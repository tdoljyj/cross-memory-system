import copy
import datetime as dt
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


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
                json.dumps({"canonical_id": PROJECT}), encoding="utf-8",
            )
        projects = {PROJECT: ["record"]} if indexed else {}
        (memory / "index.json").write_text(
            json.dumps({"by_scope": {"projects": projects}}), encoding="utf-8",
        )
        self.addCleanup(temporary.cleanup)
        return repo

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
        self.assertEqual(4, len(plan.sources_read))
        self.assertTrue(all(PROJECT in path.as_posix() for path in plan.paths))

    def test_f20_missing_index_route_falls_back_to_exact_authority_object(self):
        plan = self.plan(self.make_repo(indexed=False), project_id=PROJECT)
        self.assertEqual("index-rejected-exact-object-fallback", plan.reason)
        self.assertIn(f"memory/objects/projects/{PROJECT}.json", plan.sources_read)
        self.assertTrue(all(OTHER not in source for source in plan.sources_read))

    def test_f20_missing_target_blocks_even_if_index_claims_it(self):
        with self.assertRaisesRegex(P4ReadError, "INDEX_TARGET_MISSING"):
            self.plan(self.make_repo(make_target=False), project_id=PROJECT)

    def test_f20_invalid_index_blocks_without_directory_scan(self):
        repo = self.make_repo()
        (repo / "memory" / "index.json").write_text("not-json", encoding="utf-8")
        with self.assertRaisesRegex(P4ReadError, "INDEX_INVALID"):
            self.plan(repo, project_id=PROJECT)

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
        with self.assertRaisesRegex(P4ReadError, "T1_SELECTOR_INVALID"):
            self.plan(self.make_repo(), project_id="../../outside")

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
        self.assertEqual(4, len(payload["sources_read"]))
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
