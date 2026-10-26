//! The commit fields the log and stash reads print: hash, parents, author, email, date and subject.

use gix::ObjectId;

use crate::commit::{self, Commit};
use crate::error::{unsupported, Context, Result};
use crate::repo::{utf8, Repo};

/// Which fields the extension's `--format` asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Format {
    /// `%aN %aE` (with the mailmap) instead of `%an %ae`.
    pub mailmap: bool,
    /// `%at` (the author date) instead of `%ct` (the commit date).
    pub author_date: bool,
}

/// A commit as one line of the extension's `git log` output.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct CommitRecord {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub date: i64,
    pub message: String,
}

impl Repo {
    /// Return `Unsupported` when git would print these fields differently from the commit's bytes.
    pub(crate) fn check_format(&self, format: Format) -> Result<()> {
        // git log re-encodes commits to i18n.logOutputEncoding, or else i18n.commitEncoding
        let output = self.config().string("i18n.logOutputEncoding").or_else(|| self.config().string("i18n.commitEncoding"));
        if output.is_some_and(|name| !commit::is_utf8_name(&name)) {
            unsupported!("git log re-encodes commits to another encoding than UTF-8");
        }
        if format.mailmap {
            // The engine doesn't apply a mailmap, so it can only answer when there is none
            if self.config().string("mailmap.file").is_some() || self.config().string("mailmap.blob").is_some() {
                unsupported!("the configuration names a mailmap");
            }
            match self.workdir() {
                // A bare repository reads HEAD:.mailmap
                None => unsupported!("a bare repository may have a mailmap"),
                Some(workdir) => {
                    if std::fs::symlink_metadata(workdir.join(".mailmap")).is_ok() {
                        unsupported!("the worktree has a .mailmap");
                    }
                }
            }
        }
        Ok(())
    }

    /// The bytes of a commit object, or `Unsupported` when it's missing or not a commit (git fails).
    pub(crate) fn commit_data(&self, id: ObjectId) -> Result<Vec<u8>> {
        let Some(object) = self.git.try_find_object(id).context("Unable to read a commit")? else {
            unsupported!("the commit {id} is missing");
        };
        if object.kind != gix::object::Kind::Commit {
            unsupported!("the object {id} is a {}, not a commit", object.kind);
        }
        Ok(object.detach().data)
    }
}

/// The record of a parsed commit. With no mailmap, `%aN` and `%aE` print the same as `%an` and `%ae`.
pub(crate) fn record(id: ObjectId, commit: &Commit<'_>, format: Format) -> Result<CommitRecord> {
    Ok(CommitRecord {
        hash: id.to_string(),
        parents: commit.parents.iter().map(ToString::to_string).collect(),
        author: utf8(commit.author.name, "an author name")?,
        email: utf8(commit.author.email, "an author email")?,
        date: if format.author_date { commit.author.time } else { commit.committer.time },
        message: utf8(&commit::subject(commit.message), "a commit subject")?,
    })
}
