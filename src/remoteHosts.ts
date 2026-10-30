import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { getConfig } from './config';
import { ExtensionState } from './extensionState';
import { Logger } from './logger';
import { AGENT_INSTRUCTION } from './remoteHosts/agentInstruction';
import { BROWSE_SCRIPT, parseBrowseOutput } from './remoteHosts/browse';
import { CONFIG_FILE, ParsedConfig, RemoteHostConfig, parseConfig, removeHostFromConfig, setHostInConfig, validateHostName, validateServerPath, validateSshAlias } from './remoteHosts/config';
import { ProcessResult, SshFailure, classifySshFailure, getErrorLines, getForwardingSshOptions, getGitSshCommand, getSshOptions, isAuthenticationError, quotePosix, runProcess } from './remoteHosts/ssh';
import { readSshAliases } from './remoteHosts/sshConfig';
import { BranchTip, STATUS_SCRIPT, ServerWorktree, StatusOutput, getServerWorktrees, getStatusScriptArgs, parseStatusOutput } from './remoteHosts/status';
import { ErrorInfo, GitRemoteHost, GitRemoteHostSettings, GitRemoteHostState, GitWorktree, HostChoice, RemoteFolderEntry, RemoteHostEntry, RemoteHostGitAction, RemoteRepositorySource, SshAlias } from './types';
import { GitExecutable, getPathFromStr } from './utils';
import { Disposable, toDisposable } from './utils/disposable';
import { Event, EventEmitter } from './utils/event';
import { parseWorktreeList } from './worktreeList';

/*
 * The remote hosts of each repository (docs/0.5.0-plan.md). This file owns everything a host has: the config file
 * (`.worktrees/git-tree.yaml` in the main worktree), the SSH calls, each host's last state, the fetch of its branches
 * into `refs/git-tree/hosts/<name>/`, and the actions on it. DataSource and the view only read its state.
 *
 * Only `git` and a POSIX shell run on a server, over plain `ssh`. The config's values never become a command: the alias
 * is one argument to `ssh`, and each path is a quoted argument to a script that Git Tree ships.
 */

/** Where the refs of every remote host live. */
export const HOST_REFS_PREFIX = 'refs/git-tree/hosts/';

/** How long a host's status call may take, in milliseconds. */
const STATUS_TIMEOUT = 15000;

/** How long a fetch, or an action on a server, may take, in milliseconds. A first fetch can bring a lot of history. */
const LONG_TIMEOUT = 300000;

/** How long a local Git command may take, in milliseconds. */
const LOCAL_TIMEOUT = 60000;

/** The Visual Studio Code extension that opens a folder on an SSH server. */
const REMOTE_SSH_EXTENSION = 'ms-vscode-remote.remote-ssh';

/** How long refreshes leave a host alone after it needed authentication: this, doubled for each failure in a row. */
const AUTH_RETRY_DELAY = 30000;

/** The longest refreshes leave a host that needs authentication alone. */
const AUTH_RETRY_MAX_DELAY = 300000;

/**
 * Get the prefix of the refs that hold a remote host's branches: `refs/git-tree/hosts/<name>/heads/`.
 * @param name The host's name.
 */
export function getHostBranchesPrefix(name: string) {
	return HOST_REFS_PREFIX + name + '/heads/';
}

/** What a view shows of a repository's worktrees (getHostFilter). */
export interface HostFilter {
	readonly local: boolean; // This machine's worktrees' rows of uncommitted changes
	readonly hosts: ReadonlyArray<string>; // The names of the remote hosts shown
}

/**
 * Work out what a view shows from the Host dropdown's choice. A remote host is shown when it isn't hidden in Repository
 * Settings, and the choice is All or names it. A host that isn't shown has no worktrees, branches or rows in the view, and
 * the view's refreshes skip it. The webview's resolveHostChoice (web/main.ts) applies the same rules.
 * @param hostNames The names of the repository's remote hosts, from its config.
 * @param hideHosts The names of the hosts hidden in the Hosts panel.
 * @param hostChoice The Host dropdown's choice. The names it has of hosts that aren't in `hostNames`, or are hidden, are
 * ignored, and a choice of only such names counts as All, so a stale choice never hides everything.
 * @returns What the view shows.
 */
export function getHostFilter(hostNames: ReadonlyArray<string>, hideHosts: ReadonlyArray<string>, hostChoice: HostChoice): HostFilter {
	const available = hostNames.filter((name) => hideHosts.indexOf(name) === -1);
	const known = hostChoice !== null ? hostChoice.filter((name) => name === '' || available.indexOf(name) > -1) : [];
	if (hostChoice === null || (hostChoice.length > 0 && known.length === 0)) {
		return { local: true, hosts: available };
	}
	return { local: known.indexOf('') > -1, hosts: available.filter((name) => known.indexOf(name) > -1) };
}

/**
 * Get the ref that holds the HEAD of a detached worktree on a remote host:
 * `refs/git-tree/hosts/<name>/detached/<the first 12 hex of the SHA-1 of its path>`. Folder names can repeat on one
 * host, and paths can't.
 * @param name The host's name.
 * @param worktreePath The worktree's path on the server.
 */
export function getHostDetachedRef(name: string, worktreePath: string) {
	return HOST_REFS_PREFIX + name + '/detached/' + crypto.createHash('sha1').update(worktreePath).digest('hex').substring(0, 12);
}

/**
 * Resolve the path of a new worktree on a server, as the local dialog does: `{repo}` becomes the folder name of the
 * repository on the server, and a relative path is taken from it. `~` can't be resolved here, since the server's home
 * folder isn't known.
 * @param worktreePath The path entered for the new worktree.
 * @param hostPath The path of the repository's main worktree on the server.
 * @returns The absolute path, or the error.
 */
export function resolveServerWorktreePath(worktreePath: string, hostPath: string): { path: string } | { error: string } {
	const entered = worktreePath.trim().replace(/\{repo\}/g, path.posix.basename(hostPath));
	if (entered === '~' || entered.startsWith('~/')) return { error: 'Use an absolute path, or a path relative to the repository, for a worktree on a server: Git Tree doesn\'t know the server\'s home folder.' };
	const resolved = path.posix.resolve(hostPath, entered);
	const error = validateServerPath(resolved);
	return error === null ? { path: resolved } : { error: error };
}

/** A worktree on a remote host, from the host's last good refresh. */
export interface RemoteWorktree {
	readonly worktree: GitWorktree; // `path` is the path on the server, `host` the host's name, `isCurrent` FALSE
	readonly uncommittedChanges: number | null; // The number of `git status --porcelain` lines. NULL => the status couldn't be read.
	readonly commitIsLocal: boolean; // The worktree's HEAD commit is in this repository. FALSE => its rows say the commit isn't on this machine.
}

/** What the Hosts panel shows of a repository's remote hosts. */
export interface RemoteHostsSettings {
	readonly hosts: GitRemoteHostSettings[];
	readonly configFile: string | null; // NULL => the repository has no main worktree Git Tree can find
	readonly configError: string | null;
	readonly sshAliases: SshAlias[];
	readonly agentInstruction: string;
}

/** A folder on a server, as the folder browser lists it. */
export interface RemoteFolderListing {
	readonly path: string; // The physical path that was listed
	readonly parent: string | null; // NULL => the path is the root
	readonly entries: RemoteFolderEntry[];
	readonly truncated: boolean; // The folder holds more folders than BROWSE_LIMIT, and only that many are listed
}

/** What Git Tree knows of a remote host: its state, and its worktrees from the last good refresh. */
export interface RemoteHostSnapshot {
	readonly host: GitRemoteHost;
	readonly worktrees: ReadonlyArray<RemoteWorktree>; // Empty until the first good refresh. Kept, but stale, when the host isn't `ok`.
}

/** One host of a repository, and what Git Tree last read of it. */
interface HostEntry {
	config: RemoteHostConfig; // Replaced when the file changes but the host's alias and path don't
	state: GitRemoteHostState;
	message: string | null;
	lastRefresh: number | null;
	worktrees: ReadonlyArray<RemoteWorktree>;
	snapshot: RemoteHostSnapshot | null; // NULL only while the entry is made
	refreshing: boolean; // A refresh is running, so another one isn't started
	refreshAgain: boolean; // A refresh was asked for while one was running, so one more runs after it
	checkedProject: boolean; // The same project check passed for this alias and path
	askedConsent: boolean; // The fetch consent was asked in this session
	authFailures: number; // The refreshes in a row that ended in `needsAuthentication`
	retryAfter: number; // Refreshes before this time (ms since 1970) leave a host that needs authentication alone
	readonly localCommits: Set<string>; // Commits known to be in the local repository
}

/** The hosts of one repository, which all of its worktrees share. */
interface RepoEntry {
	readonly main: string; // The path of the main worktree, which holds the config file
	readonly repos: Set<string>; // The paths the views and DataSource used for it, which onDidChange fires with
	configKey: string | null; // The modification time and size of the file when it was last read. '' => no file. NULL => never read.
	configError: string | null;
	hosts: HostEntry[];
	loading: Promise<void> | null;
	watcher: vscode.Disposable | null;
	checkedTracked: boolean; // Whether the config file is tracked by Git was checked, since it last appeared
}

/**
 * The remote hosts of each repository, from its `.worktrees/git-tree.yaml`: their state, their worktrees, the fetch of
 * their branches into `refs/git-tree/hosts/<name>/`, and the actions on them.
 */
export class RemoteHosts extends Disposable {
	private readonly extensionState: ExtensionState;
	private readonly logger: Logger;
	private gitExecutable: GitExecutable | null;
	private readonly mainWorktrees = new Map<string, Promise<string | null>>(); // The main worktree of each repository path, being found or found
	private readonly resolvedMainWorktrees = new Map<string, string | null>(); // The same, once found. NULL => it has none.
	private readonly entries = new Map<string, RepoEntry>(); // By main worktree
	private controlDir: string | null | undefined = undefined; // The folder of the shared SSH connections. NULL => no sharing. Undefined => not set up yet.
	private consentQueue: Promise<unknown> = Promise.resolve(); // The consent dialogs, one at a time
	private intervalTimer: NodeJS.Timeout | null = null;
	private readonly onDidChangeEmitter: EventEmitter<string>;

