// tests/_demo.mjs
// One-shot render of the new v2 TUI surfaces, for demoing. Uses the same
// fake-tui pattern as the test files. Run with:
//   node --import tsx tests/_demo.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	buildSettingsMenuComponent,
	DEFAULT_SECTIONS,
} from "../src/settings-menu.ts";
import { buildQuestionnaireComponent } from "../src/tui.ts";

function makeFakeTui() {
	return {
		requestRender: () => {},
		terminal: { rows: 30, cols: 90 },
	};
}

const theme = {
	bold: (s) => `\x1b[1m${s}\x1b[0m`,
	fg: (color, s) => {
		const codes = {
			accent: 36, // cyan
			muted: 90, // bright black
			dim: 90,
			warning: 33, // yellow
			success: 32, // green
			text: 0,
		};
		const c = codes[color] ?? 0;
		return c ? `\x1b[${c}m${s}\x1b[0m` : s;
	},
};

function hr(title) {
	const line = "─".repeat(78);
	console.log("\n" + line);
	console.log("  " + title);
	console.log(line);
}

function printBlock(label, lines) {
	console.log("\n┌─ " + label + " " + "─".repeat(Math.max(0, 74 - label.length)));
	for (const l of lines) console.log("│ " + l);
	console.log("└" + "─".repeat(77));
}

// ============================================================================
// 1. Settings menu — section picker
// ============================================================================
hr("1. Settings menu — section picker (top level)");

{
	const factory = buildSettingsMenuComponent({
		sections: DEFAULT_SECTIONS,
		getCurrent: () => ({
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
		}),
		onChange: () => {},
	});
	const captured = [];
	const component = factory(makeFakeTui(), theme, {}, () => {});
	printBlock("/settings-ask-user-question (default state)", component.render(80));
}

// ============================================================================
// 2. Settings menu — inside "Notifications" section
// ============================================================================
hr("2. Settings menu — drilled into Notifications section");

{
	const factory = buildSettingsMenuComponent({
		sections: DEFAULT_SECTIONS,
		getCurrent: () => ({
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
		}),
		onChange: () => {},
	});
	const tui = makeFakeTui();
	const component = factory(tui, theme, {}, () => {});
	// Navigate down once to "Notifications", then enter it.
	component.handleInput("\x1b[B"); // down
	component.handleInput("\r"); // enter
	printBlock("Inside Notifications (notificationOnQuestion highlighted)", component.render(80));
}

// ============================================================================
// 3. Settings menu — inline editor for a number setting
// ============================================================================
hr("3. Settings menu — inline editor (notificationDelaySeconds = 120)");

{
	const factory = buildSettingsMenuComponent({
		sections: DEFAULT_SECTIONS,
		getCurrent: () => ({
			browserEnabled: true,
			browserAutoOpen: false,
			browserMinQuestions: 2,
			copyUrlToClipboard: true,
			bellOnQuestion: true,
			notificationOnQuestion: true,
			notificationDelaySeconds: 30,
			ttsOnQuestion: false,
			onQuestionCommand: "",
			heartbeatWhileActive: false,
			heartbeatIntervalMinutes: 4.5,
			debounceMs: 300,
			dangerCheckEnabled: true,
		}),
		onChange: () => {},
	});
	const tui = makeFakeTui();
	const component = factory(tui, theme, {}, () => {});
	component.handleInput("\x1b[B"); // → Notifications
	component.handleInput("\r"); // enter
	component.handleInput("\x1b[B"); // → notificationDelaySeconds
	component.handleInput("\r"); // open editor
	component.setEditorText("120");
	printBlock("Inline editor with '120' typed; current value shown as hint", component.render(80));
}

// ============================================================================
// 4. AskUserQuestion — single select_one with preview
// ============================================================================
hr("4. AskUserQuestion — single select_one with markdown preview");

