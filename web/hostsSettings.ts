/* The Hosts panel
 * A row for this machine (Local), then one for each remote host in .worktrees/git-tree.yaml, each with how much of its
 * processors, memory, disk and graphics cards is in use, and the form that adds or edits a remote host, with a browser
 * of the server's folders. Each action sends its own message, and its response comes back through
 * HostsSettings.processResponse. While the panel is open, the extension reads the usage of the hosts it watches
 * (watchHostStats), and answers with a hostStats response for each read. */

type HostsResponse = GG.ResponseBrowseRemoteHost | GG.ResponseCheckRemoteHost | GG.ResponseCreateRemoteHostRepository | GG.ResponseHostStats | GG.ResponseLoadRemoteHosts | GG.ResponseRemoveRemoteHost | GG.ResponseRunRemoteHostGit | GG.ResponseSaveRemoteHost;

/** What the panel and the graph's worktree menu say about a Git command run on a server. */
const REMOTE_HOST_GIT_ACTIONS: { readonly [action in GG.RemoteHostGitAction]: { readonly title: string, readonly running: string, readonly done: string, readonly failed: string } } = {
	fetch: { title: 'Fetch on Server', running: 'Fetching on the server', done: 'Fetched on the server.', failed: 'Unable to Fetch on Server' },
	pull: { title: 'Pull on Server', running: 'Pulling on the server', done: 'Pulled on the server.', failed: 'Unable to Pull on Server' },
	push: { title: 'Push from Server', running: 'Pushing from the server', done: 'Pushed from the server.', failed: 'Unable to Push from Server' }
};

/** Each state's label, and its tone: the colour of its dot. */
const REMOTE_HOST_STATES: { readonly [state in GG.GitRemoteHostState]: { readonly label: string, readonly tone: 'good' | 'pending' | 'warn' | 'bad' } } = {
	ok: { label: 'OK', tone: 'good' },
	loading: { label: 'Loading', tone: 'pending' },
	needsConsent: { label: 'Needs permission to fetch', tone: 'warn' },
	unreachable: { label: 'Unreachable', tone: 'bad' },
	needsAuthentication: { label: 'Needs authentication', tone: 'warn' },
	notARepository: { label: 'Not a repository', tone: 'bad' },
	differentRepository: { label: 'Different repository', tone: 'bad' },
	configError: { label: 'Config error', tone: 'bad' }
};

/** The states of a remote host whose usage isn't read: SSH can't reach it, or its entry can't be used. Its row says why. */
const REMOTE_HOST_STATES_WITHOUT_USAGE: ReadonlyArray<GG.GitRemoteHostState> = ['unreachable', 'needsAuthentication', 'configError'];

const REMOTE_HOST_NAME_REGEX = /^[A-Za-z0-9_-]+$/;

/**
 * Run a Git command in a worktree on a remote host. A push reaches the server's upstream, so the user confirms it first.
 * @param host The host's name.
 * @param worktreePath The worktree on the server.
 * @param action The command.
 * @param run Sends the request.
 */
function confirmRemoteHostGit(host: string, worktreePath: string, action: GG.RemoteHostGitAction, run: () => void) {
	if (action !== 'push') {
		run();
		return;
	}
	dialog.showConfirmation('Are you sure you want to push from <b><i>' + escapeHtml(worktreePath) + '</i></b> on <b><i>' + escapeHtml(host) + '</i></b>? The server runs <b>git push</b>, which pushes its checked-out branch to its upstream.', 'Yes, push', run, null);
}

/**
 * Get the folder a path on a server is in.
 * @param path An absolute path.
 * @returns The folder, or NULL if the path is the root.
 */
function getRemoteParentPath(path: string) {
	const trimmed = path.length > 1 && path.endsWith('/') ? path.substring(0, path.length - 1) : path;
	const i = trimmed.lastIndexOf('/');
	return i > 0 ? trimmed.substring(0, i) : i === 0 && trimmed !== '/' ? '/' : null;
}

/**
 * Join a folder on a server and a name in it.
 * @param folder The folder.
 * @param name The name.
 * @returns The path.
 */
function joinRemotePath(folder: string, name: string) {
	return folder.endsWith('/') ? folder + name : folder + '/' + name;
}

type RemoteHostFormStep = 1 | 2 | 3 | 4; // The alias, Add existing or Create new, the folder, then the name and options

interface RemoteHostBrowser {
	readonly ssh: string; // The alias whose folders are listed
	loading: boolean;
	path: string | null; // The folder listed, NULL => none yet
	parent: string | null;
	entries: ReadonlyArray<GG.RemoteFolderEntry>;
	truncated: boolean; // The folder holds more folders than are listed
	error: GG.ErrorInfo;
	focusList: boolean; // Put the focus on the list once it has loaded, because the user moved with it
}

interface RemoteHostForm {
	readonly previousName: string | null; // NULL => adding a host, otherwise => editing the host with this name
	step: RemoteHostFormStep;
	alias: string;
	mode: 'existing' | 'create';
	browser: RemoteHostBrowser | null;
	pathInput: string; // What the browser's path field holds
	showHidden: boolean;
	selectedPath: string | null; // The repository's folder, NULL => not chosen yet
	newFolderName: string;
	source: GG.RemoteRepositorySource;
	sourceChosen: boolean;
	name: string;
	nameEdited: boolean; // FALSE => the name follows the alias
	worktrees: boolean;
	forwardAgent: boolean;
	check: { readonly ssh: string, readonly path: string, running: boolean, error: GG.ErrorInfo } | null;
	submitting: boolean;
	error: GG.ErrorInfo;
}

interface RemoteHostNotice {
	readonly kind: 'error' | 'success' | 'progress';
	readonly text: string;
}

/**
 * Implements the Hosts panel, a page of the Settings Widget.
 */
class HostsSettings {
	private readonly view: GitTreeView;

	private repo: string | null = null;
	private hosts: GG.ResponseLoadRemoteHosts | null = null;
	private usage = new Map<string | null, HostUsageState>(); // The usage of each host the extension reads, by name. NULL => this machine.
	private watching: ReadonlyArray<string | null> = []; // The hosts the extension was last asked to read
	private form: RemoteHostForm | null = null;
	private notice: RemoteHostNotice | null = null; // About the last add, edit or remove
	private rowNotices: { [name: string]: RemoteHostNotice } = {};
	private runningGit: { [name: string]: GG.RemoteHostGitAction } = {}; // The Git commands the rows started, by host
	private runningChecks: string[] = []; // The hosts whose rows run a check
	private removing: string | null = null;
	private focusAfterRender: string | null = null; // A selector of the element to focus after the next render

	private elem: HTMLElement | null = null;

	/**
	 * Construct a new HostsSettings instance.
	 * @param view The Git Tree View that the panel is for.
	 */
	constructor(view: GitTreeView) {
		this.view = view;
	}

	/**
	 * Start showing the hosts of a repository: read this machine's usage, and load the remote hosts.
	 * @param repo The repository.
	 */
	public open(repo: string) {
		this.close();
		this.repo = repo;
		this.watchUsage(false);
		this.request();
	}

