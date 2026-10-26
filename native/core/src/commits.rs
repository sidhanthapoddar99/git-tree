//! The `commits` read: the refs and a log page with one open, and a token that lets a refresh skip the
//! walk when nothing the answer depends on has changed.
//!
//! The token is a SHA-1 over every input of the two answers:
//!
//! - the engine's version, and the request: `includeRemotes` and every field of the log request;
//! - the refs answer itself: HEAD's commit, every ref it lists with its target, and the peeled tags;
//! - HEAD: the ref it names, or that it's detached;
//! - what the log read finds before it walks ([`log::Plan`]): the commits the revisions resolve to, in
//!   order, with whether each came from a reflog, and the commit-graph's files and whether git orders
//!   the walk by their generation numbers.
//!
//! Past that, the walk reads only commit objects, which can't change for a given ID. The settings and
//! files the reads check, such as the repository's format and the environment ([`Repo::open`]), the
//! log output encoding, a mailmap, alternate object stores and `core.commitGraph`, are checked again on
//! every read before the token is compared, by the same code the single reads run. When one of them now
//! makes a part `Unsupported`, the read answers that part instead of `unchanged`. The engine applies no
//! mailmap: with the mailmap format, any mailmap makes the log `Unsupported`, so its contents never
//! reach an answer.

use std::collections::HashMap;

use crate::error::Result;
use crate::format::{CommitRecord, Format};
use crate::log::{self, LogRequest, Order};
use crate::refs::{self, Head, ShowRefLine};
use crate::repo::Repo;

/// The answer to a `commits` read.
#[derive(Debug)]
pub enum Commits {
    /// The token the read was given still describes the answer, so the log wasn't walked.
    Unchanged { token: String },
    /// Each part is the answer its own read gives. The token is `None` unless both are `Ok`.
    Read { token: Option<String>, refs: Result<Vec<ShowRefLine>>, log: Result<CompactLog> },
}

/// A log page with each (name, email) once, and each parent in the page as its index.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct CompactLog {
    /// Pair `k` is `people[2k]` (the name) and `people[2k + 1]` (the email).
    pub people: Vec<String>,
    /// `[hash, parents, person, date, message]`, in the log's order.
    pub commits: Vec<(String, Vec<Parent>, usize, i64, String)>,
}

/// A parent of a commit in a [`CompactLog`].
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(untagged)]
pub enum Parent {
    /// The parent's index in the page.
    Index(usize),
    /// The hash of a parent outside the page.
    Hash(String),
}

impl CompactLog {
    pub fn new(records: Vec<CommitRecord>) -> CompactLog {
        let positions: HashMap<&str, usize> = records.iter().enumerate().map(|(i, record)| (record.hash.as_str(), i)).collect();
        let mut people = Vec::new();
        let mut people_index: HashMap<(&str, &str), usize> = HashMap::new();
        let mut links = Vec::with_capacity(records.len());
        for record in &records {
            let parents = record
                .parents
                .iter()
                .map(|parent| match positions.get(parent.as_str()) {
                    Some(&index) => Parent::Index(index),
                    None => Parent::Hash(parent.clone()),
                })
                .collect::<Vec<_>>();
            let person = *people_index.entry((record.author.as_str(), record.email.as_str())).or_insert_with(|| {
                people.push(record.author.clone());
                people.push(record.email.clone());
                people.len() / 2 - 1
            });
            links.push((parents, person));
        }
        let commits = records
            .into_iter()
            .zip(links)
            .map(|(record, (parents, person))| (record.hash, parents, person, record.date, record.message))
            .collect();
        CompactLog { people, commits }
    }
}

/// The refs and a log page. `given` is the token of an earlier answer: when it still describes the
/// answer, the read returns [`Commits::Unchanged`] without walking the log.
pub fn commits(repo: &Repo, include_remotes: bool, request: &LogRequest, given: Option<&str>) -> Commits {
    let refs = refs::show_refs(repo, include_remotes);
    let plan = log::plan(repo, request);
    let token = match (&refs, &plan) {
        (Ok(refs), Ok(plan)) => token(repo, include_remotes, request, refs, plan),
        _ => None,
    };
    if let Some(token) = &token {
        if given == Some(token.as_str()) {
            return Commits::Unchanged { token: token.clone() };
        }
    }
    let log = plan.and_then(|plan| log::walk(repo, request, plan)).map(CompactLog::new);
    let token = if refs.is_ok() && log.is_ok() { token } else { None };
    Commits::Read { token, refs, log }
}

