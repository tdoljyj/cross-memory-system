#!/usr/bin/env python3
"""Deterministic, model-free health check for the Clued self-hosted CI pool."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


SCHEMA = "clued.ci-health-report/v1"
DEFAULT_REPOSITORY = "tdoljyj/cross-memory-system"
DEFAULT_STARTUP_DELAY_SECONDS = 300
DEFAULT_MINIMUM_REPEATS = 2
DEFAULT_LOOKBACK_HOURS = 24
HEARTBEAT_WORKFLOW = "clued-ci-runner-heartbeat.yml"
HEARTBEAT_PREFIX = "runner-heartbeat / "
TRANSPORT_REF = "automation/clued-ci-health-event"
TRANSPORT_REPORT_PATH = ".github/ci-health-events/latest.json"


def parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def isoformat(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


class GitHubClient:
    def __init__(self, token: str, api_url: str = "https://api.github.com") -> None:
        self.token = token
        self.api_url = api_url.rstrip("/")

    def get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        query = urllib.parse.urlencode(params or {})
        url = f"{self.api_url}{path}"
        if query:
            url = f"{url}?{query}"
        request = urllib.request.Request(
            url,
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {self.token}",
                "User-Agent": "clued-ci-health/1",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"GitHub API GET {path} failed ({exc.code}): {detail}") from exc


def load_inventory(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def host_runners(host: dict[str, Any]) -> list[dict[str, Any]]:
    runners = [host[key] for key in ("windows_runner", "linux_runner") if host.get(key)]
    return runners + list(host.get("additional_linux_runners", []))


def runner_state(host: dict[str, Any], runner: dict[str, Any]) -> str:
    return runner.get("state", host["state"])


def declared_runner_names(inventory: dict[str, Any]) -> set[str]:
    """Every runner the inventory knows about, including ones still enrolling."""
    return {runner["name"] for host in inventory["hosts"] for runner in host_runners(host)}


def build_expectations(inventory: dict[str, Any]) -> tuple[dict[str, dict[str, Any]], dict[str, set[str]]]:
    profiles = inventory["runner_profiles"]
    expected: dict[str, dict[str, Any]] = {}
    pools: dict[str, set[str]] = {}

    for host in inventory["hosts"]:
        site_label = f"site-{host['site']}"
        for runner in host_runners(host):
            if runner_state(host, runner) != "active":
                continue
            profile_name = runner["profile"]
            profile = profiles[profile_name]
            labels = {
                "self-hosted",
                profile["os"],
                profile["arch"],
                site_label,
                *profile["required_custom_labels"],
                *runner.get("capabilities", []),
                *([runner["route_label"]] if runner.get("route_label") else []),
            }
            expected[runner["name"]] = {
                "name": runner["name"],
                "os": profile["os"],
                "pool": profile_name,
                "required_labels": sorted(labels),
            }
            pools.setdefault(profile_name, set()).add(runner["name"])
    return expected, pools


def label_names(runner_or_job: dict[str, Any]) -> set[str]:
    values = runner_or_job.get("labels", [])
    return {
        value["name"] if isinstance(value, dict) else str(value)
        for value in values
    }


def anomaly(code: str, key: str, message: str, **details: Any) -> dict[str, Any]:
    return {"code": code, "key": key, "message": message, "details": details}


def evaluate_runners(
    expected: dict[str, dict[str, Any]],
    pools: dict[str, set[str]],
    actual_runners: list[dict[str, Any]],
    declared: set[str] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    anomalies: list[dict[str, Any]] = []
    actual_by_name = {runner["name"]: runner for runner in actual_runners}
    known = set(expected) | (declared or set())

    for name, contract in sorted(expected.items()):
        runner = actual_by_name.get(name)
        if runner is None:
            anomalies.append(anomaly(
                "RUNNER_MISSING",
                f"runner:{name}:missing",
                f"Expected runner {name} is not registered.",
                runner=name,
            ))
            continue
        if runner.get("os") != contract["os"]:
            anomalies.append(anomaly(
                "RUNNER_OS_DRIFT",
                f"runner:{name}:os:{contract['os']}",
                f"Runner {name} no longer advertises the expected OS.",
                runner=name,
                expected=contract["os"],
                actual=runner.get("os"),
            ))
        missing_labels = sorted(set(contract["required_labels"]) - label_names(runner))
        if missing_labels:
            anomalies.append(anomaly(
                "RUNNER_LABEL_DRIFT",
                f"runner:{name}:labels:{','.join(missing_labels)}",
                f"Runner {name} is missing required labels.",
                runner=name,
                missing_labels=missing_labels,
            ))

    for runner in sorted(actual_runners, key=lambda item: item["name"]):
        if "clued" in label_names(runner) and runner["name"] not in known:
            anomalies.append(anomaly(
                "UNEXPECTED_MANAGED_RUNNER",
                f"runner:{runner['name']}:unexpected",
                f"Managed runner {runner['name']} is absent from node-profiles.json.",
                runner=runner["name"],
            ))

    pool_status: dict[str, Any] = {}
    for pool_name, names in sorted(pools.items()):
        online = [
            name for name in sorted(names)
            if name in actual_by_name and actual_by_name[name].get("status") == "online"
        ]
        busy = [name for name in online if actual_by_name[name].get("busy") is True]
        offline = [name for name in sorted(names) if name not in online]
        pool_status[pool_name] = {"online": online, "busy": busy, "offline_or_missing": offline}
        if not online:
            anomalies.append(anomaly(
                "CAPABILITY_POOL_UNAVAILABLE",
                f"pool:{pool_name}:unavailable",
                f"No online runner is available for {pool_name}.",
                pool=pool_name,
                expected_runners=sorted(names),
            ))

    observations = {
        "expected_runner_count": len(expected),
        "registered_runner_count": len(actual_runners),
        "expected_runners": {
            name: {
                "status": actual_by_name.get(name, {}).get("status", "missing"),
                "busy": actual_by_name.get(name, {}).get("busy"),
                "pool": contract["pool"],
            }
            for name, contract in sorted(expected.items())
        },
        "capability_pools": pool_status,
    }
    return anomalies, observations


def heartbeat_runner_name(job: dict[str, Any]) -> str | None:
    name = str(job.get("name") or "")
    if not name.startswith(HEARTBEAT_PREFIX):
        return None
    return name[len(HEARTBEAT_PREFIX):].strip() or None


def evaluate_runner_routes(
    expected: dict[str, dict[str, Any]],
    jobs: list[dict[str, Any]],
    now: datetime,
    threshold_seconds: int,
    minimum_repeats: int,
    lookback_hours: int,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Infer runner health from secretless exact-label heartbeat routes."""
    since = now - timedelta(hours=lookback_hours)
    by_runner: dict[str, list[dict[str, Any]]] = {name: [] for name in expected}
    anomalies: list[dict[str, Any]] = []

    for job in jobs:
        expected_name = heartbeat_runner_name(job)
        created = parse_time(job.get("created_at"))
        if expected_name not in by_runner or created is None or created < since:
            continue
        by_runner[expected_name].append(job)
        routed_name = str(job.get("runner_name") or "")
        if routed_name and routed_name != expected_name:
            anomalies.append(anomaly(
                "RUNNER_ROUTE_DRIFT",
                f"runner:{expected_name}:routed-to:{routed_name}",
                f"Heartbeat for {expected_name} was routed to a different runner.",
                expected_runner=expected_name,
                actual_runner=routed_name,
                job_id=job.get("id"),
            ))

    route_status: dict[str, Any] = {}
    for name, route_jobs in sorted(by_runner.items()):
        route_jobs.sort(key=lambda item: str(item.get("created_at") or ""), reverse=True)
        slow_queued: list[dict[str, Any]] = []
        last_verified: str | None = None
        for job in route_jobs:
            created = parse_time(job.get("created_at"))
            if created is None:
                continue
            routed_name = str(job.get("runner_name") or "")
            if (
                routed_name == name
                and job.get("status") in {"in_progress", "completed"}
                and job.get("conclusion") not in {"cancelled", "failure", "timed_out"}
            ):
                last_verified = isoformat(created)
                break
            if job.get("status") == "queued":
                delay_seconds = int((now - created).total_seconds())
                if delay_seconds > threshold_seconds:
                    slow_queued.append({
                        "job_id": job.get("id"),
                        "run_id": job.get("run_id"),
                        "created_at": isoformat(created),
                        "delay_seconds": delay_seconds,
                    })

        route_status[name] = {
            "pool": expected[name]["pool"],
            "required_labels": expected[name]["required_labels"],
            "last_verified_at": last_verified,
            "slow_queued_probes": slow_queued[:10],
            "state": (
                "routable" if last_verified
                else "delayed" if slow_queued
                else "awaiting-probe"
            ),
        }
        if len(slow_queued) >= minimum_repeats:
            anomalies.append(anomaly(
                "RUNNER_ROUTE_UNAVAILABLE",
                f"runner:{name}:route-unavailable",
                f"Exact-label heartbeat for {name} exceeded the startup-delay threshold at least {minimum_repeats} times.",
                runner=name,
                pool=expected[name]["pool"],
                threshold_seconds=threshold_seconds,
                minimum_repeats=minimum_repeats,
                probes=slow_queued[:10],
            ))

    return anomalies, {
        "mode": "exact-label-heartbeat",
        "expected_runner_count": len(expected),
        "registered_runner_count": None,
        "routes": route_status,
    }


