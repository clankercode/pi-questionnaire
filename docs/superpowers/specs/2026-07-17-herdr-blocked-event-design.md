# Herdr Blocked-State Event Integration Design

**Date:** 2026-07-17
**Backlog:** B002 — herdr support: show as blocked when question is asked

## Goal

While `AskUserQuestion` or its `ask_user` adapter is waiting for a human response, Herdr must display the current Pi agent as blocked. When the questionnaire settles for any reason, Herdr must resume deriving working/idle state from its managed Pi integration.

## Root cause

pi-questionnaire currently starts a subprocess that runs:

```text
herdr pane report-agent <pane> --source user:pi-questionnaire --agent pi --state blocked
```

The command succeeds, but Herdr continues to show `working`. A live reproduction on the current pane showed `agent_status: working` before, during, and after the temporary report. Herdr's installed Pi integration owns the authoritative `herdr:pi` lifecycle report, so the lower-authority `user:pi-questionnaire` report cannot override it.

The managed Herdr Pi integration already listens on Pi's shared event bus:

```typescript
pi.events.on("herdr:blocked", ({ active, label }) => { /* ref-count and publish */ });
```

It preserves pane identity, agent session identity, queue ordering, retry behaviour, and the correct underlying working/idle state.

## Approaches considered

### 1. Emit the managed `herdr:blocked` event — selected

Use Pi's shared extension event bus. This composes with the authoritative Herdr integration and is a no-op when that integration is absent.

### 2. Escalate direct CLI authority

Changing the subprocess source to compete with `herdr:pi` could steal or corrupt lifecycle authority and would couple pi-questionnaire to Herdr's precedence rules. Rejected.

### 3. Implement the Herdr socket protocol directly

This would duplicate the managed integration's socket queue, retries, sequencing, and session reporting. Rejected as unnecessary and fragile.

## Architecture

Keep Herdr reporting inside `fireOnQuestionSideEffects`, which already owns the `herdrReportBlocked` setting and returns the idempotent lifecycle `clear()` handle used by `executeQuestionnaire`'s `finally` block.

Replace the Herdr subprocess implementation with two best-effort bus emissions:

```typescript
pi.events.emit("herdr:blocked", {
  active: true,
  label: `AskUserQuestion: ${firstHeader}`,
});

// exactly once from clear()
pi.events.emit("herdr:blocked", { active: false });
```

The function's Pi dependency becomes `Pick<ExtensionAPI, "sendMessage" | "events">`. Direct Herdr command builders, environment detection, pane IDs, subprocess release logic, and related constants are removed.

## Lifecycle and data flow

1. The primary `AskUserQuestion` tool and `ask_user` adapter both enter the shared `executeQuestionnaire` function.
2. Non-TUI calls and semantically rejected inputs return before side effects, so they emit no blocked event.
3. When `herdrReportBlocked` is enabled, `fireOnQuestionSideEffects` emits one active event with the first question header.
4. The managed Herdr integration increments its blocked reference count and publishes authoritative `blocked` state.
5. The TUI/browser interaction settles by answer, submit, cancel, or exception.
6. `executeQuestionnaire`'s existing `finally` calls `sideEffects.clear()`.
7. `clear()` emits one inactive event; repeated clears are no-ops.
8. The managed integration decrements its reference count and restores the state implied by agent activity.

This ref-counted protocol also handles overlapping questionnaires without one completion prematurely clearing another.

## Error handling

- Event emission is best-effort and wrapped in `try/catch`; Herdr integration failure must never prevent the questionnaire from opening or returning its result.
- The inactive event is attempted after any active-event attempt, even if a listener threw, to minimise stuck blocked state.
- With no Herdr integration installed, the shared event has no consumer and questionnaire behaviour is unchanged.
- Disabling `herdrReportBlocked` suppresses both active and inactive emissions.

## Testing

### Side-effect unit coverage

Update the TypeScript harness to record shared event emissions, then cover:

- enabled setting emits `active:true` with the first header;
- `clear()` emits `active:false` exactly once;
- repeated `clear()` remains idempotent;
- disabled setting emits nothing;
- a throwing listener is logged and does not throw from the side effect;
- no `herdr` subprocess is spawned.

### Execute lifecycle coverage

Refresh `tests/test_index_execute.mjs` to model the current Extension API (`on`, `events`, and both registered tools), include it in the normal Node test command, and assert:

- a successful questionnaire emits active then inactive;
- a thrown custom UI still emits inactive from `finally`;
- rejected/non-TUI inputs emit nothing.

### Verification

Run the focused red/green tests, rebuild `dist`, run `npm run test:all`, and perform a live in-session smoke test after reload if practical.

## Scope

In scope:

- replacing broken direct Herdr reporting with the supported shared event;
- lifecycle/error regression tests;
- updating comments/documentation that describe the obsolete subprocess path.

Out of scope:

- changes to Herdr itself or its managed Pi integration;
- new settings or UI controls;
- browser/TUI rendering changes;
- direct socket/API clients;
- unrelated side-effect refactoring.
