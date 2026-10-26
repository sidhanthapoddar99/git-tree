//! `git reflog --format=... refs/stash --`: the stashes, newest first.

use gix::bstr::ByteSlice;

use crate::commit;
use crate::error::{unsupported, Result};
use crate::format::{self, Format};
use crate::reflog;
use crate::repo::Repo;

/// A stash, as one line of the extension's `git reflog` output.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct StashRecord {
    pub hash: String,
    /// The stash commit's parents: the commit it was made on, its index, and its untracked files.
    pub parents: Vec<String>,
    /// `refs/stash@{n}`, as `%gD` prints it.
    pub selector: String,
    pub author: String,
    pub email: String,
    pub date: i64,
    pub message: String,
}

pub fn stashes(repo: &Repo, format: Format) -> Result<Vec<StashRecord>> {
    repo.check_format(format)?;
    let Some(stash) = repo.find_ref(b"refs/stash".as_bstr())? else {
        // git reflog fails without refs/stash, and the extension then shows no stashes
        return Ok(Vec::new());
    };
    if stash.target().try_id().is_none() {
        unsupported!("refs/stash is a symbolic ref");
    }
    let path = repo.common_dir().join("logs").join("refs").join("stash");
    let Some(entries) = reflog::read(&path)? else {
        // git prints nothing for a ref without a reflog
        return Ok(Vec::new());
    };

    let mut stashes = Vec::with_capacity(entries.len());
    for (index, entry) in entries.iter().rev().enumerate() {
        // Git skips an entry whose commit is missing, but still counts it in the @{n} numbers
        let data = repo.commit_data(entry.new)?;
        let parsed = commit::parse(&data)?;
        let record = format::record(entry.new, &parsed, format)?;
        stashes.push(StashRecord {
            hash: record.hash,
            parents: record.parents,
            selector: format!("refs/stash@{{{index}}}"),
            author: record.author,
            email: record.email,
            date: record.date,
            message: record.message,
        });
    }
    Ok(stashes)
}
