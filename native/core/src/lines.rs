//! The added and deleted line counts that `git diff --numstat` prints for a text file.
//!
//! Git counts the lines its Myers diff (xdiff) marks as changed. Before the diff, xdiff trims the
//! lines both files start and end with, sets aside the lines the other file doesn't have, and also
//! sets aside some lines that the other file has many times, when they sit among lines it doesn't
//! have. Then it diffs the lines that are left. The engine makes the same choices, with the same
//! limits, so it counts the same lines.
//!
//! The diff itself is minimal for most files, but xdiff takes shortcuts once a part of it costs 256
//! or more steps (`XDL_HEUR_MIN_COST` and `XDL_MAX_COST_MIN`), and its result then depends on how
//! those shortcuts cut the files. The engine doesn't reproduce them: it counts a file only when the
//! lines left differ by at most [`MAX_EDITS`] lines, which keeps every step count below 256, and
//! says it can't count the file otherwise.

use std::collections::HashMap;

/// The most lines, added plus deleted, that the engine's minimal diff accepts after the lines are
/// set aside. Xdiff finds the middle of an edit of `d` lines after `d / 2` steps, rounded up, so
/// below 512 lines it never reaches its shortcuts; the margin keeps clear of the boundary.
pub(crate) const MAX_EDITS: usize = 500;

/// Xdiff's `XDL_MAX_EQLIMIT`: the most times a line may appear before it always counts as frequent.
const MAX_FREQUENT: usize = 1024;
/// Xdiff's `XDL_SIMSCAN_WINDOW`: how far to look around a frequent line.
const SCAN_WINDOW: usize = 100;
/// Xdiff's `XDL_KPDIS_RUN`: frequent lines are set aside when they are at most a quarter of their run.
const KEEP_RUN_FACTOR: usize = 4;

/// What xdiff does with a line before the diff.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Action {
    /// The other file doesn't have the line, so it is changed.
    SetAside,
    /// The other file has the line a few times, so the diff decides.
    Keep,
    /// The other file has the line many times: it is set aside if it sits among lines set aside.
    Investigate,
}

/// The lines added and deleted between two texts, as `(added, deleted)`, or `None` when the diff is
/// too large for the engine to count the way git does.
pub(crate) fn count(old: &[u8], new: &[u8]) -> Option<(usize, usize)> {
    // Each line keeps its newline, so a last line without one differs from the same line with one
    let old_lines = split_lines(old);
    let new_lines = split_lines(new);

    // Number the distinct lines, and count how often each appears in each file
    let mut classes: HashMap<&[u8], u32> = HashMap::new();
    let mut counts: Vec<(usize, usize)> = Vec::new();
    let a: Vec<u32> = old_lines.iter().map(|line| classify(&mut classes, &mut counts, line, true)).collect();
    let b: Vec<u32> = new_lines.iter().map(|line| classify(&mut classes, &mut counts, line, false)).collect();

    // Trim the lines both files start with, then the lines both end with (xdl_trim_ends)
    let limit = a.len().min(b.len());
    let prefix = (0..limit).take_while(|&i| a[i] == b[i]).count();
    let suffix = (0..limit - prefix).take_while(|&i| a[a.len() - 1 - i] == b[b.len() - 1 - i]).count();
    let a_middle = &a[prefix..a.len() - suffix];
    let b_middle = &b[prefix..b.len() - suffix];

    // Set lines aside (xdl_cleanup_records). The limits come from the whole files' line counts.
    let a_kept = kept_lines(a_middle, frequent_limit(a.len()), |class| counts[class as usize].1);
    let b_kept = kept_lines(b_middle, frequent_limit(b.len()), |class| counts[class as usize].0);

    let edits = edit_distance(&a_kept, &b_kept, MAX_EDITS)?;
    let common = (a_kept.len() + b_kept.len() - edits) / 2;
    Some((b_middle.len() - common, a_middle.len() - common))
}

/// The number of a line's class, counting it in the old file (`first`) or the new one.
fn classify<'t>(classes: &mut HashMap<&'t [u8], u32>, counts: &mut Vec<(usize, usize)>, line: &'t [u8], first: bool) -> u32 {
    let next = classes.len() as u32;
    let class = *classes.entry(line).or_insert(next);
    if class == next {
        counts.push((0, 0));
    }
    if first {
        counts[class as usize].0 += 1;
    } else {
        counts[class as usize].1 += 1;
    }
    class
}

/// Split a text into lines, each with its newline. A last line without one is a line too.
fn split_lines(text: &[u8]) -> Vec<&[u8]> {
    text.split_inclusive(|&b| b == b'\n').collect()
}

/// How many times a line must appear in the other file to count as frequent: xdiff's `xdl_bogosqrt`
/// of this file's line count, at most [`MAX_FREQUENT`].
fn frequent_limit(lines: usize) -> usize {
    let mut n = lines;
    let mut root = 1;
    while n > 0 {
        root <<= 1;
        n >>= 2;
    }
    root.min(MAX_FREQUENT)
}

/// The lines the diff compares, after xdiff sets lines aside. `in_other` is how often a line
/// appears in the other file.
fn kept_lines(lines: &[u32], limit: usize, in_other: impl Fn(u32) -> usize) -> Vec<u32> {
    let actions: Vec<Action> = lines
        .iter()
        .map(|&class| match in_other(class) {
            0 => Action::SetAside,
            n if n < limit => Action::Keep,
            _ => Action::Investigate,
        })
        .collect();
    let mut kept = Vec::with_capacity(lines.len());
    for (i, &class) in lines.iter().enumerate() {
        let keep = match actions[i] {
            Action::Keep => true,
            Action::SetAside => false,
            Action::Investigate => !among_set_aside(&actions, i),
        };
        if keep {
            kept.push(class);
        }
    }
    kept
}

