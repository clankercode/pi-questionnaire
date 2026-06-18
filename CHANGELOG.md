# Changelog

All notable changes to this project are documented in this file.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses semantic versioning for release notes.

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
