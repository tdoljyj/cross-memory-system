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


REAL_POLICY = json.loads((ROOT / "config/clued-mechanical-files.json").read_text(encoding="utf-8"))
GENERATOR = "scripts/ci/clued-control-source-pins.mjs"  # any fixed generator slot the integrator runs


class CandidateIntegrationTest(unittest.TestCase):
    def setUp(self):
        self.repo = Fixture()
        self.addCleanup(self.repo.close)
        self.repo.git("init", "-q")
        write(self.repo.dir / "scripts/ci/check-pinned-registries.mjs",
              'console.log("fixture pinned verification executed");\n')
        write(self.repo.dir / "config/clued-mechanical-files.json", json.dumps(dict(
            REAL_POLICY, mechanical_paths=["config/clued-components.json", "control-source-observed.json"])))
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

    def generator(self, body):
        write(self.repo.dir / GENERATOR, "import fs from 'node:fs';\n" + body)
        self.commit("generator fixture")

    def test_unregistered_generated_file_fails_with_the_registration_hint(self):
        self.generator("fs.writeFileSync('scripts/ci/new-registry.json','{}\\n');\n")
        with self.assertRaisesRegex(ValueError, "scripts/ci/new-registry.json 未登记到 config/clued-mechanical-files.json"):
            integration.integrate_candidate(self.repo.dir, self.base, self.head(), write=True)

    def test_registered_directory_output_is_accepted(self):
        write(self.repo.dir / "config/clued-mechanical-files.json", json.dumps(dict(
            REAL_POLICY, mechanical_paths=["config/clued-components.json", "gen/**"])))
        self.generator("fs.mkdirSync('gen/a',{recursive:true});fs.writeFileSync('gen/a/out.ts','x\\n');\n")
        report = integration.integrate_candidate(self.repo.dir, self.base, self.head(), write=True)
        self.assertIn("gen/a/out.ts", report["output_sha256"])

    def test_generator_body_edit_of_a_version_marker_file_is_not_mechanical(self):
        # pkg/SKILL.md is a declared version-marker file: integration may render
        # its marker line, any other edit belongs in the PR itself.
        self.generator("const t=fs.readFileSync('pkg/SKILL.md','utf8');\n"
                       "if(!t.includes('generated tail'))fs.writeFileSync('pkg/SKILL.md',t+'generated tail\\n');\n")
        with self.assertRaisesRegex(ValueError, "pkg/SKILL.md 未登记"):
            integration.integrate_candidate(self.repo.dir, self.base, self.head(), write=True)

    def test_marker_only_version_rendering_needs_no_registration(self):
        write(self.repo.dir / "pkg/references/a.md", "b\n")
        self.commit("skill change")
        report = integration.integrate_candidate(self.repo.dir, self.base, self.head(), write=True)
        self.assertIn("pkg/SKILL.md", report["output_sha256"])


if __name__ == "__main__":
    unittest.main()
