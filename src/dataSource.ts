import * as cp from 'child_process';
import * as fs from 'fs';
import { decode, encodingExists } from 'iconv-lite';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AskpassEnvironment, AskpassManager } from './askpass/askpassManager';
import { getConfig } from './config';
import { BranchListEntry, CommitDetailsEntry, DiffOutput, Engine, EngineAnswer, EngineDetailsFormat, EngineFormat, EngineLogRequest, LogEntry, ShowRefEntry, StashListEntry, TagDetailsEntry, WorktreeListEntry } from './engine';
import { Logger } from './logger';
import { HOST_REFS_PREFIX, RemoteHostSnapshot, RemoteHosts, areLocalWorktreesShown, getHostBranchesPrefix, isRemoteHostShown } from './remoteHosts';
import { CommitOrdering, DateType, DeepWriteable, ErrorInfo, ErrorInfoExtensionPrefix, GitCommit, GitCommitDetails, GitCommitStash, GitConfigLocation, GitFileChange, GitFileStatus, GitPushBranchMode, GitRemoteHost, GitRepoConfig, GitRepoConfigBranches, GitResetMode, GitSignature, GitSignatureStatus, GitStash, GitTagDetails, GitWorktree, HostChoice, MergeActionOn, RebaseActionOn, SquashMessageFormat, TagType, Writeable } from './types';
import { GitExecutable, UNCOMMITTED, abbrevCommit, getGitExecutableError, getPathFromStr, getPathFromUri, openGitTerminal, pathWithTrailingSlash, realpath, resolveSpawnOutput, showErrorMessage } from './utils';
import { Disposable } from './utils/disposable';
import { Event } from './utils/event';
import { parseWorktreeList } from './worktreeList';

const DRIVE_LETTER_PATH_REGEX = /^[a-z]:\//;
const EOL_REGEX = /\r\n|\r|\n/g;
// Splits one-line-per-record output. A lone CR can appear inside a commit subject, so it doesn't end a record.
const RECORD_EOL_REGEX = /\r?\n/g;
const INVALID_BRANCH_REGEXP = /^\(.* .*\)$/;
const REMOTE_HEAD_BRANCH_REGEXP = /^remotes\/.*\/HEAD$/;
const GIT_LOG_SEPARATOR = 'XX7Nal-YARtTpjCikii9nJxER19D6diSyk-AWkPb';
const COMMITS_CACHE_SIZE = 8; // The most `commits` engine answers DataSource keeps, over all repositories and requests
// The names a remote host may have in `.worktrees/git-tree.yaml`. Only these become part of a ref name or a revision.
const HOST_NAME_REGEXP = /^[A-Za-z0-9_-]+$/;

export const enum GitConfigKey {
	DiffGuiTool = 'diff.guitool',
	DiffTool = 'diff.tool',
	RemotePushDefault = 'remote.pushdefault',
	UserEmail = 'user.email',
	UserName = 'user.name'
}

const GPG_STATUS_CODE_PARSING_DETAILS: Readonly<{ [statusCode: string]: GpgStatusCodeParsingDetails }> = {
	'GOODSIG': { status: GitSignatureStatus.GoodAndValid, uid: true },
	'BADSIG': { status: GitSignatureStatus.Bad, uid: true },
	'ERRSIG': { status: GitSignatureStatus.CannotBeChecked, uid: false },
	'EXPSIG': { status: GitSignatureStatus.GoodButExpired, uid: true },
	'EXPKEYSIG': { status: GitSignatureStatus.GoodButMadeByExpiredKey, uid: true },
	'REVKEYSIG': { status: GitSignatureStatus.GoodButMadeByRevokedKey, uid: true }
};

/**
 * Interfaces Git Tree with the Git executable to provide all Git integrations.
 */
export class DataSource extends Disposable {
	private readonly logger: Logger;
	private readonly askpassEnv: AskpassEnvironment;
	private gitExecutable!: GitExecutable | null; // The Git executable Git Tree runs. NULL => there's none, or it's older than Git Tree's minimum Git version
	private gitExecutableError!: string | null; // Why Git Tree can't run, when `gitExecutable` is NULL: no usable Git, or no engine
	private readonly engineError: string | null; // Why the engine couldn't be loaded, which stops Git Tree like an unusable Git
	public readonly remoteHosts: RemoteHosts | null; // The remote hosts of each repository, which the views and commands use too
	private gitFormatCommitDetails!: string;
	private gitFormatLog!: string;
	private gitFormatStash!: string;
	private engineFormat!: EngineFormat;
	private engineDetailsFormat!: EngineDetailsFormat;
	private readonly engine: Engine | null;
	private readonly commitsCache = new Map<string, CommitsCacheEntry>(); // The last `commits` engine answer for each repository and request, least recently used first
	private readonly commitGraphChecked = new Set<string>(); // The repositories whose commit-graph has been checked in this session

	/**
	 * Creates the Git Tree Data Source.
	 * @param gitExecutable The Git executable available to Git Tree at startup.
	 * @param onDidChangeGitExecutable The Event emitting the Git executable for Git Tree to use.
	 * @param logger The Git Tree Logger instance.
	 * @param engine The Git Tree engine, which reads repositories in-process. NULL => all reads use the Git CLI (the tests of the CLI reads).
	 * @param engineError Why the engine couldn't be loaded. Non-NULL => every read and action fails with it.
	 * @param remoteHosts The remote hosts of each repository. NULL => none (the tests that don't use them).
	 */
	constructor(gitExecutable: GitExecutable | null, onDidChangeConfiguration: Event<vscode.ConfigurationChangeEvent>, onDidChangeGitExecutable: Event<GitExecutable>, logger: Logger, engine: Engine | null = null, engineError: string | null = null, remoteHosts: RemoteHosts | null = null) {
		super();
		this.remoteHosts = remoteHosts;
		this.logger = logger;
		this.engine = engine;
		this.engineError = engineError;
		this.setGitExecutable(gitExecutable);

		const askpassManager = new AskpassManager();
		this.askpassEnv = askpassManager.getEnv();

		this.registerDisposables(
			onDidChangeConfiguration((event) => {
				if (
					event.affectsConfiguration('git-tree.date.type') || event.affectsConfiguration('git-tree.dateType') ||
					event.affectsConfiguration('git-tree.repository.commits.showSignatureStatus') || event.affectsConfiguration('git-tree.showSignatureStatus') ||
					event.affectsConfiguration('git-tree.repository.useMailmap') || event.affectsConfiguration('git-tree.useMailmap')
				) {
					this.generateGitCommandFormats();
				}
			}),
			onDidChangeGitExecutable((gitExecutable) => {
				this.setGitExecutable(gitExecutable);
			}),
			askpassManager
		);
	}

	/**
	 * Get the reason Git Tree can't run Git: there's no Git executable, or it's older than Git Tree's minimum Git version.
	 * @returns The message for the user, or NULL if Git Tree can run Git.
	 */
	public getGitExecutableError() {
		return this.gitExecutableError;
	}

	/**
	 * Set the Git executable used by the DataSource.
	 * @param gitExecutable The Git executable.
	 */
	private setGitExecutable(gitExecutable: GitExecutable | null) {
		this.gitExecutableError = this.engineError !== null ? this.engineError : getGitExecutableError(gitExecutable);
		this.gitExecutable = this.gitExecutableError === null ? gitExecutable : null;
		this.generateGitCommandFormats();
	}

	/**
	 * Generate the format strings used by various Git commands.
	 */
	private generateGitCommandFormats() {
		const config = getConfig();
		const dateType = config.dateType === DateType.Author ? '%at' : '%ct';
		const useMailmap = config.useMailmap;

		this.gitFormatCommitDetails = [
			'%H', '%P', // Hash & Parent Information
			useMailmap ? '%aN' : '%an', useMailmap ? '%aE' : '%ae', '%at', useMailmap ? '%cN' : '%cn', useMailmap ? '%cE' : '%ce', '%ct', // Author / Commit Information
			...(config.showSignatureStatus ? ['%G?', '%GS', '%GK'] : ['', '', '']), // GPG Key Information
			'%B' // Body
		].join(GIT_LOG_SEPARATOR);

		this.gitFormatLog = [
			'%H', '%P', // Hash & Parent Information
			useMailmap ? '%aN' : '%an', useMailmap ? '%aE' : '%ae', dateType, // Author / Commit Information
			'%s' // Subject
		].join(GIT_LOG_SEPARATOR);

		this.gitFormatStash = [
			'%H', '%P', '%gD', // Hash, Parent & Selector Information
			useMailmap ? '%aN' : '%an', useMailmap ? '%aE' : '%ae', dateType, // Author / Commit Information
			'%s' // Subject
		].join(GIT_LOG_SEPARATOR);

		// The same fields, for the engine's log and stash reads
		this.engineFormat = { mailmap: useMailmap, authorDate: config.dateType === DateType.Author };
		this.engineDetailsFormat = { mailmap: useMailmap, signature: config.showSignatureStatus };
	}


	/* Get Data Methods - Core */

	/**
	 * Get the high-level information of a repository.
	 * @param repo The path of the repository.
	 * @param showRemoteBranches Are remote branches shown.
	 * @param showStashes Are stashes shown.
	 * @param hideRemotes An array of hidden remotes.
	 * @param hideHosts The names of the hidden remote hosts, whose worktrees are left out.
	 * @param hostChoice The Host dropdown's choice: the remote hosts it doesn't show are left out too.
	 * @returns The repositories information. Its worktrees are the local ones, then each shown remote host's worktrees from the host's last refresh. Its hosts are all of them, shown or not.
	 */
	public getRepoInfo(repo: string, showRemoteBranches: boolean, showStashes: boolean, hideRemotes: ReadonlyArray<string>, hideHosts: ReadonlyArray<string> = [], hostChoice: HostChoice = null): Promise<GitRepoInfo> {
		// One engine crossing reads the four parts, and each part keeps its own Git CLI fallback
		const repoInfoPart = shareEngineRead((engine) => engine.repoInfo(repo, showRemoteBranches, showStashes ? this.engineFormat : null));
		// The hosts as they are now: this never waits for the network
		const hosts = this.getRemoteHosts(repo);
		return Promise.all([
			this.getBranches(repo, showRemoteBranches, hideRemotes, repoInfoPart((answer) => answer.branches)),
			this.getRemotes(repo, repoInfoPart((answer) => answer.remotes)),
			showStashes ? this.getStashes(repo, repoInfoPart((answer) => answer.stashes !== null ? answer.stashes : { failed: 'the answer has no stashes' })) : Promise.resolve([]),
			this.getWorktrees(repo, repoInfoPart((answer) => answer.worktrees))
		]).then((results) => {
			return { branches: results[0].branches, head: results[0].head, remotes: results[1], stashes: results[2], worktrees: results[3].concat(getRemoteHostWorktrees(hosts.filter((snapshot) => isRemoteHostShown(snapshot.host.name, hideHosts, hostChoice)))), hosts: hosts.map((snapshot) => snapshot.host), error: null };
		}).catch((errorMessage) => {
			return { branches: [], head: null, remotes: [], stashes: [], worktrees: [], hosts: [], error: errorMessage };
		});
	}