{
	const factory = buildQuestionnaireComponent({
		questions: [
			{
				id: "q1",
				header: "DB",
				question: "Which database should we use?",
				description: "Pick the engine you want the new service to talk to.",
				type: "select_one",
				options: [
					{
						label: "PostgreSQL",
						description: "Mature, transactional, great for relational data.",
						preview: {
							type: "markdown",
							content:
								"## PostgreSQL\n\n- ACID transactions\n- JSONB columns\n- Rich extension ecosystem",
						},
					},
					{
						label: "SQLite",
						description: "Embedded, zero-config, ideal for small services.",
					},
					{
						label: "DuckDB",
						description: "OLAP-focused, fast for analytics workloads.",
						preview: {
							type: "code",
							content:
								"SELECT region, AVG(latency_ms)\nFROM events\nWHERE ts > now() - INTERVAL 1 HOUR\nGROUP BY region;",
						},
					},
				],
			},
		],
	});
	const tui = makeFakeTui();
	const captured = [];
	const component = factory(tui, theme, {}, () => {});
	// Patch setBrowserUrl / setBrowserUrl to no-op for demo.
	if (component.setBrowserUrl) component.setBrowserUrl("http://127.0.0.1:54321/q/abc123?nonce=xyz");
	// Render twice so the duration timer is at >0s, but force askedAt to 0
	// so the timer shows a small value.
	const lines = component.render(80);
	printBlock("select_one: PostgreSQL highlighted, 1. Markdown preview shown collapsed", lines);
}

// ============================================================================
// 5. AskUserQuestion — is_dangerous confirmation flow
// ============================================================================
hr("5. AskUserQuestion — is_dangerous confirmation flow");

{
	const factory = buildQuestionnaireComponent({
		questions: [
			{
				id: "drop",
				header: "Drop DB",
				question: "Drop the production database?",
				description: "This is irreversible. All tables, indexes, and backups will be removed.",
				type: "free_text",
				is_dangerous: true,
			},
		],
	});
	const tui = makeFakeTui();
	const component = factory(tui, theme, {}, () => {});
	// Type "production" in the danger editor.
	for (const ch of "production") {
		component.handleInput(ch);
	}
	const lines = component.render(80);
	printBlock("is_dangerous: ⚠️ DESTRUCTIVE header, editor pre-fill, Enter required to commit", lines);
}

// ============================================================================
// 6. AskUserQuestion — multi_select with [Select] button
// ============================================================================
hr("6. AskUserQuestion — multi_select with persistent checkmarks + [Select] button");

{
	const factory = buildQuestionnaireComponent({
		questions: [
			{
				id: "q1",
				header: "Tags",
				question: "Which categories should this issue fall under?",
				type: "select_many",
				options: [
					{ label: "bug", description: "Something is broken." },
					{ label: "feature", description: "New capability request." },
					{ label: "docs", description: "Documentation update." },
					{ label: "perf", description: "Performance issue." },
				],
			},
		],
	});
	const tui = makeFakeTui();
	const component = factory(tui, theme, {}, () => {});
	// Toggle "bug" (1) and "perf" (4).
	component.handleInput("1");
	component.handleInput("4");
	const lines = component.render(80);
	printBlock("multi_select: bug + perf checked (■), [Select] button at bottom", lines);
}

// ============================================================================
// 7. AskUserQuestion — confirm_enum
// ============================================================================
hr("7. AskUserQuestion — confirm_enum (defaults to Affirm / Decline + auto-Other)");

{
	const factory = buildQuestionnaireComponent({
		questions: [
			{
				id: "q1",
				header: "Deploy",
				question: "Deploy to production now?",
				type: "confirm_enum",
			},
		],
	});
	const tui = makeFakeTui();
	const component = factory(tui, theme, {}, () => {});
	const lines = component.render(80);
	printBlock("confirm_enum: Affirm / Decline / Other (auto-injected)", lines);
}

// ============================================================================
// 8. Keymap summary
// ============================================================================
hr("8. Keymap (AskUserQuestion + settings menu)");

console.log(`
AskUserQuestion TUI
  ↑/↓            navigate options within a question
  1-9            jump to option N (within current question; auto-clamped)
  Space          multi_select only: toggle the focused option
  0              jump to Submit tab
  [ / ]          prev / next tab (multi-question only)
  Meta+1..4      jump to question N (Alt on Linux/Windows, Cmd on Mac)
  Tab / n        open notes editor for current question
  Enter (notes)  save notes & stay
  Esc (notes)    discard notes
  e              expand/collapse the focused option's preview
  o              open browser URL in the default browser (slice 5+)
  ?              toggle the help overlay
  Enter          commit current value / submit on the Submit tab
  Esc            cancel the whole questionnaire
  is_dangerous
    Enter        commit ONLY if editor text is non-empty
    Esc          cancel whole questionnaire (atomic)

Settings menu (/settings-ask-user-question)
  ↑/↓            navigate sections / settings
  → / Enter      enter section (or open editor for number/string)
  ← / Esc        back one level (or exit at top)
  Space          toggle boolean
  Editor
    Enter        commit (validates number ranges; rejects non-numeric)
    Esc          cancel the edit
`);
