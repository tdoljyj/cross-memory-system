"""Real-library repository integration regression, no model/data generation."""
from concurrent.futures import ThreadPoolExecutor
import ast
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/model-program/validate_m2_scoped_successor.py"
SPEC = importlib.util.spec_from_file_location("m2_scoped_test_subject", SCRIPT)
S = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(S)
FIXTURES = ROOT / S.FIXTURE_RELATIVE

def read(path):
    return S.strict_json(path.read_bytes())

def old_envelope(consumer, payload):
    return {"schema_version": S.SCHEMA, "version": "v0.1", "consumer": consumer, "payload": payload}

def stage_request(split):
    purpose = split["purpose_id"]
    fixed = copy.deepcopy(split["fixed_candidate_binding"])
    if purpose in ("qualification", "final_holdout"):
        fixed.update(candidate_role="M2_REFERENCE_BASELINE" if purpose == "qualification" else "FINAL_PRODUCT_CANDIDATE",
            source_stage="M1_FIXED_REFERENCE" if purpose == "qualification" else "M4",
            candidate_frozen_at="2026-10-07T00:02:00.000001Z", samples_materialized_at="2026-10-07T00:02:00.000002Z")
    pool = None
    if purpose in ("selection_policy_validation", "final_holdout"):
        pool = {"manifest_sha256": "b"*64, "near_duplicate_groups_sha256": "c"*64, "sampling_policy_sha256": "d"*64,
            "size_statistical_basis_ref": "DECLARED_UNIT_BASIS", "custody_ref": "DECLARED_UNIT_CUSTODY",
            "access_isolation_ref": "DECLARED_UNIT_ACCESS", "freeze_evidence_ref": "DECLARED_NOT_ACTUAL_FREEZE",
            "freeze_at": "2026-10-07T00:00:00Z", "first_selection_feedback_at": "2026-10-07T00:01:00Z"}
    return {"schema": "clued.model-program.m2-stage-binding-request/1", "status": "PREPARATION_ONLY",
        "original_source_commit": "e76a7db7edc6b47b5a719e165f688621efa9580a", "purpose_id": purpose,
        "parent_boundary": split["parent_boundary"], "use_key": {"training":"weight_learning", "development":"prompt_or_architecture_tuning",
        "calibration_fit":"calibration_fit", "selection_policy_validation":"selection", "qualification":None, "final_holdout":None}[purpose],
        "stage_id": "M2" if purpose in ("qualification", "calibration_fit", "selection_policy_validation") else "M4" if purpose=="final_holdout" else "T1",
        "report_consumer": {"training":"TRAINING_ENGINEERING_PREPARATION", "development":"DEVELOPMENT_ENGINEERING_PREPARATION",
        "calibration_fit":"CALIBRATION_PREPARATION", "selection_policy_validation":"M3_SELECTION_PREPARATION",
        "qualification":"M2_DATA_GATE_PREPARATION", "final_holdout":"PRODUCT_FINAL_QUALIFICATION_PREPARATION"}[purpose],
        "fixed_candidate_binding":fixed, "reserved_source_pool":pool, "experiment_profile_ref":None,
        "data_permission_ref":None, "domain_authority_receipt_ref":None}

def single_scope(bundle, purpose, consumer):
    payload = copy.deepcopy(bundle)
    manifest = payload["manifest"]
    split = next(row for row in manifest["splits"] if row["purpose_id"] == purpose)
    manifest["splits"] = [split]
    manifest["samples"] = [row for row in manifest["samples"] if row["split_id"] == split["split_id"]]
    payload["selection_reports"] = [row for row in payload["selection_reports"] if row["split_id"] == split["split_id"]]
    digest = S.VerificationContext().module("validate_m2_dataset_foundation").digest
    manifest["manifest_revision_sha256"] = digest({k:v for k,v in manifest.items() if k != "manifest_revision_sha256"})
    for report in payload["selection_reports"]:
        report["manifest_revision_sha256"] = manifest["manifest_revision_sha256"]
    scope = split["experiment_scope"]
    return {"schema_version":S.SCHEMA, "version":"v0.2", "consumer":consumer,
        "payload":split if consumer == "dataset_split" else payload, "owner_rule":dict(S.OWNER_RULE),
        "preparation_contract_sha256":S.PREPARATION_SHA, "scope_id":scope,
        "stage_bindings":{split["split_id"]:{"scope_id":scope, "request":stage_request(split)}}}

