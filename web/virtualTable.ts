const CLASS_VIRTUAL_SPACER = 'virtualSpacer';
const VIRTUAL_TABLE_MIN_MARGIN = 24; // The fewest rows rendered above and below the rows in view

/**
 * What a VirtualTable needs from the view that owns it.
 */
interface VirtualTableSource {
	/**
	 * Get the HTML of consecutive rows: one `tr.commit` element for each row, with its index in `data-id`.
	 * @param start The index of the first row.
	 * @param end The index after the last row.
	 */
	readonly getRowsHtml: (start: number, end: number) => string;

	/**
	 * Get the rows that must stay in the DOM wherever they are, such as the row of the open Commit Details View, or the row a context menu or dialog is for.
	 */
	readonly getPinnedRows: () => number[];

	/**
	 * A row has been rendered: apply any state that isn't in its HTML, such as find highlights.
	 * @param elem The row's element.
	 * @param index The row's index.
	 */
	readonly onRowRendered: (elem: HTMLElement, index: number) => void;

	/**
	 * The rendered rows changed because the view scrolled, or a row was rendered on request: draw what depends on them, such as the graph.
	 */
	readonly onWindowChanged: () => void;
}

/**
 * Renders the rows of the commit table virtually: only the rows in view, plus a margin, exist in the DOM. A spacer row stands in for each run
 * of rows that isn't rendered, so the table keeps its full height and every row keeps its position. Every row has the same height, except
 * for the expanded row and the expansion below it (the inline Commit Details View), which belongs to the view and stays in the DOM after its
 * row. The expanded row shows all of its labels, so it can be taller than the others: the table measures by how much, and counts it as part
 * of the expansion.
 */
class VirtualTable {
	private readonly viewElem: HTMLElement;
	private readonly source: VirtualTableSource;

	private bodyElem: HTMLElement | null = null;
	private rows: Map<number, HTMLElement> = new Map();
	private spacers: HTMLElement[] = [];
	private numRows: number = 0;
	private numColumns: number = 1;

	private rowHeight: number;
	private headerHeight: number = 0;
	private expandedIndex: number = -1;
	private expandedHeight: number = 0;
	private expandedRowExtra: number = 0; // How much taller the expanded row is than the others

	private start: number = 0;
	private end: number = 0;
	private requestedRows: number[] = []; // Rows rendered on request (by getRow), which stay rendered until the view next scrolls

	/**
	 * Construct a new VirtualTable instance.
	 * @param viewElem The element that scrolls the table.
	 * @param rowHeight The expected height of a row, until one has been rendered and measured.
	 * @param source The view that owns the table.
	 */
	constructor(viewElem: HTMLElement, rowHeight: number, source: VirtualTableSource) {
		this.viewElem = viewElem;
		this.rowHeight = rowHeight;
		this.source = source;
	}

	/**
	 * Use a newly rendered table, which has only its column headers so far. Call update to render its rows.
	 * @param bodyElem The table's body, whose first child is the row of column headers.
	 * @param numRows The number of rows in the table.
	 * @param numColumns The number of columns in the table.
	 */
	public attach(bodyElem: HTMLElement, numRows: number, numColumns: number) {
		this.bodyElem = bodyElem;
		this.rows = new Map();
		this.spacers = [];
		this.numRows = numRows;
		this.numColumns = numColumns;
		this.headerHeight = (<HTMLElement>bodyElem.firstElementChild).offsetHeight;
		this.expandedIndex = -1;
		this.expandedHeight = 0;
		this.expandedRowExtra = 0;
		this.start = 0;
		this.end = 0;
		this.requestedRows = [];
	}

	/**
	 * Set the expanded row and the expansion below it, which move every later row down by their extra height. measure() measures the row.
	 * @param index The index of the expanded row, or -1 if no row is expanded.
	 * @param height The height of the expansion below the row (0 if there isn't one).
	 */
	public setExpansion(index: number, height: number) {
		if (index !== this.expandedIndex) this.expandedRowExtra = 0;
		this.expandedIndex = index;
		this.expandedHeight = index > -1 ? height : 0;
	}


