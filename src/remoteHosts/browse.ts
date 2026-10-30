import { RemoteFolderEntry } from '../types';
import { validateServerPath } from './config';

/*
 * The folder browser of the Remote Hosts panel: one script that `ssh <alias> sh -s -- <path>` runs on the server, and the
 * parser of what it prints. Only a POSIX shell runs there, and the script only reads. The path is the one argument,
 * which the caller checks and quotes.
 */

/** The most folders one listing holds, so a huge folder can't flood the view. */
export const BROWSE_LIMIT = 2000;

/**
 * The browse script. Its one argument is the folder to list, or empty for the home folder. It prints NUL-terminated
 * records: `gt:browse`, the folder's physical path (`pwd -P`), its parent's, one record per folder in it (`r <name>`
 * for a repository's main worktree, which has a `.git` folder, `w <name>` for a linked worktree or a submodule, which
 * has a `.git` file, and `f <name>` for any other folder), `gt:more` if it stopped at BROWSE_LIMIT with folders left,
 * and `gt:end`. Hidden folders are listed too.
 */
export const BROWSE_SCRIPT = [
	'if [ -n "$1" ]; then cd "$1" 2>/dev/null || { echo gt:nopath; exit 3; }; else cd 2>/dev/null || { echo gt:nopath; exit 3; }; fi',
	'here=$(pwd -P) || exit 6',
	'parent=$(dirname "$here") || exit 6', // Not `cd ..`, which goes up the path that was entered, through any symbolic link
	'printf \'gt:browse\\0%s\\0%s\\0\' "$here" "$parent"',
	'n=0',
	'for f in .[!.]* ..?* *; do',
	'  [ -d "$f" ] || continue',
	'  [ "$n" -lt ' + BROWSE_LIMIT + ' ] || { printf \'gt:more\\0\'; break; }',
	'  if [ -d "$f/.git" ]; then k=r; elif [ -f "$f/.git" ]; then k=w; else k=f; fi',
	'  printf \'%s %s\\0\' "$k" "$f"',
	'  n=$((n + 1))',
	'done',
	'printf \'gt:end\\0\'',
	''
].join('\n');

/**
 * What the browse script printed:
 * - `ok`: the folder's physical path, its parent's (NULL => it's the root), its folders, sorted by name, and whether the
 *   script stopped at BROWSE_LIMIT with folders left.
 * - `noPath`: the folder doesn't exist, or the script can't enter it.
 * - `unreadable`: the output isn't what the script prints (it was cut short, or something else printed it).
 */
export type BrowseOutput =
	{ readonly kind: 'ok', readonly path: string, readonly parent: string | null, readonly entries: ReadonlyArray<RemoteFolderEntry>, readonly truncated: boolean }
	| { readonly kind: 'noPath' }
	| { readonly kind: 'unreadable' };

const KINDS: { [letter: string]: RemoteFolderEntry['kind'] } = { r: 'repository', w: 'worktree', f: 'folder' };

/**
 * Parse the output of the browse script. Output before its first record is ignored, since a login shell's startup
 * files may print something. A folder whose name holds a control character is left out, because a host's path can't
 * hold one.
 * @param stdout The output.
 * @returns What it printed.
 */
export function parseBrowseOutput(stdout: string): BrowseOutput {
	const start = stdout.indexOf('gt:browse\0');
	if (start === -1) return /(^|\n)gt:nopath\n/.test(stdout) ? { kind: 'noPath' } : { kind: 'unreadable' };

	const records = stdout.substring(start).split('\0');
	// The last record is the empty text after the final NUL
	if (records.length < 5 || records[records.length - 2] !== 'gt:end' || records[records.length - 1] !== '') return { kind: 'unreadable' };
	const folder = records[1], parent = records[2];
	if (validateServerPath(folder) !== null || validateServerPath(parent) !== null) return { kind: 'unreadable' };

	// A folder's record starts with its kind letter, so no folder name reads as `gt:more`
	const truncated = records[records.length - 3] === 'gt:more', last = records.length - (truncated ? 3 : 2);
	const entries: RemoteFolderEntry[] = [], names = new Set<string>();
	for (let i = 3; i < last; i++) {
		const kind = KINDS[records[i].substring(0, 1)], name = records[i].substring(2);
		if (typeof kind === 'undefined' || records[i].substring(1, 2) !== ' ' || name === '' || name.indexOf('/') > -1) return { kind: 'unreadable' };
		if (validateServerPath('/' + name) !== null || names.has(name)) continue;
		names.add(name);
		entries.push({ name: name, kind: kind });
	}
	entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
	return { kind: 'ok', path: folder, parent: parent !== folder ? parent : null, entries: entries, truncated: truncated };
}
