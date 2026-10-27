import { Document, LineCounter, Node, Pair, YAMLMap, isAlias, isMap, isScalar, parseDocument } from 'yaml';
import { RemoteHostEntry } from '../types';

/*
 * The remote hosts' configuration file, `.worktrees/git-tree.yaml` in the repository's main worktree. This file reads,
 * validates and edits its text; src/remoteHosts.ts reads and writes the file. The format is public (issue #1):
 *
 *   version: 1
 *   hosts:
 *     <name>:            # letters, digits, - and _
 *       ssh: <alias>     # a Host alias from ~/.ssh/config
 *       path: <path>     # the absolute path of the repository's main worktree on the server
 *       worktrees: true  # include the server's linked worktrees (optional, default true)
 *       forwardAgent: false  # forward the local SSH agent to the Git commands Git Tree runs on the server (optional, default false)
 *
 * Any other key or shape is an error that names its line, so a typo never silently drops a host.
 */

/** The path of the configuration file, relative to the main worktree. */
export const CONFIG_FILE = '.worktrees/git-tree.yaml';

/** The version of the file format that Git Tree reads. */
const CONFIG_VERSION = 1;

const HOST_KEYS = ['ssh', 'path', 'worktrees', 'forwardAgent'];
const HOST_NAME_REGEX = /^[A-Za-z0-9_-]+$/;
const SSH_ALIAS_REGEX = /^[A-Za-z0-9_][A-Za-z0-9._@-]*$/;
const CONTROL_CHARACTER_REGEX = /[\u0000-\u001f\u007f-\u009f]/;

/** One host's entry in the file. */
export interface RemoteHostConfig {
	readonly name: string;
	readonly ssh: string; // '' when the entry has no valid `ssh`
	readonly path: string; // '' when the entry has no valid `path`
	readonly worktrees: boolean; // Include the server's linked worktrees
	readonly forwardAgent: boolean; // The Git commands that leave the server (clone, fetch, pull, push) get the local SSH agent
	readonly error: string | null; // Why the entry is invalid, naming its line. NULL => it's valid.
}

/**
 * The file, as it was read:
 * - `hosts`: one entry per host, in the file's order. Each invalid entry has its own `error`.
 * - `error`: the file as a whole can't be used (it isn't YAML, or its top level is wrong), so it has no hosts.
 */
export type ParsedConfig = { readonly hosts: ReadonlyArray<RemoteHostConfig>, readonly error: null } | { readonly hosts: null, readonly error: string };

/**
 * Parse and validate the text of the configuration file.
 * @param text The file's contents.
 * @returns The hosts, or the error that stops the whole file from being used.
 */
export function parseConfig(text: string): ParsedConfig {
	const read = readDocument(text);
	if ('error' in read) return { hosts: null, error: read.error };

	const hosts: RemoteHostConfig[] = [], names: string[] = [];
	const items = read.hosts !== null ? read.hosts.items : [];
	for (let i = 0; i < items.length; i++) {
		const host = parseHost(items[i], read);
		const sameName = names.indexOf(host.name.toLowerCase());
		names.push(host.name.toLowerCase());
		hosts.push(host.error === null && sameName > -1
			? Object.assign({}, host, { error: read.at(items[i].key) + 'The host name "' + host.name + '" differs from "' + hosts[sameName].name + '" only in case. Host names must differ in more than case, because they name refs, which some file systems don\'t tell apart by case.' })
			: host);
	}
	return { hosts: hosts, error: null };
}

/**
 * Add a host to the configuration file's text, or replace one, keeping the other entries, the comments and the order.
 * An edited host keeps its place, and the comments inside its entry. `worktrees` is written only when it's false, and
 * `forwardAgent` only when it's true, since those are not their defaults.
 * @param text The file's contents. NULL => there's no file yet.
 * @param previousName NULL => add the host. Otherwise => replace the host with this name (which may differ from the new name).
 * @param host The host's entry.
 * @returns The new contents of the file, or why the host can't be written.
 */
