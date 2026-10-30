# Changelog

All notable changes to Git Tree are recorded in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Git Tree uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Git Tree tabs come back when Visual Studio Code restarts.** Each tab reopens in its editor group and position, split layouts included, and shows the repository it showed. Before, VS Code closed every Git Tree tab on restart.

### Changed

- **Each tab keeps its own Worktree and Host choice.** Two tabs of one repository can show different worktrees, and keep them across a restart. A new tab starts with the last choice made in that repository.

## [0.8.0] - 2026-10-30

### Added

- **The Manage Worktrees panel.** A button next to Refresh opens it. It has a section for this machine and one for each remote host that isn't hidden in Repository Settings. Each section shows the disk's free space and every worktree's size, branch, uncommitted changes and distance from the main branch. Linked worktrees inside the main worktree, and the shared `.git` folder, are each counted once. Git facts show at once, and sizes fill in as `du` finishes.
- **Fast-forward a worktree to the main branch from the panel.** The main branch is the one `origin/HEAD` points to, else `main`, else `master`. The button only works when the worktree is clean (no untracked files either), is on a branch, and hasn't diverged from main. The extension checks all of this again, on the server too, just before it runs `git merge --ff-only`.

### Fixed

- A remote host that refuses the panel's SSH login waits out its retry delay, instead of adding a failed login on every refresh.

## [0.7.0] - 2026-10-30

### Added

- **Labels that don't fit collapse into a "+N" chip.** The Description, Worktree and Host cells show the branch, tag, worktree and host chips that fit, then "+N" for the rest, instead of cutting them off with "…". The commit message always keeps room to be read.
- **Hover a cell with hidden chips to see them all.** A card lists every label in the cell, grouped by kind, with each worktree's branch and each host's state.
- **The row whose details are open shows every chip.** Its chips wrap onto as many lines as they need, the commit message stays on one line, and the graph stays lined up with the taller row.
- **The terminal button asks which worktree to open in.** A menu lists this machine's worktrees, then each remote host's, with their branches, and ticks the one you're viewing. With only one worktree, it opens straight away as before. The extension only opens a local terminal in one of the repository's own worktrees.

### Changed

- **The Host dropdown is a multi-select.** Tick Local and any hosts, use a row's "only" button to show just that one, or use the *All* row to tick or clear them all. Hosts added later show up while *All* is chosen.
- **The Host and Worktree choices are saved per repository**, so they survive a restart of Visual Studio Code. Choices saved by 0.6.2 are dropped once.
- Dropdowns show real checkboxes, and menus can show group headings and dim hints.

## [0.6.2] - 2026-10-29

### Added

- **The Host dropdown filters the graph by machine.** It sits in the top bar, before the Worktree dropdown. *All* shows this machine's worktrees and every remote host's. *Local* shows only this machine's, and Git Tree doesn't contact the hosts. A host's name shows only that host's worktrees and branches, and Git Tree reads only that host. The Worktree dropdown then lists only the worktrees the Host dropdown shows. The dropdown appears when a repository has a remote host, and each repository remembers its choice.
- **The Host column** names the remote host on each row with a server's worktree, branch or uncommitted changes. Rows with only this machine's worktrees leave it blank. It sits after the Worktree column, which still labels server worktrees like `build-box:main`. `git-tree.defaultColumnVisibility` takes a `Host` key.

### Changed

- **Show Remote Branches moved to Repository Settings**, in the General card next to *Show Stashes* and *Show Tags*. The top bar no longer has the checkbox.
- Clicking a remote host's *Uncommitted Changes* row explains that its files can't be listed from here, instead of switching the Worktree filter to that worktree. Right-click the row to show the worktree or open it with Remote-SSH.

### Fixed

- **Clicking another worktree's *Uncommitted Changes* row no longer switches the Worktree filter.** Its changed files open in place, and the panel says which worktree they're in. *View Diff*, *Open File* and the other file actions run in that worktree. Ctrl+click (Cmd+click) a commit to compare it with those changes.

