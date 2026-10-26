//! The files changed between two commits, as the extension's two diff commands print them:
//!
//! - `git diff --name-status|--numstat --find-renames --diff-filter=AMDR -z <from> <to>`, and
//! - `git diff-tree --name-status|--numstat -r --root --find-renames --diff-filter=AMDR -z <commit>`,
//!   which compares a commit with its parent, or a root commit with the empty tree.
//!
//! The engine walks the two trees as git's `tree-diff.c` does, finds renames of identical files as
//! `find_exact_renames` does, keeps the added, modified, deleted and renamed files, and counts their
//! lines as `--numstat` does. It answers with the fields git prints, separated by NULs, so the
//! extension parses both answers with the same code.
//!
//! It doesn't search for renames of files that changed (git's similarity scores): when a diff has an
//! added and a deleted file left after the identical ones are paired, git might pair them, and the
//! engine returns `Unsupported`. So it does for submodules (whose diffs depend on their settings),
//! attributes that change a diff, and settings that change the output.

use std::collections::HashMap;

use gix::ObjectId;

use crate::attributes;
use crate::commit;
use crate::error::{unsupported, Result};
use crate::lines;
use crate::repo::{full_id, utf8, Repo};
use crate::tree::{self, Entry};

/// Git treats a larger file as binary (`core.bigFileThreshold`'s default, 512 MiB).
const BIG_FILE: u64 = 512 * 1024 * 1024;
/// Git looks for a NUL in this many bytes to decide that a file is binary (`FIRST_FEW_BYTES`).
const BINARY_SNIFF: usize = 8000;
/// Git scores at most this many identical files as rename sources for one added file.
const MAX_IDENTICAL: usize = 100;

/// What the two commands print, split at each NUL as the extension splits them.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffRecords {
    /// `--name-status`: a status, then one path, or two for a rename.
    pub name_status: Vec<String>,
    /// `--numstat`: `added\tdeleted\tpath`, or `added\tdeleted\t`, then two paths for a rename.
    pub num_stat: Vec<String>,
}

/// One side of a changed file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Side {
    id: ObjectId,
    mode: u32,
}

/// A path whose entry differs between the two trees.
#[derive(Debug)]
struct Change {
    path: Vec<u8>,
    old: Option<Side>,
    new: Option<Side>,
}