def bundle(formal=False):
    return read(FIXTURES / "tests/fixtures/model-program-m2" / ("owner-adopted-foundation.json" if formal else "synthetic-foundation.json"))

class ScopedConsumerIntegration(unittest.TestCase):
    def test_real_schema_library_rejects_bool_integer(self):
        from jsonschema import Draft202012Validator, ValidationError
        with self.assertRaises(ValidationError):Draft202012Validator({"type":"integer"}).validate(True)

    def test_full_original_definition_and_schema_derivation(self):
        ctx=S.VerificationContext()
        reference, definition = ctx.module("validate_m2_dataset_split").validate_domain_candidate()
        adopted, formal, schema, manifest = ctx.module("validate_m2_adopted_definition").validate_baseline()
        self.assertEqual(formal["version"],"v0.1");self.assertIsNone(adopted["domain_authority_receipt_ref"])

    def test_full_original_frozen_synthetic_fixture(self):
        result=S.VerificationContext().module("validate_m2_dataset_foundation").validate_bundle(bundle())
        self.assertEqual(result["status"],"PASS_SYNTHETIC_OFFLINE_CHECKS_ONLY");self.assertEqual(result["m2_verdict"],"NOT_ISSUED")

    def test_full_original_frozen_adopted_fixture(self):
        result=S.VerificationContext().module("validate_m2_adopted_definition").validate_adopted_bundle(bundle(True))
        self.assertEqual(result["definition_version"],"v0.1");self.assertEqual(result["domain_authority_receipt"],"NOT_ISSUED")

    def test_v01_dispatch_both_full_fixtures_unmodified(self):
        for consumer,formal in (("dataset_foundation",False),("adopted_definition",True)):
            payload=bundle(formal);before=copy.deepcopy(payload)
            result=S.validate_envelope(old_envelope(consumer,payload),consumer)
            self.assertEqual(payload,before);self.assertFalse(result["execution_ready"])

    def test_v02_six_purposes_both_complete_legacy_guard_paths(self):
        for consumer,formal in (("dataset_foundation",False),("adopted_definition",True)):
            payload=bundle(formal)
            for split in payload["manifest"]["splits"]:
                with self.subTest(consumer=consumer,purpose=split["purpose_id"]):
                    result=S.validate_envelope(single_scope(payload,split["purpose_id"],consumer),consumer)
                    self.assertEqual(result["m2_verdict"],"NOT_ISSUED");self.assertFalse(result["actual_pool_freeze_verified"])

    def test_standalone_split_schema_and_binding(self):
        result=S.validate_envelope(single_scope(bundle(),"qualification","dataset_split"),"dataset_split")
        self.assertEqual(result["actual_execution"],"NONE")

    def test_frozen_mapping_regression(self):
        payload=read(FIXTURES/"development/contracts/model-program/m2/DatasetSplitMapping.candidate.json")
        S.validate_envelope(old_envelope("split_mapping",payload),"split_mapping")
        payload["mappings"][0]["candidate_parent_boundary"]="DEVELOPMENT"
        with self.assertRaises(ValueError):S.validate_envelope(old_envelope("split_mapping",payload),"split_mapping")

    def test_m2_reference_cannot_use_product_role(self):
        env=single_scope(bundle(True),"qualification","adopted_definition")
        next(iter(env["stage_bindings"].values()))["request"]["fixed_candidate_binding"]["candidate_role"]="FINAL_PRODUCT_CANDIDATE"
        with self.assertRaises(ValueError):S.validate_envelope(env,"adopted_definition")

    def test_product_holdout_cannot_use_reference_stage(self):
        env=single_scope(bundle(True),"final_holdout","adopted_definition")
        next(iter(env["stage_bindings"].values()))["request"]["fixed_candidate_binding"]["source_stage"]="M1_FIXED_REFERENCE"
        with self.assertRaises(ValueError):S.validate_envelope(env,"adopted_definition")

    def test_weights_cannot_hide_in_development(self):
        env=single_scope(bundle(),"development","dataset_split");env["payload"]["allowed_uses"]["weight_learning"]=True
        with self.assertRaisesRegex(ValueError,"USE_CROSS_BINDING"):S.validate_envelope(env,"dataset_split")

    def test_qualification_parent_relabel_rejected(self):
        env=single_scope(bundle(),"qualification","dataset_split");env["payload"]["parent_boundary"]="DEVELOPMENT"
        with self.assertRaisesRegex(ValueError,"PURPOSE_OR_PARENT"):S.validate_envelope(env,"dataset_split")

    def test_holdout_result_cannot_flow_to_selection(self):
        env=single_scope(bundle(True),"final_holdout","adopted_definition")
        next(iter(env["stage_bindings"].values()))["request"]["report_consumer"]="M3_SELECTION_PREPARATION"
        with self.assertRaises(ValueError):S.validate_envelope(env,"adopted_definition")

    def test_real_schema_unknown_field_rejected(self):
        payload=bundle();payload["manifest"]["splits"][0]["caller_authority"]=True
        with self.assertRaises(ValueError):S.validate_envelope(old_envelope("dataset_foundation",payload),"dataset_foundation")

    def test_withdrawn_source_rejected(self):
        payload=bundle();payload["registry"]["sources"][0]["withdrawn"]=True
        with self.assertRaisesRegex(ValueError,"PRIVACY_OR_WITHDRAWAL"):
            S.validate_envelope(old_envelope("dataset_foundation",payload),"dataset_foundation")

    def test_real_cross_partition_near_duplicate_rejected(self):
        payload=bundle();a=payload["manifest"]["samples"][0]
        b=next(row for row in payload["manifest"]["samples"] if row["split_id"]!=a["split_id"])
        key=next(k for k in a["isolation_groups"] if "near" in k);b["isolation_groups"][key]=a["isolation_groups"][key]
        digest=S.VerificationContext().module("validate_m2_dataset_foundation").digest
        payload["manifest"]["manifest_revision_sha256"]=digest({k:v for k,v in payload["manifest"].items() if k!="manifest_revision_sha256"})
        for report in payload["selection_reports"]:report["manifest_revision_sha256"]=payload["manifest"]["manifest_revision_sha256"]
        with self.assertRaisesRegex(ValueError,"CROSS_SPLIT_GROUP"):
            S.validate_envelope(old_envelope("dataset_foundation",payload),"dataset_foundation")

    def test_qualification_exposure_rejected(self):
        env=single_scope(bundle(),"qualification","dataset_split")
        env["payload"]["exposure_records"]=[{"event_id":"exposure1","consumer_id":"selection","purpose_description":"资格",
            "used_for_selection":True,"source_revision":"public-fixture-revision"}]
        with self.assertRaisesRegex(ValueError,"EXPOSED"):S.validate_envelope(env,"dataset_split")

    def test_pool_scope_and_time_order_rejected(self):
        env=single_scope(bundle(True),"final_holdout","adopted_definition");binding=next(iter(env["stage_bindings"].values()))
        binding["scope_id"]="another_scope"
        with self.assertRaisesRegex(ValueError,"SCOPE_MISMATCH"):S.validate_envelope(env,"adopted_definition")
        binding["scope_id"]=env["scope_id"];binding["request"]["reserved_source_pool"]["freeze_at"]="2026-10-07T00:01:00.000001Z"
        with self.assertRaises(ValueError):S.validate_envelope(env,"adopted_definition")

    def test_equal_candidate_materialization_time_rejected(self):
        env=single_scope(bundle(),"qualification","dataset_split");fixed=next(iter(env["stage_bindings"].values()))["request"]["fixed_candidate_binding"]
        fixed["samples_materialized_at"]=fixed["candidate_frozen_at"]
        with self.assertRaises(ValueError):S.validate_envelope(env,"dataset_split")

    def test_unknown_version_and_fields_no_fallback(self):
        env=old_envelope("dataset_foundation",bundle());env["version"]="v0.3"
        with self.assertRaisesRegex(ValueError,"UNKNOWN_VERSION"):S.validate_envelope(env,"dataset_foundation")
        env["version"]="v0.1";env["caller_permission"]=True
        with self.assertRaises(ValueError):S.validate_envelope(env,"dataset_foundation")

    def test_live_requirements_reject_before_context_creation(self):
        for flag in ("require_domain_authority","require_live_currentness"):
            with self.assertRaisesRegex(ValueError,"CAPABILITY_UNAVAILABLE"):
                S.validate_envelope({},"adopted_definition",repo_root=Path("definitely_missing"),**{flag:True})

    def test_contract_unknown_permission_field_rejected(self):
        ctx=S.VerificationContext();ctx.contract["issuer"]=True
        with self.assertRaises(ValueError):ctx.validate_contract()

    def test_duplicate_nonfinite_json_rejected(self):
        for raw in (b'{"version":1,"version":2}',b'{"value":NaN}'):
            with self.assertRaises(ValueError):S.strict_json(raw)

    def test_request_local_modules_no_process_global_mutation(self):
        names=("validate_m2_dataset_foundation","validate_m2_split_mapping","validate_m2_dataset_split","validate_m2_adopted_definition")
        before={name:sys.modules.get(name) for name in names};path_before=list(sys.path)
        a,b=S.VerificationContext(),S.VerificationContext()
        first=a.module(names[0]);second=b.module(names[0]);self.assertIsNot(first,second)
        self.assertIsNot(first.__dict__,second.__dict__)
        first.test_only_marker="request1";self.assertFalse(hasattr(second,"test_only_marker"))
        a.legacy_validate("dataset_foundation",bundle());b.legacy_validate("adopted_definition",bundle(True))
        self.assertEqual(sys.path,path_before);self.assertEqual({name:sys.modules.get(name) for name in names},before)

    def test_concurrent_requests_do_not_cross_bind_modules_or_scope(self):
        envs=[single_scope(bundle(bool(i%2)),"qualification","adopted_definition" if i%2 else "dataset_foundation") for i in range(8)]
        def check(env):return S.validate_envelope(env,env["consumer"])
        with ThreadPoolExecutor(max_workers=4) as pool:results=list(pool.map(check,envs))
        self.assertEqual(len(results),8);self.assertTrue(all(r["authority_effect"]=="NONE" for r in results))

    def test_real_import_resolver_cycle_fails_closed_without_global_entries(self):
        class CyclicContext(S.VerificationContext):
            def _compile(self,name,path,raw):
                if name=="validate_m2_dataset_foundation":return self.module("validate_m2_split_mapping")
                if name=="validate_m2_split_mapping":return self.module("validate_m2_dataset_foundation")
                return super()._compile(name,path,raw)
        ctx=CyclicContext()
        before={n:sys.modules.get(n) for n in ctx.paths}
        with self.assertRaisesRegex(ValueError,"LEGACY_IMPORT_CYCLE"):
            ctx.module("validate_m2_dataset_foundation")
        self.assertFalse(ctx.loading);self.assertFalse(ctx.modules)
        self.assertEqual(before,{n:sys.modules.get(n) for n in ctx.paths})

    def test_pinned_source_has_no_implicit_dataclass_global_registration(self):
        ctx=S.VerificationContext()
        for name in ctx.paths:
            tree=ast.parse(ctx.sources["scripts/model-program/"+name+".py"])
            self.assertFalse(any(isinstance(node,ast.ImportFrom) and node.module=="dataclasses" for node in ast.walk(tree)))
            self.assertFalse(any(isinstance(node,ast.Import) and any(alias.name=="dataclasses" for alias in node.names) for node in ast.walk(tree)))

    def test_relocated_repo_relative_materials(self):
        with tempfile.TemporaryDirectory() as temporary:
            temporary_root=Path(temporary).resolve()
            self.assertTrue(temporary_root.is_relative_to(Path(tempfile.gettempdir()).resolve()))
            relocated=temporary_root/"another-repo"
            for relative in (S.FIXTURE_RELATIVE,S.CONTRACT_RELATIVE):shutil.copytree(ROOT/relative,relocated/relative)
            script=relocated/"scripts/model-program/prepare_m2_stage_binding.py";script.parent.mkdir(parents=True)
            shutil.copyfile(ROOT/"scripts/model-program/prepare_m2_stage_binding.py",script)
            prep="development/contracts/model-program/stage-admission/M2StageBindingPreparation.v0.1.json"
            shutil.copyfile(ROOT/prep,relocated/prep)
            result=S.validate_envelope(old_envelope("adopted_definition",bundle(True)),"adopted_definition",repo_root=relocated)
            self.assertEqual(result["m2_verdict"],"NOT_ISSUED")
            self.assertTrue(relocated.resolve().is_relative_to(temporary_root))

