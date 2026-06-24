import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import vm from "node:vm";
import { once } from "node:events";
import { coerceAnswer } from "../src/answers.ts";
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
		remove(name) {
			this.toggle(name, false);
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
			this._directText = "";
			this.selectionStart = 0;
			this.selectionEnd = 0;
		}
		set textContent(value) {
			this._directText = value;
			for (const child of this.children) child.detach();
			this.children = [];
		}
		get textContent() {
			if (this.children.length === 0) return this._directText;
			let result = this._directText;
			for (const child of this.children) result += child.textContent;
			return result;
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
			this._directText = "";
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
				if (typeof item === "string") this._directText += item;
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
			if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
			const attrs = [...selector.matchAll(/\[(\w+)=["']?([^"'\]]*)["']?\]/g)];
			if (attrs.length > 0) {
				const tagMatch = selector.match(/^(\w+)/);
				const tag = tagMatch ? tagMatch[1] : null;
				if (tag && this.tagName !== tag.toUpperCase()) return false;
				return attrs.every(m => {
					const [, key, val] = m;
					if (key === 'type') return this.type === val;
					if (key === 'name') return this.name === val;
					return this.dataset[key] === val;
				});
			}
			return false;
		}
		findAll(predicate, out = []) {
			if (predicate(this)) out.push(this);
			for (const child of this.children) child.findAll(predicate, out);
			return out;
		}
		querySelectorAll(selector) {
			return this.findAll((el) => el.matches(selector));
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
	for (const id of ["status", "progress", "questions", "actions", "overlay", "mode-wrapper"]) {
		const element = new FakeElement(id === "status" ? "p" : "div");
		element.id = id;
		document.body.appendChild(element);
	}
	for (const id of ["submit"]) {
		const element = new FakeElement("button");
		element.id = id;
		document.getElementById("actions").appendChild(element);
	}
	for (const id of ["back-btn", "next-btn"]) {
		const element = new FakeElement("button");
		element.id = id;
		document.getElementById("mode-wrapper").appendChild(element);
	}
	for (const id of ["theme-toggle", "layout-toggle"]) {
		const element = new FakeElement("button");
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

function createFakeLocalStorage() {
	const store = new Map();
	return {
		getItem(key) { return store.has(key) ? store.get(key) : null; },
		setItem(key, value) { store.set(key, String(value)); },
		removeItem(key) { store.delete(key); },
	};
}

test("confirm_enum sentinel Other value is not accepted as typed Other text", () => {
	const [question] = normalizeQuestions([{ id: "go", header: "Go", question: "Proceed?", type: "confirm_enum" }]);
	assert.equal(coerceAnswer("__other__", question), undefined);
	assert.equal(coerceAnswer({ mode: "other", text: "__other__" }, question), undefined);
});


test("browser page treats internal Other sentinel text as unanswered", async () => {
	const otherQuestions = normalizeQuestions([
		{ id: "decision", header: "Decision", question: "Proceed?", type: "confirm_enum" },
	]);
	const handle = await startBrowserSyncServer({
		questions: otherQuestions,
		initialAnswers: { "0": { mode: "other", text: "__other__" } },
		preferredPort: 0,
	});
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
			localStorage: createFakeLocalStorage(),
			setInterval() {},
			setTimeout() {},
			clearTimeout() {},
		});
		new vm.Script(scriptFromPage(page.text)).runInContext(context);

		const otherInput = document.querySelector('[data-focus-key="q-0-other"]');
		const otherRadio = document.querySelector('[data-focus-key="q-0-choice-2"]');
		assert.ok(otherInput);
		assert.ok(otherRadio);
		assert.equal(otherInput.value, "");
		assert.equal(otherRadio.checked, false);

		sockets[0].onmessage({ data: JSON.stringify({ type: "tab", currentTab: otherQuestions.length }) });
		const reviewText = document.getElementById("questions").children[0].textContent;
		assert.doesNotMatch(reviewText, /__other__/);
		assert.match(reviewText, /Decision/);
		assert.match(reviewText, /unanswered/);
	} finally {
		await handle.stop();
	}
});

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

