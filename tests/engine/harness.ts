import * as vscode from '../mocks/vscode';

import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigurationChangeEvent } from 'vscode';
import { DataSource } from '../../src/dataSource';
import { Engine, EngineAnswer, getEnginePath, getEnginePlatform, loadEngine } from '../../src/engine';
import { Logger } from '../../src/logger';
import { GitExecutable, getGitExecutable } from '../../src/utils';
import { EventEmitter } from '../../src/utils/event';

/*
 * What the engine's differential tests share: a temporary folder, the engine with its answers
 * recorded, DataSources with and without the engine, and the helpers that build repositories. Each test file calls
 * useEngineHarness() in its outermost describe, and must mock 'vscode', the askpass manager and the logger itself, since
 * jest.mock only applies to the file it is in.
 */

export const ROOT = path.join(__dirname, '..', '..');
const platform = getEnginePlatform();
export const engineBuilt = platform !== null && fs.existsSync(getEnginePath(platform));
export const describeWithEngine = engineBuilt ? describe : describe.skip;

export interface RecordedAnswer {
	readonly read: string;
	readonly repo: string;
	readonly answer: string; // 'ok', or 'unsupported: <why>', or 'failed: <why>'
}

/** The state the hooks of useEngineHarness() set up. */
export const harness = {
	tmp: '', // The temporary folder, which holds the home folder and the test repositories
	engine: <Engine><unknown>null, // The engine, recording each answer in `answers`
	answers: <RecordedAnswer[]>[] // The engine's answers since the current test started
};

let gitExecutable: GitExecutable;
let logger: Logger;
let onDidChangeConfiguration: EventEmitter<ConfigurationChangeEvent>;
let onDidChangeGitExecutable: EventEmitter<GitExecutable>;

/**
 * Register the hooks that set up and clean up the harness. Call it at the top of the outermost describe.
 */
export function useEngineHarness() {
	beforeAll(async () => {
		// Git and the engine both read the global configuration from the empty home folder home-setup.js made. Tests write
		// to it, so they must never run with the user's own.
		if (!process.env.GIT_TREE_ENGINE_TEST_HOME || process.env.HOME !== process.env.GIT_TREE_ENGINE_TEST_HOME) {
			throw new Error('The engine\'s tests need the home folder that tests/engine/home-setup.js makes: run them with jest.engine.config.js.');
		}
		harness.tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-tree-engine-')));

		logger = new Logger();
		onDidChangeConfiguration = new EventEmitter<ConfigurationChangeEvent>();
		onDidChangeGitExecutable = new EventEmitter<GitExecutable>();
		gitExecutable = await getGitExecutable('git');
		const loaded = loadEngine(logger);
		if ('error' in loaded) throw new Error(loaded.error + ' Run npm run build-engine first.');
		harness.engine = recordAnswers(loaded.engine);
	});

	afterAll(() => {
		onDidChangeConfiguration.dispose();
		onDidChangeGitExecutable.dispose();
		fs.rmSync(harness.tmp, { recursive: true, force: true });
	});

	beforeEach(() => {
		harness.answers = [];
		// The uncommitted changes rows carry the current time, so they would differ between two reads
		vscode.mockExtensionSettingReturnValue('repository.showUncommittedChanges', false);
	});
}


/* Comparing reads */

/**
 * Run a read with Git, and then with the engine.
 * @returns The result with Git, and the result with the engine.
 */
export async function readTwice<T>(read: (dataSource: DataSource) => Promise<T>) {
	const cli = createDataSource(null), withEngine = createDataSource(harness.engine);
	try {
		const expected = await read(cli);
		const before = harness.answers.length;
		const actual = await read(withEngine);
		expect(harness.answers.length).toBeGreaterThan(before);
		return [expected, actual];
	} finally {
		cli.dispose();
		withEngine.dispose();
	}
}

