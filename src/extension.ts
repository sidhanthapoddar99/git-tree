import * as vscode from 'vscode';
import { AvatarManager } from './avatarManager';
import { CommandManager } from './commands';
import { getConfig } from './config';
import { DataSource } from './dataSource';
import { DiffDocProvider } from './diffDocProvider';
import { loadEngine } from './engine';
import { ExtensionState } from './extensionState';
import { GIT_TREE_VIEW_TYPE, GitTreeView } from './gitTreeView';
import { Logger } from './logger';
import { RemoteHosts } from './remoteHosts';
import { RepoManager } from './repoManager';
import { StatusBarItem } from './statusBarItem';
import { GitExecutable, findGit, getGitExecutableError, getGitExecutableFromPaths, showErrorMessage, showInformationMessage } from './utils';
import { EventEmitter } from './utils/event';

/**
 * Activate Git Tree.
 * @param context The context of the extension.
 */
export async function activate(context: vscode.ExtensionContext) {
	const logger = new Logger();
	logger.log('Starting Git Tree ...');

	const gitExecutableEmitter = new EventEmitter<GitExecutable>();
	const onDidChangeGitExecutable = gitExecutableEmitter.subscribe;

	const extensionState = new ExtensionState(context, onDidChangeGitExecutable);

	let gitExecutable: GitExecutable | null;
	try {
		gitExecutable = await findGit(extensionState);
		gitExecutableEmitter.emit(gitExecutable);
		logger.log('Using ' + gitExecutable.path + ' (version: ' + gitExecutable.version + ')');
	} catch (_) {
		gitExecutable = null;
	}
	const loaded = loadEngine(logger);
	const engineError = 'error' in loaded ? loaded.error : null;
	// Why Git Tree can't run with a Git executable: an engine that didn't load stops it, whichever Git is used
	const getStartupError = (gitExecutable: GitExecutable | null) => engineError !== null ? engineError : getGitExecutableError(gitExecutable);
	const startupError = getStartupError(gitExecutable);
	if (startupError !== null) {
		showErrorMessage(startupError);
		logger.logError(startupError);
	}

	const configurationEmitter = new EventEmitter<vscode.ConfigurationChangeEvent>();
	const onDidChangeConfiguration = configurationEmitter.subscribe;

	const remoteHosts = new RemoteHosts(extensionState, gitExecutable, onDidChangeGitExecutable, logger);
	const dataSource = new DataSource(gitExecutable, onDidChangeConfiguration, onDidChangeGitExecutable, logger, 'engine' in loaded ? loaded.engine : null, engineError, remoteHosts);
	const avatarManager = new AvatarManager(dataSource, extensionState, logger);
	const repoManager = new RepoManager(dataSource, extensionState, onDidChangeConfiguration, logger);
	const statusBarItem = new StatusBarItem(repoManager.getNumRepos(), repoManager.onDidChangeRepos, onDidChangeConfiguration, logger);
	const commandManager = new CommandManager(context, avatarManager, dataSource, extensionState, repoManager, gitExecutable, onDidChangeGitExecutable, logger);
	const diffDocProvider = new DiffDocProvider(dataSource);

	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(DiffDocProvider.scheme, diffDocProvider),
		// Bring back the Git Tree View tabs that were open when Visual Studio Code closed, in the places they had
		vscode.window.registerWebviewPanelSerializer(GIT_TREE_VIEW_TYPE, {
			deserializeWebviewPanel: async (panel, state) => GitTreeView.revive(panel, state, context.extensionPath, dataSource, extensionState, avatarManager, repoManager, logger)
		}),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('git-tree')) {
				configurationEmitter.emit(event);
			} else if (event.affectsConfiguration('git.path')) {
				const paths = getConfig().gitPaths;
				if (paths.length === 0) return;

				getGitExecutableFromPaths(paths).then((gitExecutable) => {
					gitExecutableEmitter.emit(gitExecutable);
					const gitExecutableError = getStartupError(gitExecutable);
					if (gitExecutableError !== null) {
						showErrorMessage(gitExecutableError);
						logger.logError(gitExecutableError);
						return;
					}
					const msg = 'Git Tree is now using ' + gitExecutable.path + ' (version: ' + gitExecutable.version + ')';
					showInformationMessage(msg);
					logger.log(msg);
					repoManager.searchWorkspaceForRepos();
				}, () => {
					const msg = 'The new value of "git.path" ("' + paths.join('", "') + '") does not ' + (paths.length > 1 ? 'contain a string that matches' : 'match') + ' the path and filename of a valid Git executable.';
					showErrorMessage(msg);
					logger.logError(msg);
				});
			}
		}),
		diffDocProvider,
		commandManager,
		statusBarItem,
		repoManager,
		avatarManager,
		dataSource,
		configurationEmitter,
		extensionState,
		gitExecutableEmitter,
		logger
	);
	logger.log('Started Git Tree - Ready to use!');

	extensionState.expireOldCodeReviews();
}

/**
 * Deactivate Git Tree.
 */
export function deactivate() { }
