import * as vscode from './mocks/vscode';
jest.mock('vscode', () => Object.assign({}, vscode, {
	extensions: { getExtension: jest.fn() },
	RelativePattern: class {
		constructor(public readonly baseUri: unknown, public readonly pattern: string) { }
	}
}), { virtual: true });
jest.mock('../src/logger');
jest.mock('../src/remoteHosts/ssh', () => Object.assign({}, jest.requireActual('../src/remoteHosts/ssh'), { runProcess: jest.fn() }));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_REPO_STATE, ExtensionState } from '../src/extensionState';
import { Logger } from '../src/logger';
import { RemoteHosts, getHostBranchesPrefix, getHostDetachedRef, resolveServerWorktreePath } from '../src/remoteHosts';
import { AGENT_INSTRUCTION } from '../src/remoteHosts/agentInstruction';
import { BROWSE_SCRIPT } from '../src/remoteHosts/browse';
import { CONFIG_FILE } from '../src/remoteHosts/config';
import { ProcessOptions, ProcessResult, runProcess } from '../src/remoteHosts/ssh';
import { STATUS_SCRIPT } from '../src/remoteHosts/status';
import { RemoteHostEntry, RemoteHostGitAction } from '../src/types';
import { GitExecutable } from '../src/utils';
import { EventEmitter } from '../src/utils/event';

/*
 * RemoteHosts with `ssh` and Git mocked: runProcess answers from a simulated server per SSH alias, and a simulated local
 * repository (its refs and commits). The config file is real, in a temporary main worktree.
 */

const GIT = '/path/to/git';
const MAIN_HASH = 'a'.repeat(40), TOPIC_HASH = 'b'.repeat(40), DETACHED_HASH = 'c'.repeat(40), NEW_HASH = 'd'.repeat(40), ROOT = '1'.repeat(40);
const mockedRunProcess = <jest.MockedFunction<typeof runProcess>><unknown>runProcess;
const extensions = <{ getExtension: jest.Mock }><unknown>(<any>jest.requireMock('vscode')).extensions;

interface ServerWorktree { path: string, head: string, branch: string | null, count: number | null }
interface Server {
	path: string;
	branches: { [name: string]: string };
	roots: string[];
	worktrees: ServerWorktree[];
	answer: Partial<ProcessResult> | null; // Answers every call to the server instead of the simulation (a failure)
	fetchAnswer: Partial<ProcessResult> | null; // Answers every fetch from the server instead of the simulation
	onScript: ((script: string, args: string[]) => Partial<ProcessResult>) | null; // Answers a script that isn't the status script. NULL => success.
}

interface Call { readonly file: string, readonly args: ReadonlyArray<string>, readonly options: ProcessOptions }

let tmp: string, main: string;
let servers: { [alias: string]: Server };
let localRefs: Map<string, string>, localCommits: Set<string>, localRoots: string[], configTracked: boolean;
let localRemotes: { [name: string]: string }, localHead: string | null, pushAnswer: Partial<ProcessResult>;
let calls: Call[];
let globalState: Map<string, any>;
let logger: Logger, onDidChangeGitExecutable: EventEmitter<GitExecutable>, extensionState: ExtensionState, remoteHosts: RemoteHosts;
let changes: string[];

beforeAll(() => {
	logger = new Logger();
	onDidChangeGitExecutable = new EventEmitter<GitExecutable>();
});

afterAll(() => {
	onDidChangeGitExecutable.dispose();
	logger.dispose();
});

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-tree-remote-hosts-')));
	main = tmp.replace(/\\/g, '/') + '/repo';
	fs.mkdirSync(main + '/.worktrees', { recursive: true });

	servers = { 'box': server('/srv/app') };
	localRefs = new Map();
	localCommits = new Set([MAIN_HASH, ROOT]);
	localRoots = [ROOT];
	configTracked = false;
	localRemotes = { origin: 'git@github.com:user/app.git' };
	localHead = 'refs/heads/main';
	pushAnswer = {};
	calls = [];
	mockedRunProcess.mockImplementation((file, args, options) => Promise.resolve(simulate(file, args, options)));

	globalState = new Map();
	vscode.mocks.extensionContext.globalState.get.mockImplementation((key: string, defaultValue: any) => globalState.has(key) ? JSON.parse(JSON.stringify(globalState.get(key))) : defaultValue);
	vscode.mocks.extensionContext.globalState.update.mockImplementation((key: string, value: any) => {
		globalState.set(key, value);
		return Promise.resolve();
	});
	vscode.window.showInformationMessage.mockResolvedValue(<never>'Fetch');
	extensions.getExtension.mockReturnValue({ id: 'ms-vscode-remote.remote-ssh' });

	extensionState = new ExtensionState(vscode.mocks.extensionContext, onDidChangeGitExecutable.subscribe);
	writeConfig('  box:', '    ssh: box', '    path: /srv/app');
	remoteHosts = new RemoteHosts(extensionState, { path: GIT, version: '2.54.0' }, onDidChangeGitExecutable.subscribe, logger);
	changes = [];
	remoteHosts.onDidChange((repo) => changes.push(repo));
});

