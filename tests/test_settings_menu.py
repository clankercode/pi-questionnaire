"""Settings menu — data layer tests.

Exercises the persistence flow the settings menu will drive: read the
current merged view, apply a user patch, write the result via
`saveSettings` (the only persistence path), and read the file back from
disk to verify the round-trip.

The actual TUI is harder to drive from a Python test (it needs a real
terminal and key events); this suite targets the data path that the TUI
ultimately calls. The TUI itself is covered by tests/test_settings_menu.mjs.
"""
from __future__ import annotations

import json
import os
import shutil
import tempfile
from pathlib import Path

import pytest
from conftest import run_harness


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _apply(patch: dict, cwd: str | None = None, global_dir: str | None = None) -> dict:
    """Run the harness applySettingsChange command and return the result.

    `global_dir` redirects PI_AGENT_DIR so the harness's getSettings()
    call reads from an empty temp dir (instead of polluting or being
    polluted by the real ~/.pi/agent/).
    """
    cmd: dict = {"cmd": "applySettingsChange", "patch": patch}
    if cwd is not None:
        cmd["cwd"] = cwd
    if global_dir is not None:
        cmd["globalDir"] = global_dir
    return run_harness(cmd)


@pytest.fixture
def fresh_cwd(tmp_path: Path) -> str:
    """An empty tmp dir used as cwd for the menu's save path.

    The menu writes to <cwd>/.pi/ask-user-question.json — this fixture
    gives that file a clean home per test.
    """
    return str(tmp_path)


@pytest.fixture
def empty_global_dir(tmp_path: Path) -> str:
    """A fresh tmp dir used as PI_AGENT_DIR for the harness subprocess."""
    return str(tmp_path)


# ---------------------------------------------------------------------------
# 1. boolean field round-trip
# ---------------------------------------------------------------------------


def test_apply_boolean_field_writes_file_with_that_field_set(
    fresh_cwd: str, empty_global_dir: str
):
    """A boolean patch writes the project file with that boolean set."""
    r = _apply({"bellOnQuestion": False}, cwd=fresh_cwd, global_dir=empty_global_dir)
    assert r["ok"] is True
    assert r["fileExists"] is True
    assert r["fileContent"]["bellOnQuestion"] is False


# ---------------------------------------------------------------------------
# 2. round-trip across 3 fields
# ---------------------------------------------------------------------------


def test_apply_three_changes_round_trip(fresh_cwd: str, empty_global_dir: str):
    """Apply 3 changes across 3 different fields; all 3 are correct on read-back."""
    r = _apply(
        {
            "bellOnQuestion": False,
            "notificationDelaySeconds": 60,
            "ttsOnQuestion": True,
        },
        cwd=fresh_cwd,
        global_dir=empty_global_dir,
    )
    assert r["ok"] is True
    fc = r["fileContent"]
    assert fc["bellOnQuestion"] is False
    assert fc["notificationDelaySeconds"] == 60
    assert fc["ttsOnQuestion"] is True
    # Other defaults are preserved in the file (full-merged-view write).
    assert fc["browserEnabled"] is True
    assert fc["dangerCheckEnabled"] is True
    # After-view (getSettings) should reflect all three.
    assert r["after"]["bellOnQuestion"] is False
    assert r["after"]["notificationDelaySeconds"] == 60
    assert r["after"]["ttsOnQuestion"] is True


# ---------------------------------------------------------------------------
# 3. global-only field override creates project file
# ---------------------------------------------------------------------------


def test_apply_change_to_global_only_field_creates_project_file(
    fresh_cwd: str, empty_global_dir: str
):
    """A patch that overrides a default field creates <cwd>/.pi/ask-user-question.json."""
    # bellOnQuestion defaults to true. Setting it to false must write the file.
    project_path = os.path.join(fresh_cwd, ".pi", "ask-user-question.json")
    assert not os.path.exists(project_path), "fixture left a stale file behind"

    r = _apply({"bellOnQuestion": False}, cwd=fresh_cwd, global_dir=empty_global_dir)
    assert r["ok"] is True
    assert os.path.exists(project_path), "project file was not created"
    assert r["projectPath"] == project_path


