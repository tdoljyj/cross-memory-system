"""Tests for scripts/clued_components.py (Task 6dfd7560)."""
from __future__ import annotations

import copy
import importlib.util
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
                 "version_marker": {"file": "SKILL.md", "pattern": '  version: "{version}"'}},
                {"id": "tool", "kind": "script", "version": "2", "root": ".", "files": ["tool.py"]},
                {"id": "svc", "kind": "service", "version": "0.1.0", "root": ".", "files": ["service.js"]},
            ],
        }
        write(self.dir / cc.MANIFEST, json.dumps(manifest))

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

    def test_changed_file_needs_nothing_recorded(self):
        write(self.repo.dir / "pkg" / "references" / "a.md", "changed\n")
        self.assertEqual(cc.check(self.repo.dir), [])

    def test_a_stored_digest_is_refused(self):
        # A digest kept in the manifest changes with every pull request's content and makes queued PRs conflict.
        data = cc.load_manifest(self.repo.dir)
        cc.by_id(data)["tool"]["content_sha256"] = cc.content_digest(self.repo.dir, ["tool.py"])
        cc.save_manifest(data, self.repo.dir)
        problems = cc.check(self.repo.dir)
        self.assertEqual(len(problems), 1, problems)
        self.assertIn("tool: stores content_sha256", problems[0])

    def test_versions_reports_the_computed_digest(self):
        status = cc.component_status(cc.by_id(cc.load_manifest(self.repo.dir))["tool"], self.repo.dir)
        self.assertEqual(status["content_sha256"], cc.content_digest(self.repo.dir, ["tool.py"]))
        self.assertEqual(status["problems"], [])

    def test_crlf_checkout_hashes_like_lf(self):
        before = cc.content_digest(self.repo.dir / "pkg", ["**/*"])
        path = self.repo.dir / "pkg" / "references" / "a.md"
        path.write_bytes(path.read_bytes().replace(b"\r\n", b"\n").replace(b"\n", b"\r\n"))
        self.assertEqual(cc.content_digest(self.repo.dir / "pkg", ["**/*"]), before)

    def test_marker_must_match_manifest(self):
        write(self.repo.dir / "pkg" / "SKILL.md", '---\nname: x\nmetadata:\n  version: "1.0.1"\n---\nbody\n')
        problems = cc.check(self.repo.dir)
        self.assertTrue(any("declares 1.0.1, the manifest 1.0.0" in p for p in problems), problems)

    def test_bump_rewrites_marker(self):
        write(self.repo.dir / "pkg" / "references" / "a.md", "changed\n")
        cc.bump("pkg", "1.1.0", self.repo.dir)
        self.assertIn('  version: "1.1.0"', (self.repo.dir / "pkg" / "SKILL.md").read_text())
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

    def test_bump_writes_lf_only(self):
        # On Windows write_text turns "\n" into CRLF; the R9 re-registration helper refuses such files.
        root = self.repo.dir
        skill = root / "pkg" / "SKILL.md"
        skill.write_bytes(b'---\r\nname: x\r\nmetadata:\r\n  version: "1.0.0"\r\n---\r\nbody\r\n')
        (root / "tool.py").write_text("print(2)\n")
        cc.bump("pkg", "1.1.0", root)
        for path in (skill, root / cc.MANIFEST):
            self.assertNotIn(b"\r", path.read_bytes(), path.name)
        self.assertEqual(cc.check(root), [])

    def test_bump_writes_lf_where_text_mode_translates(self):
        # The same check on every platform: make a text-mode write translate "\n" to CRLF, as Windows does.
        real_open = io.open

        def windows_open(file, mode="r", buffering=-1, encoding=None, errors=None, newline=None, *args, **kwargs):
            if "w" in mode and "b" not in mode and newline is None:
                newline = "\r\n"
            return real_open(file, mode, buffering, encoding, errors, newline, *args, **kwargs)

        write(self.repo.dir / "pkg" / "references" / "a.md", "changed\n")
        with mock.patch("io.open", windows_open), mock.patch("builtins.open", windows_open):
            cc.bump("pkg", "1.1.0", self.repo.dir)
        for path in (self.repo.dir / "pkg" / "SKILL.md", self.repo.dir / cc.MANIFEST):
            self.assertNotIn(b"\r", path.read_bytes(), path.name)

    def test_bump_refuses_lower_or_equal(self):
        with self.assertRaises(SystemExit):
            cc.bump("pkg", "1.0.0", self.repo.dir)

    def test_change_against_base_needs_no_version_bump(self):
        # A version is a label raised on purpose; a per-PR bump made every queued PR re-bump after each merge.
        self.repo.git("init", "-q")
        self.repo.git("-c", "user.email=t@t", "-c", "user.name=t", "add", "-A")
        self.repo.git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base")
        write(self.repo.dir / "tool.py", "print(2)\n")
        self.assertEqual(cc.check(self.repo.dir, base_ref="HEAD"), [])
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


