import type { RemoteHosts } from './remoteHosts';
import { getErrorLines, runProcess } from './remoteHosts/ssh';
import { HostCpu, HostGpu, HostMemory, HostUsage, ResponseHostStats } from './types';
import { parseDfOutput } from './worktreeStats';

/*
 * The Hosts panel's usage of each host: its disk, memory, processors and graphics cards. One fixed script reads them
 * all, with sh on this machine, and over SSH on a remote host (RemoteHosts.runScript). While the panel is open, the
 * view watches its hosts: each is read at once, then every 10 seconds while the view is visible. A host is never read
 * twice at once: a tick that finds its read still running skips it.
 */

/** How often a watched host is read again, in milliseconds. */
export const HOST_STATS_INTERVAL = 10000;

/** How long reading a host may take, in milliseconds. */
const HOST_STATS_TIMEOUT = 30000;

const REMOTE_HOSTS_UNAVAILABLE = 'Remote hosts aren\'t available.';

/** What HostStats uses of DataSource: the remote hosts. */
export interface HostStatsSource {
	readonly remoteHosts: Pick<RemoteHosts, 'runScript'> | null;
}

/** A host's answer, as the view's response carries it. */
export type HostStatsAnswer = Pick<ResponseHostStats, 'repo' | 'host' | 'usage' | 'error'>;


/* The script */

/**
 * Read a host's usage: `sh -s -- <the repository's main worktree>`. It only reads. It prints sections that each start
 * with a `gt:` line, and ends with `gt:end`:
 * - `gt:disk`: the output of `df -Pk` for the repository's folder.
 * - `gt:memory`: `<total> <used>` in kilobytes. Linux: MemTotal, less MemAvailable. macOS: hw.memsize, and the
 *   active, wired and compressed pages of vm_stat (as Activity Monitor's Memory Used).
 * - `gt:cpu`: `<percent busy> <cores>`. Linux: two reads of /proc/stat 0.3 seconds apart. macOS: the %CPU of every
 *   process, shared among hw.ncpu cores.
 * - `gt:gpu`: a `<percent busy>, <MiB used>, <MiB total>` line per card from nvidia-smi, `gt:nogpu` when there's no
 *   nvidia-smi, or `gt:gpufail` when it failed.
 * A section is empty when its values couldn't be read.
 */
export const HOST_STATS_SCRIPT = [
	'LC_ALL=C',
	'export LC_ALL',
	'echo gt:disk',
	'df -Pk -- "$1" 2>/dev/null',
	'echo gt:memory',
	'if [ -r /proc/meminfo ]; then',
	'  awk \'$1 == "MemTotal:" { t = $2 } $1 == "MemAvailable:" { a = $2 } END { if (t != "" && a != "") print t, t - a }\' /proc/meminfo',
	'elif command -v vm_stat >/dev/null 2>&1; then',
	'  vm_stat 2>/dev/null | awk -v b="$(sysctl -n hw.memsize 2>/dev/null)" \'/page size of/ { for (i = 1; i < NF; i++) if ($i == "of") p = $(i + 1) } /^Pages active:/ { a = $3; f++ } /^Pages wired down:/ { w = $4; f++ } /^Pages occupied by compressor:/ { c = $5; f++ } END { if (f == 3 && b ~ /^[0-9]+$/ && p ~ /^[0-9]+$/) print int(b / 1024), int((a + w + c) * p / 1024) }\'',
	'fi',
	'echo gt:cpu',
	'if [ -r /proc/stat ]; then',
	'  s1=$(head -n 1 /proc/stat)',
	// A sleep without fractions waits a whole second instead
	'  sleep 0.3 2>/dev/null || sleep 1',
	'  s2=$(head -n 1 /proc/stat)',
	// The fields after `cpu` are user, nice, system, idle, iowait, irq, softirq and steal. Guest time is in user already.
	'  printf \'%s\\n%s\\n\' "$s1" "$s2" | awk -v n="$(grep -c \'^cpu[0-9]\' /proc/stat)" \'$1 == "cpu" { idle = $5 + $6; total = 0; for (i = 2; i <= 9 && i <= NF; i++) total += $i; c++; if (c == 1) { i0 = idle; t0 = total } else { i1 = idle; t1 = total } } END { if (c == 2 && t1 > t0 && n ~ /^[0-9]+$/ && n > 0) printf "%.1f %d\\n", 100 * (1 - (i1 - i0) / (t1 - t0)), n }\'',
	'elif command -v sysctl >/dev/null 2>&1; then',
	'  ps -A -o %cpu= 2>/dev/null | awk -v n="$(sysctl -n hw.ncpu 2>/dev/null)" \'{ s += $1 } END { if (NR > 0 && n ~ /^[0-9]+$/ && n > 0) printf "%.1f %d\\n", s / n, n }\'',
	'fi',
	'echo gt:gpu',
	'if command -v nvidia-smi >/dev/null 2>&1; then',
	'  nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null || echo gt:gpufail',
	'else',
	'  echo gt:nogpu',
	'fi',
	'echo gt:end',
	''
].join('\n');

