"""Schema validation tests — exercises src/schema.ts via the TS harness."""
from __future__ import annotations

import pytest
from conftest import run_harness


# --- v2 accepts the 5 question types -----------------------------------

def test_valid_select_one():
    r = run_harness({
        "cmd": "validate",
        "input": {
            "questions": [{
                "header": "Deploy",
                "question": "Where should we deploy first?",
                "type": "select_one",
                "options": [
                    {"label": "Staging", "description": "Validate safely"},
                    {"label": "Production", "description": "Ship it"},
                ],
            }],
        },
    })
    assert r["ok"] is True, r
    assert len(r["value"]["questions"]) == 1


def test_valid_select_many():
    r = run_harness({
        "cmd": "validate",
        "input": {
            "questions": [{
                "header": "Toppings",
                "question": "Pick toppings?",
                "type": "select_many",
                "options": [
                    {"label": "A"},
                    {"label": "B"},
                    {"label": "C"},
                ],
            }],
        },
    })
    assert r["ok"] is True, r


def test_valid_confirm_enum_no_options():
    """confirm_enum with no options is valid (auto-fills Affirm/Decline)."""
    r = run_harness({
        "cmd": "validate",
        "input": {
            "questions": [{
                "header": "Go",
                "question": "Should we proceed?",
                "type": "confirm_enum",
            }],
        },
    })
    assert r["ok"] is True, r


def test_valid_confirm_enum_with_options():
    r = run_harness({
        "cmd": "validate",
        "input": {
            "questions": [{
                "header": "Mode",
                "question": "Which mode?",
                "type": "confirm_enum",
                "options": [{"label": "Auto"}, {"label": "Manual"}],
            }],
        },
    })
    assert r["ok"] is True, r


def test_valid_number():
    r = run_harness({
        "cmd": "validate",
        "input": {
            "questions": [{
                "header": "Qty",
                "question": "How many?",
                "type": "number",
                "min": 1,
                "max": 10,
            }],
        },
    })
    assert r["ok"] is True, r


def test_valid_free_text():
    r = run_harness({
        "cmd": "validate",
        "input": {
            "questions": [{
                "header": "Note",
                "question": "Anything to add?",
                "type": "free_text",
                "placeholder": "Optional",
            }],
        },
    })
    assert r["ok"] is True, r


def test_valid_multi_question_max_4():
    """Max 4 questions per call."""
    r = run_harness({
        "cmd": "validate",
        "input": {
            "questions": [
                {"header": f"q{i}", "question": f"q{i}?", "type": "free_text"}
                for i in range(4)
            ],
        },
    })
    assert r["ok"] is True, r


# --- v2 rejects v1 type names --------------------------------------------

@pytest.mark.parametrize("old,new", [
    ("single_select", "select_one"),
    ("multi_select", "select_many"),
    ("confirm", "confirm_enum"),
    ("text", "free_text"),
])
def test_rejects_v1_type_names(old, new):
    """v1 type names produce a clear migration error via detectLegacyFields."""
    r = run_harness({
        "cmd": "detectLegacyFields",
        "input": {
            "questions": [{
                "header": "x",
                "question": "q?",
                "type": old,
            }],
        },
    })
    assert isinstance(r, list)
    joined = " ".join(r)
    assert old in joined and new in joined


# --- v2 rejects v1 aliases -----------------------------------------------

def test_rejects_prompt_alias():
    r = run_harness({
        "cmd": "detectLegacyFields",
        "input": {"questions": [{
            "header": "x", "question": "q?", "type": "free_text", "prompt": "old",
        }]},
    })
    assert any("prompt" in w for w in r)


def test_rejects_input_mode_alias():
    r = run_harness({
        "cmd": "detectLegacyFields",
        "input": {"questions": [{
            "header": "x", "question": "q?", "type": "free_text", "input_mode": "text",
        }]},
    })
    assert any("input_mode" in w for w in r)


def test_rejects_multi_select_alias():
    r = run_harness({
        "cmd": "detectLegacyFields",
        "input": {"questions": [{
            "header": "x", "question": "q?", "type": "select_many", "multi_select": True,
        }]},
    })
    assert any("multi_select" in w for w in r)


def test_rejects_required_field():
    r = run_harness({
        "cmd": "detectLegacyFields",
        "input": {"questions": [{
            "header": "x", "question": "q?", "type": "free_text", "required": False,
        }]},
    })
    assert any("required" in w for w in r)


def test_rejects_option_markdown_field():
    r = run_harness({
        "cmd": "detectLegacyFields",
        "input": {"questions": [{
            "header": "x", "question": "q?", "type": "select_one",
            "options": [{"label": "A", "markdown": "old"}],
        }]},
    })
    assert any("markdown" in w for w in r)


