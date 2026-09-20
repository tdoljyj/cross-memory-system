#!/usr/bin/env python3
"""One-shot M1-07 Owner Final Issuance on DESK-W-591.

The Owner private key is consumed only by an absolute-path OpenSSL process on
the enrolled workstation. This script never reads, copies, prints, uploads, or
serializes private-key bytes.
"""
from __future__ import annotations

import argparse
import base64
import copy
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import socket
import stat
import subprocess
import tempfile
import uuid


EXPECTED_HOST = "DESK-W-591"
EXPECTED_REVIEWED_HEAD = "d0cf8836b1553f4d1b2239dba6d5a1b4e4aecb7b"
EXPECTED_CANDIDATE_SHA256 = "05a3a6cd1a7956617d906ba7b612cdd5c6436d2ff40195d8cdb1647035cd7d90"
EXPECTED_PROFILE_ID = "M1-STAB-QWEN35-08B-PC-001-ISSUED"
EXPECTED_AUTHORITY_EFFECT = "M1-07_PC_RUNTIME_STABILITY_EXECUTION_ONLY"
EXPECTED_PUBLIC_KEY_HEX = "a683b21e2d838f0773fc1251e6d0165c4b15ad2b2994cabf4290edff1c24eb03"
EXPECTED_PUBLIC_KEY_SHA256 = "7d8a39adb80276686ff052b65e074a8ea9e74f7eccbc44f4340b194fec342f9c"
EXPECTED_NATIVE_OWNER_SHA256 = "e0956d6d8194acefad85c54750b9802fe7faea648aeba5dd4408f41534e8680c"
EXPECTED_PRIVATE_KEY = Path(r"C:\Users\Windows\AppData\Local\Clued\OwnerKeys\M1RuntimeOwner\root-20260919T162148Z\owner-root-ed25519.pkcs8.pem")
EXPECTED_PRIVATE_KEY_LOCATOR = "windows-local-owner-key://DESK-W-591/Clued/M1-07/Owner-Ed25519-Root"
EXPECTED_OPENSSL = Path(r"C:\Program Files\Git\usr\bin\openssl.exe")
EXPECTED_OPENSSL_SHA256 = "78340fb01dea2df5caab73dcf28833b31329226a4c9e02f717f1d399592265b9"
SPKI_ED25519_PREFIX = bytes.fromhex("302a300506032b6570032100")


