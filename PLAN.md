# AskUserQuestion v2 — Implementation Plan

**Date:** 2026-06-18
**Spec:** `docs/superpowers/specs/2026-06-18-askuserquestion-v2-design.md`
**Worktree:** `../pi-questionnarie-v2` on branch `v2/ask-user-question`

## Philosophy

TDD discipline: each slice ships a failing test first, then minimal code to pass it, then refactor. Commit after each green test. The plan below lists the slice order; within each slice the TDD steps are explicit.

## Slice 1 — Foundation: tool rename, new schema, drop aliases

**Goal:** Rename `ask_user` → `AskUserQuestion`, replace schema with the v2 shape (5 types, no `required`, no `input_mode`/`multi_select`/`prompt` aliases), keep the existing TUI rendering working for the new types.

**Why first:** Lets us land the API break + green tests without having to design the new TUI yet. Everything else builds on this.

**Files:**
- `src/types.ts` — new types (5 QuestionType literals, BatchState, AskUserQuestionParams, etc.)
- `src/schema.ts` — new AskUserQuestionParams (no aliases, no `required`, description optional, max 7 options to leave room for auto-Other)
- `src/normalize.ts` — new normalization (no aliases, confirm_enum auto-fills Affirm/Decline)
- `src/answers.ts` — validateAgainstQuestions handles new types
- `src/index.ts` — rename tool to AskUserQuestion, register AskUserQuestionParams, result shape uses new AnswerValue discriminated union

**TDD steps:**
1. RED: `tests/test_schema.py` adds cases that:
   - accept `AskUserQuestion` with `select_one` / `select_many` / `confirm_enum` / `number` / `free_text`
   - reject old `single_select` / `multi_select` / `text` / `confirm` / `number` type names
   - reject `required` field
   - reject `prompt` / `input_mode` / `multi_select` aliases
   - require `header` and `description` (description can be empty string)
   - cap options at 7
2. GREEN: rewrite `src/types.ts` and `src/schema.ts` to match.
3. RED: `tests/test_normalize.py` adds:
   - confirm_enum with no options auto-fills to `[{label:"Affirm"},{label:"Decline"}]` + auto-Other
   - select_one/select_many auto-append Other (cap at 7 + Other = 8)
   - number/free_text error if `options` is present
   - default must equal one normalized option label (select_one) or be a list (select_many) or "affirm"/"decline" (confirm_enum)
4. GREEN: rewrite `src/normalize.ts`.
5. RED: `tests/test_answers.py` adds:
   - validateAgainstQuestions handles confirm_enum (boolean), number (number), free_text (string), select_one (string), select_many (string[])
