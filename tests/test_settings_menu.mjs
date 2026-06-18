// tests/test_settings_menu.mjs
// TUI interaction tests for the AskUserQuestion settings menu.
//
// Drives the menu component factory the same way the production TUI
// would (via handleInput on synthetic key sequences), and asserts on
// the state exposed by the component for inspection. Doesn't depend
// on a real terminal — uses the same fake tui/theme pattern as
// tests/test_tui_render.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	buildSettingsMenuComponent,
	DEFAULT_SECTIONS,
} from "../src/settings-menu.ts";

function makeFakeTui() {
	return {
		requestRender: () => {},
		terminal: { rows: 24, cols: 80 },
	};
}

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

const fakeTheme = makeFakeTheme();

/**
 * Build a menu with synthetic defaults and a change recorder.
 * Returns { component, getCurrent, changes, getDone, state }.
 */
function makeMenu(overrides = {}) {
	const sections = overrides.sections ?? DEFAULT_SECTIONS;
	const current = overrides.current ?? {
		browserEnabled: true,
		browserAutoOpen: false,
		browserMinQuestions: 2,
		copyUrlToClipboard: true,
		bellOnQuestion: true,
		notificationOnQuestion: false,
		notificationDelaySeconds: 30,
		ttsOnQuestion: false,
		onQuestionCommand: "",
		heartbeatWhileActive: false,
		heartbeatIntervalMinutes: 4.5,
		debounceMs: 300,
		dangerCheckEnabled: true,
	};
	const getCurrent = overrides.getCurrent ?? (() => current);
	const changes = [];
	const tui = makeFakeTui();
	let doneValue = null;
	const factory = buildSettingsMenuComponent({
		sections,
		getCurrent,
		onChange: (id, value) => changes.push({ id, value }),
		onExit: overrides.onExit,
	});
	const component = factory(tui, fakeTheme, {}, (v) => {
		doneValue = v;
	});
	return {
		component,
		getCurrent,
		changes,
		getDone: () => doneValue,
		_state: component._state,
		getError: () => component.getError(),
	};
}

const DOWN = "\u001b[B";
const UP = "\u001b[A";
const RIGHT = "\u001b[C";
const LEFT = "\u001b[D";
const ENTER = "\r";
const ESC = "\u001b";
const SPACE = " ";

// ---- Factory shape -------------------------------------------------------

test("buildSettingsMenuComponent returns render/handleInput/dispose", () => {
	const { component } = makeMenu();
	assert.equal(typeof component.render, "function");
	assert.equal(typeof component.handleInput, "function");
	assert.equal(typeof component.dispose, "function");
	assert.equal(typeof component.invalidate, "function");
});

test("DEFAULT_SECTIONS has 5 sections covering all 13 fields", () => {
	assert.equal(DEFAULT_SECTIONS.length, 5);
	const totalSettings = DEFAULT_SECTIONS.reduce((n, s) => n + s.settings.length, 0);
	assert.equal(totalSettings, 13, "expected 13 settings across 5 sections");
	const titles = DEFAULT_SECTIONS.map((s) => s.title);
	assert.deepEqual(titles, [
		"Browser",
		"Notifications",
		"TTS & Command",
		"Heartbeat & Debounce",
		"Question display",
	]);
});

// ---- Section navigation --------------------------------------------------

test("right-arrow on section header enters the section", () => {
	const { component, _state } = makeMenu();
	assert.equal(_state().mode, "sections");
	component.handleInput(RIGHT);
	assert.equal(_state().mode, "settings");
	assert.equal(_state().sectionIndex, 0);
});

test("Enter on section header enters the section (alias for right-arrow)", () => {
	const { component, _state } = makeMenu();
	component.handleInput(ENTER);
	assert.equal(_state().mode, "settings");
});

test("left-arrow from a section returns to the section list", () => {
	const { component, _state } = makeMenu();
	component.handleInput(RIGHT); // enter first section
	assert.equal(_state().mode, "settings");
	component.handleInput(LEFT);
	assert.equal(_state().mode, "sections");
});

test("Esc on a section returns to the section list", () => {
	const { component, _state, getDone } = makeMenu();
	component.handleInput(RIGHT);
	assert.equal(_state().mode, "settings");
	component.handleInput(ESC);
	assert.equal(_state().mode, "sections");
	assert.equal(getDone(), null, "Esc inside a section must not exit the menu");
});

test("Esc at the section list exits the menu (calls done)", () => {
	const { component, getDone } = makeMenu();
	component.handleInput(ESC);
	const v = getDone();
	assert.ok(v !== null, "done() should be called on exit");
	assert.equal(v.lifecycle, "exited");
});

