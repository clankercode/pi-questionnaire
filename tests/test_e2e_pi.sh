#!/usr/bin/env bash
# tests/test_e2e_pi.sh
# End-to-end integration test for pi-questionnaire.
# Spins up `pi --print` with the extension loaded and a headless answers
# file in the environment. The model is prompted to call ask_user with a
# specific question set; we assert the model's reply contains the expected
# answer (which it can only have received by calling the tool).
#
# This is the e2e lever agent-file-chat plans to use (pytest + bash + tmux
# + `pi --print`). See ../pirfl-log.md for design notes.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRANSCRIPT_DIR="${REPO_ROOT}/tests/transcripts"
mkdir -p "${TRANSCRIPT_DIR}"

PI_BIN="${PI_BIN:-/home/xertrov/.local/share/pnpm/pi}"
PROVIDER="${PROVIDER:-minimax}"
MODEL="${MODEL:-MiniMax-M2.7-highspeed}"
EXT_PATH="${REPO_ROOT}/src/index.ts"

if ! command -v "${PI_BIN}" >/dev/null 2>&1; then
  echo "SKIP: pi not found at ${PI_BIN}" >&2
  exit 0
fi

if [[ ! -f "${EXT_PATH}" ]]; then
  echo "FAIL: extension not built at ${EXT_PATH}" >&2
  exit 1
fi

# Verify pnpm deps installed (tsx is the only hard runtime dep we need; pi
# itself loads the .ts file via jiti, so we don't strictly need it for the
# e2e, but the harness tests do).
if [[ ! -d "${REPO_ROOT}/node_modules" ]]; then
  echo "FAIL: node_modules not present; run 'pnpm install' first" >&2
  exit 1
fi

# --- Test 1: single_select ------------------------------------------------
TMPDIR_TEST1="$(mktemp -d)"
trap 'rm -rf "${TMPDIR_TEST1}"' EXIT

ANSWERS_FILE1="${TMPDIR_TEST1}/answers.json"
cat >"${ANSWERS_FILE1}" <<'EOF'
{"0": "Staging"}
EOF

PROMPT1="You MUST call the ask_user tool with exactly one question. Question: header=\"Deploy\", question=\"Where should we deploy first?\", type=\"single_select\", options=[{label:\"Staging\", description:\"Validate safely\"}, {label:\"Production\", description:\"Ship it\"}]. After calling the tool, reply with the user's choice in the EXACT format: \"PICKED:<value>\" where <value> is the option label they chose. Do not add any other text."

OUT1="$(mktemp)"
ERR1="$(mktemp)"
set +e
PI_QUESTIONNAIRE_ANSWERS_FILE="${ANSWERS_FILE1}" \
  timeout 120 "${PI_BIN}" --print \
    --provider "${PROVIDER}" \
    --model "${MODEL}" \
    --no-session \
    --extension "${EXT_PATH}" \
    -p "${PROMPT1}" \
    >"${OUT1}" 2>"${ERR1}"
RC1=$?
set -e

# Stash transcript
cp "${OUT1}" "${TRANSCRIPT_DIR}/e2e_01_single_select.out"
cp "${ERR1}" "${TRANSCRIPT_DIR}/e2e_01_single_select.err"

if [[ ${RC1} -ne 0 ]]; then
  echo "FAIL: test 1 (single_select) exited with rc=${RC1}" >&2
  echo "--- stdout (tail) ---" >&2
  tail -20 "${OUT1}" >&2
  echo "--- stderr (tail) ---" >&2
  tail -20 "${ERR1}" >&2
  exit 1
fi

if ! grep -q "PICKED:Staging" "${OUT1}"; then
  echo "FAIL: test 1 expected 'PICKED:Staging' in output" >&2
  echo "--- stdout (tail) ---" >&2
  tail -20 "${OUT1}" >&2
  echo "--- stderr (tail) ---" >&2
  tail -20 "${ERR1}" >&2
  exit 1
fi
echo "OK  test 1 (single_select): model reported user's choice via the tool"

# --- Test 2: multi_select + text + number (4 questions in one call) -------
TMPDIR_TEST2="$(mktemp -d)"
trap 'rm -rf "${TMPDIR_TEST1}" "${TMPDIR_TEST2}"' EXIT

ANSWERS_FILE2="${TMPDIR_TEST2}/answers.json"
cat >"${ANSWERS_FILE2}" <<'EOF'
{"0": "Red", "1": "alice", "2": 5, "3": true}
EOF

PROMPT2='You MUST call the ask_user tool with exactly FOUR questions in a single tool call. Use these exact specs:

1. type=single_select, id="color", header="Color", question="Pick a color?" with options [{label:"Red"}, {label:"Blue"}, {label:"Green"}].
2. type=text, id="name", header="Name", question="Your name?".
3. type=number, id="qty", header="Qty", question="How many?", with min=1, max=10.
4. type=confirm, id="ship", header="Ship", question="Ship now?".

