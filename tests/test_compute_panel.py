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
        self.assertTrue(comment.startswith("动态："))
        self.assertIn("PR #20", comment)

    def test_only_a_new_alert_mentions_the_owner(self) -> None:
        # Issue #952: every merge's event mentioned the Owner, and the 2026-11-13 HALT alert drowned in them.
        events = {"merged:20": "PR #20 已合入 main", "dup:1": "重复执行：PR #21", "failed:22:abc:turing": "PR #22 检查失败"}
        for comment in (panel.alert_comment({}, {}, "owner", events), panel.alert_comment({}, {"disk:x": "x 磁盘不足"}, "owner")):
            self.assertNotIn("@", comment)
        both = panel.alert_comment({"halt:turing": "停机"}, {"disk:x": "x 磁盘不足"}, "owner", events)
        self.assertTrue(both.startswith("@owner 新告警："))
        self.assertEqual(both.count("@"), 1)

    def test_low_disk_and_memory_clear_only_past_a_margin(self) -> None:
        # Issue #952: home-win-01 disk alerted and recovered four times in two hours around 20 GB.
        said: list[str] = []
        previous: dict[str, str] = {}
        for disk in (19.0, 21.0, 19.0, 24.9):
            held = {flag for flag in ("disk", "memory") if f"{flag}:{NAME}" in previous}
            row = {"status": "online", "last_probe": at(1), "health": {"disk_free_gb": disk},
                   "flags": panel.health_flags({"disk_free_gb": disk}, held)}
            alerts = panel.alerts_for({NAME: row}, {})
            said += [key for key in alerts if key not in previous]
            previous = alerts
        self.assertEqual(said, [f"disk:{NAME}"])
        self.assertEqual(panel.health_flags({"disk_free_gb": 25.0}, {"disk"}), [])
        self.assertEqual(panel.health_flags({"mem_available_gb": 1.4}, {"memory"}), ["memory"])
        self.assertEqual(panel.health_flags({"mem_available_gb": 1.5}, {"memory"}), [])
        self.assertEqual(panel.health_flags({"mem_available_gb": 1.4}), [])
        self.assertEqual(panel.health_flags({}, {"disk"}), ["disk"])  # an unread value does not end the alert

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


class StallTests(unittest.TestCase):
    """CI stall (board row 26, gap 2): work waits on the resident executors and no node is on duty for it."""

    class History:
        """A client that serves one commit's status history (newest first) and counts the reads."""

        def __init__(self, rows: list[dict] | None = None) -> None:
            self.rows = rows or []
            self.paths: list[str] = []

        def get(self, path: str, params: dict | None = None):
            self.paths.append(path)
            return self.rows

    def stall(self, combined, pulls=None, client=None):
        pulls = pulls if pulls is not None else [{"number": number} for number, _ in combined]
        return panel.resident_stall(client or self.History(), pulls, combined, NOW)

    def test_halt_with_a_queued_pr_alerts_once_and_recovers_once(self) -> None:
        # 2026-11-14 03:31 (Beijing): TURING HALTed on PR #1095's head; nobody else took the work.
        halted = [(1095, {"sha": "a9e717d" + "0" * 33,
                          "statuses": [status(2, "error", "执行器停机（PUBLICATION_UNCERTAIN），等 Owner 复位")]})]
        stall = self.stall(halted)
        self.assertEqual([item["pr"] for item in stall], [1095])
        alerts = panel.alerts_for({}, {}, stall)
        self.assertIn("stall", alerts)
        self.assertIn("PR #1095", alerts["stall"])
        # The same stall seen again (more PRs, newer text) is the same alert: it is not announced again.
        again = panel.alerts_for({}, {}, stall + [{**stall[0], "pr": 1096}])
        self.assertEqual(set(again), set(alerts))
        self.assertEqual(panel.alerts_for({}, {}, []), {})

    def test_a_node_on_duty_is_no_stall(self) -> None:
        on_duty = [(1, {"sha": "1" * 40, "statuses": [status(10, "pending", "当班：排队第 2 位"),
                                                      status(1, "pending", "停摆（PAUSED）：执行器已暂停，等 Owner 恢复", node="desk")]})]
        self.assertEqual(self.stall(on_duty), [])

    def test_finished_hinted_and_draft_heads_are_no_work(self) -> None:
        combined = [(1, {"sha": "1" * 40, "statuses": [status(90, "success", "已完成：常驻执行器跑完八段，检查已发布")]}),
                    (2, {"sha": "2" * 40, "statuses": [status(90, "failure", "落后 main 1 个提交：请合入最新 main 并推送")]}),
                    (3, {"sha": "3" * 40, "statuses": [status(90, "error", "执行器停机（X），等 Owner 复位")]}),
                    (4, {"sha": "4" * 40, "statuses": [{"context": "gitleaks", "state": "pending", "created_at": at(90)}]})]
        pulls = [{"number": 1}, {"number": 2}, {"number": 3, "draft": True}, {"number": 4}]
        self.assertEqual(self.stall(combined, pulls), [])

    def test_a_silent_node_is_a_stall_after_the_duty_window(self) -> None:
        # The node stopped writing (machine off, companion gone): its last 当班 ages past the window.
        late = [(5, {"sha": "5" * 40, "statuses": [status(31, "pending", "当班：运行中：第 2 段（gitleaks 扫描）")]})]
        early = [(5, {"sha": "5" * 40, "statuses": [status(20, "pending", "当班：运行中：第 2 段（gitleaks 扫描）")]})]
        self.assertEqual([item["pr"] for item in self.stall(late)], [5])
        self.assertEqual(self.stall(early), [])

    def test_a_pause_is_a_stall_once_nobody_was_on_duty_for_the_window(self) -> None:
        # A paused node rewrites its 停摆 text every 14 minutes, so the time comes from the commit's history.
        paused = [(6, {"sha": "6" * 40, "statuses": [status(1, "pending", "停摆（PAUSED）：执行器已暂停，等 Owner 恢复")]})]
        long_ago = self.History([status(1, "pending", "停摆（PAUSED）：执行器已暂停，等 Owner 恢复"),
                                 status(45, "pending", "当班：排队第 1 位")])
        self.assertEqual([item["pr"] for item in self.stall(paused, client=long_ago)], [6])
        self.assertEqual(long_ago.paths, ["/commits/" + "6" * 40 + "/statuses"])
        just_now = self.History([status(1, "pending", "停摆（BREAKER_OPEN）：执行器熔断中"),
                                 status(8, "pending", "当班：运行中：第 1 段（准入）")])
        self.assertEqual(self.stall(paused, client=just_now), [])
        # Never on duty on this commit: it has waited since its first resident row.
        never = self.History([status(1, "pending", "已提议，等待执行器读取"), status(40, "pending", "已提议，等待执行器读取")])
        self.assertEqual([item["pr"] for item in self.stall(paused, client=never)], [6])

    def test_healthy_heads_cost_no_history_read(self) -> None:
        client = self.History()
        busy = [(7, {"sha": "7" * 40, "statuses": [status(1, "pending", "当班：运行中：第 4 段（trivy 扫描）")]})]
        self.assertEqual(self.stall(busy, client=client), [])
        self.assertEqual(client.paths, [])

    def test_halt_with_a_queued_pr_is_one_alert(self) -> None:
        # The HALT alert names the node and its reason; the PRs it holds up are added to it, not a second alert.
        residents = {"turing": {"halted": True, "description": "执行器停机（PUBLICATION_UNCERTAIN），等 Owner 复位", "pr": 1095}}
        stall = [{"pr": 1095, "node": "turing", "description": "执行器停机（PUBLICATION_UNCERTAIN），等 Owner 复位", "since": None}]
        alerts = panel.alerts_for({}, residents, stall)
        self.assertEqual(list(alerts), ["halt:turing"])
        self.assertIn("PUBLICATION_UNCERTAIN", alerts["halt:turing"])
        self.assertIn("1 个 PR 在等：#1095", alerts["halt:turing"])
        # A stall no HALT explains (a pause, a silent node) stays its own alert.
        paused = [{"pr": 7, "node": "desk", "description": "停摆（PAUSED）：执行器已暂停，等 Owner 恢复", "since": at(40)}]
        self.assertEqual(sorted(panel.alerts_for({}, residents, stall + paused)), ["halt:turing", "stall"])

    def test_a_failed_alert_comment_is_recorded_and_said_again_next_run(self) -> None:
        class Channel:
            def __init__(self, fail: bool) -> None:
                self.fail = fail
                self.sent: list[tuple[str, str]] = []

            def send(self, method: str, path: str, body):
                if self.fail and path.endswith("/comments"):
                    raise RuntimeError("POST /issues/952/comments failed (502)")
                self.sent.append((method, path))
                return {"number": 952}

        report = {"alerts": {"stall": "CI 停摆：PR #1095"}, "events": {"merged:1": "PR #1 已合入 main"}, "errors": []}
        state = {"alerts": dict(report["alerts"])}
        broken = Channel(fail=True)
        panel.announce(broken, {"number": 952}, report, state, {}, False, "owner")  # must not raise
        self.assertEqual(state["alerts"], {})  # not saved as said: the next run says it again
        self.assertFalse(panel.is_announced(state, "merged:1"))
        self.assertTrue(any("告警评论未发出" in error for error in report["errors"]))
        working = Channel(fail=False)
        report["errors"] = []
        state["alerts"] = dict(report["alerts"])
        panel.announce(working, {"number": 952}, report, state, {}, False, "owner")
        self.assertEqual(working.sent, [("POST", "/issues/952/comments")])
        self.assertEqual(state["alerts"], report["alerts"])
        self.assertTrue(panel.is_announced(state, "merged:1"))
        self.assertEqual(report["errors"], [])


