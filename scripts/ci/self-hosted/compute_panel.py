#!/usr/bin/env python3
"""Compute panel for the Clued self-hosted pool (Task 679a0c2b, Decision 183ee67c).

Runs every five minutes on a pool-general runner with the workflow's own
GITHUB_TOKEN and no other credential. It reads:

- the route probes of clued-compute-panel.yml (one job per pool runner) for
  online/offline, the disk/memory line each probe prints and the node
  governance level it reads from the node's governance status file;
- the in-progress jobs of every workflow for busy/idle and the current job;
- the resident executors' info-only PR statuses (resident-queue/<node>) for
  their latest state, HALT and the batch metrics Task 7f205c71 triggers on.

It writes one GitHub issue (the panel, edited in place) and comments on that
issue when an alert starts or ends. Nothing is written to a branch: the
gitleaks history scan reads every branch, and the panel holds no secret.
The runner registration API needs an administration token, so the pool list
below is maintained here; a probe that never runs shows the node as offline.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import http.client
import json
import os
import re
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any


SCHEMA = "clued.compute-panel/v1"
WORKFLOW = "clued-compute-panel.yml"
PROBE_PREFIX = "compute-probe / "
PROBE_LINE = re.compile(r"COMPUTE_PANEL_PROBE (\{.*\})")
GOVERNANCE_LINE = re.compile(r"COMPUTE_PANEL_GOVERNANCE ([^\r\n]{1,512})")
GOVERNANCE_LEVELS = ("green", "yellow", "red")
GOVERNANCE_TIME = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})")
GOVERNANCE_TEXT = {"green": "绿", "yellow": "黄", "red": "红", "unknown": "未知"}
MARKER = "<!-- clued-compute-panel:v1 -->"
STATE_RE = re.compile(r"<!-- clued-compute-panel-state:([A-Za-z0-9+/=]+) -->")
ISSUE_TITLE = "算力面板（自动更新）"
RESIDENT_CONTEXT = re.compile(r"^resident-queue/([A-Za-z0-9._-]{1,40}) \(info only\)$")
GATE_JOB = "admission-gate"

ONLINE_WINDOW = timedelta(minutes=12)
UNPICKED_AFTER = timedelta(minutes=4)
UNPICKED_RUNS = 2
LOOKBACK_RUNS = 4
ACTIVE_RUNS = 20
LOW_ACTIVE_RUNS = 5
RESIDENT_PULLS = 10
HEALTH_EVERY = timedelta(minutes=30)
LOW_BUDGET = 300
METRICS_EVERY = timedelta(minutes=55)
METRICS_PULLS = 50
UTILIZATION_HOURS = 24
LOW_DISK_GB = 20.0
LOW_MEMORY_GB = 1.0
# A raised low-disk or low-memory alert ends only at these (a quarter, a half above the line): available memory
# swings far more than free disk between probes, so it gets the larger share.
DISK_CLEAR_GB = LOW_DISK_GB + 5.0
MEMORY_CLEAR_GB = LOW_MEMORY_GB + 0.5
# CI stall (resident_stall): the resident's DUTY_WINDOW_MS, and the word its node on duty starts each status with.
STALL_AFTER = timedelta(minutes=30)
DUTY_WORD = "当班"
# The per-PR hint the resident writes on a behind head (pr-status.mjs describe): pending while the robot
# (clued-front-main-merge) has yet to take main in, failure in older packages; never a batch result nor a stall.
BEHIND_HINT = "落后 main"

# Duplicate-run alert (Task e435e658, rule 41ab823a: one commit's one check really runs once).
DUP_LOOKBACK = timedelta(days=3)       # PRs updated, and runs started, within this window
DUP_EVERY = timedelta(minutes=55)      # read about once an hour, like the batch metrics
DUP_PULLS = 30                         # newest-updated PRs read per scan (open and closed)
DUP_RESCAN = timedelta(hours=24)       # a PR merged this recently is read again: the resident may reschedule it
DUP_PAGES = 5                          # check-run pages per head (100 each)
DUP_ROWS = 10                          # rows in the panel table and the machine-readable data
DUP_KEEP = 12                          # findings kept with their details in the saved state (the issue body is limited to 65536 characters)
DUP_MAX = 80                           # further findings kept as short records, so the total and the carry-over stay right
DUP_ANNOUNCED = 300                    # announced duplicate keys kept (as short tokens), apart from the 200 other events
DUP_ATTEMPTS = 3                       # tries per request on a 5xx or a network error
DUP_BACKOFF = 2.0                      # seconds before the second try, doubled for the third
DUP_FAILED_WAIT = timedelta(minutes=15)  # after a failed scan, wait this long before reading again
DUP_NAME = 80                          # characters kept of a check's key and label (an unbounded name could overfill the issue body)
DUP_RUNNING = timedelta(minutes=10)    # a run still in progress counts once it has run this long (a cancelled copy dies sooner)
DUP_SKIP_CODES = (404, 410, 422)       # a head GitHub cannot return (gone, unprocessable) is skipped, not fatal
ISSUE_LIMIT = 65536                    # characters an issue body may have
DUP_BODY_LIMIT = 60000                 # shrink the saved duplicates when the issue body would pass this (the limit is 65536)
SLEEP = time.sleep
DUP_RUNS_SHOWN = 4
DUP_TITLE = 60
# check-run conclusions that mean the check's work really ran; cancelled (a superseded copy), skipped,
# neutral, stale, action_required and startup_failure never count.
REAL_CONCLUSIONS = frozenset({"success", "failure", "timed_out"})
RESIDENT_EXTERNAL = re.compile(r"^independent-ci:([a-z0-9-]{1,40}):")
RESIDENT_ATTEMPT = re.compile(r":a(\d{1,3})(?::|$)")
# The resident's own control checks ("not a scanner execution"): work-claim admission per attempt, and the
# stage 8 rechecks (admission-verified, merge-slot) that are republished on every try. They are verified
# again by design and never count as a run of the work.
RESIDENT_CONTROL_KINDS = frozenset({"native-work-admission", "control"})
RUN_URL = re.compile(r"/actions/runs/(\d+)")
# A hosted/self-hosted workflow job that executes the check the resident also publishes (gitleaks,
# trivy, contract-placement) is named "<check>-hosted-executor"; that is the same check as "<check>".
HOSTED_SUFFIX = re.compile(r"(-hosted-executor| \(hosted\))$")
GATE_JOB_NAMES = frozenset({GATE_JOB})

POOL = [
    {"name": "clued-ci-company-linux-01", "os": "Linux", "site": "company",
     "can_run": ["Linux 作业", "Docker", "WSL2"]},
    {"name": "clued-ci-company-linux-02", "os": "Linux", "site": "company",
     "can_run": ["Linux 作业", "Docker", "WSL2"]},
    {"name": "clued-ci-company-linux-03", "os": "Linux", "site": "company",
     "can_run": ["Linux 作业", "Docker", "WSL2"]},
    {"name": "clued-ci-company-linux-04", "os": "Linux", "site": "company",
     "can_run": ["Linux 作业", "Docker", "WSL2"]},
    {"name": "clued-ci-company-win-01", "os": "Windows", "site": "company",
     "can_run": ["Windows 作业", "Python 3.12", "Node 24"]},
    {"name": "clued-ci-home-win-01", "os": "Windows", "site": "home",
     "can_run": ["Windows 作业", "Python 3.12", "Node 24"]},
]
# Current machines outside the general pool; retired machines stay in historical records.
OTHERS = [
    {"name": "clued-ci-company-win-02", "status": "controller",
     "role": "DESK 独立 CI 控制 runner，按阶段启停，不计入通用算力池"},
    {"name": "clued-ci-home-win-02", "status": "controller",
     "role": "TURING 独立 CI 控制 runner，按阶段启停，不计入通用算力池"},
]
STATUS_TEXT = {
    "online": "在线", "offline": "离线", "unknown": "未知",
    "retired": "已退役", "controller": "控制机",
}


def parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def cell(value: Any) -> str:
    """Text from job names or status descriptions, made inert inside a Markdown table or list."""
    text = " ".join(str(value).split())
    for old, new in (("|", "\\|"), ("`", "'"), ("@", "＠"), ("<", "&lt;"), (">", "&gt;")):
        text = text.replace(old, new)
    return text[:200]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # noqa: D401 - keep the token off the log host
        return None


class RequestError(RuntimeError):
    """An HTTP error reply; `code` is its status."""

    def __init__(self, message: str, code: int) -> None:
        super().__init__(message)
        self.code = code


class BudgetLow(RuntimeError):
    """The shared token budget ran low in the middle of a scan: not a failure of the reads themselves."""


class GitHub:
    def __init__(self, token: str, repository: str, api_url: str = "https://api.github.com") -> None:
        self.token = token
        self.repository = repository
        self.api_url = api_url.rstrip("/")
        self.requests = 0
        self.remaining: int | None = None

    def low(self) -> bool:
        """True when the shared GITHUB_TOKEN budget is nearly spent: skip optional reads."""
        return self.remaining is not None and self.remaining < LOW_BUDGET

    def _request(self, method: str, path: str, params: dict | None = None,
                 body: Any = None) -> tuple[int, Any, dict]:
        url = f"{self.api_url}{path}"
        if params:
            url += "?" + urllib.parse.urlencode(params)
        data = json.dumps(body).encode("utf-8") if body is not None else None
        request = urllib.request.Request(url, data=data, method=method, headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {self.token}",
            "User-Agent": "clued-compute-panel/1",
            "X-GitHub-Api-Version": "2022-11-28",
        })
        # Never follow a redirect with the token attached; callers that expect one handle it.
        opener = urllib.request.build_opener(_NoRedirect)
        self.requests += 1
        try:
            with opener.open(request, timeout=30) as response:
                raw = response.read()
                self._budget(response.headers)
                return response.status, (json.loads(raw) if raw else None), dict(response.headers)
        except urllib.error.HTTPError as error:
            self._budget(error.headers)
            if error.code in (301, 302, 303, 307, 308):
                return error.code, None, dict(error.headers)
            raise RequestError(f"{method} {path} failed ({error.code})", error.code) from None

    def _budget(self, headers: Any) -> None:
        value = headers.get("X-RateLimit-Remaining") if headers else None
        if value is not None and str(value).isdigit():
            self.remaining = int(value)

    def get(self, path: str, params: dict | None = None) -> Any:
        status, body, _ = self._request("GET", f"/repos/{self.repository}{path}", params)
        if status >= 300:
            raise RuntimeError(f"GET {path} redirected ({status})")
        return body

    def send(self, method: str, path: str, body: Any) -> Any:
        status, result, _ = self._request(method, f"/repos/{self.repository}{path}", body=body)
        if status >= 300:
            raise RuntimeError(f"{method} {path} redirected ({status})")
        return result

    def job_log(self, job_id: int) -> str:
        status, _, headers = self._request("GET", f"/repos/{self.repository}/actions/jobs/{job_id}/logs")
        location = headers.get("Location") or headers.get("location")
        if status not in (301, 302, 303, 307, 308) or not location:
            return ""
        # The log host gets no Authorization header: the redirect URL is pre-signed.
        with urllib.request.urlopen(location, timeout=30) as response:
            return response.read().decode("utf-8", "replace")


def parse_probe(log: str) -> dict | None:
    for match in PROBE_LINE.finditer(log):
        try:
            value = json.loads(match.group(1))
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    return None


def parse_governance(log: str) -> dict:
    """The node governance level the probe read from its status file; anything unreadable is unknown."""
    unknown = {"level": "unknown", "writtenAt": None}
    matches = GOVERNANCE_LINE.findall(log)
    if not matches:
        return unknown
    try:
        row = json.loads(matches[-1])
    except json.JSONDecodeError:
        return unknown
    if not isinstance(row, dict) or row.get("level") not in GOVERNANCE_LEVELS:
        return unknown
    written = row.get("writtenAt")
    if written is not None and not (isinstance(written, str) and GOVERNANCE_TIME.fullmatch(written)):
        return unknown
    return {"level": row["level"], "writtenAt": written}


def unpicked(job: dict, now: datetime) -> bool:
    """A probe nobody took although its run's gate passed at least UNPICKED_AFTER earlier.

    A skipped probe (the gate failed) or one cancelled before the gate finished
    says nothing about its runner and never counts.
    """
    gate_done = parse_time(job.get("gate_done"))
    if gate_done is None or job.get("runner_name"):
        return False
    if job.get("conclusion") == "cancelled":
        ended = parse_time(job.get("completed_at"))
        return ended is not None and ended - gate_done >= UNPICKED_AFTER
    return job.get("status") == "queued" and now - gate_done >= UNPICKED_AFTER


def classify_node(name: str, probe_jobs: list[dict], active: dict[str, dict], now: datetime) -> dict:
    """Online/offline/unknown and busy for one pool runner.

    Offline needs unpicked probes in UNPICKED_RUNS different runs, so one
    saturated moment or a runner busy on a job outside the active-run window
    does not page the Owner.
    """
    mine = [job for job in probe_jobs if job.get("name") == PROBE_PREFIX + name]
    successes = [parse_time(job.get("completed_at")) for job in mine if job.get("conclusion") == "success"]
    successes = [time for time in successes if time]
    last_success = max(successes) if successes else None
    unpicked_runs = {job.get("run_id") for job in mine if unpicked(job, now)}
    running = active.get(name)
    current = None if running is None or running.get("own") else running
    if running:
        status = "online"
    elif last_success and now - last_success <= ONLINE_WINDOW:
        status = "online"
    elif len(unpicked_runs) >= UNPICKED_RUNS:
        status = "offline"
    else:
        status = "unknown"
    return {
        "status": status,
        "busy": bool(current),
        "current_job": current,
        "last_probe": iso(last_success) if last_success else None,
    }


def active_jobs(client: GitHub, limit: int = ACTIVE_RUNS) -> dict[str, dict]:
    """runner_name -> the job it is running now, across every workflow.

    This workflow's own probe/panel jobs prove the runner is up but are not
    work: they are returned with "own": True and do not make the runner busy.
    """
    runs = (client.get("/actions/runs", {"status": "in_progress", "per_page": limit}) or {}).get("workflow_runs", [])
    busy: dict[str, dict] = {}
    for run in runs[:limit]:
        own = str(run.get("path", "")).endswith("/" + WORKFLOW)
        jobs = (client.get(f"/actions/runs/{run['id']}/jobs", {"filter": "latest", "per_page": 100}) or {}).get("jobs", [])
        for job in jobs:
            name = job.get("runner_name")
            if job.get("status") != "in_progress" or not name:
                continue
            if name not in busy or (busy[name]["own"] and not own):
                busy[name] = {"workflow": run.get("name"), "job": job.get("name"),
                              "since": job.get("started_at"), "own": own}
    return busy


def probe_jobs(client: GitHub) -> list[dict]:
    try:
        runs = (client.get(f"/actions/workflows/{WORKFLOW}/runs", {"per_page": LOOKBACK_RUNS}) or {}).get("workflow_runs", [])
    except RuntimeError as error:
        if "(404)" not in str(error):
            raise
        runs = []  # the workflow is not on the default branch yet
    jobs: list[dict] = []
    for run in runs[:LOOKBACK_RUNS]:
        found = (client.get(f"/actions/runs/{run['id']}/jobs", {"filter": "latest", "per_page": 100}) or {}).get("jobs", [])
        gate = next((job for job in found if job.get("name") == GATE_JOB), None)
        gate_done = gate.get("completed_at") if gate and gate.get("conclusion") == "success" else None
        jobs.extend({**job, "run_id": run["id"], "gate_done": gate_done}
                    for job in found if str(job.get("name", "")).startswith(PROBE_PREFIX))
    return jobs


def latest_health(client: GitHub, jobs: list[dict], cache: dict, now: datetime) -> dict[str, dict]:
    """Disk/memory per runner from its newest successful probe, read at most every HEALTH_EVERY."""
    newest: dict[str, dict] = {}
    for job in jobs:
        if job.get("conclusion") != "success":
            continue
        name = str(job["name"])[len(PROBE_PREFIX):]
        if name not in newest or (job.get("completed_at") or "") > (newest[name].get("completed_at") or ""):
            newest[name] = job
    for name, job in newest.items():
        seen = cache.get(name) or {}
        fetched = parse_time(seen.get("fetched_at"))
        if client.low() or (fetched and now - fetched < HEALTH_EVERY):
            continue
        try:
            log = client.job_log(job["id"])
            values = parse_probe(log) or {}
        except (RuntimeError, OSError):
            continue
        cache[name] = {key: values[key] for key in ("disk_free_gb", "mem_available_gb")
                       if isinstance(values.get(key), (int, float))}
        cache[name]["fetched_at"] = iso(now)
        cache[name]["governance"] = parse_governance(log)
    for row in cache.values():
        row.pop("maintenance", None)  # retired cache-maintenance telemetry (Task 0c51fb42)
    result = {name: {k: v for k, v in row.items() if k != "fetched_at"} for name, row in cache.items()
              if name in {node["name"] for node in POOL}}
    for row in result.values():
        row["governance"] = dict(row.get("governance") or {"level": "unknown", "writtenAt": None})
    return result


def health_flags(health: dict, held: set[str] | frozenset[str] = frozenset()) -> list[str]:
    """Low disk or memory flags. A flag already raised (held) ends only past a margin, or the alert would come
    and go with every probe around the line (#952: home-win-01's disk four times in two hours); an unread value
    keeps it."""
    flags = []
    for flag, key, low, clear in (("disk", "disk_free_gb", LOW_DISK_GB, DISK_CLEAR_GB),
                                  ("memory", "mem_available_gb", LOW_MEMORY_GB, MEMORY_CLEAR_GB)):
        value = health.get(key)
        if not isinstance(value, (int, float)):
            if flag in held:
                flags.append(flag)
        elif value < (clear if flag in held else low):
            flags.append(flag)
    if (health.get("governance") or {}).get("level") == "red":
        flags.append("governance")
    return flags


def record_utilization(samples: dict, nodes: dict[str, dict], now: datetime) -> dict[str, float | None]:
    """Hourly busy/total sample counts per node; returns the busy share of the last 24 hours."""
    hour = str(int(now.replace(minute=0, second=0, microsecond=0).timestamp()))
    floor = now.timestamp() - UTILIZATION_HOURS * 3600
    result: dict[str, float | None] = {}
    for name, node in nodes.items():
        buckets = samples.setdefault(name, {})
        if node["status"] == "online":
            busy, total = buckets.get(hour, [0, 0])
            buckets[hour] = [busy + (1 if node["busy"] else 0), total + 1]
        for key in [key for key in buckets if int(key) < floor]:
            del buckets[key]
        busy = sum(value[0] for value in buckets.values())
        total = sum(value[1] for value in buckets.values())
        result[name] = round(100.0 * busy / total, 1) if total else None
    return result


def resident_batches(statuses: list[dict]) -> dict[str, dict]:
    """One batch summary per resident node from one PR head's status history."""
    by_node: dict[str, list[dict]] = {}
    for status in statuses:
        match = RESIDENT_CONTEXT.match(str(status.get("context", "")))
        if match:
            by_node.setdefault(match.group(1), []).append(status)
    result = {}
    for node, rows in by_node.items():
        rows = sorted(rows, key=lambda row: row.get("created_at") or "")
        start = next((i for i, row in enumerate(rows) if "运行中" in str(row.get("description", ""))), None)
        if start is None:
            continue  # never ran (a hint such as "落后 main" or a queue row only): not a batch
        last = rows[-1]
        terminal = last.get("state") in ("success", "failure", "error")
        result[node] = {
            # Queue wait runs from the first queue row (or the start itself) to the first running
            # stage; hints such as "落后 main" before it do not count as queueing.
            "queued_at": next((row.get("created_at") for row in rows[:start]
                               if "排队" in str(row.get("description", ""))), rows[start].get("created_at")),
            "started_at": rows[start].get("created_at"),
            "ended_at": last.get("created_at") if terminal else None,
            "outcome": {"success": "passed", "failure": "failed", "error": "failed"}.get(last.get("state"), "running"),
            "retries": sum(1 for row in rows if "第二次尝试" in str(row.get("description", ""))),
            "burned": 1 if last.get("state") == "failure" and "推新提交" in str(last.get("description", "")) else 0,
        }
    return result


def summarize_batches(batches: list[dict], now: datetime, days: int) -> dict:
    floor = now - timedelta(days=days)
    done = [b for b in batches if b["outcome"] != "running" and (t := parse_time(b["ended_at"])) and t >= floor]
    waits = [(parse_time(b["started_at"]) - parse_time(b["queued_at"])).total_seconds() / 60
             for b in done if b["started_at"] and b["queued_at"]]
    durations = [(parse_time(b["ended_at"]) - parse_time(b["started_at"])).total_seconds() / 60
                 for b in done if b["started_at"] and b["ended_at"]]
    failed = sum(1 for b in done if b["outcome"] == "failed")

    def quantile(values: list[float], q: float) -> float | None:
        if not values:
            return None
        ordered = sorted(values)
        return round(ordered[min(len(ordered) - 1, int(q * len(ordered)))], 1)

    return {
        "window_days": days,
        "batches": len(done),
        "passed": len(done) - failed,
        "failed": failed,
        "failure_rate": round(failed / len(done), 3) if done else None,
        "queue_wait_minutes_median": round(statistics.median(waits), 1) if waits else None,
        "queue_wait_minutes_p90": quantile(waits, 0.9),
        "batch_minutes_median": round(statistics.median(durations), 1) if durations else None,
        "retries": sum(b["retries"] for b in done),
        "burned_heads": sum(b["burned"] for b in done),
    }


def collect_batches(client: GitHub, now: datetime) -> list[dict]:
    """Batch summaries of the PRs updated in the last 7 days (read about once an hour)."""
    pulls = client.get("/pulls", {"state": "all", "sort": "updated", "direction": "desc",
                                  "per_page": METRICS_PULLS}) or []
    floor = now - timedelta(days=7)
    batches: list[dict] = []
    for pull in pulls:
        if (parse_time(pull.get("updated_at")) or now) < floor:
            continue
        statuses = client.get(f"/commits/{pull['head']['sha']}/statuses", {"per_page": 100}) or []
        for node, batch in resident_batches(statuses).items():
            batches.append({**batch, "node": node, "pr": pull.get("number")})
    return batches


def resident_latest(combined: list[tuple[int, dict]]) -> dict[str, dict]:
    """Executor state per resident node over the open PRs' combined statuses.

    An error row is executor-wide (HALT, or no status update: possibly stopped)
    and wins while it is newer than every progress row of that node, so an old
    error left on an open PR clears once the executor writes again; otherwise a
    running stage; otherwise the newest row. Per-PR hints such as "落后 main"
    are only shown when nothing better exists.
    """
    rows: dict[str, list[dict]] = {}
    for number, status in combined:
        for row in status.get("statuses") or []:
            match = RESIDENT_CONTEXT.match(str(row.get("context", "")))
            if match:
                rows.setdefault(match.group(1), []).append({
                    "state": row.get("state"), "description": row.get("description"),
                    "at": row.get("updated_at") or row.get("created_at") or "", "pr": number})
    latest: dict[str, dict] = {}
    for node, items in rows.items():
        items.sort(key=lambda item: item["at"], reverse=True)
        error = next((i for i in items if i["state"] == "error"), None)
        # Hints such as "落后 main" are written even while HALTed, so only a row of real
        # executor progress (queued, running, finished) clears an older error.
        healthy = next((i for i in items if i["state"] != "error"
                        and any(word in str(i["description"]) for word in ("运行中", "排队", "已完成"))), None)
        if error and healthy and healthy["at"] > error["at"]:
            error = None
        chosen = (error
                  or next((i for i in items if "运行中" in str(i["description"])), None)
                  or items[0])
        halted = chosen["state"] == "error"
        running = "运行中" in str(chosen["description"])
        latest[node] = {**chosen, "halted": halted,
                        "activity": "halted" if halted else "running" if running else "idle"}
    return latest


def resident_rows(status: dict) -> list[dict]:
    """The resident-queue rows of one head (its latest per node, or its history), newest first."""
    rows = [row for row in status.get("statuses") or [] if RESIDENT_CONTEXT.match(str(row.get("context", "")))]
    return sorted(rows, key=lambda row: row.get("updated_at") or row.get("created_at") or "", reverse=True)


def row_time(row: dict | None) -> datetime | None:
    return parse_time(row.get("updated_at") or row.get("created_at")) if row else None


def is_duty(row: dict) -> bool:
    return str(row.get("description", "")).startswith(DUTY_WORD)


def waiting_since(client: GitHub, sha: str) -> datetime | None:
    """When a node was last on duty for this head, from its newest 100 statuses; never on duty: its first resident row."""
    history = resident_rows({"statuses": client.get(f"/commits/{sha}/statuses", {"per_page": 100}) or []})
    return row_time(next((row for row in history if is_duty(row)), history[-1] if history else None))


def resident_stall(client: GitHub, pulls: list[dict], combined: list[tuple[int, dict]], now: datetime) -> list[dict]:
    """The open PRs whose resident work nobody moves (board row 26, gap 2): CI is stalled.

    A head waits on the residents when its newest resident row is pending or error (success and failure are
    results, such as 已完成). A 落后 main hint (BEHIND_HINT, pending since Task 484bddac) waits on the robot that
    takes main in, not on the residents, so it is never a stall (Task bc982192). It is stalled when no node has been on duty for it for STALL_AFTER:
    a node on duty rewrites 当班 on every queued commit at least every 14 minutes (the resident's
    DUTY_REFRESH_MS), so STALL_AFTER is its DUTY_WINDOW_MS. An error row (HALT, or a status no longer updated)
    is a stall at once: a HALT never hands over (Decision 199cf3de) and waits for the Owner. Only a head whose
    newest row is neither 当班 nor error costs a read (its history: since when nobody was on duty).
    """
    drafts = {pull.get("number") for pull in pulls if pull.get("draft")}
    stalled = []
    for number, status in combined:
        rows = resident_rows(status)
        if number in drafts or not rows or rows[0].get("state") not in ("pending", "error"):
            continue
        if str(rows[0].get("description", "")).startswith(BEHIND_HINT):
            continue  # behind main: waits for the robot's merge of main, the residents have nothing to do
        since = row_time(next((row for row in rows if is_duty(row)), None))
        if since is not None and now - since < STALL_AFTER:
            continue  # a node is on duty for it and alive
        if rows[0].get("state") != "error":
            if since is None and status.get("sha"):
                since = waiting_since(client, status["sha"])
            if since is None or now - since < STALL_AFTER:
                continue
        stalled.append({"pr": number, "node": RESIDENT_CONTEXT.match(rows[0]["context"]).group(1),
                        "description": rows[0].get("description"), "since": iso(since) if since else None})
    return stalled[:RESIDENT_PULLS]


def collect_residents(client: GitHub, now: datetime,
                      limit: int = RESIDENT_PULLS) -> tuple[dict[str, dict], dict[str, str], list[dict]]:
    """The resident state per node, the failed batches on the open PRs' current heads, and the stalled ones."""
    pulls = client.get("/pulls", {"state": "open", "sort": "updated", "direction": "desc", "per_page": limit}) or []
    combined = [(pull["number"], client.get(f"/commits/{pull['head']['sha']}/status") or {}) for pull in pulls[:limit]]
    return (resident_latest(combined), batch_failures(pulls[:limit], combined),
            resident_stall(client, pulls[:limit], combined, now))


def batch_failures(pulls: list[dict], combined: list[tuple[int, dict]]) -> dict[str, str]:
    """One event per failed resident batch: key PR, head and node, so a new head fails anew (Decision b30b1b79)."""
    titles = {pull["number"]: pull.get("title") for pull in pulls}
    events = {}
    for number, status in combined:
        for row in status.get("statuses") or []:
            match = RESIDENT_CONTEXT.match(str(row.get("context", "")))
            # A behind-main hint (BEHIND_HINT) is a per-PR hint written for stale branches, not a batch result.
            if match and row.get("state") == "failure" and not str(row.get("description", "")).startswith(BEHIND_HINT):
                key = f"failed:{number}:{str(status.get('sha', ''))[:12]}:{match.group(1)}"
                events[key] = (f"PR #{number}（{cell(titles.get(number))}）在 {match.group(1)} 上检查失败："
                               f"{cell(row.get('description'))}")
    return events


def recent_merges(client: GitHub, since: datetime | None, limit: int = RESIDENT_PULLS) -> dict[str, str]:
    """PRs merged into main after `since` (the previous run); none on the first run, so history is not replayed."""
    if since is None:
        return {}
    pulls = client.get("/pulls", {"state": "closed", "base": "main", "sort": "updated", "direction": "desc",
                                  "per_page": limit}) or []
    events = {}
    for pull in pulls:
        merged = parse_time(pull.get("merged_at"))
        if merged is not None and merged > since:
            events[f"merged:{pull['number']}"] = f"PR #{pull['number']}（{cell(pull.get('title'))}）已合入 main"
    return events


def real_run(check: dict, workflows: dict[int, dict], now: datetime | None = None) -> dict | None:
    """One check run as a candidate for "really ran", or None when it does not count.

    Counts: a completed success/failure/timed_out run, or one still in progress that has run for DUP_RUNNING
    (with `now`; a run that was just cancelled by its successor must not be announced).
    Never counts: skipped or cancelled copies, a queued run, the resident's control checks and stage 8
    rechecks, and the admission gate of a workflow (a wait on Clued, not CI work).

    The identity ("key") is what must run once per head: the resident's check name, and the same name for a
    hosted executor job ("<check>-hosted-executor"); any other hosted job is told apart by its workflow, so
    the many jobs named admission-gate in different workflows are different checks.
    """
    name = str(check.get("name") or "")
    started = parse_time(check.get("started_at"))
    status, conclusion = check.get("status"), check.get("conclusion")
    if not name or started is None:
        return None
    finished = parse_time(check.get("completed_at")) if status == "completed" else None
    done = iso(finished) if finished is not None else None
    origin = check.get("_origin") or "head"
    if status == "in_progress":
        if now is not None and now - started < DUP_RUNNING:
            return None
    elif not (status == "completed" and conclusion in REAL_CONCLUSIONS):
        return None
    external = str(check.get("external_id") or "")
    resident = RESIDENT_EXTERNAL.match(external)
    if resident:
        kind = resident.group(1)
        # A relay republishes a hosted run's result under the same name; it is not a second run.
        if kind in RESIDENT_CONTROL_KINDS or "relay" in kind or name.startswith("kooyumi-"):
            return None
        attempt = RESIDENT_ATTEMPT.search(external)
        # One execution, one identity: a native publication is named by its job, any other resident check by its external_id (a
        # check withdrawn and published again under the same external_id, e.g. after a read timeout, is the same run).
        job = external.split(":")[3] if kind == "native" and external.count(":") >= 3 else external
        return {"key": name, "label": name, "executor": "resident", "at": iso(started), "done": done, "conclusion": conclusion or status,
                "attempt": int(attempt.group(1)) if attempt else None, "run": None, "event": None, "job": job,
                "id": check.get("id"), "origin": origin}
    match = RUN_URL.search(str(check.get("details_url") or ""))
    run_id = int(match.group(1)) if match else None
    workflow = workflows.get(run_id) or {}
    if name in GATE_JOB_NAMES:
        return None
    base = HOSTED_SUFFIX.sub("", name)
    where = workflow.get("path") or workflow.get("name") or "unknown-workflow"
    key = base if base != name else f"{where}::{name}"
    # "Re-run failed jobs" copies the jobs it does not run into the new attempt as new check runs with the same
    # start: one execution is one (run, job name, start). The attempt is the job's own, never the run's latest;
    # a run that only had one attempt says it for every job, otherwise duplicate_findings() reads the jobs.
    attempt = check.get("_attempt") or (1 if workflow.get("attempt") == 1 else None)
    return {"key": key, "label": base if base != name else f"{name}（{str(where).rsplit('/', 1)[-1]}）",
            "executor": "hosted" if run_id else cell(((check.get("app") if isinstance(check.get("app"), dict) else None) or {}).get("slug") or "other")[:40],
            "at": iso(started), "done": done,
            "conclusion": conclusion or status, "attempt": attempt, "run": run_id,
            "event": workflow.get("event"), "job": f"{run_id}:{name}:{iso(started)}" if run_id else None,
            "id": check.get("id"), "origin": origin}


def short_name(name: str) -> str:
    """A key or label bounded to DUP_NAME characters; a long key keeps a digest so that two keys stay apart."""
    if len(name) <= DUP_NAME:
        return name
    return name[:DUP_NAME - 9] + "~" + hashlib.sha1(name.encode("utf-8")).hexdigest()[:8]


FAILED_CONCLUSIONS = frozenset({"failure", "timed_out"})


def duplicate_kind(runs: list[dict]) -> str:
    """How the runs of one tree and check (sorted by start) came about, judged at each later run's start:
    "rerun" when an earlier run had already passed; otherwise "parallel" when an earlier run had not yet finished
    (two copies at once, or a copy still running); otherwise "retry": every earlier run had finished and failed,
    a retry of a failure, which the rule allows. "rerun" and "parallel" both break the rule."""
    kind = "retry"
    for index, run in enumerate(runs[1:], 1):
        started = parse_time(run["at"])
        for earlier in runs[:index]:
            finished = parse_time(earlier["done"]) if earlier["done"] is not None else None
            if finished is None or finished > started:
                kind = "parallel"
            elif earlier["conclusion"] not in FAILED_CONCLUSIONS:
                return "rerun"
    return kind


def duplicate_findings(head: str, pull: dict, checks: list[dict], workflows: dict[int, dict],
                       now: datetime, attempts_of: Any = None, tree: str | None = None) -> list[dict]:
    """The checks of one tree that really ran twice or more (rule 41ab823a: one real run per tree and check).

    `checks` are the PR head's check runs plus, when the merge commit has the head's tree, the jobs of its main push
    runs (marked "_origin": "merge"). `attempts_of(run_id)` returns {job id: attempt} for a run that had more than one
    attempt; it is read only for the runs of a finding."""
    groups: dict[str, list[dict]] = {}
    # The earliest copy of an execution stands for it (a re-run's copies of unrun jobs come later).
    for check in sorted(checks, key=lambda item: item.get("id") if isinstance(item.get("id"), int) else 0):
        run = real_run(check, workflows, now)
        if run:
            group = groups.setdefault(run["key"], [])
            if run["job"] is None or all(other["job"] != run["job"] for other in group):
                group.append(run)
    merged = parse_time(pull.get("merged_at"))
    found = []
    for key, runs in groups.items():
        if len(runs) < 2:
            continue
        runs.sort(key=lambda run: run["at"])
        # A job's attempt is read only where one run executed it more than once (a re-run): the run's latest attempt
        # would be wrong for its earlier executions. Unread, the attempt is left out of the row.
        repeated = {run["run"] for run in runs if run["run"] is not None and sum(other["run"] == run["run"] for other in runs) > 1}
        for run in runs:
            if run["attempt"] is None and run["run"] in repeated and attempts_of is not None:
                run["attempt"] = (attempts_of(run["run"]) or {}).get(run["id"])
        executors = {run["executor"] for run in runs}
        causes = []
        if any(run["origin"] == "merge" for run in runs):
            causes.append("main-push")         # the push of the merge commit ran the PR head's tree again
        elif merged is not None and any(parse_time(run["at"]) > merged for run in runs):
            causes.append("after-merge")       # a merged PR scheduled again
        if len(executors) > 1:
            causes.append("cross-executor")    # the hosted workflow and the resident both ran it
        if not causes:
            causes.append("same-executor")     # a rerun or a second trigger on the same executor
        mix: dict[str, int] = {}
        for run in runs:
            mix[run["executor"]] = mix.get(run["executor"], 0) + 1
        pushes = sorted({run["run"] for run in runs if run["origin"] == "merge" and run["run"] is not None})
        found.append({
            "head": head[:12], "tree": tree[:12] if tree else None, "pr": pull.get("number"), "check": short_name(key),
            "label": short_name(runs[0]["label"]), "count": len(runs), "mix": mix, "causes": causes,
            # "rerun" (after a pass) and "parallel" (alongside an unfinished run) break the rule and are announced;
            # "retry" (after failures only) is listed.
            "kind": duplicate_kind(runs),
            # the main push runs of the merge commit: where the gate's log says why the tree was not reused
            **({"push_runs": pushes[:DUP_RUNS_SHOWN]} if pushes else {}),
            "first": runs[0]["at"], "last": runs[-1]["at"],
            "runs": [{k: run[k] for k in ("executor", "at", "conclusion", "attempt", "run", "event")}
                     for run in runs[:DUP_RUNS_SHOWN]],
            "title": cell(pull.get("title"))[:DUP_TITLE],
        })
    return found


def duplicate_key(finding: dict) -> str:
    """A new key whenever the count grows."""
    return f"dup:{finding['head']}:{finding['check']}:{finding['count']}"


def duplicate_event(finding: dict) -> tuple[str, str]:
    """The event key and its one-line text. A short record (kept for the total only) has no runs to describe."""
    counts: dict[str, int] = dict(finding.get("mix") or {})
    if not counts:
        for run in finding.get("runs") or []:
            counts[run["executor"]] = counts.get(run["executor"], 0) + 1
    names = {"resident": "常驻", "hosted": "托管"}
    parts = "、".join(f"{names.get(who, cell(who))} {n} 次" for who, n in counts.items())
    pushes = "、".join(str(run) for run in finding.get("push_runs") or [])
    why = "；".join(CAUSE_TEXT.get(cause, cell(cause)) + (f"（运行 {pushes}）" if cause == "main-push" and pushes else "")
                   for cause in finding.get("causes") or [])
    span = f"{finding['first']} 至 {finding['last']}" if finding.get("first") else f"最近 {finding['last']}"
    detail = "；".join(part for part in (KIND_TEXT.get(finding.get("kind"), ""), parts, why, span) if part)
    tree = f"（树 {finding['tree'][:8]}）" if finding.get("tree") else ""
    text = (f"重复执行：PR #{finding['pr']}（{finding.get('title', '')}）提交 {finding['head'][:8]}{tree} 的检查 "
            f"{cell(finding.get('label') or finding['check'])} 真跑了 {finding['count']} 次（{detail}）")
    return duplicate_key(finding), text


CAUSE_TEXT = {"main-push": "合入后 main push", "after-merge": "合并后又被调度", "cross-executor": "托管与常驻各跑一次",
              "same-executor": "同一执行方重复"}
KIND_TEXT = {"rerun": "通过后又跑", "parallel": "并行或前一次未结束又跑", "retry": "失败后重试"}


def short_finding(finding: dict) -> dict:
    """What is kept of a finding beyond the first DUP_KEEP: enough to count it by kind, carry it over and date it."""
    return {key: finding[key] for key in ("head", "pr", "check", "count", "last", "kind") if key in finding}


def duplicate_totals(found: list[dict]) -> dict[str, int]:
    """Every finding by kind. "rerun" and "parallel" break the rule; "retry" is allowed and only listed.
    "unknown" is a short record an older panel saved without its kind: not a violation, not read again, counted on
    its own until it leaves the window (DUP_LOOKBACK)."""
    totals = {"rerun": 0, "parallel": 0, "retry": 0, "unknown": 0}
    for item in found:
        kind = item.get("kind")
        totals[kind if kind in ("rerun", "parallel", "retry") else "unknown"] += 1
    return totals


def violations(totals: dict) -> int:
    return int(totals.get("rerun", 0)) + int(totals.get("parallel", 0))


def totals_line(totals: dict) -> str:
    return (f"违规 {violations(totals)} 项（通过后又跑 {totals.get('rerun', 0)}、并行 {totals.get('parallel', 0)}）；"
            f"失败后重试 {totals.get('retry', 0)} 项（规则允许，只列出）"
            + (f"；另有 {totals['unknown']} 项旧记录未记类别（{DUP_LOOKBACK.days} 天内滚出）" if totals.get("unknown") else ""))


def retrying(call):
    """Run one request; a 5xx, a network error, a cut-off reply or an unreadable body is tried DUP_ATTEMPTS times
    with a doubling pause. Other errors (403, 404) are not retried."""
    for attempt in range(DUP_ATTEMPTS):
        try:
            return call()
        except (RequestError, OSError, http.client.HTTPException, ValueError) as error:
            transient = not isinstance(error, RequestError) or error.code >= 500
            if not transient or attempt == DUP_ATTEMPTS - 1:
                if isinstance(error, (RequestError, OSError)):
                    raise  # build()'s attempt() already catches both
                # a cut-off reply (HTTPException) or an unreadable body (ValueError): make it a RuntimeError for attempt()
                raise RuntimeError(f"read failed: {type(error).__name__}") from error
            SLEEP(DUP_BACKOFF * 2 ** attempt)


def read_check_runs(client: GitHub, sha: str) -> list[dict]:
    """Every check run on a commit, not only the latest per name (filter=all). Needs checks: read."""
    checks: list[dict] = []
    seen: set[Any] = set()
    for page in range(1, DUP_PAGES + 1):
        reply = retrying(lambda: client.get(f"/commits/{sha}/check-runs", {"filter": "all", "per_page": 100, "page": page})) or {}
        rows = reply.get("check_runs") or []
        for row in rows:  # a check run published between two pages shifts the list: count each id once
            if row.get("id") is None or row["id"] not in seen:
                seen.add(row.get("id"))
                checks.append(row)
        if len(rows) < 100:
            break
    return checks


def read_workflow_runs(client: GitHub, sha: str) -> dict[int, dict]:
    """run id -> workflow path, event and attempt, to tell same-named jobs of different workflows apart."""
    reply = retrying(lambda: client.get("/actions/runs", {"head_sha": sha, "per_page": 100})) or {}
    return {run["id"]: run_record(run) for run in reply.get("workflow_runs") or []}


def run_record(run: dict) -> dict:
    return {"path": run.get("path"), "name": run.get("name"), "event": run.get("event"), "attempt": run.get("run_attempt"),
            "head_sha": run.get("head_sha"), "tree": ((run.get("head_commit") or {}) if isinstance(run.get("head_commit"), dict) else {}).get("tree_id")}


def read_run_jobs(client: GitHub, run_id: int) -> list[dict]:
    """Every job of every attempt of one run (filter=all); a job's id is its check run's id. Needs actions: read."""
    reply = retrying(lambda: client.get(f"/actions/runs/{run_id}/jobs", {"filter": "all", "per_page": 100})) or {}
    return [job for job in reply.get("jobs") or [] if isinstance(job, dict)]


def merge_push_checks(client: GitHub, merge: str, tree: str, paths: set[str]) -> tuple[list[dict], dict[int, dict]]:
    """The jobs of the main push runs of a merge commit with the PR head's tree, as check runs, for the workflows that
    also ran on the head (only those can repeat a head's check). Read through the runs, not the commit's check runs:
    main's tip collects scheduled runs (the panel itself) that would push the push runs out of the listed pages.
    Scope: only the GitHub Actions runs of the push event; resident checks and workflow_dispatch runs on the merge
    commit are not counted (the resident does not publish on main's merge commits; a dispatch is a deliberate run)."""
    reply = retrying(lambda: client.get("/actions/runs", {"head_sha": merge, "event": "push", "per_page": 100})) or {}
    checks: list[dict] = []
    workflows: dict[int, dict] = {}
    for run in reply.get("workflow_runs") or []:
        record = run_record(run)
        if record["event"] != "push" or record["tree"] != tree or record["path"] not in paths or not isinstance(run.get("id"), int):
            continue
        workflows[run["id"]] = record
        for job in read_run_jobs(client, run["id"]):
            checks.append({"id": job.get("id"), "name": job.get("name"), "status": job.get("status"),
                           "conclusion": job.get("conclusion"), "started_at": job.get("started_at"),
                           "completed_at": job.get("completed_at"), "app": {"slug": "github-actions"},
                           "details_url": f"/actions/runs/{run['id']}/job/{job.get('id')}",
                           "_attempt": job.get("run_attempt"), "_origin": "merge"})
    return checks, workflows


def dup_token(key: str) -> str:
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:12]


