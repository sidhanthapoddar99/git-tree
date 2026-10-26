# Git Tree

Git Tree is a Visual Studio Code extension that shows a Git graph of your repository, with its worktrees, and lets you run Git actions from the graph.

Its highlights:

* **Worktrees in the graph.** A branch that is checked out in another worktree shows that worktree's name on its label. A worktree on a detached HEAD gets its own label on its commit.
* **Worktree actions.** Create a worktree from a commit or a branch, open it in a new or the current window, remove it, or copy its path.
* **One tab per repository.** Keep several repositories open in their own tabs, side by side.
* **Fast in large repositories.** Git Tree writes Git's commit-graph file when a repository has none, which makes the graph load several times faster.
* **Colours that follow your theme.** Rows, labels, inputs and the graph palette are tuned for light and dark themes.
* **No telemetry.** Git Tree sends no usage data.

## Worktrees

Right-click to use worktrees:

* **A commit:** *Create Worktree...* Enter a new branch name to create that branch at the commit and check it out in the worktree. Leave the branch blank to check out the commit itself (a detached HEAD).
* **A branch that isn't checked out:** *Create Worktree...* checks the branch out in a new worktree.
* **A branch that is checked out in another worktree:** *Open Worktree in New Window*. Git won't check out or delete such a branch, so those actions are hidden.
* **A worktree label:** open the worktree in a new window or this one, remove it, or copy its path. Double-click a worktree label to open it in a new window.

New worktrees go in the `.worktrees` folder of the main worktree by default, for example `.worktrees/feature-login`. You can type another folder in the dialog, or change the default with `git-tree.worktree.defaultLocation`. When the folder is inside the repository, Git Tree adds it to `.git/info/exclude`, so the worktrees don't show up as untracked files.

## Tabs

Each Git Tree tab shows one repository, and its title names it. Opening a repository, for example with the Git Tree button on a repository in the Source Control view, switches to the tab that already shows it. If no tab shows it, it opens in a new tab. To open another tab yourself, run *Git Tree: View Git Tree in New Tab...* or click the **+** button in a Git Tree tab's title bar. The *Repo* dropdown still switches the repository inside a tab.

## Features

