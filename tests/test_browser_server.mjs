import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
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
	async function nextMessage(type) {
		const deadline = Date.now() + 1000;
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

		client.send({ type: "tab", currentTab: 1 });
		assert.deepEqual(await client.nextMessage("tab"), { type: "tab", currentTab: 1 });
		assert.deepEqual(events[1], { type: "tab", currentTab: 1 });

		client.send({ type: "submit" });
		client.send({ type: "cancel" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.deepEqual(events.slice(2), [{ type: "submit" }, { type: "cancel" }]);
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
		assert.match(page.text, /function renderPreview/);
		assert.match(page.text, /function renderMarkdown/);
		assert.match(page.text, /document\.activeElement\?\.dataset\?\.previewKey/);
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
