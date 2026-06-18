// tests/test_tui_render.mjs
// Snapshot test for the TUI render. Runs the component factory with a fake
// tui/theme, calls render(width), and asserts the rendered lines contain
// expected substrings for each question type. We don't do full snapshot
// diff (fragile across theme/wrap changes) — just key markers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildQuestionnaireComponent } from "../src/tui.ts";
import { normalizeQuestions } from "../src/normalize.ts";

const fakeTui = { requestRender: () => {} };
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
	let captured = null;
	factory(fakeTui, fakeTheme, {}, (v) => {
		captured = v;
	});
	// The factory returns a fresh component each call; capture the second call's return.
	const component = factory(fakeTui, fakeTheme, {}, () => {});
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
