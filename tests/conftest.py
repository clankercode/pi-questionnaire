# tests/conftest.py
"""Shared pytest fixtures for pi-questionnaire tests.

The core logic lives in TypeScript (src/*.ts). We drive it from Python via a
small TS harness (tests/harness.ts) that reads JSON commands on stdin and
emits JSON results on stdout. This keeps the test target the actual code
that ships, with no parallel "test mode" implementation.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
HARNESS = REPO_ROOT / "tests" / "harness.ts"


def _harness_path() -> Path:
    if not HARNESS.exists():
        pytest.skip(f"harness not built: {HARNESS}")
    return HARNESS


def _tsx() -> str:
    """Find tsx binary."""
    candidates = [
        REPO_ROOT / "node_modules" / ".bin" / "tsx",
        REPO_ROOT / "node_modules" / ".bin" / "tsx.cmd",
    ]
    for c in candidates:
        if c.exists():
            return str(c)
    # Fallback: pnpm dlx
    return shutil.which("tsx") or shutil.which("npx") or "npx"


def run_harness(cmd: dict[str, Any]) -> Any:
    """Run the TS harness with one JSON command and return the parsed result."""
    tsx = _tsx()
    payload = json.dumps(cmd).encode("utf-8")
    if tsx.endswith("npx"):
        proc = subprocess.run(
            ["npx", "tsx", str(_harness_path())],
            input=payload,
            capture_output=True,
            check=False,
            cwd=str(REPO_ROOT),
            timeout=30,
        )
    else:
        proc = subprocess.run(
            [tsx, str(_harness_path())],
            input=payload,
            capture_output=True,
            check=False,
            cwd=str(REPO_ROOT),
            timeout=30,
        )
    if proc.returncode != 0:
        raise RuntimeError(
            f"harness failed (rc={proc.returncode}): stderr={proc.stderr.decode('utf-8', errors='replace')}"
        )
    out = proc.stdout.decode("utf-8").strip()
    if not out:
        raise RuntimeError(f"harness produced no output. stderr={proc.stderr.decode('utf-8', errors='replace')}")
    return json.loads(out)


@pytest.fixture
def tmp_answers_file(tmp_path: Path):
    """Factory: write a JSON answer file to a tmp path, return the path."""
    def _factory(data: dict[str, Any]) -> Path:
        p = tmp_path / "answers.json"
        p.write_text(json.dumps(data))
        return p
    return _factory


@pytest.fixture
def monorepo_path() -> Path:
    return REPO_ROOT
