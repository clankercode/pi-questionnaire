// src/answers.ts
// Canonical answer map parsing & shaping. Mirrors pag-server's
// answer_normalizer contract: keys are stringified indices, values are
// string | string[] | boolean | number (we extend with boolean/number).
//
// Accepted input shapes (for the headless / env-var path):
//   { "0": "Staging", "1": ["A","B"], "2": "free text", "3": true, "4": 42 }
//   { "0": { "selected": "Staging", "other": "" }, ... }   (pag-server nested)
//   { "answers": { "0": "Staging", ... }, "notes": { "0": "ctx" } }
//   { "question_response": { "answers": { ... } } }

import type { AnswerMap, CanonicalAnswer, CanonicalQuestion, RenderOption } from "./types.ts";

function coerce(v: unknown): CanonicalAnswer | undefined {
	if (v === null || v === undefined) return undefined;
	if (typeof v === "string") {
		const t = v.trim();
		return t === "" ? undefined : t;
	}
	if (typeof v === "number") return v;
	if (typeof v === "boolean") return v;
	if (Array.isArray(v)) {
		const arr = v
			.map((x) => (typeof x === "string" ? x.trim() : x))
			.filter((x) => x !== "" && x !== null && x !== undefined);
		return arr;
	}
	if (typeof v === "object") {
		const obj = v as { selected?: unknown; other?: unknown; notes?: unknown };
		// pag-server nested shape
		if (obj.selected !== undefined) {
			const sel = coerce(obj.selected);
			const other = typeof obj.other === "string" ? obj.other.trim() : "";
			if (sel === undefined) {
				return other === "" ? undefined : other;
			}
			// "Other" is a label; refine the value
			if (typeof sel === "string" && /^other$/i.test(sel) && other !== "") return other;
			return sel;
		}
	}
	return undefined;
}

function normalizeKey(k: string | number): string {
	return String(k);
}

function flatten(raw: unknown): { answers: Record<string, unknown>; notes?: Record<string, string> } {
	if (raw === null || raw === undefined || typeof raw !== "object") return { answers: {} };
	const obj = raw as Record<string, unknown>;
	// Unwrap nested shapes
	const answers = (() => {
		if (obj.answers && typeof obj.answers === "object") return obj.answers as Record<string, unknown>;
		const qr = obj.question_response as Record<string, unknown> | undefined;
		if (qr && typeof qr === "object" && qr.answers && typeof qr.answers === "object") {
			return qr.answers as Record<string, unknown>;
		}
		return obj;
	})();
	const notes = (() => {
		const n = obj.notes as Record<string, unknown> | undefined;
		if (n && typeof n === "object") {
			const out: Record<string, string> = {};
			for (const [k, v] of Object.entries(n)) {
				if (typeof v === "string") out[normalizeKey(k)] = v.trim();
			}
			return Object.keys(out).length ? out : undefined;
		}
		return undefined;
	})();
	return { answers, notes };
}

/** Parse a raw answer payload into canonical AnswerMap. Accepts any of the
 * shapes documented above. */
export function parseAnswerPayload(raw: unknown): { answers: AnswerMap; notes?: Record<string, string> } {
	const { answers, notes } = flatten(raw);
	const out: AnswerMap = {};
	for (const [k, v] of Object.entries(answers)) {
		const c = coerce(v);
		if (c !== undefined) out[normalizeKey(k)] = c;
	}
	return notes ? { answers: out, notes } : { answers: out };
}

/** Validate that the parsed answers match the canonical questions' types.
 * Returns { ok, errors[] } — errors are non-fatal: collect them all so the
 * LLM gets a single round-trip feedback list. */
export function validateAgainstQuestions(
	questions: CanonicalQuestion[],
	answers: AnswerMap,
): { ok: boolean; errors: string[] } {
	const errors: string[] = [];
	for (let i = 0; i < questions.length; i++) {
		const q = questions[i];
		const key = String(i);
		const v = answers[key];
		if (q.required && (v === undefined || v === "" || (Array.isArray(v) && v.length === 0))) {
			errors.push(`Question ${i} (${q.header}) is required but not answered`);
			continue;
		}
		if (v === undefined) continue;
		switch (q.type) {
			case "single_select": {
				if (typeof v !== "string") {
					errors.push(`Question ${i} expects a single string value, got ${typeof v}`);
				} else if (q.options && !q.options.some((o) => o.label === v) && v !== "__other__") {
					// Allow free text from "Other" — only complain on truly unknown values
					// when there are no "Other" option. The normalizer always adds "Other".
				}
				break;
			}
			case "multi_select": {
				if (!Array.isArray(v)) {
					errors.push(`Question ${i} expects an array of selected option labels`);
				}
				break;
			}
			case "text": {
				if (typeof v !== "string") {
					errors.push(`Question ${i} expects a string value`);
				}
				break;
			}
			case "confirm": {
				if (typeof v !== "boolean") {
					errors.push(`Question ${i} expects a boolean value`);
				}
				break;
			}
			case "number": {
				const n = typeof v === "number" ? v : Number(v);
				if (!Number.isFinite(n)) {
					errors.push(`Question ${i} expects a number, got ${JSON.stringify(v)}`);
				} else if (q.min !== undefined && n < q.min) {
					errors.push(`Question ${i} value ${n} is below min ${q.min}`);
				} else if (q.max !== undefined && n > q.max) {
					errors.push(`Question ${i} value ${n} is above max ${q.max}`);
				}
				break;
			}
		}
	}
	return { ok: errors.length === 0, errors };
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
	if (q.type !== "single_select" && q.type !== "multi_select") return [];
	const opts: RenderOption[] = (q.options ?? []).map((o) => ({
		...o,
		value: o.label,
		isOther: /^other$/i.test(o.label.trim()),
	}));
	return opts;
}
