"""Offline bundle boundary tests; every output and source fixture is disposable."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile


spec = importlib.util.spec_from_file_location("kooyumi_bundle", Path(__file__).with_name("build_bundle.py"))
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="kooyumi-bundle-test-")
        self.directory = Path(self.temporary.name)
        self.assertTrue(self.directory.resolve().is_relative_to(Path(tempfile.gettempdir()).resolve()))
        self.addCleanup(self.temporary.cleanup)
        self.repository = self.directory / "repo"
        self.plugin = self.repository / "plugins/kooyumi"
        self.skill = self.repository / "skills/clued"
        self.plugin.mkdir(parents=True)
        shutil.copytree(bundle.REPOSITORY_ROOT / "skills/clued", self.skill)
        for name in bundle.METADATA_FILES:
            target = self.plugin / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(bundle.REPOSITORY_ROOT / "plugins/kooyumi" / name, target)
        self.root_patch = patch.object(bundle, "REPOSITORY_ROOT", self.repository)
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)
        # The release gate reads git history (ReleaseGateTests); these fixtures are not repositories.
        self.release_patch = patch.object(bundle, "released_skill", lambda: None)
        self.release_patch.start()
        self.addCleanup(self.release_patch.stop)

    def write_json(self, name, value):
        (self.plugin / name).write_text(json.dumps(value), encoding="utf-8")

    def test_deterministic_exact_inventory_and_canonical_skill_bytes(self):
        first, second = self.directory / "one.zip", self.directory / "two.zip"
        result = bundle.build_archive(first)
        for path in self.skill.rglob("*"):
            if path.is_file():
                path.touch()
        bundle.build_archive(second)
        self.assertEqual(first.read_bytes(), second.read_bytes())
        self.assertEqual(result["zip_sha256"], hashlib.sha256(first.read_bytes()).hexdigest())
        self.assertEqual(result["file_count"], 8)
        self.assertEqual(result["app_ids"], [bundle.APP_ID])
        with zipfile.ZipFile(first) as archive:
            self.assertEqual(archive.namelist(), list(bundle.ARCHIVE_FILES))
            for name in bundle.SKILL_FILES:
                self.assertEqual(archive.read("skills/clued/" + name), (self.skill / name).read_bytes())
            for entry in archive.infolist():
                self.assertEqual(entry.date_time, bundle.TIMESTAMP)
                self.assertEqual(entry.external_attr, bundle.MODE)
        self.assertEqual(bundle.check_archive(first), result)
        self.assertEqual(len(result["skill_files_sha256"]), 5)

    def test_wrong_or_extra_app_is_rejected(self):
        for apps in [
            {bundle.PACKAGE_NAME: {"id": "asdk_app_6a9f92f8ec908191a9ef87838c60177f"}},
            {bundle.PACKAGE_NAME: {"id": bundle.APP_ID}, "extra": {"id": bundle.APP_ID}},
        ]:
            with self.subTest(apps=apps):
                self.write_json(".app.json", {"apps": apps})
                with self.assertRaisesRegex(bundle.BundleError, "registered_app_mismatch"):
                    bundle.build_archive(self.directory / "rejected.zip")

    def test_plugin_python_cache_is_ignored_but_skill_inventory_stays_strict(self):
        original = self.directory / "original.zip"
        bundle.build_archive(original)
        for relative in ["__pycache__", ".codex-plugin/__pycache__"]:
            cache = self.plugin / relative
            cache.mkdir()
            (cache / "module.cpython-314.pyc").write_bytes(b"ordinary Python cache")
        cached = self.directory / "cached.zip"
        bundle.build_archive(cached)
        self.assertEqual(original.read_bytes(), cached.read_bytes())
        with zipfile.ZipFile(cached) as archive:
            self.assertEqual(archive.namelist(), list(bundle.ARCHIVE_FILES))
        cache = self.skill / "__pycache__"
        cache.mkdir()
        (cache / "extra.pyc").write_bytes(b"not a canonical Skill file")
        with self.assertRaisesRegex(bundle.BundleError, "skill_inventory_invalid"):
            bundle.source_files()

    def test_unwanted_mcp_marketplace_and_skill_copies_are_rejected(self):
        for name in [".mcp.json", "mcp.json", "marketplace.json", "skills/clued/SKILL.md"]:
            with self.subTest(name=name):
                extra = self.plugin / name
                extra.parent.mkdir(parents=True, exist_ok=True)
                extra.write_text("{}", encoding="utf-8")
                with self.assertRaisesRegex(bundle.BundleError, "plugin_inventory_invalid"):
                    bundle.build_archive(self.directory / "rejected.zip")
                if name.startswith("skills/"):
                    self.assertTrue((self.plugin / "skills").resolve().is_relative_to(self.repository.resolve()))
                    shutil.rmtree(self.plugin / "skills")
                else:
                    extra.unlink()
        original = json.loads((self.plugin / "plugin.json").read_text(encoding="utf-8"))
        for location in ["root", "extension"]:
            changed = json.loads(json.dumps(original))
            destination = changed if location == "root" else changed["extensions"]["com.openai"]
            destination["mcpServers"] = {"unwanted": {"url": "https://example.invalid/mcp"}}
            self.write_json("plugin.json", changed)
            with self.assertRaisesRegex(bundle.BundleError, "portable_manifest_mismatch"):
                bundle.source_files()

    def test_identity_interface_and_duplicate_json_keys_are_rejected(self):
        path = self.plugin / ".codex-plugin/plugin.json"
        original = json.loads(path.read_text(encoding="utf-8"))
        for field, value in [("name", "another-plugin"), ("version", "0.0.0"),
                             ("author", {"name": "Another author"}),
                             ("interface", {**original["interface"], "defaultPrompt": "Changed"})]:
            with self.subTest(field=field):
                self.write_json(".codex-plugin/plugin.json", {**original, field: value})
                with self.assertRaisesRegex(bundle.BundleError, "compatibility_manifest_mismatch"):
                    bundle.source_files()
        self.write_json(".codex-plugin/plugin.json", original)
        (self.plugin / ".app.json").write_text('{"apps":{},"apps":{}}', encoding="utf-8")
        with self.assertRaisesRegex(bundle.BundleError, "duplicate_json_key"):
            bundle.source_files()

    def test_skill_tampering_and_extra_archive_entries_are_rejected(self):
        archive = self.directory / "valid.zip"
        bundle.build_archive(archive)
        reference = self.skill / "references/connection-repair.md"
        original = reference.read_bytes()
        reference.write_bytes(original + b"\nChanged canonical reference\n")
        with self.assertRaisesRegex(bundle.BundleError, "archive_source_mismatch"):
            bundle.check_archive(archive)
        reference.write_bytes(original)
        files = bundle.source_files()
        files["skills/clued/SKILL.md"] += b"\nArchive-only tampering\n"
        tampered = self.directory / "tampered.zip"
        tampered.write_bytes(bundle.zip_bytes(files))
        with self.assertRaisesRegex(bundle.BundleError, "archive_source_mismatch"):
            bundle.check_archive(tampered)
        files["../outside"] = b"not an allowed archive path"
        tampered.write_bytes(bundle.zip_bytes(files))
        with self.assertRaisesRegex(bundle.BundleError, "archive_inventory_invalid"):
            bundle.check_archive(tampered)

    def test_duplicate_and_case_confused_zip_paths_are_rejected(self):
        files = bundle.source_files()
        for extra in [".app.json", ".APP.JSON"]:
            with self.subTest(extra=extra):
                raw = io.BytesIO(bundle.zip_bytes(files))
                with patch("warnings.warn"):
                    with zipfile.ZipFile(raw, "a") as archive:
                        archive.writestr(extra, b"{}")
                with self.assertRaisesRegex(bundle.BundleError, "archive_inventory_invalid"):
                    bundle.validate_zip(raw.getvalue(), files)

    def test_windows_reparse_points_are_rejected_without_dereferencing(self):
        path = self.skill / "references/connection-repair.md"
        info = SimpleNamespace(st_mode=0o100644, st_file_attributes=0x400)
        with patch.object(Path, "lstat", return_value=info):
            with self.assertRaisesRegex(bundle.BundleError, "linked_path_rejected"):
                bundle.plain_stat(path)

    def test_unsafe_output_and_overwrite_are_rejected(self):
        for output in [Path("relative.zip"), self.repository / "inside.zip",
                       self.directory / ".." / "escape.zip", self.directory / "wrong.txt"]:
            with self.subTest(output=output):
                with self.assertRaises(bundle.BundleError):
                    bundle.build_archive(output)
        existing = self.directory / "existing.zip"
        existing.write_bytes(b"preserve original")
        with self.assertRaisesRegex(bundle.BundleError, "archive_already_exists"):
            bundle.build_archive(existing)
        self.assertEqual(existing.read_bytes(), b"preserve original")
        with self.assertRaises(SystemExit) as result:
            with patch("sys.stderr", io.StringIO()):
                bundle.main(["--source", str(self.skill), "--out", str(self.directory / "out.zip")])
        self.assertEqual(result.exception.code, 2)

    def test_linked_skill_and_linked_output_parent_are_rejected(self):
        outside = self.directory / "outside.md"
        outside.write_text("not canonical", encoding="utf-8")
        reference = self.skill / "references/connection-repair.md"
        original = reference.read_bytes()
        reference.unlink()
        try:
            reference.symlink_to(outside)
        except OSError:
            reference.write_bytes(original)
            self.skipTest("Creating a test symlink requires host privileges")
        with self.assertRaisesRegex(bundle.BundleError, "linked_path_rejected"):
            bundle.source_files()
        reference.unlink()
        reference.write_bytes(original)
        linked = self.directory / "linked"
        linked.symlink_to(self.directory, target_is_directory=True)
        with self.assertRaisesRegex(bundle.BundleError, "linked_path_rejected"):
            bundle.build_archive(linked / "out.zip")



class ReleaseGateTests(unittest.TestCase):
    """The build is a Skill publishing entry: it refuses a Skill whose files differ from its released version."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="kooyumi-bundle-gate-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        root = patch.object(bundle, "REPOSITORY_ROOT", self.directory / "repo")
        root.start()
        self.addCleanup(root.stop)

    def test_build_refuses_when_the_skill_release_is_unknown_and_writes_nothing(self):
        with self.assertRaisesRegex(bundle.BundleError, "skill_release_unknown"):
            bundle.build_archive(self.directory / "out.zip")
        self.assertFalse((self.directory / "out.zip").exists())

    def test_build_refuses_a_changed_skill_under_its_released_version(self):
        sys.path.insert(0, str(Path(bundle.__file__).absolute().parents[2] / "scripts"))
        try:
            import clued_components
        finally:
            sys.path.pop(0)
        with patch.object(clued_components, "unreleased_change", lambda *_: "skill.clued 1.0.25: its files differ"):
            with self.assertRaisesRegex(bundle.BundleError, "skill_changed_without_version"):
                bundle.build_archive(self.directory / "out.zip")
        self.assertFalse((self.directory / "out.zip").exists())


if __name__ == "__main__":
    unittest.main()
