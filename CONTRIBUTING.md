# Git Tree — Developer Guide

This guide is for people working on Git Tree itself. How to use the extension, and the Marketplace listing, are in [README.md](README.md).

## Toolchain

[mise](https://mise.jdx.dev) pins Node.js, and runs the project's tasks. npm installs the dependencies. The engine (below) also needs Rust; `native/rust-toolchain.toml` pins its version, which rustup installs the first time cargo runs in `native/`.

```bash
mise install        # installs the Node.js version in mise.toml
mise run setup      # npm ci, then builds the demo repository
```

| Task | What it does |
| --- | --- |
| `mise run setup` | Installs the npm dependencies and builds the demo repository. |
| `mise run build` | Lints, then builds the extension (`out/`) and the webview (`media/`). |
| `mise run test` | Runs the Jest tests. |
| `mise run gate` | What CI runs: lint, build and test. |
| `mise run engine` | Builds the Rust engine in release mode, into `native/bin/`. |
| `mise run test-engine` | Compares each engine read with the Git CLI read, on real repositories. Needs the engine built. |
| `mise run bench-engine <repository>` | Times each read with the Git CLI and with the engine. |
| `mise run demo` | Rebuilds the demo repository from scratch. |
| `mise run package` | Packages `dist/git-tree-rs-<version>.vsix`. |
| `mise run install` | Packages the extension and installs it in Visual Studio Code. |
| `mise run screenshots` | Converts the README screenshots to WebP. |

Without mise, use Node.js 24 and the npm scripts: `npm ci`, `npm run compile`, `npm test`.

Converting screenshots needs ImageMagick 7 (`magick`) built with WebP support.

## Project layout

```
.
├── src/                      ← the extension, which runs in VS Code's extension host
│   ├── extension.ts          # activation: commands, status bar item, the repository manager
│   ├── gitTreeView.ts        # one Git Tree tab: answers the messages its webview sends
│   ├── dataSource.ts         # runs Git and parses its output (log, refs, status, worktrees…)
│   ├── engine.ts             # loads the Rust engine, if it's built for this platform
│   ├── repoManager.ts        # finds the repositories in the workspace
│   ├── repoFileWatcher.ts    # refreshes a tab when files in its repository or worktrees change
│   ├── config.ts             # reads the git-tree.* settings
│   └── types.ts              # the messages between the extension and the webview
├── web/                      ← the webview: the graph, table, menus and dialogs
│   ├── main.ts               # renders the view and handles its events
│   ├── graph.ts              # lays out and draws the commit graph
│   ├── virtualTable.ts       # keeps only the rows on screen in the table
│   └── styles/               # CSS, built into media/out.min.css
├── native/                   ← the engine: Rust that reads repositories in-process
│   ├── core/                 # the reads, with gix (pure Rust)
│   ├── node/                 # the Node-API module that src/engine.ts loads
│   └── bin/                  # the built modules, git-tree-engine.<platform>.node (not committed)
├── tests/                    ← Jest tests, with mocks of the vscode API and of Git
│   └── engine/               # the engine's differential tests, which run real Git
├── resources/                ← the logo and icons
├── dev-workspace/            ← what the Extension Development Host opens
│   └── demo.code-workspace   # opens demo-repo/, which scripts/make-demo-repo.sh builds
├── scripts/
│   ├── make-demo-repo.sh     # builds the demo repository
│   ├── build-engine.js       # builds the engine into native/bin/
│   ├── bench-engine.js       # times each read with the Git CLI and with the engine
│   └── convert-screenshots.sh
├── docs/images/              ← README screenshots, as WebP
├── dist/                     ← packaged .vsix files (not committed)
├── .vscode/                  # launch configurations, tasks, and the build scripts
├── mise.toml
├── CHANGELOG.md, README.md, LICENSE, licenses/
└── package.json
```

## How the extension works

Git Tree has two halves that talk through messages.

- **The extension** (`src/`) runs in Node.js inside VS Code. `DataSource` spawns Git, and parses its output into the types in `src/types.ts`. Each Git Tree tab is a `GitTreeView`, which answers its webview's requests in `respondToMessage`: load the repository's branches and worktrees, load the commits, run an action.
- **The webview** (`web/`) runs in the tab's browser page. It asks for data with `sendMessage`, draws the graph and the table, and sends Git actions back.

Every request names the folder Git runs in (`repo`). Repository-level state, such as saved column widths, code reviews and the repository's settings, is kept by repository. Git commands run in the worktree the view shows.

### The engine

The engine (`native/`) reads repositories in-process, so loading the view spawns no Git process. It answers the reads behind the view load: the branches, remotes, stashes and worktrees (`getRepoInfo`), the refs, and the page of commits. It also answers the Commit Details View's reads between commits: a commit's or a stash's details and its changed files (`--name-status` and `--numstat`), a comparison of two commits, a file at a commit, a commit's subject, a remote's URL, an annotated tag's details and the configuration lists. Diffs with the working tree, which need `git status`, stay with Git. `src/engine.ts` loads it, if `native/bin/` has a module for the platform. Otherwise, or if it fails to load, Git Tree reads everything with Git, and says why once in the Git Tree output channel.

Each engine read returns the records that the Git command prints, and `DataSource` interprets them with the same code as Git's output, so the two paths can't drift apart. When the engine can't be certain that its answer is the one Git would give, it answers `unsupported` with a reason, and `DataSource` runs the Git command instead. Examples are SHA-256 and shallow repositories, replacement objects, grafts, commits in another encoding, a mailmap, and settings it doesn't model, such as `branch.sort`. For the details reads they include a diff where Git could find a rename of a file that changed (the engine pairs only identical files), a diff it can't count lines for exactly (more than 500 changed lines in one file, after Git's own trimming), a submodule, attributes that can change a diff (`diff`, `binary`, macros), `diff.algorithm` other than Myers, `diff.context=0`, `core.bigFileThreshold`, a signed commit when the signature status is shown, a tag that may be signed, a lightweight tag, an include section with more than one entry, and both `~/.gitconfig` and the XDG configuration file existing. The Git commands stay the reference: git status, and every action that changes the repository, always run Git.

