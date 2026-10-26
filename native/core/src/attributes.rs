//! Making sure no git attribute changes how git diffs a file.
//!
//! The `diff` attribute changes what `git diff --numstat` counts: `-diff` (or the `binary` macro) makes
//! a file binary, `diff` makes it text, and `diff=<driver>` can do either or convert it with textconv.
//! The engine doesn't apply attributes. It reads every file git would read them from, and answers
//! only when no line in them that could set `diff` matches a file of the diff. Lines that set only
//! attributes that don't change a diff of two commits, like `text` or `eol`, are left alone.
//!
//! Git reads, from first to last: its system file, the global file (`core.attributesFile`, or
//! `~/.config/git/attributes`), the `.gitattributes` of each folder from the root to the file's own,
//! and `info/attributes`. In a repository with a worktree, a folder's `.gitattributes` comes from the
//! worktree, or else from the index. In a bare repository, Git 2.43 to 2.45 read them from HEAD's tree,
//! so the engine reads them there too.
//!
//! Matching is decided only where it is certain. A pattern the engine can't match exactly (a quoted
//! one, a character class, a path with wildcards) counts as matching every file.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use gix::ObjectId;

use crate::error::{unsupported, Error, Result};
use crate::repo::{git_home, xdg_config_file, Repo};

const ATTRIBUTES_FILE: &[u8] = b".gitattributes";
/// Git ignores longer lines (`ATTR_MAX_LINE_LENGTH`), and older versions don't.
const MAX_LINE: usize = 2048;
/// Git ignores larger files (`ATTR_MAX_FILE_SIZE`), and older versions don't.
const MAX_FILE: usize = 100 * 1024 * 1024;

/// The attributes that don't change what git diffs between two commits: they apply when files are
/// checked out, checked in, merged, exported or shown elsewhere.
const HARMLESS: &[&str] = &[
    "text",
    "eol",
    "crlf",
    "ident",
    "filter",
    "merge",
    "conflict-marker-size",
    "whitespace",
    "export-ignore",
    "export-subst",
    "delta",
    "encoding",
    "working-tree-encoding",
    "lockable",
];

/// Return `Unsupported` when an attribute could change how git diffs one of these paths (full paths
/// from the root, with `/`).
pub(crate) fn check_diff(repo: &Repo, paths: &[&[u8]]) -> Result<()> {
    if paths.is_empty() {
        return Ok(());
    }
    for name in ["GIT_ATTR_SOURCE", "GIT_INDEX_FILE"] {
        if std::env::var_os(name).is_some() {
            unsupported!("the environment variable {name} is set");
        }
    }
    if repo.config().string("attr.tree").is_some() {
        unsupported!("attr.tree is set");
    }
    let ignore_case = repo.config_bool("core.ignoreCase")?.unwrap_or(false);
    let matches = |rules: &[Rule], base: &[u8]| {
        paths.iter().any(|path| {
            let Some(relative) = relative_to(path, base) else { return false };
            rules.iter().any(|rule| rule.pattern.matches(relative, ignore_case))
        })
    };

    // The files that apply to the whole repository
    for file in global_files(repo)? {
        if let Some(data) = read_file(&file)? {
            if matches(&rules(&data, &file.display().to_string())?, b"") {
                unsupported!("the attributes in {} may change how git diffs a file", file.display());
            }
        }
    }

    // The .gitattributes of each folder that holds a path, from the root down
    let mut folders: Vec<&[u8]> = Vec::new();
    for path in paths {
        let mut end = 0;
        folders.push(b"");
        while let Some(slash) = path[end..].iter().position(|&b| b == b'/') {
            end += slash;
            folders.push(&path[..end]);
            end += 1;
        }
    }
    folders.sort_unstable();
    folders.dedup();
    let source = Source::new(repo)?;
    for folder in folders {
        let mut file = folder.to_vec();
        if !file.is_empty() {
            file.push(b'/');
        }
        file.extend_from_slice(ATTRIBUTES_FILE);
        if let Some(data) = source.read(repo, &file)? {
            if matches(&rules(&data, &String::from_utf8_lossy(&file))?, folder) {
                unsupported!("the attributes in {} may change how git diffs a file", String::from_utf8_lossy(&file));
            }
        }
    }
    Ok(())
}

/// A path relative to a folder (`""` for the root), or `None` when the path isn't in the folder.
fn relative_to<'p>(path: &'p [u8], folder: &[u8]) -> Option<&'p [u8]> {
    if folder.is_empty() {
        return Some(path);
    }
    path.strip_prefix(folder)?.strip_prefix(b"/")
}