	/**
	 * Fires with a repository's path when anything about its hosts changed: the config, a host's state, a worktree,
	 * a status count, or a fetch that moved the host refs. The views of that repository refresh (softly).
	 */
	public readonly onDidChange: Event<string>;

	/**
	 * @param extensionState The Git Tree ExtensionState instance (it remembers each host's fetch consent).
	 * @param gitExecutable The Git executable available to Git Tree at startup.
	 * @param onDidChangeGitExecutable The Event emitting the Git executable for Git Tree to use.
	 * @param logger The Git Tree Logger instance.
	 */
	constructor(extensionState: ExtensionState, gitExecutable: GitExecutable | null, onDidChangeGitExecutable: Event<GitExecutable>, logger: Logger) {
		super();
		this.extensionState = extensionState;
		this.gitExecutable = gitExecutable;
		this.logger = logger;
		this.onDidChangeEmitter = new EventEmitter<string>();
		this.onDidChange = this.onDidChangeEmitter.subscribe;

		this.startInterval();
		this.registerDisposables(
			this.onDidChangeEmitter,
			onDidChangeGitExecutable((executable) => {
				this.gitExecutable = executable;
				// Look again for the main worktrees that the old Git couldn't find
				this.resolvedMainWorktrees.forEach((main, repo) => {
					if (main === null) this.resolvedMainWorktrees.delete(repo);
				});
			}),
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration('git-tree.remoteHosts.refreshInterval')) this.startInterval();
			}),
			toDisposable(() => {
				if (this.intervalTimer !== null) clearInterval(this.intervalTimer);
				this.entries.forEach((entry) => {
					if (entry.watcher !== null) entry.watcher.dispose();
				});
			})
		);
	}

	/**
	 * Get the hosts of a repository, as they are now. It never waits for the network.
	 * @param repo The path of the repository (any of its worktrees), as the view and DataSource know it.
	 * @returns One snapshot per host in the config, in the config's order. Empty when the repository has no config.
	 */
	public getHosts(repo: string): RemoteHostSnapshot[] {
		const entry = this.getEntry(repo);
		return entry !== null ? entry.hosts.map((host) => host.snapshot!) : [];
	}

	/**
	 * Get why a repository's config file can't be used at all (it isn't valid YAML, or its top level is wrong). The hosts
	 * from the last good read keep their rows, with the `configError` state and this message.
	 * @param repo The path of the repository.
	 * @returns The error, naming its line. NULL => the file is usable, or there's none.
	 */
	public getConfigError(repo: string): string | null {
		const entry = this.getEntry(repo);
		return entry !== null ? entry.configError : null;
	}

	/**
	 * Get the path of a repository's config file, once Git Tree knows its main worktree.
	 * @param repo The path of the repository.
	 * @returns The path (the file may not exist). NULL => not known yet, or the repository has no main worktree.
	 */
	public getConfigFile(repo: string): string | null {
		const main = this.resolvedMainWorktrees.get(repo);
		return typeof main === 'string' ? main + '/' + CONFIG_FILE : null;
	}

	/**
	 * Read a repository's config file (if it changed), and get its hosts. Unlike `getHosts`, it waits for the file.
	 * @param repo The path of the repository.
	 * @returns One snapshot per host in the config, in the config's order.
	 */
	public async loadHosts(repo: string): Promise<RemoteHostSnapshot[]> {
		const entry = await this.loadEntry(repo);
		return entry !== null ? entry.hosts.map((host) => host.snapshot!) : [];
	}

	/**
	 * Start a refresh of each of a repository's hosts in the background, unless one is already running for that host.
	 * Each host refreshes on its own, with a time limit, and `onDidChange` fires when one changed something.
	 * The hosts the view doesn't show are skipped, so they cost no SSH call.
	 * @param repo The path of the repository.
	 * @param hideHosts The names of the hosts hidden in the Hosts panel.
	 * @param hostChoice The Host dropdown's choice.
	 */
	public refresh(repo: string, hideHosts: ReadonlyArray<string> = [], hostChoice: HostChoice = null): void {
		this.loadEntry(repo).then((entry) => {
			// The names are only known once the config is read, so the hosts to skip are worked out here
			if (entry === null) return;
			const names = entry.hosts.map((host) => host.config.name), shown = getHostFilter(names, hideHosts, hostChoice).hosts;
			this.refreshEntry(entry, names.filter((name) => shown.indexOf(name) === -1));
		}, (error) => this.logger.logError('Remote hosts: ' + error));
	}

	/**
	 * Ask the user again whether Git Tree may fetch from a host: the action of a host that shows `needsConsent`.
	 * @param repo The path of the repository.
	 * @param host The host's name.
	 */
	public async askFetchConsent(repo: string, host: string): Promise<void> {
		const found = await this.findHost(repo, host);
		if (typeof found === 'string') return;
		if (await this.askConsent(found.entry, found.host)) this.refreshHost(found.entry, found.host);
	}

	/**
	 * Open a remote worktree in Visual Studio Code, with Remote-SSH.
	 * @param repo The path of the repository.
	 * @param host The host's name.
	 * @param worktreePath The worktree's path on the server.
	 * @param newWindow Open it in a new window.
	 */
	public async openWorktree(repo: string, host: string, worktreePath: string, newWindow: boolean): Promise<ErrorInfo> {
		const found = await this.findHost(repo, host);
		if (typeof found === 'string') return found;
		const pathError = validateServerPath(worktreePath);
		if (pathError !== null) return pathError;
		if (typeof vscode.extensions.getExtension(REMOTE_SSH_EXTENSION) === 'undefined') {
			return 'Opening a worktree on a server needs the Remote - SSH extension (' + REMOTE_SSH_EXTENSION + '). Install it, then try again.';
		}

		const uri = vscode.Uri.from({ scheme: 'vscode-remote', authority: 'ssh-remote+' + found.host.config.ssh, path: worktreePath });
		return vscode.commands.executeCommand('vscode.openFolder', uri, newWindow).then(
			() => null,
			() => 'Visual Studio Code was unable to open the worktree ' + host + ':' + worktreePath + '.'
		);
	}

	/**
	 * Create a worktree on a remote host, with `git -C <host path> worktree add`.
	 * @param repo The path of the repository.
	 * @param host The host's name.
	 * @param worktreePath The new worktree's path on the server: absolute, or relative to the host's path (see `resolveServerWorktreePath`).
	 * @param commitOrBranch The commit or branch to check out (a branch must exist on the server).
	 * @param newBranch The name of a new branch to create at `commitOrBranch`, or NULL.
	 */
	public async createWorktree(repo: string, host: string, worktreePath: string, commitOrBranch: string, newBranch: string | null): Promise<ErrorInfo> {
		const found = await this.findHost(repo, host);
		if (typeof found === 'string') return found;
		const resolved = resolveServerWorktreePath(worktreePath, found.host.config.path);
		if ('error' in resolved) return resolved.error;
		if (commitOrBranch === '' || commitOrBranch.startsWith('-')) return 'The commit or branch "' + commitOrBranch + '" isn\'t valid.';

		const args = [trimTrailingSlashes(found.host.config.path), resolved.path, commitOrBranch, newBranch !== null ? newBranch : ''];
		const result = await this.runOnHost(found.host.config.ssh, CREATE_WORKTREE_SCRIPT, args, LONG_TIMEOUT, false);
		return this.finishAction(found.entry, found.host, result, 'create the worktree', { 7: 'The worktree was created, but Git Tree couldn\'t add its folder to info/exclude on the server' });
	}

	/**
	 * Remove a worktree on a remote host, with `git -C <host path> worktree remove`.
	 * @param repo The path of the repository.
	 * @param host The host's name.
	 * @param worktreePath The worktree's path on the server.
	 * @param force Remove it even if it has changes.
	 */
	public async removeWorktree(repo: string, host: string, worktreePath: string, force: boolean): Promise<ErrorInfo> {
		const found = await this.findHost(repo, host);
		if (typeof found === 'string') return found;
		const pathError = validateServerPath(worktreePath);
		if (pathError !== null) return pathError;

		const result = await this.runOnHost(found.host.config.ssh, REMOVE_WORKTREE_SCRIPT, [found.host.config.path, worktreePath, force ? 'yes' : 'no'], LONG_TIMEOUT, false);
		return this.finishAction(found.entry, found.host, result, 'remove the worktree');
	}

	/**
	 * Open a terminal on a remote host, in a worktree.
	 * @param repo The path of the repository.
	 * @param host The host's name.
	 * @param worktreePath The worktree's path on the server.
	 */
	public openTerminal(repo: string, host: string, worktreePath: string): ErrorInfo {
		const entry = this.getEntry(repo);
		if (entry !== null && entry.configError !== null) return entry.configError;
		const found = entry !== null ? entry.hosts.find((hostEntry) => hostEntry.config.name === host) : undefined;
		if (typeof found === 'undefined') return 'The host "' + host + '" isn\'t in ' + CONFIG_FILE + '.';
		if (found.config.error !== null) return found.config.error;
		const pathError = validateServerPath(worktreePath);
		if (pathError !== null) return pathError;

		// Interactive, so ssh may ask for a password. It reuses the shared connection when there is one.
		const terminal = vscode.window.createTerminal({
			name: 'Git Tree: ' + host + ':' + path.posix.basename(worktreePath),
			shellPath: getConfig().remoteHostsSshPath,
			shellArgs: getSshOptions(this.getControlDir(), false).concat(['-t', found.config.ssh, 'cd ' + quotePosix(worktreePath) + ' && exec "$SHELL" -l'])
		});
		terminal.show();
		return null;
	}

	/**
	 * Run Git on a remote host, in one of its worktrees: `git fetch --all --prune`, `git pull --ff-only` or `git push`,
	 * with no terminal prompt, so a missing credential is an error instead of a hang. A host with `forwardAgent` runs it
	 * on its own connection with the SSH agent forwarded. The host refreshes afterwards.
	 * @param repo The path of the repository.
	 * @param host The host's name.
	 * @param worktreePath The worktree's path on the server: the host's path, or one of the worktrees of its last refresh.
	 * @param action The Git command.
	 * @returns The ErrorInfo, with Git's error lines when the command failed.
	 */
	public async runGitOnHost(repo: string, host: string, worktreePath: string, action: RemoteHostGitAction): Promise<ErrorInfo> {
		const found = await this.findHost(repo, host);
		if (typeof found === 'string') return found;
		const command = Object.prototype.hasOwnProperty.call(SERVER_GIT_COMMANDS, action) ? SERVER_GIT_COMMANDS[action] : undefined;
		if (typeof command !== 'string') return 'Git Tree doesn\'t run "' + action + '" on a server.';
		const pathError = validateServerPath(worktreePath);
		if (pathError !== null) return pathError;
		const known = [found.host.config.path].concat(found.host.worktrees.map((worktree) => worktree.worktree.path)).map(trimTrailingSlashes);
		if (known.indexOf(trimTrailingSlashes(worktreePath)) === -1) {
			return worktreePath + ' isn\'t a worktree of "' + host + '" that Git Tree knows. Refresh the view, then try again.';
		}

		const result = await this.runOnHost(found.host.config.ssh, SERVER_GIT_SCRIPT, [worktreePath, action], LONG_TIMEOUT, found.host.config.forwardAgent);
		return this.finishAction(found.entry, found.host, result, 'run ' + command + ' in ' + worktreePath);
	}

	/**
	 * Run a fixed script on a host for a reader or an action outside this file (the Manage panel), as
	 * `sh -s -- <the host's path> <arguments>`. The host's path comes from the config, never from the caller. A host that
	 * needs authentication is left alone until refreshes would try it again. A call that SSH refused starts a refresh, as
	 * an action does, which records the host's state and starts that wait, so these calls don't keep adding failed logins.
	 * @param repo The path of the repository.
	 * @param host The host's name.
	 * @param script The script.
	 * @param args The script's arguments after the host's path.
	 * @param timeout The time limit, in milliseconds.
	 * @param changesHost The script changes the host, so the host refreshes afterwards.
	 * @returns The result of a call that connected (the script may still have failed), or why the host couldn't be used.
	 */
	public async runScript(repo: string, host: string, script: string, args: ReadonlyArray<string>, timeout: number, changesHost: boolean): Promise<{ result: ProcessResult } | { error: string }> {
		const found = await this.findHost(repo, host);
		if (typeof found === 'string') return { error: found };
		if (found.host.state === 'needsAuthentication' && Date.now() < found.host.retryAfter && found.host.message !== null) return { error: found.host.message };

		const result = await this.runOnHost(found.host.config.ssh, script, [trimTrailingSlashes(found.host.config.path)].concat(args), timeout, false);
		const sshFailure = classifySshFailure(result, found.host.config.ssh);
		if (changesHost || sshFailure !== null) this.refreshHost(found.entry, found.host);
		return sshFailure !== null ? { error: sshFailure.message } : { result: result };
	}


	/* The Hosts Panel */

	/**
	 * Get what the Hosts panel shows of a repository's remote hosts: each host's entry and state, the config file,
	 * the SSH aliases, and the instruction for coding agents. It reads only local files, and never waits for a server:
	 * each host's state is from its last refresh.
	 * @param repo The path of the repository.
	 * @returns The settings.
	 */
	public async loadSettings(repo: string): Promise<RemoteHostsSettings> {
		const results = await Promise.all([this.loadEntry(repo), this.getSshAliases()]);
		const entry = results[0];
		return {
			hosts: entry !== null ? entry.hosts.map((host) => ({
				name: host.config.name,
				ssh: host.config.ssh,
				path: host.config.path,
				worktrees: host.config.worktrees,
				forwardAgent: host.config.forwardAgent,
				state: host.state,
				message: host.message,
				lastRefresh: host.lastRefresh,
				worktreeCount: host.worktrees.length
			})) : [],
			configFile: entry !== null ? entry.main + '/' + CONFIG_FILE : null,
			configError: entry !== null ? entry.configError : null,
			sshAliases: results[1],
			agentInstruction: AGENT_INSTRUCTION
		};
	}

	/**
	 * Get the Host aliases of ~/.ssh/config and the files it includes, to offer when a host is added. The files are only read.
	 * @returns The literal aliases, each with its block's HostName and User. Empty when there's no file.
	 */
	public getSshAliases(): Promise<SshAlias[]> {
		const home = os.homedir();
		return readSshAliases(path.join(home, '.ssh', 'config'), home).catch((error) => {
			this.logger.logError('Remote hosts: Git Tree couldn\'t read the SSH configuration (' + error + ').');
			return [];
		});
	}

	/**
	 * List the folders in a folder on a server, for the folder browser, over the shared connection: one SSH call.
	 * @param ssh The SSH alias.
	 * @param serverPath The folder. NULL => the home folder on the server.
	 * @returns The listing, or why there's none.
	 */
	public async browse(ssh: string, serverPath: string | null): Promise<RemoteFolderListing | { error: string }> {
		const valueError = validateSshAlias(ssh) || (serverPath !== null ? validateServerPath(serverPath) : null);
		if (valueError !== null) return { error: valueError };

		const result = await this.runOnHost(ssh, BROWSE_SCRIPT, [serverPath !== null ? serverPath : ''], STATUS_TIMEOUT, false);
		const sshFailure = classifySshFailure(result, ssh);
		if (sshFailure !== null) return { error: sshFailure.message };
		const output = parseBrowseOutput(result.stdout.toString());
		if (output.kind === 'noPath') {
			return { error: serverPath !== null ? ssh + ':' + serverPath + ' doesn\'t exist, or isn\'t a folder Git Tree can enter.' : 'Git Tree couldn\'t enter the home folder on "' + ssh + '".' };
		} else if (output.kind === 'unreadable' || result.code !== 0) {
			const stderr = getErrorLines(result.stderr);
			return { error: 'Git Tree couldn\'t list the folders of ' + ssh + ':' + (serverPath !== null ? serverPath : '~') + ' (exit code ' + result.code + ')' + (stderr !== '' ? ': ' + stderr : '.') };
		}
		return { path: output.path, parent: output.parent, entries: output.entries.slice(), truncated: output.truncated };
	}


	/* Adding and removing hosts */

	/**
	 * Check that a path on a server can be a host of a repository: Git Tree can connect without a prompt, the path is
	 * the main worktree of a repository, and that repository shares a root commit with this one.
	 * @param repo The path of the repository.
	 * @param ssh The SSH alias.
	 * @param serverPath The path on the server.
	 * @returns The ErrorInfo: what's wrong, or NULL.
	 */
	public async checkHost(repo: string, ssh: string, serverPath: string): Promise<ErrorInfo> {
		const valueError = validateSshAlias(ssh) || validateServerPath(serverPath);
		if (valueError !== null) return valueError;
		const entry = await this.loadEntry(repo);
		if (entry === null) return getNoMainWorktreeMessage(repo);
		return this.checkNewHost(entry, ssh, serverPath);
	}

	/**
	 * Add a host to a repository's config file, or replace one. An added host, and an edited host whose SSH alias or path
	 * changed, is checked first (see `checkHost`); a change of only its other keys is written at once. The file keeps
	 * its other entries, comments and order. A renamed host keeps its fetch consent, and its old refs are deleted.
	 * @param repo The path of the repository.
	 * @param previousName NULL => add the host. Otherwise => replace the host with this name.
	 * @param host The host's entry.
	 * @returns The ErrorInfo: why the host wasn't written, or NULL.
	 */
	public async saveHost(repo: string, previousName: string | null, host: RemoteHostEntry): Promise<ErrorInfo> {
		const valueError = validateHostName(host.name) || validateSshAlias(host.ssh) || validateServerPath(host.path);
		if (valueError !== null) return valueError;
		const entry = await this.loadEntry(repo);
		if (entry === null) return getNoMainWorktreeMessage(repo);

		const previous = previousName !== null ? entry.hosts.find((hostEntry) => hostEntry.config.name === previousName) : undefined;
		if (previousName !== null && typeof previous === 'undefined' && entry.configError === null) return 'The host "' + previousName + '" isn\'t in ' + CONFIG_FILE + '.';
		// Find what keeps the file from taking the host (such as a name that's taken) before the check's SSH call
		const ready = await this.editConfig(entry, (text) => setHostInConfig(text, previousName, host), false);
		if (ready !== null) return ready;

		if (typeof previous === 'undefined' || previous.config.error !== null || previous.config.ssh !== host.ssh || previous.config.path !== host.path) {
			const checkError = await this.checkNewHost(entry, host.ssh, host.path);
			if (checkError !== null) return checkError;
		}
		const writeError = await this.editConfig(entry, (text) => setHostInConfig(text, previousName, host), true);
		if (writeError !== null) return writeError;

		const errors: ErrorInfo[] = [];
		if (previousName !== null && previousName !== host.name) {
			errors.push(await this.extensionState.moveRemoteHostFetchConsent(entry.main, previousName, host.name));
			errors.push(await this.deleteRefs(entry.main, HOST_REFS_PREFIX + previousName + '/', []));
		}
		if (previousName === null) errors.push(await this.excludeConfigFolder(entry.main));
		await this.reloadAndRefresh(entry);
		return errors.reduce<ErrorInfo>((first, error) => first !== null ? first : error, null);
	}

	/**
	 * Create a repository on a server, in a folder that's missing or empty, and add it as a host (see `saveHost`).
	 * - `clone`: the server runs `git clone <url of the remote>`, with the SSH agent forwarded if the host has `forwardAgent`.
	 * - `push`: the server runs `git init`, and points HEAD at this repository's current branch. Then this machine pushes
	 *   its branches with `receive.denyCurrentBranch=updateInstead` for that one push, which checks the branch out on
	 *   the server without changing the server's config.
	 * @param repo The path of the repository.
	 * @param host The host's entry. Its path is the new repository's folder.
	 * @param source Where the new repository's commits come from.
	 * @returns The ErrorInfo: why the repository wasn't created, or the host wasn't added, or NULL.
	 */
	public async createRepository(repo: string, host: RemoteHostEntry, source: RemoteRepositorySource): Promise<ErrorInfo> {
		const valueError = validateHostName(host.name) || validateSshAlias(host.ssh) || validateServerPath(host.path);
		if (valueError !== null) return valueError;
		const entry = await this.loadEntry(repo);
		if (entry === null) return getNoMainWorktreeMessage(repo);
		if (this.gitExecutable === null) return 'Git Tree has no Git executable.';
		const ready = await this.editConfig(entry, (text) => setHostInConfig(text, null, host), false);
		if (ready !== null) return ready;
		const where = host.ssh + ':' + host.path;

		if (source.kind === 'clone') {
			const url = await this.getCloneUrl(repo, source.remote);
			if ('error' in url) return url.error;
			const result = await this.runOnHost(host.ssh, CLONE_SCRIPT, [host.path, url.url], LONG_TIMEOUT, host.forwardAgent);
			const error = getCreateError(result, host.ssh, where, 'clone ' + source.remote + ' into');
			if (error !== null) return error;
		} else {
			const head = await runProcess(this.gitExecutable.path, ['symbolic-ref', '-q', 'HEAD'], { cwd: repo, timeout: LOCAL_TIMEOUT });
			const branchRef = head.stdout.toString().trim();
			if (head.code !== 0 || !branchRef.startsWith('refs/heads/')) {
				return 'This repository\'s HEAD isn\'t on a branch, so Git Tree doesn\'t know which branch to check out on the server. Check out a branch, then try again.';
			}
			const init = await this.runOnHost(host.ssh, INIT_SCRIPT, [host.path, branchRef], LONG_TIMEOUT, false);
			const initError = getCreateError(init, host.ssh, where, 'create a repository in');
			if (initError !== null) return initError;

			const args = ['push', '--quiet', '--receive-pack=git -c receive.denyCurrentBranch=updateInstead receive-pack', where, 'refs/heads/*:refs/heads/*'];
			this.logger.logCmd('git', args);
			const push = await runProcess(this.gitExecutable.path, args, { cwd: repo, env: this.getGitSshEnv(), timeout: LONG_TIMEOUT });
			if (push.code !== 0) {
				const message = push.timedOut ? 'the push timed out.' : push.error !== null ? push.error.message : getErrorLines(push.stderr);
				return 'Git Tree made an empty repository at ' + where + ', but couldn\'t push this repository\'s branches to it: ' + message + ' Remove that folder on the server before you try again.';
			}
		}
		return this.saveHost(repo, null, host);
	}

	/**
	 * Remove a host from a repository's config file, and delete its refs under `refs/git-tree/hosts/<name>/`.
	 * @param repo The path of the repository.
	 * @param name The host's name.
	 * @returns The ErrorInfo: why it wasn't removed, or NULL.
	 */
	public async removeHost(repo: string, name: string): Promise<ErrorInfo> {
		const entry = await this.loadEntry(repo);
		if (entry === null) return getNoMainWorktreeMessage(repo);

		const file = entry.main + '/' + CONFIG_FILE;
		const text = await readTextFile(file);
		if (text === null) return 'There\'s no ' + file + '.';
		if (text instanceof Error) return 'Git Tree couldn\'t read ' + file + ' (' + text.message + ').';
		const edited = removeHostFromConfig(text, name);
		if ('error' in edited) return edited.error;

		const writeError = await writeTextFile(file, edited.text);
		if (writeError !== null) return writeError;
		await this.extensionState.clearRemoteHostFetchConsent(entry.main, name);
		const refsError = validateHostName(name) === null ? await this.deleteRefs(entry.main, HOST_REFS_PREFIX + name + '/', []) : null;
		await this.reloadAndRefresh(entry);
		return refsError;
	}


	/* Repositories and their config */

	/**
	 * Get the entry of a repository, if its main worktree and config have been read. Starts reading them if not.
	 * @param repo The path of the repository.
	 * @returns The entry, or NULL.
	 */
	private getEntry(repo: string) {
		const main = this.resolvedMainWorktrees.get(repo);
		if (typeof main === 'undefined') {
			if (!this.mainWorktrees.has(repo)) this.loadEntry(repo).then(() => { }, () => { });
			return null;
		}
		const entry = main !== null ? this.entries.get(main) : undefined;
		return typeof entry !== 'undefined' && entry.configKey !== null ? entry : null;
	}

	/**
	 * Get the entry of a repository, reading its main worktree, and its config file if it changed.
	 * @param repo The path of the repository.
	 * @returns The entry. NULL => the repository has no main worktree Git Tree can find.
	 */
	private async loadEntry(repo: string): Promise<RepoEntry | null> {
		let mainPromise = this.mainWorktrees.get(repo);
		if (typeof mainPromise === 'undefined') {
			mainPromise = this.findMainWorktree(repo);
			this.mainWorktrees.set(repo, mainPromise);
		}
		const main = await mainPromise;
		if (main === null) {
			this.mainWorktrees.delete(repo); // Look again next time: Git may not have been available yet
			this.resolvedMainWorktrees.set(repo, null);
			return null;
		}

		let entry = this.entries.get(main);
		if (typeof entry === 'undefined') {
			entry = { main: main, repos: new Set<string>(), configKey: null, configError: null, hosts: [], loading: null, watcher: null, checkedTracked: false };
			this.entries.set(main, entry);
			entry.watcher = this.watchConfig(entry);
		}
		const isNewRepo = !entry.repos.has(repo);
		entry.repos.add(repo);

		const changed = await this.loadConfig(entry);
		this.resolvedMainWorktrees.set(repo, main);
		if (entry.configKey === '') {
			entry.checkedTracked = false;
		} else if (!entry.checkedTracked) {
			entry.checkedTracked = true;
			this.warnIfConfigTracked(entry);
		}
		if (changed) {
			this.emitChange(entry);
		} else if (isNewRepo && entry.hosts.length > 0) {
			this.onDidChangeEmitter.emit(repo);
		}
		return entry;
	}

	/**
	 * Warn if Git tracks the config file: it names the user's servers and paths, and belongs in the excluded `.worktrees/`
	 * folder, so a commit would share them with everyone who can read the repository.
	 * @param entry The repository's entry.
	 */
	private warnIfConfigTracked(entry: RepoEntry) {
		this.runGit(entry.main, ['ls-files', '--', CONFIG_FILE], LOCAL_TIMEOUT).then((tracked) => {
			if (tracked === null || tracked.trim() === '') return;
			const message = 'Git tracks ' + CONFIG_FILE + ' in ' + entry.main + ', so a commit would share your SSH hosts and their paths. Remove it from Git with: git rm --cached ' + CONFIG_FILE;
			this.logger.logError('Remote hosts: ' + message);
			vscode.window.showWarningMessage(message).then(() => { }, () => { });
		});
	}

	/**
	 * Find the main worktree of a repository, from any of its worktrees, with `git rev-parse --git-common-dir`.
	 * @param repo The path of the repository.
	 * @returns The path of the main worktree. NULL => there's none (a bare repository), or Git couldn't read it.
	 */
	private async findMainWorktree(repo: string): Promise<string | null> {
		const commonDir = await this.runGit(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'], LOCAL_TIMEOUT);
		if (commonDir === null) return null;
		const dir = getPathFromStr(commonDir.trim());
		if (path.basename(dir) === '.git') return getPathFromStr(path.dirname(dir));

		// A Git folder apart from its worktree (`git init --separate-git-dir`): Git's worktree list names the main worktree
		const list = await this.runGit(repo, ['worktree', 'list', '--porcelain'], LOCAL_TIMEOUT);
		const first = list !== null ? parseWorktreeList(list)[0] : undefined;
		return typeof first !== 'undefined' && first.path !== null && !first.bare ? getPathFromStr(first.path) : null;
	}

	/**
	 * Read a repository's config file, if it changed since it was last read.
	 * @param entry The repository's entry.
	 * @returns TRUE => what the view shows of the hosts changed.
	 */
	private loadConfig(entry: RepoEntry): Promise<boolean> {
		if (entry.loading !== null) return entry.loading.then(() => false);

		const file = entry.main + '/' + CONFIG_FILE;
		let changed = false;
		entry.loading = new Promise<void>((resolve) => {
			fs.stat(file, (statError, stats) => {
				const key = statError === null ? stats.mtimeMs + ':' + stats.size : statError.code === 'ENOENT' ? '' : 'error:' + statError.code;
				if (key === entry.configKey) return resolve();
				readTextFile(file).then((text) => {
					const before = getSnapshotsKey(entry);
					entry.configKey = key;
					this.applyConfig(entry, text === null
						? { hosts: [], error: null }
						: text instanceof Error ? { hosts: null, error: 'Git Tree couldn\'t read ' + CONFIG_FILE + ' (' + text.message + ').' } : parseConfig(text));
					changed = getSnapshotsKey(entry) !== before;
					if (changed && entry.configError !== null) this.logger.logError('Remote hosts: ' + file + ': ' + entry.configError);
					resolve();
				});
			});
		}).then(() => {
			entry.loading = null;
		});
		return entry.loading.then(() => changed);
	}

	/**
	 * Apply a read of the config file to a repository's hosts. A host whose SSH alias and path are unchanged keeps its
	 * state and worktrees; any other host starts again.
	 * @param entry The repository's entry.
	 * @param parsed The parsed file.
	 */
	private applyConfig(entry: RepoEntry, parsed: ParsedConfig) {
		if (parsed.hosts === null) {
			// The whole file is unusable: the hosts from the last good read keep their (stale) rows, with its error
			entry.configError = parsed.error;
			entry.hosts.forEach((host) => this.setHostState(host, 'configError', parsed.error, host.worktrees));
			return;
		}

		entry.configError = null;
		entry.hosts = parsed.hosts.map((config) => {
			const old = entry.hosts.find((host) => host.config.name === config.name && host.config.ssh === config.ssh && host.config.path === config.path && host.config.error === null);
			if (config.error === null && typeof old !== 'undefined') {
				old.config = config;
				if (old.state === 'configError') {
					this.setHostState(old, 'loading', null, old.worktrees);
				} else {
					this.setHostState(old, old.state, old.message, old.worktrees);
				}
				return old;
			}
			const host: HostEntry = {
				config: config, state: 'loading', message: null, lastRefresh: null, worktrees: [], snapshot: null,
				refreshing: false, refreshAgain: false, checkedProject: false, askedConsent: false, authFailures: 0, retryAfter: 0, localCommits: new Set<string>()
			};
			this.setHostState(host, config.error !== null ? 'configError' : 'loading', config.error, []);
			return host;
		});
	}

	/**
	 * Watch a repository's config file, and reload it when it changes. Each refresh also checks the file, so a change
	 * the watcher misses (such as the `.worktrees` folder being created) is still read.
	 * @param entry The repository's entry.
	 * @returns The watcher.
	 */
	private watchConfig(entry: RepoEntry): vscode.Disposable | null {
		try {
			const folder = vscode.Uri.file(entry.main + '/' + path.posix.dirname(CONFIG_FILE));
			const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, path.posix.basename(CONFIG_FILE)));
			let timeout: NodeJS.Timeout | null = null;
			const onChange = () => {
				if (timeout !== null) clearTimeout(timeout);
				timeout = setTimeout(() => {
					timeout = null;
					this.loadConfig(entry).then((changed) => {
						if (changed) this.refreshEntry(entry);
					});
				}, 250);
			};
			watcher.onDidCreate(onChange);
			watcher.onDidChange(onChange);
			watcher.onDidDelete(onChange);
			return watcher;
		} catch (error) {
			this.logger.logError('Remote hosts: Git Tree couldn\'t watch ' + entry.main + '/' + CONFIG_FILE + ' (' + error + ').');
			return null;
		}
	}

	/**
	 * Reload a repository's config file after Git Tree changed it, and refresh its hosts.
	 * @param entry The repository's entry.
	 */
	private async reloadAndRefresh(entry: RepoEntry) {
		if (entry.loading !== null) await entry.loading;
		entry.configKey = null;
		if (await this.loadConfig(entry)) this.emitChange(entry);
		this.refreshEntry(entry);
	}

	/**
	 * Find a host of a repository, for an action.
	 * @param repo The path of the repository.
	 * @param name The host's name.
	 * @returns The host, or why there's no usable host by that name.
	 */
	private async findHost(repo: string, name: string): Promise<{ entry: RepoEntry, host: HostEntry } | string> {
		const entry = await this.loadEntry(repo);
		const host = entry !== null ? entry.hosts.find((hostEntry) => hostEntry.config.name === name) : undefined;
		if (entry !== null && entry.configError !== null) return entry.configError;
		if (entry === null || typeof host === 'undefined') return 'The host "' + name + '" isn\'t in ' + CONFIG_FILE + '.';
		if (host.config.error !== null) return host.config.error;
		return { entry: entry, host: host };
	}

	/**
	 * Check a path on a server before it becomes a host: the connection, then that it's the main worktree of a
	 * repository, then the same project check.
	 * @param entry The repository's entry.
	 * @param ssh The SSH alias.
	 * @param serverPath The path on the server.
	 * @returns The ErrorInfo: what's wrong, or NULL.
	 */
	private async checkNewHost(entry: RepoEntry, ssh: string, serverPath: string): Promise<ErrorInfo> {
		const config: RemoteHostConfig = { name: '', ssh: ssh, path: serverPath, worktrees: false, forwardAgent: false, error: null };
		const status = await this.readStatus(config, true);
		if ('failure' in status) return status.failure.message;

		// Git lists the main worktree first, by its physical path, so a linked worktree, a folder inside a worktree, and a
		// path through a symbolic link each differ from it
		const main = status.status.worktrees[0], where = ssh + ':' + serverPath;
		if (main.bare) return where + ' is in a bare repository, which has no main worktree. Use the path of a repository with a working tree.';
		if (main.path !== trimTrailingSlashes(serverPath)) {
			return where + ' isn\'t the main worktree of its repository. Use the main worktree\'s path, ' + main.path + ', and Git Tree shows the linked worktrees with it.';
		}
		const projectError = await this.checkSameProject(entry, config, status.status.roots);
		return projectError !== null ? projectError.message : null;
	}

	/**
	 * Edit a repository's config file: read it, change its text, and write it.
	 * @param entry The repository's entry.
	 * @param edit The change: the new text, or why it can't be made.
	 * @param write Write the file. FALSE => only find out whether the change can be made.
	 * @returns The ErrorInfo.
	 */
	private async editConfig(entry: RepoEntry, edit: (text: string | null) => { text: string } | { error: string }, write: boolean): Promise<ErrorInfo> {
		const file = entry.main + '/' + CONFIG_FILE;
		const text = await readTextFile(file);
		if (text instanceof Error) return 'Git Tree couldn\'t read ' + file + ' (' + text.message + ').';
		const edited = edit(text);
		if ('error' in edited) return edited.error;
		return write ? writeTextFile(file, edited.text) : null;
	}

	/**
	 * Get the URL of a local remote, for a server to clone. A path on this machine, and a URL that holds a password, are refused.
	 * @param repo The path of the repository.
	 * @param remote The remote's name.
	 * @returns The URL, or why it can't be cloned on a server.
	 */
	private async getCloneUrl(repo: string, remote: string): Promise<{ url: string } | { error: string }> {
		if (remote === '' || remote.startsWith('-')) return { error: 'The remote name "' + remote + '" isn\'t valid.' };
		// `get-url` applies this machine's `url.<base>.insteadOf` rules, which the server doesn't have
		const output = await this.runGit(repo, ['remote', 'get-url', remote], LOCAL_TIMEOUT);
		const url = output !== null ? output.trim() : '';
		if (url === '') return { error: 'This repository has no remote named "' + remote + '".' };
		if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/@]*:[^/@]*@/.test(url)) {
			return { error: 'The URL of the remote "' + remote + '" holds a password, which Git Tree doesn\'t send to a server. Use an SSH URL with a forwarded agent, or Push instead.' };
		}
		if (isLocalPathUrl(url)) {
			return { error: 'The remote "' + remote + '" is a path on this machine (' + url + '), which the server can\'t reach. Use Push instead.' };
		}
		return { url: url };
	}


	/* Refreshing hosts */

	/**
	 * Restart the refresh interval, from the `git-tree.remoteHosts.refreshInterval` setting.
	 */
	private startInterval() {
		if (this.intervalTimer !== null) {
			clearInterval(this.intervalTimer);
			this.intervalTimer = null;
		}
		const interval = getConfig().remoteHostsRefreshInterval;
		if (interval > 0) {
			this.intervalTimer = setInterval(() => {
				this.entries.forEach((entry) => {
					this.loadConfig(entry).then((changed) => {
						if (changed) this.emitChange(entry);
						this.refreshEntry(entry, this.getHiddenHosts(entry));
					});
				});
			}, interval);
		}
	}

	/**
	 * Get the hosts that no saved view state of a repository shows (getHostFilter), which the interval leaves alone, as a
	 * view's own refresh does.
	 * @param entry The repository's entry.
	 * @returns The names of the hosts. Empty when no view state of the repository is saved.
	 */
	private getHiddenHosts(entry: RepoEntry): string[] {
		const repoStates = this.extensionState.getRepos();
		const states = Array.from(entry.repos).map((repo) => repoStates[repo]).filter((state) => typeof state !== 'undefined');
		const names = entry.hosts.map((host) => host.config.name);
		const shown = states.map((state) => getHostFilter(names, state.hideHosts, state.hostChoice).hosts);
		return states.length > 0 ? names.filter((name) => shown.every((hosts) => hosts.indexOf(name) === -1)) : [];
	}

	/**
	 * Start a refresh of each of a repository's hosts that has a valid entry. While the file as a whole is unusable,
	 * none refreshes: their entries are from the last good read, and keep the configError state.
	 * @param entry The repository's entry.
	 * @param skip The names of the hosts not to refresh.
	 */
	private refreshEntry(entry: RepoEntry, skip: ReadonlyArray<string> = []) {
		if (entry.configError !== null) return;
		entry.hosts.forEach((host) => {
			if (host.config.error === null && skip.indexOf(host.config.name) === -1) this.refreshHost(entry, host);
		});
	}

	/**
	 * Refresh one host: read its status, check it's the same project (the first time), fetch its branches if they
	 * moved, and update its state. A refresh never runs twice at once for one host: one asked for while another runs
	 * starts when that one finishes, since the host may have changed after the running one read it. It never rejects.
	 * @param entry The repository's entry.
	 * @param host The host.
	 */
	private async refreshHost(entry: RepoEntry, host: HostEntry): Promise<void> {
		if (this.gitExecutable === null) return;
		if (host.refreshing) {
			host.refreshAgain = true;
			return;
		}
		if (host.state === 'needsAuthentication' && Date.now() < host.retryAfter) {
			// Each failed login counts against this machine: OpenSSH 9.8 and later refuse new connections from an address
			// after repeated failures (PerSourcePenalties), which would also lock out the user's own ssh to fix it
			return;
		}
		host.refreshing = true;
		do {
			host.refreshAgain = false;
			try {
				await this.readHost(entry, host);
			} catch (error) {
				this.logger.logError('Remote hosts: the refresh of "' + host.config.name + '" failed (' + error + ').');
			}
		} while (host.refreshAgain && host.state !== 'needsAuthentication' && !this.isDisposed() && entry.hosts.indexOf(host) > -1);
		host.refreshing = false;
		host.refreshAgain = false;
		if (host.state === 'needsAuthentication') {
			host.authFailures++;
			host.retryAfter = Date.now() + Math.min(AUTH_RETRY_DELAY * Math.pow(2, host.authFailures - 1), AUTH_RETRY_MAX_DELAY);
		} else {
			host.authFailures = 0;
			host.retryAfter = 0;
		}
	}

	/**
	 * The steps of a host's refresh.
	 * @param entry The repository's entry.
	 * @param host The host.
	 */
	private async readHost(entry: RepoEntry, host: HostEntry) {
		const config = host.config;
		const read = await this.readStatus(config, !host.checkedProject);
		if ('failure' in read) {
			this.updateHost(entry, host, read.failure.state, read.failure.message, host.worktrees, false);
			return;
		}
		const status = read.status;

		if (!host.checkedProject) {
			const projectError = await this.checkSameProject(entry, config, status.roots);
			if (projectError !== null) {
				if (projectError.state !== null) this.updateHost(entry, host, projectError.state, projectError.message, [], false);
				return;
			}
			host.checkedProject = true;
		}

		const worktrees = getServerWorktrees(config.name, status.worktrees, status.counts, config.worktrees);
		let consent = this.extensionState.getRemoteHostFetchConsent(entry.main, config.name, config.ssh, config.path);
		if (consent === null && !host.askedConsent) {
			// Show the host while the dialog is open, then ask
			this.updateHost(entry, host, 'needsConsent', getConsentMessage(config), await this.withLocalCommits(entry, host, worktrees), false);
			consent = await this.askConsent(entry, host);
		}
		if (consent !== true) {
			this.updateHost(entry, host, 'needsConsent', getConsentMessage(config), await this.withLocalCommits(entry, host, worktrees), true);
			return;
		}

		const fetched = await this.fetchHost(entry, config, status.tips, worktrees);
		const remoteWorktrees = await this.withLocalCommits(entry, host, worktrees);
		if (fetched.failure !== null) {
			this.updateHost(entry, host, fetched.failure.state, fetched.failure.message, remoteWorktrees, false, fetched.refsChanged);
		} else {
			this.updateHost(entry, host, 'ok', null, remoteWorktrees, true, fetched.refsChanged);
		}
	}

	/**
	 * Run a host's status call: one SSH call, with the status script on stdin.
	 * @param config The host's entry in the config.
	 * @param roots Print the root commits, for the same project check.
	 * @returns The status, or the failure that sets the host's state.
	 */
	private async readStatus(config: RemoteHostConfig, roots: boolean): Promise<{ status: Extract<StatusOutput, { kind: 'ok' }> } | { failure: SshFailure }> {
		const args = getStatusScriptArgs(config.path, getConfig().showUntrackedFiles, config.worktrees, roots);
		const result = await this.runOnHost(config.ssh, STATUS_SCRIPT, args, STATUS_TIMEOUT, false);
		const sshFailure = classifySshFailure(result, config.ssh);
		if (sshFailure !== null) return { failure: sshFailure };

		const where = config.ssh + ':' + config.path;
		const status = parseStatusOutput(result.stdout.toString());
		if (status.kind === 'noGit') {
			return { failure: { state: 'notARepository', message: 'Git isn\'t installed on "' + config.ssh + '", or isn\'t on its PATH for SSH commands.' } };
		} else if (status.kind === 'noPath') {
			return { failure: { state: 'notARepository', message: where + ' doesn\'t exist, or isn\'t a folder Git Tree can enter.' } };
		} else if (status.kind === 'notARepository') {
			return { failure: { state: 'notARepository', message: where + ' isn\'t a Git repository: ' + status.message } };
		} else if (status.kind === 'unreadable' || result.code !== 0 || (roots && status.roots === null)) {
			const stderr = getErrorLines(result.stderr);
			return { failure: { state: 'unreachable', message: 'Git Tree couldn\'t read the status of ' + where + ' (exit code ' + result.code + ')' + (stderr !== '' ? ': ' + stderr : '.') } };
		}
		return { status: status };
	}

	/**
	 * The same project check: the server's root commits must share one with the local repository's.
	 * @param entry The repository's entry.
	 * @param config The host's entry in the config.
	 * @param serverRoots The root commits of the server's branches.
	 * @returns NULL => it's the same project. Otherwise the error, with the host's new state (NULL => it couldn't be checked, so the state stays).
	 */
	private async checkSameProject(entry: RepoEntry, config: RemoteHostConfig, serverRoots: ReadonlyArray<string> | null): Promise<{ state: GitRemoteHostState | null, message: string } | null> {
		const localRoots = await this.runGit(entry.main, ['rev-list', '--max-parents=0', '--exclude=' + HOST_REFS_PREFIX + '*', '--all'], LOCAL_TIMEOUT);
		if (localRoots === null) return { state: null, message: 'Git Tree couldn\'t read the root commits of ' + entry.main + '.' };
		const local = new Set(localRoots.split(/\r?\n/).filter((line) => line !== ''));
		if (serverRoots !== null && serverRoots.some((root) => local.has(root))) return null;
		return {
			state: 'differentRepository',
			message: serverRoots !== null && serverRoots.length === 0
				? 'The repository at ' + config.ssh + ':' + config.path + ' has no commits on any branch yet, so Git Tree can\'t check it\'s this project.'
				: 'The repository at ' + config.ssh + ':' + config.path + ' shares no root commit with this one, so it\'s a different project.'
		};
	}

	/**
	 * Fetch a host's branches into `refs/git-tree/hosts/<name>/heads/`, when they differ from the refs already there,
	 * and the HEAD of each detached worktree into `refs/git-tree/hosts/<name>/detached/`. Detached refs that no worktree
	 * uses any more are deleted.
	 * @param entry The repository's entry.
	 * @param config The host's entry in the config.
	 * @param tips The server's branch tips, from the status call.
	 * @param worktrees The server's worktrees, from the status call.
	 * @returns Whether a ref moved, and the failure of the branch fetch (NULL => none).
	 */
	private async fetchHost(entry: RepoEntry, config: RemoteHostConfig, tips: ReadonlyArray<BranchTip>, worktrees: ReadonlyArray<ServerWorktree>): Promise<{ refsChanged: boolean, failure: SshFailure | null }> {
		const prefix = HOST_REFS_PREFIX + config.name + '/', headsPrefix = getHostBranchesPrefix(config.name), detachedPrefix = prefix + 'detached/';
		const refsOutput = await this.runGit(entry.main, ['for-each-ref', '--format=%(objectname) %(refname)', prefix], LOCAL_TIMEOUT);
		if (refsOutput === null) return { refsChanged: false, failure: { state: 'unreachable', message: 'Git Tree couldn\'t read the refs under ' + prefix + ' in this repository.' } };
		const localRefs = new Map<string, string>();
		refsOutput.split(/\r?\n/).forEach((line) => {
			const space = line.indexOf(' ');
			if (space > -1) localRefs.set(line.substring(space + 1), line.substring(0, space));
		});

		// The branches: fetch only when a tip differs, or a branch was added or deleted
		let refsChanged = false;
		const localHeads = Array.from(localRefs.keys()).filter((ref) => ref.startsWith(headsPrefix));
		if (localHeads.length !== tips.length || tips.some((tip) => localRefs.get(headsPrefix + tip.ref.substring(11)) !== tip.hash)) {
			const failure = await this.fetch(entry.main, config, config.path, '+refs/heads/*:' + headsPrefix + '*', true);
			if (failure !== null) return { refsChanged: false, failure: failure };
			refsChanged = true;
		}

		// The detached worktrees: point their refs at their HEADs, fetching each HEAD that isn't here
		const detachedRefs = new Map<string, string>(), detachedPaths = new Map<string, string>();
		worktrees.forEach((worktree) => {
			if (worktree.worktree.branch !== null || worktree.worktree.head === null) return;
			const ref = getHostDetachedRef(config.name, worktree.worktree.path);
			detachedRefs.set(ref, worktree.worktree.head);
			detachedPaths.set(ref, worktree.worktree.path);
		});
		const stale = Array.from(localRefs.keys()).filter((ref) => ref.startsWith(detachedPrefix) && !detachedRefs.has(ref));
		if (stale.length > 0 && await this.deleteRefs(entry.main, null, stale) === null) refsChanged = true;

		const moved = Array.from(detachedRefs.keys()).filter((ref) => localRefs.get(ref) !== detachedRefs.get(ref));
		if (moved.length > 0) {
			const present = await this.getLocalCommits(entry.main, moved.map((ref) => detachedRefs.get(ref)!));
			for (const ref of moved) {
				const head = detachedRefs.get(ref)!;
				if (present.has(head)) {
					if (await this.runGit(entry.main, ['update-ref', ref, head], LOCAL_TIMEOUT) !== null) refsChanged = true;
				} else if (await this.fetch(entry.main, config, detachedPaths.get(ref)!, '+HEAD:' + ref, false) === null) {
					refsChanged = true;
				}
			}
		}
		return { refsChanged: refsChanged, failure: null };
	}

	/**
	 * Fetch from a repository on a host, over the shared connection.
	 * @param main The path of the local main worktree.
	 * @param config The host's entry in the config.
	 * @param serverPath The path to fetch from on the server (the repository, or a linked worktree for its HEAD).
	 * @param refspec The refspec.
	 * @param prune Delete the refs the server no longer has.
	 * @returns NULL => fetched. Otherwise the failure.
	 */
	private async fetch(main: string, config: RemoteHostConfig, serverPath: string, refspec: string, prune: boolean): Promise<SshFailure | null> {
		if (this.gitExecutable === null) return { state: 'unreachable', message: 'Git Tree has no Git executable.' };
		const args = ['fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--quiet'];
		if (prune) args.push('--prune');
		args.push(config.ssh + ':' + serverPath, refspec);
		this.logger.logCmd('git', args);

		const result = await runProcess(this.gitExecutable.path, args, { cwd: main, env: this.getGitSshEnv(), timeout: LONG_TIMEOUT });
		if (result.code === 0) return null;

		const message = result.timedOut ? 'the fetch timed out.' : result.error !== null ? result.error.message : getErrorLines(result.stderr);
		this.logger.logError('Remote hosts: the fetch from ' + config.ssh + ':' + serverPath + ' failed: ' + message);
		if (!result.timedOut && isAuthenticationError(result.stderr)) {
			return { state: 'needsAuthentication', message: 'SSH needs a password, a passphrase or a host key confirmation for "' + config.ssh + '" to fetch. ' + message };
		}
		return { state: 'unreachable', message: 'Git Tree couldn\'t fetch from ' + config.ssh + ':' + serverPath + ': ' + message };
	}

	/**
	 * Add whether each worktree's HEAD commit is in the local repository.
	 * @param entry The repository's entry.
	 * @param host The host.
	 * @param worktrees The server's worktrees.
	 * @returns The worktrees.
	 */
	private async withLocalCommits(entry: RepoEntry, host: HostEntry, worktrees: ReadonlyArray<ServerWorktree>): Promise<RemoteWorktree[]> {
		const unknown = worktrees.map((worktree) => worktree.worktree.head).filter((head): head is string => head !== null && !host.localCommits.has(head));
		if (unknown.length > 0) (await this.getLocalCommits(entry.main, unknown)).forEach((hash) => host.localCommits.add(hash));
		return worktrees.map((worktree) => ({
			worktree: worktree.worktree,
			uncommittedChanges: worktree.uncommittedChanges,
			commitIsLocal: worktree.worktree.head !== null && host.localCommits.has(worktree.worktree.head)
		}));
	}

	/**
	 * Get which of some commits are in the local repository, with one `git cat-file --batch-check`.
	 * @param main The path of the local main worktree.
	 * @param hashes The commits.
	 * @returns The commits that are there.
	 */
	private async getLocalCommits(main: string, hashes: ReadonlyArray<string>): Promise<Set<string>> {
		const present = new Set<string>();
		if (hashes.length === 0 || this.gitExecutable === null) return present;
		const args = ['cat-file', '--batch-check=%(objectname) %(objecttype)'];
		this.logger.logCmd('git', args);
		const result = await runProcess(this.gitExecutable.path, args, { cwd: main, input: hashes.join('\n') + '\n', timeout: LOCAL_TIMEOUT });
		if (result.code !== 0) return present;
		result.stdout.toString().split(/\r?\n/).forEach((line) => {
			const match = line.match(/^([0-9a-f]+) commit$/);
			if (match !== null) present.add(match[1]);
		});
		return present;
	}

	/**
	 * Delete refs from the local repository, with one `git update-ref --stdin`.
	 * @param main The path of the local main worktree.
	 * @param prefix Also delete every ref under this prefix, or NULL.
	 * @param refs The refs to delete.
	 * @returns The ErrorInfo.
	 */
	private async deleteRefs(main: string, prefix: string | null, refs: ReadonlyArray<string>): Promise<ErrorInfo> {
		let toDelete = refs.slice();
		if (prefix !== null) {
			const output = await this.runGit(main, ['for-each-ref', '--format=%(refname)', prefix], LOCAL_TIMEOUT);
			if (output === null) return 'Git Tree couldn\'t read the refs under ' + prefix + '.';
			toDelete = toDelete.concat(output.split(/\r?\n/).filter((line) => line !== ''));
		}
		if (toDelete.length === 0 || this.gitExecutable === null) return null;

		const args = ['update-ref', '--stdin'];
		this.logger.logCmd('git', args);
		const result = await runProcess(this.gitExecutable.path, args, { cwd: main, input: toDelete.map((ref) => 'delete ' + ref + '\n').join(''), timeout: LOCAL_TIMEOUT });
		return result.code === 0 ? null : 'Git Tree couldn\'t delete the refs under ' + (prefix !== null ? prefix : HOST_REFS_PREFIX) + ': ' + getErrorLines(result.stderr);
	}

	/**
	 * Update a host's state, and fire `onDidChange` if anything the view shows changed. The result for a host that the
	 * config has dropped meanwhile isn't announced.
	 * @param entry The repository's entry.
	 * @param host The host.
	 * @param state The new state.
	 * @param message The new message.
	 * @param worktrees The new worktrees.
	 * @param good The refresh read the host, so it sets the last good refresh time.
	 * @param refsChanged A fetch moved the host's refs, so the graph changed even if the state didn't.
	 */
	private updateHost(entry: RepoEntry, host: HostEntry, state: GitRemoteHostState, message: string | null, worktrees: ReadonlyArray<RemoteWorktree>, good: boolean, refsChanged: boolean = false) {
		if (good) host.lastRefresh = Date.now();
		const changed = this.setHostState(host, state, message, worktrees);
		if ((changed || refsChanged) && entry.hosts.indexOf(host) > -1) this.emitChange(entry);
	}

	/**
	 * Set a host's state and worktrees, and rebuild its snapshot.
	 * @returns TRUE => anything but the last refresh time changed.
	 */
	private setHostState(host: HostEntry, state: GitRemoteHostState, message: string | null, worktrees: ReadonlyArray<RemoteWorktree>) {
		const before = host.snapshot !== null ? getSnapshotKey(host.snapshot) : null;
		host.state = state;
		host.message = message;
		host.worktrees = worktrees;
		host.snapshot = {
			host: { name: host.config.name, ssh: host.config.ssh, path: host.config.path, state: state, message: message, lastRefresh: host.lastRefresh },
			worktrees: worktrees
		};
		return getSnapshotKey(host.snapshot) !== before;
	}

	/**
	 * Fire `onDidChange` with each path a repository was asked for by.
	 * @param entry The repository's entry.
	 */
	private emitChange(entry: RepoEntry) {
		entry.repos.forEach((repo) => this.onDidChangeEmitter.emit(repo));
	}


	/* Fetch consent */

	/**
	 * Ask the user whether Git Tree may fetch from a host, with a modal dialog (one at a time), and remember the answer.
	 * Closing the dialog means "not now": it isn't remembered, and isn't asked again in this session.
	 * @param entry The repository's entry.
	 * @param host The host.
	 * @returns TRUE => the user agreed.
	 */
	private askConsent(entry: RepoEntry, host: HostEntry): Promise<boolean> {
		host.askedConsent = true;
		const config = host.config;
		const ask = () => Promise.resolve(vscode.window.showInformationMessage(
			'Fetch the branches of the remote host "' + config.name + '" (' + config.ssh + ':' + config.path + ') into this repository?',
			{
				modal: true,
				detail: 'Git Tree fetches the server\'s branches, and the commits of its detached worktrees, into refs under ' + HOST_REFS_PREFIX + config.name + '/, so they show in the graph. It writes only those refs and the commits they need. "Remove Remote Host" deletes them.'
			},
			'Fetch', 'Don\'t Fetch'
		)).then(async (answer) => {
			if (typeof answer === 'undefined') return false;
			await this.extensionState.setRemoteHostFetchConsent(entry.main, config.name, config.ssh, config.path, answer === 'Fetch');
			return answer === 'Fetch';
		}, () => false);
		const answer = this.consentQueue.then(ask, ask);
		this.consentQueue = answer;
		return answer;
	}


	/* Running commands */

	/**
	 * Run a fixed script on a host, as `ssh <options> <alias> sh -s -- <quoted arguments>`, with the script on stdin.
	 * @param ssh The host's SSH alias, which its config or the caller has checked.
	 * @param script The script.
	 * @param args The script's arguments.
	 * @param timeout The time limit, in milliseconds.
	 * @param forwardAgent Forward the SSH agent, on a connection of its own. FALSE => the shared connection, which never forwards it.
	 * @returns The result.
	 */
	private runOnHost(ssh: string, script: string, args: ReadonlyArray<string>, timeout: number, forwardAgent: boolean): Promise<ProcessResult> {
		const options = forwardAgent ? getForwardingSshOptions() : getSshOptions(this.getControlDir(), true);
		const sshArgs = options.concat([ssh, 'sh -s -- ' + args.map(quotePosix).join(' ')]);
		this.logger.logCmd('ssh', sshArgs);
		return runProcess(getConfig().remoteHostsSshPath, sshArgs, { input: script, timeout: timeout });
	}

	/**
	 * Get the environment of a local Git command that connects to a host (a fetch or a push): its SSH command is the
	 * shared connection's, and it never prompts.
	 * @returns The environment.
	 */
	private getGitSshEnv() {
		return Object.assign({}, process.env, {
			GIT_SSH_COMMAND: getGitSshCommand(getConfig().remoteHostsSshPath, this.getControlDir()),
			GIT_SSH_VARIANT: 'ssh', // Skip Git's `ssh -G` probe: the options are OpenSSH's
			GIT_TERMINAL_PROMPT: '0'
		});
	}

	/**
	 * Run a local Git command that reads, or writes only Git Tree's own refs.
	 * @param cwd The folder to run it in.
	 * @param args The arguments.
	 * @param timeout The time limit, in milliseconds.
	 * @returns Its output. NULL => it failed (the failure is logged).
	 */
	private async runGit(cwd: string, args: string[], timeout: number): Promise<string | null> {
		if (this.gitExecutable === null) return null;
		this.logger.logCmd('git', args);
		const result = await runProcess(this.gitExecutable.path, args, { cwd: cwd, timeout: timeout });
		if (result.code === 0) return result.stdout.toString();
		this.logger.logError('Remote hosts: git ' + args[0] + ' failed in ' + cwd + ': ' + (result.error !== null ? result.error.message : getErrorLines(result.stderr)));
		return null;
	}

	/**
	 * Finish an action on a host: start a refresh of it, and turn the action's result into an ErrorInfo.
	 * @param entry The repository's entry.
	 * @param host The host.
	 * @param result The result of the action's SSH call.
	 * @param action What the action does, for the message.
	 * @param exitMessages The messages of the script's own exit codes, which the error lines follow.
	 * @returns The ErrorInfo.
	 */
	private finishAction(entry: RepoEntry, host: HostEntry, result: ProcessResult, action: string, exitMessages: { [code: number]: string } = {}): ErrorInfo {
		this.refreshHost(entry, host);
		const sshFailure = classifySshFailure(result, host.config.ssh);
		if (sshFailure !== null) return sshFailure.message;
		if (result.code === 0) return null;
		const message = getErrorLines(result.stderr);
		const known = exitMessages[result.code];
		if (typeof known === 'string') return known + (message !== '' ? ': ' + message : '.');
		return 'Git Tree couldn\'t ' + action + ' on "' + host.config.name + '"' + (message !== '' ? ': ' + message : '.');
	}

	/**
	 * Get the folder of the shared SSH connections' sockets, `/tmp/git-tree-<uid>`, making it with mode 0700. A Unix
	 * socket path is limited to about 104 bytes and `%C` is 40, so the folder must be short. A folder that isn't this
	 * user's own isn't used, since its sockets would carry this user's connections.
	 * @returns The folder. NULL => no connection sharing (Windows, or no safe folder).
	 */
	private getControlDir(): string | null {
		if (typeof this.controlDir !== 'undefined') return this.controlDir;
		if (process.platform === 'win32' || typeof process.getuid !== 'function') {
			this.controlDir = null;
			return null;
		}

		const uid = process.getuid(), dir = '/tmp/git-tree-' + uid;
		try {
			try {
				fs.mkdirSync(dir, { mode: 0o700 });
			} catch (error) {
				if ((<NodeJS.ErrnoException>error).code !== 'EEXIST') throw error;
			}
			const stats = fs.lstatSync(dir);
			if (!stats.isDirectory() || stats.uid !== uid) throw new Error('it isn\'t a folder this user owns');
			if ((stats.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
			this.controlDir = dir;
		} catch (error) {
			this.logger.logError('Remote hosts: Git Tree doesn\'t share SSH connections, because it can\'t use ' + dir + ' (' + (error instanceof Error ? error.message : error) + ').');
			this.controlDir = null;
		}
		return this.controlDir;
	}

	/**
	 * Add `/.worktrees/` to the local repository's `info/exclude`, unless the config file is ignored already, so the file
	 * is never committed by accident.
	 * @param main The path of the local main worktree.
	 * @returns The ErrorInfo.
	 */
	private async excludeConfigFolder(main: string): Promise<ErrorInfo> {
		if (this.gitExecutable === null) return null;
		const folder = path.posix.dirname(CONFIG_FILE);
		const ignored = await runProcess(this.gitExecutable.path, ['check-ignore', '-q', CONFIG_FILE], { cwd: main, timeout: LOCAL_TIMEOUT });
		if (ignored.code === 0) return null;

		const excludeFile = await this.runGit(main, ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], LOCAL_TIMEOUT);
		if (excludeFile === null) return 'The host was added, but Git Tree couldn\'t find info/exclude to add "/' + folder + '/" to.';
		const file = excludeFile.trim();
		const existing = await readTextFile(file);
		const prefix = typeof existing !== 'string' || existing === '' || existing.endsWith('\n') ? '' : '\n';
		return new Promise<ErrorInfo>((resolve) => {
			fs.mkdir(path.dirname(file), { recursive: true }, () => {
				fs.appendFile(file, prefix + '/' + folder + '/\n', (error) => {
					resolve(error === null ? null : 'The host was added, but Git Tree couldn\'t add "/' + folder + '/" to ' + file + ' (' + error.message + ').');
				});
			});
		});
	}
}


