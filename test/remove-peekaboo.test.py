#!/usr/bin/env python3
"""Exercise retirement against private fixtures, never installed Peekaboo."""

import contextlib
import importlib.util
import io
import json
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location(
    "retirement", Path(__file__).resolve().parents[1] / "scripts/remove-peekaboo.py"
)
retirement = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(retirement)


class RetirementTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.home = root / "home"
        self.apps = root / "Applications"
        self.cellar = root / "Cellar"
        for directory in (self.home, self.apps, self.cellar):
            directory.mkdir()
        self.app = self.apps / "Peekaboo.app"
        (self.app / "Contents").mkdir(parents=True)
        with (self.app / "Contents/Info.plist").open("wb") as stream:
            plistlib.dump({"CFBundleIdentifier": retirement.BUNDLE_ID}, stream)
        self.state = self.home / ".peekaboo"
        self.state.mkdir()
        (self.state / "config.json").write_text("private fixture settings\n")
        for relative in retirement.STATE_PATHS[1:]:
            path = self.home / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("private fixture state\n")
        self.receipt = self.cellar / "peekaboo/4.3.0/INSTALL_RECEIPT.json"
        self.receipt.parent.mkdir(parents=True)
        self.receipt.write_text(json.dumps({"source": {"tap": "steipete/tap"}}))
        self.other = self.home / "unrelated"
        self.other.write_text("keep me\n")
        self.commands = []
        self.running = False
        self.uninstall_failure = False

    def command(self, argv, **kwargs):
        argv = list(argv)
        self.commands.append(argv)
        if argv == ["fixture-brew", "--cellar"]:
            return subprocess.CompletedProcess(argv, 0, str(self.cellar) + "\n", "")
        if argv == ["/usr/bin/pgrep", "-x", "peekaboo|Peekaboo"]:
            return subprocess.CompletedProcess(argv, 0 if self.running else 1, "123\n" if self.running else "", "")
        self.assertEqual(argv, ["fixture-brew", "uninstall", "--formula", "--force", retirement.FORMULA])
        self.assertEqual(kwargs["env"]["HOMEBREW_NO_AUTOREMOVE"], "1")
        self.assertEqual(kwargs["env"]["HOMEBREW_NO_AUTO_UPDATE"], "1")
        if self.uninstall_failure:
            return subprocess.CompletedProcess(argv, 1, "", "fixture uninstall refused")
        shutil.rmtree(self.cellar / "peekaboo")
        return subprocess.CompletedProcess(argv, 0, "", "")

    def retire(self, check=False):
        with (
            patch.object(retirement.subprocess, "run", side_effect=self.command),
            patch.object(retirement.shutil, "which", return_value=None),
            patch.object(retirement.sys, "platform", "darwin"),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            retirement.retire(self.home, self.apps, "fixture-brew", check)

    def assert_untouched(self):
        self.assertTrue(self.app.exists())
        self.assertTrue(self.receipt.exists())
        self.assertEqual((self.state / "config.json").read_text(), "private fixture settings\n")
        self.assertFalse((self.home / ".Trash").exists())
        self.assertFalse(any("uninstall" in command for command in self.commands))

    def test_retires_recoverably_and_repeats(self):
        self.retire()
        archives = list((self.home / ".Trash").iterdir())
        self.assertEqual(len(archives), 1)
        self.assertTrue((archives[0] / "Applications/Peekaboo.app/Contents/Info.plist").exists())
        self.assertEqual((archives[0] / "Home/.peekaboo/config.json").read_text(), "private fixture settings\n")
        for relative in retirement.STATE_PATHS[1:]:
            self.assertFalse((self.home / relative).exists())
            self.assertEqual((archives[0] / "Home" / relative).read_text(), "private fixture state\n")
        self.assertEqual(self.other.read_text(), "keep me\n")
        self.retire()
        self.assertEqual(list((self.home / ".Trash").iterdir()), archives)
        self.assertEqual(sum("uninstall" in command for command in self.commands), 1)

    def test_check_is_read_only(self):
        self.retire(check=True)
        self.assert_untouched()

    def test_foreign_bundle_stops_before_mutation(self):
        with (self.app / "Contents/Info.plist").open("wb") as stream:
            plistlib.dump({"CFBundleIdentifier": "example.other.app"}, stream)
        with self.assertRaisesRegex(retirement.Refusal, "unexpected application"):
            self.retire()
        self.assert_untouched()

    def test_foreign_formula_stops_before_mutation(self):
        self.receipt.write_text(json.dumps({"source": {"tap": "example/other"}}))
        with self.assertRaisesRegex(retirement.Refusal, "unrecognized Peekaboo formula"):
            self.retire()
        self.assert_untouched()

    def test_redirected_state_stops_before_mutation(self):
        saved = self.home / "saved-state"
        self.state.rename(saved)
        self.state.symlink_to(saved, target_is_directory=True)
        with self.assertRaisesRegex(retirement.Refusal, "symlink"):
            self.retire()
        self.assertTrue(self.receipt.exists())
        self.assertFalse(any("uninstall" in command for command in self.commands))

    def test_redirected_parent_stops_before_mutation(self):
        external = self.home / "elsewhere"
        (self.home / "Library").rename(external)
        (self.home / "Library").symlink_to(external, target_is_directory=True)
        with self.assertRaisesRegex(retirement.Refusal, "symlink"):
            self.retire()
        self.assertTrue(self.receipt.exists())
        self.assertFalse(any("uninstall" in command for command in self.commands))

    def test_running_process_stops_before_mutation(self):
        self.running = True
        with self.assertRaisesRegex(retirement.Refusal, "is running"):
            self.retire()
        self.assert_untouched()

    def test_uninstall_failure_keeps_app_and_state(self):
        self.uninstall_failure = True
        with self.assertRaisesRegex(retirement.Refusal, "Homebrew uninstall failed"):
            self.retire()
        self.assertTrue(self.app.exists())
        self.assertTrue(self.state.exists())
        self.assertFalse((self.home / ".Trash").exists())

    def test_invalid_trash_stops_before_uninstall(self):
        (self.home / ".Trash").write_text("foreign file\n")
        with self.assertRaisesRegex(retirement.Refusal, "not a directory"):
            self.retire()
        self.assertTrue(self.receipt.exists())
        self.assertTrue(self.app.exists())
        self.assertFalse(any("uninstall" in command for command in self.commands))


if __name__ == "__main__":
    unittest.main()
