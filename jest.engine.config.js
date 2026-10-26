// The engine's differential tests: each engine read against the Git CLI read, on real repositories.
// They need the engine built (npm run build-engine), and are skipped without it.
const base = require('./jest.config');

module.exports = Object.assign({}, base, {
	roots: ['./tests/engine'],
	testPathIgnorePatterns: ['/node_modules/'],
	testTimeout: 600000
});
