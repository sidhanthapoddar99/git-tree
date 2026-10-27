import * as vscode from '../mocks/vscode';
jest.mock('vscode', () => vscode, { virtual: true });
jest.mock('../../src/askpass/askpassManager');
jest.mock('../../src/logger');

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DataSource } from '../../src/dataSource';
import { RemoteHostSnapshot, RemoteHosts } from '../../src/remoteHosts';
import { CommitOrdering } from '../../src/types';
import { ROOT, buildLinearRepository, commit, createDataSource, describeWithEngine, engineBuilt, expectAnswers, expectOnlyOkAnswers, git, gitEnv, harness, init, merge, readTwice, useEngineHarness } from './harness';

/*
 * Differential tests: each engine read against the Git CLI read, on real repositories. A DataSource
 * without the engine reads with Git, a DataSource with the engine reads with the engine, and their
 * results must be equal. The engine's answers are recorded, so a test also fails when the engine
 * quietly handed a read it should answer back to Git.
 */

const ORDERINGS = [CommitOrdering.Date, CommitOrdering.AuthorDate, CommitOrdering.Topological];

if (!engineBuilt) {
	test('the engine is not built, so the differential tests are skipped', () => { });
}

describeWithEngine('The engine reads what Git reads', () => {
	useEngineHarness();
	beforeAll(() => {
		cp.execFileSync('bash', [path.join(ROOT, 'scripts', 'make-demo-repo.sh')], { env: Object.assign({}, process.env, { DEMO_DIR: path.join(harness.tmp, 'demo') }), stdio: 'pipe' });
	});

	describe('The demo repository', () => {
		const demo = () => path.join(harness.tmp, 'demo');
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
			repo = buildEdgeCaseRepository(path.join(harness.tmp, 'edge'));
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

	describe('The log order, on a history built to stress it', () => {
		// Equal dates, clock skew, octopus merges, a long side branch merged late, several roots, criss-cross
		// merges and a few hundred random commits. Each read is compared at many page sizes, because a walk
		// that stops early goes wrong at a page boundary first.
		const PAGES = [1, 2, 3, 10, 40, 150, 100000];
		let repo: string;
		beforeAll(() => {
			repo = buildOrderingRepository(path.join(harness.tmp, 'ordering'));
		});

		const readLogs = async () => {
			const cli = createDataSource(null);
			const info = await cli.getRepoInfo(repo, true, true, []);
			cli.dispose();
			expect(info.stashes.length).toBeGreaterThan(0);
			const starts: { branches: string[] | null, showTags: boolean, reflogs: boolean }[] = [
				{ branches: null, showTags: true, reflogs: false },
				{ branches: null, showTags: true, reflogs: true },
				{ branches: null, showTags: false, reflogs: false },
				{ branches: ['main'], showTags: true, reflogs: false }
			];
			for (const ordering of ORDERINGS) {
				for (const firstParent of [false, true]) {
					for (const start of starts) {
						for (const maxCount of PAGES) {
							const label = Object.assign({ ordering: ordering, firstParent: firstParent, maxCount: maxCount }, start);
							const [expected, actual] = await readTwice((dataSource) => {
								const read = dataSource['getLogRead'](start.branches, maxCount, start.showTags, true, start.reflogs, firstParent, ordering, info.remotes, [], info.stashes);
								return dataSource['getLog'](repo, read, (engine) => engine.log(repo, read.request));
							});
							expect({ label: label, result: actual }).toStrictEqual({ label: label, result: expected });
						}
					}
				}
			}
			expectOnlyOkAnswers();
		};

		it('Reads it without a commit-graph', async () => {
			await readLogs();
		});

		it('Reads it with a commit-graph of topological levels (generation version 1)', async () => {
			git(repo, '-c', 'commitGraph.generationVersion=1', 'commit-graph', 'write', '--reachable');
			await readLogs();
		});

		it('Reads it with a commit-graph of corrected commit dates (generation version 2)', async () => {
			git(repo, '-c', 'commitGraph.generationVersion=2', 'commit-graph', 'write', '--reachable');
			await readLogs();
		});

		it('Reads it with core.commitGraph=false', async () => {
			git(repo, 'config', 'core.commitGraph', 'false');
			await readLogs();
			git(repo, 'config', '--unset', 'core.commitGraph');
		});

		it('Reads it with a split commit-graph, and commits the commit-graph doesn\'t have', async () => {
			fs.rmSync(path.join(repo, '.git', 'objects', 'info', 'commit-graph'));
			// One layer of each generation version, which makes git read topological levels from both
			cp.execFileSync('git', ['-c', 'commitGraph.generationVersion=1', 'commit-graph', 'write', '--split', '--stdin-commits'], { cwd: repo, input: git(repo, 'rev-parse', 'mid') });
			git(repo, 'commit-graph', 'write', '--reachable', '--split=no-merge');
			const chain = fs.readFileSync(path.join(repo, '.git', 'objects', 'info', 'commit-graphs', 'commit-graph-chain'), 'utf8');
			expect(chain.trim().split('\n').length).toBe(2);
			await readLogs();

			// New commits on main, with tied dates, a merge and an octopus merge
			commit(repo, 'After the graph one', '1700090000');
			commit(repo, 'After the graph two', '1700090000');
			merge(repo, 'r1', 'Merge r1 after the graph', '1700090000');
			cp.execFileSync('git', ['merge', '-q', '--no-ff', '-m', 'Octopus after the graph', 'r2', 'r3'], { cwd: repo, env: gitEnv('1700090000'), stdio: 'pipe' });
			await readLogs();
		});

		/**
		 * Build the repository for the ordering tests with git fast-import, which sets every date and parent.
		 */
		function buildOrderingRepository(dir: string) {
			init(dir);
			const T = 1700000000;
			const stream: string[] = [];
			const dates: number[] = [];
			let marks = 0;
			// Add a commit with these parents (marks) on the scratch branch, and return its mark
			const add = (parents: number[], date: number, authorDate: number = date) => {
				const mark = ++marks;
				const message = 'Commit ' + mark;
				if (parents.length === 0) stream.push('reset refs/heads/build');
				stream.push('commit refs/heads/build', 'mark :' + mark, 'author Ada Park <ada@example.com> ' + authorDate + ' +0000', 'committer Ada Park <ada@example.com> ' + date + ' +0000', 'data ' + message.length, message);
				parents.forEach((parent, i) => stream.push((i === 0 ? 'from :' : 'merge :') + parent));
				stream.push('');
				dates[mark] = date;
				return mark;
			};
			const ref = (name: string, mark: number) => stream.push('reset ' + name, 'from :' + mark, '');

			// Main: five commits share each date
			const mainLine = [add([], T)];
			for (let i = 1; i <= 30; i++) mainLine.push(add([mainLine[i - 1]], T + Math.floor(i / 5) * 100));
			let main = mainLine[30];
			// A long side branch from early on, with dates between and equal to main's, merged late
			let long = mainLine[3];
			for (let i = 0; i < 40; i++) long = add([long], T + 50 + Math.floor(i / 3) * 50, T + 7 * i);
			// Three short branches with one date, merged in one octopus merge
			const arms = [1, 2, 3].map((arm) => {
				let tip = main;
				for (let i = 0; i < 3; i++) tip = add([tip], T + 4000, T + 4000 - arm);
				return tip;
			});
			main = add([main, ...arms], T + 4000);
			const octopus = main;
			// Clock skew: a child a day older than its parent, a branch whose dates go backwards, and a merge older than both parents
			main = add([main], T + 4100 - 86400);
			let skew = main;
			for (let i = 0; i < 5; i++) skew = add([skew], T + 4200 - i * 1000);
			main = add([main], T + 4300);
			main = add([main, skew], T + 1000);
			// A second root, merged in, and a third one that is never merged, tying with main's dates
			let docs = add([], T + 200);
			for (let i = 0; i < 10; i++) docs = add([docs], T + 300 + i * 500, T + 300);
			main = add([main, docs], T + 6000);
			let island = add([], T + 6000);
			for (let i = 0; i < 5; i++) island = add([island], T + 6000);
			// Criss-cross merges, then a merge whose first parent is also an ancestor of its second
			let left = add([main], T + 6100), right = add([main], T + 6100);
			const leftMerge = add([left, right], T + 6200), rightMerge = add([right, left], T + 6200);
			left = add([leftMerge], T + 6300);
			right = add([rightMerge], T + 6300);
			main = add([left, right], T + 6400);
			main = add([main, mainLine[28]], T + 6400);
			// The long branch merged late, with a tied date
			main = add([main, long], T + 6400);
			// A branch whose tip is a merge's second parent
			let feature = add([main], T + 6500);
			feature = add([feature], T + 6500);
			main = add([main], T + 6500);
			main = add([main, feature], T + 6600);
			// A commit only a tag reaches, and commits only the reflog of wip reaches, with distinct dates
			const tagged = add([mainLine[10]], T + 7000);
			const wip = [add([main], T + 7001), add([main], T + 7013), add([main], T + 7029)];

			// A few hundred random commits on a pool of branches, with many tied dates and some skew
			let seed = 7;
			const random = () => {
				seed = (seed * 1103515245 + 12345) % 2147483648;
				return seed / 2147483648;
			};
			const pick = <V>(items: V[]) => items[Math.floor(random() * items.length)];
			const pool = [main, long, island, left, right, docs];
			for (let i = 0; i < 300; i++) {
				const r = random();
				const count = r < 0.7 ? 1 : r < 0.95 ? 2 : 3 + Math.floor(random() * 2);
				const slots: number[] = [];
				while (slots.length < count) {
					const slot = Math.floor(random() * pool.length);
					if (!slots.includes(slot)) slots.push(slot);
					if (slots.length === pool.length) break;
				}
				const parents = slots.map((slot) => pool[slot]);
				const forkOld = random() < 0.1;
				if (forkOld) parents[0] = 1 + Math.floor(random() * (marks - 1));
				if (new Set(parents).size !== parents.length) continue;
				const base = Math.max(...parents.map((parent) => dates[parent]));
				const date = random() < 0.05 ? base - 5000 : base + pick([0, 0, 0, 0, 30, 60, 3600]);
				const authorDate = random() < 0.5 ? date : T + Math.floor(random() * 50) * 100;
				const added = add(parents, date, authorDate);
				if (forkOld) {
					pool.push(added);
				} else {
					pool[slots[0]] = added;
				}
			}

			ref('refs/heads/main', pool[0]);
			ref('refs/heads/long', long);
			ref('refs/heads/feature', feature);
			ref('refs/heads/island', island);
			ref('refs/heads/mid', mainLine[20]);
			pool.slice(1).forEach((mark, i) => ref('refs/heads/r' + (i + 1), mark));
			ref('refs/tags/light', mainLine[5]);
			ref('refs/tags/octopus', octopus);
			stream.push('tag release', 'from :' + tagged, 'tagger Ada Park <ada@example.com> ' + (T + 7000) + ' +0000', 'data 7', 'Release');
			ref('refs/remotes/origin/main', mainLine[25]);
			ref('refs/remotes/origin/topic', pick(pool));
			const marksFile = path.join(dir, '.git', 'marks');
			cp.execFileSync('git', ['fast-import', '--quiet', '--export-marks=' + marksFile], { cwd: dir, input: stream.join('\n') + '\n', stdio: ['pipe', 'pipe', 'pipe'] });
			const ids: string[] = [];
			for (const line of fs.readFileSync(marksFile, 'utf8').trim().split('\n')) {
				const [mark, id] = line.split(' ');
				ids[parseInt(mark.slice(1))] = id;
			}
			git(dir, 'update-ref', '-d', 'refs/heads/build');
			git(dir, 'remote', 'add', 'origin', 'https://example.com/origin.git');

			// The reflog of wip names commits no branch reaches, and a stash is based on an old commit
			wip.forEach((mark, i) => git(dir, 'update-ref', '-m', 'wip ' + i, 'refs/heads/wip', ids[mark]));
			git(dir, 'checkout', '-q', 'main');
			git(dir, 'checkout', '-q', '--detach', ids[mainLine[12]]);
			fs.writeFileSync(path.join(dir, 'file.txt'), 'stashed\n');
			git(dir, 'add', 'file.txt');
			cp.execFileSync('git', ['stash', 'push', '-q', '-m', 'On an old commit'], { cwd: dir, env: gitEnv(String(T + 7100)), stdio: 'pipe' });
			git(dir, 'checkout', '-q', 'main');
			return dir;
		}
	});

	describe('A repository with remote hosts', () => {
		let repo: string, remoteHosts: RemoteHosts, info: Awaited<ReturnType<DataSource['getRepoInfo']>>;
		const MISSING = '0123456789abcdef0123456789abcdef01234567';
		beforeAll(async () => {
			repo = buildLinearRepository(path.join(harness.tmp, 'hosts'), 6);
			git(repo, 'branch', 'feature', 'HEAD~2');
			git(repo, 'remote', 'add', 'origin', 'https://example.com/origin.git');
			git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD~1');
			// The fetched refs of the host "server": branches (one only it has, one nested), a detached worktree's commit,
			// and a branch that points to an annotated tag
			const tree = git(repo, 'rev-parse', 'HEAD^{tree}').trim();
			const commitTree = (message: string, parent: string, date: string) => cp.execFileSync('git', ['commit-tree', tree, '-p', parent, '-m', message], { cwd: repo, env: gitEnv(date) }).toString().trim();
			const serverOnly = commitTree('Only on the server', 'HEAD~3', '1700000250');
			const detached = commitTree('Detached on the server', serverOnly, '1700000260');
			const goneOnly = commitTree('Only on a removed host', 'HEAD~4', '1700000270');
			git(repo, 'update-ref', 'refs/git-tree/hosts/server/heads/main', 'HEAD~1');
			git(repo, 'update-ref', 'refs/git-tree/hosts/server/heads/topic/server-only', serverOnly);
			git(repo, 'update-ref', 'refs/git-tree/hosts/server/detached/0123456789ab', detached);
			git(repo, 'tag', '-a', '-m', 'Release', 'release', 'HEAD~2');
			git(repo, 'update-ref', 'refs/git-tree/hosts/server/heads/tagged', git(repo, 'rev-parse', 'release').trim());
			// The refs of a host that is no longer in the config, which are neither labels nor start points
			git(repo, 'update-ref', 'refs/git-tree/hosts/gone/heads/old', goneOnly);

			const worktree = (worktreePath: string, head: string, branch: string | null, isMain: boolean, host: string) => ({ path: worktreePath, name: path.posix.basename(worktreePath), head: head, branch: branch, isMain: isMain, isCurrent: false, locked: false, prunable: false, host: host });
			const snapshots: RemoteHostSnapshot[] = [
				{
					host: { name: 'server', ssh: 'gt-test', path: '/home/dev/app', state: 'ok', message: null, lastRefresh: 1700000000000 },
					worktrees: [
						{ worktree: worktree('/home/dev/app', git(repo, 'rev-parse', 'HEAD~1').trim(), 'main', true, 'server'), uncommittedChanges: 1, commitIsLocal: true },
						{ worktree: worktree('/home/dev/app-wt', detached, null, false, 'server'), uncommittedChanges: 0, commitIsLocal: true },
						{ worktree: worktree('/home/dev/app-far', MISSING, null, false, 'server'), uncommittedChanges: 0, commitIsLocal: false }
					]
				},
				// A host whose branches haven't been fetched yet: its glob matches no ref
				{ host: { name: 'new', ssh: 'gt-test', path: '/home/dev/app', state: 'loading', message: null, lastRefresh: null }, worktrees: [] }
			];
			remoteHosts = <RemoteHosts><unknown>{ getHosts: () => snapshots };
			const cli = createDataSource(null, remoteHosts);
			info = await cli.getRepoInfo(repo, true, true, []);
			cli.dispose();
		});

		it('Reads the repository info', async () => {
			for (const showRemoteBranches of [true, false]) {
				const [expected, actual] = await readTwice((dataSource) => dataSource.getRepoInfo(repo, showRemoteBranches, true, []), remoteHosts);
				expect(actual).toStrictEqual(expected);
			}
			expect(info.worktrees.filter((worktree) => worktree.host === 'server').length).toBe(3);
			expectOnlyOkAnswers();
		});

		it('Reads the commits, the hosts\' labels and their start points', async () => {
			const variants: { branches: string[] | null, showRemoteBranches: boolean, onlyHostWorktree: number | null }[] = [
				{ branches: null, showRemoteBranches: true, onlyHostWorktree: null },
				{ branches: null, showRemoteBranches: false, onlyHostWorktree: null },
				{ branches: ['main'], showRemoteBranches: false, onlyHostWorktree: null },
				// A host worktree's history: its commit is here, or it isn't and --ignore-missing leaves it out
				{ branches: null, showRemoteBranches: true, onlyHostWorktree: 2 },
				{ branches: null, showRemoteBranches: true, onlyHostWorktree: 3 },
				{ branches: ['feature'], showRemoteBranches: true, onlyHostWorktree: 3 }
			];
			for (const ordering of ORDERINGS) {
				for (const variant of variants) {
					const label = Object.assign({ ordering: ordering }, variant);
					const onlyHostWorktree = variant.onlyHostWorktree !== null ? info.worktrees[variant.onlyHostWorktree] : null;
					const [expected, actual] = await readTwice((dataSource) => dataSource.getCommits(repo, variant.branches, 300, true, variant.showRemoteBranches, false, false, ordering, info.remotes, [], info.stashes, info.worktrees, false, onlyHostWorktree), remoteHosts);
					expect({ label: label, result: actual }).toStrictEqual({ label: label, result: expected });
				}
			}
			expectOnlyOkAnswers();

			// What both read: the host's branches as labels, its detached worktree's commit, and nothing of the removed host
			const [result] = await readTwice((dataSource) => dataSource.getCommits(repo, null, 300, true, false, false, false, CommitOrdering.Date, info.remotes, [], info.stashes, info.worktrees), remoteHosts);
			const messages = result.commits.map((commit) => commit.message);
			expect(messages).toContain('Only on the server');
			expect(messages).toContain('Detached on the server');
			expect(messages).not.toContain('Only on a removed host');
			expect(([] as string[]).concat(...result.commits.map((commit) => (commit.hostBranches || []).map((branch) => branch.host + '/' + branch.name))).sort()).toStrictEqual(['server/main', 'server/tagged', 'server/topic/server-only']);
			expect(result.commits.some((commit) => commit.remotes.length > 0)).toBe(false);
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
			const repo = build(path.join(harness.tmp, 'unsupported-' + harness.answers.length + '-' + Math.random().toString(36).slice(2)));
			await expectSameRepoInfo(repo);
			for (const ordering of ORDERINGS) {
				await expectSameCommits(repo, ordering, false);
			}
			expect(harness.answers.map((answer) => answer.answer).filter((answer) => answer.startsWith('unsupported'))).toContainEqual(expect.stringContaining(reason));
			expect(harness.answers.filter((answer) => answer.answer.startsWith('failed'))).toStrictEqual([]);
		});

		it('A mailmap, when the mailmap is used', async () => {
			const repo = buildLinearRepository(path.join(harness.tmp, 'mailmap'), 2);
			fs.writeFileSync(path.join(repo, '.mailmap'), 'Real Name <real@example.com> <ada@example.com>\n');
			vscode.mockExtensionSettingReturnValue('repository.useMailmap', true);
			await expectSameRepoInfo(repo);
			await expectSameCommits(repo, CommitOrdering.Date, false);
			expect(harness.answers.map((answer) => answer.answer)).toContainEqual(expect.stringContaining('.mailmap'));
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


/* Building repositories */

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
