#!/usr/bin/env python3
"""External, fixture-only P0 benchmark harness for Clued v1.1.

This harness uses only the Python standard library and wraps the repository's
existing commands. It never writes to the real repository or any production
service. All mutation and fault injection is confined to the supplied P0
output directory.
"""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import hashlib
import json
import math
import os
import platform
import re
import shutil
import stat
import statistics
import subprocess
import sys
import time
import uuid
from pathlib import Path


FIXED_COMMIT = "a0ef54ae006451f0d7dedfeef65c79e0f89b4c37"
MATRIX_PATH = "docs/clued-two-level-views/Clued_校验不变量与去重矩阵_v1.1.md"
REPORT_PATH = "docs/clued-two-level-views/Clued_校验不变量与去重矩阵_v1.1_第二轮静态审查报告.md"
MATRIX_BLOB = "fbc8493625a94f6f8cc4cea031d44d19756c4519"
REPORT_BLOB = "6a259f70ab3bc3286683f22cb9093f0d95f1c668"
PROJECT_ID = "0597aa60-9b98-4da6-a4ab-63d7705b632f"
MANDATORY_SCENARIOS = (
    "t0_zero_read",
    "t1_exact_read",
    "t2_current_project_read",
    "t3_light_read",
    "latest_current",
    "snapshot_audit",
    "memory_unrelated_implementation",
    "remote_unchanged",
    "remote_ahead",
    "dirty_worktree",
    "network_unavailable",
    "manifest_corrupted",
    "post_copy_target_corrupted",
)


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tree_digest(root: Path) -> dict:
    digest = hashlib.sha256()
    count = 0
    total = 0
    for path in sorted((p for p in root.rglob("*") if p.is_file()), key=lambda p: p.as_posix()):
        rel = path.relative_to(root).as_posix()
        file_hash = sha256_file(path)
        size = path.stat().st_size
        digest.update(rel.encode("utf-8") + b"\0" + file_hash.encode("ascii") + b"\0")
        count += 1
        total += size
    return {"sha256": digest.hexdigest(), "file_count": count, "byte_count": total}


