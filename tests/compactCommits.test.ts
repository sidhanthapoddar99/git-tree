import * as vscode from './mocks/vscode';
jest.mock('vscode', () => vscode, { virtual: true });

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { createLoadCommitsResponse, encodeCommits, getCommitsToken } from '../src/compactCommits';
import { CompactCommits, GitCommit, ResponseLoadCommitsPage } from '../src/types';

/**
 * Load functions from a webview file. The webview's files are scripts that share one scope, not modules, so the file is
 * compiled to JavaScript and run in this test's realm, where Jest compares its objects like the test's own.
 * @param file The name of the file in web/.
 * @param names The names of the functions.
 * @returns The functions.
 */
function loadWebFunctions(file: string, names: string[]) {
	const source = fs.readFileSync(path.join(__dirname, '..', 'web', file), 'utf8');
	const script = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2017 } }).outputText;
	return new Function(script + '\nreturn { ' + names.join(', ') + ' };')();
}

const web: {
	decodeCommits: (compact: CompactCommits) => GitCommit[],
	areCommitsIdentical: (a: ReadonlyArray<GitCommit>, b: ReadonlyArray<GitCommit>) => boolean
} = loadWebFunctions('compactCommits.ts', ['decodeCommits', 'areCommitsIdentical']);

const HASH1 = '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b';
const HASH2 = '2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c';
const HASH3 = '3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d';
const HASH4 = '4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e';
const STASH = '98adab72e57a098a45cc36e43a6c0fda95c44f8b';
const UNTRACKED = '9d81ce0a6cf64b6651bacd7a6c3a6ca90fd63235';
const OUTSIDE = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

/**
 * A page with every kind of row: the uncommitted changes of the viewed worktree and of another worktree, a stash with
 * untracked files, a merge, branches, tags, remote-tracking branches, and parents outside the page.
 */
function getPage(): GitCommit[] {
	const empty = { heads: [], tags: [], remotes: [], stash: null };
	return [
		{ hash: '*', parents: [HASH1], author: '*', email: '', date: 1587559260, message: 'Uncommitted Changes (2)', ...empty },
		{ hash: '*1', parents: [HASH3], author: '*', email: '', date: 1587559260, message: 'Uncommitted Changes (unable to read them)', ...empty, worktree: '/path/to/repo/.worktrees/review' },
		{ hash: STASH, parents: [HASH1, 'b30d6d4d14462e09515df02a8635e83b4278c8b1', UNTRACKED], author: 'Test Author', email: 'test@example.com', date: 1587559259, message: 'WIP on develop: 1a2b3c4 y', heads: [], tags: [], remotes: [], stash: { selector: 'refs/stash@{0}', baseHash: HASH1, untrackedFilesHash: UNTRACKED } },
		{ hash: HASH1, parents: [HASH2, HASH4], author: 'Test Author', email: 'test@example.com', date: 1587559258, message: 'Merge branch \'feature\'', heads: ['develop', 'master'], tags: [{ name: 'v1.0', annotated: true }, { name: 'nightly', annotated: false }], remotes: [{ name: 'origin/master', remote: 'origin' }, { name: 'gone/master', remote: null }], stash: null },
		{ hash: HASH2, parents: [HASH3], author: 'Other Author', email: 'other@example.com', date: 1587559257, message: '', heads: [], tags: [{ name: 'v0.9', annotated: true }], remotes: [], stash: null },
		{ hash: HASH3, parents: [OUTSIDE], author: 'Test Author', email: 'second@example.com', date: 1587559256, message: 'Caf\u00e9 \u2014 \ud83d\ude00', heads: [], tags: [], remotes: [{ name: 'origin/feature', remote: 'origin' }], stash: null },
		{ hash: HASH4, parents: [], author: 'Other Author', email: 'other@example.com', date: 1587559255, message: 'Root commit', heads: ['feature'], tags: [], remotes: [], stash: null }
	];
}

/**
 * Send compact rows the way a message goes to the webview, and decode them.
 * @param compact The compact rows.
 * @returns The decoded rows.
 */
function sendAndDecode(compact: CompactCommits) {
	return web.decodeCommits(JSON.parse(JSON.stringify(compact)));
}