class GovernanceStatusTests(unittest.TestCase):
    """The probe prints one COMPUTE_PANEL_GOVERNANCE line from the node governance status file."""

    def test_reads_the_level_and_time_from_the_last_line(self):
        log = ('2026-10-29T12:00:00Z printf \'COMPUTE_PANEL_GOVERNANCE {"level":"%s"}\\n\'\n'
               '2026-10-29T12:00:01Z COMPUTE_PANEL_GOVERNANCE {"level":"yellow","writtenAt":"2026-10-29T11:58:00Z"}\n')
        self.assertEqual(panel.parse_governance(log), {"level": "yellow", "writtenAt": "2026-10-29T11:58:00Z"})
        self.assertEqual(panel.parse_governance('COMPUTE_PANEL_GOVERNANCE {"level":"unknown","writtenAt":null}'),
                         {"level": "unknown", "writtenAt": None})

    def test_missing_or_bad_lines_are_unknown_never_green(self):
        for log in ["", "no line here", "COMPUTE_PANEL_GOVERNANCE not-json",
                    'COMPUTE_PANEL_GOVERNANCE {"level":"purple","writtenAt":null}',
                    'COMPUTE_PANEL_GOVERNANCE {"level":"green","writtenAt":"<script>"}',
                    'COMPUTE_PANEL_GOVERNANCE ["green"]']:
            self.assertEqual(panel.parse_governance(log)["level"], "unknown", log)
            self.assertIsNone(panel.parse_governance(log)["writtenAt"], log)

    def test_only_red_raises_an_alert(self):
        self.assertEqual(panel.health_flags({"governance": {"level": "red", "writtenAt": None}}), ["governance"])
        for level in ("green", "yellow", "unknown"):
            self.assertEqual(panel.health_flags({"governance": {"level": level, "writtenAt": None}}), [])
        row = {"status": "online", "health": {"governance": {"level": "red", "writtenAt": "2026-10-29T11:58:00Z"}},
               "flags": ["governance"]}
        text = panel.alerts_for({NAME: row}, {})["governance:" + NAME]
        self.assertIn("节点治理红色", text)
        self.assertIn("2026-10-29T11:58:00Z", text)

    def test_the_level_is_cached_from_the_probe_log_and_shown_in_the_panel(self):
        class Client:
            def low(self):
                return False

            def job_log(self, job_id):
                return ('COMPUTE_PANEL_PROBE {"runner":"r","os":"Linux","disk_free_gb":81.5,"mem_available_gb":4.2}\n'
                        'COMPUTE_PANEL_GOVERNANCE {"level":"red","writtenAt":"2026-10-29T11:58:00Z"}\n')
        cache = {NAME: {"fetched_at": panel.iso(NOW - timedelta(hours=2)), "maintenance": {"status": "ok"}}}
        health = panel.latest_health(Client(), [probe("success", 6, 5)], cache, NOW)
        self.assertEqual(health[NAME]["governance"], {"level": "red", "writtenAt": "2026-10-29T11:58:00Z"})
        self.assertNotIn("maintenance", health[NAME])
        self.assertNotIn("maintenance", cache[NAME])
        pool = {node["name"]: {**panel.classify_node(node["name"], [], {}, NOW), "can_run": node["can_run"],
                                "health": health.get(node["name"], {}), "flags": []} for node in panel.POOL}
        report = {"schema": panel.SCHEMA, "generated_at": panel.iso(NOW), "pool": pool, "utilization": {},
                  "residents": {}, "others": panel.OTHERS, "metrics": {}, "alerts": {}}
        body = panel.render(report, {})
        self.assertIn("治理等级", body)
        self.assertIn("| 红 |", body)
        self.assertNotIn("缓存维护", body)

    def test_an_old_cache_without_governance_reads_unknown(self):
        class Client:
            def low(self):
                return True
        old = {NAME: {"fetched_at": panel.iso(NOW), "maintenance": {"status": "ok"}}}
        health = panel.latest_health(Client(), [], old, NOW)
        self.assertEqual(health[NAME]["governance"], {"level": "unknown", "writtenAt": None})
        self.assertNotIn("maintenance", health[NAME])


_IDS = iter(range(1, 10**9))