/// The token of an answer (see the module documentation), or `None` when it can't be computed.
fn token(repo: &Repo, include_remotes: bool, request: &LogRequest, refs: &[ShowRefLine], plan: &log::Plan) -> Option<String> {
    let mut token = Token::new();
    token.field(b"git-tree commits token 1");
    token.field(crate::VERSION.as_bytes());

    // Destructured, so a field added to the request can't be left out
    let LogRequest { revisions, max_count, order, first_parent, format } = request;
    let Format { mailmap, author_date } = *format;
    token.flag(include_remotes);
    token.count(revisions.len());
    for revision in revisions {
        token.field(revision.as_bytes());
    }
    token.count(*max_count);
    token.field(match order {
        Order::Date => b"date",
        Order::AuthorDate => b"author-date",
        Order::Topo => b"topo",
    });
    token.flag(*first_parent);
    token.flag(mailmap);
    token.flag(author_date);

    token.count(refs.len());
    for ShowRefLine { hash, name } in refs {
        token.field(hash.as_bytes());
        token.field(name.as_bytes());
    }
    match repo.head().ok()? {
        Head::Symbolic { name, id } => {
            token.field(b"symbolic");
            token.field(name.as_bytes());
            token.field(id.as_ref().map_or(&[][..], |id| id.as_bytes()));
        }
        Head::Detached(id) => {
            token.field(b"detached");
            token.field(id.as_bytes());
        }
    }
    plan.describe(&mut token);
    token.finish()
}

/// A SHA-1 over a sequence of fields. Each field carries its length, so two different sequences can't
/// give the same bytes.
pub(crate) struct Token(gix::hash::Hasher);

impl Token {
    fn new() -> Token {
        Token(gix::hash::hasher(gix::hash::Kind::Sha1))
    }

    pub(crate) fn field(&mut self, bytes: &[u8]) {
        self.count(bytes.len());
        self.0.update(bytes);
    }

    pub(crate) fn count(&mut self, count: usize) {
        self.0.update(&(count as u64).to_le_bytes());
    }

    pub(crate) fn flag(&mut self, flag: bool) {
        self.0.update(&[u8::from(flag)]);
    }

    /// The hash in hexadecimal, or `None` when gix's hasher detects a SHA-1 collision attack.
    fn finish(self) -> Option<String> {
        self.0.try_finalize().ok().map(|id| id.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(hash: &str, parents: &[&str], author: &str, email: &str) -> CommitRecord {
        CommitRecord {
            hash: hash.to_owned(),
            parents: parents.iter().map(|&parent| parent.to_owned()).collect(),
            author: author.to_owned(),
            email: email.to_owned(),
            date: 1_700_000_000,
            message: format!("Commit {hash}"),
        }
    }

    #[test]
    fn compact_logs_share_people_and_index_parents_in_the_page() {
        let log = CompactLog::new(vec![
            record("c", &["b", "x"], "Ada", "ada@example.com"),
            record("b", &["a"], "Ravi", "ravi@example.com"),
            record("a", &["root"], "Ada", "ada@example.com"),
            // The same name with another email is another person
            record("d", &[], "Ada", "ada@work.example"),
        ]);
        assert_eq!(log.people, ["Ada", "ada@example.com", "Ravi", "ravi@example.com", "Ada", "ada@work.example"]);
        assert_eq!(
            log.commits,
            [
                ("c".to_owned(), vec![Parent::Index(1), Parent::Hash("x".to_owned())], 0, 1_700_000_000, "Commit c".to_owned()),
                ("b".to_owned(), vec![Parent::Index(2)], 1, 1_700_000_000, "Commit b".to_owned()),
                ("a".to_owned(), vec![Parent::Hash("root".to_owned())], 0, 1_700_000_000, "Commit a".to_owned()),
                ("d".to_owned(), vec![], 2, 1_700_000_000, "Commit d".to_owned()),
            ]
        );
        assert_eq!(CompactLog::new(Vec::new()), CompactLog { people: Vec::new(), commits: Vec::new() });
    }

    #[test]
    fn token_fields_carry_their_lengths() {
        let hash = |fields: &[&[u8]]| {
            let mut token = Token::new();
            for field in fields {
                token.field(field);
            }
            token.finish().unwrap()
        };
        assert_eq!(hash(&[b"ab", b"c"]), hash(&[b"ab", b"c"]));
        assert_ne!(hash(&[b"ab", b"c"]), hash(&[b"a", b"bc"]));
        assert_ne!(hash(&[b"ab"]), hash(&[b"ab", b""]));
        assert_eq!(hash(&[]).len(), 40);
    }
}
