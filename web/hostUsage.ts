/* Host Usage
 * The meters under a host in the Hosts panel: how much of its processors, memory, disk and graphics cards is in use, each
 * as a thin bar and its numbers. A value that couldn't be read shows a dash, with why in its tooltip, never a guess. */

/** What the Hosts panel knows of a host's usage. */
interface HostUsageState {
	usage: GG.HostUsage | null; // From the last answer. NULL => no answer yet, or the last one has an error.
	error: string | null; // Why the last answer has no usage
	loading: boolean; // No answer has come yet
}

/**
 * Get the HTML of a host's meters.
 * @param state What the panel knows of the host's usage.
 * @returns The HTML.
 */
function hostUsageHtml(state: HostUsageState) {
	if (state.error !== null) {
		return '<div class="hostUsageError" title="' + escapeHtml(state.error) + '">' + escapeHtml(state.error) + '</div>';
	}
	const usage = state.usage;
	if (usage === null) {
		return '<div class="hostMeters" aria-busy="true">' + ['CPU', 'RAM', 'Disk', 'GPU'].map((label) => hostMeterHtml(label, null, settingsSpinnerHtml(), 'Reading the usage' + ELLIPSIS)).join('') + '</div>';
	}

	const missing = '<span class="hostMeterMissing">&mdash;</span>';
	let html = '';

	const cpu = usage.cpu;
	if (cpu !== null) {
		const cores = cpu.cores + ' core' + (cpu.cores !== 1 ? 's' : '');
		html += hostMeterHtml('CPU', cpu.busy / 100, Math.round(cpu.busy) + '% · ' + cores, 'Processors: ' + (Math.round(cpu.busy * 10) / 10) + '% busy, across ' + cores);
	} else {
		html += hostMeterHtml('CPU', null, missing, 'Git Tree couldn\'t read how busy the processors are.');
	}

	const memory = usage.memory;
	html += memory !== null
		? hostMeterHtml('RAM', memory.used / memory.total, formatKilobytesOfTotal(memory.used, memory.total), 'Memory: ' + formatKilobytes(memory.used) + ' used of ' + formatKilobytes(memory.total))
		: hostMeterHtml('RAM', null, missing, 'Git Tree couldn\'t read the memory.');

	const disk = usage.disk;
	html += disk !== null && disk.total > 0
		? hostMeterHtml('Disk', disk.used / disk.total, formatKilobytesOfTotal(disk.used, disk.total), 'The disk that holds the repository: ' + formatKilobytes(disk.used) + ' used, ' + formatKilobytes(disk.free) + ' free, of ' + formatKilobytes(disk.total))
		: hostMeterHtml('Disk', null, missing, 'Git Tree couldn\'t read the disk that holds the repository.');

	const gpus = usage.gpus;
	if (gpus === null) {
		html += hostMeterHtml('GPU', null, missing, 'nvidia-smi couldn\'t read the graphics cards.');
	} else if (gpus.length === 0) {
		html += hostMeterHtml('GPU', null, '<span class="hostMeterNone">No GPU found</span>', 'No NVIDIA graphics card was found: nvidia-smi isn\'t installed.');
	} else {
		gpus.forEach((gpu, i) => {
			const label = gpus.length > 1 ? 'GPU ' + i : 'GPU';
			const memoryKnown = gpu.memoryUsed !== null && gpu.memoryTotal !== null && gpu.memoryTotal > 0;
			const value = (gpu.busy !== null ? Math.round(gpu.busy) + '%' : missing) + (memoryKnown ? ' · ' + formatKilobytesOfTotal(gpu.memoryUsed! * 1024, gpu.memoryTotal! * 1024) : ' · ' + missing);
			const title = 'Graphics card' + (gpus.length > 1 ? ' ' + i : '') + ': ' + (gpu.busy !== null ? Math.round(gpu.busy) + '% busy' : 'nvidia-smi didn\'t report how busy it is') +
				', ' + (memoryKnown ? formatKilobytes(gpu.memoryUsed! * 1024) + ' of its memory used of ' + formatKilobytes(gpu.memoryTotal! * 1024) : 'nvidia-smi didn\'t report its memory');
			html += hostMeterHtml(label, gpu.busy !== null ? gpu.busy / 100 : null, value, title);
		});
	}
	return '<div class="hostMeters">' + html + '</div>';
}

/**
 * Get the HTML of a meter: its label, its bar, and its numbers.
 * @param label The label.
 * @param share How full its bar is, from 0 to 1, or NULL for no bar.
 * @param value The numbers (HTML).
 * @param title What it shows, as its tooltip (text).
 * @returns The HTML.
 */
function hostMeterHtml(label: string, share: number | null, value: string, title: string) {
	const escapedTitle = escapeHtml(title);
	// A bar nine-tenths full stands out
	return '<div class="hostMeter' + (share !== null && share >= 0.9 ? ' high' : '') + '" title="' + escapedTitle + '"><span class="hostMeterLabel">' + label + '</span>' +
		(share !== null ? settingsBarHtml(share, escapedTitle) : '<span class="hostMeterNoBar"></span>') +
		'<span class="hostMeterValue">' + value + '</span></div>';
}
