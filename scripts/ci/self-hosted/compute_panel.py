#!/usr/bin/env python3
"""Compute panel for the Clued self-hosted pool (Task 679a0c2b, Decision 183ee67c).

Runs every five minutes on a pool-general runner with the workflow's own
GITHUB_TOKEN and no other credential. It reads:

- the route probes of clued-compute-panel.yml (one job per pool runner) for
  online/offline and the disk/memory line each probe prints;
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
import json
import os
import re
import statistics
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any


SCHEMA = "clued.compute-panel/v1"
WORKFLOW = "clued-compute-panel.yml"
PROBE_PREFIX = "compute-probe / "
PROBE_LINE = re.compile(r"COMPUTE_PANEL_PROBE (\{.*\})")
MARKER = "<!-- clued-compute-panel:v1 -->"
STATE_RE = re.compile(r"<!-- clued-compute-panel-state:([A-Za-z0-9+/=]+) -->")
ISSUE_TITLE = "算力面板（自动更新）"
RESIDENT_CONTEXT = re.compile(r"^resident-queue/(.+) \(info only\)$")

ONLINE_WINDOW = timedelta(minutes=8)
UNPICKED_AFTER = timedelta(minutes=4)
LOOKBACK_RUNS = 4
METRICS_EVERY = timedelta(minutes=55)
METRICS_PULLS = 30
UTILIZATION_HOURS = 24
LOW_DISK_GB = 20.0
LOW_MEMORY_GB = 1.0

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
# Not in the general pool; listed so the panel shows every machine.
OTHERS = [
    {"name": "DESK-W-591", "status": "pending", "role": "常驻执行器待安装（Task b7d84de2）"},
    {"name": "clued-ci-home-linux-01", "status": "retired",
     "role": "已退役（Decision 183ee67c），GitHub 离线 14 天后自动移除注册"},
    {"name": "clued-ci-home-win-02", "status": "controller",
     "role": "独立 CI 控制机，按阶段拉起，平时离线，不计入算力池"},
]
STATUS_TEXT = {
    "online": "在线", "offline": "离线", "unknown": "未知", "pending": "待安装",
    "retired": "已退役", "controller": "控制机",
}


def parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # noqa: D401 - keep the token off the log host
        return None


class GitHub:
    def __init__(self, token: str, repository: str, api_url: str = "https://api.github.com") -> None:
        self.token = token
        self.repository = repository
        self.api_url = api_url.rstrip("/")
        self.requests = 0

    def _request(self, method: str, path: str, params: dict | None = None, body: Any = None,
                 follow: bool = True) -> tuple[int, Any, dict]:
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
        opener = urllib.request.build_opener() if follow else urllib.request.build_opener(_NoRedirect)
        self.requests += 1
        try:
            with opener.open(request, timeout=30) as response:
                raw = response.read()
                return response.status, (json.loads(raw) if raw else None), dict(response.headers)
        except urllib.error.HTTPError as error:
            if not follow and error.code in (301, 302, 303, 307, 308):
                return error.code, None, dict(error.headers)
            raise RuntimeError(f"{method} {path} failed ({error.code})") from None

    def get(self, path: str, params: dict | None = None) -> Any:
        return self._request("GET", f"/repos/{self.repository}{path}", params)[1]

    def send(self, method: str, path: str, body: Any) -> Any:
        return self._request(method, f"/repos/{self.repository}{path}", body=body)[1]

    def job_log(self, job_id: int) -> str:
        status, _, headers = self._request("GET", f"/repos/{self.repository}/actions/jobs/{job_id}/logs",
                                           follow=False)
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


def classify_node(name: str, probe_jobs: list[dict], active: dict[str, dict], now: datetime) -> dict:
    """Online/offline/unknown and busy for one pool runner."""
    mine = [job for job in probe_jobs if job.get("name") == PROBE_PREFIX + name]
    successes = [parse_time(job.get("completed_at")) for job in mine if job.get("conclusion") == "success"]
    successes = [time for time in successes if time]
    last_success = max(successes) if successes else None
    unpicked = [job for job in mine
                if job.get("conclusion") != "success" and not job.get("runner_name")
                and (created := parse_time(job.get("created_at"))) and now - created >= UNPICKED_AFTER]
    running = active.get(name)
    current = None if running is None or running.get("own") else running
    if running:
        status = "online"
    elif last_success and now - last_success <= ONLINE_WINDOW:
        status = "online"
    elif unpicked:
        status = "offline"
    else:
        status = "unknown"
    return {
        "status": status,
        "busy": bool(current),
        "current_job": current,
        "last_probe": iso(last_success) if last_success else None,
    }


def active_jobs(client: GitHub, limit: int = 10) -> dict[str, dict]:
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
        jobs.extend(job for job in found if str(job.get("name", "")).startswith(PROBE_PREFIX))
    return jobs


def latest_health(client: GitHub, jobs: list[dict], cache: dict) -> dict[str, dict]:
    """The newest probe line per runner; a job's log is read once (cache by job id)."""
    newest: dict[str, dict] = {}
    for job in jobs:
        if job.get("conclusion") != "success":
            continue
        name = str(job["name"])[len(PROBE_PREFIX):]
        if name not in newest or (job.get("completed_at") or "") > (newest[name].get("completed_at") or ""):
            newest[name] = job
    health: dict[str, dict] = {}
    for name, job in newest.items():
        key = str(job["id"])
        if key not in cache:
            try:
                cache[key] = parse_probe(client.job_log(job["id"])) or {}
            except (RuntimeError, OSError):
                cache[key] = {}
        health[name] = {**cache[key], "job_id": job["id"]}
    return health


