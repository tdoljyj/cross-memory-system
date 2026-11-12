"""Tests for scripts/clued_components.py (Task 6dfd7560)."""
from __future__ import annotations

import copy
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import clued_components as cc  # noqa: E402


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


class Fixture:
    """A throwaway repository with one Skill-like and one marker-less component."""

    def __init__(self) -> None:
        self.dir = Path(tempfile.mkdtemp(prefix="clued-components-"))
        write(self.dir / "pkg" / "SKILL.md", '---\nname: x\nmetadata:\n  version: "1.0.0"\n---\nbody\n')
        write(self.dir / "pkg" / "references" / "a.md", "a\n")
        write(self.dir / "tool.py", "print(1)\n")
        write(self.dir / "service.js", "export const service = true;\n")
        manifest = {
            "schema": cc.SCHEMA,
            "components": [
                {"id": "pkg", "kind": "skill", "version": "1.0.0", "root": "pkg", "files": ["**/*"],
                 "content_sha256": None,
                 "version_marker": {"file": "SKILL.md", "pattern": '  version: "{version}"'}},
                {"id": "tool", "kind": "script", "version": "2", "root": ".", "files": ["tool.py"],
                 "content_sha256": None},
                {"id": "svc", "kind": "service", "version": "0.1.0", "root": ".", "files": ["service.js"]},
            ],
        }
        write(self.dir / cc.MANIFEST, json.dumps(manifest))
        cc.update(self.dir)

    def git(self, *args: str) -> None:
        # No signing and no hooks of the machine's global git configuration in a throwaway repository.
        subprocess.run(["git", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=", *args], cwd=self.dir,
                       check=True, capture_output=True)

    def close(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)


class RepositoryManifestTest(unittest.TestCase):
    def test_repository_manifest_matches_its_files(self):
        self.assertEqual(cc.check(ROOT), [])

    def test_every_marker_names_an_existing_file(self):
        for component in cc.load_manifest(ROOT)["components"]:
            marker = component.get("version_marker")
            if marker:
                self.assertTrue((ROOT / component["root"] / marker["file"]).is_file(), component["id"])

    def test_skill_and_contract_are_listed(self):
        ids = {c["id"] for c in cc.load_manifest(ROOT)["components"]}
        self.assertTrue({"skill.clued", "agent-contract", "mcp.server", "hook.version-check"} <= ids)

    def test_claude_code_plugin_copies_are_current(self):
        # The private Claude Code plugin ships copies of the Skill and the capture guard
        # (Task 67c97003); a change to either needs scripts/build_claude_code_plugin.py.
        run = subprocess.run([sys.executable, str(ROOT / "scripts" / "build_claude_code_plugin.py"), "--check"],
                             capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)


class VersionOrderTest(unittest.TestCase):
    def test_numeric_order(self):
        self.assertEqual(cc.compare_versions("1.10.0", "1.9.9"), 1)
        self.assertEqual(cc.compare_versions("28", "29"), -1)
        self.assertEqual(cc.compare_versions("1.0", "1.0.0"), 0)

    def test_rejects_non_numeric(self):
        with self.assertRaises(ValueError):
            cc.parse_version("1.0.0-beta")


class CheckTest(unittest.TestCase):
    def setUp(self):
        self.repo = Fixture()
        self.addCleanup(self.repo.close)

    def test_fresh_fixture_passes(self):
        self.assertEqual(cc.check(self.repo.dir), [])

    def test_changed_file_without_update_fails(self):
        write(self.repo.dir / "pkg" / "references" / "a.md", "changed\n")
        problems = cc.check(self.repo.dir)
        self.assertEqual(len(problems), 1)
        self.assertIn("pkg: files changed", problems[0])

    def test_crlf_checkout_hashes_like_lf(self):
        path = self.repo.dir / "pkg" / "references" / "a.md"
        path.write_bytes(path.read_bytes().replace(b"\r\n", b"\n").replace(b"\n", b"\r\n"))
        self.assertEqual(cc.check(self.repo.dir), [])

    def test_marker_must_match_manifest(self):
        write(self.repo.dir / "pkg" / "SKILL.md", '---\nname: x\nmetadata:\n  version: "1.0.1"\n---\nbody\n')
        cc.update(self.repo.dir)
        problems = cc.check(self.repo.dir)
        self.assertTrue(any("declares 1.0.1, the manifest 1.0.0" in p for p in problems), problems)

    def test_bump_rewrites_marker_and_update_records_digest(self):
        write(self.repo.dir / "pkg" / "references" / "a.md", "changed\n")
        cc.bump("pkg", "1.1.0", self.repo.dir)
        self.assertIn('  version: "1.1.0"', (self.repo.dir / "pkg" / "SKILL.md").read_text())
        cc.update(self.repo.dir)
        self.assertEqual(cc.check(self.repo.dir), [])

    def test_bump_keeps_the_blank_line_after_the_marker(self):
        skill = self.repo.dir / "pkg" / "SKILL.md"
        write(skill, '---\nname: x\nmetadata:\n  version: "1.0.0"\n\n---\nbody\n')
        cc.bump("pkg", "1.1.0", self.repo.dir)
        self.assertEqual(skill.read_text(), '---\nname: x\nmetadata:\n  version: "1.1.0"\n\n---\nbody\n')

    def test_bump_writes_a_marker_with_a_backslash_literally(self):
        data = json.loads((self.repo.dir / cc.MANIFEST).read_text())
        cc.by_id(data)["pkg"]["version_marker"]["pattern"] = r"  path: C:\x {version}"
        write(self.repo.dir / cc.MANIFEST, json.dumps(data))
        skill = self.repo.dir / "pkg" / "SKILL.md"
        write(skill, "  path: C:\\x 1.0.0\nbody\n")
        cc.bump("pkg", "1.1.0", self.repo.dir)
        self.assertEqual(skill.read_text(), "  path: C:\\x 1.1.0\nbody\n")

    def test_bump_and_update_write_lf_only(self):
        # On Windows write_text turns "\n" into CRLF; the R9 re-registration helper refuses such files.
        root = self.repo.dir
        skill = root / "pkg" / "SKILL.md"
        skill.write_bytes(b'---\r\nname: x\r\nmetadata:\r\n  version: "1.0.0"\r\n---\r\nbody\r\n')
        (root / "tool.py").write_text("print(2)\n")
        cc.bump("pkg", "1.1.0", root)
        cc.update(root)
        for path in (skill, root / cc.MANIFEST):
            self.assertNotIn(b"\r", path.read_bytes(), path.name)
        self.assertEqual(cc.check(root), [])

    def test_bump_and_update_write_lf_where_text_mode_translates(self):
        # The same check on every platform: make a text-mode write translate "\n" to CRLF, as Windows does.
        real_open = io.open

        def windows_open(file, mode="r", buffering=-1, encoding=None, errors=None, newline=None, *args, **kwargs):
            if "w" in mode and "b" not in mode and newline is None:
                newline = "\r\n"
            return real_open(file, mode, buffering, encoding, errors, newline, *args, **kwargs)

        write(self.repo.dir / "pkg" / "references" / "a.md", "changed\n")
        with mock.patch("io.open", windows_open), mock.patch("builtins.open", windows_open):
            cc.bump("pkg", "1.1.0", self.repo.dir)
            cc.update(self.repo.dir)
        for path in (self.repo.dir / "pkg" / "SKILL.md", self.repo.dir / cc.MANIFEST):
            self.assertNotIn(b"\r", path.read_bytes(), path.name)

    def test_bump_refuses_lower_or_equal(self):
        with self.assertRaises(SystemExit):
            cc.bump("pkg", "1.0.0", self.repo.dir)

    def test_change_against_base_needs_a_higher_version(self):
        self.repo.git("init", "-q")
        self.repo.git("-c", "user.email=t@t", "-c", "user.name=t", "add", "-A")
        self.repo.git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base")
        write(self.repo.dir / "tool.py", "print(2)\n")
        cc.update(self.repo.dir)  # digest re-recorded, version not bumped
        problems = cc.check(self.repo.dir, base_ref="HEAD")
        self.assertEqual(problems, ["tool: files changed but the version is still 2; bump it "
                                    "(clued_components.py bump tool <version>)"])
        cc.bump("tool", "3", self.repo.dir)
        self.assertEqual(cc.check(self.repo.dir, base_ref="HEAD"), [])

    def test_against_base_flags_downgrade_and_removal(self):
        data = cc.load_manifest(self.repo.dir)
        base = copy.deepcopy(data)
        base["components"][2]["version"] = "0.2.0"
        base["components"].append({"id": "gone", "kind": "script", "version": "1"})
        problems = cc.against_base(data, base)
        self.assertIn("svc: version went down from 0.2.0 to 0.1.0", problems)
        self.assertIn("gone: removed from the manifest", problems)

    def test_generated_module_must_match(self):
        write(self.repo.dir / cc.GENERATED,
              'export const CLUED_COMPONENT_VERSIONS: Readonly<Record<string, string>> = {"pkg": "1.0.0"};\n')
        problems = cc.check(self.repo.dir)
        self.assertTrue(any("does not match the manifest" in p for p in problems), problems)
        versions = {"pkg": "1.0.0", "tool": "2", "svc": "0.1.0"}
        write(self.repo.dir / cc.GENERATED,
              f"export const CLUED_COMPONENT_VERSIONS: Readonly<Record<string, string>> = {json.dumps(versions)};\n")
        self.assertEqual(cc.check(self.repo.dir), [])


class BaseRefTest(unittest.TestCase):
    """Task 18af3b76: a --base that cannot be used is an error, never a silent pass."""

    def setUp(self):
        self.repo = Fixture()
        self.addCleanup(self.repo.close)
        self.repo.git("init", "-q")
        self.repo.git("-c", "user.email=t@t", "-c", "user.name=t", "add", "-A")
        self.repo.git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base")
        # The tool run as the CI step runs it: from scripts/ of the checkout it checks.
        (self.repo.dir / "scripts").mkdir()
        shutil.copy(ROOT / "scripts" / "clued_components.py", self.repo.dir / "scripts" / "clued_components.py")

    def cli(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, "-I", str(self.repo.dir / "scripts" / "clued_components.py"), *args],
                              cwd=self.repo.dir, capture_output=True, text=True)

    def test_a_missing_ref_is_a_problem(self):
        problems = cc.check(self.repo.dir, base_ref="origin/does-not-exist")
        self.assertEqual(len(problems), 1, problems)
        self.assertIn("'origin/does-not-exist' does not resolve to a commit", problems[0])

    def test_the_cli_exits_non_zero_with_a_message_for_a_missing_ref(self):
        run = self.cli("check", "--base", "origin/does-not-exist")
        self.assertEqual(run.returncode, 1, run.stdout + run.stderr)
        self.assertIn("does not resolve to a commit", run.stderr)
        self.assertNotIn("every component matches", run.stdout)

    def test_an_empty_ref_is_not_the_same_as_no_base(self):
        # CI passes $BASE; an unset variable arrives as "".
        self.assertEqual(self.cli("check").returncode, 0)
        run = self.cli("check", "--base", "")
        self.assertEqual(run.returncode, 1, run.stdout + run.stderr)
        self.assertIn("base ref is empty", run.stderr)

    def test_the_all_zero_sha_of_a_new_branch_push_is_refused(self):
        run = self.cli("check", "--base", "0" * 40)
        self.assertEqual(run.returncode, 1, run.stdout + run.stderr)
        self.assertIn("does not resolve to a commit", run.stderr)

    def test_an_option_is_not_taken_for_a_ref(self):
        run = self.cli("check", "--base=--help")
        self.assertEqual(run.returncode, 1, run.stdout + run.stderr)
        self.assertIn("looks like an option", run.stderr)

    def test_a_ref_that_names_a_blob_is_not_a_commit(self):
        blob = subprocess.run(["git", "rev-parse", "HEAD:tool.py"], cwd=self.repo.dir, capture_output=True,
                              text=True, check=True).stdout.strip()
        self.assertEqual(self.cli("check", "--base", blob).returncode, 1)

    def test_a_good_ref_still_passes_through_the_cli(self):
        run = self.cli("check", "--base", "HEAD")
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)

    def test_a_commit_that_predates_the_manifest_has_nothing_to_compare(self):
        git = ["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath="]
        subprocess.run([*git, "checkout", "-q", "--orphan", "bare"], cwd=self.repo.dir, check=True, capture_output=True)
        subprocess.run([*git, "rm", "-rqf", "."], cwd=self.repo.dir, check=True, capture_output=True)
        write(self.repo.dir / "README", "no manifest here\n")
        subprocess.run([*git, "add", "README"], cwd=self.repo.dir, check=True, capture_output=True)
        subprocess.run([*git, "commit", "-qm", "before the manifest"], cwd=self.repo.dir, check=True, capture_output=True)
        base = subprocess.run(["git", "rev-parse", "HEAD"], cwd=self.repo.dir, capture_output=True, text=True,
                              check=True).stdout.strip()
        subprocess.run([*git, "checkout", "-q", "master" if self._has("master") else "main"], cwd=self.repo.dir,
                       check=True, capture_output=True)
        self.assertEqual(cc.check(self.repo.dir, base_ref=base), [])

    def commit_manifest(self, text: str) -> str:
        git = ["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath="]
        good = (self.repo.dir / cc.MANIFEST).read_text(encoding="utf-8")
        write(self.repo.dir / cc.MANIFEST, text)
        subprocess.run([*git, "commit", "-qam", "odd manifest"], cwd=self.repo.dir, check=True, capture_output=True)
        base = subprocess.run(["git", "rev-parse", "HEAD"], cwd=self.repo.dir, capture_output=True, text=True,
                              check=True).stdout.strip()
        write(self.repo.dir / cc.MANIFEST, good)
        return base

    def test_a_base_manifest_of_the_wrong_shape_is_an_error_not_a_pass(self):
        for text in ("null", "{}", "[]", '"x"', '{"components": null}', '{"components": [1]}',
                     '{"components": [{"id": "a"}]}'):
            with self.subTest(text=text):
                problems = cc.check(self.repo.dir, base_ref=self.commit_manifest(text))
                self.assertEqual(len(problems), 1, problems)
                self.assertIn("is not a component manifest", problems[0])

    def test_a_commit_without_the_manifest_says_nothing_was_compared(self):
        git = ["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath="]
        subprocess.run([*git, "rm", "-q", str(cc.MANIFEST)], cwd=self.repo.dir, check=True, capture_output=True)
        subprocess.run([*git, "commit", "-qm", "no manifest"], cwd=self.repo.dir, check=True, capture_output=True)
        base = subprocess.run(["git", "rev-parse", "HEAD"], cwd=self.repo.dir, capture_output=True, text=True,
                              check=True).stdout.strip()
        subprocess.run([*git, "reset", "-q", "--hard", "HEAD~1"], cwd=self.repo.dir, check=True, capture_output=True)
        run = self.cli("check", "--base", base)
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn("holds no config/clued-components.json; nothing was compared", run.stderr)

    def test_the_message_carries_gits_own_complaint(self):
        # GIT_DIR names no repository, wherever the system temp directory happens to be.
        with mock.patch.dict(os.environ, {"GIT_DIR": str(self.repo.dir / "no-such-git-dir")}):
            with self.assertRaises(cc.BaseRefError) as caught:
                cc.resolve_base("HEAD", self.repo.dir)
        self.assertIn("(git: ", str(caught.exception))

    def test_a_failing_tree_listing_is_an_error_not_an_absent_manifest(self):
        real = subprocess.run

        def fake(argv, *args, **kwargs):
            if argv[:2] == ["git", "ls-tree"]:
                return subprocess.CompletedProcess(argv, 128, "", "fatal: bad tree object")
            return real(argv, *args, **kwargs)

        with mock.patch.object(cc.subprocess, "run", fake):
            problems = cc.check(self.repo.dir, base_ref="HEAD")
        self.assertEqual(len(problems), 1, problems)
        self.assertIn("cannot read the tree of base ref 'HEAD' (git: fatal: bad tree object)", problems[0])

    def _has(self, branch: str) -> bool:
        return subprocess.run(["git", "rev-parse", "--verify", "-q", branch], cwd=self.repo.dir,
                              capture_output=True).returncode == 0

    def test_a_base_manifest_that_is_not_json_is_an_error(self):
        git = ["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath="]
        good = (self.repo.dir / cc.MANIFEST).read_text(encoding="utf-8")
        write(self.repo.dir / cc.MANIFEST, "{not json")
        subprocess.run([*git, "commit", "-qam", "broken manifest"], cwd=self.repo.dir, check=True, capture_output=True)
        base = subprocess.run(["git", "rev-parse", "HEAD"], cwd=self.repo.dir, capture_output=True, text=True,
                              check=True).stdout.strip()
        write(self.repo.dir / cc.MANIFEST, good)
        problems = cc.check(self.repo.dir, base_ref=base)
        self.assertTrue(any("is not valid JSON" in p for p in problems), problems)


