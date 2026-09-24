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
        name = "clued-ci-home-linux-01"
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

    def test_slow_starts_in_different_pools_do_not_combine(self):
        report = self.report(jobs=[
            self.slow_job(1, "windows-general-v1"),
            self.slow_job(2, "linux-docker-wsl2-v1"),
        ])
        self.assertEqual(report["status"], "HEALTHY")

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
        report = health.build_report(
            "tdoljyj/cross-memory-system", inventory, self.runners(), [],
            datetime(2026, 9, 23, 4, 0, tzinfo=timezone.utc),
        )
        self.assertIn("RUNNER_MISSING", [item["code"] for item in report["anomalies"]])


if __name__ == "__main__":
    unittest.main()