test("browser page protects focused answer and notes from stale websocket echoes", async () => {
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
			localStorage: createFakeLocalStorage(),
			setInterval() {},
			setTimeout() {},
			clearTimeout() {},
		});
		new vm.Script(scriptFromPage(page.text)).runInContext(context);
		assert.equal(sockets.length, 1);

		const input = document.querySelector('[data-focus-key="q-1-input"]');
		assert.ok(input);
		input.value = "Oay, no. they did not.";
		input.focus();
		input.setSelectionRange(5, 5);
		sockets[0].onmessage({ data: JSON.stringify({ type: "answers", answers: { "1": "Oay," } }) });
		assert.equal(document.activeElement.dataset.focusKey, "q-1-input");
		assert.equal(document.activeElement, input);
		assert.equal(document.activeElement.value, "Oay, no. they did not.");
		assert.equal(document.activeElement.selectionStart, 5);
		assert.equal(document.activeElement.selectionEnd, 5);

		const notes = document.querySelector('[data-focus-key="q-1-notes"]');
		assert.ok(notes);
		notes.value = "asdf  note  spaces";
		notes.focus();
		notes.setSelectionRange(6, 6);
		sockets[0].onmessage({ data: JSON.stringify({ type: "options", options: { notes: { note: "asdf" } } }) });
		assert.equal(document.activeElement.dataset.focusKey, "q-1-notes");
		assert.equal(document.activeElement.value, "asdf  note  spaces");
		assert.equal(document.activeElement.selectionStart, 6);
		assert.equal(document.activeElement.selectionEnd, 6);
	} finally {
		await handle.stop();
	}
});

test("browser page flushes pending answer and notes before confirm submit", async () => {
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
			localStorage: createFakeLocalStorage(),
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
			{ type: "tab", currentTab: QUESTIONS.length },
		]);
		assert.equal(document.getElementById("submit").textContent, "Confirm Submit");
		assert.ok(!document.getElementById("cancel"), "cancel button should not exist");
		const reviewContent = document.getElementById("questions").children[0].textContent;
		assert.match(reviewContent, /Review/);
		assert.match(reviewContent, /keep   answer spaces/);
		assert.match(reviewContent, /keep   note spaces/);

		document.getElementById("submit").onclick();
		assert.deepEqual(sent.at(-1), { type: "submit" });
	} finally {
		await handle.stop();
	}
});

test("browser confirm screen Back returns to the previous question view", async () => {
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
			localStorage: createFakeLocalStorage(),
			setInterval() {},
			setTimeout() {},
			clearTimeout() {},
		});
		new vm.Script(scriptFromPage(page.text)).runInContext(context);
		sockets[0].onmessage({ data: JSON.stringify({ type: "state", questions: QUESTIONS, currentTab: 1, answers: {}, options: { notes: {} }, lifecycle: "open" }) });

		document.getElementById("submit").onclick();
		document.querySelectorAll(".progress-step")[1].onclick();

		assert.deepEqual(sent.slice(-2), [
			{ type: "tab", currentTab: QUESTIONS.length },
			{ type: "tab", currentTab: 1 },
		]);
		assert.equal(document.getElementById("submit").textContent, "Submit");
		assert.equal(document.getElementById("questions").children.length, QUESTIONS.length);
	} finally {
		await handle.stop();
	}
});

test("browser single-question submit remains immediate", async () => {
	const [question] = QUESTIONS;
	const handle = await startBrowserSyncServer({ questions: [question], preferredPort: 0 });
	try {
		const page = await fetchText(handle.url);
		const document = createFakeBrowserDom();
		const sent = [];
		class FakeWebSocket {
			static OPEN = 1;
			constructor() {
				this.readyState = FakeWebSocket.OPEN;
			}
			send(message) {
				sent.push(JSON.parse(message));
			}
		}
		const context = vm.createContext({
			document,
			WebSocket: FakeWebSocket,
			localStorage: createFakeLocalStorage(),
			setInterval() {},
			setTimeout() {},
			clearTimeout() {},
		});
		new vm.Script(scriptFromPage(page.text)).runInContext(context);

		document.getElementById("submit").onclick();

		assert.deepEqual(sent.at(-1), { type: "submit" });
	} finally {
		await handle.stop();
	}
});

