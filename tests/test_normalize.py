"""Normalization tests — exercises src/normalize.ts via the TS harness."""
from __future__ import annotations

from conftest import run_harness


def test_normalize_injects_other_option():
    """The 'Other' option is auto-appended for single/multi_select."""
    r = run_harness({"cmd": "normalize", "input": [{
        "id": "x", "question": "q?", "type": "single_select",
        "options": [{"label": "A"}, {"label": "B"}],
    }]})
    assert r["ok"] is True, r
    opts = r["value"][0]["options"]
    labels = [o["label"] for o in opts]
    assert labels == ["A", "B", "Other"], labels


def test_normalize_dedupes_existing_other():
    """If the user already added an 'Other', don't add another."""
    r = run_harness({"cmd": "normalize", "input": [{
        "id": "x", "question": "q?", "type": "single_select",
        "options": [{"label": "A"}, {"label": "B"}, {"label": "Other"}],
    }]})
    assert r["ok"] is True
    labels = [o["label"] for o in r["value"][0]["options"]]
    assert labels.count("Other") == 1
    assert len(labels) == 3


def test_normalize_promotes_v1_markdown_to_preview():
    """pag-server v1: option.markdown string becomes a markdown preview."""
    r = run_harness({"cmd": "normalize", "input": [{
        "id": "x", "question": "q?", "type": "single_select",
        "options": [
            {"label": "A", "markdown": "# hi\nbody"},
            {"label": "B"},
        ],
    }]})
    assert r["ok"] is True
    a = r["value"][0]["options"][0]
    assert a["preview"]["type"] == "markdown"
    assert a["preview"]["content"] == "# hi\nbody"


def test_normalize_prompts_alias():
    """`prompt` is accepted as alias for `question`."""
    r = run_harness({"cmd": "normalize", "input": [{
        "id": "x", "prompt": "hi?", "type": "text",
    }]})
    assert r["ok"] is True
    assert r["value"][0]["question"] == "hi?"


def test_normalize_defaults_required_true():
    r = run_harness({"cmd": "normalize", "input": [{
        "id": "x", "question": "q?", "type": "text",
    }]})
    assert r["value"][0]["required"] is True


def test_normalize_explicit_required_false():
    r = run_harness({"cmd": "normalize", "input": [{
        "id": "x", "question": "q?", "type": "text", "required": False,
    }]})
    assert r["value"][0]["required"] is False


def test_normalize_header_truncates_to_20():
    r = run_harness({"cmd": "normalize", "input": [{
        "id": "x",
        "header": "this is a very long header for sure",
        "question": "q?",
        "type": "text",
    }]})
    assert r["ok"] is True
    assert len(r["value"][0]["header"]) == 20


def test_normalize_auto_id_when_missing():
    r = run_harness({"cmd": "normalize", "input": [
        {"question": "q1?", "type": "text"},
        {"question": "q2?", "type": "text"},
    ]})
    assert r["ok"] is True
    ids = [q["id"] for q in r["value"]]
    assert ids[0] != ids[1]
    assert all(i for i in ids)


def test_normalize_invalid_type_raises():
    r = run_harness({"cmd": "normalize", "input": [{
        "id": "x", "question": "q?", "type": "bogus",
    }]})
    assert r["ok"] is False
    assert "invalid" in r["reason"]


def test_normalize_preserves_typed_preview():
    r = run_harness({"cmd": "normalize", "input": [{
        "id": "x", "question": "q?", "type": "single_select",
        "options": [
            {"label": "A", "preview": {"type": "mermaid", "content": "graph TD; A-->B"}},
            {"label": "B"},
        ],
    }]})
    a = r["value"][0]["options"][0]
    assert a["preview"]["type"] == "mermaid"
    assert "A-->B" in a["preview"]["content"]


def test_normalize_rejects_unknown_preview_type():
    r = run_harness({"cmd": "normalize", "input": [{
        "id": "x", "question": "q?", "type": "single_select",
        "options": [
            {"label": "A", "preview": {"type": "video", "content": "x"}},
            {"label": "B"},
        ],
    }]})
    # The unknown preview type is silently dropped (preview is optional).
    a = r["value"][0]["options"][0]
    assert a.get("preview") is None
