/**
 * Decode GitCommit rows from the compact form the extension encodes them in, with `encodeCommits` (src/compactCommits.ts).
 * @param compact The rows in the compact form.
 * @returns The rows.
 */
function decodeCommits(compact: GG.CompactCommits): GG.GitCommit[] {
	const rows = compact.rows, people = compact.people, commits: GG.GitCommit[] = new Array(rows.length);
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i], person = row[2] * 2, heads = row[5], tags = row[6], remotes = row[7], stash = row[8], worktree = row[9];
		const commit: GG.Writeable<GG.GitCommit> = {
			hash: row[0],
			parents: row[1].map((parent) => typeof parent === 'number' ? rows[parent][0] : parent),
			author: people[person],
			email: people[person + 1],
			date: row[3],
			message: row[4],
			heads: typeof heads !== 'undefined' ? heads : [],
			tags: typeof tags !== 'undefined' ? tags.map((tag) => ({ name: tag[0], annotated: tag[1] === 1 })) : [],
			remotes: typeof remotes !== 'undefined' ? remotes.map((remote) => ({ name: remote[0], remote: remote[1] })) : [],
			stash: typeof stash !== 'undefined' && stash !== null ? { selector: stash[0], baseHash: stash[1], untrackedFilesHash: stash[2] } : null
		};
		if (typeof worktree === 'string') {
			commit.worktree = worktree;
		}
		commits[i] = commit;
	}
	return commits;
}

/**
 * Do two lists of commits hold the same value in every field? A token describes every field of the rows it was made from,
 * so the view keeps a token only while its rows are identical to them.
 * @param a The first list of commits.
 * @param b The second list of commits.
 * @returns TRUE => the lists are identical, FALSE => they differ.
 */
function areCommitsIdentical(a: ReadonlyArray<GG.GitCommit>, b: ReadonlyArray<GG.GitCommit>) {
	return a.length === b.length && a.every((commit, i) => isCommitIdentical(commit, b[i]));
}

/**
 * Do two commits hold the same value in every field?
 * @param x The first commit.
 * @param y The second commit.
 * @returns TRUE => the commits are identical, FALSE => they differ.
 */
function isCommitIdentical(x: GG.GitCommit, y: GG.GitCommit) {
	if (x === y) return true;
	const stringsEqual = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) => a.length === b.length && a.every((value, i) => value === b[i]);
	return x.hash === y.hash && x.author === y.author && x.email === y.email && x.date === y.date && x.message === y.message && x.worktree === y.worktree &&
		stringsEqual(x.parents, y.parents) && stringsEqual(x.heads, y.heads) &&
		x.tags.length === y.tags.length && x.tags.every((tag, j) => tag.name === y.tags[j].name && tag.annotated === y.tags[j].annotated) &&
		x.remotes.length === y.remotes.length && x.remotes.every((remote, j) => remote.name === y.remotes[j].name && remote.remote === y.remotes[j].remote) &&
		(x.stash === null || y.stash === null
			? x.stash === y.stash
			: x.stash.selector === y.stash.selector && x.stash.baseHash === y.stash.baseHash && x.stash.untrackedFilesHash === y.stash.untrackedFilesHash);
}