test("browser submitted page shows submitted answers and cancelable close timer", async () => {
	const handle = await startBrowserSyncServer({ questions: QUESTIONS, preferredPort: 0 });
	try {
		const page = await fetchText(handle.url);
		const document = createFakeBrowserDom();
		const intervals = [];
		let closeCount = 0;
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
			localStorage: createFakeLocalStorage(),
			window: { close: () => { closeCount++; } },
			setInterval(fn, ms) { intervals.push({ fn, ms }); return intervals.length; },
			setTimeout() {},
			clearInterval() {},
			clearTimeout() {},
		});
		new vm.Script(scriptFromPage(page.text)).runInContext(context);
		sockets[0].onmessage({ data: JSON.stringify({
			type: "state",
			questions: QUESTIONS,
			currentTab: 0,
			answers: { "0": { mode: "option", value: "Blue" }, "1": "done" },
			options: { notes: { note: "remember this" } },
			lifecycle: "open",
		}) });

		sockets[0].onmessage({ data: JSON.stringify({ type: "lifecycle", lifecycle: "submitted" }) });

		const root = document.getElementById("questions");
		assert.match(root.children[0].textContent, /Submitted/);
		const receiptContent = root.textContent;
		assert.match(receiptContent, /Color/);
		assert.match(receiptContent, /Blue/);
		assert.match(receiptContent, /Note/);
		assert.match(receiptContent, /done/);
		assert.match(receiptContent, /remember this/);
		assert.equal(document.getElementById("actions").style.display, "none");
		assert.match(document.getElementById("auto-close-timer").textContent, /05:00/);
		assert.ok(intervals.some((interval) => interval.ms === 1000), "submitted view should start a one-second countdown");

		const controls = root.children[2];
		const closeNow = controls.children.find((child) => child.textContent === "Close Now");
		const cancelTimer = controls.children.find((child) => child.textContent === "Cancel timer");
		assert.ok(closeNow);
		assert.ok(cancelTimer);
		cancelTimer.onclick();
		assert.match(document.getElementById("auto-close-timer").textContent, /cancelled/);
		assert.equal(cancelTimer.disabled, true);
		const countdown = intervals.find((interval) => interval.ms === 1000);
		countdown.fn();
		assert.equal(closeCount, 0, "cancelled timer should not close the tab");
		closeNow.onclick();
		assert.equal(closeCount, 1, "Close Now should close the tab immediately");
	} finally {
		await handle.stop();
	}
});

test("browser submitted page auto-closes after countdown reaches zero", async () => {
	const handle = await startBrowserSyncServer({ questions: QUESTIONS, preferredPort: 0 });
	try {
		const page = await fetchText(handle.url);
		const document = createFakeBrowserDom();
		const intervals = [];
		let closeCount = 0;
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
			localStorage: createFakeLocalStorage(),
			window: { close: () => { closeCount++; } },
			setInterval(fn, ms) { intervals.push({ fn, ms }); return intervals.length; },
			setTimeout() {},
			clearInterval() {},
			clearTimeout() {},
		});
		new vm.Script(scriptFromPage(page.text)).runInContext(context);

		sockets[0].onmessage({ data: JSON.stringify({ type: "lifecycle", lifecycle: "submitted" }) });

		const countdown = intervals.find((interval) => interval.ms === 1000);
		assert.ok(countdown, "submitted lifecycle should create a countdown interval");
		for (let i = 0; i < 300; i++) countdown.fn();
		assert.equal(closeCount, 1);
		assert.match(document.getElementById("auto-close-timer").textContent, /00:00/);
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
			localStorage: createFakeLocalStorage(),
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
		assert.equal(document.getElementById("questions").children.length, 3);
		assert.match(document.getElementById("questions").children[0].textContent, /Submitted/);
		assert.equal(document.getElementById("actions").style.display, "none");
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

test("browser focused Other text input is not recreated by stale answer echoes", async () => {
	const otherQuestions = normalizeQuestions([
		{ id: "decision", header: "Decision", question: "Proceed?", type: "confirm_enum" },
		{ id: "fallback", header: "Fallback", question: "Fallback?", type: "confirm_enum" },
	]);
	const handle = await startBrowserSyncServer({ questions: otherQuestions, preferredPort: 0 });
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
			localStorage: createFakeLocalStorage(),
			setInterval() {},
			setTimeout() {},
			clearTimeout() {},
		});
		new vm.Script(scriptFromPage(page.text)).runInContext(context);
		sockets[0].onmessage({ data: JSON.stringify({ type: "state", questions: otherQuestions, currentTab: 0, answers: {}, options: { notes: {} }, lifecycle: "open" }) });

		const decisionOther = document.querySelector('[data-focus-key="q-0-other"]');
		assert.ok(decisionOther);
		decisionOther.focus();
		decisionOther.value = "Need more context";
		decisionOther.setSelectionRange(7, 7);

		sockets[0].onmessage({ data: JSON.stringify({ type: "answers", answers: { "1": { mode: "option", value: "decline" } } }) });

		assert.equal(document.activeElement, decisionOther, "focused Other input should not be destroyed during stale echo handling");
		assert.equal(decisionOther.value, "Need more context");
		assert.equal(decisionOther.selectionStart, 7);
	} finally {
		await handle.stop();
	}
});