/**
 * Parse the output of HOST_STATS_SCRIPT. Lines before its first section are ignored, since a login shell's startup
 * files may print something. A value whose section can't be read is NULL.
 * @param stdout The output.
 * @returns The usage, or NULL if the output isn't what the script prints.
 */
export function parseHostStatsOutput(stdout: string): HostUsage | null {
	const lines = stdout.split(/\r?\n/);
	const sections: string[][] = [];
	let i = lines.indexOf('gt:disk');
	for (const name of ['gt:disk', 'gt:memory', 'gt:cpu', 'gt:gpu']) {
		if (i === -1 || lines[i] !== name) return null;
		const section: string[] = [];
		for (i++; i < lines.length && !/^gt:(memory|cpu|gpu|end)$/.test(lines[i]); i++) {
			if (lines[i] !== '') section.push(lines[i]);
		}
		sections.push(section);
	}
	if (lines[i] !== 'gt:end') return null;

	return {
		disk: parseDfOutput(sections[0].join('\n')),
		memory: parseMemoryLines(sections[1]),
		cpu: parseCpuLines(sections[2]),
		gpus: parseGpuLines(sections[3])
	};
}

/**
 * Parse the memory section: one `<total> <used>` line, in kilobytes.
 * @param lines The section's lines.
 * @returns The memory, or NULL if it can't be read.
 */
function parseMemoryLines(lines: ReadonlyArray<string>): HostMemory | null {
	const match = lines.length === 1 ? lines[0].match(/^(\d+) (\d+)$/) : null;
	if (match === null) return null;
	const total = parseInt(match[1], 10), used = parseInt(match[2], 10);
	return total > 0 && used <= total ? { total: total, used: used } : null;
}

/**
 * Parse the processors section: one `<percent busy> <cores>` line. The sum of every process's %CPU (macOS) can be a
 * little over 100 from rounding, so the percent is at most 100.
 * @param lines The section's lines.
 * @returns The processors, or NULL if they can't be read.
 */
function parseCpuLines(lines: ReadonlyArray<string>): HostCpu | null {
	const match = lines.length === 1 ? lines[0].match(/^(\d+(?:\.\d+)?) (\d+)$/) : null;
	if (match === null) return null;
	const cores = parseInt(match[2], 10);
	return cores > 0 ? { busy: Math.min(parseFloat(match[1]), 100), cores: cores } : null;
}

/**
 * Parse the graphics cards section: a line per card from nvidia-smi, `gt:nogpu`, or `gt:gpufail`. A value nvidia-smi
 * doesn't report (such as `[N/A]`) is NULL.
 * @param lines The section's lines.
 * @returns The cards (empty when the host has no nvidia-smi), or NULL if nvidia-smi failed or printed something else.
 */
function parseGpuLines(lines: ReadonlyArray<string>): HostGpu[] | null {
	if (lines.length === 1 && lines[0] === 'gt:nogpu') return [];
	if (lines.length === 0) return null;
	const gpus: HostGpu[] = [];
	for (const line of lines) {
		const fields = line.split(',').map((field) => field.trim());
		if (fields.length !== 3) return null;
		const values = fields.map((field) => /^\d+(\.\d+)?$/.test(field) ? parseFloat(field) : null);
		gpus.push({ busy: values[0], memoryUsed: values[1], memoryTotal: values[2] });
	}
	return gpus;
}


/* Watching */

/**
 * Reads the usage of the hosts a view's Hosts panel shows, while the panel is open and the view is visible.
 */
export class HostStats {
	private readonly source: HostStatsSource;
	private readonly send: (answer: HostStatsAnswer) => void;
	private watched: { readonly repo: string, readonly hosts: ReadonlyArray<string | null> } | null = null;
	private visible: boolean = true;
	private timer: NodeJS.Timeout | null = null;
	private readonly reading = new Set<string>(); // The reads running, by repository and host

	/**
	 * @param source The DataSource, for the remote hosts.
	 * @param send Called with each host's answer, while the host is still watched.
	 */
	constructor(source: HostStatsSource, send: (answer: HostStatsAnswer) => void) {
		this.source = source;
		this.send = send;
	}

