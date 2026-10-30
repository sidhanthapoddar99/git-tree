import * as vscode from './mocks/vscode';
jest.mock('vscode', () => vscode, { virtual: true });
jest.mock('../src/avatarManager');
jest.mock('../src/dataSource');
jest.mock('../src/extensionState');
jest.mock('../src/logger');
jest.mock('../src/repoManager');

import * as path from 'path';
import { ConfigurationChangeEvent } from 'vscode';
import { AvatarEvent, AvatarManager } from '../src/avatarManager';
import { encodeCommits, getCommitsToken } from '../src/compactCommits';
import { DataSource } from '../src/dataSource';
import { ExtensionState } from '../src/extensionState';
import { GitTreeView, standardiseCspSource } from '../src/gitTreeView';
import { Logger } from '../src/logger';
import { RemoteHostSnapshot } from '../src/remoteHosts';
import { AGENT_INSTRUCTION } from '../src/remoteHosts/agentInstruction';
import { RepoChangeEvent, RepoManager } from '../src/repoManager';
import { CodeReview, CommitOrdering, GitCommitStash, GitConfigLocation, GitFileStatus, GitPushBranchMode, GitRemoteHostSettings, GitResetMode, GitTreeViewGlobalState, GitTreeViewWorkspaceState, ManagedHostGit, ManagedHostSizes, MergeActionOn, PullRequestConfig, PullRequestProvider, RebaseActionOn, RemoteHostEntry, RequestMessage, ResponseMessage, TagType } from '../src/types';
import * as utils from '../src/utils';
import { EventEmitter } from '../src/utils/event';
import { HostStats } from '../src/hostStats';
import { WorktreeStats, WorktreeStatsAnswer } from '../src/worktreeStats';

import { waitForExpect } from './helpers/expectations';
import { mockRepoState } from './helpers/utils';

