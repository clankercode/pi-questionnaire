// src/tui.ts
// Rich TUI component for the ask_user tool. Supports all 5 question types
// (single_select, multi_select, text, confirm, number) in a tabbed interface
// modeled on the existing pi `questionnaire.ts` example, but extended for
// previews, descriptions, multi-select toggles, and number up/down nudging.

import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { CanonicalQuestion, RenderOption } from "./types.ts";
import { coerceNumber, getRenderOptions } from "./answers.ts";
import { confirmOptions } from "./normalize.ts";

// ---- Public types ---------------------------------------------------------

export interface TuiAnswer {
	id: string;
	type: CanonicalQuestion["type"];
	value: string | string[] | number | boolean;
	wasCustom: boolean;
	index?: number; // for single_select
}

export interface TuiResult {
	answers: TuiAnswer[];
	notes?: Record<string, string>;
	cancelled: boolean;
}

export interface TuiDeps {
	tui: any; // TUI instance from ctx.ui.custom
	theme: any; // Theme object
	done: (value: TuiResult) => void;
}

export interface TuiOptions {
	questions: CanonicalQuestion[];
}

// ---- Tabs -----------------------------------------------------------------

const SUBMIT_TAB = "__submit__";
const TABS_PER_PAGE = 1; // we render one question at a time but with a tab bar for nav

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
	const label = `[${type}]`;
	return theme.fg("muted", label);
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
	let prefix: string;
	if (checked !== undefined) {
		// multi-select: checkbox
		prefix = selected ? theme.fg("accent", "▶ ") : "  ";
		const box = checked ? theme.fg("success", "■") : theme.fg("muted", "□");
		const head = `${prefix}${box} ${idx + 1}. ${opt.label}${active ? " ✎" : ""}`;
		addWrappedWithPrefix(lines, "", theme.fg(selected ? "accent" : "text", head), width);
	} else {
		// single-select / confirm: arrow pointer
		prefix = selected ? theme.fg("accent", "> ") : "  ";
		const head = `${prefix}${idx + 1}. ${opt.label}${active ? " ✎" : ""}`;
		addWrappedWithPrefix(lines, "", theme.fg(selected ? "accent" : "text", head), width);
	}
	if (opt.description) {
		addWrappedWithPrefix(lines, "     ", theme.fg("muted", opt.description), width);
	}
	if (opt.preview) {
		addWrappedWithPrefix(lines, "     ", previewLine(opt.preview.type, theme), width);
		// Indent the first line of the preview body
		const w = Math.max(1, width);
		const indented = wrapTextWithAnsi(opt.preview.content, w - 7).map((l) => "      " + l);
		lines.push(...indented);
	}
}

// ---- Component factory ----------------------------------------------------

