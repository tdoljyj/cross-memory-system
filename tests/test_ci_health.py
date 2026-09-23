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


if __name__ == "__main__":
    unittest.main()