def is_announced(state: dict, key: str) -> bool:
    if key.startswith("dup"):
        return dup_token(key) in (state.get("announced_dup") or [])
    return key in (state.get("announced") or [])


def mark_announced(state: dict, keys: list[str]) -> None:
    """Duplicate keys have their own set of DUP_ANNOUNCED short tokens, so other events cannot push them out;
    the keys of the findings still in the window are never dropped (that would announce them again)."""
    plain = [key for key in keys if not key.startswith("dup")]
    state["announced"] = ((state.get("announced") or []) + plain)[-200:]
    tokens = list(state.get("announced_dup") or [])
    tokens += [dup_token(key) for key in keys if key.startswith("dup") and dup_token(key) not in tokens]
    if len(tokens) > DUP_ANNOUNCED:
        stored = state.get("duplicates") or {}
        live = {dup_token(duplicate_key(item)) for item in (stored.get("found") or []) + (stored.get("rest") or [])}
        room = max(DUP_ANNOUNCED - len(live & set(tokens)), 0)
        old = [token for token in tokens if token not in live]
        spare = set(old[max(len(old) - room, 0):] if room else [])
        tokens = [token for token in tokens if token in live or token in spare]
    state["announced_dup"] = tokens


def pack_duplicates(scan: dict) -> dict:
    """The saved form of a scan: the first DUP_KEEP findings in full, the next DUP_MAX as short records.
    `total` and `totals` (by kind) count all of them, whatever is kept."""
    found = scan["found"]
    packed = {key: value for key, value in scan.items() if key != "found"}
    packed["found"] = found[:DUP_KEEP]
    packed["rest"] = [short_finding(item) for item in found[DUP_KEEP:DUP_KEEP + DUP_MAX]]
    # A head whose findings did not fit is not "settled": the next scan reads it again, so the total stays exact.
    dropped = {item["head"] for item in found[DUP_KEEP + DUP_MAX:]}
    packed["settled"] = {key: stamp for key, stamp in (scan.get("settled") or {}).items()
                         if key.split(":")[-1] not in dropped}
    return packed


