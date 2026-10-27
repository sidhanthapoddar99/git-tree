import * as vscode from '../mocks/vscode';
jest.mock('vscode', () => Object.assign({}, vscode, {
	extensions: { getExtension: jest.fn(() => ({ id: 'ms-vscode-remote.remote-ssh' })) },
	RelativePattern: class {
		constructor(public readonly baseUri: unknown, public readonly pattern: string) { }
	}
}), { virtual: true });
jest.mock('../../src/logger');

import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataSource } from '../../src/dataSource';
import { loadEngine } from '../../src/engine';
import { ExtensionState } from '../../src/extensionState';
import { Logger } from '../../src/logger';
import { RemoteHosts, getHostBranchesPrefix, getHostDetachedRef } from '../../src/remoteHosts';
import { CONFIG_FILE } from '../../src/remoteHosts/config';
import { CommitOrdering, RemoteHostEntry } from '../../src/types';
import { GitExecutable, getGitExecutable } from '../../src/utils';
import { EventEmitter } from '../../src/utils/event';

/*
 * The remote hosts end to end: real SSH and Git against a test SSH server. The server needs `git` and a POSIX shell,
 * and an SSH configuration with a `Host gt-test` that logs in with a key and no prompt. The configuration's path is
 * GIT_TREE_TEST_SSH_CONFIG (default: /tmp/gt-ssh/ssh_config); without it the tests are skipped. They make their
 * repositories in a new folder under the server's /tmp, and remove it afterwards.
 *
 * The tests copy the configuration into a temporary folder, add aliases that fail (a closed port, and no key), and point
 * `git-tree.remoteHosts.sshPath` at a wrapper that runs `ssh -F <the copy>`, so ~/.ssh is never read or changed.
 *
 * The user's SSH agent is never used: the wrapper unsets SSH_AUTH_SOCK. The agent forwarding tests start a private
 * ssh-agent that holds only the test key, and write its socket to a file that the wrapper reads (Jest gives each test
 * file its own copy of process.env, which the processes Git Tree starts don't see). They kill it afterwards. They need
 * the server's own ssh client to trust localhost, as scripts/test-ssh-server.sh sets it up: a clone on the server from
 * dev@localhost then works only with the agent forwarded.
 */

const SSH_CONFIG = process.env.GIT_TREE_TEST_SSH_CONFIG || '/tmp/gt-ssh/ssh_config';
const describeWithServer = fs.existsSync(SSH_CONFIG) ? describe : describe.skip;

if (!fs.existsSync(SSH_CONFIG)) {
	test('there is no test SSH server configuration (' + SSH_CONFIG + '), so the remote host tests are skipped', () => { });
}