test("browser Other text input sends typed text and survives stale answer echoes", async () => {
	const otherQuestions = normalizeQuestions([
		{ id: "decision", header: "Decision", question: "Proceed?", type: "confirm_enum" },
		{ id: "fallback", header: "Fallback", question: "Fallback?", type: "confirm_enum" },
	]);
	const handle = await startBrowserSyncServer({ questions: otherQuestions, preferredPort: 0 });
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
			localStorage: createFakeLocalStorage(),
			setInterval() {},
			setTimeout(fn) { fn(); return 1; },
			clearTimeout() {},
		});
		new vm.Script(scriptFromPage(page.text)).runInContext(context);
		assert.equal(sockets.length, 1);
		sockets[0].onmessage({ data: JSON.stringify({ type: "state", questions: otherQuestions, currentTab: 0, answers: {}, options: { notes: {} }, lifecycle: "open" }) });

		const decisionOther = document.querySelector('[data-focus-key="q-0-other"]');
		assert.ok(decisionOther);
		decisionOther.focus();
		decisionOther.value = "Need more context";
		decisionOther.oninput();

		assert.deepEqual(sent.at(-1), {
			type: "answer",
			questionId: "decision",
			value: { mode: "other", text: "Need more context" },
		});

		sockets[0].onmessage({ data: JSON.stringify({ type: "answers", answers: { "1": { mode: "option", value: "decline" } } }) });

		const restoredDecisionOther = document.querySelector('[data-focus-key="q-0-other"]');
		const fallbackOther = document.querySelector('[data-focus-key="q-1-other"]');
		assert.ok(restoredDecisionOther);
		assert.ok(fallbackOther);
		assert.equal(restoredDecisionOther.value, "Need more context");
		assert.equal(fallbackOther.value, "");
	} finally {
		await handle.stop();
	}
});

test("browser Other text input survives unrelated option re-renders before debounce", async () => {
	const otherQuestions = normalizeQuestions([
		{ id: "decision", header: "Decision", question: "Proceed?", type: "confirm_enum" },
		{ id: "fallback", header: "Fallback", question: "Fallback?", type: "confirm_enum" },
	]);
	const handle = await startBrowserSyncServer({ questions: otherQuestions, preferredPort: 0 });
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
			localStorage: createFakeLocalStorage(),
			setInterval() {},
			setTimeout() {},
			clearTimeout() {},
		});
		new vm.Script(scriptFromPage(page.text)).runInContext(context);
		sockets[0].onmessage({ data: JSON.stringify({ type: "state", questions: otherQuestions, currentTab: 0, answers: {}, options: { notes: {} }, lifecycle: "open" }) });

		const decisionOther = document.querySelector('[data-focus-key="q-0-other"]');
		assert.ok(decisionOther);
		decisionOther.focus();
		decisionOther.value = "Need more context";
		decisionOther.setSelectionRange(7, 7);

		sockets[0].onmessage({ data: JSON.stringify({ type: "options", options: { notes: { fallback: "server note" } } }) });

		const restoredDecisionOther = document.querySelector('[data-focus-key="q-0-other"]');
		assert.ok(restoredDecisionOther);
		assert.equal(document.activeElement.dataset.focusKey, "q-0-other");
		assert.equal(restoredDecisionOther.value, "Need more context");
		assert.equal(restoredDecisionOther.selectionStart, 7);
		assert.equal(restoredDecisionOther.selectionEnd, 7);
	} finally {
		await handle.stop();
	}
});