/* Server scripts for the actions */

/**
 * Create a worktree: `sh -s -- <repository> <new path> <commit or branch> <new branch, or empty>`. When the new
 * worktree is inside the repository, its top folder is added to `info/exclude` (unless it's ignored already), as Git
 * Tree does for local worktrees. Exit code 7 => the worktree was created, but the exclude file couldn't be written.
 */
const CREATE_WORKTREE_SCRIPT = [
	'cd "$1" || exit 3',
	'if [ -n "$4" ]; then git worktree add -b "$4" -- "$2" "$3"; else git worktree add -- "$2" "$3"; fi || exit 1',
	'case "$2" in',
	'  "$1"/*)',
	'    top=${2#"$1"/}; top=${top%%/*}',
	'    if ! git check-ignore -q -- "$top/" 2>/dev/null; then',
	'      ex=$(git rev-parse --git-path info/exclude) && mkdir -p "$(dirname "$ex")" && { if [ -s "$ex" ] && [ -n "$(tail -c 1 "$ex")" ]; then echo; fi; printf \'/%s/\\n\' "$top"; } >>"$ex" || exit 7',
	'    fi;;',
	'esac',
	''
].join('\n');

/** Remove a worktree: `sh -s -- <repository> <worktree> <force: yes|no>`. */
const REMOVE_WORKTREE_SCRIPT = [
	'cd "$1" || exit 3',
	'if [ "$3" = yes ]; then git worktree remove --force -- "$2"; else git worktree remove -- "$2"; fi',
	''
].join('\n');

