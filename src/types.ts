// src/types.ts
// Shared types for pi-questionnaire.
// Compatible with pag-server v2 questionnaire contract (input_mode, preview).

export type PreviewType = "markdown" | "mermaid" | "svg" | "code";

export interface Preview {
	type: PreviewType;
	content: string;
}

export interface SelectOption {
	label: string;
	description?: string;
	preview?: Preview;
}

export type QuestionType = "single_select" | "multi_select" | "text" | "confirm" | "number";

/**
 * Canonical normalized question (post-normalize). All forms accept both
 * pag-server v2 shapes (`input_mode`, `header`) and our richer shape (`type`).
 */
export interface CanonicalQuestion {
	id: string;
	header: string;
	question: string;
	type: QuestionType;
	options?: SelectOption[];
	default?: string | string[] | number | boolean;
	required: boolean;
	min?: number;
	max?: number;
	placeholder?: string;
	multiline?: boolean;
}

/** Raw question shape accepted at the tool boundary (any field may be omitted). */
export interface RawQuestion {
	id?: string;
	header?: string;
	question?: string;
	prompt?: string; // alias of `question` for v1 compat
	type?: string;
	input_mode?: string; // pag-server v2 alias
	multi_select?: boolean; // pag-server v1 alias
	options?: Array<{ label?: string; description?: string; preview?: Preview; markdown?: string }>;
	default?: unknown;
	required?: boolean;
	min?: number;
	max?: number;
	placeholder?: string;
	multiline?: boolean;
}

export type CanonicalAnswer = string | string[] | boolean | number;

export interface AnswerMap {
	[id: string]: CanonicalAnswer;
}

export interface AnswerSet {
	answers: AnswerMap;
	notes?: Record<string, string>;
}

export interface ToolResultDetails {
	questions: CanonicalQuestion[];
	answers: AnswerMap;
	notes?: Record<string, string>;
	cancelled: boolean;
	/** lifecycle (mirrors pag-server adapter contract) */
	lifecycle: "requested" | "answered" | "cancelled" | "timed_out" | "rejected";
}

/** A canonical option as it appears in the TUI/headless pipeline (post-"Other" injection). */
export interface RenderOption extends SelectOption {
	value: string; // unique stable key for rendering
	isOther?: boolean;
}

export const MAX_QUESTIONS_PER_CALL = 4;
export const MAX_OPTIONS_PER_SELECT = 8;
export const MAX_HEADER_LENGTH = 20;
