// src/browser-server.ts
// In-process HTTP + raw WebSocket server for AskUserQuestion browser sync.

import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import type { Socket } from "node:net";
import { URL } from "node:url";
import { coerceAnswer, getRenderOptions } from "./answers.ts";
import type { AnswerMap, AnswerValue, CanonicalQuestion } from "./types.ts";

const DEFAULT_BROWSER_PORT = 54_321;
const LOOPBACK_HOST = "127.0.0.1";
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface BrowserOptionsState {
	notes: Record<string, string>;
}

export interface BrowserSyncServerOptions {
	questions: CanonicalQuestion[];
	initialAnswers?: AnswerMap;
	initialNotes?: Record<string, string>;
	preferredPort?: number;
	host?: typeof LOOPBACK_HOST;
	onAnswer?: (questionId: string, value: AnswerValue) => void;
	onClearAnswer?: (questionId: string) => void;
	onTab?: (currentTab: number) => void;
	onOptions?: (options: BrowserOptionsState) => void;
	onSubmit?: () => boolean | void;
	onCancel?: () => void;
	log?: (line: string) => void;
}

export interface BrowserSyncStatePatch {
	currentTab?: number;
	answers?: AnswerMap;
	notes?: Record<string, string>;
	lifecycle?: "open" | "submitted" | "cancelled";
}

export interface BrowserSyncServerHandle {
	batchId: string;
	nonce: string;
	port: number;
	url: string;
	broadcastState(): void;
	updateFromTui(patch: BrowserSyncStatePatch): void;
	stop(): Promise<void>;
}

type BrowserLifecycle = "open" | "submitted" | "cancelled";

type BrowserServerMessage =
	| { type: "state"; questions: CanonicalQuestion[]; currentTab: number; answers: AnswerMap; options: BrowserOptionsState; lifecycle: BrowserLifecycle }
	| { type: "tab"; currentTab: number }
	| { type: "answers"; answers: AnswerMap }
	| { type: "options"; options: BrowserOptionsState }
	| { type: "pong" }
	| { type: "lifecycle"; lifecycle: BrowserLifecycle };

interface WsClient {
	socket: Socket;
	buffer: Buffer;
}

interface BrowserSyncServerInternal {
	server: Server;
	clients: Set<WsClient>;
	questions: CanonicalQuestion[];
	answers: AnswerMap;
	options: BrowserOptionsState;
	currentTab: number;
	lifecycle: BrowserLifecycle;
	batchId: string;
	nonce: string;
	port: number;
	url: string;
	callbacks: Required<Pick<BrowserSyncServerOptions, "log">> & Omit<BrowserSyncServerOptions, "questions" | "initialAnswers" | "initialNotes" | "preferredPort" | "host" | "log">;
	stopped: boolean;
}

const NO_LOG = () => {};

export async function startBrowserSyncServer(
	opts: BrowserSyncServerOptions,
): Promise<BrowserSyncServerHandle> {
	const host = opts.host ?? LOOPBACK_HOST;
	if (host !== LOOPBACK_HOST) {
		throw new Error("browser sync server may only bind to 127.0.0.1");
	}
	const batchId = randomToken(8);
	const nonce = randomToken(16);
	const preferredPort = opts.preferredPort ?? DEFAULT_BROWSER_PORT;
	const callbacks = {
		log: opts.log ?? NO_LOG,
		onAnswer: opts.onAnswer,
		onClearAnswer: opts.onClearAnswer,
		onTab: opts.onTab,
		onOptions: opts.onOptions,
		onSubmit: opts.onSubmit,
		onCancel: opts.onCancel,
	};

	let internal: BrowserSyncServerInternal | null = null;
	const server = http.createServer((req, res) => {
		if (!internal) {
			respondText(res, 503, "server starting");
			return;
		}
		handleHttpRequest(internal, req, res);
	});
	server.on("upgrade", (req, socket, head) => {
		if (!internal) {
			socket.destroy();
			return;
		}
		handleUpgrade(internal, req, socket as Socket, head);
	});

	const port = await listenSticky(server, preferredPort, host);
	const url = `http://${host}:${port}/q/${batchId}?nonce=${nonce}`;
	internal = {
		server,
		clients: new Set(),
		questions: opts.questions,
		answers: { ...(opts.initialAnswers ?? {}) },
		options: { notes: { ...(opts.initialNotes ?? {}) } },
		currentTab: 0,
		lifecycle: "open",
		batchId,
		nonce,
		port,
		url,
		callbacks,
		stopped: false,
	};

	return {
		batchId,
		nonce,
		port,
		url,
		broadcastState() {
			if (internal) broadcastState(internal);
		},
		updateFromTui(patch) {
			if (internal) updateFromTui(internal, patch);
		},
		stop() {
			if (!internal) return Promise.resolve();
			return stopInternal(internal);
		},
	};
}

function randomToken(bytes: number): string {
	return randomBytes(bytes).toString("hex");
}

async function listenSticky(server: Server, preferredPort: number, host: string): Promise<number> {
	if (preferredPort === 0) return listenOnce(server, 0, host);
	try {
		return await listenOnce(server, preferredPort, host);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
	}
	try {
		return await listenOnce(server, preferredPort + 1, host);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
			throw new Error(`browser sync ports ${preferredPort} and ${preferredPort + 1} are in use`);
		}
		throw err;
	}
}

function listenOnce(server: Server, port: number, host: string): Promise<number> {
	return new Promise((resolve, reject) => {
		function onError(err: Error) {
			cleanup();
			reject(err);
		}
		function onListening() {
			cleanup();
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("browser sync server did not expose a TCP address"));
				return;
			}
			resolve(address.port);
		}
		function cleanup() {
			server.off("error", onError);
			server.off("listening", onListening);
		}
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port, host);
	});
}

function handleHttpRequest(state: BrowserSyncServerInternal, req: IncomingMessage, res: ServerResponse): void {
	const parsed = parseRequestUrl(state, req.url ?? "/");
	if (!parsed) {
		respondText(res, 400, "bad request");
		return;
	}
	if (req.method === "GET" && parsed.pathname === "/healthz") {
		respondText(res, 200, "ok");
		return;
	}
	if (req.method === "GET" && parsed.pathname === `/q/${state.batchId}`) {
		if (parsed.searchParams.get("nonce") !== state.nonce) {
			respondText(res, 403, "forbidden");
			return;
		}
		respondHtml(res, renderBrowserPage(state));
		return;
	}
	respondText(res, 404, "not found");
}

function parseRequestUrl(state: BrowserSyncServerInternal, raw: string): URL | null {
	try {
		return new URL(raw, `http://127.0.0.1:${state.port}`);
	} catch {
		return null;
	}
}

function respondText(res: ServerResponse, status: number, text: string): void {
	res.writeHead(status, {
		"content-type": "text/plain; charset=utf-8",
		"content-length": Buffer.byteLength(text),
	});
	res.end(text);
}

function respondHtml(res: ServerResponse, html: string): void {
	res.writeHead(200, {
		"content-type": "text/html; charset=utf-8",
		"content-length": Buffer.byteLength(html),
		"cache-control": "no-store",
	});
	res.end(html);
}

function handleUpgrade(
	state: BrowserSyncServerInternal,
	req: IncomingMessage,
	socket: Socket,
	head: Buffer,
): void {
	const parsed = parseRequestUrl(state, req.url ?? "/");
	if (!parsed || parsed.pathname !== "/ws") {
		rejectUpgrade(socket, 404, "not found");
		return;
	}
	if (parsed.searchParams.get("batch") !== state.batchId || parsed.searchParams.get("nonce") !== state.nonce) {
		rejectUpgrade(socket, 403, "forbidden");
		return;
	}
	const key = req.headers["sec-websocket-key"];
	if (typeof key !== "string" || req.headers.upgrade?.toLowerCase() !== "websocket") {
		rejectUpgrade(socket, 400, "bad websocket upgrade");
		return;
	}
	const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
	socket.write(
		"HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		`Sec-WebSocket-Accept: ${accept}\r\n` +
		"\r\n",
	);
	const client: WsClient = { socket, buffer: Buffer.alloc(0) };
	state.clients.add(client);
	socket.on("data", (chunk) => {
		const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		receiveClientData(state, client, data);
	});
	socket.on("close", () => state.clients.delete(client));
	socket.on("error", () => state.clients.delete(client));
	if (head.length > 0) receiveClientData(state, client, head);
	sendJson(client, stateMessage(state));
}

function rejectUpgrade(socket: Socket, status: number, text: string): void {
	socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
	socket.destroy();
}

