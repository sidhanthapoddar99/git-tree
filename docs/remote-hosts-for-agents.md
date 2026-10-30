# Remote hosts: an instruction for coding agents

Git Tree shows the worktrees on SSH servers in its graph, from the list in `.worktrees/git-tree.yaml`. Copy the block below into your agent's instructions, for example `CLAUDE.md` or `AGENTS.md`, so the agent keeps that list correct when it sets up work on another machine. The *Copy* button in the Remote Hosts panel copies the same block.

````markdown
## Git Tree remote hosts

Git Tree shows the worktrees on SSH servers in its graph. The list of servers is in
`.worktrees/git-tree.yaml`, in the repository's main worktree. Keep it correct when you
set up, move or finish work on another machine.

The file's format:

```yaml
version: 1
hosts:
  <name>:               # shown in the graph; letters, digits, - and _
    ssh: <alias>        # a Host alias from ~/.ssh/config
    path: <path>        # absolute path of the repository's main worktree on the server
    worktrees: false    # optional: show only the main worktree (default true: all of them)
    forwardAgent: true  # optional: forward the SSH agent to Git commands on the server (default false)
```

Rules:
- Use an SSH alias that already exists in `~/.ssh/config` (`ssh -G <alias>` prints it).
  Never put users, ports, keys, passwords or commands in this file.
- Before adding a host, check it works without a password, that `<path>` is a main worktree,
  and that it is the same project:
  `ssh -o BatchMode=yes <alias> git -C <path> rev-parse --path-format=absolute --git-common-dir`
  must print `<path>/.git`, and `ssh -o BatchMode=yes <alias> git -C <path> rev-list --max-parents=0 HEAD`
  must share a commit with `git rev-list --max-parents=0 HEAD` here.
- Write `worktrees` only to set it to `false`, and `forwardAgent` only to set it to `true`.
- Set `forwardAgent: true` only when the user asks for it. While Git Tree runs a clone, fetch,
  pull or push on that server, anyone with root there can use the user's SSH agent.
- Never commit this file. It's in `.worktrees/`, which Git Tree excludes.
- Edit only the host you're working on. Keep other entries, comments and order as they are.
- To make a worktree on a server, run `git worktree add` in that host's `path` repository
  (`git -C <path> worktree add <new path> <branch>`), so it shows up. You don't need to list
  worktrees in the file. A host with `worktrees: false` shows only its main worktree.
- When a server is gone for good, remove its entry.
````
