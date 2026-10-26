import * as crypto from 'crypto';
import { GitCommitData } from './dataSource';
import { CompactCommit, CompactCommitRemote, CompactCommitTag, CompactCommits, GitCommit, ResponseLoadCommits } from './types';
import { UNCOMMITTED } from './utils';

/**
 * Encode GitCommit rows in the compact form the webview decodes with `decodeCommits` (web/compactCommits.ts).
 * @param commits The rows.
 * @returns The rows in the compact form.
 */
export function encodeCommits(commits: ReadonlyArray<GitCommit>): CompactCommits {
	const people: string[] = [], personLookup = new Map<string, number>(), indexLookup = new Map<string, number>();
	for (let i = commits.length - 1; i >= 0; i--) {
		indexLookup.set(commits[i].hash, i);
	}

	const rows: CompactCommit[] = new Array(commits.length);
	for (let i = 0; i < commits.length; i++) {
		const commit = commits[i], personKey = commit.author + '\0' + commit.email;
		let person = personLookup.get(personKey);
		if (person === undefined) {
			person = people.length / 2;
			personLookup.set(personKey, person);
			people.push(commit.author, commit.email);
		}
		const parents = commit.parents.map((parent) => {
			const index = indexLookup.get(parent);
			return index !== undefined ? index : parent;
		});

		// The optional fields go up to the last one that is set, and the ones before it hold their empty value
		const worktree = typeof commit.worktree === 'string' ? commit.worktree : null;
		const last = worktree !== null ? 9 : commit.stash !== null ? 8 : commit.remotes.length > 0 ? 7 : commit.tags.length > 0 ? 6 : commit.heads.length > 0 ? 5 : 4;
		const row: (CompactCommit[number])[] = [commit.hash, parents, person, commit.date, commit.message];
		if (last >= 5) row.push(commit.heads);
		if (last >= 6) row.push(commit.tags.map((tag): CompactCommitTag => [tag.name, tag.annotated ? 1 : 0]));
		if (last >= 7) row.push(commit.remotes.map((remote): CompactCommitRemote => [remote.name, remote.remote]));
		if (last >= 8) row.push(commit.stash !== null ? [commit.stash.selector, commit.stash.baseHash, commit.stash.untrackedFilesHash] : null);
		if (last >= 9) row.push(worktree);
		rows[i] = <CompactCommit><unknown>row;
	}
	return { people: people, rows: rows };
}

/**
 * Get the token of a page of commits: the SHA-1 of what the view shows from it, apart from the rows of uncommitted changes.
 * It is taken from the encoded rows, so it is the same however the commits were read (with the engine or the Git CLI).
 * @param history The rows after the leading rows of uncommitted changes, encoded.
 * @param head The commit HEAD points to.
 * @param tags The names of the tags in the repository.
 * @param moreCommitsAvailable Are there more commits after the page.
 * @param onlyFollowFirstParent Was the page read following only the first parent of commits.
 * @returns The token, as hexadecimal.
 */
export function getCommitsToken(history: CompactCommits, head: string | null, tags: ReadonlyArray<string>, moreCommitsAvailable: boolean, onlyFollowFirstParent: boolean) {
	return crypto.createHash('sha1').update(JSON.stringify([history, head, tags, moreCommitsAvailable, onlyFollowFirstParent])).digest('hex');
}

/**
 * Create the response to a RequestLoadCommits. When the request's token describes the page, the response is `unchanged`,
 * and has only the rows of uncommitted changes, because the view already shows the rest.
 * @param refreshId The request's refresh ID.
 * @param onlyFollowFirstParent The request's `onlyFollowFirstParent`.
 * @param requestToken The request's token.
 * @param data The commits DataSource read.
 * @returns The response.
 */
export function createLoadCommitsResponse(refreshId: number, onlyFollowFirstParent: boolean, requestToken: string | null, data: GitCommitData): ResponseLoadCommits {
	const commits = data.commits;
	let split = 0;
	while (split < commits.length && commits[split].hash.startsWith(UNCOMMITTED)) {
		split++;
	}
	const uncommitted = encodeCommits(commits.slice(0, split)), history = encodeCommits(commits.slice(split));
	const token = data.error === null ? getCommitsToken(history, data.head, data.tags, data.moreCommitsAvailable, onlyFollowFirstParent) : null;

	if (token !== null && token === requestToken) {
		return { command: 'loadCommits', refreshId: refreshId, unchanged: true, uncommitted: uncommitted, token: token, error: null };
	}
	return {
		command: 'loadCommits',
		refreshId: refreshId,
		unchanged: false,
		uncommitted: uncommitted,
		commits: history,
		head: data.head,
		tags: data.tags,
		moreCommitsAvailable: data.moreCommitsAvailable,
		onlyFollowFirstParent: onlyFollowFirstParent,
		token: token,
		error: data.error
	};
}
