import * as cp from 'child_process';
import { GitRemoteHostState } from '../types';

/*
 * Running `ssh` and Git for the remote hosts: the options of the shared connection, quoting for the server's shell,
 * a process runner with a time limit, and how a failed `ssh` becomes a host state.
 */

/** How long `ssh` may take to connect, in seconds. */
const CONNECT_TIMEOUT = 10;

/** How long the shared connection stays open after its last use, in seconds. */
const CONTROL_PERSIST = 120;

/**
 * Quote a value for a POSIX shell: in single quotes, with each `'` written as `'\''`. This reads the same in sh, bash,
 * zsh, fish and csh, the login shells `ssh` might start on a server.
 * @param value The value.
 * @returns The quoted value.
 */
export function quotePosix(value: string) {
	return '\'' + value.replace(/'/g, '\'\\\'\'') + '\'';
}

/**
 * Get the options Git Tree gives `ssh`. A call that isn't the terminal never forwards the SSH agent, even when the SSH
 * configuration says to: only the Git commands of a host with `forwardAgent` do, on their own connection (see
 * `getForwardingSshOptions`).
 * @param controlDir The folder of the shared connections' sockets. NULL => no connection sharing (Windows, or no safe folder).
 * @param batch Fail instead of asking for a password, a passphrase or a host key confirmation (every call but the terminal's).
 * @returns The options, as arguments.
 */
export function getSshOptions(controlDir: string | null, batch: boolean) {
	const options: string[] = [];
	if (batch) options.push('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=' + CONNECT_TIMEOUT, '-o', 'ForwardAgent=no');
	if (controlDir !== null) options.push('-o', 'ControlMaster=auto', '-o', 'ControlPersist=' + CONTROL_PERSIST, '-o', 'ControlPath=' + controlDir + '/%C');
	return options;
}

/**
 * Get the options of a call that forwards the local SSH agent (`ssh -A`), for a Git command on a server that connects
 * elsewhere as the user (a clone, fetch, pull or push). It has its own connection, which neither uses nor opens a
 * shared one, so the agent is forwarded only while that command runs.
 * @returns The options, as arguments.
 */
export function getForwardingSshOptions() {
	return ['-A', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=' + CONNECT_TIMEOUT, '-o', 'ControlMaster=no', '-o', 'ControlPath=none'];
}

/**
 * Get the command Git runs for SSH (`GIT_SSH_COMMAND`), which Git runs through a shell, so each word is quoted.
 * @param sshPath The `ssh` executable.
 * @param controlDir The folder of the shared connections' sockets, or NULL.
 * @returns The command.
 */
export function getGitSshCommand(sshPath: string, controlDir: string | null) {
	return [sshPath].concat(getSshOptions(controlDir, true)).map(quotePosix).join(' ');
}

/** What a host's failed `ssh` call means. */
export interface SshFailure {
	readonly state: GitRemoteHostState;
	readonly message: string;
}

const AUTHENTICATION_ERROR_REGEX = /permission denied|host key verification failed|passphrase|password|authentication failed|too many authentication failures|no more authentication methods|remote host identification has changed|host key for .* has changed|no matching host key/i;

/**
 * Classify a failed `ssh` call. `ssh` exits with 255 for its own errors; its message tells a refused key apart from a
 * server it can't reach.
 * @param result The call's result.
 * @param alias The host's SSH alias, for the message.
 * @returns The state, with its message. NULL => `ssh` connected, and the command on the server failed.
 */
export function classifySshFailure(result: ProcessResult, alias: string): SshFailure | null {
	if (result.timedOut) {
		return { state: 'unreachable', message: 'The connection to "' + alias + '" timed out.' };
	}
	if (result.error !== null) {
		return { state: 'unreachable', message: 'Git Tree couldn\'t run ssh (' + result.error.message + '). Set "git-tree.remoteHosts.sshPath" if it isn\'t on the PATH.' };
	}
	if (result.code !== 255) return null;

	const message = getErrorLines(result.stderr);
	if (isAuthenticationError(result.stderr)) {
		return { state: 'needsAuthentication', message: 'SSH needs a password, a passphrase or a host key confirmation for "' + alias + '". Connect once in a terminal (ssh ' + alias + '), or add a key. Git Tree waits up to 5 minutes between tries, because SSH servers block an address after repeated failed logins. ' + message };
	}
	return { state: 'unreachable', message: 'Git Tree couldn\'t connect to "' + alias + '". ' + message };
}

/**
 * Check whether an error from `ssh` (or from Git running it) says that SSH needs a password, a passphrase or a host key
 * confirmation, as opposed to a server it can't reach.
 * @param stderr The error output.
 */
export function isAuthenticationError(stderr: string) {
	return AUTHENTICATION_ERROR_REGEX.test(stderr);
}

/**
 * Get the lines of a command's error output, without the empty ones, as one message.
 * @param stderr The error output.
 * @returns The message.
 */
export function getErrorLines(stderr: string) {
	return stderr.split(/\r\n|\r|\n/g).map((line) => line.trim()).filter((line) => line !== '').join(' ');
}


/* Running processes */

/** The result of a process. */
export interface ProcessResult {
	readonly code: number; // -1 => it didn't exit normally (it couldn't start, was killed, or timed out)
	readonly stdout: Buffer;
	readonly stderr: string;
	readonly error: Error | null; // Why it couldn't start
	readonly timedOut: boolean;
}

export interface ProcessOptions {
	readonly cwd?: string;
	readonly env?: { [key: string]: string | undefined };
	readonly input?: string; // Written to its stdin, which is then closed
	readonly timeout: number; // Milliseconds. The process is killed after it.
}

/**
 * Run a process, and collect its output. It never rejects.
 * @param file The executable.
 * @param args The arguments, each passed as one argument (no shell).
 * @param options The options.
 * @returns The result.
 */
export function runProcess(file: string, args: ReadonlyArray<string>, options: ProcessOptions): Promise<ProcessResult> {
	return new Promise<ProcessResult>((resolve) => {
		const stdout: Buffer[] = [];
		let stderr = '', timedOut = false, settled = false, timer: NodeJS.Timeout | null = null, grace: NodeJS.Timeout | null = null;
		const finish = (code: number, error: Error | null) => {
			if (settled) return;
			settled = true;
			if (timer !== null) clearTimeout(timer);
			if (grace !== null) clearTimeout(grace);
			resolve({ code: timedOut ? -1 : code, stdout: Buffer.concat(stdout), stderr: stderr, error: error, timedOut: timedOut });
		};

		let child: cp.ChildProcess;
		try {
			child = cp.spawn(file, args.slice(), { cwd: options.cwd, env: options.env, windowsHide: true });
		} catch (error) {
			finish(-1, error instanceof Error ? error : new Error(String(error)));
			return;
		}

		child.on('error', (error) => finish(-1, error));
		child.on('close', (code) => finish(code !== null ? code : -1, null));
		if (child.stdout) child.stdout.on('data', (data: Buffer) => stdout.push(data));
		if (child.stderr) child.stderr.on('data', (data: Buffer | string) => { stderr += data.toString(); });
		if (child.stdin) {
			child.stdin.on('error', () => { }); // The process may exit before it reads its input
			child.stdin.end(typeof options.input === 'string' ? options.input : undefined);
		}

		timer = setTimeout(() => {
			timedOut = true;
			child.kill();
			// A process that ignores the signal, or a child that keeps its output open, mustn't hold the refresh
			grace = setTimeout(() => {
				if (child.stdout) child.stdout.destroy();
				if (child.stderr) child.stderr.destroy();
				finish(-1, null);
			}, 1000);
		}, options.timeout);
	});
}
