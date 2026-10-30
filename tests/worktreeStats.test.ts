import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runProcess } from '../src/remoteHosts/ssh';
import { ManagedHostGit, ManagedHostSizes } from '../src/types';
import { FACTS_SCRIPT, FAST_FORWARD_SCRIPT, RepoFacts, SIZES_SCRIPT, SizeTarget, WorktreeFacts, WorktreeStats, WorktreeStatsAnswer, getFastForwardRefusal, getMainBranchCandidates, getManagedHostGit, getOwnSizes, parseDfOutput, parseDuOutput, parseFactsOutput, parseSizesOutput, planSizeReads, resolveMainBranch } from '../src/worktreeStats';

const A = 'a'.repeat(40), B = 'b'.repeat(40);

function facts(custom: Partial<WorktreeFacts> & { branch?: string | null } = {}): WorktreeFacts {
	const branch = typeof custom.branch !== 'undefined' ? custom.branch : 'refs/heads/feature';
	return Object.assign({
		entry: { path: '/repo/.worktrees/feature', head: A, branch: branch, bare: false, locked: false, prunable: false },
		isMain: false,
		physicalPath: '/repo/.worktrees/feature',
		changes: 0,
		counts: new Map([['refs/heads/main', { ahead: 0, behind: 2 }]])
	}, custom);
}

describe('parseDuOutput', () => {
	it('Should read each folder\'s size, with tabs and spaces in its path', () => {
		// Run
		const totals = parseDuOutput('52\t/srv/app/node_modules\n196\t/srv/app/.worktrees/my wt\n8\t/srv/app/a\tb\n644\t/srv/app\n\nnot a line\n');

		// Assert
		expect(totals).toStrictEqual(new Map([['/srv/app/node_modules', 52], ['/srv/app/.worktrees/my wt', 196], ['/srv/app/a\tb', 8], ['/srv/app', 644]]));
	});
});

describe('parseDfOutput', () => {
	it('Should read GNU df', () => {
		expect(parseDfOutput('Filesystem     1024-blocks      Used Available Capacity Mounted on\n/dev/nvme0n1p2   491134216 123456789 342345678      27% /\n')).toStrictEqual({ total: 491134216, used: 123456789, free: 342345678 });
	});

	it('Should read macOS df, whose names and mount points may hold spaces and digits', () => {
		expect(parseDfOutput('Filesystem   1024-blocks      Used Available Capacity  Mounted on\n/dev/disk3s5   971350180 412345678 512345678    45%    /System/Volumes/Data\n')).toStrictEqual({ total: 971350180, used: 412345678, free: 512345678 });
		expect(parseDfOutput('Filesystem 1024-blocks Used Available Capacity Mounted on\n//me@nas/share 2 1000 400 600 40% /Volumes/My Disk 2\n')).toStrictEqual({ total: 1000, used: 400, free: 600 });
	});

	it('Should return NULL when no line can be read', () => {
		expect(parseDfOutput('')).toBeNull();
		expect(parseDfOutput('df: /missing: No such file or directory\n')).toBeNull();
	});
});

describe('Sizes without double counting', () => {
	const targets: SizeTarget[] = [
		{ key: '/repo', path: '/repo' },
		{ key: '/repo/.worktrees/a', path: '/repo/.worktrees/a' },
		{ key: '/repo/.worktrees/a/inner', path: '/repo/.worktrees/a/inner' },
		{ key: '/elsewhere/b', path: '/elsewhere/b' },
		{ key: '/repo/.git', path: '/repo/.git' }
	];

	it('Should read each folder that isn\'t inside another, deep enough for the folders inside it', () => {
		expect(planSizeReads(targets)).toStrictEqual([{ path: '/repo', depth: 3 }, { path: '/elsewhere/b', depth: 0 }]);
	});

	it('Should take from each folder only the folders directly inside it', () => {
		// Setup
		const totals = new Map([['/repo', 1000], ['/repo/.worktrees/a', 300], ['/repo/.worktrees/a/inner', 100], ['/elsewhere/b', 50], ['/repo/.git', 400]]);

		// Run
		const sizes = getOwnSizes(targets, totals);

		// Assert
		expect(sizes).toStrictEqual(new Map([['/repo', 300], ['/repo/.worktrees/a', 200], ['/repo/.worktrees/a/inner', 100], ['/elsewhere/b', 50], ['/repo/.git', 400]]));
	});

	it('Should not give a size it can\'t work out', () => {
		// Run
		const sizes = getOwnSizes(targets, new Map([['/repo', 1000], ['/repo/.worktrees/a/inner', 100], ['/elsewhere/b', 50], ['/repo/.git', 400]]));

		// Assert
		expect(sizes.get('/repo')).toBeNull();
		expect(sizes.get('/repo/.worktrees/a')).toBeNull();
		expect(sizes.get('/repo/.git')).toBe(400);
	});
});