class QueuedPullRequestTest(unittest.TestCase):
    """Defect C (2026-11-15): when one queued PR merges, the next one only has to take main in.

    Both PRs change one component and separate scripts/ci files. Their fixed
    workflow registration remains valid when the second PR takes main in.
    """

    REGISTRY = "scripts/ci/clued-merge-reconcile-source.json"
    GENERATOR = r"""import fs from 'node:fs';
import {createHash} from 'node:crypto';
const OUT='scripts/ci/clued-merge-reconcile-source.json';
const sha256=createHash('sha256').update(fs.readFileSync('workflow.yml')).digest('hex');
const text=JSON.stringify({schema:'fixture',workflow:{path:'workflow.yml',sha256}},null,2)+'\n';
if(process.argv[2]==='--check')process.exit(fs.existsSync(OUT)&&fs.readFileSync(OUT,'utf8')===text?0:1);
fs.writeFileSync(OUT,text);
"""
    CHECK = r"""import {spawnSync} from 'node:child_process';
process.exit(spawnSync(process.execPath,['scripts/ci/clued-merge-reconcile-source-build.mjs','--check'],{stdio:'inherit'}).status);
"""

    def setUp(self):
        spec = importlib.util.spec_from_file_location(
            "component_version_integration", ROOT / "scripts/ci/component-version-integration.py")
        self.builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.builder)
        self.repo = Fixture()
        self.addCleanup(self.repo.close)
        self.repo.git("init", "-q", "-b", "main")
        write(self.repo.dir / "workflow.yml", "name: fixture\n")
        write(self.repo.dir / "scripts/ci/clued-merge-reconcile-source-build.mjs", self.GENERATOR)
        write(self.repo.dir / "scripts/ci/check-pinned-registries.mjs", self.CHECK)
        write(self.repo.dir / "scripts/ci/a.mjs", "export const a = 1;\n")
        write(self.repo.dir / "scripts/ci/b.mjs", "export const b = 1;\n")
        policy = json.loads((ROOT / "config/clued-mechanical-files.json").read_text(encoding="utf-8"))
        write(self.repo.dir / "config/clued-mechanical-files.json", json.dumps(dict(
            policy, mechanical_paths=[self.REGISTRY], marker_paths=["config/clued-components.json", "pkg/SKILL.md"])))
        done = subprocess.run(["node", "scripts/ci/clued-merge-reconcile-source-build.mjs"], cwd=self.repo.dir,
                              capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.commit("main")
        self.main = self.head()

    def git(self, *args):
        return subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false",
                               "-c", "core.hooksPath=", *args], cwd=self.repo.dir, capture_output=True, text=True)

    def head(self):
        return self.git("rev-parse", "HEAD").stdout.strip()

    def commit(self, message):
        self.git("add", "-A")
        done = self.git("commit", "-qm", message)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)

    def pull_request(self, branch, changes):
        """A PR as it reaches the queue today: the author's change, then the builder's outputs."""
        self.git("checkout", "-q", "-b", branch, self.main)
        for path, text in changes.items():
            write(self.repo.dir / path, text)
        self.commit(f"{branch}: source change")
        self.builder.integrate_candidate(self.repo.dir, self.main, self.head(), write=True)
        if self.git("status", "--porcelain").stdout.strip():
            self.commit(f"{branch}: builder outputs")
        return self.head()

    def test_next_queued_pr_needs_only_a_plain_merge_of_main(self):
        first = self.pull_request("first", {"pkg/references/a.md": "first\n", "scripts/ci/a.mjs": "export const a = 2;\n"})
        self.pull_request("second", {"pkg/references/b.md": "second\n", "scripts/ci/b.mjs": "export const b = 2;\n"})
        self.git("branch", "-f", "main", first)  # the first PR merges (strict: it contained main)
        merged = self.git("merge", "--no-edit", "main")
        self.assertEqual(merged.returncode, 0, "taking main in conflicts:\n" + merged.stdout + merged.stderr)
        self.assertEqual(cc.check(self.repo.dir, base_ref=first), [])
        report = self.builder.integrate_candidate(self.repo.dir, first, self.head(), write=True)
        self.assertEqual(report["output_sha256"], {}, "the builder still has to regenerate after taking main in")


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

    def test_plan_sets_no_version(self):
        write(self.repo.dir / "tool.py", "print(2)\n")
        write(self.repo.dir / "pkg/references/a.md", "changed\n")
        self.commit("two source changes, no version edited")
        plan = cc.integration_plan(self.base, self.repo.dir)
        self.assertEqual({row["id"]: row["version"] for row in plan["components"]},
                         {"pkg": "1.0.0", "tool": "2", "svc": "0.1.0"})
        self.assertNotIn("changes", plan)
        self.assertEqual(cc.check(self.repo.dir, self.base), [])

    def test_component_retires_only_together_with_all_its_files(self):
        data = cc.load_manifest(self.repo.dir)
        data["components"] = [c for c in data["components"] if c["id"] != "tool"]
        cc.save_manifest(data, self.repo.dir)
        with self.assertRaisesRegex(ValueError, "tool: a component is removed only together with all its files"):
            cc.integration_plan(self.base, self.repo.dir)
        (self.repo.dir / "tool.py").unlink()
        self.commit("retire tool with its files")
        self.assertNotIn("tool", {x["id"] for x in cc.integration_plan(self.base, self.repo.dir)["components"]})
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

    def test_rejects_version_rollback_and_stale_expected_head(self):
        data = cc.load_manifest(self.repo.dir)
        cc.by_id(data)["tool"]["version"] = "1"
        cc.save_manifest(data, self.repo.dir)
        with self.assertRaisesRegex(ValueError, "version went down"):
            cc.integration_plan(self.base, self.repo.dir)
        with self.assertRaisesRegex(ValueError, "head changed"):
            cc.integration_plan(self.base, self.repo.dir, expected_head="0" * 40)

    def test_input_state_follows_component_bytes(self):
        first = cc.integration_plan(self.base, self.repo.dir)["input_state_sha256"]
        write(self.repo.dir / "tool.py", "print(2)\n")
        self.assertNotEqual(cc.integration_plan(self.base, self.repo.dir)["input_state_sha256"], first)

    def test_marker_path_cannot_escape_checkout(self):
        data = cc.load_manifest(self.repo.dir)
        cc.by_id(data)["pkg"]["root"] = ".."
        cc.save_manifest(data, self.repo.dir)
        with self.assertRaisesRegex(ValueError, "unsafe component path"):
            cc.integration_plan(self.base, self.repo.dir)


if __name__ == "__main__":
    unittest.main()