## [0.6.1] - 2026-10-28

### Changed

- **The Worktree dropdown starts on *All*.** You see every worktree's branch and uncommitted changes from the start, instead of only the main worktree's. Pick *Root* or one worktree to narrow the graph. Each repository still remembers a worktree you picked, and if that worktree is removed, the view goes back to *All*.
- **The main worktree is called *Root* everywhere.** The Worktree column, its *Uncommitted Changes* row and the *Copy Absolute File Path in Another Worktree* dialog now say *Root*, as the dropdown already did. On a remote host it's `<host>:Root`. Hover over the label to see its path. The dropdown shows each worktree's branch beside its name, without Root's folder name.

## [0.6.0] - 2026-10-27

### Added

- **Remote Hosts in Repository Settings.** Each host has a row with its state, alias, path, worktree count and last refresh. From the row you can check, edit, hide or remove the host, and fetch, pull or push on the server.
- **Add a host without typing a path.** Pick one of your SSH aliases (Git Tree reads `~/.ssh/config` and the files it includes), then browse the server's folders, where repositories and worktrees are marked. Choose *Add existing* for a repository already on the server, or *Create new* to clone one of this repository's remotes on the server, or to push this repository there.
- **Agent forwarding.** A host's `forwardAgent: true` forwards your SSH agent to Git on the server, so a clone, fetch, pull or push there can reach GitHub with your keys. Only those commands forward it, each on its own connection, which closes when the command ends.
- **Fetch, pull and push on a server**, from the host's row or from a server worktree's menu in the graph. Pull is fast-forward only, and push asks first.
- **Hide a host.** A hidden host's worktrees and branches leave the graph, as a hidden remote's do, and Git Tree stops reading the host until you show it again.
- **Copy the instruction for coding agents** with one button in the Remote Hosts section. The instruction now covers `forwardAgent`, `worktrees: false`, and creating server worktrees.

### Changed

- **Repository Settings is redesigned.** Each section is a card with a title, a short description and its actions. Lists are rows with icon buttons, switches replace checkboxes, and it follows light, dark and high-contrast themes.
- Adding a host checks that the path is the repository's main worktree. A linked worktree, a folder inside a repository or a bare repository is refused, and the error names the right path.
- Git Tree's SSH calls never forward your agent unless the host asks for it, even when your SSH configuration sets `ForwardAgent yes`. The terminal is the exception, because it's your own session.

### Fixed

- The Worktree filter showed `Allow Fetching&#8230;` instead of *Allow Fetching…*.

### Performance

Against a test SSH server on the same machine, median of 9 runs.

| | Shared connection | New connection |
| --- | ---: | ---: |
| Listing a folder on the server | 17–26 ms | 162–165 ms |
| A fetch on the server | 58 ms | 190–201 ms, with the agent forwarded |

| Against 0.5.0 | 0.5.0 | 0.6.0 |
| --- | ---: | ---: |
| Opening Repository Settings' Remote Hosts section | — | 0.1 ms; it never waits for a server |
| Opening the view with a host hidden | — | no slower than with it shown, within noise |
| The view's script / styles | 226 / 40 KB | 258 / 52 KB |

## [0.5.0] - 2026-10-27

### Added

- **Worktrees on SSH servers.** List your servers in `.worktrees/git-tree.yaml`, or add them with *Git Tree: Add Remote Host...*, and their worktrees join the graph: labels such as `build-box:main` in the Worktree column, their own *Uncommitted Changes* rows, a group per host in the Worktree filter, and the server's branches drawn like remote branches under the host's name. The server needs only `git` and `ssh`; nothing is installed there.
- One SSH call per host reads its worktrees, branches and uncommitted changes, over a shared connection: about 16 ms after the first, against 180 ms for a new connection. Git Tree fetches a server's branches into hidden refs under `refs/git-tree/hosts/`, only when they moved, and asks before the first fetch from each host.
- A host that's down, needs a password, points at a missing path or at another project says so, and its rows are greyed out. It never looks clean, and it never holds up the local graph.
- From the graph: open a server worktree in VS Code with Remote-SSH, open a terminal in it, copy its path, remove it, or create a worktree on a server from a commit or a branch.
- *Git Tree: Remove Remote Host*, and the settings `git-tree.remoteHosts.sshPath` and `git-tree.remoteHosts.refreshInterval`.
- [An instruction for coding agents](docs/remote-hosts-for-agents.md), so they keep the host list up to date.

