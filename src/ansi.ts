/**
 * ANSI escape sequence helpers.
 *
 * Centralized so terminal-specific quirks (BEL vs ST terminators,
 * fallback for non-supporting terminals, SGR composition) live in
 * one place. If we ever swap in a library like `ansi-escapes` or
 * `chalk`, the change happens here.
 */

/** Start an OSC 8 clickable hyperlink. */
const OSC8_START = (url: string, term: "bel" | "st" = "bel"): string =>
	`\x1b]8;;${url}${term === "bel" ? "\x07" : "\x1b\\"}`;

/** End an OSC 8 clickable hyperlink. */
const OSC8_END = (term: "bel" | "st" = "bel"): string =>
	`\x1b]8;;${term === "bel" ? "\x07" : "\x1b\\"}`;

/**
 * Wrap `text` in an OSC 8 hyperlink targeting `url`. In terminals
 * that support OSC 8 (iTerm2, kitty, alacritty, gnome-terminal,
 * Windows Terminal, WezTerm), the text becomes clickable. In
 * terminals that don't, the text just shows inline (harmless).
 *
 * Uses BEL terminators by default for broader compatibility. Pass
 * "st" if you need the ST (ESC \) terminator instead.
 */
export function hyperlink(url: string, text: string, term: "bel" | "st" = "bel"): string {
	return `${OSC8_START(url, term)}${text}${OSC8_END(term)}`;
}

/** Set the terminal window title via OSC 0. */
export function setTitle(title: string): string {
	return `\x1b]0;${title}\x07`;
}

/** Audible terminal bell (BEL). */
export const BEL = "\x07";
