#!/usr/bin/env bash
# tests/test_e2e_pi.sh
# End-to-end integration test for pi-questionnaire.
#
# v2 status (2026-06-18): the v1 e2e tests used headless mode via
# PI_QUESTIONNAIRE_ANSWERS_FILE, which was removed in v2 (browser is the
# headless path now, lands in slice 5+). The full e2e will be rewritten when
# the browser path is ready. For now, this script is a no-op that reports
# "SKIP" so the test pipeline doesn't false-alarm on missing v1 fixtures.
#
# The pytest + node test layers (78 + 15 cases) cover the schema, normalize,
# and TUI components in the meantime.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRANSCRIPT_DIR="${REPO_ROOT}/tests/transcripts"
mkdir -p "${TRANSCRIPT_DIR}"

cat <<EOF
SKIP  test_e2e_pi.sh: full e2e is deferred to slice 5+ (browser path)
       See PLAN.md and docs/superpowers/specs/2026-06-18-askuserquestion-v2-design.md.
       Unit/integration coverage: 78 pytest + 15 node --test cases.
       Next e2e milestone: test_e2e_browser_sync.py (ws client + http GET).
       Transcript dir: ${TRANSCRIPT_DIR}
EOF
exit 0
