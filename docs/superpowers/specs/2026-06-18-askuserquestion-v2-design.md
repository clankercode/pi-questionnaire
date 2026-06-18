# AskUserQuestion v2 — Design Spec

**Date:** 2026-06-18
**Status:** Draft, awaiting review
**Author:** pi-questionnaire (PIRFL workflow)

## 1. Overview

Redesign `ask_user` → `AskUserQuestion` to match Claude Code's tool API and add a browser-backed answering flow. The v1 extension (5 types, headless mode, pag-server v2 compat) is replaced with a v2 that:

- Uses Claude Code's question shape: `select_one`, `select_many`, `confirm_enum`, `number`, `free_text`
- Drops all backwards-compat aliases (no `input_mode`, no `multi_select`, no `prompt`)
- Drops the `required` field (always required)
- Adds an HTTP+WebSocket server so the user can answer in the browser
- Adds per-question notes (codex-style, Tab to swap)
- Adds persistent checkmarks (per tab + per option) that survive tab switches
- Adds an "Other" free-text escape hatch on the choice-based types (`select_one`, `select_many`, `confirm_enum`)
- Adds TUI debounce so the TUI doesn't flicker on every browser keystroke
- Adds live question count in the TUI tool-call message as the LLM streams args
- Adds a hand-rolled mermaid renderer for `graph TD` (with `mermaid-ascii` fallback)
- Renders `markdown`/`code`/`text` previews in TUI; `mermaid`/`svg`/`html` go browser-only

## 2. Non-goals (v2)

- Real auth on the HTTP server (nonce is a check, not security — the user said "it's just not like super security"; we treat it as a soft check against accidental cross-tab access)
- Cross-device sync (localhost only)
- HTML rendering in TUI (placeholder + link)
- Timeouts on questions
- Persistent server across pi restarts

## 3. Tool surface

### 3.1 Name and registration

```typescript
pi.registerTool({
  name: "AskUserQuestion",
  label: "AskUserQuestion",
  // ...
});
```

The tool name is `AskUserQuestion` (capital A, U, Q). This matches Claude Code's tool exactly.

### 3.2 Parameters

```typescript
const QuestionOptionSchema = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.Optional(Type.String({ maxLength: 2000 })),
  preview: Type.Optional(PreviewSchema),
});

const QuestionSchema = Type.Object({
  header: Type.String({ minLength: 1, maxLength: 20 }),
  question: Type.String({ minLength: 1, maxLength: 4000 }),
  description: Type.Optional(Type.String({ maxLength: 4000 })),
  type: Type.Union([
    Type.Literal("select_one"),
    Type.Literal("select_many"),
    Type.Literal("confirm_enum"),
    Type.Literal("number"),
    Type.Literal("free_text"),
  ]),
  options: Type.Optional(Type.Array(QuestionOptionSchema, { maxItems: 7 })),
  default: Type.Optional(Type.Unknown()),
  min: Type.Optional(Type.Number()),
  max: Type.Optional(Type.Number()),
  placeholder: Type.Optional(Type.String({ maxLength: 200 })),
  multiline: Type.Optional(Type.Boolean()),  // free_text only; default true
});

const AskUserQuestionParams = Type.Object({
  questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: 4 }),
});
```

### 3.3 Per-type rules

| Type | `options` required | `options` allowed | Other rules |
|---|---|---|---|
| `select_one` | yes | yes | `default`, if present, must equal one normalized option label; auto-appends "Other" |
| `select_many` | yes | yes | `default`, if present, must be an array of distinct normalized option labels; auto-appends "Other" |
| `confirm_enum` | optional | yes | If `options` is omitted, normalize to `[{ label: "Affirm" }, { label: "Decline" }]`; `default`, if present, must be `"affirm"` or `"decline"`; auto-appends "Other" |
| `number` | no (error if present) | no | `min`/`max` enforced; `default` must be a number; reject if `min > max`; coerce nothing silently |
| `free_text` | no (error if present) | no | `default` must be a string; `multiline` defaults to true; `placeholder` allowed; editor always expands to fit content |

Hard cap: 8 options per select/confirm question (7 + auto-Other). User-provided options sliced to 7 in normalization.

Additional normalization and validation rules:

- `header` is a short tab label; `question` is the full prompt.
- `default` is optional for all types. Invalid defaults are a schema/normalization error, not silently dropped.
- For choice-based questions, option identity is the normalized `label` string because Claude-style options do not carry a separate `value`.
- `confirm_enum` returns semantic values `"affirm"` / `"decline"` / `"other"` internally; the UI labels remain human-readable.
- The synthetic `"Other"` option is never counted against user-provided uniqueness checks and always opens a free-text editor.

### 3.4 Result shape

```typescript
type ChoiceAnswer =
  | { mode: "option"; value: string }
  | { mode: "other"; text: string };

type ConfirmAnswer =
  | { mode: "option"; value: "affirm" | "decline" }
  | { mode: "other"; text: string };

type AnswerValue =
  | ChoiceAnswer
  | ChoiceAnswer[]
  | ConfirmAnswer
  | number
  | string;

interface ToolResultDetails {
  questions: CanonicalQuestion[];
  answers: Record<string, AnswerValue>;
  notes?: Record<string, string>; // { "0": "context" }
  lifecycle: "answered" | "cancelled" | "rejected";
  url?: string | null;            // browser URL for this batch
  port?: number;                  // HTTP server port
}
```

Example:

```json
{
  "answers": {
    "0": { "mode": "option", "value": "Staging" },
    "1": [
      { "mode": "option", "value": "A" },
      { "mode": "other", "text": "Something else" }
    ],
    "2": { "mode": "option", "value": "affirm" },
    "3": 42,
    "4": "free-form text"
  }
}
```

## 4. TUI design

### 4.1 Layout

Per-question tab bar at the top (when 2+ questions), question + options in the middle, status/help at the bottom. Identical to v1 in structure, but with new state for: persistent checkmarks, notes editor toggle, preview expansion, browser open.

### 4.2 Persistent checkmarks

- **Tab bar:** `□` unanswered, `■` answered. Existing v1 behavior.
- **Per-option (select_*, confirm_enum):**
  - `select_one`: arrow `>` for currently-highlighted + ✓ for chosen. After selecting A then going back, A shows `✓ 1. Red`.
  - `select_many`: `☐` for unchecked, `☑` for checked. State preserved across tab switches.
  - `confirm_enum`: same as `select_one`.
- After answer, options are dimmed (`muted` theme color) but the ✓/☑ stays.

Implementation: store `answers` Map and `checked` Set in component state; re-render reads them. Re-render is called via `invalidate()` after state changes.

### 4.3 "Other" revisit

When the user revisits a question where they previously picked "Other":
- The "Other" option is highlighted with `✎` if it was the chosen one
- The editor is preloaded with the previous "Other" text (via `editor.setText(prevOtherText)`)
- The user can edit the text and re-submit, or pick a different option

### 4.4 Notes editor (Tab swap)

State: `viewMode: "answer" | "notes"` (per question).

- `Tab` on the current question swaps from answer to notes view.
- `n` also swaps (alternative keybinding).
- In notes view:
  - Shows "Notes for <header>:" prompt
  - Multiline editor with previous notes preloaded
  - `Enter` commits notes; `Shift+Enter` newline (if multiline)
  - `Esc` backs out to answer view
  - `Tab` again swaps back to answer view (toggle)
- Notes are saved to a separate `notes: Map<questionId, string>` in state.
- On Submit, both `answers` and `notes` are returned.

Notes are independent of the answer — the user can add notes to any question, answered or not.

If `Tab` cannot be captured reliably by the terminal/editor stack, `n` is the required fallback and must be shown in the help overlay. The implementation may bind both, but the spec only requires that at least one deterministic notes-toggle key works everywhere.

### 4.5 Preview rendering (TUI)

Per `preview.type`:

| Type | TUI rendering |
|---|---|
| `text` | Shown as plain text inline, theme `text` color |
| `markdown` | Rendered as plain text with `bold`/`italic` from theme. Lists indented. |
| `code` | Rendered with `highlightCode` from `@earendil-works/pi-coding-agent`. Language auto-detected from path hint or default to `text`. |
| `mermaid` | (1) Try `mermaid-ascii` (Node package) if installed, render ASCII. (2) Else hand-rolled box-drawing for `graph TD` / `graph LR` (LR treated as TD). (3) Else raw text + `[mermaid — open in browser]` link. |
| `svg` | `[svg — open in browser]` link + first ~80 chars of raw text |
| `html` | `[html — open in browser]` link only |

