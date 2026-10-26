const CLASS_FIND_CURRENT_COMMIT = 'findCurrentCommit';
const CLASS_FIND_MATCH = 'findMatch';

interface FindWidgetState {
	readonly text: string;
	readonly currentHash: string | null;
	readonly visible: boolean;
}

/**
 * Implements the Git Tree View's Find Widget.
 */
class FindWidget {
	private readonly view: GitTreeView;
	private text: string = '';
	private matches: { hash: string, index: number }[] = [];
	private matchPositions: Map<number, number> = new Map(); // The position of each match in matches, by the index of its commit
	private position: number = -1;
	private visible: boolean = false;
	private highlightPattern: RegExp | null = null; // The global pattern that highlights the matches in the rows
	private highlightFullHash: RegExp | null = null; // The pattern that also highlights a commit column whose full hash matches, or NULL if it's hidden

	private readonly widgetElem: HTMLElement;
	private readonly inputElem: HTMLInputElement;
	private readonly caseSensitiveElem: HTMLElement;
	private readonly regexElem: HTMLElement;
	private readonly positionElem: HTMLElement;
	private readonly prevElem: HTMLElement;
	private readonly nextElem: HTMLElement;

	/**
	 * Construct a new FindWidget instance.
	 * @param view The Git Tree View that the FindWidget is for.
	 * @returns The FindWidget instance.
	 */
	constructor(view: GitTreeView) {
		this.view = view;
		this.widgetElem = document.createElement('div');
		this.widgetElem.className = 'findWidget';
		this.widgetElem.innerHTML = '<input id="findInput" type="text" placeholder="Find" disabled/><span id="findCaseSensitive" class="findModifier" title="Match Case">Aa</span><span id="findRegex" class="findModifier" title="Use Regular Expression">.*</span><span id="findPosition"></span><span id="findPrev" title="Previous match (Shift+Enter)"></span><span id="findNext" title="Next match (Enter)"></span><span id="findOpenCdv" title="Open the Commit Details View for the current match"></span><span id="findClose" title="Close (Escape)"></span>';
		document.body.appendChild(this.widgetElem);

		this.inputElem = <HTMLInputElement>document.getElementById('findInput')!;
		let keyupTimeout: NodeJS.Timeout | null = null;
		this.inputElem.addEventListener('keyup', (e) => {
			if ((e.keyCode ? e.keyCode === 13 : e.key === 'Enter') && this.text !== '') {
				if (e.shiftKey) {
					this.prev();
				} else {
					this.next();
				}
				handledEvent(e);
			} else {
				if (keyupTimeout !== null) clearTimeout(keyupTimeout);
				keyupTimeout = setTimeout(() => {
					keyupTimeout = null;
					if (this.text !== this.inputElem.value) {
						this.text = this.inputElem.value;
						this.clearMatches();
						this.findMatches(this.getCurrentHash(), true);
						this.openCommitDetailsViewForCurrentMatchIfEnabled();
					}
				}, 200);
			}
		});

		this.caseSensitiveElem = document.getElementById('findCaseSensitive')!;
		alterClass(this.caseSensitiveElem, CLASS_ACTIVE, workspaceState.findIsCaseSensitive);
		this.caseSensitiveElem.addEventListener('click', () => {
			updateWorkspaceViewState('findIsCaseSensitive', !workspaceState.findIsCaseSensitive);
			alterClass(this.caseSensitiveElem, CLASS_ACTIVE, workspaceState.findIsCaseSensitive);
			this.clearMatches();
			this.findMatches(this.getCurrentHash(), true);
			this.openCommitDetailsViewForCurrentMatchIfEnabled();
		});

		this.regexElem = document.getElementById('findRegex')!;
		alterClass(this.regexElem, CLASS_ACTIVE, workspaceState.findIsRegex);
		this.regexElem.addEventListener('click', () => {
			updateWorkspaceViewState('findIsRegex', !workspaceState.findIsRegex);
			alterClass(this.regexElem, CLASS_ACTIVE, workspaceState.findIsRegex);
			this.clearMatches();
			this.findMatches(this.getCurrentHash(), true);
			this.openCommitDetailsViewForCurrentMatchIfEnabled();
		});

		this.positionElem = document.getElementById('findPosition')!;

		this.prevElem = document.getElementById('findPrev')!;
		this.prevElem.classList.add(CLASS_DISABLED);
		this.prevElem.innerHTML = SVG_ICONS.arrowUp;
		this.prevElem.addEventListener('click', () => this.prev());

		this.nextElem = document.getElementById('findNext')!;
		this.nextElem.classList.add(CLASS_DISABLED);
		this.nextElem.innerHTML = SVG_ICONS.arrowDown;
		this.nextElem.addEventListener('click', () => this.next());

		const openCdvElem = document.getElementById('findOpenCdv')!;
		openCdvElem.innerHTML = SVG_ICONS.cdv;
		alterClass(openCdvElem, CLASS_ACTIVE, workspaceState.findOpenCommitDetailsView);
		openCdvElem.addEventListener('click', () => {
			updateWorkspaceViewState('findOpenCommitDetailsView', !workspaceState.findOpenCommitDetailsView);
			alterClass(openCdvElem, CLASS_ACTIVE, workspaceState.findOpenCommitDetailsView);
			this.openCommitDetailsViewForCurrentMatchIfEnabled();
		});

		const findCloseElem = document.getElementById('findClose')!;
		findCloseElem.innerHTML = SVG_ICONS.close;
		findCloseElem.addEventListener('click', () => this.close());
	}