describe('encodeCommits and decodeCommits', () => {
	it('Should decode the rows that were encoded, exactly', () => {
		// Setup
		const page = getPage();

		// Run
		const result = sendAndDecode(encodeCommits(page));

		// Assert
		expect(result).toStrictEqual(page);
		expect('worktree' in result[0]).toBe(false);
	});

	it('Should decode the rows of a response, which encodes the uncommitted changes and the history apart', () => {
		// Setup
		const page = getPage();

		// Run
		const response = <ResponseLoadCommitsPage>createLoadCommitsResponse(1, false, null, { commits: page, head: HASH1, tags: ['nightly', 'v0.9', 'v1.0'], moreCommitsAvailable: true, error: null });
		const result = sendAndDecode(response.uncommitted).concat(sendAndDecode(response.commits));

		// Assert
		expect(response.uncommitted.rows.length).toBe(2);
		expect(result).toStrictEqual(page);
	});

	it('Should encode each person once, each parent in the rows as its index, and leave out the empty fields at the end of each row', () => {
		// Run
		const result = encodeCommits(getPage().slice(2));

		// Assert
		expect(result).toStrictEqual({
			people: ['Test Author', 'test@example.com', 'Other Author', 'other@example.com', 'Test Author', 'second@example.com'],
			rows: [
				[STASH, [1, 'b30d6d4d14462e09515df02a8635e83b4278c8b1', UNTRACKED], 0, 1587559259, 'WIP on develop: 1a2b3c4 y', [], [], [], ['refs/stash@{0}', HASH1, UNTRACKED]],
				[HASH1, [2, 4], 0, 1587559258, 'Merge branch \'feature\'', ['develop', 'master'], [['v1.0', 1], ['nightly', 0]], [['origin/master', 'origin'], ['gone/master', null]]],
				[HASH2, [3], 1, 1587559257, '', [], [['v0.9', 1]]],
				[HASH3, [OUTSIDE], 2, 1587559256, 'Caf\u00e9 \u2014 \ud83d\ude00', [], [], [['origin/feature', 'origin']]],
				[HASH4, [], 1, 1587559255, 'Root commit', ['feature']]
			]
		});
	});

	it('Should keep a worktree row\'s empty fields before its worktree', () => {
		// Run
		const result = encodeCommits(getPage().slice(1, 2));

		// Assert
		expect(result).toStrictEqual({
			people: ['*', ''],
			rows: [['*1', [HASH3], 0, 1587559260, 'Uncommitted Changes (unable to read them)', [], [], [], null, '/path/to/repo/.worktrees/review']]
		});
	});

	it('Should encode and decode no rows', () => {
		// Run
		const result = encodeCommits([]);

		// Assert
		expect(result).toStrictEqual({ people: [], rows: [] });
		expect(sendAndDecode(result)).toStrictEqual([]);
	});

	it('Should be about half the size of the rows as JSON, for a page of plain commits', () => {
		// Setup
		const commits: GitCommit[] = [];
		for (let i = 0; i < 300; i++) {
			const hash = (i.toString(16) + HASH1).substring(0, 40), parent = ((i + 1).toString(16) + HASH1).substring(0, 40);
			commits.push({ hash: hash, parents: [parent], author: 'Author ' + (i % 5), email: 'author' + (i % 5) + '@example.com', date: 1587559258 - i, message: 'Commit message ' + i, heads: [], tags: [], remotes: [], stash: null });
		}

		// Run
		const compact = JSON.stringify(encodeCommits(commits)).length, full = JSON.stringify(commits).length;

		// Assert
		expect(compact).toBeLessThan(full * 0.6);
		expect(sendAndDecode(encodeCommits(commits))).toStrictEqual(commits);
	});
});

