# Other-Field Zero Hotkey Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `0` append literal text in an active Other editor once typing has begun, while preserving the empty-field Submit shortcut in multi-question forms.

**Architecture:** Keep the change inside `buildQuestionnaireComponent`'s existing `inputMode === "other"` key-routing branch. Derive whether `0` is a Submit navigation key from the questionnaire shape and current editor draft; all other routing and answer formats remain unchanged.

**Tech Stack:** TypeScript, Node.js built-in test runner, `@earendil-works/pi-tui` Editor, npm/tsc.

## Global Constraints

- Follow test-driven development: add each regression and observe it fail before changing production code.
- Do not change browser, answer-normalisation, schema, or persistence behaviour.
- Preserve Up/Down, Tab, Enter, Escape, and non-zero printable key handling.
- After source changes, run `npm run build` before green/full-suite verification because the extension loads from `dist/`.
- Limit test/build concurrency to two threads or fewer.

---

### Task 1: Route zero contextually in the Other editor

**Files:**
- Modify: `src/tui.ts:950-962`
- Test: `tests/test_tui_render.mjs:430-490`

**Interfaces:**
- Consumes: existing closure state `isMulti`, `inputMode`, `inputQuestionId`, and `editor.getText()` inside `handleInput(data: string)`.
- Produces: unchanged `handleInput(data: string): void` behaviour with contextual classification of `0`; no new public API.

- [ ] **Step 1: Add failing regression tests**

Insert these tests beside the existing `select_one Other` interaction tests:

```javascript
test("select_one Other: zero appends to a non-empty draft instead of opening Submit", () => {
	const { component } = drive([
		{ id: "choice", header: "Choice", question: "Pick?", type: "select_one", options: [{ label: "A" }, { label: "B" }] },
		{ id: "followup", header: "Follow-up", question: "Continue?", type: "confirm_enum" },
	]);
	component.handleInput("\u001b[B");
	component.handleInput("\u001b[B");
	for (const ch of "custom") component.handleInput(ch);
	component.handleInput("0");

	assert.equal(component.getEditorText(), "custom0");
	const joined = component.render(80).join("\n");
	assert.match(joined, /Pick\?/);
	assert.doesNotMatch(joined, /Submit answers/);
});

test("select_one Other: zero on an empty draft retains the multi-question Submit hotkey", () => {
	const { component } = drive([
		{ id: "choice", header: "Choice", question: "Pick?", type: "select_one", options: [{ label: "A" }, { label: "B" }] },
		{ id: "followup", header: "Follow-up", question: "Continue?", type: "confirm_enum" },
	]);
	component.handleInput("\u001b[B");
	component.handleInput("\u001b[B");
	component.handleInput("0");

	assert.match(component.render(80).join("\n"), /Submit answers/);
});

test("select_one Other: zero is literal in a single-question form", () => {
	const { component } = drive([
		{ id: "choice", header: "Choice", question: "Pick?", type: "select_one", options: [{ label: "A" }, { label: "B" }] },
	]);
	component.handleInput("\u001b[B");
	component.handleInput("\u001b[B");
	component.handleInput("0");

	assert.equal(component.getEditorText(), "0");
	assert.match(component.render(80).join("\n"), /Pick\?/);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
node --test --test-name-pattern='select_one Other: zero' tests/test_tui_render.mjs
```

Expected: the non-empty-draft and single-question tests fail against current behaviour; the empty multi-question hotkey test passes as the compatibility guard.

- [ ] **Step 3: Implement the minimal contextual key classification**

Replace the Other editor's navigation classification with:

```typescript
const isZeroSubmitHotkey = data === "0" && isMulti && editor.getText() === "";
const isNavKey = matchesKey(data, Key.up) || matchesKey(data, Key.down)
	|| isZeroSubmitHotkey
	|| matchesKey(data, Key.tab);
```

Do not alter the subsequent editor dispatch or fall-through navigation blocks.

- [ ] **Step 4: Rebuild before testing the source change**

Run:

```bash
npm run build
```

Expected: `tsc` and `scripts/copy-browser-assets.mjs` both exit successfully.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
node --test --test-name-pattern='select_one Other: zero' tests/test_tui_render.mjs
```

Expected: all three focused regressions pass.

- [ ] **Step 6: Run full verification**

Run:

```bash
npm run test:all
npm run build
git diff --check
```

Expected: Node and Python test suites pass, the final build exits successfully, and `git diff --check` produces no output.

- [ ] **Step 7: Commit the implementation**

```bash
git add src/tui.ts tests/test_tui_render.mjs dist
git commit -m "fix: preserve zero input in populated Other fields"
```

If `dist/` contains no tracked changes beyond copied assets or is ignored, omit it from `git add` and commit the tracked source/test changes.

--- SUMMARY ---

- Add three focused regressions for non-empty, empty multi-question, and single-question Other drafts.
- Change only Other-editor key classification: `0` navigates to Submit exclusively for an empty draft in a multi-question questionnaire.
- Rebuild `dist/`, run focused and full suites, inspect the diff, and commit the verified change.
