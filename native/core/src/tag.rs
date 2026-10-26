//! An annotated tag's details, as the extension's `git for-each-ref refs/tags/<name>
//! --format=%(objectname)...%(contents)` prints them.
//!
//! Git finds a signature at the end of a tag's message by its `-----BEGIN` line, and which kinds it
//! knows depends on its version, so a tag with such a line is `Unsupported`. A lightweight tag, a tag
//! without a tagger and a tag with headers git doesn't write are `Unsupported` too.

use gix::bstr::ByteSlice;
use gix::refs::TargetRef;

use crate::commit::ident_time;
use crate::error::{unsupported, Result};
use crate::refs::is_plain_ref_name;
use crate::repo::{ref_name, utf8, Repo};

/// The fields of the extension's `for-each-ref` format, as git prints them.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagRecord {
    /// `%(objectname)`: the tag object's ID.
    pub hash: String,
    /// `%(taggername)`.
    pub tagger_name: String,
    /// `%(taggeremail)`, with its `<>`.
    pub tagger_email: String,
    /// `%(taggerdate:unix)`.
    pub tagger_date: String,
    /// `%(contents:signature)`.
    pub signature: String,
    /// `%(contents)`, followed by the newline that ends git's output.
    pub contents: String,
}

/// The details of the tag `refs/tags/<name>`.
pub fn tag_details(repo: &Repo, name: &str) -> Result<TagRecord> {
    // for-each-ref reads its argument as a pattern, which also matches the refs below it
    if !is_plain_ref_name(name) {
        unsupported!("{name:?} isn't a plain tag name");
    }
    let full_name = format!("refs/tags/{name}");
    if repo.has_refs(&format!("{full_name}/"))? {
        unsupported!("there are refs below {full_name}");
    }
    let Some(reference) = repo.find_ref(full_name.as_bytes().as_bstr())? else {
        unsupported!("the tag {name} doesn't exist");
    };
    ref_name(reference.name().as_bstr())?;
    let id = match reference.target() {
        TargetRef::Object(id) => id.to_owned(),
        TargetRef::Symbolic(_) => unsupported!("the tag {name} is a symbolic ref"),
    };
    let (kind, _) = repo.object_header(id)?;
    if kind != gix::object::Kind::Tag {
        unsupported!("the tag {name} is a lightweight tag");
    }
    let data = repo.object(id, gix::object::Kind::Tag)?;
    let mut record = parse(&data)?;
    record.hash = id.to_string();
    Ok(record)
}

/// Parse a tag object as git's `ref-filter.c` reads it, leaving out the hash.
fn parse(data: &[u8]) -> Result<TagRecord> {
    if data.contains(&0) {
        unsupported!("the tag contains a NUL byte");
    }
    if data.find(b"-----BEGIN").is_some() {
        unsupported!("the tag may be signed");
    }

    // The headers git writes, in its order, each ending with a newline
    let mut rest = data;
    let mut tagger = None;
    for header in [&b"object "[..], b"type ", b"tag ", b"tagger "] {
        let Some(end) = rest.find_byte(b'\n') else {
            unsupported!("a tag header doesn't end with a newline");
        };
        let Some(value) = rest[..end].strip_prefix(header) else {
            unsupported!("the tag doesn't have the headers git writes");
        };
        if header == b"tagger " {
            tagger = Some(value);
        }
        rest = &rest[end + 1..];
    }
    // Then the end of the object, or the blank line before the message
    let message = match rest.strip_prefix(b"\n") {
        Some(message) => message,
        None if rest.is_empty() => rest,
        None => unsupported!("the tag has more headers than git writes"),
    };

    // ref-filter's copy_name, copy_email and grab_date, for a line with one well-formed identity
    let tagger = tagger.expect("the tagger header");
    let count = |c: u8| tagger.iter().filter(|&&b| b == c).count();
    let (Some(lt), Some(gt)) = (tagger.find_byte(b'<'), tagger.find_byte(b'>')) else {
        unsupported!("the tagger has no <email>");
    };
    if count(b'<') != 1 || count(b'>') != 1 || gt < lt || lt == 0 || tagger[lt - 1] != b' ' {
        unsupported!("the tagger isn't an identity git writes");
    }
    let Some(date) = ident_time(&tagger[gt + 1..]) else {
        unsupported!("the tagger has a malformed date");
    };

    // %(contents) starts after the blank lines that follow the headers
    let contents = &message[message.iter().take_while(|&&b| b == b'\n').count()..];
    Ok(TagRecord {
        hash: String::new(),
        tagger_name: utf8(&tagger[..lt - 1], "a tagger name")?,
        tagger_email: utf8(&tagger[lt..=gt], "a tagger email")?,
        tagger_date: date.to_string(),
        signature: String::new(),
        contents: utf8(contents, "a tag message")? + "\n",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEADERS: &str = "object 1111111111111111111111111111111111111111\ntype commit\ntag v1\n";

    fn tag(tagger: &str, message: &str) -> Vec<u8> {
        format!("{HEADERS}tagger {tagger}\n{message}").into_bytes()
    }

    #[test]
    fn reads_the_fields_git_prints() {
        let record = parse(&tag("A U Thor <a@example.com> 1700000000 +0100", "\n\nSubject\n\nBody\n")).unwrap();
        assert_eq!(record.tagger_name, "A U Thor");
        assert_eq!(record.tagger_email, "<a@example.com>");
        assert_eq!(record.tagger_date, "1700000000");
        assert_eq!(record.contents, "Subject\n\nBody\n\n");
        // A tag without a message
        assert_eq!(parse(&tag("A <a> 1 +0000", "")).unwrap().contents, "\n");
        assert_eq!(parse(&tag("A <a> 1 +0000", "\n")).unwrap().contents, "\n");
    }

    #[test]
    fn unusual_tags_are_unsupported() {
        assert!(parse(&tag("A <a> 1 +0000", "\nm\n-----BEGIN PGP SIGNATURE-----\n")).is_err());
        assert!(parse(&tag("A<a> 1 +0000", "\nm\n")).is_err());
        assert!(parse(&tag("A <a> <b> 1 +0000", "\nm\n")).is_err());
        assert!(parse(&tag("A <a> x +0000", "\nm\n")).is_err());
        assert!(parse(&tag("A <a> 1 +0000", "extra header\n\nm\n")).is_err());
        assert!(parse(format!("{HEADERS}\nm\n").as_bytes()).is_err());
    }
}
