import * as vscode from '../mocks/vscode';
jest.mock('vscode', () => vscode, { virtual: true });
jest.mock('../../src/askpass/askpassManager');
jest.mock('../../src/logger');

import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigurationChangeEvent } from 'vscode';
import { DataSource } from '../../src/dataSource';
import { Engine, EngineAnswer, getEnginePath, getEnginePlatform, loadEngine } from '../../src/engine';
import { Logger } from '../../src/logger';
import { CommitOrdering } from '../../src/types';
import { GitExecutable, getGitExecutable } from '../../src/utils';
import { EventEmitter } from '../../src/utils/event';

/*
 * Differential tests: each engine read against the Git CLI read, on real repositories. A DataSource
 * without the engine reads with Git, a DataSource with the engine reads with the engine, and their
 * results must be equal. The engine's answers are recorded, so a test also fails when the engine
 * quietly handed a read it should answer back to Git.
 */

const ROOT = path.join(__dirname, '..', '..');
const platform = getEnginePlatform();
const engineBuilt = platform !== null && fs.existsSync(getEnginePath(platform));
const describeWithEngine = engineBuilt ? describe : describe.skip;

const ORDERINGS = [CommitOrdering.Date, CommitOrdering.AuthorDate, CommitOrdering.Topological];

interface RecordedAnswer {
	readonly read: string;
	readonly repo: string;
	readonly answer: string; // 'ok', or 'unsupported: <why>', or 'failed: <why>'
}

let tmp: string;
let gitExecutable: GitExecutable;
let engine: Engine;
let answers: RecordedAnswer[] = [];
let logger: Logger;
let onDidChangeConfiguration: EventEmitter<ConfigurationChangeEvent>;
let onDidChangeGitExecutable: EventEmitter<GitExecutable>;

if (!engineBuilt) {
	test('the engine is not built, so the differential tests are skipped', () => { });
}

