# Changelog

All notable changes to this project are documented in this file.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses semantic versioning for release notes.

## [2.1.5] - 2026-07-13

### Fixed

- **ANSI escape forms in expanded option preview (TUI)** — `preview.content` now renders real ESC bytes *and* literal `\x1b` / `\u001b` / `\e` escape text as actual terminal coloring instead of literal escape characters. Real bytes were already preserved by `wrapTextWithAnsi`; the new `interpretAnsiEscapes` helper in `src/ansi.ts` decodes the literal forms before the wrap pass. Wired into `renderOptionLine`'s expanded-preview path. Description, notes, and other text fields are intentionally left alone — those paths don't usually carry ANSI and a literal escape form there is more likely intentional display than an authoring oversight (`8dc4313`).
- **ANSI escape forms in browser preview (`text` / `code`)** — the browser path was a separate bug: `code.textContent = preview.content` dumped both real ESC bytes and literal `\x1b` text as raw characters, so colors never showed in the browser view. Added an `ansiToHtml()` helper in `src/browser-assets/browser-client.js` that decodes the same literal escape forms (mirroring the TUI regex), parses SGR codes (reset / bold / dim / italic / underline / 8-color fg+bg / bright fg+bg / 256-color / 24-bit / default-fg-bg), and emits colored `<span>` elements via `innerHTML`. Every text run is HTML-escaped via the existing `escapeHtml()` for XSS safety. Real `\n` becomes `<br>` for proper line breaks (`a6c30c3`).

## [2.1.4] - 2026-07-07

### Added

