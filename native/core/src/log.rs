//! `git log` for the graph: the start points, the walk, and git's three orderings.
//!
//! All three orderings (`--date-order`, `--author-date-order`, `--topo-order`) are topological: git
//! never shows a commit before one of its children. Git sorts the start points by commit date, and then
//! repeatedly shows a commit whose children it has all shown. The ordering decides which of those
//! ready commits goes first: the newest by commit date, the newest by author date, or the last one
//! that became ready, which keeps a line of history together.
//!
//! A commit is ready when its count of children not shown yet reaches zero, so the walk must have
//! counted every child first. Git counts them in one of two ways, and the engine does the same:
//!
//! - **With generation numbers** from a commit-graph, the walk is incremental (`init_topo_walk` and
//!   `expand_topo_walk` in git's `revision.c`). A commit's generation is higher than its parents', so
//!   once the walk has counted the parents of every commit down to a generation, the counts of the
//!   commits at that generation are complete. The walk counts only as deep as the commits it shows
//!   need, and stops at `--max-count`, so a page costs about the commits on it.
//! - **Without them**, git counts every commit the start points reach before it shows the first
//!   (`limit_list`, then `sort_in_topological_order` in `commit.c`). The engine runs the same walk with
//!   every commit's generation taken as infinite, which counts them all first too.
//!
//! The engine reads its generations from the commit-graph's topological levels, while git may read
//! corrected commit dates from the same file. Both rise from parent to child, and the shown order
//! doesn't depend on which numbers count the children, only on the counts being complete. Two more
//! details decide the output when commits tie, and the engine follows git in both:
//!
//! - Among ready commits with the same date, the one that became ready first goes first.
//! - With `--first-parent`, the incremental walk counts only first-parent links. Without generation
//!   numbers, git also counts a link to a merge's second parent when the walk reached that commit, so
//!   it waits for the merge before showing it.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashSet};
use std::path::Path;

use gix::bstr::ByteSlice;
use gix::ObjectId;

use crate::commit;
use crate::error::{unsupported, Context, Error, Result};
use crate::format::{self, CommitRecord, Format};
use crate::reflog;
use crate::refs::PER_WORKTREE_PREFIXES;
use crate::repo::Repo;
use crate::worktree;

/// Git's commit-graph stores commit dates in 34 bits.
const MAX_GRAPH_DATE: i64 = 1 << 34;

/// The generation of a commit the commit-graph doesn't have, and of every commit when git doesn't use
/// generation numbers: newer than any other.
const INFINITY: u32 = gix::commitgraph::GENERATION_NUMBER_INFINITY;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
pub enum Order {
    #[serde(rename = "date")]
    Date,
    #[serde(rename = "author-date")]
    AuthorDate,
    #[serde(rename = "topo")]
    Topo,
}

/// A `git log` read, as the extension runs it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogRequest {
    /// The revision arguments, as the extension passes them to `git log`: `HEAD`, ref names, full
    /// object IDs, `--branches`, `--tags`, `--remotes`, `--reflog` and `--glob=<pattern>`.
    pub revisions: Vec<String>,
    /// `--max-count`.
    pub max_count: usize,
    pub order: Order,
    /// `--first-parent`.
    pub first_parent: bool,
    pub format: Format,
}

/// A commit the log starts from.
pub(crate) struct Start {
    id: ObjectId,
    /// Git lists the reflogs' commits in an order the engine doesn't reproduce, which only matters
    /// when two of them tie.
    from_reflog: bool,
}

/// What a log read finds before it walks: everything its answer depends on apart from the commits,
/// which can't change for a given ID. The `commits` read's token describes it.
pub(crate) enum Plan {
    /// The log is empty: `--max-count=0`, or the revisions name no commits.
    Empty,
    Walk {
        starts: Vec<Start>,
        /// Boxed, because gix's graph is large.
        graph: Option<Box<CommitGraph>>,
    },
}

