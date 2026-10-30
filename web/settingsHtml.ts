/* Settings HTML
 * The parts every card of the settings panels, and of the Manage panel, is built from: the card, its rows, buttons, switches, notices, bars
 * and sizes. Each function takes HTML, so the caller escapes every value it puts in (with escapeHtml). */

/**
 * Get the HTML of a card's header and body.
 * @param title The card's title (HTML).
 * @param description The one line under the title (HTML).
 * @param actions The buttons in the header (HTML).
 * @param body The body (HTML). An empty body leaves the card with only its header.
 * @returns The HTML.
 */
function settingsCardContentHtml(title: string, description: string, actions: string, body: string) {
	return '<header class="settingsCardHeader"><div class="settingsCardTitles"><h3>' + title + '</h3><p class="settingsCardDescription">' + description + '</p></div>' +
		(actions !== '' ? '<div class="settingsCardActions">' + actions + '</div>' : '') + '</header>' +
		(body !== '' ? '<div class="settingsCardBody">' + body + '</div>' : '');
}

/**
 * Get the HTML of a card.
 * @param id The card's id.
 * @param title The card's title (HTML).
 * @param description The one line under the title (HTML).
 * @param actions The buttons in the header (HTML).
 * @param body The body (HTML).
 * @returns The HTML.
 */
function settingsCardHtml(id: string, title: string, description: string, actions: string, body: string) {
	return '<section class="settingsCard" id="' + id + '">' + settingsCardContentHtml(title, description, actions, body) + '</section>';
}

/**
 * Get the HTML of a row with a label, a value and icon buttons.
 * @param label The label (HTML).
 * @param value The value (HTML).
 * @param title The value's tooltip (HTML, an attribute value).
 * @param actions The icon buttons (HTML).
 * @returns The HTML.
 */
function settingsRowHtml(label: string, value: string, title: string, actions: string) {
	return '<div class="settingsRow"><span class="settingsRowLabel">' + label + '</span><span class="settingsRowValue" title="' + title + '">' + value + '</span>' +
		(actions !== '' ? '<span class="settingsRowActions">' + actions + '</span>' : '') + '</div>';
}

/**
 * Get the HTML of an icon button.
 * @param attributes Its other attributes, such as its id, class or data (HTML).
 * @param title What it does, as its tooltip and accessible name (HTML, an attribute value).
 * @param icon The SVG icon.
 * @param disabled Is it disabled.
 * @param className Another class it has, or '' for none.
 * @returns The HTML.
 */
function settingsIconButtonHtml(attributes: string, title: string, icon: string, disabled: boolean = false, className: string = '') {
	return '<button type="button" class="settingsIconBtn' + (className !== '' ? ' ' + className : '') + '" ' + attributes + ' title="' + title + '" aria-label="' + title + '"' + (disabled ? ' disabled' : '') + '>' + icon + '</button>';
}

/**
 * Get the HTML of a text button.
 * @param attributes Its other attributes, such as its id or data (HTML).
 * @param label The label (HTML).
 * @param icon The SVG icon before the label, or NULL for none.
 * @param primary Is it the main action of its form.
 * @param disabled Is it disabled.
 * @returns The HTML.
 */
function settingsButtonHtml(attributes: string, label: string, icon: string | null, primary: boolean = false, disabled: boolean = false) {
	return '<button type="button" class="settingsBtn' + (primary ? ' primary' : '') + '" ' + attributes + (disabled ? ' disabled' : '') + '>' + (icon !== null ? icon : '') + '<span>' + label + '</span></button>';
}

/**
 * Get the HTML of a switch: a checkbox drawn as a toggle, with its label and an optional description.
 * @param id The checkbox's id.
 * @param label The label (HTML).
 * @param description The line under the label (HTML), or NULL for none.
 * @param checked Is it on.
 * @param disabled Is it disabled.
 * @returns The HTML.
 */
function settingsSwitchHtml(id: string, label: string, description: string | null, checked: boolean, disabled: boolean = false) {
	return '<label class="settingsSwitch' + (disabled ? ' disabled' : '') + '"><input type="checkbox" role="switch" id="' + id + '"' + (checked ? ' checked' : '') + (disabled ? ' disabled' : '') + '><span class="settingsSwitchTrack"></span>' +
		'<span class="settingsSwitchText"><span class="settingsSwitchLabel">' + label + '</span>' + (description !== null ? '<span class="settingsSwitchDescription">' + description + '</span>' : '') + '</span></label>';
}

/**
 * Get the HTML of a notice: a line that reports an error, a success, or progress.
 * @param kind The kind of notice.
 * @param html What it says (HTML).
 * @returns The HTML.
 */