# --- semantic validation --------------------------------------------------

def test_rejects_empty_questions():
    r = run_harness({"cmd": "validate", "input": {"questions": []}})
    assert r["ok"] is False
    assert "at least one" in r["reason"].lower() or "empty" in r["reason"].lower()


def test_rejects_duplicate_ids():
    r = run_harness({
        "cmd": "validate",
        "input": {
            "questions": [
                {"id": "x", "header": "h", "question": "q1?", "type": "free_text"},
                {"id": "x", "header": "h2", "question": "q2?", "type": "free_text"},
            ],
        },
    })
    assert r["ok"] is False
    assert "duplicate" in r["reason"]


def test_rejects_select_one_without_options():
    r = run_harness({
        "cmd": "validate",
        "input": {"questions": [{
            "header": "h", "question": "q?", "type": "select_one",
        }]},
    })
    assert r["ok"] is False
    assert "option" in r["reason"].lower()


def test_rejects_too_many_options():
    r = run_harness({
        "cmd": "validate",
        "input": {"questions": [{
            "header": "h", "question": "q?", "type": "select_one",
            "options": [{"label": f"opt{i}"} for i in range(8)],
        }]},
    })
    assert r["ok"] is False
    assert "at most 7" in r["reason"]


def test_rejects_too_many_questions():
    """5-question cap (max 4 per call)."""
    r = run_harness({
        "cmd": "validate",
        "input": {"questions": [{
            "header": f"q{i}", "question": f"q{i}?", "type": "free_text",
        } for i in range(5)]},
    })
    assert r["ok"] is False
    assert "at most 4" in r["reason"]


def test_rejects_number_with_options():
    r = run_harness({
        "cmd": "validate",
        "input": {"questions": [{
            "header": "h", "question": "q?", "type": "number",
            "options": [{"label": "A"}],
        }]},
    })
    assert r["ok"] is False
    assert "number" in r["reason"].lower() and "option" in r["reason"].lower()


def test_rejects_free_text_with_options():
    r = run_harness({
        "cmd": "validate",
        "input": {"questions": [{
            "header": "h", "question": "q?", "type": "free_text",
            "options": [{"label": "A"}],
        }]},
    })
    assert r["ok"] is False
    assert "free_text" in r["reason"].lower() and "option" in r["reason"].lower()


def test_rejects_number_min_gt_max():
    r = run_harness({
        "cmd": "validate",
        "input": {"questions": [{
            "header": "h", "question": "q?", "type": "number", "min": 10, "max": 5,
        }]},
    })
    assert r["ok"] is False
    assert "min" in r["reason"] and "max" in r["reason"]


def test_rejects_header_too_long():
    r = run_harness({
        "cmd": "validate",
        "input": {"questions": [{
            "header": "x" * 21, "question": "q?", "type": "free_text",
        }]},
    })
    assert r["ok"] is False
    assert "header" in r["reason"].lower()


def test_accepts_short_header():
    r = run_harness({
        "cmd": "validate",
        "input": {"questions": [{
            "header": "x" * 20, "question": "q?", "type": "free_text",
        }]},
    })
    assert r["ok"] is True, r


# --- is_dangerous field --------------------------------------------------

@pytest.mark.parametrize("flag", [True, False])
def test_valid_is_dangerous(flag):
    """Schema accepts is_dangerous as an optional boolean."""
    r = run_harness({
        "cmd": "validateSchema",
        "input": {"questions": [{
            "header": "x", "question": "q?", "type": "free_text",
            "is_dangerous": flag,
        }]},
    })
    assert r["ok"] is True, r


def test_rejects_non_boolean_is_dangerous():
    """is_dangerous: 'yes' (string) is rejected by the typebox schema."""
    r = run_harness({
        "cmd": "validateSchema",
        "input": {"questions": [{
            "header": "x", "question": "q?", "type": "free_text",
            "is_dangerous": "yes",
        }]},
    })
    assert r["ok"] is False
    assert "boolean" in r["reason"].lower()


def test_schema_uses_v2_name():
    """AskUserQuestionParams is the exported schema."""
    # Smoke test: schema validates the new shape (max 4 per call)
    r = run_harness({
        "cmd": "validate",
        "input": {
            "questions": [
                {"header": "a", "question": "q?", "type": "select_one",
                 "options": [{"label": "A"}, {"label": "B"}]},
                {"header": "b", "question": "q?", "type": "select_many",
                 "options": [{"label": "A"}, {"label": "B"}]},
                {"header": "c", "question": "q?", "type": "confirm_enum"},
                {"header": "d", "question": "q?", "type": "number"},
            ],
        },
    })
    assert r["ok"] is True, r
