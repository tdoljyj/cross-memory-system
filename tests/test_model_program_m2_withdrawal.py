import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/model-program/validate_m2_withdrawal.py"
sys.path.insert(0, str(SCRIPT.parent))
import validate_m2_withdrawal as m


class WithdrawalTests(unittest.TestCase):
    def setUp(self):
        self.bundle = m.load(m.FIXTURE)

    def reseal(self):
        sources = self.bundle["registry"]["sources"]
        for source in sources:
            source["raw_snapshot_sha256"] = m.digest(source["synthetic_inputs"])
            for row in self.bundle["manifest"]["samples"]:
                if row["source_id"] == source["source_id"]:
                    row["raw_snapshot_sha256"] = source["raw_snapshot_sha256"]
        manifest = self.bundle["manifest"]
        manifest["registry_sha256"] = m.digest(sources)
        manifest["manifest_revision_sha256"] = m.digest({
            key: value for key, value in manifest.items() if key != "manifest_revision_sha256"
        })
        for report in self.bundle["selection_reports"]:
            report["manifest_revision_sha256"] = manifest["manifest_revision_sha256"]

    def graph(self, edges):
        original = self.bundle["registry"]["sources"][0]
        root_source = copy.deepcopy(original)
        root_source.update(source_id="synthetic-withdrawal-root", synthetic_inputs={})
        self.bundle["registry"]["sources"].append(root_source)
        template = self.bundle["manifest"]["samples"][0]
        for name, parents in edges.items():
            source = original if parents else root_source
            text = "Synthetic propagation arithmetic test " + name
            source["synthetic_inputs"][name] = text
            sample = copy.deepcopy(template)
            sample.update(sample_id=name, source_id=source["source_id"], input_key=name,
                          content_sha256=m.digest(text), parent_sample_ids=parents)
            self.bundle["manifest"]["samples"].append(sample)
            self.bundle["manifest"]["splits"][0]["sample_ids"].append(name)
        self.reseal()
        return root_source

    def events(self, source=None, reason="WITHDRAWN"):
        source = source or self.bundle["registry"]["sources"][0]
        return {"schema_version": "clued.model-m2-withdrawal-candidate/1",
                "authority_effect": "NONE", "baseline_sha256": m.digest(self.bundle),
                "events": [{"event_id": "synthetic-event-1", "reason": reason,
                            **{key: source[key] for key in
                               ("source_id", "source_revision", "raw_snapshot_sha256")}}]}

    def rejected(self, events, code):
        with self.assertRaises(m.FoundationError) as caught:
            m.propagate(self.bundle, events)
        self.assertEqual(caught.exception.code, "CLUED_MODEL_M2_" + code)

    def test_multilevel_shared_ancestor_and_unaffected_samples(self):
        source = self.graph({"root": [], "left": ["root"], "right": ["root"],
                             "leaf": ["left", "right", "fixture-sample-0"]})
        before = copy.deepcopy(self.bundle)
        result = m.propagate(self.bundle, self.events(source))
        self.assertEqual(result["direct_invalid_sample_ids"], ["root"])
        self.assertEqual(result["derived_invalid_sample_ids"], ["leaf", "left", "right"])
        self.assertEqual(result["retained_sample_ids"], [f"fixture-sample-{i}" for i in range(6)])
        self.assertEqual(result["affected_split_ids"], ["fixture-partition-0"])
        self.assertEqual(result["dataset_status"], "UNAVAILABLE_WITHDRAWAL")
        self.assertEqual(self.bundle, before)
        with self.assertRaisesRegex(m.FoundationError, "DATASET_UNAVAILABLE_WITHDRAWAL"):
            m.validate_impact(self.bundle, self.events(source), result, require_available=True)

    def test_empty_event_set_remains_candidate_never_authorized(self):
        events = self.events()
        events["events"] = []
        result = m.propagate(self.bundle, events)
        m.validate_impact(self.bundle, events, result, require_available=True)
        self.assertEqual(result["dataset_status"], "UNCHANGED_CANDIDATE")
        self.assertFalse(result["training_or_data_use_authorized"])
        self.assertEqual(result["m2_verdict"], "NOT_ISSUED")
        self.assertFalse(result["physical_erasure_performed"])

    def test_duplicate_reordered_and_overlapping_events_are_idempotent(self):
        source = self.graph({"root": [], "child": ["root"]})
        events = self.events(source)
        second = copy.deepcopy(events["events"][0])
        second["event_id"] = "synthetic-event-2"
        events["events"].append(second)
        expected = m.propagate(self.bundle, events)
        events["events"] = list(reversed(events["events"])) * 3
        self.assertEqual(m.propagate(self.bundle, events), expected)
        self.assertEqual(expected["invalid_sample_ids"], ["child", "root"])

    def test_conflicting_duplicate_event_fails_closed(self):
        events = self.events()
        conflict = copy.deepcopy(events["events"][0])
        conflict["reason"] = "DELETED"
        events["events"].append(conflict)
        self.rejected(events, "WITHDRAWAL_EVENT_CONFLICT")

    def test_all_revocation_reasons_propagate(self):
        for reason in ["WITHDRAWN", "DELETED", "LICENSE_INVALIDATED"]:
            with self.subTest(reason=reason):
                result = m.propagate(self.bundle, self.events(reason=reason))
                self.assertEqual(len(result["invalid_sample_ids"]), 6)
                self.assertTrue(result["dataset_rebuild_required"])

    def test_stale_unknown_and_source_revision_evidence_rejected(self):
        for key, value, code in [("source_id", "missing", "WITHDRAWAL_SOURCE"),
                                 ("source_revision", "stale", "WITHDRAWAL_SOURCE_REVISION"),
                                 ("raw_snapshot_sha256", "0" * 64, "WITHDRAWAL_SOURCE_REVISION")]:
            with self.subTest(key=key):
                events = self.events()
                events["events"][0][key] = value
                self.rejected(events, code)
        events = self.events()
        events["baseline_sha256"] = "0" * 64
        self.rejected(events, "WITHDRAWAL_BASELINE")

    def test_missing_unknown_and_authority_fields_rejected(self):
        for key in self.events():
            events = self.events()
            del events[key]
            self.rejected(events, "WITHDRAWAL_SCHEMA")
        for key in self.events()["events"][0]:
            events = self.events()
            del events["events"][0][key]
            self.rejected(events, "WITHDRAWAL_SCHEMA")
        for key, value in [("reason", "RESTORED"), ("authority_effect", "ISSUED")]:
            events = self.events()
            if key == "reason":
                events["events"][0][key] = value
            else:
                events[key] = value
            self.rejected(events, "WITHDRAWAL_SCHEMA")
        events = self.events()
        events["extra"] = "ignored"
        self.rejected(events, "WITHDRAWAL_SCHEMA")

    def test_tampered_and_rehashed_impact_cannot_reopen_dataset(self):
        events = self.events()
        result = m.propagate(self.bundle, events)
        for key, value in [("invalid_sample_ids", []), ("dataset_rebuild_required", False),
                           ("dataset_status", "UNCHANGED_CANDIDATE"),
                           ("retained_sample_ids", ["forged-retained"]), ("training_or_data_use_authorized", True)]:
            changed = copy.deepcopy(result)
            changed[key] = value
            changed["report_sha256"] = m.digest({k: v for k, v in changed.items() if k != "report_sha256"})
            with self.assertRaisesRegex(m.FoundationError, "WITHDRAWAL_IMPACT_EVIDENCE"):
                m.validate_impact(self.bundle, events, changed)

    def test_invalid_parent_and_cycle_rejected_before_propagation(self):
        source = self.graph({"root": [], "child": ["root"]})
        root = self.bundle["manifest"]["samples"][-2]
        root["parent_sample_ids"] = ["child"]
        self.reseal()
        self.rejected(self.events(source), "LINEAGE_CYCLE")
        root["parent_sample_ids"] = ["missing"]
        self.reseal()
        self.rejected(self.events(source), "LINEAGE_PARENT")

    def test_deep_chain_is_iterative(self):
        source = self.graph({f"node-{i}": [f"node-{i-1}"] if i else [] for i in range(1100)})
        result = m.propagate(self.bundle, self.events(source))
        self.assertEqual(len(result["invalid_sample_ids"]), 1100)
        self.assertEqual(len(result["retained_sample_ids"]), 6)

    def test_withdrawn_baseline_still_rejected(self):
        self.bundle["registry"]["sources"][0]["withdrawn"] = True
        self.reseal()
        self.rejected(self.events(), "PRIVACY_OR_WITHDRAWAL")

    def test_cli_replay_and_unavailable_exit(self):
        first = subprocess.run([sys.executable, str(SCRIPT)], capture_output=True, text=True)
        self.assertEqual(first.returncode, 0, first.stderr)
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / "impact.json"
            report.write_text(first.stdout, encoding="utf-8")
            replay = subprocess.run([sys.executable, str(SCRIPT), "--impact", str(report)],
                                    capture_output=True, text=True)
            self.assertEqual(replay.returncode, 0, replay.stderr)
            self.assertEqual(replay.stdout, first.stdout)
        denied = subprocess.run([sys.executable, str(SCRIPT), "--require-available"],
                                capture_output=True, text=True)
        self.assertEqual(denied.returncode, 1)
        self.assertEqual(json.loads(denied.stdout)["error"], "CLUED_MODEL_M2_DATASET_UNAVAILABLE_WITHDRAWAL")

    def test_missing_events_file_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            denied = subprocess.run([sys.executable, str(SCRIPT), "--events", str(Path(directory)/"missing")],
                                    capture_output=True, text=True)
            self.assertEqual(denied.returncode, 1)
            self.assertEqual(json.loads(denied.stdout)["error"], "CLUED_MODEL_M2_INVALID_INPUT")


if __name__ == "__main__":
    unittest.main()
