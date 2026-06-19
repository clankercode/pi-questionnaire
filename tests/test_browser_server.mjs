import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import vm from "node:vm";
import { once } from "node:events";
import { normalizeQuestions } from "../src/normalize.ts";
import { startBrowserSyncServer } from "../src/browser-server.ts";

const QUESTIONS = normalizeQuestions([
	{
		id: "color",
		header: "Color",
		question: "Pick a color?",
		type: "select_one",
		options: [{ label: "Red" }, { label: "Blue" }],
	},
	{
		id: "note",
		header: "Note",
		question: "Anything else?",
		type: "free_text",
	},
]);

async function fetchText(url) {
	const response = await fetch(url);
	return { response, text: await response.text() };
}

function encodeClientFrame(payload) {
	const data = Buffer.from(payload, "utf8");
	const header = [];
	header.push(0x81);
	if (data.length < 126) {
		header.push(0x80 | data.length);
	} else if (data.length < 65536) {
		header.push(0x80 | 126, (data.length >> 8) & 0xff, data.length & 0xff);
	} else {
		throw new Error("test frame too large");
	}
	const mask = Buffer.from([1, 2, 3, 4]);
	const masked = Buffer.alloc(data.length);
	for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
	return Buffer.concat([Buffer.from(header), mask, masked]);
}

function tryReadServerFrame(buffer) {
	if (buffer.length < 2) return null;
	const opcode = buffer[0] & 0x0f;
	let length = buffer[1] & 0x7f;
	let offset = 2;
	if (length === 126) {
		if (buffer.length < 4) return null;
		length = buffer.readUInt16BE(2);
		offset = 4;
	} else if (length === 127) {
		if (buffer.length < 10) return null;
		const high = buffer.readUInt32BE(2);
		if (high !== 0) throw new Error("test frame too large");
		length = buffer.readUInt32BE(6);
		offset = 10;
	}
	if (buffer.length < offset + length) return null;
	const payload = buffer.subarray(offset, offset + length);
	return {
		opcode,
		message: opcode === 1 ? JSON.parse(payload.toString("utf8")) : null,
		rest: buffer.subarray(offset + length),
	};
}

async function connectWs(handle) {
	const socket = net.createConnection({ host: "127.0.0.1", port: handle.port });
	await once(socket, "connect");
	const key = Buffer.from("pi-questionnaire-test-key!").toString("base64");
	socket.write(
		`GET /ws?batch=${handle.batchId}&nonce=${handle.nonce} HTTP/1.1\r\n` +
		`Host: 127.0.0.1:${handle.port}\r\n` +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		`Sec-WebSocket-Key: ${key}\r\n` +
		"Sec-WebSocket-Version: 13\r\n" +
		"\r\n",
	);
	let buffer = Buffer.alloc(0);
	while (!buffer.includes(Buffer.from("\r\n\r\n"))) {
		const [chunk] = await once(socket, "data");
		buffer = Buffer.concat([buffer, chunk]);
	}
	const split = buffer.indexOf("\r\n\r\n");
	const header = buffer.subarray(0, split).toString("utf8");
	assert.match(header, /101 Switching Protocols/);
	let frameBuffer = buffer.subarray(split + 4);
	const messages = [];
	function drain() {
		while (true) {
			const frame = tryReadServerFrame(frameBuffer);
			if (!frame) return;
			frameBuffer = frame.rest;
			if (frame.message) messages.push(frame.message);
		}
	}
	drain();
	socket.on("data", (chunk) => {
		frameBuffer = Buffer.concat([frameBuffer, chunk]);
		drain();
	});
	async function nextMessage(type, timeoutMs = 1000) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const idx = messages.findIndex((message) => type === undefined || message.type === type);
			if (idx !== -1) return messages.splice(idx, 1)[0];
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw new Error(`timed out waiting for websocket message ${type ?? "<any>"}`);
	}
	return {
		socket,
		send(message) {
			socket.write(encodeClientFrame(JSON.stringify(message)));
		},
		nextMessage,
		close() {
			socket.destroy();
		},
	};
}

