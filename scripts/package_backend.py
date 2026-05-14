"""Package Zoo's FastAPI backend as a Tauri sidecar binary."""

from __future__ import annotations

import platform
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
BIN_DIR = ROOT / "src-tauri" / "binaries"
DIST_DIR = ROOT / "dist" / "zoo-backend"


def _target_triple() -> str:
    system = platform.system()
    machine = platform.machine().lower()
    is_arm64 = machine in {"arm64", "aarch64"}
    is_x64 = machine in {"amd64", "x86_64"}

    if system == "Darwin":
        return "aarch64-apple-darwin" if is_arm64 else "x86_64-apple-darwin"
    if system == "Windows":
        return "aarch64-pc-windows-msvc" if is_arm64 else "x86_64-pc-windows-msvc"
    if system == "Linux":
        return "aarch64-unknown-linux-gnu" if is_arm64 else "x86_64-unknown-linux-gnu"

    if not (is_arm64 or is_x64):
        raise SystemExit(f"Unsupported CPU for Tauri sidecar packaging: {machine}")

    raise SystemExit(f"Unsupported platform for Tauri sidecar packaging: {system} {machine}")


def main() -> None:
    pyinstaller = shutil.which("pyinstaller")
    if pyinstaller is None:
        raise SystemExit(
            "PyInstaller is required to package the Zoo backend sidecar. "
            "Install it in the active Python environment with `python -m pip install pyinstaller`."
        )

    subprocess.run(
        [
            pyinstaller,
            "--name",
            "zoo-backend",
            "--onefile",
            "--clean",
            "--hidden-import",
            "zoo.app",
            "--distpath",
            str(DIST_DIR),
            "--workpath",
            str(ROOT / "build" / "zoo-backend"),
            "--specpath",
            str(ROOT / "build" / "zoo-backend"),
            str(ROOT / "zoo" / "desktop_backend.py"),
        ],
        cwd=ROOT,
        check=True,
    )

    extension = ".exe" if platform.system() == "Windows" else ""
    source = DIST_DIR / f"zoo-backend{extension}"
    target = BIN_DIR / f"zoo-backend-{_target_triple()}{extension}"
    BIN_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
    target.chmod(target.stat().st_mode | 0o111)
    print(f"Packaged Tauri sidecar: {target}")


if __name__ == "__main__":
    sys.exit(main())
