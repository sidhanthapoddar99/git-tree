import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HOST_STATS_INTERVAL, HOST_STATS_SCRIPT, HostStats, HostStatsAnswer, parseHostStatsOutput } from '../src/hostStats';
import { ProcessResult } from '../src/remoteHosts/ssh';

const DF = 'Filesystem     1024-blocks      Used Available Capacity Mounted on\n/dev/nvme0n1p2   491134216 123456789 342345678      27% /\n';

/**
 * Get output as HOST_STATS_SCRIPT prints it.
 * @param memory The memory section's lines.
 * @param cpu The processors section's lines.
 * @param gpu The graphics cards section's lines.
 */
function output(memory: string, cpu: string, gpu: string) {
	return 'gt:disk\n' + DF + 'gt:memory\n' + memory + 'gt:cpu\n' + cpu + 'gt:gpu\n' + gpu + 'gt:end\n';
}

/**
 * Let the promises that are ready settle.
 */
async function flushPromises() {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('parseHostStatsOutput', () => {
	it('Should read each section, ignoring what a login shell printed first', () => {
		// Run
		const usage = parseHostStatsOutput('Welcome to the server\n' + output('32718000 12897000\n', '23.4 16\n', '41, 6246, 24576\n97, 23100, 24576\n'));

		// Assert
		expect(usage).toStrictEqual({
			disk: { total: 491134216, used: 123456789, free: 342345678 },
			memory: { total: 32718000, used: 12897000 },
			cpu: { busy: 23.4, cores: 16 },
			gpus: [{ busy: 41, memoryUsed: 6246, memoryTotal: 24576 }, { busy: 97, memoryUsed: 23100, memoryTotal: 24576 }]
		});
	});

	it('Should tell a host without nvidia-smi from one where nvidia-smi failed', () => {
		expect(parseHostStatsOutput(output('1 1\n', '1.0 1\n', 'gt:nogpu\n'))!.gpus).toStrictEqual([]);
		expect(parseHostStatsOutput(output('1 1\n', '1.0 1\n', 'gt:gpufail\n'))!.gpus).toBeNull();
		expect(parseHostStatsOutput(output('1 1\n', '1.0 1\n', ''))!.gpus).toBeNull();
	});

	it('Should leave out a value nvidia-smi didn\'t report, and refuse a line it can\'t read', () => {
		expect(parseHostStatsOutput(output('1 1\n', '1.0 1\n', '[N/A], 512, [N/A]\n'))!.gpus).toStrictEqual([{ busy: null, memoryUsed: 512, memoryTotal: null }]);
		expect(parseHostStatsOutput(output('1 1\n', '1.0 1\n', 'NVIDIA-SMI has failed\n'))!.gpus).toBeNull();
	});

	it('Should not guess a value that can\'t be read', () => {
		// Run
		const usage = parseHostStatsOutput('gt:disk\ndf: /gone: No such file or directory\ngt:memory\ngt:cpu\n12 0\ngt:gpu\ngt:nogpu\ngt:end\n');

		// Assert
		expect(usage).toStrictEqual({ disk: null, memory: null, cpu: null, gpus: [] });
		expect(parseHostStatsOutput(output('100 200\n', 'busy 16\n', 'gt:nogpu\n'))).toStrictEqual({ disk: { total: 491134216, used: 123456789, free: 342345678 }, memory: null, cpu: null, gpus: [] });
		expect(parseHostStatsOutput(output('100 50\n100 50\n', '1.0 1\n2.0 1\n', 'gt:nogpu\n'))).toMatchObject({ memory: null, cpu: null });
	});

	it('Should keep the processors\' percent at most 100, as the sum of each process\'s %CPU can be a little over', () => {
		expect(parseHostStatsOutput(output('1 1\n', '100.4 8\n', 'gt:nogpu\n'))!.cpu).toStrictEqual({ busy: 100, cores: 8 });
	});

	it('Should return NULL when the output isn\'t what the script prints', () => {
		expect(parseHostStatsOutput('')).toBeNull();
		expect(parseHostStatsOutput('gt:disk\ngt:memory\ngt:cpu\ngt:gpu\n')).toBeNull();
		expect(parseHostStatsOutput('gt:disk\ngt:cpu\ngt:memory\ngt:gpu\ngt:end\n')).toBeNull();
	});
});

describe('HOST_STATS_SCRIPT, run by sh', () => {
	const canRun = process.platform !== 'win32' && fs.existsSync('/bin/sh');
	const it_ = canRun ? it : it.skip;
	let tmp: string;

	beforeAll(() => {
		if (canRun) tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-tree-host-stats-')));
	});

	afterAll(() => {
		if (canRun) fs.rmSync(tmp, { recursive: true, force: true });
	});

	/**
	 * Make a folder of commands for the script's PATH: links to real ones, and fake ones.
	 * @param name The folder's name.
	 * @param real The real commands to link.
	 * @param fakes The fake commands' scripts, by name.
	 */
	const makeBin = (name: string, real: ReadonlyArray<string>, fakes: { [command: string]: string }) => {
		const bin = path.join(tmp, name);
		fs.mkdirSync(bin);
		real.forEach((command) => fs.symlinkSync(cp.execFileSync('/bin/sh', ['-c', 'command -v ' + command], { encoding: 'utf8' }).trim(), path.join(bin, command)));
		Object.keys(fakes).forEach((command) => fs.writeFileSync(path.join(bin, command), '#!/bin/sh\n' + fakes[command], { mode: 0o755 }));
		return bin;
	};

	it_('Should read this machine', () => {
		// Run
		const result = cp.spawnSync('/bin/sh', ['-s', '--', tmp], { input: HOST_STATS_SCRIPT, encoding: 'utf8' });
		const usage = parseHostStatsOutput(result.stdout);

		// Assert
		expect(result.status).toBe(0);
		expect(usage).not.toBeNull();
		expect(usage!.disk).not.toBeNull();
		if (fs.existsSync('/proc/meminfo')) {
			expect(usage!.memory!.used).toBeLessThanOrEqual(usage!.memory!.total);
			expect(usage!.cpu!.cores).toBeGreaterThan(0);
			expect(usage!.cpu!.busy).toBeGreaterThanOrEqual(0);
			expect(usage!.cpu!.busy).toBeLessThanOrEqual(100);
		}
	});

	it_('Should read a host without /proc, as macOS does, and say it has no nvidia-smi', () => {
		// Setup: the script reads /proc only when it can, so pointing it elsewhere takes the other way
		const bin = makeBin('mac', ['awk', 'df', 'head', 'grep', 'sleep'], {
			'sysctl': '[ "$2" = hw.memsize ] && echo 17179869184; [ "$2" = hw.ncpu ] && echo 8; exit 0\n',
			'vm_stat': 'printf \'Mach Virtual Memory Statistics: (page size of 16384 bytes)\\nPages free:                               12345.\\nPages active:                            262144.\\nPages inactive:                          100000.\\nPages wired down:                        131072.\\nPages occupied by compressor:             65536.\\n\'\n',
			'ps': 'printf \'  12.5\\n 100.0\\n   3.5\\n\'\n'
		});

		// Run
		const result = cp.spawnSync('/bin/sh', ['-s', '--', tmp], { input: HOST_STATS_SCRIPT.replace(/\/proc\//g, '/nonexistent/'), env: { PATH: bin }, encoding: 'utf8' });

		// Assert
		expect(parseHostStatsOutput(result.stdout)).toStrictEqual({
			disk: expect.objectContaining({ total: expect.any(Number) }),
			memory: { total: 16777216, used: (262144 + 131072 + 65536) * 16 },
			cpu: { busy: 14.5, cores: 8 },
			gpus: []
		});
	});

	it_('Should read each graphics card, and notice nvidia-smi failing', () => {
		// Setup
		const working = makeBin('gpu', ['awk', 'df', 'head', 'grep', 'sleep'], { 'nvidia-smi': 'printf \'41, 6246, 24576\\n7, 100, 8192\\n\'\n' });
		const failing = makeBin('gpufail', ['awk', 'df', 'head', 'grep', 'sleep'], { 'nvidia-smi': 'echo "NVIDIA-SMI has failed" ; exit 9\n' });
		const run = (bin: string) => parseHostStatsOutput(cp.spawnSync('/bin/sh', ['-s', '--', tmp], { input: HOST_STATS_SCRIPT, env: { PATH: bin }, encoding: 'utf8' }).stdout);

		// Run
		const gpus = run(working), failed = run(failing);

		// Assert
		expect(gpus!.gpus).toStrictEqual([{ busy: 41, memoryUsed: 6246, memoryTotal: 24576 }, { busy: 7, memoryUsed: 100, memoryTotal: 8192 }]);
		expect(failed!.gpus).toBeNull();
	});
});

describe('HostStats', () => {
	const ok: ProcessResult = { code: 0, stdout: Buffer.from(output('100 40\n', '12.5 4\n', 'gt:nogpu\n')), stderr: '', error: null, timedOut: false };
	let calls: { host: string, finish: (result: { result: ProcessResult } | { error: string }) => void }[];
	let answers: HostStatsAnswer[];
	let stats: HostStats;

	beforeEach(() => {
		jest.useFakeTimers();
		calls = [];
		answers = [];
		stats = new HostStats({
			remoteHosts: {
				runScript: (_repo, host, script, args, _timeout, changesHost) => {
					expect(script).toBe(HOST_STATS_SCRIPT);
					expect(args).toStrictEqual([]);
					expect(changesHost).toBe(false);
					return new Promise((resolve) => calls.push({ host: host, finish: resolve }));
				}
			}
		}, (answer) => answers.push(answer));
	});

	afterEach(() => {
		stats.stop();
		jest.useRealTimers();
	});

	/**
	 * Finish every read that is running.
	 */
	const finishAll = async () => {
		calls.splice(0).forEach((call) => call.finish({ result: ok }));
		await flushPromises();
	};

	it('Should read each host at once, then every 10 seconds', async () => {
		// Run
		stats.watch('/repo', ['a', 'b'], false);
		await finishAll();

		// Assert
		expect(answers).toStrictEqual([
			{ repo: '/repo', host: 'a', usage: { disk: { total: 491134216, used: 123456789, free: 342345678 }, memory: { total: 100, used: 40 }, cpu: { busy: 12.5, cores: 4 }, gpus: [] }, error: null },
			{ repo: '/repo', host: 'b', usage: { disk: { total: 491134216, used: 123456789, free: 342345678 }, memory: { total: 100, used: 40 }, cpu: { busy: 12.5, cores: 4 }, gpus: [] }, error: null }
		]);

		// Run
		jest.advanceTimersByTime(HOST_STATS_INTERVAL - 1);

		// Assert
		expect(calls).toHaveLength(0);

		// Run
		jest.advanceTimersByTime(1);

		// Assert
		expect(calls.map((call) => call.host)).toStrictEqual(['a', 'b']);
	});

	it('Should not read a host again while its read is still running', async () => {
		// Setup
		stats.watch('/repo', ['slow'], false);

		// Run
		jest.advanceTimersByTime(HOST_STATS_INTERVAL * 3);
		stats.watch('/repo', ['slow'], true);

		// Assert
		expect(calls).toHaveLength(1);

		// Run
		await finishAll();
		jest.advanceTimersByTime(HOST_STATS_INTERVAL);

		// Assert
		expect(answers).toHaveLength(1);
		expect(calls).toHaveLength(1);
	});

	it('Should read only the hosts that are new to the list, until the next tick, unless asked to refresh', async () => {
		// Setup
		stats.watch('/repo', ['a'], false);
		await finishAll();

		// Run
		stats.watch('/repo', ['a', 'b'], false);

		// Assert
		expect(calls.map((call) => call.host)).toStrictEqual(['b']);
		await finishAll();

		// Run
		stats.watch('/repo', ['a', 'b'], false);

		// Assert
		expect(calls).toHaveLength(0);

		// Run
		stats.watch('/repo', ['a', 'b'], true);

		// Assert
		expect(calls.map((call) => call.host)).toStrictEqual(['a', 'b']);
	});

	it('Should not read while the view is hidden, and read at once when it\'s shown', async () => {
		// Setup
		stats.watch('/repo', ['a'], false);
		await finishAll();

		// Run
		stats.setVisible(false);
		jest.advanceTimersByTime(HOST_STATS_INTERVAL * 5);
		stats.watch('/repo', ['a', 'b'], true);

		// Assert
		expect(calls).toHaveLength(0);

		// Run
		stats.setVisible(true);

		// Assert
		expect(calls.map((call) => call.host)).toStrictEqual(['a', 'b']);
	});

	it('Should stop when the panel stops watching, and not send the answer of a read that was running', async () => {
		// Setup
		stats.watch('/repo', ['a', 'b'], false);

		// Run
		stats.watch('/repo', ['a'], false);
		await finishAll();
		stats.watch('/repo', [], false);
		jest.advanceTimersByTime(HOST_STATS_INTERVAL * 5);

		// Assert
		expect(answers.map((answer) => answer.host)).toStrictEqual(['a']);
		expect(calls).toHaveLength(0);
	});

	it('Should send why a host couldn\'t be read, leaving SSH failures to runScript', async () => {
		// Setup
		stats.watch('/repo', ['down', 'odd'], false);

		// Run
		calls[0].finish({ error: 'Git Tree couldn\'t connect to "down".' });
		calls[1].finish({ result: { code: 2, stdout: Buffer.from('nothing useful'), stderr: 'sh: 1: bad\n', error: null, timedOut: false } });
		await flushPromises();

		// Assert
		expect(answers).toStrictEqual([
			{ repo: '/repo', host: 'down', usage: null, error: 'Git Tree couldn\'t connect to "down".' },
			{ repo: '/repo', host: 'odd', usage: null, error: 'Git Tree couldn\'t read the usage of "odd": sh: 1: bad' }
		]);
	});

	it('Should say remote hosts aren\'t available without them', async () => {
		// Setup
		const sent: HostStatsAnswer[] = [];
		const withoutRemoteHosts = new HostStats({ remoteHosts: null }, (answer) => sent.push(answer));

		// Run
		withoutRemoteHosts.watch('/repo', ['a'], false);
		await flushPromises();
		withoutRemoteHosts.stop();

		// Assert
		expect(sent).toStrictEqual([{ repo: '/repo', host: 'a', usage: null, error: 'Remote hosts aren\'t available.' }]);
	});
});
