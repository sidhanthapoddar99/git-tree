import * as fs from 'fs';
import * as path from 'path';
import { SshAlias } from '../types';

/*
 * The Host aliases of the user's SSH configuration, to offer when a remote host is added. It reads ~/.ssh/config and
 * the files its `Include` lines name, as ssh_config(5) does: `~` is the home folder, a relative path is in ~/.ssh,
 * globs are expanded in lexical order, and includes nest up to 16 deep. The files are only ever read.
 */

/** How deep `Include` lines nest, as in OpenSSH (READCONF_MAX_DEPTH). */
const MAX_INCLUDE_DEPTH = 16;

/** One line of an SSH configuration file that matters here. */
export type SshConfigLine =
	{ readonly kind: 'host', readonly patterns: ReadonlyArray<string> } // `Host`: a new block, for these patterns
	| { readonly kind: 'match' } // `Match`: a new block, for no alias
	| { readonly kind: 'include', readonly paths: ReadonlyArray<string> }
	| { readonly kind: 'hostName', readonly value: string }
	| { readonly kind: 'user', readonly value: string };

/**
 * Parse the text of an SSH configuration file into the lines that matter for its aliases: `Host`, `Match`, `Include`,
 * `HostName` and `User`. A keyword is separated from its arguments by spaces or one `=`, keywords ignore case,
 * arguments may be in double quotes, and a `#` that starts an argument starts a comment.
 * @param text The file's contents.
 * @returns The lines, in the file's order.
 */
export function parseSshConfig(text: string): SshConfigLine[] {
	const lines: SshConfigLine[] = [];
	text.split(/\r\n|\r|\n/g).forEach((line) => {
		const match = line.match(/^\s*([A-Za-z]+)(?:\s*=\s*|\s+)(.*)$/);
		if (match === null) return;
		const keyword = match[1].toLowerCase(), args = splitArguments(match[2]);
		if (keyword === 'host') {
			lines.push({ kind: 'host', patterns: args });
		} else if (keyword === 'match') {
			lines.push({ kind: 'match' });
		} else if (keyword === 'include') {
			lines.push({ kind: 'include', paths: args });
		} else if ((keyword === 'hostname' || keyword === 'user') && args.length > 0) {
			lines.push({ kind: keyword === 'hostname' ? 'hostName' : 'user', value: args[0] });
		}
	});
	return lines;
}

/**
 * Read the Host aliases of an SSH configuration and the files it includes. Each literal alias (without `*`, `?` or
 * `!`) is listed once, where it first appears, with the first `HostName` and `User` of the blocks that name it.
 * A file that can't be read, and a glob that matches nothing, add nothing, as for `ssh`.
 * @param rootFile The configuration file, normally ~/.ssh/config.
 * @param home The home folder, for `~` and for relative paths (which are in `<home>/.ssh`).
 * @returns The aliases, in the order `ssh` reads them.
 */
export async function readSshAliases(rootFile: string, home: string): Promise<SshAlias[]> {
	const aliases: { alias: string, hostName: string | null, user: string | null }[] = [];
	const sshDir = path.join(home, '.ssh');

	// An included file starts in the block of its Include line, and that block goes on after it, as in OpenSSH
	const readFile = async (file: string, depth: number, enclosingBlock: typeof aliases) => {
		const text = await new Promise<string | null>((resolve) => fs.readFile(file, 'utf8', (error, contents) => resolve(error === null ? contents : null)));
		if (text === null) return;
		let block = enclosingBlock; // The aliases the current block is for
		for (const line of parseSshConfig(text)) {
			if (line.kind === 'host') {
				block = [];
				line.patterns.filter((pattern) => !/[*?!]/.test(pattern)).forEach((pattern) => {
					let alias = aliases.find((existing) => existing.alias === pattern);
					if (typeof alias === 'undefined') {
						alias = { alias: pattern, hostName: null, user: null };
						aliases.push(alias);
					}
					block.push(alias);
				});
			} else if (line.kind === 'match') {
				block = [];
			} else if (line.kind === 'include') {
				if (depth >= MAX_INCLUDE_DEPTH) continue;
				for (const includePath of line.paths) {
					for (const included of await expandGlob(resolveIncludePath(includePath, home, sshDir))) {
						await readFile(included, depth + 1, block);
					}
				}
			} else {
				const key = line.kind;
				block.forEach((alias) => {
					if (alias[key] === null) alias[key] = line.value;
				});
			}
		}
	};

	await readFile(rootFile, 0, []);
	return aliases;
}

