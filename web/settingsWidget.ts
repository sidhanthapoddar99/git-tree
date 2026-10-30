/** A page of the Settings Widget. Each is a panel of its own, with its own button in the bottom bar. */
type SettingsPage = 'repository' | 'remoteHosts' | 'issues';

/** A card of the Settings Widget. */
type SettingsCard = 'general' | 'userDetails' | 'remotes' | 'remoteHosts' | 'issueLinking' | 'pullRequests' | 'gitTree';

/** Each page's title, its button's icon, and its cards in the order they show. A page that shows the repository's Git config loads it when it opens. */
const SETTINGS_PAGES: { readonly [page in SettingsPage]: { readonly title: string, readonly icon: string, readonly cards: ReadonlyArray<SettingsCard>, readonly loadsConfig: boolean } } = {
	repository: { title: 'Repository Settings', icon: SVG_ICONS.gear, cards: ['general', 'userDetails', 'remotes', 'gitTree'], loadsConfig: true },
	remoteHosts: { title: 'Remote Hosts', icon: SVG_ICONS.server, cards: ['remoteHosts'], loadsConfig: false },
	issues: { title: 'Issues & Pull Requests', icon: SVG_ICONS.pullRequest, cards: ['issueLinking', 'pullRequests'], loadsConfig: true }
};

interface SettingsWidgetState {
	readonly currentRepo: string | null;
	readonly page?: SettingsPage; // Missing in state saved before the settings were split into pages, which showed Repository Settings
	readonly scrollTop: number;
}

/**
 * Implements the Git Tree View's Settings Widget: a card for each group of settings, with its actions in the card's header. It shows one page of cards at a time.
 */
class SettingsWidget {
	private readonly view: GitTreeView;
	private readonly remoteHosts: RemoteHostsSettings;

	private currentRepo: string | null = null;
	private page: SettingsPage = 'repository';
	private repo: Readonly<GG.GitRepoState> | null = null;
	private config: Readonly<GG.GitRepoConfig> | null = null;
	private loading: boolean = false;
	private scrollTop: number = 0;

	private readonly widgetElem: HTMLElement;
	private readonly contentsElem: HTMLElement;
	private readonly loadingElem: HTMLElement;

	/**
	 * Construct a new SettingsWidget instance.
	 * @param view The Git Tree View that the SettingsWidget is for.
	 * @returns The SettingsWidget instance.
	 */
	constructor(view: GitTreeView) {
		this.view = view;
		this.remoteHosts = new RemoteHostsSettings(view);

		this.widgetElem = document.createElement('div');
		this.widgetElem.id = 'settingsWidget';
		this.widgetElem.setAttribute('role', 'region');
		this.widgetElem.innerHTML = '<div class="settingsHeader"><div class="settingsHeaderTitles"><h2 id="settingsTitle"></h2><div id="settingsRepoName"></div></div>' +
			settingsIconButtonHtml('id="settingsClose"', '', SVG_ICONS.close) + '</div><div id="settingsContent"></div><div id="settingsLoading"></div>';
		document.body.appendChild(this.widgetElem);

		observeElemScroll('settingsWidget', this.scrollTop, (scrollTop) => {
			this.scrollTop = scrollTop;
		}, () => {
			if (this.currentRepo !== null) {
				this.view.saveState();
			}
		});

		this.contentsElem = document.getElementById('settingsContent')!;
		this.loadingElem = document.getElementById('settingsLoading')!;
		document.getElementById('settingsClose')!.addEventListener('click', () => this.close());
	}

	/**
	 * Show a page of the Settings Widget. Another page that is open closes first.
	 * @param currentRepo The repository that is currently loaded in the view.
	 * @param page The page to show.
	 * @param isInitialLoad Is this the initial load of the Setting Widget, or is it being shown when restoring a previous state.
	 * @param scrollTop The scrollTop the Settings Widget should initially be set to.
	 */
	public show(currentRepo: string, page: SettingsPage, isInitialLoad: boolean = true, scrollTop: number = 0) {
		if (this.currentRepo !== null) {
			if (this.page === page) return;
			this.close();
		}
		this.currentRepo = currentRepo;
		this.page = page;
		this.scrollTop = scrollTop;
		const title = SETTINGS_PAGES[page].title, closeElem = document.getElementById('settingsClose')!;
		document.getElementById('settingsTitle')!.textContent = title;
		this.widgetElem.setAttribute('aria-label', title);
		closeElem.title = 'Close ' + title;
		closeElem.setAttribute('aria-label', closeElem.title);
		alterClass(this.widgetElem, CLASS_TRANSITION, isInitialLoad);
		this.widgetElem.classList.add(CLASS_ACTIVE);
		this.view.saveState();
		this.view.renderPanelButtons();
		if (this.hasCard('remoteHosts')) {
			this.remoteHosts.open(currentRepo);
		}
		this.refresh();
		if (isInitialLoad && SETTINGS_PAGES[page].loadsConfig) {
			this.view.requestLoadConfig();
		}
	}

	/**
	 * Refresh the Settings Widget after an action affecting it's content has completed.
	 */
	public refresh() {
		if (this.currentRepo === null) return;
		this.repo = this.view.getRepoState(this.currentRepo);
		this.config = this.view.getRepoConfig();
		this.loading = SETTINGS_PAGES[this.page].loadsConfig && this.view.isConfigLoading();
		this.render();
	}

	/**
	 * Close the Settings Widget, sliding it up out of view.
	 */
	public close() {
		if (this.currentRepo === null) return;
		this.currentRepo = null;
		this.repo = null;
		this.config = null;
		this.loading = false;
		this.remoteHosts.close();
		this.widgetElem.classList.add(CLASS_TRANSITION);
		this.widgetElem.classList.remove(CLASS_ACTIVE);
		this.widgetElem.classList.remove(CLASS_LOADING);
		this.contentsElem.innerHTML = '';
		this.loadingElem.innerHTML = '';
		this.view.saveState();
		this.view.renderPanelButtons();
	}

	/**
	 * Use the Escape key inside the Settings Widget: it cancels the Remote Hosts form when it's open.
	 * @returns TRUE => the key was used, FALSE => the Settings Widget should close.
	 */
	public handleEscape() {
		return this.remoteHosts.handleEscape();
	}

	/**
	 * Load the remote hosts again, because the view refreshed, so the state of each stays current.
	 */
	public requestRemoteHosts() {
		if (this.currentRepo !== null) this.remoteHosts.request();
	}

	/**
	 * Pass a response for the Remote Hosts card to it.
	 * @param msg The response.
	 * @returns TRUE => the card handled it, FALSE => the card didn't send it.
	 */
	public processRemoteHostsResponse(msg: RemoteHostsResponse) {
		return this.remoteHosts.processResponse(msg);
	}