function createFakeBrowserDom() {
	const elementsById = new Map();
	let documentRef;

	class FakeClassList {
		constructor(element) {
			this.element = element;
		}
		toggle(name, force) {
			const classes = new Set(this.element.className.split(/\s+/).filter(Boolean));
			const shouldHave = force ?? !classes.has(name);
			if (shouldHave) classes.add(name);
			else classes.delete(name);
			this.element.className = [...classes].join(" ");
		}
		add(name) {
			this.toggle(name, true);
		}
	}

	class FakeElement {
		constructor(tagName) {
			this.tagName = tagName.toUpperCase();
			this.children = [];
			this.dataset = {};
			this.style = {};
			this.className = "";
			this.classList = new FakeClassList(this);
			this.value = "";
			this.textContent = "";
			this.selectionStart = 0;
			this.selectionEnd = 0;
		}
		set id(value) {
			this._id = value;
			elementsById.set(value, this);
		}
		get id() {
			return this._id;
		}
		set innerHTML(value) {
			this._innerHTML = value;
			for (const child of this.children) child.detach();
			this.children = [];
		}
		get innerHTML() {
			return this._innerHTML || "";
		}
		appendChild(child) {
			child.parent = this;
			this.children.push(child);
			return child;
		}
		append(...items) {
			for (const item of items) {
				if (typeof item === "string") this.textContent += item;
				else this.appendChild(item);
			}
		}
		detach() {
			if (documentRef.activeElement === this) documentRef.activeElement = documentRef.body;
			for (const child of this.children) child.detach();
		}
		focus() {
			documentRef.activeElement = this;
			this.onfocus?.();
		}
		setSelectionRange(start, end) {
			this.selectionStart = start;
			this.selectionEnd = end;
		}
		matches(selector) {
			const focusMatch = selector.match(/^\[data-focus-key="([^"]+)"\]$/);
			if (focusMatch) return this.dataset.focusKey === focusMatch[1];
			const checkedNameMatch = selector.match(/^\[name="([^"]+)"\]:checked$/);
			if (checkedNameMatch) return this.name === checkedNameMatch[1] && this.checked;
			return false;
		}
		findAll(predicate, out = []) {
			if (predicate(this)) out.push(this);
			for (const child of this.children) child.findAll(predicate, out);
			return out;
		}
	}

	const document = {
		body: null,
		activeElement: null,
		createElement(tagName) {
			return new FakeElement(tagName);
		},
		getElementById(id) {
			return elementsById.get(id) || null;
		},
		querySelector(selector) {
			return this.body.findAll((el) => el.matches(selector))[0] || null;
		},
		querySelectorAll(selector) {
			if (selector === "#questions .question") {
				return this.getElementById("questions").findAll((el) => el.className.split(/\s+/).includes("question"));
			}
			return this.body.findAll((el) => el.matches(selector));
		},
		addEventListener() {},
	};
	documentRef = document;
	document.body = new FakeElement("body");
	document.activeElement = document.body;
	for (const id of ["status", "questions", "overlay", "submit", "cancel"]) {
		const element = new FakeElement(id === "questions" ? "div" : id === "status" ? "p" : "button");
		element.id = id;
		document.body.appendChild(element);
	}
	return document;
}

function scriptFromPage(html) {
	const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
	assert.equal(scripts.length, 1);
	return scripts[0];
}

test("browser server serves healthz and questionnaire page", async () => {
	const handle = await startBrowserSyncServer({ questions: QUESTIONS, preferredPort: 0 });
	try {
		assert.equal(handle.url, `http://127.0.0.1:${handle.port}/q/${handle.batchId}?nonce=${handle.nonce}`);
		const health = await fetchText(`http://127.0.0.1:${handle.port}/healthz`);
		assert.equal(health.response.status, 200);
		assert.equal(health.text, "ok");

		const page = await fetchText(handle.url);
		assert.equal(page.response.status, 200);
		assert.match(page.response.headers.get("content-type") ?? "", /text\/html/);
		assert.match(page.text, /Pick a color\?/);
		assert.match(page.text, new RegExp(`/ws\\?batch=${handle.batchId}&nonce=${handle.nonce}`));

		const forbidden = await fetchText(`http://127.0.0.1:${handle.port}/q/${handle.batchId}?nonce=wrong`);
		assert.equal(forbidden.response.status, 403);
	} finally {
		await handle.stop();
	}
});

test("browser websocket sends initial state and replies to ping", async () => {
	const handle = await startBrowserSyncServer({ questions: QUESTIONS, preferredPort: 0 });
	let client;
	try {
		client = await connectWs(handle);
		const state = await client.nextMessage("state");
		assert.equal(state.currentTab, 0);
		assert.equal(state.questions.length, 2);
		assert.deepEqual(state.answers, {});
		assert.deepEqual(state.options.notes, {});
		assert.equal(state.lifecycle, "open");

		client.send({ type: "ping" });
		assert.deepEqual(await client.nextMessage("pong"), { type: "pong" });
	} finally {
		client?.close();
		await handle.stop();
	}
});