describe('parseSizesOutput', () => {
	it('Should split what df and du printed, and notice a du that failed', () => {
		// Run
		const output = parseSizesOutput('Welcome\ngt:df\nFilesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100 40 60 40% /\ngt:du\n10\t/srv/app/.git\n30\t/srv/app\ngt:partial\n5\t/srv/b\ngt:end\n');

		// Assert
		expect(output).toStrictEqual({
			df: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100 40 60 40% /\n',
			totals: new Map([['/srv/app/.git', 10], ['/srv/app', 30], ['/srv/b', 5]]),
			partial: true
		});
		expect(parseSizesOutput('gt:df\ngt:du\ngt:end\n')).toStrictEqual({ df: '', totals: new Map(), partial: false });
		expect(parseSizesOutput('gt:df\n')).toBeNull();
	});
});

describe('The main branch', () => {
	it('Should list the candidates once each', () => {
		expect(getMainBranchCandidates('refs/remotes/origin/trunk')).toStrictEqual(['refs/heads/trunk', 'refs/heads/main', 'refs/heads/master']);
		expect(getMainBranchCandidates('refs/remotes/origin/main')).toStrictEqual(['refs/heads/main', 'refs/heads/master']);
		expect(getMainBranchCandidates(null)).toStrictEqual(['refs/heads/main', 'refs/heads/master']);
	});

	it('Should use the local branch that origin/HEAD points to', () => {
		expect(resolveMainBranch('refs/remotes/origin/trunk', ['refs/heads/trunk', 'refs/heads/main'])).toStrictEqual({ branch: 'trunk' });
	});

	it('Should not guess when origin/HEAD names a branch with no local branch', () => {
		expect(resolveMainBranch('refs/remotes/origin/trunk', ['refs/heads/main'])).toStrictEqual({ error: 'origin/HEAD points to origin/trunk, but there\'s no local branch "trunk".' });
		expect(resolveMainBranch('refs/remotes/upstream/main', ['refs/heads/main'])).toStrictEqual({ error: 'origin/HEAD points to refs/remotes/upstream/main, which isn\'t a branch of origin.' });
	});

	it('Should use main, then master, when origin/HEAD isn\'t set', () => {
		expect(resolveMainBranch(null, ['refs/heads/main', 'refs/heads/master'])).toStrictEqual({ branch: 'main' });
		expect(resolveMainBranch(null, ['refs/heads/master'])).toStrictEqual({ branch: 'master' });
	});

	it('Should say when there\'s no main branch', () => {
		expect(resolveMainBranch(null, [])).toStrictEqual({ error: 'There\'s no main branch: origin/HEAD isn\'t set, and there\'s no local main or master branch.' });
	});
});