/// The commit-graph the walk reads.
pub(crate) struct CommitGraph {
    graph: gix::commitgraph::Graph,
    /// Does git order its walk by the generation numbers in it?
    generations: bool,
    /// The files git reads: the checksum of the single file, or the chain's list of layers (each named
    /// by its checksum) and the checksum of its newest layer.
    files: Vec<u8>,
}

pub fn log(repo: &Repo, request: &LogRequest) -> Result<Vec<CommitRecord>> {
    let plan = plan(repo, request)?;
    walk(repo, request, plan)
}

/// The reads before the walk, in the order the log read makes them.
pub(crate) fn plan(repo: &Repo, request: &LogRequest) -> Result<Plan> {
    repo.check_format(request.format)?;
    let starts = start_points(repo, &request.revisions)?;
    if request.max_count == 0 || starts.is_empty() {
        return Ok(Plan::Empty);
    }
    Ok(Plan::Walk { starts, graph: commit_graph(repo)?.map(Box::new) })
}

impl Plan {
    /// Add what the log's answer depends on to a token: the start points and the commit-graph.
    pub(crate) fn describe(&self, token: &mut crate::commits::Token) {
        match self {
            Plan::Empty => token.field(b"empty"),
            Plan::Walk { starts, graph } => {
                token.field(b"starts");
                token.count(starts.len());
                for start in starts {
                    token.field(start.id.as_bytes());
                    token.flag(start.from_reflog);
                }
                match graph {
                    None => token.field(b"no commit-graph"),
                    Some(graph) => {
                        token.field(b"commit-graph");
                        token.flag(graph.generations);
                        token.field(&graph.files);
                    }
                }
            }
        }
    }
}

/// The log page a plan leads to.
pub(crate) fn walk(repo: &Repo, request: &LogRequest, plan: Plan) -> Result<Vec<CommitRecord>> {
    let Plan::Walk { starts, graph } = plan else {
        return Ok(Vec::new());
    };
    let mut walk = Walk::new(repo, request, graph);
    let shown = walk.run(&starts)?;

    let mut records = Vec::with_capacity(shown.len());
    for index in shown {
        let node = &mut walk.nodes[index];
        let data = match node.data.take() {
            Some(data) => data,
            None => repo.commit_data(node.id)?,
        };
        records.push(format::record(node.id, &commit::parse(&data)?, request.format)?);
    }
    Ok(records)
}

/// The commits the revision arguments name, in the order git adds them to its walk, without repeats.
fn start_points(repo: &Repo, revisions: &[String]) -> Result<Vec<Start>> {
    let mut pending: Vec<(ObjectId, bool)> = Vec::new();
    let add_refs = |prefix: &str, pending: &mut Vec<(ObjectId, bool)>| -> Result<()> {
        pending.extend(repo.refs(prefix)?.into_iter().map(|reference| (reference.id, false)));
        Ok(())
    };
    let head = ["HEAD".to_owned()];
    // Without revisions, git log starts from HEAD
    let revisions = if revisions.is_empty() { &head[..] } else { revisions };
    for revision in revisions {
        match revision.as_str() {
            "--branches" => add_refs("refs/heads/", &mut pending)?,
            "--tags" => add_refs("refs/tags/", &mut pending)?,
            "--remotes" => add_refs("refs/remotes/", &mut pending)?,
            "--reflog" => pending.extend(reflog_objects(repo)?.into_iter().map(|id| (id, true))),
            other => {
                if let Some(pattern) = other.strip_prefix("--glob=") {
                    add_refs(&glob_prefix(pattern)?, &mut pending)?;
                } else if other.starts_with('-') {
                    unsupported!("the engine doesn't read the option {other}");
                } else {
                    pending.push((repo.resolve_revision(other)?, false));
                }
            }
        }
    }

    // Git walks from the commit a tag points to, and leaves out trees and blobs. The reflogs name
    // the same objects many times, and only the first time counts, so each is peeled once.
    let mut peeled = HashSet::new();
    let mut seen = HashSet::new();
    let mut starts = Vec::new();
    for (id, from_reflog) in pending {
        if !peeled.insert(id) {
            continue;
        }
        let (id, kind, _) = repo.peel(id)?;
        if kind == gix::object::Kind::Commit && seen.insert(id) {
            starts.push(Start { id, from_reflog });
        }
    }
    Ok(starts)
}