def job_pool(job: dict[str, Any]) -> str | None:
    labels = label_names(job)
    if {"self-hosted", "Windows", "cap-python312"}.issubset(labels):
        return "windows-general-v1"
    if {"self-hosted", "Linux", "cap-docker-linux"}.issubset(labels):
        return "linux-docker-wsl2-v1"
    return None


def job_wait_end(job: dict[str, Any], now: datetime) -> datetime | None:
    """When a job stopped waiting for a runner; GitHub prefills started_at while queued."""
    if job.get("status") == "queued":
        return now
    if not job.get("runner_name") and job.get("conclusion") == "cancelled":
        # Cancelled before any runner took it: it waited until the cancellation.
        return parse_time(job.get("completed_at")) or now
    return parse_time(job.get("started_at"))


def idle_gaps(
    start: datetime,
    end: datetime,
    busy: list[tuple[datetime, datetime]],
) -> list[tuple[datetime, datetime]]:
    gaps: list[tuple[datetime, datetime]] = []
    cursor = start
    for busy_start, busy_end in sorted(busy):
        if busy_end <= cursor:
            continue
        if busy_start > cursor:
            gaps.append((cursor, min(busy_start, end)))
        cursor = max(cursor, busy_end)
        if cursor >= end:
            break
    if cursor < end:
        gaps.append((cursor, end))
    return [(gap_start, gap_end) for gap_start, gap_end in gaps if gap_end > gap_start]


