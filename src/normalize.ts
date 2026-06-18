// src/normalize.ts
// Canonical question normalization. Produces a stable shape that the TUI and
// headless paths both consume. Mirrors pag-server's payload_normalizer.

import type {
	CanonicalQuestion,
	Preview,
	QuestionType,
	RawQuestion,
	SelectOption,
} from "./types.ts";
import { MAX_HEADER_LENGTH } from "./types.ts";
import { needsOptions, resolveType } from "./schema.ts";

/** Default to a stable, deterministic id when the model forgets to set one. */
let idCounter = 0;
function autoId(): string {
	idCounter += 1;
	return `q${idCounter}`;
}

function ensurePreview(p: Preview | undefined): Preview | undefined {
	if (!p) return undefined;
	const t = p.type;
	if (t === "markdown" || t === "mermaid" || t === "svg" || t === "code") {
		return { type: t, content: String(p.content ?? "") };
	}
	return undefined;
}

function normalizeOption(
	opt: { label?: string; description?: string; preview?: Preview; markdown?: string },
): SelectOption {
	const out: SelectOption = { label: String(opt.label ?? "").trim() };
	if (opt.description) out.description = String(opt.description);
	// pag-server v1 compat: `markdown` is a flat string on the option
	if (opt.markdown && !opt.preview) {
		out.preview = { type: "markdown", content: String(opt.markdown) };
	} else if (opt.preview) {
		const norm = ensurePreview(opt.preview);
		if (norm) out.preview = norm;
	}
	return out;
}

/** For single/multi-select, append a synthetic "Other" option that captures
 * free-text from the user. pag-server does this in PayloadNormalizer. */
function appendOther(options: SelectOption[]): SelectOption[] {
	const hasOther = options.some((o) => /^other$/i.test(o.label.trim()));
	if (hasOther) return options;
	return [...options, { label: "Other", description: "Provide a custom answer" }];
}

/** Cap a raw options list at MAX_OPTIONS_PER_SELECT minus 1, leaving room for
 * the auto-appended "Other" option. */
export function capOptionsForOther(raw: unknown): unknown {
	if (!Array.isArray(raw)) return raw;
	const cap = 7; // +1 for the auto-appended "Other" = 8
	if (raw.length <= cap) return raw;
	return raw.slice(0, cap);
}

export function normalizeQuestion(raw: RawQuestion, index: number): CanonicalQuestion {
	const type: QuestionType | "invalid" = resolveType(
		raw.type,
		raw.input_mode,
		raw.multi_select === true,
		raw.options,
	);
	if (type === "invalid") {
		throw new Error(`Question ${index}: invalid type/input_mode`);
	}
	const id = (raw.id ?? autoId()).trim() || autoId();
	const header = (raw.header ?? `Q${index + 1}`).slice(0, MAX_HEADER_LENGTH);
	const question = String(raw.question ?? raw.prompt ?? "").trim();
	if (!question) {
		throw new Error(`Question ${index}: missing 'question' (or 'prompt') text`);
	}

	const q: CanonicalQuestion = {
		id,
		header,
		question,
		type,
		required: raw.required !== false,
	};
	if (needsOptions(type)) {
		// Cap at 7 so the auto-appended "Other" brings us to 8 max.
		const rawOpts = (raw.options ?? []).slice(0, 7);
		const opts = rawOpts.map(normalizeOption);
		q.options = appendOther(opts);
	}
	if (raw.default !== undefined) q.default = raw.default as CanonicalQuestion["default"];
	if (raw.min !== undefined) q.min = raw.min;
	if (raw.max !== undefined) q.max = raw.max;
	if (raw.placeholder !== undefined) q.placeholder = raw.placeholder;
	if (raw.multiline !== undefined) q.multiline = raw.multiline;
	return q;
}

export function normalizeQuestions(rawList: RawQuestion[]): CanonicalQuestion[] {
	// Reset auto-id counter so deterministic when no ids are provided.
	idCounter = 0;
	return rawList.map((q, i) => normalizeQuestion(q, i));
}

/** Confirm is single_select with exactly 2 options. */
export function confirmOptions(): SelectOption[] {
	return [
		{ label: "Yes", description: "Confirm" },
		{ label: "No", description: "Decline" },
	];
}