test("left-arrow at the section list exits the menu", () => {
	const { component, getDone } = makeMenu();
	component.handleInput(LEFT);
	const v = getDone();
	assert.ok(v !== null);
	assert.equal(v.lifecycle, "exited");
});

test("down-arrow on sections moves to the next section", () => {
	const { component, _state } = makeMenu();
	assert.equal(_state().sectionIndex, 0);
	component.handleInput(DOWN);
	assert.equal(_state().sectionIndex, 1);
	component.handleInput(DOWN);
	assert.equal(_state().sectionIndex, 2);
});

test("up-arrow wraps from index 0 to the last section", () => {
	const { component, _state } = makeMenu();
	component.handleInput(UP);
	assert.equal(_state().sectionIndex, DEFAULT_SECTIONS.length - 1);
});

test("down-arrow wraps from the last section to 0", () => {
	const { component, _state } = makeMenu();
	for (let i = 0; i < DEFAULT_SECTIONS.length; i++) component.handleInput(DOWN);
	assert.equal(_state().sectionIndex, 0);
});

// ---- Setting list navigation ---------------------------------------------

test("down-arrow in a setting list moves to the next setting", () => {
	const { component, _state } = makeMenu();
	component.handleInput(RIGHT); // enter first section (Browser)
	assert.equal(_state().settingIndex, 0);
	component.handleInput(DOWN);
	assert.equal(_state().settingIndex, 1);
});

test("up-arrow in a setting list moves to the previous setting (wraps)", () => {
	const { component, _state } = makeMenu();
	component.handleInput(RIGHT);
	assert.equal(_state().settingIndex, 0);
	component.handleInput(UP);
	assert.equal(_state().settingIndex, 3, "Browser has 4 settings; up wraps to last");
});

// ---- Boolean toggling ----------------------------------------------------

test("Space on a boolean setting toggles its value", () => {
	const { component, _state, changes } = makeMenu();
	component.handleInput(RIGHT); // enter Browser section
	component.handleInput(DOWN); // skip browserEnabled; move to browserAutoOpen
	// We're at index 1 (browserAutoOpen = false). Toggle.
	component.handleInput(SPACE);
	assert.equal(changes.length, 1);
	assert.equal(changes[0].id, "browserAutoOpen");
	assert.equal(changes[0].value, true);
	void _state;
});

test("Space on the first boolean toggles browserEnabled (true → false)", () => {
	const { component, changes } = makeMenu();
	component.handleInput(RIGHT);
	component.handleInput(SPACE);
	assert.equal(changes.length, 1);
	assert.equal(changes[0].id, "browserEnabled");
	assert.equal(changes[0].value, false);
});

test("Space on a number setting is a no-op (does not call onChange)", () => {
	const { component, changes } = makeMenu();
	// Navigate to Notifications section (index 1)
	component.handleInput(DOWN);
	component.handleInput(RIGHT);
	// Index 0 is notificationOnQuestion (boolean) — skip to index 1 (number)
	component.handleInput(DOWN);
	component.handleInput(SPACE);
	assert.equal(changes.length, 0, "Space on number must not toggle");
});

// ---- Number editor -------------------------------------------------------

test("Enter on a number setting opens an editor; Enter commits the typed value", () => {
	const { component, changes, _state } = makeMenu();
	// Navigate to Notifications section
	component.handleInput(DOWN);
	component.handleInput(RIGHT);
	// Index 1 is notificationDelaySeconds (number, default 30)
	component.handleInput(DOWN);
	assert.equal(_state().inEditor, false);
	component.handleInput(ENTER);
	assert.equal(_state().inEditor, true, "Enter should open the editor");
	// Type "60" character by character
	component.handleInput("6");
	component.handleInput("0");
	component.handleInput(ENTER);
	assert.equal(changes.length, 1);
	assert.equal(changes[0].id, "notificationDelaySeconds");
	assert.equal(changes[0].value, 60);
	assert.equal(_state().inEditor, false, "editor should close after a valid commit");
});

test("Editor rejects non-numeric input and does NOT call onChange", () => {
	const { component, changes, _state, getError } = makeMenu();
	component.handleInput(DOWN);
	component.handleInput(RIGHT); // enter Notifications
	component.handleInput(DOWN); // index 1: notificationDelaySeconds
	component.handleInput(ENTER); // open editor
	// Type "abc" — Editor accepts arbitrary chars, but the menu must
	// reject on commit.
	component.handleInput("a");
	component.handleInput("b");
	component.handleInput("c");
	component.handleInput(ENTER);
	assert.equal(changes.length, 0, "non-numeric must not commit");
	assert.equal(_state().inEditor, true, "editor stays open on invalid commit");
	const err = getError();
	assert.ok(err, "expected an error message after invalid commit");
	assert.match(err, /number|invalid/i);
});

