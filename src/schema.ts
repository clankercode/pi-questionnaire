// src/schema.ts
// Typebox schema + validation for the ask_user tool parameters.
// Mirrors pag-server v2 (input_mode, options, preview) and extends with confirm + number.

import { Type } from "typebox";
import {
	MAX_HEADER_LENGTH,
	MAX_OPTIONS_PER_SELECT,
	MAX_QUESTIONS_PER_CALL,
	type QuestionType,
} from "./types.ts";

const PreviewSchema = Type.Object({
	type: Type.Union([
		Type.Literal("markdown"),
		Type.Literal("mermaid"),
		Type.Literal("svg"),
		Type.Literal("code"),
	]),
	content: Type.String({ minLength: 1 }),
});

const OptionSchema = Type.Object({
	label: Type.String({ minLength: 1, maxLength: 200 }),
	description: Type.Optional(Type.String({ maxLength: 2000 })),
	preview: Type.Optional(PreviewSchema),
	// pag-server v1 compat:
	markdown: Type.Optional(Type.String()),
});

const QuestionSchema = Type.Object({
	id: Type.String({ minLength: 1, maxLength: 64 }),
	header: Type.Optional(Type.String({ maxLength: MAX_HEADER_LENGTH })),
	question: Type.String({ minLength: 1, maxLength: 4000 }),
	// Our richer type:
	type: Type.Optional(
		Type.Union([
			Type.Literal("single_select"),
			Type.Literal("multi_select"),
			Type.Literal("text"),
			Type.Literal("confirm"),
			Type.Literal("number"),
		]),
	),
	// pag-server v2 alias:
	input_mode: Type.Optional(
		Type.Union([
			Type.Literal("single_select"),
			Type.Literal("multi_select"),
			Type.Literal("text"),
		]),
	),
	// pag-server v1 alias:
	multi_select: Type.Optional(Type.Boolean()),
	options: Type.Optional(Type.Array(OptionSchema, { maxItems: MAX_OPTIONS_PER_SELECT })),
	default: Type.Optional(Type.Unknown()),
	required: Type.Optional(Type.Boolean({ default: true })),
	min: Type.Optional(Type.Number()),
	max: Type.Optional(Type.Number()),
	placeholder: Type.Optional(Type.String({ maxLength: 200 })),
	multiline: Type.Optional(Type.Boolean()),
});

export const AskUserParams = Type.Object({
	questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: MAX_QUESTIONS_PER_CALL }),
});

export type AskUserInput = Static<typeof AskUserParams>;

// typebox Static helper re-export
import type { Static } from "typebox";

export interface ValidationError {
	ok: false;
	reason: string;
}

export interface ValidationOk<T> {
	ok: true;
	value: T;
}

export type Validation<T> = ValidationOk<T> | ValidationError;

/** Lightweight runtime check; typebox is the source of truth for shape but we
 * add semantic checks (min<max, options present for select types, etc.). */
export function validateSemantics(input: AskUserInput): Validation<AskUserInput> {
	if (input.questions.length === 0) {
		return { ok: false, reason: "questions must not be empty" };
	}
	if (input.questions.length > MAX_QUESTIONS_PER_CALL) {
		return {
			ok: false,
			reason: `questions exceeds the per-call cap of ${MAX_QUESTIONS_PER_CALL} (got ${input.questions.length})`,
		};
	}
	const seenIds = new Set<string>();
	for (let i = 0; i < input.questions.length; i++) {
		const q = input.questions[i];
		if (seenIds.has(q.id)) {
			return { ok: false, reason: `Question ${i}: duplicate id "${q.id}"` };
		}
		seenIds.add(q.id);
		if ((q.header?.length ?? 0) > MAX_HEADER_LENGTH) {
			return { ok: false, reason: `Question ${i}: header must be at most ${MAX_HEADER_LENGTH} characters` };
		}
		const t = resolveType(q.type, q.input_mode, q.multi_select === true, q.options);
		if (t === "invalid") {
			return { ok: false, reason: `Question ${i}: invalid type/input_mode` };
		}
		if (needsOptions(t)) {
			if (!q.options || q.options.length < 2) {
				return { ok: false, reason: `Question ${i}: ${t} requires at least 2 options` };
			}
			if (q.options.length > MAX_OPTIONS_PER_SELECT) {
				return {
					ok: false,
					reason: `Question ${i}: at most ${MAX_OPTIONS_PER_SELECT} options allowed (got ${q.options.length})`,
				};
			}
		}
		if (t === "number") {
			if (q.min !== undefined && q.max !== undefined && q.min > q.max) {
				return { ok: false, reason: `Question ${i}: min (${q.min}) must be <= max (${q.max})` };
			}
		}
	}
	return { ok: true, value: input };
}

export function resolveType(
	explicit: string | undefined,
	inputMode: string | undefined,
	legacyMulti: boolean,
	_options: unknown,
): QuestionType | "invalid" {
	if (explicit === "single_select" || inputMode === "single_select") return "single_select";
	if (explicit === "multi_select" || inputMode === "multi_select") return "multi_select";
	if (explicit === "text" || inputMode === "text") return "text";
	if (explicit === "confirm") return "confirm";
	if (explicit === "number") return "number";
	// Legacy / untyped
	if (inputMode === undefined && explicit === undefined) {
		if (legacyMulti) return "multi_select";
		// No type info: default to text (most flexible)
		return "text";
	}
	return "invalid";
}

export function needsOptions(t: QuestionType): boolean {
	return t === "single_select" || t === "multi_select";
}
