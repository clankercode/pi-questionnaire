// src/tui.ts
// Rich TUI component for the AskUserQuestion tool. v2 supports 5 question types
// (select_one, select_many, confirm_enum, number, free_text) in a tabbed
// interface with per-type rendering, notes, persistent checkmarks, preview
// expansion, "Other" revisit prepopulation, help overlay, and browser-open
// shortcut. Per spec §4.

import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type {
	AnswerValue,
	CanonicalQuestion,
	ChoiceAnswer,
	ConfirmAnswer,
	Lifecycle,
	RenderOption,
} from "./types.ts";
import { coerceNumber, getRenderOptions } from "./answers.ts";
import { getSettings } from "./settings.ts";

// ---- Public types ---------------------------------------------------------

export interface TuiAnswer {
	id: string;
	index: number;
	type: CanonicalQuestion["type"];
	value: AnswerValue;
}

export interface TuiResult {
	answers: TuiAnswer[];
	notes?: Record<string, string>;
	lifecycle: Lifecycle;
}

export interface TuiOptions {
	questions: CanonicalQuestion[];
	/**
	 * Writer used for terminal control sequences (OSC 0 title, BEL).
	 * Defaults to `process.stdout.write`. Override in tests to capture.
	 */
	terminalWriter?: (s: string) => void;
}

// ---- Tabs -----------------------------------------------------------------

const SUBMIT_TAB = "__submit__";
type ViewMode = "answer" | "notes" | "help";

// ---- Render helpers -------------------------------------------------------

function addWrapped(lines: string[], text: string, width: number) {
	lines.push(...wrapTextWithAnsi(text, Math.max(1, width)));
}

function addWrappedWithPrefix(lines: string[], prefix: string, text: string, width: number) {
	const prefixWidth = visibleWidth(prefix);
	const w = Math.max(1, width);
	if (prefixWidth >= w) {
		addWrapped(lines, prefix + text, w);
		return;
	}
	const wrapped = wrapTextWithAnsi(text, w - prefixWidth);
	const cont = " ".repeat(prefixWidth);
	for (let i = 0; i < wrapped.length; i++) {
		lines.push(`${i === 0 ? prefix : cont}${wrapped[i]}`);
	}
}

function previewLine(type: string, theme: any): string {
	return theme.fg("muted", `[${type}]`);
}

function renderOptionLine(
	opt: RenderOption,
	idx: number,
	selected: boolean,
	checked: boolean | undefined,
	active: boolean,
	previewExpanded: boolean,
	width: number,
	theme: any,
	lines: string[],
) {
	const isOther = opt.isOther === true;
	const head = (() => {
		if (checked !== undefined) {
			const arrow = selected ? SELECTOR_ARROW : "   ";
			const box = checked ? theme.fg("success", "■") : theme.fg("muted", "□");
			return `${arrow}${box} ${idx + 1}. ${opt.label}${active ? " ✎" : ""}`;
		}
		const arrow = selected ? theme.fg("accent", "> ") : "  ";
		return `${arrow}${idx + 1}. ${opt.label}${active ? " ✎" : ""}`;
	})();
	addWrappedWithPrefix(lines, "", theme.fg(selected ? "accent" : "text", head), width);
	if (opt.description) {
		addWrappedWithPrefix(lines, "     ", theme.fg("muted", opt.description), width);
	}
	if (opt.preview) {
		if (previewExpanded) {
			lines.push(theme.fg("muted", `     ┌─ ${opt.preview.type} ─`));
			const w = Math.max(1, width);
			const indented = wrapTextWithAnsi(opt.preview.content, w - 9).map(
				(l) => "     │ " + l,
			);
			lines.push(...indented);
			lines.push(theme.fg("muted", "     └────"));
		} else {
			lines.push(
				theme.fg(
					"muted",
					`     ${previewLine(opt.preview.type, theme)} (press e to expand)`,
				),
			);
		}
	}
}

function isOtherSelectedFor(q: CanonicalQuestion, currentValue: AnswerValue | undefined): boolean {
	if (currentValue === undefined) return false;
	if (q.type === "select_one" || q.type === "confirm_enum") {
		return typeof currentValue === "object" && currentValue !== null && !Array.isArray(currentValue) && (currentValue as { mode?: string }).mode === "other";
	}
	if (q.type === "select_many") {
		// For multi-select, "Other is selected" means any element of the
		// array is an {mode:"other"} entry.
		if (!Array.isArray(currentValue)) return false;
		return currentValue.some(
			(e) => typeof e === "object" && e !== null && (e as { mode?: string }).mode === "other",
		);
	}
	return false;
}

function getOtherText(q: CanonicalQuestion, currentValue: AnswerValue | undefined): string {
	if (currentValue === undefined) return "";
	if (q.type === "select_one" || q.type === "confirm_enum") {
		const a = currentValue as { mode?: string; text?: string };
		return a.mode === "other" ? a.text ?? "" : "";
	}
	if (q.type === "select_many") {
		if (!Array.isArray(currentValue)) return "";
		const otherEntry = currentValue.find(
			(e) => typeof e === "object" && e !== null && (e as { mode?: string }).mode === "other",
		) as { mode?: string; text?: string } | undefined;
		return otherEntry?.text ?? "";
	}
	return "";
}

function getOptionByIdx(q: CanonicalQuestion, idx: number): RenderOption | undefined {
	const opts = getRenderOptions(q);
	return opts[idx];
}

