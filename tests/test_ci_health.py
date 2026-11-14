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


health = load_module("clued_ci_health", "scripts/ci/self-hosted/ci_health.py")
transport = load_module("clued_ci_health_transport", "scripts/ci/self-hosted/ci_health_transport.py")
analyzer = load_module("clued_ci_health_analyzer", "scripts/ci/self-hosted/ci_health_analyze.py")


class CluedCiHealthTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.inventory = json.loads(
            (ROOT / "scripts/ci/self-hosted/node-profiles.json").read_text(encoding="utf-8")
        )
        cls.expected, _ = health.build_expectations(cls.inventory)

    def runners(self):
        result = []
        for index, contract in enumerate(self.expected.values(), start=1):
            result.append({
                "id": index,
                "name": contract["name"],
                "os": contract["os"],
                "status": "online",
                "busy": False,
                "labels": [{"name": value} for value in contract["required_labels"]],
            })
        return result

    def test_transport_is_permanently_marked_do_not_merge(self):
        self.assertEqual(transport.DO_NOT_MERGE_LABEL, "do-not-merge")
        self.assertIn("DO NOT MERGE", transport.PR_BODY)
        self.assertIn(transport.TRANSPORT_LABEL, transport.LABEL_SPECS)
        self.assertIn(transport.DO_NOT_MERGE_LABEL, transport.LABEL_SPECS)

    def test_hosted_monitor_and_revocation_schedules_stay_independent(self):
        workflows = ROOT / ".github" / "workflows"
        monitor = (workflows / "clued-ci-health.yml").read_text(encoding="utf-8")
        reverify = (workflows / "clued-work-admission-reverify.yml").read_text(encoding="utf-8")
        executor = (workflows / "clued-merge-executor.yml").read_text(encoding="utf-8")
        self.assertIn('cron: "17 */6 * * *"', monitor)
        self.assertIn("runs-on: ubuntu-slim", monitor)
        self.assertIn("  pull_request:\n", monitor)
        self.assertIn("  workflow_dispatch:\n", monitor)
        self.assertNotIn("needs:", monitor, "pool loss must not prevent its hosted monitor")
        self.assertIn('cron: "17 * * * *"', reverify, "revocation checks remain hourly")
        self.assertIn("inputs.reason == 'state_change' && 30 || 10", reverify)
        self.assertNotRegex(executor, r"(?m)^  schedule:")

    def report(self, runners=None, jobs=None):
        return health.build_report(
            "tdoljyj/cross-memory-system",
            self.inventory,
            runners if runners is not None else self.runners(),
            jobs or [],
            datetime(2026, 9, 23, 4, 0, tzinfo=timezone.utc),
        )

    def slow_job(self, job_id: int, pool: str, minutes: int = 6):
        labels = ["self-hosted", "X64", "clued", "pool-general", "trust-internal"]
        if pool == "windows-general-v1":
            labels += ["Windows", "cap-python312"]
        else:
            labels += ["Linux", "cap-docker-linux"]
        created = datetime(2026, 9, 23, 3, 0, tzinfo=timezone.utc) + timedelta(minutes=job_id)
        return {
            "id": job_id,
            "run_id": 100 + job_id,
            "name": f"job-{job_id}",
            "status": "in_progress",
            "labels": labels,
            "created_at": health.isoformat(created),
            "started_at": health.isoformat(created + timedelta(minutes=minutes)),
        }

    def heartbeat_job(self, job_id: int, runner_name: str, queued: bool = True):
        contract = self.expected[runner_name]
        created = datetime(2026, 9, 23, 3, 0, tzinfo=timezone.utc) + timedelta(minutes=job_id)
        return {
            "id": job_id,
            "run_id": 500 + job_id,
            "name": f"{health.HEARTBEAT_PREFIX}{runner_name}",
            "status": "queued" if queued else "completed",
            "conclusion": None if queued else "success",
            "runner_name": "" if queued else runner_name,
            "labels": contract["required_labels"],
            "created_at": health.isoformat(created),
            "started_at": health.isoformat(created),
        }

    def test_healthy_four_runner_pool_is_model_free(self):
        report = self.report()
        self.assertEqual(report["status"], "HEALTHY")
        self.assertFalse(report["notify_model"])
        self.assertEqual(report["anomalies"], [])

    def test_one_offline_runner_is_not_pool_failure(self):
        runners = self.runners()
        runners[0]["status"] = "offline"
        report = self.report(runners=runners)
        self.assertEqual(report["status"], "HEALTHY")

    def test_both_windows_runners_offline_is_anomaly(self):
        runners = self.runners()
        for runner in runners:
            if runner["os"] == "Windows":
                runner["status"] = "offline"
        report = self.report(runners=runners)
        self.assertIn("CAPABILITY_POOL_UNAVAILABLE", [item["code"] for item in report["anomalies"]])

    def test_required_label_drift_is_anomaly(self):
        runners = self.runners()
        runners[0]["labels"] = [
            item for item in runners[0]["labels"] if item["name"] != "trust-internal"
        ]
        report = self.report(runners=runners)
        self.assertIn("RUNNER_LABEL_DRIFT", [item["code"] for item in report["anomalies"]])

    def test_secretless_heartbeat_route_can_be_healthy(self):
        jobs = [
            self.heartbeat_job(index, name, queued=False)
            for index, name in enumerate(self.expected, start=1)
        ]
        report = health.build_report(
            "tdoljyj/cross-memory-system",
            self.inventory,
            None,
            jobs,
            datetime(2026, 9, 23, 4, 0, tzinfo=timezone.utc),
        )
        self.assertEqual(report["status"], "HEALTHY")
        self.assertFalse(report["notify_model"])
        self.assertEqual(report["observations"]["runners"]["mode"], "exact-label-heartbeat")

    def test_two_slow_exact_route_probes_notify(self):
        name = "clued-ci-company-linux-02"
        jobs = [self.heartbeat_job(1, name), self.heartbeat_job(2, name)]
        report = health.build_report(
            "tdoljyj/cross-memory-system",
            self.inventory,
            None,
            jobs,
            datetime(2026, 9, 23, 4, 0, tzinfo=timezone.utc),
        )
        codes = [item["code"] for item in report["anomalies"]]
        self.assertIn("RUNNER_ROUTE_UNAVAILABLE", codes)
        self.assertIn("REPEATED_STARTUP_DELAY", codes)

    def test_single_slow_start_does_not_notify(self):
        report = self.report(jobs=[self.slow_job(1, "windows-general-v1")])
        self.assertEqual(report["status"], "HEALTHY")

    def test_two_slow_starts_in_same_pool_notify(self):
        report = self.report(jobs=[
            self.slow_job(1, "windows-general-v1"),
            self.slow_job(2, "windows-general-v1"),
        ])
        self.assertEqual(report["status"], "ANOMALY")
        self.assertIn("REPEATED_STARTUP_DELAY", [item["code"] for item in report["anomalies"]])

    def test_previous_report_preserves_delay_occurrences(self):
        original = self.report(jobs=[
            self.slow_job(1, "windows-general-v1"),
            self.slow_job(2, "windows-general-v1"),
        ])
        restored_jobs = health.previous_delay_jobs(original)
        restored = self.report(jobs=restored_jobs)
        self.assertEqual(restored["status"], "ANOMALY")
        self.assertIn("REPEATED_STARTUP_DELAY", [item["code"] for item in restored["anomalies"]])

    def test_queued_jobs_ignore_prefilled_started_at(self):
        jobs = [
            self.slow_job(1, "windows-general-v1"),
            self.slow_job(2, "windows-general-v1"),
        ]
        for job in jobs:
            job["status"] = "queued"
            job["started_at"] = job["created_at"]
        report = self.report(jobs=jobs)
        anomaly_details = next(
            item["details"]
            for item in report["anomalies"]
            if item["code"] == "REPEATED_STARTUP_DELAY"
        )
        self.assertTrue(all(item["kind"] == "queued" for item in anomaly_details["jobs"]))

    def routed_job(self, job_id, runner_name, created, started, completed, labels=None, name=None):
        return {
            "id": job_id,
            "run_id": 900 + job_id,
            "name": name or f"job-{job_id}",
            "status": "completed",
            "conclusion": "success",
            "runner_name": runner_name,
            "labels": labels or self.expected[runner_name]["required_labels"],
            "created_at": health.isoformat(created),
            "started_at": health.isoformat(started),
            "completed_at": health.isoformat(completed),
        }

    def secretless_report(self, jobs):
        return health.build_report(
            "tdoljyj/cross-memory-system", self.inventory, None, jobs,
            datetime(2026, 9, 23, 4, 0, tzinfo=timezone.utc),
        )

    def slow_entries(self, report):
        pools = report["observations"]["startup_delays"]["slow_occurrences_by_pool"]
        return {entry["job_id"]: entry for entries in pools.values() for entry in entries}

    def test_wait_behind_another_job_is_runner_occupied(self):
        name = "clued-ci-company-win-01"
        t0 = datetime(2026, 9, 23, 3, 0, tzinfo=timezone.utc)
        gate = self.routed_job(
            1, name, t0 - timedelta(minutes=2), t0 - timedelta(minutes=2), t0 + timedelta(minutes=12),
            labels=["self-hosted", "Windows", "X64", "clued", "pool-general", "trust-internal", "cap-node24"],
            name="clued-g4-database",
        )
        probe = self.routed_job(
            2, name, t0, t0 + timedelta(minutes=12, seconds=4), t0 + timedelta(minutes=12, seconds=14),
            name=f"{health.HEARTBEAT_PREFIX}{name}",
        )
        entry = self.slow_entries(self.secretless_report([gate, probe]))["2"]
        self.assertEqual(entry["wait_cause"], "runner_occupied")
        self.assertEqual(entry["runner_name"], name)
        self.assertEqual([item["name"] for item in entry["occupied_by"]], ["clued-g4-database"])

    def test_idle_runner_while_eligible_work_queued_notifies(self):
        idle = "clued-ci-company-linux-03"
        busy = "clued-ci-company-linux-01"
        t0 = datetime(2026, 9, 23, 3, 0, tzinfo=timezone.utc)
        generic = ["self-hosted", "Linux", "X64", "clued", "pool-general", "trust-internal", "cap-docker-linux"]
        jobs = [
            self.routed_job(1, idle, t0, t0 + timedelta(minutes=40), t0 + timedelta(minutes=41),
                            name=f"{health.HEARTBEAT_PREFIX}{idle}"),
            self.routed_job(2, busy, t0 + timedelta(minutes=5), t0 + timedelta(minutes=13),
                            t0 + timedelta(minutes=14), labels=generic),
            self.routed_job(3, busy, t0 + timedelta(minutes=6), t0 + timedelta(minutes=15),
                            t0 + timedelta(minutes=16), labels=generic),
        ]
        report = self.secretless_report(jobs)
        entry = self.slow_entries(report)["1"]
        self.assertEqual(entry["wait_cause"], "runner_idle_while_work_queued")
        self.assertEqual({str(item["job_id"]) for item in entry["queued_eligible_jobs"]}, {"2", "3"})
        keys = [item["key"] for item in report["anomalies"]]
        self.assertIn(f"runner:{idle}:idle-while-work-queued", keys)

        restored = self.secretless_report(health.previous_delay_jobs(report))
        self.assertIn(f"runner:{idle}:idle-while-work-queued", [item["key"] for item in restored["anomalies"]])
        self.assertEqual(self.slow_entries(restored)["1"]["wait_cause"], "runner_idle_while_work_queued")

    def test_single_queued_eligible_job_does_not_flag_idle_runner(self):
        idle = "clued-ci-company-linux-03"
        t0 = datetime(2026, 9, 23, 3, 0, tzinfo=timezone.utc)
        generic = ["self-hosted", "Linux", "X64", "clued", "pool-general", "trust-internal", "cap-docker-linux"]
        jobs = [
            self.routed_job(1, idle, t0, t0 + timedelta(minutes=40), t0 + timedelta(minutes=41),
                            name=f"{health.HEARTBEAT_PREFIX}{idle}"),
            self.routed_job(2, "clued-ci-company-linux-01", t0 + timedelta(minutes=5),
                            t0 + timedelta(minutes=13), t0 + timedelta(minutes=14), labels=generic),
            # Another runner's exact route is not work the idle runner could serve.
            self.routed_job(3, "clued-ci-company-linux-02", t0, t0 + timedelta(minutes=20),
                            t0 + timedelta(minutes=21), name=f"{health.HEARTBEAT_PREFIX}clued-ci-company-linux-02"),
        ]
        report = self.secretless_report(jobs)
        self.assertNotIn("RUNNER_IDLE_WHILE_WORK_QUEUED", [item["code"] for item in report["anomalies"]])

    def test_slow_starts_in_different_pools_do_not_combine(self):
        report = self.report(jobs=[
            self.slow_job(1, "windows-general-v1"),
            self.slow_job(2, "linux-docker-wsl2-v1"),
        ])
        self.assertEqual(report["status"], "HEALTHY")

    def test_old_unexplained_wait_is_corrected_by_recovered_occupation(self):
        name = "clued-ci-company-linux-02"
        t0 = datetime(2026, 9, 23, 3, 0, tzinfo=timezone.utc)
        probe = self.routed_job(2, name, t0, t0 + timedelta(seconds=385), t0 + timedelta(seconds=395))
        probe.update(wait_cause="unexplained", idle_seconds=385)
        occupier = self.routed_job(1, name, t0 - timedelta(minutes=1), t0 - timedelta(minutes=1), t0 + timedelta(seconds=381))
        entry = self.slow_entries(self.report(jobs=[probe, occupier]))["2"]
        self.assertEqual(entry["wait_cause"], "runner_occupied")
        self.assertEqual(entry["idle_seconds"], 4)

    def test_partial_occupation_does_not_explain_a_five_minute_wait(self):
        name = "clued-ci-company-linux-02"
        t0 = datetime(2026, 9, 23, 3, 0, tzinfo=timezone.utc)
        probe = self.routed_job(2, name, t0, t0 + timedelta(seconds=304), t0 + timedelta(seconds=310))
        occupier = self.routed_job(1, name, t0, t0, t0 + timedelta(seconds=5))
        entry = self.slow_entries(self.report(jobs=[probe, occupier]))["2"]
        self.assertEqual(entry["wait_cause"], "unexplained")

    def test_capacity_classification_changes_fingerprint_without_hiding_threshold(self):
        jobs = [self.slow_job(1, "linux-docker-wsl2-v1"), self.slow_job(2, "linux-docker-wsl2-v1")]
        unknown = self.report(jobs=jobs)
        for job in jobs:
            job.update(wait_cause="runner_occupied", idle_seconds=4, occupied_by=[{"job_id": 100}])
        capacity = self.report(jobs=jobs)
        self.assertEqual(capacity["status"], "ANOMALY")
        self.assertTrue(capacity["notify_model"])
        self.assertEqual(capacity["anomalies"][0]["details"]["classification"], "capacity_pressure")
        self.assertEqual(capacity["anomalies"][0]["details"]["severity"], "info")
        self.assertNotEqual(capacity["fingerprint"], unknown["fingerprint"])
        jobs[0]["wait_cause"] = "unexplained"
        mixed = self.report(jobs=jobs)
        self.assertEqual(mixed["anomalies"][0]["details"]["severity"], "warning")

    def test_missing_occupation_details_cannot_be_capacity_only(self):
        jobs = [self.slow_job(1, "linux-docker-wsl2-v1"), self.slow_job(2, "linux-docker-wsl2-v1")]
        for job in jobs:
            job["wait_cause"] = "runner_occupied"
        report = self.report(jobs=jobs)
        self.assertEqual(report["anomalies"][0]["details"]["classification"], "startup_delay_needs_investigation")

    def test_carried_queued_job_keeps_waiting_instead_of_becoming_success(self):
        jobs = [self.slow_job(1, "linux-docker-wsl2-v1"), self.slow_job(2, "linux-docker-wsl2-v1")]
        for job in jobs:
            job.update(status="queued", started_at=job["created_at"])
        report = self.report(jobs=jobs)
        restored = health.previous_delay_jobs(report)
        self.assertTrue(all(job["status"] == "queued" and job["conclusion"] is None for job in restored))
        self.assertTrue(all(entry["kind"] == "queued" for entry in self.slow_entries(self.report(jobs=restored)).values()))

    def test_context_recovery_fetches_old_run_assignment_and_obeys_budget(self):
        calls = []
        old = self.slow_job(1, "linux-docker-wsl2-v1")
        old.update(wait_cause="unexplained", runner_name="")
        class Client:
            def get(self, path, params):
                calls.append((path, params))
                if path.endswith("/actions/runs"):
                    return {"workflow_runs": [{"id": 200}, {"id": 201}, {"id": 202}]}
                return {"jobs": [{"id": old["id"], "runner_name": "clued-ci-company-linux-02"}]}
        recovered = health.collect_delay_context_jobs(Client(), "tdoljyj/cross-memory-system", [old], [],
                                                     datetime(2026, 9, 23, tzinfo=timezone.utc), 2)
        self.assertEqual(sum(path.endswith("/jobs") for path, _ in calls), 2)
        self.assertEqual(recovered[0]["runner_name"], "clued-ci-company-linux-02")
        self.assertIn("..", next(params["created"] for path, params in calls if path.endswith("/actions/runs")))

    def test_capacity_only_history_does_not_trigger_extra_collection(self):
        class Client:
            def get(self, *_):
                raise AssertionError("capacity-only history must not add requests")
        self.assertEqual(health.collect_delay_context_jobs(Client(), "repo", [{"wait_cause": "runner_occupied"}], [],
                                                         datetime(2026, 9, 23, tzinfo=timezone.utc), 20), [])

    def test_fingerprint_ignores_observation_timestamps(self):
        first = self.report(jobs=[self.slow_job(1, "windows-general-v1"), self.slow_job(2, "windows-general-v1")])
        second = json.loads(json.dumps(first))
        second["observed_at"] = "2026-09-23T05:00:00Z"
        second["anomalies"][0]["details"]["jobs"][0]["delay_seconds"] = 999
        self.assertEqual(
            health.anomaly_fingerprint(first["anomalies"]),
            health.anomaly_fingerprint(second["anomalies"]),
        )

    def test_transport_deduplicates_same_open_anomaly(self):
        report = self.report(jobs=[self.slow_job(1, "windows-general-v1"), self.slow_job(2, "windows-general-v1")])
        self.assertEqual(transport.decide_transport(report, report, "open"), "NOOP")
        self.assertEqual(transport.decide_transport(report, report, "open", True), "UPSERT")

    def test_transport_closes_on_recovery_and_reopens_later(self):
        healthy = self.report()
        anomaly_report = self.report(jobs=[self.slow_job(1, "windows-general-v1"), self.slow_job(2, "windows-general-v1")])
        self.assertEqual(transport.decide_transport(healthy, anomaly_report, "open"), "RECOVER")
        self.assertEqual(transport.decide_transport(anomaly_report, anomaly_report, "closed"), "UPSERT")

    def test_api_fallback_is_explicitly_gpt_6_luna(self):
        self.assertEqual(analyzer.DEFAULT_MODEL, "gpt-6-luna")
        self.assertEqual(
            analyzer.extract_output_text({
                "output": [{"content": [{"type": "output_text", "text": "analysis"}]}]
            }),
            "analysis",
        )


    def inventory_with_extra_linux(self, state: str):
        inventory = json.loads(json.dumps(self.inventory))
        company = next(host for host in inventory["hosts"] if host["site"] == "company")
        extra = company.setdefault("additional_linux_runners", [])
        if not extra:
            extra.append({
                "profile": "linux-docker-wsl2-v1",
                "name": "clued-ci-company-linux-02",
                "route_label": "runner-company-linux-02",
                "capabilities": ["cap-docker-linux", "runtime-wsl2"],
            })
        extra[0]["state"] = state
        return inventory, extra[0]

    def test_enrolling_extra_linux_runner_is_known_but_not_required(self):
        inventory, extra = self.inventory_with_extra_linux("enrolling")
        expected, _ = health.build_expectations(inventory)
        self.assertNotIn(extra["name"], expected)
        registered = self.runners() + [{
            "id": 99,
            "name": extra["name"],
            "os": "Linux",
            "status": "online",
            "busy": False,
            "labels": [{"name": "clued"}],
        }]
        report = health.build_report(
            "tdoljyj/cross-memory-system", inventory, registered, [],
            datetime(2026, 9, 23, 4, 0, tzinfo=timezone.utc),
        )
        self.assertEqual(report["anomalies"], [])

    def test_active_extra_linux_runner_requires_its_route_label(self):
        inventory, extra = self.inventory_with_extra_linux("active")
        expected, pools = health.build_expectations(inventory)
        self.assertIn(extra["name"], expected)
        self.assertIn(extra["route_label"], expected[extra["name"]]["required_labels"])
        self.assertIn("site-company", expected[extra["name"]]["required_labels"])
        self.assertIn(extra["name"], pools["linux-docker-wsl2-v1"])
        without_extra = [runner for runner in self.runners() if runner["name"] != extra["name"]]
        report = health.build_report(
            "tdoljyj/cross-memory-system", inventory, without_extra, [],
            datetime(2026, 9, 23, 4, 0, tzinfo=timezone.utc),
        )
        self.assertIn("RUNNER_MISSING", [item["code"] for item in report["anomalies"]])

    def test_retired_primary_linux_runner_is_known_but_not_expected(self):
        retired = "clued-ci-home-linux-01"
        self.assertNotIn(retired, self.expected)
        self.assertIn(retired, health.declared_runner_names(self.inventory))
        # Its registration is kept but stays offline; that is not an anomaly.
        registered = self.runners() + [{
            "id": 99,
            "name": retired,
            "os": "Linux",
            "status": "offline",
            "busy": False,
            "labels": [{"name": "clued"}],
        }]
        self.assertEqual(self.report(runners=registered)["anomalies"], [])
        # Leftover queued probes for it never make its route unavailable.
        t0 = datetime(2026, 9, 23, 3, 0, tzinfo=timezone.utc)
        probes = [{
            "id": job_id,
            "run_id": 700 + job_id,
            "name": f"{health.HEARTBEAT_PREFIX}{retired}",
            "status": "queued",
            "conclusion": None,
            "runner_name": "",
            "labels": ["self-hosted", "Linux", "X64", "clued", "pool-general", "trust-internal",
                       "cap-docker-linux", "runtime-wsl2", "site-home"],
            "created_at": health.isoformat(t0 + timedelta(minutes=job_id)),
            "started_at": health.isoformat(t0 + timedelta(minutes=job_id)),
        } for job_id in (1, 2)]
        report = self.secretless_report(probes)
        self.assertNotIn(retired, report["observations"]["runners"]["routes"])
        self.assertNotIn("RUNNER_ROUTE_UNAVAILABLE", [item["code"] for item in report["anomalies"]])


if __name__ == "__main__":
    unittest.main()
