# pi-questionnaire

## Build

This extension loads from `dist/`. After any source changes, run `npm run build` before testing or reloading.

Always rebuild before asking the user to test. If you make changes and want to test them yourself, run `npm run build` then reload the pi session (use `pi_extension_dev_reload_self`).

## Testing flow

1. Make code changes
2. `npm run build`
3. `pi_extension_dev_reload_self` to pick up new dist/
4. Test via AskUserQuestion or browser

