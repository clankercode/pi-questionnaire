# Architecture

## High-level

`pi-questionnaire` is a single pi extension that registers one tool: `AskUserQuestion`. The tool asks 1–4 questions per call, renders a rich tabbed TUI with persistent state, fires configurable side effects on mount, and returns a canonical answer map (plus optional notes) to the model.

```
src/
  index.ts          → registerTool({ name: "AskUserQuestion", ... }) + tool result formatting
  schema.ts         → typebox params + semantic validation + v1-legacy error messages
  normalize.ts      → raw question → canonical v2 question (Other injection, confirm_enum defaults)
  types.ts          → canonical types + constants (MAX_*, label names, type guards)
  answers.ts        → answer payload coercion/validation (Claude Code + pag-server shapes)
  tui.ts            → rich TUI component (notes, checkmarks, danger flow, preview, help, timer, title)
  settings.ts       → 14-field settings persistence (global + project merge, in-memory hook for tests)
  side-effects.ts   → on-question side effects (notification, TTS, command, heartbeat, browser-intent log)
```

## Module boundaries

- `schema.ts` is the only module that imports `typebox`. Other modules import types from `types.ts`.
- `normalize.ts` is the only module that mutates the canonical shape (Other injection, confirm_enum defaults, default validation). Tests target normalization without touching the schema validation.
- `answers.ts` is pure (no I/O). It accepts any pag-server shape and produces a canonical answer map.
- `tui.ts` is the only module that imports from `@earendil-works/pi-tui`. Everything else is portable.
- `settings.ts` is the only module that reads/writes the JSON config files. The extension never writes the global file; only the future settings menu writes the project file via `saveSettings()`.
- `side-effects.ts` is the only module that `spawn()`s child processes. It accepts `SideEffectDeps` overrides for tests, so the production code path is identical to the test path.
- `index.ts` is the only module that calls `pi.registerTool()`. It wires schema, normalize, side effects, settings, and TUI together.

This shape makes each layer swappable in isolation: the TUI could be replaced with a web UI, the headless loader (when it lands in slice 5+) could be replaced with an HTTP endpoint, the settings JSON could be replaced with a database — none of the other modules would need to change.

## Data flow

```
   LLM tool call
        │
        ▼
  ┌─────────────────────────────────────────────┐
  │ 1.  validateSemantics(params)               │  src/schema.ts
  │     — typebox + per-type rules              │
  └─────────────────────────────────────────────┘
        │ ok
        ▼
  ┌─────────────────────────────────────────────┐
  │ 2.  normalizeQuestions(params.questions)    │  src/normalize.ts
  │     — Other injection                       │
  │     — confirm_enum default options          │
  │     — default validation per type           │
  │     — free_text multiline default true      │
  └─────────────────────────────────────────────┘
        │
        ▼
  ┌─────────────────────────────────────────────┐
  │ 3.  fireOnQuestionSideEffects(params, pi)   │  src/side-effects.ts
  │     — read getSettings() live               │
  │     — notification / TTS / command /        │
  │       heartbeat / browser-intent log        │
  │     — return handle w/ clear()             │
  └─────────────────────────────────────────────┘
        │
        ▼
  ┌─────────────────────────────────────────────┐
  │ 4.  ctx.ui.custom(buildQuestionnaireComponent)│  src/tui.ts
  │     — TUI mount: title + BEL + timer        │
  │     — render(width): string[]  (pure)       │
  │     — handleInput(data): key routing        │
  │     — done({ answers, notes, lifecycle })   │
  └─────────────────────────────────────────────┘
        │
        ▼
  ┌─────────────────────────────────────────────┐
  │ 5.  sideEffects.clear() on every return     │  src/side-effects.ts
  │     — release heartbeat + delayed notif     │
  └─────────────────────────────────────────────┘
        │
        ▼
  ToolResult { content, details: ToolResultDetails }
```

Every error path (`validateSemantics` failure, `normalizeQuestions` throw, non-tui mode) returns a `ToolResult` with `lifecycle: "rejected"` or `"cancelled"` so the model can recover. The user-cancelled path returns `lifecycle: "cancelled"`. The answered path returns `lifecycle: "answered"` with the canonical `AnswerMap` (and optional `notes`) plus the active `debounceMs` value.

## Settings flow

```
   getSettings()        — fully resolved view (defaults + disk + in-memory)
   loadSettings()       — disk view only (DEFAULT + global < project)
   saveSettings()       — write to <cwd>/.pi/ask-user-question.json
   readSettingsFile()   — read + sanitize a single file (unknown keys dropped)
```