	/**
	 * Show the Find Widget.
	 * @param transition Should the Find Widget animate when becoming visible (sliding down).
	 */
	public show(transition: boolean) {
		if (!this.visible) {
			this.visible = true;
			this.inputElem.value = this.text;
			this.inputElem.disabled = false;
			this.updatePosition(-1, false);
			alterClass(this.widgetElem, CLASS_TRANSITION, transition);
			this.widgetElem.classList.add(CLASS_ACTIVE);
		}
		this.inputElem.focus();
	}

	/**
	 * Close the Find Widget, sliding it up out of view.
	 */
	public close() {
		if (!this.visible) return;
		this.visible = false;
		this.widgetElem.classList.add(CLASS_TRANSITION);
		this.widgetElem.classList.remove(CLASS_ACTIVE);
		this.clearMatches();
		this.text = '';
		this.matches = [];
		this.matchPositions = new Map();
		this.position = -1;
		this.inputElem.value = this.text;
		this.inputElem.disabled = true;
		this.widgetElem.removeAttribute(ATTR_ERROR);
		this.prevElem.classList.add(CLASS_DISABLED);
		this.nextElem.classList.add(CLASS_DISABLED);
		this.view.saveState();
	}

	/**
	 * Refresh the Find Widget's state / matches after the commits have changed.
	 */
	public refresh() {
		if (this.visible) {
			this.findMatches(this.getCurrentHash(), false);
		}
	}

	/**
	 * Set the colours used to indicate the find matches.
	 * @param colour The base colour for the find matches.
	 */
	public setColour(colour: string) {
		document.body.style.setProperty('--git-tree-findMatch', colour);
		document.body.style.setProperty('--git-tree-findMatchCommit', modifyColourOpacity(colour, 0.5));
	}


	/* State */

	/**
	 * Get the current state of the Find Widget.
	 */
	public getState(): FindWidgetState {
		return {
			text: this.text,
			currentHash: this.getCurrentHash(),
			visible: this.visible
		};
	}

	/**
	 * Get the commit hash of the current find match.
	 * @returns The commit hash, or NULL if no commit is currently matched.
	 */
	public getCurrentHash() {
		return this.position > -1 ? this.matches[this.position].hash : null;
	}

	/**
	 * Restore the Find Widget to an existing state.
	 * @param state The previous Find Widget state.
	 */
	public restoreState(state: FindWidgetState) {
		if (!state.visible) return;
		this.text = state.text;
		this.show(false);
		if (this.text !== '') this.findMatches(state.currentHash, false);
	}

	/**
	 * Is the Find Widget currently visible.
	 * @returns TRUE => The Find Widget is visible, FALSE => The Find Widget is not visible
	 */
	public isVisible() {
		return this.visible;
	}


	/* Matching */

