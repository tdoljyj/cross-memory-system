"""Isolated structural/predicate tests using synthetic API responses, NOT real signatures/CI.

No fixture mode is exposed by publication.py CLI. These tests do not prove actual
GitHub permission denial, local cryptographic signature validation or Step18.
"""
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import zipfile

MODULE = Path(__file__).resolve().parents[1] / "scripts/naming-governance/publication.py"
spec = importlib.util.spec_from_file_location("phase2_publication_under_test", MODULE)
pub = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = pub
spec.loader.exec_module(pub)


class FixtureAPI:
    provenance = "SYNTHETIC_UNIT_TEST_FIXTURE_NOT_PLATFORM_EVIDENCE"

    def __init__(self):
        self.responses = {}
        self.downloads = {}
        self.calls = []

    def get(self, endpoint):
        self.calls.append(endpoint)
        pub.need(endpoint in self.responses, "fixture missing endpoint: " + endpoint)
        return copy.deepcopy(self.responses[endpoint])

    def download(self, endpoint):
        self.calls.append(endpoint)
        pub.need(endpoint in self.downloads, "fixture missing download")
        return self.downloads[endpoint]


class World:
    def __init__(self):
        self.api = FixtureAPI()
        self.repo = "fixture-owner/fixture-private"
        self.base = "/repos/" + self.repo
        self.source = "a" * 40
        self.attestation = "b" * 40
        self.tree = "d" * 40
        self.subject_sha = "c" * 64
        self.selector = {"attestation_commit": self.attestation, "publication_pr": 12}
        self.p = {
            "contract": pub.POLICY_CONTRACT, "repository": self.repo,
            "publication_validator_sha256": pub.digest(MODULE.read_bytes()),
            "source_commit": self.source, "subject": {"id": "FIXTURE_SUBJECT", "sha256": self.subject_sha},
            "candidate_package": {"sha256": "9" * 64, "bytes": 1234, "members": 5},
            "sequence": 1, "publisher_actor": "fixture-owner", "publisher_base_ref": "main",
            "statement_path": "docs/PublicationStatement.json",
            "payloads": {pub.SOURCE_INDEX: self.add_blob(pub.SOURCE_INDEX, b'{"fixture":"index"}\n')},
            "naming_bindings_sha256": "1" * 64,
            "naming_validator_sha256": pub.digest(b"fixture naming validator"),
            "workflows": {},
            "additional_required_runs": {},
        }
        for key, status in (("acceptance", "ACCEPTED"), ("freeze", "FROZEN")):
            path = "docs/" + key + ".json"
            data = pub.canonical({"status": status, "subject_sha256": self.subject_sha})
            self.p[key] = {"path": path, "sha256": self.add_blob(path, data),
                           "assertions": {"/status": status}, "subject_pointer": "/subject_sha256"}
        for role, wid in (("four_gates", 41), ("naming", 42)):
            path = ".github/workflows/" + role + ".yml"
            code = ("fixture workflow " + role).encode()
            source_path = "scripts/" + role + ".py"
            source_data = ("fixture " + role + " validator").encode()
            self.p["workflows"][role] = {
                "id": wid, "path": path, "sha256": self.add_blob(path, code),
                "trusted_sources": {source_path: self.add_blob(source_path, source_data)},
                "receipt_path": "Receipt.json", "execution_path": "Execution.json",
                "job_name": "Validate", "step_name": role,
            }
        self.api.responses[self.base] = {"full_name": self.repo, "private": True,
                                        "owner": {"login": "fixture-owner", "type": "User"}}
        self.api.responses[self.base + "/collaborators?per_page=100"] = [
            {"login": "fixture-owner", "permissions": {"admin": True, "push": True}}]
        self.api.responses[self.base + "/commits/" + self.attestation] = {
            "sha": self.attestation,
            "committer": {"login": "web-flow"},
            "parents": [{"sha": self.source}, {"sha": "e" * 40}],
            "commit": {"tree": {"sha": self.tree}, "verification": {
                "verified": True, "reason": "valid",
                "signature": "-----BEGIN PGP SIGNATURE-----\nSYNTHETIC_FIXTURE\n-----END PGP SIGNATURE-----",
                "payload": "tree " + self.tree + "\nparent " + self.source + "\nparent " +
                           "e" * 40 + "\n\nSynthetic remote assertion, not real GPG evidence\n",
            }},
        }
        self.api.responses[self.base + "/pulls/12"] = {
            "merged": True, "merge_commit_sha": self.attestation,
            "merged_by": {"login": "fixture-owner"},
            "base": {"ref": "main", "repo": {"full_name": self.repo}},
        }
        self.receipts = {
            "four_gates": {
                "schema": "clued.phase2-v027-ci-gate-receipt/v1", "repository": self.repo,
                "commit_sha": self.source, "run_id": "51", "run_attempt": "1", "overall": "PASS",
                "workflow_ref": self.repo + "/.github/workflows/four_gates.yml@refs/heads/fixture-branch",
                "gates": {gate: {"status": "PASS"} for gate in pub.GATES},
            },
            "naming": {
                "format": "STEP8_BOUNDED_VALIDATION_RECEIPT", "status": "SCOPED_EVIDENCE_PASS",
                "exit_code": 0, "fixture_only": False, "errors": [],
                "subject": {"sha256": self.p["naming_bindings_sha256"]},
                "validator_sha256": self.p["naming_validator_sha256"],
                "checks": [{"rule": rule, "status": "PASS"} for rule in pub.NAMING_RULES],
            },
        }
        self.execution = {}
        self.receipts["four_gates"]["gates"]["candidate_identity"]["details"] = copy.deepcopy(self.p["candidate_package"])
        self.statement = {
            "contract": pub.CONTRACT, **{key: copy.deepcopy(self.p[key]) for key in
                                        ("repository", "source_commit", "subject", "candidate_package", "payloads", "sequence")},
            "acceptance_sha256": self.p["acceptance"]["sha256"],
            "freeze_sha256": self.p["freeze"]["sha256"], "evidence": {}, "additional_required_runs": {},
        }
        for role, run_id, aid in (("four_gates", 51, 61), ("naming", 52, 62)):
            self.execution[role] = {
                "contract": pub.EXECUTION_CONTRACT, "repository": self.repo, "source_commit": self.source,
                "workflow_ref": self.repo + "/" + self.p["workflows"][role]["path"] + "@refs/heads/fixture-branch",
                "workflow_sha": self.source,
                "run_id": str(run_id), "run_attempt": "1", "negative_case": "none",
            }
            self.api.responses[self.base + f"/actions/runs/{run_id}/attempts/1"] = {
                "id": run_id, "run_attempt": 1, "repository": {"full_name": self.repo},
                "head_repository": {"full_name": self.repo}, "head_sha": self.source,
                "workflow_id": self.p["workflows"][role]["id"], "path": self.p["workflows"][role]["path"],
                "status": "completed", "conclusion": "success",
                "event": "workflow_dispatch", "head_branch": "fixture-branch",
                "run_started_at": "2026-09-07T01:00:00Z", "updated_at": "2026-09-07T01:02:00Z",
            }
            self.statement["evidence"][role] = {"run_id": run_id, "attempt": 1, "artifact_id": aid}
            start, end = (("01:01:00", "01:01:30") if role == "four_gates" else ("01:00:10", "01:00:30"))
            self.api.responses[self.base + f"/actions/runs/{run_id}/attempts/1/jobs?per_page=100"] = {
                "total_count": 1, "jobs": [{"name": "Validate", "run_id": run_id,
                    "status": "completed", "conclusion": "success", "steps": [
                        {"name": role, "status": "completed", "conclusion": "success",
                         "started_at": "2026-09-07T" + start + "Z", "completed_at": "2026-09-07T" + end + "Z"}]}],
            }
            self.refresh_bundle(role)
        for i, name in enumerate(sorted(pub.BASE_CORE)):
            wid, run_id, check_id, suite_id = 101 + i, 201 + i, 301 + i, 401 + i
            path = ".github/workflows/" + name + ".yml"
            source_path = "scripts/" + name + ".mjs"
            self.p["additional_required_runs"][name] = {
                "id": wid, "path": path, "sha256": self.add_blob(path, ("workflow " + name).encode()),
                "trusted_sources": {source_path: self.add_blob(source_path, ("source " + name).encode())},
                "job_names": [name], "app_id": 15368, "app_slug": "github-actions", "events": ["push"],
            }
            self.statement["additional_required_runs"][name] = {"run_id": run_id, "attempt": 1}
            self.api.responses[self.base + f"/actions/runs/{run_id}/attempts/1"] = {
                "id": run_id, "run_attempt": 1, "head_sha": self.source, "workflow_id": wid, "path": path,
                "status": "completed", "conclusion": "success", "event": "push", "check_suite_id": suite_id,
                "repository": {"full_name": self.repo}, "head_repository": {"full_name": self.repo},
            }
            self.api.responses[self.base + f"/actions/runs/{run_id}/attempts/1/jobs?per_page=100"] = {
                "total_count": 1, "jobs": [{"name": name, "run_id": run_id, "status": "completed", "conclusion": "success",
                                            "check_run_url": "https://api.github.com" + self.base + f"/check-runs/{check_id}"}],
            }
            self.api.responses[self.base + f"/check-runs/{check_id}"] = {
                "id": check_id, "name": name, "head_sha": self.source, "check_suite": {"id": suite_id},
                "status": "completed", "conclusion": "success", "app": {"id": 15368, "slug": "github-actions"},
            }
        self.refresh_statement()

    def add_blob(self, path, data, commit=None):
        import base64
        commit = commit or self.source
        git_sha = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
        self.api.responses[self.base + "/contents/" + path + "?ref=" + commit] = {
            "type": "file", "encoding": "base64", "path": path,
            "sha": git_sha, "content": base64.b64encode(data).decode(),
        }
        return pub.digest(data)

    def refresh_bundle(self, role):
        evidence = self.statement["evidence"][role]
        receipt = pub.canonical(self.receipts[role])
        execution = pub.canonical(self.execution[role])
        out = io.BytesIO()
        with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("Receipt.json", receipt)
            archive.writestr("Execution.json", execution)
        raw = out.getvalue()
        evidence.update(zip_sha256=pub.digest(raw), receipt_sha256=pub.digest(receipt),
                        execution_sha256=pub.digest(execution))
        aid, run_id = evidence["artifact_id"], evidence["run_id"]
        self.api.responses[self.base + f"/actions/artifacts/{aid}"] = {
            "id": aid, "expired": False, "digest": "sha256:" + pub.digest(raw),
            "workflow_run": {"id": run_id, "head_sha": self.source},
            "created_at": "2026-09-07T01:01:45Z", "size_in_bytes": len(raw),
        }
        self.api.downloads[self.base + f"/actions/artifacts/{aid}/zip"] = raw

    def refresh_statement(self):
        self.add_blob(self.p["statement_path"], pub.canonical(self.statement), self.attestation)

    def policy(self):
        raw = pub.canonical(self.p)
        return pub.load_policy(raw, pub.digest(raw))

    def validate(self):
        return pub.validate(self.policy(), self.api, self.selector)


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.w = World()

    def fails(self, text):
        with self.assertRaisesRegex(pub.PublicationError, text):
            self.w.validate()

    def test_valid_different_source_and_attestation_commits(self):
        activation, report = self.w.validate()
        self.assertNotEqual(activation["source_commit"], activation["attestation_commit"])
        self.assertEqual(report["validation"], "PASS")
        self.assertFalse(report["step18_pass"])
        self.assertIn("SYNTHETIC", report["api_provenance"])
        self.assertEqual(report["evidence_class"], "INJECTED_TEST_API_PREDICATES_ONLY")

    def test_unpinned_policy_rejected(self):
        with self.assertRaisesRegex(pub.PublicationError, "pinned policy"):
            pub.load_policy(pub.canonical(self.w.p), "0" * 64)

    def test_original_base_core_platform_checks_included(self):
        activation, _ = self.w.validate()
        self.assertEqual(set(activation["additional_required_runs"]), pub.BASE_CORE)

    def test_same_run_and_artifact_for_two_native_proofs(self):
        four = self.w.p["workflows"]["four_gates"]
        naming = self.w.p["workflows"]["naming"]
        naming.update(id=four["id"], path=four["path"], sha256=four["sha256"],
                      receipt_path="NamingReceipt.json", execution_path="NamingExecution.json")
        self.w.execution["naming"].update(run_id="51", workflow_ref=self.w.execution["four_gates"]["workflow_ref"])
        jobs51 = self.w.api.responses[self.w.base + "/actions/runs/51/attempts/1/jobs?per_page=100"]
        jobs52 = self.w.api.responses[self.w.base + "/actions/runs/52/attempts/1/jobs?per_page=100"]
        jobs51["jobs"][0]["steps"].extend(jobs52["jobs"][0]["steps"])
        out = io.BytesIO()
        with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for role in ("four_gates", "naming"):
                spec = self.w.p["workflows"][role]
                receipt = pub.canonical(self.w.receipts[role])
                execution = pub.canonical(self.w.execution[role])
                archive.writestr(spec["receipt_path"], receipt)
                archive.writestr(spec["execution_path"], execution)
                self.w.statement["evidence"][role].update(run_id=51, artifact_id=61,
                    receipt_sha256=pub.digest(receipt), execution_sha256=pub.digest(execution))
        raw = out.getvalue()
        for role in ("four_gates", "naming"):
            self.w.statement["evidence"][role]["zip_sha256"] = pub.digest(raw)
        self.w.api.responses[self.w.base + "/actions/artifacts/61"].update(
            digest="sha256:" + pub.digest(raw), size_in_bytes=len(raw))
        self.w.api.downloads[self.w.base + "/actions/artifacts/61/zip"] = raw
        self.w.refresh_statement()
        activation, _ = self.w.validate()
        self.assertEqual(activation["evidence"]["naming"]["run_id"], 51)
        self.assertEqual(self.w.api.calls.count(self.w.base + "/actions/artifacts/61/zip"), 1)

    def test_reversed_actual_steps_rejected(self):
        step = self.w.api.responses[self.w.base + "/actions/runs/52/attempts/1/jobs?per_page=100"]["jobs"][0]["steps"][0]
        step.update(started_at="2026-09-07T01:01:31Z", completed_at="2026-09-07T01:01:40Z")
        self.fails("Step15 Naming must precede Step16")

    def test_missing_additional_base_core_run_rejected(self):
        del self.w.statement["additional_required_runs"]["trivy"]
        self.w.refresh_statement()
        self.fails("exact additional required run set")

    def test_additional_check_wrong_source_app_rejected(self):
        self.w.api.responses[self.w.base + "/check-runs/301"]["app"]["id"] = 999
        self.fails("check source app ID")

    def test_stale_subject(self):
        self.w.statement["subject"]["sha256"] = "0" * 64
        self.w.refresh_statement()
        self.fails("statement subject")

    def test_stale_sequence(self):
        self.w.statement["sequence"] = 0
        self.w.refresh_statement()
        self.fails("statement sequence")

    def test_wrong_ci_sha(self):
        self.w.api.responses[self.w.base + "/actions/runs/51/attempts/1"]["head_sha"] = "f" * 40
        self.fails("CI source SHA")

    def test_wrong_candidate_in_receipt_even_when_run_green(self):
        self.w.receipts["four_gates"]["commit_sha"] = "f" * 40
        self.w.refresh_bundle("four_gates")
        self.w.refresh_statement()
        self.fails("four-gate source")

    def test_forged_workflow_bytes(self):
        self.w.add_blob(self.w.p["workflows"]["four_gates"]["path"], b"always pass")
        self.fails("trusted workflow bytes")

    def test_same_named_different_workflow_id(self):
        self.w.api.responses[self.w.base + "/actions/runs/51/attempts/1"]["workflow_id"] = 999
        self.fails("workflow ID")

    def test_forged_verifier(self):
        self.w.add_blob("scripts/naming.py", b"malicious")
        self.fails("trusted verifier")

    def test_successful_negative_harness_not_positive(self):
        self.w.execution["four_gates"]["negative_case"] = "provenance"
        self.w.refresh_bundle("four_gates")
        self.w.refresh_statement()
        self.fails("positive execution")

    def test_four_gate_failure_behind_green_run(self):
        self.w.receipts["four_gates"]["gates"]["provenance"]["status"] = "FAIL"
        self.w.refresh_bundle("four_gates")
        self.w.refresh_statement()
        self.fails("actual gate provenance")

    def test_naming_failure_behind_green_run(self):
        self.w.receipts["naming"]["checks"][0]["status"] = "FAIL"
        self.w.refresh_bundle("naming")
        self.w.refresh_statement()
        self.fails("actual Naming rule")

    def test_other_package_pass_rejected(self):
        self.w.receipts["four_gates"]["gates"]["candidate_identity"]["details"]["sha256"] = "0" * 64
        self.w.refresh_bundle("four_gates")
        self.w.refresh_statement()
        self.fails("four-gate actual package sha256")

    def test_different_execution_workflow_sha_rejected(self):
        self.w.execution["naming"]["workflow_sha"] = "0" * 40
        self.w.refresh_bundle("naming")
        self.w.refresh_statement()
        self.fails("execution immutable workflow SHA")

    def test_naming_fixture_rejected(self):
        self.w.receipts["naming"]["fixture_only"] = True
        self.w.refresh_bundle("naming")
        self.w.refresh_statement()
        self.fails("Naming fixture")

    def test_missing_naming_rule(self):
        self.w.receipts["naming"]["checks"].pop()
        self.w.refresh_bundle("naming")
        self.w.refresh_statement()
        self.fails("Naming rule count")

    def test_missing_evidence_role(self):
        del self.w.statement["evidence"]["naming"]
        self.w.refresh_statement()
        self.fails("required evidence roles")

    def test_replayed_attempt(self):
        self.w.execution["naming"]["run_attempt"] = "2"
        self.w.refresh_bundle("naming")
        self.w.refresh_statement()
        self.fails("execution attempt")

    def test_artifact_from_previous_attempt(self):
        self.w.api.responses[self.w.base + "/actions/artifacts/61"]["created_at"] = "2026-09-06T01:00:00Z"
        self.fails("outside selected run attempt")

    def test_replaced_artifact_bytes(self):
        self.w.api.downloads[self.w.base + "/actions/artifacts/61/zip"] += b"tamper"
        self.fails("artifact download size")

    def test_expired_artifact(self):
        self.w.api.responses[self.w.base + "/actions/artifacts/61"]["expired"] = True
        self.fails("artifact expired")

    def test_signature_forgery_in_selector_not_trusted(self):
        self.w.selector["verification"] = {"verified": True, "reason": "valid"}
        v = self.w.api.responses[self.w.base + "/commits/" + self.w.attestation]["commit"]["verification"]
        v["verified"] = False
        v["reason"] = "invalid"
        self.fails("signature not verified")

    def test_missing_signature(self):
        self.w.api.responses[self.w.base + "/commits/" + self.w.attestation]["commit"]["verification"]["signature"] = None
        self.fails("missing GitHub GPG")

    def test_signature_wrong_tree(self):
        self.w.api.responses[self.w.base + "/commits/" + self.w.attestation]["commit"]["verification"]["payload"] = "tree " + "f" * 40 + "\n"
        self.fails("signature payload/tree")

    def test_non_service_signature_issuer_rejected(self):
        self.w.api.responses[self.w.base + "/commits/" + self.w.attestation]["committer"]["login"] = "other-signer"
        self.fails("GitHub service signing identity")

    def test_unauthorized_merge_actor(self):
        self.w.api.responses[self.w.base + "/pulls/12"]["merged_by"]["login"] = "writer"
        self.fails("authorized publishing actor")

    def test_new_writer_invalidates_current_scope(self):
        self.w.api.responses[self.w.base + "/collaborators?per_page=100"].append(
            {"login": "writer", "permissions": {"admin": False, "push": True}})
        self.fails("actor set changed")

    def test_freeze_changed(self):
        self.w.add_blob(self.w.p["freeze"]["path"], b'{"status":"PENDING"}')
        self.fails("accepted source bytes")

    def test_missing_freeze_field_rejected(self):
        del self.w.statement["freeze_sha256"]
        self.w.refresh_statement()
        self.fails("missing or malformed")

    def test_wrong_governed_source_index(self):
        self.w.add_blob(pub.SOURCE_INDEX, b'{"unapproved":true}')
        self.fails("governed payload")

    def test_bare_pointer_reader_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / pub.TARGET
            target.parent.mkdir(parents=True)
            target.write_bytes(pub.canonical(self.w.selector))
            with self.assertRaises((KeyError, pub.PublicationError)):
                pub.read_activation(self.w.policy(), self.w.api, root)

    def test_reader_revalidates_remote_after_valid_local_pointer(self):
        activation, _ = self.w.validate()
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / pub.TARGET
            target.parent.mkdir(parents=True)
            target.write_bytes(pub.canonical(activation))
            self.w.api.responses[self.w.base + "/actions/artifacts/62"]["expired"] = True
            with self.assertRaisesRegex(pub.PublicationError, "artifact expired"):
                pub.read_activation(self.w.policy(), self.w.api, root)

    def test_skip_validator_cannot_publish_candidate_pointer(self):
        activation, _ = self.w.validate()
        activation["payloads"][pub.SOURCE_INDEX] = "0" * 64
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / pub.TARGET
            target.parent.mkdir(parents=True)
            target.write_bytes(pub.canonical(activation))
            with self.assertRaisesRegex(pub.PublicationError, "exact current verified projection"):
                pub.read_activation(self.w.policy(), self.w.api, root)

    def test_publish_isolated_cas_and_readback(self):
        with tempfile.TemporaryDirectory() as root:
            if os.name != "nt":
                with self.assertRaisesRegex(pub.PublicationError, "require Windows"):
                    pub.publish(self.w.policy(), self.w.api, root, self.w.selector, "NONE")
                return
            activation, result = pub.publish(self.w.policy(), self.w.api, root, self.w.selector, "NONE")
            self.assertTrue(result["activated"])
            self.assertTrue(list((Path(root) / pub.RECEIPTS).glob("*.json")))
            self.assertFalse((Path(root) / pub.TARGET.parent / "publication-receipts").exists())
            reloaded, _ = pub.read_activation(self.w.policy(), self.w.api, root)
            self.assertEqual(activation, reloaded)
            with self.assertRaisesRegex(pub.PublicationError, "expected-current CAS"):
                pub.publish(self.w.policy(), self.w.api, root, self.w.selector, "NONE")

    def test_failed_publish_does_not_write_activation(self):
        self.w.statement["subject"]["sha256"] = "0" * 64
        self.w.refresh_statement()
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(pub.PublicationError):
                pub.publish(self.w.policy(), self.w.api, root, self.w.selector, "NONE")
            self.assertFalse((Path(root) / pub.TARGET).exists())

    def test_parent_swap_during_validation_is_denied_and_handles_release(self):
        with tempfile.TemporaryDirectory() as folder:
            if os.name != "nt":
                with self.assertRaisesRegex(pub.PublicationError, "require Windows"):
                    pub.publish(self.w.policy(), self.w.api, folder, self.w.selector, "NONE")
                return
            root = Path(folder) / "candidate"
            root.mkdir()
            original = pub.validate
            denied = []
            def during_network(policy, api, selector):
                for name, path in (("target", root / pub.TARGET.parent),
                                   ("receipts", root / pub.RECEIPTS),
                                   ("root", root)):
                    try:
                        path.rename(Path(folder) / ("swapped-" + name))
                    except PermissionError:
                        denied.append(name)
                    else:
                        self.fail("directory replacement was allowed: " + name)
                return original(policy, api, selector)
            with mock.patch.object(pub, "validate", side_effect=during_network):
                _, report = pub.publish(self.w.policy(), self.w.api, root, self.w.selector, "NONE")
            self.assertTrue(report["activated"])
            self.assertEqual(denied, ["target", "receipts", "root"])
            parent = root / pub.TARGET.parent
            renamed = parent.with_name("after-handles-release")
            parent.rename(renamed)
            renamed.rename(parent)

    def test_preexisting_parent_junction_is_rejected_without_outside_write(self):
        with tempfile.TemporaryDirectory() as folder:
            if os.name != "nt":
                with self.assertRaisesRegex(pub.PublicationError, "require Windows"):
                    pub.publish(self.w.policy(), self.w.api, folder, self.w.selector, "NONE")
                return
            root, outside = Path(folder) / "candidate", Path(folder) / "outside"
            root.mkdir()
            outside.mkdir()
            parent = root / pub.TARGET.parent
            parent.parent.mkdir(parents=True)
            quote = lambda path: "'" + str(path).replace("'", "''") + "'"
            run = subprocess.run(["powershell", "-NoProfile", "-Command",
                "New-Item -ItemType Junction -Path " + quote(parent) + " -Target " + quote(outside) + " | Out-Null"],
                capture_output=True)
            self.assertEqual(run.returncode, 0)
            try:
                with self.assertRaisesRegex(pub.PublicationError, "symlink/junction"):
                    pub.publish(self.w.policy(), self.w.api, root, self.w.selector, "NONE")
                self.assertEqual(list(outside.iterdir()), [])
            finally:
                parent.rmdir()  # Remove only the fixture junction, never its target.

    def test_nonwindows_publisher_fails_before_validation(self):
        with mock.patch.object(pub.os, "name", "posix"), mock.patch.object(pub, "validate") as validate:
            with self.assertRaisesRegex(pub.PublicationError, "require Windows"):
                pub.publish(None, None, "unused", {}, "NONE")
            validate.assert_not_called()

    def test_nonboolean_signature_flag_rejected(self):
        self.w.api.responses[self.w.base + "/commits/" + self.w.attestation]["commit"]["verification"]["verified"] = 1
        self.fails("signature not verified")

    def test_cli_has_no_fixture_metadata_option(self):
        result = subprocess.run([sys.executable, str(MODULE), "--help"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        self.assertNotIn("--fixture", result.stdout)
        self.assertNotIn("--metadata", result.stdout)
        self.assertIn("--expected-current", result.stdout)


if __name__ == "__main__":
    unittest.main()
