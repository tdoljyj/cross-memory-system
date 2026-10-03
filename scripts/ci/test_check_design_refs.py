"""Tests for check_design_refs.py (run: python3 -m unittest scripts/ci/test_check_design_refs.py)."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_design_refs as checker  # noqa: E402

STEPS = """# Design

## 7. 分步（每步单独请 Owner 授权）

1. 资源模型（Task `e9a10dbb`）。
2. 默认门口：接入存储写工具。
3. 多份模式，
   延续 Task `5d379c50` 的说明。

## 8. 其他

1. 这里不是分步清单。
"""


class CheckTextTest(unittest.TestCase):
    def test_step_items_need_an_id_on_the_item_or_its_continuation(self):
        findings = checker.check_text("d.md", STEPS)
        self.assertEqual(len(findings), 1, findings)
        self.assertIn("d.md:6: step without", findings[0])

    def test_step_section_ends_at_a_heading_of_the_same_level(self):
        findings = checker.check_text("d.md", "## Implementation slices\n\n1. S1 (Task `45fb2ae7`)\n\n## Next\n\n1. free text\n")
        self.assertEqual(findings, [])

    def test_deferral_sentence_needs_its_own_id(self):
        text = "第 2 步（Task `9cabcfa0`）：已上线。放宽范围本步不做。\n- 不做 OCR（Decision `7dbb4c09`）。\n"
        findings = checker.check_text("d.md", text)
        self.assertEqual(len(findings), 1, findings)
        self.assertIn("放宽范围本步不做", findings[0])

    def test_every_deferral_word_and_table_cells(self):
        for word in ("不做", "暂缓", "未实现", "未做", "待做", "not yet implemented", "deferred to v2"):
            self.assertEqual(len(checker.check_text("d.md", f"这一项{word}。\n")), 1, word)
        table = "| 项 | 状态 |\n|---|---|\n| 配额 | 未实现 |\n| 读取 | 已上线 |\n"
        self.assertEqual(len(checker.check_text("d.md", table)), 1)
        self.assertEqual(checker.check_text("d.md", "| 配额 | 未实现（Task `2a31ca2a`） |\n"), [])

    def test_ids_in_any_accepted_form(self):
        for ref in ("Task `fcd55008`", "Decision 2a7391ff", "任务 `bb9f1e36`", "决定：`136a000e`",
                    "Task `fcd55008-b277-40b2-9f71-1aa6cd42ec41`", "Decisions `aaaaaaaa`、`bbbbbbbb`"):
            self.assertEqual(checker.check_text("d.md", f"本步不做（{ref}）。\n"), [], ref)
        for ref in ("Task 1234567", "PR #522", "`fcd55008`", "Task `fcd5500g`"):
            self.assertEqual(len(checker.check_text("d.md", f"本步不做（{ref}）。\n")), 1, ref)

    def test_code_and_comments_are_ignored(self):
        text = "```\n不做\n```\n`不做` 是一个字面量。\n<!-- 暂缓 -->\n<!--\n未实现\n-->\n"
        self.assertEqual(checker.check_text("d.md", text), [])


class MainTest(unittest.TestCase):
    def tree(self, files: dict[str, str]) -> Path:
        root = Path(tempfile.mkdtemp())
        for name, body in files.items():
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(body, encoding="utf-8")
        return root

    def run_main(self, root: Path) -> int:
        stdout = sys.stdout
        try:
            sys.stdout = open("/dev/null", "w", encoding="utf-8")
            return checker.main([str(root)])
        finally:
            sys.stdout.close()
            sys.stdout = stdout

    def test_passes_fails_and_honours_the_exempt_list(self):
        root = self.tree({
            "development/contracts/a/A.md": "已上线（Task `5d379c50`）。\n",
            "development/contracts/b/Frozen.md": "这一步暂缓。\n",
            "development/contracts/b/README.md": "pins Frozen.md\n",
        })
        self.assertEqual(self.run_main(root), 1)
        exempt = {"exempt": [{"path": "development/contracts/b/Frozen.md", "pinned_by": "development/contracts/b/README.md",
                              "decision": "558c0a0b", "reason": "frozen"}]}
        (root / checker.EXEMPT_FILE).write_text(json.dumps(exempt), encoding="utf-8")
        self.assertEqual(self.run_main(root), 0)

    def test_a_malformed_exempt_entry_fails(self):
        for entry in ({"path": "development/contracts/b/Frozen.md", "pinned_by": "missing.md", "reason": "x"},
                      {"path": "development/contracts/b/Frozen.md", "pinned_by": "development/contracts/b/README.md", "reason": ""},
                      {"path": "development/contracts/b/Frozen.md", "pinned_by": "development/contracts/b/README.md",
                       "decision": "not-an-id", "reason": "x"},
                      {"path": "docs/Elsewhere.md", "pinned_by": "development/contracts/b/README.md", "reason": "x"}):
            root = self.tree({"development/contracts/b/Frozen.md": "ok\n", "development/contracts/b/README.md": "pins\n"})
            (root / checker.EXEMPT_FILE).write_text(json.dumps({"exempt": [entry]}), encoding="utf-8")
            self.assertEqual(self.run_main(root), 1, entry)

    def test_the_repository_exempt_file_is_well_formed(self):
        exempt, problems = checker.load_exempt(checker.ROOT)
        self.assertEqual(problems, [])
        self.assertTrue(exempt)


if __name__ == "__main__":
    unittest.main()
