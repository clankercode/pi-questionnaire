"""Headless mode tests — exercises src/headless.ts via subprocess + env var.

Headless mode is activated by setting PI_QUESTIONNAIRE_ANSWERS_FILE to a JSON
file path. The tool reads the file inside execute() and returns the answer
map as if the user had picked it. This is the lever for deterministic e2e.

These tests directly test the loader module (loadHeadlessAnswers) by spawning
a small tsx subprocess that imports the loader and writes its result to stdout.
This way we don't need to run pi itself to validate the env-bypass path.
"""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
HARNESS = REPO_ROOT / "tests" / "harness.ts"


def _run_loader(questions: list[dict], env: dict[str, str]) -> dict:
    """Run a tsx subprocess that loads questions and reads PI_QUESTIONNAIRE_ANSWERS_FILE."""
    inner = REPO_ROOT / "tests" / "headless_inner.ts"
    script = f"""
import {{ loadHeadlessAnswers, isHeadless }} from {json.dumps(str(REPO_ROOT / "src" / "headless.ts"))};
import {{ normalizeQuestions }} from {json.dumps(str(REPO_ROOT / "src" / "normalize.ts"))};
const questions = normalizeQuestions({json.dumps(questions)});
const result = await loadHeadlessAnswers(questions);
process.stdout.write(JSON.stringify({{ isHeadless: isHeadless(), ...result }}));
"""
    inner.write_text(script)
    try:
        proc = subprocess.run(
            ["npx", "tsx", str(inner)],
            capture_output=True,
            check=False,
            env={**os.environ, **env},
            cwd=str(REPO_ROOT),
            timeout=30,
        )
        out = proc.stdout.decode("utf-8").strip()
        if proc.returncode != 0:
            raise RuntimeError(f"loader failed: {proc.stderr.decode('utf-8')}")
        return json.loads(out)
    finally:
        inner.unlink(missing_ok=True)


def test_is_headless_false_when_env_unset():
    r = _run_loader(
        [{"id": "x", "question": "q?", "type": "text"}],
        env={},
    )
    assert r["isHeadless"] is False
    assert r["answers"] == {}


def test_loads_canonical_answer_file(tmp_path: Path):
    answers = {"0": "Staging", "1": ["A", "B"], "2": "free", "3": True, "4": 42}
    f = tmp_path / "answers.json"
    f.write_text(json.dumps(answers))
    r = _run_loader(
        [
            {"id": "x0", "question": "0?", "type": "single_select",
             "options": [{"label": "Staging"}, {"label": "Other"}]},
            {"id": "x1", "question": "1?", "type": "multi_select",
             "options": [{"label": "A"}, {"label": "B"}, {"label": "Other"}]},
            {"id": "x2", "question": "2?", "type": "text"},
            {"id": "x3", "question": "3?", "type": "confirm"},
            {"id": "x4", "question": "4?", "type": "number"},
        ],
        env={"PI_QUESTIONNAIRE_ANSWERS_FILE": str(f)},
    )
    assert r["isHeadless"] is True
    assert r["ok"] is True, r
    assert r["answers"] == answers


def test_loads_pag_server_envelope(tmp_path: Path):
    """{ answers: {...}, notes: {...} } envelope is supported."""
    f = tmp_path / "answers.json"
    f.write_text(json.dumps({
        "answers": {"0": "X"},
        "notes": {"0": "ctx"},
    }))
    r = _run_loader(
        [{"id": "x0", "question": "q?", "type": "text"}],
        env={"PI_QUESTIONNAIRE_ANSWERS_FILE": str(f)},
    )
    assert r["ok"] is True
    assert r["answers"] == {"0": "X"}
    assert r["notes"] == {"0": "ctx"}


def test_missing_file_returns_error(tmp_path: Path):
    f = tmp_path / "does_not_exist.json"
    r = _run_loader(
        [{"id": "x0", "question": "q?", "type": "text"}],
        env={"PI_QUESTIONNAIRE_ANSWERS_FILE": str(f)},
    )
    assert r["isHeadless"] is True
    assert r["ok"] is False
    assert any("failed to read" in e for e in r["errors"])


def test_invalid_json_returns_error(tmp_path: Path):
    f = tmp_path / "broken.json"
    f.write_text("{not json")
    r = _run_loader(
        [{"id": "x0", "question": "q?", "type": "text"}],
        env={"PI_QUESTIONNAIRE_ANSWERS_FILE": str(f)},
    )
    assert r["ok"] is False
    assert any("JSON" in e for e in r["errors"])


def test_out_of_range_number_reports_error(tmp_path: Path):
    f = tmp_path / "answers.json"
    f.write_text(json.dumps({"0": 99}))
    r = _run_loader(
        [{"id": "x0", "question": "n?", "type": "number", "min": 1, "max": 10}],
        env={"PI_QUESTIONNAIRE_ANSWERS_FILE": str(f)},
    )
    assert r["ok"] is False
    assert any("above max" in e for e in r["errors"])


def test_required_missing_reports_error(tmp_path: Path):
    f = tmp_path / "answers.json"
    f.write_text(json.dumps({"0": "ok"}))
    r = _run_loader(
        [
            {"id": "x0", "question": "q1?", "type": "text"},
            {"id": "x1", "question": "q2?", "type": "text"},  # missing
        ],
        env={"PI_QUESTIONNAIRE_ANSWERS_FILE": str(f)},
    )
    assert r["ok"] is False
    assert any("required" in e for e in r["errors"])


def test_pag_server_nested_per_question(tmp_path: Path):
    """{ "0": { selected, other } } per-question shape works."""
    f = tmp_path / "answers.json"
    f.write_text(json.dumps({
        "0": {"selected": "Staging"},
        "1": {"selected": ["A", "B"]},
    }))
    r = _run_loader(
        [
            {"id": "x0", "question": "0?", "type": "single_select",
             "options": [{"label": "Staging"}, {"label": "Other"}]},
            {"id": "x1", "question": "1?", "type": "multi_select",
             "options": [{"label": "A"}, {"label": "B"}, {"label": "Other"}]},
        ],
        env={"PI_QUESTIONNAIRE_ANSWERS_FILE": str(f)},
    )
    assert r["ok"] is True
    assert r["answers"] == {"0": "Staging", "1": ["A", "B"]}
