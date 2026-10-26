//! Reading a commit object the way `git log --format` reads it.
//!
//! The parser is strict on purpose. It accepts the commits that git itself writes, and returns
//! [`Error::Unsupported`] for anything unusual: a missing header, a malformed identity or date, a
//! duplicate header, a NUL byte, or a message in an encoding other than UTF-8. Git reads those
//! commits with its own rules for each case, and the engine doesn't guess what they are.

use gix::ObjectId;

use crate::error::{unsupported, Error, Result};

/// The parts of a commit object the view needs.
#[derive(Debug, PartialEq, Eq)]
pub struct Commit<'a> {
    pub parents: Vec<ObjectId>,
    pub author: Ident<'a>,
    pub committer: Ident<'a>,
    /// Everything after the blank line that ends the headers.
    pub message: &'a [u8],
}

/// An `author` or `committer` header: `Name <email> 1700000000 +0000`.
#[derive(Debug, PartialEq, Eq)]
pub struct Ident<'a> {
    /// The name, without the whitespace before the `<`, as `%an` prints it.
    pub name: &'a [u8],
    /// The text between `<` and `>`, as `%ae` prints it.
    pub email: &'a [u8],
    /// The Unix timestamp, as `%at` and `%ct` print it.
    pub time: i64,
}

/// The largest timestamp the engine accepts. It is below 2^53, so the number is exact in JavaScript.
const MAX_TIME_DIGITS: usize = 15;

/// Parse a commit object's bytes.
pub fn parse(data: &[u8]) -> Result<Commit<'_>> {
    if data.contains(&0) {
        // Git's format code stops at a NUL, and its header parser handles it in other ways
        unsupported!("the commit contains a NUL byte");
    }
    let mut rest = data;

    let tree = header_line(&mut rest)?;
    if hex_id(tree.strip_prefix(b"tree ")).is_none() {
        unsupported!("the commit doesn't start with a tree header");
    }

    // Git reads the parents only from the lines right after the tree
    let mut parents: Vec<ObjectId> = Vec::new();
    let mut line = header_line(&mut rest)?;
    while let Some(value) = line.strip_prefix(b"parent ") {
        let Some(parent) = hex_id(Some(value)) else {
            unsupported!("the commit has a malformed parent header");
        };
        if parents.contains(&parent) {
            unsupported!("the commit names the same parent twice");
        }
        parents.push(parent);
        line = header_line(&mut rest)?;
    }

    // Git reads the commit date from the committer line right after the author line
    let Some(author) = line.strip_prefix(b"author ") else {
        unsupported!("the commit has no author header after its parents");
    };
    let author = ident(author)?;
    let Some(committer) = header_line(&mut rest)?.strip_prefix(b"committer ") else {
        unsupported!("the commit has no committer header after its author");
    };
    let committer = ident(committer)?;

    // The other headers (encoding, gpgsig, mergetag...), up to the blank line before the message
    loop {
        if rest.is_empty() {
            // No message at all
            break;
        }
        let line = header_line(&mut rest)?;
        if line.is_empty() {
            break;
        }
        if line[0] == b' ' {
            // A continuation of the previous header
            continue;
        }
        let name = line.split(|&b| b == b' ').next().unwrap_or(line);
        match name {
            b"tree" | b"parent" | b"author" | b"committer" => {
                unsupported!("the commit has a second {} header", String::from_utf8_lossy(name));
            }
            b"encoding" => {
                let value = &line[name.len()..];
                let value = value.strip_prefix(b" ").unwrap_or(value);
                if !is_utf8_name(value) {
                    unsupported!("the commit is encoded in {}", String::from_utf8_lossy(value));
                }
            }
            _ => {}
        }
    }

    Ok(Commit { parents, author, committer, message: rest })
}

/// Take the next header line, which must end with a newline. Git stops reading the dates of a header
/// that doesn't.
fn header_line<'a>(rest: &mut &'a [u8]) -> Result<&'a [u8]> {
    match rest.iter().position(|&b| b == b'\n') {
        Some(end) => {
            let line = &rest[..end];
            *rest = &rest[end + 1..];
            Ok(line)
        }
        None => Err(Error::unsupported("a commit header doesn't end with a newline")),
    }
}

/// A 40-character lowercase hexadecimal object ID, and nothing else.
fn hex_id(value: Option<&[u8]>) -> Option<ObjectId> {
    let value = value?;
    if value.len() != 40 || !value.iter().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return None;
    }
    ObjectId::from_hex(value).ok()
}