# ---------------------------------------------------------------------------
# 4. partial patch preserves other fields
# ---------------------------------------------------------------------------


def test_apply_partial_patch_preserves_other_fields_in_file(
    fresh_cwd: str, empty_global_dir: str
):
    """A 1-field patch writes a file that contains ALL 13 fields (full merged view).

    The patch is conceptually `{ bellOnQuestion: false }`, but the file
    is written with the full merged view: every field is present, with
    the patched value where overridden and the merged value elsewhere.
    """
    r = _apply({"bellOnQuestion": False}, cwd=fresh_cwd, global_dir=empty_global_dir)
    assert r["ok"] is True
    fc = r["fileContent"]
    # All 13 fields must be present.
    expected_fields = {
        "browserEnabled",
        "browserAutoOpen",
        "browserMinQuestions",
        "copyUrlToClipboard",
        "bellOnQuestion",
        "notificationOnQuestion",
        "notificationDelaySeconds",
        "ttsOnQuestion",
        "onQuestionCommand",
        "heartbeatWhileActive",
        "heartbeatIntervalMinutes",
        "debounceMs",
        "dangerCheckEnabled",
    }
    assert set(fc.keys()) == expected_fields, (
        f"file keys {set(fc.keys())} != expected {expected_fields}"
    )
    # The patched field is overridden.
    assert fc["bellOnQuestion"] is False
    # Other fields keep their default values (since no global + no prior
    # project file existed before this test).
    assert fc["browserEnabled"] is True
    assert fc["browserMinQuestions"] == 2
    assert fc["notificationDelaySeconds"] == 30


def test_apply_partial_patch_preserves_pre_existing_field_values(
    fresh_cwd: str, empty_global_dir: str
):
    """A patch applied on top of an existing project file does not blow away
    fields that were already set there."""
    project_dir = os.path.join(fresh_cwd, ".pi")
    os.makedirs(project_dir, exist_ok=True)
    project_path = os.path.join(project_dir, "ask-user-question.json")
    # Pre-existing file: browserEnabled = false (an explicit override).
    with open(project_path, "w") as f:
        json.dump({"browserEnabled": False}, f)

    r = _apply({"bellOnQuestion": False}, cwd=fresh_cwd, global_dir=empty_global_dir)
    assert r["ok"] is True
    fc = r["fileContent"]
    # Pre-existing override is preserved.
    assert fc["browserEnabled"] is False
    # New patch is applied.
    assert fc["bellOnQuestion"] is False
    # Defaults are still there.
    assert fc["browserMinQuestions"] == 2


# ---------------------------------------------------------------------------
# 5. number field type preservation
# ---------------------------------------------------------------------------


def test_apply_number_writes_as_number_not_string(
    fresh_cwd: str, empty_global_dir: str
):
    """A number patch must be persisted as a JSON number, not a string."""
    r = _apply(
        {"notificationDelaySeconds": 45},
        cwd=fresh_cwd,
        global_dir=empty_global_dir,
    )
    assert r["ok"] is True
    fc = r["fileContent"]
    assert fc["notificationDelaySeconds"] == 45
    # Read raw to confirm it's not a quoted string.
    with open(r["projectPath"]) as f:
        raw = f.read()
    assert '"notificationDelaySeconds": 45' in raw or '"notificationDelaySeconds":45' in raw, (
        f"expected number literal in raw file; got: {raw[:200]}"
    )


def test_apply_fractional_number_writes_as_number(fresh_cwd: str, empty_global_dir: str):
    """heartbeatIntervalMinutes accepts fractional values (0.5–60)."""
    r = _apply(
        {"heartbeatIntervalMinutes": 2.5},
        cwd=fresh_cwd,
        global_dir=empty_global_dir,
    )
    assert r["ok"] is True
    assert r["fileContent"]["heartbeatIntervalMinutes"] == 2.5


# ---------------------------------------------------------------------------
# 6. invalid input rejection (out-of-range)
# ---------------------------------------------------------------------------


