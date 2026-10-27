import * as cp from 'child_process';
import * as fs from 'fs';
import { ProcessResult, classifySshFailure, getErrorLines, getForwardingSshOptions, getGitSshCommand, getSshOptions, isAuthenticationError, quotePosix, runProcess } from '../src/remoteHosts/ssh';

const PATHS = [
	'/home/dev/app',
	'/srv/it\'s an app',
	'/srv/\'\'\'',
	'/srv/with spaces/and  two',
	'/srv/$HOME/${PATH}/$(whoami)/`id`',
	'/srv/back\\slash\\\\n',
	'/srv/"double" quotes',
	'/srv/glob*?[a]',
	'/srv/semi;colon&amp|pipe>x<y',
	'/srv/~tilde/#hash/!bang',
	'/srv/ünïcode/日本'
];

function result(custom: Partial<ProcessResult>): ProcessResult {
	return Object.assign({ code: 0, stdout: Buffer.from(''), stderr: '', error: null, timedOut: false }, custom);
}

describe('quotePosix', () => {
	it('Should quote a value in single quotes', () => {
		expect(quotePosix('/a b')).toBe('\'/a b\'');
		expect(quotePosix('it\'s')).toBe('\'it\'\\\'\'s\'');
		expect(quotePosix('')).toBe('\'\'');
	});

	// Each shell that's installed reads each quoted path back as the path
	const shells = ['sh', 'dash', 'bash', 'zsh', 'fish', 'csh', 'tcsh'].filter((shell) => process.platform !== 'win32' && cp.spawnSync('sh', ['-c', 'command -v ' + shell]).status === 0);
	shells.forEach((shell) => {
		it('Should be read back as the same value by ' + shell, () => {
			PATHS.forEach((value) => {
				// Run
				const output = cp.execFileSync(shell, ['-c', 'printf %s ' + quotePosix(value)], { encoding: 'utf8' });

				// Assert
				expect(output).toBe(value);
			});
		});
	});

	it('Should pass each value as one argument to a script run with sh -s', () => {
		if (process.platform === 'win32') return;

		// Run
		const output = cp.execFileSync('sh', ['-c', 'sh -s -- ' + PATHS.map(quotePosix).join(' ')], { input: 'for a in "$@"; do printf "%s\\n" "$a"; done', encoding: 'utf8' });

		// Assert
		expect(output).toBe(PATHS.join('\n') + '\n');
	});
});

describe('getSshOptions', () => {
	it('Should share the connection, never prompt, and never forward the SSH agent', () => {
		expect(getSshOptions('/tmp/git-tree-1000', true)).toStrictEqual(['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ForwardAgent=no', '-o', 'ControlMaster=auto', '-o', 'ControlPersist=120', '-o', 'ControlPath=/tmp/git-tree-1000/%C']);
	});

	it('Should leave out connection sharing without a folder for it (Windows)', () => {
		expect(getSshOptions(null, true)).toStrictEqual(['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ForwardAgent=no']);
	});

	it('Should leave out BatchMode for an interactive terminal', () => {
		expect(getSshOptions('/tmp/git-tree-1000', false)).toStrictEqual(['-o', 'ControlMaster=auto', '-o', 'ControlPersist=120', '-o', 'ControlPath=/tmp/git-tree-1000/%C']);
	});

	it('Should quote each word of the command Git runs for SSH', () => {
		expect(getGitSshCommand('/opt/my ssh/ssh', '/tmp/git-tree-1000')).toBe('\'/opt/my ssh/ssh\' \'-o\' \'BatchMode=yes\' \'-o\' \'ConnectTimeout=10\' \'-o\' \'ForwardAgent=no\' \'-o\' \'ControlMaster=auto\' \'-o\' \'ControlPersist=120\' \'-o\' \'ControlPath=/tmp/git-tree-1000/%C\'');
		expect(getGitSshCommand('ssh', null)).toBe('\'ssh\' \'-o\' \'BatchMode=yes\' \'-o\' \'ConnectTimeout=10\' \'-o\' \'ForwardAgent=no\'');
	});
});

