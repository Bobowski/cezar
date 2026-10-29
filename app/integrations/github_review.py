"""Pull-request review and merge.

Dry-run answers without calling `gh` or the network. A real `gh` runs only when
dry-run is off.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

METHODS = frozenset({"merge", "squash", "rebase"})
REVIEWS = frozenset({"approve", "request-changes", "comment"})


def merge_state(number: int, *, dry_run: bool, cwd: Path) -> dict[str, object]:
    if number < 1:
        return {"available": False, "reason": "invalid pull request number"}
    if dry_run:
        return {
            "available": True,
            "dryRun": True,
            "mergeState": {
                "number": number,
                "mergeable": "mergeable",
                "reviewDecision": "approved",
                "eligibility": "ready",
                "canMerge": True,
                "methods": ["merge", "squash", "rebase"],
                "defaultMethod": "squash",
            },
        }
    ok, out, err = _gh(cwd, ["pr", "view", str(number), "--json", "mergeable,reviewDecision,url"])
    if not ok:
        return {"available": False, "reason": err or "gh pr view failed"}
    return {"available": True, "dryRun": False, "raw": out}


def merge_pr(number: int, method: str, *, dry_run: bool, cwd: Path) -> dict[str, object]:
    if number < 1:
        return {"ok": False, "status": 400, "error": "invalid pull request number"}
    if method not in METHODS:
        return {"ok": False, "status": 400, "error": "method must be merge, squash, or rebase"}
    if dry_run:
        return {
            "ok": True,
            "merged": True,
            "number": number,
            "method": method,
            "dryRun": True,
            "url": f"https://github.com/open-mercato/demo/pull/{number}",
            "mergeCommitSha": "0" * 40,
        }
    flag = {"merge": "--merge", "squash": "--squash", "rebase": "--rebase"}[method]
    ok, out, err = _gh(cwd, ["pr", "merge", str(number), flag, "--yes"])
    if not ok:
        return {"ok": False, "status": 409, "error": err or "gh pr merge failed"}
    return {
        "ok": True,
        "merged": True,
        "number": number,
        "method": method,
        "dryRun": False,
        "url": out.strip().splitlines()[-1] if out.strip() else "",
    }


def review_pr(number: int, event: str, body: str, *, dry_run: bool, cwd: Path) -> dict[str, object]:
    if number < 1:
        return {"ok": False, "status": 400, "error": "invalid pull request number"}
    if event not in REVIEWS:
        return {
            "ok": False,
            "status": 400,
            "error": "event must be approve, request-changes, or comment",
        }
    if not body.strip():
        return {"ok": False, "status": 400, "error": "review body is empty"}
    if dry_run:
        return {"ok": True, "submitted": True, "dryRun": True, "event": event, "number": number}
    flag = {
        "approve": "--approve",
        "request-changes": "--request-changes",
        "comment": "--comment",
    }[event]
    ok, _out, err = _gh(cwd, ["pr", "review", str(number), flag, "--body", body])
    if not ok:
        return {"ok": False, "status": 409, "error": err or "gh pr review failed"}
    return {"ok": True, "submitted": True, "dryRun": False, "event": event, "number": number}


def _gh(cwd: Path, args: list[str]) -> tuple[bool, str, str]:
    try:
        proc = subprocess.run(
            ["gh", *args],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, "", str(exc)
    if proc.returncode != 0:
        return False, proc.stdout, (proc.stderr or proc.stdout).strip()
    return True, proc.stdout, ""