	/**
	 * Stop showing the hosts, and reading their usage, forgetting the form and what each row said.
	 */
	public close() {
		if (this.repo !== null && this.watching.length > 0) {
			sendMessage({ command: 'watchHostStats', repo: this.repo, hosts: [], refresh: false });
		}
		this.repo = null;
		this.hosts = null;
		this.usage = new Map();
		this.watching = [];
		this.form = null;
		this.notice = null;
		this.rowNotices = {};
		this.runningGit = {};
		this.runningChecks = [];
		this.removing = null;
		this.elem = null;
	}

	/**
	 * Load the remote hosts again, so their states are current.
	 */
	public request() {
		if (this.repo === null) return;
		sendMessage({ command: 'loadRemoteHosts', repo: this.repo });
		this.render();
	}

	/**
	 * Load the remote hosts again, and read every host's usage now, as the panel's Refresh button asks.
	 */
	public refresh() {
		this.watchUsage(true);
		this.request();
	}

	/**
	 * Cancel the form, if it is open.
	 * @returns TRUE => the Escape key was used here, FALSE => the form isn't open.
	 */
	public handleEscape() {
		if (this.form === null) return false;
		if (!this.form.submitting) {
			this.form = null;
			this.focusAfterRender = '#hostsAdd';
			this.render();
		}
		return true;
	}

	/**
	 * Process a response to one of the panel's requests.
	 * @param msg The response.
	 * @returns TRUE => the panel handled it, FALSE => the panel didn't send it (so the view reports it).
	 */
	public processResponse(msg: HostsResponse) {
		if (this.repo === null) return false;
		switch (msg.command) {
			case 'loadRemoteHosts':
				this.processLoad(msg);
				return true;
			case 'hostStats':
				this.processUsage(msg);
				return true;
			case 'browseRemoteHost':
				this.processBrowse(msg);
				return true;
			case 'checkRemoteHost':
				this.processCheck(msg);
				return true;
			case 'saveRemoteHost':
			case 'createRemoteHostRepository':
				this.processSaved(msg.error, msg.command === 'createRemoteHostRepository');
				return true;
			case 'removeRemoteHost':
				return this.processRemoved(msg.error);
			case 'runRemoteHostGit':
				return this.processRunGit(msg);
		}
	}


	/* Render */

	/**
	 * Render the panel's hosts.
	 * @param elem The hosts' element, when the Settings Widget has just rendered a new one.
	 */
	public render(elem: HTMLElement | null = this.elem) {
		if (elem !== this.elem && elem !== null) this.listen(elem);
		this.elem = elem;
		if (elem === null || this.repo === null) return;

		const focus = captureSettingsFocus(elem);
		const scrollTops = ['hostBrowserList', 'hostAliasList'].map((id) => {
			const list = document.getElementById(id);
			return list !== null ? list.scrollTop : 0;
		});
		elem.innerHTML = this.getHtml();
		['hostBrowserList', 'hostAliasList'].forEach((id, i) => {
			const list = document.getElementById(id);
			if (list !== null) list.scrollTop = scrollTops[i];
		});

		const target = this.focusAfterRender !== null ? <HTMLElement | null>elem.querySelector(this.focusAfterRender) : null;
		if (target !== null) {
			target.focus();
			if (target.closest('.hostForm') !== null) target.closest('.hostForm')!.scrollIntoView({ block: 'nearest' });
		} else {
			restoreSettingsFocus(elem, focus);
		}
		this.focusAfterRender = null;
	}

	private getHtml() {
		const hosts = this.hosts, form = this.form;
		const canAdd = hosts !== null && hosts.error === null && hosts.configFile !== null && form === null;

		let html = this.notice !== null ? settingsNoticeHtml(this.notice.kind, escapeHtml(this.notice.text)) : '';
		html += '<div class="hostRow local"><div class="hostRowHead"><span class="hostStateDot good" aria-hidden="true"></span><span class="hostName">Local</span><span class="hostStateLabel">This machine</span></div>' +
			this.getUsageHtml(null) + '</div>';
		if (hosts === null) {
			html += settingsNoticeHtml('progress', 'Loading the remote hosts' + ELLIPSIS);
		} else if (hosts.error !== null) {
			html += settingsNoticeHtml('error', 'Unable to load the remote hosts: ' + escapeHtml(hosts.error));
		} else {
			if (hosts.configError !== null) {
				html += settingsNoticeHtml('error', '<b>The config file can\'t be used.</b> ' + escapeHtml(hosts.configError));
			}
			if (form !== null && form.previousName === null) {
				html += this.getFormHtml(form, hosts);
			}
			const hideHosts = this.getHideHosts();
			hosts.hosts.forEach((host, i) => {
				html += form !== null && form.previousName === host.name ? this.getFormHtml(form, hosts) : this.getHostRowHtml(host, i, hideHosts.includes(host.name));
			});
			if (hosts.hosts.length === 0 && form === null && hosts.configError === null) {
				html += '<div class="settingsEmpty">' + (hosts.configFile === null
					? 'This repository has no main worktree (it\'s bare), so it can\'t have remote hosts.'
					: 'No remote hosts yet. Add an SSH server to show its worktrees in the graph.') + '</div>';
			}
		}

		// Adding a host, where the hosts are saved, and the instruction for coding agents, quietly under the hosts
		html += '<div class="hostsFooter"><button type="button" class="settingsLinkBtn" id="hostsAdd" data-action="add"' + (canAdd ? '' : ' disabled') + '>' + SVG_ICONS.plus + '<span>Add a remote host</span></button>';
		if (hosts !== null && hosts.error === null && hosts.configFile !== null) {
			html += '<div class="hostsConfigFile" title="' + escapeHtml(hosts.configFile) + '">Saved in <code>' + escapeHtml(hosts.configFile) + '</code></div>';
		}
		return html + '<div class="hostsAgent">Using a coding agent? <button type="button" class="settingsLinkBtn" id="hostsCopyInstruction" data-action="copyInstruction"' + (hosts === null || hosts.agentInstruction === '' ? ' disabled' : '') +
			' title="Copy the instruction that tells a coding agent how to set up remote hosts for Git Tree"><span>Copy its setup instruction</span></button></div></div>';
	}

