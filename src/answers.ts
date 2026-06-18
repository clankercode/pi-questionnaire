// src/answers.ts
// Answer validation + shaping for v2.
//
// v2 answer values are a discriminated union (AnswerValue):
//   - select_one     -> { mode:"option", value:string } | { mode:"other", text:string }
//   - select_many    -> [{ mode:"option", value:string } | { mode:"other", text:string }, ...]
//   - confirm_enum   -> { mode:"option", value:"affirm"|"decline" } | { mode:"other", text:string }
//   - number         -> number
//   - free_text      -> string
//
// This module also provides helpers for working with options in the
// normalized/canonical shape.

import type {
	AnswerMap,
	AnswerValue,
	CanonicalQuestion,
	ChoiceAnswer,
	ConfirmAnswer,
	RenderOption,
	SelectOption,
} from "./types.ts";
import { CONFIRM_AFFIRM, CONFIRM_DECLINE, isChoiceType, OTHER_LABEL } from "./types.ts";

/** Coerce a raw input value (from JSON / WS / env) into an AnswerValue.
 * Returns undefined if the value can't be coerced. */
export function coerceAnswer(raw: unknown, q: CanonicalQuestion): AnswerValue | undefined {
	if (raw === null || raw === undefined) return undefined;

	if (q.type === "select_one") {
		if (typeof raw === "string") {
			const trimmed = raw.trim();
			if (trimmed === "") return undefined;
			// Map "__other__" or "other" with empty text to undefined
			if (/^__other__$/i.test(trimmed)) return undefined;
			// If matches an option label, return option mode
			if (q.options?.some((o) => o.label === trimmed)) {
				return { mode: "option", value: trimmed };
			}
			// Otherwise treat as "Other" text
			return { mode: "other", text: trimmed };
		}
		// Object form: { mode, value/text }
		if (typeof raw === "object") {
			const obj = raw as { mode?: unknown; value?: unknown; text?: unknown; label?: unknown };
			if (obj.mode === "option" && typeof obj.value === "string") {
				return { mode: "option", value: obj.value };
			}
			if (obj.mode === "other" && typeof obj.text === "string") {
				return { mode: "other", text: obj.text };
			}
			// pag-server nested shape: { selected, other }
			if (typeof obj.label === "string" && typeof obj.text === "string") {
				return obj.label === OTHER_LABEL
					? { mode: "other", text: obj.text }
					: { mode: "option", value: obj.label };
			}
		}
		return undefined;
	}

	if (q.type === "select_many") {
		if (Array.isArray(raw)) {
			const out: ChoiceAnswer[] = [];
			for (const v of raw) {
				const c = coerceAnswer(v, { ...q, type: "select_one" });
				if (c && typeof c === "object" && !Array.isArray(c) && "mode" in c) {
					out.push(c as ChoiceAnswer);
				}
			}
			return out;
		}
		return undefined;
	}

	if (q.type === "confirm_enum") {
		if (typeof raw === "string") {
			const trimmed = raw.trim();
			if (trimmed === "") return undefined;
			if (trimmed === "affirm" || trimmed === CONFIRM_AFFIRM) {
				return { mode: "option", value: "affirm" };
			}
			if (trimmed === "decline" || trimmed === CONFIRM_DECLINE) {
				return { mode: "option", value: "decline" };
			}
			// Otherwise treat as "Other" text
			return { mode: "other", text: trimmed };
		}
		if (typeof raw === "boolean") {
			return { mode: "option", value: raw ? "affirm" : "decline" };
		}
		if (typeof raw === "object" && raw !== null) {
			const obj = raw as { mode?: unknown; value?: unknown; text?: unknown };
			if (obj.mode === "option" && (obj.value === "affirm" || obj.value === "decline")) {
				return { mode: "option", value: obj.value };
			}
			if (obj.mode === "other" && typeof obj.text === "string") {
				return { mode: "other", text: obj.text };
			}
		}
		return undefined;
	}

	if (q.type === "number") {
		const n = typeof raw === "number" ? raw : Number(raw);
		if (!Number.isFinite(n)) return undefined;
		if (q.min !== undefined && n < q.min) return undefined;
		if (q.max !== undefined && n > q.max) return undefined;
		return n;
	}

	// free_text
	if (typeof raw === "string") {
		return raw; // include empty if user submitted it
	}
	return undefined;
}

/** Validate that the parsed answers match the canonical questions' types.
 * Returns { ok, errors[] }. */
export function validateAgainstQuestions(
	questions: CanonicalQuestion[],
	answers: AnswerMap,
): { ok: boolean; errors: string[] } {
	const errors: string[] = [];
	for (let i = 0; i < questions.length; i++) {
		const q = questions[i];
		const v = answers[String(i)];
		if (v === undefined) {
			errors.push(`Question ${i} (${q.header}) is not answered`);
			continue;
		}
		const check = validateOne(q, v, i);
		if (check) errors.push(check);
	}
	return { ok: errors.length === 0, errors };
}

