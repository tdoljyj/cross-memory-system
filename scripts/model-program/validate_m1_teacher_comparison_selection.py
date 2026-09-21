#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
MATRIX_REL = Path(
    "development/contracts/model-program/m1/registries/"
    "TeacherComparisonSelectionMatrix.v1.0.2.json"
)

EXPECTED_BINDINGS = {
    "device_matrix",
    "stage_entry",
    "shortlist",
    "license_review",
    "download_closeout",
    "invocation_harness",
    "provider_registry",
    "invocation_closeout",
    "package_matrix",
    "runtime_selection",
    "pc_benchmark",
    "pc_benchmark_validation",
    "runtime_stability",
    "runtime_lifecycle",
}

MODEL_REVISION = "2fc06364715b967f1860aea9cf38778875588b17"
SOURCE_WEIGHT_SHA256 = "04b1c301231dd422b8860db31311ab2721511346a32cb1e079c4c4e5f1fe4696"
LLAMA_RELEASE_TAG = "b11033"
LLAMA_COMMIT = "8ed1a55efcd7424d2c592f6cbc9f97756db1d74d"
LLAMA_ASSET_SHA256 = "8ca91d4621fcac8799245f01a6467e9c09eba7b8d3be161a382048dc5c839db2"
M1_04_PROFILE_ID = "M1-INF-QWEN35-08B-Q8_0-001"
M1_04_PROFILE_SHA256 = "45211288a98e860f83cf96d3d1684884d96348dda9bc23d3b11061a97c77e6cc"
M1_04_LIBRARY_RECORD_SHA256 = "6f085b3826fd86dc2e8352828a701bd68a6e6d4fa5286f2989535c210282fcda"

EXPECTED_ROLES = [
    "Mobile-class Local Reference",
    "Personal-device Local Reference",
    "Strong Hosted / Enterprise Reference",
    "Reproducible From-scratch Reference",
    "Embedding Reference",
    "Reranker Reference",
    "Guard / Classifier Reference",
]

EXPECTED_VARIANTS = {
    "bf16": {
        "bytes": 1557662720,
        "sha256": "fbeda5bd9fa2e8c418cb08df1fa2d06082d2d8ded2728df2d94c9144033f2b73",
        "pp512_avg_ts": 167.149615,
        "tg128_avg_ts": 19.17819,
    },
    "q8_0": {
        "bytes": 833592320,
        "sha256": "799482186ea1c91b63bf4eb2999e034330425745496a95f0bffbfe6300a1064d",
        "pp512_avg_ts": 194.355903,
        "tg128_avg_ts": 34.287641,
    },
    "q4_0": {
        "bytes": 512977920,
        "sha256": "d9192377b378863e309e5d2faeeea5b0489f385320a8ed281cff9568061577d6",
        "pp512_avg_ts": 280.758082,
        "tg128_avg_ts": 51.380995,
    },
    "q4_k_m": {
        "bytes": 541903872,
        "sha256": "2f26e07f5585a0f824edbb62a62c3f571bdbaae58d5f13b99befc6447edce90e",
        "pp512_avg_ts": 222.455343,
        "tg128_avg_ts": 46.823885,
    },
}


class ValidationError(RuntimeError):
    pass