def canonical(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def regular_file(path: Path, label: str) -> None:
    info = os.lstat(path)
    if not stat.S_ISREG(info.st_mode) or path.is_symlink():
        raise RuntimeError(label + " must be a non-symlink regular file")


def openssl_path() -> Path:
    regular_file(EXPECTED_OPENSSL, "OpenSSL")
    if sha256_file(EXPECTED_OPENSSL) != EXPECTED_OPENSSL_SHA256:
        raise RuntimeError("approved OpenSSL digest drift")
    return EXPECTED_OPENSSL


def safe_env(temp_dir: Path) -> dict[str, str]:
    allowed = {"SYSTEMROOT", "WINDIR"}
    env = {key: value for key, value in os.environ.items() if key.upper() in allowed and value}
    env.update(TEMP=str(temp_dir), TMP=str(temp_dir), OPENSSL_CONF="NUL")
    return env


def run_checked(argv: list[str], env: dict[str, str], label: str) -> subprocess.CompletedProcess[str]:
    process = subprocess.run(argv, env=env, capture_output=True, text=True, timeout=60)
    if process.returncode:
        raise RuntimeError(label + " failed")
    return process


def derive_public_key(openssl: Path, key: Path, temp_dir: Path, env: dict[str, str]) -> bytes:
    public_der = temp_dir / "owner-public.spki.der"
    run_checked(
        [str(openssl), "pkey", "-in", str(key), "-pubout", "-outform", "DER", "-out", str(public_der)],
        env,
        "public-key derivation",
    )
    data = public_der.read_bytes()
    if len(data) != len(SPKI_ED25519_PREFIX) + 32 or not data.startswith(SPKI_ED25519_PREFIX):
        raise RuntimeError("Owner key is not canonical Ed25519 PKCS#8/SPKI")
    return data[len(SPKI_ED25519_PREFIX):]


def sign(openssl: Path, key: Path, payload: bytes, temp_dir: Path, env: dict[str, str]) -> bytes:
    message = temp_dir / "whole-profile.canonical.json"
    signature = temp_dir / "whole-profile.ed25519.sig"
    message.write_bytes(payload)
    run_checked(
        [str(openssl), "pkeyutl", "-sign", "-rawin", "-inkey", str(key), "-in", str(message), "-out", str(signature)],
        env,
        "Owner signature",
    )
    data = signature.read_bytes()
    if len(data) != 64:
        raise RuntimeError("Ed25519 signature length invalid")
    return data


def verify_signature(openssl: Path, public_raw: bytes, payload: bytes, signature: bytes, temp_dir: Path, env: dict[str, str]) -> None:
    public_der = temp_dir / "verify-public.spki.der"
    message = temp_dir / "verify-message.json"
    signature_path = temp_dir / "verify-signature.bin"
    public_der.write_bytes(SPKI_ED25519_PREFIX + public_raw)
    message.write_bytes(payload)
    signature_path.write_bytes(signature)
    run_checked(
        [str(openssl), "pkeyutl", "-verify", "-pubin", "-inkey", str(public_der), "-keyform", "DER", "-rawin", "-in", str(message), "-sigfile", str(signature_path)],
        env,
        "signature verification",
    )


def diff_paths(before: object, after: object, prefix: str = "") -> set[str]:
    if type(before) is not type(after):
        return {prefix}
    if isinstance(before, dict):
        changed: set[str] = set()
        for key in set(before) | set(after):
            path = f"{prefix}/{key}" if prefix else key
            if key not in before or key not in after:
                changed.add(path)
            else:
                changed.update(diff_paths(before[key], after[key], path))
        return changed
    if isinstance(before, list):
        if len(before) != len(after):
            return {prefix}
        changed: set[str] = set()
        for index, (left, right) in enumerate(zip(before, after)):
            changed.update(diff_paths(left, right, f"{prefix}/{index}"))
        return changed
    return set() if before == after else {prefix}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--receipt", required=True, type=Path)
    parser.add_argument("--native-owner", required=True, type=Path)
    parser.add_argument("--python-facade", required=True, type=Path)
    parser.add_argument("--expiry-hours", required=True, type=int)
    parser.add_argument("--reviewed-head", required=True)
    args = parser.parse_args()

    if socket.gethostname().upper() != EXPECTED_HOST:
        raise RuntimeError("Final Issuance is restricted to DESK-W-591")
    if args.expiry_hours != 24:
        raise RuntimeError("Owner-approved expiry must be exactly 24 hours")
    if args.reviewed_head != EXPECTED_REVIEWED_HEAD:
        raise RuntimeError("reviewed exact head drift")
    if args.output.exists() or args.receipt.exists():
        raise RuntimeError("issuance outputs must not already exist")

    candidate_path = args.candidate.resolve(strict=True)
    native_owner = args.native_owner.resolve(strict=True)
    python_facade = args.python_facade.resolve(strict=True)
    regular_file(candidate_path, "candidate")
    regular_file(native_owner, "native owner")
    regular_file(python_facade, "Python facade")
    if sha256_file(candidate_path) != EXPECTED_CANDIDATE_SHA256:
        raise RuntimeError("candidate digest drift")
    if sha256_file(native_owner) != EXPECTED_NATIVE_OWNER_SHA256:
        raise RuntimeError("native owner digest drift")

    private_key = EXPECTED_PRIVATE_KEY
    regular_file(private_key, "Owner private key")
    openssl = openssl_path()

    candidate = json.loads(candidate_path.read_text(encoding="utf-8"))
    if candidate.get("profile_id") != "M1-STAB-QWEN35-08B-PC-001-CANDIDATE":
        raise RuntimeError("candidate profile identity drift")
    if candidate.get("status") != "BLOCKED_PENDING_REVIEW_AND_FINAL_ISSUANCE":
        raise RuntimeError("candidate status drift")
    if candidate.get("effectful_authority_issued") is not False:
        raise RuntimeError("candidate authority drift")
    if candidate.get("authority_effect") != "NONE / PROFILE_PREPARATION_ONLY":
        raise RuntimeError("candidate authority effect drift")
    if candidate.get("expiry") != "TO_BE_BOUND_AT_FINAL_ISSUANCE":
        raise RuntimeError("candidate expiry drift")
    if candidate.get("owner_final_execution_authorization") is not None:
        raise RuntimeError("candidate authorization was already populated")
    if candidate.get("trusted_execution_bindings", {}).get("expected_owner_authorization_id") != "TO_BE_BOUND_AT_FINAL_ISSUANCE":
        raise RuntimeError("candidate trusted authorization drift")
    if candidate.get("execution_control", {}).get("issuer_public_key_sha256_fingerprint") != EXPECTED_PUBLIC_KEY_SHA256:
        raise RuntimeError("candidate Owner root drift")

    issued_at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    expires_at = issued_at + dt.timedelta(hours=24)
    issued_text = issued_at.isoformat().replace("+00:00", "Z")
    expiry_text = expires_at.isoformat().replace("+00:00", "Z")
    authorization_id = "OWNER-M1-07-FINAL-" + issued_at.strftime("%Y%m%dT%H%M%SZ") + "-" + str(uuid.uuid4())

    profile = copy.deepcopy(candidate)
    profile["profile_id"] = EXPECTED_PROFILE_ID
    profile["status"] = "ISSUED"
    profile["issued_at_utc"] = issued_text
    profile["expiry"] = expiry_text
    profile["effectful_authority_issued"] = True
    profile["authority_effect"] = EXPECTED_AUTHORITY_EFFECT
    profile["fail_closed_rule"] = (
        "IF_STATUS_IS_NOT_ISSUED_OR_ISSUED_PROFILE_ID_IS_NOT_EXACT_OR_OWNER_FINAL_EXECUTION_AUTHORIZATION_OBJECT_IS_ABSENT_OR_DIGEST_INVALID_OR_EXPIRY_IS_UNRESOLVED_OR_EXPIRED_OR_BOUND_ORCHESTRATOR_SHA_DRIFTS_OR_DEVICE_MODEL_RUNTIME_CONFIG_SCOPE_DRIFTS_OR_ATTEMPT_GUARD_ALREADY_EXISTS_THEN M1-07 MUST_NOT_START_LLAMA-SERVER_OR_LOAD_A_MODEL; PYTHON_EXECUTION_IS_PERMANENTLY_DISABLED; NATIVE_OWNER_REQUIRES THE PINNED OWNER ED25519 ROOT, WHOLE-PROFILE SIGNATURE, AND EXACT NATIVE BINARY/SOURCE BINDINGS; THIS ISSUED PROFILE REMAINS FAIL-CLOSED UNLESS EVERY BINDING IS VALID."
    )
    profile["execution_control"]["issuer_trust_root_status"] = "PINNED_OWNER_ED25519_PUBLIC_KEY / OWNER_ENROLLMENT_COMPLETE / PRIVATE_KEY_OWNER_ONLY / ISSUED"
    profile["execution_control"]["boundary_contract_adoption_status"] = "OWNER_ADOPTED_EVENT_833 / SUCCESSOR_PREPARATION_GATE_EVENT_834 / INDEPENDENT_REVIEW_PASS / FINAL_ISSUANCE_OWNER_APPROVED"
    profile["successor_preparation"]["successor_state"] = "OWNER_ROOT_PINNED / R3_TOOLCHAIN_PROVENANCE_CLOSED / NATIVE_SOURCE_BINARY_RUNTIME_TREE_EXACT_BOUND / ISSUED / NO_MODEL_EXECUTION_PERFORMED / NO_MERGE"
    authorization = {
        "present": True,
        "authorization_id": authorization_id,
        "owner_message": "批准 Final Issuance",
        "source": "CURRENT_CONVERSATION",
        "authorized_profile_id": EXPECTED_PROFILE_ID,
        "authorized_authority_effect": EXPECTED_AUTHORITY_EFFECT,
        "reviewed_exact_head": EXPECTED_REVIEWED_HEAD,
        "issued_at_utc": issued_text,
        "expires_at_utc": expiry_text,
        "expiry_policy": "ISSUED_AT_PLUS_24_HOURS",
    }
    authorization["sha256"] = sha256_bytes(canonical(authorization))
    profile["owner_final_execution_authorization"] = authorization
    profile["trusted_execution_bindings"]["expected_owner_authorization_id"] = authorization_id
    profile["trusted_execution_bindings"]["expected_owner_authorization_sha256"] = authorization["sha256"]
    profile["issuance_basis"] = {
        "owner_instruction": "批准 Final Issuance",
        "expiry_policy": "ISSUED_AT_PLUS_24_HOURS",
        "reviewed_exact_head": EXPECTED_REVIEWED_HEAD,
        "independent_review_verdict": "PASS / OWNER_ROOT_PINNED_SUCCESSOR_R3_INDEPENDENTLY_ACCEPTED",
        "issued_on_device": EXPECTED_HOST,
        "model_execution_performed_during_issuance": False,
        "pr_merge_performed_during_issuance": False,
    }

    allowed_changes = {
        "profile_id", "status", "issued_at_utc", "expiry", "effectful_authority_issued", "authority_effect", "fail_closed_rule",
        "execution_control/issuer_trust_root_status", "execution_control/boundary_contract_adoption_status",
        "successor_preparation/successor_state",
        "owner_final_execution_authorization",
        "trusted_execution_bindings/expected_owner_authorization_id",
        "trusted_execution_bindings/expected_owner_authorization_sha256",
        "issuance_basis",
    }
    changed = diff_paths(candidate, profile)
    if changed != allowed_changes:
        raise RuntimeError("unexpected issuance mutation set: " + ",".join(sorted(changed ^ allowed_changes)))

    with tempfile.TemporaryDirectory(prefix="m107-final-issuance-") as temp:
        temp_dir = Path(temp)
        env = safe_env(temp_dir)
        openssl = openssl_path()
        public_raw = derive_public_key(openssl, private_key, temp_dir, env)
        if public_raw.hex() != EXPECTED_PUBLIC_KEY_HEX or sha256_bytes(public_raw) != EXPECTED_PUBLIC_KEY_SHA256:
            raise RuntimeError("Owner private key does not match the pinned public root")
        payload = canonical(profile)
        signature = sign(openssl, private_key, payload, temp_dir, env)
        verify_signature(openssl, public_raw, payload, signature, temp_dir, env)

    profile["owner_signature"] = {
        "algorithm": "Ed25519-CLUED-CANONICAL-JSON-v1",
        "signature_base64": base64.b64encode(signature).decode("ascii"),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(profile, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")

    native = subprocess.run(
        [str(native_owner), "--validate-only", "--profile", str(args.output.resolve())],
        env={k: v for k, v in os.environ.items() if k.upper() in {"SYSTEMROOT", "WINDIR", "TEMP", "TMP"} and v},
        capture_output=True,
        text=True,
        timeout=60,
    )
    if native.returncode != 0:
        raise RuntimeError("native validate-only process failed")
    native_result = json.loads(native.stdout.strip().splitlines()[-1])
    if native_result.get("profile_checks_ready") is not True or native_result.get("reason") != "READY_FOR_NATIVE_AUTHORIZATION":
        raise RuntimeError("native validate-only rejected issued profile")
    if native_result.get("execution_ready") is not False or native_result.get("server_started") is not False or native_result.get("model_loaded") is not False:
        raise RuntimeError("native validate-only effect boundary drift")

    facade = subprocess.run(
        [os.environ.get("PYTHON", "python"), str(python_facade), "--validate-only", "--profile", str(args.output.resolve())],
        env={k: v for k, v in os.environ.items() if k.upper() in {"SYSTEMROOT", "WINDIR", "TEMP", "TMP", "PATH", "PATHEXT"} and v},
        capture_output=True,
        text=True,
        timeout=60,
    )
    if facade.returncode != 0:
        raise RuntimeError("Python facade validate-only process failed")
    facade_result = json.loads(facade.stdout.strip().splitlines()[-1])
    if facade_result.get("profile_checks_ready") is not True or facade_result.get("reason") != "NATIVE_OWNER_PROCESS_REQUIRED":
        raise RuntimeError("Python facade validate-only rejected issued profile")
    if facade_result.get("execution_ready") is not False or facade_result.get("server_started") is not False or facade_result.get("model_loaded") is not False:
        raise RuntimeError("Python facade validate-only effect boundary drift")

    receipt = {
        "schema_version": "clued.model-m1-07-owner-final-issuance-receipt/1",
        "record_id": "M1-STAB-QWEN35-08B-PC-001-FINAL-ISSUANCE-" + issued_at.strftime("%Y%m%dT%H%M%SZ"),
        "status": "OWNER_FINAL_ISSUANCE_COMPLETE / ISSUED / NOT_EXECUTED / NO_MERGE",
        "task_id": "M1-07",
        "reviewed_exact_head": EXPECTED_REVIEWED_HEAD,
        "candidate_sha256": EXPECTED_CANDIDATE_SHA256,
        "issued_profile_path": "development/contracts/model-program/m1/governance/ExperimentAuthorizationProfile.M1-STAB-QWEN35-08B-PC-001.issued.json",
        "issued_profile_sha256": sha256_file(args.output),
        "issued_at_utc": issued_text,
        "expiry": expiry_text,
        "expiry_policy": "ISSUED_AT_PLUS_24_HOURS",
        "owner_authorization_id": authorization_id,
        "owner_authorization_sha256": authorization["sha256"],
        "owner_public_key_sha256_fingerprint": EXPECTED_PUBLIC_KEY_SHA256,
        "owner_private_key_locator": EXPECTED_PRIVATE_KEY_LOCATOR,
        "owner_private_key_material_exported": False,
        "native_owner_sha256": EXPECTED_NATIVE_OWNER_SHA256,
        "native_validate_only": native_result,
        "python_facade_validate_only": facade_result,
        "effects": {
            "llama_server_started": False,
            "model_loaded": False,
            "real_m1_07_scenario_executed": False,
            "attempt_guard_created": False,
            "m1_08_started": False,
            "training_or_distillation_performed": False,
            "promotion_or_activation_performed": False,
            "production_mutation": False,
            "release_performed": False,
            "pr_268_merged": False,
        },
        "next_gate": "SEPARATE_OWNER_DECISION_TO_INVOKE_EXACT_ISSUED_PROFILE_ONCE_BEFORE_EXPIRY",
    }
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps({
        "status": receipt["status"],
        "issued_profile_sha256": receipt["issued_profile_sha256"],
        "issued_at_utc": issued_text,
        "expiry": expiry_text,
        "owner_authorization_id": authorization_id,
        "private_key_exported": False,
        "server_started": False,
        "model_loaded": False,
    }, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print("FAIL: " + type(exc).__name__ + ": " + str(exc))
        raise SystemExit(1)