export function createDataSource(engine: Engine | null) {
	return new DataSource(gitExecutable, onDidChangeConfiguration.subscribe, onDidChangeGitExecutable.subscribe, logger, engine);
}

/**
 * Wrap the engine, recording each answer it gives. Every read takes the repository first. The parts of the view
 * load's reads (repoInfo and commits) are recorded too, as `<read>.<part>`, because each part is an answer of its own.
 */
function recordAnswers(engine: Engine): Engine {
	const recorded: { [read: string]: unknown } = { version: engine.version };
	const describe = (value: EngineAnswer<unknown>) => 'ok' in value ? 'ok' : 'unsupported' in value ? 'unsupported: ' + value.unsupported : 'failed: ' + value.failed;
	const isAnswer = (value: unknown): value is EngineAnswer<unknown> => typeof value === 'object' && value !== null && ('ok' in value || 'unsupported' in value || 'failed' in value);
	for (const read of <(keyof Engine)[]>Object.keys(engine)) {
		const run = engine[read];
		if (typeof run !== 'function') continue;
		recorded[read] = (repo: string, ...args: unknown[]) => (<(...args: unknown[]) => Promise<EngineAnswer<unknown>>>run)(repo, ...args).then((value) => {
			harness.answers.push({ read: read, repo: repo, answer: describe(value) });
			if ((read === 'repoInfo' || read === 'commits') && 'ok' in value) {
				for (const [part, answer] of Object.entries(<{ [part: string]: unknown }>value.ok)) {
					if (isAnswer(answer)) harness.answers.push({ read: read + '.' + part, repo: repo, answer: describe(answer) });
				}
			}
			return value;
		});
	}
	return <Engine><unknown>recorded;
}

/**
 * Expect the engine to have answered every read itself.
 */
export function expectOnlyOkAnswers() {
	expect(harness.answers.filter((answer) => answer.answer !== 'ok')).toStrictEqual([]);
}

/**
 * Expect the engine to have answered, or said why it didn't. Used for this repository, whose state the tests don't control.
 */
export function expectAnswers() {
	expect(harness.answers.filter((answer) => answer.answer.startsWith('failed'))).toStrictEqual([]);
	expect(harness.answers.some((answer) => answer.answer === 'ok')).toBe(true);
}


/* Building repositories */

export function gitEnv(date: string, name: string = 'Ada Park', email: string = 'ada@example.com') {
	return Object.assign({}, process.env, {
		GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: '@' + date + ' +0000',
		GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email, GIT_COMMITTER_DATE: '@' + date + ' +0000'
	});
}

export function git(cwd: string, ...args: string[]) {
	return cp.execFileSync('git', args, { cwd: cwd, env: gitEnv('1700000000'), stdio: 'pipe' }).toString();
}

export function init(dir: string, ...options: string[]) {
	fs.mkdirSync(dir, { recursive: true });
	git(dir, 'init', '-q', '-b', 'main', ...options);
	git(dir, 'config', 'commit.gpgsign', 'false');
	git(dir, 'config', 'tag.gpgsign', 'false');
	return dir;
}

export function commit(dir: string, message: string, date: string, authorDate?: string, name?: string) {
	const env = gitEnv(date, name);
	if (authorDate) env.GIT_AUTHOR_DATE = '@' + authorDate + ' +0000';
	cp.execFileSync('git', ['commit', '-q', '--allow-empty', '--cleanup=verbatim', '-m', message], { cwd: dir, env: env, stdio: 'pipe' });
}

export function merge(dir: string, branch: string, message: string, date: string) {
	cp.execFileSync('git', ['merge', '-q', '--no-ff', '-m', message, branch], { cwd: dir, env: gitEnv(date), stdio: 'pipe' });
}

export function buildLinearRepository(dir: string, commits: number) {
	init(dir);
	for (let i = 0; i < commits; i++) {
		commit(dir, 'Commit ' + i, String(1700000000 + i * 100));
	}
	return dir;
}