/// A file change in the output.
enum Item<'a> {
    Added(&'a [u8], Side),
    Deleted(&'a [u8], Side),
    Modified(&'a [u8], Side, Side),
    Renamed(&'a [u8], &'a [u8], Side, Side),
}

/// The diff between `from` and `to`, as the extension's `execDiff` runs it: `git diff-tree` of one
/// commit when they're equal, and `git diff` of two commits otherwise. A revision is a full commit ID,
/// and `from` may also be `<id>^`, the commit's first parent.
pub fn diff(repo: &Repo, from: &str, to: &str) -> Result<DiffRecords> {
    let single = from == to;
    check_settings(repo, single)?;
    let (old_tree, new_tree) = if single {
        let (tree, parents) = commit_tree(repo, full_id(to)?)?;
        match parents.as_slice() {
            [] => (None, tree),
            [parent] => (Some(commit_tree(repo, *parent)?.0), tree),
            // git diff-tree shows nothing for a merge commit without -m, -c or --cc
            _ => return Ok(DiffRecords { name_status: Vec::new(), num_stat: Vec::new() }),
        }
    } else {
        let old = match from.strip_suffix('^') {
            Some(child) => match commit_tree(repo, full_id(child)?)?.1.first() {
                Some(&parent) => parent,
                None => unsupported!("{child} has no parent"),
            },
            None => full_id(from)?,
        };
        (Some(commit_tree(repo, old)?.0), commit_tree(repo, full_id(to)?)?.0)
    };

    let mut changes = Vec::new();
    walk(repo, old_tree, Some(new_tree), &mut Vec::new(), &mut changes)?;
    let items = find_renames(&changes, |id| Ok(repo.object_header(id)?.1))?;

    let mut paths: Vec<&[u8]> = Vec::new();
    for item in &items {
        match item {
            Item::Added(path, _) | Item::Deleted(path, _) | Item::Modified(path, _, _) => paths.push(path),
            Item::Renamed(old, new, _, _) => paths.extend([*old, *new]),
        }
    }
    attributes::check_diff(repo, &paths)?;

    let mut blobs = Blobs { repo, cache: HashMap::new() };
    let mut name_status = Vec::new();
    let mut num_stat = Vec::new();
    for item in &items {
        match *item {
            Item::Added(path, side) => {
                let path = path_string(path)?;
                name_status.extend(["A".to_owned(), path.clone()]);
                num_stat.push(format!("{}\t{path}", blobs.numstat(None, Some(side))?));
            }
            Item::Deleted(path, side) => {
                let path = path_string(path)?;
                name_status.extend(["D".to_owned(), path.clone()]);
                num_stat.push(format!("{}\t{path}", blobs.numstat(Some(side), None)?));
            }
            Item::Modified(path, old, new) => {
                let path = path_string(path)?;
                name_status.extend(["M".to_owned(), path.clone()]);
                num_stat.push(format!("{}\t{path}", blobs.numstat(Some(old), Some(new))?));
            }
            Item::Renamed(old_path, new_path, old, new) => {
                let (old_path, new_path) = (path_string(old_path)?, path_string(new_path)?);
                name_status.extend(["R100".to_owned(), old_path.clone(), new_path.clone()]);
                num_stat.extend([format!("{}\t", blobs.numstat(Some(old), Some(new))?), old_path, new_path]);
            }
        }
    }

    // Every field ends with a NUL, so splitting the output leaves an empty string at the end. git
    // diff-tree prints nothing at all for a commit without changes, and starts its output with the
    // commit's ID, which the extension removes.
    if !(single && items.is_empty()) {
        name_status.push(String::new());
        num_stat.push(String::new());
    }
    Ok(DiffRecords { name_status, num_stat })
}

/// Return `Unsupported` for settings that change the output. `git diff` reads the settings of the
/// diff "porcelain" (`git_diff_ui_config`), and `git diff-tree` only the basic ones.
fn check_settings(repo: &Repo, diff_tree: bool) -> Result<()> {
    let config = repo.config();
    if config.string("core.bigFileThreshold").is_some() {
        unsupported!("core.bigFileThreshold is set");
    }
    if diff_tree {
        return Ok(());
    }
    if let Some(algorithm) = config.string("diff.algorithm") {
        if !algorithm.eq_ignore_ascii_case(b"myers") && !algorithm.eq_ignore_ascii_case(b"default") {
            unsupported!("diff.algorithm is {algorithm}");
        }
    }
    if config.string("diff.context").is_some() {
        // A context of 0 makes git trim the files' common end before the diff
        match config.integer("diff.context") {
            Ok(Some(context)) if context > 0 => {}
            _ => unsupported!("diff.context isn't a positive number"),
        }
    }
    if repo.config_bool("diff.relative")?.unwrap_or(false) {
        unsupported!("diff.relative is set");
    }
    for key in ["diff.orderFile", "diff.external", "diff.ignoreSubmodules"] {
        if config.string(key).is_some() {
            unsupported!("{key} is set");
        }
    }
    Ok(())
}

/// The tree and the parents of a commit.
fn commit_tree(repo: &Repo, id: ObjectId) -> Result<(ObjectId, Vec<ObjectId>)> {
    let data = repo.commit_data(id)?;
    let parsed = commit::parse(&data)?;
    Ok((parsed.tree, parsed.parents))
}

/// Walk two trees side by side, as git's `ll_diff_tree_paths` does with `-r`, and collect the files
/// that differ, in the order git finds them. A missing tree is the empty tree.
fn walk(repo: &Repo, old: Option<ObjectId>, new: Option<ObjectId>, prefix: &mut Vec<u8>, changes: &mut Vec<Change>) -> Result<()> {
    let old_data = old.map(|id| repo.tree_data(id)).transpose()?;
    let new_data = new.map(|id| repo.tree_data(id)).transpose()?;
    let a = old_data.as_deref().map(tree::entries).transpose()?.unwrap_or_default();
    let b = new_data.as_deref().map(tree::entries).transpose()?.unwrap_or_default();

    let (mut i, mut j) = (0, 0);
    while i < a.len() || j < b.len() {
        let order = match (a.get(i), b.get(j)) {
            (Some(x), Some(y)) => tree::compare(x, y),
            (Some(_), None) => std::cmp::Ordering::Less,
            _ => std::cmp::Ordering::Greater,
        };
        match order {
            std::cmp::Ordering::Less => {
                visit(repo, Some(&a[i]), None, prefix, changes)?;
                i += 1;
            }
            std::cmp::Ordering::Greater => {
                visit(repo, None, Some(&b[j]), prefix, changes)?;
                j += 1;
            }
            // Equal entries have the same name, and are both trees or both not
            std::cmp::Ordering::Equal => {
                if a[i].id != b[j].id || a[i].mode != b[j].mode {
                    visit(repo, Some(&a[i]), Some(&b[j]), prefix, changes)?;
                }
                i += 1;
                j += 1;
            }
        }
    }
    Ok(())
}

/// An entry on one side or both: a tree is walked, and a file is a change.
fn visit(repo: &Repo, old: Option<&Entry<'_>>, new: Option<&Entry<'_>>, prefix: &mut Vec<u8>, changes: &mut Vec<Change>) -> Result<()> {
    let name = old.or(new).expect("an entry on one side").name;
    let length = prefix.len();
    prefix.extend_from_slice(name);
    if old.or(new).is_some_and(Entry::is_tree) {
        prefix.push(b'/');
        walk(repo, old.map(|entry| entry.id), new.map(|entry| entry.id), prefix, changes)?;
    } else {
        let side = |entry: &Entry<'_>| {
            if entry.mode == tree::GITLINK {
                // How git diffs a submodule depends on its settings, and on .gitmodules
                Err(crate::error::Error::unsupported("the diff has a submodule"))
            } else {
                Ok(Side { id: entry.id, mode: entry.mode })
            }
        };
        changes.push(Change { path: prefix.clone(), old: old.map(side).transpose()?, new: new.map(side).transpose()? });
    }
    prefix.truncate(length);
    Ok(())
}

/// Pair deleted and added files with the same contents as renames, as git's `find_exact_renames`
/// does with `-M`, and keep the changes `--diff-filter=AMDR` keeps, in git's order: a rename takes
/// the place of the added file, and its deleted file is left out. `size` gives a blob's size.
fn find_renames(changes: &[Change], size: impl Fn(ObjectId) -> Result<u64>) -> Result<Vec<Item<'_>>> {
    let sources: Vec<usize> = (0..changes.len()).filter(|&i| changes[i].new.is_none()).collect();
    let destinations: Vec<usize> = (0..changes.len()).filter(|&i| changes[i].old.is_none()).collect();
    let mut used = vec![false; sources.len()];
    // The source paired with each change that is a rename's destination
    let mut renamed_from: HashMap<usize, usize> = HashMap::new();

    if !sources.is_empty() && !destinations.is_empty() {
        for &destination in &destinations {
            let target = changes[destination].new.expect("an added file");
            let mut best: Option<(usize, u8)> = None;
            let mut scored = 0;
            // Git looks at the sources in path order, and prefers one with the same file name
            for (s, &source) in sources.iter().enumerate() {
                let side = changes[source].old.expect("a deleted file");
                if side.id != target.id || used[s] {
                    continue;
                }
                if (!tree::is_regular(side.mode) || !tree::is_regular(target.mode)) && side.mode != target.mode {
                    continue;
                }
                let score = 1 + u8::from(same_name(&changes[source].path, &changes[destination].path));
                if best.is_none_or(|(_, best_score)| score > best_score) {
                    best = Some((s, score));
                    if score == 2 {
                        break;
                    }
                }
                scored += 1;
                if scored == MAX_IDENTICAL {
                    unsupported!("a file has more than {MAX_IDENTICAL} identical rename sources");
                }
            }
            if let Some((s, _)) = best {
                used[s] = true;
                renamed_from.insert(destination, sources[s]);
            }
        }
        // Git then scores how similar each deleted file left is to each added file left. The engine
        // doesn't score, so it returns Unsupported unless git's estimate_similarity gives every pair 0
        // before scoring: when a file isn't a regular file, or one is less than half the other's size.
        let unpaired_sources: Vec<Side> =
            sources.iter().zip(&used).filter(|(_, &used)| !used).map(|(&i, _)| changes[i].old.expect("a deleted file")).collect();
        let unpaired_destinations: Vec<Side> = destinations
            .iter()
            .filter(|destination| !renamed_from.contains_key(destination))
            .map(|&i| changes[i].new.expect("an added file"))
            .collect();
        for source in unpaired_sources.iter().filter(|side| tree::is_regular(side.mode)) {
            for destination in unpaired_destinations.iter().filter(|side| tree::is_regular(side.mode)) {
                let (a, b) = (size(source.id)?, size(destination.id)?);
                if a.min(b).saturating_mul(2) >= a.max(b) {
                    unsupported!("git would look for renames among the added and deleted files that changed");
                }
            }
        }
    }

    let used_sources: Vec<usize> = renamed_from.values().copied().collect();
    let mut items = Vec::new();
    for (i, change) in changes.iter().enumerate() {
        match (change.old, change.new) {
            (None, Some(new)) => match renamed_from.get(&i) {
                Some(&source) => {
                    let old = changes[source].old.expect("a deleted file");
                    items.push(Item::Renamed(&changes[source].path, &change.path, old, new));
                }
                None => items.push(Item::Added(&change.path, new)),
            },
            (Some(old), None) => {
                if !used_sources.contains(&i) {
                    items.push(Item::Deleted(&change.path, old));
                }
            }
            (Some(old), Some(new)) => {
                // A change of type (a file to a symbolic link) is `T`, which the filter leaves out
                if !tree::type_changed(old.mode, new.mode) {
                    items.push(Item::Modified(&change.path, old, new));
                }
            }
            (None, None) => {}
        }
    }
    Ok(items)
}

