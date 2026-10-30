import * as vscode from './mocks/vscode';
jest.mock('vscode', () => vscode, { virtual: true });
jest.mock('../src/avatarManager');
jest.mock('../src/commands');
jest.mock('../src/dataSource');
jest.mock('../src/diffDocProvider');
jest.mock('../src/engine');
jest.mock('../src/extensionState');
jest.mock('../src/logger');
jest.mock('../src/remoteHosts');
jest.mock('../src/repoManager');
jest.mock('../src/statusBarItem');

import { ConfigurationChangeEvent } from 'vscode';
import { DataSource } from '../src/dataSource';
import { Engine, loadEngine } from '../src/engine';
import { ExtensionState } from '../src/extensionState';
import { activate } from '../src/extension';
import { GitTreeView } from '../src/gitTreeView';
import { Logger } from '../src/logger';
import { RepoManager } from '../src/repoManager';
import * as utils from '../src/utils';

const ENGINE_ERROR_MSG = 'This Git Tree installation is missing its engine for linux-x64-gnu. Reinstall Git Tree.';
const OLD_GIT_MSG = 'Git Tree needs Git 2.31.0 or later, but the Git executable it found ("/path/to/old-git") is version 2.30.9. Upgrade Git, or set the Visual Studio Code Setting "git.path" to a newer Git executable, then reload the window.';

const engine = <Engine>{ version: '0.0.0' };
const loadEngineMock = <jest.MockedFunction<typeof loadEngine>>loadEngine;

let spyOnFindGit: jest.SpyInstance, spyOnGetGitExecutableFromPaths: jest.SpyInstance;
beforeEach(() => {
	loadEngineMock.mockReturnValue({ engine: engine });
	spyOnFindGit = jest.spyOn(utils, 'findGit');
	spyOnGetGitExecutableFromPaths = jest.spyOn(utils, 'getGitExecutableFromPaths');
	vscode.window.showErrorMessage.mockResolvedValue(null);
	vscode.window.showInformationMessage.mockResolvedValue(null);
});

afterEach(() => {
	vscode.mocks.extensionContext.subscriptions.splice(0).forEach((disposable) => disposable.dispose());
});

/**
 * Activate Git Tree.
 * @returns The Logger and RepoManager that activation created, and the listener it registered for configuration changes.
 */
async function activateGitTree() {
	await activate(vscode.mocks.extensionContext);
	const loggerMock = <jest.MockedClass<typeof Logger>>Logger;
	const repoManagerMock = <jest.MockedClass<typeof RepoManager>>RepoManager;
	const onDidChangeConfiguration = vscode.workspace.onDidChangeConfiguration.mock.calls[0][0];
	return {
		logger: loggerMock.mock.instances[loggerMock.mock.instances.length - 1],
		repoManager: repoManagerMock.mock.instances[repoManagerMock.mock.instances.length - 1],
		changeGitPath: async (path: string) => {
			vscode.mockExtensionSettingReturnValue('path', path);
			onDidChangeConfiguration(<ConfigurationChangeEvent>{ affectsConfiguration: (section: string) => section === 'git.path' });
			// Activation's handler for the new Git executable runs before this await resumes
			await spyOnGetGitExecutableFromPaths.mock.results[0].value;
		}
	};
}

