import * as fs from 'fs';
import * as path from 'path';
import { WorktreeListEntry } from './engine';
import type { RemoteHosts } from './remoteHosts';
import { ProcessResult, getErrorLines, runProcess } from './remoteHosts/ssh';
import { DiskSpace, ErrorInfo, ManagedHostGit, ManagedHostSizes, ManagedSize, ManagedWorktree, ResponseLoadWorktreeStats, WorktreeMainRelation } from './types';
import { getWorktreeFromEntry, parseWorktreeList } from './worktreeList';

/*
 * The Manage panel's data: each host's worktrees, how each relates to the main branch, their sizes on disk, and the
 * Fast-forward action. This machine runs Git, du and df directly. A remote host runs one fixed script per step over
 * SSH (RemoteHosts.runScript): one for its Git, then one for its sizes, so the Git shows while the sizes are measured.
 *
 * Linked worktrees often live inside the main worktree (`.worktrees/<name>`), and the Git folder always does. Each
 * folder is measured with a single `du -k -d <depth>` call, which prints the total of every folder down to that depth,
 * and each row's own size is its total minus the totals of the rows inside it. This doesn't depend on how du counts a
 * folder that it sees twice, which GNU, BusyBox and BSD (macOS) du each do differently.
 */

/** How long reading a host's Git may take, in milliseconds. */
const GIT_TIMEOUT = 60000;

/** How long measuring a host's sizes may take, in milliseconds. A large node_modules takes a while. */
const SIZES_TIMEOUT = 600000;

/** How long a Fast-forward may take, in milliseconds. */
const FAST_FORWARD_TIMEOUT = 300000;

const REMOTE_HOSTS_UNAVAILABLE = 'Remote hosts aren\'t available.';
const ORIGIN_HEAD = 'refs/remotes/origin/HEAD';
const ORIGIN_PREFIX = 'refs/remotes/origin/';
const HEADS_PREFIX = 'refs/heads/';

/** What WorktreeStats uses of DataSource: its Git, and the remote hosts. */
export interface WorktreeStatsSource {
	readonly runGit: (args: ReadonlyArray<string>, cwd: string, timeout: number) => Promise<ProcessResult | null>;
	readonly getGitExecutableError: () => string | null;
	readonly remoteHosts: Pick<RemoteHosts, 'runScript'> | null;
}

/** One part of a host's answer, as the view's response carries it. */
export type WorktreeStatsAnswer = Pick<ResponseLoadWorktreeStats, 'part' | 'git' | 'sizes' | 'error'>;

/** The commits only a worktree has (`ahead`), and the commits only the main branch has (`behind`). */
export interface AheadBehind {
	readonly ahead: number;
	readonly behind: number;
}

/** What Git says of one worktree. */
export interface WorktreeFacts {
	readonly entry: WorktreeListEntry; // Its record in `git worktree list`, with a path, and not bare
	readonly isMain: boolean;
	readonly physicalPath: string | null; // Its path with symbolic links resolved. NULL => its folder is missing.
	readonly changes: number | null; // NULL => the status couldn't be read
	readonly counts: ReadonlyMap<string, AheadBehind>; // Against each main branch candidate that exists, by ref
}

/** What Git says of a host's repository. */
export interface RepoFacts {
	readonly commonDir: string; // The Git folder all worktrees share, with symbolic links resolved
	readonly originHead: string | null; // The ref that refs/remotes/origin/HEAD points to. NULL => it isn't set.
	readonly branches: ReadonlyArray<string>; // The main branch candidates that exist, as refs
	readonly worktrees: ReadonlyArray<WorktreeFacts>; // The main worktree first
}


/* The main branch, and the Fast-forward rules */

/**
 * Get the branches that could be the main branch, as refs: the local branch that origin/HEAD points to, then main, then master.
 * @param originHead The ref that refs/remotes/origin/HEAD points to, or NULL.
 */
export function getMainBranchCandidates(originHead: string | null) {
	const candidates: string[] = [];
	if (originHead !== null && originHead.startsWith(ORIGIN_PREFIX)) candidates.push(HEADS_PREFIX + originHead.substring(ORIGIN_PREFIX.length));
	[HEADS_PREFIX + 'main', HEADS_PREFIX + 'master'].forEach((ref) => {
		if (candidates.indexOf(ref) === -1) candidates.push(ref);
	});
	return candidates;
}

/**
 * Work out a repository's main branch: the local branch that origin/HEAD points to (origin/main gives main). When
 * origin/HEAD isn't set, main if it exists, otherwise master. When origin/HEAD names a branch with no local branch,
 * there's no main branch, rather than a guess.
 * @param originHead The ref that refs/remotes/origin/HEAD points to, or NULL.
 * @param branches The candidates that exist, as refs.
 * @returns The branch's name, or why there's none.
 */
