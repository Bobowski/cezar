"""Build a wheel from the `app` package.

This is the Python stand-in for the Node release tarball. It does not publish
anywhere and it does not invoke the Node installer.
"""

from __future__ import annotations

import base64
import hashlib
import zipfile
from pathlib import Path


def build_wheel(repo: Path, dest: Path, version: str = "0.1.0") -> Path:
    package = repo / "app"
    dest.mkdir(parents=True, exist_ok=True)
    name = f"cezar-{version}-py3-none-any.whl"
    target = dest / name
    dist = f"cezar-{version}.dist-info"
    records: list[str] = []
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(package.rglob("*")):
            if not path.is_file() or "__pycache__" in path.parts or path.suffix == ".pyc":
                continue
            rel = path.relative_to(repo).as_posix()
            payload = path.read_bytes()
            archive.writestr(rel, payload)
            records.append(_record(rel, payload))
        metadata = (
            "Metadata-Version: 2.1\n"
            "Name: cezar\n"
            f"Version: {version}\n"
            "Summary: Python cockpit for cezar\n"
            "Requires-Python: >=3.14\n"
        ).encode()
        wheel = b"Wheel-Version: 1.0\nGenerator: cezar\nRoot-Is-Purelib: true\nTag: py3-none-any\n"
        archive.writestr(f"{dist}/METADATA", metadata)
        archive.writestr(f"{dist}/WHEEL", wheel)
        records.append(_record(f"{dist}/METADATA", metadata))
        records.append(_record(f"{dist}/WHEEL", wheel))
        record = "".join(records).encode()
        archive.writestr(f"{dist}/RECORD", record + _record(f"{dist}/RECORD", b"").encode())
    return target


def _record(name: str, payload: bytes) -> str:
    digest = base64.urlsafe_b64encode(hashlib.sha256(payload).digest()).decode().rstrip("=")
    return f"{name},sha256={digest},{len(payload)}\n"