function settingsNoticeHtml(kind: 'error' | 'success' | 'progress' | 'info', html: string) {
	const icon = kind === 'error' ? SVG_ICONS.failed : kind === 'success' ? SVG_ICONS.passed : kind === 'progress' ? SVG_ICONS.loading : SVG_ICONS.info;
	return '<div class="settingsNotice ' + kind + '"' + (kind === 'error' ? ' role="alert"' : ' role="status"') + '>' + icon + '<div class="settingsNoticeText">' + html + '</div></div>';
}

/**
 * Get the HTML of a small spinning icon, for a value that is loading.
 * @returns The HTML.
 */
function settingsSpinnerHtml() {
	return '<span class="settingsSpinner" title="Loading' + ELLIPSIS + '">' + SVG_ICONS.loading + '</span>';
}

/**
 * Get the HTML of a slim bar.
 * @param share How full it is, from 0 to 1.
 * @param title Its tooltip (HTML, an attribute value).
 * @returns The HTML.
 */
function settingsBarHtml(share: number, title: string) {
	const percent = Math.round(Math.min(Math.max(share, 0), 1) * 1000) / 10;
	return '<div class="settingsBar" role="img" aria-label="' + title + '" title="' + title + '"><div class="settingsBarFill" style="width:' + percent + '%"></div></div>';
}


/* Sizes */

const SIZE_UNITS = ['KB', 'MB', 'GB', 'TB'];

/**
 * Get the unit a size is shown in: the largest unit it has at least one of.
 * @param kilobytes The size, in kilobytes (1024 bytes).
 * @returns The unit's index in SIZE_UNITS.
 */
function getSizeUnit(kilobytes: number) {
	let unit = 0;
	while (kilobytes >= Math.pow(1024, unit + 1) && unit < SIZE_UNITS.length - 1) unit++;
	return unit;
}

/**
 * Format a size in kilobytes as KB, MB, GB or TB, with one decimal below 10.
 * @param kilobytes The size, in kilobytes (1024 bytes).
 * @returns The size.
 */
function formatKilobytes(kilobytes: number) {
	const unit = getSizeUnit(kilobytes), value = kilobytes / Math.pow(1024, unit);
	return (unit > 0 && value < 10 ? (Math.round(value * 10) / 10).toFixed(1) : String(Math.round(value))) + ' ' + SIZE_UNITS[unit];
}

/**
 * Format a part of a size, and the size, in the size's unit, with one decimal below 100: `12.3 / 31.2 GB`.
 * @param used The part, in kilobytes (1024 bytes).
 * @param total The size, in kilobytes.
 * @returns The part and the size.
 */
function formatKilobytesOfTotal(used: number, total: number) {
	const unit = getSizeUnit(total), scale = Math.pow(1024, unit);
	const format = (kilobytes: number) => {
		const value = kilobytes / scale;
		return unit > 0 && value < 100 ? String(Math.round(value * 10) / 10) : String(Math.round(value));
	};
	return format(used) + ' / ' + format(total) + ' ' + SIZE_UNITS[unit];
}


/* Keyboard Focus */

/** Where the keyboard focus was inside an element, so it can be put back after the element's HTML is replaced. */
interface SettingsFocus {
	readonly id: string | null;
	readonly key: string | null; // The data-focus attribute of an element without an id
	readonly selectionStart: number | null;
	readonly selectionEnd: number | null;
}

/**
 * Remember where the keyboard focus is inside an element.
 * @param container The element.
 * @returns Where the focus is, or NULL if it isn't inside the element.
 */
function captureSettingsFocus(container: HTMLElement): SettingsFocus | null {
	const active = document.activeElement;
	if (!(active instanceof HTMLElement) || !container.contains(active)) return null;
	const isText = active instanceof HTMLInputElement && active.type === 'text';
	return {
		id: active.id !== '' ? active.id : null,
		key: active.getAttribute('data-focus'),
		selectionStart: isText ? (<HTMLInputElement>active).selectionStart : null,
		selectionEnd: isText ? (<HTMLInputElement>active).selectionEnd : null
	};
}

/**
 * Put the keyboard focus back where it was, after the element's HTML was replaced.
 * @param container The element.
 * @param focus Where the focus was.
 * @returns TRUE => the focus is back, FALSE => the element it was on is gone.
 */
function restoreSettingsFocus(container: HTMLElement, focus: SettingsFocus | null) {
	if (focus === null) return false;
	let elem: HTMLElement | null = null;
	if (focus.id !== null) {
		elem = document.getElementById(focus.id);
	} else if (focus.key !== null) {
		const elems = container.querySelectorAll('[data-focus]');
		for (let i = 0; i < elems.length && elem === null; i++) {
			if (elems[i].getAttribute('data-focus') === focus.key) elem = <HTMLElement>elems[i];
		}
	}
	if (elem === null || !container.contains(elem) || (<HTMLButtonElement>elem).disabled) return false;
	elem.focus();
	if (focus.selectionStart !== null && elem instanceof HTMLInputElement) {
		elem.setSelectionRange(focus.selectionStart, focus.selectionEnd);
	}
	return true;
}
