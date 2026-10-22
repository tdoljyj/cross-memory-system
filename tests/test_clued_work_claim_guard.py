"""Tests for scripts/hooks/clued_work_claim_guard.py (Claude Code work-claim hooks)."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HOOK = ROOT / "scripts" / "hooks" / "clued_work_claim_guard.py"
CLAIM_ID = "1bd72d4d-d2f8-4459-b3a7-c0521258e405"
TASK_ID = "178ff66c-1432-46e2-8b27-d8a7a1755be5"


def load_guard():
    spec = importlib.util.spec_from_file_location("clued_work_claim_guard", HOOK)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GUARD = load_guard()


def bash_kind(command: str) -> str | None:
    return GUARD.guarded_kind({"tool_name": "Bash", "tool_input": {"command": command}})


def stamp(delta: timedelta) -> str:
    # Postgres prints a variable-length fraction; keep five digits on purpose.
    value = datetime.now(timezone.utc) + delta
    return value.strftime("%Y-%m-%dT%H:%M:%S.") + f"{value.microsecond:06d}"[:5] + "+00:00"


def claim(status: str = "ACTIVE", claim_id: str = CLAIM_ID, expires: timedelta = timedelta(hours=1)) -> dict:
    return {"claim_id": claim_id, "task_id": TASK_ID, "context_key": "global", "fence": 1,
            "lease_version": 1, "status": status, "expires_at": stamp(expires),
            "write_set": ["scripts/hooks/clued_work_claim_guard.py"], "base_commit": "1b6ca6d8",
            "holder_session_ref": "session_test"}


def committed(value: dict) -> dict:
    return {"status": "committed", "receipt_id": "r1", "claim": value}


class WorkClaimGuardTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.project = Path(self.tmp.name) / "project"
        self.project.mkdir()
        self.env = {**os.environ, "TMPDIR": self.tmp.name, "CLAUDE_PROJECT_DIR": str(self.project)}
        for name in ("CLUED_WORK_CLAIM_GUARD", "CLUED_WORK_CLAIM", "CLUED_CONTEXT_READ_TOKEN",
                     "CLUED_SUPABASE_URL", "CLUED_SUPABASE_PUBLISHABLE_KEY"):
            self.env.pop(name, None)

    def run_hook(self, payload: dict, env: dict | None = None) -> subprocess.CompletedProcess:
        payload = {"session_id": "s1", **payload}
        return subprocess.run([sys.executable, str(HOOK)], input=json.dumps(payload), text=True,
                              capture_output=True, env=env or self.env, timeout=30)

    def pre(self, name: str, tool_input: dict, session: str = "s1", env: dict | None = None):
        return self.run_hook({"hook_event_name": "PreToolUse", "session_id": session,
                              "tool_name": name, "tool_input": tool_input}, env)

    def bash(self, command: str, session: str = "s1", env: dict | None = None):
        return self.pre("Bash", {"command": command}, session, env)

    def post(self, name: str, response, tool_input: dict | None = None):
        return self.run_hook({"hook_event_name": "PostToolUse", "tool_name": name,
                              "tool_input": tool_input or {}, "tool_response": response})

    def stored(self) -> dict:
        path = self.project / ".clued" / "work-claim.json"
        return json.loads(path.read_text(encoding="utf-8"))["claims"] if path.exists() else {}

    # PreToolUse -------------------------------------------------------------

    def test_push_without_claim_blocks_once_per_session(self):
        first = self.bash("git push -u origin claude/x")
        self.assertEqual(first.returncode, 2)
        self.assertIn("Clued-Work-Claim", first.stderr)
        self.assertIn("clued_work_claim", first.stderr)
        self.assertEqual(self.bash("git push -u origin claude/x").returncode, 0)
        self.assertEqual(self.bash("git push -u origin claude/x", session="s2").returncode, 2)

    def test_spend_and_publish_are_reported_separately(self):
        self.assertEqual(self.bash("cd apps/clued-cloud && npm run build").returncode, 2)
        self.assertEqual(self.bash("node --test tests/a.test.mjs").returncode, 0)
        self.assertEqual(self.bash("gh pr create --fill").returncode, 2)

    def test_guarded_commands(self):
        for command in ("npm ci", "npm install", "pnpm test", "yarn add x", "npm run test:work:claims",
                        "node --test x.mjs", "python3 -m pytest -q", "pytest", "python3 -m unittest t",
                        "pip install -r r.txt", "npx vitest run", "cargo test", "go build ./...",
                        "FOO=1 npm test", "cd a; npm ci", "true && git push", "npm run mcp:tools:verify",
                        "npx tsc --noEmit", "npx --yes wrangler deploy", "gh workflow run g4.yml -f ref=x",
                        "gh run rerun 123 --failed"):
            with self.subTest(command=command):
                self.assertEqual(self.bash(command, session=command).returncode, 2)

    def test_unguarded_commands_pass(self):
        for command in ("git status", "ls -la", "git commit -m 'git push later'", "echo npm test",
                        "grep -rn 'node --test' .", "git fetch origin main", "npm view next version",
                        "npm info x", "gh run view 1", "gh workflow list", "echo npx tsc",
                        "cat <<'EOF' > f\ngit push\nnpm ci\nEOF"):
            with self.subTest(command=command):
                self.assertEqual(self.bash(command, session=command).returncode, 0)

    # Task ada1334c: inside the quoted arguments of a read-only text command, a
    # | ; ( or command word is data, not a command.
    QUOTED_DATA = ("rg 'foo|npx tsc' .", "grep -E '(npm test|node --test)' package.json",
                   "grep -rn 'x; npm ci' .", 'git commit -m "fix: (npm test) | npx tsc"',
                   "git log --grep 'npm ci'", 'git commit -m "subject\nnpm ci in the body"',
                   "LC_ALL=C grep -n 'a|npm ci' f", "sudo rg 'x; git push' /", "git tag -a v1 -m 'v1; npm ci'",
                   "sed -n '/a|npm test/p' f", "awk '/x|npm ci/' f", "echo 'a; npm test'",
                   "printf '%s; npm ci\\n' x", "git show HEAD --grep='x|npm ci'", "git grep -n 'x|npm ci'",
                   "rg 'a|npx tsc' . | head -5", "grep -c 'x;npm ci' f > out.txt", "egrep '(npm test)' f; ls",
                   'echo "$(date) | npm test"', 'grep "a|npm ci" f && git status', "rg $'a\\'|npm ci' .")
    # Everything else is scanned exactly as origin/main 1dcf6ef scanned it. The
    # expected kinds are what that version's guarded_kind returns for each one.
    SCANNED_AS_WRITTEN = (
        ("ssh host 'cd app && npm ci'", "spend"),
        ("echo 'cd x && npm test' | bash", "spend"),
        ("$SHELL -c 'cd x && npm test'", "spend"),
        ("docker run img ash -c 'cd x && npm test'", "spend"),
        ("su -c 'cd x && npm test'", "spend"),
        ("bash <<< 'cd x && npm test'", "spend"),
        ("sh " + "-o " * 36 + "-c 'a; npm test'", "spend"),
        ("cd apps/x && npm test", "spend"),
        ("(npm test)", "spend"),
        ("foo | npx tsc", "spend"),
        ("echo 'a|b' | npx tsc", "spend"),
        ('echo "$(npm test)"', "spend"),
        ("grep x f && npm test", "spend"),
        ("rg foo | npx tsc", "spend"),
        ('sh -c "npm test"', None),
        ("bash -c 'cd x && npm test'", "spend"),
        ("eval 'x; npm test'", "spend"),
        ("xargs sh -c 'x; npm test'", "spend"),
        ("node -e 'x; npm test'", "spend"),
        ("python3 -c 'x; npm test'", "spend"),
        ("echo 'cd x && npm test' | grep cd | sh", "spend"),
        ("echo 'x && npm test' 2>&1 | bash", "spend"),
        ("(echo 'x; npm test') | sh", "spend"),
        ("{ echo 'x; npm test'; } | sh", "spend"),
        ("bash <(echo 'cd x; npm test')", "spend"),
        ('echo "`cd x && npm test`"', "spend"),
        ("echo \"$(grep 'a|npm ci' f)\"", "spend"),
        ("grep x <(npm test)", "spend"),
        ("awk 'BEGIN{system(\"x; npm test\")}'", "spend"),
        ("sed -n '1e x; npm test' f", "spend"),
        ("sed -n 's/a/x; npm test/ge' f", "spend"),
        ("rg --pre 'x; npm test' foo", "spend"),
        ("git grep -O'x; npm test' foo", "spend"),
        ("printf -v c 'x; npm test'", "spend"),
        ("/usr/bin/grep 'x; npm ci' f", "spend"),
        ("git -C d log --grep 'x; npm ci'", "spend"),
        ("PAGER='x; npm test' git log", "spend"),
        ("grep 'unterminated | npm ci", "spend"),
        ("ls # it's here\nnpm ci", "spend"),
        ("for f in *; do grep 'a|b' $f; done; npm ci", "spend"),
        ("git push", "publish"),
        ("rg -n 'x|y' . && git push", "publish"),
        ("echo 'a; git push' | sh", "publish"),
        ("grep x f; gh pr create --fill", "publish"),
        ("git commit -m x && git push origin HEAD", "publish"),
        ("ssh h 'git push'", None),
        ("sh -c 'git push'", None),
    )

    def test_quoted_data_in_text_commands_passes(self):
        for n, command in enumerate(self.QUOTED_DATA):
            with self.subTest(command=command):
                self.assertIsNone(bash_kind(command))
                result = self.bash(command, session=f"quoted-data-{n}")
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_other_commands_are_scanned_as_written(self):
        for command, expected in self.SCANNED_AS_WRITTEN:
            with self.subTest(command=command):
                self.assertEqual(bash_kind(command), expected)
        self.assertEqual(self.bash("echo 'cd x && npm test' | bash", session="piped").returncode, 2)
        self.assertEqual(self.bash("ssh host 'git push'; git push", session="pushed").returncode, 2)

    def test_blanking_keeps_quotes_and_length(self):
        command = "grep -E '(npm test|x)' f && git commit -m \"a; $(date) | b\""
        blanked = GUARD.scannable(command)
        self.assertEqual(len(blanked), len(command))
        self.assertEqual(blanked, "grep -E '            ' f && git commit -m \"   $(date)    \"")
        for command in ("sh -c 'a|b'", "grep 'open", "grep x )"):
            with self.subTest(command=command):
                self.assertEqual(GUARD.scannable(command), command)

    def test_classification_time_is_linear(self):
        quoted = "'" + "x|npm ci; (" * 40 + "'"
        unit = " ; ".join(("sh " + "-o " * 40, "grep " + "-o " * 30 + quoted,
                           'git commit -m "' + "a|b $(c 'd') `e` " * 4 + '"', "rg " + "'' " * 30,
                           "echo $(" + "$(" * 20 + ")" * 20 + ")", "echo " + quoted + " | head" * 10))
        balanced = (unit + " ; ") * (5000 // (len(unit) + 3))
        balanced += " " * (5000 - len(balanced))
        for command in (balanced, "rg '" + balanced[4:]):
            with self.subTest(parses=command is balanced):
                self.assertEqual(len(command), 5000)
                self.assertEqual(GUARD.shell_segments(command) is not None, command is balanced)
                started = time.perf_counter()
                bash_kind(command)
                self.assertLess(time.perf_counter() - started, 0.5)
        self.assertNotEqual(GUARD.scannable(balanced), balanced)

    def test_github_publish_tools_are_guarded(self):
        for name in ("mcp__github__create_pull_request", "mcp__github__push_files",
                     "mcp__github__create_or_update_file"):
            with self.subTest(name=name):
                self.assertEqual(self.pre(name, {"owner": "o"}, session=name).returncode, 2)
        self.assertEqual(self.pre("mcp__github__pull_request_read", {}, session="read").returncode, 0)
        self.assertEqual(self.pre("Read", {"file_path": "x"}, session="read2").returncode, 0)

    def test_ci_dispatch_and_subtasks_are_spend(self):
        for name, tool_input in (("mcp__github__actions_run_trigger", {"method": "run_workflow"}),
                                 ("mcp__claude-code-remote__create_session", {"prompt": "x"}),
                                 ("Workflow", {"script": "x"}),
                                 ("Agent", {"subagent_type": "general-purpose", "prompt": "x"}),
                                 ("Agent", {"prompt": "x"})):
            with self.subTest(name=name, tool_input=tool_input):
                result = self.pre(name, tool_input, session=f"{name}{tool_input}")
                self.assertEqual(result.returncode, 2)
                self.assertIn("starts CI or dispatches a subtask", result.stderr)
        for kind in ("Explore", "Plan", "claude-code-guide"):
            with self.subTest(agent=kind):
                self.assertEqual(self.pre("Agent", {"subagent_type": kind}, session=kind).returncode, 0)
        # One kind per session: a build after a dispatch passes.
        self.assertEqual(self.pre("Workflow", {}, session="mixed").returncode, 2)
        self.assertEqual(self.bash("npm ci", session="mixed").returncode, 0)

    def test_repository_edits_are_guarded(self):
        inside = str(self.project / "scripts" / "x.py")
        for name, tool_input in (("Edit", {"file_path": inside}), ("Write", {"file_path": "docs/a.md"}),
                                 ("NotebookEdit", {"notebook_path": str(self.project / "n.ipynb")})):
            with self.subTest(name=name):
                result = self.pre(name, tool_input, session=f"edit-{name}")
                self.assertEqual(result.returncode, 2)
                self.assertIn("changes a repository file", result.stderr)
        outside = str(Path(self.tmp.name) / "scratch" / "notes.md")
        for tool_input in ({"file_path": outside}, {"file_path": str(self.project / ".clued" / "x.json")},
                           {"file_path": str(self.project / ".git" / "config")},
                           {"file_path": str(self.project / ".." / "elsewhere.txt")}, {}):
            with self.subTest(tool_input=tool_input):
                self.assertEqual(self.pre("Write", tool_input, session=f"out-{tool_input}").returncode, 0)
        # Edits and publishing are reported separately.
        self.assertEqual(self.pre("Edit", {"file_path": inside}, session="both").returncode, 2)
        self.assertEqual(self.bash("git push", session="both").returncode, 2)
        # A recorded claim allows edits.
        self.post("mcp__Clued__clued_work_claim", committed(claim()))
        self.assertEqual(self.pre("Edit", {"file_path": inside}, session="claimed").returncode, 0)

    def test_env_claim_and_off_switch_allow(self):
        self.assertEqual(self.bash("git push", env={**self.env, "CLUED_WORK_CLAIM": CLAIM_ID}).returncode, 0)
        self.assertEqual(self.bash("git push", env={**self.env, "CLUED_WORK_CLAIM_GUARD": "off"}).returncode, 0)

    # PostToolUse -> PreToolUse ----------------------------------------------

    def test_recorded_claim_allows_and_shapes_are_parsed(self):
        shapes = {
            "structured": {"content": [{"type": "text", "text": "{}"}], "structuredContent": committed(claim())},
            "content": [{"type": "text", "text": json.dumps(committed(claim()))}],
            "text": json.dumps(committed(claim())),
            "object": committed(claim()),
        }
        for label, response in shapes.items():
            with self.subTest(shape=label):
                (self.project / ".clued" / "work-claim.json").unlink(missing_ok=True)
                self.assertEqual(self.post("mcp__Clued__clued_work_claim", response).returncode, 0)
                self.assertIn(CLAIM_ID, self.stored())
                self.assertEqual(self.bash("git push", session=f"after-{label}").returncode, 0)

    def test_rejected_claim_is_not_recorded(self):
        rejected = {"status": "rejected", "error_code": "work_claim_conflict", "conflicts": []}
        self.post("mcp__Clued__clued_work_claim", rejected)
        self.assertEqual(self.stored(), {})
        self.assertEqual(self.bash("git push").returncode, 2)

    def test_expired_claim_does_not_count(self):
        self.post("mcp__Clued__clued_work_claim", committed(claim(expires=-timedelta(minutes=1))))
        self.assertEqual(self.bash("git push").returncode, 2)

    def test_release_and_draining(self):
        self.post("mcp__Clued__clued_work_claim", committed(claim()))
        self.post("mcp__Clued__clued_work_release", committed(claim(status="DRAINING")))
        self.assertEqual(self.stored()[CLAIM_ID]["status"], "DRAINING")
        self.assertEqual(self.bash("git push", session="draining").returncode, 0)
        self.post("mcp__Clued__clued_work_release", committed(claim(status="RELEASED")))
        self.assertEqual(self.stored(), {})
        self.assertEqual(self.bash("git push", session="released").returncode, 2)

    def test_renew_updates_and_takeover_replaces(self):
        self.post("mcp__Clued__clued_work_claim", committed(claim()))
        renewed = {**claim(), "lease_version": 2}
        self.post("mcp__Clued__clued_work_renew", committed(renewed))
        self.assertEqual(self.stored()[CLAIM_ID]["lease_version"], 2)
        new_id = "2bd72d4d-d2f8-4459-b3a7-c0521258e405"
        self.post("mcp__Clued__clued_work_takeover", committed(claim(claim_id=new_id)), {"claim_id": CLAIM_ID})
        self.assertEqual(set(self.stored()), {new_id})

    def test_lease_key_is_never_stored(self):
        # The claim's private lease key (contract §1.7, migration 20261005190000)
        # stays in the session: neither the answer's key nor a renewal's input
        # reaches .clued/work-claim.json.
        key = "clued_lk_" + "a" * 64
        self.post("mcp__Clued__clued_work_claim", {**committed(claim()), "lease_key": key})
        self.post("mcp__Clued__clued_work_renew", {**committed({**claim(), "lease_version": 2}), "transferred": True},
                  {"claim_id": CLAIM_ID, "lease_key": key})
        self.assertEqual(self.stored()[CLAIM_ID]["lease_version"], 2)
        self.assertNotIn(key, (self.project / ".clued" / "work-claim.json").read_text(encoding="utf-8"))

    def test_other_tools_are_ignored(self):
        self.post("mcp__Clued__clued_record_mutate", committed(claim()))
        self.assertEqual(self.stored(), {})

    # SessionStart -----------------------------------------------------------

    def session_start(self, env: dict | None = None) -> str:
        result = self.run_hook({"hook_event_name": "SessionStart", "source": "startup"}, env)
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)["hookSpecificOutput"]
        self.assertEqual(output["hookEventName"], "SessionStart")
        return output["additionalContext"]

    def test_session_start_without_token(self):
        self.post("mcp__Clued__clued_work_claim", committed(claim()))
        text = self.session_start()
        self.assertIn("clued_work_claim", text)
        self.assertIn("Clued-Work-Claim", text)
        self.assertIn(CLAIM_ID, text)
        self.assertIn("clued_session_resume", text)

    def test_session_start_reads_live_claims(self):
        seen = {}
        live = {"status": "ok", "active_work_claims": [claim(claim_id="3bd72d4d-d2f8-4459-b3a7-c0521258e405")]}

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                seen["path"] = self.path
                seen["apikey"] = self.headers.get("apikey")
                seen["body"] = json.loads(self.rfile.read(int(self.headers["content-length"])))
                payload = json.dumps(live).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        env = {**self.env, "CLUED_CONTEXT_READ_TOKEN": "clued_bnd_test",
               "CLUED_SUPABASE_URL": f"http://127.0.0.1:{server.server_port}",
               "CLUED_SUPABASE_PUBLISHABLE_KEY": "sb_publishable_test"}
        text = self.session_start(env)
        self.assertIn("3bd72d4d-d2f8-4459-b3a7-c0521258e405", text)
        self.assertEqual(seen["path"], "/rest/v1/rpc/clued_work_claims_active_v1")
        self.assertEqual(seen["apikey"], "sb_publishable_test")
        self.assertEqual(seen["body"]["p_token_hash"], hashlib.sha256(b"clued_bnd_test").hexdigest())

    def test_session_start_degrades_when_clued_is_unreachable(self):
        env = {**self.env, "CLUED_CONTEXT_READ_TOKEN": "clued_bnd_test",
               "CLUED_SUPABASE_URL": "http://127.0.0.1:9", "CLUED_SUPABASE_PUBLISHABLE_KEY": "sb_publishable_test"}
        self.assertIn("unavailable", self.session_start(env))
        insecure = {**env, "CLUED_SUPABASE_URL": "http://example.com"}
        self.assertIn("unavailable", self.session_start(insecure))

    def test_public_config_is_read_from_the_repository_file(self):
        source = self.project / "apps" / "clued-cloud" / "app"
        source.mkdir(parents=True)
        (source / "supabase-public-config.ts").write_text(
            'x\n    return { url: "https://127.0.0.1:9", key: "sb_publishable_test" };\n', encoding="utf-8")
        env = {**self.env, "CLUED_CONTEXT_READ_TOKEN": "clued_bnd_test"}
        self.assertIn("reading live claims failed", self.session_start(env))

    def test_bad_payloads_are_ignored(self):
        for raw in ("", "not json", "[]"):
            result = subprocess.run([sys.executable, str(HOOK)], input=raw, text=True,
                                    capture_output=True, env=self.env, timeout=30)
            self.assertEqual(result.returncode, 0)


# Agent messages (agent-contract §1.7, AgentMessaging.v0.1 step 2) ----------

INBOX = {"unread_count": 1, "open_request_count": 1, "awaiting_reply_count": 0,
         "latest_unread": [{"message_id": "m1", "kind": "request", "subject": "release apps/x?"}]}
EMPTY_INBOX = {"unread_count": 0, "open_request_count": 0, "awaiting_reply_count": 0, "latest_unread": []}


def call(use_id: str, name: str, tool_input: dict | None = None) -> dict:
    return {"type": "assistant", "message": {"content": [
        {"type": "tool_use", "id": use_id, "name": f"mcp__Clued__{name}", "input": tool_input or {}}]}}


def result(use_id: str, body: dict, is_error: bool = False) -> dict:
    return {"type": "user", "message": {"content": [
        {"type": "tool_result", "tool_use_id": use_id, "is_error": is_error,
         "content": [{"type": "text", "text": json.dumps(body)}]}]}}


class AgentInboxTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.env = {**os.environ, "TMPDIR": self.tmp.name, "CLAUDE_PROJECT_DIR": self.tmp.name}
        self.env.pop("CLUED_WORK_CLAIM_GUARD", None)
        self.transcript = Path(self.tmp.name) / "session.jsonl"

    def run_hook(self, payload: dict) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, str(HOOK)], input=json.dumps({"session_id": "s1", **payload}),
                              text=True, capture_output=True, env=self.env, timeout=30)

    def stop(self, entries: list[dict]) -> subprocess.CompletedProcess:
        self.transcript.write_text("\n".join(json.dumps(e) for e in entries) + "\n", encoding="utf-8")
        return self.run_hook({"hook_event_name": "Stop", "transcript_path": str(self.transcript),
                              "stop_hook_active": False})

    def post(self, name: str, response) -> subprocess.CompletedProcess:
        return self.run_hook({"hook_event_name": "PostToolUse", "tool_name": f"mcp__Clued__{name}",
                              "tool_input": {}, "tool_response": response})

    def test_resume_and_renew_with_waiting_messages_add_a_reminder(self):
        for name, body in (("clued_session_resume", {"session_token": "t", "agent_inbox": INBOX}),
                           ("clued_work_renew", {"status": "committed", "claim": claim(), "agent_inbox": INBOX})):
            for response in (body, [{"type": "text", "text": json.dumps(body)}]):
                with self.subTest(name=name, shape=type(response).__name__):
                    out = self.post(name, response)
                    self.assertEqual(out.returncode, 0, out.stderr)
                    context = json.loads(out.stdout)["hookSpecificOutput"]
                    self.assertEqual(context["hookEventName"], "PostToolUse")
                    self.assertIn("1 request(s) to you not yet answered", context["additionalContext"])
                    self.assertIn("clued_agent_message_send reply_to", context["additionalContext"])
                    self.assertIn("reconnect the BeamingFace connector", context["additionalContext"])

    def test_disabled_inbox_reminder_requires_reading_without_replies(self):
        disabled = {**INBOX, "messages_enabled": False}
        for name, body in (("clued_session_resume", {"session_token": "t", "agent_inbox": disabled}),
                           ("clued_work_renew", {"status": "committed", "claim": claim(), "agent_inbox": disabled})):
            for response in (body, {"structuredContent": body}, [{"type": "text", "text": json.dumps(body)}]):
                with self.subTest(name=name, shape=type(response).__name__):
                    out = self.post(name, response)
                    self.assertEqual(out.returncode, 0, out.stderr)
                    text = json.loads(out.stdout)["hookSpecificOutput"]["additionalContext"]
                    self.assertIn("read them with clued_agent_inbox", text)
                    self.assertIn("do not send or reply", text)
                    self.assertIn("Tell the Owner in one line whom you need to reach and why", text)
                    self.assertIn("Do not ask the Owner to turn the switch on", text)
                    self.assertNotIn("clued_agent_message_send", text)
                    self.assertNotIn("answer each request", text)

    def test_disabled_unread_or_open_requests_still_need_a_read(self):
        for unread in (0, 1):
            for name in ("clued_session_resume", "clued_work_renew"):
                with self.subTest(unread=unread, name=name):
                    use_id = f"disabled-{name}-{unread}"
                    inbox = {**INBOX, "unread_count": unread, "messages_enabled": False}
                    body = {"status": "committed", "claim": claim(), "agent_inbox": inbox}
                    entries = [call(use_id, name), result(use_id, body)]
                    out = self.stop(entries)
                    self.assertEqual(out.returncode, 2, out.stderr)
                    self.assertIn("you have not read them", out.stderr)
                    self.assertIn("do not send or reply", out.stderr)
                    self.assertNotIn("clued_agent_message_send", out.stderr)
                    self.assertNotIn("answered them in another way", out.stderr)
                    read = entries + [call("i1", "clued_agent_inbox"), result("i1", {"status": "ok"})]
                    self.assertIsNone(GUARD.inbox_finding(read), "disabled open requests need no reply")
                    self.assertEqual(self.stop(read).returncode, 0)

    def test_disabled_failed_reads_do_not_settle_unread_messages(self):
        for index, (body, is_error) in enumerate((( {"error": "insufficient_scope"}, True),
                                                 ({"status": "rejected", "error_code": "insufficient_scope"}, False))):
            with self.subTest(body=body):
                use_id = f"disabled-read-{index}"
                inbox = {**INBOX, "messages_enabled": False}
                entries = [call(use_id, "clued_session_resume"),
                           result(use_id, {"session_token": "t", "agent_inbox": inbox}),
                           call("i1", "clued_agent_inbox"), result("i1", body, is_error)]
                out = self.stop(entries)
                self.assertEqual(out.returncode, 2, out.stderr)
                self.assertIn("you have not read them", out.stderr)
                self.assertNotIn("clued_agent_message_send", out.stderr)

    def test_disabled_send_overrides_a_prior_enabled_summary(self):
        rejection = {"status": "rejected", "error_code": "agent_messages_disabled"}
        responses = (rejection, {"error": "agent_messages_disabled"},
                     {"error": {"code": "agent_messages_disabled"}},
                     {"structuredContent": rejection, "isError": True},
                     {"content": [{"type": "text", "text": json.dumps(rejection)}], "isError": True})
        for response in responses:
            with self.subTest(response=response):
                entries = [call("r1", "clued_session_resume"),
                           result("r1", {"session_token": "t", "agent_inbox": {**INBOX, "messages_enabled": True}}),
                           call("i1", "clued_agent_inbox"), result("i1", {"status": "ok"}),
                           call("s1", "clued_agent_message_send", {"reply_to": "m1"}), result("s1", response, True)]
                self.assertIsNone(GUARD.inbox_finding(entries))
                self.assertEqual(self.stop(entries).returncode, 0)
                unread = entries[:2] + entries[4:]
                finding = GUARD.inbox_finding(unread)
                self.assertIsNotNone(finding, "a refused send does not settle an unread inbox")
                self.assertIn("do not send or reply", finding[1])
                self.assertNotIn("clued_agent_message_send", finding[1])

    def test_newest_enabled_summary_requires_replies_again(self):
        disabled = {**INBOX, "messages_enabled": False}
        for explicit in (False, True):
            with self.subTest(explicit=explicit):
                enabled = {**INBOX, **({"messages_enabled": True} if explicit else {})}
                use_id = f"reenabled-{explicit}"
                entries = [call("r1", "clued_session_resume"),
                           result("r1", {"session_token": "t", "agent_inbox": disabled}),
                           call("i1", "clued_agent_inbox"), result("i1", {"status": "ok"}),
                           call("s1", "clued_agent_message_send", {"reply_to": "m1"}),
                           result("s1", {"status": "rejected", "error_code": "agent_messages_disabled"}),
                           call(use_id, "clued_work_renew"),
                           result(use_id, {"status": "committed", "claim": claim(), "agent_inbox": enabled}),
                           call("i2", "clued_agent_inbox"), result("i2", {"status": "ok"})]
                out = self.stop(entries)
                self.assertEqual(out.returncode, 2, out.stderr)
                self.assertIn("you have not answered any of the requests", out.stderr)
                self.assertIn("clued_agent_message_send reply_to", out.stderr)
                self.assertNotIn("Agent messages are disabled", out.stderr)
                replied = entries + [call("s2", "clued_agent_message_send", {"reply_to": "m1"}),
                                     result("s2", {"status": "committed"})]
                self.assertIsNone(GUARD.inbox_finding(replied))
                self.assertEqual(self.stop(replied).returncode, 0)

    def test_nothing_waiting_adds_nothing(self):
        for body in ({"session_token": "t", "agent_inbox": EMPTY_INBOX},
                     {"session_token": "t", "agent_inbox": None, "agent_inbox_unavailable": True},
                     {"session_token": "t"}):
            out = self.post("clued_session_resume", body)
            self.assertEqual((out.returncode, out.stdout), (0, ""), out.stderr)
        out = self.post("clued_record_list", {"agent_inbox": INBOX})
        self.assertEqual((out.returncode, out.stdout), (0, ""))

    def test_stop_blocks_once_while_messages_are_unread(self):
        entries = [call("r1", "clued_session_resume"), result("r1", {"session_token": "t", "agent_inbox": INBOX})]
        first = self.stop(entries)
        self.assertEqual(first.returncode, 2)
        self.assertIn("you have not read them", first.stderr)
        self.assertEqual(self.stop(entries).returncode, 0, "reported once")

    def test_a_read_without_a_reply_still_owes_the_answer(self):
        entries = [call("r1", "clued_session_resume"), result("r1", {"session_token": "t", "agent_inbox": INBOX}),
                   call("i1", "clued_agent_inbox", {"session_ref": "s1"}), result("i1", {"status": "ok", "messages": []})]
        out = self.stop(entries)
        self.assertEqual(out.returncode, 2)
        self.assertIn("you have not answered any of the requests", out.stderr)

    def test_a_committed_reply_settles_it(self):
        entries = [call("n1", "clued_work_renew"),
                   result("n1", {"status": "committed", "claim": claim(), "agent_inbox": INBOX}),
                   call("i1", "clued_agent_inbox"), result("i1", {"status": "ok", "messages": []}),
                   call("s1", "clued_agent_message_send", {"reply_to": "m1", "body": "releasing now"}),
                   result("s1", {"status": "committed", "receipt_id": "x"})]
        self.assertEqual(self.stop(entries).returncode, 0)

    def test_failed_reads_and_replies_do_not_count(self):
        base = [call("r1", "clued_session_resume"), result("r1", {"session_token": "t", "agent_inbox": INBOX})]
        out = self.stop(base + [call("i1", "clued_agent_inbox"), result("i1", {"error": "insufficient_scope"}, True)])
        self.assertIn("you have not read them", out.stderr)
        out = self.stop(base + [call("i1", "clued_agent_inbox"), result("i1", {"status": "ok"}),
                                call("s1", "clued_agent_message_send", {"reply_to": "m1"}),
                                result("s1", {"status": "rejected", "error_code": "agent_message_not_participant"})])
        self.assertIn("you have not answered", out.stderr)
        out = self.stop(base[:0] + [call("r2", "clued_session_resume"),
                                    result("r2", {"session_token": "t", "agent_inbox": INBOX}),
                                    call("i1", "clued_agent_inbox"), result("i1", {"status": "ok"}),
                                    call("s1", "clued_agent_message_send", {"to": {"claim_id": CLAIM_ID}}),
                                    result("s1", {"status": "committed"})])
        self.assertIn("you have not answered", out.stderr, "a new message is not a reply")

    def test_a_later_empty_report_clears_an_earlier_one(self):
        entries = [call("r1", "clued_session_resume"), result("r1", {"session_token": "t", "agent_inbox": INBOX}),
                   call("r2", "clued_session_resume"), result("r2", {"session_token": "t", "agent_inbox": EMPTY_INBOX})]
        self.assertEqual(self.stop(entries).returncode, 0)

    def test_unread_info_needs_only_a_read(self):
        info = {**INBOX, "open_request_count": 0}
        entries = [call("r1", "clued_session_resume"), result("r1", {"session_token": "t", "agent_inbox": info})]
        self.assertEqual(self.stop(entries).returncode, 2)
        self.assertEqual(self.stop(entries + [call("i1", "clued_agent_inbox"),
                                              result("i1", {"status": "ok"})]).returncode, 0)

    def test_off_switch_and_odd_transcripts(self):
        entries = [call("r1", "clued_session_resume"), result("r1", {"session_token": "t", "agent_inbox": INBOX})]
        self.env["CLUED_WORK_CLAIM_GUARD"] = "off"
        self.assertEqual(self.stop(entries).returncode, 0)
        self.env.pop("CLUED_WORK_CLAIM_GUARD")
        self.transcript.write_text("not json\n{\"type\": \"user\", \"message\": 5}\n", encoding="utf-8")
        out = self.run_hook({"hook_event_name": "Stop", "transcript_path": str(self.transcript)})
        self.assertEqual(out.returncode, 0, out.stderr)
        out = self.run_hook({"hook_event_name": "Stop", "transcript_path": str(Path(self.tmp.name) / "missing")})
        self.assertEqual(out.returncode, 0, out.stderr)

    def test_settings_run_it_on_stop_and_after_resume(self):
        settings = json.loads((ROOT / ".claude" / "settings.json").read_text(encoding="utf-8"))
        hooks = settings["hooks"]
        stop = [hook["command"] for group in hooks["Stop"] for hook in group["hooks"]]
        self.assertTrue(any(command.endswith('clued_work_claim_guard.py"') for command in stop))
        resume = [hook["command"] for group in hooks["PostToolUse"]
                  if group["matcher"] == "mcp__.*__clued_session_resume" for hook in group["hooks"]]
        self.assertTrue(any(command.endswith('clued_work_claim_guard.py"') for command in resume))


LAUNCHER = ROOT / "scripts" / "hooks" / "run_python.sh"
STUB = "#!/bin/sh\nexit 49\n"  # what the Windows Store python3 alias does


class HookLauncherTest(unittest.TestCase):
    """scripts/hooks/run_python.sh and the hook registrations that use it."""

    def setUp(self) -> None:
        self.sh = shutil.which("sh")
        if not self.sh:
            self.skipTest("sh is not available")
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.bin = Path(self.tmp.name) / "bin"
        self.bin.mkdir()
        self.script = Path(self.tmp.name) / "hook.py"
        self.script.write_text("import sys\nsys.stdout.write(sys.stdin.read().upper())\nsys.exit(3)\n",
                               encoding="utf-8")

    def fake(self, name: str, body: str) -> None:
        path = self.bin / name
        path.write_text(body, encoding="utf-8", newline="\n")
        path.chmod(0o755)

    def launch(self) -> subprocess.CompletedProcess:
        env = {k: v for k, v in os.environ.items() if k != "CLUED_HOOK_PYTHON"}
        env["PATH"] = str(self.bin) + os.pathsep + env.get("PATH", "")
        return subprocess.run([self.sh, str(LAUNCHER), str(self.script)], input="payload", text=True,
                              capture_output=True, env=env, timeout=60)

    def test_settings_run_every_hook_through_the_launcher(self):
        settings = json.loads((ROOT / ".claude" / "settings.json").read_text(encoding="utf-8"))
        prefix = 'sh "$CLAUDE_PROJECT_DIR/scripts/hooks/run_python.sh" "$CLAUDE_PROJECT_DIR/'
        commands = [hook["command"] for groups in settings["hooks"].values()
                    for group in groups for hook in group["hooks"]]
        self.assertEqual(len(commands), 8)
        for command in commands:
            with self.subTest(command=command):
                self.assertTrue(command.startswith(prefix), command)
                target = command[len(prefix):].rstrip('"')
                self.assertTrue((ROOT / target).is_file(), target)

    def test_stub_interpreters_are_skipped(self):
        for name in ("python3", "py"):
            self.fake(name, STUB)
        self.fake("python", f'#!/bin/sh\nexec "{Path(sys.executable).as_posix()}" "$@"\n')
        result = self.launch()
        self.assertEqual((result.returncode, result.stdout), (3, "PAYLOAD"), result.stderr)

    def test_no_working_interpreter_is_reported(self):
        for name in ("python3", "python", "py"):
            self.fake(name, STUB)
        result = self.launch()
        self.assertEqual(result.returncode, 1)
        self.assertIn("no working Python 3.8+ interpreter", result.stderr)
        self.assertIn("hook.py did not run", result.stderr)


class RuntimeBoundaryTest(unittest.TestCase):
    now = datetime(2026, 10, 17, 0, 0, tzinfo=timezone.utc)

    def payload(self, **changes):
        value = {**claim(), "holder_session_ref": "session_test",
                 "expires_at": (self.now + timedelta(minutes=5)).isoformat(),
                 "hard_deadline_at": (self.now + timedelta(hours=2)).isoformat(), **changes}
        return {"session_id": "session_test", "tool_name": "mcp__clued__clued_session_resume",
                "tool_response": {"status": "restored", "active_work_claims": [value]}}

    def test_own_near_lease_directs_agent_to_normal_renewal_without_owner_approval(self):
        text = GUARD.runtime_reminder(self.payload(), self.now)
        self.assertIn(CLAIM_ID, text)
        self.assertIn("clued_work_renew", text)
        self.assertIn("real fresh progress", text)
        self.assertIn("do not require an Owner", text)

    def test_agent_task_text_and_old_claim_metadata_do_not_create_deadlines(self):
        payload = self.payload(expires_at=(self.now + timedelta(hours=1)).isoformat())
        payload["tool_response"]["snapshot"] = {"task": {"original_deadline_not_reset": "2026-10-16T17:07:04.656847Z"}}
        payload["tool_input"] = {"owner_deadline": "2020-01-01T00:00:00Z"}
        self.assertIsNone(GUARD.runtime_reminder(payload, self.now))

    def test_other_holder_unknown_holder_draining_and_malformed_claims_get_no_renewal(self):
        for change in ({"holder_session_ref": "another-session"}, {"holder_session_ref": None},
                       {"status": "DRAINING"}, {"status": "RELEASED"}, {"expires_at": "unknown"},
                       {"claim_id": "free text masquerading as identity"}):
            with self.subTest(change=change):
                self.assertIsNone(GUARD.runtime_reminder(self.payload(**change), self.now))

    def test_real_chain_cap_wins_over_an_apparently_live_lease(self):
        text = GUARD.runtime_reminder(self.payload(hard_deadline_at=self.now.isoformat()), self.now)
        self.assertIn("Stop new protected spending", text)
        self.assertIn("Do not renew or reclaim", text)
        self.assertNotIn("clued_work_renew", text)
        self.assertIn("not an Owner-imposed", text)

    def test_expired_lease_stays_expired_and_requires_lawful_recovery(self):
        text = GUARD.runtime_reminder(self.payload(expires_at=self.now.isoformat()), self.now)
        self.assertIn("lease has expired", text)
        self.assertIn("Stop work protected", text)
        self.assertNotIn("clued_work_renew", text)

    def test_error_and_unrelated_tool_responses_cannot_look_like_fresh_claims(self):
        payload = self.payload()
        payload["tool_response"]["status"] = "refused"
        self.assertIsNone(GUARD.runtime_reminder(payload, self.now))
        payload = self.payload()
        payload["tool_name"] = "mcp__clued__clued_record_list"
        self.assertIsNone(GUARD.runtime_reminder(payload, self.now))

    def test_real_post_hook_combines_inbox_with_renewal_and_keeps_capability_private(self):
        with tempfile.TemporaryDirectory() as directory:
            value = {**claim(expires=timedelta(minutes=5)), "hard_deadline_at": stamp(timedelta(hours=2)),
                     "lease_key": "private-capability-must-not-appear"}
            payload = {"hook_event_name": "PostToolUse", "session_id": "session_test", "cwd": directory,
                       "tool_name": "mcp__clued__clued_work_renew", "tool_response": {
                           **committed(value), "agent_inbox": INBOX, "lease_key": "private-capability-must-not-appear"}}
            env = {**os.environ, "CLAUDE_PROJECT_DIR": directory}
            env.pop("CLUED_WORK_CLAIM_GUARD", None)
            result = subprocess.run([sys.executable, str(HOOK)], input=json.dumps(payload), text=True,
                                    capture_output=True, env=env, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            context = json.loads(result.stdout)["hookSpecificOutput"]["additionalContext"]
            self.assertIn("clued_agent_inbox", context)
            self.assertIn("clued_work_renew", context)
            self.assertNotIn("private-capability", result.stdout)
            saved = (Path(directory) / GUARD.CLAIM_FILE).read_text(encoding="utf-8")
            self.assertNotIn("private-capability", saved)

    def test_mcp_outer_error_cannot_turn_valid_looking_data_into_a_renewal_advice(self):
        payload = self.payload()
        body = payload["tool_response"]
        for wrapper in ({**body}, {"structuredContent": body},
                        {"content": [{"type": "text", "text": json.dumps(body)}]}):
            with self.subTest(wrapper=list(wrapper)):
                payload["tool_response"] = {**wrapper, "isError": True}
                self.assertIsNone(GUARD.runtime_reminder(payload, self.now))
                payload["tool_response"] = {**wrapper, "isError": False}
                self.assertIn("clued_work_renew", GUARD.runtime_reminder(payload, self.now))


if __name__ == "__main__":
    unittest.main()