	/* State */

	/**
	 * Get the current state of the Settings Widget.
	 */
	public getState(): SettingsWidgetState {
		return {
			currentRepo: this.currentRepo,
			page: this.page,
			scrollTop: this.scrollTop
		};
	}

	/**
	 * Restore the Settings Widget to an existing state.
	 * @param state The previous Settings Widget state.
	 */
	public restoreState(state: SettingsWidgetState) {
		if (state.currentRepo === null) return;
		const page = typeof state.page === 'string' && Object.prototype.hasOwnProperty.call(SETTINGS_PAGES, state.page) ? state.page : 'repository';
		this.show(state.currentRepo, page, false, state.scrollTop);
	}

	/**
	 * Is the Settings Widget currently visible.
	 * @returns TRUE => The Settings Widget is visible, FALSE => The Settings Widget is not visible
	 */
	public isVisible() {
		return this.currentRepo !== null;
	}

	/**
	 * Get the page the Settings Widget shows.
	 * @returns The page, or NULL if the Settings Widget is closed.
	 */
	public getOpenPage() {
		return this.currentRepo !== null ? this.page : null;
	}


	/* Render Methods */

	/**
	 * Render the Settings Widget.
	 */
	private render() {
		if (this.currentRepo !== null && this.repo !== null) {
			const escapedRepoName = escapeHtml(this.repo.name || getRepoName(this.currentRepo));
			const repoNameElem = document.getElementById('settingsRepoName')!;
			repoNameElem.innerHTML = escapedRepoName;
			repoNameElem.title = this.currentRepo;

			const initialBranchesLocallyConfigured = this.repo.onRepoLoadShowCheckedOutBranch !== GG.BooleanOverride.Default || this.repo.onRepoLoadShowSpecificBranches !== null;
			const initialBranches: string[] = [];
			if (getOnRepoLoadShowCheckedOutBranch(this.repo.onRepoLoadShowCheckedOutBranch)) {
				initialBranches.push('Checked Out');
			}
			const branchOptions = this.view.getBranchOptions();
			getOnRepoLoadShowSpecificBranches(this.repo.onRepoLoadShowSpecificBranches).forEach((branch) => {
				const option = branchOptions.find((option) => option.value === branch);
				if (option) {
					initialBranches.push(option.name);
				}
			});
			const initialBranchesStr = initialBranches.length > 0
				? escapeHtml(formatCommaSeparatedList(initialBranches))
				: 'Show All';
			const scope = (local: boolean) => ' <span class="settingsHint">' + (local ? 'local' : 'global') + '</span>';
			const editAndRemove = (id: string, removeId: string, name: string) => settingsIconButtonHtml('id="' + id + '"', 'Edit ' + name + ELLIPSIS, SVG_ICONS.pencil) + settingsIconButtonHtml('id="' + removeId + '"', 'Remove ' + name + ELLIPSIS, SVG_ICONS.close);

			let html = '';
			if (this.hasCard('general')) {
				html += settingsCardHtml('settingsGeneral', 'General', 'How this repository is named, and what the graph loads.', '',
					settingsRowHtml('Name', escapedRepoName + (this.repo.name === null ? ' <span class="settingsHint">from the folder</span>' : ''), escapedRepoName + (this.repo.name === null ? ' (Default Name from the File System)' : ''),
						settingsIconButtonHtml('id="editRepoName"', 'Edit Name' + ELLIPSIS, SVG_ICONS.pencil) + (this.repo.name !== null ? settingsIconButtonHtml('id="deleteRepoName"', 'Delete Name' + ELLIPSIS, SVG_ICONS.close) : '')) +
					settingsRowHtml('Initial Branches', initialBranchesStr + scope(initialBranchesLocallyConfigured), initialBranchesStr + ' (' + (initialBranchesLocallyConfigured ? 'Local' : 'Global') + ')',
						settingsIconButtonHtml('id="editInitialBranches"', 'Edit Initial Branches' + ELLIPSIS, SVG_ICONS.pencil) + (initialBranchesLocallyConfigured ? settingsIconButtonHtml('id="clearInitialBranches"', 'Clear Initial Branches' + ELLIPSIS, SVG_ICONS.close) : '')) +
					'<div class="settingsSwitches">' +
					settingsSwitchHtml('settingsShowRemoteBranchesCheckbox', 'Show Remote Branches', null, getShowRemoteBranches(this.repo.showRemoteBranchesV2)) +
					settingsSwitchHtml('settingsShowStashesCheckbox', 'Show Stashes', null, getShowStashes(this.repo.showStashes)) +
					settingsSwitchHtml('settingsShowTagsCheckbox', 'Show Tags', null, getShowTags(this.repo.showTags)) +
					settingsSwitchHtml('settingsIncludeCommitsMentionedByReflogsCheckbox', 'Include commits only mentioned by reflogs', 'Only applies when showing all branches.', getIncludeCommitsMentionedByReflogs(this.repo.includeCommitsMentionedByReflogs)) +
					settingsSwitchHtml('settingsOnlyFollowFirstParentCheckbox', 'Only follow the first parent of commits', 'Instead of following all parents of commits, only follow the first parent when discovering the commits to load.', getOnlyFollowFirstParent(this.repo.onlyFollowFirstParent)) +
					'</div>');
			}

			let userNameSet = false, userEmailSet = false;
			if (this.config !== null) {
				const userName = this.config.user.name, userEmail = this.config.user.email;
				userNameSet = userName.local !== null || userName.global !== null;
				userEmailSet = userEmail.local !== null || userEmail.global !== null;
				let userBody = '';
				if (userNameSet || userEmailSet) {
					const escapedUserName = escapeHtml(userName.local ?? userName.global ?? 'Not Set');
					const escapedUserEmail = escapeHtml(userEmail.local ?? userEmail.global ?? 'Not Set');
					userBody = settingsRowHtml('User Name', escapedUserName + (userNameSet ? scope(userName.local !== null) : ''), escapedUserName + (userNameSet ? ' (' + (userName.local !== null ? 'Local' : 'Global') + ')' : ''), '') +
						settingsRowHtml('User Email', escapedUserEmail + (userEmailSet ? scope(userEmail.local !== null) : ''), escapedUserEmail + (userEmailSet ? ' (' + (userEmail.local !== null ? 'Local' : 'Global') + ')' : ''), '');
				}
				if (this.hasCard('userDetails')) {
					html += settingsCardHtml('settingsUserDetails', 'User Details', 'The name and email Git records as the author and committer of commits.',
						userNameSet || userEmailSet ? editAndRemove('editUserDetails', 'removeUserDetails', 'User Details') : settingsButtonHtml('id="editUserDetails"', 'Add', SVG_ICONS.plus), userBody);
				}

				if (this.hasCard('remotes')) {
					const hideRemotes = this.repo.hideRemotes;
					const remotesHtml = this.config.remotes.map((remote, i) => {
						const hidden = hideRemotes.includes(remote.name);
						const fetchUrl = escapeHtml(remote.url || 'Not Set'), pushUrl = escapeHtml(remote.pushUrl || remote.url || 'Not Set');
						return '<div class="settingsRow remoteRow' + (hidden ? ' hidden' : '') + '">' +
							settingsIconButtonHtml('data-index="' + i + '" data-focus="hideRemote:' + i + '"', hidden ? 'Show the Branches of This Remote' : 'Hide the Branches of This Remote', hidden ? SVG_ICONS.eyeClosed : SVG_ICONS.eyeOpen, false, 'hideRemoteBtn') +
							'<div class="remoteRowMain"><div class="remoteRowName">' + escapeHtml(remote.name) + (hidden ? ' <span class="settingsBadge outline">Hidden</span>' : '') + '</div>' +
							'<div class="remoteRowUrl" title="Fetch URL: ' + fetchUrl + '"><span class="remoteRowUrlKind">Fetch</span>' + fetchUrl + '</div>' +
							'<div class="remoteRowUrl" title="Push URL: ' + pushUrl + '"><span class="remoteRowUrlKind">Push</span>' + pushUrl + '</div></div>' +
							'<span class="settingsRowActions remoteBtns" data-index="' + i + '">' +
							settingsIconButtonHtml('', 'Fetch from Remote' + ELLIPSIS, SVG_ICONS.download, false, 'fetchRemote') + settingsIconButtonHtml('', 'Prune Remote' + ELLIPSIS, SVG_ICONS.branch, false, 'pruneRemote') +
							settingsIconButtonHtml('', 'Edit Remote' + ELLIPSIS, SVG_ICONS.pencil, false, 'editRemote') + settingsIconButtonHtml('', 'Delete Remote' + ELLIPSIS, SVG_ICONS.close, false, 'deleteRemote') + '</span></div>';
					}).join('');
					html += settingsCardHtml('settingsRemotes', 'Remote Configuration', 'The remotes this repository fetches from and pushes to. A hidden remote\'s branches stay out of the graph.',
						settingsButtonHtml('id="settingsAddRemote"', 'Add Remote', SVG_ICONS.plus), remotesHtml !== '' ? remotesHtml : '<div class="settingsEmpty">There are no remotes configured for this repository.</div>');
				}
			}

			if (this.hasCard('remoteHosts')) {
				html += '<section class="settingsCard" id="settingsRemoteHosts"></section>';
			}

			if (this.hasCard('issueLinking')) {
				const issueLinkingConfig = this.repo.issueLinkingConfig || globalState.issueLinkingConfig;
				let issueBody = '';
				if (issueLinkingConfig !== null) {
					const escapedIssue = escapeHtml(issueLinkingConfig.issue), escapedUrl = escapeHtml(issueLinkingConfig.url);
					issueBody = settingsRowHtml('Issue Regex', escapedIssue, escapedIssue, '') + settingsRowHtml('Issue URL', escapedUrl, escapedUrl, '');
				}
				html += settingsCardHtml('settingsIssueLinking', 'Issue Linking', 'Turns issue numbers in commit and tag messages into links to your issue tracker. A branch named with an issue number links to it from its context menu.',
					issueLinkingConfig !== null ? editAndRemove('editIssueLinking', 'removeIssueLinking', 'Issue Linking') : settingsButtonHtml('id="editIssueLinking"', 'Add', SVG_ICONS.plus), issueBody);
			}

			if (this.config !== null && this.hasCard('pullRequests')) {
				const pullRequestConfig = this.repo.pullRequestConfig;
				let pullRequestBody = '';
				if (pullRequestConfig !== null) {
					const provider = escapeHtml((pullRequestConfig.provider === GG.PullRequestProvider.Bitbucket
						? 'Bitbucket'
						: pullRequestConfig.provider === GG.PullRequestProvider.Custom
							? pullRequestConfig.custom.name
							: pullRequestConfig.provider === GG.PullRequestProvider.GitHub
								? 'GitHub'
								: 'GitLab'
					) + ' (' + pullRequestConfig.hostRootUrl + ')');
					const source = escapeHtml(pullRequestConfig.sourceOwner + '/' + pullRequestConfig.sourceRepo + ' (' + pullRequestConfig.sourceRemote + ')');
					const destination = escapeHtml(pullRequestConfig.destOwner + '/' + pullRequestConfig.destRepo + (pullRequestConfig.destRemote !== null ? ' (' + pullRequestConfig.destRemote + ')' : ''));
					const destinationBranch = escapeHtml(pullRequestConfig.destBranch);
					pullRequestBody = settingsRowHtml('Provider', provider, provider, '') + settingsRowHtml('Source Repo', source, source, '') +
						settingsRowHtml('Destination Repo', destination, destination, '') + settingsRowHtml('Destination Branch', destinationBranch, destinationBranch, '');
				}
				html += settingsCardHtml('settingsPullRequests', 'Pull Request Creation', 'Opens a pre-filled pull request form from a branch\'s context menu.',
					pullRequestConfig !== null ? editAndRemove('editPullRequestIntegration', 'removePullRequestIntegration', 'Pull Request Creation') : settingsButtonHtml('id="editPullRequestIntegration"', 'Configure', SVG_ICONS.gear), pullRequestBody);
			}

			if (this.hasCard('gitTree')) {
				html += settingsCardHtml('settingsGitTree', 'Git Tree Configuration', 'The extension\'s settings, and a file that shares this repository\'s Git Tree settings with others.', '',
					'<div class="settingsCardButtons">' + settingsButtonHtml('id="openExtensionSettings"', 'Open Git Tree Extension Settings', SVG_ICONS.gear) +
					settingsButtonHtml('id="exportRepositoryConfig"', 'Export Repository Configuration', SVG_ICONS.package) + '</div>');
			}

			const focus = captureSettingsFocus(this.contentsElem);
			this.contentsElem.innerHTML = html;
			this.remoteHosts.render(document.getElementById('settingsRemoteHosts'));
			if (!this.contentsElem.contains(document.activeElement)) restoreSettingsFocus(this.contentsElem, focus);

			if (this.hasCard('general')) {
				document.getElementById('editRepoName')!.addEventListener('click', () => {
					if (this.currentRepo === null || this.repo === null) return;
					dialog.showForm('Specify a Name for this Repository:', [
						{ type: DialogInputType.Text, name: 'Name', default: this.repo.name || '', placeholder: getRepoName(this.currentRepo) }
					], 'Save Name', (values) => {
						if (this.currentRepo === null) return;
						this.view.saveRepoStateValue(this.currentRepo, 'name', <string>values[0] || null);
						this.view.renderRepoDropdownOptions();
						this.render();
					}, null);
				});

				if (this.repo.name !== null) {
					document.getElementById('deleteRepoName')!.addEventListener('click', () => {
						if (this.currentRepo === null || this.repo === null || this.repo.name === null) return;
						dialog.showConfirmation('Are you sure you want to delete the manually configured name <b><i>' + escapeHtml(this.repo.name) + '</i></b> for this repository, and use the default name from the File System <b><i>' + escapeHtml(getRepoName(this.currentRepo)) + '</i></b>?', 'Yes, delete', () => {
							if (this.currentRepo === null) return;
							this.view.saveRepoStateValue(this.currentRepo, 'name', null);
							this.view.renderRepoDropdownOptions();
							this.render();
						}, null);
					});
				}

				document.getElementById('editInitialBranches')!.addEventListener('click', () => {
					if (this.repo === null) return;
					const showCheckedOutBranch = getOnRepoLoadShowCheckedOutBranch(this.repo.onRepoLoadShowCheckedOutBranch);
					const showSpecificBranches = getOnRepoLoadShowSpecificBranches(this.repo.onRepoLoadShowSpecificBranches);
					dialog.showForm('<b>Configure Initial Branches</b><p style="margin:6px 0;">Configure the branches that are initially shown when this repository is loaded in the Git Tree View.</p><p style="font-size:12px; margin:6px 0 0 0;">Note: When "Checked Out Branch" is Disabled, and no "Specific Branches" are selected, all branches will be shown.</p>', [
						{ type: DialogInputType.Checkbox, name: 'Checked Out Branch', value: showCheckedOutBranch },
						{ type: DialogInputType.Select, name: 'Specific Branches', options: this.view.getBranchOptions(), defaults: showSpecificBranches, multiple: true }
					], 'Save Configuration', (values) => {
						if (this.currentRepo === null) return;
						if (showCheckedOutBranch !== values[0] || !arraysStrictlyEqualIgnoringOrder(showSpecificBranches, <string[]>values[1])) {
							this.view.saveRepoStateValue(this.currentRepo, 'onRepoLoadShowCheckedOutBranch', values[0] ? GG.BooleanOverride.Enabled : GG.BooleanOverride.Disabled);
							this.view.saveRepoStateValue(this.currentRepo, 'onRepoLoadShowSpecificBranches', <string[]>values[1]);
							this.render();
						}
					}, null, 'Cancel', null, false);
				});

				if (initialBranchesLocallyConfigured) {
					document.getElementById('clearInitialBranches')!.addEventListener('click', () => {
						dialog.showConfirmation('Are you sure you want to clear the branches that are initially shown when this repository is loaded in the Git Tree View?', 'Yes, clear', () => {
							if (this.currentRepo === null) return;
							this.view.saveRepoStateValue(this.currentRepo, 'onRepoLoadShowCheckedOutBranch', GG.BooleanOverride.Default);
							this.view.saveRepoStateValue(this.currentRepo, 'onRepoLoadShowSpecificBranches', null);
							this.render();
						}, null);
					});
				}

				// Each switch saves its setting, and the view reloads to show it
				const switches: ReadonlyArray<readonly [string, 'showRemoteBranchesV2' | 'showStashes' | 'showTags' | 'includeCommitsMentionedByReflogs' | 'onlyFollowFirstParent']> = [
					['settingsShowRemoteBranchesCheckbox', 'showRemoteBranchesV2'], ['settingsShowStashesCheckbox', 'showStashes'], ['settingsShowTagsCheckbox', 'showTags'],
					['settingsIncludeCommitsMentionedByReflogsCheckbox', 'includeCommitsMentionedByReflogs'], ['settingsOnlyFollowFirstParentCheckbox', 'onlyFollowFirstParent']
				];
				switches.forEach(([id, key]) => {
					document.getElementById(id)!.addEventListener('change', (e) => {
						if (this.currentRepo === null) return;
						this.view.saveRepoStateValue(this.currentRepo, key, (<HTMLInputElement>e.target).checked ? GG.BooleanOverride.Enabled : GG.BooleanOverride.Disabled);
						this.view.refresh(true);
					});
				});
			}

			if (this.config !== null && this.hasCard('userDetails')) {
				document.getElementById('editUserDetails')!.addEventListener('click', () => {
					if (this.config === null) return;
					const userName = this.config.user.name, userEmail = this.config.user.email;
					dialog.showForm('Set the user name and email used by Git to record the Author and Committer of commit objects:', [
						{ type: DialogInputType.Text, name: 'User Name', default: userName.local ?? userName.global ?? '', placeholder: null },
						{ type: DialogInputType.Text, name: 'User Email', default: userEmail.local ?? userEmail.global ?? '', placeholder: null },
						{ type: DialogInputType.Checkbox, name: 'Use Globally', value: userName.local === null && userEmail.local === null, info: 'Use the "User Name" and "User Email" globally for all Git repositories (it can be overridden per repository).' }
					], 'Set User Details', (values) => {
						if (this.currentRepo === null) return;
						const useGlobally = <boolean>values[2];
						runAction({
							command: 'editUserDetails',
							repo: this.currentRepo,
							name: <string>values[0],
							email: <string>values[1],
							location: useGlobally ? GG.GitConfigLocation.Global : GG.GitConfigLocation.Local,
							deleteLocalName: useGlobally && userName.local !== null,
							deleteLocalEmail: useGlobally && userEmail.local !== null
						}, 'Setting User Details');
					}, null);
				});

				if (userNameSet || userEmailSet) {
					document.getElementById('removeUserDetails')!.addEventListener('click', () => {
						if (this.config === null) return;
						const userName = this.config.user.name, userEmail = this.config.user.email;
						const isGlobal = userName.local === null && userEmail.local === null;
						dialog.showConfirmation('Are you sure you want to remove the <b>' + (isGlobal ? 'globally' : 'locally') + ' configured</b> user name and email, which are used by Git to record the Author and Committer of commit objects?', 'Yes, remove', () => {
							if (this.currentRepo === null) return;
							runAction({
								command: 'deleteUserDetails',
								repo: this.currentRepo,
								name: (isGlobal ? userName.global : userName.local) !== null,
								email: (isGlobal ? userEmail.global : userEmail.local) !== null,
								location: isGlobal ? GG.GitConfigLocation.Global : GG.GitConfigLocation.Local
							}, 'Removing User Details');
						}, null);
					});
				}
			}

			if (this.config !== null && this.hasCard('remotes')) {
				const pushUrlPlaceholder = 'Leave blank to use the Fetch URL';
				document.getElementById('settingsAddRemote')!.addEventListener('click', () => {
					dialog.showForm('Add a new remote to this repository:', [
						{ type: DialogInputType.Text, name: 'Name', default: '', placeholder: null },
						{ type: DialogInputType.Text, name: 'Fetch URL', default: '', placeholder: null },
						{ type: DialogInputType.Text, name: 'Push URL', default: '', placeholder: pushUrlPlaceholder },
						{ type: DialogInputType.Checkbox, name: 'Fetch Immediately', value: true }
					], 'Add Remote', (values) => {
						if (this.currentRepo === null) return;
						runAction({ command: 'addRemote', repo: this.currentRepo, name: <string>values[0], url: <string>values[1], pushUrl: <string>values[2] !== '' ? <string>values[2] : null, fetch: <boolean>values[3] }, 'Adding Remote');
					}, { type: TargetType.Repo });
				});

				addListenerToClass('editRemote', 'click', (e) => {
					const remote = this.getRemoteForBtnEvent(e);
					if (remote === null) return;
					dialog.showForm('Edit the remote <b><i>' + escapeHtml(remote.name) + '</i></b>:', [
						{ type: DialogInputType.Text, name: 'Name', default: remote.name, placeholder: null },
						{ type: DialogInputType.Text, name: 'Fetch URL', default: remote.url !== null ? remote.url : '', placeholder: null },
						{ type: DialogInputType.Text, name: 'Push URL', default: remote.pushUrl !== null ? remote.pushUrl : '', placeholder: pushUrlPlaceholder }
					], 'Save Changes', (values) => {
						if (this.currentRepo === null) return;
						runAction({ command: 'editRemote', repo: this.currentRepo, nameOld: remote.name, nameNew: <string>values[0], urlOld: remote.url, urlNew: <string>values[1] !== '' ? <string>values[1] : null, pushUrlOld: remote.pushUrl, pushUrlNew: <string>values[2] !== '' ? <string>values[2] : null }, 'Saving Changes to Remote');
					}, { type: TargetType.Repo });
				});

				addListenerToClass('deleteRemote', 'click', (e) => {
					const remote = this.getRemoteForBtnEvent(e);
					if (remote === null) return;
					dialog.showConfirmation('Are you sure you want to delete the remote <b><i>' + escapeHtml(remote.name) + '</i></b>?', 'Yes, delete', () => {
						if (this.currentRepo === null) return;
						runAction({ command: 'deleteRemote', repo: this.currentRepo, name: remote.name }, 'Deleting Remote');
					}, { type: TargetType.Repo });
				});

				addListenerToClass('fetchRemote', 'click', (e) => {
					const remote = this.getRemoteForBtnEvent(e);
					if (remote === null) return;
					dialog.showForm('Are you sure you want to fetch from the remote <b><i>' + escapeHtml(remote.name) + '</i></b>?', [
						{ type: DialogInputType.Checkbox, name: 'Prune', value: initialState.config.dialogDefaults.fetchRemote.prune, info: 'Before fetching, remove any remote-tracking references that no longer exist on the remote.' },
						{ type: DialogInputType.Checkbox, name: 'Prune Tags', value: initialState.config.dialogDefaults.fetchRemote.pruneTags, info: 'Before fetching, remove any local tags that no longer exist on the remote. Requires "Prune" to be enabled.' }
					], 'Yes, fetch', (values) => {
						if (this.currentRepo === null) return;
						runAction({ command: 'fetch', repo: this.currentRepo, name: remote.name, prune: <boolean>values[0], pruneTags: <boolean>values[1] }, 'Fetching from Remote');
					}, { type: TargetType.Repo });
				});

				addListenerToClass('pruneRemote', 'click', (e) => {
					const remote = this.getRemoteForBtnEvent(e);
					if (remote === null) return;
					dialog.showConfirmation('Are you sure you want to prune remote-tracking references that no longer exist on the remote <b><i>' + escapeHtml(remote.name) + '</i></b>?', 'Yes, prune', () => {
						if (this.currentRepo === null) return;
						runAction({ command: 'pruneRemote', repo: this.currentRepo, name: remote.name }, 'Pruning Remote');
					}, { type: TargetType.Repo });
				});

				addListenerToClass('hideRemoteBtn', 'click', (e) => {
					if (this.currentRepo === null || this.repo === null || this.config === null) return;
					const source = <HTMLElement>(<Element>e.target).closest('.hideRemoteBtn')!;
					const remote = this.config.remotes[parseInt(source.dataset.index!)].name;
					if (!this.repo.hideRemotes.includes(remote)) {
						this.repo.hideRemotes.push(remote);
					} else {
						this.repo.hideRemotes.splice(this.repo.hideRemotes.indexOf(remote), 1);
					}
					this.view.saveRepoStateValue(this.currentRepo, 'hideRemotes', this.repo.hideRemotes);
					this.view.refresh(true);
					this.render();
				});
			}

			if (this.hasCard('issueLinking')) {
				document.getElementById('editIssueLinking')!.addEventListener('click', () => {
					if (this.repo === null) return;
					const issueLinkingConfig = this.repo.issueLinkingConfig || globalState.issueLinkingConfig;
					if (issueLinkingConfig !== null) {
						this.showIssueLinkingDialog(issueLinkingConfig.issue, issueLinkingConfig.url, this.repo.issueLinkingConfig === null && globalState.issueLinkingConfig !== null, true);
					} else {
						this.showIssueLinkingDialog(null, null, false, false);
					}
				});

				if (this.repo.issueLinkingConfig !== null || globalState.issueLinkingConfig !== null) {
					document.getElementById('removeIssueLinking')!.addEventListener('click', () => {
						if (this.repo === null) return;
						const locallyConfigured = this.repo.issueLinkingConfig !== null;
						dialog.showConfirmation('Are you sure you want to remove ' + (locallyConfigured ? (globalState.issueLinkingConfig !== null ? 'the <b>locally configured</b> ' : '') + 'Issue Linking from this repository' : 'the <b>globally configured</b> Issue Linking in Git Tree') + '?', 'Yes, remove', () => {
							this.setIssueLinkingConfig(null, !locallyConfigured);
						}, null);
					});
				}
			}

			if (this.config !== null && this.hasCard('pullRequests')) {
				document.getElementById('editPullRequestIntegration')!.addEventListener('click', () => {
					if (this.repo === null || this.config === null) return;

					if (this.config.remotes.length === 0) {
						dialog.showError('Unable to configure the "Pull Request Creation" Integration', 'The repository must have at least one remote to configure the "Pull Request Creation" Integration. There are no remotes in the current repository.', null, null);
						return;
					}

					let config: GG.DeepWriteable<GG.PullRequestConfig>;
					if (this.repo.pullRequestConfig === null) {
						let originIndex = this.config.remotes.findIndex((remote) => remote.name === 'origin');
						let sourceRemoteUrl = this.config.remotes[originIndex > -1 ? originIndex : 0].url;
						let provider: GG.PullRequestProvider;
						if (sourceRemoteUrl !== null) {
							if (sourceRemoteUrl.match(/^(https?:\/\/|git@)[^/]*github/) !== null) {
								provider = GG.PullRequestProvider.GitHub;
							} else if (sourceRemoteUrl.match(/^(https?:\/\/|git@)[^/]*gitlab/) !== null) {
								provider = GG.PullRequestProvider.GitLab;
							} else {
								provider = GG.PullRequestProvider.Bitbucket;
							}
						} else {
							provider = GG.PullRequestProvider.Bitbucket;
						}
						config = {
							provider: provider, hostRootUrl: '',
							sourceRemote: '', sourceOwner: '', sourceRepo: '',
							destRemote: '', destOwner: '', destRepo: '', destProjectId: '', destBranch: '',
							custom: null
						};
					} else {
						config = Object.assign({}, this.repo.pullRequestConfig);
					}
					this.showCreatePullRequestIntegrationDialog1(config);
				});

				if (this.repo.pullRequestConfig !== null) {
					document.getElementById('removePullRequestIntegration')!.addEventListener('click', () => {
						dialog.showConfirmation('Are you sure you want to remove the configured "Pull Request Creation" Integration?', 'Yes, remove', () => {
							this.setPullRequestConfig(null);
						}, null);
					});
				}
			}

			if (this.hasCard('gitTree')) {
				document.getElementById('openExtensionSettings')!.addEventListener('click', () => {
					sendMessage({ command: 'openExtensionSettings' });
				});

				document.getElementById('exportRepositoryConfig')!.addEventListener('click', () => {
					dialog.showConfirmation('Exporting the Git Tree Repository Configuration will generate a file that can be committed in this repository. It allows others working in this repository to use the same configuration.', 'Yes, export', () => {
						if (this.currentRepo === null) return;
						runAction({ command: 'exportRepoConfig', repo: this.currentRepo }, 'Exporting Repository Configuration');
					}, null);
				});
			}
		}

		alterClass(this.widgetElem, CLASS_LOADING, this.loading);
		this.loadingElem.innerHTML = this.loading ? '<span>' + SVG_ICONS.loading + 'Loading ...</span>' : '';
		this.widgetElem.scrollTop = this.scrollTop;
		this.loadingElem.style.top = (this.scrollTop + (this.widgetElem.clientHeight / 2) - 12) + 'px';
	}


