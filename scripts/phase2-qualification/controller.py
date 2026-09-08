"""Local engineering controller candidate. Never issues qualification or authority.

Only fixed synthetic operations run. Empty child credentials are not an OS sandbox.
Do not use this runner to load a Skill, execute arbitrary code, or access a service.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import time

SCHEMA = "clued.controller-candidate.v1"
MODE = "LOCAL_ENGINEERING_ONLY"
FIXTURE = b'{"fixture":"synthetic-v1","real_user_payload":false}\n'
LIMITATIONS = [
    "OS_NETWORK_ISOLATION_NOT_PROVEN",
    "OS_FILESYSTEM_ISOLATION_NOT_PROVEN",
    "QUALIFIED_ACTOR_ISSUER_AUTHORITY_NOT_BOUND",
    "CONTROLLER_QUALIFICATION_NOT_ISSUED",
    "PROFILE_AND_PER_ACTION_AUTHORIZATION_NOT_ISSUED",
    "LOCAL_CONTROL_IS_NOT_SERVICE_REVOCATION_OR_DISTRIBUTED_FENCING",
    "FILESYSTEM_FSYNC_IS_NOT_INDEPENDENT_REMOTE_DURABILITY_ATTESTATION",
]


class Denied(ValueError):
    pass


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def result(status, reason, **extra):
    return {"schema": SCHEMA, "status": status, "reason": reason,
            "qualified": False, "authorization_effect": "NONE",
            "formal_regressions_executed": False, "limitations": LIMITATIONS, **extra}


def plain_path(path):
    path = Path(os.path.abspath(path))
    for part in (path, *path.parents):
        if part.is_symlink() or (hasattr(part, "is_junction") and part.is_junction()):
            raise Denied("linked_path_denied")
    return path


def persist(path, value):
    """Create immutable evidence; never truncate an existing record."""
    plain_path(path)
    with open(path, "xb") as stream:
        stream.write(encoded(value))
        stream.flush()
        os.fsync(stream.fileno())


def read(path):
    plain_path(path)
    if path.stat().st_size > 65536:
        raise Denied("evidence_too_large")
    return json.loads(path.read_text(encoding="utf-8"))


def validate(config):
    keys = {"schema", "mode", "idempotency_key", "operation", "parameters",
            "timeout_seconds", "expected_runner_sha256", "expected_control_generation"}
    if not isinstance(config, dict) or set(config) != keys:
        raise Denied("unexpected_or_missing_config_keys")
    if config["schema"] != SCHEMA or config["mode"] != MODE:
        raise Denied("formal_or_unknown_mode_denied")
    if not isinstance(config["idempotency_key"], str) or not re.fullmatch(
            r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", config["idempotency_key"]):
        raise Denied("invalid_idempotency_key")
    if config["operation"] not in ("noop", "wait", "fixture_write"):
        raise Denied("operation_not_allowlisted")
    timeout = config["timeout_seconds"]
    if type(timeout) not in (float, int) or not math.isfinite(timeout) or not 0 < timeout <= 30:
        raise Denied("invalid_timeout")
    if type(config["expected_control_generation"]) is not int or config["expected_control_generation"] < 1:
        raise Denied("invalid_control_generation")
    if config["expected_runner_sha256"] != sha(Path(__file__).read_bytes()):
        raise Denied("runner_digest_drift")
    params = config["parameters"]
    if not isinstance(params, dict):
        raise Denied("invalid_parameters")
    if config["operation"] == "wait":
        seconds = params.get("seconds")
        if (set(params) != {"seconds"} or type(seconds) not in (int, float)
                or not math.isfinite(seconds) or not 0 <= seconds <= 60):
            raise Denied("invalid_wait_parameters")
    elif params != ({"fixture_id": "synthetic-v1"} if config["operation"] == "fixture_write" else {}):
        raise Denied("non_synthetic_parameters_denied")


def control(root, generation):
    plain_path(root)
    if (root / "STOP").exists():
        raise Denied("stop_requested")
    value = read(root / "control.json")
    if set(value) != {"generation", "revoked"} or type(value["generation"]) is not int or type(value["revoked"]) is not bool:
        raise Denied("invalid_control")
    if value["revoked"] or value["generation"] != generation:
        raise Denied("revoked_or_generation_changed")


def verify_intent(intent, key):
    if not isinstance(intent, dict) or not isinstance(intent.get("configuration"), dict):
        raise Denied("invalid_intent_evidence")
    config = intent["configuration"]
    validate(config)
    fixture = config["operation"] == "fixture_write"
    if (config["idempotency_key"] != key
            or intent.get("configuration_sha256") != sha(encoded(config))
            or intent.get("runner_sha256") != config["expected_runner_sha256"]
            or intent.get("target") != ("fixture.json" if fixture else None)
            or intent.get("expected_target_sha256") != (sha(FIXTURE) if fixture else None)
            or intent.get("authority_effect") != "NONE"
            or intent.get("qualification") != "CANDIDATE_ONLY"):
        raise Denied("intent_binding_mismatch")


def worker(seconds):
    # Fixed code only; no candidate modules, payload, shell, or plugin loading.
    time.sleep(seconds)
    print(json.dumps({"environment_keys": sorted(os.environ), "fixed_worker": True}))


def execute_worker(config, root):
    env = {}
    if os.name == "nt":
        # Windows runtime locator only; no PATH, HOME, proxy, token, or credentials.
        env["SYSTEMROOT"] = os.environ.get("SYSTEMROOT", r"C:\Windows")
    process = subprocess.Popen(
        [sys.executable, "-I", "-S", str(Path(__file__).resolve()), "_worker",
         str(config["parameters"].get("seconds", 0))],
        cwd=root, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True, shell=False,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    start = time.monotonic()
    stopped = None
    try:
        while process.poll() is None:
            try:
                control(root, config["expected_control_generation"])
            except (Denied, OSError, ValueError):
                stopped = "stop_or_control_invalidated"
                break
            if time.monotonic() - start >= config["timeout_seconds"]:
                stopped = "deadline_exceeded"
                break
            time.sleep(0.01)
        if stopped:
            process.kill()
        output, _ = process.communicate(timeout=5)
        if stopped:
            return {"stopped": True, "reason": stopped, "pid": process.pid,
                    "exit_code": process.returncode, "termination_observed": True}
        if process.returncode != 0:
            raise Denied("fixed_worker_failed")
        report = json.loads(output)
        allowed = {"SYSTEMROOT", "LC_CTYPE"} if os.name == "nt" else {"LC_CTYPE"}
        if not set(report["environment_keys"]) <= allowed:
            raise Denied("unexpected_child_environment")
        return {**report, "pid": process.pid, "exit_code": process.returncode,
                "termination_observed": True, "credential_values_recorded": False}
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)


def run(config, evidence_dir):
    """Execute only a local synthetic probe; uncertain intents never auto-retry."""
    lock = None
    intent_created = False
    existing_intent = False
    try:
        validate(config)
        root = plain_path(evidence_dir)
        if not root.is_dir():
            raise Denied("evidence_directory_must_exist")
        lock = root / ".controller.lock"
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            lock = None
            raise Denied("controller_lock_present_requires_operator_reconciliation")
        with os.fdopen(fd, "wb") as stream:
            stream.write(encoded({"pid": os.getpid(), "purpose": MODE,
                                  "automatic_stale_lock_recovery": False}))
            stream.flush()
            os.fsync(stream.fileno())
        if not (root / "control.json").exists():
            persist(root / "control.json", {"generation": 1, "revoked": False})
        control(root, config["expected_control_generation"])
        runs = plain_path(root / "runs")
        runs.mkdir(exist_ok=True)
        folder = plain_path(runs / config["idempotency_key"])
        folder.mkdir(exist_ok=True)
        config_hash = sha(encoded(config))
        intent = folder / "intent.json"
        if intent.exists():
            existing_intent = True
            old = read(intent)
            if not isinstance(old, dict):
                raise Denied("invalid_intent_evidence")
            if old.get("configuration_sha256") != config_hash:
                raise Denied("same_key_changed_parameters")
            verify_intent(old, config["idempotency_key"])
            if (folder / "result.json").exists():
                previous = read(folder / "result.json")
                allowed_keys = {"schema", "status", "reason", "qualified", "authorization_effect",
                                "formal_regressions_executed", "limitations", "worker", "target_sha256",
                                "idempotency_key", "configuration_sha256", "intent_sha256"}
                if (not isinstance(previous, dict)
                        or not set(previous) <= allowed_keys
                        or previous.get("schema") != SCHEMA
                        or previous.get("idempotency_key") != config["idempotency_key"]
                        or previous.get("status") not in ("COMPLETED", "STOPPED")
                        or previous.get("qualified") is not False
                        or previous.get("authorization_effect") != "NONE"
                        or previous.get("formal_regressions_executed") is not False
                        or previous.get("configuration_sha256") != config_hash
                        or previous.get("intent_sha256") != sha(intent.read_bytes())):
                    raise Denied("invalid_result_evidence")
                if config["operation"] == "fixture_write" and previous["status"] == "COMPLETED":
                    target = plain_path(folder / "fixture.json")
                    if sha(target.read_bytes()) != sha(FIXTURE):
                        return result("UNKNOWN", "completed_target_drift_requires_reconciliation")
                return {**previous, **result(previous["status"], previous["reason"]),
                        "replayed_evidence_only": True}
            return result("UNKNOWN", "unresolved_intent_no_automatic_retry",
                          idempotency_key=config["idempotency_key"])
        if any(folder.iterdir()):
            raise Denied("unexpected_existing_run_files")
        data = {"configuration_sha256": config_hash, "configuration": config,
                "runner_sha256": sha(Path(__file__).read_bytes()),
                "runtime": sys.version, "executable_sha256": sha(Path(sys.executable).read_bytes()),
                "target": "fixture.json" if config["operation"] == "fixture_write" else None,
                "expected_target_sha256": sha(FIXTURE) if config["operation"] == "fixture_write" else None,
                "authority_effect": "NONE", "qualification": "CANDIDATE_ONLY"}
        persist(intent, data)
        intent_created = True
        observation = execute_worker(config, root)
        if observation.get("stopped"):
            outcome = result("STOPPED", observation["reason"], worker=observation)
        else:
            control(root, config["expected_control_generation"])
            target_sha = None
            if config["operation"] == "fixture_write":
                target = plain_path(folder / "fixture.json")
                with open(target, "xb") as stream:
                    stream.write(FIXTURE)
                    stream.flush()
                    os.fsync(stream.fileno())
                target_sha = sha(target.read_bytes())
            outcome = result("COMPLETED", "local_synthetic_probe_only", worker=observation,
                             target_sha256=target_sha)
        outcome.update({"idempotency_key": config["idempotency_key"],
                        "configuration_sha256": config_hash, "intent_sha256": sha(intent.read_bytes())})
        persist(folder / "result.json", outcome)
        return outcome
    except Denied as error:
        return result("UNKNOWN" if intent_created else "BLOCKED", type(error).__name__ + ":" + str(error))
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        # Persisted intent without a result is deliberately recoverable as UNKNOWN.
        return result("UNKNOWN" if intent_created or existing_intent else "BLOCKED",
                      type(error).__name__ + ":" + str(error))
    finally:
        if lock is not None:
            lock.unlink(missing_ok=True)


def reconcile(evidence_dir, key):
    """Read-only reconciliation observation, never a retry or terminal Gate receipt."""
    try:
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", key):
            raise Denied("invalid_idempotency_key")
        root = plain_path(evidence_dir)
        if (root / ".controller.lock").exists():
            raise Denied("controller_lock_present_requires_operator_reconciliation")
        folder = plain_path(root / "runs" / key)
        intent = read(folder / "intent.json")
        if not isinstance(intent, dict):
            raise Denied("invalid_intent_evidence")
        verify_intent(intent, key)
        target = folder / "fixture.json"
        if intent.get("target") != "fixture.json":
            return result("UNKNOWN", "no_target_observation_cannot_prove_execution")
        plain_path(target)
        if not target.is_file():
            return result("UNKNOWN", "target_absent_not_permission_to_retry")
        matched = sha(target.read_bytes()) == intent.get("expected_target_sha256")
        return result("UNKNOWN", "target_matches_intent" if matched else "target_mismatch",
                      target_matches=matched, new_action_allowed=False,
                      capacity_released=False, terminal_receipt_issued=False)
    except (Denied, OSError, ValueError) as error:
        return result("BLOCKED", type(error).__name__ + ":" + str(error))


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "_worker":
        seconds = float(sys.argv[2])
        if not math.isfinite(seconds) or not 0 <= seconds <= 60:
            raise SystemExit(2)
        worker(seconds)
        return
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    execute = commands.add_parser("run")
    execute.add_argument("--config", required=True, type=Path)
    execute.add_argument("--evidence-dir", required=True, type=Path)
    recover = commands.add_parser("reconcile")
    recover.add_argument("--evidence-dir", required=True, type=Path)
    recover.add_argument("--idempotency-key", required=True)
    args = parser.parse_args()
    try:
        outcome = (run(read(args.config), args.evidence_dir) if args.command == "run"
                   else reconcile(args.evidence_dir, args.idempotency_key))
    except (OSError, ValueError) as error:
        outcome = result("BLOCKED", type(error).__name__ + ":" + str(error))
    print(json.dumps(outcome, ensure_ascii=False))
    raise SystemExit(0 if outcome["status"] == "COMPLETED" else 2)


if __name__ == "__main__":
    main()
