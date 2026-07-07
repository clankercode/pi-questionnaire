// src/side-effects.ts
// Per-setting on-question side effects for the AskUserQuestion tool.
//
// `fireOnQuestionSideEffects(params, pi, deps)` runs at the start of
// `execute()`, before the TUI mounts. It honors the 13 v2 settings in
// src/settings.ts (minus `bellOnQuestion`, which is wired inside tui.ts):
//
//   - browserEnabled / browserAutoOpen / browserMinQuestions / copyUrlToClipboard
//     → all gated "would / TODO" log lines today; slice 5+ will start the
//     HTTP server + clipboard + auto-open. We record the *intent* so the
//     TUI / future server can read it from getSettings().
//   - notificationOnQuestion + notificationDelaySeconds
//     → spawn `notify-send` / `osascript` / `msg` (platform-picked) on
//     the first question's header. Delay > 0 schedules via setTimeout
//     (`.unref()`-ed). spawn failure is caught and logged.
//   - ttsOnQuestion
//     → spawn `attn "AskUserQuestion: <header>"`. Same try/catch.
//   - onQuestionCommand
//     → write the raw params JSON to a temp file under os.tmpdir() and
//     spawn the user-provided command with `PI_QUESTIONNAIRE_PAYLOAD_FILE`
//     in the env. The command is responsible for cleanup; we don't poll.
//   - heartbeatWhileActive + heartbeatIntervalMinutes
//     → start a `.unref()`-ed setInterval that calls `pi.sendMessage`
//     with a stable customType and `deliverAs: "followUp"`. Cleared by
//     the handle when the TUI settles.
//   - herdrReportBlocked
//     → when inside a herdr-managed pane (HERDR_ENV=1 + HERDR_PANE_ID),
//       spawn `herdr pane report-agent ... --state blocked` on mount and
//       `herdr pane release-agent ...` on clear(). No-op outside herdr.
//   - dangerCheckEnabled
//     → just logs "enabled" / "disabled". The TUI's is_dangerous flow
//     reads the setting directly from getSettings().
//   - debounceMs
//     → not a side effect; the caller (index.ts) puts it on the
//     `ToolResultDetails` so the TUI can read it.
//
// Returned handle:
//   { effects, payloadFile, heartbeatStarted, clear() }
//   - `effects` lists what fired (in execution order) for assertions.
//   - `payloadFile` is the on-disk path of the onQuestionCommand JSON
//     (or null if not used). Useful for tests and for a future cleanup.
//   - `clear()` releases the heartbeat + any in-flight notification
//     timer. Call from the TUI's done/cancel paths.
//
// All spawns are wrapped in try/catch — side effects must NEVER break
// the tool. The TUI is shown even if every side effect fails.

import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomBytes as nodeRandomBytes } from "node:crypto";
import { writeFileSync as nodeWriteFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AskUserQuestionInput } from "./schema.ts";
import { getSettings, type AskUserQuestionSettings } from "./settings.ts";

/** Stable customType for the heartbeat message. Renderers can register
 * against this to suppress display if needed. */
export const HEARTBEAT_CUSTOM_TYPE = "ask-user-question-heartbeat";

/** Description of a single child_process.spawn call. Used for trace
 * assertions in tests. */
export interface SpawnRecord {
	cmd: string;
	args: string[];
	env?: NodeJS.ProcessEnv;
	shell?: boolean;
	detached?: boolean;
	stdio?: SpawnOptions["stdio"];
}

/** All deps the function needs from the outside world. Each has a
 * sensible default (the real Node API); tests override specific fields
 * to inject mocks. */
