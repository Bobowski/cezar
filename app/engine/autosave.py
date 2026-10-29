"""Janitor commits on a task branch.

`periodic` is the opt-in timer (`CEZ_AUTOSAVE=1`). Turn end, run finalize, and
pre-PR always run, matching `autosaveCommit` in `git-worktree.ts`. A worktree
that is mid-merge is left dirty: committing it would record a conflict.
"""

from __future__ import annotations

from pathlib import Path

from app.engine.gitwork import git

_UNMERGED = frozenset({"UU", "AA", "DD", "AU", "UA", "DU", "UD"})


def autosave_commit(cwd: Path, reason: str) -> str:
    """`committed`, `nothing`, `refused`, or `skipped` when git cannot run.

    Signing is off. A janitor commit must not wait on `ssh-keygen -Y sign`.
    """
    ok, status, _err = git(cwd, ["status", "--porcelain"])
    if not ok:
        return "skipped"
    if not status.strip():
        return "nothing"
    for line in status.splitlines():
        if line[:2] in _UNMERGED:
            return "refused"
    git(cwd, ["add", "-A"])
    args = ["-c", "commit.gpgsign=false", "commit", "-m", f"cezar autosave ({reason})"]
    named, name, _err = git(cwd, ["config", "user.name"])
    if not named or not name.strip():
        args = ["-c", "user.name=cezar", "-c", "user.email=cezar@localhost", *args]
    ok, _out, err = git(cwd, args)
    if not ok:
        return "skipped"
    if "nothing" in err.lower():
        return "nothing"
    return "committed"
