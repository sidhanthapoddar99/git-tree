// Times the reads behind the Git Tree view, with the Git CLI and with the engine, on one repository.
//
// Usage: npm run bench-engine -- <repository> [--runs N]
//   <repository>  the path of the repository (or of a folder in it) to read
//   --runs N      the number of timed runs of each read (default 15); the table shows the median
//
// Each read goes through DataSource, the code the extension runs, so a time includes parsing and the
// shared interpretation of the records. A DataSource without the engine reads with Git, and one with
// the engine reads with the engine. The two alternate, after one warm-up run each.
//
// The view load is what opening the view reads: the repository info (branches, remotes, stashes and
// worktrees), then the refs and the first 300 commits. git status, which stays on the CLI, is left out
// (repository.showUncommittedChanges is off), so the times compare only the reads the engine replaces.
//
// It needs out/ (npm run bench-engine compiles src/ first) and the engine (npm run build-engine).
const Module = require('module');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const args = process.argv.slice(2);
let runs = 15, repoArg;
for (let i = 0; i < args.length; i++) {
	if (args[i] === '--runs') {
		runs = parseInt(args[++i], 10);
	} else {
		repoArg = args[i];
	}
}
if (typeof repoArg !== 'string' || !(runs > 0)) {
	console.error('Usage: npm run bench-engine -- <repository> [--runs N]');
	process.exit(1);
}

installVscodeStub({ 'repository.showUncommittedChanges': false });
const { DataSource } = require(path.join(ROOT, 'out', 'dataSource.js'));
const { loadEngine } = require(path.join(ROOT, 'out', 'engine.js'));
const { Logger } = require(path.join(ROOT, 'out', 'logger.js'));
const { getGitExecutable } = require(path.join(ROOT, 'out', 'utils.js'));

const ORDER = { date: 'date', authorDate: 'author-date', topo: 'topo' };

main().catch((error) => {
	console.error(error);
	process.exit(1);
});

async function main() {
	const repo = path.resolve(repoArg);
	const logger = new Logger();
	const loaded = loadEngine(logger);
	if (loaded === null) {
		console.error('The engine isn\'t built. Run npm run build-engine first.');
		process.exit(1);
	}
	const notOk = [];
	const engine = recordUnanswered(loaded, notOk);
	const gitExecutable = await getGitExecutable('git');
	const subscribe = () => ({ dispose: () => { } });
	const cli = new DataSource(gitExecutable, subscribe, subscribe, logger, null);
	const withEngine = new DataSource(gitExecutable, subscribe, subscribe, logger, engine);

	// The inputs that the view passes from the repository info to the commits
	const info = await cli.getRepoInfo(repo, true, true, []);
	if (info.error !== null) throw new Error('Unable to read the repository: ' + info.error);
	const log = (order) => (dataSource) => dataSource.getLog(repo, null, 301, true, true, false, false, order, info.remotes, [], info.stashes);

	const reads = [
		['branches (git branch -a)', (dataSource) => dataSource.getBranches(repo, true, [])],
		['remotes (git remote)', (dataSource) => dataSource.getRemotes(repo)],
		['stashes (git reflog refs/stash)', (dataSource) => dataSource.getStashes(repo)],
		['worktrees (git worktree list)', (dataSource) => dataSource.getWorktrees(repo)],
		['refs (git show-ref)', (dataSource) => dataSource.getRefs(repo, true, true, [])],
		['log, 301 commits, date order', log(ORDER.date)],
		['log, 301 commits, author-date order', log(ORDER.authorDate)],
		['log, 301 commits, topo order', log(ORDER.topo)],
		['log, all commits, date order', (dataSource) => dataSource.getLog(repo, null, 1000000, true, true, false, false, ORDER.date, info.remotes, [], info.stashes)],
		['repository info', (dataSource) => dataSource.getRepoInfo(repo, true, true, [])],
		['view load: repository info, refs and 300 commits', async (dataSource) => {
			const repoInfo = await dataSource.getRepoInfo(repo, true, true, []);
			return dataSource.getCommits(repo, null, 300, true, true, false, false, ORDER.date, repoInfo.remotes, [], repoInfo.stashes, repoInfo.worktrees);
		}]
	];

	console.log('Repository: ' + repo);
	console.log('Git ' + gitExecutable.version + ', engine ' + loaded.version + ', median of ' + runs + ' runs');
	console.log('');
	console.log('| Read | Git CLI (ms) | Engine (ms) | Speed-up |');
	console.log('|---|---:|---:|---:|');
	for (const [name, read] of reads) {
		const before = notOk.length;
		const [cliMs, engineMs] = await time(() => read(cli), () => read(withEngine));
		const note = notOk.length > before ? ' (engine handed to Git: ' + notOk.slice(before).filter(unique).join('; ') + ')' : '';
		console.log('| ' + name + note + ' | ' + cliMs.toFixed(1) + ' | ' + engineMs.toFixed(1) + ' | ' + (cliMs / engineMs).toFixed(1) + 'x |');
	}

	cli.dispose();
	withEngine.dispose();
	logger.dispose();
}

/**
 * Time two reads, alternating them, after one warm-up run each.
 * @returns The median time of each read, in milliseconds.
 */
async function time(first, second) {
	await first();
	await second();
	const firstTimes = [], secondTimes = [];
	for (let i = 0; i < runs; i++) {
		firstTimes.push(await timeOnce(first));
		secondTimes.push(await timeOnce(second));
	}
	return [median(firstTimes), median(secondTimes)];
}

async function timeOnce(read) {
	const start = process.hrtime.bigint();
	await read();
	return Number(process.hrtime.bigint() - start) / 1e6;
}

function median(values) {
	const sorted = values.slice().sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function unique(value, index, array) {
	return array.indexOf(value) === index;
}

/**
 * Wrap the engine, recording each answer that isn't `ok`, so the table shows a read that Git answered instead.
 */
function recordUnanswered(engine, notOk) {
	const wrapped = { version: engine.version };
	for (const read of ['branches', 'remotes', 'stashes', 'worktrees', 'refs', 'log']) {
		wrapped[read] = (...readArgs) => engine[read](...readArgs).then((answer) => {
			if (!('ok' in answer)) notOk.push(read + ': ' + ('unsupported' in answer ? answer.unsupported : answer.failed));
			return answer;
		});
	}
	return wrapped;
}

/**
 * Let out/ load outside Visual Studio Code: `require('vscode')` returns a stub whose settings are the
 * defaults, apart from the given ones, and whose output channel discards the log.
 */
function installVscodeStub(settings) {
	const configuration = {
		get: (section, defaultValue) => typeof settings[section] !== 'undefined' ? settings[section] : defaultValue,
		inspect: (section) => typeof settings[section] !== 'undefined' ? { workspaceValue: settings[section] } : undefined
	};
	const stub = {
		ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 },
		Uri: { file: (file) => ({ fsPath: file, scheme: 'file', path: file }) },
		workspace: { getConfiguration: () => configuration },
		window: { createOutputChannel: () => ({ appendLine: () => { }, dispose: () => { } }) }
	};
	const load = Module._load;
	Module._load = function (request) {
		return request === 'vscode' ? stub : load.apply(this, arguments);
	};
}
