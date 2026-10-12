"""Existing technical scorer examples only; no Corpus, Gold, model or action."""
import builtins
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import types
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("private_existing_scorer_examples", ROOT / "tests/test_model_workflow_saved_scorers.py")
OLD = importlib.util.module_from_spec(spec); spec.loader.exec_module(OLD)
subject = ROOT / "scripts/model-program/decision_candidate_projection.py"
M = types.ModuleType("private_decision_projection")
namespace = dict(vars(builtins))
def private_import(name, globals=None, locals=None, fromlist=(), level=0):
    if name == "workflow_saved_scorers": return OLD.S
    if name == "validate_m2_scoped_successor":
        # Only the existing pure strict parser is needed, with no shared module mutation.
        path = ROOT / "scripts/model-program/validate_m2_scoped_successor.py"
        loaded = importlib.util.spec_from_file_location("private_decision_parser", path)
        module = importlib.util.module_from_spec(loaded); loaded.loader.exec_module(module)
        return module
    return builtins.__import__(name, globals, locals, fromlist, level)
namespace["__import__"] = private_import
M.__dict__["__builtins__"] = namespace
exec(compile(subject.read_bytes(), str(subject), "exec"), M.__dict__)

def encoded(value):return json.dumps(value, ensure_ascii=False, allow_nan=False).encode()
SCHEMA = encoded({"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"})
RUNTIME = {"saved-success":"SUCCEEDED","saved-timeout":"TIMEOUT","saved-unknown":"UNKNOWN"}
KEYS = {"SUCCEEDED":"ok","ABSTAINED":"abstain","SCHEMA_INVALID":"invalid","UNKNOWN":"unknown","TIMEOUT":"timeout"}
INPUT_SHA = "a" * 64  # Existing technical metadata, not an actual input digest.

def body(value, kind="NONE", distribution=None, calibration=None):
    return {"status":"PREDICTED","value":value,"score_kind":kind,"distribution":distribution,
            "calibration_ref":calibration,"evidence_refs":[],"abstain_reason":None}

def setup(task="decision.semantic_relation"):
    if task == "decision.semantic_relation":
        old, policy = OLD.relation_row(), OLD.relation_policy()
        candidate = body({"relation_id":old["candidate"]["label"],"left_input_ref":"a","right_input_ref":"b",
            "support_refs":old["candidate"]["support_refs"],"counterevidence_refs":old["candidate"]["counterevidence_refs"]})
        supplied = {"visible_evidence_refs":old["reference"]["available_refs"],"left_input_ref":"a","right_input_ref":"b"}
    elif task == "decision.context_relevance":
        old, policy = OLD.context_row(), OLD.context_policy()
        candidate = body({"ranking":[{"context_ref":k,"score":old["candidate"]["raw_scores"][k]} for k in old["candidate"]["ordered_ids"]],
            "unranked_context_refs":[]}, "RAW_SCORE")
        supplied = {"visible_evidence_refs":[],"context_ids":old["input_context_ids"]}
    else:
        policy = OLD.route_policy()
        old = {"reference":{"allowed_routes":[["start","work","end"]],"route_losses":None,"source_ref":"technical-example:reference"}}
        candidate = body({"route_ref":"a","support_refs":[],"counterevidence_refs":[]})
        supplied = {"visible_evidence_refs":[],"route_catalog":{"a":["start","work","end"]}}
    policy["status_categories"].update(invalid="SCHEMA_INVALID",timeout="TIMEOUT")
    raw = encoded(candidate)
    snapshot = [{"id":"r1","input_sha256":INPUT_SHA,"raw_output":raw,"terminal_status":"saved-success",
                 "usage":None,"split_id":"technical-example:development"}]
    bindings = [{"id":"r1","input_sha256":INPUT_SHA,"output_schema_digest":"sha256:"+OLD.S.digest(json.loads(SCHEMA)),
                 "task_input":supplied,"scoring_reference":old["reference"]}]
    return snapshot, bindings, policy, candidate

def project(s,b,p,task="decision.semantic_relation",**extra):
    args = dict(task_key=task,payload_schema_raw=SCHEMA,payload_schema_sha256=hashlib.sha256(SCHEMA).hexdigest(),
        runtime_status_categories=RUNTIME,scoring_category_keys=KEYS)
    args.update(extra)
    return M.project_decision_snapshot(s,b,p,**args)

