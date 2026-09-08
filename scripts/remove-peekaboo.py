#!/usr/bin/env python3
"""Retire the official Peekaboo formula and its dedicated app/state paths."""

import argparse
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
from typing import Optional

FORMULA = "steipete/tap/peekaboo"
BUNDLE_ID = "boo.peekaboo.mac"
STATE_PATHS = (
    ".peekaboo",
    "Library/Application Support/Peekaboo",
    "Library/Application Support/PeekabooShared",
    "Library/Caches/boo.peekaboo.mac",
    "Library/Preferences/boo.peekaboo.mac.plist",
    "Library/HTTPStorages/boo.peekaboo.mac",
    "Library/HTTPStorages/boo.peekaboo.mac.binarycookies",
    "Library/WebKit/boo.peekaboo.mac",
)

class Refusal(Exception):
    pass

def run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, text=True, capture_output=True, check=False)

def checked_path(path: Path, boundary: Path) -> None:
    for current in (path, *path.parents):
        if current.is_symlink():
            raise Refusal(f"refusing a symlink: {current}")
        if current == boundary:
            break
    if path.exists() and path.stat().st_uid != os.getuid():
        raise Refusal(f"path belongs to another user: {path}")

def retire(home: Path, applications: Path, brew: Optional[str], check_only: bool) -> None:
    app = applications / "Peekaboo.app"
    checked_path(app, applications)
    if app.exists():
        info = app / "Contents/Info.plist"
        checked_path(info, app)
        with info.open("rb") as stream:
            metadata = plistlib.load(stream)
        if not isinstance(metadata, dict) or metadata.get("CFBundleIdentifier") != BUNDLE_ID:
            raise Refusal(f"unexpected application at {app}")

    paths = [(app, Path("Applications/Peekaboo.app"))]
    for relative in STATE_PATHS:
        path = home / relative
        checked_path(path, home)
        paths.append((path, Path("Home") / relative))
    trash = home / ".Trash"
    checked_path(trash, home)
    if trash.exists() and not trash.is_dir():
        raise Refusal(f"Trash is not a directory: {trash}")

    installed = False
    keg: Optional[Path] = None
    if brew:
        result = run(brew, "--cellar")
        if result.returncode or not result.stdout.strip():
            raise Refusal("Homebrew could not report its Cellar")
        cellar = Path(result.stdout.strip())
        if not cellar.is_absolute():
            raise Refusal("Homebrew returned a relative Cellar")
        keg = cellar / "peekaboo"
        checked_path(keg, cellar)
        if keg.exists():
            versions = list(keg.iterdir())
            if not versions:
                raise Refusal(f"unrecognized empty keg: {keg}")
            for version in versions:
                receipt = version / "INSTALL_RECEIPT.json"
                checked_path(receipt, cellar)
                metadata = json.loads(receipt.read_text())
                source = metadata.get("source") if isinstance(metadata, dict) else None
                if not isinstance(source, dict) or source.get("tap") != "steipete/tap":
                    raise Refusal(f"unrecognized Peekaboo formula receipt: {receipt}")
            installed = True
    elif shutil.which("peekaboo"):
        raise Refusal("Peekaboo is on PATH but Homebrew is unavailable")

    process = run("/usr/bin/pgrep", "-x", "peekaboo|Peekaboo")
    if process.returncode not in (0, 1):
        raise Refusal("could not determine whether Peekaboo is running")
    if process.returncode == 0:
        raise Refusal("Peekaboo is running; close it before retirement")

    existing = [(path, relative) for path, relative in paths if path.exists()]
    if check_only:
        print(f"Peekaboo retirement: uninstall {FORMULA} if present; never install it.")
        print("Move its verified app and dedicated state to ~/.Trash; leave shared taps and macOS permissions alone.")
        print(f"  Official formula installed: {installed}; app/state paths present: {len(existing)}")
        return
    if sys.platform != "darwin" or os.getuid() == 0:
        raise Refusal("run as the target macOS user, not root")

    if installed:
        env = {**os.environ, "HOMEBREW_NO_AUTOREMOVE": "1", "HOMEBREW_NO_AUTO_UPDATE": "1"}
        result = subprocess.run([brew, "uninstall", "--formula", "--force", FORMULA], env=env, text=True, capture_output=True, check=False)
        if result.returncode:
            raise Refusal(f"Homebrew uninstall failed: {result.stderr.strip()}")
        if keg is not None and keg.exists():
            raise Refusal(f"Homebrew left a Peekaboo keg at {keg}")
        print(f"Uninstalled {FORMULA}.")

    if existing:
        trash.mkdir(mode=0o700, exist_ok=True)
        archive = Path(tempfile.mkdtemp(prefix="Peekaboo-retired-", dir=trash))
        for path, relative in existing:
            destination = archive / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(path), str(destination))
        print(f"Moved Peekaboo app and state to {archive}.")
    if shutil.which("peekaboo"):
        raise Refusal("an additional Peekaboo command remains on PATH")
    print("Peekaboo retired. Desktop workflows use Codex Computer Use.")

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--install", action="store_true", help="retire Peekaboo; install no replacement binary")
    mode.add_argument("--check", action="store_true", help="inspect and print the retirement plan without changes")
    args = parser.parse_args()
    try:
        brew = shutil.which("brew") or next((str(path) for path in (Path("/opt/homebrew/bin/brew"), Path("/usr/local/bin/brew")) if path.is_file()), None)
        retire(Path.home(), Path("/Applications"), brew, args.check)
    except (Refusal, OSError, ValueError, plistlib.InvalidFileException) as error:
        print(f"Agentdesk retirement: {error}", file=sys.stderr)
        return 1
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
