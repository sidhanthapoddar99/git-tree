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
// (repository.showUncommittedChanges is off), so the times compare only the reads the engine replaces. With the
// engine, a view load is two reads (repoInfo and commits). DataSource gives the commits read the token of its last
// answer, so a refresh where nothing changed doesn't walk the log: the view load row forgets that answer before each
// run, and the refresh row keeps it.
//
// The details reads are what the Commit Details View reads: a commit's details with its diff, for a small
// commit, the merge with the largest diff from its first parent and the commit with the most changed lines
// (among the latest 500, preferring commits the engine answers), and a stash, a comparison, a file, a subject,
// a remote's URL, a tag's details and the configuration.
//
// It needs out/ (npm run bench-engine compiles src/ first) and the engine (npm run build-engine).
const cp = require('child_process');
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
	if ('error' in loaded) {
		console.error(loaded.error + ' Run npm run build-engine first.');
		process.exit(1);
	}
	const notOk = [];
	const engine = recordUnanswered(loaded.engine, notOk);
	const gitExecutable = await getGitExecutable('git');
	const subscribe = () => ({ dispose: () => { } });
	const cli = new DataSource(gitExecutable, subscribe, subscribe, logger, null);
	const withEngine = new DataSource(gitExecutable, subscribe, subscribe, logger, engine);

	// The inputs that the view passes from the repository info to the commits
	const info = await cli.getRepoInfo(repo, true, true, []);
	if (info.error !== null) throw new Error('Unable to read the repository: ' + info.error);
	// The single log read, which Commit Details and the differential tests still use
	const readLog = (dataSource, maxCount, order) => {
		const read = dataSource.getLogRead(null, maxCount, true, true, false, false, order, info.remotes, [], info.stashes);
		return dataSource.getLog(repo, read, (engine) => engine.log(repo, read.request));
	};
	const log = (order) => (dataSource) => readLog(dataSource, 301, order);
	const viewLoad = async (dataSource) => {
		const repoInfo = await dataSource.getRepoInfo(repo, true, true, []);
		return dataSource.getCommits(repo, null, 300, true, true, false, false, ORDER.date, repoInfo.remotes, [], repoInfo.stashes, repoInfo.worktrees);
	};

	const reads = [
		['branches (git branch -a)', (dataSource) => dataSource.getBranches(repo, true, [])],
		['remotes (git remote)', (dataSource) => dataSource.getRemotes(repo)],
		['stashes (git reflog refs/stash)', (dataSource) => dataSource.getStashes(repo)],
		['worktrees (git worktree list)', (dataSource) => dataSource.getWorktrees(repo)],
		['refs (git show-ref)', (dataSource) => dataSource.getRefs(repo, true, true, [], (engine) => engine.refs(repo, true))],
		['log, 301 commits, date order', log(ORDER.date)],
		['log, 301 commits, author-date order', log(ORDER.authorDate)],
		['log, 301 commits, topo order', log(ORDER.topo)],
		['log, all commits, date order', (dataSource) => readLog(dataSource, 1000000, ORDER.date)],
		['repository info', (dataSource) => dataSource.getRepoInfo(repo, true, true, [])],
		['view load: repository info, refs and 300 commits', (dataSource) => {
			dataSource.commitsCache.clear();
			return viewLoad(dataSource);
		}],
		['refresh where nothing changed', viewLoad],
		...await detailsReads(repo, info, loaded.engine)
	];

	console.log('Repository: ' + repo);
	console.log('Git ' + gitExecutable.version + ', engine ' + loaded.engine.version + ', median of ' + runs + ' runs');
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
 * The Commit Details View's reads, on commits picked from the latest 500.
 */
async function detailsReads(repo, info, engine) {
	const git = (...gitArgs) => cp.execFileSync('git', gitArgs, { cwd: repo, maxBuffer: 1 << 30 }).toString();
	const engineAnswers = async (from, to) => 'ok' in await engine.diff(repo, from, to);

	// Each commit's parents, changed files and changed lines (git log shows no diff for a merge)
	const commits = [];
	for (const block of git('log', '-n', '500', '--format=@%H %P', '--numstat', '--no-renames', '--all').split('@').slice(1)) {
		const lines = block.trim().split('\n');
		const [hash, ...parents] = lines[0].split(' ');
		const stats = lines.slice(1).filter((line) => line !== '').map((line) => line.split('\t'));
		commits.push({ hash: hash, parents: parents, files: stats.length, lines: stats.reduce((sum, stat) => sum + (parseInt(stat[0]) || 0) + (parseInt(stat[1]) || 0), 0) });
	}
	const pick = async (candidates) => {
		for (const commit of candidates) {
			if (await engineAnswers(commit.parents.length > 0 ? commit.hash + '^' : commit.hash, commit.hash)) return commit;
		}
		return candidates[0];
	};
	const nonMerges = commits.filter((commit) => commit.parents.length === 1);
	const small = await pick(nonMerges.filter((commit) => commit.files >= 1 && commit.files <= 3));
	const big = await pick(nonMerges.slice().sort((a, b) => b.lines - a.lines).slice(0, 20));
	const merges = commits.filter((commit) => commit.parents.length > 1).slice(0, 40);
	merges.forEach((merge) => merge.files = git('diff', '--name-only', merge.hash + '^', merge.hash).split('\n').filter((line) => line !== '').length);
	const largeMerge = await pick(merges.sort((a, b) => b.files - a.files).slice(0, 20));

	const details = (label, commit) => commit ? [['commit details, ' + label, (dataSource) => dataSource.getCommitDetails(repo, commit.hash, commit.parents.length > 0)]] : [];
	const reads = [
		...details('small commit (' + (small && small.files) + ' files)', small),
		...details('large merge (' + (largeMerge && largeMerge.files) + ' files from the first parent)', largeMerge),
		...details('big diff (' + (big && big.lines) + ' lines)', big)
	];
	if (info.stashes.length > 0) {
		reads.push(['stash details', (dataSource) => dataSource.getStashDetails(repo, info.stashes[0].hash, info.stashes[0])]);
	}
	if (commits.length > 50) {
		reads.push(['commit comparison, 50 commits apart', (dataSource) => dataSource.getCommitComparison(repo, commits[50].hash, commits[0].hash)]);
	}
	if (small) {
		const file = git('diff-tree', '--no-commit-id', '--name-only', '-r', '--diff-filter=AM', small.hash).split('\n')[0];
		if (file) reads.push(['commit file (git show)', (dataSource) => dataSource.getCommitFile(repo, small.hash, file)]);
		reads.push(['commit subject', (dataSource) => dataSource.getCommitSubject(repo, small.hash)]);
	}
	if (info.remotes.length > 0) {
		reads.push(['remote URL (git config --get)', (dataSource) => dataSource.getRemoteUrl(repo, info.remotes[0])]);
	}
	const tag = git('for-each-ref', '--format=%(objecttype) %(refname:strip=2)', 'refs/tags').split('\n').find((line) => line.startsWith('tag '));
	if (tag) {
		reads.push(['tag details (git for-each-ref)', (dataSource) => dataSource.getTagDetails(repo, tag.substring(4))]);
	}
	reads.push(['configuration (three git config --list)', (dataSource) => dataSource.getConfig(repo, info.remotes)]);
	return reads;
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
	for (const read of Object.keys(engine).filter((key) => typeof engine[key] === 'function')) {
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