afterEach(() => {
	remoteHosts.dispose();
	extensionState.dispose();
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe('RemoteHosts', () => {
	describe('Config', () => {
		it('Should return no hosts until the config is read, and then fire onDidChange', async () => {
			// Run
			const before = remoteHosts.getHosts(main);
			await settle();

			// Assert
			expect(before).toStrictEqual([]);
			expect(changes).toStrictEqual([main]);
			expect(remoteHosts.getHosts(main)).toStrictEqual([{ host: { name: 'box', ssh: 'box', path: '/srv/app', state: 'loading', message: null, lastRefresh: null }, worktrees: [] }]);
			expect(remoteHosts.getConfigFile(main)).toBe(main + '/' + CONFIG_FILE);
			expect(calls.filter((call) => call.file === 'ssh')).toStrictEqual([]); // Reading the hosts never calls a server
		});

		it('Should warn once when Git tracks the config file', async () => {
			// Setup
			configTracked = true;

			// Run
			await remoteHosts.loadHosts(main);
			await settle();
			await remoteHosts.loadHosts(main);
			await settle();

			// Assert
			expect(gitCalls('ls-files')).toStrictEqual([['ls-files', '--', CONFIG_FILE]]);
			expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
			expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('Git tracks ' + CONFIG_FILE + ' in ' + main + ', so a commit would share your SSH hosts and their paths. Remove it from Git with: git rm --cached ' + CONFIG_FILE);
		});

		it('Should not warn when Git doesn\'t track the config file', async () => {
			// Run
			await remoteHosts.loadHosts(main);
			await settle();

			// Assert
			expect(gitCalls('ls-files')).toHaveLength(1);
			expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
		});

		it('Should find the main worktree from a linked worktree, with git rev-parse --git-common-dir, once', async () => {
			// Run
			await remoteHosts.loadHosts(tmp + '/linked');
			await remoteHosts.loadHosts(tmp + '/linked');

			// Assert
			expect(gitCalls('rev-parse')).toStrictEqual([['rev-parse', '--path-format=absolute', '--git-common-dir']]);
			expect(calls[0].options.cwd).toBe(tmp + '/linked');
			expect(remoteHosts.getConfigFile(tmp + '/linked')).toBe(main + '/' + CONFIG_FILE);
		});

		it('Should have no hosts without a config file', async () => {
			// Setup
			fs.unlinkSync(main + '/' + CONFIG_FILE);

			// Run
			const hosts = await remoteHosts.loadHosts(main);

			// Assert
			expect(hosts).toStrictEqual([]);
			expect(remoteHosts.getConfigError(main)).toBeNull();
			expect(changes).toStrictEqual([]);
		});

		it('Should give an invalid entry the configError state, and never call its server', async () => {
			// Setup
			writeConfig('  box:', '    ssh: box', '    path: srv/app');

			// Run
			await refresh();

			// Assert
			expect(remoteHosts.getHosts(main).map((host) => host.host)).toStrictEqual([{ name: 'box', ssh: 'box', path: '', state: 'configError', message: 'Line 5: The path "srv/app" must be absolute (start with /).', lastRefresh: null }]);
			expect(calls.filter((call) => call.file === 'ssh')).toStrictEqual([]);
		});

		it('Should give one error for a file that can\'t be read, and keep the old hosts\' rows with configError', async () => {
			// Setup
			await refresh();
			const worktrees = remoteHosts.getHosts(main)[0].worktrees;
			writeConfig('  box: [');

			// Run
			await refresh();

			// Assert
			expect(remoteHosts.getConfigError(main)).toMatch(/^Line 4: /);
			expect(remoteHosts.getHosts(main)).toStrictEqual([{ host: expect.objectContaining({ name: 'box', state: 'configError', message: remoteHosts.getConfigError(main) }), worktrees: worktrees }]);

			// Run
			writeConfig('  box:', '    ssh: box', '    path: /srv/app');
			await refresh();

			// Assert
			expect(remoteHosts.getConfigError(main)).toBeNull();
			expect(remoteHosts.getHosts(main)[0].host.state).toBe('ok');
		});

		it('Should reload the file when its watcher fires', async () => {
			// Setup
			await remoteHosts.loadHosts(main);
			const watcher = (<jest.Mock>vscode.workspace.createFileSystemWatcher).mock.results[0].value;
			expect((<jest.Mock>vscode.workspace.createFileSystemWatcher).mock.calls[0][0]).toStrictEqual(expect.objectContaining({ pattern: 'git-tree.yaml' }));
			writeConfig('  box:', '    ssh: box', '    path: /srv/app', '  other:', '    ssh: other', '    path: /srv/other');
			servers['other'] = server('/srv/other');

			// Run
			watcher.onDidChange.mock.calls[0][0]();
			await new Promise((resolve) => setTimeout(resolve, 300));
			await settle();

			// Assert
			expect(remoteHosts.getHosts(main).map((host) => [host.host.name, host.host.state])).toStrictEqual([['box', 'ok'], ['other', 'ok']]);
		});

		it('Should keep a host\'s state when the file changes but its alias and path don\'t, and start again when they do', async () => {
			// Setup
			await refresh();

			// Run
			writeConfig('  box:', '    ssh: box', '    path: /srv/app', '    worktrees: false');
			await remoteHosts.loadHosts(main);

			// Assert
			expect(remoteHosts.getHosts(main)[0].host.state).toBe('ok');

			// Run
			servers['box'].path = '/srv/moved';
			writeConfig('  box:', '    ssh: box', '    path: /srv/moved');
			await remoteHosts.loadHosts(main);

			// Assert
			expect(remoteHosts.getHosts(main)[0]).toStrictEqual({ host: { name: 'box', ssh: 'box', path: '/srv/moved', state: 'loading', message: null, lastRefresh: null }, worktrees: [] });

			// Run
			await refresh();

			// Assert: a new path is checked again, and asks for consent again
			expect(sshCalls().map((call) => statusArgs(call)[3])).toStrictEqual(['yes', 'yes']);
			expect(gitCalls('rev-list')).toHaveLength(2);
			expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(2);
		});
	});

	describe('Status', () => {
		it('Should read the worktrees with one SSH call, and fetch the branches', async () => {
			// Run
			await refresh();

			// Assert
			expect(sshCalls()).toHaveLength(1);
			const call = sshCalls()[0];
			expect(call.args).toStrictEqual(['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ForwardAgent=no', '-o', 'ControlMaster=auto', '-o', 'ControlPersist=120', '-o', 'ControlPath=/tmp/git-tree-' + process.getuid!() + '/%C', 'box', 'sh -s -- \'/srv/app\' \'all\' \'yes\' \'yes\'']);
			expect(call.options.input).toBe(STATUS_SCRIPT);
			expect(call.options.timeout).toBe(15000);

			const box = remoteHosts.getHosts(main)[0];
			expect(box.host).toStrictEqual({ name: 'box', ssh: 'box', path: '/srv/app', state: 'ok', message: null, lastRefresh: expect.any(Number) });
			expect(box.worktrees).toStrictEqual([
				{ worktree: { path: '/srv/app', name: 'app', head: MAIN_HASH, branch: 'main', isMain: true, isCurrent: false, locked: false, prunable: false, host: 'box' }, uncommittedChanges: 2, commitIsLocal: true },
				{ worktree: { path: '/srv/app wt', name: 'app wt', head: DETACHED_HASH, branch: null, isMain: false, isCurrent: false, locked: false, prunable: false, host: 'box' }, uncommittedChanges: null, commitIsLocal: true }
			]);
			expect(Array.from(localRefs.entries()).sort()).toStrictEqual([
				[getHostDetachedRef('box', '/srv/app wt'), DETACHED_HASH],
				[getHostBranchesPrefix('box') + 'main', MAIN_HASH],
				[getHostBranchesPrefix('box') + 'topic', TOPIC_HASH]
			]);
			expect(changes.length).toBeGreaterThan(0);
		});

		it('Should quote a path with quotes, spaces, $ and backslashes as one argument', async () => {
			// Setup
			const odd = '/srv/it\'s a $HOME \\ "path"';
			servers['box'].path = odd;
			writeConfig('  box:', '    ssh: box', '    path: \'/srv/it\'\'s a $HOME \\ "path"\'');

			// Run
			await refresh();

			// Assert
			expect(sshCalls()[0].args[sshCalls()[0].args.length - 1]).toBe('sh -s -- \'/srv/it\'\\\'\'s a $HOME \\ "path"\' \'all\' \'yes\' \'yes\'');
			expect(remoteHosts.getHosts(main)[0].host.state).toBe('ok');
			expect(gitCalls('fetch')[0]).toContain('box:' + odd);
		});

		it('Should count untracked files only with showUntrackedFiles, and read only the main worktree with "worktrees: false"', async () => {
			// Setup
			vscode.mockExtensionSettingReturnValue('repository.showUntrackedFiles', false);
			writeConfig('  box:', '    ssh: box', '    path: /srv/app', '    worktrees: false');

			// Run
			await refresh();

			// Assert
			expect(statusArgs(sshCalls()[0])).toStrictEqual(['/srv/app', 'no', 'no', 'yes']);
			expect(remoteHosts.getHosts(main)[0].worktrees.map((worktree) => worktree.worktree.path)).toStrictEqual(['/srv/app']);
		});

		it('Should use the ssh in the git-tree.remoteHosts.sshPath setting', async () => {
			// Setup
			vscode.mockExtensionSettingReturnValue('remoteHosts.sshPath', '/opt/ssh wrapper');

			// Run
			await refresh();

			// Assert
			expect(calls.filter((call) => call.file === '/opt/ssh wrapper')).toHaveLength(1);
			expect(gitCalls('fetch')).toHaveLength(2);
			const fetch = calls.find((call) => call.args[0] === 'fetch')!;
			expect(fetch.options.env!.GIT_SSH_COMMAND).toBe('\'/opt/ssh wrapper\' \'-o\' \'BatchMode=yes\' \'-o\' \'ConnectTimeout=10\' \'-o\' \'ForwardAgent=no\' \'-o\' \'ControlMaster=auto\' \'-o\' \'ControlPersist=120\' \'-o\' \'ControlPath=/tmp/git-tree-' + process.getuid!() + '/%C\'');
			expect(fetch.options.env!.GIT_SSH_VARIANT).toBe('ssh');
		});

		it('Should make the connection sharing folder with mode 0700', async () => {
			// Run
			await refresh();

			// Assert
			const stats = fs.lstatSync('/tmp/git-tree-' + process.getuid!());
			expect(stats.isDirectory()).toBe(true);
			expect(stats.mode & 0o777).toBe(0o700);
		});

		it('Should never refresh a host twice at once, and refresh once more after a refresh asked for meanwhile', async () => {
			// Setup
			await remoteHosts.loadHosts(main);
			let running = 0, most = 0;
			mockedRunProcess.mockImplementation(async (file, args, options) => {
				if (file !== 'ssh') return simulate(file, args, options);
				running++;
				most = Math.max(most, running);
				await new Promise((resolve) => setTimeout(resolve, 20));
				running--;
				return simulate(file, args, options);
			});

			// Run
			remoteHosts.refresh(main);
			remoteHosts.refresh(main);
			remoteHosts.refresh(main);
			await settle();

			// Assert
			expect(most).toBe(1);
			expect(sshCalls()).toHaveLength(2);
		});

		it('Should fire onDidChange only when something changed', async () => {
			// Setup
			await refresh();
			changes = [];

			// Run
			await refresh();

			// Assert
			expect(changes).toStrictEqual([]);

			// Run
			servers['box'].worktrees[0].count = 5;
			await refresh();

			// Assert
			expect(changes).toStrictEqual([main]);
			expect(remoteHosts.getHosts(main)[0].worktrees[0].uncommittedChanges).toBe(5);
		});

		it('Should fire onDidChange with each path the repository was asked for by', async () => {
			// Setup
			await remoteHosts.loadHosts(main);
			await remoteHosts.loadHosts(tmp + '/linked');
			changes = [];

			// Run
			await refresh();

			// Assert
			expect(changes).toContain(main);
			expect(changes).toContain(tmp + '/linked');
		});
	});

	describe('Failure states', () => {
		async function refreshWithAnswer(answer: Partial<ProcessResult>) {
			await refresh();
			const good = remoteHosts.getHosts(main)[0];
			servers['box'].answer = answer;
			await refresh();
			return { good: good, now: remoteHosts.getHosts(main)[0] };
		}

		it('Should show unreachable when ssh can\'t connect, keeping the old worktrees and the last good refresh time', async () => {
			// Run
			const { good, now } = await refreshWithAnswer({ code: 255, stderr: 'ssh: connect to host box port 22: Connection refused\r\n' });

			// Assert
			expect(now.host).toStrictEqual(Object.assign({}, good.host, { state: 'unreachable', message: 'Git Tree couldn\'t connect to "box". ssh: connect to host box port 22: Connection refused' }));
			expect(now.worktrees).toStrictEqual(good.worktrees);
		});

		it('Should show unreachable when ssh times out', async () => {
			// Run
			const { now } = await refreshWithAnswer({ code: -1, timedOut: true });

			// Assert
			expect(now.host.state).toBe('unreachable');
			expect(now.host.message).toBe('The connection to "box" timed out.');
		});

		it('Should show unreachable when ssh can\'t run', async () => {
			// Run
			const { now } = await refreshWithAnswer({ code: -1, error: new Error('spawn ssh ENOENT') });

			// Assert
			expect(now.host.state).toBe('unreachable');
			expect(now.host.message).toMatch(/^Git Tree couldn't run ssh \(spawn ssh ENOENT\)/);
		});

		it('Should show needsAuthentication when the server refuses the key', async () => {
			// Run
			const { now } = await refreshWithAnswer({ code: 255, stderr: 'dev@box: Permission denied (publickey).\n' });

			// Assert
			expect(now.host.state).toBe('needsAuthentication');
			expect(now.host.message).toMatch(/Permission denied \(publickey\)\.$/);
		});

		it('Should leave a host that needs authentication alone for a while, doubling the wait after each failure', async () => {
			// Setup
			const spyOnNow = jest.spyOn(Date, 'now');
			let time = 1000000;
			spyOnNow.mockImplementation(() => time);
			try {
				await refreshWithAnswer({ code: 255, stderr: 'dev@box: Permission denied (publickey).\n' });
				const calls = sshCalls().length;

				// Run: within 30 seconds, no new SSH call
				time += 29000;
				await refresh();

				// Assert
				expect(sshCalls()).toHaveLength(calls);

				// Run: after 30 seconds it tries again, fails, and then waits 60 seconds
				time += 2000;
				await refresh();
				time += 59000;
				await refresh();

				// Assert
				expect(sshCalls()).toHaveLength(calls + 1);

				// Run: once the key works, a good read resets the wait
				time += 2000;
				servers['box'].answer = null;
				await refresh();
				servers['box'].answer = { code: 255, stderr: 'dev@box: Permission denied (publickey).\n' };
				await refresh();
				time += 31000;
				await refresh();

				// Assert
				expect(sshCalls()).toHaveLength(calls + 4);
				expect(remoteHosts.getHosts(main)[0].host.state).toBe('needsAuthentication');
			} finally {
				spyOnNow.mockRestore();
			}
		});

		it('Should show needsAuthentication when the host key isn\'t known', async () => {
			// Run
			const { now } = await refreshWithAnswer({ code: 255, stderr: 'Host key verification failed.\n' });

			// Assert
			expect(now.host.state).toBe('needsAuthentication');
		});

		it('Should show notARepository when the path doesn\'t exist', async () => {
			// Run
			const { now } = await refreshWithAnswer({ code: 3, stdout: Buffer.from('gt:nopath\n') });

			// Assert
			expect(now.host.state).toBe('notARepository');
			expect(now.host.message).toBe('box:/srv/app doesn\'t exist, or isn\'t a folder Git Tree can enter.');
		});

		it('Should show notARepository with Git\'s message', async () => {
			// Run
			const { now } = await refreshWithAnswer({ code: 4, stdout: Buffer.from('gt:norepo\nfatal: not a git repository (or any of the parent directories): .git\n') });

			// Assert
			expect(now.host.state).toBe('notARepository');
			expect(now.host.message).toBe('box:/srv/app isn\'t a Git repository: fatal: not a git repository (or any of the parent directories): .git');
		});

		it('Should show notARepository when Git isn\'t installed on the server', async () => {
			// Run
			const { now } = await refreshWithAnswer({ code: 5, stdout: Buffer.from('gt:nogit\n') });

			// Assert
			expect(now.host.state).toBe('notARepository');
			expect(now.host.message).toBe('Git isn\'t installed on "box", or isn\'t on its PATH for SSH commands.');
		});

		it('Should not trust an answer it can\'t read', async () => {
			// Run
			const { now } = await refreshWithAnswer({ code: 0, stdout: Buffer.from('gt:tips\n' + MAIN_HASH + ' refs/heads/main\n') });

			// Assert
			expect(now.host.state).toBe('unreachable');
			expect(now.host.message).toBe('Git Tree couldn\'t read the status of box:/srv/app (exit code 0).');
		});

		it('Should not trust an answer whose script failed', async () => {
			// Run
			const { now } = await refreshWithAnswer({ code: 6, stdout: Buffer.from('gt:tips\ngt:worktrees\nworktree /srv/app\n\ngt:status\ngt:end\n'), stderr: 'fatal: bad object\n' });

			// Assert
			expect(now.host.state).toBe('unreachable');
			expect(now.host.message).toBe('Git Tree couldn\'t read the status of box:/srv/app (exit code 6): fatal: bad object');
		});

		it('Should show differentRepository when the server shares no root commit, and not show its worktrees', async () => {
			// Setup
			servers['box'].roots = ['9'.repeat(40)];

			// Run
			await refresh();

			// Assert
			expect(remoteHosts.getHosts(main)[0]).toStrictEqual({
				host: { name: 'box', ssh: 'box', path: '/srv/app', state: 'differentRepository', message: 'The repository at box:/srv/app shares no root commit with this one, so it\'s a different project.', lastRefresh: null },
				worktrees: []
			});
			expect(gitCalls('fetch')).toStrictEqual([]);
			expect(gitCalls('rev-list')).toStrictEqual([['rev-list', '--max-parents=0', '--exclude=refs/git-tree/hosts/*', '--all']]);
		});

		it('Should show differentRepository when the server has no commits', async () => {
			// Setup
			servers['box'].roots = [];
			servers['box'].branches = {};

			// Run
			await refresh();

			// Assert
			expect(remoteHosts.getHosts(main)[0].host.state).toBe('differentRepository');
			expect(remoteHosts.getHosts(main)[0].host.message).toMatch(/has no commits on any branch yet/);
		});

		it('Should check the project only on the first refresh', async () => {
			// Run
			await refresh();
			await refresh();

			// Assert
			expect(sshCalls().map((call) => statusArgs(call)[3])).toStrictEqual(['yes', 'no']);
			expect(gitCalls('rev-list')).toHaveLength(1);
		});

		it('Should show unreachable when the fetch fails, and needsAuthentication when it\'s refused', async () => {
			// Setup
			servers['box'].fetchAnswer = { code: 128, stderr: 'ssh: connect to host box port 22: Connection refused\nfatal: Could not read from remote repository.\n' };

			// Run
			await refresh();

			// Assert
			expect(remoteHosts.getHosts(main)[0].host.state).toBe('unreachable');
			expect(remoteHosts.getHosts(main)[0].host.message).toMatch(/^Git Tree couldn't fetch from box:\/srv\/app: ssh: connect to host box/);
			expect(remoteHosts.getHosts(main)[0].host.lastRefresh).toBeNull();

			// Run
			servers['box'].fetchAnswer = { code: 128, stderr: 'dev@box: Permission denied (publickey).\nfatal: Could not read from remote repository.\n' };
			await refresh();

			// Assert
			expect(remoteHosts.getHosts(main)[0].host.state).toBe('needsAuthentication');
		});
	});

	describe('Fetch', () => {
		it('Should not fetch when the branch tips match the refs already here', async () => {
			// Setup
			await refresh();
			calls = [];

			// Run
			await refresh();

			// Assert
			expect(gitCalls('fetch')).toStrictEqual([]);
			expect(gitCalls('cat-file')).toStrictEqual([]);
			expect(gitCalls('update-ref')).toStrictEqual([]);
			expect(gitCalls('for-each-ref')).toHaveLength(1);
		});

		it('Should fetch with --prune when a tip moved, or a branch was added or deleted', async () => {
			// Setup
			await refresh();

			// Run
			servers['box'].branches['main'] = NEW_HASH;
			calls = [];
			await refresh();

			// Assert
			expect(gitCalls('fetch')).toStrictEqual([['fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--quiet', '--prune', 'box:/srv/app', '+refs/heads/*:refs/git-tree/hosts/box/heads/*']]);
			expect(calls.find((call) => call.args[0] === 'fetch')!.options.cwd).toBe(main);
			expect(localRefs.get(getHostBranchesPrefix('box') + 'main')).toBe(NEW_HASH);

			// Run
			servers['box'].branches['added'] = NEW_HASH;
			calls = [];
			await refresh();

			// Assert
			expect(gitCalls('fetch')).toHaveLength(1);

			// Run
			delete servers['box'].branches['topic'];
			calls = [];
			await refresh();

			// Assert
			expect(gitCalls('fetch')).toHaveLength(1);
			expect(localRefs.has(getHostBranchesPrefix('box') + 'topic')).toBe(false);
		});

		it('Should point a detached worktree\'s ref at a commit that\'s already here, without fetching', async () => {
			// Setup
			localCommits.add(DETACHED_HASH);

			// Run
			await refresh();

			// Assert
			expect(gitCalls('fetch')).toHaveLength(1); // Only the branches
			expect(gitCalls('update-ref')).toStrictEqual([['update-ref', getHostDetachedRef('box', '/srv/app wt'), DETACHED_HASH]]);
		});

		it('Should fetch the HEAD of a detached worktree from its own path', async () => {
			// Run
			await refresh();

			// Assert
			expect(gitCalls('fetch')[1]).toStrictEqual(['fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--quiet', 'box:/srv/app wt', '+HEAD:' + getHostDetachedRef('box', '/srv/app wt')]);
			expect(getHostDetachedRef('box', '/srv/app wt')).toMatch(/^refs\/git-tree\/hosts\/box\/detached\/[0-9a-f]{12}$/);
		});

		it('Should say a commit isn\'t on this machine when its fetch fails', async () => {
			// Setup
			mockedRunProcess.mockImplementation((file, args, options) => Promise.resolve(args[0] === 'fetch' && args.indexOf('box:/srv/app wt') > -1
				? result({ code: 128, stderr: 'fatal: couldn\'t find remote ref HEAD' })
				: simulate(file, args, options)));

			// Run
			await refresh();

			// Assert
			const box = remoteHosts.getHosts(main)[0];
			expect(box.host.state).toBe('ok');
			expect(box.worktrees[1].commitIsLocal).toBe(false);
		});

		it('Should delete the refs of detached worktrees that are gone', async () => {
			// Setup
			await refresh();
			servers['box'].worktrees.pop();

			// Run
			await refresh();

			// Assert
			const deletion = calls.find((call) => call.args[0] === 'update-ref' && call.args[1] === '--stdin')!;
			expect(deletion.options.input).toBe('delete ' + getHostDetachedRef('box', '/srv/app wt') + '\n');
			expect(localRefs.has(getHostDetachedRef('box', '/srv/app wt'))).toBe(false);
		});
	});

	describe('Consent', () => {
		it('Should ask before the first fetch from a host, and remember the answer', async () => {
			// Run
			await refresh();
			await refresh();

			// Assert
			expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
			expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Fetch the branches of the remote host "box" (box:/srv/app) into this repository?', expect.objectContaining({ modal: true }), 'Fetch', 'Don\'t Fetch');
			expect(extensionState.getRemoteHostFetchConsent(main, 'box', 'box', '/srv/app')).toBe(true);
			expect(globalState.get('remoteHostFetchConsent')).toStrictEqual({ [main]: { box: { ssh: 'box', path: '/srv/app', consent: true } } });
		});

		it('Should show needsConsent, and not fetch, when the user declines, and not ask again', async () => {
			// Setup
			vscode.window.showInformationMessage.mockResolvedValue(<never>'Don\'t Fetch');

			// Run
			await refresh();
			await refresh();

			// Assert
			const box = remoteHosts.getHosts(main)[0];
			expect(box.host.state).toBe('needsConsent');
			expect(box.host.message).toBe('Git Tree hasn\'t fetched the branches of "box", because it needs your consent first.');
			expect(box.host.lastRefresh).not.toBeNull();
			expect(box.worktrees.map((worktree) => worktree.commitIsLocal)).toStrictEqual([true, false]);
			expect(gitCalls('fetch')).toStrictEqual([]);
			expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
			expect(extensionState.getRemoteHostFetchConsent(main, 'box', 'box', '/srv/app')).toBe(false);
		});

		it('Should not remember a closed dialog, nor ask again in the same session', async () => {
			// Setup
			vscode.window.showInformationMessage.mockResolvedValue(<never>undefined);

			// Run
			await refresh();
			await refresh();

			// Assert
			expect(remoteHosts.getHosts(main)[0].host.state).toBe('needsConsent');
			expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
			expect(extensionState.getRemoteHostFetchConsent(main, 'box', 'box', '/srv/app')).toBeNull();
		});

		it('Should fetch after the user agrees from the host\'s action', async () => {
			// Setup
			vscode.window.showInformationMessage.mockResolvedValueOnce(<never>'Don\'t Fetch');
			await refresh();

			// Run
			await remoteHosts.askFetchConsent(main, 'box');
			await settle();

			// Assert
			expect(remoteHosts.getHosts(main)[0].host.state).toBe('ok');
			expect(gitCalls('fetch').length).toBeGreaterThan(0);
		});

		it('Should ask again when the host\'s alias or path changed', () => {
			// Setup
			extensionState.setRemoteHostFetchConsent(main, 'box', 'box', '/srv/old', true);

			// Assert
			expect(extensionState.getRemoteHostFetchConsent(main, 'box', 'box', '/srv/app')).toBeNull();
			expect(extensionState.getRemoteHostFetchConsent(main, 'box', 'other', '/srv/old')).toBeNull();
			expect(extensionState.getRemoteHostFetchConsent(main, 'box', 'box', '/srv/old')).toBe(true);
		});

		it('Should ask one question at a time', async () => {
			// Setup
			servers['other'] = server('/srv/other');
			writeConfig('  box:', '    ssh: box', '    path: /srv/app', '  other:', '    ssh: other', '    path: /srv/other');
			let open = 0, most = 0;
			vscode.window.showInformationMessage.mockImplementation(<any>(async () => {
				open++;
				most = Math.max(most, open);
				await new Promise((resolve) => setTimeout(resolve, 20));
				open--;
				return 'Fetch';
			}));

			// Run
			await refresh();

			// Assert
			expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(2);
			expect(most).toBe(1);
		});
	});

	describe('Actions', () => {
		beforeEach(async () => {
			await refresh();
			calls = [];
		});

		it('Should open a worktree with Remote-SSH', async () => {
			// Setup
			const uris: any[] = [];
			(<any>vscode.Uri).from = (components: any) => components;
			vscode.commands.executeCommand.mockImplementationOnce((_command: string, uri: any) => {
				uris.push(uri);
				return Promise.resolve();
			});

			// Run
			const result = await remoteHosts.openWorktree(main, 'box', '/srv/app wt', true);

			// Assert
			expect(result).toBeNull();
			expect(vscode.commands.executeCommand).toHaveBeenCalledWith('vscode.openFolder', { scheme: 'vscode-remote', authority: 'ssh-remote+box', path: '/srv/app wt' }, true);
		});

		it('Should say that opening a worktree needs Remote-SSH when it isn\'t installed', async () => {
			// Setup
			extensions.getExtension.mockReturnValue(undefined);

			// Run
			const result = await remoteHosts.openWorktree(main, 'box', '/srv/app', false);

			// Assert
			expect(result).toBe('Opening a worktree on a server needs the Remote - SSH extension (ms-vscode-remote.remote-ssh). Install it, then try again.');
		});

		it('Should create a worktree over the shared connection, with quoted arguments', async () => {
			// Run
			const result = await remoteHosts.createWorktree(main, 'box', '.worktrees/{repo}-it\'s', 'main', 'feature');

			// Assert
			expect(result).toBeNull();
			const call = sshCalls()[0];
			expect(call.args.slice(-2)).toStrictEqual(['box', 'sh -s -- \'/srv/app\' \'/srv/app/.worktrees/app-it\'\\\'\'s\' \'main\' \'feature\'']);
			expect(call.options.input).toMatch(/git worktree add -b "\$4" -- "\$2" "\$3"/);
			await settle();
			expect(sshCalls()).toHaveLength(2); // Then a refresh
		});

		it('Should refuse a worktree path it can\'t resolve, and a commit that looks like an option', async () => {
			// Assert
			expect(await remoteHosts.createWorktree(main, 'box', '~/wt', 'main', null)).toMatch(/^Use an absolute path/);
			expect(await remoteHosts.createWorktree(main, 'box', '/srv/wt', '--force', null)).toBe('The commit or branch "--force" isn\'t valid.');
			expect(await remoteHosts.createWorktree(main, 'nope', '/srv/wt', 'main', null)).toBe('The host "nope" isn\'t in ' + CONFIG_FILE + '.');
			expect(sshCalls()).toStrictEqual([]);
		});

		it('Should return Git\'s message when an action fails', async () => {
			// Setup
			servers['box'].answer = { code: 128, stderr: 'fatal: \'/srv/wt\' already exists\n' };

			// Run
			const result = await remoteHosts.createWorktree(main, 'box', '/srv/wt', 'main', null);

			// Assert
			expect(result).toBe('Git Tree couldn\'t create the worktree on "box": fatal: \'/srv/wt\' already exists');
		});

		it('Should return the SSH failure when an action can\'t connect', async () => {
			// Setup
			servers['box'].answer = { code: 255, stderr: 'ssh: connect to host box port 22: Connection refused\n' };

			// Run
			const result = await remoteHosts.removeWorktree(main, 'box', '/srv/app wt', false);

			// Assert
			expect(result).toBe('Git Tree couldn\'t connect to "box". ssh: connect to host box port 22: Connection refused');
		});

		it('Should remove a worktree, with --force when asked', async () => {
			// Run
			const result = await remoteHosts.removeWorktree(main, 'box', '/srv/app wt', true);

			// Assert
			expect(result).toBeNull();
			expect(sshCalls()[0].args[sshCalls()[0].args.length - 1]).toBe('sh -s -- \'/srv/app\' \'/srv/app wt\' \'yes\'');
			expect(sshCalls()[0].options.input).toMatch(/git worktree remove --force -- "\$2"/);
		});

		it('Should open a terminal in the worktree', () => {
			// Run
			const result = remoteHosts.openTerminal(main, 'box', '/srv/it\'s wt');

			// Assert
			expect(result).toBeNull();
			expect(vscode.window.createTerminal).toHaveBeenCalledWith({
				name: 'Git Tree: box:it\'s wt',
				shellPath: 'ssh',
				shellArgs: ['-o', 'ControlMaster=auto', '-o', 'ControlPersist=120', '-o', 'ControlPath=/tmp/git-tree-' + process.getuid!() + '/%C', '-t', 'box', 'cd \'/srv/it\'\\\'\'s wt\' && exec "$SHELL" -l']
			});
			expect(vscode.mocks.terminal.show).toHaveBeenCalled();
		});

		it('Should refuse a terminal in a path that isn\'t absolute', () => {
			// Assert
			expect(remoteHosts.openTerminal(main, 'box', 'wt')).toBe('The path "wt" must be absolute (start with /).');
			expect(vscode.window.createTerminal).not.toHaveBeenCalled();
		});
	});

	describe('Adding and removing hosts', () => {
		const entry = (name: string, ssh: string, serverPath: string, worktrees: boolean = true, forwardAgent: boolean = false): RemoteHostEntry => ({ name: name, ssh: ssh, path: serverPath, worktrees: worktrees, forwardAgent: forwardAgent });

		it('Should check the connection and the project, then add the host and exclude the folder', async () => {
			// Setup
			servers['new-box'] = server('/srv/new');

			// Run
			const result = await remoteHosts.saveHost(main, null, entry('new', 'new-box', '/srv/new', false, true));
			await settle();

			// Assert
			expect(result).toBeNull();
			expect(fs.readFileSync(main + '/' + CONFIG_FILE, 'utf8')).toBe('version: 1\nhosts:\n  box:\n    ssh: box\n    path: /srv/app\n  new:\n    ssh: new-box\n    path: /srv/new\n    worktrees: false\n    forwardAgent: true\n');
			expect(gitCalls('check-ignore')).toStrictEqual([['check-ignore', '-q', CONFIG_FILE]]);
			expect(fs.readFileSync(main + '/.git/info/exclude', 'utf8')).toBe('/.worktrees/\n');
			expect(remoteHosts.getHosts(main).map((host) => [host.host.name, host.host.state])).toStrictEqual([['box', 'ok'], ['new', 'ok']]);
		});

		it('Should not add a host it can\'t reach, or of another project, or whose name is taken', async () => {
			// Setup
			servers['down'] = Object.assign(server('/srv/app'), { answer: { code: 255, stderr: 'ssh: Could not resolve hostname down\n' } });
			servers['other'] = Object.assign(server('/srv/app'), { roots: ['9'.repeat(40)] });

			// Assert
			expect(await remoteHosts.saveHost(main, null, entry('down', 'down', '/srv/app'))).toBe('Git Tree couldn\'t connect to "down". ssh: Could not resolve hostname down');
			expect(await remoteHosts.saveHost(main, null, entry('other', 'other', '/srv/app'))).toMatch(/shares no root commit with this one/);
			expect(await remoteHosts.saveHost(main, null, entry('bad name', 'other', '/srv/app'))).toMatch(/may only hold letters/);
			calls = [];
			expect(await remoteHosts.saveHost(main, null, entry('BOX', 'box', '/srv/app'))).toBe('The file already has a host named "box".');
			expect(sshCalls()).toStrictEqual([]); // A taken name is found before the check
			expect(fs.readFileSync(main + '/' + CONFIG_FILE, 'utf8')).toBe('version: 1\nhosts:\n  box:\n    ssh: box\n    path: /srv/app\n');
		});

		it('Should only add the main worktree of a repository, and not a bare one', async () => {
			// Setup: the path is a linked worktree, whose list names the main worktree first
			servers['linked'] = Object.assign(server('/srv/app'), { path: '/srv/app wt' });
			servers['bare'] = server('/srv/bare.git');
			servers['bare'].worktrees = [{ path: '/srv/bare.git', head: MAIN_HASH, branch: null, count: null }];
			const simulateBare = mockedRunProcess.getMockImplementation()!;
			mockedRunProcess.mockImplementation((file, args, options) => {
				const answer = simulateBare(file, args, options);
				return args[args.length - 2] !== 'bare' ? answer : answer.then((output) => Object.assign({}, output, { stdout: Buffer.from(output.stdout.toString().replace('detached\n', 'bare\n')) }));
			});

			// Assert
			expect(await remoteHosts.checkHost(main, 'linked', '/srv/app wt')).toBe('linked:/srv/app wt isn\'t the main worktree of its repository. Use the main worktree\'s path, /srv/app, and Git Tree shows the linked worktrees with it.');
			expect(await remoteHosts.checkHost(main, 'bare', '/srv/bare.git')).toBe('bare:/srv/bare.git is in a bare repository, which has no main worktree. Use the path of a repository with a working tree.');
			expect(await remoteHosts.checkHost(main, 'box', '/srv/app')).toBeNull();
		});

		it('Should check a host with the status call over the shared connection, reading the root commits', async () => {
			// Run
			const result = await remoteHosts.checkHost(main, 'box', '/srv/app');

			// Assert
			expect(result).toBeNull();
			expect(sshCalls()).toHaveLength(1);
			expect(statusArgs(sshCalls()[0])).toStrictEqual(['/srv/app', 'all', 'no', 'yes']);
			expect(sshCalls()[0].args).toContain('ControlMaster=auto');
			expect(await remoteHosts.checkHost(main, '-oProxyCommand=x', '/srv/app')).toMatch(/must be a Host alias/);
			expect(sshCalls()).toHaveLength(1);
		});

		it('Should write a change of only the options at once, without checking', async () => {
			// Setup
			await refresh();
			calls = [];

			// Run
			const result = await remoteHosts.saveHost(main, 'box', entry('box', 'box', '/srv/app', false, true));

			// Assert
			expect(result).toBeNull();
			expect(calls.filter((call) => call.file !== GIT && call.options.input !== STATUS_SCRIPT)).toStrictEqual([]);
			expect(sshCalls().every((call) => statusArgs(call)[3] === 'no')).toBe(true); // Only the refresh afterwards, with no root commits
			expect(fs.readFileSync(main + '/' + CONFIG_FILE, 'utf8')).toBe('version: 1\nhosts:\n  box:\n    ssh: box\n    path: /srv/app\n    worktrees: false\n    forwardAgent: true\n');
			expect(gitCalls('check-ignore')).toStrictEqual([]);
		});

		it('Should check a changed path before writing it', async () => {
			// Setup
			servers['box'].path = '/srv/moved';
			servers['box'].worktrees[0].path = '/srv/moved';

			// Run
			const wrong = await remoteHosts.saveHost(main, 'box', entry('box', 'box', '/srv/nowhere'));
			const moved = await remoteHosts.saveHost(main, 'box', entry('box', 'box', '/srv/moved'));

			// Assert
			expect(wrong).toBe('box:/srv/nowhere doesn\'t exist, or isn\'t a folder Git Tree can enter.');
			expect(moved).toBeNull();
			expect(fs.readFileSync(main + '/' + CONFIG_FILE, 'utf8')).toBe('version: 1\nhosts:\n  box:\n    ssh: box\n    path: /srv/moved\n');
		});

		it('Should rename a host, keeping its fetch consent and deleting its old refs', async () => {
			// Setup
			await refresh();
			expect(Array.from(localRefs.keys()).some((ref) => ref.startsWith('refs/git-tree/hosts/box/'))).toBe(true);
			calls = [];

			// Run
			const result = await remoteHosts.saveHost(main, 'box', entry('renamed', 'box', '/srv/app'));
			await settle();

			// Assert
			expect(result).toBeNull();
			expect(fs.readFileSync(main + '/' + CONFIG_FILE, 'utf8')).toBe('version: 1\nhosts:\n  renamed:\n    ssh: box\n    path: /srv/app\n');
			expect(extensionState.getRemoteHostFetchConsent(main, 'renamed', 'box', '/srv/app')).toBe(true);
			expect(extensionState.getRemoteHostFetchConsent(main, 'box', 'box', '/srv/app')).toBeNull();
			expect(Array.from(localRefs.keys()).filter((ref) => ref.startsWith('refs/git-tree/hosts/box/'))).toStrictEqual([]);
			expect(Array.from(localRefs.keys()).some((ref) => ref.startsWith('refs/git-tree/hosts/renamed/heads/'))).toBe(true);
			expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1); // The consent question was asked once, before the rename
			expect(remoteHosts.getHosts(main).map((host) => [host.host.name, host.host.state])).toStrictEqual([['renamed', 'ok']]);
		});

		it('Should refuse to edit a host that isn\'t in the file', async () => {
			// Assert
			expect(await remoteHosts.saveHost(main, 'missing', entry('missing', 'box', '/srv/app'))).toBe('The host "missing" isn\'t in ' + CONFIG_FILE + '.');
			expect(sshCalls()).toStrictEqual([]);
		});

		it('Should remove a host, its refs and its consent', async () => {
			// Setup
			await refresh();
			localRefs.set('refs/git-tree/hosts/boxer/heads/main', MAIN_HASH);

			// Run
			const result = await remoteHosts.removeHost(main, 'box');

			// Assert
			expect(result).toBeNull();
			expect(fs.readFileSync(main + '/' + CONFIG_FILE, 'utf8')).toBe('version: 1\nhosts: {}\n');
			expect(Array.from(localRefs.keys())).toStrictEqual(['refs/git-tree/hosts/boxer/heads/main']);
			expect(extensionState.getRemoteHostFetchConsent(main, 'box', 'box', '/srv/app')).toBeNull();
			expect(remoteHosts.getHosts(main)).toStrictEqual([]);
		});
	});

	describe('Repository Settings', () => {
		it('Should load the hosts, the file, the SSH aliases and the instruction, without calling a server', async () => {
			// Setup
			writeConfig('  box:', '    ssh: box', '    path: /srv/app', '    forwardAgent: true', '  bad:', '    ssh: -x');
			await refresh();
			calls = [];
			const home = tmp + '/home';
			fs.mkdirSync(home + '/.ssh', { recursive: true });
			fs.writeFileSync(home + '/.ssh/config', 'Include hosts\nHost box\n  HostName 10.0.0.2\n');
			fs.writeFileSync(home + '/.ssh/hosts', 'Host gpu\n  User me\n');
			const spyOnHomedir = jest.spyOn(os, 'homedir').mockReturnValue(home);

			// Run
			const settings = await remoteHosts.loadSettings(main);
			spyOnHomedir.mockRestore();

			// Assert
			expect(settings).toStrictEqual({
				hosts: [
					{ name: 'box', ssh: 'box', path: '/srv/app', worktrees: true, forwardAgent: true, state: 'ok', message: null, lastRefresh: expect.any(Number), worktreeCount: 2 },
					{ name: 'bad', ssh: '', path: '', worktrees: true, forwardAgent: false, state: 'configError', message: expect.stringMatching(/^Line 8: /), lastRefresh: null, worktreeCount: 0 }
				],
				configFile: main + '/' + CONFIG_FILE,
				configError: null,
				sshAliases: [{ alias: 'gpu', hostName: null, user: 'me' }, { alias: 'box', hostName: '10.0.0.2', user: null }],
				agentInstruction: AGENT_INSTRUCTION
			});
			expect(sshCalls()).toStrictEqual([]);
		});

		it('Should list a folder on a server, over the shared connection', async () => {
			// Setup
			servers['box'].onScript = (script, args) => script === BROWSE_SCRIPT && args[0] === '/srv/it\'s'
				? { stdout: Buffer.from('gt:browse\0/srv/it\'s\0/srv\0r app\0f .cache\0gt:end\0') }
				: { code: 3, stdout: Buffer.from('gt:nopath\n') };

			// Run
			const listing = await remoteHosts.browse('box', '/srv/it\'s');

			// Assert
			expect(listing).toStrictEqual({ path: '/srv/it\'s', parent: '/srv', entries: [{ name: '.cache', kind: 'folder' }, { name: 'app', kind: 'repository' }], truncated: false });
			expect(sshCalls()[0].args).toStrictEqual(['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ForwardAgent=no', '-o', 'ControlMaster=auto', '-o', 'ControlPersist=120', '-o', 'ControlPath=/tmp/git-tree-' + process.getuid!() + '/%C', 'box', 'sh -s -- \'/srv/it\'\\\'\'s\'']);
			expect(sshCalls()[0].options.timeout).toBe(15000);
		});

		it('Should list the home folder for no path, and say why a folder can\'t be listed', async () => {
			// Setup
			servers['box'].onScript = (_, args) => args[0] === ''
				? { stdout: Buffer.from('gt:browse\0/home/me\0/home\0gt:end\0') }
				: { code: 3, stdout: Buffer.from('gt:nopath\n') };
			servers['down'] = Object.assign(server('/srv/app'), { answer: { code: 255, stderr: 'ssh: connect to host down port 22: Connection refused\n' } });

			// Assert
			expect(await remoteHosts.browse('box', null)).toStrictEqual({ path: '/home/me', parent: '/home', entries: [], truncated: false });
			expect(await remoteHosts.browse('box', '/missing')).toStrictEqual({ error: 'box:/missing doesn\'t exist, or isn\'t a folder Git Tree can enter.' });
			expect(await remoteHosts.browse('down', null)).toStrictEqual({ error: 'Git Tree couldn\'t connect to "down". ssh: connect to host down port 22: Connection refused' });
			expect(await remoteHosts.browse('-oProxyCommand=x', null)).toHaveProperty('error');
			expect(await remoteHosts.browse('box', 'relative')).toStrictEqual({ error: 'The path "relative" must be absolute (start with /).' });
			expect(sshCalls()).toHaveLength(3);
		});

		it('Should create a repository by cloning a remote on the server, with the agent forwarded, then add it', async () => {
			// Setup
			servers['new-box'] = server('/srv/new');

			// Run
			const result = await remoteHosts.createRepository(main, entry('new', 'new-box', '/srv/new', true, true), { kind: 'clone', remote: 'origin' });

			// Assert
			expect(result).toBeNull();
			const clone = sshCalls()[0];
			expect(clone.options.input).toMatch(/git clone --quiet -- "\$2" "\$1"/);
			expect(statusArgs(clone)).toStrictEqual(['/srv/new', 'git@github.com:user/app.git']);
			expect(clone.args.slice(0, -2)).toStrictEqual(['-A', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ControlMaster=no', '-o', 'ControlPath=none']);
			expect(clone.options.timeout).toBe(300000);
			expect(sshCalls().slice(1).every((call) => call.args.indexOf('-A') === -1)).toBe(true); // Only the clone forwards the agent
			expect(fs.readFileSync(main + '/' + CONFIG_FILE, 'utf8')).toMatch(/  new:\n    ssh: new-box\n    path: \/srv\/new\n    forwardAgent: true\n$/);
		});

		it('Should clone on the shared connection without forwardAgent', async () => {
			// Setup
			servers['new-box'] = server('/srv/new');

			// Run
			await remoteHosts.createRepository(main, entry('new', 'new-box', '/srv/new'), { kind: 'clone', remote: 'origin' });

			// Assert
			expect(sshCalls()[0].args).toContain('ControlMaster=auto');
			expect(sshCalls()[0].args).not.toContain('-A');
		});

		it('Should refuse to clone a remote the server can\'t reach, or a URL with a password', async () => {
			// Setup
			localRemotes = { local: '/home/me/app.git', file: 'file:///home/me/app.git', relative: '../app', token: 'https://me:secret@example.com/app.git' };

			// Assert
			expect(await remoteHosts.createRepository(main, entry('new', 'box', '/srv/new'), { kind: 'clone', remote: 'local' })).toBe('The remote "local" is a path on this machine (/home/me/app.git), which the server can\'t reach. Use Push instead.');
			expect(await remoteHosts.createRepository(main, entry('new', 'box', '/srv/new'), { kind: 'clone', remote: 'file' })).toMatch(/is a path on this machine/);
			expect(await remoteHosts.createRepository(main, entry('new', 'box', '/srv/new'), { kind: 'clone', remote: 'relative' })).toMatch(/is a path on this machine/);
			expect(await remoteHosts.createRepository(main, entry('new', 'box', '/srv/new'), { kind: 'clone', remote: 'token' })).toMatch(/holds a password/);
			expect(await remoteHosts.createRepository(main, entry('new', 'box', '/srv/new'), { kind: 'clone', remote: 'missing' })).toBe('This repository has no remote named "missing".');
			expect(sshCalls()).toStrictEqual([]);
		});

		it('Should create a repository by pushing this repository\'s branches, then add it', async () => {
			// Setup
			servers['new-box'] = server('/srv/new');

			// Run
			const result = await remoteHosts.createRepository(main, entry('new', 'new-box', '/srv/new', true, true), { kind: 'push' });

			// Assert
			expect(result).toBeNull();
			const init = sshCalls()[0];
			expect(init.options.input).toMatch(/git init --quiet -- "\$1" && git -C "\$1" symbolic-ref HEAD "\$2"/);
			expect(statusArgs(init)).toStrictEqual(['/srv/new', 'refs/heads/main']);
			expect(init.args).not.toContain('-A'); // The push doesn't leave the server, so nothing forwards the agent
			const push = calls.find((call) => call.args[0] === 'push')!;
			expect(push.args).toStrictEqual(['push', '--quiet', '--receive-pack=git -c receive.denyCurrentBranch=updateInstead receive-pack', 'new-box:/srv/new', 'refs/heads/*:refs/heads/*']);
			expect(push.options.cwd).toBe(main);
			expect(push.options.env!.GIT_SSH_COMMAND).toMatch(/'ControlMaster=auto'/);
			expect(push.options.env!.GIT_TERMINAL_PROMPT).toBe('0');
			expect(remoteHosts.getHosts(main).map((host) => host.host.name)).toStrictEqual(['box', 'new']);
		});

		it('Should say why a repository wasn\'t created', async () => {
			// Setup
			servers['full'] = Object.assign(server('/srv/full'), { onScript: () => ({ code: 8 }) });
			servers['new-box'] = server('/srv/new');

			// Assert
			expect(await remoteHosts.createRepository(main, entry('new', 'full', '/srv/full'), { kind: 'push' })).toBe('full:/srv/full already exists, and isn\'t an empty folder. Choose a new folder, or add the repository that\'s there.');
			expect(await remoteHosts.createRepository(main, entry('box', 'new-box', '/srv/new'), { kind: 'push' })).toBe('The file already has a host named "box".');

			// Setup
			pushAnswer = { code: 1, stderr: 'error: failed to push some refs\n' };

			// Assert
			expect(await remoteHosts.createRepository(main, entry('new', 'new-box', '/srv/new'), { kind: 'push' })).toBe('Git Tree made an empty repository at new-box:/srv/new, but couldn\'t push this repository\'s branches to it: error: failed to push some refs Remove that folder on the server before you try again.');

			// Setup
			localHead = null;

			// Assert
			expect(await remoteHosts.createRepository(main, entry('new', 'new-box', '/srv/new'), { kind: 'push' })).toMatch(/^This repository's HEAD isn't on a branch/);
			expect(fs.readFileSync(main + '/' + CONFIG_FILE, 'utf8')).toBe('version: 1\nhosts:\n  box:\n    ssh: box\n    path: /srv/app\n');
		});

		it('Should run Git in a worktree of a host, with no prompt, and refresh the host', async () => {
			// Setup
			await refresh();
			calls = [];

			// Run
			const result = await remoteHosts.runGitOnHost(main, 'box', '/srv/app wt', 'pull');
			await settle();

			// Assert
			expect(result).toBeNull();
			const run = sshCalls()[0];
			expect(statusArgs(run)).toStrictEqual(['/srv/app wt', 'pull']);
			expect(run.options.input).toMatch(/export GIT_TERMINAL_PROMPT=0\n/);
			expect(run.options.input).toMatch(/pull\) exec git pull --ff-only;;/);
			expect(run.options.timeout).toBe(300000);
			expect(run.args).toContain('ControlMaster=auto');
			expect(run.args).not.toContain('-A');
			expect(sshCalls().slice(1).filter((call) => call.options.input === STATUS_SCRIPT)).toHaveLength(1); // The refresh afterwards
		});

		it('Should forward the agent to Git on a host with forwardAgent, on its own connection', async () => {
			// Setup
			writeConfig('  box:', '    ssh: box', '    path: /srv/app', '    forwardAgent: true');
			await refresh();
			calls = [];

			// Run
			await remoteHosts.runGitOnHost(main, 'box', '/srv/app', 'fetch');
			await settle();

			// Assert
			const run = sshCalls()[0];
			expect(run.args).toStrictEqual(['-A', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', 'box', 'sh -s -- \'/srv/app\' \'fetch\'']);
			expect(run.options.input).toMatch(/fetch\) exec git fetch --all --prune;;/);
			expect(sshCalls().slice(1).every((call) => call.args.indexOf('-A') === -1)).toBe(true); // The refresh doesn't forward it
		});

		it('Should return Git\'s error lines, and refuse a worktree the host doesn\'t have', async () => {
			// Setup
			await refresh();
			servers['box'].onScript = () => ({ code: 128, stderr: 'fatal: Not possible to fast-forward, aborting.\n' });

			// Assert
			expect(await remoteHosts.runGitOnHost(main, 'box', '/srv/app', 'pull')).toBe('Git Tree couldn\'t run git pull --ff-only in /srv/app on "box": fatal: Not possible to fast-forward, aborting.');
			calls = [];
			expect(await remoteHosts.runGitOnHost(main, 'box', '/srv/elsewhere', 'push')).toBe('/srv/elsewhere isn\'t a worktree of "box" that Git Tree knows. Refresh the view, then try again.');
			expect(await remoteHosts.runGitOnHost(main, 'box', '/srv/app', <RemoteHostGitAction>'gc')).toBe('Git Tree doesn\'t run "gc" on a server.');
			expect(await remoteHosts.runGitOnHost(main, 'box', '/srv/app', <RemoteHostGitAction>'toString')).toBe('Git Tree doesn\'t run "toString" on a server.');
			expect(await remoteHosts.runGitOnHost(main, 'other', '/srv/app', 'push')).toBe('The host "other" isn\'t in ' + CONFIG_FILE + '.');
			expect(sshCalls()).toStrictEqual([]);
		});

		it('Should only run Git in the main worktree of a host without worktrees', async () => {
			// Setup
			writeConfig('  box:', '    ssh: box', '    path: /srv/app', '    worktrees: false');
			await refresh();

			// Assert
			expect(await remoteHosts.runGitOnHost(main, 'box', '/srv/app wt', 'fetch')).toMatch(/isn't a worktree of "box" that Git Tree knows/);
			expect(await remoteHosts.runGitOnHost(main, 'box', '/srv/app/', 'fetch')).toBeNull();
		});

		it('Should skip the hosts a view hides when it asks for a refresh', async () => {
			// Setup
			servers['other'] = server('/srv/other');
			writeConfig('  box:', '    ssh: box', '    path: /srv/app', '  other:', '    ssh: other', '    path: /srv/other');

			// Run
			remoteHosts.refresh(main, ['box']);
			await settle();

			// Assert
			expect(sshCalls().map((call) => call.args[call.args.length - 2])).toStrictEqual(['other']);
		});

		function entry(name: string, ssh: string, serverPath: string, worktrees: boolean = true, forwardAgent: boolean = false): RemoteHostEntry {
			return { name: name, ssh: ssh, path: serverPath, worktrees: worktrees, forwardAgent: forwardAgent };
		}
	});

	describe('Refresh interval', () => {
		it('Should refresh on the interval in the setting, and not without it', async () => {
			// Setup
			remoteHosts.dispose();
			vscode.mockExtensionSettingReturnValue('remoteHosts.refreshInterval', 0.001); // At least 5 seconds
			jest.useFakeTimers();
			try {
				remoteHosts = new RemoteHosts(extensionState, { path: GIT, version: '2.54.0' }, onDidChangeGitExecutable.subscribe, logger);
				expect(remoteHosts['intervalTimer']).not.toBeNull();
				expect((<jest.Mock>setInterval).mock.calls[(<jest.Mock>setInterval).mock.calls.length - 1][1]).toBe(5000);

				remoteHosts.dispose();
				vscode.mockExtensionSettingReturnValue('remoteHosts.refreshInterval', 0);
				remoteHosts = new RemoteHosts(extensionState, { path: GIT, version: '2.54.0' }, onDidChangeGitExecutable.subscribe, logger);
				expect(remoteHosts['intervalTimer']).toBeNull();
			} finally {
				jest.useRealTimers();
			}
		});

		it('Should leave out the hosts that every saved view state of the repository hides', () => {
			// Setup
			const repoState = (hideHosts: string[]) => Object.assign({}, DEFAULT_REPO_STATE, { hideHosts: hideHosts });
			const spyOnGetRepos = jest.spyOn(extensionState, 'getRepos');
			spyOnGetRepos.mockReturnValue({ '/repo': repoState(['a', 'b']), '/repo/.worktrees/x': repoState(['b', 'c']) });
			const getHiddenHosts = (repos: string[]) => remoteHosts['getHiddenHosts'](<any>{ repos: new Set(repos) });

			// Assert
			expect(getHiddenHosts(['/repo', '/repo/.worktrees/x'])).toStrictEqual(['b']);
			expect(getHiddenHosts(['/repo', '/elsewhere'])).toStrictEqual(['a', 'b']);
			expect(getHiddenHosts(['/elsewhere'])).toStrictEqual([]);
			spyOnGetRepos.mockRestore();
		});
	});
});

describe('resolveServerWorktreePath', () => {
	it('Should resolve a path as the local dialog does', () => {
		expect(resolveServerWorktreePath('/srv/wt', '/srv/app')).toStrictEqual({ path: '/srv/wt' });
		expect(resolveServerWorktreePath(' .worktrees/x ', '/srv/app')).toStrictEqual({ path: '/srv/app/.worktrees/x' });
		expect(resolveServerWorktreePath('../{repo}-x', '/srv/app/')).toStrictEqual({ path: '/srv/app-x' });
		expect(resolveServerWorktreePath('~/wt', '/srv/app')).toHaveProperty('error');
		expect(resolveServerWorktreePath('/srv/a\nb', '/srv/app')).toStrictEqual({ error: 'The path "/srv/a?b" holds a control character.' });
	});
});


/* The simulation */

function server(repoPath: string): Server {
	return {
		path: repoPath,
		branches: { main: MAIN_HASH, topic: TOPIC_HASH },
		roots: [ROOT],
		worktrees: [
			{ path: repoPath, head: MAIN_HASH, branch: 'main', count: 2 },
			{ path: repoPath + ' wt', head: DETACHED_HASH, branch: null, count: null }
		],
		answer: null,
		fetchAnswer: null,
		onScript: null
	};
}

function result(custom: Partial<ProcessResult>): ProcessResult {
	return Object.assign({ code: 0, stdout: Buffer.from(''), stderr: '', error: null, timedOut: false }, custom);
}

/**
 * Answer a process as the simulated server or local repository would.
 */
function simulate(file: string, args: ReadonlyArray<string>, options: ProcessOptions): ProcessResult {
	calls.push({ file: file, args: args, options: options });
	if (file !== GIT) {
		const alias = args[args.length - 2], target = servers[alias];
		if (typeof target === 'undefined') return result({ code: 255, stderr: 'ssh: Could not resolve hostname ' + alias + '\n' });
		if (target.answer !== null) return result(target.answer);
		const scriptArgs = unquote(args[args.length - 1]);
		if (options.input !== STATUS_SCRIPT) return result(target.onScript !== null ? target.onScript(options.input!, scriptArgs) : {});
		if (scriptArgs[0] !== target.path) return result({ code: 3, stdout: Buffer.from('gt:nopath\n') });
		const lines = ['gt:tips'].concat(Object.keys(target.branches).sort().map((name) => target.branches[name] + ' refs/heads/' + name));
		if (scriptArgs[3] === 'yes') lines.push('gt:roots', ...target.roots);
		lines.push('gt:worktrees');
		target.worktrees.forEach((worktree) => lines.push('worktree ' + worktree.path, 'HEAD ' + worktree.head, worktree.branch !== null ? 'branch refs/heads/' + worktree.branch : 'detached', ''));
		lines.push('gt:status');
		target.worktrees.forEach((worktree, i) => {
			if (scriptArgs[2] === 'yes' || i === 0) lines.push((worktree.count !== null ? worktree.count : -1) + ' ' + worktree.path);
		});
		lines.push('gt:end');
		return result({ stdout: Buffer.from(lines.join('\n') + '\n') });
	}

	switch (args[0]) {
		case 'rev-parse':
			return result({ stdout: Buffer.from(args.indexOf('--git-common-dir') > -1 ? main + '/.git\n' : main + '/.git/info/exclude\n') });
		case 'rev-list':
			return result({ stdout: Buffer.from(localRoots.map((root) => root + '\n').join('')) });
		case 'for-each-ref': {
			const prefix = args[2], names = Array.from(localRefs.keys()).filter((ref) => ref.startsWith(prefix)).sort();
			return result({ stdout: Buffer.from(names.map((ref) => (args[1] === '--format=%(refname)' ? '' : localRefs.get(ref) + ' ') + ref + '\n').join('')) });
		}
		case 'cat-file':
			return result({ stdout: Buffer.from(options.input!.split('\n').filter((hash) => hash !== '').map((hash) => hash + (localCommits.has(hash) ? ' commit' : ' missing') + '\n').join('')) });
		case 'update-ref':
			if (args[1] === '--stdin') {
				options.input!.split('\n').filter((line) => line !== '').forEach((line) => localRefs.delete(line.substring(7)));
			} else {
				localRefs.set(args[1], args[2]);
			}
			return result({});
		case 'check-ignore':
			return result({ code: 1 });
		case 'ls-files':
			return result({ stdout: Buffer.from(configTracked ? args[2] + '\n' : '') });
		case 'remote':
			return localRemotes[args[2]] ? result({ stdout: Buffer.from(localRemotes[args[2]] + '\n') }) : result({ code: 2, stderr: 'error: No such remote \'' + args[2] + '\'\n' });
		case 'symbolic-ref':
			return localHead !== null ? result({ stdout: Buffer.from(localHead + '\n') }) : result({ code: 1 });
		case 'push':
			return result(pushAnswer);
		case 'fetch': {
			const url = args[args.length - 2], refspec = args[args.length - 1];
			const alias = url.substring(0, url.indexOf(':')), serverPath = url.substring(url.indexOf(':') + 1), target = servers[alias];
			if (target.fetchAnswer !== null) return result(target.fetchAnswer);
			if (refspec.startsWith('+refs/heads/*:')) {
				const prefix = refspec.substring(14, refspec.length - 1);
				Array.from(localRefs.keys()).filter((ref) => ref.startsWith(prefix)).forEach((ref) => localRefs.delete(ref));
				Object.keys(target.branches).forEach((name) => {
					localRefs.set(prefix + name, target.branches[name]);
					localCommits.add(target.branches[name]);
				});
			} else {
				const worktree = target.worktrees.find((candidate) => candidate.path === serverPath)!;
				localRefs.set(refspec.substring(6), worktree.head);
				localCommits.add(worktree.head);
			}
			return result({});
		}
	}
	throw new Error('Unexpected git ' + args.join(' '));
}

/**
 * Split a command of single-quoted words, as a server's shell would.
 */
function unquote(command: string) {
	const words: string[] = [];
	const regex = /'((?:[^']|'\\'')*)'/g;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(command.substring('sh -s -- '.length))) !== null) words.push(match[1].replace(/'\\''/g, '\''));
	return words;
}


