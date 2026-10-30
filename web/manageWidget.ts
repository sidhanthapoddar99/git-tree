/** What the Manage panel knows of one host, and what it is doing on it. */
interface ManageHost {
	readonly name: string | null; // NULL => this machine
	requestId: number; // The request whose answers are shown. Older answers are ignored.
	git: GG.ManagedHostGit | null;
	gitError: string | null;
	loadingGit: boolean;
	sizes: GG.ManagedHostSizes | null;
	sizesError: string | null;
	loadingSizes: boolean;
	fastForwarding: string | null; // The path of the worktree being fast-forwarded
	readonly errors: { [path: string]: string }; // The last Fast-forward error of each worktree, by path
}

/** The Manage panel's responses, which it handles. */
type ManageResponse = GG.ResponseLoadWorktreeStats | GG.ResponseFastForwardWorktree;

/**
 * Implements the Manage panel: a card for each host, with its disk, and a row for each worktree and for the Git data
 * they share. Git's facts show at once, and each host's sizes fill in when they arrive.
 */
class ManageWidget {
	private readonly view: GitTreeView;

	private currentRepo: string | null = null;
	private hosts: ManageHost[] = [];
	private lastRequestId: number = 0;

	private readonly widgetElem: HTMLElement;
	private readonly contentsElem: HTMLElement;

	/**
	 * Construct a new ManageWidget instance.
	 * @param view The Git Tree View that the ManageWidget is for.
	 */
	constructor(view: GitTreeView) {
		this.view = view;

		this.widgetElem = document.createElement('div');
		this.widgetElem.id = 'manageWidget';
		this.widgetElem.className = 'bottomBarPanel';
		this.widgetElem.setAttribute('role', 'region');
		this.widgetElem.setAttribute('aria-label', 'Manage Worktrees');
		this.widgetElem.innerHTML = '<div class="settingsHeader"><div class="settingsHeaderTitles"><h2>Manage Worktrees</h2><div id="manageRepoName"></div></div>' +
			settingsIconButtonHtml('id="manageRefresh"', 'Refresh', SVG_ICONS.refresh) + settingsIconButtonHtml('id="manageClose"', 'Close Manage Worktrees', SVG_ICONS.close) + '</div><div id="manageContent"></div>';
		document.body.appendChild(this.widgetElem);

		this.contentsElem = document.getElementById('manageContent')!;
		document.getElementById('manageClose')!.addEventListener('click', () => this.close());
		document.getElementById('manageRefresh')!.addEventListener('click', () => this.load(null));
		this.contentsElem.addEventListener('click', (e) => {
			const button = (<HTMLElement>e.target).closest('[data-fast-forward]');
			if (button === null || (<HTMLButtonElement>button).disabled) return;
			const host = this.hosts[parseInt((<HTMLElement>button).dataset.host!)], index = parseInt((<HTMLElement>button).dataset.fastForward!);
			if (typeof host !== 'undefined' && host.git !== null && typeof host.git.worktrees[index] !== 'undefined') this.fastForward(host, host.git.worktrees[index].worktree.path);
		});
	}

	/**
	 * Show the Manage panel, and load each host.
	 * @param currentRepo The repository that is currently loaded in the view.
	 */
	public show(currentRepo: string) {
		if (this.currentRepo !== null) return;
		this.currentRepo = currentRepo;
		this.hosts = [];
		this.widgetElem.classList.add(CLASS_TRANSITION, CLASS_ACTIVE);
		const repoState = this.view.getRepoState(currentRepo);
		const repoNameElem = document.getElementById('manageRepoName')!;
		repoNameElem.textContent = repoState !== null && repoState.name !== null ? repoState.name : getRepoName(currentRepo);
		repoNameElem.title = currentRepo;
		this.view.renderPanelButtons();
		this.load(null);
	}

	/**
	 * Close the Manage panel. Answers that arrive later are ignored.
	 */
	public close() {
		if (this.currentRepo === null) return;
		this.currentRepo = null;
		this.hosts = [];
		this.widgetElem.classList.add(CLASS_TRANSITION);
		this.widgetElem.classList.remove(CLASS_ACTIVE);
		this.contentsElem.innerHTML = '';
		this.view.renderPanelButtons();
	}