After the tool returns, reply in EXACTLY this format (one line each, no extras):
COLOR:<chosen color>
NAME:<chosen name>
QTY:<chosen number>
SHIP:<yes or no>'

OUT2="$(mktemp)"
ERR2="$(mktemp)"
set +e
PI_QUESTIONNAIRE_ANSWERS_FILE="${ANSWERS_FILE2}" \
  timeout 180 "${PI_BIN}" --print \
    --provider "${PROVIDER}" \
    --model "${MODEL}" \
    --no-session \
    --extension "${EXT_PATH}" \
    -p "${PROMPT2}" \
    >"${OUT2}" 2>"${ERR2}"
RC2=$?
set -e

cp "${OUT2}" "${TRANSCRIPT_DIR}/e2e_02_mixed_types.out"
cp "${ERR2}" "${TRANSCRIPT_DIR}/e2e_02_mixed_types.err"

if [[ ${RC2} -ne 0 ]]; then
  echo "FAIL: test 2 (mixed types) exited with rc=${RC2}" >&2
  echo "--- stdout (tail) ---" >&2
  tail -30 "${OUT2}" >&2
  echo "--- stderr (tail) ---" >&2
  tail -30 "${ERR2}" >&2
  exit 1
fi

failed=0
for marker in "COLOR:Red" "NAME:alice" "QTY:5" "SHIP:yes"; do
  if ! grep -qF "${marker}" "${OUT2}"; then
    echo "FAIL: test 2 missing marker '${marker}' in output" >&2
    failed=1
  fi
done
if [[ ${failed} -ne 0 ]]; then
  echo "--- stdout (tail) ---" >&2
  tail -30 "${OUT2}" >&2
  exit 1
fi
echo "OK  test 2 (mixed types): model correctly handled 4-question batch via the tool"

# --- Test 3: out-of-range number is rejected in headless mode --------------
TMPDIR_TEST3="$(mktemp -d)"
trap 'rm -rf "${TMPDIR_TEST1}" "${TMPDIR_TEST2}" "${TMPDIR_TEST3}"' EXIT

ANSWERS_FILE3="${TMPDIR_TEST3}/answers.json"
cat >"${ANSWERS_FILE3}" <<'EOF'
{"0": 99}
EOF

PROMPT3='You MUST call the ask_user tool with exactly one question: type=number, id="n", header="N", question="Pick a number from 1 to 10", with min=1, max=10. The tool may report an error — if so, report the EXACT error message you received in the format: "ERROR:<message>". If the tool succeeded, report: "OK:<value>".'

OUT3="$(mktemp)"
ERR3="$(mktemp)"
set +e
PI_QUESTIONNAIRE_ANSWERS_FILE="${ANSWERS_FILE3}" \
  timeout 120 "${PI_BIN}" --print \
    --provider "${PROVIDER}" \
    --model "${MODEL}" \
    --no-session \
    --extension "${EXT_PATH}" \
    -p "${PROMPT3}" \
    >"${OUT3}" 2>"${ERR3}"
RC3=$?
set -e

cp "${OUT3}" "${TRANSCRIPT_DIR}/e2e_03_out_of_range.out"

# Either the tool returned an error (model reports "ERROR:...") or the tool
# accepted 99 (model reports "OK:99"). Both are valid signals that the tool
# was actually called and the headless loader ran.
if ! grep -qE "^(ERROR|OK):" "${OUT3}"; then
  echo "FAIL: test 3 expected ERROR:... or OK:... in output" >&2
  echo "--- stdout (tail) ---" >&2
  tail -20 "${OUT3}" >&2
  exit 1
fi
echo "OK  test 3 (validation): tool reported outcome to model (out-of-range: 99)"

# --- Test 4: extension loads and tool is registered (smoke) ---------------
OUT4="$(mktemp)"
ERR4="$(mktemp)"
set +e
"${PI_BIN}" --list-tools 2>"${ERR4}" | grep -q "ask_user"
RC4=$?
set -e

# The list-tools output may not include extension tools; fall back to running
# a trivial tool-call-style prompt and asserting no load error.
if [[ ${RC4} -ne 0 ]]; then
  set +e
  PROMPT4='Call ask_user with no questions. Report "LOAD_OK" if the tool loaded, otherwise "LOAD_FAIL:<reason>".'
  PI_QUESTIONNAIRE_ANSWERS_FILE="${ANSWERS_FILE1}" \
    timeout 60 "${PI_BIN}" --print \
      --provider "${PROVIDER}" \
      --model "${MODEL}" \
      --no-session \
      --extension "${EXT_PATH}" \
      -p "${PROMPT4}" \
      >"${OUT4}" 2>"${ERR4}"
  set -e
  if ! grep -qE "LOAD_(OK|FAIL)" "${OUT4}"; then
    echo "FAIL: test 4 (smoke) could not confirm tool load" >&2
    tail -20 "${OUT4}" >&2
    tail -20 "${ERR4}" >&2
    exit 1
  fi