/* Helpers */

function writeConfig(...hostLines: string[]) {
	fs.writeFileSync(main + '/' + CONFIG_FILE, ['version: 1', 'hosts:'].concat(hostLines).join('\n') + '\n');
	// The file's modification time is how a refresh tells it changed, and two writes can share a millisecond
	const time = new Date(Date.now() + Math.floor(Math.random() * 100000));
	fs.utimesSync(main + '/' + CONFIG_FILE, time, time);
}

function sshCalls() {
	return calls.filter((call) => call.file !== GIT);
}

function gitCalls(command: string) {
	return calls.filter((call) => call.file === GIT && call.args[0] === command).map((call) => call.args);
}

function statusArgs(call: Call) {
	return unquote(call.args[call.args.length - 1]);
}

/**
 * Refresh the hosts of the main worktree, and wait until every refresh finished.
 */
async function refresh() {
	remoteHosts.refresh(main);
	await settle();
}

/**
 * Wait until the hosts are neither loading nor refreshing.
 */
async function settle() {
	for (let i = 0; i < 2000; i++) {
		await new Promise((resolve) => setTimeout(resolve, i < 10 ? 0 : 2));
		const entries = <Map<string, { hosts: { refreshing: boolean }[], loading: Promise<void> | null }>>remoteHosts['entries'];
		const mainWorktrees = <Map<string, Promise<string | null>>>remoteHosts['mainWorktrees'];
		const resolved = <Map<string, string | null>>remoteHosts['resolvedMainWorktrees'];
		const busy = Array.from(entries.values()).some((entry) => entry.loading !== null || entry.hosts.some((host) => host.refreshing)) || mainWorktrees.size > resolved.size;
		if (!busy && i > 3) return;
	}
	throw new Error('The hosts didn\'t settle.');
}