	/**
	 * Is the Manage panel currently visible.
	 */
	public isVisible() {
		return this.currentRepo !== null;
	}

	/**
	 * Handle a response the Manage panel sent.
	 * @param msg The response.
	 * @returns TRUE => the panel handled it, FALSE => the panel has closed, or shows another repository.
	 */
	public processResponse(msg: ManageResponse) {
		if (this.currentRepo === null || msg.repo !== this.currentRepo) return false;
		const host = this.hosts.find((host) => host.name === msg.host);
		if (typeof host === 'undefined') return false;

		if (msg.command === 'fastForwardWorktree') {
			host.fastForwarding = null;
			if (msg.error !== null) {
				host.errors[msg.path] = msg.error;
			} else {
				delete host.errors[msg.path];
			}
			this.load(host);
			return true;
		}

		if (msg.requestId !== host.requestId) return true;
		if (msg.part === 'git') {
			host.loadingGit = false;
			host.git = msg.git;
			host.gitError = msg.error;
			if (msg.error !== null) {
				// The sizes aren't read without the Git, and old ones would describe other worktrees
				host.loadingSizes = false;
				host.sizes = null;
				host.sizesError = null;
			}
		} else {
			host.loadingSizes = false;
			host.sizes = msg.sizes;
			host.sizesError = msg.error;
		}
		this.render();
		return true;
	}


	/* Loading and Actions */

	/**
	 * Load hosts again: this machine, then each remote host that isn't hidden in the Hosts panel. A host keeps what
	 * it showed until its answers arrive.
	 * @param only The one host to load, or NULL for every host. Every host is loaded when the view's hosts changed.
	 */
	private load(only: ManageHost | null) {
		if (this.currentRepo === null) return;
		const names = [<string | null>null].concat(this.view.getAvailableRemoteHosts().map((host) => host.name));
		const everyHost = only === null || names.length !== this.hosts.length || names.some((name, i) => this.hosts[i].name !== name);
		if (everyHost) {
			this.hosts = names.map((name) => this.hosts.find((host) => host.name === name) || {
				name: name, requestId: 0, git: null, gitError: null, loadingGit: true, sizes: null, sizesError: null, loadingSizes: true, fastForwarding: null, errors: {}
			});
		}

		const requestId = ++this.lastRequestId, loading = everyHost || only === null ? this.hosts : [only];
		loading.forEach((host) => {
			host.requestId = requestId;
			host.loadingGit = true;
			host.loadingSizes = true;
		});
		sendMessage({ command: 'loadWorktreeStats', repo: this.currentRepo, hosts: loading.map((host) => host.name), requestId: requestId });
		this.render();
	}

	/**
	 * Fast-forward a worktree to the main branch. The extension checks every rule again before it runs.
	 * @param host The worktree's host.
	 * @param path The worktree's path.
	 */
	private fastForward(host: ManageHost, path: string) {
		if (this.currentRepo === null || host.fastForwarding !== null) return;
		host.fastForwarding = path;
		delete host.errors[path];
		sendMessage({ command: 'fastForwardWorktree', repo: this.currentRepo, host: host.name, path: path });
		this.render();
	}


	/* Render Methods */

	/**
	 * Render the Manage panel.
	 */
	private render() {
		if (this.currentRepo === null) return;
		const focus = captureSettingsFocus(this.contentsElem);
		this.contentsElem.innerHTML = this.hosts.map((host, index) => this.getHostHtml(host, index)).join('');
		restoreSettingsFocus(this.contentsElem, focus);
	}

