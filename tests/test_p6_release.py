import hashlib
import json
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BASELINE = "59ce5224b18bad502184a26e8c00f9e51521e41e"
APP = ROOT / "apps" / "clued-cloud"

ALLOWED_EXACT = {
    "apps/clued-cloud/scripts/two-level-snapshot.mjs",
    "apps/clued-cloud/scripts/m2-snapshot-store.mjs",
    "apps/clued-cloud/tests/two-level-snapshot.test.mjs",
    "apps/clued-cloud/worker/records.ts",
    "apps/clued-cloud/worker/continuity.ts",
    "apps/clued-cloud/worker-env.d.ts",
    "apps/clued-cloud/package.json",
    "apps/clued-cloud/worker/p6.ts",
    "apps/clued-cloud/scripts/p6-shadow-canary.mjs",
    "apps/clued-cloud/tests/p6-shadow-canary.test.mjs",
    "tests/test_p6_release.py",
    "docs/execution-plans/Clued_P6_Shadow_Canary_Publish_Rollback_Runbook_v1.0.md",
    "docs/execution-plans/Clued_P6_Low_Cost_Shadow_Canary_Contract_v2.0.md",
    "docs/execution-plans/Clued_P6_Low_Cost_Shadow_Canary_Contract_v3.0.md",
}
ALLOWED_PREFIXES = ("artifacts/clued-validation/p6/",)
FORBIDDEN_PREFIXES = (
    "memory/",
    "artifacts/clued-validation/p5/",
    "artifacts/clued-two-level-snapshots/published/",
    "apps/clued-cloud/supabase/migrations/",
)
FORBIDDEN_EXACT = {
    "VERSION",
    ".openai/hosting.json",
    "artifacts/clued-two-level-snapshots/current.json",
}


def git(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-c", "core.longpaths=true", *args], cwd=ROOT,
        text=True, encoding="utf-8", capture_output=True, check=check,
    )


def changed_paths() -> set[str]:
    tracked = git("diff", "--name-only", BASELINE, "--").stdout.splitlines()
    untracked = git("ls-files", "--others", "--exclude-standard").stdout.splitlines()
    return {item.replace("\\", "/") for item in (*tracked, *untracked) if item}