class AutomaticIntegrationTest(unittest.TestCase):
    def setUp(self):
        self.repo = Fixture()
        self.addCleanup(self.repo.close)
        self.repo.git("init", "-q")
        self.commit("base")
        self.base = self.head()

    def head(self):
        return subprocess.run(["git", "rev-parse", "HEAD"], cwd=self.repo.dir,
                              capture_output=True, text=True, check=True).stdout.strip()

    def commit(self, message):
        self.repo.git("add", "-A")
        self.repo.git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", message)

    def test_unbumped_source_change_is_planned_and_applied_once(self):
        write(self.repo.dir / "tool.py", "print(2)\n")
        self.commit("source without metadata")
        plan = cc.integration_plan(self.base, self.repo.dir)
        self.assertEqual({x["id"]: x["target_version"] for x in plan["changes"]}, {"tool": "3"})
        self.assertEqual(cc.by_id(cc.load_manifest(self.repo.dir))["tool"]["version"], "2")
        cc.apply_integration(plan, self.repo.dir)
        self.assertEqual(cc.check(self.repo.dir, self.base), [])
        first = (self.repo.dir / cc.MANIFEST).read_bytes()
        cc.apply_integration(cc.integration_plan(self.base, self.repo.dir), self.repo.dir)
        self.assertEqual((self.repo.dir / cc.MANIFEST).read_bytes(), first)

    def test_two_sources_auto_bump_only_their_own_components(self):
        write(self.repo.dir / "tool.py", "print(2)\n")
        write(self.repo.dir / "pkg/references/a.md", "changed\n")
        self.commit("two independent changes")
        cc.apply_integration(cc.integration_plan(self.base, self.repo.dir), self.repo.dir)
        versions = {x["id"]: x["version"] for x in cc.load_manifest(self.repo.dir)["components"]}
        self.assertEqual(versions, {"pkg": "1.0.1", "tool": "3", "svc": "0.1.0"})
        self.assertEqual(cc.check(self.repo.dir, self.base), [])

    def test_marker_only_change_does_not_bump_overlapping_component(self):
        data = cc.load_manifest(self.repo.dir)
        data["components"].append({"id": "outer", "kind": "script", "version": "4.0.0",
                                   "root": ".", "files": ["pkg/**/*"]})
        cc.save_manifest(data, self.repo.dir)
        cc.update(self.repo.dir)
        self.commit("outer baseline")
        baseline = self.head()
        cc.bump("pkg", "2.0.0", self.repo.dir)
        self.commit("explicit semantic release")
        plan = cc.integration_plan(baseline, self.repo.dir)
        cc.apply_integration(plan, self.repo.dir)
        current = cc.by_id(cc.load_manifest(self.repo.dir))
        self.assertEqual(current["pkg"]["version"], "2.0.0")
        self.assertEqual(current["outer"]["version"], "4.0.0")

    def test_mechanical_only_change_does_not_raise_source_version(self):
        policy = {"schema": 1, "repository": "tdoljyj/cross-memory-system",
                  "context_keys": ["project:0597aa60-9b98-4da6-a4ab-63d7705b632f"],
                  "mechanical_paths": ["config/clued-components.json",
                  "apps/clued-cloud/worker/generated/**", "scripts/ci/clued-merge-reconcile.mjs",
                  "scripts/ci/clued-merge-reconcile-source.json", "scripts/ci/clued-independent-publication-port.mjs"]}
        write(self.repo.dir / "config/clued-mechanical-files.json", json.dumps(policy))
        write(self.repo.dir / "apps/clued-cloud/worker/generated/example.ts", "old\n")
        data = cc.load_manifest(self.repo.dir)
        cc.by_id(data)["tool"]["files"].append("apps/clued-cloud/worker/generated/**")
        cc.save_manifest(data, self.repo.dir)
        cc.update(self.repo.dir)
        self.commit("mechanical baseline")
        baseline = self.head()
        write(self.repo.dir / "apps/clued-cloud/worker/generated/example.ts", "new\n")
        self.commit("generated only")
        self.assertEqual(cc.integration_plan(baseline, self.repo.dir)["changes"], [])
        cc.apply_integration(cc.integration_plan(baseline, self.repo.dir), self.repo.dir)
        self.assertEqual(cc.check(self.repo.dir, baseline), [])

    def test_service_auto_bump_uses_explicit_coverage_not_a_name_heuristic(self):
        data = cc.load_manifest(self.repo.dir)
        cc.by_id(data)["svc"].update({"root": ".", "files": ["tool.py"]})
        cc.save_manifest(data, self.repo.dir)
        cc.update(self.repo.dir)
        self.commit("explicit service coverage")
        baseline = self.head()
        write(self.repo.dir / "tool.py", "print(2)\n")
        self.commit("backend change")
        plan = cc.integration_plan(baseline, self.repo.dir)
        self.assertEqual({row["id"]: row["target_version"] for row in plan["changes"]},
                         {"tool": "3", "svc": "0.1.1"})

    def test_component_retires_only_together_with_all_its_files(self):
        data = cc.load_manifest(self.repo.dir)
        data["components"] = [c for c in data["components"] if c["id"] != "tool"]
        cc.save_manifest(data, self.repo.dir)
        with self.assertRaisesRegex(ValueError, "tool: a component is removed only together with all its files"):
            cc.integration_plan(self.base, self.repo.dir)
        (self.repo.dir / "tool.py").unlink()
        self.commit("retire tool with its files")
        self.assertNotIn("tool", {x["id"] for x in cc.integration_plan(self.base, self.repo.dir)["changes"]})
        self.assertEqual(cc.check(self.repo.dir, self.base), [])
        data["components"].append(dict(data["components"][0]))
        cc.save_manifest(data, self.repo.dir)
        with self.assertRaisesRegex(ValueError, "refuses duplicate components"):
            cc.integration_plan(self.base, self.repo.dir)

    def test_service_without_explicit_source_coverage_is_not_silently_skipped(self):
        data = cc.load_manifest(self.repo.dir)
        service = cc.by_id(data)["svc"]
        service.pop("root")
        service.pop("files")
        cc.save_manifest(data, self.repo.dir)
        with self.assertRaisesRegex(ValueError, "svc: service has no explicit source coverage"):
            cc.integration_plan(self.base, self.repo.dir)

    def test_mechanical_version_marker_does_not_hide_executable_body_change(self):
        policy = {"schema": 1, "repository": "tdoljyj/cross-memory-system",
                  "context_keys": ["project:0597aa60-9b98-4da6-a4ab-63d7705b632f"],
                  "mechanical_paths": ["scripts/ci/clued-merge-reconcile.mjs"]}
        write(self.repo.dir / "config/clued-mechanical-files.json", json.dumps(policy))
        source = "scripts/ci/clued-merge-reconcile.mjs"
        write(self.repo.dir / source, "export const COMPONENT_VERSION='2';\nexport const decision = false;\n")
        data = cc.load_manifest(self.repo.dir)
        cc.by_id(data)["tool"].update({"files": [source], "version_marker": {
            "file": source, "pattern": "export const COMPONENT_VERSION='{version}';"}})
        cc.save_manifest(data, self.repo.dir)
        cc.update(self.repo.dir)
        self.commit("mechanical marker baseline")
        baseline = self.head()
        write(self.repo.dir / source, "export const COMPONENT_VERSION='2';\nexport const decision = true;\n")
        self.commit("executable body change")
        self.assertEqual(cc.integration_plan(baseline, self.repo.dir)["changes"][0]["target_version"], "3")

    def test_deleted_source_and_new_coverage_are_changes(self):
        (self.repo.dir / "pkg/references/a.md").unlink()
        self.commit("remove source")
        self.assertEqual(cc.integration_plan(self.base, self.repo.dir)["changes"][0]["id"], "pkg")

    def test_rename_out_of_component_keeps_the_deleted_source_change(self):
        self.repo.git("mv", "pkg/references/a.md", "outside.md")
        self.commit("move outside component")
        self.assertEqual(cc.integration_plan(self.base, self.repo.dir)["changes"][0]["id"], "pkg")

    def test_rejects_version_rollback_and_stale_expected_head(self):
        data = cc.load_manifest(self.repo.dir)
        cc.by_id(data)["tool"]["version"] = "1"
        cc.save_manifest(data, self.repo.dir)
        with self.assertRaisesRegex(ValueError, "version went down"):
            cc.integration_plan(self.base, self.repo.dir)
        with self.assertRaisesRegex(ValueError, "head changed"):
            cc.integration_plan(self.base, self.repo.dir, expected_head="0" * 40)

    def test_apply_refuses_source_changed_after_plan(self):
        write(self.repo.dir / "tool.py", "print(2)\n")
        plan = cc.integration_plan(self.base, self.repo.dir)
        write(self.repo.dir / "tool.py", "print(3)\n")
        with self.assertRaisesRegex(ValueError, "changed since integration plan"):
            cc.apply_integration(plan, self.repo.dir)

    def test_marker_path_cannot_escape_checkout(self):
        data = cc.load_manifest(self.repo.dir)
        cc.by_id(data)["pkg"]["root"] = ".."
        cc.save_manifest(data, self.repo.dir)
        with self.assertRaisesRegex(ValueError, "unsafe component path"):
            cc.integration_plan(self.base, self.repo.dir)


if __name__ == "__main__":
    unittest.main()
