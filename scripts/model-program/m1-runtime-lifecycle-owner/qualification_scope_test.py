import json
import ast
from pathlib import Path
import unittest
from unittest import mock
from qualification_scope import QUALIFICATION_ROOT, PROTECTED_ROOTS, overlaps, validate_output_path, QualificationScope, require_go_test_report

class QualificationScopeTests(unittest.TestCase):
    def test_fixed_direct_child(self):
        actual = validate_output_path(QUALIFICATION_ROOT + r"\r1_build_02", r"D:\code\clued")
        self.assertEqual(actual, (QUALIFICATION_ROOT + r"\r1_build_02").lower())

    def test_protected_namespace_and_ancestors_rejected(self):
        for p in PROTECTED_ROOTS:
            for bad in (p, p + r"\runtime-state\x", p.rsplit("\\", 1)[0], p + r"\evidence\r1"):
                with self.subTest(path=bad), self.assertRaises(ValueError):
                    validate_output_path(bad, r"D:\code\clued")

    def test_aliases_and_bad_labels_rejected(self):
        for suffix in (r"\..\bad", r"\a\b", r"\r1:stream", r"\CON", r"\test.", r"\test ", "\\", r"\test*", r"\r1\..\r2"):
            with self.subTest(suffix=suffix), self.assertRaises(ValueError):
                validate_output_path(QUALIFICATION_ROOT + suffix, r"D:\code\clued")
        for bad in (r"\\server\share\r1", r"\\?\C:\Clued\r1", r"C:r1", "r1"):
            with self.subTest(path=bad), self.assertRaises(ValueError):
                validate_output_path(bad, r"D:\code\clued")

    def test_repository_ancestor_overlap(self):
        with self.assertRaises(ValueError):
            validate_output_path(QUALIFICATION_ROOT + r"\r1", r"C:\Users\Public\Clued")

    def test_component_aware_overlap(self):
        self.assertFalse(overlaps(r"C:\a\b", r"C:\a\bc"))
        self.assertTrue(overlaps(r"C:\a\b", r"c:\A\B\c"))
        self.assertTrue(overlaps(r"C:\a\b\c", r"c:\A\B"))

    def test_invalid_scope_rejected_without_any_mkdir(self):
        with mock.patch.object(Path, "mkdir") as mkdir:
            with self.assertRaises(ValueError):
                QualificationScope(Path(PROTECTED_ROOTS[0] + r"\runtime-state\bad"), Path(r"D:\code\clued"))
            mkdir.assert_not_called()

    def test_import_and_scope_validation_perform_no_filesystem_write(self):
        # Import is intentionally pure. Context entry alone can write; validation
        # failure above cannot provision either a qualification or runtime root.
        tree = ast.parse(Path(__file__).with_name('qualification_scope.py').read_text())
        calls = [x for x in tree.body if isinstance(x, ast.Expr) and isinstance(x.value, ast.Call)]
        self.assertEqual(calls, [])

class QualificationTestReportTests(unittest.TestCase):
    def rows(self, *events):
        return "\n".join(json.dumps(event) for event in events)

    def test_required_native_test_pass_required(self):
        raw = self.rows({"Action": "pass", "Test": "Required"}, {"Action": "pass"})
        result = require_go_test_report(raw, ("Required",))
        self.assertEqual(result["top_level_pass"], 1)

    def test_package_ok_cannot_hide_skip(self):
        raw = self.rows({"Action": "skip", "Test": "Required"}, {"Action": "pass"})
        with self.assertRaises(RuntimeError):
            require_go_test_report(raw, ("Required",))

    def test_missing_test_and_failure_rejected(self):
        for raw in (self.rows({"Action": "pass"}), self.rows({"Action": "fail", "Test": "Required"})):
            with self.assertRaises(RuntimeError):
                require_go_test_report(raw, ("Required",))

if __name__ == '__main__':
    unittest.main()