export function resolveMainBranch(originHead: string | null, branches: ReadonlyArray<string>): { branch: string } | { error: string } {
	if (originHead !== null) {
		if (!originHead.startsWith(ORIGIN_PREFIX) || originHead.length === ORIGIN_PREFIX.length) {
			return { error: 'origin/HEAD points to ' + originHead + ', which isn\'t a branch of origin.' };
		}
		const name = originHead.substring(ORIGIN_PREFIX.length);
		return branches.indexOf(HEADS_PREFIX + name) > -1
			? { branch: name }
			: { error: 'origin/HEAD points to origin/' + name + ', but there\'s no local branch "' + name + '".' };
	}
	if (branches.indexOf(HEADS_PREFIX + 'main') > -1) return { branch: 'main' };
	if (branches.indexOf(HEADS_PREFIX + 'master') > -1) return { branch: 'master' };
	return { error: 'There\'s no main branch: origin/HEAD isn\'t set, and there\'s no local main or master branch.' };
}

/**
 * Get how a worktree relates to the main branch.
 * @param facts The worktree.
 * @param main The main branch, or why there's none.
 */
export function getMainRelation(facts: WorktreeFacts, main: { branch: string } | { error: string }): WorktreeMainRelation {
	if (facts.physicalPath === null || facts.entry.prunable) return { kind: 'unknown' };
	if (facts.entry.branch === null) return { kind: 'detached' };
	if ('error' in main) return { kind: 'unknown' };
	if (facts.entry.branch === HEADS_PREFIX + main.branch) return { kind: 'main' };
	const counts = facts.counts.get(HEADS_PREFIX + main.branch);
	return typeof counts !== 'undefined' ? { kind: 'compared', ahead: counts.ahead, behind: counts.behind } : { kind: 'unknown' };
}

/**
 * Check whether a worktree can be fast-forwarded to the main branch. All of these must hold: it's clean (no changes,
 * untracked files included), it's on a branch, that branch isn't main, it hasn't diverged (HEAD is an ancestor of
 * main, so it has no commits of its own), and main is ahead of it.
 * @param facts The worktree.
 * @param main The main branch, or why there's none.
 * @returns NULL => it can, otherwise why it can't, as a short phrase.
 */
export function getFastForwardRefusal(facts: WorktreeFacts, main: { branch: string } | { error: string }): string | null {
	if ('error' in main) return main.error;
	if (facts.physicalPath === null || facts.entry.prunable) return 'The worktree\'s folder is missing';
	if (facts.changes === null) return 'Git couldn\'t read the worktree\'s status';
	if (facts.changes > 0) return facts.changes + ' uncommitted change' + (facts.changes === 1 ? '' : 's');
	if (facts.entry.branch === null) return 'Detached HEAD: check out a branch first';
	if (facts.entry.branch === HEADS_PREFIX + main.branch) return 'This is the main branch';
	const counts = facts.counts.get(HEADS_PREFIX + main.branch);
	if (typeof counts === 'undefined') return 'Git couldn\'t compare it with ' + main.branch;
	if (counts.ahead > 0) return counts.behind > 0 ? 'Diverged from ' + main.branch : counts.ahead + ' commit' + (counts.ahead === 1 ? '' : 's') + ' ahead of ' + main.branch + ', so there\'s nothing to fast-forward';
	if (counts.behind === 0) return 'Already up to date';
	return null;
}

/**
 * Get what the Manage panel shows of a host's Git.
 * @param facts What Git says of the host's repository.
 * @param host The remote host's name, or NULL for this machine.
 */
export function getManagedHostGit(facts: RepoFacts, host: string | null): ManagedHostGit {
	const main = resolveMainBranch(facts.originHead, facts.branches);
	return {
		mainBranch: 'branch' in main ? main.branch : null,
		mainBranchError: 'error' in main ? main.error : null,
		worktrees: facts.worktrees.map((worktreeFacts): ManagedWorktree => {
			const entry = worktreeFacts.entry, worktreePath = entry.path!;
			const worktree = Object.assign(getWorktreeFromEntry(entry, worktreePath, path.posix.basename(worktreePath.replace(/\\/g, '/')), worktreeFacts.isMain), { prunable: entry.prunable || worktreeFacts.physicalPath === null });
			return {
				worktree: host !== null ? Object.assign(worktree, { host: host }) : worktree,
				changes: worktreeFacts.changes,
				relation: getMainRelation(worktreeFacts, main),
				fastForwardRefusal: getFastForwardRefusal(worktreeFacts, main)
			};
		})
	};
}


/* Sizes */

/** A folder to measure: a worktree, keyed by its path as Git lists it, or the Git folder, keyed by its own path. */
export interface SizeTarget {
	readonly key: string;
	readonly path: string; // With symbolic links resolved, so a folder inside another starts with its path
}

/** A du call: the folder, and how deep its output must go to print every target inside it. */
export interface SizeRead {
	readonly path: string;
	readonly depth: number;
}

/**
 * Get the folders to measure: each worktree whose folder exists, and the Git folder.
 * @param facts What Git says of the host's repository.
 */
export function getSizeTargets(facts: RepoFacts): SizeTarget[] {
	const targets: SizeTarget[] = [];
	facts.worktrees.forEach((worktree) => {
		if (worktree.physicalPath !== null) targets.push({ key: worktree.entry.path!, path: worktree.physicalPath });
	});
	targets.push({ key: facts.commonDir, path: facts.commonDir });
	return targets.filter((target, index) => targets.findIndex((other) => other.path === target.path) === index);
}