describe('getCommitsToken', () => {
	const getToken = (page: GitCommit[], head: string | null = HASH1, tags: string[] = ['v1.0'], moreCommitsAvailable = false, onlyFollowFirstParent = false) => {
		return getCommitsToken(encodeCommits(page), head, tags, moreCommitsAvailable, onlyFollowFirstParent);
	};

	it('Should give the same token for the same rows', () => {
		// Run
		const token1 = getToken(getPage().slice(2)), token2 = getToken(getPage().slice(2));

		// Assert
		expect(token1).toBe(token2);
		expect(token1).toMatch(/^[0-9a-f]{40}$/);
	});

	type Change = (page: any[]) => void;
	const changes: [string, Change][] = [
		['hash', (page) => page[2].hash = OUTSIDE],
		['parent', (page) => page[2].parents = [HASH4]],
		['order of parents', (page) => page[1].parents = [HASH4, HASH2]],
		['author', (page) => page[2].author = 'Someone Else'],
		['email', (page) => page[2].email = 'someone@example.com'],
		['date', (page) => page[2].date++],
		['message', (page) => page[2].message = 'Commit Message'],
		['heads', (page) => page[1].heads = ['develop']],
		['tag name', (page) => page[1].tags = [{ name: 'v1.1', annotated: true }, { name: 'nightly', annotated: false }]],
		['tag annotation', (page) => page[2].tags = [{ name: 'v0.9', annotated: false }]],
		['remote-tracking branch', (page) => page[3].remotes = [{ name: 'upstream/feature', remote: 'upstream' }]],
		['remote of a remote-tracking branch', (page) => page[3].remotes = [{ name: 'origin/feature', remote: null }]],
		['stash selector', (page) => page[0].stash = { ...page[0].stash, selector: 'refs/stash@{1}' }],
		['stash untracked files', (page) => page[0].stash = { ...page[0].stash, untrackedFilesHash: null }],
		['stash base', (page) => page[0].stash = { ...page[0].stash, baseHash: HASH2 }],
		['worktree', (page) => page[4].worktree = '/path/to/worktree'],
		['number of rows', (page) => page.pop()]
	];
	changes.forEach(([field, change]) => {
		it('Should give a different token when the ' + field + ' differs', () => {
			// Setup
			const page = getPage().slice(2);
			change(page);

			// Run
			const result = getToken(page);

			// Assert
			expect(result).not.toBe(getToken(getPage().slice(2)));
		});
	});

	it('Should give a different token when the head, the tags, moreCommitsAvailable or onlyFollowFirstParent differs', () => {
		// Setup
		const page = getPage().slice(2), token = getToken(page);

		// Assert
		expect(getToken(page, HASH2)).not.toBe(token);
		expect(getToken(page, null)).not.toBe(token);
		expect(getToken(page, HASH1, ['v1.0', 'v0.9'])).not.toBe(token);
		expect(getToken(page, HASH1, ['v1.0'], true)).not.toBe(token);
		expect(getToken(page, HASH1, ['v1.0'], false, true)).not.toBe(token);
	});
});