### Performance

Against a test SSH server on the same machine, median of 9 runs. Across a network, add one round trip with a shared connection, and about three without.

| | Shared connection | New connection each time |
| --- | ---: | ---: |
| Reading a server's worktrees and changes | 16 ms | 178 ms |
| A refresh where nothing changed | 19 ms, about 3.3 KB | 175 ms, about 13 KB |
| A refresh after one new commit, with its fetch | 130 ms, about 8.3 KB | 360 ms, about 30 KB |

| Against 0.4.2 | 0.4.2 | 0.5.0 |
| --- | ---: | ---: |
| Opening the view with two hosts of three worktrees each (569 commits) | 5.8 ms (no hosts) | 6.2 ms, within noise |
| Data sent to the view with those two hosts | 39.5 KB | 40.5 KB |
| Download size | 8.2 MB | 8.4 MB |

## [0.4.2] - 2026-10-27

### Changed

- **A refresh where nothing changed costs about 1 ms.** The engine checks whether anything the commits depend on has changed, and if not, it skips the log walk: about 0.7 ms instead of 7 ms on a 6,750-commit repository. The view then gets only its *Uncommitted Changes* rows, in a message of about 160 bytes instead of 97 KB.
- **Opening the view sends half the data.** The engine answers the view load in two calls instead of six, and the commits reach the view in a compact form: each author once, and each parent as a row number. 300 commits take 40 KB instead of 97 KB. Under Remote-SSH, where the extension runs on the server, this is the data that crosses the network.

### Performance

Against 0.4.1, on a 6,750-commit repository with 300 commits loaded, on Linux x64 with Git 2.55. The machine was busy, so the times are rough; the ratios hold.

| | 0.4.1 | 0.4.2 |
| --- | ---: | ---: |
| Engine calls to open the view | 6 | 2 |
| Data from the engine to the extension | 86.7 KB | 44.4 KB |
| The engine's time to open the view | 7.8 ms | 6.3 ms |
| A refresh where nothing changed, reading the commits | 6.95 ms | 0.69 ms |
| Data sent to the view | 96.7 KB | 40.4 KB |
| Data sent to the view when nothing changed | 96.7 KB | 158 bytes |
| The view reading that data | 0.20 ms | 0.07 ms |
| Download size | 7.9 MB | 8.2 MB |

### Fixed

- Changing `git-tree.date.type` or `git-tree.repository.useMailmap` updates the dates and names in the graph straight away. Before, they kept their old values until the next full refresh.

## [0.4.1] - 2026-10-27

### Added

- **Windows, macOS and every Linux.** One package holds the engine for Windows x64 and arm64, macOS 15 or later on Intel and Apple silicon, and Linux x64 and arm64 with glibc 2.28 or later or with musl (Alpine). 0.4.0 shipped only Linux x64.

### Changed

- **The engine reads the Commit Details View.** A commit's details and changed files, a stash's, a comparison of two commits, a file at a commit, a commit's subject, a remote's URL, an annotated tag's details and the configuration come from the engine instead of 2 to 5 `git` processes each. On a 6,750-commit repository, opening a small commit's details takes about 1 ms instead of 14 ms, and reading the configuration 0.4 ms instead of 26 ms. When Git might find a rename of a file that changed, or a diff depends on attributes or settings the engine doesn't model, Git reads it instead.
- **The engine reads the commit log incrementally, as Git does.** With a commit-graph file, a page of commits costs about the commits on it, in every order: 301 commits in author-date order take about 5 ms instead of 45 ms on a 6,750-commit repository. Without a commit-graph file, the engine reads each commit once, so the whole log takes about 64 ms instead of 88 ms, where Git takes 85 ms.
- **Git Tree needs its engine.** If the engine is missing or can't load, Git Tree shows a message that says why, instead of reading everything with `git`.

