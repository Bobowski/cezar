from pathlib import Path

from stario import Assets

ASSETS = Assets(Path(__file__).resolve().parents[1] / "static", url_prefix="/static")
STYLE_CSS = ASSETS.href("css/style.css")
DATASTAR_JS = ASSETS.href("js/datastar.js")
# Client behaviour would live in static/js/<name>.js. This cockpit stays on the server.
SCRIPTS: tuple[str, ...] = ()
