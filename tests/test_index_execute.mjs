import { test } from "node:test";
import assert from "node:assert/strict";
import extension from "../src/index.ts";
import { clearInMemorySettings, setInMemorySettings } from "../src/settings.ts";

const fakeTheme = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	bold: (text) => text,
	italic: (text) => text,
	strikethrough: (text) => text,
};

function fakeTui() {
	return {
		requestRender() {},
		terminal: { rows: 24, cols: 100 },
	};
}

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
		on() {},
		events: { emit() {} },
		sendMessage: async () => {},
	});
	return { tools, commands };
}

test("AskUserQuestion clears side effects when ctx.ui.custom throws", async () => {
	const clears = [];
	const intervals = [];
	const timeouts = [];
	const events = [];
	const pi = {
		registerTool(tool) {
			if (tool.name === "AskUserQuestion") this.tool = tool;
		},
		registerCommand() {},
		on() {},
		events: {
			emit(name, data) {
				events.push({ name, data });
			},
		},
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
				browserEnabled: false,
				notificationOnQuestion: true,
				notificationDelaySeconds: 5,
				heartbeatWhileActive: false,
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
	assert.deepEqual(events, [
		{ name: "herdr:blocked", data: { active: true, label: "AskUserQuestion: Danger" } },
		{ name: "herdr:blocked", data: { active: false } },
	]);
});

test("AskUserQuestion starts browser server, injects URL, and stops server after submit", async () => {
	const events = [];
	const pi = {
		registerTool(tool) {
			if (tool.name === "AskUserQuestion") this.tool = tool;
		},
		registerCommand() {},
		on() {},
		events: {
			emit(name, data) {
				events.push({ name, data });
			},
		},
		sendMessage: async () => {},
	};
	extension(pi);
	setInMemorySettings({
		browserEnabled: true,
		browserMinQuestions: 1,
		browserAutoOpen: false,
		copyUrlToClipboard: false,
		bellOnQuestion: false,
	});
	let rendered = "";
	try {
		const result = await pi.tool.execute(
			"call-browser",
			{
				questions: [
					{ id: "pick", header: "Pick", question: "Pick?", type: "select_one", options: [{ label: "A" }] },
					{ id: "note", header: "Note", question: "Note?", type: "free_text" },
				],
			},
			new AbortController().signal,
			() => {},
			{
				mode: "tui",
				ui: {
					custom: async (build) => {
						let doneValue = null;
						const component = build(fakeTui(), fakeTheme, {}, (value) => {
							doneValue = value;
						});
						rendered = component.render(100).join("\n");
						component.handleInput("\r"); // select first option, advance to free_text
						component.handleInput("o");
						component.handleInput("k");
						component.applyBrowserOptions({ notes: { note: "browser note" } });
						component.handleInput("\r"); // commit free_text, advance to submit
						await new Promise((resolve) => setTimeout(resolve, 260));
						component.handleInput("\r"); // submit after the production debounce
						return doneValue;
					},
				},
			},
		);
		assert.match(rendered, /http:\/\/127\.0\.0\.1:\d+\/q\//);
		assert.equal(result.details.lifecycle, "answered");
		assert.deepEqual(result.details.notes, { note: "browser note" });
		assert.match(result.content[0].text, /note \(Note\): browser note/);
		assert.match(result.details.url, /http:\/\/127\.0\.0\.1:\d+\/q\//);
		assert.equal(typeof result.details.port, "number");
		await assert.rejects(fetch(`http://127.0.0.1:${result.details.port}/healthz`));
		assert.deepEqual(events, [
			{ name: "herdr:blocked", data: { active: true, label: "AskUserQuestion: Pick" } },
			{ name: "herdr:blocked", data: { active: false } },
		]);
	} finally {
		clearInMemorySettings();
	}
});

test("ask_user single-question mode emits and clears Herdr blocked state", async () => {
	const events = [];
	const pi = {
		registerTool(tool) {
			if (tool.name === "ask_user") this.tool = tool;
		},
		registerCommand() {},
		on() {},
		events: {
			emit(name, data) {
				events.push({ name, data });
			},
		},
		sendMessage: async () => {},
	};
	extension(pi);
	setInMemorySettings({ browserEnabled: false, bellOnQuestion: false });
	try {
		const result = await pi.tool.execute(
			"call-ask-user-single",
			{ method: "confirm", title: "Proceed" },
			new AbortController().signal,
			() => {},
			{
				mode: "tui",
				ui: {
					custom: async (build) => {
						let doneValue = null;
						const component = build(fakeTui(), fakeTheme, {}, (value) => {
							doneValue = value;
						});
						component.handleInput("\r");
						await new Promise((resolve) => setTimeout(resolve, 260));
						component.handleInput("\r");
						return doneValue;
					},
				},
			},
		);

		assert.equal(result.details.lifecycle, "answered");
		assert.deepEqual(events, [
			{ name: "herdr:blocked", data: { active: true, label: "AskUserQuestion: Proceed" } },
			{ name: "herdr:blocked", data: { active: false } },
		]);
	} finally {
		clearInMemorySettings();
	}
});

test("ask_user batch mode emits and clears one Herdr blocked scope", async () => {
	const events = [];
	const pi = {
		registerTool(tool) {
			if (tool.name === "ask_user") this.tool = tool;
		},
		registerCommand() {},
		on() {},
		events: {
			emit(name, data) {
				events.push({ name, data });
			},
		},
		sendMessage: async () => {},
	};
	extension(pi);
	setInMemorySettings({ browserEnabled: false, bellOnQuestion: false });
	try {
		const result = await pi.tool.execute(
			"call-ask-user-batch",
			{
				questions: [
					{ method: "confirm", title: "First" },
					{ method: "confirm", title: "Second" },
				],
			},
			new AbortController().signal,
			() => {},
			{
				mode: "tui",
				ui: {
					custom: async (build) => {
						let doneValue = null;
						const component = build(fakeTui(), fakeTheme, {}, (value) => {
							doneValue = value;
						});
						component.handleInput("\r");
						component.handleInput("\r");
						await new Promise((resolve) => setTimeout(resolve, 260));
						component.handleInput("\r");
						return doneValue;
					},
				},
			},
		);

		assert.equal(result.details.lifecycle, "answered");
		assert.deepEqual(events, [
			{ name: "herdr:blocked", data: { active: true, label: "AskUserQuestion: First" } },
			{ name: "herdr:blocked", data: { active: false } },
		]);
	} finally {
		clearInMemorySettings();
	}
});

test("AskUserQuestion non-TUI rejection emits no Herdr lifecycle event", async () => {
	const events = [];
	const pi = {
		registerTool(tool) {
			if (tool.name === "AskUserQuestion") this.tool = tool;
		},
		registerCommand() {},
		on() {},
		events: {
			emit(name, data) {
				events.push({ name, data });
			},
		},
		sendMessage: async () => {},
	};
	extension(pi);

	const result = await pi.tool.execute(
		"call-print",
		{ questions: [{ header: "Headless", question: "Proceed?", type: "confirm_enum" }] },
		new AbortController().signal,
		() => {},
		{ mode: "print", ui: {} },
	);

	assert.equal(result.details.lifecycle, "cancelled");
	assert.deepEqual(events, []);
});

test("AskUserQuestion tools and settings command register", () => {
	const { tools, commands } = registerExtension();
	assert.deepEqual(tools.map((tool) => tool.name), ["AskUserQuestion", "ask_user"]);
	assert.ok(commands.some((x) => x.name === "settings-ask-user-question"));
});