describe('activate', () => {
	it('Should use a Git executable that is at least Git Tree\'s minimum Git version, without an error message', async () => {
		// Setup
		spyOnFindGit.mockResolvedValueOnce({ path: '/path/to/git', version: '2.31.0' });

		// Run
		const { logger } = await activateGitTree();

		// Assert
		expect(DataSource).toHaveBeenCalledWith({ path: '/path/to/git', version: '2.31.0' }, expect.anything(), expect.anything(), expect.anything(), engine, null, expect.anything());
		expect(logger.log).toHaveBeenCalledWith('Using /path/to/git (version: 2.31.0)');
		expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
		expect(logger.logError).not.toHaveBeenCalled();
	});

	it('Should show the incompatible version message when the Git executable is older than Git Tree\'s minimum Git version', async () => {
		// Setup
		spyOnFindGit.mockResolvedValueOnce({ path: '/path/to/old-git', version: '2.30.9' });

		// Run
		const { logger } = await activateGitTree();

		// Assert
		expect(DataSource).toHaveBeenCalledWith({ path: '/path/to/old-git', version: '2.30.9' }, expect.anything(), expect.anything(), expect.anything(), engine, null, expect.anything());
		expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(OLD_GIT_MSG);
		expect(logger.logError).toHaveBeenCalledWith(OLD_GIT_MSG);
	});

	it('Should show UNABLE_TO_FIND_GIT_MSG when no Git executable is found', async () => {
		// Setup
		spyOnFindGit.mockRejectedValueOnce(undefined);

		// Run
		const { logger } = await activateGitTree();

		// Assert
		expect(DataSource).toHaveBeenCalledWith(null, expect.anything(), expect.anything(), expect.anything(), engine, null, expect.anything());
		expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(utils.UNABLE_TO_FIND_GIT_MSG);
		expect(logger.logError).toHaveBeenCalledWith(utils.UNABLE_TO_FIND_GIT_MSG);
	});

	it('Should show the engine\'s error, and pass it to the DataSource, when the engine can\'t be loaded', async () => {
		// Setup
		loadEngineMock.mockReturnValueOnce({ error: ENGINE_ERROR_MSG });
		spyOnFindGit.mockResolvedValueOnce({ path: '/path/to/git', version: '2.31.0' });

		// Run
		const { logger } = await activateGitTree();

		// Assert
		expect(DataSource).toHaveBeenCalledWith({ path: '/path/to/git', version: '2.31.0' }, expect.anything(), expect.anything(), expect.anything(), null, ENGINE_ERROR_MSG, expect.anything());
		expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(ENGINE_ERROR_MSG);
		expect(logger.logError).toHaveBeenCalledWith(ENGINE_ERROR_MSG);
	});

	describe('Restoring Git Tree View tabs', () => {
		it('Should register a serializer that revives each restored tab', async () => {
			// Setup
			spyOnFindGit.mockResolvedValueOnce({ path: '/path/to/git', version: '2.31.0' });
			const spyOnRevive = jest.spyOn(GitTreeView, 'revive').mockReturnValue(undefined);
			const { logger, repoManager } = await activateGitTree();
			const panel = vscode.window.createWebviewPanel('git-tree', 'Git Tree', vscode.ViewColumn.One);
			const state = { currentRepo: '/path/to/repo' };

			// Run
			const [viewType, serializer] = vscode.window.registerWebviewPanelSerializer.mock.calls[0];
			await serializer.deserializeWebviewPanel(panel, state);

			// Assert
			expect(viewType).toBe('git-tree');
			expect(spyOnRevive).toHaveBeenCalledWith(panel, state, vscode.mocks.extensionContext.extensionPath, expect.any(DataSource), expect.any(ExtensionState), expect.anything(), repoManager, logger);
			spyOnRevive.mockRestore();
		});
	});

	describe('git.path changes', () => {
		it('Should use the new Git executable when it is at least Git Tree\'s minimum Git version', async () => {
			// Setup
			spyOnFindGit.mockResolvedValueOnce({ path: '/path/to/old-git', version: '2.30.9' });
			spyOnGetGitExecutableFromPaths.mockResolvedValueOnce({ path: '/path/to/git', version: '2.31.0' });
			const { logger, repoManager, changeGitPath } = await activateGitTree();
			vscode.window.showErrorMessage.mockClear();

			// Run
			await changeGitPath('/path/to/git');

			// Assert
			expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Git Tree is now using /path/to/git (version: 2.31.0)');
			expect(repoManager.searchWorkspaceForRepos).toHaveBeenCalled();
			expect(spyOnGetGitExecutableFromPaths).toHaveBeenCalledWith(['/path/to/git']);
			expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
			expect(logger.log).toHaveBeenCalledWith('Git Tree is now using /path/to/git (version: 2.31.0)');
		});

		it('Should show the incompatible version message when the new Git executable is older than Git Tree\'s minimum Git version', async () => {
			// Setup
			spyOnFindGit.mockResolvedValueOnce({ path: '/path/to/git', version: '2.31.0' });
			spyOnGetGitExecutableFromPaths.mockResolvedValueOnce({ path: '/path/to/old-git', version: '2.30.9' });
			const { logger, repoManager, changeGitPath } = await activateGitTree();

			// Run
			await changeGitPath('/path/to/old-git');

			// Assert
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(OLD_GIT_MSG);
			expect(logger.logError).toHaveBeenCalledWith(OLD_GIT_MSG);
			expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
			expect(repoManager.searchWorkspaceForRepos).not.toHaveBeenCalled();
		});

		it('Should show the engine\'s error when the engine can\'t be loaded, even if the new Git executable is usable', async () => {
			// Setup
			loadEngineMock.mockReturnValueOnce({ error: ENGINE_ERROR_MSG });
			spyOnFindGit.mockResolvedValueOnce({ path: '/path/to/git', version: '2.31.0' });
			spyOnGetGitExecutableFromPaths.mockResolvedValueOnce({ path: '/path/to/other-git', version: '2.31.0' });
			const { logger, repoManager, changeGitPath } = await activateGitTree();
			vscode.window.showErrorMessage.mockClear();

			// Run
			await changeGitPath('/path/to/other-git');

			// Assert
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(ENGINE_ERROR_MSG);
			expect(logger.logError).toHaveBeenCalledWith(ENGINE_ERROR_MSG);
			expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
			expect(repoManager.searchWorkspaceForRepos).not.toHaveBeenCalled();
		});
	});
});