describe('getFastForwardRefusal', () => {
	const main = { branch: 'main' };

	it('Should allow a clean branch that main is ahead of', () => {
		expect(getFastForwardRefusal(facts(), main)).toBeNull();
	});

	it('Should refuse without a main branch', () => {
		expect(getFastForwardRefusal(facts(), { error: 'No main' })).toBe('No main');
	});

	it('Should refuse a worktree whose folder is missing', () => {
		expect(getFastForwardRefusal(facts({ physicalPath: null }), main)).toBe('The worktree\'s folder is missing');
	});

	it('Should refuse a worktree whose status couldn\'t be read', () => {
		expect(getFastForwardRefusal(facts({ changes: null }), main)).toBe('Git couldn\'t read the worktree\'s status');
	});

	it('Should refuse uncommitted changes, untracked files included', () => {
		expect(getFastForwardRefusal(facts({ changes: 1 }), main)).toBe('1 uncommitted change');
		expect(getFastForwardRefusal(facts({ changes: 3 }), main)).toBe('3 uncommitted changes');
	});

	it('Should refuse a detached HEAD', () => {
		expect(getFastForwardRefusal(facts({ branch: null }), main)).toBe('Detached HEAD: check out a branch first');
	});

	it('Should refuse the main branch itself', () => {
		expect(getFastForwardRefusal(facts({ branch: 'refs/heads/main' }), main)).toBe('This is the main branch');
	});

	it('Should refuse a branch that has diverged', () => {
		expect(getFastForwardRefusal(facts({ counts: new Map([['refs/heads/main', { ahead: 1, behind: 2 }]]) }), main)).toBe('Diverged from main');
	});

	it('Should refuse a branch that is only ahead of main', () => {
		expect(getFastForwardRefusal(facts({ counts: new Map([['refs/heads/main', { ahead: 2, behind: 0 }]]) }), main)).toBe('2 commits ahead of main, so there\'s nothing to fast-forward');
	});

	it('Should refuse a branch that is up to date', () => {
		expect(getFastForwardRefusal(facts({ counts: new Map([['refs/heads/main', { ahead: 0, behind: 0 }]]) }), main)).toBe('Already up to date');
	});

	it('Should refuse a branch Git couldn\'t compare', () => {
		expect(getFastForwardRefusal(facts({ counts: new Map() }), main)).toBe('Git couldn\'t compare it with main');
	});
});

describe('parseFactsOutput', () => {
	it('Should read the sections and each worktree\'s record', () => {
		// Run
		const output = parseFactsOutput([
			'Last login: today',
			'gt:commondir', '/srv/app/.git',
			'gt:originhead', 'refs/remotes/origin/main',
			'gt:branches', 'refs/heads/main',
			'gt:worktrees',
			'worktree /srv/app', 'HEAD ' + A, 'branch refs/heads/main', '',
			'worktree /srv/app/.worktrees/my wt', 'HEAD ' + B, 'branch refs/heads/feature', '',
			'worktree /srv/gone', 'HEAD ' + B, 'detached', 'prunable gitdir file points to non-existent location', '',
			'gt:wt /srv/app', 'p /data/app', 's 0', 'c refs/heads/main 0\t0',
			'gt:wt /srv/app/.worktrees/my wt', 'p /data/app/.worktrees/my wt', 's 2', 'c refs/heads/main 1\t3',
			'gt:wt /srv/gone',
			'gt:end', ''
		].join('\n'));

		// Assert
		if (output.kind !== 'ok') throw new Error('Unexpected answer: ' + output.kind);
		expect(output.facts.commonDir).toBe('/srv/app/.git');
		expect(output.facts.originHead).toBe('refs/remotes/origin/main');
		expect(output.facts.branches).toStrictEqual(['refs/heads/main']);
		expect(output.facts.worktrees.map((worktree) => [worktree.entry.path, worktree.isMain, worktree.physicalPath, worktree.changes, Array.from(worktree.counts.entries())])).toStrictEqual([
			['/srv/app', true, '/data/app', 0, [['refs/heads/main', { ahead: 0, behind: 0 }]]],
			['/srv/app/.worktrees/my wt', false, '/data/app/.worktrees/my wt', 2, [['refs/heads/main', { ahead: 1, behind: 3 }]]],
			['/srv/gone', false, null, null, []]
		]);
	});

	it('Should read a repository without origin/HEAD or main branch', () => {
		// Run
		const output = parseFactsOutput('gt:commondir\n/srv/app/.git\ngt:originhead\n\ngt:branches\ngt:worktrees\nworktree /srv/app\nHEAD ' + A + '\nbranch refs/heads/dev\n\ngt:wt /srv/app\np /srv/app\ns -1\ngt:end\n');

		// Assert
		if (output.kind !== 'ok') throw new Error('Unexpected answer: ' + output.kind);
		expect(output.facts.originHead).toBeNull();
		expect(output.facts.branches).toStrictEqual([]);
		expect(output.facts.worktrees[0].changes).toBeNull();
		expect(getManagedHostGit(output.facts, 'srv').mainBranchError).toBe('There\'s no main branch: origin/HEAD isn\'t set, and there\'s no local main or master branch.');
	});

	it('Should say what went wrong', () => {
		expect(parseFactsOutput('gt:nogit\n')).toStrictEqual({ kind: 'noGit' });
		expect(parseFactsOutput('gt:nopath\n')).toStrictEqual({ kind: 'noPath' });
		expect(parseFactsOutput('gt:norepo\nfatal: not a git repository\n')).toStrictEqual({ kind: 'notARepository', message: 'fatal: not a git repository' });
		expect(parseFactsOutput('')).toStrictEqual({ kind: 'unreadable' });
		expect(parseFactsOutput('gt:commondir\n/x\ngt:originhead\n\ngt:branches\ngt:worktrees\nworktree /x\n')).toStrictEqual({ kind: 'unreadable' });
		expect(parseFactsOutput('gt:commondir\n/x\ngt:originhead\n\ngt:branches\ngt:worktrees\nworktree /x\n\ngt:wt /x\nnonsense\ngt:end\n')).toStrictEqual({ kind: 'unreadable' });
	});
});