function receiveClientData(state: BrowserSyncServerInternal, client: WsClient, chunk: Buffer): void {
	client.buffer = Buffer.concat([client.buffer, chunk]);
	while (true) {
		const frame = readClientFrame(client.buffer);
		if (!frame) return;
		client.buffer = frame.rest;
		if (frame.opcode === 0x8) {
			client.socket.end(encodeServerFrame(Buffer.alloc(0), 0x8));
			state.clients.delete(client);
			return;
		}
		if (frame.opcode === 0x9) {
			client.socket.write(encodeServerFrame(frame.payload, 0xA));
			continue;
		}
		if (frame.opcode !== 0x1) continue;
		try {
			const message = JSON.parse(frame.payload.toString("utf8"));
			handleClientMessage(state, client, message);
		} catch (err) {
			state.callbacks.log(`browser ws message ignored: ${(err as Error).message}`);
		}
	}
}

function readClientFrame(buffer: Buffer): { opcode: number; payload: Buffer; rest: Buffer } | null {
	if (buffer.length < 2) return null;
	const opcode = buffer[0] & 0x0f;
	let offset = 2;
	let length = buffer[1] & 0x7f;
	const masked = (buffer[1] & 0x80) !== 0;
	if (length === 126) {
		if (buffer.length < offset + 2) return null;
		length = buffer.readUInt16BE(offset);
		offset += 2;
	} else if (length === 127) {
		if (buffer.length < offset + 8) return null;
		const high = buffer.readUInt32BE(offset);
		const low = buffer.readUInt32BE(offset + 4);
		if (high !== 0) throw new Error("websocket payload too large");
		length = low;
		offset += 8;
	}
	let mask: Buffer | null = null;
	if (masked) {
		if (buffer.length < offset + 4) return null;
		mask = buffer.subarray(offset, offset + 4);
		offset += 4;
	}
	if (buffer.length < offset + length) return null;
	const payload = Buffer.from(buffer.subarray(offset, offset + length));
	if (mask) {
		for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
	}
	return { opcode, payload, rest: buffer.subarray(offset + length) };
}

function handleClientMessage(state: BrowserSyncServerInternal, client: WsClient, raw: unknown): void {
	if (!raw || typeof raw !== "object") return;
	const message = raw as Record<string, unknown>;
	switch (message.type) {
		case "ping":
			sendJson(client, { type: "pong" });
			break;
		case "answer":
			handleBrowserAnswer(state, message);
			break;
		case "tab":
			handleBrowserTab(state, message);
			break;
		case "options":
			handleBrowserOptions(state, message);
			break;
		case "submit": {
			const accepted = state.callbacks.onSubmit?.();
			if (accepted === false) break;
			state.lifecycle = "submitted";
			broadcast(state, { type: "lifecycle", lifecycle: state.lifecycle });
			break;
		}
		case "cancel":
			state.lifecycle = "cancelled";
			state.callbacks.onCancel?.();
			broadcast(state, { type: "lifecycle", lifecycle: state.lifecycle });
			break;
	}
}

function handleBrowserAnswer(state: BrowserSyncServerInternal, message: Record<string, unknown>): void {
	const questionId = typeof message.questionId === "string" ? message.questionId : "";
	const index = state.questions.findIndex((question) => question.id === questionId);
	if (index === -1) return;
	if (message.value === null) {
		delete state.answers[String(index)];
		state.callbacks.onClearAnswer?.(questionId);
		broadcast(state, { type: "answers", answers: state.answers });
		return;
	}
	const value = coerceAnswer(message.value, state.questions[index]);
	if (value === undefined) return;
	state.answers[String(index)] = value;
	state.callbacks.onAnswer?.(questionId, value);
	broadcast(state, { type: "answers", answers: state.answers });
}

function handleBrowserTab(state: BrowserSyncServerInternal, message: Record<string, unknown>): void {
	const raw = Number(message.currentTab);
	if (!Number.isInteger(raw)) return;
	state.currentTab = clampTab(raw, state.questions.length);
	state.callbacks.onTab?.(state.currentTab);
	broadcast(state, { type: "tab", currentTab: state.currentTab });
}

function handleBrowserOptions(state: BrowserSyncServerInternal, message: Record<string, unknown>): void {
	const options = message.options;
	if (!options || typeof options !== "object") return;
	const notes = (options as { notes?: unknown }).notes;
	if (!notes || typeof notes !== "object" || Array.isArray(notes)) return;
	state.options.notes = sanitizeNotes(notes as Record<string, unknown>);
	state.callbacks.onOptions?.(state.options);
	broadcast(state, { type: "options", options: state.options });
}

function sanitizeNotes(raw: Record<string, unknown>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value === "string" && value.trim() !== "") out[key] = value;
	}
	return out;
}

function clampTab(tab: number, questionCount: number): number {
	return Math.max(0, Math.min(questionCount, tab));
}

function updateFromTui(state: BrowserSyncServerInternal, patch: BrowserSyncStatePatch): void {
	let optionsChanged = false;
	if (patch.currentTab !== undefined) {
		state.currentTab = clampTab(patch.currentTab, state.questions.length);
		broadcast(state, { type: "tab", currentTab: state.currentTab });
	}
	if (patch.answers !== undefined) {
		state.answers = { ...patch.answers };
		broadcast(state, { type: "answers", answers: state.answers });
	}
	if (patch.notes !== undefined) {
		state.options.notes = { ...patch.notes };
		optionsChanged = true;
	}
	if (patch.lifecycle !== undefined) {
		state.lifecycle = patch.lifecycle;
		broadcast(state, { type: "lifecycle", lifecycle: state.lifecycle });
	}
	if (optionsChanged) {
		broadcast(state, { type: "options", options: state.options });
	}
}

function stateMessage(state: BrowserSyncServerInternal): BrowserServerMessage {
	return {
		type: "state",
		questions: state.questions,
		currentTab: state.currentTab,
		answers: state.answers,
		options: state.options,
		lifecycle: state.lifecycle,
	};
}

function broadcastState(state: BrowserSyncServerInternal): void {
	broadcast(state, stateMessage(state));
}

function broadcast(state: BrowserSyncServerInternal, message: BrowserServerMessage): void {
	for (const client of state.clients) sendJson(client, message);
}

function sendJson(client: WsClient, message: BrowserServerMessage): void {
	try {
		client.socket.write(encodeServerFrame(Buffer.from(JSON.stringify(message), "utf8"), 0x1));
	} catch {
		client.socket.destroy();
	}
}

function encodeServerFrame(payload: Buffer, opcode: number): Buffer {
	const header: number[] = [0x80 | opcode];
	if (payload.length < 126) {
		header.push(payload.length);
	} else if (payload.length < 65_536) {
		header.push(126, (payload.length >> 8) & 0xff, payload.length & 0xff);
	} else {
		header.push(127, 0, 0, 0, 0);
		const len = Buffer.alloc(4);
		len.writeUInt32BE(payload.length, 0);
		header.push(...len);
	}
	return Buffer.concat([Buffer.from(header), payload]);
}

async function stopInternal(state: BrowserSyncServerInternal): Promise<void> {
	if (state.stopped) return;
	state.stopped = true;
	if (state.lifecycle === "open") {
		state.lifecycle = "cancelled";
		broadcast(state, { type: "lifecycle", lifecycle: state.lifecycle });
	}
	for (const client of state.clients) {
		try {
			client.socket.end(encodeServerFrame(Buffer.alloc(0), 0x8));
		} catch {
			client.socket.destroy();
		}
	}
	state.clients.clear();
	await new Promise<void>((resolve) => {
		state.server.close(() => resolve());
		setTimeout(resolve, 100).unref?.();
	});
}

