// tests/harness.ts
// TS test harness: reads JSON commands from stdin, exercises the
// schema/normalize/answers modules, emits JSON results on stdout.
// Used by the Python pytest suite to test against the real TypeScript code.

import { AskUserQuestionParams, validateSchema, validateSemantics } from "../src/schema.ts";
import { normalizeQuestions } from "../src/normalize.ts";
import {
	coerceNumber,
	getRenderOptions,
	parseAnswerPayload,
	validateAgainstQuestions,
} from "../src/answers.ts";
import { buildQuestionnaireComponent } from "../src/tui.ts";

interface HarnessCommand {
	cmd: string;
	[key: string]: unknown;
}

async function readAllStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		if (chunk === undefined) continue;
		chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
	}
	return Buffer.concat(chunks).toString("utf8");
}

function makeFakeTheme() {
	const F = (color: string, text: string) => `[${color}]${text}[/${color}]`;
	return {
		fg: F,
		bg: F,
		bold: (s: string) => `[bold]${s}[/bold]`,
		italic: (s: string) => `[italic]${s}[/italic]`,
		strikethrough: (s: string) => `[strike]${s}[/strike]`,
	};
}

async function main() {
	const raw = await readAllStdin();
	const cmd = JSON.parse(raw) as HarnessCommand;
	let result: unknown;
	try {
		switch (cmd.cmd) {
			case "validate": {
				const v = validateSemantics(cmd.input as never);
				result = v;
				break;
			}
			case "validateSchema": {
				result = validateSchema(cmd.input);
				break;
			}
			case "detectLegacyFields": {
				const { detectLegacyFields } = await import("../src/schema.ts");
				result = detectLegacyFields(cmd.input);
				break;
			}
			case "normalize": {
				try {
					const normalized = normalizeQuestions(cmd.input as never);
					result = { ok: true, value: normalized };
				} catch (err) {
					result = { ok: false, reason: (err as Error).message };
				}
				break;
			}
			case "parseAnswers": {
				const questions = cmd.questions
					? normalizeQuestions(cmd.questions as never)
					: [];
				result = parseAnswerPayload(cmd.input, questions);
				break;
			}
			case "validateAnswers": {
				const questions = cmd.questions
					? normalizeQuestions(cmd.questions as never)
					: [];
				const answers = cmd.answers as never;
				result = validateAgainstQuestions(questions, answers);
				break;
			}
			case "coerceNumber": {
				const q = normalizeQuestions([(cmd.question as never) || {}])[0];
				result = coerceNumber(cmd.input as string, q);
				break;
			}
			case "renderOptions": {
				const q = normalizeQuestions([(cmd.question as never) || {}])[0];
				result = getRenderOptions(q);
				break;
			}
			case "renderTui": {
				const questions = normalizeQuestions(cmd.questions as never);
				const factory = buildQuestionnaireComponent({ questions });
				const fakeTui = { requestRender: () => {} };
				const fakeTheme = makeFakeTheme();
				const width = (cmd.width as number) || 80;
				const component = factory(
					fakeTui as never,
					fakeTheme as never,
					{} as never,
					() => {},
				);
				const lines = (component as { render: (w: number) => string[] }).render(width);
				result = { lines };
				break;
			}
			default:
				result = { ok: false, reason: `unknown cmd: ${cmd.cmd}` };
		}
	} catch (err) {
		result = { ok: false, reason: (err as Error).message, stack: (err as Error).stack };
	}
	process.stdout.write(JSON.stringify(result ?? null));
}

main().catch((err) => {
	process.stdout.write(
		JSON.stringify({ ok: false, reason: (err as Error).message, stack: (err as Error).stack }),
	);
	process.exit(1);
});
