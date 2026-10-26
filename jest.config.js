module.exports = {
	roots: ['./tests'],
	transform: {
		'^.+\\.ts$': ['ts-jest', { tsconfig: './tests/tsconfig.json' }]
	},
	testRegex: '\\.test\\.ts$',
	fakeTimers: { legacyFakeTimers: true },
	moduleFileExtensions: ['ts', 'js'],
	collectCoverageFrom: [
		'src/utils/*.ts',
		'src/*.ts'
	]
};
