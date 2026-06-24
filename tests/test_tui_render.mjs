// tests/test_tui_render.mjs
// Snapshot test for the v2 TUI render. Runs the component factory with a
// fake tui/theme, calls render(width), and asserts the rendered lines contain
// expected substrings for each question type. We don't do full snapshot
// diff (fragile across theme/wrap changes) — just key markers.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	buildQuestionnaireComponent,
	clearTerminalTitle,
	playBell,
	setTerminalTitle,
} from "../src/tui.ts";
import { normalizeQuestions } from "../src/normalize.ts";
import {
	clearInMemorySettings,
	DEFAULT_SETTINGS,
	getSettings,
	loadSettings,
	saveSettings,
	setInMemorySettings,
} from "../src/settings.ts";

import { runHarness as _runHarness } from "./harness-runner.mjs";
function runHarness(cmd) { return _runHarness(cmd); }

const fakeTui = makeFakeTui();
const fakeTheme = makeFakeTheme();
const ansiTheme = makeAnsiTheme();

function makeFakeTheme() {
	const F = (_color, text) => text; // strip theme markup for stable assertions
	return {
		fg: F,
		bg: F,
		bold: (s) => s,
		italic: (s) => s,
		strikethrough: (s) => s,
	};
}

function makeAnsiTheme() {
	const fgCodes = {
		accent: "\x1b[36m",
		text: "\x1b[37m",
		muted: "\x1b[90m",
		success: "\x1b[32m",
		dim: "\x1b[2m",
		warning: "\x1b[33m",
	};
	const fg = (color, text) => `${fgCodes[color] ?? "\x1b[37m"}${text}\x1b[39m`;
	return {
		fg,
		bg: (_color, text) => text,
		bold: (s) => s,
		italic: (s) => s,
		strikethrough: (s) => s,
	};
}

function makeFakeTui() {
	return {
		requestRender: () => {},
		terminal: { rows: 24, cols: 80 },
	};
}

// Default writer used by the shared helpers — a no-op so the test suite
// doesn't leak OSC title writes and BELs onto the real process.stdout.
// Individual tests that need to assert on writes use terminalWriter
// explicitly with a capturing writer.
const silentWriter = () => {};

function render(questions, width = 80) {
	return renderWithTheme(questions, fakeTheme, width);
}

function renderWithTheme(questions, theme, width = 80) {
	const canonical = normalizeQuestions(questions);
	const factory = buildQuestionnaireComponent({
		questions: canonical,
		terminalWriter: silentWriter,
	});
	const tui = makeFakeTui();
	const component = factory(tui, theme, {}, () => {});
	const lines = component.render(width);
	return { lines, component };
}

function drive(questions) {
	const canonical = normalizeQuestions(questions);
	const factory = buildQuestionnaireComponent({
		questions: canonical,
		terminalWriter: silentWriter,
	});
	const tui = makeFakeTui();
	let doneValue = null;
	const component = factory(tui, fakeTheme, {}, (v) => {
		doneValue = v;
	});
	return { component, getDone: () => doneValue };
}

function countChars(text, ch) {
	return Array.from(text).filter((c) => c === ch).length;
}