Build it with `mise run engine` (`npm run build-engine`). On Linux the script builds with cargo-zigbuild against glibc 2.28, the oldest glibc Visual Studio Code supports, so the module also loads on older systems and in the Snap build of VS Code; `mise install` installs zig and cargo-zigbuild. Cargo runs at most four jobs, unless `CARGO_BUILD_JOBS` says otherwise. `npm run build-engine -- --debug` builds without optimisations, which is quicker while you work on it. The Rust tests run with `cargo test` in `native/`.

### The build

The build has two steps. `tsc -p ./src` compiles the extension into `out/`. `tsc -p ./web` compiles the webview, and `.vscode/package-web.js` joins it into `media/out.min.js` and `media/out.min.css`. The webview's compile reads the message types from `out/`, so build `src` first. `npm run compile` does both, in that order.

## Running the extension locally (F5)

Open this folder in VS Code and press F5. `.vscode/launch.json` has two configurations:

| Configuration | Before it starts | Opens |
| --- | --- | --- |
| **Run Extension (demo repo)** | An unminified build, and the demo repository if it's missing | `dev-workspace/demo.code-workspace`, with other extensions disabled |
| **Run Extension (empty window)** | An unminified build | An empty window, for a folder of your own |

The Extension Development Host doesn't pick up a rebuild by itself. After you change code, run the build again (*Tasks: Run Task* → **Build (Debug)**), then run *Developer: Reload Window* in the host. To debug the webview, run *Developer: Open Webview Developer Tools* in the host.

### The demo repository

`scripts/make-demo-repo.sh` builds a small TypeScript project, Skycast, in `dev-workspace/`. It has what Git Tree needs to show:

- about 65 commits over three months, from four authors
- feature branches merged with merge commits, and two unmerged branches
- a release branch, annotated tags (`v0.1.0`, `v1.0.0`) and a lightweight tag (`nightly`)
- a remote, `origin` (`demo-origin.git`), with a branch that exists only there, and `main` two commits ahead of `origin/main`
- a stash, and uncommitted changes on `main`
- three linked worktrees:
  - `.worktrees/alerts`, on `feature/alerts`, with uncommitted changes
  - `.worktrees/review`, a detached HEAD at `v1.0.0`
  - `../demo-hotfix`, outside the repository, on `fix/cache-crash`, with uncommitted changes

Rebuild it with `mise run demo`, or the **Rebuild Demo Repository** task, after you've changed it while testing. The script only deletes its own folders in `dev-workspace/`.

## Tests

```bash
npx jest                          # everything
npx jest tests/dataSource.test.ts # one file
```

`npx jest` leaves out `tests/engine/`. Those tests run real Git, so they have their own configuration (`jest.engine.config.js`):

```bash
mise run engine        # build the engine first
mise run test-engine   # npm run test-engine
```

They read the demo repository (built in a temporary folder), this repository, and repositories built for edge cases, with each ordering and option the view uses. `tests/engine/differential.test.ts` covers the view load, and `tests/engine/details.test.ts` reads every commit's details, diff, subject and changed files, comparisons, stashes, tags, remote URLs and the configuration. `tests/engine/harness.ts` holds what they share. A Git Tree without the engine and one with it must return the same results, and the engine must answer each read itself, apart from the reads it hands to Git on purpose. Without a built engine, the tests are skipped.

The tests give Git and the engine an empty home folder, which `tests/engine/home-setup.js` makes before Jest starts its workers. It can't be set in a test file: the engine reads the process's environment, and Jest gives each test file its own copy of `process.env`, which only Git sees.

The benchmark times each read, and the view load, as the median of several runs:

```bash
mise run bench-engine /path/to/repository   # or: npm run bench-engine -- /path/to/repository --runs 30
```

