from __future__ import annotations

import importlib.util
import json
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def load_module(name: str, relative: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


panel = load_module("clued_compute_panel", "scripts/ci/self-hosted/compute_panel.py")
NOW = datetime(2026, 10, 29, 12, 0, tzinfo=timezone.utc)
NAME = "clued-ci-company-linux-03"


def at(minutes_ago: float) -> str:
    return panel.iso(NOW - timedelta(minutes=minutes_ago))


def probe(conclusion: str | None, created: float, completed: float | None = None, runner: str = NAME,
          gate: float | None | str = "auto") -> dict:
    """A probe of the run created `created` minutes ago; its gate passed half a minute later unless told otherwise."""
    gate_done = created - 0.5 if gate == "auto" else gate
    return {
        "id": int(created * 100), "run_id": int(created * 100), "name": panel.PROBE_PREFIX + NAME,
        "conclusion": conclusion, "status": "completed" if conclusion else "queued",
        "created_at": at(created), "completed_at": at(completed) if completed is not None else None,
        "runner_name": runner if conclusion == "success" else "",
        "gate_done": at(gate_done) if gate_done is not None else None,
    }


class ClassifyNodeTests(unittest.TestCase):
    def test_recent_probe_is_online_and_idle(self) -> None:
        row = panel.classify_node(NAME, [probe("success", 3, 2)], {}, NOW)
        self.assertEqual((row["status"], row["busy"]), ("online", False))
        self.assertEqual(row["last_probe"], at(2))

    def test_busy_runner_is_online_even_when_its_probe_waits(self) -> None:
        job = {"workflow": "gitleaks", "job": "scan", "since": at(30)}
        row = panel.classify_node(NAME, [probe(None, 9)], {NAME: job}, NOW)
        self.assertEqual((row["status"], row["busy"], row["current_job"]), ("online", True, job))

    def test_own_probe_job_proves_online_but_not_busy(self) -> None:
        own = {"workflow": "clued-compute-panel", "job": panel.PROBE_PREFIX + NAME, "since": at(0), "own": True}
        row = panel.classify_node(NAME, [], {NAME: own}, NOW)
        self.assertEqual((row["status"], row["busy"], row["current_job"]), ("online", False, None))

    def test_two_unpicked_runs_are_offline(self) -> None:
        jobs = [probe("success", 20, 19), probe("cancelled", 10, 5), probe(None, 5)]
        self.assertEqual(panel.classify_node(NAME, jobs, {}, NOW)["status"], "offline")

    def test_one_unpicked_run_is_not_yet_offline(self) -> None:
        jobs = [probe("success", 20, 19), probe("cancelled", 10, 5), probe(None, 2)]
        self.assertEqual(panel.classify_node(NAME, jobs, {}, NOW)["status"], "unknown")

    def test_skipped_or_gate_less_probes_never_count(self) -> None:
        # Review MAJOR 1: a skipped probe (gate failed) or one cancelled before the gate passed.
        jobs = [probe("success", 20, 19), probe("skipped", 11, 10.5, gate=None),
                probe("cancelled", 6, 1, gate=None), probe("skipped", 16, 15.5)]
        self.assertEqual(panel.classify_node(NAME, jobs, {}, NOW)["status"], "unknown")

    def test_cancelled_soon_after_its_gate_does_not_count(self) -> None:
        jobs = [probe("cancelled", 10, 8), probe("cancelled", 5, 3)]
        self.assertEqual(panel.classify_node(NAME, jobs, {}, NOW)["status"], "unknown")

    def test_no_probe_at_all_is_unknown(self) -> None:
        self.assertEqual(panel.classify_node(NAME, [], {}, NOW)["status"], "unknown")

    def test_other_runners_probes_do_not_count(self) -> None:
        other = {**probe("success", 3, 2), "name": panel.PROBE_PREFIX + "clued-ci-company-linux-01"}
        self.assertEqual(panel.classify_node(NAME, [other], {}, NOW)["status"], "unknown")


class ProbeLineTests(unittest.TestCase):
    def test_parses_the_output_line_and_skips_the_echoed_script(self) -> None:
        log = (
            '2026-10-29T12:00:00Z printf \'COMPUTE_PANEL_PROBE {"runner":"%s","disk_free_gb":%s}\\n\'\n'
            '2026-10-29T12:00:01Z COMPUTE_PANEL_PROBE {"runner":"r","os":"Linux","disk_free_gb":81.5,"mem_available_gb":4.2}\n'
        )
        self.assertEqual(panel.parse_probe(log)["disk_free_gb"], 81.5)

    def test_low_disk_and_memory_flags(self) -> None:
        self.assertEqual(panel.health_flags({"disk_free_gb": 12.0, "mem_available_gb": 0.5}), ["disk", "memory"])
        self.assertEqual(panel.health_flags({"disk_free_gb": 90.0, "mem_available_gb": 8.0}), [])
        self.assertEqual(panel.health_flags({}), [])


class UtilizationTests(unittest.TestCase):
    def test_busy_share_counts_only_online_samples_and_drops_old_hours(self) -> None:
        samples = {NAME: {str(int((NOW - timedelta(hours=30)).timestamp())): [5, 5]}}
        nodes = {NAME: {"status": "online", "busy": True}}
        self.assertEqual(panel.record_utilization(samples, nodes, NOW)[NAME], 100.0)
        nodes[NAME]["busy"] = False
        self.assertEqual(panel.record_utilization(samples, nodes, NOW + timedelta(minutes=5))[NAME], 50.0)
        nodes[NAME]["status"] = "offline"
        self.assertEqual(panel.record_utilization(samples, nodes, NOW + timedelta(minutes=10))[NAME], 50.0)
        self.assertEqual(len(samples[NAME]), 1)


def status(minutes_ago: float, state: str, description: str, node: str = "turing") -> dict:
    return {"context": f"resident-queue/{node} (info only)", "state": state,
            "description": description, "created_at": at(minutes_ago), "updated_at": at(minutes_ago)}


class ResidentTests(unittest.TestCase):
    def test_batch_from_status_history(self) -> None:
        rows = [
            status(60, "pending", "排队第 1 位"),
            status(55, "pending", "当班：运行中：第 0 段（准备）"),
            status(30, "pending", "暂时失败（X），将自动第二次尝试"),
            status(20, "success", "已完成：常驻执行器跑完八段，检查已发布"),
            {"context": "gitleaks", "state": "success", "created_at": at(1)},
        ]
        batch = panel.resident_batches(rows)["turing"]
        self.assertEqual((batch["outcome"], batch["retries"], batch["burned"]), ("passed", 1, 0))
        summary = panel.summarize_batches([batch], NOW, 1)
        self.assertEqual(summary["queue_wait_minutes_median"], 5.0)
        self.assertEqual(summary["batch_minutes_median"], 35.0)
        self.assertEqual((summary["batches"], summary["failure_rate"]), (1, 0.0))

    def test_a_hint_that_never_ran_is_not_a_batch(self) -> None:
        rows = [status(10, "failure", "落后 main 3 个提交：请合入最新 main 并推送")]
        self.assertEqual(panel.resident_batches(rows), {})

    def test_burned_head_and_failure_rate(self) -> None:
        rows = [status(50, "pending", "当班：运行中：第 2 段（gitleaks 扫描）"),
                status(40, "failure", "失败（X）：此提交不再运行，请推新提交")]
        batch = panel.resident_batches(rows)["turing"]
        summary = panel.summarize_batches([batch, {**batch, "outcome": "running", "ended_at": None}], NOW, 7)
        self.assertEqual((summary["batches"], summary["failed"], summary["burned_heads"]), (1, 1, 1))

    def test_error_row_wins_as_halt(self) -> None:
        combined = [
            (1, {"statuses": [status(1, "failure", "落后 main 1 个提交：请合入最新 main 并推送")]}),
            (2, {"statuses": [status(3, "error", "执行器已停机（X），等 Owner 复位")]}),
        ]
        row = panel.resident_latest(combined)["turing"]
        self.assertEqual((row["halted"], row["activity"], row["pr"]), (True, "halted", 2))

    def test_old_error_clears_once_the_executor_writes_again(self) -> None:
        # Review MAJOR 3: an error left on an open PR must not keep the node halted.
        combined = [
            (1, {"statuses": [status(30, "error", "执行器停机（X），等 Owner 复位")]}),
            (2, {"statuses": [status(2, "pending", "当班：运行中：第 1 段（准备）")]}),
        ]
        row = panel.resident_latest(combined)["turing"]
        self.assertEqual((row["halted"], row["activity"]), (False, "running"))

    def test_queue_wait_ignores_hints_before_the_queue(self) -> None:
        rows = [status(90, "failure", "落后 main 1 个提交：请合入最新 main 并推送"),
                status(30, "pending", "排队第 2 位"),
                status(20, "pending", "当班：运行中：第 0 段（准备）"),
                status(10, "success", "已完成")]
        summary = panel.summarize_batches([panel.resident_batches(rows)["turing"]], NOW, 1)
        self.assertEqual(summary["queue_wait_minutes_median"], 10.0)

    def test_unsafe_node_names_are_ignored(self) -> None:
        bad = {**status(1, "error", "x"), "context": "resident-queue/a|b @x (info only)"}
        self.assertEqual(panel.resident_latest([(1, {"statuses": [bad]})]), {})

    def test_running_row_beats_a_newer_hint(self) -> None:
        combined = [
            (1, {"statuses": [status(1, "failure", "落后 main 1 个提交：请合入最新 main 并推送")]}),
            (2, {"statuses": [status(4, "pending", "当班：运行中：第 4 段（trivy 扫描）")]}),
        ]
        self.assertEqual(panel.resident_latest(combined)["turing"]["activity"], "running")


class AlertAndStateTests(unittest.TestCase):
    def test_alerts_and_comment_on_change_only(self) -> None:
        pool = {NAME: {"status": "offline", "last_probe": None, "flags": []},
                "clued-ci-home-win-01": {"status": "online", "last_probe": at(1), "flags": ["disk"]}}
        residents = {"turing": {"halted": True, "description": "执行器已停机（X）", "pr": 7}}
        alerts = panel.alerts_for(pool, residents)
        self.assertEqual(set(alerts), {f"offline:{NAME}", "disk:clued-ci-home-win-01", "halt:turing"})
        self.assertIsNone(panel.alert_comment({}, {}, "owner"))
        comment = panel.alert_comment({"halt:turing": "停机"}, {"offline:x": "x 离线"}, "owner")
        self.assertTrue(comment.startswith("@owner 新告警："))
        self.assertIn("已恢复：", comment)

    def test_failed_batches_and_merges_become_events(self) -> None:
        pulls = [{"number": 12, "title": "Fix | it"}]
        combined = [(12, {"sha": "abcdef1234567890", "statuses": [
            {"context": "resident-queue/turing (info only)", "state": "failure", "description": "失败：gitleaks"},
            {"context": "gitleaks", "state": "failure", "description": "not a resident row"}]}),
                    (13, {"sha": "1111111111111111", "statuses": [
            {"context": "resident-queue/turing (info only)", "state": "failure", "description": "落后 main 3 个提交"}]})]
        events = panel.batch_failures(pulls, combined)
        self.assertEqual(list(events), ["failed:12:abcdef123456:turing"])
        self.assertIn("Fix \\| it", events["failed:12:abcdef123456:turing"])

        class Closed:
            def get(self, path: str, params: dict | None = None):
                return [{"number": 20, "title": "new", "merged_at": at(1)},
                        {"number": 19, "title": "old", "merged_at": at(60)},
                        {"number": 18, "title": "closed unmerged", "merged_at": None}]

        self.assertEqual(panel.recent_merges(Closed(), None), {})  # first run: no history replay
        merged = panel.recent_merges(Closed(), NOW - timedelta(minutes=10))
        self.assertEqual(list(merged), ["merged:20"])
        comment = panel.alert_comment({}, {}, "owner", merged)
        self.assertTrue(comment.startswith("@owner 动态："))
        self.assertIn("PR #20", comment)

    def test_untrusted_text_is_inert(self) -> None:
        self.assertEqual(panel.cell("a|b `c` @owner <x>\nnext"), "a\\|b 'c' ＠owner &lt;x&gt; next")

    def test_the_last_state_comment_wins(self) -> None:
        forged = panel.write_state({"alerts": {"forged": "x"}})
        real = panel.write_state({"alerts": {}})
        self.assertEqual(panel.read_state(f"{forged}\n...\n{real}\n"), {"alerts": {}})

    def test_low_budget_reads_less_and_keeps_the_resident_state(self) -> None:
        class LowClient:
            def __init__(self) -> None:
                self.paths: list[tuple[str, dict]] = []

            def low(self) -> bool:
                return True

            def get(self, path: str, params: dict | None = None):
                self.paths.append((path, params or {}))
                return {}

        client = LowClient()
        kept = {"turing": {"halted": True, "activity": "halted", "description": "停机", "pr": 3, "at": at(9)}}
        report = panel.build(client, NOW, {"residents": kept, "probe_cache": {"1": {}}})
        self.assertEqual(report["residents"], kept)
        self.assertIn("halt:turing", report["alerts"])
        self.assertFalse(any(path == "/pulls" for path, _ in client.paths))
        runs = [params for path, params in client.paths if path == "/actions/runs"]
        self.assertEqual(runs[0]["per_page"], panel.LOW_ACTIVE_RUNS)

    def test_state_round_trip_inside_the_issue_body(self) -> None:
        state = {"alerts": {"halt:turing": "停机"}, "samples": {}}
        body = "panel\n" + panel.write_state(state) + "\n"
        self.assertEqual(panel.read_state(body), state)
        self.assertEqual(panel.read_state("no state here"), {})
        self.assertNotIn("--", panel.write_state(state)[4:-3])

    def test_render_lists_current_machines_without_stale_rows(self) -> None:
        pool = {node["name"]: {**panel.classify_node(node["name"], [], {}, NOW), "can_run": node["can_run"],
                                "health": {}, "flags": []} for node in panel.POOL}
        report = {"schema": panel.SCHEMA, "generated_at": panel.iso(NOW), "pool": pool,
                  "utilization": {}, "residents": {"desk-w-591": {"activity": "idle", "description": "当班，正常"}},
                  "others": panel.OTHERS, "metrics": {}, "alerts": {}}
        body = panel.render(report, {})
        self.assertTrue(body.startswith(panel.MARKER))
        self.assertIn("通用 runner 6 个", body)
        for name in [node["name"] for node in panel.POOL] + [other["name"] for other in panel.OTHERS]:
            self.assertIn(name, body)
        self.assertNotIn("clued-ci-home-linux-01", body)
        self.assertNotIn("待安装", body)
        self.assertEqual(body.count("| 常驻 desk-w-591 |"), 1)
        self.assertIn("控制机", body)


class MaintenanceTelemetryTests(unittest.TestCase):
    def test_invalid_telemetry_never_becomes_healthy(self):
        for value in ['{"status":"ok","removed_bytes":NaN}', '{"status":"ok","node_id":"<script>"}',
                      '{"status":"unknown"}', '[]', '{"status":"ok","at":999999999999}',
                      '{"status":"ok","removed_bytes":' + '9' * 400 + '}']:
            self.assertEqual(panel.parse_maintenance("CACHE_MAINTENANCE_PROBE " + value, NOW)["status"], "invalid")

    def test_not_registered_is_explicit_but_registered_failures_alert(self):
        self.assertEqual(panel.parse_maintenance('CACHE_MAINTENANCE_PROBE {"status":"not-registered"}', NOW),
                         {"status": "not-registered"})
        self.assertNotIn("maintenance", panel.health_flags({"maintenance": {"status": "not-registered"}}))
        row = {"status": "online", "health": {"maintenance": {"status": "partial"}}, "flags": ["maintenance"]}
        self.assertIn("缓存维护异常", panel.alerts_for({NAME: row}, {})["maintenance:" + NAME])

    def test_cached_report_ages_without_new_log_fetch(self):
        class Client:
            def low(self):
                return True
        old = {NAME: {"fetched_at": panel.iso(NOW), "maintenance": {"node_id": "desk-w-591", "status": "ok",
            "at": NOW.timestamp() - 7200, "stale_after_seconds": 3600, "removed_bytes": 100}}}
        health = panel.latest_health(Client(), [], old, NOW)
        self.assertEqual(health[NAME]["maintenance"]["status"], "stale")
        self.assertEqual(old[NAME]["maintenance"]["status"], "ok")


def check(name: str, started_min_ago: float, conclusion: str | None = "success", *, external: str | None = None,
          run: int | None = None, app: str = "github-actions", status: str | None = None) -> dict:
    """A check run as GitHub returns it: a resident one has an independent-ci external_id, a hosted one a run URL."""
    return {
        "id": int(started_min_ago * 1000) + len(name), "name": name, "app": app,
        "status": status or ("completed" if conclusion else "in_progress"), "conclusion": conclusion,
        "started_at": at(started_min_ago), "completed_at": at(started_min_ago - 1) if conclusion else None,
        "external_id": external,
        "details_url": f"https://github.com/o/r/actions/runs/{run}/job/{run}1" if run else "https://github.com/o/r",
    }


def resident(name: str, ago: float, kind: str = "staged", attempt: int = 1, conclusion: str = "success") -> dict:
    tail = f":a{attempt}" if kind.startswith("staged") else f":a{attempt}:c9c0c019a:f1:e1"
    return check(name, ago, conclusion, external=f"independent-ci:{kind}:v2:{'0' * 64}{tail}",
                 app="clued-ci-checks-turing-20261018")


WORKFLOWS = {
    11: {"path": ".github/workflows/gitleaks.yml", "name": "gitleaks", "event": "pull_request", "attempt": 1},
    12: {"path": ".github/workflows/trivy.yml", "name": "trivy", "event": "pull_request", "attempt": 1},
    21: {"path": ".github/workflows/a.yml", "name": "a", "event": "pull_request", "attempt": 1},
    22: {"path": ".github/workflows/b.yml", "name": "b", "event": "pull_request", "attempt": 1},
    23: {"path": ".github/workflows/a.yml", "name": "a", "event": "pull_request_target", "attempt": 2},
}
PULL = {"number": 7, "title": "x", "merged_at": None}
SHA = "a" * 40


def findings(checks: list[dict], pull: dict | None = None) -> list[dict]:
    return panel.duplicate_findings(SHA, pull or PULL, checks, WORKFLOWS, NOW)


class DuplicateRunTests(unittest.TestCase):
    def test_one_run_per_check_is_not_a_duplicate(self) -> None:
        self.assertEqual(findings([resident("gitleaks", 30), resident("trivy", 25),
                                   check("gitleaks-hosted-executor", 5, run=11) | {"name": "other-job"}]), [])

    def test_hosted_executor_and_resident_are_the_same_check(self) -> None:
        (item,) = findings([check("gitleaks-hosted-executor", 40, run=11), resident("gitleaks", 30), resident("trivy", 25)])
        self.assertEqual((item["check"], item["count"], item["causes"]), ("gitleaks", 2, ["cross-executor"]))
        self.assertEqual([run["executor"] for run in item["runs"]], ["hosted", "resident"])
        self.assertEqual(item["pr"], 7)

    def test_skipped_cancelled_and_queued_copies_never_count(self) -> None:
        self.assertEqual(findings([
            resident("gitleaks", 30), check("gitleaks-hosted-executor", 40, "skipped", run=11),
            check("gitleaks-hosted-executor", 38, "cancelled", run=11),
            check("gitleaks-hosted-executor", 36, None, run=11, status="queued"),
            check("gitleaks-hosted-executor-skipped", 35, "skipped", run=11),
            check("gitleaks-hosted-executor", 34, "neutral", run=11),
        ]), [])

    def test_a_running_check_counts_once_it_has_started(self) -> None:
        (item,) = findings([check("gitleaks-hosted-executor", 4, None, run=11), resident("gitleaks", 2, conclusion="failure")])
        self.assertEqual(item["count"], 2)

    def test_resident_admission_and_stage_8_rechecks_are_not_runs(self) -> None:
        self.assertEqual(findings([
            resident("kooyumi-work-admission", 60, "native-work-admission", 1),
            resident("kooyumi-work-admission", 30, "native-work-admission", 2),
            resident("kooyumi-merge-slot", 20, "control"), resident("kooyumi-merge-slot", 15, "control"),
            resident("kooyumi-admission-verified", 20, "control"), resident("kooyumi-admission-verified", 10, "control", 2),
            resident("gitleaks", 25, attempt=2),
        ]), [])

    def test_a_relay_of_a_hosted_result_is_not_a_second_run(self) -> None:
        self.assertEqual(findings([check("gitleaks-hosted-executor", 40, run=11), resident("gitleaks", 30, "staged-relay")]), [])

    def test_the_resident_second_attempt_counts_when_a_scan_really_ran_twice(self) -> None:
        (item,) = findings([resident("trivy", 50, attempt=1), resident("trivy", 20, attempt=2)])
        self.assertEqual((item["count"], item["causes"], [run["attempt"] for run in item["runs"]]),
                         (2, ["same-executor"], [1, 2]))

    def test_same_job_name_in_different_workflows_is_different_checks(self) -> None:
        self.assertEqual(findings([check("validate", 30, run=21), check("validate", 29, run=22)]), [])

    def test_admission_gates_are_control_jobs(self) -> None:
        self.assertEqual(findings([check("admission-gate", 30, run=21), check("admission-gate", 20, run=23)]), [])

    def test_a_hosted_job_run_twice_in_one_workflow_is_a_duplicate(self) -> None:
        (item,) = findings([check("validate", 30, run=21), check("validate", 20, run=23)])
        self.assertEqual((item["check"], item["causes"]), (".github/workflows/a.yml::validate", ["same-executor"]))
        self.assertEqual([run["event"] for run in item["runs"]], ["pull_request", "pull_request_target"])

    def test_a_merged_pr_scheduled_again_is_named(self) -> None:
        merged = {**PULL, "merged_at": at(30)}
        (item,) = findings([resident("gitleaks", 50), resident("gitleaks", 10, attempt=2)], merged)
        self.assertEqual(item["causes"], ["after-merge"])
        # both runs before the merge: only the executors decide
        (item,) = findings([resident("gitleaks", 50), resident("gitleaks", 40, attempt=2)], merged)
        self.assertEqual(item["causes"], ["same-executor"])

    def test_event_key_changes_when_the_count_grows_and_text_is_inert(self) -> None:
        pull = {**PULL, "title": "a|b @owner"}
        two = findings([resident("gitleaks", 50), resident("gitleaks", 40, attempt=2)], pull)[0]
        three = findings([resident("gitleaks", 50), resident("gitleaks", 40, attempt=2),
                          resident("gitleaks", 30, attempt=3)], pull)[0]
        key2, text = panel.duplicate_event(two)
        key3, _ = panel.duplicate_event(three)
        self.assertNotEqual(key2, key3)
        self.assertIn("真跑了 2 次", text)
        self.assertNotIn("@owner", text)
        self.assertNotIn("a|b", text)


class FakeGitHub:
    """Serves the read endpoints the duplicate scan uses; counts requests."""

    def __init__(self, pulls: list[dict], checks: dict[str, list[dict]], runs: dict[str, list[dict]] | None = None,
                 fail: str | None = None) -> None:
        self.pulls, self.checks, self.runs, self.fail = pulls, checks, runs or {}, fail
        self.paths: list[str] = []
        self.remaining: int | None = None

    def low(self) -> bool:
        return self.remaining is not None and self.remaining < panel.LOW_BUDGET

    def get(self, path: str, params: dict | None = None):
        params = params or {}
        self.paths.append(path)
        if self.fail and self.fail in path:
            raise RuntimeError(f"GET {path} failed (403)")
        if path == "/pulls":
            return self.pulls
        if path == "/actions/runs":
            return {"workflow_runs": self.runs.get(params["head_sha"], [])}
        sha = path.split("/")[2]
        rows = self.checks.get(sha, [])
        page = params.get("page", 1)
        return {"total_count": len(rows), "check_runs": rows[(page - 1) * 100: page * 100]}


class BuildClient(FakeGitHub):
    """FakeGitHub plus the other reads build() makes, all empty."""

    def get(self, path: str, params: dict | None = None):
        params = params or {}
        if path == "/pulls" and params.get("state") != "all":
            return []
        if path.startswith("/actions/workflows") or (path == "/actions/runs" and "head_sha" not in params):
            return {"workflow_runs": []}
        if path.endswith("/status"):
            return {}
        if path.endswith("/statuses"):
            return []
        if path == "/pulls" and params.get("state") == "closed":
            return []
        return super().get(path, params)


def pull(number: int, sha: str, state: str = "open", updated_min_ago: float = 10,
         merged_min_ago: float | None = None) -> dict:
    return {"number": number, "title": f"pr {number}", "state": state, "head": {"sha": sha}, "updated_at": at(updated_min_ago),
            "merged_at": at(merged_min_ago) if merged_min_ago is not None else None}


class DuplicateScanTests(unittest.TestCase):
    def test_scan_reads_two_endpoints_per_head_and_reports_findings(self) -> None:
        dup = [resident("gitleaks", 50), resident("gitleaks", 40, attempt=2)]
        client = FakeGitHub([pull(1, "a" * 40), pull(2, "b" * 40)], {"a" * 40: dup, "b" * 40: [resident("trivy", 20)]})
        result = panel.scan_duplicates(client, NOW, {})
        self.assertEqual(client.paths.count("/pulls"), 1)
        self.assertEqual(len(client.paths), 1 + 2 * 2)
        self.assertEqual((result["heads_read"], [(item["pr"], item["check"]) for item in result["found"]]),
                         (2, [(1, "gitleaks")]))

    def test_old_prs_are_not_read_and_old_findings_age_out(self) -> None:
        client = FakeGitHub([pull(1, "a" * 40, updated_min_ago=4 * 24 * 60)], {})
        self.assertEqual(panel.scan_duplicates(client, NOW, {})["heads_read"], 0)
        old = {"head": "c" * 12, "last": at(5 * 24 * 60), "check": "x"}
        self.assertEqual(panel.scan_duplicates(FakeGitHub([], {}), NOW, {"found": [old]})["found"], [])

    def test_settled_closed_pr_is_not_read_again_but_a_recently_merged_one_is(self) -> None:
        dup = [resident("gitleaks", 50), resident("gitleaks", 40, attempt=2)]
        closed = pull(1, "a" * 40, "closed", updated_min_ago=3 * 60, merged_min_ago=30 * 60)
        recent = pull(2, "b" * 40, "closed", updated_min_ago=3 * 60, merged_min_ago=2 * 60)
        checks = {"a" * 40: dup, "b" * 40: dup}
        first = panel.scan_duplicates(FakeGitHub([closed, recent], checks), NOW, {})
        self.assertEqual(sorted(first["settled"]), ["a" * 12])
        again = FakeGitHub([closed, recent], checks)
        second = panel.scan_duplicates(again, NOW + timedelta(hours=1), first)
        self.assertEqual(len(again.paths), 1 + 2)  # only the recently merged head is read
        self.assertEqual(sorted(item["pr"] for item in second["found"]), [1, 2])

    def test_a_pr_updated_after_it_settled_is_read_again(self) -> None:
        closed = pull(1, "a" * 40, "closed", updated_min_ago=3 * 60)
        first = panel.scan_duplicates(FakeGitHub([closed], {}), NOW, {})
        moved = {**closed, "updated_at": at(1)}
        client = FakeGitHub([moved], {})
        panel.scan_duplicates(client, NOW, first)
        self.assertEqual(len(client.paths), 3)

    def test_check_runs_are_read_page_by_page(self) -> None:
        many = [resident(f"c{i}", 90 - i * 0.1) for i in range(130)]
        client = FakeGitHub([pull(1, "a" * 40)], {"a" * 40: many})
        panel.scan_duplicates(client, NOW, {})
        self.assertEqual(client.paths.count("/commits/" + "a" * 40 + "/check-runs"), 2)

    def test_a_failed_read_raises_so_the_previous_result_stays(self) -> None:
        client = FakeGitHub([pull(1, "a" * 40)], {}, fail="check-runs")
        with self.assertRaises(RuntimeError):
            panel.scan_duplicates(client, NOW, {})

    def test_low_budget_stops_the_scan(self) -> None:
        client = FakeGitHub([pull(1, "a" * 40)], {})
        client.remaining = 10
        with self.assertRaises(RuntimeError):
            panel.scan_duplicates(client, NOW, {})


class DuplicateBuildTests(unittest.TestCase):
    def setUp(self) -> None:
        self.dup = [resident("gitleaks", 50), resident("gitleaks", 40, attempt=2)]

    def client(self, **kwargs) -> BuildClient:
        return BuildClient([pull(1, "a" * 40)], {"a" * 40: self.dup}, **kwargs)

    def test_first_scan_records_without_announcing_then_a_new_duplicate_is_announced_once(self) -> None:
        state: dict = {}
        report = panel.build(self.client(), NOW, state)
        key = panel.duplicate_event(report["duplicates"]["found"][0])[0]
        self.assertEqual(len(report["duplicates"]["found"]), 1)
        self.assertIn(key, state["announced"])  # main() announces only the keys not in `announced`
        # a duplicate on a new head at the next scan is not yet recorded: it will be announced
        newer = BuildClient([pull(1, "a" * 40), pull(2, "b" * 40)], {"a" * 40: self.dup, "b" * 40: self.dup})
        report = panel.build(newer, NOW + timedelta(hours=1), state)
        fresh = [k for k in report["events"] if k.startswith("dup:") and k not in state["announced"]]
        self.assertEqual(len(fresh), 1)
        self.assertIn("b" * 12, fresh[0])

    def test_no_rescan_within_the_interval_and_a_failed_scan_keeps_the_last_result(self) -> None:
        state: dict = {}
        panel.build(self.client(), NOW, state)
        again = self.client()
        panel.build(again, NOW + timedelta(minutes=5), state)
        self.assertNotIn("/commits/" + "a" * 40 + "/check-runs", again.paths)
        failing = self.client(fail="check-runs")
        report = panel.build(failing, NOW + timedelta(hours=1), state)
        self.assertEqual(len(report["duplicates"]["found"]), 1)
        self.assertTrue(any(error.startswith("duplicate runs:") for error in report["errors"]))

    def test_render_shows_the_table_or_says_none_found(self) -> None:
        state: dict = {}
        report = panel.build(self.client(), NOW, state)
        body = panel.render(report, state)
        self.assertIn("### 重复执行", body)
        self.assertIn("| #1 | " + "a" * 8 + " | gitleaks | 2 |", body)
        clean_client = BuildClient([pull(1, "a" * 40)], {"a" * 40: [resident("gitleaks", 5)]})
        self.assertIn("没有发现", panel.render(panel.build(clean_client, NOW, {}), {}))
        unread = panel.render(panel.build(BuildClient([], {}, fail="check-runs"), NOW, {}), {})
        self.assertIn("没有发现", unread)  # an empty list of PRs is a scan with nothing to read
        broken = panel.render(panel.build(BuildClient([pull(1, "a" * 40)], {}, fail="check-runs"), NOW, {}), {})
        self.assertIn("尚未采集", broken)


FIXTURE = ROOT / "tests" / "fixtures" / "compute-panel-duplicate-runs.json"


class RecordedGitHub:
    """Serves a recorded snapshot of the repository's recent PR heads (check runs and workflow runs, 2026-10-30 to
    11-04), as the scan would read them at `now`: only PRs updated by then are listed."""

    def __init__(self, now: datetime) -> None:
        self.heads = json.loads(FIXTURE.read_text(encoding="utf-8"))["heads"]
        self.now = now
        self.paths: list[str] = []

    def low(self) -> bool:
        return False

    @staticmethod
    def api_check(row: list) -> dict:
        name, status, conclusion, started, external, run = row
        return {"name": name, "status": status, "conclusion": conclusion, "started_at": started, "external_id": external,
                "details_url": f"https://github.com/o/r/actions/runs/{run}/job/1" if run else "https://github.com/o/r"}

    def get(self, path: str, params: dict | None = None):
        params = params or {}
        self.paths.append(path)
        if path == "/pulls":
            listed = sorted((h for h in self.heads if h["updated_at"] <= panel.iso(self.now)),
                            key=lambda h: h["updated_at"], reverse=True)
            return [{"number": h["pr"], "title": "recorded", "state": h["state"], "head": {"sha": h["sha"]},
                     "updated_at": h["updated_at"], "merged_at": h["merged_at"]} for h in listed][:params["per_page"]]
        head = next(h for h in self.heads if h["sha"] == (params.get("head_sha") or path.split("/")[2]))
        if path == "/actions/runs":
            return {"workflow_runs": [{"id": int(run), "path": row[0], "name": row[1], "event": row[2], "run_attempt": row[3]}
                                      for run, row in head["workflows"].items()]}
        return {"check_runs": [self.api_check(row) for row in head["checks"]]}


class RecordedDataTests(unittest.TestCase):
    """The detector over what GitHub really returned for 55 PR heads (762 check runs)."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.heads = json.loads(FIXTURE.read_text(encoding="utf-8"))["heads"]

    def head_findings(self, head: dict) -> list[dict]:
        workflows = {int(run): {"path": row[0], "name": row[1], "event": row[2], "attempt": row[3]}
                     for run, row in head["workflows"].items()}
        checks = [RecordedGitHub.api_check(row) for row in head["checks"]]
        pull = {"number": head["pr"], "merged_at": head["merged_at"], "title": "recorded"}
        return panel.duplicate_findings(head["sha"], pull, checks, workflows, NOW)

    def test_what_counts_as_a_real_run(self) -> None:
        self.assertEqual((len(self.heads), sum(len(h["checks"]) for h in self.heads)), (55, 762))
        real = {"resident": 0, "hosted": 0}
        skipped = gates = controls = 0
        for head in self.heads:
            workflows = {int(run): {"path": row[0], "name": row[1]} for run, row in head["workflows"].items()}
            for row in head["checks"]:
                run = panel.real_run(RecordedGitHub.api_check(row), workflows)
                if run:
                    real[run["executor"]] += 1
                elif row[2] == "skipped":
                    skipped += 1
                elif row[0] == "admission-gate":
                    gates += 1
                elif row[0].startswith("kooyumi-"):
                    controls += 1
        self.assertEqual(real, {"resident": 137, "hosted": 93})
        self.assertEqual((skipped, gates, controls), (208, 191, 133))
        self.assertEqual(sum(real.values()) + skipped + gates + controls, 762)

    def test_history_has_36_cross_executor_duplicates_and_nothing_else(self) -> None:
        found = [item for head in self.heads for item in self.head_findings(head)]
        self.assertEqual(len(found), 36)
        self.assertEqual({tuple(item["causes"]) for item in found}, {("cross-executor",)})
        self.assertEqual({item["check"] for item in found}, {"gitleaks", "trivy", "contract-placement"})
        self.assertEqual(sorted({item["pr"] for item in found}), [958, 959, 960, 961, 962, 963, 964, 965, 970, 976, 977, 978])
        for item in found:
            self.assertEqual([run["executor"] for run in item["runs"]], ["hosted", "resident"])
            self.assertLess(item["runs"][0]["at"], item["runs"][1]["at"])

    def test_resident_retries_of_admission_and_stage_8_are_not_reported(self) -> None:
        for number in (976, 990):  # attempt 2 re-published kooyumi-work-admission
            (head,) = [h for h in self.heads if h["pr"] == number]
            names = [row[0] for row in head["checks"]]
            self.assertEqual(names.count("kooyumi-work-admission"), 2)
            self.assertNotIn("kooyumi-work-admission", [item["check"] for item in self.head_findings(head)])

    def test_scan_replayed_on_the_evening_of_november_2(self) -> None:
        now = datetime(2026, 11, 2, 12, 0, tzinfo=timezone.utc)
        client = RecordedGitHub(now)
        result = panel.scan_duplicates(client, now, {})
        self.assertEqual(result["heads_read"], panel.DUP_PULLS)
        self.assertEqual((result["total"], len(result["found"])), (33, panel.DUP_KEEP))
        self.assertEqual(sorted({item["pr"] for item in result["found"]}), [959, 964, 965, 970, 976, 977, 978])
        self.assertEqual(len(client.paths), 1 + 2 * panel.DUP_PULLS)
        # three days later, a scan reads the same PRs and finds the hosted-and-resident pairs have aged out
        later = RecordedGitHub(datetime(2026, 11, 5, 9, 0, tzinfo=timezone.utc))
        self.assertEqual(panel.scan_duplicates(later, later.now, result)["found"], [])

    def test_scan_today_finds_nothing_in_22_heads_and_44_requests(self) -> None:
        now = datetime(2026, 11, 4, 9, 0, tzinfo=timezone.utc)
        client = RecordedGitHub(now)
        result = panel.scan_duplicates(client, now, {})
        self.assertEqual((result["heads_read"], result["found"], len(client.paths)), (22, [], 1 + 2 * 22))

    def test_the_replayed_panel_lists_the_duplicates_and_announces_each_once(self) -> None:
        now = datetime(2026, 11, 2, 12, 0, tzinfo=timezone.utc)

        class Client(RecordedGitHub):
            def get(self, path: str, params: dict | None = None):
                params = params or {}
                if path.startswith("/actions/workflows") or (path == "/actions/runs" and "head_sha" not in params)                         or (path == "/pulls" and params.get("state") != "all") or path.endswith("/status"):
                    return {} if path.endswith("/status") else ([] if path == "/pulls" else {"workflow_runs": []})
                if path.endswith("/statuses"):
                    return []
                return super().get(path, params)

        state: dict = {"events_at": panel.iso(now)}
        report = panel.build(Client(now), now, state)
        self.assertEqual((report["duplicates"]["total"], len(report["duplicates"]["found"])), (33, panel.DUP_ROWS))
        body = panel.render(report, state)
        self.assertIn("### 重复执行", body)
        self.assertEqual(sum(1 for line in body.splitlines() if line.startswith("| #")), panel.DUP_ROWS)
        self.assertIn("共 33 项，只列最近 10 项", body)
        self.assertLess(len(body), 40000)
        self.assertEqual(len({key for key in report["events"] if key.startswith("dup:")}), panel.DUP_KEEP)
        # a later scan that finds a burst announces the first rows and one summary line, and records the rest
        later = {"events_at": panel.iso(now), "duplicates": {"as_of": panel.iso(now - timedelta(hours=2))}}
        report = panel.build(Client(now), now, later)
        announce = [key for key in report["events"] if key.startswith("dup") and key not in later["announced"]]
        self.assertEqual(len(announce), panel.DUP_ROWS + 1)
        self.assertEqual(sum(1 for key in announce if key.startswith("dup-more:")), 1)
        self.assertIn("另有 10 项", report["events"][[key for key in announce if key.startswith("dup-more:")][0]])
        self.assertEqual(len(later["announced"]), panel.DUP_KEEP - panel.DUP_ROWS)


if __name__ == "__main__":
    unittest.main()
