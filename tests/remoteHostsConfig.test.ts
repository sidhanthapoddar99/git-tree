import { CONFIG_FILE, parseConfig, removeHostFromConfig, setHostInConfig, validateHostName, validateServerPath, validateSshAlias } from '../src/remoteHosts/config';
import { RemoteHostEntry } from '../src/types';

const VALID = [
	'version: 1',
	'hosts:',
	'  build-box:                          # the name shown in the graph',
	'    ssh: build-box                    # a Host alias from ~/.ssh/config',
	'    path: /home/ubuntu/projects/app   # the repository\'s main worktree on the server',
	'    worktrees: true                   # include its linked worktrees (default: true)',
	'  gpu:',
	'    ssh: gpu-01',
	'    path: /srv/work/app',
	'    worktrees: false                  # only the main worktree',
	''
].join('\n');

function config(...hostLines: string[]) {
	return ['version: 1', 'hosts:'].concat(hostLines).join('\n') + '\n';
}

describe('parseConfig', () => {
	it('Should parse the example from the issue', () => {
		// Run
		const result = parseConfig(VALID);

		// Assert
		expect(result).toStrictEqual({
			hosts: [
				{ name: 'build-box', ssh: 'build-box', path: '/home/ubuntu/projects/app', worktrees: true, forwardAgent: false, error: null },
				{ name: 'gpu', ssh: 'gpu-01', path: '/srv/work/app', worktrees: false, forwardAgent: false, error: null }
			],
			error: null
		});
	});

	it('Should default "worktrees" to true', () => {
		// Run
		const result = parseConfig(config('  a:', '    ssh: a', '    path: /a'));

		// Assert
		expect(result.hosts).toStrictEqual([{ name: 'a', ssh: 'a', path: '/a', worktrees: true, forwardAgent: false, error: null }]);
	});

	it('Should read "forwardAgent", which defaults to false', () => {
		// Run
		const result = parseConfig(config('  a:', '    ssh: a', '    path: /a', '    forwardAgent: true', '  b:', '    ssh: b', '    path: /b', '    forwardAgent: false'));

		// Assert
		expect(result.hosts).toStrictEqual([
			{ name: 'a', ssh: 'a', path: '/a', worktrees: true, forwardAgent: true, error: null },
			{ name: 'b', ssh: 'b', path: '/b', worktrees: true, forwardAgent: false, error: null }
		]);
	});

	it('Should parse flow mappings, quoted strings, and aliases', () => {
		// Run
		const result = parseConfig(config('  a: &host { ssh: "a.example", path: \'/srv/it\'\'s app\' }', '  b: *host'));

		// Assert
		expect(result.hosts).toStrictEqual([
			{ name: 'a', ssh: 'a.example', path: '/srv/it\'s app', worktrees: true, forwardAgent: false, error: null },
			{ name: 'b', ssh: 'a.example', path: '/srv/it\'s app', worktrees: true, forwardAgent: false, error: null }
		]);
	});

	it('Should accept an empty "hosts"', () => {
		// Assert
		expect(parseConfig('version: 1\nhosts:\n')).toStrictEqual({ hosts: [], error: null });
		expect(parseConfig('version: 1\nhosts: {}\n')).toStrictEqual({ hosts: [], error: null });
	});

	describe('Errors that stop the whole file', () => {
		const cases: [string, string, string][] = [
			['an empty file', '', 'The file is empty. It needs "version: 1" and "hosts:".'],
			['a file of comments', '# nothing yet\n', 'The file is empty. It needs "version: 1" and "hosts:".'],
			['invalid YAML', 'version: 1\nhosts:\n  a: [\n', 'Line 4: '],
			['a duplicate key', config('  a: { ssh: a, path: /a }', '  a: { ssh: b, path: /b }'), 'Line 4: A key appears twice in the same mapping.'],
			['two documents', 'version: 1\n---\nversion: 1\n', 'Line 2: The file holds more than one YAML document.'],
			['an unknown tag', 'version: 1\nhosts: !!foo bar\n', 'Line 2: Unresolved tag: tag:yaml.org,2002:foo'],
			['a top level that isn\'t a mapping', '- a\n- b\n', 'Line 1: The file must be a mapping with "version" and "hosts".'],
			['an unknown top-level key', 'version: 1\nhosts:\nhost:\n', 'Line 3: Unknown key "host". The file may only hold "version" and "hosts".'],
			['no version', 'hosts:\n', 'The file has no "version". Add "version: 1".'],
			['version 2', 'version: 2\nhosts:\n', 'Line 1: "version" must be 1, the only version of the file this Git Tree reads.'],
			['version as a string', 'version: "1"\nhosts:\n', 'Line 1: "version" must be 1, the only version of the file this Git Tree reads.'],
			['no hosts', 'version: 1\n', 'The file has no "hosts".'],
			['hosts as a list', 'version: 1\nhosts:\n  - a\n', 'Line 3: "hosts" must be a mapping of host names to their entries.']
		];
		cases.forEach(([name, text, error]) => {
			it('Should reject ' + name, () => {
				// Run
				const result = parseConfig(text);

				// Assert
				expect(result.hosts).toBeNull();
				expect(result.error!.startsWith(error)).toBe(true);
			});
		});
	});

	describe('Errors in one host, which only that host gets', () => {
		const cases: [string, string[], string][] = [
			['a name with a space', ['  "build box":', '    ssh: a', '    path: /a'], 'Line 3: The host name "build box" may only hold letters, digits, - and _.'],
			['a name with a slash', ['  a/b:', '    ssh: a', '    path: /a'], 'Line 3: The host name "a/b" may only hold letters, digits, - and _.'],
			['a name with a dot', ['  a.b:', '    ssh: a', '    path: /a'], 'Line 3: The host name "a.b" may only hold letters, digits, - and _.'],
			['an entry that isn\'t a mapping', ['  a: build-box'], 'Line 3: The host "a" must be a mapping with "ssh" and "path".'],
			['an empty entry', ['  a:'], 'Line 3: The host "a" must be a mapping with "ssh" and "path".'],
			['an unknown key', ['  a:', '    ssh: a', '    path: /a', '    user: me'], 'Line 6: Unknown key "user" in the host "a". A host may only hold "ssh", "path", "worktrees" and "forwardAgent".'],
			['a misspelt key', ['  a:', '    ssh: a', '    paht: /a'], 'Line 5: Unknown key "paht" in the host "a". A host may only hold "ssh", "path", "worktrees" and "forwardAgent".'],
			['no ssh', ['  a:', '    path: /a'], 'Line 3: The host "a" has no "ssh", the Host alias from ~/.ssh/config.'],
			['no path', ['  a:', '    ssh: a'], 'Line 3: The host "a" has no "path", the absolute path of the repository on the server.'],
			['an ssh that isn\'t a string', ['  a:', '    ssh: 22', '    path: /a'], 'Line 4: "ssh" must be a string.'],
			['an ssh that is a list', ['  a:', '    ssh: [a, b]', '    path: /a'], 'Line 4: "ssh" must be a string.'],
			['an ssh with a space', ['  a:', '    ssh: a -oProxyCommand=x', '    path: /a'], 'Line 4: The SSH alias "a -oProxyCommand=x" must be a Host alias'],
			['an ssh starting with -', ['  a:', '    ssh: -oProxyCommand=x', '    path: /a'], 'Line 4: The SSH alias "-oProxyCommand=x" must be a Host alias'],
			['an ssh with a colon', ['  a:', '    ssh: "a:b"', '    path: /a'], 'Line 4: The SSH alias "a:b" must be a Host alias'],
			['an ssh with a semicolon', ['  a:', '    ssh: "a;rm"', '    path: /a'], 'Line 4: The SSH alias "a;rm" must be a Host alias'],
			['a relative path', ['  a:', '    ssh: a', '    path: projects/app'], 'Line 5: The path "projects/app" must be absolute (start with /).'],
			['a path from ~', ['  a:', '    ssh: a', '    path: ~/app'], 'Line 5: The path "~/app" must be absolute (start with /).'],
			['a path with a newline', ['  a:', '    ssh: a', '    path: "/a\\nb"'], 'Line 5: The path "/a?b" holds a control character.'],
			['a path with a NUL', ['  a:', '    ssh: a', '    path: "/a\\0b"'], 'Line 5: The path "/a?b" holds a control character.'],
			['a path that isn\'t a string', ['  a:', '    ssh: a', '    path: 1'], 'Line 5: "path" must be a string.'],
			['worktrees as yes', ['  a:', '    ssh: a', '    path: /a', '    worktrees: yes'], 'Line 6: "worktrees" must be true or false.'],
			['worktrees as a string', ['  a:', '    ssh: a', '    path: /a', '    worktrees: "true"'], 'Line 6: "worktrees" must be true or false.'],
			['forwardAgent as yes', ['  a:', '    ssh: a', '    path: /a', '    forwardAgent: yes'], 'Line 6: "forwardAgent" must be true or false.'],
			['a name that differs from another only in case', ['  b:', '    ssh: b', '    path: /b', '  a:', '    ssh: a', '    path: /a', '  A:', '    ssh: a', '    path: /a'], 'Line 9: The host name "A" differs from "a" only in case.']
		];
		cases.forEach(([name, hostLines, error]) => {
			it('Should reject ' + name, () => {
				// Run
				const result = parseConfig(config('  ok:', '    ssh: ok', '    path: /ok', ...hostLines));

				// Assert
				expect(result.error).toBeNull();
				expect(result.hosts![0]).toStrictEqual({ name: 'ok', ssh: 'ok', path: '/ok', worktrees: true, forwardAgent: false, error: null });
				const host = result.hosts![result.hosts!.length - 1];
				expect(host.error).not.toBeNull();
				expect(host.error!.replace(/^Line (\d+)/, (_, line) => 'Line ' + (parseInt(line) - 3)).startsWith(error)).toBe(true);
			});
		});

		it('Should keep the valid values of an invalid host', () => {
			// Run
			const result = parseConfig(config('  a:', '    ssh: a', '    path: /a', '    worktrees: maybe'));

			// Assert
			expect(result.hosts).toStrictEqual([{ name: 'a', ssh: 'a', path: '/a', worktrees: true, forwardAgent: false, error: 'Line 6: "worktrees" must be true or false.' }]);
		});
	});
});

