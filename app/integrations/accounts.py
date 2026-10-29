"""Local agent accounts.

Claude and Codex get a directory under the data dir and the runner injects
`CLAUDE_CONFIG_DIR` or `CODEX_HOME`. The other runners have no such variable,
so they stay on the default login. A hosted cockpit refuses new accounts
unless `CEZ_REMOTE_AGENT_ACCOUNTS=1`.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

from app.config import Config, agent_accounts_enabled

_RUNNERS = ("claude", "codex", "opencode", "cursor", "pi", "junie", "copilot")
_HOMES = {"claude": "CLAUDE_CONFIG_DIR", "codex": "CODEX_HOME"}
_HOSTED = (
    "agent accounts are disabled in hosted mode; "
    "set CEZ_REMOTE_AGENT_ACCOUNTS=1 only behind an authenticated perimeter"
)


def accounts_path(config: Config) -> Path:
    return config.data_dir / "agent-accounts.json"


def list_accounts(config: Config) -> list[dict[str, str]]:
    rows = _load(config)
    return [
        {"id": row["id"], "name": row["name"], "runner": row["runner"], "home": row["home"]}
        for row in rows
    ]


def add_account(config: Config, name: str, runner: str) -> str | None:
    if not agent_accounts_enabled(config):
        return _HOSTED
    cleaned = name.strip()
    if not cleaned or len(cleaned) > 80:
        return "name must be 1 to 80 characters"
    if runner not in _RUNNERS:
        return "unknown runner"
    rows = _load(config)
    account_id = uuid.uuid4().hex
    home = ""
    if runner in _HOMES:
        directory = config.data_dir / "agent-homes" / account_id
        directory.mkdir(parents=True, exist_ok=True)
        home = str(directory)
    rows.append({"id": account_id, "name": cleaned, "runner": runner, "home": home})
    _save(config, rows)
    return None


def profile_home_for(config: Config, account_id: str, runner: str) -> str | None:
    """The home to inject, `""` when this runner cannot carry one, or None if unknown."""
    if not account_id:
        return ""
    for row in _load(config):
        if row["id"] == account_id:
            if runner not in _HOMES:
                return ""
            return row["home"]
    return None


def _load(config: Config) -> list[dict[str, str]]:
    try:
        loaded = json.loads(accounts_path(config).read_text(encoding="utf-8"))
    except OSError, json.JSONDecodeError:
        return []
    if not isinstance(loaded, list):
        return []
    rows: list[dict[str, str]] = []
    for item in loaded:
        if isinstance(item, dict) and isinstance(item.get("name"), str):
            rows.append(
                {
                    "id": str(item.get("id", "")),
                    "name": item["name"],
                    "runner": str(item.get("runner", "claude")),
                    "home": str(item.get("home", "")),
                }
            )
    return rows


def _save(config: Config, rows: list[dict[str, str]]) -> None:
    path = accounts_path(config)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(rows, indent=2) + "\n", encoding="utf-8")