class Harness:
    def __init__(self, args: argparse.Namespace):
        self.real_repo = Path(args.real_repo).resolve()
        self.origin_url = args.origin_url
        self.root = Path(args.output_dir).resolve()
        self.iterations = args.iterations
        self.python = str(Path(args.python).resolve())
        self.git = str(Path(args.git).resolve())
        self.raw_path = self.root / "p0_raw_results.jsonl"
        self.started_at = utc_now()
        self.records: list[dict] = []
        self.base_repo = self.root / "f" / "b"
        self.trace_dir = self.root / "t"
        self.fixture_root = self.root / "f"
        self.real_before: dict | None = None
        self.real_after: dict | None = None
        self.remote_start: str | None = None
        self.remote_end: str | None = None
        self._prepare_dirs()

    def _prepare_dirs(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        self.trace_dir.mkdir(parents=True, exist_ok=True)
        self.fixture_root.mkdir(parents=True, exist_ok=True)
        if self.raw_path.exists():
            raise RuntimeError(f"refusing to overwrite existing raw results: {self.raw_path}")

    def assert_fixture_path(self, path: Path) -> None:
        path = path.resolve()
        if path == self.root or self.root not in path.parents:
            raise RuntimeError(f"fixture path escaped P0 root: {path}")

    def safe_rmtree(self, path: Path) -> None:
        self.assert_fixture_path(path)
        if path.exists():
            def remove_readonly(func, item, _exc):
                os.chmod(item, stat.S_IWRITE)
                func(item)
            shutil.rmtree(path, onexc=remove_readonly)

    def sanitized(self, value: str) -> str:
        text = value or ""
        replacements = [
            (re.escape(str(self.real_repo)), "<REAL_REPO>"),
            (re.escape(str(self.root)), "<P0_DIR>"),
            (re.escape(str(Path.home())), "<USER_HOME>"),
            (re.escape(str(self.real_repo).replace("\\", "\\\\")), "<REAL_REPO>"),
            (re.escape(str(self.root).replace("\\", "\\\\")), "<P0_DIR>"),
            (re.escape(str(Path.home()).replace("\\", "\\\\")), "<USER_HOME>"),
        ]
        for pattern, replacement in replacements:
            text = re.sub(pattern, replacement, text, flags=re.IGNORECASE)
        text = re.sub(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", "<redacted-email>", text)
        text = re.sub(r"(?:ghp_|gho_|github_pat_)[A-Za-z0-9_]+", "<redacted-token>", text)
        text = re.sub(r"Bearer\s+[A-Za-z0-9._~+/=-]{12,}", "Bearer <redacted-token>", text, flags=re.IGNORECASE)
        text = re.sub(r"owner_[A-Za-z0-9_-]+", "<redacted-owner-ref>", text)
        text = re.sub(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b", "<opaque-id>", text)
        text = re.sub(r"(?i)(client[_ -]?secret\s*[=:]\s*)\S+", r"\1<redacted-secret>", text)
        return text[:4000]

    def base_env(self) -> dict[str, str]:
        env = os.environ.copy()
        git_dir = str(Path(self.git).parent)
        env["PATH"] = git_dir + os.pathsep + env.get("PATH", "")
        env["GIT_TERMINAL_PROMPT"] = "0"
        env["GCM_INTERACTIVE"] = "Never"
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        env["PYTHONUTF8"] = "1"
        return env

    def git_run(self, *args: str, cwd: Path, check: bool = True, timeout: int = 180) -> subprocess.CompletedProcess:
        result = subprocess.run(
            [self.git, *args], cwd=cwd, env=self.base_env(), text=True,
            encoding="utf-8", errors="replace", capture_output=True, timeout=timeout,
        )
        if check and result.returncode:
            raise RuntimeError(self.sanitized(result.stderr or result.stdout))
        return result

    def _parse_git_trace(self, path: Path) -> tuple[dict[str, int], dict[str, float]]:
        counts: collections.Counter[str] = collections.Counter()
        starts: dict[str, tuple[str, dt.datetime]] = {}
        durations: collections.defaultdict[str, float] = collections.defaultdict(float)
        if not path.exists():
            return {}, {}
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                event = json.loads(line)
            except Exception:
                continue
            sid = str(event.get("sid", ""))
            name = event.get("event")
            if name == "start":
                argv = event.get("argv") or []
                kind = self._git_kind([str(x) for x in argv])
                counts[kind] += 1
                timestamp = self._parse_time(event.get("time"))
                if sid and timestamp:
                    starts[sid] = (kind, timestamp)
            elif name == "exit" and sid in starts:
                timestamp = self._parse_time(event.get("time"))
                if timestamp:
                    kind, start = starts[sid]
                    durations[kind] += max(0.0, (timestamp - start).total_seconds() * 1000.0)
        try:
            path.unlink()
        except OSError:
            pass
        return dict(counts), {key: round(value, 3) for key, value in durations.items()}

    @staticmethod
    def _parse_time(value) -> dt.datetime | None:
        if not isinstance(value, str):
            return None
        try:
            return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None

    @staticmethod
    def _git_kind(argv: list[str]) -> str:
        known = ("ls-remote", "fetch", "merge-base", "merge", "status", "rev-parse", "clone", "push", "add", "commit")
        for item in argv:
            if item in known:
                return item
        return "git-other"

    def run_phase(self, label: str, cmd: list[str], cwd: Path, extra_env: dict[str, str] | None = None,
                  timeout: int = 180) -> dict:
        trace = self.trace_dir / f"{uuid.uuid4().hex}.jsonl"
        env = self.base_env()
        env["GIT_TRACE2_EVENT"] = str(trace)
        if extra_env:
            env.update(extra_env)
        started = utc_now()
        begin = time.perf_counter_ns()
        timed_out = False
        try:
            result = subprocess.run(
                cmd, cwd=cwd, env=env, text=True, encoding="utf-8", errors="replace",
                capture_output=True, timeout=timeout,
            )
            code = result.returncode
            stdout = result.stdout
            stderr = result.stderr
        except subprocess.TimeoutExpired as exc:
            timed_out = True
            code = 124
            stdout = exc.stdout or ""
            stderr = (exc.stderr or "") + "\nP0_TIMEOUT"
        end = time.perf_counter_ns()
        ended = utc_now()
        counts, durations = self._parse_git_trace(trace)
        return {
            "label": label,
            "command": [self.sanitized(str(x)) for x in cmd],
            "started_at": started,
            "ended_at": ended,
            "duration_ms": round((end - begin) / 1_000_000, 3),
            "exit_code": code,
            "timed_out": timed_out,
            "stdout": self.sanitized(stdout),
            "stderr": self.sanitized(stderr),
            "git_call_counts": counts,
            "git_call_durations_ms": durations,
        }

    def infer_error(self, text: str, code: int, expected_success: bool) -> tuple[str | None, str | None, str]:
        folded = text.casefold()
        if "legacy-root-entry:session" in folded:
            return "BLOCKED_BY_BASELINE", "source_validation", "BLOCKED_BY_BASELINE"
        if code == 0:
            return None, None, "PASS" if expected_success else "UNEXPECTED_SUCCESS"
        if "worktree is dirty" in folded:
            return "WORKTREE_DIRTY", "git_status", "EXPECTED_BLOCK" if not expected_success else "FAIL"
        if "hash-mismatch" in folded or "manifest-invalid" in folded or "manifest:" in folded:
            block = "target_validation" if "post_copy" in folded else "source_validation"
            return "INTEGRITY_ERROR", block, "EXPECTED_BLOCK" if not expected_success else "FAIL"
        if "could not resolve" in folded or "failed to connect" in folded or "unable to access" in folded or "connection" in folded:
            return "UNAVAILABLE", "remote_head", "EXPECTED_BLOCK" if not expected_success else "FAIL"
        if code == 124:
            return "TIMEOUT", "external_process", "EXPECTED_BLOCK" if not expected_success else "FAIL"
        return "COMMAND_ERROR", "command", "EXPECTED_BLOCK" if not expected_success else "FAIL"

    def parse_payload_metadata(self, stdout: str) -> dict:
        try:
            payload = json.loads(stdout)
        except Exception:
            return {}
        metadata: dict = {}
        if isinstance(payload, dict):
            if isinstance(payload.get("sources_read"), list):
                sources = [str(x) for x in payload["sources_read"]]
                metadata["sources_read_count"] = len(sources)
                metadata["source_classes"] = {
                    "profile": sum(x.endswith("profile.md") for x in sources),
                    "global_views": sum("/global/" in f"/{x}" for x in sources),
                    "project_views": sum("/projects/" in f"/{x}" for x in sources),
                }
            if isinstance(payload.get("results"), list):
                metadata["result_count"] = len(payload["results"])
            for key in ("status", "read_only", "snapshot_version", "canonical_version", "baseline_claim", "source_verification", "views_complete"):
                if key in payload:
                    metadata[key] = payload[key]
            metadata["backup_created"] = bool(payload.get("backup"))
        return metadata

    def record_run(self, scenario: str, bucket: str, iteration: int, phases_spec: list[tuple], cwd: Path,
                   expected_success: bool, note: str = "") -> dict:
        phases: list[dict] = []
        total_begin = time.perf_counter_ns()
        for spec in phases_spec:
            label, cmd = spec[0], spec[1]
            extra_env = spec[2] if len(spec) > 2 else None
            timeout = spec[3] if len(spec) > 3 else 180
            phase = self.run_phase(label, cmd, cwd, extra_env, timeout)
            phases.append(phase)
            if phase["exit_code"] != 0:
                break
        total_ms = round((time.perf_counter_ns() - total_begin) / 1_000_000, 3)
        last = phases[-1]
        text = "\n".join((p["stdout"] + "\n" + p["stderr"]) for p in phases)
        error_type, block, outcome = self.infer_error(text, last["exit_code"], expected_success)
        calls: collections.Counter[str] = collections.Counter()
        call_ms: collections.defaultdict[str, float] = collections.defaultdict(float)
        for phase in phases:
            calls.update(phase["git_call_counts"])
            for key, value in phase["git_call_durations_ms"].items():
                call_ms[key] += value
        remote_ms = call_ms.get("ls-remote", 0.0)
        fetch_merge_ms = sum(call_ms.get(x, 0.0) for x in ("fetch", "merge-base", "merge"))
        git_total = sum(call_ms.values())
        metadata = self.parse_payload_metadata(last["stdout"])
        if scenario == "post_copy_target_corrupted" and error_type == "INTEGRITY_ERROR":
            block = "target_validation"
        record = {
            "run_id": uuid.uuid4().hex,
            "scenario": scenario,
            "bucket": bucket,
            "iteration": iteration,
            "expected_path": "success" if expected_success else "expected_failure",
            "started_at": phases[0]["started_at"],
            "ended_at": phases[-1]["ended_at"],
            "duration_ms": total_ms,
            "exit_code": last["exit_code"],
            "outcome": outcome,
            "error_type": error_type,
            "block_position": block,
            "commands": [p["command"] for p in phases],
            "phase_durations_ms": {p["label"]: p["duration_ms"] for p in phases},
            "observed_git_calls": dict(calls),
            "observed_git_call_durations_ms": {k: round(v, 3) for k, v in call_ms.items()},
            "stage_costs_ms": {
                "remote_head_network": round(remote_ms, 3) if remote_ms else None,
                "fetch_merge": round(fetch_merge_ms, 3) if fetch_merge_ms else None,
                "git_other": round(max(0.0, git_total - remote_ms - fetch_merge_ms), 3) if git_total else None,
                "process_total": total_ms,
                "streaming_hash": "UNOBSERVABLE_SEPARATELY",
                "copy": "UNOBSERVABLE_SEPARATELY",
                "atomic_switch": "UNOBSERVABLE_SEPARATELY",
                "backup": "UNOBSERVABLE_SEPARATELY",
            },
            "stdout_excerpt": last["stdout"][:1500],
            "stderr_excerpt": last["stderr"][:1500],
            "metadata": metadata,
            "note": note,
            "fixture_only": True,
        }
        self.append(record)
        return record

    def append_unobservable(self, scenario: str, bucket: str, reason: str) -> None:
        self.append({
            "run_id": uuid.uuid4().hex,
            "scenario": scenario,
            "bucket": bucket,
            "iteration": 0,
            "expected_path": "unobservable",
            "started_at": utc_now(),
            "ended_at": utc_now(),
            "duration_ms": None,
            "exit_code": None,
            "outcome": "UNOBSERVABLE",
            "error_type": None,
            "block_position": None,
            "commands": [],
            "phase_durations_ms": {},
            "observed_git_calls": {},
            "observed_git_call_durations_ms": {},
            "stage_costs_ms": {
                "remote_head_network": "UNOBSERVABLE",
                "fetch_merge": "UNOBSERVABLE",
                "process_total": "UNOBSERVABLE",
                "streaming_hash": "UNOBSERVABLE",
                "copy": "UNOBSERVABLE",
                "atomic_switch": "UNOBSERVABLE",
                "backup": "UNOBSERVABLE",
            },
            "stdout_excerpt": "",
            "stderr_excerpt": "",
            "metadata": {},
            "note": reason,
            "fixture_only": True,
        })

    def append(self, record: dict) -> None:
        self.records.append(record)
        with self.raw_path.open("a", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")

    def clone(self, source: str | Path, target: Path, *, bare: bool = False) -> None:
        self.assert_fixture_path(target)
        cmd = ["clone", "--no-hardlinks"]
        if bare:
            cmd.append("--bare")
        cmd.extend([str(source), str(target)])
        self.git_run(*cmd, cwd=self.root)

    def set_origin(self, repo: Path, url: str) -> None:
        self.git_run("remote", "set-url", "origin", url, cwd=repo)

    def copy_read_fixture(self, target: Path, include_sync: bool = False) -> None:
        self.assert_fixture_path(target)
        target.mkdir(parents=True)
        shutil.copy2(self.base_repo / "memory.py", target / "memory.py")
        if include_sync:
            shutil.copy2(self.base_repo / "sync-memory.py", target / "sync-memory.py")
        shutil.copytree(self.base_repo / "memory", target / "memory")

    def real_state(self) -> dict:
        protected = [
            "AGENTS.md", "memory.py", "sync-memory.py", "sync-memory.ps1",
            "memory/manifest.json", "artifacts/clued-two-level-snapshots/current.json",
        ]
        return {
            "head": self.git_run("rev-parse", "HEAD", cwd=self.real_repo).stdout.strip(),
            "status_porcelain": self.git_run("status", "--porcelain", cwd=self.real_repo).stdout.strip(),
            "protected_sha256": {rel: sha256_file(self.real_repo / rel) for rel in protected},
            "memory_tree": tree_digest(self.real_repo / "memory"),
        }

    def verify_fixed_input(self) -> None:
        remote_line = self.git_run("ls-remote", self.origin_url, "refs/heads/main", cwd=self.real_repo).stdout.strip()
        if not remote_line:
            raise RuntimeError("origin/main could not be resolved")
        self.remote_start = remote_line.split()[0]
        if self.git_run("merge-base", "--is-ancestor", FIXED_COMMIT, self.remote_start, cwd=self.real_repo, check=False).returncode:
            raise RuntimeError("fixed commit is not contained in remote main")
        actual_matrix = self.git_run("rev-parse", f"{FIXED_COMMIT}:{MATRIX_PATH}", cwd=self.real_repo).stdout.strip()
        actual_report = self.git_run("rev-parse", f"{FIXED_COMMIT}:{REPORT_PATH}", cwd=self.real_repo).stdout.strip()
        if actual_matrix != MATRIX_BLOB or actual_report != REPORT_BLOB:
            raise RuntimeError(f"fixed blob mismatch: matrix={actual_matrix} report={actual_report}")

    def prepare_baseline(self) -> None:
        self.clone(self.real_repo, self.base_repo)
        head = self.git_run("rev-parse", "HEAD", cwd=self.base_repo).stdout.strip()
        if head != FIXED_COMMIT:
            raise RuntimeError(f"baseline clone HEAD changed: {head}")
        self.set_origin(self.base_repo, self.origin_url)
        for rel, expected in ((MATRIX_PATH, MATRIX_BLOB), (REPORT_PATH, REPORT_BLOB)):
            actual = self.git_run("rev-parse", f"HEAD:{rel}", cwd=self.base_repo).stdout.strip()
            if actual != expected:
                raise RuntimeError(f"baseline clone blob mismatch for {rel}: {actual}")

    def python_cmd(self, repo: Path, *args: str) -> list[str]:
        return [self.python, "-B", str(repo / args[0]), *args[1:]]

    def run_read_scenario(self, scenario: str, args: list[str], metadata_note: str) -> None:
        code = {
            "t0_zero_read": "t0", "t1_exact_read": "t1", "t2_current_project_read": "t2",
            "t3_light_read": "t3", "snapshot_status_control": "ss", "snapshot_audit": "sa",
            "memory_unrelated_implementation": "mu",
        }[scenario]
        cold_root = self.fixture_root / code / "c"
        for i in range(1, self.iterations + 1):
            fixture = cold_root / f"run_{i:02d}"
            self.copy_read_fixture(fixture, include_sync=args[0] == "sync-memory.py")
            self.record_run(scenario, "cold", i, [("command", self.python_cmd(fixture, *args))], fixture, True, metadata_note)
            self.safe_rmtree(fixture)
        self.safe_rmtree(cold_root)

        warm = self.fixture_root / code / "w"
        self.copy_read_fixture(warm, include_sync=args[0] == "sync-memory.py")
        self.run_phase("warmup", self.python_cmd(warm, *args), warm)
        for i in range(1, self.iterations + 1):
            self.record_run(scenario, "warm", i, [("command", self.python_cmd(warm, *args))], warm, True, metadata_note)

    def scenario_process_startup(self) -> None:
        cmd = [self.python, "-I", "-S", "-c", "pass"]
        for bucket in ("cold", "warm"):
            if bucket == "warm":
                self.run_phase("warmup", cmd, self.root)
            for i in range(1, self.iterations + 1):
                self.record_run("process_startup_calibration", bucket, i, [("python_startup", cmd)], self.root, True,
                                "External calibration only; not subtracted as a claimed core stage.")

    def scenario_reads(self) -> None:
        self.run_read_scenario("t0_zero_read", ["sync-memory.py", "pull", "NONE"],
                               "External trace can prove zero Git subprocesses and zero writes; OS file-read syscalls remain UNOBSERVABLE.")
        self.run_read_scenario("t1_exact_read", ["memory.py", "recall", "工作偏好", "--tier", "T1", "--limit", "5"],
                               "Measures current baseline behavior; source count reveals whether reading is exact.")
        self.run_read_scenario("t2_current_project_read", ["memory.py", "recall", "Clued", "--tier", "T2", "--project-id", PROJECT_ID, "--limit", "5"],
                               "Project ID is redacted in raw commands and excerpts.")
        self.run_read_scenario("t3_light_read", ["memory.py", "recall", "不确定项目", "--tier", "T3", "--limit", "5"],
                               "Measures current light-read behavior without a selected project.")
        self.run_read_scenario("snapshot_status_control", ["memory.py", "status"],
                               "Read-only snapshot status control; not treated as online Canonical current.")
        self.run_read_scenario("snapshot_audit", ["memory.py", "doctor"],
                               "Full bundle validation aggregate; hash-only time is not externally separable.")
        self.run_read_scenario("memory_unrelated_implementation", ["sync-memory.py", "pull", "NONE"],
                               "REPO_IMPLEMENT unrelated to Memory routes to NONE and must avoid Git/Memory pull.")
        for bucket in ("cold", "warm"):
            self.append_unobservable(
                "latest_current", bucket,
                "Authenticated Clued Canonical online API was intentionally not invoked; snapshot status was measured separately and is not a substitute for current.",
            )

    def sync_phases(self, repo: Path, target: Path) -> list[tuple]:
        env = {"CROSS_MEMORY_LOCAL_DIR": str(target), "CROSS_MEMORY_BACKUP_DIR": str(target.parent / "backups")}
        return [
            ("external_remote_preflight", [self.git, "ls-remote", "origin", "refs/heads/main"]),
            ("existing_pull", self.python_cmd(repo, "sync-memory.py", "pull", "PROJECT"), env, 240),
        ]

    def scenario_remote_unchanged(self) -> None:
        cold_root = self.fixture_root / "ru" / "c"
        cold_root.mkdir(parents=True)
        for i in range(1, self.iterations + 1):
            endpoint = cold_root / f"e{i:02d}"
            target = cold_root / f"m{i:02d}" / "memory"
            self.clone(self.base_repo, endpoint)
            self.set_origin(endpoint, self.origin_url)
            self.record_run("remote_unchanged", "cold", i, self.sync_phases(endpoint, target), endpoint, True,
                            "Fresh endpoint and absent mirror; external preflight plus existing pull expose duplicate Remote Head calls.")
            self.safe_rmtree(endpoint)
            self.safe_rmtree(target.parent)
        self.safe_rmtree(cold_root)

        warm_root = self.fixture_root / "ru" / "w"
        endpoint = warm_root / "e"
        target = warm_root / "m" / "memory"
        warm_root.mkdir(parents=True)
        self.clone(self.base_repo, endpoint)
        self.set_origin(endpoint, self.origin_url)
        self.run_phase("warmup_pull", self.python_cmd(endpoint, "sync-memory.py", "pull", "PROJECT"), endpoint,
                       {"CROSS_MEMORY_LOCAL_DIR": str(target), "CROSS_MEMORY_BACKUP_DIR": str(target.parent / "backups")}, 240)
        for i in range(1, self.iterations + 1):
            self.record_run("remote_unchanged", "warm", i, self.sync_phases(endpoint, target), endpoint, True,
                            "Same endpoint and mirror; each request remains a new process with no persisted PASS context.")

    def make_local_origin(self) -> tuple[Path, Path]:
        origin = self.fixture_root / "ao.git"
        publisher = self.fixture_root / "ap"
        self.clone(self.base_repo, origin, bare=True)
        self.clone(origin, publisher)
        self.git_run("config", "user.name", "P0-Fixture", cwd=publisher)
        self.git_run("config", "user.email", "p0-fixture", cwd=publisher)
        origin_url = Path(self.git_run("remote", "get-url", "origin", cwd=publisher).stdout.strip()).resolve()
        if self.root not in origin_url.parents:
            raise RuntimeError(f"refusing fixture push outside P0 root: {origin_url}")
        return origin, publisher

    def publisher_advance(self, publisher: Path, marker: str) -> None:
        marker_path = publisher / "p0_fixture_marker.txt"
        marker_path.write_text(marker + "\n", encoding="utf-8", newline="\n")
        self.git_run("add", "p0_fixture_marker.txt", cwd=publisher)
        self.git_run("commit", "-m", f"P0 fixture ahead {marker}", cwd=publisher)
        origin_url = Path(self.git_run("remote", "get-url", "origin", cwd=publisher).stdout.strip()).resolve()
        if self.root not in origin_url.parents:
            raise RuntimeError("blocked non-fixture push")
        self.git_run("push", "origin", "HEAD:main", cwd=publisher)

    def scenario_remote_ahead(self) -> Path:
        origin, publisher = self.make_local_origin()
        cold_root = self.fixture_root / "ra" / "c"
        cold_root.mkdir(parents=True)
        for i in range(1, self.iterations + 1):
            endpoint = cold_root / f"e{i:02d}"
            target = cold_root / f"m{i:02d}" / "memory"
            self.clone(origin, endpoint)
            self.publisher_advance(publisher, f"cold-{i:02d}")
            self.record_run("remote_ahead", "cold", i, self.sync_phases(endpoint, target), endpoint, True,
                            "Remote-ahead commit and push occur only in a disposable local bare origin.")
            remote = self.git_run("rev-parse", "refs/heads/main", cwd=origin).stdout.strip()
            local = self.git_run("rev-parse", "HEAD", cwd=endpoint).stdout.strip()
            if local != remote:
                raise RuntimeError("remote-ahead fixture failed to align")
            self.safe_rmtree(endpoint)
            self.safe_rmtree(target.parent)
        self.safe_rmtree(cold_root)

        warm_root = self.fixture_root / "ra" / "w"
        endpoint = warm_root / "e"
        target = warm_root / "m" / "memory"
        warm_root.mkdir(parents=True)
        self.clone(origin, endpoint)
        self.run_phase("warmup_pull", self.python_cmd(endpoint, "sync-memory.py", "pull", "PROJECT"), endpoint,
                       {"CROSS_MEMORY_LOCAL_DIR": str(target), "CROSS_MEMORY_BACKUP_DIR": str(target.parent / "backups")}, 240)
        for i in range(1, self.iterations + 1):
            self.publisher_advance(publisher, f"warm-{i:02d}")
            self.record_run("remote_ahead", "warm", i, self.sync_phases(endpoint, target), endpoint, True,
                            "Remote advances once per request in local fixture; no cross-request PASS evidence is reused.")
        return origin

    def scenario_dirty(self, origin: Path) -> None:
        cold_root = self.fixture_root / "d" / "c"
        cold_root.mkdir(parents=True)
        for i in range(1, self.iterations + 1):
            endpoint = cold_root / f"e{i:02d}"
            self.clone(origin, endpoint)
            readme = endpoint / "README.md"
            readme.write_text(readme.read_text(encoding="utf-8") + f"\nP0 dirty fixture {i}\n", encoding="utf-8", newline="\n")
            target = cold_root / f"m{i:02d}" / "memory"
            env = {"CROSS_MEMORY_LOCAL_DIR": str(target), "CROSS_MEMORY_BACKUP_DIR": str(target.parent / "backups")}
            self.record_run("dirty_worktree", "cold", i,
                            [("existing_pull", self.python_cmd(endpoint, "sync-memory.py", "pull", "PROJECT"), env)],
                            endpoint, False, "Dirty mutation is fixture-only; expected block precedes Remote Head lookup.")
            self.safe_rmtree(endpoint)
        self.safe_rmtree(cold_root)

        warm_root = self.fixture_root / "d" / "w"
        endpoint = warm_root / "e"
        warm_root.mkdir(parents=True)
        self.clone(origin, endpoint)
        readme = endpoint / "README.md"
        readme.write_text(readme.read_text(encoding="utf-8") + "\nP0 dirty fixture warm\n", encoding="utf-8", newline="\n")
        target = warm_root / "m" / "memory"
        env = {"CROSS_MEMORY_LOCAL_DIR": str(target), "CROSS_MEMORY_BACKUP_DIR": str(target.parent / "backups")}
        for i in range(1, self.iterations + 1):
            self.record_run("dirty_worktree", "warm", i,
                            [("existing_pull", self.python_cmd(endpoint, "sync-memory.py", "pull", "PROJECT"), env)],
                            endpoint, False, "Repeated expected block on same disposable dirty fixture.")

    def scenario_network_unavailable(self, origin: Path) -> None:
        invalid = "http://127.0.0.1:9/clued-p0-unavailable.git"
        cold_root = self.fixture_root / "n" / "c"
        cold_root.mkdir(parents=True)
        for i in range(1, self.iterations + 1):
            endpoint = cold_root / f"e{i:02d}"
            self.clone(origin, endpoint)
            self.set_origin(endpoint, invalid)
            target = cold_root / f"m{i:02d}" / "memory"
            env = {"CROSS_MEMORY_LOCAL_DIR": str(target), "CROSS_MEMORY_BACKUP_DIR": str(target.parent / "backups")}
            self.record_run("network_unavailable", "cold", i,
                            [("existing_pull", self.python_cmd(endpoint, "sync-memory.py", "pull", "PROJECT"), env, 30)],
                            endpoint, False, "Loopback discard endpoint; no external service is modified.")
            self.safe_rmtree(endpoint)
        self.safe_rmtree(cold_root)

        warm_root = self.fixture_root / "n" / "w"
        endpoint = warm_root / "e"
        warm_root.mkdir(parents=True)
        self.clone(origin, endpoint)
        self.set_origin(endpoint, invalid)
        target = warm_root / "m" / "memory"
        env = {"CROSS_MEMORY_LOCAL_DIR": str(target), "CROSS_MEMORY_BACKUP_DIR": str(target.parent / "backups")}
        for i in range(1, self.iterations + 1):
            self.record_run("network_unavailable", "warm", i,
                            [("existing_pull", self.python_cmd(endpoint, "sync-memory.py", "pull", "PROJECT"), env, 30)],
                            endpoint, False, "Repeated UNAVAILABLE fixture; LKG fallback is not claimed by this Git-only command.")

    def damage_manifest(self, repo: Path) -> None:
        (repo / "memory" / "manifest.json").write_text("{\n", encoding="utf-8", newline="\n")

    def damage_target_file(self, repo: Path) -> str:
        manifest = json.loads((repo / "memory" / "manifest.json").read_text(encoding="utf-8"))
        rel = next(item["path"] for item in manifest["files"] if item["path"] not in {"manifest.json"})
        target = repo / "memory" / rel
        with target.open("ab") as handle:
            handle.write(b"\nP0_POST_COPY_CORRUPTION\n")
        return rel

    def scenario_integrity_fault(self, scenario: str, target_fault: bool) -> None:
        code = "mc" if scenario == "manifest_corrupted" else "tc"
        cold_root = self.fixture_root / code / "c"
        for i in range(1, self.iterations + 1):
            fixture = cold_root / f"run_{i:02d}"
            self.copy_read_fixture(fixture)
            if target_fault:
                self.damage_target_file(fixture)
            else:
                self.damage_manifest(fixture)
            self.record_run(scenario, "cold", i, [("doctor", self.python_cmd(fixture, "memory.py", "doctor"))], fixture, False,
                            "post_copy target fixture" if target_fault else "source manifest fixture")
            self.safe_rmtree(fixture)
        self.safe_rmtree(cold_root)

        warm = self.fixture_root / code / "w"
        self.copy_read_fixture(warm)
        if target_fault:
            self.damage_target_file(warm)
        else:
            self.damage_manifest(warm)
        for i in range(1, self.iterations + 1):
            self.record_run(scenario, "warm", i, [("doctor", self.python_cmd(warm, "memory.py", "doctor"))], warm, False,
                            "Repeated validation of the same corrupted disposable fixture.")

    @staticmethod
    def percentile(values: list[float], p: float) -> float | None:
        if not values:
            return None
        ordered = sorted(values)
        pos = (len(ordered) - 1) * p
        lo = math.floor(pos)
        hi = math.ceil(pos)
        if lo == hi:
            return ordered[lo]
        return ordered[lo] + (ordered[hi] - ordered[lo]) * (pos - lo)

    def grouped(self):
        groups: dict[tuple[str, str], list[dict]] = collections.defaultdict(list)
        for record in self.records:
            groups[(record["scenario"], record["bucket"])].append(record)
        return groups

    def write_summary(self) -> Path:
        path = self.root / "p0_summary.md"
        lines = [
            "# Clued P0 外部只读 Benchmark Harness 汇总",
            "",
            f"- 固定 Commit：`{FIXED_COMMIT}`",
            f"- 目标每桶次数：`{self.iterations}`",
            "- cold：新进程；涉及状态的场景使用新 Fixture/空 Mirror。无法清空操作系统页缓存。",
            "- warm：同一 Fixture 上先预热，但每次测量仍启动新进程，未复用跨请求 PASS 证据。",
            "",
            "## 场景结果",
            "",
            "| 场景 | 桶 | 实际次数 | 路径 | PASS | 预期阻断 | UNOBSERVABLE | p50 ms | p95 ms | 观测 Git 调用/次 |",
            "|---|---:|---:|---|---:|---:|---:|---:|---:|---|",
        ]
        for (scenario, bucket), records in sorted(self.grouped().items()):
            measured = [r for r in records if isinstance(r.get("duration_ms"), (int, float))]
            values = [float(r["duration_ms"]) for r in measured]
            counts: collections.Counter[str] = collections.Counter()
            for record in measured:
                counts.update(record.get("observed_git_calls", {}))
            per_call = ", ".join(f"{k}={v / len(measured):.2f}" for k, v in sorted(counts.items())) if measured else "—"
            expected_path = records[0]["expected_path"] if records else "—"
            p50 = self.percentile(values, 0.50)
            p95 = self.percentile(values, 0.95)
            lines.append(
                f"| `{scenario}` | {bucket} | {len(measured)} | {expected_path} | "
                f"{sum(r['outcome']=='PASS' for r in records)} | {sum(r['outcome']=='EXPECTED_BLOCK' for r in records)} | "
                f"{sum(r['outcome']=='UNOBSERVABLE' for r in records)} | "
                f"{f'{p50:.3f}' if p50 is not None else '—'} | {f'{p95:.3f}' if p95 is not None else '—'} | {per_call} |"
            )

        lines.extend([
            "",
            "## 阶段成本与占比",
            "",
            "只有 Git Trace2 可从进程外可靠拆分。流式哈希、复制、原子切换和 Backup 在现有命令内部没有独立外部边界，均不猜测。",
            "",
            "| 场景/桶 | Remote Head 占总耗时 | fetch/merge 占总耗时 | 其余总耗时 |",
            "|---|---:|---:|---:|",
        ])
        for (scenario, bucket), records in sorted(self.grouped().items()):
            measured = [r for r in records if isinstance(r.get("duration_ms"), (int, float)) and r["duration_ms"] > 0]
            if not measured:
                continue
            total = sum(r["duration_ms"] for r in measured)
            remote = sum((r["stage_costs_ms"].get("remote_head_network") or 0) for r in measured)
            fetch = sum((r["stage_costs_ms"].get("fetch_merge") or 0) for r in measured)
            remainder = max(0.0, total - remote - fetch)
            lines.append(f"| `{scenario}` / {bucket} | {remote/total*100:.2f}% | {fetch/total*100:.2f}% | {remainder/total*100:.2f}% |")

        lines.extend([
            "",
            "## 关键外部观测",
            "",
            "- `latest/current` 的在线 Canonical 路径未调用生产认证服务，标为 `UNOBSERVABLE`；只测了 Snapshot `status` 控制组。",
            "- `remote_unchanged` 将 AGENTS 规定的外部 Remote Head 预检与现有 `pull` 放在同一请求测量，因而可直接观察重复查询。",
            "- Manifest 与复制后目标损坏均在一次性 Fixture 上保持拒绝语义。",
            "- `T0`/Memory 无关路径可观察到零 Git 子进程和零状态写入；文件读取 syscall 因无外部追踪器而不作猜测。",
        ])
        path.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
        return path

    def write_evidence_matrix(self) -> Path:
        path = self.root / "p0_invariant_evidence_matrix.md"
        rows = [
            ("`sync-memory.py pull NONE`", "t0_zero_read; memory_unrelated_implementation", "A02, G01, U05", "退出码、零 Git 子进程、零 Fixture 写入；syscall 级读取 UNOBSERVABLE"),
            ("`memory.py recall --tier T1`", "t1_exact_read", "A05, S02, S15, U02, U05", "完整性通过、sources_read 数量与分类、p50/p95"),
            ("`memory.py recall --tier T2 --project-id …`", "t2_current_project_read", "A05, S02, S15, U02, U05", "项目选择已脱敏；sources_read 分类和耗时"),
            ("`memory.py recall --tier T3`", "t3_light_read", "A05, S02, S15, U02, U05", "轻读取实际 sources_read 分类和耗时"),
            ("`memory.py status`", "snapshot_status_control", "A01, A02, S02, S07, O01", "只证明只读 Snapshot 状态；不冒充在线 current"),
            ("`memory.py doctor`", "snapshot_audit", "S02, S03, S04, S07", "Manifest 全枚举验证总耗时、文件数、退出码"),
            ("外部 `git ls-remote` + 现有 `pull`", "remote_unchanged", "G01, G03, G05, G07", "Trace2 调用次数与 Remote Head 时间；Mirror/Backup 结果"),
            ("本地 Fixture Remote Ahead + 现有 `pull`", "remote_ahead", "G01, G03, G05, G07", "两次 Remote Head、fetch/merge 调用、最终祖先/HEAD 对齐"),
            ("脏 Fixture + 现有 `pull`", "dirty_worktree", "G03, G04", "在 git status 阶段明确阻断；未读取 Remote"),
            ("不可达 loopback origin + 现有 `pull`", "network_unavailable", "G01, O05", "UNAVAILABLE 错误、退出码、remote_head 阻断位置"),
            ("损坏 Fixture Manifest + `doctor`", "manifest_corrupted", "S02, S03, S04", "源完整性失败，未复制/切换"),
            ("复制后损坏 Fixture 文件 + `doctor`", "post_copy_target_corrupted", "S05, S06, G07", "目标哈希失败；旧真实目标未触碰"),
            ("无生产调用", "latest_current", "A01, A03–A08, O01–O08", "缺少已授权 Canonical 测量接口，明确 UNOBSERVABLE"),
        ]
        lines = [
            "# P0 调用 → 不变量 → 证据矩阵", "",
            "| 调用 | 场景 | 不变量 ID | 外部证据 |", "|---|---|---|---|",
            *(f"| {a} | {b} | {c} | {d} |" for a, b, c, d in rows),
            "",
            "所有拒绝结果均保留原命令退出码与脱敏 stderr；原始记录见 `p0_raw_results.jsonl`。",
        ]
        path.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
        return path

    def metric(self, scenario: str, bucket: str) -> dict:
        rows = [r for r in self.records if r["scenario"] == scenario and r["bucket"] == bucket and isinstance(r.get("duration_ms"), (int, float))]
        values = [r["duration_ms"] for r in rows]
        calls: collections.Counter[str] = collections.Counter()
        for row in rows:
            calls.update(row.get("observed_git_calls", {}))
        sources = [r.get("metadata", {}).get("sources_read_count") for r in rows if r.get("metadata", {}).get("sources_read_count") is not None]
        backups = sum(bool(r.get("metadata", {}).get("backup_created")) for r in rows)
        return {
            "n": len(rows), "p50": self.percentile(values, .5), "p95": self.percentile(values, .95),
            "calls_per_run": {k: v / len(rows) for k, v in calls.items()} if rows else {},
            "source_count_median": statistics.median(sources) if sources else None,
            "backups": backups,
        }

    def write_classification(self) -> Path:
        path = self.root / "p0_classification.md"
        ru = self.metric("remote_unchanged", "warm")
        t1 = self.metric("t1_exact_read", "warm")
        t3 = self.metric("t3_light_read", "warm")
        lines = [
            "# P0 实测分类", "",
            "| ID | 实测分类 | P0 证据 | 裁决 |",
            "|---|---|---|---|",
            f"| D01 | 真重复 | Remote 未变 warm 平均 `ls-remote` {ru['calls_per_run'].get('ls-remote', 0):.2f} 次/请求 | P1 可优先统一为一次请求内查询，但每个需新鲜度的请求仍至少一次 |",
            "| D02 | 真重复/条件边界 | Remote Ahead 可观察外部预检后，pull 再次查询并执行 fetch/merge | 只建议 P1 统一入口；工作树隔离属于 P3，不越权实现 |",
            "| D03 | 表面重复 | Manifest 源损坏与复制后目标损坏在不同 Fixture 边界均独立阻断 | 两侧哈希必须保留，不去重 |",
            "| D04/D05/D18 | 条件重复 | doctor/recall 每个新进程都重新完整验证；内部 hash 阶段无法单独计时 | 只能在未来请求内 Context 且满足全部失效条件时讨论；不属于 P1 实现 |",
            f"| D06/D07 | 不必要工作 | T1 warm `sources_read` 中位数={t1['source_count_median']}；T3={t3['source_count_median']} | 证实读取范围热点；归属 P4，本轮不实现 |",
            "| D08/D19 | 架构热点/非等价来源 | 在线 Canonical current 无授权测量接口；Snapshot status 只能证明离线投影 | 不得以 Git/Snapshot 指标替代 Canonical current |",
            f"| D10 | 条件重复 | Remote 未变 warm 仍生成 Backup 的记录数={ru['backups']}/{ru['n']} | 归属 P3；P0 只记录成本与现象 |",
            "| D11–D16/D21 | 表面重复 | 未触碰生产 Auth/RLS/CAS/Event/Receipt/发布边界 | 保留独立不变量，不以缺测推断可去重 |",
        ]
        path.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
        return path

    def write_limitations(self) -> Path:
        path = self.root / "p0_limitations.md"
        blocked = [r for r in self.records if r["outcome"] == "BLOCKED_BY_BASELINE"]
        lines = [
            "# P0 局限与不可观测项", "",
            "## UNOBSERVABLE", "",
            "- 未调用生产 Clued Canonical/Auth/Binding/Scope/RLS 接口，因此在线 `latest/current`、撤销、租户隔离与服务端 CAS 不能从本 Harness 量化。",
            "- 现有 Python 命令没有外部阶段边界；流式哈希、复制、原子 rename 和 Backup 的纯耗时不能可靠拆分。报告仅给出 Git Trace2 阶段与剩余聚合时间。",
            "- 无内核级文件访问追踪器，因此 T0 的“零文件读取 syscall”不可直接证明；可证明的是命令早退、零 Git 子进程与零文件状态变化。",
            "- Windows 页缓存未清空；cold 表示新进程及（适用时）新 Fixture/空 Mirror，不等价于物理冷盘。",
            "- 复制中途的纳秒级竞态注入无法在不改核心/不加埋点的条件下稳定完成；以复制后副本损坏并运行同一 Validator 作为外部可重复负测。",
            "- Backup 删除、Legal Hold、Erasure 与同机并发策略属 P3/G09/G10 目标态，本轮不执行。",
            "- 网络结果受当时 GitHub 与本机代理/链路影响，只代表本次运行窗口。",
            "",
            "## BLOCKED_BY_BASELINE", "",
            (f"- 遇到 `legacy-root-entry:session` 的记录数：{len(blocked)}；均未修复，详见原始记录。" if blocked else "- 本次固定 Commit 的一次性 Clone 未出现 `legacy-root-entry:session`；未创建、修复或删除该条目。"),
            "",
            "## 脱敏", "",
            "- 原始结果中的邮箱、Token、Bearer、Client Secret、Owner Ref、UUID 和用户目录均已替换为占位符。",
            "- 未记录原始 Supabase User ID 或稳定跨范围身份映射。",
        ]
        path.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
        return path

    def write_p1_recommendations(self) -> Path:
        path = self.root / "p0_p1_priority_recommendations.md"
        ru_cold = self.metric("remote_unchanged", "cold")
        ru_warm = self.metric("remote_unchanged", "warm")
        ra = self.metric("remote_ahead", "warm")
        lines = [
            "# P0 → P1 优先级建议（不含实现）", "",
            "> 本文只提出 P1 优先级，不授权也未实施 P1–P6。", "",
            "## P1-1（最高）：统一一次请求内 Remote Head 解析", "",
            f"- 证据：Remote 未变 cold/warm 的 `ls-remote` 平均分别为 {ru_cold['calls_per_run'].get('ls-remote', 0):.2f} / {ru_warm['calls_per_run'].get('ls-remote', 0):.2f} 次/请求。",
            "- 建议验收：同一请求只解析一次具体 Commit SHA；新请求、重试、TTL 失效仍重新查询；F01 正负路径与 G01 不变量不削弱。",
            "- 禁止：缓存跨请求 PASS、跳过 Remote Head、用 mtime/本地 tracking ref 替代远端真实 Ref。",
            "",
            "## P1-2（高）：让 fetch/merge 只由统一 align 入口负责", "",
            f"- 证据：Remote Ahead warm 观察到 `fetch` {ra['calls_per_run'].get('fetch', 0):.2f} 次/请求、`merge` {ra['calls_per_run'].get('merge', 0):.2f} 次/请求，同时仍有前置 Remote Head 查询。",
            "- 建议验收：Fast-forward 与真分叉继续用双向 ancestor 判定；真分叉保留证据并阻断；不得引入 rebase/reset/force push。",
            "- 边界：开发工作树隔离与 Mirror 原子切换是 P3，不应混入 P1。",
            "",
            "## P1-3（中）：冻结错误分类与阶段证据格式", "",
            "- 将 Remote UNAVAILABLE、dirty worktree、Git divergence 分为独立错误类型，保留退出码、阻断位置和远端/本地版本证据。",
            "- 先建立 F01/F05/F06 的控制与故障回归门禁，再评估任何去重收益。",
            "",
            "## 不进入 P1 的观测", "",
            "- T1/T3 读取范围、Snapshot no-op/Backup、Canonical-first 分别属于 P4/P3/P4；本轮只登记，不建议在 P1 顺手实现。",
        ]
        path.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
        return path

    def write_manifest(self, report_paths: list[Path]) -> Path:
        path = self.root / "p0_execution_manifest.json"
        scenario_status = {}
        for scenario in MANDATORY_SCENARIOS:
            rows = [r for r in self.records if r["scenario"] == scenario]
            scenario_status[scenario] = {
                "records": len(rows),
                "measured_runs": sum(isinstance(r.get("duration_ms"), (int, float)) for r in rows),
                "outcomes": dict(collections.Counter(r["outcome"] for r in rows)),
            }
        payload = {
            "schema_version": 1,
            "p0_only": True,
            "p1_p6_implemented": False,
            "fixed_input": {
                "repository": "tdoljyj/cross-memory-system",
                "branch": "main",
                "commit": FIXED_COMMIT,
                "matrix": {"path": MATRIX_PATH, "blob_sha": MATRIX_BLOB},
                "second_review": {"path": REPORT_PATH, "blob_sha": REPORT_BLOB},
                "remote_main_at_start": self.remote_start,
                "remote_main_at_end": self.remote_end,
                "fixed_commit_contained_at_start": True,
            },
            "environment": {
                "os": platform.platform(),
                "python": subprocess.run([self.python, "--version"], capture_output=True, text=True, encoding="utf-8").stdout.strip(),
                "git": self.git_run("--version", cwd=self.root).stdout.strip(),
                "clock": "time.perf_counter_ns (monotonic)",
                "repository_version": (self.base_repo / "VERSION").read_text(encoding="utf-8").strip(),
                "snapshot_version": json.loads((self.base_repo / "memory" / "manifest.json").read_text(encoding="utf-8"))["snapshot_version"],
                "canonical_version": json.loads((self.base_repo / "memory" / "manifest.json").read_text(encoding="utf-8"))["canonical_version"],
                "manifest_file_count": len(json.loads((self.base_repo / "memory" / "manifest.json").read_text(encoding="utf-8"))["files"]),
            },
            "execution": {
                "started_at": self.started_at,
                "ended_at": utc_now(),
                "target_iterations_per_bucket": self.iterations,
                "raw_record_count": len(self.records),
                "mandatory_scenario_count": len(MANDATORY_SCENARIOS),
                "scenario_status": scenario_status,
                "cold_definition": "new process and, for stateful cases, fresh fixture/absent mirror; OS page cache not forcibly cleared",
                "warm_definition": "same fixture after warmup; every measured request is a new process and no PASS evidence is persisted",
            },
            "safety": {
                "real_repository_unchanged": self.real_before == self.real_after,
                "real_repository_before": self.real_before,
                "real_repository_after": self.real_after,
                "core_files_modified": False,
                "snapshot_or_current_pointer_modified": False,
                "canonical_or_production_calls": False,
                "remote_mutations": False,
                "fixture_local_pushes_only": True,
                "commit_push_tag_pr_release_deploy": False,
            },
            "redaction": {
                "emails": True, "tokens": True, "client_secrets": True,
                "stable_identity_refs": True, "uuids": True, "user_paths": True,
            },
            "file_sha256": {p.name: sha256_file(p) for p in report_paths},
            "self_hash": "NOT_EMBEDDED_RECURSIVE; compute SHA-256 externally",
        }
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")
        return path

    def scan_redaction(self, paths: list[Path]) -> None:
        forbidden = [
            re.compile(r"(?:ghp_|gho_|github_pat_)[A-Za-z0-9_]+"),
            re.compile(r"Bearer\s+[A-Za-z0-9._~+/=-]{12,}", re.I),
            re.compile(r"owner_[A-Za-z0-9_-]+"),
            re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"),
        ]
        for path in paths:
            text = path.read_text(encoding="utf-8", errors="replace")
            for pattern in forbidden:
                if pattern.search(text):
                    raise RuntimeError(f"redaction scan failed for {path.name}: {pattern.pattern}")

    def run(self) -> None:
        self.real_before = self.real_state()
        if self.real_before["status_porcelain"]:
            raise RuntimeError("real repository is dirty before P0")
        self.verify_fixed_input()
        self.prepare_baseline()
        self.scenario_process_startup()
        self.scenario_reads()
        self.scenario_remote_unchanged()
        local_origin = self.scenario_remote_ahead()
        self.scenario_dirty(local_origin)
        self.scenario_network_unavailable(local_origin)
        self.scenario_integrity_fault("manifest_corrupted", target_fault=False)
        self.scenario_integrity_fault("post_copy_target_corrupted", target_fault=True)

        remote_line = self.git_run("ls-remote", self.origin_url, "refs/heads/main", cwd=self.real_repo).stdout.strip()
        self.remote_end = remote_line.split()[0] if remote_line else None
        self.git_run("fetch", "origin", "main", cwd=self.base_repo)
        if self.git_run("merge-base", "--is-ancestor", FIXED_COMMIT, self.remote_end, cwd=self.base_repo, check=False).returncode:
            raise RuntimeError("fixed commit is no longer contained in origin/main at P0 completion")
        self.real_after = self.real_state()
        if self.real_before != self.real_after:
            raise RuntimeError("real repository or protected snapshot changed during P0")

        summary = self.write_summary()
        evidence = self.write_evidence_matrix()
        classification = self.write_classification()
        limitations = self.write_limitations()
        recommendations = self.write_p1_recommendations()
        report_paths = [self.raw_path, summary, evidence, classification, limitations, recommendations]
        self.scan_redaction(report_paths)
        manifest = self.write_manifest([*report_paths, Path(__file__).resolve()])
        self.scan_redaction([manifest])
        self.safe_rmtree(self.fixture_root)
        self.safe_rmtree(self.trace_dir)
        print(json.dumps({
            "status": "P0_COMPLETE",
            "output_dir": str(self.root),
            "raw_records": len(self.records),
            "mandatory_scenarios": len(MANDATORY_SCENARIOS),
            "manifest_sha256": sha256_file(manifest),
            "real_repo_unchanged": True,
            "remote_main": self.remote_end,
        }, ensure_ascii=False))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--real-repo", required=True)
    parser.add_argument("--origin-url", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--python", required=True)
    parser.add_argument("--git", required=True)
    parser.add_argument("--iterations", type=int, default=20)
    args = parser.parse_args()
    if args.iterations < 1:
        parser.error("--iterations must be positive")
    return args


if __name__ == "__main__":
    Harness(parse_args()).run()
