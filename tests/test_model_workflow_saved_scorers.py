"""Pure technical arithmetic examples; no actual Corpus, Gold, model or action."""
import copy
import importlib.util
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("private_workflow_scorers", ROOT / "scripts/model-program/workflow_saved_scorers.py")
S = importlib.util.module_from_spec(spec)
spec.loader.exec_module(S)


def common(names=None):
    return {"policy_ref": "technical-example:policy", "task_spec_ref": None, "threshold_ref": None,
            "expected_request_ids": names or ["r1"],
            "status_categories": {"ok": "SUCCEEDED", "fail": "RUNTIME_ERROR",
                                  "abstain": "ABSTAINED", "unknown": "UNKNOWN"}}


def relation_policy(names=None):
    return {**common(names), "labels": ["a", "b"],
            "loss_matrix": {"a": {"a": 0, "b": 4}, "b": {"a": 2, "b": 0}}, "require_support": True}


def relation_row(name="r1", label="a"):
    return {"id": name, "status": "ok",
            "candidate": {"label": label, "support_refs": ["s"], "counterevidence_refs": ["c"]},
            "reference": {"available_refs": ["s", "c"], "supporting_refs": ["s"],
                          "required_counterevidence_refs": ["c"], "gold_label": "a",
                          "source_ref": "technical-example:external-reference"}}


def context_policy(names=None):
    return {**common(names), "contexts": [{"id": "a", "tokens": 2}, {"id": "b", "tokens": 3}],
            "context_set_ref": "technical-example:fixed-set", "gain_rule": "linear",
            "cutoff": 2, "discounts": [1, 0.5], "token_budget": 5}


def context_row(name="r1"):
    return {"id": name, "status": "ok", "input_context_ids": ["a", "b"],
            "candidate": {"ordered_ids": ["a", "b"], "raw_scores": {"a": -3, "b": -8}},
            "reference": {"relevance": {"a": 3, "b": 1}, "source_ref": "technical-example:reference",
                          "downstream_effect": {"correct": True, "required_omissions": 0, "conflicts_preserved": True}}}


def route_policy(names=None):
    return {**common(names), "nodes": [
        {"id": "start", "action_id": None, "terminal": False, "cost": 0},
        {"id": "work", "action_id": "act", "terminal": False, "cost": 2},
        {"id": "end", "action_id": None, "terminal": True, "cost": 0},
        {"id": "other", "action_id": None, "terminal": True, "cost": 1}],
        "edges": [["start", "work"], ["work", "end"], ["start", "other"]], "start": "start",
        "allowed_action_ids": ["act"], "max_steps": 3, "budget": 3}


def route_row(name="r1"):
    return {"id": name, "status": "ok", "candidate": {"path": ["start", "work", "end"], "actions": ["act"]},
            "reference": {"allowed_routes": [["start", "work", "end"]],
                          "route_losses": [{"path": ["start", "work", "end"], "loss": 0},
                                           {"path": ["start", "other"], "loss": 4}],
                          "source_ref": "technical-example:route-reference"}}


