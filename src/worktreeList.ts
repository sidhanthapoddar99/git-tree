import { WorktreeListEntry } from './engine';
import { GitWorktree } from './types';

/**
 * Parse the output of `git worktree list --porcelain`.
 * @param stdout The output of the command.
 * @returns An array of the records, with the main worktree first.
 */
export function parseWorktreeList(stdout: string) {
	const entries: WorktreeListEntry[] = [];
	const records = stdout.split(/\r?\n\r?\n/);
	for (let i = 0; i < records.length; i++) {
		let worktreePath: string | null = null, head: string | null = null, branch: string | null = null;
		let bare = false, locked = false, prunable = false;
		const lines = records[i].split(/\r\n|\r|\n/g);
		for (let j = 0; j < lines.length; j++) {
			const line = lines[j];
			if (line.startsWith('worktree ')) {
				worktreePath = line.substring(9);
			} else if (line.startsWith('HEAD ')) {
				head = line.substring(5);
			} else if (line.startsWith('branch ')) {
				branch = line.substring(7);
			} else if (line === 'bare') {
				bare = true;
			} else if (line === 'locked' || line.startsWith('locked ')) {
				locked = true;
			} else if (line === 'prunable' || line.startsWith('prunable ')) {
				prunable = true;
			}
		}
		entries.push({ path: worktreePath, head: head, branch: branch, bare: bare, locked: locked, prunable: prunable });
	}
	return entries;
}

/**
 * Get a worktree from its record in `git worktree list --porcelain`. This machine's worktrees, a remote host's and the
 * Manage panel's all use it, so they read a record the same way.
 * @param entry The record.
 * @param worktreePath The worktree's path, as the caller shows it.
 * @param name The worktree's name: its folder's name.
 * @param isMain Is it the main worktree (the first record).
 * @returns The worktree. It isn't marked as the current worktree: the caller does that.
 */
export function getWorktreeFromEntry(entry: WorktreeListEntry, worktreePath: string, name: string, isMain: boolean): GitWorktree {
	return {
		path: worktreePath,
		name: name,
		head: entry.head === null || /^0+$/.test(entry.head) ? null : entry.head,
		branch: entry.branch === null ? null : entry.branch.replace(/^refs\/heads\//, ''),
		isMain: isMain,
		isCurrent: false,
		locked: entry.locked,
		prunable: entry.prunable
	};
}