describe('GitTreeView', () => {
	let onDidChangeConfiguration: EventEmitter<ConfigurationChangeEvent>;
	let onDidChangeGitExecutable: EventEmitter<utils.GitExecutable>;
	let onDidChangeRepos: EventEmitter<RepoChangeEvent>;
	let onAvatar: EventEmitter<AvatarEvent>;

	let logger: Logger;
	let dataSource: DataSource;
	let extensionState: ExtensionState;
	let avatarManager: AvatarManager;
	let repoManager: RepoManager;

	let spyOnLog: jest.SpyInstance;
	let spyOnLogError: jest.SpyInstance;
	let spyOnGetRepos: jest.SpyInstance;
	let spyOnGetGitExecutableError: jest.SpyInstance;
	let spyOnWriteCommitGraphIfMissing: jest.SpyInstance;

	beforeAll(() => {
		onDidChangeConfiguration = new EventEmitter<ConfigurationChangeEvent>();
		onDidChangeGitExecutable = new EventEmitter<utils.GitExecutable>();
		onDidChangeRepos = new EventEmitter<RepoChangeEvent>();
		onAvatar = new EventEmitter<AvatarEvent>();

		logger = new Logger();
		dataSource = new DataSource({ path: '/path/to/git', version: '2.31.0' }, onDidChangeConfiguration.subscribe, onDidChangeGitExecutable.subscribe, logger);
		extensionState = new ExtensionState(vscode.mocks.extensionContext, onDidChangeGitExecutable.subscribe);
		avatarManager = new AvatarManager(dataSource, extensionState, logger);
		repoManager = new RepoManager(dataSource, extensionState, onDidChangeConfiguration.subscribe, logger);

		spyOnLog = jest.spyOn(logger, 'log');
		spyOnLogError = jest.spyOn(logger, 'logError');
		spyOnGetRepos = jest.spyOn(repoManager, 'getRepos');
		spyOnGetGitExecutableError = jest.spyOn(dataSource, 'getGitExecutableError');

		spyOnGetRepos.mockReturnValue({ '/path/to/repo': mockRepoState() });
		spyOnGetGitExecutableError.mockReturnValue(null);
		spyOnWriteCommitGraphIfMissing = jest.spyOn(dataSource, 'writeCommitGraphIfMissing');
		spyOnWriteCommitGraphIfMissing.mockResolvedValue(null);
		Object.defineProperty(repoManager, 'onDidChangeRepos', {
			get: () => onDidChangeRepos.subscribe
		});
		Object.defineProperty(avatarManager, 'onAvatar', {
			get: () => onAvatar.subscribe
		});
		jest.spyOn(extensionState, 'getLastActiveRepo').mockReturnValue(null);
	});

	afterAll(() => {
		repoManager.dispose();
		avatarManager.dispose();
		extensionState.dispose();
		dataSource.dispose();
		logger.dispose();
		onAvatar.dispose();
		onDidChangeRepos.dispose();
		onDidChangeGitExecutable.dispose();
		onDidChangeConfiguration.dispose();
	});

	afterEach(() => {
		while (GitTreeView.currentPanel) {
			GitTreeView.currentPanel.dispose();
		}
	});

	describe('WebviewPanel Construction', () => {
		it('Should construct a new WebviewPanel', () => {
			// Setup
			vscode.window.activeTextEditor = {
				document: {
					uri: vscode.Uri.file('/path/to/workspace-folder/active-file.txt')
				},
				viewColumn: vscode.ViewColumn.Two
			};

			// Run
			GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);

			// Assert
			expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith('git-tree', 'Git Tree', vscode.ViewColumn.Two, {
				enableScripts: true,
				localResourceRoots: [vscode.Uri.file(path.join('/path/to/extension', 'media'))],
				retainContextWhenHidden: true
			});
			expect(spyOnLog).toHaveBeenCalledWith('Created Git Tree View');
		});

		it('Should reveal the existing WebviewPanel (when one exists)', () => {
			// Setup
			GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);

			// Run
			GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);

			// Assert
			const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
			expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
			expect(mockedWebviewPanel.panel.reveal).toHaveBeenCalledTimes(1);
		});

		it('Should reveal the existing WebviewPanel (when one exists, but it isn\'t visible)', () => {
			// Setup
			GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, { repo: '/path/to/repo' });
			const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
			mockedWebviewPanel.mocks.panel.setVisibility(false);

			// Run
			GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, { repo: '/path/to/repo' });

			// Assert
			expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
			expect(mockedWebviewPanel.panel.reveal).toHaveBeenCalledTimes(1);
			expect(mockedWebviewPanel.mocks.messages).toStrictEqual([]);
		});

		it('Should reveal the existing WebviewPanel (when one exists), and send loadViewTo', () => {
			// Setup
			GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);

			// Run
			GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, { repo: '/path/to/repo' });

			// Assert
			const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
			expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
			expect(mockedWebviewPanel.panel.reveal).toHaveBeenCalledTimes(1);
			expect(mockedWebviewPanel.mocks.messages).toStrictEqual([
				{
					command: 'loadRepos',
					lastActiveRepo: null,
					loadViewTo: { repo: '/path/to/repo' },
					repos: {
						'/path/to/repo': mockRepoState()
					}
				}
			]);
		});

		describe('Multiple tabs', () => {
			it('Should open a repository in a new tab when the open tab shows a different repository', () => {
				// Setup
				GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, { repo: '/path/to/repo1' });

				// Run
				GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, { repo: '/path/to/repo2' });

				// Assert
				expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(2);
				expect(vscode.getMockedWebviewPanel(0).panel.reveal).not.toHaveBeenCalled();
				expect(vscode.getMockedWebviewPanel(1).panel.webview.html).toContain('"loadViewTo":{"repo":"/path/to/repo2"}');
				expect(GitTreeView.currentPanel!['panel']).toBe(vscode.getMockedWebviewPanel(1).panel);
			});

			it('Should reveal the tab that already shows the repository', () => {
				// Setup
				GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, { repo: '/path/to/repo1' });
				GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, { repo: '/path/to/repo2' });

				// Run
				GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, { repo: '/path/to/repo1' });

				// Assert
				expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(2);
				expect(vscode.getMockedWebviewPanel(0).panel.reveal).toHaveBeenCalledTimes(1);
				expect(vscode.getMockedWebviewPanel(1).panel.reveal).not.toHaveBeenCalled();
			});

			it('Should reveal the most recently active tab when no repository is requested', () => {
				// Setup
				GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, { repo: '/path/to/repo1' });
				GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, { repo: '/path/to/repo2' });
				vscode.getMockedWebviewPanel(0).mocks.panel.onDidChangeViewState({ webviewPanel: vscode.getMockedWebviewPanel(0).panel });

				// Run
				GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);

				// Assert
				expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(2);
				expect(vscode.getMockedWebviewPanel(0).panel.reveal).toHaveBeenCalledTimes(1);
			});

			it('Should always open a new tab when asked to', () => {
				// Setup
				GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, { repo: '/path/to/repo' });

				// Run
				GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, { repo: '/path/to/repo' }, true);

				// Assert
				expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(2);
				expect(vscode.getMockedWebviewPanel(0).panel.reveal).not.toHaveBeenCalled();
			});

			it('Should forget a tab when it is closed, and keep the others', () => {
				// Setup
				GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, { repo: '/path/to/repo1' });
				GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, { repo: '/path/to/repo2' });

				// Run
				vscode.getMockedWebviewPanel(1).mocks.panel.onDidDispose();

				// Assert
				expect(GitTreeView.currentPanel!['panel']).toBe(vscode.getMockedWebviewPanel(0).panel);
				GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, { repo: '/path/to/repo2' });
				expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(3);
			});
		});

		describe('Restored tabs', () => {
			/**
			 * Make the Webview Panel that Visual Studio Code restores, and revive it.
			 * @param state The state its webview saved.
			 * @returns The mocked Webview Panel.
			 */
			const reviveTab = (state: unknown) => {
				const panel = vscode.window.createWebviewPanel('git-tree', 'Git Tree', vscode.ViewColumn.Three);
				vscode.window.createWebviewPanel.mockClear();
				GitTreeView.revive(panel, state, '/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger);
				return vscode.getMockedWebviewPanel(0);
			};

			it('Should take over the restored panel, instead of opening another', () => {
				// Run
				const mockedWebviewPanel = reviveTab({ currentRepo: '/path/to/repo' });

				// Assert
				expect(vscode.window.createWebviewPanel).not.toHaveBeenCalled();
				expect(mockedWebviewPanel.panel.webview.options).toStrictEqual({
					enableScripts: true,
					localResourceRoots: [vscode.Uri.file(path.join('/path/to/extension', 'media'))]
				});
				expect(mockedWebviewPanel.panel.webview.html).toContain('"loadViewTo":null');
				expect(GitTreeView.currentPanel!['panel']).toBe(mockedWebviewPanel.panel);
				expect(GitTreeView.currentPanel!['retainContextWhenHidden']).toBe(false);
			});

			it('Should keep the restored panel\'s retainContextWhenHidden', () => {
				// Setup
				const panel = vscode.window.createWebviewPanel('git-tree', 'Git Tree', vscode.ViewColumn.Three);
				Object.assign(panel, { options: { retainContextWhenHidden: true } });

				// Run
				GitTreeView.revive(panel, undefined, '/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger);

				// Assert
				expect(GitTreeView.currentPanel!['retainContextWhenHidden']).toBe(true);
			});

			it('Should reveal the restored tab for the repository it showed', () => {
				// Setup
				const mockedWebviewPanel = reviveTab({ currentRepo: '/path/to/repo' });

				// Run
				GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, { repo: '/path/to/repo' });

				// Assert
				expect(vscode.window.createWebviewPanel).not.toHaveBeenCalled();
				expect(mockedWebviewPanel.panel.reveal).toHaveBeenCalledTimes(1);
			});

			it('Should treat a restored tab without a saved repository as showing none', () => {
				// Setup
				reviveTab({ currentRepo: 5 });

				// Assert
				expect(GitTreeView.currentPanel!['shownRepo']).toBe(null);
			});

			it('Should treat a restored tab without saved state as showing none', () => {
				// Setup
				reviveTab(undefined);

				// Assert
				expect(GitTreeView.currentPanel!['shownRepo']).toBe(null);
			});
		});

		it('Should construct a new WebviewPanel, providing loadViewTo', () => {
			// Run
			GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, { repo: '/path/to/repo' });

			// Assert
			const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
			expect(spyOnLog).toHaveBeenCalledWith('Created Git Tree View (active repo: /path/to/repo)');
			expect(mockedWebviewPanel.panel.webview.html).toContain('"loadViewTo":{"repo":"/path/to/repo"}');
		});

		it('Should construct a new WebviewPanel (no active text editor)', () => {
			// Setup
			vscode.window.activeTextEditor = undefined;

			// Run
			GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);

			// Assert
			expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith('git-tree', 'Git Tree', vscode.ViewColumn.One, {
				enableScripts: true,
				localResourceRoots: [vscode.Uri.file(path.join('/path/to/extension', 'media'))],
				retainContextWhenHidden: true
			});
			expect(spyOnLog).toHaveBeenCalledWith('Created Git Tree View');
		});

		it('Should construct a WebviewPanel with retainContextWhenHidden set to TRUE', () => {
			// Setup
			vscode.mockExtensionSettingReturnValue('retainContextWhenHidden', true);

			// Run
			GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);

			// Assert
			expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith('git-tree', 'Git Tree', vscode.ViewColumn.One, {
				enableScripts: true,
				localResourceRoots: [vscode.Uri.file(path.join('/path/to/extension', 'media'))],
				retainContextWhenHidden: true
			});
			expect(spyOnLog).toHaveBeenCalledWith('Created Git Tree View');
		});

		it('Should construct a WebviewPanel with retainContextWhenHidden set to FALSE', () => {
			// Setup
			vscode.mockExtensionSettingReturnValue('retainContextWhenHidden', false);

			// Run
			GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);

			// Assert
			expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith('git-tree', 'Git Tree', vscode.ViewColumn.One, {
				enableScripts: true,
				localResourceRoots: [vscode.Uri.file(path.join('/path/to/extension', 'media'))],
				retainContextWhenHidden: false
			});
			expect(spyOnLog).toHaveBeenCalledWith('Created Git Tree View');
		});

		it('Should construct a WebviewPanel with a colour icon', () => {
			// Setup
			vscode.mockExtensionSettingReturnValue('tabIconColourTheme', 'colour');

			// Run
			GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);

			// Assert
			const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
			expect(mockedWebviewPanel.panel.iconPath).toStrictEqual(vscode.Uri.file(path.join('/path/to/extension', 'resources', 'webview-icon.svg')));
		});

		it('Should construct a WebviewPanel with a grey icon', () => {
			// Setup
			vscode.mockExtensionSettingReturnValue('tabIconColourTheme', 'grey');

			// Run
			GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);

			// Assert
			const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
			expect(mockedWebviewPanel.panel.iconPath).toStrictEqual({
				light: vscode.Uri.file(path.join('/path/to/extension', 'resources', 'webview-icon-light.svg')),
				dark: vscode.Uri.file(path.join('/path/to/extension', 'resources', 'webview-icon-dark.svg'))
			});
		});

		describe('WebviewPanel.onDidDispose', () => {
			it('Should dispose the GitTreeView when the WebviewPanel is disposed', () => {
				// Setup
				GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);

				// Run
				const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
				mockedWebviewPanel.mocks.panel.onDidDispose();

				// Asset
				expect(GitTreeView.currentPanel).toBeUndefined();
			});
		});

		describe('WebviewPanel.onDidChangeViewState', () => {
			it('Should transition from visible to not-visible correctly', () => {
				// Setup
				GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);
				const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
				const spyOnRepoFileWatcherStop = jest.spyOn(GitTreeView.currentPanel!['repoFileWatcher'], 'stop');

				// Run
				mockedWebviewPanel.mocks.panel.setVisibility(false);

				// Assert
				expect(GitTreeView.currentPanel!['currentRepo']).toBeNull();
				expect(spyOnRepoFileWatcherStop).toHaveBeenCalledTimes(1);
				expect(GitTreeView.currentPanel!['isPanelVisible']).toBe(false);
			});

			it('Should transition from not-visible to visible correctly, refreshing the page that was kept alive', () => {
				// Setup
				GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);
				const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
				mockedWebviewPanel.mocks.panel.setVisibility(false);
				GitTreeView.currentPanel!['panel']['webview'].html = '';

				// Run
				mockedWebviewPanel.mocks.panel.setVisibility(true);

				// Assert
				expect(mockedWebviewPanel.panel.webview.html).toBe('');
				expect(mockedWebviewPanel.mocks.messages).toStrictEqual([{ command: 'refresh' }]);
				expect(GitTreeView.currentPanel!['isPanelVisible']).toBe(true);
			});

			it('Should send the pending loadViewTo to the page that was kept alive', () => {
				// Setup
				GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);
				const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
				mockedWebviewPanel.mocks.panel.setVisibility(false);
				GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, { repo: '/path/to/repo' });
				GitTreeView.currentPanel!['panel']['webview'].html = '';

				// Run
				mockedWebviewPanel.mocks.panel.setVisibility(true);

				// Assert
				expect(mockedWebviewPanel.panel.webview.html).toBe('');
				expect(mockedWebviewPanel.mocks.messages).toStrictEqual([
					{
						command: 'loadRepos',
						lastActiveRepo: null,
						loadViewTo: { repo: '/path/to/repo' },
						repos: {
							'/path/to/repo': mockRepoState()
						}
					}
				]);
				expect(GitTreeView.currentPanel!['loadViewTo']).toBe(null);
			});

			it('Should rebuild the page when it is shown, if a setting changed while it was hidden', () => {
				// Setup
				GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);
				const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
				mockedWebviewPanel.mocks.panel.setVisibility(false);
				GitTreeView.currentPanel!['panel']['webview'].html = '';
				vscode.mockExtensionSettingReturnValue('repository.showTags', false);

				// Run
				mockedWebviewPanel.mocks.panel.setVisibility(true);

				// Assert
				expect(mockedWebviewPanel.panel.webview.html).toContain('"showTags":false');
				expect(mockedWebviewPanel.mocks.messages).toStrictEqual([]);
			});

			it('Should rebuild the page when it is shown, if the repositories changed while it was hidden', () => {
				// Setup
				GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);
				const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
				mockedWebviewPanel.mocks.panel.setVisibility(false);
				onDidChangeRepos.emit({
					repos: { '/path/to/repo': mockRepoState() },
					numRepos: 1,
					loadRepo: null
				});
				GitTreeView.currentPanel!['panel']['webview'].html = '';

				// Run
				mockedWebviewPanel.mocks.panel.setVisibility(true);

				// Assert
				expect(mockedWebviewPanel.panel.webview.html).not.toBe('');
				expect(mockedWebviewPanel.mocks.messages).toStrictEqual([]);
			});

			it('Should rebuild the page when it is shown, if it wasn\'t kept alive', () => {
				// Setup
				vscode.mockExtensionSettingReturnValue('retainContextWhenHidden', false);
				GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);
				const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
				mockedWebviewPanel.mocks.panel.setVisibility(false);
				GitTreeView.currentPanel!['panel']['webview'].html = '';

				// Run
				mockedWebviewPanel.mocks.panel.setVisibility(true);

				// Assert
				expect(mockedWebviewPanel.panel.webview.html).not.toBe('');
			});

			it('Should ignore events if they have no effect', () => {
				// Setup
				GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);
				const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
				GitTreeView.currentPanel!['panel']['webview'].html = '';

				// Run
				mockedWebviewPanel.mocks.panel.setVisibility(true);

				// Assert
				expect(mockedWebviewPanel.panel.webview.html).toBe('');
				expect(GitTreeView.currentPanel!['isPanelVisible']).toBe(true);
			});
		});

		describe('RepoManager.onDidChangeRepos', () => {
			it('Should send the updated repositories to the front-end when the view is already loaded', () => {
				// Setup
				GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);

				// Run
				onDidChangeRepos.emit({
					repos: { '/path/to/repo': mockRepoState() },
					numRepos: 1,
					loadRepo: null
				});

				// Assert
				const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
				expect(mockedWebviewPanel.mocks.messages).toStrictEqual([
					{
						command: 'loadRepos',
						lastActiveRepo: null,
						loadViewTo: null,
						repos: {
							'/path/to/repo': mockRepoState()
						}
					}
				]);
			});

			it('Should send the updated repositories to the front-end when the view is already loaded (with loadViewTo)', () => {
				// Setup
				GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);

				// Run
				onDidChangeRepos.emit({
					repos: { '/path/to/repo': mockRepoState() },
					numRepos: 1,
					loadRepo: '/path/to/repo'
				});

				// Assert
				const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
				expect(mockedWebviewPanel.mocks.messages).toStrictEqual([
					{
						command: 'loadRepos',
						lastActiveRepo: null,
						loadViewTo: {
							repo: '/path/to/repo'
						},
						repos: {
							'/path/to/repo': mockRepoState()
						}
					}
				]);
			});

			it('Shouldn\'t send the updated repositories to the front-end when the view is not visible', () => {
				// Setup
				GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);
				const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
				mockedWebviewPanel.mocks.panel.setVisibility(false);

				// Run
				onDidChangeRepos.emit({
					repos: { '/path/to/repo': mockRepoState() },
					numRepos: 1,
					loadRepo: null
				});

				// Assert
				expect(mockedWebviewPanel.mocks.messages).toHaveLength(0);
			});

			it('Should transition to no repositories correctly', () => {
				// Setup
				GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);
				spyOnGetRepos.mockReturnValueOnce({});

				// Run
				onDidChangeRepos.emit({
					repos: {},
					numRepos: 0,
					loadRepo: null
				});

				// Assert
				const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
				expect(mockedWebviewPanel.mocks.messages).toHaveLength(0);
				expect(mockedWebviewPanel.panel.webview.html).toContain('No Git repositories were found');
			});

			it('Should transition from no repositories correctly', () => {
				// Setup
				spyOnGetRepos.mockReturnValueOnce({});
				GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);

				// Run
				onDidChangeRepos.emit({
					repos: {
						'/path/to/repo': mockRepoState()
					},
					numRepos: 1,
					loadRepo: '/path/to/repo'
				});

				// Assert
				const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
				expect(mockedWebviewPanel.mocks.messages).toHaveLength(0);
				expect(mockedWebviewPanel.panel.webview.html).toContain('"loadViewTo":{"repo":"/path/to/repo"}');
			});
		});

		describe('AvatarManager.onAvatar', () => {
			it('Should send the avatar', () => {
				// Setup
				GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);

				// Run
				onAvatar.emit({
					email: 'user1@example.com',
					image: 'data:image/png;base64,YmluYXJ5LWltYWdlLWRhdGE='
				});

				// Assert
				const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
				expect(mockedWebviewPanel.mocks.messages).toStrictEqual([
					{
						command: 'fetchAvatar',
						email: 'user1@example.com',
						image: 'data:image/png;base64,YmluYXJ5LWltYWdlLWRhdGE='
					}
				]);
			});
		});

		describe('RepoFileWatcher.repoChangeCallback', () => {
			it('Should refresh the view when it\'s visible', () => {
				// Setup
				GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);

				// Run
				GitTreeView.currentPanel!['repoFileWatcher']['repoChangeCallback']();

				// Assert
				const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
				expect(mockedWebviewPanel.mocks.messages).toStrictEqual([
					{
						command: 'refresh'
					}
				]);
			});

			it('Shouldn\'t refresh the view when it isn\'t visible', () => {
				// Setup
				GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);
				const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
				mockedWebviewPanel.mocks.panel.setVisibility(false);

				// Run
				GitTreeView.currentPanel!['repoFileWatcher']['repoChangeCallback']();

				// Assert
				expect(mockedWebviewPanel.mocks.messages).toHaveLength(0);
			});
		});
	});

	describe('respondToMessage', () => {
		let onDidReceiveMessage: (msg: RequestMessage) => void;
		let messages: ResponseMessage[];

		let spyOnRepoFileWatcherMute: jest.SpyInstance;
		let spyOnRepoFileWatcherUnmute: jest.SpyInstance;
		beforeEach(() => {
			GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);
			const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);

			onDidReceiveMessage = mockedWebviewPanel.mocks.panel.webview.onDidReceiveMessage;
			messages = mockedWebviewPanel.mocks.messages;

			spyOnRepoFileWatcherMute = jest.spyOn(GitTreeView.currentPanel!['repoFileWatcher'], 'mute');
			spyOnRepoFileWatcherUnmute = jest.spyOn(GitTreeView.currentPanel!['repoFileWatcher'], 'unmute');
		});

		afterEach(() => {
			expect(spyOnRepoFileWatcherMute).toHaveBeenCalledWith();
			expect(spyOnRepoFileWatcherUnmute).toHaveBeenCalledWith();
		});

		describe('addRemote', () => {
			it('Should add a remote', async () => {
				// Setup
				const addRemoteResolvedValue = null;
				const spyOnAddRemote = jest.spyOn(dataSource, 'addRemote');
				spyOnAddRemote.mockResolvedValueOnce(addRemoteResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'addRemote',
					repo: '/path/to/repo',
					name: 'origin',
					url: 'url',
					pushUrl: 'pushUrl',
					fetch: true
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnAddRemote).toHaveBeenCalledWith('/path/to/repo', 'origin', 'url', 'pushUrl', true);
					expect(messages).toStrictEqual([
						{
							command: 'addRemote',
							error: addRemoteResolvedValue
						}
					]);
				});
			});
		});

		describe('addTag', () => {
			it('Should add a tag', async () => {
				// Setup
				const addTagResolvedValue = null;
				const spyOnAddTag = jest.spyOn(dataSource, 'addTag');
				const spyOnPushTag = jest.spyOn(dataSource, 'pushTag');
				spyOnAddTag.mockResolvedValueOnce(addTagResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'addTag',
					repo: '/path/to/repo',
					commitHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					tagName: 'name',
					type: TagType.Annotated,
					message: 'message',
					pushToRemote: null,
					pushSkipRemoteCheck: true,
					force: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnAddTag).toHaveBeenCalledWith('/path/to/repo', 'name', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', TagType.Annotated, 'message', false);
					expect(spyOnPushTag).not.toHaveBeenCalled();
					expect(messages).toStrictEqual([
						{
							command: 'addTag',
							repo: '/path/to/repo',
							tagName: 'name',
							pushToRemote: null,
							commitHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
							errors: [addTagResolvedValue]
						}
					]);
				});
			});

			it('Should add a tag, and then push the tag to a remote', async () => {
				// Setup
				const addTagResolvedValue = null;
				const spyOnPushTagResolvedValue = [null];
				const spyOnAddTag = jest.spyOn(dataSource, 'addTag');
				const spyOnPushTag = jest.spyOn(dataSource, 'pushTag');
				spyOnAddTag.mockResolvedValueOnce(addTagResolvedValue);
				spyOnPushTag.mockResolvedValueOnce(spyOnPushTagResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'addTag',
					repo: '/path/to/repo',
					commitHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					tagName: 'name',
					type: TagType.Annotated,
					message: 'message',
					pushToRemote: 'origin',
					pushSkipRemoteCheck: true,
					force: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnAddTag).toHaveBeenCalledWith('/path/to/repo', 'name', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', TagType.Annotated, 'message', false);
					expect(spyOnPushTag).toHaveBeenCalledWith('/path/to/repo', 'name', ['origin'], '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', true);
					expect(messages).toStrictEqual([
						{
							command: 'addTag',
							repo: '/path/to/repo',
							tagName: 'name',
							pushToRemote: 'origin',
							commitHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
							errors: [addTagResolvedValue, spyOnPushTagResolvedValue[0]]
						}
					]);
				});
			});

			it('Shouldn\'t push the tag if an error occurred when adding the tag', async () => {
				// Setup
				const addTagResolvedValue = 'error message';
				const spyOnAddTag = jest.spyOn(dataSource, 'addTag');
				const spyOnPushTag = jest.spyOn(dataSource, 'pushTag');
				spyOnAddTag.mockResolvedValueOnce(addTagResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'addTag',
					repo: '/path/to/repo',
					commitHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					tagName: 'name',
					type: TagType.Annotated,
					message: 'message',
					pushToRemote: 'origin',
					pushSkipRemoteCheck: true,
					force: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnAddTag).toHaveBeenCalledWith('/path/to/repo', 'name', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', TagType.Annotated, 'message', false);
					expect(spyOnPushTag).not.toHaveBeenCalled();
					expect(messages).toStrictEqual([
						{
							command: 'addTag',
							repo: '/path/to/repo',
							tagName: 'name',
							pushToRemote: 'origin',
							commitHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
							errors: [addTagResolvedValue]
						}
					]);
				});
			});
		});

		describe('applyStash', () => {
			it('Should apply a stash', async () => {
				// Setup
				const applyStashResolvedValue = null;
				const spyOnApplyStash = jest.spyOn(dataSource, 'applyStash');
				spyOnApplyStash.mockResolvedValueOnce(applyStashResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'applyStash',
					repo: '/path/to/repo',
					selector: 'refs/stash@{0}',
					reinstateIndex: true
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnApplyStash).toHaveBeenCalledWith('/path/to/repo', 'refs/stash@{0}', true);
					expect(messages).toStrictEqual([
						{
							command: 'applyStash',
							error: applyStashResolvedValue
						}
					]);
				});
			});
		});

		describe('branchFromStash', () => {
			it('Should create a branch from a stash', async () => {
				// Setup
				const branchFromStashResolvedValue = null;
				const spyOnBranchFromStash = jest.spyOn(dataSource, 'branchFromStash');
				spyOnBranchFromStash.mockResolvedValueOnce(branchFromStashResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'branchFromStash',
					repo: '/path/to/repo',
					selector: 'refs/stash@{0}',
					branchName: 'new-branch'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnBranchFromStash).toHaveBeenCalledWith('/path/to/repo', 'refs/stash@{0}', 'new-branch');
					expect(messages).toStrictEqual([
						{
							command: 'branchFromStash',
							error: branchFromStashResolvedValue
						}
					]);
				});
			});
		});

		describe('checkoutBranch', () => {
			it('Should check out a branch', async () => {
				// Setup
				const checkoutBranchResolvedValue = null;
				const spyOnCheckoutBranch = jest.spyOn(dataSource, 'checkoutBranch');
				const spyOnPullBranch = jest.spyOn(dataSource, 'pullBranch');
				spyOnCheckoutBranch.mockResolvedValueOnce(checkoutBranchResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'checkoutBranch',
					repo: '/path/to/repo',
					branchName: 'develop',
					remoteBranch: 'origin/develop',
					pullAfterwards: null
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnCheckoutBranch).toHaveBeenCalledWith('/path/to/repo', 'develop', 'origin/develop');
					expect(spyOnPullBranch).not.toHaveBeenCalled();
					expect(messages).toStrictEqual([
						{
							command: 'checkoutBranch',
							pullAfterwards: null,
							errors: [checkoutBranchResolvedValue]
						}
					]);
				});
			});

			it('Should check out a branch, and then pull the branch from a remote', async () => {
				// Setup
				const checkoutBranchResolvedValue = null;
				const pullBranchResolvedValue = null;
				const spyOnCheckoutBranch = jest.spyOn(dataSource, 'checkoutBranch');
				const spyOnPullBranch = jest.spyOn(dataSource, 'pullBranch');
				spyOnCheckoutBranch.mockResolvedValueOnce(checkoutBranchResolvedValue);
				spyOnPullBranch.mockResolvedValueOnce(pullBranchResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'checkoutBranch',
					repo: '/path/to/repo',
					branchName: 'develop',
					remoteBranch: null,
					pullAfterwards: {
						branchName: 'develop',
						remote: 'origin',
						createNewCommit: true,
						squash: false
					}
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnCheckoutBranch).toHaveBeenCalledWith('/path/to/repo', 'develop', null);
					expect(spyOnPullBranch).toHaveBeenCalledWith('/path/to/repo', 'develop', 'origin', true, false);
					expect(messages).toStrictEqual([
						{
							command: 'checkoutBranch',
							pullAfterwards: {
								branchName: 'develop',
								remote: 'origin',
								createNewCommit: true,
								squash: false
							},
							errors: [checkoutBranchResolvedValue, pullBranchResolvedValue]
						}
					]);
				});
			});

			it('Shouldn\'t pull the branch if an error occurred when checking out the branch', async () => {
				// Setup
				const checkoutBranchResolvedValue = 'error message';
				const spyOnCheckoutBranch = jest.spyOn(dataSource, 'checkoutBranch');
				const spyOnPullBranch = jest.spyOn(dataSource, 'pullBranch');
				spyOnCheckoutBranch.mockResolvedValueOnce(checkoutBranchResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'checkoutBranch',
					repo: '/path/to/repo',
					branchName: 'develop',
					remoteBranch: null,
					pullAfterwards: {
						branchName: 'develop',
						remote: 'origin',
						createNewCommit: true,
						squash: false
					}
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnCheckoutBranch).toHaveBeenCalledWith('/path/to/repo', 'develop', null);
					expect(spyOnPullBranch).not.toHaveBeenCalled();
					expect(messages).toStrictEqual([
						{
							command: 'checkoutBranch',
							pullAfterwards: {
								branchName: 'develop',
								remote: 'origin',
								createNewCommit: true,
								squash: false
							},
							errors: [checkoutBranchResolvedValue]
						}
					]);
				});
			});
		});

		describe('checkoutCommit', () => {
			it('Should check out a commit', async () => {
				// Setup
				const checkoutCommitResolvedValue = null;
				const spyOnCheckoutCommit = jest.spyOn(dataSource, 'checkoutCommit');
				spyOnCheckoutCommit.mockResolvedValueOnce(checkoutCommitResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'checkoutCommit',
					repo: '/path/to/repo',
					commitHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnCheckoutCommit).toHaveBeenCalledWith('/path/to/repo', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b');
					expect(messages).toStrictEqual([
						{
							command: 'checkoutCommit',
							error: checkoutCommitResolvedValue
						}
					]);
				});
			});
		});

		describe('cherrypickCommit', () => {
			it('Should cherrypick a commit', async () => {
				// Setup
				const cherrypickCommitResolvedValue = null;
				const spyOnCherrypickCommit = jest.spyOn(dataSource, 'cherrypickCommit');
				const spyOnViewScm = jest.spyOn(utils, 'viewScm');
				spyOnCherrypickCommit.mockResolvedValueOnce(cherrypickCommitResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'cherrypickCommit',
					repo: '/path/to/repo',
					commitHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					parentIndex: 1,
					recordOrigin: true,
					noCommit: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnCherrypickCommit).toHaveBeenCalledWith('/path/to/repo', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', 1, true, false);
					expect(spyOnViewScm).not.toHaveBeenCalled();
					expect(messages).toStrictEqual([
						{
							command: 'cherrypickCommit',
							errors: [cherrypickCommitResolvedValue]
						}
					]);
				});
			});

			it('Should cherrypick a commit, and then open the Visual Studio Code Source Control View', async () => {
				// Setup
				const cherrypickCommitResolvedValue = null;
				const viewScmResolvedValue = null;
				const spyOnCherrypickCommit = jest.spyOn(dataSource, 'cherrypickCommit');
				const spyOnViewScm = jest.spyOn(utils, 'viewScm');
				spyOnCherrypickCommit.mockResolvedValueOnce(cherrypickCommitResolvedValue);
				spyOnViewScm.mockResolvedValueOnce(viewScmResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'cherrypickCommit',
					repo: '/path/to/repo',
					commitHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					parentIndex: 1,
					recordOrigin: false,
					noCommit: true
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnCherrypickCommit).toHaveBeenCalledWith('/path/to/repo', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', 1, false, true);
					expect(spyOnViewScm).toHaveBeenCalledWith();
					expect(messages).toStrictEqual([
						{
							command: 'cherrypickCommit',
							errors: [cherrypickCommitResolvedValue, viewScmResolvedValue]
						}
					]);
				});
			});

			it('Shouldn\'t open the Visual Studio Code Source Control View if an error occurred when cherrypicking the commit', async () => {
				// Setup
				const cherrypickCommitResolvedValue = 'error message';
				const spyOnCherrypickCommit = jest.spyOn(dataSource, 'cherrypickCommit');
				const spyOnViewScm = jest.spyOn(utils, 'viewScm');
				spyOnCherrypickCommit.mockResolvedValueOnce(cherrypickCommitResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'cherrypickCommit',
					repo: '/path/to/repo',
					commitHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					parentIndex: 1,
					recordOrigin: false,
					noCommit: true
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnCherrypickCommit).toHaveBeenCalledWith('/path/to/repo', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', 1, false, true);
					expect(spyOnViewScm).not.toHaveBeenCalled();
					expect(messages).toStrictEqual([
						{
							command: 'cherrypickCommit',
							errors: [cherrypickCommitResolvedValue]
						}
					]);
				});
			});
		});

		describe('cleanUntrackedFiles', () => {
			it('Should clean the untracked files', async () => {
				// Setup
				const cleanUntrackedFilesResolvedValue = null;
				const spyOnCleanUntrackedFiles = jest.spyOn(dataSource, 'cleanUntrackedFiles');
				spyOnCleanUntrackedFiles.mockResolvedValueOnce(cleanUntrackedFilesResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'cleanUntrackedFiles',
					repo: '/path/to/repo',
					directories: true
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnCleanUntrackedFiles).toHaveBeenCalledWith('/path/to/repo', true);
					expect(messages).toStrictEqual([
						{
							command: 'cleanUntrackedFiles',
							error: cleanUntrackedFilesResolvedValue
						}
					]);
				});
			});
		});

		describe('commitDetails', () => {
			it('Should get the data for the Commit Details View', async () => {
				// Setup
				const getCommitDetailsResolvedValue = { commitDetails: null, error: null };
				const getAvatarImageResolvedValue = 'data:image/png;base64,YmluYXJ5LWltYWdlLWRhdGE=';
				const getCodeReviewResolvedValue: CodeReview = {
					id: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					lastActive: 1587559258000,
					lastViewedFile: 'file1.txt',
					remainingFiles: ['file2.txt', 'file3.txt']
				};
				const spyOnGetCommitDetails = jest.spyOn(dataSource, 'getCommitDetails');
				const spyOnGetAvatarImage = jest.spyOn(avatarManager, 'getAvatarImage');
				const spyOnGetCodeReview = jest.spyOn(extensionState, 'getCodeReview');
				spyOnGetCommitDetails.mockResolvedValueOnce(getCommitDetailsResolvedValue);
				spyOnGetAvatarImage.mockResolvedValueOnce(getAvatarImageResolvedValue);
				spyOnGetCodeReview.mockReturnValueOnce(getCodeReviewResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'commitDetails',
					repo: '/path/to/repo',
					commitHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					hasParents: true,
					stash: null,
					avatarEmail: 'user@example.com',
					refresh: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnGetCommitDetails).toHaveBeenCalledWith('/path/to/repo', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', true);
					expect(spyOnGetAvatarImage).toHaveBeenCalledWith('user@example.com');
					expect(spyOnGetCodeReview).toHaveBeenCalledWith('/path/to/repo', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b');
					expect(messages).toStrictEqual([
						{
							command: 'commitDetails',
							repo: '/path/to/repo',
							commitDetails: null,
							avatar: getAvatarImageResolvedValue,
							codeReview: getCodeReviewResolvedValue,
							refresh: false,
							error: null
						}
					]);
				});
			});

			it('Should get the data for the Commit Details View (Uncommitted Changes)', async () => {
				// Setup
				const getUncommittedDetailsResolvedValue = { commitDetails: null, error: null };
				const spyOnGetUncommittedDetails = jest.spyOn(dataSource, 'getUncommittedDetails');
				const spyOnGetAvatarImage = jest.spyOn(avatarManager, 'getAvatarImage');
				const spyOnGetCodeReview = jest.spyOn(extensionState, 'getCodeReview');
				spyOnGetUncommittedDetails.mockResolvedValueOnce(getUncommittedDetailsResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'commitDetails',
					repo: '/path/to/repo',
					commitHash: utils.UNCOMMITTED,
					hasParents: true,
					stash: null,
					avatarEmail: null,
					refresh: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnGetUncommittedDetails).toHaveBeenCalledWith('/path/to/repo');
					expect(spyOnGetAvatarImage).not.toHaveBeenCalled();
					expect(spyOnGetCodeReview).not.toHaveBeenCalled();
					expect(messages).toStrictEqual([
						{
							command: 'commitDetails',
							repo: '/path/to/repo',
							commitDetails: null,
							avatar: null,
							codeReview: null,
							refresh: false,
							error: null
						}
					]);
				});
			});

			it('Should get the data for the Commit Details View (Stash)', async () => {
				// Setup
				const stash: GitCommitStash = {
					selector: 'refs/stash@{0}',
					baseHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
					untrackedFilesHash: null
				};
				const getStashDetailsResolvedValue = { commitDetails: null, error: null };
				const getCodeReviewResolvedValue = null;
				const spyOnGetStashDetails = jest.spyOn(dataSource, 'getStashDetails');
				const spyOnGetAvatarImage = jest.spyOn(avatarManager, 'getAvatarImage');
				const spyOnGetCodeReview = jest.spyOn(extensionState, 'getCodeReview');
				spyOnGetStashDetails.mockResolvedValueOnce(getStashDetailsResolvedValue);
				spyOnGetCodeReview.mockReturnValueOnce(getCodeReviewResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'commitDetails',
					repo: '/path/to/repo',
					commitHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					hasParents: true,
					stash: stash,
					avatarEmail: null,
					refresh: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnGetStashDetails).toHaveBeenCalledWith('/path/to/repo', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', stash);
					expect(spyOnGetAvatarImage).not.toHaveBeenCalled();
					expect(spyOnGetCodeReview).toHaveBeenCalledWith('/path/to/repo', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b');
					expect(messages).toStrictEqual([
						{
							command: 'commitDetails',
							repo: '/path/to/repo',
							commitDetails: null,
							avatar: null,
							codeReview: getCodeReviewResolvedValue,
							refresh: false,
							error: null
						}
					]);
				});
			});
		});

		describe('compareCommits', () => {
			it('Should get the data for the Commit Details View (Comparison)', async () => {
				// Setup
				const getCommitComparisonResolvedValue = { fileChanges: [], error: null };
				const getCodeReviewResolvedValue: CodeReview = {
					id: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2-1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					lastActive: 1587559258000,
					lastViewedFile: 'file1.txt',
					remainingFiles: ['file2.txt', 'file3.txt']
				};
				const spyOnGetCommitComparison = jest.spyOn(dataSource, 'getCommitComparison');
				const spyOnGetCodeReview = jest.spyOn(extensionState, 'getCodeReview');
				spyOnGetCommitComparison.mockResolvedValueOnce(getCommitComparisonResolvedValue);
				spyOnGetCodeReview.mockReturnValueOnce(getCodeReviewResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'compareCommits',
					repo: '/path/to/repo',
					commitHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					compareWithHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
					fromHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
					toHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					refresh: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnGetCommitComparison).toHaveBeenCalledWith('/path/to/repo', 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b');
					expect(spyOnGetCodeReview).toHaveBeenCalledWith('/path/to/repo', 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2-1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b');
					expect(messages).toStrictEqual([
						{
							command: 'compareCommits',
							commitHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
							compareWithHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
							fileChanges: [],
							codeReview: getCodeReviewResolvedValue,
							refresh: false,
							error: null
						}
					]);
				});
			});

			it('Should get the data for the Commit Details View (Comparison with the Uncommitted Changes)', async () => {
				// Setup
				const getCommitComparisonResolvedValue = { fileChanges: [], error: null };
				const spyOnGetCommitComparison = jest.spyOn(dataSource, 'getCommitComparison');
				const spyOnGetCodeReview = jest.spyOn(extensionState, 'getCodeReview');
				spyOnGetCommitComparison.mockResolvedValueOnce(getCommitComparisonResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'compareCommits',
					repo: '/path/to/repo',
					commitHash: utils.UNCOMMITTED,
					compareWithHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
					fromHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
					toHash: utils.UNCOMMITTED,
					refresh: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnGetCommitComparison).toHaveBeenCalledWith('/path/to/repo', 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2', utils.UNCOMMITTED);
					expect(spyOnGetCodeReview).not.toHaveBeenCalled();
					expect(messages).toStrictEqual([
						{
							command: 'compareCommits',
							commitHash: utils.UNCOMMITTED,
							compareWithHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
							fileChanges: [],
							codeReview: null,
							refresh: false,
							error: null
						}
					]);
				});
			});
		});

		describe('copyFilePath', () => {
			it('Should copy a file path to the clipboard', async () => {
				// Setup
				const copyFilePathToClipboardResolvedValue = null;
				const spyOnCopyFilePathToClipboard = jest.spyOn(utils, 'copyFilePathToClipboard');
				spyOnCopyFilePathToClipboard.mockResolvedValueOnce(copyFilePathToClipboardResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'copyFilePath',
					repo: '/path/to/repo',
					filePath: 'file.txt',
					absolute: true
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnCopyFilePathToClipboard).toHaveBeenCalledWith('/path/to/repo', 'file.txt', true);
					expect(messages).toStrictEqual([
						{
							command: 'copyFilePath',
							error: copyFilePathToClipboardResolvedValue
						}
					]);
				});
			});
		});

		describe('copyToClipboard', () => {
			it('Should copy text to the clipboard', async () => {
				// Setup
				const copyToClipboardResolvedValue = null;
				const spyOnCopyToClipboard = jest.spyOn(utils, 'copyToClipboard');
				spyOnCopyToClipboard.mockResolvedValueOnce(copyToClipboardResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'copyToClipboard',
					type: 'Branch Name',
					data: 'master'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnCopyToClipboard).toHaveBeenCalledWith('master');
					expect(messages).toStrictEqual([
						{
							command: 'copyToClipboard',
							type: 'Branch Name',
							error: copyToClipboardResolvedValue
						}
					]);
				});
			});
		});

		describe('createArchive', () => {
			it('Should create an archive', async () => {
				// Setup
				const archiveResolvedValue = null;
				const spyOnArchive = jest.spyOn(utils, 'archive');
				spyOnArchive.mockResolvedValueOnce(archiveResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'createArchive',
					repo: '/path/to/repo',
					ref: 'master'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnArchive).toHaveBeenCalledWith('/path/to/repo', 'master', dataSource);
					expect(messages).toStrictEqual([
						{
							command: 'createArchive',
							error: archiveResolvedValue
						}
					]);
				});
			});
		});

		describe('createBranch', () => {
			it('Should create a branch', async () => {
				// Setup
				const createBranchResolvedValue = [null];
				const spyOnCreateBranch = jest.spyOn(dataSource, 'createBranch');
				spyOnCreateBranch.mockResolvedValueOnce(createBranchResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'createBranch',
					repo: '/path/to/repo',
					commitHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					branchName: 'feature-1',
					checkout: true,
					force: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnCreateBranch).toHaveBeenCalledWith('/path/to/repo', 'feature-1', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', true, false);
					expect(messages).toStrictEqual([
						{
							command: 'createBranch',
							errors: createBranchResolvedValue
						}
					]);
				});
			});
		});

		describe('createWorktree', () => {
			it('Should create a worktree', async () => {
				// Setup
				const spyOnCreateWorktree = jest.spyOn(dataSource, 'createWorktree');
				spyOnCreateWorktree.mockResolvedValueOnce({ errors: [null, null], path: '/path/to/repo/.worktrees/feature' });
				const spyOnOpenWorktree = jest.spyOn(utils, 'openWorktree');

				// Run
				onDidReceiveMessage({
					command: 'createWorktree',
					repo: '/path/to/repo',
					path: '.worktrees/feature',
					commitish: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					newBranch: 'feature',
					openInNewWindow: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnCreateWorktree).toHaveBeenCalledWith('/path/to/repo', '.worktrees/feature', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', 'feature');
					expect(spyOnOpenWorktree).not.toHaveBeenCalled();
					expect(messages).toStrictEqual([
						{
							command: 'createWorktree',
							errors: [null, null]
						}
					]);
				});
			});

			it('Should create a worktree, and open it in a new window', async () => {
				// Setup
				const spyOnCreateWorktree = jest.spyOn(dataSource, 'createWorktree');
				spyOnCreateWorktree.mockResolvedValueOnce({ errors: [null, null], path: '/path/to/repo/.worktrees/feature' });
				const spyOnOpenWorktree = jest.spyOn(utils, 'openWorktree');
				spyOnOpenWorktree.mockResolvedValueOnce(null);

				// Run
				onDidReceiveMessage({
					command: 'createWorktree',
					repo: '/path/to/repo',
					path: '.worktrees/feature',
					commitish: 'feature',
					newBranch: null,
					openInNewWindow: true
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnOpenWorktree).toHaveBeenCalledWith('/path/to/repo/.worktrees/feature', true);
					expect(messages).toStrictEqual([
						{
							command: 'createWorktree',
							errors: [null, null, null]
						}
					]);
				});
			});

			it('Shouldn\'t open a worktree that wasn\'t created', async () => {
				// Setup
				const spyOnCreateWorktree = jest.spyOn(dataSource, 'createWorktree');
				spyOnCreateWorktree.mockResolvedValueOnce({ errors: ['error message'], path: null });
				const spyOnOpenWorktree = jest.spyOn(utils, 'openWorktree');

				// Run
				onDidReceiveMessage({
					command: 'createWorktree',
					repo: '/path/to/repo',
					path: '.worktrees/feature',
					commitish: 'feature',
					newBranch: null,
					openInNewWindow: true
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnOpenWorktree).not.toHaveBeenCalled();
					expect(messages).toStrictEqual([
						{
							command: 'createWorktree',
							errors: ['error message']
						}
					]);
				});
			});
		});

		describe('createPullRequest', () => {
			it('Should create a pull request', async () => {
				// Setup
				const pullRequestConfig: PullRequestConfig = {
					provider: PullRequestProvider.Bitbucket,
					custom: null,
					hostRootUrl: 'https://bitbucket.org',
					sourceOwner: 'sourceOwner',
					sourceRepo: 'sourceRepo',
					sourceRemote: 'sourceRemote',
					destOwner: 'destOwner',
					destRepo: 'destRepo',
					destBranch: 'destBranch',
					destRemote: 'destRemote',
					destProjectId: 'destProjectId'
				};
				const createPullRequestResolvedValue = null;
				const spyOnPushBranch = jest.spyOn(dataSource, 'pushBranch');
				const spyOnCreatePullRequest = jest.spyOn(utils, 'createPullRequest');
				spyOnCreatePullRequest.mockResolvedValueOnce(createPullRequestResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'createPullRequest',
					repo: '/path/to/repo',
					config: pullRequestConfig,
					sourceRemote: 'origin',
					sourceOwner: 'sourceOwner',
					sourceRepo: 'sourceRepo',
					sourceBranch: 'sourceBranch',
					push: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnPushBranch).not.toHaveBeenCalled();
					expect(spyOnCreatePullRequest).toHaveBeenCalledWith(pullRequestConfig, 'sourceOwner', 'sourceRepo', 'sourceBranch');
					expect(messages).toStrictEqual([
						{
							command: 'createPullRequest',
							push: false,
							errors: [null, createPullRequestResolvedValue]
						}
					]);
				});
			});

			it('Should push the branch, and then create a pull request', async () => {
				// Setup
				const pullRequestConfig: PullRequestConfig = {
					provider: PullRequestProvider.Bitbucket,
					custom: null,
					hostRootUrl: 'https://bitbucket.org',
					sourceOwner: 'sourceOwner',
					sourceRepo: 'sourceRepo',
					sourceRemote: 'sourceRemote',
					destOwner: 'destOwner',
					destRepo: 'destRepo',
					destBranch: 'destBranch',
					destRemote: 'destRemote',
					destProjectId: 'destProjectId'
				};
				const pushBranchResolvedValue = null;
				const createPullRequestResolvedValue = null;
				const spyOnPushBranch = jest.spyOn(dataSource, 'pushBranch');
				const spyOnCreatePullRequest = jest.spyOn(utils, 'createPullRequest');
				spyOnPushBranch.mockResolvedValueOnce(pushBranchResolvedValue);
				spyOnCreatePullRequest.mockResolvedValueOnce(createPullRequestResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'createPullRequest',
					repo: '/path/to/repo',
					config: pullRequestConfig,
					sourceRemote: 'origin',
					sourceOwner: 'sourceOwner',
					sourceRepo: 'sourceRepo',
					sourceBranch: 'sourceBranch',
					push: true
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnPushBranch).toHaveBeenCalledWith('/path/to/repo', 'sourceBranch', 'origin', true, GitPushBranchMode.Normal);
					expect(spyOnCreatePullRequest).toHaveBeenCalledWith(pullRequestConfig, 'sourceOwner', 'sourceRepo', 'sourceBranch');

					expect(messages).toStrictEqual([
						{
							command: 'createPullRequest',
							push: true,
							errors: [pushBranchResolvedValue, createPullRequestResolvedValue]
						}
					]);
				});
			});

			it('Shouldn\'t create a pull request if an error occurred when pushing the branch', async () => {
				// Setup
				const pullRequestConfig: PullRequestConfig = {
					provider: PullRequestProvider.Bitbucket,
					custom: null,
					hostRootUrl: 'https://bitbucket.org',
					sourceOwner: 'sourceOwner',
					sourceRepo: 'sourceRepo',
					sourceRemote: 'sourceRemote',
					destOwner: 'destOwner',
					destRepo: 'destRepo',
					destBranch: 'destBranch',
					destRemote: 'destRemote',
					destProjectId: 'destProjectId'
				};
				const pushBranchResolvedValue = 'error message';
				const spyOnPushBranch = jest.spyOn(dataSource, 'pushBranch');
				const spyOnCreatePullRequest = jest.spyOn(utils, 'createPullRequest');
				spyOnPushBranch.mockResolvedValueOnce(pushBranchResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'createPullRequest',
					repo: '/path/to/repo',
					config: pullRequestConfig,
					sourceRemote: 'origin',
					sourceOwner: 'sourceOwner',
					sourceRepo: 'sourceRepo',
					sourceBranch: 'sourceBranch',
					push: true
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnPushBranch).toHaveBeenCalledWith('/path/to/repo', 'sourceBranch', 'origin', true, GitPushBranchMode.Normal);
					expect(spyOnCreatePullRequest).not.toHaveBeenCalled();

					expect(messages).toStrictEqual([
						{
							command: 'createPullRequest',
							push: true,
							errors: [pushBranchResolvedValue]
						}
					]);
				});
			});
		});

		describe('deleteBranch', () => {
			it('Should delete a branch', async () => {
				// Setup
				const deleteBranchResolvedValue = null;
				const spyOnDeleteBranch = jest.spyOn(dataSource, 'deleteBranch');
				const spyOnDeleteRemoteBranch = jest.spyOn(dataSource, 'deleteRemoteBranch');
				spyOnDeleteBranch.mockResolvedValueOnce(deleteBranchResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'deleteBranch',
					repo: '/path/to/repo',
					branchName: 'feature-1',
					forceDelete: false,
					deleteOnRemotes: []
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnDeleteBranch).toHaveBeenCalledWith('/path/to/repo', 'feature-1', false);
					expect(spyOnDeleteRemoteBranch).not.toHaveBeenCalled();
					expect(messages).toStrictEqual([
						{
							command: 'deleteBranch',
							repo: '/path/to/repo',
							branchName: 'feature-1',
							deleteOnRemotes: [],
							errors: [deleteBranchResolvedValue]
						}
					]);
				});
			});

			it('Should delete a branch, and then delete the branch on the specified remotes', async () => {
				// Setup
				const deleteBranchResolvedValue = null;
				const deleteRemoteBranchResolvedValue1 = null;
				const deleteRemoteBranchResolvedValue2 = null;
				const spyOnDeleteBranch = jest.spyOn(dataSource, 'deleteBranch');
				const spyOnDeleteRemoteBranch = jest.spyOn(dataSource, 'deleteRemoteBranch');
				spyOnDeleteBranch.mockResolvedValueOnce(deleteBranchResolvedValue);
				spyOnDeleteRemoteBranch.mockResolvedValueOnce(deleteRemoteBranchResolvedValue1);
				spyOnDeleteRemoteBranch.mockResolvedValueOnce(deleteRemoteBranchResolvedValue2);

				// Run
				onDidReceiveMessage({
					command: 'deleteBranch',
					repo: '/path/to/repo',
					branchName: 'feature-1',
					forceDelete: false,
					deleteOnRemotes: ['origin', 'upstream']
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnDeleteBranch).toHaveBeenCalledWith('/path/to/repo', 'feature-1', false);
					expect(spyOnDeleteRemoteBranch).toHaveBeenNthCalledWith(1, '/path/to/repo', 'feature-1', 'origin');
					expect(spyOnDeleteRemoteBranch).toHaveBeenNthCalledWith(2, '/path/to/repo', 'feature-1', 'upstream');
					expect(messages).toStrictEqual([
						{
							command: 'deleteBranch',
							repo: '/path/to/repo',
							branchName: 'feature-1',
							deleteOnRemotes: ['origin', 'upstream'],
							errors: [deleteBranchResolvedValue, deleteRemoteBranchResolvedValue1, deleteRemoteBranchResolvedValue2]
						}
					]);
				});
			});

			it('Shouldn\'t delete a branch on a remote if an error occurred when deleting the local branch', async () => {
				// Setup
				const deleteBranchResolvedValue = 'error message';
				const spyOnDeleteBranch = jest.spyOn(dataSource, 'deleteBranch');
				const spyOnDeleteRemoteBranch = jest.spyOn(dataSource, 'deleteRemoteBranch');
				spyOnDeleteBranch.mockResolvedValueOnce(deleteBranchResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'deleteBranch',
					repo: '/path/to/repo',
					branchName: 'feature-1',
					forceDelete: false,
					deleteOnRemotes: ['origin', 'upstream']
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnDeleteBranch).toHaveBeenCalledWith('/path/to/repo', 'feature-1', false);
					expect(spyOnDeleteRemoteBranch).not.toHaveBeenCalled();
					expect(messages).toStrictEqual([
						{
							command: 'deleteBranch',
							repo: '/path/to/repo',
							branchName: 'feature-1',
							deleteOnRemotes: ['origin', 'upstream'],
							errors: [deleteBranchResolvedValue]
						}
					]);
				});
			});
		});

		describe('deleteRemote', () => {
			it('Should delete a remote', async () => {
				// Setup
				const deleteRemoteResolvedValue = null;
				const spyOnDeleteRemote = jest.spyOn(dataSource, 'deleteRemote');
				spyOnDeleteRemote.mockResolvedValueOnce(deleteRemoteResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'deleteRemote',
					repo: '/path/to/repo',
					name: 'origin'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnDeleteRemote).toHaveBeenCalledWith('/path/to/repo', 'origin');
					expect(messages).toStrictEqual([
						{
							command: 'deleteRemote',
							error: deleteRemoteResolvedValue
						}
					]);
				});
			});
		});

		describe('deleteRemoteBranch', () => {
			it('Should delete a remote branch', async () => {
				// Setup
				const deleteRemoteBranchResolvedValue = null;
				const spyOnDeleteRemoteBranch = jest.spyOn(dataSource, 'deleteRemoteBranch');
				spyOnDeleteRemoteBranch.mockResolvedValueOnce(deleteRemoteBranchResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'deleteRemoteBranch',
					repo: '/path/to/repo',
					branchName: 'feature-1',
					remote: 'origin'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnDeleteRemoteBranch).toHaveBeenCalledWith('/path/to/repo', 'feature-1', 'origin');
					expect(messages).toStrictEqual([
						{
							command: 'deleteRemoteBranch',
							error: deleteRemoteBranchResolvedValue
						}
					]);
				});
			});
		});

		describe('deleteTag', () => {
			it('Should delete a tag', async () => {
				// Setup
				const deleteTagResolvedValue = null;
				const spyOnDeleteTag = jest.spyOn(dataSource, 'deleteTag');
				spyOnDeleteTag.mockResolvedValueOnce(deleteTagResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'deleteTag',
					repo: '/path/to/repo',
					tagName: 'v1.0',
					deleteOnRemote: null
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnDeleteTag).toHaveBeenCalledWith('/path/to/repo', 'v1.0', null);
					expect(messages).toStrictEqual([
						{
							command: 'deleteTag',
							error: deleteTagResolvedValue
						}
					]);
				});
			});
		});

		describe('deleteUserDetails', () => {
			it('Should delete user.name and user.email', async () => {
				// Setup
				const unsetConfigValueResolvedValue1 = null;
				const unsetConfigValueResolvedValue2 = null;
				const spyOnUnsetConfigValue = jest.spyOn(dataSource, 'unsetConfigValue');
				spyOnUnsetConfigValue.mockResolvedValueOnce(unsetConfigValueResolvedValue1);
				spyOnUnsetConfigValue.mockResolvedValueOnce(unsetConfigValueResolvedValue2);

				// Run
				onDidReceiveMessage({
					command: 'deleteUserDetails',
					repo: '/path/to/repo',
					name: true,
					email: true,
					location: GitConfigLocation.Local
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnUnsetConfigValue).toHaveBeenNthCalledWith(1, '/path/to/repo', 'user.name', GitConfigLocation.Local);
					expect(spyOnUnsetConfigValue).toHaveBeenNthCalledWith(2, '/path/to/repo', 'user.email', GitConfigLocation.Local);
					expect(messages).toStrictEqual([
						{
							command: 'deleteUserDetails',
							errors: [unsetConfigValueResolvedValue1, unsetConfigValueResolvedValue2]
						}
					]);
				});
			});

			it('Should only delete user.name', async () => {
				// Setup
				const unsetConfigValueResolvedValue = null;
				const spyOnUnsetConfigValue = jest.spyOn(dataSource, 'unsetConfigValue');
				spyOnUnsetConfigValue.mockResolvedValueOnce(unsetConfigValueResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'deleteUserDetails',
					repo: '/path/to/repo',
					name: true,
					email: false,
					location: GitConfigLocation.Global
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnUnsetConfigValue).toHaveBeenCalledTimes(1);
					expect(spyOnUnsetConfigValue).toHaveBeenCalledWith('/path/to/repo', 'user.name', GitConfigLocation.Global);
					expect(messages).toStrictEqual([
						{
							command: 'deleteUserDetails',
							errors: [unsetConfigValueResolvedValue]
						}
					]);
				});
			});

			it('Should only delete user.email', async () => {
				// Setup
				const unsetConfigValueResolvedValue = null;
				const spyOnUnsetConfigValue = jest.spyOn(dataSource, 'unsetConfigValue');
				spyOnUnsetConfigValue.mockResolvedValueOnce(unsetConfigValueResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'deleteUserDetails',
					repo: '/path/to/repo',
					name: false,
					email: true,
					location: GitConfigLocation.Global
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnUnsetConfigValue).toHaveBeenCalledTimes(1);
					expect(spyOnUnsetConfigValue).toHaveBeenCalledWith('/path/to/repo', 'user.email', GitConfigLocation.Global);
					expect(messages).toStrictEqual([
						{
							command: 'deleteUserDetails',
							errors: [unsetConfigValueResolvedValue]
						}
					]);
				});
			});
		});

		describe('dropCommit', () => {
			it('Should drop a commit', async () => {
				// Setup
				const dropCommitResolvedValue = null;
				const spyOnDropCommit = jest.spyOn(dataSource, 'dropCommit');
				spyOnDropCommit.mockResolvedValueOnce(dropCommitResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'dropCommit',
					repo: '/path/to/repo',
					commitHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnDropCommit).toHaveBeenCalledWith('/path/to/repo', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b');
					expect(messages).toStrictEqual([
						{
							command: 'dropCommit',
							error: dropCommitResolvedValue
						}
					]);
				});
			});
		});

		describe('dropStash', () => {
			it('Should drop a stash', async () => {
				// Setup
				const dropStashResolvedValue = null;
				const spyOnDropStash = jest.spyOn(dataSource, 'dropStash');
				spyOnDropStash.mockResolvedValueOnce(dropStashResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'dropStash',
					repo: '/path/to/repo',
					selector: 'refs/stash@{0}'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnDropStash).toHaveBeenCalledWith('/path/to/repo', 'refs/stash@{0}');
					expect(messages).toStrictEqual([
						{
							command: 'dropStash',
							error: dropStashResolvedValue
						}
					]);
				});
			});
		});

		describe('editRemote', () => {
			it('Should edit a remote', async () => {
				// Setup
				const editRemoteResolvedValue = null;
				const spyOnEditRemote = jest.spyOn(dataSource, 'editRemote');
				spyOnEditRemote.mockResolvedValueOnce(editRemoteResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'editRemote',
					repo: '/path/to/repo',
					nameOld: 'old-origin',
					nameNew: 'new-origin',
					urlOld: 'https://github.com/example/old.git',
					urlNew: 'https://github.com/example/new.git',
					pushUrlOld: 'https://github.com/example/old-push.git',
					pushUrlNew: 'https://github.com/example/new-push.git'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnEditRemote).toHaveBeenCalledWith('/path/to/repo', 'old-origin', 'new-origin', 'https://github.com/example/old.git', 'https://github.com/example/new.git', 'https://github.com/example/old-push.git', 'https://github.com/example/new-push.git');
					expect(messages).toStrictEqual([
						{
							command: 'editRemote',
							error: editRemoteResolvedValue
						}
					]);
				});
			});
		});

		describe('editUserDetails', () => {
			it('Should edit the local user.name and user.email', async () => {
				// Setup
				const setConfigValueResolvedValue1 = null;
				const setConfigValueResolvedValue2 = null;
				const spyOnSetConfigValue = jest.spyOn(dataSource, 'setConfigValue');
				const spyOnUnsetConfigValue = jest.spyOn(dataSource, 'unsetConfigValue');
				spyOnSetConfigValue.mockResolvedValueOnce(setConfigValueResolvedValue1);
				spyOnSetConfigValue.mockResolvedValueOnce(setConfigValueResolvedValue2);

				// Run
				onDidReceiveMessage({
					command: 'editUserDetails',
					repo: '/path/to/repo',
					name: 'name',
					email: 'user@example.com',
					location: GitConfigLocation.Local,
					deleteLocalName: false,
					deleteLocalEmail: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnSetConfigValue).toHaveBeenNthCalledWith(1, '/path/to/repo', 'user.name', 'name', GitConfigLocation.Local);
					expect(spyOnSetConfigValue).toHaveBeenNthCalledWith(2, '/path/to/repo', 'user.email', 'user@example.com', GitConfigLocation.Local);
					expect(spyOnUnsetConfigValue).not.toHaveBeenCalled();
					expect(messages).toStrictEqual([
						{
							command: 'editUserDetails',
							errors: [setConfigValueResolvedValue1, setConfigValueResolvedValue2]
						}
					]);
				});
			});

			it('Should edit the global user.name and user.email, and delete the local user.name and user.email', async () => {
				// Setup
				const setConfigValueResolvedValue1 = null;
				const setConfigValueResolvedValue2 = null;
				const unsetConfigValueResolvedValue1 = null;
				const unsetConfigValueResolvedValue2 = null;
				const spyOnSetConfigValue = jest.spyOn(dataSource, 'setConfigValue');
				const spyOnUnsetConfigValue = jest.spyOn(dataSource, 'unsetConfigValue');
				spyOnSetConfigValue.mockResolvedValueOnce(setConfigValueResolvedValue1);
				spyOnSetConfigValue.mockResolvedValueOnce(setConfigValueResolvedValue2);
				spyOnUnsetConfigValue.mockResolvedValueOnce(unsetConfigValueResolvedValue1);
				spyOnUnsetConfigValue.mockResolvedValueOnce(unsetConfigValueResolvedValue2);

				// Run
				onDidReceiveMessage({
					command: 'editUserDetails',
					repo: '/path/to/repo',
					name: 'name',
					email: 'user@example.com',
					location: GitConfigLocation.Global,
					deleteLocalName: true,
					deleteLocalEmail: true
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnSetConfigValue).toHaveBeenNthCalledWith(1, '/path/to/repo', 'user.name', 'name', GitConfigLocation.Global);
					expect(spyOnSetConfigValue).toHaveBeenNthCalledWith(2, '/path/to/repo', 'user.email', 'user@example.com', GitConfigLocation.Global);
					expect(spyOnUnsetConfigValue).toHaveBeenNthCalledWith(1, '/path/to/repo', 'user.name', GitConfigLocation.Local);
					expect(spyOnUnsetConfigValue).toHaveBeenNthCalledWith(2, '/path/to/repo', 'user.email', GitConfigLocation.Local);
					expect(messages).toStrictEqual([
						{
							command: 'editUserDetails',
							errors: [setConfigValueResolvedValue1, setConfigValueResolvedValue2, unsetConfigValueResolvedValue1, unsetConfigValueResolvedValue2]
						}
					]);
				});
			});

			it('Should edit the global user.name and user.email, and only delete the local user.name', async () => {
				// Setup
				const setConfigValueResolvedValue1 = null;
				const setConfigValueResolvedValue2 = null;
				const unsetConfigValueResolvedValue = null;
				const spyOnSetConfigValue = jest.spyOn(dataSource, 'setConfigValue');
				const spyOnUnsetConfigValue = jest.spyOn(dataSource, 'unsetConfigValue');
				spyOnSetConfigValue.mockResolvedValueOnce(setConfigValueResolvedValue1);
				spyOnSetConfigValue.mockResolvedValueOnce(setConfigValueResolvedValue2);
				spyOnUnsetConfigValue.mockResolvedValueOnce(unsetConfigValueResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'editUserDetails',
					repo: '/path/to/repo',
					name: 'name',
					email: 'user@example.com',
					location: GitConfigLocation.Global,
					deleteLocalName: true,
					deleteLocalEmail: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnSetConfigValue).toHaveBeenNthCalledWith(1, '/path/to/repo', 'user.name', 'name', GitConfigLocation.Global);
					expect(spyOnSetConfigValue).toHaveBeenNthCalledWith(2, '/path/to/repo', 'user.email', 'user@example.com', GitConfigLocation.Global);
					expect(spyOnUnsetConfigValue).toHaveBeenCalledTimes(1);
					expect(spyOnUnsetConfigValue).toHaveBeenCalledWith('/path/to/repo', 'user.name', GitConfigLocation.Local);
					expect(messages).toStrictEqual([
						{
							command: 'editUserDetails',
							errors: [setConfigValueResolvedValue1, setConfigValueResolvedValue2, unsetConfigValueResolvedValue]
						}
					]);
				});
			});

			it('Should edit the global user.name and user.email, and only delete the local user.email', async () => {
				// Setup
				const setConfigValueResolvedValue1 = null;
				const setConfigValueResolvedValue2 = null;
				const unsetConfigValueResolvedValue = null;
				const spyOnSetConfigValue = jest.spyOn(dataSource, 'setConfigValue');
				const spyOnUnsetConfigValue = jest.spyOn(dataSource, 'unsetConfigValue');
				spyOnSetConfigValue.mockResolvedValueOnce(setConfigValueResolvedValue1);
				spyOnSetConfigValue.mockResolvedValueOnce(setConfigValueResolvedValue2);
				spyOnUnsetConfigValue.mockResolvedValueOnce(unsetConfigValueResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'editUserDetails',
					repo: '/path/to/repo',
					name: 'name',
					email: 'user@example.com',
					location: GitConfigLocation.Global,
					deleteLocalName: false,
					deleteLocalEmail: true
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnSetConfigValue).toHaveBeenNthCalledWith(1, '/path/to/repo', 'user.name', 'name', GitConfigLocation.Global);
					expect(spyOnSetConfigValue).toHaveBeenNthCalledWith(2, '/path/to/repo', 'user.email', 'user@example.com', GitConfigLocation.Global);
					expect(spyOnUnsetConfigValue).toHaveBeenCalledTimes(1);
					expect(spyOnUnsetConfigValue).toHaveBeenCalledWith('/path/to/repo', 'user.email', GitConfigLocation.Local);
					expect(messages).toStrictEqual([
						{
							command: 'editUserDetails',
							errors: [setConfigValueResolvedValue1, setConfigValueResolvedValue2, unsetConfigValueResolvedValue]
						}
					]);
				});
			});

			it('Shouldn\'t delete the local user.name or user.email if an error occurred when editing the global user.name', async () => {
				// Setup
				const setConfigValueResolvedValue1 = 'error message';
				const setConfigValueResolvedValue2 = null;
				const spyOnSetConfigValue = jest.spyOn(dataSource, 'setConfigValue');
				const spyOnUnsetConfigValue = jest.spyOn(dataSource, 'unsetConfigValue');
				spyOnSetConfigValue.mockResolvedValueOnce(setConfigValueResolvedValue1);
				spyOnSetConfigValue.mockResolvedValueOnce(setConfigValueResolvedValue2);

				// Run
				onDidReceiveMessage({
					command: 'editUserDetails',
					repo: '/path/to/repo',
					name: 'name',
					email: 'user@example.com',
					location: GitConfigLocation.Global,
					deleteLocalName: true,
					deleteLocalEmail: true
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnSetConfigValue).toHaveBeenNthCalledWith(1, '/path/to/repo', 'user.name', 'name', GitConfigLocation.Global);
					expect(spyOnSetConfigValue).toHaveBeenNthCalledWith(2, '/path/to/repo', 'user.email', 'user@example.com', GitConfigLocation.Global);
					expect(spyOnUnsetConfigValue).not.toHaveBeenCalled();
					expect(messages).toStrictEqual([
						{
							command: 'editUserDetails',
							errors: [setConfigValueResolvedValue1, setConfigValueResolvedValue2]
						}
					]);
				});
			});

			it('Shouldn\'t delete the local user.name or user.email if an error occurred when editing the global user.email', async () => {
				// Setup
				const setConfigValueResolvedValue1 = null;
				const setConfigValueResolvedValue2 = 'error message';
				const spyOnSetConfigValue = jest.spyOn(dataSource, 'setConfigValue');
				const spyOnUnsetConfigValue = jest.spyOn(dataSource, 'unsetConfigValue');
				spyOnSetConfigValue.mockResolvedValueOnce(setConfigValueResolvedValue1);
				spyOnSetConfigValue.mockResolvedValueOnce(setConfigValueResolvedValue2);

				// Run
				onDidReceiveMessage({
					command: 'editUserDetails',
					repo: '/path/to/repo',
					name: 'name',
					email: 'user@example.com',
					location: GitConfigLocation.Global,
					deleteLocalName: true,
					deleteLocalEmail: true
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnSetConfigValue).toHaveBeenNthCalledWith(1, '/path/to/repo', 'user.name', 'name', GitConfigLocation.Global);
					expect(spyOnSetConfigValue).toHaveBeenNthCalledWith(2, '/path/to/repo', 'user.email', 'user@example.com', GitConfigLocation.Global);
					expect(spyOnUnsetConfigValue).not.toHaveBeenCalled();
					expect(messages).toStrictEqual([
						{
							command: 'editUserDetails',
							errors: [setConfigValueResolvedValue1, setConfigValueResolvedValue2]
						}
					]);
				});
			});
		});

		describe('endCodeReview', () => {
			it('Should end a code review', async () => {
				// Setup
				const spyOnEndCodeReview = jest.spyOn(extensionState, 'endCodeReview');
				spyOnEndCodeReview.mockResolvedValueOnce(null);

				// Run
				onDidReceiveMessage({
					command: 'endCodeReview',
					repo: '/path/to/repo',
					id: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnEndCodeReview).toHaveBeenCalledWith('/path/to/repo', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b');
					expect(messages).toHaveLength(0);
				});
			});
		});

		describe('exportRepoConfig', () => {
			it('Should export the repository configuration', async () => {
				// Setup
				const exportRepoConfigResolvedValue = null;
				const spyOnExportRepoConfig = jest.spyOn(repoManager, 'exportRepoConfig');
				spyOnExportRepoConfig.mockResolvedValueOnce(exportRepoConfigResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'exportRepoConfig',
					repo: '/path/to/repo'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnExportRepoConfig).toHaveBeenCalledWith('/path/to/repo');
					expect(messages).toStrictEqual([
						{
							command: 'exportRepoConfig',
							error: exportRepoConfigResolvedValue
						}
					]);
				});
			});
		});

		describe('fetch', () => {
			it('Should fetch a remote, and prune it', async () => {
				// Setup
				const fetchResolvedValue = null;
				const spyOnFetch = jest.spyOn(dataSource, 'fetch');
				spyOnFetch.mockResolvedValueOnce(fetchResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'fetch',
					repo: '/path/to/repo',
					name: null,
					prune: true,
					pruneTags: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnFetch).toHaveBeenCalledWith('/path/to/repo', null, true, false);
					expect(messages).toStrictEqual([
						{
							command: 'fetch',
							error: fetchResolvedValue
						}
					]);
				});
			});
		});

		describe('fetchAvatar', () => {
			it('Should fetch an avatar', async () => {
				// Setup
				const spyOnFetchAvatarImage = jest.spyOn(avatarManager, 'fetchAvatarImage');
				spyOnFetchAvatarImage.mockImplementationOnce(() => { });

				// Run
				onDidReceiveMessage({
					command: 'fetchAvatar',
					repo: '/path/to/repo',
					remote: 'origin',
					email: 'user@example.com',
					commits: ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnFetchAvatarImage).toHaveBeenCalledWith('user@example.com', '/path/to/repo', 'origin', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);
					expect(messages).toHaveLength(0);
				});
			});
		});

		describe('fetchIntoLocalBranch', () => {
			it('Should fetch into local branch', async () => {
				// Setup
				const fetchIntoLocalBranchResolvedValue = null;
				const spyOnFetchIntoLocalBranch = jest.spyOn(dataSource, 'fetchIntoLocalBranch');
				spyOnFetchIntoLocalBranch.mockResolvedValueOnce(fetchIntoLocalBranchResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'fetchIntoLocalBranch',
					repo: '/path/to/repo',
					remote: 'origin',
					remoteBranch: 'remote-branch',
					localBranch: 'local-branch',
					force: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnFetchIntoLocalBranch).toHaveBeenCalledWith('/path/to/repo', 'origin', 'remote-branch', 'local-branch', false);
					expect(messages).toStrictEqual([
						{
							command: 'fetchIntoLocalBranch',
							error: fetchIntoLocalBranchResolvedValue
						}
					]);
				});
			});
		});

		describe('loadCommits', () => {
			const getCommitsResolvedValue = {
				commits: [
					{
						hash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
						parents: [],
						author: 'Test Name',
						email: 'test@example.com',
						date: 1587559258,
						message: 'Commit Message 3',
						heads: ['master'],
						tags: [],
						remotes: [{ name: 'origin/master', remote: 'origin' }],
						stash: null
					}
				],
				head: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
				tags: ['tag1', 'tag2'],
				moreCommitsAvailable: false,
				error: null
			};
			const getPageToken = (onlyFollowFirstParent: boolean) => getCommitsToken(encodeCommits(getCommitsResolvedValue.commits), getCommitsResolvedValue.head, getCommitsResolvedValue.tags, false, onlyFollowFirstParent);

			it('Should get commits (show tags)', async () => {
				// Setup
				const spyOnGetCommits = jest.spyOn(dataSource, 'getCommits');
				spyOnGetCommits.mockResolvedValueOnce(getCommitsResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'loadCommits',
					repo: '/path/to/repo',
					refreshId: 2,
					branches: null,
					maxCommits: 300,
					showTags: true,
					showRemoteBranches: false,
					includeCommitsMentionedByReflogs: false,
					onlyFollowFirstParent: false,
					commitOrdering: CommitOrdering.Date,
					remotes: ['origin', 'upstream'],
					hideRemotes: ['upstream'],
					hideHosts: [],
					hostChoice: null,
					stashes: [],
					worktrees: [],
					onlyWorktreeHistory: false,
					onlyHostWorktree: null,
					token: null
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnGetCommits).toHaveBeenCalledWith('/path/to/repo', null, 300, true, false, false, false, CommitOrdering.Date, ['origin', 'upstream'], ['upstream'], [], [], false, null, [], null);
					expect(messages).toStrictEqual([
						{
							command: 'loadCommits',
							refreshId: 2,
							unchanged: false,
							uncommitted: { people: [], rows: [] },
							commits: { people: ['Test Name', 'test@example.com'], rows: [['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', [], 0, 1587559258, 'Commit Message 3', ['master'], [], [['origin/master', 'origin']]]] },
							head: getCommitsResolvedValue.head,
							tags: getCommitsResolvedValue.tags,
							moreCommitsAvailable: getCommitsResolvedValue.moreCommitsAvailable,
							onlyFollowFirstParent: false,
							token: getPageToken(false),
							error: getCommitsResolvedValue.error
						}
					]);
					expect(GitTreeView.currentPanel!['loadCommitsRefreshId']).toBe(2);
				});
			});

			it('Should get commits (show remote branches)', async () => {
				// Setup
				const spyOnGetCommits = jest.spyOn(dataSource, 'getCommits');
				spyOnGetCommits.mockResolvedValueOnce(getCommitsResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'loadCommits',
					repo: '/path/to/repo',
					refreshId: 2,
					branches: null,
					maxCommits: 300,
					showTags: false,
					showRemoteBranches: true,
					includeCommitsMentionedByReflogs: false,
					onlyFollowFirstParent: false,
					commitOrdering: CommitOrdering.Date,
					remotes: ['origin', 'upstream'],
					hideRemotes: ['upstream'],
					hideHosts: [],
					hostChoice: null,
					stashes: [],
					worktrees: [],
					onlyWorktreeHistory: false,
					onlyHostWorktree: null,
					token: null
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnGetCommits).toHaveBeenCalledWith('/path/to/repo', null, 300, false, true, false, false, CommitOrdering.Date, ['origin', 'upstream'], ['upstream'], [], [], false, null, [], null);
					expect(messages).toStrictEqual([
						{
							command: 'loadCommits',
							refreshId: 2,
							unchanged: false,
							uncommitted: { people: [], rows: [] },
							commits: { people: ['Test Name', 'test@example.com'], rows: [['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', [], 0, 1587559258, 'Commit Message 3', ['master'], [], [['origin/master', 'origin']]]] },
							head: getCommitsResolvedValue.head,
							tags: getCommitsResolvedValue.tags,
							moreCommitsAvailable: getCommitsResolvedValue.moreCommitsAvailable,
							onlyFollowFirstParent: false,
							token: getPageToken(false),
							error: getCommitsResolvedValue.error
						}
					]);
					expect(GitTreeView.currentPanel!['loadCommitsRefreshId']).toBe(2);
				});
			});

			it('Should get commits (include commits mentioned by reflogs)', async () => {
				// Setup
				const spyOnGetCommits = jest.spyOn(dataSource, 'getCommits');
				spyOnGetCommits.mockResolvedValueOnce(getCommitsResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'loadCommits',
					repo: '/path/to/repo',
					refreshId: 2,
					branches: null,
					maxCommits: 300,
					showTags: false,
					showRemoteBranches: false,
					includeCommitsMentionedByReflogs: true,
					onlyFollowFirstParent: false,
					commitOrdering: CommitOrdering.Date,
					remotes: ['origin', 'upstream'],
					hideRemotes: ['upstream'],
					hideHosts: [],
					hostChoice: null,
					stashes: [],
					worktrees: [],
					onlyWorktreeHistory: false,
					onlyHostWorktree: null,
					token: null
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnGetCommits).toHaveBeenCalledWith('/path/to/repo', null, 300, false, false, true, false, CommitOrdering.Date, ['origin', 'upstream'], ['upstream'], [], [], false, null, [], null);
					expect(messages).toStrictEqual([
						{
							command: 'loadCommits',
							refreshId: 2,
							unchanged: false,
							uncommitted: { people: [], rows: [] },
							commits: { people: ['Test Name', 'test@example.com'], rows: [['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', [], 0, 1587559258, 'Commit Message 3', ['master'], [], [['origin/master', 'origin']]]] },
							head: getCommitsResolvedValue.head,
							tags: getCommitsResolvedValue.tags,
							moreCommitsAvailable: getCommitsResolvedValue.moreCommitsAvailable,
							onlyFollowFirstParent: false,
							token: getPageToken(false),
							error: getCommitsResolvedValue.error
						}
					]);
					expect(GitTreeView.currentPanel!['loadCommitsRefreshId']).toBe(2);
				});
			});

			it('Should get commits (only follow first parent)', async () => {
				// Setup
				const spyOnGetCommits = jest.spyOn(dataSource, 'getCommits');
				spyOnGetCommits.mockResolvedValueOnce(getCommitsResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'loadCommits',
					repo: '/path/to/repo',
					refreshId: 2,
					branches: null,
					maxCommits: 300,
					showTags: false,
					showRemoteBranches: false,
					includeCommitsMentionedByReflogs: false,
					onlyFollowFirstParent: true,
					commitOrdering: CommitOrdering.Date,
					remotes: ['origin', 'upstream'],
					hideRemotes: ['upstream'],
					hideHosts: [],
					hostChoice: null,
					stashes: [],
					worktrees: [],
					onlyWorktreeHistory: false,
					onlyHostWorktree: null,
					token: null
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnGetCommits).toHaveBeenCalledWith('/path/to/repo', null, 300, false, false, false, true, CommitOrdering.Date, ['origin', 'upstream'], ['upstream'], [], [], false, null, [], null);
					expect(messages).toStrictEqual([
						{
							command: 'loadCommits',
							refreshId: 2,
							unchanged: false,
							uncommitted: { people: [], rows: [] },
							commits: { people: ['Test Name', 'test@example.com'], rows: [['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', [], 0, 1587559258, 'Commit Message 3', ['master'], [], [['origin/master', 'origin']]]] },
							head: getCommitsResolvedValue.head,
							tags: getCommitsResolvedValue.tags,
							moreCommitsAvailable: getCommitsResolvedValue.moreCommitsAvailable,
							onlyFollowFirstParent: true,
							token: getPageToken(true),
							error: getCommitsResolvedValue.error
						}
					]);
					expect(GitTreeView.currentPanel!['loadCommitsRefreshId']).toBe(2);
				});
			});

			it('Should get commits (only the history of a worktree, with specific branches)', async () => {
				// Setup
				const spyOnGetCommits = jest.spyOn(dataSource, 'getCommits');
				spyOnGetCommits.mockResolvedValueOnce(getCommitsResolvedValue);
				const worktrees = [
					{ path: '/path/to/repo', name: 'repo', head: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', branch: 'master', isMain: true, isCurrent: false, locked: false, prunable: false },
					{ path: '/path/to/repo/.worktrees/review', name: 'review', head: '2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c', branch: null, isMain: false, isCurrent: true, locked: false, prunable: false }
				];

				// Run
				onDidReceiveMessage({
					command: 'loadCommits',
					repo: '/path/to/repo/.worktrees/review',
					refreshId: 2,
					branches: ['develop'],
					maxCommits: 300,
					showTags: true,
					showRemoteBranches: true,
					includeCommitsMentionedByReflogs: false,
					onlyFollowFirstParent: false,
					commitOrdering: CommitOrdering.Date,
					remotes: ['origin'],
					hideRemotes: [],
					hideHosts: [],
					hostChoice: null,
					stashes: [],
					worktrees: worktrees,
					onlyWorktreeHistory: true,
					onlyHostWorktree: null,
					token: null
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnGetCommits).toHaveBeenCalledWith('/path/to/repo/.worktrees/review', ['develop'], 300, true, true, false, false, CommitOrdering.Date, ['origin'], [], [], worktrees, true, null, [], null);
					expect(messages).toStrictEqual([
						{
							command: 'loadCommits',
							refreshId: 2,
							unchanged: false,
							uncommitted: { people: [], rows: [] },
							commits: { people: ['Test Name', 'test@example.com'], rows: [['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', [], 0, 1587559258, 'Commit Message 3', ['master'], [], [['origin/master', 'origin']]]] },
							head: getCommitsResolvedValue.head,
							tags: getCommitsResolvedValue.tags,
							moreCommitsAvailable: getCommitsResolvedValue.moreCommitsAvailable,
							onlyFollowFirstParent: false,
							token: getPageToken(false),
							error: getCommitsResolvedValue.error
						}
					]);
				});
			});

			describe('The token of the commits the view shows', () => {
				const HASH = '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b';
				const uncommittedRow = { hash: '*', parents: [HASH], author: '*', email: '', date: 1587559259, message: 'Uncommitted Changes (2)', heads: [], tags: [], remotes: [], stash: null };
				const page = { ...getCommitsResolvedValue, commits: [uncommittedRow, ...getCommitsResolvedValue.commits] };
				const request = (token: string | null): RequestMessage => ({
					command: 'loadCommits',
					repo: '/path/to/repo',
					refreshId: 3,
					branches: null,
					maxCommits: 300,
					showTags: true,
					showRemoteBranches: true,
					includeCommitsMentionedByReflogs: false,
					onlyFollowFirstParent: false,
					commitOrdering: CommitOrdering.Date,
					remotes: ['origin'],
					hideRemotes: [],
					hideHosts: [],
					hostChoice: null,
					stashes: [],
					worktrees: [],
					onlyWorktreeHistory: false,
					onlyHostWorktree: null,
					token: token
				});

				it('Should send only the rows of uncommitted changes when the request\'s token describes the history', async () => {
					// Setup
					jest.spyOn(dataSource, 'getCommits').mockResolvedValueOnce(page);

					// Run
					onDidReceiveMessage(request(getPageToken(false)));

					// Assert
					await waitForExpect(() => {
						expect(messages).toStrictEqual([
							{
								command: 'loadCommits',
								refreshId: 3,
								unchanged: true,
								uncommitted: { people: ['*', ''], rows: [['*', [HASH], 0, 1587559259, 'Uncommitted Changes (2)']] },
								token: getPageToken(false),
								error: null
							}
						]);
					});
				});

				it('Should send the full page when the request\'s token describes other commits', async () => {
					// Setup
					jest.spyOn(dataSource, 'getCommits').mockResolvedValueOnce(page);

					// Run
					onDidReceiveMessage(request(getPageToken(true)));

					// Assert
					await waitForExpect(() => {
						expect(messages).toStrictEqual([
							{
								command: 'loadCommits',
								refreshId: 3,
								unchanged: false,
								uncommitted: { people: ['*', ''], rows: [['*', [HASH], 0, 1587559259, 'Uncommitted Changes (2)']] },
								commits: encodeCommits(getCommitsResolvedValue.commits),
								head: HASH,
								tags: ['tag1', 'tag2'],
								moreCommitsAvailable: false,
								onlyFollowFirstParent: false,
								token: getPageToken(false),
								error: null
							}
						]);
					});
				});

				it('Should send the full page, with no token, when the commits can\'t be loaded', async () => {
					// Setup
					const failed = { commits: [], head: null, tags: [], moreCommitsAvailable: false, error: 'error message' };
					jest.spyOn(dataSource, 'getCommits').mockResolvedValueOnce(failed);

					// Run
					onDidReceiveMessage(request(getCommitsToken(encodeCommits([]), null, [], false, false)));

					// Assert
					await waitForExpect(() => {
						expect(messages).toStrictEqual([
							{
								command: 'loadCommits',
								refreshId: 3,
								unchanged: false,
								uncommitted: { people: [], rows: [] },
								commits: { people: [], rows: [] },
								head: null,
								tags: [],
								moreCommitsAvailable: false,
								onlyFollowFirstParent: false,
								token: null,
								error: 'error message'
							}
						]);
					});
				});
			});
		});

		describe('loadRepoInfo', () => {
			it('Should get the repository information (initial repo load)', async () => {
				// Setup
				const getRepoInfoResolvedValue = {
					branches: ['master'],
					head: 'master',
					remotes: ['origin', 'upstream'],
					stashes: [],
					worktrees: [],
					hosts: [],
					error: null
				};
				const spyOnGetRepoInfo = jest.spyOn(dataSource, 'getRepoInfo');
				const spyOnRepoRoot = jest.spyOn(dataSource, 'repoRoot');
				const spyOnSetLastActiveRepo = jest.spyOn(extensionState, 'setLastActiveRepo');
				const spyOnRepoFileWatcherStart = jest.spyOn(GitTreeView.currentPanel!['repoFileWatcher'], 'start');
				spyOnGetRepoInfo.mockResolvedValueOnce(getRepoInfoResolvedValue);
				spyOnSetLastActiveRepo.mockImplementationOnce(() => { });
				spyOnRepoFileWatcherStart.mockImplementationOnce(() => { });

				// Run
				onDidReceiveMessage({
					command: 'loadRepoInfo',
					repo: '/path/to/repo',
					worktree: '/path/to/repo',
					refreshId: 0,
					showRemoteBranches: true,
					showStashes: false,
					hideRemotes: ['upstream'],
					hideHosts: [],
					hostChoice: null,
					refreshHosts: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnGetRepoInfo).toHaveBeenCalledWith('/path/to/repo', true, false, ['upstream'], [], null);
					expect(spyOnRepoRoot).not.toHaveBeenCalled();
					expect(spyOnSetLastActiveRepo).toHaveBeenCalledWith('/path/to/repo');
					expect(spyOnRepoFileWatcherStart).toHaveBeenCalledWith('/path/to/repo', []);
					expect(messages).toStrictEqual([
						{
							command: 'loadRepoInfo',
							refreshId: 0,
							branches: getRepoInfoResolvedValue.branches,
							head: getRepoInfoResolvedValue.head,
							remotes: getRepoInfoResolvedValue.remotes,
							stashes: getRepoInfoResolvedValue.stashes,
							worktrees: getRepoInfoResolvedValue.worktrees,
							hosts: getRepoInfoResolvedValue.hosts,
							isRepo: true,
							error: getRepoInfoResolvedValue.error
						}
					]);
					expect(GitTreeView.currentPanel!['currentRepo']).toBe('/path/to/repo');
					expect(GitTreeView.currentPanel!['loadRepoInfoRefreshId']).toBe(0);
					expect(GitTreeView.currentPanel!['panel'].title).toBe('Git Tree: repo');
					expect(spyOnWriteCommitGraphIfMissing).toHaveBeenCalledWith('/path/to/repo');
				});
			});

			it('Should log the error when the commit-graph can\'t be written', async () => {
				// Setup
				jest.spyOn(dataSource, 'getRepoInfo').mockResolvedValueOnce({ branches: ['master'], head: 'master', remotes: [], stashes: [], worktrees: [], hosts: [], error: null });
				jest.spyOn(extensionState, 'setLastActiveRepo').mockImplementationOnce(() => { });
				jest.spyOn(GitTreeView.currentPanel!['repoFileWatcher'], 'start').mockImplementationOnce(() => { });
				spyOnWriteCommitGraphIfMissing.mockResolvedValueOnce('error message');

				// Run
				onDidReceiveMessage({ command: 'loadRepoInfo', repo: '/path/to/repo', worktree: '/path/to/repo', refreshId: 0, showRemoteBranches: true, showStashes: false, hideRemotes: [], hideHosts: [], hostChoice: null, refreshHosts: false });

				// Assert
				await waitForExpect(() => expect(spyOnLogError).toHaveBeenCalledWith('Unable to write the commit-graph of /path/to/repo: error message'));
			});

			it('Should not write the commit-graph when the setting is disabled', async () => {
				// Setup
				vscode.mockExtensionSettingReturnValue('repository.writeCommitGraph', false);
				jest.spyOn(dataSource, 'getRepoInfo').mockResolvedValueOnce({ branches: ['master'], head: 'master', remotes: [], stashes: [], worktrees: [], hosts: [], error: null });
				jest.spyOn(extensionState, 'setLastActiveRepo').mockImplementationOnce(() => { });
				const spyOnRepoFileWatcherStart = jest.spyOn(GitTreeView.currentPanel!['repoFileWatcher'], 'start');
				spyOnRepoFileWatcherStart.mockImplementationOnce(() => { });

				// Run
				onDidReceiveMessage({ command: 'loadRepoInfo', repo: '/path/to/repo', worktree: '/path/to/repo', refreshId: 0, showRemoteBranches: true, showStashes: false, hideRemotes: [], hideHosts: [], hostChoice: null, refreshHosts: false });

				// Assert
				await waitForExpect(() => expect(spyOnRepoFileWatcherStart).toHaveBeenCalled());
				expect(spyOnWriteCommitGraphIfMissing).not.toHaveBeenCalled();
			});

			it('Should get the repository information (subsequent repo load)', async () => {
				// Setup
				const getRepoInfoResolvedValue = {
					branches: ['master'],
					head: 'master',
					remotes: ['origin', 'upstream'],
					stashes: [],
					worktrees: [],
					hosts: [],
					error: null
				};
				const spyOnGetRepoInfo = jest.spyOn(dataSource, 'getRepoInfo');
				const spyOnRepoRoot = jest.spyOn(dataSource, 'repoRoot');
				const spyOnSetLastActiveRepo = jest.spyOn(extensionState, 'setLastActiveRepo');
				const spyOnRepoFileWatcherStart = jest.spyOn(GitTreeView.currentPanel!['repoFileWatcher'], 'start');
				spyOnGetRepoInfo.mockResolvedValueOnce(getRepoInfoResolvedValue);
				GitTreeView.currentPanel!['currentRepo'] = '/path/to/repo';

				// Run
				onDidReceiveMessage({
					command: 'loadRepoInfo',
					repo: '/path/to/repo',
					worktree: '/path/to/repo',
					refreshId: 1,
					showRemoteBranches: true,
					showStashes: false,
					hideRemotes: ['upstream'],
					hideHosts: [],
					hostChoice: null,
					refreshHosts: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnGetRepoInfo).toHaveBeenCalledWith('/path/to/repo', true, false, ['upstream'], [], null);
					expect(spyOnRepoRoot).not.toHaveBeenCalled();
					expect(spyOnSetLastActiveRepo).not.toHaveBeenCalled();
					expect(spyOnRepoFileWatcherStart).not.toHaveBeenCalled();
					expect(messages).toStrictEqual([
						{
							command: 'loadRepoInfo',
							refreshId: 1,
							branches: getRepoInfoResolvedValue.branches,
							head: getRepoInfoResolvedValue.head,
							remotes: getRepoInfoResolvedValue.remotes,
							stashes: getRepoInfoResolvedValue.stashes,
							worktrees: getRepoInfoResolvedValue.worktrees,
							hosts: getRepoInfoResolvedValue.hosts,
							isRepo: true,
							error: getRepoInfoResolvedValue.error
						}
					]);
					expect(GitTreeView.currentPanel!['currentRepo']).toBe('/path/to/repo');
					expect(GitTreeView.currentPanel!['loadRepoInfoRefreshId']).toBe(1);
				});
			});

			it('Should get the repository information (error thrown by getRepoInfo)', async () => {
				// Setup
				const getRepoInfoResolvedValue = {
					branches: ['master'],
					head: 'master',
					remotes: ['origin', 'upstream'],
					stashes: [],
					worktrees: [],
					hosts: [],
					error: 'error message'
				};
				const spyOnGetRepoInfo = jest.spyOn(dataSource, 'getRepoInfo');
				const spyOnRepoRoot = jest.spyOn(dataSource, 'repoRoot');
				const spyOnSetLastActiveRepo = jest.spyOn(extensionState, 'setLastActiveRepo');
				const spyOnRepoFileWatcherStart = jest.spyOn(GitTreeView.currentPanel!['repoFileWatcher'], 'start');
				spyOnGetRepoInfo.mockResolvedValueOnce(getRepoInfoResolvedValue);
				spyOnRepoRoot.mockResolvedValueOnce('/path/to/repo');
				GitTreeView.currentPanel!['currentRepo'] = '/path/to/repo';

				// Run
				onDidReceiveMessage({
					command: 'loadRepoInfo',
					repo: '/path/to/repo',
					worktree: '/path/to/repo',
					refreshId: 2,
					showRemoteBranches: true,
					showStashes: false,
					hideRemotes: ['upstream'],
					hideHosts: [],
					hostChoice: null,
					refreshHosts: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnGetRepoInfo).toHaveBeenCalledWith('/path/to/repo', true, false, ['upstream'], [], null);
					expect(spyOnRepoRoot).toHaveBeenCalledWith('/path/to/repo');
					expect(spyOnSetLastActiveRepo).not.toHaveBeenCalled();
					expect(spyOnRepoFileWatcherStart).not.toHaveBeenCalled();
					expect(messages).toStrictEqual([
						{
							command: 'loadRepoInfo',
							refreshId: 2,
							branches: getRepoInfoResolvedValue.branches,
							head: getRepoInfoResolvedValue.head,
							remotes: getRepoInfoResolvedValue.remotes,
							stashes: getRepoInfoResolvedValue.stashes,
							worktrees: getRepoInfoResolvedValue.worktrees,
							hosts: getRepoInfoResolvedValue.hosts,
							isRepo: true,
							error: getRepoInfoResolvedValue.error
						}
					]);
					expect(GitTreeView.currentPanel!['currentRepo']).toBe('/path/to/repo');
					expect(GitTreeView.currentPanel!['loadRepoInfoRefreshId']).toBe(2);
				});
			});

			it('Should get the repository information (repo no longer exists)', async () => {
				// Setup
				const getRepoInfoResolvedValue = {
					branches: ['master'],
					head: 'master',
					remotes: ['origin', 'upstream'],
					stashes: [],
					worktrees: [],
					hosts: [],
					error: 'error message'
				};
				const spyOnGetRepoInfo = jest.spyOn(dataSource, 'getRepoInfo');
				const spyOnRepoRoot = jest.spyOn(dataSource, 'repoRoot');
				const spyOnSetLastActiveRepo = jest.spyOn(extensionState, 'setLastActiveRepo');
				const spyOnRepoFileWatcherStart = jest.spyOn(GitTreeView.currentPanel!['repoFileWatcher'], 'start');
				spyOnGetRepoInfo.mockResolvedValueOnce(getRepoInfoResolvedValue);
				spyOnRepoRoot.mockResolvedValueOnce(null);
				GitTreeView.currentPanel!['currentRepo'] = '/path/to/repo';

				// Run
				onDidReceiveMessage({
					command: 'loadRepoInfo',
					repo: '/path/to/repo',
					worktree: '/path/to/repo',
					refreshId: 3,
					showRemoteBranches: true,
					showStashes: false,
					hideRemotes: ['upstream'],
					hideHosts: [],
					hostChoice: null,
					refreshHosts: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnGetRepoInfo).toHaveBeenCalledWith('/path/to/repo', true, false, ['upstream'], [], null);
					expect(spyOnRepoRoot).toHaveBeenCalledWith('/path/to/repo');
					expect(spyOnSetLastActiveRepo).not.toHaveBeenCalled();
					expect(spyOnRepoFileWatcherStart).not.toHaveBeenCalled();
					expect(messages).toStrictEqual([
						{
							command: 'loadRepoInfo',
							refreshId: 3,
							branches: getRepoInfoResolvedValue.branches,
							head: getRepoInfoResolvedValue.head,
							remotes: getRepoInfoResolvedValue.remotes,
							stashes: getRepoInfoResolvedValue.stashes,
							worktrees: getRepoInfoResolvedValue.worktrees,
							hosts: getRepoInfoResolvedValue.hosts,
							isRepo: false,
							error: null
						}
					]);
					expect(GitTreeView.currentPanel!['currentRepo']).toBe('/path/to/repo');
					expect(GitTreeView.currentPanel!['loadRepoInfoRefreshId']).toBe(3);
				});
			});

			it('Should get the repository information of the worktree being shown, and watch every worktree', async () => {
				// Setup
				const worktree = (path: string, isMain: boolean, isCurrent: boolean, prunable: boolean) => ({ path: path, name: path.substring(path.lastIndexOf('/') + 1), head: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', branch: null, isMain: isMain, isCurrent: isCurrent, locked: false, prunable: prunable });
				const worktrees = [worktree('/path/to/repo', true, false, false), worktree('/path/to/repo-feature', false, true, false), worktree('/path/to/repo-old', false, false, true)];
				const spyOnGetRepoInfo = jest.spyOn(dataSource, 'getRepoInfo');
				const spyOnRepoFileWatcherStart = jest.spyOn(GitTreeView.currentPanel!['repoFileWatcher'], 'start');
				spyOnGetRepoInfo.mockResolvedValue({ branches: ['master'], head: 'master', remotes: [], stashes: [], worktrees: worktrees, hosts: [], error: null });
				jest.spyOn(extensionState, 'setLastActiveRepo').mockImplementationOnce(() => { });
				spyOnRepoFileWatcherStart.mockImplementation(() => { });

				// Run
				onDidReceiveMessage({ command: 'loadRepoInfo', repo: '/path/to/repo', worktree: '/path/to/repo-feature', refreshId: 0, showRemoteBranches: true, showStashes: false, hideRemotes: [], hideHosts: [], hostChoice: null, refreshHosts: false });

				// Assert
				await waitForExpect(() => {
					expect(spyOnGetRepoInfo).toHaveBeenCalledWith('/path/to/repo-feature', true, false, [], [], null);
					expect(spyOnRepoFileWatcherStart).toHaveBeenCalledWith('/path/to/repo', ['/path/to/repo', '/path/to/repo-feature']);
					expect(GitTreeView.currentPanel!['currentRepo']).toBe('/path/to/repo');
					expect(GitTreeView.currentPanel!['panel'].title).toBe('Git Tree: repo (repo-feature)');
				});

				// Run: switch back to the main worktree, which watches the same worktrees
				onDidReceiveMessage({ command: 'loadRepoInfo', repo: '/path/to/repo', worktree: '/path/to/repo', refreshId: 1, showRemoteBranches: true, showStashes: false, hideRemotes: [], hideHosts: [], hostChoice: null, refreshHosts: false });

				// Assert
				await waitForExpect(() => expect(GitTreeView.currentPanel!['panel'].title).toBe('Git Tree: repo'));
				expect(spyOnRepoFileWatcherStart).toHaveBeenCalledTimes(1);
				spyOnGetRepoInfo.mockRestore();
				spyOnRepoFileWatcherStart.mockRestore();
			});
		});

		describe('loadConfig', () => {
			it('Should get the Git configuration for a repository', async () => {
				// Setup
				const getConfigResolvedValue = { config: null, error: null };
				const spyOnGetConfig = jest.spyOn(dataSource, 'getConfig');
				spyOnGetConfig.mockResolvedValueOnce(getConfigResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'loadConfig',
					repo: '/path/to/repo',
					remotes: ['origin']
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnGetConfig).toHaveBeenCalledWith('/path/to/repo', ['origin']);
					expect(messages).toStrictEqual([
						{
							command: 'loadConfig',
							repo: '/path/to/repo',
							config: getConfigResolvedValue.config,
							error: getConfigResolvedValue.error
						}
					]);
				});
			});
		});

		describe('loadRepos', () => {
			it('Should load the repositories (without checking for new repositories)', async () => {
				// Setup
				const spyOnCheckReposExist = jest.spyOn(repoManager, 'checkReposExist');

				// Run
				onDidReceiveMessage({
					command: 'loadRepos',
					check: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnCheckReposExist).not.toHaveBeenCalled();
					expect(messages).toStrictEqual([
						{
							command: 'loadRepos',
							repos: { '/path/to/repo': mockRepoState() },
							lastActiveRepo: null,
							loadViewTo: null
						}
					]);
				});
			});

			it('Should load the repositories (found one new repository)', async () => {
				// Setup
				const spyOnCheckReposExist = jest.spyOn(repoManager, 'checkReposExist');
				spyOnCheckReposExist.mockResolvedValueOnce(true);

				// Run
				onDidReceiveMessage({
					command: 'loadRepos',
					check: true
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnCheckReposExist).toHaveBeenCalledWith();
					expect(messages).toHaveLength(0);
				});
			});

			it('Should load the repositories (no new repositories)', async () => {
				// Setup
				const spyOnCheckReposExist = jest.spyOn(repoManager, 'checkReposExist');
				spyOnCheckReposExist.mockResolvedValueOnce(false);

				// Run
				onDidReceiveMessage({
					command: 'loadRepos',
					check: true
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnCheckReposExist).toHaveBeenCalledWith();
					expect(messages).toStrictEqual([
						{
							command: 'loadRepos',
							repos: { '/path/to/repo': mockRepoState() },
							lastActiveRepo: null,
							loadViewTo: null
						}
					]);
				});
			});
		});

		describe('merge', () => {
			it('Should perform a merge (creating a new commit)', async () => {
				// Setup
				const mergeResolvedValue = null;
				const spyOnMerge = jest.spyOn(dataSource, 'merge');
				spyOnMerge.mockResolvedValueOnce(mergeResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'merge',
					repo: '/path/to/repo',
					obj: 'master',
					actionOn: MergeActionOn.Branch,
					createNewCommit: true,
					squash: false,
					noCommit: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnMerge).toHaveBeenCalledWith('/path/to/repo', 'master', MergeActionOn.Branch, true, false, false);
					expect(messages).toStrictEqual([
						{
							command: 'merge',
							actionOn: MergeActionOn.Branch,
							error: mergeResolvedValue
						}
					]);
				});
			});

			it('Should perform a merge (squash)', async () => {
				// Setup
				const mergeResolvedValue = null;
				const spyOnMerge = jest.spyOn(dataSource, 'merge');
				spyOnMerge.mockResolvedValueOnce(mergeResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'merge',
					repo: '/path/to/repo',
					obj: 'master',
					actionOn: MergeActionOn.Branch,
					createNewCommit: false,
					squash: true,
					noCommit: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnMerge).toHaveBeenCalledWith('/path/to/repo', 'master', MergeActionOn.Branch, false, true, false);
					expect(messages).toStrictEqual([
						{
							command: 'merge',
							actionOn: MergeActionOn.Branch,
							error: mergeResolvedValue
						}
					]);
				});
			});

			it('Should perform a merge (no commit)', async () => {
				// Setup
				const mergeResolvedValue = null;
				const spyOnMerge = jest.spyOn(dataSource, 'merge');
				spyOnMerge.mockResolvedValueOnce(mergeResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'merge',
					repo: '/path/to/repo',
					obj: 'master',
					actionOn: MergeActionOn.Branch,
					createNewCommit: false,
					squash: false,
					noCommit: true
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnMerge).toHaveBeenCalledWith('/path/to/repo', 'master', MergeActionOn.Branch, false, false, true);
					expect(messages).toStrictEqual([
						{
							command: 'merge',
							actionOn: MergeActionOn.Branch,
							error: mergeResolvedValue
						}
					]);
				});
			});
		});

		describe('openExtensionSettings', () => {
			it('Should open the Extension Settings', async () => {
				// Setup
				const openExtensionSettingsResolvedValue = null;
				const spyOnOpenExtensionSettings = jest.spyOn(utils, 'openExtensionSettings');
				spyOnOpenExtensionSettings.mockResolvedValueOnce(openExtensionSettingsResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'openExtensionSettings'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnOpenExtensionSettings).toHaveBeenCalledWith();
					expect(messages).toStrictEqual([
						{
							command: 'openExtensionSettings',
							error: openExtensionSettingsResolvedValue
						}
					]);
				});
			});
		});

		describe('openExternalDirDiff', () => {
			it('Should open an External Directory Diff', async () => {
				// Setup
				const openExternalDirDiffResolvedValue = null;
				const spyOnOpenExternalDirDiff = jest.spyOn(dataSource, 'openExternalDirDiff');
				spyOnOpenExternalDirDiff.mockResolvedValueOnce(openExternalDirDiffResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'openExternalDirDiff',
					repo: '/path/to/repo',
					fromHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					toHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
					isGui: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnOpenExternalDirDiff).toHaveBeenCalledWith('/path/to/repo', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2', false);
					expect(messages).toStrictEqual([
						{
							command: 'openExternalDirDiff',
							error: openExternalDirDiffResolvedValue
						}
					]);
				});
			});
		});

		describe('openExternalUrl', () => {
			it('Should open an External URL', async () => {
				// Setup
				const openExternalUrlResolvedValue = null;
				const spyOnOpenExternalUrl = jest.spyOn(utils, 'openExternalUrl');
				spyOnOpenExternalUrl.mockResolvedValueOnce(openExternalUrlResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'openExternalUrl',
					url: 'https://www.example.com'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnOpenExternalUrl).toHaveBeenCalledWith('https://www.example.com');
					expect(messages).toStrictEqual([
						{
							command: 'openExternalUrl',
							error: openExternalUrlResolvedValue
						}
					]);
				});
			});
		});

		describe('openFile', () => {
			it('Should open a file', async () => {
				// Setup
				const openFileResolvedValue = null;
				const spyOnOpenFile = jest.spyOn(utils, 'openFile');
				spyOnOpenFile.mockResolvedValueOnce(openFileResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'openFile',
					repo: '/path/to/repo',
					hash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					filePath: 'file.txt'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnOpenFile).toHaveBeenCalledWith('/path/to/repo', 'file.txt', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', dataSource);
					expect(messages).toStrictEqual([
						{
							command: 'openFile',
							error: openFileResolvedValue
						}
					]);
				});
			});
		});

		describe('openTerminal', () => {
			const worktree = (path: string, isMain: boolean, isCurrent: boolean, prunable: boolean) => ({ path: path, name: path.substring(path.lastIndexOf('/') + 1), head: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', branch: null, isMain: isMain, isCurrent: isCurrent, locked: false, prunable: prunable });
			const worktrees = [
				worktree('/path/to/repo', true, true, false),
				worktree('/path/to/repo/.worktrees/feature', false, false, false),
				worktree('/path/to/repo/.worktrees/gone', false, false, true)
			];
			let spyOnGetWorktrees: jest.SpyInstance;
			let spyOnOpenGitTerminal: jest.SpyInstance;
			beforeEach(() => {
				spyOnGetWorktrees = jest.spyOn(dataSource, 'getWorktrees');
				spyOnGetWorktrees.mockResolvedValueOnce(worktrees);
				spyOnOpenGitTerminal = jest.spyOn(dataSource, 'openGitTerminal');
				spyOnOpenGitTerminal.mockResolvedValueOnce(null);
			});
			afterEach(() => {
				// A test that refuses to open the terminal leaves its values unused, so they're cleared for the next tests
				spyOnGetWorktrees.mockReset();
				spyOnOpenGitTerminal.mockReset();
			});

			it('Should open a terminal in a linked worktree, named after the repository and the worktree', async () => {
				// Run
				onDidReceiveMessage({ command: 'openTerminal', repo: '/path/to/repo', path: '/path/to/repo/.worktrees/feature' });

				// Assert
				await waitForExpect(() => {
					expect(spyOnGetWorktrees).toHaveBeenCalledWith('/path/to/repo');
					expect(spyOnOpenGitTerminal).toHaveBeenCalledWith('/path/to/repo/.worktrees/feature', null, 'repo (feature)');
					expect(messages).toStrictEqual([{ command: 'openTerminal', error: null }]);
				});
			});

			it('Should open a terminal in the main worktree, named Root', async () => {
				// Setup
				spyOnGetRepos.mockReturnValueOnce({ '/path/to/repo': mockRepoState({ name: 'My Repo' }) });

				// Run
				onDidReceiveMessage({ command: 'openTerminal', repo: '/path/to/repo', path: '/path/to/repo' });

				// Assert
				await waitForExpect(() => {
					expect(spyOnOpenGitTerminal).toHaveBeenCalledWith('/path/to/repo', null, 'My Repo (Root)');
					expect(messages).toStrictEqual([{ command: 'openTerminal', error: null }]);
				});
			});

			it('Should open a terminal in the repository itself, when Git lists it by its real path', async () => {
				// Setup
				spyOnGetWorktrees.mockReset();
				spyOnGetWorktrees.mockResolvedValueOnce([worktree('/real/path/to/repo', true, true, false)]);

				// Run
				onDidReceiveMessage({ command: 'openTerminal', repo: '/path/to/repo', path: '/path/to/repo' });

				// Assert
				await waitForExpect(() => {
					expect(spyOnOpenGitTerminal).toHaveBeenCalledWith('/real/path/to/repo', null, 'repo (Root)');
					expect(messages).toStrictEqual([{ command: 'openTerminal', error: null }]);
				});
			});

			it('Shouldn\'t open a terminal in a path that isn\'t a worktree of the repository', async () => {
				// Run
				onDidReceiveMessage({ command: 'openTerminal', repo: '/path/to/repo', path: '/etc' });

				// Assert
				await waitForExpect(() => {
					expect(messages).toStrictEqual([{ command: 'openTerminal', error: '/etc isn\'t a worktree of this repository. Refresh the view, then try again.' }]);
				});
				expect(spyOnOpenGitTerminal).not.toHaveBeenCalled();
			});

			it('Shouldn\'t open a terminal in a worktree whose folder no longer exists', async () => {
				// Run
				onDidReceiveMessage({ command: 'openTerminal', repo: '/path/to/repo', path: '/path/to/repo/.worktrees/gone' });

				// Assert
				await waitForExpect(() => {
					expect(messages).toStrictEqual([{ command: 'openTerminal', error: 'The folder of the worktree /path/to/repo/.worktrees/gone no longer exists.' }]);
				});
				expect(spyOnOpenGitTerminal).not.toHaveBeenCalled();
			});

			it('Shouldn\'t open a terminal for a repository that isn\'t in Git Tree', async () => {
				// Run
				onDidReceiveMessage({ command: 'openTerminal', repo: '/path/to/other', path: '/path/to/other' });

				// Assert
				await waitForExpect(() => {
					expect(messages).toStrictEqual([{ command: 'openTerminal', error: 'The repository /path/to/other isn\'t in Git Tree.' }]);
				});
				expect(spyOnGetWorktrees).not.toHaveBeenCalled();
				expect(spyOnOpenGitTerminal).not.toHaveBeenCalled();
			});

			it('Should return the error when the worktrees can\'t be read', async () => {
				// Setup
				spyOnGetWorktrees.mockReset();
				spyOnGetWorktrees.mockRejectedValueOnce('fatal: not a git repository');

				// Run
				onDidReceiveMessage({ command: 'openTerminal', repo: '/path/to/repo', path: '/path/to/repo' });

				// Assert
				await waitForExpect(() => {
					expect(messages).toStrictEqual([{ command: 'openTerminal', error: 'fatal: not a git repository' }]);
				});
				expect(spyOnOpenGitTerminal).not.toHaveBeenCalled();
			});
		});

		describe('openWorktree', () => {
			it('Should open a worktree in a new window', async () => {
				// Setup
				const spyOnOpenWorktree = jest.spyOn(utils, 'openWorktree');
				spyOnOpenWorktree.mockResolvedValueOnce(null);

				// Run
				onDidReceiveMessage({
					command: 'openWorktree',
					path: '/path/to/repo/.worktrees/feature',
					newWindow: true
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnOpenWorktree).toHaveBeenCalledWith('/path/to/repo/.worktrees/feature', true);
					expect(messages).toStrictEqual([
						{
							command: 'openWorktree',
							error: null
						}
					]);
				});
			});
		});

		describe('popStash', () => {
			it('Should pop a stash', async () => {
				// Setup
				const popStashResolvedValue = null;
				const spyOnPopStash = jest.spyOn(dataSource, 'popStash');
				spyOnPopStash.mockResolvedValueOnce(popStashResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'popStash',
					repo: '/path/to/repo',
					selector: 'refs/stash@{0}',
					reinstateIndex: true
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnPopStash).toHaveBeenCalledWith('/path/to/repo', 'refs/stash@{0}', true);
					expect(messages).toStrictEqual([
						{
							command: 'popStash',
							error: popStashResolvedValue
						}
					]);
				});
			});
		});

		describe('pruneRemote', () => {
			it('Should prune a remote', async () => {
				// Setup
				const pruneRemoteResolvedValue = null;
				const spyOnPruneRemote = jest.spyOn(dataSource, 'pruneRemote');
				spyOnPruneRemote.mockResolvedValueOnce(pruneRemoteResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'pruneRemote',
					repo: '/path/to/repo',
					name: 'origin'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnPruneRemote).toHaveBeenCalledWith('/path/to/repo', 'origin');
					expect(messages).toStrictEqual([
						{
							command: 'pruneRemote',
							error: pruneRemoteResolvedValue
						}
					]);
				});
			});
		});

		describe('pullBranch', () => {
			it('Should pull a branch from a remote', async () => {
				// Setup
				const pullBranchResolvedValue = null;
				const spyOnPullBranch = jest.spyOn(dataSource, 'pullBranch');
				spyOnPullBranch.mockResolvedValueOnce(pullBranchResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'pullBranch',
					repo: '/path/to/repo',
					branchName: 'master',
					remote: 'origin',
					createNewCommit: true,
					squash: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnPullBranch).toHaveBeenCalledWith('/path/to/repo', 'master', 'origin', true, false);
					expect(messages).toStrictEqual([
						{
							command: 'pullBranch',
							error: pullBranchResolvedValue
						}
					]);
				});
			});
		});

		describe('pushBranch', () => {
			it('Should push a branch to a remote', async () => {
				// Setup
				const pushBranchToMultipleRemotesResolvedValue = [null];
				const spyOnPushBranchToMultipleRemotes = jest.spyOn(dataSource, 'pushBranchToMultipleRemotes');
				spyOnPushBranchToMultipleRemotes.mockResolvedValueOnce(pushBranchToMultipleRemotesResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'pushBranch',
					repo: '/path/to/repo',
					branchName: 'develop',
					remotes: ['origin'],
					setUpstream: true,
					mode: GitPushBranchMode.Normal,
					willUpdateBranchConfig: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnPushBranchToMultipleRemotes).toHaveBeenCalledWith('/path/to/repo', 'develop', ['origin'], true, GitPushBranchMode.Normal);
					expect(messages).toStrictEqual([
						{
							command: 'pushBranch',
							willUpdateBranchConfig: false,
							errors: pushBranchToMultipleRemotesResolvedValue
						}
					]);
				});
			});
		});

		describe('pushStash', () => {
			it('Should push a stash', async () => {
				// Setup
				const pushStashResolvedValue = null;
				const spyOnPushStash = jest.spyOn(dataSource, 'pushStash');
				spyOnPushStash.mockResolvedValueOnce(pushStashResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'pushStash',
					repo: '/path/to/repo',
					message: 'stash message',
					includeUntracked: true
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnPushStash).toHaveBeenCalledWith('/path/to/repo', 'stash message', true);
					expect(messages).toStrictEqual([
						{
							command: 'pushStash',
							error: pushStashResolvedValue
						}
					]);
				});
			});
		});

		describe('pushTag', () => {
			it('Should push a tag to a remote', async () => {
				// Setup
				const spyOnPushTagResolvedValue = [null];
				const spyOnPushTag = jest.spyOn(dataSource, 'pushTag');
				spyOnPushTag.mockResolvedValueOnce(spyOnPushTagResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'pushTag',
					repo: '/path/to/repo',
					tagName: 'tag-name',
					remotes: ['origin'],
					commitHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					skipRemoteCheck: true
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnPushTag).toHaveBeenCalledWith('/path/to/repo', 'tag-name', ['origin'], '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', true);
					expect(messages).toStrictEqual([
						{
							command: 'pushTag',
							repo: '/path/to/repo',
							tagName: 'tag-name',
							remotes: ['origin'],
							commitHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
							errors: spyOnPushTagResolvedValue
						}
					]);
				});
			});
		});

		describe('rebase', () => {
			it('Should rebase the current branch on a branch', async () => {
				// Setup
				const rebaseResolvedValue = null;
				const spyOnRebase = jest.spyOn(dataSource, 'rebase');
				spyOnRebase.mockResolvedValueOnce(rebaseResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'rebase',
					repo: '/path/to/repo',
					obj: 'feature',
					actionOn: RebaseActionOn.Branch,
					ignoreDate: true,
					interactive: false
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnRebase).toHaveBeenCalledWith('/path/to/repo', 'feature', RebaseActionOn.Branch, true, false);
					expect(messages).toStrictEqual([
						{
							command: 'rebase',
							actionOn: RebaseActionOn.Branch,
							interactive: false,
							error: rebaseResolvedValue
						}
					]);
				});
			});
		});

		describe('removeWorktree', () => {
			it('Should remove a worktree', async () => {
				// Setup
				const spyOnRemoveWorktree = jest.spyOn(dataSource, 'removeWorktree');
				spyOnRemoveWorktree.mockResolvedValueOnce(null);

				// Run
				onDidReceiveMessage({
					command: 'removeWorktree',
					repo: '/path/to/repo',
					path: '/path/to/repo/.worktrees/feature',
					force: true
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnRemoveWorktree).toHaveBeenCalledWith('/path/to/repo', '/path/to/repo/.worktrees/feature', true);
					expect(messages).toStrictEqual([
						{
							command: 'removeWorktree',
							error: null
						}
					]);
				});
			});
		});

		describe('renameBranch', () => {
			it('Should rename a branch', async () => {
				// Setup
				const renameBranchResolvedValue = null;
				const spyOnRenameBranch = jest.spyOn(dataSource, 'renameBranch');
				spyOnRenameBranch.mockResolvedValueOnce(renameBranchResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'renameBranch',
					repo: '/path/to/repo',
					oldName: 'old-branch',
					newName: 'new-branch'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnRenameBranch).toHaveBeenCalledWith('/path/to/repo', 'old-branch', 'new-branch');
					expect(messages).toStrictEqual([
						{
							command: 'renameBranch',
							error: renameBranchResolvedValue
						}
					]);
				});
			});
		});

		describe('rescanForRepos', () => {
			it('Should rescan the workspace for repositories (repositories added)', async () => {
				// Setup
				const spyOnSearchWorkspaceForRepos = jest.spyOn(repoManager, 'searchWorkspaceForRepos');
				const spyOnShowErrorMessage = jest.spyOn(utils, 'showErrorMessage');
				spyOnSearchWorkspaceForRepos.mockResolvedValueOnce(true);

				// Run
				onDidReceiveMessage({
					command: 'rescanForRepos'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnSearchWorkspaceForRepos).toHaveBeenCalledWith();
					expect(spyOnShowErrorMessage).not.toHaveBeenCalled();
					expect(messages).toHaveLength(0);
				});
			});

			it('Should rescan the workspace for repositories (no new repositories were found)', async () => {
				// Setup
				const spyOnSearchWorkspaceForRepos = jest.spyOn(repoManager, 'searchWorkspaceForRepos');
				const spyOnShowErrorMessage = jest.spyOn(utils, 'showErrorMessage');
				spyOnSearchWorkspaceForRepos.mockResolvedValueOnce(false);
				spyOnShowErrorMessage.mockResolvedValueOnce();

				// Run
				onDidReceiveMessage({
					command: 'rescanForRepos'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnSearchWorkspaceForRepos).toHaveBeenCalledWith();
					expect(spyOnShowErrorMessage).toHaveBeenCalledWith('No Git repositories were found in the current workspace.');
					expect(messages).toHaveLength(0);
				});
			});
		});

		describe('resetFileToRevision', () => {
			it('Should reset the file to a revision', async () => {
				// Setup
				const resetFileToRevisionResolvedValue = null;
				const spyOnResetFileToRevision = jest.spyOn(dataSource, 'resetFileToRevision');
				spyOnResetFileToRevision.mockResolvedValueOnce(resetFileToRevisionResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'resetFileToRevision',
					repo: '/path/to/repo',
					commitHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					filePath: 'path/to/file'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnResetFileToRevision).toHaveBeenCalledWith('/path/to/repo', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', 'path/to/file');
					expect(messages).toStrictEqual([
						{
							command: 'resetFileToRevision',
							error: resetFileToRevisionResolvedValue
						}
					]);
				});
			});
		});

		describe('resetToCommit', () => {
			it('Should reset the current branch to a commit', async () => {
				// Setup
				const resetToCommitResolvedValue = null;
				const spyOnResetToCommit = jest.spyOn(dataSource, 'resetToCommit');
				spyOnResetToCommit.mockResolvedValueOnce(resetToCommitResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'resetToCommit',
					repo: '/path/to/repo',
					commit: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					resetMode: GitResetMode.Mixed
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnResetToCommit).toHaveBeenCalledWith('/path/to/repo', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', GitResetMode.Mixed);
					expect(messages).toStrictEqual([
						{
							command: 'resetToCommit',
							error: resetToCommitResolvedValue
						}
					]);
				});
			});
		});

		describe('revertCommit', () => {
			it('Should revert a commit', async () => {
				// Setup
				const revertCommitResolvedValue = null;
				const spyOnRevertCommit = jest.spyOn(dataSource, 'revertCommit');
				spyOnRevertCommit.mockResolvedValueOnce(revertCommitResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'revertCommit',
					repo: '/path/to/repo',
					commitHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					parentIndex: 1
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnRevertCommit).toHaveBeenCalledWith('/path/to/repo', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', 1);
					expect(messages).toStrictEqual([
						{
							command: 'revertCommit',
							error: revertCommitResolvedValue
						}
					]);
				});
			});
		});

		describe('setGlobalViewState', () => {
			it('Should set the Global View State', async () => {
				// Setup
				const globalViewState: GitTreeViewGlobalState = {
					alwaysAcceptCheckoutCommit: true,
					issueLinkingConfig: null,
					pushTagSkipRemoteCheck: false
				};
				const setGlobalViewStateResolvedValue = null;
				const spyOnSetGlobalViewState = jest.spyOn(extensionState, 'setGlobalViewState');
				spyOnSetGlobalViewState.mockResolvedValueOnce(setGlobalViewStateResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'setGlobalViewState',
					state: globalViewState
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnSetGlobalViewState).toHaveBeenCalledWith(globalViewState);
					expect(messages).toStrictEqual([
						{
							command: 'setGlobalViewState',
							error: setGlobalViewStateResolvedValue
						}
					]);
				});
			});
		});

		describe('setRepoState', () => {
			it('Should set the Repository State', async () => {
				// Setup
				const repoState = mockRepoState();
				const spyOnSetRepoState = jest.spyOn(repoManager, 'setRepoState');
				spyOnSetRepoState.mockImplementationOnce(() => { });

				// Run
				onDidReceiveMessage({
					command: 'setRepoState',
					repo: '/path/to/repo',
					state: repoState
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnSetRepoState).toHaveBeenCalledWith('/path/to/repo', repoState);
					expect(messages).toHaveLength(0);
				});
			});

			it('Should save the Host and Worktree dropdowns\' choices with the Repository State', async () => {
				// Setup
				const repoState = mockRepoState({ hostChoice: ['', 'aws-ns'], worktreeChoice: 'host:aws-ns:/srv/app' });
				const spyOnSetRepoState = jest.spyOn(repoManager, 'setRepoState');
				spyOnSetRepoState.mockImplementationOnce(() => { });

				// Run
				onDidReceiveMessage({
					command: 'setRepoState',
					repo: '/path/to/repo',
					state: repoState
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnSetRepoState).toHaveBeenCalledWith('/path/to/repo', expect.objectContaining({ hostChoice: ['', 'aws-ns'], worktreeChoice: 'host:aws-ns:/srv/app' }));
				});
			});
		});

		describe('setWorkspaceViewState', () => {
			it('Should set the Workspace View State', async () => {
				// Setup
				const workspaceViewState: GitTreeViewWorkspaceState = {
					findIsCaseSensitive: true,
					findIsRegex: false,
					findOpenCommitDetailsView: true
				};
				const setWorkspaceViewStateResolvedValue = null;
				const spyOnSetWorkspaceViewState = jest.spyOn(extensionState, 'setWorkspaceViewState');
				spyOnSetWorkspaceViewState.mockResolvedValueOnce(setWorkspaceViewStateResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'setWorkspaceViewState',
					state: workspaceViewState
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnSetWorkspaceViewState).toHaveBeenCalledWith(workspaceViewState);
					expect(messages).toStrictEqual([
						{
							command: 'setWorkspaceViewState',
							error: setWorkspaceViewStateResolvedValue
						}
					]);
				});
			});
		});

		describe('showErrorMessage', () => {
			it('Should show a Visual Studio Code Error Message', async () => {
				// Setup
				const spyOnShowErrorMessage = jest.spyOn(utils, 'showErrorMessage');
				spyOnShowErrorMessage.mockResolvedValueOnce();

				// Run
				onDidReceiveMessage({
					command: 'showErrorMessage',
					message: 'error message'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnShowErrorMessage).toHaveBeenCalledWith('error message');
					expect(messages).toHaveLength(0);
				});
			});
		});

		describe('startCodeReview', () => {
			it('Should start a code review', async () => {
				// Setup
				const startCodeReviewResolvedValue = {
					codeReview: {
						id: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
						lastActive: 1587559258000,
						lastViewedFile: null,
						remainingFiles: ['file1.txt', 'file2.txt', 'file3.txt']
					},
					error: null
				};
				const spyOnStartCodeReview = jest.spyOn(extensionState, 'startCodeReview');
				spyOnStartCodeReview.mockResolvedValueOnce(startCodeReviewResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'startCodeReview',
					repo: '/path/to/repo',
					id: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					files: ['file1.txt', 'file2.txt', 'file3.txt'],
					lastViewedFile: null,
					commitHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					compareWithHash: null
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnStartCodeReview).toHaveBeenCalledWith('/path/to/repo', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', ['file1.txt', 'file2.txt', 'file3.txt'], null);
					expect(messages).toStrictEqual([
						{
							command: 'startCodeReview',
							codeReview: startCodeReviewResolvedValue.codeReview,
							commitHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
							compareWithHash: null,
							error: startCodeReviewResolvedValue.error
						}
					]);
				});
			});
		});

		describe('tagDetails', () => {
			it('Should get a tag\'s details', async () => {
				// Setup
				const getTagDetailsResolvedValue = { details: null, error: null };
				const spyOnGetTagDetails = jest.spyOn(dataSource, 'getTagDetails');
				spyOnGetTagDetails.mockResolvedValueOnce(getTagDetailsResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'tagDetails',
					repo: '/path/to/repo',
					tagName: 'tag-name',
					commitHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnGetTagDetails).toHaveBeenCalledWith('/path/to/repo', 'tag-name');
					expect(messages).toStrictEqual([
						{
							command: 'tagDetails',
							tagName: 'tag-name',
							commitHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
							details: null,
							error: null
						}
					]);
				});
			});
		});

		describe('updateCodeReview', () => {
			it('Should update a code review', async () => {
				// Setup
				const updateCodeReviewResolvedValue = null;
				const spyOnUpdateCodeReview = jest.spyOn(extensionState, 'updateCodeReview');
				spyOnUpdateCodeReview.mockResolvedValueOnce(updateCodeReviewResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'updateCodeReview',
					repo: '/path/to/repo',
					id: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					remainingFiles: ['file2.txt', 'file3.txt'],
					lastViewedFile: 'file1.txt'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnUpdateCodeReview).toHaveBeenCalledWith('/path/to/repo', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', ['file2.txt', 'file3.txt'], 'file1.txt');
					expect(messages).toStrictEqual([
						{
							command: 'updateCodeReview',
							error: updateCodeReviewResolvedValue
						}
					]);
				});
			});
		});

		describe('viewDiff', () => {
			it('Should open a diff', async () => {
				// Setup
				const viewDiffResolvedValue = null;
				const spyOnViewDiff = jest.spyOn(utils, 'viewDiff');
				spyOnViewDiff.mockResolvedValueOnce(viewDiffResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'viewDiff',
					repo: '/path/to/repo',
					fromHash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					toHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
					oldFilePath: 'old-file.txt',
					newFilePath: 'new-file.txt',
					type: GitFileStatus.Renamed
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnViewDiff).toHaveBeenCalledWith('/path/to/repo', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2', 'old-file.txt', 'new-file.txt', GitFileStatus.Renamed);
					expect(messages).toStrictEqual([
						{
							command: 'viewDiff',
							error: viewDiffResolvedValue
						}
					]);
				});
			});
		});

		describe('viewDiffWithWorkingFile', () => {
			it('Should open a diff with the working file', async () => {
				// Setup
				const viewDiffWithWorkingFileResolvedValue = null;
				const spyOnViewDiffWithWorkingFile = jest.spyOn(utils, 'viewDiffWithWorkingFile');
				spyOnViewDiffWithWorkingFile.mockResolvedValueOnce(viewDiffWithWorkingFileResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'viewDiffWithWorkingFile',
					repo: '/path/to/repo',
					hash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					filePath: 'file.txt'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnViewDiffWithWorkingFile).toHaveBeenCalledWith('/path/to/repo', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', 'file.txt', dataSource);
					expect(messages).toStrictEqual([
						{
							command: 'viewDiffWithWorkingFile',
							error: viewDiffWithWorkingFileResolvedValue
						}
					]);
				});
			});
		});

		describe('viewFileAtRevision', () => {
			it('Should view a file at a revision', async () => {
				// Setup
				const viewFileAtRevisionResolvedValue = null;
				const spyOnViewFileAtRevision = jest.spyOn(utils, 'viewFileAtRevision');
				spyOnViewFileAtRevision.mockResolvedValueOnce(viewFileAtRevisionResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'viewFileAtRevision',
					repo: '/path/to/repo',
					hash: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					filePath: 'file.txt'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnViewFileAtRevision).toHaveBeenCalledWith('/path/to/repo', '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', 'file.txt');
					expect(messages).toStrictEqual([
						{
							command: 'viewFileAtRevision',
							error: viewFileAtRevisionResolvedValue
						}
					]);
				});
			});
		});

		describe('viewScm', () => {
			it('Should open the Visual Studio Code Source Control View', async () => {
				// Setup
				const viewScmResolvedValue = null;
				const spyOnViewScm = jest.spyOn(utils, 'viewScm');
				spyOnViewScm.mockResolvedValueOnce(viewScmResolvedValue);

				// Run
				onDidReceiveMessage({
					command: 'viewScm'
				});

				// Assert
				await waitForExpect(() => {
					expect(spyOnViewScm).toHaveBeenCalledWith();
					expect(messages).toStrictEqual([
						{
							command: 'viewScm',
							error: viewScmResolvedValue
						}
					]);
				});
			});
		});
	});

	describe('Remote hosts', () => {
		const hostSnapshot: RemoteHostSnapshot = {
			host: { name: 'server', ssh: 'gt-test', path: '/home/dev/app', state: 'ok', message: null, lastRefresh: 1700000000000 },
			worktrees: []
		};
		const hostEntry: RemoteHostEntry = { name: 'server', ssh: 'gt-test', path: '/home/dev/app', worktrees: true, forwardAgent: false };
		const hostSettings: GitRemoteHostSettings = Object.assign({}, hostEntry, { state: <const>'ok', message: null, lastRefresh: 1700000000000, worktreeCount: 2 });
		let onDidChangeHosts: EventEmitter<string>;
		let remoteHosts: { [name: string]: jest.Mock | Function };
		let onDidReceiveMessage: (msg: RequestMessage) => void;
		let messages: ResponseMessage[];

		const setRemoteHosts = (value: object | null) => {
			Object.defineProperty(dataSource, 'remoteHosts', { value: value, configurable: true, writable: true });
		};

		beforeEach(() => {
			onDidChangeHosts = new EventEmitter<string>();
			remoteHosts = {
				onDidChange: onDidChangeHosts.subscribe,
				getHosts: jest.fn(() => [hostSnapshot]),
				refresh: jest.fn(),
				createWorktree: jest.fn(() => Promise.resolve(null)),
				openWorktree: jest.fn(() => Promise.resolve(null)),
				removeWorktree: jest.fn(() => Promise.resolve(null)),
				openTerminal: jest.fn(() => null),
				askFetchConsent: jest.fn(() => Promise.resolve()),
				loadSettings: jest.fn(() => Promise.resolve({ hosts: [hostSettings], configFile: '/path/to/repo/.worktrees/git-tree.yaml', configError: null, sshAliases: [{ alias: 'gt-test', hostName: '127.0.0.1', user: 'dev' }], agentInstruction: 'The instruction' })),
				browse: jest.fn(() => Promise.resolve({ path: '/home/dev', parent: '/home', entries: [{ name: 'app', kind: 'repository' }], truncated: false })),
				checkHost: jest.fn(() => Promise.resolve(null)),
				saveHost: jest.fn(() => Promise.resolve(null)),
				createRepository: jest.fn(() => Promise.resolve(null)),
				removeHost: jest.fn(() => Promise.resolve(null)),
				runGitOnHost: jest.fn(() => Promise.resolve(null))
			};
			setRemoteHosts(remoteHosts);
			GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);
			const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
			onDidReceiveMessage = mockedWebviewPanel.mocks.panel.webview.onDidReceiveMessage;
			messages = mockedWebviewPanel.mocks.messages;
		});

		afterEach(() => {
			while (GitTreeView.currentPanel) {
				GitTreeView.currentPanel.dispose();
			}
			setRemoteHosts(undefined as unknown as null);
			onDidChangeHosts.dispose();
		});

		describe('RemoteHosts.onDidChange', () => {
			it('Should refresh the view of the repository whose hosts changed', () => {
				// Setup
				GitTreeView.currentPanel!['currentRepo'] = '/path/to/repo';

				// Run
				onDidChangeHosts.emit('/path/to/repo');

				// Assert
				expect(messages).toStrictEqual([{ command: 'refresh' }]);
			});

			it('Should refresh the view when the hosts of the worktree it shows changed', () => {
				// Setup
				GitTreeView.currentPanel!['currentRepo'] = '/path/to/repo';
				GitTreeView.currentPanel!['shownWorktree'] = '/path/to/repo-feature';

				// Run
				onDidChangeHosts.emit('/path/to/repo-feature');

				// Assert
				expect(messages).toStrictEqual([{ command: 'refresh' }]);
			});

			it('Shouldn\'t refresh the view of another repository', () => {
				// Setup
				GitTreeView.currentPanel!['currentRepo'] = '/path/to/repo';

				// Run
				onDidChangeHosts.emit('/path/to/other-repo');

				// Assert
				expect(messages).toStrictEqual([]);
			});

			it('Shouldn\'t refresh the view when it isn\'t visible', () => {
				// Setup
				GitTreeView.currentPanel!['currentRepo'] = '/path/to/repo';
				vscode.getMockedWebviewPanel(0).mocks.panel.setVisibility(false);

				// Run
				onDidChangeHosts.emit('/path/to/repo');

				// Assert
				expect(messages).toStrictEqual([]);
			});
		});

		describe('loadRepoInfo', () => {
			const loadRepoInfo = (refreshId: number, refreshHosts: boolean): RequestMessage => ({ command: 'loadRepoInfo', repo: '/path/to/repo', worktree: '/path/to/repo', refreshId: refreshId, showRemoteBranches: true, showStashes: false, hideRemotes: [], hideHosts: [], hostChoice: null, refreshHosts: refreshHosts });

			beforeEach(() => {
				jest.spyOn(dataSource, 'getRepoInfo').mockResolvedValue({ branches: ['master'], head: 'master', remotes: [], stashes: [], worktrees: [], hosts: [hostSnapshot.host], error: null });
				jest.spyOn(extensionState, 'setLastActiveRepo').mockImplementation(() => { });
				jest.spyOn(GitTreeView.currentPanel!['repoFileWatcher'], 'start').mockImplementation(() => { });
			});

			it('Should refresh the hosts when the view loads a repository, and send them to the view', async () => {
				// Run
				onDidReceiveMessage(loadRepoInfo(0, false));

				// Assert
				await waitForExpect(() => {
					expect(remoteHosts.refresh).toHaveBeenCalledWith('/path/to/repo', [], null);
					expect(messages).toStrictEqual([
						{ command: 'loadRepoInfo', refreshId: 0, branches: ['master'], head: 'master', remotes: [], stashes: [], worktrees: [], hosts: [hostSnapshot.host], error: null, isRepo: true }
					]);
				});
			});

			it('Shouldn\'t refresh the hosts on a refresh of the same repository', async () => {
				// Setup
				onDidReceiveMessage(loadRepoInfo(0, false));
				await waitForExpect(() => expect(messages).toHaveLength(1));

				// Run
				onDidReceiveMessage(loadRepoInfo(1, false));

				// Assert
				await waitForExpect(() => expect(messages).toHaveLength(2));
				expect(remoteHosts.refresh).toHaveBeenCalledTimes(1);
			});

			it('Should skip the hosts the view hides', async () => {
				// Run
				onDidReceiveMessage(Object.assign({}, loadRepoInfo(0, false), { hideHosts: ['server'] }));

				// Assert
				await waitForExpect(() => {
					expect(dataSource.getRepoInfo).toHaveBeenCalledWith('/path/to/repo', true, false, [], ['server'], null);
					expect(remoteHosts.refresh).toHaveBeenCalledWith('/path/to/repo', ['server'], null);
				});
			});

			it('Should pass the Host dropdown\'s choice on, so the hosts it doesn\'t show are left out and skipped', async () => {
				// Run
				onDidReceiveMessage(Object.assign({}, loadRepoInfo(0, false), { hideHosts: ['other'], hostChoice: ['', 'server'] }));

				// Assert
				await waitForExpect(() => {
					expect(dataSource.getRepoInfo).toHaveBeenCalledWith('/path/to/repo', true, false, [], ['other'], ['', 'server']);
					expect(remoteHosts.refresh).toHaveBeenCalledWith('/path/to/repo', ['other'], ['', 'server']);
				});
			});

			it('Should pass a Host dropdown choice of no sources on as it is', async () => {
				// Run
				onDidReceiveMessage(Object.assign({}, loadRepoInfo(0, false), { hostChoice: [] }));

				// Assert
				await waitForExpect(() => {
					expect(dataSource.getRepoInfo).toHaveBeenCalledWith('/path/to/repo', true, false, [], [], []);
					expect(remoteHosts.refresh).toHaveBeenCalledWith('/path/to/repo', [], []);
				});
			});

			it('Should refresh the hosts when the user refreshes the view', async () => {
				// Setup
				onDidReceiveMessage(loadRepoInfo(0, false));
				await waitForExpect(() => expect(messages).toHaveLength(1));

				// Run
				onDidReceiveMessage(loadRepoInfo(1, true));

				// Assert
				await waitForExpect(() => expect(remoteHosts.refresh).toHaveBeenCalledTimes(2));
			});

			it('Should refresh the hosts again when the view becomes visible', async () => {
				// Setup
				onDidReceiveMessage(loadRepoInfo(0, false));
				await waitForExpect(() => expect(messages).toHaveLength(1));
				const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
				mockedWebviewPanel.mocks.panel.setVisibility(false);
				mockedWebviewPanel.mocks.panel.setVisibility(true);

				// Run
				onDidReceiveMessage(loadRepoInfo(1, false));

				// Assert
				await waitForExpect(() => expect(remoteHosts.refresh).toHaveBeenCalledTimes(2));
			});
		});

		describe('createRemoteWorktree', () => {
			const createRemoteWorktree = (host: string, worktreePath: string, openInNewWindow: boolean): RequestMessage => ({ command: 'createRemoteWorktree', repo: '/path/to/repo', host: host, path: worktreePath, commitish: 'main', newBranch: 'feature', openInNewWindow: openInNewWindow });

			it('Should create a worktree at the path resolved from the host\'s path, and open it', async () => {
				// Run
				onDidReceiveMessage(createRemoteWorktree('server', '../{repo}-feature', true));

				// Assert
				await waitForExpect(() => {
					expect(remoteHosts.createWorktree).toHaveBeenCalledWith('/path/to/repo', 'server', '/home/dev/app-feature', 'main', 'feature');
					expect(remoteHosts.openWorktree).toHaveBeenCalledWith('/path/to/repo', 'server', '/home/dev/app-feature', true);
					expect(messages).toStrictEqual([{ command: 'createRemoteWorktree', errors: [null, null] }]);
				});
			});

			it('Shouldn\'t open the worktree when it couldn\'t be created', async () => {
				// Setup
				(remoteHosts.createWorktree as jest.Mock).mockResolvedValueOnce('Git Tree couldn\'t create the worktree on "server".');

				// Run
				onDidReceiveMessage(createRemoteWorktree('server', '/home/dev/app-feature', true));

				// Assert
				await waitForExpect(() => expect(messages).toStrictEqual([{ command: 'createRemoteWorktree', errors: ['Git Tree couldn\'t create the worktree on "server".'] }]));
				expect(remoteHosts.openWorktree).not.toHaveBeenCalled();
			});

			it('Should refuse a path under ~, since the server\'s home folder isn\'t known', async () => {
				// Run
				onDidReceiveMessage(createRemoteWorktree('server', '~/app-feature', false));

				// Assert
				await waitForExpect(() => expect(messages).toStrictEqual([{ command: 'createRemoteWorktree', errors: ['Use an absolute path, or a path relative to the repository, for a worktree on a server: Git Tree doesn\'t know the server\'s home folder.'] }]));
				expect(remoteHosts.createWorktree).not.toHaveBeenCalled();
			});

			it('Should return an error for a host that isn\'t in the config', async () => {
				// Run
				onDidReceiveMessage(createRemoteWorktree('other', '/home/dev/app-feature', false));

				// Assert
				await waitForExpect(() => expect(messages).toStrictEqual([{ command: 'createRemoteWorktree', errors: ['The host "other" isn\'t in .worktrees/git-tree.yaml.'] }]));
				expect(remoteHosts.createWorktree).not.toHaveBeenCalled();
			});
		});

		describe('openRemoteWorktree', () => {
			it('Should open the worktree with Remote-SSH', async () => {
				// Run
				onDidReceiveMessage({ command: 'openRemoteWorktree', repo: '/path/to/repo', host: 'server', path: '/home/dev/app-wt', newWindow: false });

				// Assert
				await waitForExpect(() => {
					expect(remoteHosts.openWorktree).toHaveBeenCalledWith('/path/to/repo', 'server', '/home/dev/app-wt', false);
					expect(messages).toStrictEqual([{ command: 'openRemoteWorktree', error: null }]);
				});
			});
		});

		describe('openRemoteTerminal', () => {
			it('Should open a terminal on the host', async () => {
				// Run
				onDidReceiveMessage({ command: 'openRemoteTerminal', repo: '/path/to/repo', host: 'server', path: '/home/dev/app-wt' });

				// Assert
				await waitForExpect(() => {
					expect(remoteHosts.openTerminal).toHaveBeenCalledWith('/path/to/repo', 'server', '/home/dev/app-wt');
					expect(messages).toStrictEqual([{ command: 'openRemoteTerminal', error: null }]);
				});
			});

			it('Shouldn\'t open a local terminal in a host\'s worktree path', async () => {
				// Setup
				const spyOnGetWorktrees = jest.spyOn(dataSource, 'getWorktrees');
				spyOnGetWorktrees.mockResolvedValueOnce([{ path: '/path/to/repo', name: 'repo', head: null, branch: 'main', isMain: true, isCurrent: true, locked: false, prunable: false }]);
				const spyOnOpenGitTerminal = jest.spyOn(dataSource, 'openGitTerminal');

				// Run
				onDidReceiveMessage({ command: 'openTerminal', repo: '/path/to/repo', path: '/home/dev/app-wt' });

				// Assert
				await waitForExpect(() => {
					expect(messages).toStrictEqual([{ command: 'openTerminal', error: '/home/dev/app-wt isn\'t a worktree of this repository. Refresh the view, then try again.' }]);
				});
				expect(spyOnOpenGitTerminal).not.toHaveBeenCalled();
				expect(remoteHosts.openTerminal).not.toHaveBeenCalled();
			});
		});

		describe('removeRemoteWorktree', () => {
			it('Should remove the worktree on the host', async () => {
				// Setup
				(remoteHosts.removeWorktree as jest.Mock).mockResolvedValueOnce('Git Tree couldn\'t remove the worktree on "server": it has changes.');

				// Run
				onDidReceiveMessage({ command: 'removeRemoteWorktree', repo: '/path/to/repo', host: 'server', path: '/home/dev/app-wt', force: false });

				// Assert
				await waitForExpect(() => {
					expect(remoteHosts.removeWorktree).toHaveBeenCalledWith('/path/to/repo', 'server', '/home/dev/app-wt', false);
					expect(messages).toStrictEqual([{ command: 'removeRemoteWorktree', error: 'Git Tree couldn\'t remove the worktree on "server": it has changes.' }]);
				});
			});
		});

		describe('Repository Settings', () => {
			it('Should load the hosts, the aliases and the agent instruction', async () => {
				// Run
				onDidReceiveMessage({ command: 'loadRemoteHosts', repo: '/path/to/repo' });

				// Assert
				await waitForExpect(() => {
					expect(remoteHosts.loadSettings).toHaveBeenCalledWith('/path/to/repo');
					expect(messages).toStrictEqual([{
						command: 'loadRemoteHosts',
						repo: '/path/to/repo',
						hosts: [hostSettings],
						configFile: '/path/to/repo/.worktrees/git-tree.yaml',
						configError: null,
						sshAliases: [{ alias: 'gt-test', hostName: '127.0.0.1', user: 'dev' }],
						agentInstruction: 'The instruction',
						error: null
					}]);
				});
			});

			it('Should list a folder on the server', async () => {
				// Run
				onDidReceiveMessage({ command: 'browseRemoteHost', repo: '/path/to/repo', ssh: 'gt-test', path: null });

				// Assert
				await waitForExpect(() => {
					expect(remoteHosts.browse).toHaveBeenCalledWith('gt-test', null);
					expect(messages).toStrictEqual([{ command: 'browseRemoteHost', ssh: 'gt-test', path: '/home/dev', parent: '/home', entries: [{ name: 'app', kind: 'repository' }], truncated: false, error: null }]);
				});
			});

			it('Should send why a folder couldn\'t be listed', async () => {
				// Setup
				(remoteHosts.browse as jest.Mock).mockResolvedValueOnce({ error: 'Git Tree couldn\'t connect to "gt-test".' });

				// Run
				onDidReceiveMessage({ command: 'browseRemoteHost', repo: '/path/to/repo', ssh: 'gt-test', path: '/srv' });

				// Assert
				await waitForExpect(() => expect(messages).toStrictEqual([{ command: 'browseRemoteHost', ssh: 'gt-test', path: '/srv', parent: null, entries: [], truncated: false, error: 'Git Tree couldn\'t connect to "gt-test".' }]));
			});

			it('Should check a host', async () => {
				// Setup
				(remoteHosts.checkHost as jest.Mock).mockResolvedValueOnce('It\'s a different project.');

				// Run
				onDidReceiveMessage({ command: 'checkRemoteHost', repo: '/path/to/repo', ssh: 'gt-test', path: '/home/dev/app' });

				// Assert
				await waitForExpect(() => {
					expect(remoteHosts.checkHost).toHaveBeenCalledWith('/path/to/repo', 'gt-test', '/home/dev/app');
					expect(messages).toStrictEqual([{ command: 'checkRemoteHost', ssh: 'gt-test', path: '/home/dev/app', error: 'It\'s a different project.' }]);
				});
			});

			it('Should save a host', async () => {
				// Run
				onDidReceiveMessage({ command: 'saveRemoteHost', repo: '/path/to/repo', previousName: 'old', host: hostEntry });

				// Assert
				await waitForExpect(() => {
					expect(remoteHosts.saveHost).toHaveBeenCalledWith('/path/to/repo', 'old', hostEntry);
					expect(messages).toStrictEqual([{ command: 'saveRemoteHost', error: null }]);
				});
			});

			it('Should create a repository on a server', async () => {
				// Run
				onDidReceiveMessage({ command: 'createRemoteHostRepository', repo: '/path/to/repo', host: hostEntry, source: { kind: 'clone', remote: 'origin' } });

				// Assert
				await waitForExpect(() => {
					expect(remoteHosts.createRepository).toHaveBeenCalledWith('/path/to/repo', hostEntry, { kind: 'clone', remote: 'origin' });
					expect(messages).toStrictEqual([{ command: 'createRemoteHostRepository', error: null }]);
				});
			});

			it('Should remove a host', async () => {
				// Run
				onDidReceiveMessage({ command: 'removeRemoteHost', repo: '/path/to/repo', name: 'server' });

				// Assert
				await waitForExpect(() => {
					expect(remoteHosts.removeHost).toHaveBeenCalledWith('/path/to/repo', 'server');
					expect(messages).toStrictEqual([{ command: 'removeRemoteHost', error: null }]);
				});
			});

			it('Should run Git on a server', async () => {
				// Setup
				(remoteHosts.runGitOnHost as jest.Mock).mockResolvedValueOnce('Git Tree couldn\'t run git pull --ff-only in /home/dev/app on "server": fatal: Not possible to fast-forward, aborting.');

				// Run
				onDidReceiveMessage({ command: 'runRemoteHostGit', repo: '/path/to/repo', host: 'server', worktreePath: '/home/dev/app', action: 'pull' });

				// Assert
				await waitForExpect(() => {
					expect(remoteHosts.runGitOnHost).toHaveBeenCalledWith('/path/to/repo', 'server', '/home/dev/app', 'pull');
					expect(messages).toStrictEqual([{ command: 'runRemoteHostGit', host: 'server', action: 'pull', error: 'Git Tree couldn\'t run git pull --ff-only in /home/dev/app on "server": fatal: Not possible to fast-forward, aborting.' }]);
				});
			});
		});

		describe('askRemoteHostFetchConsent', () => {
			it('Should ask for the fetch consent, without waiting for the answer', async () => {
				// Setup
				(remoteHosts.askFetchConsent as jest.Mock).mockReturnValueOnce(new Promise(() => { }));

				// Run
				onDidReceiveMessage({ command: 'askRemoteHostFetchConsent', repo: '/path/to/repo', host: 'server' });

				// Assert
				await waitForExpect(() => {
					expect(remoteHosts.askFetchConsent).toHaveBeenCalledWith('/path/to/repo', 'server');
					expect(messages).toStrictEqual([{ command: 'askRemoteHostFetchConsent', error: null }]);
				});
			});
		});

		describe('Without remote hosts', () => {
			it('Should answer each host action with an error', async () => {
				// Setup
				setRemoteHosts(null);

				// Run
				onDidReceiveMessage({ command: 'createRemoteWorktree', repo: '/path/to/repo', host: 'server', path: '/home/dev/app-feature', commitish: 'main', newBranch: null, openInNewWindow: false });
				onDidReceiveMessage({ command: 'openRemoteWorktree', repo: '/path/to/repo', host: 'server', path: '/home/dev/app-wt', newWindow: false });
				onDidReceiveMessage({ command: 'openRemoteTerminal', repo: '/path/to/repo', host: 'server', path: '/home/dev/app-wt' });
				onDidReceiveMessage({ command: 'removeRemoteWorktree', repo: '/path/to/repo', host: 'server', path: '/home/dev/app-wt', force: false });
				onDidReceiveMessage({ command: 'askRemoteHostFetchConsent', repo: '/path/to/repo', host: 'server' });
				onDidReceiveMessage({ command: 'loadRemoteHosts', repo: '/path/to/repo' });
				onDidReceiveMessage({ command: 'browseRemoteHost', repo: '/path/to/repo', ssh: 'gt-test', path: null });
				onDidReceiveMessage({ command: 'saveRemoteHost', repo: '/path/to/repo', previousName: null, host: hostEntry });
				onDidReceiveMessage({ command: 'runRemoteHostGit', repo: '/path/to/repo', host: 'server', worktreePath: '/home/dev/app', action: 'fetch' });

				// Assert
				await waitForExpect(() => expect(messages).toHaveLength(9));
				expect(messages).toEqual(expect.arrayContaining([
					{ command: 'loadRemoteHosts', repo: '/path/to/repo', hosts: [], configFile: null, configError: null, sshAliases: [], agentInstruction: AGENT_INSTRUCTION, error: 'Remote hosts aren\'t available.' },
					{ command: 'browseRemoteHost', ssh: 'gt-test', path: '', parent: null, entries: [], truncated: false, error: 'Remote hosts aren\'t available.' },
					{ command: 'saveRemoteHost', error: 'Remote hosts aren\'t available.' },
					{ command: 'runRemoteHostGit', host: 'server', action: 'fetch', error: 'Remote hosts aren\'t available.' },
					{ command: 'createRemoteWorktree', errors: ['Remote hosts aren\'t available.'] },
					{ command: 'openRemoteWorktree', error: 'Remote hosts aren\'t available.' },
					{ command: 'openRemoteTerminal', error: 'Remote hosts aren\'t available.' },
					{ command: 'removeRemoteWorktree', error: 'Remote hosts aren\'t available.' },
					{ command: 'askRemoteHostFetchConsent', error: 'Remote hosts aren\'t available.' }
				]));
			});
		});
	});

	describe('Manage panel', () => {
		const hostGit: ManagedHostGit = { mainBranch: 'main', mainBranchError: null, worktrees: [] };
		const hostSizes: ManagedHostSizes = { disk: { total: 100, used: 40, free: 60 }, worktrees: [{ path: '/path/to/repo', size: 12 }], gitData: { path: '/path/to/repo/.git', size: 30 }, warning: null };
		let spyOnLoad: jest.SpyInstance;
		let spyOnFastForward: jest.SpyInstance;
		let onDidReceiveMessage: (msg: RequestMessage) => void;
		let messages: ResponseMessage[];

		beforeEach(() => {
			GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);
			const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
			onDidReceiveMessage = mockedWebviewPanel.mocks.panel.webview.onDidReceiveMessage;
			messages = mockedWebviewPanel.mocks.messages;
			spyOnLoad = jest.spyOn(WorktreeStats.prototype, 'load');
			spyOnFastForward = jest.spyOn(WorktreeStats.prototype, 'fastForward');
		});

		afterEach(() => {
			spyOnLoad.mockRestore();
			spyOnFastForward.mockRestore();
		});

		it('Should load each host, and send each part as it arrives', async () => {
			// Setup
			spyOnLoad.mockImplementation(async (_repo: string, host: string | null, send: (answer: WorktreeStatsAnswer) => void) => {
				send({ part: 'git', git: hostGit, sizes: null, error: null });
				send(host === null ? { part: 'sizes', git: null, sizes: hostSizes, error: null } : { part: 'sizes', git: null, sizes: null, error: 'du failed' });
			});

			// Run
			onDidReceiveMessage({ command: 'loadWorktreeStats', repo: '/path/to/repo', hosts: [null, 'server'], requestId: 7 });

			// Assert
			await waitForExpect(() => expect(messages).toHaveLength(4));
			expect(spyOnLoad).toHaveBeenCalledWith('/path/to/repo', null, expect.any(Function));
			expect(spyOnLoad).toHaveBeenCalledWith('/path/to/repo', 'server', expect.any(Function));
			expect(messages).toStrictEqual([
				{ command: 'loadWorktreeStats', repo: '/path/to/repo', requestId: 7, host: null, part: 'git', git: hostGit, sizes: null, error: null },
				{ command: 'loadWorktreeStats', repo: '/path/to/repo', requestId: 7, host: null, part: 'sizes', git: null, sizes: hostSizes, error: null },
				{ command: 'loadWorktreeStats', repo: '/path/to/repo', requestId: 7, host: 'server', part: 'git', git: hostGit, sizes: null, error: null },
				{ command: 'loadWorktreeStats', repo: '/path/to/repo', requestId: 7, host: 'server', part: 'sizes', git: null, sizes: null, error: 'du failed' }
			]);
		});

		it('Should refuse a repository that isn\'t in Git Tree, without reading or fast-forwarding it', async () => {
			// Run
			onDidReceiveMessage({ command: 'loadWorktreeStats', repo: '/path/to/unknown', hosts: [null, 'server'], requestId: 3 });
			onDidReceiveMessage({ command: 'fastForwardWorktree', repo: '/path/to/unknown', host: null, path: '/path/to/unknown/.worktrees/feature' });

			// Assert
			await waitForExpect(() => expect(messages).toHaveLength(3));
			expect(spyOnLoad).not.toHaveBeenCalled();
			expect(spyOnFastForward).not.toHaveBeenCalled();
			expect(messages).toStrictEqual([
				{ command: 'loadWorktreeStats', repo: '/path/to/unknown', requestId: 3, host: null, part: 'git', git: null, sizes: null, error: 'The repository /path/to/unknown isn\'t in Git Tree.' },
				{ command: 'loadWorktreeStats', repo: '/path/to/unknown', requestId: 3, host: 'server', part: 'git', git: null, sizes: null, error: 'The repository /path/to/unknown isn\'t in Git Tree.' },
				{ command: 'fastForwardWorktree', repo: '/path/to/unknown', host: null, path: '/path/to/unknown/.worktrees/feature', error: 'The repository /path/to/unknown isn\'t in Git Tree.' }
			]);
		});

		it('Should answer other messages while the sizes are measured', async () => {
			// Setup
			spyOnLoad.mockImplementation((_repo: string, _host: string | null, send: (answer: WorktreeStatsAnswer) => void) => {
				send({ part: 'git', git: hostGit, sizes: null, error: null });
				return new Promise(() => { });
			});
			spyOnFastForward.mockResolvedValueOnce(null);

			// Run
			onDidReceiveMessage({ command: 'loadWorktreeStats', repo: '/path/to/repo', hosts: [null], requestId: 1 });
			onDidReceiveMessage({ command: 'fastForwardWorktree', repo: '/path/to/repo', host: null, path: '/path/to/repo/.worktrees/feature' });

			// Assert
			await waitForExpect(() => expect(messages).toHaveLength(2));
			expect(messages[1]).toStrictEqual({ command: 'fastForwardWorktree', repo: '/path/to/repo', host: null, path: '/path/to/repo/.worktrees/feature', error: null });
		});

		it('Should fast-forward a worktree, and send the error', async () => {
			// Setup
			spyOnFastForward.mockResolvedValueOnce('Git Tree didn\'t fast-forward /home/dev/app-wt on "server": Diverged from main.');

			// Run
			onDidReceiveMessage({ command: 'fastForwardWorktree', repo: '/path/to/repo', host: 'server', path: '/home/dev/app-wt' });

			// Assert
			await waitForExpect(() => {
				expect(spyOnFastForward).toHaveBeenCalledWith('/path/to/repo', 'server', '/home/dev/app-wt');
				expect(messages).toStrictEqual([{ command: 'fastForwardWorktree', repo: '/path/to/repo', host: 'server', path: '/home/dev/app-wt', error: 'Git Tree didn\'t fast-forward /home/dev/app-wt on "server": Diverged from main.' }]);
			});
		});
	});

	describe('Hosts panel', () => {
		let spyOnWatch: jest.SpyInstance;
		let spyOnStop: jest.SpyInstance;
		let spyOnSetVisible: jest.SpyInstance;
		let onDidReceiveMessage: (msg: RequestMessage) => void;
		let mockedWebviewPanel: ReturnType<typeof vscode.getMockedWebviewPanel>;

		beforeEach(() => {
			spyOnWatch = jest.spyOn(HostStats.prototype, 'watch').mockImplementation(() => { });
			spyOnStop = jest.spyOn(HostStats.prototype, 'stop');
			spyOnSetVisible = jest.spyOn(HostStats.prototype, 'setVisible');
			GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);
			mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
			onDidReceiveMessage = mockedWebviewPanel.mocks.panel.webview.onDidReceiveMessage;
		});

		afterEach(() => {
			spyOnWatch.mockRestore();
			spyOnStop.mockRestore();
			spyOnSetVisible.mockRestore();
		});

		it('Should watch the hosts the panel shows', () => {
			// Run
			onDidReceiveMessage({ command: 'watchHostStats', repo: '/path/to/repo', hosts: [null, 'server'], refresh: true });

			// Assert
			expect(spyOnWatch).toHaveBeenCalledWith('/path/to/repo', [null, 'server'], true);
			expect(mockedWebviewPanel.mocks.messages).toStrictEqual([]);
		});

		it('Should refuse a repository that isn\'t in Git Tree, without reading its hosts', () => {
			// Run
			onDidReceiveMessage({ command: 'watchHostStats', repo: '/path/to/unknown', hosts: [null, 'server'], refresh: false });

			// Assert
			expect(spyOnWatch).not.toHaveBeenCalled();
			expect(spyOnStop).toHaveBeenCalled();
			expect(mockedWebviewPanel.mocks.messages).toStrictEqual([
				{ command: 'hostStats', repo: '/path/to/unknown', host: null, usage: null, error: 'The repository /path/to/unknown isn\'t in Git Tree.' },
				{ command: 'hostStats', repo: '/path/to/unknown', host: 'server', usage: null, error: 'The repository /path/to/unknown isn\'t in Git Tree.' }
			]);
		});

		it('Should send each host\'s answer to the view', () => {
			// Run
			GitTreeView.currentPanel!['hostStats']['send']({ repo: '/path/to/repo', host: 'server', usage: null, error: 'Git Tree couldn\'t connect to "server".' });

			// Assert
			expect(mockedWebviewPanel.mocks.messages).toStrictEqual([{ command: 'hostStats', repo: '/path/to/repo', host: 'server', usage: null, error: 'Git Tree couldn\'t connect to "server".' }]);
		});

		it('Should pause while the view is hidden, and stop when the page is rebuilt or the view is closed', () => {
			// Run
			mockedWebviewPanel.mocks.panel.setVisibility(false);

			// Assert
			expect(spyOnSetVisible).toHaveBeenLastCalledWith(false);

			// Run
			spyOnStop.mockClear();
			vscode.mockExtensionSettingReturnValue('panelPosition', 'topRight');
			mockedWebviewPanel.mocks.panel.setVisibility(true);

			// Assert: the setting changed while the view was hidden, so the page was rebuilt with it
			expect(spyOnStop).toHaveBeenCalled();
			expect(spyOnSetVisible).toHaveBeenLastCalledWith(true);
			expect(mockedWebviewPanel.panel.webview.html).toContain('"panelPosition":"topRight"');

			// Run
			spyOnStop.mockClear();
			GitTreeView.currentPanel!.dispose();

			// Assert
			expect(spyOnStop).toHaveBeenCalled();
		});

		it('Should give the view the panel position, centred by default', () => {
			// Assert
			expect(mockedWebviewPanel.panel.webview.html).toContain('"panelPosition":"center"');
		});
	});

	describe('sendMessage', () => {
		beforeEach(() => {
			GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);
			spyOnLog.mockReset();
			spyOnLogError.mockReset();
		});

		it('Should send a message to the Webview', async () => {
			// Setup
			const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
			jest.spyOn(utils, 'viewScm').mockResolvedValueOnce(null);
			jest.spyOn(mockedWebviewPanel.panel.webview, 'postMessage').mockResolvedValueOnce(true);

			// Run
			mockedWebviewPanel.mocks.panel.webview.onDidReceiveMessage({
				command: 'viewScm'
			});

			// Assert
			await waitForExpect(() => {
				expect(mockedWebviewPanel.panel.webview.postMessage).toHaveBeenCalledWith({
					command: 'viewScm',
					error: null
				});
				expect(spyOnLog).not.toHaveBeenCalled();
				expect(spyOnLogError).not.toHaveBeenCalled();
			});
		});

		it('Should log an error message when Webview.postMessage rejects, and the GitTreeView hasn\'t been disposed', async () => {
			// Setup
			const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
			jest.spyOn(utils, 'viewScm').mockResolvedValueOnce(null);
			jest.spyOn(mockedWebviewPanel.panel.webview, 'postMessage').mockRejectedValueOnce(null);

			// Run
			mockedWebviewPanel.mocks.panel.webview.onDidReceiveMessage({
				command: 'viewScm'
			});

			// Assert
			await waitForExpect(() => {
				expect(mockedWebviewPanel.panel.webview.postMessage).toHaveBeenCalledWith({
					command: 'viewScm',
					error: null
				});
				expect(spyOnLog).not.toHaveBeenCalled();
				expect(spyOnLogError).toHaveBeenCalledWith('Unable to send "viewScm" message to the Git Tree View.');
			});
		});

		it('Should log an information message when Webview.postMessage rejects, and the GitTreeView has been disposed', async () => {
			// Setup
			const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
			jest.spyOn(utils, 'viewScm').mockResolvedValueOnce(null);
			jest.spyOn(mockedWebviewPanel.panel.webview, 'postMessage').mockImplementationOnce(() => {
				GitTreeView.currentPanel!.dispose();
				return Promise.reject();
			});

			// Run
			mockedWebviewPanel.mocks.panel.webview.onDidReceiveMessage({
				command: 'viewScm'
			});

			// Assert
			await waitForExpect(() => {
				expect(mockedWebviewPanel.panel.webview.postMessage).toHaveBeenCalledWith({
					command: 'viewScm',
					error: null
				});
				expect(spyOnLog).toHaveBeenCalledWith('The Git Tree View was disposed while sending "viewScm" message.');
				expect(spyOnLogError).not.toHaveBeenCalled();
			});
		});

		it('Shouldn\'t send a message to the Webview if it has been disposed', async () => {
			// Setup
			const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
			jest.spyOn(utils, 'viewScm').mockResolvedValueOnce(null);
			jest.spyOn(mockedWebviewPanel.panel.webview, 'postMessage').mockResolvedValueOnce(true);

			// Run
			GitTreeView.currentPanel!.dispose();
			mockedWebviewPanel.mocks.panel.webview.onDidReceiveMessage({
				command: 'viewScm'
			});

			// Assert
			await waitForExpect(() => {
				expect(mockedWebviewPanel.panel.webview.postMessage).not.toHaveBeenCalled();
				expect(spyOnLog).toHaveBeenCalledWith('The Git Tree View has already been disposed, ignored sending "viewScm" message.');
				expect(spyOnLogError).not.toHaveBeenCalled();
			});
		});
	});

	describe('getHtmlForWebview', () => {
		beforeEach(() => {
			jest.spyOn(utils, 'getNonce').mockReturnValueOnce('1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d');
		});
		afterEach(() => {
			// Assert
			const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
			expect(mockedWebviewPanel.panel.webview.html).toContain('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src vscode-webview-resource: \'unsafe-inline\'; script-src \'nonce-1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d\'; img-src data:;">');
			expect(mockedWebviewPanel.panel.webview.html).toContain('<link rel="stylesheet" type="text/css" href="vscode-webview-resource://file///path/to/extension/media/out.min.css">');
			expect(mockedWebviewPanel.panel.webview.html).toContain('<title>Git Tree</title>');
			expect(mockedWebviewPanel.panel.webview.html).toContain('<style>body{--git-tree-color0:#0085d9; --git-tree-color1:#d9008f; --git-tree-color2:#00d90a; --git-tree-color3:#d98500; --git-tree-color4:#a300d9; --git-tree-color5:#ff0000; --git-tree-color6:#00d9cc; --git-tree-color7:#e138e8; --git-tree-color8:#85d900; --git-tree-color9:#dc5b23; --git-tree-color10:#6f24d6; --git-tree-color11:#ffcc00; } body.vscode-light, body.vscode-high-contrast-light{--git-tree-color0:#0070b8; --git-tree-color1:#b8007a; --git-tree-color2:#00a307; --git-tree-color3:#b86f00; --git-tree-color4:#8a00b8; --git-tree-color5:#d60000; --git-tree-color6:#00a399; --git-tree-color7:#b51fbd; --git-tree-color8:#5f9c00; --git-tree-color9:#c2491a; --git-tree-color10:#5a1bb0; --git-tree-color11:#a88600; } [data-color=\"0\"]{--git-tree-color:var(--git-tree-color0);} [data-color=\"1\"]{--git-tree-color:var(--git-tree-color1);} [data-color=\"2\"]{--git-tree-color:var(--git-tree-color2);} [data-color=\"3\"]{--git-tree-color:var(--git-tree-color3);} [data-color=\"4\"]{--git-tree-color:var(--git-tree-color4);} [data-color=\"5\"]{--git-tree-color:var(--git-tree-color5);} [data-color=\"6\"]{--git-tree-color:var(--git-tree-color6);} [data-color=\"7\"]{--git-tree-color:var(--git-tree-color7);} [data-color=\"8\"]{--git-tree-color:var(--git-tree-color8);} [data-color=\"9\"]{--git-tree-color:var(--git-tree-color9);} [data-color=\"10\"]{--git-tree-color:var(--git-tree-color10);} [data-color=\"11\"]{--git-tree-color:var(--git-tree-color11);} </style>');
		});

		it('Should get HTML when no Git executable is known', () => {
			// Setup
			spyOnGetGitExecutableError.mockReturnValueOnce(utils.UNABLE_TO_FIND_GIT_MSG);

			// Run
			GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);

			// Assert
			const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
			expect(mockedWebviewPanel.panel.webview.html).toContain('<h2>Unable to load Git Tree</h2>');
			expect(mockedWebviewPanel.panel.webview.html).toContain('<p class="unableToLoadMessage">' + utils.escapeHtml(utils.UNABLE_TO_FIND_GIT_MSG) + '</p>');
		});

		it('Should get HTML when the Git executable is older than Git Tree\'s minimum Git version', () => {
			// Setup
			spyOnGetGitExecutableError.mockReturnValueOnce(utils.constructIncompatibleGitVersionMessage({ path: '/path/to/<old>-git', version: '2.30.9' }));

			// Run
			GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);

			// Assert
			const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
			expect(mockedWebviewPanel.panel.webview.html).toContain('<h2>Unable to load Git Tree</h2>');
			expect(mockedWebviewPanel.panel.webview.html).toContain('<p class="unableToLoadMessage">Git Tree needs Git 2.31.0 or later, but the Git executable it found (&#34;/path/to/&#60;old&#62;-git&#34;) is version 2.30.9. Upgrade Git, or set the Visual Studio Code Setting &#34;git.path&#34; to a newer Git executable, then reload the window.</p>');
			expect(mockedWebviewPanel.panel.webview.html).not.toContain('<div id="view"');
		});

		it('Should get HTML when no repositories are found in the workspace', () => {
			// Setup
			spyOnGetRepos.mockResolvedValueOnce({});

			// Run
			GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);

			// Assert
			const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
			expect(mockedWebviewPanel.panel.webview.html).toContain('<h2>Unable to load Git Tree</h2>');
			expect(mockedWebviewPanel.panel.webview.html).toContain('No Git repositories were found in the current workspace when it was last scanned by Git Tree.');
			expect(mockedWebviewPanel.panel.webview.html).toContain('<script nonce="1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d">');
		});

		it('Should get HTML when repositories exist', () => {
			// Setup
			const spyOnIsAvatarStorageAvailable = jest.spyOn(extensionState, 'isAvatarStorageAvailable');
			vscode.mockExtensionSettingReturnValue('repository.commits.fetchAvatars', false);

			// Run
			GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);

			// Assert
			const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
			expect(mockedWebviewPanel.panel.webview.html).toContain('<div id="view" tabindex="-1">');
			expect(mockedWebviewPanel.panel.webview.html).toContain('<script nonce="1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d">');
			expect(mockedWebviewPanel.panel.webview.html).toContain('<script nonce="1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d" src="vscode-webview-resource://file///path/to/extension/media/out.min.js"></script>');
			expect(spyOnIsAvatarStorageAvailable).not.toHaveBeenCalled();
		});

		it('Should get HTML when repositories exist (fetch avatars enabled)', () => {
			// Setup
			const spyOnIsAvatarStorageAvailable = jest.spyOn(extensionState, 'isAvatarStorageAvailable');
			vscode.mockExtensionSettingReturnValue('repository.commits.fetchAvatars', true);

			// Run
			GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);

			// Assert
			const mockedWebviewPanel = vscode.getMockedWebviewPanel(0);
			expect(mockedWebviewPanel.panel.webview.html).toContain('<div id="view" tabindex="-1">');
			expect(mockedWebviewPanel.panel.webview.html).toContain('<script nonce="1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d">');
			expect(mockedWebviewPanel.panel.webview.html).toContain('<script nonce="1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d" src="vscode-webview-resource://file///path/to/extension/media/out.min.js"></script>');
			expect(spyOnIsAvatarStorageAvailable).toHaveBeenCalledWith();
		});

		it('Should put the dropdowns in the top bar, and the buttons in the bottom bar', () => {
			// Run
			GitTreeView.createOrShow('/path/to/extension', dataSource, extensionState, avatarManager, repoManager, logger, null);

			// Assert
			const html = vscode.getMockedWebviewPanel(0).panel.webview.html;
			const controls = html.substring(html.indexOf('<div id="controls">'), html.indexOf('<div id="content">'));
			expect(controls.match(/ id="\w+"/g)).toStrictEqual([' id="controls"', ' id="repoControl"', ' id="repoDropdown"', ' id="branchControl"', ' id="branchDropdown"', ' id="hostControl"', ' id="hostDropdown"', ' id="worktreeControl"', ' id="worktreeDropdown"']);
			const bottomBar = html.substring(html.indexOf('<div id="bottomBar"'), html.indexOf('<div id="scrollShadow">'));
			expect(bottomBar.split('<div class="bottomBarGroup">').slice(1).map((group) => group.match(/ id="\w+"/g))).toStrictEqual([
				[' id="refreshBtn"', ' id="fetchBtn"', ' id="findBtn"', ' id="terminalBtn"'],
				[' id="manageBtn"', ' id="hostsBtn"', ' id="issuesBtn"', ' id="settingsBtn"']
			]);
			expect(bottomBar.match(/ data-panel="\w+"/g)).toStrictEqual([' data-panel="manage"', ' data-panel="hosts"', ' data-panel="issues"', ' data-panel="repository"']);
			// The bar is outside the scrolling view, so the view's commits and footer end above it
			expect(html.indexOf('<div id="bottomBar"')).toBeGreaterThan(html.indexOf('<div id="footer"></div>\n\t\t\t</div>'));
		});
	});
});

