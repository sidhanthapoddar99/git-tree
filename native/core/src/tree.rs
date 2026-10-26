//! Reading tree objects the way git's `decode_tree_entry` and `tree-diff.c` read them.
//!
//! Each entry is `<octal mode> <name>\0<object ID>`. Git keeps a file's mode as one of five canonical
//! values (`canon_mode`), so an old mode like `100664` reads as `100644`. The entries must be in
//! git's tree order, without repeats: git walks two trees side by side, and an unsorted tree would
//! make it pair entries the engine doesn't, so such a tree is `Unsupported`.

use std::cmp::Ordering;

use gix::ObjectId;

use crate::error::{unsupported, Context, Result};
use crate::repo::Repo;

pub(crate) const TREE: u32 = 0o040000;
pub(crate) const SYMLINK: u32 = 0o120000;
pub(crate) const GITLINK: u32 = 0o160000;
const TYPE_MASK: u32 = 0o170000;
const REGULAR_TYPE: u32 = 0o100000;

/// One entry of a tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Entry<'a> {
    /// The canonical mode: 040000, 100644, 100755, 120000 or 160000.
    pub mode: u32,
    pub name: &'a [u8],
    pub id: ObjectId,
}

impl Entry<'_> {
    pub(crate) fn is_tree(&self) -> bool {
        self.mode == TREE
    }
}

/// Is this mode a regular file (100644 or 100755)?
pub(crate) fn is_regular(mode: u32) -> bool {
    mode & TYPE_MASK == REGULAR_TYPE
}

/// Do two modes have different types (a file and a symbolic link, say)? Git reports such a change
/// as a type change (`T`) rather than a modification.
pub(crate) fn type_changed(a: u32, b: u32) -> bool {
    a & TYPE_MASK != b & TYPE_MASK
}

/// The entries of a tree object, in order.
pub(crate) fn entries(data: &[u8]) -> Result<Vec<Entry<'_>>> {
    let mut entries: Vec<Entry<'_>> = Vec::new();
    let mut rest = data;
    while !rest.is_empty() {
        let Some(space) = rest.iter().position(|&b| b == b' ') else {
            unsupported!("a tree has a malformed entry");
        };
        let mode = mode(&rest[..space])?;
        rest = &rest[space + 1..];
        let Some(nul) = rest.iter().position(|&b| b == 0) else {
            unsupported!("a tree has a malformed entry");
        };
        let name = &rest[..nul];
        rest = &rest[nul + 1..];
        if name.is_empty() || name.contains(&b'/') || name == b"." || name == b".." {
            unsupported!("a tree has an entry named {:?}", String::from_utf8_lossy(name));
        }
        if rest.len() < 20 {
            unsupported!("a tree has a malformed entry");
        }
        let id = ObjectId::try_from(&rest[..20]).context("Unable to read a tree entry")?;
        rest = &rest[20..];
        let entry = Entry { mode, name, id };
        if entries.last().is_some_and(|last| compare(last, &entry) != Ordering::Less) {
            unsupported!("a tree's entries aren't in git's order");
        }
        entries.push(entry);
    }
    Ok(entries)
}

/// Parse an octal mode and make it canonical, as git's `get_mode` and `canon_mode` do.
fn mode(text: &[u8]) -> Result<u32> {
    if text.is_empty() || text.len() > 7 || !text.iter().all(|b| matches!(b, b'0'..=b'7')) {
        unsupported!("a tree has a malformed mode");
    }
    let mode = text.iter().fold(0u32, |mode, &b| (mode << 3) | u32::from(b - b'0'));
    Ok(match mode & TYPE_MASK {
        REGULAR_TYPE => REGULAR_TYPE | if mode & 0o100 != 0 { 0o755 } else { 0o644 },
        SYMLINK => SYMLINK,
        TREE => TREE,
        GITLINK => GITLINK,
        // Git reads any other type as a submodule; the engine doesn't guess
        _ => unsupported!("a tree has an entry with the mode {mode:o}"),
    })
}

/// Git's tree order (`base_name_compare`): by name, as if a tree's name ended with `/`.
pub(crate) fn compare(a: &Entry<'_>, b: &Entry<'_>) -> Ordering {
    let common = a.name.len().min(b.name.len());
    match a.name[..common].cmp(&b.name[..common]) {
        Ordering::Equal => {
            let end = |entry: &Entry<'_>| match entry.name.get(common) {
                Some(&byte) => byte,
                None if entry.is_tree() => b'/',
                None => 0,
            };
            end(a).cmp(&end(b))
        }
        order => order,
    }
}

impl Repo {
    /// The tree of a commit, or a tree's own ID for a tree.
    pub(crate) fn tree_data(&self, id: ObjectId) -> Result<Vec<u8>> {
        self.object(id, gix::object::Kind::Tree)
    }

    /// The entry at a path (`a/b/c`) in a tree, or `None` when the path isn't there.
    pub(crate) fn tree_entry(&self, tree: ObjectId, path: &[u8]) -> Result<Option<(u32, ObjectId)>> {
        let mut current = tree;
        let mut components = path.split(|&b| b == b'/').peekable();
        while let Some(component) = components.next() {
            let data = self.tree_data(current)?;
            let Some(entry) = entries(&data)?.into_iter().find(|entry| entry.name == component) else {
                return Ok(None);
            };
            if components.peek().is_none() {
                return Ok(Some((entry.mode, entry.id)));
            }
            if !entry.is_tree() {
                return Ok(None);
            }
            current = entry.id;
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut data = Vec::new();
        for (mode, name) in entries {
            data.extend_from_slice(format!("{mode} {name}\0").as_bytes());
            data.extend_from_slice(&[7; 20]);
        }
        data
    }

    #[test]
    fn modes_are_made_canonical() {
        let data = tree(&[("100664", "a"), ("100775", "b"), ("40000", "c"), ("120000", "d"), ("160000", "e")]);
        let modes: Vec<u32> = entries(&data).unwrap().iter().map(|entry| entry.mode).collect();
        assert_eq!(modes, [0o100644, 0o100755, TREE, SYMLINK, GITLINK]);
        assert!(entries(&tree(&[("100648", "a")])).is_err());
        assert!(entries(&tree(&[("010644", "a")])).is_err());
    }

    #[test]
    fn trees_sort_as_if_they_ended_with_a_slash() {
        // a.txt < a/ < a0, so a file a.txt comes before a tree a, which comes before a file a0
        assert!(entries(&tree(&[("100644", "a.txt"), ("40000", "a"), ("100644", "a0")])).is_ok());
        assert!(entries(&tree(&[("40000", "a"), ("100644", "a.txt")])).is_err());
        assert!(entries(&tree(&[("100644", "a"), ("100644", "a")])).is_err());
        // A file and a tree of the same name are two entries, the file first
        assert!(entries(&tree(&[("100644", "a"), ("40000", "a")])).is_ok());
    }

    #[test]
    fn unusual_names_are_unsupported() {
        assert!(entries(&tree(&[("100644", ".")])).is_err());
        assert!(entries(&tree(&[("100644", "")])).is_err());
        assert!(entries(b"100644 a\0short").is_err());
    }
}