	private getHostRowHtml(host: GG.GitRemoteHostSettings, index: number, hidden: boolean) {
		const name = escapeHtml(host.name), state = REMOTE_HOST_STATES[host.state], notice = this.rowNotices[host.name];
		const busy = typeof this.runningGit[host.name] !== 'undefined' || this.runningChecks.includes(host.name) || this.removing === host.name;
		const gitDisabled = busy || host.state === 'configError', formOpen = this.form !== null;
		const attrs = (action: string) => 'data-action="' + action + '" data-focus="' + action + ':' + name + '"';
		const gitIcons: { readonly [action in GG.RemoteHostGitAction]: string } = { fetch: SVG_ICONS.download, pull: SVG_ICONS.arrowDown, push: SVG_ICONS.arrowUp };
		const actions = (<GG.RemoteHostGitAction[]>['fetch', 'pull', 'push']).map((action) => settingsIconButtonHtml(attrs(action), escapeHtml(REMOTE_HOST_GIT_ACTIONS[action].title + ' (in ' + host.path + ')') + (action === 'push' ? ELLIPSIS : ''), gitIcons[action], gitDisabled)).join('') +
			'<span class="settingsActionsDivider"></span>' +
			settingsIconButtonHtml(attrs('check'), 'Check the Connection and the Repository', SVG_ICONS.check, busy) +
			settingsIconButtonHtml(attrs('toggleHidden'), hidden ? 'Show This Host in the Graph' : 'Hide This Host from the Graph', hidden ? SVG_ICONS.eyeClosed : SVG_ICONS.eyeOpen) +
			settingsIconButtonHtml(attrs('edit'), 'Edit Host' + ELLIPSIS, SVG_ICONS.pencil, busy || formOpen) +
			settingsIconButtonHtml(attrs('remove'), 'Remove Host' + ELLIPSIS, SVG_ICONS.close, busy || formOpen);

		// What the graph shows of the host, and its last refresh, as one quiet line
		const refreshed = host.lastRefresh !== null ? formatShortDate(Math.floor(host.lastRefresh / 1000)) : null;
		const facts = [(refreshed !== null || host.worktreeCount > 0 ? host.worktreeCount + ' worktree' + (host.worktreeCount !== 1 ? 's' : '') + ' · ' : '') +
			(refreshed !== null ? '<span title="' + escapeHtml(refreshed.title) + '">Refreshed ' + escapeHtml(refreshed.formatted) + '</span>' : 'Not refreshed yet')];
		facts.push(host.worktrees
			? '<span title="The graph shows the server\'s linked worktrees too.">All worktrees</span>'
			: '<span title="The graph shows only the server\'s main worktree.">Main worktree only</span>');
		if (host.forwardAgent) facts.push('<span title="Clone, fetch, pull and push on the server get your SSH agent while they run.">Forward agent</span>');
		if (hidden) facts.push('<span class="hostRowHidden" title="Its worktrees and branches are left out of the graph, and its usage isn\'t read.">Hidden</span>');

		return '<div class="hostRow' + (hidden ? ' hidden' : '') + '" data-index="' + index + '">' +
			'<div class="hostRowHead"><span class="hostStateDot ' + state.tone + '" aria-hidden="true"></span><span class="hostName" title="' + name + '">' + name + '</span>' +
			'<span class="hostStateLabel" title="' + escapeHtml(state.label + (host.message !== null ? ': ' + host.message : '')) + '">' + state.label + '</span>' +
			'<span class="settingsRowActions">' + actions + '</span></div>' +
			'<div class="hostRowTarget" title="' + escapeHtml(host.ssh + ':' + host.path) + '"><span class="hostAlias">' + escapeHtml(host.ssh) + '</span>:' + escapeHtml(host.path) + '</div>' +
			'<div class="hostRowMeta">' + facts.join(' · ') + '</div>' +
			(host.state !== 'ok' && (host.message !== null || host.state === 'needsConsent') ? '<div class="hostRowMessage ' + state.tone + '">' + (host.message !== null ? escapeHtml(host.message) : '') +
				(host.state === 'needsConsent' ? ' <button type="button" class="settingsLinkBtn" data-action="allowFetch" data-focus="allowFetch:' + name + '">Allow Fetching' + ELLIPSIS + '</button>' : '') + '</div>' : '') +
			(typeof notice !== 'undefined' ? settingsNoticeHtml(notice.kind, escapeHtml(notice.text)) : '') +
			this.getUsageHtml(host.name) +
			'</div>';
	}

	/**
	 * Get the HTML of a host's usage, in an element that each answer for the host fills again.
	 * @param host The remote host's name, or NULL for this machine.
	 * @returns The HTML, or '' if the host's usage isn't read.
	 */
	private getUsageHtml(host: string | null) {
		const state = this.usage.get(host);
		return typeof state !== 'undefined' ? '<div class="hostUsage" data-usage="' + escapeHtml(host !== null ? host : '') + '">' + hostUsageHtml(state) + '</div>' : '';
	}

	/**
	 * Show a host's new usage. Only its element is filled again, so a form that is being typed in isn't rendered again.
	 * @param host The remote host's name, or NULL for this machine.
	 */
	private renderUsage(host: string | null) {
		const state = this.usage.get(host), key = host !== null ? host : '';
		if (this.elem === null || typeof state === 'undefined') return;
		const elem = Array.from(this.elem.querySelectorAll<HTMLElement>('.hostUsage')).find((usageElem) => usageElem.dataset.usage === key);
		if (typeof elem !== 'undefined') elem.innerHTML = hostUsageHtml(state);
	}

	private getFormHtml(form: RemoteHostForm, hosts: GG.ResponseLoadRemoteHosts) {
		const editing = form.previousName !== null;
		const steps: RemoteHostFormStep[] = editing ? [1, 3, 4] : [1, 2, 3, 4];
		let html = '<div class="hostForm" role="group" aria-labelledby="hostFormTitle"><div class="hostFormTitle" id="hostFormTitle">' + (editing ? 'Edit the host <b>' + escapeHtml(form.previousName!) + '</b>' : 'Add a remote host') + '</div>';
		steps.forEach((step, i) => {
			html += this.getStepHtml(form, hosts, step, i + 1);
		});

		html += '<div class="hostFormFooter">' + settingsButtonHtml('id="hostFormCancel" data-action="cancel"', 'Cancel', null, false, form.submitting);
		if (form.step === 4) {
			const invalid = this.getNameError(form, hosts) !== null || form.selectedPath === null;
			html += '<span class="hostFormFooterSpacer"></span>' +
				(form.mode === 'existing' ? settingsButtonHtml('id="hostFormCheck" data-action="check"', 'Check', SVG_ICONS.check, false, form.submitting || form.selectedPath === null || (form.check !== null && form.check.running)) : '') +
				settingsButtonHtml('id="hostFormSubmit" data-action="submit"', editing ? 'Save' : form.mode === 'create' ? 'Create and Add' : 'Add Host', null, true, invalid || form.submitting);
		}
		return html + '</div></div>';
	}

	private getStepHtml(form: RemoteHostForm, hosts: GG.ResponseLoadRemoteHosts, step: RemoteHostFormStep, number: number) {
		const state = step < form.step ? 'done' : step === form.step ? 'current' : 'future';
		const titles = ['SSH alias', 'Repository', form.mode === 'create' ? 'New repository folder' : 'Repository folder', 'Name and options'];
		let html = '<div class="hostFormStep ' + state + '"' + (state === 'current' ? ' aria-current="step"' : '') + '><span class="hostFormStepNumber" aria-hidden="true">' + (state === 'done' ? SVG_ICONS.check : number) + '</span>' +
			'<div class="hostFormStepBody"><div class="hostFormStepHead"><span class="hostFormStepTitle">' + titles[step - 1] + '</span>' +
			(state === 'done' && !form.submitting ? '<button type="button" class="settingsLinkBtn" data-action="changeStep" data-step="' + step + '" data-focus="change:' + step + '" aria-label="Change the ' + titles[step - 1] + '">Change</button>' : '') + '</div>';
		if (state === 'done') {
			html += '<div class="hostFormStepSummary">' + this.getStepSummaryHtml(form, hosts, step) + '</div>';
		} else if (state === 'current') {
			html += step === 1 ? this.getAliasStepHtml(form, hosts) : step === 2 ? this.getModeStepHtml(form) : step === 3 ? this.getFolderStepHtml(form) : this.getDetailsStepHtml(form, hosts);
		}
		return html + '</div></div>';
	}