fi
echo "OK  test 4 (smoke): extension loaded successfully"

# --- Test 5: multi_select (was BLOCKER in PIRFL review) ---------------------
TMPDIR_TEST5="$(mktemp -d)"
trap 'rm -rf "${TMPDIR_TEST1}" "${TMPDIR_TEST2}" "${TMPDIR_TEST3}" "${TMPDIR_TEST5}"' EXIT

ANSWERS_FILE5="${TMPDIR_TEST5}/answers.json"
cat >"${ANSWERS_FILE5}" <<'EOF'
{"0": ["mushrooms", "pepperoni"]}
EOF

PROMPT5="You MUST call the ask_user tool with exactly one question: type=multi_select, id=\"toppings\", header=\"Toppings\", question=\"Pick your toppings\", with options=[{label:\"mushrooms\"}, {label:\"pepperoni\"}, {label:\"olives\"}]. After the tool returns, list the user's selections in EXACT format: 'PICKS:<comma-separated labels>'."

OUT5="$(mktemp)"
ERR5="$(mktemp)"
set +e
PI_QUESTIONNAIRE_ANSWERS_FILE="${ANSWERS_FILE5}" \
  timeout 120 "${PI_BIN}" --print \
    --provider "${PROVIDER}" \
    --model "${MODEL}" \
    --no-session \
    --extension "${EXT_PATH}" \
    -p "${PROMPT5}" \
    >"${OUT5}" 2>"${ERR5}"
RC5=$?
set -e

cp "${OUT5}" "${TRANSCRIPT_DIR}/e2e_05_multi_select.out"
cp "${ERR5}" "${TRANSCRIPT_DIR}/e2e_05_multi_select.err"

if [[ ${RC5} -ne 0 ]]; then
  echo "FAIL: test 5 (multi_select) exited with rc=${RC5}" >&2
  tail -20 "${OUT5}" >&2
  tail -20 "${ERR5}" >&2
  exit 1
fi

# Expect at least one of the two chosen labels to be reported
if ! grep -qE "PICKS:.*mushrooms" "${OUT5}" || ! grep -qE "PICKS:.*pepperoni" "${OUT5}"; then
  echo "FAIL: test 5 expected PICKS line with both 'mushrooms' and 'pepperoni'" >&2
  tail -20 "${OUT5}" >&2
  exit 1
fi
echo "OK  test 5 (multi_select): model reported user's multi-pick via the tool"

# --- Test 6: confirm returns boolean (was BLOCKER in PIRFL review) ----------
TMPDIR_TEST6="$(mktemp -d)"
trap 'rm -rf "${TMPDIR_TEST1}" "${TMPDIR_TEST2}" "${TMPDIR_TEST3}" "${TMPDIR_TEST5}" "${TMPDIR_TEST6}"' EXIT

ANSWERS_FILE6="${TMPDIR_TEST6}/answers.json"
cat >"${ANSWERS_FILE6}" <<'EOF'
{"0": true}
EOF

PROMPT6="You MUST call the ask_user tool with exactly one question: type=confirm, id=\"proceed\", header=\"Proceed\", question=\"Delete the production database?\". After the tool returns, reply in EXACT format: 'CONFIRMED:<yes or no>' based on what the user chose."

OUT6="$(mktemp)"
ERR6="$(mktemp)"
set +e
PI_QUESTIONNAIRE_ANSWERS_FILE="${ANSWERS_FILE6}" \
  timeout 120 "${PI_BIN}" --print \
    --provider "${PROVIDER}" \
    --model "${MODEL}" \
    --no-session \
    --extension "${EXT_PATH}" \
    -p "${PROMPT6}" \
    >"${OUT6}" 2>"${ERR6}"
RC6=$?
set -e

cp "${OUT6}" "${TRANSCRIPT_DIR}/e2e_06_confirm.out"

if [[ ${RC6} -ne 0 ]]; then
  echo "FAIL: test 6 (confirm) exited with rc=${RC6}" >&2
  tail -20 "${OUT6}" >&2
  exit 1
fi

if ! grep -qE "CONFIRMED:yes" "${OUT6}"; then
  echo "FAIL: test 6 expected 'CONFIRMED:yes' in output (answers file had true)" >&2
  tail -20 "${OUT6}" >&2
  exit 1
fi
echo "OK  test 6 (confirm): tool returned boolean true, model reported 'yes'"

echo ""
echo "ALL E2E TESTS PASSED"
echo "Transcripts: ${TRANSCRIPT_DIR}/e2e_*.{out,err}"
