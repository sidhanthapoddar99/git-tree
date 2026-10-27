# Changelog

All notable changes to Git Tree are recorded in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Git Tree uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-10-27

### Added

- **Worktrees on SSH servers.** List your servers in `.worktrees/git-tree.yaml`, or add them with *Git Tree: Add Remote Host...*, and their worktrees join the graph: labels such as `build-box:main` in the Worktree column, their own *Uncommitted Changes* rows, a group per host in the Worktree filter, and the server's branches drawn like remote branches under the host's name. The server needs only `git` and `ssh`; nothing is installed there.
- One SSH call per host reads its worktrees, branches and uncommitted changes, over a shared connection: about 16 ms after the first, against 180 ms for a new connection. Git Tree fetches a server's branches into hidden refs under `refs/git-tree/hosts/`, only when they moved, and asks before the first fetch from each host.
- A host that's down, needs a password, points at a missing path or at another project says so, and its rows are greyed out. It never looks clean, and it never holds up the local graph.
- From the graph: open a server worktree in VS Code with Remote-SSH, open a terminal in it, copy its path, remove it, or create a worktree on a server from a commit or a branch.
- *Git Tree: Remove Remote Host*, and the settings `git-tree.remoteHosts.sshPath` and `git-tree.remoteHosts.refreshInterval`.
- [An instruction for coding agents](docs/remote-hosts-for-agents.md), so they keep the host list up to date.

## [0.4.2] - 2026-10-27

### Changed

- **A refresh where nothing changed costs about 1 ms.** The engine checks whether anything the commits depend on has changed, and if not, it skips the log walk: about 0.7 ms instead of 7 ms on a 6,750-commit repository. The view then gets only its *Uncommitted Changes* rows, in a message of about 160 bytes instead of 97 KB.
- **Opening the view sends half the data.** The engine answers the view load in two calls instead of six, and the commits reach the view in a compact form: each author once, and each parent as a row number. 300 commits take 40 KB instead of 97 KB. Under Remote-SSH, where the extension runs on the server, this is the data that crosses the network.

### Fixed

- Changing `git-tree.date.type` or `git-tree.repository.useMailmap` updates the dates and names in the graph straight away. Before, they kept their old values until the next full refresh.

## [0.4.1] - 2026-10-27

### Added

- **Windows, macOS and every Linux.** One package holds the engine for Windows x64 and arm64, macOS 15 or later on Intel and Apple silicon, and Linux x64 and arm64 with glibc 2.28 or later or with musl (Alpine). 0.4.0 shipped only Linux x64.

### Changed

- **The engine reads the Commit Details View.** A commit's details and changed files, a stash's, a comparison of two commits, a file at a commit, a commit's subject, a remote's URL, an annotated tag's details and the configuration come from the engine instead of 2 to 5 `git` processes each. On a 6,750-commit repository, opening a small commit's details takes about 1 ms instead of 14 ms, and reading the configuration 0.4 ms instead of 26 ms. When Git might find a rename of a file that changed, or a diff depends on attributes or settings the engine doesn't model, Git reads it instead.
- **The engine reads the commit log incrementally, as Git does.** With a commit-graph file, a page of commits costs about the commits on it, in every order: 301 commits in author-date order take about 4 ms instead of 47 ms on a 6,750-commit repository. Without a commit-graph file, the engine reads each commit once, so the whole log takes about 57 ms instead of 85 ms, where Git takes 83 ms.
- **Git Tree needs its engine.** If the engine is missing or can't load, Git Tree shows a message that says why, instead of reading everything with `git`.

## [0.4.0] - 2026-10-27

### Added

- **A Rust engine.** Git Tree reads branches, remotes, stashes, worktrees, refs and the commit log in-process with gitoxide, instead of starting `git` for each. Opening the view takes about 7 ms instead of 19 ms on a 6,750-commit repository, and starts no `git` processes. When the engine can't be sure it would match Git, such as in a shallow clone, Git reads it instead. `git status` and every Git action still run `git`.

### Changed

- **The graph draws only the rows on screen.** With 5,000 commits loaded, drawing takes about 24 ms instead of 400 ms, the page holds about 1,600 elements instead of 48,000, and the view uses about 120 MB less memory.
- Find searches the loaded commits' data, so it finds commits whose rows aren't drawn yet.
- **Git Tree needs Git 2.31 or later**, released in March 2021. With an older Git, it shows a message that says which Git it found and how to fix it, instead of the graph.

## [0.3.5] - 2026-10-27

### Changed

- Better Marketplace tags, including `worktrees`, `history`, `git graph` and `rust`, and the *SCM Providers* and *Visualization* categories.

## [0.3.4] - 2026-10-26

### Changed

- The extension's ID is `sidh1999.git-tree-rs`, because the Marketplace already has an extension named `git-tree`. Its commands, views and `git-tree.*` settings keep their names.

### Fixed

- The Marketplace page links to the MIT license.

## [0.3.3] - 2026-10-26

### Changed

- The publisher is `sidh1999`, so the extension's ID is `sidh1999.git-tree`.
- The Marketplace lists the extension as **git-tree-rs**, because another extension already uses the name "Git Tree". Its commands and views are still called Git Tree.

## [0.3.2] - 2026-10-26

### Added

- **A Worktree column**, right after Description. Worktree labels moved there from beside the branch labels, so they can't be mistaken for branches. It labels the worktree a branch is checked out in, a detached worktree, and the worktree of each *Uncommitted Changes* row. Resize it, or show and hide it from the column header's context menu. It appears when the repository has more than one worktree. `git-tree.defaultColumnVisibility` gains `Worktree`, which defaults to `true`.
- **Ctrl+click (Cmd+click on macOS) a worktree label** to open that worktree in a new window.
- A developer setup: F5 opens a demo repository with branches, tags, a remote, a stash and three worktrees. See [CONTRIBUTING.md](CONTRIBUTING.md).