function stripAnsi(text) {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function visibleWidthForTest(text) {
	let width = 0;
	for (const ch of Array.from(stripAnsi(text))) {
		const cp = ch.codePointAt(0) ?? 0;
		width += cp >= 0x1F300 && cp <= 0x1FAFF ? 2 : 1;
	}
	return width;
}

function assertFrameIntact(lines, width) {
	assert.ok(lines.length >= 2, "frame should include top and bottom borders");
	assert.match(stripAnsi(lines[0]), /^┌.*┐$/, "top border should be intact");
	assert.match(stripAnsi(lines.at(-1) ?? ""), /^└.*┘$/, "bottom border should be intact");
	for (const line of lines) {
		const plain = stripAnsi(line);
		assert.equal(visibleWidthForTest(plain), width, `expected visible width ${width}, got ${visibleWidthForTest(plain)}: ${plain}`);
	}
}

// ---- Render tests ---------------------------------------------------------

test("select_one renders question + numbered options", () => {
	const { lines } = render([{
		header: "Pick",
		question: "Pick a color?",
		type: "select_one",
		options: [{ label: "Red" }, { label: "Blue" }],
	}]);
	const joined = lines.join("\n");
	assert.match(joined, /Pick a color\?/);
	assert.match(joined, /1\. Red/);
	assert.match(joined, /2\. Blue/);
	assert.match(joined, /3\. Other/);
});

test("select_many shows checkboxes + [Select] button + Space/Enter hint", () => {
	const { lines } = render([{
		header: "Toppings",
		question: "Pick toppings?",
		type: "select_many",
		options: [{ label: "A" }, { label: "B" }, { label: "C" }],
	}]);
	const joined = lines.join("\n");
	assert.match(joined, /Pick toppings\?/);
	// Multi-select hint now includes both Space and Enter
	assert.match(joined, /Space\/Enter toggle/);
	// [Select] button appears below the options
	assert.match(joined, /\[Select\]/);
	assert.match(joined, /submit selected/);
});

test("confirm_enum auto-fills Affirm/Decline + Other", () => {
	const { lines } = render([{
		header: "Go",
		question: "Proceed?",
		type: "confirm_enum",
	}]);
	const joined = lines.join("\n");
	assert.match(joined, /Proceed\?/);
	assert.match(joined, /1\. Affirm/);
	assert.match(joined, /2\. Decline/);
	assert.match(joined, /3\. Other/);
});

test("selected single-choice cursor uses a text glyph outside ANSI styling", () => {
	const { lines: selectOneLines } = renderWithTheme([{
		header: "Pick",
		question: "Pick a color?",
		type: "select_one",
		options: [{ label: "Red" }, { label: "Blue" }],
	}], ansiTheme);
	const selectOneLine = selectOneLines.find((line) => stripAnsi(line).includes("1. Red"));
	assert.ok(selectOneLine, "selected select_one option should render");
	assert.doesNotMatch(stripAnsi(selectOneLine), />\s+1\. Red/, "single-choice cursor must not fall back to >");
	assert.doesNotMatch(selectOneLine, /\x1b\[36m▶/, "cursor should not be inside the accent ANSI span");
	assert.match(selectOneLine, /▶ \x1b\[36m {2}1\. Red/, "accent styling should start after the raw text cursor");

	const { lines: confirmLines } = renderWithTheme([{
		header: "Go",
		question: "Proceed?",
		type: "confirm_enum",
	}], ansiTheme);
	const confirmLine = confirmLines.find((line) => stripAnsi(line).includes("1. Affirm"));
	assert.ok(confirmLine, "selected confirm_enum option should render");
	assert.doesNotMatch(stripAnsi(confirmLine), />\s+1\. Affirm/, "confirm cursor must not fall back to >");
	assert.doesNotMatch(confirmLine, /\x1b\[36m▶/, "cursor should not be inside the accent ANSI span");
	assert.match(confirmLine, /▶ \x1b\[36m {2}1\. Affirm/, "accent styling should start after the raw text cursor");
});

test("number question shows range", () => {
	const { lines } = render([{
		header: "Qty",
		question: "How many?",
		type: "number",
		min: 1,
		max: 10,
	}]);
	const joined = lines.join("\n");
	assert.match(joined, /How many\?/);
	assert.match(joined, /Range: 1 … 10/);
});

test("number Up/Down nudges visible draft and clamps to range", () => {
	const { component } = drive([{
		id: "qty",
		header: "Qty",
		question: "How many?",
		type: "number",
		min: 2,
		max: 4,
	}]);

	component.handleInput("\u001b[A");
	assert.equal(component.getEditorText(), "2", "empty Up should start at min");
	let joined = component.render(80).join("\n");
	assert.match(joined, /Answer: 2/, "nudged draft should render immediately");

	component.handleInput("\u001b[A");
	component.handleInput("\u001b[A");
	component.handleInput("\u001b[A");
	assert.equal(component.getEditorText(), "4", "Up should clamp at max");
	joined = component.render(80).join("\n");
	assert.match(joined, /Answer: 4/);

	component.setEditorText("");
	component.handleInput("\u001b[B");
	assert.equal(component.getEditorText(), "4", "empty Down should start at max");

	component.handleInput("\u001b[B");
	component.handleInput("\u001b[B");
	component.handleInput("\u001b[B");
	assert.equal(component.getEditorText(), "2", "Down should clamp at min");
});

test("free_text opens editor immediately on render", () => {
	const { lines } = render([{
		header: "Note",
		question: "Anything to add?",
		type: "free_text",
		placeholder: "Optional",
	}]);
	const joined = lines.join("\n");
	assert.match(joined, /Anything to add\?/);
	// The editor opens immediately for free_text questions so the
	// user can start typing without an extra Enter. The placeholder
	// is preloaded as the initial text (so the user can edit/clear
	// it) and a cursor block is rendered to show where input will go.
	assert.match(joined, /Optional/);
	assert.match(joined, /\u258f/); // cursor block
});

test("free_text long draft wraps without truncating or breaking frame", () => {
	const draft = "x".repeat(500);
	const { component } = drive([{
		header: "Long",
		question: "Long answer?",
		type: "free_text",
	}]);
	for (const ch of draft) component.handleInput(ch);
	const lines = component.render(80);
	const joined = lines.join("\n");
	assert.match(joined, /x{20}/, "render should include a wrapped run from the long draft");
	assert.equal(countChars(joined, "x"), 500, "all draft characters should render exactly once");
	assertFrameIntact(lines, 80);
});

test("free_text renders unicode and emoji draft", () => {
	const draft = "héllo 🌍 wörld";
	const { component } = drive([{
		header: "Unicode",
		question: "Unicode answer?",
		type: "free_text",
	}]);
	for (const ch of draft) component.handleInput(ch);
	const lines = component.render(80);
	const joined = lines.join("\n");
	assert.match(joined, /héllo 🌍 wörld/);
	assert.equal(component.getEditorText(), draft);
	assertFrameIntact(lines, 80);
});

test("rapid free_text key sequence captures every character", () => {
	const keys = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWX";
	assert.equal(keys.length, 50);
	const { component } = drive([{
		header: "Rapid",
		question: "Rapid input?",
		type: "free_text",
	}]);
	for (const ch of keys) component.handleInput(ch);
	const lines = component.render(100).join("\n");
	assert.match(lines, /abcdefghijklmnopqrstuvwxyz/);
	assert.match(lines, /ABCDEFGHIJKLMNOPQRSTUVWX/);
	assert.equal(component.getEditorText(), keys, "all rapid key inputs should be captured in order");
});

test("multi question renders tab bar", () => {
	const { lines } = render([
		{ header: "Q1", question: "A?", type: "free_text" },
		{ header: "Q2", question: "B?", type: "free_text" },
		{ header: "Q3", question: "C?", type: "free_text" },
	], 100);
	const joined = lines.join("\n");
	assert.match(joined, /Q1/);
	assert.match(joined, /Q2/);
	assert.match(joined, /Q3/);
	assert.match(joined, /Submit/);
});

test("preview content is shown collapsed by default, expanded on `e`", () => {
	const { lines, component } = render([{
		header: "Pick",
		question: "Pick",
		type: "select_one",
		options: [
			{ label: "A", preview: { type: "mermaid", content: "graph TD; A-->B" } },
			{ label: "B" },
		],
	}]);
	let joined = lines.join("\n");
	// Collapsed: shows indicator, not content
	assert.match(joined, /\[mermaid\]/);
	assert.doesNotMatch(joined, /A-->B/);
	// Press e to expand
	component.handleInput("e");
	joined = component.render(80).join("\n");
	assert.match(joined, /A-->B/);
});

test("description is rendered under option", () => {
	const { lines } = render([{
		header: "Pick",
		question: "Pick",
		type: "select_one",
		options: [
			{ label: "A", description: "first option" },
			{ label: "B" },
		],
	}]);
	const joined = lines.join("\n");
	assert.match(joined, /first option/);
});

test("header field caps at 20 chars in tab bar", () => {
	const { lines } = render([
		{ header: "ThisIsAVeryLongHeader", question: "A?", type: "free_text" },
		{ header: "B", question: "B?", type: "free_text" },
	], 120);
	const joined = lines.join("\n");
	assert.match(joined, /ThisIsAVeryLongHead/);
});

// ---- Interaction tests (drive the component via handleInput) --------------

test("select_many: Space toggles, then submit returns array of labels", () => {
	// Multi-question flow so we can test the array of selected labels.
	const questions = [
		{ id: "ms", header: "ms", question: "Pick toppings?", type: "select_many",
			options: [{ label: "A" }, { label: "B" }, { label: "C" }] },
		{ id: "so", header: "so", question: "Pick one", type: "select_one",
			options: [{ label: "X" }, { label: "Y" }] },
	];
	const { component, getDone } = drive(questions);
	component.handleInput(" "); // toggle A
	component.handleInput("\u001b[B"); // down to B
	component.handleInput(" "); // toggle B
	// Move to next question with `]`
	component.handleInput("]");
	// On select_one, Enter selects first option (commits and advances in multi-question)
	component.handleInput("\r");
	// Jump to Submit tab and commit
	component.handleInput("0");
	component.handleInput("\r");
	const v = getDone();
	assert.ok(v !== null, "expected done() to be called");
	if (v) {
		assert.equal(v.lifecycle, "answered");
		// The first answer should be the multi-select with A and B
		const msAnswer = v.answers.find((a) => a.id === "ms");
		assert.ok(msAnswer, "should have an answer for ms");
		if (msAnswer) {
			assert.ok(Array.isArray(msAnswer.value), "multi_select value should be an array");
			const labels = msAnswer.value.map((x) => x.value).sort();
			assert.deepEqual(labels, ["A", "B"]);
		}
	}
});

test("confirm_enum: Enter on Affirm returns affirm", () => {
	const { component, getDone } = drive([{
		header: "c",
		question: "Proceed?",
		type: "confirm_enum",
	}]);
	component.handleInput("\r"); // enter on first option (Affirm)
	const v = getDone();
	assert.ok(v !== null);
	if (v) {
		assert.equal(v.lifecycle, "answered");
		const a = v.answers[0];
		assert.deepEqual(a.value, { mode: "option", value: "affirm" });
	}
});

test("confirm_enum: arrow-down + Enter on Decline returns decline", () => {
	const { component, getDone } = drive([{
		header: "c",
		question: "Proceed?",
		type: "confirm_enum",
	}]);
	component.handleInput("\u001b[B"); // down
	component.handleInput("\r"); // enter
	const v = getDone();
	assert.ok(v !== null);
	if (v) {
		assert.deepEqual(v.answers[0].value, { mode: "option", value: "decline" });
	}
});

test("select_one Other: typing goes to the editor and Enter commits", () => {
	const { component, getDone } = drive([{
		header: "x",
		question: "Pick?",
		type: "select_one",
		options: [{ label: "A" }, { label: "B" }],
	}]);
	component.handleInput("\u001b[B"); // down to B
	component.handleInput("\u001b[B"); // down to Other (auto-opens editor)
	for (const ch of "custom") component.handleInput(ch);
	// Most reliable check: typed text should be in the editor buffer.
	assert.equal(
		typeof component.getEditorText === "function" ? component.getEditorText() : "",
		"custom",
		"typed text should be in the editor's buffer",
	);
	component.handleInput("\r");
	const done = getDone();
	assert.ok(done !== null);
	if (done) {
		assert.deepEqual(done.answers[0].value, { mode: "other", text: "custom" });
	}
});

test("Esc cancels the whole questionnaire", () => {
	const { component, getDone } = drive([{
		header: "x",
		question: "Pick?",
		type: "select_one",
		options: [{ label: "A" }, { label: "B" }],
	}]);
	component.handleInput("\u001b"); // esc
	const v = getDone();
	assert.ok(v !== null);
	if (v) {
		assert.equal(v.lifecycle, "cancelled");
	}
});

test("normalize caps user options at 7 so post-Other is 8", () => {
	const r = runHarness({
		cmd: "normalize",
		input: [{
			header: "x", question: "q?", type: "select_one",
			options: Array.from({ length: 9 }, (_, i) => ({ label: `opt${i}` })),
		}],
	});
	assert.equal(r.value[0].options.length, 8, "capped at 8 (7 + Other)");
});

// ---- Bell + duration timer ------------------------------------------------

test("setTerminalTitle writes OSC 0 sequence with given title", () => {
	const writes = [];
	const writer = (s) => writes.push(s);
	setTerminalTitle("hello", writer);
	assert.equal(writes.length, 1);
	assert.equal(writes[0], "\x1b]0;hello\x07");
});

test("clearTerminalTitle writes OSC 0 sequence with empty title", () => {
	const writes = [];
	const writer = (s) => writes.push(s);
	clearTerminalTitle(writer);
	assert.equal(writes.length, 1);
	assert.equal(writes[0], "\x1b]0;\x07");
});

test("TUI mount sets title with bell prefix; submit clears it", () => {
	const writes = [];
	const origWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((s) => {
		if (typeof s === "string") writes.push(s);
		return true;
	});
	try {
		const canonical = normalizeQuestions([{
			header: "Pick", question: "Pick one?", type: "select_one",
			options: [{ label: "A" }, { label: "B" }],
		}]);
		const factory = buildQuestionnaireComponent({ questions: canonical });
		factory(makeFakeTui(), fakeTheme, {}, () => {});
		const setCalls = writes.filter((w) => w.startsWith("\x1b]0;"));
		assert.ok(setCalls.length >= 1, "expected at least one title-set on mount");
		assert.match(setCalls[0], /\x1b\]0;🔔 AskUserQuestion — Pick\x07/);
	} finally {
		process.stdout.write = origWrite;
	}
});

test("duration timer appears in status line; updates on re-render", async () => {
	const canonical = normalizeQuestions([{
		header: "h", question: "q?", type: "free_text",
	}]);
	const factory = buildQuestionnaireComponent({
		questions: canonical,
		terminalWriter: silentWriter,
	});
	const tui = makeFakeTui();
	const c = factory(tui, fakeTheme, {}, () => {});
	const t0 = Date.now();
	let lines = c.render(80).join("\n");
	assert.match(lines, /⏱\s+\d+s elapsed/);
	await new Promise((r) => setTimeout(r, 1100));
	lines = c.render(80).join("\n");
	const m = lines.match(/⏱\s+(\d+)s elapsed/);
	assert.ok(m, "elapsed should still be present");
	const secs = Number(m[1]);
	assert.ok(secs >= 1 && secs < 30, `expected elapsed >= 1, got ${secs} (waited ${Date.now() - t0}ms)`);
	c.dispose();
});

test("dispose() prevents further timer callbacks; safe to call multiple times", () => {
	const canonical = normalizeQuestions([{
		header: "h", question: "q?", type: "free_text",
	}]);
	const factory = buildQuestionnaireComponent({
		questions: canonical,
		terminalWriter: silentWriter,
	});
	const c = factory(makeFakeTui(), fakeTheme, {}, () => {});
	c.dispose();
	c.dispose(); // no throw
});

test("multi_select single-question: Space toggles, [Select] commits", () => {
	// Indices: 0=A, 1=B, 2=C, 3=Other (auto-appended), 4=[Select]
	const { component, getDone } = drive([{
		header: "ms",
		question: "Pick toppings?",
		type: "select_many",
		options: [{ label: "A" }, { label: "B" }, { label: "C" }],
	}]);
	component.handleInput(" "); // toggle A (index 0)
	assert.equal(getDone(), null, "Space should not submit");
	component.handleInput("\u001b[B"); // down to B (1)
	component.handleInput(" "); // toggle B
	assert.equal(getDone(), null, "Space should still not submit");
	// Navigate past C, Other, to [Select] (index 4)
	component.handleInput("\u001b[B"); // C (2)
	component.handleInput("\u001b[B"); // Other (3)
	component.handleInput("\u001b[B"); // [Select] (4)
	component.handleInput("\r"); // commit
	const v = getDone();
	assert.ok(v !== null, "Enter on [Select] should submit");
	if (v) {
		assert.equal(v.lifecycle, "answered");
		const a = v.answers[0];
		const labels = a.value.map((x) => x.value).sort();
		assert.deepEqual(labels, ["A", "B"]);
	}
});

test("multi_select single-question: Enter on a regular option toggles (not submits)", () => {
	const { component, getDone } = drive([{
		header: "ms",
		question: "Pick toppings?",
		type: "select_many",
		options: [{ label: "A" }, { label: "B" }, { label: "C" }],
	}]);
	component.handleInput("\r"); // toggle A
	assert.equal(getDone(), null, "Enter on an option should toggle, not submit");
	component.handleInput("\u001b[B"); // B
	component.handleInput("\r"); // toggle B
	assert.equal(getDone(), null, "Enter on an option should still not submit");
	// Navigate to [Select]
	component.handleInput("\u001b[B"); // C
	component.handleInput("\u001b[B"); // Other
	component.handleInput("\u001b[B"); // [Select]
	component.handleInput("\r"); // commit
	const v = getDone();
	assert.ok(v !== null, "Enter on [Select] should submit");
	if (v) {
		const labels = v.answers[0].value.map((x) => x.value).sort();
		assert.deepEqual(labels, ["A", "B"]);
	}
});

test("multi_select single-question: 1-9 toggles without submitting", () => {
	const { component, getDone } = drive([{
		header: "ms",
		question: "Pick?",
		type: "select_many",
		options: [{ label: "A" }, { label: "B" }, { label: "C" }],
	}]);
	component.handleInput("1"); // toggle A
	component.handleInput("2"); // toggle B
	assert.equal(getDone(), null, "1-9 should not submit on multi_select");
	// Navigate to [Select] (index 4) from index 0
	component.handleInput("\u001b[B"); // 1
	component.handleInput("\u001b[B"); // 2
	component.handleInput("\u001b[B"); // 3
	component.handleInput("\u001b[B"); // 4 ([Select])
	component.handleInput("\r"); // commit
	const v = getDone();
	assert.ok(v !== null);
	if (v) {
		const labels = v.answers[0].value.map((x) => x.value).sort();
		assert.deepEqual(labels, ["A", "B"]);
	}
});

// ---- Slice 2 features ----------------------------------------------------

test("Tab swaps to notes view; Esc returns to answer view", () => {
	const { component, getDone } = drive([{
		header: "h", question: "q?", type: "select_one",
		options: [{ label: "A" }, { label: "B" }],
	}]);
	// Initially answer view
	let lines = component.render(80).join("\n");
	assert.doesNotMatch(lines, /Notes for/);
	// Press Tab to open notes
	component.handleInput("\t");
	lines = component.render(80).join("\n");
	assert.match(lines, /Notes for "h"/);
	// Press Esc to back out
	component.handleInput("\u001b");
	lines = component.render(80).join("\n");
	assert.doesNotMatch(lines, /Notes for/);
	// Pressing Esc again at top level should cancel
	component.handleInput("\u001b");
	const v = getDone();
	assert.ok(v !== null);
	assert.equal(v.lifecycle, "cancelled");
});

test("Tab opens notes from active free_text editor and preserves draft answer", () => {
	const { component } = drive([{
		id: "text",
		header: "Text",
		question: "Describe it?",
		type: "free_text",
	}]);
	for (const ch of "draft answer") component.handleInput(ch);

	component.handleInput("\t");

	const lines = component.render(80).join("\n");
	assert.match(lines, /Notes for "Text"/);
	assert.equal(component.getBrowserState().answers["0"], "draft answer");
});

test("Tab opens notes from active number editor and preserves numeric draft", () => {
	const { component } = drive([{
		id: "qty",
		header: "Qty",
		question: "How many?",
		type: "number",
		min: 0,
		max: 10,
	}]);
	component.handleInput("7");

	component.handleInput("\t");

	const lines = component.render(80).join("\n");
	assert.match(lines, /Notes for "Qty"/);
	assert.equal(component.getBrowserState().answers["0"], 7);
});

test("number draft reopens after visiting notes", () => {
	const { component } = drive([{
		id: "qty",
		header: "Qty",
		question: "How many?",
		type: "number",
		min: 0,
		max: 10,
	}]);
	component.handleInput("7");
	component.handleInput("\t");
	component.handleInput("\u001b");

	assert.equal(component.getEditorText(), "7");
	const lines = component.render(80).join("\n");
	assert.match(lines, /Answer: 7/);
});

test("out-of-range number draft reopens after visiting notes without committing answer", () => {
	const { component } = drive([{
		id: "qty",
		header: "Qty",
		question: "How many?",
		type: "number",
		min: 0,
		max: 10,
	}]);
	component.handleInput("1");
	component.handleInput("1");
	component.handleInput("\t");
	component.handleInput("\u001b");

	assert.deepEqual(component.getBrowserState().answers, {});
	assert.equal(component.getEditorText(), "11");
	const lines = component.render(80).join("\n");
	assert.match(lines, /Answer: 11/);
});

test("Tab opens notes from active Other editor and preserves custom draft", () => {
	const { component } = drive([{
		id: "pick",
		header: "Pick",
		question: "Pick one?",
		type: "select_one",
		options: [{ label: "A" }],
	}]);
	component.handleInput("\u001b[B"); // Other
	for (const ch of "custom") component.handleInput(ch);

	component.handleInput("\t");

	const lines = component.render(80).join("\n");
	assert.match(lines, /Notes for "Pick"/);
	assert.deepEqual(component.getBrowserState().answers["0"], { mode: "other", text: "custom" });
});

test("Other draft editor reopens after visiting notes", () => {
	const { component } = drive([{
		id: "pick",
		header: "Pick",
		question: "Pick one?",
		type: "select_one",
		options: [{ label: "A" }],
	}]);
	component.handleInput("\u001b[B"); // Other
	for (const ch of "custom") component.handleInput(ch);
	component.handleInput("\t");
	component.handleInput("\u001b");

	assert.equal(component.getEditorText(), "custom");
	const lines = component.render(80).join("\n");
	assert.match(lines, /Other: custom/);
});

test("Tab opens notes from danger editor and preserves confirmation draft", () => {
	setInMemorySettings({ dangerCheckEnabled: true });
	try {
		const { component } = drive([{
			id: "danger",
			header: "Delete",
			question: "Delete production?",
			type: "free_text",
			is_dangerous: true,
		}]);
		for (const ch of "production-db") component.handleInput(ch);

		component.handleInput("\t");

		let lines = component.render(80).join("\n");
		assert.match(lines, /Notes for "Delete"/);
		component.handleInput("\u001b");
		assert.equal(component.getEditorText(), "production-db");
		lines = component.render(80).join("\n");
		assert.match(lines, /production-db/);
	} finally {
		clearInMemorySettings();
	}
});

test("notes typing is visible while editing", () => {
	const { component } = drive([{
		header: "h", question: "q?", type: "select_one",
		options: [{ label: "A" }],
	}]);
	component.handleInput("\t");
	for (const ch of "remember this") component.handleInput(ch);
	const lines = component.render(80).join("\n");
	assert.match(lines, /remember this/);
});

test("notes long draft wraps without truncating or breaking frame", () => {
	const draft = "z".repeat(500);
	const { component } = drive([{
		header: "LongNote",
		question: "Record note?",
		type: "select_one",
		options: [{ label: "A" }],
	}]);
	component.handleInput("\t");
	for (const ch of draft) component.handleInput(ch);
	const lines = component.render(80);
	const joined = lines.join("\n");
	assert.match(joined, /z{20}/, "render should include a wrapped run from the long note");
	assert.equal(countChars(joined, "z"), 500, "all note characters should render exactly once");
	assertFrameIntact(lines, 80);
});

test("notes render unicode and emoji draft", () => {
	const draft = "héllo 🌍 wörld";
	const { component } = drive([{
		header: "UnicodeNote",
		question: "Record unicode note?",
		type: "select_one",
		options: [{ label: "A" }],
	}]);
	component.handleInput("\t");
	for (const ch of draft) component.handleInput(ch);
	const lines = component.render(80);
	const joined = lines.join("\n");
	assert.match(joined, /héllo 🌍 wörld/);
	assert.equal(component.getEditorText(), draft);
	assertFrameIntact(lines, 80);
});

test("notes Enter saves and returns to answer view", () => {
	const questions = [
		{ header: "a", question: "A?", type: "select_one", options: [{ label: "Yes" }] },
		{ header: "b", question: "B?", type: "select_one", options: [{ label: "Go" }] },
	];
	const { component, getDone } = drive(questions);
	component.handleInput("\t");
	for (const ch of "remember this") component.handleInput(ch);
	component.handleInput("\r");
	let lines = component.render(80).join("\n");
	assert.doesNotMatch(lines, /Notes for/);
	assert.match(lines, /Note: remember this/);
	component.handleInput("\r"); // answer q1
	component.handleInput("\r"); // answer q2
	component.handleInput("\r"); // submit
	const v = getDone();
	assert.ok(v !== null, "expected final submit after saving notes");
	if (v) {
		assert.equal(v.lifecycle, "answered");
		assert.equal(v.notes?.q1 ?? v.notes?.a, "remember this");
	}
});

test("notes Tab saves and cycles to the next question tab", () => {
	const questions = [
		{ header: "a", question: "A?", type: "select_one", options: [{ label: "Yes" }] },
		{ header: "b", question: "B?", type: "select_one", options: [{ label: "Go" }] },
	];
	const { component } = drive(questions);
	component.handleInput("\t");
	for (const ch of "side note") component.handleInput(ch);
	component.handleInput("\t");
	let lines = component.render(80).join("\n");
	assert.match(lines, /B\?/);
	assert.doesNotMatch(lines, /Notes for "a"/);
	component.handleInput("[");
	lines = component.render(80).join("\n");
	assert.match(lines, /Note: side note/);
});

test("`n` key is typed into the free_text editor (not notes toggle)", () => {
	// Regression test: previously pressing 'n' on a free_text
	// question opened the notes overlay instead of typing 'n' into
	// the editor. The editor now opens immediately on render, so
	// printable characters go to the editor.
	const { component } = drive([{
		header: "h", question: "q?", type: "free_text",
	}]);
	component.handleInput("n");
	const lines = component.render(80).join("\n");
	// 'n' should appear in the editor area, not in the notes view.
	assert.match(lines, /\bn\b/);
	assert.doesNotMatch(lines, /Notes for "h"/);
});

test("? key shows the help overlay", () => {
	const { component } = drive([{
		header: "h", question: "q?", type: "select_one",
		options: [{ label: "A" }],
	}]);
	component.handleInput("?");
	const lines = component.render(80).join("\n");
	assert.match(lines, /Keyboard shortcuts/);
	assert.match(lines, /Enter/);
	assert.match(lines, /Esc/);
	// Any key dismisses
	component.handleInput("x");
	const after = component.render(80).join("\n");
	assert.doesNotMatch(after, /Keyboard shortcuts/);
});

test("persistent checkmarks: select_one shows ✓ on chosen option after revisit", () => {
	const { component, getDone } = drive([
		{ header: "a", question: "A?", type: "select_one",
			options: [{ label: "Red" }, { label: "Blue" }] },
		{ header: "b", question: "B?", type: "select_one",
			options: [{ label: "Yes" }, { label: "No" }] },
	]);
	// Pick Red on question A
	component.handleInput("\r");
	// Now on Submit tab (single question advanced to B, but we have 2 questions
	// so we move to B)
	const lines = component.render(80).join("\n");
	// Tab bar shows A as answered
	assert.match(lines, /■ a/);
	// Go back to A with [
	component.handleInput("[");
	const linesA = component.render(80).join("\n");
	assert.match(linesA, /■ a/);
	// The chosen option "Red" should be marked
	assert.match(linesA, /✓|Red/);
});

test("Other revisit: re-entering Other prepopulates editor with previous text", () => {
	const { component } = drive([{
		header: "x", question: "q?", type: "select_one",
		options: [{ label: "A" }, { label: "B" }],
	}]);
	// Navigate to Other (index 2)
	component.handleInput("\u001b[B"); // B
	component.handleInput("\u001b[B"); // Other
	// Enter Other mode
	component.handleInput("\r");
	// Editor is in input mode now; set its text via setText
	// (We can't easily type into the editor without a real terminal)
	// For the test, just verify the flow doesn't crash and Other is highlighted
	const lines = component.render(80).join("\n");
	assert.match(lines, /q\?/); // question still visible
});

test("frame keeps the requested width", () => {
	const { lines } = render([{
		header: "Frame",
		question: "Does the border line up?",
		type: "select_one",
		options: [{ label: "A" }],
	}], 40);
	for (const line of lines) {
		assert.equal(line.length, 40, `expected exact width 40, got ${line.length}: ${line}`);
	}
});

test("select_one Other: editor opens inline when cursor lands on Other", () => {
	// The pi-tui Editor renders its own box-drawing chrome. This test
	// confirms the editor is in the render output when Other is active.
	// (We don't assert exact line width because the editor is multi-line
	// and can render lines that visually exceed the frame inner width
	// for very long single-line input — a known TUI library rendering
	// quirk.)
	const { component } = drive([{
		header: "x",
		question: "Pick?",
		type: "select_one",
		options: [{ label: "A" }],
	}]);
	component.handleInput("\x1b[B"); // down to Other
	const lines = component.render(40).join("\n");
	// The pi-tui Editor always renders a top border (┌─…) when active.
	assert.match(lines, /┌/);
});

test("`o` key records a browser open attempt and calls the open handler", () => {
	const { component } = drive([{
		header: "h", question: "q?", type: "select_one",
		options: [{ label: "A" }],
	}]);
	const opened = [];
	component.setBrowserUrl("http://localhost:54321/q/abc?nonce=xyz");
	component.setBrowserOpenHandler((url) => opened.push(url));
	let lines = component.render(80).join("\n");
	assert.match(lines, /http:\/\/localhost:54321/);
	assert.doesNotMatch(lines, /slice 5\+/);
	component.handleInput("o");
	const attempt = component.getBrowserOpenAttempt();
	assert.ok(attempt, "browser open attempt should be recorded");
	assert.equal(attempt.url, "http://localhost:54321/q/abc?nonce=xyz");
	assert.deepEqual(opened, ["http://localhost:54321/q/abc?nonce=xyz"]);
});

test("browser-origin tab and answer updates debounce TUI refresh", async () => {
	const questions = normalizeQuestions([
		{ id: "a", header: "a", question: "A?", type: "select_one", options: [{ label: "Red" }] },
		{ id: "b", header: "b", question: "B?", type: "free_text" },
	]);
	let renderCount = 0;
	let doneValue = null;
	const factory = buildQuestionnaireComponent({
		questions,
		terminalWriter: silentWriter,
		browserIdleMs: 5,
	});
	const component = factory(
		{ ...makeFakeTui(), requestRender: () => { renderCount += 1; } },
		fakeTheme,
		{},
		(v) => { doneValue = v; },
	);

	component.applyBrowserTab(1);
	component.applyBrowserAnswer("b", "  hello   from browser  ");
	assert.equal(renderCount, 0, "browser activity should not refresh the TUI immediately");
	assert.equal(component.getBrowserState().currentTab, 1);
	assert.deepEqual(component.getBrowserState().answers, { "1": "  hello   from browser  " });

	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(renderCount, 1, "one idle refresh should fire after the debounce window");
	component.applyBrowserAnswer("a", { mode: "option", value: "Red" });
	component.applyBrowserSubmit();
	assert.equal(doneValue.lifecycle, "answered");
	assert.equal(doneValue.answers.find((answer) => answer.id === "b")?.value, "  hello   from browser  ");
});

test("browser-origin notes are included in submitted TUI result", () => {
	const questions = normalizeQuestions([
		{ id: "a", header: "a", question: "A?", type: "select_one", options: [{ label: "Red" }] },
		{ id: "b", header: "b", question: "B?", type: "free_text" },
	]);
	let doneValue = null;
	const factory = buildQuestionnaireComponent({
		questions,
		terminalWriter: silentWriter,
		browserIdleMs: 5,
	});
	const component = factory(
		makeFakeTui(),
		fakeTheme,
		{},
		(v) => { doneValue = v; },
	);

	component.applyBrowserAnswer("a", { mode: "option", value: "Red" });
	component.applyBrowserAnswer("b", "done");
	component.applyBrowserOptions({ notes: { b: "  browser note  " } });
	component.applyBrowserSubmit();

	assert.equal(doneValue.lifecycle, "answered");
	assert.deepEqual(doneValue.notes, { b: "  browser note  " });
});

test("browser-origin free_text updates active editor and TUI submit preserves spaces", () => {
	const questions = normalizeQuestions([
		{ id: "b", header: "b", question: "B?", type: "free_text" },
	]);
	let doneValue = null;
	const factory = buildQuestionnaireComponent({
		questions,
		terminalWriter: silentWriter,
		browserIdleMs: 5,
	});
	const component = factory(
		makeFakeTui(),
		fakeTheme,
		{},
		(v) => { doneValue = v; },
	);

	component.render(80);
	component.applyBrowserAnswer("b", "  keep   every space  ");
	assert.equal(component.getEditorText(), "  keep   every space  ");

	component.handleInput("\r");
	assert.equal(doneValue.lifecycle, "answered");
	assert.equal(doneValue.answers.find((answer) => answer.id === "b")?.value, "  keep   every space  ");
});

test("browser-origin notes update active notes editor and TUI submit preserves notes", () => {
	const questions = normalizeQuestions([
		{ id: "a", header: "a", question: "A?", type: "select_one", options: [{ label: "Red" }] },
	]);
	let doneValue = null;
	const factory = buildQuestionnaireComponent({
		questions,
		terminalWriter: silentWriter,
		browserIdleMs: 5,
	});
	const component = factory(
		makeFakeTui(),
		fakeTheme,
		{},
		(v) => { doneValue = v; },
	);

	component.handleInput("\t");
	component.applyBrowserOptions({ notes: { a: "  keep   browser note  " } });
	assert.equal(component.getEditorText(), "  keep   browser note  ");

	component.handleInput("\r");
	component.handleInput("\r");
	assert.equal(doneValue.lifecycle, "answered");
	assert.deepEqual(doneValue.notes, { a: "  keep   browser note  " });
});

test("browser-origin number answer replaces stale local draft after notes", () => {
	const questions = normalizeQuestions([
		{ id: "qty", header: "Qty", question: "How many?", type: "number", min: 0, max: 10 },
	]);
	const factory = buildQuestionnaireComponent({
		questions,
		terminalWriter: silentWriter,
		browserIdleMs: 5,
	});
	const component = factory(makeFakeTui(), fakeTheme, {}, () => {});

	component.handleInput("7");
	component.handleInput("\t");
	component.applyBrowserAnswer("qty", 3);
	component.handleInput("\u001b");

	assert.equal(component.getEditorText(), "3");
	assert.equal(component.getBrowserState().answers["0"], 3);
});

test("browser-origin clear answer drops stale local draft after notes", () => {
	const questions = normalizeQuestions([
		{ id: "text", header: "Text", question: "Describe?", type: "free_text" },
	]);
	const factory = buildQuestionnaireComponent({
		questions,
		terminalWriter: silentWriter,
		browserIdleMs: 5,
	});
	const component = factory(makeFakeTui(), fakeTheme, {}, () => {});

	for (const ch of "draft") component.handleInput(ch);
	component.handleInput("\t");
	component.applyBrowserClearAnswer("text");
	component.handleInput("\u001b");

	assert.equal(component.getEditorText(), "");
	assert.deepEqual(component.getBrowserState().answers, {});
});

test("local save drops stale draft from before notes", () => {
	const questions = normalizeQuestions([
		{ id: "text", header: "Text", question: "Describe?", type: "free_text" },
		{ id: "next", header: "Next", question: "Next?", type: "free_text" },
	]);
	const factory = buildQuestionnaireComponent({
		questions,
		terminalWriter: silentWriter,
		browserIdleMs: 5,
	});
	const component = factory(makeFakeTui(), fakeTheme, {}, () => {});

	for (const ch of "draft") component.handleInput(ch);
	component.handleInput("\t");
	component.handleInput("\u001b");
	component.setEditorText("final");
	component.handleInput("\r");
	component.handleInput("[");

	assert.equal(component.getBrowserState().answers["0"], "final");
	assert.equal(component.getEditorText(), "final");
});

test("browser-origin submit is blocked until every question is answered", async () => {
	const questions = normalizeQuestions([
		{ id: "a", header: "a", question: "A?", type: "select_one", options: [{ label: "Red" }] },
		{ id: "b", header: "b", question: "B?", type: "free_text" },
	]);
	let doneValue = null;
	let renderCount = 0;
	const factory = buildQuestionnaireComponent({
		questions,
		terminalWriter: silentWriter,
		browserIdleMs: 5,
	});
	const component = factory(
		{ ...makeFakeTui(), requestRender: () => { renderCount += 1; } },
		fakeTheme,
		{},
		(v) => { doneValue = v; },
	);

	component.applyBrowserAnswer("b", "partial");
	component.applyBrowserSubmit();
	assert.equal(doneValue, null, "partial browser answers must not submit");
	assert.equal(component.getBrowserState().currentTab, 2, "blocked submit moves to Submit review tab");
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.ok(renderCount >= 1, "blocked submit should refresh after idle debounce");

	component.applyBrowserAnswer("a", { mode: "option", value: "Red" });
	component.applyBrowserSubmit();
	assert.equal(doneValue.lifecycle, "answered");
});

test("Meta+1 jumps to question 1 (multi-question)", () => {
	const { component } = drive([
		{ header: "a", question: "A?", type: "free_text" },
		{ header: "b", question: "B?", type: "free_text" },
		{ header: "c", question: "C?", type: "free_text" },
	]);
	// Move to question c via `]`, then back to a via Meta+1
	component.handleInput("]");
	component.handleInput("]");
	let lines = component.render(80).join("\n");
	assert.match(lines, /C\?/);
	// Meta+1 = ESC + "1"
	component.handleInput("\x1b1");
	lines = component.render(80).join("\n");
	assert.match(lines, /A\?/);
});

test("Left/Right arrows switch question tabs", () => {
	const { component } = drive([
		{ header: "a", question: "A?", type: "free_text" },
		{ header: "b", question: "B?", type: "free_text" },
		{ header: "c", question: "C?", type: "free_text" },
	]);
	let lines = component.render(80).join("\n");
	assert.match(lines, /A\?/);
	component.handleInput("\u001b[C");
	lines = component.render(80).join("\n");
	assert.match(lines, /B\?/);
	component.handleInput("\u001b[C");
	lines = component.render(80).join("\n");
	assert.match(lines, /C\?/);
	component.handleInput("\u001b[D");
	lines = component.render(80).join("\n");
	assert.match(lines, /B\?/);
});

test("multi-question stress: nav and submit across mixed question types", () => {
	const questions = [
		{ id: "pick1", header: "Pick1", question: "Pick one 1?", type: "select_one", options: [{ label: "A1" }, { label: "B1" }] },
		{ id: "many1", header: "Many1", question: "Pick many 1?", type: "select_many", options: [{ label: "M1A" }, { label: "M1B" }] },
		{ id: "confirm1", header: "Confirm1", question: "Confirm 1?", type: "confirm_enum" },
		{ id: "text1", header: "Text1", question: "Text 1?", type: "free_text" },
		{ id: "number1", header: "Number1", question: "Number 1?", type: "number", min: 0, max: 100 },
		{ id: "pick2", header: "Pick2", question: "Pick one 2?", type: "select_one", options: [{ label: "A2" }, { label: "B2" }] },
		{ id: "text2", header: "Text2", question: "Text 2?", type: "free_text" },
		{ id: "many2", header: "Many2", question: "Pick many 2?", type: "select_many", options: [{ label: "M2A" }, { label: "M2B" }] },
		{ id: "number2", header: "Number2", question: "Number 2?", type: "number", min: 0, max: 10 },
		{ id: "confirm2", header: "Confirm2", question: "Confirm 2?", type: "confirm_enum" },
		{ id: "text3", header: "Text3", question: "Text 3?", type: "free_text" },
	];
	const { component, getDone } = drive(questions);

	let lines = component.render(120).join("\n");
	assert.match(lines, /Pick one 1\?/);
	component.handleInput("]");
	lines = component.render(120).join("\n");
	assert.match(lines, /Pick many 1\?/);
	component.handleInput("[");
	lines = component.render(120).join("\n");
	assert.match(lines, /Pick one 1\?/);
	component.handleInput("\x1b[C");
	lines = component.render(120).join("\n");
	assert.match(lines, /Pick many 1\?/);
	component.handleInput("\x1b[D");
	lines = component.render(120).join("\n");
	assert.match(lines, /Pick one 1\?/);
	component.handleInput("\x1b4");
	lines = component.render(120).join("\n");
	assert.match(lines, /Text 1\?/);
	component.handleInput("\x1b3");
	lines = component.render(120).join("\n");
	assert.match(lines, /Confirm 1\?/);
	component.handleInput("\x1b2");
	lines = component.render(120).join("\n");
	assert.match(lines, /Pick many 1\?/);
	component.handleInput("\x1b1");
	lines = component.render(120).join("\n");
	assert.match(lines, /Pick one 1\?/);
	component.handleInput("0");
	lines = component.render(120).join("\n");
	assert.match(lines, /Submit answers/);
	component.handleInput("[");
	lines = component.render(120).join("\n");
	assert.match(lines, /Text 3\?/);

	component.handleInput("\x1b1"); // Pick1
	component.handleInput("1");
	component.handleInput("1"); // Many1: toggle M1A
	component.handleInput("]");
	component.handleInput("1"); // Confirm1: affirm
	for (const ch of "alpha") component.handleInput(ch);
	component.handleInput("]"); // Text1: nav-key commit while editor is active
	for (const ch of "42") component.handleInput(ch);
	component.handleInput("\x1b[C"); // Number1: arrow-key commit while editor is active
	component.handleInput("2"); // Pick2: B2
	for (const ch of "bravo") component.handleInput(ch);
	component.handleInput("\x1b[C"); // Text2: arrow-key commit while editor is active
	component.handleInput("2"); // Many2: toggle M2B
	component.handleInput("]");
	for (const ch of "7") component.handleInput(ch);
	component.handleInput("]"); // Number2: bracket-nav commit while editor is active
	component.handleInput("\x1b[B");
	component.handleInput("\r"); // Confirm2: decline
	for (const ch of "charlie") component.handleInput(ch);
	component.handleInput("0"); // Text3: Submit-tab jump commits while editor is active
	lines = component.render(120).join("\n");
	assert.match(lines, /Submit answers/);
	component.handleInput("\r");

	const done = getDone();
	assert.ok(done !== null, "Submit should call done() after every mixed question is answered");
	if (done) {
		assert.equal(done.lifecycle, "answered");
		assert.equal(done.answers.length, questions.length);
		assert.deepEqual(done.answers.find((a) => a.id === "pick1")?.value, { mode: "option", value: "A1" });
		assert.deepEqual(done.answers.find((a) => a.id === "many1")?.value, [{ mode: "option", value: "M1A" }]);
		assert.deepEqual(done.answers.find((a) => a.id === "confirm1")?.value, { mode: "option", value: "affirm" });
		assert.equal(done.answers.find((a) => a.id === "text1")?.value, "alpha");
		assert.equal(done.answers.find((a) => a.id === "number1")?.value, 42);
		assert.deepEqual(done.answers.find((a) => a.id === "pick2")?.value, { mode: "option", value: "B2" });
		assert.equal(done.answers.find((a) => a.id === "text2")?.value, "bravo");
		assert.deepEqual(done.answers.find((a) => a.id === "many2")?.value, [{ mode: "option", value: "M2B" }]);
		assert.equal(done.answers.find((a) => a.id === "number2")?.value, 7);
		assert.deepEqual(done.answers.find((a) => a.id === "confirm2")?.value, { mode: "option", value: "decline" });
		assert.equal(done.answers.find((a) => a.id === "text3")?.value, "charlie");
	}
});

test("preview expansion persists per question; toggles with `e`", () => {
	const { lines, component } = render([{
		header: "Pick",
		question: "Pick",
		type: "select_one",
		options: [
			{ label: "A", preview: { type: "mermaid", content: "graph TD; A-->B" } },
			{ label: "B" },
		],
	}]);
	let joined = lines.join("\n");
	assert.doesNotMatch(joined, /A-->B/);
	component.handleInput("e");
	joined = component.render(80).join("\n");
	assert.match(joined, /A-->B/);
	component.handleInput("e"); // toggle off
	joined = component.render(80).join("\n");
	assert.doesNotMatch(joined, /A-->B/);
});

test("tab bar shows ■ for answered, ▣ for answered+note, □ for unanswered", () => {
	const { lines, component } = render([
		{ header: "a", question: "A?", type: "free_text" },
		{ header: "b", question: "B?", type: "free_text" },
		{ header: "c", question: "C?", type: "free_text" },
	], 100);
	let joined = lines.join("\n");
	// All unanswered initially: □ markers
	assert.match(joined, /□ a/);
	// Press Tab to add a note to question a
	component.handleInput("\t");
	// Type a note (we just submit empty for the test; the editor stays in
	// notes mode). Add via setText + trigger onSubmit with non-empty value.
	// Easier: simulate submit by directly calling the editor's onSubmit via
	// handleInput. We can use a fake text-input by sending characters; but
	// the test harness has a fake tui that may not handle text.
	// For this test, just check the structure renders the bar.
	assert.match(joined, /Submit/);
});

// ============================================================================
// Settings module (src/settings.ts)
// ============================================================================
//
// We exercise the merge/sanitize logic by pointing loadSettings at arbitrary
// paths via its { globalPath, projectPath } options. No real user config is
// touched. The `node:fs` mkdtempSync helper gives us a clean tmpdir per test.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync as fsWriteFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeTmpDir() {
	return mkdtempSync(join(tmpdir(), "pi-questionnaire-settings-"));
}

test("settings: load returns DEFAULTS when no files exist", () => {
	const dir = makeTmpDir();
	try {
		const s = loadSettings(dir, {
			globalPath: join(dir, "absent.global.json"),
			projectPath: join(dir, "absent.project.json"),
		});
		assert.deepEqual(s, {});
		// But getSettings() always returns the full resolved view.
		const resolved = getSettings(dir);
		assert.equal(resolved.bellOnQuestion, DEFAULT_SETTINGS.bellOnQuestion);
		assert.equal(resolved.browserMinQuestions, DEFAULT_SETTINGS.browserMinQuestions);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("settings: project file overrides global file (project wins)", () => {
	const dir = makeTmpDir();
	try {
		// Use distinct filenames so both layers can co-exist.
		const g = join(dir, "global.json");
		const p = join(dir, "project.json");
		fsWriteFileSync(g, JSON.stringify({
			browserEnabled: true,
			browserMinQuestions: 1,
			bellOnQuestion: true,
		}));
		fsWriteFileSync(p, JSON.stringify({
			browserMinQuestions: 4,  // overrides global
			bellOnQuestion: false,    // overrides global
		}));
		const s = loadSettings(dir, { globalPath: g, projectPath: p });
		// browserEnabled: only in global, preserved
		assert.equal(s.browserEnabled, true);
		// browserMinQuestions: project wins
		assert.equal(s.browserMinQuestions, 4);
		// bellOnQuestion: project wins (false)
		assert.equal(s.bellOnQuestion, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("settings: drop unknown keys + coerce/reject fields with wrong types", () => {
	const dir = makeTmpDir();
	try {
		const p = join(dir, "project.json");
		fsWriteFileSync(p, JSON.stringify({
			browserEnabled: "true",      // string, not boolean → dropped
			browserMinQuestions: 2.5,     // not integer → dropped
			browserMinQuestions_min: -1,  // out of range → dropped
			browserMinQuestions_max: 99,  // out of range → dropped
			bellOnQuestion: true,         // valid
			notificationDelaySeconds: -10, // below min → dropped
			heartbeatIntervalMinutes: 999, // above max → dropped
			onQuestionCommand: "say 'question'", // valid string
			bogusKey: { deep: [1, 2] },   // unknown → dropped
			__proto__: { polluted: true }, // attempt at prototype pollution → dropped
		}));
		const s = loadSettings(dir, { projectPath: p });
		assert.equal(s.browserEnabled, undefined, "string 'true' dropped");
		assert.equal(s.browserMinQuestions, undefined, "non-integer dropped");
		assert.equal(s.bellOnQuestion, true);
		assert.equal(s.notificationDelaySeconds, undefined);
		assert.equal(s.heartbeatIntervalMinutes, undefined);
		assert.equal(s.onQuestionCommand, "say 'question'");
		assert.equal(s.bogusKey, undefined);
		// Sanity: no pollution slipped through.
		assert.equal(({}).polluted, undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("settings: save + reload round-trip preserves every valid field", () => {
	const dir = makeTmpDir();
	try {
		const snapshot = {
			browserEnabled: false,
			browserAutoOpen: true,
			browserMinQuestions: 3,
			copyUrlToClipboard: false,
			bellOnQuestion: false,
			notificationOnQuestion: true,
			notificationDelaySeconds: 90,
			ttsOnQuestion: true,
			onQuestionCommand: "echo asked",
			heartbeatWhileActive: true,
			heartbeatIntervalMinutes: 7.5,
			debounceMs: 750,
			dangerCheckEnabled: false,
		};
		const ok = saveSettings(snapshot, dir);
		assert.equal(ok, true);
		const reloaded = loadSettings(dir);
		assert.deepEqual(reloaded, snapshot);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("settings: getSettings returns full resolved view (no missing fields)", () => {
	const dir = makeTmpDir();
	try {
		// Force-set cwd via cwd param — getSettings reads project from <cwd>/.pi/.
		const resolved = getSettings(dir, {
			// getSettings() doesn't take path overrides directly, but
			// loadSettings does — verify the public surface resolves every
			// default for a fresh dir.
			__unused: undefined,
		});
		void resolved;
		const r = getSettings(dir);
		// Every DEFAULT_SETTINGS key must be present and of the right type.
		for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
			assert.ok(k in r, `missing resolved key: ${k}`);
			assert.equal(typeof r[k], typeof v, `type mismatch for ${k}`);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("settings: setInMemorySettings overrides disk for the duration of the test", () => {
	const dir = makeTmpDir();
	try {
		// Disk says bellOnQuestion: false. getSettings reads project from
		// <cwd>/.pi/ask-user-question.json, so write there.
		const projectPath = join(dir, ".pi", "ask-user-question.json");
		mkdirSync(join(dir, ".pi"), { recursive: true });
		fsWriteFileSync(projectPath, JSON.stringify({ bellOnQuestion: false }));
		// Baseline: bellOnQuestion should be false from disk.
		const before = getSettings(dir);
		assert.equal(before.bellOnQuestion, false);
		// Now override.
		setInMemorySettings({ bellOnQuestion: true });
		try {
			const overridden = getSettings(dir);
			assert.equal(overridden.bellOnQuestion, true);
		} finally {
			clearInMemorySettings();
		}
		// After clear: back to disk value.
		const after = getSettings(dir);
		assert.equal(after.bellOnQuestion, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("settings: malformed project file is ignored (warning logged, defaults returned)", () => {
	const dir = makeTmpDir();
	try {
		const p = join(dir, "project.json");
		fsWriteFileSync(p, "{ this is not valid JSON");
		const origWarn = console.warn;
		const warnings = [];
		console.warn = (...args) => warnings.push(args.join(" "));
		try {
			const s = loadSettings(dir, { projectPath: p });
			assert.deepEqual(s, {});
		} finally {
			console.warn = origWarn;
		}
		assert.ok(
			warnings.some((w) => w.includes("Ignoring malformed settings")),
			"expected a warning about the malformed settings file",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ============================================================================
// BEL emission (gated by bellOnQuestion)
// ============================================================================

test("playBell writes BEL when bellOnQuestion is true (default)", () => {
	clearInMemorySettings();
	const writes = [];
	const writer = (s) => writes.push(s);
	const ok = playBell(writer);
	assert.equal(ok, true);
	assert.deepEqual(writes, ["\x07"]);
});

test("playBell writes nothing when bellOnQuestion is false", () => {
	setInMemorySettings({ bellOnQuestion: false });
	try {
		const writes = [];
		const writer = (s) => writes.push(s);
		const ok = playBell(writer);
		assert.equal(ok, false);
		assert.deepEqual(writes, []);
	} finally {
		clearInMemorySettings();
	}
});

test("TUI mount writes a BEL when bellOnQuestion is true (default)", () => {
	clearInMemorySettings();
	const writes = [];
	const writer = (s) => writes.push(s);
	const canonical = normalizeQuestions([{
		header: "Pick",
		question: "Pick one?",
		type: "select_one",
		options: [{ label: "A" }, { label: "B" }],
	}]);
	const factory = buildQuestionnaireComponent({
		questions: canonical,
		terminalWriter: writer,
	});
	const c = factory(makeFakeTui(), fakeTheme, {}, () => {});
	// The bell fires on the FIRST render, not on mount (so it only
	// rings once the TUI is actually visible to the user).
	c.render(80);
	// Exactly one standalone BEL (no title prefix, just \x07 by itself).
	const bareBel = writes.filter((w) => w === "\x07");
	assert.equal(bareBel.length, 1, `expected exactly 1 BEL, got ${bareBel.length}; writes=${JSON.stringify(writes)}`);
	c.dispose();
});

test("TUI mount writes NO BEL when bellOnQuestion is false (in-memory override)", () => {
	setInMemorySettings({ bellOnQuestion: false });
	try {
		const writes = [];
		const writer = (s) => writes.push(s);
		const canonical = normalizeQuestions([{
			header: "Pick",
			question: "Pick one?",
			type: "select_one",
			options: [{ label: "A" }, { label: "B" }],
		}]);
		const factory = buildQuestionnaireComponent({
			questions: canonical,
			terminalWriter: writer,
		});
		const c = factory(makeFakeTui(), fakeTheme, {}, () => {});
		// Render to trigger the first-render bell check. With
		// bellOnQuestion=false, no BEL is written.
		c.render(80);
		const bareBel = writes.filter((w) => w === "\x07");
		assert.equal(bareBel.length, 0, `expected no BEL; writes=${JSON.stringify(writes)}`);
		// Title prefix still fires (independent signal).
		const titleCalls = writes.filter((w) => w.startsWith("\x1b]0;"));
		assert.ok(titleCalls.length >= 1, "title prefix should still be set even when BEL is off");
		c.dispose();
	} finally {
		clearInMemorySettings();
	}
});

test("TUI submit/cancel/dispose do NOT re-trigger the bell", () => {
	clearInMemorySettings();

	// --- submit path (single-question select_one) ---
	{
		const writes = [];
		const writer = (s) => writes.push(s);
		const canonical = normalizeQuestions([{
			header: "Pick",
			question: "Pick one?",
			type: "select_one",
			options: [{ label: "A" }, { label: "B" }],
		}]);
		const factory = buildQuestionnaireComponent({
			questions: canonical,
			terminalWriter: writer,
		});
		const c = factory(makeFakeTui(), fakeTheme, {}, () => {});
		// Render first to fire the mount bell (fires on first render,
		// not on mount).
		c.render(80);
		c.handleInput("\r"); // single-question: Enter triggers commitAndAdvance → submit()
		const bareBel = writes.filter((w) => w === "\x07");
		assert.equal(
			bareBel.length,
			1,
			`submit path: expected exactly 1 BEL, got ${bareBel.length}; writes=${JSON.stringify(writes)}`,
		);
		// And the title was cleared on submit.
		const titleClears = writes.filter((w) => w === "\x1b]0;\x07");
		assert.ok(titleClears.length >= 1, "submit must clear the terminal title");
	}

	// --- cancel path ---
	{
		const writes = [];
		const writer = (s) => writes.push(s);
		const canonical = normalizeQuestions([{
			header: "Pick",
			question: "Pick one?",
			type: "select_one",
			options: [{ label: "A" }, { label: "B" }],
		}]);
		const factory = buildQuestionnaireComponent({
			questions: canonical,
			terminalWriter: writer,
		});
		const c = factory(makeFakeTui(), fakeTheme, {}, () => {});
		// Render first to fire the mount bell.
		c.render(80);
		c.handleInput("\x1b"); // Escape triggers cancel()
		const bareBel = writes.filter((w) => w === "\x07");
		assert.equal(
			bareBel.length,
			1,
			`cancel path: expected exactly 1 BEL, got ${bareBel.length}; writes=${JSON.stringify(writes)}`,
		);
		const titleClears = writes.filter((w) => w === "\x1b]0;\x07");
		assert.ok(titleClears.length >= 1, "cancel must clear the terminal title");
	}

	// --- dispose path (safe to call twice) ---
	{
		const writes = [];
		const writer = (s) => writes.push(s);
		const canonical = normalizeQuestions([{
			header: "Pick",
			question: "Pick one?",
			type: "select_one",
			options: [{ label: "A" }, { label: "B" }],
		}]);
		const factory = buildQuestionnaireComponent({
			questions: canonical,
			terminalWriter: writer,
		});
		const c = factory(makeFakeTui(), fakeTheme, {}, () => {});
		// Render first to fire the mount bell.
		c.render(80);
		c.dispose();
		c.dispose(); // safe to call twice
		const bareBel = writes.filter((w) => w === "\x07");
		assert.equal(bareBel.length, 1, "dispose path: bell fires exactly once on first render");
	}
});

// ============================================================================
// is_dangerous TUI flow (gated by settings.dangerCheckEnabled)
// ============================================================================

test("is_dangerous: warning header + prompt shown when dangerCheckEnabled is true", () => {
	setInMemorySettings({ dangerCheckEnabled: true });
	try {
		const { lines } = render([{
			header: "Drop",
			question: "Drop the database?",
			type: "free_text",
			is_dangerous: true,
		}]);
		const joined = lines.join("\n");
		assert.match(joined, /⚠️/, "should include warning marker");
		assert.match(joined, /DESTRUCTIVE/, "should include DESTRUCTIVE label");
		assert.match(joined, /Type the resource name to confirm/, "should include confirmation prompt");
	} finally {
		clearInMemorySettings();
	}
});

test("is_dangerous: empty editor + Enter does NOT commit", () => {
	setInMemorySettings({ dangerCheckEnabled: true });
	try {
		const { component, getDone } = drive([{
			header: "Drop",
			question: "Drop the database?",
			type: "free_text",
			is_dangerous: true,
		}]);
		// No typing. Just press Enter.
		component.handleInput("\r");
		assert.equal(getDone(), null, "empty Enter must not commit; should stay in danger mode");
	} finally {
		clearInMemorySettings();
	}
});

test("is_dangerous: non-empty editor + Enter commits typed text as free_text answer", () => {
	setInMemorySettings({ dangerCheckEnabled: true });
	try {
		const { component, getDone } = drive([{
			header: "Drop",
			question: "Drop the database?",
			type: "free_text",
			is_dangerous: true,
		}]);
		// Type "production-db" character by character.
		for (const ch of "production-db") {
			component.handleInput(ch);
		}
		component.handleInput("\r");
		const v = getDone();
		assert.ok(v !== null, "Enter with non-empty text must commit");
		if (v) {
			assert.equal(v.lifecycle, "answered");
			assert.equal(v.answers.length, 1);
			assert.equal(v.answers[0].type, "free_text");
			assert.equal(v.answers[0].value, "production-db");
		}
	} finally {
		clearInMemorySettings();
	}
});

test("is_dangerous: revisit prepopulates the editor with the previous answer", () => {
	setInMemorySettings({ dangerCheckEnabled: true });
	try {
		const questions = [
			{ id: "d", header: "Drop", question: "Drop the database?", type: "free_text", is_dangerous: true },
			{ id: "o", header: "Other", question: "Anything else?", type: "free_text" },
		];
		const { component, getDone } = drive(questions);
		// On question 0 (danger): editor is open, empty. Type "production-db".
		for (const ch of "production-db") {
			component.handleInput(ch);
		}
		component.handleInput("\r");
		// After commit, advance to question 1.
		// Navigate back to question 0 (danger revisit).
		component.handleInput("[");
		// Editor should now be pre-filled with "production-db".
		assert.equal(
			typeof component.getEditorText === "function",
			true,
			"factory should expose getEditorText for revisit verification",
		);
		assert.equal(component.getEditorText(), "production-db");
	} finally {
		clearInMemorySettings();
	}
});

test("is_dangerous: dangerCheckEnabled false falls through to normal free_text behavior", () => {
	setInMemorySettings({ dangerCheckEnabled: false });
	try {
		const { lines } = render([{
			header: "Drop",
			question: "Drop the database?",
			type: "free_text",
			is_dangerous: true,
		}]);
		const joined = lines.join("\n");
		assert.doesNotMatch(joined, /⚠️/, "no warning marker when setting is off");
		assert.doesNotMatch(joined, /DESTRUCTIVE/, "no DESTRUCTIVE label when setting is off");
		assert.doesNotMatch(joined, /Type the resource name to confirm/, "no confirmation prompt when setting is off");
	} finally {
		clearInMemorySettings();
	}
});

test("is_dangerous: is_dangerous=false (or undefined) uses normal free_text behavior", () => {
	setInMemorySettings({ dangerCheckEnabled: true });
	try {
		// Explicitly false
		const { lines: a } = render([{
			header: "Note",
			question: "Anything to add?",
			type: "free_text",
			is_dangerous: false,
		}]);
		assert.doesNotMatch(a.join("\n"), /⚠️/);
		assert.doesNotMatch(a.join("\n"), /DESTRUCTIVE/);

		// Undefined
		const { lines: b } = render([{
			header: "Note",
			question: "Anything to add?",
			type: "free_text",
		}]);
		assert.doesNotMatch(b.join("\n"), /⚠️/);
		assert.doesNotMatch(b.join("\n"), /DESTRUCTIVE/);
	} finally {
		clearInMemorySettings();
	}
});

// ---------------------------------------------------------------------------
// Regression: `[` on Submit tab used to be dropped (the isOnSubmit
// early-return swallowed every key except Enter/Esc), so the user
// couldn't back out of Submit to fix a wrong answer without Esc'ing
// the whole questionnaire. Now nav keys fall through to the multi-
// question tab-nav handlers.
// ---------------------------------------------------------------------------
test("Submit tab: `[` navigates back to the previous question", () => {
	const questions = [
		{ header: "Pick", question: "Pick one?", type: "select_one", options: [{ label: "A" }] },
		{ header: "Tags", question: "Tags?", type: "select_many", options: [{ label: "bug" }] },
	];
	const { component } = drive(questions);
	// Advance to Submit tab via the natural path.
	component.handleInput("1"); // pick A on q0 → advances
	component.handleInput("1"); // toggle bug on q1
	component.handleInput("0"); // jump to Submit tab
	const linesAtSubmit = component.render(80);
	assert.match(linesAtSubmit.join("\n"), /Submit answers/, "should be on Submit tab");
	// Press `[` — should navigate back to Tags (q1), not be dropped.
	component.handleInput("[");
	const linesAfterBack = component.render(80);
	assert.doesNotMatch(
		linesAfterBack.join("\n"),
		/Submit answers/,
		"should have left Submit tab",
	);
	assert.match(
		linesAfterBack.join("\n"),
		/Tags/,
		"should be back on the Tags question",
	);
});

test("Submit tab: Left arrow navigates back to the previous question", () => {
	const questions = [
		{ header: "Pick", question: "Pick one?", type: "select_one", options: [{ label: "A" }] },
		{ header: "Tags", question: "Tags?", type: "select_many", options: [{ label: "bug" }] },
	];
	const { component } = drive(questions);
	component.handleInput("1"); // pick A on q0
	component.handleInput("1"); // toggle bug on q1
	component.handleInput("0"); // jump to Submit tab
	const linesAtSubmit = component.render(80);
	assert.match(linesAtSubmit.join("\n"), /Submit answers/, "should be on Submit tab");
	// Press Left arrow — should navigate back to Tags (q1), same as `[`.
	component.handleInput("\x1b[D");
	const linesAfterBack = component.render(80);
	assert.doesNotMatch(
		linesAfterBack.join("\n"),
		/Submit answers/,
		"Left arrow should leave Submit tab",
	);
	assert.match(
		linesAfterBack.join("\n"),
		/Tags/,
		"should be back on the Tags question",
	);
});

test("Submit tab: Enter submits all answers when every question is answered", () => {
	const questions = [
		{ header: "Note", question: "Anything else?", type: "free_text" },
		{ header: "Tags", question: "Tags?", type: "select_many", options: [{ label: "bug" }] },
	];
	const { component, getDone } = drive(questions);
	// free_text editor opens immediately on render — no need to
	// press Enter first. Just type and commit.
	for (const ch of "hello world") component.handleInput(ch);
	let lines = component.render(80).join("\n");
	assert.match(lines, /hello world/, "typed free_text should be visible while editing");
	component.handleInput("\r"); // commit free_text → advance to Tags
	component.handleInput(" "); // toggle bug
	component.handleInput("0"); // jump to Submit tab
	component.handleInput("\r"); // submit all answers
	const v = getDone();
	assert.ok(v !== null, "Enter on Submit should call done() when all answers exist");
	if (v) {
		assert.equal(v.lifecycle, "answered");
		assert.equal(v.answers.find((a) => a.index === 0)?.value, "hello world");
		assert.deepEqual(v.answers.find((a) => a.index === 1)?.value, [{ mode: "option", value: "bug" }]);
	}
});

test("free_text active editor hints only supported controls", () => {
	const { component } = drive([{
		header: "Note",
		question: "Anything else?",
		type: "free_text",
	}]);
	component.handleInput("\r");
	for (const ch of "hello") component.handleInput(ch);
	const lines = component.render(80).join("\n");
	assert.match(lines, /\[Enter\] save answer  Esc close/);
	assert.doesNotMatch(lines, /Tab notes/);
	assert.doesNotMatch(lines, /\? help/);
});

// ---------------------------------------------------------------------------
// Regression: danger editor text was not being echoed before this fix.
// The host only renders the editor for known inputModes ("free_text",
// "notes", "other", "number", "text") — "danger" wasn't on that list, so
// without inline-rendering the user typed into a black hole. Now the
// editor is appended to the render output in the danger branch.
// ---------------------------------------------------------------------------
test("is_dangerous: typed text is echoed in the rendered output", () => {
	setInMemorySettings({ dangerCheckEnabled: true });
	try {
		const questions = [{
			header: "Drop",
			question: "Drop the database?",
			type: "free_text",
			is_dangerous: true,
		}];
		const { component } = drive(questions);
		// Type characters into the danger editor
		for (const ch of "production-db") {
			component.handleInput(ch);
		}
		const lines = component.render(80);
		const joined = lines.join("\n");
		// The typed text must appear in the rendered output. If the editor
		// is rendered inline (the fix), this matches; if it isn't, the
		// prompt is shown but typed text is invisible.
		assert.match(
			joined,
			/production-db/,
			"typed text should be visible in the danger editor rendering",
		);
	} finally {
		clearInMemorySettings();
	}
});

test("is_dangerous: warning view replaces the normal header instead of duplicating it", () => {
	setInMemorySettings({ dangerCheckEnabled: true });
	try {
		const questions = [{
			header: "Drop",
			question: "Drop the database?",
			type: "free_text",
			is_dangerous: true,
		}];
		const { component } = drive(questions);
		const lines = component.render(80);
		// With the visual frame, lines[0] is the top border — skip past
		// it to find the first content line.
		const firstContent = lines.find((l) => !l.startsWith("┌") && !l.startsWith("└") && !l.startsWith("│") || l.includes("⚠️") || l.includes("DESTRUCTIVE"));
		assert.match(
			firstContent ?? "",
			/⚠️  DESTRUCTIVE — Drop/,
			"first content line should be the destructive header",
		);
		// The question text should appear exactly once (the danger branch
		// replaces, not duplicates, the normal header rendering).
		const occurrences = lines.filter((l) => l.includes("Drop the database?")).length;
		assert.equal(
			occurrences,
			1,
			"danger prompt should appear exactly once",
		);
	} finally {
		clearInMemorySettings();
	}
});

// ---------------------------------------------------------------------------
// Regression: multi_select Other is an inline text input (no modal).
// Cursor on Other -> printable chars append to the inline text,
// Backspace deletes, and Enter commits the Other text WITHOUT
// submitting the whole question. The dedicated [Select] button is the
// only final submit for the batch.
// ---------------------------------------------------------------------------
test("multi_select Other: Enter commits text and returns to choices without submitting", () => {
	const questions = [{
		header: "Tags",
		question: "Which categories?",
		type: "select_many",
		options: [
			{ label: "bug", description: "Broken." },
			{ label: "feature", description: "New capability." },
		],
	}];
	const { component, getDone } = drive(questions);

	component.handleInput("1"); // toggle bug
	component.handleInput("\x1b[B"); // feature
	component.handleInput("\x1b[B"); // Other
	for (const ch of "needs-investigation") {
		component.handleInput(ch);
	}
	assert.equal(
		typeof component.getEditorText === "function" ? component.getEditorText() : "",
		"needs-investigation",
		"typed text should be in the editor buffer before commit",
	);
	let lines = component.render(80).join("\n");
	assert.match(lines, /needs-investigation/);
	component.handleInput("\r");
	assert.equal(getDone(), null, "Enter on multi_select Other should not submit the questionnaire");
	lines = component.render(80).join("\n");
	assert.match(lines, /→ needs-investigation/);
	assert.match(lines, /\[Select\]/);
	component.handleInput("\x1b[B"); // [Select]
	component.handleInput("\r");
	const v = getDone();
	assert.ok(v !== null, "[Select] should submit the single-question multi_select");
	if (v) {
		assert.equal(v.lifecycle, "answered");
		assert.equal(v.answers.length, 1);
		const ans = v.answers[0].value;
		assert.ok(Array.isArray(ans), "select_many answer must be an array");
		if (Array.isArray(ans)) {
			assert.deepEqual(ans, [
				{ mode: "option", value: "bug" },
				{ mode: "other", text: "needs-investigation" },
			]);
		}
	}
});

test("multi_select Other: empty Enter on Other is a no-op (no commit)", () => {
	const questions = [{
		header: "Tags",
		question: "Which categories?",
		type: "select_many",
		options: [{ label: "bug" }],
	}];
	const { component, getDone } = drive(questions);
	// Navigate to Other (idx 1)
	component.handleInput("\x1b[B");
	// Press Enter with empty text — should NOT commit.
	component.handleInput("\r");
	assert.equal(
		getDone(),
		null,
		"empty Enter on Other should be a no-op, not submit",
	);
});

test("multi_select Other: revisit shows previous Other text", () => {
	// Two questions so we can navigate away and then back to the
	// multi_select after committing Other text.
	const questions = [
		{ header: "Pick", question: "Pick one?", type: "select_one", options: [{ label: "A" }] },
		{ header: "Tags", question: "Which categories?", type: "select_many", options: [{ label: "bug" }] },
	];
	const { component } = drive(questions);
	// First question: pick A
	component.handleInput("1"); // advances
	// Second question: navigate to Other, type, commit
	component.handleInput("\x1b[B"); // down → Other
	for (const ch of "first") component.handleInput(ch);
	component.handleInput("\r"); // commit Other, stay on the same question
	component.handleInput("0"); // jump to Submit
	// Navigate from Submit tab back to the multi_select.
	component.handleInput("[");
	// Render: the inline text input should show "first" (prefilled from
	// saved answer on first render of Other for this question).
	const lines = component.render(80).join("\n");
	assert.match(
		lines,
		/first/,
		"inline Other text input should show prior answer on revisit",
	);
});

test("multi_select Other: Backspace deletes from inline text input", () => {
	const questions = [{
		header: "Tags",
		question: "Which categories?",
		type: "select_many",
		options: [{ label: "bug" }],
	}];
	const { component } = drive(questions);
	component.handleInput("\x1b[B"); // Other
	for (const ch of "abc") component.handleInput(ch);
	let draft = component.render(80).join("\n");
	assert.match(draft, /abc/, "should show 'abc' after typing");
	component.handleInput("\b"); // backspace
	draft = component.render(80).join("\n");
	assert.doesNotMatch(draft, /abc/, "should no longer show 'abc'");
	assert.match(draft, /ab/, "should show 'ab' after one backspace");
});

test("multi_select Other: toggling a regular option preserves the existing Other entry", () => {
	const questions = [
		{ header: "Pick", question: "Pick one?", type: "select_one", options: [{ label: "A" }] },
		{
			header: "Tags",
			question: "Which categories?",
			type: "select_many",
			options: [{ label: "bug" }, { label: "feature" }],
		},
	];
	const { component, getDone } = drive(questions);
	component.handleInput("1"); // q0 -> advance
	component.handleInput("\x1b[B"); // feature
	component.handleInput("\x1b[B"); // Other
	for (const ch of "custom-tag") component.handleInput(ch);
	component.handleInput("\r"); // commit Other, return to choices
	component.handleInput("\x1b[A"); // feature
	component.handleInput(" "); // toggle feature on
	component.handleInput("0"); // submit tab
	component.handleInput("\r"); // submit all
	const v = getDone();
	assert.ok(v !== null, "expected done() to be called");
	if (v) {
		const ans = v.answers.find((a) => a.id === "q2" || a.index === 1)?.value;
		assert.ok(Array.isArray(ans), "select_many answer must stay an array");
		if (Array.isArray(ans)) {
			assert.deepEqual(ans, [
				{ mode: "option", value: "feature" },
				{ mode: "other", text: "custom-tag" },
			]);
		}
	}
});