def shrink_duplicates(state: dict, level: int, report: dict | None = None) -> None:
    """Make the saved duplicates smaller (the issue body is limited to 65536 characters). Level 1 drops the short
    records, level 2 the run details (the split by executor stays), level 3 all but the rows shown, level 4 every
    detail: only the total remains, and the panel says so. Level 5 also leaves the events out of the machine-readable
    data (they are already in the comment). Heads that lost findings are not settled, so the next scan reads them
    again and the total is exact once more; the announced keys and the quiet heads are kept, so nothing is said twice."""
    saved = state.get("duplicates") or {}
    if not saved:
        return
    keep = [item for item in saved.get("found") or []]
    drop = list(saved.get("rest") or [])
    if level >= 3:
        drop += keep[DUP_ROWS:]
        keep = keep[:DUP_ROWS]
    if level >= 2:
        keep = [{k: v for k, v in item.items() if k != "runs"} for item in keep]
    if level >= 1:
        saved["rest"] = []
    saved["found"] = keep
    heads = {item["head"] for item in drop}
    saved["settled"] = {key: stamp for key, stamp in (saved.get("settled") or {}).items() if key.split(":")[-1] not in heads}
    if level >= 4:
        saved.update(found=[], rest=[], settled={}, omitted=True)
        if report is not None:
            report["duplicates"].update(found=[], omitted=True)
    if level >= 5 and report is not None:
        report["events"] = {}


