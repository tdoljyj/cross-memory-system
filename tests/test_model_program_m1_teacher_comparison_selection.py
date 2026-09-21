import copy
import importlib.util
import json
import pathlib
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
VALIDATOR_PATH = ROOT / "scripts/model-program/validate_m1_teacher_comparison_selection.py"
MATRIX_PATH = ROOT / (
    "development/contracts/model-program/m1/registries/"
    "TeacherComparisonSelectionMatrix.v1.0.2.json"
)
SPEC = importlib.util.spec_from_file_location("m1_09_validator", VALIDATOR_PATH)
VALIDATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VALIDATOR)


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def fixture_sources():
    variants = VALIDATOR.EXPECTED_VARIANTS
    return {
        "device_matrix": {
            "schema_version": "clued.model-m1-device-runtime-matrix/2",
            "task_id": "M1-00",
            "first_tranche_runtime": "llama.cpp",
            "physical_device_profiles": [
                {"binding_state": "EXACT_BOUND", "device_name": "DESK-W-591"},
                {"binding_state": "TO_BE_BOUND", "device_name": "MOBILE"},
            ],
        },
        "stage_entry": {
            "schema_version": "clued.model-m1-stage-entry-authorization/1",
            "record_id": "CLUED-MODEL-M1-STAGE-ENTRY-v1.0.3-20260921",
            "tasks": {"M1-09": "形成教师 / 对照选择矩阵；静态证据"},
            "m1_06_progressive_acceptance": {
                "M1-06A": {"current_status": "CLOSED_SUCCESS", "accepted_device_names": ["DESK-W-591"]},
                "M1-06B": {"current_status": "DEFERRED_NO_BOUND_DEVICE", "coverage_claim": "NONE", "global_m1_blocking": False},
                "M1-06C": {"current_status": "DEFERRED_NO_BOUND_DEVICE", "coverage_claim": "NONE", "global_m1_blocking": False},
            },
            "progression_policy": {
                "m1_09": {
                    "device_baseline_gate_satisfied": True,
                    "deferred_platform_completion_required_for_global_finalization": False,
                    "exact_experiment_profile_required_for_any_new_provider_call_or_benchmark": True,
                }
            },
            "independent_review": {
                "task": "M1-10",
                "required": True,
                "mode": ["FRESH_CONTEXT", "READ_ONLY", "REVIEWER_NOT_MODIFIER"],
            },
            "m1_hard_boundaries": {"training": False, "distillation": False, "production": False},
        },
        "shortlist": {
            "first_tranche": {
                "model_id": "Qwen/Qwen3.5-0.8B",
                "revision": "2fc06364715b967f1860aea9cf38778875588b17",
            },
            "roles": [{"role": role} for role in VALIDATOR.EXPECTED_ROLES],
        },
        "license_review": {
            "model_reviews": [
                {
                    "id": "Qwen/Qwen3.5-0.8B",
                    "internal_m1_reference": "PROVISIONALLY_COMPATIBLE",
                    "training_or_distillation_authority": "NOT_ISSUED",
                },
                {
                    "id": "Strong Hosted / Enterprise Reference",
                    "internal_m1_reference": "BLOCKED_PENDING_PROVIDER_TERMS_DATA_RETENTION_BENCHMARK_AND_MODEL_DEVELOPMENT_USE_REVIEW",
                },
            ],
            "runtime_reviews": [
                {
                    "id": "llama.cpp",
                    "release_tag": VALIDATOR.LLAMA_RELEASE_TAG,
                    "revision": VALIDATOR.LLAMA_COMMIT,
                    "license": "MIT",
                    "selected_runtime_binding": {
                        "path": "../package/RuntimePackageSelection.v1.0.1.json",
                        "git_blob_sha1": "4aa482c5a6b8dbe50441efa496d8f19f3cd5405b",
                        "asset_sha256": VALIDATOR.LLAMA_ASSET_SHA256,
                    },
                }
            ],
        },
        "download_closeout": {
            "task_id": "M1-03",
            "result": "PASS / CLUED_MODEL_M1_PROFILE_003_DOWNLOAD_AND_INTEGRITY_ACCEPTED",
            "snapshot": {
                "revision": VALIDATOR.MODEL_REVISION,
                "weight": {"sha256": VALIDATOR.SOURCE_WEIGHT_SHA256},
            },
            "attempt_accounting": {
                "profile_status_after_closeout": "CLOSED_SUCCESS",
                "retry_under_same_profile_allowed": False,
            },
        },
        "invocation_closeout": {
            "task_id": "M1-04",
            "status": "CLOSED_SUCCESS / HISTORICAL_EXECUTION_EVIDENCE_RECOVERED / NO_REEXECUTION",
            "recovery_scope": {
                "administrative_recovery_only": True,
                "effectful_execution_performed": False,
                "new_model_calls": 0,
                "new_provider_calls": 0,
                "new_benchmarks": 0,
                "new_downloads": 0,
            },
            "immutable_source_record": {
                "library_file_id": "libfile_2082206838948191859c6372100df3eb",
                "bytes": 2558,
                "sha256": VALIDATOR.M1_04_LIBRARY_RECORD_SHA256,
            },
            "execution_profile": {
                "profile_id": VALIDATOR.M1_04_PROFILE_ID,
                "profile_sha256": VALIDATOR.M1_04_PROFILE_SHA256,
                "status_after_execution": "CLOSED_SUCCESS",
                "attempts_used": 1,
                "same_profile_retry_allowed": False,
            },
            "execution": {"http_post_count": 1, "real_provider_invocation": True},
            "model": {
                "revision": VALIDATOR.MODEL_REVISION,
                "sha256": variants["q8_0"]["sha256"],
            },
            "runtime": {
                "release_tag": VALIDATOR.LLAMA_RELEASE_TAG,
                "commit": VALIDATOR.LLAMA_COMMIT,
            },
            "committed_downstream_corroboration": {
                "m1_04_real_invocation_profile_id": VALIDATOR.M1_04_PROFILE_ID,
                "m1_04_disposition": "CLOSED_SUCCESS / ONE_SHOT_PROFILE_CONSUMED",
            },
        },
        "provider_registry": {
            "status": "HISTORICAL_QUALIFICATION_RECOVERED / EXECUTION_PROFILE_CONSUMED / EXECUTION_DISABLED",
            "adapters": [
                {
                    "runtime_revision": VALIDATOR.LLAMA_COMMIT,
                    "qualified_capabilities": ["structured_generate"],
                    "execution_allowed": False,
                    "execution_blockers": ["NEW_EFFECTFUL_CALL_REQUIRES_NEW_EXACT_EXPERIMENT_PROFILE"],
                }
            ],
            "historical_execution_closeout": {"git_blob_sha1": "SET_BY_FIXTURE"},
        },
        "invocation_harness": {
            "status": "CLOSED_SUCCESS / HISTORICAL_REAL_INVOCATION_BOUND / EXECUTION_PROFILE_CONSUMED",
            "binding_identity": {"runtime_revision": VALIDATOR.LLAMA_COMMIT},
            "local_surfaces": {"adapter_registry": "ProviderAdapterRegistry.v1.0.2.json"},
            "current_kernel_model_capability_profile": {"local_provider_execution_allowed_now": False},
            "real_inference_gate": {"status": "CLOSED_SUCCESS / CONSUMED"},
            "execution_evidence": {
                "profile_id": VALIDATOR.M1_04_PROFILE_ID,
                "closeout_git_blob_sha1": "SET_BY_FIXTURE",
            },
            "task_effect": "M1-04_COMPLETED / REAL_INVOCATION_EVIDENCE_BOUND / NO_CURRENT_EXECUTION_AUTHORITY",
        },
        "package_matrix": {
            "status": "GENERATED_AND_INTEGRITY_VERIFIED / QUALITY_UNRANKED",
            "source_snapshot": {
                "model_id": "Qwen/Qwen3.5-0.8B",
                "revision": "2fc06364715b967f1860aea9cf38778875588b17",
                "weight_sha256": "04b1c301231dd422b8860db31311ab2721511346a32cb1e079c4c4e5f1fe4696",
            },
            "variants": [
                {
                    "variant_id": variant_id,
                    "bytes": value["bytes"],
                    "sha256": value["sha256"],
                    "package_status": "GENERATED_INTEGRITY_VERIFIED",
                }
                for variant_id, value in variants.items()
            ],
            "quality_selection": {"performed": False, "winner": None},
        },
        "runtime_selection": {
            "successor_runtime": {
                "runtime_id": "llama.cpp",
                "release_tag": "b11033",
                "commit": "8ed1a55efcd7424d2c592f6cbc9f97756db1d74d",
                "selected_asset": {"sha256": "8ca91d4621fcac8799245f01a6467e9c09eba7b8d3be161a382048dc5c839db2"},
            }
        },
        "pc_benchmark": {
            "status": "VALIDATED_EVIDENCE",
            "device": {"device_name": "DESK-W-591"},
            "model": {"revision": "2fc06364715b967f1860aea9cf38778875588b17"},
            "benchmark_contract": {"threads": 2, "n_gpu_layers": 0, "devices": "none", "no_op_offload": 1},
            "validation": {
                "result_groups_eight": True,
                "measurement_samples_forty": True,
                "all_devices_none": True,
                "all_no_op_offload_one": True,
                "all_n_gpu_layers_zero": True,
                "all_threads_two": True,
                "all_repetitions_five": True,
                "expected_tests_only": True,
            },
            "results": [
                {"variant_id": variant_id, "test": test, "avg_ts": value[f"{test}_avg_ts"]}
                for variant_id, value in variants.items()
                for test in ("pp512", "tg128")
            ],
        },
        "pc_benchmark_validation": {
            "conclusion": "PASS / M1_06_PC_BENCHMARK_EVIDENCE_REGRESSION_VALIDATED"
        },
        "runtime_stability": {
            "status": "AUTHOR_SIDE_CLOSEOUT_PASS / EFFECTFUL_EXECUTION_COMPLETE",
            "scenario_results": {"load": "PASS", "cancel": "PASS", "crash_restart": "PASS"},
            "one_shot_accounting": {
                "attempts_used": 1,
                "same_profile_retry_allowed": False,
                "profile_effectful_execution_state": "CONSUMED",
            },
            "execution": {"model_sha256_pre": variants["q8_0"]["sha256"], "model_sha256_post": variants["q8_0"]["sha256"]},
            "post_execution_observation": {
                "llama_server_process_count": 0,
                "native_owner_process_count": 0,
                "port_18087_listener_count": 0,
            },
        },
        "runtime_lifecycle": {
            "status": "AUTHOR_SIDE_CLOSEOUT_PASS / EFFECTFUL_EXECUTION_COMPLETE",
            "lifecycle_results": {"install": "PASS", "upgrade": "PASS", "rollback": "PASS", "cleanup": "PASS"},
            "one_shot_accounting": {
                "attempts_used": 1,
                "same_profile_retry_allowed": False,
                "profile_effectful_execution_state": "CONSUMED",
            },
            "execution": {
                "model_sha256_pre": variants["q8_0"]["sha256"],
                "model_sha256_post": variants["q8_0"]["sha256"],
                "runtime_asset_sha256_post": "8ca91d4621fcac8799245f01a6467e9c09eba7b8d3be161a382048dc5c839db2",
            },
            "post_execution_observation": {
                "llama_server_process_count": 0,
                "native_owner_process_count": 0,
                "port_18088_listener_count": 0,
                "runtime_test_root_removed": True,
            },
        },
    }


