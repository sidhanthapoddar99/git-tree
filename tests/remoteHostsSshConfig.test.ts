import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseSshConfig, readSshAliases } from '../src/remoteHosts/sshConfig';

/*
 * The SSH configuration reader, on files in a temporary home folder, so ~/.ssh is never read.
 */

let home: string, sshDir: string;

beforeEach(() => {
	home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-tree-ssh-config-')));
	sshDir = path.join(home, '.ssh');
	fs.mkdirSync(sshDir);
});

afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true });
});

describe('parseSshConfig', () => {
	it('Should read the keywords in any case, with spaces or =, quotes and comments', () => {
		// Run
		const lines = parseSshConfig([
			'# A comment',
			'Include ~/.ssh/config.d/* "with space"',
			'Host build-box gpu-01 # two aliases',
			'  HostName 10.0.0.2',
			'  user=ubuntu',
			'',
			'host = lowercase',
			'\tHost "quoted"',
			'Match host foo',
			'Port 22'
		].join('\r\n'));

		// Assert
		expect(lines).toStrictEqual([
			{ kind: 'include', paths: ['~/.ssh/config.d/*', 'with space'] },
			{ kind: 'host', patterns: ['build-box', 'gpu-01'] },
			{ kind: 'hostName', value: '10.0.0.2' },
			{ kind: 'user', value: 'ubuntu' },
			{ kind: 'host', patterns: ['lowercase'] },
			{ kind: 'host', patterns: ['quoted'] },
			{ kind: 'match' }
		]);
	});
});

describe('readSshAliases', () => {
	it('Should list each literal alias once, with its block\'s first HostName and User', async () => {
		// Setup
		write('config', [
			'User everyone',
			'Host build-box gpu-01',
			'  HostName 10.0.0.2',
			'  HostName ignored',
			'  User ubuntu',
			'Host *.example.com !bad.example.com prod-?',
			'  User pattern',
			'Host plain',
			'Host build-box',
			'  User later',
			'Match host plain',
			'  HostName from-match'
		]);

		// Run
		const aliases = await readSshAliases(path.join(sshDir, 'config'), home);

		// Assert
		expect(aliases).toStrictEqual([
			{ alias: 'build-box', hostName: '10.0.0.2', user: 'ubuntu' },
			{ alias: 'gpu-01', hostName: '10.0.0.2', user: 'ubuntu' },
			{ alias: 'plain', hostName: null, user: null }
		]);
	});

	it('Should follow Include with ~, relative paths and globs, in lexical order where it appears', async () => {
		// Setup
		write('config', ['Host first', 'Include config.d/*.conf ~/other/extra', 'Host last']);
		write('config.d/b.conf', ['Host from-b']);
		write('config.d/a.conf', ['Host from-a', '  User a']);
		write('config.d/.hidden.conf', ['Host hidden']);
		write('config.d/c.txt', ['Host not-matched']);
		fs.mkdirSync(path.join(home, 'other'));
		fs.writeFileSync(path.join(home, 'other', 'extra'), 'Host extra\n');

		// Run
		const aliases = await readSshAliases(path.join(sshDir, 'config'), home);

		// Assert
		expect(aliases.map((alias) => alias.alias)).toStrictEqual(['first', 'from-a', 'from-b', 'extra', 'last']);
		expect(aliases[1].user).toBe('a');
	});

	it('Should follow an absolute Include, and glob sets', async () => {
		// Setup
		write('config', ['Include ' + path.join(sshDir, 'hosts-[ab]'), 'Include ' + path.join(sshDir, 'hosts-[!ab]')]);
		write('hosts-a', ['Host a']);
		write('hosts-b', ['Host b']);
		write('hosts-c', ['Host c']);

		// Run
		const aliases = await readSshAliases(path.join(sshDir, 'config'), home);

		// Assert
		expect(aliases.map((alias) => alias.alias)).toStrictEqual(['a', 'b', 'c']);
	});

	it('Should give an included file\'s first lines to the block of its Include line', async () => {
		// Setup
		write('config', ['Host box', '  Include box.conf', '  User after']);
		write('box.conf', ['HostName box.example.com']);

		// Run
		const aliases = await readSshAliases(path.join(sshDir, 'config'), home);

		// Assert
		expect(aliases).toStrictEqual([{ alias: 'box', hostName: 'box.example.com', user: 'after' }]);
	});

	it('Should stop following includes 16 deep, as ssh does', async () => {
		// Setup: config includes level-1, which includes level-2, and so on
		write('config', ['Include level-1']);
		for (let i = 1; i <= 20; i++) write('level-' + i, ['Host alias-' + i, 'Include level-' + (i + 1)]);

		// Run
		const aliases = await readSshAliases(path.join(sshDir, 'config'), home);

		// Assert
		expect(aliases.map((alias) => alias.alias)).toStrictEqual(Array.from({ length: 16 }, (_, i) => 'alias-' + (i + 1)));
	});

	it('Should stop at a file that includes itself', async () => {
		// Setup
		write('config', ['Host loop', 'Include config']);

		// Run
		const aliases = await readSshAliases(path.join(sshDir, 'config'), home);

		// Assert
		expect(aliases).toStrictEqual([{ alias: 'loop', hostName: null, user: null }]);
	});

	it('Should have no aliases without a file, and skip includes that match nothing', async () => {
		// Assert
		expect(await readSshAliases(path.join(sshDir, 'config'), home)).toStrictEqual([]);

		// Setup
		write('config', ['Include missing/* nothing', 'Host only']);

		// Assert
		expect(await readSshAliases(path.join(sshDir, 'config'), home)).toStrictEqual([{ alias: 'only', hostName: null, user: null }]);
	});
});

function write(file: string, lines: string[]) {
	const filePath = path.join(sshDir, file);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, lines.join('\n') + '\n');
}
