"""Answers the settings pages save and render back.

A base branch is stored on the project by the engine. Required checks, the
tracker connection, the global prompt, org skill repos, and the memory cap
live in this directory. The run loop does not read them.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from stario.json import dumps

from app.integrations.clients import forge_base_issue

_CHECK = re.compile(r"[A-Za-z0-9_-]{1,80}")
_REF = re.compile(r"[A-Za-z0-9._/-]{1,80}")
KINDS = ("jira", "linear")
MEMORY_MIN = 256
MEMORY_MAX = 65_536
PROMPT_MAX = 20_000


def _load(path: Path) -> dict[str, object]:
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except OSError, json.JSONDecodeError:
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _save(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(dumps(payload) + "\n", encoding="utf-8")
    path.chmod(0o600)


def checks_path(data_dir: Path, project_id: str) -> Path:
    return data_dir / "project-settings" / f"{project_id}.json"


def read_checks(data_dir: Path, project_id: str) -> list[str]:
    raw = _load(checks_path(data_dir, project_id)).get("requiredChecks")
    if not isinstance(raw, list):
        return []
    return [item for item in raw if isinstance(item, str)]


def write_checks(data_dir: Path, project_id: str, names: list[str]) -> None:
    _save(checks_path(data_dir, project_id), {"requiredChecks": names})


def parse_checks(raw: str) -> tuple[list[str] | None, str | None]:
    names = [part.strip() for part in raw.split(",") if part.strip()]
    if len(names) > 20:
        return None, "at most 20 required checks"
    for name in names:
        if _CHECK.fullmatch(name) is None:
            return None, "a check name is letters, digits, _ and -"
    return names, None


@dataclass(frozen=True, slots=True)
class TrackerConnection:
    kind: str = "jira"
    site: str = ""
    email: str = ""
    token: str = ""


def tracker_path(data_dir: Path) -> Path:
    return data_dir / "tracker-connection.json"


def read_tracker(data_dir: Path) -> TrackerConnection:
    raw = _load(tracker_path(data_dir))
    kind = raw.get("kind")
    site = raw.get("site")
    email = raw.get("email")
    token = raw.get("token")
    return TrackerConnection(
        kind if isinstance(kind, str) and kind in KINDS else "jira",
        site if isinstance(site, str) else "",
        email if isinstance(email, str) else "",
        token if isinstance(token, str) else "",
    )


def write_tracker(data_dir: Path, row: TrackerConnection) -> None:
    _save(
        tracker_path(data_dir),
        {"kind": row.kind, "site": row.site, "email": row.email, "token": row.token},
    )


def parse_tracker(
    kind: str, site: str, email: str, token: str, previous: str
) -> tuple[TrackerConnection | None, str | None]:
    if kind not in KINDS:
        return None, "tracker is jira or linear"
    site, email, token = site.strip(), email.strip(), token.strip()
    if len(site) > 200 or len(email) > 200 or len(token) > 500:
        return None, "tracker fields are too long"
    if site:
        issue = forge_base_issue(site, "jira" if kind == "jira" else "linear")
        if issue:
            return None, issue
    if kind == "jira" and site and not email:
        return None, "jira needs an email with the site"
    return TrackerConnection(kind, site, email, token or previous), None


def tracker_overrides(data_dir: Path) -> dict[str, str]:
    """Stored credentials win over the process env when the row is complete."""
    row = read_tracker(data_dir)
    if row.kind == "jira" and row.site and row.email and row.token:
        return {"jira_base": row.site, "jira_email": row.email, "jira_token": row.token}
    if row.kind == "linear" and row.token:
        overrides = {"linear_key": row.token}
        if row.site:
            overrides["linear_api"] = row.site
        return overrides
    return {}


def prompt_path(data_dir: Path) -> Path:
    return data_dir / "global-instructions.json"


def read_prompt(data_dir: Path) -> str:
    raw = _load(prompt_path(data_dir)).get("systemPrompt")
    return raw if isinstance(raw, str) else ""


def write_prompt(data_dir: Path, prompt: str) -> None:
    _save(prompt_path(data_dir), {"systemPrompt": prompt})


def parse_prompt(prompt: str) -> str | None:
    if len(prompt) > PROMPT_MAX:
        return f"global prompt is at most {PROMPT_MAX} characters"
    return None


@dataclass(frozen=True, slots=True)
class SkillRepo:
    repo: str
    ref: str


def skills_path(data_dir: Path) -> Path:
    return data_dir / "global-skills.json"


def read_skill_repos(data_dir: Path) -> list[SkillRepo]:
    raw = _load(skills_path(data_dir)).get("repos")
    if not isinstance(raw, list):
        return []
    rows: list[SkillRepo] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        repo = item.get("repo")
        ref = item.get("ref")
        if isinstance(repo, str) and isinstance(ref, str):
            rows.append(SkillRepo(repo, ref))
    return rows


def write_skill_repos(data_dir: Path, rows: list[SkillRepo]) -> None:
    _save(skills_path(data_dir), {"repos": [{"repo": row.repo, "ref": row.ref} for row in rows]})


def parse_skill_repo(repo: str, ref: str) -> tuple[SkillRepo | None, str | None]:
    repo, ref = repo.strip(), ref.strip() or "main"
    if len(repo) > 200:
        return None, "a skill repo URL is at most 200 characters"
    parsed = urlsplit(repo)
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or not host or parsed.username or parsed.password:
        return None, "a skill repo is an https URL without credentials"
    if host in ("localhost", "127.0.0.1", "::1"):
        return None, "a skill repo is not a loopback address"
    if _REF.fullmatch(ref) is None:
        return None, "a ref is letters, digits, and . _ / -"
    return SkillRepo(repo, ref), None


def memory_path(data_dir: Path) -> Path:
    return data_dir / "resources.json"


def read_memory(data_dir: Path) -> int | None:
    raw = _load(memory_path(data_dir)).get("memoryLimitMb")
    if isinstance(raw, int) and not isinstance(raw, bool) and MEMORY_MIN <= raw <= MEMORY_MAX:
        return raw
    return None


def write_memory(data_dir: Path, limit: int | None) -> None:
    _save(memory_path(data_dir), {"memoryLimitMb": limit})


def parse_memory(raw: object) -> tuple[int | None, str | None]:
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return None, None
    if isinstance(raw, str) and raw.isdecimal():
        raw = int(raw)
    if isinstance(raw, bool) or not isinstance(raw, int):
        return None, "memory cap is a number of megabytes, or empty for no limit"
    if not MEMORY_MIN <= raw <= MEMORY_MAX:
        return None, f"memory cap is from {MEMORY_MIN} to {MEMORY_MAX} MB, or empty"
    return raw, None
