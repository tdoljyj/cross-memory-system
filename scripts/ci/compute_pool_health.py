#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import sys
import urllib.request
from datetime import datetime, timezone

REPO = os.environ["GITHUB_REPOSITORY"]
TOKEN = os.environ["GITHUB_TOKEN"]
API = "https://api.github.com"
EXPECTED = {
    "clued-ci-company-win-01": {"Windows", "X64", "clued", "pool-general", "trust-internal", "site-company", "cap-python312", "cap-node24"},
    "clued-ci-company-linux-01": {"Linux", "X64", "clued", "pool-general", "trust-internal", "site-company", "cap-docker-linux", "runtime-wsl2"},
    "clued-ci-home-win-01": {"Windows", "X64", "clued", "pool-general", "trust-internal", "site-home", "cap-python312", "cap-node24"},
    "clued-ci-home-linux-01": {"Linux", "X64", "clued", "pool-general", "trust-internal", "site-home", "cap-docker-linux", "runtime-wsl2"},
}

def api(path: str) -> dict:
    request = urllib.request.Request(
        API + path,
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "clued-compute-pool-health",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)

def parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)

def main() -> int:
    runner_payload = api(f"/repos/{REPO}/actions/runners?per_page=100")
    runners = {item["name"]: item for item in runner_payload.get("runners", [])}
    errors: list[str] = []
    warnings: list[str] = []
    records: list[dict[str, object]] = []

    for name, required in EXPECTED.items():
        item = runners.get(name)
        if not item:
            errors.append(f"missing registered runner: {name}")
            records.append({"name": name, "status": "missing", "busy": False, "labels": []})
            continue
        labels = {label["name"] for label in item.get("labels", [])}
        missing_labels = sorted(required - labels)
        if missing_labels:
            errors.append(f"{name} missing labels: {', '.join(missing_labels)}")
        records.append({
            "name": name,
            "status": item.get("status"),
            "busy": bool(item.get("busy")),
            "labels": sorted(labels),
            "missing_labels": missing_labels,
        })

    windows_online = sum(r["status"] == "online" and "Windows" in r["labels"] for r in records)
    linux_online = sum(r["status"] == "online" and "Linux" in r["labels"] for r in records)
    offline = [r["name"] for r in records if r["status"] != "online"]

    if windows_online == 0:
        errors.append("Windows capability pool has zero online runners")
    if linux_online == 0:
        errors.append("Linux capability pool has zero online runners")
    if offline and windows_online and linux_online:
        warnings.append("offline runners: " + ", ".join(offline))

    delay_records: list[dict[str, object]] = []
    runs = api(f"/repos/{REPO}/actions/runs?per_page=20").get("workflow_runs", [])
    for run in runs:
        created = parse_time(run["created_at"])
        jobs = api(f"/repos/{REPO}/actions/runs/{run['id']}/jobs?filter=latest&per_page=100").get("jobs", [])
        for job in jobs:
            runner_name = job.get("runner_name") or ""
            started_at = job.get("started_at")
            if not runner_name.startswith("clued-ci-") or not started_at:
                continue
            delay = max(0, int((parse_time(started_at) - created).total_seconds()))
            delay_records.append({
                "workflow": run.get("name"),
                "job": job.get("name"),
                "runner": runner_name,
                "start_delay_seconds": delay,
            })

    slow = sorted(
        (item for item in delay_records if item["workflow"] != "public-mcp-gate-receipt"),
        key=lambda item: item["start_delay_seconds"],
        reverse=True,
    )[:5]
    if slow and slow[0]["start_delay_seconds"] >= 300:
        warnings.append(f"recent self-hosted start delay reached {slow[0]['start_delay_seconds']}s")

    status = "FAIL" if errors else ("DEGRADED" if warnings else "FULL")
    report = {
        "schema": "clued.compute-pool-health/v1",
        "status": status,
        "windows_online": windows_online,
        "linux_online": linux_online,
        "runners": records,
        "recent_slowest_start_delays": slow,
        "warnings": warnings,
        "errors": errors,
    }
    print(json.dumps(report, indent=2, ensure_ascii=False))

    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as handle:
            handle.write(f"# Clued Compute Pool Health: {status}\n\n")
            handle.write(f"- Windows online: **{windows_online}**\n- Linux online: **{linux_online}**\n")
            if warnings:
                handle.write("\n## Warnings\n" + "".join(f"- {item}\n" for item in warnings))
            if errors:
                handle.write("\n## Errors\n" + "".join(f"- {item}\n" for item in errors))

    return 1 if errors else 0

if __name__ == "__main__":
    sys.exit(main())