function validateOne(q: CanonicalQuestion, v: AnswerValue, i: number): string | null {
	if (q.type === "select_one") {
		if (typeof v !== "object" || v === null || Array.isArray(v)) {
			return `Question ${i}: expected option object`;
		}
		const obj = v as { mode?: unknown; value?: unknown; text?: unknown };
		if (obj.mode === "option") {
			if (typeof obj.value !== "string") return `Question ${i}: option value must be a string`;
			if (!q.options?.some((o) => o.label === obj.value)) {
				return `Question ${i}: option label "${obj.value}" not in options`;
			}
		} else if (obj.mode === "other") {
			if (typeof obj.text !== "string" || obj.text.trim() === "") {
				return `Question ${i}: other text must be a non-empty string`;
			}
		} else {
			return `Question ${i}: invalid mode "${obj.mode}"`;
		}
		return null;
	}
	if (q.type === "select_many") {
		if (!Array.isArray(v)) return `Question ${i}: expected an array of option objects`;
		for (let j = 0; j < v.length; j++) {
			const e = v[j];
			if (typeof e !== "object" || e === null) {
				return `Question ${i} item ${j}: expected option object`;
			}
			const obj = e as { mode?: unknown; value?: unknown; text?: unknown };
			if (obj.mode === "option" && !q.options?.some((o) => o.label === obj.value)) {
				return `Question ${i} item ${j}: option label "${obj.value}" not in options`;
			}
			if (obj.mode === "other" && (typeof obj.text !== "string" || obj.text.trim() === "")) {
				return `Question ${i} item ${j}: other text must be non-empty`;
			}
		}
		return null;
	}
	if (q.type === "confirm_enum") {
		if (typeof v !== "object" || v === null || Array.isArray(v)) {
			return `Question ${i}: expected option object`;
		}
		const obj = v as { mode?: unknown; value?: unknown; text?: unknown };
		if (obj.mode === "option" && obj.value !== "affirm" && obj.value !== "decline") {
			return `Question ${i}: confirm value must be "affirm" or "decline"`;
		}
		if (obj.mode === "other" && (typeof obj.text !== "string" || obj.text.trim() === "")) {
			return `Question ${i}: other text must be a non-empty string`;
		}
		return null;
	}
	if (q.type === "number") {
		if (typeof v !== "number" || !Number.isFinite(v)) {
			return `Question ${i}: expected a finite number`;
		}
		if (q.min !== undefined && v < q.min) {
			return `Question ${i}: value ${v} is below min ${q.min}`;
		}
		if (q.max !== undefined && v > q.max) {
			return `Question ${i}: value ${v} is above max ${q.max}`;
		}
		return null;
	}
	// free_text
	if (typeof v !== "string") return `Question ${i}: expected a string`;
	return null;
}

/** Coerce a number from a string (for text-input roundtrips in the TUI). */
export function coerceNumber(input: string, q: CanonicalQuestion): number | undefined {
	const n = Number(input.trim());
	if (!Number.isFinite(n)) return undefined;
	if (q.min !== undefined && n < q.min) return undefined;
	if (q.max !== undefined && n > q.max) return undefined;
	return n;
}

/** Get the render options for a question (post-"Other" injection). */
export function getRenderOptions(q: CanonicalQuestion): RenderOption[] {
	if (!isChoiceType(q.type) || !q.options) return [];
	return q.options.map((o) => ({
		...o,
		value: o.label,
		isOther: /^other$/i.test(o.label.trim()),
	}));
}

/** Parse a raw answer payload (any of the pag-server shapes) into the v2
 * AnswerMap. Used by headless / WS paths. */
export function parseAnswerPayload(
	raw: unknown,
	questions: CanonicalQuestion[],
): { answers: AnswerMap; notes?: Record<string, string> } {
	if (raw === null || typeof raw !== "object") return { answers: {} };
	const obj = raw as Record<string, unknown>;
	const inner = (() => {
		if (obj.answers && typeof obj.answers === "object") return obj.answers as Record<string, unknown>;
		const qr = obj.question_response as Record<string, unknown> | undefined;
		if (qr && typeof qr === "object" && qr.answers && typeof qr.answers === "object") {
			return qr.answers as Record<string, unknown>;
		}
		return obj;
	})();
	const out: AnswerMap = {};
	for (let i = 0; i < questions.length; i++) {
		const key = String(i);
		if (!(key in inner)) continue;
		const v = coerceAnswer(inner[key], questions[i]);
		if (v !== undefined) out[key] = v;
	}
	const notes = (() => {
		const n = obj.notes as Record<string, unknown> | undefined;
		if (!n || typeof n !== "object") return undefined;
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(n)) {
			if (typeof v === "string" && v.trim() !== "") out[String(k)] = v.trim();
		}
		return Object.keys(out).length > 0 ? out : undefined;
	})();
	return notes ? { answers: out, notes } : { answers: out };
}

export function getOptionByLabel(q: CanonicalQuestion, label: string): SelectOption | undefined {
	return q.options?.find((o) => o.label === label);
}