	/**
	 * Get the HTML of a host's card.
	 * @param host The host.
	 * @param index The host's index, which its buttons carry.
	 * @returns The HTML.
	 */
	private getHostHtml(host: ManageHost, index: number) {
		const git = host.git, sizes = host.sizes;
		const spinner = settingsSpinnerHtml();

		// The sizes of each row, and their total, which the bars are a share of
		const sizeOf = (path: string) => {
			if (sizes === null) return null;
			const found = sizes.worktrees.find((size) => size.path === path);
			return typeof found !== 'undefined' ? found.size : null;
		};
		let total = 0, totalKnown = sizes !== null;
		if (sizes !== null) {
			sizes.worktrees.concat([sizes.gitData]).forEach((size) => {
				if (size.size !== null) total += size.size; else totalKnown = false;
			});
		}

		let description: string;
		if (host.gitError !== null || git === null) {
			description = host.name === null ? 'This machine' : 'Remote host';
		} else if (git.mainBranch !== null) {
			description = 'Main branch: <span class="mono">' + escapeHtml(git.mainBranch) + '</span>';
		} else {
			description = '<span title="' + escapeHtml(git.mainBranchError || '') + '">No main branch</span>';
		}

		const totalHtml = host.loadingSizes && sizes === null
			? spinner
			: sizes !== null ? '<span class="manageHostTotal" title="The worktrees and the Git data on this host, each counted once' + (totalKnown ? '' : '. Some sizes couldn\'t be measured, so this is too small') + '.">' + (totalKnown ? '' : '&ge; ') + formatKilobytes(total) + '</span>' : '';
		let html = '<section class="settingsCard manageHost' + (host.loadingGit ? ' loading' : '') + '"><header class="settingsCardHeader"><div class="settingsCardTitles"><h3>' +
			(host.name === null ? 'Local' : escapeHtml(host.name)) + (host.loadingGit && git !== null ? spinner : '') + '</h3><p class="settingsCardDescription">' + description + '</p></div>' +
			'<div class="settingsCardActions">' + totalHtml + '</div></header>';

		// The disk
		if (sizes !== null && sizes.disk !== null) {
			const disk = sizes.disk;
			html += '<div class="manageDisk"><div class="manageDiskText"><span>' + formatKilobytes(disk.used) + ' used of ' + formatKilobytes(disk.total) + '</span><span>' + formatKilobytes(disk.free) + ' free</span></div>' +
				settingsBarHtml(disk.total > 0 ? disk.used / disk.total : 0, 'The disk that holds the repository: ' + formatKilobytes(disk.used) + ' used, ' + formatKilobytes(disk.free) + ' free') + '</div>';
		}

		// The rows
		let body = '';
		if (host.gitError !== null) {
			body = settingsNoticeHtml('error', escapeHtml(host.gitError));
		} else if (git === null) {
			body = '<div class="settingsEmpty">' + spinner + 'Reading the worktrees' + ELLIPSIS + '</div>';
		} else {
			if (host.sizesError !== null) body += settingsNoticeHtml('error', escapeHtml(host.sizesError));
			if (sizes !== null && sizes.warning !== null) body += settingsNoticeHtml('info', escapeHtml(sizes.warning));
			const sizeHtml = (size: number | null, missing: boolean) => '<div class="manageRowSize">' + (host.loadingSizes && sizes === null
				? spinner
				: size !== null
					? '<span class="manageRowSizeText">' + formatKilobytes(size) + '</span>' + settingsBarHtml(total > 0 ? size / total : 0, formatKilobytes(size) + (total > 0 ? ' of ' + formatKilobytes(total) : ''))
					: '<span class="manageMuted" title="' + (missing ? 'The folder is missing' : 'The size couldn\'t be measured') + '">&mdash;</span>') + '</div>';

			body += git.worktrees.map((managed, worktreeIndex) => {
				const worktree = managed.worktree, path = escapeHtml(worktree.path);
				const busy = host.fastForwarding === worktree.path, refusal = host.fastForwarding !== null && !busy ? 'Another worktree is being fast-forwarded' : managed.fastForwardRefusal;
				const title = busy ? 'Fast-forwarding' + ELLIPSIS : refusal !== null ? escapeHtml(refusal) : 'Fast-forward ' + escapeHtml(worktree.branch || '') + ' to ' + escapeHtml(git.mainBranch || '');
				const error = host.errors[worktree.path];
				return '<div class="manageRow">' +
					'<div class="manageRowName"><span class="manageRowLabel" title="' + path + '">' + SVG_ICONS.worktree + '<span class="manageRowLabelText">' + escapeHtml(getWorktreeLabel(worktree)) + '</span></span>' +
					'<span class="manageRowBranch mono" title="' + (worktree.branch !== null ? escapeHtml(worktree.branch) : 'Detached HEAD') + '">' + (worktree.branch !== null ? escapeHtml(worktree.branch) : 'detached HEAD') + '</span></div>' +
					sizeHtml(worktree.prunable ? null : sizeOf(worktree.path), worktree.prunable) +
					'<div class="manageRowStatus">' + getManageStatusHtml(managed) + '</div>' +
					'<div class="manageRowRelation">' + getManageRelationHtml(managed, git) + '</div>' +
					'<div class="manageRowAction"><span class="manageButtonWrap" title="' + title + '">' +
					settingsButtonHtml('data-host="' + index + '" data-fast-forward="' + worktreeIndex + '" data-focus="ff:' + index + ':' + path + '" aria-label="Fast-forward ' + escapeHtml(getWorktreeLabel(worktree)) + ': ' + title + '"', 'Fast-forward', busy ? SVG_ICONS.loading : null, false, refusal !== null || busy) +
					'</span></div>' +
					(typeof error === 'string' ? '<div class="manageRowError">' + settingsNoticeHtml('error', escapeHtml(error)) + '</div>' : '') +
					'</div>';
			}).join('');

			// The Git data, which every worktree shares
			const gitData = sizes !== null ? sizes.gitData : null;
			body += '<div class="manageRow manageGitRow">' +
				'<div class="manageRowName"><span class="manageRowLabel"' + (gitData !== null ? ' title="' + escapeHtml(gitData.path) + '"' : '') + '>' + SVG_ICONS.package + '<span class="manageRowLabelText">Git data (.git)</span></span>' +
				'<span class="manageRowBranch">Shared by every worktree</span></div>' +
				sizeHtml(gitData !== null ? gitData.size : null, false) + '</div>';
		}

		return html + '<div class="settingsCardBody">' + body + '</div></section>';
	}
}

