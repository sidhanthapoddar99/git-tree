import * as vscode from '../mocks/vscode';
jest.mock('vscode', () => vscode, { virtual: true });
jest.mock('../../src/askpass/askpassManager');
jest.mock('../../src/logger');

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ROOT, commit, createDataSource, describeWithEngine, engineBuilt, git, gitEnv, harness, init, merge, readTwice, useEngineHarness } from './harness';

/*
 * Differential tests of the Commit Details View's reads: each engine read against the Git CLI read, on real
 * repositories. Every commit's details, diff, subject and files are read both ways, as are commit comparisons,
 * stashes, tags, remote URLs and the configuration.
 */

if (!engineBuilt) {
	test('the engine is not built, so the differential tests are skipped', () => { });
}

describeWithEngine('The engine reads the details Git reads', () => {
	useEngineHarness();

	beforeAll(() => {
		cp.execFileSync('bash', [path.join(ROOT, 'scripts', 'make-demo-repo.sh')], { env: Object.assign({}, process.env, { DEMO_DIR: path.join(harness.tmp, 'demo') }), stdio: 'pipe' });
	});

	describe('The demo repository', () => {
		const demo = () => path.join(harness.tmp, 'demo');
		const repos: [string, () => string][] = [
			['the main worktree', () => path.join(demo(), 'demo-repo')],
			['a linked worktree', () => path.join(demo(), 'demo-repo', '.worktrees', 'alerts')],
			['the bare remote', () => path.join(demo(), 'demo-origin.git')]
		];
		describe.each(repos)('%s', (_, repo) => {
			it('Reads every commit\'s details and files', async () => {
				await expectSameCommitDetails(repo());
				// Some of the demo's commits rename a file and change it
				expectOnlyAnswersOkOr(['git would look for renames']);
			});

			it('Reads the comparisons between commits', async () => {
				await expectSameComparisons(repo());
				expectOnlyAnswersOkOr(['git would look for renames']);
			});

			it('Reads the stashes, tags, remote URLs and configuration', async () => {
				await expectSameRepositoryDetails(repo());
				// The view shows the details of annotated tags only
				expectOnlyAnswersOkOr(['is a lightweight tag']);
			});
		});
	});

	describe('This repository', () => {
		it('Reads every commit\'s details and files', async () => {
			await expectSameCommitDetails(ROOT, 300);
			expectNoFailedAnswers();
		});

		it('Reads the comparisons between commits', async () => {
			await expectSameComparisons(ROOT, 300);
			expectNoFailedAnswers();
		});

		it('Reads the stashes, tags, remote URLs and configuration', async () => {
			await expectSameRepositoryDetails(ROOT);
			expectNoFailedAnswers();
		});
	});

	describe('A repository built for edge cases', () => {
		let repo: string;
		beforeAll(() => {
			repo = buildDetailsRepository(path.join(harness.tmp, 'details'));
		});

		afterAll(() => {
			fs.rmSync(path.join(process.env.HOME!, '.gitconfig'), { force: true });
		});

		it('Reads every commit\'s details and files', async () => {
			await expectSameCommitDetails(repo);
			expectOnlyAnswersOkOr([]);
		});

		it('Reads the comparisons between commits', async () => {
			await expectSameComparisons(repo);
			// Consecutive commits on different branches add and delete files that Git may find renamed
			expectOnlyAnswersOkOr(['git would look for renames']);
		});

		it('Reads the stashes, tags, remote URLs and configuration', async () => {
			await expectSameRepositoryDetails(repo);
			expectOnlyAnswersOkOr(['is a lightweight tag']);
		});

		it('Reads the commit details with the mailmap setting, and with the signature status, of unsigned commits', async () => {
			vscode.mockExtensionSettingReturnValue('repository.useMailmap', true);
			vscode.mockExtensionSettingReturnValue('repository.commits.showSignatureStatus', true);
			try {
				await expectSameCommitDetails(repo);
			} finally {
				vscode.mockExtensionSettingReturnValue('repository.useMailmap', undefined);
				vscode.mockExtensionSettingReturnValue('repository.commits.showSignatureStatus', undefined);
			}
			expectOnlyAnswersOkOr([]);
		});

		it('Reads the global configuration from the XDG file when there is no ~/.gitconfig', async () => {
			const xdg = path.join(process.env.XDG_CONFIG_HOME!, 'git', 'config');
			fs.mkdirSync(path.dirname(xdg), { recursive: true });
			fs.renameSync(path.join(process.env.HOME!, '.gitconfig'), xdg);
			try {
				await expectSameRepositoryDetails(repo);
			} finally {
				fs.renameSync(xdg, path.join(process.env.HOME!, '.gitconfig'));
			}
			expectOnlyAnswersOkOr(['is a lightweight tag']);
		});
	});

	describe('Details the engine leaves to Git', () => {
		// Each read is done with Git, so the results are still equal, and the engine says why
		const cases: [string, (dir: string) => string, string][] = [
			['a diff attribute', (dir) => {
				const repo = buildChangeRepository(dir);
				fs.writeFileSync(path.join(repo, '.gitattributes'), '*.txt diff=words\n');
				return repo;
			}, 'attribute'],
			['the binary macro attribute, in info/attributes', (dir) => {
				const repo = buildChangeRepository(dir);
				fs.mkdirSync(path.join(repo, '.git', 'info'), { recursive: true });
				fs.writeFileSync(path.join(repo, '.git', 'info', 'attributes'), 'a.txt binary\n');
				return repo;
			}, 'attribute'],
			['a global attributes file', (dir) => {
				const repo = buildChangeRepository(dir);
				const file = path.join(dir + '-attributes');
				fs.writeFileSync(file, '*.txt -diff\n');
				git(repo, 'config', 'core.attributesFile', file);
				return repo;
			}, 'attribute'],
			['diff.algorithm=histogram', (dir) => {
				const repo = buildChangeRepository(dir);
				git(repo, 'config', 'diff.algorithm', 'histogram');
				return repo;
			}, 'diff.algorithm'],
			['diff.context=0', (dir) => {
				const repo = buildChangeRepository(dir);
				git(repo, 'config', 'diff.context', '0');
				return repo;
			}, 'diff.context'],
			['core.bigFileThreshold', (dir) => {
				const repo = buildChangeRepository(dir);
				git(repo, 'config', 'core.bigFileThreshold', '10');
				return repo;
			}, 'core.bigFileThreshold'],
			['a rename of a file that changed', (dir) => {
				const repo = init(dir);
				write(repo, 'old.txt', lines(20, 'line'));
				git(repo, 'add', '-A');
				commit(repo, 'Add', '1700000000');
				git(repo, 'mv', 'old.txt', 'new.txt');
				write(repo, 'new.txt', lines(20, 'line') + 'one more\n');
				git(repo, 'add', '-A');
				commit(repo, 'Rename and change', '1700000100');
				return repo;
			}, 'renames'],
			['a diff too large to count exactly', (dir) => {
				const repo = init(dir);
				write(repo, 'big.txt', lines(600, 'line'));
				git(repo, 'add', '-A');
				commit(repo, 'Add', '1700000000');
				// Reversing the lines keeps every line in both files, so none is set aside
				write(repo, 'big.txt', lines(600, 'line').split('\n').slice(0, -1).reverse().join('\n') + '\n');
				git(repo, 'add', '-A');
				commit(repo, 'Reverse', '1700000100');
				return repo;
			}, 'too large'],
			['a submodule', (dir) => {
				const repo = buildChangeRepository(dir);
				git(repo, 'update-index', '--add', '--cacheinfo', '160000,' + git(repo, 'rev-parse', 'HEAD').trim() + ',sub');
				cp.execFileSync('git', ['commit', '-q', '-m', 'Add a submodule'], { cwd: repo, env: gitEnv('1700000200'), stdio: 'pipe' });
				return repo;
			}, 'submodule'],
			['a commit without a blank line after its headers', (dir) => {
				const repo = init(dir);
				const tree = git(repo, 'write-tree').trim();
				const id = cp.execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: repo, input: 'tree ' + tree + '\nauthor A <a@example.com> 1700000000 +0000\ncommitter A <a@example.com> 1700000000 +0000\n' }).toString().trim();
				git(repo, 'update-ref', 'refs/heads/main', id);
				return repo;
			}, 'blank line'],
			['an include section with two files', (dir) => {
				const repo = buildChangeRepository(dir);
				fs.writeFileSync(dir + '-one', '[one]\n\tvalue = 1\n');
				fs.writeFileSync(dir + '-two', '[two]\n\tvalue = 2\n');
				fs.appendFileSync(path.join(repo, '.git', 'config'), '[include]\n\tpath = ' + dir + '-one\n\tpath = ' + dir + '-two\n');
				return repo;
			}, 'include section'],
			['a tag that may be signed', (dir) => {
				const repo = buildChangeRepository(dir);
				const tag = 'object ' + git(repo, 'rev-parse', 'HEAD').trim() + '\ntype commit\ntag signed\ntagger A <a@example.com> 1700000000 +0000\n\nSigned\n-----BEGIN PGP SIGNATURE-----\n\nnot a signature\n-----END PGP SIGNATURE-----\n';
				const id = cp.execFileSync('git', ['hash-object', '-t', 'tag', '-w', '--stdin'], { cwd: repo, input: tag }).toString().trim();
				git(repo, 'update-ref', 'refs/tags/signed', id);
				return repo;
			}, 'may be signed']
		];
		it.each(cases)('%s', async (_, build, reason) => {
			const repo = build(path.join(harness.tmp, 'unsupported-' + Math.random().toString(36).slice(2)));
			await expectSameCommitDetails(repo);
			await expectSameComparisons(repo);
			await expectSameRepositoryDetails(repo);
			expect(harness.answers.map((answer) => answer.answer).filter((answer) => answer.startsWith('unsupported'))).toContainEqual(expect.stringContaining(reason));
			expectNoFailedAnswers();
		});

		it('A signed commit, when the signature status is shown', async () => {
			const repo = init(path.join(harness.tmp, 'signed'));
			const tree = git(repo, 'write-tree').trim();
			const object = 'tree ' + tree + '\nauthor A <a@example.com> 1700000000 +0000\ncommitter A <a@example.com> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n not a signature\n -----END PGP SIGNATURE-----\n\nSigned\n';
			const id = cp.execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: repo, input: object }).toString().trim();
			git(repo, 'update-ref', 'refs/heads/main', id);

			// Without the signature status, the engine reads it
			await expectSameCommitDetails(repo);
			expectOnlyAnswersOkOr([]);

			vscode.mockExtensionSettingReturnValue('repository.commits.showSignatureStatus', true);
			try {
				await expectSameCommitDetails(repo);
			} finally {
				vscode.mockExtensionSettingReturnValue('repository.commits.showSignatureStatus', undefined);
			}
			expect(harness.answers.map((answer) => answer.answer)).toContainEqual(expect.stringContaining('the commit is signed'));
		});

		it('Both global configuration files', async () => {
			const xdg = path.join(process.env.XDG_CONFIG_HOME!, 'git', 'config');
			fs.mkdirSync(path.dirname(xdg), { recursive: true });
			fs.writeFileSync(xdg, '[user]\n\tname = XDG Name\n');
			fs.writeFileSync(path.join(process.env.HOME!, '.gitconfig'), '[user]\n\tname = Home Name\n');
			try {
				await expectSameRepositoryDetails(buildChangeRepository(path.join(harness.tmp, 'both-global')));
			} finally {
				fs.rmSync(xdg);
				fs.rmSync(path.join(process.env.HOME!, '.gitconfig'));
			}
			expect(harness.answers.map((answer) => answer.answer)).toContainEqual(expect.stringContaining('both ~/.gitconfig and the XDG'));
		});

		it('A mailmap, when the mailmap is used', async () => {
			const repo = buildChangeRepository(path.join(harness.tmp, 'mailmap'));
			fs.writeFileSync(path.join(repo, '.mailmap'), 'Real Name <real@example.com> <ada@example.com>\n');
			vscode.mockExtensionSettingReturnValue('repository.useMailmap', true);
			try {
				await expectSameCommitDetails(repo);
			} finally {
				vscode.mockExtensionSettingReturnValue('repository.useMailmap', undefined);
			}
			expect(harness.answers.map((answer) => answer.answer)).toContainEqual(expect.stringContaining('.mailmap'));
		});
	});
});