const KEYMAP_HELP = [
	"",
	"  Keyboard shortcuts:",
	"  ↑/↓         Navigate options (or nudge value on number)",
	"  Enter       Select / commit / submit",
	"  Space       Toggle (select_many)",
	"  Tab / n     Swap to notes editor (or back)",
	"  1-9         Select option index (choice questions)",
	"  Meta+1-4    Jump to question N (multi-question)",
	"  [ / ]       Previous / next question tab",
	"  0           Jump to Submit tab",
	"  e           Toggle preview expansion (current option)",
	"  o           Open browser URL (in browser view)",
	"  ?           Show this help",
	"  Esc         Cancel (or back from notes)",
	"",
	"  Press any key to dismiss this help.",
];

function frameInnerWidth(width: number): number {
	return width < 12 ? width : width - 2;
}

/** The cursor selector drawn next to the highlighted option (and the
 *  [Select] button on multi-select). Single source of truth so we only
 *  have to change it once. Some terminals fall back to a plain `>` when
 *  the emoji doesn't render in the option list — that's a known TUI
 *  library rendering quirk, not a bug here. */
export const SELECTOR_ARROW = "👉 ";

// ---- Terminal title (OSC 0) --------------------------------------------

/** Set the terminal title via OSC 0. Default writer is process.stdout. */
export function setTerminalTitle(
	title: string,
	write: (s: string) => void = (s) => process.stdout.write(s),
): void {
	// OSC 0 ; title ST  (where ST is \x1b\\ or BEL).
	// We use BEL (\x07) which is the simpler, broadly-supported terminator.
	write(`\x1b]0;${title}\x07`);
}

/** Clear the terminal title. */
export function clearTerminalTitle(
	write: (s: string) => void = (s) => process.stdout.write(s),
): void {
	setTerminalTitle("", write);
}

// ---- Terminal bell (BEL) -------------------------------------------------

const BEL = "\x07";

/**
 * Play an audible terminal bell (BEL, \x07). Gated by the
 * `bellOnQuestion` setting so users running in shared/quiet environments
 * can disable it without losing the title hint.
 *
 * Returns `true` if a BEL was written, `false` if the setting disabled it
 * (or if no writer is available). The bell fires once per questionnaire
 * mount — submit/cancel/dispose do not re-trigger it.
 */
export function playBell(
	write: (s: string) => void = (s) => process.stdout.write(s),
): boolean {
	if (getSettings().bellOnQuestion !== true) return false;
	write(BEL);
	return true;
}

// ---- Component factory ----------------------------------------------------

/** Format a duration in ms as a human-readable string (e.g. "1m 23s"). */
function formatElapsed(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const m = Math.floor(totalSeconds / 60);
	const s = totalSeconds % 60;
	if (m < 60) return `${m}m ${s.toString().padStart(2, "0")}s`;
	const h = Math.floor(m / 60);
	const rm = m % 60;
	return `${h}h ${rm.toString().padStart(2, "0")}m`;
}

