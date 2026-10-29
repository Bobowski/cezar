import uuid
from dataclasses import dataclass, replace
from pathlib import Path

from litewriter import LiteWriter
from stario import App, Context, Relay, Writer
from stario.datastar import SSE, read_signals
from stario.exceptions import RequestBodyError

from app.clock import after, stamp
from app.common.shell import load_chrome
from app.config import Config
from app.engine.catalog import load_workflows
from app.engine.engine import CHANGED, Engine
from app.engine.model import Automation
from app.features.automations.urls import (
    AUTOMATIONS,
    AUTOMATIONS_CREATE,
    AUTOMATIONS_DELETE,
    AUTOMATIONS_ENABLE,
    AUTOMATIONS_LIVE,
    AUTOMATIONS_PAUSE,
    AUTOMATIONS_RUN,
    AutomationsView,
)
from app.features.automations.views import render
from app.store.db import get_project, get_settings, list_automations


@dataclass(frozen=True, slots=True)
class AutomationsPage:
    db: LiteWriter
    relay: Relay[dict[str, str]]
    engine: Engine
    config: Config

    def register(self, app: App) -> None:
        app.add(AUTOMATIONS, self.show)
        app.add(AUTOMATIONS_LIVE, self.live)
        app.add(AUTOMATIONS_CREATE, self.create)
        app.add(AUTOMATIONS_ENABLE, self.enable)
        app.add(AUTOMATIONS_PAUSE, self.pause)
        app.add(AUTOMATIONS_RUN, self.run)
        app.add(AUTOMATIONS_DELETE, self.delete)

    def _view(self, query: object) -> AutomationsView:
        view = AutomationsView.from_query(query)  # type: ignore[arg-type]
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
        task = str(signals.get("task", "")).strip()
        every = signals.get("every", 60)
        workflow = str(signals.get("workflow", "quick-task")).strip()
        if isinstance(every, bool) or not isinstance(every, int | str):
            w.text("every must be a number of minutes", 400)
            return
        if isinstance(every, str):
            if not every.isdecimal():
                w.text("every must be a number of minutes", 400)
                return
            every = int(every)
        if not name or len(name) > 80 or not task or len(task) > 20_000:
            w.text("name and task are required", 400)
            return
        if not 1 <= every <= 10080:
            w.text("every must be between 1 and 10080 minutes", 400)
            return
        project = get_project(self.db, view.project)
        if project is None:
            w.text("unknown project", 400)
            return
        if not any(item.name == workflow for item in load_workflows(Path(project.root))[0]):
            w.text("unknown workflow", 400)
            return
        settings = get_settings(self.db)
        item = Automation(
            id=uuid.uuid4().hex,
            project_id=project.id,
            name=name,
            task=task,
            workflow=workflow,
            runner=settings.default_runner,
            every_minutes=every,
            enabled=False,
            next_at=after(every),
            created_at=stamp(),
        )
        SSE(w).patch_signals({"name": "", "task": "", "_error": ""})
        await self.engine.create_automation(item)

    async def enable(self, c: Context, w: Writer) -> None:
        await self._toggle(c, w, True)

    async def pause(self, c: Context, w: Writer) -> None:
        await self._toggle(c, w, False)

    async def _toggle(self, c: Context, w: Writer, enabled: bool) -> None:
        automation_id, tab = await _id(c, w)
        if automation_id is None or tab is None:
            return
        reason = await self.engine.set_automation_enabled(automation_id, enabled)
        if reason:
            w.text(reason, 404)
            return
        w.empty()

    async def run(self, c: Context, w: Writer) -> None:
        automation_id, tab = await _id(c, w)
        if automation_id is None:
            return
        _run_id, reason = await self.engine.run_automation_now(automation_id)
        if reason:
            w.text(reason, 404)
            return
        w.empty()

    async def delete(self, c: Context, w: Writer) -> None:
        automation_id, _tab = await _id(c, w)
        if automation_id is None:
            return
        reason = await self.engine.remove_automation(automation_id)
        if reason:
            w.text(reason, 404)
            return
        w.empty()

    def _render(self, view: AutomationsView, tab: str):
        project = get_project(self.db, view.project)
        workflows = load_workflows(Path(project.root))[0] if project else []
        items = list_automations(self.db, view.project or None)
        return render(
            items,
            workflows,
            view,
            load_chrome(self.db, self.config, "Automations", "automations", view.project),
            tab,
        )


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


async def _tab(c: Context, w: Writer) -> str | None:
    _signals, tab = await _form(c, w)
    return tab


async def _id(c: Context, w: Writer):
    _signals, tab = await _form(c, w)
    automation_id = c.match.params["automation_id"]
    if tab is None:
        return None, None
    if not (len(automation_id) == 32 and automation_id.isalnum()):
        w.text("not found", 404)
        return None, None
    return automation_id, tab