describeWithServer('Remote hosts, against a test SSH server', () => {
	const serverRoot = '/tmp/git-tree-e2e-' + process.pid + '-' + Date.now();
	const serverRepo = serverRoot + '/app', serverDetached = serverRoot + '/app wt\'s "detached"', serverOther = serverRoot + '/other';
	let tmp: string, wrapper: string, local: string, configText: string;
	let gitExecutable: GitExecutable, logger: Logger, extensionState: ExtensionState, remoteHosts: RemoteHosts;
	let onDidChangeGitExecutable: EventEmitter<GitExecutable>, changes: string[];
	const consents: { [key: string]: boolean } = {};
	let agentFile: string, agentPid: number | null = null;

	beforeAll(async () => {
		if (!process.env.GIT_TREE_ENGINE_TEST_HOME || process.env.HOME !== process.env.GIT_TREE_ENGINE_TEST_HOME) {
			throw new Error('The remote host tests need the home folder that tests/engine/home-setup.js makes: run them with jest.remote.config.js.');
		}
		Object.assign(process.env, { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' });
		tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-tree-remote-')));

		// A copy of the SSH configuration, with two aliases that fail, and a wrapper that uses it. The alias without a key
		// has its own user, so it can't use the connection that Git Tree shares for gt-test.
		const sshConfig = path.join(tmp, 'ssh_config');
		const original = fs.readFileSync(SSH_CONFIG, 'utf8');
		fs.writeFileSync(sshConfig, original + '\n'
			+ getAlias(original, 'gt-test-down', ['Port 1']) + '\n'
			+ getAlias(original, 'gt-test-nokey', ['User git-tree-no-such-user', 'IdentityFile ' + path.join(tmp, 'no-such-key'), 'PubkeyAuthentication no', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no']));
		wrapper = path.join(tmp, 'ssh');
		agentFile = path.join(tmp, 'agent-socket');
		fs.writeFileSync(wrapper, [
			'#!/bin/sh',
			'if [ -s \'' + agentFile + '\' ]; then SSH_AUTH_SOCK=$(cat \'' + agentFile + '\'); export SSH_AUTH_SOCK; else unset SSH_AUTH_SOCK; fi',
			'exec ssh -F \'' + sshConfig + '\' "$@"',
			''
		].join('\n'), { mode: 0o755 });
		vscode.mockExtensionSettingReturnValue('remoteHosts.sshPath', wrapper);

		// The server: a repository with a main worktree and a detached linked worktree that has a commit on no branch,
		// and a repository of another project
		ssh(serverScript(
			'mkdir -p "$1" && cd "$1"',
			'git init -q -b main app && cd app && echo one > a && git add a && git commit -q -m one && git branch topic',
			'git worktree add -q --detach "$2" HEAD && cd "$2" && echo two > b && git add b && git commit -q -m detached',
			'cd "$1" && git init -q -b main other && cd other && git commit -q --allow-empty -m unrelated'
		), serverRoot, serverDetached);

		// The local repository: a clone of the server's
		local = path.join(tmp, 'local');
		git(tmp, ['clone', '-q', 'gt-test:' + serverRepo, local]);
		fs.mkdirSync(path.join(local, '.worktrees'));
		configText = [
			'version: 1',
			'hosts:',
			'  # The test server',
			'  box:',
			'    ssh: gt-test',
			'    path: ' + serverRepo,
			'  down:',
			'    ssh: gt-test-down',
			'    path: ' + serverRepo,
			'  other:',
			'    ssh: gt-test',
			'    path: ' + serverOther,
			'  nowhere:',
			'    ssh: gt-test',
			'    path: ' + serverRoot + '/missing',
			'  typo:',
			'    ssh: gt-test',
			'    paht: ' + serverRepo,
			''
		].join('\n');
		fs.writeFileSync(path.join(local, CONFIG_FILE), configText);

		gitExecutable = await getGitExecutable('git');
		logger = new Logger();
		onDidChangeGitExecutable = new EventEmitter<GitExecutable>();
		extensionState = <ExtensionState><unknown>{
			getRemoteHostFetchConsent: (repo: string, host: string) => typeof consents[repo + ':' + host] === 'boolean' ? consents[repo + ':' + host] : null,
			setRemoteHostFetchConsent: (repo: string, host: string, _ssh: string, _path: string, consent: boolean) => {
				consents[repo + ':' + host] = consent;
				return Promise.resolve(null);
			},
			clearRemoteHostFetchConsent: (repo: string, host: string) => {
				delete consents[repo + ':' + host];
				return Promise.resolve(null);
			},
			moveRemoteHostFetchConsent: (repo: string, from: string, to: string) => {
				if (typeof consents[repo + ':' + from] === 'boolean') consents[repo + ':' + to] = consents[repo + ':' + from];
				delete consents[repo + ':' + from];
				return Promise.resolve(null);
			}
		};
	});

	afterAll(() => {
		if (typeof remoteHosts !== 'undefined') remoteHosts.dispose();
		onDidChangeGitExecutable.dispose();
		stopAgent();
		try {
			ssh(serverScript('rm -rf "$1"'), serverRoot);
			cp.spawnSync(wrapper, ['-O', 'exit', '-o', 'ControlPath=' + path.join(tmp, 'cm-%C'), 'gt-test'], { stdio: 'ignore' });
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	beforeEach(() => {
		vscode.mockExtensionSettingReturnValue('remoteHosts.sshPath', wrapper);
		vscode.window.showInformationMessage.mockResolvedValue(<never>'Fetch');
	});

	it('Should read the hosts, and show each failure as its state', async () => {
		// Setup
		remoteHosts = new RemoteHosts(extensionState, gitExecutable, onDidChangeGitExecutable.subscribe, logger);
		changes = [];
		remoteHosts.onDidChange((repo) => changes.push(repo));

		// Run
		await refresh();

		// Assert
		const hosts = remoteHosts.getHosts(local);
		expect(hosts.map((host) => [host.host.name, host.host.state])).toStrictEqual([
			['box', 'ok'],
			['down', 'unreachable'],
			['other', 'differentRepository'],
			['nowhere', 'notARepository'],
			['typo', 'configError']
		]);
		expect(hosts[1].host.message).toMatch(/^Git Tree couldn't connect to "gt-test-down"\. .*Connection refused/);
		expect(hosts[1].host.lastRefresh).toBeNull();
		expect(hosts[1].worktrees).toStrictEqual([]);
		expect(hosts[2].host.message).toMatch(/shares no root commit with this one/);
		expect(hosts[3].host.message).toBe('gt-test:' + serverRoot + '/missing doesn\'t exist, or isn\'t a folder Git Tree can enter.');
		expect(hosts[4].host.message).toBe('Line 18: Unknown key "paht" in the host "typo". A host may only hold "ssh", "path", "worktrees" and "forwardAgent".');
		expect(changes.length).toBeGreaterThan(0);
		expect(changes.every((repo) => repo === local)).toBe(true);
		expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1); // The consent, for the only host that got that far
	});

	it('Should read the worktrees and their status, and fetch the branches and the detached HEAD', () => {
		// Assert
		const box = remoteHosts.getHosts(local)[0];
		expect(box.host.lastRefresh).not.toBeNull();
		expect(box.worktrees.map((worktree) => [worktree.worktree.path, worktree.worktree.name, worktree.worktree.branch, worktree.worktree.isMain, worktree.worktree.host, worktree.uncommittedChanges, worktree.commitIsLocal])).toStrictEqual([
			[serverRepo, 'app', 'main', true, 'box', 0, true],
			[serverDetached, 'app wt\'s "detached"', null, false, 'box', 0, true]
		]);
		expect(getRefs(local, 'refs/git-tree/hosts/box/')).toStrictEqual([
			serverHash(serverDetached, 'HEAD') + ' ' + getHostDetachedRef('box', serverDetached),
			serverHash(serverRepo, 'main') + ' ' + getHostBranchesPrefix('box') + 'main',
			serverHash(serverRepo, 'topic') + ' ' + getHostBranchesPrefix('box') + 'topic'
		]);
	});

	it('Should neither fetch nor fire onDidChange when nothing changed', async () => {
		// Setup
		changes = [];
		const spyOnLogCmd = jest.spyOn(logger, 'logCmd');

		// Run
		await refresh();

		// Assert
		expect(spyOnLogCmd.mock.calls.filter((call) => call[0] === 'ssh')).toHaveLength(4); // One status call per valid host
		expect(spyOnLogCmd.mock.calls.filter((call) => call[1][0] === 'fetch')).toHaveLength(0);
		expect(changes).toStrictEqual([]);
	});

	it('Should count the uncommitted changes, and fetch a new commit', async () => {
		// Setup
		ssh(serverScript('cd "$1" && echo three > c && git add c && git commit -q -m three && echo changed > a && echo new > d'), serverRepo);
		changes = [];
		const spyOnLogCmd = jest.spyOn(logger, 'logCmd');

		// Run
		await refresh();

		// Assert
		const box = remoteHosts.getHosts(local)[0];
		expect(box.worktrees[0].uncommittedChanges).toBe(2);
		expect(box.worktrees[0].worktree.head).toBe(serverHash(serverRepo, 'main'));
		expect(box.worktrees[0].commitIsLocal).toBe(true);
		expect(git(local, ['rev-parse', getHostBranchesPrefix('box') + 'main'])).toBe(serverHash(serverRepo, 'main'));
		expect(spyOnLogCmd.mock.calls.filter((call) => call[1][0] === 'fetch')).toHaveLength(1);
		expect(changes).toContain(local);
	});

	it('Should show the hosts in the view load, through DataSource with the engine and with Git', async () => {
		// Setup
		const loaded = loadEngine(logger);
		if ('error' in loaded) throw new Error(loaded.error);
		const subscribe = () => ({ dispose: () => { } });
		const mainHash = serverHash(serverRepo, 'main');
		for (const engine of [loaded.engine, null]) {
			const dataSource = new DataSource(gitExecutable, subscribe, subscribe, logger, engine, null, remoteHosts);
			try {
				// Run
				const info = await dataSource.getRepoInfo(local, true, true, []);
				const data = await dataSource.getCommits(local, null, 300, true, true, false, false, CommitOrdering.Date, info.remotes, [], info.stashes, info.worktrees);

				// Assert
				expect(info.error).toBe(null);
				const boxWorktrees = info.worktrees.filter((worktree) => worktree.host === 'box');
				expect(boxWorktrees.map((worktree) => [worktree.path, worktree.head, worktree.isCurrent])).toStrictEqual([[serverRepo, mainHash, false], [serverDetached, serverHash(serverDetached, 'HEAD'), false]]);
				expect(info.hosts.find((host) => host.name === 'box')!.state).toBe('ok');
				expect(data.error).toBe(null);
				// The server's new commit is in the graph, labelled with the host's branch, and its changes have their own row
				const top = data.commits.find((commit) => commit.hash === mainHash)!;
				expect(top.hostBranches).toStrictEqual([{ host: 'box', name: 'main' }, { host: 'box', name: 'topic' }].filter((branch) => serverHash(serverRepo, branch.name) === mainHash));
				const row = data.commits.find((commit) => commit.host === 'box' && commit.parents[0] === mainHash)!;
				expect(row.message).toBe('Uncommitted Changes (2)');
				// The detached worktree's commit, on no branch, is in the graph too
				expect(data.commits.some((commit) => commit.hash === serverHash(serverDetached, 'HEAD'))).toBe(true);
			} finally {
				dataSource.dispose();
			}
		}
	});

	it('Should count untracked files only with showUntrackedFiles', async () => {
		// Setup
		vscode.mockExtensionSettingReturnValue('repository.showUntrackedFiles', false);

		// Run
		await refresh();

		// Assert
		expect(remoteHosts.getHosts(local)[0].worktrees[0].uncommittedChanges).toBe(1);
	});

	it('Should create and remove a worktree on the server', async () => {
		// Run
		const created = await remoteHosts.createWorktree(local, 'box', '.worktrees/feature x', 'main', 'feature');
		await refresh();

		// Assert
		expect(created).toBeNull();
		const worktree = remoteHosts.getHosts(local)[0].worktrees.find((worktree) => worktree.worktree.name === 'feature x');
		expect(worktree).toBeDefined();
		expect(worktree!.worktree.path).toBe(serverRepo + '/.worktrees/feature x');
		expect(worktree!.worktree.branch).toBe('feature');
		expect(ssh(serverScript('tail -n 1 "$1/.git/info/exclude"'), serverRepo)).toBe('/.worktrees/\n');
		expect(git(local, ['rev-parse', getHostBranchesPrefix('box') + 'feature'])).toBe(serverHash(serverRepo, 'main'));

		// Run
		const removed = await remoteHosts.removeWorktree(local, 'box', serverRepo + '/.worktrees/feature x', false);
		await refresh();

		// Assert
		expect(removed).toBeNull();
		expect(remoteHosts.getHosts(local)[0].worktrees.map((worktree) => worktree.worktree.name)).toStrictEqual(['app', 'app wt\'s "detached"']);
	});

	it('Should report a worktree that can\'t be created', async () => {
		// Run
		const result = await remoteHosts.createWorktree(local, 'box', serverRoot + '/never', 'no-such-branch', null);

		// Assert
		expect(result).toMatch(/^Git Tree couldn't create the worktree on "box": .*no-such-branch/);
	});

	it('Should delete the ref of a detached worktree that\'s gone', async () => {
		// Setup
		ssh(serverScript('cd "$1" && git worktree remove --force "$2"'), serverRepo, serverDetached);

		// Run
		await refresh();

		// Assert
		expect(getRefs(local, 'refs/git-tree/hosts/box/detached/')).toStrictEqual([]);
		expect(remoteHosts.getHosts(local)[0].worktrees).toHaveLength(1);
	});

	it('Should add a host after checking it, keeping the file\'s comments, and remove it with its refs', async () => {
		// Run
		const wrongProject = await remoteHosts.saveHost(local, null, entry('second', serverOther));
		const added = await remoteHosts.saveHost(local, null, entry('second', serverRepo));
		await refresh();

		// Assert
		expect(wrongProject).toMatch(/shares no root commit with this one/);
		expect(added).toBeNull();
		const text = fs.readFileSync(path.join(local, CONFIG_FILE), 'utf8');
		expect(text).toBe(configText + '  second:\n    ssh: gt-test\n    path: ' + serverRepo + '\n');
		expect(fs.readFileSync(path.join(local, '.git', 'info', 'exclude'), 'utf8')).toMatch(/\n\/\.worktrees\/\n$/);
		expect(remoteHosts.getHosts(local).find((host) => host.host.name === 'second')!.host.state).toBe('ok');
		expect(getRefs(local, 'refs/git-tree/hosts/second/')).not.toStrictEqual([]);

		// Run
		const removed = await remoteHosts.removeHost(local, 'second');

		// Assert
		expect(removed).toBeNull();
		expect(getRefs(local, 'refs/git-tree/hosts/second/')).toStrictEqual([]);
		expect(remoteHosts.getHosts(local).map((host) => host.host.name)).not.toContain('second');
		expect(fs.readFileSync(path.join(local, CONFIG_FILE), 'utf8')).toBe(configText);
	});

	it('Should list the folders on the server, each with its kind', async () => {
		// Setup
		ssh(serverScript(
			'mkdir -p "$1/browse/plain" "$1/browse/.hidden" "$1/browse/linked" "$1/browse/it\'s here"',
			'git init -q "$1/browse/repo"',
			'echo "gitdir: $1/app/.git/worktrees/linked" > "$1/browse/linked/.git"',
			'touch "$1/browse/file"',
			'ln -s "$1/browse" "$1/browse-link"'
		), serverRoot);

		// Run
		const listing = await remoteHosts.browse('gt-test', serverRoot + '/browse-link');
		const home = await remoteHosts.browse('gt-test', null);
		const missing = await remoteHosts.browse('gt-test', serverRoot + '/missing');
		const down = await remoteHosts.browse('gt-test-down', null);

		// Assert
		expect(listing).toStrictEqual({
			path: serverRoot + '/browse',
			parent: serverRoot,
			entries: [
				{ name: '.hidden', kind: 'folder' },
				{ name: 'it\'s here', kind: 'folder' },
				{ name: 'linked', kind: 'worktree' },
				{ name: 'plain', kind: 'folder' },
				{ name: 'repo', kind: 'repository' }
			],
			truncated: false
		});
		expect(home).toStrictEqual(expect.objectContaining({ path: '/home/dev', parent: '/home' }));
		expect(missing).toStrictEqual({ error: 'gt-test:' + serverRoot + '/missing doesn\'t exist, or isn\'t a folder Git Tree can enter.' });
		expect(down).toStrictEqual({ error: expect.stringMatching(/^Git Tree couldn't connect to "gt-test-down"\. .*Connection refused/) });
	});

	it('Should check a host: the main worktree of the same project', async () => {
		// Run
		ssh(serverScript('git -C "$1" worktree add -q --detach "$2" HEAD'), serverRepo, serverRoot + '/linked');
		const linked = await remoteHosts.checkHost(local, 'gt-test', serverRoot + '/linked');
		const inside = await remoteHosts.checkHost(local, 'gt-test', serverRepo + '/.git');
		const other = await remoteHosts.checkHost(local, 'gt-test', serverOther);
		const good = await remoteHosts.checkHost(local, 'gt-test', serverRepo);
		ssh(serverScript('git -C "$1" worktree remove --force "$2"'), serverRepo, serverRoot + '/linked');

		// Assert
		expect(linked).toBe('gt-test:' + serverRoot + '/linked isn\'t the main worktree of its repository. Use the main worktree\'s path, ' + serverRepo + ', and Git Tree shows the linked worktrees with it.');
		expect(inside).toMatch(/isn't the main worktree of its repository/);
		expect(other).toMatch(/shares no root commit with this one/);
		expect(good).toBeNull();
	});

	it('Should create a repository on the server by pushing this one\'s branches, which checks out the current branch', async () => {
		// Setup
		const pushed = serverRoot + '/new/pushed';
		git(local, ['branch', 'extra', 'HEAD']);

		// Run
		const full = await remoteHosts.createRepository(local, entry('pushed', serverRoot + '/browse'), { kind: 'push' });
		const result = await remoteHosts.createRepository(local, entry('pushed', pushed), { kind: 'push' });
		await refresh();

		// Assert
		expect(full).toBe('gt-test:' + serverRoot + '/browse already exists, and isn\'t an empty folder. Choose a new folder, or add the repository that\'s there.');
		expect(result).toBeNull();
		expect(ssh(serverScript('cd "$1"', 'git symbolic-ref HEAD', 'git rev-parse HEAD', 'git status --porcelain', 'git for-each-ref --format="%(refname)" refs/heads', 'cat a', 'git config --get receive.denyCurrentBranch || echo unset'), pushed))
			.toBe('refs/heads/main\n' + git(local, ['rev-parse', 'main']) + '\nrefs/heads/extra\nrefs/heads/main\none\nunset\n');
		expect(fs.readFileSync(path.join(local, CONFIG_FILE), 'utf8')).toBe(configText + '  pushed:\n    ssh: gt-test\n    path: ' + pushed + '\n');
		expect(remoteHosts.getHosts(local).find((host) => host.host.name === 'pushed')!.host.state).toBe('ok');

		// Clean up
		expect(await remoteHosts.removeHost(local, 'pushed')).toBeNull();
		git(local, ['branch', '-D', 'extra']);
	});

	it('Should clone on the server only with the agent forwarded, and run fetch and pull there with it', async () => {
		// Setup: a private agent with the test key, and a remote that the server reaches as dev@localhost
		const cloned = serverRoot + '/cloned';
		startAgent();
		git(local, ['remote', 'add', 'server-local', 'dev@localhost:' + serverRepo]);

		// Run
		const withoutAgent = await remoteHosts.createRepository(local, entry('cloned', cloned), { kind: 'clone', remote: 'server-local' });
		const withAgent = await remoteHosts.createRepository(local, entry('cloned', cloned, true), { kind: 'clone', remote: 'server-local' });
		await refresh();

		// Assert
		expect(withoutAgent).toMatch(/^Git Tree couldn't clone server-local into gt-test:.*\/cloned: .*Permission denied/);
		expect(withAgent).toBeNull();
		expect(ssh(serverScript('git -C "$1" rev-parse HEAD'), cloned).trim()).toBe(serverHash(serverRepo, 'main'));
		expect(fs.readFileSync(path.join(local, CONFIG_FILE), 'utf8')).toBe(configText + '  cloned:\n    ssh: gt-test\n    path: ' + cloned + '\n    forwardAgent: true\n');
		expect(remoteHosts.getHosts(local).find((host) => host.host.name === 'cloned')!.host.state).toBe('ok');

		// Run: a new commit where the clone came from, then a fetch and a pull in the clone
		ssh(serverScript('cd "$1" && git commit -q --allow-empty -m four'), serverRepo);
		const fetched = await remoteHosts.runGitOnHost(local, 'cloned', cloned, 'fetch');
		const originMain = ssh(serverScript('git -C "$1" rev-parse origin/main'), cloned).trim();
		const pulled = await remoteHosts.runGitOnHost(local, 'cloned', cloned, 'pull');
		await refresh();

		// Assert
		expect(fetched).toBeNull();
		expect(originMain).toBe(serverHash(serverRepo, 'main'));
		expect(pulled).toBeNull();
		expect(ssh(serverScript('git -C "$1" rev-parse HEAD'), cloned).trim()).toBe(serverHash(serverRepo, 'main'));
		expect(git(local, ['rev-parse', getHostBranchesPrefix('cloned') + 'main'])).toBe(serverHash(serverRepo, 'main'));

		// Run: the same fetch with forwardAgent off fails, because the server has no key of its own
		stopAgent();
		startAgent();
		expect(await remoteHosts.saveHost(local, 'cloned', entry('cloned', cloned, false))).toBeNull();
		const unforwarded = await remoteHosts.runGitOnHost(local, 'cloned', cloned, 'fetch');

		// Assert
		expect(unforwarded).toMatch(/^Git Tree couldn't run git fetch --all --prune in .*\/cloned on "cloned": .*Permission denied/);

		// Clean up
		stopAgent();
		expect(await remoteHosts.removeHost(local, 'cloned')).toBeNull();
		git(local, ['remote', 'remove', 'server-local']);
	});

	it('Should refuse to pull when it isn\'t a fast-forward, and push from the server', async () => {
		// Setup: the box host gets a remote on the server itself, so no agent is needed
		ssh(serverScript('git clone -q --bare "$1" "$2"', 'cd "$1" && git remote add up "$2" && git fetch -q up && git branch -q -u up/main main'), serverRepo, serverRoot + '/up.git');
		await refresh();
		ssh(serverScript('cd "$1" && git commit -q --allow-empty -m local-only'), serverRepo);
		ssh(serverScript('git clone -q "$1" "$2"', 'cd "$2" && git commit -q --allow-empty -m upstream-only && git push -q origin HEAD:main'), serverRoot + '/up.git', serverRoot + '/up-work');

		// Run
		const pulled = await remoteHosts.runGitOnHost(local, 'box', serverRepo, 'pull');
		const fetched = await remoteHosts.runGitOnHost(local, 'box', serverRepo, 'fetch');

		// Assert
		expect(pulled).toMatch(/^Git Tree couldn't run git pull --ff-only in .*\/app on "box": .*(Not possible to fast-forward|diverging)/i);
		expect(fetched).toBeNull();

		// Run
		ssh(serverScript('cd "$1" && git reset -q --hard up/main && git commit -q --allow-empty -m to-push'), serverRepo);
		const pushed = await remoteHosts.runGitOnHost(local, 'box', serverRepo, 'push');

		// Assert
		expect(pushed).toBeNull();
		expect(serverHash(serverRoot + '/up.git', 'main')).toBe(serverHash(serverRepo, 'main'));
	});

	it('Should show a host whose key the server refuses as needing authentication', async () => {
		// Setup (last, because the server may refuse new connections from this machine for a while after a failed login)
		fs.writeFileSync(path.join(local, CONFIG_FILE), configText + '  nokey:\n    ssh: gt-test-nokey\n    path: ' + serverRepo + '\n');

		// Run
		await refresh();

		// Assert
		const nokey = remoteHosts.getHosts(local).find((host) => host.host.name === 'nokey')!;
		expect(nokey.host.state).toBe('needsAuthentication');
		expect(nokey.host.message).toMatch(/Permission denied/);
	});


	/* Helpers */

	function entry(name: string, serverPath: string, forwardAgent: boolean = false): RemoteHostEntry {
		return { name: name, ssh: 'gt-test', path: serverPath, worktrees: true, forwardAgent: forwardAgent };
	}

	/**
	 * Start a private ssh-agent that holds only the test key, and point the wrapper's SSH_AUTH_SOCK at it.
	 */
	function startAgent() {
		const socket = path.join(tmp, 'agent-' + Date.now() + '.sock');
		const output = cp.execFileSync('ssh-agent', ['-s', '-a', socket], { encoding: 'utf8' });
		const pid = output.match(/SSH_AGENT_PID=(\d+)/);
		if (pid === null) throw new Error('ssh-agent didn\'t print its PID.');
		agentPid = parseInt(pid[1], 10);
		const key = path.join(path.dirname(SSH_CONFIG), 'id_test');
		cp.execFileSync('ssh-add', ['-q', key], { env: Object.assign({}, process.env, { SSH_AUTH_SOCK: socket }), stdio: 'ignore' });
		fs.writeFileSync(agentFile, socket);
	}

	/**
	 * Kill the private ssh-agent, and leave the wrapper without an agent.
	 */
	function stopAgent() {
		if (agentPid !== null) {
			try {
				process.kill(agentPid);
			} catch (_) { }
			agentPid = null;
		}
		if (typeof agentFile === 'string') fs.writeFileSync(agentFile, '');
	}

	/**
	 * Refresh the local repository's hosts, and wait until every refresh finished.
	 */
	async function refresh() {
		remoteHosts.refresh(local);
		await new Promise((resolve) => setTimeout(resolve, 50));
		const deadline = Date.now() + 60000;
		while (Date.now() < deadline) {
			const entries = <Map<string, { hosts: { refreshing: boolean }[], loading: Promise<void> | null }>>remoteHosts['entries'];
			const busy = Array.from(entries.values()).some((entry) => entry.loading !== null || entry.hosts.some((host) => host.refreshing));
			if (!busy && entries.size > 0) return;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		throw new Error('The refresh didn\'t finish within 60 seconds.');
	}

	/**
	 * Run a script on the test server, over a connection of the tests' own, so the server doesn't limit the logins.
	 */
	function ssh(script: string, ...args: string[]) {
		const options = ['-o', 'BatchMode=yes', '-o', 'ControlMaster=auto', '-o', 'ControlPersist=60', '-o', 'ControlPath=' + path.join(tmp, 'cm-%C')];
		return cp.execFileSync(wrapper, options.concat(['gt-test', 'sh -s -- ' + args.map((arg) => '\'' + arg.replace(/'/g, '\'\\\'\'') + '\'').join(' ')]), { input: script, encoding: 'utf8' });
	}

	function serverHash(repo: string, rev: string) {
		return ssh(serverScript('git -C "$1" rev-parse "$2"'), repo, rev).trim();
	}

	function git(cwd: string, args: string[]) {
		return cp.execFileSync('git', args, { cwd: cwd, encoding: 'utf8', env: Object.assign({}, process.env, { GIT_SSH_COMMAND: '\'' + wrapper + '\' -o BatchMode=yes' }) }).trim();
	}

	function getRefs(repo: string, prefix: string) {
		return git(repo, ['for-each-ref', '--format=%(objectname) %(refname)', prefix]).split('\n').filter((line) => line !== '');
	}
});

/**
 * Get a script for the test server, which stops at the first error.
 * @param lines The script's lines.
 */
function serverScript(...lines: string[]) {
	return ['set -e', 'export GIT_AUTHOR_NAME=Test GIT_AUTHOR_EMAIL=test@example.com GIT_COMMITTER_NAME=Test GIT_COMMITTER_EMAIL=test@example.com'].concat(lines).join('\n') + '\n';
}

/**
 * Get an alias that copies the `gt-test` alias of an SSH configuration, with some options first (the first value of
 * an option wins).
 * @param config The SSH configuration.
 * @param name The new alias.
 * @param options The options that differ.
 */
function getAlias(config: string, name: string, options: string[]) {
	const match = config.match(/^Host gt-test\s*\n((?:[ \t]+.*\n?)*)/m);
	if (match === null) throw new Error('The SSH configuration has no "Host gt-test".');
	return 'Host ' + name + '\n' + options.map((option) => '  ' + option + '\n').join('') + match[1];
}