/**
 * Plan the du calls: one per target that isn't inside another target, deep enough to print the targets inside it.
 * @param targets The folders to measure.
 */
export function planSizeReads(targets: ReadonlyArray<SizeTarget>): SizeRead[] {
	return targets.filter((target) => !targets.some((other) => isInside(target.path, other.path))).map((top) => ({
		path: top.path,
		depth: targets.reduce((depth, target) => isInside(target.path, top.path) ? Math.max(depth, target.path.substring(trimSlashes(top.path).length + 1).split('/').length) : depth, 0)
	}));
}

/**
 * Get each target's own size: its total, less the totals of the targets directly inside it.
 * @param targets The folders that were measured.
 * @param totals The total of each folder du printed, by path.
 * @returns The own size of each target, by key. NULL => du didn't print the totals it needs.
 */
export function getOwnSizes(targets: ReadonlyArray<SizeTarget>, totals: ReadonlyMap<string, number>): Map<string, number | null> {
	const sizes = new Map<string, number | null>();
	targets.forEach((target) => {
		const total = totals.get(target.path);
		// The targets inside it that aren't inside another target inside it
		const inner = targets.filter((other) => isInside(other.path, target.path) && !targets.some((middle) => isInside(other.path, middle.path) && isInside(middle.path, target.path)));
		let size: number | null = typeof total === 'number' ? total : null;
		inner.forEach((other) => {
			const innerTotal = totals.get(other.path);
			size = size !== null && typeof innerTotal === 'number' ? size - innerTotal : null;
		});
		sizes.set(target.key, size !== null ? Math.max(size, 0) : null);
	});
	return sizes;
}

/**
 * Parse the output of `du -k`: a size in kilobytes, a tab, and a path, on each line.
 * @param stdout The output.
 * @returns The size of each folder, by path.
 */
export function parseDuOutput(stdout: string) {
	const totals = new Map<string, number>();
	stdout.split(/\r?\n/).forEach((line) => {
		const match = line.match(/^(\d+)\t(.+)$/);
		if (match !== null) totals.set(match[2], parseInt(match[1], 10));
	});
	return totals;
}

/**
 * Parse the output of `df -Pk <path>`: a header, then `<filesystem> <total> <used> <available> <capacity>% <mount point>`.
 * The filesystem's name and the mount point may hold spaces, so the numbers are found between them.
 * @param stdout The output.
 * @returns The disk's space in kilobytes, or NULL if no line could be read.
 */
export function parseDfOutput(stdout: string): DiskSpace | null {
	let space: DiskSpace | null = null;
	stdout.split(/\r?\n/).forEach((line) => {
		const match = line.match(/^(.*\S)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+%|-)\s+(\/.*)$/);
		if (match !== null) space = { total: parseInt(match[2], 10), used: parseInt(match[3], 10), free: parseInt(match[4], 10) };
	});
	return space;
}

/**
 * Get what the Manage panel shows of a host's disk.
 * @param facts What Git says of the host's repository.
 * @param targets The folders that were measured.
 * @param dfOutput The output of df, or NULL if it couldn't run.
 * @param totals What du printed.
 * @param partial du couldn't read some folders.
 */
export function getManagedHostSizes(facts: RepoFacts, targets: ReadonlyArray<SizeTarget>, dfOutput: string | null, totals: ReadonlyMap<string, number>, partial: boolean): ManagedHostSizes {
	const sizes = getOwnSizes(targets, totals);
	const getSize = (key: string): ManagedSize => {
		const size = sizes.get(key);
		return { path: key, size: typeof size === 'number' ? size : null };
	};
	return {
		disk: dfOutput !== null ? parseDfOutput(dfOutput) : null,
		worktrees: facts.worktrees.filter((worktree) => worktree.physicalPath !== null).map((worktree) => getSize(worktree.entry.path!)),
		gitData: getSize(facts.commonDir),
		warning: partial ? 'du couldn\'t read some folders, so some sizes may be too small.' : null
	};
}

/**
 * Is a path inside a folder (and not the folder itself)?
 * @param child The path.
 * @param parent The folder.
 */
function isInside(child: string, parent: string) {
	const prefix = trimSlashes(parent) + '/';
	return child.startsWith(prefix) && child.length > prefix.length;
}

/**
 * Remove a path's trailing slashes (`/` stays as '').
 * @param folder The path.
 */
function trimSlashes(folder: string) {
	return folder.replace(/\/+$/, '');
}


/* Scripts for a remote host */

/**
 * Read a host's Git: `sh -s -- <the repository's main worktree>`. It only reads. It prints sections that each start
 * with a `gt:` line, and ends with `gt:end`:
 * - `gt:commondir`: the Git folder, with symbolic links resolved.
 * - `gt:originhead`: the ref that origin/HEAD points to, or an empty line.
 * - `gt:branches`: the main branch candidates that exist (see getMainBranchCandidates).
 * - `gt:worktrees`: `git worktree list --porcelain`.
 * - `gt:wt <path>` for each worktree, then `p <physical path>`, `s <status lines, or -1>`, and `c <ref> <ahead> <behind>`
 *   for each candidate. A worktree whose folder is missing has only its `gt:wt` line.
 */
