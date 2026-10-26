// The engine's differential tests: each engine read against the Git CLI read, on real repositories.
// They need the engine built (npm run build-engine), and are skipped without it.
const base = require('./jest.config');

module.exports = Object.assign({}, base, {
	roots: ['./tests/engine'],
	testPathIgnorePatterns: ['/node_modules/'],
	// An empty home folder for Git and the engine, set before Jest starts its workers
	globalSetup: './tests/engine/home-setup.js',
	globalTeardown: './tests/engine/home-teardown.js',
	testTimeout: 600000
});
