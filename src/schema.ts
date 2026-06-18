// src/schema.ts
// Typebox schema + validation for the AskUserQuestion tool parameters.
// v2 surface: 5 question types, no aliases, no `required` field, max 4
// questions per call, max 7 user-provided options (so auto-Other = 8 max).

import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { MAX_HEADER_LENGTH, MAX_OPTIONS_PER_USER, MAX_QUESTIONS_PER_CALL } from "./types.ts";

const PreviewSchema = Type.Object({
	type: Type.Union([
		Type.Literal("markdown"),
		Type.Literal("code"),
		Type.Literal("text"),
		Type.Literal("mermaid"),
		Type.Literal("svg"),
		Type.Literal("html"),
	]),
	content: Type.String({ minLength: 1 }),
});

const OptionSchema = Type.Object({
	label: Type.String({ minLength: 1, maxLength: 200 }),
	description: Type.Optional(Type.String({ maxLength: 2000 })),
	preview: Type.Optional(PreviewSchema),
});

const QuestionSchema = Type.Object({
	id: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
	header: Type.String({ minLength: 1, maxLength: MAX_HEADER_LENGTH }),
	question: Type.String({ minLength: 1, maxLength: 4000 }),
	description: Type.Optional(Type.String({ maxLength: 4000 })),
	type: Type.Union([
		Type.Literal("select_one"),
		Type.Literal("select_many"),
		Type.Literal("confirm_enum"),
		Type.Literal("number"),
		Type.Literal("free_text"),
	]),
	options: Type.Optional(Type.Array(OptionSchema, { maxItems: MAX_OPTIONS_PER_USER })),
	default: Type.Optional(Type.Unknown()),
	min: Type.Optional(Type.Number()),
	max: Type.Optional(Type.Number()),
	placeholder: Type.Optional(Type.String({ maxLength: 200 })),
	multiline: Type.Optional(Type.Boolean()),
	is_dangerous: Type.Optional(Type.Boolean()),
});

export const AskUserQuestionParams = Type.Object({
	questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: MAX_QUESTIONS_PER_CALL }),
});

export type AskUserQuestionInput = Static<typeof AskUserQuestionParams>;

export interface ValidationError {
	ok: false;
	reason: string;
}

export interface ValidationOk<T> {
	ok: true;
	value: T;
}

export type Validation<T> = ValidationOk<T> | ValidationError;

const OLD_TYPE_NAMES: Record<string, string> = {
	single_select: "select_one",
	multi_select: "select_many",
	confirm: "confirm_enum",
	text: "free_text",
};

const ALIASES_REMOVED = ["prompt", "input_mode", "multi_select", "required", "markdown"] as const;

/** Detect a v1 payload (used for friendly migration errors). */
export function detectLegacyFields(input: unknown): string[] {
	if (input === null || typeof input !== "object") return [];
	const warnings: string[] = [];
	const root = input as Record<string, unknown>;
	const qs = Array.isArray(root.questions) ? root.questions : [];

	if (root.tool === "ask_user" || root.name === "ask_user") {
		warnings.push(
			"Tool name 'ask_user' is no longer supported; this tool is now 'AskUserQuestion'.",
		);
	}

	for (let i = 0; i < qs.length; i++) {
		const q = qs[i] as Record<string, unknown> | null;
		if (!q || typeof q !== "object") continue;
		if (typeof q.prompt === "string") {
			warnings.push(`Question ${i}: 'prompt' field removed; use 'question'.`);
		}
		if (typeof q.input_mode === "string") {
			warnings.push(
				`Question ${i}: 'input_mode' field removed; use 'type' with values 'select_one' | 'select_many' | 'free_text'.`,
			);
		}
		if (typeof q.multi_select === "boolean") {
			warnings.push(
				`Question ${i}: 'multi_select' field removed; use 'type'='select_many' instead of 'select_one'.`,
			);
		}
		if (typeof q.required === "boolean") {
			warnings.push(`Question ${i}: 'required' field removed; questions are always required.`);
		}
		if (Array.isArray(q.options)) {
			for (let j = 0; j < q.options.length; j++) {
				const opt = q.options[j] as Record<string, unknown> | null;
				if (opt && typeof opt.markdown === "string") {
					warnings.push(
						`Question ${i} option ${j}: 'markdown' field removed; use 'preview: {type:"markdown", content: ...}'.`,
					);
				}
			}
		}
		if (typeof q.type === "string" && q.type in OLD_TYPE_NAMES) {
			warnings.push(
				`Question ${i}: type '${q.type}' renamed to '${OLD_TYPE_NAMES[q.type]}'.`,
			);
		}
	}
	return warnings;
}