describe('classifySshFailure', () => {
	it('Should leave a call that connected to the caller', () => {
		expect(classifySshFailure(result({ code: 0 }), 'box')).toBeNull();
		expect(classifySshFailure(result({ code: 4, stderr: 'fatal: not a git repository' }), 'box')).toBeNull();
	});

	const unreachable = [
		'ssh: connect to host 10.0.0.1 port 22: Connection refused',
		'ssh: connect to host 10.0.0.1 port 22: Connection timed out',
		'ssh: Could not resolve hostname box: Name or service not known',
		'ssh: connect to host 10.0.0.1 port 22: No route to host',
		'kex_exchange_identification: read: Connection reset by peer\r\nConnection reset by 127.0.0.1 port 2222',
		'Connection closed by 127.0.0.1 port 2222'
	];
	unreachable.forEach((stderr) => {
		it('Should classify "' + stderr.split(/\r?\n/)[0] + '" as unreachable', () => {
			expect(classifySshFailure(result({ code: 255, stderr: stderr }), 'box')).toStrictEqual({ state: 'unreachable', message: 'Git Tree couldn\'t connect to "box". ' + getErrorLines(stderr) });
		});
	});

	const authentication = [
		'dev@127.0.0.1: Permission denied (publickey).',
		'dev@127.0.0.1: Permission denied (publickey,password).',
		'Host key verification failed.',
		'@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
		'Too many authentication failures',
		'Received disconnect from 10.0.0.1 port 22:2: Too many authentication failures'
	];
	authentication.forEach((stderr) => {
		it('Should classify "' + stderr.split(/\r?\n/)[stderr.includes('\n') ? 1 : 0].trim() + '" as needing authentication', () => {
			const failure = classifySshFailure(result({ code: 255, stderr: stderr }), 'box');
			expect(failure!.state).toBe('needsAuthentication');
			expect(failure!.message).toBe('SSH needs a password, a passphrase or a host key confirmation for "box". Connect once in a terminal (ssh box), or add a key. Git Tree waits up to 5 minutes between tries, because SSH servers block an address after repeated failed logins. ' + getErrorLines(stderr));
		});
	});

	it('Should classify a timeout as unreachable', () => {
		expect(classifySshFailure(result({ code: -1, timedOut: true }), 'box')).toStrictEqual({ state: 'unreachable', message: 'The connection to "box" timed out.' });
	});

	it('Should classify an ssh that can\'t run as unreachable, and say how to set it', () => {
		expect(classifySshFailure(result({ code: -1, error: new Error('spawn ssh ENOENT') }), 'box')).toStrictEqual({ state: 'unreachable', message: 'Git Tree couldn\'t run ssh (spawn ssh ENOENT). Set "git-tree.remoteHosts.sshPath" if it isn\'t on the PATH.' });
	});

	it('Should tell an authentication error in Git\'s fetch output', () => {
		expect(isAuthenticationError('dev@box: Permission denied (publickey).\r\nfatal: Could not read from remote repository.')).toBe(true);
		expect(isAuthenticationError('ssh: connect to host box port 22: Connection refused\nfatal: Could not read from remote repository.')).toBe(false);
	});
});

describe('getForwardingSshOptions', () => {
	it('Should forward the SSH agent on a connection of its own, and never prompt', () => {
		expect(getForwardingSshOptions()).toStrictEqual(['-A', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ControlMaster=no', '-o', 'ControlPath=none']);
	});
});

describe('runProcess', () => {
	const sh = process.platform !== 'win32' && fs.existsSync('/bin/sh') ? it : it.skip;

	sh('Should collect the output and the exit code, with the input on stdin', async () => {
		// Run
		const output = await runProcess('/bin/sh', ['-c', 'cat; echo err >&2; exit 3'], { input: 'in\n', timeout: 5000 });

		// Assert
		expect(output).toStrictEqual({ code: 3, stdout: Buffer.from('in\n'), stderr: 'err\n', error: null, timedOut: false });
	});

	sh('Should stop a process that runs past its time limit', async () => {
		// Run
		const output = await runProcess('/bin/sh', ['-c', 'sleep 5'], { timeout: 100 });

		// Assert
		expect(output.timedOut).toBe(true);
		expect(output.code).toBe(-1);
	});

	it('Should report a process that can\'t start', async () => {
		// Run
		const output = await runProcess('/no/such/executable', [], { timeout: 5000 });

		// Assert
		expect(output.code).toBe(-1);
		expect(output.error).not.toBeNull();
	});
});