/**
 * Get the HTML of a worktree's status: clean, or how many files changed.
 * @param managed The worktree.
 * @returns The HTML.
 */
function getManageStatusHtml(managed: GG.ManagedWorktree) {
	if (managed.worktree.prunable) return '<span class="manageMuted" title="The worktree\'s folder no longer exists">Folder missing</span>';
	if (managed.changes === null) return '<span class="manageMuted" title="Git couldn\'t read its status">Unknown</span>';
	if (managed.changes === 0) return '<span class="manageClean" title="No uncommitted changes or untracked files">' + SVG_ICONS.check + 'Clean</span>';
	return '<span class="manageChanged" title="' + managed.changes + ' changed or untracked file' + (managed.changes === 1 ? '' : 's') + '">' + managed.changes + ' changed</span>';
}

/**
 * Get the HTML of how a worktree relates to the main branch.
 * @param managed The worktree.
 * @param git The host's Git.
 * @returns The HTML.
 */
function getManageRelationHtml(managed: GG.ManagedWorktree, git: GG.ManagedHostGit) {
	const relation = managed.relation, main = escapeHtml(git.mainBranch || 'main');
	const commits = (count: number) => count + ' commit' + (count === 1 ? '' : 's');
	switch (relation.kind) {
		case 'main':
			return '<span class="manageMuted">Main branch</span>';
		case 'detached':
			return '<span class="manageMuted" title="No branch is checked out">Detached</span>';
		case 'compared':
			if (relation.ahead > 0 && relation.behind > 0) return '<span class="manageDiverged" title="' + commits(relation.ahead) + ' ahead of ' + main + ', and ' + commits(relation.behind) + ' behind">Diverged</span>';
			if (relation.behind > 0) return '<span class="manageBehind" title="' + commits(relation.behind) + ' behind ' + main + '">' + relation.behind + ' behind</span>';
			if (relation.ahead > 0) return '<span title="' + commits(relation.ahead) + ' ahead of ' + main + '">' + relation.ahead + ' ahead</span>';
			return '<span class="manageMuted" title="The same commit as ' + main + '">Up to date</span>';
		default:
			return '<span class="manageMuted" title="' + escapeHtml(git.mainBranchError || 'Git couldn\'t compare it with ' + (git.mainBranch || 'the main branch')) + '">&mdash;</span>';
	}
}