/** The Git commands that `runGitOnHost` runs, by action. */
const SERVER_GIT_COMMANDS: { readonly [action: string]: string | undefined } = {
	fetch: 'git fetch --all --prune',
	pull: 'git pull --ff-only',
	push: 'git push'
};

/** Run Git in a worktree: `sh -s -- <worktree> <fetch|pull|push>`, with no terminal prompt. */
const SERVER_GIT_SCRIPT = [
	'cd "$1" || exit 3',
	'export GIT_TERMINAL_PROMPT=0',
	'case "$2" in',
	'  fetch) exec ' + SERVER_GIT_COMMANDS.fetch + ';;',
	'  pull) exec ' + SERVER_GIT_COMMANDS.pull + ';;',
	'  push) exec ' + SERVER_GIT_COMMANDS.push + ';;',
	'esac',
	'exit 2',
	''
].join('\n');

/** The start of a script that makes a repository in a folder: exit code 8 => the folder exists, and isn't empty. */
const EMPTY_FOLDER_CHECK = 'if [ -e "$1" ] || [ -L "$1" ]; then { [ -d "$1" ] && [ -z "$(ls -A "$1")" ]; } || exit 8; fi';

/** Clone a repository: `sh -s -- <new folder> <url>`, with no terminal prompt. */
const CLONE_SCRIPT = [
	EMPTY_FOLDER_CHECK,
	'export GIT_TERMINAL_PROMPT=0',
	'git clone --quiet -- "$2" "$1"',
	''
].join('\n');

