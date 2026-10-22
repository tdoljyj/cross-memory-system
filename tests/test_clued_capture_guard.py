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
ABOUT_PR_7 = {"mutation": {"content": "PR o/r#7 已合入 main"}}


def ask(use_id: str, question: str, answer: str) -> list[dict]:
    """An AskUserQuestion call and the Owner's answer, as Claude Code logs them."""
    text = (f'Your questions have been answered: "{question}"="{answer}". '
            "You can now continue with these answers in mind.")
    return [call(use_id, "AskUserQuestion", {"questions": [{"question": question}]}), result(use_id, text)]


class GuardHarness(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.env = {**os.environ, "TMPDIR": self.tmp.name}
        self.env.pop("CLUED_CAPTURE_GUARD", None)
        self.session = 0

    def run_hook(self, entries: list[dict], session: str | None = None, trailing: str = "",
                 env: dict | None = None, subagents: dict[str, list[dict]] | None = None
                 ) -> subprocess.CompletedProcess:
        if session is None:
            self.session += 1
            session = f"s{self.session}"
        transcript = Path(self.tmp.name) / f"{session}.jsonl"
        transcript.write_text("".join(json.dumps(e) + "\n" for e in entries) + trailing, encoding="utf-8")
        for name, lines in (subagents or {}).items():
            folder = transcript.with_suffix("") / "subagents"
            folder.mkdir(parents=True, exist_ok=True)
            (folder / f"agent-{name}.jsonl").write_text(
                "".join(json.dumps(e) + "\n" for e in lines), encoding="utf-8")
        payload = {"session_id": session, "transcript_path": str(transcript),
                   "hook_event_name": "Stop", "stop_hook_active": False}
        return subprocess.run([sys.executable, str(HOOK)], input=json.dumps(payload), text=True,
                              capture_output=True, env=env or self.env, timeout=30)


class CaptureGuardTest(GuardHarness):
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
            call("w1", MUTATE, ABOUT_PR_7), result("w1", COMMITTED),
            call("c1", CHECKPOINT), result("c1", {"status": "committed", "version": 2})]
        self.assertEqual(self.run_hook(entries).returncode, 0)

    def test_rejected_write_does_not_settle_an_outcome(self):
        rejected = {"status": "rejected", "error": {"code": "record_version_conflict"}}
        entries = self.merge_turn() + [call("w1", MUTATE, ABOUT_PR_7), result("w1", rejected)]
        proc = self.run_hook(entries)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("did not commit (rejected: record_version_conflict)", proc.stderr)

    def test_error_or_unanswered_write_does_not_settle_an_outcome(self):
        errored = self.merge_turn() + [call("w1", MUTATE, ABOUT_PR_7),
                                       result("w1", "MCP error -32001: Request timed out", True)]
        proc = self.run_hook(errored)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("did not commit (MCP error -32001", proc.stderr)
        # The Host stopped before the write returned (crash, interrupt).
        unanswered = self.merge_turn() + [call("w1", MUTATE, ABOUT_PR_7)]
        proc = self.run_hook(unanswered)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("did not commit (no result)", proc.stderr)

    def test_replayed_committed_write_settles_an_outcome(self):
        entries = self.merge_turn() + [
            call("w1", MUTATE, ABOUT_PR_7), result("w1", {**COMMITTED, "replayed": True}),
            call("c1", CHECKPOINT), result("c1", {"status": "committed"})]
        self.assertEqual(self.run_hook(entries).returncode, 0)

    def test_committed_write_about_something_else_does_not_settle_a_merge(self):
        for text in ("Task 进展，与本次合并无关", "PR #70 已合入", "PR #77"):
            entries = self.merge_turn() + [
                call("w1", MUTATE, {"mutation": {"content": text}}), result("w1", COMMITTED),
                call("c1", CHECKPOINT), result("c1", {"status": "committed"})]
            proc = self.run_hook(entries)
            self.assertEqual(proc.returncode, 2, text)
            self.assertIn("none names PR #7", proc.stderr)

    def test_merge_is_named_by_number_reference_or_merge_commit(self):
        merged = [{"type": "text", "text": '{"sha":"abc1234def","merged":true}'}]
        base = [human("合入", "u1"), call("m1", MERGE, {"owner": "o", "repo": "r", "pullNumber": 7}),
                result("m1", merged)]
        for text in ("PR o/r#7 已合入", "pr:o/r#7", "https://github.com/o/r/pull/7", "PR 7",
                     "merge commit ABC1234"):
            entries = base + [call("w1", MUTATE, {"mutation": {"content": text}}), result("w1", COMMITTED),
                              call("c1", CHECKPOINT), result("c1", {"status": "committed"})]
            self.assertEqual(self.run_hook(entries).returncode, 0, text)

    def test_each_state_of_a_finding_is_reported_once(self):
        steps = [self.merge_turn(),
                 [call("w1", MUTATE, ABOUT_PR_7), result("w1", {"status": "rejected"})],
                 [call("w2", MUTATE, {"mutation": {"content": "unrelated"}}), result("w2", COMMITTED)]]
        expected = ["no BeamingFace write after it", "did not commit", "none names PR #7"]
        entries: list[dict] = []
        for step, text in zip(steps, expected):
            entries += step
            first = self.run_hook(entries, session="same")
            self.assertEqual(first.returncode, 2)
            self.assertIn(text, first.stderr)
            self.assertEqual(self.run_hook(entries, session="same").returncode, 0)
        entries += [call("w3", MUTATE, ABOUT_PR_7), result("w3", COMMITTED),
                    call("c1", CHECKPOINT), result("c1", {"status": "committed"})]
        self.assertEqual(self.run_hook(entries, session="same").returncode, 0)

    def test_gh_pr_merge_number_is_the_subject(self):
        for command in ("gh pr merge 478 --merge --match-head-commit 7ac3f7bc",
                        "gh pr merge https://github.com/o/r/pull/478 --squash", "gh pr merge #478"):
            turn = [human("合入", "u1"), call("b1", "Bash", {"command": command}), result("b1", "ok")]
            unrelated = turn + [call("w1", MUTATE, {"mutation": {"content": "PR #47"}}),
                                result("w1", COMMITTED)]
            proc = self.run_hook(unrelated)
            self.assertEqual(proc.returncode, 2, command)
            self.assertIn("none names PR #478", proc.stderr)
            named = turn + [call("w1", MUTATE, {"mutation": {"content": "PR #478 已合入"}}),
                            result("w1", COMMITTED), call("c1", CHECKPOINT), result("c1", {"status": "committed"})]
            self.assertEqual(self.run_hook(named).returncode, 0, command)

    def test_real_rejection_shape_reports_its_error_code(self):
        rejected = {"status": "rejected", "replayed": False, "error_code": "NOW_CONFLICT"}
        proc = self.run_hook(self.merge_turn() + [call("w1", MUTATE, ABOUT_PR_7), result("w1", rejected)])
        self.assertIn("did not commit (rejected: NOW_CONFLICT)", proc.stderr)

    def test_failure_is_reported_for_the_write_about_the_subject(self):
        entries = self.merge_turn() + [
            call("w1", MUTATE, ABOUT_PR_7), result("w1", {"status": "rejected", "error_code": "about_pr"}),
            call("w2", MUTATE, {"mutation": {"content": "other"}}), result("w2", {"status": "rejected"})]
        self.assertIn("(rejected: about_pr)", self.run_hook(entries).stderr)

    def test_appended_event_counts_as_a_write(self):
        entries = self.merge_turn() + [
            call("e1", "mcp__Clued__clued_append_event", {"summary": "PR o/r#7 merged"}),
            result("e1", {"status": "appended", "event_id": 650, "receipt_id": "r"}),
            call("c1", CHECKPOINT), result("c1", {"status": "committed"})]
        self.assertEqual(self.run_hook(entries).returncode, 0)

    def test_pr_number_is_read_from_every_merge_tool_shape(self):
        for field in ("pullNumber", "pull_number", "number"):
            entries = [human("合入", "u1"), call("m1", MERGE, {"owner": "o", "repo": "r", field: 7}),
                       result("m1", MERGED), call("w1", MUTATE, {"mutation": {"content": "PR #7 已合入"}}),
                       result("w1", COMMITTED), call("c1", CHECKPOINT), result("c1", {"status": "committed"})]
            self.assertEqual(self.run_hook(entries).returncode, 0, field)

    def test_pr_references_in_free_text(self):
        for text in ("合入PR7", "已合并PR 7", "Merged.\nPR 7 done", "pull request 7", "＃7 已合入", "PR-7"):
            entries = self.merge_turn() + [
                call("w1", MUTATE, {"mutation": {"content": text}}), result("w1", COMMITTED),
                call("c1", CHECKPOINT), result("c1", {"status": "committed"})]
            self.assertEqual(self.run_hook(entries).returncode, 0, text)
        for text in ("#7a7", "#70", "sprint 7", "prefix 7"):
            entries = self.merge_turn() + [call("w1", MUTATE, {"mutation": {"content": text}}),
                                           result("w1", COMMITTED)]
            self.assertIn("none names PR #7", self.run_hook(entries).stderr, text)
        # "pr" ending one value and "7" starting the next do not name PR #7.
        entries = self.merge_turn() + [call("w1", MUTATE, {"title": "bump pr", "base_version": 7}),
                                       result("w1", COMMITTED)]
        self.assertIn("none names PR #7", self.run_hook(entries).stderr)

    def test_gh_pr_merge_argument_forms(self):
        for command in ("gh pr merge --squash 478", "gh pr merge -R o/r 478 --merge", 'gh pr merge "478"',
                        "(gh pr merge 478)", "gh pr merge \\\n  478 --merge", "gh pr merge \\\r\n 478",
                        "gh pr merge --match-head-commit 7ac3f7bc 478"):
            turn = [human("合入", "u1"), call("b1", "Bash", {"command": command}), result("b1", "ok"),
                    call("w1", MUTATE, {"mutation": {"content": "PR #47"}}), result("w1", COMMITTED)]
            self.assertIn("none names PR #478", self.run_hook(turn).stderr, command)

    def test_every_merge_in_one_command_is_an_outcome(self):
        command = "gh pr merge 1 --merge && gh pr merge 478 --merge"
        turn = [human("合入", "u1"), call("b1", "Bash", {"command": command}), result("b1", "ok"),
                call("w1", MUTATE, {"mutation": {"content": "PR #1 已合入"}}), result("w1", COMMITTED),
                call("c1", CHECKPOINT), result("c1", {"status": "committed"})]
        proc = self.run_hook(turn)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("none names PR #478", proc.stderr)
        self.assertNotIn("PR #1 with", proc.stderr)

    def test_own_reminder_logged_as_user_entry_is_not_a_decision(self):
        for brand in ("BeamingFace", "KooYomi", "Kooyumi", "Clued"):
            with self.subTest(brand=brand):
                feedback = (f"Stop hook feedback:\n{brand} capture guard (protocol/agent/agent-contract.md §3 "
                            f"and §5):\n- The {brand} write after it did not commit (rejected: authority_escalation_forbidden).")
                entries = self.merge_turn() + [
                    call("w1", MUTATE, ABOUT_PR_7), result("w1", COMMITTED), call("c1", CHECKPOINT),
                    result("c1", {"status": "committed"}),
                    {"type": "user", "uuid": "fb1", "message": {"role": "user", "content": feedback}}]
                self.assertEqual(self.run_hook(entries).returncode, 0)

    def test_subjectless_outcomes_are_settled_by_any_committed_write(self):
        for command in ("gh pr merge --merge", "git push origin HEAD:main"):
            turn = [human("合入", "u1"), call("b1", "Bash", {"command": command}), result("b1", "ok"),
                    call("w1", MUTATE), result("w1", COMMITTED), call("c1", CHECKPOINT),
                    result("c1", {"status": "committed"})]
            self.assertEqual(self.run_hook(turn).returncode, 0, command)

    def test_migration_is_named_by_its_name(self):
        turn = [human("上线迁移", "u1"),
                call("a1", "mcp__supabase__apply_migration", {"name": "capture_unknown"}),
                result("a1", '{"success":true}')]
        unrelated = turn + [call("w1", MUTATE, {"mutation": {"content": "other"}}), result("w1", COMMITTED)]
        self.assertIn("none names migration capture_unknown", self.run_hook(unrelated).stderr)
        named = turn + [call("w1", MUTATE, {"mutation": {"content": "applied capture_unknown"}}),
                        result("w1", COMMITTED), call("c1", CHECKPOINT), result("c1", {"status": "committed"})]
        self.assertEqual(self.run_hook(named).returncode, 0)

    def test_committed_write_without_checkpoint_blocks(self):
        entries = [notification("<task-notification/>"), call("w1", MUTATE), result("w1", COMMITTED)]
        proc = self.run_hook(entries)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("since the last checkpoint", proc.stderr)

    def test_rejected_checkpoint_does_not_clear_pending_writes(self):
        entries = [call("w1", MUTATE), result("w1", COMMITTED), call("c1", CHECKPOINT),
                   result("c1", {"error": "current_truth_changed_since_resume", "status": "conflict"}, True)]
        self.assertEqual(self.run_hook(entries).returncode, 2)

    def test_checkpoint_in_another_context_does_not_settle_writes(self):
        project = "project:0597aa60-9b98-4da6-a4ab-63d7705b632f"
        entries = [call("w1", MUTATE, {"scope": project}), result("w1", COMMITTED),
                   call("c1", CHECKPOINT, {"context_key": "global"}),
                   result("c1", {"status": "committed", "version": 2})]
        proc = self.run_hook(entries)
        self.assertEqual(proc.returncode, 2)
        self.assertIn(f"in context {project}", proc.stderr)
        self.assertIn(f"context_key={project}", proc.stderr)

    def test_checkpoint_without_context_key_counts_as_global(self):
        entries = [call("w1", MUTATE, {"scope": "global"}), result("w1", COMMITTED),
                   call("c1", CHECKPOINT), result("c1", {"status": "committed", "version": 2})]
        self.assertEqual(self.run_hook(entries).returncode, 0)

    def test_checkpoint_context_comes_from_the_result(self):
        # Since PR #466 the server takes an omitted context_key from the session
        # token and returns the context it committed in.
        project = "project:0597aa60-9b98-4da6-a4ab-63d7705b632f"
        writes = [call("w1", MUTATE, {"scope": project}), result("w1", COMMITTED), call("c1", CHECKPOINT)]
        settled = writes + [result("c1", {"status": "committed", "version": 654, "context_key": project})]
        self.assertEqual(self.run_hook(settled).returncode, 0)
        other = writes + [result("c1", {"status": "committed", "context_key": "project:p2"})]
        proc = self.run_hook(other)
        self.assertEqual(proc.returncode, 2)
        self.assertIn(f"in context {project}", proc.stderr)

    def test_each_context_needs_its_own_checkpoint(self):
        project = "project:p1"
        writes = [call("w1", MUTATE, {"scope": "global"}), result("w1", COMMITTED),
                  call("w2", MUTATE, {"scope": project}), result("w2", COMMITTED)]
        global_only = writes + [call("c1", CHECKPOINT, {"context_key": "global"}),
                                result("c1", {"status": "committed"})]
        proc = self.run_hook(global_only)
        self.assertEqual(proc.returncode, 2)
        self.assertIn(f"in context {project}", proc.stderr)
        self.assertNotIn("in context global", proc.stderr)
        both = global_only + [call("c2", CHECKPOINT, {"context_key": project}),
                              result("c2", {"status": "committed"})]
        self.assertEqual(self.run_hook(both).returncode, 0)

    def test_decision_prompt_without_write_blocks(self):
        proc = self.run_hook([human("那就保持原样", "u9")])
        self.assertEqual(proc.returncode, 2)
        self.assertIn("保持原样", proc.stderr)

    def test_decision_prompt_followed_by_write_passes(self):
        entries = [human("对齐脚本的范围缩小吧", "u9"), call("w1", MUTATE), result("w1", COMMITTED),
                   call("c1", CHECKPOINT), result("c1", {"status": "committed"})]
        self.assertEqual(self.run_hook(entries).returncode, 0)

    def test_rejected_write_after_decision_still_blocks(self):
        entries = [human("那就保持原样", "u9"), call("w1", MUTATE),
                   result("w1", {"status": "rejected", "error": {"code": "authority_escalation_forbidden"}})]
        proc = self.run_hook(entries)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("did not commit (rejected: authority_escalation_forbidden)", proc.stderr)

    def test_answered_question_without_write_blocks(self):
        # No decision keyword: every answer to a question counts.
        entries = [human("下一步呢", "u1")] + ask("q1", "PR #9 怎么处理？", "等 CI 全绿后合并 (推荐)")
        proc = self.run_hook(entries)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("answered a question (“等 CI 全绿后合并 (推荐)”)", proc.stderr)

    def test_answered_question_followed_by_committed_write_passes(self):
        entries = ask("q1", "PR #9 怎么处理？", "现在合并") + [
            call("w1", MUTATE), result("w1", COMMITTED), call("c1", CHECKPOINT),
            result("c1", {"status": "committed"})]
        self.assertEqual(self.run_hook(entries).returncode, 0)

    def test_every_answered_question_needs_a_write_after_it(self):
        entries = (ask("q1", "A？", "选一") + [call("w1", MUTATE), result("w1", COMMITTED),
                                               call("c1", CHECKPOINT), result("c1", {"status": "committed"})]
                   + ask("q2", "B？", "选二"))
        proc = self.run_hook(entries)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("“选二”", proc.stderr)
        self.assertNotIn("“选一”", proc.stderr)

    def test_answered_question_with_rejected_write_still_blocks(self):
        entries = ask("q1", "接受吗？", "接受") + [
            call("w1", MUTATE), result("w1", {"status": "rejected", "error_code": "authority_escalation_forbidden"})]
        proc = self.run_hook(entries)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("did not commit (rejected: authority_escalation_forbidden)", proc.stderr)

    def test_answer_followed_only_by_an_event_still_blocks(self):
        # 2026-10-03: a decision kept only as a legacy decision Event withheld
        # every Global Decision. An Event never records an Owner decision.
        for tool, body in (("mcp__Clued__clued_append_event", {"status": "appended", "event_id": 3951}),
                           ("mcp__Clued__clued_event_append", COMMITTED)):
            entries = ask("q1", "先对账吗？", "先对账，优先级先不用管") + [
                call("e1", tool, {"payload": {"text": "先对账"}}), result("e1", body),
                call("c1", CHECKPOINT), result("c1", {"status": "committed"})]
            proc = self.run_hook(entries)
            self.assertEqual(proc.returncode, 2, tool)
            self.assertIn("only an Event followed", proc.stderr)
            self.assertIn("clued_record_mutate", proc.stderr)

    def test_decision_message_followed_only_by_an_event_still_blocks(self):
        entries = [human("先对账，优先级先不用管，就这样", "u9"),
                   call("e1", "mcp__Clued__clued_append_event", {"event_type": "note"}),
                   result("e1", {"status": "appended", "event_id": 7}),
                   call("c1", CHECKPOINT), result("c1", {"status": "committed"})]
        proc = self.run_hook(entries)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("only an Event followed", proc.stderr)

    def test_record_write_settles_a_decision_after_an_event(self):
        entries = ask("q1", "先对账吗？", "先对账") + [
            call("e1", "mcp__Clued__clued_append_event"), result("e1", {"status": "appended", "event_id": 7}),
            call("w1", "mcp__Clued__clued_decision_supersede"), result("w1", COMMITTED),
            call("c1", CHECKPOINT), result("c1", {"status": "committed"})]
        self.assertEqual(self.run_hook(entries).returncode, 0)

    def test_refused_record_write_is_reported_even_when_an_event_committed(self):
        entries = ask("q1", "接受吗？", "接受") + [
            call("w1", MUTATE), result("w1", {"status": "rejected", "error_code": "authority_escalation_forbidden"}),
            call("e1", "mcp__Clued__clued_append_event"), result("e1", {"status": "appended", "event_id": 7}),
            call("c1", CHECKPOINT), result("c1", {"status": "committed"})]
        proc = self.run_hook(entries)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("did not commit (rejected: authority_escalation_forbidden)", proc.stderr)

    def test_declined_or_failed_question_is_not_a_decision(self):
        rejected = ("The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it "
                    "was a file edit, the new_string was NOT written to the file). STOP what you are doing.")
        for body, is_error in ((rejected, True), ("Error: question tool unavailable", True),
                               ("The user dismissed the questions.", False)):
            entries = [call("q1", "AskUserQuestion", {"questions": []}), result("q1", body, is_error)]
            self.assertEqual(self.run_hook(entries).returncode, 0, body)

    def test_answer_is_reported_once_per_state(self):
        entries = ask("q1", "A？", "选一")
        self.assertEqual(self.run_hook(entries, session="same").returncode, 2)
        self.assertEqual(self.run_hook(entries, session="same").returncode, 0)
        entries += [call("w1", MUTATE), result("w1", {"status": "rejected"})]
        proc = self.run_hook(entries, session="same")
        self.assertEqual(proc.returncode, 2)
        self.assertIn("If it needs no record, say why", proc.stderr)
        self.assertEqual(self.run_hook(entries, session="same").returncode, 0)

    def test_answer_shapes(self):
        multi = ('Your questions have been answered: "A？"="选一", "B？"="甲, 乙". '
                 "You can now continue with these answers in mind.")
        listed = [{"type": "text", "text": multi}]
        reworded = 'User has answered your questions: "A？"="选一". You can now continue.'
        for body in (multi, listed, reworded):
            entries = [call("q1", "AskUserQuestion", {"questions": []}), result("q1", body)]
            proc = self.run_hook(entries)
            self.assertEqual(proc.returncode, 2, body)
            self.assertIn("选一", proc.stderr)
        # The Host's structured answers win over the text, quotes and all.
        entry = result("q1", "Answers recorded.")
        entry["toolUseResult"] = {"questions": [], "answers": {"A？": 'say "hi" now', "B？": "b"}}
        proc = self.run_hook([call("q1", "AskUserQuestion", {"questions": []}), entry])
        self.assertEqual(proc.returncode, 2)
        self.assertIn('“say "hi" now; b”', proc.stderr)

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

    def test_sidechain_outcome_in_the_session_transcript_counts(self):
        sidechain_result = {**result("m1", MERGED), "isSidechain": True}
        entries = [human("看看", "u1"), call("m1", MERGE, {"owner": "o", "repo": "r", "pullNumber": 7},
                                            sidechain=True), sidechain_result]
        proc = self.run_hook(entries)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("merged PR o/r#7", proc.stderr)

    def test_outcome_inside_a_subagent_needs_a_record(self):
        def at(entry: dict, second: int) -> dict:
            return {**entry, "timestamp": f"2026-10-02T10:00:{second:02d}.000Z"}
        session = [at(human("让子代理合入 PR 7", "u1"), 0)]
        # The subagent's own prompt is the parent's instruction, not an Owner decision.
        subagent = [at({**human("接受并合入 PR 7", "sub-u"), "isSidechain": True}, 1),
                    at(call("m1", MERGE, {"owner": "o", "repo": "r", "pullNumber": 7}, sidechain=True), 2),
                    at({**result("m1", MERGED), "isSidechain": True}, 3)]
        proc = self.run_hook(session, subagents={"a1": subagent})
        self.assertEqual(proc.returncode, 2)
        self.assertIn("merged PR o/r#7", proc.stderr)
        self.assertNotIn("may be a decision", proc.stderr)
        recorded = session + [at(call("w1", MUTATE, ABOUT_PR_7), 5), at(result("w1", COMMITTED), 6),
                              at(call("c1", CHECKPOINT), 7), at(result("c1", {"status": "committed"}), 8)]
        self.assertEqual(self.run_hook(recorded, subagents={"a1": subagent}).returncode, 0)
        # A write before the subagent merged does not settle it.
        early = [at(human("让子代理合入 PR 7", "u1"), 0), at(call("w1", MUTATE, ABOUT_PR_7), 0),
                 at(result("w1", COMMITTED), 0), at(call("c1", CHECKPOINT), 0),
                 at(result("c1", {"status": "committed"}), 0)]
        self.assertEqual(self.run_hook(early, subagents={"a1": subagent}).returncode, 2)

    def test_gh_api_put_to_the_merge_endpoint_is_a_merge(self):
        merged = '{"sha":"abc1234","merged":true,"message":"Pull Request successfully merged"}'
        for command in ("gh api -X PUT repos/o/r/pulls/478/merge -f merge_method=merge",
                        "gh api --method PUT /repos/o/r/pulls/478/merge", "gh api --method=put repos/o/r/pulls/478/merge"):
            turn = [human("合入", "u1"), call("b1", "Bash", {"command": command}), result("b1", merged)]
            proc = self.run_hook(turn)
            self.assertEqual(proc.returncode, 2, command)
            self.assertIn("merged PR #478 with gh api", proc.stderr)
            named = turn + [call("w1", MUTATE, {"mutation": {"content": "PR #478 已合入"}}), result("w1", COMMITTED),
                            call("c1", CHECKPOINT), result("c1", {"status": "committed"})]
            self.assertEqual(self.run_hook(named).returncode, 0, command)
        # A GET only asks whether it is merged; a failed PUT merged nothing.
        for command, body, is_error in (("gh api repos/o/r/pulls/478/merge", "", False),
                                        ("gh api -X PUT repos/o/r/pulls/478/merge",
                                         '{"message":"Pull Request is not mergeable","status":"405"}', True),
                                        ("gh api -X PUT repos/o/r/pulls/478/merge",
                                         '{"message":"Pull Request is not mergeable","status":"405"}', False)):
            turn = [human("看看", "u1"), call("b1", "Bash", {"command": command}), result("b1", body, is_error)]
            self.assertEqual(self.run_hook(turn).returncode, 0, (command, is_error))

    def test_gh_api_merge_command_forms(self):
        merged = '{"sha":"abc1234","merged":true}'
        for command in ("gh api \\\n  -X PUT \\\n  repos/o/r/pulls/478/merge", "gh api -X 'PUT' repos/o/r/pulls/478/merge",
                        'gh api -XPUT repos/o/r/pulls/478/merge'):
            turn = [human("合入", "u1"), call("b1", "Bash", {"command": command}), result("b1", merged)]
            self.assertIn("merged PR #478 with gh api", self.run_hook(turn).stderr, command)
        # No number to name: any committed write settles it.
        for command, body in (("gh api -X PUT repos/o/r/pulls/$PR/merge", merged),
                              ("gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"X\"}) "
                               "{ clientMutationId } }'", '{"data":{"mergePullRequest":{"clientMutationId":null}}}')):
            turn = [human("合入", "u1"), call("b1", "Bash", {"command": command}), result("b1", body)]
            proc = self.run_hook(turn)
            self.assertIn("merged a PR with gh api", proc.stderr, command)
            settled = turn + [call("w1", MUTATE), result("w1", COMMITTED), call("c1", CHECKPOINT),
                              result("c1", {"status": "committed"})]
            self.assertEqual(self.run_hook(settled).returncode, 0, command)
        # Commands run through the PowerShell tool count too.
        turn = [human("合入", "u1"), call("p1", "PowerShell", {"command": "gh pr merge 478 --merge"}),
                result("p1", "ok")]
        self.assertIn("merged PR #478 with gh pr merge", self.run_hook(turn).stderr)

    def test_failed_gh_api_merge_does_not_hide_a_push_to_main(self):
        command = "gh api -X PUT repos/o/r/pulls/5/merge; git push origin HEAD:main"
        turn = [human("推送", "u1"), call("b1", "Bash", {"command": command}),
                result("b1", '{"message":"Pull Request is not mergeable"}')]
        self.assertIn("pushed to main", self.run_hook(turn).stderr)

    def test_subagent_transcript_edge_cases(self):
        def at(entry: dict, stamp: str | None) -> dict:
            return {**entry, "timestamp": stamp} if stamp else entry
        merge = [at({**human("合入 7", "sub-u"), "isSidechain": True}, "2026-10-02T10:00:06.500Z"),
                 at(call("m1", MERGE, {"owner": "o", "repo": "r", "pullNumber": 7}, sidechain=True),
                    "2026-10-02T10:00:06.600Z"),
                 at({**result("m1", MERGED), "isSidechain": True}, "2026-10-02T10:00:06.700Z")]
        write_at = lambda stamp: [at(human("看看", "u1"), "2026-10-02T10:00:00Z"),
                                  at(call("w1", MUTATE, ABOUT_PR_7), stamp), at(result("w1", COMMITTED), stamp),
                                  at(call("c1", CHECKPOINT), stamp), at(result("c1", {"status": "committed"}), stamp)]
        # Timestamps are compared as times, not strings: 06Z is before 06.700Z.
        self.assertEqual(self.run_hook(write_at("2026-10-02T10:00:06Z"), subagents={"a": merge}).returncode, 2)
        self.assertEqual(self.run_hook(write_at("2026-10-02T10:00:07Z"), subagents={"a": merge}).returncode, 0)
        # A subagent file without timestamps is placed last.
        undated = [{k: v for k, v in e.items() if k != "timestamp"} for e in merge]
        self.assertEqual(self.run_hook(write_at("2026-10-02T10:00:07Z"), subagents={"a": undated}).returncode, 2)
        # An unreadable subagent path does not switch the guard off.
        session = self.merge_turn()
        transcript_dir = Path(self.tmp.name) / "unreadable" / "subagents" / "agent-zz.jsonl"
        transcript_dir.mkdir(parents=True)
        self.assertEqual(self.run_hook(session, session="unreadable").returncode, 2)
        # An entry repeated in a subagent file (same uuid) counts once.
        first = {**human("那就保持原样", "dup"), "timestamp": "2026-10-02T10:00:00Z"}
        later_write = [at(call("w1", MUTATE), "2026-10-02T10:00:05Z"), at(result("w1", COMMITTED), "2026-10-02T10:00:05Z"),
                       at(call("c1", CHECKPOINT), "2026-10-02T10:00:05Z"),
                       at(result("c1", {"status": "committed"}), "2026-10-02T10:00:05Z")]
        replay = [{**first, "isSidechain": True, "timestamp": "2026-10-02T10:00:09Z"}]
        self.assertEqual(self.run_hook([first] + later_write, subagents={"r": replay}).returncode, 0)
        # A subagent's own committed write needs a checkpoint like any other.
        sub_write = [at({**call("w9", MUTATE), "isSidechain": True}, "2026-10-02T10:00:03Z"),
                     at({**result("w9", COMMITTED), "isSidechain": True}, "2026-10-02T10:00:03Z")]
        proc = self.run_hook([at(human("看看", "u1"), "2026-10-02T10:00:00Z")], subagents={"w": sub_write})
        self.assertIn("since the last checkpoint", proc.stderr)

    def test_every_decision_message_since_the_last_write_counts(self):
        first, second = human("那就保持原样", "u1"), human("这个也暂缓", "u2")
        proc = self.run_hook([first, human("好的继续", "u-mid"), second])
        self.assertEqual(proc.returncode, 2)
        self.assertIn("保持原样", proc.stderr)
        self.assertIn("暂缓", proc.stderr)
        settled_first = [first, call("w1", MUTATE), result("w1", COMMITTED), call("c1", CHECKPOINT),
                         result("c1", {"status": "committed"}), human("好的继续", "u-mid"), second]
        proc = self.run_hook(settled_first)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("暂缓", proc.stderr)
        self.assertNotIn("保持原样", proc.stderr)
        # A decision followed by a plain message is still reported.
        proc = self.run_hook([first, human("好的继续", "u-mid")])
        self.assertEqual(proc.returncode, 2)
        self.assertIn("保持原样", proc.stderr)

    def test_host_injected_text_is_not_an_owner_decision(self):
        summary = {"type": "user", "uuid": "c1", "isCompactSummary": True, "isVisibleInTranscriptOnly": True,
                   "message": {"role": "user", "content": "This session is being continued ... the user approved X"}}
        reminder_only = human("<system-reminder> The user approves of nothing yet </system-reminder>", "u1")
        reminder_then_ask = human("<system-reminder>accepted rules</system-reminder>\n帮我看看日志", "u2")
        for entry in (summary, reminder_only, reminder_then_ask):
            self.assertEqual(self.run_hook([entry]).returncode, 0, entry["uuid"])
        # The Owner's own words after a reminder still count.
        proc = self.run_hook([human("<system-reminder>context</system-reminder>\n那就保持原样", "u3")])
        self.assertEqual(proc.returncode, 2)
        self.assertIn("保持原样", proc.stderr)

    def test_incomplete_trailing_line_is_tolerated(self):
        proc = self.run_hook(self.merge_turn(), trailing='{"type": "assistant", "mess')
        self.assertEqual(proc.returncode, 2)

    def test_disabled_by_environment(self):
        env = {**self.env, "CLUED_CAPTURE_GUARD": "off"}
        self.assertEqual(self.run_hook(self.merge_turn(), env=env).returncode, 0)

    def test_missing_transcript_or_bad_input_passes(self):
        for stdin in ("not json", "[]", json.dumps({"session_id": "x", "transcript_path": "/nonexistent"})):
            proc = subprocess.run([sys.executable, str(HOOK)], input=stdin, text=True,
                                  capture_output=True, env=self.env, timeout=30)
            self.assertEqual(proc.returncode, 0)
            self.assertNotIn("Traceback", proc.stderr)

    def test_malformed_transcript_entries_do_not_crash(self):
        odd = [[1], 5, {"type": "user", "message": {"content": None}}, {"type": "user", "message": "x"},
               {"type": "user", "origin": "human", "message": {"content": "接受"}},
               {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": ["x"], "name": MUTATE,
                                                              "input": "a string"}]}},
               {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": ["x"]}]}}]
        proc = self.run_hook(self.merge_turn() + odd)
        self.assertIn(proc.returncode, (0, 2))
        self.assertNotIn("Traceback", proc.stderr)


class Adr06ReplayTest(GuardHarness):
    """BUG-20260924-001 reproduction: the Owner accepts a final review PASS and
    the session ends with no committed record of it (ADR-06 v0.1.1, 2026-09-22)."""

    ACCEPT = "ADR-06 v0.1.1 Fresh-Context 终审 PASS，0 BLOCKER / 0 MAJOR，我接受"

    def accepted(self) -> list[dict]:
        return [human(self.ACCEPT, "u-accept"),
                call("r1", "mcp__Clued__clued_record_list", {"record_type": "task"}),
                result("r1", {"status": "ok", "records": []})]

    def test_acceptance_with_no_record_blocks(self):
        proc = self.run_hook(self.accepted())
        self.assertEqual(proc.returncode, 2)
        self.assertIn("may be a decision", proc.stderr)

    def test_acceptance_with_a_refused_record_still_blocks(self):
        entries = self.accepted() + [
            call("w1", MUTATE, {"authority": "user_explicit", "mutation": {"content": "ADR-06 accepted"}}),
            result("w1", {"status": "rejected", "error": {"code": "authority_escalation_forbidden"}})]
        proc = self.run_hook(entries)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("authority_escalation_forbidden", proc.stderr)

    def test_acceptance_given_as_an_answer_with_no_record_blocks(self):
        # Owner decisions are asked as questions (resident constraint 2dca3cf1).
        entries = [human("看看终审结果", "u1")] + ask(
            "q1", "ADR-06 v0.1.1 终审 PASS，0 BLOCKER / 0 MAJOR。是否接受？", "接受 (推荐)")
        proc = self.run_hook(entries)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("answered a question (“接受 (推荐)”)", proc.stderr)

    def test_acceptance_given_as_an_answer_and_recorded_passes(self):
        entries = [human("看看终审结果", "u1")] + ask("q1", "是否接受 ADR-06 终审 PASS？", "接受 (推荐)") + [
            call("w1", MUTATE, {"authority": "user_explicit", "user_confirmed": True,
                                "mutation": {"content": "ADR-06 accepted"}}),
            result("w1", COMMITTED), call("c1", CHECKPOINT), result("c1", {"status": "committed"})]
        self.assertEqual(self.run_hook(entries).returncode, 0)

    def test_acceptance_recorded_and_checkpointed_passes(self):
        entries = self.accepted() + [
            call("w1", MUTATE, {"authority": "user_explicit", "user_confirmed": True,
                                "mutation": {"content": "ADR-06 accepted"}}),
            result("w1", COMMITTED), call("c1", CHECKPOINT), result("c1", {"status": "committed"})]
        self.assertEqual(self.run_hook(entries).returncode, 0)


class SettingsRegistrationTest(unittest.TestCase):
    def test_project_settings_register_the_stop_hook(self):
        settings = json.loads((ROOT / ".claude" / "settings.json").read_text(encoding="utf-8"))
        commands = [hook["command"] for group in settings["hooks"]["Stop"] for hook in group["hooks"]]
        self.assertTrue(any("scripts/hooks/clued_capture_guard.py" in command for command in commands))


if __name__ == "__main__":
    unittest.main()