export function buildQuestionnaireComponent(opts: TuiOptions) {
	const questions = opts.questions;
	if (questions.length === 0) {
		throw new Error("questionnaire requires at least one question");
	}
	const isMulti = questions.length > 1;
	// For single question we still offer the Submit tab so the user can review answers.
	const totalTabs = questions.length + 1;

	return (tui: any, theme: any, _kb: any, done: (v: TuiResult) => void) => {
		let currentTab = 0;
		let optionIndex = 0;
		let checked: Record<string, Set<number>> = {}; // questionId -> set of selected option indices
		let inputMode: "text" | "number" | "other" | null = null;
		let inputQuestionId: string | null = null;
		let cachedLines: string[] | undefined;
		const answers = new Map<string, TuiAnswer>();

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
			cachedLines = undefined;
			tui.requestRender();
		}

		function currentQuestion(): CanonicalQuestion | undefined {
			return questions[currentTab];
		}

		function isOnSubmit(): boolean {
			return currentTab === questions.length;
		}

		function allAnswered(): boolean {
			for (const q of questions) {
				if (!q.required) continue;
				if (!answers.has(q.id)) return false;
				const a = answers.get(q.id)!;
				if (a.value === "" || (Array.isArray(a.value) && a.value.length === 0)) return false;
			}
			return true;
		}

		function saveAnswer(q: CanonicalQuestion, value: TuiAnswer["value"], wasCustom: boolean, index?: number) {
			answers.set(q.id, { id: q.id, type: q.type, value, wasCustom, index });
		}

		function advanceAfterAnswer() {
			if (currentTab < questions.length - 1) {
				currentTab += 1;
			} else {
				currentTab = questions.length; // Submit tab
			}
			optionIndex = 0;
			refresh();
		}

		function selectOption(opt: RenderOption, q: CanonicalQuestion) {
			if (q.type === "multi_select") {
				const set = checked[q.id] ?? new Set<number>();
				const idx = q.options!.indexOf(opt);
				if (set.has(idx)) set.delete(idx);
				else set.add(idx);
				checked[q.id] = set;
				refresh();
				return;
			}
			// single_select / confirm
			if (opt.isOther) {
				inputMode = "other";
				inputQuestionId = q.id;
				editor.setText("");
				refresh();
				return;
			}
			const idx = q.options!.indexOf(opt);
			saveAnswer(q, opt.label, false, idx + 1);
			advanceAfterAnswer();
		}

		editor.onSubmit = (value: string) => {
			if (!inputQuestionId || !inputMode) return;
			const q = questions.find((x) => x.id === inputQuestionId);
			if (!q) return;
			if (inputMode === "number") {
				const n = coerceNumber(value, q);
				if (n === undefined) {
					// bad input — stay in input mode, show warning
					editor.setText("");
					refresh();
					return;
				}
				saveAnswer(q, n, false);
			} else {
				// text or "other"
				const trimmed = value.trim();
				if (inputMode === "other") {
					// Empty Other is treated as no answer.
					if (trimmed === "") {
						inputMode = null;
						inputQuestionId = null;
						editor.setText("");
						refresh();
						return;
					}
					saveAnswer(q, trimmed, true);
				} else {
					// text question
					saveAnswer(q, trimmed || "", false);
				}
			}
			inputMode = null;
			inputQuestionId = null;
			editor.setText("");
			advanceAfterAnswer();
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
				editor.handleInput(data);
				refresh();
				return;
			}

			// Tab navigation
			if (isMulti) {
				if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
					currentTab = (currentTab + 1) % totalTabs;
					optionIndex = 0;
					refresh();
					return;
				}
				if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
					currentTab = (currentTab - 1 + totalTabs) % totalTabs;
					optionIndex = 0;
					refresh();
					return;
				}
			}

			// Submit tab
			if (isOnSubmit()) {
				if (matchesKey(data, Key.enter) && allAnswered()) {
					done({ answers: Array.from(answers.values()), cancelled: false });
				} else if (matchesKey(data, Key.escape)) {
					done({ answers: [], cancelled: true });
				}
				return;
			}

			const q = currentQuestion();
			if (!q) return;

			// text input
			if (q.type === "text") {
				if (matchesKey(data, Key.enter) && q.multiline) {
					// newline within multiline
				}
				if (matchesKey(data, Key.enter) && !q.multiline) {
					const v = editor.getText().trim();
					saveAnswer(q, v, false);
					editor.setText("");
					advanceAfterAnswer();
					return;
				}
				inputMode = "text";
				inputQuestionId = q.id;
				if (editor.getText() === "" && typeof q.default === "string") {
					editor.setText(q.default);
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			// number input
			if (q.type === "number") {
				if (matchesKey(data, Key.up)) {
					const cur = Number(editor.getText() || "0");
					editor.setText(String(Number.isFinite(cur) ? cur + 1 : 1));
					inputMode = "number";
					inputQuestionId = q.id;
					refresh();
					return;
				}
				if (matchesKey(data, Key.down)) {
					const cur = Number(editor.getText() || "0");
					editor.setText(String(Number.isFinite(cur) ? cur - 1 : 0));
					inputMode = "number";
					inputQuestionId = q.id;
					refresh();
					return;
				}
				if (matchesKey(data, Key.enter)) {
					const n = coerceNumber(editor.getText(), q);
					if (n === undefined) return;
					saveAnswer(q, n, false);
					editor.setText("");
					advanceAfterAnswer();
					return;
				}
				// start editing
				inputMode = "number";
				inputQuestionId = q.id;
				editor.handleInput(data);
				refresh();
				return;
			}

			// select-type (single_select, multi_select, confirm)
			const opts =
				q.type === "confirm"
					? confirmOptions().map((o) => ({ ...o, value: o.label }))
					: getRenderOptions(q);
			if (opts.length === 0) return;
			if (matchesKey(data, Key.up)) {
				optionIndex = Math.max(0, optionIndex - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				optionIndex = Math.min(opts.length - 1, optionIndex + 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.space) && q.type === "multi_select") {
				const opt = opts[optionIndex];
				selectOption(opt, q);
				return;
			}
			if (matchesKey(data, Key.enter)) {
				const opt = opts[optionIndex];
				selectOption(opt, q);
				return;
			}
			if (matchesKey(data, Key.escape)) {
				done({ answers: [], cancelled: true });
			}
		}

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;
			const lines: string[] = [];
			const W = Math.max(1, width);

			lines.push(theme.fg("accent", "─".repeat(W)));

			// Tab bar
			if (isMulti) {
				const tabs: string[] = ["← "];
				for (let i = 0; i < questions.length; i++) {
					const isActive = i === currentTab;
					const isAnswered = answers.has(questions[i].id);
					const lbl = questions[i].header;
					const box = isAnswered ? "■" : "□";
					const color = isAnswered ? "success" : "muted";
					const text = ` ${box} ${lbl} `;
					const styled = isActive
						? theme.bg("selectedBg", theme.fg("text", text))
						: theme.fg(color, text);
					tabs.push(`${styled} `);
				}
				const canSubmit = allAnswered();
				const onSubmit = isOnSubmit();
				const subText = " ✓ Submit ";
				const subStyled = onSubmit
					? theme.bg("selectedBg", theme.fg("text", subText))
					: theme.fg(canSubmit ? "success" : "dim", subText);
				tabs.push(`${subStyled} →`);
				addWrappedWithPrefix(lines, " ", tabs.join(""), W);
				lines.push("");
			}

			const q = currentQuestion();

			if (isOnSubmit()) {
				addWrappedWithPrefix(lines, " ", theme.fg("accent", theme.bold("Ready to submit")), W);
				lines.push("");
				for (const question of questions) {
					const a = answers.get(question.id);
					if (a) {
						let val: string;
						if (Array.isArray(a.value)) val = a.value.join(", ");
						else val = String(a.value);
						if (a.wasCustom) val = `(wrote) ${val}`;
						addWrappedWithPrefix(
							lines,
							" ",
							`${theme.fg("muted", question.header + ": ")}${theme.fg("text", val)}`,
							W,
						);
					}
				}
				lines.push("");
				if (allAnswered()) {
					addWrappedWithPrefix(lines, " ", theme.fg("success", "Press Enter to submit"), W);
				} else {
					const missing = questions.filter((qq) => !answers.has(qq.id) && qq.required).map((qq) => qq.header);
					addWrappedWithPrefix(
						lines,
						" ",
						theme.fg("warning", `Unanswered: ${missing.join(", ")}`),
						W,
					);
				}
			} else if (q) {
				addWrappedWithPrefix(lines, " ", theme.fg("text", q.question), W);
				lines.push("");

				// Edit mode for text/number — show editor with prompt
				if ((q.type === "text" || q.type === "number") && (inputMode || answers.has(q.id))) {
					const placeholder = q.placeholder ?? (q.type === "number" ? "0" : "type your answer…");
					addWrappedWithPrefix(lines, " ", theme.fg("muted", `> ${placeholder}`), W);
					if (q.min !== undefined || q.max !== undefined) {
						const range = [q.min, q.max].filter((n) => n !== undefined).join("…");
						addWrappedWithPrefix(lines, " ", theme.fg("dim", `  range: ${range}`), W);
					}
					const rendered = editor.render(Math.max(1, W - 2));
					for (const l of rendered) lines.push(` ${l}`);
					lines.push("");
					if (q.type === "text" && q.multiline) {
						addWrappedWithPrefix(lines, " ", theme.fg("dim", "Enter newline • Tab/←→ next question • Esc cancel"), W);
					} else if (q.type === "number") {
						addWrappedWithPrefix(lines, " ", theme.fg("dim", "↑↓ nudge • Enter confirm • Tab/←→ next • Esc cancel"), W);
					} else {
						addWrappedWithPrefix(lines, " ", theme.fg("dim", "Enter confirm • Tab/←→ next • Esc cancel"), W);
					}
				} else if (q.type === "text" || q.type === "number") {
					// Not yet editing — show editor empty with prompt
					const placeholder = q.placeholder ?? (q.type === "number" ? "0" : "type your answer…");
					addWrappedWithPrefix(lines, " ", theme.fg("muted", `> ${placeholder}`), W);
					editor.setText("");
					inputMode = q.type;
					inputQuestionId = q.id;
				} else {
					// select-type
					const opts =
						q.type === "confirm"
							? confirmOptions().map((o) => ({ ...o, value: o.label, isOther: false }))
							: getRenderOptions(q);
					for (let i = 0; i < opts.length; i++) {
						const opt = opts[i];
						const selected = i === optionIndex;
						const active = opt.isOther === true && inputMode === "other" && inputQuestionId === q.id;
						const isChecked =
							q.type === "multi_select" ? (checked[q.id]?.has(i) ?? false) : undefined;
						renderOptionLine(opt, i, selected, isChecked, active, W, theme, lines);
					}
					if (inputMode === "other" && inputQuestionId === q.id) {
						lines.push("");
						const rendered = editor.render(Math.max(1, W - 2));
						for (const l of rendered) lines.push(` ${l}`);
						lines.push("");
						addWrappedWithPrefix(lines, " ", theme.fg("dim", "Enter submit • Esc back to options"), W);
					} else {
						lines.push("");
						if (q.type === "multi_select") {
							addWrappedWithPrefix(
								lines,
								" ",
								theme.fg(
									"dim",
									"↑↓ navigate • Space toggle • Tab/←→ next question • Enter confirm & next • Esc cancel",
								),
								W,
							);
						} else {
							addWrappedWithPrefix(
								lines,
								" ",
								theme.fg("dim", "↑↓ navigate • Enter select • Tab/←→ next • Esc cancel"),
								W,
							);
						}
					}
				}
			}

			lines.push(theme.fg("accent", "─".repeat(W)));
			cachedLines = lines;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
		};
	};
}
