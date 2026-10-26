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

use std::panic::{catch_unwind, AssertUnwindSafe};

use git_tree_engine::{Error, Format, LogRequest};
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
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
enum Answer<T: Serialize> {
    Ok(T),
    Unsupported(String),
    Failed(String),
}

fn answer<T: Serialize>(result: git_tree_engine::Result<T>) -> String {
    let answer = match result {
        Ok(records) => Answer::Ok(records),
        Err(Error::Unsupported(why)) => Answer::Unsupported(why),
        Err(Error::Failed(why)) => Answer::Failed(why),
    };
    serde_json::to_string(&answer).unwrap_or_else(|e| failed(&format!("Unable to write the answer: {e}")))
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