def check(name: str, started_min_ago: float, conclusion: str | None = "success", *, external: str | None = None,
          run: int | None = None, app: str = "github-actions", status: str | None = None) -> dict:
    """A check run as GitHub returns it: a resident one has an independent-ci external_id, a hosted one a run URL."""
    return {
        "id": next(_IDS), "name": name, "app": {"id": 1, "slug": app, "name": app, "description": "d" * 100},
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
        (item,) = findings([check("gitleaks-hosted-executor", 15, None, run=11), resident("gitleaks", 2, conclusion="failure")])
        self.assertEqual(item["count"], 2)
        # a run that has only just started may be a copy about to be cancelled by its successor: not yet a run
        self.assertEqual(findings([check("gitleaks-hosted-executor", 4, None, run=11), resident("gitleaks", 2)]), [])

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
        self.assertEqual(sorted(first["settled"]), ["1:" + "a" * 12])
        again = FakeGitHub([closed, recent], checks)
        second = panel.scan_duplicates(again, NOW + timedelta(hours=1), first)
        self.assertEqual(len(again.paths), 1 + 2)  # only the recently merged head is read
        self.assertEqual(sorted(item["pr"] for item in second["found"]), [1, 2])

    def test_a_pr_updated_after_it_settled_is_read_again(self) -> None:
        closed = pull(1, "a" * 40, "closed", updated_min_ago=30 * 60)
        first = panel.scan_duplicates(FakeGitHub([closed], {}), NOW, {})
        self.assertEqual(sorted(first["settled"]), ["1:" + "a" * 12])
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
        self.assertTrue(panel.is_announced(state, key))  # main() announces only the keys not yet announced
        self.assertEqual(state["announced"], [])  # duplicates keep their own set
        self.assertEqual([k for k in report["events"] if k.startswith("dup")], [])
        # a duplicate on a new head at the next scan is not yet recorded: it will be announced
        newer = BuildClient([pull(1, "a" * 40), pull(2, "b" * 40)], {"a" * 40: self.dup, "b" * 40: self.dup})
        report = panel.build(newer, NOW + timedelta(hours=1), state)
        fresh = [k for k in report["events"] if k.startswith("dup:") and not panel.is_announced(state, k)]
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


class Flaky(BuildClient):
    """BuildClient whose check-run reads fail: the codes in `errors` once each, in order, or `always` every time
    (a code of 0 is a network error)."""

    def __init__(self, *args, errors: list[int] | None = None, always: int | None = None, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.errors, self.always, self.check_calls = list(errors or []), always, 0

    def get(self, path: str, params: dict | None = None):
        if "check-runs" in path:
            self.check_calls += 1
            code = self.always if self.always is not None else (self.errors.pop(0) if self.errors else None)
            if code == 0:
                raise OSError("connection reset")
            if code:
                raise panel.RequestError(f"GET {path} failed ({code})", code)
        return super().get(path, params)


def many_heads(count: int, state: str = "closed", updated_min_ago: float = 2 * 24 * 60) -> tuple[list[dict], dict[str, list[dict]]]:
    """`count` PRs, each head with one gitleaks check that really ran twice."""
    dup = [resident("gitleaks", 50), resident("gitleaks", 40, attempt=2)]
    shas = [f"{i:04x}" + "a" * 36 for i in range(count)]
    return [pull(i + 1, sha, state, updated_min_ago=updated_min_ago) for i, sha in enumerate(shas)], {sha: dup for sha in shas}


class DuplicateRetryTests(unittest.TestCase):
    """Review finding (a): a 5xx must not void the whole scan, and a failed scan must not start over every 5 minutes."""

    def setUp(self) -> None:
        self.sleeps: list[float] = []
        self.original = panel.SLEEP
        panel.SLEEP = self.sleeps.append
        self.dup = [resident("gitleaks", 50), resident("gitleaks", 40, attempt=2)]

    def tearDown(self) -> None:
        panel.SLEEP = self.original

    def test_a_5xx_or_network_error_is_tried_again_with_a_doubling_pause(self) -> None:
        client = Flaky([pull(1, "a" * 40)], {"a" * 40: self.dup}, errors=[502, 0])
        result = panel.scan_duplicates(client, NOW, {})
        self.assertEqual([item["pr"] for item in result["found"]], [1])
        self.assertEqual((client.check_calls, self.sleeps), (3, [panel.DUP_BACKOFF, panel.DUP_BACKOFF * 2]))

    def test_other_errors_are_not_retried_and_the_tries_are_bounded(self) -> None:
        client = Flaky([pull(1, "a" * 40)], {}, always=403)
        with self.assertRaises(RuntimeError):
            panel.scan_duplicates(client, NOW, {})
        self.assertEqual((client.check_calls, self.sleeps), (1, []))
        client = Flaky([pull(1, "a" * 40)], {}, always=502)
        with self.assertRaises(RuntimeError):
            panel.scan_duplicates(client, NOW, {})
        self.assertEqual((client.check_calls, len(self.sleeps)), (panel.DUP_ATTEMPTS, panel.DUP_ATTEMPTS - 1))

    def test_a_failed_scan_waits_15_minutes_then_reads_again(self) -> None:
        state: dict = {}
        report = panel.build(Flaky([pull(1, "a" * 40)], {"a" * 40: self.dup}, always=502), NOW, state)
        self.assertEqual(state["duplicates_failed_at"], panel.iso(NOW))
        self.assertTrue(any(e.startswith("duplicate runs:") for e in report["errors"]))
        soon = Flaky([pull(1, "a" * 40)], {"a" * 40: self.dup})
        report = panel.build(soon, NOW + timedelta(minutes=5), state)
        self.assertEqual(soon.check_calls, 0)  # still waiting
        self.assertTrue(any("不再重试" in e for e in report["errors"]))
        self.assertNotIn("duplicates", state)
        later = Flaky([pull(1, "a" * 40)], {"a" * 40: self.dup})
        report = panel.build(later, NOW + timedelta(minutes=16), state)
        self.assertEqual(later.check_calls, 1)
        self.assertNotIn("duplicates_failed_at", state)
        self.assertEqual(report["duplicates"]["total"], 1)
        self.assertEqual(report["errors"], [])

    def test_a_scan_that_retried_into_success_leaves_no_failure_mark(self) -> None:
        state: dict = {}
        panel.build(Flaky([pull(1, "a" * 40)], {"a" * 40: self.dup}, errors=[502]), NOW, state)
        self.assertNotIn("duplicates_failed_at", state)
        self.assertEqual(state["duplicates"]["total"], 1)


class DuplicateKeepTests(unittest.TestCase):
    """Review finding (b): the total and the carry-over must not fall to the number of findings kept in full."""

    def test_the_total_survives_saving_and_settled_heads(self) -> None:
        pulls, checks = many_heads(36)
        state: dict = {}
        report = panel.build(BuildClient(pulls, checks), NOW, state)
        saved = state["duplicates"]
        self.assertEqual((saved["total"], len(saved["found"]), len(saved["rest"])), (36, panel.DUP_KEEP, 36 - panel.DUP_KEEP))
        self.assertNotIn("runs", saved["rest"][0])  # a short record
        self.assertEqual((report["duplicates"]["total"], len(report["duplicates"]["found"])), (36, panel.DUP_ROWS))
        # an hour later the closed heads are not read again, and still all 36 are counted
        again = BuildClient(pulls, checks)
        report = panel.build(again, NOW + timedelta(hours=1), state)
        self.assertNotIn("/commits/" + "0000" + "a" * 36 + "/check-runs", again.paths)
        self.assertEqual(state["duplicates"]["total"], 36)
        self.assertEqual((len(state["duplicates"]["found"]), len(state["duplicates"]["rest"])), (panel.DUP_KEEP, 36 - panel.DUP_KEEP))
        self.assertIn("共 36 项，只列最近 10 项", panel.render(report, state))
        # and a third pass still has them (the short records are carried, not dropped)
        panel.build(BuildClient(pulls, checks), NOW + timedelta(hours=2), state)
        self.assertEqual(state["duplicates"]["total"], 36)

    def test_beyond_the_saving_limit_the_dropped_heads_are_read_again_so_the_total_stays_exact(self) -> None:
        count = panel.DUP_KEEP + panel.DUP_MAX + 10
        pulls, checks = many_heads(count)
        state: dict = {}
        panel.build(BuildClient(pulls, checks), NOW, state)
        saved = state["duplicates"]
        self.assertEqual((saved["total"], len(saved["rest"]), len(saved["settled"])), (count, panel.DUP_MAX, count - 10))
        again = BuildClient(pulls, checks)
        panel.build(again, NOW + timedelta(hours=1), state)
        self.assertEqual(state["duplicates"]["total"], count)
        self.assertEqual(sum(1 for path in again.paths if path.endswith("/check-runs")), 10)  # only the dropped heads

    def test_short_records_age_out_with_the_window(self) -> None:
        pulls, checks = many_heads(30)
        state: dict = {}
        panel.build(BuildClient(pulls, checks), NOW, state)
        self.assertEqual(state["duplicates"]["total"], 30)
        panel.build(BuildClient(pulls, checks), NOW + timedelta(days=4), state)
        self.assertEqual(state["duplicates"]["total"], 0)


class DuplicateAnnouncedTests(unittest.TestCase):
    """Review finding (c): other events must not push announced duplicate keys out of the saved set."""

    def test_other_events_do_not_evict_duplicate_keys(self) -> None:
        state: dict = {}
        panel.mark_announced(state, ["dup:aaaa:gitleaks:2"])
        panel.mark_announced(state, [f"failed:{i}" for i in range(500)])
        self.assertTrue(panel.is_announced(state, "dup:aaaa:gitleaks:2"))
        self.assertEqual(len(state["announced"]), 200)
        self.assertFalse(panel.is_announced(state, "failed:0"))
        self.assertNotIn("dup:aaaa:gitleaks:2", state["announced"])

    def test_the_duplicate_set_is_bounded_but_never_drops_a_live_finding(self) -> None:
        pulls, checks = many_heads(3)
        state: dict = {}
        panel.build(BuildClient(pulls, checks), NOW, state)
        live = [panel.duplicate_key(item) for item in state["duplicates"]["found"]]
        panel.mark_announced(state, [f"dup:old{i}:x:2" for i in range(2 * panel.DUP_ANNOUNCED)])
        self.assertEqual(len(state["announced_dup"]), panel.DUP_ANNOUNCED)
        self.assertTrue(all(panel.is_announced(state, key) for key in live))
        self.assertTrue(panel.is_announced(state, f"dup:old{2 * panel.DUP_ANNOUNCED - 1}:x:2"))  # the newest others stay
        self.assertFalse(panel.is_announced(state, "dup:old0:x:2"))  # the oldest others go

    def test_a_finding_is_not_announced_again_after_many_other_events(self) -> None:
        pulls, checks = many_heads(2, state="open", updated_min_ago=10)
        state: dict = {}
        panel.build(BuildClient(pulls, checks), NOW, state)  # the first scan records both
        panel.mark_announced(state, [f"failed:{i}" for i in range(1000)])
        report = panel.build(BuildClient(pulls, checks), NOW + timedelta(hours=1), state)
        self.assertEqual([key for key in report["events"] if key.startswith("dup")], [])

    def test_the_issue_body_stays_well_under_the_limit_in_the_worst_case(self) -> None:
        pulls, checks = many_heads(panel.DUP_KEEP + panel.DUP_MAX + 30)
        state: dict = {}
        panel.build(BuildClient(pulls, checks), NOW, state)
        panel.mark_announced(state, [f"dup:old{i}:x:2" for i in range(2 * panel.DUP_ANNOUNCED)])
        panel.mark_announced(state, [f"failed:{i}" for i in range(400)])
        report = panel.build(BuildClient(pulls, checks), NOW + timedelta(hours=1), state)
        body = panel.render(report, state)
        self.assertLess(len(body), 50000)  # the limit is 65536 characters


class FailRules(BuildClient):
    """BuildClient that raises the listed exceptions, once each in order, for paths containing a substring."""

    def __init__(self, *args, rules: list[tuple[str, list[BaseException]]], **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.rules = rules

    def get(self, path: str, params: dict | None = None):
        for part, errors in self.rules:
            if part in path and errors:
                raise errors.pop(0)
        return super().get(path, params)


class DuplicateReviewTests(unittest.TestCase):
    """The second review round: shared heads, bounded names, real API shapes, error kinds, the whole of main()."""

    def setUp(self) -> None:
        self.sleeps: list[float] = []
        self.original = panel.SLEEP
        panel.SLEEP = self.sleeps.append
        self.dup = [resident("gitleaks", 50), resident("gitleaks", 40, attempt=2)]

    def tearDown(self) -> None:
        panel.SLEEP = self.original

    def test_two_prs_sharing_a_head_are_one_finding_however_often_it_is_scanned(self) -> None:
        old = 2 * 24 * 60
        for pulls in ([pull(1, SHA, "closed", old), pull(2, SHA, "closed", old + 7)],
                      [pull(1, SHA, "closed", old), pull(3, SHA, "open", 10)]):
            state: dict = {}
            totals = []
            for hour in range(5):
                panel.build(BuildClient(pulls, {SHA: self.dup}), NOW + timedelta(hours=hour), state)
                totals.append(state["duplicates"]["total"])
            self.assertEqual(totals, [1] * 5)
            self.assertEqual(len(state["duplicates"]["found"]), 1)

    def test_long_check_names_are_bounded_but_stay_distinct(self) -> None:
        first, second = "x" * 255 + "1", "x" * 255 + "2"
        items = findings([resident(first, 50), resident(first, 40, attempt=2), resident(second, 50), resident(second, 40, attempt=2)])
        self.assertEqual(len(items), 2)
        self.assertTrue(all(len(item["check"]) <= panel.DUP_NAME and len(item["label"]) <= panel.DUP_NAME for item in items))
        self.assertEqual(len({item["check"] for item in items}), 2)
        self.assertEqual(panel.short_name("gitleaks"), "gitleaks")

    def test_a_third_party_check_names_its_app_by_slug_not_by_the_whole_object(self) -> None:
        (item,) = findings([check("lint", 50, app="octoapp"), check("lint", 40, app="octoapp")])
        self.assertEqual([run["executor"] for run in item["runs"]], ["octoapp", "octoapp"])
        text = panel.duplicate_event(item)[1]
        self.assertNotIn("description", text)
        self.assertNotIn("{", text)

    def test_the_split_of_a_finding_counts_every_run_not_only_the_first_four(self) -> None:
        checks = [check("gitleaks-hosted-executor", 90 - i, run=11) for i in range(4)] + [resident("gitleaks", 30), resident("gitleaks", 20, attempt=2)]
        (item,) = findings(checks)
        self.assertEqual((item["count"], item["mix"], len(item["runs"])), (6, {"hosted": 4, "resident": 2}, panel.DUP_RUNS_SHOWN))
        text = panel.duplicate_event(item)[1]
        self.assertIn("托管 4 次", text)
        self.assertIn("常驻 2 次", text)

    def test_a_native_publication_of_one_job_is_one_run(self) -> None:
        def native(job: str, ago: float, ticket: str) -> dict:
            return check("gitleaks", ago, external=f"independent-ci:native:v1:{job}:p{ticket}", app="clued-ci-checks-turing-20261018")

        self.assertEqual(findings([native("job-1", 50, "t1"), native("job-1", 40, "t2")]), [])  # published twice
        (item,) = findings([native("job-1", 50, "t1"), native("job-2", 40, "t2")])  # two jobs
        self.assertEqual(item["count"], 2)

    def test_a_resident_check_republished_under_its_external_id_is_one_run(self) -> None:
        # PR #1094: contract-placement withdrawn after a read timeout (failure) and published again (success), one external_id.
        first, again = resident("contract-placement", 50, conclusion="failure"), resident("contract-placement", 48)
        self.assertEqual(first["external_id"], again["external_id"])
        self.assertEqual(findings([first, again]), [])
        # the front batch (another job, so another external_id) that really ran the scan again still counts
        front = check("contract-placement", 20, external=f"independent-ci:staged:v2:{'1' * 64}:a1", app="clued-ci-checks-turing-20261018")
        (item,) = findings([first, again, front])
        self.assertEqual((item["count"], item["causes"]), (2, ["same-executor"]))

    def test_a_closed_unmerged_pr_is_read_until_it_has_been_closed_for_a_day(self) -> None:
        recent = {**pull(1, SHA, "closed", 3 * 60), "closed_at": at(3 * 60)}
        old = {**pull(2, "b" * 40, "closed", 30 * 60), "closed_at": at(30 * 60)}
        result = panel.scan_duplicates(FakeGitHub([recent, old], {}), NOW, {})
        self.assertEqual(sorted(result["settled"]), ["2:" + "b" * 12])
        # a check published after the PR was closed still reaches the next scan
        again = FakeGitHub([recent], {SHA: self.dup})
        self.assertEqual(len(panel.scan_duplicates(again, NOW + timedelta(hours=1), result)["found"]), 1)

    def test_a_check_run_repeated_between_pages_is_counted_once(self) -> None:
        rows = [resident(f"c{i}", 100 - i * 0.1) for i in range(99)] + [resident("gitleaks", 5)]

        class Overlap(FakeGitHub):
            def get(self, path: str, params: dict | None = None):
                reply = super().get(path, params)
                if "check-runs" in path and (params or {}).get("page") == 2:
                    reply = {**reply, "check_runs": [rows[-1]] + reply["check_runs"] + [resident("trivy", 6)]}
                return reply

        client = Overlap([pull(1, SHA)], {SHA: rows})
        self.assertEqual(panel.scan_duplicates(client, NOW, {})["found"], [])

    def test_a_head_github_cannot_return_is_skipped_other_errors_stop_the_scan(self) -> None:
        gone = FailRules([pull(1, SHA), pull(2, "b" * 40)], {SHA: self.dup, "b" * 40: self.dup},
                         rules=[("b" * 40, [panel.RequestError("GET failed (404)", 404)] * 5)])
        result = panel.scan_duplicates(gone, NOW, {})
        self.assertEqual((result["skipped"], result["heads_read"], [item["pr"] for item in result["found"]]), (1, 1, [1]))
        state: dict = {}
        report = panel.build(FailRules([pull(1, SHA), pull(2, "b" * 40)], {SHA: self.dup, "b" * 40: self.dup},
                                       rules=[("b" * 40, [panel.RequestError("GET failed (422)", 422)] * 5)]), NOW, state)
        self.assertEqual(report["duplicates"]["skipped"], 1)
        self.assertIn("不返回", panel.render(report, state))
        forbidden = FailRules([pull(1, SHA)], {SHA: self.dup}, rules=[("check-runs", [panel.RequestError("GET failed (403)", 403)])])
        with self.assertRaises(RuntimeError):
            panel.scan_duplicates(forbidden, NOW, {})

    def test_running_out_of_budget_midway_is_not_a_failed_scan(self) -> None:
        class Drain(BuildClient):
            def low(self) -> bool:
                return len(self.paths) > 4

        state: dict = {}
        report = panel.build(Drain([pull(i, f"{i:04x}" + "a" * 36) for i in range(1, 4)], {}), NOW, state)
        self.assertNotIn("duplicates_failed_at", state)
        self.assertTrue(any("额度不足" in error for error in report["errors"]))

    def test_every_request_of_the_scan_is_retried_and_unreadable_replies_count_as_transient(self) -> None:
        import http.client
        client = FailRules([pull(1, SHA)], {SHA: self.dup}, rules=[
            ("/pulls", [panel.RequestError("GET failed (502)", 502), OSError("reset")]),
            ("/actions/runs", [http.client.IncompleteRead(b"x")]),
            ("check-runs", [ValueError("truncated json")])])
        self.assertEqual(len(panel.scan_duplicates(client, NOW, {})["found"]), 1)
        self.assertEqual(len(self.sleeps), 4)
        stuck = FailRules([pull(1, SHA)], {}, rules=[("check-runs", [ValueError("truncated json")] * 5)])
        with self.assertRaises(RuntimeError) as caught:
            panel.scan_duplicates(stuck, NOW, {})
        self.assertIs(type(caught.exception), RuntimeError)  # a RuntimeError, so build() reports it and goes on

    def test_short_records_among_the_rows_shown_do_not_break_the_panel(self) -> None:
        state: dict = {}
        report = panel.build(BuildClient([pull(13, SHA)], {SHA: self.dup}), NOW, state)
        short = {"head": "a" * 12, "pr": 13, "check": "gitleaks", "count": 2, "last": at(40)}
        report["duplicates"]["found"] = [short]
        report["duplicates"]["total"] = 1
        body = panel.render(report, state)
        self.assertIn("| #13 | " + "a" * 8 + " | gitleaks | 2 | — | — |", body)
        self.assertIn("PR #13", panel.duplicate_event(short)[1])

    def test_a_head_with_findings_on_both_sides_of_the_saving_limit_is_read_again(self) -> None:
        keep = panel.DUP_KEEP + panel.DUP_MAX
        first = [resident(name, 50) for name in ("gitleaks", "trivy", "contract-placement")]
        first += [resident(name, 40, attempt=2) for name in ("gitleaks", "trivy", "contract-placement")]
        pair = [resident("gitleaks", 50), resident("gitleaks", 40, attempt=2), resident("trivy", 50), resident("trivy", 40, attempt=2)]
        shas = [f"{i:04x}" + "a" * 36 for i in range(1 + (keep - 3) // 2 + 1)]
        checks = {shas[0]: first, **{sha: pair for sha in shas[1:]}}
        pulls = [pull(i + 1, sha, "closed", 2 * 24 * 60) for i, sha in enumerate(shas)]
        state: dict = {}
        panel.build(BuildClient(pulls, checks), NOW, state)
        saved = state["duplicates"]
        total = 3 + 2 * (len(shas) - 1)
        self.assertEqual((saved["total"], len(saved["found"]) + len(saved["rest"])), (total, keep))
        self.assertEqual(len(saved["settled"]), len(shas) - 1)  # the head cut in two is not settled
        again = BuildClient(pulls, checks)
        panel.build(again, NOW + timedelta(hours=1), state)
        self.assertEqual(state["duplicates"]["total"], total)
        self.assertEqual(sum(1 for path in again.paths if path.endswith("/check-runs")), 1)

    def test_live_keys_among_the_short_records_survive_a_flood_of_other_keys(self) -> None:
        pulls, checks = many_heads(40)
        state: dict = {}
        panel.build(BuildClient(pulls, checks), NOW, state)
        rest = state["duplicates"]["rest"]
        self.assertGreater(len(rest), 20)
        panel.mark_announced(state, [f"dup:old{i}:x:2" for i in range(3 * panel.DUP_ANNOUNCED)])
        self.assertTrue(all(panel.is_announced(state, panel.duplicate_key(item)) for item in rest))

    def test_shrinking_the_saved_duplicates_unsettles_what_it_drops_and_the_next_scan_restores_it(self) -> None:
        pulls, checks = many_heads(40)
        state: dict = {}
        panel.build(BuildClient(pulls, checks), NOW, state)
        before = len(state["duplicates"]["settled"])
        panel.shrink_duplicates(state, 1)
        saved = state["duplicates"]
        self.assertEqual((saved["total"], saved["rest"], len(saved["found"])), (40, [], panel.DUP_KEEP))
        self.assertEqual(len(saved["settled"]), before - (40 - panel.DUP_KEEP))
        panel.shrink_duplicates(state, 3)
        self.assertEqual(len(state["duplicates"]["found"]), panel.DUP_ROWS)
        self.assertTrue(all("runs" not in item for item in state["duplicates"]["found"]))
        again = BuildClient(pulls, checks)
        panel.build(again, NOW + timedelta(hours=1), state)
        self.assertEqual(state["duplicates"]["total"], 40)

    def test_a_running_check_only_just_started_is_not_announced(self) -> None:
        self.assertIsNone(panel.real_run(check("gitleaks-hosted-executor", 3, None, run=11), WORKFLOWS, NOW))
        self.assertIsNotNone(panel.real_run(check("gitleaks-hosted-executor", 30, None, run=11), WORKFLOWS, NOW))


    def test_when_no_head_can_be_read_the_scan_fails_and_the_first_scan_stays_quiet(self) -> None:
        state: dict = {"events_at": panel.iso(NOW)}
        everything = [panel.RequestError("GET failed (404)", 404)] * 20
        report = panel.build(FailRules([pull(1, SHA), pull(2, "b" * 40)], {SHA: self.dup, "b" * 40: self.dup},
                                       rules=[("check-runs", everything)]), NOW, state)
        self.assertNotIn("duplicates", state)  # not recorded as a scan: the first one is still to come
        self.assertEqual(state["duplicates_failed_at"], panel.iso(NOW))
        self.assertTrue(any("都读不到" in error for error in report["errors"]))

    def test_heads_unreadable_in_the_first_scan_are_recorded_quietly_when_they_become_readable(self) -> None:
        state: dict = {"events_at": panel.iso(NOW)}
        pulls = [pull(1, SHA), pull(2, "b" * 40), pull(3, "c" * 40)]
        checks = {SHA: self.dup, "b" * 40: self.dup, "c" * 40: self.dup}
        panel.build(FailRules(pulls, checks, rules=[("b" * 40, [panel.RequestError("gone", 404)] * 5)]), NOW, state)
        self.assertEqual((state["duplicates"]["skipped"], state["duplicates"]["quiet"]), (1, ["b" * 12]))
        # the head is readable an hour later: its old duplicate is recorded, not announced; a new one is
        newer = pulls + [pull(4, "d" * 40)]
        report = panel.build(BuildClient(newer, {**checks, "d" * 40: self.dup}), NOW + timedelta(hours=1), state)
        fresh = [key for key in report["events"] if key.startswith("dup:")]
        self.assertEqual(len(fresh), 1)
        self.assertIn("d" * 12, fresh[0])
        self.assertEqual(state["duplicates"]["quiet"], [])

    def test_a_settled_pr_carried_over_keeps_the_scan_valid_when_the_other_head_is_unreadable(self) -> None:
        closed = pull(1, SHA, "closed", 2 * 24 * 60)
        state: dict = {}
        panel.build(BuildClient([closed], {SHA: self.dup}), NOW, state)
        gone = FailRules([closed, pull(2, "b" * 40)], {SHA: self.dup}, rules=[("b" * 40, [panel.RequestError("x", 422)] * 5)])
        panel.build(gone, NOW + timedelta(hours=1), state)
        self.assertNotIn("duplicates_failed_at", state)
        self.assertEqual((state["duplicates"]["as_of"], state["duplicates"]["skipped"], state["duplicates"]["total"]),
                         (panel.iso(NOW + timedelta(hours=1)), 1, 1))

    def test_shrinking_keeps_the_split_by_executor_in_the_table(self) -> None:
        state: dict = {}
        report = panel.build(BuildClient([pull(1, SHA)], {SHA: self.dup}), NOW, state)
        self.assertIn("| 常驻#1、常驻#2 |", panel.render(report, state))
        panel.shrink_duplicates(state, 2, report)
        report["duplicates"]["found"] = state["duplicates"]["found"]  # what the next run reads back from the saved state
        body = panel.render(report, state)
        self.assertIn("| 常驻 2 |", body)

    def test_many_unreadable_heads_are_all_remembered_and_never_announced_late(self) -> None:
        count = panel.DUP_PULLS
        shas = [f"{i:04x}" + "a" * 36 for i in range(count)]
        pulls = [pull(i + 1, sha) for i, sha in enumerate(shas)]
        checks = {sha: self.dup for sha in shas}
        gone = [(sha, [panel.RequestError("gone", 404)] * 5) for sha in shas[1:]]
        state: dict = {"events_at": panel.iso(NOW)}
        panel.build(FailRules(pulls, checks, rules=gone), NOW, state)
        self.assertEqual((state["duplicates"]["skipped"], len(state["duplicates"]["quiet"])), (count - 1, count - 1))
        report = panel.build(BuildClient(pulls, checks), NOW + timedelta(hours=1), state)
        self.assertEqual([key for key in report["events"] if key.startswith("dup")], [])
        self.assertEqual(state["duplicates"]["total"], count)
        self.assertEqual(state["duplicates"]["quiet"], [])

    def test_check_run_ids_are_unique_so_page_deduplication_never_drops_a_real_run(self) -> None:
        ids = [check("gitleaks", 5)["id"] for _ in range(50)]
        self.assertEqual(len(set(ids)), 50)


class MainClient(BuildClient):
    """The whole API main() talks to: an issue that is created, edited and commented on."""

    def __init__(self, pulls: list[dict], checks: dict, store: dict) -> None:
        super().__init__(pulls, checks)
        self.store, self.requests = store, 0

    def get(self, path: str, params: dict | None = None):
        if path == "/issues":
            return [self.store["issue"]] if self.store.get("issue") else []
        return super().get(path, params)

    def send(self, method: str, path: str, body: dict):
        if method == "POST" and path == "/issues":
            self.store["issue"] = {"number": 952, "body": body["body"]}
            return self.store["issue"]
        if method == "POST" and path.endswith("/comments"):
            self.store["comments"].append(body["body"])
            return {}
        self.store["issue"]["body"] = body["body"]
        return self.store["issue"]


class DuplicateMainTests(unittest.TestCase):
    """Duplicates through main(): the comment, the saved state in the issue body, and the size guard."""

    def run_main(self, store: dict, pulls: list[dict], checks: dict, when: datetime) -> None:
        import contextlib
        import io
        import os
        import sys
        from unittest import mock

        class Clock(datetime):
            @classmethod
            def now(cls, tz=None):
                return when

        client = MainClient(pulls, checks, store)
        env = {"GITHUB_TOKEN": "t", "GITHUB_REPOSITORY": "o/r", "GITHUB_REPOSITORY_OWNER": "owner"}
        with mock.patch.dict(os.environ, env), mock.patch.object(sys, "argv", ["panel"]), \
                mock.patch.object(panel, "GitHub", lambda *args, **kwargs: client), \
                mock.patch.object(panel, "datetime", Clock), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(panel.main(), 0)

    def test_a_new_duplicate_is_commented_once_and_never_again(self) -> None:
        dup = [resident("gitleaks", 50), resident("gitleaks", 40, attempt=2)]
        store: dict = {"comments": []}
        self.run_main(store, [pull(1, "a" * 40)], {"a" * 40: dup}, NOW)
        self.assertEqual(store["comments"], [])  # the first run records and says nothing
        both = [pull(1, "a" * 40), pull(2, "b" * 40)]
        checks = {"a" * 40: dup, "b" * 40: dup}
        self.run_main(store, both, checks, NOW + timedelta(hours=1))
        self.assertEqual(len(store["comments"]), 1)
        self.assertIn("重复执行：PR #2", store["comments"][0])
        self.assertNotIn("@owner", store["comments"][0])  # an event, not an alert: no mention
        for hour in (2, 3, 4):
            self.run_main(store, both, checks, NOW + timedelta(hours=hour))
        self.assertEqual(len(store["comments"]), 1)
        self.assertIn("重复执行", store["issue"]["body"])

    def test_the_issue_body_is_shrunk_when_it_would_pass_the_limit(self) -> None:
        from unittest import mock
        pulls, checks = many_heads(panel.DUP_KEEP + panel.DUP_MAX + 20)
        store: dict = {"comments": []}
        self.run_main(store, pulls, checks, NOW)
        full = len(store["issue"]["body"])
        with mock.patch.object(panel, "DUP_BODY_LIMIT", full - 1500):
            self.run_main(store, pulls, checks, NOW + timedelta(hours=1))
        self.assertLessEqual(len(store["issue"]["body"]), full - 1500)
        state = panel.read_state(store["issue"]["body"])
        self.assertEqual(state["duplicates"]["total"], len(pulls))  # the total is still exact
        self.run_main(store, pulls, checks, NOW + timedelta(hours=2))
        self.assertEqual(panel.read_state(store["issue"]["body"])["duplicates"]["total"], len(pulls))
        self.assertLess(len(store["issue"]["body"]), 65536)

    def test_the_worst_case_with_long_names_fits_the_issue_only_because_of_the_guard(self) -> None:
        from unittest import mock
        name = "w" * 250
        dup = [resident(name, 50), resident(name, 40, attempt=2)]
        count = panel.DUP_KEEP + panel.DUP_MAX + 30
        shas = [f"{i:04x}" + "a" * 36 for i in range(count)]
        pulls = [{**pull(i + 1, sha, "closed", 2 * 24 * 60), "title": "T" * 300} for i, sha in enumerate(shas)]
        checks = {sha: dup for sha in shas}
        original = panel.read_state

        def crowded(body):
            state = original(body)
            panel.mark_announced(state, [f"dup:old{i}:x:2" for i in range(2 * panel.DUP_ANNOUNCED)])
            panel.mark_announced(state, [f"failed:{i:04d}:{'f' * 40}:company-linux-01" for i in range(400)])
            return state

        sizes = {}
        for label, limit in (("unguarded", 10 ** 9), ("guarded", panel.DUP_BODY_LIMIT)):
            store: dict = {"comments": []}
            with mock.patch.object(panel, "read_state", crowded), mock.patch.object(panel, "DUP_BODY_LIMIT", limit):
                self.run_main(store, pulls, checks, NOW)
                self.run_main(store, pulls, checks, NOW + timedelta(hours=1))
            sizes[label] = len(store["issue"]["body"])
        self.assertGreater(sizes["unguarded"], panel.ISSUE_LIMIT)  # the guard is what keeps the update writable
        self.assertLessEqual(sizes["guarded"], panel.DUP_BODY_LIMIT)
        self.assertEqual(panel.read_state(store["issue"]["body"])["duplicates"]["total"], count)

    def test_the_body_always_ends_up_under_the_limit_down_to_a_summary(self) -> None:
        from unittest import mock
        name = "w" * 250
        dup = [resident(name, 50), resident(name, 40, attempt=2)]
        count = panel.DUP_KEEP + panel.DUP_MAX + 30
        shas = [f"{i:04x}" + "a" * 36 for i in range(count)]
        pulls = [{**pull(i + 1, sha, "closed", 2 * 24 * 60), "title": "T" * 300} for i, sha in enumerate(shas)]
        checks = {sha: dup for sha in shas}
        sizes = {}
        for limit in (10 ** 9, panel.DUP_BODY_LIMIT, 40000, 1):  # unguarded, normal, forcing level 4, forcing level 5
            store: dict = {"comments": []}
            with mock.patch.object(panel, "DUP_BODY_LIMIT", limit):
                self.run_main(store, pulls, checks, NOW)
                self.run_main(store, pulls, checks, NOW + timedelta(hours=1))
            sizes[limit] = len(store["issue"]["body"])
            state = panel.read_state(store["issue"]["body"])
            self.assertEqual(state["duplicates"]["total"], count)  # the total survives every level
            if limit == 1:
                self.assertTrue(state["duplicates"]["omitted"])
                self.assertIn("明细已省略", store["issue"]["body"])
                self.assertLessEqual(len(store["issue"]["body"]), panel.ISSUE_LIMIT - 500)
                self.assertEqual(store["comments"], [])
        self.assertLessEqual(sizes[40000], 40000)
        self.assertLess(sizes[1], sizes[40000])
        # the next run after a summary-only body (the limit is normal again) scans again and restores the detail, announcing nothing twice
        self.run_main(store, pulls, checks, NOW + timedelta(hours=3))
        state = panel.read_state(store["issue"]["body"])
        self.assertEqual((state["duplicates"]["total"], state["duplicates"].get("omitted")), (count, None))
        self.assertEqual(len(state["duplicates"]["found"]), panel.DUP_KEEP)  # the detail is back (the limit is normal again)
        self.assertEqual(store["comments"], [])

    def test_a_summary_only_body_still_comments_keeps_between_scans_and_recovers_on_the_next(self) -> None:
        from unittest import mock
        dup = [resident("gitleaks", 50), resident("gitleaks", 40, attempt=2)]
        pulls, checks = many_heads(40)
        store: dict = {"comments": []}
        with mock.patch.object(panel, "DUP_BODY_LIMIT", 1):
            self.run_main(store, pulls, checks, NOW)  # the first scan: recorded quietly
            self.assertEqual(store["comments"], [])
            newer, more = pulls + [pull(99, "f" * 40)], {**checks, "f" * 40: dup}
            self.run_main(store, newer, more, NOW + timedelta(hours=1))  # a scan with a new duplicate
            self.assertEqual(len(store["comments"]), 1)
            self.assertIn("重复执行：PR #99", store["comments"][0])
            first = panel.read_state(store["issue"]["body"])
            self.assertTrue(first["duplicates"]["omitted"])
            self.run_main(store, newer, more, NOW + timedelta(hours=1, minutes=5))  # between scans
            between = panel.read_state(store["issue"]["body"])
            self.assertEqual((between["duplicates"]["omitted"], between["duplicates"]["total"], between["duplicates"]["as_of"]),
                             (True, 41, first["duplicates"]["as_of"]))
            self.assertIn("明细已省略", store["issue"]["body"])
            self.assertEqual(len(store["comments"]), 1)
            self.assertEqual(between["announced_dup"], first["announced_dup"])
        self.run_main(store, newer, more, NOW + timedelta(hours=2))  # the next scan, limit normal again
        recovered = panel.read_state(store["issue"]["body"])
        self.assertNotIn("omitted", recovered["duplicates"])
        self.assertEqual((recovered["duplicates"]["total"], len(recovered["duplicates"]["found"])), (41, panel.DUP_KEEP))
        self.assertNotIn("明细已省略", store["issue"]["body"])
        self.assertEqual(len(store["comments"]), 1)


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
        self.assertEqual((result["total"], len(result["found"])), (33, 33))  # every finding; pack_duplicates() trims the saved form
        self.assertEqual(sorted({item["pr"] for item in result["found"]}), [958, 959, 960, 961, 963, 964, 965, 970, 976, 977, 978])
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
        self.assertEqual([key for key in report["events"] if key.startswith("dup")], [])  # the first scan announces nothing
        self.assertEqual(len(state["announced_dup"]), 33)
        # a later scan that finds a burst announces the first rows and one summary line, and records the rest
        later = {"events_at": panel.iso(now), "duplicates": {"as_of": panel.iso(now - timedelta(hours=2))}}
        report = panel.build(Client(now), now, later)
        announce = [key for key in report["events"] if key.startswith("dup") and not panel.is_announced(later, key)]
        self.assertEqual(len(announce), panel.DUP_ROWS + 1)
        self.assertEqual(sum(1 for key in announce if key.startswith("dup-more:")), 1)
        self.assertIn("另有 23 项", report["events"][[key for key in announce if key.startswith("dup-more:")][0]])
        self.assertEqual(len(later["announced_dup"]), 33 - panel.DUP_ROWS)


# Rule 41ab823a by tree (FABLE-main-push-tree-reuse §4, §5 T4/T5): real GitHub replies of #1178, #1156 and #1170.
# GitHub REST replies recorded read-only on 2026-11-19 (Beijing), trimmed to the fields the scan reads.
# check: (id, name, app slug, status, conclusion, started_at, completed_at, run id, external_id)
# run: (id, path, event, run_attempt, head_commit.tree_id, head_sha); job: (id, name, run_attempt, status, conclusion, started_at, completed_at)
TREE_RECORDED = {
    1156: {
        "pull": {"number": 1156, "title": "test(owner-grants): assert grant duration from server timestamps, not the wall clock", "state": "open", "head": {"sha": "43361ab833d68b2d6b9e53f7bc6e27ccbd6776e5"}, "merge_commit_sha": None, "merged_at": None, "closed_at": None, "updated_at": "2026-11-17T17:25:31Z"},
        "checks": [
            (134244333953, "clued-cloud-tests", "github-actions", "completed", "success", "2026-11-17T17:27:39Z", "2026-11-17T17:37:21Z", 44136843405, "7ca72b2f-22af-5985-90e5-009600d3a533"),
            (134244255605, "ci-suites", "github-actions", "completed", "success", "2026-11-17T17:27:39Z", "2026-11-17T17:32:20Z", 44136843405, "672ba5f8-5d12-5704-a447-4e8f1bdde9c2"),
            (134244253929, "admission-gate", "github-actions", "completed", "success", "2026-11-17T17:25:39Z", "2026-11-17T17:27:36Z", 44136843405, "4b9d1ded-144f-55f2-be56-aa1a1f82a449"),
            (134244251063, "migration-verify", "github-actions", "completed", "failure", "2026-11-17T17:49:46Z", "2026-11-17T17:49:59Z", 44136843405, "cb8ddb09-fa77-517a-88f9-511726301d58"),
            (134238390986, "contract-placement", "clued-ci-checks-turing-20261018", "completed", "success", "2026-11-17T17:40:36Z", "2026-11-17T17:40:36Z", 0, "independent-ci:staged:v2:b6d3f34bd31f84e4833a17e3da75db1a5381fafb478821694b3bdd0f4dcd7271:a1"),
            (134237153383, "trivy", "clued-ci-checks-turing-20261018", "completed", "success", "2026-11-17T17:38:40Z", "2026-11-17T17:38:40Z", 0, "independent-ci:staged:v2:628999bb39141e269fdb3bd14fb4a346d1795062c26f4b0023f31fd8b441cc79:a1"),
            (134235150300, "gitleaks", "clued-ci-checks-turing-20261018", "completed", "success", "2026-11-17T17:35:34Z", "2026-11-17T17:35:34Z", 0, "independent-ci:staged:v2:8d890ea49378a00962d1de8adcebde4400b5c171eb8f011f59857cd25aa7e62b:a1"),
            (134231302422, "kooyumi-work-admission", "clued-ci-checks-turing-20261018", "completed", "success", "2026-11-17T17:29:46Z", "2026-11-17T17:29:46Z", 0, "independent-ci:native-work-admission:v2:17249ee85b8a512ffcb1d7f6813f3c16492fac5760a800138921b2fddc78e690:a1:c1859e94e:f1:e1"),
            (134229895984, "migration-verify", "github-actions", "completed", "failure", "2026-11-17T17:27:39Z", "2026-11-17T17:48:26Z", 44136843405, "62a7d4fd-fbec-5a3e-a855-ea1fe40618d5"),
            (134229895876, "clued-cloud-tests", "github-actions", "completed", "success", "2026-11-17T17:27:39Z", "2026-11-17T17:37:21Z", 44136843405, "1895fd81-3583-5369-b90a-51993c4f4dae"),
            (134229895867, "ci-suites", "github-actions", "completed", "success", "2026-11-17T17:27:39Z", "2026-11-17T17:32:20Z", 44136843405, "b11f64ab-6838-5ef7-8f95-4ee423fa9935"),
            (134229894294, "ci-suites-windows", "github-actions", "completed", "success", "2026-11-17T17:27:39Z", "2026-11-17T17:31:58Z", 44136843505, "57b39bfa-d66a-55e4-b54c-1f855d3748cd"),
            (134229684764, "kooyumi-work-admission", "clued-ci-checks-turing-20261018", "completed", "success", "2026-11-17T17:27:16Z", "2026-11-17T17:27:16Z", 0, "independent-ci:native-work-admission:v2:46277db4d5e765dbb0d092c2a2afe34588df78ed8424e256ef155a56d7169537:a1:c1859e94e:f1:e1"),
            (134228583490, "admission-gate", "github-actions", "completed", "success", "2026-11-17T17:25:39Z", "2026-11-17T17:27:36Z", 44136843505, "aa3533a5-17aa-5cb0-a385-38a4668484aa"),
            (134228580664, "admission-gate", "github-actions", "completed", "success", "2026-11-17T17:25:39Z", "2026-11-17T17:27:36Z", 44136843405, "278c005b-2622-5000-b9ec-73c6354d5887"),
        ],
        "runs": [(44136843405, ".github/workflows/clued-required-tests.yml", "pull_request", 2, "a9e5b439dce5ecdfe7a63ee4f042f827595b1477", "43361ab833d68b2d6b9e53f7bc6e27ccbd6776e5"), (44136843505, ".github/workflows/clued-required-tests-windows.yml", "pull_request", 1, "a9e5b439dce5ecdfe7a63ee4f042f827595b1477", "43361ab833d68b2d6b9e53f7bc6e27ccbd6776e5")],
        "push_runs": [],
        "jobs": {
            44136843405: [(134228580664, "admission-gate", 1, "completed", "success", "2026-11-17T17:25:39Z", "2026-11-17T17:27:36Z"),
                (134229895867, "ci-suites", 1, "completed", "success", "2026-11-17T17:27:39Z", "2026-11-17T17:32:20Z"),
                (134229895876, "clued-cloud-tests", 1, "completed", "success", "2026-11-17T17:27:39Z", "2026-11-17T17:37:21Z"),
                (134229895984, "migration-verify", 1, "completed", "failure", "2026-11-17T17:27:39Z", "2026-11-17T17:48:26Z"),
                (134244251063, "migration-verify", 2, "completed", "failure", "2026-11-17T17:49:46Z", "2026-11-17T17:49:59Z"),
                (134244253929, "admission-gate", 2, "completed", "success", "2026-11-17T17:25:39Z", "2026-11-17T17:27:36Z"),
                (134244255605, "ci-suites", 2, "completed", "success", "2026-11-17T17:27:39Z", "2026-11-17T17:32:20Z"),
                (134244333953, "clued-cloud-tests", 2, "completed", "success", "2026-11-17T17:27:39Z", "2026-11-17T17:37:21Z")],
        },
    },
    1170: {
        "pull": {"number": 1170, "title": "First install: drill VM, first-install kit and on-duty guard (rebuilt)", "state": "closed", "head": {"sha": "8086d0e404dfc8f5bfcc8c467bd58658dea6efa9"}, "merge_commit_sha": "3ab8380d121b76a4256dd87d849897a535a48ab3", "merged_at": "2026-11-19T02:31:47Z", "closed_at": "2026-11-19T02:31:47Z", "updated_at": "2026-11-19T02:31:47Z"},
        "checks": [
            (135294798064, "kooyumi-merge-slot", "clued-ci-checks-turing-20261018", "completed", "success", "2026-11-19T02:31:45Z", "2026-11-19T02:31:45Z", 0, "independent-ci:control:control-merge-slot:v2:1eab0d55eb4999850da0dda699f9580024514f644d4bbf6b11798c33500434cf:a1:cd924089f:f2:e1"),
            (135294632467, "kooyumi-admission-verified", "clued-ci-checks-turing-20261018", "completed", "success", "2026-11-19T02:31:20Z", "2026-11-19T02:31:20Z", 0, "independent-ci:control:control-admission:v2:4b430d371793f24636dbd12447133479bc7690c7eb9fd67d339d0072327c4b07:a1:cd924089f:f2:e1"),
            (135294340231, "contract-placement", "clued-ci-checks-turing-20261018", "completed", "success", "2026-11-19T02:30:36Z", "2026-11-19T02:30:36Z", 0, "independent-ci:staged:v2:1bc4ca39304e5a519bc0218793246015836c7e3481979700402ef65190f2a7b9:a1"),
            (135293207330, "trivy", "clued-ci-checks-turing-20261018", "completed", "success", "2026-11-19T02:27:49Z", "2026-11-19T02:27:49Z", 0, "independent-ci:staged:v2:ddb6c24e7fbe584101ed04796945a16a5bc34a9ff4a1bbb9a2b5f9435014c0c4:a1"),
            (135292314263, "gitleaks", "clued-ci-checks-turing-20261018", "completed", "success", "2026-11-19T02:25:38Z", "2026-11-19T02:25:38Z", 0, "independent-ci:staged:v2:c73bc1ea0a04e0dfad0304cc44eb8c21b4177e91c668f037f7452675a88c25fa:a1"),
            (135290350282, "kooyumi-work-admission", "clued-ci-checks-turing-20261018", "completed", "success", "2026-11-19T02:20:56Z", "2026-11-19T02:20:56Z", 0, "independent-ci:native-work-admission:v2:965bc6a7b8b090d6637a85aed7cea41ddeac13f172efc7934d3fd31df6b03bfd:a1:cd924089f:f2:e1"),
            (135222860319, "contract-placement", "clued-ci-checks-turing-20261018", "completed", "success", "2026-11-18T23:47:13Z", "2026-11-18T23:47:13Z", 0, "independent-ci:staged:v2:ae70e963000e8540d956cac6e325525bc75b9ca50bb4e0de01256a890ce1c5d8:a1"),
            (135221915080, "trivy", "clued-ci-checks-turing-20261018", "completed", "success", "2026-11-18T23:45:13Z", "2026-11-18T23:45:13Z", 0, "independent-ci:staged:v2:c42571a5b0dd6fdba6945a10eef4a48b6228fffed60793c26a4a8482b117842a:a1"),
            (135220645414, "gitleaks", "clued-ci-checks-turing-20261018", "completed", "success", "2026-11-18T23:42:33Z", "2026-11-18T23:42:33Z", 0, "independent-ci:staged:v2:34278a0680c3981dffdda30c8a12ed7c5a1d62a50886bdc0941b3c1753a11d74:a1"),
            (135218157960, "ci-suites", "github-actions", "completed", "success", "2026-11-18T23:37:25Z", "2026-11-18T23:45:11Z", 44422035542, "5a0a0de1-5628-5add-b193-7b27b40af327"),
            (135218157827, "migration-verify", "github-actions", "completed", "success", "2026-11-18T23:37:25Z", "2026-11-18T23:40:55Z", 44422035542, "72fc1695-55fe-52db-bf1a-46086ea85df5"),
            (135218157807, "clued-cloud-tests", "github-actions", "completed", "success", "2026-11-18T23:37:25Z", "2026-11-18T23:46:19Z", 44422035542, "e4465580-8a6d-56a4-b1f7-c923bc88da99"),
            (135218142012, "ci-suites-windows", "github-actions", "completed", "success", "2026-11-18T23:37:23Z", "2026-11-18T23:50:33Z", 44422035579, "f7003d14-88f2-50b0-be20-6e75760c534d"),
            (135217997505, "kooyumi-work-admission", "clued-ci-checks-turing-20261018", "completed", "success", "2026-11-18T23:37:03Z", "2026-11-18T23:37:03Z", 0, "independent-ci:native-work-admission:v2:8fc746f34586862c931ab2999316fed563f75bc6a0cc728423fff3a353b5bdeb:a1:cd924089f:f2:e1"),
            (135217187194, "admission-gate", "github-actions", "completed", "success", "2026-11-18T23:35:27Z", "2026-11-18T23:37:22Z", 44422035542, "4151a308-b8a5-5df7-b7dc-9334ca776cd1"),
            (135217187048, "admission-gate", "github-actions", "completed", "success", "2026-11-18T23:35:27Z", "2026-11-18T23:37:20Z", 44422035579, "c47b2b97-f21b-5090-b229-190279992f02"),
        ],
        "runs": [(44422035579, ".github/workflows/clued-required-tests-windows.yml", "pull_request", 1, "055b4a666fa4b7adf6e4c23846f32ff3957ada09", "8086d0e404dfc8f5bfcc8c467bd58658dea6efa9"), (44422035542, ".github/workflows/clued-required-tests.yml", "pull_request", 1, "055b4a666fa4b7adf6e4c23846f32ff3957ada09", "8086d0e404dfc8f5bfcc8c467bd58658dea6efa9")],
        "push_runs": [(44444986057, ".github/workflows/clued-required-tests.yml", "push", 1, "055b4a666fa4b7adf6e4c23846f32ff3957ada09", "3ab8380d121b76a4256dd87d849897a535a48ab3"), (44444986420, ".github/workflows/clued-required-tests-windows.yml", "push", 1, "055b4a666fa4b7adf6e4c23846f32ff3957ada09", "3ab8380d121b76a4256dd87d849897a535a48ab3")],
        "jobs": {
            44444986057: [(135294837874, "admission-gate", 1, "completed", "success", "2026-11-19T02:31:53Z", "2026-11-19T02:32:12Z"),
                (135294983680, "migration-verify", 1, "completed", "success", "2026-11-19T02:32:15Z", "2026-11-19T02:51:26Z"),
                (135294983707, "clued-cloud-tests", 1, "completed", "success", "2026-11-19T02:32:15Z", "2026-11-19T02:41:59Z"),
                (135294984175, "ci-suites", 1, "completed", "success", "2026-11-19T02:32:15Z", "2026-11-19T02:42:21Z")],
            44444986420: [(135294839149, "admission-gate", 1, "completed", "success", "2026-11-19T02:31:54Z", "2026-11-19T02:32:14Z"),
                (135294998909, "ci-suites-windows", 1, "completed", "success", "2026-11-19T02:32:17Z", "2026-11-19T02:46:06Z")],
        },
    },
    1178: {
        "pull": {"number": 1178, "title": "Fleet: a package without the first-install kit fails to publish, an acceptance without its sha is refused", "state": "closed", "head": {"sha": "76783d4ad8b3b5584f80cae400e4465e14250241"}, "merge_commit_sha": "0a1d2f0b955833aaace9971ca634a5bd74371dab", "merged_at": "2026-11-19T06:43:24Z", "closed_at": "2026-11-19T06:43:24Z", "updated_at": "2026-11-19T06:43:24Z"},
        "checks": [
            (135390784412, "kooyumi-merge-slot", "clued-ci-checks-turing-20261018", "completed", "success", "2026-11-19T06:43:22Z", "2026-11-19T06:43:22Z", 0, "independent-ci:control:control-merge-slot:v2:7bba4aa046c6a8781575c6d432d0ff1d92aff52447de416b9c5cc682ee33cb22:a1:c06b37ff7:f1:e1"),
            (135390656324, "kooyumi-admission-verified", "clued-ci-checks-turing-20261018", "completed", "success", "2026-11-19T06:43:03Z", "2026-11-19T06:43:03Z", 0, "independent-ci:control:control-admission:v2:37a5b028b7ac72b9eefe59efa5cc2c422318c281726a81d2f609ba9cb2697c7b:a1:c06b37ff7:f1:e1"),
            (135390008323, "contract-placement", "clued-ci-checks-turing-20261018", "completed", "success", "2026-11-19T06:41:25Z", "2026-11-19T06:41:25Z", 0, "independent-ci:staged:v2:efdcf52ebf541444b5f83fe757b3ff1fc175279fc1cbec38fe2964f04e812ad1:a1"),
            (135389269289, "trivy", "clued-ci-checks-turing-20261018", "completed", "success", "2026-11-19T06:39:35Z", "2026-11-19T06:39:35Z", 0, "independent-ci:staged:v2:1f0bd2b1eef35507756b2019ad5584620b36872b52cbd9493f7ee45605b06e4a:a1"),
            (135388000825, "gitleaks", "clued-ci-checks-turing-20261018", "completed", "success", "2026-11-19T06:36:23Z", "2026-11-19T06:36:23Z", 0, "independent-ci:staged:v2:0893d0411875dd72b509a27d08b949efdce96e2e58e3d72b9274b35446199a2e:a1"),
            (135385622189, "kooyumi-work-admission", "clued-ci-checks-turing-20261018", "completed", "success", "2026-11-19T06:30:26Z", "2026-11-19T06:30:26Z", 0, "independent-ci:native-work-admission:v2:463d345ad58c3b184c26c1bbde252b0bc35419397c3118498260fa23c7786cca:a1:c06b37ff7:f1:e1"),
            (135383262052, "clued-cloud-tests", "github-actions", "completed", "success", "2026-11-19T06:31:06Z", "2026-11-19T06:38:40Z", 44471531779, "af4c9705-c9ce-557c-a135-35038fe38137"),
            (135383261896, "ci-suites", "github-actions", "completed", "success", "2026-11-19T06:27:09Z", "2026-11-19T06:34:59Z", 44471531779, "bf231b43-88a0-562b-9956-15ed908afe0a"),
            (135383261850, "migration-verify", "github-actions", "completed", "success", "2026-11-19T06:25:01Z", "2026-11-19T06:26:47Z", 44471531779, "d5dbac6a-6817-587e-9e57-04f6d06472db"),
            (135383024242, "ci-suites-windows", "github-actions", "completed", "success", "2026-11-19T06:23:59Z", "2026-11-19T06:39:24Z", 44471531651, "9b2a4e48-2a23-57f0-b8ce-c2a0773b353f"),
            (135382930538, "kooyumi-work-admission", "clued-ci-checks-turing-20261018", "completed", "success", "2026-11-19T06:23:43Z", "2026-11-19T06:23:43Z", 0, "independent-ci:native-work-admission:v2:cdbe9243d136e3542c7a8b7a350b73b5405a8a4d9d9499b01f66bb9495a58dd8:a1:c06b37ff7:f1:e1"),
            (135381926463, "admission-gate", "github-actions", "completed", "success", "2026-11-19T06:24:01Z", "2026-11-19T06:24:32Z", 44471531779, "51f28859-8c5f-55c6-832f-07104069eb04"),
            (135381925792, "admission-gate", "github-actions", "completed", "success", "2026-11-19T06:22:22Z", "2026-11-19T06:23:56Z", 44471531651, "e62c7eb8-8335-5c99-89af-841634724ccc"),
        ],
        "runs": [(44471531779, ".github/workflows/clued-required-tests.yml", "pull_request", 1, "80b9c36e57f95261b59af5aac6f5a1fb649fd33f", "76783d4ad8b3b5584f80cae400e4465e14250241"), (44471531651, ".github/workflows/clued-required-tests-windows.yml", "pull_request", 1, "80b9c36e57f95261b59af5aac6f5a1fb649fd33f", "76783d4ad8b3b5584f80cae400e4465e14250241")],
        "push_runs": [(44474248138, ".github/workflows/clued-required-tests-windows.yml", "push", 1, "80b9c36e57f95261b59af5aac6f5a1fb649fd33f", "0a1d2f0b955833aaace9971ca634a5bd74371dab"), (44474248339, ".github/workflows/clued-required-tests.yml", "push", 1, "80b9c36e57f95261b59af5aac6f5a1fb649fd33f", "0a1d2f0b955833aaace9971ca634a5bd74371dab")],
        "jobs": {
            44474248339: [(135390823271, "admission-gate", 1, "completed", "success", "2026-11-19T06:43:30Z", "2026-11-19T06:43:48Z"),
                (135390957668, "migration-verify", 1, "completed", "success", "2026-11-19T06:43:52Z", "2026-11-19T07:03:37Z"),
                (135390957680, "clued-cloud-tests", 1, "completed", "success", "2026-11-19T06:43:53Z", "2026-11-19T06:54:06Z"),
                (135390957746, "ci-suites", 1, "completed", "success", "2026-11-19T06:43:51Z", "2026-11-19T06:54:08Z")],
            44474248138: [(135390822631, "admission-gate", 1, "completed", "success", "2026-11-19T06:43:30Z", "2026-11-19T06:43:50Z"),
                (135390971555, "ci-suites-windows", 1, "completed", "success", "2026-11-19T06:43:53Z", "2026-11-19T06:59:33Z")],
        },
    },
}

REC_NOW = datetime(2026, 11, 19, 8, 0, tzinfo=timezone.utc)
REC_REPO = "https://github.com/tdoljyj/cross-memory-system"


def rec_check(row: tuple) -> dict:
    cid, name, slug, status, conclusion, started, completed, run, external = row
    return {"id": cid, "name": name, "app": {"slug": slug}, "status": status, "conclusion": conclusion,
            "started_at": started, "completed_at": completed, "external_id": external or None,
            "details_url": f"{REC_REPO}/actions/runs/{run}/job/{cid}" if run else REC_REPO}


def rec_run(row: tuple) -> dict:
    rid, path, event, attempt, tree, head = row
    return {"id": rid, "path": path, "name": path.rsplit("/", 1)[-1], "event": event, "run_attempt": attempt,
            "head_sha": head, "head_commit": {"id": head, "tree_id": tree}}


def rec_job(run: int, row: tuple) -> dict:
    jid, name, attempt, status, conclusion, started, completed = row
    return {"id": jid, "run_id": run, "name": name, "run_attempt": attempt, "status": status, "conclusion": conclusion,
            "started_at": started, "completed_at": completed}


class TreeRecordedGitHub:
    """Serves one recorded PR: its head's check runs and runs, the merge commit's push runs, and run jobs."""

    def __init__(self, case: dict, skipped_push: bool = False) -> None:
        self.case, self.skipped_push = case, skipped_push
        self.paths: list[str] = []

    def low(self) -> bool:
        return False

    def get(self, path: str, params: dict | None = None):
        params = params or {}
        self.paths.append(path)
        case = self.case
        head, merge = case["pull"]["head"]["sha"], case["pull"].get("merge_commit_sha")
        if path == "/pulls":
            return [case["pull"]]
        if path == f"/commits/{head}/check-runs":
            rows = [rec_check(row) for row in case["checks"]]
            page = params.get("page", 1)
            return {"total_count": len(rows), "check_runs": rows[(page - 1) * 100: page * 100]}
        if path == "/actions/runs" and params.get("head_sha") == head:
            return {"workflow_runs": [rec_run(row) for row in case["runs"]]}
        if path == "/actions/runs" and merge and params.get("head_sha") == merge:
            runs = [rec_run(row) for row in case["push_runs"]]
            return {"workflow_runs": [run for run in runs if params.get("event") in (None, run["event"])]}
        if path.startswith("/actions/runs/") and path.endswith("/jobs"):
            run = int(path.split("/")[3])
            jobs = [rec_job(run, row) for row in case["jobs"].get(run, [])]
            if self.skipped_push and any(run == row[0] for row in case["push_runs"]):
                for job in jobs:
                    if job["name"] != "admission-gate":
                        job.update(name=job["name"] + "-skipped", conclusion="skipped")
            return {"total_count": len(jobs), "jobs": jobs}
        raise panel.RequestError(f"GET {path} unscripted", 404)


def scan_recorded(number: int, **kwargs) -> list[dict]:
    return panel.scan_duplicates(TreeRecordedGitHub(TREE_RECORDED[number], **kwargs), REC_NOW, {})["found"]


class TreeDuplicateTests(unittest.TestCase):
    def test_t4_the_main_push_of_1178_ran_four_checks_again_on_the_same_tree(self) -> None:
        found = scan_recorded(1178)
        self.assertEqual(sorted(item["label"] for item in found),
                         ["ci-suites-windows（clued-required-tests-windows.yml）", "ci-suites（clued-required-tests.yml）",
                          "clued-cloud-tests（clued-required-tests.yml）", "migration-verify（clued-required-tests.yml）"])
        for item in found:
            self.assertEqual((item["pr"], item["count"], item["kind"]), (1178, 2, "rerun"))
            self.assertIn("main-push", item["causes"])
            self.assertEqual(item["tree"], "80b9c36e57f9")
            self.assertEqual([run["event"] for run in item["runs"]], ["pull_request", "push"])
            self.assertEqual([run["attempt"] for run in item["runs"]], [1, 1])
        key, text = panel.duplicate_event(found[0])
        self.assertIn("合入后 main push", text)

    def test_t5_1156_reran_only_migration_verify_and_that_is_a_retry_after_a_failure(self) -> None:
        (item,) = scan_recorded(1156)
        self.assertEqual((item["check"], item["count"], item["kind"]),
                         (".github/workflows/clued-required-tests.yml::migration-verify", 2, "retry"))
        self.assertEqual([run["attempt"] for run in item["runs"]], [1, 2])
        self.assertEqual([run["conclusion"] for run in item["runs"]], ["failure", "failure"])

    def test_guard_1170_resident_scans_run_twice_on_one_head_stay_found(self) -> None:
        found = {item["check"]: item for item in scan_recorded(1170)}
        for name in ("gitleaks", "trivy", "contract-placement"):
            self.assertEqual(found[name]["count"], 2)
            self.assertEqual([run["executor"] for run in found[name]["runs"]], ["resident", "resident"])

    def test_guard_a_main_push_whose_heavy_jobs_were_skipped_is_no_run(self) -> None:
        self.assertEqual(scan_recorded(1178, skipped_push=True), [])

    def test_two_copies_at_once_or_one_still_running_are_parallel_not_after_a_pass(self) -> None:
        (item,) = findings([check("validate", 30, run=21), check("validate", 29.5, run=23)])  # the first ended at 29
        self.assertEqual(item["kind"], "parallel")
        (item,) = findings([check("validate", 30, None, run=21), check("validate", 20, "failure", run=23)])
        self.assertEqual(item["kind"], "parallel")
        self.assertIn("并行或前一次未结束又跑", panel.duplicate_event(item)[1])
        # after a pass it is a rerun, whatever ran alongside; after failures only, a retry
        (item,) = findings([check("validate", 30, run=21), check("validate", 25, None, run=23), check("validate", 24, run=21)])
        self.assertEqual(item["kind"], "rerun")
        (item,) = findings([check("validate", 30, "failure", run=21), check("validate", 20, run=23)])
        self.assertEqual(item["kind"], "retry")

    def test_a_retry_after_a_failure_is_listed_but_not_announced(self) -> None:
        state: dict = {"duplicates": {"as_of": panel.iso(REC_NOW - timedelta(hours=2))}}

        class Client(TreeRecordedGitHub):
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
                return super().get(path, params)

        report = panel.build(Client(TREE_RECORDED[1156]), REC_NOW, state)
        self.assertEqual(len(report["duplicates"]["found"]), 1)
        self.assertEqual([key for key in report["events"] if key.startswith("dup")], [])
        body = panel.render(report, state)
        self.assertIn("失败后重试", body)
        self.assertIn("同一棵树", body)
        report = panel.build(Client(TREE_RECORDED[1178]), REC_NOW, {"duplicates": {"as_of": panel.iso(REC_NOW - timedelta(hours=2))}})
        self.assertEqual(len([key for key in report["events"] if key.startswith("dup:")]), 4)


if __name__ == "__main__":
    unittest.main()
