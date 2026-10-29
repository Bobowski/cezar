"""The settings editors' files.

Instructions live in the repo. Agent config is addressed by catalog id, never
by a client path, and a hosted cockpit refuses the write. Accounts live in the
data directory, separate from workspace config.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

from app.config import Config

CATALOG = {
    "agents-md": "AGENTS.md",
    "claude-project": ".claude/settings.json",
    "claude-local": ".claude/settings.local.json",
}
BRANCH_NAMING_MAX = 2_000
PROMPT_MAX = 20_000
SHORTCUTS = frozenset({"mod+enter", "mod+shift+enter", "enter"})


def instructions_path(root: Path) -> Path:
    return root / ".ai" / "cezar" / "instructions.json"


def read_instructions(root: Path) -> dict[str, str]:
    path = instructions_path(root)
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except OSError, json.JSONDecodeError:
        return {"systemPrompt": "", "branchNaming": ""}
    if not isinstance(loaded, dict):
        return {"systemPrompt": "", "branchNaming": ""}
    prompt = loaded.get("systemPrompt")
    naming = loaded.get("branchNaming")
    return {
        "systemPrompt": prompt if isinstance(prompt, str) else "",
        "branchNaming": naming if isinstance(naming, str) else "",
    }


def write_instructions(root: Path, prompt: str, naming: str) -> str | None:
    if len(prompt) > PROMPT_MAX:
        return f"system prompt is at most {PROMPT_MAX} characters"
    if len(naming) > BRANCH_NAMING_MAX:
        return f"branch naming is at most {BRANCH_NAMING_MAX} characters"
    path = instructions_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"systemPrompt": prompt, "branchNaming": naming}, indent=2) + "\n",
        encoding="utf-8",
    )
    return None


def read_agent_file(root: Path, file_id: str) -> tuple[str, str] | None:
    relative = CATALOG.get(file_id)
    if relative is None:
        return None
    path = root / relative
    try:
        return relative, path.read_text(encoding="utf-8") if path.is_file() else ""
    except OSError:
        return relative, ""


def write_agent_file(root: Path, file_id: str, text: str, *, hosted: bool) -> str | None:
    if hosted:
        return "agent config writes are local-only"
    relative = CATALOG.get(file_id)
    if relative is None:
        return "unknown config file"
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return None


def accounts_path(config: Config) -> Path:
    return config.data_dir / "agent-accounts.json"


def list_accounts(config: Config) -> list[dict[str, str]]:
    try:
        loaded = json.loads(accounts_path(config).read_text(encoding="utf-8"))
    except OSError, json.JSONDecodeError:
        return []
    if not isinstance(loaded, list):
        return []
    rows = []
    for item in loaded:
        if isinstance(item, dict) and isinstance(item.get("name"), str):
            rows.append(
                {
                    "id": str(item.get("id", "")),
                    "name": item["name"],
                    "runner": str(item.get("runner", "claude")),
                }
            )
    return rows


def add_account(config: Config, name: str, runner: str) -> str | None:
    if not name.strip() or len(name) > 80:
        return "name must be 1 to 80 characters"
    if runner not in ("claude", "codex", "opencode", "cursor", "pi", "junie", "copilot"):
        return "unknown runner"
    rows = list_accounts(config)
    rows.append({"id": uuid.uuid4().hex, "name": name.strip(), "runner": runner})
    path = accounts_path(config)
    path.write_text(json.dumps(rows, indent=2) + "\n", encoding="utf-8")
    return None