test("focused Other text input value survives direct DOM re-renders", async () => {
	const previewQuestions = normalizeQuestions([
		{
			id: "choice",
			header: "Choice",
			question: "Choose?",
			type: "select_one",
			options: [{ label: "Red", preview: { type: "text", content: "preview" } }],
		},
	]);
	const handle = await startBrowserSyncServer({ questions: previewQuestions, preferredPort: 0 });
	try {
		const page = await fetchText(handle.url);
		const document = createFakeBrowserDom();
		class FakeWebSocket {
			static OPEN = 1;
			constructor() {
				this.readyState = FakeWebSocket.OPEN;
			}
			send() {}
		}
		const context = vm.createContext({
			document,
			WebSocket: FakeWebSocket,
			localStorage: createFakeLocalStorage(),
			setInterval() {},
			setTimeout() {},
			clearTimeout() {},
		});
		new vm.Script(scriptFromPage(page.text)).runInContext(context);

		const otherInput = document.querySelector('[data-focus-key="q-0-other"]');
		assert.ok(otherInput);
		otherInput.focus();
		otherInput.value = "Unsynced other text";
		otherInput.setSelectionRange(9, 9);

		const previewButton = document.querySelector('[data-focus-key="q-0-preview-0"]');
		assert.ok(previewButton);
		previewButton.onclick();

		const restoredOtherInput = document.querySelector('[data-focus-key="q-0-other"]');
		assert.ok(restoredOtherInput);
		assert.equal(document.activeElement.dataset.focusKey, "q-0-other");
		assert.equal(restoredOtherInput.value, "Unsynced other text");
		assert.equal(restoredOtherInput.selectionStart, 9);
		assert.equal(restoredOtherInput.selectionEnd, 9);
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

test("browser page renders the Submit review tab from TUI tab sync", async () => {
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
			localStorage: createFakeLocalStorage(),
			setInterval() {},
			setTimeout() {},
			clearTimeout() {},
		});
		new vm.Script(scriptFromPage(page.text)).runInContext(context);
		sockets[0].onmessage({ data: JSON.stringify({ type: "state", questions: QUESTIONS, currentTab: 0, answers: { "0": { mode: "option", value: "Blue" }, "1": "done" }, options: { notes: {} }, lifecycle: "open" }) });

		sockets[0].onmessage({ data: JSON.stringify({ type: "tab", currentTab: QUESTIONS.length }) });

		const root = document.getElementById("questions");
		assert.equal(root.children.length, 1);
		assert.match(root.children[0].className, /submit-review/);
		const reviewContent = root.children[0].textContent;
		assert.match(reviewContent, /Review/);
		assert.match(reviewContent, /Color/);
		assert.match(reviewContent, /Blue/);
		assert.match(reviewContent, /Note/);
		assert.match(reviewContent, /done/);
	} finally {
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

test("browser page has semantic progress band with step markers", async () => {
	const handle = await startBrowserSyncServer({ questions: QUESTIONS, preferredPort: 0 });
	try {
		const page = await fetchText(handle.url);
		assert.match(page.text, /progress-band/);
		assert.match(page.text, /progress-step/);
		assert.match(page.text, /progress-info/);
		assert.match(page.text, /renderProgress/);
		assert.match(page.text, /Step /);
		assert.match(page.text, /answered/);
	} finally {
		await handle.stop();
	}
});

test("browser page uses choice-row structure with selected state", async () => {
	const handle = await startBrowserSyncServer({ questions: QUESTIONS, preferredPort: 0 });
	try {
		const page = await fetchText(handle.url);
		assert.match(page.text, /choice-row/);
		assert.match(page.text, /selected/);
		assert.match(page.text, /label-text/);
		assert.match(page.text, /choice-desc/);
		assert.match(page.text, /choice-other-input/);
	} finally {
		await handle.stop();
	}
});

test("browser page has notes-field wrapper with dashed border styling", async () => {
	const handle = await startBrowserSyncServer({ questions: QUESTIONS, preferredPort: 0 });
	try {
		const page = await fetchText(handle.url);
		assert.match(page.text, /notes-field/);
		assert.match(page.text, /Add a note/);
		assert.match(page.text, /border-style:dashed/);
	} finally {
		await handle.stop();
	}
});

test("browser review screen uses ledger structure with QUESTION/ANSWER/NOTES labels", async () => {
	const handle = await startBrowserSyncServer({ questions: QUESTIONS, preferredPort: 0 });
	try {
		const page = await fetchText(handle.url);
		assert.match(page.text, /review-ledger/);
		assert.match(page.text, /ledger-row/);
		assert.match(page.text, /ledger-label/);
		assert.match(page.text, /ledger-answer/);
		assert.match(page.text, /ledger-note/);
		assert.match(page.text, /q-num/);
		assert.match(page.text, /renderReviewLedger/);
	} finally {
		await handle.stop();
	}
});

test("browser submitted screen uses receipt structure", async () => {
	const handle = await startBrowserSyncServer({ questions: QUESTIONS, preferredPort: 0 });
	try {
		const page = await fetchText(handle.url);
		assert.match(page.text, /renderSubmittedReceipt/);
		assert.match(page.text, /submitted-header/);
		assert.match(page.text, /submitted-answers/);
	} finally {
		await handle.stop();
	}
});

test("browser review ledger renders structured QUESTION/ANSWER/NOTES per question", async () => {
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
			localStorage: createFakeLocalStorage(),
			setInterval() {},
			setTimeout() {},
			clearTimeout() {},
		});
		new vm.Script(scriptFromPage(page.text)).runInContext(context);
		sockets[0].onmessage({ data: JSON.stringify({ type: "state", questions: QUESTIONS, currentTab: 0, answers: { "0": { mode: "option", value: "Blue" }, "1": "done" }, options: { notes: { note: "my note" } }, lifecycle: "open" }) });

		sockets[0].onmessage({ data: JSON.stringify({ type: "tab", currentTab: QUESTIONS.length }) });

		const root = document.getElementById("questions");
		const text = root.textContent;
		assert.match(text, /QUESTION/);
		assert.match(text, /ANSWER/);
		assert.match(text, /NOTES/);
		assert.match(text, /1\. Color/);
		assert.match(text, /Pick a color/);
		assert.match(text, /Blue/);
		assert.match(text, /2\. Note/);
		assert.match(text, /Anything else/);
		assert.match(text, /done/);
		assert.match(text, /my note/);

		const ledgerLabels = root.findAll(el => el.className === 'ledger-label');
		const labelTexts = ledgerLabels.map(el => el.textContent);
		assert.ok(labelTexts.includes('QUESTION'), 'should have QUESTION labels');
		assert.ok(labelTexts.includes('ANSWER'), 'should have ANSWER labels');
		assert.ok(labelTexts.includes('NOTES'), 'should have NOTES labels');
	} finally {
		await handle.stop();
	}
});