/// Does the frequent line `i` sit among lines set aside, as xdiff's `xdl_clean_mmatch` decides? It
/// looks at the run of set-aside and frequent lines on each side, at most [`SCAN_WINDOW`] lines
/// away. Each side needs a line set aside, and the frequent lines must be few in the two runs.
fn among_set_aside(actions: &[Action], i: usize) -> bool {
    let start = i.saturating_sub(SCAN_WINDOW);
    let end = (i + SCAN_WINDOW).min(actions.len() - 1);

    // The run before the line, then the run after it. The line itself counts once on each side.
    let run = |range: &mut dyn Iterator<Item = usize>| {
        let (mut set_aside, mut frequent) = (0, 1);
        for j in range {
            match actions[j] {
                Action::SetAside => set_aside += 1,
                Action::Investigate => frequent += 1,
                Action::Keep => break,
            }
        }
        (set_aside, frequent)
    };
    let (set_aside_before, frequent_before) = run(&mut (start..i).rev());
    if set_aside_before == 0 {
        return false;
    }
    let (set_aside_after, frequent_after) = run(&mut (i + 1..=end));
    if set_aside_after == 0 {
        return false;
    }
    let set_aside = set_aside_before + set_aside_after;
    let frequent = frequent_before + frequent_after;
    frequent * KEEP_RUN_FACTOR < frequent + set_aside
}

/// The fewest lines to add and delete to turn `a` into `b` (Myers' greedy algorithm), or `None`
/// when it is more than `max`.
fn edit_distance(a: &[u32], b: &[u32], max: usize) -> Option<usize> {
    let (n, m) = (a.len() as i64, b.len() as i64);
    let max = max.min(a.len() + b.len()) as i64;
    // The furthest point reached on each diagonal k = x - y, or -1 when no path reaches it
    let offset = max + 1;
    let mut furthest = vec![-1i64; (2 * max + 3) as usize];
    let slide = |mut x: i64, k: i64| {
        while x < n && x - k < m && a[x as usize] == b[(x - k) as usize] {
            x += 1;
        }
        x
    };

    furthest[offset as usize] = slide(0, 0);
    if furthest[offset as usize] == n && n == m {
        return Some(0);
    }
    for d in 1..=max {
        for k in (-d..=d).step_by(2) {
            let index = (k + offset) as usize;
            // From the diagonal above (a line added) or below (a line deleted), whichever reaches further
            let added = furthest[index + 1];
            let deleted = if furthest[index - 1] >= 0 { furthest[index - 1] + 1 } else { -1 };
            let x = added.max(deleted);
            if x < 0 || x > n || x - k > m || x - k < 0 {
                furthest[index] = -1;
                continue;
            }
            let x = slide(x, k);
            furthest[index] = x;
            if x == n && x - k == m {
                return Some(d as usize);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_simple_changes() {
        assert_eq!(count(b"", b""), Some((0, 0)));
        assert_eq!(count(b"", b"a\nb\n"), Some((2, 0)));
        assert_eq!(count(b"a\nb\n", b""), Some((0, 2)));
        assert_eq!(count(b"a\nb\nc\n", b"a\nx\nc\n"), Some((1, 1)));
        assert_eq!(count(b"a\nb\nc\n", b"a\nc\n"), Some((0, 1)));
        assert_eq!(count(b"a\nc\n", b"a\nb\nc\nd\n"), Some((2, 0)));
    }

    #[test]
    fn a_missing_newline_changes_the_last_line() {
        assert_eq!(count(b"a\nb", b"a\nb\n"), Some((1, 1)));
        assert_eq!(count(b"a", b"a"), Some((0, 0)));
        assert_eq!(count(b"a\r\n", b"a\n"), Some((1, 1)));
    }

    #[test]
    fn frequent_limits_match_xdiff() {
        assert_eq!(frequent_limit(0), 1);
        assert_eq!(frequent_limit(1), 2);
        assert_eq!(frequent_limit(10), 4);
        assert_eq!(frequent_limit(100), 16);
        assert_eq!(frequent_limit(10_000_000), MAX_FREQUENT);
    }

    #[test]
    fn edit_distances_are_minimal() {
        assert_eq!(edit_distance(&[1, 2, 3], &[1, 2, 3], 10), Some(0));
        assert_eq!(edit_distance(&[1, 2, 3], &[3, 2, 1], 10), Some(4));
        assert_eq!(edit_distance(&[], &[1, 2], 10), Some(2));
        assert_eq!(edit_distance(&[1, 2], &[], 10), Some(2));
        assert_eq!(edit_distance(&[1, 2, 3, 4], &[5, 6, 7, 8], 7), None);
        assert_eq!(edit_distance(&[1, 2, 3, 4], &[5, 6, 7, 8], 8), Some(8));
    }

    #[test]
    fn large_diffs_are_not_counted() {
        let old: Vec<u8> = (0..400).flat_map(|i| format!("old {i}\n").into_bytes()).collect();
        let new: Vec<u8> = (0..400).flat_map(|i| format!("new {i}\n").into_bytes()).collect();
        // Every line is set aside, so nothing is left to diff
        assert_eq!(count(&old, &new), Some((400, 400)));
        let shuffled: Vec<u8> = (0..400).rev().flat_map(|i| format!("old {i}\n").into_bytes()).collect();
        assert_eq!(count(&old, &shuffled), None);
    }
}