class P6ReleaseGate(unittest.TestCase):
    def test_fixed_baseline_is_ancestor_and_candidate_has_no_merge_commit(self):
        self.assertEqual(0, git("merge-base", "--is-ancestor", BASELINE, "HEAD", check=False).returncode)
        self.assertEqual("", git("rev-list", "--merges", f"{BASELINE}..HEAD").stdout.strip())
        self.assertEqual(0, git("diff", "--check", BASELINE, "--").returncode)

    def test_changes_remain_inside_frozen_p6_allowlist(self):
        changes = changed_paths()
        self.assertTrue(changes, "P6 candidate must contain implementation changes")
        unexpected = sorted(path for path in changes if path not in ALLOWED_EXACT and not path.startswith(ALLOWED_PREFIXES))
        self.assertEqual([], unexpected)

    def test_forbidden_files_migrations_and_frozen_p5_evidence_are_unchanged(self):
        changes = changed_paths()
        forbidden = sorted(
            path for path in changes
            if path in FORBIDDEN_EXACT or path.startswith(FORBIDDEN_PREFIXES)
        )
        self.assertEqual([], forbidden)
        self.assertFalse(any(path.endswith("wrangler.jsonc") for path in changes))
        self.assertFalse(any("semantic" in path.casefold() and path.startswith("memory/") for path in changes))

    def test_basic_snapshot_cli_cannot_activate_or_rollback_without_cas(self):
        source = (APP / "scripts" / "two-level-snapshot.mjs").read_text(encoding="utf-8")
        self.assertIn('throw new Error("expected_current_required")', source)
        self.assertIn('operation: activate ? "publish_activate" : "publish_offline"', source)
        self.assertIn('operation: "rollback"', source)
        self.assertIn('if (activate && actualCurrent !== expectedCurrentSnapshotVersion)', source)
        self.assertIn('current.snapshot_version !== expectedCurrentSnapshotVersion', source)
        self.assertIn("readFormalSnapshot", source)
        self.assertIn("restorePointer", source)
        self.assertIn("pointer_directory_sync", source)
        self.assertIn("post_switch_audit", source)

    def test_m2_publish_and_rollback_share_cas_reconcile_contract(self):
        source = (APP / "scripts" / "m2-snapshot-store.mjs").read_text(encoding="utf-8")
        self.assertIn("coordinatedPublishSnapshot", source)
        self.assertIn("coordinatedRollbackSnapshot", source)
        self.assertIn("expectedCurrentSnapshotVersion", source)
        self.assertIn("post_publish_reconcile_failed", source)
        self.assertIn("post_rollback_reconcile_failed", source)
        self.assertIn("afterRecovery", source)

    def test_shadow_canary_affinity_and_version_attribution_are_fail_closed(self):
        shadow = (APP / "scripts" / "p6-shadow-canary.mjs").read_text(encoding="utf-8")
        worker = (APP / "worker" / "p6.ts").read_text(encoding="utf-8")
        for token in (
            "OLD_REJECT_NEW_ACCEPT", "AUTHORITY_OR_SCOPE_DIFFERENCE",
            "CANONICAL_ID_DIFFERENCE", "CANONICAL_VERSION_DIFFERENCE",
            "SOURCES_READ_REDUCED", "REJECTION_AUDIT_REDUCED",
            "BUSINESS_RESULT_DIFFERENCE", "UNCLASSIFIED_SEMANTIC_DIFFERENCE",
        ):
            self.assertIn(token, shadow)
        for token in (
            "AUTO_ROLLBACK", "TWO_CONSECUTIVE_SEVERE_WINDOWS",
            "Cloudflare-Workers-Version-Key", "CF_VERSION_METADATA",
            "version_timestamp", "production_enabled",
        ):
            self.assertIn(token, worker if token != "production_enabled" else (APP / "worker" / "continuity.ts").read_text(encoding="utf-8"))
        self.assertNotIn("Math.random", worker)
        self.assertNotIn("as unknown as", worker)

    def test_publication_lock_uses_trusted_time_and_owner_token(self):
        snapshot = (APP / "scripts" / "two-level-snapshot.mjs").read_text(encoding="utf-8")
        store = (APP / "scripts" / "m2-snapshot-store.mjs").read_text(encoding="utf-8")
        for token in (
            "randomUUID", "owner_token", "Date.now()", "requested_at",
            "releaseSnapshotPublicationLock", "transitionLock",
            "withPublicationLockTransition", "publication_lock_transition_busy",
        ):
            self.assertIn(token, snapshot)
        self.assertNotIn("removePublicationLockIfUnchanged", snapshot)
        self.assertNotIn("Date.parse(occurredAt) - lockStat.mtimeMs", snapshot)
        self.assertNotIn("Date.parse(now) - lockStat.mtimeMs", store)
        self.assertIn("withSnapshotPublicationLock", store)

    def test_f26_contract_keeps_current_views_above_log(self):
        records = (APP / "worker" / "records.ts").read_text(encoding="utf-8")
        self.assertIn('current_fields: ["state", "task", "decision"]', records)
        self.assertIn('log_role: "historical_event_evidence_only"', records)
        self.assertIn('behavior: "retain_current_and_report_log_conflicts"', records)
        self.assertIn("silent_merge: false", records)

    def test_all_f01_f32_ids_have_executable_test_coverage(self):
        test_sources = "\n".join(
            path.read_text(encoding="utf-8")
            for root in (ROOT / "tests", APP / "tests")
            for path in root.rglob("*")
            if path.suffix in {".py", ".mjs"}
        ).casefold()
        missing = [f"F{number:02d}" for number in range(1, 33) if f"f{number:02d}" not in test_sources]
        self.assertEqual([], missing)

    def test_p5_sha256sums_still_match_every_frozen_jsonl(self):
        directory = ROOT / "artifacts" / "clued-validation" / "p5" / "8327b6b0"
        rows = (directory / "SHA256SUMS").read_text(encoding="utf-8").splitlines()
        self.assertEqual(11, len(rows))
        for row in rows:
            expected, name = row.split("  ", 1)
            actual = hashlib.sha256((directory / name).read_bytes()).hexdigest()
            self.assertEqual(expected, actual, name)

    def test_no_production_target_or_secret_is_embedded_in_new_p6_files(self):
        paths = [
            APP / "worker" / "p6.ts",
            APP / "scripts" / "p6-shadow-canary.mjs",
            APP / "tests" / "p6-shadow-canary.test.mjs",
        ]
        content = "\n".join(path.read_text(encoding="utf-8") for path in paths)
        for forbidden in (
            "clued.pixelgrav.com", "api.cloudflare.com/client/v4", "supabase.co",
            "wrangler versions upload", "supabase link", "supabase db push",
        ):
            self.assertNotIn(forbidden, content)
        self.assertNotRegex(content, r"\b(?:ghp_|gho_|github_pat_|AKIA)[A-Za-z0-9_]{12,}")

    def test_package_scripts_are_local_only_and_lockfile_is_unchanged(self):
        package = json.loads((APP / "package.json").read_text(encoding="utf-8"))
        self.assertEqual("node --test tests/p6-shadow-canary.test.mjs", package["scripts"]["test:p6"])
        self.assertIn("verify-evidence", package["scripts"]["p6:evidence:verify"])
        self.assertNotIn("apps/clued-cloud/package-lock.json", changed_paths())

    def test_p6_evidence_hashes_match_when_evidence_is_present(self):
        directory = ROOT / "artifacts" / "clued-validation" / "p6" / "59ce5224-r4"
        if not directory.exists():
            self.skipTest("evidence is generated after implementation tests")
        rows = (directory / "SHA256SUMS").read_text(encoding="utf-8").splitlines()
        self.assertGreaterEqual(len(rows), 7)
        for row in rows:
            expected, name = row.split("  ", 1)
            self.assertEqual(expected, hashlib.sha256((directory / name).read_bytes()).hexdigest(), name)


if __name__ == "__main__":
    unittest.main()