/* Comparing reads */

/**
 * Read each commit's details and subject, and the files each one changed, on both sides, with Git and with the engine,
 * and expect equal results.
 */
async function expectSameCommitDetails(repo: string, maxCommits: number = 100000) {
	const commits = git(repo, 'rev-list', '--all', '--parents', '-n', String(maxCommits)).trim().split('\n').filter((line) => line !== '').map((line) => line.split(' '));
	for (const [hash, ...parents] of commits) {
		const label = { repo: repo, hash: hash };
		const [expected, actual] = await readTwice((dataSource) => dataSource.getCommitDetails(repo, hash, parents.length > 0));
		expect({ label: label, result: actual }).toStrictEqual({ label: label, result: expected });
		expect(expected.error).toBe(null);
		const [expectedSubject, actualSubject] = await readTwice((dataSource) => dataSource.getCommitSubject(repo, hash));
		expect({ label: label, result: actualSubject }).toStrictEqual({ label: label, result: expectedSubject });

		for (const change of expected.commitDetails!.fileChanges) {
			const files: [string, string][] = [];
			if (change.type !== 'D') files.push([hash, change.newFilePath]);
			if (change.type !== 'A' && parents.length > 0) files.push([parents[0], change.oldFilePath]);
			for (const [revision, file] of files) {
				const fileLabel = { repo: repo, revision: revision, file: file };
				const [expectedFile, actualFile] = await readTwice((dataSource) => dataSource.getCommitFile(repo, revision, file));
				expect({ label: fileLabel, result: actualFile }).toStrictEqual({ label: fileLabel, result: expectedFile });
			}
		}
	}

}