	private getStepSummaryHtml(form: RemoteHostForm, hosts: GG.ResponseLoadRemoteHosts, step: RemoteHostFormStep) {
		if (step === 1) {
			const alias = hosts.sshAliases.find((alias) => alias.alias === form.alias);
			const hint = typeof alias !== 'undefined' ? HostsSettings.getAliasHint(alias) : '';
			return '<code>' + escapeHtml(form.alias) + '</code>' + (hint !== '' ? ' <span class="settingsHint">' + escapeHtml(hint) + '</span>' : '');
		} else if (step === 2) {
			return form.mode === 'create' ? 'Create a new repository' : 'Add an existing repository';
		} else {
			return '<code>' + escapeHtml(form.selectedPath || '') + '</code>' + (form.mode === 'create' ? ' <span class="settingsHint">' + (form.source.kind === 'clone' ? 'cloned from ' + escapeHtml(form.source.remote) : 'pushed from this machine') + '</span>' : '');
		}
	}

	private getAliasStepHtml(form: RemoteHostForm, hosts: GG.ResponseLoadRemoteHosts) {
		const typed = form.alias.trim(), lowerTyped = typed.toLowerCase(), error = HostsSettings.getAliasError(typed);
		const matches = hosts.sshAliases.filter((alias) => lowerTyped === '' || alias.alias.toLowerCase().includes(lowerTyped) || (alias.hostName !== null && alias.hostName.toLowerCase().includes(lowerTyped)));
		let html = '<label class="settingsField"><span class="settingsFieldLabel">Alias</span><input type="text" id="hostFormAlias" class="settingsInput mono" value="' + escapeHtml(form.alias) + '" placeholder="A Host from your SSH config" autocomplete="off" spellcheck="false"></label>';
		if (hosts.sshAliases.length > 0) {
			html += '<div class="hostPickList" id="hostAliasList" aria-label="SSH aliases">' + (matches.length > 0
				? matches.map((alias) => '<button type="button" class="hostPickItem' + (alias.alias === typed ? ' selected' : '') + '" data-action="pickAlias" data-alias="' + escapeHtml(alias.alias) + '" data-focus="alias:' + escapeHtml(alias.alias) + '"><span class="hostPickName">' + escapeHtml(alias.alias) + '</span><span class="hostPickHint">' + escapeHtml(HostsSettings.getAliasHint(alias)) + '</span></button>').join('')
				: '<div class="settingsEmpty">No alias in your SSH config matches.</div>') + '</div>';
		}
		if (error !== null) {
			html += '<div class="settingsFieldError" role="alert">' + error + '</div>';
		} else if (typed !== '' && matches.length === 0) {
			html += '<div class="settingsHint">ssh may still know this alias from a file Git Tree doesn\'t read. Check tells you once you have chosen the folder.</div>';
		} else if (hosts.sshAliases.length === 0) {
			html += '<div class="settingsHint">No Host aliases were found in ~/.ssh/config or the files it includes. Type an alias that ssh knows.</div>';
		}
		return html + '<div class="hostFormStepActions">' + settingsButtonHtml('id="hostFormAliasNext" data-action="aliasNext"', 'Next', null, true, typed === '' || error !== null) + '</div>';
	}

	private getModeStepHtml(form: RemoteHostForm) {
		const option = (mode: 'existing' | 'create', title: string, description: string) => '<button type="button" class="hostModeOption' + (form.mode === mode ? ' selected' : '') + '" data-action="mode" data-mode="' + mode + '" id="hostFormMode-' + mode + '">' +
			(mode === 'existing' ? SVG_ICONS.repo : SVG_ICONS.plus) + '<span class="hostModeText"><span class="hostModeTitle">' + title + '</span><span class="hostModeDescription">' + description + '</span></span></button>';
		return '<div class="hostModeOptions">' +
			option('existing', 'Add existing', 'Pick a repository that is already on the server.') +
			option('create', 'Create new', 'Make a new repository on the server, cloned from a remote or pushed from this machine.') + '</div>';
	}

	private getFolderStepHtml(form: RemoteHostForm) {
		const browser = form.browser, listed = browser !== null && !browser.loading && browser.error === null && browser.path !== null;
		const busy = browser === null || browser.loading;
		let list: string;
		if (browser === null || (browser.loading && browser.path === null)) {
			list = settingsNoticeHtml('progress', 'Listing the folders on ' + escapeHtml(form.alias) + ELLIPSIS);
		} else if (browser.error !== null) {
			list = settingsNoticeHtml('error', escapeHtml(browser.error)) + '<div class="hostFormStepActions">' + settingsButtonHtml('id="hostBrowseRetry" data-action="browseRetry"', 'Try Again', null) + '</div>';
		} else {
			const entries = browser.entries.filter((entry) => form.showHidden || !entry.name.startsWith('.'));
			list = (browser.loading ? settingsNoticeHtml('progress', 'Listing ' + escapeHtml(form.pathInput !== '' ? form.pathInput : 'the home folder') + ELLIPSIS) : '') +
				(entries.length > 0 ? entries.map((entry) => this.getFolderEntryHtml(form, browser.path!, entry, busy)).join('') : '<div class="settingsEmpty">' + (browser.entries.length > 0 ? 'Only hidden folders are here.' : 'There are no folders here.') + '</div>');
		}

		let count = '';
		if (listed) {
			const hiddenCount = browser!.entries.filter((entry) => entry.name.startsWith('.')).length, shown = form.showHidden ? browser!.entries.length : browser!.entries.length - hiddenCount;
			count = shown + ' folder' + (shown !== 1 ? 's' : '') + (!form.showHidden && hiddenCount > 0 ? ', ' + hiddenCount + ' hidden' : '') + (browser!.truncated ? ' (only the first 2,000 are listed; type a path to go further)' : '');
		}

		let html = '<div class="hostBrowser">' +
			'<div class="hostBrowserBar">' + settingsIconButtonHtml('id="hostBrowseUp" data-action="browseUp"', 'Up One Folder', SVG_ICONS.arrowUp, busy || browser!.parent === null || browser!.path === null) +
			settingsIconButtonHtml('id="hostBrowseHome" data-action="browseHome"', 'Home Folder', SVG_ICONS.home, busy) +
			'<input type="text" id="hostBrowsePath" class="settingsInput mono" value="' + escapeHtml(form.pathInput) + '" placeholder="The home folder" aria-label="Folder on the server (press Enter to open it)" title="Type a folder and press Enter to open it" autocomplete="off" spellcheck="false"></div>' +
			'<div class="hostBrowserList" id="hostBrowserList" aria-label="Folders"' + (busy ? ' aria-busy="true"' : '') + '>' + list + '</div>' +
			'<div class="hostBrowserFoot">' + settingsSwitchHtml('hostBrowseHidden', 'Show hidden folders', null, form.showHidden) + '<span class="hostBrowserCount">' + count + '</span></div>' +
			'</div>';

		if (form.mode === 'existing') {
			html += '<div class="hostFormSelection">' + (form.selectedPath !== null
				? 'Repository: <code>' + escapeHtml(form.selectedPath) + '</code>'
				: 'Choose a folder marked <b>repository</b>, or open the repository\'s folder and use it.') + '</div>' +
				'<div class="hostFormStepActions">' + settingsButtonHtml('id="hostBrowseUseFolder" data-action="useFolder"', 'Use This Folder', null, false, !listed) +
				settingsButtonHtml('id="hostFormFolderNext" data-action="folderNext"', 'Next', null, true, form.selectedPath === null) + '</div>';
		} else {
			const nameError = HostsSettings.getFolderNameError(form.newFolderName), name = form.newFolderName.trim();
			const exists = listed && browser!.entries.some((entry) => entry.name === name);
			html += '<label class="settingsField"><span class="settingsFieldLabel">New folder name</span><input type="text" id="hostFormNewFolder" class="settingsInput mono" value="' + escapeHtml(form.newFolderName) + '" autocomplete="off" spellcheck="false"></label>' +
				(nameError !== null && name !== ''
					? '<div class="settingsFieldError" role="alert">' + nameError + '</div>'
					: listed && name !== '' ? '<div class="settingsHint">Creates <code>' + escapeHtml(joinRemotePath(browser!.path!, name)) + '</code>' + (exists ? '. A folder with this name is already here, so it must be empty.' : '') + '</div>' : '') +
				this.getSourceHtml(form) +
				'<div class="hostFormStepActions">' + settingsButtonHtml('id="hostFormFolderNext" data-action="folderNext"', 'Next', null, true, !listed || nameError !== null) + '</div>';
		}
		return html;
	}

