# Architecture

## High-level

`pi-questionnaire` is a single-file pi extension (well, a small package) that
registers one tool: `ask_user`. The tool's job is to ask the user one or more
questions (max 4 per call) and return a canonical structured answer.

```
src/
  index.ts          → registerTool({ name: "ask_user", ... })
  schema.ts         → typebox params + semantic validation
  normalize.ts      → raw question → canonical v2 question
  answers.ts        → raw answer payload → canonical answer map
  tui.ts            → rich tabbed TUI (all 5 question types)
  headless.ts       → env-var answer loader (for e2e / scripts)
  types.ts          → shared types
```

## Why a single tool?

- The model needs one decision point: "should I ask the user for input?" If
  we split it into 5 tools (`ask_single`, `ask_multi`, `ask_text`, ...), the
  model has to choose the right tool AND the right schema. One tool with
  `type` discrimination is simpler.
- It also matches the pag-server v2 contract, where one MCP tool handles
  all question types.

## Question types

The 5 types are grouped by what they do:

- **Selection**: `single_select`, `multi_select`, `confirm` — the user picks
  from a list. `confirm` is a special case of `single_select` with exactly
  2 options (Yes/No).
- **Free input**: `text` — any string. Can be `multiline: true`.
- **Numeric**: `number` — integer (or float) with optional `min` / `max`.

This covers ~99% of agent UIs. For truly weird widgets (date pickers, color
pickers), `text` is the fallback.

## Canonical output shape (pag-server v2 compatible)

```ts
{
  "0": "Staging",        // single_select
  "1": ["A", "B"],       // multi_select
  "2": "free text",      // text
  "3": true,             // confirm
  "4": 42                // number
}
```

Plus optional per-question notes (pag-server v2 compat):

```ts
{
  "answers": { ... },
  "notes":   { "0": "context for 0" }
}
```

We accept the full pag-server input envelope shapes (flat map, `answers`
envelope, `question_response` envelope, per-question `{selected, other}`
nested) so any pag-server agent can talk to pi-questionnaire unmodified.

## Lifecycle (mirrors pag-server adapter contract)

```
tool_call starts            → lifecycle: "requested"
user answers all required   → lifecycle: "answered"
user presses Esc            → lifecycle: "cancelled"
timeout (future)            → lifecycle: "timed_out"
invalid input attempted     → lifecycle: "rejected" + re-ask
```

The `details.lifecycle` field in the tool result exposes this so downstream
code (sessions, mail adapters, etc.) can pattern-match on the outcome.

## Headless mode

The same tool is used for interactive and headless operation. The switch is
`PI_QUESTIONNAIRE_ANSWERS_FILE`:

- **Unset** (interactive): tool uses `ctx.ui.custom()` to show the TUI.
- **Set, file readable, answers valid**: tool skips the TUI and returns
  the file's answers as if the user picked them.
- **Set, file missing or invalid**: tool returns an error (NOT cancellation),
  so the LLM can retry or fall back.

This single-path design avoids a parallel "test mode" implementation that
drifts from the real one.

## TUI design

Inspired by the `questionnaire.ts` example in the pi extension examples,
extended for our 5 question types:

- **Single question**: simple options list / editor, no tab bar.
- **Multi question**: tab bar at the top with one tab per question + a
  `✓ Submit` tab. Each tab shows its question; switching tabs preserves
  state (selected options, partial text).
- **Submit tab**: appears when there are multiple questions. Shows a
  summary of all answers and rejects submission if any required question
  is unanswered.
- **Submit bar**: 4 characters for nav (← tabs →), ↑↓ for option nav,
  Space to toggle (multi_select), Enter to confirm, Esc to cancel.

Previews are rendered as the option's indented body. For `mermaid` /
`svg` previews we print `[mermaid]` / `[svg]` and the content as-is (v1
doesn't render them as images). For `markdown` and `code` we show the
text and let the terminal color it via the theme.

## Backward compatibility

The tool accepts all three pag-server question shapes:

```jsonc
// v1 (legacy)
{ "question": "q?", "options": [...], "multi_select": true }

// v2 (canonical)
{ "question": "q?", "input_mode": "multi_select", "header": "x",
  "options": [{ "label": "...", "description": "...", "preview": {...} }] }

// our richer shape
{ "id": "x", "question": "q?", "type": "text", "header": "x",
  "default": "hello", "required": true }
```

`resolveType()` is the single point that maps all three to the canonical
`QuestionType` enum.

## Why max 4 questions?

The user asked for it explicitly. It also matches typical agent UIs
(Claude Code, opencode, pag-server) and keeps the TUI short enough to
read at a glance. For longer forms, call `ask_user` multiple times —
each call is a separate turn for the user.

## Module boundaries

- `schema.ts` is the only module that imports `typebox`. Other modules
  import types from `types.ts`.
- `normalize.ts` is the only module that calls `resolveType`. Tests can
  target normalization without touching the schema validation.
- `answers.ts` is pure (no I/O). It accepts any pag-server shape and
  produces a canonical answer map. `validateAgainstQuestions()` is
  optional validation that the headless path uses.
- `tui.ts` is the only module that imports from `@earendil-works/pi-tui`.
  The rest of the package is portable (could run in a web UI, server
  adapter, etc.).
- `headless.ts` is the only module that reads from disk. Tool flow:
  `headless → answers → result`; `tui → answers → result`. Same
  downstream.
- `index.ts` is the only module that calls `pi.registerTool()`. It
  wires schema, normalize, headless, tui together.

This shape makes it easy to swap any layer (e.g. replace the TUI with a
web UI, replace the headless loader with an HTTP endpoint) without
touching the rest.

## Testing strategy

Three layers:

1. **Unit** (Python pytest, 47 cases): schema, normalize, answers, headless.
   Drives the real TypeScript via a `harness.ts` CLI over stdin/stdout.
   No mocks — the test target is the production code.
2. **Render** (node --test, 9 cases): TUI render snapshots. Runs the
   component factory with a fake tui/theme, asserts key substrings in
   the rendered lines for each question type.
3. **E2E** (bash + pi --print, 4 scenarios): runs `pi --print` with the
   extension loaded and `PI_QUESTIONNAIRE_ANSWERS_FILE` set. Asserts
   that the model — which can only have received the answer via the
   tool — reports it back in a strict format.

Why this shape:

- Unit tests are fast (sub-second per case, parallelizable).
- Render tests catch UI regressions without needing a real terminal.
- E2E tests prove the tool works in the real pi environment. The model
  is non-deterministic but we mitigate by using a strict output format
  (e.g. `PICKED:<value>`) that we can grep for.

The e2e is the only test that exercises the real network call to the
LLM, so it's the most expensive (~30s per scenario). Unit + render tests
are pure local computation.
