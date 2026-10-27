import * as path from 'path';
import { WorktreeListEntry } from '../engine';
import { GitWorktree } from '../types';
import { parseWorktreeList } from '../worktreeList';

/*
 * A host's status call: one script that `ssh <alias> sh -s -- <arguments>` runs on the server, and the parser of what
 * it prints. Only `git` and a POSIX shell run there, and the script only reads. The arguments are fixed values apart
 * from the path, which the config has checked and the caller quotes.
 */

/**
 * The status script. Its arguments:
 * 1. The path of the repository's main worktree.
 * 2. `--untracked-files` for `git status`: `all` or `no` (the `showUntrackedFiles` setting, as for local worktrees).
 * 3. `yes` to read the linked worktrees' status too, `no` for only the main worktree's.
 * 4. `yes` to print the root commits of the branches, for the same project check, `no` to skip that walk.
 *
 * It prints sections that each start with a `gt:` line, and ends with `gt:end`. Each status count is the number of
 * `git status --porcelain` lines, counted on the server (`-1` when the status couldn't be read), so a worktree with
 * 10,000 untracked files costs a number, not its file list.
 */
export const STATUS_SCRIPT = [
	'command -v git >/dev/null 2>&1 || { echo gt:nogit; exit 5; }',
	'cd "$1" 2>/dev/null || { echo gt:nopath; exit 3; }',
	'err=$(git rev-parse --git-dir 2>&1 >/dev/null) || { echo gt:norepo; printf \'%s\\n\' "$err"; exit 4; }',
	'echo gt:tips',
	'git for-each-ref --format=\'%(objectname) %(refname)\' refs/heads || exit 6',
	'if [ "$4" = yes ]; then echo gt:roots; git rev-list --max-parents=0 --branches || exit 6; fi',
	'list=$(git worktree list --porcelain) || exit 6',
	'echo gt:worktrees',
	'printf \'%s\\n\' "$list"',
	'echo gt:status',
	'printf \'%s\\n\' "$list" | sed -n \'s/^worktree //p\' | {',
	'  i=0',
	'  while IFS= read -r wt; do',
	'    i=$((i + 1))',
	'    if [ "$3" = yes ] || [ "$i" -eq 1 ]; then',
	'      n=$({ git --no-optional-locks -C "$wt" status --untracked-files="$2" --porcelain 2>/dev/null || echo gt:fail; } | awk \'$0 == "gt:fail" { f = 1 } END { print f ? -1 : NR }\')',
	'      printf \'%s %s\\n\' "$n" "$wt"',
	'    fi',
	'  done',
	'}',
	'echo gt:end',
	''
].join('\n');

/**
 * Get the arguments of the status script, each quoted for the server's shell.
 * @param repoPath The path of the repository's main worktree on the server.
 * @param showUntrackedFiles Count untracked files (the `showUntrackedFiles` setting).
 * @param linkedWorktrees Read the linked worktrees' status too.
 * @param roots Print the root commits.
 * @returns The arguments after `sh -s --`.
 */
export function getStatusScriptArgs(repoPath: string, showUntrackedFiles: boolean, linkedWorktrees: boolean, roots: boolean) {
	return [repoPath, showUntrackedFiles ? 'all' : 'no', linkedWorktrees ? 'yes' : 'no', roots ? 'yes' : 'no'];
}

/** A branch on the server. */
export interface BranchTip {
	readonly ref: string; // `refs/heads/<branch>`
	readonly hash: string;
}

/**
 * What the status script printed:
 * - `ok`: the branch tips, the root commits (NULL when not asked for), the worktree records, and each worktree's status count by path.
 * - `noGit`: Git isn't installed on the server, or isn't on its PATH.
 * - `noPath`: the path doesn't exist on the server.
 * - `notARepository`: the path isn't a Git repository, with Git's message.
 * - `unreadable`: the output isn't what the script prints (it was cut short, or something else printed it).
 */
export type StatusOutput =
	{ readonly kind: 'ok', readonly tips: ReadonlyArray<BranchTip>, readonly roots: ReadonlyArray<string> | null, readonly worktrees: ReadonlyArray<WorktreeListEntry>, readonly counts: ReadonlyMap<string, number | null> }
	| { readonly kind: 'noGit' }
	| { readonly kind: 'noPath' }
	| { readonly kind: 'notARepository', readonly message: string }
	| { readonly kind: 'unreadable' };

const HASH_REGEX = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const SECTIONS = ['gt:tips', 'gt:roots', 'gt:worktrees', 'gt:status', 'gt:end'];

