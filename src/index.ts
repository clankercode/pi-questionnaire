// src/index.ts
// Pi extension entry point. Registers the `ask_user` tool.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { AskUserParams, validateSemantics } from "./schema.ts";
import { normalizeQuestions } from "./normalize.ts";
import { buildQuestionnaireComponent, type TuiResult } from "./tui.ts";
import { isHeadless, loadHeadlessAnswers } from "./headless.ts";
import type { AnswerMap, CanonicalQuestion, ToolResultDetails } from "./types.ts";

const NO_QUESTIONS_DETAILS = (
	questions: CanonicalQuestion[],
	reason: string,
): { content: { type: "text"; text: string }[]; details: ToolResultDetails } => ({
	content: [{ type: "text", text: reason }],
	details: { questions, answers: {}, cancelled: true, lifecycle: "rejected" },
});

function formatAnswers(questions: CanonicalQuestion[], answers: AnswerMap, notes?: Record<string, string>) {
	const lines: string[] = [];
	for (let i = 0; i < questions.length; i++) {
		const q = questions[i];
		const v = answers[String(i)];
		if (v === undefined || v === "") continue;
		const lbl = q.header;
		if (Array.isArray(v)) {
			lines.push(`${lbl}: ${v.join(", ")}`);
		} else {
			lines.push(`${lbl}: ${v}`);
		}
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
	let text = theme.fg("toolTitle", theme.bold("ask_user "));
	text += theme.fg("muted", `${questions.length} question${questions.length !== 1 ? "s" : ""}`);
	if (labels) text += theme.fg("dim", ` (${labels})`);
	return text;
}

function renderResultText(
	details: ToolResultDetails,
	theme: any,
): string {
	if (details.lifecycle === "cancelled") {
		return theme.fg("warning", "Cancelled");
	}
	if (details.lifecycle === "rejected") {
		return theme.fg("error", "Rejected (see tool result)");
	}
	const lines = details.questions.map((q, i) => {
		const v = details.answers[String(i)];
		if (v === undefined || v === "") return null;
		if (Array.isArray(v)) {
			return `${theme.fg("success", "✓ ")}${theme.fg("accent", q.header)}: ${v.join(", ")}`;
		}
		return `${theme.fg("success", "✓ ")}${theme.fg("accent", q.header)}: ${v}`;
	}).filter((l): l is string => l !== null);
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description:
			"Ask the user one or more questions (max 4 per call) and collect structured answers. " +
			"Supports single_select, multi_select, text, confirm, and number question types. " +
			"Each option can carry a description and a rich preview (markdown/mermaid/svg/code). " +
			"Use for clarifying requirements, getting preferences, or confirming decisions. " +
			"Returns a canonical answer map: { \"0\": \"Staging\", \"1\": [\"A\",\"B\"], ... } — pag-server v2 compatible.",
		promptSnippet: "Ask the user one or more questions and collect structured answers",
		promptGuidelines: [
			"Use ask_user when you need structured input from the user (preferences, decisions, confirmations) before proceeding.",
			"Prefer ask_user for choices and confirmations; use plain text in chat for open-ended discussion.",
			"Each call can include 1 to 4 questions; for longer forms, break them into multiple ask_user calls.",
			"For single_select / multi_select, provide 2 to 8 options with concise labels and useful descriptions.",
			"Add a preview (markdown/mermaid/svg/code) when an option needs to show a code sample, diagram, or formatted spec.",
			"Use confirm for yes/no questions; use number for integer input with optional min/max; use text for free-form input.",
		],
		parameters: AskUserParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// 1. Semantic validation
			const sem = validateSemantics(params);
			if (!sem.ok) {
				return NO_QUESTIONS_DETAILS([], `Error: ${sem.reason}`);
			}
			// 2. Normalize questions into canonical v2 shape
			let questions: CanonicalQuestion[];
			try {
				questions = normalizeQuestions(params.questions as unknown as CanonicalQuestion[]);
			} catch (err) {
				return NO_QUESTIONS_DETAILS([], `Error: ${(err as Error).message}`);
			}

			// 3. Headless path — env var set, skip TUI
			if (isHeadless()) {
				const result = await loadHeadlessAnswers(questions);
				if (!result.ok) {
					return {
						content: [
							{
								type: "text",
								text: `Error loading headless answers from ${result.source}: ${result.errors.join("; ")}`,
							},
						],
						details: {
							questions,
							answers: result.answers,
							...(result.notes ? { notes: result.notes } : {}),
							cancelled: false,
							lifecycle: "rejected",
						},
					};
				}
				return {
					content: [
						{
							type: "text",
							text: `[headless] ${formatAnswers(questions, result.answers, result.notes)}`,
						},
					],
					details: {
						questions,
						answers: result.answers,
						...(result.notes ? { notes: result.notes } : {}),
						cancelled: false,
						lifecycle: "answered",
					},
				};
			}

			// 4. Non-tui mode (--print etc) — TUI unavailable
			if (ctx.mode !== "tui") {
				return {
					content: [
						{
							type: "text",
							text:
								"Error: ask_user requires interactive (tui) mode. " +
								"Set PI_QUESTIONNAIRE_ANSWERS_FILE=/path/to/answers.json to drive the tool headlessly in non-tui mode.",
						},
					],
					details: { questions, answers: {}, cancelled: true, lifecycle: "cancelled" },
				};
			}

			// 5. Interactive TUI
			const factory = buildQuestionnaireComponent({ questions });
			const result = await ctx.ui.custom<TuiResult>((tui, theme, kb, done) => factory(tui, theme, kb, done));

			if (!result || result.cancelled) {
				return {
					content: [{ type: "text", text: "User cancelled the questionnaire" }],
					details: { questions, answers: {}, cancelled: true, lifecycle: "cancelled" },
				};
			}

			// Convert array-of-answers back into the canonical AnswerMap shape.
			const answers: AnswerMap = {};
			for (let i = 0; i < questions.length; i++) {
				const a = result.answers.find((x) => x.id === questions[i].id);
				if (!a) continue;
				answers[String(i)] = a.value as never;
			}
			return {
				content: [{ type: "text", text: formatAnswers(questions, answers) }],
				details: { questions, answers, cancelled: false, lifecycle: "answered" },
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
