//! `git worktree list --porcelain`, read from the repository's `worktrees/` folder as git reads it.

use std::path::Path;

use gix::bstr::ByteSlice;
use gix::ObjectId;

use crate::error::{unsupported, Context, Error, Result};
use crate::repo::{path_string, real_path, Repo};

/// One record of `git worktree list --porcelain`, without the `detached` line, which the extension
/// doesn't read: a worktree without a `branch` line is detached.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct WorktreeRecord {
    /// The `worktree <path>` line.
    pub path: String,
    /// The `HEAD <id>` line: forty zeros for a branch without commits, and `None` for a bare repository.
    pub head: Option<String>,
    /// The `branch <ref>` line, a full ref name.
    pub branch: Option<String>,
    pub bare: bool,
    pub locked: bool,
    pub prunable: bool,
}

/// A worktree's HEAD, read from its HEAD file.
pub(crate) struct WorktreeHead {
    /// The commit, or `None` for a branch without commits.
    pub id: Option<ObjectId>,
    /// The ref HEAD names, at the end of its chain of symbolic refs.
    pub branch: Option<String>,
}

pub fn worktrees(repo: &Repo) -> Result<Vec<WorktreeRecord>> {
    if cfg!(windows) {
        // Git's paths on Windows (drive letters, slashes, UNC paths) aren't checked against the CLI yet
        unsupported!("the engine doesn't list worktrees on Windows yet");
    }
    let common = repo.common_dir();
    let core_bare = repo.config_bool("core.bare")?;
    // Git's is_bare_repository(), from the worktree the command runs in
    let bare = core_bare == Some(true) || (core_bare != Some(false) && repo.workdir().is_none());

    // The main worktree: the real path of the common folder, without its /.git
    let common_real = path_string(&real_path(common)?, "the repository path")?;
    let main_path = match common_real.strip_suffix("/.git") {
        Some(path) => path.to_owned(),
        None if bare => common_real.clone(),
        None => unsupported!("the repository folder {common_real} isn't named .git"),
    };
    let mut records = vec![record(repo, main_path, &common.join("HEAD"), bare, false, false)?];

    let mut linked = Vec::new();
    for id in linked_ids(repo)? {
        let dir = common.join("worktrees").join(&id);
        let gitdir = std::fs::read(dir.join("gitdir")).context("Unable to read a worktree's gitdir")?;
        // Git trims all trailing whitespace for the path, and only CR and LF to test that it exists
        let trimmed = trim_end_matching(&gitdir, b" \t\n\r");
        if trimmed != trim_end_matching(&gitdir, b"\n\r") || trimmed.is_empty() {
            unsupported!("the gitdir file of the worktree {id} isn't in the form git writes");
        }
        let Ok(gitdir) = std::str::from_utf8(trimmed) else {
            unsupported!("the path of the worktree {id} isn't valid UTF-8");
        };
        if !Path::new(gitdir).is_absolute() || gitdir.contains(['\n', '\r']) {
            unsupported!("the gitdir file of the worktree {id} holds a relative or multi-line path");
        }
        let path = gitdir.strip_suffix("/.git").unwrap_or(gitdir).to_owned();
        let locked = std::fs::symlink_metadata(dir.join("locked")).is_ok();
        let prunable = !locked && std::fs::symlink_metadata(gitdir).is_err();
        linked.push(record(repo, path, &dir.join("HEAD"), false, locked, prunable)?);
    }

    // Git sorts the linked worktrees by path (fspathcmp), keeping the main worktree first
    if repo.config_bool("core.ignoreCase")? == Some(true) {
        linked.sort_by(|a, b| a.path.to_ascii_lowercase().as_bytes().cmp(b.path.to_ascii_lowercase().as_bytes()));
    } else {
        linked.sort_by(|a, b| a.path.as_bytes().cmp(b.path.as_bytes()));
    }
    records.extend(linked);
    Ok(records)
}

fn record(repo: &Repo, path: String, head_file: &Path, bare: bool, locked: bool, prunable: bool) -> Result<WorktreeRecord> {
    if path.contains(['\n', '\r']) {
        unsupported!("a worktree path holds a line break");
    }
    if cfg!(target_os = "macos") && !path.is_ascii() {
        unsupported!("the worktree path {path} isn't ASCII");
    }
    if bare {
        return Ok(WorktreeRecord { path, head: None, branch: None, bare, locked, prunable });
    }
    let head = read_head(repo, head_file)?;
    Ok(WorktreeRecord {
        path,
        head: Some(head.id.unwrap_or_else(|| ObjectId::null(gix::hash::Kind::Sha1)).to_string()),
        branch: head.branch,
        bare,
        locked,
        prunable,
    })
}

fn trim_end_matching<'a>(bytes: &'a [u8], set: &[u8]) -> &'a [u8] {
    let end = bytes.iter().rposition(|b| !set.contains(b)).map_or(0, |i| i + 1);
    &bytes[..end]
}

/// The linked worktrees git lists: the folders in `worktrees/` with a readable, non-empty gitdir file.
pub(crate) fn linked_ids(repo: &Repo) -> Result<Vec<String>> {
    let dir = repo.common_dir().join("worktrees");
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(Error::failed(format!("Unable to read {}: {e}", dir.display()))),
    };
    let mut ids = Vec::new();
    for entry in entries {
        let entry = entry.context("Unable to read the worktrees")?;
        let Some(id) = entry.file_name().to_str().map(str::to_owned) else {
            unsupported!("a worktree name isn't valid UTF-8");
        };
        match std::fs::read(entry.path().join("gitdir")) {
            Ok(gitdir) if !gitdir.is_empty() => ids.push(id),
            _ => {}
        }
    }
    Ok(ids)
}

/// Read a HEAD file as git's files backend does: `ref: <name>` or an object ID, each on one line.
pub(crate) fn read_head(repo: &Repo, path: &Path) -> Result<WorktreeHead> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| Error::unsupported(format!("{} is missing", path.display())))?;
    if !metadata.is_file() {
        unsupported!("{} isn't a file", path.display());
    }
    let data = std::fs::read(path).context("Unable to read HEAD")?;
    let Some(line) = data.strip_suffix(b"\n").filter(|line| !line.contains(&b'\n')) else {
        unsupported!("{} isn't one line", path.display());
    };
    if let Some(target) = line.strip_prefix(b"ref: ") {
        let resolved = repo.resolve_symbolic(target.as_bstr(), 1)?;
        if let Some(id) = resolved.id {
            if !repo.git.has_object(id) {
                unsupported!("{} points to a missing object", path.display());
            }
        }
        return Ok(WorktreeHead { id: resolved.id, branch: Some(resolved.name) });
    }
    if line.len() == 40 && line.iter().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        let id = ObjectId::from_hex(line).context("Unable to read HEAD")?;
        return Ok(WorktreeHead { id: Some(id), branch: None });
    }
    unsupported!("{} isn't in the form git writes", path.display())
}