/// The ref prefix that `--glob=<pattern>` matches. Git adds `/*` to a pattern without glob characters,
/// and its `*` matches across `/`, so the pattern matches every ref under the prefix.
fn glob_prefix(pattern: &str) -> Result<String> {
    if pattern.contains(['?', '*', '[', '\\']) {
        unsupported!("the glob pattern {pattern} has glob characters");
    }
    let mut prefix = if pattern.starts_with("refs/") { pattern.to_owned() } else { format!("refs/{pattern}") };
    if !prefix.ends_with('/') {
        prefix.push('/');
    }
    Ok(prefix)
}

/// The objects `--reflog` adds: the old and new object of every entry in every reflog git reads,
/// which are the shared refs' reflogs, the main worktree's, and each linked worktree's HEAD reflog.
fn reflog_objects(repo: &Repo) -> Result<Vec<ObjectId>> {
    let common = repo.common_dir();
    let mut files = Vec::new();
    list_files(&common.join("logs"), "", &mut files)?;
    let mut reflogs: Vec<(std::path::PathBuf, Option<std::path::PathBuf>)> = Vec::new();
    for name in files {
        if name == "HEAD" {
            reflogs.push((common.join("logs").join("HEAD"), Some(common.join("HEAD"))));
        } else if name.starts_with("refs/") && !PER_WORKTREE_PREFIXES.iter().any(|prefix| name.starts_with(prefix)) {
            // Git versions differ on the reflog of a ref that no longer exists
            if repo.find_ref(name.as_bytes().as_bstr())?.is_none() {
                unsupported!("the reflog of {name} has no ref");
            }
            reflogs.push((common.join("logs").join(&name), None));
        } else {
            unsupported!("the engine doesn't read the reflog {name}");
        }
    }
    for linked in worktree::linked_ids(repo)? {
        let dir = common.join("worktrees").join(&linked);
        let mut files = Vec::new();
        list_files(&dir.join("logs"), "", &mut files)?;
        for name in files {
            if name != "HEAD" {
                unsupported!("the worktree {linked} has the reflog {name}");
            }
            reflogs.push((dir.join("logs").join("HEAD"), Some(dir.join("HEAD"))));
        }
    }

    let mut ids = Vec::new();
    for (path, head) in reflogs {
        if let Some(head) = head {
            // Git versions differ on the reflog of an unborn HEAD
            if worktree::read_head(repo, &head)?.id.is_none() {
                unsupported!("{} has a reflog but no commits", head.display());
            }
        }
        for entry in reflog::read(&path)?.unwrap_or_default() {
            for id in [entry.old, entry.new] {
                if !id.is_null() {
                    ids.push(id);
                }
            }
        }
    }
    Ok(ids)
}

/// The files under `dir`, as `/`-separated paths relative to it.
fn list_files(dir: &Path, prefix: &str, files: &mut Vec<String>) -> Result<()> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(Error::failed(format!("Unable to read {}: {e}", dir.display()))),
    };
    for entry in entries {
        let entry = entry.context("Unable to read the reflogs")?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            unsupported!("a reflog name isn't valid UTF-8");
        };
        let path = format!("{prefix}{name}");
        let kind = entry.file_type().context("Unable to read the reflogs")?;
        if kind.is_dir() {
            list_files(&entry.path(), &format!("{path}/"), files)?;
        } else if kind.is_file() {
            files.push(path);
        } else {
            unsupported!("the reflog {path} isn't a file");
        }
    }
    Ok(())
}

