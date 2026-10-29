import uuid
from dataclasses import dataclass, replace
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
    SETTINGS_WEBHOOKS_SAVE,
    SETTINGS_WORKTREES,
    TRACKER,
    WORKFLOW,
)
from app.features.settings.store import tracker_overrides
from app.integrations.clients import github_issues, jira_issue, linear_issue
from app.integrations.hooks import load_receivers, save_receiver
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
        app.add(SETTINGS_WEBHOOKS_SAVE, self.save_webhook)
        app.add(SETTINGS_WORKTREES, self.worktrees)

    async def inbox(self, c: Context, w: Writer) -> None:
        project = self.engine.boot_project_id
        rows = [run for run in list_runs(self.db, project, None) if is_unread(run)]
        w.html(views.inbox(rows, self._chrome("Inbox", "tasks"), uuid.uuid7().hex))

    async def inbox_read(self, c: Context, w: Writer) -> None:
        await self.engine.mark_all_read(self.engine.boot_project_id)
        w.redirect(INBOX.href(), 303)

    async def github(self, c: Context, w: Writer) -> None:
        owner = c.req.query.get("owner", "")
        repo = c.req.query.get("repo", "")
        notice = ""
        titles: list[str] = []
        if not owner or not repo:
            notice = "Name an owner and a repository to list open issues."
        else:
            loaded = github_issues(self.config, owner, repo)
            if loaded.get("available") is not True:
                notice = str(loaded.get("reason", "unavailable"))
            else:
                issues = loaded.get("issues")
                rows = issues if isinstance(issues, list) else []
                titles = [
                    f"#{item.get('number')} {item.get('title', '')}"
                    for item in rows
                    if isinstance(item, dict)
                ]
                notice = "No open issues." if not titles else f"{len(titles)} open"
        w.html(
            views.github(
                owner, repo, titles, notice, self._chrome("GitHub", "github"), uuid.uuid7().hex
            )
        )

    async def tracker(self, c: Context, w: Writer) -> None:
        kind = c.req.query.get("kind", "jira")
        if kind not in ("jira", "linear"):
            kind = "jira"
        key = c.req.query.get("key", "").strip()
        notice = "Enter an issue key."
        if key:
            cfg = replace(self.config, **tracker_overrides(self.config.data_dir))
            loaded = linear_issue(cfg, key) if kind == "linear" else jira_issue(cfg, key)
            if loaded.get("available") is not True:
                notice = str(loaded.get("reason", "unavailable"))
            elif kind == "linear":
                notice = f"{loaded.get('identifier', key)} {loaded.get('title', '')}".strip()
            else:
                notice = f"{loaded.get('key', key)} {loaded.get('summary', '')}".strip()
        w.html(
            views.tracker(kind, key, notice, self._chrome("Tracker", "tracker"), uuid.uuid7().hex)
        )

    async def repo(self, c: Context, w: Writer) -> None:
        pane = c.req.query.get("pane", "commits")
        if pane not in ("commits", "changes", "branches", "files"):
            pane = "commits"
        args = {
            "commits": ["log", "--oneline", "-n", "20"],
            "changes": ["status", "--short"],
            "branches": ["branch", "--format=%(refname:short)"],
            "files": ["ls-files"],
        }[pane]
        ok, out, _err = git(self.config.repo_root, args)
        lines = out.splitlines() if ok else []
        w.html(views.repo(pane, lines, self._chrome("Repository", "git"), uuid.uuid7().hex))

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
        w.html(
            views.webhooks(
                self._receiver_names(), self._chrome("Webhooks", "settings"), uuid.uuid7().hex
            )
        )

    async def save_webhook(self, c: Context, w: Writer) -> None:
        from stario.datastar import SSE, read_signals
        from stario.exceptions import RequestBodyError

        try:
            signals = await read_signals(c.req)
        except RequestBodyError:
            w.text("invalid input", 400)
            return
        tab = str(signals.get("tab", ""))
        if not (tab.isalnum() and len(tab) <= 32):
            w.text("tab must be a short id", 400)
            return
        _row, reason = save_receiver(
            self.config.data_dir, str(signals.get("name", "")), str(signals.get("url", ""))
        )
        if reason:
            SSE(w).patch_signals({"_error": reason})
            return
        SSE(w).patch_signals({"name": "", "url": "", "_error": ""})
        SSE(w).patch_elements(
            views.webhooks(self._receiver_names(), self._chrome("Webhooks", "settings"), tab)
        )

    def _receiver_names(self) -> list[str]:
        return [str(row.get("name", "")) for row in load_receivers(self.config.data_dir)]

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