	/**
	 * Find all matches based on the user's criteria. The commits are matched from their data, as most of their rows aren't rendered; the
	 * rendered rows are highlighted now, and each other row as it is rendered (highlightRow).
	 * @param goToCommitHash If this commit hash matches the criteria, directly go to this commit instead of starting at the first match.
	 * @param scrollToCommit Should the resultant find match be scrolled to (so it's visible in the view).
	 */
	private findMatches(goToCommitHash: string | null, scrollToCommit: boolean) {
		this.clearMatches();
		this.matches = [];
		this.matchPositions = new Map();
		this.position = -1;

		if (this.text !== '') {
			let colVisibility = this.view.getColumnVisibility(), findPattern: RegExp | null, findGlobalPattern: RegExp | null;
			const regexText = workspaceState.findIsRegex ? this.text : this.text.replace(/[\\\[\](){}|.*+?^$]/g, '\\$&'), flags = 'u' + (workspaceState.findIsCaseSensitive ? '' : 'i');
			try {
				findPattern = new RegExp(regexText, flags);
				findGlobalPattern = new RegExp(regexText, 'g' + flags);
				this.widgetElem.removeAttribute(ATTR_ERROR);
			} catch (e) {
				findPattern = null;
				findGlobalPattern = null;
				this.widgetElem.setAttribute(ATTR_ERROR, (<Error>e).message);
			}
			if (findPattern !== null && findGlobalPattern !== null) {
				const pattern = findPattern;
				let zeroLengthMatch = false, commit;

				// A pattern that matches an empty string can't be highlighted
				const test = (text: string) => {
					const match = pattern.exec(text);
					if (match !== null && match[0].length === 0) zeroLengthMatch = true;
					return match !== null;
				};
				const testHashStart = (hash: string) => {
					const match = pattern.exec(hash);
					if (match !== null && match[0].length === 0) zeroLengthMatch = true;
					return match !== null && match.index === 0;
				};

				const commits = this.view.getCommits();
				for (let i = 0; i < commits.length && !zeroLengthMatch; i++) {
					commit = commits[i];
					let branchLabels = getBranchLabels(commit.heads, commit.remotes);
					if (!isUncommittedChanges(commit.hash) && (
						(colVisibility.author && test(commit.author))
						|| (colVisibility.commit && (testHashStart(commit.hash) || test(abbrevCommit(commit.hash))))
						|| test(commit.message)
						|| branchLabels.heads.some(head => test(head.name) || head.remotes.some(remote => test(remote)))
						|| branchLabels.remotes.some(remote => test(remote.name))
						|| commit.tags.some(tag => test(tag.name))
						|| (colVisibility.date && test(formatShortDate(commit.date).formatted))
						|| (commit.stash !== null && test(commit.stash.selector))
					)) {
						this.matchPositions.set(i, this.matches.length);
						this.matches.push({ hash: commit.hash, index: i });
					}
				}
				if (zeroLengthMatch) {
					this.widgetElem.setAttribute(ATTR_ERROR, 'Cannot use a regular expression which has zero length matches');
					this.matches = [];
					this.matchPositions = new Map();
				} else {
					this.highlightPattern = findGlobalPattern;
					this.highlightFullHash = colVisibility.commit ? findPattern : null;
					this.view.forEachCommitElem((elem, index) => this.highlightRow(elem, index));
				}
			}
		} else {
			this.widgetElem.removeAttribute(ATTR_ERROR);
		}

		alterClass(this.prevElem, CLASS_DISABLED, this.matches.length === 0);
		alterClass(this.nextElem, CLASS_DISABLED, this.matches.length === 0);

		let newPos = -1;
		if (this.matches.length > 0) {
			newPos = 0;
			if (goToCommitHash !== null) {
				let pos = this.matches.findIndex(match => match.hash === goToCommitHash);
				if (pos > -1) newPos = pos;
			}
		}
		this.updatePosition(newPos, scrollToCommit);
	}

	/**
	 * Highlight the find matches in a rendered row, if its commit is a match.
	 * @param elem The row's element.
	 * @param index The index of the row's commit.
	 */
	public highlightRow(elem: HTMLElement, index: number) {
		const position = this.matchPositions.get(index), findGlobalPattern = this.highlightPattern;
		if (typeof position === 'undefined' || findGlobalPattern === null) return;

		let textElems = getChildNodesWithTextContent(elem), textElem;
		for (let k = 0; k < textElems.length; k++) {
			textElem = textElems[k];
			let matchStart = 0, matchEnd = 0, text = textElem.textContent!, match: RegExpExecArray | null;
			findGlobalPattern.lastIndex = 0;
			while (match = findGlobalPattern.exec(text)) {
				if (match[0].length === 0) break; // Only possible in text that differs from the commit's data (findMatches rejects such patterns)
				if (matchEnd !== match.index) {
					// This match isn't immediately after the previous match, or isn't at the beginning of the text
					if (matchStart !== matchEnd) {
						// There was a previous match, insert it in a text node
						textElem.parentNode!.insertBefore(FindWidget.createMatchElem(text.substring(matchStart, matchEnd)), textElem);
					}
					// Insert a text node containing the text between the last match and the current match
					textElem.parentNode!.insertBefore(document.createTextNode(text.substring(matchEnd, match.index)), textElem);
					matchStart = match.index;
				}
				matchEnd = findGlobalPattern.lastIndex;
			}
			if (matchEnd > 0) {
				// There were one or more matches
				if (matchStart !== matchEnd) {
					// There was a match, insert it in a text node
					textElem.parentNode!.insertBefore(FindWidget.createMatchElem(text.substring(matchStart, matchEnd)), textElem);
				}
				if (matchEnd !== text.length) {
					// There was some text after last match, update the textElem (the last node of it's parent) to contain the remaining text.
					textElem.textContent = text.substring(matchEnd);
				} else {
					// The last match was at the end of the text, the textElem is no longer required, so delete it
					textElem.parentNode!.removeChild(textElem);
				}
			}
		}
		const hash = this.matches[position].hash, findPattern = this.highlightFullHash;
		if (findPattern !== null && hash.search(findPattern) === 0 && !findPattern.test(abbrevCommit(hash)) && textElems.length > 0) {
			// The commit matches on more than the abbreviated commit, so the commit should be highlighted
			let commitNode = textElems[textElems.length - 1]; // Commit is always the last column if it is visible
			commitNode.parentNode!.replaceChild(FindWidget.createMatchElem(commitNode.textContent!), commitNode);
		}

		alterClass(elem, CLASS_FIND_CURRENT_COMMIT, position === this.position);
	}

