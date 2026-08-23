import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ROUTES_PATH = ROOT / "memory" / "contexts" / "routes.json"


def load_route():
    return json.loads(ROUTES_PATH.read_text(encoding="utf-8"))


def resolve_sources(query):
    route = load_route()
    folded = query.casefold()
    terms = [term.casefold() for term in route["match"]["terms"]]
    if not any(term in folded for term in terms):
        return []
    sources = [item["path"] for item in route["required_sources"]]
    sources.extend(
        item["path"] for item in route["authorized_context_sources"]
        if item.get("required_when_authorized_and_relevant")
    )
    return sources


class CluedMemoryRoutingTests(unittest.TestCase):
    def test_current_work_prompts_use_complete_read_set(self):
        expected = {
            "memory/状态.md",
            "memory/待办.md",
            "memory/决策.md",
            "memory/contexts/projects/clued/日志.md",
        }
        prompts = [
            "我现在要做的有哪些",
            "我现在最需要做什么",
            "当前待办是什么",
            "Clued 下一步是什么",
            "What should I work on now?",
        ]
        for prompt in prompts:
            with self.subTest(prompt=prompt):
                self.assertEqual(set(resolve_sources(prompt)), expected)

    def test_generic_question_does_not_match_current_work_route(self):
        self.assertEqual(resolve_sources("解释一下 Python 列表"), [])

    def test_answer_contract_requires_trace_and_conflict_reporting(self):
        contract = load_route()["answer_contract"]
        self.assertIn("sources_read", contract["required_fields"])
        self.assertIn("conflicts", contract["required_fields"])
        self.assertTrue(contract["surface_conflicts"])
        self.assertTrue(contract["fail_closed_when_required_source_is_unavailable"])
        self.assertFalse(contract["project_log_replaces_global_memory"])

    def test_root_agents_enforces_route(self):
        agents = (ROOT / "AGENTS.md").read_text(encoding="utf-8")
        self.assertIn("memory/contexts/routes.json", agents)
        self.assertIn("状态.md + 待办.md + 决策.md", agents)
        self.assertIn("我现在要做的有哪些", agents)

    def test_cloud_agents_uses_canonical_repo_log(self):
        agents = (ROOT / "apps" / "clued-cloud" / "AGENTS.md").read_text(encoding="utf-8")
        self.assertIn("memory/contexts/projects/clued/日志.md", agents)
        self.assertIn("memory/contexts/routes.json", agents)
        self.assertNotIn("Clued_工作日志.md", agents)

    def test_legacy_l1_l6_index_is_unchanged(self):
        index = json.loads((ROOT / "memory" / "index.json").read_text(encoding="utf-8"))
        self.assertEqual(index["schema_version"], 1)
        self.assertEqual(
            index["files"],
            ["画像.md", "状态.md", "决策.md", "待办.md", "归档.md"],
        )


if __name__ == "__main__":
    unittest.main()
