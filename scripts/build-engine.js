// Builds the Rust engine (native/) and places its Node-API module where src/engine.ts loads it:
// native/bin/git-tree-engine.<platform>.node, for example git-tree-engine.linux-x64-gnu.node.
//
// Usage: node scripts/build-engine.js [--debug]
//   --debug   build without optimisations, which is faster to build (for working on the engine)
//
// npm run build-engine compiles src/ first, because the platform name comes from out/engine.js, the
// same code that loads the module. Cargo runs at most 4 jobs (CARGO_BUILD_JOBS), so the machine stays usable.
//
// On glibc Linux it builds with cargo-zigbuild against glibc 2.28, the oldest glibc Visual Studio Code supports.
// A module built against the build machine's newer glibc fails to load in older systems, and in the Snap
// build of Visual Studio Code. mise.toml installs zig and cargo-zigbuild (mise install).
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NATIVE = path.join(ROOT, 'native');
const { getEnginePath, getEnginePlatform } = require(path.join(ROOT, 'out', 'engine.js'));

const debug = process.argv.includes('--debug');
const platform = getEnginePlatform();
if (platform === null) {
	console.error('The engine isn\'t built for ' + process.platform + '-' + process.arch + '.');
	process.exit(1);
}

// The Rust target for glibc Linux, which cargo-zigbuild builds against GLIBC_TARGET; NULL => the host's own target
const GLIBC_TARGET = '2.28';
const RUST_ARCH = { x64: 'x86_64', arm64: 'aarch64' };
const target = platform.endsWith('-gnu') ? RUST_ARCH[process.arch] + '-unknown-linux-gnu' : null;
if (target !== null && cp.spawnSync('cargo', ['zigbuild', '--help'], { stdio: 'ignore' }).status !== 0) {
	console.error('Building the engine for Linux needs cargo-zigbuild and zig. Run mise install, or install them yourself.');
	process.exit(1);
}

const args = target !== null
	? ['zigbuild', '--target', target + '.' + GLIBC_TARGET]
	: ['build'];
args.push('--manifest-path', path.join(NATIVE, 'Cargo.toml'), '-p', 'git-tree-engine-node', '--locked');
if (!debug) args.push('--release');
const env = Object.assign({}, process.env);
if (!env.CARGO_BUILD_JOBS) env.CARGO_BUILD_JOBS = '4';

console.log('> cargo ' + args.join(' '));
const result = cp.spawnSync('cargo', args, { cwd: NATIVE, env: env, stdio: 'inherit', shell: process.platform === 'win32' });
if (result.status !== 0) {
	process.exit(result.status === null ? 1 : result.status);
}

// Cargo names the library after the crate, with the platform's prefix and extension
const library = process.platform === 'win32'
	? 'git_tree_engine_node.dll'
	: 'libgit_tree_engine_node.' + (process.platform === 'darwin' ? 'dylib' : 'so');
const built = path.join(NATIVE, 'target', ...(target !== null ? [target] : []), debug ? 'debug' : 'release', library);
const destination = getEnginePath(platform);
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.copyFileSync(built, destination);
console.log('Built ' + path.relative(ROOT, destination) + ' (' + Math.round(fs.statSync(destination).size / 1024) + ' KiB)');
