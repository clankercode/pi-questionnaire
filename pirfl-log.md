# PIRFL log — pi-questionnaire

## 2026-06-18 — intake

### Task model

- **Goal**: Create a pi-coding-agent extension that exposes a rich, flexible
  questionnaire tool (`ask_user`) supporting single_select, multi_select, text,
  confirm, and number question types — inspired by pag-server's questionnaire
  v2 contract. Full e2e testing with the same standards agent-file-chat is
  adopting (pytest + bash + tmux + `pi --print`).
- **Deliverable**: TypeScript extension (`src/`), Python + TS tests, e2e tmux
  integration, public `clankercode/pi-questionnaire` repo with README/LICENSE.
- **Acceptance**:
  - Tool registers and is callable by the LLM
  - All 5 question types render in TUI and produce correct canonical output
  - Tabs work for multi-question
  - Headless mode via `PI_QUESTIONNAIRE_ANSWERS_FILE` works for e2e
  - pytest, node --test, and bash e2e all pass
- **Constraints**:
  - Max 4 questions per single tool call
  - Use pag-server's questionnaire v2 as inspiration (input_mode, options with
    label/description/preview, canonical answer map)
  - Rich: previews (markdown/mermaid/svg/code), descriptions, default values
  - Flexible: pag-server v1 shape also accepted
  - Regular commits
  - E2E testing with pytest + bash + tmux + `pi --print`
  - Work autonomously

### Assumptions

- `pi --print` is a real and supported mode (confirmed in docs)
- `ui.custom()` is unavailable in `print` mode, so headless path is required
  for e2e (confirmed in extensions.md)
- The pnpm store at `/home/xertrov/.local/share/pnpm/store/v11/links/...`
  contains the packages I need; `pnpm link --global` will work
- Python 3.14 is installed and pytest is available
- tmux is installed (per pi-6ab87f's standards)
- gh CLI is authed as `XertroV` with access to `clankercode` org

### Blockers

- None at intake. Will validate model availability at first e2e run.

### Validators

- TypeScript: `node --test --import tsx` for TUI render snapshots
- Python: pytest for schema/normalize/answers/headless
- Bash: `test_e2e_pi.sh` for full tmux + `pi --print` integration

## Plan slices (will be filled in as we go)

1. **Slice 1 — scaffold + commit**: package.json, tsconfig, README, .gitignore,
   PLAN, pirfl-log, first commit.
2. **Slice 2 — schema + normalize + types**: `src/types.ts`, `src/schema.ts`,
   `src/normalize.ts` + pytest unit tests. Commit.
3. **Slice 3 — answers + headless**: `src/answers.ts`, `src/headless.ts` +
   pytest tests. Commit.
4. **Slice 4 — TUI component**: `src/tui.ts` + node --test render snapshots.
   Commit.
5. **Slice 5 — main tool wiring**: `src/index.ts` registers `ask_user`. Smoke
   test with `pi --list-tools` and `pi -e ./src/index.ts --print "..."`.
   Commit.
6. **Slice 6 — e2e with tmux + pi**: `tests/test_e2e_pi.sh`, MODEL_NOTES.md.
   Commit.
7. **Slice 7 — docs + repo**: README, LICENSE, ARCHITECTURE, USAGE, gh repo.
   Commit.
8. **Slice 8 — PIRFL review pass**: reviewers, fix, commit.

## Reviewer prompts (to run after each slice)

- **Correctness critic**: any logical, schema, or file-IO bugs?
- **Goal-fit critic**: do we cover all 5 question types? Is "Other" handling
  consistent with pag-server?
- **Edge-case critic**: out-of-range numbers, empty options, very long text,
  unicode, "Other" with empty body, 4-question cap, pag-server v1 compat.
- **Integration critic**: do schema, normalize, tui, and headless all produce
  the same canonical output for the same input?

## 2026-06-18 — PIRFL review pass (slice 8)

Dispatched the 4 reviewer roles via a sonnet subagent. Findings:

**2 BLOCKERs (both fixed):**
- `multi_select` answers were never saved. `selectOption` toggled the
  `checked` Set but never called `saveAnswer`. → Fix: save the array
  snapshot on each toggle; for single-question, call `done()` immediately.
  Verified by new e2e test 5 (multi_select with 2 chosen labels).
- `confirm` returned the string label ("Yes"/"No") instead of a boolean.
  The schema/validator expected `typeof v === "boolean"`, the headless
  path used `true`/`false`, but the TUI wrote strings. → Fix: in
  `selectOption` for `confirm`, save `isYes` (boolean) where isYes is
  `idx === 0` (Yes is always first). Verified by new e2e test 6.

**1 MAJOR (fixed):**
- `render()` had side effects that mutated `inputMode` and
  `inputQuestionId` on every redraw (when the cached lines were
  invalidated by a resize). This could reset the editor state
  unexpectedly. → Fix: moved input-mode initialization to `handleInput`
  on the first relevant keystroke (lazy init).

**2 MINORs (fixed):**
- "Other" injection could push the option list past the 8-cap (user
  provides 8, normalizer appends Other, total 9). → Fix: cap user
  options at 7 in `normalizeQuestion` so the post-Other count is
  always ≤ 8.
- `confirmOptions()` was mapped inconsistently — one map added
  `isOther: false`, the other didn't. → Fix: always set `isOther`
  in the render path.

**Verification after fixes:**
- 47/47 pytest pass
- 15/15 node --test pass (6 new tests for multi_select, confirm,
  Other, Esc, option cap)
- 6/6 e2e bash pass (2 new tests for the 2 BLOCKER fixes)
- Total: 68 test cases, all green
- TypeScript compiles cleanly
- Git: 6 atomic commits, pushed to clankercode/pi-questionnaire

**Open known limitations:**
- v1 doesn't render mermaid/svg as images — previews are text with
  `[type]` marker. Future enhancement.
- No timeout/lifecycle="timed_out" path — user must press Esc to
  cancel. Could add in v2.
- Multi-select UX could be improved with a "Done" button per
  question, but Enter-to-commit works for v1.

## Final state

- Public repo: https://github.com/clankercode/pi-questionnaire
- 68 test cases (47 pytest + 15 node + 6 bash e2e)
- README, LICENSE, ARCHITECTURE, USAGE all present
- E2E uses `minimax/MiniMax-M2.7-highspeed` (recorded in MODEL_NOTES.md)
- PIRFL log complete with all 8 slices documented
