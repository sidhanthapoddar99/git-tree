//! A commit's details and subject, as the extension's `git show --quiet --format=...` and
//! `git log --format=%s -n 1` print them.
//!
//! A signed commit is `Unsupported` when the extension asks for the signature's status (`%G?`),
//! because git asks GPG or SSH to verify it. An unsigned commit's status is `N`, with no signer or key.

use crate::commit;
use crate::error::{unsupported, Result};
use crate::format::Format;
use crate::repo::{full_id, utf8, Repo};

/// Which fields the extension's commit details format asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailsFormat {
    /// `%aN %aE %cN %cE` (with the mailmap) instead of `%an %ae %cn %ce`.
    pub mailmap: bool,
    /// `%G? %GS %GK` (the signature's status, signer and key) instead of nothing.
    pub signature: bool,
}

/// A commit's fields, as the extension's `git show` format prints them.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetailsRecord {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub author_email: String,
    pub author_date: i64,
    pub committer: String,
    pub committer_email: String,
    pub committer_date: i64,
    /// `%G?`, or empty when the format doesn't ask for it.
    pub signature_status: String,
    /// `%GS`.
    pub signer: String,
    /// `%GK`.
    pub key: String,
    /// `%B` (the raw message), followed by the newline that ends git's output.
    pub body: String,
}

/// The details of the commit `hash`.
pub fn commit_details(repo: &Repo, hash: &str, format: DetailsFormat) -> Result<CommitDetailsRecord> {
    repo.check_format(Format { mailmap: format.mailmap, author_date: false })?;
    let id = full_id(hash)?;
    let data = repo.commit_data(id)?;
    let parsed = commit::parse(&data)?;
    if format.signature && parsed.signed {
        unsupported!("the commit is signed, and git verifies its signature");
    }
    if !parsed.has_body {
        // git's %B starts after the blank line that ends the headers
        unsupported!("the commit has no blank line after its headers");
    }
    Ok(CommitDetailsRecord {
        hash: id.to_string(),
        parents: parsed.parents.iter().map(ToString::to_string).collect(),
        author: utf8(parsed.author.name, "an author name")?,
        author_email: utf8(parsed.author.email, "an author email")?,
        author_date: parsed.author.time,
        committer: utf8(parsed.committer.name, "a committer name")?,
        committer_email: utf8(parsed.committer.email, "a committer email")?,
        committer_date: parsed.committer.time,
        signature_status: if format.signature { "N".to_owned() } else { String::new() },
        signer: String::new(),
        key: String::new(),
        body: utf8(parsed.message, "a commit message")? + "\n",
    })
}

/// The subject of the commit `hash`, as `%s` prints it.
pub fn commit_subject(repo: &Repo, hash: &str) -> Result<String> {
    repo.check_format(Format::default())?;
    let data = repo.commit_data(full_id(hash)?)?;
    let parsed = commit::parse(&data)?;
    utf8(&commit::subject(parsed.message), "a commit subject")
}