	/* Private Helper Methods */

	/**
	 * Does the open page show a card.
	 * @param card The card.
	 * @returns TRUE => The page shows the card, FALSE => It doesn't.
	 */
	private hasCard(card: SettingsCard) {
		return SETTINGS_PAGES[this.page].cards.includes(card);
	}

	/**
	 * Save the issue linking configuration for this repository, and refresh the view so these changes are taken into affect.
	 * @param config The issue linking configuration to save.
	 * @param global Should this configuration be set globally for all repositories, or locally for this specific repository.
	 */
	private setIssueLinkingConfig(config: GG.IssueLinkingConfig | null, global: boolean) {
		if (this.currentRepo === null || this.repo === null) return;

		if (global) {
			if (this.repo.issueLinkingConfig !== null) {
				this.view.saveRepoStateValue(this.currentRepo, 'issueLinkingConfig', null);
			}
			updateGlobalViewState('issueLinkingConfig', config);
		} else {
			this.view.saveRepoStateValue(this.currentRepo, 'issueLinkingConfig', config);
		}

		this.view.refresh(true);
		this.render();
	}

	/**
	 * Save the pull request configuration for this repository.
	 * @param config The pull request configuration to save.
	 */
	private setPullRequestConfig(config: GG.PullRequestConfig | null) {
		if (this.currentRepo === null) return;
		this.view.saveRepoStateValue(this.currentRepo, 'pullRequestConfig', config);
		this.render();
	}