export const FACTS_SCRIPT = [
	'command -v git >/dev/null 2>&1 || { echo gt:nogit; exit 5; }',
	'cd "$1" 2>/dev/null || { echo gt:nopath; exit 3; }',
	'err=$(git rev-parse --git-dir 2>&1 >/dev/null) || { echo gt:norepo; printf \'%s\\n\' "$err"; exit 4; }',
	'list=$(git worktree list --porcelain) || exit 6',
	'echo gt:commondir',
	// Without the Git folder, Root's size would silently include it, so the read fails instead (exit 7 ends it before gt:end)
	'(cd "$(git rev-parse --git-common-dir)" && pwd -P) || exit 7',
	'echo gt:originhead',
	// symbolic-ref -q exits with 1 when origin/HEAD isn't set, and show-ref --verify -q when the branch doesn't exist. Any
	// other code means Git couldn't read them, which mustn't look like "there's no main branch".
	'oh=$(git symbolic-ref -q ' + ORIGIN_HEAD + ') || [ "$?" -eq 1 ] || exit 7',
	'printf \'%s\\n\' "$oh"',
	'echo gt:branches',
	'refs=',
	'case "$oh" in ' + ORIGIN_PREFIX + '?*) first="' + HEADS_PREFIX + '${oh#' + ORIGIN_PREFIX + '}";; *) first=;; esac',
	'for r in $first ' + HEADS_PREFIX + 'main ' + HEADS_PREFIX + 'master; do',
	'  case " $refs " in *" $r "*) continue;; esac',
	'  git show-ref --verify -q "$r"; rc=$?',
	'  if [ "$rc" -eq 0 ]; then refs="$refs $r"; printf \'%s\\n\' "$r"; elif [ "$rc" -ne 1 ]; then exit 7; fi',
	'done',
	'echo gt:worktrees',
	'printf \'%s\\n\' "$list"',
	'printf \'%s\\n\' "$list" | sed -n \'s/^worktree //p\' | while IFS= read -r wt; do',
	'  printf \'gt:wt %s\\n\' "$wt"',
	'  [ -d "$wt" ] || continue',
	'  printf \'p %s\\n\' "$(cd "$wt" && pwd -P)"',
	'  n=$({ git --no-optional-locks -C "$wt" status --porcelain --untracked-files=all 2>/dev/null || echo gt:fail; } | awk \'$0 == "gt:fail" { f = 1 } END { print f ? -1 : NR }\')',
	'  printf \'s %s\\n\' "$n"',
	'  git -C "$wt" symbolic-ref -q HEAD >/dev/null || continue',
	'  for r in $refs; do',
	'    c=$(git -C "$wt" rev-list --left-right --count "HEAD...$r" 2>/dev/null) && printf \'c %s %s\\n\' "$r" "$c"',
	'  done',
	'done',
	'echo gt:end',
	''
].join('\n');

/**
 * Measure a host's disk and folders: `sh -s -- <the repository's main worktree> <number of targets> <target> [...]
 * <depth> <folder> [<depth> <folder> ...]`. It prints `gt:df`, the output of df for the main worktree, `gt:du`, the
 * targets' lines of each du call (with a `gt:partial` line after one that failed), and `gt:end`.
 */
export const SIZES_SCRIPT = [
	'echo gt:df',
	'df -Pk -- "$1" 2>/dev/null',
	'echo gt:du',
	'shift',
	// The du calls run in a subshell that skips the targets. awk keeps only the targets' lines, so a deep du call sends a
	// few totals over SSH, not a line for every folder it walked.
	'(',
	'  shift "$(($1 + 1))"',
	'  while [ "$#" -ge 2 ]; do',
	'    du -k -d "$1" -- "$2" 2>/dev/null || echo gt:partial',
	'    shift 2',
	'  done',
	') | awk \'BEGIN { for (i = 2; i <= ARGV[1] + 1; i++) keep[ARGV[i]] = 1; ARGC = 1 } $0 == "gt:partial" { print; next } { p = $0; sub(/^[0-9]+\\t/, "", p); if (p in keep) print }\' "$@"',
	'echo gt:end',
	''
].join('\n');

/**
 * Fast-forward a worktree to the main branch: `sh -s -- <the repository's main worktree> <worktree> <branch> <main branch>`.
 * The extension has checked every rule just before, and the script checks again on the server, since the worktree could
 * change between the two calls. Its exit codes: 3 => a folder is missing, 10 => the path isn't a worktree of the
 * repository, 11 => another branch is checked out, 12 => it has changes, 13 => it has diverged from main. Otherwise
 * it's the exit code of `git merge --ff-only`.
 */