	/**
	 * Watch a repository's hosts, instead of the hosts watched before. Hosts that are new to the list are read at once,
	 * and every host is read every 10 seconds while the view is visible.
	 * @param repo The path of the repository.
	 * @param hosts The hosts: NULL => this machine, otherwise a remote host's name. Empty => stop watching.
	 * @param refresh Read every host now.
	 */
	public watch(repo: string, hosts: ReadonlyArray<string | null>, refresh: boolean) {
		const before = this.watched !== null && this.watched.repo === repo ? this.watched.hosts : [];
		this.watched = hosts.length > 0 ? { repo: repo, hosts: hosts.slice() } : null;
		if (this.watched === null) {
			this.stopTimer();
		} else if (this.visible) {
			if (refresh || this.timer === null) {
				this.tick();
			} else {
				hosts.filter((host) => before.indexOf(host) === -1).forEach((host) => this.read(repo, host));
			}
		}
	}

	/**
	 * Stop watching, as the panel that asked has gone (it closed, or the page was rebuilt). Reads that are running
	 * finish, but aren't sent.
	 */
	public stop() {
		this.watched = null;
		this.stopTimer();
	}

	/**
	 * Pause while the view is hidden, and read every host again when it's shown.
	 * @param visible Is the view visible.
	 */
	public setVisible(visible: boolean) {
		if (this.visible === visible) return;
		this.visible = visible;
		if (visible) {
			this.tick();
		} else {
			this.stopTimer();
		}
	}

	/**
	 * Read every watched host, except one whose read is still running, and read them again in 10 seconds.
	 */
	private tick() {
		this.stopTimer();
		const watched = this.watched;
		if (watched === null || !this.visible) return;
		watched.hosts.forEach((host) => this.read(watched.repo, host));
		this.timer = setTimeout(() => {
			this.timer = null;
			this.tick();
		}, HOST_STATS_INTERVAL);
	}

	private stopTimer() {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	/**
	 * Read a host, unless its read is still running, and send its answer if it's still watched then.
	 * @param repo The path of the repository.
	 * @param host The remote host's name, or NULL for this machine.
	 */
	private read(repo: string, host: string | null) {
		const key = JSON.stringify([repo, host]);
		if (this.reading.has(key)) return;
		this.reading.add(key);
		this.readHost(repo, host).then((answer) => {
			this.reading.delete(key);
			const watched = this.watched;
			if (watched !== null && watched.repo === repo && watched.hosts.indexOf(host) > -1) {
				this.send({ repo: repo, host: host, usage: answer.usage, error: answer.error });
			}
		});
	}

	/**
	 * Run the script on a host, and parse its output. It never rejects.
	 * @param repo The path of the repository.
	 * @param host The remote host's name, or NULL for this machine.
	 * @returns The usage, or why there's none.
	 */
	private async readHost(repo: string, host: string | null): Promise<Pick<HostStatsAnswer, 'usage' | 'error'>> {
		const failed = (error: string) => ({ usage: null, error: error });
		try {
			if (host === null) {
				// Windows has no sh, df or /proc
				if (process.platform === 'win32') return failed('The usage of this machine isn\'t available on Windows.');
				const result = await runProcess('sh', ['-s', '--', repo], { input: HOST_STATS_SCRIPT, timeout: HOST_STATS_TIMEOUT });
				if (result.error !== null) return failed('Git Tree couldn\'t run sh to read the usage of this machine (' + result.error.message + ').');
				if (result.timedOut) return failed('Reading the usage of this machine took longer than ' + (HOST_STATS_TIMEOUT / 1000) + ' seconds.');
				const usage = parseHostStatsOutput(result.stdout.toString());
				return usage !== null ? { usage: usage, error: null } : failed('Git Tree couldn\'t read the usage of this machine' + (result.stderr.trim() !== '' ? ': ' + getErrorLines(result.stderr) : '.'));
			}

			const remoteHosts = this.source.remoteHosts;
			if (remoteHosts === null) return failed(REMOTE_HOSTS_UNAVAILABLE);
			const ran = await remoteHosts.runScript(repo, host, HOST_STATS_SCRIPT, [], HOST_STATS_TIMEOUT, false);
			if ('error' in ran) return failed(ran.error);
			const usage = parseHostStatsOutput(ran.result.stdout.toString());
			return usage !== null ? { usage: usage, error: null } : failed('Git Tree couldn\'t read the usage of "' + host + '"' + (ran.result.stderr.trim() !== '' ? ': ' + getErrorLines(ran.result.stderr) : '.'));
		} catch (error) {
			return failed('Git Tree couldn\'t read the usage (' + (error instanceof Error ? error.message : String(error)) + ').');
		}
	}
}