	private getFolderEntryHtml(form: RemoteHostForm, folder: string, entry: GG.RemoteFolderEntry, busy: boolean) {
		const name = escapeHtml(entry.name), path = joinRemotePath(folder, entry.name);
		const selects = form.mode === 'existing' && entry.kind === 'repository';
		const title = selects
			? 'Choose ' + name + ' as the repository'
			: 'Open ' + name + (entry.kind === 'worktree' ? '. It is a linked worktree (it has a .git file), so it can\'t be a host\'s main worktree.' : entry.kind === 'repository' ? '. It is a repository.' : '');
		return '<div class="hostBrowserEntry ' + entry.kind + (form.selectedPath === path ? ' selected' : '') + '">' +
			'<button type="button" class="hostBrowserMain" data-action="' + (selects ? 'selectEntry' : 'openEntry') + '" data-name="' + name + '" data-focus="entry:' + name + '" title="' + title + '"' + (busy ? ' disabled' : '') + '>' +
			(entry.kind === 'repository' ? SVG_ICONS.repo : entry.kind === 'worktree' ? SVG_ICONS.worktree : SVG_ICONS.closedFolder) + '<span class="hostBrowserName">' + name + '</span>' +
			(entry.kind !== 'folder' ? '<span class="hostBrowserKind">' + entry.kind + '</span>' : '') + (selects ? '' : '<span class="hostBrowserChevron" aria-hidden="true">' + SVG_ICONS.chevronRight + '</span>') + '</button>' +
			(selects ? settingsIconButtonHtml('data-action="openEntry" data-name="' + name + '" data-focus="open:' + name + '"', 'Open ' + name, SVG_ICONS.chevronRight, busy) : '') +
			'</div>';
	}

	private getSourceHtml(form: RemoteHostForm) {
		const config = this.view.getRepoConfig();
		const remotes = config !== null ? config.remotes.filter((remote) => remote.url !== null) : [];
		const option = (attrs: string, checked: boolean, label: string, description: string) => '<label class="settingsRadio"><input type="radio" name="hostSource" ' + attrs + (checked ? ' checked' : '') + '><span class="customRadio"></span><span class="settingsRadioText"><span>' + label + '</span><span class="settingsRadioDescription">' + description + '</span></span></label>';
		return '<div class="settingsField"><span class="settingsFieldLabel">Its commits come from</span>' +
			remotes.map((remote) => option('data-remote="' + escapeHtml(remote.name) + '" data-focus="source:' + escapeHtml(remote.name) + '"', form.source.kind === 'clone' && form.source.remote === remote.name, 'Clone <b>' + escapeHtml(remote.name) + '</b>', '<span class="mono">' + escapeHtml(remote.url!) + '</span>')).join('') +
			option('data-focus="source:"', form.source.kind === 'push', 'Push from this machine', 'The server runs git init, then this machine pushes its branches there. For a server that can\'t reach the remotes.') +
			(config === null ? '<div class="settingsHint">Loading this repository\'s remotes' + ELLIPSIS + '</div>' : '') +
			(form.source.kind === 'clone' ? '<div class="settingsHint">The server clones the URL itself. For a private repository, forward your SSH agent in the next step.</div>' : '') + '</div>';
	}

	private getDetailsStepHtml(form: RemoteHostForm, hosts: GG.ResponseLoadRemoteHosts) {
		const nameError = this.getNameError(form, hosts);
		let html = '<label class="settingsField"><span class="settingsFieldLabel">Name</span><input type="text" id="hostFormName" class="settingsInput" value="' + escapeHtml(form.name) + '" autocomplete="off" spellcheck="false"' + (form.submitting ? ' disabled' : '') + '></label>' +
			(nameError !== null ? '<div class="settingsFieldError" role="alert">' + nameError + '</div>' : '<div class="settingsHint">Shown in the graph. Letters, digits, - and _.</div>') +
			'<div class="hostFormSwitches">' + settingsSwitchHtml('hostFormWorktrees', 'Include the server\'s worktrees', 'Show the server\'s linked worktrees too, not only its main worktree.', form.worktrees, form.submitting) +
			settingsSwitchHtml('hostFormForwardAgent', 'Forward my SSH agent', 'Clone, fetch, pull and push on the server can then use your SSH keys, for example to reach GitHub. While one of them runs, root on the server can use your agent too.', form.forwardAgent, form.submitting) + '</div>';
		if (form.check !== null) {
			html += form.check.running
				? settingsNoticeHtml('progress', 'Checking ' + escapeHtml(form.check.ssh + ':' + form.check.path) + ELLIPSIS)
				: form.check.error === null
					? settingsNoticeHtml('success', 'The folder is the main worktree of a repository of this project.')
					: settingsNoticeHtml('error', escapeHtml(form.check.error));
		}
		if (form.submitting) {
			html += settingsNoticeHtml('progress', form.mode === 'create'
				? 'Creating the repository on ' + escapeHtml(form.alias) + '. Cloning or pushing can take a while' + ELLIPSIS
				: 'Checking the server and saving the host' + ELLIPSIS);
		} else if (form.error !== null) {
			html += settingsNoticeHtml('error', escapeHtml(form.error));
		}
		return html;
	}


	/* Events */