	/**
	 * Show the dialog allowing the user to configure the issue linking for this repository.
	 * @param defaultIssueRegex The default regular expression used to match issue numbers.
	 * @param defaultIssueUrl The default URL for the issue number to be substituted into.
	 * @param defaultUseGlobally The default value for the checkbox determining whether the issue linking configuration should be used globally (for all repositories).
	 * @param isEdit Is the dialog editing an existing issue linking configuration.
	 */
	private showIssueLinkingDialog(defaultIssueRegex: string | null, defaultIssueUrl: string | null, defaultUseGlobally: boolean, isEdit: boolean) {
		let html = '<b>' + (isEdit ? 'Edit Issue Linking for' : 'Add Issue Linking to') + ' this Repository</b>';
		html += '<p style="font-size:12px; margin:6px 0;">The following example links <b>#123</b> in commit messages to <b>https://github.com/owner/repo/issues/123</b>:</p>';
		html += '<table style="display:inline-table; width:360px; text-align:left; font-size:12px; margin-bottom:2px;"><tr><td>Issue Regex:</td><td>#(\\d+)</td></tr><tr><td>Issue URL:</td><td>https://github.com/owner/repo/issues/$1</td></tr></tbody></table>';

		if (!isEdit && defaultIssueRegex === null && defaultIssueUrl === null) {
			defaultIssueRegex = SettingsWidget.autoDetectIssueRegex(this.view.getCommits());
			if (defaultIssueRegex !== null) {
				html += '<p style="font-size:12px"><i>The prefilled Issue Regex was detected in commit messages in this repository. Review and/or correct it if necessary.</i></p>';
			}
		}

		dialog.showForm(html, [
			{ type: DialogInputType.Text, name: 'Issue Regex', default: defaultIssueRegex !== null ? defaultIssueRegex : '', placeholder: null, info: 'A regular expression that matches your issue numbers, with one or more capturing groups ( ) that will be substituted into the "Issue URL".' },
			{ type: DialogInputType.Text, name: 'Issue URL', default: defaultIssueUrl !== null ? defaultIssueUrl : '', placeholder: null, info: 'The issue\'s URL in your issue tracking system, with placeholders ($1, $2, etc.) for the groups captured ( ) in the "Issue Regex".' },
			{ type: DialogInputType.Checkbox, name: 'Use Globally', value: defaultUseGlobally, info: 'Use the "Issue Regex" and "Issue URL" for all repositories by default (it can be overridden per repository). Note: "Use Globally" is only suitable if identical Issue Linking applies to the majority of your repositories (e.g. when using JIRA or Pivotal Tracker).' }
		], 'Save', (values) => {
			let issueRegex = (<string>values[0]).trim(), issueUrl = (<string>values[1]).trim(), useGlobally = <boolean>values[2];
			let regExpParseError = null;
			try {
				if (issueRegex.indexOf('(') === -1 || issueRegex.indexOf(')') === -1) {
					regExpParseError = 'The regular expression does not contain a capturing group ( ).';
				} else if (new RegExp(issueRegex, 'gu')) {
					regExpParseError = null;
				}
			} catch (e) {
				regExpParseError = (<Error>e).message;
			}
			if (regExpParseError !== null) {
				dialog.showError('Invalid Issue Regex', regExpParseError, 'Go Back', () => {
					this.showIssueLinkingDialog(issueRegex, issueUrl, useGlobally, isEdit);
				});
			} else if (!(/\$([1-9][0-9]*)/.test(issueUrl))) {
				dialog.showError('Invalid Issue URL', 'The Issue URL does not contain any placeholders ($1, $2, etc.) for the issue number components captured in the Issue Regex.', 'Go Back', () => {
					this.showIssueLinkingDialog(issueRegex, issueUrl, useGlobally, isEdit);
				});
			} else {
				this.setIssueLinkingConfig({ issue: issueRegex, url: issueUrl }, useGlobally);
			}
		}, null, 'Cancel', null, false);
	}

