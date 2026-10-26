import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './logger';
import { CommitOrdering } from './types';

/* The records the engine reads. Each is what one Git command prints, as an object instead of text. */

/** One line of `git branch [-a]`. */
export interface BranchListEntry {
	readonly name: string; // The name `git branch` prints (the part before ` -> ` for a symbolic ref)
	readonly current: boolean; // The line is marked with `*`
}

/** One line of `git show-ref -d --head`. */
export interface ShowRefEntry {
	readonly hash: string;
	readonly ref: string;
}

/** One record of `git worktree list --porcelain`. */
export interface WorktreeListEntry {
	readonly path: string | null; // NULL => the record has no `worktree` line
	readonly head: string | null; // The `HEAD` line's hash, all zeros for a branch without commits
	readonly branch: string | null; // The `branch` line's full ref name
	readonly bare: boolean;
	readonly locked: boolean;
	readonly prunable: boolean;
}

/** One line of the extension's `git reflog refs/stash` output. */
export interface StashListEntry {
	readonly hash: string;
	readonly parents: string[];
	readonly selector: string;
	readonly author: string;
	readonly email: string;
	readonly date: number;
	readonly message: string;
}

/** One line of the extension's `git log` output. */
export interface LogEntry {
	readonly hash: string;
	readonly parents: string[];
	readonly author: string;
	readonly email: string;
	readonly date: number;
	readonly message: string;
}

/** The fields of the extension's `git show` format for a commit's details. */
export interface CommitDetailsEntry {
	readonly hash: string;
	readonly parents: string[];
	readonly author: string;
	readonly authorEmail: string;
	readonly authorDate: number;
	readonly committer: string;
	readonly committerEmail: string;
	readonly committerDate: number;
	readonly signatureStatus: string; // `%G?`, or empty when the format doesn't ask for it
	readonly signer: string; // `%GS`
	readonly key: string; // `%GK`
	readonly body: string; // `%B`, and the newline that ends Git's output
}

/** The fields the extension's commit details format asks for. */
export interface EngineDetailsFormat {
	readonly mailmap: boolean; // `%aN %aE %cN %cE` instead of `%an %ae %cn %ce`
	readonly signature: boolean; // `%G? %GS %GK` instead of nothing
}

/** What `git diff` (or `git diff-tree`) prints with `--name-status` and with `--numstat`, split at each NUL. */
export interface DiffOutput {
	readonly nameStatus: string[];
	readonly numStat: string[];
}

/** The fields of the extension's `git for-each-ref` format for a tag's details, as Git prints them. */
export interface TagDetailsEntry {
	readonly hash: string; // `%(objectname)`
	readonly taggerName: string; // `%(taggername)`
	readonly taggerEmail: string; // `%(taggeremail)`, with its `<>`
	readonly taggerDate: string; // `%(taggerdate:unix)`
	readonly signature: string; // `%(contents:signature)`
	readonly contents: string; // `%(contents)`, and the newline that ends Git's output
}

/** The fields the extension's `--format` strings ask for. */
export interface EngineFormat {
	readonly mailmap: boolean; // `%aN %aE` instead of `%an %ae`
	readonly authorDate: boolean; // `%at` instead of `%ct`
}

/** A `git log` read. */
export interface EngineLogRequest {
	readonly revisions: ReadonlyArray<string>; // The revision arguments passed to `git log`
	readonly maxCount: number;
	readonly order: CommitOrdering;
	readonly firstParent: boolean;
	readonly format: EngineFormat;
}

/** The repository info reads in one crossing. Each part is the answer its own read gives. */
export interface RepoInfoAnswer {
	readonly branches: EngineAnswer<BranchListEntry[]>;
	readonly remotes: EngineAnswer<string[]>;
	readonly stashes: EngineAnswer<StashListEntry[]> | null; // NULL => stashes weren't asked for
	readonly worktrees: EngineAnswer<WorktreeListEntry[]>;
}

/**
 * The refs and a log page in one crossing:
 * - `unchanged`: the token the read was given still describes the answer, so the engine didn't walk the log.
 * - Otherwise each part is the answer its own read gives, and `token` describes them (NULL unless both are `ok`).
 */
export type CommitsAnswer = { readonly token: string, readonly unchanged: true }
	| { readonly token: string | null, readonly refs: EngineAnswer<ShowRefEntry[]>, readonly log: EngineAnswer<LogEntry[]> };