	/**
	 * Get the commits in a repository.
	 * @param repo The path of the repository.
	 * @param branches The list of branch heads to display, or NULL (show all).
	 * @param maxCommits The maximum number of commits to return.
	 * @param showTags Are tags are shown.
	 * @param showRemoteBranches Are remote branches shown.
	 * @param includeCommitsMentionedByReflogs Should commits mentioned by reflogs being included.
	 * @param onlyFollowFirstParent Only follow the first parent of commits.
	 * @param commitOrdering The order for commits to be returned.
	 * @param remotes An array of known remotes.
	 * @param hideRemotes An array of hidden remotes.
	 * @param stashes An array of all stashes in the repository.
	 * @param worktrees An array of all worktrees of the repository: the local ones, then the remote hosts'. Each other worktree with uncommitted changes gets its own row.
	 * @param onlyWorktreeHistory Show only the history of the worktree that `repo` is: its HEAD joins `branches` as a start point (all branches are left out when `branches` is NULL), and other worktrees' uncommitted changes are left out.
	 * @param onlyHostWorktree A remote host's worktree (one of `worktrees`) whose history alone is shown: its HEAD commit joins `branches` as a start point if it is on this machine, and only its uncommitted changes are shown. `repo` is then the repository. NULL => none.
	 * @param hideHosts The names of the hidden remote hosts: their refs are neither start points nor labels, and their worktrees get no rows.
	 * @param hostChoice The Host dropdown's choice: the remote hosts it doesn't show are left out too, and when it chose a host, this machine's worktrees get no rows.
	 * @returns The commits in the repository.
	 */
	public getCommits(repo: string, branches: ReadonlyArray<string> | null, maxCommits: number, showTags: boolean, showRemoteBranches: boolean, includeCommitsMentionedByReflogs: boolean, onlyFollowFirstParent: boolean, commitOrdering: CommitOrdering, remotes: ReadonlyArray<string>, hideRemotes: ReadonlyArray<string>, stashes: ReadonlyArray<GitStash>, worktrees: ReadonlyArray<GitWorktree>, onlyWorktreeHistory: boolean = false, onlyHostWorktree: GitWorktree | null = null, hideHosts: ReadonlyArray<string> = [], hostChoice: HostChoice = null): Promise<GitCommitData> {
		const config = getConfig();
		// The shown hosts as they are now: their names give the refs to read, and their snapshots the counts of their worktrees' changes
		const hosts = this.getRemoteHosts(repo).filter((snapshot) => isRemoteHostShown(snapshot.host.name, hideHosts, hostChoice));
		const localWorktreesShown = areLocalWorktreesShown(hostChoice);
		const hostNames = hosts.map((snapshot) => snapshot.host.name).filter((name) => HOST_NAME_REGEXP.test(name));
		let startPoints: ReadonlyArray<string> | null;
		if (onlyHostWorktree !== null) {
			if (onlyHostWorktree.head === null && (branches === null || branches.length === 0)) {
				// Without a start point, the log would start from HEAD, which isn't the host worktree's history
				return Promise.resolve({ commits: [], head: null, tags: [], moreCommitsAvailable: false, error: null });
			}
			// The log runs in the repository. The host worktree's commit is only here once its host has been fetched, and
			// --ignore-missing leaves it out until then, as it does for every revision after it.
			startPoints = (branches !== null ? branches : []).concat(onlyHostWorktree.head !== null ? ['--ignore-missing', onlyHostWorktree.head] : []);
		} else {
			// The log runs in the worktree, so HEAD is the worktree's own HEAD, whether it is on a branch or detached
			startPoints = onlyWorktreeHistory ? (branches !== null ? branches : []).concat('HEAD') : branches;
		}
		const logRead = this.getLogRead(startPoints, maxCommits + 1, showTags && config.showCommitsOnlyReferencedByTags, showRemoteBranches, includeCommitsMentionedByReflogs, onlyFollowFirstParent, commitOrdering, remotes, hideRemotes, stashes, hostNames);
		// One engine crossing reads the log page and the refs, and each keeps its own Git CLI fallback
		const commitsPart = shareEngineRead((engine) => this.readCommitsWithEngine(engine, repo, showRemoteBranches, logRead.request));
		const log = this.getLog(repo, logRead, commitsPart((answer) => answer.log));
		const refs = this.getRefs(repo, showRemoteBranches, config.showRemoteHeads, hideRemotes, commitsPart((answer) => answer.refs), hostNames).then((refData: GitRefData) => refData, (errorMessage: string) => errorMessage);
		// Git status is often the slowest command in a large repository, so it runs alongside the log instead of after it
		const uncommittedChanges = config.showUncommittedChanges && onlyHostWorktree === null && localWorktreesShown ? this.getUncommittedChanges(repo) : null;
		if (uncommittedChanges !== null) {
			// Its result, or error, is only used when HEAD is one of the loaded commits
			uncommittedChanges.catch(() => { });
		}
		// The other local worktrees' uncommitted changes, also read alongside the log. The index of each worktree in `worktrees` identifies its row.
		const indexedWorktrees = worktrees.map((worktree, index) => ({ worktree: worktree, index: index }));
		const otherWorktrees = config.showUncommittedChanges && !onlyWorktreeHistory && onlyHostWorktree === null && localWorktreesShown
			? indexedWorktrees.filter((item) => typeof item.worktree.host === 'undefined' && !item.worktree.isCurrent && !item.worktree.prunable && item.worktree.head !== null)
			: [];
		const otherUncommittedChanges = Promise.all(otherWorktrees.map((item) => this.getUncommittedChanges(item.worktree.path).catch(() => null)));
		// The remote hosts' worktrees, whose counts come from each host's last refresh, after the local worktrees' rows
		const hostWorktrees = config.showUncommittedChanges && !onlyWorktreeHistory
			? indexedWorktrees.filter((item) => typeof item.worktree.host !== 'undefined' && isRemoteHostShown(item.worktree.host, hideHosts, hostChoice) && !item.worktree.prunable && item.worktree.head !== null &&
				(onlyHostWorktree === null || (item.worktree.host === onlyHostWorktree.host && item.worktree.path === onlyHostWorktree.path)))
			: [];

		return Promise.all([log, refs]).then(async (results) => {
			let commits: GitCommitRecord[] = results[0], refData: GitRefData | string = results[1], i;
			let moreCommitsAvailable = commits.length === maxCommits + 1;
			if (moreCommitsAvailable) commits.pop();

			// It doesn't matter if getRefs() was rejected if no commits exist
			if (typeof refData === 'string') {
				// getRefs() returned an error message (string)
				if (commits.length > 0) {
					// Commits exist, throw the error
					throw refData;
				} else {
					// No commits exist, so getRefs() will always return an error. Set refData to the default value
					refData = { head: null, heads: [], tags: [], remotes: [], hostBranches: [] };
				}
			}

			if (refData.head !== null && uncommittedChanges !== null) {
				for (i = 0; i < commits.length; i++) {
					if (refData.head === commits[i].hash) {
						const numUncommittedChanges = await uncommittedChanges;
						if (numUncommittedChanges > 0) {
							commits.unshift({ hash: UNCOMMITTED, parents: [refData.head], author: '*', email: '', date: Math.round((new Date()).getTime() / 1000), message: 'Uncommitted Changes (' + numUncommittedChanges + ')' });
						}
						break;
					}
				}
			}

			if (otherWorktrees.length > 0 || hostWorktrees.length > 0) {
				const loadedHashes = new Set(commits.map((commit) => commit.hash));
				const otherCounts = await otherUncommittedChanges;
				const otherRows: GitCommitRecord[] = [];
				const addRow = (item: { worktree: GitWorktree, index: number }, count: number | null) => {
					const worktree = item.worktree;
					if (!loadedHashes.has(worktree.head!) || count === 0) return;
					const row: GitCommitRecord = {
						hash: UNCOMMITTED + item.index,
						parents: [worktree.head!],
						author: '*',
						email: '',
						date: Math.round((new Date()).getTime() / 1000),
						// When Git status fails, say so, rather than looking like the worktree has no changes
						message: count !== null ? 'Uncommitted Changes (' + count + ')' : 'Uncommitted Changes (unable to read them)',
						worktree: worktree.path
					};
					if (typeof worktree.host !== 'undefined') row.host = worktree.host;
					otherRows.push(row);
				};
				for (i = 0; i < otherWorktrees.length; i++) {
					addRow(otherWorktrees[i], otherCounts[i]);
				}
				for (i = 0; i < hostWorktrees.length; i++) {
					const remoteWorktree = findRemoteWorktree(hosts, hostWorktrees[i].worktree);
					// A worktree the host's last refresh no longer has gets no row: the view's list is older, and the refresh that changed the host refreshes the view too
					if (remoteWorktree !== null) addRow(hostWorktrees[i], remoteWorktree.uncommittedChanges);
				}
				// The rows go after the viewed worktree's row, which stays first
				commits.splice(commits.length > 0 && commits[0].hash === UNCOMMITTED ? 1 : 0, 0, ...otherRows);
			}

			let commitNodes: DeepWriteable<GitCommit>[] = [];
			let commitLookup: { [hash: string]: number } = {};

			for (i = 0; i < commits.length; i++) {
				commitLookup[commits[i].hash] = i;
				commitNodes.push({ ...commits[i], heads: [], tags: [], remotes: [], stash: null });
			}

			/* Insert Stashes */
			let toAdd: { index: number, data: GitStash }[] = [];
			for (i = 0; i < stashes.length; i++) {
				if (typeof commitLookup[stashes[i].hash] === 'number') {
					commitNodes[commitLookup[stashes[i].hash]].stash = {
						selector: stashes[i].selector,
						baseHash: stashes[i].baseHash,
						untrackedFilesHash: stashes[i].untrackedFilesHash
					};
				} else if (typeof commitLookup[stashes[i].baseHash] === 'number') {
					toAdd.push({ index: commitLookup[stashes[i].baseHash], data: stashes[i] });
				}
			}
			toAdd.sort((a, b) => a.index !== b.index ? a.index - b.index : b.data.date - a.data.date);
			for (i = toAdd.length - 1; i >= 0; i--) {
				let stash = toAdd[i].data;
				commitNodes.splice(toAdd[i].index, 0, {
					hash: stash.hash,
					parents: [stash.baseHash],
					author: stash.author,
					email: stash.email,
					date: stash.date,
					message: stash.message,
					heads: [], tags: [], remotes: [],
					stash: {
						selector: stash.selector,
						baseHash: stash.baseHash,
						untrackedFilesHash: stash.untrackedFilesHash
					}
				});
			}
			for (i = 0; i < commitNodes.length; i++) {
				// Correct commit lookup after stashes have been spliced in
				commitLookup[commitNodes[i].hash] = i;
			}

			/* Annotate Heads */
			for (i = 0; i < refData.heads.length; i++) {
				if (typeof commitLookup[refData.heads[i].hash] === 'number') commitNodes[commitLookup[refData.heads[i].hash]].heads.push(refData.heads[i].name);
			}

			/* Annotate Tags */
			if (showTags) {
				for (i = 0; i < refData.tags.length; i++) {
					if (typeof commitLookup[refData.tags[i].hash] === 'number') commitNodes[commitLookup[refData.tags[i].hash]].tags.push({ name: refData.tags[i].name, annotated: refData.tags[i].annotated });
				}
			}

			/* Annotate Remotes */
			for (i = 0; i < refData.remotes.length; i++) {
				if (typeof commitLookup[refData.remotes[i].hash] === 'number') {
					let name = refData.remotes[i].name;
					let remote = remotes.find(remote => name.startsWith(remote + '/'));
					commitNodes[commitLookup[refData.remotes[i].hash]].remotes.push({ name: name, remote: remote ? remote : null });
				}
			}

			/* Annotate the Remote Hosts' Branches */
			for (i = 0; i < refData.hostBranches.length; i++) {
				const hostBranch = refData.hostBranches[i];
				if (typeof commitLookup[hostBranch.hash] === 'number') {
					const node = commitNodes[commitLookup[hostBranch.hash]];
					// The field is only set on the commits that have a host's branch, like the other optional fields
					(node.hostBranches || (node.hostBranches = [])).push({ host: hostBranch.host, name: hostBranch.name });
				}
			}

			return {
				commits: commitNodes,
				head: refData.head,
				tags: unique(refData.tags.map((tag) => tag.name)),
				moreCommitsAvailable: moreCommitsAvailable,
				error: null
			};
		}).catch((errorMessage) => {
			return { commits: [], head: null, tags: [], moreCommitsAvailable: false, error: errorMessage };
		});
	}

	/**
	 * Get various Git config variables for a repository that are consumed by the Git Tree View.
	 * @param repo The path of the repository.
	 * @param remotes An array of known remotes.
	 * @returns The config data.
	 */
	public getConfig(repo: string, remotes: ReadonlyArray<string>): Promise<GitRepoConfigData> {
		return Promise.all([
			this.getConfigList(repo),
			this.getConfigList(repo, GitConfigLocation.Local),
			this.getConfigList(repo, GitConfigLocation.Global)
		]).then((results) => {
			const consolidatedConfigs = results[0], localConfigs = results[1], globalConfigs = results[2];

			const branches: GitRepoConfigBranches = {};
			Object.keys(localConfigs).forEach((key) => {
				if (key.startsWith('branch.')) {
					if (key.endsWith('.remote')) {
						const branchName = key.substring(7, key.length - 7);
						branches[branchName] = {
							pushRemote: typeof branches[branchName] !== 'undefined' ? branches[branchName].pushRemote : null,
							remote: localConfigs[key]
						};
					} else if (key.endsWith('.pushremote')) {
						const branchName = key.substring(7, key.length - 11);
						branches[branchName] = {
							pushRemote: localConfigs[key],
							remote: typeof branches[branchName] !== 'undefined' ? branches[branchName].remote : null
						};
					}
				}
			});

			return {
				config: {
					branches: branches,
					diffTool: getConfigValue(consolidatedConfigs, GitConfigKey.DiffTool),
					guiDiffTool: getConfigValue(consolidatedConfigs, GitConfigKey.DiffGuiTool),
					pushDefault: getConfigValue(consolidatedConfigs, GitConfigKey.RemotePushDefault),
					remotes: remotes.map((remote) => ({
						name: remote,
						url: getConfigValue(localConfigs, 'remote.' + remote + '.url'),
						pushUrl: getConfigValue(localConfigs, 'remote.' + remote + '.pushurl')
					})),
					user: {
						name: {
							local: getConfigValue(localConfigs, GitConfigKey.UserName),
							global: getConfigValue(globalConfigs, GitConfigKey.UserName)
						},
						email: {
							local: getConfigValue(localConfigs, GitConfigKey.UserEmail),
							global: getConfigValue(globalConfigs, GitConfigKey.UserEmail)
						}
					}
				},
				error: null
			};
		}).catch((errorMessage) => {
			return { config: null, error: errorMessage };
		});
	}


	/* Get Data Methods - Commit Details View */

	/**
	 * Get the commit details for the Commit Details View.
	 * @param repo The path of the repository.
	 * @param commitHash The hash of the commit open in the Commit Details View.
	 * @param hasParents Does the commit have parents
	 * @returns The commit details.
	 */
	public getCommitDetails(repo: string, commitHash: string, hasParents: boolean): Promise<GitCommitDetailsData> {
		const fromCommit = commitHash + (hasParents ? '^' : '');
		return Promise.all([
			this.getCommitDetailsBase(repo, commitHash),
			this.getDiff(repo, fromCommit, commitHash)
		]).then((results) => {
			results[0].fileChanges = generateFileChanges(results[1].nameStatus, results[1].numStat, null);
			return { commitDetails: results[0], error: null };
		}).catch((errorMessage) => {
			return { commitDetails: null, error: errorMessage };
		});
	}

	/**
	 * Get the stash details for the Commit Details View.
	 * @param repo The path of the repository.
	 * @param commitHash The hash of the stash commit open in the Commit Details View.
	 * @param stash The stash.
	 * @returns The stash details.
	 */
	public getStashDetails(repo: string, commitHash: string, stash: GitCommitStash): Promise<GitCommitDetailsData> {
		return Promise.all([
			this.getCommitDetailsBase(repo, commitHash),
			this.getDiff(repo, stash.baseHash, commitHash),
			stash.untrackedFilesHash !== null ? this.getDiff(repo, stash.untrackedFilesHash, stash.untrackedFilesHash) : Promise.resolve(null)
		]).then((results) => {
			results[0].fileChanges = generateFileChanges(results[1].nameStatus, results[1].numStat, null);
			if (results[2] !== null) {
				generateFileChanges(results[2].nameStatus, results[2].numStat, null).forEach((fileChange) => {
					if (fileChange.type === GitFileStatus.Added) {
						fileChange.type = GitFileStatus.Untracked;
						results[0].fileChanges.push(fileChange);
					}
				});
			}
			return { commitDetails: results[0], error: null };
		}).catch((errorMessage) => {
			return { commitDetails: null, error: errorMessage };
		});
	}