describe('standardiseCspSource', () => {
	it('Should not affect vscode-resource scheme-only sources', () => {
		// Run
		const result = standardiseCspSource('vscode-resource:');

		// Assert
		expect(result).toBe('vscode-resource:');
	});

	it('Should not affect file scheme-only sources', () => {
		// Run
		const result = standardiseCspSource('file:');

		// Assert
		expect(result).toBe('file:');
	});

	it('Should not affect http scheme-only sources', () => {
		// Run
		const result = standardiseCspSource('http:');

		// Assert
		expect(result).toBe('http:');
	});

	it('Should not affect https scheme-only sources', () => {
		// Run
		const result = standardiseCspSource('https:');

		// Assert
		expect(result).toBe('https:');
	});

	it('Should not affect file scheme sources', () => {
		// Run
		const result = standardiseCspSource('file://server');

		// Assert
		expect(result).toBe('file://server');
	});

	it('Should not affect http host-only sources', () => {
		// Run
		const result = standardiseCspSource('http://www.example.com');

		// Assert
		expect(result).toBe('http://www.example.com');
	});

	it('Should not affect https host-only sources', () => {
		// Run
		const result = standardiseCspSource('https://www.example.com');

		// Assert
		expect(result).toBe('https://www.example.com');
	});

	it('Should not affect https host-only IP sources', () => {
		// Run
		const result = standardiseCspSource('https://192.168.1.101');

		// Assert
		expect(result).toBe('https://192.168.1.101');
	});

	it('Should remove the path component from http sources', () => {
		// Run
		const result = standardiseCspSource('http://www.example.com/path/to/file');

		// Assert
		expect(result).toBe('http://www.example.com');
	});

	it('Should remove the path component from https sources', () => {
		// Run
		const result = standardiseCspSource('https://www.example.com/path/to/file');

		// Assert
		expect(result).toBe('https://www.example.com');
	});

	it('Should remove the path component from https IP sources', () => {
		// Run
		const result = standardiseCspSource('https://192.168.1.101:8080/path/to/file');

		// Assert
		expect(result).toBe('https://192.168.1.101:8080');
	});

	it('Should remove the query from http/https sources', () => {
		// Run
		const result = standardiseCspSource('https://www.example.com?query');

		// Assert
		expect(result).toBe('https://www.example.com');
	});

	it('Should remove the fragment from http/https sources', () => {
		// Run
		const result = standardiseCspSource('https://www.example.com#fragment');

		// Assert
		expect(result).toBe('https://www.example.com');
	});

	it('Should remove the path, query & fragment from http/https sources', () => {
		// Run
		const result = standardiseCspSource('https://www.example.com:443/path/to/file?query#fragment');

		// Assert
		expect(result).toBe('https://www.example.com:443');
	});
});
