import uuid
from dataclasses import dataclass

from litewriter import LiteWriter
from stario import App, Context, Relay, Writer
from stario.datastar import SSE, read_signals
from stario.exceptions import RequestBodyError

from app.common.shell import load_chrome
from app.config import RUNNERS, Config
from app.engine.engine import CHANGED, Engine
from app.engine.model import Settings
from app.features.settings.urls import SETTINGS, SETTINGS_LIVE, SETTINGS_SAVE
from app.features.settings.views import render
from app.features.settings.workspace import WorkspaceSettings
from app.store.db import get_settings


@dataclass(frozen=True, slots=True)
class SettingsPage:
    db: LiteWriter
    relay: Relay[dict[str, str]]
    engine: Engine
    config: Config

    def register(self, app: App) -> None:
        app.add(SETTINGS, self.show)
        app.add(SETTINGS_LIVE, self.live)
        app.add(SETTINGS_SAVE, self.save)
        WorkspaceSettings(self.db, self.engine, self.config).register(app)

    async def show(self, c: Context, w: Writer) -> None:
        w.html(self._render(uuid.uuid7().hex))

    async def live(self, c: Context, w: Writer) -> None:
        try:
            signals = await read_signals(c.req)
        except RequestBodyError:
            w.text("tab must be a short id", 400)
            return
        tab = str(signals.get("tab", ""))
        if not (tab.isalnum() and len(tab) <= 32):
            w.text("tab must be a short id", 400)
            return
        async with self.relay.subscribe(CHANGED, f"tab.{tab}", latest=True) as events:
            sse = SSE(w)
            sse.patch_elements(self._render(tab))
            async for subject, payload in c.alive(events):
                if subject == CHANGED:
                    sse.patch_elements(self._render(tab))
                else:
                    sse.patch_signals(payload)

    async def save(self, c: Context, w: Writer) -> None:
        try:
            signals = await read_signals(c.req)
        except RequestBodyError:
            w.text("invalid input", 400)
            return
        tab = str(signals.get("tab", ""))
        if not (tab.isalnum() and len(tab) <= 32):
            w.text("tab must be a short id", 400)
            return
        raw = signals.get("max_parallel")
        if isinstance(raw, str) and raw.isdecimal():
            raw = int(raw)
        if isinstance(raw, bool) or not isinstance(raw, int) or not 1 <= raw <= 16:
            w.text("tasks at once must be from 1 to 16", 400)
            return
        runner = str(signals.get("default_runner", "claude"))
        theme = str(signals.get("theme", "dark"))
        accent = str(signals.get("accent", "lime"))
        if (
            runner not in RUNNERS
            or theme not in ("dark", "light")
            or accent not in ("lime", "violet")
        ):
            w.text("unknown setting", 400)
            return
        w.empty()
        await self.engine.save_workspace(Settings(raw, runner, theme, accent))

    def _render(self, tab: str):
        return render(
            get_settings(self.db),
            load_chrome(self.db, self.config, "Settings", "settings", self.engine.boot_project_id),
            tab,
        )
