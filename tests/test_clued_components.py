"""Tests for scripts/clued_components.py (Task 6dfd7560)."""
from __future__ import annotations

import copy
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
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
        manifest = {
            "schema": cc.SCHEMA,
            "components": [
                {"id": "pkg", "kind": "skill", "version": "1.0.0", "root": "pkg", "files": ["**/*"],
                 "content_sha256": None,
                 "version_marker": {"file": "SKILL.md", "pattern": '  version: "{version}"'}},
                {"id": "tool", "kind": "script", "version": "2", "root": ".", "files": ["tool.py"],
                 "content_sha256": None},
                {"id": "svc", "kind": "service", "version": "0.1.0"},
            ],
        }
        write(self.dir / cc.MANIFEST, json.dumps(manifest))
        cc.update(self.dir)

    def git(self, *args: str) -> None:
        subprocess.run(["git", *args], cwd=self.dir, check=True, capture_output=True)

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
        path.write_bytes(path.read_bytes().replace(b"\n", b"\r\n"))
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


if __name__ == "__main__":
    unittest.main()