describeWithEngine('The engine reads what Git reads', () => {
	beforeAll(async () => {
		tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-tree-engine-')));
		// Git and the engine both read the global configuration; an empty one keeps the tests independent of the machine
		process.env.HOME = path.join(tmp, 'home');
		process.env.XDG_CONFIG_HOME = path.join(tmp, 'home', '.config');
		fs.mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });

		cp.execFileSync('bash', [path.join(ROOT, 'scripts', 'make-demo-repo.sh')], { env: Object.assign({}, process.env, { DEMO_DIR: path.join(tmp, 'demo') }), stdio: 'pipe' });

		logger = new Logger();
		onDidChangeConfiguration = new EventEmitter<ConfigurationChangeEvent>();
		onDidChangeGitExecutable = new EventEmitter<GitExecutable>();
		gitExecutable = await getGitExecutable('git');
		engine = recordAnswers(loadEngine(logger)!);
	});

	afterAll(() => {
		onDidChangeConfiguration.dispose();
		onDidChangeGitExecutable.dispose();
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	beforeEach(() => {
		answers = [];
		// The uncommitted changes rows carry the current time, so they would differ between two reads
		vscode.mockExtensionSettingReturnValue('repository.showUncommittedChanges', false);
	});

	describe('The demo repository', () => {
		const demo = () => path.join(tmp, 'demo');
		const repos: [string, () => string][] = [
			['the main worktree', () => path.join(demo(), 'demo-repo')],
			['a linked worktree on a branch', () => path.join(demo(), 'demo-repo', '.worktrees', 'alerts')],
			['a linked worktree with a detached HEAD', () => path.join(demo(), 'demo-repo', '.worktrees', 'review')],
			['a linked worktree outside the repository', () => path.join(demo(), 'demo-hotfix')],
			['the bare remote', () => path.join(demo(), 'demo-origin.git')]
		];
		describe.each(repos)('%s', (_, repo) => {
			it('Reads the repository info', async () => {
				await expectSameRepoInfo(repo());
				expectOnlyOkAnswers();
			});

			describe.each(ORDERINGS)('%s order', (ordering) => {
				it.each([false, true])('Reads the commits (first parent only: %s)', async (firstParent) => {
					await expectSameCommits(repo(), ordering, firstParent);
					expectOnlyOkAnswers();
				});
			});
		});

		it('Reads the commits with a commit-graph', async () => {
			const repo = path.join(demo(), 'demo-repo');
			git(repo, 'commit-graph', 'write', '--reachable');
			for (const ordering of ORDERINGS) {
				await expectSameCommits(repo, ordering, true);
				await expectSameCommits(repo, ordering, false);
			}
			expectOnlyOkAnswers();
		});
	});

	describe('This repository', () => {
		it('Reads the repository info', async () => {
			await expectSameRepoInfo(ROOT);
			expectAnswers();
		});

		it.each(ORDERINGS)('Reads the commits in %s order', async (ordering) => {
			await expectSameCommits(ROOT, ordering, false);
			await expectSameCommits(ROOT, ordering, true);
			expectAnswers();
		});
	});

	describe('A repository built for edge cases', () => {
		let repo: string;
		beforeAll(() => {
			repo = buildEdgeCaseRepository(path.join(tmp, 'edge'));
		});

		const read = async () => {
			await expectSameRepoInfo(repo);
			for (const ordering of ORDERINGS) {
				await expectSameCommits(repo, ordering, false);
				await expectSameCommits(repo, ordering, true);
			}
		};

		it('Reads it without a commit-graph', async () => {
			await read();
			expectOnlyOkAnswers();
		});

		it('Reads it with a commit-graph', async () => {
			git(repo, 'commit-graph', 'write', '--reachable');
			await read();
			expectOnlyOkAnswers();
		});

		it('Reads it with a split commit-graph', async () => {
			fs.rmSync(path.join(repo, '.git', 'objects', 'info', 'commit-graph'));
			git(repo, 'commit-graph', 'write', '--reachable', '--split');
			commit(repo, 'After the graph was written', '1700009000');
			git(repo, 'commit-graph', 'write', '--reachable', '--split');
			await read();
			expectOnlyOkAnswers();
		});

		it('Reads it with core.commitGraph=false', async () => {
			git(repo, 'config', 'core.commitGraph', 'false');
			await read();
			expectOnlyOkAnswers();
			git(repo, 'config', '--unset', 'core.commitGraph');
		});

		it('Reads it with a detached HEAD', async () => {
			git(repo, 'checkout', '-q', '--detach', 'HEAD~1');
			await read();
			expectOnlyOkAnswers();
			git(repo, 'checkout', '-q', 'main');
		});
	});

	describe('Repositories the engine leaves to Git', () => {
		// Each repository is read with Git, so the results are still equal, and the engine says why
		const cases: [string, (dir: string) => string, string][] = [
			['an empty repository', (dir) => init(dir), 'HEAD has no commits'],
			['a shallow clone', (dir) => {
				const origin = buildLinearRepository(dir + '-origin', 5);
				cp.execFileSync('git', ['clone', '-q', '--depth', '2', 'file://' + origin, dir], { env: gitEnv('1700000000') });
				return dir;
			}, 'shallow clone'],
			['a SHA-256 repository', (dir) => {
				init(dir, '--object-format=sha256');
				commit(dir, 'First', '1700000000');
				return dir;
			}, 'sha256'],
			['a repository with replacement objects', (dir) => {
				buildLinearRepository(dir, 3);
				git(dir, 'replace', 'HEAD~1', 'HEAD~2');
				return dir;
			}, 'replacement objects'],
			['a commit in another encoding', (dir) => {
				init(dir);
				git(dir, 'config', 'i18n.commitEncoding', 'ISO-8859-1');
				fs.writeFileSync(path.join(dir, 'message.txt'), Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x0a]));
				cp.execFileSync('git', ['commit', '-q', '--allow-empty', '-F', 'message.txt'], { cwd: dir, env: gitEnv('1700000000') });
				git(dir, 'config', '--unset', 'i18n.commitEncoding');
				return dir;
			}, 'encoded in ISO-8859-1'],
			['an author name that is not UTF-8', (dir) => {
				// Node.js passes the environment as UTF-8, so the commit is written as an object, with its name in Latin-1
				init(dir);
				const tree = git(dir, 'write-tree').trim();
				const object = Buffer.concat([
					Buffer.from('tree ' + tree + '\nauthor J'), Buffer.from([0xf6]), Buffer.from('rg <j@example.com> 1700000000 +0000\n'),
					Buffer.from('committer Ada Park <ada@example.com> 1700000000 +0000\n\nLatin-1 name\n')
				]);
				const id = cp.execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: dir, input: object }).toString().trim();
				git(dir, 'update-ref', 'refs/heads/main', id);
				return dir;
			}, 'isn\'t valid UTF-8'],
			['branch.sort set', (dir) => {
				buildLinearRepository(dir, 2);
				git(dir, 'branch', 'aaa', 'HEAD~1');
				git(dir, 'config', 'branch.sort', '-committerdate');
				return dir;
			}, 'branch.sort']
		];
		it.each(cases)('%s', async (_, build, reason) => {
			const repo = build(path.join(tmp, 'unsupported-' + answers.length + '-' + Math.random().toString(36).slice(2)));
			await expectSameRepoInfo(repo);
			for (const ordering of ORDERINGS) {
				await expectSameCommits(repo, ordering, false);
			}
			expect(answers.map((answer) => answer.answer).filter((answer) => answer.startsWith('unsupported'))).toContainEqual(expect.stringContaining(reason));
			expect(answers.filter((answer) => answer.answer.startsWith('failed'))).toStrictEqual([]);
		});

		it('A mailmap, when the mailmap is used', async () => {
			const repo = buildLinearRepository(path.join(tmp, 'mailmap'), 2);
			fs.writeFileSync(path.join(repo, '.mailmap'), 'Real Name <real@example.com> <ada@example.com>\n');
			vscode.mockExtensionSettingReturnValue('repository.useMailmap', true);
			await expectSameRepoInfo(repo);
			await expectSameCommits(repo, CommitOrdering.Date, false);
			expect(answers.map((answer) => answer.answer)).toContainEqual(expect.stringContaining('.mailmap'));
		});
	});
});