/**
 * Parse the output of the status script. Lines before its first section are ignored, since a login shell's startup
 * files may print something.
 * @param stdout The output.
 * @returns What it printed.
 */
export function parseStatusOutput(stdout: string): StatusOutput {
	const lines = stdout.split('\n');
	let start = 0;
	while (start < lines.length && !lines[start].startsWith('gt:')) start++;
	if (start === lines.length) return { kind: 'unreadable' };

	const first = lines[start];
	if (first === 'gt:nogit') return { kind: 'noGit' };
	if (first === 'gt:nopath') return { kind: 'noPath' };
	if (first === 'gt:norepo') return { kind: 'notARepository', message: lines.slice(start + 1).map((line) => line.trim()).filter((line) => line !== '').join(' ') };

	// Split the output at the section lines, which must come in order, each once (gt:roots only when asked for)
	const sections: { [name: string]: string[] } = {};
	let current: string | null = null, next = 0;
	for (let i = start; i < lines.length; i++) {
		const index = SECTIONS.indexOf(lines[i], next);
		if (index > -1 && (current !== 'gt:worktrees' || lines[i] === 'gt:status')) {
			current = lines[i];
			sections[current] = [];
			next = index + 1;
		} else if (current !== null) {
			sections[current].push(lines[i]);
		}
	}
	if (current !== 'gt:end' || typeof sections['gt:tips'] === 'undefined' || typeof sections['gt:worktrees'] === 'undefined' || typeof sections['gt:status'] === 'undefined') {
		return { kind: 'unreadable' };
	}

	const tips: BranchTip[] = [];
	for (const line of sections['gt:tips']) {
		if (line === '') continue;
		const space = line.indexOf(' ');
		const hash = line.substring(0, space), ref = line.substring(space + 1);
		if (space === -1 || !HASH_REGEX.test(hash) || !ref.startsWith('refs/heads/')) return { kind: 'unreadable' };
		tips.push({ ref: ref, hash: hash });
	}

	let roots: string[] | null = null;
	if (typeof sections['gt:roots'] !== 'undefined') {
		roots = sections['gt:roots'].filter((line) => line !== '');
		if (roots.some((root) => !HASH_REGEX.test(root))) return { kind: 'unreadable' };
	}

	const worktreeLines = sections['gt:worktrees'];
	while (worktreeLines.length > 0 && worktreeLines[worktreeLines.length - 1] === '') worktreeLines.pop();
	const worktrees = parseWorktreeList(worktreeLines.join('\n'));
	if (worktrees.length === 0 || worktrees[0].path === null) return { kind: 'unreadable' };

	const counts = new Map<string, number | null>();
	for (const line of sections['gt:status']) {
		if (line === '') continue;
		const match = line.match(/^(-1|\d+) (.+)$/);
		if (match === null) return { kind: 'unreadable' };
		counts.set(match[2], match[1] === '-1' ? null : parseInt(match[1], 10));
	}

	return { kind: 'ok', tips: tips, roots: roots, worktrees: worktrees, counts: counts };
}

/** A worktree on a server, read from its status. */
export interface ServerWorktree {
	readonly worktree: GitWorktree;
	readonly uncommittedChanges: number | null; // NULL => the status couldn't be read
}

/**
 * Get a host's worktrees from its status. The paths stay as the server wrote them (POSIX), unlike local worktrees,
 * whose paths are normalised for this machine.
 * @param host The host's name.
 * @param entries The worktree records, with the main worktree first.
 * @param counts The status counts, by path.
 * @param linkedWorktrees Include the linked worktrees.
 * @returns The worktrees, with the main worktree first. A bare main repository has no worktree, so it's left out.
 */
export function getServerWorktrees(host: string, entries: ReadonlyArray<WorktreeListEntry>, counts: ReadonlyMap<string, number | null>, linkedWorktrees: boolean) {
	const worktrees: ServerWorktree[] = [];
	for (let i = 0; i < entries.length && (i === 0 || linkedWorktrees); i++) {
		const entry = entries[i];
		if (entry.path === null || entry.bare) continue;
		const count = counts.get(entry.path);
		worktrees.push({
			worktree: {
				path: entry.path,
				name: path.posix.basename(entry.path),
				head: entry.head === null || /^0+$/.test(entry.head) ? null : entry.head,
				branch: entry.branch === null ? null : entry.branch.replace(/^refs\/heads\//, ''),
				isMain: i === 0,
				isCurrent: false,
				locked: entry.locked,
				prunable: entry.prunable,
				host: host
			},
			uncommittedChanges: typeof count === 'number' ? count : null
		});
	}
	return worktrees;
}