describe('Validation', () => {
	it('Should accept host names of letters, digits, - and _', () => {
		expect(validateHostName('build-box_2')).toBeNull();
		expect(validateHostName('')).not.toBeNull();
		expect(validateHostName('a b')).not.toBeNull();
		expect(validateHostName('ä')).not.toBeNull();
		expect(validateHostName('..')).not.toBeNull();
	});

	it('Should accept SSH aliases that are one safe argument', () => {
		expect(validateSshAlias('build-box')).toBeNull();
		expect(validateSshAlias('dev@gpu-01.example.com')).toBeNull();
		expect(validateSshAlias('')).not.toBeNull();
		expect(validateSshAlias('-p')).not.toBeNull();
		expect(validateSshAlias('.hidden')).not.toBeNull();
		expect(validateSshAlias('a b')).not.toBeNull();
		expect(validateSshAlias('a\'b')).not.toBeNull();
		expect(validateSshAlias('a$b')).not.toBeNull();
		expect(validateSshAlias('[::1]')).not.toBeNull();
	});

	it('Should accept absolute paths without control characters', () => {
		expect(validateServerPath('/')).toBeNull();
		expect(validateServerPath('/srv/it\'s "an" app $HOME \\ `x`')).toBeNull();
		expect(validateServerPath('relative')).toBe('The path "relative" must be absolute (start with /).');
		expect(validateServerPath('')).toBe('The path "" must be absolute (start with /).');
		expect(validateServerPath('/a\tb')).toBe('The path "/a?b" holds a control character.');
		expect(validateServerPath('/a\u007fb')).toBe('The path "/a?b" holds a control character.');
		expect(validateServerPath('/a\u0085b')).toBe('The path "/a?b" holds a control character.');
	});
});

