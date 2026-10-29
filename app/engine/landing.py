"""Commit what an in-place task left in the checkout.

cezar's own data directory is not staged. Nothing is pushed. A clean tree is
`nothing`. A git failure is `failed` and does not raise.
"""

from __future__ import annotations

from pathlib import Path

from app.engine.gitwork import git


def land_inplace(root: Path) -> dict[str, object]:
    ok, status, err = git(root, ["status", "--porcelain", "--", ".", ":(exclude).ai/cezar"])
    if not ok:
        return {"result": "failed", "stage": "commit", "error": err.strip() or "git status failed"}
    if not status.strip():
        return {"result": "nothing"}
    added, _out, add_err = git(root, ["add", "-A", "--", ".", ":(exclude).ai/cezar"])
    if not added:
        return {"result": "failed", "stage": "commit", "error": add_err.strip() or "git add failed"}
    committed, _cout, commit_err = git(root, ["commit", "-m", "land the task"])
    if not committed:
        return {
            "result": "failed",
            "stage": "commit",
            "error": commit_err.strip() or "git commit failed",
        }
    _ok, sha, _sha_err = git(root, ["rev-parse", "HEAD"])
    files = [line[3:] for line in status.splitlines() if len(line) > 3]
    return {"result": "landed", "sha": sha.strip(), "files": files}


def inplace_requested(root: Path) -> bool:
    path = root / ".ai" / "cezar" / "config.json"
    try:
        import json

        loaded = json.loads(path.read_text(encoding="utf-8"))
    except OSError, ValueError:
        return False
    return isinstance(loaded, dict) and loaded.get("inPlace") is True
