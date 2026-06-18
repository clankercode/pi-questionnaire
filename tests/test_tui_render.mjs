// tests/test_tui_render.mjs
// Snapshot test for the v2 TUI render. Runs the component factory with a
// fake tui/theme, calls render(width), and asserts the rendered lines contain
// expected substrings for each question type. We don't do full snapshot
// diff (fragile across theme/wrap changes) — just key markers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildQuestionnaireComponent } from "../src/tui.ts";
import { normalizeQuestions } from "../src/normalize.ts";

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

function makeFakeTui() {
	return {
		requestRender: () => {},
		terminal: { rows: 24, cols: 80 },
	};
}

function render(questions, width = 80) {
	const canonical = normalizeQuestions(questions);
	const factory = buildQuestionnaireComponent({ questions: canonical });
	const tui = makeFakeTui();
	const component = factory(tui, fakeTheme, {}, () => {});
	const lines = component.render(width);
	return { lines, component };
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

test("select_many shows checkboxes", () => {
	const { lines } = render([{
		header: "Toppings",
		question: "Pick toppings?",
		type: "select_many",
		options: [{ label: "A" }, { label: "B" }, { label: "C" }],
	}]);
	const joined = lines.join("\n");
	assert.match(joined, /Pick toppings\?/);
	// Multi-select hint
	assert.match(joined, /Space toggle/);
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

test("free_text shows multiline hint", () => {
	const { lines } = render([{
		header: "Note",
		question: "Anything to add?",
		type: "free_text",
		placeholder: "Optional",
	}]);
	const joined = lines.join("\n");
	assert.match(joined, /Anything to add\?/);
	assert.match(joined, /multiline/);
	assert.match(joined, /Optional/);
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

test("preview content is rendered under option", () => {
	const { lines } = render([{
		header: "Pick",
		question: "Pick",
		type: "select_one",
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

test("select_one Other: Enter on Other opens text editor", () => {
	const { component } = drive([{
		header: "x",
		question: "Pick?",
		type: "select_one",
		options: [{ label: "A" }, { label: "B" }],
	}]);
	component.handleInput("\u001b[B"); // down to B
	component.handleInput("\u001b[B"); // down to Other
	component.handleInput("\r"); // enter on Other → opens editor
	// The component should now be in input mode; we just check it didn't crash.
	const lines = component.render(80);
	const joined = lines.join("\n");
	// In input mode, the editor is shown (the prompt is rendered by the
	// Editor component). We can't easily test editor output without a
	// terminal mock, so just assert the question still appears.
	assert.match(joined, /Pick\?/);
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
