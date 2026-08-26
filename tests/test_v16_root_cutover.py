import hashlib
import json
import subprocess
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MEMORY = ROOT / "memory"
LEGACY = {"画像.md", "状态.md", "待办.md", "决策.md", "归档.md", "object-index.json", "contexts", "audit", "session"}
VIEWS = {"state.md", "task.md", "decision.md", "archive.md", "log.md"}


class V16RootCutover(unittest.TestCase):
    def manifest(self):
        return json.loads((MEMORY / "manifest.json").read_text(encoding="utf-8"))

    def test_root_contract_and_no_legacy_dual_write(self):
        self.assertTrue((MEMORY / "profile.md").is_file())
        self.assertEqual(VIEWS, {p.name for p in (MEMORY / "global").iterdir() if p.is_file()})
        self.assertTrue((MEMORY / "projects").is_dir())
        self.assertTrue((MEMORY / "objects" / "records").is_dir())
        self.assertTrue((MEMORY / "objects" / "projects").is_dir())
        self.assertTrue((MEMORY / "objects" / "legacy").is_dir())
        self.assertFalse(LEGACY & {p.name for p in MEMORY.iterdir()})

    def test_manifest_is_current_and_all_hashes_match(self):
        manifest = self.manifest()
        self.assertEqual("current", manifest["baseline_claim"])
        self.assertEqual("live_rechecked", manifest["source_verification"])
        self.assertTrue(manifest["views_complete"])
        self.assertEqual("ready", manifest["status"])
        for item in manifest["files"]:
            path = MEMORY / item["path"]
            self.assertTrue(path.is_file(), item["path"])
            self.assertEqual(item["sha256"], hashlib.sha256(path.read_bytes()).hexdigest(), item["path"])

    def test_root_matches_formal_pointer(self):
        pointer = json.loads((ROOT / "artifacts" / "clued-two-level-snapshots" / "current.json").read_text(encoding="utf-8"))
        published = ROOT / "artifacts" / "clued-two-level-snapshots" / pointer["bundle_path"]
        root_files = {p.relative_to(MEMORY).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in MEMORY.rglob("*") if p.is_file()}
        published_files = {p.relative_to(published).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in published.rglob("*") if p.is_file()}
        self.assertEqual(published_files, root_files)

    def run_cli(self, *args):
        return subprocess.run([sys.executable, str(ROOT / "memory.py"), *args], cwd=ROOT, text=True, encoding="utf-8", capture_output=True)

    def test_read_only_cli(self):
        self.assertEqual(0, self.run_cli("doctor").returncode)
        status = self.run_cli("status")
        self.assertEqual(0, status.returncode)
        self.assertEqual("cv_155", json.loads(status.stdout)["canonical_version"])
        t0 = self.run_cli("recall", "generic", "--tier", "T0")
        self.assertEqual([], json.loads(t0.stdout)["sources_read"])
        write = self.run_cli("add", "--content", "forbidden")
        self.assertEqual(2, write.returncode)
        self.assertIn("local_snapshot_is_read_only", write.stderr)

    def test_consumers_reject_dual_write(self):
        agents = (ROOT / "AGENTS.md").read_text(encoding="utf-8")
        for name in LEGACY:
            if isinstance(name, str) and name.endswith(".md"):
                self.assertNotIn(f"`memory/{name}`", agents)
        self.assertIn("only online Canonical Store", agents)
        self.assertIn("clued_record_mutate", agents)
        self.assertIn("business-memory push path must fail closed", agents)


if __name__ == "__main__":
    unittest.main()
