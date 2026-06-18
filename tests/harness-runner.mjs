// tests/harness-runner.mjs
// Helper that runs tests/harness.ts as a subprocess. Used by test_tui_render.mjs
// for the rare case where we want a normalized result without driving the
// full TUI.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const harnessPath = join(repoRoot, "tests", "harness.ts");

export function runHarness(cmd) {
	const proc = spawnSync("npx", ["tsx", harnessPath], {
		input: JSON.stringify(cmd),
		cwd: repoRoot,
		encoding: "utf-8",
		timeout: 30000,
	});
	if (proc.status !== 0) {
		throw new Error(`harness failed: ${proc.stderr}`);
	}
	return JSON.parse(proc.stdout.trim() || "null");
}
