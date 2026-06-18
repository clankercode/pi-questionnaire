# Usage examples

## Basic single question

```
You: "Use ask_user to ask me which cloud to use."
```

The model will call:
```json
{
  "questions": [{
    "id": "cloud",
    "header": "Cloud",
    "question": "Which cloud provider should we use?",
    "type": "single_select",
    "options": [
      { "label": "AWS", "description": "Industry standard" },
      { "label": "GCP", "description": "Best for data/ML" },
      { "label": "Azure", "description": "Best for enterprise" }
    ]
  }]
}
```

The user picks one in the TUI. The tool returns:
```json
{
  "0": "AWS"
}
```

The model now has the answer and continues.

## Multi-question batch (up to 4)

```
You: "Use ask_user to confirm a few deployment details at once."
```

```json
{
  "questions": [
    {
      "id": "env",
      "header": "Env",
      "question": "Target environment?",
      "type": "single_select",
      "options": [
        { "label": "staging" },
        { "label": "production" },
        { "label": "canary" }
      ]
    },
    {
      "id": "version",
      "header": "Version",
      "question": "Which version to deploy?",
      "type": "text",
      "placeholder": "e.g. v1.2.3"
    },
    {
      "id": "replicas",
      "header": "Replicas",
      "question": "How many replicas?",
      "type": "number",
      "min": 1,
      "max": 100,
      "default": 3
    },
    {
      "id": "confirm",
      "header": "Confirm",
      "question": "Proceed?",
      "type": "confirm"
    }
  ]
}
```

The TUI shows a tab bar with `□ Env`, `□ Version`, `□ Replicas`, `□ Confirm`,
`✓ Submit`. As the user answers each, the box becomes ■. The Submit tab
summarizes all answers and only enables submission when all required
questions are answered.

## Free-form text

```json
{
  "questions": [{
    "id": "feedback",
    "header": "Feedback",
    "question": "Any other notes?",
    "type": "text",
    "multiline": true,
    "required": false
  }]
}
```

`multiline: true` lets the user enter multiple lines. `required: false`
lets them skip it.

## Multi-select

```json
{
  "questions": [{
    "id": "toppings",
    "header": "Toppings",
    "question": "Pick your toppings",
    "type": "multi_select",
    "options": [
      { "label": "mushrooms" },
      { "label": "pepperoni" },
      { "label": "olives" },
      { "label": "pineapple" }
    ]
  }]
}
```

The user toggles with Space, confirms with Enter. Output is an array:
```json
{ "0": ["mushrooms", "pepperoni"] }
```

## Rich previews

Each option can carry a `preview` to show code, diagrams, or formatted specs.

```json
{
  "id": "auth",
  "header": "Auth",
  "question": "Which auth strategy?",
  "type": "single_select",
  "options": [
    {
      "label": "JWT",
      "description": "Stateless tokens",
      "preview": {
        "type": "code",
        "content": "Authorization: Bearer eyJhbGc..."
      }
    },
    {
      "label": "OAuth2",
      "description": "Delegated auth",
      "preview": {
        "type": "mermaid",
        "content": "sequenceDiagram\n  U->>A: /login\n  A->>P: redirect\n  P-->>A: code\n  A-->>U: token"
      }
    },
    {
      "label": "Session",
      "description": "Server-side state",
      "preview": {
        "type": "markdown",
        "content": "Stored in **Redis** with TTL of 24h"
      }
    }
  ]
}
```

The TUI renders the preview indented under each option. For `code` and
`markdown` it shows the content; for `mermaid` and `svg` it shows
`[mermaid]` / `[svg]` plus the content as text (v1 doesn't render
diagrams as images — that's a future enhancement).

## Confirm

```json
{
  "questions": [{
    "id": "ok",
    "header": "Confirm",
    "question": "Delete the prod database?",
    "type": "confirm"
  }]
}
```

Always exactly 2 options: Yes / No. Output is a boolean:
```json
{ "0": false }
```

## Number

```json
{
  "questions": [{
    "id": "n",
    "header": "N",
    "question": "How many concurrent connections?",
    "type": "number",
    "min": 1,
    "max": 1000,
    "default": 100
  }]
}
```

The TUI shows a numeric input with ↑/↓ nudging. Invalid input (out of
range, NaN) is rejected and the editor stays in input mode until a
valid number is entered.

## Headless / scripted use

```bash
# Set the answer file
export PI_QUESTIONNAIRE_ANSWERS_FILE=/tmp/my_answers.json

cat > /tmp/my_answers.json <<EOF
{
  "0": "Staging",
  "1": ["A", "B"],
  "2": "free text",
  "3": true,
  "4": 42
}
EOF

# Now run pi with the extension; the model can call ask_user and the
# answers will be loaded from the file.
pi -e ./src/index.ts -p "Use ask_user to ask me 5 questions and act on the answers."
```

This is the pattern the e2e test suite uses. The model sees a normal
tool result; it doesn't know the answers came from a file.

## Optional fields

| Field         | Applies to                | Default | Description                          |
|---------------|---------------------------|---------|--------------------------------------|
| `header`      | any                       | `Q1`/`Q2`/... | Short tab label, max 20 chars |
| `default`     | any                       | none    | Pre-filled value                     |
| `required`    | any                       | `true`  | If false, user can leave blank       |
| `min`/`max`   | `number`                  | none    | Bounds                               |
| `placeholder` | `text`                    | none    | Placeholder text in editor           |
| `multiline`   | `text`                    | `false` | Allow multi-line input               |

## What's intentionally NOT in v1

- **Real mermaid/svg rendering** — previews show as text with `[type]`
  marker. v1 is text-only.
- **Timeouts** — no auto-cancel after N seconds. The user can always
  press Esc.
- **Session persistence** — the answers live in the tool result
  `details`. If the model needs to remember across turns, it should
  write them to a file or session entry itself.
- **Custom widgets** (date pickers, color pickers, sliders). Use `text`
  with a format hint if you need a freeform input for one of these.
- **Cross-process synchronization** — the TUI is per-process. If you
  want a "background" questionnaire, use the headless path with a
  pre-populated answers file.