def settle_key(pull: dict, sha: str) -> str:
    """Settled marks are per PR and head: two PRs may share a head."""
    return f"{pull.get('number')}:{sha[:12]}"


def tree_findings(client: GitHub, sha: str, pull: dict, now: datetime) -> list[dict]:
    """The findings of one PR by tree: its head's check runs, and for a merged PR the main push of a merge commit
    that has the head's tree (the tree is read off the runs' head_commit, no extra request)."""
    checks = read_check_runs(client, sha)
    workflows = read_workflow_runs(client, sha)
    trees = {record["tree"] for record in workflows.values() if record.get("head_sha") == sha and record.get("tree")}
    tree = next(iter(trees)) if len(trees) == 1 else None
    merge = pull.get("merge_commit_sha") if pull.get("merged_at") else None
    if tree and isinstance(merge, str) and merge and merge != sha:
        paths = {record["path"] for record in workflows.values() if record.get("path")}
        extra, extra_workflows = merge_push_checks(client, merge, tree, paths)
        checks = checks + extra
        workflows = {**workflows, **extra_workflows}
    cache: dict[int, dict[int, int]] = {}

    def attempts_of(run_id: int) -> dict[int, int]:
        if run_id not in cache:
            try:
                cache[run_id] = {job["id"]: job.get("run_attempt") for job in read_run_jobs(client, run_id) if "id" in job}
            except BudgetLow:
                raise
            except (RequestError, OSError, RuntimeError):
                cache[run_id] = {}  # the attempt is a detail of the row: unread, it is left out
        return cache[run_id]

    return duplicate_findings(sha, pull, checks, workflows, now, attempts_of, tree)


