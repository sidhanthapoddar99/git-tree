const CLASS_CONTEXT_MENU_ACTIVE = 'contextMenuActive';

interface ContextMenuAction {
	readonly title: string; // HTML
	readonly visible: boolean;
	readonly onClick: () => void;
	readonly checked?: boolean; // Required in checked context menus
	readonly hint?: string; // Dim text after the title, such as a branch name. Plain text.
}

/** A dim heading above a group's actions. It is shown when one of the group's actions is visible. */
interface ContextMenuHeading {
	readonly heading: string; // Plain text
	readonly hint?: string; // Dim text after the heading. Plain text.
}

type ContextMenuActions = ReadonlyArray<ReadonlyArray<ContextMenuAction | ContextMenuHeading>>;

type ContextMenuTarget = {
	type: TargetType.Commit | TargetType.Ref | TargetType.CommitDetailsView;
	elem: HTMLElement;
	hash: string;
	index: number;
	ref?: string;
} | RepoTarget;

/**
 * Implements the Git Tree View's context menus.
 */
class ContextMenu {
	private elem: HTMLElement | null = null;
	private onClose: (() => void) | null = null;
	private target: ContextMenuTarget | null = null;

	/**
	 * Construct a new ContextMenu instance.
	 * @returns The ContextMenu instance.
	 */
	constructor() {
		const listener = () => this.close();
		document.addEventListener('click', listener);
		document.addEventListener('contextmenu', listener);
	}

	/**
	 * Show a context menu in the Git Tree View.
	 * @param actions The collection of actions to display in the context menu.
	 * @param checked Should the context menu display checks to the left of each action.
	 * @param target The target that the context menu was triggered on.
	 * @param at The mouse event that triggered the context menu, which is shown at the cursor, or the element (such as a button) that the context menu is shown under.
	 * @param frameElem The HTML Element that the context menu should be rendered within (and be positioned relative to it's content).
	 * @param onClose An optional callback to be invoked when the context menu is closed.
	 * @param className An optional class name to add to the context menu.
	 */
	public show(actions: ContextMenuActions, checked: boolean, target: ContextMenuTarget | null, at: MouseEvent | HTMLElement, frameElem: HTMLElement, onClose: (() => void) | null = null, className: string | null = null) {
		let html = '', handlers: (() => void)[] = [], handlerId = 0;
		this.close();

		for (let i = 0; i < actions.length; i++) {
			let groupHtml = '', headingHtml = '';
			for (let j = 0; j < actions[i].length; j++) {
				const item = actions[i][j];
				if ('heading' in item) {
					headingHtml = '<li class="contextMenuHeading">' + escapeHtml(item.heading) + getContextMenuHintHtml(item.hint) + '</li>';
				} else if (item.visible) {
					groupHtml += '<li class="contextMenuItem" data-index="' + handlerId++ + '">' + (checked ? '<span class="contextMenuItemCheck">' + (item.checked ? SVG_ICONS.check : '') + '</span>' : '') + item.title + getContextMenuHintHtml(item.hint) + '</li>';
					handlers.push(item.onClick);
				}
			}

			if (groupHtml !== '') {
				if (html !== '') html += '<li class="contextMenuDivider"></li>';
				html += headingHtml + groupHtml;
			}
		}

		if (handlers.length === 0) return; // No context menu actions are visible

		const menu = document.createElement('ul');
		menu.className = 'contextMenu' + (checked ? ' checked' : '') + (className !== null ? ' ' + className : '');
		menu.style.opacity = '0';
		menu.innerHTML = html;
		frameElem.appendChild(menu);
		const menuBounds = menu.getBoundingClientRect(), frameBounds = frameElem.getBoundingClientRect();
		if (at instanceof HTMLElement) {
			// Under the element, lined up with its left edge, or with its right edge when the menu doesn't fit to the right. Above it when the menu doesn't fit below.
			const anchorBounds = at.getBoundingClientRect();
			const x = anchorBounds.left + menuBounds.width < frameBounds.right ? anchorBounds.left : anchorBounds.right - menuBounds.width;
			const y = anchorBounds.bottom + 2 + menuBounds.height < frameBounds.bottom ? anchorBounds.bottom + 2 : anchorBounds.top - 2 - menuBounds.height;
			menu.style.left = (frameElem.scrollLeft + Math.max(x - frameBounds.left, 2)) + 'px';
			menu.style.top = (frameElem.scrollTop + Math.max(y - frameBounds.top, 2)) + 'px';
		} else {
			const event = at;
			const relativeX = event.pageX + menuBounds.width < frameBounds.right
				? -2 // context menu fits to the right
				: event.pageX - menuBounds.width > frameBounds.left
					? 2 - menuBounds.width // context menu fits to the left
					: -2 - (menuBounds.width - (frameBounds.width - (event.pageX - frameBounds.left))); // Overlap the context menu horizontally with the cursor
			const relativeY = event.pageY + menuBounds.height < frameBounds.bottom
				? -2 // context menu fits below
				: event.pageY - menuBounds.height > frameBounds.top
					? 2 - menuBounds.height // context menu fits above
					: -2 - (menuBounds.height - (frameBounds.height - (event.pageY - frameBounds.top))); // Overlap the context menu vertically with the cursor
			menu.style.left = (frameElem.scrollLeft + Math.max(event.pageX - frameBounds.left + relativeX, 2)) + 'px';
			menu.style.top = (frameElem.scrollTop + Math.max(event.pageY - frameBounds.top + relativeY, 2)) + 'px';
		}
		menu.style.opacity = '1';
		this.elem = menu;
		this.onClose = onClose;

		addListenerToClass('contextMenuItem', 'click', (e) => {
			// The user clicked on a context menu item => call the corresponding handler
			e.stopPropagation();
			this.close();
			handlers[parseInt((<HTMLElement>(<Element>e.target).closest('.contextMenuItem')!).dataset.index!)]();
		});

		menu.addEventListener('click', (e) => {
			// The user clicked on the context menu (but not a specific item) => keep the context menu open to allow the user to reattempt clicking on a specific item
			e.stopPropagation();
		});

		this.target = target;
		if (this.target !== null && this.target.type !== TargetType.Repo) {
			alterClass(this.target.elem, CLASS_CONTEXT_MENU_ACTIVE, true);
		}
	}