export interface SideEffectDeps {
	spawn?: typeof spawn;
	spawnSync?: typeof spawnSync;
	randomBytes?: (n: number) => Buffer;
	writeFileSync?: typeof nodeWriteFileSync;
	setInterval?: typeof setInterval;
	clearInterval?: typeof clearInterval;
	setTimeout?: typeof setTimeout;
	clearTimeout?: typeof clearTimeout;
	platform?: NodeJS.Platform;
	tmpDir?: string;
	/** herdr env detection. Default: process.env.HERDR_ENV ("1" inside a
	 * herdr-managed pane). Tests override to simulate being in herdr. */
	herdrEnv?: string;
	/** herdr pane id. Default: process.env.HERDR_PANE_ID. */
	herdrPaneId?: string;
	/** Override the getSettings() result. Useful for tests; production
	 * leaves this undefined and reads the live view. */
	getSettingsOverride?: AskUserQuestionSettings;
	/** Override the sendMessage implementation. Default: pi.sendMessage. */
	sendMessage?: ExtensionAPI["sendMessage"];
	/** Logger for "would fire" events. Default: silent. */
	log?: (line: string) => void;
}

export interface SideEffectHandle {
	/** Names of effects that fired (in execution order). Names:
	 *   "browserEnabled", "browserAutoOpen", "copyUrlToClipboard",
	 *   "notification", "tts", "command", "heartbeat", "herdr",
	 *   "dangerCheck" (dangerCheck is logged, not pushed). */
	effects: string[];
	/** Path to the temp file written for onQuestionCommand, or null. */
	payloadFile: string | null;
	/** True if the heartbeat interval was started. */
	heartbeatStarted: boolean;
	/** Clear any active timers (heartbeat, delayed notification). Safe
	 * to call multiple times. */
	clear(): void;
}

const NO_LOG: (line: string) => void = () => {};

/** Escape a string for inclusion inside a double-quoted AppleScript
 * literal. We use spawn with an args array (no shell), so the only
 * escaping needed is for the `"` and `\` characters that osascript
 * itself interprets. */