describe('createLoadCommitsResponse', () => {
	const data = (page: GitCommit[]) => ({ commits: page, head: HASH1, tags: ['nightly', 'v0.9', 'v1.0'], moreCommitsAvailable: false, error: null });
	const getPageToken = () => (<ResponseLoadCommitsPage>createLoadCommitsResponse(1, false, null, data(getPage()))).token!;

	it('Should send the full page, with its token, when the request has no token', () => {
		// Run
		const result = createLoadCommitsResponse(2, false, null, data(getPage()));

		// Assert
		expect(result).toStrictEqual({
			command: 'loadCommits',
			refreshId: 2,
			unchanged: false,
			uncommitted: encodeCommits(getPage().slice(0, 2)),
			commits: encodeCommits(getPage().slice(2)),
			head: HASH1,
			tags: ['nightly', 'v0.9', 'v1.0'],
			moreCommitsAvailable: false,
			onlyFollowFirstParent: false,
			token: getCommitsToken(encodeCommits(getPage().slice(2)), HASH1, ['nightly', 'v0.9', 'v1.0'], false, false),
			error: null
		});
	});

	it('Should send only the rows of uncommitted changes when the request\'s token is the page\'s token', () => {
		// Run
		const result = createLoadCommitsResponse(2, false, getPageToken(), data(getPage()));

		// Assert
		expect(result).toStrictEqual({ command: 'loadCommits', refreshId: 2, unchanged: true, uncommitted: encodeCommits(getPage().slice(0, 2)), token: getPageToken(), error: null });
	});

	it('Should give the same token when only the rows of uncommitted changes differ', () => {
		// Setup
		const page = getPage();
		page.splice(0, 2, { ...page[0], message: 'Uncommitted Changes (5)', date: 1587559300 });

		// Run
		const result = createLoadCommitsResponse(2, false, getPageToken(), data(page));

		// Assert
		expect(result).toStrictEqual({ command: 'loadCommits', refreshId: 2, unchanged: true, uncommitted: encodeCommits(page.slice(0, 1)), token: getPageToken(), error: null });
	});

	it('Should send the full page when the request\'s token is another page\'s', () => {
		// Setup
		const page = getPage();
		page[3] = { ...page[3], heads: ['develop'] };

		// Run
		const result = createLoadCommitsResponse(2, false, getPageToken(), data(page));

		// Assert
		expect(result.unchanged).toBe(false);
		expect(sendAndDecode((<ResponseLoadCommitsPage>result).commits)).toStrictEqual(page.slice(2));
		expect(result.token).not.toBe(getPageToken());
	});

	it('Should send the full page when the page was read following only the first parent, and the token wasn\'t', () => {
		// Run
		const result = createLoadCommitsResponse(2, true, getPageToken(), data(getPage()));

		// Assert
		expect(result.unchanged).toBe(false);
	});

	it('Should send no token, and never unchanged, when the commits couldn\'t be loaded', () => {
		// Setup
		const failed = { commits: [], head: null, tags: [], moreCommitsAvailable: false, error: 'error message' };
		const emptyToken = getCommitsToken(encodeCommits([]), null, [], false, false);

		// Run
		const result = createLoadCommitsResponse(2, false, emptyToken, failed);

		// Assert
		expect(result).toStrictEqual({
			command: 'loadCommits',
			refreshId: 2,
			unchanged: false,
			uncommitted: { people: [], rows: [] },
			commits: { people: [], rows: [] },
			head: null,
			tags: [],
			moreCommitsAvailable: false,
			onlyFollowFirstParent: false,
			token: null,
			error: 'error message'
		});
	});
});

describe('areCommitsIdentical', () => {
	it('Should find a page identical to its own copy', () => {
		// Assert
		expect(web.areCommitsIdentical(getPage(), sendAndDecode(encodeCommits(getPage())))).toBe(true);
		expect(web.areCommitsIdentical([], [])).toBe(true);
	});

	type Change = (page: any[]) => void;
	const changes: [string, Change][] = [
		['hash', (page) => page[2].hash = OUTSIDE],
		['parent', (page) => page[3].parents = [HASH2]],
		['author', (page) => page[3].author = 'Someone Else'],
		['email', (page) => page[3].email = 'someone@example.com'],
		['date', (page) => page[3].date++],
		['message', (page) => page[3].message = 'Commit Message'],
		['heads', (page) => page[3].heads = ['develop']],
		['tag name', (page) => page[4].tags = [{ name: 'v1.1', annotated: true }]],
		['tag annotation', (page) => page[4].tags = [{ name: 'v0.9', annotated: false }]],
		['remote-tracking branch', (page) => page[5].remotes = [{ name: 'upstream/feature', remote: 'upstream' }]],
		['remote of a remote-tracking branch', (page) => page[5].remotes = [{ name: 'origin/feature', remote: null }]],
		['stash', (page) => page[2].stash = null],
		['stash selector', (page) => page[2].stash = { ...page[2].stash, selector: 'refs/stash@{1}' }],
		['stash base', (page) => page[2].stash = { ...page[2].stash, baseHash: HASH2 }],
		['stash untracked files', (page) => page[2].stash = { ...page[2].stash, untrackedFilesHash: null }],
		['worktree', (page) => page[1].worktree = '/path/to/worktree'],
		['number of rows', (page) => page.pop()]
	];
	changes.forEach(([field, change]) => {
		it('Should find the pages different when the ' + field + ' differs', () => {
			// Setup
			const page = getPage();
			change(page);

			// Assert
			expect(web.areCommitsIdentical(page, getPage())).toBe(false);
			expect(web.areCommitsIdentical(getPage(), page)).toBe(false);
		});
	});
});