def test_apply_out_of_range_number_is_clamped_or_rejected(
    fresh_cwd: str, empty_global_dir: str
):
    """A patch that violates range constraints is rejected by the sanitizer.

    The merge layer in `getSettings()` re-validates:
    notificationDelaySeconds must be in [0, 300]. A patch of -5 is
    rejected by `sanitize()`, so the merged view falls back to the
    default (30). The contract:

    - `after` (the post-`getSettings()` view) MUST NOT contain -5.
    - The TUI is the gatekeeper that prevents -5 from being saved in
      the first place; the data layer's sanitizer is the safety net.

    This test pins down the safety-net contract.
    """
    r = _apply(
        {"notificationDelaySeconds": -5},
        cwd=fresh_cwd,
        global_dir=empty_global_dir,
    )
    # Post-sanitize view: -5 is dropped, defaults to 30.
    assert r["after"]["notificationDelaySeconds"] == 30
    # saveSettings itself is permissive (it writes the raw merged view
    # so a future bug fix in sanitize() can be observed), but the resolved
    # after-view is what consumers see via getSettings().
    # The TUI test (tests/test_settings_menu.mjs) verifies that the menu
    # refuses to dispatch -5 to onChange in the first place.


# ---------------------------------------------------------------------------
# 7. file path resolution
# ---------------------------------------------------------------------------


def test_apply_writes_to_cwd_pi_subdir_not_elsewhere(
    fresh_cwd: str, empty_global_dir: str
):
    """The file must be created at <cwd>/.pi/ask-user-question.json."""
    r = _apply({"bellOnQuestion": False}, cwd=fresh_cwd, global_dir=empty_global_dir)
    expected = os.path.join(fresh_cwd, ".pi", "ask-user-question.json")
    assert r["projectPath"] == expected
    assert os.path.exists(expected)
    # And nowhere else relevant.
    assert not os.path.exists(os.path.join(fresh_cwd, "ask-user-question.json"))
    # Global file is not touched (the menu only writes the project layer).
    global_path = os.path.join(empty_global_dir, "ask-user-question.json")
    assert not os.path.exists(global_path)


def test_apply_creates_pi_subdir_if_missing(fresh_cwd: str, empty_global_dir: str):
    """saveSettings must mkdir -p the .pi/ subdir if it doesn't exist."""
    pi_dir = os.path.join(fresh_cwd, ".pi")
    assert not os.path.exists(pi_dir)
    r = _apply({"bellOnQuestion": False}, cwd=fresh_cwd, global_dir=empty_global_dir)
    assert r["ok"] is True
    assert os.path.isdir(pi_dir)
    assert os.path.isfile(os.path.join(pi_dir, "ask-user-question.json"))


# ---------------------------------------------------------------------------
# 8. empty patch is a no-op write (still writes the full merged view)
# ---------------------------------------------------------------------------


def test_apply_empty_patch_writes_defaults(fresh_cwd: str, empty_global_dir: str):
    """An empty patch is allowed: writes the full default view."""
    r = _apply({}, cwd=fresh_cwd, global_dir=empty_global_dir)
    assert r["ok"] is True
    fc = r["fileContent"]
    assert fc["bellOnQuestion"] is True  # default
    assert fc["browserMinQuestions"] == 2  # default


# ---------------------------------------------------------------------------
# 9. multiple sequential patches accumulate
# ---------------------------------------------------------------------------


def test_sequential_patches_accumulate(fresh_cwd: str, empty_global_dir: str):
    """Two patches applied in sequence both persist (the second sees the first)."""
    _apply({"bellOnQuestion": False}, cwd=fresh_cwd, global_dir=empty_global_dir)
    r2 = _apply(
        {"notificationDelaySeconds": 120},
        cwd=fresh_cwd,
        global_dir=empty_global_dir,
    )
    fc = r2["fileContent"]
    assert fc["bellOnQuestion"] is False  # from first patch
    assert fc["notificationDelaySeconds"] == 120  # from second patch