class SharedBoundaryTests(unittest.TestCase):
    cases = ((S.score_semantic_relations, relation_policy, relation_row),
             (S.score_context_relevance, context_policy, context_row),
             (S.score_processing_routes, route_policy, route_row))

    def test_inputs_immutable_and_every_report_has_no_authority_or_formal_id(self):
        for fn, factory, row in self.cases:
            p, records = factory(), [row()]
            before = copy.deepcopy((p, records))
            answer = fn(records, p)
            self.assertEqual((p, records), before)
            self.assertEqual(answer["authority_effect"], "NONE")
            self.assertEqual(answer["gate"], "NOT_ISSUED")
            self.assertIsNone(answer["formal_capability_id"])
            self.assertIsNone(answer["task_spec_ref"])
            self.assertFalse(answer["authority_and_freeze_verified"])
            self.assertFalse(answer["reference_provenance_verified"])

    def test_missing_duplicate_and_unregistered_request_ids_rejected(self):
        for fn, factory, row in self.cases:
            for records in ([], [row(), row()], [row("other")]):
                with self.subTest(function=fn.__name__, records=records), self.assertRaises(ValueError):
                    fn(records, factory())
            p = factory(); p["expected_request_ids"] *= 2
            with self.assertRaises(ValueError): fn([row()], p)

    def test_unknown_field_status_and_candidate_self_grading_rejected(self):
        for fn, factory, row in self.cases:
            for target in ("policy", "row", "candidate"):
                p, r = factory(), row()
                (p if target == "policy" else r if target == "row" else r["candidate"])["correct"] = True
                with self.subTest(target=target, fn=fn.__name__), self.assertRaises(ValueError): fn([r], p)
            r = row(); r["status"] = "unmapped"
            with self.assertRaises(ValueError): fn([r], factory())

    def test_all_fail_abstain_unknown_requests_retained_and_full_denominator(self):
        for fn, factory, row in self.cases:
            names = ["r1", "r2", "r3", "r4"]
            records = [row("r1")]
            for name, status in zip(names[1:], ["fail", "abstain", "unknown"]):
                r = row(name); r.update(status=status, candidate=None, reference=None); records.append(r)
            answer = fn(list(reversed(records)), factory(names))
            self.assertEqual(answer["total_request_count"], 4)
            self.assertEqual([r["id"] for r in answer["results"]], names)
            self.assertEqual(answer["outcome_counts"], {"SUCCEEDED": 1, "RUNTIME_ERROR": 1, "ABSTAINED": 1, "UNKNOWN": 1})
            self.assertTrue(all(r["correct"] is None for r in answer["results"][1:]))
            self.assertIsNone(answer.get("accuracy", answer.get("mean_ndcg")))

    def test_non_success_cannot_carry_a_scored_candidate(self):
        for fn, factory, row in self.cases:
            r = row(); r["status"] = "fail"
            with self.assertRaises(ValueError): fn([r], factory())

    def test_nonfinite_surrogate_and_non_json_policy_rejected(self):
        for fn, factory, row in self.cases:
            for value in (float("nan"), float("inf"), "\ud800", ("tuple",)):
                p = factory(); p["policy_ref"] = value
                with self.subTest(value=repr(value)), self.assertRaises((ValueError, UnicodeError)): fn([row()], p)


class RelationTests(unittest.TestCase):
    def test_correct_incorrect_and_external_loss_not_candidate_claim(self):
        p = relation_policy(["r1", "r2"])
        answer = S.score_semantic_relations([relation_row(), relation_row("r2", "b")], p)
        self.assertEqual(answer["accuracy"], 0.5)
        self.assertEqual(answer["mean_loss"], 2)
        self.assertEqual(answer["confusion_on_scored_requests"]["a"], {"a": 1, "b": 1})
        self.assertEqual(answer["per_class_on_scored_requests"]["a"]["recall"], 0.5)

    def test_missing_gold_keeps_correctness_and_loss_none(self):
        r = relation_row(); r["reference"]["gold_label"] = None
        answer = S.score_semantic_relations([r], relation_policy())
        self.assertTrue(answer["results"][0]["candidate_valid"])
        self.assertIsNone(answer["results"][0]["correct"])
        self.assertIsNone(answer["accuracy"]); self.assertIsNone(answer["mean_loss"])

    def test_missing_reference_or_labelspace_not_assumed_valid(self):
        r = relation_row(); r["reference"] = None
        answer = S.score_semantic_relations([r], relation_policy())
        self.assertIsNone(answer["results"][0]["candidate_valid"])
        p = relation_policy(); p.update(labels=None, loss_matrix=None)
        answer = S.score_semantic_relations([relation_row()], p)
        self.assertIsNone(answer["accuracy"]); self.assertIsNone(answer["confusion_on_scored_requests"])

    def test_unknown_label_forged_ref_or_lost_counterevidence_invalid(self):
        for change in ({"label": "invented"}, {"support_refs": ["forged"]},
                       {"counterevidence_refs": []}, {"counterevidence_refs": ["foreign"]}, {"support_refs": []}):
            r = relation_row(); r["candidate"].update(change)
            answer = S.score_semantic_relations([r], relation_policy())
            self.assertFalse(answer["results"][0]["candidate_valid"])
            self.assertIsNone(answer["accuracy"])

    def test_duplicate_refs_bad_reference_scope_or_bool_loss_rejected(self):
        r = relation_row(); r["candidate"]["support_refs"] *= 2
        with self.assertRaises(ValueError): S.score_semantic_relations([r], relation_policy())
        r = relation_row(); r["reference"]["supporting_refs"] = ["foreign"]
        with self.assertRaises(ValueError): S.score_semantic_relations([r], relation_policy())
        p = relation_policy(); p["loss_matrix"]["a"]["b"] = True
        with self.assertRaises(ValueError): S.score_semantic_relations([relation_row()], p)

    def test_unknown_policy_never_masks_known_invalid_evidence_or_label(self):
        p = relation_policy(); p.update(labels=None, loss_matrix=None)
        r = relation_row(); r["candidate"]["support_refs"] = ["forged"]
        self.assertFalse(S.score_semantic_relations([r], p)["results"][0]["candidate_valid"])
        p = relation_policy(); p["require_support"] = None
        for change in ({"support_refs": ["forged"]}, {"counterevidence_refs": []}):
            r = relation_row(); r["candidate"].update(change)
            self.assertFalse(S.score_semantic_relations([r], p)["results"][0]["candidate_valid"])
        self.assertIsNone(S.score_semantic_relations([relation_row()], p)["results"][0]["candidate_valid"])
        r = relation_row(label="invented"); r["reference"] = None
        self.assertFalse(S.score_semantic_relations([r], relation_policy())["results"][0]["candidate_valid"])


