# Release Notes — v2.0.0

`pi-questionnaire` v2.0.0 is the `AskUserQuestion` release: a Claude Code-compatible, interactive questionnaire tool for pi with a new schema, richer TUI, configurable side effects, and optional local browser sync.

## What's new

### Claude Code-compatible tool name

The public tool is now `AskUserQuestion`. It accepts 1–4 questions and returns a canonical answer map keyed by stringified question index:

```json
{
  "0": { "mode": "option", "value": "staging" },
  "1": [ { "mode": "option", "value": "lint" } ]
}
```

### New question model

v2 has five explicit question types:

- `select_one` — one option, or `Other` text.
- `select_many` — zero or more options, committed with `[Select]`.
- `confirm_enum` — `Affirm` / `Decline` / `Other`; omitted options auto-fill to `Affirm` and `Decline`.
- `number` — numeric input with optional `min` / `max`.
- `free_text` — multiline text by default.

Choice questions auto-append `Other`. User options are capped at seven so the rendered list stays at eight options total.

### Richer TUI

The terminal UI now includes:

- Per-question notes returned alongside answers.
- Persistent answered indicators/checkmarks while moving between tabs.
- Revisit support for `Other` answers.
- Rich option previews (`markdown`, `code`, `text`, `mermaid`, `svg`, `html`).
- Help overlay and broader keyboard navigation.
- Visual frame around the questionnaire.
- `🔔` terminal-title prefix and live `⏱` elapsed-time status.
- Explicit `[Select]` button for multi-select commit.

### Dangerous action confirmation

Questions can set `is_dangerous: true` for destructive confirmation prompts. When `dangerCheckEnabled` is on, the TUI replaces the normal answer widget with a warning and requires non-empty typed confirmation before the answer is accepted. In v2.0.0, use this primarily for confirmation/free-text prompts because the danger path records the typed confirmation text.

### Settings and side effects

v2 includes a 13-field settings system with global + project merge, live reads on each tool call, and `/settings-ask-user-question` for interactive editing.

Settings can enable or tune browser sync, auto-open, clipboard copy, bell, desktop notifications, `attn` TTS, a custom command, heartbeat keepalives, input debounce, and danger checks.

### Browser sync

When enabled, v2 starts a per-questionnaire HTTP + WebSocket server on `127.0.0.1` for local browser access:

```text
http://127.0.0.1:<port>/q/<batch-id>?nonce=<random>
```

The browser and TUI share answers, notes, tab focus, submit/cancel lifecycle, and reconnect snapshots. Previews render in both surfaces, but each surface tracks its own preview expansion state.

## Breaking changes

v2 is a clean break from v1. There is no silent compatibility shim.

| v1 | v2 |
| --- | --- |
| Tool name `ask_user` | Tool name `AskUserQuestion` |
| `type: "single_select"` | `type: "select_one"` |
| `type: "multi_select"` | `type: "select_many"` |
| `type: "confirm"` | `type: "confirm_enum"` |
| `type: "text"` | `type: "free_text"` |
| `multi_select: true` | `type: "select_many"` |
| `input_mode` | `type` |
| `prompt` | `question` |
| `required` | removed; every question is required |
| option `markdown` | `preview: { "type": "markdown", "content": "..." }` |
| v1 answer-file headless mode | removed from v2; browser sync is interactive and TUI-attached |
| timeout lifecycle | removed; v2 reports answered/cancelled/rejected |

Legacy type names are rejected with explicit migration guidance. Other v1-only fields such as `prompt`, `required`, and option `markdown` are unsupported in v2 payloads; update them even if an extra-property-tolerant runtime path ignores them.

## Migration guide from v1

### Single choice

v1 `ask_user` payload:

```json
{
  "questions": [{
    "id": "env",
    "prompt": "Which environment should we deploy to?",
    "type": "single_select",
    "required": true,
    "options": [
      { "label": "staging", "markdown": "Validate safely first." },
      { "label": "production", "markdown": "Ship to users." }
    ]
  }]
}
```

v2 `AskUserQuestion` payload:

```json
{
  "questions": [{
    "id": "env",
    "header": "Env",
    "question": "Which environment should we deploy to?",
    "type": "select_one",
    "options": [
      {
        "label": "staging",
        "preview": { "type": "markdown", "content": "Validate safely first." }
      },
      {
        "label": "production",
        "preview": { "type": "markdown", "content": "Ship to users." }
      }
    ]
  }]
}
```

Expected answer shape:

```json
{ "0": { "mode": "option", "value": "staging" } }
```

### Multi-select

v1:

```json
{
  "questions": [{
    "id": "checks",
    "prompt": "Which checks should run?",
    "type": "multi_select",
    "options": [
      { "label": "lint" },
      { "label": "unit tests" },
      { "label": "typecheck" }
    ]
  }]
}
```

