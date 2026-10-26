//! `git remote`: the names of the remotes in the configuration.

use std::collections::BTreeSet;

use crate::error::{unsupported, Result};
use crate::repo::{utf8, Repo};

/// The remotes, sorted and without repeats, as `git remote` prints them. Git makes a remote for every
/// `remote.<name>.<key>` setting, in any configuration file, unless the name starts with `/`.
pub fn remotes(repo: &Repo) -> Result<Vec<String>> {
    let mut names = BTreeSet::new();
    if let Some(sections) = repo.config().sections_by_name("remote") {
        for section in sections {
            let header = section.header();
            let Some(name) = header.subsection_name() else {
                // remote.pushDefault and the like
                continue;
            };
            if header.is_legacy() {
                unsupported!("the configuration has a [remote.{name}] section");
            }
            if section.body().num_values() == 0 || name.first() == Some(&b'/') {
                continue;
            }
            names.insert(utf8(name, "a remote name")?);
        }
    }
    // Sorted by bytes, as git's string_list_sort: UTF-8 strings sort the same way
    Ok(names.into_iter().collect())
}
