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
	onSubmit?: () => void;
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
	| { type: "state"; questions: CanonicalQuestion[]; currentTab: number; answers: AnswerMap; options: BrowserOptionsState }
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
		case "submit":
			state.lifecycle = "submitted";
			state.callbacks.onSubmit?.();
			broadcast(state, { type: "lifecycle", lifecycle: state.lifecycle });
			break;
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
body{font-family:system-ui,sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem;line-height:1.45;color:#17202a;background:#fafafa}
.question{background:#fff;border:1px solid #ddd;border-radius:10px;padding:1rem;margin:1rem 0;box-shadow:0 1px 3px #0001}.active{border-color:#5b7cff}.muted{color:#667}.row{display:block;margin:.45rem 0}.preview{margin:.5rem 0;padding:.5rem;background:#f4f6fb;border-radius:6px;white-space:pre-wrap}.actions{display:flex;gap:.75rem;margin:1rem 0}.overlay{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:#fffc;font-size:1.5rem}.overlay.visible{display:flex}textarea,input[type=text],input[type=number]{box-sizing:border-box;width:100%;padding:.45rem}button{padding:.45rem .8rem}fieldset{border:0;padding:0;margin:.5rem 0}
</style>
</head>
<body>
<h1>AskUserQuestion</h1>
<p id="status" class="muted">Connecting...</p>
<div id="questions"></div>
<div class="actions"><button id="submit">Submit</button><button id="cancel">Cancel</button></div>
<div id="overlay" class="overlay">Waiting for TUI...</div>
<script>
const BOOT = ${safeJson(boot)};
let state = { questions: BOOT.questions, currentTab: BOOT.currentTab, answers: BOOT.answers || {}, options: BOOT.options || {notes:{}}, renderOptions: BOOT.renderOptions };
let socket;
let expanded = new Set();
let sendTimer;
let reconnectTimer;
let reconnectDelay = 500;
let terminalLifecycle = false;
function connect(){
  if(terminalLifecycle) return;
  clearTimeout(reconnectTimer);
  socket = new WebSocket(BOOT.wsUrl);
  socket.onopen = () => { reconnectDelay = 500; document.getElementById('status').textContent = 'Connected'; };
  socket.onclose = () => { if(terminalLifecycle) return; document.getElementById('status').textContent = 'Disconnected; reconnecting...'; reconnectTimer = setTimeout(connect, reconnectDelay); reconnectDelay = Math.min(8000, reconnectDelay * 2); };
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if(message.type === 'state') state = {...state, ...message};
    if(message.type === 'tab') state.currentTab = message.currentTab;
    if(message.type === 'answers') state.answers = message.answers || {};
    if(message.type === 'options') state.options = message.options || {notes:{}};
    if(message.type === 'lifecycle' && message.lifecycle !== 'open') { terminalLifecycle = true; clearTimeout(reconnectTimer); document.getElementById('status').textContent = message.lifecycle; document.getElementById('overlay').classList.add('visible'); }
    render();
  };
}
function send(message){ if(socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); }
function sendDebounced(message){ clearTimeout(sendTimer); sendTimer = setTimeout(() => send(message), 120); }
function currentAnswer(i){ return state.answers[String(i)]; }
function optionValue(opt){ return opt.isOther ? '__other__' : opt.label; }
function isOtherAnswer(answer){ return answer && typeof answer === 'object' && !Array.isArray(answer) && answer.mode === 'other'; }
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
function answerValue(q,i,el){
  if(q.type === 'select_one') return el.value === '__other__' ? (document.getElementById('other-'+i).value || '') : el.value;
  if(q.type === 'select_many') return Array.from(document.querySelectorAll('[name="q'+i+'"]:checked')).map(x => x.value === '__other__' ? (document.getElementById('other-'+i).value || '') : x.value).filter(Boolean);
  if(q.type === 'confirm_enum') return el.value;
  if(q.type === 'number') return el.value === '' ? null : Number(el.value);
  return el.value;
}
function setTab(i){ state.currentTab = i; send({type:'tab', currentTab:i}); render(); }
function activateQuestion(i){ if(state.currentTab !== i) setTab(i); }
function render(){
  const root = document.getElementById('questions'); root.innerHTML = '';
  document.getElementById('overlay').classList.toggle('visible', state.currentTab === state.questions.length);
  state.questions.forEach((q,i)=>{
    const section = document.createElement('section'); section.className = 'question' + (i === state.currentTab ? ' active' : '');
    section.innerHTML = '<h2>'+escapeHtml(q.header)+'</h2><p>'+escapeHtml(q.question)+'</p>';
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
      const current = currentAnswer(i); if(current !== undefined) input.value = current;
      input.onfocus = () => activateQuestion(i);
      input.oninput = () => { activateQuestion(i); sendDebounced({type:'answer', questionId:q.id, value:answerValue(q,i,input)}); };
      fieldset.appendChild(input);
    }
    section.appendChild(fieldset);
    const notes = document.createElement('textarea'); notes.placeholder = 'Notes'; notes.value = (state.options.notes || {})[q.id] || '';
    notes.onfocus = () => activateQuestion(i);
    notes.oninput = () => { activateQuestion(i); const next = {...(state.options.notes || {}), [q.id]: notes.value}; state.options.notes = next; sendDebounced({type:'options', options:{notes:next}}); };
    section.appendChild(notes);
    root.appendChild(section);
  });
}
function addChoice(parent,q,i,opt,j,kind){
  const label = document.createElement('label'); label.className = 'row';
  const input = document.createElement('input'); input.type = kind; input.name = 'q'+i; input.value = optionValue(opt); input.checked = isChoiceChecked(q,i,opt);
  input.onfocus = () => activateQuestion(i);
  input.onchange = () => { activateQuestion(i); send({type:'answer', questionId:q.id, value:answerValue(q,i,input)}); };
  label.appendChild(input); label.append(' '+opt.label);
  parent.appendChild(label);
  if(opt.description){ const d=document.createElement('div'); d.className='muted'; d.textContent=opt.description; parent.appendChild(d); }
  if(opt.preview){ const key=q.id+':'+j; input.dataset.previewKey = key; const b=document.createElement('button'); b.type='button'; b.textContent=expanded.has(key)?'Hide preview':'Show preview'; b.dataset.previewKey = key; b.onclick=()=>{ activateQuestion(i); expanded.has(key)?expanded.delete(key):expanded.add(key); render();}; parent.appendChild(b); if(expanded.has(key)) renderPreview(parent,opt.preview); }
  if(opt.isOther){ const other=document.createElement('input'); other.id='other-'+i; other.type='text'; other.placeholder='Other'; other.value = otherAnswerText(i); other.onfocus=()=>activateQuestion(i); other.oninput=()=>{ activateQuestion(i); sendDebounced({type:'answer', questionId:q.id, value:answerValue(q,i,input)}); }; parent.appendChild(other); }
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
    const pre=document.createElement('pre'); pre.textContent='['+preview.type+']\n'+preview.content; box.appendChild(pre);
  }
  parent.appendChild(box);
}
function renderMarkdown(markdown){
  return escapeHtml(markdown)
    .replace(/^### (.*)$/gm,'<h3>$1</h3>')
    .replace(/^## (.*)$/gm,'<h2>$1</h2>')
    .replace(/^# (.*)$/gm,'<h1>$1</h1>')
    .replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>')
    .replace(new RegExp(String.fromCharCode(96)+'([^'+String.fromCharCode(96)+']+)'+String.fromCharCode(96),'g'),'<code>$1</code>')
    .replace(/\n/g,'<br>');
}
document.addEventListener('keydown', event => { if(event.key === 'e'){ const key = document.activeElement?.dataset?.previewKey || firstPreviewKeyForCurrentQuestion(); if(key){ expanded.has(key)?expanded.delete(key):expanded.add(key); render(); } } });
function firstPreviewKeyForCurrentQuestion(){ const q=state.questions[state.currentTab]; if(!q) return null; const opts=state.renderOptions[String(state.currentTab)] || q.options || []; const idx=opts.findIndex(opt=>opt.preview); return idx === -1 ? null : q.id+':'+idx; }
document.getElementById('submit').onclick = () => send({type:'submit'});
document.getElementById('cancel').onclick = () => send({type:'cancel'});
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
connect(); render(); setInterval(()=>send({type:'ping'}), 25000);
</script>
</body>
</html>`;
}

function safeJson(value: unknown): string {
	return JSON.stringify(value).replace(/</g, "\\u003c");
}