def scan_duplicates(client: GitHub, now: datetime, previous: dict) -> dict:
    """Duplicate runs on the heads of the PRs updated in the last DUP_LOOKBACK.

    A closed PR whose last update is unchanged, and that was closed or merged more than DUP_RESCAN ago, is not read
    again; its earlier findings are kept. Raises RuntimeError when a read still fails after its retries (the
    previous result then stays), BudgetLow when the budget runs out; a head GitHub will not return is skipped.
    Returns every finding (one per head and check); pack_duplicates() decides what is saved.
    """
    floor = now - DUP_LOOKBACK
    pulls = retrying(lambda: client.get(
        "/pulls", {"state": "all", "sort": "updated", "direction": "desc", "per_page": DUP_PULLS})) or []
    old_found = (previous.get("found") or []) + (previous.get("rest") or [])
    settled_before = previous.get("settled") or {}
    settled: dict[str, str] = {}
    found: list[dict] = []
    heads = skipped = carried = 0
    skipped_heads: list[str] = []
    for pull in pulls:
        if (parse_time(pull.get("updated_at")) or now) < floor:
            continue
        sha = str(pull["head"]["sha"])
        closed = pull.get("state") == "closed"
        key = settle_key(pull, sha)
        if closed and settled_before.get(key) == pull.get("updated_at"):
            settled[key] = pull["updated_at"]
            carried += 1
            found.extend(item for item in old_found if item["head"] == sha[:12])
            continue
        if client.low():
            raise BudgetLow("额度不足，未读完")
        try:
            findings = tree_findings(client, sha, pull, now)
        except RequestError as error:
            if error.code not in DUP_SKIP_CODES:
                raise
            skipped += 1  # this head cannot be read; what was found before stays
            skipped_heads.append(sha[:12])
            found.extend(item for item in old_found if item["head"] == sha[:12])
            continue
        heads += 1
        found.extend(findings)
        ended = parse_time(pull.get("merged_at")) or parse_time(pull.get("closed_at")) or parse_time(pull.get("updated_at"))
        if closed and ended is not None and now - ended >= DUP_RESCAN:
            settled[key] = str(pull.get("updated_at"))
    if skipped and not heads and not carried:
        raise RuntimeError(f"所有 {skipped} 个提交都读不到")  # nothing was read: a failed scan, not an empty one
    best: dict[tuple[str, str], dict] = {}
    for item in found:  # a head shared by two PRs, or read twice, is one finding per check: the larger count wins
        old = best.get((item["head"], item["check"]))
        if old is None or item["count"] > old["count"]:
            best[(item["head"], item["check"])] = item
    found = [item for item in best.values() if (parse_time(item["last"]) or now) >= floor]
    found.sort(key=lambda item: item["last"], reverse=True)
    # Violations first, then allowed retries and records without a kind, each newest first: what is cut off
    # (DUP_KEEP, DUP_ROWS) is not a violation first.
    found.sort(key=lambda item: item.get("kind") not in ("rerun", "parallel"))
    return {"as_of": iso(now), "window_days": DUP_LOOKBACK.days, "heads_read": heads, "skipped": skipped,
            "skipped_heads": skipped_heads, "total": len(found), "totals": duplicate_totals(found), "found": found,
            "settled": settled}