Preview is **collapsed by default**. `e` toggles expansion. Expanded preview shows full content inline; collapsed shows `preview attached` indicator.

### 4.6 Keyboard shortcuts

| Key | Action |
|---|---|
| `↑` / `↓` | Navigate options (select/confirm) or nudge value (number) |
| `Enter` | Select option (select_one/confirm) / commit (select_many/number/free_text/notes) / submit (Submit tab) |
| `Space` | Toggle option (select_many) |
| `Tab` | Swap between answer view and notes view for the current question |
| `Shift+Tab` | Return from notes view to answer view |
| `Esc` | Cancel (close whole questionnaire) OR back from notes |
| `e` | Toggle preview expansion (current question) |
| `o` | Open current question's browser URL (spawns `xdg-open` / `open` / `start`) |
| `n` | Swap to notes editor (alternative to Tab) |
| `1`-`4` | Jump to question N (multi-question) |
| `0` | Jump to Submit tab |
| `[` / `]` | Previous / next question tab |
| `?` | Show help overlay (lists all shortcuts) |

Browser URL is always shown in the TUI status line: `🌐 http://localhost:PORT/q/<batch-id>?nonce=<...>` with `link` formatting (terminal hyperlink escape).

### 4.7 Live question count in renderCall

The TUI tool-call message shows the count of questions as the LLM streams the args:
- Initially: `AskUserQuestion 0 questions`
- After first `}` in `questions[]`: `AskUserQuestion 1 question`
- etc.

Implementation: subscribe to `message_update` in `index.ts`. On each token, maintain a quote-aware incremental scanner for the current tool call's JSON args. Count only top-level objects inside the `questions` array while honoring string/escape state; do not count braces that appear inside string contents such as markdown, code, or mermaid previews. The count is stored in a per-tool-call state cell, and `message_update` must explicitly invalidate the render so `renderCall` refreshes.

This requires:
- Identifying which tokens belong to our tool call (via toolCallId in `assistantMessageEvent`)
- Buffering the JSON until complete (or until we have enough to count)
- A small partial-JSON state machine

## 5. HTTP server

### 5.1 Lifecycle

- One server per pi process.
- Started on the first `AskUserQuestion` tool call.
- Sticky port: pick a random port in `[30000, 60000]` on first start. If `EADDRINUSE`, try +1, +2, ... up to 10 retries. If all fail, fall back to TUI-only mode (no error to the user, just no browser option).
- Bind `127.0.0.1` only.
- Stopped on `session_shutdown` or after the last questionnaire completes (whichever comes first).
- Concurrent `AskUserQuestion` calls in the same pi process share the server (per-batch routes).

The TUI is the canonical owner of questionnaire state for the active tool call. The HTTP server holds a mirrored per-batch copy so the browser can connect and reconnect, but it does not invent independent state.

