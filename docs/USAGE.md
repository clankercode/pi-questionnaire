# Usage

## Tool schema

The full `AskUserQuestion` parameters, expressed as a TypeBox schema (see `src/schema.ts`):

```typescript
const QuestionOption = {
  label: string,                 // required, 1–200 chars
  description?: string,          // optional, max 2000 chars
  preview?: {                    // optional rich preview
    type: "markdown" | "code" | "text" | "mermaid" | "svg" | "html",
    content: string,             // required
  },
};

const Question = {
  id?: string,                   // optional, 1–64 chars (auto-assigned if omitted)
  header: string,                // required, 1–20 chars (short tab label)
  question: string,              // required, 1–4000 chars
  description?: string,          // optional, max 4000 chars
  type: "select_one" | "select_many" | "confirm_enum" | "number" | "free_text",
  options?: QuestionOption[],    // required for select_*, optional for confirm_enum (auto-filled), REJECTED for number/free_text
  default?: string | string[] | number,  // optional; type-dependent
  min?: number,                  // number only
  max?: number,                  // number only
  placeholder?: string,          // free_text only, max 200 chars
  multiline?: boolean,           // free_text only; defaults to true
  is_dangerous?: boolean,        // all types; gates typed-confirmation flow
};

const AskUserQuestionParams = {
  questions: Question[],         // 1 to 4
};
```

Top-level constraints:

- **1 to 4 questions per call.** Break longer forms into multiple `AskUserQuestion` calls.
- **Header** is a short tab label (1–20 chars). The full prompt lives in `question`.
- **Duplicate `id` values are rejected** with a clear error.
- **`required` is gone** — every question is always required.

## The 5 question types

### `select_one`

Single-choice list. 2–7 user options + auto `Other` = 8 max.

```json
{
  "questions": [{
    "header": "Env",
    "question": "Which environment?",
    "type": "select_one",
    "options": [
      { "label": "staging",    "description": "Validate safely" },
      { "label": "production", "description": "Ship it" },
      { "label": "canary",     "description": "1% of traffic" }
    ]
  }]
}
```

Result:

```json
{ "0": { "mode": "option", "value": "staging" } }
```

If the user picks `Other`:

```json
{ "0": { "mode": "other", "text": "rollback" } }
```

### `select_many`

Multi-choice with checkboxes. Space to toggle, Enter on the highlighted `[Select]` button to commit the array.

```json
{
  "questions": [{
    "header": "Toppings",
    "question": "Pick your toppings",
    "type": "select_many",
    "options": [
      { "label": "mushrooms" },
      { "label": "pepperoni" },
      { "label": "olives" },
      { "label": "pineapple" }
    ]
  }]
}
```

Result:

```json
{ "0": [
  { "mode": "option", "value": "mushrooms" },
  { "mode": "option", "value": "olives" }
] }
```

Each entry is either `{mode:"option",value}` or `{mode:"other",text}`.

### `confirm_enum`

Yes/No/Other. If `options` is omitted, normalizes to `[{label:"Affirm"},{label:"Decline"}]` plus auto `Other`.

```json
{
  "questions": [{
    "header": "Confirm",
    "question": "Drop the prod database?",
    "type": "confirm_enum",
    "is_dangerous": true
  }]
}
```

Result:

```json
{ "0": { "mode": "option", "value": "affirm" } }
```

Semantic values are `"affirm"` / `"decline"` (or `"other"` with text) — the UI labels remain human-readable.

### `number`

Integer (or float) with optional `min` / `max`. Up/Down in the editor nudge by 1.

```json
{
  "questions": [{
    "header": "Replicas",
    "question": "How many replicas?",
    "type": "number",
    "min": 1,
    "max": 100,
    "default": 3
  }]
}
```

Result:

```json
{ "0": 3 }
```

Constraints:

- `min ≤ max` (rejected at validation time if not).
- Out-of-range input is rejected silently — the editor stays in input mode until a valid number is entered.
- `default` must be a finite number.

### `free_text`

Always multiline. `Shift+Enter` for a newline; `Enter` to submit. `multiline` defaults to `true` (set to `false` for a single-line free_text, though multiline is recommended).

```json
{
  "questions": [{
    "header": "Feedback",
    "question": "Any other notes?",
    "type": "free_text",
    "placeholder": "context, blockers, surprises…"
  }]
}
```

Result:

```json
{ "0": "The build was slow on the first try." }
```

The editor expands to fit the content; previous text is preloaded when revisiting a question.

## Previews

Each option can carry a `preview` to show code, diagrams, or formatted specs alongside the label. All five preview types are rendered uniformly in the TUI today: the type-specific renderer (highlight.js for `code`, marked for `markdown`, mermaid-ascii / hand-rolled box-drawing for `mermaid`, sanitized SVG for `svg`, sandboxed iframe for `html`) lands with the browser path in a later slice.

Press `e` on a highlighted option to toggle preview expansion:

- **Collapsed** — `[<type>] (press e to expand)` under the option description.
- **Expanded** — the content is shown in a box-drawing frame: `┌─ <type> ─` / `│ <content>` / `└────`. The content is the raw preview string, word-wrapped to the terminal width.

Example:

```json
{
  "header": "Auth",
  "question": "Which auth strategy?",
  "type": "select_one",
  "options": [{
    "label": "OAuth2",
    "description": "Delegated auth",
    "preview": {
      "type": "mermaid",
      "content": "sequenceDiagram\n  U->>A: /login\n  A->>P: redirect\n  P-->>A: code\n  A-->>U: token"
    }
  }]
}
```

## The "Other" option

Every choice-based question (`select_one`, `select_many`, `confirm_enum`) gets a synthetic **Other** option auto-appended during normalization. Picking it opens a free-text editor. On revisit, the editor is **preloaded with the previous Other text** so the user can edit or replace it without retyping.

Implementation notes:

- User-provided options are capped at **7** (the 8th slot is reserved for Other).
- The Other option is identified by a case-insensitive label match (`other`, `Other`, `OTHER` all collapse to the same slot), so a user-supplied `Other` option doesn't create a duplicate.
- Other is never counted against user uniqueness checks.

## `is_dangerous` confirmation

Mark a question as destructive:

```json
{
  "header": "Wipe DB",
  "question": "Drop the prod database?",
  "type": "confirm_enum",
  "is_dangerous": true
}
```

When `is_dangerous` is `true` **and** the `dangerCheckEnabled` setting is `true`, the TUI:

1. Renders a `⚠️  DESTRUCTIVE — <header>` warning header in place of the normal question header.
2. Skips the type-specific UI (options, etc.) and shows a typed-confirmation prompt: `Type the resource name to confirm:`
3. Opens the editor in `danger` mode — Up/Down are suppressed (so the editor's history cursor doesn't move behind the user).
4. Accepts the answer **only if the user types a non-empty string** and presses Enter. Empty / whitespace-only commits are rejected silently — the editor stays open.
5. Treats `Esc` as cancelling the whole questionnaire (no "back out of the editor but stay on the question" path).
6. Hides the Submit tab while a danger question is active, so the user can't skip past the confirmation by jumping tabs.

The previous answer is **prefilled in the editor** on revisit, so re-acknowledging a danger flow doesn't require retyping from scratch (the user can leave it as-is to confirm, or edit it).

`dangerCheckEnabled` is a per-user safety toggle. Disable it in trusted environments (CI, scripted batch sessions) to skip the typed-confirmation prompt and accept the answer immediately.

## Notes per question

Press `Tab` (or `n`) on the current question to swap to a notes editor. Notes are independent of the answer — you can attach a note to an answered question, a danger confirmation, or a `free_text` you haven't submitted yet.

Notes editor behavior:

- `Enter` saves the notes and **stays in notes view** (you stay in the editor).
- `Tab` again swaps back to the answer view.
- `Esc` discards the current edit (notes are saved on Enter, not on Esc).

On submit, notes flow back to the model alongside the answers:

```json
{
  "answers": { "0": { "mode": "option", "value": "staging" } },
  "notes":   { "0": "Checked with SRE first." }
}
```

## Settings reference

All 13 settings fields, with defaults from `src/settings.ts`:

| Field                       | Type      | Default | Range / shape        | Description                                                                                  |
|-----------------------------|-----------|---------|----------------------|----------------------------------------------------------------------------------------------|
| `browserEnabled`            | boolean   | `true`  | —                    | Start the browser HTTP server alongside the TUI *(slice 5+)*                                 |
| `browserAutoOpen`           | boolean   | `false` | —                    | Auto-open the browser when ≥ `browserMinQuestions`                                           |
| `browserMinQuestions`       | integer   | `2`     | 1–4                  | Threshold for auto-open (capped at the tool's max 4 questions/call)                          |
| `copyUrlToClipboard`        | boolean   | `true`  | —                    | Copy the URL to the clipboard when generated                                                 |
| `bellOnQuestion`            | boolean   | `true`  | —                    | Audible BEL (`\x07`) on mount                                                                |
| `notificationOnQuestion`    | boolean   | `false` | —                    | Desktop notification on mount (`notify-send` / `osascript` / `msg`)                          |
| `notificationDelaySeconds`  | integer   | `30`    | 0–300                | Delay before notification fires (`0` = immediate)                                            |
| `ttsOnQuestion`             | boolean   | `false` | —                    | Speak the header via `attn` on mount                                                         |
| `onQuestionCommand`         | string    | `""`    | shell command        | Command to run on mount. Payload JSON is written to a tmp file; path is in `PI_QUESTIONNAIRE_PAYLOAD_FILE` env var. |
| `heartbeatWhileActive`      | boolean   | `false` | —                    | Send a keepalive heartbeat (via `pi.sendMessage`, `deliverAs:"followUp"`) while the TUI is on screen |
| `heartbeatIntervalMinutes`  | number    | `4.5`   | 0.5–60               | Idle interval in minutes (matches pi's default 4.5m heartbeat)                               |
| `debounceMs`                | integer   | `300`   | 0–10 000             | Debounce (ms) when typing into number/free_text inputs                                       |
| `dangerCheckEnabled`        | boolean   | `true`  | —                    | Enforce the `is_dangerous` typed-confirmation flow in the TUI                                |

Settings are read live on every `execute()` call, so editing the JSON file and re-asking takes effect immediately (no pi restart needed).

### Settings storage

Two locations, project overrides global:

| Scope    | Path                                       | Written by                                       |
|----------|--------------------------------------------|--------------------------------------------------|
| Global   | `<agentDir>/ask-user-question.json`        | You (hand-edit)                                  |
| Project  | `<cwd>/.pi/ask-user-question.json`         | The settings menu (when it lands); never by the extension directly |

The merge order is `DEFAULT_SETTINGS < global < project`. Within a scope, unknown keys are dropped and fields with the wrong shape (or out-of-range) are dropped silently — `getSettings()` always returns the fully-resolved view with every field populated.

`<agentDir>` is the directory returned by `getAgentDir()` from `@earendil-works/pi-coding-agent` — typically `~/.pi/agent/` on a single-user install.

### Settings menu

The settings menu is available via the menu command in pi. The slash name will land with the menu UI in a separate slice. Until then, hand-edit the JSON files (or use the in-memory `setInMemorySettings()` hook from a test fixture).

## Behavior flags / TUI signals

These are observable side effects of the TUI mount, all gated by settings:

| Signal                          | Gated by                  | What you see                                                                |
|---------------------------------|---------------------------|-----------------------------------------------------------------------------|
| **Terminal title** prefix       | always on                 | `🔔 AskUserQuestion — <header>` via OSC 0; cleared on submit/cancel         |
| **Duration timer**              | always on                 | `⏱  <elapsed> elapsed` in the status line; updates once per second          |
| **Audible BEL** on mount        | `bellOnQuestion`          | Terminal bell (`\x07`) at mount                                             |
| **Desktop notification**        | `notificationOnQuestion`  | `notify-send` (Linux) / `osascript` (macOS) / `msg` (Windows) on mount      |
| **TTS**                         | `ttsOnQuestion`           | Spawns `attn "AskUserQuestion: <header>"`                                   |
| **Custom command**              | `onQuestionCommand`       | Spawns the command; payload JSON at `PI_QUESTIONNAIRE_PAYLOAD_FILE`         |
| **Idle heartbeat**              | `heartbeatWhileActive`    | `pi.sendMessage` with `customType:"ask-user-question-heartbeat"` every `heartbeatIntervalMinutes` |
| **Debounce**                    | `debounceMs`              | Coalesces rapid keystrokes; the active value is included in the result details |

All side-effect spawns are wrapped in try/catch — the TUI shows even if every side effect fails. Timers are `.unref()`-ed so they never keep Node alive after the questionnaire settles.

## Migration from v1

The v2 surface is a clean break from v1. There is **no silent compatibility shim** — v1 payloads fail schema validation with explicit field/type guidance.

| v1 (gone)                                  | v2 (use this)                                                                |
|--------------------------------------------|------------------------------------------------------------------------------|
| Tool name `ask_user`                       | Tool name `AskUserQuestion`                                                  |
| `type: "single_select"`                    | `type: "select_one"`                                                         |
| `type: "multi_select"`                     | `type: "select_many"`                                                        |
| `type: "confirm"`                          | `type: "confirm_enum"`                                                       |
| `type: "text"`                             | `type: "free_text"`                                                          |
| `type: "number"`                           | `type: "number"` (unchanged)                                                 |
| `multi_select: true` on a question         | `type: "select_many"`                                                        |
| `input_mode: "..."`                        | `type: "..."`                                                                |
| `prompt: "..."`                            | `question: "..."`                                                            |
| `required: true` / `required: false`        | (field removed; questions are always required)                               |
| `markdown: "..."` on an option             | `preview: { type: "markdown", content: "..." }`                              |
| `PI_QUESTIONNAIRE_ANSWERS_FILE` headless   | (removed; the browser-backed headless path lands in slice 5+)                |
| `lifecycle: "timed_out"`                   | (removed; no timeouts in v2)                                                 |
| `details.lifecycle: "answered"` semantics  | Same; new `debounceMs` field added to the result details                     |

A v1 payload sent to `AskUserQuestion` returns an error like:

```
Question 0: type 'multi_select' renamed to 'select_many'.
Question 1: 'required' field removed; questions are always required.
Question 2 option 0: 'markdown' field removed; use 'preview: {type:"markdown", content: ...}'.
```

(`detectLegacyFields()` in `src/schema.ts` produces these messages for tests and documentation.)