/**
 * Compare consecutive commits, which may be on different branches, the oldest commit with the newest, and each commit
 * with itself, with Git and with the engine, and expect equal results.
 */
async function expectSameComparisons(repo: string, maxCommits: number = 100000) {
	const commits = git(repo, 'rev-list', '--all', '-n', String(maxCommits)).trim().split('\n').filter((line) => line !== '').map((line) => [line]);
	const pairs = commits.slice(1).map((line, i): [string, string] => [line[0], commits[i][0]]);
	if (commits.length > 1) pairs.push([commits[commits.length - 1][0], commits[0][0]]);
	// A commit compared with itself runs git diff-tree, which shows a merge commit as no changes
	commits.forEach((line) => pairs.push([line[0], line[0]]));
	for (const [from, to] of pairs) {
		const label = { repo: repo, from: from, to: to };
		const [expected, actual] = await readTwice((dataSource) => dataSource.getCommitComparison(repo, from, to));
		expect({ label: label, result: actual }).toStrictEqual({ label: label, result: expected });
	}
}

/**
 * Read the stashes' details, the tags' details, the remotes' URLs and the configuration, with Git and with the engine,
 * and expect equal results.
 */
async function expectSameRepositoryDetails(repo: string) {
	const cli = createDataSource(null);
	const info = await cli.getRepoInfo(repo, true, true, []);
	cli.dispose();

	for (const stash of info.stashes) {
		const label = { repo: repo, stash: stash.selector };
		const [expected, actual] = await readTwice((dataSource) => dataSource.getStashDetails(repo, stash.hash, stash));
		expect({ label: label, result: actual }).toStrictEqual({ label: label, result: expected });
	}

	const tags = git(repo, 'for-each-ref', '--format=%(refname:strip=2)', 'refs/tags').split('\n').filter((tag) => tag !== '');
	for (const tag of tags) {
		const label = { repo: repo, tag: tag };
		const [expected, actual] = await readTwice((dataSource) => dataSource.getTagDetails(repo, tag));
		expect({ label: label, result: actual }).toStrictEqual({ label: label, result: expected });
	}

	for (const remote of info.remotes.concat(['missing'])) {
		const label = { repo: repo, remote: remote };
		const [expected, actual] = await readTwice((dataSource) => dataSource.getRemoteUrl(repo, remote));
		expect({ label: label, result: actual }).toStrictEqual({ label: label, result: expected });
	}

	const [expected, actual] = await readTwice((dataSource) => dataSource.getConfig(repo, info.remotes));
	expect({ repo: repo, result: actual }).toStrictEqual({ repo: repo, result: expected });
	expect(expected.error).toBe(null);
}