export const FAST_FORWARD_SCRIPT = [
	'cd "$1" || exit 3',
	'git worktree list --porcelain | grep -qxF "worktree $2" || exit 10',
	'cd "$2" || exit 3',
	'[ "$(git symbolic-ref -q HEAD)" = "' + HEADS_PREFIX + '$3" ] || exit 11',
	'[ -z "$(git status --porcelain --untracked-files=all)" ] || exit 12',
	'git merge-base --is-ancestor HEAD "' + HEADS_PREFIX + '$4" || exit 13',
	'exec git merge --ff-only "' + HEADS_PREFIX + '$4"',
	''
].join('\n');

/** The messages of FAST_FORWARD_SCRIPT's own exit codes. */
const FAST_FORWARD_EXIT_MESSAGES: { readonly [code: number]: string } = {
	3: 'The worktree\'s folder is missing',
	10: 'It isn\'t a worktree of the repository on the server',
	11: 'Another branch was checked out since Git Tree checked it',
	12: 'It has uncommitted changes',
	13: 'It has diverged from the main branch'
};

/**
 * What FACTS_SCRIPT printed:
 * - `ok`: the facts.
 * - `noGit`, `noPath`, `notARepository`: as the status script (see remoteHosts/status.ts).
 * - `unreadable`: the output isn't what the script prints.
 */
export type FactsOutput =
	{ readonly kind: 'ok', readonly facts: RepoFacts }
	| { readonly kind: 'noGit' }
	| { readonly kind: 'noPath' }
	| { readonly kind: 'notARepository', readonly message: string }
	| { readonly kind: 'unreadable' };

/**
 * Parse the output of FACTS_SCRIPT. Lines before its first section are ignored, since a login shell's startup files
 * may print something.
 * @param stdout The output.
 */
export function parseFactsOutput(stdout: string): FactsOutput {
	const lines = stdout.split('\n');
	let i = 0;
	while (i < lines.length && !lines[i].startsWith('gt:')) i++;
	if (i === lines.length) return { kind: 'unreadable' };
	if (lines[i] === 'gt:nogit') return { kind: 'noGit' };
	if (lines[i] === 'gt:nopath') return { kind: 'noPath' };
	if (lines[i] === 'gt:norepo') return { kind: 'notARepository', message: getErrorLines(lines.slice(i + 1).join('\n')) };

	// The fixed sections, in order, each up to the next one
	const readSection = (name: string, until: (line: string) => boolean) => {
		if (lines[i] !== name) return null;
		const section: string[] = [];
		for (i++; i < lines.length && !until(lines[i]); i++) section.push(lines[i]);
		return section;
	};
	const isSection = (line: string) => line.startsWith('gt:');
	const commonDir = readSection('gt:commondir', isSection);
	const originHead = readSection('gt:originhead', isSection);
	const branches = readSection('gt:branches', isSection);
	const list = readSection('gt:worktrees', (line) => line.startsWith('gt:wt ') || line === 'gt:end');
	// Without the Git folder, Root's size would silently include it
	if (commonDir === null || commonDir.length === 0 || commonDir[0] === '' || originHead === null || branches === null || list === null) return { kind: 'unreadable' };

	// Each worktree's record
	const records = new Map<string, { physicalPath: string | null, changes: number | null, counts: Map<string, AheadBehind> }>();
	while (i < lines.length && lines[i].startsWith('gt:wt ')) {
		const record = { physicalPath: <string | null>null, changes: <number | null>null, counts: new Map<string, AheadBehind>() };
		records.set(lines[i].substring(6), record);
		for (i++; i < lines.length && !isSection(lines[i]); i++) {
			const line = lines[i];
			let match: RegExpMatchArray | null;
			if (line.startsWith('p ')) {
				record.physicalPath = line.substring(2) !== '' ? line.substring(2) : null;
			} else if ((match = line.match(/^s (-1|\d+)$/)) !== null) {
				record.changes = match[1] === '-1' ? null : parseInt(match[1], 10);
			} else if ((match = line.match(/^c (\S+) (\d+)\s+(\d+)$/)) !== null) {
				record.counts.set(match[1], { ahead: parseInt(match[2], 10), behind: parseInt(match[3], 10) });
			} else if (line !== '') {
				return { kind: 'unreadable' };
			}
		}
	}
	if (lines[i] !== 'gt:end') return { kind: 'unreadable' };

	while (list.length > 0 && list[list.length - 1] === '') list.pop();
	const entries = parseWorktreeList(list.join('\n'));
	if (entries.length === 0 || entries[0].path === null) return { kind: 'unreadable' };
	const worktrees: WorktreeFacts[] = [];
	entries.forEach((entry, index) => {
		if (entry.path === null || entry.bare) return;
		const record = records.get(entry.path);
		worktrees.push({
			entry: entry,
			isMain: index === 0,
			physicalPath: typeof record !== 'undefined' ? record.physicalPath : null,
			changes: typeof record !== 'undefined' ? record.changes : null,
			counts: typeof record !== 'undefined' ? record.counts : new Map<string, AheadBehind>()
		});
	});

	return {
		kind: 'ok',
		facts: {
			commonDir: commonDir[0],
			originHead: originHead.length > 0 && originHead[0] !== '' ? originHead[0] : null,
			branches: branches.filter((line) => line !== ''),
			worktrees: worktrees
		}
	};
}