def alerts_for(pool: dict[str, dict], residents: dict[str, dict], stall: list[dict] | None = None) -> dict[str, str]:
    alerts = {}
    # A HALTed node's alert already names the node and its reason, and exists before any PR queues; the PRs its HALT
    # holds up are added to it rather than said again as a stall. Keyed by node, it is not announced again (nor
    # "recovered") when PRs come or go. Only a stall no HALT explains (a pause, a silent node) is its own alert.
    halted = {node for node, row in residents.items() if row["halted"]}
    held_up: dict[str, list[int]] = {}
    for item in stall or []:
        if item["node"] in halted:
            held_up.setdefault(item["node"], []).append(item["pr"])
    stall = [item for item in stall or [] if item["node"] not in halted]
    if stall:
        # One key for the whole stall: more PRs or newer texts during it are not a new alert.
        shown = "；".join(f"PR #{item['pr']}（{item['node']}：{cell(item.get('description'))}）" for item in stall[:3])
        alerts["stall"] = (f"CI 停摆：{len(stall)} 个 PR 在等常驻执行器，没有节点当班推进"
                           f"（停机，或 {int(STALL_AFTER.total_seconds() // 60)} 分钟无人当班）：{shown}"
                           + ("；……" if len(stall) > 3 else ""))
    for name, node in pool.items():
        if node["status"] == "offline":
            alerts[f"offline:{name}"] = f"{name} 离线（最近一次探测成功：{node['last_probe'] or '无'}）"
        for flag in node.get("flags", []):
            written = node.get("health", {}).get("governance", {}).get("writtenAt") or "未知"
            alerts[f"{flag}:{name}"] = (f"{name} 节点治理红色（状态写于 {cell(written)}）"
                if flag == "governance" else f"{name} {'磁盘' if flag == 'disk' else '内存'}不足")
    for node, row in residents.items():
        if row["halted"]:
            prs = held_up.get(node, [])
            alerts[f"halt:{node}"] = (f"常驻执行器 {node} 停机或未更新：{cell(row.get('description'))}（PR #{row.get('pr')}）"
                                      + (f"；CI 停摆，{len(prs)} 个 PR 在等：" + "、".join(f"#{pr}" for pr in prs) if prs else ""))
    return alerts


