//! Refs: listing them as git's ref iteration does, HEAD, and resolving the names `git log` is given.

use gix::bstr::{BStr, ByteSlice};
use gix::refs::TargetRef;
use gix::ObjectId;

use crate::error::{unsupported, Context, Error, Result};
use crate::repo::{ref_name, Repo};

/// Git follows at most this many symbolic refs in a row (`SYMREF_MAXDEPTH`).
const MAX_SYMREF_DEPTH: usize = 5;

/// Refs that belong to one worktree. Looked up from another worktree, gix and git could disagree on
/// which worktree's ref they mean.
pub(crate) const PER_WORKTREE_PREFIXES: &[&str] = &["refs/bisect/", "refs/worktree/", "refs/rewritten/"];

/// A ref, resolved through symbolic refs to the object it names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Ref {
    /// The full name, like `refs/heads/main`.
    pub name: String,
    pub id: ObjectId,
}

/// The HEAD of the worktree the read runs in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Head {
    /// HEAD names a ref. `name` is the ref at the end of the chain of symbolic refs, and `id` is
    /// `None` when that ref doesn't exist yet (an unborn branch).
    Symbolic {
        name: String,
        id: Option<ObjectId>,
    },
    Detached(ObjectId),
}

impl Head {
    /// The commit HEAD resolves to, if it does.
    pub fn id(&self) -> Option<ObjectId> {
        match self {
            Head::Symbolic { id, .. } => *id,
            Head::Detached(id) => Some(*id),
        }
    }
}

/// What a symbolic ref resolves to: the last ref in its chain, and that ref's object if it exists.
pub(crate) struct Resolved {
    pub name: String,
    pub id: Option<ObjectId>,
}

/// One line of `git show-ref -d --head`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ShowRefLine {
    pub hash: String,
    /// `HEAD`, a full ref name, or a full ref name followed by `^{}` for the object an annotated tag
    /// points to.
    #[serde(rename = "ref")]
    pub name: String,
}

/// One line of `git branch [-a]`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct BranchLine {
    /// The name `git branch` prints: `main`, or `remotes/origin/main`. For a symbolic ref, the part
    /// before ` -> `.
    pub name: String,
    /// Is this the line marked with `*`, HEAD's branch?
    pub current: bool,
}

impl Repo {
    /// The refs whose names start with `prefix`, sorted by name, as git's ref iteration lists them.
    ///
    /// Like git, it leaves out a symbolic ref whose target doesn't exist. A ref to a missing object is
    /// `Unsupported`: git leaves it out with a warning, but a missing object usually means the
    /// repository is damaged or a partial clone, and the CLI read is then the safer one.
    pub(crate) fn refs(&self, prefix: &str) -> Result<Vec<Ref>> {
        let platform = self.git.references().context("Unable to read the refs")?;
        let mut refs = Vec::new();
        for reference in platform.prefixed(prefix).context("Unable to read the refs")? {
            let reference = reference.map_err(|e| Error::unsupported(format!("a ref can't be read: {e}")))?;
            let name = ref_name(reference.name().as_bstr())?;
            let id = match reference.target() {
                TargetRef::Object(id) => id.to_owned(),
                TargetRef::Symbolic(target) => match self.resolve_symbolic(target.as_bstr(), 1)?.id {
                    Some(id) => id,
                    None => continue,
                },
            };
            if !self.git.has_object(id) {
                unsupported!("the ref {name} points to a missing object");
            }
            refs.push(Ref { name, id });
        }
        refs.sort_by(|a, b| a.name.as_bytes().cmp(b.name.as_bytes()));
        Ok(refs)
    }