The tests mock the `vscode` API (`tests/mocks/vscode.ts`) and Git's process (`tests/mocks/spawn.ts`). `mockGitSuccessOnce` and `mockGitThrowingErrorOnce` are used up in the order Git is spawned, so a test that adds a Git call has to add its mock in the same place. Jest uses its legacy fake timers (`jest.config.js`), which the debounce tests rely on.

## What to test by hand

Before a release, go through these in the demo repository:

- **The graph.** Branches, merges, tags, the stash and the remote branches draw correctly, in a dark and a light theme.
- **Worktrees.** Each worktree's label is in the Worktree column. Picking a worktree in the Worktree filter shows its history and its uncommitted changes; *All* shows every worktree's changes. Ctrl+click (Cmd+click on macOS) on a worktree label opens it in a new window.
- **Uncommitted changes.** Edit a file in `.worktrees/alerts` and in `../demo-hotfix`. Their rows update within a second or two.
- **Create and remove a worktree.** Create one from a commit with a new branch, and from a branch. Try a folder with `~` and `{repo}`. Remove it again.
- **Commit details.** Open a commit, view a diff, open a file, copy its paths, and copy its path in another worktree.
- **Tabs.** *View Git Tree in New Tab...* opens a second tab, and each tab's title names its repository and worktree.
- **A narrow view.** Make the tab narrow. The top bar stays on one row.

## Screenshots for the README

The README shows two screenshots from `docs/images/`, as WebP. Take them in the demo repository: build a throwaway copy with `DEMO_DIR=/tmp/git-tree-demo scripts/make-demo-repo.sh`, and open `/tmp/git-tree-demo/demo-repo` in VS Code with Git Tree installed. Save the PNGs in `docs/images/raw/` (not committed) with these names:

| File | What it shows | Where the README uses it |
| --- | --- | --- |
| `worktree-filter.png` | The graph with the Worktree column, and the Worktree dropdown open | At the top |
| `commit-menu.png` | A commit's context menu, with *Create Worktree...* | Create, open and remove worktrees |

Then convert them, with either tool:

```bash
mise run screenshots   # ImageMagick: every PNG in docs/images/raw/, at most 1600 px wide
agent-ks img docs/images/raw/*.png --format webp --max-dim 1600 --quality 90 --strip --out docs/images
```

## Building and packaging

```bash
mise run build              # lint, then build out/ and media/
mise run package            # dist/git-tree-rs-<version>.vsix
npx --yes @vscode/vsce ls   # what the package would contain
```

The package holds `out/`, `media/`, `resources/`, the engine modules in `native/bin/`, the README, the changelog and the licenses. `.vscodeignore` leaves out the sources (including the engine's Rust sources and `native/target/`), tests, the dev workspace, the screenshots and the scripts. The Marketplace shows the README's images from the GitHub repository, so they need to be pushed, and the repository public, before a release.

## Releasing

1. Move the *Unreleased* entries in `CHANGELOG.md` under a new version heading with today's date, and add its compare link at the bottom.
2. Set the version: `npm version <version> --no-git-tag-version`.
3. Run `mise run gate`, then go through *What to test by hand*.
4. Commit the release as `Release <version>`, and tag it: `git tag -a v<version> -m "Git Tree <version>"`.
5. Run `mise run package` and publish the `.vsix` (below).

Versions follow [Semantic Versioning](https://semver.org): the patch number for fixes and small changes, the minor number for new features, and the major number for a change that breaks existing settings or workflows.

## Publishing to the Marketplace

**Option A — upload by hand.** Sign in to the [publisher management page](https://marketplace.visualstudio.com/manage), choose the publisher, then *New extension* → *Visual Studio Code*, or *Update* on an existing listing, and upload the `.vsix`.

**Option B — the vsce command.** Create an Azure DevOps personal access token with the *Marketplace (Manage)* scope, then:

```bash
npx --yes @vscode/vsce login sidh1999
npx --yes @vscode/vsce publish --packagePath dist/git-tree-rs-<version>.vsix
```

Before either one, check:

- `publisher` in `package.json` is `sidh1999`, the Marketplace publisher.
- The GitHub repository is public and pushed, so the README's images load on the Marketplace.
- The changelog's new section is complete.

## Notes

- **Line endings.** The TypeScript, CSS and build scripts use CRLF, and the linter checks it. Keep CRLF when you edit them.
- **Message types.** A new message needs its request and response types in `src/types.ts`, a case in `GitTreeView.respondToMessage`, and a case in the webview's message handler.
- **vsce** isn't a dependency; `npx --yes @vscode/vsce` fetches it when needed.
- **Performance in commit messages.** A commit that changes speed, memory or package size says what it measured, before and after, in its message: what was measured, on which repository, and the numbers. For example: "Opening the view, 6,750 commits: 19.4 ms → 7.0 ms (median of 25 runs, Linux x64)". `git log` is then the record of what each change gained.