/// Git's `basename_same`: do the two paths end with the same file name?
fn same_name(a: &[u8], b: &[u8]) -> bool {
    let name = |path: &[u8]| path.rsplit(|&b| b == b'/').next().unwrap_or(path).to_vec();
    name(a) == name(b)
}

fn path_string(path: &[u8]) -> Result<String> {
    utf8(path, "a path")
}

/// The blobs of one diff, read once each.
struct Blobs<'r> {
    repo: &'r Repo,
    /// Each blob's contents, or `None` for a blob too large to read, which git treats as binary.
    cache: HashMap<ObjectId, Option<Vec<u8>>>,
}

impl Blobs<'_> {
    fn load(&mut self, id: ObjectId) -> Result<()> {
        if self.cache.contains_key(&id) {
            return Ok(());
        }
        let (kind, size) = self.repo.object_header(id)?;
        if kind != gix::object::Kind::Blob {
            unsupported!("the object {id} is a {kind}, not a blob");
        }
        let data = if size > BIG_FILE { None } else { Some(self.repo.object(id, gix::object::Kind::Blob)?) };
        self.cache.insert(id, data);
        Ok(())
    }

    /// Is the blob binary, as git's `diff_filespec_is_binary` decides without attributes?
    fn binary(&mut self, side: Option<Side>) -> Result<bool> {
        let Some(side) = side else { return Ok(false) };
        self.load(side.id)?;
        Ok(match &self.cache[&side.id] {
            Some(data) => data[..data.len().min(BINARY_SNIFF)].contains(&0),
            None => true,
        })
    }

    /// A loaded blob's contents, or nothing for a missing side.
    fn text(&self, side: Option<Side>) -> &[u8] {
        side.and_then(|side| self.cache[&side.id].as_deref()).unwrap_or_default()
    }

    /// The `added\tdeleted` columns of `--numstat`, as git's `builtin_diffstat` counts them.
    fn numstat(&mut self, old: Option<Side>, new: Option<Side>) -> Result<String> {
        if self.binary(old)? || self.binary(new)? {
            return Ok("-\t-".to_owned());
        }
        if let (Some(old), Some(new)) = (old, new) {
            if old.id == new.id {
                // A rename, or a change of mode only
                return Ok("0\t0".to_owned());
            }
        }
        match lines::count(self.text(old), self.text(new)) {
            Some((added, deleted)) => Ok(format!("{added}\t{deleted}")),
            None => unsupported!("a file's diff is too large for the engine to count its lines as git does"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn side(byte: u8, mode: u32) -> Side {
        Side { id: ObjectId::from_bytes_or_panic(&[byte; 20]), mode }
    }

    fn change(path: &str, old: Option<Side>, new: Option<Side>) -> Change {
        Change { path: path.as_bytes().to_vec(), old, new }
    }

    fn describe(items: &[Item<'_>]) -> Vec<String> {
        let s = |path: &[u8]| String::from_utf8_lossy(path).into_owned();
        items
            .iter()
            .map(|item| match item {
                Item::Added(path, _) => format!("A {}", s(path)),
                Item::Deleted(path, _) => format!("D {}", s(path)),
                Item::Modified(path, _, _) => format!("M {}", s(path)),
                Item::Renamed(old, new, _, _) => format!("R {} {}", s(old), s(new)),
            })
            .collect()
    }

    const FILE: u32 = 0o100644;

    /// Blobs `[n; 20]` are `n` bytes long.
    fn sizes(id: ObjectId) -> Result<u64> {
        Ok(u64::from(id.as_bytes()[0]))
    }

    #[test]
    fn identical_files_are_renames_with_git_preferences() {
        // Two sources with the same contents: the one with the same name wins, then the first in path order
        let changes = [
            change("d/s2", None, Some(side(1, FILE))),
            change("s1", Some(side(1, FILE)), None),
            change("s2", Some(side(1, FILE)), None),
            change("t", None, Some(side(1, FILE))),
        ];
        assert_eq!(describe(&find_renames(&changes, sizes).unwrap()), ["R s2 d/s2", "R s1 t"]);
    }

    #[test]
    fn modes_and_types_decide_what_pairs() {
        // A symbolic link and a file with the same contents aren't a rename, exact or not
        let changes = [change("a", Some(side(1, tree::SYMLINK)), None), change("b", None, Some(side(1, FILE)))];
        assert_eq!(describe(&find_renames(&changes, sizes).unwrap()), ["D a", "A b"]);
        // An executable and a regular file are
        let changes = [change("a", Some(side(1, 0o100755)), None), change("b", None, Some(side(1, FILE)))];
        assert_eq!(describe(&find_renames(&changes, sizes).unwrap()), ["R a b"]);
        // A change of type is left out
        let changes =
            [change("a", Some(side(1, FILE)), Some(side(2, tree::SYMLINK))), change("m", Some(side(3, FILE)), Some(side(4, 0o100755)))];
        assert_eq!(describe(&find_renames(&changes, sizes).unwrap()), ["M m"]);
    }

    #[test]
    fn leftover_additions_and_deletions_are_unsupported_when_git_could_pair_them() {
        let changes = [change("a", Some(side(10, FILE)), None), change("b", None, Some(side(20, FILE)))];
        assert!(find_renames(&changes, sizes).is_err());
        // Git doesn't score a pair where one file is less than half the other's size, or isn't a regular file
        let changes = [change("a", Some(side(10, FILE)), None), change("b", None, Some(side(21, FILE)))];
        assert_eq!(describe(&find_renames(&changes, sizes).unwrap()), ["D a", "A b"]);
        let changes = [change("a", Some(side(10, tree::SYMLINK)), None), change("b", None, Some(side(11, FILE)))];
        assert_eq!(describe(&find_renames(&changes, sizes).unwrap()), ["D a", "A b"]);
        let changes = [change("a", Some(side(0, FILE)), None), change("b", None, Some(side(11, FILE)))];
        assert_eq!(describe(&find_renames(&changes, sizes).unwrap()), ["D a", "A b"]);
        // Only additions, or only deletions, need no search
        let changes = [change("a", None, Some(side(1, FILE))), change("b", None, Some(side(2, FILE)))];
        assert_eq!(describe(&find_renames(&changes, sizes).unwrap()), ["A a", "A b"]);
        let changes =
            [change("a", Some(side(1, FILE)), None), change("b", None, Some(side(1, FILE))), change("c", None, Some(side(2, FILE)))];
        assert_eq!(describe(&find_renames(&changes, sizes).unwrap()), ["R a b", "A c"]);
    }

    #[test]
    fn same_names() {
        assert!(same_name(b"a/b/c.txt", b"c.txt"));
        assert!(same_name(b"x", b"y/x"));
        assert!(!same_name(b"a/bc", b"c"));
    }
}