### Performance

Against 0.4.0, on a 6,750-commit repository, on Linux x64 with Git 2.55, median of 21 runs. 0.4.0 read the Commit Details View with `git`.

| | 0.4.0 | 0.4.1 |
| --- | ---: | ---: |
| Commit details, small commit | 14.3 ms | 0.8 ms |
| Configuration (Repository Settings) | 26.4 ms | 0.4 ms |
| Commit subject | 10.6 ms | 0.6 ms |
| A file at a commit | 6.0 ms | 0.6 ms |
| A remote's URL | 6.1 ms | 0.3 ms |
| Commit details, 30,841-line diff | 93.5 ms | 82.2 ms |
| Log, 301 commits, author-date order | 44.9 ms | 4.8 ms (Git: 55.2 ms) |
| Log, 301 commits, topological order | 5.7 ms | 3.8 ms (Git: 9.3 ms) |
| Whole log, no commit-graph file | 88.1 ms | 64.0 ms (Git: 85.4 ms) |
| Engine, Linux x64 | 1.9 MB | 2.1 MB |
| Download size | 1.2 MB, Linux x64 only | 7.9 MB, all eight platforms |

The subject, file and remote URL times come from a second run on a busy machine, which slows `git` more than the engine.

## [0.4.0] - 2026-10-27

### Added

- **A Rust engine.** Git Tree reads branches, remotes, stashes, worktrees, refs and the commit log in-process with gitoxide, instead of starting `git` for each. Opening the view takes about 7 ms instead of 19 ms on a 6,750-commit repository, and starts no `git` processes. When the engine can't be sure it would match Git, such as in a shallow clone, Git reads it instead. `git status` and every Git action still run `git`.

### Changed

- **The graph draws only the rows on screen.** With 5,000 commits loaded, drawing takes about 24 ms instead of 400 ms, the page holds about 1,600 elements instead of 48,000, and the view uses about 120 MB less memory.
- Find searches the loaded commits' data, so it finds commits whose rows aren't drawn yet.
- **Git Tree needs Git 2.31 or later**, released in March 2021. With an older Git, it shows a message that says which Git it found and how to fix it, instead of the graph.

### Performance

Against 0.3.5, on Linux x64 with Git 2.55. Opening the view is the median of 25 runs, with the versions taking turns.

| | 0.3.5 | 0.4.0 |
| --- | ---: | ---: |
| Opening the view, 6,750 commits | 19.4 ms | 7.0 ms |
| Opening the view, 6,750 commits, no commit-graph file | 63.9 ms | 45.3 ms |
| Opening the view, 63 commits | 10.6 ms | 3.2 ms |
| `git` processes started to open the view | 6 | 0 |
| Drawing 300 / 2,000 / 5,000 commits | 33 / 162 / about 400 ms | 24 / 22 / 24 ms |
| Elements on the page, 5,000 commits | about 48,000 | about 1,600 |
| View memory, 2,000 / 5,000 commits | 199 / 277 MB | 145 / 153 MB |
| Extension memory after 30 view loads | 33 MB | 28 MB |
| Download size | 336 KB | 1.2 MB, Linux x64 only |

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

[Unreleased]: https://github.com/sidhanthapoddar99/git-tree/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/sidhanthapoddar99/git-tree/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/sidhanthapoddar99/git-tree/compare/v0.6.2...v0.7.0
[0.6.2]: https://github.com/sidhanthapoddar99/git-tree/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/sidhanthapoddar99/git-tree/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/sidhanthapoddar99/git-tree/compare/v0.5.0...v0.6.0
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
