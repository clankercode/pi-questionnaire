# PLAN.md — pi-questionnaire

## High-level

Build a pi-coding-agent extension that exposes a single rich, flexible
questionnaire tool — `ask_user` — supporting the full set of question styles
inspired by pag-server's questionnaire v2 contract (single_select, multi_select,
text, plus extras: confirm, number). All styles share a unified UI with
tabbed navigation, descriptions, and rich previews (markdown / mermaid / svg /
code). The tool is fully usable from the LLM and from scripts/agents, with a
headless mode for deterministic e2e tests.

## Deliverables

1. `src/` — TypeScript source:
   - `index.ts` — extension entry; registers the `ask_user` tool
   - `schema.ts` — typebox schemas + per-question validation
   - `normalize.ts` — canonical v2 question shape (input_mode, typed preview)
   - `answers.ts` — answer parsing → canonical `{"0": ..., "1": [...]}` map
   - `tui.ts` — the rich TUI component (all question types, tabbed nav)
   - `headless.ts` — env-var-driven answer loading for e2e tests
   - `types.ts` — shared TS types
2. `tests/` — Python + bash:
   - `test_schema.py` — schema validation, including pag-server compat shapes
   - `test_normalize.py` — payload normalization
   - `test_answers.py` — answer parsing & canonical map
   - `test_headless.py` — env-var headless path
   - `test_tui_render.ts` — snapshot the rendered lines for each question type
   - `test_e2e_pi.sh` — tmux + `pi --print` integration test
   - `MODEL_NOTES.md` — record which model patterns work for `--print`
   - `transcripts/` — saved e2e transcripts for replay/debug
3. `docs/` — ARCHITECTURE.md, USAGE.md
4. `package.json` — declares `pi.extensions` entry; `dependencies` for
   `@earendil-works/pi-coding-agent`, `pi-tui`, `pi-ai`, `typebox`.
5. `README.md` — install, usage, design, e2e test instructions
6. `LICENSE` — MIT
7. GitHub repo `clankercode/pi-questionnaire` (public)

## Architecture

### Question types

Inspired by pag-server v2 (`single_select`, `multi_select`, `text`) and
extended with the common gap-fillers that come up in agent UIs:

| Type          | UI                          | Output                          | Notes                                |
|---------------|-----------------------------|---------------------------------|--------------------------------------|
| `single_select` | List, arrow + Enter       | chosen option value (string)    | Up to 8 options; "Other" auto-added  |
| `multi_select`  | Checkbox list, Space toggles | array of chosen values        | Same limits                          |
| `text`          | Inline editor              | free string                    | multiline or single-line             |
| `confirm`       | Yes/No list                | `true` or `false`              | Always 2 options                     |
| `number`        | Inline editor with up/down | integer (or float)             | Honors min/max; arrow keys nudge     |

### Per-question metadata

```ts
{
  id: string,                  // unique
  header?: string,             // short tab label (max 20 chars)
  question: string,            // full prompt text
  type: 'single_select' | 'multi_select' | 'text' | 'confirm' | 'number',
  options?: Array<{            // for single/multi-select
    label: string,
    description?: string,
    preview?: { type: 'markdown'|'mermaid'|'svg'|'code', content: string }
  }>,
  default?: string | string[] | number | boolean,
  required?: boolean,          // default true
  min?: number, max?: number,  // for number
  placeholder?: string,        // for text
  multiline?: boolean,         // for text
}
```

### Canonical output shape (pag-server v2 compatible)

```ts
{
  "0": "Staging",            // single_select
  "1": ["A", "B"],            // multi_select
  "2": "free text",           // text
  "3": true,                  // confirm
  "4": 42                     // number
}
```

Plus optional per-question notes:
```ts
{ "0": "context for answer 0" }
```

### UI shell (tabbed when multi-question)

- Single question: simple option list / editor
- Multi question: tab bar (□/■ for unanswered/answered), ←/→/Tab to switch, Enter to submit on the ✓ Submit tab when all answered
- Each tab has full render: question text, options, descriptions, previews (markdown rendered as plain text for now; mermaid/svg marked as "(mermaid diagram — not rendered in v1)")
- Esc cancels the whole questionnaire; answer map is empty
- 4th question limit per single tool call (pag-server uses no hard cap; we cap at 4 here per user request)

### Headless mode (for e2e tests)

`ctx.mode !== "tui"` OR `process.env.PI_QUESTIONNAIRE_ANSWERS_FILE` is set:
- If `PI_QUESTIONNAIRE_ANSWERS_FILE` is set, read JSON `{"0": "Staging", "1": [...]}` from it; treat as if the user picked those values; skip the TUI.
- If unset and `ctx.mode !== "tui"`, return a clear error: "Error: questionnaire requires interactive mode (or set PI_QUESTIONNAIRE_ANSWERS_FILE=<path>)".
- This makes tmux + `pi --print` deterministic.

### Lifecycle states (mirrors pag-server adapter contract)

- `requested` — tool execution starts
- `answered` — all required questions answered
- `cancelled` — user pressed Esc
- `timed_out` — (future: if timeout is added)
- `rejected` — invalid input attempted (e.g. out-of-range number); re-asks

## Acceptance criteria

- [ ] `ask_user` tool registered; `--print pi -e ./src/index.ts` loads it
- [ ] All 5 question types render in TUI and produce correct canonical output
- [ ] Tabs work for multi-question; submit tab enforces all-answered
- [ ] Headless mode (`PI_QUESTIONNAIRE_ANSWERS_FILE=...`) skips TUI and returns the file's answer map
- [ ] `pytest tests/` passes (schema, normalize, answers, headless, edge cases)
- [ ] `node --test` passes (TUI render snapshots)
- [ ] `bash tests/test_e2e_pi.sh` runs `pi --print` end-to-end with a real
      model, captures transcript, asserts answer map matches expected
- [ ] Public repo `clankercode/pi-questionnaire` exists with README/LICENSE
- [ ] Clean `git log` with regular commits
- [ ] Backward compat: pag-server v1 question shape (`{ question, options: [{label}] }`) is also accepted

## Out of scope (v1)

- Real mermaid/svg rendering (we just mark them as "preview attached")
- Cross-process synchronization for in-flight questionnaires (sessions are local)
- Timeouts (could be added later)
- A standalone HTTP service to receive answers (pag-server does this; for pi it's local)

## Open questions

- Which model string works reliably for `pi --print --model <m>` headless? → record in tests/MODEL_NOTES.md
- Should we ship a `parse_answers.ts` for agents that want to read session tool-result `details` back as canonical answers? → yes, expose as helper

## Reviewer prompts

- **Correctness critic**: check schema validation, normalization, answer parsing for pag-server compat
- **Goal-fit critic**: did we cover single_select, multi_select, text, confirm, number? Rich = previews + descriptions
- **Edge-case critic**: out-of-range numbers, empty options, "Other" with empty text, multiline, unicode, large option lists (8 limit), 4-question cap
- **Integration critic**: do the schema, normalize, tui, and headless paths all agree on canonical output?
