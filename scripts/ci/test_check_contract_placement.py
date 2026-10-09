"""Negative and rollout fixtures for ComponentVersioning.v0.2 (Task af536fcc)."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import unittest

spec = importlib.util.spec_from_file_location("contract_placement", Path(__file__).with_name("check_contract_placement.py"))
checker = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = checker
spec.loader.exec_module(checker)


def blob(value, mode="100644"):
    return checker.Blob(mode, value.encode("utf-8") if isinstance(value, str) else value)


def manifest():
    return {"schema": "clued.components/1", "components": [
        {"id": "skill.clued", "kind": "skill", "root": "skills/clued", "version": "1.0.13", "files": ["**/*"]},
        {"id": "agent-contract", "kind": "contract", "root": "skills/clued/references", "files": ["agent-contract.md"], "version": "41"},
        {"id": "mcp.server", "kind": "service", "version": "0.4.4"},
    ]}


def legacy():
    source = blob("# Contract\n\nContract version: 41\n\n## Start\nRules.\n")
    return {checker.MANIFEST: blob(json.dumps(manifest())), checker.LEGACY: source, checker.COPY: source,
            "skills/clued/SKILL.md": blob("Read agent-contract §1.6 through clued_agent_bootstrap.\n")}


def change_manifest(tree, change):
    value = json.loads(tree[checker.MANIFEST].data)
    change(value)
    tree[checker.MANIFEST] = blob(json.dumps(value))


def split(base):
    head = copy.deepcopy(base)
    head[checker.NEW] = head.pop(checker.LEGACY)
    head.pop(checker.COPY)
    change_manifest(head, lambda m: m["components"][1].update(root="protocol/agent"))
    return head


def production(base, version="0.4.5", sha=None):
    return {"agent_contract": {"sha256": sha or hashlib.sha256(base[checker.LEGACY].data.replace(b"\r\n", b"\n")).hexdigest()},
            "components": {"versions": {"mcp.server": version}}}


class PlacementTests(unittest.TestCase):
    def check(self, base, head, reader=None, floor=None):
        return checker.check_placement(base, head, read_production=reader, minimum_service_version=floor)

    def test_real_pre_split_layout_passes(self):
        tree = checker.git_tree(checker.ROOT, "7888979c7e6a7e467aaa062aa84934918a024722")
        failures, notices = self.check(tree, tree)
        self.assertEqual(failures, [])
        self.assertTrue(any("pending-split" in notice for notice in notices))

    def test_legacy_pending_does_not_read_production(self):
        failures, notices = self.check(legacy(), legacy(), lambda: self.fail("premature production read"))
        self.assertEqual(failures, [])
        self.assertEqual(len(notices), 1)

    def test_synchronized_contract_edit_stays_pending(self):
        base, head = legacy(), legacy()
        head[checker.LEGACY] = head[checker.COPY] = blob("Contract version: 42\n")
        change_manifest(head, lambda m: m["components"][1].update(version="42"))
        self.assertEqual(self.check(base, head)[0], [])

    def test_copy_must_match_in_base_and_head(self):
        for side in ("base", "head"):
            for mutation in ("missing", "drift", "symlink"):
                with self.subTest(side=side, mutation=mutation):
                    base, head = legacy(), legacy()
                    target = base if side == "base" else head
                    if mutation == "missing":
                        target.pop(checker.COPY)
                    else:
                        target[checker.COPY] = blob("different", "120000" if mutation == "symlink" else "100644")
                    self.assertTrue(self.check(base, head)[0])

    def test_source_symlink_never_enters_transition(self):
        base, head = legacy(), legacy()
        head[checker.LEGACY] = blob("/outside/source", "120000")
        self.assertTrue(self.check(base, head)[0])

    def test_other_skill_contract_files_and_markers_fail(self):
        for path, content in (
            ("skills/other/agent-contract.md", "text"),
            ("integrations/other/skills/clued/agent-contract.md", "text"),
            ("skills/clued/references/hidden.txt", "Contract version: 42\n"),
            ("integrations/other/skills/a/reference.md", "Contract version: 42\n"),
        ):
            with self.subTest(path=path):
                head = legacy()
                head[path] = blob(content)
                self.assertTrue(any("rule 1" in failure for failure in self.check(legacy(), head)[0]))

    def test_version_pin_forms_fail(self):
        for value in ("Contract version: 42", "word Contract version: 42.", "see contract v42.", "合同v35.",
                      "`contract_version` 42", "contract (v42)", "v42 of the contract"):
            with self.subTest(value=value):
                head = legacy()
                head["skills/clued/references/engineering.md"] = blob(value)
                self.assertTrue(any("rule 3" in failure for failure in self.check(legacy(), head)[0]))

    def test_exempt_forms_pass(self):
        for value in ("OAuth (v2) flow", "contract §1.7", "合同 §3.6", "project_lifecycle.contract_version: 2",
                      "metadata.version: 1.0.13", "contract_version and agent-contract", "contract's §1.6"):
            with self.subTest(value=value):
                head = legacy()
                head["skills/clued/references/engineering.md"] = blob(value)
                self.assertEqual(self.check(legacy(), head)[0], [])

    def test_manifest_identity_cannot_enable_exemption(self):
        for field, value in (("kind", "skill"), ("root", "skills/clued"), ("files", ["*.md"]),
                             ("files", ["agent-contract.md", "hidden.md"])):
            with self.subTest(field=field, value=value):
                head = legacy()
                change_manifest(head, lambda m: m["components"][1].update({field: value}))
                self.assertTrue(self.check(legacy(), head)[0])

    def test_skill_component_missing_malformed_or_moved_fails(self):
        for mutation in (lambda m: m["components"].pop(0),
                         lambda m: m["components"][0].update(kind="script"),
                         lambda m: m["components"][0].update(root="elsewhere"),
                         lambda m: m["components"].append(dict(m["components"][0]))):
            head = legacy()
            change_manifest(head, mutation)
            self.assertTrue(self.check(legacy(), head)[0])

    def test_other_contract_component_cannot_hide_in_skill(self):
        head = legacy()
        change_manifest(head, lambda m: m["components"].append({"id": "hidden", "kind": "contract", "root": "skills/other"}))
        self.assertTrue(any("rule 2" in failure for failure in self.check(legacy(), head)[0]))

    def test_custom_skill_root_also_scanned(self):
        head = legacy()
        change_manifest(head, lambda m: m["components"].append({"id": "skill.other", "kind": "skill", "root": "custom/package"}))
        head["custom/package/agent-contract.md"] = blob("copied contract")
        self.assertTrue(any("rule 1" in failure for failure in self.check(legacy(), head)[0]))

    def test_invalid_or_escape_root_fails(self):
        for value in ("../skills", "/skills", "skills/../elsewhere", "skills\\other", None):
            with self.subTest(value=value):
                head = legacy()
                change_manifest(head, lambda m: m["components"][1].update(root=value))
                self.assertTrue(self.check(legacy(), head)[0])

    def test_valid_split_reads_production_once(self):
        base = legacy()
        calls = []
        def reader():
            calls.append(True)
            return production(base)
        failures, notices = self.check(base, split(base), reader, "0.4.5")
        self.assertEqual(failures, [])
        self.assertEqual(notices, [])
        self.assertEqual(calls, [True])

    def test_moving_and_editing_contract_fails(self):
        base = legacy()
        head = split(base)
        head[checker.NEW] = blob("Contract version: 42\n")
        self.assertTrue(any("differs" in failure for failure in self.check(base, head, lambda: production(base), "0.4.5")[0]))

    def test_missing_or_symlink_new_source_fails(self):
        base = legacy()
        for mode in (None, "120000"):
            head = split(base)
            if mode is None:
                head.pop(checker.NEW)
            else:
                head[checker.NEW] = blob("elsewhere", mode)
            self.assertTrue(self.check(base, head, lambda: production(base), "0.4.5")[0])

    def test_leftover_copy_or_wrong_new_root_fails(self):
        base = legacy()
        head = split(base)
        head[checker.COPY] = base[checker.COPY]
        self.assertTrue(self.check(base, head, lambda: production(base), "0.4.5")[0])
        head = split(base)
        change_manifest(head, lambda m: m["components"][1].update(root="protocol/other"))
        self.assertTrue(self.check(base, head, lambda: production(base), "0.4.5")[0])

    def test_production_old_hash_missing_version_or_old_service_fails(self):
        base = legacy()
        for result in (production(base, sha="0" * 64), production(base, version="0.4.4"), {},
                       {"agent_contract": production(base)["agent_contract"]}):
            with self.subTest(result=result):
                self.assertTrue(self.check(base, split(base), lambda: result, "0.4.5")[0])

    def test_production_failure_does_not_pass(self):
        def unavailable():
            raise OSError("unreachable")
        base = legacy()
        self.assertTrue(self.check(base, split(base), unavailable, "0.4.5")[0])
        self.assertTrue(self.check(base, split(base))[0])

    def test_numeric_service_comparison(self):
        base = legacy()
        self.assertEqual(self.check(base, split(base), lambda: production(base, "0.4.10"), "0.4.5")[0], [])
        self.assertEqual(self.check(base, split(base), lambda: production(base, "0.4.5.0"), "0.4.5")[0], [])

    def test_post_split_never_reenters_transition(self):
        base = split(legacy())
        failures, notices = self.check(base, legacy())
        self.assertTrue(any("rule 1" in failure for failure in failures))
        self.assertTrue(any("rule 2" in failure for failure in failures))
        self.assertEqual(notices, [])

    def test_post_split_has_no_production_read(self):
        base = split(legacy())
        self.assertEqual(self.check(base, base, lambda: self.fail("post-split read"))[0], [])

    def test_response_budget_includes_structured_and_escaped_content(self):
        normal = {"content": [{"type": "text", "text": "source"}], "structuredContent": {"agent_contract": {"parts": 1}}}
        self.assertEqual(checker.check_response_budget([normal]), [])
        oversized = copy.deepcopy(normal)
        oversized["structuredContent"]["hidden_duplicate"] = "x" * checker.BUDGET_BYTES
        self.assertTrue(checker.check_response_budget([oversized]))
        escaped = copy.deepcopy(normal)
        escaped["content"][0]["text"] = "\n" * (checker.BUDGET_BYTES // 2)
        self.assertTrue(checker.check_response_budget([escaped]))
        self.assertTrue(checker.check_response_budget([]))
        self.assertTrue(checker.check_response_budget([{}]))


if __name__ == "__main__":
    unittest.main()