export function setHostInConfig(text: string | null, previousName: string | null, host: RemoteHostEntry): { text: string } | { error: string } {
	const valueError = validateHostName(host.name) || validateSshAlias(host.ssh) || validateServerPath(host.path);
	if (valueError !== null) return { error: valueError };

	let doc: Document;
	if (text === null || text.trim() === '') {
		if (previousName !== null) return { error: 'The file has no host named "' + previousName + '".' };
		doc = new Document({ version: CONFIG_VERSION, hosts: {} });
	} else {
		const read = readDocument(text);
		if ('error' in read) return { error: 'Git Tree can\'t edit ' + CONFIG_FILE + ' until it\'s fixed. ' + read.error };
		doc = read.doc;
		if (read.hosts === null) doc.set('hosts', doc.createNode({}));
	}

	const hosts = <YAMLMap>doc.get('hosts', true);
	const getName = (item: Pair) => isScalar(item.key) ? String(item.key.value) : null;
	const index = previousName !== null ? hosts.items.findIndex((item) => getName(item) === previousName) : -1;
	if (previousName !== null && index === -1) return { error: 'The file has no host named "' + previousName + '".' };
	const clash = hosts.items.find((item, i) => i !== index && getName(item) !== null && getName(item)!.toLowerCase() === host.name.toLowerCase());
	if (typeof clash !== 'undefined') return { error: 'The file already has a host named "' + getName(clash) + '".' };

	if (index === -1) {
		hosts.flow = false;
		hosts.set(host.name, doc.createNode(getEntryValues(host)));
	} else {
		const item = hosts.items[index];
		if (isScalar(item.key)) {
			item.key.value = host.name;
		} else {
			item.key = doc.createNode(host.name);
		}
		if (isMap(item.value)) {
			// In place, so the comments inside the entry stay
			const entry = item.value;
			entry.set('ssh', host.ssh);
			entry.set('path', host.path);
			if (host.worktrees) {
				entry.delete('worktrees');
			} else {
				entry.set('worktrees', false);
			}
			if (host.forwardAgent) {
				entry.set('forwardAgent', true);
			} else {
				entry.delete('forwardAgent');
			}
		} else {
			// Not a mapping of its own (such as an alias of another node), so it gets a new one
			item.value = doc.createNode(getEntryValues(host));
		}
	}
	const newText = doc.toString();

	// Check the result with the same rules that read it, so the file Git Tree writes is always one it can read, holds the
	// host as asked, and means the same as before for every other host
	const before = text !== null && text.trim() !== '' ? parseConfig(text).hosts : [];
	const after = parseConfig(newText).hosts;
	const written = after !== null ? after.find((config) => config.name === host.name) : undefined;
	const others = (hostList: ReadonlyArray<RemoteHostConfig>) => JSON.stringify(hostList.filter((config) => config.name !== host.name && config.name !== previousName));
	if (before === null || after === null || typeof written === 'undefined' || written.error !== null || written.ssh !== host.ssh || written.path !== host.path
		|| written.worktrees !== host.worktrees || written.forwardAgent !== host.forwardAgent || others(before) !== others(after)) {
		return { error: 'Git Tree couldn\'t write the host to ' + CONFIG_FILE + ' without changing what the file means. Edit it by hand.' };
	}
	return { text: newText };
}

/**
 * Get the values of a host's new entry in the file: `worktrees` only when it's false, and `forwardAgent` only when it's true.
 * @param host The host's entry.
 */
function getEntryValues(host: RemoteHostEntry) {
	const values: { [key: string]: string | boolean } = { ssh: host.ssh, path: host.path };
	if (!host.worktrees) values.worktrees = false;
	if (host.forwardAgent) values.forwardAgent = true;
	return values;
}

/**
 * Remove a host from the configuration file's text, keeping its other entries and comments.
 * @param text The file's contents.
 * @param name The host's name.
 * @returns The new contents of the file, or why the host can't be removed.
 */
