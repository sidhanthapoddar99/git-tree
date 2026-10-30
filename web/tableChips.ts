const CLASS_CHIP_HIDDEN = 'chipHidden';
const CLASS_CHIP_MORE = 'chipMore';
const CLASS_CHIPS = 'cellChips';
const CLASS_CHIPS_FITTING = 'chipsFitting';
const CLASS_CHIPS_OVERFLOW = 'chipsOverflow';
const CLASS_HOST_CHIP = 'hostChip';
const CLASS_ROW_EXPANDED = 'rowExpanded';

const CSS_PROP_MESSAGE_MIN_WIDTH = '--messageMinWidth';
const CHIP_CARD_DELAY = 300; // How long a cell is hovered before its card is shown, in milliseconds
const CHIP_CARD_MARGIN = 4; // The card's least distance from the edges of the window
const CHIPS_SELECTOR = ':scope > span.description, :scope > .' + CLASS_CHIPS; // The element that holds a cell's chips, in the Description, Worktree or Host column

/**
 * The width a commit message keeps in the Description column, before any chip beside it: about 17 characters, enough to recognise a commit
 * by the first words of its subject, while a narrow column still has room for a chip or two.
 */
const MESSAGE_MIN_WIDTH = 120;

/** The kinds of chips, in the order the card lists them. */
const CHIP_KINDS: ReadonlyArray<{ readonly classNames: ReadonlyArray<string>, readonly title: string, readonly icon: keyof typeof SVG_ICONS | null }> = [
	{ classNames: [CLASS_REF_HEAD], title: 'Branches', icon: 'branch' },
	{ classNames: [CLASS_REF_REMOTE, CLASS_REF_HOST_BRANCH], title: 'Remote branches', icon: 'branch' },
	{ classNames: [CLASS_REF_TAG], title: 'Tags', icon: 'tag' },
	{ classNames: [CLASS_REF_STASH], title: 'Stashes', icon: 'stash' },
	{ classNames: [CLASS_REF_WORKTREE], title: 'Worktrees', icon: 'worktree' },
	{ classNames: [CLASS_HOST_CHIP], title: 'Hosts', icon: null }
];

/** A cell's chips, while they are fitted to its width. */
interface FittingChips {
	readonly container: HTMLElement;
	readonly chips: HTMLElement[];
	readonly others: HTMLElement[]; // What else takes up width beside the chips, such as the dot of the checked out commit
	readonly hasMessage: boolean;
	readonly more: HTMLElement | null;
}

/**
 * Fits the chips in the commit table's cells to their width: the labels of branches, remote branches, tags and stashes in the Description
 * column, and of worktrees and hosts in the Worktree and Host columns. A row shows the chips that fit whole, then a +N chip that counts the
 * others. The commit message keeps MESSAGE_MIN_WIDTH, so the chips collapse into +N before it does. The expanded row (the row of the open
 * Commit Details View) shows all of its chips, wrapped onto as many lines as they need.
 *
 * Hovering a cell that hides chips shows a card that lists all of them, grouped by kind.
 */
class TableChips {
	private readonly tableElem: HTMLElement;
	private readonly forEachRow: (callback: (elem: HTMLElement) => void) => void;
	private readonly resizeObserver: ResizeObserver;
	private readonly expandedRowObserver: ResizeObserver;
	private readonly queuedRows: Set<HTMLElement> = new Set();
	private frame: number | null = null;
	private expandedRow: HTMLElement | null = null;

	private hoveredCell: HTMLElement | null = null;
	private cardElem: HTMLElement | null = null;
	private cardTimeout: NodeJS.Timeout | null = null;

