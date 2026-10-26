//! Reading reflog files (`logs/HEAD`, `logs/refs/...`).

use std::path::Path;

use gix::ObjectId;

use crate::error::{unsupported, Error, Result};

/// One line of a reflog: the ref moved from `old` to `new`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Entry {
    pub old: ObjectId,
    pub new: ObjectId,
}

/// The entries of a reflog file, oldest first, or `None` when the file doesn't exist.
///
/// Git skips a line it can't parse, which shifts the `@{n}` numbers of the lines after it. The engine
/// returns `Unsupported` for such a file instead.
pub(crate) fn read(path: &Path) -> Result<Option<Vec<Entry>>> {
    let data = match std::fs::read(path) {
        Ok(data) => data,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(Error::failed(format!("Unable to read the reflog {}: {e}", path.display()))),
    };
    if !data.is_empty() && !data.ends_with(b"\n") {
        unsupported!("the reflog {} doesn't end with a newline", path.display());
    }
    let mut entries = Vec::new();
    for line in data.split(|&b| b == b'\n').filter(|line| !line.is_empty()) {
        match parse_line(line) {
            Some(entry) => entries.push(entry),
            None => unsupported!("the reflog {} has a line git would skip", path.display()),
        }
    }
    Ok(Some(entries))
}

/// Parse `<old> <new> Name <email> 1700000000 +0000\tmessage`, with the checks of git's
/// `show_one_reflog_ent`.
fn parse_line(line: &[u8]) -> Option<Entry> {
    let hex = |bytes: &[u8]| -> Option<ObjectId> {
        if bytes.len() == 40 && bytes.iter().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
            ObjectId::from_hex(bytes).ok()
        } else {
            None
        }
    };
    let old = hex(line.get(..40)?)?;
    if line.get(40) != Some(&b' ') {
        return None;
    }
    let new = hex(line.get(41..81)?)?;
    if line.get(81) != Some(&b' ') {
        return None;
    }
    let ident = &line[82..];
    let lt = ident.iter().position(|&b| b == b'<')?;
    let gt = ident.iter().position(|&b| b == b'>')?;
    if gt < lt || ident.get(gt + 1) != Some(&b' ') {
        return None;
    }
    let date = &ident[gt + 2..];
    let digits = date.iter().take_while(|b| b.is_ascii_digit()).count();
    // Git treats a zero timestamp as a line it can't parse
    if digits == 0 || digits > 15 || date[..digits].iter().all(|&b| b == b'0') {
        return None;
    }
    let zone = &date[digits..];
    if zone.len() < 6 || zone[0] != b' ' || !matches!(zone[1], b'+' | b'-') || !zone[2..6].iter().all(u8::is_ascii_digit) {
        return None;
    }
    if zone.len() > 6 && zone[6] != b'\t' {
        return None;
    }
    Some(Entry { old, new })
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "1111111111111111111111111111111111111111";
    const B: &str = "2222222222222222222222222222222222222222";

    #[test]
    fn parses_lines_git_writes() {
        let entry = parse_line(format!("{A} {B} Ada Park <ada@x> 1700000000 +0100\tcommit: Add\n").trim_end().as_bytes()).unwrap();
        assert_eq!((entry.old.to_string(), entry.new.to_string()), (A.to_owned(), B.to_owned()));
        assert!(parse_line(format!("{A} {B} Ada <ada@x> 1700000000 -0500").as_bytes()).is_some());
    }

    #[test]
    fn refuses_lines_git_skips() {
        for line in [
            format!("{A} {B} Ada <ada@x> 0 +0000\tm"),
            format!("{A} {B} Ada <ada@x>  1 +0000\tm"),
            format!("{A} {B} Ada <ada@x> 1 0000\tm"),
            format!("{A} {B} Ada <ada@x> 1 +0000 m"),
            format!("{A} {B} Ada ada@x 1 +0000\tm"),
            format!("{A}{B} Ada <ada@x> 1 +0000\tm"),
            format!("{} {B} Ada <ada@x> 1 +0000\tm", &A[1..]),
        ] {
            assert!(parse_line(line.as_bytes()).is_none(), "{line}");
        }
    }
}