def read_state(body: str | None) -> dict:
    # The panel writes its state last; read the last match so text earlier in the body cannot shadow it.
    matches = STATE_RE.findall(body or "")
    if not matches:
        return {}
    try:
        value = json.loads(base64.b64decode(matches[-1]).decode("utf-8"))
    except (ValueError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def write_state(state: dict) -> str:
    encoded = base64.b64encode(json.dumps(state, separators=(",", ":")).encode("utf-8")).decode("ascii")
    return f"<!-- clued-compute-panel-state:{encoded} -->"


def render(report: dict, state: dict) -> str:
    beijing = parse_time(report["generated_at"]).astimezone(timezone(timedelta(hours=8)))
    pool = report["pool"]
    online = [n for n in pool.values() if n["status"] == "online"]
    lines = [
        MARKER,
        f"## 算力面板　{beijing:%Y-%m-%d %H:%M} 北京时间",
        "",
        f"通用 runner {len(pool)} 个：在线 {len(online)}，忙 {sum(1 for n in online if n['busy'])}，"
        f"空闲 {sum(1 for n in online if not n['busy'])}，离线 {sum(1 for n in pool.values() if n['status'] == 'offline')}，"
        f"未知 {sum(1 for n in pool.values() if n['status'] == 'unknown')}。告警 {len(report['alerts'])} 条。",
        "",
        "以下按执行实例列出；同机实例共享磁盘与内存，资源数值不能累加。",
        "",
        "| 通用 runner | 状态 | 忙/闲 | 当前作业 | 能接的活 | 磁盘空闲 | 可用内存 | 治理等级 | 24 小时利用率 | 最近探测 |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    for name, node in pool.items():
        job = node.get("current_job")
        health = node.get("health", {})
        util = report["utilization"].get(name)
        lines.append("| {} | {} | {} | {} | {} | {} | {} | {} | {} | {} |".format(
            name, STATUS_TEXT[node["status"]],
            ("忙" if node["busy"] else "闲") if node["status"] == "online" else "—",
            cell(f"{job['workflow']} / {job['job']}") if job else "—",
            "、".join(node["can_run"]),
            f"{health['disk_free_gb']} GB" if "disk_free_gb" in health else "—",
            f"{health['mem_available_gb']} GB" if "mem_available_gb" in health else "—",
            GOVERNANCE_TEXT.get((health.get("governance") or {}).get("level"), "—"),
            f"{util}%" if util is not None else "—",
            node["last_probe"] or "—",
        ))
    lines += ["", "控制器 company-win-02、home-win-02 均在正常使用，按阶段启停；"
              "GitHub 显示离线或长期离线后自动移除注册，不代表控制器故障或退役。"
              "实际状态以本机服务和阶段执行结果为准。", "",
              "| 常驻与控制组件 | 状态或用途 | 说明 |", "|---|---|---|"]
    for name, row in report["residents"].items():
        activity = {"halted": "停机", "running": "运行中", "idle": "空闲（无运行中批次）"}[row["activity"]]
        lines.append(f"| 常驻 {name} | {activity} | 最近状态：{cell(row.get('description'))}（PR #{row.get('pr')}，{row.get('at')}） |")
    if not report["residents"]:
        lines.append("| 常驻执行器 | 未知 | 没有开放 PR 带常驻状态 |")
    for other in OTHERS:
        lines.append(f"| {other['name']} | {STATUS_TEXT[other['status']]} | {other['role']} |")
    metrics = report.get("metrics") or {}
    lines += ["", f"### 常驻批次指标（来自 PR 上的常驻状态，{metrics.get('as_of') or '尚未采集'}）", "",
              "| 窗口 | 批次 | 通过 | 失败 | 失败率 | 排队中位/P90（分） | 批次时长中位（分） | 重试 | 烧头 |",
              "|---|---|---|---|---|---|---|---|---|"]
    def shown(value: Any) -> str:
        return "—" if value is None else str(value)

    for key in ("day", "week"):
        m = metrics.get(key)
        if m:
            lines.append(f"| {m['window_days']} 天 | {m['batches']} | {m['passed']} | {m['failed']} | "
                         f"{shown(m['failure_rate'])} | "
                         f"{shown(m['queue_wait_minutes_median'])}/{shown(m['queue_wait_minutes_p90'])} | "
                         f"{shown(m['batch_minutes_median'])} | {m['retries']} | {m['burned_heads']} |")
    duplicates = report.get("duplicates") or {}
    totals = duplicates.get("totals")  # absent only in a state saved before the kinds were counted apart
    lines += ["", f"### 重复执行（规则 41ab823a：同一棵树的同一检查只真跑一次，PR head 与其同树的合并提交算一棵树；"
              f"最近 {DUP_LOOKBACK.days} 天，{duplicates.get('as_of') or '尚未采集'}）", ""]
    if not duplicates.get("as_of"):
        lines.append("尚未采集（需要 checks: read；读取失败见页末说明）。")
    elif duplicates.get("omitted"):
        count = totals_line(totals) if totals else f"共 {duplicates.get('total', 0)} 项"
        lines.append(f"{count}；正文接近 Issue 上限，明细已省略，下一轮扫描恢复。")
    elif not duplicates.get("found"):
        lines.append(f"没有发现：读了 {duplicates.get('heads_read', 0)} 个提交，没有同一检查真跑两次及以上。"
                     "取消、跳过、常驻的准入与第 8 段复查不算真跑。")
    else:
        lines += [(totals_line(totals) + "。") if totals else "“通过后又跑”“并行或前一次未结束又跑”违反规则并告警；“失败后重试”只列出。", "",
                  "| PR | 提交 | 检查 | 真跑次数 | 类别 | 构成 | 原因 | 最近一次 |", "|---|---|---|---|---|---|---|---|"]
        for item in duplicates["found"]:
            who = {"resident": "常驻", "hosted": "托管"}
            parts = "、".join(f"{who.get(r['executor'], cell(r['executor']))}{('#' + str(r['attempt'])) if r.get('attempt') else ''}"
                              for r in item.get("runs") or [])
            if not parts and item.get("mix"):  # the run details were shrunk away; the split stays
                parts = "、".join(f"{who.get(e, cell(e))} {n}" for e, n in item["mix"].items())
            parts = parts or "—"
            lines.append(f"| #{item['pr']} | {item['head'][:8]} | {cell(item.get('label') or item['check'])} | {item['count']} | "
                         f"{KIND_TEXT.get(item.get('kind'), '—')} | {parts} | "
                         f"{'；'.join(CAUSE_TEXT.get(c, cell(c)) for c in item.get('causes') or []) or '—'} | {item['last']} |")
        listed = sum(1 for item in duplicates["found"] if item.get("kind") in ("rerun", "parallel"))
        if totals and violations(totals) > listed:
            lines.append(f"违规 {violations(totals)} 项，只列最近 {listed} 项。")
        elif not totals and duplicates.get("total", 0) > len(duplicates["found"]):
            lines.append(f"共 {duplicates['total']} 项，只列最近 {len(duplicates['found'])} 项。")
    if duplicates.get("skipped"):
        lines.append(f"有 {duplicates['skipped']} 个提交 GitHub 不返回（404、410 或 422），本次跳过，沿用以前的结果。")
    if report["alerts"]:
        lines += ["", "### 当前告警", ""] + [f"- {text}" for text in report["alerts"].values()]
    lines += ["", "<details><summary>机器可读数据（clued.compute-panel/v1）</summary>", "", "```json",
              json.dumps(report, ensure_ascii=False, indent=1).replace("`", "\\u0060"), "```", "</details>",
              "", "由 `.github/workflows/clued-compute-panel.yml` 每 5 分钟更新；离线判定需要连续两轮探测在门禁通过 4 分钟后仍无人接。"
              + (f" 本轮未完成：{cell('；'.join(report['errors']))}" if report.get("errors") else ""),
              write_state(state)]
    return "\n".join(lines) + "\n"


def find_issue(client: GitHub) -> dict | None:
    issues = client.get("/issues", {"state": "open", "creator": "github-actions[bot]", "per_page": 100}) or []
    for issue in issues:
        if "pull_request" not in issue and MARKER in (issue.get("body") or ""):
            return issue
    return None


def build(client: GitHub, now: datetime, state: dict) -> dict:
    """Each read degrades on its own: a failed section is reported, and the panel and alerts still publish."""
    errors: list[str] = []

    def attempt(label: str, call, fallback):
        try:
            return call()
        except (RuntimeError, OSError) as error:
            errors.append(f"{label}: {error}")
            return fallback

    jobs = attempt("probes", lambda: probe_jobs(client), [])
    state.pop("probe_cache", None)  # replaced by "health"
    # Below LOW_BUDGET the shared token is nearly spent: read fewer runs and reuse the resident state.
    active = attempt("active jobs", lambda: active_jobs(client, LOW_ACTIVE_RUNS if client.low() else ACTIVE_RUNS), {})
    health = attempt("health", lambda: latest_health(client, jobs, state.setdefault("health", {}), now), {})
    pool: dict[str, dict] = {}
    for node in POOL:
        row = classify_node(node["name"], jobs, active, now)
        row.update(os=node["os"], site=node["site"], can_run=node["can_run"])
        row["health"] = dict(health.get(node["name"], {}))
        held = {flag for flag in ("disk", "memory") if f"{flag}:{node['name']}" in (state.get("alerts") or {})}
        row["flags"] = health_flags(row["health"], held) if row["status"] == "online" else []
        pool[node["name"]] = row
    utilization = record_utilization(state.setdefault("samples", {}), pool, now)
    metrics = state.get("metrics") or {}
    if not client.low() and (not metrics.get("as_of") or now - parse_time(metrics["as_of"]) >= METRICS_EVERY):
        batches = attempt("batch metrics", lambda: collect_batches(client, now), None)
        if batches is not None:
            metrics = {"as_of": iso(now), "day": summarize_batches(batches, now, 1),
                       "week": summarize_batches(batches, now, 7)}
            state["metrics"] = metrics
    duplicates = state.get("duplicates") or {}
    items = duplicates.get("found") or []  # between scans: the findings saved with their details
    due = not client.low() and (not duplicates.get("as_of") or now - parse_time(duplicates["as_of"]) >= DUP_EVERY)
    failed_at = parse_time(state.get("duplicates_failed_at"))
    if due and failed_at is not None and now - failed_at < DUP_FAILED_WAIT:
        # A scan that failed (after its retries) is not started again at once: the next 5-minute runs would fail the same way.
        errors.append(f"duplicate runs: 上次读取失败（{iso(failed_at)}），{int(DUP_FAILED_WAIT.total_seconds() // 60)} 分钟内不再重试")
    elif due:
        budget = []

        def scan():
            try:
                return scan_duplicates(client, now, duplicates)
            except BudgetLow:
                budget.append(True)  # the budget ran out: not a failed read, so no waiting period
                raise

        scanned = attempt("duplicate runs", scan, None)
        if scanned is None:
            if not budget:
                state["duplicates_failed_at"] = iso(now)
        else:
            state.pop("duplicates_failed_at", None)
            first_scan = not duplicates.get("as_of")
            items = scanned["found"]
            # Heads that could not be read in the first scan, or since, are "quiet": what they show once readable is
            # old news, recorded without an announcement.
            was_quiet = set(duplicates.get("quiet") or [])
            unreadable = set(scanned.pop("skipped_heads", []))
            scanned["quiet"] = sorted(unreadable if first_scan else was_quiet & unreadable)  # at most DUP_PULLS heads are read per scan
            state["duplicates"] = duplicates = pack_duplicates(scanned)
            if first_scan:
                # The first scan records what is already there and announces none of it.
                mark_announced(state, [duplicate_key(item) for item in items])
            else:
                mark_announced(state, [duplicate_key(item) for item in items if item["head"] in was_quiet - unreadable])
    events: dict[str, str] = {}
    for item in items:
        if item.get("kind") == "retry":
            continue  # a retry after failures is allowed: it is listed in the table, never announced
        key = duplicate_key(item)
        if not is_announced(state, key):  # only what is still to be said: already announced ones stay out of the report
            events[key] = duplicate_event(item)[1]
    if len(events) > DUP_ROWS:
        # A burst is announced as the first DUP_ROWS items and one line for the rest (the panel lists them all).
        extra = list(events)[DUP_ROWS:]
        mark_announced(state, extra)
        for key in extra:
            del events[key]
        # Violations are reruns and parallels only; an old record without a kind is said apart (ruling 12.2 #8).
        kinds = {duplicate_key(item): item.get("kind") for item in items}
        bad = sum(1 for key in extra if kinds.get(key) in ("rerun", "parallel"))
        said = "；".join(part for part in (f"另有 {bad} 项违规" if bad else "",
                                         f"另有 {len(extra) - bad} 项旧记录未记类别（不算违规）" if len(extra) - bad else "") if part)
        events[f"dup-more:{duplicates.get('as_of')}"] = f"重复执行：{said}，见面板“重复执行”表"
    stall = None
    if client.low():
        errors.append("residents: 额度不足，沿用上一轮常驻状态")
        residents = None
    else:
        collected = attempt("residents", lambda: collect_residents(client, now), None)
        residents, stall = (collected[0], collected[2]) if collected else (None, None)
        events.update(collected[1] if collected else {})
        merges = attempt("merges", lambda: recent_merges(client, parse_time(state.get("events_at"))), None)
        if merges is not None:  # a failed read keeps the window open, so its merges are announced next run
            events.update(merges)
            state["events_at"] = iso(now)
    if residents is None:  # keep the last known resident state (and its HALT and stall alerts) rather than clearing it
        residents, stall = state.get("residents") or {}, state.get("stall") or []
    state["residents"], state["stall"] = residents, stall
    return {
        "schema": SCHEMA,
        "generated_at": iso(now),
        "pool": pool,
        "utilization": utilization,
        "residents": residents,
        "others": OTHERS,
        "metrics": metrics,
        "duplicates": {**{key: duplicates[key] for key in ("as_of", "window_days", "heads_read", "skipped", "total", "totals", "omitted") if key in duplicates},
                       "found": (duplicates.get("found") or [])[:DUP_ROWS]},
        "alerts": alerts_for(pool, residents, stall),
        "events": events,
        "errors": errors,
    }


def alert_comment(new: dict[str, str], resolved: dict[str, str], owner: str | None,
                  events: dict[str, str] | None = None) -> str | None:
    if not new and not resolved and not events:
        return None
    # Only a new alert mentions the Owner, first so it leads the notification: events and recoveries are news, not
    # calls to act, and mentioning them drowned the 2026-11-13 HALT alert in issue #952.
    lines = []
    if new:
        lines.append(("@" + owner + " " if owner else "") + "新告警：")
        lines += [f"- {text}" for text in new.values()]  # alerts_for already escaped the untrusted parts
    if events:
        lines.append("动态：")
        lines += [f"- {text}" for text in events.values()]  # titles and descriptions already escaped by cell()
    if resolved:
        lines.append("已恢复：")
        lines += [f"- {text}" for text in resolved.values()]
    return "\n".join(lines)


def announce(client: GitHub, issue: dict | None, report: dict, state: dict, previous: dict[str, str],
             first_events: bool, owner: str | None) -> dict:
    """Comment the new and ended alerts and the new events on the panel issue (created if missing) and save them as said.

    The comment is sent before the state is saved. When it fails, the failure is recorded on the panel and the state
    keeps the previous alerts and the unsaid events, so the next run says them again; the panel itself still updates
    (the alert channel never stops it).
    """
    new = {k: v for k, v in report["alerts"].items() if k not in previous}
    resolved = {k: v for k, v in previous.items() if k not in report["alerts"]}
    said = {key: list(state.get(key) or []) for key in ("announced", "announced_dup")}
    # Events are announced once: the keys already announced stay in the state (the newest 200; duplicates have their own set).
    events = {k: v for k, v in report["events"].items() if not is_announced(state, k)}
    mark_announced(state, list(events))
    if first_events:
        events = {}
    comment = alert_comment(new, resolved, owner, events)
    if issue is None:
        # Created without alert state, so the alerts are announced by the comment below.
        issue = client.send("POST", "/issues", {"title": ISSUE_TITLE, "body": render(report, {**state, "alerts": {}})})
    if comment:
        try:
            client.send("POST", f"/issues/{issue['number']}/comments", {"body": comment})
        except (RuntimeError, OSError) as error:
            report["errors"].append(f"告警评论未发出，下一轮重发：{error}")
            print(f"::warning::compute panel alert comment failed: {error}")
            state["alerts"] = dict(previous)
            state.update(said)
    return issue


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", default=os.environ.get("GITHUB_REPOSITORY", "tdoljyj/cross-memory-system"))
    parser.add_argument("--output", help="also write the report JSON here")
    parser.add_argument("--dry-run", action="store_true", help="read only: print the panel, write no issue")
    args = parser.parse_args()
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        raise RuntimeError("GITHUB_TOKEN is required")
    client = GitHub(token, args.repository, os.environ.get("GITHUB_API_URL", "https://api.github.com"))
    now = datetime.now(timezone.utc)
    issue = find_issue(client)
    state = read_state(issue.get("body") if issue else None)
    previous = state.get("alerts") or {}
    first_events = "events_at" not in state  # the first run records what is there and announces nothing
    report = build(client, now, state)
    state["alerts"] = report["alerts"]
    body = render(report, state)
    if args.dry_run:
        print(body.replace(write_state(state), ""))
        print(json.dumps({"requests": client.requests}))
        return 0
    issue = announce(client, issue, report, state, previous, first_events, os.environ.get("GITHUB_REPOSITORY_OWNER"))
    body = render(report, state)
    for level in (1, 2, 3, 4, 5):
        if len(body) <= DUP_BODY_LIMIT:
            break
        shrink_duplicates(state, level, report)  # the body must stay under the issue limit, or no update could be written
        body = render(report, state)
    if len(body) > ISSUE_LIMIT - 500:
        report["errors"].append(f"正文 {len(body)} 字符，接近 Issue 上限 {ISSUE_LIMIT}")
        body = render(report, state)
    client.send("PATCH", f"/issues/{issue['number']}", {"body": body})
    if args.output:
        with open(args.output, "w", encoding="utf-8") as handle:
            json.dump(report, handle, ensure_ascii=False, indent=1)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as handle:
            handle.write(body.replace(write_state(state), "") + "\n")
    print(json.dumps({"issue": issue.get("number"), "alerts": list(report["alerts"]),
                      "requests": client.requests}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