def classify_wait(
    job: dict[str, Any],
    created: datetime,
    started: datetime,
    jobs: list[dict[str, Any]],
    runner_labels: dict[str, set[str]],
    now: datetime,
    threshold_seconds: int,
) -> dict[str, Any]:
    """Explain a slow start on runner R from the collected jobs.

    runner_occupied: other collected jobs kept R busy for all but at most the
    threshold of the wait. runner_idle_while_work_queued: R ran no collected job
    for longer than the threshold while another job R could serve was waiting
    for that long, which points at R being offline or suspended rather than
    busy. Jobs outside the collected runs are invisible, so both are best-effort.
    """
    runner = str(job.get("runner_name") or "")
    labels = runner_labels.get(runner)
    if labels is None:
        return {"wait_cause": "unexplained"}
    job_id = str(job.get("id"))
    busy: list[tuple[datetime, datetime]] = []
    occupying: list[dict[str, Any]] = []
    for other in jobs:
        if str(other.get("id")) == job_id or other.get("runner_name") != runner:
            continue
        other_start = parse_time(other.get("started_at"))
        other_end = parse_time(other.get("completed_at"))
        if other_end is None and other.get("status") == "in_progress":
            other_end = now
        if other_start is None or other_end is None:
            continue
        if other_end <= created or other_start >= started:
            continue
        busy.append((other_start, other_end))
        occupying.append({"job_id": other.get("id"), "run_id": other.get("run_id"), "name": other.get("name")})
    gaps = idle_gaps(created, started, busy)
    idle_seconds = int(sum((gap_end - gap_start).total_seconds() for gap_start, gap_end in gaps))

    evidence: list[dict[str, Any]] = []
    for gap_start, gap_end in gaps:
        if (gap_end - gap_start).total_seconds() <= threshold_seconds:
            continue
        for other in jobs:
            if str(other.get("id")) == job_id or other.get("runner_name") == runner:
                continue
            if other.get("conclusion") == "skipped" or not label_names(other) <= labels:
                continue
            waited_from = parse_time(other.get("created_at"))
            waited_until = job_wait_end(other, now)
            if waited_from is None or waited_until is None:
                continue
            overlap = (min(gap_end, waited_until) - max(gap_start, waited_from)).total_seconds()
            if overlap >= threshold_seconds:
                evidence.append({"job_id": other.get("id"), "name": other.get("name"), "overlap_seconds": int(overlap)})

    if evidence:
        evidence.sort(key=lambda item: (-item["overlap_seconds"], str(item["job_id"])))
        return {
            "wait_cause": "runner_idle_while_work_queued",
            "idle_seconds": idle_seconds,
            "queued_eligible_jobs": evidence[:10],
        }
    if idle_seconds <= threshold_seconds:
        return {"wait_cause": "runner_occupied", "idle_seconds": idle_seconds, "occupied_by": occupying[:5]}
    return {"wait_cause": "unexplained", "idle_seconds": idle_seconds}