/// The attribute files that apply to every path: the system file, the global file and
/// `info/attributes`. Git's system file is in the folder of its system configuration; the engine looks
/// in every folder gix knows for it.
fn global_files(repo: &Repo) -> Result<Vec<PathBuf>> {
    let mut files: Vec<PathBuf> = Vec::new();
    if cfg!(unix) {
        files.push(PathBuf::from("/etc/gitattributes"));
    }
    if let Some(prefix) = gix::path::env::installation_config_prefix() {
        files.push(prefix.join("gitattributes"));
    }
    if cfg!(windows) {
        if let Some(prefix) = gix::path::env::system_prefix() {
            files.push(prefix.join("etc").join("gitattributes"));
            if let Some(parent) = prefix.parent() {
                files.push(parent.join("etc").join("gitattributes"));
            }
        }
    }
    match repo.config().string("core.attributesFile") {
        Some(value) => files.push(config_path(repo, &value)?),
        None => files.extend(xdg_config_file("attributes")),
    }
    files.push(repo.common_dir().join("info").join("attributes"));
    files.dedup();
    Ok(files)
}

/// A path setting, as git interpolates it: `~/` is the home folder, and a relative path is relative to
/// the folder git runs in.
fn config_path(repo: &Repo, value: &[u8]) -> Result<PathBuf> {
    let Ok(value) = std::str::from_utf8(value) else {
        unsupported!("core.attributesFile isn't valid UTF-8");
    };
    if let Some(rest) = value.strip_prefix("~/") {
        match git_home() {
            Some(home) => Ok(home.join(rest)),
            None => unsupported!("core.attributesFile starts with ~, and there is no home folder"),
        }
    } else if value.starts_with('~') || value.starts_with("%(") {
        unsupported!("core.attributesFile is {value}, which the engine doesn't interpolate")
    } else {
        Ok(repo.git.current_dir().join(value))
    }
}

