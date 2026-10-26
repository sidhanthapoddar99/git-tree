import * as vscode from '../mocks/vscode';
jest.mock('vscode', () => vscode, { virtual: true });
jest.mock('../../src/askpass/askpassManager');
jest.mock('../../src/logger');

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { CommitsAnswer, EngineAnswer, EngineFormat, EngineLogRequest, RepoInfoAnswer, getEnginePath, getEnginePlatform } from '../../src/engine';
import { CommitOrdering } from '../../src/types';
import { ROOT, buildLinearRepository, commit, describeWithEngine, engineBuilt, git, gitEnv, harness, init, merge, useEngineHarness } from './harness';

/*
 * The view load's two engine reads, repoInfo and commits, against the single reads they combine. The single reads
 * are compared with Git in differential.test.ts, so these tests compare the combined reads with the single ones:
 * each part of a combined answer must be the answer its own read gives. They also check the commits read's token:
 * the same token gives `unchanged`, and every kind of change to what the answer depends on changes it.
 */

const ORDERINGS = [CommitOrdering.Date, CommitOrdering.AuthorDate, CommitOrdering.Topological];
const FORMATS: EngineFormat[] = [{ mailmap: false, authorDate: false }, { mailmap: true, authorDate: true }];
const TOKEN = /^[0-9a-f]{40}$/;

if (!engineBuilt) {
	test('the engine is not built, so the view load tests are skipped', () => { });
}