describe('getManagedHostGit', () => {
	it('Should name each worktree, and mark a remote host\'s', () => {
		// Setup
		const repoFacts: RepoFacts = {
			commonDir: '/repo/.git',
			originHead: null,
			branches: ['refs/heads/main'],
			worktrees: [
				facts({ entry: { path: '/repo', head: A, branch: 'refs/heads/main', bare: false, locked: false, prunable: false }, isMain: true, physicalPath: '/repo' }),
				facts(),
				facts({ branch: null, counts: new Map() })
			]
		};

		// Run
		const local = getManagedHostGit(repoFacts, null), remote = getManagedHostGit(repoFacts, 'srv');

		// Assert
		expect(local.mainBranch).toBe('main');
		expect(local.worktrees.map((managed) => [managed.worktree.name, managed.worktree.isMain, managed.worktree.branch, managed.relation, managed.fastForwardRefusal])).toStrictEqual([
			['repo', true, 'main', { kind: 'main' }, 'This is the main branch'],
			['feature', false, 'feature', { kind: 'compared', ahead: 0, behind: 2 }, null],
			['feature', false, null, { kind: 'detached' }, 'Detached HEAD: check out a branch first']
		]);
		expect(local.worktrees[0].worktree).not.toHaveProperty('host');
		expect(remote.worktrees.map((managed) => managed.worktree.host)).toStrictEqual(['srv', 'srv', 'srv']);
	});
});

