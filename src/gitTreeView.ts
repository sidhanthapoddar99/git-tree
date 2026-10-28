import * as path from 'path';
import * as vscode from 'vscode';
import { AvatarManager } from './avatarManager';
import { createLoadCommitsResponse } from './compactCommits';
import { getConfig } from './config';
import { DataSource, GitConfigKey } from './dataSource';
import { ExtensionState } from './extensionState';
import { Logger } from './logger';
import { RepoFileWatcher } from './repoFileWatcher';
import { resolveServerWorktreePath } from './remoteHosts';
import { AGENT_INSTRUCTION } from './remoteHosts/agentInstruction';
import { RepoManager } from './repoManager';
import { ErrorInfo, GitConfigLocation, GitPushBranchMode, GitRepoSet, GitTreeViewConfig, GitTreeViewInitialState, LoadGitTreeViewTo, RequestMessage, ResponseMessage, TabIconColourTheme } from './types';
import { UNCOMMITTED, archive, copyFilePathToClipboard, copyToClipboard, createPullRequest, escapeHtml, getNonce, getRepoName, openExtensionSettings, openExternalUrl, openFile, openWorktree, showErrorMessage, viewDiff, viewDiffWithWorkingFile, viewFileAtRevision, viewScm } from './utils';
import { Disposable, toDisposable } from './utils/disposable';

const REMOTE_HOSTS_UNAVAILABLE = 'Remote hosts aren\'t available.';

/**
 * Manages the Git Tree View.
 */
export class GitTreeView extends Disposable {
	// Every open Git Tree View, most recently active first. Each view is its own editor tab.
	private static readonly views: GitTreeView[] = [];

	/**
	 * The most recently active Git Tree View, if one is open.
	 */
	public static get currentPanel(): GitTreeView | undefined {
		return GitTreeView.views[0];
	}

	private readonly panel: vscode.WebviewPanel;
	private readonly extensionPath: string;
	private readonly avatarManager: AvatarManager;
	private readonly dataSource: DataSource;
	private readonly extensionState: ExtensionState;
	private readonly repoFileWatcher: RepoFileWatcher;
	private readonly repoManager: RepoManager;
	private readonly logger: Logger;
	private isGraphViewLoaded: boolean = false;
	private isPanelVisible: boolean = true;
	private currentRepo: string | null = null; // The repository the file watcher follows. It is reset to null while the view is hidden.
	private shownRepo: string | null = null; // The repository this view shows. It is kept while the view is hidden.
	private shownWorktree: string | null = null; // Where the view runs Git: the repository, or one of its linked worktrees
	private watchedWorktrees: string = ''; // The worktree paths the file watcher follows, joined by NUL
	private loadViewTo: LoadGitTreeViewTo = null; // Is used by the next call to getHtmlForWebview, and is then reset to null
	private readonly retainContextWhenHidden: boolean;
	private renderedConfig: string | null = null; // The configuration the loaded HTML was built with, or NULL if the HTML must be rebuilt when next shown

	private loadRepoInfoRefreshId: number = 0;
	private loadCommitsRefreshId: number = 0;

	/**
	 * Show and update a Git Tree View that already exists, or create one.
	 *
	 * A repository is shown in the view that already shows it. If no view shows it, it opens in a new view, unless the most recently active view shows no repository yet.
	 * @param extensionPath The absolute file path of the directory containing the extension.
	 * @param dataSource The Git Tree DataSource instance.
	 * @param extensionState The Git Tree ExtensionState instance.
	 * @param avatarManger The Git Tree AvatarManager instance.
	 * @param repoManager The Git Tree RepoManager instance.
	 * @param logger The Git Tree Logger instance.
	 * @param loadViewTo What to load the view to.
	 * @param inNewTab Always create a new Git Tree View, in its own tab (default: `FALSE`).
	 */
	public static createOrShow(extensionPath: string, dataSource: DataSource, extensionState: ExtensionState, avatarManager: AvatarManager, repoManager: RepoManager, logger: Logger, loadViewTo: LoadGitTreeViewTo, inNewTab: boolean = false) {
		const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;
		const view = inNewTab ? undefined : GitTreeView.findView(loadViewTo);

		if (view) {
			// If a suitable Git Tree panel already exists
			if (loadViewTo !== null) {
				view.shownRepo = loadViewTo.repo;
			}
			if (view.isPanelVisible) {
				// If the Git Tree panel is visible
				if (loadViewTo !== null) {
					view.respondLoadRepos(repoManager.getRepos(), loadViewTo);
				}
			} else {
				// If the Git Tree panel is not visible
				view.loadViewTo = loadViewTo;
			}
			view.panel.reveal(column);
		} else {
			// If no suitable Git Tree panel exists
			GitTreeView.views.unshift(new GitTreeView(extensionPath, dataSource, extensionState, avatarManager, repoManager, logger, loadViewTo, column));
		}
	}

	/**
	 * Find the open Git Tree View to show.
	 * @param loadViewTo What to load the view to.
	 * @returns The view showing the requested repository. If no repository is requested, or no view has shown one yet, the most recently active view. Otherwise undefined.
	 */
	private static findView(loadViewTo: LoadGitTreeViewTo) {
		const recentView = GitTreeView.views[0];
		if (loadViewTo === null || typeof recentView === 'undefined') {
			return recentView;
		}
		return GitTreeView.views.find((view) => view.shownRepo === loadViewTo.repo)
			|| (recentView.shownRepo === null ? recentView : undefined);
	}