6. GREEN: update `src/answers.ts`.
7. Update `src/index.ts` to register the new tool and use the new result shape (AnswerValue, lifecycle, notes, url, port).
8. Update `src/tui.ts` minimally to render the 5 new types (we'll redesign in slice 2; this slice just keeps things working).
9. Update `tests/harness.ts` to handle the new shape.
10. Run all tests, commit.

**Acceptance:**
- All existing pytest/node/bash e2e tests pass after updating their payloads to the new types
- A v1 payload fails schema validation with a clear "multi_select → select_many" message
- Tool name is exactly `AskUserQuestion` (capital A, U, Q)

## Slice 2 — TUI redesign: notes, checkmarks, preview, "Other" revisit, keymap

**Goal:** Full new TUI matching §4 of the spec.

**Files:**
- `src/tui.ts` — major rewrite

**TDD steps:**
1. RED: `tests/test_tui_render.mjs` adds snapshots for:
   - persistent checkmarks after returning to a question (`select_one` shows `✓ 1. Red`)
   - `select_many` shows `☑ 2. Blue` for selected
   - notes editor shows "Notes for <header>:" prompt when toggled
   - "Other" revisit shows `✎ Other` + prepopulated editor content
   - preview expansion (`e`) shows full markdown/code content
   - help overlay shows all keybindings
2. GREEN: implement each piece in `src/tui.ts`.
3. Wire all 5 types' widgets per spec §4.
4. Implement keymap:
   - `1`–`9` selects option on choice questions (clamped to options.length - 1)
   - `Meta+1`–`Meta+4` jumps tab (Alt on Linux/Win, Option on macOS)
   - `[` / `]` for tab nav (fallback)
   - `Tab` / `n` toggle notes
   - `e` toggle preview
   - `o` open browser URL (calls out to URL handler; in tests, mocks spawn)
   - `?` show help
5. Render check: each test snapshot matches.

**Acceptance:**
- `pnpm test` passes (node --test on test_tui_render.mjs)
- pytest passes (no schema/normal regressions)
- All 5 types render with checkmarks, persistent state survives tab switches
- Notes editor swaps via Tab; `n` works as fallback
- 1-9 selects option index, Meta+1-4 jumps tab

## Slice 3 — Hand-rolled mermaid renderer

**Goal:** Mermaid preview in TUI shows ASCII art for simple `graph TD`/`graph LR`; raw + link fallback for everything else.

**Files:**
- `src/mermaid.ts` — new

**TDD steps:**
1. RED: `tests/test_mermaid.py` (new) with cases:
   - `graph TD\n  A --> B` renders as ASCII with two boxes and an arrow
   - `graph LR` renders the same way as TD (per spec)
   - `graph TD\n  A[Label] --> B{Decision}` renders with multi-word labels
   - empty input → empty output
   - non-graph mermaid (sequence, class) → fallback to raw
2. GREEN: implement the parser. Naive line-by-line scanner: detect `graph TD/LR` header, then for each `A --> B` line, place nodes in a left-to-right grid and connect with ASCII arrow.
3. Try `mermaid-ascii` package first; if not installed, use hand-rolled. (Test both paths with mock.)

**Acceptance:**
- New pytest cases pass
- Output looks visually reasonable (manually inspect for a few inputs)

## Slice 4 — Live question count in renderCall

**Goal:** TUI tool-call message shows question count as the LLM streams the args (e.g. `AskUserQuestion 2 questions`).

**Files:**
- `src/scanner.ts` — new (quote-aware JSON object counter)
- `src/index.ts` — subscribe to message_update, invalidate renderCall

**TDD steps:**
1. RED: `tests/test_scanner.py` (new) with cases:
   - count `{}` braces inside `questions: [...]` array, ignoring braces inside string values
   - handles split tokens: `{"a":"b","c` then `":"d"}` should not double-count
   - handles escape sequences: `{"a":"with } brace"}` should count only outer `{}`
   - count is "0" or "unknown" until we have at least one complete object
2. GREEN: implement the scanner.
3. RED: `tests/test_index.py` or extension test: simulate message_update, verify renderCall text contains the count.
4. GREEN: wire into `src/index.ts` (no actual pi runtime — test by exporting a `createLiveCountUpdater()` factory that we mock-invoke).

**Acceptance:**
- Live count works in unit test
- Real pi integration deferred to slice 8 (no harness for it)

## Slice 5 — HTTP server + WebSocket

**Goal:** Standalone HTTP server in `src/server.ts` with port manager, state model, routes, WebSocket. TUI is not wired to it yet — that's slice 8.

**Files:**
- `src/port.ts` — new (sticky port allocation)
- `src/server.ts` — new (HTTP + WebSocket)
- `package.json` — add `ws` dependency

**TDD steps:**
1. RED: `tests/test_port.py` (new):
   - allocatePort() returns a number in [30000, 60000]
   - second call in same process returns same port (sticky)
   - if first port is occupied, +1 retry
2. GREEN: implement `src/port.ts`.
3. RED: `tests/test_server.py` (new):
   - server starts on first createServer()
   - GET `/q/<id>?nonce=<x>` returns HTML page
   - GET `/q/<id>/state?nonce=<x>` returns JSON state
   - POST `/q/<id>/answer?nonce=<x>` with `{index, value, kind:"answer"}` updates state
   - POST `/q/<id>/submit?nonce=<x>` sets lifecycle to "submitted"
   - POST `/q/<id>/cancel?nonce=<x>` sets lifecycle to "cancelled"
   - nonce mismatch returns 401
   - WebSocket connection receives initial state, then patches on update
   - Multiple WebSocket clients: a patch sent via one reaches the others
4. GREEN: implement `src/server.ts` using `http` + `ws`.
5. Add `ws` to `package.json` and run `pnpm install`.

**Acceptance:**
- All new server tests pass
- Server can be started/stopped cleanly
- State model has all fields per spec §5.3

## Slice 6 — Browser page (no vendor libs yet)

**Goal:** HTML page served from the server, basic per-type widgets, raw previews, WebSocket client.

**Files:**
- `src/browser/template.html` — new (single self-contained file)
- `src/browser/render.ts` — new (replaces placeholders in the template)

**TDD steps:**
1. RED: `tests/test_browser.py` (new):
   - GET `/q/<id>?nonce=<x>` returns HTML containing: the question headers, all option labels, the right widget element for each type (radio/checkbox/input/textarea), a Submit button, a WebSocket script tag with the right URL
   - HTML escapes user-supplied text (no XSS via option labels)
   - Notes textarea is present per question
2. GREEN: build the template with placeholders; implement render.ts to substitute questions, options, batch id, nonce, port.
3. Test WebSocket flow end-to-end: connect, send `{type:"answer",index:0,value:"A"}`, verify server state, verify second client receives a patch.

**Acceptance:**
- HTML page renders all 5 types
- WebSocket submit closes the questionnaire
- No XSS via label/question/description text

## Slice 7 — Vendor cache + browser previews

**Goal:** Markdown (marked), code (highlight.js), mermaid (mermaid.js) downloaded once and cached in `~/.cache/pi-questionnaire/vendor/`. Browser page renders them.

**Files:**
- `src/vendor.ts` — new (download + cache)
- `src/browser/template.html` — wires in vendor scripts

**TDD steps:**
1. RED: `tests/test_vendor.py` (new):
   - ensureVendored(url, dest) downloads if missing, returns cached file if present
   - if URL changes, downloads new version (per spec: "Dependency URLs must be version-pinned"; we use one URL per lib, no upgrade probe in v2)
   - if download fails, throws with clear error
2. GREEN: implement `src/vendor.ts`.
3. Update `src/browser/template.html` to:
   - on page load, fetch `/vendor/marked.js`, `/vendor/highlight.js`, `/vendor/mermaid.js`
   - the server serves these from the cache, falling back to the network on first use
   - in the browser, marked/highlight/mermaid auto-render `<pre class="...">` blocks
4. Test: open a batch with markdown preview, verify the HTML includes the rendered output (or the script tag is there if rendering is client-side).

**Acceptance:**
- First use: server downloads, browser fetches
- Subsequent uses: instant (cached)
- All preview types render in the browser

## Slice 8 — TUI ↔ browser sync

**Goal:** TUI subscribes to server events, debounces content changes, auto-switches tab on focus change, opens browser URL on `o`.

**Files:**
- `src/tui.ts` — add WebSocket client, debouncer
- `src/index.ts` — wire server lifecycle to TUI

**TDD steps:**
1. RED: `tests/test_tui_render.mjs` adds:
   - when WebSocket emits `state` with focus=N, TUI switches to question N
   - when WebSocket emits `patch` with field="answer" + index, TUI marks question answered
   - debouncer: rapid `patch` events coalesce; only the last one applies after 3s
2. GREEN: implement WS client in TUI; debouncer; auto-tab.
3. RED: `tests/test_e2e_browser_sync.py` (new, headless e2e):
   - spawn the tool, get a URL
   - open WebSocket to the URL
   - send `{type:"answer", index:0, value:{mode:"option",value:"Staging"}}`
   - verify TUI receives the patch within 3s + 1s grace
4. GREEN: implement integration in `src/index.ts`.

**Acceptance:**
- TUI auto-switches tab on browser focus
- TUI shows browser-submitted answers after 3s
- Submit/cancel from browser closes TUI

## Slice 9 — Documentation + final review

**Goal:** README, USAGE, ARCHITECTURE reflect v2; PIRFL review pass.

**Files:**
- `README.md` — update tool name, new types, new URL flow
- `docs/USAGE.md` — new types, examples, keybindings
- `docs/ARCHITECTURE.md` — HTTP server, WebSocket, TUI canonical, browser mirror

**Steps:**
1. Update each doc to reflect v2.
2. Add migration table from v1 to v2 in USAGE.
3. Run full test suite (pytest + node --test + bash e2e + browser-sync e2e).
4. PIRFL review pass (codex or fresh claude).
5. Fix any blockers/majors.
6. Merge to master, push, update changelog.

## Out of scope (v3+)

- Real auth (OAuth, session tokens, etc.)
- Cross-device sync
- HTML in TUI rendering
- Timeouts
- Persistent server across pi restarts
- Plugin-level configuration of the HTTP server
- Multi-user collaboration
- A `cmd-shift-r` to re-render TUI from server state

## Slice ordering rationale

Slices 1–2 are the schema/TUI core and can land without a network. Slices 3–4 are isolated utilities. Slices 5–7 are the HTTP/browser stack. Slice 8 wires them together. Slice 9 is docs + review. This ordering lets us keep tests green at every step and ship a working tool at any slice boundary.