	/**
	 * Construct a new TableChips instance.
	 * @param tableElem The element that holds the commit table.
	 * @param viewElem The element that scrolls the table.
	 * @param forEachRow Call a function for each rendered row of the table.
	 * @param onExpandedRowResized The expanded row's size changed, such as when its chips wrap onto more lines after a column was resized.
	 */
	constructor(tableElem: HTMLElement, viewElem: HTMLElement, forEachRow: (callback: (elem: HTMLElement) => void) => void, onExpandedRowResized: () => void) {
		this.tableElem = tableElem;
		this.forEachRow = forEachRow;
		tableElem.style.setProperty(CSS_PROP_MESSAGE_MIN_WIDTH, MESSAGE_MIN_WIDTH + 'px');

		// A column's width changed: it was resized, the panel was resized, or the table was rendered again. The callback runs after layout and before paint, so no row is drawn unfitted
		this.resizeObserver = new ResizeObserver(() => this.fitAllRows());
		this.expandedRowObserver = new ResizeObserver(() => onExpandedRowResized());

		tableElem.addEventListener('mouseover', (e) => this.hoverCell(<Element>e.target));
		tableElem.addEventListener('mouseleave', () => {
			this.hoveredCell = null;
			this.closeCard();
		});
		viewElem.addEventListener('scroll', () => this.closeCard());
		document.addEventListener('mousedown', () => this.closeCard(), true);
	}

	/**
	 * Watch the widths of the columns of a newly rendered table, and fit the chips of every row each time one changes.
	 */
	public observeColumns() {
		this.resizeObserver.disconnect();
		this.tableElem.querySelectorAll<HTMLElement>('#tableColHeaders > th').forEach((elem) => this.resizeObserver.observe(elem));
		this.closeCard();
	}

	/**
	 * A row has been rendered: fit its chips before the next paint, together with the other rows rendered by then.
	 * @param elem The row's element.
	 */
	public queueRow(elem: HTMLElement) {
		this.queuedRows.add(elem);
		if (this.frame === null) {
			this.frame = requestAnimationFrame(() => {
				this.frame = null;
				const rows = Array.from(this.queuedRows);
				this.queuedRows.clear();
				this.fitRows(rows);
			});
		}
	}

	/**
	 * Set the expanded row, which shows all of its chips. The row that was expanded before is fitted again.
	 * @param elem The row's element, or NULL if no row is expanded.
	 */
	public setExpandedRow(elem: HTMLElement | null) {
		if (elem === this.expandedRow) return;
		if (this.expandedRow !== null) {
			this.expandedRow.classList.remove(CLASS_ROW_EXPANDED);
			this.queueRow(this.expandedRow);
		}
		this.expandedRowObserver.disconnect();
		if (elem !== null) {
			elem.classList.add(CLASS_ROW_EXPANDED);
			this.expandedRowObserver.observe(elem);
		}
		this.expandedRow = elem;
		this.closeCard();
	}


	/* Fitting */

	private fitAllRows() {
		const rows: HTMLElement[] = [];
		this.forEachRow((elem) => rows.push(elem));
		this.queuedRows.clear();
		this.fitRows(rows);
	}

	/**
	 * Fit the chips of rows to their cells. Every chip is shown so it can be measured, then all of them are measured, then the chips that don't
	 * fit are hidden: the browser lays out the table once, however many rows there are. The expanded row is skipped, as it shows every chip.
	 * @param rows The rows' elements.
	 */
	private fitRows(rows: ReadonlyArray<HTMLElement>) {
		const cells: FittingChips[] = [];
		rows.forEach((row) => {
			if (!row.isConnected || row.classList.contains(CLASS_ROW_EXPANDED)) return;
			for (let i = 0; i < row.children.length; i++) {
				const container = row.children[i].querySelector<HTMLElement>(CHIPS_SELECTOR);
				const cell = container !== null ? TableChips.showAllChips(container) : null;
				if (cell !== null) cells.push(cell);
			}
		});
		const numVisible = cells.map((cell) => TableChips.getNumChipsThatFit(cell));
		cells.forEach((cell, i) => TableChips.hideChips(cell, numVisible[i]));
	}