	/**
	 * Get the uncommitted details for the Commit Details View.
	 * @param repo The path of the repository.
	 * @returns The uncommitted details.
	 */
	public getUncommittedDetails(repo: string): Promise<GitCommitDetailsData> {
		return Promise.all([
			this.getDiff(repo, 'HEAD', ''),
			this.getStatus(repo)
		]).then((results) => {
			return {
				commitDetails: {
					hash: UNCOMMITTED, parents: [],
					author: '', authorEmail: '', authorDate: 0,
					committer: '', committerEmail: '', committerDate: 0, signature: null,
					body: '', fileChanges: generateFileChanges(results[0].nameStatus, results[0].numStat, results[1])
				},
				error: null
			};
		}).catch((errorMessage) => {
			return { commitDetails: null, error: errorMessage };
		});
	}

	/**
	 * Get the comparison details for the Commit Comparison View.
	 * @param repo The path of the repository.
	 * @param fromHash The commit hash the comparison is from.
	 * @param toHash The commit hash the comparison is to.
	 * @returns The comparison details.
	 */
	public getCommitComparison(repo: string, fromHash: string, toHash: string): Promise<GitCommitComparisonData> {
		return Promise.all([
			this.getDiff(repo, fromHash, toHash === UNCOMMITTED ? '' : toHash),
			toHash === UNCOMMITTED ? this.getStatus(repo) : Promise.resolve(null)
		]).then((results) => {
			return {
				fileChanges: generateFileChanges(results[0].nameStatus, results[0].numStat, results[1]),
				error: null
			};
		}).catch((errorMessage) => {
			return { fileChanges: [], error: errorMessage };
		});
	}

	/**
	 * Get the contents of a file at a specific revision.
	 * @param repo The path of the repository.
	 * @param commitHash The commit hash specifying the revision of the file.
	 * @param filePath The path of the file relative to the repositories root.
	 * @returns The file contents.
	 */
	public getCommitFile(repo: string, commitHash: string, filePath: string) {
		return this.readWithEngine('commit file', (engine) => engine.commitFile(repo, commitHash, filePath).then((answer): EngineAnswer<Buffer> => 'ok' in answer ? { ok: Buffer.from(answer.ok, 'base64') } : answer), () => this._spawnGit(['show', commitHash + ':' + filePath], repo, (stdout) => stdout)).then((contents) => {
			const encoding = getConfig(repo).fileEncoding;
			return decode(contents, encodingExists(encoding) ? encoding : 'utf8');
		});
	}


	/* Get Data Methods - General */

	/**
	 * Get the subject of a commit.
	 * @param repo The path of the repository.
	 * @param commitHash The commit hash.
	 * @returns The subject string, or NULL if an error occurred.
	 */
	public getCommitSubject(repo: string, commitHash: string): Promise<string | null> {
		return this.readWithEngine('commit subject', (engine) => engine.commitSubject(repo, commitHash), () => this.spawnGit(['-c', 'log.showSignature=false', 'log', '--format=%s', '-n', '1', commitHash, '--'], repo, (stdout) => stdout)).then((subject) => {
			return subject.trim().replace(/\s+/g, ' ');
		}, () => null);
	}

	/**
	 * Get the URL of a repositories remote.
	 * @param repo The path of the repository.
	 * @param remote The name of the remote.
	 * @returns The URL, or NULL if an error occurred.
	 */
	public getRemoteUrl(repo: string, remote: string): Promise<string | null> {
		// The engine answers NULL when the URL isn't set, where Git fails
		return this.readWithEngine('remote URL', (engine) => engine.remoteUrl(repo, remote), (): Promise<string | null> => this.spawnGit(['config', '--get', 'remote.' + remote + '.url'], repo, (stdout) => stdout)).then((url) => {
			return url !== null ? url.split(EOL_REGEX)[0] : null;
		}, () => null);
	}

	/**
	 * Check to see if a file has been renamed between a commit and the working tree, and return the new file path.
	 * @param repo The path of the repository.
	 * @param commitHash The commit hash where `oldFilePath` is known to have existed.
	 * @param oldFilePath The file path that may have been renamed.
	 * @returns The new renamed file path, or NULL if either: the file wasn't renamed or the Git command failed to execute.
	 */
	public getNewPathOfRenamedFile(repo: string, commitHash: string, oldFilePath: string) {
		return this.getDiffNameStatus(repo, commitHash, '', 'R').then((renamed) => {
			const renamedRecordForFile = renamed.find((record) => record.oldFilePath === oldFilePath);
			return renamedRecordForFile ? renamedRecordForFile.newFilePath : null;
		}).catch(() => null);
	}

	/**
	 * Get the details of a tag.
	 * @param repo The path of the repository.
	 * @param tagName The name of the tag.
	 * @returns The tag details.
	 */
	public getTagDetails(repo: string, tagName: string): Promise<GitTagDetailsData> {
		const ref = 'refs/tags/' + tagName;
		return this.readWithEngine('tag details', (engine) => engine.tagDetails(repo, tagName), () => this.spawnGit(['for-each-ref', ref, '--format=' + ['%(objectname)', '%(taggername)', '%(taggeremail)', '%(taggerdate:unix)', '%(contents:signature)', '%(contents)'].join(GIT_LOG_SEPARATOR)], repo, (stdout): TagDetailsEntry => {
			const data = stdout.split(GIT_LOG_SEPARATOR);
			return { hash: data[0], taggerName: data[1], taggerEmail: data[2], taggerDate: data[3], signature: data[4], contents: data.slice(5).join(GIT_LOG_SEPARATOR) };
		})).then((entry) => ({
			hash: entry.hash,
			taggerName: entry.taggerName,
			taggerEmail: entry.taggerEmail.substring(entry.taggerEmail.startsWith('<') ? 1 : 0, entry.taggerEmail.length - (entry.taggerEmail.endsWith('>') ? 1 : 0)),
			taggerDate: parseInt(entry.taggerDate),
			message: removeTrailingBlankLines(entry.contents.replace(entry.signature, '').split(EOL_REGEX)).join('\n'),
			signed: entry.signature !== ''
		})).then(async (tag) => ({
			details: {
				hash: tag.hash,
				taggerName: tag.taggerName,
				taggerEmail: tag.taggerEmail,
				taggerDate: tag.taggerDate,
				message: tag.message,
				signature: tag.signed
					? await this.getTagSignature(repo, ref)
					: null
			},
			error: null
		})).catch((errorMessage) => ({
			details: null,
			error: errorMessage
		}));
	}