def health_flags(health: dict) -> list[str]:
    flags = []
    disk = health.get("disk_free_gb")
    memory = health.get("mem_available_gb")
    if isinstance(disk, (int, float)) and disk < LOW_DISK_GB:
        flags.append("disk")
    if isinstance(memory, (int, float)) and memory < LOW_MEMORY_GB:
        flags.append("memory")
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
            # Queue wait runs from the first resident status of this head to its first running stage.
            "queued_at": rows[0].get("created_at"),
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
    and wins; otherwise a running stage; otherwise the newest row. Per-PR hints
    such as "落后 main" are only shown when nothing better exists.
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
        chosen = (next((i for i in items if i["state"] == "error"), None)
                  or next((i for i in items if "运行中" in str(i["description"])), None)
                  or items[0])
        halted = chosen["state"] == "error"
        running = "运行中" in str(chosen["description"])
        latest[node] = {**chosen, "halted": halted,
                        "activity": "halted" if halted else "running" if running else "idle"}
    return latest


def collect_residents(client: GitHub, limit: int = 20) -> dict[str, dict]:
    pulls = client.get("/pulls", {"state": "open", "sort": "updated", "direction": "desc", "per_page": limit}) or []
    combined = [(pull["number"], client.get(f"/commits/{pull['head']['sha']}/status") or {}) for pull in pulls[:limit]]
    return resident_latest(combined)


def alerts_for(pool: dict[str, dict], residents: dict[str, dict]) -> dict[str, str]:
    alerts = {}
    for name, node in pool.items():
        if node["status"] == "offline":
            alerts[f"offline:{name}"] = f"{name} 离线（最近一次探测成功：{node['last_probe'] or '无'}）"
        for flag in node.get("flags", []):
            alerts[f"{flag}:{name}"] = f"{name} {'磁盘' if flag == 'disk' else '内存'}不足"
    for node, row in residents.items():
        if row["halted"]:
            alerts[f"halt:{node}"] = f"常驻执行器 {node} 停机或未更新：{row.get('description')}（PR #{row.get('pr')}）"
    return alerts