def build_fixture(root):
    matrix = json.loads(MATRIX_PATH.read_text(encoding="utf-8"))
    sources = fixture_sources()
    for name, value in sources.items():
        if name in {"provider_registry", "invocation_harness"}:
            closeout_blob = matrix["source_bindings"]["invocation_closeout"]["git_blob_sha1"]
            if name == "provider_registry":
                value["historical_execution_closeout"]["git_blob_sha1"] = closeout_blob
            else:
                value["execution_evidence"]["closeout_git_blob_sha1"] = closeout_blob
        target = root / matrix["source_bindings"][name]["path"]
        write_json(target, value)
        matrix["source_bindings"][name]["git_blob_sha1"] = VALIDATOR.git_blob_sha1(target)
    matrix["selected_reference_baseline"]["runtime_license_binding"]["review_git_blob_sha1"] = (
        matrix["source_bindings"]["license_review"]["git_blob_sha1"]
    )
    matrix_target = root / VALIDATOR.MATRIX_REL
    write_json(matrix_target, matrix)
    return matrix_target


class M1TeacherComparisonSelectionTests(unittest.TestCase):
    def with_fixture(self):
        temp = tempfile.TemporaryDirectory()
        root = pathlib.Path(temp.name)
        matrix_path = build_fixture(root)
        self.addCleanup(temp.cleanup)
        return root, matrix_path

    def mutate_matrix(self, matrix_path, mutation):
        matrix = json.loads(matrix_path.read_text(encoding="utf-8"))
        mutation(matrix)
        write_json(matrix_path, matrix)

    def test_static_source_bound_matrix_passes(self):
        root, matrix_path = self.with_fixture()
        VALIDATOR.validate(root, matrix_path)

    def test_teacher_invention_fails_closed(self):
        root, matrix_path = self.with_fixture()
        self.mutate_matrix(matrix_path, lambda matrix: matrix["teacher_selection"].update(candidate="unbound/teacher"))
        with self.assertRaisesRegex(VALIDATOR.ValidationError, "teacher selected without evidence"):
            VALIDATOR.validate(root, matrix_path)

    def test_new_provider_call_fails_closed(self):
        root, matrix_path = self.with_fixture()
        self.mutate_matrix(matrix_path, lambda matrix: matrix["generation_mode"].update(new_provider_calls=1))
        with self.assertRaisesRegex(VALIDATOR.ValidationError, "non-zero M1-09 effect count"):
            VALIDATOR.validate(root, matrix_path)

    def test_quality_winner_invention_fails_closed(self):
        root, matrix_path = self.with_fixture()
        self.mutate_matrix(matrix_path, lambda matrix: matrix["package_comparison_set"].update(quality_winner="q4_0"))
        with self.assertRaisesRegex(VALIDATOR.ValidationError, "ranked without quality evidence"):
            VALIDATOR.validate(root, matrix_path)

    def test_unqualified_platform_coverage_fails_closed(self):
        root, matrix_path = self.with_fixture()
        self.mutate_matrix(matrix_path, lambda matrix: matrix["device_coverage"].update(full_cross_device_claim_allowed=True))
        with self.assertRaisesRegex(VALIDATOR.ValidationError, "cross-device claim improperly allowed"):
            VALIDATOR.validate(root, matrix_path)

    def test_source_blob_drift_fails_closed(self):
        root, matrix_path = self.with_fixture()
        matrix = json.loads(matrix_path.read_text(encoding="utf-8"))
        source = root / matrix["source_bindings"]["license_review"]["path"]
        source.write_text(source.read_text(encoding="utf-8") + "\n", encoding="utf-8")
        with self.assertRaisesRegex(VALIDATOR.ValidationError, "bound source blob drift"):
            VALIDATOR.validate(root, matrix_path)

    def test_m1_08_retry_regression_fails_closed(self):
        root, matrix_path = self.with_fixture()
        matrix = json.loads(matrix_path.read_text(encoding="utf-8"))
        source = root / matrix["source_bindings"]["runtime_lifecycle"]["path"]
        value = json.loads(source.read_text(encoding="utf-8"))
        value["one_shot_accounting"]["same_profile_retry_allowed"] = True
        write_json(source, value)
        matrix["source_bindings"]["runtime_lifecycle"]["git_blob_sha1"] = VALIDATOR.git_blob_sha1(source)
        write_json(matrix_path, matrix)
        with self.assertRaisesRegex(VALIDATOR.ValidationError, "M1-08 one-shot accounting drift"):
            VALIDATOR.validate(root, matrix_path)

    def test_q8_operational_reference_is_not_quality_winner(self):
        matrix = json.loads(MATRIX_PATH.read_text(encoding="utf-8"))
        self.assertEqual(matrix["selected_reference_baseline"]["package"]["variant_id"], "q8_0")
        self.assertFalse(matrix["selected_reference_baseline"]["package"]["quality_winner"])
        self.assertIsNone(matrix["package_comparison_set"]["quality_winner"])
        self.assertFalse(matrix["package_comparison_set"]["ranking_performed"])

    def test_m1_04_incomplete_harness_fails_closed(self):
        root, matrix_path = self.with_fixture()
        matrix = json.loads(matrix_path.read_text(encoding="utf-8"))
        source = root / matrix["source_bindings"]["invocation_harness"]["path"]
        value = json.loads(source.read_text(encoding="utf-8"))
        value["task_effect"] = "M1-04_IN_PROGRESS / REAL_INVOCATION_PENDING"
        write_json(source, value)
        matrix["source_bindings"]["invocation_harness"]["git_blob_sha1"] = VALIDATOR.git_blob_sha1(source)
        write_json(matrix_path, matrix)
        with self.assertRaisesRegex(VALIDATOR.ValidationError, "M1-04 task remains incomplete"):
            VALIDATOR.validate(root, matrix_path)

    def test_selected_runtime_license_revision_drift_fails_closed(self):
        root, matrix_path = self.with_fixture()
        matrix = json.loads(matrix_path.read_text(encoding="utf-8"))
        source = root / matrix["source_bindings"]["license_review"]["path"]
        value = json.loads(source.read_text(encoding="utf-8"))
        value["runtime_reviews"][0]["revision"] = "bdcbaaf6e7520b68c8c60ff724c67409970d70e1"
        write_json(source, value)
        matrix["source_bindings"]["license_review"]["git_blob_sha1"] = VALIDATOR.git_blob_sha1(source)
        write_json(matrix_path, matrix)
        with self.assertRaisesRegex(VALIDATOR.ValidationError, "selected llama.cpp license revision drift"):
            VALIDATOR.validate(root, matrix_path)

    def test_required_early_task_binding_omission_fails_closed(self):
        root, matrix_path = self.with_fixture()
        self.mutate_matrix(matrix_path, lambda matrix: matrix["source_bindings"].pop("download_closeout"))
        with self.assertRaisesRegex(VALIDATOR.ValidationError, "source binding set drift"):
            VALIDATOR.validate(root, matrix_path)


if __name__ == "__main__":
    unittest.main()
