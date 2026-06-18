# AskUserQuestion v2 — Persistent State (2026-06-18)

> This file is written by the orchestrator session before compaction.
> It captures the current state of the v2/ask-user-question branch so
> a fresh session can resume without re-deriving context.

## Worktree

- **Path:** `/home/xertrov/src/pi-questionnarie-v2`
  (note: folder name has typo "questionnarie" — to be renamed before merge)
- **Branch:** `v2/ask-user-question`
- **Spec:** `docs/superpowers/specs/2026-06-18-askuserquestion-v2-design.md`
- **Plan:** `PLAN.md`

## Commits (chronological, oldest → newest)

| Hash | Slice | Description |
|---|---|---|
| `7abeaa1` | slice 1 | rename ask_user → AskUserQuestion, new schema (5 types, no aliases) |
| `5d2cd70` | slice 2 | TUI redesign — notes, checkmarks, preview, help, browser shortcut |
| `3969d53` | fix | multi_select Space/1-9 toggles only; Enter commits |
| `d719724` | feat(tui) | terminal title prefix, duration timer, multi_select [Select] button |
| `0eb8f64` | feat(schema) | is_dangerous question flag (passes through) |
| `3156df1` | feat(bell) | audible BEL notification, gated by bellOnQuestion setting (default on) |

## In-flight subagents (background tool calls)

Coordinate via simple-agent-room channel: `v2-ask-user-question`

| ID | Role | Files owned | Status |
|---|---|---|---|
| `02511d75-efd8-424` | Wire up per-setting side effects (notification, TTS, command, heartbeat, browser, debounce) | `src/index.ts` (execute), new `src/side-effects.ts`, new `tests/test_side_effects.py`, `tests/harness.ts` | in progress, posted to room at 11:33:19 |
| `891e33e5-0bb2-402` | is_dangerous TUI flow + tests | `src/tui.ts`, `tests/test_tui_render.mjs` | in progress, posted to room at 11:33:34 |

**Subagents are told to post status lines to the room at start / test-complete / commit.** Steering messages sent to both telling them about the room.

## Coord channel (simple-agent-room)

- **Room:** `v2-ask-user-question`
- **Path:** `~/.cache/simple-agent-room/v2-ask-user-question.log`
- **Tools:** `simple-room-send`, `simple-room-monitor`, `simple-room-scan` (all on `$PATH`)
- **My agent id:** `pi-orchestrator` (exported as `$SIMPLE_AGENT_ID` for child shells)
- **Tail last N:** `simple-room-scan v2-ask-user-question tail -n 20`
- **Active agents:** `simple-room-scan v2-ask-user-question active --window 600`

## Settings module (already landed in commit 3156df1)

`src/settings.ts` exports:
- `AskUserQuestionSettings` interface (all 13 fields defined up-front for stable shape)
- `DEFAULT_SETTINGS` (bellOnQuestion=true, dangerCheckEnabled=true, etc.)
- `getSettings(cwd?)` — merged view (DEFAULT < global disk < project disk < in-memory override)
- `setInMemorySettings(s)` / `clearInMemorySettings()` — for tests
- `saveSettings(s, cwd?)` — writes project file

`getSettings()` is called on every execute so live changes are picked up. Tests can short-circuit via `setInMemorySettings`.

## Task list state

(See TaskList output for live status.)

- **#1 completed** — multi-select Enter fix
- **#2 completed** — duration timer
- **#3 completed** — title bell (🔔 prefix in OSC 0)
- **#5 in_progress** — side effects wiring (subagent 02511d75)
- **#11 pending** — is_dangerous flag (TUI part in #13)
- **#12 completed** — is_dangerous schema
- **#13 in_progress** — is_dangerous TUI flow (subagent 891e33e5)
- **#15 pending** — docs (blocked by #5, #11, #13, #14)
- **#16 pending** — PIRFL review (blocked by all of the above)
- **#17 pending** — rename worktree, merge to master, push (blocked by #16)
- **#18 completed** — BEL + settings module

## Pending after subagents land

1. **Settings menu UI (#14)** — register `/settings-ask-user-question` command with submenu navigation (left=back, right=enter per `~/.llm-general/ai-coding/pi/pi-tui-menus.md`). Touches `src/index.ts` so blocked by #5 landing.
2. **Docs (#15)** — update `README.md`, `docs/USAGE.md`, `docs/ARCHITECTURE.md` for v2 surface + settings + is_dangerous.
3. **PIRFL review (#16)** — run `ccc --yolo @cx-reviewer` over the v2 branch, fix blockers, re-review until PASS.
4. **Merge (#17)** — rename worktree `pi-questionnarie-v2` → `pi-questionnaire-v2`, merge `v2/ask-user-question` to `master`, push.

## Test counts (last green)

- `npx tsc --noEmit` — clean
- `node --test tests/test_tui_render.mjs` — 44/44 pass (32 v1 + 12 new for title/duration/[Select])
- `python -m pytest tests/test_schema.py tests/test_normalize.py tests/test_answers.py` — 84/84 pass (78 v1 + 6 new for is_dangerous)

## Risks / open items

- `notificationOnQuestion` and `onQuestionCommand` spawn processes; we need cross-platform handling (notify-send / osascript / msg). The side effects subagent owns this — verify it actually mocks `spawn` for tests.
- `heartbeatWhileActive` uses `ctx.sendMessage` with `customType`. The ExtensionAPI may not have that exact method; need to check. Falls back to `pi.sendMessage` if available.
- `dangerCheckEnabled` defaults to `true` in the subagent's settings module (per the plan I asked for). User actually said "default false" originally — **check this after subagent lands and correct if needed**.
- Browser section effects (auto-open, copy-clipboard) are no-ops until slice 5+ HTTP server lands. For now they're just logged.
- The `debounceMs` effect needs slice 8 (TUI ↔ browser sync) — also no-op for now.

## Resumption checklist (post-compact)

1. Read this file.
2. Read PLAN.md for slice context.
3. Tail the room: `simple-room-scan v2-ask-user-question tail -n 20`.
4. If #5 and #13 are committed, dispatch #14 (settings menu) and #15 (docs) in parallel.
5. If subagents are still running, give them more time. Use `steer_subagent` if needed.
6. Once everything lands, run PIRFL review (#16) and merge (#17).
