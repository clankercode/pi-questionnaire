# Herdr Blocked-State Event Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Herdr authoritatively display Pi as blocked while either questionnaire tool waits for human input, then restore managed agent state on every exit.

**Architecture:** Replace pi-questionnaire's ineffective lower-authority Herdr CLI subprocess report with Pi's shared `herdr:blocked` extension event. Keep lifecycle ownership in `fireOnQuestionSideEffects` and its idempotent `clear()` handle, which `executeQuestionnaire` already invokes from `finally`.

**Tech Stack:** TypeScript, Pi `ExtensionAPI.events`, Node.js built-in test runner, Python/pytest TypeScript harness, npm/tsc.

## Global Constraints

- Preserve the existing `herdrReportBlocked` setting and its default value of `true`.
- Emit no Herdr event for semantically rejected or non-TUI calls that return before side effects start.
- Event delivery is best-effort: listener absence or failure must not change questionnaire results.
- Emit the inactive event at most once per side-effect handle, including answer, cancel, browser completion, exception, or repeated cleanup.
- Do not call the Herdr CLI, socket, or API directly.
- Do not change questionnaire rendering, answer schemas, browser protocol, or unrelated side effects.
- After source changes, run `npm run build` before green/full-suite verification because the extension loads from `dist/`.
- Limit tests/builds to two threads or fewer.

---

### Task 1: Replace direct Herdr reports with managed extension events

**Files:**
- Modify: `tests/harness.ts:170-320`
- Modify: `tests/test_side_effects.py:1-430`
- Modify: `tests/test_index_execute.mjs:1-170`
- Modify: `package.json:30-34`
- Modify: `src/side-effects.ts:1-500`

**Interfaces:**
- Consumes: `ExtensionAPI.events.emit(eventName: string, data: unknown)` and existing `fireOnQuestionSideEffects(params, pi, deps)` callers.
- Produces: `fireOnQuestionSideEffects<P extends Pick<ExtensionAPI, "sendMessage" | "events">>(params, pi, deps): SideEffectHandle`.
- Event protocol: `pi.events.emit("herdr:blocked", { active: true, label: string })` and `pi.events.emit("herdr:blocked", { active: false })`.
- Cleanup protocol: existing `SideEffectHandle.clear(): void`, idempotent.

- [ ] **Step 1: Update the recording harness for shared events**

In `tests/harness.ts`, add an event trace beside `sendLog`:

```typescript
const eventLog: Array<{ name: string; data: unknown }> = [];
```

Build the mock Pi object with both required APIs:

```typescript
const mockEvents = {
	emit(name: string, data: unknown) {
		eventLog.push({ name, data });
		if (cmd.mockEventThrows === true) {
			throw new Error("mock event failure");
		}
	},
};
const mockPi = {
	sendMessage: mockSendMessage,
	events: mockEvents,
} as unknown as Pick<
	import("@earendil-works/pi-coding-agent").ExtensionAPI,
	"sendMessage" | "events"
>;
```

Remove the `herdrEnv` and `herdrPaneId` dependency overrides from the harness call. Add `events: eventLog` under `result.trace`.

- [ ] **Step 2: Replace CLI-oriented side-effect tests with event expectations**

In `tests/test_side_effects.py`, add:

```python
def _event_records(r):
    return r["trace"]["events"]
```

Replace the Herdr subprocess tests with these behaviours:

```python
def test_herdr_off_emits_no_event():
    r = _fire([CONFIRM_Q], settings={"herdrReportBlocked": False}, doClear=True)
    assert "herdr" not in r["effects"]
    assert _event_records(r) == []


def test_herdr_on_emits_blocked_with_first_header():
    r = _fire([CONFIRM_Q], settings={"herdrReportBlocked": True})
    assert "herdr" in r["effects"]
    assert _event_records(r) == [{
        "name": "herdr:blocked",
        "data": {"active": True, "label": "AskUserQuestion: Deploy"},
    }]
    assert all(s["cmd"] != "herdr" for s in _spawn_records(r))


def test_herdr_clear_emits_inactive_once():
    r = _fire([CONFIRM_Q], settings={"herdrReportBlocked": True}, doClear=True)
    assert _event_records(r) == [
        {"name": "herdr:blocked", "data": {"active": True, "label": "AskUserQuestion: Deploy"}},
        {"name": "herdr:blocked", "data": {"active": False}},
    ]


def test_herdr_listener_failure_is_nonfatal():
    r = _fire(
        [CONFIRM_Q],
        settings={"herdrReportBlocked": True},
        mockEventThrows=True,
        doClear=True,
    )
    assert "herdr" in r["effects"]
    assert len(_event_records(r)) == 2
    assert any("herdr blocked event failed" in line for line in _log(r))
```

Make the harness call `clear()` twice when `cmd.doClearTwice` is true and add a test asserting only one inactive event. Update exact default-effect assertions to include `"herdr"` because the default setting now attempts the shared event even when no listener is installed.

