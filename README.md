# pi-questionnaire

Rich, flexible questionnaire tool for the [pi](https://github.com/earendil-works/pi-mono) coding agent.

`ask_user` is a single tool that supports five question types — `single_select`, `multi_select`, `text`, `confirm`, and `number` — with rich option previews (markdown / mermaid / svg / code), per-question descriptions, defaults, and a tabbed UI for multi-question forms. The output is a canonical answer map (`{"0": "Staging", "1": ["A", "B"], ...}`) compatible with the [pag-server v2 questionnaire contract](https://github.com/clankercode/pag-server).

## Install

```bash
# from the pi-questionnaire repo
pi install .
```

This will:

1. Symlink `src/index.ts` into your global `~/.pi/agent/extensions/`
2. Install npm dependencies via pnpm

Restart pi (or `/reload`) to pick up the new extension.

### Manual install (without `pi install`)

```bash
pnpm install
# then add to ~/.pi/agent/settings.json → extensions:
#   /absolute/path/to/pi-questionnarie/src/index.ts
```

## Usage

Ask the LLM to use the `ask_user` tool. For example:

> "Use the ask_user tool to ask me which environment to deploy to. Give me options: staging, production, or canary. Then deploy to whichever I pick."

The model will call:

```json
{
  "questions": [{
    "id": "env",
    "header": "Env",
    "question": "Which environment should we deploy to?",
    "type": "single_select",
    "options": [
      { "label": "staging", "description": "Validate safely" },
      { "label": "production", "description": "Ship it" },
      { "label": "canary", "description": "1% of traffic" }
    ]
  }]
}
```

The user picks from the TUI (or the answers come from `PI_QUESTIONNAIRE_ANSWERS_FILE` in headless mode — see below), and the model receives a structured result.

### Question types

| Type            | UI                                | Output value     | Notes                              |
|-----------------|-----------------------------------|------------------|------------------------------------|
| `single_select` | list, ↑↓ + Enter                  | chosen label     | up to 8 options; "Other" auto-added |
| `multi_select`  | checkbox list, Space to toggle    | array of labels  | up to 8 options                    |
| `text`          | inline editor                     | string           | single-line or multiline           |
| `confirm`       | Yes / No                          | boolean          | always 2 options                   |
| `number`        | inline editor with ↑↓ nudging     | number           | honors min / max                   |

### Rich previews

Each option can carry a `preview` for code samples, diagrams, or specs:

```json
{
  "label": "Streaming",
  "description": "Server-sent events",
  "preview": {
    "type": "mermaid",
    "content": "sequenceDiagram\n  C->>S: GET /events\n  S-->>C: data: {...}"
  }
}
```

Supported preview types: `markdown`, `mermaid`, `svg`, `code`. (v1: previews are rendered as plain text; mermaid/svg marked as "[mermaid]" in the TUI.)

### Max 4 questions per call

Each `ask_user` invocation accepts 1 to 4 questions. For longer forms, break them into multiple `ask_user` calls.

### pag-server v1 / v2 compatibility

The tool accepts the older pag-server shapes too:

```json
// v1: { question, options, multi_select: true }
{ "question": "Pick toppings?", "options": [...], "multi_select": true }

// v2: { question, input_mode, options, header }
{ "question": "Where?", "input_mode": "single_select", "header": "Where", "options": [...] }
```

## Headless mode (for scripts & e2e)

Set `PI_QUESTIONNAIRE_ANSWERS_FILE=/path/to/answers.json` and the tool will skip the TUI and load the canonical answer map from that file. This makes the tool fully scriptable for CI / e2e tests.

```json
{
  "0": "Staging",
  "1": ["A", "B"],
  "2": "free text",
  "3": true,
  "4": 42
}
```

Supported envelope shapes: the canonical flat map, pag-server's `{answers, notes}` envelope, and pag-server's `{question_response: {answers}}` envelope. Per-question `{selected, other}` nested shapes are also accepted.

If the file is missing, unreadable, or contains invalid answers, the tool returns an error (not cancellation) so the LLM can recover.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design rationale and module breakdown. See [docs/USAGE.md](docs/USAGE.md) for richer examples.

## Development

### Tests

```bash
# Python unit tests (47 cases for schema, normalize, answers, headless)
pnpm test:py

# TUI render snapshots (9 cases via node --test)
npx tsx --test tests/test_tui_render.mjs

# Full e2e (6 scenarios via tmux + pi --print, ~5 min)
bash tests/test_e2e_pi.sh

# All of the above
pnpm test:all
```

The e2e script uses `minimax/MiniMax-M2.7-highspeed` by default. Override with `PROVIDER=...` and `MODEL=...` env vars. See [tests/MODEL_NOTES.md](tests/MODEL_NOTES.md) for what works.

### Repo layout

```
src/
  index.ts          # extension entry; registers ask_user
  schema.ts         # typebox schemas + semantic validation
  normalize.ts      # canonical v2 question normalization
  answers.ts        # answer parsing + validation
  tui.ts            # rich tabbed TUI component (all 5 types)
  headless.ts       # env-var-driven answer loading
  types.ts          # shared types
tests/
  harness.ts        # TS CLI that the pytest suite drives
  conftest.py       # pytest fixtures
  test_schema.py    # 10 cases
  test_normalize.py # 11 cases
  test_answers.py   # 18 cases
  test_headless.py  # 8 cases
  test_tui_render.mjs  # 15 cases
  test_e2e_pi.sh    # 6 e2e scenarios via pi --print
  MODEL_NOTES.md    # which models work for e2e
docs/
  ARCHITECTURE.md
  USAGE.md
PLAN.md             # original plan
pirfl-log.md        # PIRFL work log
```

## License

MIT — see [LICENSE](LICENSE).