/// The commit-graph git reads, if it reads one, and whether git orders its walk by the generation
/// numbers in it (`generation_numbers_enabled`).
fn commit_graph(repo: &Repo) -> Result<Option<CommitGraph>> {
    if repo.config_bool("core.commitGraph")? == Some(false) {
        return Ok(None);
    }
    let info = repo.git.objects.store_ref().path().join("info");
    if info.join("alternates").exists() {
        // Git can also use the commit-graph of an alternate object store
        unsupported!("the repository has alternate object stores");
    }
    let single = info.join("commit-graph");
    let chain = info.join("commit-graphs").join("commit-graph-chain");
    let mut files = Vec::new();
    // Git reads the single file first, and the chain's newest layer holds the commit it checks
    let newest = if single.exists() {
        single
    } else if chain.exists() {
        let text = std::fs::read_to_string(&chain).context("Unable to read the commit-graph chain")?;
        files.extend_from_slice(text.as_bytes());
        match text.lines().last() {
            Some(hash) => info.join("commit-graphs").join(format!("graph-{hash}.graph")),
            None => return Ok(None),
        }
    } else {
        return Ok(None);
    };
    let unreadable = |_| Error::unsupported("the commit-graph can't be read, and git may still read it");
    let graph = gix::commitgraph::Graph::from_info_dir(&info, gix::hash::Kind::Sha1).map_err(unreadable)?;
    let file = gix::commitgraph::File::at(&newest).map_err(unreadable)?;
    let generations = file.num_commits() > 0 && file.commit_at(gix::commitgraph::file::Position(0)).generation() != 0;
    files.extend_from_slice(file.checksum().as_bytes());
    Ok(Some(CommitGraph { graph, generations, files }))
}

/// Git's walk for the three orderings, over the commits it reaches (see the module documentation).
struct Walk<'r> {
    repo: &'r Repo,
    /// Git reads parents and commit dates from the commit-graph when it can; so does the engine.
    graph: Option<gix::commitgraph::Graph>,
    /// Does git use generation numbers? Without them, every commit's generation is [`INFINITY`].
    generations: bool,
    order: Order,
    first_parent: bool,
    max_count: usize,
    index: gix::hashtable::HashMap<ObjectId, usize>,
    nodes: Vec<Node>,
    /// The commits whose parents the walk hasn't counted yet, highest generation first, then newest
    /// (git's `indegree_queue`).
    uncounted: BinaryHeap<(u32, i64, Reverse<u64>, usize)>,
    /// The number of commits put in a queue so far, which breaks ties as git's `prio_queue` does.
    queued: u64,
    /// The number of commit objects the walk read and kept for the records.
    kept: usize,
}

struct Node {
    id: ObjectId,
    /// The commit's position in the commit-graph, when the walk knows it.
    position: Option<gix::commitgraph::Position>,
    /// Have the parents and dates been read?
    loaded: bool,
    parents: Vec<usize>,
    date: i64,
    generation: u32,
    /// Read only for `--author-date-order`, and only for the commits that become ready.
    author_date: Option<i64>,
    /// Zero before the walk reaches the commit and after it's shown; otherwise one more than the
    /// children the walk counted and hasn't shown (git's `indegree` slab).
    indegree: u32,
    /// Has the walk reached the commit (git's `TOPO_WALK_INDEGREE` flag)?
    reached: bool,
    /// The commit object, when the walk read it, so the record doesn't read it again.
    data: Option<Vec<u8>>,
}

/// The commits that are ready to show, in the order of the request.
enum Ready {
    /// `--topo-order`: the last commit that became ready goes first.
    Stack(Vec<usize>),
    /// `--date-order` and `--author-date-order`: the newest goes first, then the one that became
    /// ready first.
    Newest(BinaryHeap<(i64, Reverse<u64>, usize)>),
}

