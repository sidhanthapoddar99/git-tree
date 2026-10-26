import * as vscode from 'vscode';
import { Logger } from './logger';
import { getPathFromUri, pathWithTrailingSlash } from './utils';

const FILE_CHANGE_REGEX = /(^\.git\/(config|index|HEAD|refs\/stash|refs\/heads\/.*|refs\/remotes\/.*|refs\/tags\/.*|worktrees\/[^\/]+\/(HEAD|index))$)|(^(?!\.git).*$)|(^\.git[^\/]+$)/;

/**
 * Watches a Git repository, and its worktrees, for file events.
 */
export class RepoFileWatcher {
	private readonly logger: Logger;
	private readonly repoChangeCallback: () => void;
	private repo: string | null = null;
	private fsWatchers: { root: string, watcher: vscode.FileSystemWatcher }[] = [];
	private refreshTimeout: NodeJS.Timeout | null = null;
	private muted: boolean = false;
	private resumeAt: number = 0;

	/**
	 * Creates a RepoFileWatcher.
	 * @param logger The Git Tree Logger instance.
	 * @param repoChangeCallback A callback to be invoked when a file event occurs in the repository.
	 */
	constructor(logger: Logger, repoChangeCallback: () => void) {
		this.logger = logger;
		this.repoChangeCallback = repoChangeCallback;
	}

	/**
	 * Start watching a repository for file events.
	 * @param repo The path of the repository to watch.
	 * @param worktrees The paths of the repository's worktrees. Those outside the repository's folder get their own watcher, so their uncommitted changes stay up to date.
	 */
	public start(repo: string, worktrees: ReadonlyArray<string> = []) {
		if (this.fsWatchers.length > 0) {
			// If there are existing File System Watchers, stop them
			this.stop();
		}

		this.repo = repo;
		const roots = [repo, ...worktrees.filter((worktree) => worktree !== repo && !worktree.startsWith(pathWithTrailingSlash(repo)))];
		this.fsWatchers = roots.map((root) => {
			// Create a File System Watcher for all events within the folder
			const watcher = vscode.workspace.createFileSystemWatcher(root + '/**');
			watcher.onDidCreate(uri => this.refresh(root, uri));
			watcher.onDidChange(uri => this.refresh(root, uri));
			watcher.onDidDelete(uri => this.refresh(root, uri));
			return { root: root, watcher: watcher };
		});
		this.logger.log('Started watching repo: ' + repo + (roots.length > 1 ? ' (and ' + (roots.length - 1) + ' worktree' + (roots.length > 2 ? 's' : '') + ' outside it)' : ''));
	}

	/**
	 * Stop watching the repository for file events.
	 */
	public stop() {
		if (this.fsWatchers.length > 0) {
			// If there are existing File System Watchers, stop them
			this.fsWatchers.forEach((fsWatcher) => fsWatcher.watcher.dispose());
			this.fsWatchers = [];
			this.logger.log('Stopped watching repo: ' + this.repo);
		}
		if (this.refreshTimeout !== null) {
			// If a timeout is active, clear it
			clearTimeout(this.refreshTimeout);
			this.refreshTimeout = null;
		}
	}

	/**
	 * Mute file events - Used to prevent many file events from being triggered when a Git action is executed by the Git Tree View.
	 */
	public mute() {
		this.muted = true;
	}

	/**
	 * Unmute file events - Used to resume normal watching after a Git action executed by the Git Tree View has completed.
	 */
	public unmute() {
		this.muted = false;
		this.resumeAt = (new Date()).getTime() + 1500;
	}


	/**
	 * Handle a file event triggered by a File System Watcher.
	 * @param root The folder the File System Watcher watches.
	 * @param uri The URI of the file that the event occurred on.
	 */
	private refresh(root: string, uri: vscode.Uri) {
		if (this.muted) return;
		const filePath = getPathFromUri(uri).replace(root + '/', '');
		if (!filePath.match(FILE_CHANGE_REGEX)) return;
		if ((new Date()).getTime() < this.resumeAt) return;

		if (this.refreshTimeout !== null) {
			clearTimeout(this.refreshTimeout);
		}
		this.refreshTimeout = setTimeout(() => {
			this.refreshTimeout = null;
			this.repoChangeCallback();
		}, 750);
	}
}
