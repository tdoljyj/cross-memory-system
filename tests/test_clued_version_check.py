"""Tests for scripts/hooks/clued_version_check.py (Task 6dfd7560)."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HOOK = ROOT / "scripts" / "hooks" / "clued_version_check.py"
sys.path.insert(0, str(ROOT / "scripts"))
import clued_components as cc  # noqa: E402

MANIFEST = cc.load_manifest(ROOT)
LOCAL = {c["id"]: c["version"] for c in MANIFEST["components"]}


def bump(version: str) -> str:
    parts = version.split(".")
    parts[0] = str(int(parts[0]) + 1)
    return ".".join(parts)


class Service:
    """A local stand-in for /.well-known/clued-continuity."""

    def __init__(self, body: dict) -> None:
        payload = json.dumps(body).encode()

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                self.send_response(200 if self.path == "/.well-known/clued-continuity" else 404)
                self.send_header("content-type", "application/json")
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.origin = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


class HookTest(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="clued-version-home-"))
        self.addCleanup(shutil.rmtree, self.home, True)

    def run_hook(self, payload: dict, **env: str) -> dict | None:
        environment = {k: v for k, v in os.environ.items()
                       if k not in {"CLUED_VERSION_CHECK", "CLUED_ORIGIN", "CODEX_HOME", "CLAUDE_CONFIG_DIR"}}
        environment.update({"HOME": str(self.home), "USERPROFILE": str(self.home), "NO_PROXY": "127.0.0.1", "no_proxy": "127.0.0.1"}, **env)
        result = subprocess.run([sys.executable, str(HOOK)], input=json.dumps(payload), text=True,
                                capture_output=True, env=environment, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout) if result.stdout.strip() else None

    def context(self, payload: dict, **env: str) -> str:
        output = self.run_hook(payload, **env)
        self.assertIsNotNone(output)
        return output["hookSpecificOutput"]["additionalContext"]

    def install_skill(self, relative: str, version: str | None, complete: bool = True) -> Path:
        target = self.home / relative
        shutil.copytree(ROOT / "skills" / "clued", target)
        skill = target / "SKILL.md"
        text = skill.read_text(encoding="utf-8")
        if version is None:
            text = text.replace(f'metadata:\n  version: "{LOCAL["skill.clued"]}"\n', "")
        else:
            text = text.replace(f'version: "{LOCAL["skill.clued"]}"', f'version: "{version}"')
        skill.write_text(text, encoding="utf-8")
        if not complete:
            shutil.rmtree(target / "references")
        return target

    def serve(self, versions: dict) -> Service:
        service = Service({"components": {"schema": cc.SCHEMA, "versions": versions},
                           "lifecycle": {"contract": {"version": int(versions["agent-contract"])}}})
        self.addCleanup(service.close)
        return service

    # SessionStart

    def test_current_everything_reports_one_line(self):
        service = self.serve(LOCAL)
        self.install_skill(".claude/skills/clued", LOCAL["skill.clued"])
        text = self.context({"hook_event_name": "SessionStart"}, CLUED_ORIGIN=service.origin)
        self.assertTrue(text.startswith("BeamingFace components current"), text)
        self.assertIn("compared with the service", text)

    def test_unversioned_synced_copy_is_reported(self):
        path = self.install_skill(".claude/skills/synced/org_x/clued", None, complete=False)
        text = self.context({"hook_event_name": "SessionStart"}, CLUED_VERSION_CHECK="offline")
        self.assertIn(f"BeamingFace Skill at {path} has no version", text)
        self.assertIn("upload the whole skills/clued folder", text)

    def test_older_codex_copy_is_reported_against_the_service(self):
        newer = dict(LOCAL, **{"skill.clued": bump(LOCAL["skill.clued"])})
        service = self.serve(newer)
        path = self.install_skill("codex/skills/clued", LOCAL["skill.clued"])
        text = self.context({"hook_event_name": "SessionStart"}, CLUED_ORIGIN=service.origin,
                            CODEX_HOME=str(self.home / "codex"))
        self.assertIn(f"BeamingFace Skill at {path} is version {LOCAL['skill.clued']}, "
                      f"the latest is {newer['skill.clued']}", text)
        self.assertIn("This checkout is older than the BeamingFace service: skill.clued", text)

    def test_same_version_with_missing_files_is_reported(self):
        path = self.install_skill(".claude/skills/clued", LOCAL["skill.clued"], complete=False)
        text = self.context({"hook_event_name": "SessionStart"}, CLUED_VERSION_CHECK="offline")
        self.assertIn(f"BeamingFace Skill at {path} is version {LOCAL['skill.clued']} but its files differ", text)
        self.assertIn("missing: references/", text)

    def test_unreleased_contract_is_explained(self):
        older = dict(LOCAL, **{"agent-contract": str(int(LOCAL["agent-contract"]) - 1)})
        service = self.serve(older)
        text = self.context({"hook_event_name": "SessionStart"}, CLUED_ORIGIN=service.origin)
        self.assertIn("is newer than the one the service serves", text)

    def test_unreachable_service_degrades(self):
        text = self.context({"hook_event_name": "SessionStart"}, CLUED_ORIGIN="http://127.0.0.1:9")
        self.assertIn("service: could not read http://127.0.0.1:9", text)

    def test_off_prints_nothing(self):
        self.assertIsNone(self.run_hook({"hook_event_name": "SessionStart"}, CLUED_VERSION_CHECK="off"))

    # PostToolUse on clued_session_resume

    def resume(self, body: dict) -> dict:
        return {"hook_event_name": "PostToolUse", "tool_name": "mcp__Clued__clued_session_resume",
                "tool_response": [{"type": "text", "text": json.dumps(body)}]}

    def test_resume_with_same_versions_is_silent(self):
        body = {"status": "restored", "contract_version": int(LOCAL["agent-contract"]),
                "clued_components": {"versions": LOCAL}}
        self.assertIsNone(self.run_hook(self.resume(body)))

    def test_resume_with_newer_contract_tells_the_agent_to_follow_it(self):
        text = self.context(self.resume({"status": "restored",
                                         "contract_version": int(LOCAL["agent-contract"]) + 1}))
        self.assertIn("clued_agent_bootstrap (all parts) or /clued-agent.md", text)
        self.assertIn("needs no Skill reinstall", text)

    def test_bundled_contract_is_an_old_package_even_with_a_current_version(self):
        path = self.install_skill(".claude/skills/clued", LOCAL["skill.clued"])
        (path / "references" / "agent-contract.md").write_text("legacy\n", encoding="utf-8")
        text = self.context({"hook_event_name": "SessionStart"}, CLUED_VERSION_CHECK="offline")
        self.assertIn("carries a bundled agent contract", text)

    def test_contract_change_does_not_make_a_current_skill_stale(self):
        self.install_skill(".claude/skills/clued", LOCAL["skill.clued"])
        text = self.context(self.resume({"status": "restored",
                            "contract_version": int(LOCAL["agent-contract"]) + 1,
                            "clued_components": {"versions": dict(LOCAL, **{
                                "agent-contract": str(int(LOCAL["agent-contract"]) + 1)})}}))
        self.assertNotIn("Reinstall", text)
        self.assertNotIn("Skill at", text)

    def test_resume_with_newer_hook_versions_reports_the_checkout_stale(self):
        versions = dict(LOCAL, **{"hook.capture-guard": bump(LOCAL["hook.capture-guard"])})
        text = self.context(self.resume({"status": "restored", "clued_components": {"versions": versions}}))
        self.assertIn("This checkout is older than the service: hook.capture-guard", text)

    def test_resume_with_older_served_contract_still_requires_the_served_full_text(self):
        served_contract = str(int(LOCAL["agent-contract"]) - 1)
        text = self.context(self.resume({"status": "restored",
                            "contract_version": int(served_contract),
                            "clued_components": {"versions": dict(LOCAL, **{
                                "agent-contract": served_contract})}}))
        self.assertIn("clued_agent_bootstrap (all parts) or /clued-agent.md", text)
        self.assertIn(f"the service behaves per {served_contract}", text)
        self.assertIn("needs no Skill reinstall", text)

    def test_other_tools_are_ignored(self):
        payload = self.resume({"contract_version": 1})
        payload["tool_name"] = "mcp__Clued__clued_record_list"
        self.assertIsNone(self.run_hook(payload))


if __name__ == "__main__":
    unittest.main()