	/* Rendering */

	/**
	 * Choose the rendered rows again, around the rows in view, and render every row that is missing. The caller then draws what depends on the
	 * rendered rows, such as the graph.
	 */
	public render() {
		this.update(true, -1);
	}

	/**
	 * The view scrolled: render the rows in view, plus a margin. While the rows in view stay well inside the rendered rows, nothing changes.
	 */
	public scrolled() {
		this.requestedRows = [];
		this.update(false, -1);
	}

	/**
	 * Update the rendered rows.
	 * @param force Choose the rendered rows again, around the rows in view, and render every row that is missing. Otherwise the source is told when they change.
	 * @param extraRow Also render this row (if > -1), wherever it is.
	 */
	private update(force: boolean, extraRow: number) {
		if (this.bodyElem === null || !this.bodyElem.isConnected) return;

		let start = 0, end = 0;
		if (this.numRows > 0) {
			const top = this.viewElem.getBoundingClientRect().top - this.bodyElem.getBoundingClientRect().top, viewHeight = this.viewElem.clientHeight;
			const first = this.clampRow(this.getRowAt(top)), last = this.clampRow(this.getRowAt(top + viewHeight));
			const margin = Math.max(VIRTUAL_TABLE_MIN_MARGIN, Math.ceil(viewHeight / this.rowHeight)), halfMargin = Math.floor(margin / 2);
			if (!force && this.start < this.end && this.start <= Math.max(first - halfMargin, 0) && this.end >= Math.min(last + 1 + halfMargin, this.numRows)) {
				// The rows in view are well inside the rendered rows
				start = this.start;
				end = this.end;
			} else {
				start = Math.max(first - margin, 0);
				end = Math.min(last + 1 + margin, this.numRows);
			}
		}

		const changed = start !== this.start || end !== this.end;
		if (extraRow > -1) this.requestedRows.push(extraRow);
		const pinned = this.source.getPinnedRows().concat(this.requestedRows);
		const outside = pinned.filter((index, i) => index > -1 && index < this.numRows && (index < start || index >= end) && pinned.indexOf(index) === i);
		if (changed || force || outside.some((index) => !this.rows.has(index))) {
			this.start = start;
			this.end = end;
			this.renderRows(outside);
			if (changed && !force) this.source.onWindowChanged();
		}
	}

	/**
	 * Measure the height of a row, where the first row starts, and how much taller the expanded row is, from the rendered table. If any of them
	 * differs from what the table assumed, render it again, and the caller then draws what depends on the rendered rows.
	 * @returns TRUE => The table was rendered again, FALSE => Nothing changed.
	 */
	public measure() {
		let changed = false;
		for (let attempt = 0; attempt < 2 && this.bodyElem !== null && this.bodyElem.isConnected; attempt++) {
			const firstItem = <HTMLElement | null>this.bodyElem.firstElementChild!.nextElementSibling;
			if (firstItem === null) break;

			// The first row or spacer also holds half of the column headers' border, and the expanded row can be taller, so a row's height is measured from another row
			let rowHeight = this.rowHeight;
			for (const [index, elem] of this.rows) {
				if (elem !== firstItem && index !== this.expandedIndex) {
					rowHeight = elem.getBoundingClientRect().height;
					break;
				}
			}
			const expandedElem = this.rows.get(this.expandedIndex);
			const expandedRowExtra = typeof expandedElem !== 'undefined' ? Math.max(expandedElem.getBoundingClientRect().height - rowHeight, 0) : 0;

			// Where the rows would start if the first one were like the others: the bottom of the first row or spacer, less the rows it holds
			const numRowsInFirstItem = firstItem.classList.contains(CLASS_VIRTUAL_SPACER) ? parseInt(firstItem.dataset.rows!) : 1;
			const headerHeight = firstItem.getBoundingClientRect().bottom - this.bodyElem.getBoundingClientRect().top - numRowsInFirstItem * rowHeight - (firstItem === expandedElem ? expandedRowExtra : 0);

			if (rowHeight <= 0 || (rowHeight === this.rowHeight && headerHeight === this.headerHeight && expandedRowExtra === this.expandedRowExtra)) break;
			this.rowHeight = rowHeight;
			this.headerHeight = headerHeight;
			this.expandedRowExtra = expandedRowExtra;
			this.update(true, -1);
			changed = true;
		}
		return changed;
	}