def read_state(body: str | None) -> dict:
    match = STATE_RE.search(body or "")
    if not match:
        return {}
    try:
        value = json.loads(base64.b64decode(match.group(1)).decode("utf-8"))
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
        f"通用池 {len(pool)} 台：在线 {len(online)}，忙 {sum(1 for n in online if n['busy'])}，"
        f"空闲 {sum(1 for n in online if not n['busy'])}，离线 {sum(1 for n in pool.values() if n['status'] == 'offline')}，"
        f"未知 {sum(1 for n in pool.values() if n['status'] == 'unknown')}。告警 {len(report['alerts'])} 条。",
        "",
        "| 机器 | 状态 | 忙/闲 | 当前作业 | 能接的活 | 磁盘空闲 | 可用内存 | 24 小时利用率 | 最近探测 |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for name, node in pool.items():
        job = node.get("current_job")
        health = node.get("health", {})
        util = report["utilization"].get(name)
        lines.append("| {} | {} | {} | {} | {} | {} | {} | {} | {} |".format(
            name, STATUS_TEXT[node["status"]],
            ("忙" if node["busy"] else "闲") if node["status"] == "online" else "—",
            f"{job['workflow']} / {job['job']}" if job else "—",
            "、".join(node["can_run"]),
            f"{health['disk_free_gb']} GB" if "disk_free_gb" in health else "—",
            f"{health['mem_available_gb']} GB" if "mem_available_gb" in health else "—",
            f"{util}%" if util is not None else "—",
            node["last_probe"] or "—",
        ))
    lines += ["", "| 其他机器 | 状态 | 说明 |", "|---|---|---|"]
    for name, row in report["residents"].items():
        activity = {"halted": "停机", "running": "运行中", "idle": "空闲（无运行中批次）"}[row["activity"]]
        lines.append(f"| 常驻 {name} | {activity} | 最近状态：{row.get('description')}（PR #{row.get('pr')}，{row.get('at')}） |")
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
    if report["alerts"]:
        lines += ["", "### 当前告警", ""] + [f"- {text}" for text in report["alerts"].values()]
    lines += ["", "<details><summary>机器可读数据（clued.compute-panel/v1）</summary>", "", "```json",
              json.dumps({k: v for k, v in report.items()}, ensure_ascii=False, indent=1), "```", "</details>",
              "", "由 `.github/workflows/clued-compute-panel.yml` 每 5 分钟更新；离线判定需要至少一次探测在 4 分钟内无人接。",
              write_state(state)]
    return "\n".join(lines) + "\n"


def find_issue(client: GitHub) -> dict | None:
    issues = client.get("/issues", {"state": "open", "creator": "github-actions[bot]", "per_page": 100}) or []
    for issue in issues:
        if "pull_request" not in issue and MARKER in (issue.get("body") or ""):
            return issue
    return None


def build(client: GitHub, now: datetime, state: dict) -> dict:
    cache = state.setdefault("probe_cache", {})
    jobs = probe_jobs(client)
    active = active_jobs(client)
    health = latest_health(client, jobs, cache)
    live_ids = {str(row["job_id"]) for row in health.values()}
    state["probe_cache"] = {key: value for key, value in cache.items() if key in live_ids}
    pool: dict[str, dict] = {}
    for node in POOL:
        row = classify_node(node["name"], jobs, active, now)
        row.update(os=node["os"], site=node["site"], can_run=node["can_run"])
        row["health"] = {k: v for k, v in health.get(node["name"], {}).items() if k != "job_id"}
        row["flags"] = health_flags(row["health"]) if row["status"] == "online" else []
        pool[node["name"]] = row
    utilization = record_utilization(state.setdefault("samples", {}), pool, now)
    metrics = state.get("metrics") or {}
    if not metrics.get("as_of") or now - parse_time(metrics["as_of"]) >= METRICS_EVERY:
        batches = collect_batches(client, now)
        metrics = {"as_of": iso(now), "day": summarize_batches(batches, now, 1),
                   "week": summarize_batches(batches, now, 7)}
        state["metrics"] = metrics
    residents = collect_residents(client)
    return {
        "schema": SCHEMA,
        "generated_at": iso(now),
        "pool": pool,
        "utilization": utilization,
        "residents": residents,
        "others": OTHERS,
        "metrics": metrics,
        "alerts": alerts_for(pool, residents),
    }


def alert_comment(new: dict[str, str], resolved: dict[str, str], owner: str | None) -> str | None:
    if not new and not resolved:
        return None
    lines = []
    if new:
        lines.append(("@" + owner + " " if owner else "") + "新告警：")
        lines += [f"- {text}" for text in new.values()]
    if resolved:
        lines.append("已恢复：")
        lines += [f"- {text}" for text in resolved.values()]
    return "\n".join(lines)


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
    report = build(client, now, state)
    state["alerts"] = report["alerts"]
    body = render(report, state)
    if args.dry_run:
        print(body.replace(write_state(state), ""))
        print(json.dumps({"requests": client.requests}))
        return 0
    if issue is None:
        issue = client.send("POST", "/issues", {"title": ISSUE_TITLE, "body": body})
    else:
        client.send("PATCH", f"/issues/{issue['number']}", {"body": body})
    new = {k: v for k, v in report["alerts"].items() if k not in previous}
    resolved = {k: v for k, v in previous.items() if k not in report["alerts"]}
    comment = alert_comment(new, resolved, os.environ.get("GITHUB_REPOSITORY_OWNER"))
    if comment:
        client.send("POST", f"/issues/{issue['number']}/comments", {"body": comment})
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