/** A log page as the engine sends it: each (name, email) once, and each parent in the page as its index. */
interface CompactLog {
	readonly people: string[]; // Pair k is people[2k] (name) and people[2k + 1] (email)
	readonly commits: [string, (number | string)[], number, number, string][]; // [hash, parents, person, date, message]
}

/**
 * The engine's answer to a read:
 * - `ok`: the records.
 * - `unsupported`: the engine can't answer with certainty, and says why. The Git CLI read must be used instead.
 * - `failed`: the read failed, and says why.
 */
export type EngineAnswer<T> = { readonly ok: T } | { readonly unsupported: string } | { readonly failed: string };

/**
 * The Git Tree engine: a native module that reads repositories in-process, instead of spawning Git.
 */
export interface Engine {
	readonly version: string;
	readonly branches: (repo: string, includeRemotes: boolean) => Promise<EngineAnswer<BranchListEntry[]>>;
	readonly remotes: (repo: string) => Promise<EngineAnswer<string[]>>;
	readonly stashes: (repo: string, format: EngineFormat) => Promise<EngineAnswer<StashListEntry[]>>;
	readonly worktrees: (repo: string) => Promise<EngineAnswer<WorktreeListEntry[]>>;
	readonly refs: (repo: string, includeRemotes: boolean) => Promise<EngineAnswer<ShowRefEntry[]>>;
	readonly log: (repo: string, request: EngineLogRequest) => Promise<EngineAnswer<LogEntry[]>>;
	readonly commitDetails: (repo: string, hash: string, format: EngineDetailsFormat) => Promise<EngineAnswer<CommitDetailsEntry>>;
	readonly commitSubject: (repo: string, hash: string) => Promise<EngineAnswer<string>>;
	readonly diff: (repo: string, from: string, to: string) => Promise<EngineAnswer<DiffOutput>>;
	readonly commitFile: (repo: string, hash: string, path: string) => Promise<EngineAnswer<string>>; // The contents in base64
	readonly config: (repo: string, location: 'local' | 'global' | null) => Promise<EngineAnswer<string[]>>;
	readonly remoteUrl: (repo: string, remote: string) => Promise<EngineAnswer<string | null>>;
	readonly tagDetails: (repo: string, name: string) => Promise<EngineAnswer<TagDetailsEntry>>;
	readonly repoInfo: (repo: string, includeRemotes: boolean, stashes: EngineFormat | null) => Promise<EngineAnswer<RepoInfoAnswer>>;
	readonly commits: (repo: string, includeRemotes: boolean, request: EngineLogRequest, token: string | null) => Promise<EngineAnswer<CommitsAnswer>>;
}

/** The functions the native module exports (`native/node/src/lib.rs`). */
interface NativeModule {
	readonly read: (request: string) => Promise<string>;
	readonly version: () => string;
}

/**
 * Get the name of the platform the native module is built for, as in its file name.
 * @returns The platform name (e.g. `linux-x64-gnu`), or NULL if the engine isn't built for this platform.
 */
export function getEnginePlatform() {
	const arch = process.arch === 'x64' || process.arch === 'arm64' ? process.arch : null;
	if (arch === null) return null;
	switch (process.platform) {
		case 'linux':
			return 'linux-' + arch + (isMusl() ? '-musl' : '-gnu');
		case 'darwin':
			return 'darwin-' + arch;
		case 'win32':
			return 'win32-' + arch;
		default:
			return null;
	}
}

/**
 * Get the path of the native module for a platform.
 * @param platform The platform name, from `getEnginePlatform`.
 * @returns The path of the native module.
 */
export function getEnginePath(platform: string) {
	return path.join(__dirname, '..', 'native', 'bin', 'git-tree-engine.' + platform + '.node');
}

/**
 * Load the engine for the current platform. Git Tree needs it: the package ships the engine for every platform it
 * supports, so a missing or broken engine is an error, not a reason to read everything with the Git CLI.
 * @param logger The Git Tree Logger instance.
 * @returns The engine, or the message that explains why it can't be loaded.
 */