test("Editor rejects out-of-range number (negative)", () => {
	const { component, changes, _state, getError } = makeMenu();
	component.handleInput(DOWN);
	component.handleInput(RIGHT);
	component.handleInput(DOWN); // notificationDelaySeconds
	component.handleInput(ENTER);
	component.handleInput("-");
	component.handleInput("5");
	component.handleInput(ENTER);
	assert.equal(changes.length, 0, "-5 must not commit");
	assert.equal(_state().inEditor, true);
	assert.ok(getError(), "expected an error message");
});

test("Esc in the editor cancels and does NOT call onChange", () => {
	const { component, changes, _state } = makeMenu();
	component.handleInput(DOWN);
	component.handleInput(RIGHT);
	component.handleInput(DOWN); // notificationDelaySeconds
	component.handleInput(ENTER); // open editor
	component.handleInput("9");
	component.handleInput("9");
	component.handleInput(ESC); // cancel
	assert.equal(changes.length, 0);
	assert.equal(_state().inEditor, false);
});

// ---- String editor -------------------------------------------------------

test("Enter on a string setting opens an editor; Enter commits the typed text", () => {
	const { component, changes, _state } = makeMenu();
	// Navigate to TTS & Command (section index 2)
	component.handleInput(DOWN);
	component.handleInput(DOWN);
	component.handleInput(RIGHT);
	// Index 1 is onQuestionCommand (string, default "")
	component.handleInput(DOWN);
	component.handleInput(ENTER);
	assert.equal(_state().inEditor, true);
	component.handleInput("e");
	component.handleInput("c");
	component.handleInput("h");
	component.handleInput("o");
	component.handleInput(" ");
	component.handleInput("a");
	component.handleInput("s");
	component.handleInput("k");
	component.handleInput(ENTER);
	assert.equal(changes.length, 1);
	assert.equal(changes[0].id, "onQuestionCommand");
	assert.equal(changes[0].value, "echo ask");
});

// ---- Render --------------------------------------------------------------

test("render at section level shows all 5 section titles", () => {
	const { component } = makeMenu();
	const joined = component.render(80).join("\n");
	for (const s of DEFAULT_SECTIONS) {
		assert.match(joined, new RegExp(s.title), `expected to see section: ${s.title}`);
	}
});

test("render inside a section shows each setting label and current value", () => {
	const { component } = makeMenu();
	component.handleInput(RIGHT); // enter Browser
	const joined = component.render(80).join("\n");
	// Boolean true → "on"; false → "off"
	assert.match(joined, /Browser enabled/);
	assert.match(joined, /Auto-open browser/);
	assert.match(joined, /Min questions/);
	assert.match(joined, /Copy URL to clipboard/);
	// browserMinQuestions = 2 → "2"
	assert.match(joined, /\b2\b/);
});

test("render reflects the latest getCurrent() — onChange is picked up on next render", () => {
	// getCurrent is a closure that returns whatever the latest "saved"
	// settings are. Simulating the persistence layer.
	let live = { bellOnQuestion: true };
	const { component } = makeMenu({ getCurrent: () => live });
	let joined = component.render(80).join("\n");
	assert.match(joined, /AskUserQuestion settings/);
	// Enter Bell section (Question display, index 4)
	for (let i = 0; i < 4; i++) component.handleInput(DOWN);
	component.handleInput(RIGHT);
	// Index 0 is bellOnQuestion
	const before = component.render(80).join("\n");
	assert.match(before, /on/i);
	// Toggle — the production onChange callback would call saveSettings,
	// which updates the file, which the next getSettings() reads. We
	// simulate that here by mutating live.
	component.handleInput(SPACE);
	live = { bellOnQuestion: false };
	const after = component.render(80).join("\n");
	assert.match(after, /off/i);
});

// ---- dispose -------------------------------------------------------------

test("dispose() is safe to call multiple times", () => {
	const { component } = makeMenu();
	component.dispose();
	component.dispose(); // no throw
});

// ---- onExit fires only on full exit --------------------------------------

test("onExit is called only when the user backs out at the top level", () => {
	const exits = [];
	const { component } = makeMenu({ onExit: () => exits.push(true) });
	component.handleInput(RIGHT); // enter section — no exit
	component.handleInput(LEFT); // back to sections — no exit
	component.handleInput(ESC); // exit menu
	assert.deepEqual(exits, [true]);
});