### 5.2 Routes

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/q/<batch-id>?nonce=<...>` | Serve the HTML page for a batch |
| `GET` | `/q/<batch-id>/state?nonce=<...>` | Return current state as JSON |
| `POST` | `/q/<batch-id>/answer?nonce=<...>` | Submit an answer or notes (body: `{ index, value, kind: "answer" \| "notes", focus? }`) |
| `POST` | `/q/<batch-id>/submit?nonce=<...>` | Submit the whole questionnaire without requiring WebSocket connectivity |
| `POST` | `/q/<batch-id>/cancel?nonce=<...>` | Cancel the questionnaire without requiring WebSocket connectivity |
| `WS` | `/q/<batch-id>?nonce=<...>` | WebSocket for bidirectional live updates |

Every route requires the nonce to match. Mismatch returns 401 / closes the socket.

### 5.3 State model (in-process mirror, canonical state lives in TUI)

```typescript
interface BatchState {
  id: string;            // uuid
  nonce: string;         // random 16 bytes
  questions: CanonicalQuestion[];
  answers: Record<string, AnswerValue>; // by index
  notes: Record<string, string>;      // by index
  activeQuestion: number | null; // current question index selected in TUI
  browserFocus: number | null;   // latest browser-focused question index
  lifecycle: "open" | "submitted" | "cancelled";
  createdAt: number;
  updatedAt: number;
}
```

State changes emit events on an in-process `EventEmitter` keyed by `batchId`. TUI-originated changes update the canonical state first, then mirror to the server copy and emit. Browser-originated changes are validated by the server, forwarded to the TUI, and only become visible to other clients after the TUI applies them and echoes back the mirrored state.

### 5.4 WebSocket protocol

Server → client (events):
- `{ type: "state", state: BatchState }` — full state on connect
- `{ type: "patch", index?: number, field: "answer" | "notes" | "activeQuestion" | "browserFocus" | "lifecycle", value: any }` — incremental updates
- `{ type: "ping" }` — keepalive every 30s

Client → server (commands):
- `{ type: "answer", index: number, value: any }` — set an answer
- `{ type: "notes", index: number, value: string }` — set notes
- `{ type: "focus", index: number | null }` — set browser focus only
- `{ type: "submit" }` — submit all answers
- `{ type: "cancel" }` — cancel

The server validates commands against the schema before applying them.

### 5.5 Debounce (TUI refresh)

TUI subscribes to `BatchState` events from the server. To avoid flicker during rapid browser typing, answer/note content changes from the browser are buffered and flushed after 3 seconds of no new content events. Focus changes, submit/cancel lifecycle changes, and initial state sync are rendered immediately. The debouncer must retain the latest full mirrored batch snapshot, not just the last raw event, so no intermediate answer/note changes are lost.

Implementation: per-batch debouncer in the TUI. A `setTimeout(..., 3000)` is reset on each answer/note event. On fire, the TUI swaps in the latest mirrored batch snapshot and invalidates its render. Non-debounced events (`focus`, `submit`, `cancel`, initial `state`) bypass the timer and invalidate immediately.

The first answer/note event after the debounce window is rendered immediately; subsequent answer/note events within the window coalesce.

## 6. Browser page

### 6.1 Structure

Single HTML file served at `/q/<batch-id>?nonce=<...>`. Vanilla HTML + inline CSS + minimal JS. No build step. ~200 LoC total.

Layout:
- Header: tool name, batch title
- Question list (vertical): each question is a card with header, question text, description, and the answer widget
- Sidebar: browser's current focus (highlighted question), notes panel
- Footer: Submit All button, link to cancel

### 6.2 Per-type widgets

| Type | Browser widget |
|---|---|
| `select_one` | Radio buttons |
| `select_many` | Checkboxes |
| `confirm_enum` | Radio buttons (Yes / No / [Other]) |
| `number` | `<input type="number">` with min/max |
| `free_text` | `<textarea>` (auto-resize) |
| `notes` | `<textarea>` per question (separate from answer) |

### 6.3 Previews in browser

| Type | Browser rendering |
|---|---|
| `text` | Plain `<pre>` |
| `markdown` | `marked` from a vendored copy (downloaded on first use, cached in `~/.cache/pi-questionnaire/marked.js`) |
| `code` | `highlight.js` from a vendored copy (same caching) |
| `mermaid` | `mermaid.js` from a vendored copy (same caching) — auto-renders `<pre class="mermaid">` blocks |
| `svg` | Inline `<svg>` (sanitized) |
| `html` | Sandboxed `<iframe srcdoc="...">` |

Vendored libraries are downloaded once on first use and cached locally. The user approved this pattern: "download them once and globally cache them on first load."

Cache location: `~/.cache/pi-questionnaire/vendor/`. Dependency URLs must be version-pinned in code. A cached file is reused as long as the pinned URL is unchanged; there is no background "newer version" probe in v2.

### 6.4 Live updates

WebSocket connection to the server. On every event, the relevant DOM is updated. TUI-originated answer, notes, and activeQuestion changes are mirrored to the server and pushed to the browser, so the browser scrolls to / highlights the current question and reflects any in-TUI edits. Browser-originated answer, notes, focus, submit, and cancel changes flow in the opposite direction.

## 7. Port and URL

### 7.1 Sticky port

- On first start: pick random in `[30000, 60000]`.
- On `EADDRINUSE`: try +1, +2, ... up to 10 times.
- Sticky across all calls in the same pi process.

### 7.2 URL format

```
http://localhost:PORT/q/<batch-id>?nonce=<random>
```

- `<batch-id>` is a UUID.
- `<random>` is 32 hex chars (16 random bytes).
- The nonce is included in every state request, answer POST, and WebSocket URL.
- Server validates the nonce on every request.

The nonce is **mild security** (per the user): it prevents accidental cross-tab access and casual CSRF. It is NOT strong security — anyone with shell access to the user's machine can read the URL and submit. That's fine; the threat model is "accidental", not "malicious".

## 8. Lifecycle

| Event | State transition |
|---|---|
| Tool called | `lifecycle: "open"`, TUI creates canonical state, server starts (if not running), server mirrors the initial snapshot |
| User answers in TUI | Canonical `answers` updated in TUI, mirrored to server, server emits patch/state to browsers |
| User answers in browser | Server validates and forwards intent to TUI, TUI applies it to canonical state, server mirrors the updated snapshot |
| User submits (TUI or browser) | `lifecycle: "submitted"`, TUI `done()`, server emits final state, server cleans up batch |
| User cancels (Esc) | `lifecycle: "cancelled"`, TUI `done()`, server emits final state, server cleans up batch |
| Session ends | `lifecycle: "cancelled"` for all open batches, server stops |

## 9. Files and modules

### 9.1 New files

- `src/server.ts` — HTTP + WebSocket server, port management, state model
- `src/browser/template.html` — the HTML page (with inline CSS, embedded JS)
- `src/browser/render.ts` — server-side render of the HTML (replaces placeholders)
- `src/mermaid.ts` — hand-rolled mermaid renderer
- `src/vendor.ts` — vendored library download/cache

### 9.2 Modified files

- `src/index.ts` — rename tool, wire up server, subscribe to events for live count and debounced refresh
- `src/types.ts` — new types (`BatchState`, `AskUserQuestionParams`, etc.)
- `src/schema.ts` — new schema (no aliases, new types)
- `src/normalize.ts` — new normalization (no aliases, new defaults)
- `src/answers.ts` — updated for new types
- `src/tui.ts` — new TUI (notes, checkmarks, preview expansion, browser open, live count)
- `package.json` — add `ws` dependency
- `tests/` — update existing, add new

### 9.3 Removed

- `src/headless.ts` — headless mode is no longer needed (browser IS the headless mode; the answers come from the browser via HTTP). The `PI_QUESTIONNAIRE_ANSWERS_FILE` env var is gone.
- Backwards-compat aliases: removed.

### 9.4 Migration behavior

- v1 callers using tool name `ask_user` fail fast with a clear "tool renamed to AskUserQuestion" error.
- v1 payloads sent to `AskUserQuestion` fail schema validation with explicit field/type guidance (`multi_select` → `select_many`, `prompt` removed, `required` removed, etc.).
- README/USAGE must include a migration table with before/after examples so prompt authors can update quickly.
- No silent compatibility shim is provided in v2.

## 10. Testing

### 10.1 Unit (pytest, currently 47)

- Update for new schema/types
- Add: schema rejects old type names, rejects `required`, rejects aliases
- Add: confirm_enum auto-fills options
- Add: per-type options rules
- Add: hand-rolled mermaid renderer (parser + ASCII output)
- Add: vendor cache logic
- Add: port allocation (sticky, +1 retry)
- Add: quote-aware streaming arg scanner for live question count
- Add: result-shape normalization for `"other"` and `confirm_enum`

### 10.2 TUI render (node --test, currently 15)

- Update for new types
- Add: persistent checkmarks across tab switches
- Add: notes editor
- Add: preview expansion
- Add: "Other" revisit prepopulates
- Add: help overlay
- Add: tab navigation via `[` / `]`
- Add: notes-toggle fallback when `Tab` is not delivered by the terminal

### 10.3 E2E (bash + pi --print, currently 6)

- Update prompts to use new type names + new fields
- Add: "Other" answer flows back to model
- Add: notes flows back to model

### 10.4 E2E (new: browser sync)

- Headless test using `ws` Node client + `http` GET
- Open a batch, connect via WebSocket, submit an answer, verify TUI sees it
- Open a batch, set focus, verify TUI switches tabs
- Open a batch, submit, verify TUI closes
- Open a batch, edit notes rapidly from browser, verify the 3s debounce applies the final mirrored snapshot without dropping intermediate fields
- Drop and reconnect the WebSocket, verify the browser receives the latest full state snapshot

### 10.5 Migration test

- Verify the old v1 schema fails cleanly with a clear error message (not a silent accept)

## 11. Risks and open questions

### 11.1 Risks

- **WebSocket reliability:** Network blips may disconnect the browser. Reconnect logic with exponential backoff.
- **Server lifecycle:** If the server crashes mid-questionnaire, browser connectivity is lost. Mitigation: canonical state remains in TUI memory; the server can be restarted and re-seeded from the TUI snapshot for still-open batches.
- **Mermaid in TUI:** Hand-rolled parser may produce ugly output for complex diagrams. Fallback to `mermaid-ascii` then raw + link.
- **Browser vendor caching:** First-use download may be slow (~1MB total for marked + highlight + mermaid). Show a small spinner in the browser while it loads.
- **Live count parsing:** Streaming JSON may arrive in arbitrarily split chunks. Mitigation: quote-aware incremental scanner with fallback to "unknown" until the next safe object boundary.

### 11.2 Open questions for review

- Should we offer a "skip question" keybinding? (Skip an optional question.) — currently no optional questions (no `required` field), so N/A.
- Should the browser page support keyboard navigation? (Tab between questions, etc.) — yes, default browser behavior.
- Should there be a "reset all" button in the browser? — probably not; user can re-edit each question.
- Should the live count also work in non-streaming mode? — yes, it falls back to `args.questions.length` when no streaming is detected.

## 12. Implementation order

1. Tool rename + new schema/types (no HTTP server yet) — keeps the tool working in TUI-only mode first
2. TUI redesign: checkmarks, notes, preview, "Other" revisit
3. Mermaid renderer (hand-rolled + mermaid-ascii fallback)
4. Live question count in renderCall
5. HTTP server: routes, state, WebSocket
6. Browser page
7. Vendor cache
8. Debounce
9. Tests for each layer
10. E2E with browser sync
11. Final review + merge

## 13. Acceptance criteria

- [ ] Tool renamed to `AskUserQuestion`; old name fails with clear error
- [ ] All 5 types work: select_one, select_many, confirm_enum, number, free_text
- [ ] `confirm_enum` auto-fills options when empty
- [ ] Result payload shape is explicit for all 5 types, including `"other"` and `confirm_enum`
- [ ] `free_text` always uses expanding multiline editor
- [ ] `select_*` error if options empty; `number`/`free_text` error if options present
- [ ] Per-question notes (Tab to swap, Enter to commit, Esc to back out)
- [ ] Persistent checkmarks: tab bar + per-option
- [ ] "Other" revisit prepopulates
- [ ] HTTP server starts on first call, sticky port, +1 retry, 127.0.0.1 only
- [ ] Browser page renders all 5 types
- [ ] Browser previews: markdown/code/mermaid/svg/html all work
- [ ] Mermaid in TUI: hand-rolled for graph TD/LR, mermaid-ascii fallback, raw+link fallback
- [ ] Live question count in renderCall (counts as LLM streams)
- [ ] TUI debounce: 3s idle before TUI refresh on browser events
- [ ] TUI remains the canonical state owner; server/browser are mirrors
- [ ] TUI auto-switches tab to match browser focus
- [ ] `e` expands preview; `o` opens browser
- [ ] URLs shown with link formatting
- [ ] All tests pass: pytest, node --test, bash e2e, browser-sync e2e
- [ ] Old v1 schema rejected with clear error
- [ ] README + ARCHITECTURE + USAGE updated
- [ ] No regressions on previously-working flows

## 14. Out of scope (deferred to v3+)

- Real auth (OAuth, session tokens, etc.)
- Cross-device sync
- HTML in TUI rendering
- Timeouts
- Persistent server across pi restarts
- Plugin-level configuration of the HTTP server (bind, port range, etc.)
- Multi-user collaboration (multiple browsers answering the same questionnaire)
- A `cmd-shift-r` to re-render the TUI from server state (currently TUI is source of truth)