	private listen(elem: HTMLElement) {
		elem.addEventListener('click', (e) => {
			const target = <HTMLElement | null>(<Element>e.target).closest('[data-action]');
			if (target === null || !elem.contains(target) || (<HTMLButtonElement>target).disabled) return;
			this.runAction(target);
		});
		elem.addEventListener('input', (e) => {
			if (!(e.target instanceof HTMLInputElement) || this.form === null || (<InputEvent>e).isComposing) return;
			const value = e.target.value;
			switch (e.target.id) {
				case 'hostFormAlias':
					this.form.alias = value;
					break;
				case 'hostBrowsePath':
					this.form.pathInput = value;
					return; // Nothing else depends on it until Enter is pressed
				case 'hostFormNewFolder':
					this.form.newFolderName = value;
					break;
				case 'hostFormName':
					this.form.name = value;
					this.form.nameEdited = true;
					break;
				default:
					return;
			}
			this.render();
		});
		elem.addEventListener('change', (e) => {
			const target = e.target;
			if (!(target instanceof HTMLInputElement) || this.form === null) return;
			if (target.id === 'hostBrowseHidden') {
				this.form.showHidden = target.checked;
			} else if (target.id === 'hostFormWorktrees') {
				this.form.worktrees = target.checked;
			} else if (target.id === 'hostFormForwardAgent') {
				this.form.forwardAgent = target.checked;
			} else if (target.name === 'hostSource') {
				this.form.source = typeof target.dataset.remote === 'string' ? { kind: 'clone', remote: target.dataset.remote } : { kind: 'push' };
				this.form.sourceChosen = true;
			} else {
				return;
			}
			this.render();
		});
		elem.addEventListener('keydown', (e) => this.onKeyDown(e));
	}

