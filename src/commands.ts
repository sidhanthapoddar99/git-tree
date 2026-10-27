import * as os from 'os';
import * as vscode from 'vscode';
import { AvatarManager } from './avatarManager';
import { getConfig } from './config';
import { DataSource } from './dataSource';
import { DiffDocProvider, decodeDiffDocUri } from './diffDocProvider';
import { CodeReviewData, CodeReviews, ExtensionState } from './extensionState';
import { GitTreeView } from './gitTreeView';
import { Logger } from './logger';
import { CONFIG_FILE, validateHostName, validateServerPath, validateSshAlias } from './remoteHosts/config';
import { RepoManager } from './repoManager';
import { GitExecutable, VsCodeVersionRequirement, abbrevCommit, abbrevText, copyToClipboard, doesVersionMeetRequirement, getExtensionVersion, getPathFromUri, getRelativeTimeDiff, getRepoName, getSortedRepositoryPaths, isPathInWorkspace, openFile, resolveToSymbolicPath, showErrorMessage, showInformationMessage } from './utils';
import { Disposable } from './utils/disposable';
import { Event } from './utils/event';

/**
 * Manages the registration and execution of Git Tree Commands.
 */
export class CommandManager extends Disposable {
	private readonly context: vscode.ExtensionContext;
	private readonly avatarManager: AvatarManager;
	private readonly dataSource: DataSource;
	private readonly extensionState: ExtensionState;
	private readonly logger: Logger;
	private readonly repoManager: RepoManager;
	private gitExecutable: GitExecutable | null;

	/**
	 * Creates the Git Tree Command Manager.
	 * @param extensionPath The absolute file path of the directory containing the extension.
	 * @param avatarManger The Git Tree AvatarManager instance.
	 * @param dataSource The Git Tree DataSource instance.
	 * @param extensionState The Git Tree ExtensionState instance.
	 * @param repoManager The Git Tree RepoManager instance.
	 * @param gitExecutable The Git executable available to Git Tree at startup.
	 * @param onDidChangeGitExecutable The Event emitting the Git executable for Git Tree to use.
	 * @param logger The Git Tree Logger instance.
	 */
	constructor(context: vscode.ExtensionContext, avatarManger: AvatarManager, dataSource: DataSource, extensionState: ExtensionState, repoManager: RepoManager, gitExecutable: GitExecutable | null, onDidChangeGitExecutable: Event<GitExecutable>, logger: Logger) {
		super();
		this.context = context;
		this.avatarManager = avatarManger;
		this.dataSource = dataSource;
		this.extensionState = extensionState;
		this.logger = logger;
		this.repoManager = repoManager;
		this.gitExecutable = gitExecutable;

		// Register Extension Commands
		this.registerCommand('git-tree.view', (arg) => this.view(arg));
		this.registerCommand('git-tree.viewInNewTab', () => this.viewInNewTab());
		this.registerCommand('git-tree.addGitRepository', () => this.addGitRepository());
		this.registerCommand('git-tree.removeGitRepository', () => this.removeGitRepository());
		this.registerCommand('git-tree.addRemoteHost', () => this.addRemoteHost());
		this.registerCommand('git-tree.removeRemoteHost', () => this.removeRemoteHost());
		this.registerCommand('git-tree.clearAvatarCache', () => this.clearAvatarCache());
		this.registerCommand('git-tree.fetch', () => this.fetch());
		this.registerCommand('git-tree.endAllWorkspaceCodeReviews', () => this.endAllWorkspaceCodeReviews());
		this.registerCommand('git-tree.endSpecificWorkspaceCodeReview', () => this.endSpecificWorkspaceCodeReview());
		this.registerCommand('git-tree.resumeWorkspaceCodeReview', () => this.resumeWorkspaceCodeReview());
		this.registerCommand('git-tree.version', () => this.version());
		this.registerCommand('git-tree.openFile', (arg) => this.openFile(arg));

		this.registerDisposable(
			onDidChangeGitExecutable((gitExecutable) => {
				this.gitExecutable = gitExecutable;
			})
		);

		// Register Extension Contexts
		try {
			this.registerContext('git-tree:codiconsSupported', doesVersionMeetRequirement(vscode.version, VsCodeVersionRequirement.Codicons));
		} catch (_) {
			this.logger.logError('Unable to set Visual Studio Code Context "git-tree:codiconsSupported"');
		}
	}