	/**
	 * Show the first dialog for configuring the pull request integration.
	 * @param config The pull request configuration.
	 */
	private showCreatePullRequestIntegrationDialog1(config: GG.DeepWriteable<GG.PullRequestConfig>) {
		if (this.config === null) return;

		let originIndex = this.config.remotes.findIndex((remote) => remote.name === 'origin');
		let upstreamIndex = this.config.remotes.findIndex((remote) => remote.name === 'upstream');
		let sourceRemoteIndex = this.config.remotes.findIndex((remote) => remote.name === config.sourceRemote);
		let destRemoteIndex = this.config.remotes.findIndex((remote) => remote.name === config.destRemote);

		if (config.sourceRemote === '' || sourceRemoteIndex === -1) {
			sourceRemoteIndex = originIndex > -1 ? originIndex : 0;
		}
		if (config.destRemote === '') {
			destRemoteIndex = upstreamIndex > -1 ? upstreamIndex : originIndex > -1 ? originIndex : 0;
		}

		let defaultProvider = config.provider.toString();
		let providerOptions = [
			{ name: 'Bitbucket', value: (GG.PullRequestProvider.Bitbucket).toString() },
			{ name: 'GitHub', value: (GG.PullRequestProvider.GitHub).toString() },
			{ name: 'GitLab', value: (GG.PullRequestProvider.GitLab).toString() }
		];
		let providerTemplateLookup: { [name: string]: string } = {};
		initialState.config.customPullRequestProviders.forEach((provider) => {
			providerOptions.push({ name: provider.name, value: (providerOptions.length + 1).toString() });
			providerTemplateLookup[provider.name] = provider.templateUrl;
		});
		if (config.provider === GG.PullRequestProvider.Custom) {
			if (!providerOptions.some((provider) => provider.name === config.custom.name)) {
				// The existing custom Pull Request provider no longer exists, so add it.
				providerOptions.push({ name: config.custom.name, value: (providerOptions.length + 1).toString() });
				providerTemplateLookup[config.custom.name] = config.custom.templateUrl;
			}
			defaultProvider = providerOptions.find((provider) => provider.name === config.custom.name)!.value;
		}
		providerOptions.sort((a, b) => a.name.localeCompare(b.name));

		let sourceRemoteOptions = this.config.remotes.map((remote, index) => ({ name: remote.name, value: index.toString() }));
		let destRemoteOptions = sourceRemoteOptions.map((option) => option);
		destRemoteOptions.push({ name: 'Not a remote', value: '-1' });

		dialog.showForm('Configure "Pull Request Creation" Integration (Step&nbsp;1/2)', [
			{
				type: DialogInputType.Select, name: 'Provider',
				options: providerOptions, default: defaultProvider,
				info: 'In addition to the built-in publicly hosted Pull Request providers, custom providers can be configured using the Extension Setting "git-tree.customPullRequestProviders" (e.g. for use with privately hosted Pull Request providers).'
			},
			{
				type: DialogInputType.Select, name: 'Source Remote',
				options: sourceRemoteOptions, default: sourceRemoteIndex.toString(),
				info: 'The remote that corresponds to the source of the Pull Request.'
			},
			{
				type: DialogInputType.Select, name: 'Destination Remote',
				options: destRemoteOptions, default: destRemoteIndex.toString(),
				info: 'The remote that corresponds to the destination / target of the Pull Request.'
			}
		], 'Next', (values) => {
			if (this.config === null) return;

			let newProvider = <GG.PullRequestProvider>parseInt(<string>values[0]);
			if (newProvider > 3) newProvider = GG.PullRequestProvider.Custom;

			const newSourceRemoteIndex = parseInt(<string>values[1]);
			const newDestRemoteIndex = parseInt(<string>values[2]);
			const newSourceRemote = this.config.remotes[newSourceRemoteIndex].name;
			const newDestRemote = newDestRemoteIndex > -1 ? this.config.remotes[newDestRemoteIndex].name : null;
			const newSourceUrl = this.config.remotes[newSourceRemoteIndex].url;
			const newDestUrl = newDestRemoteIndex > -1 ? this.config.remotes[newDestRemoteIndex].url : null;

			if (config.hostRootUrl === '' || config.provider !== newProvider) {
				const remoteUrlForHost = newSourceUrl !== null ? newSourceUrl : newDestUrl;
				if (remoteUrlForHost !== null) {
					const match = remoteUrlForHost.match(/^(https?:\/\/|git@)((?=[^/]+@)[^@]+@|(?![^/]+@))([^/:]+)/);
					config.hostRootUrl = match !== null ? 'https://' + match[3] : '';
				} else {
					config.hostRootUrl = '';
				}
			}

			if (newProvider === GG.PullRequestProvider.Custom) {
				const customProviderName = providerOptions.find((provider) => provider.value === <string>values[0])!.name;
				config.custom = { name: customProviderName, templateUrl: providerTemplateLookup[customProviderName] };
			} else {
				config.custom = null;
			}
			config.provider = newProvider;

			if (config.sourceRemote !== newSourceRemote) {
				config.sourceRemote = newSourceRemote;
				const match = newSourceUrl !== null ? newSourceUrl.match(/^(https?:\/\/|git@)[^/:]+[/:]([^/]+)\/([^/]*?)(.git|)$/) : null;
				config.sourceOwner = match !== null ? match[2] : '';
				config.sourceRepo = match !== null ? match[3] : '';
			}

			if (config.provider !== GG.PullRequestProvider.GitLab || config.destRemote !== newDestRemote) {
				config.destProjectId = '';
			}

			if (config.destRemote !== newDestRemote) {
				config.destRemote = newDestRemote;
				if (newDestRemote !== null) {
					const match = newDestUrl !== null ? newDestUrl.match(/^(https?:\/\/|git@)[^/:]+[/:]([^/]+)\/([^/]*?)(.git|)$/) : null;
					config.destOwner = match !== null ? match[2] : '';
					config.destRepo = match !== null ? match[3] : '';
					const branches = this.view.getBranches()
						.filter((branch) => branch.startsWith('remotes/' + newDestRemote + '/') && branch !== ('remotes/' + newDestRemote + '/HEAD'))
						.map((branch) => branch.substring(newDestRemote.length + 9));
					config.destBranch = branches.length > 0 ? branches.includes('master') ? 'master' : branches[0] : '';
				} else {
					config.destOwner = '';
					config.destRepo = '';
					config.destBranch = '';
				}
			}

			this.showCreatePullRequestIntegrationDialog2(config);
		}, { type: TargetType.Repo });
	}