/** What df and du printed: df's output (NULL if it failed), each folder's total by path, and whether du couldn't read some folders. */
export interface Measured {
	readonly df: string | null;
	readonly totals: Map<string, number>;
	readonly partial: boolean;
}

/**
 * Parse the output of SIZES_SCRIPT.
 * @param stdout The output.
 * @returns What df and du printed, or NULL if the output isn't what the script prints.
 */
export function parseSizesOutput(stdout: string): Measured | null {
	const start = stdout.indexOf('gt:df\n'), du = stdout.indexOf('\ngt:du\n'), end = stdout.lastIndexOf('\ngt:end');
	if (start === -1 || du < start || end < du) return null;
	const duOutput = stdout.substring(du + 7, end + 1);
	return { df: stdout.substring(start + 6, du + 1), totals: parseDuOutput(duOutput), partial: /^gt:partial$/m.test(duOutput) };
}


/* Reading and acting */

/**
 * Reads each host's worktrees for the Manage panel, and fast-forwards them.
 */
export class WorktreeStats {
	private readonly source: WorktreeStatsSource;
	private readonly measuring = new Map<string, Promise<Measured | { error: string }>>(); // The measurements running, by repository, host and folders

	/**
	 * @param source The DataSource, for its Git and the remote hosts.
	 */
	constructor(source: WorktreeStatsSource) {
		this.source = source;
	}

	/**
	 * Load a host's worktrees: its Git first, then its sizes. It never rejects.
	 * @param repo The path of the repository.
	 * @param host The remote host's name, or NULL for this machine.
	 * @param send Called with each part as it arrives.
	 */
	public async load(repo: string, host: string | null, send: (answer: WorktreeStatsAnswer) => void): Promise<void> {
		let part: 'git' | 'sizes' = 'git';
		try {
			const read = await this.readFacts(repo, host);
			if ('error' in read) {
				send({ part: 'git', git: null, sizes: null, error: read.error });
				return;
			}
			send({ part: 'git', git: getManagedHostGit(read.facts, host), sizes: null, error: null });
			part = 'sizes';
			const sizes = await this.readSizes(repo, host, read.facts);
			send('error' in sizes ? { part: 'sizes', git: null, sizes: null, error: sizes.error } : { part: 'sizes', git: null, sizes: sizes.sizes, error: null });
		} catch (error) {
			send({ part: part, git: null, sizes: null, error: 'Git Tree couldn\'t read the worktrees (' + (error instanceof Error ? error.message : String(error)) + ').' });
		}
	}

	/**
	 * Fast-forward a worktree to the main branch. It reads the host's worktrees again, so the worktree must be one Git
	 * lists for this repository, and every rule must still hold. Only then it runs `git merge --ff-only <main>` in it.
	 * @param repo The path of the repository.
	 * @param host The remote host's name, or NULL for this machine.
	 * @param worktreePath The worktree's path, as the panel was given it.
	 * @returns The ErrorInfo.
	 */
	public async fastForward(repo: string, host: string | null, worktreePath: string): Promise<ErrorInfo> {
		const read = await this.readFacts(repo, host);
		if ('error' in read) return read.error;
		const git = getManagedHostGit(read.facts, host);
		const found = git.worktrees.find((managed) => managed.worktree.path === worktreePath);
		const where = worktreePath + (host !== null ? ' on "' + host + '"' : '');
		if (typeof found === 'undefined') return where + ' isn\'t a worktree of this repository. Refresh the panel, then try again.';
		if (found.fastForwardRefusal !== null) return 'Git Tree didn\'t fast-forward ' + where + ': ' + found.fastForwardRefusal + '.';
		const main = git.mainBranch!, branch = found.worktree.branch!;

		if (host === null) {
			const result = await this.runGit(['merge', '--ff-only', HEADS_PREFIX + main], worktreePath, FAST_FORWARD_TIMEOUT);
			if ('error' in result) return result.error;
			return result.result.code === 0 ? null : 'Git couldn\'t fast-forward ' + where + ': ' + getProcessError(result.result);
		}

		const remoteHosts = this.source.remoteHosts;
		if (remoteHosts === null) return REMOTE_HOSTS_UNAVAILABLE;
		const ran = await remoteHosts.runScript(repo, host, FAST_FORWARD_SCRIPT, [worktreePath, branch, main], FAST_FORWARD_TIMEOUT, true);
		if ('error' in ran) return ran.error;
		if (ran.result.code === 0) return null;
		const known = FAST_FORWARD_EXIT_MESSAGES[ran.result.code];
		return 'Git Tree didn\'t fast-forward ' + where + ': ' + (typeof known === 'string' ? known + '.' : getProcessError(ran.result));
	}

