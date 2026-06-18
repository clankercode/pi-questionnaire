// src/headless.ts
// Headless answer loading for e2e tests and scripted use.
// Activated by setting PI_QUESTIONNAIRE_ANSWERS_FILE=/path/to/answers.json
// in the process environment. The file shape is the canonical answer map:
//   { "0": "Staging", "1": ["A","B"], "2": "free text", "3": true, "4": 42 }
// Optionally with "notes": { "0": "context" }.

import { readFile } from "node:fs/promises";
import type { AnswerMap } from "./types.ts";
import { parseAnswerPayload, validateAgainstQuestions } from "./answers.ts";
import type { CanonicalQuestion } from "./types.ts";

export interface HeadlessResult {
	ok: boolean;
	answers: AnswerMap;
	notes?: Record<string, string>;
	errors: string[];
	source: string | null;
}

export async function loadHeadlessAnswers(
	questions: CanonicalQuestion[],
	env: NodeJS.ProcessEnv = process.env,
): Promise<HeadlessResult> {
	const file = env.PI_QUESTIONNAIRE_ANSWERS_FILE;
	if (!file) {
		return { ok: false, answers: {}, errors: ["PI_QUESTIONNAIRE_ANSWERS_FILE is not set"], source: null };
	}
	let raw: string;
	try {
		raw = await readFile(file, "utf8");
	} catch (err) {
		return {
			ok: false,
			answers: {},
			errors: [`failed to read ${file}: ${(err as Error).message}`],
			source: file,
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		return {
			ok: false,
			answers: {},
			errors: [`failed to parse ${file} as JSON: ${(err as Error).message}`],
			source: file,
		};
	}
	const { answers, notes } = parseAnswerPayload(parsed);
	const validation = validateAgainstQuestions(questions, answers);
	return {
		ok: validation.ok,
		answers,
		...(notes ? { notes } : {}),
		errors: validation.errors,
		source: file,
	};
}

/** True if headless mode is active (regardless of file contents). */
export function isHeadless(env: NodeJS.ProcessEnv = process.env): boolean {
	return !!env.PI_QUESTIONNAIRE_ANSWERS_FILE;
}