test("browser submitted receipt has structured layout with answer values", async () => {
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
			localStorage: createFakeLocalStorage(),
			window: { close() {} },
			setInterval() {},
			setTimeout() {},
			clearInterval() {},
			clearTimeout() {},
		});
		new vm.Script(scriptFromPage(page.text)).runInContext(context);
		sockets[0].onmessage({ data: JSON.stringify({ type: "state", questions: QUESTIONS, currentTab: 0, answers: { "0": { mode: "option", value: "Blue" }, "1": "done" }, options: { notes: { note: "remember" } }, lifecycle: "open" }) });
		sockets[0].onmessage({ data: JSON.stringify({ type: "lifecycle", lifecycle: "submitted" }) });

		const root = document.getElementById("questions");
		assert.equal(root.children[0].tagName, 'H2');
		assert.equal(root.children[0].textContent, 'Submitted');
		const container = root.children[1];
		assert.match(container.className, /submitted-answers/);
		const text = container.textContent;
		assert.match(text, /Blue/);
		assert.match(text, /done/);
		assert.match(text, /remember/);
		const controls = root.children[2];
		assert.match(controls.className, /terminal-actions/);
	} finally {
		await handle.stop();
	}
});

test("choice row click toggles checkbox and selects radio", async () => {
	const multiQs = normalizeQuestions([
		{ id: "color", header: "Color", question: "Pick a color?", type: "select_one", options: [{ label: "Red" }, { label: "Blue" }] },
		{ id: "features", header: "Features", question: "Pick features?", type: "select_many", options: [{ label: "A" }, { label: "B" }] },
	]);
	const handle = await startBrowserSyncServer({ questions: multiQs, preferredPort: 0 });
	try {
		const page = await fetchText(handle.url);
		const document = createFakeBrowserDom();
		const sent = [];
		const sockets = [];
		class FakeWebSocket {
			static OPEN = 1;
			constructor(url) { this.url = url; this.readyState = FakeWebSocket.OPEN; sockets.push(this); }
			send(message) { sent.push(JSON.parse(message)); }
		}
		const context = vm.createContext({
			document,
			WebSocket: FakeWebSocket,
			localStorage: createFakeLocalStorage(),
			setInterval() {},
			setTimeout(fn) { fn(); return 1; },
			clearTimeout() {},
		});
		new vm.Script(scriptFromPage(page.text)).runInContext(context);
		sockets[0].onmessage({ data: JSON.stringify({ type: "state", questions: multiQs, currentTab: 1, answers: {}, options: { notes: {} }, lifecycle: "open" }) });

		const questionsDiv = document.getElementById("questions");
		const activeSection = questionsDiv.children[1];
		const checkboxRows = activeSection.findAll(el => el.className.split(/\s+/).includes('choice-row'));
		assert.ok(checkboxRows.length >= 2, 'should have checkbox rows');
		const firstRow = checkboxRows[0];
		const firstInput = firstRow.children[0];
		assert.equal(firstInput.type, 'checkbox');
		assert.equal(firstInput.checked, false);

		firstRow.onclick({ target: firstRow });
		assert.equal(firstInput.checked, true);
		assert.ok(firstRow.className.includes('selected'), 'row should be selected after click');

		firstRow.onclick({ target: firstRow });
		assert.equal(firstInput.checked, false);
		assert.ok(!firstRow.className.includes('selected'), 'row should be deselected after second click');
	} finally {
		await handle.stop();
	}
});

