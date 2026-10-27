// The remote hosts' end-to-end tests: real SSH and Git against a test SSH server, which the header of
// tests/remote/remoteHosts.test.ts describes. They run only with this configuration (npm run test-remote), and are
// skipped without the server's SSH configuration.
const base = require('./jest.config');

module.exports = Object.assign({}, base, {
	roots: ['./tests/remote'],
	testPathIgnorePatterns: ['/node_modules/'],
	// An empty home folder for Git, set before Jest starts its workers, as for the engine's tests
	globalSetup: './tests/engine/home-setup.js',
	globalTeardown: './tests/engine/home-teardown.js',
	testTimeout: 120000
});
