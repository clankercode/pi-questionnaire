# Other-field zero hotkey design

## Goal

Fix B001: pressing `0` while editing an inline **Other** value must not unexpectedly discard editor focus and jump to the Submit tab when the user has already started typing.

## Behaviour

The `0` key is contextual while `inputMode === "other"`:

- If the Other draft is non-empty, `0` is inserted as literal text and the editor remains active.
- If the Other draft is empty in a multi-question form, `0` retains its existing meaning: jump to the Submit tab.
- If the Other draft is empty in a single-question form, `0` is inserted as literal text because no Submit tab exists.

Up/Down option navigation, Tab notes navigation, Enter submission, Escape handling, and all other editor behaviour remain unchanged.

## Implementation

Change only the Other-editor key classification in `src/tui.ts`. Treat `0` as a navigation key when both conditions hold:

1. the questionnaire has multiple questions; and
2. `editor.getText()` is empty.

Otherwise route `0` through `editor.handleInput(data)` as a printable character. This keeps the fix local to the state that currently misclassifies the key and avoids changing free-text, number, browser, answer-normalisation, or persistence paths.

## Tests

Add TUI interaction regressions to `tests/test_tui_render.mjs`:

1. A non-empty Other draft followed by `0` becomes `<draft>0`, stays on the same question, and keeps the Other editor active.
2. An empty Other draft followed by `0` in a multi-question form still opens the Submit tab.
3. An empty Other draft followed by `0` in a single-question form inserts `0` and keeps the Other editor active.

Run the targeted Node TUI suite first, then the complete build and test suite.

## Error handling and compatibility

No new error path is introduced. Existing key handling remains the fallback. The canonical answer shape and browser synchronisation contract are unchanged.

## Acceptance criteria

- Typing `0` after existing Other text does not navigate or reset focus.
- The empty-field Submit shortcut remains available in multi-question forms.
- Single-question Other input accepts `0`.
- Existing and new tests pass, and `dist/` is rebuilt before testing or reloading.
