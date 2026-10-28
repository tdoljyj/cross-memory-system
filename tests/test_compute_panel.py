from __future__ import annotations

import importlib.util
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


def probe(conclusion: str | None, created: float, completed: float | None = None, runner: str = NAME) -> dict:
    return {
        "id": int(created * 100), "name": panel.PROBE_PREFIX + NAME, "conclusion": conclusion,
        "created_at": at(created), "completed_at": at(completed) if completed is not None else None,
        "runner_name": runner if conclusion == "success" else "",
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

    def test_unpicked_probe_after_four_minutes_is_offline(self) -> None:
        jobs = [probe("success", 20, 19), probe("cancelled", 10), probe(None, 5)]
        self.assertEqual(panel.classify_node(NAME, jobs, {}, NOW)["status"], "offline")

    def test_fresh_unpicked_probe_is_not_yet_offline(self) -> None:
        self.assertEqual(panel.classify_node(NAME, [probe(None, 2)], {}, NOW)["status"], "unknown")

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

    def test_state_round_trip_inside_the_issue_body(self) -> None:
        state = {"alerts": {"halt:turing": "停机"}, "samples": {}}
        body = "panel\n" + panel.write_state(state) + "\n"
        self.assertEqual(panel.read_state(body), state)
        self.assertEqual(panel.read_state("no state here"), {})
        self.assertNotIn("--", panel.write_state(state)[4:-3])

    def test_render_lists_every_machine(self) -> None:
        pool = {node["name"]: {**panel.classify_node(node["name"], [], {}, NOW), "can_run": node["can_run"],
                                "health": {}, "flags": []} for node in panel.POOL}
        report = {"schema": panel.SCHEMA, "generated_at": panel.iso(NOW), "pool": pool,
                  "utilization": {}, "residents": {}, "others": panel.OTHERS, "metrics": {}, "alerts": {}}
        body = panel.render(report, {})
        self.assertTrue(body.startswith(panel.MARKER))
        for name in [node["name"] for node in panel.POOL] + [other["name"] for other in panel.OTHERS]:
            self.assertIn(name, body)
        self.assertIn("已退役", body)
        self.assertIn("控制机", body)


if __name__ == "__main__":
    unittest.main()
