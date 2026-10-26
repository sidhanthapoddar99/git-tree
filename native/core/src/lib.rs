//! The Git Tree engine: reads Git repositories in-process, with gitoxide, instead of starting `git`.
//!
//! Each read answers what one `git` command of the extension prints, as structured records instead of
//! text: the extension's TypeScript code then treats both the same way. The `git` CLI read stays the
//! reference. When the engine can't be sure it would answer exactly as git does, it returns
//! [`Error::Unsupported`], and the extension runs the CLI read instead.
//!
//! | Read | The command it answers |
//! | --- | --- |
//! | [`branches`] | `git branch [-a] --no-color --no-column` |
//! | [`remotes`] | `git remote` |
//! | [`stashes`] | `git reflog --format=... refs/stash --` |
//! | [`worktrees`] | `git worktree list --porcelain` |
//! | [`show_refs`] | `git show-ref [--heads --tags] -d --head` |
//! | [`log`] | `git log --max-count=N --format=... --<order>-order [--first-parent] <revisions> --` |
//! | [`commit_details`] | `git show --quiet <commit> --format=...` |
//! | [`commit_subject`] | `git log --format=%s -n 1 <commit> --` |
//! | [`diff`] | `git diff --name-status\|--numstat --find-renames --diff-filter=AMDR -z <from> <to>`, or `git diff-tree ... -r --root <commit>` |
//! | [`commit_file`] | `git show <commit>:<path>` |
//! | [`config_list`] | `git config --list -z --includes [--local\|--global]` |
//! | [`remote_url`] | `git config --get remote.<name>.url` |
//! | [`tag_details`] | `git for-each-ref refs/tags/<name> --format=...` |
//!
//! Every read opens the repository afresh, as each git command does. A view load makes two reads, each
//! of which opens it once and answers several of the reads above, each part as its own read would:
//!
//! | Read | The reads it answers |
//! | --- | --- |
//! | [`repo_info`] | [`branches`], [`remotes`], [`stashes`] (when asked for) and [`worktrees`] |
//! | [`commits`] | [`show_refs`] and [`log`], with a token that skips the walk when nothing changed |

mod attributes;
mod blob;
mod commit;
mod commits;
mod config;
mod details;
mod diff;
mod error;
mod format;
mod lines;
mod log;
mod reflog;
mod refs;
mod remotes;
mod repo;
mod stash;
mod tag;
mod tree;
mod worktree;

use std::path::Path;

pub use commits::{Commits, CompactLog, Parent};
pub use config::ConfigLocation;
pub use details::{CommitDetailsRecord, DetailsFormat};
pub use diff::DiffRecords;
pub use error::{Error, Result};
pub use format::{CommitRecord, Format};
pub use log::{LogRequest, Order};
pub use refs::{BranchLine, ShowRefLine};
pub use repo::Repo;
pub use stash::StashRecord;
pub use tag::TagRecord;
pub use worktree::WorktreeRecord;

/// `git branch --no-color --no-column`, with `-a` when `include_remotes` is set.
pub fn branches(repo: impl AsRef<Path>, include_remotes: bool) -> Result<Vec<BranchLine>> {
    refs::branches(&Repo::open(repo)?, include_remotes)
}

/// `git remote`.
pub fn remotes(repo: impl AsRef<Path>) -> Result<Vec<String>> {
    remotes::remotes(&Repo::open(repo)?)
}

/// `git reflog --format=... refs/stash --`.
pub fn stashes(repo: impl AsRef<Path>, format: Format) -> Result<Vec<StashRecord>> {
    stash::stashes(&Repo::open(repo)?, format)
}

/// `git worktree list --porcelain`.
pub fn worktrees(repo: impl AsRef<Path>) -> Result<Vec<WorktreeRecord>> {
    worktree::worktrees(&Repo::open(repo)?)
}

/// `git show-ref -d --head`, or with `--heads --tags` when `include_remotes` isn't set.
pub fn show_refs(repo: impl AsRef<Path>, include_remotes: bool) -> Result<Vec<ShowRefLine>> {
    refs::show_refs(&Repo::open(repo)?, include_remotes)
}

/// `git log` with the extension's format.
pub fn log(repo: impl AsRef<Path>, request: &LogRequest) -> Result<Vec<CommitRecord>> {
    log::log(&Repo::open(repo)?, request)
}

/// `git show --quiet <commit> --format=...` with the extension's commit details format.
pub fn commit_details(repo: impl AsRef<Path>, hash: &str, format: DetailsFormat) -> Result<CommitDetailsRecord> {
    details::commit_details(&Repo::open(repo)?, hash, format)
}

/// `git log --format=%s -n 1 <commit> --`, without its newline.
pub fn commit_subject(repo: impl AsRef<Path>, hash: &str) -> Result<String> {
    details::commit_subject(&Repo::open(repo)?, hash)
}

/// `git diff --name-status` and `--numstat` between two commits, or `git diff-tree` of one commit.
pub fn diff(repo: impl AsRef<Path>, from: &str, to: &str) -> Result<DiffRecords> {
    diff::diff(&Repo::open(repo)?, from, to)
}

/// `git show <commit>:<path>`, in base64.
pub fn commit_file(repo: impl AsRef<Path>, hash: &str, path: &str) -> Result<String> {
    blob::commit_file(&Repo::open(repo)?, hash, path)
}

/// `git config --list -z --includes`, with `--local` or `--global`, as its NUL-separated records.
pub fn config_list(repo: impl AsRef<Path>, location: Option<ConfigLocation>) -> Result<Vec<String>> {
    config::list(&Repo::open(repo)?, location)
}

/// `git config --get remote.<name>.url`, or `None` when it isn't set.
pub fn remote_url(repo: impl AsRef<Path>, remote: &str) -> Result<Option<String>> {
    config::remote_url(&Repo::open(repo)?, remote)
}

/// `git for-each-ref refs/tags/<name>` with the extension's tag details format.
pub fn tag_details(repo: impl AsRef<Path>, name: &str) -> Result<TagRecord> {
    tag::tag_details(&Repo::open(repo)?, name)
}

/// The answers of the repository info reads, from one open. Each part is what its own read answers.
#[derive(Debug)]
pub struct RepoInfo {
    pub branches: Result<Vec<BranchLine>>,
    pub remotes: Result<Vec<String>>,
    /// `None` when the stashes weren't asked for.
    pub stashes: Option<Result<Vec<StashRecord>>>,
    pub worktrees: Result<Vec<WorktreeRecord>>,
}

/// [`branches`], [`remotes`], [`stashes`] with `stashes` as the format, unless it's `None`, and
/// [`worktrees`], with one open.
pub fn repo_info(repo: impl AsRef<Path>, include_remotes: bool, stashes: Option<Format>) -> Result<RepoInfo> {
    let repo = Repo::open(repo)?;
    Ok(RepoInfo {
        branches: refs::branches(&repo, include_remotes),
        remotes: remotes::remotes(&repo),
        stashes: stashes.map(|format| stash::stashes(&repo, format)),
        worktrees: worktree::worktrees(&repo),
    })
}

/// [`show_refs`] and [`log`], with one open, and the log as a [`CompactLog`]. When `token` is the
/// token of an answer that the repository would still give, the answer is [`Commits::Unchanged`].
pub fn commits(repo: impl AsRef<Path>, include_remotes: bool, request: &LogRequest, token: Option<&str>) -> Result<Commits> {
    Ok(commits::commits(&Repo::open(repo)?, include_remotes, request, token))
}

/// The engine's version, which is the extension's.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