	/**
	 * Get the submodules of a repository.
	 * @param repo The path of the repository.
	 * @returns An array of the paths of the submodules.
	 */
	public getSubmodules(repo: string) {
		return new Promise<string[]>(resolve => {
			fs.readFile(path.join(repo, '.gitmodules'), { encoding: 'utf8' }, async (err, data) => {
				let submodules: string[] = [];
				if (!err) {
					let lines = data.split(EOL_REGEX), inSubmoduleSection = false, match;
					const section = /^\s*\[.*\]\s*$/, submodule = /^\s*\[submodule "([^"]+)"\]\s*$/, pathProp = /^\s*path\s+=\s+(.*)$/;

					for (let i = 0; i < lines.length; i++) {
						if (lines[i].match(section) !== null) {
							inSubmoduleSection = lines[i].match(submodule) !== null;
							continue;
						}

						if (inSubmoduleSection && (match = lines[i].match(pathProp)) !== null) {
							let root = await this.repoRoot(getPathFromUri(vscode.Uri.file(path.join(repo, getPathFromStr(match[1])))));
							if (root !== null && !submodules.includes(root)) {
								submodules.push(root);
							}
						}
					}
				}
				resolve(submodules);
			});
		});
	}


	/* Repository Info Methods */

	/**
	 * Check if there are any staged changes in the repository.
	 * @param repo The path of the repository.
	 * @returns TRUE => Staged Changes, FALSE => No Staged Changes.
	 */
	private areStagedChanges(repo: string) {
		return this.spawnGit(['diff-index', 'HEAD'], repo, (stdout) => stdout !== '').then(changes => changes, () => false);
	}

	/**
	 * Get the root of the repository containing the specified path.
	 * @param pathOfPotentialRepo The path that is potentially a repository (or is contained within a repository).
	 * @returns STRING => The root of the repository, NULL => `pathOfPotentialRepo` is not in a repository.
	 */
	public repoRoot(pathOfPotentialRepo: string) {
		return this.spawnGit(['rev-parse', '--show-toplevel'], pathOfPotentialRepo, (stdout) => getPathFromUri(vscode.Uri.file(path.normalize(stdout.trim())))).then(async (pathReturnedByGit) => {
			if (process.platform === 'win32') {
				// On Windows Mapped Network Drives with Git >= 2.25.0, `git rev-parse --show-toplevel` returns the UNC Path for the Mapped Network Drive, instead of the Drive Letter.
				// Attempt to replace the UNC Path with the Drive Letter.
				let driveLetterPathMatch: RegExpMatchArray | null;
				if ((driveLetterPathMatch = pathOfPotentialRepo.match(DRIVE_LETTER_PATH_REGEX)) && !pathReturnedByGit.match(DRIVE_LETTER_PATH_REGEX)) {
					const realPathForDriveLetter = pathWithTrailingSlash(await realpath(driveLetterPathMatch[0], true));
					if (realPathForDriveLetter !== driveLetterPathMatch[0] && pathReturnedByGit.startsWith(realPathForDriveLetter)) {
						pathReturnedByGit = driveLetterPathMatch[0] + pathReturnedByGit.substring(realPathForDriveLetter.length);
					}
				}
			}
			let path = pathOfPotentialRepo;
			let first = path.indexOf('/');
			while (true) {
				if (pathReturnedByGit === path || pathReturnedByGit === await realpath(path)) return path;
				let next = path.lastIndexOf('/');
				if (first !== next && next > -1) {
					path = path.substring(0, next);
				} else {
					return pathReturnedByGit;
				}
			}
		}).catch(() => null); // null => path is not in a repo
	}


	/* Git Action Methods - Remotes */

	/**
	 * Add a new remote to a repository.
	 * @param repo The path of the repository.
	 * @param name The name of the remote.
	 * @param url The URL of the remote.
	 * @param pushUrl The Push URL of the remote.
	 * @param fetch Fetch the remote after it is added.
	 * @returns The ErrorInfo from the executed command.
	 */
	public async addRemote(repo: string, name: string, url: string, pushUrl: string | null, fetch: boolean) {
		let status = await this.runGitCommand(['remote', 'add', name, url], repo);
		if (status !== null) return status;

		if (pushUrl !== null) {
			status = await this.runGitCommand(['remote', 'set-url', name, '--push', pushUrl], repo);
			if (status !== null) return status;
		}

		return fetch ? this.fetch(repo, name, false, false) : null;
	}

	/**
	 * Delete an existing remote from a repository.
	 * @param repo The path of the repository.
	 * @param name The name of the remote.
	 * @returns The ErrorInfo from the executed command.
	 */
	public deleteRemote(repo: string, name: string) {
		return this.runGitCommand(['remote', 'remove', name], repo);
	}

	/**
	 * Edit an existing remote of a repository.
	 * @param repo The path of the repository.
	 * @param nameOld The old name of the remote.
	 * @param nameNew The new name of the remote.
	 * @param urlOld The old URL of the remote.
	 * @param urlNew The new URL of the remote.
	 * @param pushUrlOld The old Push URL of the remote.
	 * @param pushUrlNew The new Push URL of the remote.
	 * @returns The ErrorInfo from the executed command.
	 */
	public async editRemote(repo: string, nameOld: string, nameNew: string, urlOld: string | null, urlNew: string | null, pushUrlOld: string | null, pushUrlNew: string | null) {
		if (nameOld !== nameNew) {
			let status = await this.runGitCommand(['remote', 'rename', nameOld, nameNew], repo);
			if (status !== null) return status;
		}

		if (urlOld !== urlNew) {
			let args = ['remote', 'set-url', nameNew];
			if (urlNew === null) args.push('--delete', urlOld!);
			else if (urlOld === null) args.push('--add', urlNew);
			else args.push(urlNew, urlOld);

			let status = await this.runGitCommand(args, repo);
			if (status !== null) return status;
		}

		if (pushUrlOld !== pushUrlNew) {
			let args = ['remote', 'set-url', '--push', nameNew];
			if (pushUrlNew === null) args.push('--delete', pushUrlOld!);
			else if (pushUrlOld === null) args.push('--add', pushUrlNew);
			else args.push(pushUrlNew, pushUrlOld);

			let status = await this.runGitCommand(args, repo);
			if (status !== null) return status;
		}

		return null;
	}

	/**
	 * Prune an existing remote of a repository.
	 * @param repo The path of the repository.
	 * @param name The name of the remote.
	 * @returns The ErrorInfo from the executed command.
	 */
	public pruneRemote(repo: string, name: string) {
		return this.runGitCommand(['remote', 'prune', name], repo);
	}


	/* Git Action Methods - Tags */

	/**
	 * Add a new tag to a commit.
	 * @param repo The path of the repository.
	 * @param tagName The name of the tag.
	 * @param commitHash The hash of the commit the tag should be added to.
	 * @param type Is the tag annotated or lightweight.
	 * @param message The message of the tag (if it is an annotated tag).
	 * @param force Force add the tag, replacing an existing tag with the same name (if it exists).
	 * @returns The ErrorInfo from the executed command.
	 */
	public addTag(repo: string, tagName: string, commitHash: string, type: TagType, message: string, force: boolean) {
		const args = ['tag'];
		if (force) {
			args.push('-f');
		}
		if (type === TagType.Lightweight) {
			args.push(tagName);
		} else {
			args.push(getConfig().signTags ? '-s' : '-a', tagName, '-m', message);
		}
		args.push(commitHash);
		return this.runGitCommand(args, repo);
	}

	/**
	 * Delete an existing tag from a repository.
	 * @param repo The path of the repository.
	 * @param tagName The name of the tag.
	 * @param deleteOnRemote The name of the remote to delete the tag on, or NULL.
	 * @returns The ErrorInfo from the executed command.
	 */
	public async deleteTag(repo: string, tagName: string, deleteOnRemote: string | null) {
		if (deleteOnRemote !== null) {
			// The full ref name, so a branch with the same name doesn't make the push ambiguous
			let status = await this.runGitCommand(['push', deleteOnRemote, '--delete', 'refs/tags/' + tagName], repo);
			if (status !== null) return status;
		}
		return this.runGitCommand(['tag', '-d', tagName], repo);
	}


	/* Git Action Methods - Remote Sync */

	/**
	 * Fetch from the repositories remote(s).
	 * @param repo The path of the repository.
	 * @param remote The remote to fetch, or NULL (fetch all remotes).
	 * @param prune Is pruning enabled.
	 * @param pruneTags Should tags be pruned.
	 * @returns The ErrorInfo from the executed command.
	 */
	public fetch(repo: string, remote: string | null, prune: boolean, pruneTags: boolean) {
		let args = ['fetch', remote === null ? '--all' : remote];

		if (prune) {
			args.push('--prune');
		}
		if (pruneTags) {
			if (!prune) {
				return Promise.resolve('In order to Prune Tags, pruning must also be enabled when fetching from ' + (remote !== null ? 'a remote' : 'remote(s)') + '.');
			}
			args.push('--prune-tags');
		}

		return this.runGitCommand(args, repo);
	}

	/**
	 * Push a branch to a remote.
	 * @param repo The path of the repository.
	 * @param branchName The name of the branch to push.
	 * @param remote The remote to push the branch to.
	 * @param setUpstream Set the branches upstream.
	 * @param mode The mode of the push.
	 * @returns The ErrorInfo from the executed command.
	 */
	public pushBranch(repo: string, branchName: string, remote: string, setUpstream: boolean, mode: GitPushBranchMode) {
		let args = ['push'];
		args.push(remote, branchName);
		if (setUpstream) args.push('--set-upstream');
		if (mode !== GitPushBranchMode.Normal) args.push('--' + mode);

		return this.runGitCommand(args, repo);
	}

	/**
	 * Push a branch to multiple remotes.
	 * @param repo The path of the repository.
	 * @param branchName The name of the branch to push.
	 * @param remotes The remotes to push the branch to.
	 * @param setUpstream Set the branches upstream.
	 * @param mode The mode of the push.
	 * @returns The ErrorInfo's from the executed commands.
	 */
	public async pushBranchToMultipleRemotes(repo: string, branchName: string, remotes: string[], setUpstream: boolean, mode: GitPushBranchMode): Promise<ErrorInfo[]> {
		if (remotes.length === 0) {
			return ['No remote(s) were specified to push the branch ' + branchName + ' to.'];
		}

		const results: ErrorInfo[] = [];
		for (let i = 0; i < remotes.length; i++) {
			const result = await this.pushBranch(repo, branchName, remotes[i], setUpstream, mode);
			results.push(result);
			if (result !== null) break;
		}
		return results;
	}

	/**
	 * Push a tag to remote(s).
	 * @param repo The path of the repository.
	 * @param tagName The name of the tag to push.
	 * @param remotes The remote(s) to push the tag to.
	 * @param commitHash The commit hash the tag is on.
	 * @param skipRemoteCheck Skip checking that the tag is on each of the `remotes`.
	 * @returns The ErrorInfo's from the executed commands.
	 */
	public async pushTag(repo: string, tagName: string, remotes: string[], commitHash: string, skipRemoteCheck: boolean): Promise<ErrorInfo[]> {
		if (remotes.length === 0) {
			return ['No remote(s) were specified to push the tag ' + tagName + ' to.'];
		}

		if (!skipRemoteCheck) {
			const remotesContainingCommit = await this.getRemotesContainingCommit(repo, commitHash, remotes).catch(() => remotes);
			const remotesNotContainingCommit = remotes.filter((remote) => !remotesContainingCommit.includes(remote));
			if (remotesNotContainingCommit.length > 0) {
				return [ErrorInfoExtensionPrefix.PushTagCommitNotOnRemote + JSON.stringify(remotesNotContainingCommit)];
			}
		}

		const results: ErrorInfo[] = [];
		for (let i = 0; i < remotes.length; i++) {
			const result = await this.runGitCommand(['push', remotes[i], 'refs/tags/' + tagName], repo);
			results.push(result);
			if (result !== null) break;
		}
		return results;
	}


	/* Git Action Methods - Branches */

	/**
	 * Checkout a branch in a repository.
	 * @param repo The path of the repository.
	 * @param branchName The name of the branch to checkout.
	 * @param remoteBranch The name of the remote branch to check out (if not NULL).
	 * @returns The ErrorInfo from the executed command.
	 */
	public checkoutBranch(repo: string, branchName: string, remoteBranch: string | null) {
		let args = ['checkout'];
		if (remoteBranch === null) args.push(branchName);
		else args.push('-b', branchName, remoteBranch);

		return this.runGitCommand(args, repo);
	}

	/**
	 * Create a branch at a commit.
	 * @param repo The path of the repository.
	 * @param branchName The name of the branch.
	 * @param commitHash The hash of the commit the branch should be created at.
	 * @param checkout Check out the branch after it is created.
	 * @param force Force create the branch, replacing an existing branch with the same name (if it exists).
	 * @returns The ErrorInfo's from the executed command(s).
	 */
	public async createBranch(repo: string, branchName: string, commitHash: string, checkout: boolean, force: boolean) {
		const args = [];
		if (checkout && !force) {
			args.push('checkout', '-b');
		} else {
			args.push('branch');
			if (force) {
				args.push('-f');
			}
		}
		args.push(branchName, commitHash);

		const statuses = [await this.runGitCommand(args, repo)];
		if (statuses[0] === null && checkout && force) {
			statuses.push(await this.checkoutBranch(repo, branchName, null));
		}
		return statuses;
	}

	/**
	 * Delete a branch in a repository.
	 * @param repo The path of the repository.
	 * @param branchName The name of the branch.
	 * @param force Should force the branch to be deleted (even if not merged).
	 * @returns The ErrorInfo from the executed command.
	 */
	public deleteBranch(repo: string, branchName: string, force: boolean) {
		return this.runGitCommand(['branch', force ? '-D' : '-d', branchName], repo);
	}

	/**
	 * Delete a remote branch in a repository.
	 * @param repo The path of the repository.
	 * @param branchName The name of the branch.
	 * @param remote The name of the remote to delete the branch on.
	 * @returns The ErrorInfo from the executed command.
	 */
	public async deleteRemoteBranch(repo: string, branchName: string, remote: string) {
		let remoteStatus = await this.runGitCommand(['push', remote, '--delete', branchName], repo);
		if (remoteStatus !== null && (new RegExp('remote ref does not exist', 'i')).test(remoteStatus)) {
			let trackingBranchStatus = await this.runGitCommand(['branch', '-d', '-r', remote + '/' + branchName], repo);
			return trackingBranchStatus === null ? null : 'Branch does not exist on the remote, deleting the remote tracking branch ' + remote + '/' + branchName + '.\n' + trackingBranchStatus;
		}
		return remoteStatus;
	}

	/**
	 * Fetch a remote branch into a local branch.
	 * @param repo The path of the repository.
	 * @param remote The name of the remote containing the remote branch.
	 * @param remoteBranch The name of the remote branch.
	 * @param localBranch The name of the local branch.
	 * @param force Force fetch the remote branch.
	 * @returns The ErrorInfo from the executed command.
	 */
	public fetchIntoLocalBranch(repo: string, remote: string, remoteBranch: string, localBranch: string, force: boolean) {
		const args = ['fetch'];
		if (force) {
			args.push('-f');
		}
		args.push(remote, remoteBranch + ':' + localBranch);
		return this.runGitCommand(args, repo);
	}

	/**
	 * Pull a remote branch into the current branch.
	 * @param repo The path of the repository.
	 * @param branchName The name of the remote branch.
	 * @param remote The name of the remote containing the remote branch.
	 * @param createNewCommit Is `--no-ff` enabled if a merge is required.
	 * @param squash Is `--squash` enabled if a merge is required.
	 * @returns The ErrorInfo from the executed command.
	 */
	public pullBranch(repo: string, branchName: string, remote: string, createNewCommit: boolean, squash: boolean) {
		const args = ['pull', remote, branchName], config = getConfig();
		if (squash) {
			args.push('--squash');
		} else if (createNewCommit) {
			args.push('--no-ff');
		}
		if (config.signCommits) {
			args.push('-S');
		}
		return this.runGitCommand(args, repo).then((pullStatus) => {
			return pullStatus === null && squash
				? this.commitSquashIfStagedChangesExist(repo, remote + '/' + branchName, MergeActionOn.Branch, config.squashPullMessageFormat, config.signCommits)
				: pullStatus;
		});
	}

	/**
	 * Rename a branch in a repository.
	 * @param repo The path of the repository.
	 * @param oldName The old name of the branch.
	 * @param newName The new name of the branch.
	 * @returns The ErrorInfo from the executed command.
	 */
	public renameBranch(repo: string, oldName: string, newName: string) {
		return this.runGitCommand(['branch', '-m', oldName, newName], repo);
	}


	/* Git Action Methods - Branches & Commits */

	/**
	 * Merge a branch or commit into the current branch.
	 * @param repo The path of the repository.
	 * @param obj The object to be merged into the current branch.
	 * @param actionOn Is the merge on a branch, remote-tracking branch or commit.
	 * @param createNewCommit Is `--no-ff` enabled.
	 * @param squash Is `--squash` enabled.
	 * @param noCommit Is `--no-commit` enabled.
	 * @returns The ErrorInfo from the executed command.
	 */
	public merge(repo: string, obj: string, actionOn: MergeActionOn, createNewCommit: boolean, squash: boolean, noCommit: boolean) {
		const args = ['merge', obj], config = getConfig();
		if (squash) {
			args.push('--squash');
		} else if (createNewCommit) {
			args.push('--no-ff');
		}
		if (noCommit) {
			args.push('--no-commit');
		}
		if (config.signCommits) {
			args.push('-S');
		}
		return this.runGitCommand(args, repo).then((mergeStatus) => {
			return mergeStatus === null && squash && !noCommit
				? this.commitSquashIfStagedChangesExist(repo, obj, actionOn, config.squashMergeMessageFormat, config.signCommits)
				: mergeStatus;
		});
	}

	/**
	 * Rebase the current branch on a branch or commit.
	 * @param repo The path of the repository.
	 * @param obj The object the current branch will be rebased onto.
	 * @param actionOn Is the rebase on a branch or commit.
	 * @param ignoreDate Is `--ignore-date` enabled.
	 * @param interactive Should the rebase be performed interactively.
	 * @returns The ErrorInfo from the executed command.
	 */
	public async rebase(repo: string, obj: string, actionOn: RebaseActionOn, ignoreDate: boolean, interactive: boolean): Promise<ErrorInfo> {
		if (interactive) {
			// The terminal runs the command through a shell, so it is given the commit hash, never a branch name that could contain shell syntax
			let hash: string;
			try {
				hash = await this.spawnGit(['rev-parse', '--verify', obj + '^{commit}'], repo, (stdout) => stdout.trim());
			} catch (errorMessage) {
				return <ErrorInfo>errorMessage;
			}
			if (!/^[0-9a-f]{40,64}$/.test(hash)) {
				return 'Unable to resolve "' + obj + '" to a commit.';
			}
			return this.openGitTerminal(
				repo,
				'rebase --interactive ' + (getConfig().signCommits ? '-S ' : '') + hash,
				'Rebase on "' + (actionOn === RebaseActionOn.Branch ? obj : abbrevCommit(obj)) + '"'
			);
		} else {
			const args = ['rebase', obj];
			if (ignoreDate) {
				args.push('--ignore-date');
			}
			if (getConfig().signCommits) {
				args.push('-S');
			}
			return this.runGitCommand(args, repo);
		}
	}


	/* Git Action Methods - Branches & Tags */

	/**
	 * Create an archive of a repository at a specific reference, and save to disk.
	 * @param repo The path of the repository.
	 * @param ref The reference of the revision to archive.
	 * @param outputFilePath The file path that the archive should be saved to.
	 * @param type The type of archive.
	 * @returns The ErrorInfo from the executed command.
	 */
	public archive(repo: string, ref: string, outputFilePath: string, type: 'tar' | 'zip') {
		return this.runGitCommand(['archive', '--format=' + type, '-o', outputFilePath, ref], repo);
	}


	/* Git Action Methods - Commits */

	/**
	 * Checkout a commit in a repository.
	 * @param repo The path of the repository.
	 * @param commitHash The hash of the commit to check out.
	 * @returns The ErrorInfo from the executed command.
	 */
	public checkoutCommit(repo: string, commitHash: string) {
		return this.runGitCommand(['checkout', commitHash], repo);
	}

	/**
	 * Cherrypick a commit in a repository.
	 * @param repo The path of the repository.
	 * @param commitHash The hash of the commit to be cherry picked.
	 * @param parentIndex The parent index if the commit is a merge.
	 * @param recordOrigin Is `-x` enabled.
	 * @param noCommit Is `--no-commit` enabled.
	 * @returns The ErrorInfo from the executed command.
	 */
	public cherrypickCommit(repo: string, commitHash: string, parentIndex: number, recordOrigin: boolean, noCommit: boolean) {
		const args = ['cherry-pick'];
		if (noCommit) {
			args.push('--no-commit');
		}
		if (recordOrigin) {
			args.push('-x');
		}
		if (getConfig().signCommits) {
			args.push('-S');
		}
		if (parentIndex > 0) {
			args.push('-m', parentIndex.toString());
		}
		args.push(commitHash);
		return this.runGitCommand(args, repo);
	}

	/**
	 * Drop a commit in a repository.
	 * @param repo The path of the repository.
	 * @param commitHash The hash of the commit to drop.
	 * @returns The ErrorInfo from the executed command.
	 */
	public dropCommit(repo: string, commitHash: string) {
		const args = ['rebase'];
		if (getConfig().signCommits) {
			args.push('-S');
		}
		args.push('--onto', commitHash + '^', commitHash);
		return this.runGitCommand(args, repo);
	}

	/**
	 * Reset the current branch to a specified commit.
	 * @param repo The path of the repository.
	 * @param commit The hash of the commit that the current branch should be reset to.
	 * @param resetMode The mode of the reset.
	 * @returns The ErrorInfo from the executed command.
	 */
	public resetToCommit(repo: string, commit: string, resetMode: GitResetMode) {
		return this.runGitCommand(['reset', '--' + resetMode, commit], repo);
	}

	/**
	 * Revert a commit in a repository.
	 * @param repo The path of the repository.
	 * @param commitHash The hash of the commit to revert.
	 * @param parentIndex The parent index if the commit is a merge.
	 * @returns The ErrorInfo from the executed command.
	 */
	public revertCommit(repo: string, commitHash: string, parentIndex: number) {
		const args = ['revert', '--no-edit'];
		if (getConfig().signCommits) {
			args.push('-S');
		}
		if (parentIndex > 0) {
			args.push('-m', parentIndex.toString());
		}
		args.push(commitHash);
		return this.runGitCommand(args, repo);
	}


	/* Git Action Methods - Config */

	/**
	 * Set a configuration value for a repository.
	 * @param repo The path of the repository.
	 * @param key The Git Config Key to be set.
	 * @param value The value to be set.
	 * @param location The location where the configuration value should be set.
	 * @returns The ErrorInfo from the executed command.
	 */
	public setConfigValue(repo: string, key: GitConfigKey, value: string, location: GitConfigLocation) {
		return this.runGitCommand(['config', '--' + location, key, value], repo);
	}

	/**
	 * Unset a configuration value for a repository.
	 * @param repo The path of the repository.
	 * @param key The Git Config Key to be unset.
	 * @param location The location where the configuration value should be unset.
	 * @returns The ErrorInfo from the executed command.
	 */
	public unsetConfigValue(repo: string, key: GitConfigKey, location: GitConfigLocation) {
		return this.runGitCommand(['config', '--' + location, '--unset-all', key], repo);
	}


	/* Git Action Methods - Uncommitted */

	/**
	 * Clean the untracked files in a repository.
	 * @param repo The path of the repository.
	 * @param directories Is `-d` enabled.
	 * @returns The ErrorInfo from the executed command.
	 */
	public cleanUntrackedFiles(repo: string, directories: boolean) {
		return this.runGitCommand(['clean', '-f' + (directories ? 'd' : '')], repo);
	}


	/* Git Action Methods - File */

	/**
	 * Reset a file to the specified revision.
	 * @param repo The path of the repository.
	 * @param commitHash The commit to reset the file to.
	 * @param filePath The file to reset.
	 * @returns The ErrorInfo from the executed command.
	 */
	public resetFileToRevision(repo: string, commitHash: string, filePath: string) {
		return this.runGitCommand(['checkout', commitHash, '--', filePath], repo);
	}


	/* Git Action Methods - Stash */

	/**
	 * Apply a stash in a repository.
	 * @param repo The path of the repository.
	 * @param selector The selector of the stash.
	 * @param reinstateIndex Is `--index` enabled.
	 * @returns The ErrorInfo from the executed command.
	 */
	public applyStash(repo: string, selector: string, reinstateIndex: boolean) {
		let args = ['stash', 'apply'];
		if (reinstateIndex) args.push('--index');
		args.push(selector);

		return this.runGitCommand(args, repo);
	}

	/**
	 * Create a branch from a stash.
	 * @param repo The path of the repository.
	 * @param selector The selector of the stash.
	 * @param branchName The name of the branch to be created.
	 * @returns The ErrorInfo from the executed command.
	 */
	public branchFromStash(repo: string, selector: string, branchName: string) {
		return this.runGitCommand(['stash', 'branch', branchName, selector], repo);
	}

	/**
	 * Drop a stash in a repository.
	 * @param repo The path of the repository.
	 * @param selector The selector of the stash.
	 * @returns The ErrorInfo from the executed command.
	 */
	public dropStash(repo: string, selector: string) {
		return this.runGitCommand(['stash', 'drop', selector], repo);
	}

	/**
	 * Pop a stash in a repository.
	 * @param repo The path of the repository.
	 * @param selector The selector of the stash.
	 * @param reinstateIndex Is `--index` enabled.
	 * @returns The ErrorInfo from the executed command.
	 */
	public popStash(repo: string, selector: string, reinstateIndex: boolean) {
		let args = ['stash', 'pop'];
		if (reinstateIndex) args.push('--index');
		args.push(selector);

		return this.runGitCommand(args, repo);
	}

	/**
	 * Push the uncommitted changes to a stash.
	 * @param repo The path of the repository.
	 * @param message The message of the stash.
	 * @param includeUntracked Is `--include-untracked` enabled.
	 * @returns The ErrorInfo from the executed command.
	 */
	public pushStash(repo: string, message: string, includeUntracked: boolean): Promise<ErrorInfo> {
		let args = ['stash', 'push'];
		if (includeUntracked) args.push('--include-untracked');
		if (message !== '') args.push('--message', message);
		return this.runGitCommand(args, repo);
	}


	/* Git Action Methods - Worktrees */

	/**
	 * Create a worktree, and check out a commit or branch in it.
	 * @param repo The path of the repository.
	 * @param worktreePath An absolute path, or a path relative to the main worktree.
	 * @param commitish The commit or branch to check out in the worktree.
	 * @param newBranch The name of a new branch to create at `commitish` and check out, or NULL to check out `commitish` itself.
	 * @returns The ErrorInfo's from the executed command(s), and the absolute path of the worktree (NULL if it wasn't created).
	 */
	public async createWorktree(repo: string, worktreePath: string, commitish: string, newBranch: string | null): Promise<{ errors: ErrorInfo[], path: string | null }> {
		let mainWorktreePath: string;
		try {
			const mainWorktree = (await this.getWorktrees(repo)).find((worktree) => worktree.isMain);
			mainWorktreePath = typeof mainWorktree !== 'undefined' ? mainWorktree.path : repo;
		} catch (errorMessage) {
			return { errors: [<ErrorInfo>errorMessage], path: null };
		}

		const absolutePath = resolveWorktreePath(worktreePath, mainWorktreePath);
		const args = ['worktree', 'add'];
		if (newBranch !== null) args.push('-b', newBranch);
		args.push(absolutePath, commitish);

		const status = await this.runGitCommand(args, repo);
		if (status !== null) {
			return { errors: [status], path: null };
		}
		return { errors: [null, await this.excludeWorktreeFolder(repo, mainWorktreePath, absolutePath)], path: absolutePath };
	}

	/**
	 * Remove a worktree.
	 * @param repo The path of the repository.
	 * @param worktreePath The path of the worktree.
	 * @param force Remove the worktree even if it has uncommitted changes or untracked files.
	 * @returns The ErrorInfo from the executed command.
	 */
	public removeWorktree(repo: string, worktreePath: string, force: boolean) {
		const args = ['worktree', 'remove'];
		if (force) args.push('--force');
		args.push(worktreePath);
		return this.runGitCommand(args, repo);
	}

	/**
	 * If a new worktree is inside the main worktree, add its top-level folder to `.git/info/exclude`, so the
	 * worktree isn't shown as untracked files of the repository. Folders that are already ignored are left alone.
	 * @param repo The path of the repository.
	 * @param mainWorktreePath The path of the main worktree.
	 * @param worktreePath The absolute path of the new worktree.
	 * @returns The ErrorInfo from updating the exclude file.
	 */
	private async excludeWorktreeFolder(repo: string, mainWorktreePath: string, worktreePath: string): Promise<ErrorInfo> {
		const relativePath = getPathFromStr(path.relative(mainWorktreePath, worktreePath));
		if (relativePath === '' || relativePath.startsWith('../') || path.isAbsolute(relativePath)) return null;

		const folder = relativePath.split('/')[0];
		const isIgnored = await this._spawnGit(['check-ignore', '-q', folder + '/'], mainWorktreePath, () => true).catch(() => false);
		if (isIgnored) return null;

		let excludeFilePath: string;
		try {
			const commonDir = await this.spawnGit(['rev-parse', '--git-common-dir'], repo, (stdout) => stdout.trim());
			excludeFilePath = path.join(path.resolve(repo, commonDir), 'info', 'exclude');
		} catch (errorMessage) {
			return <ErrorInfo>errorMessage;
		}

		return new Promise<ErrorInfo>((resolve) => {
			fs.readFile(excludeFilePath, 'utf8', (readErr, contents) => {
				const existing = readErr === null ? contents : '';
				const prefix = existing === '' || existing.endsWith('\n') ? '' : '\n';
				fs.mkdir(path.dirname(excludeFilePath), () => { // The info folder is normally present, any error is reported by appendFile
					fs.appendFile(excludeFilePath, prefix + '/' + folder + '/\n', (writeErr) => {
						resolve(writeErr === null ? null : 'The worktree was created, but Git Tree was unable to add "/' + folder + '/" to "' + getPathFromStr(excludeFilePath) + '" (' + writeErr.message + ').');
					});
				});
			});
		});
	}


	/* Public Utils */

	/**
	 * Write Git's commit-graph file for a repository that has none. Git walks the history much faster with it, so the graph of a large repository loads several times faster.
	 * Each repository is checked at most once per session.
	 * @param repo The path of the repository.
	 * @returns The ErrorInfo from writing the file. NULL if it was written, or wasn't needed.
	 */
	public async writeCommitGraphIfMissing(repo: string): Promise<ErrorInfo> {
		if (this.commitGraphChecked.has(repo)) return null;
		this.commitGraphChecked.add(repo);

		let graphPaths: string[];
		try {
			graphPaths = await this.spawnGit(['rev-parse', '--git-path', 'objects/info/commit-graph', '--git-path', 'objects/info/commit-graphs/commit-graph-chain'], repo, (stdout) => stdout.split(RECORD_EOL_REGEX).filter((line) => line !== ''));
		} catch (errorMessage) {
			return <ErrorInfo>errorMessage;
		}
		if (graphPaths.length !== 2) {
			return 'Unable to locate the commit-graph of the repository.';
		}

		const exists = await Promise.all(graphPaths.map((graphPath) => new Promise<boolean>((resolve) => fs.stat(path.resolve(repo, graphPath), (err) => resolve(err === null)))));
		return exists.includes(true) ? null : this.runGitCommand(['commit-graph', 'write', '--reachable'], repo);
	}

	/**
	 * Opens an external directory diff for the specified commits.
	 * @param repo The path of the repository.
	 * @param fromHash The commit hash the diff is from.
	 * @param toHash The commit hash the diff is to.
	 * @param isGui Is the external diff tool GUI based.
	 * @returns The ErrorInfo from the executed command.
	 */
	public openExternalDirDiff(repo: string, fromHash: string, toHash: string, isGui: boolean) {
		return new Promise<ErrorInfo>((resolve) => {
			if (this.gitExecutable === null) {
				resolve(this.gitExecutableError);
			} else {
				const args = ['difftool', '--dir-diff'];
				if (isGui) {
					args.push('-g');
				}
				if (fromHash === toHash) {
					if (toHash === UNCOMMITTED) {
						args.push('HEAD');
					} else {
						args.push(toHash + '^..' + toHash);
					}
				} else {
					if (toHash === UNCOMMITTED) {
						args.push(fromHash);
					} else {
						args.push(fromHash + '..' + toHash);
					}
				}
				if (isGui) {
					this.logger.log('External diff tool is being opened (' + args[args.length - 1] + ')');
					this.runGitCommand(args, repo).then((errorInfo) => {
						this.logger.log('External diff tool has exited (' + args[args.length - 1] + ')');
						if (errorInfo !== null) {
							const errorMessage = errorInfo.replace(EOL_REGEX, ' ');
							this.logger.logError(errorMessage);
							showErrorMessage(errorMessage);
						}
					});
				} else {
					openGitTerminal(repo, this.gitExecutable.path, args.join(' '), 'Open External Directory Diff');
				}
				setTimeout(() => resolve(null), 1500);
			}
		});
	}

	/**
	 * Open a new terminal, set up the Git executable, and optionally run a command.
	 * @param repo The path of the repository.
	 * @param command The command to run.
	 * @param name The name for the terminal.
	 * @returns The ErrorInfo from opening the terminal.
	 */
	public openGitTerminal(repo: string, command: string | null, name: string) {
		return new Promise<ErrorInfo>((resolve) => {
			if (this.gitExecutable === null) {
				resolve(this.gitExecutableError);
			} else {
				openGitTerminal(repo, this.gitExecutable.path, command, name);
				setTimeout(() => resolve(null), 1000);
			}
		});
	}


	/* Private Data Providers */

	/**
	 * Get the branches in a repository.
	 * @param repo The path of the repository.
	 * @param showRemoteBranches Are remote branches shown.
	 * @param hideRemotes An array of hidden remotes.
	 * @param engineRead Reads the branch records with the engine (default: the engine's `branches` read).
	 * @returns The branch data.
	 */
	private getBranches(repo: string, showRemoteBranches: boolean, hideRemotes: ReadonlyArray<string>, engineRead: EngineRead<BranchListEntry[]> = (engine) => engine.branches(repo, showRemoteBranches)) {
		let args = ['branch'];
		if (showRemoteBranches) args.push('-a');
		// --no-column keeps one branch per line when the user sets column.ui
		args.push('--no-color', '--no-column');

		const hideRemotePatterns = hideRemotes.map((remote) => 'remotes/' + remote + '/');
		const showRemoteHeads = getConfig().showRemoteHeads;

		return this.readWithEngine('branches', engineRead, () => this.spawnGit(args, repo, (stdout) => {
			let entries: BranchListEntry[] = [];
			let lines = stdout.split(EOL_REGEX);
			for (let i = 0; i < lines.length - 1; i++) {
				entries.push({ name: lines[i].substring(2).split(' -> ')[0], current: lines[i][0] === '*' });
			}
			return entries;
		})).then((entries) => {
			let branchData: GitBranchData = { branches: [], head: null, error: null };
			for (let i = 0; i < entries.length; i++) {
				let name = entries[i].name;
				if (INVALID_BRANCH_REGEXP.test(name) || hideRemotePatterns.some((pattern) => name.startsWith(pattern)) || (!showRemoteHeads && REMOTE_HEAD_BRANCH_REGEXP.test(name))) {
					continue;
				}

				if (entries[i].current) {
					branchData.head = name;
					branchData.branches.unshift(name);
				} else {
					branchData.branches.push(name);
				}
			}
			return branchData;
		});
	}

	/**
	 * Get the base commit details for the Commit Details View.
	 * @param repo The path of the repository.
	 * @param commitHash The hash of the commit open in the Commit Details View.
	 * @returns The base commit details.
	 */
	private getCommitDetailsBase(repo: string, commitHash: string) {
		const args = ['-c', 'log.showSignature=false', 'show', '--quiet', commitHash, '--format=' + this.gitFormatCommitDetails];
		return this.readWithEngine('commit details', (engine) => engine.commitDetails(repo, commitHash, this.engineDetailsFormat), () => this.spawnGit(args, repo, (stdout): CommitDetailsEntry => {
			const commitInfo = stdout.split(GIT_LOG_SEPARATOR);
			return {
				hash: commitInfo[0],
				parents: commitInfo[1] !== '' ? commitInfo[1].split(' ') : [],
				author: commitInfo[2],
				authorEmail: commitInfo[3],
				authorDate: parseInt(commitInfo[4]),
				committer: commitInfo[5],
				committerEmail: commitInfo[6],
				committerDate: parseInt(commitInfo[7]),
				signatureStatus: commitInfo[8],
				signer: commitInfo[9],
				key: commitInfo[10],
				body: commitInfo.slice(11).join(GIT_LOG_SEPARATOR)
			};
		})).then((entry): DeepWriteable<GitCommitDetails> => ({
			hash: entry.hash,
			parents: entry.parents,
			author: entry.author,
			authorEmail: entry.authorEmail,
			authorDate: entry.authorDate,
			committer: entry.committer,
			committerEmail: entry.committerEmail,
			committerDate: entry.committerDate,
			signature: ['G', 'U', 'X', 'Y', 'R', 'E', 'B'].includes(entry.signatureStatus)
				? {
					key: entry.key.trim(),
					signer: entry.signer.trim(),
					status: <GitSignatureStatus>entry.signatureStatus
				}
				: null,
			body: removeTrailingBlankLines(entry.body.split(EOL_REGEX)).join('\n'),
			fileChanges: []
		}));
	}

	/**
	 * Get the configuration list of a repository.
	 * @param repo The path of the repository.
	 * @param location The location of the configuration to be listed.
	 * @returns A set of key-value pairs of Git configuration records.
	 */
	private getConfigList(repo: string, location?: GitConfigLocation): Promise<GitConfigSet> {
		const args = ['--no-pager', 'config', '--list', '-z', '--includes'];
		if (location) {
			args.push('--' + location);
		}

		// The records Git prints between NULs: a key, then a newline and its value
		const gitRead = () => this.spawnGit(args, repo, (stdout) => {
			const records = stdout.split('\0');
			records.pop();
			return records;
		}).catch((errorMessage): string[] => {
			if (typeof errorMessage === 'string') {
				const message = errorMessage.toLowerCase();
				if (message.startsWith('fatal: unable to read config file') && message.endsWith('no such file or directory')) {
					// If the Git command failed due to the configuration file not existing, return an empty list instead of throwing the exception
					return [];
				}
			} else {
				errorMessage = 'An unexpected error occurred while spawning the Git child process.';
			}
			throw errorMessage;
		});

		// The engine reads all the files, the local file or the global file
		const engineLocation = location === undefined ? null : location === GitConfigLocation.Local ? 'local' : location === GitConfigLocation.Global ? 'global' : undefined;
		const read = engineLocation !== undefined ? this.readWithEngine('config', (engine) => engine.config(repo, engineLocation), gitRead) : gitRead();
		return read.then((records) => {
			const configs: GitConfigSet = {};
			let comps, key;
			for (let i = 0; i < records.length; i++) {
				comps = records[i].split(EOL_REGEX);
				key = comps.shift()!;
				configs[key] = comps.join('\n');
			}
			return configs;
		});
	}

	/**
	 * Get the `--name-status` and `--numstat` records of the diff between two revisions.
	 * @param repo The path of the repository.
	 * @param fromHash The revision the diff is from.
	 * @param toHash The revision the diff is to, or `''` for the working tree.
	 * @returns The `--name-status` and `--numstat` records of the added, modified, deleted and renamed files.
	 */
	private getDiff(repo: string, fromHash: string, toHash: string) {
		const gitRead = () => Promise.all([
			this.execDiff(repo, fromHash, toHash, '--name-status', 'AMDR'),
			this.execDiff(repo, fromHash, toHash, '--numstat', 'AMDR')
		]).then((results): DiffOutput => ({ nameStatus: results[0], numStat: results[1] }));

		// The engine reads diffs between commits, and Git reads diffs with the working tree
		const read = toHash !== '' ? this.readWithEngine('diff', (engine) => engine.diff(repo, fromHash, toHash), gitRead) : gitRead();
		return read.then((output) => ({ nameStatus: parseDiffNameStatus(output.nameStatus), numStat: parseDiffNumStat(output.numStat) }));
	}

	/**
	 * Get the diff `--name-status` records.
	 * @param repo The path of the repository.
	 * @param fromHash The revision the diff is from.
	 * @param toHash The revision the diff is to.
	 * @param filter The types of file changes to retrieve.
	 * @returns An array of `--name-status` records.
	 */
	private getDiffNameStatus(repo: string, fromHash: string, toHash: string, filter: string) {
		return this.execDiff(repo, fromHash, toHash, '--name-status', filter).then(parseDiffNameStatus);
	}

	/**
	 * Get the `git log` read of a page of commits, as the Git CLI's arguments and as the engine's request.
	 * @param branches The list of branch heads to display, or NULL (show all).
	 * @param num The maximum number of commits to return.
	 * @param includeTags Include commits only referenced by tags.
	 * @param includeRemotes Include remote branches.
	 * @param includeCommitsMentionedByReflogs Include commits mentioned by reflogs.
	 * @param onlyFollowFirstParent Only follow the first parent of commits.
	 * @param order The order for commits to be returned.
	 * @param remotes An array of the known remotes.
	 * @param hideRemotes An array of hidden remotes.
	 * @param stashes An array of all stashes in the repository.
	 * @param hostNames The names of the repository's remote hosts, whose refs are start points when all branches are shown.
	 * @returns The read.
	 */
	private getLogRead(branches: ReadonlyArray<string> | null, num: number, includeTags: boolean, includeRemotes: boolean, includeCommitsMentionedByReflogs: boolean, onlyFollowFirstParent: boolean, order: CommitOrdering, remotes: ReadonlyArray<string>, hideRemotes: ReadonlyArray<string>, stashes: ReadonlyArray<GitStash>, hostNames: ReadonlyArray<string> = []): LogRead {
		// The revisions the log starts from, which the Git CLI and the engine both read
		const revisions: string[] = [];
		if (branches !== null) {
			for (let i = 0; i < branches.length; i++) {
				revisions.push(branches[i]);
			}
		} else {
			// Show All
			revisions.push('--branches');
			if (includeTags) revisions.push('--tags');
			if (includeCommitsMentionedByReflogs) revisions.push('--reflog');
			if (includeRemotes) {
				if (hideRemotes.length === 0) {
					revisions.push('--remotes');
				} else {
					remotes.filter((remote) => !hideRemotes.includes(remote)).forEach((remote) => {
						revisions.push('--glob=refs/remotes/' + remote);
					});
				}
			}
			// Every ref of each remote host: its branches, and the commits of its detached worktrees. The glob has no glob
			// characters, so Git and the engine both read it as every ref under refs/git-tree/hosts/<name>/.
			hostNames.forEach((name) => revisions.push('--glob=' + HOST_REFS_PREFIX + name));

			// Add the unique list of base hashes of stashes, so that commits only referenced by stashes are displayed
			const stashBaseHashes = stashes.map((stash) => stash.baseHash);
			stashBaseHashes.filter((hash, index) => stashBaseHashes.indexOf(hash) === index).forEach((hash) => revisions.push(hash));

			revisions.push('HEAD');
		}

		const args = ['-c', 'log.showSignature=false', 'log', '--max-count=' + num, '--format=' + this.gitFormatLog, '--' + order + '-order'];
		if (onlyFollowFirstParent) {
			args.push('--first-parent');
		}
		args.push(...revisions, '--');

		return { args: args, request: { revisions: revisions, maxCount: num, order: order, firstParent: onlyFollowFirstParent, format: this.engineFormat } };
	}

	/**
	 * Get the raw commits in a repository.
	 * @param repo The path of the repository.
	 * @param read The read, from `getLogRead`.
	 * @param engineRead Reads the log records with the engine.
	 * @returns An array of commits.
	 */
	private getLog(repo: string, read: LogRead, engineRead: EngineRead<LogEntry[]>) {
		return this.readWithEngine('log', engineRead, () => this.spawnGit(read.args, repo, (stdout) => {
			let lines = stdout.split(RECORD_EOL_REGEX);
			let commits: LogEntry[] = [];
			for (let i = 0; i < lines.length - 1; i++) {
				let line = lines[i].split(GIT_LOG_SEPARATOR);
				if (line.length !== 6) break;
				commits.push({ hash: line[0], parents: line[1] !== '' ? line[1].split(' ') : [], author: line[2], email: line[3], date: parseInt(line[4]), message: line[5] });
			}
			return commits;
		})).then((commits): GitCommitRecord[] => commits);
	}

	/**
	 * Get the references in a repository.
	 * @param repo The path of the repository.
	 * @param showRemoteBranches Are remote branches shown.
	 * @param showRemoteHeads Are remote heads shown.
	 * @param hideRemotes An array of hidden remotes.
	 * @param engineRead Reads the ref records with the engine.
	 * @param hostNames The names of the repository's remote hosts, whose branches are read too.
	 * @returns The references data.
	 */
	private getRefs(repo: string, showRemoteBranches: boolean, showRemoteHeads: boolean, hideRemotes: ReadonlyArray<string>, engineRead: EngineRead<ShowRefEntry[]>, hostNames: ReadonlyArray<string> = []) {
		let args = ['show-ref'];
		// --heads and --tags would leave out the hosts' refs, so with hosts, every ref is listed and the remotes' are left out below
		if (!showRemoteBranches && hostNames.length === 0) args.push('--heads', '--tags');
		args.push('-d', '--head');

		const hideRemotePatterns = hideRemotes.map((remote) => 'refs/remotes/' + remote + '/');
		const hostBranchesPrefixes = hostNames.map((name) => ({ name: name, prefix: getHostBranchesPrefix(name) }));

		return this.readWithEngine('refs', engineRead, () => this.spawnGit(args, repo, (stdout) => {
			let entries: ShowRefEntry[] = [];
			let lines = stdout.split(EOL_REGEX);
			for (let i = 0; i < lines.length - 1; i++) {
				let line = lines[i].split(' ');
				if (line.length < 2) continue;

				let hash = line.shift()!;
				entries.push({ hash: hash, ref: line.join(' ') });
			}
			return entries;
		})).then((entries) => {
			let refData: GitRefData = { head: null, heads: [], tags: [], remotes: [], hostBranches: [] };
			for (let i = 0; i < entries.length; i++) {
				let hash = entries[i].hash, ref = entries[i].ref;

				if (ref.startsWith('refs/heads/')) {
					refData.heads.push({ hash: hash, name: ref.substring(11) });
				} else if (ref.startsWith('refs/tags/')) {
					let annotated = ref.endsWith('^{}');
					refData.tags.push({ hash: hash, name: (annotated ? ref.substring(10, ref.length - 3) : ref.substring(10)), annotated: annotated });
				} else if (ref.startsWith('refs/remotes/')) {
					if (showRemoteBranches && !hideRemotePatterns.some((pattern) => ref.startsWith(pattern)) && (showRemoteHeads || !ref.endsWith('/HEAD'))) {
						refData.remotes.push({ hash: hash, name: ref.substring(13) });
					}
				} else if (ref.startsWith(HOST_REFS_PREFIX)) {
					// Only a configured host's branches are labels. Its other refs (the commits of its detached worktrees) are only start points.
					const host = hostBranchesPrefixes.find((host) => ref.startsWith(host.prefix));
					if (typeof host !== 'undefined') {
						// A branch that points to a tag is listed twice, the second time peeled (^{}), and only that one names a commit
						const name = ref.substring(host.prefix.length, ref.endsWith('^{}') ? ref.length - 3 : ref.length);
						refData.hostBranches.push({ hash: hash, host: host.name, name: name });
					}
				} else if (ref === 'HEAD') {
					refData.head = hash;
				}
			}
			return refData;
		});
	}

	/**
	 * Get all of the remotes that contain the specified commit hash.
	 * @param repo The path of the repository.
	 * @param commitHash The commit hash to test.
	 * @param knownRemotes The list of known remotes to check for.
	 * @returns A promise resolving to a list of remote names.
	 */
	private getRemotesContainingCommit(repo: string, commitHash: string, knownRemotes: string[]) {
		return this.spawnGit(['branch', '-r', '--no-color', '--no-column', '--contains=' + commitHash], repo, (stdout) => {
			// Get the names of all known remote branches that contain commitHash
			const branchNames = stdout.split(EOL_REGEX)
				.filter((line) => line.length > 2)
				.map((line) => line.substring(2).split(' -> ')[0])
				.filter((branchName) => !INVALID_BRANCH_REGEXP.test(branchName));

			// Get all the remotes that are the prefix of at least one remote branch name
			return knownRemotes.filter((knownRemote) => {
				const knownRemotePrefix = knownRemote + '/';
				return branchNames.some((branchName) => branchName.startsWith(knownRemotePrefix));
			});
		});
	}

	/**
	 * Get the stashes in a repository.
	 * @param repo The path of the repository.
	 * @param engineRead Reads the stash records with the engine (default: the engine's `stashes` read).
	 * @returns An array of stashes.
	 */
	private getStashes(repo: string, engineRead: EngineRead<StashListEntry[]> = (engine) => engine.stashes(repo, this.engineFormat)) {
		return this.readWithEngine('stashes', engineRead, () => this.spawnGit(['reflog', '--format=' + this.gitFormatStash, 'refs/stash', '--'], repo, (stdout) => {
			let lines = stdout.split(RECORD_EOL_REGEX);
			let entries: StashListEntry[] = [];
			for (let i = 0; i < lines.length - 1; i++) {
				let line = lines[i].split(GIT_LOG_SEPARATOR);
				if (line.length !== 7) continue;
				entries.push({ hash: line[0], parents: line[1] !== '' ? line[1].split(' ') : [], selector: line[2], author: line[3], email: line[4], date: parseInt(line[5]), message: line[6] });
			}
			return entries;
		})).then((entries) => {
			let stashes: GitStash[] = [];
			for (let i = 0; i < entries.length; i++) {
				let parentHashes = entries[i].parents;
				if (parentHashes.length === 0) continue;
				stashes.push({
					hash: entries[i].hash,
					baseHash: parentHashes[0],
					untrackedFilesHash: parentHashes.length === 3 ? parentHashes[2] : null,
					selector: entries[i].selector,
					author: entries[i].author,
					email: entries[i].email,
					date: entries[i].date,
					message: entries[i].message
				});
			}
			return stashes;
		}).catch(() => <GitStash[]>[]);
	}

	/**
	 * Get the names of the remotes of a repository.
	 * @param repo The path of the repository.
	 * @param engineRead Reads the remote names with the engine (default: the engine's `remotes` read).
	 * @returns An array of remote names.
	 */
	private getRemotes(repo: string, engineRead: EngineRead<string[]> = (engine) => engine.remotes(repo)) {
		return this.readWithEngine('remotes', engineRead, () => this.spawnGit(['remote'], repo, (stdout) => {
			let lines = stdout.split(EOL_REGEX);
			lines.pop();
			return lines;
		}));
	}

	/**
	 * Get the remote hosts of a repository, as they are now. It never waits for the network.
	 * @param repo The path of the repository (any of its worktrees).
	 * @returns The snapshot of each host, in the config's order. Empty without RemoteHosts.
	 */
	private getRemoteHosts(repo: string): ReadonlyArray<RemoteHostSnapshot> {
		return this.remoteHosts !== null ? this.remoteHosts.getHosts(repo) : [];
	}

	/**
	 * Get the signature of a signed tag.
	 * @param repo The path of the repository.
	 * @param ref The reference identifying the tag.
	 * @returns A Promise resolving to the signature.
	 */
	private getTagSignature(repo: string, ref: string): Promise<GitSignature> {
		return this._spawnGit(['verify-tag', '--raw', ref], repo, (stdout, stderr) => stderr || stdout.toString(), true).then((output) => {
			const records = output.split(EOL_REGEX)
				.filter((line) => line.startsWith('[GNUPG:] '))
				.map((line) => line.split(' '));

			let signature: Writeable<GitSignature> | null = null, trustLevel: string | null = null, parsingDetails: GpgStatusCodeParsingDetails | undefined;
			for (let i = 0; i < records.length; i++) {
				parsingDetails = GPG_STATUS_CODE_PARSING_DETAILS[records[i][1]];
				if (parsingDetails) {
					if (signature !== null) {
						throw new Error('Multiple Signatures Exist: As Git currently doesn\'t support them, nor does Git Tree (for consistency).');
					} else {
						signature = {
							status: parsingDetails.status,
							key: records[i][2],
							signer: parsingDetails.uid ? records[i].slice(3).join(' ') : '' // When parsingDetails.uid === TRUE, the signer is the rest of the record (so join the remaining arguments)
						};
					}
				} else if (records[i][1].startsWith('TRUST_')) {
					trustLevel = records[i][1];
				}
			}

			if (signature !== null && signature.status === GitSignatureStatus.GoodAndValid && (trustLevel === 'TRUST_UNDEFINED' || trustLevel === 'TRUST_NEVER')) {
				signature.status = GitSignatureStatus.GoodWithUnknownValidity;
			}

			if (signature !== null) {
				return signature;
			} else {
				throw new Error('No Signature could be parsed.');
			}
		}).catch(() => ({
			status: GitSignatureStatus.CannotBeChecked,
			key: '',
			signer: ''
		}));
	}

	/**
	 * Get the number of uncommitted changes in a repository.
	 * @param repo The path of the repository.
	 * @returns The number of uncommitted changes.
	 */
	private getUncommittedChanges(repo: string) {
		return this.spawnGit(['status', '--untracked-files=' + (getConfig().showUntrackedFiles ? 'all' : 'no'), '--porcelain'], repo, (stdout) => {
			const numLines = stdout.split(EOL_REGEX).length;
			return numLines > 1 ? numLines - 1 : 0;
		});
	}

	/**
	 * Get the worktrees of a repository.
	 * @param repo The path of the repository.
	 * @param engineRead Reads the worktree records with the engine (default: the engine's `worktrees` read).
	 * @returns An array of the worktrees, with the main worktree first.
	 */
	private getWorktrees(repo: string, engineRead: EngineRead<WorktreeListEntry[]> = (engine) => engine.worktrees(repo)): Promise<GitWorktree[]> {
		return Promise.all([
			this.readWithEngine('worktrees', engineRead, () => this.spawnGit(['worktree', 'list', '--porcelain'], repo, parseWorktreeList)),
			realpath(repo)
		]).then((results) => getWorktreesFromList(results[0], [repo, results[1]]));
	}

	/**
	 * Get the untracked and deleted files that are not staged or committed.
	 * @param repo The path of the repository.
	 * @returns The untracked and deleted files.
	 */
	private getStatus(repo: string) {
		return this.spawnGit(['status', '-s', '--untracked-files=' + (getConfig().showUntrackedFiles ? 'all' : 'no'), '--porcelain', '-z'], repo, (stdout) => {
			let output = stdout.split('\0'), i = 0;
			let status: GitStatusFiles = { deleted: [], untracked: [] };
			let path = '', c1 = '', c2 = '';
			while (i < output.length && output[i] !== '') {
				if (output[i].length < 4) break;
				path = output[i].substring(3);
				c1 = output[i].substring(0, 1);
				c2 = output[i].substring(1, 2);
				if (c1 === 'D' || c2 === 'D') status.deleted.push(path);
				else if (c1 === '?' || c2 === '?') status.untracked.push(path);

				if (c1 === 'R' || c2 === 'R' || c1 === 'C' || c2 === 'C') {
					// Renames or copies
					i += 2;
				} else {
					i += 1;
				}
			}
			return status;
		});
	}


	/* Private Utils */

	/**
	 * Check if there are staged changes that resulted from a squash merge, and if so, commit them.
	 * @param repo The path of the repository.
	 * @param obj The object being squash merged into the current branch.
	 * @param actionOn Is the merge on a branch, remote-tracking branch or commit.
	 * @param squashMessageFormat The format to be used in the commit message of the squash.
	 * @returns The ErrorInfo from the executed command.
	 */
	private commitSquashIfStagedChangesExist(repo: string, obj: string, actionOn: MergeActionOn, squashMessageFormat: SquashMessageFormat, signCommits: boolean): Promise<ErrorInfo> {
		return this.areStagedChanges(repo).then((changes) => {
			if (changes) {
				const args = ['commit'];
				if (signCommits) {
					args.push('-S');
				}
				if (squashMessageFormat === SquashMessageFormat.Default) {
					args.push('-m', 'Merge ' + actionOn.toLowerCase() + ' \'' + obj + '\'');
				} else {
					args.push('--no-edit');
				}
				return this.runGitCommand(args, repo);
			} else {
				return null;
			}
		});
	}

	/**
	 * Get the diff between two revisions.
	 * @param repo The path of the repository.
	 * @param fromHash The revision the diff is from.
	 * @param toHash The revision the diff is to.
	 * @param arg Sets the data reported from the diff.
	 * @param filter The types of file changes to retrieve.
	 * @returns The diff output.
	 */
	private execDiff(repo: string, fromHash: string, toHash: string, arg: '--numstat' | '--name-status', filter: string) {
		let args: string[];
		if (fromHash === toHash) {
			args = ['diff-tree', arg, '-r', '--root', '--find-renames', '--diff-filter=' + filter, '-z', fromHash];
		} else {
			args = ['diff', arg, '--find-renames', '--diff-filter=' + filter, '-z', fromHash];
			if (toHash !== '') args.push(toHash);
		}

		return this.spawnGit(args, repo, (stdout) => {
			let lines = stdout.split('\0');
			if (fromHash === toHash) lines.shift();
			return lines;
		});
	}

	/**
	 * Read the refs and a log page with the engine, in one crossing. The engine is given the token of its last answer to the
	 * same read, and when it answers that the token still describes the refs and the log, the records of that answer are used again.
	 * @param engine The engine.
	 * @param repo The path of the repository.
	 * @param includeRemotes Include the remote-tracking refs.
	 * @param request The log request.
	 * @returns The answer of each part.
	 */
	private readCommitsWithEngine(engine: Engine, repo: string, includeRemotes: boolean, request: EngineLogRequest): Promise<EngineAnswer<CommitsParts>> {
		const key = JSON.stringify([repo, includeRemotes, request]), cached = this.commitsCache.get(key);
		return engine.commits(repo, includeRemotes, request, cached !== undefined ? cached.token : null).then((answer): EngineAnswer<CommitsParts> => {
			// The entry is set again below when it is still right, which also makes it the most recently used
			this.commitsCache.delete(key);
			if (!('ok' in answer)) return answer;

			const commits = answer.ok;
			if ('unchanged' in commits) {
				if (cached === undefined || commits.token !== cached.token) {
					// The engine didn't say which records are unchanged, so neither part is known
					return { failed: 'the engine answered unchanged to a token it wasn\'t given' };
				}
				this.commitsCache.set(key, cached);
				return { ok: { refs: { ok: cached.refs.slice() }, log: { ok: cached.log.slice() } } };
			}

			if (commits.token !== null && 'ok' in commits.refs && 'ok' in commits.log) {
				// getCommits changes the arrays it is given, so the cache keeps its own
				this.commitsCache.set(key, { token: commits.token, refs: commits.refs.ok.slice(), log: commits.log.ok.slice() });
				if (this.commitsCache.size > COMMITS_CACHE_SIZE) {
					const oldest = this.commitsCache.keys().next();
					if (!oldest.done) this.commitsCache.delete(oldest.value);
				}
			}
			return { ok: { refs: commits.refs, log: commits.log } };
		});
	}

	/**
	 * Run a read with the engine, or with the Git CLI when there's no engine, or when the engine can't answer with certainty.
	 * The two reads return the same records, which the caller then interprets.
	 * @param name The name of the read, for the log.
	 * @param engineRead Runs the read with the engine.
	 * @param gitRead Runs the read with the Git CLI.
	 * @returns The records.
	 */
	private readWithEngine<T>(name: string, engineRead: (engine: Engine) => Promise<EngineAnswer<T>>, gitRead: () => Promise<T>): Promise<T> {
		const engine = this.engine;
		if (this.gitExecutable === null) {
			// The engine reads only for a Git that Git Tree can run, so it never answers where Git can't
			return Promise.reject(this.gitExecutableError);
		} else if (engine === null) {
			return gitRead();
		}

		this.logger.log('> engine ' + name);
		return engineRead(engine).then((answer) => {
			if ('ok' in answer) {
				return answer.ok;
			} else if ('unsupported' in answer) {
				this.logger.log('The engine can\'t read ' + name + ' with certainty (' + answer.unsupported + '), so Git reads it.');
			} else {
				this.logger.logError('The engine failed to read ' + name + ' (' + answer.failed + '), so Git reads it.');
			}
			return gitRead();
		}, (error) => {
			this.logger.logError('The engine failed to read ' + name + ' (' + (error instanceof Error ? error.message : String(error)) + '), so Git reads it.');
			return gitRead();
		});
	}

	/**
	 * Run a Git command (typically for a Git Tree View action).
	 * @param args The arguments to pass to Git.
	 * @param repo The repository to run the command in.
	 * @returns The returned ErrorInfo (suitable for being sent to the Git Tree View).
	 */
	private runGitCommand(args: string[], repo: string): Promise<ErrorInfo> {
		return this._spawnGit(args, repo, () => null).catch((errorMessage: string) => errorMessage);
	}

	/**
	 * Spawn Git, with the return value resolved from `stdout` as a string.
	 * @param args The arguments to pass to Git.
	 * @param repo The repository to run the command in.
	 * @param resolveValue A callback invoked to resolve the data from `stdout`.
	 */
	private spawnGit<T>(args: string[], repo: string, resolveValue: { (stdout: string): T }) {
		return this._spawnGit(args, repo, (stdout) => resolveValue(stdout.toString()));
	}

	/**
	 * Spawn Git, with the return value resolved from `stdout` as a buffer.
	 * @param args The arguments to pass to Git.
	 * @param repo The repository to run the command in.
	 * @param resolveValue A callback invoked to resolve the data from `stdout` and `stderr`.
	 * @param ignoreExitCode Ignore the exit code returned by Git (default: `FALSE`).
	 */
	private _spawnGit<T>(args: string[], repo: string, resolveValue: { (stdout: Buffer, stderr: string): T }, ignoreExitCode: boolean = false) {
		return new Promise<T>((resolve, reject) => {
			if (this.gitExecutable === null) {
				return reject(this.gitExecutableError);
			}

			resolveSpawnOutput(cp.spawn(this.gitExecutable.path, args, {
				cwd: repo,
				env: Object.assign({}, process.env, this.askpassEnv)
			})).then((values) => {
				const status = values[0], stdout = values[1], stderr = values[2];
				if (status.code === 0 || ignoreExitCode) {
					resolve(resolveValue(stdout, stderr));
				} else {
					reject(getErrorMessage(status.error, stdout, stderr));
				}
			});

			this.logger.logCmd('git', args);
		});
	}
}


