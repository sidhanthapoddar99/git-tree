import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { STATUS_SCRIPT, getServerWorktrees, getStatusScriptArgs, parseStatusOutput } from '../src/remoteHosts/status';

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40), R = '1'.repeat(40);

function output(...lines: string[]) {
	return lines.join('\n') + '\n';
}

const OK = output(
	'gt:tips',
	A + ' refs/heads/main',
	B + ' refs/heads/feature/x',
	'gt:roots',
	R,
	'gt:worktrees',
	'worktree /srv/app',
	'HEAD ' + A,
	'branch refs/heads/main',
	'',
	'worktree /srv/app wt\'s "x"',
	'HEAD ' + C,
	'detached',
	'locked',
	'',
	'worktree /srv/gone',
	'HEAD ' + B,
	'branch refs/heads/feature/x',
	'prunable gitdir file points to non-existent location',
	'gt:status',
	'3 /srv/app',
	'0 /srv/app wt\'s "x"',
	'-1 /srv/gone',
	'gt:end'
);

describe('getStatusScriptArgs', () => {
	it('Should pass the path and the fixed values', () => {
		expect(getStatusScriptArgs('/srv/app', true, true, false)).toStrictEqual(['/srv/app', 'all', 'yes', 'no']);
		expect(getStatusScriptArgs('/srv/app', false, false, true)).toStrictEqual(['/srv/app', 'no', 'no', 'yes']);
	});
});

describe('parseStatusOutput', () => {
	it('Should parse the tips, roots, worktrees and counts', () => {
		// Run
		const status = parseStatusOutput(OK);

		// Assert
		expect(status).toStrictEqual({
			kind: 'ok',
			tips: [{ ref: 'refs/heads/main', hash: A }, { ref: 'refs/heads/feature/x', hash: B }],
			roots: [R],
			worktrees: [
				{ path: '/srv/app', head: A, branch: 'refs/heads/main', bare: false, locked: false, prunable: false },
				{ path: '/srv/app wt\'s "x"', head: C, branch: null, bare: false, locked: true, prunable: false },
				{ path: '/srv/gone', head: B, branch: 'refs/heads/feature/x', bare: false, locked: false, prunable: true }
			],
			counts: new Map<string, number | null>([['/srv/app', 3], ['/srv/app wt\'s "x"', 0], ['/srv/gone', null]])
		});
	});

	it('Should parse an answer without roots or branches', () => {
		// Run
		const status = parseStatusOutput(output('gt:tips', 'gt:worktrees', 'worktree /srv/app', 'HEAD ' + '0'.repeat(40), 'branch refs/heads/main', '', 'gt:status', '0 /srv/app', 'gt:end'));

		// Assert
		expect(status).toStrictEqual({
			kind: 'ok', tips: [], roots: null,
			worktrees: [{ path: '/srv/app', head: '0'.repeat(40), branch: 'refs/heads/main', bare: false, locked: false, prunable: false }],
			counts: new Map([['/srv/app', 0]])
		});
	});

	it('Should ignore what a login shell prints before the answer', () => {
		// Run
		const status = parseStatusOutput('Welcome to the build box!\nLast login: today\n' + OK);

		// Assert
		expect(status.kind).toBe('ok');
	});

	it('Should parse a server without Git, a missing path, and a folder that isn\'t a repository', () => {
		expect(parseStatusOutput('gt:nogit\n')).toStrictEqual({ kind: 'noGit' });
		expect(parseStatusOutput('gt:nopath\n')).toStrictEqual({ kind: 'noPath' });
		expect(parseStatusOutput('gt:norepo\nfatal: not a git repository (or any of the parent directories): .git\n')).toStrictEqual({ kind: 'notARepository', message: 'fatal: not a git repository (or any of the parent directories): .git' });
	});

	const unreadable: [string, string][] = [
		['nothing', ''],
		['an answer cut short', OK.substring(0, OK.indexOf('gt:status'))],
		['an answer without its end', OK.replace('gt:end\n', '')],
		['sections out of order', OK.replace('gt:tips', 'gt:x').replace('gt:roots', 'gt:tips')],
		['a bad tip', OK.replace(A + ' refs/heads/main', 'xyz refs/heads/main')],
		['a tip that isn\'t a branch', OK.replace(A + ' refs/heads/main', A + ' refs/tags/v1')],
		['a bad root', OK.replace(R, 'not-a-hash')],
		['a bad count', OK.replace('3 /srv/app', 'three /srv/app')],
		['no worktrees', output('gt:tips', 'gt:worktrees', 'gt:status', 'gt:end')]
	];
	unreadable.forEach(([name, text]) => {
		it('Should not trust ' + name, () => {
			expect(parseStatusOutput(text)).toStrictEqual({ kind: 'unreadable' });
		});
	});
});