def evaluate_startup_delays(
    jobs: list[dict[str, Any]],
    now: datetime,
    threshold_seconds: int,
    minimum_repeats: int,
    lookback_hours: int,
    runner_labels: dict[str, set[str]] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    since = now - timedelta(hours=lookback_hours)
    slow_by_pool: dict[str, list[dict[str, Any]]] = {}
    seen: set[str] = set()
    runner_labels = runner_labels or {}

    for job in jobs:
        job_id = str(job.get("id") or f"{job.get('run_id')}:{job.get('name')}:{job.get('created_at')}")
        if job_id in seen:
            continue
        seen.add(job_id)
        pool = job_pool(job)
        created = parse_time(job.get("created_at"))
        if pool is None or created is None or created < since:
            continue
        started = parse_time(job.get("started_at"))
        # GitHub may prefill started_at with created_at while a job is still queued.
        # Queue status therefore takes precedence over the timestamp field.
        if job.get("status") == "queued":
            delay_seconds = int((now - created).total_seconds())
            delay_kind = "queued"
        elif started is not None:
            delay_seconds = int((started - created).total_seconds())
            delay_kind = "started"
        else:
            continue
        if delay_seconds <= threshold_seconds:
            continue
        if job.get("wait_cause"):
            # Carried forward from an earlier report, whose job context is gone.
            cause = {
                key: job[key]
                for key in ("wait_cause", "idle_seconds", "occupied_by", "queued_eligible_jobs")
                if key in job
            }
        elif delay_kind == "queued":
            cause = {"wait_cause": "unassigned"}
        else:
            cause = classify_wait(job, created, started, jobs, runner_labels, now, threshold_seconds)
        slow_by_pool.setdefault(pool, []).append({
            "job_id": job_id,
            "run_id": job.get("run_id"),
            "name": job.get("name"),
            "runner_name": job.get("runner_name") or None,
            "created_at": isoformat(created),
            "started_at": isoformat(started) if started else None,
            "delay_seconds": delay_seconds,
            "kind": delay_kind,
            **cause,
        })

    anomalies: list[dict[str, Any]] = []
    idle_evidence: dict[str, dict[str, Any]] = {}
    for pool, slow_jobs in sorted(slow_by_pool.items()):
        slow_jobs.sort(key=lambda item: (item["created_at"], item["job_id"]))
        causes: dict[str, int] = {}
        for item in slow_jobs:
            causes[item["wait_cause"]] = causes.get(item["wait_cause"], 0) + 1
            if item["wait_cause"] == "runner_idle_while_work_queued" and item.get("runner_name"):
                entry = idle_evidence.setdefault(item["runner_name"], {"pool": pool, "probes": [], "queued": {}})
                entry["probes"].append(item)
                for queued in item.get("queued_eligible_jobs", []):
                    entry["queued"][str(queued["job_id"])] = queued
        if len(slow_jobs) >= minimum_repeats:
            anomalies.append(anomaly(
                "REPEATED_STARTUP_DELAY",
                f"pool:{pool}:startup-delay-repeated",
                f"{pool} exceeded the startup-delay threshold at least {minimum_repeats} times.",
                pool=pool,
                threshold_seconds=threshold_seconds,
                minimum_repeats=minimum_repeats,
                occurrences=len(slow_jobs),
                wait_causes=dict(sorted(causes.items())),
                jobs=slow_jobs[-10:],
            ))

    # A runner that sat idle while at least minimum_repeats jobs it could serve
    # each waited past the threshold was unavailable, not merely busy.
    for runner, entry in sorted(idle_evidence.items()):
        if len(entry["queued"]) < minimum_repeats:
            continue
        anomalies.append(anomaly(
            "RUNNER_IDLE_WHILE_WORK_QUEUED",
            f"runner:{runner}:idle-while-work-queued",
            f"{runner} ran no job while at least {minimum_repeats} jobs it could serve waited past the threshold; it was likely offline or suspended.",
            runner=runner,
            pool=entry["pool"],
            threshold_seconds=threshold_seconds,
            minimum_repeats=minimum_repeats,
            queued_eligible_job_count=len(entry["queued"]),
            probes=entry["probes"][-10:],
        ))

    observations = {
        "lookback_hours": lookback_hours,
        "threshold_seconds": threshold_seconds,
        "minimum_repeats": minimum_repeats,
        "slow_occurrences_by_pool": {
            pool: entries for pool, entries in sorted(slow_by_pool.items())
        },
    }
    return anomalies, observations


def anomaly_fingerprint(anomalies: list[dict[str, Any]]) -> str:
    keys = sorted(item["key"] for item in anomalies)
    encoded = json.dumps(keys, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def build_report(
    repository: str,
    inventory: dict[str, Any],
    runners: list[dict[str, Any]] | None,
    jobs: list[dict[str, Any]],
    now: datetime,
    threshold_seconds: int = DEFAULT_STARTUP_DELAY_SECONDS,
    minimum_repeats: int = DEFAULT_MINIMUM_REPEATS,
    lookback_hours: int = DEFAULT_LOOKBACK_HOURS,
) -> dict[str, Any]:
    expected, pools = build_expectations(inventory)
    if runners is None:
        runner_anomalies, runner_observations = evaluate_runner_routes(
            expected, jobs, now, threshold_seconds, minimum_repeats, lookback_hours
        )
    else:
        runner_anomalies, runner_observations = evaluate_runners(
            expected, pools, runners, declared_runner_names(inventory)
        )
        runner_observations["mode"] = "repository-runner-api"
    runner_labels = {name: set(contract["required_labels"]) for name, contract in expected.items()}
    delay_anomalies, delay_observations = evaluate_startup_delays(
        jobs, now, threshold_seconds, minimum_repeats, lookback_hours, runner_labels
    )
    anomalies = sorted(runner_anomalies + delay_anomalies, key=lambda item: item["key"])
    status = "ANOMALY" if anomalies else "HEALTHY"
    return {
        "schema": SCHEMA,
        "repository": repository,
        "observed_at": isoformat(now),
        "status": status,
        "notify_model": status == "ANOMALY",
        "fingerprint": anomaly_fingerprint(anomalies),
        "thresholds": {
            "startup_delay_seconds": threshold_seconds,
            "minimum_repeats": minimum_repeats,
            "lookback_hours": lookback_hours,
        },
        "anomalies": anomalies,
        "observations": {
            "runners": runner_observations,
            "startup_delays": delay_observations,
        },
    }


def collect_recent_jobs(
    client: GitHubClient,
    repository: str,
    since: datetime,
    max_runs: int,
) -> list[dict[str, Any]]:
    runs = client.get(
        f"/repos/{repository}/actions/runs",
        {"created": f">={isoformat(since)}", "per_page": max_runs},
    ).get("workflow_runs", [])
    jobs: list[dict[str, Any]] = []
    for run in runs[:max_runs]:
        page = client.get(
            f"/repos/{repository}/actions/runs/{run['id']}/jobs",
            {"filter": "all", "per_page": 100},
        )
        for job in page.get("jobs", []):
            job.setdefault("run_id", run["id"])
            jobs.append(job)
    return jobs


def collect_workflow_jobs(
    client: GitHubClient,
    repository: str,
    workflow: str,
    since: datetime,
    max_runs: int,
) -> list[dict[str, Any]]:
    try:
        runs = client.get(
            f"/repos/{repository}/actions/workflows/{workflow}/runs",
            {"created": f">={isoformat(since)}", "per_page": max_runs},
        ).get("workflow_runs", [])
    except RuntimeError as exc:
        if "failed (404)" in str(exc):
            return []
        raise
    jobs: list[dict[str, Any]] = []
    for run in runs[:max_runs]:
        page = client.get(
            f"/repos/{repository}/actions/runs/{run['id']}/jobs",
            {"filter": "all", "per_page": 100},
        )
        for job in page.get("jobs", []):
            job.setdefault("run_id", run["id"])
            jobs.append(job)
    return jobs


def previous_delay_jobs(report: dict[str, Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    delays = (
        report.get("observations", {})
        .get("startup_delays", {})
        .get("slow_occurrences_by_pool", {})
    )
    for pool, entries in delays.items():
        if pool == "windows-general-v1":
            labels = ["self-hosted", "Windows", "X64", "clued", "pool-general", "trust-internal", "cap-python312"]
        elif pool == "linux-docker-wsl2-v1":
            labels = ["self-hosted", "Linux", "X64", "clued", "pool-general", "trust-internal", "cap-docker-linux"]
        else:
            continue
        for entry in entries:
            created = parse_time(entry.get("created_at"))
            if created is None:
                continue
            started_at = entry.get("started_at")
            if not started_at:
                started_at = isoformat(created + timedelta(seconds=int(entry.get("delay_seconds") or 0)))
            job = {
                "id": entry.get("job_id"),
                "run_id": entry.get("run_id"),
                "name": entry.get("name"),
                "status": "completed",
                "conclusion": "success",
                "labels": labels,
                "created_at": entry.get("created_at"),
                "started_at": started_at,
            }
            if entry.get("runner_name"):
                job["runner_name"] = entry["runner_name"]
            for key in ("wait_cause", "idle_seconds", "occupied_by", "queued_eligible_jobs"):
                if key in entry:
                    job[key] = entry[key]
            result.append(job)
    return result


def collect_previous_delay_jobs(client: GitHubClient, repository: str) -> list[dict[str, Any]]:
    try:
        response = client.get(
            f"/repos/{repository}/contents/{TRANSPORT_REPORT_PATH}",
            {"ref": TRANSPORT_REF},
        )
    except RuntimeError as exc:
        if "failed (404)" in str(exc):
            return []
        raise
    encoded = str(response.get("content") or "").replace("\n", "")
    if not encoded:
        return []
    report = json.loads(base64.b64decode(encoded).decode("utf-8"))
    return previous_delay_jobs(report)


def load_event_job(event_path: str | None) -> dict[str, Any] | None:
    if not event_path:
        return None
    path = Path(event_path)
    if not path.exists():
        return None
    payload = json.loads(path.read_text(encoding="utf-8"))
    job = payload.get("workflow_job")
    if not isinstance(job, dict):
        return None
    return job


def should_scan_history(job: dict[str, Any] | None, now: datetime, threshold_seconds: int) -> bool:
    if job is None or job_pool(job) is None:
        return False
    created = parse_time(job.get("created_at"))
    started = parse_time(job.get("started_at"))
    if created is None:
        return False
    effective = started or now
    return (effective - created).total_seconds() > threshold_seconds


def write_github_output(report: dict[str, Any]) -> None:
    output_path = os.environ.get("GITHUB_OUTPUT")
    if not output_path:
        return
    with open(output_path, "a", encoding="utf-8") as handle:
        handle.write(f"status={report['status']}\n")
        handle.write(f"notify_model={str(report['notify_model']).lower()}\n")
        handle.write(f"fingerprint={report['fingerprint']}\n")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", default=os.environ.get("GITHUB_REPOSITORY", DEFAULT_REPOSITORY))
    parser.add_argument(
        "--inventory",
        type=Path,
        default=Path(__file__).resolve().with_name("node-profiles.json"),
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--event-path", default=os.environ.get("GITHUB_EVENT_PATH"))
    parser.add_argument("--startup-delay-seconds", type=int, default=DEFAULT_STARTUP_DELAY_SECONDS)
    parser.add_argument("--minimum-repeats", type=int, default=DEFAULT_MINIMUM_REPEATS)
    parser.add_argument("--lookback-hours", type=int, default=DEFAULT_LOOKBACK_HOURS)
    parser.add_argument("--max-runs", type=int, default=50)
    parser.add_argument("--scan-job-history", action="store_true")
    parser.add_argument("--runners-fixture", type=Path)
    parser.add_argument("--jobs-fixture", type=Path)
    parser.add_argument("--fail-on-anomaly", action="store_true")
    args = parser.parse_args()

    now = datetime.now(timezone.utc)
    inventory = load_inventory(args.inventory)
    event_job = load_event_job(args.event_path)

    if args.runners_fixture:
        runners = json.loads(args.runners_fixture.read_text(encoding="utf-8"))["runners"]
        jobs = json.loads(args.jobs_fixture.read_text(encoding="utf-8"))["jobs"] if args.jobs_fixture else []
    else:
        token = os.environ.get("GITHUB_TOKEN")
        if not token:
            raise RuntimeError("GITHUB_TOKEN is required for live collection")
        api_url = os.environ.get("GITHUB_API_URL", "https://api.github.com")
        client = GitHubClient(token, api_url)
        runner_token = os.environ.get("CI_HEALTH_GITHUB_TOKEN") or token
        try:
            runners = GitHubClient(runner_token, api_url).get(
                f"/repos/{args.repository}/actions/runners", {"per_page": 100}
            ).get("runners", [])
        except RuntimeError as exc:
            if "failed (403)" not in str(exc):
                raise
            runners = None
        scan_history = args.scan_job_history or should_scan_history(
            event_job, now, args.startup_delay_seconds
        )
        jobs = []
        if scan_history:
            jobs = collect_recent_jobs(
                client,
                args.repository,
                now - timedelta(hours=args.lookback_hours),
                args.max_runs,
            )
            heartbeat_jobs = collect_workflow_jobs(
                client,
                args.repository,
                HEARTBEAT_WORKFLOW,
                now - timedelta(hours=args.lookback_hours),
                args.max_runs,
            )
            known_job_ids = {str(job.get("id")) for job in jobs}
            jobs.extend(
                job for job in heartbeat_jobs
                if str(job.get("id")) not in known_job_ids
            )
            known_job_ids.update(str(job.get("id")) for job in heartbeat_jobs)
            prior_jobs = collect_previous_delay_jobs(client, args.repository)
            jobs.extend(
                job for job in prior_jobs
                if str(job.get("id")) not in known_job_ids
            )
        if event_job is not None:
            jobs.append(event_job)

    report = build_report(
        args.repository,
        inventory,
        runners,
        jobs,
        now,
        args.startup_delay_seconds,
        args.minimum_repeats,
        args.lookback_hours,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    write_github_output(report)
    print(json.dumps({
        "status": report["status"],
        "notify_model": report["notify_model"],
        "fingerprint": report["fingerprint"],
        "anomaly_codes": [item["code"] for item in report["anomalies"]],
    }, ensure_ascii=False))
    return 2 if args.fail_on_anomaly and report["notify_model"] else 0


if __name__ == "__main__":
    sys.exit(main())