- **Herdr `blocked` status** — when inside a [herdr](https://herdr.dev)-managed pane and the new `herdrReportBlocked` setting is on (default `true`), the extension reports the pane as `blocked` (with `custom-status "answering question"`) for the duration of an `AskUserQuestion`/`ask_user` TUI, and releases the authority on answer/cancel/throw. No-op outside herdr. Surfaces the agent-waiting-on-human state in herdr's sidebar, waits, and rollups.

## [2.1.3] - 2026-06-30

### Added

- Browser markdown previews now render with **snarkdown** (vendored ~2 KB UMD), replacing the brittle hand-rolled regex renderer. Adds support for italics, strikethrough, fenced code blocks, ordered/unordered lists, blockquotes, links, images, horizontal rules, and nested formatting (previously only headings/bold/inline-code/newlines were handled) (`ee18049`).

### Fixed

- **Markdown preview rendering** — the bold regex `**...**` had been written as `/\\*\\*(.*?)\\*\\*/g` (literal backslash before each `*`), which matched the empty string at every position and inserted `<strong></strong>` between every character. This corrupted the entire HTML stream, causing headings, entities, and code spans to render as literal text. Root cause of the broken-preview reports (`f129195`).
- **Entity double-escaping** — markdown content emitted with HTML entities (e.g. LLM output like `&#39;` or `&amp;`) now decodes to the intended character before rendering instead of being double-escaped into visible entity codes (`f129195`).
- **Multi-line markdown** — the `<br>` rule was `/\\n/g` (matches literal backslash-n) instead of `/\n/g`, so newlines never line-broke (`f129195`).
- **Submit debounce stuck disabled** — the browser submit button stayed on "Please wait..." / disabled forever after entering the review screen. A timer now re-enables the button when the debounce window elapses (the TUI was unaffected because its render loop re-evaluates every tick) (`f129195`).
- **`e` key in text fields** — pressing `e` while typing in an input/textarea no longer toggles the current option's preview (`f129195`).

### Changed

- Markdown renderer is now defensive: if snarkdown is unavailable or throws, falls back to escaped plain text; `renderPreview` wraps rendering in try/catch so a single bad preview can no longer blank the whole question section (`ee18049`).

## [2.1.0] - 2026-06-28

### Highlights

- **`ask_user` tool override** — the extension now replaces the built-in `ask_user` tool with the rich questionnaire TUI. The LLM can call either `AskUserQuestion` (full schema with 5 question types, previews, notes) or `ask_user` (simpler `confirm`/`select`/`multiselect`/`input`/`batch` schema) and both route to the same TUI with browser sync, previews, notes, and all 13 settings.
- **Browser UI overhaul** — the browser questionnaire page has been rebuilt with an editorial document layout, dark mode, a layout toggle (single-question / all-questions), row-click option selection, and a review/submit flow redesign.
- **Browser confirm + submitted screens** — dedicated confirm-before-submit and submitted-receipt screens with auto-close timer.

### Added

- Added `src/ask-user-adapter.ts` with TypeBox schema and param conversion for the built-in `ask_user` tool surface (`7477051`). The adapter maps `confirm` → `confirm_enum`, `select` → `select_one`, `multiselect` → `select_many`, `input` → `free_text`, and `questions[]` batch mode to multiple adapted questions.
- Added shared `executeQuestionnaire()` function in `index.ts` used by both `AskUserQuestion` and `ask_user` tools, eliminating duplicated execution logic.
- Added browser editorial document layout with semantic progress band, step markers, choice-row structure with selected state, notes-field wrapper with dashed border, and review ledger with QUESTION/ANSWER/NOTES labels (`061f3a4`).
- Added browser dark mode with CSS custom properties, `data-theme` attribute on `<html>`, native control `color-scheme`, and a theme toggle (auto/light/dark) (`c3c1790`, `7ade39f`).
- Added browser single-question / all-questions layout toggle (`c3c1790`).
- Added browser row-click option selection (radio clears siblings, checkbox toggles) and progress-step click to exit review mode (`c3c1790`).
- Added browser confirm submit screen with Back navigation to return to the questionnaire (`5bf4205`).
- Added browser submitted receipt screen with structured answer display and cancelable auto-close countdown timer (`b218475`).

### Fixed

- Fixed keyboard handling bugs and added 250ms submit debounce to prevent accidental rapid submits (`dae3b54`).
- Fixed Submit tab to show clear required-answer feedback before allowing submission (`e4b19bf`).
- Fixed browser dark mode controls and review navigation styling (`46cdd3d`).
- Fixed browser theme application to target `<html>` document root instead of `<body>` so `color-scheme` affects native controls (`7ade39f`).
- Fixed browser sync server leak: all active per-call servers are now stopped on `session_shutdown` event (`e1036ed`).
- Fixed option status markers (■/▣/□) alignment after numbered options in the tab bar (`de76abe`).
- Fixed Other checkmark rendering order — now renders after the option number, not before (`61501a9`).
- Fixed inline cursor rendering at editor line position instead of always at end of text (`41868c7`, `86c7777`).
- Fixed bracket character typing in TUI Other editor (`d2c1652`).
- Fixed focused browser inputs to remain stable across WebSocket re-renders (`cc25ac2`, `2be039c`).
- Fixed saved option checkmark rendering to be independent of the selection cursor (`46f59e9`).
- Fixed single-choice options to use emoji pointing-hand cursor and saved answers to use blue checkmark (`7788657`, `cbb661b`).
- Fixed saved option checkmarks against edge cases with raw string answers from browser sync (`a5658d1`).
- Fixed browser submit review tab to sync from TUI tab changes (`db2e260`).
- Fixed browser Other draft text preservation during option sync updates (`b1bf176`).
- Fixed `confirm_enum` Other sentinel value handling in browser client (`8ba754b`).
- Fixed single-choice options to use text cursor instead of pointer (`6898988`).
- Fixed choice cursor emoji to render outside ANSI styling spans (`f05dc87`).
- Fixed browser Other answer sync to send structured `ChoiceAnswer` instead of raw strings (`9227c76`).
- Fixed `confirm_enum` value normalization to lowercase in browser and `coerceAnswer` (`04b797f`, `caa572e`).
- Removed cancel button from browser UI; replaced with helper text (`c3c1790`).

### Changed

- Changed browser assets to be served dynamically from `dist/browser-assets/` instead of static file serving (`3727bb5`).
- Refactored `src/index.ts` to extract shared questionnaire execution logic into `executeQuestionnaire()`, used by both `AskUserQuestion` and the new `ask_user` adapter tool (`7477051`).

### Testing

- 140 node tests passing (TUI render, browser server, settings, side effects).
- 127 pytest cases passing (schema, normalize, answers, settings menu, TUI integration).
- 267 total tests, all green.

## [2.0.0] - 2026-06-19

### Added

- Added the Claude Code-compatible `AskUserQuestion` tool surface (`7abeaa1`), replacing the v1 `ask_user` contract with a canonical answer map keyed by question index.
- Added the v2 schema with five explicit question types: `select_one`, `select_many`, `confirm_enum`, `number`, and `free_text` (`7abeaa1`).
- Added per-option rich previews with `markdown`, `code`, `text`, `mermaid`, `svg`, and `html` preview types (`5d2cd70`, `7499388`).
- Added an auto-appended `Other` option for choice questions, including revisit/edit support and a cap of seven user-provided options plus `Other` (`5d2cd70`, `bfc06a0`, `9ee4264`).
- Added per-question notes that are returned alongside answers (`5d2cd70`).
- Added persistent answered-state indicators/checkmarks across tab navigation (`5d2cd70`).
- Added a help overlay and expanded keyboard navigation for tabs, answer selection, previews, notes, and browser opening (`5d2cd70`, `b9fcf19`).
- Added the terminal title prefix (`🔔 AskUserQuestion — ...`), a live duration timer, and an explicit `[Select]` commit button for `select_many` questions (`d719724`).
- Added the `is_dangerous` question flag and a typed-confirmation gate for destructive prompts, controlled by `dangerCheckEnabled` (`0eb8f64`, `9ccc06b`, `8838031`, `5f91103`).
- Added a visual frame around the questionnaire and inline `Other` editing for choice questions (`3cbeca7`, `6746397`).
- Added the 13-field settings system with global/project merge, live reads, validation, and the `/settings-ask-user-question` interactive settings command (`3156df1`, `b47a70e`, `ea9f133`).
- Added on-question side effects: terminal bell, desktop notification, `attn` TTS, custom command payloads, heartbeat keepalives, browser URL copy/open handling, and debounce reporting (`3156df1`, `b47a70e`, `2d16881`).
- Added browser sync: a per-call HTTP + raw WebSocket server bound to `127.0.0.1`, sticky port selection, nonce-protected `/q/<batch-id>?nonce=<random>` URLs, browser/TUI state sync, reconnect handling, late-join snapshots, gated submit, cancel/submit lifecycle broadcasts, preview rendering, and auto-tab behavior (`53519e5`, `d7de984`, `494595c`, `acc3641`, `159d9e4`, `7499388`, `8e651b2`, `3e4ddff`).
- Added and hardened coverage across schema, normalization, answer coercion, settings, side effects, TUI rendering, settings menu behavior, and browser server lifecycle tests, validated for release with 127 pytest cases and 84 targeted node tests (`7a6b592` and related test commits).

### Changed

- Renamed the public tool from `ask_user` to `AskUserQuestion` to match Claude Code naming and prompt conventions (`7abeaa1`).
- Reworked the question payload shape around `header`, `question`, `type`, `options`, `default`, `min`, `max`, `placeholder`, `multiline`, `preview`, and `is_dangerous` fields (`7abeaa1`).
- Changed `confirm_enum` to normalize omitted options to `Affirm` / `Decline` plus `Other` (`7abeaa1`, `5d2cd70`).
- Changed `free_text` to default to multiline input and to open the editor immediately when revisited (`7abeaa1`, `b9fcf19`).
- Changed `select_many` keyboard behavior so Space and number keys toggle, Enter on a regular option toggles, and Enter on `[Select]` commits the array (`3969d53`, `d719724`).
- Changed option previews from v1-style markdown fields to typed `preview` objects (`7abeaa1`, `5d2cd70`).
- Changed tool results to include canonical answers, optional notes, lifecycle status, browser URL/port when available, and active debounce settings (`494595c`, `b47a70e`).
- Changed side-effect cleanup so heartbeat and delayed notification timers are cleared even when the TUI throws (`2d16881`).
- Updated README, usage, and architecture documentation for the v2 settings and danger-check flows (`ec67ecc`).

### Removed

- Removed the v1 `ask_user` tool name and compatibility surface (`7abeaa1`).
- Removed v1 type names and aliases: `single_select`, `multi_select`, `confirm`, `text`, `multi_select: true`, and `input_mode` (`7abeaa1`).
- Removed the `prompt` alias; use `question` instead (`7abeaa1`).
- Removed the `required` flag; v2 questions are always required (`7abeaa1`).
- Removed per-option `markdown`; use `preview: { "type": "markdown", "content": "..." }` instead (`7abeaa1`).
- Removed v1 headless answer-file mode and timeout lifecycle semantics from the v2 surface. Browser sync is interactive and TUI-attached in this release (`7abeaa1`, `494595c`).