### Changed

- **The Worktree dropdown filters the graph.** It lists *All*, *Root* (the main worktree) and each linked worktree.
  - Picking a worktree shows only its history and its own uncommitted changes, and Git actions run in it.
  - Branches picked in the *Branches* dropdown are shown as well.
  - *All* shows every branch and every worktree's uncommitted changes.
  - *Root* is the default, and each repository remembers your choice.
  - Clicking another worktree's *Uncommitted Changes* row, or *Show This Worktree*, picks that worktree in the filter.
- New logo and icons: three branches at the top meet in one hub commit, and three lines run below it, one through another commit.
- The README is rewritten for the Marketplace, with screenshots and a comparison with Git Graph on performance and features.

### Fixed

- The worktree being viewed is kept when the view reloads.
- Clicking another worktree's *Uncommitted Changes* row opens its changes after the view switches to that worktree.
- A branch named `constructor` no longer confuses the worktree labels.

## [0.3.1] - 2026-10-26

### Added

- **Worktree dropdown.** The top bar lists the main worktree and every linked worktree. Pick one, and the graph, the branch filter, the uncommitted changes and Git actions use that worktree. The tab's title names the worktree when it isn't the main one.
- **Uncommitted changes in every worktree.** Each worktree with uncommitted changes gets its own *Uncommitted Changes* row, labelled with the worktree's name and drawn from the commit it's on. Click the row to switch to that worktree and see its changes. If Git can't read a worktree's status, the row says so instead of looking clean.
- *Show This Worktree* in a worktree label's context menu.
- *Copy Absolute File Path in Another Worktree...* in a file's context menu in Commit Details. The same file has a different absolute path in each worktree.
- A *Worktrees* section in the Settings editor for `git-tree.worktree.defaultLocation`.
- Worktree paths, in the setting and in the Create Worktree dialog, accept `~` for your home folder and `{repo}` for the repository's folder name, for example `~/worktrees/{repo}`.

### Changed

- The top bar stays on one row in a narrow view. Dropdowns shrink with an ellipsis and the text labels hide, instead of the controls wrapping onto more rows. An open dropdown keeps its full width and stays inside the view.
- When a repository has several worktrees, every worktree is labelled, including the one being viewed.
- Git Tree watches worktrees outside the repository too, so their uncommitted changes stay up to date.
- New logo and icons: three branches growing from one root.

### Fixed

- The Commit column shows `*` for every *Uncommitted Changes* row.

## [0.2.0] - 2026-10-26

### Added

- **One tab per repository.** A repository opens in the tab that already shows it, or in a new tab, so you can keep several repositories open side by side. *View Git Tree in New Tab...*, a command and a button in the tab's title bar, opens another one. Each tab's title names its repository.
- **Commit-graph file.** When a repository has no Git commit-graph file, Git Tree writes one in the background (`git-tree.repository.writeCommitGraph`). On a repository with 16,000 commits, loading the graph's data went from 113 ms to 25 ms.

### Changed

- `git status` runs alongside `git log` instead of after it, so large repositories load faster.
- A tab that was hidden refreshes its data when shown, instead of reloading the whole page.
- Git Tree needs Visual Studio Code 1.82 or later.
- The toolchain is current: TypeScript 5.9, Jest 29 and ESLint 8 with typescript-eslint 8.

### Fixed

- Interactive rebase can no longer run shell commands hidden in a branch name.
- A carriage return in a commit subject no longer hides all older commits.
- A tag with the same name as a branch can be pushed and deleted on a remote.
- The branch list works when the Git setting `column.ui` is on.
- Commit Details no longer hangs on a folder named `constructor`, or on a folder replaced by a file.
- Pasting a name with the mouse enables the dialog's button.
- Long histories no longer overflow the stack when you hover the graph or mute commits.
- Keyboard navigation picks the right alternative branch.
- The Git Tree button appears on each repository in the Source Control view of newer Visual Studio Code.
- The view command no longer fails when it gets an empty argument.

## [0.1.0] - 2026-10-26

The first version of Git Tree.

### Added

- Worktrees in the graph. A branch checked out in another worktree carries the worktree's name, and a detached worktree gets its own label.
- Create a worktree from a commit, with a new branch or on a detached HEAD, or from a branch. New worktrees go in `.worktrees/` by default (`git-tree.worktree.defaultLocation`), and Git Tree adds that folder to `.git/info/exclude`.
- Open a worktree in a new or the current window, remove it, or copy its path.
- Theme colours for rows, labels and inputs, tuned for light and dark themes, with a darker graph palette on light themes.
- A tree-shaped logo and icons.

### Changed

- Checkout and Delete are hidden for a branch checked out in another worktree, because Git refuses them.

### Removed

- Telemetry. Git Tree sends no usage data.

[Unreleased]: https://github.com/sidhanthapoddar99/git-tree/compare/v0.4.0...HEAD
[0.5.0]: https://github.com/sidhanthapoddar99/git-tree/compare/v0.4.2...v0.5.0
[0.4.2]: https://github.com/sidhanthapoddar99/git-tree/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/sidhanthapoddar99/git-tree/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/sidhanthapoddar99/git-tree/compare/v0.3.5...v0.4.0
[0.3.5]: https://github.com/sidhanthapoddar99/git-tree/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/sidhanthapoddar99/git-tree/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/sidhanthapoddar99/git-tree/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/sidhanthapoddar99/git-tree/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/sidhanthapoddar99/git-tree/compare/v0.2.0...v0.3.1
[0.2.0]: https://github.com/sidhanthapoddar99/git-tree/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/sidhanthapoddar99/git-tree/releases/tag/v0.1.0
