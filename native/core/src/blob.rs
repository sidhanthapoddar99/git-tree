//! A file's contents at a commit, as `git show <commit>:<path>` prints them.
//!
//! For a blob, `git show` prints its bytes as they are, without filters or text conversion. The
//! engine finds the blob in the commit's tree, and answers with its bytes in base64, so they cross
//! to JavaScript unchanged.

use crate::commit;
use crate::error::{unsupported, Result};
use crate::repo::{full_id, Repo};
use crate::tree;

/// The largest file the engine reads. A larger one would make an answer of several hundred MB.
const MAX_SIZE: u64 = 64 * 1024 * 1024;

/// The contents of `path` in the commit `hash`, in base64.
pub fn commit_file(repo: &Repo, hash: &str, path: &str) -> Result<String> {
    // git reads a path that starts with ./ or ../ from the current folder, and gives others meaning too
    let plain = !path.is_empty() && path.split('/').all(|part| !part.is_empty() && part != "." && part != "..");
    if !plain {
        unsupported!("{path:?} isn't a plain path from the repository's root");
    }
    let data = repo.commit_data(full_id(hash)?)?;
    let root = commit::parse(&data)?.tree;
    let Some((mode, id)) = repo.tree_entry(root, path.as_bytes())? else {
        unsupported!("{path} isn't in the commit");
    };
    if mode == tree::TREE || mode == tree::GITLINK {
        // git show lists a folder, and fails on a submodule
        unsupported!("{path} isn't a file");
    }
    let (_, size) = repo.object_header(id)?;
    if size > MAX_SIZE {
        unsupported!("{path} is larger than the engine reads");
    }
    Ok(base64(&repo.object(id, gix::object::Kind::Blob)?))
}

/// Standard base64, with padding.
fn base64(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut text = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let bytes = [chunk[0], chunk.get(1).copied().unwrap_or(0), chunk.get(2).copied().unwrap_or(0)];
        let bits = (u32::from(bytes[0]) << 16) | (u32::from(bytes[1]) << 8) | u32::from(bytes[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                text.push(ALPHABET[(bits >> (18 - 6 * i) & 0x3f) as usize] as char);
            } else {
                text.push('=');
            }
        }
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_the_standard() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(&[0, 255, 128]), "AP+A");
    }
}
