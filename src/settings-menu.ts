// src/settings-menu.ts
// Settings menu for the AskUserQuestion pi extension.
//
// Surfaces the 13 settings in src/settings.ts under the slash command
// /settings-ask-user-question. Two-level TUI: a section picker (5
// groups) and per-section setting lists. Boolean settings toggle with
// Space; number / string settings open an inline Editor that commits on
// Enter and validates on submit.
//
// Persistence: the caller is expected to wire `onChange` to saveSettings
// (or write the full merged view back to the project file). The menu
// itself never touches disk — see src/index.ts for the wiring.
//
// Left/right arrow semantics:
//   - At the section picker: right or Enter enters the highlighted
//     section; left or Esc exits the menu (calls `done`).
//   - Inside a section: left or Esc returns to the section picker.
//   - Inside an editor: Esc cancels the edit; Enter commits.
//
// Visual design follows ~/.llm-general/ai-coding/pi/pi-tui-menus.md:
// "left/right arrow should go back/forward in the menu structure".

import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
} from "@earendil-works/pi-tui";
import type { AskUserQuestionSettings } from "./settings.ts";

// --------------------------------------------------------------------------
// Section / setting definitions
// --------------------------------------------------------------------------

/** A single setting's UI metadata. The `id` is the field name in
 *  AskUserQuestionSettings. */
export interface SettingDef {
	id: keyof AskUserQuestionSettings;
	label: string;
	type: "boolean" | "number" | "string";
	/** Inclusive lower bound for numbers. */
	min?: number;
	/** Inclusive upper bound for numbers. */
	max?: number;
	/** Placeholder text shown in the editor for strings/numbers. */
	placeholder?: string;
	/** Optional helper text rendered under the label. */
	description?: string;
}

/** A section (group of settings) shown in the section picker. */
export interface SectionDef {
	title: string;
	settings: SettingDef[];
}

/** The 5-section, 13-setting default layout. Tests and the extension
 *  both reference this; the caller can also pass a custom layout to
 *  buildSettingsMenuComponent. */
export const DEFAULT_SECTIONS: SectionDef[] = [
	{
		title: "Browser",
		settings: [
			{
				id: "browserEnabled",
				label: "Browser enabled",
				type: "boolean",
				description: "Render an external browser page alongside the TUI.",
			},
			{
				id: "browserAutoOpen",
				label: "Auto-open browser",
				type: "boolean",
				description: "Open the browser page automatically when the questionnaire mounts.",
			},
			{
				id: "browserMinQuestions",
				label: "Min questions to auto-open",
				type: "number",
				min: 1,
				max: 4,
			},
			{
				id: "copyUrlToClipboard",
				label: "Copy URL to clipboard",
				type: "boolean",
			},
		],
	},
	{
		title: "Notifications",
		settings: [
			{ id: "notificationOnQuestion", label: "Notify on question", type: "boolean" },
			{
				id: "notificationDelaySeconds",
				label: "Notification delay (seconds)",
				type: "number",
				min: 0,
				max: 300,
			},
		],
	},
	{
		title: "TTS & Command",
		settings: [
			{ id: "ttsOnQuestion", label: "Speak via TTS on question", type: "boolean" },
			{
				id: "onQuestionCommand",
				label: "Shell command on question",
				type: "string",
				placeholder: "e.g. echo asked",
			},
		],
	},
	{
		title: "Heartbeat & Debounce",
		settings: [
			{ id: "heartbeatWhileActive", label: "Heartbeat while active", type: "boolean" },
			{
				id: "heartbeatIntervalMinutes",
				label: "Heartbeat interval (minutes)",
				type: "number",
				min: 0.5,
				max: 60,
			},
			{
				id: "debounceMs",
				label: "Input debounce (ms)",
				type: "number",
				min: 0,
				max: 10_000,
			},
		],
	},
	{
		title: "Question display",
		settings: [
			{ id: "bellOnQuestion", label: "Audible bell on question", type: "boolean" },
			{ id: "dangerCheckEnabled", label: "Danger check enabled", type: "boolean" },
		],
	},
];

// --------------------------------------------------------------------------
// Component factory
// --------------------------------------------------------------------------

export type SettingsMenuValue = boolean | number | string;

export interface BuildSettingsMenuComponentOptions {
	sections: SectionDef[];
	/** Called on every render and on every edit so the menu always
	 *  shows the latest saved values. Returns the merged view. */
	getCurrent: () => AskUserQuestionSettings;
	/** Called when the user commits a change. The caller is responsible
	 *  for persistence (typically saveSettings(getSettings() ∪ patch)). */
	onChange: (id: keyof AskUserQuestionSettings, value: SettingsMenuValue) => void;
	/** Optional callback fired when the user backs out at the top level. */
	onExit?: () => void;
}

export interface SettingsMenuResult {
	lifecycle: "exited";
}

type ViewMode = "sections" | "settings" | "editor";