export function removeHostFromConfig(text: string, name: string): { text: string } | { error: string } {
	const read = readDocument(text);
	if ('error' in read) return { error: 'Git Tree can\'t edit ' + CONFIG_FILE + ' until it\'s fixed. ' + read.error };

	const index = read.hosts !== null ? read.hosts.items.findIndex((item) => isScalar(item.key) && String(item.key.value) === name) : -1;
	if (index === -1) return { error: 'The file has no host named "' + name + '".' };

	read.hosts!.items.splice(index, 1);
	return { text: read.doc.toString() };
}

/**
 * Check a host's name: letters, digits, `-` and `_`.
 * @param name The name.
 * @returns The error, or NULL if it's valid.
 */
export function validateHostName(name: string) {
	return HOST_NAME_REGEX.test(name) ? null : 'The host name "' + name + '" may only hold letters, digits, - and _.';
}

/**
 * Check an SSH alias. It must be one argument that `ssh` can't read as an option, and that Git can't read as a path or
 * a port: letters, digits, `.`, `_`, `@` and `-`, not starting with `-` or `.`.
 * @param alias The alias.
 * @returns The error, or NULL if it's valid.
 */
export function validateSshAlias(alias: string) {
	return SSH_ALIAS_REGEX.test(alias) ? null : 'The SSH alias "' + alias + '" must be a Host alias from ~/.ssh/config: letters, digits, ., _, @ and -, not starting with - or a dot.';
}

/**
 * Check a path on a server: it must be absolute, and hold no control character, so its quoted form can't be cut short.
 * @param path The path.
 * @returns The error, or NULL if it's valid.
 */
export function validateServerPath(path: string) {
	if (CONTROL_CHARACTER_REGEX.test(path)) return 'The path "' + path.replace(CONTROL_CHARACTER_REGEX, '?') + '" holds a control character.';
	if (!path.startsWith('/')) return 'The path "' + path + '" must be absolute (start with /).';
	return null;
}


/* Reading the document */

/** The parsed file, with what reading its nodes needs. */
interface ReadDocument {
	readonly doc: Document;
	readonly hosts: YAMLMap | null; // NULL => `hosts:` is empty
	readonly at: (node: unknown) => string; // `Line <n>: ` for a node, or '' if it has no position
	readonly resolve: (node: unknown) => unknown; // The node an alias points at, or the node itself
}

/**
 * Parse the file's text, and check its top level: a mapping with `version: 1` and `hosts`.
 * @param text The file's contents.
 * @returns The document, or the error that stops the whole file from being used.
 */
function readDocument(text: string): ReadDocument | { error: string } {
	const lineCounter = new LineCounter();
	const doc = parseDocument(text, { lineCounter: lineCounter, prettyErrors: false, uniqueKeys: true });
	const problems = doc.errors.concat(doc.warnings);
	if (problems.length > 0) {
		const problem = problems[0];
		const message = problem.code === 'DUPLICATE_KEY' ? 'A key appears twice in the same mapping.'
			: problem.code === 'MULTIPLE_DOCS' ? 'The file holds more than one YAML document.'
				: problem.message.split('\n')[0];
		return { error: 'Line ' + lineCounter.linePos(problem.pos[0]).line + ': ' + message };
	}

	const at = (node: unknown) => {
		const range = node !== null && typeof node === 'object' ? (<Node>node).range : undefined;
		return Array.isArray(range) ? 'Line ' + lineCounter.linePos(range[0]).line + ': ' : '';
	};
	const resolve = (node: unknown) => isAlias(node) ? node.resolve(doc) : node;

	const contents = resolve(doc.contents);
	if (contents === null || typeof contents === 'undefined' || (isScalar(contents) && contents.value === null)) {
		return { error: 'The file is empty. It needs "version: 1" and "hosts:".' };
	}
	if (!isMap(contents)) return { error: at(contents) + 'The file must be a mapping with "version" and "hosts".' };

	let version: Pair | null = null, hosts: Pair | null = null;
	for (let i = 0; i < contents.items.length; i++) {
		const key = contents.items[i].key, keyName = isScalar(key) ? String(key.value) : null;
		if (keyName === 'version') {
			version = contents.items[i];
		} else if (keyName === 'hosts') {
			hosts = contents.items[i];
		} else {
			return { error: at(key) + 'Unknown key "' + (keyName !== null ? keyName : '?') + '". The file may only hold "version" and "hosts".' };
		}
	}

	if (version === null) return { error: 'The file has no "version". Add "version: 1".' };
	const versionValue = resolve(version.value);
	if (!isScalar(versionValue) || versionValue.value !== CONFIG_VERSION) {
		return { error: at(versionValue !== null ? versionValue : version.key) + '"version" must be 1, the only version of the file this Git Tree reads.' };
	}

	if (hosts === null) return { error: 'The file has no "hosts".' };
	const hostsValue = resolve(hosts.value);
	if (hostsValue === null || (isScalar(hostsValue) && hostsValue.value === null)) {
		return { doc: doc, hosts: null, at: at, resolve: resolve };
	}
	if (!isMap(hostsValue)) return { error: at(hostsValue) + '"hosts" must be a mapping of host names to their entries.' };
	return { doc: doc, hosts: hostsValue, at: at, resolve: resolve };
}

