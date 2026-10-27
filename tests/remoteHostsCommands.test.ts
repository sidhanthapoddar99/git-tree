import * as vscode from './mocks/vscode';
jest.mock('vscode', () => Object.assign({}, vscode, {
	ProgressLocation: { Notification: 15 },
	window: Object.assign(vscode.window, {
		showInputBox: jest.fn(),
		showWarningMessage: jest.fn(),
		withProgress: jest.fn((_options: unknown, task: () => Promise<unknown>) => task())
	})
}), { virtual: true });
jest.mock('../src/avatarManager');
jest.mock('../src/dataSource');
jest.mock('../src/extensionState');
jest.mock('../src/gitTreeView');
jest.mock('../src/logger');
jest.mock('../src/repoManager');

import { ConfigurationChangeEvent } from 'vscode';
import { AvatarManager } from '../src/avatarManager';
import { CommandManager } from '../src/commands';
import { DataSource } from '../src/dataSource';
import { ExtensionState } from '../src/extensionState';
import { Logger } from '../src/logger';
import { RemoteHostSnapshot } from '../src/remoteHosts';
import { RepoManager } from '../src/repoManager';
import { GitExecutable } from '../src/utils';
import { EventEmitter } from '../src/utils/event';

import { mockRepoState } from './helpers/utils';

const window = <typeof vscode.window & { showInputBox: jest.Mock, showWarningMessage: jest.Mock, withProgress: jest.Mock }><unknown>vscode.window;

let onDidChangeConfiguration: EventEmitter<ConfigurationChangeEvent>, onDidChangeGitExecutable: EventEmitter<GitExecutable>;
let logger: Logger, dataSource: DataSource, extensionState: ExtensionState, avatarManager: AvatarManager, repoManager: RepoManager;
let commandManager: CommandManager;
let remoteHosts: { loadHosts: jest.Mock, getConfigError: jest.Mock, getSshAliases: jest.Mock, saveHost: jest.Mock, removeHost: jest.Mock };

beforeAll(() => {
	onDidChangeConfiguration = new EventEmitter<ConfigurationChangeEvent>();
	onDidChangeGitExecutable = new EventEmitter<GitExecutable>();
	logger = new Logger();
	dataSource = new DataSource(null, onDidChangeConfiguration.subscribe, onDidChangeGitExecutable.subscribe, logger);
	extensionState = new ExtensionState(vscode.mocks.extensionContext, onDidChangeGitExecutable.subscribe);
	avatarManager = new AvatarManager(dataSource, extensionState, logger);
	repoManager = new RepoManager(dataSource, extensionState, onDidChangeConfiguration.subscribe, logger);
});

afterAll(() => {
	repoManager.dispose();
	avatarManager.dispose();
	extensionState.dispose();
	dataSource.dispose();
	logger.dispose();
	onDidChangeConfiguration.dispose();
	onDidChangeGitExecutable.dispose();
});

beforeEach(() => {
	remoteHosts = {
		loadHosts: jest.fn().mockResolvedValue([snapshot('box')]),
		getConfigError: jest.fn().mockReturnValue(null),
		getSshAliases: jest.fn().mockResolvedValue([{ alias: 'build-box', hostName: '10.0.0.2', user: 'ubuntu' }, { alias: 'gpu-01', hostName: null, user: null }]),
		saveHost: jest.fn().mockResolvedValue(null),
		removeHost: jest.fn().mockResolvedValue(null)
	};
	(<{ remoteHosts: unknown }>dataSource).remoteHosts = remoteHosts;
	jest.spyOn(dataSource, 'getGitExecutableError').mockReturnValue(null);
	jest.spyOn(repoManager, 'getRepos').mockReturnValue({ '/path/to/repo': mockRepoState() });
	commandManager = new CommandManager(vscode.mocks.extensionContext, avatarManager, dataSource, extensionState, repoManager, { path: '/path/to/git', version: '2.31.0' }, onDidChangeGitExecutable.subscribe, logger);
});

afterEach(() => {
	commandManager.dispose();
});

function snapshot(name: string): RemoteHostSnapshot {
	return { host: { name: name, ssh: name, path: '/srv/' + name, state: 'ok', message: null, lastRefresh: null }, worktrees: [] };
}