/** Make an empty repository whose HEAD is a branch, for a push: `sh -s -- <new folder> <refs/heads/<branch>>`. */
const INIT_SCRIPT = [
	EMPTY_FOLDER_CHECK,
	'git init --quiet -- "$1" && git -C "$1" symbolic-ref HEAD "$2"',
	''
].join('\n');


/* Helpers */

/**
 * Get the message for a repository whose config file Git Tree can't find.
 * @param repo The path of the repository.
 */
function getNoMainWorktreeMessage(repo: string) {
	return 'Git Tree couldn\'t find the main worktree of "' + repo + '", which holds ' + CONFIG_FILE + '.';
}

/**
 * Get the error of a script that makes a repository on a server.
 * @param result The result of its SSH call.
 * @param ssh The SSH alias.
 * @param where The new repository's `<alias>:<path>`.
 * @param action What the script does, for the message.
 * @returns The ErrorInfo.
 */
function getCreateError(result: ProcessResult, ssh: string, where: string, action: string): ErrorInfo {
	const sshFailure = classifySshFailure(result, ssh);
	if (sshFailure !== null) return sshFailure.message;
	if (result.code === 0) return null;
	if (result.code === 8) return where + ' already exists, and isn\'t an empty folder. Choose a new folder, or add the repository that\'s there.';
	const message = getErrorLines(result.stderr);
	return 'Git Tree couldn\'t ' + action + ' ' + where + (message !== '' ? ': ' + message : '.');
}

