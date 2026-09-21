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
    "TeacherComparisonSelectionMatrix.v1.0.1.json"
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
            ]
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
        target = root / matrix["source_bindings"][name]["path"]
        write_json(target, value)
        matrix["source_bindings"][name]["git_blob_sha1"] = VALIDATOR.git_blob_sha1(target)
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


if __name__ == "__main__":
    unittest.main()
