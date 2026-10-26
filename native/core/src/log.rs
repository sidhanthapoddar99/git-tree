//! `git log` for the graph: the start points, the walk, and git's three orderings.
//!
//! All three orderings (`--date-order`, `--author-date-order`, `--topo-order`) are topological: git
//! never shows a commit before one of its children. Git sorts the start points by commit date, and then
//! repeatedly shows a commit whose children it has all shown. The ordering decides which of those
//! ready commits goes first: the newest by commit date, the newest by author date, or the last one
//! that became ready, which keeps a line of history together.
//!
//! The engine runs the same algorithm (`sort_in_topological_order` in git's `commit.c`) over every
//! commit the start points reach, so the page it returns is exact. Two details decide the output when
//! commits tie, and the engine follows git in both:
//!
//! - Among ready commits with the same date, the one that became ready first goes first.
//! - With `--first-parent`, git's walk depends on whether it can use generation numbers from a
//!   commit-graph. With them, only first-parent links order the commits. Without them, git also waits
//!   for a merge before showing a commit that is the merge's second parent.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};
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
struct Start {
    id: ObjectId,
    /// Git lists the reflogs' commits in an order the engine doesn't reproduce, which only matters
    /// when two of them tie.
    from_reflog: bool,
}

pub fn log(repo: &Repo, request: &LogRequest) -> Result<Vec<CommitRecord>> {
    repo.check_format(request.format)?;
    let starts = start_points(repo, &request.revisions)?;
    if request.max_count == 0 || starts.is_empty() {
        return Ok(Vec::new());
    }

    // With --first-parent, the order depends on the walk git uses (see the module documentation)
    let first_parent_links_only = request.first_parent && generation_numbers_enabled(repo)?;
    let mut graph = Graph::new(repo, request.order == Order::AuthorDate);
    let order = graph.order(&starts, request, first_parent_links_only)?;

    let mut records = Vec::with_capacity(order.len());
    for index in order {
        let id = graph.ids[index];
        let data = repo.commit_data(id)?;
        records.push(format::record(id, &commit::parse(&data)?, request.format)?);
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

    // Git walks from the commit a tag points to, and leaves out trees and blobs
    let mut seen = HashSet::new();
    let mut starts = Vec::new();
    for (id, from_reflog) in pending {
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

/// Does git use generation numbers from a commit-graph (`generation_numbers_enabled`)?
fn generation_numbers_enabled(repo: &Repo) -> Result<bool> {
    if repo.config_bool("core.commitGraph")? == Some(false) {
        return Ok(false);
    }
    let info = repo.git.objects.store_ref().path().join("info");
    if info.join("alternates").exists() {
        // Git can also use the commit-graph of an alternate object store
        unsupported!("the repository has alternate object stores");
    }
    let single = info.join("commit-graph");
    let chain = info.join("commit-graphs").join("commit-graph-chain");
    // Git reads the single file first, and the chain's newest layer holds the commit it checks
    let newest = if single.exists() {
        single
    } else if chain.exists() {
        let text = std::fs::read_to_string(&chain).context("Unable to read the commit-graph chain")?;
        match text.lines().last() {
            Some(hash) => info.join("commit-graphs").join(format!("graph-{hash}.graph")),
            None => return Ok(false),
        }
    } else {
        return Ok(false);
    };
    let unreadable = |_| Error::unsupported("the commit-graph can't be read, and git may still read it");
    gix::commitgraph::Graph::from_info_dir(&info, gix::hash::Kind::Sha1).map_err(unreadable)?;
    let file = gix::commitgraph::File::at(&newest).map_err(unreadable)?;
    if file.num_commits() == 0 {
        return Ok(false);
    }
    Ok(file.commit_at(gix::commitgraph::file::Position(0)).generation() != 0)
}

/// The commits the walk reaches, with what the orderings need to know about each.
struct Graph<'r> {
    repo: &'r Repo,
    /// Git reads parents and commit dates from the commit-graph when it can; so does the engine.
    cache: Option<gix::commitgraph::Graph>,
    /// Author dates are only in the commit objects.
    author_dates: bool,
    ids: Vec<ObjectId>,
    index: HashMap<ObjectId, usize>,
    nodes: Vec<Option<Node>>,
}

struct Node {
    parents: Vec<usize>,
    date: i64,
    author_date: i64,
}

impl<'r> Graph<'r> {
    fn new(repo: &'r Repo, author_dates: bool) -> Graph<'r> {
        // An unreadable commit-graph is only slower: the commit objects say the same
        let cache = repo.git.commit_graph_if_enabled().ok().flatten();
        Graph { repo, cache, author_dates, ids: Vec::new(), index: HashMap::new(), nodes: Vec::new() }
    }

    fn intern(&mut self, id: ObjectId) -> usize {
        if let Some(&index) = self.index.get(&id) {
            return index;
        }
        let index = self.ids.len();
        self.ids.push(id);
        self.index.insert(id, index);
        self.nodes.push(None);
        index
    }

    /// Read a commit's parents and dates.
    fn load(&mut self, index: usize) -> Result<()> {
        if self.nodes[index].is_some() {
            return Ok(());
        }
        let id = self.ids[index];
        let mut parent_ids = Vec::new();
        let (date, author_date);
        let cached = if self.author_dates { None } else { self.cache.as_ref().and_then(|cache| cache.commit_by_id(id)) };
        if let Some(cached) = cached {
            let cache = self.cache.as_ref().unwrap();
            for parent in cached.iter_parents() {
                let position = parent.map_err(|e| Error::failed(format!("Unable to read the commit-graph: {e}")))?;
                parent_ids.push(cache.id_at(position).to_owned());
            }
            date = cached.committer_timestamp() as i64;
            author_date = 0;
        } else {
            let data = self.repo.commit_data(id)?;
            let parsed = commit::parse(&data)?;
            parent_ids = parsed.parents;
            date = parsed.committer.time;
            author_date = parsed.author.time;
            if date >= MAX_GRAPH_DATE {
                unsupported!("the commit {id} has a date git's commit-graph can't store");
            }
        }
        let parents = parent_ids.into_iter().map(|parent| self.intern(parent)).collect();
        self.nodes[index] = Some(Node { parents, date, author_date });
        Ok(())
    }

    fn node(&self, index: usize) -> &Node {
        self.nodes[index].as_ref().expect("the walk loads every commit it reaches")
    }

    /// The first `max_count` commits of the log, as indices into `ids`.
    fn order(&mut self, starts: &[Start], request: &LogRequest, first_parent_links_only: bool) -> Result<Vec<usize>> {
        // Every commit the start points reach, following only first parents with --first-parent
        let mut member = Vec::new();
        let mut stack: Vec<usize> = Vec::new();
        let start_indices: Vec<usize> = starts.iter().map(|start| self.intern(start.id)).collect();
        for &index in &start_indices {
            stack.push(index);
        }
        while let Some(index) = stack.pop() {
            if member.len() < self.ids.len() {
                member.resize(self.ids.len(), false);
            }
            if member[index] {
                continue;
            }
            member[index] = true;
            self.load(index)?;
            let parents = &self.node(index).parents;
            let followed = if request.first_parent { &parents[..parents.len().min(1)] } else { &parents[..] };
            stack.extend(followed.iter().copied());
        }
        member.resize(self.ids.len(), false);

        // The links that order the commits: the first-parent links only when git uses generation
        // numbers with --first-parent, and otherwise every link between two commits of the walk
        let links = |node: &Node| -> Vec<usize> {
            let parents = if first_parent_links_only { &node.parents[..node.parents.len().min(1)] } else { &node.parents[..] };
            parents.iter().copied().filter(|&parent| member[parent]).collect()
        };
        let mut children = vec![0usize; self.ids.len()];
        let mut links_of: Vec<Vec<usize>> = vec![Vec::new(); self.ids.len()];
        for index in 0..self.ids.len() {
            if member[index] {
                links_of[index] = links(self.node(index));
                for &parent in &links_of[index] {
                    children[parent] += 1;
                }
            }
        }

        // The start points, sorted by commit date as git sorts them (a stable sort)
        let mut sorted: Vec<(usize, bool)> = start_indices.iter().zip(starts).map(|(&index, start)| (index, start.from_reflog)).collect();
        sorted.sort_by_key(|&(index, _)| Reverse(self.node(index).date));
        let tips: Vec<usize> = sorted.iter().filter(|&&(index, _)| children[index] == 0).map(|&(index, _)| index).collect();
        let mut reflog_dates = HashSet::new();
        for &(index, from_reflog) in &sorted {
            if from_reflog && children[index] == 0 && !reflog_dates.insert(self.node(index).date) {
                unsupported!("two commits from the reflogs tie as start points");
            }
        }

        let mut shown = Vec::with_capacity(request.max_count.min(self.ids.len()));
        match request.order {
            Order::Topo => {
                // Git's queue is a stack here, with the first tip on top
                let mut ready: Vec<usize> = tips.into_iter().rev().collect();
                while shown.len() < request.max_count {
                    let Some(index) = ready.pop() else { break };
                    shown.push(index);
                    for &parent in &links_of[index] {
                        children[parent] -= 1;
                        if children[parent] == 0 {
                            ready.push(parent);
                        }
                    }
                }
            }
            Order::Date | Order::AuthorDate => {
                // Newest first; among equal dates, the commit that became ready first
                let key = |node: &Node| if request.order == Order::Date { node.date } else { node.author_date };
                let mut ready = BinaryHeap::new();
                let mut counter = 0u64;
                for index in tips {
                    ready.push((key(self.node(index)), Reverse(counter), index));
                    counter += 1;
                }
                while shown.len() < request.max_count {
                    let Some((_, _, index)) = ready.pop() else { break };
                    shown.push(index);
                    for &parent in &links_of[index] {
                        children[parent] -= 1;
                        if children[parent] == 0 {
                            ready.push((key(self.node(parent)), Reverse(counter), parent));
                            counter += 1;
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
