// src/index.ts
// Pi extension entry point. Registers the `AskUserQuestion` tool (v2).
// v2 surface: 5 question types, browser-sync URL, notes, persistent checkmarks.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { AskUserQuestionParams, validateSemantics } from "./schema.ts";
import { normalizeQuestions } from "./normalize.ts";
import { buildQuestionnaireComponent, type TuiResult } from "./tui.ts";
import { startBrowserSyncServer, type BrowserSyncServerHandle } from "./browser-server.ts";
import { fireBrowserUrlSideEffects, fireOnQuestionSideEffects, openBrowserUrl } from "./side-effects.ts";
import { getSettings, saveSettings } from "./settings.ts";
import {
	buildSettingsMenuComponent,
	DEFAULT_SECTIONS,
	type SettingsMenuValue,
} from "./settings-menu.ts";
import type { AnswerMap, CanonicalQuestion, ToolResultDetails } from "./types.ts";

function formatAnswers(
	questions: CanonicalQuestion[],
	answers: AnswerMap,
	notes?: Record<string, string>,
): string {
	const lines: string[] = [];
	for (let i = 0; i < questions.length; i++) {
		const q = questions[i];
		const v = answers[String(i)];
		if (v === undefined) continue;
		const lbl = q.header;
		let display: string;
		if (typeof v === "object" && v !== null && !Array.isArray(v) && "mode" in v) {
			const obj = v as { mode: string; value?: unknown; text?: string };
			if (obj.mode === "option") display = String(obj.value);
			else if (obj.mode === "other") display = `(Other) ${obj.text}`;
			else display = JSON.stringify(v);
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
		lines.push(`${lbl}: ${display}`);
	}
	if (notes) {
		for (const [k, v] of Object.entries(notes)) {
			const idx = Number(k);
			const q = questions[idx];
			if (q) lines.push(`note (${q.header}): ${v}`);
		}
	}
	return lines.join("\n") || "(no answers recorded)";
}

function renderCallText(questions: CanonicalQuestion[], theme: any) {
	const labels = questions.map((q) => q.header).join(", ");
	let text = theme.fg("toolTitle", theme.bold("AskUserQuestion "));
	text += theme.fg("muted", `${questions.length} question${questions.length !== 1 ? "s" : ""}`);
	if (labels) text += theme.fg("dim", ` (${labels})`);
	return text;
}

function renderResultText(details: ToolResultDetails, theme: any): string {
	if (details.lifecycle === "cancelled") {
		return theme.fg("warning", "Cancelled");
	}
	if (details.lifecycle === "rejected") {
		return theme.fg("error", "Rejected (see tool result)");
	}
	const lines: string[] = [];
	for (let i = 0; i < details.questions.length; i++) {
		const q = details.questions[i];
		const v = details.answers[String(i)];
		if (v === undefined) continue;
		let display: string;
		if (typeof v === "object" && v !== null && !Array.isArray(v) && "mode" in v) {
			const obj = v as { mode: string; value?: unknown; text?: string };
			if (obj.mode === "option") display = String(obj.value);
			else if (obj.mode === "other") display = `(Other) ${obj.text}`;
			else display = JSON.stringify(v);
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
		lines.push(
			`${theme.fg("success", "✓ ")}${theme.fg("accent", q.header)}: ${display}`,
		);
	}
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	registerSettingsCommand(pi);
	pi.registerTool({
		name: "AskUserQuestion",
		label: "AskUserQuestion",
		description:
			"Ask the user one or more questions (max 4 per call) and collect structured answers. " +
			"Supports select_one, select_many, confirm_enum, number, and free_text question types. " +
			"Each option can carry a description and a rich preview (markdown/code/mermaid/svg/html). " +
			"Use for clarifying requirements, getting preferences, or confirming decisions. " +
			"Returns a canonical answer map: { \"0\": {mode, value}, \"1\": [...], ... }.",
		promptSnippet: "Ask the user one or more questions and collect structured answers",
		promptGuidelines: [
			"Use AskUserQuestion when you need structured input from the user (preferences, decisions, confirmations) before proceeding.",
			"Prefer AskUserQuestion for choices and confirmations; use plain text in chat for open-ended discussion.",
			"Each call can include 1 to 4 questions; for longer forms, break them into multiple AskUserQuestion calls.",
			"For select_one / select_many, provide 2 to 7 options with concise labels and useful descriptions. The 'Other' option is auto-appended.",
			"Add a preview (markdown/code/mermaid/svg/html) when an option needs to show a code sample, diagram, or formatted spec.",
			"Use confirm_enum for yes/no/other questions; use number for integer/numeric input with optional min/max; use free_text for free-form input (always multiline).",
		],
		parameters: AskUserQuestionParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// 1. Semantic validation
			const sem = validateSemantics(params);
			if (!sem.ok) {
				return {
					content: [{ type: "text", text: `Error: ${sem.reason}` }],
					details: { questions: [], answers: {}, lifecycle: "rejected" },
				};
			}
			// 2. Normalize questions
			let questions: CanonicalQuestion[];
			try {
				questions = normalizeQuestions(params.questions as never);
			} catch (err) {
				return {
					content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
					details: { questions: [], answers: {}, lifecycle: "rejected" },
				};
			}

			// 3. Non-tui mode (--print etc) — TUI unavailable. The browser
			// path lands in slice 5+.
			if (ctx.mode !== "tui") {
				return {
					content: [
						{
							type: "text",
							text:
								"Error: AskUserQuestion requires interactive (tui) mode. " +
								"(Browser-driven headless mode lands in a later slice.)",
						},
					],
					details: { questions, answers: {}, lifecycle: "cancelled" },
				};
			}

			// 4. Start browser sync before the TUI mounts when settings allow.
			// The server is per-call and is stopped in the finally block below.
			const settings = getSettings();
			let browserHandle: BrowserSyncServerHandle | null = null;
			let activeComponent: any = null;
			if (settings.browserEnabled && questions.length >= settings.browserMinQuestions) {
				try {
					browserHandle = await startBrowserSyncServer({
						questions,
						onAnswer: (questionId, value) => activeComponent?.applyBrowserAnswer?.(questionId, value),
						onTab: (currentTab) => activeComponent?.applyBrowserTab?.(currentTab),
						onOptions: (options) => activeComponent?.applyBrowserOptions?.(options),
						onSubmit: () => activeComponent?.applyBrowserSubmit?.(),
						onCancel: () => activeComponent?.applyBrowserCancel?.(),
						log: (line) => console.warn(`[pi-questionnaire] ${line}`),
					});
				} catch (err) {
					console.warn(`[pi-questionnaire] Browser sync unavailable: ${(err as Error).message}`);
				}
			}

			// 5. Fire per-setting side effects (notification, TTS, command,
			// heartbeat, browser intent/copy/open, danger-check log). The handle
			// owns the heartbeat interval and any pending delayed notification timer;
			// we MUST call clear() on every return path below to release them.
			const sideEffects = fireOnQuestionSideEffects(params, pi);
			if (browserHandle) {
				fireBrowserUrlSideEffects(params, browserHandle.url, {
					log: (line) => console.warn(`[pi-questionnaire] ${line}`),
				});
			}

			// 6. Interactive TUI
			const factory = buildQuestionnaireComponent({
				questions,
				onBrowserStateChange: (patch) => browserHandle?.updateFromTui(patch),
			});
			let result: TuiResult | undefined;
			try {
				result = await ctx.ui.custom<TuiResult>((tui, theme, kb, done) => {
					const component = factory(tui, theme, kb, done);
					activeComponent = component;
					if (browserHandle) {
						component.setBrowserUrl?.(browserHandle.url);
						component.setBrowserOpenHandler?.((url: string) => openBrowserUrl(url, {
							log: (line) => console.warn(`[pi-questionnaire] ${line}`),
						}));
					}
					return component;
				});
			} finally {
				// Release timers and the per-call browser server even if the TUI throws
				// or the session aborts mid-render.
				sideEffects.clear();
				await browserHandle?.stop();
			}

			if (!result || result.lifecycle === "cancelled") {
				return {
					content: [{ type: "text", text: "User cancelled the questionnaire" }],
					details: {
						questions,
						answers: {},
						lifecycle: "cancelled",
						url: browserHandle?.url ?? null,
						port: browserHandle?.port ?? null,
					},
				};
			}

			// Convert array-of-answers back into the AnswerMap shape.
			const answers: AnswerMap = {};
			for (let i = 0; i < questions.length; i++) {
				const a = result.answers.find((x) => x.id === questions[i].id);
				if (a) answers[String(i)] = a.value;
			}
			// debounceMs lives on the answered details so the TUI (or any
			// downstream consumer) can read the active value at submit
			// time. We re-read getSettings() live here for the same
			// reason: if the user changed it mid-questionnaire, the value
			// on the result reflects the moment-of-answer, not the
			// moment-of-mount.
			return {
				content: [
					{
						type: "text",
						text: formatAnswers(questions, answers, result.notes),
					},
				],
				details: {
					questions,
					answers,
					...(result.notes ? { notes: result.notes } : {}),
					lifecycle: "answered",
					url: browserHandle?.url ?? null,
					port: browserHandle?.port ?? null,
					debounceMs: getSettings().debounceMs,
				} as ToolResultDetails & { debounceMs: number },
			};
		},

		renderCall(args, theme) {
			const qs = (args?.questions as CanonicalQuestion[] | undefined) ?? [];
			return new Text(renderCallText(qs, theme), 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as ToolResultDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			return new Text(renderResultText(details, theme), 0, 0);
		},
	});
}

/**
 * Register `/settings-ask-user-question` — a two-level TUI menu (section
 * picker → setting list) that lets the user tweak the 13 fields in
 * src/settings.ts. Each change is persisted to <cwd>/.pi/ask-user-question.json
 * via the existing saveSettings() path.
 *
 * Requires TUI mode (the same constraint as the AskUserQuestion tool
 * itself). In headless / print mode the command emits a notification.
 */
function registerSettingsCommand(pi: ExtensionAPI): void {
	pi.registerCommand("settings-ask-user-question", {
		description:
			"Configure the AskUserQuestion extension (browser, notifications, TTS, heartbeat, debounce, danger check).",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify(
					"AskUserQuestion settings menu requires interactive (tui) mode.",
					"warning",
				);
				return;
			}
			await ctx.ui.custom<{ lifecycle: "exited" }>((tui, theme, kb, done) =>
				buildSettingsMenuComponent({
					sections: DEFAULT_SECTIONS,
					getCurrent: () => getSettings(),
					onChange: (id, value: SettingsMenuValue) => {
						// Read the current merged view, apply the patch, and
						// write the FULL merged view back. The next
						// getSettings() call picks up the change immediately
						// because saveSettings writes synchronously.
						const updated = { ...getSettings(), [id]: value };
						saveSettings(updated);
					},
				})(tui, theme, kb, done),
			);
		},
	});
}