	/**
	 * Read what Git says of a host's repository.
	 * @param repo The path of the repository.
	 * @param host The remote host's name, or NULL for this machine.
	 */
	private async readFacts(repo: string, host: string | null): Promise<{ facts: RepoFacts } | { error: string }> {
		if (host === null) return this.readLocalFacts(repo);

		const remoteHosts = this.source.remoteHosts;
		if (remoteHosts === null) return { error: REMOTE_HOSTS_UNAVAILABLE };
		const ran = await remoteHosts.runScript(repo, host, FACTS_SCRIPT, [], GIT_TIMEOUT, false);
		if ('error' in ran) return ran;
		const output = parseFactsOutput(ran.result.stdout.toString());
		switch (output.kind) {
			case 'ok':
				return { facts: output.facts };
			case 'noGit':
				return { error: 'Git isn\'t installed on "' + host + '", or isn\'t on its PATH for SSH commands.' };
			case 'noPath':
				return { error: 'The repository\'s folder doesn\'t exist on "' + host + '".' };
			case 'notARepository':
				return { error: 'The folder on "' + host + '" isn\'t a Git repository: ' + output.message };
			default:
				return { error: 'Git Tree couldn\'t read the worktrees on "' + host + '"' + (ran.result.stderr.trim() !== '' ? ': ' + getErrorLines(ran.result.stderr) : '.') };
		}
	}

	/**
	 * Read what Git says of the repository on this machine. Each worktree is read at the same time.
	 * @param repo The path of the repository.
	 */
	private async readLocalFacts(repo: string): Promise<{ facts: RepoFacts } | { error: string }> {
		const first = await Promise.all([
			this.runGit(['worktree', 'list', '--porcelain'], repo, GIT_TIMEOUT),
			// A relative path is relative to the folder Git ran in (`--path-format=absolute` needs Git 2.31)
			this.runGit(['rev-parse', '--git-common-dir'], repo, GIT_TIMEOUT),
			this.runGit(['symbolic-ref', '-q', ORIGIN_HEAD], repo, GIT_TIMEOUT)
		]);
		const list = first[0], commonDirResult = first[1], originHeadResult = first[2];
		if ('error' in list) return list;
		if (list.result.code !== 0) return { error: 'Git couldn\'t list the worktrees: ' + getProcessError(list.result) };
		// Without the Git folder, Root's size would silently include it, so the read fails instead
		if ('error' in commonDirResult) return commonDirResult;
		const commonDirOutput = commonDirResult.result.stdout.toString().trim();
		const commonDir = commonDirResult.result.code === 0 && commonDirOutput !== '' ? await realpathOrNull(path.resolve(repo, commonDirOutput)) : null;
		if (commonDir === null) return { error: 'Git couldn\'t find the repository\'s Git folder' + (commonDirResult.result.code !== 0 ? ': ' + getProcessError(commonDirResult.result) : '.') };
		// symbolic-ref -q exits with 1 when origin/HEAD isn't set, and with another code when it couldn't read it
		if ('error' in originHeadResult) return originHeadResult;
		if (originHeadResult.result.code !== 0 && originHeadResult.result.code !== 1) return { error: 'Git couldn\'t read origin/HEAD: ' + getProcessError(originHeadResult.result) };
		const originHead = originHeadResult.result.code === 0 && originHeadResult.result.stdout.toString().trim() !== '' ? originHeadResult.result.stdout.toString().trim() : null;

		// for-each-ref matches a pattern's subfolders too, so only the exact refs are kept
		const candidates = getMainBranchCandidates(originHead);
		const shown = await this.runGit(['for-each-ref', '--format=%(refname)'].concat(candidates), repo, GIT_TIMEOUT);
		if ('error' in shown) return shown;
		if (shown.result.code !== 0) return { error: 'Git couldn\'t read the branches: ' + getProcessError(shown.result) };
		const branches = shown.result.stdout.toString().split(/\r?\n/).filter((ref) => candidates.indexOf(ref) > -1);
		const main = resolveMainBranch(originHead, branches);

		const entries = parseWorktreeList(list.result.stdout.toString().replace(/(\r?\n)+$/, ''));
		const worktrees = await Promise.all(entries.map((entry, index) => ({ entry: entry, index: index })).filter((item) => item.entry.path !== null && !item.entry.bare).map(async (item): Promise<WorktreeFacts> => {
			const entry = item.entry, worktreePath = entry.path!;
			const physicalPath = await realpathOrNull(worktreePath);
			if (physicalPath === null) return { entry: entry, isMain: item.index === 0, physicalPath: null, changes: null, counts: new Map() };
			const results = await Promise.all([
				this.runGit(['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all'], worktreePath, GIT_TIMEOUT),
				entry.branch !== null && 'branch' in main && entry.branch !== HEADS_PREFIX + main.branch
					? this.runGit(['rev-list', '--left-right', '--count', 'HEAD...' + HEADS_PREFIX + main.branch], worktreePath, GIT_TIMEOUT)
					: Promise.resolve(null)
			]);
			const status = results[0], compared = results[1];
			const counts = new Map<string, AheadBehind>();
			const match = compared !== null && 'result' in compared && compared.result.code === 0 ? compared.result.stdout.toString().trim().match(/^(\d+)\s+(\d+)$/) : null;
			if (match !== null && 'branch' in main) counts.set(HEADS_PREFIX + main.branch, { ahead: parseInt(match[1], 10), behind: parseInt(match[2], 10) });
			return {
				entry: entry,
				isMain: item.index === 0,
				physicalPath: physicalPath,
				changes: 'result' in status && status.result.code === 0 ? status.result.stdout.toString().split(/\r?\n/).filter((line) => line !== '').length : null,
				counts: counts
			};
		}));

		return {
			facts: {
				commonDir: commonDir,
				originHead: originHead,
				branches: branches,
				worktrees: worktrees
			}
		};
	}

