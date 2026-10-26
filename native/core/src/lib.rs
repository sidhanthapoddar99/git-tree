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
//!
//! Every read opens the repository afresh, as each git command does.

mod commit;
mod error;
mod format;
mod log;
mod reflog;
mod refs;
mod remotes;
mod repo;
mod stash;
mod worktree;

use std::path::Path;

pub use error::{Error, Result};
pub use format::{CommitRecord, Format};
pub use log::{LogRequest, Order};
pub use refs::{BranchLine, ShowRefLine};
pub use repo::Repo;
pub use stash::StashRecord;
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

/// The engine's version, which is the extension's.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
