"""Answer parsing & validation tests — exercises src/answers.ts."""
from __future__ import annotations

from conftest import run_harness


# --- parseAnswerPayload ---------------------------------------------------

def test_parse_flat_canonical():
    r = run_harness({
        "cmd": "parseAnswers",
        "input": {"0": "Staging", "1": ["A", "B"], "2": "free text"},
    })
    assert r["answers"] == {"0": "Staging", "1": ["A", "B"], "2": "free text"}


def test_parse_pag_server_nested_shape():
    """pag-server: { selected, other } per question."""
    r = run_harness({
        "cmd": "parseAnswers",
        "input": {
            "0": {"selected": "Staging", "other": ""},
            "1": {"selected": ["A", "B"]},
        },
    })
    assert r["answers"]["0"] == "Staging"
    assert r["answers"]["1"] == ["A", "B"]


def test_parse_pag_server_answers_envelope():
    """pag-server: { answers: { ... } } outer envelope."""
    r = run_harness({
        "cmd": "parseAnswers",
        "input": {"answers": {"0": "X"}},
    })
    assert r["answers"] == {"0": "X"}


def test_parse_pag_server_question_response_envelope():
    """pag-server: { question_response: { answers: { ... } } }."""
    r = run_harness({
        "cmd": "parseAnswers",
        "input": {"question_response": {"answers": {"0": "X"}}},
    })
    assert r["answers"] == {"0": "X"}


def test_parse_other_label_with_free_text():
    """When 'Other' is selected, the 'other' string refines the value."""
    r = run_harness({
        "cmd": "parseAnswers",
        "input": {
            "0": {"selected": "Other", "other": "Custom region"},
        },
    })
    assert r["answers"]["0"] == "Custom region"


def test_parse_notes():
    r = run_harness({
        "cmd": "parseAnswers",
        "input": {
            "0": "X",
            "notes": {"0": "context for X", "1": "n2"},
        },
    })
    assert r["answers"]["0"] == "X"
    assert r["notes"]["0"] == "context for X"
    assert r["notes"]["1"] == "n2"


def test_parse_drops_empty_strings():
    r = run_harness({
        "cmd": "parseAnswers",
        "input": {"0": "", "1": "  ", "2": "ok"},
    })
    assert "0" not in r["answers"]
    assert "1" not in r["answers"]
    assert r["answers"]["2"] == "ok"


def test_parse_stringifies_int_keys():
    r = run_harness({
        "cmd": "parseAnswers",
        "input": {0: "X", 1: "Y"},
    })
    # JS object keys are always strings; ints get stringified.
    assert r["answers"] == {"0": "X", "1": "Y"}


# --- validateAgainstQuestions --------------------------------------------

def test_validate_required_missing():
    r = run_harness({
        "cmd": "validateAnswers",
        "questions": [
            {"id": "a", "question": "q?", "type": "text"},
            {"id": "b", "question": "q?", "type": "text"},
        ],
        "answers": {"0": "x"},
    })
    assert r["ok"] is False
    assert any("required" in e for e in r["errors"])


def test_validate_number_out_of_range():
    r = run_harness({
        "cmd": "validateAnswers",
        "questions": [{"id": "n", "question": "n?", "type": "number", "min": 1, "max": 10}],
        "answers": {"0": 42},
    })
    assert r["ok"] is False
    assert any("above max" in e for e in r["errors"])


def test_validate_number_in_range():
    r = run_harness({
        "cmd": "validateAnswers",
        "questions": [{"id": "n", "question": "n?", "type": "number", "min": 1, "max": 10}],
        "answers": {"0": 5},
    })
    assert r["ok"] is True, r


def test_validate_confirm_wrong_type():
    r = run_harness({
        "cmd": "validateAnswers",
        "questions": [{"id": "c", "question": "c?", "type": "confirm"}],
        "answers": {"0": "yes"},
    })
    assert r["ok"] is False
    assert any("boolean" in e for e in r["errors"])


def test_validate_multi_select_must_be_array():
    r = run_harness({
        "cmd": "validateAnswers",
        "questions": [{
            "id": "ms", "question": "ms?", "type": "multi_select",
            "options": [{"label": "A"}, {"label": "B"}],
        }],
        "answers": {"0": "A"},
    })
    assert r["ok"] is False
    assert any("array" in e for e in r["errors"])


def test_validate_optional_can_be_empty():
    r = run_harness({
        "cmd": "validateAnswers",
        "questions": [{"id": "a", "question": "q?", "type": "text", "required": False}],
        "answers": {},
    })
    assert r["ok"] is True, r


# --- coerceNumber --------------------------------------------------------

def test_coerce_number_basic():
    r = run_harness({
        "cmd": "coerceNumber",
        "question": {"id": "n", "question": "n?", "type": "number"},
        "input": "42",
    })
    assert r == 42


def test_coerce_number_respects_min_max():
    r = run_harness({
        "cmd": "coerceNumber",
        "question": {"id": "n", "question": "n?", "type": "number", "min": 1, "max": 10},
        "input": "100",
    })
    assert r is None


def test_coerce_number_rejects_nan():
    r = run_harness({
        "cmd": "coerceNumber",
        "question": {"id": "n", "question": "n?", "type": "number"},
        "input": "not a number",
    })
    assert r is None


def test_coerce_number_handles_decimals():
    r = run_harness({
        "cmd": "coerceNumber",
        "question": {"id": "n", "question": "n?", "type": "number"},
        "input": "3.14",
    })
    assert r == 3.14
