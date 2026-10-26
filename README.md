# Git Tree

**A Git graph for Visual Studio Code that understands worktrees.** See every branch, tag, stash and worktree in one graph, see each worktree's uncommitted changes, and run Git actions from a right-click.

<!-- Marketplace badges, once Git Tree is published:
[![Version](https://vsmarketplacebadges.dev/version-short/<publisher>.git-tree.png)](https://marketplace.visualstudio.com/items?itemName=<publisher>.git-tree)
[![Installs](https://vsmarketplacebadges.dev/installs-short/<publisher>.git-tree.png)](https://marketplace.visualstudio.com/items?itemName=<publisher>.git-tree)
-->
[![VS Code](https://img.shields.io/badge/VS%20Code-1.82%2B-007ACC.svg)](https://code.visualstudio.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

<!-- ![Git Tree showing a repository with three worktrees in a dark theme](docs/images/hero-dark.webp) -->

## Why Git Tree?

Worktrees let you keep several branches checked out at once, each in its own folder. Most Git graphs don't know they exist: a branch checked out in another worktree looks like any other branch, and changes waiting in that worktree are invisible. Git Tree puts worktrees in the graph.

### Features

- 🌳 **Worktrees in the graph.** A Worktree column labels every worktree on the commit it's on, and each worktree's uncommitted changes get their own row.
- 🔎 **A worktree filter.** Show one worktree's history and changes, the main worktree's, or everything at once.
- 🛠️ **Worktree actions.** Create a worktree from a commit or a branch, open it in a new window, remove it, or copy its path. Ctrl+click a worktree to open it.
- 🗂️ **One tab per repository.** Keep several repositories open side by side.
- ⚡ **Fast in large repositories.** Git Tree writes Git's commit-graph file when a repository has none, which makes the graph load up to four times faster.
- 🎨 **Follows your theme.** Rows, labels, dialogs and the graph's colours are tuned for light and dark themes.
- 🔒 **No telemetry.** Git Tree sends no usage data.

And everything you expect from a Git graph: branches, merges, tags, stashes and remote branches; checkout, merge, rebase, cherry-pick, reset, push and pull from a right-click; commit details with diffs; and comparing any two commits.

<!-- ![The same repository in a light theme](docs/images/graph-light.webp) -->

## Getting started

1. Install Git Tree from the Extensions view (search for "Git Tree"), or install a `.vsix` with *Extensions: Install from VSIX...*.
2. Open a folder that is a Git repository.
3. Open the graph in any of these ways:
   - click **Git Tree** in the status bar
   - run **Git Tree: View Git Tree** from the Command Palette
   - click the Git Tree button on a repository in the Source Control view

## Worktrees

### See every worktree

The **Worktree** column shows which worktree has each commit checked out. A branch that's checked out in a worktree keeps its branch label in the description, and the worktree's label sits in the Worktree column on the same row. The column appears when a repository has more than one worktree, and `git-tree.defaultColumnVisibility` can hide it.

Each worktree with uncommitted changes gets its own **Uncommitted Changes** row, drawn from the commit it's on and labelled with the worktree's name. Git Tree watches every worktree, including those outside the repository's folder, so the rows stay up to date.

<!-- ![Uncommitted changes in three worktrees](docs/images/worktree-changes.webp) -->

### Filter by worktree

The **Worktree** dropdown in the top bar filters the graph, the way the Branches dropdown does:

| Choice | Shows |
| --- | --- |
| **All** | Every branch, and every worktree's uncommitted changes |
| **Root** (the default) | The main worktree's history and its uncommitted changes |
| *a worktree's name* | That worktree's history and its uncommitted changes |

Git actions, such as checkout, commit details and opening files, run in the worktree you pick. Branches you pick in the Branches dropdown are shown as well. The dropdown appears when a repository has more than one worktree.

<!-- ![The Worktree dropdown](docs/images/worktree-filter.webp) -->

### Create, open and remove worktrees

Right-click to work with worktrees:

- **A commit:** *Create Worktree...*. Enter a new branch name to create that branch at the commit and check it out in the worktree, or leave it blank for a detached HEAD.
- **A branch that isn't checked out:** *Create Worktree...* checks the branch out in a new worktree.
- **A branch checked out in another worktree:** *Open Worktree in New Window*. Git won't check out or delete such a branch, so those actions are hidden.
- **A worktree label:** show the worktree, open it in a new window or this one, remove it, or copy its path.

**Ctrl+click** (**Cmd+click** on macOS) or double-click a worktree label to open that worktree in a new VS Code window.

<!-- ![Creating a worktree](docs/images/create-worktree.webp) -->

### Where new worktrees go

New worktrees go in the `.worktrees` folder of the main worktree by default, for example `.worktrees/feature-login`. Type another folder in the dialog, or change the default with `git-tree.worktree.defaultLocation`. Both accept:

| Form | Example | Means |
| --- | --- | --- |
| A relative path | `.worktrees`, `../{repo}-worktrees` | Relative to the main worktree |
| A home path | `~/worktrees/{repo}` | Inside your home folder |
| An absolute path | `/srv/worktrees` | Exactly that folder |

`{repo}` becomes the repository's folder name, which keeps each repository's worktrees apart. When the folder is inside the repository, Git Tree adds it to `.git/info/exclude`, so the worktrees don't show up as untracked files.

### File paths in worktrees

A file has a different absolute path in each worktree. In Commit Details, Open File and Copy Absolute File Path use the worktree you're viewing. To copy the path in another worktree, right-click the file and choose *Copy Absolute File Path in Another Worktree...*.

## Everyday use

### Commit details and comparisons

Click a commit to see its details and changed files. Click a file to see its diff, or right-click it to open the file, view it at that commit, or copy its path. Ctrl+click (Cmd+click) a second commit to compare the two.

<!-- ![A commit's details](docs/images/commit-details.webp) -->

### Tabs

Each Git Tree tab shows one repository, and its title names the repository and the worktree. Opening a repository switches to the tab that already shows it, or opens a new one. Run *Git Tree: View Git Tree in New Tab...*, or click **+** in a Git Tree tab's title bar, to open another tab.

### More

- **Branches dropdown:** show all branches, pick some, or use your own glob patterns (`git-tree.customBranchGlobPatterns`).
- **Find** (Ctrl/Cmd+F): find commits by message, date, author, hash, branch or tag.
- **Code review:** keep track of the files you've reviewed in a commit or a comparison. Reviews last across sessions.
- **Repository settings:** manage remotes, link issue numbers in commit messages to your tracker, and set up pull request creation for GitHub, GitLab, Bitbucket or your own provider.
- **Columns:** resize them, and show or hide Date, Author, Commit and Worktree.

### Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| Ctrl/Cmd+F | Find |
| Ctrl/Cmd+H | Scroll to the HEAD commit |
| Ctrl/Cmd+R | Refresh |
| Ctrl/Cmd+S, Ctrl/Cmd+Shift+S | Scroll to the next or previous stash |
| Up, Down | With Commit Details open: the commit above or below |
| Ctrl/Cmd+Up, Ctrl/Cmd+Down | With Commit Details open: the child or parent commit on the same branch (add Shift to follow the other branch) |
| Enter | Submit a dialog |
| Escape | Close a dialog, a menu or Commit Details |

## Settings

All settings start with `git-tree.`. Search for "Git Tree" in the Settings editor to see each one. Settings that are new in Git Tree:

| Setting | Default | What it does |
| --- | --- | --- |
| `git-tree.worktree.defaultLocation` | `.worktrees` | The folder new worktrees go in. See [Where new worktrees go](#where-new-worktrees-go). |
| `git-tree.repository.writeCommitGraph` | on | Writes Git's [commit-graph](https://git-scm.com/docs/git-commit-graph) file in the background when a repository has none. Needs Git 2.24 or later. |

If `git-tree.graph.colours` isn't set, the graph uses a darker palette on light themes. A repository's shared Git Tree configuration lives in `.vscode/vscode-git-tree.json`.

## Commands

| Command | What it does |
| --- | --- |
| Git Tree: View Git Tree | Opens the graph |
| Git Tree: View Git Tree in New Tab... | Opens a repository in another tab |
| Git Tree: Fetch from Remote(s) | Opens the graph and fetches |
| Git Tree: Add Git Repository... | Adds a repository that wasn't found automatically |
| Git Tree: Remove Git Repository... | Removes a repository from Git Tree |
| Git Tree: Resume a specific Code Review in Workspace... | Reopens a code review in progress |
| Git Tree: End a specific Code Review in Workspace... | Ends one code review |
| Git Tree: End All Code Reviews in Workspace | Ends every code review |
| Git Tree: Clear Avatar Cache | Clears the cached author avatars |
| Git Tree: Get Version Information | Shows the versions of Git Tree, Git and VS Code |

## Requirements

- Visual Studio Code 1.82 or later
- Git. Worktrees need Git 2.7 or later, and the commit-graph file needs Git 2.24 or later.

## Known limitations

- Git Tree draws every loaded commit. Very long histories take longer to draw; *Load More Commits* loads them in steps.
- Each worktree adds one `git status` to every refresh, so a repository with many worktrees refreshes more slowly.

## Support

- Report a bug or ask for a feature in [GitHub Issues](https://github.com/sidhanthapoddar99/git-tree/issues).
- The [changelog](CHANGELOG.md) lists what changed in each version.
- To work on Git Tree itself, see the [developer guide](CONTRIBUTING.md).

## License

Git Tree is under the MIT License in [LICENSE](LICENSE). Some code and icons come from other projects, under the licenses in the [licenses](licenses) folder.

Some of the icons are from the following sources:
- [GitHub Octicons](https://octicons.github.com/) ([License](https://github.com/primer/octicons/blob/master/LICENSE))
- [Icons8](https://icons8.com/icon/pack/free-icons/ios11) ([License](https://icons8.com/license))