- [ ] **Step 3: Refresh and extend execute lifecycle tests**

In `tests/test_index_execute.mjs`, make every fake Extension API provide:

```javascript
on() {},
events: {
	emit(name, data) {
		events.push({ name, data });
	},
},
```

Capture registered tools by name rather than overwriting `pi.tool` with the later `ask_user` adapter:

```javascript
registerTool(tool) {
	this.tools ??= new Map();
	this.tools.set(tool.name, tool);
},
```

Use `pi.tools.get("AskUserQuestion")` in execute tests. Update the registration assertion to expect both `AskUserQuestion` and `ask_user`.

For the custom-UI exception test and successful browser-submit test, assert:

```javascript
assert.deepEqual(events, [
	{ name: "herdr:blocked", data: { active: true, label: "AskUserQuestion: Danger" } },
	{ name: "herdr:blocked", data: { active: false } },
]);
```

Use the relevant first header (`Danger` or `Pick`) in each assertion. Add a non-TUI execution test that expects `events` to remain empty.

Add `tests/test_index_execute.mjs` to the normal Node test command in `package.json`:

```json
"test": "node --test tests/test_tui_render.mjs tests/test_browser_server.mjs tests/test_index_execute.mjs"
```

- [ ] **Step 4: Run focused tests and verify RED**

Run separately:

```bash
python3 -m pytest tests/test_side_effects.py -k herdr -q
node --test tests/test_index_execute.mjs
```

Expected: the new event assertions fail because current production code spawns the Herdr CLI and emits no `herdr:blocked` events. Existing non-Herdr assertions should remain green after their expected effect list is updated.

- [ ] **Step 5: Replace the production Herdr subprocess path**

In `src/side-effects.ts`:

1. Change the function constraint:

```typescript
export function fireOnQuestionSideEffects<
	P extends Pick<ExtensionAPI, "sendMessage" | "events">
>(
	params: AskUserQuestionInput,
	pi: P,
	deps: SideEffectDeps = {},
): SideEffectHandle {
```

2. Remove `SideEffectDeps.herdrEnv`, `SideEffectDeps.herdrPaneId`, `HERDR_SOURCE`, `HERDR_AGENT`, `HERDR_CUSTOM_STATUS`, `herdrReportCommand`, `herdrReleaseCommand`, environment reads, and all Herdr child-process spawning.

3. Add a best-effort emitter after `firstHeader` is derived:

```typescript
function emitHerdrBlocked(active: boolean, label?: string): void {
	try {
		pi.events.emit("herdr:blocked", {
			active,
			...(label ? { label } : {}),
		});
	} catch (err) {
		log(`herdr blocked event failed: ${(err as Error).message}`);
	}
}
```

4. Keep `let herdrArmed = false`. In the Herdr side-effect block:

```typescript
if (settings.herdrReportBlocked) {
	effects.push("herdr");
	herdrArmed = true;
	emitHerdrBlocked(true, `AskUserQuestion: ${firstHeader}`);
}
```

5. In idempotent `clear()`:

```typescript
if (herdrArmed) {
	herdrArmed = false;
	emitHerdrBlocked(false);
}
```

6. Rewrite module/interface comments to describe the shared event protocol and remove subprocess/environment claims.

- [ ] **Step 6: Rebuild before green verification**

Run:

```bash
npm run build
```

Expected: TypeScript and browser asset copying exit successfully.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run:

```bash
python3 -m pytest tests/test_side_effects.py -k herdr -q
node --test tests/test_index_execute.mjs
```

Expected: all Herdr side-effect tests and all execute lifecycle tests pass.

- [ ] **Step 8: Run full verification**

Run:

```bash
npm run test:all
npm run build
git diff --check
```

Expected: Node and Python suites pass, build exits successfully, and `git diff --check` is silent.

- [ ] **Step 9: Inspect scope and commit**

Confirm the diff contains only the spec/plan plus:

```text
src/side-effects.ts
tests/harness.ts
tests/test_side_effects.py
tests/test_index_execute.mjs
package.json
```

Then commit:

```bash
git add src/side-effects.ts tests/harness.ts tests/test_side_effects.py tests/test_index_execute.mjs package.json
git commit -m "fix: report questionnaire blocking through Herdr integration"
```

- [ ] **Step 10: Review and live smoke test**

Run independent standards/spec reviews against the design and implementation commits. After review fixes and rebuild, reload Pi and open one questionnaire while observing `herdr agent get "$HERDR_PANE_ID"`; it must report `blocked` during the prompt and resume managed state after completion.

--- SUMMARY ---

- Replace the ineffective lower-authority Herdr CLI report with the managed `herdr:blocked` Pi extension event.
- Preserve the existing setting and idempotent cleanup lifecycle; make event failures non-fatal.
- Record events in the Python harness, activate/repair execute lifecycle tests in the normal Node suite, and prove active/inactive behaviour across success, rejection, and exceptions.
- Rebuild, run both full suites, review independently, smoke-test live after reload, then merge and close B002.
