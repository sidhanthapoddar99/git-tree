import * as date from './mocks/date';
import * as vscode from './mocks/vscode';
jest.mock('vscode', () => vscode, { virtual: true });
jest.mock('fs');
jest.mock('https');
jest.mock('../src/dataSource');
jest.mock('../src/extensionState');
jest.mock('../src/logger');

import * as fs from 'fs';
import { ClientRequest, IncomingMessage } from 'http';
import * as https from 'https';
import { URL } from 'url';
import { ConfigurationChangeEvent } from 'vscode';
import { AvatarEvent, AvatarManager } from '../src/avatarManager';
import { DataSource } from '../src/dataSource';
import { ExtensionState } from '../src/extensionState';
import { Logger } from '../src/logger';
import { GitExecutable } from '../src/utils';
import { EventEmitter } from '../src/utils/event';

import { waitForExpect } from './helpers/expectations';

let onDidChangeConfiguration: EventEmitter<ConfigurationChangeEvent>;
let onDidChangeGitExecutable: EventEmitter<GitExecutable>;
let logger: Logger;
let dataSource: DataSource;
let extensionState: ExtensionState;
let spyOnSaveAvatar: jest.SpyInstance, spyOnRemoveAvatarFromCache: jest.SpyInstance, spyOnHttpsGet: jest.SpyInstance, spyOnWriteFile: jest.SpyInstance, spyOnReadFile: jest.SpyInstance, spyOnLog: jest.SpyInstance, spyOnGetRemoteUrl: jest.SpyInstance;

beforeAll(() => {
	onDidChangeConfiguration = new EventEmitter<ConfigurationChangeEvent>();
	onDidChangeGitExecutable = new EventEmitter<GitExecutable>();
	logger = new Logger();
	dataSource = new DataSource(null, onDidChangeConfiguration.subscribe, onDidChangeGitExecutable.subscribe, logger);
	extensionState = new ExtensionState(vscode.mocks.extensionContext, onDidChangeGitExecutable.subscribe);
	spyOnSaveAvatar = jest.spyOn(extensionState, 'saveAvatar');
	spyOnRemoveAvatarFromCache = jest.spyOn(extensionState, 'removeAvatarFromCache');
	spyOnHttpsGet = jest.spyOn(https, 'get');
	spyOnWriteFile = jest.spyOn(fs, 'writeFile');
	spyOnReadFile = jest.spyOn(fs, 'readFile');
	spyOnLog = jest.spyOn(logger, 'log');
	spyOnGetRemoteUrl = jest.spyOn(dataSource, 'getRemoteUrl');
});

afterAll(() => {
	extensionState.dispose();
	dataSource.dispose();
	logger.dispose();
	onDidChangeConfiguration.dispose();
	onDidChangeGitExecutable.dispose();
});