/* Comparing reads */

/**
 * Read the repository info with Git and with the engine, with each combination of options, and expect equal results.
 */
async function expectSameRepoInfo(repo: string) {
	for (const showRemoteBranches of [true, false]) {
		for (const showStashes of [true, false]) {
			for (const hideRemotes of [[], ['origin']]) {
				const label = { repo: repo, showRemoteBranches: showRemoteBranches, showStashes: showStashes, hideRemotes: hideRemotes };
				const [expected, actual] = await readTwice((dataSource) => dataSource.getRepoInfo(repo, showRemoteBranches, showStashes, hideRemotes));
				expect({ label: label, result: actual }).toStrictEqual({ label: label, result: expected });
			}
		}
	}
}

/**
 * Read the commits with Git and with the engine, for the start points and settings the view uses, and expect equal results.
 */
async function expectSameCommits(repo: string, ordering: CommitOrdering, firstParent: boolean) {
	// The view reads the repository info first, and passes the remotes, stashes and worktrees on
	const cli = createDataSource(null);
	const info = await cli.getRepoInfo(repo, true, true, []);
	cli.dispose();
	const branch = info.head !== null ? [info.head] : ['HEAD'];
	const remoteBranches = info.branches.filter((name) => name.startsWith('remotes/'));

	const variants: { branches: string[] | null, maxCommits: number, showTags: boolean, showRemoteBranches: boolean, reflogs: boolean, hideRemotes: string[], onlyWorktreeHistory: boolean, settings: { [section: string]: any } }[] = [
		{ branches: null, maxCommits: 300, showTags: true, showRemoteBranches: true, reflogs: false, hideRemotes: [], onlyWorktreeHistory: false, settings: {} },
		{ branches: null, maxCommits: 300, showTags: true, showRemoteBranches: true, reflogs: true, hideRemotes: [], onlyWorktreeHistory: false, settings: { 'date.type': 'Commit Date' } },
		{ branches: null, maxCommits: 5, showTags: false, showRemoteBranches: false, reflogs: false, hideRemotes: [], onlyWorktreeHistory: false, settings: {} },
		{ branches: null, maxCommits: 100000, showTags: true, showRemoteBranches: true, reflogs: false, hideRemotes: ['origin'], onlyWorktreeHistory: false, settings: { 'repository.showCommitsOnlyReferencedByTags': false, 'repository.showRemoteHeads': false } },
		{ branches: null, maxCommits: 300, showTags: true, showRemoteBranches: true, reflogs: false, hideRemotes: [], onlyWorktreeHistory: true, settings: {} },
		{ branches: branch, maxCommits: 300, showTags: true, showRemoteBranches: true, reflogs: false, hideRemotes: [], onlyWorktreeHistory: false, settings: {} },
		{ branches: branch.concat(remoteBranches), maxCommits: 50, showTags: true, showRemoteBranches: true, reflogs: false, hideRemotes: [], onlyWorktreeHistory: true, settings: { 'date.type': 'Commit Date' } }
	];

	for (const variant of variants) {
		for (const section of Object.keys(variant.settings)) {
			vscode.mockExtensionSettingReturnValue(section, variant.settings[section]);
		}
		const label = Object.assign({ repo: repo, ordering: ordering, firstParent: firstParent }, variant);
		const [expected, actual] = await readTwice((dataSource) => dataSource.getCommits(repo, variant.branches, variant.maxCommits, variant.showTags, variant.showRemoteBranches, variant.reflogs, firstParent, ordering, info.remotes, variant.hideRemotes, info.stashes, info.worktrees, variant.onlyWorktreeHistory));
		expect({ label: label, result: actual }).toStrictEqual({ label: label, result: expected });
		for (const section of Object.keys(variant.settings)) {
			vscode.mockExtensionSettingReturnValue(section, undefined);
		}
	}
}