describeWithEngine('The view load reads', () => {
	useEngineHarness();
	beforeAll(() => {
		cp.execFileSync('bash', [path.join(ROOT, 'scripts', 'make-demo-repo.sh')], { env: Object.assign({}, process.env, { DEMO_DIR: path.join(harness.tmp, 'demo') }), stdio: 'pipe' });
	});

	describe('The demo repository and this repository', () => {
		const demo = () => path.join(harness.tmp, 'demo');
		const repos: [string, () => string][] = [
			['the main worktree', () => path.join(demo(), 'demo-repo')],
			['a linked worktree on a branch', () => path.join(demo(), 'demo-repo', '.worktrees', 'alerts')],
			['a linked worktree with a detached HEAD', () => path.join(demo(), 'demo-repo', '.worktrees', 'review')],
			['the bare remote', () => path.join(demo(), 'demo-origin.git')],
			['this repository', () => ROOT]
		];
		describe.each(repos)('%s', (name, repo) => {
			it('Reads the repository info as the single reads do', async () => {
				await expectRepoInfoAsSingleReads(repo());
			});

			it('Reads the commits as the single reads do, and the same token gives unchanged', async () => {
				const requests = await viewRequests(repo());
				for (const request of requests) {
					for (const includeRemotes of [true, false]) {
						const token = await expectCommitsAsSingleReads(repo(), includeRemotes, request);
						// A bare repository may have a mailmap at HEAD, so the engine hands the log to Git when the format uses it
						const handedToGit = request.format.mailmap && name === 'the bare remote';
						expect({ request: request, token: token }).toStrictEqual({ request: request, token: handedToGit ? null : expect.stringMatching(TOKEN) });
					}
				}
			});
		});

		it('Gives each request its own token', async () => {
			const repo = path.join(demo(), 'demo-repo');
			const tokens = new Set<string | null>();
			const requests = await viewRequests(repo);
			for (const request of requests) {
				for (const includeRemotes of [true, false]) {
					tokens.add(await expectCommitsAsSingleReads(repo, includeRemotes, request));
				}
			}
			expect(tokens.size).toBe(requests.length * 2);
		});

		it('Sends the log in its compact form', async () => {
			// The compact form, before src/engine.ts expands it
			const native = require(getEnginePath(<string>getEnginePlatform()));
			const repo = path.join(demo(), 'demo-repo');
			for (const maxCount of [1, 7, 100000]) {
				const answer = JSON.parse(await native.read(JSON.stringify({ read: 'commits', repo: repo, includeRemotes: true, log: logRequest(['--branches', '--tags', '--remotes', 'HEAD'], maxCount), token: null })));
				const log: { people: string[], commits: [string, (number | string)[], number, number, string][] } = answer.ok.log.ok;
				expect(log.commits.length).toBe(Math.min(maxCount, (await harness.engine.log(repo, logRequest(['--branches', '--tags', '--remotes', 'HEAD'], 100000)) as { ok: unknown[] }).ok.length));
				const pairs = [];
				for (let i = 0; i < log.people.length; i += 2) pairs.push(log.people[i] + '\0' + log.people[i + 1]);
				expect(new Set(pairs).size).toBe(pairs.length);
				const inPage = new Map(log.commits.map((entry, i) => [entry[0], i]));
				for (const entry of log.commits) {
					expect(entry[2]).toBeLessThan(pairs.length);
					for (const parent of entry[1]) {
						// A parent in the page is its index, and any other parent its hash
						if (typeof parent === 'number') {
							expect(parent).toBeLessThan(log.commits.length);
						} else {
							expect(inPage.has(parent)).toBe(false);
						}
					}
				}
			}
		});
	});

	describe('Repositories the engine leaves to Git', () => {
		// Each repository, and whether a request gets a token: only when the refs and log reads both answer
		const always = () => true, never = () => false;
		const cases: [string, (dir: string) => string, (request: EngineLogRequest) => boolean][] = [
			['an empty repository', (dir) => init(dir), never],
			['a shallow clone', (dir) => {
				const origin = buildLinearRepository(dir + '-origin', 5);
				cp.execFileSync('git', ['clone', '-q', '--depth', '2', 'file://' + origin, dir], { env: gitEnv('1700000000') });
				return dir;
			}, never],
			['branch.sort set', (dir) => {
				buildLinearRepository(dir, 2);
				git(dir, 'config', 'branch.sort', '-committerdate');
				return dir;
			}, always],
			['a mailmap', (dir) => {
				buildLinearRepository(dir, 2);
				fs.writeFileSync(path.join(dir, '.mailmap'), 'Real Name <real@example.com> <ada@example.com>\n');
				fs.writeFileSync(path.join(dir, 'file.txt'), 'stashed\n');
				git(dir, 'add', 'file.txt');
				cp.execFileSync('git', ['stash', 'push', '-q', '-m', 'A stash'], { cwd: dir, env: gitEnv('1700001000'), stdio: 'pipe' });
				return dir;
			}, (request) => !request.format.mailmap]
		];
		it.each(cases)('%s', async (name, build, hasToken) => {
			const repo = build(path.join(harness.tmp, 'left-to-git-' + name.replace(/\W/g, '-')));
			await expectRepoInfoAsSingleReads(repo);
			for (const request of await viewRequests(repo)) {
				const token = await expectCommitsAsSingleReads(repo, true, request);
				expect({ request: request, token: token }).toStrictEqual({ request: request, token: hasToken(request) ? expect.stringMatching(TOKEN) : null });
			}
			expect(harness.answers.filter((answer) => answer.answer.startsWith('failed'))).toStrictEqual([]);
		});
	});

	describe('The token', () => {
		let repo: string;
		beforeAll(() => {
			repo = buildChangingRepository(path.join(harness.tmp, 'changing'));
		});

		it('Changes after each kind of change the answer depends on', async () => {
			const base = logRequest(['--branches', '--tags', '--remotes', 'HEAD'], 301);
			let token = await expectCommitsAsSingleReads(repo, true, base);
			expect(token).toMatch(TOKEN);

			// Make a change, and expect the earlier token to no longer give unchanged, and the new answer to have a new token
			const expectChange = async (label: string, change: () => void, request: EngineLogRequest = base, includeRemotes: boolean = true, hasToken: boolean = true) => {
				const before = token;
				change();
				const answer = await harness.engine.commits(repo, includeRemotes, request, before);
				expect({ label: label, unchanged: 'ok' in answer && 'unchanged' in answer.ok }).toStrictEqual({ label: label, unchanged: false });
				token = await expectCommitsAsSingleReads(repo, includeRemotes, request);
				expect({ label: label, token: token }).toStrictEqual({ label: label, token: hasToken ? expect.stringMatching(TOKEN) : null });
				expect({ label: label, changed: token !== before }).toStrictEqual({ label: label, changed: true });
			};
			const nothing = () => { };

			await expectChange('a new commit', () => commit(repo, 'New commit', '1700005000'));
			await expectChange('a moved branch', () => git(repo, 'branch', '-f', 'other', 'HEAD~2'));
			await expectChange('a new lightweight tag', () => git(repo, 'tag', 'light-2', 'HEAD~1'));
			await expectChange('a new annotated tag', () => git(repo, 'tag', '-a', '-m', 'Annotated', 'annotated-2', 'HEAD~3'));
			await expectChange('a deleted tag', () => git(repo, 'tag', '-d', 'light'));
			await expectChange('a new remote branch', () => git(repo, 'update-ref', 'refs/remotes/origin/topic', 'HEAD~1'));
			await expectChange('a deleted remote branch', () => git(repo, 'update-ref', '-d', 'refs/remotes/origin/topic'));
			await expectChange('a new branch', () => git(repo, 'branch', 'same'));
			await expectChange('HEAD switching to a branch on the same commit', () => git(repo, 'checkout', '-q', 'same'));
			await expectChange('HEAD detached on the same commit', () => git(repo, 'checkout', '-q', '--detach'));
			await expectChange('HEAD back on main', () => git(repo, 'checkout', '-q', 'main'));
			// Packing the refs changes how they are stored, not what they are, so neither the answer nor the token changes
			git(repo, 'pack-refs', '--all');
			expect(await expectCommitsAsSingleReads(repo, true, base)).toBe(token);
			await expectChange('a commit-graph', () => git(repo, 'commit-graph', 'write', '--reachable'));
			await expectChange('a rewritten commit-graph', () => git(repo, '-c', 'commitGraph.generationVersion=1', 'commit-graph', 'write', '--reachable'));
			await expectChange('a split commit-graph', () => {
				fs.rmSync(path.join(repo, '.git', 'objects', 'info', 'commit-graph'));
				git(repo, 'commit-graph', 'write', '--reachable', '--split');
			});
			await expectChange('core.commitGraph=false', () => git(repo, 'config', 'core.commitGraph', 'false'));
			git(repo, 'config', '--unset', 'core.commitGraph');
			const current = await expectCommitsAsSingleReads(repo, true, base);

			// A stash isn't a ref the refs read lists. The view adds its base commit to the log's revisions.
			fs.writeFileSync(path.join(repo, 'file.txt'), 'stashed\n');
			git(repo, 'add', 'file.txt');
			cp.execFileSync('git', ['stash', 'push', '-q', '-m', 'A stash'], { cwd: repo, env: gitEnv('1700006000'), stdio: 'pipe' });
			expect(await expectCommitsAsSingleReads(repo, true, base)).toBe(current);
			token = current;
			const stashBase = git(repo, 'rev-parse', 'refs/stash^').trim();
			await expectChange('a new stash', nothing, logRequest(['--branches', '--tags', '--remotes', stashBase, 'HEAD'], 301));

			// The reflogs, when the log reads them
			const reflogs = logRequest(['--branches', '--tags', '--reflog', '--remotes', 'HEAD'], 301);
			await expectChange('a request with the reflogs', nothing, reflogs);
			await expectChange('expired reflogs', () => git(repo, 'reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all'), reflogs);

			// Each field of the request
			token = await expectCommitsAsSingleReads(repo, true, base);
			const changed = [
				['includeRemotes', base, false],
				['maxCount', logRequest(base.revisions, 302), true],
				['the revisions', logRequest(['--branches', 'HEAD'], 301), true],
				['the order', logRequest(base.revisions, 301, CommitOrdering.Topological), true],
				['first parent only', logRequest(base.revisions, 301, CommitOrdering.Date, true), true],
				['the author date', logRequest(base.revisions, 301, CommitOrdering.Date, false, { mailmap: false, authorDate: true }), true],
				['the mailmap', logRequest(base.revisions, 301, CommitOrdering.Date, false, { mailmap: true, authorDate: false }), true]
			] as const;
			for (const [label, request, includeRemotes] of changed) {
				await expectChange('a request with another ' + label, nothing, request, includeRemotes);
				token = await expectCommitsAsSingleReads(repo, true, base);
			}

			// A mailmap, when the format uses it: the engine hands the log to Git, so there is no token
			const mailmap = logRequest(base.revisions, 301, CommitOrdering.Date, false, { mailmap: true, authorDate: false });
			token = await expectCommitsAsSingleReads(repo, true, mailmap);
			expect(token).toMatch(TOKEN);
			const withoutMailmap = token;
			await expectChange('a new mailmap', () => fs.writeFileSync(path.join(repo, '.mailmap'), 'Real Name <real@example.com> <ada@example.com>\n'), mailmap, true, false);
			fs.writeFileSync(path.join(repo, '.mailmap'), 'Other Name <other@example.com> <ada@example.com>\n');
			expect(await harness.engine.commits(repo, true, mailmap, withoutMailmap)).toMatchObject({ ok: { token: null, log: { unsupported: expect.stringContaining('.mailmap') } } });
			// Without the mailmap, the same state gives the same token again
			fs.rmSync(path.join(repo, '.mailmap'));
			expect(await expectCommitsAsSingleReads(repo, true, mailmap)).toBe(withoutMailmap);
		});
	});
});


