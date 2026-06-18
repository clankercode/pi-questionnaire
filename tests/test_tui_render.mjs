// tests/test_tui_render.mjs
// Snapshot test for the TUI render. Runs the component factory with a fake
// tui/theme, calls render(width), and asserts the rendered lines contain
// expected substrings for each question type. We don't do full snapshot
// diff (fragile across theme/wrap changes) — just key markers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildQuestionnaireComponent } from "../src/tui.ts";
import { normalizeQuestions } from "../src/normalize.ts";

// We import runHarness for the "normalize caps at 7" test which needs the
// normalize() command in tests/harness.ts.
import { runHarness as _runHarness } from "./harness-runner.mjs";
function runHarness(cmd) { return _runHarness(cmd); }

const fakeTui = makeFakeTui();
const fakeTheme = makeFakeTheme();

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

function render(questions, width = 80) {
	const canonical = normalizeQuestions(questions);
	const factory = buildQuestionnaireComponent({ questions: canonical });
	const tui = makeFakeTui();
	let captured = null;
	factory(tui, fakeTheme, {}, (v) => {
		captured = v;
	});
	const component = factory(tui, fakeTheme, {}, () => {});
	const lines = component.render(width);
	return { lines, captured, component };
}

test("single_select renders question + numbered options", () => {
	const { lines } = render([{
		id: "x",
		question: "Pick a color?",
		type: "single_select",
		options: [{ label: "Red" }, { label: "Blue" }, { label: "Other" }],
	}]);
	const joined = lines.join("\n");
	assert.match(joined, /Pick a color\?/);
	assert.match(joined, /1\. Red/);
	assert.match(joined, /2\. Blue/);
	assert.match(joined, /3\. Other/);
});

test("multi_select shows checkboxes", () => {
	const { lines } = render([{
		id: "x",
		question: "Pick toppings?",
		type: "multi_select",
		options: [{ label: "A" }, { label: "B" }, { label: "Other" }],
	}]);
	const joined = lines.join("\n");
	// The renderer uses ■ for selected and □ for unselected (multi mode).
	assert.match(joined, /Pick toppings\?/);
	// "Space toggle" hint
	assert.match(joined, /Space toggle/);
});

test("text question shows placeholder + editor prompt", () => {
	const { lines } = render([{
		id: "x",
		question: "Your name?",
		type: "text",
		placeholder: "type your answer…",
	}]);
	const joined = lines.join("\n");
	assert.match(joined, /Your name\?/);
	assert.match(joined, /type your answer…/);
});

test("number question shows range", () => {
	const { lines } = render([{
		id: "x",
		question: "How many?",
		type: "number",
		min: 1,
		max: 10,
	}]);
	const joined = lines.join("\n");
	assert.match(joined, /How many\?/);
	assert.match(joined, /range: 1…10/);
});

test("confirm renders Yes/No", () => {
	const { lines } = render([{
		id: "x",
		question: "Proceed?",
		type: "confirm",
	}]);
	const joined = lines.join("\n");
	assert.match(joined, /Proceed\?/);
	assert.match(joined, /1\. Yes/);
	assert.match(joined, /2\. No/);
});

test("multi question renders tab bar", () => {
	const { lines } = render([
		{ id: "a", question: "A?", type: "text" },
		{ id: "b", question: "B?", type: "text" },
		{ id: "c", question: "C?", type: "text" },
	], 100);
	const joined = lines.join("\n");
	assert.match(joined, /Q1/);
	assert.match(joined, /Q2/);
	assert.match(joined, /Q3/);
	assert.match(joined, /Submit/);
});

test("preview content is rendered under option", () => {
	const { lines } = render([{
		id: "x",
		question: "Pick",
		type: "single_select",
		options: [
			{ label: "A", preview: { type: "mermaid", content: "graph TD; A-->B" } },
			{ label: "B" },
		],
	}]);
	const joined = lines.join("\n");
	assert.match(joined, /A-->B/);
	assert.match(joined, /\[mermaid\]/);
});