/**
 * Expect the engine to have answered every read itself, apart from reads it can't answer for one of these reasons.
 */
function expectOnlyAnswersOkOr(reasons: string[]) {
	expect(harness.answers.filter((answer) => answer.answer !== 'ok' && !reasons.some((reason) => answer.answer.startsWith('unsupported') && answer.answer.includes(reason)))).toStrictEqual([]);
}

function expectNoFailedAnswers() {
	expect(harness.answers.filter((answer) => answer.answer.startsWith('failed'))).toStrictEqual([]);
}


/* Building repositories */

function write(repo: string, file: string, contents: string | Buffer) {
	fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
	fs.writeFileSync(path.join(repo, file), contents);
}

function lines(count: number, prefix: string) {
	let text = '';
	for (let i = 0; i < count; i++) text += prefix + ' ' + i + '\n';
	return text;
}

/**
 * A repository with one commit that adds a file, and one that changes it.
 */
function buildChangeRepository(dir: string) {
	const repo = init(dir);
	write(repo, 'a.txt', 'one\ntwo\n');
	git(repo, 'add', '-A');
	commit(repo, 'Add', '1700000000');
	write(repo, 'a.txt', 'one\nthree\n');
	git(repo, 'add', '-A');
	commit(repo, 'Change', '1700000100');
	return repo;
}