/**
 * Parse and validate one host's entry.
 * @param item The entry's pair in `hosts`.
 * @param read The parsed file.
 * @returns The host. Its `error` is the entry's first error.
 */
function parseHost(item: Pair, read: ReadDocument): RemoteHostConfig {
	const key = item.key;
	const name = isScalar(key) ? (typeof key.value === 'string' ? key.value : String(typeof key.source === 'string' ? key.source : key.value)) : '?';
	let ssh = '', path = '', worktrees = true, forwardAgent = false;
	const invalid = (node: unknown, message: string): RemoteHostConfig => ({ name: name, ssh: ssh, path: path, worktrees: worktrees, forwardAgent: forwardAgent, error: read.at(node) + message });

	const nameError = validateHostName(name);
	if (nameError !== null) return invalid(key, nameError);

	const value = read.resolve(item.value);
	if (!isMap(value)) return invalid(value !== null ? value : key, 'The host "' + name + '" must be a mapping with "ssh" and "path".');

	let hasSsh = false, hasPath = false;
	for (let i = 0; i < value.items.length; i++) {
		const field = value.items[i], fieldName = isScalar(field.key) ? String(field.key.value) : null;
		if (fieldName === null || HOST_KEYS.indexOf(fieldName) === -1) {
			return invalid(field.key, 'Unknown key "' + (fieldName !== null ? fieldName : '?') + '" in the host "' + name + '". A host may only hold "ssh", "path", "worktrees" and "forwardAgent".');
		}

		const fieldValue = read.resolve(field.value), node = fieldValue !== null ? fieldValue : field.key;
		const scalar = isScalar(fieldValue) ? fieldValue.value : undefined;
		if (fieldName === 'worktrees' || fieldName === 'forwardAgent') {
			if (typeof scalar !== 'boolean') return invalid(node, '"' + fieldName + '" must be true or false.');
			if (fieldName === 'worktrees') {
				worktrees = scalar;
			} else {
				forwardAgent = scalar;
			}
		} else if (typeof scalar !== 'string') {
			return invalid(node, '"' + fieldName + '" must be a string.');
		} else if (fieldName === 'ssh') {
			const error = validateSshAlias(scalar);
			if (error !== null) return invalid(node, error);
			ssh = scalar;
			hasSsh = true;
		} else {
			const error = validateServerPath(scalar);
			if (error !== null) return invalid(node, error);
			path = scalar;
			hasPath = true;
		}
	}

	if (!hasSsh) return invalid(key, 'The host "' + name + '" has no "ssh", the Host alias from ~/.ssh/config.');
	if (!hasPath) return invalid(key, 'The host "' + name + '" has no "path", the absolute path of the repository on the server.');
	return { name: name, ssh: ssh, path: path, worktrees: worktrees, forwardAgent: forwardAgent, error: null };
}
