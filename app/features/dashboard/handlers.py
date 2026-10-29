import uuid
from dataclasses import dataclass

from litewriter import LiteWriter
from stario import App, Context, Relay, Writer
from stario.datastar import SSE, read_signals
from stario.exceptions import RequestBodyError

from app.common.shell import load_chrome
from app.config import Config
from app.engine.engine import CHANGED, Engine
from app.features.dashboard.urls import DASHBOARD, DASHBOARD_LIVE
from app.features.dashboard.views import render
from app.store.db import list_runs


@dataclass(frozen=True, slots=True)
class DashboardPage:
    db: LiteWriter
    relay: Relay[dict[str, str]]
    engine: Engine
    config: Config

    def register(self, app: App) -> None:
        app.add(DASHBOARD, self.show)
        app.add(DASHBOARD_LIVE, self.live)

    async def show(self, c: Context, w: Writer) -> None:
        w.html(self._render(uuid.uuid7().hex, _days(c.req.query.get("period", "7d"))))

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
            sse.patch_elements(self._render(tab, _days(c.req.query.get("period", "7d"))))
            async for subject, payload in c.alive(events):
                if subject == CHANGED:
                    sse.patch_elements(self._render(tab, _days(c.req.query.get("period", "7d"))))
                else:
                    sse.patch_signals(payload)

    def _render(self, tab: str, days: int = 7):
        hide_all = self.config.hide_token_metrics
        return render(
            list_runs(self.db, None, None),
            load_chrome(
                self.db, self.config, "Dashboard", "dashboard", self.engine.boot_project_id
            ),
            tab,
            show_tokens=not hide_all and not self.config.hide_token_usage,
            show_cost=not hide_all and not self.config.hide_cost,
            days=days,
        )


def _days(period: str) -> int:
    return 30 if period == "30d" else 7