Merge order (low → high precedence):

```
DEFAULT_SETTINGS  <  global disk  <  project disk  <  in-memory test override
```

The global file is **never written by the extension** (only by hand or by a future settings menu). The project file is written only via `saveSettings()`. Both files are optional — missing files are silent.

Sanitization drops unknown keys and out-of-range values silently. A file that exists but fails to parse emits a warning to stderr and is treated as empty so startup always proceeds.

`getSettings()` is called **live** at every `execute()` invocation. Edits to the JSON files take effect on the next question without a pi restart. The TUI's `is_dangerous` flow and the `playBell()` helper both call `getSettings()` directly, so they pick up edits without remounting.

## TUI state machine

The TUI component has two pieces of state that drive rendering:

```typescript
type ViewMode = "answer" | "notes" | "help";
type InputMode = "text" | "number" | "other" | "free_text" | "notes" | "danger" | null;
```

### `viewMode`

Per-component state, drives the top-level render branch:

- `answer` — the normal question view.
- `notes` — the notes editor for the current question. Triggered by `Tab` or `n`.
- `help` — the keymap help overlay. Triggered by `?`. Any key dismisses.

### `inputMode`

Per-component state, drives the editor's behavior. `null` means no editor is open. Transitions:

- `null → number` — when Enter is pressed on a `number` question.
- `null → free_text` — when Enter is pressed on a `free_text` question.
- `null → other` — when an `Other` option is selected on a choice question.
- `null → notes` — when `Tab`/`n` opens the notes editor.
- `null → danger` — driven by `reconcileMode()` when the active question is `is_dangerous` and `dangerCheckEnabled` is true.
- any → `null` — on successful commit, on Esc (except `notes` which goes through `closeNotes()`), or when `reconcileMode()` detects a non-danger question.

### `reconcileMode()`

A helper called at the top of every `render()` and after every tab change. It reads the active question, and:

- If the question is `is_dangerous` **and** `dangerCheckEnabled` is true, forces `inputMode = "danger"` and prefills the editor with the previous answer (if any).
- If we're in `danger` mode but the active question is no longer dangerous, drops back to `null` and clears the editor.

This keeps `inputMode` in sync with the active question without every call-site having to remember to manage it. The single explicit transition the user can drive is the notes toggle (`Tab`/`n` → `openNotes` / `closeNotes`).

### State table

| User action                               | viewMode        | inputMode                                            |
|-------------------------------------------|-----------------|------------------------------------------------------|
| Mount, single question                    | answer          | null (or danger if is_dangerous)                     |
| Mount, multi-question, tab 0 not dangerous| answer          | null                                                 |
| Mount, multi-question, tab 0 is dangerous | answer          | danger (prefilled with previous answer if any)       |
| `↑`/`↓`                                   | (unchanged)     | (unchanged)                                          |
| `Enter` on select_one/confirm_enum option | answer          | (commits answer; advances or submits)                |
| `Enter` on select_many option             | answer          | (toggles; not committing)                            |
| `Enter` on select_many `[Select]` button  | answer          | (commits array; advances or submits)                 |
| `Enter` on `Other` option                 | answer          | other                                                |
| `Enter` on `number` question              | answer          | number                                               |
| `Enter` on `free_text` question           | answer          | free_text                                            |
| `Enter` while `inputMode` set             | (unchanged)     | (commits via `editor.onSubmit`)                      |
| `Tab` / `n` (in answer view)              | notes           | notes (prefilled)                                    |
| `Enter` while in notes view               | notes           | notes (saves; stays in view)                         |
| `Tab` / `n` (in notes view)               | answer          | null                                                 |
| `Esc` (in notes view)                     | answer          | null (discards unsaved edits)                        |
| `Esc` (in danger mode)                    | —               | — (cancels whole questionnaire)                     |
| `Esc` (otherwise)                         | answer          | null                                                 |
| `?`                                       | help            | (unchanged)                                          |
| any key in help view                      | answer          | (unchanged)                                          |

## TUI render architecture

The component factory returns an object with three methods:

```typescript
{
  render(width: number): string[],   // pure — lines for the host to print
  handleInput(data: string): void,   // key routing
  invalidate(): void,                // request a re-render
  // ...plus dispose / test helpers
}
```

