# MODEL_NOTES.md — which `pi --print` model works for e2e

Working models (verified 2026-06-18):

| Provider | Model | Notes |
|----------|-------|-------|
| `minimax` | `MiniMax-M2.7-highspeed` | Default e2e model. Fast, cheap, handles tool calls. ✅ |

To use a different model in the e2e test:

```bash
PROVIDER=minimax MODEL=MiniMax-M2.7-highspeed bash tests/test_e2e_pi.sh
```

Other models tested (and the result):

- `minimax/MiniMax-M2.7` (non-highspeed) — works, just slower
- `minimax/MiniMax-M3` — works, larger context
- `github-copilot/claude-haiku-4.5` — works but rate-limited for our quota
- `google/gemini-2.5-flash` — should work; not yet tested for this e2e

Gotchas:

- `pi --print` exits after one turn, so multi-turn dialogue needs `--continue` + an outer loop, OR each agent gets one scripted turn with a pre-known prompt (the route we take).
- The model needs to actually call the tool; if the prompt is ambiguous, the model may answer from its own knowledge instead. Use explicit "MUST call" wording in the prompt.
- Some models hallucinate tool results; we mitigate by instructing the model to reply in a strict format (`PICKED:<value>`) so we can grep for the answer that came back through the tool.
- For tests, we use `--no-session` so the session isn't saved (ephemeral).
