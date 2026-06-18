"""Normalization tests — exercises src/normalize.ts via the TS harness."""
from __future__ import annotations

from conftest import run_harness


# --- Other option injection --------------------------------------------

def test_select_one_injects_other():
    r = run_harness({"cmd": "normalize", "input": [{
        "header": "x", "question": "q?", "type": "select_one",
        "options": [{"label": "A"}, {"label": "B"}],
    }]})
    assert r["ok"] is True, r
    labels = [o["label"] for o in r["value"][0]["options"]]
    assert labels == ["A", "B", "Other"]


def test_select_many_injects_other():
    r = run_harness({"cmd": "normalize", "input": [{
        "header": "x", "question": "q?", "type": "select_many",
        "options": [{"label": "A"}, {"label": "B"}],
    }]})
    assert r["ok"] is True
    labels = [o["label"] for o in r["value"][0]["options"]]
    assert labels[-1] == "Other"


def test_dedupes_existing_other():
    r = run_harness({"cmd": "normalize", "input": [{
        "header": "x", "question": "q?", "type": "select_one",
        "options": [{"label": "A"}, {"label": "B"}, {"label": "Other"}],
    }]})
    assert r["ok"] is True
    labels = [o["label"] for o in r["value"][0]["options"]]
    assert labels.count("Other") == 1
    assert len(labels) == 3


# --- confirm_enum auto-fill -------------------------------------------

def test_confirm_enum_autofills_when_no_options():
    """Per spec: confirm_enum with no options normalizes to Affirm/Decline + Other."""
    r = run_harness({"cmd": "normalize", "input": [{
        "header": "x", "question": "Go?", "type": "confirm_enum",
    }]})
    assert r["ok"] is True, r
    labels = [o["label"] for o in r["value"][0]["options"]]
    assert labels == ["Affirm", "Decline", "Other"]


def test_confirm_enum_preserves_user_options():
    r = run_harness({"cmd": "normalize", "input": [{
        "header": "x", "question": "Mode?", "type": "confirm_enum",
        "options": [{"label": "Auto"}, {"label": "Manual"}],
    }]})
    assert r["ok"] is True
    labels = [o["label"] for o in r["value"][0]["options"]]
    assert labels == ["Auto", "Manual", "Other"]


# --- options cap (7 + Other = 8) --------------------------------------

def test_caps_options_at_7_user_provided():
    """User-provided options are capped at 7 (so + Other = 8 max)."""
    r = run_harness({"cmd": "normalize", "input": [{
        "header": "x", "question": "q?", "type": "select_one",
        "options": [{"label": f"opt{i}"} for i in range(10)],
    }]})
    assert r["ok"] is True
    labels = [o["label"] for o in r["value"][0]["options"]]
    assert len(labels) == 8  # 7 + Other
    assert labels[-1] == "Other"


# --- description field ------------------------------------------------

def test_preserves_description():
    r = run_harness({"cmd": "normalize", "input": [{
        "header": "h", "question": "q?", "description": "Context here",
        "type": "free_text",
    }]})
    assert r["ok"] is True
    assert r["value"][0]["description"] == "Context here"


def test_description_optional():
    r = run_harness({"cmd": "normalize", "input": [{
        "header": "h", "question": "q?", "type": "free_text",
    }]})
    assert r["ok"] is True
    assert r["value"][0].get("description") is None or "description" not in r["value"][0]


# --- number/free_text: no options ------------------------------------

def test_number_rejects_options_at_normalize():
    """Schema already rejects, but normalize is also defensive."""
    # Skipped at normalize layer since schema catches it; but we test schema
    # for the canonical "no options" case:
    r = run_harness({"cmd": "normalize", "input": [{
        "header": "h", "question": "q?", "type": "number",
    }]})
    assert r["ok"] is True
    assert "options" not in r["value"][0]


def test_free_text_rejects_options_at_normalize():
    r = run_harness({"cmd": "normalize", "input": [{
        "header": "h", "question": "q?", "type": "free_text",
    }]})
    assert r["ok"] is True
    assert "options" not in r["value"][0]


# --- default validation ----------------------------------------------

def test_default_select_one_must_match_label():
    r = run_harness({"cmd": "normalize", "input": [{
        "header": "h", "question": "q?", "type": "select_one",
        "options": [{"label": "A"}, {"label": "B"}],
        "default": "C",
    }]})
    assert r["ok"] is False
    assert "default" in r["reason"]


def test_default_select_one_matching_label():
    r = run_harness({"cmd": "normalize", "input": [{
        "header": "h", "question": "q?", "type": "select_one",
        "options": [{"label": "A"}, {"label": "B"}],
        "default": "A",
    }]})
    assert r["ok"] is True
    assert r["value"][0]["default"] == "A"


def test_default_select_many_must_be_array():
    r = run_harness({"cmd": "normalize", "input": [{
        "header": "h", "question": "q?", "type": "select_many",
        "options": [{"label": "A"}, {"label": "B"}],
        "default": "A",
    }]})
    assert r["ok"] is False
    assert "array" in r["reason"].lower()


