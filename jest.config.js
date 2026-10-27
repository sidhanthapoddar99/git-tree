module.exports = {
	roots: ['./tests'],
	transform: {
		'^.+\\.ts$': ['ts-jest', { tsconfig: './tests/tsconfig.json' }]
	},
	testRegex: '\\.test\\.ts$',
	// The engine's differential tests use real Git, and run with jest.engine.config.js. The remote hosts' end-to-end tests
	// use real SSH and Git against a test server, and run with jest.remote.config.js.
	testPathIgnorePatterns: ['/node_modules/', '<rootDir>/tests/engine/', '<rootDir>/tests/remote/'],
	fakeTimers: { legacyFakeTimers: true },
	moduleFileExtensions: ['ts', 'js'],
	collectCoverageFrom: [
		'src/utils/*.ts',
		'src/*.ts'
	]
};