	/**
	 * Register a Git Tree command with Visual Studio Code.
	 * @param command A unique identifier for the command.
	 * @param callback A command handler function.
	 */
	private registerCommand(command: string, callback: (...args: any[]) => any) {
		this.registerDisposable(
			vscode.commands.registerCommand(command, (...args: any[]) => {
				this.logger.log('Command Invoked: ' + command);
				callback(...args);
			})
		);
	}

	/**
	 * Register a context with Visual Studio Code.
	 * @param key The Context Key.
	 * @param value The Context Value.
	 */
	private registerContext(key: string, value: any) {
		return vscode.commands.executeCommand('setContext', key, value).then(
			() => this.logger.log('Successfully set Visual Studio Code Context "' + key + '" to "' + JSON.stringify(value) + '"'),
			() => this.logger.logError('Failed to set Visual Studio Code Context "' + key + '" to "' + JSON.stringify(value) + '"')
		);
	}


	/* Commands */

	/**
	 * The method run when the `git-tree.view` command is invoked.
	 * @param arg An optional argument passed to the command (when invoked from the Visual Studio Code Git Extension).
	 */
	private async view(arg: any) {
		let loadRepo: string | null = null;

		if (typeof arg === 'object' && arg !== null && arg.rootUri) {
			// If command is run from the Visual Studio Code Source Control View, load the specific repo
			const repoPath = getPathFromUri(arg.rootUri);
			loadRepo = await this.repoManager.getKnownRepo(repoPath);
			if (loadRepo === null) {
				// The repo is not currently known, add it
				loadRepo = (await this.repoManager.registerRepo(await resolveToSymbolicPath(repoPath), true)).root;
			}
		} else if (getConfig().openToTheRepoOfTheActiveTextEditorDocument && vscode.window.activeTextEditor) {
			// If the config setting is enabled, load the repo containing the active text editor document
			loadRepo = this.repoManager.getRepoContainingFile(getPathFromUri(vscode.window.activeTextEditor.document.uri));
		}

		GitTreeView.createOrShow(this.context.extensionPath, this.dataSource, this.extensionState, this.avatarManager, this.repoManager, this.logger, loadRepo !== null ? { repo: loadRepo } : null);
	}

	/**
	 * The method run when the `git-tree.viewInNewTab` command is invoked.
	 */
	private viewInNewTab() {
		const repos = this.repoManager.getRepos();
		const repoPaths = getSortedRepositoryPaths(repos, getConfig().repoDropdownOrder);

		if (repoPaths.length > 1) {
			const items: vscode.QuickPickItem[] = repoPaths.map((path) => ({
				label: repos[path].name || getRepoName(path),
				description: path
			}));

			vscode.window.showQuickPick(items, {
				placeHolder: 'Select the repository you want to open in a new Git Tree tab:',
				canPickMany: false
			}).then((item) => {
				if (item && item.description) {
					GitTreeView.createOrShow(this.context.extensionPath, this.dataSource, this.extensionState, this.avatarManager, this.repoManager, this.logger, { repo: item.description }, true);
				}
			}, () => {
				showErrorMessage('An unexpected error occurred while running the command "View Git Tree in New Tab".');
			});
		} else {
			GitTreeView.createOrShow(this.context.extensionPath, this.dataSource, this.extensionState, this.avatarManager, this.repoManager, this.logger, repoPaths.length === 1 ? { repo: repoPaths[0] } : null, true);
		}
	}

