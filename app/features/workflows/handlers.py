import re
import uuid
from dataclasses import dataclass, replace
from pathlib import Path

import yaml
from litewriter import LiteWriter
from stario import App, Context, Relay, Writer
from stario.datastar import SSE, read_signals
from stario.exceptions import RequestBodyError

from app.common.shell import load_chrome
from app.config import Config
from app.engine.catalog import WORKFLOWS_DIR, load_workflows
from app.engine.engine import CHANGED, Engine
from app.features.workflows.urls import (
    WORKFLOWS,
    WORKFLOWS_CREATE,
    WORKFLOWS_DELETE,
    WORKFLOWS_LIVE,
    WorkflowsView,
)
from app.features.workflows.views import render
from app.store.db import get_project

_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,64}$")

_FIX = {
    "name": "fix-and-verify",
    "description": "Implement the task, then retry when the check fails.",
    "steps": [
        {"id": "implement", "name": "Implement", "prompt": "{{task}}"},
        {
            "id": "verify",
            "name": "Verify",
            "command": "echo 'replace me with: npm test / pytest'",
            "onFail": {"retry": "implement", "max": 2},
        },
    ],
}


@dataclass(frozen=True, slots=True)
class WorkflowsPage:
    db: LiteWriter
    relay: Relay[dict[str, str]]
    engine: Engine
    config: Config

    def register(self, app: App) -> None:
        app.add(WORKFLOWS, self.show)
        app.add(WORKFLOWS_LIVE, self.live)
        app.add(WORKFLOWS_CREATE, self.create)
        app.add(WORKFLOWS_DELETE, self.delete)

    def _view(self, query: object) -> WorkflowsView:
        view = WorkflowsView.from_query(query)  # type: ignore[arg-type]
        if not view.project:
            view = replace(view, project=self.engine.boot_project_id)
        return view

    async def show(self, c: Context, w: Writer) -> None:
        view = self._view(c.req.query)
        w.html(self._render(view, uuid.uuid7().hex))

    async def live(self, c: Context, w: Writer) -> None:
        view = self._view(c.req.query)
        tab = await _tab(c, w)
        if tab is None:
            return
        async with self.relay.subscribe(CHANGED, f"tab.{tab}", latest=True) as events:
            sse = SSE(w)
            sse.patch_elements(self._render(view, tab))
            async for subject, payload in c.alive(events):
                if subject == CHANGED:
                    sse.patch_elements(self._render(view, tab))
                else:
                    sse.patch_signals(payload)

    async def create(self, c: Context, w: Writer) -> None:
        view = self._view(c.req.query)
        signals, tab = await _form(c, w)
        if signals is None or tab is None:
            return
        name = str(signals.get("name", "")).strip()
        template = str(signals.get("template", "agent"))
        if not _NAME.fullmatch(name):
            w.text("name must be letters, digits, _ or -", 400)
            return
        if template not in ("agent", "fix-and-verify"):
            w.text("unknown template", 400)
            return
        project = get_project(self.db, view.project)
        if project is None:
            w.text("unknown project", 400)
            return
        if template == "fix-and-verify":
            doc = {**_FIX, "name": name}
        else:
            doc = {
                "name": name,
                "description": "One agent step.",
                "steps": [{"id": "task", "name": "Do the task", "prompt": "{{task}}"}],
            }
        directory = Path(project.root) / WORKFLOWS_DIR
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f"{name}.yaml"
        SSE(w).patch_signals({"name": "", "_error": ""})
        path.write_text(yaml.safe_dump(doc, sort_keys=False), encoding="utf-8")
        self.relay.publish(CHANGED, {})

    async def delete(self, c: Context, w: Writer) -> None:
        view = self._view(c.req.query)
        name = c.match.params["name"]
        signals, tab = await _form(c, w)
        if tab is None:
            return
        if not _NAME.fullmatch(name):
            w.text("unknown workflow", 400)
            return
        project = get_project(self.db, view.project)
        if project is None:
            w.text("unknown project", 404)
            return
        path = (Path(project.root) / WORKFLOWS_DIR / f"{name}.yaml").resolve()
        root = (Path(project.root) / WORKFLOWS_DIR).resolve()
        if path.parent != root:
            w.text("unknown workflow", 400)
            return
        if not path.is_file():
            yml = path.with_suffix(".yml")
            path = yml if yml.is_file() else path
        if not path.is_file():
            self.relay.publish(f"tab.{tab}", {"_error": "built-in workflows stay available"})
            w.text("built-in workflows stay available", 409)
            return
        w.empty()
        path.unlink()
        self.relay.publish(CHANGED, {})

    def _render(self, view: WorkflowsView, tab: str):
        project = get_project(self.db, view.project)
        if project is None:
            workflows, issues = [], []
        else:
            workflows, issues = load_workflows(Path(project.root))
        return render(
            workflows,
            issues,
            view,
            load_chrome(self.db, self.config, "Workflows", "workflows", view.project),
            tab,
        )


async def _tab(c: Context, w: Writer) -> str | None:
    signals, tab = await _form(c, w)
    return tab


async def _form(c: Context, w: Writer):
    try:
        signals = await read_signals(c.req)
    except RequestBodyError:
        w.text("invalid input", 400)
        return None, None
    tab = str(signals.get("tab", ""))
    if not (tab.isalnum() and len(tab) <= 32):
        w.text("tab must be a short id", 400)
        return None, None
    return signals, tab