/// Is this the name of the UTF-8 encoding, as git's `is_encoding_utf8` tests it?
pub(crate) fn is_utf8_name(name: &[u8]) -> bool {
    name.eq_ignore_ascii_case(b"utf-8") || name.eq_ignore_ascii_case(b"utf8")
}

/// Parse `Name <email> 1700000000 +0000`.
fn ident(line: &[u8]) -> Result<Ident<'_>> {
    let count = |c: u8| line.iter().filter(|&&b| b == c).count();
    if count(b'<') != 1 || count(b'>') != 1 {
        unsupported!("a commit identity doesn't have exactly one <email>");
    }
    let lt = line.iter().position(|&b| b == b'<').unwrap();
    let gt = line.iter().position(|&b| b == b'>').unwrap();
    if gt < lt {
        unsupported!("a commit identity has its > before its <");
    }

    let date = &line[gt + 1..];
    let Some(time) = ident_time(date) else {
        unsupported!("a commit identity has a malformed date");
    };

    Ok(Ident { name: trim_end_space(&line[..lt]), email: &line[lt + 1..gt], time })
}

/// Parse ` 1700000000 +0000` (the part after `>`), the only form git writes.
fn ident_time(date: &[u8]) -> Option<i64> {
    let date = date.strip_prefix(b" ")?;
    let space = date.iter().position(|&b| b == b' ')?;
    let (digits, zone) = (&date[..space], &date[space + 1..]);
    if digits.is_empty() || digits.len() > MAX_TIME_DIGITS || !digits.iter().all(u8::is_ascii_digit) {
        return None;
    }
    if zone.len() != 5 || !matches!(zone[0], b'+' | b'-') || !zone[1..].iter().all(u8::is_ascii_digit) {
        return None;
    }
    std::str::from_utf8(digits).ok()?.parse().ok()
}

/// Git's `isspace`: space, tab, LF and CR (not vertical tab or form feed).
fn is_space(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\r')
}

fn trim_end_space(bytes: &[u8]) -> &[u8] {
    let end = bytes.iter().rposition(|&b| !is_space(b)).map_or(0, |i| i + 1);
    &bytes[..end]
}

/// The length of the next line, including its newline.
fn line_len(bytes: &[u8]) -> usize {
    bytes.iter().position(|&b| b == b'\n').map_or(bytes.len(), |i| i + 1)
}

/// The subject of a commit message, as `%s` prints it: the lines of the first paragraph, each without
/// its trailing whitespace, joined with spaces. Blank lines before the paragraph are skipped. This is
/// git's `format_subject`, after `skip_blank_lines`.
pub fn subject(message: &[u8]) -> Vec<u8> {
    let mut rest = message;
    // Skip blank lines
    loop {
        let len = line_len(rest);
        if len == 0 || !trim_end_space(&rest[..len]).is_empty() {
            break;
        }
        rest = &rest[len..];
    }

    let mut subject = Vec::new();
    let mut first = true;
    loop {
        let len = line_len(rest);
        let line = trim_end_space(&rest[..len]);
        if line.is_empty() {
            break;
        }
        if !first {
            subject.push(b' ');
        }
        subject.extend_from_slice(line);
        first = false;
        rest = &rest[len..];
    }
    subject
}

#[cfg(test)]
mod tests {
    use super::*;

    const TREE: &str = "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n";
    const P1: &str = "1111111111111111111111111111111111111111";
    const P2: &str = "2222222222222222222222222222222222222222";

    fn commit(headers: &str, message: &str) -> Vec<u8> {
        format!(
            "{TREE}{headers}author Ada Park <ada@example.com> 1700000000 +0100\ncommitter Ravi <ravi@example.com> 1700000100 -0500\n\n{message}"
        )
        .into_bytes()
    }

    #[test]
    fn parses_a_merge_commit() {
        let data = commit(&format!("parent {P1}\nparent {P2}\n"), "Merge\n");
        let c = parse(&data).unwrap();
        assert_eq!(c.parents.iter().map(ToString::to_string).collect::<Vec<_>>(), [P1, P2]);
        assert_eq!(c.author, Ident { name: b"Ada Park", email: b"ada@example.com", time: 1_700_000_000 });
        assert_eq!(c.committer.time, 1_700_000_100);
        assert_eq!(c.message, b"Merge\n");
    }