/**
 * Check whether a remote's URL is a path on this machine, as Git reads it: not `<scheme>://`, and not `[user@]host:path`
 * (a `:` before any `/`), or a `file://` URL.
 * @param url The URL.
 */
function isLocalPathUrl(url: string) {
	if (/^file:\/\//i.test(url) || /^[A-Za-z]:[\\/]/.test(url)) return true;
	if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url)) return false;
	const colon = url.indexOf(':'), slash = url.indexOf('/');
	return colon === -1 || (slash > -1 && slash < colon);
}

/**
 * Get the message of a host that waits for the fetch consent.
 * @param config The host's entry in the config.
 */
function getConsentMessage(config: RemoteHostConfig) {
	return 'Git Tree hasn\'t fetched the branches of "' + config.name + '", because it needs your consent first.';
}

/**
 * Get what the view shows of a host, as a string, to tell whether it changed. The last refresh time is left out: it
 * changes on every refresh, and only shows with a host that isn't `ok`.
 * @param snapshot The host's snapshot.
 */
function getSnapshotKey(snapshot: RemoteHostSnapshot) {
	return JSON.stringify([snapshot.host.name, snapshot.host.ssh, snapshot.host.path, snapshot.host.state, snapshot.host.message, snapshot.worktrees]);
}

/**
 * Get what the view shows of a repository's hosts, as a string.
 * @param entry The repository's entry.
 */