/**
 * Run a read with Git, and then with the engine.
 * @returns The result with Git, and the result with the engine.
 */
async function readTwice<T>(read: (dataSource: DataSource) => Promise<T>) {
	const cli = createDataSource(null), withEngine = createDataSource(engine);
	try {
		const expected = await read(cli);
		const before = answers.length;
		const actual = await read(withEngine);
		expect(answers.length).toBeGreaterThan(before);
		return [expected, actual];
	} finally {
		cli.dispose();
		withEngine.dispose();
	}
}

function createDataSource(engine: Engine | null) {
	return new DataSource(gitExecutable, onDidChangeConfiguration.subscribe, onDidChangeGitExecutable.subscribe, logger, engine);
}

/**
 * Wrap the engine, recording each answer it gives.
 */
function recordAnswers(engine: Engine): Engine {
	const record = <T>(read: string, repo: string, answer: Promise<EngineAnswer<T>>) => answer.then((value) => {
		answers.push({ read: read, repo: repo, answer: 'ok' in value ? 'ok' : 'unsupported' in value ? 'unsupported: ' + value.unsupported : 'failed: ' + value.failed });
		return value;
	});
	return {
		version: engine.version,
		branches: (repo, includeRemotes) => record('branches', repo, engine.branches(repo, includeRemotes)),
		remotes: (repo) => record('remotes', repo, engine.remotes(repo)),
		stashes: (repo, format) => record('stashes', repo, engine.stashes(repo, format)),
		worktrees: (repo) => record('worktrees', repo, engine.worktrees(repo)),
		refs: (repo, includeRemotes) => record('refs', repo, engine.refs(repo, includeRemotes)),
		log: (repo, request) => record('log', repo, engine.log(repo, request))
	};
}