`render(width)` is **pure**: it reads component state and produces a `string[]` of themed lines. The host (`ctx.ui.custom`) is responsible for printing. This keeps the component testable — the `test_tui_render.mjs` suite calls `render(80)` and asserts on substrings.

`handleInput(data)` is the only state-mutation path. It:

1. Routes by `viewMode` (help overlay vs answer vs notes).
2. Routes by `inputMode` (editor vs no editor).
3. Routes by question type for the no-editor branch.

Every state mutation ends with a `refresh()` (which is `tui.requestRender()`).

`reconcileMode()` is called at the top of `render()` so any tab change (or the first mount) drives the editor into the right mode. Call-sites that change the tab (e.g. `[`/`]`/Meta+1-4/`0`) call `reconcileMode()` after the change so the editor is in sync before the next `render()`.

The `setBrowserUrl()` and `getBrowserOpenAttempt()` hooks are exposed for slice 5+ (browser path) to wire up. Today they're no-ops — `o` records the attempt but doesn't spawn.

## Side effects architecture

`fireOnQuestionSideEffects(params, pi, deps)` is called at the start of `execute()`, **before** the TUI is shown. It reads `getSettings()` fresh (no cache) and:

| Setting(s)                                | Effect                                                                                    |
|-------------------------------------------|-------------------------------------------------------------------------------------------|
| `browserEnabled`                          | Log "browser enabled (slice 5+ would start HTTP server)" — intent only, no spawn today    |
| `browserAutoOpen` + `browserMinQuestions` | Log "would auto-open browser" if question count ≥ threshold — intent only                 |
| `copyUrlToClipboard`                      | Log "would copy URL to clipboard (slice 5+)" — intent only                                |
| `notificationOnQuestion` + delay          | Spawn `notify-send` / `osascript` / `msg` (platform-picked), possibly delayed by `notificationDelaySeconds` |
| `ttsOnQuestion`                           | Spawn `attn "AskUserQuestion: <header>"`                                                  |
| `onQuestionCommand`                       | Write payload JSON to `os.tmpdir()/ask-user-question-<id>.json`, spawn the command with `PI_QUESTIONNAIRE_PAYLOAD_FILE` env var |
| `heartbeatWhileActive` + interval         | `setInterval` calling `pi.sendMessage` with `customType:"ask-user-question-heartbeat"`, `deliverAs:"followUp"` |
| `dangerCheckEnabled`                      | Log "danger check: enabled/disabled" — TUI reads the setting itself                       |
| `herdrReportBlocked`                      | Inside a herdr pane (`HERDR_ENV=1` + `HERDR_PANE_ID`), spawn `herdr pane report-agent --state blocked` on mount and `herdr pane release-agent` on `clear()`; no-op outside herdr |
| `debounceMs`                              | Not a side effect; the caller (`index.ts`) puts it on the `ToolResultDetails`             |

All spawns are wrapped in try/catch — **side effects must NEVER break the tool**. The TUI shows even if every side effect fails.

All timers are `.unref()`-ed (where supported) so they never keep Node alive after the questionnaire settles.

Returned handle:

```typescript
{
  effects: string[],          // names of fired effects, in execution order
  payloadFile: string | null, // on-disk path of onQuestionCommand payload
  heartbeatStarted: boolean,  // true if heartbeat interval was started
  clear(): void,              // release heartbeat + delayed notification timer; safe to call multiple times
}
```

`index.ts` calls `sideEffects.clear()` on **every** return path (TUI settled, user cancelled, TUI threw) so the heartbeat and delayed notification can't outlive the questionnaire.

### Testability

`SideEffectDeps` lets tests inject:

- A recording `spawn` (records `{cmd, args, env, shell, detached}` per call).
- A fake `setInterval` / `setTimeout` (manually advanced, so the heartbeat + delay can be tested deterministically).
- A fake `randomBytes` (deterministic payload file names).
- An `override` for `getSettings()` so per-test settings are read live.
- A mock `sendMessage` (records heartbeat messages).
- A `log` callback so "would" intents are observable.

This is what `tests/test_side_effects.py` (31 cases) drives via `tests/harness.ts`.

## The `is_dangerous` flow

```typescript
function isDangerActive(q: CanonicalQuestion): boolean {
  if (q.is_dangerous !== true) return false;
  return getSettings().dangerCheckEnabled === true;
}
```

The TUI reads the setting dynamically (no cache) so tests can flip `dangerCheckEnabled` via `setInMemorySettings()` without remounting.

When `isDangerActive(q)` is true on the active question:

- `reconcileMode()` forces `inputMode = "danger"` and prefills the editor with the previous answer (`answers.get(q.id)?.value`, cast to `string` — the free_text answer value is already a string).
- `render()` renders the warning header `⚠️  DESTRUCTIVE — <header>` instead of the normal `q.header` line, and skips the type-specific UI.
- The `Submit` tab is hidden so the user can't skip past the confirmation by jumping tabs.
- `editor.onSubmit()` for `inputMode === "danger"`: empty / whitespace-only text is rejected (no commit, no advance, no error toast — the empty editor is the visual cue). Non-empty text commits the answer and advances.
- `Esc` while in `danger` mode cancels the whole questionnaire (no "back out of the editor but stay on the question" path — the danger confirmation is atomic).
- `Up` / `Down` are suppressed while `inputMode === "danger"` so the editor's history cursor doesn't move behind the user.

On revisit (after navigating away and back), the editor is **prefilled with the previous answer** so re-acknowledging a danger flow doesn't require retyping from scratch.

## Testing strategy

Three layers today:

1. **Python pytest (~110 cases)** drives the production TypeScript via `tests/harness.ts` over stdin/stdout. No mocks for production code; only `SideEffectDeps` overrides in `test_side_effects.py` for Node API surface.
   - `test_schema.py` — 26 cases. Schema acceptance, per-type rules, legacy field rejection.
   - `test_normalize.py` — 29 cases. Other injection, confirm_enum defaults, default validation, free_text multiline default.
   - `test_answers.py` — 25 cases. Answer coercion (pag-server shapes, `{mode,value/text}`, booleans → `confirm_enum`).
   - `test_side_effects.py` — 31 cases. Per-setting gating, platform notification command selection, heartbeat + delayed notification timer wiring, in-memory settings override.
2. **Node `--test` (50 cases)** drives the TUI render and helpers. Calls `render(80)` and asserts on substrings (no snapshot diffing — substring assertions are robust across theme changes).
3. **Bash e2e** (`test_e2e_pi.sh`) is currently a SKIP no-op; the real e2e lands with the browser path in slice 5+ (using a Node `ws` client + `http` GET to drive the same flows pytest drives today via the harness).

Why this shape:

- Unit tests are fast (~ms per case, parallelizable, no LLM).
- Render tests catch UI regressions without needing a real terminal.
- The pytest harness keeps the test target the **production** code (no parallel "test mode" implementation that drifts from the real one).
- Side-effect tests run against the real `fireOnQuestionSideEffects` with deps overridden — they exercise the real settings merge, the real payload-file write, the real timer wiring.

## Slices (v2 implementation order)

The full v2 spec is at `docs/superpowers/specs/2026-06-18-askuserquestion-v2-design.md`. The slices that have landed on `v2/ask-user-question`:

1. **Slice 1** (`7abeaa1`) — tool rename, new schema, no aliases, free of v1 backward-compat.
2. **Slice 2** (`5d2cd70`) — TUI redesign: notes, persistent checkmarks, preview expansion, "Other" revisit, help overlay.
3. **Slice 3** (`3969d53`) — `select_many` Enter-on-option toggles only; Enter on `[Select]` commits.
4. **Slice 4** (`d719724`) — terminal title prefix (OSC 0 with 🔔), duration timer (1Hz, `.unref()`-ed), `select_many` `[Select]` button.
5. **Slice 5** (`0eb8f64`) — `is_dangerous` schema field.
6. **Slice 6** (`3156df1`) — BEL on mount (gated by `bellOnQuestion`), settings module (all 13 fields, global + project merge, in-memory test override).
7. **Slice 7** (`9ccc06b`) — `is_dangerous` TUI flow, gated by `dangerCheckEnabled`, with `reconcileMode()`.
8. **Slice 8** (`b47a70e`) — side effects wiring (notification, TTS, command, heartbeat, browser-intent log, debounce).

Still pending:

- **Settings menu UI** (slash command, submenu navigation) — touches `src/index.ts` so it can land independently.
- **Slice 9+** (browser-backed headless) — HTTP server, WebSocket, browser page, vendor cache, debounce from server. See spec §5–§7.

## Future slices

See spec §14 (out of scope for v2):

- Real auth on the HTTP server (nonce is a soft check, not security).
- Cross-device sync (localhost only).
- HTML rendering in TUI (placeholder + link today).
- Timeouts on questions.
- Persistent server across pi restarts.
- Multi-user collaboration.