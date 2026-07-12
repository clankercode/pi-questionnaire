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

/** Interpret common literal escape-sequence forms of ESC (0x1b) as
 * actual ESC bytes. Used by the in-terminal preview renderer so content
 * authored in either form renders correctly.
 *
 * Recognized forms (all must be followed by a non-alphanumeric char or
 * end-of-string, except \x and \u which are strictly \x1b / \u001b):
 *   - `\x1b`, `\x1B`        — C/Python hex escape
 *   - `\u001b`, `\u001B`    — JS/JSON unicode escape (some tools emit
 *                             the literal six-char text by mistake)
 *   - `\e`                  — bash/printf `$'\e'`, not followed by an
 *                             identifier char so we don't mangle words
 *                             like `\edit` or `\else`
 *
 * Always decodes (never leaves literal escape text alone, even when the
 * string also contains real ESC bytes elsewhere). The decode is
 * targeted at literal backslash sequences — real ESC bytes are not
 * regex-matched and cannot be "double-decoded". The same-string forms
 * (`\x1b[31m` literal vs `\x1b[31m` real bytes) become identical after
 * decode, so mixing them is intentional and supports.
 *
 * Other backslash escapes (e.g. literal `\n`) are intentionally NOT
 * decoded — preview content is treated as already-decoded text by the
 * pipeline (JSON has the JS string semantics), so we only touch the
 * specific forms that represent ESC.
 */
export function interpretAnsiEscapes(s: string): string {
	return s.replace(/\\x1[bB]|\\u001[bB]|\\e(?![A-Za-z0-9_])/g, "\x1b");
}