export function loadEngine(logger: Logger): { engine: Engine } | { error: string } {
	const platform = getEnginePlatform();
	if (platform === null) {
		return { error: 'Git Tree doesn\'t run on ' + process.platform + '-' + process.arch + '. It runs on Windows, macOS and Linux, on x64 and arm64.' };
	}
	const enginePath = getEnginePath(platform);
	if (!fs.existsSync(enginePath)) {
		return { error: 'This Git Tree installation is missing its engine for ' + platform + '. Reinstall Git Tree.' };
	}

	let native: NativeModule;
	try {
		native = require(enginePath);
	} catch (error) {
		return { error: 'Unable to load the Git Tree engine for ' + platform + ': ' + (error instanceof Error ? error.message : String(error)) };
	}
	const engine = createEngine(native);
	logger.log('Using the Git Tree engine (version: ' + engine.version + ')');
	return { engine: engine };
}

/**
 * Wrap the native module's read function with a typed function for each read.
 * @param native The native module.
 * @returns The engine.
 */
function createEngine(native: NativeModule): Engine {
	const read = <T>(request: object) => native.read(JSON.stringify(request)).then((answer) => <EngineAnswer<T>>JSON.parse(answer));
	return {
		version: native.version(),
		branches: (repo, includeRemotes) => read({ read: 'branches', repo: repo, includeRemotes: includeRemotes }),
		remotes: (repo) => read({ read: 'remotes', repo: repo }),
		stashes: (repo, format) => read({ read: 'stashes', repo: repo, format: format }),
		worktrees: (repo) => read({ read: 'worktrees', repo: repo }),
		refs: (repo, includeRemotes) => read({ read: 'refs', repo: repo, includeRemotes: includeRemotes }),
		log: (repo, request) => read({ read: 'log', repo: repo, log: request }),
		commitDetails: (repo, hash, format) => read({ read: 'commitDetails', repo: repo, hash: hash, format: format }),
		commitSubject: (repo, hash) => read({ read: 'commitSubject', repo: repo, hash: hash }),
		diff: (repo, from, to) => read({ read: 'diff', repo: repo, from: from, to: to }),
		commitFile: (repo, hash, path) => read({ read: 'commitFile', repo: repo, hash: hash, path: path }),
		config: (repo, location) => read({ read: 'config', repo: repo, location: location }),
		remoteUrl: (repo, remote) => read({ read: 'remoteUrl', repo: repo, remote: remote }),
		tagDetails: (repo, name) => read({ read: 'tagDetails', repo: repo, name: name }),
		repoInfo: (repo, includeRemotes, stashes) => read({ read: 'repoInfo', repo: repo, includeRemotes: includeRemotes, stashes: stashes }),
		commits: (repo, includeRemotes, request, token) => read<CommitsAnswer>({ read: 'commits', repo: repo, includeRemotes: includeRemotes, log: request, token: token }).then((answer) => {
			if ('ok' in answer && 'log' in answer.ok && 'ok' in answer.ok.log) {
				return { ok: { token: answer.ok.token, refs: answer.ok.refs, log: { ok: expandLog(<CompactLog><unknown>answer.ok.log.ok) } } };
			}
			return answer;
		})
	};
}

/**
 * Expand a compact log page into the records the `log` read returns.
 * @param log The compact log page.
 * @returns The records.
 */
function expandLog(log: CompactLog): LogEntry[] {
	const commits = log.commits, people = log.people, entries: LogEntry[] = new Array(commits.length);
	for (let i = 0; i < commits.length; i++) {
		const commit = commits[i], parents = commit[1], person = commit[2] * 2;
		entries[i] = {
			hash: commit[0],
			parents: parents.map((parent) => typeof parent === 'number' ? commits[parent][0] : parent),
			author: people[person],
			email: people[person + 1],
			date: commit[3],
			message: commit[4]
		};
	}
	return entries;
}

/**
 * Is Node.js running on a Linux that uses the musl C library (for example Alpine), rather than glibc?
 */
function isMusl() {
	// musl installs its dynamic loader as /lib/ld-musl-<arch>.so.1. process.report can't tell: in Visual Studio Code's
	// Electron, getReport() doesn't return the report object that Node.js does. A wrong answer only means the wrong
	// module fails to load, which loadEngine reports.
	try {
		return fs.readdirSync('/lib').some((name) => name.startsWith('ld-musl-'));
	} catch (_) {
		return false;
	}
}