class ContextTests(unittest.TestCase):
    def test_explicit_linear_and_exp2_gains_match_hand_calculation(self):
        r = context_row(); r["candidate"]["ordered_ids"] = ["b", "a"]
        p = context_policy(); answer = S.score_context_relevance([r], p)
        self.assertAlmostEqual(answer["mean_ndcg"], 2.5 / 3.5)
        p["gain_rule"] = "exp2_minus1"; answer = S.score_context_relevance([r], p)
        self.assertAlmostEqual(answer["mean_ndcg"], 4.5 / 7.5)
        self.assertEqual(answer["results"][0]["selected_tokens"], 5)

    def test_no_default_gain_rule_or_rawscore_probability(self):
        for rule in (None, "auto", True):
            p = context_policy(); p["gain_rule"] = rule
            with self.assertRaises(ValueError): S.score_context_relevance([context_row()], p)
        r = context_row(); r["candidate"]["probabilities"] = {"a": 0.9}
        with self.assertRaises(ValueError): S.score_context_relevance([r], context_policy())

    def test_missing_relevance_never_fakes_ndcg_or_creates_downstream_observation(self):
        for ref in (None, {"relevance": None, "downstream_effect": None, "source_ref": None}):
            r = context_row(); r["reference"] = ref
            answer = S.score_context_relevance([r], context_policy())
            self.assertIsNone(answer["mean_ndcg"])
            self.assertIsNone(answer["results"][0]["downstream_effect"])

    def test_independent_downstream_without_relevance_retained_only_for_valid_candidate(self):
        r = context_row(); r["reference"]["relevance"] = None
        r["reference"]["source_ref"] = None
        supplied = copy.deepcopy(r["reference"]["downstream_effect"])
        answer = S.score_context_relevance([r], context_policy())
        self.assertIsNone(answer["mean_ndcg"])
        self.assertEqual(answer["results"][0]["downstream_effect"], supplied)
        self.assertIsNot(answer["results"][0]["downstream_effect"], r["reference"]["downstream_effect"])
        self.assertFalse(answer["reference_provenance_verified"])
        for budget in (None, 1):
            p = context_policy(); p["token_budget"] = budget
            answer = S.score_context_relevance([r], p)
            self.assertIsNone(answer["results"][0]["downstream_effect"])
            self.assertIsNone(answer["mean_ndcg"])
        self.assertEqual(r["reference"]["downstream_effect"], supplied)

    def test_context_set_change_duplicates_and_foreign_reference_rejected(self):
        for ids in (["a"], ["a", "a"]):
            r = context_row(); r["input_context_ids"] = ids
            with self.assertRaises(ValueError): S.score_context_relevance([r], context_policy())
        r = context_row(); r["reference"]["relevance"] = {"a": 1, "other": 3}
        with self.assertRaises(ValueError): S.score_context_relevance([r], context_policy())
        p = context_policy(); p["contexts"].append(copy.deepcopy(p["contexts"][0]))
        with self.assertRaises(ValueError): S.score_context_relevance([context_row()], p)

    def test_order_duplicate_foreign_id_cutoff_and_token_budget(self):
        r = context_row(); r["candidate"]["ordered_ids"] = ["a", "a"]
        with self.assertRaises(ValueError): S.score_context_relevance([r], context_policy())
        for order, budget, cutoff in [(["foreign"], 5, 2), (["a", "b"], 4, 2), (["a", "b"], 5, 1)]:
            p = context_policy(); p.update(token_budget=budget, cutoff=cutoff, discounts=[1] if cutoff == 1 else [1, 0.5])
            r = context_row(); r["candidate"]["ordered_ids"] = order
            answer = S.score_context_relevance([r], p)
            self.assertFalse(answer["results"][0]["candidate_valid"])
            self.assertIsNone(answer["mean_ndcg"])

    def test_unknown_budget_zero_ideal_and_boolean_token_or_rank_values(self):
        p = context_policy(); p["token_budget"] = None
        self.assertIsNone(S.score_context_relevance([context_row()], p)["results"][0]["candidate_valid"])
        r = context_row(); r["reference"]["relevance"] = {"a": 0, "b": 0}
        self.assertIsNone(S.score_context_relevance([r], context_policy())["mean_ndcg"])
        for change in ("tokens", "discount", "relevance", "raw"):
            p, r = context_policy(), context_row()
            if change == "tokens": p["contexts"][0]["tokens"] = True
            elif change == "discount": p["discounts"][0] = True
            elif change == "relevance": r["reference"]["relevance"]["a"] = True
            else: r["candidate"]["raw_scores"]["a"] = True
            with self.assertRaises(ValueError): S.score_context_relevance([r], p)

    def test_gain_overflow_rejected_and_success_has_no_probability_fields(self):
        p = context_policy(); p["gain_rule"] = "exp2_minus1"
        r = context_row(); r["reference"]["relevance"]["a"] = 2000
        with self.assertRaises(ValueError): S.score_context_relevance([r], p)
        answer = S.score_context_relevance([context_row()], context_policy())
        self.assertEqual(answer["results"][0]["raw_score_kind"], "RAW_SCORE_ONLY")
        self.assertNotIn("probability", answer)

    def test_unknown_budget_never_masks_illegal_id_or_cutoff_and_ideal_is_unconstrained(self):
        p = context_policy(); p["token_budget"] = None
        for order in (["foreign"], ["a", "b"]):
            r = context_row(); r["candidate"]["ordered_ids"] = order
            if order == ["a", "b"]: p.update(cutoff=1, discounts=[1])
            self.assertFalse(S.score_context_relevance([r], p)["results"][0]["candidate_valid"])
        p = context_policy(); p["token_budget"] = 2
        r = context_row(); r["candidate"]["ordered_ids"] = ["a"]
        answer = S.score_context_relevance([r], p)
        self.assertEqual(answer["results"][0]["ideal_dcg"], 3.5)
        self.assertIn("unconstrained", answer["ideal_dcg_scope"])


