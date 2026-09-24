"""Tests for scripts/hooks/clued_capture_guard.py (Claude Code Stop hook)."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HOOK = ROOT / "scripts" / "hooks" / "clued_capture_guard.py"


def human(text: str, uuid: str) -> dict:
    return {"type": "user", "uuid": uuid, "origin": {"kind": "human"},
            "message": {"role": "user", "content": text}}


def notification(text: str) -> dict:
    return {"type": "user", "origin": {"kind": "task-notification"},
            "message": {"role": "user", "content": text}}


def call(use_id: str, name: str, tool_input: dict | None = None, sidechain: bool = False) -> dict:
    return {"type": "assistant", "isSidechain": sidechain, "message": {"role": "assistant", "content": [
        {"type": "tool_use", "id": use_id, "name": name, "input": tool_input or {}}]}}


def result(use_id: str, body, is_error: bool = False) -> dict:
    content = body if isinstance(body, (str, list)) else json.dumps(body)
    return {"type": "user", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": use_id, "content": content, "is_error": is_error}]}}


MERGE = "mcp__github__merge_pull_request"
MUTATE = "mcp__Clued__clued_record_mutate"
CHECKPOINT = "mcp__Clued__clued_session_checkpoint"
MERGED = [{"type": "text", "text": '{"sha":"abc","merged":true,"message":"Pull Request successfully merged"}'}]
COMMITTED = {"status": "committed", "event_ids": ["1"]}


class CaptureGuardTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.env = {**os.environ, "TMPDIR": self.tmp.name}
        self.env.pop("CLUED_CAPTURE_GUARD", None)
        self.session = 0

    def run_hook(self, entries: list[dict], session: str | None = None, trailing: str = "",
                 env: dict | None = None) -> subprocess.CompletedProcess:
        if session is None:
            self.session += 1
            session = f"s{self.session}"
        transcript = Path(self.tmp.name) / f"{session}.jsonl"
        transcript.write_text("".join(json.dumps(e) + "\n" for e in entries) + trailing, encoding="utf-8")
        payload = {"session_id": session, "transcript_path": str(transcript),
                   "hook_event_name": "Stop", "stop_hook_active": False}
        return subprocess.run([sys.executable, str(HOOK)], input=json.dumps(payload), text=True,
                              capture_output=True, env=env or self.env, timeout=30)

    def merge_turn(self) -> list[dict]:
        return [human("合入后告诉我", "u1"),
                call("m1", MERGE, {"owner": "o", "repo": "r", "pullNumber": 7}), result("m1", MERGED)]

    def test_merge_without_clued_write_blocks_once(self):
        entries = self.merge_turn()
        first = self.run_hook(entries, session="same")
        self.assertEqual(first.returncode, 2)
        self.assertIn("merged PR o/r#7", first.stderr)
        second = self.run_hook(entries, session="same")
        self.assertEqual(second.returncode, 0, "each finding is reported once per session")

    def test_merge_then_write_and_checkpoint_passes(self):
        entries = self.merge_turn() + [
            call("w1", MUTATE), result("w1", COMMITTED),
            call("c1", CHECKPOINT), result("c1", {"status": "committed", "version": 2})]
        self.assertEqual(self.run_hook(entries).returncode, 0)

    def test_failed_write_attempt_counts_as_capture_attempt(self):
        entries = self.merge_turn() + [call("w1", MUTATE), result("w1", {"status": "rejected"})]
        self.assertEqual(self.run_hook(entries).returncode, 0)

    def test_committed_write_without_checkpoint_blocks(self):
        entries = [notification("<task-notification/>"), call("w1", MUTATE), result("w1", COMMITTED)]
        proc = self.run_hook(entries)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("since the last checkpoint", proc.stderr)

    def test_rejected_checkpoint_does_not_clear_pending_writes(self):
        entries = [call("w1", MUTATE), result("w1", COMMITTED), call("c1", CHECKPOINT),
                   result("c1", {"error": "current_truth_changed_since_resume", "status": "conflict"}, True)]
        self.assertEqual(self.run_hook(entries).returncode, 2)

    def test_decision_prompt_without_write_blocks(self):
        proc = self.run_hook([human("那就保持原样", "u9")])
        self.assertEqual(proc.returncode, 2)
        self.assertIn("保持原样", proc.stderr)

    def test_decision_prompt_followed_by_write_passes(self):
        entries = [human("对齐脚本的范围缩小吧", "u9"), call("w1", MUTATE), result("w1", COMMITTED),
                   call("c1", CHECKPOINT), result("c1", {"status": "committed"})]
        self.assertEqual(self.run_hook(entries).returncode, 0)

    def test_plain_request_passes(self):
        self.assertEqual(self.run_hook([human("做 L3 的 Stop hook", "u1")]).returncode, 0)

    def test_failed_merge_is_not_an_outcome(self):
        entries = [human("合入", "u1"), call("m1", MERGE), result("m1", "405 not mergeable", True)]
        self.assertEqual(self.run_hook(entries).returncode, 0)

    def test_git_push_to_main_is_an_outcome_but_branch_push_is_not(self):
        push_main = [human("push", "u1"), call("b1", "Bash", {"command": "git push origin HEAD:main"}),
                     result("b1", "ok")]
        self.assertEqual(self.run_hook(push_main).returncode, 2)
        push_branch = [human("push", "u1"),
                       call("b1", "Bash", {"command": "git push -u origin feature 2>&1 | tail -2; git log origin/main"}),
                       result("b1", "ok")]
        self.assertEqual(self.run_hook(push_branch).returncode, 0)

    def test_command_text_that_only_mentions_merge_or_push_is_not_an_outcome(self):
        commit = ("git commit -q -F - <<'EOF'\nAdd hook\n\n- a merged PR (merge_pull_request, or gh pr merge),"
                  " a push to main\nEOF\ngit push -u origin feature")
        entries = [human("做 hook", "u1"), call("b1", "Bash", {"command": commit}), result("b1", "ok")]
        self.assertEqual(self.run_hook(entries).returncode, 0)
        script = "python3 - <<'PY'\ncases = ('cd repo && gh pr merge 5', 'x; git push origin main')\nPY\necho done"
        entries = [human("做 hook", "u1"), call("b2", "Bash", {"command": script}), result("b2", "ok")]
        self.assertEqual(self.run_hook(entries).returncode, 0)
        for command in ("cd repo && gh pr merge 5 --merge", "GH_TOKEN=x gh pr merge 5"):
            entries = [human("合入", "u1"), call("b1", "Bash", {"command": command}), result("b1", "ok")]
            self.assertEqual(self.run_hook(entries).returncode, 2, command)

    def test_sidechain_calls_are_ignored(self):
        entries = [human("看看", "u1"), call("m1", MERGE, sidechain=True), result("m1", MERGED)]
        self.assertEqual(self.run_hook(entries).returncode, 0)

    def test_incomplete_trailing_line_is_tolerated(self):
        proc = self.run_hook(self.merge_turn(), trailing='{"type": "assistant", "mess')
        self.assertEqual(proc.returncode, 2)

    def test_disabled_by_environment(self):
        env = {**self.env, "CLUED_CAPTURE_GUARD": "off"}
        self.assertEqual(self.run_hook(self.merge_turn(), env=env).returncode, 0)

    def test_missing_transcript_or_bad_input_passes(self):
        for stdin in ("not json", json.dumps({"session_id": "x", "transcript_path": "/nonexistent"})):
            proc = subprocess.run([sys.executable, str(HOOK)], input=stdin, text=True,
                                  capture_output=True, env=self.env, timeout=30)
            self.assertEqual(proc.returncode, 0)


class SettingsRegistrationTest(unittest.TestCase):
    def test_project_settings_register_the_stop_hook(self):
        settings = json.loads((ROOT / ".claude" / "settings.json").read_text(encoding="utf-8"))
        commands = [hook["command"] for group in settings["hooks"]["Stop"] for hook in group["hooks"]]
        self.assertTrue(any("scripts/hooks/clued_capture_guard.py" in command for command in commands))


if __name__ == "__main__":
    unittest.main()
