"""Answer parsing & validation tests — exercises src/answers.ts (v2)."""
from __future__ import annotations

from conftest import run_harness


# --- v2 parseAnswerPayload: index-keyed object --------------------------

def test_parse_select_one_option_mode():
    r = run_harness({
        "cmd": "parseAnswers",
        "questions": [
            {"header": "h", "question": "q?", "type": "select_one",
             "options": [{"label": "A"}, {"label": "B"}]},
        ],
        "input": {"0": {"mode": "option", "value": "A"}},
    })
    assert r["answers"]["0"] == {"mode": "option", "value": "A"}


def test_parse_select_one_other_mode():
    r = run_harness({
        "cmd": "parseAnswers",
        "questions": [
            {"header": "h", "question": "q?", "type": "select_one",
             "options": [{"label": "A"}, {"label": "B"}]},
        ],
        "input": {"0": {"mode": "other", "text": "Custom"}},
    })
    assert r["answers"]["0"] == {"mode": "other", "text": "Custom"}


def test_parse_select_many_array():
    r = run_harness({
        "cmd": "parseAnswers",
        "questions": [
            {"header": "h", "question": "q?", "type": "select_many",
             "options": [{"label": "A"}, {"label": "B"}]},
        ],
        "input": {"0": [{"mode": "option", "value": "A"}, {"mode": "other", "text": "X"}]},
    })
    assert r["answers"]["0"] == [
        {"mode": "option", "value": "A"},
        {"mode": "other", "text": "X"},
    ]


def test_parse_confirm_enum_affirm():
    r = run_harness({
        "cmd": "parseAnswers",
        "questions": [{"header": "h", "question": "q?", "type": "confirm_enum"}],
        "input": {"0": {"mode": "option", "value": "affirm"}},
    })
    assert r["answers"]["0"] == {"mode": "option", "value": "affirm"}


def test_parse_confirm_enum_decline():
    r = run_harness({
        "cmd": "parseAnswers",
        "questions": [{"header": "h", "question": "q?", "type": "confirm_enum"}],
        "input": {"0": {"mode": "option", "value": "decline"}},
    })
    assert r["answers"]["0"] == {"mode": "option", "value": "decline"}


def test_parse_confirm_enum_other():
    r = run_harness({
        "cmd": "parseAnswers",
        "questions": [{"header": "h", "question": "q?", "type": "confirm_enum"}],
        "input": {"0": {"mode": "other", "text": "Maybe"}},
    })
    assert r["answers"]["0"] == {"mode": "other", "text": "Maybe"}


def test_parse_confirm_enum_custom_label_string_maps_by_position():
    r = run_harness({
        "cmd": "parseAnswers",
        "questions": [{
            "header": "h", "question": "q?", "type": "confirm_enum",
            "options": [{"label": "Approved"}, {"label": "Changes needed"}],
        }],
        "input": {"0": "Approved"},
    })
    assert r["answers"]["0"] == {"mode": "option", "value": "affirm"}


def test_parse_confirm_enum_custom_option_object_maps_by_position():
    r = run_harness({
        "cmd": "parseAnswers",
        "questions": [{
            "header": "h", "question": "q?", "type": "confirm_enum",
            "options": [{"label": "Approved"}, {"label": "Changes needed"}],
        }],
        "input": {"0": {"mode": "option", "value": "Changes needed"}},
    })
    assert r["answers"]["0"] == {"mode": "option", "value": "decline"}


def test_parse_number():
    r = run_harness({
        "cmd": "parseAnswers",
        "questions": [{"header": "h", "question": "q?", "type": "number"}],
        "input": {"0": 42},
    })
    assert r["answers"]["0"] == 42


def test_parse_free_text():
    r = run_harness({
        "cmd": "parseAnswers",
        "questions": [{"header": "h", "question": "q?", "type": "free_text"}],
        "input": {"0": "free-form text"},
    })
    assert r["answers"]["0"] == "free-form text"


# --- envelopes: pag-server compat is dropped in v2 -----------------------

def test_parse_envelope_unwraps_answers():
    r = run_harness({
        "cmd": "parseAnswers",
        "questions": [{"header": "h", "question": "q?", "type": "free_text"}],
        "input": {"answers": {"0": "X"}},
    })
    assert r["answers"] == {"0": "X"}


def test_parse_envelope_unwraps_question_response():
    r = run_harness({
        "cmd": "parseAnswers",
        "questions": [{"header": "h", "question": "q?", "type": "free_text"}],
        "input": {"question_response": {"answers": {"0": "Y"}}},
    })
    assert r["answers"] == {"0": "Y"}