	/**
	 * Close the context menu (if one is currently open in the Git Tree View).
	 */
	public close() {
		if (this.elem !== null) {
			this.elem.remove();
			this.elem = null;
		}
		alterClassOfCollection(<HTMLCollectionOf<HTMLElement>>document.getElementsByClassName(CLASS_CONTEXT_MENU_ACTIVE), CLASS_CONTEXT_MENU_ACTIVE, false);
		if (this.onClose !== null) {
			this.onClose();
			this.onClose = null;
		}
		this.target = null;
	}

	/**
	 * Refresh the context menu (if one is currently open in the Git Tree View). If the context menu has a dynamic source,
	 * re-link it to the newly rendered HTML Element, or close it if the target is no longer visible in the Git Tree View.
	 * @param commits The new array of commits that is rendered in the Git Tree View.
	 */
	public refresh(commits: ReadonlyArray<GG.GitCommit>) {
		if (!this.isOpen() || this.target === null || this.target.type === TargetType.Repo) {
			// Don't need to refresh if no context menu is open, or it is not dynamic
			return;
		}

		if (this.target.index < commits.length && commits[this.target.index].hash === this.target.hash) {
			// The commit still exists at the same index

			const commitElem = findCommitElemWithId(getCommitElems(), this.target.index);
			if (commitElem !== null) {
				if (typeof this.target.ref === 'undefined') {
					// ContextMenu is only dependent on the commit itself
					if (this.target.type !== TargetType.CommitDetailsView) {
						this.target.elem = commitElem;
						alterClass(this.target.elem, CLASS_CONTEXT_MENU_ACTIVE, true);
					}
					return;
				} else {
					// ContextMenu is dependent on the commit and ref
					const elems = <NodeListOf<HTMLElement>>commitElem.querySelectorAll('[data-fullref]');
					for (let i = 0; i < elems.length; i++) {
						if (elems[i].dataset.fullref! === this.target.ref) {
							this.target.elem = this.target.type === TargetType.Ref ? elems[i] : commitElem;
							alterClass(this.target.elem, CLASS_CONTEXT_MENU_ACTIVE, true);
							return;
						}
					}
				}
			}
		}

		this.close();
	}

	/**
	 * Get the commit the open context menu is for, whose row must stay rendered while it is open.
	 * @returns The commit's hash, or NULL if no context menu is open, or it isn't for a commit.
	 */
	public getTargetHash() {
		return this.target !== null && this.target.type !== TargetType.Repo ? this.target.hash : null;
	}

	/**
	 * Is a context menu currently open in the Git Tree View.
	 * @returns TRUE => A context menu is open, FALSE => No context menu is open
	 */
	public isOpen() {
		return this.elem !== null;
	}

	/**
	 * Is the target of the context menu dynamic (i.e. is it tied to a Git object & HTML Element in the Git Tree View).
	 * @returns TRUE => The context menu is dynamic, FALSE => The context menu is not dynamic
	 */
	public isTargetDynamicSource() {
		return this.isOpen() && this.target !== null;
	}
}

/**
 * Get the HTML of the dim hint after a context menu item's title or a heading.
 * @param hint The hint, or undefined for none.
 * @returns The HTML.
 */
function getContextMenuHintHtml(hint: string | undefined) {
	return typeof hint === 'string' && hint !== '' ? '<span class="contextMenuHint" title="' + escapeHtml(hint) + '">' + escapeHtml(hint) + '</span>' : '';
}
