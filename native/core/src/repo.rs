//! Opening a repository, and the checks that decide whether the engine can read it like git does.
//!
//! The engine opens the repository afresh for every read. Git reads its configuration and refs anew for
//! every command, so a handle kept between reads could answer with a remote or a setting that no
//! longer exists.

use std::path::{Path, PathBuf};

use gix::bstr::{BStr, ByteSlice};
use gix::ObjectId;

use crate::error::{unsupported, Context, Error, Result};

/// Environment variables that change which repository, objects, refs or configuration git reads.
/// The extension passes its own environment to git, so when one of these is set the engine can't be
/// sure it reads what git reads.
const GIT_ENVIRONMENT: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
    "GIT_REPLACE_REF_BASE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_GRAFT_FILE",
    "GIT_SHALLOW_FILE",
    "GIT_CONFIG",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_CEILING_DIRECTORIES",
    "GIT_DISCOVERY_ACROSS_FILESYSTEM",
    "GIT_TEST_COMMIT_GRAPH",
    "GIT_REF_PARANOIA",
];

/// The repository extensions the engine reads like git does (`extensions.*` keys, lowercase).
const KNOWN_EXTENSIONS: &[&str] = &["objectformat", "refstorage", "worktreeconfig", "preciousobjects", "noop", "partialclone"];

/// An open repository that passed the checks in [`Repo::open`].
pub struct Repo {
    pub(crate) git: gix::Repository,
    /// The resolved configuration, kept so reads can borrow it.
    config: gix::config::File,
}

impl Repo {
    /// Open the repository that contains `path`, as git does when it runs in `path`.
    pub fn open(path: impl AsRef<Path>) -> Result<Repo> {
        for name in GIT_ENVIRONMENT {
            if std::env::var_os(name).is_some() {
                unsupported!("the environment variable {name} is set");
            }
        }
        let git = match gix::discover(path.as_ref()) {
            Ok(git) => git,
            // gix refuses to open a repository whose object format this build doesn't read (SHA-256).
            // Its error has no variant to match, so the engine reads the message of the pinned gix,
            // and a message that changes makes this a failed read, which Git Tree also hands to Git.
            Err(e) if format!("{e:?}").contains("extensions.objectFormat") => {
                unsupported!("the repository's extensions.objectFormat isn't sha1 (sha256 object IDs)")
            }
            Err(e) => return Err(Error::failed(format!("Unable to open the repository: {e}"))),
        };
        let config = git.config_snapshot().plumbing().clone();
        let repo = Repo { git, config };
        repo.check()?;
        Ok(repo)
    }

    /// Return `Unsupported` for a repository that git reads with rules the engine doesn't model.
    fn check(&self) -> Result<()> {
        if self.git.git_dir_trust() != gix::sec::Trust::Full {
            // Git refuses such a repository unless safe.directory names it
            unsupported!("the repository isn't owned by the current user");
        }
        if self.git.object_hash() != gix::hash::Kind::Sha1 {
            unsupported!("the repository uses {} object IDs", self.git.object_hash());
        }
        if uses_reftable(self.git.git_dir()) || uses_reftable(self.git.common_dir()) {
            unsupported!("the repository stores its refs in the reftable format");
        }

        let config = self.config();
        let format = config.integer("core.repositoryFormatVersion").context("Unable to read core.repositoryFormatVersion")?.unwrap_or(0);
        if let Some(sections) = config.sections_by_name("extensions") {
            for section in sections {
                for name in section.value_names() {
                    let name = name.to_ascii_lowercase();
                    if format == 0 || !KNOWN_EXTENSIONS.contains(&name.as_str()) {
                        unsupported!("the repository sets extensions.{name}");
                    }
                }
            }
        }
        if let Some(value) = config.string("extensions.refStorage") {
            if value.as_bstr() != "files" {
                unsupported!("the repository stores its refs in {value}");
            }
        }
        if format > 1 {
            unsupported!("the repository has format version {format}");
        }
        if let Some(sections) = config.sections_by_name("includeIf") {
            for section in sections {
                if section.header().subsection_name().is_some_and(|name| name.starts_with(b"hasconfig:")) {
                    unsupported!("the configuration has an includeIf.hasconfig section");
                }
            }
        }
        if self.git.workdir().is_none() && config.string("safe.bareRepository").is_some_and(|value| value.as_bstr() == "explicit") {
            unsupported!("safe.bareRepository is explicit, so git may refuse the repository");
        }

        let common = self.git.common_dir();
        if common.join("shallow").exists() {
            unsupported!("the repository is a shallow clone");
        }
        if common.join("info").join("grafts").exists() {
            unsupported!("the repository has grafts");
        }
        if self.has_refs("refs/replace/")? {
            unsupported!("the repository has replacement objects (git replace)");
        }
        Ok(())
    }

    /// The configuration git reads in this repository: system, global, local and worktree.
    pub(crate) fn config(&self) -> &gix::config::File {
        &self.config
    }

    /// A boolean setting, or `Unsupported` when its value isn't a boolean.
    pub(crate) fn config_bool(&self, key: &str) -> Result<Option<bool>> {
        self.config().boolean(key).map_err(|_| Error::unsupported(format!("{key} isn't a boolean")))
    }