class RouteTests(unittest.TestCase):
    def test_valid_route_agreement_and_loss_from_external_reference(self):
        answer = S.score_processing_routes([route_row()], route_policy())
        self.assertTrue(answer["results"][0]["candidate_valid"])
        self.assertEqual(answer["accuracy"], 1)
        self.assertEqual(answer["mean_loss"], 0)
        self.assertEqual(answer["results"][0]["configured_budget_cost"], 2)

    def test_structurally_valid_route_can_disagree_with_external_allowed_routes(self):
        r = route_row(); r["candidate"] = {"path": ["start", "other"], "actions": []}
        answer = S.score_processing_routes([r], route_policy())
        self.assertTrue(answer["results"][0]["candidate_valid"])
        self.assertEqual(answer["accuracy"], 0); self.assertEqual(answer["mean_loss"], 4)

    def test_no_reference_allowed_routes_or_loss_remains_none(self):
        r = route_row(); r["reference"] = None
        answer = S.score_processing_routes([r], route_policy())
        self.assertIsNone(answer["accuracy"]); self.assertIsNone(answer["mean_loss"])
        r = route_row(); r["reference"]["route_losses"] = None
        self.assertIsNone(S.score_processing_routes([r], route_policy())["mean_loss"])

    def test_illegal_edge_action_wrong_start_or_nonterminal_rejected_locally(self):
        for candidate in ({"path": ["start", "end"], "actions": []},
                          {"path": ["start", "work"], "actions": ["act"]},
                          {"path": ["work", "end"], "actions": ["act"]},
                          {"path": ["start", "work", "end"], "actions": ["unapproved"]},
                          {"path": ["start", "work", "end"], "actions": []},
                          {"path": ["start", "foreign"], "actions": []}):
            r = route_row(); r["candidate"] = candidate
            answer = S.score_processing_routes([r], route_policy())
            self.assertFalse(answer["results"][0]["candidate_valid"])
            self.assertIsNone(answer["accuracy"])

    def test_step_cost_and_unknown_budget_limits(self):
        for key, value in (("max_steps", 2), ("budget", 1)):
            p = route_policy(); p[key] = value
            r = route_row(); r["reference"] = None
            self.assertFalse(S.score_processing_routes([r], p)["results"][0]["candidate_valid"])
        p = route_policy(); p["budget"] = None
        self.assertIsNone(S.score_processing_routes([route_row()], p)["results"][0]["candidate_valid"])

    def test_duplicate_graph_ids_edges_actions_and_invalid_reference_rejected(self):
        for key in ("nodes", "edges", "allowed_action_ids"):
            p = route_policy(); p[key].append(copy.deepcopy(p[key][0]))
            with self.assertRaises(ValueError): S.score_processing_routes([route_row()], p)
        r = route_row(); r["reference"]["allowed_routes"] = [["start", "end"]]
        with self.assertRaises(ValueError): S.score_processing_routes([r], route_policy())

    def test_boolean_budgets_costs_and_terminal_types_not_integers(self):
        for key in ("budget", "max_steps", "cost", "terminal"):
            p = route_policy()
            if key == "cost": p["nodes"][1]["cost"] = True
            elif key == "terminal": p["nodes"][1]["terminal"] = 0
            else: p[key] = True
            with self.assertRaises(ValueError): S.score_processing_routes([route_row()], p)

    def test_graph_cannot_smuggle_unapproved_action_or_continue_after_terminal(self):
        p = route_policy(); p["nodes"][1]["action_id"] = "foreign"
        with self.assertRaises(ValueError): S.score_processing_routes([route_row()], p)

    def test_unknown_budget_never_masks_illegal_edge_action_or_node(self):
        p = route_policy(); p.update(budget=None, max_steps=None)
        for candidate in ({"path": ["start", "end"], "actions": []},
                          {"path": ["start", "foreign"], "actions": []},
                          {"path": ["start", "work", "end"], "actions": ["foreign"]}):
            r = route_row(); r["candidate"] = candidate
            self.assertFalse(S.score_processing_routes([r], p)["results"][0]["candidate_valid"])
        self.assertIsNone(S.score_processing_routes([route_row()], p)["results"][0]["candidate_valid"])
        p = route_policy(); p["edges"].append(["end", "work"])
        with self.assertRaises(ValueError): S.score_processing_routes([route_row()], p)


if __name__ == "__main__":
    unittest.main()
