import { WorktreeListEntry } from './engine';

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