class DecisionCandidateProjectionTests(unittest.TestCase):
    def test_all_three_actual_scorer_paths_and_inputs_unchanged(self):
        for task in M.TASKS:
            s,b,p,_=setup(task);before=copy.deepcopy((s,b,p))
            got=project(s,b,p,task)
            self.assertTrue(got["scorer_report"]["results"][0]["candidate_valid"])
            self.assertEqual((s,b,p),before)
            self.assertIs(got["slots"][0]["raw_output"],s[0]["raw_output"])
            self.assertEqual(got["qualification"],"NOT_ISSUED")
            self.assertFalse(got["domain_adoption_verified"])

    def test_semantic_abstention_stays_distinct_from_actual_timeout(self):
        s,b,p,_=setup();raw=encoded({"status":"ABSTAINED","value":None,"score_kind":"NONE","distribution":None,
            "calibration_ref":None,"evidence_refs":[],"abstain_reason":"INSUFFICIENT_EVIDENCE"})
        s[0]["raw_output"]=raw
        got=project(s,b,p)
        self.assertEqual(got["scorer_records"][0]["status"],"abstain")
        self.assertEqual(got["slots"][0]["original_provider_status"],"saved-success")
        s[0]["terminal_status"]="saved-timeout"
        got=project(s,b,p)
        self.assertEqual(got["scorer_records"][0]["status"],"timeout")
        self.assertIsNone(got["slots"][0]["decision_payload"])
        self.assertEqual(got["slots"][0]["raw_output"],raw)

    def test_relation_pair_evidence_and_required_counterevidence(self):
        for fault in ("pair","support","counter"):
            s,b,p,c=setup()
            if fault=="pair":c["value"]["left_input_ref"]="foreign"
            elif fault=="support":c["value"]["support_refs"]=["foreign"]
            else:c["value"]["counterevidence_refs"]=[]
            s[0]["raw_output"]=encoded(c);got=project(s,b,p)
            self.assertFalse(got["scorer_report"]["results"][0]["candidate_valid"])
            self.assertEqual(got["slots"][0]["raw_output"],s[0]["raw_output"])

    def test_context_partition_duplicate_unknown_score_kind_and_budget(self):
        task="decision.context_relevance"
        for fault in ("duplicate","unknown","partition","score_kind","budget"):
            s,b,p,c=setup(task)
            if fault=="duplicate":c["value"]["ranking"][1]["context_ref"]="a"
            elif fault=="unknown":c["value"]["ranking"][1]["context_ref"]="foreign"
            elif fault=="partition":c["value"]["unranked_context_refs"]=["a"]
            elif fault=="score_kind":c["score_kind"]="NONE"
            else:p["token_budget"]=1
            s[0]["raw_output"]=encoded(c)
            self.assertFalse(project(s,b,p,task)["scorer_report"]["results"][0]["candidate_valid"])

    def test_route_is_resolved_from_code_and_never_model_supplied_actions(self):
        task="decision.processing_route";s,b,p,c=setup(task)
        got=project(s,b,p,task)
        self.assertEqual(got["scorer_records"][0]["candidate"]["actions"],["act"])
        for fault in ("unknown","action_injection","illegal_edge"):
            s,b,p,c=setup(task)
            if fault=="unknown":c["value"]["route_ref"]="foreign"
            elif fault=="action_injection":c["value"]["actions"]=["foreign"]
            else:b[0]["task_input"]["route_catalog"]["a"]=["start","end"]
            s[0]["raw_output"]=encoded(c)
            self.assertFalse(project(s,b,p,task)["scorer_report"]["results"][0]["candidate_valid"])

    def test_malformed_duplicate_utf8_nonfinite_and_self_grading_preserve_raw(self):
        for raw in (b"\xff",b'{"status":"PREDICTED","status":"ABSTAINED"}',b'{"confidence":NaN}',b'{}'):
            s,b,p,_=setup();s[0]["raw_output"]=raw
            got=project(s,b,p)
            self.assertEqual(got["scorer_records"][0]["status"],"invalid")
            self.assertEqual(got["slots"][0]["raw_sha256"],hashlib.sha256(raw).hexdigest())
        s,b,p,c=setup();c["correct"]=True;s[0]["raw_output"]=encoded(c)
        self.assertEqual(project(s,b,p)["scorer_records"][0]["status"],"invalid")

    def test_missing_external_truth_usage_and_probability_are_not_zero(self):
        s,b,p,_=setup();b[0]["scoring_reference"]=None
        got=project(s,b,p)
        self.assertIsNone(got["scorer_report"]["accuracy"])
        self.assertIsNone(got["slots"][0]["usage"])
        self.assertIsNone(got["slots"][0]["score_claims"]["distribution"])

    def test_probability_shape_and_calibration_claim_never_create_auto_rights(self):
        contract={"labels":["a","b"],"sum_tolerance":0.001,"estimation_object_ref":"technical-example:class-estimate"}
        s,b,p,c=setup();c.update(score_kind="CALIBRATED_PROBABILITY",distribution={"a":0.7,"b":0.3},calibration_ref="claimed:calibration")
        s[0]["raw_output"]=encoded(c);got=project(s,b,p,probability_contract=contract)
        self.assertFalse(got["probability_auto_path_admitted"])
        self.assertFalse(got["slots"][0]["score_claims"]["calibration_provenance_verified"])
        self.assertIn("CALIBRATION_PROVENANCE_NOT_VERIFIED",got["slots"][0]["gaps"])
        for bad in ({"a":0.7},{"a":0.7,"b":0.9},{"a":True,"b":0.3}):
            c["distribution"]=bad;s[0]["raw_output"]=encoded(c)
            self.assertEqual(project(s,b,p,probability_contract=contract)["scorer_records"][0]["status"],"invalid")
        c["distribution"]={"a":0.7,"b":0.3};s[0]["raw_output"]=encoded(c)
        self.assertEqual(project(s,b,p)["scorer_records"][0]["status"],"unknown")

    def test_exact_snapshot_set_bindings_hashes_and_caller_errors_not_model_mistakes(self):
        for fault in ("missing","duplicate","hash","schema_identity","context_policy"):
            task="decision.context_relevance" if fault=="context_policy" else "decision.semantic_relation"
            s,b,p,_=setup(task);before=copy.deepcopy(s)
            if fault=="missing":b=[]
            elif fault=="duplicate":s.append(copy.deepcopy(s[0]));before=copy.deepcopy(s)
            elif fault=="hash":b[0]["input_sha256"]="b"*64
            elif fault=="schema_identity":b[0]["output_schema_digest"]="sha256:"+"b"*64
            else:b[0]["task_input"]["context_ids"]=["a"]
            with self.assertRaises(ValueError):project(s,b,p,task)
            self.assertEqual(s,before)

    def test_all_expected_slots_include_failed_and_unknown_requests(self):
        s,b,p,_=setup();p["expected_request_ids"]=["r1","r2","r3"]
        for key,status in (("r2","saved-timeout"),("r3","missing-provider-status")):
            s.append({**s[0],"id":key,"terminal_status":status,"raw_output":None})
            b.append({**copy.deepcopy(b[0]),"id":key})
        got=project(s,b,p)
        self.assertEqual(got["scorer_report"]["total_request_count"],3)
        self.assertEqual(got["scorer_report"]["outcome_counts"],{"SUCCEEDED":1,"TIMEOUT":1,"UNKNOWN":1})
        self.assertIsNone(got["scorer_report"]["accuracy"])

    def test_schema_pin_remote_reference_and_status_mapping_fail_closed(self):
        s,b,p,_=setup()
        with self.assertRaises(ValueError):project(s,b,p,payload_schema_sha256="f"*64)
        remote=encoded({"$ref":"https://invalid.example/schema"})
        b[0]["output_schema_digest"]="sha256:"+OLD.S.digest(json.loads(remote))
        got=project(s,b,p,payload_schema_raw=remote,payload_schema_sha256=hashlib.sha256(remote).hexdigest())
        self.assertEqual(got["scorer_records"][0]["status"],"invalid")
        with self.assertRaises(ValueError):project(s,b,p,scoring_category_keys={})

    def test_payload_bound_and_abstention_cannot_hide_business_value(self):
        s,b,p,_=setup();s[0]["raw_output"]=b" "*(M.MAX_RAW+1)
        self.assertEqual(project(s,b,p)["scorer_records"][0]["status"],"invalid")
        s,b,p,c=setup();c["status"]="ABSTAINED";c["abstain_reason"]="missing";s[0]["raw_output"]=encoded(c)
        self.assertEqual(project(s,b,p)["scorer_records"][0]["status"],"invalid")

if __name__=="__main__":unittest.main()
