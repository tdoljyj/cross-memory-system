"""Tests for the private Clued plugin for Claude Code (integrations/claude-code/clued, Task 67c97003)."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "integrations" / "claude-code" / "clued"
MARKETPLACE = ROOT / ".claude-plugin" / "marketplace.json"
BUILD = ROOT / "scripts" / "build_claude_code_plugin.py"


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def stop_command() -> str:
    return load(PLUGIN / "hooks" / "hooks.json")["hooks"]["Stop"][0]["hooks"][0]["command"]


class PluginLayoutTest(unittest.TestCase):
    def test_copies_match_their_sources(self) -> None:
        run = subprocess.run([sys.executable, str(BUILD), "--check"], capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)

    def test_only_tracked_source_files_count(self) -> None:
        # An untracked file in the source (a .DS_Store, a draft) is neither copied nor reported.
        stray = ROOT / "skills" / "clued" / "references" / "untracked-draft-for-test.md"
        self.assertFalse(stray.exists())
        stray.write_text("draft\n", encoding="utf-8")
        try:
            run = subprocess.run([sys.executable, str(BUILD), "--check"], capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
        finally:
            stray.unlink()

    def test_manifest(self) -> None:
        manifest = load(PLUGIN / ".claude-plugin" / "plugin.json")
        self.assertEqual(manifest["name"], "clued")
        # No version on purpose: Claude Code then versions the install by commit, so a rebuilt
        # Skill or guard reaches existing installs; a pinned version would hide it until someone
        # raised it by hand.
        self.assertNotIn("version", manifest)
        # Owner choice (Task 67c97003): the trial uses the existing Clued connector and adds none.
        self.assertNotIn("mcpServers", manifest)
        self.assertFalse((PLUGIN / ".mcp.json").exists())
        # claude.ai and Cowork refuse a plugin with a top-level bin/.
        self.assertFalse((PLUGIN / "bin").exists())
        self.assertTrue((PLUGIN / "skills" / "clued" / "SKILL.md").is_file())

    def test_marketplace_lists_the_plugin(self) -> None:
        market = load(MARKETPLACE)
        self.assertEqual(market["name"], "clued-private")
        entries = {p["name"]: p for p in market["plugins"]}
        self.assertEqual((ROOT / entries["clued"]["source"]).resolve(), PLUGIN.resolve())

    @unittest.skipUnless(shutil.which("claude"), "Claude Code CLI not installed")
    def test_claude_validates_plugin_and_marketplace(self) -> None:
        for target in (PLUGIN, ROOT):
            run = subprocess.run(["claude", "plugin", "validate", str(target)],
                                 capture_output=True, text=True, timeout=120)
            self.assertEqual(run.returncode, 0, run.stdout + run.stderr)


class PluginStopHookTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def run_stop(self, project_dir: Path) -> subprocess.CompletedProcess:
        # A committed Clued write with no checkpoint after it: the capture guard blocks the stop.
        entries = [
            {"type": "assistant", "message": {"role": "assistant", "content": [
                {"type": "tool_use", "id": "w1", "name": "mcp__Clued__clued_record_mutate",
                 "input": {"scope": "global"}}]}},
            {"type": "user", "message": {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "w1",
                 "content": json.dumps({"status": "committed", "event_ids": ["1"]})}]}},
        ]
        transcript = Path(self.tmp.name) / "s.jsonl"
        transcript.write_text("".join(json.dumps(e) + "\n" for e in entries), encoding="utf-8")
        payload = {"session_id": "plugin-test", "transcript_path": str(transcript),
                   "hook_event_name": "Stop", "stop_hook_active": False}
        env = {**os.environ, "TMPDIR": self.tmp.name, "CLAUDE_PLUGIN_ROOT": str(PLUGIN),
               "CLAUDE_PROJECT_DIR": str(project_dir)}
        env.pop("CLUED_CAPTURE_GUARD", None)
        return subprocess.run(["sh", "-c", stop_command()], input=json.dumps(payload), text=True,
                              capture_output=True, env=env, timeout=30)

    def test_blocks_an_unchecked_write_in_another_project(self) -> None:
        run = self.run_stop(Path(self.tmp.name))
        self.assertEqual(run.returncode, 2, run.stderr)
        self.assertIn("BeamingFace capture guard", run.stderr)

    def test_stays_quiet_where_the_project_runs_its_own_guard(self) -> None:
        # This repository's .claude/settings.json already runs the guard; the plugin must not run it twice.
        run = self.run_stop(ROOT)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(run.stderr, "")


if __name__ == "__main__":
    unittest.main()
