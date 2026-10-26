# Change Log

## 0.1.0

The first version of Git Tree, based on Git Graph's `develop` branch at commit `d7f43f4` (v1.31.0-beta).

* Shows worktrees in the graph. A branch checked out in another worktree carries the worktree's name, and a detached worktree gets its own label.
* Creates worktrees from a commit (with a new branch, or on a detached HEAD) or from a branch. New worktrees go in `.worktrees/` by default (`git-tree.worktree.defaultLocation`), and that folder is added to `.git/info/exclude`.
* Opens a worktree in a new or the current window, removes it, or copies its path.
* Hides Checkout and Delete for branches checked out in another worktree, because Git refuses them.
* Uses theme colours for rows, labels and inputs, with tuned values for light and dark themes, and a darker graph palette on light themes.
* New tree-shaped logo and icons.
* Renamed the commands, settings and diff scheme from `git-graph` to `git-tree`, so Git Tree can run next to Git Graph.
* Removed telemetry: the install, update and uninstall events that Git Graph sent.
* Removed the GitLab token that belongs to Git Graph's author. GitLab avatar lookups fall back to Gravatar when GitLab refuses an anonymous search.