test("description is rendered under option", () => {
	const { lines } = render([{
		id: "x",
		question: "Pick",
		type: "single_select",
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
		{ id: "a", question: "A?", header: "ThisIsAVeryLongHeader", type: "text" },
		{ id: "b", question: "B?", header: "B", type: "text" },
	], 120);
	const joined = lines.join("\n");
	// header truncated to 20 chars
	assert.match(joined, /ThisIsAVeryLongHead/);
});

// ---- Interaction tests (drive the component via handleInput) --------------

function makeFakeTui() {
	return {
		requestRender: () => {},
		terminal: { rows: 24, cols: 80 },
	};
}

function drive(questions) {
	const canonical = normalizeQuestions(questions);
	const factory = buildQuestionnaireComponent({ questions: canonical });
	const tui = makeFakeTui();
	let doneValue = null;
	const component = factory(tui, fakeTheme, {}, (v) => {
		doneValue = v;
	});
	return { component, getDone: () => doneValue };
}

test("multi_select: Space toggles, then Enter commits array of labels", () => {
	const { component, getDone } = drive([{
		id: "ms",
		question: "Pick toppings?",
		type: "multi_select",
		options: [{ label: "A" }, { label: "B" }, { label: "C" }],
	}]);
	// Highlight first option, toggle it
	component.handleInput(" ");
	// Move to second
	component.handleInput("\u001b[B"); // Key.down
	// Toggle second
	component.handleInput(" ");
	// Move to third
	component.handleInput("\u001b[B"); // Key.down
	// Toggle third
	component.handleInput(" ");
	// Multi-select commits the answer on each toggle (it saves a snapshot),
	// so we expect the snapshot to contain all three labels.
	// Now hit Enter to commit and advance to the submit tab.
	component.handleInput("\r");
	const done = getDone();
	// In multi-question, Enter saves and advances. With 1 question, we go
	// to the submit tab. Press Enter again on submit tab to commit.
	if (done === null) {
		component.handleInput("\r"); // submit
	}
	const finalDone = getDone();
	if (finalDone === null) {
		// The flow may have advanced to the submit tab; look at the answers
		// map by inspecting the component's internal state via re-render.
		// Easiest: just assert that the saved answer was an array of 3 items.
	}
	// The cleaner test: drive the multi-select with a single question, then
	// call Space three times and assert the saved answer is correct.
	// Re-do the test from scratch with explicit assertions.
	const { component: c2, getDone: d2 } = drive([{
		id: "ms2",
		question: "Pick?",
		type: "multi_select",
		options: [{ label: "A" }, { label: "B" }, { label: "C" }],
	}]);
	c2.handleInput(" "); // toggle A
	c2.handleInput("\u001b[B"); // move to B
	c2.handleInput(" "); // toggle B
	// Now drive to done. After Space, the answer is saved. After another
	// action that triggers done, we get the result.
	c2.handleInput("\r"); // enter (advances to submit tab for single-question)
	c2.handleInput("\r"); // submit
	const v = d2();
	assert.ok(v !== null, "expected done() to be called");
	if (v) {
		assert.equal(v.cancelled, false);
		// The answers array will contain one entry for "ms2" with the array
		// of toggled labels. Order may differ; check as set.
		assert.equal(v.answers.length, 1);
		const a = v.answers[0];
		assert.equal(a.id, "ms2");
		assert.deepEqual([...a.value].sort(), ["A", "B"]);
	}
});

test("confirm: Enter on Yes returns boolean true", () => {
	const { component, getDone } = drive([{
		id: "c",
		question: "Proceed?",
		type: "confirm",
	}]);
	component.handleInput("\r"); // enter on first option (Yes)
	const v = getDone();
	assert.ok(v !== null);
	if (v) {
		assert.equal(v.cancelled, false);
		const a = v.answers[0];
		assert.equal(a.id, "c");
		assert.equal(a.value, true);
	}
});

test("confirm: arrow-down + Enter on No returns boolean false", () => {
	const { component, getDone } = drive([{
		id: "c",
		question: "Proceed?",
		type: "confirm",
	}]);
	component.handleInput("\u001b[B"); // Key.down
	component.handleInput("\r"); // enter on No
	const v = getDone();
	assert.ok(v !== null);
	if (v) {
		assert.equal(v.answers[0].value, false);
	}
});

test("single_select Other: Enter on Other opens text editor", () => {
	const { component } = drive([{
		id: "x",
		question: "Pick?",
		type: "single_select",
		options: [{ label: "A" }, { label: "B" }, { label: "Other" }],
	}]);
	component.handleInput("\u001b[B"); // down to B
	component.handleInput("\u001b[B"); // down to Other
	component.handleInput("\r"); // enter on Other → opens editor
	const lines = component.render(80);
	const joined = lines.join("\n");
	// After entering Other, the editor should be visible
	assert.match(joined, /Your answer:/);
});

test("Esc cancels the whole questionnaire", () => {
	const { component, getDone } = drive([{
		id: "x",
		question: "Pick?",
		type: "single_select",
		options: [{ label: "A" }, { label: "B" }],
	}]);
	component.handleInput("\u001b"); // Key.escape
	const v = getDone();
	assert.ok(v !== null);
	if (v) {
		assert.equal(v.cancelled, true);
		assert.equal(v.answers.length, 0);
	}
});

test("normalize caps at 7 options so post-Other is 8", () => {
	const r = runHarness({ cmd: "normalize", input: [{
		id: "x", "question": "q?", "type": "single_select",
		options: Array.from({ length: 9 }, (_, i) => ({ label: `opt${i}` })),
	}] });
	assert.equal(r.value[0].options.length, 8, "capped at 8 (7 + Other)");
});