	/**
	 * Show all of a cell's chips, so they can be measured. A cell that might need a +N chip gets one that counts all of them, which is at least
	 * as wide as the one it will need.
	 * @param container The element that holds the chips.
	 * @returns The cell's chips, or NULL if it has none.
	 */
	private static showAllChips(container: HTMLElement): FittingChips | null {
		const chips: HTMLElement[] = [], others: HTMLElement[] = [];
		let more: HTMLElement | null = null, hasMessage = false;
		for (let i = 0; i < container.children.length; i++) {
			const child = <HTMLElement>container.children[i];
			if (child.classList.contains(CLASS_CHIP_MORE)) {
				more = child;
			} else if (child.classList.contains('gitRef') || child.classList.contains(CLASS_HOST_CHIP)) {
				chips.push(child);
			} else if (child.classList.contains('text')) {
				hasMessage = true;
			} else {
				others.push(child);
			}
		}

		if (chips.length > 1 || (chips.length === 1 && hasMessage)) {
			if (more === null) {
				more = document.createElement('span');
				more.className = CLASS_CHIP_MORE;
			}
			more.dataset.count = chips.length.toString();
			container.appendChild(more);
		} else if (more !== null) {
			more.remove();
			more = null;
		}
		if (chips.length === 0) {
			container.classList.remove(CLASS_CHIPS_OVERFLOW);
			return null;
		}

		chips.forEach((chip) => chip.classList.remove(CLASS_CHIP_HIDDEN));
		container.classList.add(CLASS_CHIPS_FITTING);
		return { container: container, chips: chips, others: others, hasMessage: hasMessage, more: more };
	}

	/**
	 * Get how many of a cell's chips fit whole, leaving the message its minimum width, and room for a +N chip that counts the others.
	 * @param cell The cell's chips, all shown (showAllChips).
	 * @returns The number of chips, from the first, that stay visible.
	 */
	private static getNumChipsThatFit(cell: FittingChips) {
		const width = cell.container.getBoundingClientRect().width;
		if (width === 0) return cell.chips.length; // The table isn't laid out, such as while the view is hidden

		const widths = cell.chips.map((chip) => TableChips.getOuterWidth(chip));
		const available = cell.others.reduce((available, elem) => available - TableChips.getOuterWidth(elem), width - (cell.hasMessage ? MESSAGE_MIN_WIDTH : 0));
		let used = widths.reduce((sum, chipWidth) => sum + chipWidth, 0);
		if (used <= available) return cell.chips.length;

		let numVisible = 0;
		used = cell.more !== null ? TableChips.getOuterWidth(cell.more) : 0;
		while (numVisible < widths.length && used + widths[numVisible] <= available) {
			used += widths[numVisible];
			numVisible++;
		}
		// A cell with only chips keeps its first one, shortened with an ellipsis (by CSS), so it never shows only +N
		return cell.hasMessage ? numVisible : Math.max(numVisible, 1);
	}

	/**
	 * Hide the chips of a cell that don't fit, and put the +N chip where the first of them was.
	 * @param cell The cell's chips, all shown (showAllChips).
	 * @param numVisible The number of chips, from the first, that stay visible.
	 */
	private static hideChips(cell: FittingChips, numVisible: number) {
		const numHidden = cell.chips.length - numVisible;
		cell.container.classList.remove(CLASS_CHIPS_FITTING);
		for (let i = numVisible; i < cell.chips.length; i++) {
			cell.chips[i].classList.add(CLASS_CHIP_HIDDEN);
		}
		if (cell.more !== null) {
			if (numHidden > 0) {
				cell.more.dataset.count = numHidden.toString();
				cell.container.insertBefore(cell.more, cell.chips[numVisible]);
			} else {
				cell.more.remove();
			}
		}
		alterClass(cell.container, CLASS_CHIPS_OVERFLOW, numHidden > 0);
	}

	/**
	 * Get the width an element takes up in a row, including its margins.
	 * @param elem The element.
	 * @returns The width, in pixels.
	 */
	private static getOuterWidth(elem: HTMLElement) {
		const style = getComputedStyle(elem);
		return elem.getBoundingClientRect().width + parseFloat(style.marginLeft) + parseFloat(style.marginRight);
	}


	/* Card */

	/**
	 * The mouse moved onto an element of the table. Moving onto a cell that hides chips shows its card after CHIP_CARD_DELAY. A card closed by a
	 * click or a scroll stays closed until the mouse moves onto another cell.
	 * @param target The element.
	 */
	private hoverCell(target: Element) {
		const cell = <HTMLElement | null>target.closest('td');
		if (cell === this.hoveredCell) return;
		this.hoveredCell = cell;
		this.closeCard();
		if (cell !== null && TableChips.getHiddenChipsContainer(cell) !== null) {
			this.cardTimeout = setTimeout(() => {
				this.cardTimeout = null;
				this.showCard(cell);
			}, CHIP_CARD_DELAY);
		}
	}