	/**
	 * Render the rows from start to end, and the pinned rows. Rows that are already rendered stay as they are, and so does any element after a row
	 * that isn't a row (the expansion). Only the rows that are no longer needed, and the spacers, are removed.
	 * @param pinned The pinned rows outside start to end, without duplicates.
	 */
	private renderRows(pinned: number[]) {
		const bodyElem = this.bodyElem!, start = this.start, end = this.end;
		pinned.sort((a, b) => a - b);

		this.rows.forEach((elem, index) => {
			if ((index < start || index >= end) && !pinned.includes(index)) {
				elem.remove();
				this.rows.delete(index);
			}
		});
		this.spacers.forEach((spacer) => spacer.remove());
		this.spacers = [];

		const indexes: number[] = [];
		pinned.forEach((index) => { if (index < start) indexes.push(index); });
		for (let index = start; index < end; index++) indexes.push(index);
		pinned.forEach((index) => { if (index >= end) indexes.push(index); });

		// The rendered rows are in order, so walk them, inserting the missing rows and a spacer for each gap
		let ref = VirtualTable.getNextRow(bodyElem.firstElementChild!.nextSibling), prev = -1, i = 0;
		while (i < indexes.length) {
			const index = indexes[i], existing = this.rows.get(index);
			if (index > prev + 1) this.insertSpacer(index - prev - 1, ref);
			if (typeof existing !== 'undefined') {
				ref = VirtualTable.getNextRow(existing.nextSibling);
				prev = index;
				i++;
			} else {
				let j = i + 1;
				while (j < indexes.length && indexes[j] === indexes[j - 1] + 1 && !this.rows.has(indexes[j])) j++;
				this.insertRows(index, indexes[j - 1] + 1, ref);
				prev = indexes[j - 1];
				i = j;
			}
		}
		if (prev < this.numRows - 1) this.insertSpacer(this.numRows - 1 - prev, ref);
	}

	/**
	 * Insert consecutive rows into the table.
	 * @param start The index of the first row.
	 * @param end The index after the last row.
	 * @param ref The node to insert the rows before, or NULL to insert them at the end.
	 */
	private insertRows(start: number, end: number, ref: Node | null) {
		const template = document.createElement('template');
		template.innerHTML = this.source.getRowsHtml(start, end);
		const elems = <HTMLCollectionOf<HTMLElement>>template.content.children, rendered: HTMLElement[] = [];
		for (let i = 0; i < elems.length; i++) rendered.push(elems[i]);
		this.bodyElem!.insertBefore(template.content, ref);
		for (let i = 0; i < rendered.length; i++) {
			this.rows.set(start + i, rendered[i]);
			this.source.onRowRendered(rendered[i], start + i);
		}
	}

	/**
	 * Insert a spacer row, which stands in for rows that aren't rendered.
	 * @param numRows The number of rows it stands in for.
	 * @param ref The node to insert the spacer before, or NULL to insert it at the end.
	 */
	private insertSpacer(numRows: number, ref: Node | null) {
		const spacer = document.createElement('tr');
		spacer.className = CLASS_VIRTUAL_SPACER;
		spacer.dataset.rows = numRows.toString();
		spacer.style.height = (numRows * this.rowHeight) + 'px';
		spacer.innerHTML = '<td colspan="' + this.numColumns + '"></td>';
		this.bodyElem!.insertBefore(spacer, ref);
		this.spacers.push(spacer);
	}

	/**
	 * Get the first row at or after a node, skipping elements that aren't rows (the expansion).
	 * @param node The node.
	 * @returns The row, or NULL if there isn't one.
	 */
	private static getNextRow(node: Node | null) {
		while (node !== null && !(node instanceof HTMLElement && node.classList.contains('commit'))) node = node.nextSibling;
		return node;
	}


