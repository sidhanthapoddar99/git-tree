import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BROWSE_LIMIT, BROWSE_SCRIPT, parseBrowseOutput } from '../src/remoteHosts/browse';
import { quotePosix } from '../src/remoteHosts/ssh';

describe('parseBrowseOutput', () => {
	it('Should read the path, its parent and the folders, sorted by name', () => {
		// Run
		const output = parseBrowseOutput('Welcome!\ngt:browse\0/srv/app\0/srv\0f zeta\0r app\0w app-wt\0f .hidden\0f gt:end\0gt:end\0');

		// Assert
		expect(output).toStrictEqual({
			kind: 'ok',
			path: '/srv/app',
			parent: '/srv',
			entries: [
				{ name: '.hidden', kind: 'folder' },
				{ name: 'app', kind: 'repository' },
				{ name: 'app-wt', kind: 'worktree' },
				{ name: 'gt:end', kind: 'folder' },
				{ name: 'zeta', kind: 'folder' }
			],
			truncated: false
		});
	});

	it('Should give the root no parent', () => {
		// Assert
		expect(parseBrowseOutput('gt:browse\0/\0/\0f home\0gt:end\0')).toStrictEqual({ kind: 'ok', path: '/', parent: null, entries: [{ name: 'home', kind: 'folder' }], truncated: false });
	});

	it('Should leave out a folder whose name holds a control character', () => {
		// Assert
		expect(parseBrowseOutput('gt:browse\0/srv\0/\0f a\nb\0f ok\0gt:end\0')).toStrictEqual({ kind: 'ok', path: '/srv', parent: '/', entries: [{ name: 'ok', kind: 'folder' }], truncated: false });
	});

	it('Should tell a path that can\'t be entered', () => {
		// Assert
		expect(parseBrowseOutput('gt:nopath\n')).toStrictEqual({ kind: 'noPath' });
	});

	it('Should refuse output that was cut short, or that the script didn\'t print', () => {
		// Assert
		expect(parseBrowseOutput('')).toStrictEqual({ kind: 'unreadable' });
		expect(parseBrowseOutput('gt:browse\0/srv\0/\0f a\0')).toStrictEqual({ kind: 'unreadable' });
		expect(parseBrowseOutput('gt:browse\0/srv\0/\0x a\0gt:end\0')).toStrictEqual({ kind: 'unreadable' });
		expect(parseBrowseOutput('gt:browse\0srv\0/\0gt:end\0')).toStrictEqual({ kind: 'unreadable' });
		expect(parseBrowseOutput('gt:browse\0/srv\0/\0f a/b\0gt:end\0')).toStrictEqual({ kind: 'unreadable' });
	});
});

describe('BROWSE_SCRIPT', () => {
	let tmp: string;

	beforeEach(() => {
		tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-tree-browse-')));
	});

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it('Should list the folders with their kinds, and their physical path', () => {
		// Setup
		fs.mkdirSync(path.join(tmp, 'repo', '.git'), { recursive: true });
		fs.mkdirSync(path.join(tmp, 'worktree'));
		fs.writeFileSync(path.join(tmp, 'worktree', '.git'), 'gitdir: /elsewhere\n');
		fs.mkdirSync(path.join(tmp, '.hidden'));
		fs.mkdirSync(path.join(tmp, '..dots'));
		fs.mkdirSync(path.join(tmp, 'it\'s a "folder"'));
		fs.writeFileSync(path.join(tmp, 'file'), '');
		fs.symlinkSync(tmp, path.join(tmp, 'link'));

		// Run
		const output = parseBrowseOutput(runScript(path.join(tmp, 'link')));

		// Assert
		expect(output).toStrictEqual({
			kind: 'ok',
			path: tmp,
			parent: path.dirname(tmp),
			entries: [
				{ name: '..dots', kind: 'folder' },
				{ name: '.hidden', kind: 'folder' },
				{ name: 'it\'s a "folder"', kind: 'folder' },
				{ name: 'link', kind: 'folder' },
				{ name: 'repo', kind: 'repository' },
				{ name: 'worktree', kind: 'worktree' }
			],
			truncated: false
		});
	});

	it('Should list the home folder for an empty path', () => {
		// Run
		const output = parseBrowseOutput(runScript('', { HOME: tmp }));

		// Assert
		expect(output).toStrictEqual({ kind: 'ok', path: tmp, parent: path.dirname(tmp), entries: [], truncated: false });
	});

	it('Should list at most ' + BROWSE_LIMIT + ' folders', () => {
		// Setup
		for (let i = 0; i < BROWSE_LIMIT + 5; i++) fs.mkdirSync(path.join(tmp, 'f' + i));

		// Run
		const output = parseBrowseOutput(runScript(tmp));

		// Assert
		expect(output.kind === 'ok' ? output.entries.length : null).toBe(BROWSE_LIMIT);
		expect(output.kind === 'ok' ? output.truncated : null).toBe(true);
	});

	it('Should not say a folder of exactly ' + BROWSE_LIMIT + ' folders was cut short', () => {
		// Setup
		for (let i = 0; i < BROWSE_LIMIT; i++) fs.mkdirSync(path.join(tmp, 'f' + i));

		// Run
		const output = parseBrowseOutput(runScript(tmp));

		// Assert
		expect(output.kind === 'ok' ? [output.entries.length, output.truncated] : null).toStrictEqual([BROWSE_LIMIT, false]);
	});

	it('Should say when the path can\'t be entered', () => {
		// Assert
		expect(parseBrowseOutput(runScript(path.join(tmp, 'missing')))).toStrictEqual({ kind: 'noPath' });
	});

	function runScript(folder: string, env: { [key: string]: string } = {}) {
		return cp.spawnSync('sh', ['-c', 'sh -s -- ' + quotePosix(folder)], { input: BROWSE_SCRIPT, env: Object.assign({}, process.env, env) }).stdout.toString();
	}
});
