# Change Log

## 0.3.1

* **Choose the worktree to view.** A new *Worktree* dropdown in the top bar lists the main worktree and every linked worktree. The graph, the branch filter, uncommitted changes and Git actions then use that worktree. The tab's title names it when it isn't the main worktree. A worktree's context menu also has *Show This Worktree*.
* **Uncommitted changes in every worktree.** Each worktree with uncommitted changes gets its own *Uncommitted Changes* row, labelled with the worktree's name and drawn from the commit it's on. Click the row to switch to that worktree and see its changes. When Git can't read a worktree's status, the row says so. Every worktree is watched, including those outside the repository, so the rows stay up to date.
* **Worktree location setting.** `git-tree.worktree.defaultLocation` now has its own *Worktrees* section in the Settings editor. It takes a path relative to the repository, `~` for your home folder, an absolute path, and `{repo}` for the repository's folder name, for example `~/worktrees/{repo}`. The Create Worktree dialog accepts the same forms.
* **Copy a file's path in another worktree.** In Commit Details, a file's context menu has *Copy Absolute File Path in Another Worktree...*, because the same file has a different absolute path in each worktree.
* **A top bar that stays on one row.** In a narrow view, the dropdowns shrink and the text labels hide, instead of the controls wrapping onto more rows. An open dropdown keeps its full width and stays inside the view.
* **When several worktrees exist, every one is labelled**, including the one being viewed.
* New logo and icons: three branches growing from one root.

## 0.2.0

* **One tab per repository.** A repository opens in the tab that already shows it, or in a new tab, so you can keep several repositories open side by side. *View Git Tree in New Tab...* (a command, and a button in the tab's title bar) opens another one. Each tab's title names its repository.
* **Faster loading in large repositories.** When a repository has no Git commit-graph file, Git Tree writes one in the background (`git-tree.repository.writeCommitGraph`). On a 16k-commit repository, loading the graph's data went from 113 ms to 25 ms. `git status` also runs alongside `git log` now, instead of after it.
* **Faster tab switching.** A tab that was kept alive while hidden refreshes when shown, instead of reloading the whole page.
* Needs Visual Studio Code 1.82 or later.
* Fixes:
    * Interactive rebase can no longer run shell commands hidden in a branch name.
    * A carriage return in a commit subject no longer hides all older commits.
    * A tag that has the same name as a branch can be pushed and deleted on a remote.
    * The branch list works when the Git setting `column.ui` is on.
    * Commit Details no longer hangs on a folder named `constructor`, or on a folder replaced by a file.
    * Pasting a name with the mouse enables the dialog's button.
    * Long histories no longer overflow the stack when hovering the graph or muting commits.
    * Keyboard navigation picks the right alternative branch.
    * The Git Tree button appears on each repository in the Source Control view of newer Visual Studio Code.
    * The view command no longer fails when it is given an empty argument.

## 0.1.0

The first version of Git Tree.

* Shows worktrees in the graph. A branch checked out in another worktree carries the worktree's name, and a detached worktree gets its own label.
* Creates worktrees from a commit (with a new branch, or on a detached HEAD) or from a branch. New worktrees go in `.worktrees/` by default (`git-tree.worktree.defaultLocation`), and that folder is added to `.git/info/exclude`.
* Opens a worktree in a new or the current window, removes it, or copies its path.
* Hides Checkout and Delete for branches checked out in another worktree, because Git refuses them.
* Uses theme colours for rows, labels and inputs, with tuned values for light and dark themes, and a darker graph palette on light themes.
* New tree-shaped logo and icons.
* Sends no telemetry.