	/**
	 * Creates a Git Tree View.
	 * @param extensionPath The absolute file path of the directory containing the extension.
	 * @param dataSource The Git Tree DataSource instance.
	 * @param extensionState The Git Tree ExtensionState instance.
	 * @param avatarManger The Git Tree AvatarManager instance.
	 * @param repoManager The Git Tree RepoManager instance.
	 * @param logger The Git Tree Logger instance.
	 * @param loadViewTo What to load the view to.
	 * @param column The column the view should be loaded in.
	 */
	private constructor(extensionPath: string, dataSource: DataSource, extensionState: ExtensionState, avatarManager: AvatarManager, repoManager: RepoManager, logger: Logger, loadViewTo: LoadGitTreeViewTo, column: vscode.ViewColumn | undefined) {
		super();
		this.extensionPath = extensionPath;
		this.avatarManager = avatarManager;
		this.dataSource = dataSource;
		this.extensionState = extensionState;
		this.repoManager = repoManager;
		this.logger = logger;
		this.loadViewTo = loadViewTo;
		this.shownRepo = loadViewTo !== null ? loadViewTo.repo : null;

		const config = getConfig();
		this.retainContextWhenHidden = config.retainContextWhenHidden;
		this.panel = vscode.window.createWebviewPanel('git-tree', 'Git Tree', column || vscode.ViewColumn.One, {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.file(path.join(extensionPath, 'media'))],
			retainContextWhenHidden: this.retainContextWhenHidden
		});
		this.panel.iconPath = config.tabIconColourTheme === TabIconColourTheme.Colour
			? this.getResourcesUri('webview-icon.svg')
			: {
				light: this.getResourcesUri('webview-icon-light.svg'),
				dark: this.getResourcesUri('webview-icon-dark.svg')
			};


		this.registerDisposables(
			// Dispose Git Tree View resources when disposed
			toDisposable(() => {
				const index = GitTreeView.views.indexOf(this);
				if (index > -1) {
					GitTreeView.views.splice(index, 1);
				}
				this.repoFileWatcher.stop();
			}),

			// Dispose this Git Tree View when the Webview Panel is disposed
			this.panel.onDidDispose(() => this.dispose()),

			// Register a callback that is called when the view is shown or hidden
			this.panel.onDidChangeViewState(() => {
				if (this.panel.active) {
					// Keep the most recently active view first
					const index = GitTreeView.views.indexOf(this);
					if (index > 0) {
						GitTreeView.views.splice(index, 1);
						GitTreeView.views.unshift(this);
					}
				}
				if (this.panel.visible !== this.isPanelVisible) {
					if (this.panel.visible) {
						this.show();
					} else {
						this.currentRepo = null;
						this.repoFileWatcher.stop();
					}
					this.isPanelVisible = this.panel.visible;
				}
			}),

			// Subscribe to events triggered when a repository is added or deleted from Git Tree
			repoManager.onDidChangeRepos((event) => {
				if (!this.panel.visible) {
					// The HTML holds the known repositories, so rebuild it when the view is next shown
					this.renderedConfig = null;
					return;
				}
				const loadViewTo = event.loadRepo !== null ? { repo: event.loadRepo } : null;
				if ((event.numRepos === 0 && this.isGraphViewLoaded) || (event.numRepos > 0 && !this.isGraphViewLoaded)) {
					this.loadViewTo = loadViewTo;
					this.update();
				} else {
					this.respondLoadRepos(event.repos, loadViewTo);
				}
			}),

			// Subscribe to events triggered when an avatar is available
			avatarManager.onAvatar((event) => {
				this.sendMessage({
					command: 'fetchAvatar',
					email: event.email,
					image: event.image
				});
			}),

			// Respond to messages sent from the Webview
			this.panel.webview.onDidReceiveMessage((msg) => this.respondToMessage(msg)),

			// When a remote host of the repository this view shows has changed, refresh the view softly. A hidden view
			// catches up when it is next shown.
			dataSource.remoteHosts
				? dataSource.remoteHosts.onDidChange((repo) => {
					if (this.panel.visible && this.currentRepo !== null && (repo === this.currentRepo || repo === this.shownWorktree)) {
						this.sendMessage({ command: 'refresh' });
					}
				})
				: toDisposable(() => { }),

			// Dispose the Webview Panel when disposed
			this.panel
		);

		// Instantiate a RepoFileWatcher that watches for file changes in the repository currently open in the Git Tree View
		this.repoFileWatcher = new RepoFileWatcher(logger, () => {
			if (this.panel.visible) {
				this.sendMessage({ command: 'refresh' });
			}
		});

		// Render the content of the Webview
		this.update();

