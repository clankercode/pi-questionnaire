// src/normalize.ts
// Canonical question normalization for v2. Produces a stable shape used by
// the TUI, headless, and server modules.
//
// Rules:
// - `confirm_enum` with no options is auto-filled with `[{Affirm},{Decline}]`.
// - All choice-based types (`select_one`, `select_many`, `confirm_enum`)
//   auto-append a synthetic "Other" option that captures free-text input.
// - `select_one`/`select_many` cap user-provided options at 7 (so + Other = 8).
// - `number` and `free_text` reject `options`.
// - `default` is validated against the type.

import type {
	CanonicalQuestion,
	Preview,
	PreviewType,
	QuestionType,
	RawQuestion,
	SelectOption,
} from "./types.ts";
import { CONFIRM_AFFIRM, CONFIRM_DECLINE, MAX_HEADER_LENGTH, OTHER_LABEL } from "./types.ts";

let idCounter = 0;
function autoId(): string {
	idCounter += 1;
	return `q${idCounter}`;
}

function normalizePreview(p: Preview | undefined): Preview | undefined {
	if (!p) return undefined;
	const t: PreviewType = p.type;
	const allowed: PreviewType[] = ["markdown", "code", "text", "mermaid", "svg", "html"];
	if (!allowed.includes(t)) return undefined;
	return { type: t, content: String(p.content ?? "") };
}

function normalizeOption(opt: { label: string; description?: string; preview?: Preview }): SelectOption {
	const out: SelectOption = { label: String(opt.label ?? "").trim() };
	if (typeof opt.description === "string" && opt.description.length > 0) {
		out.description = String(opt.description);
	}
	const pv = normalizePreview(opt.preview);
	if (pv) out.preview = pv;
	return out;
}

/** Append a synthetic "Other" option if not already present. */
function appendOther(options: SelectOption[]): SelectOption[] {
	const hasOther = options.some((o) => /^other$/i.test(o.label.trim()));
	if (hasOther) return options;
	return [...options, { label: OTHER_LABEL, description: "Provide a custom answer" }];
}

/** Default options for `confirm_enum` (per spec §3.3). */
export function confirmOptions(): SelectOption[] {
	return [
		{ label: CONFIRM_AFFIRM, description: "Affirm" },
		{ label: CONFIRM_DECLINE, description: "Decline" },
	];
}

/** Find the matching normalized label for a default value (string match). */
function findOptionLabel(options: SelectOption[], value: string): string | null {
	for (const opt of options) {
		if (opt.label === value) return opt.label;
		// Also try case-insensitive
		if (opt.label.toLowerCase() === value.toLowerCase()) return opt.label;
	}
	return null;
}

function validateDefault(
	qtype: QuestionType,
	options: SelectOption[] | undefined,
	dflt: unknown,
	index: number,
): unknown {
	if (qtype === "select_one") {
		if (typeof dflt !== "string") {
			throw new Error(`Question ${index}: default for 'select_one' must be a string`);
		}
		if (!options) {
			throw new Error(`Question ${index}: select_one missing options`);
		}
		const matched = findOptionLabel(options, dflt);
		if (matched === null) {
			throw new Error(`Question ${index}: default "${dflt}" does not match any option label`);
		}
		return matched;
	}
	if (qtype === "select_many") {
		if (!Array.isArray(dflt)) {
			throw new Error(`Question ${index}: default for 'select_many' must be an array of option labels`);
		}
		if (!options) {
			throw new Error(`Question ${index}: select_many missing options`);
		}
		const out: string[] = [];
		const seen = new Set<string>();
		for (const v of dflt) {
			if (typeof v !== "string") {
				throw new Error(`Question ${index}: default array entries must be strings`);
			}
			const matched = findOptionLabel(options, v);
			if (matched === null) {
				throw new Error(`Question ${index}: default "${v}" does not match any option label`);
			}
			if (seen.has(matched)) continue;
			seen.add(matched);
			out.push(matched);
		}
		return out;
	}
	if (qtype === "confirm_enum") {
		// Internal value: "affirm" | "decline". Map to display label.
		if (typeof dflt !== "string") {
			throw new Error(`Question ${index}: default for 'confirm_enum' must be "affirm" or "decline"`);
		}
		if (dflt === "affirm" || dflt === "decline") return dflt;
		throw new Error(`Question ${index}: default for 'confirm_enum' must be "affirm" or "decline" (got "${dflt}")`);
	}
	if (qtype === "number") {
		if (typeof dflt !== "number" || !Number.isFinite(dflt)) {
			throw new Error(`Question ${index}: default for 'number' must be a finite number`);
		}
		return dflt;
	}
	// free_text
	if (typeof dflt !== "string") {
		throw new Error(`Question ${index}: default for 'free_text' must be a string`);
	}
	return dflt;
}

export function normalizeQuestion(raw: RawQuestion, index: number): CanonicalQuestion {
	const qtype: QuestionType = raw.type;
	const id = (raw.id ?? autoId()).trim() || autoId();
	const header = (raw.header ?? `Q${index + 1}`).slice(0, MAX_HEADER_LENGTH);
	const question = String(raw.question ?? "").trim();
	if (!question) {
		throw new Error(`Question ${index}: missing 'question' text`);
	}

	const q: CanonicalQuestion = {
		id,
		header,
		question,
		type: qtype,
	};
	if (typeof raw.description === "string") {
		q.description = raw.description;
	}

	if (qtype === "select_one" || qtype === "select_many") {
		const rawOpts = (raw.options ?? []).slice(0, 7);
		const opts = rawOpts.map(normalizeOption);
		q.options = appendOther(opts);
	} else if (qtype === "confirm_enum") {
		// Auto-fill if user didn't provide options.
		const userOpts = (raw.options ?? []).slice(0, 7).map(normalizeOption);
		const base = userOpts.length > 0 ? userOpts : confirmOptions();
		q.options = appendOther(base);
	}
	// number and free_text: no options

	if (raw.default !== undefined) {
		q.default = validateDefault(qtype, q.options, raw.default, index) as CanonicalQuestion["default"];
	}
	if (raw.min !== undefined) q.min = raw.min;
	if (raw.max !== undefined) q.max = raw.max;
	if (raw.placeholder !== undefined) q.placeholder = raw.placeholder;
	if (raw.multiline !== undefined) q.multiline = raw.multiline;
	// free_text default: multiline = true unless explicitly false
	if (qtype === "free_text" && q.multiline === undefined) {
		q.multiline = true;
	}
	return q;
}

export function normalizeQuestions(rawList: RawQuestion[]): CanonicalQuestion[] {
	idCounter = 0;
	return rawList.map((q, i) => normalizeQuestion(q, i));
}
