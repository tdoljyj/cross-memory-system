import copy
import datetime as dt
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from canonical_read import (
    CanonicalAccessError,
    P4ReadError,
    canonical_first_read,
    compute_freshness,
    deterministic_t1_plan,
)


NOW = dt.datetime(2026, 8, 27, 12, 0, tzinfo=dt.timezone.utc)
PROJECT = "0597aa60-9b98-4da6-a4ab-63d7705b632f"
OTHER = "09c99505-7971-4bca-a885-632350b05139"
RECORD = "86fa71e8-3ab0-42e1-a24e-91ec473e70fc"


def canonical_payload():
    return {
        "source_kind": "canonical_live",
        "authoritative": True,
        "complete": True,
        "policy_id": "strict",
        "verified_at": "2026-08-27T11:55:00Z",
        "live_rechecked_at": "2026-08-27T11:50:00Z",
        "session_expires_at": "2026-08-27T13:00:00Z",
        "degraded_reason": None,
        "sources_read": ["canonical:records", "canonical:projects"],
        "source_versions": ["cv_156", "project:v3"],
        "source_conflicts": [],
        "views": {
            "state": {"current": "canonical-state"},
            "task": {"next": "canonical-task"},
            "decision": {"active": "canonical-decision"},
            "archive": [{"old": "archived"}],
            "log": [{"event": "old-event-says-different"}],
        },
        "field_versions": {
            "state": "state:v4", "task": "task:v5", "decision": "decision:v2",
            "archive": "archive:v8", "log": "log:v20",
        },
        "log_conflicts": ["log event differs from current state; current state retained"],
    }


def lkg_payload():
    value = canonical_payload()
    value.update({
        "source_kind": "snapshot_lkg",
        "authoritative": False,
        "policy_id": "degraded",
        "live_rechecked_at": "2026-08-27T11:50:00Z",
        "degraded_expires_at": "2026-08-27T12:10:00Z",
        "degraded_reason": "canonical-unavailable",
        "sources_read": ["mirror:manifest", "mirror:project-views"],
        "source_versions": ["snap_fixture", "cv_155", "generation:7"],
        "source_conflicts": [],
    })
    return value