/* Comparing reads */

/**
 * Expect the repoInfo read to give, for each combination of options, the answers of the single reads.
 */
async function expectRepoInfoAsSingleReads(repo: string) {
	const engine = harness.engine;
	for (const includeRemotes of [true, false]) {
		for (const stashes of [null, ...FORMATS]) {
			const label = { repo: repo, includeRemotes: includeRemotes, stashes: stashes };
			const combined = await engine.repoInfo(repo, includeRemotes, stashes);
			const single: RepoInfoAnswer = {
				branches: await engine.branches(repo, includeRemotes),
				remotes: await engine.remotes(repo),
				stashes: stashes !== null ? await engine.stashes(repo, stashes) : null,
				worktrees: await engine.worktrees(repo)
			};
			if ('ok' in combined) {
				expect({ label: label, answer: combined.ok }).toStrictEqual({ label: label, answer: single });
			} else {
				// The repository didn't open, so each single read gives the same answer
				const parts: EngineAnswer<unknown>[] = [single.branches, single.remotes, single.worktrees];
				if (single.stashes !== null) parts.push(single.stashes);
				expect({ label: label, answers: parts }).toStrictEqual({ label: label, answers: parts.map(() => combined) });
			}
		}
	}
}

/**
 * Expect the commits read to give the answers of the refs and log reads, and its token, when it has one, to give
 * `unchanged` straight after.
 * @returns The token.
 */