	/**
	 * Show the second dialog for configuring the pull request integration.
	 * @param config The pull request configuration.
	 */
	private showCreatePullRequestIntegrationDialog2(config: GG.DeepWriteable<GG.PullRequestConfig>) {
		if (this.config === null) return;

		const destBranches = config.destRemote !== null
			? this.view.getBranches()
				.filter((branch) => branch.startsWith('remotes/' + config.destRemote + '/') && branch !== ('remotes/' + config.destRemote + '/HEAD'))
				.map((branch) => branch.substring(config.destRemote!.length + 9))
			: [];
		const destBranchInfo = 'The name of the branch that is the destination / target of the Pull Request.';

		const updateConfigWithFormValues = (values: DialogInputValue[]) => {
			const hostRootUri = <string>values[0];
			config.hostRootUrl = hostRootUri.endsWith('/') ? hostRootUri.substring(0, hostRootUri.length - 1) : hostRootUri;
			config.sourceOwner = <string>values[1];
			config.sourceRepo = <string>values[2];
			config.destOwner = <string>values[3];
			config.destRepo = <string>values[4];
			config.destProjectId = config.provider === GG.PullRequestProvider.GitLab ? <string>values[5] : '';
			const destBranch = <string>values[config.provider === GG.PullRequestProvider.GitLab ? 6 : 5];
			config.destBranch = config.destRemote === null || destBranches.length === 0
				? destBranch
				: destBranches[parseInt(destBranch)];
		};

		const inputs: DialogInput[] = [
			{ type: DialogInputType.Text, name: 'Host Root URL', default: config.hostRootUrl, placeholder: null, info: 'The Pull Request provider\'s Host Root URL (e.g. https://github.com).' },
			{ type: DialogInputType.Text, name: 'Source Owner', default: config.sourceOwner, placeholder: null, info: 'The owner of the repository that is the source of the Pull Request.' },
			{ type: DialogInputType.Text, name: 'Source Repo', default: config.sourceRepo, placeholder: null, info: 'The name of the repository that is the source of the Pull Request.' },
			{ type: DialogInputType.Text, name: 'Destination Owner', default: config.destOwner, placeholder: null, info: 'The owner of the repository that is the destination / target of the Pull Request.' },
			{ type: DialogInputType.Text, name: 'Destination Repo', default: config.destRepo, placeholder: null, info: 'The name of the repository that is the destination / target of the Pull Request.' }
		];
		if (config.provider === GG.PullRequestProvider.GitLab) {
			inputs.push({ type: DialogInputType.Text, name: 'Destination Project ID', default: config.destProjectId, placeholder: null, info: 'The GitLab Project ID of the destination / target of the Pull Request. Leave this field blank to use the default destination / target configured in GitLab.' });
		}
		inputs.push(config.destRemote === null || destBranches.length === 0
			? { type: DialogInputType.Text, name: 'Destination Branch', default: config.destBranch, placeholder: null, info: destBranchInfo }
			: {
				type: DialogInputType.Select,
				name: 'Destination Branch',
				options: destBranches.map((branch, index) => ({ name: branch, value: index.toString() })),
				default: destBranches.includes(config.destBranch) ? destBranches.indexOf(config.destBranch).toString() : '0',
				info: destBranchInfo
			}
		);

		dialog.showForm('Configure "Pull Request Creation" Integration (Step&nbsp;2/2)', inputs, 'Save Configuration', (values) => {
			updateConfigWithFormValues(values);
			this.setPullRequestConfig(config);
		}, { type: TargetType.Repo }, 'Back', (values) => {
			updateConfigWithFormValues(values);
			this.showCreatePullRequestIntegrationDialog1(config);
		});
	}

	/**
	 * Get the remote details corresponding to a mouse event.
	 * @param e The mouse event.
	 * @returns The details of the remote.
	 */
	private getRemoteForBtnEvent(e: Event) {
		return this.config !== null
			? this.config.remotes[parseInt((<HTMLElement>(<Element>e.target).closest('.remoteBtns')!).dataset.index!)]
			: null;
	}

	/**
	 * Automatically detect common issue number formats in the specified commits, returning the most common.
	 * @param commits The commits to analyse.
	 * @returns The regular expression of the most likely issue number format.
	 */
	private static autoDetectIssueRegex(commits: ReadonlyArray<GG.GitCommit>) {
		const patterns = ['#(\\d+)', '^(\\d+)\\.(?=\\s|$)', '^(\\d+):(?=\\s|$)', '([A-Za-z]+-\\d+)'].map((pattern) => {
			const regexp = new RegExp(pattern);
			return {
				pattern: pattern,
				matches: commits.filter((commit) => regexp.test(commit.message)).length
			};
		}).sort((a, b) => b.matches - a.matches);

		if (patterns[0].matches > 0.1 * commits.length) {
			// If the most common pattern was matched in more than 10% of commits, return the pattern
			return patterns[0].pattern;
		}
		return null;
	}
}