impl<'r> Walk<'r> {
    fn new(repo: &'r Repo, request: &LogRequest, graph: Option<Box<CommitGraph>>) -> Walk<'r> {
        let (graph, generations) = match graph {
            Some(graph) => {
                let CommitGraph { graph, generations, .. } = *graph;
                (Some(graph), generations)
            }
            None => (None, false),
        };
        Walk {
            repo,
            graph,
            generations,
            order: request.order,
            first_parent: request.first_parent,
            max_count: request.max_count,
            index: Default::default(),
            nodes: Vec::new(),
            uncounted: BinaryHeap::new(),
            queued: 0,
            kept: 0,
        }
    }

    fn intern(&mut self, id: ObjectId, position: Option<gix::commitgraph::Position>) -> usize {
        if let Some(&index) = self.index.get(&id) {
            return index;
        }
        let index = self.nodes.len();
        self.index.insert(id, index);
        self.nodes.push(Node {
            id,
            position,
            loaded: false,
            parents: Vec::new(),
            date: 0,
            generation: INFINITY,
            author_date: None,
            indegree: 0,
            reached: false,
            data: None,
        });
        index
    }

    /// Read a commit's parents, commit date and generation: from the commit-graph when it has the
    /// commit, and otherwise from the commit object.
    fn load(&mut self, index: usize) -> Result<()> {
        if self.nodes[index].loaded {
            return Ok(());
        }
        let id = self.nodes[index].id;
        let mut parents = Vec::new();
        let graph = self.graph.as_ref();
        if let Some((graph, position)) = graph.and_then(|graph| Some((graph, self.nodes[index].position.or_else(|| graph.lookup(id))?))) {
            let cached = graph.commit_at(position);
            for parent in cached.iter_parents() {
                let position = parent.map_err(|e| Error::failed(format!("Unable to read the commit-graph: {e}")))?;
                parents.push((graph.id_at(position).to_owned(), Some(position)));
            }
            let node = &mut self.nodes[index];
            node.date = cached.committer_timestamp() as i64;
            node.generation = if self.generations { cached.generation() } else { INFINITY };
        } else {
            let data = self.repo.commit_data(id)?;
            let parsed = commit::parse(&data)?;
            if parsed.committer.time >= MAX_GRAPH_DATE {
                unsupported!("the commit {id} has a date git's commit-graph can't store");
            }
            parents.extend(parsed.parents.iter().map(|&parent| (parent, None)));
            let node = &mut self.nodes[index];
            node.date = parsed.committer.time;
            node.author_date = Some(parsed.author.time);
            self.keep(index, data);
        }
        let parents = parents.into_iter().map(|(id, position)| self.intern(id, position)).collect();
        let node = &mut self.nodes[index];
        node.parents = parents;
        node.loaded = true;
        Ok(())
    }

    /// Keep a commit object the walk read, for the record. The walk keeps at most `max_count`, so its
    /// memory stays proportional to the page, and when every commit it reads is shown, it reads each
    /// only once.
    fn keep(&mut self, index: usize, data: Vec<u8>) {
        if self.kept < self.max_count {
            self.nodes[index].data = Some(data);
            self.kept += 1;
        }
    }

    /// The key that orders ready commits by date.
    fn date_key(&mut self, index: usize) -> Result<i64> {
        if self.order == Order::Date {
            return Ok(self.nodes[index].date);
        }
        if let Some(date) = self.nodes[index].author_date {
            return Ok(date);
        }
        // Author dates are only in the commit objects
        let data = self.repo.commit_data(self.nodes[index].id)?;
        let date = commit::parse(&data)?.author.time;
        self.nodes[index].author_date = Some(date);
        self.keep(index, data);
        Ok(date)
    }

    /// Mark a loaded commit as reached, and queue it for counting its parents.
    fn reach(&mut self, index: usize) {
        let node = &mut self.nodes[index];
        if !node.reached {
            node.reached = true;
            self.uncounted.push((node.generation, node.date, Reverse(self.queued), index));
            self.queued += 1;
        }
    }

    /// Count the children of every commit at `generation` or above (git's `compute_indegrees_to_depth`).
    fn count_to(&mut self, generation: u32) -> Result<()> {
        while let Some(&(top, _, _, index)) = self.uncounted.peek() {
            if top < generation {
                break;
            }
            self.uncounted.pop();
            let followed = if self.first_parent { self.nodes[index].parents.len().min(1) } else { self.nodes[index].parents.len() };
            for i in 0..followed {
                let parent = self.nodes[index].parents[i];
                self.load(parent)?;
                if self.nodes[parent].generation > self.nodes[index].generation {
                    // The walk would show the commit before its child
                    unsupported!("the commit-graph gives {} a higher generation than its child", self.nodes[parent].id);
                }
                let node = &mut self.nodes[parent];
                node.indegree = if node.indegree == 0 { 2 } else { node.indegree + 1 };
                self.reach(parent);
            }
        }
        Ok(())
    }

    /// The first `max_count` commits of the log, as indices into `nodes`.
    fn run(&mut self, starts: &[Start]) -> Result<Vec<usize>> {
        let mut sorted = Vec::with_capacity(starts.len());
        for start in starts {
            let index = self.intern(start.id, None);
            self.load(index)?;
            sorted.push((index, start.from_reflog));
        }
        // The start points, sorted by commit date as git sorts them (a stable sort)
        sorted.sort_by_key(|&(index, _)| Reverse(self.nodes[index].date));

        let mut lowest = INFINITY;
        for &(index, _) in &sorted {
            self.reach(index);
            self.nodes[index].indegree = 1;
            lowest = lowest.min(self.nodes[index].generation);
        }
        self.count_to(lowest)?;
        let first_parent_links_only = self.generations && self.first_parent;
        if self.first_parent && !self.generations {
            // Git's sort also counts the other parents' links between commits of the walk
            for index in 0..self.nodes.len() {
                for i in 1..self.nodes[index].parents.len() {
                    let parent = self.nodes[index].parents[i];
                    if self.nodes[index].reached && self.nodes[parent].reached {
                        self.nodes[parent].indegree += 1;
                    }
                }
            }
        }

        // The tips: start points that no other commit of the walk leads to
        let tips: Vec<usize> = sorted.iter().map(|&(index, _)| index).filter(|&index| self.nodes[index].indegree == 1).collect();
        let mut reflog_dates = HashSet::new();
        for &(index, from_reflog) in &sorted {
            if from_reflog && self.nodes[index].indegree == 1 && !reflog_dates.insert(self.nodes[index].date) {
                unsupported!("two commits from the reflogs tie as start points");
            }
        }
        let mut ready = match self.order {
            // Git's queue is a stack here, with the first tip on top
            Order::Topo => Ready::Stack(tips.into_iter().rev().collect()),
            Order::Date | Order::AuthorDate => {
                let mut heap = BinaryHeap::new();
                for index in tips {
                    heap.push((self.date_key(index)?, Reverse(self.queued), index));
                    self.queued += 1;
                }
                Ready::Newest(heap)
            }
        };

        let mut shown = Vec::with_capacity(self.max_count.min(self.nodes.len()));
        while shown.len() < self.max_count {
            let next = match &mut ready {
                Ready::Stack(stack) => stack.pop(),
                Ready::Newest(heap) => heap.pop().map(|(_, _, index)| index),
            };
            let Some(index) = next else { break };
            self.nodes[index].indegree = 0;
            shown.push(index);
            if shown.len() == self.max_count {
                break;
            }

            let links = if first_parent_links_only { self.nodes[index].parents.len().min(1) } else { self.nodes[index].parents.len() };
            for i in 0..links {
                let parent = self.nodes[index].parents[i];
                if !self.nodes[parent].reached {
                    // Only with --first-parent and no generation numbers: a parent the walk didn't follow
                    continue;
                }
                let generation = self.nodes[parent].generation;
                if generation < lowest {
                    lowest = generation;
                    self.count_to(lowest)?;
                }
                self.nodes[parent].indegree -= 1;
                if self.nodes[parent].indegree == 1 {
                    match &mut ready {
                        Ready::Stack(stack) => stack.push(parent),
                        Ready::Newest(heap) => {
                            heap.push((self.date_key(parent)?, Reverse(self.queued), parent));
                            self.queued += 1;
                        }
                    }
                }
            }
        }
        Ok(shown)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_prefixes() {
        assert_eq!(glob_prefix("refs/remotes/origin").unwrap(), "refs/remotes/origin/");
        assert_eq!(glob_prefix("remotes/origin/").unwrap(), "refs/remotes/origin/");
        assert!(matches!(glob_prefix("refs/remotes/o*"), Err(Error::Unsupported(_))));
        assert!(matches!(glob_prefix("refs/remotes/[ab]"), Err(Error::Unsupported(_))));
    }
}