async function expectCommitsAsSingleReads(repo: string, includeRemotes: boolean, request: EngineLogRequest) {
	const engine = harness.engine;
	const label = { repo: repo, includeRemotes: includeRemotes, request: request };
	const combined = await engine.commits(repo, includeRemotes, request, null);
	const refs = await engine.refs(repo, includeRemotes), log = await engine.log(repo, request);
	if (!('ok' in combined)) {
		// The repository didn't open, so each single read gives the same answer
		expect({ label: label, answers: [refs, log] }).toStrictEqual({ label: label, answers: [combined, combined] });
		return null;
	}
	const answer = <Exclude<CommitsAnswer, { unchanged: true }>>combined.ok;
	expect({ label: label, answer: answer }).toStrictEqual({ label: label, answer: { token: 'ok' in refs && 'ok' in log ? expect.stringMatching(TOKEN) : null, refs: refs, log: log } });
	if (answer.token !== null) {
		expect({ label: label, answer: await engine.commits(repo, includeRemotes, request, answer.token) }).toStrictEqual({ label: label, answer: { ok: { token: answer.token, unchanged: true } } });
	}
	return answer.token;
}

/**
 * The log requests the view makes, with each ordering, first parent option and format.
 */
async function viewRequests(repo: string) {
	const stashes = await harness.engine.stashes(repo, FORMATS[0]);
	const stashBases = 'ok' in stashes ? stashes.ok.map((stash) => stash.parents[0]).filter((hash, i, hashes) => hashes.indexOf(hash) === i) : [];
	const branches = await harness.engine.branches(repo, false);
	const head = 'ok' in branches ? branches.ok.filter((branch) => branch.current).map((branch) => branch.name) : [];
	const revisions = [
		['--branches', '--tags', '--remotes', ...stashBases, 'HEAD'],
		['--branches', '--tags', '--reflog', '--remotes', ...stashBases, 'HEAD'],
		['--branches', '--glob=refs/remotes/origin', ...stashBases, 'HEAD'],
		head.length > 0 ? head : ['HEAD']
	];
	const requests: EngineLogRequest[] = [];
	for (const order of ORDERINGS) {
		for (const firstParent of [false, true]) {
			for (const format of FORMATS) {
				revisions.forEach((revision, i) => requests.push(logRequest(revision, i === 0 ? 301 : i === 1 ? 100000 : 5, order, firstParent, format)));
			}
		}
	}
	return requests;
}

function logRequest(revisions: ReadonlyArray<string>, maxCount: number, order: CommitOrdering = CommitOrdering.Date, firstParent: boolean = false, format: EngineFormat = FORMATS[0]): EngineLogRequest {
	return { revisions: revisions, maxCount: maxCount, order: order, firstParent: firstParent, format: format };
}


/* Building repositories */

/**
 * Build a repository for the token's changes: branches, merges, tags, a remote and an amended commit in the reflogs.
 */
function buildChangingRepository(dir: string) {
	init(dir);
	for (let i = 0; i < 5; i++) commit(dir, 'Main ' + i, String(1700000000 + i * 100));
	git(dir, 'checkout', '-q', '-b', 'other', 'HEAD~2');
	commit(dir, 'Other', '1700000550');
	git(dir, 'checkout', '-q', 'main');
	merge(dir, 'other', 'Merge other', '1700000600');
	git(dir, 'tag', 'light', 'HEAD~1');
	git(dir, 'tag', '-a', '-m', 'Annotated', 'annotated', 'HEAD~2');
	git(dir, 'remote', 'add', 'origin', 'https://example.com/origin.git');
	git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD~1');
	commit(dir, 'Amended away', '1700000700');
	cp.execFileSync('git', ['commit', '-q', '--amend', '--allow-empty', '-m', 'Amended'], { cwd: dir, env: gitEnv('1700000800'), stdio: 'pipe' });
	return dir;
}
