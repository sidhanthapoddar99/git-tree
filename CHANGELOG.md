# Changelog

All notable changes to Git Tree are recorded in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Git Tree uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- New logo and icons: three branches at the top meet in one hub commit, and three lines run below it, one through another commit.

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

[Unreleased]: https://github.com/sidhanthapoddar99/git-tree/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/sidhanthapoddar99/git-tree/compare/v0.2.0...v0.3.1
[0.2.0]: https://github.com/sidhanthapoddar99/git-tree/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/sidhanthapoddar99/git-tree/releases/tag/v0.1.0