    /// Find the ref with exactly this full name. gix's lookup also tries `refs/heads/<name>` and the
    /// other short forms, which git doesn't for a full name, so the found name is checked.
    pub(crate) fn find_ref(&self, name: &BStr) -> Result<Option<gix::Reference<'_>>> {
        let found = self.git.try_find_reference(name).map_err(|e| Error::unsupported(format!("the ref {name} can't be read: {e}")))?;
        Ok(found.filter(|reference| reference.name().as_bstr() == name))
    }

    /// Follow a symbolic ref's target, as git's `refs_resolve_ref_unsafe` does without
    /// `RESOLVE_REF_READING`: a missing ref at the end of the chain gives its name and no object.
    pub(crate) fn resolve_symbolic(&self, target: &BStr, depth: usize) -> Result<Resolved> {
        if depth > MAX_SYMREF_DEPTH {
            unsupported!("the symbolic ref {target} is nested too deeply");
        }
        if PER_WORKTREE_PREFIXES.iter().any(|prefix| target.starts_with(prefix.as_bytes())) || !target.starts_with(b"refs/") {
            unsupported!("a symbolic ref points to {target}");
        }
        let name = ref_name(target)?;
        let Some(reference) = self.find_ref(target)? else {
            return Ok(Resolved { name, id: None });
        };
        match reference.target() {
            TargetRef::Object(id) => Ok(Resolved { name, id: Some(id.to_owned()) }),
            TargetRef::Symbolic(next) => self.resolve_symbolic(next.as_bstr(), depth + 1),
        }
    }

    /// The HEAD of the worktree the read runs in.
    pub(crate) fn head(&self) -> Result<Head> {
        let head = self.git.head().context("Unable to read HEAD")?;
        let head = match head.kind {
            gix::head::Kind::Detached { target, .. } => Head::Detached(target),
            gix::head::Kind::Unborn(name) => {
                let name = name.as_bstr();
                self.resolve_symbolic(name, 1)?;
                Head::Symbolic { name: ref_name(name)?, id: None }
            }
            gix::head::Kind::Symbolic(reference) => {
                let name = reference.name.as_bstr();
                if !name.starts_with(b"refs/") || PER_WORKTREE_PREFIXES.iter().any(|prefix| name.starts_with(prefix.as_bytes())) {
                    unsupported!("HEAD points to {name}");
                }
                match reference.target {
                    gix::refs::Target::Object(id) => Head::Symbolic { name: ref_name(name)?, id: Some(id) },
                    gix::refs::Target::Symbolic(next) => {
                        let resolved = self.resolve_symbolic(next.as_bstr(), 2)?;
                        Head::Symbolic { name: resolved.name, id: resolved.id }
                    }
                }
            }
        };
        if let Some(id) = head.id() {
            if !self.git.has_object(id) {
                unsupported!("HEAD points to a missing object");
            }
        }
        Ok(head)
    }

    /// Follow tags to the object they point to. Returns the object and whether `id` was a tag.
    pub(crate) fn peel(&self, id: ObjectId) -> Result<(ObjectId, gix::object::Kind, bool)> {
        let mut current = id;
        // Git peels at most this deep too (`MAXDEPTH` in its tag code is lower, but no real tag nests so far)
        for depth in 0..64 {
            let Some(header) = self.git.try_find_header(current).context("Unable to read an object")? else {
                unsupported!("the object {current} is missing");
            };
            if header.kind() != gix::object::Kind::Tag {
                return Ok((current, header.kind(), depth > 0));
            }
            let tag = self.git.find_object(current).context("Unable to read a tag")?;
            current = tag_target(&tag.data)?;
        }
        unsupported!("the tag {id} is nested too deeply")
    }

    /// Resolve a revision given to `git log`: `HEAD`, a full object ID, or a ref name that git finds
    /// with its `ref_rev_parse_rules`. Anything else, like `HEAD~2` or an abbreviated ID, is
    /// `Unsupported`, as is a name that doesn't resolve (git fails on it).
    pub(crate) fn resolve_revision(&self, name: &str) -> Result<ObjectId> {
        if name == "HEAD" {
            return match self.head()?.id() {
                Some(id) => Ok(id),
                None => Err(Error::unsupported("HEAD has no commits")),
            };
        }
        if name.len() == 40 && name.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
            let id = ObjectId::from_hex(name.as_bytes()).context("Unable to read an object ID")?;
            if !self.git.has_object(id) {
                unsupported!("the object {name} is missing");
            }
            return Ok(id);
        }
        if !is_plain_ref_name(name) {
            unsupported!("the revision {name} isn't a plain ref name");
        }
        if name.bytes().all(|b| b.is_ascii_uppercase() || b == b'_') {
            // A pseudo-ref like FETCH_HEAD, which git reads from a file in the git folder
            unsupported!("the revision {name} is a pseudo-ref");
        }
        if self.git_dir().join(name).exists() || self.common_dir().join(name).exists() {
            // Older git versions resolve a name to a file of that name in the git folder first
            unsupported!("the revision {name} matches a file in the git folder");
        }

        // git's ref_rev_parse_rules, in order; the first ref that resolves wins
        let candidates = [
            name.to_owned(),
            format!("refs/{name}"),
            format!("refs/tags/{name}"),
            format!("refs/heads/{name}"),
            format!("refs/remotes/{name}"),
            format!("refs/remotes/{name}/HEAD"),
        ];
        for candidate in candidates.iter().filter(|candidate| candidate.starts_with("refs/")) {
            if PER_WORKTREE_PREFIXES.iter().any(|prefix| candidate.starts_with(prefix)) {
                unsupported!("the revision {name} names a per-worktree ref");
            }
            let Some(reference) = self.find_ref(candidate.as_bytes().as_bstr())? else {
                continue;
            };
            let id = match reference.target() {
                TargetRef::Object(id) => Some(id.to_owned()),
                TargetRef::Symbolic(target) => self.resolve_symbolic(target.as_bstr(), 1)?.id,
            };
            if let Some(id) = id {
                if !self.git.has_object(id) {
                    unsupported!("the ref {candidate} points to a missing object");
                }
                return Ok(id);
            }
        }
        unsupported!("the revision {name} doesn't resolve")
    }
}