function getSnapshotsKey(entry: RepoEntry) {
	return JSON.stringify([entry.configError, entry.hosts.map((host) => host.snapshot !== null ? getSnapshotKey(host.snapshot) : null)]);
}

/**
 * Remove the trailing slashes of a path on a server (but not of `/`).
 * @param serverPath The path.
 */
function trimTrailingSlashes(serverPath: string) {
	const trimmed = serverPath.replace(/\/+$/, '');
	return trimmed !== '' ? trimmed : '/';
}

/**
 * Read a text file.
 * @param file The path of the file.
 * @returns Its contents. NULL => it doesn't exist. An Error => it couldn't be read.
 */
function readTextFile(file: string): Promise<string | null | Error> {
	return new Promise((resolve) => {
		fs.readFile(file, 'utf8', (error, text) => resolve(error === null ? text : error.code === 'ENOENT' ? null : error));
	});
}

/**
 * Write a text file, making its folder if needed. It writes a temporary file and renames it, so a reader never sees
 * half a file.
 * @param file The path of the file.
 * @param text The contents.
 * @returns The ErrorInfo.
 */
function writeTextFile(file: string, text: string): Promise<ErrorInfo> {
	return new Promise((resolve) => {
		const temporary = file + '.' + process.pid + '.tmp';
		fs.mkdir(path.dirname(file), { recursive: true }, () => {
			fs.writeFile(temporary, text, 'utf8', (writeError) => {
				if (writeError !== null) return resolve('Git Tree couldn\'t write ' + file + ' (' + writeError.message + ').');
				fs.rename(temporary, file, (renameError) => {
					if (renameError === null) return resolve(null);
					fs.unlink(temporary, () => resolve('Git Tree couldn\'t write ' + file + ' (' + renameError.message + ').'));
				});
			});
		});
	});
}