/**
 * Expect the engine to have answered every read itself.
 */
function expectOnlyOkAnswers() {
	expect(answers.filter((answer) => answer.answer !== 'ok')).toStrictEqual([]);
}

/**
 * Expect the engine to have answered, or said why it didn't. Used for this repository, whose state the tests don't control.
 */
function expectAnswers() {
	expect(answers.filter((answer) => answer.answer.startsWith('failed'))).toStrictEqual([]);
	expect(answers.some((answer) => answer.answer === 'ok')).toBe(true);
}


/* Building repositories */

function gitEnv(date: string, name: string = 'Ada Park', email: string = 'ada@example.com') {
	return Object.assign({}, process.env, {
		GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: '@' + date + ' +0000',
		GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email, GIT_COMMITTER_DATE: '@' + date + ' +0000'
	});
}

function git(cwd: string, ...args: string[]) {
	return cp.execFileSync('git', args, { cwd: cwd, env: gitEnv('1700000000'), stdio: 'pipe' }).toString();
}

function init(dir: string, ...options: string[]) {
	fs.mkdirSync(dir, { recursive: true });
	git(dir, 'init', '-q', '-b', 'main', ...options);
	git(dir, 'config', 'commit.gpgsign', 'false');
	git(dir, 'config', 'tag.gpgsign', 'false');
	return dir;
}

function commit(dir: string, message: string, date: string, authorDate?: string, name?: string) {
	const env = gitEnv(date, name);
	if (authorDate) env.GIT_AUTHOR_DATE = '@' + authorDate + ' +0000';
	cp.execFileSync('git', ['commit', '-q', '--allow-empty', '--cleanup=verbatim', '-m', message], { cwd: dir, env: env, stdio: 'pipe' });
}

function merge(dir: string, branch: string, message: string, date: string) {
	cp.execFileSync('git', ['merge', '-q', '--no-ff', '-m', message, branch], { cwd: dir, env: gitEnv(date), stdio: 'pipe' });
}

function buildLinearRepository(dir: string, commits: number) {
	init(dir);
	for (let i = 0; i < commits; i++) {
		commit(dir, 'Commit ' + i, String(1700000000 + i * 100));
	}
	return dir;
}

/**
 * Build a repository with the history shapes, refs and messages where the orderings and the reads are easiest to get wrong.
 */