	/**
	 * Show the card of a cell: every chip in it, grouped by kind. It is below the cell, or above it if there isn't room, and inside the window.
	 * @param cell The cell.
	 */
	private showCard(cell: HTMLElement) {
		const container = TableChips.getHiddenChipsContainer(cell);
		if (container === null || !cell.isConnected) {
			this.closeCard();
			return;
		}

		const chips: Element[] = [];
		for (let i = 0; i < container.children.length; i++) chips.push(container.children[i]);
		let html = '';
		CHIP_KINDS.forEach((kind) => {
			const items = chips.filter((chip) => kind.classNames.some((className) => chip.classList.contains(className)));
			if (items.length === 0) return;
			html += '<div class="chipCardGroup"><div class="chipCardTitle">' + kind.title + '</div>';
			items.forEach((chip) => {
				const nameElem = chip.querySelector('.gitRefName'), remotes = chip.querySelectorAll('.gitRefHeadRemote');
				const name = (nameElem !== null ? nameElem : chip).textContent!;
				// A local branch's hint is its remotes with the same branch, otherwise the chip's own hint, such as a worktree's branch
				const hint = remotes.length > 0 ? Array.from(remotes).map((remote) => remote.textContent!).join(', ') : (<HTMLElement>chip).dataset.hint || '';
				html += '<div class="chipCardItem' + (chip.classList.contains(CLASS_ACTIVE) ? ' ' + CLASS_ACTIVE : '') + (chip.classList.contains(CLASS_STALE_HOST) ? ' ' + CLASS_STALE_HOST : '') + '">' +
					(kind.icon !== null ? SVG_ICONS[kind.icon] : '') +
					'<span class="chipCardName">' + escapeHtml(name) + '</span>' +
					(hint !== '' ? '<span class="chipCardHint">' + escapeHtml(hint) + '</span>' : '') +
					'</div>';
			});
			html += '</div>';
		});

		const cardElem = document.createElement('div');
		cardElem.id = 'chipCard';
		cardElem.innerHTML = html;
		document.body.appendChild(cardElem);
		this.cardElem = cardElem;

		// Below the cell if the card fits there, otherwise on the side with more room, cut short if it doesn't fit there either
		const cellRect = container.getBoundingClientRect(), cardRect = cardElem.getBoundingClientRect();
		const roomBelow = window.innerHeight - CHIP_CARD_MARGIN - cellRect.bottom, roomAbove = cellRect.top - CHIP_CARD_MARGIN;
		const isBelow = cardRect.height <= roomBelow || roomBelow >= roomAbove, room = Math.max(isBelow ? roomBelow : roomAbove, 0);
		if (cardRect.height > room) cardElem.style.maxHeight = room + 'px';
		cardElem.style.left = Math.max(Math.min(cellRect.left, window.innerWidth - CHIP_CARD_MARGIN - cardRect.width), CHIP_CARD_MARGIN) + 'px';
		cardElem.style.top = (isBelow ? cellRect.bottom : cellRect.top - Math.min(cardRect.height, room)) + 'px';
	}

	/**
	 * Close the card, or stop it from being shown.
	 */
	private closeCard() {
		if (this.cardTimeout !== null) {
			clearTimeout(this.cardTimeout);
			this.cardTimeout = null;
		}
		if (this.cardElem !== null) {
			this.cardElem.remove();
			this.cardElem = null;
		}
	}

	/**
	 * Get the element that holds a cell's chips, if some of them are hidden. The expanded row hides none.
	 * @param cell The cell.
	 * @returns The element, or NULL if the cell hides no chips.
	 */
	private static getHiddenChipsContainer(cell: HTMLElement) {
		const row = cell.parentElement, container = cell.querySelector(CHIPS_SELECTOR);
		return row !== null && row.classList.contains('commit') && !row.classList.contains(CLASS_ROW_EXPANDED) && container !== null && container.classList.contains(CLASS_CHIPS_OVERFLOW)
			? container
			: null;
	}
}