def load(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValidationError(f"cannot load JSON {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ValidationError(f"JSON root must be an object: {path}")
    return value


def git_blob_sha1(path: Path) -> str:
    payload = path.read_bytes()
    header = b"blob " + str(len(payload)).encode("ascii") + b"\0"
    return hashlib.sha1(header + payload).hexdigest()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValidationError(message)


def bound_sources(matrix: dict[str, Any], root: Path) -> dict[str, dict[str, Any]]:
    bindings = matrix.get("source_bindings")
    require(isinstance(bindings, dict), "source_bindings missing")
    require(set(bindings) == EXPECTED_BINDINGS, "source binding set drift")

    resolved: dict[str, dict[str, Any]] = {}
    root_resolved = root.resolve()
    for name in sorted(EXPECTED_BINDINGS):
        binding = bindings[name]
        require(isinstance(binding, dict), f"invalid source binding: {name}")
        rel_text = binding.get("path")
        require(isinstance(rel_text, str) and rel_text, f"missing path: {name}")
        rel = Path(rel_text)
        require(not rel.is_absolute() and ".." not in rel.parts, f"unsafe path: {name}")
        target = (root / rel).resolve()
        require(target.is_relative_to(root_resolved), f"path escapes root: {name}")
        require(target.is_file(), f"bound source missing: {name}")
        actual_blob = git_blob_sha1(target)
        require(
            actual_blob == binding.get("git_blob_sha1"),
            f"bound source blob drift: {name}",
        )
        resolved[name] = load(target)
        resolved[name]["__bound_git_blob_sha1"] = actual_blob
    return resolved


def validate_stage(stage: dict[str, Any]) -> None:
    require(stage.get("schema_version") == "clued.model-m1-stage-entry-authorization/1", "stage schema drift")
    require(stage.get("record_id") == "CLUED-MODEL-M1-STAGE-ENTRY-v1.0.3-20260921", "stage successor drift")
    require(stage.get("tasks", {}).get("M1-09", "").startswith("形成教师 / 对照选择矩阵"), "M1-09 task drift")
    m106 = stage.get("m1_06_progressive_acceptance", {})
    require(m106.get("M1-06A", {}).get("current_status") == "CLOSED_SUCCESS", "PC baseline not closed")
    require(m106.get("M1-06A", {}).get("accepted_device_names") == ["DESK-W-591"], "accepted PC drift")
    for key in ("M1-06B", "M1-06C"):
        row = m106.get(key, {})
        require(row.get("current_status") == "DEFERRED_NO_BOUND_DEVICE", f"{key} state drift")
        require(row.get("coverage_claim") == "NONE", f"{key} coverage drift")
        require(row.get("global_m1_blocking") is False, f"{key} incorrectly blocks M1")
    p9 = stage.get("progression_policy", {}).get("m1_09", {})
    require(p9.get("device_baseline_gate_satisfied") is True, "M1-09 PC gate not satisfied")
    require(p9.get("deferred_platform_completion_required_for_global_finalization") is False, "deferred platforms block M1-09")
    require(p9.get("exact_experiment_profile_required_for_any_new_provider_call_or_benchmark") is True, "effectful M1-09 gate weakened")
    review = stage.get("independent_review", {})
    require(review.get("task") == "M1-10" and review.get("required") is True, "M1-10 gate drift")
    require(review.get("mode") == ["FRESH_CONTEXT", "READ_ONLY", "REVIEWER_NOT_MODIFIER"], "M1-10 review mode drift")
    require(all(value is False for value in stage.get("m1_hard_boundaries", {}).values()), "M1 hard boundary expanded")


def validate_sources(sources: dict[str, dict[str, Any]]) -> None:
    stage = sources["stage_entry"]
    validate_stage(stage)

    devices = sources["device_matrix"]
    require(devices.get("schema_version") == "clued.model-m1-device-runtime-matrix/2", "M1-00 device matrix schema drift")
    require(devices.get("task_id") == "M1-00", "M1-00 task binding drift")
    require(devices.get("first_tranche_runtime") == "llama.cpp", "M1-00 first-tranche runtime drift")
    bound_devices = [row for row in devices.get("physical_device_profiles", []) if row.get("binding_state") == "EXACT_BOUND"]
    require(len(bound_devices) == 1 and bound_devices[0].get("device_name") == "DESK-W-591", "M1-00 exact device binding drift")

    shortlist = sources["shortlist"]
    first = shortlist.get("first_tranche", {})
    require(first.get("model_id") == "Qwen/Qwen3.5-0.8B", "first-tranche model drift")
    require(first.get("revision") == MODEL_REVISION, "first-tranche revision drift")
    require([row.get("role") for row in shortlist.get("roles", [])] == EXPECTED_ROLES, "shortlist role set/order drift")

    licenses = {row.get("id"): row for row in sources["license_review"].get("model_reviews", [])}
    qwen = licenses.get("Qwen/Qwen3.5-0.8B", {})
    require(qwen.get("internal_m1_reference") == "PROVISIONALLY_COMPATIBLE", "Qwen license screen drift")
    require(qwen.get("training_or_distillation_authority") == "NOT_ISSUED", "training authority unexpectedly issued")
    hosted = licenses.get("Strong Hosted / Enterprise Reference", {})
    require(str(hosted.get("internal_m1_reference", "")).startswith("BLOCKED_PENDING_PROVIDER_TERMS"), "hosted provider terms no longer blocked")
    runtime_licenses = {row.get("id"): row for row in sources["license_review"].get("runtime_reviews", [])}
    llama_license = runtime_licenses.get("llama.cpp", {})
    require(llama_license.get("release_tag") == LLAMA_RELEASE_TAG, "selected llama.cpp license tag drift")
    require(llama_license.get("revision") == LLAMA_COMMIT, "selected llama.cpp license revision drift")
    require(llama_license.get("license") == "MIT", "selected llama.cpp license drift")
    license_runtime_binding = llama_license.get("selected_runtime_binding", {})
    require(license_runtime_binding.get("path") == "../package/RuntimePackageSelection.v1.0.1.json", "selected runtime license path drift")
    require(license_runtime_binding.get("git_blob_sha1") == "4aa482c5a6b8dbe50441efa496d8f19f3cd5405b", "selected runtime license selection binding drift")
    require(license_runtime_binding.get("asset_sha256") == LLAMA_ASSET_SHA256, "selected runtime license asset drift")

    download = sources["download_closeout"]
    require(download.get("task_id") == "M1-03", "M1-03 task binding drift")
    require(download.get("result") == "PASS / CLUED_MODEL_M1_PROFILE_003_DOWNLOAD_AND_INTEGRITY_ACCEPTED", "M1-03 closeout not accepted")
    require(download.get("snapshot", {}).get("revision") == MODEL_REVISION, "M1-03 model revision drift")
    require(download.get("snapshot", {}).get("weight", {}).get("sha256") == SOURCE_WEIGHT_SHA256, "M1-03 source weight drift")
    d_attempt = download.get("attempt_accounting", {})
    require(d_attempt.get("profile_status_after_closeout") == "CLOSED_SUCCESS" and d_attempt.get("retry_under_same_profile_allowed") is False, "M1-03 closeout accounting drift")

    invocation = sources["invocation_closeout"]
    require(invocation.get("task_id") == "M1-04", "M1-04 closeout task drift")
    require(invocation.get("status") == "CLOSED_SUCCESS / HISTORICAL_EXECUTION_EVIDENCE_RECOVERED / NO_REEXECUTION", "M1-04 historical closeout not accepted")
    recovery = invocation.get("recovery_scope", {})
    require(recovery.get("administrative_recovery_only") is True and recovery.get("effectful_execution_performed") is False, "M1-04 recovery performed an effect")
    require(all(recovery.get(key) == 0 for key in ("new_model_calls", "new_provider_calls", "new_benchmarks", "new_downloads")), "M1-04 recovery effect count drift")
    source_record = invocation.get("immutable_source_record", {})
    require(source_record.get("library_file_id") == "libfile_2082206838948191859c6372100df3eb", "M1-04 source record identity drift")
    require(source_record.get("bytes") == 2558 and source_record.get("sha256") == M1_04_LIBRARY_RECORD_SHA256, "M1-04 source record content drift")
    i_profile = invocation.get("execution_profile", {})
    require(i_profile.get("profile_id") == M1_04_PROFILE_ID and i_profile.get("profile_sha256") == M1_04_PROFILE_SHA256, "M1-04 profile identity drift")
    require(i_profile.get("status_after_execution") == "CLOSED_SUCCESS" and i_profile.get("attempts_used") == 1 and i_profile.get("same_profile_retry_allowed") is False, "M1-04 one-shot accounting drift")
    require(invocation.get("execution", {}).get("http_post_count") == 1 and invocation.get("execution", {}).get("real_provider_invocation") is True, "M1-04 real invocation evidence drift")
    require(invocation.get("model", {}).get("revision") == MODEL_REVISION and invocation.get("model", {}).get("sha256") == EXPECTED_VARIANTS["q8_0"]["sha256"], "M1-04 model binding drift")
    require(invocation.get("runtime", {}).get("release_tag") == LLAMA_RELEASE_TAG and invocation.get("runtime", {}).get("commit") == LLAMA_COMMIT, "M1-04 runtime binding drift")
    corroboration = invocation.get("committed_downstream_corroboration", {})
    require(corroboration.get("m1_04_real_invocation_profile_id") == M1_04_PROFILE_ID and corroboration.get("m1_04_disposition") == "CLOSED_SUCCESS / ONE_SHOT_PROFILE_CONSUMED", "M1-04 downstream corroboration drift")

    provider = sources["provider_registry"]
    require(provider.get("status") == "HISTORICAL_QUALIFICATION_RECOVERED / EXECUTION_PROFILE_CONSUMED / EXECUTION_DISABLED", "M1-04 provider registry state drift")
    adapter_rows = provider.get("adapters", [])
    require(len(adapter_rows) == 1, "M1-04 provider adapter count drift")
    adapter = adapter_rows[0]
    require(adapter.get("runtime_revision") == LLAMA_COMMIT, "M1-04 provider runtime drift")
    require(adapter.get("qualified_capabilities") == ["structured_generate"], "M1-04 provider capability drift")
    require(adapter.get("execution_allowed") is False, "M1-04 provider execution authority reopened")
    require("NEW_EFFECTFUL_CALL_REQUIRES_NEW_EXACT_EXPERIMENT_PROFILE" in adapter.get("execution_blockers", []), "M1-04 new-call gate missing")

    harness = sources["invocation_harness"]
    require(harness.get("status") == "CLOSED_SUCCESS / HISTORICAL_REAL_INVOCATION_BOUND / EXECUTION_PROFILE_CONSUMED", "M1-04 harness not closed")
    require(harness.get("binding_identity", {}).get("runtime_revision") == LLAMA_COMMIT, "M1-04 harness runtime drift")
    require(harness.get("local_surfaces", {}).get("adapter_registry") == "ProviderAdapterRegistry.v1.0.2.json", "M1-04 harness adapter successor drift")
    require(harness.get("current_kernel_model_capability_profile", {}).get("local_provider_execution_allowed_now") is False, "M1-04 harness reopened local execution")
    require(harness.get("real_inference_gate", {}).get("status") == "CLOSED_SUCCESS / CONSUMED", "M1-04 real inference gate drift")
    require(harness.get("execution_evidence", {}).get("profile_id") == M1_04_PROFILE_ID, "M1-04 harness evidence profile drift")
    closeout_blob = invocation.get("__bound_git_blob_sha1")
    require(harness.get("execution_evidence", {}).get("closeout_git_blob_sha1") == closeout_blob, "M1-04 harness closeout binding drift")
    require(provider.get("historical_execution_closeout", {}).get("git_blob_sha1") == closeout_blob, "M1-04 provider closeout binding drift")
    require(str(harness.get("task_effect", "")).startswith("M1-04_COMPLETED"), "M1-04 task remains incomplete")

    runtime = sources["runtime_selection"].get("successor_runtime", {})
    require(runtime.get("runtime_id") == "llama.cpp", "runtime id drift")
    require(runtime.get("release_tag") == LLAMA_RELEASE_TAG, "runtime tag drift")
    require(runtime.get("commit") == LLAMA_COMMIT, "runtime commit drift")
    require(runtime.get("selected_asset", {}).get("sha256") == LLAMA_ASSET_SHA256, "runtime asset drift")

    package = sources["package_matrix"]
    require(package.get("status") == "GENERATED_AND_INTEGRITY_VERIFIED / QUALITY_UNRANKED", "package matrix is not accepted unranked evidence")
    source = package.get("source_snapshot", {})
    require(source.get("model_id") == "Qwen/Qwen3.5-0.8B", "package model drift")
    require(source.get("revision") == MODEL_REVISION, "package revision drift")
    require(source.get("weight_sha256") == SOURCE_WEIGHT_SHA256, "source weight drift")
    package_rows = {row.get("variant_id"): row for row in package.get("variants", [])}
    require(set(package_rows) == set(EXPECTED_VARIANTS), "package variant set drift")
    for variant_id, expected in EXPECTED_VARIANTS.items():
        row = package_rows[variant_id]
        require(row.get("bytes") == expected["bytes"], f"package size drift: {variant_id}")
        require(row.get("sha256") == expected["sha256"], f"package digest drift: {variant_id}")
        require(row.get("package_status") == "GENERATED_INTEGRITY_VERIFIED", f"package integrity drift: {variant_id}")
    quality = package.get("quality_selection", {})
    require(quality.get("performed") is False and quality.get("winner") is None, "package quality winner exists")

    benchmark = sources["pc_benchmark"]
    require(benchmark.get("status") == "VALIDATED_EVIDENCE", "PC benchmark not validated")
    require(benchmark.get("device", {}).get("device_name") == "DESK-W-591", "PC device drift")
    require(benchmark.get("model", {}).get("revision") == MODEL_REVISION, "benchmark model drift")
    contract = benchmark.get("benchmark_contract", {})
    require(contract.get("threads") == 2 and contract.get("n_gpu_layers") == 0, "strict CPU contract drift")
    require(contract.get("devices") == "none" and contract.get("no_op_offload") == 1, "strict CPU offload gate drift")
    check = benchmark.get("validation", {})
    required_flags = (
        "result_groups_eight",
        "measurement_samples_forty",
        "all_devices_none",
        "all_no_op_offload_one",
        "all_n_gpu_layers_zero",
        "all_threads_two",
        "all_repetitions_five",
        "expected_tests_only",
    )
    require(all(check.get(flag) is True for flag in required_flags), "strict CPU validation incomplete")
    result_rows = {(row.get("variant_id"), row.get("test")): row for row in benchmark.get("results", [])}
    require(len(result_rows) == 8, "benchmark result row count drift")
    for variant_id, expected in EXPECTED_VARIANTS.items():
        require(result_rows[(variant_id, "pp512")].get("avg_ts") == expected["pp512_avg_ts"], f"pp512 drift: {variant_id}")
        require(result_rows[(variant_id, "tg128")].get("avg_ts") == expected["tg128_avg_ts"], f"tg128 drift: {variant_id}")
    receipt = sources["pc_benchmark_validation"]
    require(receipt.get("conclusion") == "PASS / M1_06_PC_BENCHMARK_EVIDENCE_REGRESSION_VALIDATED", "benchmark validation receipt drift")

    stability = sources["runtime_stability"]
    require("AUTHOR_SIDE_CLOSEOUT_PASS" in str(stability.get("status")), "M1-07 closeout missing")
    require(all(value == "PASS" for value in stability.get("scenario_results", {}).values()), "M1-07 scenario failure")
    s_attempt = stability.get("one_shot_accounting", {})
    require(s_attempt.get("attempts_used") == 1 and s_attempt.get("same_profile_retry_allowed") is False, "M1-07 one-shot accounting drift")
    require(s_attempt.get("profile_effectful_execution_state") == "CONSUMED", "M1-07 profile not consumed")
    require(stability.get("execution", {}).get("model_sha256_post") == EXPECTED_VARIANTS["q8_0"]["sha256"], "M1-07 package drift")
    s_post = stability.get("post_execution_observation", {})
    require(s_post.get("llama_server_process_count") == 0 and s_post.get("native_owner_process_count") == 0, "M1-07 process cleanup drift")
    require(s_post.get("port_18087_listener_count") == 0, "M1-07 listener remains")

    lifecycle = sources["runtime_lifecycle"]
    require("AUTHOR_SIDE_CLOSEOUT_PASS" in str(lifecycle.get("status")), "M1-08 closeout missing")
    require(all(lifecycle.get("lifecycle_results", {}).get(step) == "PASS" for step in ("install", "upgrade", "rollback", "cleanup")), "M1-08 lifecycle failure")
    require(lifecycle.get("execution", {}).get("model_sha256_post") == EXPECTED_VARIANTS["q8_0"]["sha256"], "M1-08 package drift")
    require(lifecycle.get("execution", {}).get("runtime_asset_sha256_post") == LLAMA_ASSET_SHA256, "M1-08 runtime asset drift")
    l_attempt = lifecycle.get("one_shot_accounting", {})
    require(l_attempt.get("attempts_used") == 1 and l_attempt.get("same_profile_retry_allowed") is False, "M1-08 one-shot accounting drift")
    require(l_attempt.get("profile_effectful_execution_state") == "CONSUMED", "M1-08 profile not consumed")
    l_post = lifecycle.get("post_execution_observation", {})
    require(l_post.get("llama_server_process_count") == 0 and l_post.get("native_owner_process_count") == 0, "M1-08 process cleanup drift")
    require(l_post.get("port_18088_listener_count") == 0 and l_post.get("runtime_test_root_removed") is True, "M1-08 cleanup incomplete")


def validate_matrix(matrix: dict[str, Any], sources: dict[str, dict[str, Any]]) -> None:
    require(matrix.get("schema_version") == "clued.model-m1-teacher-comparison-selection-matrix/1", "matrix schema drift")
    require(matrix.get("task_id") == "M1-09", "matrix task drift")
    require(matrix.get("record_id") == "CLUED-MODEL-M1-TEACHER-COMPARISON-SELECTION-MATRIX-v1.0.2-20260921", "matrix successor drift")
    require(matrix.get("status") == "AUTHOR_SIDE_COMPLETE / STATIC_EVIDENCE_ONLY / M1_10_REVIEW_PENDING", "matrix status drift")

    baseline = matrix.get("baseline", {})
    require(baseline.get("m1_10_blocked_review_exact_target") == "f55237bd8535c812b8279745e84744796c98b69c", "M1-10 blocked target drift")
    expected_anchors = {
        "m1_09_parent_commit": "bbfb9427a6712d9b79038a64e9f5e011ebbfda13",
        "m1_08_accepted_exact_head": "a15ca02439b383b28e9faeddb585e72a65decb02",
        "m1_08_merge_commit": "bbfb9427a6712d9b79038a64e9f5e011ebbfda13",
        "m1_07_accepted_exact_head": "d91b7a6418afa811530ca39bb1fe43f322ccc375",
        "m1_07_merge_commit": "0e31b8a3b7da55bf9723a3d0650081ef98b5e85b",
        "stage_successor_merge_commit": "329bf8af416659e6ea98d096d270d8243cb5cdc9",
    }
    for key, value in expected_anchors.items():
        require(baseline.get(key) == value, f"baseline anchor drift: {key}")

    mode = matrix.get("generation_mode", {})
    require(mode.get("mode") == "STATIC_EVIDENCE_ONLY_TEACHER_COMPARISON_SELECTION_MATRIX", "generation mode drift")
    for key in ("new_model_calls", "new_provider_calls", "new_benchmarks", "new_downloads"):
        require(mode.get(key) == 0, f"non-zero M1-09 effect count: {key}")
    for key in ("network_access_required", "effectful_experiment_profile_required", "effectful_execution_performed"):
        require(mode.get(key) is False, f"M1-09 effect boundary drift: {key}")

    teacher = matrix.get("teacher_selection", {})
    require(teacher.get("candidate") is None and teacher.get("revision") is None, "teacher selected without evidence")
    require(teacher.get("disposition") == "NOT_SELECTED / INSUFFICIENT_ACCEPTED_EVIDENCE", "teacher disposition drift")
    required_reasons = {
        "STRONG_HOSTED_ENTERPRISE_REFERENCE_NOT_SELECTED",
        "PROVIDER_TERMS_AND_ACCOUNT_SCOPE_NOT_BOUND",
        "NO_ACCEPTED_TEACHER_QUALITY_COMPARISON",
        "TRAINING_AND_DISTILLATION_NOT_AUTHORIZED",
    }
    require(set(teacher.get("reason_codes", [])) == required_reasons, "teacher deferral reasons drift")

    selected = matrix.get("selected_reference_baseline", {})
    require(selected.get("candidate") == "Qwen/Qwen3.5-0.8B", "selected reference drift")
    require(selected.get("revision") == MODEL_REVISION, "selected revision drift")
    require(selected.get("source_weight_sha256") == SOURCE_WEIGHT_SHA256, "selected source weight drift")
    require(selected.get("runtime", {}).get("commit") == LLAMA_COMMIT, "selected runtime drift")
    selected_license = selected.get("runtime_license_binding", {})
    require(selected_license.get("license") == "MIT", "selected runtime license missing")
    require(selected_license.get("review_git_blob_sha1") == matrix.get("source_bindings", {}).get("license_review", {}).get("git_blob_sha1"), "selected runtime license review mismatch")
    selected_package = selected.get("package", {})
    require(selected_package.get("variant_id") == "q8_0", "operational reference package drift")
    require(selected_package.get("sha256") == EXPECTED_VARIANTS["q8_0"]["sha256"], "operational reference digest drift")
    require(selected_package.get("quality_winner") is False, "operational reference misrepresented as quality winner")
    require(selected.get("device", {}).get("name") == "DESK-W-591", "selected device drift")
    expected_selection_tasks = {"M1-00", "M1-01", "M1-02", "M1-03", "M1-04", "M1-05", "M1-06A", "M1-07", "M1-08"}
    require(set(selected.get("selection_basis_tasks", [])) == expected_selection_tasks, "M1-00 through M1-08 selection basis incomplete")

    comparison = matrix.get("package_comparison_set", {})
    require(comparison.get("quality_winner") is None and comparison.get("ranking_performed") is False, "comparison set ranked without quality evidence")
    require(comparison.get("operational_reference_variant") == "q8_0", "comparison operational reference drift")
    rows = {row.get("variant_id"): row for row in comparison.get("variants", [])}
    require(set(rows) == set(EXPECTED_VARIANTS), "matrix comparison variant set drift")
    for variant_id, expected in EXPECTED_VARIANTS.items():
        for key, value in expected.items():
            require(rows[variant_id].get(key) == value, f"matrix comparison drift: {variant_id}.{key}")

    role_rows = matrix.get("role_matrix", [])
    require([row.get("role") for row in role_rows] == EXPECTED_ROLES, "role matrix set/order drift")
    require(role_rows[0].get("candidate") == "Qwen/Qwen3.5-0.8B", "local reference row drift")
    require(role_rows[0].get("coverage") == "PC_ONLY", "local reference overclaims coverage")
    require(all(row.get("coverage") == "NONE" for row in role_rows[1:]), "unqualified role gained coverage")

    coverage = matrix.get("device_coverage", {})
    require(coverage.get("minimum_formal_m1_baseline", {}).get("device_name") == "DESK-W-591", "minimum PC coverage drift")
    require(coverage.get("full_cross_device_claim_allowed") is False, "cross-device claim improperly allowed")
    require(coverage.get("deferred_platforms_block_global_m1_closeout") is False, "deferred platform gate regression")
    expected_deferred = {
        "Phone": "DEFERRED_NO_BOUND_DEVICE / NO_COVERAGE",
        "Tablet": "DEFERRED_NO_BOUND_DEVICE / NO_COVERAGE",
        "Mac": "DEFERRED_NO_BOUND_DEVICE / NO_COVERAGE",
    }
    require(coverage.get("deferred_platforms") == expected_deferred, "deferred platform coverage drift")

    boundaries = matrix.get("hard_boundaries", {})
    require(boundaries and all(value is False for value in boundaries.values()), "M1-09 hard boundary expanded")
    require(matrix.get("authority_effect") == "REFERENCE_BASELINE_REPORT_ONLY / NO_NEW_EXECUTION_TRAINING_DISTILLATION_PROMOTION_ACTIVATION_RELEASE_OR_PRODUCTION_AUTHORITY", "M1-09 authority effect drift")
    require(matrix.get("next_gate") == "M1-10 SINGLE FRESH_CONTEXT / READ_ONLY / REVIEWER_NOT_MODIFIER FINAL REVIEW", "M1-10 gate drift")

    # Cross-source proof that q8_0 is an operational reference, not a quality winner.
    q8 = EXPECTED_VARIANTS["q8_0"]["sha256"]
    require(sources["runtime_stability"].get("execution", {}).get("model_sha256_pre") == q8, "M1-07 did not use selected package")
    require(sources["runtime_lifecycle"].get("execution", {}).get("model_sha256_pre") == q8, "M1-08 did not use selected package")


def validate(root: Path = ROOT, matrix_path: Path | None = None) -> None:
    root = root.resolve()
    matrix_path = (matrix_path or (root / MATRIX_REL)).resolve()
    require(matrix_path.is_relative_to(root), "matrix path escapes root")
    matrix = load(matrix_path)
    sources = bound_sources(matrix, root)
    validate_sources(sources)
    validate_matrix(matrix, sources)


def main() -> int:
    try:
        validate()
    except ValidationError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    print(
        "PASS: MODEL-PROGRAM-M1 M1-09 static evidence-only teacher/comparison "
        "selection matrix is source-bound; Qwen3.5-0.8B Q8_0 is the PC local "
        "reference baseline, teacher selection remains deferred, and no effectful "
        "authority is created"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