describe('WorktreeStats, on real repositories', () => {
	// Git, du and df run for real. The remote host's scripts run with a local sh, as a server runs them after ssh.
	const canRun = process.platform !== 'win32' && cp.spawnSync('sh', ['-c', 'command -v git && command -v du && command -v df']).status === 0;
	const env = Object.assign({}, process.env, { GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' });
	const it_ = canRun ? it : it.skip;
	let tmp: string, repo: string, outside: string, stats: WorktreeStats;
	const scriptCalls: { host: string, args: ReadonlyArray<string>, changesHost: boolean }[] = [];

	const git = (cwd: string, ...args: string[]) => cp.execFileSync('git', args, { cwd: cwd, env: env, encoding: 'utf8' }).trim();
	const load = async (host: string | null) => {
		const answers: WorktreeStatsAnswer[] = [];
		await stats.load(repo, host, (answer) => answers.push(answer));
		return answers;
	};
	const withoutHost = (git: ManagedHostGit) => git.worktrees.map((managed) => Object.assign({}, managed, { worktree: Object.assign({}, managed.worktree, { host: undefined }) }));

	beforeAll(() => {
		if (!canRun) return;
		tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-tree-stats-')));
		repo = path.join(tmp, 'app');
		outside = path.join(tmp, 'app-side');
		git(tmp, 'init', '-q', '-b', 'main', 'app');
		fs.writeFileSync(path.join(repo, 'a'), 'a');
		git(repo, 'add', 'a');
		git(repo, 'commit', '-q', '-m', 'one');
		git(repo, 'branch', 'feat');
		git(repo, 'branch', 'feat2');
		git(repo, 'branch', 'side');
		fs.writeFileSync(path.join(repo, 'b'), 'b');
		git(repo, 'add', 'b');
		git(repo, 'commit', '-q', '-m', 'two');
		// As Git Tree creates them: inside the main worktree, in a folder that info/exclude ignores
		fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '/.worktrees/\nbig.bin\n');
		git(repo, 'worktree', 'add', '-q', path.join(repo, '.worktrees', 'feat'), 'feat');
		git(repo, 'worktree', 'add', '-q', path.join(repo, '.worktrees', 'feat2'), 'feat2');
		git(repo, 'worktree', 'add', '-q', '--detach', path.join(repo, '.worktrees', 'det'), 'HEAD');
		git(repo, 'worktree', 'add', '-q', outside, 'side');
		fs.writeFileSync(path.join(outside, 's'), 's');
		git(outside, 'add', 's');
		git(outside, 'commit', '-q', '-m', 'side');
		// Big ignored files, so a size counted twice would show
		fs.writeFileSync(path.join(repo, '.worktrees', 'feat', 'big.bin'), Buffer.alloc(1024 * 1024, 1));
		fs.writeFileSync(path.join(repo, '.git', 'big.bin'), Buffer.alloc(1024 * 1024, 2));

		stats = new WorktreeStats({
			runGit: (args, cwd, timeout) => runProcess('git', args, { cwd: cwd, env: env, timeout: timeout }),
			getGitExecutableError: () => null,
			remoteHosts: {
				runScript: async (_repo, host, script, args, timeout, changesHost) => {
					scriptCalls.push({ host: host, args: args, changesHost: changesHost });
					return { result: await runProcess('sh', ['-s', '--', repo].concat(args), { input: script, env: env, timeout: timeout }) };
				}
			}
		});
	});

	afterAll(() => {
		if (canRun) fs.rmSync(tmp, { recursive: true, force: true });
	});

	it_('Should read this machine\'s worktrees, then their sizes without counting a folder twice', async () => {
		// Run
		const answers = await load(null);

		// Assert
		expect(answers.map((answer) => [answer.part, answer.error])).toStrictEqual([['git', null], ['sizes', null]]);
		const hostGit = answers[0].git!;
		expect(hostGit.mainBranch).toBe('main');
		// Git lists the linked worktrees in an order that depends on its version
		const rows = hostGit.worktrees.map((managed) => [managed.worktree.path, managed.worktree.isMain, managed.worktree.branch, managed.changes, managed.relation, managed.fastForwardRefusal]);
		expect(rows.slice(0, 1).concat(rows.slice(1).sort((a, b) => <string>a[0] < <string>b[0] ? -1 : 1))).toStrictEqual([
			[repo, true, 'main', 0, { kind: 'main' }, 'This is the main branch'],
			[outside, false, 'side', 0, { kind: 'compared', ahead: 1, behind: 1 }, 'Diverged from main'],
			[path.join(repo, '.worktrees', 'det'), false, null, 0, { kind: 'detached' }, 'Detached HEAD: check out a branch first'],
			[path.join(repo, '.worktrees', 'feat'), false, 'feat', 0, { kind: 'compared', ahead: 0, behind: 1 }, null],
			[path.join(repo, '.worktrees', 'feat2'), false, 'feat2', 0, { kind: 'compared', ahead: 0, behind: 1 }, null]
		]);

		const sizes: ManagedHostSizes = answers[1].sizes!;
		const size = (folder: string) => sizes.worktrees.find((worktree) => worktree.path === folder)!.size!;
		const duTotal = (folder: string) => parseInt(cp.execFileSync('du', ['-sk', folder], { encoding: 'utf8' }).split('\t')[0], 10);
		expect(sizes.gitData!.path).toBe(path.join(repo, '.git'));
		expect(size(path.join(repo, '.worktrees', 'feat'))).toBeGreaterThanOrEqual(1024);
		expect(sizes.gitData!.size).toBeGreaterThanOrEqual(1024);
		expect(size(repo)).toBeLessThan(1024);
		// The rows inside the main worktree add up to its total, once each
		expect(size(repo) + size(path.join(repo, '.worktrees', 'feat')) + size(path.join(repo, '.worktrees', 'feat2')) + size(path.join(repo, '.worktrees', 'det')) + sizes.gitData!.size!).toBe(duTotal(repo));
		expect(size(outside)).toBe(duTotal(outside));
		expect(sizes.disk!.total).toBeGreaterThan(0);
		expect(sizes.warning).toBeNull();
	});

	it_('Should read a remote host\'s worktrees and sizes with its scripts, as this machine\'s', async () => {
		// Run
		const local = await load(null), remote = await load('srv');

		// Assert
		expect(remote.map((answer) => [answer.part, answer.error])).toStrictEqual([['git', null], ['sizes', null]]);
		expect(remote[0].git!.worktrees.every((managed) => managed.worktree.host === 'srv')).toBe(true);
		expect(withoutHost(remote[0].git!)).toStrictEqual(withoutHost(local[0].git!));
		expect(remote[1].sizes!.worktrees).toStrictEqual(local[1].sizes!.worktrees);
		expect(remote[1].sizes!.gitData).toStrictEqual(local[1].sizes!.gitData);
		// The targets, which awk keeps the lines of, then each du call. Git lists the linked worktrees in an order that depends on its version.
		const args = scriptCalls[scriptCalls.length - 1].args;
		const targets = [repo, outside, path.join(repo, '.worktrees', 'det'), path.join(repo, '.worktrees', 'feat'), path.join(repo, '.worktrees', 'feat2'), path.join(repo, '.git')];
		expect(args[0]).toBe(String(targets.length));
		expect(args.slice(1, targets.length + 1).slice().sort()).toStrictEqual(targets.slice().sort());
		expect(args.slice(targets.length + 1)).toStrictEqual(['2', repo, '0', outside]);
	});

	it_('Should measure the same folders once while loads overlap, and again after', async () => {
		// Setup: the sizes script waits until both loads have read the Git, so the second load finds the first one's measurement running
		let release = () => { };
		const gate = new Promise<void>((resolve) => release = resolve);
		let sizeCalls = 0, gitAnswers = 0;
		const overlapping = new WorktreeStats({
			runGit: (args, cwd, timeout) => runProcess('git', args, { cwd: cwd, env: env, timeout: timeout }),
			getGitExecutableError: () => null,
			remoteHosts: {
				runScript: async (_repo, _host, script, args, timeout) => {
					if (script === SIZES_SCRIPT) {
						sizeCalls++;
						await gate;
					}
					return { result: await runProcess('sh', ['-s', '--', repo].concat(args), { input: script, env: env, timeout: timeout }) };
				}
			}
		});
		const answers: WorktreeStatsAnswer[][] = [[], []];

		// Run
		await Promise.all(answers.map((list) => overlapping.load(repo, 'srv', (answer) => {
			list.push(answer);
			if (answer.part === 'git' && ++gitAnswers === 2) setTimeout(release, 0);
		})));
		const later: WorktreeStatsAnswer[] = [];
		await overlapping.load(repo, 'srv', (answer) => later.push(answer));

		// Assert
		expect(answers.map((list) => list.map((answer) => [answer.part, answer.error]))).toStrictEqual([[['git', null], ['sizes', null]], [['git', null], ['sizes', null]]]);
		expect(answers[1][1].sizes).toStrictEqual(answers[0][1].sizes);
		expect(later[1].sizes).toStrictEqual(answers[0][1].sizes);
		expect(sizeCalls).toBe(2);
	});

	it_('Should fail instead of guessing when Git can\'t read the Git folder, origin/HEAD or the branches on this machine', async () => {
		// Setup
		const failing = (failArgs: string) => new WorktreeStats({
			runGit: (args, cwd, timeout) => args.join(' ').startsWith(failArgs)
				? Promise.resolve({ code: 128, stdout: Buffer.alloc(0), stderr: 'fatal: bad object', error: null, timedOut: false })
				: runProcess('git', args, { cwd: cwd, env: env, timeout: timeout }),
			getGitExecutableError: () => null,
			remoteHosts: null
		});
		const loadWith = async (failArgs: string) => {
			const answers: WorktreeStatsAnswer[] = [];
			await failing(failArgs).load(repo, null, (answer) => answers.push(answer));
			return answers.map((answer) => [answer.part, answer.error]);
		};

		// Run
		const commonDir = await loadWith('rev-parse --git-common-dir');
		const originHead = await loadWith('symbolic-ref');
		const branches = await loadWith('for-each-ref');

		// Assert
		expect(commonDir).toStrictEqual([['git', 'Git couldn\'t find the repository\'s Git folder: fatal: bad object']]);
		expect(originHead).toStrictEqual([['git', 'Git couldn\'t read origin/HEAD: fatal: bad object']]);
		expect(branches).toStrictEqual([['git', 'Git couldn\'t read the branches: fatal: bad object']]);
	});

	it_('Should fail instead of guessing when Git can\'t read origin/HEAD on a remote host', () => {
		// Setup: a git on the PATH that fails to read origin/HEAD, and runs the real git otherwise
		const bin = path.join(tmp, 'bin'), realGit = cp.execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
		fs.mkdirSync(bin, { recursive: true });
		fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nif [ "$1" = symbolic-ref ] && [ "$3" = refs/remotes/origin/HEAD ]; then echo "fatal: bad object" >&2; exit 128; fi\nexec "' + realGit + '" "$@"\n', { mode: 0o755 });

		// Run
		const result = cp.spawnSync('sh', ['-s', '--', repo], { input: FACTS_SCRIPT, env: Object.assign({}, env, { PATH: bin + path.delimiter + env.PATH }), encoding: 'utf8' });

		// Assert
		expect(result.status).toBe(7);
		expect(parseFactsOutput(result.stdout)).toStrictEqual({ kind: 'unreadable' });
	});

	it_('Should refuse to fast-forward a worktree with changes, or a path that isn\'t a worktree', async () => {
		// Setup
		const feat = path.join(repo, '.worktrees', 'feat');
		fs.writeFileSync(path.join(feat, 'untracked'), 'u');

		// Run
		const dirty = await stats.fastForward(repo, null, feat);
		const notAWorktree = await stats.fastForward(repo, null, tmp);
		const remoteNotAWorktree = await stats.fastForward(repo, 'srv', '/etc');
		fs.unlinkSync(path.join(feat, 'untracked'));

		// Assert
		expect(dirty).toBe('Git Tree didn\'t fast-forward ' + feat + ': 1 uncommitted change.');
		expect(notAWorktree).toBe(tmp + ' isn\'t a worktree of this repository. Refresh the panel, then try again.');
		expect(remoteNotAWorktree).toBe('/etc on "srv" isn\'t a worktree of this repository. Refresh the panel, then try again.');
		expect(git(feat, 'rev-parse', 'HEAD')).not.toBe(git(repo, 'rev-parse', 'main'));
	});

	it_('Should fast-forward a worktree on this machine, and on a remote host', async () => {
		// Setup
		const feat = path.join(repo, '.worktrees', 'feat'), feat2 = path.join(repo, '.worktrees', 'feat2');

		// Run
		const local = await stats.fastForward(repo, null, feat);
		const remote = await stats.fastForward(repo, 'srv', feat2);
		const again = await stats.fastForward(repo, null, feat);

		// Assert
		expect(local).toBeNull();
		expect(remote).toBeNull();
		expect(git(feat, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'main'));
		expect(git(feat2, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'main'));
		expect(scriptCalls[scriptCalls.length - 1]).toStrictEqual({ host: 'srv', args: [feat2, 'feat2', 'main'], changesHost: true });
		expect(again).toBe('Git Tree didn\'t fast-forward ' + feat + ': Already up to date.');
	});

	it_('Should refuse on the server when the worktree changed after the extension checked it', async () => {
		// Setup: a branch that is behind main, then changes made after the check
		const side = path.join(repo, '.worktrees', 'late');
		git(repo, 'worktree', 'add', '-q', '-b', 'late', side, 'HEAD~1');
		fs.writeFileSync(path.join(side, 'late'), 'late');
		const run = (args: string[]) => runProcess('sh', ['-s', '--', repo].concat(args), { input: FAST_FORWARD_SCRIPT, env: env, timeout: 10000 });

		// Run
		const dirty = await run([side, 'late', 'main']);
		const otherBranch = await run([side, 'feat', 'main']);
		const notListed = await run([tmp, 'late', 'main']);

		// Assert
		expect(dirty.code).toBe(12);
		expect(otherBranch.code).toBe(11);
		expect(notListed.code).toBe(10);
	});

	it_('Should say when the folder isn\'t a repository', async () => {
		// Run
		const output = parseFactsOutput(cp.spawnSync('sh', ['-s', '--', tmp], { input: FACTS_SCRIPT, env: env, encoding: 'utf8' }).stdout);

		// Assert
		expect(output.kind).toBe('notARepository');
	});
});
