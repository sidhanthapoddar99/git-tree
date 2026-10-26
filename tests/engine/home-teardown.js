// Remove the home folder that home-setup.js made.
const fs = require('fs');

module.exports = async () => {
	if (process.env.GIT_TREE_ENGINE_TEST_HOME) {
		fs.rmSync(process.env.GIT_TREE_ENGINE_TEST_HOME, { recursive: true, force: true });
	}
};