test("browser websocket accepts answer, tab, submit, and cancel messages", async () => {
	const events = [];
	const handle = await startBrowserSyncServer({
		questions: QUESTIONS,
		preferredPort: 0,
		onAnswer: (questionId, value) => events.push({ type: "answer", questionId, value }),
		onTab: (currentTab) => events.push({ type: "tab", currentTab }),
		onSubmit: () => events.push({ type: "submit" }),
		onCancel: () => events.push({ type: "cancel" }),
	});
	let client;
	try {
		client = await connectWs(handle);
		await client.nextMessage("state");

		client.send({ type: "answer", questionId: "color", value: "Red" });
		const answers = await client.nextMessage("answers");
		assert.deepEqual(answers.answers, { "0": { mode: "option", value: "Red" } });
		assert.deepEqual(events[0], { type: "answer", questionId: "color", value: { mode: "option", value: "Red" } });

		client.send({ type: "answer", questionId: "note", value: "  keep   all spaces  " });
		const textAnswers = await client.nextMessage("answers");
		assert.equal(textAnswers.answers["1"], "  keep   all spaces  ");
		assert.deepEqual(events[1], { type: "answer", questionId: "note", value: "  keep   all spaces  " });

		client.send({ type: "tab", currentTab: 1 });
		assert.deepEqual(await client.nextMessage("tab"), { type: "tab", currentTab: 1 });
		assert.deepEqual(events[2], { type: "tab", currentTab: 1 });

		client.send({ type: "submit" });
		client.send({ type: "cancel" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.deepEqual(events.slice(3), [{ type: "submit" }, { type: "cancel" }]);
	} finally {
		client?.close();
		await handle.stop();
	}
});

test("browser page script restores answers and auto-tabs on control focus", async () => {
	const handle = await startBrowserSyncServer({ questions: QUESTIONS, preferredPort: 0 });
	try {
		const page = await fetchText(handle.url);
		assert.equal(page.response.status, 200);
		assert.match(page.text, /input\.checked = isChoiceChecked/);
		assert.match(page.text, /other\.value = otherAnswerText\(i\)/);
		assert.match(page.text, /input\.onfocus = \(\) => activateQuestion\(i\)/);
		assert.match(page.text, /input\.onchange = \(\) => \{ activateQuestion\(i\)/);
		assert.match(page.text, /el\.value === '' \? null : Number\(el\.value\)/);
		assert.match(page.text, /setTimeout\(connect, reconnectDelay\)/);
		assert.match(page.text, /if\(terminalLifecycle\) return/);
		assert.match(page.text, /let terminalLifecycle = state\.lifecycle !== 'open'/);
		assert.match(page.text, /let awaitingState = !terminalLifecycle/);
		assert.match(page.text, /setOverlayPending\(true, 'Connecting to TUI\.\.\.'\)/);
		assert.match(page.text, /classList\.toggle\('visible', awaitingState && !terminalLifecycle\)/);
		assert.match(page.text, /if\(message\.lifecycle && message\.lifecycle !== 'open'\) terminalLifecycle = true/);
		assert.doesNotMatch(page.text, /classList\.toggle\('visible', terminalLifecycle\)/);
		assert.doesNotMatch(page.text, /classList\.toggle\('visible', state\.currentTab === state\.questions\.length\)/);
		assert.match(page.text, /function renderPreview/);
		assert.match(page.text, /function renderMarkdown/);
		assert.match(page.text, /document\.activeElement\?\.dataset\?\.previewKey/);
	} finally {
		await handle.stop();
	}
});

test("browser page preserves focused text control across websocket answer renders", async () => {
	const handle = await startBrowserSyncServer({ questions: QUESTIONS, preferredPort: 0 });
	try {
		const page = await fetchText(handle.url);
		const document = createFakeBrowserDom();
		const sockets = [];
		class FakeWebSocket {
			static OPEN = 1;
			constructor(url) {
				this.url = url;
				this.readyState = FakeWebSocket.OPEN;
				sockets.push(this);
			}
			send() {}
		}
		const context = vm.createContext({
			document,
			WebSocket: FakeWebSocket,
			setInterval() {},
			setTimeout() {},
			clearTimeout() {},
		});
		new vm.Script(scriptFromPage(page.text)).runInContext(context);
		assert.equal(sockets.length, 1);

		const input = document.querySelector('[data-focus-key="q-1-input"]');
		assert.ok(input);
		input.value = "hello";
		input.focus();
		input.setSelectionRange(3, 3);

		sockets[0].onmessage({ data: JSON.stringify({ type: "answers", answers: { "1": "hello" } }) });

		assert.equal(document.activeElement.dataset.focusKey, "q-1-input");
		assert.notEqual(document.activeElement, input);
		assert.equal(document.activeElement.value, "hello");
		assert.equal(document.activeElement.selectionStart, 3);
		assert.equal(document.activeElement.selectionEnd, 3);
	} finally {
		await handle.stop();
	}
});

test("browser page flushes pending answer and notes before submit", async () => {
	const handle = await startBrowserSyncServer({ questions: QUESTIONS, preferredPort: 0 });
	try {
		const page = await fetchText(handle.url);
		const document = createFakeBrowserDom();
		const sent = [];
		const sockets = [];
		class FakeWebSocket {
			static OPEN = 1;
			constructor(url) {
				this.url = url;
				this.readyState = FakeWebSocket.OPEN;
				sockets.push(this);
			}
			send(message) {
				sent.push(JSON.parse(message));
			}
		}
		const context = vm.createContext({
			document,
			WebSocket: FakeWebSocket,
			setInterval() {},
			setTimeout() {},
			clearTimeout() {},
		});
		new vm.Script(scriptFromPage(page.text)).runInContext(context);
		assert.equal(sockets.length, 1);
		sockets[0].onmessage({ data: JSON.stringify({ type: "state", questions: QUESTIONS, currentTab: 0, answers: {}, options: { notes: {} }, lifecycle: "open" }) });

		const input = document.querySelector('[data-focus-key="q-1-input"]');
		assert.ok(input);
		input.value = "  keep   answer spaces  ";
		input.focus();
		input.oninput();

		const notes = document.querySelector('[data-focus-key="q-1-notes"]');
		assert.ok(notes);
		notes.value = "  keep   note spaces  ";
		notes.focus();
		notes.oninput();

		document.getElementById("submit").onclick();
		assert.deepEqual(sent.slice(-3), [
			{ type: "answer", questionId: "note", value: "  keep   answer spaces  " },
			{ type: "options", options: { notes: { note: "  keep   note spaces  " } } },
			{ type: "submit" },
		]);
	} finally {
		await handle.stop();
	}
});

test("browser page hides pending overlay after terminal lifecycle", async () => {
	const handle = await startBrowserSyncServer({ questions: QUESTIONS, preferredPort: 0 });
	try {
		const page = await fetchText(handle.url);
		const document = createFakeBrowserDom();
		const sockets = [];
		class FakeWebSocket {
			static OPEN = 1;
			constructor(url) {
				this.url = url;
				this.readyState = FakeWebSocket.OPEN;
				sockets.push(this);
			}
			send() {}
		}
		const context = vm.createContext({
			document,
			WebSocket: FakeWebSocket,
			setInterval() {},
			setTimeout() {},
			clearTimeout() {},
		});
		new vm.Script(scriptFromPage(page.text)).runInContext(context);
		const overlay = document.getElementById("overlay");
		assert.match(overlay.className, /visible/);
		sockets[0].onmessage({ data: JSON.stringify({ type: "state", questions: QUESTIONS, currentTab: 0, answers: {}, options: { notes: {} }, lifecycle: "open" }) });
		assert.doesNotMatch(overlay.className, /visible/);
		sockets[0].onclose();
		assert.match(overlay.className, /visible/);
		sockets[0].onmessage({ data: JSON.stringify({ type: "lifecycle", lifecycle: "submitted" }) });
		assert.doesNotMatch(overlay.className, /visible/);
		assert.equal(document.getElementById("status").textContent, "Submitted");
		assert.equal(document.getElementById("questions").children.length, 0);
		assert.match(document.getElementById("questions").textContent, /Questionnaire submitted/);
	} finally {
		await handle.stop();
	}
});

test("browser page avoids unconditional websocket re-renders and restores focused controls", async () => {
	const handle = await startBrowserSyncServer({ questions: QUESTIONS, preferredPort: 0 });
	try {
		const page = await fetchText(handle.url);
		assert.equal(page.response.status, 200);
		assert.match(page.text, /function applyServerMessage/);
		assert.match(page.text, /if\(dom\.needsRender\) render\(\)/);
		assert.match(page.text, /function captureFocus/);
		assert.match(page.text, /function restoreFocus/);
		assert.match(page.text, /data-focus-key/);
		assert.match(page.text, /restoreFocus\(focus\)/);
		assert.match(page.text, /function updateActiveQuestionClasses/);
		assert.doesNotMatch(page.text, /\n    render\(\);\n  \};/);
	} finally {
		await handle.stop();
	}
});

test("browser page inline script is syntactically valid", async () => {
	const handle = await startBrowserSyncServer({ questions: QUESTIONS, preferredPort: 0 });
	try {
		const page = await fetchText(handle.url);
		assert.equal(page.response.status, 200);
		const scripts = [...page.text.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
		assert.equal(scripts.length, 1);
		assert.doesNotThrow(() => new vm.Script(scripts[0]));
	} finally {
		await handle.stop();
	}
});

test("reconnected websocket receives latest full state snapshot", async () => {
	const handle = await startBrowserSyncServer({ questions: QUESTIONS, preferredPort: 0 });
	let first;
	let second;
	try {
		first = await connectWs(handle);
		await first.nextMessage("state");
		first.send({ type: "answer", questionId: "color", value: "Blue" });
		await first.nextMessage("answers");
		first.close();
		second = await connectWs(handle);
		const state = await second.nextMessage("state");
		assert.deepEqual(state.answers, { "0": { mode: "option", value: "Blue" } });
	} finally {
		first?.close();
		second?.close();
		await handle.stop();
	}
});

test("browser submit rejection keeps lifecycle open and syncs review tab", async () => {
	const events = [];
	let acceptsSubmit = false;
	let handle;
	handle = await startBrowserSyncServer({
		questions: QUESTIONS,
		preferredPort: 0,
		onSubmit: () => {
			events.push({ type: "submit" });
			if (!acceptsSubmit) {
				handle.updateFromTui({ currentTab: QUESTIONS.length });
				return false;
			}
			return true;
		},
	});
	let client;
	try {
		client = await connectWs(handle);
		await client.nextMessage("state");

		client.send({ type: "submit" });
		assert.deepEqual(await client.nextMessage("tab"), { type: "tab", currentTab: QUESTIONS.length });
		await assert.rejects(
			() => client.nextMessage("lifecycle", 60),
			/timed out waiting for websocket message lifecycle/,
		);

		acceptsSubmit = true;
		client.send({ type: "submit" });
		assert.deepEqual(await client.nextMessage("lifecycle"), { type: "lifecycle", lifecycle: "submitted" });
		assert.deepEqual(events, [{ type: "submit" }, { type: "submit" }]);
	} finally {
		client?.close();
		await handle.stop();
	}
});

test("late websocket join receives terminal lifecycle in state snapshot", async () => {
	const handle = await startBrowserSyncServer({ questions: QUESTIONS, preferredPort: 0 });
	let client;
	try {
		handle.updateFromTui({ lifecycle: "submitted" });
		client = await connectWs(handle);
		const state = await client.nextMessage("state");
		assert.equal(state.lifecycle, "submitted");
	} finally {
		client?.close();
		await handle.stop();
	}
});

test("stopping an open browser server broadcasts cancelled lifecycle", async () => {
	const handle = await startBrowserSyncServer({ questions: QUESTIONS, preferredPort: 0 });
	let client;
	try {
		client = await connectWs(handle);
		await client.nextMessage("state");
		const stopped = handle.stop();
		assert.deepEqual(await client.nextMessage("lifecycle"), { type: "lifecycle", lifecycle: "cancelled" });
		await stopped;
	} finally {
		client?.close();
		await handle.stop();
	}
});

test("empty number answers clear stale state instead of coercing to zero", async () => {
	const numberQuestions = normalizeQuestions([
		{ id: "count", header: "Count", question: "How many?", type: "number", min: 0 },
	]);
	const events = [];
	const handle = await startBrowserSyncServer({
		questions: numberQuestions,
		preferredPort: 0,
		onAnswer: (questionId, value) => events.push({ type: "answer", questionId, value }),
		onClearAnswer: (questionId) => events.push({ type: "clear", questionId }),
	});
	let client;
	try {
		client = await connectWs(handle);
		await client.nextMessage("state");
		client.send({ type: "answer", questionId: "count", value: 5 });
		assert.deepEqual(await client.nextMessage("answers"), { type: "answers", answers: { "0": 5 } });
		client.send({ type: "answer", questionId: "count", value: null });
		assert.deepEqual(await client.nextMessage("answers"), { type: "answers", answers: {} });
		assert.deepEqual(events, [
			{ type: "answer", questionId: "count", value: 5 },
			{ type: "clear", questionId: "count" },
		]);
	} finally {
		client?.close();
		await handle.stop();
	}
});
