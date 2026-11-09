"""Integration candidate safety/ordering tests; all writes are throwaway fixtures."""
from pathlib import Path
import importlib.util
import json
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from tests.test_clued_components import Fixture, write
sys.path.insert(0, str(ROOT / "scripts"))
import clued_components as cc

spec = importlib.util.spec_from_file_location("component_version_integration", Path(__file__).with_name("component-version-integration.py"))
integration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(integration)


class CandidateIntegrationTest(unittest.TestCase):
    def setUp(self):
        self.repo = Fixture()
        self.addCleanup(self.repo.close)
        self.repo.git("init", "-q")
        write(self.repo.dir / "scripts/ci/check-pinned-registries.mjs",
              'console.log("fixture pinned verification executed");\n')
        self.commit("base")
        self.base = self.head()
        write(self.repo.dir / "tool.py", "print(2)\n")
        self.commit("unbumped source PR")

    def commit(self, title):
        self.repo.git("add", "-A")
        self.repo.git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", title)

    def head(self):
        return subprocess.run(["git", "rev-parse", "HEAD"], cwd=self.repo.dir,
                              capture_output=True, text=True, check=True).stdout.strip()

    def test_default_does_not_write_unbumped_pr(self):
        before = (self.repo.dir / cc.MANIFEST).read_bytes()
        report = integration.integrate_candidate(self.repo.dir, self.base, self.head())
        self.assertFalse(report["applied"])
        self.assertEqual(report["changes"][0]["target_version"], "3")
        self.assertEqual((self.repo.dir / cc.MANIFEST).read_bytes(), before)

    def test_clean_candidate_is_generated_then_verified_without_git_mutation(self):
        before = self.head()
        report = integration.integrate_candidate(self.repo.dir, self.base, before, write=True)
        self.assertTrue(report["applied"])
        self.assertEqual(cc.by_id(cc.load_manifest(self.repo.dir))["tool"]["version"], "3")
        self.assertEqual(cc.check(self.repo.dir, self.base), [])
        self.assertEqual(self.head(), before)
        self.assertIn("config/clued-components.json", report["output_sha256"])
        self.commit("generated integration metadata")
        second = integration.integrate_candidate(self.repo.dir, self.base, self.head(), write=True)
        self.assertEqual(second["changes"], [])
        self.assertEqual(second["output_sha256"], {})

    def test_refuses_dirty_candidate_before_mutation(self):
        write(self.repo.dir / "tool.py", "print(3)\n")
        before = (self.repo.dir / cc.MANIFEST).read_bytes()
        with self.assertRaisesRegex(ValueError, "clean candidate"):
            integration.integrate_candidate(self.repo.dir, self.base, self.head(), write=True)
        self.assertEqual((self.repo.dir / cc.MANIFEST).read_bytes(), before)

    def test_refuses_symbolic_or_stale_head(self):
        with self.assertRaisesRegex(ValueError, "exact base"):
            integration.integrate_candidate(self.repo.dir, "HEAD", self.head(), write=True)
        with self.assertRaisesRegex(ValueError, "head changed"):
            integration.integrate_candidate(self.repo.dir, self.base, "0" * 40, write=True)

    def test_pinned_failure_never_becomes_success(self):
        write(self.repo.dir / "scripts/ci/check-pinned-registries.mjs", 'process.exit(2);\n')
        self.commit("unchecked pin verifier")
        with self.assertRaisesRegex(ValueError, "integration step failed"):
            integration.integrate_candidate(self.repo.dir, self.base, self.head(), write=True)

    def test_control_source_generation_observes_materialized_versions_and_exact_base(self):
        write(self.repo.dir / "scripts/ci/clued-control-source-pins.mjs", r'''
import fs from 'node:fs';
const args=process.argv.slice(2), at=args.indexOf('--base');
if(at<0 || !args.includes('--write')) process.exit(3);
const manifest=JSON.parse(fs.readFileSync('config/clued-components.json','utf8'));
fs.writeFileSync('control-source-observed.json',JSON.stringify({
  base:args[at+1], version:manifest.components.find(c=>c.id==='tool').version
})+'\n');
''')
        self.commit("control Source generator fixture")
        report = integration.integrate_candidate(self.repo.dir, self.base, self.head(), write=True)
        self.assertTrue(report["applied"])
        observed = json.loads((self.repo.dir / "control-source-observed.json").read_text())
        self.assertEqual(observed, {"base": self.base, "version": "3"})


if __name__ == "__main__":
    unittest.main()