describe('git-tree.addRemoteHost', () => {
	it('Should ask for the name, the alias and the path, and add the host', async () => {
		// Setup
		window.showInputBox.mockResolvedValueOnce('gpu').mockResolvedValueOnce('/srv/work/app');
		vscode.window.showQuickPick.mockResolvedValueOnce(<never>{ label: 'gpu-01' });
		vscode.window.showInformationMessage.mockResolvedValueOnce(<never>undefined);

		// Run
		await vscode.commands.executeCommand('git-tree.addRemoteHost');
		await waitFor(() => remoteHosts.saveHost.mock.calls.length > 0 && vscode.window.showInformationMessage.mock.calls.length > 0);

		// Assert
		expect(remoteHosts.saveHost).toHaveBeenCalledWith('/path/to/repo', null, { name: 'gpu', ssh: 'gpu-01', path: '/srv/work/app', worktrees: true, forwardAgent: false });
		expect(vscode.window.showQuickPick).toHaveBeenCalledWith([{ label: 'build-box', description: 'ubuntu@10.0.0.2' }, { label: 'gpu-01', description: undefined }, { label: 'Enter another alias...' }], expect.objectContaining({ placeHolder: 'Select the Host alias from ~/.ssh/config that reaches the server:' }));
		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('The remote host "gpu" was added to .worktrees/git-tree.yaml.');

		// The name must be valid, and new in any case
		const validateName = window.showInputBox.mock.calls[0][0].validateInput;
		expect(validateName('gpu')).toBeNull();
		expect(validateName('BOX')).toBe('The repository already has a host named "BOX".');
		expect(validateName('a b')).toMatch(/may only hold letters/);
		const validatePath = window.showInputBox.mock.calls[1][0].validateInput;
		expect(validatePath('/srv')).toBeNull();
		expect(validatePath('srv')).toMatch(/must be absolute/);
	});

	it('Should ask for an alias that isn\'t in ~/.ssh/config', async () => {
		// Setup
		remoteHosts.getSshAliases.mockResolvedValueOnce([]);
		window.showInputBox.mockResolvedValueOnce('gpu').mockResolvedValueOnce('gpu-02').mockResolvedValueOnce('/srv/app');
		vscode.window.showInformationMessage.mockResolvedValueOnce(<never>undefined);

		// Run
		await vscode.commands.executeCommand('git-tree.addRemoteHost');
		await waitFor(() => remoteHosts.saveHost.mock.calls.length > 0);

		// Assert
		expect(remoteHosts.saveHost).toHaveBeenCalledWith('/path/to/repo', null, { name: 'gpu', ssh: 'gpu-02', path: '/srv/app', worktrees: true, forwardAgent: false });
		expect(window.showInputBox.mock.calls[1][0].validateInput('-oProxyCommand=x')).toMatch(/must be a Host alias/);
	});

	it('Should show why a host wasn\'t added', async () => {
		// Setup
		window.showInputBox.mockResolvedValueOnce('gpu').mockResolvedValueOnce('/srv/app');
		vscode.window.showQuickPick.mockResolvedValueOnce(<never>{ label: 'gpu-01' });
		remoteHosts.saveHost.mockResolvedValueOnce('Git Tree couldn\'t connect to "gpu-01".');
		vscode.window.showErrorMessage.mockResolvedValueOnce(<never>undefined);

		// Run
		await vscode.commands.executeCommand('git-tree.addRemoteHost');
		await waitFor(() => vscode.window.showErrorMessage.mock.calls.length > 0);

		// Assert
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('The remote host "gpu" wasn\'t added: Git Tree couldn\'t connect to "gpu-01".');
	});

	it('Should stop when the user cancels', async () => {
		// Setup
		window.showInputBox.mockResolvedValueOnce(undefined);

		// Run
		await vscode.commands.executeCommand('git-tree.addRemoteHost');
		await waitFor(() => window.showInputBox.mock.calls.length > 0);

		// Assert
		expect(remoteHosts.getSshAliases).not.toHaveBeenCalled();
		expect(remoteHosts.saveHost).not.toHaveBeenCalled();
	});
});

describe('git-tree.removeRemoteHost', () => {
	it('Should remove the host the user picks, after a confirmation', async () => {
		// Setup
		vscode.window.showQuickPick.mockResolvedValueOnce(<never>{ label: 'box', description: 'box:/srv/box' });
		window.showWarningMessage.mockResolvedValueOnce('Remove');
		vscode.window.showInformationMessage.mockResolvedValueOnce(<never>undefined);

		// Run
		await vscode.commands.executeCommand('git-tree.removeRemoteHost');
		await waitFor(() => remoteHosts.removeHost.mock.calls.length > 0);

		// Assert
		expect(window.showWarningMessage).toHaveBeenCalledWith('Remove the remote host "box"?', { modal: true, detail: 'Git Tree removes its entry from .worktrees/git-tree.yaml, and deletes the refs it fetched from it, under refs/git-tree/hosts/box/. Nothing on the server changes.' }, 'Remove');
		expect(remoteHosts.removeHost).toHaveBeenCalledWith('/path/to/repo', 'box');
	});

	it('Should not remove a host the user doesn\'t confirm', async () => {
		// Setup
		vscode.window.showQuickPick.mockResolvedValueOnce(<never>{ label: 'box', description: 'box:/srv/box' });
		window.showWarningMessage.mockResolvedValueOnce(undefined);

		// Run
		await vscode.commands.executeCommand('git-tree.removeRemoteHost');
		await waitFor(() => window.showWarningMessage.mock.calls.length > 0);

		// Assert
		expect(remoteHosts.removeHost).not.toHaveBeenCalled();
	});

	it('Should ask for the file to be fixed first', async () => {
		// Setup
		remoteHosts.getConfigError.mockReturnValue('Line 3: bad');
		vscode.window.showErrorMessage.mockResolvedValueOnce(<never>undefined);

		// Run
		await vscode.commands.executeCommand('git-tree.removeRemoteHost');
		await waitFor(() => vscode.window.showErrorMessage.mock.calls.length > 0);

		// Assert
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Fix .worktrees/git-tree.yaml before removing a host: Line 3: bad');
		expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
	});

	it('Should pick the repository when there are several, the last active first', async () => {
		// Setup
		jest.spyOn(repoManager, 'getRepos').mockReturnValue({ '/path/to/a': mockRepoState(), '/path/to/b': mockRepoState() });
		(<jest.Mock>extensionState.getLastActiveRepo).mockReturnValueOnce('/path/to/b');
		vscode.window.showQuickPick.mockResolvedValueOnce(<never>undefined);

		// Run
		await vscode.commands.executeCommand('git-tree.removeRemoteHost');
		await waitFor(() => vscode.window.showQuickPick.mock.calls.length > 0);

		// Assert
		expect(vscode.window.showQuickPick.mock.calls[0][0]).toStrictEqual([{ label: 'b', description: '/path/to/b' }, { label: 'a', description: '/path/to/a' }]);
		expect(remoteHosts.loadHosts).not.toHaveBeenCalled();
	});
});

async function waitFor(condition: () => boolean) {
	for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 1));
	await new Promise((resolve) => setTimeout(resolve, 5));
}
