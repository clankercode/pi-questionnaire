"""Side-effects tests — exercises src/side-effects.ts via the TS harness.

The v2 settings in src/settings.ts define 14 fields. This suite asserts
that `fireOnQuestionSideEffects` (called at the start of `execute()`)
fires the right side effect for each one — gating on the setting value
and never throwing, even when a child process can't be spawned.

The harness installs a recording mock for every Node API the function
touches (spawn, setInterval, setTimeout, writeFileSync, randomBytes,
sendMessage), so the tests are deterministic across platforms and don't
depend on notify-send / osascript / msg / attn being installed.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest
from conftest import run_harness, REPO_ROOT


# --- helpers --------------------------------------------------------------

CONFIRM_Q = {
    "header": "Deploy",
    "question": "Ship it?",
    "type": "confirm_enum",
}

SELECT_Q = {
    "header": "Region",
    "question": "Pick a region",
    "type": "select_one",
    "options": [{"label": "US"}, {"label": "EU"}],
}

DEFAULT_TEST_SETTINGS = {
    "browserEnabled": True,
    "browserAutoOpen": False,
    "browserMinQuestions": 2,
    "copyUrlToClipboard": True,
    "bellOnQuestion": True,
    "notificationOnQuestion": False,
    "notificationDelaySeconds": 30,
    "ttsOnQuestion": False,
    "onQuestionCommand": "",
    "heartbeatWhileActive": False,
    "heartbeatIntervalMinutes": 4.5,
    "debounceMs": 300,
    "dangerCheckEnabled": True,
    "herdrReportBlocked": True,
}


def _fire(params, settings=None, platform="linux", **overrides):
    """Run the harness and return the parsed trace.

    `params` may be either a list of raw question dicts (most tests) or
    a full AskUserQuestionInput dict (rare). We wrap lists in the input
    envelope so the harness always sees `{ questions: [...] }`.
    """
    if isinstance(params, list):
        params = {"questions": params}
    cmd = {
        "cmd": "fireSideEffects",
        "params": params,
        "settings": {**DEFAULT_TEST_SETTINGS, **(settings or {})},
        "platform": platform,
    }
    cmd.update(overrides)
    return run_harness(cmd)


def _spawn_records(r):
    return r["trace"]["spawn"]


def _interval_records(r):
    return r["trace"]["setInterval"]


def _timeout_records(r):
    return r["trace"]["setTimeout"]


def _send_records(r):
    return r["trace"]["sendMessage"]


def _log(r):
    return r["trace"]["log"]


# --- 1. notificationOnQuestion -------------------------------------------

def test_notification_off_does_not_spawn():
    r = _fire([CONFIRM_Q], settings={"notificationOnQuestion": False})
    assert r["effects"] == ["browserEnabled", "copyUrlToClipboard", "herdr"]
    assert all(s["cmd"] != "notify-send" for s in _spawn_records(r))


def test_notification_on_linux_spawns_notify_send():
    r = _fire([CONFIRM_Q], settings={"notificationOnQuestion": True, "notificationDelaySeconds": 0}, platform="linux")
    assert "notification" in r["effects"]
    spawned = [s for s in _spawn_records(r) if s["cmd"] == "notify-send"]
    assert len(spawned) == 1
    assert spawned[0]["args"] == ["AskUserQuestion", "Deploy"]


def test_notification_on_darwin_uses_osascript():
    r = _fire([CONFIRM_Q], settings={"notificationOnQuestion": True, "notificationDelaySeconds": 0}, platform="darwin")
    assert "notification" in r["effects"]
    spawned = [s for s in _spawn_records(r) if s["cmd"] == "osascript"]
    assert len(spawned) == 1
    assert spawned[0]["args"][0] == "-e"
    assert 'display notification "Deploy"' in spawned[0]["args"][1]
    assert 'with title "AskUserQuestion"' in spawned[0]["args"][1]


def test_notification_on_win32_uses_msg():
    r = _fire([CONFIRM_Q], settings={"notificationOnQuestion": True, "notificationDelaySeconds": 0}, platform="win32")
    assert "notification" in r["effects"]
    spawned = [s for s in _spawn_records(r) if s["cmd"] == "msg"]
    assert len(spawned) == 1
    assert spawned[0]["args"] == ["*", "/TIME:5", "AskUserQuestion: Deploy"]


def test_notification_delay_schedules_setTimeout():
    r = _fire([CONFIRM_Q], settings={"notificationOnQuestion": True, "notificationDelaySeconds": 5}, platform="linux")
    assert "notification" in r["effects"]
    # No immediate spawn — it was scheduled.
    assert all(s["cmd"] != "notify-send" for s in _spawn_records(r))
    # setTimeout was called with 5_000 ms.
    assert len(_timeout_records(r)) == 1
    assert _timeout_records(r)[0]["ms"] == 5000


def test_notification_delay_zero_fires_immediately():
    r = _fire([CONFIRM_Q], settings={"notificationOnQuestion": True, "notificationDelaySeconds": 0}, platform="linux")
    assert len(_timeout_records(r)) == 0
    spawned = [s for s in _spawn_records(r) if s["cmd"] == "notify-send"]
    assert len(spawned) == 1


# --- 2. ttsOnQuestion -----------------------------------------------------

def test_tts_off_does_not_spawn_attn():
    r = _fire([CONFIRM_Q], settings={"ttsOnQuestion": False})
    assert "tts" not in r["effects"]
    assert all(s["cmd"] != "attn" for s in _spawn_records(r))


def test_tts_on_spawns_attn():
    r = _fire([CONFIRM_Q], settings={"ttsOnQuestion": True})
    assert "tts" in r["effects"]
    spawned = [s for s in _spawn_records(r) if s["cmd"] == "attn"]
    assert len(spawned) == 1
    assert spawned[0]["args"] == ["AskUserQuestion: Deploy"]


# --- 3. onQuestionCommand ------------------------------------------------

def test_onQuestionCommand_empty_does_not_spawn():
    r = _fire([CONFIRM_Q], settings={"onQuestionCommand": ""})
    assert "command" not in r["effects"]
    assert r["payloadFile"] is None


def test_onQuestionCommand_runs_with_payload_file_env():
    # Use a real temp dir so the file actually exists for the test to read.
    with tempfile.TemporaryDirectory() as tmpd:
        r = _fire(
            [CONFIRM_Q],
            settings={"onQuestionCommand": "echo hi"},
            tmpDir=tmpd,
            readPayload=True,
        )
        assert "command" in r["effects"]
        assert r["payloadFile"] is not None
        assert r["payloadFile"].startswith(tmpd)
        assert r["payloadFile"].endswith(".json")
        # File contains the raw params JSON.
        content = json.loads(r["payloadContent"])
        assert content["questions"][0]["header"] == "Deploy"
        # Spawn was called with the command, shell=true, and the env var set.
        spawned = [s for s in _spawn_records(r) if s["cmd"] == "echo hi"]
        assert len(spawned) == 1
        assert spawned[0]["shell"] is True
        env = spawned[0]["env"]
        assert env is not None
        assert env.get("PI_QUESTIONNAIRE_PAYLOAD_FILE") == r["payloadFile"]


# --- 4. browserAutoOpen gating -------------------------------------------

def test_browser_auto_open_disabled_no_effect():
    r = _fire([CONFIRM_Q] * 3, settings={"browserAutoOpen": False, "browserMinQuestions": 1})
    assert "browserAutoOpen" not in r["effects"]


def test_browser_auto_open_below_threshold_no_effect():
    r = _fire([CONFIRM_Q], settings={"browserAutoOpen": True, "browserMinQuestions": 2})
    # 1 question < 2 min, so no auto-open.
    assert "browserAutoOpen" not in r["effects"]


def test_browser_auto_open_above_threshold_fires():
    r = _fire([CONFIRM_Q] * 3, settings={"browserAutoOpen": True, "browserMinQuestions": 2})
    # 3 >= 2, so it fires.
    assert "browserAutoOpen" in r["effects"]


def test_browser_auto_open_at_threshold_fires():
    r = _fire([CONFIRM_Q] * 2, settings={"browserAutoOpen": True, "browserMinQuestions": 2})
    assert "browserAutoOpen" in r["effects"]


def test_browser_enabled_logs_todo():
    r = _fire([CONFIRM_Q], settings={"browserEnabled": True})
    assert "browserEnabled" in r["effects"]
    assert any("browser enabled" in line for line in _log(r))


def test_copy_url_to_clipboard_logs_todo():
    r = _fire([CONFIRM_Q], settings={"copyUrlToClipboard": True})
    assert "copyUrlToClipboard" in r["effects"]
    assert any("clipboard" in line for line in _log(r))


# --- 5. dangerCheckEnabled (logged, not in effects) ---------------------

def test_danger_check_enabled_logged():
    r = _fire([CONFIRM_Q], settings={"dangerCheckEnabled": True})
    # Not pushed to effects — just logged.
    assert "dangerCheck" not in r["effects"]
    assert any("danger check: enabled" in line for line in _log(r))


def test_danger_check_disabled_logged():
    r = _fire([CONFIRM_Q], settings={"dangerCheckEnabled": False})
    assert "dangerCheck" not in r["effects"]
    assert any("danger check: disabled" in line for line in _log(r))


# --- 6. heartbeat --------------------------------------------------------

def test_heartbeat_off_no_interval():
    r = _fire([CONFIRM_Q], settings={"heartbeatWhileActive": False})
    assert r["heartbeatStarted"] is False
    assert "heartbeat" not in r["effects"]
    assert _interval_records(r) == []


def test_heartbeat_on_is_hard_disabled_b005():
    """B005: heartbeatWhileActive is ignored until lifecycle ownership is fixed."""
    r = _fire([CONFIRM_Q], settings={"heartbeatWhileActive": True})
    assert r["heartbeatStarted"] is False
    assert "heartbeat" not in r["effects"]
    assert _interval_records(r) == []
    assert any("hard-disabled" in line or "B005" in line for line in _log(r))


def test_heartbeat_tick_does_not_send_when_hard_disabled():
    r = _fire(
        [CONFIRM_Q],
        settings={"heartbeatWhileActive": True, "heartbeatIntervalMinutes": 1.0},
        tickHeartbeat=True,
    )
    assert r["heartbeatStarted"] is False
    assert r.get("heartbeatTick") is None


def test_heartbeat_custom_interval_hard_disabled():
    r = _fire([CONFIRM_Q], settings={"heartbeatWhileActive": True, "heartbeatIntervalMinutes": 10})
    assert _interval_records(r) == []


# --- 7. error tolerance --------------------------------------------------

def test_spawn_failure_is_caught():
    r = _fire(
        [CONFIRM_Q],
        settings={"notificationOnQuestion": True, "notificationDelaySeconds": 0},
        platform="linux",
        mockSpawn=True,
        mockSpawnThrows=True,
    )
    # Effect is still recorded, but the function didn't throw.
    assert "notification" in r["effects"]
    # The failure was logged (via the log dep).
    assert any("notification spawn failed" in line for line in _log(r))


def test_tts_spawn_failure_is_caught():
    r = _fire(
        [CONFIRM_Q],
        settings={"ttsOnQuestion": True},
        platform="linux",
        mockSpawn=True,
        mockSpawnThrows=True,
    )
    assert "tts" in r["effects"]
    assert any("tts spawn failed" in line for line in _log(r))


def test_onQuestionCommand_spawn_failure_is_caught():
    r = _fire(
        [CONFIRM_Q],
        settings={"onQuestionCommand": "echo hi"},
        platform="linux",
        mockSpawn=True,
        mockSpawnThrows=True,
    )
    # The file write happens first, so the effect is still recorded even
    # if spawn fails (we tolerate spawn failures silently).
    assert "command" in r["effects"]
    assert any("onQuestionCommand failed" in line for line in _log(r))


# --- 8. clear() releases timers ----------------------------------------

def test_clear_releases_heartbeat():
    r = _fire(
        [CONFIRM_Q],
        settings={"heartbeatWhileActive": True},
        doClear=True,
    )
    # cleared flag returned in result
    assert r["cleared"] is True


def test_clear_releases_delayed_notification():
    r = _fire(
        [CONFIRM_Q],
        settings={"notificationOnQuestion": True, "notificationDelaySeconds": 30},
        doClear=True,
    )
    # handle was constructed; clear() called
    assert r["cleared"] is True
    # the timeout was scheduled
    assert len(_timeout_records(r)) == 1


# --- 9. multi-question first header -------------------------------------

def test_first_header_is_used_for_notification():
    r = _fire(
        [
            {"header": "First", "question": "?", "type": "confirm_enum"},
            {"header": "Second", "question": "?", "type": "confirm_enum"},
        ],
        settings={"notificationOnQuestion": True, "notificationDelaySeconds": 0},
        platform="linux",
    )
    spawned = [s for s in _spawn_records(r) if s["cmd"] == "notify-send"]
    assert spawned[0]["args"] == ["AskUserQuestion", "First"]


def test_tts_uses_first_header():
    r = _fire(
        [
            {"header": "A", "question": "?", "type": "confirm_enum"},
            {"header": "B", "question": "?", "type": "confirm_enum"},
        ],
        settings={"ttsOnQuestion": True},
    )
    spawned = [s for s in _spawn_records(r) if s["cmd"] == "attn"]
    assert spawned[0]["args"] == ["AskUserQuestion: A"]


# --- 10. defaults (no overrides) ----------------------------------------

def test_defaults_fire_browser_clipboard_and_herdr_event_only():
    """Defaults announce the questionnaire on the shared Herdr event bus
    without spawning a Herdr subprocess."""
    r = _fire([CONFIRM_Q])
    assert "browserEnabled" in r["effects"]
    assert "copyUrlToClipboard" in r["effects"]
    assert "herdr" in r["effects"]
    assert "notification" not in r["effects"]
    assert "tts" not in r["effects"]
    assert "command" not in r["effects"]
    assert "heartbeat" not in r["effects"]
    assert r["heartbeatStarted"] is False
    assert _spawn_records(r) == []
    assert _event_records(r) == [{
        "name": "herdr:blocked",
        "data": {"active": True, "label": "AskUserQuestion: Deploy"},
    }]
    assert any("danger check: enabled" in line for line in _log(r))


# --- 11. integration: payload file is real and JSON-parses --------------

def test_payload_file_actually_written_and_readable():
    """End-to-end: real fs write → real fs read → JSON contains the params."""
    with tempfile.TemporaryDirectory() as tmpd:
        r = _fire(
            [{"header": "Persist", "question": "?", "type": "free_text"}],
            settings={"onQuestionCommand": "cat"},
            tmpDir=tmpd,
            readPayload=True,
        )
        path = r["payloadFile"]
        assert path is not None
        assert os.path.exists(path), f"payload file {path} not on disk"
        with open(path) as f:
            data = json.load(f)
        assert data["questions"][0]["header"] == "Persist"


# --- 12. herdr blocked status -------------------------------------------
# The managed Herdr Pi integration owns authoritative agent state. The
# questionnaire joins that lifecycle through Pi's shared event bus rather
# than spawning a competing lower-authority CLI report.


def _event_records(r):
    return r["trace"]["events"]


def test_herdr_off_emits_no_event():
    r = _fire([CONFIRM_Q], settings={"herdrReportBlocked": False}, doClear=True)
    assert "herdr" not in r["effects"]
    assert _event_records(r) == []


def test_herdr_on_emits_blocked_with_first_header():
    r = _fire([CONFIRM_Q], settings={"herdrReportBlocked": True})
    assert "herdr" in r["effects"]
    assert _event_records(r) == [{
        "name": "herdr:blocked",
        "data": {"active": True, "label": "AskUserQuestion: Deploy"},
    }]
    assert all(s["cmd"] != "herdr" for s in _spawn_records(r))


def test_herdr_event_uses_first_header():
    r = _fire(
        [
            {"header": "First", "question": "?", "type": "confirm_enum"},
            {"header": "Second", "question": "?", "type": "confirm_enum"},
        ],
        settings={"herdrReportBlocked": True},
    )
    assert _event_records(r)[0]["data"]["label"] == "AskUserQuestion: First"


def test_herdr_clear_emits_inactive_once():
    r = _fire(
        [CONFIRM_Q],
        settings={"herdrReportBlocked": True},
        doClear=True,
    )
    assert r["cleared"] is True
    assert _event_records(r) == [
        {
            "name": "herdr:blocked",
            "data": {"active": True, "label": "AskUserQuestion: Deploy"},
        },
        {"name": "herdr:blocked", "data": {"active": False}},
    ]


def test_herdr_repeated_clear_is_idempotent():
    r = _fire(
        [CONFIRM_Q],
        settings={"herdrReportBlocked": True},
        doClearTwice=True,
    )
    inactive = [event for event in _event_records(r) if event["data"] == {"active": False}]
    assert len(inactive) == 1


def test_herdr_listener_failure_is_nonfatal():
    r = _fire(
        [CONFIRM_Q],
        settings={"herdrReportBlocked": True},
        mockEventThrows=True,
        doClear=True,
    )
    assert "herdr" in r["effects"]
    assert len(_event_records(r)) == 2
    assert any("herdr blocked event failed" in line for line in _log(r))
