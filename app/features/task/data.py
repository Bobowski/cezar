"""Worktree reads the task page and the run API both use."""

from __future__ import annotations

import os
from pathlib import Path

from app.engine.gitwork import git


def list_worktree_files(root: str) -> list[str]:
    if not root:
        return []
    base = Path(root)
    if not base.is_dir():
        return []
    found: list[str] = []
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = [name for name in dirnames if name not in (".git", "node_modules")]
        for name in filenames:
            found.append(str(Path(dirpath, name).relative_to(base)))
            if len(found) >= 200:
                return found
    return found


def list_commits(root: str) -> list[str]:
    if not root:
        return []
    ok, out, _err = git(Path(root), ["log", "--oneline", "-n", "20"])
    if not ok:
        return []
    return [line for line in out.splitlines() if line.strip()]
