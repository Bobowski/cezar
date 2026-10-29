"""Which agent CLIs are on PATH, and the model ids the cockpit can name.

This is not the TypeScript catalog probe: that spawns each CLI. A missing
binary is `{available: false}`. A present binary lists the ids this port knows
how to pass as `--model`, not whatever the CLI would print today.
"""

from __future__ import annotations

import shutil

MODELS: dict[str, tuple[str, ...]] = {
    "claude": ("claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"),
    "codex": ("gpt-5.1-codex",),
    "opencode": ("opencode",),
    "cursor": ("auto",),
    "junie": ("junie",),
    "pi": ("pi",),
    "copilot": ("gpt-4.1",),
}

DISCOVERY = frozenset({"claude", "codex", "opencode", "cursor", "junie"})


def provider_status(bins: dict[str, str]) -> dict[str, object]:
    providers = []
    for name, binary in bins.items():
        found = shutil.which(binary) is not None
        providers.append({"provider": name, "installed": found, "enabled": found, "binary": binary})
    return {"providers": providers}


def model_catalog(runner: str, bins: dict[str, str]) -> dict[str, object]:
    if runner not in DISCOVERY and runner not in MODELS:
        return {
            "available": False,
            "reason": "runner must be claude, codex, opencode, cursor, or junie",
        }
    binary = bins.get(runner, runner)
    if shutil.which(binary) is None:
        return {"available": False, "reason": f"`{binary}` not found on PATH"}
    return {"available": True, "runner": runner, "models": list(MODELS.get(runner, ()))}
