// Give the engine's tests an empty home folder, so the machine's global Git configuration doesn't change what they
// read. Git and the engine must read the same one: Git gets the environment of each test file's process.env, but the
// engine reads the environment of the process, which Jest's copy of process.env in a test file doesn't change. So it
// is set here, before Jest starts its workers, which inherit it.
const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = async () => {
	const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-tree-engine-home-')));
	fs.mkdirSync(path.join(home, '.config'));
	process.env.HOME = home;
	process.env.XDG_CONFIG_HOME = path.join(home, '.config');
	process.env.GIT_TREE_ENGINE_TEST_HOME = home;
};
