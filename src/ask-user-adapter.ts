// src/ask-user-adapter.ts
// Adapter that maps the simpler `ask_user` tool schema (confirm/select/
// multiselect/input/batch) onto the richer AskUserQuestion questionnaire
// format so the LLM can call either name and get the same TUI experience.

import { Type } from "typebox";
import type { Static } from "typebox";
import { MAX_QUESTIONS_PER_CALL } from "./types.ts";

// ── ask_user schema ──────────────────────────────────────────────────

const QuestionMethod = Type.Union([
	Type.Literal("confirm"),
	Type.Literal("select"),
	Type.Literal("multiselect"),
	Type.Literal("input"),
]);

const SingleQuestion = Type.Object({
	method: QuestionMethod,
	title: Type.String({ minLength: 1, maxLength: 20 }),
	options: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 7 })),
	placeholder: Type.Optional(Type.String({ maxLength: 200 })),
	message: Type.Optional(Type.String({ maxLength: 4000 })),
});

const BatchQuestion = Type.Object({
	method: QuestionMethod,
	title: Type.String({ minLength: 1, maxLength: 20 }),
	options: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 7 })),
	placeholder: Type.Optional(Type.String({ maxLength: 200 })),
	message: Type.Optional(Type.String({ maxLength: 4000 })),
});

/** Schema for the built-in `ask_user` tool parameters. */
export const AskUserAdapterParams = Type.Object({
	method: Type.Optional(QuestionMethod),
	title: Type.Optional(Type.String({ minLength: 1, maxLength: 20 })),
	message: Type.Optional(Type.String({ maxLength: 4000 })),
	options: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 7 })),
	placeholder: Type.Optional(Type.String({ maxLength: 200 })),
	questions: Type.Optional(Type.Array(BatchQuestion, { minItems: 1, maxItems: MAX_QUESTIONS_PER_CALL })),
});

export type AskUserAdapterInput = Static<typeof AskUserAdapterParams>;

// ── adapter ──────────────────────────────────────────────────────────

interface AdaptedQuestion {
	id?: string;
	header: string;
	question: string;
	type: "select_one" | "select_many" | "confirm_enum" | "number" | "free_text";
	options?: { label: string }[];
	placeholder?: string;
}

function adaptSingle(
	method: string,
	title: string,
	message?: string,
	options?: string[],
	placeholder?: string,
): AdaptedQuestion {
	const question = message || title;
	switch (method) {
		case "confirm":
			return { header: title, question, type: "confirm_enum" };
		case "select":
			return {
				header: title,
				question,
				type: "select_one",
				options: (options ?? []).map((o) => ({ label: o })),
			};
		case "multiselect":
			return {
				header: title,
				question,
				type: "select_many",
				options: (options ?? []).map((o) => ({ label: o })),
			};
		case "input":
			return { header: title, question, type: "free_text", placeholder };
		default:
			return { header: title, question, type: "free_text", placeholder };
	}
}

/**
 * Convert `ask_user` parameters into the `AskUserQuestion` questions array.
 * Returns an error string if the input is invalid, or the adapted questions.
 */
export function adaptAskUserParams(input: AskUserAdapterInput): { ok: false; reason: string } | { ok: true; questions: AdaptedQuestion[] } {
	// batch mode
	if (input.questions && input.questions.length > 0) {
		const questions = input.questions.map((q, i) => ({
			...adaptSingle(q.method, q.title, q.message, q.options, q.placeholder),
			id: `q${i}`,
		}));
		return { ok: true, questions };
	}

	// single-question mode
	if (!input.method || !input.title) {
		return {
			ok: false,
			reason: "ask_user requires either 'questions' (batch) or both 'method' and 'title' (single).",
		};
	}

	return {
		ok: true,
		questions: [adaptSingle(input.method, input.title, input.message, input.options, input.placeholder)],
	};
}