def load_tests(loader, tests, pattern):
    """Append metric specifications to the existing source-fixture CI suite."""
    path = ROOT / "tests/test_model_program_m2_saved_output_metrics.py"
    spec = importlib.util.spec_from_file_location("m2_metric_specifications", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    tests.addTests(loader.loadTestsFromModule(module, pattern=pattern))
    replay_path = ROOT / "tests/test_model_program_m2_saved_report_runner.py"
    replay_spec = importlib.util.spec_from_file_location("m2_saved_report_specifications", replay_path)
    replay_module = importlib.util.module_from_spec(replay_spec)
    replay_spec.loader.exec_module(replay_module)
    tests.addTests(loader.loadTestsFromModule(replay_module, pattern=pattern))
    harness_path = ROOT / "tests/test_model_program_m2_saved_harness.py"
    harness_spec = importlib.util.spec_from_file_location("m2_saved_harness_specifications", harness_path)
    harness_module = importlib.util.module_from_spec(harness_spec)
    harness_spec.loader.exec_module(harness_module)
    tests.addTests(loader.loadTestsFromModule(harness_module, pattern=pattern))
    core_path = ROOT / "tests/test_model_program_m2_core_saved_adapter.py"
    core_spec = importlib.util.spec_from_file_location("m2_core_saved_adapter_specifications", core_path)
    core_module = importlib.util.module_from_spec(core_spec)
    core_spec.loader.exec_module(core_module)
    tests.addTests(loader.loadTestsFromModule(core_module, pattern=pattern))
    input_path = ROOT / "tests/test_model_program_m2_input_generator.py"
    input_spec = importlib.util.spec_from_file_location("m2_input_generator_specifications", input_path)
    input_module = importlib.util.module_from_spec(input_spec)
    input_spec.loader.exec_module(input_module)
    tests.addTests(loader.loadTestsFromModule(input_module, pattern=pattern))
    request_path = ROOT / "tests/test_model_program_development_invocation_projection.py"
    request_spec = importlib.util.spec_from_file_location("m2_development_invocation_specifications", request_path)
    request_module = importlib.util.module_from_spec(request_spec)
    request_spec.loader.exec_module(request_module)
    tests.addTests(loader.loadTestsFromModule(request_module, pattern=pattern))
    saved_path = ROOT / "tests/test_model_program_invocation_saved_projection.py"
    saved_spec = importlib.util.spec_from_file_location("m2_invocation_saved_specifications", saved_path)
    saved_module = importlib.util.module_from_spec(saved_spec)
    saved_spec.loader.exec_module(saved_module)
    tests.addTests(loader.loadTestsFromModule(saved_module, pattern=pattern))
    completion_path = ROOT / "tests/test_model_local_completion_execution.py"
    completion_spec = importlib.util.spec_from_file_location("m2_local_completion_specifications", completion_path)
    completion_module = importlib.util.module_from_spec(completion_spec)
    completion_spec.loader.exec_module(completion_module)
    tests.addTests(loader.loadTestsFromModule(completion_module, pattern=pattern))
    response_path = ROOT / "tests/test_model_completion_saved_response.py"
    response_spec = importlib.util.spec_from_file_location("m2_completion_response_specifications", response_path)
    response_module = importlib.util.module_from_spec(response_spec)
    response_spec.loader.exec_module(response_module)
    tests.addTests(loader.loadTestsFromModule(response_module, pattern=pattern))
    workflow_path = ROOT / "tests/test_model_workflow_saved_scorers.py"
    workflow_spec = importlib.util.spec_from_file_location("m2_workflow_scorer_specifications", workflow_path)
    workflow_module = importlib.util.module_from_spec(workflow_spec)
    workflow_spec.loader.exec_module(workflow_module)
    tests.addTests(loader.loadTestsFromModule(workflow_module, pattern=pattern))
    records_path = ROOT / "tests/test_model_completion_v2_records.py"
    records_spec = importlib.util.spec_from_file_location("m2_completion_v2_specifications", records_path)
    records_module = importlib.util.module_from_spec(records_spec)
    records_spec.loader.exec_module(records_module)
    tests.addTests(loader.loadTestsFromModule(records_module, pattern=pattern))
    observed_path = ROOT / "tests/test_model_observed_completion_execution.py"
    observed_spec = importlib.util.spec_from_file_location("m2_observed_completion_specifications", observed_path)
    observed_module = importlib.util.module_from_spec(observed_spec)
    observed_spec.loader.exec_module(observed_module)
    tests.addTests(loader.loadTestsFromModule(observed_module, pattern=pattern))
    token_path = ROOT / "tests/test_model_runtime_observation_records.py"
    token_spec = importlib.util.spec_from_file_location("m2_runtime_observation_specifications", token_path)
    token_module = importlib.util.module_from_spec(token_spec)
    token_spec.loader.exec_module(token_module)
    tests.addTests(loader.loadTestsFromModule(token_module, pattern=pattern))
    observed_response_path = ROOT / "tests/test_model_observed_completion_response.py"
    observed_response_spec = importlib.util.spec_from_file_location("m2_observed_response_specifications", observed_response_path)
    observed_response_module = importlib.util.module_from_spec(observed_response_spec)
    observed_response_spec.loader.exec_module(observed_response_module)
    tests.addTests(loader.loadTestsFromModule(observed_response_module, pattern=pattern))
    decision_path = ROOT / "tests/test_model_decision_candidate_projection.py"
    decision_spec = importlib.util.spec_from_file_location("m2_decision_projection_specifications", decision_path)
    decision_module = importlib.util.module_from_spec(decision_spec)
    decision_spec.loader.exec_module(decision_module)
    tests.addTests(loader.loadTestsFromModule(decision_module, pattern=pattern))
    domain_path = ROOT / "tests/test_model_workflow_domain_contract.py"
    domain_spec = importlib.util.spec_from_file_location("m2_workflow_domain_specifications", domain_path)
    domain_module = importlib.util.module_from_spec(domain_spec)
    domain_spec.loader.exec_module(domain_module)
    tests.addTests(loader.loadTestsFromModule(domain_module, pattern=pattern))
    timing_path = ROOT / "tests/test_model_provider_timing_saved_projection.py"
    timing_spec = importlib.util.spec_from_file_location("m2_provider_timing_specifications", timing_path)
    timing_module = importlib.util.module_from_spec(timing_spec)
    timing_spec.loader.exec_module(timing_module)
    tests.addTests(loader.loadTestsFromModule(timing_module, pattern=pattern))
    return tests


if __name__=="__main__":unittest.main()