/**
 * Generates the file changes from the diff output and status information.
 * @param nameStatusRecords The `--name-status` records.
 * @param numStatRecords The `--numstat` records.
 * @param status The deleted and untracked files.
 * @returns An array of file changes.
 */
function generateFileChanges(nameStatusRecords: DiffNameStatusRecord[], numStatRecords: DiffNumStatRecord[], status: GitStatusFiles | null) {
	let fileChanges: Writeable<GitFileChange>[] = [], fileLookup: { [file: string]: number } = {}, i = 0;

	for (i = 0; i < nameStatusRecords.length; i++) {
		fileLookup[nameStatusRecords[i].newFilePath] = fileChanges.length;
		fileChanges.push({ oldFilePath: nameStatusRecords[i].oldFilePath, newFilePath: nameStatusRecords[i].newFilePath, type: nameStatusRecords[i].type, additions: null, deletions: null });
	}

	if (status !== null) {
		let filePath;
		for (i = 0; i < status.deleted.length; i++) {
			filePath = getPathFromStr(status.deleted[i]);
			if (typeof fileLookup[filePath] === 'number') {
				fileChanges[fileLookup[filePath]].type = GitFileStatus.Deleted;
			} else {
				fileChanges.push({ oldFilePath: filePath, newFilePath: filePath, type: GitFileStatus.Deleted, additions: null, deletions: null });
			}
		}
		for (i = 0; i < status.untracked.length; i++) {
			filePath = getPathFromStr(status.untracked[i]);
			fileChanges.push({ oldFilePath: filePath, newFilePath: filePath, type: GitFileStatus.Untracked, additions: null, deletions: null });
		}
	}

	for (i = 0; i < numStatRecords.length; i++) {
		if (typeof fileLookup[numStatRecords[i].filePath] === 'number') {
			fileChanges[fileLookup[numStatRecords[i].filePath]].additions = numStatRecords[i].additions;
			fileChanges[fileLookup[numStatRecords[i].filePath]].deletions = numStatRecords[i].deletions;
		}
	}

	return fileChanges;
}