/// Read an attribute file, or `None` when it doesn't exist.
fn read_file(path: &Path) -> Result<Option<Vec<u8>>> {
    match std::fs::read(path) {
        Ok(data) => Ok(Some(data)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(Error::unsupported(format!("the attribute file {} can't be read: {e}", path.display()))),
    }
}

/// Where a folder's `.gitattributes` comes from.
enum Source {
    /// The worktree, or else the index.
    Worktree { workdir: PathBuf, index: Arc<IndexAttributes> },
    /// A bare repository: HEAD's tree, or nothing when HEAD has no commits.
    Head(Option<ObjectId>),
}

impl Source {
    fn new(repo: &Repo) -> Result<Source> {
        match repo.workdir() {
            Some(workdir) => Ok(Source::Worktree { workdir: workdir.to_owned(), index: index_attributes(&repo.git_dir().join("index"))? }),
            None => {
                let tree = match repo.head()?.id() {
                    Some(id) => Some(crate::commit::parse(&repo.commit_data(id)?)?.tree),
                    None => None,
                };
                Ok(Source::Head(tree))
            }
        }
    }

    /// The contents of the `.gitattributes` at `path` (from the root), or `None` when there is none.
    fn read(&self, repo: &Repo, path: &[u8]) -> Result<Option<Vec<u8>>> {
        match self {
            Source::Worktree { workdir, index } => {
                let Ok(relative) = std::str::from_utf8(path) else {
                    unsupported!("a path isn't valid UTF-8");
                };
                let file = workdir.join(relative);
                match std::fs::symlink_metadata(&file) {
                    Ok(metadata) if metadata.is_file() => return read_file(&file),
                    // Git doesn't follow a symbolic link here, and older versions do
                    Ok(_) => unsupported!("{} isn't a regular file", file.display()),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => unsupported!("{} can't be read: {e}", file.display()),
                }
                match index.entries.get(path) {
                    None => Ok(None),
                    Some(Stage::Merged(id)) => Ok(Some(repo.object(*id, gix::object::Kind::Blob)?)),
                    Some(Stage::Conflicted) => unsupported!("{relative} has a merge conflict in the index"),
                }
            }
            Source::Head(None) => Ok(None),
            Source::Head(Some(tree)) => match repo.tree_entry(*tree, path)? {
                Some((mode, id)) if crate::tree::is_regular(mode) => Ok(Some(repo.object(id, gix::object::Kind::Blob)?)),
                Some(_) => unsupported!("HEAD's {} isn't a regular file", String::from_utf8_lossy(path)),
                None => Ok(None),
            },
        }
    }
}

/// A rule of an attribute file that could change how git diffs a file.
struct Rule {
    pattern: Pattern,
}

/// The rules of an attribute file that set an attribute other than the [`HARMLESS`] ones.
fn rules(data: &[u8], file: &str) -> Result<Vec<Rule>> {
    if data.len() >= MAX_FILE {
        unsupported!("the attribute file {file} is too large");
    }
    if data.contains(&0) {
        // Git stops reading at a NUL
        unsupported!("the attribute file {file} has a NUL byte");
    }
    let data = data.strip_prefix(b"\xef\xbb\xbf").unwrap_or(data);
    let is_blank = |b: &u8| matches!(b, b' ' | b'\t' | b'\r' | b'\n');
    let mut rules = Vec::new();
    for line in data.split(|&b| b == b'\n') {
        if line.len() >= MAX_LINE {
            unsupported!("the attribute file {file} has a line git may ignore");
        }
        let line = &line[line.iter().position(|b| !is_blank(b)).unwrap_or(line.len())..];
        if line.is_empty() || line[0] == b'#' {
            continue;
        }
        let mut words = line.split(is_blank).filter(|word| !word.is_empty());
        let pattern = words.next().unwrap_or_default();
        // `[attr]<name>` defines a macro, an attribute name that sets others. Its uses count as changing
        // a diff, since they aren't harmless names, unless it redefines one of those. A bare `[attr]`
        // is a pattern.
        if let Some(name) = pattern.strip_prefix(b"[attr]").filter(|name| !name.is_empty()) {
            if HARMLESS.iter().any(|harmless| harmless.as_bytes() == name) || name.starts_with(b"linguist-") {
                unsupported!("the attribute file {file} defines a macro named {}", String::from_utf8_lossy(name));
            }
            continue;
        }
        let harmful = words.any(|word| {
            let name = word.strip_prefix(b"-").or_else(|| word.strip_prefix(b"!")).unwrap_or(word);
            let name = name.split(|&b| b == b'=').next().unwrap_or_default();
            !HARMLESS.iter().any(|harmless| harmless.as_bytes() == name) && !name.starts_with(b"linguist-")
        });
        if harmful {
            rules.push(Rule { pattern: Pattern::new(pattern) });
        }
    }
    Ok(rules)
}

/// A pattern of an attribute file, as far as the engine can match it.
enum Pattern {
    /// The engine can't match it exactly, so it counts as matching every file.
    Any,
    /// A pattern without a `/`, matched against a file's name, with `*` and `?`.
    Name(Vec<u8>),
    /// A path from the attribute file's folder, without wildcards.
    Path(Vec<u8>),
}

impl Pattern {
    fn new(pattern: &[u8]) -> Pattern {
        let wild = |text: &[u8]| text.iter().any(|b| b"*?[\\".contains(b));
        if pattern.starts_with(b"\"") || pattern.starts_with(b"!") || pattern.ends_with(b"/") {
            // Quoted, negative (which git ignores) or folder patterns
            Pattern::Any
        } else if pattern.contains(&b'/') {
            let path = pattern.strip_prefix(b"/").unwrap_or(pattern);
            if wild(path) {
                Pattern::Any
            } else {
                Pattern::Path(path.to_vec())
            }
        } else if pattern.iter().any(|b| b"[\\".contains(b)) {
            Pattern::Any
        } else {
            Pattern::Name(pattern.to_vec())
        }
    }

    /// Could the pattern match the file at this path (relative to the attribute file's folder)?
    fn matches(&self, path: &[u8], ignore_case: bool) -> bool {
        let name = path.rsplit(|&b| b == b'/').next().unwrap_or(path);
        match self {
            Pattern::Any => true,
            Pattern::Path(pattern) => equal(pattern, path, ignore_case),
            Pattern::Name(pattern) => glob(pattern, name, ignore_case),
        }
    }
}

fn equal(a: &[u8], b: &[u8], ignore_case: bool) -> bool {
    if ignore_case {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

/// Match a name against a pattern of literal bytes, `*` (any bytes) and `?` (one byte).
fn glob(pattern: &[u8], name: &[u8], ignore_case: bool) -> bool {
    let same = |a: u8, b: u8| if ignore_case { a.eq_ignore_ascii_case(&b) } else { a == b };
    let (mut p, mut n) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while n < name.len() {
        if p < pattern.len() && pattern[p] == b'*' {
            star = Some((p, n));
            p += 1;
        } else if p < pattern.len() && (pattern[p] == b'?' || same(pattern[p], name[n])) {
            p += 1;
            n += 1;
        } else if let Some((star_p, star_n)) = star {
            p = star_p + 1;
            n = star_n + 1;
            star = Some((star_p, star_n + 1));
        } else {
            return false;
        }
    }
    pattern[p..].iter().all(|&b| b == b'*')
}

/// The `.gitattributes` entries of an index file.
#[derive(Default)]
struct IndexAttributes {
    entries: HashMap<Vec<u8>, Stage>,
}

enum Stage {
    Merged(ObjectId),
    Conflicted,
}

/// Each index's checksum, and its `.gitattributes` entries.
type IndexCache = HashMap<PathBuf, ([u8; 20], Arc<IndexAttributes>)>;

/// The `.gitattributes` entries of the index at this path, kept for as long as its checksum stays
/// the same, so a read doesn't decode a large index again.
fn index_attributes(path: &Path) -> Result<Arc<IndexAttributes>> {
    static CACHE: OnceLock<Mutex<IndexCache>> = OnceLock::new();
    let data = match std::fs::read(path) {
        Ok(data) => data,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Arc::default()),
        Err(e) => unsupported!("the index can't be read: {e}"),
    };
    let checksum: Option<[u8; 20]> = data.len().checked_sub(20).map(|start| data[start..].try_into().expect("20 bytes"));
    // index.skipHash writes a checksum of zeros, which says nothing about the contents
    let key = checksum.filter(|checksum| checksum.iter().any(|&b| b != 0));
    let cache = CACHE.get_or_init(Mutex::default);
    if let Some(key) = key {
        if let Some((cached, entries)) = cache.lock().map_err(|_| Error::failed("The index cache is poisoned"))?.get(path) {
            if *cached == key {
                return Ok(Arc::clone(entries));
            }
        }
    }
    let entries = Arc::new(read_index(&data)?);
    if let Some(key) = key {
        cache.lock().map_err(|_| Error::failed("The index cache is poisoned"))?.insert(path.to_owned(), (key, Arc::clone(&entries)));
    }
    Ok(entries)
}

/// Read an index file (versions 2 to 4), keeping its `.gitattributes` entries. A split index or a
/// sparse index is `Unsupported`: their entries are elsewhere.
fn read_index(data: &[u8]) -> Result<IndexAttributes> {
    let malformed = || Error::unsupported("the index is malformed");
    let u32_at = |at: usize| data.get(at..at + 4).map(|bytes| u32::from_be_bytes(bytes.try_into().expect("4 bytes"))).ok_or_else(malformed);
    if data.len() < 32 || &data[..4] != b"DIRC" {
        return Err(malformed());
    }
    let version = u32_at(4)?;
    if !(2..=4).contains(&version) {
        unsupported!("the index has version {version}");
    }
    let count = u32_at(8)? as usize;
    let end = data.len() - 20;
    let mut at = 12;
    let mut name: Vec<u8> = Vec::new();
    let mut found = IndexAttributes::default();
    for _ in 0..count {
        let fixed = data.get(at..at + 62).ok_or_else(malformed)?;
        let id = ObjectId::try_from(&fixed[40..60]).map_err(|_| malformed())?;
        let flags = u16::from_be_bytes([fixed[60], fixed[61]]);
        let extended = flags & 0x4000 != 0;
        if extended && version < 3 {
            return Err(malformed());
        }
        let stage = (flags >> 12) & 3;
        let mut cursor = at + 62 + if extended { 2 } else { 0 };
        if version == 4 {
            // The name is the previous one without its last N bytes, then a new ending
            let (strip, next) = varint(data, cursor).ok_or_else(malformed)?;
            name.truncate(name.len().checked_sub(strip).ok_or_else(malformed)?);
            cursor = next;
            let nul = data[cursor..end].iter().position(|&b| b == 0).ok_or_else(malformed)?;
            name.extend_from_slice(&data[cursor..cursor + nul]);
            at = cursor + nul + 1;
        } else {
            let nul = data[cursor..end].iter().position(|&b| b == 0).ok_or_else(malformed)?;
            name.clear();
            name.extend_from_slice(&data[cursor..cursor + nul]);
            // Entries are padded with NULs to a multiple of eight bytes
            let length = (cursor - at + nul + 8) & !7;
            at += length;
        }
        if at > end {
            return Err(malformed());
        }
        if name == ATTRIBUTES_FILE || name.ends_with(b"/.gitattributes") {
            let entry = if stage == 0 { Stage::Merged(id) } else { Stage::Conflicted };
            match found.entries.get(&name) {
                Some(_) => {
                    found.entries.insert(name.clone(), Stage::Conflicted);
                }
                None => {
                    found.entries.insert(name.clone(), entry);
                }
            }
        }
    }
    // The extensions: a split index keeps its entries in another file, and a sparse index keeps
    // folders as entries, with their .gitattributes in trees
    while at + 8 <= end {
        let signature = &data[at..at + 4];
        if signature == b"link" || signature == b"sdir" {
            unsupported!("the index is a split or sparse index");
        }
        at += 8 + u32_at(at + 4)? as usize;
    }
    Ok(found)
}

/// Git's offset varint (`decode_varint`).
fn varint(data: &[u8], mut at: usize) -> Option<(usize, usize)> {
    let mut byte = *data.get(at)?;
    at += 1;
    let mut value = usize::from(byte & 127);
    while byte & 128 != 0 {
        value = value.checked_add(1)?.checked_mul(128)?;
        byte = *data.get(at)?;
        at += 1;
        value = value.checked_add(usize::from(byte & 127))?;
    }
    Some((value, at))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn harmful(data: &str) -> Vec<String> {
        rules(data.as_bytes(), "test")
            .unwrap()
            .iter()
            .map(|rule| match &rule.pattern {
                Pattern::Any => "*any*".to_owned(),
                Pattern::Name(name) => format!("name:{}", String::from_utf8_lossy(name)),
                Pattern::Path(path) => format!("path:{}", String::from_utf8_lossy(path)),
            })
            .collect()
    }

    #[test]
    fn only_rules_that_change_diffs_count() {
        assert_eq!(harmful("* text=auto\n*.sh text eol=lf\n# *.png binary\n\n*.lfs filter=lfs -text\n"), Vec::<String>::new());
        assert_eq!(harmful("*.png binary\n*.pdf diff=astextplain\r\n*.min.js -diff\n"), ["name:*.png", "name:*.pdf", "name:*.min.js"]);
        assert_eq!(
            harmful("docs/*.md diff\n/vendor/lib.c diff\n\"a b\" -diff\n!x -diff\nbuild/ -diff\n"),
            ["*any*", "path:vendor/lib.c", "*any*", "*any*", "*any*"]
        );
        assert_eq!(harmful("*.x mymacro\n*.y linguist-generated\n"), ["name:*.x"]);
        assert!(rules(b"[attr]text -diff\n", "test").is_err());
        assert!(rules(b"[attr]mine -diff\n", "test").unwrap().is_empty());
        assert!(rules(format!("*.c {}\n", "x".repeat(MAX_LINE)).as_bytes(), "test").is_err());
    }

    #[test]
    fn names_match_like_git() {
        assert!(glob(b"*.pdf", b"a.pdf", false));
        assert!(!glob(b"*.pdf", b"a.PDF", false));
        assert!(glob(b"*.pdf", b"a.PDF", true));
        assert!(glob(b"a?c*", b"abcdef", false));
        assert!(!glob(b"a?c", b"ac", false));
        assert!(glob(b"*", b"anything", false));
        assert!(glob(b"*a*b", b"xaab", false));
        assert!(!glob(b"*a*b", b"xaabc", false));
        let pattern = Pattern::new(b"*.doc");
        assert!(pattern.matches(b"deep/folder/report.doc", false));
        assert!(!pattern.matches(b"deep/report.doc.txt", false));
        let path = Pattern::new(b"/a/b.c");
        assert!(path.matches(b"a/b.c", false));
        assert!(!path.matches(b"x/a/b.c", false));
    }

    #[test]
    fn relative_paths() {
        assert_eq!(relative_to(b"a/b/c", b""), Some(&b"a/b/c"[..]));
        assert_eq!(relative_to(b"a/b/c", b"a"), Some(&b"b/c"[..]));
        assert_eq!(relative_to(b"ab/c", b"a"), None);
    }

    #[test]
    fn varints_match_git() {
        assert_eq!(varint(&[0], 0), Some((0, 1)));
        assert_eq!(varint(&[127], 0), Some((127, 1)));
        assert_eq!(varint(&[0x80, 0], 0), Some((128, 2)));
        assert_eq!(varint(&[0x81, 0x7f], 0), Some((383, 2)));
    }
}
