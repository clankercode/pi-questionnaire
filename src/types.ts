// src/types.ts
// v2 types for the AskUserQuestion tool. Matches Claude Code's tool surface
// (select_one, select_many, confirm_enum, number, free_text) and the new
// browser-sync state model.

export type QuestionType =
	| "select_one"
	| "select_many"
	| "confirm_enum"
	| "number"
	| "free_text";

export type PreviewType = "markdown" | "code" | "text" | "mermaid" | "svg" | "html";

export interface Preview {
	type: PreviewType;
	content: string;
}

export interface SelectOption {
	label: string;
	description?: string;
	preview?: Preview;
}

/** Canonical normalized question (post-normalize). */
export interface CanonicalQuestion {
	id: string;
	header: string;
	question: string;
	description?: string;
	type: QuestionType;
	/** Required for choice-based types; auto-filled for confirm_enum when absent. */
	options?: SelectOption[];
	default?: string | string[] | number;
	/** number only */
	min?: number;
	max?: number;
	/** free_text only */
	placeholder?: string;
	multiline?: boolean;
}

/** Raw question shape accepted at the tool boundary. v1 aliases are rejected
 * by the schema with a clear error message. */
export interface RawQuestion {
	id?: string;
	header: string;
	question: string;
	description?: string;
	type: QuestionType;
	options?: Array<{ label: string; description?: string; preview?: Preview }>;
	default?: unknown;
	min?: number;
	max?: number;
	placeholder?: string;
	multiline?: boolean;
}

export interface RawAskUserQuestionParams {
	questions: RawQuestion[];
}

// ---- Result shape ---------------------------------------------------------

/** Result for single_choice and select_many items. */
export type ChoiceAnswer =
	| { mode: "option"; value: string }
	| { mode: "other"; text: string };

/** Result for confirm_enum. Value is "affirm" | "decline" for option mode, or
 * free text in "other" mode. */
export type ConfirmAnswer =
	| { mode: "option"; value: "affirm" | "decline" }
	| { mode: "other"; text: string };

export type AnswerValue =
	| ChoiceAnswer
	| ChoiceAnswer[]
	| ConfirmAnswer
	| number
	| string;

/** Stringified-indexed map of answers (matches Claude Code's contract). */
export type AnswerMap = Record<string, AnswerValue>;

export type Lifecycle = "answered" | "cancelled" | "rejected";

export interface ToolResultDetails {
	questions: CanonicalQuestion[];
	answers: AnswerMap;
	notes?: Record<string, string>;
	lifecycle: Lifecycle;
	url?: string | null;
	port?: number | null;
}

// ---- Server state mirror --------------------------------------------------

/** In-process state mirrored by the HTTP server. The TUI is the canonical
 * owner; the server holds a copy so browsers can connect. */
export interface BatchState {
	id: string;
	nonce: string;
	questions: CanonicalQuestion[];
	answers: AnswerMap;
	notes: Record<string, string>;
	activeQuestion: number | null;
	browserFocus: number | null;
	lifecycle: "open" | "submitted" | "cancelled";
	createdAt: number;
	updatedAt: number;
}

/** Render option as it appears in the TUI/headless pipeline (post-"Other" injection). */
export interface RenderOption extends SelectOption {
	value: string; // unique stable key for rendering
	isOther?: boolean;
}

// ---- Constants ------------------------------------------------------------

export const MAX_QUESTIONS_PER_CALL = 4;
export const MAX_OPTIONS_PER_USER = 7; // + 1 auto-Other = 8
export const MAX_HEADER_LENGTH = 20;
export const CONFIRM_AFFIRM = "Affirm";
export const CONFIRM_DECLINE = "Decline";
export const OTHER_LABEL = "Other";

// ---- Type guards ----------------------------------------------------------

export function isChoiceType(t: QuestionType): boolean {
	return t === "select_one" || t === "select_many" || t === "confirm_enum";
}

export function needsOptions(t: QuestionType): boolean {
	return isChoiceType(t);
}