function renderBrowserPage(state: BrowserSyncServerInternal): string {
	const wsPath = `/ws?batch=${state.batchId}&nonce=${state.nonce}`;
	const boot = {
		wsUrl: `ws://127.0.0.1:${state.port}${wsPath}`,
		batchId: state.batchId,
		nonce: state.nonce,
		questions: state.questions,
		currentTab: state.currentTab,
		answers: state.answers,
		options: state.options,
		lifecycle: state.lifecycle,
		renderOptions: Object.fromEntries(
			state.questions.map((question, index) => [String(index), getRenderOptions(question)]),
		),
	};
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AskUserQuestion</title>
<style>
*,*::before,*::after{box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;max-width:800px;margin:0 auto;padding:2rem 2rem 4rem;line-height:1.6;color:#1a1a2e;background:#fff}

/* === Header === */
.header{margin-bottom:2rem}
.header h1{font-size:1.75rem;font-weight:700;letter-spacing:-0.02em;margin:0 0 .25rem;color:#1a1a2e}
.header .status-text{font-size:.875rem;color:#64748b;margin:0}

/* === Progress Band === */
.progress-band{display:flex;align-items:center;gap:.5rem;margin-bottom:2.5rem;padding-bottom:1.25rem;border-bottom:1px solid #e2e8f0}
.progress-step{width:2rem;height:2rem;display:flex;align-items:center;justify-content:center;border-radius:50%;font-size:.8125rem;font-weight:600;cursor:pointer;transition:all .15s;border:2px solid #cbd5e1;color:#94a3b8;background:transparent}
.progress-step.answered{border-color:#4361ee;color:#4361ee;background:#eff3ff}
.progress-step.active{border-color:#4361ee;color:#fff;background:#4361ee}
.progress-step.review{border-color:#64748b;color:#64748b;font-size:.6875rem}
.progress-step.review.active{border-color:#4361ee;color:#fff;background:#4361ee}
.progress-info{margin-left:auto;font-size:.8125rem;color:#64748b}
.progress-info strong{color:#1a1a2e}

/* === Question Sections (document rhythm) === */
.question{position:relative;padding:1.5rem 0 1.5rem 2.5rem;border-bottom:1px solid #f1f5f9}
.question:last-child{border-bottom:none}
.question .q-number{position:absolute;left:0;top:1.5rem;width:1.75rem;text-align:right;font-size:1.5rem;font-weight:700;color:#e2e8f0;line-height:1}
.question.active .q-number{color:#4361ee}
.question h2{font-size:1.125rem;font-weight:600;margin:0 0 .25rem;color:#1a1a2e}
.question.active h2{text-decoration:underline;text-decoration-color:#4361ee;text-underline-offset:4px;text-decoration-thickness:2px}
.question>p{margin:0 0 1rem;color:#475569;font-size:.9375rem}
.question.active{background:linear-gradient(to right,#f0f4ff 0,#f0f4ff 3px,transparent 3px)}
.question:not(.active){opacity:.7}
.question:not(.active):hover{opacity:.9}

/* === Fieldset / Choices === */
fieldset{border:0;padding:0;margin:0 0 1rem}
.choice-row{display:flex;align-items:center;gap:.625rem;padding:.625rem .75rem;margin-bottom:.375rem;border-left:3px solid transparent;border-radius:2px;cursor:pointer;transition:background .1s}
.choice-row:hover{background:#f8fafc}
.choice-row.selected{border-left-color:#4361ee;background:#f0f4ff}
.choice-row input[type=radio],.choice-row input[type=checkbox]{accent-color:#4361ee;width:1.125rem;height:1.125rem;flex-shrink:0}
.choice-row label-text{font-size:.9375rem;color:#1a1a2e}
.choice-desc{font-size:.8125rem;color:#64748b;margin-left:1.75rem;margin-top:-.125rem;margin-bottom:.375rem}
.choice-other-input{margin-left:1.75rem;margin-top:.25rem;max-width:24rem}
.preview-toggle{font-size:.8125rem;color:#4361ee;background:none;border:none;cursor:pointer;padding:.25rem .5rem;margin-left:1.75rem}
.preview-toggle:hover{text-decoration:underline}

/* === Layout & Theme Controls === */
.controls{display:flex;gap:.75rem;align-items:center}
.toggle-btn{font-family:inherit;font-size:.75rem;padding:.25rem .625rem;border:1px solid #cbd5e1;border-radius:2px;background:transparent;color:#64748b;cursor:pointer;line-height:1.3;white-space:nowrap}
.toggle-btn:hover{border-color:#4361ee;color:#4361ee}
.toggle-btn.active{background:#4361ee;border-color:#4361ee;color:#fff}

/* === Single-question mode === */
.single-question-mode .question:not(.active){display:none}
.back-next-controls{display:none;justify-content:space-between;margin-top:1.5rem;padding-top:1rem}
.single-question-mode .back-next-controls{display:flex}
.back-next-controls button{font-family:inherit;font-size:.875rem;font-weight:500;padding:.5rem 1.25rem;border:1px solid #cbd5e1;border-radius:2px;background:#fff;color:#1a1a2e;cursor:pointer;transition:all .15s}
.back-next-controls button:hover{border-color:#4361ee;color:#4361ee}
.back-next-controls button:disabled{opacity:.4;cursor:default}
.back-next-controls button.next-btn{background:#4361ee;border-color:#4361ee;color:#fff}
.back-next-controls button.next-btn:hover{background:#3451d1}
.cancel-helper{font-size:.8125rem;color:#94a3b8;margin-top:.5rem}
.actions .confirm-btn{background:#4361ee;border-color:#4361ee;color:#fff}
.actions .confirm-btn:hover{background:#3451d1}

/* === Dark Mode === */
[data-theme=dark],[data-theme=auto]{--clr-bg:#14161e;--clr-surface:#1c1f2e;--clr-border:#2d3148;--clr-border-light:#252838;--clr-text:#e8eaf0;--clr-text-secondary:#8b90a8;--clr-text-muted:#5c6078;--clr-accent:#6b8aff;--clr-accent-bg:#1e2744;--clr-hover-bg:#1c1f2e;--clr-header-border:#252838;--clr-overlay:rgba(20,22,30,.92)}
[data-theme=dark] body,[data-theme=auto] body{background:var(--clr-bg);color:var(--clr-text)}
[data-theme=dark] .header h1,[data-theme=auto] .header h1{color:var(--clr-text)}
[data-theme=dark] .header .status-text,[data-theme=auto] .header .status-text{color:var(--clr-text-muted)}
[data-theme=dark] .progress-band,[data-theme=auto] .progress-band{border-color:var(--clr-border)}
[data-theme=dark] .progress-step,[data-theme=auto] .progress-step{border-color:var(--clr-border);color:var(--clr-text-muted)}
[data-theme=dark] .progress-step.answered,[data-theme=auto] .progress-step.answered{border-color:var(--clr-accent);color:var(--clr-accent);background:var(--clr-accent-bg)}
[data-theme=dark] .progress-step.active,[data-theme=auto] .progress-step.active{color:#fff;background:var(--clr-accent)}
[data-theme=dark] .progress-step.review,[data-theme=auto] .progress-step.review{border-color:var(--clr-text-muted);color:var(--clr-text-muted)}
[data-theme=dark] .progress-step.review.active,[data-theme=auto] .progress-step.review.active{color:#fff;background:var(--clr-accent)}
[data-theme=dark] .progress-info,[data-theme=auto] .progress-info{color:var(--clr-text-muted)}
[data-theme=dark] .progress-info strong,[data-theme=auto] .progress-info strong{color:var(--clr-text)}
[data-theme=dark] .question,[data-theme=auto] .question{border-color:var(--clr-border-light)}
[data-theme=dark] .question .q-number,[data-theme=auto] .question .q-number{color:var(--clr-border)}
[data-theme=dark] .question.active .q-number,[data-theme=auto] .question.active .q-number{color:var(--clr-accent)}
[data-theme=dark] .question h2,[data-theme=auto] .question h2{color:var(--clr-text)}
[data-theme=dark] .question.active h2,[data-theme=auto] .question.active h2{text-decoration-color:var(--clr-accent)}
[data-theme=dark] .question>p,[data-theme=auto] .question>p{color:var(--clr-text-secondary)}
[data-theme=dark] .question.active,[data-theme=auto] .question.active{background:linear-gradient(to right,var(--clr-accent-bg) 0,var(--clr-accent-bg) 3px,transparent 3px)}
[data-theme=dark] .choice-row:hover,[data-theme=auto] .choice-row:hover{background:var(--clr-hover-bg)}
[data-theme=dark] .choice-row.selected,[data-theme=auto] .choice-row.selected{border-left-color:var(--clr-accent);background:var(--clr-accent-bg)}
[data-theme=dark] .choice-row input[type=radio],[data-theme=auto] .choice-row input[type=radio],[data-theme=dark] .choice-row input[type=checkbox],[data-theme=auto] .choice-row input[type=checkbox]{accent-color:var(--clr-accent)}
[data-theme=dark] .choice-row .label-text,[data-theme=auto] .choice-row .label-text{color:var(--clr-text)}
[data-theme=dark] .choice-desc,[data-theme=auto] .choice-desc{color:var(--clr-text-muted)}
[data-theme=dark] input[type=text],[data-theme=auto] input[type=text],[data-theme=dark] input[type=number],[data-theme=auto] input[type=number],[data-theme=dark] textarea,[data-theme=auto] textarea{background:var(--clr-surface);border-color:var(--clr-border);color:var(--clr-text)}
[data-theme=dark] input:focus,[data-theme=auto] input:focus,[data-theme=dark] textarea:focus,[data-theme=auto] textarea:focus{border-color:var(--clr-accent);box-shadow:0 0 0 3px rgba(107,138,255,.15)}
[data-theme=dark] .notes-field textarea,[data-theme=auto] .notes-field textarea{border-color:var(--clr-border-light);color:var(--clr-text-muted)}
[data-theme=dark] .notes-field textarea:focus,[data-theme=auto] .notes-field textarea:focus{border-color:var(--clr-accent);color:var(--clr-text)}
[data-theme=dark] .notes-field textarea::placeholder,[data-theme=auto] .notes-field textarea::placeholder{color:var(--clr-text-muted)}
[data-theme=dark] .preview,[data-theme=auto] .preview{background:var(--clr-surface);border-color:var(--clr-border)}
[data-theme=dark] .preview-toggle,[data-theme=auto] .preview-toggle{color:var(--clr-accent)}
[data-theme=dark] .actions,[data-theme=auto] .actions{border-color:var(--clr-border)}
[data-theme=dark] .actions button,[data-theme=auto] .actions button{border-color:var(--clr-border);background:var(--clr-surface);color:var(--clr-text)}
[data-theme=dark] .actions button:hover,[data-theme=auto] .actions button:hover{border-color:var(--clr-accent);color:var(--clr-accent)}
[data-theme=dark] .back-next-controls button,[data-theme=auto] .back-next-controls button{border-color:var(--clr-border);background:var(--clr-surface);color:var(--clr-text)}
[data-theme=dark] .back-next-controls button:hover,[data-theme=auto] .back-next-controls button:hover{border-color:var(--clr-accent);color:var(--clr-accent)}
[data-theme=dark] .back-next-controls button.next-btn,[data-theme=auto] .back-next-controls button.next-btn{background:var(--clr-accent);border-color:var(--clr-accent);color:#fff}
[data-theme=dark] .back-next-controls button.next-btn:hover,[data-theme=auto] .back-next-controls button.next-btn:hover{background:#5a7aee}
[data-theme=dark] .toggle-btn,[data-theme=auto] .toggle-btn{border-color:var(--clr-border);color:var(--clr-text-muted)}
[data-theme=dark] .toggle-btn:hover,[data-theme=auto] .toggle-btn:hover{border-color:var(--clr-accent);color:var(--clr-accent)}
[data-theme=dark] .toggle-btn.active,[data-theme=auto] .toggle-btn.active{background:var(--clr-accent);border-color:var(--clr-accent);color:#fff}
[data-theme=dark] .review-ledger,[data-theme=auto] .review-ledger{}
[data-theme=dark] .review-ledger .ledger-row,[data-theme=auto] .review-ledger .ledger-row{border-color:var(--clr-border-light)}
[data-theme=dark] .review-ledger .q-num,[data-theme=auto] .review-ledger .q-num{color:var(--clr-text-muted)}
[data-theme=dark] .review-ledger .ledger-label,[data-theme=auto] .review-ledger .ledger-label{color:var(--clr-text-muted)}
[data-theme=dark] .review-ledger .ledger-value,[data-theme=auto] .review-ledger .ledger-value{color:var(--clr-text)}
[data-theme=dark] .review-ledger .ledger-answer,[data-theme=auto] .review-ledger .ledger-answer{color:var(--clr-accent)}
[data-theme=dark] .review-ledger .ledger-note,[data-theme=auto] .review-ledger .ledger-note{color:var(--clr-text-secondary)}
[data-theme=dark] .review-ledger .ledger-empty,[data-theme=auto] .review-ledger .ledger-empty{color:var(--clr-text-muted)}
[data-theme=dark] .submitted-header,[data-theme=auto] .submitted-header{color:var(--clr-text);border-color:var(--clr-accent)}
[data-theme=dark] .muted,[data-theme=auto] .muted{color:var(--clr-text-secondary)}
[data-theme=dark] .terminal-text,[data-theme=auto] .terminal-text{color:var(--clr-text-muted)}
[data-theme=dark] .overlay,[data-theme=auto] .overlay{background:var(--clr-overlay);color:var(--clr-text-muted)}
[data-theme=dark] .timer,[data-theme=auto] .timer{color:var(--clr-accent)}
[data-theme=dark] .terminal-actions button,[data-theme=auto] .terminal-actions button{border-color:var(--clr-border);background:var(--clr-surface);color:var(--clr-text)}
[data-theme=dark] .terminal-actions button:hover,[data-theme=auto] .terminal-actions button:hover{border-color:var(--clr-accent);color:var(--clr-accent)}
[data-theme=dark] .terminal-actions .primary-btn,[data-theme=auto] .terminal-actions .primary-btn{background:var(--clr-accent);border-color:var(--clr-accent);color:#fff}

/* === Inputs === */
input[type=text],input[type=number],textarea{font-family:inherit;font-size:.9375rem;padding:.5rem .75rem;border:1px solid #cbd5e1;border-radius:2px;width:100%;max-width:32rem;transition:border-color .15s}
input[type=text]:focus,input[type=number]:focus,textarea:focus{outline:none;border-color:#4361ee;box-shadow:0 0 0 3px rgba(67,97,238,.12)}
textarea{resize:vertical;min-height:2.5rem}

/* === Notes === */
.notes-field{margin-top:.75rem}
.notes-field textarea{border-style:dashed;border-color:#e2e8f0;font-size:.8125rem;color:#64748b;max-width:32rem}
.notes-field textarea:focus{border-style:solid;border-color:#4361ee;color:#1a1a2e}
.notes-field textarea::placeholder{font-style:italic;color:#94a3b8}

/* === Preview === */
.preview{margin:.5rem 0 .75rem;padding:.75rem;background:#f8fafc;border:1px solid #e2e8f0;border-radius:2px;white-space:pre-wrap;font-size:.875rem}

/* === Actions === */
.actions{display:flex;gap:.75rem;margin-top:2rem;padding-top:1.5rem;border-top:1px solid #e2e8f0}
.actions button,.terminal-actions button{font-family:inherit;font-size:.875rem;font-weight:500;padding:.5rem 1.25rem;border:1px solid #cbd5e1;border-radius:2px;background:#fff;color:#1a1a2e;cursor:pointer;transition:all .15s}
.actions button:hover,.terminal-actions button:hover{border-color:#4361ee;color:#4361ee}
.actions #submit,.terminal-actions .primary-btn{background:#4361ee;border-color:#4361ee;color:#fff}
.actions #submit:hover,.terminal-actions .primary-btn:hover{background:#3451d1}

/* === Review Ledger === */
.review-ledger{width:100%;border-collapse:collapse}
.review-ledger .ledger-row{border-bottom:1px solid #f1f5f9;padding:.875rem 0}
.review-ledger .ledger-row:last-child{border-bottom:none}
.review-ledger .q-num{font-size:.75rem;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;margin-bottom:.375rem}
.review-ledger .ledger-label{font-size:.6875rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:.125rem}
.review-ledger .ledger-value{font-size:.9375rem;color:#1a1a2e;margin-bottom:.5rem}
.review-ledger .ledger-answer{font-size:.9375rem;color:#4361ee;font-weight:500}
.review-ledger .ledger-note{font-size:.8125rem;color:#64748b;font-style:italic}
.review-ledger .ledger-empty{color:#cbd5e1}

/* === Submitted Receipt === */
.submitted-header{font-size:1.375rem;font-weight:700;color:#1a1a2e;margin:0 0 .5rem;padding-bottom:.75rem;border-bottom:2px solid #4361ee}
.submitted-answers{margin-top:1.5rem}\n.terminal-actions{display:flex;gap:.75rem;align-items:center;flex-wrap:wrap;margin-top:1.5rem;padding-top:1rem;border-top:1px solid #e2e8f0}
.timer{font-family:ui-monospace,monospace;font-size:.875rem;font-weight:600;color:#4361ee}

/* === Overlay === */
.overlay{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(255,255,255,.92);font-size:1.125rem;color:#64748b;z-index:100}
.overlay.visible{display:flex}

/* === Cancelled === */
.terminal-text{font-size:1.125rem;color:#64748b;padding:2rem 0}
</style>
</head>
<body>
<div class="header">
<h1>AskUserQuestion</h1>
<p id="status" class="status-text">Connecting...</p>
<div class="controls"><button id="theme-toggle" type="button" class="toggle-btn">\u25CC System</button><button id="layout-toggle" type="button" class="toggle-btn">All Qs</button></div>
</div>
<div id="progress" class="progress-band"></div>
<div id="mode-wrapper" class="">
<div id="questions"></div>
<div id="back-next" class="back-next-controls"><button id="back-btn" type="button">Back</button><button id="next-btn" type="button">Next</button></div>
<div id="actions" class="actions"><button id="submit" class="confirm-btn">Submit</button></div>
<p class="cancel-helper">To cancel, return to the TUI and press Esc.</p>
</div>
<div id="overlay" class="overlay">Connecting to TUI...</div>
<script>
const BOOT = ${safeJson(boot)};
let state = { questions: BOOT.questions, currentTab: BOOT.currentTab, answers: BOOT.answers || {}, options: BOOT.options || {notes:{}}, lifecycle: BOOT.lifecycle || 'open', renderOptions: BOOT.renderOptions };
let socket;
let expanded = new Set();
let sendTimer;
let pendingSendMessages = [];
let reconnectTimer;
let reconnectDelay = 500;
let terminalLifecycle = state.lifecycle !== 'open';
let awaitingState = !terminalLifecycle;
let reviewReturnTab = Math.max(0, Math.min(state.questions.length - 1, state.currentTab));
const AUTO_CLOSE_SECONDS = 5 * 60;
let autoCloseRemainingSeconds = AUTO_CLOSE_SECONDS;
let autoCloseInterval = null;
let autoCloseTimerRunning = false;
let autoCloseCancelled = false;
function connect(){
  if(terminalLifecycle) return;
  clearTimeout(reconnectTimer);
  setOverlayPending(true, 'Connecting to TUI...');
  socket = new WebSocket(BOOT.wsUrl);
  socket.onopen = () => { reconnectDelay = 500; document.getElementById('status').textContent = 'Connected'; setOverlayPending(true, 'Loading TUI state...'); };
  socket.onclose = () => { if(terminalLifecycle) return; document.getElementById('status').textContent = 'Disconnected; reconnecting...'; setOverlayPending(true, 'Reconnecting to TUI...'); reconnectTimer = setTimeout(connect, reconnectDelay); reconnectDelay = Math.min(8000, reconnectDelay * 2); };
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const dom = applyServerMessage(message);
    if(message.type === 'state') setOverlayPending(false);
    if(dom.needsRender) render();
    else {
      if(dom.needsActiveUpdate) updateActiveQuestionClasses();
      updateLifecycleOverlay();
    }
  };
}
function sameJson(left,right){ return JSON.stringify(left) === JSON.stringify(right); }
function applyLifecycle(lifecycle){
  if(!lifecycle) return false;
  const changed = state.lifecycle !== lifecycle || terminalLifecycle !== (lifecycle !== 'open');
  state.lifecycle = lifecycle;
  if(lifecycle !== 'open'){
    terminalLifecycle = true;
    clearTimeout(reconnectTimer);
    setOverlayPending(false);
    document.getElementById('status').textContent = lifecycle === 'submitted' ? 'Submitted' : 'Cancelled';
    if(lifecycle === 'cancelled') stopAutoCloseTimer();
  }
  return changed;
}
function applyServerMessage(message){
  const dom = { needsRender:false, needsActiveUpdate:false };
  const focusedTextControl = isTextValueControl(document.activeElement);
  if(message.type === 'state'){
    if(!sameJson(state.questions, message.questions || [])){ state.questions = message.questions || []; reviewReturnTab = Math.max(0, Math.min(state.questions.length - 1, reviewReturnTab)); dom.needsRender = true; }
    if(state.currentTab !== message.currentTab){ const wasSubmit = state.currentTab === state.questions.length; state.currentTab = message.currentTab; if(state.currentTab < state.questions.length) reviewReturnTab = state.currentTab; dom.needsRender = wasSubmit || state.currentTab === state.questions.length; dom.needsActiveUpdate = !dom.needsRender; }
    const nextAnswers = protectFocusedAnswer(message.answers || {});
    if(!sameJson(state.answers, nextAnswers)){ state.answers = nextAnswers; if(!focusedTextControl) dom.needsRender = true; }
    const nextOptions = protectFocusedOptions(message.options || {notes:{}});
    if(!sameJson(state.options, nextOptions)){ state.options = nextOptions; if(!focusedTextControl) dom.needsRender = true; }
    if(message.lifecycle && message.lifecycle !== 'open') terminalLifecycle = true;
    if(applyLifecycle(message.lifecycle)) dom.needsRender = true;
    return dom;
  }
  if(message.type === 'tab' && state.currentTab !== message.currentTab){ const wasSubmit = state.currentTab === state.questions.length; state.currentTab = message.currentTab; if(state.currentTab < state.questions.length) reviewReturnTab = state.currentTab; dom.needsRender = wasSubmit || state.currentTab === state.questions.length; dom.needsActiveUpdate = !dom.needsRender; }
  if(message.type === 'answers'){
    const nextAnswers = protectFocusedAnswer(message.answers || {});
    if(!sameJson(state.answers, nextAnswers)){ state.answers = nextAnswers; if(!focusedTextControl) dom.needsRender = true; }
  }
  if(message.type === 'options'){
    const protectedAnswers = protectFocusedAnswer(state.answers);
    if(!sameJson(state.answers, protectedAnswers)) state.answers = protectedAnswers;
    const nextOptions = protectFocusedOptions(message.options || {notes:{}});
    if(!sameJson(state.options, nextOptions)){ state.options = nextOptions; if(!focusedTextControl) dom.needsRender = true; }
  }
  if(message.type === 'lifecycle' && message.lifecycle !== 'open'){
    if(applyLifecycle(message.lifecycle)) dom.needsRender = true;
  }
  return dom;
}
function setOverlayPending(pending, text){
  awaitingState = pending && !terminalLifecycle;
  if(text) document.getElementById('overlay').textContent = text;
  updateLifecycleOverlay();
}
function updateLifecycleOverlay(){ document.getElementById('overlay').classList.toggle('visible', awaitingState && !terminalLifecycle); }
function setActionsVisible(visible){ document.getElementById('actions').style.display = visible ? '' : 'none'; }
function updateActionLabels(){ const reviewing = isReviewTab(); document.getElementById('submit').textContent = reviewing ? 'Confirm Submit' : 'Submit'; }
function updateActiveQuestionClasses(){ document.querySelectorAll('#questions .question').forEach((section,i)=>section.classList.toggle('active', i === state.currentTab)); updateLayoutMode(); renderProgress(); }
function answeredCount(){ let n=0; state.questions.forEach((_,i)=>{ if(currentAnswer(i) !== undefined) n++; }); return n; }
function renderProgress(){
  const bar = document.getElementById('progress'); if(!bar) return;
  bar.innerHTML = '';
  const isReview = isReviewTab();
  const total = state.questions.length;
  const answered = answeredCount();
  state.questions.forEach((_,i)=>{
    const btn = document.createElement('button'); btn.type='button';
    btn.className = 'progress-step' + (i === state.currentTab && !isReview ? ' active' : '') + (currentAnswer(i) !== undefined ? ' answered' : '');
    btn.textContent = String(i+1);
    btn.onclick = ()=> { if(isReviewTab()){ setTab(i); render(); } else setTab(i); };
    bar.appendChild(btn);
  });
  if(total >= 2){
    const rev = document.createElement('button'); rev.type='button';
    rev.className = 'progress-step review' + (isReview ? ' active' : '');
    rev.textContent = '\u2713';
    rev.title = 'Review';
    rev.onclick = ()=> showSubmitReview();
    bar.appendChild(rev);
  }
  const info = document.createElement('span'); info.className = 'progress-info';
  if(isReview){ info.innerHTML = '<strong>Review</strong> &middot; ' + answered + ' of ' + total + ' answered'; }
  else { info.innerHTML = '<strong>Step '+(state.currentTab+1)+' / '+total+'</strong> &middot; ' + answered + ' answered'; }
  bar.appendChild(info);
}
function send(message){ if(message && socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); }
function pendingKey(message){ return message.type === 'answer' ? 'answer:'+message.questionId : message.type; }
function queuePending(message){
  const key = pendingKey(message);
  const idx = pendingSendMessages.findIndex(item => item.key === key);
  if(idx === -1) pendingSendMessages.push({key, message});
  else pendingSendMessages[idx] = {key, message};
}
function sendDebounced(message){ queuePending(message); clearTimeout(sendTimer); sendTimer = setTimeout(flushDebounced, 120); }
function flushDebounced(){ if(pendingSendMessages.length === 0) return; clearTimeout(sendTimer); const messages = pendingSendMessages; pendingSendMessages = []; messages.forEach(item => send(item.message)); }
function setLocalAnswer(i,value){ if(value === null) delete state.answers[String(i)]; else state.answers[String(i)] = value; }
function protectFocusedAnswer(answers){
  const el = document.activeElement;
  const match = el && el.dataset && /^q-(\\d+)-(input|other)$/.exec(el.dataset.focusKey || '');
  if(!match) return answers;
  const i = Number(match[1]);
  const role = match[2];
  const q = state.questions[i];
  if(!q) return answers;
  if(role === 'input' && q.type === 'free_text') return {...answers, [String(i)]: el.value};
  if(role === 'other' && (q.type === 'select_one' || q.type === 'select_many' || q.type === 'confirm_enum')){
    const value = answerValue(q,i,el);
    if(value === null){ const next = {...answers}; delete next[String(i)]; return next; }
    return {...answers, [String(i)]: value};
  }
  return answers;
}
function protectFocusedOptions(options){
  const el = document.activeElement;
  const match = el && el.dataset && /^q-(\\d+)-notes$/.exec(el.dataset.focusKey || '');
  if(!match) return options;
  const q = state.questions[Number(match[1])];
  if(!q) return options;
  return {...options, notes:{...(options.notes || {}), [q.id]:el.value}};
}
function currentAnswer(i){ return state.answers[String(i)]; }
function optionValue(opt){ return opt.isOther ? '__other__' : opt.label; }
function isOtherSentinelText(text){ return String(text || '').trim().toLowerCase() === '__other__'; }
function isOtherAnswer(answer){ return answer && typeof answer === 'object' && !Array.isArray(answer) && answer.mode === 'other' && !isOtherSentinelText(answer.text); }
function choiceValue(answer){ return answer && typeof answer === 'object' && !Array.isArray(answer) && answer.mode === 'option' ? answer.value : undefined; }
function isChoiceChecked(q,i,opt){
  const answer = currentAnswer(i);
  if(q.type === 'select_many'){
    return Array.isArray(answer) && answer.some(x => opt.isOther ? isOtherAnswer(x) : choiceValue(x) === opt.label);
  }
  return opt.isOther ? isOtherAnswer(answer) : choiceValue(answer) === (q.type === 'confirm_enum' && opt.label === 'Affirm' ? 'affirm' : q.type === 'confirm_enum' && opt.label === 'Decline' ? 'decline' : opt.label);
}
function otherAnswerText(i){
  const answer = currentAnswer(i);
  if(Array.isArray(answer)){ const other = answer.find(isOtherAnswer); return other ? other.text || '' : ''; }
  return isOtherAnswer(answer) ? answer.text || '' : '';
}
function otherInputId(q,i){ return 'other-'+i+'-'+String(q.id || i).replace(/[^a-zA-Z0-9_-]/g, '_'); }
function isOtherTextInput(el){ return el && el.dataset && el.dataset.inputRole === 'other'; }
function otherTextValue(q,i,el){
  if(isOtherTextInput(el)) return el.value;
  const otherInput = document.getElementById(otherInputId(q,i));
  return otherInput ? otherInput.value : '';
}
function otherAnswerValue(q,i,el){
  const text = otherTextValue(q,i,el);
  return text && !isOtherSentinelText(text) ? {mode:'other', text} : null;
}
function answerValue(q,i,el){
  if(q.type === 'select_one'){
    if(isOtherTextInput(el) || el.value === '__other__') return otherAnswerValue(q,i,el);
    return {mode:'option', value:el.value};
  }
  if(q.type === 'select_many'){
    return Array.from(document.querySelectorAll('[name="q'+i+'"]:checked')).map(x => {
      if(x.value === '__other__') return otherAnswerValue(q,i,isOtherTextInput(el) ? el : x);
      return {mode:'option', value:x.value};
    }).filter(Boolean);
  }
  if(q.type === 'confirm_enum'){
    if(isOtherTextInput(el) || el.value === '__other__') return otherAnswerValue(q,i,el);
    return {mode:'option', value: el.value.toLowerCase() === 'affirm' ? 'affirm' : 'decline'};
  }
  if(q.type === 'number') return el.value === '' ? null : Number(el.value);
  return el.value;
}
function setTab(i){ state.currentTab = i; if(i < state.questions.length) reviewReturnTab = i; send({type:'tab', currentTab:i}); updateActiveQuestionClasses(); }
function isReviewTab(){ return state.currentTab === state.questions.length; }
function reviewBackTab(){ return Math.max(0, Math.min(state.questions.length - 1, reviewReturnTab)); }
function showSubmitReview(){ flushDebounced(); reviewReturnTab = state.currentTab < state.questions.length ? state.currentTab : reviewBackTab(); setTab(state.questions.length); render(); }
function returnFromSubmitReview(){ setTab(reviewBackTab()); render(); }
function confirmSubmit(){ flushDebounced(); send({type:'submit'}); }
function activateQuestion(i){ if(state.currentTab !== i) setTab(i); }
function isTextValueControl(el){
  if(!el) return false;
  if(el.tagName === 'TEXTAREA') return true;
  if(el.tagName !== 'INPUT') return false;
  return ['text','number','search','email','url','tel','password'].includes(el.type || 'text');
}
function captureFocus(){
  const el = document.activeElement;
  if(!el || !el.dataset || !el.dataset.focusKey) return null;
  const focus = { key:el.dataset.focusKey };
  if(isTextValueControl(el)) focus.value = el.value;
  if(typeof el.selectionStart === 'number' && typeof el.selectionEnd === 'number'){
    focus.start = el.selectionStart;
    focus.end = el.selectionEnd;
  }
  return focus;
}
function restoreFocus(focus){
  if(!focus) return;
  const el = document.querySelector('[data-focus-key="'+focus.key+'"]');
  if(!el) return;
  if(typeof focus.value === 'string' && isTextValueControl(el)) el.value = focus.value;
  el.focus({preventScroll:true});
  if(typeof focus.start === 'number' && typeof el.setSelectionRange === 'function') el.setSelectionRange(focus.start, focus.end);
}
function terminalText(){ return state.lifecycle === 'submitted' ? 'Questionnaire submitted.' : 'Questionnaire cancelled.'; }
function formatCountdown(seconds){
  const safe = Math.max(0, seconds);
  return String(Math.floor(safe / 60)).padStart(2, '0')+':'+String(safe % 60).padStart(2, '0');
}
function autoCloseTimerText(){ return autoCloseCancelled ? 'Auto-close timer cancelled.' : 'This tab will close in '+formatCountdown(autoCloseRemainingSeconds)+'.'; }
function updateAutoCloseTimerDisplay(){
  const timer = document.getElementById('auto-close-timer');
  if(timer) timer.textContent = autoCloseTimerText();
  const cancel = document.getElementById('cancel-auto-close');
  if(cancel) cancel.disabled = autoCloseCancelled;
}
function closeBrowserTab(){
  const browserWindow = typeof window !== 'undefined' ? window : globalThis;
  if(browserWindow && typeof browserWindow.close === 'function') browserWindow.close();
}
function stopAutoCloseTimer(){
  if(autoCloseTimerRunning && autoCloseInterval !== null && typeof clearInterval === 'function') clearInterval(autoCloseInterval);
  autoCloseInterval = null;
  autoCloseTimerRunning = false;
}
function tickAutoCloseTimer(){
  if(state.lifecycle !== 'submitted' || autoCloseCancelled){ stopAutoCloseTimer(); updateAutoCloseTimerDisplay(); return; }
  autoCloseRemainingSeconds = Math.max(0, autoCloseRemainingSeconds - 1);
  updateAutoCloseTimerDisplay();
  if(autoCloseRemainingSeconds === 0){ stopAutoCloseTimer(); closeBrowserTab(); }
}
function startAutoCloseTimer(){
  if(state.lifecycle !== 'submitted' || autoCloseCancelled || autoCloseTimerRunning){ updateAutoCloseTimerDisplay(); return; }
  autoCloseRemainingSeconds = AUTO_CLOSE_SECONDS;
  autoCloseTimerRunning = true;
  autoCloseInterval = setInterval(tickAutoCloseTimer, 1000);
  updateAutoCloseTimerDisplay();
}
function cancelAutoCloseTimer(){ autoCloseCancelled = true; stopAutoCloseTimer(); updateAutoCloseTimerDisplay(); }
function displayAnswerValue(value){
  if(value === undefined) return 'unanswered';
  if(Array.isArray(value)) return value.map(displayAnswerValue).join(', ');
  if(value && typeof value === 'object'){
    if(value.mode === 'option') return String(value.value);
    if(value.mode === 'other') return isOtherSentinelText(value.text) ? 'unanswered' : '(Other) '+String(value.text || '');
    return JSON.stringify(value);
  }
  return String(value);
}
function renderReviewLedger(root){
  const desc = document.createElement('p'); desc.className = 'muted'; desc.style.cssText = 'color:#64748b;margin:0 0 1.25rem;font-size:.9375rem';
  desc.textContent = 'Review your answers, then choose Confirm Submit or Back.';
  root.appendChild(desc);
  const table = document.createElement('div'); table.className = 'review-ledger';
  state.questions.forEach((q,i)=>{
    const row = document.createElement('div'); row.className = 'ledger-row';
    const num = document.createElement('div'); num.className = 'q-num'; num.textContent = (i+1) + '. ' + q.header;
    row.appendChild(num);
    const qLabel = document.createElement('div'); qLabel.className = 'ledger-label'; qLabel.textContent = 'QUESTION';
    const qVal = document.createElement('div'); qVal.className = 'ledger-value'; qVal.textContent = q.question;
    row.append(qLabel, qVal);
    const aLabel = document.createElement('div'); aLabel.className = 'ledger-label'; aLabel.textContent = 'ANSWER';
    const aVal = document.createElement('div'); aVal.className = 'ledger-answer';
    const ans = displayAnswerValue(currentAnswer(i));
    aVal.textContent = ans;
    if(ans === 'unanswered') aVal.classList.add('ledger-empty');
    row.append(aLabel, aVal);
    const note = (state.options.notes || {})[q.id];
    if(note){
      const nLabel = document.createElement('div'); nLabel.className = 'ledger-label'; nLabel.textContent = 'NOTES';
      const nVal = document.createElement('div'); nVal.className = 'ledger-note'; nVal.textContent = note;
      row.append(nLabel, nVal);
    }
    table.appendChild(row);
  });
  root.appendChild(table);
}
function renderSubmittedReceipt(root){
  const hdr = document.createElement('h2'); hdr.className = 'submitted-header'; hdr.textContent = 'Submitted';
  root.appendChild(hdr);
  const container = document.createElement('div'); container.className = 'submitted-answers';
  const table = document.createElement('div'); table.className = 'review-ledger';
  state.questions.forEach((q,i)=>{
    const row = document.createElement('div'); row.className = 'ledger-row';
    const num = document.createElement('div'); num.className = 'q-num'; num.textContent = (i+1) + '. ' + q.header;
    row.appendChild(num);
    const qLabel = document.createElement('div'); qLabel.className = 'ledger-label'; qLabel.textContent = 'QUESTION';
    const qVal = document.createElement('div'); qVal.className = 'ledger-value'; qVal.textContent = q.question;
    row.append(qLabel, qVal);
    const aLabel = document.createElement('div'); aLabel.className = 'ledger-label'; aLabel.textContent = 'ANSWER';
    const aVal = document.createElement('div'); aVal.className = 'ledger-answer';
    const ans = displayAnswerValue(currentAnswer(i));
    aVal.textContent = ans;
    if(ans === 'unanswered') aVal.classList.add('ledger-empty');
    row.append(aLabel, aVal);
    const note = (state.options.notes || {})[q.id];
    if(note){
      const nLabel = document.createElement('div'); nLabel.className = 'ledger-label'; nLabel.textContent = 'NOTES';
      const nVal = document.createElement('div'); nVal.className = 'ledger-note'; nVal.textContent = note;
      row.append(nLabel, nVal);
    }
    table.appendChild(row);
  });
  container.appendChild(table);
  root.appendChild(container);
}
function renderSubmittedTerminal(root){
  renderSubmittedReceipt(root);
  const controls = document.createElement('div');
  controls.className = 'terminal-actions';
  const timer = document.createElement('span');
  timer.id = 'auto-close-timer';
  timer.className = 'timer';
  timer.textContent = autoCloseTimerText();
  const closeNow = document.createElement('button');
  closeNow.className = 'primary-btn';
  closeNow.type = 'button';
  closeNow.textContent = 'Close Now';
  closeNow.onclick = closeBrowserTab;
  const cancel = document.createElement('button');
  cancel.id = 'cancel-auto-close';
  cancel.type = 'button';
  cancel.textContent = 'Cancel timer';
  cancel.disabled = autoCloseCancelled;
  cancel.onclick = cancelAutoCloseTimer;
  controls.append(timer, closeNow, cancel);
  root.appendChild(controls);
  startAutoCloseTimer();
}
function renderTerminal(root){
  setActionsVisible(false);
  if(state.lifecycle === 'submitted') renderSubmittedTerminal(root);
  else { stopAutoCloseTimer(); const p = document.createElement('p'); p.className = 'terminal-text'; p.textContent = terminalText(); root.appendChild(p); }
}
function render(){
  const focus = captureFocus();
  const root = document.getElementById('questions'); root.innerHTML = ''; root.textContent = '';
  updateLifecycleOverlay();
  renderProgress();
  updateLayoutMode();
  if(terminalLifecycle || state.lifecycle !== 'open'){
    renderTerminal(root);
    return;
  }
  setActionsVisible(true);
  updateActionLabels();
  if(isReviewTab()){
    const section = document.createElement('section');
    section.className = 'question active submit-review';
    renderReviewLedger(section);
    root.appendChild(section);
    restoreFocus(focus);
    return;
  }
  state.questions.forEach((q,i)=>{
    const section = document.createElement('section'); section.className = 'question' + (i === state.currentTab ? ' active' : '');
    const num = document.createElement('span'); num.className = 'q-number'; num.textContent = String(i+1);
    section.appendChild(num);
    const h2 = document.createElement('h2'); h2.textContent = q.header;
    const p = document.createElement('p'); p.textContent = q.question;
    section.append(h2, p);
    section.onclick = () => activateQuestion(i);
    const fieldset = document.createElement('fieldset');
    const opts = state.renderOptions[String(i)] || q.options || [];
    if(q.type === 'select_one' || q.type === 'confirm_enum'){
      opts.forEach((opt,j)=> addChoice(fieldset,q,i,opt,j,'radio'));
    } else if(q.type === 'select_many'){
      opts.forEach((opt,j)=> addChoice(fieldset,q,i,opt,j,'checkbox'));
    } else {
      const input = document.createElement(q.type === 'free_text' && q.multiline !== false ? 'textarea' : 'input');
      if(q.type === 'number') input.type = 'number'; else if(input.tagName === 'INPUT') input.type = 'text';
      if(q.min !== undefined) input.min = q.min; if(q.max !== undefined) input.max = q.max;
      input.placeholder = q.placeholder || '';
      input.dataset.focusKey = 'q-'+i+'-input';
      const current = currentAnswer(i); if(current !== undefined) input.value = current;
      input.onfocus = () => activateQuestion(i);
      input.oninput = () => { activateQuestion(i); const value = answerValue(q,i,input); setLocalAnswer(i,value); sendDebounced({type:'answer', questionId:q.id, value}); };
      fieldset.appendChild(input);
    }
    section.appendChild(fieldset);
    const notesWrap = document.createElement('div'); notesWrap.className = 'notes-field';
    const notes = document.createElement('textarea'); notes.placeholder = 'Add a note...'; notes.value = (state.options.notes || {})[q.id] || '';
    notes.dataset.focusKey = 'q-'+i+'-notes';
    notes.onfocus = () => activateQuestion(i);
    notes.oninput = () => { activateQuestion(i); const next = {...(state.options.notes || {}), [q.id]: notes.value}; state.options.notes = next; sendDebounced({type:'options', options:{notes:next}}); };
    notesWrap.appendChild(notes);
    section.appendChild(notesWrap);
    root.appendChild(section);
  });
  restoreFocus(focus);
}
function addChoice(parent,q,i,opt,j,kind){
  const row = document.createElement('div'); row.className = 'choice-row' + (isChoiceChecked(q,i,opt) ? ' selected' : '');
  const input = document.createElement('input'); input.type = kind; input.name = 'q'+i; input.value = optionValue(opt); input.checked = isChoiceChecked(q,i,opt);
  input.dataset.focusKey = 'q-'+i+'-choice-'+j;
  input.onfocus = () => activateQuestion(i);
  input.onchange = () => { activateQuestion(i); if(kind === 'radio'){ parent.querySelectorAll('input[type=radio][name="'+input.name+'"]').forEach(r => { if(r!==input) r.checked=false; }); parent.querySelectorAll('.choice-row').forEach(r => r.classList.remove('selected')); row.classList.add('selected'); } else { row.classList.toggle('selected', input.checked); } const value = answerValue(q,i,input); setLocalAnswer(i,value); send({type:'answer', questionId:q.id, value}); };
  const labelText = document.createElement('span'); labelText.className = 'label-text'; labelText.textContent = opt.label;
  row.append(input, labelText);
  row.onclick = (e) => { if(e.target.tagName==='INPUT'||isTextCtrl(e.target)||e.target.tagName==='BUTTON') return; activateQuestion(i); if(kind==='checkbox'){ input.checked=!input.checked; input.onchange(); } else if(kind==='radio'){ if(!input.checked){ input.checked=true; input.onchange(); } } };
  parent.appendChild(row);
  if(opt.description){ const d=document.createElement('div'); d.className='choice-desc'; d.textContent=opt.description; parent.appendChild(d); }
  if(opt.preview){ const key=q.id+':'+j; input.dataset.previewKey = key; const b=document.createElement('button'); b.type='button'; b.className='preview-toggle'; b.textContent=expanded.has(key)?'Hide preview':'Show preview'; b.dataset.previewKey = key; b.dataset.focusKey = 'q-'+i+'-preview-'+j; b.onclick=()=>{ activateQuestion(i); expanded.has(key)?expanded.delete(key):expanded.add(key); render();}; parent.appendChild(b); if(expanded.has(key)) renderPreview(parent,opt.preview); }
  if(opt.isOther){ const otherWrap = document.createElement('div'); otherWrap.className = 'choice-other-input'; const other=document.createElement('input'); other.id=otherInputId(q,i); other.type='text'; other.placeholder='Other'; other.value = otherAnswerText(i); other.dataset.focusKey = 'q-'+i+'-other'; other.dataset.inputRole = 'other'; other.onfocus=()=>activateQuestion(i); other.oninput=()=>{ activateQuestion(i); if(kind === 'radio' || other.value) input.checked = true; const value = answerValue(q,i,other); setLocalAnswer(i,value); sendDebounced({type:'answer', questionId:q.id, value}); row.classList.toggle('selected', !!other.value); }; otherWrap.appendChild(other); parent.appendChild(otherWrap); }
}
function renderPreview(parent,preview){
  const box=document.createElement('div'); box.className='preview preview-'+preview.type;
  if(preview.type === 'html' || preview.type === 'svg'){
    const iframe=document.createElement('iframe'); iframe.sandbox=''; iframe.style.width='100%'; iframe.style.minHeight='140px'; iframe.srcdoc=preview.type === 'svg' ? preview.content : preview.content; box.appendChild(iframe);
  } else if(preview.type === 'markdown'){
    box.innerHTML = renderMarkdown(preview.content);
  } else if(preview.type === 'code'){
    const pre=document.createElement('pre'); const code=document.createElement('code'); code.textContent=preview.content; pre.appendChild(code); box.appendChild(pre);
  } else {
    const pre=document.createElement('pre'); pre.textContent='['+preview.type+']\\n'+preview.content; box.appendChild(pre);
  }
  parent.appendChild(box);
}
function renderMarkdown(markdown){
  return escapeHtml(markdown)
    .replace(/^### (.*)$/gm,'<h3>$1</h3>')
    .replace(/^## (.*)$/gm,'<h2>$1</h2>')
    .replace(/^# (.*)$/gm,'<h1>$1</h1>')
    .replace(/\\*\\*(.*?)\\*\\*/g,'<strong>$1</strong>')
    .replace(new RegExp(String.fromCharCode(96)+'([^'+String.fromCharCode(96)+']+)'+String.fromCharCode(96),'g'),'<code>$1</code>')
    .replace(/\\n/g,'<br>');
}
document.addEventListener('keydown', event => { if(event.key === 'e'){ const key = document.activeElement?.dataset?.previewKey || firstPreviewKeyForCurrentQuestion(); if(key){ expanded.has(key)?expanded.delete(key):expanded.add(key); render(); } } });
function firstPreviewKeyForCurrentQuestion(){ const q=state.questions[state.currentTab]; if(!q) return null; const opts=state.renderOptions[String(state.currentTab)] || q.options || []; const idx=opts.findIndex(opt=>opt.preview); return idx === -1 ? null : q.id+':'+idx; }

/* === Theme Toggle === */
const THEME_KEY='pq-theme';
const themes=[{id:'auto',label:'System',icon:'\u25CC'},{id:'light',label:'Light',icon:'\u2600'},{id:'dark',label:'Dark',icon:'\u263E'}];
let themeIdx=0;
function applyTheme(theme){ document.body.dataset.theme=theme; if(typeof localStorage!=='undefined') localStorage.setItem(THEME_KEY,theme); if(theme==='auto'){ mediaQuery.onchange=e=>{ if((localStorage.getItem(THEME_KEY)||'auto')==='auto') document.body.dataset.theme=e.matches?'dark':'auto'; }; if(mediaQuery.matches) document.body.dataset.theme='dark'; } else { mediaQuery.onchange=null; } }
function toggleTheme(){ themeIdx=(themeIdx+1)%themes.length; applyTheme(themes[themeIdx].id); renderThemeBtn(); }
function renderThemeBtn(){ const btn=document.getElementById('theme-toggle'); if(!btn)return; const t=themes[themeIdx]; btn.textContent=t.icon+' '+t.label; btn.title='Theme: '+t.label+' (click to cycle)'; }
function renderLayoutBtn(){ const btn=document.getElementById('layout-toggle'); if(!btn)return; btn.textContent=isSingleMode()?'One Q':'All Qs'; btn.title='Layout: '+(isSingleMode()?'One question at a time':'All questions'); }
const mediaQuery=(typeof window!=='undefined'&&window.matchMedia)?window.matchMedia('(prefers-color-scheme:dark)'):{matches:false,onchange:null};
const savedTheme=(typeof localStorage!=='undefined'&&localStorage.getItem(THEME_KEY))||'auto';
themeIdx=themes.findIndex(t=>t.id===savedTheme);
if(themeIdx===-1)themeIdx=0;
applyTheme(themes[themeIdx].id);

/* === Layout Mode === */
const LAYOUT_KEY='pq-layout';
let layoutMode=(typeof localStorage!=='undefined'&&localStorage.getItem(LAYOUT_KEY))||'all';
function isSingleMode(){ return layoutMode==='single'; }
function updateLayoutMode(){ const wrapper=document.getElementById('mode-wrapper'); if(wrapper) wrapper.classList.toggle('single-question-mode',isSingleMode()); const backBtn=document.getElementById('back-btn'); const nextBtn=document.getElementById('next-btn'); if(backBtn) backBtn.disabled=(state.currentTab===0); if(nextBtn){ const isLastQ=(state.currentTab>=state.questions.length-1); nextBtn.textContent=isLastQ?'Review':'Next'; } }
function toggleLayout(){ layoutMode=layoutMode==='all'?'single':'all'; if(typeof localStorage!=='undefined') localStorage.setItem(LAYOUT_KEY,layoutMode); renderLayoutBtn(); render(); }
function goBack(){ if(state.currentTab>0) setTab(state.currentTab-1); render(); }
function goNext(){ if(isReviewTab()){ confirmSubmit(); return; } if(state.currentTab<state.questions.length-1) setTab(state.currentTab+1); else showSubmitReview(); render(); }
function isTextCtrl(el){ if(!el)return false; if(el.tagName==='TEXTAREA')return true; if(el.tagName!=='INPUT')return false; return ['text','number','search','email','url','tel','password'].includes(el.type||'text'); }
renderThemeBtn();
renderLayoutBtn();
document.getElementById('submit').onclick = () => { if(isReviewTab()) confirmSubmit(); else if(state.questions.length >= 2) showSubmitReview(); else confirmSubmit(); };
document.getElementById('back-btn').onclick = () => { goBack(); };
document.getElementById('next-btn').onclick = () => { goNext(); };
document.getElementById('theme-toggle').onclick = () => { toggleTheme(); };
document.getElementById('layout-toggle').onclick = () => { toggleLayout(); };
document.addEventListener('keydown', event => { if(event.key==='Enter' && isSingleMode() && !isReviewTab() && isTextCtrl(document.activeElement)){ event.preventDefault(); goNext(); } });
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
connect(); render(); setInterval(()=>send({type:'ping'}), 25000);
</script>
</body>
</html>`;
}

function safeJson(value: unknown): string {
	return JSON.stringify(value).replace(/</g, "\\u003c");
}
