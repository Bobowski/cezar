"""One git worktree per task, on `cez/<id8>`, forked from the base we record.

Nothing here merges. Fetch is skipped under the dry-run, matching the TypeScript helper.
A ref that starts with `-` is refused before it can become a git option.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

WORKTREES_DIR = Path(".ai") / "cezar" / "worktrees"
DIFF_CAP = 400_000
_SHA = re.compile(r"^[0-9a-fA-F]{7,64}$")
_RUN_DIR = re.compile(r"^[0-9a-f]{32}$")


class WorktreeError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class Diff:
    text: str
    files: int
    adds: int
    dels: int
    truncated: bool


def is_safe_git_ref(ref: str) -> bool:
    return len(ref) > 0 and not ref.startswith("-")


def branch_for(run_id: str) -> str:
    return f"cez/{run_id[:8]}"


def git(cwd: Path, args: list[str], timeout: float = 30) -> tuple[bool, str, str]:
    # The cockpit was pointed at this repo. In a container the process uid often
    # does not own it, and git then refuses with "dubious ownership" — which would
    # make every task look like a non-git directory and run in place.
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
    if "GIT_CONFIG_COUNT" not in env:
        env["GIT_CONFIG_COUNT"] = "1"
        env["GIT_CONFIG_KEY_0"] = "safe.directory"
        env["GIT_CONFIG_VALUE_0"] = "*"
    try:
        proc = subprocess.run(
            ["git", *args],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            env=env,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, "", str(exc)
    return proc.returncode == 0, proc.stdout, proc.stderr


def is_git_repo(path: Path) -> bool:
    ok, out, _err = git(path, ["rev-parse", "--is-inside-work-tree"])
    return ok and out.strip() == "true"


def head_branch(repo: Path) -> str:
    ok, out, _err = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])
    name = out.strip() if ok else ""
    if not name or name == "HEAD" or not is_safe_git_ref(name):
        return "main"
    return name


def fork_sha(repo: Path, base: str, *, fetch: bool) -> str:
    if not is_safe_git_ref(base):
        raise WorktreeError(f"refusing option-like base ref: {base}")
    ok, _out, err = git(repo, ["check-ref-format", "--branch", base])
    if not ok:
        raise WorktreeError(err.strip() or f"refusing base ref: {base}")
    if fetch:
        # Best effort. A missing remote or an offline machine leaves the local ref.
        git(repo, ["fetch", "--quiet", "--no-tags", "origin", base], timeout=8)
    remote = f"origin/{base}"
    if not is_safe_git_ref(remote):
        raise WorktreeError(f"refusing option-like base ref: {remote}")
    ok, _out, _err = git(repo, ["rev-parse", "--verify", "--quiet", remote])
    start = remote if ok else base
    ok, sha, err = git(repo, ["rev-parse", "--verify", start])
    if not ok:
        raise WorktreeError(err.strip() or f"unknown base {base}")
    pinned = sha.strip()
    if not _SHA.fullmatch(pinned):
        raise WorktreeError(f"refusing base that is not a commit: {base}")
    return pinned


def create_worktree(repo: Path, run_id: str, base: str, *, fetch: bool) -> tuple[Path, str, str]:
    """Return `(path, branch, base_sha)`. Failure leaves the main tree untouched."""
    if not _RUN_DIR.fullmatch(run_id):
        raise WorktreeError("refusing worktree id")
    branch = branch_for(run_id)
    if not is_safe_git_ref(branch):
        raise WorktreeError(f"refusing option-like branch name: {branch}")
    sha = fork_sha(repo, base, fetch=fetch)
    path = (repo / WORKTREES_DIR / run_id).resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    git(repo, ["worktree", "prune"])
    if path.exists():
        raise WorktreeError(f"worktree path already exists: {path}")
    ok, _out, err = git(repo, ["worktree", "add", "-b", branch, str(path), sha])
    if not ok:
        raise WorktreeError(err.strip() or "git worktree add failed")
    return path, branch, sha


def drop_worktree_dir(repo: Path, path: Path) -> bool:
    """Remove the worktree directory and keep the branch. True when the directory is gone."""
    if path.exists():
        git(repo, ["worktree", "remove", "--force", str(path)])
        if path.exists():
            shutil.rmtree(path, ignore_errors=True)
    git(repo, ["worktree", "prune"])
    return not path.exists()


def remove_worktree(repo: Path, path: Path, branch: str) -> None:
    if path.exists():
        git(repo, ["worktree", "remove", "--force", str(path)])
        if path.exists():
            shutil.rmtree(path, ignore_errors=True)
    git(repo, ["worktree", "prune"])
    if branch.startswith("cez/") and is_safe_git_ref(branch):
        git(repo, ["branch", "-D", branch])


def prune_orphans(repo: Path, known_ids: set[str]) -> list[str]:
    """Remove worktree directories whose run id is not in the database. Keep every known run."""
    root = repo / WORKTREES_DIR
    if not root.is_dir():
        return []
    removed: list[str] = []
    for child in list(root.iterdir()):
        if not _RUN_DIR.fullmatch(child.name) or child.name in known_ids:
            continue
        remove_worktree(repo, child, branch_for(child.name))
        removed.append(child.name)
    return removed


def diff_against(cwd: Path, base_sha: str, cap: int = DIFF_CAP) -> Diff:
    if not _SHA.fullmatch(base_sha):
        return Diff("missing base", 0, 0, 0, False)
    _ok, patch, _err = git(cwd, ["diff", "--find-renames", base_sha])
    _ok, numstat, _err = git(cwd, ["diff", "--numstat", base_sha])
    adds = dels = files = 0
    for line in numstat.splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        files += 1
        if parts[0].isdigit():
            adds += int(parts[0])
        if parts[1].isdigit():
            dels += int(parts[1])
    extra: list[str] = []
    _ok, status, _err = git(cwd, ["status", "--porcelain", "-uall"])
    for line in status.splitlines():
        if len(line) < 4 or line[:2] != "??":
            continue
        rel = line[3:]
        file = cwd / rel
        if not file.is_file():
            continue
        files += 1
        text = file.read_text(encoding="utf-8", errors="replace")
        adds += text.count("\n") or (1 if text else 0)
        extra.append(f"diff --git a/{rel} b/{rel}\nnew file mode 100644\n{text}")
    body = patch
    if extra:
        body = f"{patch}\n" + "\n".join(extra) if patch else "\n".join(extra)
    truncated = len(body) > cap
    if truncated:
        body = body[:cap] + "\n… diff truncated\n"
    return Diff(body, files, adds, dels, truncated)


def log_count(repo: Path) -> int:
    ok, out, _err = git(repo, ["rev-list", "--count", "HEAD"])
    if not ok:
        return 0
    try:
        return int(out.strip())
    except ValueError:
        return 0
