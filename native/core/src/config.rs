//! The configuration reads: `git config --list -z --includes [--local|--global]`, and
//! `git config --get remote.<name>.url`.
//!
//! gix reads the same files as git, in the same order, and follows their includes. It places an
//! included file's sections right after the section that includes it, where git lists them right after
//! the `path` entry. The two orders are the same when each include section has just one entry, so the
//! engine returns `Unsupported` for an include section with more.

use std::collections::HashMap;
use std::path::PathBuf;

use gix::bstr::BString;
use gix::config::Source;

use crate::error::{unsupported, Result};
use crate::repo::{git_home, utf8, xdg_config_file, Repo};

/// Which files `git config --list` reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConfigLocation {
    /// `--local`: the repository's own file.
    Local,
    /// `--global`: the user's file.
    Global,
}

/// One entry of the configuration: its full key, as git prints it, and its value.
struct Entry {
    key: String,
    value: BString,
}

/// `git config --list -z --includes`, with `--local` or `--global` when `location` is set. Each record
/// is what git prints between two NULs: the key, then a newline and the value.
pub fn list(repo: &Repo, location: Option<ConfigLocation>) -> Result<Vec<String>> {
    let sources: &[Source] = match location {
        None => {
            check_global_paths()?;
            &[Source::GitInstallation, Source::System, Source::Git, Source::User, Source::Local, Source::Worktree]
        }
        Some(ConfigLocation::Local) => {
            if !repo.common_dir().join("config").is_file() {
                unsupported!("the repository has no config file");
            }
            &[Source::Local]
        }
        Some(ConfigLocation::Global) => {
            check_global_paths()?;
            match global_source()? {
                Some(Source::User) => &[Source::User],
                Some(_) => &[Source::Git],
                // git fails to read ~/.gitconfig, which the extension reads as an empty list
                None => return Ok(Vec::new()),
            }
        }
    };
    entries(repo, sources)?
        .into_iter()
        .map(|entry| Ok(format!("{}\n{}", entry.key, utf8(&entry.value, "a configuration value")?)))
        .collect()
}

/// `git config --get remote.<name>.url`: the last value, or `None` when there is none (git fails).
pub fn remote_url(repo: &Repo, remote: &str) -> Result<Option<String>> {
    if remote.is_empty() || remote.contains(['\n', '\0']) {
        unsupported!("{remote:?} isn't a remote name git reads");
    }
    check_global_paths()?;
    let key = format!("remote.{remote}.url");
    let sources = [Source::GitInstallation, Source::System, Source::Git, Source::User, Source::Local, Source::Worktree];
    match entries(repo, &sources)?.into_iter().rev().find(|entry| entry.key == key) {
        Some(entry) => Ok(Some(utf8(&entry.value, "a remote's URL")?)),
        None => Ok(None),
    }
}

/// The entries of the sections from these sources, in the order git lists them.
fn entries(repo: &Repo, sources: &[Source]) -> Result<Vec<Entry>> {
    let mut entries = Vec::new();
    for section in repo.config().sections() {
        if !sources.contains(&section.meta().source) {
            continue;
        }
        let header = section.header();
        let name = header.name().to_ascii_lowercase();
        let body = section.body();
        if (name == b"include" || name == b"includeif") && body.num_values() > 1 {
            unsupported!("an include section of the configuration has more than one entry");
        }

        // The section and subsection, as git prints them. git lowercases a legacy `[section.sub]`.
        let mut prefix = utf8(&name, "a configuration section")?;
        if let Some(subsection) = header.subsection_name() {
            let subsection = if header.is_legacy() { subsection.to_ascii_lowercase() } else { subsection.to_vec() };
            prefix.push('.');
            prefix.push_str(&utf8(&subsection, "a configuration subsection")?);
        }

        // gix gives each name's values in order, an implicit value (`[core] bare`) as an empty one
        let mut values: HashMap<String, (Vec<BString>, usize)> = HashMap::new();
        for value_name in body.value_names() {
            let lowercase = value_name.to_ascii_lowercase();
            let (list, next) = values.entry(lowercase.clone()).or_insert_with(|| (body.values(&value_name), 0));
            let Some(value) = list.get(*next).cloned() else {
                unsupported!("the configuration has an entry gix doesn't give a value for");
            };
            *next += 1;
            entries.push(Entry { key: format!("{prefix}.{lowercase}"), value });
        }
    }
    Ok(entries)
}

/// The source `git config --global` reads: `~/.gitconfig`, or the XDG file when only it exists, or
/// `None` when neither exists. Some git versions read both files when both exist, so that is
/// `Unsupported`.
fn global_source() -> Result<Option<Source>> {
    let Some(home) = git_home() else {
        unsupported!("git has no home folder");
    };
    let user = home.join(".gitconfig").is_file();
    let xdg = xdg_config_file("config").is_some_and(|path| path.is_file());
    Ok(match (user, xdg) {
        (true, true) => unsupported!("both ~/.gitconfig and the XDG configuration file exist"),
        (true, false) => Some(Source::User),
        (false, true) => Some(Source::Git),
        (false, false) => None,
    })
}

/// Return `Unsupported` when gix would read the global files from other paths than git does.
fn check_global_paths() -> Result<()> {
    let mut env = |name: &str| std::env::var_os(name);
    let user: Option<PathBuf> = git_home().map(|home| home.join(".gitconfig"));
    if Source::User.storage_location(&mut env) != user {
        unsupported!("gix reads the user's configuration from another file than git");
    }
    if Source::Git.storage_location(&mut env) != xdg_config_file("config") {
        unsupported!("gix reads the XDG configuration from another file than git");
    }
    Ok(())
}
