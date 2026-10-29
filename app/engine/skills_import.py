"""Copy local skill files into `.ai/cezar/skills`.

The sources are the directories the engine already scans. Nothing is cloned
and nothing is fetched.
"""

from __future__ import annotations

from pathlib import Path

from app.engine.skills import load_skills

_INSTALLED = Path(".ai") / "cezar" / "skills"


def importable_skills(repo: Path) -> list[dict[str, str]]:
    installed = repo / _INSTALLED
    rows: list[dict[str, str]] = []
    for skill in load_skills(repo):
        path = Path(skill.path)
        try:
            path.resolve().relative_to(installed.resolve())
        except ValueError:
            rows.append({"name": skill.name, "description": skill.description, "path": str(path)})
    return rows


def refresh_local_skills(repo: Path) -> list[str]:
    dest_root = repo / _INSTALLED
    dest_root.mkdir(parents=True, exist_ok=True)
    copied: list[str] = []
    for item in importable_skills(repo):
        dest = dest_root / f"{item['name']}.md"
        if dest.exists():
            continue
        dest.write_bytes(Path(item["path"]).read_bytes())
        copied.append(item["name"])
    return copied
