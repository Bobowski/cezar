"""Janitor commits on a task branch.

`periodic` is the opt-in timer (`CEZ_AUTOSAVE=1`). Turn end, run finalize, and
pre-PR always run, matching `autosaveCommit` in `git-worktree.ts`. A worktree
that is mid-merge is left dirty: committing it would record a conflict.
"""

from __future__ import annotations

from pathlib import Path

from app.engine.git_actions import commit_all
from app.engine.gitwork import git

_UNMERGED = frozenset({"UU", "AA", "DD", "AU", "UA", "DU", "UD"})


def autosave_commit(cwd: Path, reason: str) -> str:
    """`committed`, `nothing`, `refused`, or `skipped` when git cannot run."""
    ok, status, _err = git(cwd, ["status", "--porcelain"])
    if not ok:
        return "skipped"
    if not status.strip():
        return "nothing"
    for line in status.splitlines():
        if line[:2] in _UNMERGED:
            return "refused"
    result = commit_all(cwd, f"cezar autosave ({reason})")
    if result.get("ok") != "true":
        return "skipped"
    if result.get("result") == "nothing":
        return "nothing"
    return "committed"
