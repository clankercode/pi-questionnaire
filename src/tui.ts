// src/tui.ts
// Rich TUI component for the AskUserQuestion tool. v2 supports 5 question types
// (select_one, select_many, confirm_enum, number, free_text) in a tabbed
// interface. Full feature set per spec §4 lands across slices; this file is
// the minimal-but-functional v2 starting point for slice 1, with notes /
// persistent checkmarks / preview expansion / "Other" revisit / live count
// added in slice 2+.

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
	width: number,
	theme: any,
	lines: string[],
) {
	const isOther = opt.isOther === true;
	const head = (() => {
		if (checked !== undefined) {
			// multi_select: checkbox
			const arrow = selected ? theme.fg("accent", "▶ ") : "  ";
			const box = checked ? theme.fg("success", "■") : theme.fg("muted", "□");
			return `${arrow}${box} ${idx + 1}. ${opt.label}${active ? " ✎" : ""}`;
		}
		// select_one / confirm_enum: arrow pointer
		const arrow = selected ? theme.fg("accent", "> ") : "  ";
		return `${arrow}${idx + 1}. ${opt.label}${active ? " ✎" : ""}`;
	})();
	addWrappedWithPrefix(lines, "", theme.fg(selected ? "accent" : "text", head), width);
	if (opt.description) {
		addWrappedWithPrefix(lines, "     ", theme.fg("muted", opt.description), width);
	}
	if (opt.preview) {
		addWrappedWithPrefix(lines, "     ", previewLine(opt.preview.type, theme), width);
		const w = Math.max(1, width);
		const indented = wrapTextWithAnsi(opt.preview.content, w - 7).map((l) => "      " + l);
		lines.push(...indented);
	}
}

function isOtherSelectedFor(q: CanonicalQuestion, currentValue: AnswerValue | undefined): boolean {
	if (currentValue === undefined) return false;
	if (q.type === "select_one") {
		const a = currentValue as { mode?: string; text?: string };
		return typeof a === "object" && a !== null && a.mode === "other";
	}
	if (q.type === "confirm_enum") {
		const a = currentValue as { mode?: string; text?: string };
		return typeof a === "object" && a !== null && a.mode === "other";
	}
	return false;
}

// ---- Component factory ----------------------------------------------------

export function buildQuestionnaireComponent(opts: TuiOptions) {
	const questions = opts.questions;
	if (questions.length === 0) {
		throw new Error("AskUserQuestion requires at least one question");
	}
	const isMulti = questions.length > 1;
	const totalTabs = questions.length + 1; // + Submit tab

	return (tui: any, theme: any, _kb: any, done: (v: TuiResult) => void) => {
		let currentTab = 0;
		let optionIndex = 0;
		let checked: Record<string, Set<number>> = {};
		const answers = new Map<string, TuiAnswer>();
		const notes: Record<string, string> = {};
		let inputMode: "text" | "number" | "other" | "free_text" | null = null;
		let inputQuestionId: string | null = null;

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
			done({ answers: Array.from(answers.values()), notes, lifecycle: "answered" });
		}

		function cancel() {
			done({ answers: [], notes, lifecycle: "cancelled" });
		}

		// --- option selection ----------------------------------------------

		function selectOption(idx: number, q: CanonicalQuestion) {
			if (q.type === "select_many") {
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
				if (!isMulti) {
					submit();
					return;
				}
				refresh();
				return;
			}
			if (q.type === "confirm_enum") {
				const opts = getRenderOptions(q);
				const opt = opts[idx];
				if (opt.isOther) {
					inputMode = "other";
					inputQuestionId = q.id;
					editor.setText("");
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
				editor.setText("");
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
			}
			inputMode = null;
			inputQuestionId = null;
			editor.setText("");
			commitAndAdvance();
		};

		function handleInput(data: string) {
			if (inputMode) {
				if (matchesKey(data, Key.escape)) {
					inputMode = null;
					inputQuestionId = null;
					editor.setText("");
					refresh();
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
				// Forward to editor for normal text input
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

			// Tab nav: Meta+1..4 (or [ / ]) or 0 (Submit)
			if (matchesKey(data, Key.escape)) {
				cancel();
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
				// Meta+1..4 (Alt+1..4): jump to question
				if (data.startsWith("\x1b") && data.length >= 3 && data[2] >= "1" && data[2] <= "4") {
					const n = Number(data[2]) - 1;
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
					optionIndex = (optionIndex - 1 + opts.length) % opts.length;
				}
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				if (q.type === "select_one" || q.type === "select_many" || q.type === "confirm_enum") {
					const opts = getRenderOptions(q);
					optionIndex = (optionIndex + 1) % opts.length;
				}
				refresh();
				return;
			}

			// Space: toggle on select_many
			if (q.type === "select_many" && matchesKey(data, Key.space)) {
				selectOption(optionIndex, q);
				return;
			}

			// Enter
			if (matchesKey(data, Key.enter)) {
				if (q.type === "select_one" || q.type === "select_many" || q.type === "confirm_enum") {
					selectOption(optionIndex, q);
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

			// 1-9: select option on choice questions
			if (q.type === "select_one" || q.type === "select_many" || q.type === "confirm_enum") {
				const opts = getRenderOptions(q);
				// Clamp to options.length - 1 so numeric keys never reach "Other"
				const numericMax = opts.length - 1; // last index = "Other"
				if (data >= "1" && data <= "9") {
					const n = Number(data) - 1;
					if (n <= numericMax) {
						selectOption(n, q);
					}
					return;
				}
			}
		}

		function render(width: number): string[] {
			const lines: string[] = [];
			// Tab bar (multi-question only)
			if (isMulti) {
				const tabs: string[] = [];
				for (let i = 0; i < questions.length; i++) {
					const q = questions[i];
					const answered = answers.has(q.id);
					const marker = answered ? "■" : "□";
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
						continue;
					}
					const v = a.value;
					let display: string;
					if (typeof v === "object" && v !== null && "mode" in v) {
						if (v.mode === "option") display = String((v as { value: unknown }).value);
						else if (v.mode === "other") display = `(Other) ${(v as { text: string }).text}`;
						else display = JSON.stringify(v);
					} else if (typeof v === "string") {
						display = v;
					} else if (typeof v === "number") {
						display = String(v);
					} else if (Array.isArray(v)) {
						display = v
							.map((e) =>
								typeof e === "object" && e !== null && "mode" in e
									? e.mode === "option"
										? (e as { value: string }).value
										: `(Other) ${(e as { text: string }).text}`
									: String(e),
							)
							.join(", ");
					} else {
						display = String(v);
					}
					lines.push(`${theme.fg("success", "✓")} ${head}: ${display}`);
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
					// For Other, show checkmark if it was the chosen one
					const showOtherMark = isOtherOpt && isOtherChosen;
					const fakeChecked = showOtherMark
						? true
						: isChecked;
					// If answered, dim non-chosen options
					const active = isOtherOpt && isOtherChosen;
					renderOptionLine(opt, i, selected, fakeChecked, active, width, theme, lines);
				}
				lines.push("");
				if (q.type === "select_many") {
					lines.push(theme.fg("muted", "↑/↓ navigate  Space toggle  Enter next  Esc cancel"));
				} else {
					lines.push(theme.fg("muted", "↑/↓ navigate  Enter select  1-9 quick  Esc cancel"));
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
				lines.push(theme.fg("muted", "Enter to type  Esc cancel"));
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
				lines.push(theme.fg("muted", "Enter to type  Esc cancel"));
			}

			return lines;
		}

		return {
			render,
			handleInput,
			invalidate() {
				refresh();
			},
		};
	};
}