function escapeOsascript(s: string): string {
	return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Pick the platform-appropriate notification command + args.
 * Returns a record suitable for `spawn(cmd, args)`. */
export function notificationCommand(
	platform: NodeJS.Platform,
	header: string,
): { cmd: string; args: string[] } {
	const safe = header || "Question";
	if (platform === "darwin") {
		return {
			cmd: "osascript",
			args: [
				"-e",
				`display notification "${escapeOsascript(safe)}" with title "AskUserQuestion"`,
			],
		};
	}
	if (platform === "win32") {
		return { cmd: "msg", args: ["*", "/TIME:5", `AskUserQuestion: ${safe}`] };
	}
	// linux + other unix-likes
	return { cmd: "notify-send", args: ["AskUserQuestion", safe] };
}

/** Build the TTS command + args. `attn` is a TTS utility documented in
 * the host's CLAUDE.md — it takes a single message string. */
export function ttsCommand(header: string): { cmd: string; args: string[] } {
	const safe = header || "Question";
	return { cmd: "attn", args: [`AskUserQuestion: ${safe}`] };
}

export function browserOpenCommand(
	platform: NodeJS.Platform,
	url: string,
): { cmd: string; args: string[]; shell?: boolean } {
	if (platform === "darwin") return { cmd: "open", args: [url] };
	if (platform === "win32") return { cmd: "cmd", args: ["/c", "start", "", url], shell: false };
	return { cmd: "xdg-open", args: [url] };
}

export function clipboardCommand(
	platform: NodeJS.Platform,
): { cmd: string; args: string[] } {
	if (platform === "darwin") return { cmd: "pbcopy", args: [] };
	if (platform === "win32") return { cmd: "clip", args: [] };
	return { cmd: "xclip", args: ["-selection", "clipboard"] };
}

// -- herdr (agent multiplexer) blocked-status reporting -----------------
//
// While a questionnaire is on screen the agent is blocked on human input.
// Reporting `blocked` to herdr makes the sidebar dot, `herdr wait
// agent-status`, notifications, and workspace rollups reflect that. Outside
// a herdr-managed pane this is a no-op (see HERDR_ENV / HERDR_PANE_ID).

/** Source identity. The `user:` prefix marks a non-authority hook; the
 * `--agent pi` guard restricts the report to while pi is the active pane
 * agent. */
export const HERDR_SOURCE = "user:pi-questionnaire";
/** Agent label — the extension only runs inside pi. */
export const HERDR_AGENT = "pi";
/** Short visual label next to the blocked dot (herdr caps at 32 chars). */
export const HERDR_CUSTOM_STATUS = "answering question";

/** Build the `herdr pane report-agent` command that marks the pane
 * `blocked` while the questionnaire is on screen. */
export function herdrReportCommand(
	paneId: string,
	header: string,
): { cmd: string; args: string[] } {
	return {
		cmd: "herdr",
		args: [
			"pane", "report-agent", paneId,
			"--source", HERDR_SOURCE,
			"--agent", HERDR_AGENT,
			"--state", "blocked",
			"--custom-status", HERDR_CUSTOM_STATUS,
			"--message", `AskUserQuestion: ${header || "Question"}`,
		],
	};
}

/** Build the `herdr pane release-agent` command that restores the pane's
 * prior status authority when the questionnaire ends (answered, cancelled,
 * or thrown). */
export function herdrReleaseCommand(
	paneId: string,
): { cmd: string; args: string[] } {
	return {
		cmd: "herdr",
		args: [
			"pane", "release-agent", paneId,
			"--source", HERDR_SOURCE,
			"--agent", HERDR_AGENT,
		],
	};
}

function commandExists(cmd: string, platform: NodeJS.Platform, doSpawnSync: typeof spawnSync): boolean {
	const check = platform === "win32"
		? doSpawnSync("where", [cmd], { stdio: "ignore" })
		: doSpawnSync("command", ["-v", cmd], { shell: true, stdio: "ignore" });
	return check.status === 0;
}

export function openBrowserUrl(
	url: string,
	deps: Pick<SideEffectDeps, "spawn" | "platform" | "log"> = {},
): void {
	const doSpawn = deps.spawn ?? spawn;
	const platform = deps.platform ?? process.platform;
	const log = deps.log ?? NO_LOG;
	try {
		const { cmd, args, shell } = browserOpenCommand(platform, url);
		const child = doSpawn(cmd, args, { detached: true, stdio: "ignore", shell });
		child.unref?.();
	} catch (err) {
		log(`browser open failed: ${(err as Error).message}`);
	}
}

export function copyBrowserUrlToClipboard(
	url: string,
	deps: Pick<SideEffectDeps, "spawn" | "spawnSync" | "platform" | "log"> = {},
): void {
	const doSpawn = deps.spawn ?? spawn;
	const doSpawnSync = deps.spawnSync ?? spawnSync;
	const platform = deps.platform ?? process.platform;
	const log = deps.log ?? NO_LOG;
	try {
		const { cmd, args } = clipboardCommand(platform);
		if (!commandExists(cmd, platform, doSpawnSync)) {
			log(`clipboard command not found: ${cmd}`);
			return;
		}
		const child = doSpawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
		child.stdin?.end(url);
		child.unref?.();
	} catch (err) {
		log(`clipboard copy failed: ${(err as Error).message}`);
	}
}

export function fireBrowserUrlSideEffects(
	params: AskUserQuestionInput,
	url: string,
	deps: SideEffectDeps = {},
): string[] {
	const settings = deps.getSettingsOverride
		? { ...getSettings(), ...deps.getSettingsOverride }
		: getSettings();
	const effects: string[] = [];
	if (!settings.browserEnabled || params.questions.length < settings.browserMinQuestions) return effects;
	if (settings.copyUrlToClipboard) {
		copyBrowserUrlToClipboard(url, deps);
		effects.push("copyUrlToClipboard");
	}
	if (settings.browserAutoOpen) {
		openBrowserUrl(url, deps);
		effects.push("browserAutoOpen");
	}
	return effects;
}

export function fireOnQuestionSideEffects<P extends Pick<ExtensionAPI, "sendMessage">>(
	params: AskUserQuestionInput,
	pi: P,
	deps: SideEffectDeps = {},
): SideEffectHandle {
	const effects: string[] = [];
	const log = deps.log ?? NO_LOG;

	const settings = deps.getSettingsOverride
		? { ...getSettings(), ...deps.getSettingsOverride }
		: getSettings();

	const doSpawn = deps.spawn ?? spawn;
	const doRandom = deps.randomBytes ?? nodeRandomBytes;
	const doWrite = deps.writeFileSync ?? nodeWriteFileSync;
	const doSetInterval = deps.setInterval ?? setInterval;
	const doClearInterval = deps.clearInterval ?? clearInterval;
	const doSetTimeout = deps.setTimeout ?? setTimeout;
	const doClearTimeout = deps.clearTimeout ?? clearTimeout;
	const platform = deps.platform ?? process.platform;
	const tmpDir = deps.tmpDir ?? tmpdir();
	const sendMessage = deps.sendMessage ?? pi.sendMessage;

	const firstHeader = params.questions[0]?.header || "Question";

	// herdr env detection (overridable by tests). Outside a herdr pane
	// both are absent and the blocked-status effect below is a no-op.
	const herdrEnv = deps.herdrEnv ?? process.env.HERDR_ENV;
	const herdrPaneId = deps.herdrPaneId ?? process.env.HERDR_PANE_ID;

	let heartbeatHandle: ReturnType<typeof setInterval> | null = null;
	let heartbeatStarted = false;
	let notificationTimer: ReturnType<typeof setTimeout> | null = null;
	let payloadFile: string | null = null;
	let herdrArmed = false;
	let cleared = false;

	function unref(t: { unref?: () => void } | null | undefined): void {
		if (t && typeof t.unref === "function") {
			try {
				t.unref();
			} catch {
				/* ignore — some timers may not support unref */
			}
		}
	}

	function detach(child: ChildProcess | null): void {
		if (!child) return;
		// detached: true puts the child in its own process group; unref
		// lets the parent exit even if the child is still running. Both
		// are belt-and-braces.
		try {
			child.unref();
		} catch {
			/* ignore */
		}
	}

	function clear(): void {
		if (cleared) return;
		cleared = true;
		if (herdrArmed) {
			herdrArmed = false;
			if (typeof herdrPaneId === "string" && herdrPaneId.length > 0) {
				try {
					const { cmd, args } = herdrReleaseCommand(herdrPaneId);
					const child = doSpawn(cmd, args, { detached: true, stdio: "ignore" });
					detach(child);
				} catch (err) {
					log(`herdr release-agent failed: ${(err as Error).message}`);
				}
			}
		}
		if (heartbeatHandle !== null) {
			try {
				doClearInterval(heartbeatHandle);
			} catch {
				/* ignore */
			}
			heartbeatHandle = null;
		}
		if (notificationTimer !== null) {
			try {
				doClearTimeout(notificationTimer);
			} catch {
				/* ignore */
			}
			notificationTimer = null;
		}
	}

	// -- 1. Browser side effects ------------------------------------------
	if (settings.browserEnabled) {
		log("browser enabled");
		effects.push("browserEnabled");
	}
	if (
		settings.browserAutoOpen &&
		params.questions.length >= settings.browserMinQuestions
	) {
		log("would auto-open browser");
		effects.push("browserAutoOpen");
	}
	if (settings.copyUrlToClipboard) {
		log("browser URL will be copied to clipboard if the server starts");
		effects.push("copyUrlToClipboard");
	}

	// -- 2. Desktop notification -----------------------------------------
	if (settings.notificationOnQuestion) {
		effects.push("notification");
		const fire = () => {
			try {
				const { cmd, args } = notificationCommand(platform, firstHeader);
				const child = doSpawn(cmd, args, {
					detached: true,
					stdio: "ignore",
				});
				detach(child);
			} catch (err) {
				log(`notification spawn failed: ${(err as Error).message}`);
			}
		};
		if (settings.notificationDelaySeconds > 0) {
			notificationTimer = doSetTimeout(
				fire,
				settings.notificationDelaySeconds * 1000,
			);
			unref(notificationTimer as unknown as { unref?: () => void });
		} else {
			fire();
		}
	}

	// -- 3. TTS ----------------------------------------------------------
	if (settings.ttsOnQuestion) {
		effects.push("tts");
		try {
			const { cmd, args } = ttsCommand(firstHeader);
			const child = doSpawn(cmd, args, {
				detached: true,
				stdio: "ignore",
			});
			detach(child);
		} catch (err) {
			log(`tts spawn failed: ${(err as Error).message}`);
		}
	}

	// -- 4. onQuestionCommand --------------------------------------------
	if (settings.onQuestionCommand && settings.onQuestionCommand.length > 0) {
		// Effect is registered up front: the command is "fired" the moment
		// we accept the setting, even if a downstream step (mkdir, file
		// write, spawn) throws. Callers/tests can tell the command was
		// registered from effects; payloadFile tells them whether the
		// temp file was actually written.
		effects.push("command");
		try {
			const id = doRandom(8).toString("hex");
			const file = join(tmpDir, `ask-user-question-${id}.json`);
			doWrite(file, JSON.stringify(params), "utf-8");
			payloadFile = file;
			const child = doSpawn(settings.onQuestionCommand, [], {
				detached: true,
				stdio: "ignore",
				env: { ...process.env, PI_QUESTIONNAIRE_PAYLOAD_FILE: file },
				shell: true,
			});
			detach(child);
		} catch (err) {
			log(`onQuestionCommand failed: ${(err as Error).message}`);
		}
	}

	// -- 5. Heartbeat ----------------------------------------------------
	if (settings.heartbeatWhileActive) {
		const intervalMs = Math.max(1, settings.heartbeatIntervalMinutes) * 60_000;
		heartbeatHandle = doSetInterval(() => {
			try {
				// sendMessage is async (returns Promise<void> in the SDK
				// types). We fire-and-forget and swallow rejections so a
				// single failed tick doesn't kill the interval.
				const maybe = (sendMessage(
					{
						customType: HEARTBEAT_CUSTOM_TYPE,
						content: "AskUserQuestion is still waiting for an answer.",
						display: false,
						details: { tickAt: Date.now() },
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				) as unknown) as Promise<unknown> | void;
				if (maybe && typeof maybe.catch === "function") {
					maybe.catch((err) => {
						log(`heartbeat sendMessage rejected: ${(err as Error).message}`);
					});
				}
			} catch (err) {
				log(`heartbeat sendMessage threw: ${(err as Error).message}`);
			}
		}, intervalMs);
		unref(heartbeatHandle as unknown as { unref?: () => void });
		heartbeatStarted = true;
		effects.push("heartbeat");
	}

	// -- 6. Herdr blocked status -----------------------------------------
	// Inside a herdr-managed pane, report `blocked` so the sidebar dot,
	// waits, notifications, and rollups reflect that the agent is waiting
	// on a human. No-op outside herdr (HERDR_ENV / HERDR_PANE_ID absent).
	// Armed here, released in clear() via release-agent. report-agent has
	// no TTL, so release is the restore path; the --agent pi guard also
	// drops the report if pi exits first.
	if (
		settings.herdrReportBlocked &&
		herdrEnv === "1" &&
		typeof herdrPaneId === "string" &&
		herdrPaneId.length > 0
	) {
		effects.push("herdr");
		herdrArmed = true;
		try {
			const { cmd, args } = herdrReportCommand(herdrPaneId, firstHeader);
			const child = doSpawn(cmd, args, { detached: true, stdio: "ignore" });
			detach(child);
		} catch (err) {
			log(`herdr report-agent failed: ${(err as Error).message}`);
		}
	}

	// -- 7. dangerCheckEnabled (logged; TUI reads it itself) -------------
	log(`danger check: ${settings.dangerCheckEnabled ? "enabled" : "disabled"}`);
	// We do NOT push "dangerCheck" into effects — it's not a fire-able
	// action, just a status. Tests assert on the log instead.

	// -- 7. debounceMs (caller reads getSettings().debounceMs) -----------

	return {
		effects,
		payloadFile,
		heartbeatStarted,
		clear,
	};
}