class CanonicalFirstGates(unittest.TestCase):
    def test_f10_online_current_uses_canonical_without_lkg_or_git(self):
        calls = []

        def lkg():
            calls.append("lkg")
            raise AssertionError("LKG must not be read")

        result = canonical_first_read(lambda: canonical_payload(), lkg, trusted_now=NOW)
        self.assertEqual("authoritative-current", result["status"])
        self.assertTrue(result["authoritative"])
        self.assertEqual([], calls)
        self.assertEqual("canonical-state", result["current"]["state"]["current"])

    def test_f11_unavailable_uses_readonly_lkg_with_complete_envelope(self):
        def unavailable():
            raise CanonicalAccessError("UNAVAILABLE", "transport offline")

        result = canonical_first_read(unavailable, lambda: lkg_payload(), trusted_now=NOW)
        self.assertEqual("degraded-read-only", result["status"])
        self.assertFalse(result["authoritative"])
        self.assertEqual("UNAVAILABLE", result["fallback_trigger"])
        self.assertEqual("canonical-unavailable", result["degraded_reason"])
        self.assertGreater(result["freshness"]["stale_age_seconds"], 0)
        self.assertEqual(3, len(result["source_versions"]))

    def test_f12_auth_scope_binding_and_owner_fail_without_lkg(self):
        for code in ("AUTH_FAILED", "SCOPE_DENIED", "BINDING_INVALID", "OWNER_MISMATCH"):
            with self.subTest(code=code):
                lkg_calls = []

                def denied():
                    raise CanonicalAccessError(code, "classified denial")

                with self.assertRaisesRegex(CanonicalAccessError, code):
                    canonical_first_read(denied, lambda: lkg_calls.append(True), trusted_now=NOW)
                self.assertEqual([], lkg_calls)

    def test_f13_each_policy_has_exact_ttl(self):
        for policy, seconds in (("strict", 3600), ("balanced", 21600), ("degraded", 1800)):
            with self.subTest(policy=policy):
                live = NOW - dt.timedelta(seconds=seconds - 1)
                args = dict(
                    policy_id=policy, trusted_now=NOW,
                    verified_at="2026-08-27T11:59:00Z", live_rechecked_at=live.isoformat(),
                    session_expires_at="2026-08-28T12:00:00Z",
                    degraded=policy == "degraded",
                )
                if policy == "degraded":
                    args["degraded_expires_at"] = "2026-08-27T12:05:00Z"
                self.assertEqual(policy, compute_freshness(**args).policy_id)

    def test_f13_each_policy_expires_and_unknown_fails_closed(self):
        for policy, seconds in (("strict", 3600), ("balanced", 21600), ("degraded", 1800)):
            with self.subTest(policy=policy):
                live = NOW - dt.timedelta(seconds=seconds)
                args = dict(
                    policy_id=policy, trusted_now=NOW,
                    verified_at="2026-08-27T11:59:00Z", live_rechecked_at=live.isoformat(),
                    session_expires_at="2026-08-28T12:00:00Z", degraded=policy == "degraded",
                )
                if policy == "degraded":
                    args["degraded_expires_at"] = "2026-08-27T12:05:00Z"
                with self.assertRaisesRegex(P4ReadError, "SOURCE_EXPIRED"):
                    compute_freshness(**args)
        with self.assertRaisesRegex(P4ReadError, "FRESHNESS_POLICY_UNKNOWN"):
            compute_freshness(
                policy_id="custom-7h", trusted_now=NOW,
                verified_at="2026-08-27T11:59:00Z", live_rechecked_at="2026-08-27T11:59:00Z",
                session_expires_at="2026-08-27T13:00:00Z",
            )

    def test_f14_session_expiry_wins(self):
        decision = compute_freshness(
            policy_id="balanced", trusted_now=NOW,
            verified_at="2026-08-27T11:59:00Z", live_rechecked_at="2026-08-27T11:59:00Z",
            session_expires_at="2026-08-27T12:01:00Z",
        )
        self.assertEqual("2026-08-27T12:01:00Z", decision.effective_expires_at)
        with self.assertRaisesRegex(P4ReadError, "SOURCE_EXPIRED"):
            compute_freshness(
                policy_id="balanced", trusted_now=NOW,
                verified_at="2026-08-27T11:59:00Z", live_rechecked_at="2026-08-27T11:59:00Z",
                session_expires_at="2026-08-27T12:00:00Z",
            )

    def test_u02_u03_log_is_evidence_and_cannot_override_current(self):
        result = canonical_first_read(lambda: canonical_payload(), lambda: None, trusted_now=NOW)
        self.assertEqual("canonical-state", result["current"]["state"]["current"])
        self.assertEqual("old-event-says-different", result["log_event_evidence"][0]["event"])
        self.assertIn("current state retained", result["log_conflicts"][0])
        self.assertNotIn("log", result["current"])

    def test_u05_sources_and_specific_versions_are_mandatory(self):
        for key in ("sources_read", "source_versions"):
            with self.subTest(key=key):
                value = canonical_payload()
                value[key] = []
                with self.assertRaisesRegex(P4ReadError, "SOURCE_ENVELOPE_INCOMPLETE"):
                    canonical_first_read(lambda: value, lambda: None, trusted_now=NOW)

    def test_incomplete_source_does_not_fall_back(self):
        value = canonical_payload()
        value["complete"] = False
        lkg_calls = []
        with self.assertRaisesRegex(P4ReadError, "SOURCE_ENVELOPE_INCOMPLETE"):
            canonical_first_read(lambda: value, lambda: lkg_calls.append(True), trusted_now=NOW)
        self.assertEqual([], lkg_calls)

    def test_conflicting_current_sources_fail_closed(self):
        value = canonical_payload()
        value["source_conflicts"] = ["record version mismatch"]
        with self.assertRaisesRegex(P4ReadError, "SOURCE_CONFLICT"):
            canonical_first_read(lambda: value, lambda: None, trusted_now=NOW)

    def test_lkg_false_authoritative_claim_is_rejected(self):
        value = lkg_payload()
        value["authoritative"] = True

        def unavailable():
            raise CanonicalAccessError("UNAVAILABLE", "offline")

        with self.assertRaisesRegex(P4ReadError, "INVALID_AUTHORITY_CLAIM"):
            canonical_first_read(unavailable, lambda: value, trusted_now=NOW)

    def test_future_source_time_and_untrusted_clock_fail_closed(self):
        with self.assertRaisesRegex(P4ReadError, "CLOCK_UNTRUSTED"):
            compute_freshness(
                policy_id="strict", trusted_now=NOW,
                verified_at="2026-08-27T12:01:00Z", live_rechecked_at="2026-08-27T11:59:00Z",
                session_expires_at="2026-08-27T13:00:00Z",
            )
        with self.assertRaisesRegex(P4ReadError, "CLOCK_UNTRUSTED"):
            compute_freshness(
                policy_id="strict", trusted_now=NOW.replace(tzinfo=None),
                verified_at="2026-08-27T11:59:00Z", live_rechecked_at="2026-08-27T11:59:00Z",
                session_expires_at="2026-08-27T13:00:00Z",
            )