	private onKeyDown(e: KeyboardEvent) {
		const target = <HTMLElement>e.target;
		if (e.key === 'Escape') return; // The view passes it to handleEscape
		if (target instanceof HTMLInputElement && target.type === 'text') {
			e.stopPropagation(); // Typing is not a shortcut of the view
			if (e.key === 'Enter' && !e.isComposing) {
				e.preventDefault();
				const actions: { readonly [id: string]: string } = { hostFormAlias: 'aliasNext', hostBrowsePath: 'browsePath', hostFormNewFolder: 'folderNext', hostFormName: 'submit' };
				if (typeof actions[target.id] === 'string') this.runActionIfEnabled(actions[target.id]);
			}
		} else if (target.classList.contains('hostBrowserMain') || target.classList.contains('hostPickItem')) {
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				// Move along the list, as in the lists of Visual Studio Code
				const items = Array.from(target.parentElement!.closest('.hostBrowserList, .hostPickList')!.querySelectorAll<HTMLButtonElement>('.' + target.classList[0] + ':not([disabled])'));
				const next = items[items.indexOf(<HTMLButtonElement>target) + (e.key === 'ArrowDown' ? 1 : -1)];
				if (typeof next !== 'undefined') next.focus();
				handledEvent(e);
			} else if (e.key === 'Backspace' && target.classList.contains('hostBrowserMain')) {
				this.runActionIfEnabled('browseUp');
				handledEvent(e);
			}
		}
	}

	/**
	 * Run the action of a button, unless the button is disabled.
	 * @param action The action, as the button's data-action.
	 */
	private runActionIfEnabled(action: string) {
		if (action === 'browsePath') {
			if (this.form !== null && this.form.browser !== null && !this.form.browser.loading) this.browse(this.form.pathInput.trim() !== '' ? this.form.pathInput.trim() : null, false);
			return;
		}
		const button = this.elem !== null ? <HTMLButtonElement | null>this.elem.querySelector('[data-action="' + action + '"]') : null;
		if (button !== null && !button.disabled) this.runAction(button);
	}

	private runAction(target: HTMLElement) {
		const action = target.dataset.action!;
		const rowElem = <HTMLElement | null>target.closest('.hostRow');
		const host = rowElem !== null && this.hosts !== null ? this.hosts.hosts[parseInt(rowElem.dataset.index!)] : null;
		if (host !== null && typeof host !== 'undefined') {
			this.runHostAction(host, action);
			return;
		}
		const form = this.form;
		switch (action) {
			case 'add':
				this.openForm(null);
				return;
			case 'copyInstruction':
				if (this.hosts !== null && this.hosts.agentInstruction !== '') {
					sendMessage({ command: 'copyToClipboard', type: 'Agent Instruction', data: this.hosts.agentInstruction });
					const span = target.querySelector('span')!, label = span.textContent;
					span.textContent = 'Copied';
					setTimeout(() => {
						span.textContent = label;
					}, 1500);
				}
				return;
		}
		if (form === null) return;
		switch (action) {
			case 'cancel':
				this.handleEscape();
				return;
			case 'pickAlias':
				form.alias = target.dataset.alias!;
				this.aliasNext(form);
				return;
			case 'aliasNext':
				this.aliasNext(form);
				return;
			case 'changeStep':
				this.goToStep(form, <RemoteHostFormStep>parseInt(target.dataset.step!));
				return;
			case 'mode':
				this.setMode(form, <'existing' | 'create'>target.dataset.mode);
				return;
			case 'browseUp':
				if (form.browser !== null && form.browser.parent !== null) this.browse(form.browser.parent, true);
				return;
			case 'browseHome':
				this.browse(null, true);
				return;
			case 'browseRetry':
				this.browse(form.pathInput.trim() !== '' ? form.pathInput.trim() : form.browser !== null ? form.browser.path : null, true);
				return;
			case 'openEntry':
				if (form.browser !== null && form.browser.path !== null) this.browse(joinRemotePath(form.browser.path, target.dataset.name!), true);
				return;
			case 'selectEntry':
				if (form.browser !== null && form.browser.path !== null) this.selectPath(form, joinRemotePath(form.browser.path, target.dataset.name!));
				return;
			case 'useFolder':
				if (form.browser !== null && form.browser.path !== null) this.selectPath(form, form.browser.path);
				return;
			case 'folderNext':
				this.folderNext(form);
				return;
			case 'check':
				this.checkForm(form);
				return;
			case 'submit':
				this.submit(form);
				return;
		}
	}

	private runHostAction(host: GG.GitRemoteHostSettings, action: string) {
		const repo = this.repo;
		if (repo === null) return;
		switch (action) {
			case 'fetch':
			case 'pull':
			case 'push':
				confirmRemoteHostGit(host.name, host.path, action, () => {
					if (this.repo !== repo) return;
					this.runningGit[host.name] = action;
					this.rowNotices[host.name] = { kind: 'progress', text: REMOTE_HOST_GIT_ACTIONS[action].running + ' (in ' + host.path + ')' + '…' };
					sendMessage({ command: 'runRemoteHostGit', repo: repo, host: host.name, worktreePath: host.path, action: action });
					this.render();
				});
				break;
			case 'check':
				this.runningChecks.push(host.name);
				this.rowNotices[host.name] = { kind: 'progress', text: 'Checking the connection and the repository…' };
				sendMessage({ command: 'checkRemoteHost', repo: repo, ssh: host.ssh, path: host.path });
				this.render();
				break;
			case 'toggleHidden': {
				// Hiding a host leaves its worktrees and branches out of the view, as hiding a remote does
				const hideHosts = this.getHideHosts().filter((name) => name !== host.name);
				if (hideHosts.length === this.getHideHosts().length) hideHosts.push(host.name);
				this.view.saveRepoStateValue(repo, 'hideHosts', hideHosts);
				this.view.refresh(true);
				this.watchUsage(false);
				this.render();
				break;
			}
			case 'allowFetch':
				// Visual Studio Code asks with a modal dialog, and the host refreshes if the user agrees
				sendMessage({ command: 'askRemoteHostFetchConsent', repo: repo, host: host.name });
				break;
			case 'edit':
				this.openForm(host);
				break;
			case 'remove':
				dialog.showConfirmation('Are you sure you want to remove the remote host <b><i>' + escapeHtml(host.name) + '</i></b>? Git Tree deletes its entry from <b><i>' + escapeHtml(this.hosts !== null && this.hosts.configFile !== null ? this.hosts.configFile : '.worktrees/git-tree.yaml') + '</i></b>, and its worktrees leave the graph. Nothing on the server changes.', 'Yes, remove', () => {
					if (this.repo !== repo) return;
					this.removing = host.name;
					this.notice = null;
					this.rowNotices[host.name] = { kind: 'progress', text: 'Removing the host…' };
					sendMessage({ command: 'removeRemoteHost', repo: repo, name: host.name });
					this.render();
				}, null);
				break;
		}
	}


	/* The Form */

	private openForm(host: GG.GitRemoteHostSettings | null) {
		this.notice = null;
		this.form = {
			previousName: host !== null ? host.name : null,
			step: host !== null ? 4 : 1,
			alias: host !== null ? host.ssh : '',
			mode: 'existing',
			browser: null,
			pathInput: host !== null ? getRemoteParentPath(host.path) || host.path : '',
			showHidden: false,
			selectedPath: host !== null ? host.path : null,
			newFolderName: this.repo !== null ? getRepoName(this.repo) : '',
			source: { kind: 'push' },
			sourceChosen: false,
			name: host !== null ? host.name : '',
			nameEdited: host !== null,
			worktrees: host !== null ? host.worktrees : true,
			forwardAgent: host !== null ? host.forwardAgent : false,
			check: null,
			submitting: false,
			error: null
		};
		this.focusAfterRender = host !== null ? '#hostFormName' : '#hostFormAlias';
		this.render();
	}

	private aliasNext(form: RemoteHostForm) {
		const alias = form.alias.trim();
		if (alias === '' || HostsSettings.getAliasError(alias) !== null) return;
		form.alias = alias;
		if (form.browser !== null && form.browser.ssh !== alias) {
			form.browser = null;
			if (form.previousName === null) form.selectedPath = null;
		}
		if (!form.nameEdited) {
			// The alias, as a name: other characters become -, and a name another host has gets a number
			const name = alias.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, ''), taken = this.hosts !== null ? this.hosts.hosts.map((host) => host.name) : [];
			let suffix = 1;
			while (taken.includes(suffix > 1 ? name + '-' + suffix : name)) suffix++;
			form.name = suffix > 1 ? name + '-' + suffix : name;
		}
		form.check = null;
		this.goToStep(form, form.previousName !== null ? 3 : 2);
	}

	private setMode(form: RemoteHostForm, mode: 'existing' | 'create') {
		if (form.mode !== mode) {
			form.mode = mode;
			form.selectedPath = null;
		}
		if (mode === 'create' && !form.sourceChosen) {
			// Clone origin, or the first remote, when the repository has one the server may reach
			const config = this.view.getRepoConfig();
			const remotes = config !== null ? config.remotes.filter((remote) => remote.url !== null) : [];
			const remote = remotes.find((remote) => remote.name === 'origin') || remotes[0];
			form.source = typeof remote !== 'undefined' ? { kind: 'clone', remote: remote.name } : { kind: 'push' };
		}
		this.goToStep(form, 3);
	}

	private goToStep(form: RemoteHostForm, step: RemoteHostFormStep) {
		form.step = step;
		form.error = null;
		this.focusAfterRender = ['#hostFormAlias', '#hostFormMode-' + form.mode, '#hostBrowsePath', '#hostFormName'][step - 1];
		if (step === 3 && (form.browser === null || form.browser.ssh !== form.alias)) {
			this.browse(form.pathInput.trim() !== '' ? form.pathInput.trim() : null, false);
		} else {
			this.render();
		}
	}

	/**
	 * List the folders in a folder on the server. One listing runs at a time, so its response is always for the latest request.
	 * @param path The folder, or NULL for the home folder.
	 * @param focusList Put the focus on the list once it has loaded.
	 */
	private browse(path: string | null, focusList: boolean) {
		const form = this.form;
		if (this.repo === null || form === null || (form.browser !== null && form.browser.loading)) return;
		const previous = form.browser !== null && form.browser.ssh === form.alias && form.browser.error === null ? form.browser : null;
		form.browser = {
			ssh: form.alias,
			loading: true,
			path: previous !== null ? previous.path : null,
			parent: previous !== null ? previous.parent : null,
			entries: previous !== null ? previous.entries : [],
			truncated: previous !== null ? previous.truncated : false,
			error: null,
			focusList: focusList
		};
		form.pathInput = path !== null ? path : '';
		sendMessage({ command: 'browseRemoteHost', repo: this.repo, ssh: form.alias, path: path });
		this.render();
	}

	private selectPath(form: RemoteHostForm, path: string) {
		form.selectedPath = path;
		form.check = null;
		this.render();
	}

	private folderNext(form: RemoteHostForm) {
		if (form.mode === 'create') {
			const browser = form.browser;
			if (browser === null || browser.loading || browser.error !== null || browser.path === null || HostsSettings.getFolderNameError(form.newFolderName) !== null) return;
			form.newFolderName = form.newFolderName.trim();
			form.selectedPath = joinRemotePath(browser.path, form.newFolderName);
		} else if (form.selectedPath === null) {
			return;
		}
		this.goToStep(form, 4);
	}

	private checkForm(form: RemoteHostForm) {
		if (this.repo === null || form.selectedPath === null) return;
		form.check = { ssh: form.alias, path: form.selectedPath, running: true, error: null };
		sendMessage({ command: 'checkRemoteHost', repo: this.repo, ssh: form.alias, path: form.selectedPath });
		this.render();
	}

	private submit(form: RemoteHostForm) {
		if (this.repo === null || this.hosts === null || form.submitting || form.step !== 4 || form.selectedPath === null || this.getNameError(form, this.hosts) !== null) return;
		const host: GG.RemoteHostEntry = { name: form.name.trim(), ssh: form.alias, path: form.selectedPath, worktrees: form.worktrees, forwardAgent: form.forwardAgent };
		form.name = host.name;
		form.submitting = true;
		form.error = null;
		if (form.mode === 'create') {
			sendMessage({ command: 'createRemoteHostRepository', repo: this.repo, host: host, source: form.source });
		} else {
			sendMessage({ command: 'saveRemoteHost', repo: this.repo, previousName: form.previousName, host: host });
		}
		this.render();
	}


	/* Responses */

	private processLoad(msg: GG.ResponseLoadRemoteHosts) {
		if (msg.repo !== this.repo) return;
		this.hosts = msg;
		if (msg.error === null && msg.configError === null) {
			// Forget hidden hosts that are no longer in the config, as hidden remotes are forgotten
			const names = msg.hosts.map((host) => host.name), hideHosts = this.getHideHosts();
			const kept = hideHosts.filter((name) => names.includes(name));
			if (kept.length !== hideHosts.length) this.view.saveRepoStateValue(this.repo, 'hideHosts', kept);
			Object.keys(this.rowNotices).forEach((name) => {
				if (!names.includes(name)) delete this.rowNotices[name];
			});
		}
		this.watchUsage(false);
		this.render();
	}

	private processUsage(msg: GG.ResponseHostStats) {
		const state = msg.repo === this.repo ? this.usage.get(msg.host) : undefined;
		if (typeof state === 'undefined') return;
		state.usage = msg.usage;
		state.error = msg.error;
		state.loading = false;
		this.renderUsage(msg.host);
	}

	private processBrowse(msg: GG.ResponseBrowseRemoteHost) {
		const browser = this.form !== null ? this.form.browser : null;
		if (browser === null || !browser.loading || browser.ssh !== msg.ssh) return;
		browser.loading = false;
		if (msg.error !== null) {
			browser.error = msg.error;
			this.focusAfterRender = browser.focusList ? '#hostBrowseRetry' : null;
		} else {
			browser.path = msg.path;
			browser.parent = msg.parent;
			browser.entries = msg.entries;
			browser.truncated = msg.truncated;
			browser.error = null;
			this.form!.pathInput = msg.path;
			this.focusAfterRender = browser.focusList ? '.hostBrowserMain, #hostBrowseUp:not([disabled]), #hostBrowsePath' : null;
		}
		this.render();
	}

	private processCheck(msg: GG.ResponseCheckRemoteHost) {
		const form = this.form;
		if (form !== null && form.check !== null && form.check.running && form.check.ssh === msg.ssh && form.check.path === msg.path) {
			form.check.running = false;
			form.check.error = msg.error;
		}
		if (this.hosts !== null) {
			this.runningChecks = this.runningChecks.filter((name) => {
				const host = this.hosts!.hosts.find((host) => host.name === name);
				if (typeof host !== 'undefined' && (host.ssh !== msg.ssh || host.path !== msg.path)) return true;
				this.rowNotices[name] = msg.error === null
					? { kind: 'success', text: 'Check passed: the folder is the main worktree of a repository of this project.' }
					: { kind: 'error', text: msg.error };
				return false;
			});
		}
		this.render();
	}

	private processSaved(error: GG.ErrorInfo, created: boolean) {
		const form = this.form !== null && this.form.submitting ? this.form : null;
		if (error !== null) {
			if (form !== null) {
				form.submitting = false;
				form.error = error;
			} else {
				this.notice = { kind: 'error', text: error };
			}
			this.render();
			return;
		}
		if (form !== null && form.previousName !== null && form.previousName !== form.name && this.repo !== null) {
			// A renamed host stays hidden if it was
			this.view.saveRepoStateValue(this.repo, 'hideHosts', this.getHideHosts().map((name) => name === form.previousName ? form.name : name));
		}
		this.notice = { kind: 'success', text: form === null ? 'Saved the host.' : created ? 'Created the repository on ' + form.alias + ', and added the host ' + form.name + '.' : form.previousName !== null ? 'Saved the host ' + form.name + '.' : 'Added the host ' + form.name + '.' };
		this.form = null;
		this.focusAfterRender = '#hostsAdd';
		this.request();
		this.view.refresh(false);
	}

	private processRemoved(error: GG.ErrorInfo) {
		const name = this.removing;
		if (name === null) return false;
		this.removing = null;
		if (error !== null) {
			this.rowNotices[name] = { kind: 'error', text: error };
			this.render();
		} else {
			delete this.rowNotices[name];
			this.notice = { kind: 'success', text: 'Removed the host ' + name + '.' };
			this.focusAfterRender = '#hostsAdd';
			this.request();
			this.view.refresh(false);
		}
		return true;
	}

	private processRunGit(msg: GG.ResponseRunRemoteHostGit) {
		if (this.runningGit[msg.host] !== msg.action) return false;
		delete this.runningGit[msg.host];
		this.rowNotices[msg.host] = msg.error === null ? { kind: 'success', text: REMOTE_HOST_GIT_ACTIONS[msg.action].done } : { kind: 'error', text: msg.error };
		this.render();
		if (msg.error === null) {
			this.request();
			this.view.refresh(false);
		}
		return true;
	}


	/* Usage */

	/**
	 * Ask the extension to read the usage of this machine, and of each remote host that isn't hidden and that SSH can
	 * reach. It asks again only when the hosts change, or to read them all now.
	 * @param refresh Read every host now.
	 */
	private watchUsage(refresh: boolean) {
		if (this.repo === null) return;
		const hosts = this.hosts, hideHosts = this.getHideHosts();
		const names = [<string | null>null].concat(hosts !== null && hosts.error === null && hosts.configError === null
			? hosts.hosts.filter((host) => !hideHosts.includes(host.name) && !REMOTE_HOST_STATES_WITHOUT_USAGE.includes(host.state)).map((host) => host.name)
			: []);
		// A host that is no longer read loses its numbers, rather than showing old ones
		Array.from(this.usage.keys()).forEach((name) => {
			if (!names.includes(name)) this.usage.delete(name);
		});
		names.forEach((name) => {
			if (!this.usage.has(name)) this.usage.set(name, { usage: null, error: null, loading: true });
		});
		if (refresh || !arraysStrictlyEqual(names, this.watching)) {
			this.watching = names;
			sendMessage({ command: 'watchHostStats', repo: this.repo, hosts: names, refresh: refresh });
		}
	}


	/* Helpers */

	private getHideHosts(): ReadonlyArray<string> {
		const state = this.repo !== null ? this.view.getRepoState(this.repo) : null;
		return state !== null ? state.hideHosts : [];
	}

	private getNameError(form: RemoteHostForm, hosts: GG.ResponseLoadRemoteHosts) {
		const name = form.name.trim();
		if (name === '') return 'A host needs a name.';
		if (!REMOTE_HOST_NAME_REGEX.test(name)) return 'Use only letters, digits, - and _.';
		if (name !== form.previousName && hosts.hosts.some((host) => host.name === name)) return 'Another host is already called ' + escapeHtml(name) + '.';
		return null;
	}

	/**
	 * Get what is wrong with a typed SSH alias.
	 * @param alias The alias, trimmed.
	 * @returns The error (HTML), or NULL if there's none (an empty alias has none, it just can't be used yet).
	 */
	private static getAliasError(alias: string) {
		if (/\s/.test(alias)) return 'An alias has no spaces.';
		if (alias.startsWith('-')) return 'An alias can\'t start with -.';
		return null;
	}

	/**
	 * Get what is wrong with the name of a new folder.
	 * @param name The name, as typed.
	 * @returns The error (HTML), or NULL if it can be used.
	 */
	private static getFolderNameError(name: string) {
		const trimmed = name.trim();
		if (trimmed === '') return 'The new repository needs a folder name.';
		if (trimmed.includes('/') || trimmed.includes('\0')) return 'A folder name can\'t contain /.';
		if (trimmed === '.' || trimmed === '..') return 'Choose a folder name other than . and ..';
		return null;
	}

	/**
	 * Get the hint shown next to an SSH alias: who it connects as, and to where.
	 * @param alias The alias.
	 * @returns The hint, such as `sid@devbox.example.com`.
	 */
	private static getAliasHint(alias: GG.SshAlias) {
		return (alias.user !== null ? alias.user + '@' : '') + (alias.hostName !== null ? alias.hostName : alias.user !== null ? alias.alias : '');
	}
}
