"""Non-effectful build-boundary regressions; no real model paths are written."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("owner_build", Path(__file__).with_name("build.py"))
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class QualificationBoundaryTests(unittest.TestCase):
    def test_fixed_namespace_accepts_only_direct_child(self):
        root = str(build.QUALIFICATION_ROOT)
        self.assertEqual(build.qualification_output_name(root + r"\build-A"), "build-A")
        self.assertEqual(build.qualification_output_name(root.lower() + "/build-B"), "build-B")

    def test_protected_and_untrusted_outputs_rejected_without_creation(self):
        root = str(build.QUALIFICATION_ROOT)
        bad = [
            r"C:\Users\Public\Clued\ModelProgram\M1\runtime-state\M1-LIFE-QWEN35-08B-PC-001",
            r"C:\Users\Public\Clued\ModelProgram\M1\runtime-lifecycle-smoke\M1-LIFE-QWEN35-08B-PC-001",
            r"C:\Users\Public\Clued\ModelProgram\M1\evidence\M1-LIFE-QWEN35-08B-PC-001",
            r"C:\Users\Public\Clued\ModelProgram\M1\packages\Qwen_Qwen3.5-0.8B\m1pkg002",
            r"C:\arbitrary-output", r"\\server\share\output", r"\\?\C:\output",
            "relative", root, root + r"\..\escape", root + r"\nested\child",
            root + r"\output:ads", root + r"\output.", root + r"\output ",
            root + r"\CON", root + r"\NUL.log", root + r"\COM1", root + r"\LPT9",
        ]
        for path in bad:
            with self.subTest(path=path):
                with self.assertRaises(ValueError):
                    build.qualification_output_name(path)

    def test_skips_and_unfinished_tests_cannot_count_as_pass(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "go-test.jsonl"
            for outcome in ("skip", "fail", "output"):
                p.write_text('\n'.join(json.dumps(x) for x in [
                    {"Action": "run", "Test": "TestNative"},
                    {"Action": outcome, "Test": "TestNative"},
                ]), encoding="utf-8")
                with self.assertRaises(RuntimeError):
                    build.summarize_test_events(p)
            p.write_text('\n'.join(json.dumps(x) for x in [
                {"Action": "run", "Test": "TestNative"},
                {"Action": "pass", "Test": "TestNative"},
            ]), encoding="utf-8")
            self.assertEqual(build.summarize_test_events(p)["passed"], 1)


if __name__ == "__main__":
    unittest.main()