/**
 * Resolve the path of a new worktree. `{repo}` becomes the folder name of the main worktree, a leading `~` becomes the
 * home directory, and a relative path is taken from the main worktree.
 * @param worktreePath The path entered for the new worktree.
 * @param mainWorktreePath The path of the main worktree.
 * @returns The absolute path of the new worktree.
 */
export function resolveWorktreePath(worktreePath: string, mainWorktreePath: string) {
	let resolved = worktreePath.trim().replace(/\{repo\}/g, path.basename(mainWorktreePath));
	if (resolved === '~' || resolved.startsWith('~/') || resolved.startsWith('~\\')) {
		resolved = path.join(os.homedir(), resolved.substring(1));
	}
	return getPathFromStr(path.resolve(mainWorktreePath, resolved));
}

/**
 * Get the worktrees from the records of `git worktree list --porcelain`.
 * @param entries The records, with the main worktree first.
 * @param viewedRepoPaths The paths of the repository being viewed, used to mark its worktree as the current worktree.
 * @returns An array of the worktrees, with the main worktree first. A bare main repository has no worktree, so it is left out.
 */
function getWorktreesFromList(entries: ReadonlyArray<WorktreeListEntry>, viewedRepoPaths: ReadonlyArray<string>) {
	const worktrees: GitWorktree[] = [];
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.path === null || entry.bare) continue;

		const worktreePath = getPathFromUri(vscode.Uri.file(path.normalize(entry.path)));
		worktrees.push({
			path: worktreePath,
			name: path.basename(worktreePath),
			head: entry.head === null || /^0+$/.test(entry.head) ? null : entry.head,
			branch: entry.branch === null ? null : entry.branch.replace(/^refs\/heads\//, ''),
			isMain: i === 0,
			isCurrent: viewedRepoPaths.includes(worktreePath),
			locked: entry.locked,
			prunable: entry.prunable
		});
	}
	return worktrees;
}