/**
 * Build a repository with the file changes, messages, tags, stashes and configuration where the details reads are
 * easiest to get wrong.
 */
function buildDetailsRepository(dir: string) {
	const repo = init(dir);
	const stage = (message: string, date: string) => {
		git(repo, 'add', '-A');
		commit(repo, message, date);
	};

	// The root commit adds text, binary, empty, executable and non-ASCII files
	write(repo, 'README.md', 'Hello\nWorld\n');
	write(repo, 'dir/ünïcode file.txt', 'Grüße\n');
	write(repo, 'crlf.txt', 'one\r\ntwo\r\nthree\r\n');
	write(repo, 'no-newline.txt', 'last line');
	write(repo, 'binary.bin', Buffer.from([0, 1, 2, 3, 0, 255]));
	write(repo, 'empty.txt', '');
	write(repo, 'script.sh', '#!/bin/sh\necho hi\n');
	write(repo, 'same/a.txt', 'duplicate\n');
	write(repo, 'same/b.txt', 'duplicate\n');
	write(repo, 'lines.txt', lines(200, 'line'));
	write(repo, 'repeated.txt', 'x\n'.repeat(50) + 'y\n' + 'x\n'.repeat(50));
	write(repo, 'thing', 'a file that becomes a folder\n');
	// Attributes that don't change a diff
	write(repo, '.gitattributes', '# Line endings\n*.txt text eol=lf\n*.md linguist-documentation\n');
	write(repo, 'dir/.gitattributes', '*.bin -text whitespace=-trailing-space\n');
	stage('Root\n\nWith a body', '1700000000');

	// Edits: lines added, removed, moved and changed, a CRLF change, a newline added, a binary change and a mode change
	const edited = lines(200, 'line').split('\n');
	edited.splice(10, 3);
	edited.splice(50, 0, 'inserted one', 'inserted two');
	edited[100] = 'changed';
	edited.push(...edited.splice(150, 5));
	write(repo, 'lines.txt', edited.join('\n'));
	write(repo, 'repeated.txt', 'x\n'.repeat(49) + 'z\n' + 'x\n'.repeat(52));
	write(repo, 'crlf.txt', 'one\r\n2\r\nthree\r\n');
	write(repo, 'no-newline.txt', 'last line\n');
	write(repo, 'binary.bin', Buffer.from([0, 1, 2, 4, 0, 255, 7]));
	fs.chmodSync(path.join(repo, 'script.sh'), 0o755);
	stage('Edits', '1700000100');

	// Renames of identical files: a moved non-ASCII file, two identical sources, a copy, and an empty file
	fs.mkdirSync(path.join(repo, 'moved'));
	fs.mkdirSync(path.join(repo, 'other'));
	git(repo, 'mv', 'dir/ünïcode file.txt', 'moved/ünïcode file.txt');
	git(repo, 'mv', 'same/a.txt', 'other/a.txt');
	git(repo, 'mv', 'same/b.txt', 'other/b2.txt');
	git(repo, 'mv', 'empty.txt', 'empty-renamed.txt');
	fs.copyFileSync(path.join(repo, 'README.md'), path.join(repo, 'README-copy.md'));
	stage('Renames', '1700000200');

	// Types: a file becomes a symbolic link (which the view leaves out) and a folder, and a symbolic link is added. Git
	// doesn't look for a rename between the deleted file and the added one, as one is less than half the other's size.
	fs.rmSync(path.join(repo, 'script.sh'));
	fs.symlinkSync('README.md', path.join(repo, 'script.sh'));
	fs.symlinkSync('lines.txt', path.join(repo, 'link'));
	fs.rmSync(path.join(repo, 'thing'));
	write(repo, 'thing/inside.txt', 'now a folder\n');
	stage('Types', '1700000300');
	git(repo, 'rm', '-q', 'README-copy.md');
	stage('Delete', '1700000350');

	// An empty commit, and a commit whose message has trailing blank lines and Windows line endings
	commit(repo, 'Empty', '1700000400');
	write(repo, 'crlf.txt', 'one\r\n2\r\n3\r\n');
	git(repo, 'add', '-A');
	commit(repo, 'Message\r\n\r\nWith CRLF\r\n\r\n\r\n', '1700000500');

	// A merge with changes on both sides, so its diff from the first parent differs from the second's
	git(repo, 'checkout', '-q', '-b', 'side');
	write(repo, 'side.txt', 'from the side\n');
	write(repo, 'lines.txt', 'top\n' + edited.join('\n'));
	stage('Side', '1700000600');
	git(repo, 'checkout', '-q', 'main');
	write(repo, 'main.txt', 'from main\n');
	stage('Main', '1700000700');
	merge(repo, 'side', 'Merge side', '1700000800');

	// Tags: annotated, with a multi-line message, a tag of a tag, a lightweight tag, an empty message, and messages git
	// writes only through mktag, with leading blank lines and with no newline at the end
	cp.execFileSync('git', ['tag', '-a', '-m', 'Release 1\n\nNotes\nMore notes', 'v1'], { cwd: repo, env: gitEnv('1700000900'), stdio: 'pipe' });
	cp.execFileSync('git', ['tag', '-a', '-m', 'Tag of a tag', 'v1-again', 'v1'], { cwd: repo, env: gitEnv('1700000910'), stdio: 'pipe' });
	git(repo, 'tag', 'light', 'HEAD~2');
	cp.execFileSync('git', ['tag', '-a', '--cleanup=verbatim', '-m', '', 'empty-message'], { cwd: repo, env: gitEnv('1700000920'), stdio: 'pipe' });
	const head = git(repo, 'rev-parse', 'HEAD').trim();
	for (const [name, message] of [['blank-lines', '\n\n\nAfter blank lines\n'], ['no-newline', 'No newline at the end'], ['ünïcode', 'Grüße 🌦️\r\nCRLF\r\n']]) {
		const tag = 'object ' + head + '\ntype commit\ntag ' + name + '\ntagger Tomás Ortega <tomas@example.com> 1700000930 -0130\n\n' + message;
		const id = cp.execFileSync('git', ['hash-object', '-t', 'tag', '-w', '--stdin'], { cwd: repo, input: tag }).toString().trim();
		git(repo, 'update-ref', 'refs/tags/' + name, id);
	}

	// Stashes: a tracked change, and one with untracked files, binary and non-ASCII among them
	write(repo, 'lines.txt', 'stashed\n' + edited.join('\n'));
	cp.execFileSync('git', ['stash', 'push', '-q', '-m', 'Tracked change'], { cwd: repo, env: gitEnv('1700001000'), stdio: 'pipe' });
	write(repo, 'main.txt', 'changed in the stash\n');
	write(repo, 'untracked ünïcode.txt', 'untracked\n');
	write(repo, 'untracked/binary.bin', Buffer.from([0, 0, 0]));
	cp.execFileSync('git', ['stash', 'push', '-q', '-u', '-m', 'Untracked change'], { cwd: repo, env: gitEnv('1700001100'), stdio: 'pipe' });

	// Remotes: one URL, two URLs (Git reads the last), and an implicit value
	git(repo, 'remote', 'add', 'origin', 'https://example.com/origin.git');
	git(repo, 'remote', 'add', 'mirror', 'https://example.com/first.git');
	git(repo, 'config', '--add', 'remote.mirror.url', 'https://example.com/second.git');
	fs.appendFileSync(path.join(repo, '.git', 'config'), '[remote "implicit"]\n\turl\n\tfetch = +refs/heads/*:refs/remotes/implicit/*\n');

	// Configuration: an included file, a legacy subsection, an implicit value, quotes, escapes and a continued line
	fs.writeFileSync(dir + '-included', '[included]\n\tValue = from the included file\n[user]\n\temail = included@example.com\n');
	fs.appendFileSync(path.join(repo, '.git', 'config'), [
		'[include]', '\tpath = ' + dir + '-included',
		'[Legacy.SubSection]', '\tKey = legacy',
		'[Section "Sub.Section"]', '\tKey = modern',
		'[flags]', '\timplicit', '\tquoted = "  spaced  " ; comment', '\tescaped = tab\\there\\nnewline', '\tcontinued = one \\', 'two',
		'\tdiffTool = vimdiff', '\tunicode = Grüße', ''
	].join('\n'));
	git(repo, 'config', 'diff.tool', 'meld');
	git(repo, 'config', 'user.name', 'Local Name');

	// The global configuration, which the tests' afterAll removes
	fs.writeFileSync(path.join(process.env.HOME!, '.gitconfig'), '[user]\n\tname = Global Name\n\temail = global@example.com\n[remote]\n\tpushDefault = origin\n');
	return repo;
}
