import uuid
from dataclasses import dataclass
from pathlib import Path

from litewriter import LiteWriter
from stario import App, Context, Writer

from app.common.shell import load_chrome
from app.config import Config
from app.engine.catalog import load_workflows
from app.engine.engine import Engine
from app.engine.gitwork import git
from app.engine.providers import provider_status
from app.engine.receipts import is_unread
from app.features.places import views
from app.features.places.urls import (
    COMPARE,
    GITHUB,
    INBOX,
    INBOX_READ,
    REPO,
    SETTINGS_AGENTS,
    SETTINGS_PRIVACY,
    SETTINGS_WEBHOOKS,
    SETTINGS_WORKTREES,
    TRACKER,
    WORKFLOW,
)
from app.integrations.clients import github_issues
from app.integrations.hooks import load_receivers
from app.store.db import get_project, get_run, list_runs


@dataclass(frozen=True, slots=True)
class PlacesPage:
    db: LiteWriter
    engine: Engine
    config: Config

    def register(self, app: App) -> None:
        app.add(INBOX, self.inbox)
        app.add(INBOX_READ, self.inbox_read)
        app.add(GITHUB, self.github)
        app.add(TRACKER, self.tracker)
        app.add(REPO, self.repo)
        app.add(WORKFLOW, self.workflow)
        app.add(COMPARE, self.compare)
        app.add(SETTINGS_PRIVACY, self.privacy)
        app.add(SETTINGS_AGENTS, self.agents)
        app.add(SETTINGS_WEBHOOKS, self.webhooks)
        app.add(SETTINGS_WORKTREES, self.worktrees)

    async def inbox(self, c: Context, w: Writer) -> None:
        project = self.engine.boot_project_id
        rows = [run for run in list_runs(self.db, project, None) if is_unread(run)]
        w.html(views.inbox(rows, self._chrome("Inbox", "tasks"), uuid.uuid7().hex))

    async def inbox_read(self, c: Context, w: Writer) -> None:
        await self.engine.mark_all_read(self.engine.boot_project_id)
        w.redirect(INBOX.href())

    async def github(self, c: Context, w: Writer) -> None:
        owner = c.req.query.get("owner", "")
        repo = c.req.query.get("repo", "")
        if not owner or not repo:
            text = (
                "Add ?owner=&repo= to list open issues. Without a token the answer is unavailable."
            )
        else:
            loaded = github_issues(self.config, owner, repo)
            if loaded.get("available") is not True:
                text = str(loaded.get("reason", "unavailable"))
            else:
                issues = loaded.get("issues")
                rows = issues if isinstance(issues, list) else []
                titles = [str(item.get("title", "")) for item in rows if isinstance(item, dict)]
                text = ", ".join(titles) if titles else "No open issues."
        w.html(views.github(text, self._chrome("GitHub", "github"), uuid.uuid7().hex))

    async def tracker(self, c: Context, w: Writer) -> None:
        w.html(views.tracker(self._chrome("Tracker", "tracker"), uuid.uuid7().hex))

    async def repo(self, c: Context, w: Writer) -> None:
        ok, out, _err = git(self.config.repo_root, ["log", "--oneline", "-n", "20"])
        lines = out.splitlines() if ok else []
        w.html(views.repo(lines, self._chrome("Repository", "git"), uuid.uuid7().hex))

    async def workflow(self, c: Context, w: Writer) -> None:
        name = c.match.params.get("name", "")
        project = get_project(self.db, self.engine.boot_project_id)
        root = Path(project.root) if project else self.config.repo_root
        catalog, _issues = load_workflows(root)
        item = next((workflow for workflow in catalog if workflow.name == name), None)
        w.html(views.workflow(item, self._chrome("Workflow", "workflows"), uuid.uuid7().hex))

    async def compare(self, c: Context, w: Writer) -> None:
        run = get_run(self.db, c.match.params.get("run_id", ""))
        if run is None or not run.group_id:
            w.html(views.compare([], self._chrome("Compare", "tasks"), uuid.uuid7().hex))
            return
        rows = [
            item
            for item in list_runs(self.db, run.project_id, None, limit=50)
            if item.group_id == run.group_id
        ]
        w.html(views.compare(rows, self._chrome("Compare", "tasks"), uuid.uuid7().hex))

    async def privacy(self, c: Context, w: Writer) -> None:
        w.html(views.privacy(self._chrome("Privacy", "settings"), uuid.uuid7().hex))

    async def agents(self, c: Context, w: Writer) -> None:
        status = provider_status(self.config.runner_bins)
        providers = status.get("providers")
        lines = []
        if isinstance(providers, list):
            for item in providers:
                if isinstance(item, dict):
                    lines.append(
                        f"{item.get('provider')}: "
                        f"{'installed' if item.get('installed') else 'missing'}"
                    )
        w.html(views.agents(lines, self._chrome("Agents", "settings"), uuid.uuid7().hex))

    async def webhooks(self, c: Context, w: Writer) -> None:
        names = [str(row.get("name", "")) for row in load_receivers(self.config.data_dir)]
        w.html(views.webhooks(names, self._chrome("Webhooks", "settings"), uuid.uuid7().hex))

    async def worktrees(self, c: Context, w: Writer) -> None:
        w.html(
            views.worktrees(
                self.config.worktree_keep,
                self._chrome("Worktrees", "settings"),
                uuid.uuid7().hex,
            )
        )

    def _chrome(self, title: str, section: str):
        return load_chrome(self.db, self.config, title, section, self.engine.boot_project_id)