function buildEdgeCaseRepository(dir: string) {
	init(dir);
	commit(dir, 'Root', '1700000000');

	// Branches whose commits tie on their dates, merged back in both directions
	git(dir, 'branch', 'left');
	git(dir, 'branch', 'right');
	commit(dir, 'Main after the fork', '1700000100');
	git(dir, 'checkout', '-q', 'left');
	commit(dir, 'Left one', '1700000100');
	commit(dir, 'Left two', '1700000200', '1700000050');
	git(dir, 'checkout', '-q', 'right');
	commit(dir, 'Right one', '1700000100');
	commit(dir, 'Right two', '1700000200', '1700000300');
	git(dir, 'checkout', '-q', 'main');
	merge(dir, 'left', 'Merge left', '1700000300');
	git(dir, 'checkout', '-q', 'right');
	merge(dir, 'main', 'Merge main into right', '1700000300');
	git(dir, 'checkout', '-q', 'main');
	merge(dir, 'right', 'Merge right', '1700000400');

	// A feature branch whose tip is a merge's second parent, and is also its own start point
	git(dir, 'checkout', '-q', '-b', 'feature');
	commit(dir, 'Feature one', '1700000450');
	commit(dir, 'Feature two', '1700000460');
	git(dir, 'checkout', '-q', 'main');
	commit(dir, 'Main moves on', '1700000500');
	merge(dir, 'feature', 'Merge feature', '1700000600');
	git(dir, 'checkout', '-q', 'feature');
	commit(dir, 'Feature continues', '1700000700');
	git(dir, 'checkout', '-q', 'main');

	// Messages: a multi-line first paragraph, leading blank lines, trailing whitespace, a CR, and Unicode
	commit(dir, 'First line\nsecond line of the subject  \n\nBody', '1700000800');
	commit(dir, '\n\n  Indented subject after blank lines\t\n', '1700000810');
	commit(dir, 'Windows line ending\r\n\r\nBody', '1700000820');
	commit(dir, 'A carriage\rreturn inside', '1700000830', undefined, 'Tomás Ortega');
	commit(dir, 'Émoji 🌦️ and ünïcode', '1700000840');

	// A commit older than its parent, and an orphan branch
	commit(dir, 'Clock skew', '1600000000');
	git(dir, 'checkout', '-q', '--orphan', 'orphan');
	commit(dir, 'Orphan root', '1700000900');
	git(dir, 'checkout', '-q', 'main');

	// Tags: lightweight, annotated, a tag of a tag, a tag of a tree and of a blob, and a tag named like a branch
	git(dir, 'tag', 'light', 'HEAD~2');
	git(dir, 'tag', '-a', '-m', 'Annotated', 'annotated', 'HEAD~3');
	git(dir, 'tag', '-a', '-m', 'Nested', 'nested', 'annotated');
	git(dir, 'tag', 'tree', 'HEAD^{tree}');
	const blob = cp.execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: 'a blob\n' }).toString().trim();
	git(dir, 'tag', 'blob', blob);
	git(dir, 'tag', 'left', 'right');
	git(dir, 'tag', 'old-tag', 'HEAD~8');

	// Remotes: refs from two remotes, a symbolic remote HEAD, and one that points nowhere
	git(dir, 'remote', 'add', 'origin', 'https://example.com/origin.git');
	git(dir, 'remote', 'add', 'upstream', 'https://example.com/upstream.git');
	git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD~1');
	git(dir, 'update-ref', 'refs/remotes/origin/feature/nested', 'feature');
	git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
	git(dir, 'update-ref', 'refs/remotes/upstream/main', 'left');
	git(dir, 'symbolic-ref', 'refs/remotes/upstream/HEAD', 'refs/remotes/upstream/gone');

	// A local branch that is a symbolic ref, and packed refs next to loose ones
	git(dir, 'symbolic-ref', 'refs/heads/alias', 'refs/heads/feature');
	git(dir, 'pack-refs', '--all');
	git(dir, 'branch', 'loose', 'HEAD~4');

	// Stashes, one with untracked files
	fs.writeFileSync(path.join(dir, 'file.txt'), 'one\n');
	git(dir, 'add', 'file.txt');
	cp.execFileSync('git', ['stash', 'push', '-q', '-m', 'Tracked change'], { cwd: dir, env: gitEnv('1700001000') });
	fs.writeFileSync(path.join(dir, 'untracked.txt'), 'two\n');
	cp.execFileSync('git', ['stash', 'push', '-q', '-u', '-m', 'Untracked change'], { cwd: dir, env: gitEnv('1700001100') });

	// Reflog entries for commits no branch reaches any more
	commit(dir, 'Amended away', '1700001200');
	cp.execFileSync('git', ['commit', '-q', '--amend', '--allow-empty', '-m', 'Amended'], { cwd: dir, env: gitEnv('1700001300') });

	// A linked worktree, a locked one, and one whose folder is gone
	git(dir, 'worktree', 'add', '-q', path.join(dir, '..', 'edge-linked'), 'left');
	git(dir, 'worktree', 'add', '-q', '--detach', path.join(dir, '..', 'edge-locked'), 'HEAD~2');
	git(dir, 'worktree', 'lock', path.join(dir, '..', 'edge-locked'));
	git(dir, 'worktree', 'add', '-q', path.join(dir, '..', 'edge-gone'), 'orphan');
	fs.rmSync(path.join(dir, '..', 'edge-gone'), { recursive: true, force: true });
	return dir;
}
