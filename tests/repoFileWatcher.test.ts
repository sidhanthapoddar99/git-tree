import * as date from './mocks/date';
import * as vscode from './mocks/vscode';
jest.mock('vscode', () => vscode, { virtual: true });
jest.mock('../src/logger');

import { Logger } from '../src/logger';
import { RepoFileWatcher } from '../src/repoFileWatcher';

let logger: Logger;
let spyOnLog: jest.SpyInstance;

beforeAll(() => {
	logger = new Logger();
	spyOnLog = jest.spyOn(logger, 'log');
	jest.useFakeTimers();
});

afterAll(() => {
	logger.dispose();
});

describe('RepoFileWatcher', () => {
	let repoFileWatcher: RepoFileWatcher;
	let callback: jest.Mock;
	beforeEach(() => {
		callback = jest.fn();
		repoFileWatcher = new RepoFileWatcher(logger, callback);
	});

	const watcher = (index: number) => repoFileWatcher['fsWatchers'][index].watcher;

	it('Should start and receive file events', () => {
		// Setup
		repoFileWatcher.start('/path/to/repo');
		const onDidCreate = (<jest.Mock<any, any>>watcher(0).onDidCreate).mock.calls[0][0];
		const onDidChange = (<jest.Mock<any, any>>watcher(0).onDidChange).mock.calls[0][0];
		const onDidDelete = (<jest.Mock<any, any>>watcher(0).onDidDelete).mock.calls[0][0];

		// Run
		onDidCreate(vscode.Uri.file('/path/to/repo/file'));
		onDidChange(vscode.Uri.file('/path/to/repo/file'));
		onDidDelete(vscode.Uri.file('/path/to/repo/file'));
		jest.runOnlyPendingTimers();

		// Assert
		expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalledWith('/path/to/repo/**');
		expect(callback).toHaveBeenCalledTimes(1);
	});

	it('Should stop a previous active File System Watcher before creating a new one', () => {
		// Setup
		repoFileWatcher.start('/path/to/repo1');
		const firstWatcher = watcher(0);
		const onDidCreate = (<jest.Mock<any, any>>firstWatcher.onDidCreate).mock.calls[0][0];

		// Run
		onDidCreate(vscode.Uri.file('/path/to/repo1/file'));
		repoFileWatcher.start('/path/to/repo2');
		jest.runOnlyPendingTimers();

		// Assert
		expect(<jest.Mock<any, any>>firstWatcher.dispose).toHaveBeenCalledTimes(1);
		expect(callback).toHaveBeenCalledTimes(0);
	});

	it('Should only dispose the active File System Watcher if it exists', () => {
		// Run
		repoFileWatcher.stop();

		// Assert
		expect(spyOnLog).toHaveBeenCalledTimes(0);
	});

	it('Should ignore file system events while muted', () => {
		// Setup
		repoFileWatcher.start('/path/to/repo');
		const onDidCreate = (<jest.Mock<any, any>>watcher(0).onDidCreate).mock.calls[0][0];

		// Run
		repoFileWatcher.mute();
		onDidCreate(vscode.Uri.file('/path/to/repo/file'));
		jest.runOnlyPendingTimers();

		// Assert
		expect(callback).toHaveBeenCalledTimes(0);
	});

	it('Should resume reporting file events after 1.5 seconds', () => {
		// Setup
		date.setCurrentTime(1587559258);
		repoFileWatcher.start('/path/to/repo');
		const onDidCreate = (<jest.Mock<any, any>>watcher(0).onDidCreate).mock.calls[0][0];
		const onDidChange = (<jest.Mock<any, any>>watcher(0).onDidChange).mock.calls[0][0];

		// Run
		repoFileWatcher.mute();
		repoFileWatcher.unmute();
		onDidCreate(vscode.Uri.file('/path/to/repo/file'));
		date.setCurrentTime(1587559260);
		onDidChange(vscode.Uri.file('/path/to/repo/file'));
		jest.runOnlyPendingTimers();

		// Assert
		expect(callback).toHaveBeenCalledTimes(1);
	});

	it('Should ignore file system events on files ignored within .git directory', () => {
		// Setup
		repoFileWatcher.start('/path/to/repo');
		const onDidCreate = (<jest.Mock<any, any>>watcher(0).onDidCreate).mock.calls[0][0];

		// Run
		onDidCreate(vscode.Uri.file('/path/to/repo/.git/config-x'));
		jest.runOnlyPendingTimers();

		// Assert
		expect(callback).toHaveBeenCalledTimes(0);
	});

	it('Should report file events when a worktree\'s HEAD changes', () => {
		// Setup
		repoFileWatcher.start('/path/to/repo');
		const onDidChange = (<jest.Mock<any, any>>watcher(0).onDidChange).mock.calls[0][0];

		// Run
		onDidChange(vscode.Uri.file('/path/to/repo/.git/worktrees/feature/HEAD'));
		jest.runOnlyPendingTimers();

		// Assert
		expect(callback).toHaveBeenCalledTimes(1);
	});

	it('Should report file events in a worktree inside the repository, so its uncommitted changes stay up to date', () => {
		// Setup
		repoFileWatcher.start('/path/to/repo', ['/path/to/repo', '/path/to/repo/.worktrees/feature']);
		const onDidChange = (<jest.Mock<any, any>>watcher(0).onDidChange).mock.calls[0][0];

		// Run
		onDidChange(vscode.Uri.file('/path/to/repo/.worktrees/feature/file'));
		jest.runOnlyPendingTimers();

		// Assert
		expect(repoFileWatcher['fsWatchers'].map((fsWatcher) => fsWatcher.root)).toStrictEqual(['/path/to/repo']);
		expect(callback).toHaveBeenCalledTimes(1);
	});

	it('Should watch each worktree outside the repository with its own File System Watcher', () => {
		// Setup
		repoFileWatcher.start('/path/to/repo', ['/path/to/repo', '/path/to/repo-feature', '/path/to/worktrees/fix']);
		const onDidChange = (<jest.Mock<any, any>>watcher(1).onDidChange).mock.calls[0][0];

		// Run
		onDidChange(vscode.Uri.file('/path/to/repo-feature/src/file'));
		jest.runOnlyPendingTimers();

		// Assert
		expect(repoFileWatcher['fsWatchers'].map((fsWatcher) => fsWatcher.root)).toStrictEqual(['/path/to/repo', '/path/to/repo-feature', '/path/to/worktrees/fix']);
		expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalledWith('/path/to/repo-feature/**');
		expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalledWith('/path/to/worktrees/fix/**');
		expect(spyOnLog).toHaveBeenCalledWith('Started watching repo: /path/to/repo (and 2 worktrees outside it)');
		expect(callback).toHaveBeenCalledTimes(1);
	});

	it('Should ignore file events on files ignored within the .git directory of a worktree outside the repository', () => {
		// Setup
		repoFileWatcher.start('/path/to/repo', ['/path/to/repo-feature']);
		const onDidChange = (<jest.Mock<any, any>>watcher(1).onDidChange).mock.calls[0][0];

		// Run
		onDidChange(vscode.Uri.file('/path/to/repo-feature/.git/config-x'));
		jest.runOnlyPendingTimers();

		// Assert
		expect(callback).toHaveBeenCalledTimes(0);
	});

	it('Should dispose every File System Watcher when stopped', () => {
		// Setup
		repoFileWatcher.start('/path/to/repo', ['/path/to/repo-feature']);
		const watchers = [watcher(0), watcher(1)];

		// Run
		repoFileWatcher.stop();

		// Assert
		watchers.forEach((fsWatcher) => expect(<jest.Mock<any, any>>fsWatcher.dispose).toHaveBeenCalledTimes(1));
		expect(repoFileWatcher['fsWatchers']).toStrictEqual([]);
	});
});