class DeterministicT1Gates(unittest.TestCase):
    def make_repo(self, *, indexed=True, make_target=True, make_object=True):
        temporary = tempfile.TemporaryDirectory()
        repo = Path(temporary.name)
        memory = repo / "memory"
        (memory / "global").mkdir(parents=True)
        (memory / "objects" / "projects").mkdir(parents=True)
        (memory / "objects" / "records").mkdir(parents=True)
        (memory / "profile.md").write_text("profile preference", encoding="utf-8")
        for name in ("state.md", "task.md", "decision.md"):
            (memory / "global" / name).write_text(f"global {name}", encoding="utf-8")
        if make_target:
            project = memory / "projects" / PROJECT
            project.mkdir(parents=True)
            for name in ("state.md", "task.md", "decision.md", "archive.md", "log.md"):
                (project / name).write_text(f"project {name}", encoding="utf-8")
        if make_object:
            (memory / "objects" / "projects" / f"{PROJECT}.json").write_text(
                json.dumps({
                    "schema_version": 1,
                    "snapshot_version": "snap_fixture",
                    "canonical_version": "cv_fixture",
                    "kind": "project",
                    "canonical_id": PROJECT,
                    "data": {
                        "canonical_project_id": PROJECT,
                        "name": "fixture project",
                        "aliases": [],
                        "certainty_status": "confirmed",
                        "progress_status": "active",
                        "lifecycle_status": "active",
                        "merge_generation": 0,
                        "merged_into_project_id": None,
                        "project_schema_version": 1,
                        "version": 1,
                        "closed_at": None,
                        "closed_reason": None,
                        "closure_summary": None,
                        "receipt_id": None,
                        "recorded_at": "2026-08-27T00:00:00Z",
                        "updated_at": "2026-08-27T00:00:00Z",
                    },
                }), encoding="utf-8",
            )
        (memory / "objects" / "records" / f"{RECORD}.json").write_text(
            json.dumps({"kind": "record", "canonical_id": RECORD}), encoding="utf-8",
        )
        projects = {PROJECT: [RECORD]} if indexed else {}
        (memory / "index.json").write_text(
            json.dumps({
                "schema_version": 1,
                "snapshot_version": "snap_fixture",
                "by_scope": {"projects": projects},
                "by_id": {
                    RECORD: {
                        "kind": "record",
                        "effective_scope": f"project:{PROJECT}",
                        "lifecycle_status": "active",
                        "path": f"objects/records/{RECORD}.json",
                    },
                },
            }), encoding="utf-8",
        )
        self.addCleanup(temporary.cleanup)
        return repo

    @staticmethod
    def update_json(path, update):
        value = json.loads(path.read_text(encoding="utf-8"))
        update(value)
        path.write_text(json.dumps(value), encoding="utf-8")

    def assert_fails_before_project_views(self, repo, code):
        original = Path.read_text
        reads = []

        def tracked(path, *args, **kwargs):
            reads.append(path.as_posix())
            return original(path, *args, **kwargs)

        with mock.patch.object(Path, "read_text", tracked):
            with self.assertRaisesRegex(P4ReadError, code):
                self.plan(repo, project_id=PROJECT)
        self.assertFalse(any(f"memory/projects/{PROJECT}/" in path for path in reads), reads)
        self.assertFalse(any(f"memory/projects/{OTHER}/" in path for path in reads), reads)
        return reads

    def plan(self, repo, query="Clued", project_id=None, history=False):
        return deterministic_t1_plan(
            repo, query=query, project_id=project_id, history=history,
            snapshot_version="snap_fixture", canonical_version="cv_fixture",
        )

    def test_f20_valid_index_routes_exact_project_std(self):
        plan = self.plan(self.make_repo(), project_id=PROJECT)
        self.assertEqual("T1", plan.access_tier)
        self.assertEqual("unique-canonical-project-route", plan.reason)
        self.assertEqual(3, len(plan.paths))
        self.assertEqual(5, len(plan.sources_read))
        self.assertEqual(f"memory/objects/projects/{PROJECT}.json", plan.sources_read[0])
        self.assertTrue(all(PROJECT in path.as_posix() for path in plan.paths))

    def test_f20_missing_index_route_falls_back_to_exact_authority_object(self):
        plan = self.plan(self.make_repo(indexed=False), project_id=PROJECT)
        self.assertEqual("index-rejected-exact-object-fallback", plan.reason)
        self.assertIn(f"memory/objects/projects/{PROJECT}.json", plan.sources_read)
        self.assertTrue(all(OTHER not in source for source in plan.sources_read))

    def test_f20_index_hit_missing_object_blocks_before_stale_views(self):
        repo = self.make_repo(make_object=False)
        self.assert_fails_before_project_views(repo, "PROJECT_OBJECT_INVALID")

    def test_f20_missing_target_blocks_even_if_index_claims_it(self):
        with self.assertRaisesRegex(P4ReadError, "T1_TARGET_INCOMPLETE"):
            self.plan(self.make_repo(make_target=False), project_id=PROJECT)

    def test_f20_invalid_index_falls_back_only_after_exact_object_validation(self):
        repo = self.make_repo()
        (repo / "memory" / "index.json").write_text("not-json", encoding="utf-8")
        plan = self.plan(repo, project_id=PROJECT)
        self.assertEqual("index-rejected-exact-object-fallback", plan.reason)

    def test_f20_project_object_identity_kind_and_lifecycle_fail_closed(self):
        cases = (
            ("canonical_id", lambda value: value.__setitem__("canonical_id", OTHER), "PROJECT_OBJECT_IDENTITY_MISMATCH"),
            ("canonical_project_id", lambda value: value["data"].__setitem__("canonical_project_id", OTHER), "PROJECT_OBJECT_IDENTITY_MISMATCH"),
            ("kind", lambda value: value.__setitem__("kind", "record"), "PROJECT_OBJECT_KIND_INVALID"),
            ("lifecycle", lambda value: value["data"].__setitem__("lifecycle_status", "merged"), "PROJECT_OBJECT_LIFECYCLE_INVALID"),
        )
        for name, update, code in cases:
            with self.subTest(name=name):
                repo = self.make_repo()
                self.update_json(repo / "memory" / "objects" / "projects" / f"{PROJECT}.json", update)
                reads = self.assert_fails_before_project_views(repo, code)
                self.assertFalse(any(path.endswith("memory/index.json") for path in reads), reads)

    def test_f20_corrupt_or_incomplete_project_object_fails_closed(self):
        repo = self.make_repo()
        object_path = repo / "memory" / "objects" / "projects" / f"{PROJECT}.json"
        object_path.write_text("not-json", encoding="utf-8")
        reads = self.assert_fails_before_project_views(repo, "PROJECT_OBJECT_INVALID")
        self.assertFalse(any(path.endswith("memory/index.json") for path in reads), reads)

        repo = self.make_repo()
        object_path = repo / "memory" / "objects" / "projects" / f"{PROJECT}.json"
        self.update_json(object_path, lambda value: value["data"].pop("merged_into_project_id"))
        reads = self.assert_fails_before_project_views(repo, "PROJECT_OBJECT_INVALID")
        self.assertFalse(any(path.endswith("memory/index.json") for path in reads), reads)

    def test_f20_project_object_snapshot_and_canonical_versions_must_match_request(self):
        for field in ("snapshot_version", "canonical_version"):
            with self.subTest(field=field):
                repo = self.make_repo()
                self.update_json(
                    repo / "memory" / "objects" / "projects" / f"{PROJECT}.json",
                    lambda value, field=field: value.__setitem__(field, "stale"),
                )
                reads = self.assert_fails_before_project_views(repo, "PROJECT_OBJECT_VERSION_MISMATCH")
                self.assertFalse(any(path.endswith("memory/index.json") for path in reads), reads)

    def test_f20_index_missing_record_id_rejected_to_exact_object_fallback(self):
        repo = self.make_repo()
        self.update_json(repo / "memory" / "index.json", lambda value: value["by_id"].clear())
        self.assertEqual("index-rejected-exact-object-fallback", self.plan(repo, project_id=PROJECT).reason)

    def test_f20_index_route_must_be_record_id_list_not_arbitrary_string(self):
        repo = self.make_repo()
        self.update_json(
            repo / "memory" / "index.json",
            lambda value: value["by_scope"]["projects"].__setitem__(PROJECT, "truthy-not-a-route"),
        )
        self.assertEqual("index-rejected-exact-object-fallback", self.plan(repo, project_id=PROJECT).reason)

    def test_f20_index_record_scope_conflict_rejected_to_exact_object_fallback(self):
        repo = self.make_repo()
        self.update_json(
            repo / "memory" / "index.json",
            lambda value: value["by_id"][RECORD].__setitem__("effective_scope", f"project:{OTHER}"),
        )
        self.assertEqual("index-rejected-exact-object-fallback", self.plan(repo, project_id=PROJECT).reason)

    def test_f20_index_record_path_escape_and_type_rejected_to_exact_object_fallback(self):
        for bad_path in (f"objects/projects/{PROJECT}.json", ["objects", "records", RECORD]):
            with self.subTest(path=bad_path):
                repo = self.make_repo()
                self.update_json(
                    repo / "memory" / "index.json",
                    lambda value, bad_path=bad_path: value["by_id"][RECORD].__setitem__("path", bad_path),
                )
                self.assertEqual("index-rejected-exact-object-fallback", self.plan(repo, project_id=PROJECT).reason)

    def test_f20_index_record_target_missing_rejected_to_exact_object_fallback(self):
        repo = self.make_repo()
        (repo / "memory" / "objects" / "records" / f"{RECORD}.json").unlink()
        self.assertEqual("index-rejected-exact-object-fallback", self.plan(repo, project_id=PROJECT).reason)

    def test_f21_query_canonical_id_is_unique_exact_selector(self):
        plan = self.plan(self.make_repo(), query=f"current {PROJECT}")
        self.assertEqual(PROJECT, plan.project_id)
        self.assertEqual("query-canonical-id", plan.selector)

    def test_f21_profile_trigger_reads_only_index_and_profile(self):
        plan = self.plan(self.make_repo(), query="我的工作偏好")
        self.assertEqual(("memory/index.json", "memory/profile.md"), plan.sources_read)
        self.assertEqual("unique-profile-trigger", plan.reason)

    def test_f21_zero_match_degrades_to_t3_global_std(self):
        plan = self.plan(self.make_repo(), query="an unrelated selector")
        self.assertEqual("T3", plan.access_tier)
        self.assertEqual("t1-zero-match-global-std", plan.reason)
        self.assertEqual(4, len(plan.sources_read))
        self.assertFalse(any("memory/projects/" in source for source in plan.sources_read))

    def test_f21_conflicting_or_ambiguous_selectors_are_rejected(self):
        repo = self.make_repo()
        with self.assertRaisesRegex(P4ReadError, "T1_SELECTOR_CONFLICT"):
            self.plan(repo, query=f"{OTHER}", project_id=PROJECT)
        with self.assertRaisesRegex(P4ReadError, "T1_SELECTOR_AMBIGUOUS"):
            self.plan(repo, query=f"{PROJECT} and {OTHER}")

    def test_f21_invalid_explicit_selector_is_rejected_before_path_access(self):
        repo = self.make_repo()
        original = Path.read_text
        reads = []

        def tracked(path, *args, **kwargs):
            reads.append(path.as_posix())
            return original(path, *args, **kwargs)

        with mock.patch.object(Path, "read_text", tracked):
            with self.assertRaisesRegex(P4ReadError, "T1_SELECTOR_INVALID"):
                self.plan(repo, project_id="../../outside")
            with self.assertRaisesRegex(P4ReadError, "T1_SELECTOR_INVALID"):
                self.plan(repo, query="project 0597aa6z-9b98-4da6-a4ab-63d7705b632f")
        self.assertEqual([], reads)

    def test_history_expansion_is_explicit_and_keeps_field_boundaries(self):
        normal = self.plan(self.make_repo(), project_id=PROJECT)
        expanded = self.plan(self.make_repo(), project_id=PROJECT, history=True)
        self.assertIsNone(normal.expansion_reason)
        self.assertEqual("history-explicitly-requested", expanded.expansion_reason)
        self.assertEqual(["archive.md", "log.md"], [p.name for p in expanded.paths[-2:]])

    def run_cli(self, *args):
        return subprocess.run(
            [sys.executable, str(ROOT / "memory.py"), *args], cwd=ROOT,
            text=True, encoding="utf-8", capture_output=True,
        )

    def test_cli_t1_exact_sources_versions_and_semantic_off(self):
        result = self.run_cli("recall", "Clued current", "--tier", "T1", "--project-id", PROJECT)
        self.assertEqual(0, result.returncode, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual("T1", payload["tier"])
        self.assertEqual(5, len(payload["sources_read"]))
        self.assertIn(f"memory/objects/projects/{PROJECT}.json", payload["sources_read"])
        self.assertEqual(2, len(payload["source_versions"]))
        self.assertEqual("disabled", payload["routing"]["semantic_recall"])

    def test_cli_t1_zero_match_never_scans_projects(self):
        result = self.run_cli("recall", "definitely-no-project-selector", "--tier", "T1")
        self.assertEqual(0, result.returncode, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual("T3", payload["tier"])
        self.assertFalse(any("memory/projects/" in source for source in payload["sources_read"]))


if __name__ == "__main__":
    unittest.main()
