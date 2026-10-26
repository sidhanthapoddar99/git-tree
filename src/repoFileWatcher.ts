import * as path from 'path';
import * as vscode from 'vscode';
import { getConfig } from './config';
import { Logger } from './logger';
import { getPathFromStr, getPathFromUri } from './utils';

const FILE_CHANGE_REGEX = /(^\.git\/(config|index|HEAD|refs\/stash|refs\/heads\/.*|refs\/remotes\/.*|refs\/tags\/.*|worktrees\/[^\/]+\/HEAD)$)|(^(?!\.git).*$)|(^\.git[^\/]+$)/;

/**
 * Watches a Git repository for file events.
 */
export class RepoFileWatcher {
	private readonly logger: Logger;
	private readonly repoChangeCallback: () => void;
	private repo: string | null = null;
	private worktreeFolder: string | null = null;
	private fsWatcher: vscode.FileSystemWatcher | null = null;
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
	 */
	public start(repo: string) {
		if (this.fsWatcher !== null) {
			// If there is an existing File System Watcher, stop it
			this.stop();
		}

		this.repo = repo;
		// Ignore file events in the folder that worktrees are created in, as they don't change this repository
		const worktreeLocation = getConfig(repo).worktreeDefaultLocation;
		this.worktreeFolder = path.isAbsolute(worktreeLocation) ? null : getPathFromStr(path.normalize(worktreeLocation)) + '/';
		// Create a File System Watcher for all events within the specified repository
		this.fsWatcher = vscode.workspace.createFileSystemWatcher(repo + '/**');
		this.fsWatcher.onDidCreate(uri => this.refresh(uri));
		this.fsWatcher.onDidChange(uri => this.refresh(uri));
		this.fsWatcher.onDidDelete(uri => this.refresh(uri));
		this.logger.log('Started watching repo: ' + repo);
	}

	/**
	 * Stop watching the repository for file events.
	 */
	public stop() {
		if (this.fsWatcher !== null) {
			// If there is an existing File System Watcher, stop it
			this.fsWatcher.dispose();
			this.fsWatcher = null;
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
	 * Handle a file event triggered by the File System Watcher.
	 * @param uri The URI of the file that the event occurred on.
	 */
	private refresh(uri: vscode.Uri) {
		if (this.muted) return;
		const filePath = getPathFromUri(uri).replace(this.repo + '/', '');
		if (!filePath.match(FILE_CHANGE_REGEX) || (this.worktreeFolder !== null && filePath.startsWith(this.worktreeFolder))) return;
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