	/**
	 * The method run when the `git-tree.addGitRepository` command is invoked.
	 */
	private addGitRepository() {
		const gitExecutableError = this.dataSource.getGitExecutableError();
		if (gitExecutableError !== null) {
			showErrorMessage(gitExecutableError);
			return;
		}

		vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false }).then(uris => {
			if (uris && uris.length > 0) {
				let path = getPathFromUri(uris[0]);
				if (isPathInWorkspace(path)) {
					this.repoManager.registerRepo(path, false).then(status => {
						if (status.error === null) {
							showInformationMessage('The repository "' + status.root! + '" was added to Git Tree.');
						} else {
							showErrorMessage(status.error + ' Therefore it could not be added to Git Tree.');
						}
					});
				} else {
					showErrorMessage('The folder "' + path + '" is not within the opened Visual Studio Code workspace, and therefore could not be added to Git Tree.');
				}
			}
		}, () => { });
	}

	/**
	 * The method run when the `git-tree.removeGitRepository` command is invoked.
	 */
	private removeGitRepository() {
		const gitExecutableError = this.dataSource.getGitExecutableError();
		if (gitExecutableError !== null) {
			showErrorMessage(gitExecutableError);
			return;
		}

		const repos = this.repoManager.getRepos();
		const items: vscode.QuickPickItem[] = getSortedRepositoryPaths(repos, getConfig().repoDropdownOrder).map((path) => ({
			label: repos[path].name || getRepoName(path),
			description: path
		}));

		vscode.window.showQuickPick(items, {
			placeHolder: 'Select a repository to remove from Git Tree:',
			canPickMany: false
		}).then((item) => {
			if (item && item.description !== undefined) {
				if (this.repoManager.ignoreRepo(item.description)) {
					showInformationMessage('The repository "' + item.label + '" was removed from Git Tree.');
				} else {
					showErrorMessage('The repository "' + item.label + '" is not known to Git Tree.');
				}
			}
		}, () => { });
	}

	/**
	 * The method run when the `git-tree.addRemoteHost` command is invoked. It asks for the host's name, SSH alias and
	 * path, and RemoteHosts checks the connection and the project before it writes `.worktrees/git-tree.yaml`.
	 */
	private async addRemoteHost() {
		const remoteHosts = this.dataSource.remoteHosts;
		const repo = await this.pickRepoForRemoteHosts('Select the repository to add a remote host to:');
		if (remoteHosts === null || repo === null) return;

		const existing = (await remoteHosts.loadHosts(repo)).map((snapshot) => snapshot.host.name.toLowerCase());
		const name = await vscode.window.showInputBox({
			title: 'Add Remote Host (1/3)',
			prompt: 'The host\'s name, shown in the graph: letters, digits, - and _.',
			placeHolder: 'build-box',
			ignoreFocusOut: true,
			validateInput: (value) => validateHostName(value) || (existing.indexOf(value.toLowerCase()) > -1 ? 'The repository already has a host named "' + value + '".' : null)
		});
		if (typeof name === 'undefined') return;

		const ssh = await this.pickSshAlias(remoteHosts.getSshAliases());
		if (ssh === null) return;

		const serverPath = await vscode.window.showInputBox({
			title: 'Add Remote Host (3/3)',
			prompt: 'The absolute path of the repository\'s main worktree on "' + ssh + '".',
			placeHolder: '/home/user/projects/app',
			ignoreFocusOut: true,
			validateInput: (value) => validateServerPath(value)
		});
		if (typeof serverPath === 'undefined') return;

		const errorInfo = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Checking ' + ssh + ':' + serverPath + '...' }, () => remoteHosts.addHost(repo, name, ssh, serverPath));
		if (errorInfo === null) {
			showInformationMessage('The remote host "' + name + '" was added to ' + CONFIG_FILE + '.');
		} else {
			showErrorMessage('The remote host "' + name + '" wasn\'t added: ' + errorInfo);
		}
	}

	/**
	 * The method run when the `git-tree.removeRemoteHost` command is invoked. It removes the host's entry from
	 * `.worktrees/git-tree.yaml`, and deletes its refs under `refs/git-tree/hosts/<name>/`, after a confirmation.
	 */
	private async removeRemoteHost() {
		const remoteHosts = this.dataSource.remoteHosts;
		const repo = await this.pickRepoForRemoteHosts('Select the repository to remove a remote host from:');
		if (remoteHosts === null || repo === null) return;

		const hosts = await remoteHosts.loadHosts(repo);
		const configError = remoteHosts.getConfigError(repo);
		if (configError !== null) {
			showErrorMessage('Fix ' + CONFIG_FILE + ' before removing a host: ' + configError);
			return;
		}
		if (hosts.length === 0) {
			showErrorMessage('The repository has no remote hosts in ' + CONFIG_FILE + '.');
			return;
		}

		const item = await vscode.window.showQuickPick(hosts.map((snapshot) => ({ label: snapshot.host.name, description: snapshot.host.ssh + ':' + snapshot.host.path })), {
			placeHolder: 'Select the remote host to remove:',
			canPickMany: false
		});
		if (typeof item === 'undefined') return;

		const confirmed = await vscode.window.showWarningMessage('Remove the remote host "' + item.label + '"?', {
			modal: true,
			detail: 'Git Tree removes its entry from ' + CONFIG_FILE + ', and deletes the refs it fetched from it, under refs/git-tree/hosts/' + item.label + '/. Nothing on the server changes.'
		}, 'Remove');
		if (confirmed !== 'Remove') return;

		const errorInfo = await remoteHosts.removeHost(repo, item.label);
		if (errorInfo === null) {
			showInformationMessage('The remote host "' + item.label + '" was removed.');
		} else {
			showErrorMessage(errorInfo);
		}
	}

	/**
	 * The method run when the `git-tree.clearAvatarCache` command is invoked.
	 */
	private clearAvatarCache() {
		this.avatarManager.clearCache().then((errorInfo) => {
			if (errorInfo === null) {
				showInformationMessage('The Avatar Cache was successfully cleared.');
			} else {
				showErrorMessage(errorInfo);
			}
		}, () => {
			showErrorMessage('An unexpected error occurred while running the command "Clear Avatar Cache".');
		});
	}

	/**
	 * The method run when the `git-tree.fetch` command is invoked.
	 */
	private fetch() {
		const repos = this.repoManager.getRepos();
		const repoPaths = getSortedRepositoryPaths(repos, getConfig().repoDropdownOrder);

		if (repoPaths.length > 1) {
			const items: vscode.QuickPickItem[] = repoPaths.map((path) => ({
				label: repos[path].name || getRepoName(path),
				description: path
			}));

			const lastActiveRepo = this.extensionState.getLastActiveRepo();
			if (lastActiveRepo !== null) {
				let lastActiveRepoIndex = items.findIndex((item) => item.description === lastActiveRepo);
				if (lastActiveRepoIndex > -1) {
					const item = items.splice(lastActiveRepoIndex, 1)[0];
					items.unshift(item);
				}
			}

			vscode.window.showQuickPick(items, {
				placeHolder: 'Select the repository you want to open in Git Tree, and fetch from remote(s):',
				canPickMany: false
			}).then((item) => {
				if (item && item.description) {
					GitTreeView.createOrShow(this.context.extensionPath, this.dataSource, this.extensionState, this.avatarManager, this.repoManager, this.logger, {
						repo: item.description,
						runCommandOnLoad: 'fetch'
					});
				}
			}, () => {
				showErrorMessage('An unexpected error occurred while running the command "Fetch from Remote(s)".');
			});
		} else if (repoPaths.length === 1) {
			GitTreeView.createOrShow(this.context.extensionPath, this.dataSource, this.extensionState, this.avatarManager, this.repoManager, this.logger, {
				repo: repoPaths[0],
				runCommandOnLoad: 'fetch'
			});
		} else {
			GitTreeView.createOrShow(this.context.extensionPath, this.dataSource, this.extensionState, this.avatarManager, this.repoManager, this.logger, null);
		}
	}

	/**
	 * The method run when the `git-tree.endAllWorkspaceCodeReviews` command is invoked.
	 */
	private endAllWorkspaceCodeReviews() {
		this.extensionState.endAllWorkspaceCodeReviews();
		showInformationMessage('Ended All Code Reviews in Workspace');
	}

	/**
	 * The method run when the `git-tree.endSpecificWorkspaceCodeReview` command is invoked.
	 */
	private endSpecificWorkspaceCodeReview() {
		const codeReviews = this.extensionState.getCodeReviews();
		if (Object.keys(codeReviews).length === 0) {
			showErrorMessage('There are no Code Reviews in progress within the current workspace.');
			return;
		}

		vscode.window.showQuickPick(this.getCodeReviewQuickPickItems(codeReviews), {
			placeHolder: 'Select the Code Review you want to end:',
			canPickMany: false
		}).then((item) => {
			if (item) {
				this.extensionState.endCodeReview(item.codeReviewRepo, item.codeReviewId).then((errorInfo) => {
					if (errorInfo === null) {
						showInformationMessage('Successfully ended Code Review "' + item.label + '".');
					} else {
						showErrorMessage(errorInfo);
					}
				}, () => { });
			}
		}, () => {
			showErrorMessage('An unexpected error occurred while running the command "End a specific Code Review in Workspace...".');
		});
	}

	/**
	 * The method run when the `git-tree.resumeWorkspaceCodeReview` command is invoked.
	 */
	private resumeWorkspaceCodeReview() {
		const codeReviews = this.extensionState.getCodeReviews();
		if (Object.keys(codeReviews).length === 0) {
			showErrorMessage('There are no Code Reviews in progress within the current workspace.');
			return;
		}

		vscode.window.showQuickPick(this.getCodeReviewQuickPickItems(codeReviews), {
			placeHolder: 'Select the Code Review you want to resume:',
			canPickMany: false
		}).then((item) => {
			if (item) {
				const commitHashes = item.codeReviewId.split('-');
				GitTreeView.createOrShow(this.context.extensionPath, this.dataSource, this.extensionState, this.avatarManager, this.repoManager, this.logger, {
					repo: item.codeReviewRepo,
					commitDetails: {
						commitHash: commitHashes[commitHashes.length > 1 ? 1 : 0],
						compareWithHash: commitHashes.length > 1 ? commitHashes[0] : null
					}
				});
			}
		}, () => {
			showErrorMessage('An unexpected error occurred while running the command "Resume a specific Code Review in Workspace...".');
		});
	}

	/**
	 * The method run when the `git-tree.version` command is invoked.
	 */
	private async version() {
		try {
			const gitTreeVersion = await getExtensionVersion(this.context);
			const information = 'Git Tree: ' + gitTreeVersion + '\nVisual Studio Code: ' + vscode.version + '\nOS: ' + os.type() + ' ' + os.arch() + ' ' + os.release() + '\nGit: ' + (this.gitExecutable !== null ? this.gitExecutable.version : '(none)');
			vscode.window.showInformationMessage(information, { modal: true }, 'Copy').then((selectedItem) => {
				if (selectedItem === 'Copy') {
					copyToClipboard(information).then((result) => {
						if (result !== null) {
							showErrorMessage(result);
						}
					});
				}
			}, () => { });
		} catch (_) {
			showErrorMessage('An unexpected error occurred while retrieving version information.');
		}
	}

	/**
	 * Opens a file in Visual Studio Code, based on a Git Tree URI (from the Diff View).
	 * The method run when the `git-tree.openFile` command is invoked.
	 * @param arg The Git Tree URI.
	 */
	private openFile(arg?: vscode.Uri) {
		const uri = arg || vscode.window.activeTextEditor?.document.uri;
		if (typeof uri === 'object' && uri && uri.scheme === DiffDocProvider.scheme) {
			// A Git Tree URI has been provided
			const request = decodeDiffDocUri(uri);
			return openFile(request.repo, request.filePath, request.commit, this.dataSource, vscode.ViewColumn.Active).then((errorInfo) => {
				if (errorInfo !== null) {
					return showErrorMessage('Unable to Open File: ' + errorInfo);
				}
			});
		} else {
			return showErrorMessage('Unable to Open File: The command was not called with the required arguments.');
		}
	}


	/**
	 * Pick the repository a remote host command acts on: the only one, or one the user picks (the last active first).
	 * @param placeHolder The Quick Pick's placeholder.
	 * @returns The repository's path. NULL => there's none, remote hosts aren't available, or the user cancelled.
	 */
	private async pickRepoForRemoteHosts(placeHolder: string): Promise<string | null> {
		if (this.dataSource.remoteHosts === null) {
			showErrorMessage('Remote hosts aren\'t available.');
			return null;
		}
		const gitExecutableError = this.dataSource.getGitExecutableError();
		if (gitExecutableError !== null) {
			showErrorMessage(gitExecutableError);
			return null;
		}

		const repos = this.repoManager.getRepos();
		const repoPaths = getSortedRepositoryPaths(repos, getConfig().repoDropdownOrder).slice();
		if (repoPaths.length === 0) {
			showErrorMessage('Git Tree has no repositories in this workspace.');
			return null;
		} else if (repoPaths.length === 1) {
			return repoPaths[0];
		}

		const lastActiveRepo = this.extensionState.getLastActiveRepo();
		const lastActiveIndex = lastActiveRepo !== null ? repoPaths.indexOf(lastActiveRepo) : -1;
		if (lastActiveIndex > 0) repoPaths.unshift(repoPaths.splice(lastActiveIndex, 1)[0]);
		const item = await vscode.window.showQuickPick(repoPaths.map((path) => ({ label: repos[path].name || getRepoName(path), description: path })), {
			placeHolder: placeHolder,
			canPickMany: false
		});
		return typeof item !== 'undefined' && typeof item.description === 'string' ? item.description : null;
	}

	/**
	 * Pick the SSH alias of a new remote host: one of the Host aliases in ~/.ssh/config, or one the user types.
	 * @param aliases The Host aliases in ~/.ssh/config.
	 * @returns The alias. NULL => the user cancelled.
	 */
	private async pickSshAlias(aliases: Promise<string[]>): Promise<string | null> {
		const other = 'Enter another alias...';
		const known = await aliases;
		if (known.length > 0) {
			const item = await vscode.window.showQuickPick(known.map((alias) => ({ label: alias })).concat([{ label: other }]), {
				title: 'Add Remote Host (2/3)',
				placeHolder: 'Select the Host alias from ~/.ssh/config that reaches the server:',
				canPickMany: false,
				ignoreFocusOut: true
			});
			if (typeof item === 'undefined') return null;
			if (item.label !== other) return item.label;
		}

		const alias = await vscode.window.showInputBox({
			title: 'Add Remote Host (2/3)',
			prompt: 'A Host alias from ~/.ssh/config (ssh -G <alias> prints it). Its user, port and key stay in ~/.ssh/config.',
			placeHolder: 'build-box',
			ignoreFocusOut: true,
			validateInput: (value) => validateSshAlias(value)
		});
		return typeof alias !== 'undefined' ? alias : null;
	}


	/* Helper Methods */

	/**
	 * Transform a set of Code Reviews into a list of Quick Pick items for use with `vscode.window.showQuickPick`.
	 * @param codeReviews A set of Code Reviews.
	 * @returns A list of Quick Pick items.
	 */
	private getCodeReviewQuickPickItems(codeReviews: CodeReviews): Promise<CodeReviewQuickPickItem[]> {
		const repos = this.repoManager.getRepos();
		const enrichedCodeReviews: { repo: string, id: string, review: CodeReviewData, fromCommitHash: string, toCommitHash: string }[] = [];
		const fetchCommits: { repo: string, commitHash: string }[] = [];

		Object.keys(codeReviews).forEach((repo) => {
			if (typeof repos[repo] === 'undefined') return;
			Object.keys(codeReviews[repo]).forEach((id) => {
				const commitHashes = id.split('-');
				commitHashes.forEach((commitHash) => fetchCommits.push({ repo: repo, commitHash: commitHash }));
				enrichedCodeReviews.push({
					repo: repo, id: id, review: codeReviews[repo][id],
					fromCommitHash: commitHashes[0], toCommitHash: commitHashes[commitHashes.length > 1 ? 1 : 0]
				});
			});
		});

		return Promise.all(fetchCommits.map((fetch) => this.dataSource.getCommitSubject(fetch.repo, fetch.commitHash))).then(
			(subjects) => {
				const commitSubjects: { [repo: string]: { [commitHash: string]: string } } = {};
				subjects.forEach((subject, i) => {
					if (typeof commitSubjects[fetchCommits[i].repo] === 'undefined') {
						commitSubjects[fetchCommits[i].repo] = {};
					}
					commitSubjects[fetchCommits[i].repo][fetchCommits[i].commitHash] = subject !== null ? subject : '<Unknown Commit Subject>';
				});

				return enrichedCodeReviews.sort((a, b) => b.review.lastActive - a.review.lastActive).map((codeReview) => {
					const fromSubject = commitSubjects[codeReview.repo][codeReview.fromCommitHash];
					const toSubject = commitSubjects[codeReview.repo][codeReview.toCommitHash];
					const isComparison = codeReview.fromCommitHash !== codeReview.toCommitHash;
					return {
						codeReviewRepo: codeReview.repo,
						codeReviewId: codeReview.id,
						label: (repos[codeReview.repo].name || getRepoName(codeReview.repo)) + ': ' + abbrevCommit(codeReview.fromCommitHash) + (isComparison ? ' ↔ ' + abbrevCommit(codeReview.toCommitHash) : ''),
						description: getRelativeTimeDiff(Math.round(codeReview.review.lastActive / 1000)),
						detail: isComparison
							? abbrevText(fromSubject, 50) + ' ↔ ' + abbrevText(toSubject, 50)
							: fromSubject
					};
				});
			}
		);
	}
}

interface CodeReviewQuickPickItem extends vscode.QuickPickItem {
	codeReviewRepo: string;
	codeReviewId: string;
}