/**
 * Get the worktrees of the remote hosts, from each host's last refresh.
 * @param hosts The snapshot of each host.
 * @returns The worktrees, host by host. Each is marked with its host and whether its commit is here, and is never the worktree being viewed.
 */
function getRemoteHostWorktrees(hosts: ReadonlyArray<RemoteHostSnapshot>) {
	const worktrees: GitWorktree[] = [];
	hosts.forEach((snapshot) => {
		snapshot.worktrees.forEach((remoteWorktree) => {
			// The host's name is set here too, so a worktree on a server can never be taken for one on this machine
			worktrees.push(Object.assign({}, remoteWorktree.worktree, { isCurrent: false, host: snapshot.host.name, hostCommitIsLocal: remoteWorktree.commitIsLocal }));
		});
	});
	return worktrees;
}

/**
 * Find a remote host's worktree in the hosts' snapshots.
 * @param hosts The snapshot of each host.
 * @param worktree The worktree (with its `host`).
 * @returns The worktree from the host's last refresh, or NULL if the host or the worktree isn't in it.
 */
function findRemoteWorktree(hosts: ReadonlyArray<RemoteHostSnapshot>, worktree: GitWorktree) {
	const snapshot = hosts.find((snapshot) => snapshot.host.name === worktree.host);
	if (typeof snapshot === 'undefined') return null;
	return snapshot.worktrees.find((remoteWorktree) => remoteWorktree.worktree.path === worktree.path) || null;
}

