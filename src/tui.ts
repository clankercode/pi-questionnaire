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
	ConfirmAnswer,
	Lifecycle,
	RenderOption,
} from "./types.ts";
import { coerceNumber, getRenderOptions } from "./answers.ts";

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
			const arrow = selected ? theme.fg("accent", "▶ ") : "  ";
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
	return false;
}

function getOtherText(q: CanonicalQuestion, currentValue: AnswerValue | undefined): string {
	if (currentValue === undefined) return "";
	if (q.type === "select_one" || q.type === "confirm_enum") {
		const a = currentValue as { mode?: string; text?: string };
		return a.mode === "other" ? a.text ?? "" : "";
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
		// Prefix the terminal title with a bell so the user notices the
		// questionnaire is waiting. Restored (cleared) on done.
		const firstHeader = questions[0]?.header ?? "Question";
		setTerminalTitle(`🔔 AskUserQuestion — ${firstHeader}`);
		let currentTab = 0;
		let optionIndex = 0;
		const checked: Record<string, Set<number>> = {};
		const expandedPreview: Record<string, number | null> = {}; // q.id -> option index
		const notes: Record<string, string> = {};
		const answers = new Map<string, TuiAnswer>();
		let viewMode: ViewMode = "answer";
		let inputMode: "text" | "number" | "other" | "free_text" | "notes" | null = null;
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
				done({ answers: Array.from(answers.values()), notes, lifecycle: "answered" });
				return;
			}
			if (currentTab < questions.length - 1) {
				currentTab += 1;
			} else {
				currentTab = questions.length; // Submit tab
			}
			optionIndex = 0;
			refresh();
		}

		function submit() {
			if (durationTimer !== null) clearInterval(durationTimer);
			clearTerminalTitle();
			done({ answers: Array.from(answers.values()), notes, lifecycle: "answered" });
		}

		function cancel() {
			if (durationTimer !== null) clearInterval(durationTimer);
			clearTerminalTitle();
			done({ answers: [], notes, lifecycle: "cancelled" });
		}

		// Exposed so the extension can clear the timer on abnormal exits
		// (e.g. session shutdown, parent process kill). Safe to call multiple times.
		function dispose() {
			if (durationTimer !== null) {
				clearInterval(durationTimer);
				durationTimer = null;
			}
			clearTerminalTitle();
		}

		// --- option selection ----------------------------------------------

		/** Toggle a multi-select option (does NOT submit). */
		function toggleOption(idx: number, q: CanonicalQuestion) {
			if (q.type !== "select_many") return;
			const set = checked[q.id] ?? new Set<number>();
			if (set.has(idx)) set.delete(idx);
			else set.add(idx);
			checked[q.id] = set;
			const opts = getRenderOptions(q);
			const arr: { mode: "option"; value: string }[] = [];
			for (const i of set) {
				if (!opts[i].isOther) arr.push({ mode: "option", value: opts[i].label });
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
				// Back-compat: selectOption is called from 1-9 path. For
				// multi_select, 1-9 should toggle, not submit.
				toggleOption(idx, q);
				return;
			}
			if (q.type === "confirm_enum") {
				const opts = getRenderOptions(q);
				const opt = opts[idx];
				if (opt.isOther) {
					inputMode = "other";
					inputQuestionId = q.id;
					// Pre-populate editor with previous "Other" text (Other revisit)
					const prev = getOtherText(q, answers.get(q.id)?.value);
					editor.setText(prev);
					refresh();
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
				inputMode = "other";
				inputQuestionId = q.id;
				// Pre-populate editor with previous "Other" text (Other revisit)
				const prev = getOtherText(q, answers.get(q.id)?.value);
				editor.setText(prev);
				refresh();
				return;
			}
			saveAnswer(q, { mode: "option", value: opt.label });
			commitAndAdvance();
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
					inputMode = null;
					inputQuestionId = null;
					editor.setText("");
					refresh();
					return;
				}
				const ans: AnswerValue = q.type === "confirm_enum"
					? { mode: "other", text: trimmed }
					: { mode: "other", text: trimmed };
				saveAnswer(q, ans);
			} else if (inputMode === "free_text") {
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

			if (inputMode) {
				if (matchesKey(data, Key.escape)) {
					if (inputMode === "notes") {
						closeNotes();
					} else {
						inputMode = null;
						inputQuestionId = null;
						editor.setText("");
						refresh();
					}
					return;
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
				editor.handleInput(data);
				refresh();
				return;
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
				return;
			}

			const q = currentQuestion()!;

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
			if (isMulti) {
				if (data === "[") {
					currentTab = Math.max(0, currentTab - 1);
					optionIndex = 0;
					refresh();
					return;
				}
				if (data === "]") {
					currentTab = Math.min(questions.length, currentTab + 1);
					optionIndex = 0;
					refresh();
					return;
				}
				if (data === "0") {
					currentTab = questions.length;
					refresh();
					return;
				}
				// Meta+1..4: jump to question. ESC + digit arrives as "\x1b1" (2 chars).
				if (data.startsWith("\x1b") && data.length >= 2 && data[1] >= "1" && data[1] <= "4") {
					const n = Number(data[1]) - 1;
					if (n < questions.length) {
						currentTab = n;
						optionIndex = 0;
						refresh();
						return;
					}
				}
			}

			// Up/Down navigation on options
			if (matchesKey(data, Key.up)) {
				if (q.type === "select_one" || q.type === "select_many" || q.type === "confirm_enum") {
					const opts = getRenderOptions(q);
					// +1 for the [Select] button on multi_select
					const totalLen = opts.length + (q.type === "select_many" ? 1 : 0);
					optionIndex = (optionIndex - 1 + totalLen) % totalLen;
				}
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				if (q.type === "select_one" || q.type === "select_many" || q.type === "confirm_enum") {
					const opts = getRenderOptions(q);
					const totalLen = opts.length + (q.type === "select_many" ? 1 : 0);
					optionIndex = (optionIndex + 1) % totalLen;
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

		function render(width: number): string[] {
			// Help overlay
			if (viewMode === "help") {
				return KEYMAP_HELP.map((l) => theme.fg("muted", l));
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
				tabs.push(currentTab === questions.length ? theme.fg("accent", "Submit") : theme.fg("muted", "Submit"));
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
						addWrappedWithPrefix(lines, "    ", theme.fg("muted", `note: ${note}`), width);
					}
				}
				lines.push("");
				lines.push(theme.fg("muted", "[Enter] submit  [Esc] cancel"));
				return lines;
			}

			const q = currentQuestion()!;
			lines.push(theme.fg("accent", theme.bold(q.header)));
			lines.push(theme.fg("text", q.question));
			if (q.description) {
				lines.push("");
				addWrapped(lines, theme.fg("muted", q.description), width);
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
				return lines;
			}

			if (q.type === "select_one" || q.type === "select_many" || q.type === "confirm_enum") {
				const opts = getRenderOptions(q);
				const currentValue = answers.get(q.id)?.value;
				const isOtherChosen = isOtherSelectedFor(q, currentValue);
				const otherText = getOtherText(q, currentValue);
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
					renderOptionLine(opt, i, selected, fakeChecked, active, previewExpanded, width, theme, lines);
					// If Other is chosen, show the text on the next line
					if (isOtherOpt && isOtherChosen && otherText) {
						addWrappedWithPrefix(lines, "     ", theme.fg("accent", `→ ${otherText}`), width);
					}
				}
				// [Select] button for multi_select (commits the array)
				if (q.type === "select_many") {
					lines.push("");
					const isSelect = optionIndex === opts.length;
					const arrow = isSelect ? theme.fg("accent", "▶ ") : "  ";
					const selectText = `${arrow}[Select]  ${theme.fg("muted", "(submit selected)")}`;
					lines.push(theme.fg(isSelect ? "accent" : "text", selectText));
				}
				lines.push("");
				if (q.type === "select_many") {
					lines.push(theme.fg("muted", "↑/↓ navigate  Space/Enter toggle  Enter on [Select] to commit  Tab notes  e preview  ? help"));
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
					addWrapped(lines, theme.fg("success", `Answered: ${current}`), width);
				}
				lines.push("");
				lines.push(theme.fg("muted", "Enter to type  Tab notes  ? help  Esc cancel"));
			}

			// Status line: duration timer + notes indicator + browser URL
			const note = notes[q.id];
			const noteIndicator = note ? theme.fg("accent", " 📝") : "";
			const elapsed = formatElapsed(Date.now() - askedAt);
			lines.push("");
			lines.push(theme.fg("muted", `⏱  ${elapsed} elapsed`));
			if (browserUrl) {
				lines.push(theme.fg("muted", `🌐 ${browserUrl} (press o to open)`));
			}
			if (noteIndicator) {
				lines.push(theme.fg("muted", `Note: ${note}`));
			}
			// Suppress unused warning for the helper
			void getOptionByIdx;

			return lines;
		}

		return {
			render,
			handleInput,
			invalidate() {
				refresh();
			},
			// Exposed for slice 5+ to wire up
			setBrowserUrl,
			getBrowserOpenAttempt,
			// Clear the duration timer (called on done or session shutdown)
			dispose,
		};
	};
}