		this.logger.log('Created Git Tree View' + (loadViewTo !== null ? ' (active repo: ' + loadViewTo.repo + ')' : ''));
	}

	/**
	 * Respond to a message sent from the front-end.
	 * @param msg The message that was received.
	 */
	private async respondToMessage(msg: RequestMessage) {
		this.repoFileWatcher.mute();
		let errorInfos: ErrorInfo[];

		switch (msg.command) {
			case 'addRemote':
				this.sendMessage({
					command: 'addRemote',
					error: await this.dataSource.addRemote(msg.repo, msg.name, msg.url, msg.pushUrl, msg.fetch)
				});
				break;
			case 'askRemoteHostFetchConsent':
				// The question is a modal dialog, so the view isn't kept waiting for the answer. The host refreshes if the user agrees, and onDidChange then refreshes the view.
				if (this.dataSource.remoteHosts) {
					this.dataSource.remoteHosts.askFetchConsent(msg.repo, msg.host).catch((error) => this.logger.logError('Remote hosts: ' + error));
				}
				this.sendMessage({
					command: 'askRemoteHostFetchConsent',
					error: this.dataSource.remoteHosts ? null : REMOTE_HOSTS_UNAVAILABLE
				});
				break;
			case 'addTag':
				errorInfos = [await this.dataSource.addTag(msg.repo, msg.tagName, msg.commitHash, msg.type, msg.message, msg.force)];
				if (errorInfos[0] === null && msg.pushToRemote !== null) {
					errorInfos.push(...await this.dataSource.pushTag(msg.repo, msg.tagName, [msg.pushToRemote], msg.commitHash, msg.pushSkipRemoteCheck));
				}
				this.sendMessage({
					command: 'addTag',
					repo: msg.repo,
					tagName: msg.tagName,
					pushToRemote: msg.pushToRemote,
					commitHash: msg.commitHash,
					errors: errorInfos
				});
				break;
			case 'applyStash':
				this.sendMessage({
					command: 'applyStash',
					error: await this.dataSource.applyStash(msg.repo, msg.selector, msg.reinstateIndex)
				});
				break;
			case 'branchFromStash':
				this.sendMessage({
					command: 'branchFromStash',
					error: await this.dataSource.branchFromStash(msg.repo, msg.selector, msg.branchName)
				});
				break;
			case 'browseRemoteHost': {
				const listing = this.dataSource.remoteHosts ? await this.dataSource.remoteHosts.browse(msg.ssh, msg.path) : { error: REMOTE_HOSTS_UNAVAILABLE };
				this.sendMessage('error' in listing
					? { command: 'browseRemoteHost', ssh: msg.ssh, path: msg.path !== null ? msg.path : '', parent: null, entries: [], truncated: false, error: listing.error }
					: { command: 'browseRemoteHost', ssh: msg.ssh, path: listing.path, parent: listing.parent, entries: listing.entries, truncated: listing.truncated, error: null });
				break;
			}
			case 'checkRemoteHost':
				this.sendMessage({
					command: 'checkRemoteHost',
					ssh: msg.ssh,
					path: msg.path,
					error: this.dataSource.remoteHosts ? await this.dataSource.remoteHosts.checkHost(msg.repo, msg.ssh, msg.path) : REMOTE_HOSTS_UNAVAILABLE
				});
				break;
			case 'checkoutBranch':
				errorInfos = [await this.dataSource.checkoutBranch(msg.repo, msg.branchName, msg.remoteBranch)];
				if (errorInfos[0] === null && msg.pullAfterwards !== null) {
					errorInfos.push(await this.dataSource.pullBranch(msg.repo, msg.pullAfterwards.branchName, msg.pullAfterwards.remote, msg.pullAfterwards.createNewCommit, msg.pullAfterwards.squash));
				}
				this.sendMessage({
					command: 'checkoutBranch',
					pullAfterwards: msg.pullAfterwards,
					errors: errorInfos
				});
				break;
			case 'checkoutCommit':
				this.sendMessage({
					command: 'checkoutCommit',
					error: await this.dataSource.checkoutCommit(msg.repo, msg.commitHash)
				});
				break;
			case 'cherrypickCommit':
				errorInfos = [await this.dataSource.cherrypickCommit(msg.repo, msg.commitHash, msg.parentIndex, msg.recordOrigin, msg.noCommit)];
				if (errorInfos[0] === null && msg.noCommit) {
					errorInfos.push(await viewScm());
				}
				this.sendMessage({ command: 'cherrypickCommit', errors: errorInfos });
				break;
			case 'cleanUntrackedFiles':
				this.sendMessage({
					command: 'cleanUntrackedFiles',
					error: await this.dataSource.cleanUntrackedFiles(msg.repo, msg.directories)
				});
				break;
			case 'commitDetails':
				let data = await Promise.all([
					msg.commitHash === UNCOMMITTED
						? this.dataSource.getUncommittedDetails(msg.repo)
						: msg.stash === null
							? this.dataSource.getCommitDetails(msg.repo, msg.commitHash, msg.hasParents)
							: this.dataSource.getStashDetails(msg.repo, msg.commitHash, msg.stash),
					msg.avatarEmail !== null ? this.avatarManager.getAvatarImage(msg.avatarEmail) : Promise.resolve(null)
				]);
				this.sendMessage({
					command: 'commitDetails',
					repo: msg.repo,
					...data[0],
					avatar: data[1],
					codeReview: msg.commitHash !== UNCOMMITTED ? this.extensionState.getCodeReview(msg.repo, msg.commitHash) : null,
					refresh: msg.refresh
				});
				break;
			case 'compareCommits':
				this.sendMessage({
					command: 'compareCommits',
					commitHash: msg.commitHash,
					compareWithHash: msg.compareWithHash,
					...await this.dataSource.getCommitComparison(msg.repo, msg.fromHash, msg.toHash),
					codeReview: msg.toHash !== UNCOMMITTED ? this.extensionState.getCodeReview(msg.repo, msg.fromHash + '-' + msg.toHash) : null,
					refresh: msg.refresh
				});
				break;
			case 'copyFilePath':
				this.sendMessage({
					command: 'copyFilePath',
					error: await copyFilePathToClipboard(msg.repo, msg.filePath, msg.absolute)
				});
				break;
			case 'copyToClipboard':
				this.sendMessage({
					command: 'copyToClipboard',
					type: msg.type,
					error: await copyToClipboard(msg.data)
				});
				break;
			case 'createArchive':
				this.sendMessage({
					command: 'createArchive',
					error: await archive(msg.repo, msg.ref, this.dataSource)
				});
				break;
			case 'createBranch':
				this.sendMessage({
					command: 'createBranch',
					errors: await this.dataSource.createBranch(msg.repo, msg.branchName, msg.commitHash, msg.checkout, msg.force)
				});
				break;
			case 'createWorktree': {
				const result = await this.dataSource.createWorktree(msg.repo, msg.path, msg.commitish, msg.newBranch);
				if (result.path !== null && msg.openInNewWindow) {
					result.errors.push(await openWorktree(result.path, true));
				}
				this.sendMessage({
					command: 'createWorktree',
					errors: result.errors
				});
				break;
			}
			case 'createRemoteWorktree':
				this.sendMessage({
					command: 'createRemoteWorktree',
					errors: await this.createRemoteWorktree(msg.repo, msg.host, msg.path, msg.commitish, msg.newBranch, msg.openInNewWindow)
				});
				break;
			case 'createRemoteHostRepository':
				this.sendMessage({
					command: 'createRemoteHostRepository',
					error: this.dataSource.remoteHosts ? await this.dataSource.remoteHosts.createRepository(msg.repo, msg.host, msg.source) : REMOTE_HOSTS_UNAVAILABLE
				});
				break;
			case 'createPullRequest':
				errorInfos = [msg.push ? await this.dataSource.pushBranch(msg.repo, msg.sourceBranch, msg.sourceRemote, true, GitPushBranchMode.Normal) : null];
				if (errorInfos[0] === null) {
					errorInfos.push(await createPullRequest(msg.config, msg.sourceOwner, msg.sourceRepo, msg.sourceBranch));
				}
				this.sendMessage({
					command: 'createPullRequest',
					push: msg.push,
					errors: errorInfos
				});
				break;
			case 'deleteBranch':
				errorInfos = [await this.dataSource.deleteBranch(msg.repo, msg.branchName, msg.forceDelete)];
				if (errorInfos[0] === null) {
					for (let i = 0; i < msg.deleteOnRemotes.length; i++) {
						errorInfos.push(await this.dataSource.deleteRemoteBranch(msg.repo, msg.branchName, msg.deleteOnRemotes[i]));
					}
				}
				this.sendMessage({
					command: 'deleteBranch',
					repo: msg.repo,
					branchName: msg.branchName,
					deleteOnRemotes: msg.deleteOnRemotes,
					errors: errorInfos
				});
				break;
			case 'deleteRemote':
				this.sendMessage({
					command: 'deleteRemote',
					error: await this.dataSource.deleteRemote(msg.repo, msg.name)
				});
				break;
			case 'deleteRemoteBranch':
				this.sendMessage({
					command: 'deleteRemoteBranch',
					error: await this.dataSource.deleteRemoteBranch(msg.repo, msg.branchName, msg.remote)
				});
				break;
			case 'deleteTag':
				this.sendMessage({
					command: 'deleteTag',
					error: await this.dataSource.deleteTag(msg.repo, msg.tagName, msg.deleteOnRemote)
				});
				break;
			case 'deleteUserDetails':
				errorInfos = [];
				if (msg.name) {
					errorInfos.push(await this.dataSource.unsetConfigValue(msg.repo, GitConfigKey.UserName, msg.location));
				}
				if (msg.email) {
					errorInfos.push(await this.dataSource.unsetConfigValue(msg.repo, GitConfigKey.UserEmail, msg.location));
				}
				this.sendMessage({
					command: 'deleteUserDetails',
					errors: errorInfos
				});
				break;
			case 'dropCommit':
				this.sendMessage({
					command: 'dropCommit',
					error: await this.dataSource.dropCommit(msg.repo, msg.commitHash)
				});
				break;
			case 'dropStash':
				this.sendMessage({
					command: 'dropStash',
					error: await this.dataSource.dropStash(msg.repo, msg.selector)
				});
				break;
			case 'editRemote':
				this.sendMessage({
					command: 'editRemote',
					error: await this.dataSource.editRemote(msg.repo, msg.nameOld, msg.nameNew, msg.urlOld, msg.urlNew, msg.pushUrlOld, msg.pushUrlNew)
				});
				break;
			case 'editUserDetails':
				errorInfos = [
					await this.dataSource.setConfigValue(msg.repo, GitConfigKey.UserName, msg.name, msg.location),
					await this.dataSource.setConfigValue(msg.repo, GitConfigKey.UserEmail, msg.email, msg.location)
				];
				if (errorInfos[0] === null && errorInfos[1] === null) {
					if (msg.deleteLocalName) {
						errorInfos.push(await this.dataSource.unsetConfigValue(msg.repo, GitConfigKey.UserName, GitConfigLocation.Local));
					}
					if (msg.deleteLocalEmail) {
						errorInfos.push(await this.dataSource.unsetConfigValue(msg.repo, GitConfigKey.UserEmail, GitConfigLocation.Local));
					}
				}
				this.sendMessage({
					command: 'editUserDetails',
					errors: errorInfos
				});
				break;
			case 'endCodeReview':
				this.extensionState.endCodeReview(msg.repo, msg.id);
				break;
			case 'exportRepoConfig':
				this.sendMessage({
					command: 'exportRepoConfig',
					error: await this.repoManager.exportRepoConfig(msg.repo)
				});
				break;
			case 'fetch':
				this.sendMessage({
					command: 'fetch',
					error: await this.dataSource.fetch(msg.repo, msg.name, msg.prune, msg.pruneTags)
				});
				break;
			case 'fetchAvatar':
				this.avatarManager.fetchAvatarImage(msg.email, msg.repo, msg.remote, msg.commits);
				break;
			case 'fetchIntoLocalBranch':
				this.sendMessage({
					command: 'fetchIntoLocalBranch',
					error: await this.dataSource.fetchIntoLocalBranch(msg.repo, msg.remote, msg.remoteBranch, msg.localBranch, msg.force)
				});
				break;
			case 'loadCommits':
				this.loadCommitsRefreshId = msg.refreshId;
				this.sendMessage(createLoadCommitsResponse(msg.refreshId, msg.onlyFollowFirstParent, msg.token,
					await this.dataSource.getCommits(msg.repo, msg.branches, msg.maxCommits, msg.showTags, msg.showRemoteBranches, msg.includeCommitsMentionedByReflogs, msg.onlyFollowFirstParent, msg.commitOrdering, msg.remotes, msg.hideRemotes, msg.stashes, msg.worktrees, msg.onlyWorktreeHistory, msg.onlyHostWorktree, msg.hideHosts, msg.hostChoice)
				));
				break;
			case 'loadConfig':
				this.sendMessage({
					command: 'loadConfig',
					repo: msg.repo,
					...await this.dataSource.getConfig(msg.repo, msg.remotes)
				});
				break;
			case 'loadRemoteHosts':
				if (this.dataSource.remoteHosts) {
					this.sendMessage({
						command: 'loadRemoteHosts',
						repo: msg.repo,
						...await this.dataSource.remoteHosts.loadSettings(msg.repo),
						error: null
					});
				} else {
					this.sendMessage({ command: 'loadRemoteHosts', repo: msg.repo, hosts: [], configFile: null, configError: null, sshAliases: [], agentInstruction: AGENT_INSTRUCTION, error: REMOTE_HOSTS_UNAVAILABLE });
				}
				break;
			case 'loadRepoInfo':
				this.loadRepoInfoRefreshId = msg.refreshId;
				let repoInfo = await this.dataSource.getRepoInfo(msg.worktree, msg.showRemoteBranches, msg.showStashes, msg.hideRemotes, msg.hideHosts, msg.hostChoice), isRepo = true;
				if (repoInfo.error) {
					// If an error occurred, check to make sure the repo (or the worktree being viewed) still exists
					isRepo = (await this.dataSource.repoRoot(msg.worktree)) !== null;
					if (!isRepo) repoInfo.error = null; // If the error is caused by the repo no longer existing, clear the error message
				}
				this.sendMessage({
					command: 'loadRepoInfo',
					refreshId: msg.refreshId,
					...repoInfo,
					isRepo: isRepo
				});
				const repoChanged = msg.repo !== this.currentRepo;
				if (repoChanged) {
					this.currentRepo = msg.repo;
					this.shownRepo = msg.repo;
					this.extensionState.setLastActiveRepo(msg.repo);
					if (repoInfo.error === null && getConfig().writeCommitGraph) {
						// In the background, because the file only speeds up later loads
						const repo = msg.repo;
						this.dataSource.writeCommitGraphIfMissing(repo).then((errorInfo) => {
							if (errorInfo !== null) this.logger.logError('Unable to write the commit-graph of ' + repo + ': ' + errorInfo);
						});
					}
				}
				// Watch the repository and every worktree of it on this machine, so changes in any worktree refresh the view
				const watchedWorktrees = repoInfo.worktrees.filter((worktree) => typeof worktree.host === 'undefined' && !worktree.prunable).map((worktree) => worktree.path);
				if (repoChanged || watchedWorktrees.join('\0') !== this.watchedWorktrees) {
					this.repoFileWatcher.start(msg.repo, watchedWorktrees);
					this.watchedWorktrees = watchedWorktrees.join('\0');
				}
				if (repoChanged || msg.worktree !== this.shownWorktree) {
					this.shownWorktree = msg.worktree;
					this.updateTitle();
				}
				// The remote hosts refresh in the background when the view loads the repository, which it also does when it
				// becomes visible again (currentRepo is reset while it is hidden), and when the user refreshes it. The hosts
				// the view hides are skipped, so they cost no SSH call.
				if ((repoChanged || msg.refreshHosts) && this.dataSource.remoteHosts) {
					this.dataSource.remoteHosts.refresh(msg.repo, msg.hideHosts, msg.hostChoice);
				}
				break;
			case 'loadRepos':
				if (!msg.check || !await this.repoManager.checkReposExist()) {
					// If not required to check repos, or no changes were found when checking, respond with repos
					this.respondLoadRepos(this.repoManager.getRepos(), null);
				}
				break;
			case 'merge':
				this.sendMessage({
					command: 'merge',
					actionOn: msg.actionOn,
					error: await this.dataSource.merge(msg.repo, msg.obj, msg.actionOn, msg.createNewCommit, msg.squash, msg.noCommit)
				});
				break;
			case 'openExtensionSettings':
				this.sendMessage({
					command: 'openExtensionSettings',
					error: await openExtensionSettings()
				});
				break;
			case 'openExternalDirDiff':
				this.sendMessage({
					command: 'openExternalDirDiff',
					error: await this.dataSource.openExternalDirDiff(msg.repo, msg.fromHash, msg.toHash, msg.isGui)
				});
				break;
			case 'openExternalUrl':
				this.sendMessage({
					command: 'openExternalUrl',
					error: await openExternalUrl(msg.url)
				});
				break;
			case 'openFile':
				this.sendMessage({
					command: 'openFile',
					error: await openFile(msg.repo, msg.filePath, msg.hash, this.dataSource)
				});
				break;
			case 'openTerminal':
				this.sendMessage({
					command: 'openTerminal',
					error: await this.dataSource.openGitTerminal(msg.repo, null, msg.name)
				});
				break;
			case 'openWorktree':
				this.sendMessage({
					command: 'openWorktree',
					error: await openWorktree(msg.path, msg.newWindow)
				});
				break;
			case 'openRemoteTerminal':
				this.sendMessage({
					command: 'openRemoteTerminal',
					error: this.dataSource.remoteHosts ? this.dataSource.remoteHosts.openTerminal(msg.repo, msg.host, msg.path) : REMOTE_HOSTS_UNAVAILABLE
				});
				break;
			case 'openRemoteWorktree':
				this.sendMessage({
					command: 'openRemoteWorktree',
					error: this.dataSource.remoteHosts ? await this.dataSource.remoteHosts.openWorktree(msg.repo, msg.host, msg.path, msg.newWindow) : REMOTE_HOSTS_UNAVAILABLE
				});
				break;
			case 'popStash':
				this.sendMessage({
					command: 'popStash',
					error: await this.dataSource.popStash(msg.repo, msg.selector, msg.reinstateIndex)
				});
				break;
			case 'pruneRemote':
				this.sendMessage({
					command: 'pruneRemote',
					error: await this.dataSource.pruneRemote(msg.repo, msg.name)
				});
				break;
			case 'pullBranch':
				this.sendMessage({
					command: 'pullBranch',
					error: await this.dataSource.pullBranch(msg.repo, msg.branchName, msg.remote, msg.createNewCommit, msg.squash)
				});
				break;
			case 'pushBranch':
				this.sendMessage({
					command: 'pushBranch',
					willUpdateBranchConfig: msg.willUpdateBranchConfig,
					errors: await this.dataSource.pushBranchToMultipleRemotes(msg.repo, msg.branchName, msg.remotes, msg.setUpstream, msg.mode)
				});
				break;
			case 'pushStash':
				this.sendMessage({
					command: 'pushStash',
					error: await this.dataSource.pushStash(msg.repo, msg.message, msg.includeUntracked)
				});
				break;
			case 'pushTag':
				this.sendMessage({
					command: 'pushTag',
					repo: msg.repo,
					tagName: msg.tagName,
					remotes: msg.remotes,
					commitHash: msg.commitHash,
					errors: await this.dataSource.pushTag(msg.repo, msg.tagName, msg.remotes, msg.commitHash, msg.skipRemoteCheck)
				});
				break;
			case 'rebase':
				this.sendMessage({
					command: 'rebase',
					actionOn: msg.actionOn,
					interactive: msg.interactive,
					error: await this.dataSource.rebase(msg.repo, msg.obj, msg.actionOn, msg.ignoreDate, msg.interactive)
				});
				break;
			case 'removeWorktree':
				this.sendMessage({
					command: 'removeWorktree',
					error: await this.dataSource.removeWorktree(msg.repo, msg.path, msg.force)
				});
				break;
			case 'removeRemoteWorktree':
				this.sendMessage({
					command: 'removeRemoteWorktree',
					error: this.dataSource.remoteHosts ? await this.dataSource.remoteHosts.removeWorktree(msg.repo, msg.host, msg.path, msg.force) : REMOTE_HOSTS_UNAVAILABLE
				});
				break;
			case 'removeRemoteHost':
				this.sendMessage({
					command: 'removeRemoteHost',
					error: this.dataSource.remoteHosts ? await this.dataSource.remoteHosts.removeHost(msg.repo, msg.name) : REMOTE_HOSTS_UNAVAILABLE
				});
				break;
			case 'runRemoteHostGit':
				this.sendMessage({
					command: 'runRemoteHostGit',
					host: msg.host,
					action: msg.action,
					error: this.dataSource.remoteHosts ? await this.dataSource.remoteHosts.runGitOnHost(msg.repo, msg.host, msg.worktreePath, msg.action) : REMOTE_HOSTS_UNAVAILABLE
				});
				break;
			case 'renameBranch':
				this.sendMessage({
					command: 'renameBranch',
					error: await this.dataSource.renameBranch(msg.repo, msg.oldName, msg.newName)
				});
				break;
			case 'rescanForRepos':
				if (!(await this.repoManager.searchWorkspaceForRepos())) {
					showErrorMessage('No Git repositories were found in the current workspace.');
				}
				break;
			case 'resetFileToRevision':
				this.sendMessage({
					command: 'resetFileToRevision',
					error: await this.dataSource.resetFileToRevision(msg.repo, msg.commitHash, msg.filePath)
				});
				break;
			case 'resetToCommit':
				this.sendMessage({
					command: 'resetToCommit',
					error: await this.dataSource.resetToCommit(msg.repo, msg.commit, msg.resetMode)
				});
				break;
			case 'revertCommit':
				this.sendMessage({
					command: 'revertCommit',
					error: await this.dataSource.revertCommit(msg.repo, msg.commitHash, msg.parentIndex)
				});
				break;
			case 'saveRemoteHost':
				this.sendMessage({
					command: 'saveRemoteHost',
					error: this.dataSource.remoteHosts ? await this.dataSource.remoteHosts.saveHost(msg.repo, msg.previousName, msg.host) : REMOTE_HOSTS_UNAVAILABLE
				});
				break;
			case 'setGlobalViewState':
				this.sendMessage({
					command: 'setGlobalViewState',
					error: await this.extensionState.setGlobalViewState(msg.state)
				});
				break;
			case 'setRepoState':
				this.repoManager.setRepoState(msg.repo, msg.state);
				break;
			case 'setWorkspaceViewState':
				this.sendMessage({
					command: 'setWorkspaceViewState',
					error: await this.extensionState.setWorkspaceViewState(msg.state)
				});
				break;
			case 'showErrorMessage':
				showErrorMessage(msg.message);
				break;
			case 'startCodeReview':
				this.sendMessage({
					command: 'startCodeReview',
					commitHash: msg.commitHash,
					compareWithHash: msg.compareWithHash,
					...await this.extensionState.startCodeReview(msg.repo, msg.id, msg.files, msg.lastViewedFile)
				});
				break;
			case 'tagDetails':
				this.sendMessage({
					command: 'tagDetails',
					tagName: msg.tagName,
					commitHash: msg.commitHash,
					...await this.dataSource.getTagDetails(msg.repo, msg.tagName)
				});
				break;
			case 'updateCodeReview':
				this.sendMessage({
					command: 'updateCodeReview',
					error: await this.extensionState.updateCodeReview(msg.repo, msg.id, msg.remainingFiles, msg.lastViewedFile)
				});
				break;
			case 'viewDiff':
				this.sendMessage({
					command: 'viewDiff',
					error: await viewDiff(msg.repo, msg.fromHash, msg.toHash, msg.oldFilePath, msg.newFilePath, msg.type)
				});
				break;
			case 'viewDiffWithWorkingFile':
				this.sendMessage({
					command: 'viewDiffWithWorkingFile',
					error: await viewDiffWithWorkingFile(msg.repo, msg.hash, msg.filePath, this.dataSource)
				});
				break;
			case 'viewFileAtRevision':
				this.sendMessage({
					command: 'viewFileAtRevision',
					error: await viewFileAtRevision(msg.repo, msg.hash, msg.filePath)
				});
				break;
			case 'viewScm':
				this.sendMessage({
					command: 'viewScm',
					error: await viewScm()
				});
				break;
		}

		this.repoFileWatcher.unmute();
	}

	/**
	 * Create a worktree on a remote host, and open it with Remote-SSH if asked to. RemoteHosts refreshes the host afterwards, so the view shows the new worktree.
	 * @param repo The path of the repository.
	 * @param host The host's name.
	 * @param worktreePath The path entered for the new worktree: absolute on the server, or relative to the host's main worktree.
	 * @param commitish The commit, or the host's branch, to check out.
	 * @param newBranch The name of a new branch to create at `commitish`, or NULL.
	 * @param openInNewWindow Open the new worktree in a new window.
	 * @returns The errors of each step.
	 */
	private async createRemoteWorktree(repo: string, host: string, worktreePath: string, commitish: string, newBranch: string | null, openInNewWindow: boolean): Promise<ErrorInfo[]> {
		const remoteHosts = this.dataSource.remoteHosts;
		if (!remoteHosts) return [REMOTE_HOSTS_UNAVAILABLE];
		const snapshot = remoteHosts.getHosts(repo).find((snapshot) => snapshot.host.name === host);
		if (typeof snapshot === 'undefined') return ['The host "' + host + '" isn\'t in .worktrees/git-tree.yaml.'];
		// The path is resolved here as RemoteHosts resolves it, so the new worktree can be opened by its absolute path
		const resolved = resolveServerWorktreePath(worktreePath, snapshot.host.path);
		if ('error' in resolved) return [resolved.error];

		const errors: ErrorInfo[] = [await remoteHosts.createWorktree(repo, host, resolved.path, commitish, newBranch)];
		if (errors[0] === null && openInNewWindow) errors.push(await remoteHosts.openWorktree(repo, host, resolved.path, true));
		return errors;
	}

	/**
	 * Send a message to the front-end.
	 * @param msg The message to be sent.
	 */
	private sendMessage(msg: ResponseMessage) {
		if (this.isDisposed()) {
			this.logger.log('The Git Tree View has already been disposed, ignored sending "' + msg.command + '" message.');
		} else {
			this.panel.webview.postMessage(msg).then(
				() => { },
				() => {
					if (this.isDisposed()) {
						this.logger.log('The Git Tree View was disposed while sending "' + msg.command + '" message.');
					} else {
						this.logger.logError('Unable to send "' + msg.command + '" message to the Git Tree View.');
					}
				}
			);
		}
	}

	/**
	 * Update the HTML document loaded in the Webview.
	 */
	private update() {
		this.panel.webview.html = this.getHtmlForWebview();
	}

	/**
	 * Bring the Webview up to date when it becomes visible.
	 *
	 * A Webview kept alive while hidden only needs to catch up, which avoids reloading the whole page on every tab switch. The page is rebuilt if it wasn't kept alive, or if what the HTML was built from has changed.
	 */
	private show() {
		if (!this.retainContextWhenHidden || !this.isGraphViewLoaded || this.renderedConfig !== this.getConfigKey()) {
			this.update();
		} else if (this.loadViewTo !== null) {
			this.respondLoadRepos(this.repoManager.getRepos(), this.loadViewTo);
			this.loadViewTo = null;
		} else {
			this.sendMessage({ command: 'refresh' });
		}
	}

	/**
	 * Set the title of the panel's tab to the name of the repository it shows, and of the worktree when it shows a linked worktree, so tabs can be told apart.
	 */
	private updateTitle() {
		const repo = this.shownRepo !== null ? this.repoManager.getRepos()[this.shownRepo] : undefined;
		if (!repo || this.shownRepo === null) {
			this.panel.title = 'Git Tree';
			return;
		}
		const worktree = this.shownWorktree !== null && this.shownWorktree !== this.shownRepo ? ' (' + getRepoName(this.shownWorktree) + ')' : '';
		this.panel.title = 'Git Tree: ' + (repo.name || getRepoName(this.shownRepo)) + worktree;
	}

	/**
	 * Get a key for the settings the Webview's HTML is built from, used to tell whether the HTML must be rebuilt.
	 * @returns The key.
	 */
	private getConfigKey() {
		return JSON.stringify([this.getViewConfig(), this.dataSource.getGitExecutableError()]);
	}

	/**
	 * Get the configuration of the Webview.
	 * @returns The configuration.
	 */
	private getViewConfig(): GitTreeViewConfig {
		const config = getConfig();
		return {
			commitDetailsView: config.commitDetailsView,
			commitOrdering: config.commitOrder,
			contextMenuActionsVisibility: config.contextMenuActionsVisibility,
			customBranchGlobPatterns: config.customBranchGlobPatterns,
			customEmojiShortcodeMappings: config.customEmojiShortcodeMappings,
			customPullRequestProviders: config.customPullRequestProviders,
			dateFormat: config.dateFormat,
			defaultColumnVisibility: config.defaultColumnVisibility,
			dialogDefaults: config.dialogDefaults,
			enhancedAccessibility: config.enhancedAccessibility,
			fetchAndPrune: config.fetchAndPrune,
			fetchAndPruneTags: config.fetchAndPruneTags,
			fetchAvatars: config.fetchAvatars && this.extensionState.isAvatarStorageAvailable(),
			graph: config.graph,
			includeCommitsMentionedByReflogs: config.includeCommitsMentionedByReflogs,
			initialLoadCommits: config.initialLoadCommits,
			keybindings: config.keybindings,
			loadMoreCommits: config.loadMoreCommits,
			loadMoreCommitsAutomatically: config.loadMoreCommitsAutomatically,
			markdown: config.markdown,
			mute: config.muteCommits,
			onlyFollowFirstParent: config.onlyFollowFirstParent,
			onRepoLoad: config.onRepoLoad,
			referenceLabels: config.referenceLabels,
			repoDropdownOrder: config.repoDropdownOrder,
			showRemoteBranches: config.showRemoteBranches,
			showStashes: config.showStashes,
			showTags: config.showTags,
			worktreeDefaultLocation: config.worktreeDefaultLocation
		};
	}

	/**
	 * Get the HTML document to be loaded in the Webview.
	 * @returns The HTML.
	 */
	private getHtmlForWebview() {
		const nonce = getNonce();
		const initialState: GitTreeViewInitialState = {
			config: this.getViewConfig(),
			lastActiveRepo: this.extensionState.getLastActiveRepo(),
			loadViewTo: this.loadViewTo,
			repos: this.repoManager.getRepos(),
			loadRepoInfoRefreshId: this.loadRepoInfoRefreshId,
			loadCommitsRefreshId: this.loadCommitsRefreshId
		};
		const globalState = this.extensionState.getGlobalViewState();
		const workspaceState = this.extensionState.getWorkspaceViewState();

		let body, numRepos = Object.keys(initialState.repos).length, colorVars = '', colorVarsLight = '', colorParams = '';
		for (let i = 0; i < initialState.config.graph.colours.length; i++) {
			colorVars += '--git-tree-color' + i + ':' + initialState.config.graph.colours[i] + '; ';
			colorVarsLight += '--git-tree-color' + i + ':' + initialState.config.graph.coloursLight[i] + '; ';
			colorParams += '[data-color="' + i + '"]{--git-tree-color:var(--git-tree-color' + i + ');} ';
		}

		const gitExecutableError = this.dataSource.getGitExecutableError();
		if (gitExecutableError !== null) {
			body = `<body class="unableToLoad">
			<h2>Unable to load Git Tree</h2>
			<p class="unableToLoadMessage">${escapeHtml(gitExecutableError)}</p>
			</body>`;
		} else if (numRepos > 0) {
			body = `<body>
			<div id="view" tabindex="-1">
				<div id="controls">
					<span id="repoControl"><span class="unselectable controlText">Repo: </span><div id="repoDropdown" class="dropdown"></div></span>
					<span id="branchControl"><span class="unselectable controlText">Branches: </span><div id="branchDropdown" class="dropdown"></div></span>
					<span id="hostControl"><span class="unselectable controlText">Host: </span><div id="hostDropdown" class="dropdown"></div></span>
					<span id="worktreeControl"><span class="unselectable controlText">Worktree: </span><div id="worktreeDropdown" class="dropdown"></div></span>
					<div id="findBtn" title="Find"></div>
					<div id="terminalBtn" title="Open a Terminal for this Repository"></div>
					<div id="settingsBtn" title="Repository Settings"></div>
					<div id="fetchBtn"></div>
					<div id="refreshBtn"></div>
				</div>
				<div id="content">
					<div id="commitGraph"></div>
					<div id="commitTable"></div>
				</div>
				<div id="footer"></div>
			</div>
			<div id="scrollShadow"></div>
			<script nonce="${nonce}">var initialState = ${JSON.stringify(initialState)}, globalState = ${JSON.stringify(globalState)}, workspaceState = ${JSON.stringify(workspaceState)};</script>
			<script nonce="${nonce}" src="${this.getMediaUri('out.min.js')}"></script>
			</body>`;
		} else {
			body = `<body class="unableToLoad">
			<h2>Unable to load Git Tree</h2>
			<p class="unableToLoadMessage">No Git repositories were found in the current workspace when it was last scanned by Git Tree.</p>
			<p>If your repositories are in subfolders of the open workspace folder(s), make sure you have set the Git Tree Setting "git-tree.maxDepthOfRepoSearch" appropriately.</p>
			<p><div id="rescanForReposBtn" class="roundedBtn">Re-scan the current workspace for repositories</div></p>
			<script nonce="${nonce}">(function(){ var api = acquireVsCodeApi(); document.getElementById('rescanForReposBtn').addEventListener('click', function(){ api.postMessage({command: 'rescanForRepos'}); }); })();</script>
			</body>`;
		}
		this.isGraphViewLoaded = numRepos > 0;
		this.loadViewTo = null;
		this.renderedConfig = this.getConfigKey();

		return `<!DOCTYPE html>
		<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${standardiseCspSource(this.panel.webview.cspSource)} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:;">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<link rel="stylesheet" type="text/css" href="${this.getMediaUri('out.min.css')}">
				<title>Git Tree</title>
				<style>body{${colorVars}} body.vscode-light, body.vscode-high-contrast-light{${colorVarsLight}} ${colorParams}</style>
			</head>
			${body}
		</html>`;
	}


	/* URI Manipulation Methods */

	/**
	 * Get a WebviewUri for a media file included in the extension.
	 * @param file The file name in the `media` directory.
	 * @returns The WebviewUri.
	 */
	private getMediaUri(file: string) {
		return this.panel.webview.asWebviewUri(this.getUri('media', file));
	}

	/**
	 * Get a File Uri for a resource file included in the extension.
	 * @param file The file name in the `resource` directory.
	 * @returns The Uri.
	 */
	private getResourcesUri(file: string) {
		return this.getUri('resources', file);
	}

	/**
	 * Get a File Uri for a file included in the extension.
	 * @param pathComps The path components relative to the root directory of the extension.
	 * @returns The File Uri.
	 */
	private getUri(...pathComps: string[]) {
		return vscode.Uri.file(path.join(this.extensionPath, ...pathComps));
	}


	/* Response Construction Methods */

	/**
	 * Send the known repositories to the front-end.
	 * @param repos The set of known repositories.
	 * @param loadViewTo What to load the view to.
	 */
	private respondLoadRepos(repos: GitRepoSet, loadViewTo: LoadGitTreeViewTo) {
		this.sendMessage({
			command: 'loadRepos',
			repos: repos,
			lastActiveRepo: this.extensionState.getLastActiveRepo(),
			loadViewTo: loadViewTo
		});
	}
}

/**
 * Standardise the CSP Source provided by Visual Studio Code for use with the Webview. It is idempotent unless called with http/https URI's, in which case it keeps only the authority portion of the http/https URI. This is necessary to be compatible with some web browser environments.
 * @param cspSource The value provide by Visual Studio Code.
 * @returns The standardised CSP Source.
 */
export function standardiseCspSource(cspSource: string) {
	if (cspSource.startsWith('http://') || cspSource.startsWith('https://')) {
		const pathIndex = cspSource.indexOf('/', 8), queryIndex = cspSource.indexOf('?', 8), fragmentIndex = cspSource.indexOf('#', 8);
		let endOfAuthorityIndex = pathIndex;
		if (queryIndex > -1 && (queryIndex < endOfAuthorityIndex || endOfAuthorityIndex === -1)) endOfAuthorityIndex = queryIndex;
		if (fragmentIndex > -1 && (fragmentIndex < endOfAuthorityIndex || endOfAuthorityIndex === -1)) endOfAuthorityIndex = fragmentIndex;
		return endOfAuthorityIndex > -1 ? cspSource.substring(0, endOfAuthorityIndex) : cspSource;
	} else {
		return cspSource;
	}
}