    /// Does any ref start with `prefix`?
    pub(crate) fn has_refs(&self, prefix: &str) -> Result<bool> {
        let platform = self.git.references().context("Unable to read the refs")?;
        let mut refs = platform.prefixed(prefix).context("Unable to read the refs")?;
        Ok(refs.next().is_some())
    }

    /// The folder of the worktree the read runs in, or `None` in a bare repository.
    pub(crate) fn workdir(&self) -> Option<&Path> {
        self.git.workdir()
    }

    /// The repository's own folder, shared by all its worktrees.
    pub(crate) fn common_dir(&self) -> &Path {
        self.git.common_dir()
    }

    /// The folder of the worktree's own refs and logs: the common folder for the main worktree, or
    /// `worktrees/<id>` in it for a linked worktree.
    pub(crate) fn git_dir(&self) -> &Path {
        self.git.git_dir()
    }

    /// The bytes of an object of the given kind, or `Unsupported` when it's missing or of another
    /// kind: git fails then, or fetches it from a promisor remote, and the CLI read says which.
    pub(crate) fn object(&self, id: ObjectId, kind: gix::object::Kind) -> Result<Vec<u8>> {
        let Some(object) = self.git.try_find_object(id).context("Unable to read an object")? else {
            unsupported!("the object {id} is missing");
        };
        if object.kind != kind {
            unsupported!("the object {id} is a {}, not a {kind}", object.kind);
        }
        Ok(object.detach().data)
    }

    /// The kind and size of an object, or `Unsupported` when it's missing.
    pub(crate) fn object_header(&self, id: ObjectId) -> Result<(gix::object::Kind, u64)> {
        match self.git.try_find_header(id).context("Unable to read an object")? {
            Some(header) => Ok((header.kind(), header.size())),
            None => unsupported!("the object {id} is missing"),
        }
    }
}

/// A full object ID, as the extension passes it: 40 lowercase hexadecimal digits. Anything else is
/// `Unsupported`, because git would resolve it with rules the engine doesn't model.
pub(crate) fn full_id(hash: &str) -> Result<ObjectId> {
    if hash.len() != 40 || !hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        unsupported!("{hash:?} isn't a full object ID");
    }
    ObjectId::from_hex(hash.as_bytes()).context("Unable to read an object ID")
}

/// The home folder git uses: `HOME`, and on Windows, without it, `HOMEDRIVE` and `HOMEPATH` when that
/// folder exists, or else `USERPROFILE`, as Git for Windows sets `HOME` when it starts. `None` when git
/// has no home folder.
pub(crate) fn git_home() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("HOME") {
        return Some(PathBuf::from(home));
    }
    if cfg!(windows) {
        if let (Some(drive), Some(path)) = (std::env::var_os("HOMEDRIVE"), std::env::var_os("HOMEPATH")) {
            let mut home = drive;
            home.push(path);
            if Path::new(&home).is_dir() {
                return Some(PathBuf::from(home));
            }
        }
        return std::env::var_os("USERPROFILE").map(PathBuf::from);
    }
    None
}

/// A file in git's XDG configuration folder (`xdg_config_home`): `$XDG_CONFIG_HOME/git/<name>`, or
/// `~/.config/git/<name>`.
pub(crate) fn xdg_config_file(name: &str) -> Option<PathBuf> {
    match std::env::var_os("XDG_CONFIG_HOME") {
        Some(dir) if !dir.is_empty() => Some(PathBuf::from(dir).join("git").join(name)),
        _ => git_home().map(|home| home.join(".config").join("git").join(name)),
    }
}

/// Does the git folder use the reftable format? gix reads only the files format, and a reftable
/// repository would look like one without refs. Git's reftable layout replaces `refs/heads` with a
/// file, or `refs` itself, and keeps the tables in `reftable/`.
fn uses_reftable(git_dir: &Path) -> bool {
    git_dir.join("refs").is_file() || git_dir.join("refs").join("heads").is_file() || git_dir.join("reftable").exists()
}

/// Convert bytes from the repository to a string, or `Unsupported` when they aren't UTF-8. The CLI
/// decodes git's output as UTF-8, replacing what isn't, and the engine doesn't reproduce that.
pub(crate) fn utf8(bytes: &[u8], what: &str) -> Result<String> {
    match std::str::from_utf8(bytes) {
        Ok(text) => Ok(text.to_owned()),
        Err(_) => Err(Error::unsupported(format!("{what} isn't valid UTF-8"))),
    }
}

/// Convert a path to a string, or `Unsupported` when it isn't UTF-8.
pub(crate) fn path_string(path: &Path, what: &str) -> Result<String> {
    match path.to_str() {
        Some(text) => Ok(text.to_owned()),
        None => Err(Error::unsupported(format!("{what} isn't valid UTF-8"))),
    }
}

/// Convert a ref name to a string. On macOS git precomposes Unicode names (core.precomposeUnicode), and
/// the engine doesn't, so a name that isn't ASCII is `Unsupported` there.
pub(crate) fn ref_name(name: &BStr) -> Result<String> {
    if cfg!(target_os = "macos") && !name.is_ascii() {
        unsupported!("the ref name {name} isn't ASCII");
    }
    utf8(name, "a ref name")
}

/// `std::fs::canonicalize`, as git's `strbuf_realpath`.
pub(crate) fn real_path(path: &Path) -> Result<PathBuf> {
    std::fs::canonicalize(path).context("Unable to resolve the path")
}
