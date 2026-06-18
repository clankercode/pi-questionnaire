// tests/harness.ts
// TS test harness: reads JSON commands from stdin, exercises the
// schema/normalize/answers/side-effects modules, emits JSON results on
// stdout. Used by the Python pytest suite to test against the real
// TypeScript code.

import { AskUserQuestionParams, validateSchema, validateSemantics } from "../src/schema.ts";
import { normalizeQuestions } from "../src/normalize.ts";
import {
	coerceNumber,
	getRenderOptions,
	parseAnswerPayload,
	validateAgainstQuestions,
} from "../src/answers.ts";
import { buildQuestionnaireComponent } from "../src/tui.ts";
import {
	fireOnQuestionSideEffects,
	type SpawnRecord,
} from "../src/side-effects.ts";
import type { AskUserQuestionInput } from "../src/schema.ts";
import type { AskUserQuestionSettings } from "../src/settings.ts";

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
			case "fireSideEffects": {
				// Run the side-effects function with a recording harness.
				// `params` is the raw AskUserQuestionInput (validated at the
				// call site by the test, not by the harness — the
				// side-effects module is permissive). `settings` is the
				// override applied on top of getSettings(). `platform`
				// selects the notification command. `mockSpawn` /
				// `mockSpawnThrows` control spawn behavior. The returned
				// object includes the full trace (every spawn, setInterval,
				// setTimeout, sendMessage, and log line) so tests can assert
				// on the exact call shape.
				const params = cmd.params as AskUserQuestionInput;
				const settingsOverride = (cmd.settings ?? {}) as AskUserQuestionSettings;
				const platform = (cmd.platform ?? "linux") as NodeJS.Platform;

				const spawnLog: SpawnRecord[] = [];
				const intervalLog: Array<{ ms: number; cb: () => void }> = [];
				const timeoutLog: Array<{ ms: number; cb: () => void }> = [];
				const sendLog: Array<{ message: unknown; options: unknown }> = [];
				const logBuf: string[] = [];

				const useMockSpawn = cmd.mockSpawn !== false; // default true
				const spawnThrows = cmd.mockSpawnThrows === true;

				const mockSpawn = ((c: string, a: string[], opts: Record<string, unknown> = {}) => {
					spawnLog.push({
						cmd: c,
						args: [...a],
						env: opts.env as NodeJS.ProcessEnv | undefined,
						shell: opts.shell as boolean | undefined,
						detached: opts.detached as boolean | undefined,
						stdio: opts.stdio as SpawnRecord["stdio"],
					});
					if (spawnThrows) {
						throw new Error("mock spawn failure");
					}
					// Return a fake ChildProcess-shaped object with unref.
					return { unref: () => {} } as unknown as ReturnType<typeof import("node:child_process").spawn>;
				}) as unknown as typeof import("node:child_process").spawn;

				const mockSetInterval = ((cb: () => void, ms: number) => {
					intervalLog.push({ ms, cb });
					const handle = { unref: () => {} } as unknown as ReturnType<typeof setInterval>;
					return handle;
				}) as unknown as typeof setInterval;
				const mockClearInterval = (() => {}) as unknown as typeof clearInterval;
				const mockSetTimeout = ((cb: () => void, ms: number) => {
					timeoutLog.push({ ms, cb });
					const handle = { unref: () => {} } as unknown as ReturnType<typeof setTimeout>;
					return handle;
				}) as unknown as typeof setTimeout;
				const mockClearTimeout = (() => {}) as unknown as typeof clearTimeout;
				const mockRandomBytes = ((n: number) => Buffer.alloc(n, "ab")) as (n: number) => Buffer;
				// Real writeFileSync (with a recording wrapper) so tests that
				// read the payload back actually see a file on disk. We log
				// every write so tests can assert on the path/content.
				const writes: Array<{ path: string; content: string }> = [];
				const realWriteFileSync = (await import("node:fs")).writeFileSync;
				const mockWriteFileSync = ((path: unknown, data: unknown, ...rest: unknown[]) => {
					const s = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf-8") : String(data);
					writes.push({ path: String(path), content: s });
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					(realWriteFileSync as any)(path, data, ...rest);
				}) as unknown as typeof import("node:fs").writeFileSync;
				const mockSendMessage = (async (msg: unknown, options: unknown) => {
					sendLog.push({ message: msg, options });
				}) as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI["sendMessage"];

				const mockPi = { sendMessage: mockSendMessage };

				const tmpDir = (cmd.tmpDir as string | undefined) ?? "/tmp/auq-test";

				const handle = fireOnQuestionSideEffects(params, mockPi, {
					spawn: useMockSpawn ? mockSpawn : undefined,
					setInterval: mockSetInterval,
					clearInterval: mockClearInterval,
					setTimeout: mockSetTimeout,
					clearTimeout: mockClearTimeout,
					randomBytes: mockRandomBytes,
					writeFileSync: mockWriteFileSync,
					platform,
					tmpDir,
					getSettingsOverride: settingsOverride,
					log: (line) => logBuf.push(line),
				});

				// If cmd.tickHeartbeat is true, run one heartbeat tick to
				// verify the callback shape.
				let heartbeatTick: { message: unknown; options: unknown } | null = null;
				if (cmd.tickHeartbeat === true && intervalLog.length > 0) {
					intervalLog[0].cb();
					// Allow microtasks to settle for the sendMessage async call.
					await Promise.resolve();
					heartbeatTick = sendLog[sendLog.length - 1] ?? null;
				}
				// If cmd.tickNotification is true, run one notification tick.
				let notificationTick = false;
				if (cmd.tickNotification === true && timeoutLog.length > 0) {
					timeoutLog[0].cb();
					notificationTick = spawnLog.some(
						(s) => s.cmd !== "echo" && s.cmd !== "attn" && s.cmd !== "msg",
					);
				}

				// If cmd.readPayload is true, read the payload file so
				// tests can assert on its content.
				let payloadContent: string | null = null;
				if (cmd.readPayload === true && handle.payloadFile) {
					try {
						const { readFileSync } = await import("node:fs");
						payloadContent = readFileSync(handle.payloadFile, "utf-8");
					} catch {
						payloadContent = null;
					}
				}

				// If cmd.doClear is true, call clear() and report timer cleanup.
				let cleared = false;
				if (cmd.doClear === true) {
					handle.clear();
					cleared = true;
				}

				result = {
					effects: handle.effects,
					payloadFile: handle.payloadFile,
					heartbeatStarted: handle.heartbeatStarted,
					trace: {
						spawn: spawnLog,
						setInterval: intervalLog.map((e) => ({ ms: e.ms })),
						setTimeout: timeoutLog.map((e) => ({ ms: e.ms })),
						sendMessage: sendLog,
						log: logBuf,
						writes,
					},
					heartbeatTick,
					notificationTick,
					payloadContent,
					cleared,
				};
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
