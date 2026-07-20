// src/settings.ts
// Persistence for the AskUserQuestion extension's settings.
//
// Layout:
//   Global:  <agentDir>/ask-user-question.json  (manual defaults; hand-edited
//             or written by a future settings menu; the extension itself
//             never writes the global file)
//   Project: <cwd>/.pi/ask-user-question.json   (overrides global; written by
//             the future settings menu)
//
// Merge order (low → high precedence):
//   DEFAULT_SETTINGS < global disk < project disk < in-memory test override
//
// getSettings() returns the resolved view. Tests can short-circuit disk reads
// via setInMemorySettings() / clearInMemorySettings().

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// --------------------------------------------------------------------------
// Interface (all 14 fields defined up front so future menu work has a stable
// shape; only `bellOnQuestion` is wired into behavior today).
// --------------------------------------------------------------------------

export interface AskUserQuestionSettings {
	/** Render an external browser page alongside the TUI (slice 5+). */
	browserEnabled?: boolean;
	/** Open the browser page automatically when the questionnaire mounts. */
	browserAutoOpen?: boolean;
	/** Auto-open the browser only when at least N questions are asked. */
	browserMinQuestions?: number;
	/** Copy the browser URL to the clipboard when it is generated. */
	copyUrlToClipboard?: boolean;
	/** Send a BEL (\x07) to the terminal when the questionnaire mounts. */
	bellOnQuestion?: boolean;
	/** Trigger a desktop notification when the questionnaire mounts. */
	notificationOnQuestion?: boolean;
	/** Delay (seconds) before the desktop notification fires. 0 = immediate. */
	notificationDelaySeconds?: number;
	/** Speak the question header + first question via TTS. */
	ttsOnQuestion?: boolean;
	/** Shell command to run when a questionnaire mounts (e.g. for custom alerts). */
	onQuestionCommand?: string;
	/** Send a keepalive heartbeat while the questionnaire is on screen.
	 *  HARD-DISABLED in 2.1.7 (B005) — setting is accepted but ignored. */
	heartbeatWhileActive?: boolean;
	/** Idle heartbeat interval in minutes (matches pi's 4.5m default).
	 *  Unused while heartbeat is hard-disabled (B005). */
	heartbeatIntervalMinutes?: number;
	/** Debounce (ms) when typing into number/free_text inputs. */
	debounceMs?: number;
	/** Show a confirmation prompt before destructive commands are executed. */
	dangerCheckEnabled?: boolean;
	/** Report `blocked` through Herdr's managed Pi integration while a
	 * questionnaire is on screen. No-ops when that integration is absent. */
	herdrReportBlocked?: boolean;
}

// --------------------------------------------------------------------------
// Defaults (single source of truth for resolved values when no overrides
// exist on disk).
// --------------------------------------------------------------------------

export const DEFAULT_SETTINGS: Required<AskUserQuestionSettings> = {
	browserEnabled: true,
	browserAutoOpen: false,
	browserMinQuestions: 2,
	copyUrlToClipboard: true,
	bellOnQuestion: true,
	notificationOnQuestion: false,
	notificationDelaySeconds: 30,
	ttsOnQuestion: false,
	onQuestionCommand: "",
	heartbeatWhileActive: false,
	heartbeatIntervalMinutes: 4.5,
	debounceMs: 300,
	dangerCheckEnabled: true,
	herdrReportBlocked: true,
};

// Sanity ceilings — prevent hand-edited configs from asking for values that
// make no operational sense. Permissive enough that any realistic power-user
// setting passes through.
const BROWSER_MIN_QUESTIONS_MIN = 1;
const BROWSER_MIN_QUESTIONS_MAX = 4; // AskUserQuestion caps at 4 questions/call
const NOTIFICATION_DELAY_MIN = 0;
const NOTIFICATION_DELAY_MAX = 300; // 5 minutes
const HEARTBEAT_INTERVAL_MIN = 0.5;
const HEARTBEAT_INTERVAL_MAX = 60;
const DEBOUNCE_MIN = 0;
const DEBOUNCE_MAX = 10_000;

// --------------------------------------------------------------------------
// Paths
// --------------------------------------------------------------------------

function globalPath(): string {
	return join(getAgentDir(), "ask-user-question.json");
}

function projectPath(cwd: string): string {
	return join(cwd, ".pi", "ask-user-question.json");
}

// --------------------------------------------------------------------------
// Sanitization — drop unknown keys and coerce/reject fields with the wrong
// shape. Garbage becomes absent silently (matches the pi-subagents pattern).
// --------------------------------------------------------------------------