/**
 * Split the arguments of a configuration line, as `ssh` does: at spaces, with double quotes around an argument that
 * holds spaces, and a comment from a `#` that starts an argument.
 * @param text The line after its keyword.
 * @returns The arguments.
 */
function splitArguments(text: string) {
	const args: string[] = [];
	const regex = /"([^"]*)"|(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(text)) !== null) {
		if (typeof match[2] === 'string' && match[2].startsWith('#')) break;
		args.push(typeof match[1] === 'string' ? match[1] : match[2]);
	}
	return args;
}

/**
 * Resolve an `Include` path: `~` and `~/` are the home folder, and a relative path is in ~/.ssh.
 * @param includePath The path as written.
 * @param home The home folder.
 * @param sshDir The folder of relative paths.
 * @returns The absolute path, which may hold glob characters.
 */
function resolveIncludePath(includePath: string, home: string, sshDir: string) {
	if (includePath === '~') return home;
	if (includePath.startsWith('~/')) return path.join(home, includePath.substring(2));
	return path.isAbsolute(includePath) ? includePath : path.join(sshDir, includePath);
}

/**
 * Expand the glob characters (`*`, `?` and `[...]`) of an absolute path, as glob(3) does: each part of the path is
 * matched against its folder's entries, a leading `.` is matched only by a `.` in the pattern, and the matches are in
 * lexical order.
 * @param pattern The absolute path.
 * @returns The files that exist and match. A path without glob characters is returned as it is.
 */
async function expandGlob(pattern: string): Promise<string[]> {
	if (!/[*?[]/.test(pattern)) return [pattern];
	const root = path.parse(pattern).root;
	const parts = pattern.substring(root.length).split(/[\\/]+/).filter((part) => part !== '');
	let matches = [root];
	for (const part of parts) {
		const next: string[] = [];
		if (!/[*?[]/.test(part)) {
			matches.forEach((match) => next.push(path.join(match, part)));
		} else {
			const regex = globToRegExp(part);
			for (const folder of matches) {
				const names = await new Promise<string[]>((resolve) => fs.readdir(folder, (error, entries) => resolve(error === null ? entries : [])));
				names.filter((name) => regex.test(name) && (!name.startsWith('.') || part.startsWith('.'))).sort().forEach((name) => next.push(path.join(folder, name)));
			}
		}
		matches = next;
	}
	return matches;
}

/**
 * Convert one part of a glob pattern into a regular expression: `*` is any characters, `?` one character, and `[...]`
 * (or `[!...]`) a set of characters.
 * @param part The pattern, without `/`.
 * @returns The regular expression, for the whole name.
 */
function globToRegExp(part: string) {
	let source = '';
	for (let i = 0; i < part.length; i++) {
		const char = part[i];
		// A set's first character (after a `!`) may be `]`, which is then part of it
		let setStart = i + 1;
		if (part[setStart] === '!') setStart++;
		const close = char === '[' ? part.indexOf(']', setStart + 1) : -1;
		if (char === '*') {
			source += '.*';
		} else if (char === '?') {
			source += '.';
		} else if (close > -1) {
			const set = part.substring(i + 1, close);
			source += '[' + (set.startsWith('!') ? '^' + escapeSet(set.substring(1)) : escapeSet(set)) + ']';
			i = close;
		} else {
			source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		}
	}
	return new RegExp('^' + source + '$');
}

/**
 * Escape the characters of a glob's set that mean something else in a regular expression's set, keeping ranges (`a-z`).
 * @param set The set, without its brackets.
 */
function escapeSet(set: string) {
	return set.replace(/[\\\]^]/g, '\\$&');
}
