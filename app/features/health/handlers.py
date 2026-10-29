from dataclasses import dataclass

from stario import App, Context, Writer

from app.config import Config
from app.features.health.urls import API_HEALTH, HEALTH


@dataclass(frozen=True, slots=True)
class HealthPage:
    config: Config

    def register(self, app: App) -> None:
        app.add(HEALTH, self.show)
        app.add(API_HEALTH, self.api)

    async def show(self, c: Context, w: Writer) -> None:
        w.text("ok\n")

    async def api(self, c: Context, w: Writer) -> None:
        w.json(
            {
                "ok": True,
                "dryRun": self.config.dry_run,
                "version": self.config.version,
            }
        )