/** Run semantic checks beyond typebox. */
export function validateSemantics(input: AskUserQuestionInput): Validation<AskUserQuestionInput> {
	if (input.questions.length === 0) {
		return { ok: false, reason: "AskUserQuestion requires at least one question" };
	}
	if (input.questions.length > MAX_QUESTIONS_PER_CALL) {
		return {
			ok: false,
			reason: `AskUserQuestion accepts at most ${MAX_QUESTIONS_PER_CALL} questions per call (got ${input.questions.length})`,
		};
	}
	const seenIds = new Set<string>();
	for (let i = 0; i < input.questions.length; i++) {
		const q = input.questions[i];
		if (q.id) {
			if (seenIds.has(q.id)) {
				return { ok: false, reason: `Question ${i}: duplicate id "${q.id}"` };
			}
			seenIds.add(q.id);
		}
		if (q.header.length > MAX_HEADER_LENGTH) {
			return {
				ok: false,
				reason: `Question ${i}: header must be at most ${MAX_HEADER_LENGTH} characters (got ${q.header.length})`,
			};
		}
		if (q.type === "select_one" || q.type === "select_many") {
			if (!q.options || q.options.length === 0) {
				return { ok: false, reason: `Question ${i}: type '${q.type}' requires at least one option` };
			}
			if (q.options.length > MAX_OPTIONS_PER_USER) {
				return {
					ok: false,
					reason: `Question ${i}: at most ${MAX_OPTIONS_PER_USER} options allowed (got ${q.options.length})`,
				};
			}
		}
		if (q.type === "number") {
			if (q.options !== undefined) {
				return {
					ok: false,
					reason: `Question ${i}: type 'number' does not accept options`,
				};
			}
			if (q.min !== undefined && q.max !== undefined && q.min > q.max) {
				return {
					ok: false,
					reason: `Question ${i}: min (${q.min}) must be <= max (${q.max})`,
				};
			}
		}
		if (q.type === "free_text") {
			if (q.options !== undefined) {
				return {
					ok: false,
					reason: `Question ${i}: type 'free_text' does not accept options`,
				};
			}
		}
	}
	return { ok: true, value: input };
}

/** Names of fields that v2 removed. Exported for documentation and tests. */
export const REMOVED_FIELDS = [...ALIASES_REMOVED] as const;

/** Validate input strictly against the AskUserQuestionParams typebox schema.
 * Returns a clear reason string on the first violation. Used by the harness
 * (and could be wired into the tool entrypoint) to surface type mismatches
 * like `is_dangerous: "yes"`. */
export function validateSchema(input: unknown): Validation<AskUserQuestionInput> {
	if (input === null || typeof input !== "object") {
		return { ok: false, reason: "AskUserQuestion input must be an object" };
	}
	const check = Value.Check(AskUserQuestionParams, input);
	if (check) return { ok: true, value: input as AskUserQuestionInput };
	const errs = Value.Errors(AskUserQuestionParams, input);
	const first = errs[0];
	const path = first?.instancePath && first.instancePath.length > 0 ? first.instancePath : "<root>";
	return { ok: false, reason: `${path}: ${first?.message ?? "schema violation"}` };
}