export function buildQuestionnaireComponent(opts: TuiOptions) {
	const questions = opts.questions;
	if (questions.length === 0) {
		throw new Error("AskUserQuestion requires at least one question");
	}
	const isMulti = questions.length > 1;
	const totalTabs = questions.length + 1; // + Submit tab

	return (tui: any, theme: any, _kb: any, done: (v: TuiResult) => void) => {
		// Writer for terminal control sequences (title, BEL). Defaults to
		// process.stdout.write; tests inject a capturing writer via
		// TuiOptions.terminalWriter.
		const terminalWriter: (s: string) => void = opts.terminalWriter ?? ((s) => process.stdout.write(s));

		// Prefix the terminal title with a bell so the user notices the
		// questionnaire is waiting. Restored (cleared) on done.
		const firstHeader = questions[0]?.header ?? "Question";
		setTerminalTitle(`🔔 AskUserQuestion — ${firstHeader}`, terminalWriter);
		// Audible terminal bell (gated by bellOnQuestion setting, default on).
		// Independent of the title signal — title is visual, BEL is audio.
		playBell(terminalWriter);
		let currentTab = 0;
		let optionIndex = 0;
		const checked: Record<string, Set<number>> = {};
		const expandedPreview: Record<string, number | null> = {}; // q.id -> option index
		const notes: Record<string, string> = {};
		const answers = new Map<string, TuiAnswer>();
		let viewMode: ViewMode = "answer";
		let inputMode: "text" | "number" | "other" | "free_text" | "notes" | "danger" | null = null;
		let inputQuestionId: string | null = null;
		let browserUrl: string | null = null;
		let lastBrowserOpenAttempt: { url: string; at: number } | null = null;

		const editorTheme: EditorTheme = {
			borderColor: (s: string) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t: string) => theme.fg("accent", t),
				selectedText: (t: string) => theme.fg("accent", t),
				description: (t: string) => theme.fg("muted", t),
				scrollInfo: (t: string) => theme.fg("dim", t),
				noMatch: (t: string) => theme.fg("warning", t),
			},
		};
		const editor = new Editor(tui, editorTheme);

		// Duration timer: track when the questionnaire was asked, refresh
		// the render once per second so the "elapsed" line updates.
		// unref() so the interval doesn't keep Node alive (esp. in tests).
		const askedAt = Date.now();
		let durationTimer: ReturnType<typeof setInterval> | null = null;
		if (typeof setInterval === "function") {
			durationTimer = setInterval(() => {
				tui.requestRender();
			}, 1000);
			// Node: don't keep the process alive. (No-op in non-Node runtimes.)
			const t = durationTimer as unknown as { unref?: () => void };
			if (typeof t.unref === "function") t.unref();
		}

		function refresh() {
			tui.requestRender();
		}

		// is_dangerous questions require the user to type a confirmation
		// string before the answer is accepted — modeled on GitHub's
		// "type the repo name to confirm deletion" pattern. Gate the
		// behavior behind the user-controlled setting so it can be turned
		// off in trusted environments. Reads the setting dynamically
		// (not cached at component creation) so tests can flip it via
		// setInMemorySettings without remounting.
		function isDangerActive(q: CanonicalQuestion): boolean {
			if (q.is_dangerous !== true) return false;
			return getSettings().dangerCheckEnabled === true;
		}

		// Keep `inputMode` in sync with the current question. Called from
		// render() so any tab change (or mount) drives the editor into the
		// right mode without every call-site having to remember to do it.
		// Idempotent: if state already matches, no changes are made.
		function reconcileMode() {
			const q = currentQuestion();
			if (!q) {
				// On Submit tab or invalid: drop out of danger mode only if
				// we were in it. Other inputModes are user-driven and stay.
				if (inputMode === "danger") {
					inputMode = null;
					inputQuestionId = null;
					editor.setText("");
				}
				return;
			}
			if (isDangerActive(q)) {
				if (inputMode !== "danger" || inputQuestionId !== q.id) {
					inputMode = "danger";
					inputQuestionId = q.id;
					// Pre-fill editor with previous answer on revisit (the
					// free_text answer value is a string, not a discriminated
					// union, so the value comes through as-is).
					const prev = answers.get(q.id)?.value;
					editor.setText(typeof prev === "string" ? prev : "");
				}
				return;
			}
			// Non-danger question: leave danger mode if we were in it.
			if (inputMode === "danger") {
				inputMode = null;
				inputQuestionId = null;
				editor.setText("");
			}
		}

		function currentQuestion(): CanonicalQuestion | undefined {
			return questions[currentTab];
		}

		function isOnSubmit(): boolean {
			return currentTab === questions.length;
		}

		function allAnswered(): boolean {
			for (let i = 0; i < questions.length; i++) {
				if (!answers.has(questions[i].id)) return false;
				const a = answers.get(questions[i].id)!;
				if (a.value === "" || (Array.isArray(a.value) && a.value.length === 0)) return false;
			}
			return true;
		}

		function saveAnswer(q: CanonicalQuestion, value: AnswerValue) {
			const idx = questions.findIndex((x) => x.id === q.id);
			answers.set(q.id, { id: q.id, index: idx, type: q.type, value });
		}

		function commitAndAdvance() {
			viewMode = "answer";
			if (!isMulti) {
				// Single-question flow shares the cleanup path with submit()
				// (clear title, stop timer). Otherwise the terminal title and
				// 1Hz render interval would outlive the questionnaire.
				submit();
				return;
			}
			if (currentTab < questions.length - 1) {
				currentTab += 1;
			} else {
				currentTab = questions.length; // Submit tab
			}
			optionIndex = 0;
			refresh();
			reconcileMode(); // open the editor on the next tab if it's a danger question
		}

		function submit() {
			if (durationTimer !== null) clearInterval(durationTimer);
			clearTerminalTitle(terminalWriter);
			done({ answers: Array.from(answers.values()), notes, lifecycle: "answered" });
		}

		function cancel() {
			if (durationTimer !== null) clearInterval(durationTimer);
			clearTerminalTitle(terminalWriter);
			done({ answers: [], notes, lifecycle: "cancelled" });
		}

		// Exposed so the extension can clear the timer on abnormal exits
		// (e.g. session shutdown, parent process kill). Safe to call multiple times.
		function dispose() {
			if (durationTimer !== null) {
				clearInterval(durationTimer);
				durationTimer = null;
			}
			clearTerminalTitle(terminalWriter);
		}

		// --- option selection ----------------------------------------------

		/** Toggle a multi-select option (does NOT submit). Other is handled
		 *  by the inline text input flow in handleInput — this function
		 *  just moves the cursor onto Other when called with Other's
		 *  index. Real-option toggles do their normal toggle dance. */
		function toggleOption(idx: number, q: CanonicalQuestion) {
			if (q.type !== "select_many") return;
			const opts = getRenderOptions(q);
			const opt = opts[idx];
			if (!opt) return;
			if (opt.isOther) {
				if (inputMode !== "other" || inputQuestionId !== q.id) {
					inputMode = "other";
					inputQuestionId = q.id;
					const prev = getOtherText(q, answers.get(q.id)?.value);
					editor.setText(prev);
					refresh();
				}
				if (optionIndex !== idx) {
					optionIndex = idx;
					refresh();
				}
				return;
			}
			const set = checked[q.id] ?? new Set<number>();
			if (set.has(idx)) set.delete(idx);
			else set.add(idx);
			checked[q.id] = set;
			const arr: ChoiceAnswer[] = [];
			for (const i of set) {
				if (!opts[i].isOther) arr.push({ mode: "option", value: opts[i].label });
			}
			const existing = answers.get(q.id)?.value;
			if (Array.isArray(existing)) {
				const otherEntry = existing.find(
					(e) => typeof e === "object" && e !== null && (e as { mode?: string }).mode === "other",
				) as ChoiceAnswer | undefined;
				if (otherEntry) arr.push(otherEntry);
			}
			saveAnswer(q, arr as AnswerValue);
			refresh();
		}

		/** Commit the current multi-select selection (with current array). */
		function commitMultiSelect(q: CanonicalQuestion) {
			if (q.type !== "select_many") return;
			// If the user hasn't toggled anything, treat as empty submit (no
			// answer). The TUI's allAnswered() will block submit.
			commitAndAdvance();
		}

		function selectOption(idx: number, q: CanonicalQuestion) {
			if (q.type === "select_many") {
				// 1-9 on multi_select calls selectOption — same routing as
				// toggleOption.
				toggleOption(idx, q);
				return;
			}
			if (q.type === "confirm_enum") {
				const opts = getRenderOptions(q);
				const opt = opts[idx];
				if (opt.isOther) {
					if (inputMode !== "other" || inputQuestionId !== q.id) {
						inputMode = "other";
						inputQuestionId = q.id;
						const prev = getOtherText(q, answers.get(q.id)?.value);
						editor.setText(prev);
						refresh();
					}
					if (optionIndex !== idx) {
						optionIndex = idx;
						refresh();
					}
					return;
				}
				const value: ConfirmAnswer = opt.label === "Affirm"
					? { mode: "option", value: "affirm" }
					: { mode: "option", value: "decline" };
				saveAnswer(q, value);
				commitAndAdvance();
				return;
			}
			// select_one
			const opts = getRenderOptions(q);
			const opt = opts[idx];
			if (opt.isOther) {
				if (inputMode !== "other" || inputQuestionId !== q.id) {
					inputMode = "other";
					inputQuestionId = q.id;
					const prev = getOtherText(q, answers.get(q.id)?.value);
					editor.setText(prev);
					refresh();
				}
				if (optionIndex !== idx) {
					optionIndex = idx;
					refresh();
				}
				return;
			}
			saveAnswer(q, { mode: "option", value: opt.label });
			commitAndAdvance();
		}

		/** Re-open the Other editor for a question (no-op if it's
		 *  already open for that question). Called by the navigation
		 *  handlers so the editor auto-opens on cursor arrival. */
		function openOtherEditorFor(q: CanonicalQuestion) {
			if (inputMode === "other" && inputQuestionId === q.id) return;
			inputMode = "other";
			inputQuestionId = q.id;
			const prev = getOtherText(q, answers.get(q.id)?.value);
			editor.setText(prev);
			refresh();
		}

		/** Auto-open the Other editor when the cursor lands on the Other
		 *  option via Up/Down navigation. No-op if Other isn't the new
		 *  option or if the editor is already open for this question. */
		function autoOpenOtherEditor(q: CanonicalQuestion, opts: ReturnType<typeof getRenderOptions>) {
			const otherIdx = opts.length - 1;
			if (optionIndex !== otherIdx) return;
			if (opts[otherIdx]?.isOther !== true) return;
			openOtherEditorFor(q);
		}

		editor.onSubmit = (value: string) => {
			if (!inputQuestionId || !inputMode) return;
			const q = questions.find((x) => x.id === inputQuestionId);
			if (!q) return;
			if (inputMode === "number") {
				const n = coerceNumber(value, q);
				if (n === undefined) {
					editor.setText("");
					refresh();
					return;
				}
				saveAnswer(q, n);
			} else if (inputMode === "other") {
				const trimmed = value.trim();
				if (trimmed === "") {
					// Empty Other: don't commit a blank answer; the editor
					// stays open with the empty text so the user can retry.
					return;
				}
				if (q.type === "select_many") {
					// Merge with any existing checked options; drop any
					// prior Other entry so re-committing doesn't accumulate
					// duplicates.
					const cur = answers.get(q.id)?.value;
					const baseArr: ChoiceAnswer[] = Array.isArray(cur)
						? (cur.filter(
								(e) =>
									typeof e === "object" && e !== null
									&& (e as { mode?: string }).mode !== "other",
							) as ChoiceAnswer[])
						: [];
					const arr: ChoiceAnswer[] = [
						...baseArr,
						{ mode: "other", text: trimmed },
					];
					saveAnswer(q, arr as AnswerValue);
				} else {
					saveAnswer(q, { mode: "other", text: trimmed });
				}
			} else if (inputMode === "free_text") {
				saveAnswer(q, value);
			} else if (inputMode === "danger") {
				// Gate: empty / whitespace-only must NOT commit. Stay in
				// danger mode (don't reset inputMode, don't advance) so the
				// user can retry. Don't show any error toast — the visual
				// state is already clear (empty editor visible).
				if (value.trim() === "") {
					return;
				}
				saveAnswer(q, value);
			} else if (inputMode === "text") {
				saveAnswer(q, value.trim());
			} else if (inputMode === "notes") {
				// Save notes
				if (value.trim() !== "") {
					notes[inputQuestionId] = value;
				} else {
					delete notes[inputQuestionId];
				}
				// Stay in notes view until user Tab/Esc back
				editor.setText(value);
				refresh();
				return;
			}
			inputMode = null;
			inputQuestionId = null;
			editor.setText("");
			commitAndAdvance();
		};

		// --- notes mode -----------------------------------------------------

		function openNotes(q: CanonicalQuestion) {
			inputMode = "notes";
			inputQuestionId = q.id;
			viewMode = "notes";
			editor.setText(notes[q.id] ?? "");
			refresh();
		}

		function closeNotes() {
			inputMode = null;
			inputQuestionId = null;
			viewMode = "answer";
			editor.setText("");
			refresh();
		}

		function toggleNotes() {
			const q = currentQuestion();
			if (!q) return;
			if (viewMode === "notes") closeNotes();
			else openNotes(q);
		}

		function handleInput(data: string) {
			// Help overlay: any key dismisses
			if (viewMode === "help") {
				viewMode = "answer";
				refresh();
				return;
			}
			// Set when the "other" editor handled a nav key (Up/Down/Tab
			// etc.) by closing itself and letting the key fall through to
			// the option-navigation handlers below. Used to skip the
			// final editor.handleInput(data) at the end of the
			// inputMode block.
			let otherHandled = false;

			if (inputMode) {
				if (matchesKey(data, Key.escape)) {
					if (inputMode === "notes") {
						closeNotes();
					} else if (inputMode === "danger") {
						// Esc cancels the whole questionnaire (same as the
						// top-level Esc behavior). Spec: danger confirmation
						// is an atomic action — there is no "back out of the
						// editor but stay on the question" path.
						cancel();
						return;
					} else {
						inputMode = null;
						inputQuestionId = null;
						editor.setText("");
						refresh();
					}
					return;
				}
				// Danger mode has no options to navigate; Up/Down are
				// explicitly suppressed so the editor's own history cursor
				// doesn't move around behind the user.
				if (
					inputMode === "danger" &&
					(matchesKey(data, Key.up) || matchesKey(data, Key.down))
				) {
					return;
				}
				// For "other" mode, let Up/Down/Tab/etc. fall through to
				// the option-navigation handlers below so the user can
				// move past Other (e.g. onto the [Select] button on
				// multi-select) without the editor swallowing the key.
				// The editor stays open with its content intact; the
				// auto-open/close logic in autoOpenOtherEditor handles the
				// focus state.
				if (inputMode === "other") {
					// Note: 'n' is NOT in the nav-key list because it's a
					// printable character the user might type into the
					// editor. Tab is the canonical notes toggle, not 'n'.
					const isNavKey = matchesKey(data, Key.up) || matchesKey(data, Key.down)
						|| data === "[" || data === "]" || data === "0"
						|| matchesKey(data, Key.tab);
					if (!isNavKey) {
						editor.handleInput(data);
						refresh();
						return;
					}
					// Nav key: close the editor and fall through to the
					// option-navigation handlers. We DON'T return here —
					// the `otherHandled` flag below tells the bottom of
					// the inputMode block to skip the final
					// editor.handleInput, and we fall through out of the
					// whole inputMode block to the option-nav handlers.
					inputMode = null;
					inputQuestionId = null;
					editor.setText("");
					otherHandled = true;
				}
				if (inputMode === "number" && matchesKey(data, Key.up)) {
					const cur = Number(editor.getText() || "0");
					editor.setText(String(Number.isFinite(cur) ? cur + 1 : 1));
					refresh();
					return;
				}
				if (inputMode === "number" && matchesKey(data, Key.down)) {
					const cur = Number(editor.getText() || "0");
					editor.setText(String(Number.isFinite(cur) ? cur - 1 : 0));
					refresh();
					return;
				}
				// In notes mode, Enter saves & stays; user Tab/Esc to leave
				if (inputMode === "notes" && matchesKey(data, Key.enter)) {
					// Save notes on Enter: trigger the editor's onSubmit, which
					// our handler routes back to the notes branch.
					const cur = editor.getText();
					editor.onSubmit?.(cur);
					return;
				}
				if (!otherHandled) {
					editor.handleInput(data);
					refresh();
				}
				if (otherHandled) {
					// Nav key from "other" mode: fall through to the
					// option-navigation handlers below. Don't return.
				} else {
					return;
				}
			}

			// On Submit tab
			if (isOnSubmit()) {
				if (matchesKey(data, Key.enter)) {
					if (allAnswered()) submit();
					return;
				}
				if (matchesKey(data, Key.escape)) {
					cancel();
					return;
				}
				// Allow nav keys to fall through to the multi-question
				// tab-nav handlers below. Without this, the user can't
				// back out of Submit to fix a wrong answer (they'd have
				// to Esc and re-answer everything). `]` and `0` are
				// no-ops here (already on Submit).
				const isMetaJump = data.startsWith("\x1b") && data.length >= 2
					&& data[1] >= "1" && data[1] <= "4";
				if (!isMulti || (data !== "[" && data !== "]" && data !== "0" && !isMetaJump)) {
					return;
				}
				// fall through to global keys (none match `[`) then tab nav
			}

			// Multi-question tab nav runs before any other handlers so
			// that `[`, `]`, `0`, Meta+1-4 work from any tab — including
			// the Submit tab (where there's no active question).
			if (isMulti) {
				if (data === "[") {
					currentTab = Math.max(0, currentTab - 1);
					optionIndex = 0;
					refresh();
					reconcileMode(); // drive inputMode to match the new tab
					return;
				}
				if (data === "]") {
					currentTab = Math.min(questions.length, currentTab + 1);
					optionIndex = 0;
					refresh();
					reconcileMode();
					return;
				}
				if (data === "0") {
					currentTab = questions.length;
					refresh();
					reconcileMode();
					return;
				}
				// Meta+1..4: jump to question. ESC + digit arrives as "\x1b1" (2 chars).
				if (data.startsWith("\x1b") && data.length >= 2 && data[1] >= "1" && data[1] <= "4") {
					const n = Number(data[1]) - 1;
					if (n < questions.length) {
						currentTab = n;
						optionIndex = 0;
						refresh();
						reconcileMode();
						return;
					}
				}
			}

			const q = currentQuestion();

			// On Submit tab (no active question) the only meaningful
			// keys have already been handled above (the isOnSubmit branch
			// for Enter/Esc, and the multi-question tab nav for [,],0).
			if (!q) return;

			// Global keys
			if (matchesKey(data, Key.escape)) {
				cancel();
				return;
			}
			if (data === "?") {
				viewMode = "help";
				refresh();
				return;
			}
			if (data === "n" || matchesKey(data, Key.tab)) {
				toggleNotes();
				return;
			}
			if (data === "e") {
				// Toggle preview expansion for current option on choice questions
				if (q.type === "select_one" || q.type === "select_many" || q.type === "confirm_enum") {
					const opts = getRenderOptions(q);
					const cur = expandedPreview[q.id];
					if (cur === optionIndex) {
						delete expandedPreview[q.id];
					} else {
						expandedPreview[q.id] = optionIndex;
					}
				}
				refresh();
				return;
			}
			if (data === "o") {
				// Open browser URL (slice 5 will hook this up; for now we record)
				if (browserUrl) {
					lastBrowserOpenAttempt = { url: browserUrl, at: Date.now() };
					// In a real implementation, we'd spawn xdg-open/open/start here.
					// The slice 5+ server module will register an openBrowser() callback.
				}
				refresh();
				return;
			}

			// Up/Down navigation on options
			if (matchesKey(data, Key.up)) {
				if (q.type === "select_one" || q.type === "select_many" || q.type === "confirm_enum") {
					const opts = getRenderOptions(q);
					// +1 for the [Select] button on multi_select
					const totalLen = opts.length + (q.type === "select_many" ? 1 : 0);
					optionIndex = (optionIndex - 1 + totalLen) % totalLen;
					autoOpenOtherEditor(q, opts);
				}
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				if (q.type === "select_one" || q.type === "select_many" || q.type === "confirm_enum") {
					const opts = getRenderOptions(q);
					const totalLen = opts.length + (q.type === "select_many" ? 1 : 0);
					optionIndex = (optionIndex + 1) % totalLen;
					autoOpenOtherEditor(q, opts);
				}
				refresh();
				return;
			}

			// Space: toggle on select_many (does NOT submit)
			if (q.type === "select_many" && matchesKey(data, Key.space)) {
				toggleOption(optionIndex, q);
				return;
			}

			// Enter
			if (matchesKey(data, Key.enter)) {
				if (q.type === "select_one" || q.type === "confirm_enum") {
					selectOption(optionIndex, q);
				} else if (q.type === "select_many") {
					// Check if [Select] button is highlighted (index = options.length)
					const opts = getRenderOptions(q);
					if (optionIndex === opts.length) {
						commitMultiSelect(q);
					} else {
						// Otherwise toggle the current option (like Space)
						toggleOption(optionIndex, q);
					}
				} else if (q.type === "number") {
					inputMode = "number";
					inputQuestionId = q.id;
					editor.setText("");
					refresh();
				} else if (q.type === "free_text") {
					inputMode = "free_text";
					inputQuestionId = q.id;
					editor.setText("");
					refresh();
				}
				return;
			}

			// 1-9: toggle option on multi_select, select on select_one/confirm_enum
			if (q.type === "select_one" || q.type === "select_many" || q.type === "confirm_enum") {
				const opts = getRenderOptions(q);
				// Clamp to Other's index (exclude [Select] from numeric keys)
				const numericMax = opts.length - 1;
				if (data >= "1" && data <= "9") {
					const n = Number(data) - 1;
					if (n <= numericMax) {
						if (q.type === "select_many") {
							toggleOption(n, q);
						} else {
							selectOption(n, q);
						}
					}
					return;
				}
			}
		}

		function renderAnsweredValue(v: AnswerValue): string {
			if (typeof v === "object" && v !== null && !Array.isArray(v) && "mode" in v) {
				const obj = v as { mode: string; value?: unknown; text?: string };
				if (obj.mode === "option") return String(obj.value);
				if (obj.mode === "other") return `(Other) ${obj.text}`;
				return JSON.stringify(v);
			}
			if (Array.isArray(v)) {
				return v
					.map((e) =>
						typeof e === "object" && e !== null && "mode" in e
							? e.mode === "option"
								? (e as { value: string }).value
								: `(Other) ${(e as { text: string }).text}`
							: String(e),
					)
					.join(", ");
			}
			return String(v);
		}

		function setBrowserUrl(url: string | null) {
			browserUrl = url;
		}

		function getBrowserOpenAttempt() {
			return lastBrowserOpenAttempt;
		}

		// ---- Visual frame + inline Other text input -----------------------
		// The questionnaire reads as one widget (frame) and the Other
		// option is captured by a small inline text input directly below
		// the option row — no modal editor, no Enter-to-open.

		const FRAME_TITLE = "AskUserQuestion";

		function wrapInFrame(inner: string[], width: number): string[] {
			const minWidth = 12;
			if (width < minWidth) return inner;
			const innerWidth = frameInnerWidth(width);
			const out: string[] = [];
			const dim = (s: string) => theme.fg("muted", s);
			const titleLabel = `─ ${FRAME_TITLE} `;
			const titleRemaining = innerWidth - titleLabel.length;
			const topBorder =
				"┌" +
				titleLabel +
				"─".repeat(Math.max(0, titleRemaining)) +
				"┐";
			out.push(dim(topBorder));
			for (const line of inner) {
				const wrapped = wrapTextWithAnsi(line, Math.max(1, innerWidth));
				for (const segment of wrapped) {
					const vw = visibleWidth(segment);
					const pad = Math.max(0, innerWidth - vw);
					out.push(dim("│") + segment + " ".repeat(pad) + dim("│"));
				}
			}
			out.push(dim("└" + "─".repeat(innerWidth) + "┘"));
			return out;
		}

		// Append the trailing status block (duration timer, browser URL,
		// note indicator) to a render buffer. Shared between the normal
		// question view and the is_dangerous confirmation view so both
		// stay in sync if the format evolves.
		function appendStatusLines(
			lines: string[],
			q: CanonicalQuestion,
			theme: any,
			askedAtMs: number,
			notesMap: Record<string, string>,
			browser: string | null,
		) {
			const note = notesMap[q.id];
			const noteIndicator = note ? " 📝" : "";
			const elapsed = formatElapsed(Date.now() - askedAtMs);
			lines.push("");
			lines.push(theme.fg("muted", `⏱  ${elapsed} elapsed`));
			if (browser) {
				lines.push(theme.fg("muted", `🌐 ${browser} (press o to open)`));
			}
			if (noteIndicator) {
				lines.push(theme.fg("muted", `Note: ${note}`));
			}
		}

		function render(width: number): string[] {
			// Keep the inputMode in sync with the active question. Done at
			// the top of render() so any tab change (or the first mount)
			// drives the editor into the right state without every callsite
			// having to remember to invoke reconcileMode().
			reconcileMode();
			const contentWidth = frameInnerWidth(width);

			// Help overlay
			if (viewMode === "help") {
				return wrapInFrame(
					KEYMAP_HELP.map((l) => theme.fg("muted", l)),
					width,
				);
			}

			const lines: string[] = [];
			// Tab bar (multi-question only)
			if (isMulti) {
				const tabs: string[] = [];
				for (let i = 0; i < questions.length; i++) {
					const q = questions[i];
					const answered = answers.has(q.id);
					const hasNote = notes[q.id] !== undefined && notes[q.id] !== "";
					const marker = answered ? (hasNote ? "▣" : "■") : (hasNote ? "▢" : "□");
					const active = i === currentTab;
					const text = `${marker} ${q.header}`;
					tabs.push(active ? theme.fg("accent", text) : theme.fg("muted", text));
				}
				// Hide the Submit tab while on a danger question: the danger
				// flow is atomic (Enter on the editor commits that single
				// question), so there is nothing for a Submit review step to
				// do — and we don't want the user to skip past the
				// confirmation by jumping to Submit.
				const activeQ = currentQuestion();
				const onDanger = activeQ !== undefined && isDangerActive(activeQ);
				if (!onDanger) {
					tabs.push(currentTab === questions.length ? theme.fg("accent", "Submit") : theme.fg("muted", "Submit"));
				}
				lines.push(tabs.join("  "));
				lines.push("");
			}

			if (isOnSubmit()) {
				lines.push(theme.fg("accent", theme.bold("Submit answers")));
				lines.push("");
				lines.push(theme.fg("muted", "Review your answers and press Enter to submit, or Esc to cancel."));
				lines.push("");
				for (let i = 0; i < questions.length; i++) {
					const q = questions[i];
					const a = answers.get(q.id);
					const head = theme.fg("accent", q.header);
					if (!a) {
						lines.push(`${theme.fg("muted", "○")} ${head}: ${theme.fg("warning", "unanswered")}`);
					} else {
						lines.push(`${theme.fg("success", "✓")} ${head}: ${renderAnsweredValue(a.value)}`);
					}
						const note = notes[q.id];
						if (note) {
							addWrappedWithPrefix(lines, "    ", theme.fg("muted", `note: ${note}`), contentWidth);
						}
					}
				lines.push("");
				lines.push(theme.fg("muted", "[Enter] submit  [Esc] cancel"));
				return wrapInFrame(lines, width);
			}

			const q = currentQuestion()!;

			// is_dangerous confirmation editor. Renders BEFORE the type-
			// specific UI so the warning header replaces the normal header
			// and the type-specific widget (options, etc.) is skipped.
			//
			// The editor is rendered INLINE here (unlike free_text / notes,
			// where the host renders the editor). Reason: the host only
			// renders the editor for a known set of inputModes ("free_text",
			// "notes", "other", "number", "text"). "danger" isn't on that
			// list, so without inlining the editor the user would type into
			// a black hole. Inlining guarantees the typed text is echoed so
			// the user can see what they're confirming.
			if (isDangerActive(q)) {
				lines.push(
					theme.fg("warning", theme.bold(`⚠️  DESTRUCTIVE — ${q.header}`)),
				);
				lines.push("");
				lines.push(theme.fg("warning", q.question));
					if (q.description) {
						lines.push("");
						addWrapped(lines, theme.fg("muted", q.description), contentWidth);
					}
				lines.push("");
				lines.push(theme.fg("accent", "Type the resource name to confirm:"));
				lines.push("");
				// Inline-render the editor so the user sees what they're typing.
				// The host doesn't render the editor for inputMode === "danger".
					lines.push(...editor.render(contentWidth));
				lines.push("");
				lines.push(theme.fg("muted", "[Enter] confirm  [Esc] cancel"));
				appendStatusLines(lines, q, theme, askedAt, notes, browserUrl);
				return wrapInFrame(lines, width);
			}

			lines.push(theme.fg("accent", theme.bold(q.header)));
			lines.push(theme.fg("text", q.question));
				if (q.description) {
					lines.push("");
					addWrapped(lines, theme.fg("muted", q.description), contentWidth);
				}
			lines.push("");

			// Notes mode for this question
			if (viewMode === "notes") {
				lines.push(theme.fg("muted", `Notes for "${q.header}":`));
				lines.push("");
				// We don't render the editor inline (it would conflict with the
				// rest of the layout). The user is in the editor; the test just
				// sees this prompt line.
				lines.push(theme.fg("accent", "(typing in editor — Enter to save, Esc to discard)"));
				lines.push("");
				lines.push(theme.fg("muted", "[Enter] save notes  [Esc] back to answer"));
				return wrapInFrame(lines, width);
			}

			if (q.type === "select_one" || q.type === "select_many" || q.type === "confirm_enum") {
				const opts = getRenderOptions(q);
				const currentValue = answers.get(q.id)?.value;
				const isOtherChosen = isOtherSelectedFor(q, currentValue);
				for (let i = 0; i < opts.length; i++) {
					const opt = opts[i];
					const isOtherOpt = opt.isOther === true;
					const selected = i === optionIndex;
					const isChecked = q.type === "select_many"
						? (checked[q.id]?.has(i) ?? false)
						: undefined;
					const showOtherMark = isOtherOpt && isOtherChosen;
					const fakeChecked = showOtherMark ? true : isChecked;
					const active = isOtherOpt && isOtherChosen;
					const previewExpanded = expandedPreview[q.id] === i;
					renderOptionLine(opt, i, selected, fakeChecked, active, previewExpanded, contentWidth, theme, lines);
					// If Other is chosen, show the committed text on the
					// next line as a hint.
					if (isOtherOpt && isOtherChosen) {
						const prior = getOtherText(q, currentValue);
						if (prior) {
							addWrappedWithPrefix(
								lines,
								"     ",
								theme.fg("accent", `→ ${prior}`),
								contentWidth,
							);
						}
					}
				}
				// Inline editor for Other. The host doesn't render the
				// editor for inputMode === "other" (same as for
				// "danger"), so we inline it. Gives the user full
				// pi-tui text input mechanics (word delete, history,
				// multi-line, etc.) instead of a stripped-down custom
				// text input.
				if (inputMode === "other" && inputQuestionId === q.id) {
					lines.push("");
					lines.push(...editor.render(contentWidth));
				}
				// [Select] button for multi_select (commits the array)
				if (q.type === "select_many") {
					lines.push("");
					const isSelect = optionIndex === opts.length;
					const arrow = isSelect ? SELECTOR_ARROW : "   ";
					const selectText = `${arrow}[Select]  ${theme.fg("muted", "(submit selected)")}`;
					lines.push(theme.fg(isSelect ? "accent" : "text", selectText));
				}
				lines.push("");
				if (q.type === "select_many") {
					lines.push(theme.fg("muted", "↑/↓ navigate  Space/Enter toggle  Tab notes  e preview  ? help"));
				} else {
					lines.push(theme.fg("muted", "↑/↓ navigate  Enter select  1-9 quick  Tab notes  e preview  o browser  ? help"));
				}
			} else if (q.type === "number") {
				lines.push(theme.fg("muted", "(Enter to edit; ↑/↓ to nudge)"));
				if (q.min !== undefined || q.max !== undefined) {
					lines.push(
						theme.fg(
							"muted",
							`Range: ${q.min ?? "−∞"} … ${q.max ?? "+∞"}`,
						),
					);
				}
				const current = answers.get(q.id)?.value;
				if (current !== undefined) {
					lines.push("");
					lines.push(theme.fg("success", `Answered: ${current}`));
				}
				lines.push("");
				lines.push(theme.fg("muted", "Enter to type  Tab notes  ? help  Esc cancel"));
			} else if (q.type === "free_text") {
				lines.push(theme.fg("muted", "(Enter to start typing — multiline)"));
				if (q.placeholder) {
					lines.push(theme.fg("muted", `Placeholder: ${q.placeholder}`));
				}
				const current = answers.get(q.id)?.value;
					if (typeof current === "string" && current.length > 0) {
						lines.push("");
						addWrapped(lines, theme.fg("success", `Answered: ${current}`), contentWidth);
					}
				lines.push("");
				lines.push(theme.fg("muted", "Enter to type  Tab notes  ? help  Esc cancel"));
			}

			// Status line: duration timer + notes indicator + browser URL
			appendStatusLines(lines, q, theme, askedAt, notes, browserUrl);
			// Suppress unused warning for the helper
			void getOptionByIdx;

			return wrapInFrame(lines, width);
		}

		// Initial sync: if the first question is in danger mode, open the
		// editor immediately so the very first keypress is routed into it
		// (without this, the user would have to call render() once before
		// handleInput for inputMode to settle correctly).
		reconcileMode();

		return {
			render,
			handleInput,
			invalidate() {
				refresh();
			},
			// Exposed for slice 5+ to wire up
			setBrowserUrl,
			getBrowserOpenAttempt,
			// Test helpers: read/write the editor's text directly. Used by
			// the is_dangerous tests to verify the revisit prefill path
			// (after re-mounting / navigating back) without having to drive
			// a full terminal-input sequence.
			getEditorText: () => editor.getText(),
			setEditorText: (text: string) => editor.setText(text),
			// Clear the duration timer (called on done or session shutdown)
			dispose,
		};
	};
}
