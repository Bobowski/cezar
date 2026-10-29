"""Playwright walk of the Datastar cockpit. Not part of `uv run pytest`.

```bash
uv sync --group e2e
uv run --group e2e playwright install chromium
uv run --group e2e pytest e2e -q
```
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest
from playwright.sync_api import sync_playwright
from tests.conftest import init_repo


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _wait_healthy(port: int) -> None:
    import urllib.request

    deadline = time.time() + 20
    last = ""
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1) as response:
                if response.status == 200:
                    return
        except OSError as exc:
            last = str(exc)
        time.sleep(0.1)
    raise AssertionError(last or "cockpit did not listen")


def test_a_new_task_reaches_done(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    port = _free_port()
    env = os.environ.copy()
    env.update(
        {
            "CEZ_DRY_RUN": "1",
            "CEZ_REPO": str(repo),
            "PROJECT_DATA_DIR": str(tmp_path / "data"),
            "STARIO_HOST": "127.0.0.1",
            "STARIO_PORT": str(port),
        }
    )
    process = subprocess.Popen(
        [sys.executable, "-m", "app.main"],
        cwd=Path(__file__).resolve().parents[1],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        _wait_healthy(port)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page()
            page.goto(f"http://127.0.0.1:{port}/tasks/new", wait_until="networkidle")
            page.locator("textarea").fill("write a note from the browser")
            page.get_by_role("button", name="Start").click()
            page.wait_for_url("**/tasks/*", timeout=15_000)
            page.get_by_text("done", exact=True).wait_for(timeout=15_000)
            assert "write a note from the browser" in page.content()
            browser.close()
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