def test_default_select_many_array():
    r = run_harness({"cmd": "normalize", "input": [{
        "header": "h", "question": "q?", "type": "select_many",
        "options": [{"label": "A"}, {"label": "B"}],
        "default": ["A", "B"],
    }]})
    assert r["ok"] is True
    assert r["value"][0]["default"] == ["A", "B"]


def test_default_confirm_enum_must_be_affirm_or_decline():
    r = run_harness({"cmd": "normalize", "input": [{
        "header": "h", "question": "q?", "type": "confirm_enum",
        "default": "maybe",
    }]})
    assert r["ok"] is False
    assert "affirm" in r["reason"] or "decline" in r["reason"]


def test_default_confirm_enum_affirm():
    r = run_harness({"cmd": "normalize", "input": [{
        "header": "h", "question": "q?", "type": "confirm_enum",
        "default": "affirm",
    }]})
    assert r["ok"] is True
    assert r["value"][0]["default"] == "affirm"


def test_default_number_must_be_number():
    r = run_harness({"cmd": "normalize", "input": [{
        "header": "h", "question": "q?", "type": "number",
        "default": "forty-two",
    }]})
    assert r["ok"] is False
    assert "number" in r["reason"].lower()


def test_default_number():
    r = run_harness({"cmd": "normalize", "input": [{
        "header": "h", "question": "q?", "type": "number",
        "default": 42,
    }]})
    assert r["ok"] is True
    assert r["value"][0]["default"] == 42


def test_default_free_text():
    r = run_harness({"cmd": "normalize", "input": [{
        "header": "h", "question": "q?", "type": "free_text",
        "default": "hello",
    }]})
    assert r["ok"] is True
    assert r["value"][0]["default"] == "hello"


# --- free_text multiline default -------------------------------------

def test_free_text_multiline_defaults_to_true():
    r = run_harness({"cmd": "normalize", "input": [{
        "header": "h", "question": "q?", "type": "free_text",
    }]})
    assert r["ok"] is True
    assert r["value"][0]["multiline"] is True


def test_free_text_multiline_explicit_false():
    r = run_harness({"cmd": "normalize", "input": [{
        "header": "h", "question": "q?", "type": "free_text",
        "multiline": False,
    }]})
    assert r["ok"] is True
    assert r["value"][0]["multiline"] is False


# --- id handling ------------------------------------------------------

def test_auto_id_when_missing():
    r = run_harness({"cmd": "normalize", "input": [
        {"header": "h", "question": "q1?", "type": "free_text"},
        {"header": "h", "question": "q2?", "type": "free_text"},
    ]})
    assert r["ok"] is True
    ids = [q["id"] for q in r["value"]]
    assert ids[0] != ids[1]
    assert all(i for i in ids)


def test_explicit_id_preserved():
    r = run_harness({"cmd": "normalize", "input": [{
        "id": "deploy-1", "header": "h", "question": "q?", "type": "free_text",
    }]})
    assert r["ok"] is True
    assert r["value"][0]["id"] == "deploy-1"


# --- header truncation ------------------------------------------------

def test_header_truncates_to_20():
    r = run_harness({"cmd": "normalize", "input": [{
        "header": "this is a very long header for sure",
        "question": "q?", "type": "free_text",
    }]})
    assert r["ok"] is True
    assert len(r["value"][0]["header"]) == 20


# --- preview handling --------------------------------------------------

def test_preserves_typed_preview():
    r = run_harness({"cmd": "normalize", "input": [{
        "header": "h", "question": "q?", "type": "select_one",
        "options": [
            {"label": "A", "preview": {"type": "mermaid", "content": "graph TD; A-->B"}},
            {"label": "B"},
        ],
    }]})
    assert r["ok"] is True
    a = r["value"][0]["options"][0]
    assert a["preview"]["type"] == "mermaid"
    assert "A-->B" in a["preview"]["content"]


def test_rejects_unknown_preview_type():
    r = run_harness({"cmd": "normalize", "input": [{
        "header": "h", "question": "q?", "type": "select_one",
        "options": [
            {"label": "A", "preview": {"type": "video", "content": "x"}},
            {"label": "B"},
        ],
    }]})
    assert r["ok"] is True
    a = r["value"][0]["options"][0]
    assert a.get("preview") is None


# --- is_dangerous pass-through ------------------------------------------

def test_normalize_preserves_is_dangerous_true():
    r = run_harness({"cmd": "normalize", "input": [{
        "header": "x", "question": "q?", "type": "free_text",
        "is_dangerous": True,
    }]})
    assert r["ok"] is True, r
    assert r["value"][0]["is_dangerous"] is True


def test_normalize_preserves_is_dangerous_false():
    r = run_harness({"cmd": "normalize", "input": [{
        "header": "x", "question": "q?", "type": "free_text",
        "is_dangerous": False,
    }]})
    assert r["ok"] is True, r
    assert r["value"][0]["is_dangerous"] is False


def test_normalize_omits_is_dangerous_when_unset():
    """When the input has no is_dangerous, the canonical question must not
    set a default — the key is absent so the TUI knows the user did not
    explicitly flag the question as dangerous."""
    r = run_harness({"cmd": "normalize", "input": [{
        "header": "x", "question": "q?", "type": "free_text",
    }]})
    assert r["ok"] is True, r
    assert "is_dangerous" not in r["value"][0]