/**
 * Get the specified config value from a set of key-value config pairs.
 * @param configs A set key-value pairs of Git configuration records.
 * @param key The key of the desired config.
 * @returns The value for `key` if it exists, otherwise NULL.
 */
function getConfigValue(configs: GitConfigSet, key: string) {
	return typeof configs[key] !== 'undefined' ? configs[key] : null;
}

/**
 * Produce a suitable error message from a spawned Git command that terminated with an erroneous status code.
 * @param error An error generated by JavaScript (optional).
 * @param stdoutBuffer A buffer containing the data outputted to `stdout`.
 * @param stderr A string containing the data outputted to `stderr`.
 * @returns A suitable error message.
 */
function getErrorMessage(error: Error | null, stdoutBuffer: Buffer, stderr: string) {
	let stdout = stdoutBuffer.toString(), lines: string[];
	if (stdout !== '' || stderr !== '') {
		lines = (stderr + stdout).split(EOL_REGEX);
		lines.pop();
	} else if (error) {
		lines = error.message.split(EOL_REGEX);
	} else {
		lines = [];
	}
	return lines.join('\n');
}

/**
 * Parse the `--name-status` output of a diff.
 * @param output The output, split at each NUL.
 * @returns An array of `--name-status` records.
 */
function parseDiffNameStatus(output: string[]) {
	let records: DiffNameStatusRecord[] = [], i = 0;
	while (i < output.length && output[i] !== '') {
		let type = <GitFileStatus>output[i][0];
		if (type === GitFileStatus.Added || type === GitFileStatus.Deleted || type === GitFileStatus.Modified) {
			// Add, Modify, or Delete
			let p = getPathFromStr(output[i + 1]);
			records.push({ type: type, oldFilePath: p, newFilePath: p });
			i += 2;
		} else if (type === GitFileStatus.Renamed) {
			// Rename
			records.push({ type: type, oldFilePath: getPathFromStr(output[i + 1]), newFilePath: getPathFromStr(output[i + 2]) });
			i += 3;
		} else {
			break;
		}
	}
	return records;
}

/**
 * Parse the `--numstat` output of a diff.
 * @param output The output, split at each NUL.
 * @returns An array of `--numstat` records.
 */
function parseDiffNumStat(output: string[]) {
	let records: DiffNumStatRecord[] = [], i = 0;
	while (i < output.length && output[i] !== '') {
		let fields = output[i].split('\t');
		if (fields.length !== 3) break;
		if (fields[2] !== '') {
			// Add, Modify, or Delete
			records.push({ filePath: getPathFromStr(fields[2]), additions: parseInt(fields[0]), deletions: parseInt(fields[1]) });
			i += 1;
		} else {
			// Rename
			records.push({ filePath: getPathFromStr(output[i + 2]), additions: parseInt(fields[0]), deletions: parseInt(fields[1]) });
			i += 3;
		}
	}
	return records;
}

/**
 * Remove trailing blank lines from an array of lines.
 * @param lines The array of lines.
 * @returns The same array.
 */
function removeTrailingBlankLines(lines: string[]) {
	while (lines.length > 0 && lines[lines.length - 1] === '') {
		lines.pop();
	}
	return lines;
}

/**
 * Share one engine crossing between the reads of its parts, so that each part keeps its own Git CLI fallback. The crossing
 * starts when the first part's read runs. When the crossing doesn't answer `ok`, each part gets that answer.
 * @param read Runs the crossing.
 * @returns A function that makes the engine read of a part, given how to pick the part from the crossing's records.
 */
function shareEngineRead<A>(read: EngineRead<A>) {
	let answer: Promise<EngineAnswer<A>> | null = null;
	return <T>(pick: (records: A) => EngineAnswer<T>): EngineRead<T> => (engine) => {
		if (answer === null) answer = read(engine);
		return answer.then((answer) => 'ok' in answer ? pick(answer.ok) : answer);
	};
}

/**
 * Get all the unique strings from an array of strings.
 * @param items The array of strings with duplicates.
 * @returns An array of unique strings.
 */
function unique(items: ReadonlyArray<string>) {
	const uniqueItems: { [item: string]: true } = {};
	items.forEach((item) => uniqueItems[item] = true);
	return Object.keys(uniqueItems);
}


/* Types */

interface CommitsCacheEntry {
	readonly token: string; // The engine's token for the refs and the log
	readonly refs: ReadonlyArray<ShowRefEntry>;
	readonly log: ReadonlyArray<LogEntry>;
}

interface CommitsParts {
	readonly refs: EngineAnswer<ShowRefEntry[]>;
	readonly log: EngineAnswer<LogEntry[]>;
}

interface DiffNameStatusRecord {
	type: GitFileStatus;
	oldFilePath: string;
	newFilePath: string;
}

interface DiffNumStatRecord {
	filePath: string;
	additions: number;
	deletions: number;
}

type EngineRead<T> = (engine: Engine) => Promise<EngineAnswer<T>>;

interface GitBranchData {
	branches: string[];
	head: string | null;
	error: ErrorInfo;
}

interface GitCommitRecord {
	hash: string;
	parents: string[];
	author: string;
	email: string;
	date: number;
	message: string;
	worktree?: string;
	host?: string;
}

export interface GitCommitData {
	commits: GitCommit[];
	head: string | null;
	tags: string[];
	moreCommitsAvailable: boolean;
	error: ErrorInfo;
}

export interface GitCommitDetailsData {
	commitDetails: GitCommitDetails | null;
	error: ErrorInfo;
}

interface GitCommitComparisonData {
	fileChanges: GitFileChange[];
	error: ErrorInfo;
}

type GitConfigSet = { [key: string]: string };

interface GitRef {
	hash: string;
	name: string;
}

interface GitRefTag extends GitRef {
	annotated: boolean;
}

interface GitRefData {
	head: string | null;
	heads: GitRef[];
	tags: GitRefTag[];
	remotes: GitRef[];
	hostBranches: GitRefHostBranch[];
}

interface GitRefHostBranch extends GitRef {
	host: string; // The host's name. `name` is the branch's name on the host.
}

interface GitRepoInfo extends GitBranchData {
	remotes: string[];
	stashes: GitStash[];
	worktrees: GitWorktree[];
	hosts: GitRemoteHost[];
}

interface GitRepoConfigData {
	config: GitRepoConfig | null;
	error: ErrorInfo;
}

interface GitStatusFiles {
	deleted: string[];
	untracked: string[];
}

interface GitTagDetailsData {
	details: GitTagDetails | null;
	error: ErrorInfo;
}

interface GpgStatusCodeParsingDetails {
	readonly status: GitSignatureStatus,
	readonly uid: boolean
}

interface LogRead {
	readonly args: string[]; // The Git CLI's arguments
	readonly request: EngineLogRequest; // The engine's request
}