def test_parse_notes():
    r = run_harness({
        "cmd": "parseAnswers",
        "questions": [
            {"header": "h", "question": "q1?", "type": "free_text"},
            {"header": "h2", "question": "q2?", "type": "free_text"},
        ],
        "input": {"0": "X", "notes": {"0": "context for X", "1": "n2"}},
    })
    assert r["answers"]["0"] == "X"
    assert r["notes"]["0"] == "context for X"
    assert r["notes"]["1"] == "n2"


def test_parse_stringifies_int_keys():
    r = run_harness({
        "cmd": "parseAnswers",
        "questions": [{"header": "h", "question": "q?", "type": "free_text"}],
        "input": {"0": "X"},
    })
    assert r["answers"] == {"0": "X"}


# --- validateAgainstQuestions (v2 types) --------------------------------

def test_validate_select_one_ok():
    r = run_harness({
        "cmd": "validateAnswers",
        "questions": [{
            "header": "h", "question": "q?", "type": "select_one",
            "options": [{"label": "A"}, {"label": "B"}],
        }],
        "answers": {"0": {"mode": "option", "value": "A"}},
    })
    assert r["ok"] is True, r


def test_validate_select_one_unknown_label():
    r = run_harness({
        "cmd": "validateAnswers",
        "questions": [{
            "header": "h", "question": "q?", "type": "select_one",
            "options": [{"label": "A"}, {"label": "B"}],
        }],
        "answers": {"0": {"mode": "option", "value": "Z"}},
    })
    assert r["ok"] is False
    assert any("Z" in e for e in r["errors"])


def test_validate_select_many_must_be_array():
    r = run_harness({
        "cmd": "validateAnswers",
        "questions": [{
            "header": "h", "question": "q?", "type": "select_many",
            "options": [{"label": "A"}, {"label": "B"}],
        }],
        "answers": {"0": {"mode": "option", "value": "A"}},
    })
    assert r["ok"] is False
    assert any("array" in e.lower() for e in r["errors"])


def test_validate_confirm_wrong_internal_value():
    r = run_harness({
        "cmd": "validateAnswers",
        "questions": [{"header": "h", "question": "q?", "type": "confirm_enum"}],
        "answers": {"0": {"mode": "option", "value": "maybe"}},
    })
    assert r["ok"] is False
    assert any("affirm" in e or "decline" in e for e in r["errors"])


def test_validate_number_out_of_range():
    r = run_harness({
        "cmd": "validateAnswers",
        "questions": [{
            "header": "h", "question": "q?", "type": "number", "min": 1, "max": 10,
        }],
        "answers": {"0": 42},
    })
    assert r["ok"] is False
    assert any("above max" in e for e in r["errors"])


def test_validate_number_in_range():
    r = run_harness({
        "cmd": "validateAnswers",
        "questions": [{
            "header": "h", "question": "q?", "type": "number", "min": 1, "max": 10,
        }],
        "answers": {"0": 5},
    })
    assert r["ok"] is True, r


def test_validate_missing_answer():
    r = run_harness({
        "cmd": "validateAnswers",
        "questions": [
            {"header": "h", "question": "q1?", "type": "free_text"},
            {"header": "h2", "question": "q2?", "type": "free_text"},
        ],
        "answers": {"0": "x"},
    })
    assert r["ok"] is False
    assert any("1 " in e or "not answered" in e for e in r["errors"])


def test_validate_free_text_wrong_type():
    r = run_harness({
        "cmd": "validateAnswers",
        "questions": [{"header": "h", "question": "q?", "type": "free_text"}],
        "answers": {"0": 42},
    })
    assert r["ok"] is False
    assert any("string" in e.lower() for e in r["errors"])


def test_validate_select_one_other_with_empty_text():
    r = run_harness({
        "cmd": "validateAnswers",
        "questions": [{
            "header": "h", "question": "q?", "type": "select_one",
            "options": [{"label": "A"}, {"label": "B"}],
        }],
        "answers": {"0": {"mode": "other", "text": "  "}},
    })
    assert r["ok"] is False
    assert any("non-empty" in e for e in r["errors"])


# --- coerceNumber --------------------------------------------------------

def test_coerce_number_basic():
    r = run_harness({
        "cmd": "coerceNumber",
        "question": {"header": "h", "question": "q?", "type": "number"},
        "input": "42",
    })
    assert r == 42


def test_coerce_number_respects_min_max():
    r = run_harness({
        "cmd": "coerceNumber",
        "question": {"header": "h", "question": "q?", "type": "number", "min": 1, "max": 10},
        "input": "100",
    })
    assert r is None


def test_coerce_number_rejects_nan():
    r = run_harness({
        "cmd": "coerceNumber",
        "question": {"header": "h", "question": "q?", "type": "number"},
        "input": "not a number",
    })
    assert r is None


def test_coerce_number_handles_decimals():
    r = run_harness({
        "cmd": "coerceNumber",
        "question": {"header": "h", "question": "q?", "type": "number"},
        "input": "3.14",
    })
    assert r == 3.14
