"""Run instructions from `.ai/cezar/instructions.json`, then `config.json`.

`systemPrompt` is prepended to the agent prompt. `branchNaming` replaces
`cez/<id8>` when it names a prefix (`start with feature/`). The TypeScript
namer asks a model; this port builds a sanitized slug of the task instead,
and keeps `cez/<id8>` when that slug is not a valid branch.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

_PREFIX = re.compile(r"start with\s+([A-Za-z0-9._/-]+)", re.IGNORECASE)
_MAX = 80


def run_instructions(root: Path) -> tuple[str, str]:
    prompt, naming = _pair(root / ".ai" / "cezar" / "instructions.json")
    fallback_prompt, fallback_naming = _pair(root / ".ai" / "cezar" / "config.json")
    return prompt or fallback_prompt, naming or fallback_naming


def branch_from_instructions(task: str, naming: str, run_id: str) -> str | None:
    if not naming.strip():
        return None
    found = _PREFIX.search(naming)
    if found is None:
        return None
    prefix = found.group(1)
    if not prefix.endswith("/"):
        prefix += "/"
    slug = _sanitize(task) or "task"
    name = _sanitize(f"{prefix}{slug}")
    if name is None:
        return None
    suffix = run_id[:8]
    if not name.endswith(suffix):
        room = _MAX - len(suffix) - 1
        trimmed = name[:room].rstrip("./-") if len(name) > room else name
        name = f"{trimmed}-{suffix}"
    return _sanitize(name)


def _pair(path: Path) -> tuple[str, str]:
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except OSError, json.JSONDecodeError:
        return "", ""
    if not isinstance(loaded, dict):
        return "", ""
    prompt = loaded.get("systemPrompt")
    naming = loaded.get("branchNaming")
    return (
        prompt.strip() if isinstance(prompt, str) else "",
        naming.strip() if isinstance(naming, str) else "",
    )


def _sanitize(raw: str) -> str | None:
    name = re.sub(r"\s+", "-", raw.strip().strip("`"))
    name = re.sub(r"[^A-Za-z0-9._/-]", "", name)
    name = re.sub(r"\.\.+", ".", name)
    name = name.replace("@{", "")
    name = re.sub(r"-{2,}", "-", name)
    name = re.sub(r"/{2,}", "/", name)
    name = re.sub(r"\.lock(?=/|$)", "", name)
    parts = [part.strip(".-") for part in name.split("/")]
    name = "/".join(part for part in parts if part)
    if len(name) > _MAX:
        name = name[:_MAX].rstrip("./-")
    if not name or name.startswith("-"):
        return None
    return name