test("radio row click selects and clears siblings", async () => {
	const handle = await startBrowserSyncServer({ questions: QUESTIONS, preferredPort: 0 });
	try {
		const page = await fetchText(handle.url);
		const document = createFakeBrowserDom();
		const sent = [];
		const sockets = [];
		class FakeWebSocket {
			static OPEN = 1;
			constructor(url) { this.url = url; this.readyState = FakeWebSocket.OPEN; sockets.push(this); }
			send(message) { sent.push(JSON.parse(message)); }
		}
		const context = vm.createContext({
			document,
			WebSocket: FakeWebSocket,
			localStorage: createFakeLocalStorage(),
			setInterval() {},
			setTimeout(fn) { fn(); return 1; },
			clearTimeout() {},
		});
		new vm.Script(scriptFromPage(page.text)).runInContext(context);
		sockets[0].onmessage({ data: JSON.stringify({ type: "state", questions: QUESTIONS, currentTab: 0, answers: {}, options: { notes: {} }, lifecycle: "open" }) });

		const radioRows = document.querySelectorAll('.choice-row');
		assert.ok(radioRows.length >= 2, 'should have radio rows');
		const redRow = radioRows[0];
		const blueRow = radioRows[1];
		const redInput = redRow.children[0];
		const blueInput = blueRow.children[0];

		redRow.onclick({ target: redRow });
		assert.equal(redInput.checked, true);
		assert.ok(redRow.className.includes('selected'));

		blueRow.onclick({ target: blueRow });
		assert.equal(blueInput.checked, true);
		assert.equal(redInput.checked, false);
		assert.ok(!redRow.className.includes('selected'), 'red row should lose selected class');
		assert.ok(blueRow.className.includes('selected'), 'blue row should have selected class');
	} finally {
		await handle.stop();
	}
});

