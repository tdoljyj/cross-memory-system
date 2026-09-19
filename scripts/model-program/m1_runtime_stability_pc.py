#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

SCRIPT_PATH = Path(__file__).resolve()
ROOT = SCRIPT_PATH.parents[2]
DEFAULT_CANDIDATE = ROOT / "development/contracts/model-program/m1/governance/ExperimentAuthorizationProfile.M1-STAB-QWEN35-08B-PC-001.candidate.json"


class StabilityError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def canonical_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def normalized_text_sha256(path: Path) -> str:
    text = path.read_text(encoding="utf-8").replace("\r\n", "\n").replace("\r", "\n")
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def append_jsonl(path: Path, event: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n")


def now_utc() -> str:
    import datetime
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def validate_execution_profile(profile: dict[str, Any]) -> tuple[bool, str]:
    if profile.get("task_id") != "M1-07":
        return False, "M1_07_TASK_ID"
    if profile.get("status") != "ISSUED":
        return False, "PROFILE_NOT_ISSUED"
    if profile.get("effectful_authority_issued") is not True:
        return False, "EFFECTFUL_AUTHORITY_NOT_ISSUED"
    if profile.get("authority_effect") != "M1-07_PC_RUNTIME_STABILITY_EXECUTION_ONLY":
        return False, "M1_07_AUTHORITY_EFFECT"

    auth = profile.get("owner_final_execution_authorization") or {}
    if auth.get("present") is not True or not auth.get("owner_message"):
        return False, "OWNER_FINAL_EXECUTION_AUTHORIZATION_MISSING"

    code = profile.get("code_revision") or {}
    if code.get("status") != "EXACT_BOUND":
        return False, "EXECUTION_CODE_BINDING_UNRESOLVED"
    expected_script_sha = code.get("required_script_normalized_sha256")
    if not expected_script_sha or expected_script_sha == "TO_BE_BOUND":
        return False, "EXECUTION_CODE_BINDING_UNRESOLVED"
    if normalized_text_sha256(SCRIPT_PATH) != expected_script_sha:
        return False, "EXECUTION_SCRIPT_SHA256_DRIFT"

    expiry = profile.get("expiry")
    if not expiry or expiry == "TO_BE_BOUND_AT_FINAL_ISSUANCE":
        return False, "EXPIRY_UNRESOLVED"
    try:
        import datetime
        expiry_dt = datetime.datetime.fromisoformat(expiry.replace("Z", "+00:00"))
        if datetime.datetime.now(datetime.timezone.utc) >= expiry_dt:
            return False, "PROFILE_EXPIRED"
    except Exception:
        return False, "EXPIRY_INVALID"

    return True, "READY"


def server_config(profile: dict[str, Any]) -> dict[str, Any]:
    return ((profile.get("config_revision") or {}).get("server") or {})


def model_binding(profile: dict[str, Any]) -> dict[str, Any]:
    return ((profile.get("exact_model_ids_and_revisions") or {}).get("stability_subject") or {})


def runtime_binding(profile: dict[str, Any]) -> dict[str, Any]:
    return profile.get("runtime_and_device_profile") or {}


def preflight(profile: dict[str, Any], out_dir: Path) -> dict[str, Any]:
    cfg = server_config(profile)
    if cfg.get("host") != "127.0.0.1" or cfg.get("external_bind") is not False:
        raise StabilityError("NON_LOOPBACK_BIND", "server must bind only to 127.0.0.1")
    if cfg.get("offline") is not True or cfg.get("external_network") is not False:
        raise StabilityError("EXTERNAL_NETWORK_BOUNDARY", "offline/loopback-only boundary missing")
    if cfg.get("device") != "none" or cfg.get("n_gpu_layers") != 0 or cfg.get("op_offload") is not False:
        raise StabilityError("GPU_OFFLOAD_BOUNDARY", "strict CPU-only boundary missing")

    runtime = runtime_binding(profile)
    model = model_binding(profile)
    server_path = Path(runtime["package_root"]) / "runtime" / "b11033-vulkan" / runtime["server_executable"]
    model_path = Path(runtime["exact_model_path"])

    if not server_path.is_file():
        raise StabilityError("SERVER_EXECUTABLE_MISSING", str(server_path))
    if not model_path.is_file():
        raise StabilityError("MODEL_PATH_MISSING", str(model_path))

    server_bytes = server_path.stat().st_size
    model_bytes = model_path.stat().st_size
    server_sha = sha256_file(server_path)
    model_sha = sha256_file(model_path)
    if server_bytes != runtime.get("server_executable_bytes") or server_sha != runtime.get("server_executable_sha256"):
        raise StabilityError("SERVER_EXECUTABLE_DIGEST_DRIFT", server_sha)
    if model_bytes != model.get("bytes") or model_sha != model.get("sha256"):
        raise StabilityError("MODEL_DIGEST_DRIFT", model_sha)

    host = cfg["host"]
    port = int(cfg["port"])
    if not port_is_free(host, port):
        raise StabilityError("PORT_ALREADY_IN_USE", f"{host}:{port}")

    result = {
        "profile_id": profile.get("profile_id"),
        "checked_at_utc": now_utc(),
        "server_path": str(server_path),
        "server_bytes": server_bytes,
        "server_sha256": server_sha,
        "model_path": str(model_path),
        "model_bytes": model_bytes,
        "model_sha256": model_sha,
        "host": host,
        "port": port,
        "port_free": True,
    }
    (out_dir / "M1RuntimeStabilityPreflight.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n"
    )
    return result


def port_is_free(host: str, port: int) -> bool:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
        sock.bind((host, port))
        return True
    except OSError:
        return False
    finally:
        sock.close()


def wait_port_released(host: str, port: int, timeout: float = 10.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if port_is_free(host, port):
            return True
        time.sleep(0.2)
    return False


def build_server_command(profile: dict[str, Any]) -> list[str]:
    cfg = server_config(profile)
    runtime = runtime_binding(profile)
    server_path = Path(runtime["package_root"]) / "runtime" / "b11033-vulkan" / runtime["server_executable"]
    model_path = Path(runtime["exact_model_path"])
    return [
        str(server_path),
        "--model", str(model_path),
        "--offline",
        "--host", str(cfg["host"]),
        "--port", str(cfg["port"]),
        "--no-webui",
        "--threads", str(cfg["threads"]),
        "--threads-batch", str(cfg["threads_batch"]),
        "--ctx-size", str(cfg["ctx_size"]),
        "--parallel", str(cfg["parallel"]),
        "--n-gpu-layers", str(cfg["n_gpu_layers"]),
        "--device", str(cfg["device"]),
        "--no-op-offload",
    ]


def start_server(profile: dict[str, Any], out_dir: Path, label: str) -> tuple[subprocess.Popen[Any], list[str]]:
    cmd = build_server_command(profile)
    stdout_path = out_dir / f"{label}.stdout.txt"
    stderr_path = out_dir / f"{label}.stderr.txt"
    stdout = stdout_path.open("w", encoding="utf-8", newline="\n")
    stderr = stderr_path.open("w", encoding="utf-8", newline="\n")

    creationflags = 0
    startupinfo = None
    if os.name == "nt":
        creationflags |= getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startupinfo.wShowWindow = 0

    proc = subprocess.Popen(
        cmd,
        cwd=str(Path(cmd[0]).parent),
        stdin=subprocess.DEVNULL,
        stdout=stdout,
        stderr=stderr,
        creationflags=creationflags,
        startupinfo=startupinfo,
    )
    proc._clued_stdout_handle = stdout  # type: ignore[attr-defined]
    proc._clued_stderr_handle = stderr  # type: ignore[attr-defined]
    return proc, cmd


def close_server_handles(proc: subprocess.Popen[Any]) -> None:
    for name in ("_clued_stdout_handle", "_clued_stderr_handle"):
        handle = getattr(proc, name, None)
        if handle:
            try:
                handle.close()
            except Exception:
                pass


def owned_process_alive(proc: subprocess.Popen[Any]) -> bool:
    return proc.poll() is None


def graceful_stop_owned(proc: subprocess.Popen[Any], timeout: float = 10.0) -> bool:
    if proc.poll() is not None:
        close_server_handles(proc)
        return True
    try:
        if os.name == "nt" and hasattr(signal, "CTRL_BREAK_EVENT"):
            proc.send_signal(signal.CTRL_BREAK_EVENT)
        else:
            proc.terminate()
        proc.wait(timeout=timeout)
        close_server_handles(proc)
        return True
    except Exception:
        return False


def force_kill_owned(proc: subprocess.Popen[Any], timeout: float = 10.0) -> None:
    if proc.poll() is None:
        proc.kill()
    proc.wait(timeout=timeout)
    close_server_handles(proc)


def request_json(host: str, port: int, method: str, path: str, payload: dict[str, Any] | None = None, timeout: float = 10.0) -> tuple[int, Any]:
    conn = http.client.HTTPConnection(host, port, timeout=timeout)
    try:
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        headers = {} if body is None else {"Content-Type": "application/json"}
        conn.request(method, path, body=body, headers=headers)
        resp = conn.getresponse()
        raw = resp.read()
        data: Any
        try:
            data = json.loads(raw.decode("utf-8")) if raw else None
        except Exception:
            data = raw.decode("utf-8", errors="replace")
        return resp.status, data
    finally:
        conn.close()


def wait_health(host: str, port: int, timeout: float = 60.0) -> float:
    start = time.monotonic()
    deadline = start + timeout
    last_error = ""
    while time.monotonic() < deadline:
        try:
            status, _ = request_json(host, port, "GET", "/health", timeout=2.0)
            if 200 <= status < 300:
                return time.monotonic() - start
            last_error = f"status={status}"
        except Exception as exc:
            last_error = repr(exc)
        time.sleep(0.25)
    raise StabilityError("HEALTH_TIMEOUT", last_error)


def minimal_probe(profile: dict[str, Any]) -> dict[str, Any]:
    cfg = server_config(profile)
    status, data = request_json(
        cfg["host"],
        int(cfg["port"]),
        "POST",
        "/completion",
        {
            "prompt": "Reply with exactly: OK",
            "n_predict": 8,
            "temperature": 0,
            "stream": False,
        },
        timeout=30.0,
    )
    if not (200 <= status < 300):
        raise StabilityError("PROBE_HTTP_FAILURE", f"status={status}")
    return {"status": status, "response": data}


def stream_then_cancel(profile: dict[str, Any]) -> dict[str, Any]:
    cfg = server_config(profile)
    host, port = cfg["host"], int(cfg["port"])
    conn = http.client.HTTPConnection(host, port, timeout=30.0)
    payload = json.dumps({
        "prompt": "Count upward from 1 and keep going with one number per token.",
        "n_predict": 512,
        "temperature": 0,
        "stream": True,
    }).encode("utf-8")
    try:
        conn.request("POST", "/completion", body=payload, headers={"Content-Type": "application/json"})
        resp = conn.getresponse()
        if not (200 <= resp.status < 300):
            raise StabilityError("STREAM_HTTP_FAILURE", f"status={resp.status}")
        first = resp.read(1)
        if not first:
            raise StabilityError("STREAM_NO_DATA", "stream ended before cancellation point")
        return {"http_status": resp.status, "first_byte_hex": first.hex(), "cancelled_by_client_close": True}
    finally:
        conn.close()


def event(events_path: Path, scenario: str, kind: str, **extra: Any) -> None:
    append_jsonl(events_path, {"ts_utc": now_utc(), "scenario": scenario, "kind": kind, **extra})


def run_load_cycles(profile: dict[str, Any], out_dir: Path, events: Path) -> dict[str, Any]:
    cfg = server_config(profile)
    rows = []
    for i in range(1, 4):
        label = f"load-{i:02d}"
        proc, cmd = start_server(profile, out_dir, label)
        event(events, "M1-07-PC-LOAD-001", "server_started", cycle=i, pid=proc.pid, command=cmd)
        try:
            ready = wait_health(cfg["host"], int(cfg["port"]))
            probe = minimal_probe(profile)
            event(events, "M1-07-PC-LOAD-001", "ready", cycle=i, pid=proc.pid, readiness_seconds=ready)
            graceful = graceful_stop_owned(proc)
            if not graceful:
                raise StabilityError("GRACEFUL_STOP_FAILED", f"cycle={i}")
            if not wait_port_released(cfg["host"], int(cfg["port"])):
                raise StabilityError("PORT_RELEASE_TIMEOUT", f"cycle={i}")
            rows.append({"cycle": i, "pid": proc.pid, "readiness_seconds": ready, "probe": probe, "graceful_exit": True})
        finally:
            if owned_process_alive(proc):
                force_kill_owned(proc)
    return {"scenario_id": "M1-07-PC-LOAD-001", "cycles": rows, "pass": len(rows) == 3}


def run_cancel(profile: dict[str, Any], out_dir: Path, events: Path) -> dict[str, Any]:
    cfg = server_config(profile)
    proc, cmd = start_server(profile, out_dir, "cancel")
    event(events, "M1-07-PC-CANCEL-001", "server_started", pid=proc.pid, command=cmd)
    try:
        ready = wait_health(cfg["host"], int(cfg["port"]))
        cancelled = stream_then_cancel(profile)
        time.sleep(0.5)
        alive = owned_process_alive(proc)
        if not alive:
            raise StabilityError("SERVER_CRASHED_AFTER_CANCEL", "server process exited")
        post_health = wait_health(cfg["host"], int(cfg["port"]), timeout=5.0)
        probe = minimal_probe(profile)
        graceful = graceful_stop_owned(proc)
        if not graceful or not wait_port_released(cfg["host"], int(cfg["port"])):
            raise StabilityError("CANCEL_CLEANUP_FAILED", "server did not exit/release port")
        return {
            "scenario_id": "M1-07-PC-CANCEL-001",
            "readiness_seconds": ready,
            "cancel": cancelled,
            "server_alive_after_cancel": alive,
            "post_cancel_health_seconds": post_health,
            "post_cancel_probe": probe,
            "pass": True,
        }
    finally:
        if owned_process_alive(proc):
            force_kill_owned(proc)


def run_background_reconnect(profile: dict[str, Any], out_dir: Path, events: Path) -> dict[str, Any]:
    cfg = server_config(profile)
    proc, cmd = start_server(profile, out_dir, "background")
    pid = proc.pid
    event(events, "M1-07-PC-BACKGROUND-001", "server_started", pid=pid, command=cmd)
    try:
        ready = wait_health(cfg["host"], int(cfg["port"]))
        status, _ = request_json(cfg["host"], int(cfg["port"]), "GET", "/health", timeout=2.0)
        if not (200 <= status < 300):
            raise StabilityError("BACKGROUND_INITIAL_HEALTH_FAILED", str(status))
        time.sleep(10.0)
        same_pid_alive = owned_process_alive(proc)
        if not same_pid_alive:
            raise StabilityError("BACKGROUND_SERVER_EXITED", "server exited while controller detached")
        reconnect = wait_health(cfg["host"], int(cfg["port"]), timeout=5.0)
        probe = minimal_probe(profile)
        graceful = graceful_stop_owned(proc)
        if not graceful or not wait_port_released(cfg["host"], int(cfg["port"])):
            raise StabilityError("BACKGROUND_CLEANUP_FAILED", "server did not exit/release port")
        return {
            "scenario_id": "M1-07-PC-BACKGROUND-001",
            "semantics": "PC_BACKGROUND_SERVICE_CONTINUITY_ONLY / NOT_MOBILE_APP_BACKGROUND_RESUME",
            "pid": pid,
            "readiness_seconds": ready,
            "same_pid_alive_after_10s_no_client": same_pid_alive,
            "reconnect_health_seconds": reconnect,
            "probe": probe,
            "pass": True,
        }
    finally:
        if owned_process_alive(proc):
            force_kill_owned(proc)


def run_crash_restart(profile: dict[str, Any], out_dir: Path, events: Path) -> dict[str, Any]:
    cfg = server_config(profile)
    proc, cmd = start_server(profile, out_dir, "crash-before")
    first_pid = proc.pid
    event(events, "M1-07-PC-CRASH-001", "server_started", pid=first_pid, command=cmd)
    try:
        ready1 = wait_health(cfg["host"], int(cfg["port"]))
        _ = stream_then_cancel(profile)
        force_kill_owned(proc)
        event(events, "M1-07-PC-CRASH-001", "forced_crash", pid=first_pid)
        if not wait_port_released(cfg["host"], int(cfg["port"])):
            raise StabilityError("CRASH_PORT_RELEASE_TIMEOUT", "port not released after forced crash")

        proc2, cmd2 = start_server(profile, out_dir, "crash-after")
        second_pid = proc2.pid
        event(events, "M1-07-PC-CRASH-001", "server_restarted", pid=second_pid, command=cmd2)
        try:
            ready2 = wait_health(cfg["host"], int(cfg["port"]))
            probe = minimal_probe(profile)
            graceful = graceful_stop_owned(proc2)
            if not graceful or not wait_port_released(cfg["host"], int(cfg["port"])):
                raise StabilityError("RESTART_CLEANUP_FAILED", "restarted server did not exit/release port")
        finally:
            if owned_process_alive(proc2):
                force_kill_owned(proc2)

        return {
            "scenario_id": "M1-07-PC-CRASH-001",
            "first_pid": first_pid,
            "second_pid": second_pid,
            "first_readiness_seconds": ready1,
            "restart_readiness_seconds": ready2,
            "post_restart_probe": probe,
            "pass": True,
        }
    finally:
        if owned_process_alive(proc):
            force_kill_owned(proc)


def run(profile: dict[str, Any], output_dir: Path) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=False)
    events = output_dir / "M1RuntimeStabilityEvents.jsonl"
    start = time.monotonic()
    pre = preflight(profile, output_dir)
    event(events, "PROFILE", "preflight_pass", **pre)

    load = run_load_cycles(profile, output_dir, events)
    (output_dir / "M1RuntimeStabilityLoad.json").write_text(json.dumps(load, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    cancel = run_cancel(profile, output_dir, events)
    (output_dir / "M1RuntimeStabilityCancel.json").write_text(json.dumps(cancel, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    background = run_background_reconnect(profile, output_dir, events)
    (output_dir / "M1RuntimeStabilityBackgroundReconnect.json").write_text(json.dumps(background, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    crash = run_crash_restart(profile, output_dir, events)
    (output_dir / "M1RuntimeStabilityCrashRestart.json").write_text(json.dumps(crash, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    runtime = runtime_binding(profile)
    model = model_binding(profile)
    server_path = Path(runtime["package_root"]) / "runtime" / "b11033-vulkan" / runtime["server_executable"]
    model_path = Path(runtime["exact_model_path"])
    digests = {
        "model_sha256_post": sha256_file(model_path),
        "model_sha256_expected": model["sha256"],
        "server_sha256_post": sha256_file(server_path),
        "server_sha256_expected": runtime["server_executable_sha256"],
    }
    digests["pass"] = (
        digests["model_sha256_post"] == digests["model_sha256_expected"]
        and digests["server_sha256_post"] == digests["server_sha256_expected"]
    )
    (output_dir / "M1RuntimeStabilityDigests.json").write_text(json.dumps(digests, indent=2) + "\n", encoding="utf-8")
    if not digests["pass"]:
        raise StabilityError("POST_RUN_DIGEST_DRIFT", json.dumps(digests))

    summary = {
        "profile_id": profile["profile_id"],
        "started_at_utc": pre["checked_at_utc"],
        "ended_at_utc": now_utc(),
        "wall_seconds": round(time.monotonic() - start, 3),
        "load": load["pass"],
        "cancel": cancel["pass"],
        "background_reconnect": background["pass"],
        "crash_restart": crash["pass"],
        "post_run_digests": digests["pass"],
        "pass": all([load["pass"], cancel["pass"], background["pass"], crash["pass"], digests["pass"]]),
    }
    (output_dir / "M1RuntimeStabilityCloseout.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n"
    )
    return summary


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", type=Path, default=DEFAULT_CANDIDATE)
    parser.add_argument("--validate-only", action="store_true", help="validate profile readiness only; never start server")
    parser.add_argument("--execute", action="store_true", help="execute M1-07 scenarios; requires final ISSUED profile")
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args()

    if args.validate_only and args.execute:
        print("ERROR: choose either --validate-only or --execute", file=sys.stderr)
        return 2
    if not args.validate_only and not args.execute:
        args.validate_only = True

    profile = load_json(args.profile)
    ready, reason = validate_execution_profile(profile)

    if args.validate_only:
        print(json.dumps({
            "profile_id": profile.get("profile_id"),
            "status": profile.get("status"),
            "effectful_authority_issued": profile.get("effectful_authority_issued"),
            "execution_ready": ready,
            "reason": reason,
            "server_started": False,
            "model_loaded": False,
        }, ensure_ascii=False))
        return 0 if not ready else 0

    if not ready:
        print(f"BLOCKED: {reason}", file=sys.stderr)
        return 3
    if args.output_dir is None:
        print("ERROR: --output-dir is required with --execute", file=sys.stderr)
        return 2

    try:
        result = run(profile, args.output_dir)
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result.get("pass") else 1
    except StabilityError as exc:
        print(json.dumps({"status": "FAIL_CLOSED", "code": exc.code, "message": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
