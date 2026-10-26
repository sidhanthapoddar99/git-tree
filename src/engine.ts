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
			return 'win32-' + arch + '-msvc';
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
 * Load the engine for the current platform.
 * @param logger The Git Tree Logger instance, which says once why the engine isn't used.
 * @returns The engine, or NULL if it isn't available, in which case Git Tree reads repositories with the Git CLI.
 */
export function loadEngine(logger: Logger): Engine | null {
	const platform = getEnginePlatform();
	if (platform === null) {
		logger.log('The Git Tree engine isn\'t built for ' + process.platform + '-' + process.arch + ', so Git Tree reads repositories with Git.');
		return null;
	}
	const enginePath = getEnginePath(platform);
	if (!fs.existsSync(enginePath)) {
		logger.log('The Git Tree engine isn\'t installed for ' + platform + ', so Git Tree reads repositories with Git.');
		return null;
	}

	let native: NativeModule;
	try {
		native = require(enginePath);
	} catch (error) {
		logger.logError('Unable to load the Git Tree engine, so Git Tree reads repositories with Git: ' + (error instanceof Error ? error.message : String(error)));
		return null;
	}
	const engine = createEngine(native);
	logger.log('Using the Git Tree engine (version: ' + engine.version + ')');
	return engine;
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
		log: (repo, request) => read({ read: 'log', repo: repo, log: request })
	};
}

/**
 * Is Node.js running on a Linux that uses the musl C library (for example Alpine), rather than glibc?
 */
function isMusl() {
	const report = process.report ? <{ header?: { glibcVersionRuntime?: string } }>process.report.getReport() : null;
	return report !== null && typeof report.header === 'object' && typeof report.header.glibcVersionRuntime === 'undefined';
}