test("progress step click exits review mode", async () => {
	const handle = await startBrowserSyncServer({ questions: QUESTIONS, preferredPort: 0 });
	try {
		const page = await fetchText(handle.url);
		const document = createFakeBrowserDom();
		const sent = [];
		const sockets = [];
		class FakeWebSocket {
			static OPEN = 1;
			constructor(url) { this.url = url; this.readyState = FakeWebSocket.OPEN; sockets.push(this); }
			send(message) { sent.push(JSON.parse(message)); }
		}
		const context = vm.createContext({
			document,
			WebSocket: FakeWebSocket,
			localStorage: createFakeLocalStorage(),
			setInterval() {},
			setTimeout() {},
			clearTimeout() {},
		});
		new vm.Script(scriptFromPage(page.text)).runInContext(context);
		sockets[0].onmessage({ data: JSON.stringify({ type: "state", questions: QUESTIONS, currentTab: 0, answers: {}, options: { notes: {} }, lifecycle: "open" }) });

		document.getElementById("submit").onclick();
		assert.equal(document.getElementById("submit").textContent, "Confirm Submit");

		const steps = document.querySelectorAll(".progress-step");
		assert.ok(steps.length >= 2, 'should have progress steps');
		steps[0].onclick();

		assert.equal(document.getElementById("submit").textContent, "Submit");
	} finally {
		await handle.stop();
	}
});

test("browser page has theme and layout toggle controls", async () => {
	const handle = await startBrowserSyncServer({ questions: QUESTIONS, preferredPort: 0 });
	try {
		const page = await fetchText(handle.url);
		assert.match(page.text, /theme-toggle/);
		assert.match(page.text, /layout-toggle/);
		assert.match(page.text, /toggle-btn/);
		assert.match(page.text, /controls/);
		assert.match(page.text, /localStorage/);
		assert.match(page.text, /pq-theme/);
		assert.match(page.text, /pq-layout/);
	} finally {
		await handle.stop();
	}
});

test("browser page has dark mode CSS variables and data-theme support", async () => {
	const handle = await startBrowserSyncServer({ questions: QUESTIONS, preferredPort: 0 });
	try {
		const page = await fetchText(handle.url);
		assert.match(page.text, /data-theme/);
		assert.match(page.text, /prefers-color-scheme/);
		assert.match(page.text, /\[data-theme=dark\]/);
		assert.match(page.text, /--clr-bg/);
		assert.match(page.text, /--clr-accent/);
	} finally {
		await handle.stop();
	}
});

test("browser page has single-question mode layout support", async () => {
	const handle = await startBrowserSyncServer({ questions: QUESTIONS, preferredPort: 0 });
	try {
		const page = await fetchText(handle.url);
		assert.match(page.text, /single-question-mode/);
		assert.match(page.text, /back-next-controls/);
		assert.match(page.text, /back-btn/);
		assert.match(page.text, /next-btn/);
		assert.match(page.text, /mode-wrapper/);
		assert.match(page.text, /isSingleMode/);
	} finally {
		await handle.stop();
	}
});

test("cancel button removed and helper text present", async () => {
	const handle = await startBrowserSyncServer({ questions: QUESTIONS, preferredPort: 0 });
	try {
		const page = await fetchText(handle.url);
		assert.doesNotMatch(page.text, /<button id="cancel">/);
		assert.match(page.text, /cancel-helper/);
		assert.match(page.text, /To cancel, return to the TUI and press Esc/);
	} finally {
		await handle.stop();
	}
});