describe('getServerWorktrees', () => {
	const status = parseStatusOutput(OK);
	if (status.kind !== 'ok') throw new Error('The test answer must parse');

	it('Should keep the server\'s POSIX paths, and mark the host', () => {
		// Run
		const worktrees = getServerWorktrees('box', status.worktrees, status.counts, true);

		// Assert
		expect(worktrees).toStrictEqual([
			{ worktree: { path: '/srv/app', name: 'app', head: A, branch: 'main', isMain: true, isCurrent: false, locked: false, prunable: false, host: 'box' }, uncommittedChanges: 3 },
			{ worktree: { path: '/srv/app wt\'s "x"', name: 'app wt\'s "x"', head: C, branch: null, isMain: false, isCurrent: false, locked: true, prunable: false, host: 'box' }, uncommittedChanges: 0 },
			{ worktree: { path: '/srv/gone', name: 'gone', head: B, branch: 'feature/x', isMain: false, isCurrent: false, locked: false, prunable: true, host: 'box' }, uncommittedChanges: null }
		]);
	});

	it('Should include only the main worktree when "worktrees" is false', () => {
		// Run
		const worktrees = getServerWorktrees('box', status.worktrees, status.counts, false);

		// Assert
		expect(worktrees.map((worktree) => worktree.worktree.path)).toStrictEqual(['/srv/app']);
	});

	it('Should leave out a bare main repository, and give a branch without commits no HEAD', () => {
		// Run
		const worktrees = getServerWorktrees('box', [
			{ path: '/srv/app.git', head: null, branch: null, bare: true, locked: false, prunable: false },
			{ path: '/srv/new', head: '0'.repeat(40), branch: 'refs/heads/new', bare: false, locked: false, prunable: false }
		], new Map(), true);

		// Assert
		expect(worktrees).toStrictEqual([
			{ worktree: { path: '/srv/new', name: 'new', head: null, branch: 'new', isMain: false, isCurrent: false, locked: false, prunable: false, host: 'box' }, uncommittedChanges: null }
		]);
	});
});

describe('STATUS_SCRIPT', () => {
	// The script, run by a local sh in a real repository: what a server runs after ssh
	const canRun = process.platform !== 'win32' && cp.spawnSync('sh', ['-c', 'command -v git']).status === 0;
	const env = Object.assign({}, process.env, { GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' });
	let tmp: string;

	beforeAll(() => {
		if (!canRun) return;
		tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-tree-status-')));
		const git = (cwd: string, ...args: string[]) => cp.execFileSync('git', args, { cwd: cwd, env: env, encoding: 'utf8' }).trim();
		git(tmp, 'init', '-q', '-b', 'main', 'app');
		const repo = path.join(tmp, 'app');
		fs.writeFileSync(path.join(repo, 'a'), 'a');
		git(repo, 'add', 'a');
		git(repo, 'commit', '-q', '-m', 'one');
		git(repo, 'worktree', 'add', '-q', '--detach', path.join(tmp, 'it\'s a "wt"'), 'HEAD');
		fs.writeFileSync(path.join(repo, 'a'), 'changed');
		fs.writeFileSync(path.join(repo, 'new'), 'new');
		fs.writeFileSync(path.join(tmp, 'it\'s a "wt"', 'new'), 'new');
	});

	afterAll(() => {
		if (canRun) fs.rmSync(tmp, { recursive: true, force: true });
	});

	function run(args: string[]) {
		return cp.spawnSync('sh', ['-s', '--'].concat(args), { input: STATUS_SCRIPT, env: env, encoding: 'utf8' });
	}

	(canRun ? it : it.skip)('Should print what the parser reads', () => {
		// Run
		const result = run(getStatusScriptArgs(path.join(tmp, 'app'), true, true, true));
		const status = parseStatusOutput(result.stdout);

		// Assert
		expect(result.status).toBe(0);
		if (status.kind !== 'ok') throw new Error('Unexpected answer: ' + result.stdout);
		expect(status.tips.map((tip) => tip.ref)).toStrictEqual(['refs/heads/main']);
		expect(status.roots).toStrictEqual([status.tips[0].hash]);
		expect(status.worktrees.map((worktree) => worktree.path)).toStrictEqual([path.join(tmp, 'app'), path.join(tmp, 'it\'s a "wt"')]);
		expect(status.counts).toStrictEqual(new Map([[path.join(tmp, 'app'), 2], [path.join(tmp, 'it\'s a "wt"'), 1]]));
	});

	(canRun ? it : it.skip)('Should count only tracked changes, only in the main worktree, without roots, when asked', () => {
		// Run
		const status = parseStatusOutput(run(getStatusScriptArgs(path.join(tmp, 'app'), false, false, false)).stdout);

		// Assert
		if (status.kind !== 'ok') throw new Error('Unexpected answer');
		expect(status.roots).toBeNull();
		expect(status.counts).toStrictEqual(new Map([[path.join(tmp, 'app'), 1]]));
	});

	(canRun ? it : it.skip)('Should say when the path is missing, or isn\'t a repository', () => {
		// Run
		const missing = run(getStatusScriptArgs(path.join(tmp, 'missing'), true, true, false));
		fs.mkdirSync(path.join(tmp, 'plain'));
		const plain = run(getStatusScriptArgs(path.join(tmp, 'plain'), true, true, false));

		// Assert
		expect(missing.status).toBe(3);
		expect(parseStatusOutput(missing.stdout)).toStrictEqual({ kind: 'noPath' });
		expect(plain.status).toBe(4);
		expect(parseStatusOutput(plain.stdout)).toStrictEqual({ kind: 'notARepository', message: expect.stringMatching(/^fatal: not a git repository/) });
	});
});
