"""Python stand-in for the Node `server-install` family.

It writes a systemd unit and a compose file into a directory the operator
names. It does not talk to systemd, launchd, or a registry. `uninstall`
deletes those two files. The listen port probe is a bind check.
"""

from __future__ import annotations

import socket
from pathlib import Path


def first_free_port(host: str, start: int, span: int = 20) -> int:
    for port in range(start, start + span):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind((host, port))
            except OSError:
                continue
            return port
    return start


def install_files(dest: Path, *, host: str, port: int, repo: str) -> list[str]:
    dest.mkdir(parents=True, exist_ok=True)
    unit = dest / "cezar.service"
    compose = dest / "compose.yaml"
    unit.write_text(_unit(host, port, repo), encoding="utf-8")
    compose.write_text(_compose(host, port), encoding="utf-8")
    return [unit.name, compose.name]


def deploy_compose(dest: Path, *, host: str, port: int) -> str:
    dest.mkdir(parents=True, exist_ok=True)
    path = dest / "compose.yaml"
    path.write_text(_compose(host, port), encoding="utf-8")
    return path.name


def uninstall_files(dest: Path) -> list[str]:
    removed: list[str] = []
    for name in ("cezar.service", "compose.yaml"):
        path = dest / name
        if path.is_file():
            path.unlink()
            removed.append(name)
    return removed


def _unit(host: str, port: int, repo: str) -> str:
    return (
        "[Unit]\n"
        "Description=cezar cockpit\n"
        "\n"
        "[Service]\n"
        "Type=simple\n"
        f"WorkingDirectory={repo}\n"
        f"Environment=STARIO_HOST={host}\n"
        f"Environment=STARIO_PORT={port}\n"
        "ExecStart=python -m app.main\n"
        "Restart=on-failure\n"
        "\n"
        "[Install]\n"
        "WantedBy=default.target\n"
    )


def _compose(host: str, port: int) -> str:
    return (
        "services:\n"
        "  cezar:\n"
        "    build: .\n"
        f"    ports:\n      - {host}:{port}:{port}\n"
        "    command: [python, -m, app.main]\n"
    )