	/**
	 * Clear all of the highlighted find matches in the view.
	 */
	private clearMatches() {
		this.view.forEachCommitElem((elem, index) => {
			const position = this.matchPositions.get(index);
			if (typeof position === 'undefined') return;
			if (position === this.position) elem.classList.remove(CLASS_FIND_CURRENT_COMMIT);
			let matchElems = getChildrenWithClassName(elem, CLASS_FIND_MATCH), matchElem;
			for (let j = 0; j < matchElems.length; j++) {
				matchElem = matchElems[j];
				let text = matchElem.childNodes[0].textContent!;

				// Combine current text with the text from previous sibling text nodes
				let node = matchElem.previousSibling, prevElem = matchElem.previousElementSibling;
				while (node !== null && node !== prevElem && node.textContent !== null) {
					text = node.textContent + text;
					matchElem.parentNode!.removeChild(node);
					node = matchElem.previousSibling;
				}

				// Combine current text with the text from next sibling text nodes
				node = matchElem.nextSibling;
				prevElem = matchElem.nextElementSibling;
				while (node !== null && node !== prevElem && node.textContent !== null) {
					text = text + node.textContent;
					matchElem.parentNode!.removeChild(node);
					node = matchElem.nextSibling;
				}

				matchElem.parentNode!.replaceChild(document.createTextNode(text), matchElem);
			}
		});
		this.highlightPattern = null;
		this.highlightFullHash = null;
	}

	/**
	 * Update the user's position in the set of find matches.
	 * @param position The new position index within the find matches.
	 * @param scrollToCommit After updating the user's position in the set of find matches, should the current match be scrolled to (so it's visible in the view).
	 */
	private updatePosition(position: number, scrollToCommit: boolean) {
		if (this.position > -1) {
			const elem = this.view.getCommitElem(this.matches[this.position].index, false);
			if (elem !== null) elem.classList.remove(CLASS_FIND_CURRENT_COMMIT);
		}
		this.position = position;
		if (this.position > -1) {
			// A row that isn't rendered yet is marked as the current match by highlightRow when it is
			const match = this.matches[this.position];
			if (scrollToCommit) this.view.scrollToCommit(match.hash, false);
			const elem = this.view.getCommitElem(match.index, false);
			if (elem !== null) elem.classList.add(CLASS_FIND_CURRENT_COMMIT);
		}
		this.positionElem.innerHTML = this.matches.length > 0 ? (this.position + 1) + ' of ' + this.matches.length : 'No Results';
		this.view.saveState();
	}

	/**
	 * Move the user's position to the previous match in the set of find matches.
	 */
	private prev() {
		if (this.matches.length === 0) return;
		this.updatePosition(this.position > 0 ? this.position - 1 : this.matches.length - 1, true);
		this.openCommitDetailsViewForCurrentMatchIfEnabled();
	}

	/**
	 * Move the user's position to the next match in the set of find matches.
	 */
	private next() {
		if (this.matches.length === 0) return;
		this.updatePosition(this.position < this.matches.length - 1 ? this.position + 1 : 0, true);
		this.openCommitDetailsViewForCurrentMatchIfEnabled();
	}

	/**
	 * If the Find Widget is configured to open the Commit Details View for the current find match, load the Commit Details View accordingly.
	 */
	private openCommitDetailsViewForCurrentMatchIfEnabled() {
		if (workspaceState.findOpenCommitDetailsView) {
			const commitHash = this.getCurrentHash();
			if (commitHash !== null && !this.view.isCdvOpen(commitHash, null)) {
				const commitElem = this.view.getCommitElem(this.view.getCommitId(commitHash), true);
				if (commitElem !== null) {
					this.view.loadCommitDetails(commitElem);
				}
			}
		}
	}

	/**
	 * Create a find match element containing the specified text.
	 * @param text The text content of the find match.
	 * @returns The HTML element for the find match.
	 */
	private static createMatchElem(text: string) {
		const span = document.createElement('span');
		span.className = CLASS_FIND_MATCH;
		span.innerHTML = text;
		return span;
	}
}