describe('AvatarManager', () => {
	let avatarManager: AvatarManager;
	beforeEach(() => {
		jest.spyOn(extensionState, 'getAvatarStoragePath').mockReturnValueOnce('/path/to/avatars');
		jest.spyOn(extensionState, 'getAvatarCache').mockReturnValueOnce({
			'user1@example.com': {
				image: '111d68d06e2d317b5a59c2c6c5bad808.png',
				timestamp: date.now * 1000,
				identicon: false
			},
			'user2@example.com': {
				image: 'ab53a2911ddf9b4817ac01ddcd3d975f.png',
				timestamp: date.now * 1000 - 1209600001,
				identicon: false
			},
			'user3@example.com': {
				image: '97d6d9441ff85fdc730e02a6068d267b.png',
				timestamp: date.now * 1000 - 345600001,
				identicon: true
			}
		});
		avatarManager = new AvatarManager(dataSource, extensionState, logger);
		jest.clearAllTimers();
		jest.useRealTimers();
	});
	afterEach(() => {
		avatarManager.dispose();
	});

	it('Should construct an AvatarManager, and be disposed', () => {
		// Assert
		expect(avatarManager['disposables']).toHaveLength(2);

		// Run
		avatarManager.dispose();

		// Assert
		expect(avatarManager['disposables']).toHaveLength(0);
	});

	describe('fetchAvatarImage', () => {
		it('Should trigger the avatar to be emitted when a known avatar is fetched', async () => {
			// Setup
			mockReadFile('binary-image-data');
			const avatarEvents = waitForEvents(avatarManager, 1);

			// Run
			avatarManager.fetchAvatarImage('user1@example.com', 'test-repo', 'test-remote', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);

			// Assert
			expect(await avatarEvents).toStrictEqual([{
				email: 'user1@example.com',
				image: 'data:image/png;base64,YmluYXJ5LWltYWdlLWRhdGE='
			}]);
		});

		describe('GitHub', () => {
			it('Should fetch a new avatar from GitHub (HTTPS Remote)', async () => {
				// Setup
				spyOnGetRemoteUrl.mockResolvedValueOnce('https://github.com/example/test-repo.git');
				mockHttpsResponse(200, '{"author":{"avatar_url":"https://avatar-url/u/1?v=4"}}');
				mockHttpsResponse(200, 'binary-image-data');
				mockWriteFile(null);
				mockReadFile('binary-image-data');
				const avatarEvents = waitForEvents(avatarManager, 1);

				// Run
				avatarManager.fetchAvatarImage('user4@example.com', 'test-repo', 'test-remote', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);

				// Assert
				expect(await avatarEvents).toStrictEqual([{
					email: 'user4@example.com',
					image: 'data:image/png;base64,YmluYXJ5LWltYWdlLWRhdGE='
				}]);
				expect(spyOnGetRemoteUrl).toHaveBeenCalledWith('test-repo', 'test-remote');
				expect(spyOnHttpsGet).toHaveBeenCalledWith({
					hostname: 'api.github.com',
					path: '/repos/example/test-repo/commits/1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					headers: { 'User-Agent': 'vscode-git-tree' },
					agent: false,
					timeout: 15000
				}, expect.anything());
				expect(spyOnHttpsGet).toHaveBeenCalledWith({
					hostname: 'avatar-url',
					path: '/u/1?v=4&size=162',
					headers: { 'User-Agent': 'vscode-git-tree' },
					agent: false,
					timeout: 15000
				}, expect.anything());
				expectFileToHaveBeenWritten('/path/to/avatars/7e65550957227bd38fe2d7fbc6fd2f7b.png', 'binary-image-data');
				expectFileToHaveBeenRead('/path/to/avatars/7e65550957227bd38fe2d7fbc6fd2f7b.png');
				expect(spyOnSaveAvatar).toHaveBeenCalledWith('user4@example.com', {
					image: '7e65550957227bd38fe2d7fbc6fd2f7b.png',
					timestamp: 1587559258000,
					identicon: false
				});
			});

			it('Should fetch a new avatar from GitHub (SSH Remote)', async () => {
				// Setup
				spyOnGetRemoteUrl.mockResolvedValueOnce('git@github.com:example/test-repo.git');
				mockHttpsResponse(200, '{"author":{"avatar_url":"https://avatar-url/u/1?v=4"}}');
				mockHttpsResponse(200, 'binary-image-data');
				mockWriteFile(null);
				mockReadFile('binary-image-data');
				const avatarEvents = waitForEvents(avatarManager, 1);

				// Run
				avatarManager.fetchAvatarImage('user4@example.com', 'test-repo', 'test-remote', [
					'1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					'2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c',
					'3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d',
					'4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e',
					'5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f',
					'6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a',
					'1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					'2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c'
				]);

				// Assert
				expect(await avatarEvents).toStrictEqual([{
					email: 'user4@example.com',
					image: 'data:image/png;base64,YmluYXJ5LWltYWdlLWRhdGE='
				}]);
				expect(spyOnGetRemoteUrl).toHaveBeenCalledWith('test-repo', 'test-remote');
				expect(spyOnHttpsGet).toHaveBeenCalledWith({
					hostname: 'api.github.com',
					path: '/repos/example/test-repo/commits/2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c',
					headers: { 'User-Agent': 'vscode-git-tree' },
					agent: false,
					timeout: 15000
				}, expect.anything());
				expect(spyOnHttpsGet).toHaveBeenCalledWith({
					hostname: 'avatar-url',
					path: '/u/1?v=4&size=162',
					headers: { 'User-Agent': 'vscode-git-tree' },
					agent: false,
					timeout: 15000
				}, expect.anything());
				expectFileToHaveBeenWritten('/path/to/avatars/7e65550957227bd38fe2d7fbc6fd2f7b.png', 'binary-image-data');
				expectFileToHaveBeenRead('/path/to/avatars/7e65550957227bd38fe2d7fbc6fd2f7b.png');
				expect(spyOnSaveAvatar).toHaveBeenCalledWith('user4@example.com', {
					image: '7e65550957227bd38fe2d7fbc6fd2f7b.png',
					timestamp: 1587559258000,
					identicon: false
				});
			});

			it('Should fallback to Gravatar when there is no avatar_url are in the GitHub response', async () => {
				// Setup
				spyOnGetRemoteUrl.mockResolvedValueOnce('https://github.com/example/test-repo.git');
				mockHttpsResponse(200, '{"author":{}}');
				mockHttpsResponse(200, 'binary-image-data');
				mockWriteFile(null);
				mockReadFile('binary-image-data');
				const avatarEvents = waitForEvents(avatarManager, 1);

				// Run
				avatarManager.fetchAvatarImage('user4@example.com', 'test-repo', 'test-remote', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);

				// Assert
				expect(await avatarEvents).toStrictEqual([{
					email: 'user4@example.com',
					image: 'data:image/png;base64,YmluYXJ5LWltYWdlLWRhdGE='
				}]);
				expect(spyOnGetRemoteUrl).toHaveBeenCalledWith('test-repo', 'test-remote');
				expect(spyOnHttpsGet).toHaveBeenCalledWith({
					hostname: 'api.github.com',
					path: '/repos/example/test-repo/commits/1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					headers: { 'User-Agent': 'vscode-git-tree' },
					agent: false,
					timeout: 15000
				}, expect.anything());
				expect(spyOnHttpsGet).toHaveBeenCalledWith({
					hostname: 'secure.gravatar.com',
					path: '/avatar/7e65550957227bd38fe2d7fbc6fd2f7b?s=162&d=404',
					headers: { 'User-Agent': 'vscode-git-tree' },
					agent: false,
					timeout: 15000
				}, expect.anything());
				expectFileToHaveBeenWritten('/path/to/avatars/7e65550957227bd38fe2d7fbc6fd2f7b.png', 'binary-image-data');
				expectFileToHaveBeenRead('/path/to/avatars/7e65550957227bd38fe2d7fbc6fd2f7b.png');
				expect(spyOnSaveAvatar).toHaveBeenCalledWith('user4@example.com', {
					image: '7e65550957227bd38fe2d7fbc6fd2f7b.png',
					timestamp: 1587559258000,
					identicon: false
				});
			});

			it('Should fallback to Gravatar when an unexpected status code is received from the GitHub API', async () => {
				// Setup
				spyOnGetRemoteUrl.mockResolvedValueOnce('https://github.com/example/test-repo.git');
				mockHttpsResponse(401, '');
				mockHttpsResponse(200, 'binary-image-data');
				mockWriteFile(null);
				mockReadFile('binary-image-data');
				const avatarEvents = waitForEvents(avatarManager, 1);

				// Run
				avatarManager.fetchAvatarImage('user4@example.com', 'test-repo', 'test-remote', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);

				// Assert
				expect(await avatarEvents).toStrictEqual([{
					email: 'user4@example.com',
					image: 'data:image/png;base64,YmluYXJ5LWltYWdlLWRhdGE='
				}]);
				expect(spyOnGetRemoteUrl).toHaveBeenCalledWith('test-repo', 'test-remote');
				expect(spyOnHttpsGet).toHaveBeenCalledWith({
					hostname: 'api.github.com',
					path: '/repos/example/test-repo/commits/1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					headers: { 'User-Agent': 'vscode-git-tree' },
					agent: false,
					timeout: 15000
				}, expect.anything());
				expect(spyOnHttpsGet).toHaveBeenCalledWith({
					hostname: 'secure.gravatar.com',
					path: '/avatar/7e65550957227bd38fe2d7fbc6fd2f7b?s=162&d=404',
					headers: { 'User-Agent': 'vscode-git-tree' },
					agent: false,
					timeout: 15000
				}, expect.anything());
				expectFileToHaveBeenWritten('/path/to/avatars/7e65550957227bd38fe2d7fbc6fd2f7b.png', 'binary-image-data');
				expectFileToHaveBeenRead('/path/to/avatars/7e65550957227bd38fe2d7fbc6fd2f7b.png');
				expect(spyOnSaveAvatar).toHaveBeenCalledWith('user4@example.com', {
					image: '7e65550957227bd38fe2d7fbc6fd2f7b.png',
					timestamp: 1587559258000,
					identicon: false
				});
			});

			it('Should halt fetching the avatar when the GitHub avatar url request is unsuccessful', async () => {
				// Setup
				spyOnGetRemoteUrl.mockResolvedValueOnce('https://github.com/example/test-repo.git');
				mockHttpsResponse(200, '{"author":{"avatar_url":"https://avatar-url/u/1?v=4"}}');
				mockHttpsResponse(404, '');

				// Run
				avatarManager.fetchAvatarImage('user4@example.com', 'test-repo', 'test-remote', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);

				// Assert
				await waitForExpect(() => {
					expect(spyOnLog).toHaveBeenCalledWith('Failed to download avatar from GitHub for user4@*****');
				});
				expect(spyOnGetRemoteUrl).toHaveBeenCalledWith('test-repo', 'test-remote');
				expect(spyOnHttpsGet).toHaveBeenCalledWith({
					hostname: 'api.github.com',
					path: '/repos/example/test-repo/commits/1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
					headers: { 'User-Agent': 'vscode-git-tree' },
					agent: false,
					timeout: 15000
				}, expect.anything());
				expect(spyOnHttpsGet).toHaveBeenCalledWith({
					hostname: 'avatar-url',
					path: '/u/1?v=4&size=162',
					headers: { 'User-Agent': 'vscode-git-tree' },
					agent: false,
					timeout: 15000
				}, expect.anything());
			});

			it('Should requeue the request when the GitHub API cannot find the commit', async () => {
				// Setup
				spyOnGetRemoteUrl.mockResolvedValueOnce('https://github.com/example/test-repo.git');
				mockHttpsResponse(422, '', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': (date.now + 1).toString() });

				// Run
				avatarManager.fetchAvatarImage('user4@example.com', 'test-repo', 'test-remote', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', '2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c']);

				// Assert
				await waitForExpect(() => {
					expect(avatarManager['queue']['queue'].length).toBe(1);
					expect(avatarManager['queue']['queue'][0].attempts).toBe(1);
				});
				expect(avatarManager['queue']['queue']).toStrictEqual([
					{
						email: 'user4@example.com',
						repo: 'test-repo',
						remote: 'test-remote',
						commits: [
							'1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
							'2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c'
						],
						checkAfter: 0,
						attempts: 1
					}
				]);
			});

			it('Should set the GitHub API timeout and requeue the request when the rate limit is reached', async () => {
				// Setup
				spyOnGetRemoteUrl.mockResolvedValueOnce('https://github.com/example/test-repo.git');
				mockHttpsResponse(403, '', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': (date.now + 1).toString() });

				// Run
				avatarManager.fetchAvatarImage('user4@example.com', 'test-repo', 'test-remote', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);

				// Assert
				await waitForExpect(() => {
					expect(spyOnLog).toHaveBeenCalledWith('GitHub API Rate Limit Reached - Paused fetching from GitHub until the Rate Limit is reset');
				});
				expect(avatarManager['queue']['queue']).toStrictEqual([
					{
						email: 'user4@example.com',
						repo: 'test-repo',
						remote: 'test-remote',
						commits: ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b'],
						checkAfter: (date.now + 1) * 1000,
						attempts: 0
					}
				]);
				expect(avatarManager['githubTimeout']).toBe(1587559259000);
			});

			it('Should set the GitHub API timeout and requeue the request when the API returns a 5xx error', async () => {
				// Setup
				spyOnGetRemoteUrl.mockResolvedValueOnce('https://github.com/example/test-repo.git');
				mockHttpsResponse(500, '');

				// Run
				avatarManager.fetchAvatarImage('user4@example.com', 'test-repo', 'test-remote', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);

				// Assert
				await waitForExpect(() => {
					expect(avatarManager['githubTimeout']).toBe(date.now * 1000 + 600000);
				});
				expect(avatarManager['queue']['queue']).toStrictEqual([
					{
						email: 'user4@example.com',
						repo: 'test-repo',
						remote: 'test-remote',
						commits: ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b'],
						checkAfter: date.now * 1000 + 600000,
						attempts: 0
					}
				]);
			});

			it('Should set the GitHub API timeout and requeue the request when there is an HTTPS Client Request Error', async () => {
				// Setup
				spyOnGetRemoteUrl.mockResolvedValueOnce('https://github.com/example/test-repo.git');
				mockHttpsClientRequestErrorEvent();

				// Run
				avatarManager.fetchAvatarImage('user4@example.com', 'test-repo', 'test-remote', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);

				// Assert
				await waitForExpect(() => {
					expect(avatarManager['githubTimeout']).toBe(date.now * 1000 + 300000);
				});
				expect(avatarManager['queue']['queue']).toStrictEqual([
					{
						email: 'user4@example.com',
						repo: 'test-repo',
						remote: 'test-remote',
						commits: ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b'],
						checkAfter: date.now * 1000 + 300000,
						attempts: 0
					}
				]);
			});

			it('Should set the GitHub API timeout and requeue the request when there is an HTTPS Incoming Message Error', async () => {
				// Setup
				spyOnGetRemoteUrl.mockResolvedValueOnce('https://github.com/example/test-repo.git');
				mockHttpsIncomingMessageErrorEvent();

				// Run
				avatarManager.fetchAvatarImage('user4@example.com', 'test-repo', 'test-remote', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);

				// Assert
				await waitForExpect(() => {
					expect(avatarManager['githubTimeout']).toBe(date.now * 1000 + 300000);
				});
				expect(avatarManager['queue']['queue']).toStrictEqual([
					{
						email: 'user4@example.com',
						repo: 'test-repo',
						remote: 'test-remote',
						commits: ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b'],
						checkAfter: date.now * 1000 + 300000,
						attempts: 0
					}
				]);
			});

			it('Should set the GitHub API timeout and requeue the request once when there are multiple HTTPS Error Events', async () => {
				// Setup
				spyOnGetRemoteUrl.mockResolvedValueOnce('https://github.com/example/test-repo.git');
				mockHttpsMultipleErrorEvents();

				// Run
				avatarManager.fetchAvatarImage('user4@example.com', 'test-repo', 'test-remote', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);

				// Assert
				await waitForExpect(() => {
					expect(avatarManager['githubTimeout']).toBe(date.now * 1000 + 300000);
				});
				expect(avatarManager['queue']['queue']).toStrictEqual([
					{
						email: 'user4@example.com',
						repo: 'test-repo',
						remote: 'test-remote',
						commits: ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b'],
						checkAfter: date.now * 1000 + 300000,
						attempts: 0
					}
				]);
			});

			it('Should requeue the request when it\'s before the GitHub API timeout', async () => {
				// Setup
				spyOnGetRemoteUrl.mockResolvedValueOnce('https://github.com/example/test-repo.git');
				avatarManager['githubTimeout'] = (date.now + 1) * 1000;

				// Run
				avatarManager.fetchAvatarImage('user4@example.com', 'test-repo', 'test-remote', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);

				// Assert
				await waitForExpect(() => {
					expect(avatarManager['queue']['queue']).toStrictEqual([
						{
							email: 'user4@example.com',
							repo: 'test-repo',
							remote: 'test-remote',
							commits: ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b'],
							checkAfter: 1587559259000,
							attempts: 0
						}
					]);
				});
			});
		});

		describe('GitLab', () => {
			it('Should fetch a new avatar from GitLab (HTTPS Remote)', async () => {
				// Setup
				spyOnGetRemoteUrl.mockResolvedValueOnce('https://gitlab.com/example/test-repo.git');
				mockHttpsResponse(200, '[{"avatar_url":"https://avatar-url"}]');
				mockHttpsResponse(200, 'binary-image-data');
				mockWriteFile(null);
				mockReadFile('binary-image-data');
				const avatarEvents = waitForEvents(avatarManager, 1);

				// Run
				avatarManager.fetchAvatarImage('user4@example.com', 'test-repo', 'test-remote', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);

				// Assert
				expect(await avatarEvents).toStrictEqual([{
					email: 'user4@example.com',
					image: 'data:image/png;base64,YmluYXJ5LWltYWdlLWRhdGE='
				}]);
				expect(spyOnGetRemoteUrl).toHaveBeenCalledWith('test-repo', 'test-remote');
				expect(spyOnHttpsGet).toHaveBeenCalledWith({
					hostname: 'gitlab.com',
					path: '/api/v4/users?search=user4@example.com',
					headers: { 'User-Agent': 'vscode-git-tree' },
					agent: false,
					timeout: 15000
				}, expect.anything());
				expect(spyOnHttpsGet).toHaveBeenCalledWith({
					hostname: 'avatar-url',
					path: '/',
					headers: { 'User-Agent': 'vscode-git-tree' },
					agent: false,
					timeout: 15000
				}, expect.anything());
				expectFileToHaveBeenWritten('/path/to/avatars/7e65550957227bd38fe2d7fbc6fd2f7b.png', 'binary-image-data');
				expectFileToHaveBeenRead('/path/to/avatars/7e65550957227bd38fe2d7fbc6fd2f7b.png');
				expect(spyOnSaveAvatar).toHaveBeenCalledWith('user4@example.com', {
					image: '7e65550957227bd38fe2d7fbc6fd2f7b.png',
					timestamp: 1587559258000,
					identicon: false
				});
			});

			it('Should fetch a new avatar from GitLab (SSH Remote)', async () => {
				// Setup
				spyOnGetRemoteUrl.mockResolvedValueOnce('git@gitlab.com:example/test-repo.git');
				mockHttpsResponse(200, '[{"avatar_url":"https://avatar-url"}]');
				mockHttpsResponse(200, 'binary-image-data');
				mockWriteFile(null);
				mockReadFile('binary-image-data');
				const avatarEvents = waitForEvents(avatarManager, 1);

				// Run
				avatarManager.fetchAvatarImage('user4@example.com', 'test-repo', 'test-remote', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);

				// Assert
				expect(await avatarEvents).toStrictEqual([{
					email: 'user4@example.com',
					image: 'data:image/png;base64,YmluYXJ5LWltYWdlLWRhdGE='
				}]);
				expect(spyOnGetRemoteUrl).toHaveBeenCalledWith('test-repo', 'test-remote');
				expect(spyOnHttpsGet).toHaveBeenCalledWith({
					hostname: 'gitlab.com',
					path: '/api/v4/users?search=user4@example.com',
					headers: { 'User-Agent': 'vscode-git-tree' },
					agent: false,
					timeout: 15000
				}, expect.anything());
				expect(spyOnHttpsGet).toHaveBeenCalledWith({
					hostname: 'avatar-url',
					path: '/',
					headers: { 'User-Agent': 'vscode-git-tree' },
					agent: false,
					timeout: 15000
				}, expect.anything());
				expectFileToHaveBeenWritten('/path/to/avatars/7e65550957227bd38fe2d7fbc6fd2f7b.png', 'binary-image-data');
				expectFileToHaveBeenRead('/path/to/avatars/7e65550957227bd38fe2d7fbc6fd2f7b.png');
				expect(spyOnSaveAvatar).toHaveBeenCalledWith('user4@example.com', {
					image: '7e65550957227bd38fe2d7fbc6fd2f7b.png',
					timestamp: 1587559258000,
					identicon: false
				});
			});

			it('Should fallback to Gravatar when no users are in the GitLab response', async () => {
				// Setup
				spyOnGetRemoteUrl.mockResolvedValueOnce('https://gitlab.com/example/test-repo.git');
				mockHttpsResponse(200, '[]');
				mockHttpsResponse(200, 'binary-image-data');
				mockWriteFile(null);
				mockReadFile('binary-image-data');
				const avatarEvents = waitForEvents(avatarManager, 1);

				// Run
				avatarManager.fetchAvatarImage('user4@example.com', 'test-repo', 'test-remote', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);

				// Assert
				expect(await avatarEvents).toStrictEqual([{
					email: 'user4@example.com',
					image: 'data:image/png;base64,YmluYXJ5LWltYWdlLWRhdGE='
				}]);
				expect(spyOnGetRemoteUrl).toHaveBeenCalledWith('test-repo', 'test-remote');
				expect(spyOnHttpsGet).toHaveBeenCalledWith({
					hostname: 'gitlab.com',
					path: '/api/v4/users?search=user4@example.com',
					headers: { 'User-Agent': 'vscode-git-tree' },
					agent: false,
					timeout: 15000
				}, expect.anything());
				expect(spyOnHttpsGet).toHaveBeenCalledWith({
					hostname: 'secure.gravatar.com',
					path: '/avatar/7e65550957227bd38fe2d7fbc6fd2f7b?s=162&d=404',
					headers: { 'User-Agent': 'vscode-git-tree' },
					agent: false,
					timeout: 15000
				}, expect.anything());
				expectFileToHaveBeenWritten('/path/to/avatars/7e65550957227bd38fe2d7fbc6fd2f7b.png', 'binary-image-data');
				expectFileToHaveBeenRead('/path/to/avatars/7e65550957227bd38fe2d7fbc6fd2f7b.png');
				expect(spyOnSaveAvatar).toHaveBeenCalledWith('user4@example.com', {
					image: '7e65550957227bd38fe2d7fbc6fd2f7b.png',
					timestamp: 1587559258000,
					identicon: false
				});
			});

			it('Should fallback to Gravatar when an unexpected status code is received from the GitLab API', async () => {
				// Setup
				spyOnGetRemoteUrl.mockResolvedValueOnce('https://gitlab.com/example/test-repo.git');
				mockHttpsResponse(401, '');
				mockHttpsResponse(200, 'binary-image-data');
				mockWriteFile(null);
				mockReadFile('binary-image-data');
				const avatarEvents = waitForEvents(avatarManager, 1);

				// Run
				avatarManager.fetchAvatarImage('user4@example.com', 'test-repo', 'test-remote', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);

				// Assert
				expect(await avatarEvents).toStrictEqual([{
					email: 'user4@example.com',
					image: 'data:image/png;base64,YmluYXJ5LWltYWdlLWRhdGE='
				}]);
				expect(spyOnGetRemoteUrl).toHaveBeenCalledWith('test-repo', 'test-remote');
				expect(spyOnHttpsGet).toHaveBeenCalledWith({
					hostname: 'gitlab.com',
					path: '/api/v4/users?search=user4@example.com',
					headers: { 'User-Agent': 'vscode-git-tree' },
					agent: false,
					timeout: 15000
				}, expect.anything());
				expect(spyOnHttpsGet).toHaveBeenCalledWith({
					hostname: 'secure.gravatar.com',
					path: '/avatar/7e65550957227bd38fe2d7fbc6fd2f7b?s=162&d=404',
					headers: { 'User-Agent': 'vscode-git-tree' },
					agent: false,
					timeout: 15000
				}, expect.anything());
				expectFileToHaveBeenWritten('/path/to/avatars/7e65550957227bd38fe2d7fbc6fd2f7b.png', 'binary-image-data');
				expectFileToHaveBeenRead('/path/to/avatars/7e65550957227bd38fe2d7fbc6fd2f7b.png');
				expect(spyOnSaveAvatar).toHaveBeenCalledWith('user4@example.com', {
					image: '7e65550957227bd38fe2d7fbc6fd2f7b.png',
					timestamp: 1587559258000,
					identicon: false
				});
			});

			it('Should halt fetching the avatar when the GitLab avatar url request is unsuccessful', async () => {
				// Setup
				spyOnGetRemoteUrl.mockResolvedValueOnce('https://gitlab.com/example/test-repo.git');
				mockHttpsResponse(200, '[{"avatar_url":"https://avatar-url"}]');
				mockHttpsResponse(404, '');

				// Run
				avatarManager.fetchAvatarImage('user4@example.com', 'test-repo', 'test-remote', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);

				// Assert
				await waitForExpect(() => {
					expect(spyOnLog).toHaveBeenCalledWith('Failed to download avatar from GitLab for user4@*****');
				});
				expect(spyOnGetRemoteUrl).toHaveBeenCalledWith('test-repo', 'test-remote');
				expect(spyOnHttpsGet).toHaveBeenCalledWith({
					hostname: 'gitlab.com',
					path: '/api/v4/users?search=user4@example.com',
					headers: { 'User-Agent': 'vscode-git-tree' },
					agent: false,
					timeout: 15000
				}, expect.anything());
				expect(spyOnHttpsGet).toHaveBeenCalledWith({
					hostname: 'avatar-url',
					path: '/',
					headers: { 'User-Agent': 'vscode-git-tree' },
					agent: false,
					timeout: 15000
				}, expect.anything());
			});

			it('Should set the GitLab API timeout and requeue the request when the rate limit is reached', async () => {
				// Setup
				spyOnGetRemoteUrl.mockResolvedValueOnce('https://gitlab.com/example/test-repo.git');
				mockHttpsResponse(429, '', { 'ratelimit-remaining': '0', 'ratelimit-reset': (date.now + 1).toString() });

				// Run
				avatarManager.fetchAvatarImage('user4@example.com', 'test-repo', 'test-remote', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);

				// Assert
				await waitForExpect(() => {
					expect(spyOnLog).toHaveBeenCalledWith('GitLab API Rate Limit Reached - Paused fetching from GitLab until the Rate Limit is reset');
				});
				expect(avatarManager['queue']['queue']).toStrictEqual([
					{
						email: 'user4@example.com',
						repo: 'test-repo',
						remote: 'test-remote',
						commits: ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b'],
						checkAfter: (date.now + 1) * 1000,
						attempts: 0
					}
				]);
				expect(avatarManager['gitLabTimeout']).toBe(1587559259000);
			});

			it('Should set the GitLab API timeout and requeue the request when the API returns a 5xx error', async () => {
				// Setup
				spyOnGetRemoteUrl.mockResolvedValueOnce('https://gitlab.com/example/test-repo.git');
				mockHttpsResponse(500, '');

				// Run
				avatarManager.fetchAvatarImage('user4@example.com', 'test-repo', 'test-remote', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);

				// Assert
				await waitForExpect(() => {
					expect(avatarManager['gitLabTimeout']).toBe(date.now * 1000 + 600000);
				});
				expect(avatarManager['queue']['queue']).toStrictEqual([
					{
						email: 'user4@example.com',
						repo: 'test-repo',
						remote: 'test-remote',
						commits: ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b'],
						checkAfter: date.now * 1000 + 600000,
						attempts: 0
					}
				]);
			});

			it('Should set the GitLab API timeout and requeue the request when there is an HTTPS Client Request Error', async () => {
				// Setup
				spyOnGetRemoteUrl.mockResolvedValueOnce('https://gitlab.com/example/test-repo.git');
				mockHttpsClientRequestErrorEvent();

				// Run
				avatarManager.fetchAvatarImage('user4@example.com', 'test-repo', 'test-remote', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);

				// Assert
				await waitForExpect(() => {
					expect(avatarManager['gitLabTimeout']).toBe(date.now * 1000 + 300000);
				});
				expect(avatarManager['queue']['queue']).toStrictEqual([
					{
						email: 'user4@example.com',
						repo: 'test-repo',
						remote: 'test-remote',
						commits: ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b'],
						checkAfter: date.now * 1000 + 300000,
						attempts: 0
					}
				]);
			});

			it('Should set the GitLab API timeout and requeue the request when there is an HTTPS Incoming Message Error', async () => {
				// Setup
				spyOnGetRemoteUrl.mockResolvedValueOnce('https://gitlab.com/example/test-repo.git');
				mockHttpsIncomingMessageErrorEvent();

				// Run
				avatarManager.fetchAvatarImage('user4@example.com', 'test-repo', 'test-remote', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);

				// Assert
				await waitForExpect(() => {
					expect(avatarManager['gitLabTimeout']).toBe(date.now * 1000 + 300000);
				});
				expect(avatarManager['queue']['queue']).toStrictEqual([
					{
						email: 'user4@example.com',
						repo: 'test-repo',
						remote: 'test-remote',
						commits: ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b'],
						checkAfter: date.now * 1000 + 300000,
						attempts: 0
					}
				]);
			});

			it('Should set the GitLab API timeout and requeue the request once when there are multiple HTTPS Error Events', async () => {
				// Setup
				spyOnGetRemoteUrl.mockResolvedValueOnce('https://gitlab.com/example/test-repo.git');
				mockHttpsMultipleErrorEvents();

				// Run
				avatarManager.fetchAvatarImage('user4@example.com', 'test-repo', 'test-remote', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);

				// Assert
				await waitForExpect(() => {
					expect(avatarManager['gitLabTimeout']).toBe(date.now * 1000 + 300000);
				});
				expect(avatarManager['queue']['queue']).toStrictEqual([
					{
						email: 'user4@example.com',
						repo: 'test-repo',
						remote: 'test-remote',
						commits: ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b'],
						checkAfter: date.now * 1000 + 300000,
						attempts: 0
					}
				]);
			});

			it('Should requeue the request when it\'s before the GitLab API timeout', async () => {
				// Setup
				spyOnGetRemoteUrl.mockResolvedValueOnce('https://gitlab.com/example/test-repo.git');
				avatarManager['gitLabTimeout'] = (date.now + 1) * 1000;

				// Run
				avatarManager.fetchAvatarImage('user4@example.com', 'test-repo', 'test-remote', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);

				// Assert
				await waitForExpect(() => {
					expect(avatarManager['queue']['queue']).toStrictEqual([
						{
							email: 'user4@example.com',
							repo: 'test-repo',
							remote: 'test-remote',
							commits: ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b'],
							checkAfter: 1587559259000,
							attempts: 0
						}
					]);
				});
			});
		});

		describe('Gravatar', () => {
			it('Should fetch a new avatar from Gravatar', async () => {
				// Setup
				spyOnGetRemoteUrl.mockResolvedValueOnce(null);
				mockHttpsResponse(200, 'binary-image-data');
				mockWriteFile(null);
				mockReadFile('binary-image-data');
				const avatarEvents = waitForEvents(avatarManager, 1);

				// Run
				avatarManager.fetchAvatarImage('user4@example.com', 'test-repo', 'test-remote', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);

				// Assert
				expect(await avatarEvents).toStrictEqual([{
					email: 'user4@example.com',
					image: 'data:image/png;base64,YmluYXJ5LWltYWdlLWRhdGE='
				}]);
				await waitForExpect(() => {
					expect(spyOnLog).toHaveBeenCalledWith('Saved Avatar for user4@*****');
					expect(spyOnLog).toHaveBeenCalledWith('Sent Avatar for user4@***** to the Git Tree View');
				});
				expect(spyOnGetRemoteUrl).toHaveBeenCalledWith('test-repo', 'test-remote');
				expect(spyOnHttpsGet).toHaveBeenCalledWith({
					hostname: 'secure.gravatar.com',
					path: '/avatar/7e65550957227bd38fe2d7fbc6fd2f7b?s=162&d=404',
					headers: { 'User-Agent': 'vscode-git-tree' },
					agent: false,
					timeout: 15000
				}, expect.anything());
				expectFileToHaveBeenWritten('/path/to/avatars/7e65550957227bd38fe2d7fbc6fd2f7b.png', 'binary-image-data');
				expectFileToHaveBeenRead('/path/to/avatars/7e65550957227bd38fe2d7fbc6fd2f7b.png');
				expect(spyOnSaveAvatar).toHaveBeenCalledWith('user4@example.com', {
					image: '7e65550957227bd38fe2d7fbc6fd2f7b.png',
					timestamp: 1587559258000,
					identicon: false
				});
				expect(spyOnGetRemoteUrl).toHaveBeenCalledWith('test-repo', 'test-remote');
				expect(spyOnHttpsGet).toHaveBeenCalledWith({
					hostname: 'secure.gravatar.com',
					path: '/avatar/7e65550957227bd38fe2d7fbc6fd2f7b?s=162&d=404',
					headers: { 'User-Agent': 'vscode-git-tree' },
					agent: false,
					timeout: 15000
				}, expect.anything());
				expectFileToHaveBeenWritten('/path/to/avatars/7e65550957227bd38fe2d7fbc6fd2f7b.png', 'binary-image-data');
				expectFileToHaveBeenRead('/path/to/avatars/7e65550957227bd38fe2d7fbc6fd2f7b.png');
				expect(spyOnSaveAvatar).toHaveBeenCalledWith('user4@example.com', {
					image: '7e65550957227bd38fe2d7fbc6fd2f7b.png',
					timestamp: 1587559258000,
					identicon: false
				});
			});

			it('Should fetch an identicon if no avatar can be found on Gravatar', async () => {
				// Setup
				spyOnGetRemoteUrl.mockResolvedValueOnce(null);
				mockHttpsResponse(404, '');
				mockHttpsResponse(200, 'binary-image-data');
				mockWriteFile(null);
				mockReadFile('binary-image-data');
				const avatarEvents = waitForEvents(avatarManager, 1);

				// Run
				avatarManager.fetchAvatarImage('user4@example.com', 'test-repo', 'test-remote', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);

				// Assert
				expect(await avatarEvents).toStrictEqual([{
					email: 'user4@example.com',
					image: 'data:image/png;base64,YmluYXJ5LWltYWdlLWRhdGE='
				}]);
				expect(spyOnGetRemoteUrl).toHaveBeenCalledWith('test-repo', 'test-remote');
				expect(spyOnHttpsGet).toHaveBeenCalledWith({
					hostname: 'secure.gravatar.com',
					path: '/avatar/7e65550957227bd38fe2d7fbc6fd2f7b?s=162&d=404',
					headers: { 'User-Agent': 'vscode-git-tree' },
					agent: false,
					timeout: 15000
				}, expect.anything());
				expect(spyOnHttpsGet).toHaveBeenCalledWith({
					hostname: 'secure.gravatar.com',
					path: '/avatar/7e65550957227bd38fe2d7fbc6fd2f7b?s=162&d=identicon',
					headers: { 'User-Agent': 'vscode-git-tree' },
					agent: false,
					timeout: 15000
				}, expect.anything());
				expectFileToHaveBeenWritten('/path/to/avatars/7e65550957227bd38fe2d7fbc6fd2f7b.png', 'binary-image-data');
				expectFileToHaveBeenRead('/path/to/avatars/7e65550957227bd38fe2d7fbc6fd2f7b.png');
				expect(spyOnSaveAvatar).toHaveBeenCalledWith('user4@example.com', {
					image: '7e65550957227bd38fe2d7fbc6fd2f7b.png',
					timestamp: 1587559258000,
					identicon: true
				});
			});

			it('Should not save an avatar if it cannot be fetched from Gravatar', async () => {
				// Setup
				spyOnGetRemoteUrl.mockResolvedValueOnce(null);
				mockHttpsResponse(404, '');
				mockHttpsResponse(500, '');

				// Run
				avatarManager.fetchAvatarImage('user4@example.com', 'test-repo', 'test-remote', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);

				// Assert
				await waitForExpect(() => {
					expect(spyOnLog).toHaveBeenCalledWith('No Avatar could be found for user4@*****');
				});
				expect(spyOnGetRemoteUrl).toHaveBeenCalledWith('test-repo', 'test-remote');
				expect(spyOnHttpsGet).toHaveBeenCalledWith({
					hostname: 'secure.gravatar.com',
					path: '/avatar/7e65550957227bd38fe2d7fbc6fd2f7b?s=162&d=404',
					headers: { 'User-Agent': 'vscode-git-tree' },
					agent: false,
					timeout: 15000
				}, expect.anything());
				expect(spyOnHttpsGet).toHaveBeenCalledWith({
					hostname: 'secure.gravatar.com',
					path: '/avatar/7e65550957227bd38fe2d7fbc6fd2f7b?s=162&d=identicon',
					headers: { 'User-Agent': 'vscode-git-tree' },
					agent: false,
					timeout: 15000
				}, expect.anything());
			});

			it('Should fetch an avatar from Gravatar when no remote is specified', async () => {
				// Setup
				mockHttpsResponse(200, 'binary-image-data');
				mockWriteFile(null);
				mockReadFile('binary-image-data');
				const avatarEvents = waitForEvents(avatarManager, 1);

				// Run
				avatarManager.fetchAvatarImage('user4@example.com', 'test-repo', null, ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);

				// Assert
				expect(await avatarEvents).toStrictEqual([{
					email: 'user4@example.com',
					image: 'data:image/png;base64,YmluYXJ5LWltYWdlLWRhdGE='
				}]);
				expect(spyOnGetRemoteUrl).not.toHaveBeenCalled();
				expect(spyOnHttpsGet).toHaveBeenCalledWith({
					hostname: 'secure.gravatar.com',
					path: '/avatar/7e65550957227bd38fe2d7fbc6fd2f7b?s=162&d=404',
					headers: { 'User-Agent': 'vscode-git-tree' },
					agent: false,
					timeout: 15000
				}, expect.anything());
				expectFileToHaveBeenWritten('/path/to/avatars/7e65550957227bd38fe2d7fbc6fd2f7b.png', 'binary-image-data');
				expectFileToHaveBeenRead('/path/to/avatars/7e65550957227bd38fe2d7fbc6fd2f7b.png');
				expect(spyOnSaveAvatar).toHaveBeenCalledWith('user4@example.com', {
					image: '7e65550957227bd38fe2d7fbc6fd2f7b.png',
					timestamp: 1587559258000,
					identicon: false
				});
			});

			it('Should fetch an avatar from Gravatar when the remote hostname is not GitHub or GitLab', async () => {
				// Setup
				spyOnGetRemoteUrl.mockResolvedValueOnce('http://other-host/example/test-repo.git');
				mockHttpsResponse(200, 'binary-image-data');
				mockWriteFile(null);
				mockReadFile('binary-image-data');
				const avatarEvents = waitForEvents(avatarManager, 1);

				// Run
				avatarManager.fetchAvatarImage('user4@example.com', 'test-repo', 'test-remote', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);

				// Assert
				expect(await avatarEvents).toStrictEqual([{
					email: 'user4@example.com',
					image: 'data:image/png;base64,YmluYXJ5LWltYWdlLWRhdGE='
				}]);
				expect(spyOnGetRemoteUrl).toHaveBeenCalledWith('test-repo', 'test-remote');
				expect(spyOnHttpsGet).toHaveBeenCalledWith({
					hostname: 'secure.gravatar.com',
					path: '/avatar/7e65550957227bd38fe2d7fbc6fd2f7b?s=162&d=404',
					headers: { 'User-Agent': 'vscode-git-tree' },
					agent: false,
					timeout: 15000
				}, expect.anything());
				expectFileToHaveBeenWritten('/path/to/avatars/7e65550957227bd38fe2d7fbc6fd2f7b.png', 'binary-image-data');
				expectFileToHaveBeenRead('/path/to/avatars/7e65550957227bd38fe2d7fbc6fd2f7b.png');
				expect(spyOnSaveAvatar).toHaveBeenCalledWith('user4@example.com', {
					image: '7e65550957227bd38fe2d7fbc6fd2f7b.png',
					timestamp: 1587559258000,
					identicon: false
				});
			});

			it('Should fetch an identicon the avatar fails to be saved', async () => {
				// Setup
				spyOnGetRemoteUrl.mockResolvedValueOnce(null);
				mockHttpsResponse(200, 'binary-image-data');
				mockWriteFile(new Error());
				mockHttpsResponse(200, 'binary-image-data');
				mockWriteFile(null);
				mockReadFile('binary-image-data');
				const avatarEvents = waitForEvents(avatarManager, 1);

				// Run
				avatarManager.fetchAvatarImage('user4@example.com', 'test-repo', 'test-remote', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);

				// Assert
				expect(await avatarEvents).toStrictEqual([{
					email: 'user4@example.com',
					image: 'data:image/png;base64,YmluYXJ5LWltYWdlLWRhdGE='
				}]);
				expect(spyOnGetRemoteUrl).toHaveBeenCalledWith('test-repo', 'test-remote');
				expect(spyOnHttpsGet).toHaveBeenCalledWith({
					hostname: 'secure.gravatar.com',
					path: '/avatar/7e65550957227bd38fe2d7fbc6fd2f7b?s=162&d=404',
					headers: { 'User-Agent': 'vscode-git-tree' },
					agent: false,
					timeout: 15000
				}, expect.anything());
				expect(spyOnHttpsGet).toHaveBeenCalledWith({
					hostname: 'secure.gravatar.com',
					path: '/avatar/7e65550957227bd38fe2d7fbc6fd2f7b?s=162&d=identicon',
					headers: { 'User-Agent': 'vscode-git-tree' },
					agent: false,
					timeout: 15000
				}, expect.anything());
				expectFileToHaveBeenWritten('/path/to/avatars/7e65550957227bd38fe2d7fbc6fd2f7b.png', 'binary-image-data');
				expectFileToHaveBeenRead('/path/to/avatars/7e65550957227bd38fe2d7fbc6fd2f7b.png');
				expect(spyOnSaveAvatar).toHaveBeenCalledWith('user4@example.com', {
					image: '7e65550957227bd38fe2d7fbc6fd2f7b.png',
					timestamp: 1587559258000,
					identicon: true
				});
			});

			it('Should fetch an identicon if the first avatar request receives an HTTPS Client Request Error', async () => {
				// Setup
				spyOnGetRemoteUrl.mockResolvedValueOnce(null);
				mockHttpsClientRequestErrorEvent();
				mockHttpsResponse(200, 'binary-image-data');
				mockWriteFile(null);
				mockReadFile('binary-image-data');
				const avatarEvents = waitForEvents(avatarManager, 1);

				// Run
				avatarManager.fetchAvatarImage('user4@example.com', 'test-repo', 'test-remote', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);

				// Assert
				expect(await avatarEvents).toStrictEqual([{
					email: 'user4@example.com',
					image: 'data:image/png;base64,YmluYXJ5LWltYWdlLWRhdGE='
				}]);
				expect(spyOnGetRemoteUrl).toHaveBeenCalledWith('test-repo', 'test-remote');
				expect(spyOnHttpsGet).toHaveBeenCalledWith({
					hostname: 'secure.gravatar.com',
					path: '/avatar/7e65550957227bd38fe2d7fbc6fd2f7b?s=162&d=404',
					headers: { 'User-Agent': 'vscode-git-tree' },
					agent: false,
					timeout: 15000
				}, expect.anything());
				expect(spyOnHttpsGet).toHaveBeenCalledWith({
					hostname: 'secure.gravatar.com',
					path: '/avatar/7e65550957227bd38fe2d7fbc6fd2f7b?s=162&d=identicon',
					headers: { 'User-Agent': 'vscode-git-tree' },
					agent: false,
					timeout: 15000
				}, expect.anything());
				expectFileToHaveBeenWritten('/path/to/avatars/7e65550957227bd38fe2d7fbc6fd2f7b.png', 'binary-image-data');
				expectFileToHaveBeenRead('/path/to/avatars/7e65550957227bd38fe2d7fbc6fd2f7b.png');
				expect(spyOnSaveAvatar).toHaveBeenCalledWith('user4@example.com', {
					image: '7e65550957227bd38fe2d7fbc6fd2f7b.png',
					timestamp: 1587559258000,
					identicon: true
				});
			});

			it('Should fetch an identicon if the first avatar request receives an HTTPS Incoming Message Error', async () => {
				// Setup
				spyOnGetRemoteUrl.mockResolvedValueOnce(null);
				mockHttpsIncomingMessageErrorEvent();
				mockHttpsResponse(200, 'binary-image-data');
				mockWriteFile(null);
				mockReadFile('binary-image-data');
				const avatarEvents = waitForEvents(avatarManager, 1);

				// Run
				avatarManager.fetchAvatarImage('user4@example.com', 'test-repo', 'test-remote', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);

				// Assert
				expect(await avatarEvents).toStrictEqual([{
					email: 'user4@example.com',
					image: 'data:image/png;base64,YmluYXJ5LWltYWdlLWRhdGE='
				}]);
				expect(spyOnGetRemoteUrl).toHaveBeenCalledWith('test-repo', 'test-remote');
				expect(spyOnHttpsGet).toHaveBeenCalledWith({
					hostname: 'secure.gravatar.com',
					path: '/avatar/7e65550957227bd38fe2d7fbc6fd2f7b?s=162&d=404',
					headers: { 'User-Agent': 'vscode-git-tree' },
					agent: false,
					timeout: 15000
				}, expect.anything());
				expect(spyOnHttpsGet).toHaveBeenCalledWith({
					hostname: 'secure.gravatar.com',
					path: '/avatar/7e65550957227bd38fe2d7fbc6fd2f7b?s=162&d=identicon',
					headers: { 'User-Agent': 'vscode-git-tree' },
					agent: false,
					timeout: 15000
				}, expect.anything());
				expectFileToHaveBeenWritten('/path/to/avatars/7e65550957227bd38fe2d7fbc6fd2f7b.png', 'binary-image-data');
				expectFileToHaveBeenRead('/path/to/avatars/7e65550957227bd38fe2d7fbc6fd2f7b.png');
				expect(spyOnSaveAvatar).toHaveBeenCalledWith('user4@example.com', {
					image: '7e65550957227bd38fe2d7fbc6fd2f7b.png',
					timestamp: 1587559258000,
					identicon: true
				});
			});

			it('Should fetch an identicon once if the first avatar request receives multiple HTTPS Error Events', async () => {
				// Setup
				spyOnGetRemoteUrl.mockResolvedValueOnce(null);
				mockHttpsMultipleErrorEvents();
				mockHttpsResponse(200, 'binary-image-data');
				mockWriteFile(null);
				mockReadFile('binary-image-data');
				const avatarEvents = waitForEvents(avatarManager, 1);

				// Run
				avatarManager.fetchAvatarImage('user4@example.com', 'test-repo', 'test-remote', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);

				// Assert
				expect(await avatarEvents).toStrictEqual([{
					email: 'user4@example.com',
					image: 'data:image/png;base64,YmluYXJ5LWltYWdlLWRhdGE='
				}]);
				expect(spyOnGetRemoteUrl).toHaveBeenCalledWith('test-repo', 'test-remote');
				expect(spyOnHttpsGet).toHaveBeenCalledWith({
					hostname: 'secure.gravatar.com',
					path: '/avatar/7e65550957227bd38fe2d7fbc6fd2f7b?s=162&d=404',
					headers: { 'User-Agent': 'vscode-git-tree' },
					agent: false,
					timeout: 15000
				}, expect.anything());
				expect(spyOnHttpsGet).toHaveBeenCalledWith({
					hostname: 'secure.gravatar.com',
					path: '/avatar/7e65550957227bd38fe2d7fbc6fd2f7b?s=162&d=identicon',
					headers: { 'User-Agent': 'vscode-git-tree' },
					agent: false,
					timeout: 15000
				}, expect.anything());
				expectFileToHaveBeenWritten('/path/to/avatars/7e65550957227bd38fe2d7fbc6fd2f7b.png', 'binary-image-data');
				expectFileToHaveBeenRead('/path/to/avatars/7e65550957227bd38fe2d7fbc6fd2f7b.png');
				expect(spyOnSaveAvatar).toHaveBeenCalledTimes(1);
				expect(spyOnSaveAvatar).toHaveBeenCalledWith('user4@example.com', {
					image: '7e65550957227bd38fe2d7fbc6fd2f7b.png',
					timestamp: 1587559258000,
					identicon: true
				});
			});

			it('Should fetch an identicon the first avatar HTTPS request throws an expected exception', async () => {
				// Setup
				spyOnGetRemoteUrl.mockResolvedValueOnce(null);
				spyOnHttpsGet.mockImplementationOnce(() => {
					throw new Error();
				});
				mockHttpsResponse(200, 'binary-image-data');
				mockWriteFile(null);
				mockReadFile('binary-image-data');
				const avatarEvents = waitForEvents(avatarManager, 1);

				// Run
				avatarManager.fetchAvatarImage('user4@example.com', 'test-repo', 'test-remote', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);

				// Assert
				expect(await avatarEvents).toStrictEqual([{
					email: 'user4@example.com',
					image: 'data:image/png;base64,YmluYXJ5LWltYWdlLWRhdGE='
				}]);
				expect(spyOnGetRemoteUrl).toHaveBeenCalledWith('test-repo', 'test-remote');
				expect(spyOnHttpsGet).toHaveBeenCalledWith({
					hostname: 'secure.gravatar.com',
					path: '/avatar/7e65550957227bd38fe2d7fbc6fd2f7b?s=162&d=404',
					headers: { 'User-Agent': 'vscode-git-tree' },
					agent: false,
					timeout: 15000
				}, expect.anything());
				expect(spyOnHttpsGet).toHaveBeenCalledWith({
					hostname: 'secure.gravatar.com',
					path: '/avatar/7e65550957227bd38fe2d7fbc6fd2f7b?s=162&d=identicon',
					headers: { 'User-Agent': 'vscode-git-tree' },
					agent: false,
					timeout: 15000
				}, expect.anything());
				expectFileToHaveBeenWritten('/path/to/avatars/7e65550957227bd38fe2d7fbc6fd2f7b.png', 'binary-image-data');
				expectFileToHaveBeenRead('/path/to/avatars/7e65550957227bd38fe2d7fbc6fd2f7b.png');
				expect(spyOnSaveAvatar).toHaveBeenCalledWith('user4@example.com', {
					image: '7e65550957227bd38fe2d7fbc6fd2f7b.png',
					timestamp: 1587559258000,
					identicon: true
				});
			});
		});

		it('Should fetch an avatar when the existing avatar is over 14 days old', async () => {
			// Setup
			spyOnGetRemoteUrl.mockResolvedValueOnce(null);
			mockReadFile('binary-image-data');
			mockHttpsResponse(200, 'new-binary-image-data');
			mockWriteFile(null);
			mockReadFile('new-binary-image-data');
			const avatarEvents = waitForEvents(avatarManager, 2);

			// Run
			avatarManager.fetchAvatarImage('user2@example.com', 'test-repo', 'test-remote', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);

			// Assert
			expect(await avatarEvents).toStrictEqual([
				{
					email: 'user2@example.com',
					image: 'data:image/png;base64,YmluYXJ5LWltYWdlLWRhdGE='
				},
				{
					email: 'user2@example.com',
					image: 'data:image/png;base64,bmV3LWJpbmFyeS1pbWFnZS1kYXRh'
				}
			]);
			expect(spyOnGetRemoteUrl).toHaveBeenCalledWith('test-repo', 'test-remote');
			expect(spyOnHttpsGet).toHaveBeenCalledWith({
				hostname: 'secure.gravatar.com',
				path: '/avatar/ab53a2911ddf9b4817ac01ddcd3d975f?s=162&d=404',
				headers: { 'User-Agent': 'vscode-git-tree' },
				agent: false,
				timeout: 15000
			}, expect.anything());
			expectFileToHaveBeenWritten('/path/to/avatars/ab53a2911ddf9b4817ac01ddcd3d975f.png', 'new-binary-image-data');
			expectFileToHaveBeenRead('/path/to/avatars/ab53a2911ddf9b4817ac01ddcd3d975f.png');
			expect(spyOnSaveAvatar).toHaveBeenCalledWith('user2@example.com', {
				image: 'ab53a2911ddf9b4817ac01ddcd3d975f.png',
				timestamp: 1587559258000,
				identicon: false
			});
		});

		it('Shouldn\'t replace the existing avatar if it wasn\'t an identicon and the new avatar is', async () => {
			// Setup
			spyOnGetRemoteUrl.mockResolvedValueOnce(null);
			mockReadFile('binary-image-data');
			mockHttpsResponse(404, 'new-binary-image-data');
			mockHttpsResponse(200, 'new-binary-image-data');
			mockWriteFile(null);
			mockReadFile('new-binary-image-data');
			const avatarEvents = waitForEvents(avatarManager, 2);

			// Run
			avatarManager.fetchAvatarImage('user2@example.com', 'test-repo', 'test-remote', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);

			// Assert
			expect(await avatarEvents).toStrictEqual([
				{
					email: 'user2@example.com',
					image: 'data:image/png;base64,YmluYXJ5LWltYWdlLWRhdGE='
				},
				{
					email: 'user2@example.com',
					image: 'data:image/png;base64,bmV3LWJpbmFyeS1pbWFnZS1kYXRh'
				}
			]);
			expect(spyOnGetRemoteUrl).toHaveBeenCalledWith('test-repo', 'test-remote');
			expect(spyOnHttpsGet).toHaveBeenCalledWith({
				hostname: 'secure.gravatar.com',
				path: '/avatar/ab53a2911ddf9b4817ac01ddcd3d975f?s=162&d=404',
				headers: { 'User-Agent': 'vscode-git-tree' },
				agent: false,
				timeout: 15000
			}, expect.anything());
			expectFileToHaveBeenWritten('/path/to/avatars/ab53a2911ddf9b4817ac01ddcd3d975f.png', 'new-binary-image-data');
			expectFileToHaveBeenRead('/path/to/avatars/ab53a2911ddf9b4817ac01ddcd3d975f.png');
			expect(spyOnSaveAvatar).toHaveBeenCalledWith('user2@example.com', {
				image: 'ab53a2911ddf9b4817ac01ddcd3d975f.png',
				timestamp: 1587559258000,
				identicon: false
			});
		});

		it('Should fetch an avatar when the existing identicon is over 4 days old', async () => {
			// Setup
			spyOnGetRemoteUrl.mockResolvedValueOnce(null);
			mockReadFile('binary-image-data');
			mockHttpsResponse(200, 'new-binary-image-data');
			mockWriteFile(null);
			mockReadFile('new-binary-image-data');
			const avatarEvents = waitForEvents(avatarManager, 2);

			// Run
			avatarManager.fetchAvatarImage('user3@example.com', 'test-repo', 'test-remote', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);

			// Assert
			expect(await avatarEvents).toStrictEqual([
				{
					email: 'user3@example.com',
					image: 'data:image/png;base64,YmluYXJ5LWltYWdlLWRhdGE='
				},
				{
					email: 'user3@example.com',
					image: 'data:image/png;base64,bmV3LWJpbmFyeS1pbWFnZS1kYXRh'
				}
			]);
			expect(spyOnGetRemoteUrl).toHaveBeenCalledWith('test-repo', 'test-remote');
			expect(spyOnHttpsGet).toHaveBeenCalledWith({
				hostname: 'secure.gravatar.com',
				path: '/avatar/97d6d9441ff85fdc730e02a6068d267b?s=162&d=404',
				headers: { 'User-Agent': 'vscode-git-tree' },
				agent: false,
				timeout: 15000
			}, expect.anything());
			expectFileToHaveBeenWritten('/path/to/avatars/97d6d9441ff85fdc730e02a6068d267b.png', 'new-binary-image-data');
			expectFileToHaveBeenRead('/path/to/avatars/97d6d9441ff85fdc730e02a6068d267b.png');
			expect(spyOnSaveAvatar).toHaveBeenCalledWith('user3@example.com', {
				image: '97d6d9441ff85fdc730e02a6068d267b.png',
				timestamp: 1587559258000,
				identicon: false
			});
		});

		it('Should fetch multiple avatars', async () => {
			// Setup
			spyOnGetRemoteUrl.mockResolvedValueOnce(null);
			jest.useFakeTimers();
			mockHttpsResponse(200, 'binary-image-data-one');
			mockWriteFile(null);
			mockReadFile('binary-image-data-one');
			mockHttpsResponse(200, 'binary-image-data-two');
			mockWriteFile(null);
			mockReadFile('binary-image-data-two');
			const avatarEvents = waitForEvents(avatarManager, 2, true);

			// Run
			avatarManager.fetchAvatarImage('user4@example.com', 'test-repo', 'test-remote', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);
			avatarManager.fetchAvatarImage('user5@example.com', 'test-repo', 'test-remote', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);

			// Assert
			expect(await avatarEvents).toStrictEqual([
				{
					email: 'user4@example.com',
					image: 'data:image/png;base64,YmluYXJ5LWltYWdlLWRhdGEtb25l'
				},
				{
					email: 'user5@example.com',
					image: 'data:image/png;base64,YmluYXJ5LWltYWdlLWRhdGEtdHdv'
				}
			]);
			expect(spyOnGetRemoteUrl).toHaveBeenCalledWith('test-repo', 'test-remote');
			expect(spyOnHttpsGet).toHaveBeenCalledWith({
				hostname: 'secure.gravatar.com',
				path: '/avatar/7e65550957227bd38fe2d7fbc6fd2f7b?s=162&d=404',
				headers: { 'User-Agent': 'vscode-git-tree' },
				agent: false,
				timeout: 15000
			}, expect.anything());
			expectFileToHaveBeenWritten('/path/to/avatars/7e65550957227bd38fe2d7fbc6fd2f7b.png', 'binary-image-data-one');
			expectFileToHaveBeenRead('/path/to/avatars/7e65550957227bd38fe2d7fbc6fd2f7b.png');
			expect(spyOnSaveAvatar).toHaveBeenCalledWith('user4@example.com', {
				image: '7e65550957227bd38fe2d7fbc6fd2f7b.png',
				timestamp: 1587559258000,
				identicon: false
			});
			expect(spyOnHttpsGet).toHaveBeenCalledWith({
				hostname: 'secure.gravatar.com',
				path: '/avatar/cfa35b8cd2ec278026357769582fa563?s=162&d=404',
				headers: { 'User-Agent': 'vscode-git-tree' },
				agent: false,
				timeout: 15000
			}, expect.anything());
			expectFileToHaveBeenWritten('/path/to/avatars/cfa35b8cd2ec278026357769582fa563.png', 'binary-image-data-two');
			expectFileToHaveBeenRead('/path/to/avatars/cfa35b8cd2ec278026357769582fa563.png');
			expect(spyOnSaveAvatar).toHaveBeenCalledWith('user5@example.com', {
				image: 'cfa35b8cd2ec278026357769582fa563.png',
				timestamp: 1587559258000,
				identicon: false
			});
		});

		it('Should fetch a new avatar when the existing image can\'t be read', async () => {
			// Setup
			spyOnGetRemoteUrl.mockResolvedValueOnce(null);
			mockReadFile(null);
			mockHttpsResponse(200, 'binary-image-data');
			mockWriteFile(null);
			mockReadFile('binary-image-data');
			const avatarEvents = waitForEvents(avatarManager, 1);

			// Run
			avatarManager.fetchAvatarImage('user1@example.com', 'test-repo', 'test-remote', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);

			// Assert
			expect(await avatarEvents).toStrictEqual([{
				email: 'user1@example.com',
				image: 'data:image/png;base64,YmluYXJ5LWltYWdlLWRhdGE='
			}]);
			expect(spyOnGetRemoteUrl).toHaveBeenCalledWith('test-repo', 'test-remote');
			expect(spyOnRemoveAvatarFromCache).toHaveBeenCalledWith('user1@example.com');
			expect(spyOnHttpsGet).toHaveBeenCalledWith({
				hostname: 'secure.gravatar.com',
				path: '/avatar/111d68d06e2d317b5a59c2c6c5bad808?s=162&d=404',
				headers: { 'User-Agent': 'vscode-git-tree' },
				agent: false,
				timeout: 15000
			}, expect.anything());
			expectFileToHaveBeenWritten('/path/to/avatars/111d68d06e2d317b5a59c2c6c5bad808.png', 'binary-image-data');
			expectFileToHaveBeenRead('/path/to/avatars/111d68d06e2d317b5a59c2c6c5bad808.png');
			expect(spyOnSaveAvatar).toHaveBeenCalledWith('user1@example.com', {
				image: '111d68d06e2d317b5a59c2c6c5bad808.png',
				timestamp: 1587559258000,
				identicon: false
			});
		});

		it('Should fetch a new avatar, but not send it to the Git Tree View', async () => {
			// Setup
			spyOnGetRemoteUrl.mockResolvedValueOnce(null);
			mockHttpsResponse(200, 'binary-image-data');
			mockWriteFile(null);
			mockReadFile(null);
			avatarManager.onAvatar(() => { });

			// Run
			avatarManager.fetchAvatarImage('user4@example.com', 'test-repo', 'test-remote', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);

			// Assert
			await waitForExpect(() => {
				expect(spyOnLog).toHaveBeenCalledWith('Saved Avatar for user4@*****');
				expect(spyOnLog).toHaveBeenCalledWith('Failed to Send Avatar for user4@***** to the Git Tree View');
			});
			expect(spyOnGetRemoteUrl).toHaveBeenCalledWith('test-repo', 'test-remote');
			expect(spyOnHttpsGet).toHaveBeenCalledWith({
				hostname: 'secure.gravatar.com',
				path: '/avatar/7e65550957227bd38fe2d7fbc6fd2f7b?s=162&d=404',
				headers: { 'User-Agent': 'vscode-git-tree' },
				agent: false,
				timeout: 15000
			}, expect.anything());
			expectFileToHaveBeenWritten('/path/to/avatars/7e65550957227bd38fe2d7fbc6fd2f7b.png', 'binary-image-data');
			expect(spyOnSaveAvatar).toHaveBeenCalledWith('user4@example.com', {
				image: '7e65550957227bd38fe2d7fbc6fd2f7b.png',
				timestamp: 1587559258000,
				identicon: false
			});
		});

		it('Should fetch a new avatar, and log when it fails to send it to the Git Tree View', async () => {
			// Setup
			spyOnGetRemoteUrl.mockResolvedValueOnce(null);
			mockHttpsResponse(200, 'binary-image-data');
			mockWriteFile(null);

			// Run
			avatarManager.fetchAvatarImage('user4@example.com', 'test-repo', 'test-remote', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);

			// Assert
			await waitForExpect(() => {
				expect(spyOnLog).toHaveBeenCalledWith('Saved Avatar for user4@*****');
				expect(spyOnLog).toHaveBeenCalledWith('Avatar for user4@***** is ready to be used the next time the Git Tree View is opened');
			});
			expect(spyOnGetRemoteUrl).toHaveBeenCalledWith('test-repo', 'test-remote');
			expect(spyOnHttpsGet).toHaveBeenCalledWith({
				hostname: 'secure.gravatar.com',
				path: '/avatar/7e65550957227bd38fe2d7fbc6fd2f7b?s=162&d=404',
				headers: { 'User-Agent': 'vscode-git-tree' },
				agent: false,
				timeout: 15000
			}, expect.anything());
			expectFileToHaveBeenWritten('/path/to/avatars/7e65550957227bd38fe2d7fbc6fd2f7b.png', 'binary-image-data');
			expect(spyOnSaveAvatar).toHaveBeenCalledWith('user4@example.com', {
				image: '7e65550957227bd38fe2d7fbc6fd2f7b.png',
				timestamp: 1587559258000,
				identicon: false
			});
		});

		it('Should add new commits to existing records queued for the same user in the same repository', async () => {
			// Setup
			spyOnGetRemoteUrl.mockResolvedValueOnce('https://github.com/example/test-repo.git');
			mockHttpsResponse(403, '', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': (date.now + 1).toString() });

			// Run
			avatarManager.fetchAvatarImage('user4@example.com', 'test-repo', 'test-remote', [
				'1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
				'3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d',
				'5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f'
			]);

			// Assert
			await waitForExpect(() => {
				expect(spyOnLog).toHaveBeenCalledWith('GitHub API Rate Limit Reached - Paused fetching from GitHub until the Rate Limit is reset');
			});

			// Run
			avatarManager.fetchAvatarImage('user4@example.com', 'test-repo', 'test-remote', [
				'1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
				'2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c',
				'3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d',
				'4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e'
			]);

			// Assert
			expect(avatarManager['queue']['queue']).toStrictEqual([
				{
					email: 'user4@example.com',
					repo: 'test-repo',
					remote: 'test-remote',
					commits: [
						'1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
						'3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d',
						'5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f',
						'2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c',
						'4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e'
					],
					checkAfter: (date.now + 1) * 1000,
					attempts: 0
				}
			]);
			expect(avatarManager['githubTimeout']).toBe(1587559259000);
		});

		it('Should insert requests into the priority queue in the correct order', async () => {
			// Setup
			spyOnGetRemoteUrl.mockResolvedValueOnce('https://github.com/example/test-repo.git');
			mockHttpsResponse(403, '', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': (date.now + 1).toString() });

			// Run
			avatarManager.fetchAvatarImage('user4@example.com', 'test-repo', 'test-remote', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);

			// Assert
			await waitForExpect(() => {
				expect(spyOnLog).toHaveBeenCalledWith('GitHub API Rate Limit Reached - Paused fetching from GitHub until the Rate Limit is reset');
			});

			// Run
			avatarManager.fetchAvatarImage('user2@example.com', 'test-repo', 'test-remote', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);
			avatarManager.fetchAvatarImage('user5@example.com', 'test-repo', 'test-remote', ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b']);

			// Assert
			expect(avatarManager['queue']['queue']).toStrictEqual([
				{
					email: 'user5@example.com',
					repo: 'test-repo',
					remote: 'test-remote',
					commits: ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b'],
					checkAfter: 0,
					attempts: 0
				},
				{
					email: 'user4@example.com',
					repo: 'test-repo',
					remote: 'test-remote',
					commits: ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b'],
					checkAfter: (date.now + 1) * 1000,
					attempts: 0
				},
				{
					email: 'user2@example.com',
					repo: 'test-repo',
					remote: 'test-remote',
					commits: ['1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b'],
					checkAfter: (date.now + 1) * 1000 + 1,
					attempts: 0
				}
			]);
		});
	});

	describe('getAvatarImage', () => {
		it('Should return a Data Url of the avatar\'s image data', async () => {
			// Setup
			mockReadFile('binary-image-data');

			// Run
			const avatar = await avatarManager.getAvatarImage('user1@example.com');

			// Assert
			expect(avatar).toBe('data:image/png;base64,YmluYXJ5LWltYWdlLWRhdGE=');
			expectFileToHaveBeenRead('/path/to/avatars/111d68d06e2d317b5a59c2c6c5bad808.png');
		});

		it('Should return null when the avatar file could not be read from the file system', async () => {
			// Setup
			mockReadFile(null);

			// Run
			const avatar = await avatarManager.getAvatarImage('user1@example.com');

			// Assert
			expect(avatar).toBe(null);
			expectFileToHaveBeenRead('/path/to/avatars/111d68d06e2d317b5a59c2c6c5bad808.png');
		});

		it('Should return null when no avatar exists for the provided email address', async () => {
			// Run
			const avatar = await avatarManager.getAvatarImage('user4@example.com');

			// Assert
			expect(avatar).toBe(null);
			expect(spyOnReadFile).not.toHaveBeenCalled();
		});
	});

	describe('clearCache', () => {
		let spyOnClearAvatarCache: jest.SpyInstance;
		beforeAll(() => {
			spyOnClearAvatarCache = jest.spyOn(extensionState, 'clearAvatarCache');
		});

		it('Should clear the cache of avatars', async () => {
			// Setup
			spyOnClearAvatarCache.mockResolvedValueOnce(null);

			// Run
			const result = await avatarManager.clearCache();

			// Assert
			expect(result).toBeNull();
			expect(avatarManager['avatars']).toStrictEqual({});
			expect(spyOnClearAvatarCache).toHaveBeenCalledTimes(1);
		});

		it('Should return the error message returned by ExtensionState.clearAvatarCache', async () => {
			// Setup
			const errorMessage = 'Visual Studio Code was unable to save the Git Tree Global State Memento.';
			spyOnClearAvatarCache.mockResolvedValueOnce(errorMessage);

			// Run
			const result = await avatarManager.clearCache();

			// Assert
			expect(result).toBe(errorMessage);
			expect(avatarManager['avatars']).toStrictEqual({});
			expect(spyOnClearAvatarCache).toHaveBeenCalledTimes(1);
		});
	});
});

function mockHttpsResponse(statusCode: number, imageData: string, headers: { [header: string]: string } = {}) {
	spyOnHttpsGet.mockImplementationOnce((_: string | https.RequestOptions | URL, callback: (res: IncomingMessage) => void): ClientRequest => {
		if (callback) {
			const callbacks: { [event: string]: (...args: any) => void } = {};
			const message: IncomingMessage = <any>{
				statusCode: statusCode,
				headers: Object.assign({
					'content-type': 'image/png'
				}, headers),
				on: (event: string, listener: () => void) => {
					callbacks[event] = listener;
					return message;
				}
			};
			callback(message);
			callbacks['data'](Buffer.from(imageData));
			callbacks['end']();
		}
		return ({
			on: jest.fn()
		}) as any as ClientRequest;
	});
}

function mockHttpsClientRequestErrorEvent() {
	spyOnHttpsGet.mockImplementationOnce((_1: string | https.RequestOptions | URL, _2: (res: IncomingMessage) => void): ClientRequest => {
		const request: ClientRequest = <any>{
			on: (event: string, callback: () => void) => {
				if (event === 'error') {
					callback();
				}
				return request;
			}
		};
		return request;
	});
}

function mockHttpsIncomingMessageErrorEvent() {
	spyOnHttpsGet.mockImplementationOnce((_: string | https.RequestOptions | URL, callback: (res: IncomingMessage) => void): ClientRequest => {
		const callbacks: { [event: string]: (...args: any) => void } = {};
		const message: IncomingMessage = <any>{
			on: (event: string, listener: () => void) => {
				callbacks[event] = listener;
				return message;
			}
		};
		callback(message);
		callbacks['error']();
		return ({
			on: jest.fn()
		}) as any as ClientRequest;
	});
}

function mockHttpsMultipleErrorEvents() {
	spyOnHttpsGet.mockImplementationOnce((_: string | https.RequestOptions | URL, callback: (res: IncomingMessage) => void): ClientRequest => {
		const callbacks: { [event: string]: (...args: any) => void } = {};
		const message: IncomingMessage = <any>{
			on: (event: string, listener: () => void) => {
				callbacks[event] = listener;
				return message;
			}
		};
		callback(message);
		callbacks['error']();

		const request: ClientRequest = <any>{
			on: (event: string, callback: () => void) => {
				if (event === 'error') {
					callback();
				}
				return request;
			}
		};
		return request;
	});
}

function mockWriteFile(error: NodeJS.ErrnoException | null) {
	spyOnWriteFile.mockImplementationOnce((_1: fs.PathLike | number, _2: Buffer, callback: (err: NodeJS.ErrnoException | null) => void) => callback(error));
}

function mockReadFile(data: string | null) {
	spyOnReadFile.mockImplementationOnce((_: fs.PathLike | number, callback: (err: NodeJS.ErrnoException | null, _: Buffer) => void) => {
		if (data) {
			callback(null, Buffer.from(data));
		} else {
			callback(new Error(), Buffer.alloc(0));
		}
	});
}

function expectFileToHaveBeenWritten(name: string, data: string) {
	expect(spyOnWriteFile.mock.calls.some((args) => args[0] === name && args[1].toString() === data)).toBe(true);
}

function expectFileToHaveBeenRead(name: string) {
	expect(spyOnReadFile.mock.calls.some((args) => args[0] === name)).toBe(true);
}

function waitForEvents(avatarManager: AvatarManager, n: number, runPendingTimers = false) {
	return new Promise<AvatarEvent[]>((resolve) => {
		const events: AvatarEvent[] = [];
		avatarManager.onAvatar((event) => {
			events.push(event);
			if (runPendingTimers) {
				jest.runOnlyPendingTimers();
			}
			if (events.length === n) {
				resolve(events);
			}
		});
	});
}
