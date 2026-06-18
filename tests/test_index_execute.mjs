import { test } from "node:test";
import assert from "node:assert/strict";
import extension from "../src/index.ts";
import { clearInMemorySettings, setInMemorySettings } from "../src/settings.ts";

function registerExtension() {
	const tools = [];
	const commands = [];
	extension({
		registerTool(tool) {
			tools.push(tool);
		},
		registerCommand(name, command) {
			commands.push({ name, command });
		},
		sendMessage: async () => {},
	});
	return { tools, commands };
}

test("AskUserQuestion clears side effects when ctx.ui.custom throws", async () => {
	const clears = [];
	const intervals = [];
	const timeouts = [];
	const pi = {
		registerTool(tool) {
			this.tool = tool;
		},
		registerCommand() {},
		sendMessage: async () => {},
	};
	extension(pi);
	assert.ok(pi.tool, "expected AskUserQuestion to be registered");

	const realSetInterval = globalThis.setInterval;
	const realClearInterval = globalThis.clearInterval;
	const realSetTimeout = globalThis.setTimeout;
	const realClearTimeout = globalThis.clearTimeout;

	globalThis.setInterval = ((cb, ms) => {
		const handle = { kind: "interval", ms, cleared: false, unref() {} };
		intervals.push(handle);
		return handle;
	});
	globalThis.clearInterval = ((handle) => {
		clears.push({ kind: "interval", handle });
		if (handle && typeof handle === "object") handle.cleared = true;
	});
	globalThis.setTimeout = ((cb, ms) => {
		const handle = { kind: "timeout", ms, cleared: false, unref() {} };
		timeouts.push(handle);
		return handle;
	});
	globalThis.clearTimeout = ((handle) => {
		clears.push({ kind: "timeout", handle });
		if (handle && typeof handle === "object") handle.cleared = true;
	});

	try {
		setInMemorySettings({
			notificationOnQuestion: true,
			notificationDelaySeconds: 5,
		});
		await assert.rejects(
			pi.tool.execute(
				"call-1",
				{
					questions: [{ header: "Danger", question: "Proceed?", type: "free_text" }],
				},
				new AbortController().signal,
				() => {},
				{
					mode: "tui",
					ui: {
						custom: async () => {
							throw new Error("boom");
						},
					},
				},
			),
			/boom/,
		);
	} finally {
		clearInMemorySettings();
		globalThis.setInterval = realSetInterval;
		globalThis.clearInterval = realClearInterval;
		globalThis.setTimeout = realSetTimeout;
		globalThis.clearTimeout = realClearTimeout;
	}

	assert.equal(intervals.length, 0, "heartbeat should stay off with default settings");
	assert.equal(timeouts.length, 1, "default delayed notification timer should be created");
	assert.equal(clears.length, 1, "pending side effects should be cleared in finally");
	assert.equal(clears[0].kind, "timeout");
	assert.equal(timeouts[0].cleared, true);
});

test("AskUserQuestion tool and settings command register", () => {
	const { tools, commands } = registerExtension();
	assert.equal(tools.length, 1);
	assert.equal(tools[0].name, "AskUserQuestion");
	assert.ok(commands.some((x) => x.name === "settings-ask-user-question"));
});