interface SettingsMenuState {
	mode: ViewMode;
	sectionIndex: number;
	settingIndex: number;
	inEditor: boolean;
}

/** Build a TUI component for the settings menu. Returns a function
 *  with the signature expected by `ctx.ui.custom()`. The returned
 *  component also exposes `_state`, `getEditorText`, `setEditorText`,
 *  and `getError` for tests. */
export function buildSettingsMenuComponent(opts: BuildSettingsMenuComponentOptions) {
	return (
		tui: any,
		theme: any,
		_kb: any,
		done: (result: SettingsMenuResult) => void,
	 ) => {
		const sections = opts.sections;
		if (sections.length === 0) {
			throw new Error("settings-menu requires at least one section");
		}

		const state: SettingsMenuState = {
			mode: "sections",
			sectionIndex: 0,
			settingIndex: 0,
			inEditor: false,
		};
		let error: string | null = null;
		let errorTimer: ReturnType<typeof setTimeout> | null = null;

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
		// Disable multi-line submit — we use Enter to commit a single
		// value. The Editor's default is shift+enter for newlines;
		// backslash+enter is a "submit without newline" escape hatch
		// we don't want here. `disableSubmit` keeps the contract simple:
		// Enter always commits, Esc always cancels.
		editor.disableSubmit = true;

		function refresh() {
			tui.requestRender();
		}

		function showError(msg: string) {
			error = msg;
			if (errorTimer) clearTimeout(errorTimer);
			errorTimer = setTimeout(() => {
				error = null;
				errorTimer = null;
				refresh();
			}, 3000);
			// Don't keep Node alive just for the error tooltip.
			const handle = errorTimer as unknown as { unref?: () => void };
			if (typeof handle?.unref === "function") handle.unref();
		}

		function currentSection(): SectionDef | undefined {
			return sections[state.sectionIndex];
		}
		function currentSetting(): SettingDef | undefined {
			const s = currentSection();
			return s?.settings[state.settingIndex];
		}

		function formatValue(value: unknown, type: "boolean" | "number" | "string"): string {
			if (type === "boolean") return value ? "on" : "off";
			if (type === "number") return String(value);
			if (type === "string") return value === "" || value === undefined ? "(empty)" : String(value);
			return String(value);
		}

		function toggleBoolean() {
			const s = currentSetting();
			if (!s || s.type !== "boolean") return;
			const cur = opts.getCurrent()[s.id];
			const next = !cur;
			opts.onChange(s.id, next);
			refresh();
		}

		function openEditor() {
			const s = currentSetting();
			if (!s) return;
			if (s.type === "boolean") {
				toggleBoolean();
				return;
			}
			// Start empty so typing "60" doesn't append to "30" and produce
			// "3060". The current value is rendered above as a hint line.
			editor.setText("");
			error = null;
			state.inEditor = true;
			refresh();
		}

		function commitEditor() {
			const s = currentSetting();
			if (!s) return;
			const raw = editor.getText();
			if (s.type === "string") {
				opts.onChange(s.id, raw);
				state.inEditor = false;
				editor.setText("");
				error = null;
				refresh();
				return;
			}
			// number
			const trimmed = raw.trim();
			if (trimmed === "") {
				showError("Must be a number");
				return;
			}
			const n = Number(trimmed);
			if (!Number.isFinite(n)) {
				showError(`Not a number: "${raw}"`);
				return;
			}
			if (s.min !== undefined && n < s.min) {
				showError(`Must be ≥ ${s.min}`);
				return;
			}
			if (s.max !== undefined && n > s.max) {
				showError(`Must be ≤ ${s.max}`);
				return;
			}
			opts.onChange(s.id, n);
			state.inEditor = false;
			editor.setText("");
			error = null;
			refresh();
		}

		function cancelEditor() {
			state.inEditor = false;
			editor.setText("");
			error = null;
			refresh();
		}

		function exitMenu() {
			opts.onExit?.();
			done({ lifecycle: "exited" });
		}

		// ---- render ----------------------------------------------------

		function renderSections(width: number): string[] {
			const lines: string[] = [];
			lines.push(theme.bold(theme.fg("accent", "AskUserQuestion settings")));
			lines.push("");
			for (let i = 0; i < sections.length; i++) {
				const s = sections[i];
				const selected = i === state.sectionIndex;
				const cursor = selected ? theme.fg("accent", "▶ ") : "  ";
				const label = `${cursor}${s.title}`;
				const count = theme.fg("muted", `  (${s.settings.length})`);
				lines.push(theme.fg(selected ? "accent" : "text", label) + count);
			}
			lines.push("");
			if (error) {
				lines.push(theme.fg("warning", `! ${error}`));
				lines.push("");
			}
			lines.push(
				theme.fg(
					"muted",
					"↑↓ navigate · Enter/→ enter section · ←/Esc exit",
				),
			);
			return lines;
		}

		function renderSettings(width: number): string[] {
			const section = currentSection();
			if (!section) return [];
			const current = opts.getCurrent();
			const lines: string[] = [];
			lines.push(theme.fg("muted", "‹ back"));
			lines.push(theme.bold(theme.fg("accent", section.title)));
			lines.push("");
			for (let i = 0; i < section.settings.length; i++) {
				const s = section.settings[i];
				const selected = i === state.settingIndex;
				const cursor = selected ? theme.fg("accent", "▶ ") : "  ";
				const labelText = `${cursor}${s.label}`;
				lines.push(theme.fg(selected ? "accent" : "text", labelText));
				const valueText = formatValue(current[s.id], s.type);
				const rightHint =
					s.type === "boolean"
						? theme.fg("muted", "[Space]")
						: theme.fg("muted", "[Enter]");
				lines.push(
					`    ${theme.fg("muted", valueText)}  ${rightHint}`,
				);
				if (selected && s.description) {
					lines.push(`      ${theme.fg("dim", s.description)}`);
				}
				if (selected && s.type === "number") {
					const lo = s.min ?? "—";
					const hi = s.max ?? "—";
					lines.push(`      ${theme.fg("dim", `range: ${lo} … ${hi}`)}`);
				}
			}
			lines.push("");
			if (error) {
				lines.push(theme.fg("warning", `! ${error}`));
				lines.push("");
			}
			lines.push(
				theme.fg(
					"muted",
					"↑↓ navigate · Space toggle · Enter edit · ←/Esc back",
				),
			);
			return lines;
		}

		function renderEditor(width: number): string[] {
			const section = currentSection();
			const s = currentSetting();
			if (!section || !s) return [];
			const current = opts.getCurrent();
			const lines: string[] = [];
			lines.push(theme.fg("muted", `${section.title} ‹ ${s.label}`));
			lines.push(theme.bold(theme.fg("accent", `Edit ${s.label}`)));
			lines.push("");
			lines.push(
				theme.fg("muted", `Current: ${formatValue(current[s.id], s.type)}`),
			);
			if (s.min !== undefined || s.max !== undefined) {
				const lo = s.min ?? "—";
				const hi = s.max ?? "—";
				lines.push(theme.fg("muted", `Allowed: ${lo} … ${hi}`));
			}
			if (s.placeholder) {
				lines.push(theme.fg("dim", `Placeholder: ${s.placeholder}`));
			}
			lines.push("");
			lines.push(...editor.render(width));
			lines.push("");
			if (error) {
				lines.push(theme.fg("warning", `! ${error}`));
				lines.push("");
			}
			lines.push(theme.fg("muted", "Enter commit · Esc cancel"));
			return lines;
		}

		function render(width: number): string[] {
			if (state.inEditor) return renderEditor(width);
			if (state.mode === "sections") return renderSections(width);
			return renderSettings(width);
		}

		// ---- input -----------------------------------------------------

		function handleInput(data: string) {
			if (state.inEditor) {
				if (matchesKey(data, Key.escape)) {
					cancelEditor();
					return;
				}
				if (matchesKey(data, Key.enter)) {
					commitEditor();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			// Section picker
			if (state.mode === "sections") {
				if (matchesKey(data, Key.up)) {
					state.sectionIndex =
						(state.sectionIndex - 1 + sections.length) % sections.length;
					error = null;
					refresh();
					return;
				}
				if (matchesKey(data, Key.down)) {
					state.sectionIndex = (state.sectionIndex + 1) % sections.length;
					error = null;
					refresh();
					return;
				}
				if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
					state.mode = "settings";
					state.settingIndex = 0;
					error = null;
					refresh();
					return;
				}
				if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
					exitMenu();
					return;
				}
				return;
			}

			// Setting list
			const section = currentSection();
			if (!section) return;
			if (matchesKey(data, Key.up)) {
				state.settingIndex =
					(state.settingIndex - 1 + section.settings.length) %
					section.settings.length;
				error = null;
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				state.settingIndex = (state.settingIndex + 1) % section.settings.length;
				error = null;
				refresh();
				return;
			}
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
				state.mode = "sections";
				state.settingIndex = 0;
				error = null;
				refresh();
				return;
			}
			if (data === " ") {
				const s = currentSetting();
				if (s?.type === "boolean") toggleBoolean();
				return;
			}
			if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
				openEditor();
				return;
			}
		}

		function dispose() {
			if (errorTimer !== null) {
				clearTimeout(errorTimer);
				errorTimer = null;
			}
		}

		return {
			render,
			handleInput,
			invalidate: refresh,
			dispose,
			// Test introspection
			_state: () => ({ ...state }),
			getEditorText: () => editor.getText(),
			setEditorText: (text: string) => editor.setText(text),
			getError: () => error,
			// Test helper: how many sections + settings
			getLayout: () => ({
				sectionCount: sections.length,
				settingCount: sections.reduce((n, s) => n + s.settings.length, 0),
			}),
		};
	};
}

// Suppress unused-import lint for Text (kept for symmetry with tui.ts; in
// the future we may split renderers out and use Text components).
void Text;