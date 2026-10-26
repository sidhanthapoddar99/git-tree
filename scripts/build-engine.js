// Builds the Rust engine (native/) and places its Node-API module where src/engine.ts loads it:
// native/bin/git-tree-engine.<platform>.node, for example git-tree-engine.linux-x64-gnu.node.
//
// Usage: node scripts/build-engine.js [--debug] [--platform <platform> | --all]
//   --debug                build without optimisations, which is faster to build (for working on the engine)
//   --platform <platform>  build for another platform than this machine's, for example linux-arm64-musl on
//                          Linux x64, or darwin-x64 on an Apple Silicon Mac (CI builds every platform this way)
//
// npm run build-engine compiles src/ first, because the platform name comes from out/engine.js, the
// same code that loads the module. Cargo runs at most 4 jobs (CARGO_BUILD_JOBS), so the machine stays usable.
//
// Linux builds use cargo-zigbuild: glibc builds link against glibc 2.28, the oldest glibc Visual Studio Code
// supports, because a module built against the build machine's newer glibc fails to load in older systems and
// in the Snap build of Visual Studio Code. mise.toml installs zig and cargo-zigbuild (mise install).
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NATIVE = path.join(ROOT, 'native');
const { getEnginePath, getEnginePlatform } = require(path.join(ROOT, 'out', 'engine.js'));

// Each platform's Rust target, and the target cargo-zigbuild builds. zig builds every platform from any machine:
// glibc Linux against glibc 2.28, and Windows with the GNU toolchain, so no Windows SDK is needed. Node-API modules
// built that way load in Visual Studio Code's Electron, because napi-rs resolves Node-API at load time.
const PLATFORMS = {
	'linux-x64-gnu': { target: 'x86_64-unknown-linux-gnu', zigTarget: 'x86_64-unknown-linux-gnu.2.28' },
	'linux-arm64-gnu': { target: 'aarch64-unknown-linux-gnu', zigTarget: 'aarch64-unknown-linux-gnu.2.28' },
	'linux-x64-musl': { target: 'x86_64-unknown-linux-musl', zigTarget: 'x86_64-unknown-linux-musl' },
	'linux-arm64-musl': { target: 'aarch64-unknown-linux-musl', zigTarget: 'aarch64-unknown-linux-musl' },
	'darwin-x64': { target: 'x86_64-apple-darwin', zigTarget: 'x86_64-apple-darwin' },
	'darwin-arm64': { target: 'aarch64-apple-darwin', zigTarget: 'aarch64-apple-darwin' },
	'win32-x64': { target: 'x86_64-pc-windows-gnu', zigTarget: 'x86_64-pc-windows-gnu' },
	'win32-arm64': { target: 'aarch64-pc-windows-gnullvm', zigTarget: 'aarch64-pc-windows-gnullvm' }
};

const argv = process.argv.slice(2);
const debug = argv.includes('--debug');
const platformIndex = argv.indexOf('--platform');
const platforms = argv.includes('--all') ? Object.keys(PLATFORMS) : [platformIndex > -1 ? argv[platformIndex + 1] : getEnginePlatform()];
for (const platform of platforms) {
	if (platform === null || !Object.prototype.hasOwnProperty.call(PLATFORMS, platform)) {
		console.error('The engine isn\'t built for ' + (platform === null ? process.platform + '-' + process.arch : platform) + '. Platforms: ' + Object.keys(PLATFORMS).join(', '));
		process.exit(1);
	}
}
if (cp.spawnSync('cargo', ['zigbuild', '--help'], { stdio: 'ignore' }).status !== 0) {
	console.error('Building the engine needs cargo-zigbuild and zig. Run mise install, or install them yourself.');
	process.exit(1);
}
platforms.forEach(build);

/**
 * Build the engine for one platform, and copy it to where src/engine.ts loads it.
 */
function build(platform) {
	const { target, zigTarget } = PLATFORMS[platform];
	const args = ['zigbuild', '--target', zigTarget, '--manifest-path', path.join(NATIVE, 'Cargo.toml'), '-p', 'git-tree-engine-node', '--locked'];
	if (!debug) args.push('--release');
	const env = Object.assign({}, process.env);
	if (!env.CARGO_BUILD_JOBS) env.CARGO_BUILD_JOBS = '4';
	// native/rust-toolchain.toml pins the Rust version; a RUSTUP_TOOLCHAIN from the environment (mise sets one) would override it
	delete env.RUSTUP_TOOLCHAIN;
	if (platform.startsWith('darwin-')) {
		// Git Tree supports macOS 15 (2024) and later. Set explicitly, so a zig update doesn't move it.
		env.MACOSX_DEPLOYMENT_TARGET = '15.0';
	}
	if (platform.startsWith('win32-')) {
		// napi-build insists on a libnode.dll to link against with the GNU toolchain. The engine loads Node-API from
		// the host process instead (napi's dyn-symbols), so stand-ins satisfy it and nothing links to Node.js.
		env.LIBNODE_PATH = buildLibnodeStub(zigTarget);
	}
	if (platform.endsWith('-musl')) {
		// musl targets link the C library statically by default, which a shared library can't do
		env['CARGO_TARGET_' + target.toUpperCase().replace(/-/g, '_') + '_RUSTFLAGS'] = '-C target-feature=-crt-static';
	}

	console.log('> cargo ' + args.join(' '));
	const result = cp.spawnSync('cargo', args, { cwd: NATIVE, env: env, stdio: 'inherit', shell: process.platform === 'win32' });
	if (result.status !== 0) {
		process.exit(result.status === null ? 1 : result.status);
	}

	// Cargo names the library after the crate, with the target's prefix and extension
	const library = platform.startsWith('win32-')
		? 'git_tree_engine_node.dll'
		: 'libgit_tree_engine_node.' + (platform.startsWith('darwin-') ? 'dylib' : 'so');
	const built = path.join(NATIVE, 'target', target, debug ? 'debug' : 'release', library);
	const destination = getEnginePath(platform);
	fs.mkdirSync(path.dirname(destination), { recursive: true });
	fs.copyFileSync(built, destination);
	console.log('Built ' + path.relative(ROOT, destination) + ' (' + Math.round(fs.statSync(destination).size / 1024) + ' KiB)');
}

/**
 * Build stand-ins for Node.js's library, for a Windows target: napi-build checks that a libnode.dll exists, and links
 * with -lnode, which an empty static library (libnode.a) satisfies without adding a DLL dependency.
 * @returns The folder that holds them.
 */
function buildLibnodeStub(zigTarget) {
	const dir = path.join(NATIVE, 'target', 'libnode-stub', zigTarget);
	fs.mkdirSync(dir, { recursive: true });
	const source = path.join(dir, 'libnode.c'), object = path.join(dir, 'libnode.o');
	fs.writeFileSync(source, 'void git_tree_libnode_stub(void) {}\n');
	const target = (zigTarget.startsWith('aarch64') ? 'aarch64' : 'x86_64') + '-windows-gnu';
	const steps = [
		['cc', '-shared', '-target', target, '-o', path.join(dir, 'libnode.dll'), source],
		['cc', '-c', '-target', target, '-o', object, source],
		['ar', 'rcs', path.join(dir, 'libnode.a'), object]
	];
	for (const step of steps) {
		if (cp.spawnSync('zig', step, { stdio: 'inherit', shell: process.platform === 'win32' }).status !== 0) {
			console.error('Unable to build the stand-ins for libnode with zig (zig ' + step.join(' ') + ').');
			process.exit(1);
		}
	}
	return dir;
}