* Git Tree View:
    * Display:
        * Local & Remote Branches
        * Local Refs: Heads, Tags & Remotes
        * Uncommitted Changes
    * Perform Git Actions (available by right clicking on a commit / branch / tag):
        * Create, Checkout, Delete, Fetch, Merge, Pull, Push, Rebase, Rename & Reset Branches
        * Add, Delete & Push Tags
        * Checkout, Cherry Pick, Drop, Merge & Revert Commits
        * Clean, Reset & Stash Uncommitted Changes
        * Apply, Create Branch From, Drop & Pop Stashes
        * View annotated tag details (name, email, date and message)
        * Copy commit hashes, and branch, stash & tag names to the clipboard
    * View commit details and file changes by clicking on a commit. On the Commit Details View you can:
        * View the Visual Studio Code Diff of any file change by clicking on it.
        * Open the current version of any file that was affected in the commit.
        * Copy the path of any file that was affected in the commit to the clipboard.
        * Click on any HTTP/HTTPS url in the commit body to open it in your default web browser.
    * Compare any two commits by clicking on a commit, and then CTRL/CMD clicking on another commit. On the Commit Comparison View you can:
        * View the Visual Studio Code Diff of any file change between the selected commits by clicking on it.
        * Open the current version of any file that was affected between the selected commits.
        * Copy the path of any file that was affected between the selected commits to the clipboard.
    * Code Review - Keep track of which files you have reviewed in the Commit Details & Comparison Views.
        * Code Review's can be performed on any commit, or between any two commits (not on Uncommitted Changes).
        * When a Code Review is started, all files needing to be reviewed are bolded. When you view the diff / open a file, it will then be un-bolded.
        * Code Reviews persist across Visual Studio Code sessions. They are automatically closed after 90 days of inactivity.
    * View uncommitted changes, and compare the uncommitted changes with any commit.
    * Hover over any commit vertex on the graph to see a tooltip indicating:
        * Whether the commit is included in the HEAD.
        * Which branches, tags and stashes include the commit. 
    * Filter the branches shown in Git Tree using the 'Branches' dropdown menu. The options for filtering the branches are:
        * Show All branches
        * Select one or more branches to be viewed
        * Select from a user predefined array of custom glob patterns (by setting `git-tree.customBranchGlobPatterns`)
    * Fetch from Remote(s) _(available on the top control bar)_
    * Find Widget allows you to quickly find one or more commits containing a specific phrase (in the commit message / date / author / hash, branch or tag names).
    * Repository Settings Widget:
        * Allows you to view, add, edit, delete, fetch & prune remotes of the repository.
        * Configure "Issue Linking" - Converts issue numbers in commit messages into hyperlinks, that open the issue in your issue tracking system.
        * Configure "Pull Request Creation" - Automates the opening and pre-filling of a Pull Request form, directly from a branches context menu.
            * Support for the publicly hosted Bitbucket, GitHub and GitLab Pull Request providers is built-in.
            * Custom Pull Request providers can be configured using the Extension Setting `git-tree.customPullRequestProviders` (e.g. for use with privately hosted Pull Request providers).
        * Export your Git Tree Repository Configuration to a file that can be committed in the repository. It allows others working in the same repository to automatically use the same Git Tree configuration.
    * Keyboard Shortcuts (available in the Git Tree View):
        * `CTRL/CMD + F`: Open the Find Widget.
        * `CTRL/CMD + H`: Scrolls the Git Tree View to be centered on the commit referenced by HEAD.
        * `CTRL/CMD + R`: Refresh the Git Tree View.
        * `CTRL/CMD + S`: Scrolls the Git Tree View to the first (or next) stash in the loaded commits.
        * `CTRL/CMD + SHIFT + S`: Scrolls the Git Tree View to the last (or previous) stash in the loaded commits.
        * When the Commit Details View is open on a commit:
            * `Up` / `Down`: The Commit Details View will be opened on the commit directly above or below it on the Git Tree View.
            * `CTRL/CMD + Up` / `CTRL/CMD + Down`: The Commit Details View will be opened on its child or parent commit on the same branch.
                * If the Shift Key is also pressed (i.e. `CTRL/CMD + SHIFT + Up` / `CTRL/CMD + SHIFT + Down`), when branches or merges are encountered the alternative branch is followed.
        * `Enter`: If a dialog is open, pressing enter submits the dialog, taking the primary (left) action.
        * `Escape`: Closes the active dialog, context menu or the Commit Details View.
    * Resize the width of each column, and show/hide the Date, Author & Commit columns.
    * Common Emoji Shortcodes are automatically replaced with the corresponding emoji in commit messages (including all [gitmoji](https://gitmoji.carloscuesta.me/)). Custom Emoji Shortcode mappings can be defined in `git-tree.customEmojiShortcodeMappings`.
* A broad range of configurable settings (e.g. graph style, branch colours, and more...). See the 'Extension Settings' section below for more information.
* "Git Tree" launch button in the Status Bar
* "Git Tree: View Git Tree" launch command in the Command Palette


## Extension Settings

All settings start with `git-tree.`. Search for "Git Tree" in the Settings editor to see each one with its description. A repository's shared configuration file is `.vscode/vscode-git-tree.json`.

Settings that are new in Git Tree:

* `git-tree.worktree.defaultLocation`: The folder new worktrees are created in, relative to the main worktree, or an absolute path. Default: `.worktrees`.
* `git-tree.repository.writeCommitGraph`: When a repository has no [commit-graph](https://git-scm.com/docs/git-commit-graph) file, write one in the background. It is the file `git gc` writes, and it needs Git 2.24 or later. Default: on.

If `git-tree.graph.colours` is not set, the graph uses a darker palette on light themes. Custom colours are used on every theme.

## Extension Commands

This extension contributes the following commands:

* `git-tree.view`: Git Tree: View Git Tree
* `git-tree.viewInNewTab`: Git Tree: View Git Tree in New Tab... _(opens a repository in another tab)_
* `git-tree.addGitRepository`: Git Tree: Add Git Repository... _(used to add sub-repos to Git Tree)_
* `git-tree.clearAvatarCache`: Git Tree: Clear Avatar Cache
* `git-tree.endAllWorkspaceCodeReviews`: Git Tree: End All Code Reviews in Workspace
* `git-tree.endSpecificWorkspaceCodeReview`: Git Tree: End a specific Code Review in Workspace... _(used to end a specific Code Review without having to first open it in the Git Tree View)_
* `git-tree.fetch`: Git Tree: Fetch from Remote(s) _(used to open the Git Tree View and immediately run "Fetch from Remote(s)")_
* `git-tree.removeGitRepository`: Git Tree: Remove Git Repository... _(used to remove repositories from Git Tree)_
* `git-tree.resumeWorkspaceCodeReview`: Git Tree: Resume a specific Code Review in Workspace... _(used to open the Git Tree View to a Code Review that is already in progress)_
* `git-tree.version`: Git Tree: Get Version Information

## Building from Source

You need Node.js and Git.

```sh
npm install
npm run compile      # lint, then build ./out and ./media
npm test             # run the Jest tests
npx @vscode/vsce package   # build git-tree-<version>.vsix
```

Install the `.vsix` with *Extensions: Install from VSIX...* in Visual Studio Code.

## Release Notes

The release notes are in [CHANGELOG.md](CHANGELOG.md).

## Credits and License

Git Tree is under the MIT License in [LICENSE](LICENSE). Some code and icons come from other projects, under the licenses in the [licenses](licenses) folder.

Some of the icons are from the following sources:
- [GitHub Octicons](https://octicons.github.com/) ([License](https://github.com/primer/octicons/blob/master/LICENSE))
- [Icons8](https://icons8.com/icon/pack/free-icons/ios11) ([License](https://icons8.com/license))