	/* Get */

	/**
	 * Get the rendered rows: from the first to the last row of the window, which are rendered around the rows in view.
	 * @returns The index of the first row, and the index after the last row.
	 */
	public getWindow() {
		return this.bodyElem !== null && this.bodyElem.isConnected ? { start: this.start, end: this.end } : { start: 0, end: 0 };
	}

	/**
	 * Get the element of a row.
	 * @param index The index of the row.
	 * @param render If the row isn't rendered, render it (wherever it is). It stays rendered until the view next scrolls, unless it is pinned.
	 * @returns The element, or NULL if the row isn't rendered.
	 */
	public getRow(index: number, render: boolean) {
		let elem = this.rows.get(index);
		if (typeof elem === 'undefined' && render && index > -1 && index < this.numRows) {
			this.update(false, index);
			elem = this.rows.get(index);
		}
		return typeof elem !== 'undefined' ? elem : null;
	}

	/**
	 * Call a function for each rendered row.
	 * @param callback The function, given the row's element and index.
	 */
	public forEachRow(callback: (elem: HTMLElement, index: number) => void) {
		this.rows.forEach(callback);
	}

	/**
	 * Get the height of a row.
	 */
	public getRowHeight() {
		return this.rowHeight;
	}

	/**
	 * Get where the first row starts (if it were like the others), relative to the top of the table: the height of the column headers.
	 */
	public getHeaderHeight() {
		return this.headerHeight;
	}

	/**
	 * Get how far the expanded row moves the later rows down: how much taller it is than the others, plus the expansion below it. The graph
	 * stretches its lines by this much below the expanded row's commit.
	 * @returns The height, or 0 if no row is expanded.
	 */
	public getExpansionHeight() {
		return this.expandedIndex > -1 ? this.expandedRowExtra + this.expandedHeight : 0;
	}

	/**
	 * Get the top of a row, relative to the top of the table.
	 * @param index The index of the row.
	 */
	public getRowTop(index: number) {
		return this.headerHeight + index * this.rowHeight + (this.expandedIndex > -1 && index > this.expandedIndex ? this.getExpansionHeight() : 0);
	}

	/**
	 * Get the row at a position. The expansion, and the expanded row's extra height, belong to the expanded row.
	 * @param y The position, relative to the top of the table.
	 * @returns The index of the row, which may be outside the table.
	 */
	private getRowAt(y: number) {
		let offset = y - this.headerHeight;
		if (this.expandedIndex > -1) {
			const expansionTop = (this.expandedIndex + 1) * this.rowHeight, expansionHeight = this.getExpansionHeight();
			if (offset >= expansionTop + expansionHeight) {
				offset -= expansionHeight;
			} else if (offset >= expansionTop) {
				return this.expandedIndex;
			}
		}
		return Math.floor(offset / this.rowHeight);
	}

	private clampRow(index: number) {
		return Math.min(Math.max(index, 0), this.numRows - 1);
	}
}


/**
 * Estimates the width of text in a font by adding up the widths of its characters, which is fast enough to compare the text of every commit.
 * Kerning isn't counted, so an estimate only picks the likely widest texts: the DOM then measures them exactly.
 */
class TextWidthEstimator {
	private readonly context: CanvasRenderingContext2D | null;
	private readonly widths: Map<string, number> = new Map();

	/**
	 * Construct a new TextWidthEstimator instance.
	 * @param font The font, as in the CSS font property.
	 */
	constructor(font: string) {
		this.context = document.createElement('canvas').getContext('2d');
		if (this.context !== null) this.context.font = font;
	}

	/**
	 * Estimate the width of a text.
	 * @param text The text.
	 * @returns The estimated width, in pixels.
	 */
	public estimate(text: string) {
		if (this.context === null) return text.length;
		let width = 0;
		for (let i = 0; i < text.length; i++) {
			let charWidth = this.widths.get(text[i]);
			if (typeof charWidth === 'undefined') {
				charWidth = this.context.measureText(text[i]).width;
				this.widths.set(text[i], charWidth);
			}
			width += charWidth;
		}
		return width;
	}
}
