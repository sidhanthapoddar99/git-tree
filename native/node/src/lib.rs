//! The Node-API module the extension loads (`src/engine.ts`).
//!
//! It has one read function. The request and the answer are JSON strings: V8 parses one JSON string
//! faster than Node-API builds the same objects one property at a time. Each read runs on a worker
//! thread of libuv's pool, so it doesn't block the extension host.
//!
//! The answer is one of:
//! - `{"ok": <records>}`
//! - `{"unsupported": "<why>"}`: the extension runs the `git` CLI read instead
//! - `{"failed": "<why>"}`: the read failed; the extension logs it and runs the `git` CLI read
//!
//! The view load's two reads answer several reads at once, each part in that same form:
//! - `repoInfo`: `{"ok": {"branches": <answer>, "remotes": <answer>, "stashes": <answer> | null, "worktrees": <answer>}}`
//! - `commits`: `{"ok": {"token": <token> | null, "refs": <answer>, "log": <answer>}}`, with the log in its
//!   compact form, or `{"ok": {"token": <token>, "unchanged": true}}`

use std::panic::{catch_unwind, AssertUnwindSafe};

use git_tree_engine::{
    BranchLine, Commits, CompactLog, ConfigLocation, DetailsFormat, Error, Format, LogRequest, RepoInfo, ShowRefLine, StashRecord,
    WorktreeRecord,
};
use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Task};
use napi_derive::napi;
use serde::Serialize;

#[derive(serde::Deserialize)]
#[serde(tag = "read", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum Request {
    Branches { repo: String, include_remotes: bool },
    Remotes { repo: String },
    Stashes { repo: String, format: Format },
    Worktrees { repo: String },
    Refs { repo: String, include_remotes: bool },
    Log { repo: String, log: LogRequest },
    CommitDetails { repo: String, hash: String, format: DetailsFormat },
    CommitSubject { repo: String, hash: String },
    Diff { repo: String, from: String, to: String },
    CommitFile { repo: String, hash: String, path: String },
    Config { repo: String, location: Option<ConfigLocation> },
    RemoteUrl { repo: String, remote: String },
    TagDetails { repo: String, name: String },
    RepoInfo { repo: String, include_remotes: bool, stashes: Option<Format> },
    Commits { repo: String, include_remotes: bool, log: LogRequest, token: Option<String> },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
enum Answer<T: Serialize> {
    Ok(T),
    Unsupported(String),
    Failed(String),
}

impl<T: Serialize> From<git_tree_engine::Result<T>> for Answer<T> {
    fn from(result: git_tree_engine::Result<T>) -> Answer<T> {
        match result {
            Ok(records) => Answer::Ok(records),
            Err(Error::Unsupported(why)) => Answer::Unsupported(why),
            Err(Error::Failed(why)) => Answer::Failed(why),
        }
    }
}

#[derive(Serialize)]
struct RepoInfoAnswer {
    branches: Answer<Vec<BranchLine>>,
    remotes: Answer<Vec<String>>,
    stashes: Option<Answer<Vec<StashRecord>>>,
    worktrees: Answer<Vec<WorktreeRecord>>,
}

impl From<RepoInfo> for RepoInfoAnswer {
    fn from(info: RepoInfo) -> RepoInfoAnswer {
        RepoInfoAnswer {
            branches: info.branches.into(),
            remotes: info.remotes.into(),
            stashes: info.stashes.map(Answer::from),
            worktrees: info.worktrees.into(),
        }
    }
}

#[derive(Serialize)]
#[serde(untagged)]
enum CommitsAnswer {
    Unchanged { token: String, unchanged: bool },
    Read { token: Option<String>, refs: Answer<Vec<ShowRefLine>>, log: Answer<CompactLog> },
}

impl From<Commits> for CommitsAnswer {
    fn from(commits: Commits) -> CommitsAnswer {
        match commits {
            Commits::Unchanged { token } => CommitsAnswer::Unchanged { token, unchanged: true },
            Commits::Read { token, refs, log } => CommitsAnswer::Read { token, refs: refs.into(), log: log.into() },
        }
    }
}

fn answer<T: Serialize>(result: git_tree_engine::Result<T>) -> String {
    serde_json::to_string(&Answer::from(result)).unwrap_or_else(|e| failed(&format!("Unable to write the answer: {e}")))
}

fn failed(why: &str) -> String {
    serde_json::to_string(&Answer::<()>::Failed(why.to_owned())).expect("a string serializes")
}

fn handle(request: &str) -> String {
    let request: Request = match serde_json::from_str(request) {
        Ok(request) => request,
        Err(e) => return failed(&format!("The request is malformed: {e}")),
    };
    match request {
        Request::Branches { repo, include_remotes } => answer(git_tree_engine::branches(repo, include_remotes)),
        Request::Remotes { repo } => answer(git_tree_engine::remotes(repo)),
        Request::Stashes { repo, format } => answer(git_tree_engine::stashes(repo, format)),
        Request::Worktrees { repo } => answer(git_tree_engine::worktrees(repo)),
        Request::Refs { repo, include_remotes } => answer(git_tree_engine::show_refs(repo, include_remotes)),
        Request::Log { repo, log } => answer(git_tree_engine::log(repo, &log)),
        Request::CommitDetails { repo, hash, format } => answer(git_tree_engine::commit_details(repo, &hash, format)),
        Request::CommitSubject { repo, hash } => answer(git_tree_engine::commit_subject(repo, &hash)),
        Request::Diff { repo, from, to } => answer(git_tree_engine::diff(repo, &from, &to)),
        Request::CommitFile { repo, hash, path } => answer(git_tree_engine::commit_file(repo, &hash, &path)),
        Request::Config { repo, location } => answer(git_tree_engine::config_list(repo, location)),
        Request::RemoteUrl { repo, remote } => answer(git_tree_engine::remote_url(repo, &remote)),
        Request::TagDetails { repo, name } => answer(git_tree_engine::tag_details(repo, &name)),
        Request::RepoInfo { repo, include_remotes, stashes } => {
            answer(git_tree_engine::repo_info(repo, include_remotes, stashes).map(RepoInfoAnswer::from))
        }
        Request::Commits { repo, include_remotes, log, token } => {
            answer(git_tree_engine::commits(repo, include_remotes, &log, token.as_deref()).map(CommitsAnswer::from))
        }
    }
}

pub struct Read {
    request: String,
}

impl Task for Read {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> napi::Result<String> {
        // A panic becomes a failed read rather than unwinding into libuv
        Ok(catch_unwind(AssertUnwindSafe(|| handle(&self.request))).unwrap_or_else(|panic| {
            let why =
                panic.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| panic.downcast_ref::<String>().cloned()).unwrap_or_default();
            failed(&format!("The engine panicked: {why}"))
        }))
    }

    fn resolve(&mut self, _env: Env, output: String) -> napi::Result<String> {
        Ok(output)
    }
}

/// Run a read. Resolves to the JSON answer.
#[napi]
pub fn read(request: String) -> AsyncTask<Read> {
    AsyncTask::new(Read { request })
}

/// The engine's version.
#[napi]
pub fn version() -> String {
    git_tree_engine::VERSION.to_owned()
}