/// The object a tag points to: its first line, `object <id>`.
fn tag_target(data: &[u8]) -> Result<ObjectId> {
    let line = data.split(|&b| b == b'\n').next().unwrap_or_default();
    match line.strip_prefix(b"object ") {
        Some(hex) if hex.len() == 40 => ObjectId::from_hex(hex).map_err(|_| Error::unsupported("a tag has a malformed object header")),
        _ => Err(Error::unsupported("a tag doesn't start with an object header")),
    }
}

/// Is `name` something git can only read as a ref name, with no revision syntax (`~`, `^`, `:`, `@{`,
/// `..`) and nothing `check_refname_format` refuses?
pub(crate) fn is_plain_ref_name(name: &str) -> bool {
    !name.is_empty()
        && name != "@"
        && !name.starts_with('-')
        && !name.starts_with('/')
        && !name.ends_with('/')
        && !name.ends_with('.')
        && !name.ends_with(".lock")
        && !name.contains("..")
        && !name.contains("//")
        && !name.contains("@{")
        && !name.contains("/.")
        && !name.starts_with('.')
        && name.bytes().all(|b| b > b' ' && b != 0x7f && !b"~^:?*[\\".contains(&b))
}

/// `git show-ref -d --head`, or `git show-ref --heads --tags -d --head` without `include_remotes`.
///
/// Only HEAD and the refs under `refs/heads/`, `refs/remotes/` and `refs/tags/` are returned: those
/// are the lines the extension reads. Git lists them in this order, because it sorts all refs by name.
pub fn show_refs(repo: &Repo, include_remotes: bool) -> Result<Vec<ShowRefLine>> {
    let mut lines = Vec::new();
    if let Some(id) = repo.head()?.id() {
        lines.push(ShowRefLine { hash: id.to_string(), name: "HEAD".to_owned() });
    }
    let prefixes: &[&str] = if include_remotes { &["refs/heads/", "refs/remotes/", "refs/tags/"] } else { &["refs/heads/", "refs/tags/"] };
    for prefix in prefixes {
        for reference in repo.refs(prefix)? {
            let (peeled, _, was_tag) = repo.peel(reference.id)?;
            lines.push(ShowRefLine { hash: reference.id.to_string(), name: reference.name.clone() });
            if was_tag {
                lines.push(ShowRefLine { hash: peeled.to_string(), name: reference.name + "^{}" });
            }
        }
    }
    if lines.is_empty() {
        // git show-ref fails when it finds nothing
        unsupported!("the repository has no refs");
    }
    Ok(lines)
}

/// `git branch --no-color --no-column`, or `git branch -a ...` with `include_remotes`.
///
/// A detached HEAD's `(HEAD detached at ...)` line is left out: the extension leaves it out too.
pub fn branches(repo: &Repo, include_remotes: bool) -> Result<Vec<BranchLine>> {
    if repo.config().string("branch.sort").is_some() {
        unsupported!("branch.sort changes the order git branch lists branches in");
    }
    let current = match repo.head()? {
        Head::Symbolic { name, id: Some(_) } => Some(name),
        _ => None,
    };
    let mut lines = Vec::new();
    let prefixes: &[&str] = if include_remotes { &["refs/heads/", "refs/remotes/"] } else { &["refs/heads/"] };
    for prefix in prefixes {
        for reference in repo.refs(prefix)? {
            let shown = match reference.name.strip_prefix("refs/heads/") {
                Some(local) => local.to_owned(),
                None => reference.name["refs/".len()..].to_owned(),
            };
            lines.push(BranchLine { current: current.as_deref() == Some(reference.name.as_str()), name: shown });
        }
    }
    Ok(lines)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_ref_names() {
        for name in ["main", "feature/a", "remotes/origin/main", "v1.0.0", "refs/heads/x", "fix-crash_2"] {
            assert!(is_plain_ref_name(name), "{name}");
        }
        for name in ["", "@", "HEAD~2", "a^", "a:b", "a..b", "x@{1}", "-x", "/x", "x/", "x.", "x.lock", "a b", "a*", "a//b", "a/.b", ".a"] {
            assert!(!is_plain_ref_name(name), "{name}");
        }
    }

    #[test]
    fn tag_targets() {
        let id = "1111111111111111111111111111111111111111";
        assert_eq!(tag_target(format!("object {id}\ntype commit\n").as_bytes()).unwrap().to_string(), id);
        assert!(tag_target(b"type commit\n").is_err());
        assert!(tag_target(b"object 1234\n").is_err());
    }
}