describe('setHostInConfig', () => {
	const host = (name: string, ssh: string, path: string, worktrees: boolean = true, forwardAgent: boolean = false): RemoteHostEntry => ({ name: name, ssh: ssh, path: path, worktrees: worktrees, forwardAgent: forwardAgent });
	// The yaml package writes one space before a line comment, and moves the comment of a key whose value is a mapping onto its own line
	const VALID_AS_WRITTEN = VALID.replace(/ {2,}#/g, ' #').replace('build-box: # the name shown in the graph\n', 'build-box:\n    # the name shown in the graph\n');

	describe('Adding a host', () => {
		it('Should make a new file', () => {
			// Run
			const result = setHostInConfig(null, null, host('box', 'build-box', '/srv/app'));

			// Assert
			expect(result).toStrictEqual({ text: 'version: 1\nhosts:\n  box:\n    ssh: build-box\n    path: /srv/app\n' });
		});

		it('Should add a host, keeping the other entries and comments', () => {
			// Run
			const result = setHostInConfig(VALID, null, host('third', 'third-01', '/srv/it\'s: app'));

			// Assert
			expect(result).toStrictEqual({ text: VALID_AS_WRITTEN + '  third:\n    ssh: third-01\n    path: "/srv/it\'s: app"\n' });
			expect(parseConfig((<{ text: string }>result).text).hosts!.map((config) => config.name)).toStrictEqual(['build-box', 'gpu', 'third']);
		});

		it('Should write "worktrees" only when it\'s false, and "forwardAgent" only when it\'s true', () => {
			// Assert
			expect(setHostInConfig(null, null, host('a', 'a', '/a', false, true))).toStrictEqual({ text: 'version: 1\nhosts:\n  a:\n    ssh: a\n    path: /a\n    worktrees: false\n    forwardAgent: true\n' });
			expect(setHostInConfig(null, null, host('a', 'a', '/a', true, false))).toStrictEqual({ text: 'version: 1\nhosts:\n  a:\n    ssh: a\n    path: /a\n' });
		});

		it('Should add a host to an empty "hosts"', () => {
			// Assert
			expect(setHostInConfig('version: 1\nhosts:\n', null, host('a', 'a', '/a'))).toStrictEqual({ text: 'version: 1\nhosts:\n  a:\n    ssh: a\n    path: /a\n' });
			expect(setHostInConfig('version: 1\nhosts: {}\n', null, host('a', 'a', '/a'))).toStrictEqual({ text: 'version: 1\nhosts:\n  a:\n    ssh: a\n    path: /a\n' });
		});

		it('Should refuse a host whose name is taken, in any case', () => {
			// Assert
			expect(setHostInConfig(VALID, null, host('GPU', 'a', '/a'))).toStrictEqual({ error: 'The file already has a host named "gpu".' });
		});
	});

	describe('Editing a host', () => {
		it('Should replace a host in place, keeping its comments and the order', () => {
			// Run
			const result = setHostInConfig(VALID, 'build-box', host('build-box', 'other-box', '/srv/other', true, true));

			// Assert
			expect(result).toStrictEqual({
				text: VALID_AS_WRITTEN
					.replace('ssh: build-box # a Host alias', 'ssh: other-box # a Host alias')
					.replace('path: /home/ubuntu/projects/app #', 'path: /srv/other #')
					.replace('    worktrees: true # include its linked worktrees (default: true)\n', '    forwardAgent: true\n')
			});
			expect(parseConfig((<{ text: string }>result).text).hosts!.map((config) => config.name)).toStrictEqual(['build-box', 'gpu']);
		});

		it('Should rename a host in its place', () => {
			// Run
			const result = setHostInConfig(VALID, 'gpu', host('gpu-02', 'gpu-01', '/srv/work/app'));

			// Assert
			expect(result).toStrictEqual({ text: VALID_AS_WRITTEN.replace('  gpu:\n', '  gpu-02:\n').replace('    worktrees: false # only the main worktree\n', '') });
		});

		it('Should allow a rename that only changes the case', () => {
			// Run
			const result = setHostInConfig(VALID, 'gpu', host('GPU', 'gpu-01', '/srv/work/app', false));

			// Assert
			expect(parseConfig((<{ text: string }>result).text).hosts!.map((config) => config.name)).toStrictEqual(['build-box', 'GPU']);
		});

		it('Should refuse a rename to a name that\'s taken, in any case', () => {
			// Assert
			expect(setHostInConfig(VALID, 'gpu', host('Build-Box', 'gpu-01', '/srv/work/app'))).toStrictEqual({ error: 'The file already has a host named "build-box".' });
		});

		it('Should refuse a host that isn\'t there', () => {
			// Assert
			expect(setHostInConfig(VALID, 'other', host('other', 'a', '/a'))).toStrictEqual({ error: 'The file has no host named "other".' });
			expect(setHostInConfig(null, 'other', host('other', 'a', '/a'))).toStrictEqual({ error: 'The file has no host named "other".' });
		});

		it('Should fix an invalid entry', () => {
			// Run
			const result = setHostInConfig(config('  a:', '    ssh: -a', '  b:', '    ssh: b', '    path: /b'), 'a', host('a', 'a', '/a'));

			// Assert
			expect(parseConfig((<{ text: string }>result).text).hosts).toStrictEqual([
				{ name: 'a', ssh: 'a', path: '/a', worktrees: true, forwardAgent: false, error: null },
				{ name: 'b', ssh: 'b', path: '/b', worktrees: true, forwardAgent: false, error: null }
			]);
		});

		it('Should give an entry that\'s an alias a mapping of its own, so the host it points at keeps its values', () => {
			// Run
			const result = setHostInConfig(config('  a: &host { ssh: a, path: /a }', '  b: *host'), 'b', host('b', 'b', '/b'));

			// Assert
			expect(parseConfig((<{ text: string }>result).text).hosts).toStrictEqual([
				{ name: 'a', ssh: 'a', path: '/a', worktrees: true, forwardAgent: false, error: null },
				{ name: 'b', ssh: 'b', path: '/b', worktrees: true, forwardAgent: false, error: null }
			]);
		});

		it('Should refuse an edit that would change another host', () => {
			// Run
			const result = setHostInConfig(config('  a: &host { ssh: a, path: /a }', '  b: *host'), 'a', host('a', 'c', '/c'));

			// Assert
			expect(result).toStrictEqual({ error: 'Git Tree couldn\'t write the host to ' + CONFIG_FILE + ' without changing what the file means. Edit it by hand.' });
		});
	});

	it('Should refuse invalid values', () => {
		// Assert
		expect(setHostInConfig(null, null, host('a b', 'a', '/a'))).toStrictEqual({ error: 'The host name "a b" may only hold letters, digits, - and _.' });
		expect(setHostInConfig(null, null, host('a', '-a', '/a'))).toHaveProperty('error');
		expect(setHostInConfig(null, null, host('a', 'a', 'a'))).toStrictEqual({ error: 'The path "a" must be absolute (start with /).' });
	});

	it('Should refuse to edit a file that can\'t be read', () => {
		// Assert
		expect(setHostInConfig('version: 2\nhosts:\n', null, host('a', 'a', '/a'))).toStrictEqual({ error: 'Git Tree can\'t edit ' + CONFIG_FILE + ' until it\'s fixed. Line 1: "version" must be 1, the only version of the file this Git Tree reads.' });
	});
});

describe('removeHostFromConfig', () => {
	it('Should remove a host, keeping the other entries and comments', () => {
		// Run
		const result = removeHostFromConfig(VALID, 'gpu');

		// Assert
		expect(result).toStrictEqual({ text: VALID.split('  gpu:')[0].replace(/ {2,}#/g, ' #').replace('build-box: # the name shown in the graph\n', 'build-box:\n    # the name shown in the graph\n') });
		expect(parseConfig((<{ text: string }>result).text).hosts!.map((host) => host.name)).toStrictEqual(['build-box']);
	});

	it('Should leave an empty "hosts" when the last host is removed', () => {
		// Run
		const result = removeHostFromConfig(config('  a:', '    ssh: a', '    path: /a'), 'a');

		// Assert
		expect(parseConfig((<{ text: string }>result).text)).toStrictEqual({ hosts: [], error: null });
	});

	it('Should remove a host whose entry is invalid', () => {
		// Run
		const result = removeHostFromConfig(config('  a:', '    ssh: -a', '  b:', '    ssh: b', '    path: /b'), 'a');

		// Assert
		expect(parseConfig((<{ text: string }>result).text).hosts).toStrictEqual([{ name: 'b', ssh: 'b', path: '/b', worktrees: true, forwardAgent: false, error: null }]);
	});

	it('Should refuse a host that isn\'t there', () => {
		// Assert
		expect(removeHostFromConfig(VALID, 'other')).toStrictEqual({ error: 'The file has no host named "other".' });
	});
});