function sanitize(raw: unknown): AskUserQuestionSettings {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const r = raw as Record<string, unknown>;
	const out: AskUserQuestionSettings = {};

	if (typeof r.browserEnabled === "boolean") out.browserEnabled = r.browserEnabled;
	if (typeof r.browserAutoOpen === "boolean") out.browserAutoOpen = r.browserAutoOpen;
	if (
		Number.isInteger(r.browserMinQuestions) &&
		(r.browserMinQuestions as number) >= BROWSER_MIN_QUESTIONS_MIN &&
		(r.browserMinQuestions as number) <= BROWSER_MIN_QUESTIONS_MAX
	) {
		out.browserMinQuestions = r.browserMinQuestions as number;
	}
	if (typeof r.copyUrlToClipboard === "boolean") out.copyUrlToClipboard = r.copyUrlToClipboard;
	if (typeof r.bellOnQuestion === "boolean") out.bellOnQuestion = r.bellOnQuestion;
	if (typeof r.notificationOnQuestion === "boolean") {
		out.notificationOnQuestion = r.notificationOnQuestion;
	}
	if (
		Number.isInteger(r.notificationDelaySeconds) &&
		(r.notificationDelaySeconds as number) >= NOTIFICATION_DELAY_MIN &&
		(r.notificationDelaySeconds as number) <= NOTIFICATION_DELAY_MAX
	) {
		out.notificationDelaySeconds = r.notificationDelaySeconds as number;
	}
	if (typeof r.ttsOnQuestion === "boolean") out.ttsOnQuestion = r.ttsOnQuestion;
	if (typeof r.onQuestionCommand === "string") {
		out.onQuestionCommand = r.onQuestionCommand as string;
	}
	if (typeof r.heartbeatWhileActive === "boolean") {
		out.heartbeatWhileActive = r.heartbeatWhileActive;
	}
	if (
		typeof r.heartbeatIntervalMinutes === "number" &&
		Number.isFinite(r.heartbeatIntervalMinutes) &&
		(r.heartbeatIntervalMinutes as number) >= HEARTBEAT_INTERVAL_MIN &&
		(r.heartbeatIntervalMinutes as number) <= HEARTBEAT_INTERVAL_MAX
	) {
		out.heartbeatIntervalMinutes = r.heartbeatIntervalMinutes as number;
	}
	if (
		Number.isInteger(r.debounceMs) &&
		(r.debounceMs as number) >= DEBOUNCE_MIN &&
		(r.debounceMs as number) <= DEBOUNCE_MAX
	) {
		out.debounceMs = r.debounceMs as number;
	}
	if (typeof r.dangerCheckEnabled === "boolean") out.dangerCheckEnabled = r.dangerCheckEnabled;
	if (typeof r.herdrReportBlocked === "boolean") out.herdrReportBlocked = r.herdrReportBlocked;

	return out;
}

/**
 * Read a settings file. Missing file is silent (returns `{}`). A file that
 * exists but can't be parsed emits a warning to stderr so users aren't
 * silently reverted to defaults — and still returns `{}` so startup proceeds.
 * Exported so tests can target arbitrary paths.
 */
export function readSettingsFile(path: string): AskUserQuestionSettings {
	if (!existsSync(path)) return {};
	try {
		return sanitize(JSON.parse(readFileSync(path, "utf-8")));
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		console.warn(`[pi-questionnaire] Ignoring malformed settings at ${path}: ${reason}`);
		return {};
	}
}

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

/**
 * Load merged settings: global provides defaults, project overrides.
 * Result is partial — fields not present in either file are undefined.
 * Use getSettings() when you want the fully-resolved view.
 *
 * `options.globalPath` / `options.projectPath` override the disk paths
 * (used by tests to point at tmp dirs without polluting the user's
 * real config directories).
 */
export function loadSettings(
	cwd: string = process.cwd(),
	options: { globalPath?: string; projectPath?: string } = {},
): AskUserQuestionSettings {
	return {
		...readSettingsFile(options.globalPath ?? globalPath()),
		...readSettingsFile(options.projectPath ?? projectPath(cwd)),
	};
}

/**
 * Write project-local settings. Global is never touched from code.
 * Returns `true` on success, `false` if the write (or mkdir) failed so
 * the caller can surface a warning — persistence isn't fatal but isn't
 * silent.
 */
export function saveSettings(
	s: AskUserQuestionSettings,
	cwd: string = process.cwd(),
): boolean {
	const path = projectPath(cwd);
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(s, null, 2), "utf-8");
		return true;
	} catch {
		return false;
	}
}

/**
 * In-memory override used by tests. When set, getSettings() returns the
 * override merged on top of disk + defaults. Setting it back to `null`
 * restores normal disk-based resolution.
 */
let inMemoryOverride: AskUserQuestionSettings | null = null;

export function setInMemorySettings(s: AskUserQuestionSettings | null): void {
	if (s === null) {
		inMemoryOverride = null;
	} else {
		inMemoryOverride = { ...s };
	}
}

export function clearInMemorySettings(): void {
	inMemoryOverride = null;
}

/**
 * Fully-resolved settings view: DEFAULT_SETTINGS + disk (global then
 * project) + in-memory override (if set). Tests use the in-memory
 * hook to override without touching disk.
 */
export function getSettings(cwd: string = process.cwd()): Required<AskUserQuestionSettings> {
	const fromDisk = loadSettings(cwd);
	const merged: AskUserQuestionSettings = { ...DEFAULT_SETTINGS, ...fromDisk };
	if (inMemoryOverride) {
		Object.assign(merged, inMemoryOverride);
	}
	// `merged` is now guaranteed to have every field — Required<> is sound.
	return merged as Required<AskUserQuestionSettings>;
}