v2:

```json
{
  "questions": [{
    "id": "checks",
    "header": "Checks",
    "question": "Which checks should run?",
    "type": "select_many",
    "options": [
      { "label": "lint" },
      { "label": "unit tests" },
      { "label": "typecheck" }
    ]
  }]
}
```

Expected answer shape:

```json
{
  "0": [
    { "mode": "option", "value": "lint" },
    { "mode": "option", "value": "typecheck" }
  ]
}
```

### Confirmation, numbers, and text

- Convert yes/no confirmations to `type: "confirm_enum"`; omit `options` for default `Affirm` / `Decline`.
- Keep numeric questions as `type: "number"`, with optional `min`, `max`, and numeric `default`.
- Convert `type: "text"` to `type: "free_text"`; multiline input is the default.
- Add a short `header` for every question. Keep the full prompt in `question`.

## Settings

Settings are loaded from global and project files and merged as:

```text
DEFAULT_SETTINGS < <agentDir>/ask-user-question.json < <cwd>/.pi/ask-user-question.json
```

The project file is written by `/settings-ask-user-question`. Settings are read live on every `AskUserQuestion` call.

| Setting | Default | What it does |
| --- | ---: | --- |
| `browserEnabled` | `true` | Starts the local browser sync server when the questionnaire meets the threshold. |
| `browserAutoOpen` | `false` | Opens the browser page automatically when the server starts and the question count is high enough. |
| `browserMinQuestions` | `2` | Minimum question count for browser startup/auto-open behavior; valid range 1–4. |
| `copyUrlToClipboard` | `true` | Copies the generated browser URL to the clipboard when possible. |
| `bellOnQuestion` | `true` | Emits terminal BEL when the questionnaire mounts. |
| `notificationOnQuestion` | `false` | Sends a desktop notification on mount. |
| `notificationDelaySeconds` | `30` | Delay before desktop notification; `0` means immediate. |
| `ttsOnQuestion` | `false` | Runs `attn "AskUserQuestion: <header>"` on mount. |
| `onQuestionCommand` | `""` | Runs a shell command on mount with payload JSON path in `PI_QUESTIONNAIRE_PAYLOAD_FILE`. |
| `heartbeatWhileActive` | `false` | Sends follow-up heartbeat messages while the TUI is active. |
| `heartbeatIntervalMinutes` | `4.5` | Heartbeat interval; valid range 0.5–60 minutes. |
| `debounceMs` | `300` | Debounce value reported for text/number input behavior. |
| `dangerCheckEnabled` | `true` | Enforces typed confirmation for `is_dangerous` questions. |

## Browser sync

Browser sync is local-only and attached to an active TUI questionnaire.

1. Ensure `browserEnabled` is `true`.
2. Ask at least `browserMinQuestions` questions in one `AskUserQuestion` call, or lower `browserMinQuestions` to `1`.
3. Use the URL shown in the TUI status area, press `o` to open it, enable `browserAutoOpen`, or use the copied URL if clipboard support is available.
4. Answer in either the TUI or browser. Changes sync over WebSocket.
5. Submit or cancel from either side. The lifecycle is broadcast so reconnecting/late browser tabs see the terminal state.

Implementation details:

- The server binds only to `127.0.0.1`.
- The default sticky port is `54321`, with fallback to `54322` if the first is busy.
- The questionnaire page is `/q/<batch-id>?nonce=<random>`.
- WebSocket clients connect to `/ws?batch=<batch-id>&nonce=<random>`.
- The nonce is a local accidental-access guard, not a full authentication system.
- The server is per-call and stops when the TUI settles.

## Known issues and deferred items

- Browser sync is not a non-interactive/headless replacement yet; `AskUserQuestion` still requires TUI mode.
- Browser sync is local-only. Cross-device sync and multi-user collaboration are out of scope for v2.0.0.
- The browser nonce is not a security boundary; do not expose the server beyond loopback.
- The browser server is per-questionnaire, not persistent across pi restarts.
- No question timeout lifecycle is included in v2.0.0.
- Browser preview rendering is intentionally lightweight; markdown is basic, code is raw, and mermaid remains text-like rather than a full diagram renderer.
- `is_dangerous` currently records typed confirmation text; avoid combining it with choice/number prompts when you need the normal typed answer shape.
- Clipboard copy depends on platform tools such as `pbcopy`, `clip`, or `xclip`; missing tools are logged and do not block the questionnaire.

## Verification

The v2 work is covered by schema, normalization, answer coercion, settings, side-effect, TUI render, settings-menu, and browser-server tests. For this release, `npx tsc --noEmit`, `node --test tests/test_tui_render.mjs tests/test_browser_server.mjs` (84 tests), and `python3 -m pytest tests/ -q` (127 tests) passed before publishing.