	/**
	 * Measure a host's disk, and the folders of its worktrees and Git.
	 * @param repo The path of the repository.
	 * @param host The remote host's name, or NULL for this machine.
	 * @param facts What Git says of the host's repository.
	 */
	private async readSizes(repo: string, host: string | null, facts: RepoFacts): Promise<{ sizes: ManagedHostSizes } | { error: string }> {
		const targets = getSizeTargets(facts);
		// A measurement of the same folders that an earlier load started is waited for, instead of running du again beside it
		const key = JSON.stringify([repo, host, targets]);
		let measuring = this.measuring.get(key);
		if (typeof measuring === 'undefined') {
			const started = this.measure(repo, host, facts, targets);
			const forget = () => {
				if (this.measuring.get(key) === started) this.measuring.delete(key);
			};
			started.then(forget, forget);
			this.measuring.set(key, started);
			measuring = started;
		}
		const measured = await measuring;
		return 'error' in measured ? measured : { sizes: getManagedHostSizes(facts, targets, measured.df, measured.totals, measured.partial) };
	}

	/**
	 * Run df and du for a host's folders (see readSizes).
	 * @param repo The path of the repository.
	 * @param host The remote host's name, or NULL for this machine.
	 * @param facts What Git says of the host's repository.
	 * @param targets The folders to measure.
	 */
	private async measure(repo: string, host: string | null, facts: RepoFacts, targets: ReadonlyArray<SizeTarget>): Promise<Measured | { error: string }> {
		const reads = planSizeReads(targets);

		if (host === null) {
			const main = facts.worktrees.find((worktree) => worktree.isMain && worktree.physicalPath !== null);
			const results = await Promise.all([
				runProcess('df', ['-Pk', '--', typeof main !== 'undefined' ? main.physicalPath! : repo], { timeout: SIZES_TIMEOUT })
			].concat(reads.map((read) => runProcess('du', ['-k', '-d', String(read.depth), '--', read.path], { timeout: SIZES_TIMEOUT }))));
			const failed = results.find((result) => result.error !== null);
			if (typeof failed !== 'undefined') return { error: 'Git Tree couldn\'t measure the sizes, because du or df couldn\'t run (' + failed.error!.message + ').' };
			if (results.some((result) => result.timedOut)) return { error: 'Measuring the sizes took longer than ' + (SIZES_TIMEOUT / 60000) + ' minutes.' };
			const totals = new Map<string, number>();
			results.slice(1).forEach((result) => parseDuOutput(result.stdout.toString()).forEach((size, folder) => totals.set(folder, size)));
			return { df: results[0].code === 0 ? results[0].stdout.toString() : null, totals: totals, partial: results.slice(1).some((result) => result.code !== 0) };
		}

		const remoteHosts = this.source.remoteHosts;
		if (remoteHosts === null) return { error: REMOTE_HOSTS_UNAVAILABLE };
		const args = [String(targets.length)].concat(targets.map((target) => target.path));
		reads.forEach((read) => args.push(String(read.depth), read.path));
		const ran = await remoteHosts.runScript(repo, host, SIZES_SCRIPT, args, SIZES_TIMEOUT, false);
		if ('error' in ran) return ran;
		const output = parseSizesOutput(ran.result.stdout.toString());
		if (output === null) return { error: 'Git Tree couldn\'t read the sizes on "' + host + '"' + (ran.result.stderr.trim() !== '' ? ': ' + getErrorLines(ran.result.stderr) : '.') };
		return output;
	}

	/**
	 * Run Git on this machine.
	 * @returns The result, or why Git can't run.
	 */
	private async runGit(args: string[], cwd: string, timeout: number): Promise<{ result: ProcessResult } | { error: string }> {
		const result = await this.source.runGit(args, cwd, timeout);
		if (result === null) {
			const error = this.source.getGitExecutableError();
			return { error: error !== null ? error : 'Git Tree can\'t run Git.' };
		}
		return { result: result };
	}
}

/**
 * Get why a process failed, in words.
 * @param result The process's result.
 */
function getProcessError(result: ProcessResult) {
	if (result.timedOut) return 'it took too long.';
	if (result.error !== null) return result.error.message;
	const lines = getErrorLines(result.stderr);
	return lines !== '' ? lines : 'it exited with code ' + result.code + '.';
}

/**
 * Resolve a path's symbolic links.
 * @param folder The path.
 * @returns The resolved path, with forward slashes. NULL => it doesn't exist.
 */
function realpathOrNull(folder: string): Promise<string | null> {
	return new Promise((resolve) => fs.realpath(folder, (error, resolved) => resolve(error === null ? resolved.replace(/\\/g, '/') : null)));
}
