"""Schema validation tests — exercises src/schema.ts via the TS harness."""
from __future__ import annotations

import pytest
from conftest import run_harness


def test_valid_single_select():
    r = run_harness({
        "cmd": "validate",
        "input": {
            "questions": [{
                "id": "deploy",
                "header": "Deploy",
                "question": "Where should we deploy first?",
                "type": "single_select",
                "options": [
                    {"label": "Staging", "description": "Validate safely"},
                    {"label": "Production", "description": "Ship it"},
                ],
            }],
        },
    })
    assert r["ok"] is True, r
    assert len(r["value"]["questions"]) == 1


def test_valid_multi_question_pag_server_v2():
    """pag-server v2 shape: input_mode, no 'type' field, with options."""
    r = run_harness({
        "cmd": "validate",
        "input": {
            "questions": [
                {
                    "id": "where",
                    "header": "Where",
                    "question": "Where?",
                    "input_mode": "single_select",
                    "options": [
                        {"label": "Here", "description": "desc1"},
                        {"label": "There", "description": "desc2"},
                    ],
                },
                {
                    "id": "why",
                    "header": "Why",
                    "question": "Why?",
                    "input_mode": "text",
                },
            ],
        },
    })
    assert r["ok"] is True, r


def test_valid_pag_server_v1_compat():
    """pag-server v1: { question, options, multi_select: true }."""
    r = run_harness({
        "cmd": "validate",
        "input": {
            "questions": [{
                "id": "toppings",
                "question": "Pick toppings?",
                "options": [{"label": "A"}, {"label": "B"}, {"label": "C"}],
                "multi_select": True,
            }],
        },
    })
    assert r["ok"] is True, r


def test_rejects_empty_questions():
    r = run_harness({"cmd": "validate", "input": {"questions": []}})
    assert r["ok"] is False
    assert "empty" in r["reason"]


def test_rejects_duplicate_ids():
    r = run_harness({
        "cmd": "validate",
        "input": {
            "questions": [
                {"id": "x", "question": "q1?", "type": "text"},
                {"id": "x", "question": "q2?", "type": "text"},
            ],
        },
    })
    assert r["ok"] is False
    assert "duplicate" in r["reason"]


def test_rejects_select_without_options():
    r = run_harness({
        "cmd": "validate",
        "input": {"questions": [{
            "id": "x", "question": "q?", "type": "single_select",
        }]},
    })
    assert r["ok"] is False
    assert "at least 2 options" in r["reason"]


def test_rejects_too_many_options():
    r = run_harness({
        "cmd": "validate",
        "input": {"questions": [{
            "id": "x", "question": "q?", "type": "single_select",
            "options": [{"label": f"opt{i}"} for i in range(9)],
        }]},
    })
    assert r["ok"] is False
    assert "at most 8 options" in r["reason"]


def test_rejects_too_many_questions():
    """5-question cap (max 4 per call)."""
    r = run_harness({
        "cmd": "validate",
        "input": {"questions": [{
            "id": f"q{i}", "question": f"q{i}?", "type": "text",
        } for i in range(5)]},
    })
    assert r["ok"] is False
    assert "per-call cap" in r["reason"]


def test_rejects_number_min_gt_max():
    r = run_harness({
        "cmd": "validate",
        "input": {"questions": [{
            "id": "n", "question": "n?", "type": "number", "min": 10, "max": 5,
        }]},
    })
    assert r["ok"] is False
    assert "min" in r["reason"] and "max" in r["reason"]


def test_resolve_type_aliases():
    """resolveType() — pure function over (type, input_mode, multi_select)."""
    cases = [
        ({"explicit": "single_select", "inputMode": None, "legacyMulti": False}, "single_select"),
        ({"explicit": "multi_select", "inputMode": None, "legacyMulti": False}, "multi_select"),
        ({"explicit": "confirm", "inputMode": None, "legacyMulti": False}, "confirm"),
        ({"explicit": "number", "inputMode": None, "legacyMulti": False}, "number"),
        ({"explicit": None, "inputMode": "text", "legacyMulti": False}, "text"),
        ({"explicit": None, "inputMode": None, "legacyMulti": True}, "multi_select"),
        ({"explicit": None, "inputMode": None, "legacyMulti": False}, "text"),  # default
        ({"explicit": "bogus", "inputMode": None, "legacyMulti": False}, "invalid"),
    ]
    for args, expected in cases:
        r = run_harness({"cmd": "resolveType", **args})
        assert r == expected, f"args={args} expected={expected} got={r}"
