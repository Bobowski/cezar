"""Settings pages that were still a heading: tasks, tracker, global instructions,
global skills, and resources.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from litewriter import LiteWriter
from stario import App, Context, Writer, h
from stario.datastar import read_signals
from stario.exceptions import RequestBodyError
from stario.markup import HtmlElement

from app.common.shell import frame, load_chrome
from app.config import Config
from app.engine.engine import Engine
from app.features.settings import workspace_views as views
from app.features.settings.nav import settings_nav
from app.features.settings.store import (
    parse_checks,
    parse_memory,
    parse_prompt,
    parse_skill_repo,
    parse_tracker,
    read_checks,
    read_memory,
    read_prompt,
    read_skill_repos,
    read_tracker,
    write_checks,
    write_memory,
    write_prompt,
    write_skill_repos,
    write_tracker,
)
from app.features.settings.urls import (
    GLOBAL_INSTRUCTIONS,
    GLOBAL_INSTRUCTIONS_SAVE,
    GLOBAL_SKILLS,
    GLOBAL_SKILLS_REMOVE,
    GLOBAL_SKILLS_SAVE,
    RESOURCES,
    RESOURCES_SAVE,
    TASKS_SETTINGS,
    TASKS_SETTINGS_SAVE,
    TRACKER_SETTINGS,
    TRACKER_SETTINGS_SAVE,
)
from app.store.db import get_project


@dataclass(frozen=True, slots=True)
class WorkspaceSettings:
    db: LiteWriter
    engine: Engine
    config: Config

    def register(self, app: App) -> None:
        app.add(TASKS_SETTINGS, self.tasks)
        app.add(TASKS_SETTINGS_SAVE, self.save_tasks)
        app.add(TRACKER_SETTINGS, self.tracker)
        app.add(TRACKER_SETTINGS_SAVE, self.save_tracker)
        app.add(GLOBAL_INSTRUCTIONS, self.instructions)
        app.add(GLOBAL_INSTRUCTIONS_SAVE, self.save_instructions)
        app.add(GLOBAL_SKILLS, self.skills)
        app.add(GLOBAL_SKILLS_SAVE, self.save_skill)
        app.add(GLOBAL_SKILLS_REMOVE, self.remove_skill)
        app.add(RESOURCES, self.resources)
        app.add(RESOURCES_SAVE, self.save_resources)

    async def tasks(self, _c: Context, w: Writer) -> None:
        project = get_project(self.db, self.engine.boot_project_id)
        branch = project.base_branch if project else "main"
        checks = read_checks(self.config.data_dir, self.engine.boot_project_id)
        w.html(
            self._page(
                "Tasks",
                "task-settings",
                {"branch": branch, "checks": ", ".join(checks)},
                *views.tasks(branch, checks),
            )
        )

    async def save_tasks(self, c: Context, w: Writer) -> None:
        signals = await _signals(c, w)
        if signals is None:
            return
        branch = str(signals.get("branch", "")).strip()
        checks, issue = parse_checks(str(signals.get("checks", "")))
        if issue or checks is None:
            w.text(issue or "invalid checks", 400)
            return
        reason = await self.engine.set_base_branch(self.engine.boot_project_id, branch)
        if reason:
            w.text(reason, 404 if reason == "not found" else 400)
            return
        write_checks(self.config.data_dir, self.engine.boot_project_id, checks)
        w.redirect(TASKS_SETTINGS.href(), 303)

    async def tracker(self, _c: Context, w: Writer) -> None:
        row = read_tracker(self.config.data_dir)
        w.html(
            self._page(
                "Tracker",
                "tracker-settings",
                {"kind": row.kind, "site": row.site, "email": row.email, "token": ""},
                *views.tracker(row),
            )
        )

    async def save_tracker(self, c: Context, w: Writer) -> None:
        signals = await _signals(c, w)
        if signals is None:
            return
        previous = read_tracker(self.config.data_dir)
        row, issue = parse_tracker(
            str(signals.get("kind", "jira")),
            str(signals.get("site", "")),
            str(signals.get("email", "")),
            str(signals.get("token", "")),
            previous.token,
        )
        if issue or row is None:
            w.text(issue or "invalid tracker", 400)
            return
        write_tracker(self.config.data_dir, row)
        w.redirect(TRACKER_SETTINGS.href(), 303)

    async def instructions(self, _c: Context, w: Writer) -> None:
        prompt = read_prompt(self.config.data_dir)
        w.html(
            self._page(
                "Global instructions",
                "global-instructions",
                {"prompt": prompt},
                *views.instructions(prompt),
            )
        )

    async def save_instructions(self, c: Context, w: Writer) -> None:
        signals = await _signals(c, w)
        if signals is None:
            return
        prompt = str(signals.get("prompt", ""))
        issue = parse_prompt(prompt)
        if issue:
            w.text(issue, 400)
            return
        write_prompt(self.config.data_dir, prompt.strip())
        w.redirect(GLOBAL_INSTRUCTIONS.href(), 303)

    async def skills(self, _c: Context, w: Writer) -> None:
        rows = read_skill_repos(self.config.data_dir)
        w.html(
            self._page(
                "Skills",
                "global-skills",
                {"repo": "", "ref": "main"},
                *views.skills(rows),
            )
        )

    async def save_skill(self, c: Context, w: Writer) -> None:
        signals = await _signals(c, w)
        if signals is None:
            return
        row, issue = parse_skill_repo(str(signals.get("repo", "")), str(signals.get("ref", "")))
        if issue or row is None:
            w.text(issue or "invalid repo", 400)
            return
        rows = [item for item in read_skill_repos(self.config.data_dir) if item.repo != row.repo]
        rows.append(row)
        write_skill_repos(self.config.data_dir, rows)
        w.redirect(GLOBAL_SKILLS.href(), 303)

    async def remove_skill(self, c: Context, w: Writer) -> None:
        signals = await _signals(c, w)
        if signals is None:
            return
        repo = str(signals.get("repo", "")).strip()
        rows = [item for item in read_skill_repos(self.config.data_dir) if item.repo != repo]
        write_skill_repos(self.config.data_dir, rows)
        w.redirect(GLOBAL_SKILLS.href(), 303)

    async def resources(self, _c: Context, w: Writer) -> None:
        limit = read_memory(self.config.data_dir)
        w.html(
            self._page(
                "Resources",
                "resources",
                {"memory": "" if limit is None else str(limit)},
                *views.resources(limit),
            )
        )

    async def save_resources(self, c: Context, w: Writer) -> None:
        signals = await _signals(c, w)
        if signals is None:
            return
        limit, issue = parse_memory(signals.get("memory", ""))
        if issue:
            w.text(issue, 400)
            return
        write_memory(self.config.data_dir, limit)
        w.redirect(RESOURCES.href(), 303)

    def _page(self, title: str, element_id: str, signals: dict[str, str], *children: HtmlElement):
        chrome = load_chrome(self.db, self.config, title, "settings", self.engine.boot_project_id)
        payload: dict[str, str] = {"tab": uuid.uuid7().hex}
        payload.update(signals)
        return frame(
            chrome,
            None,
            payload,
            h.Main({"id": element_id}, settings_nav(), h.H1(title), *children),
        )


async def _signals(c: Context, w: Writer) -> dict[str, object] | None:
    try:
        loaded = await read_signals(c.req)
    except RequestBodyError:
        w.text("invalid input", 400)
        return None
    if not isinstance(loaded, dict):
        w.text("invalid input", 400)
        return None
    tab = str(loaded.get("tab", ""))
    if tab and not (tab.isalnum() and len(tab) <= 32):
        w.text("tab must be a short id", 400)
        return None
    return loaded