    #[test]
    fn parses_a_root_commit_with_extra_headers() {
        let data = format!(
            "{TREE}author A <a@x> 1 +0000\ncommitter A <a@x> 2 +0000\nencoding UTF-8\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n abc\n -----END PGP SIGNATURE-----\n\nSigned\n"
        );
        let c = parse(data.as_bytes()).unwrap();
        assert!(c.parents.is_empty());
        assert_eq!(c.message, b"Signed\n");
    }

    #[test]
    fn a_commit_without_a_message_has_an_empty_one() {
        let data = format!("{TREE}author A <a@x> 1 +0000\ncommitter A <a@x> 2 +0000\n");
        assert_eq!(parse(data.as_bytes()).unwrap().message, b"");
    }

    #[test]
    fn identities_keep_leading_space_and_lose_trailing_space() {
        let i = ident(b" Ada  <> 5 +0000").unwrap();
        assert_eq!(i.name, b" Ada");
        assert_eq!(i.email, b"");
        assert_eq!(ident(b"<a@x> 5 +0000").unwrap().name, b"");
    }

    #[test]
    fn unusual_commits_are_unsupported() {
        let unsupported = |data: &[u8]| matches!(parse(data), Err(Error::Unsupported(_)));
        // Not in the form git writes
        assert!(unsupported(format!("{TREE}author A <a@x> -5 +0000\ncommitter A <a@x> 2 +0000\n\nm").as_bytes()));
        assert!(unsupported(format!("{TREE}author A <a@x> 5\ncommitter A <a@x> 2 +0000\n\nm").as_bytes()));
        assert!(unsupported(format!("{TREE}author A <a@x> 5 +000\ncommitter A <a@x> 2 +0000\n\nm").as_bytes()));
        assert!(unsupported(format!("{TREE}author A <a@x> 9999999999999999 +0000\ncommitter A <a@x> 2 +0000\n\nm").as_bytes()));
        assert!(unsupported(format!("{TREE}author A <<a@x>> 5 +0000\ncommitter A <a@x> 2 +0000\n\nm").as_bytes()));
        assert!(unsupported(format!("{TREE}author A a@x 5 +0000\ncommitter A <a@x> 2 +0000\n\nm").as_bytes()));
        // Headers out of order, missing or repeated
        assert!(unsupported(format!("{TREE}committer A <a@x> 2 +0000\nauthor A <a@x> 5 +0000\n\nm").as_bytes()));
        assert!(unsupported(b"author A <a@x> 5 +0000\ncommitter A <a@x> 2 +0000\n\nm"));
        assert!(unsupported(format!("{TREE}author A <a@x> 5 +0000\ncommitter A <a@x> 2 +0000\nencoding ISO-8859-1\n\nm").as_bytes()));
        assert!(unsupported(&commit(&format!("parent {P1}\nparent {P1}\n"), "m")));
        assert!(unsupported(format!("{TREE}author A <a@x> 5 +0000\ncommitter A <a@x> 2 +0000\nauthor B <b@x> 5 +0000\n\nm").as_bytes()));
        assert!(unsupported(format!("{TREE}author A <a@x> 5 +0000\ncommitter A <a@x> 2 +0000").as_bytes()));
        assert!(unsupported(&commit("parent ABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD\n", "m")));
        // A NUL byte
        assert!(unsupported(&commit("", "a\0b")));
    }

    #[test]
    fn utf8_encoding_headers_are_accepted() {
        for name in ["utf-8", "UTF-8", "utf8", "Utf8"] {
            let data = format!("{TREE}author A <a@x> 1 +0000\ncommitter A <a@x> 2 +0000\nencoding {name}\n\nm");
            assert!(parse(data.as_bytes()).is_ok(), "{name}");
        }
    }

    #[test]
    fn subjects_match_git() {
        assert_eq!(subject(b"Subject\n\nBody\n"), b"Subject");
        assert_eq!(subject(b"Subject"), b"Subject");
        assert_eq!(subject(b"\n  \n\nSubject  \n"), b"Subject");
        assert_eq!(subject(b"Line one\nline two\t\r\n\nBody"), b"Line one line two");
        assert_eq!(subject(b"Windows\r\n\r\nBody"), b"Windows");
        assert_eq!(subject(b"Lone\rCR inside\n"), b"Lone\rCR inside");
        assert_eq!(subject(b"  Leading space kept\n"), b"  Leading space kept");
        assert_eq!(subject(b""), b"");
        assert_eq!(subject(b"\n\n"), b"");
    }
}
