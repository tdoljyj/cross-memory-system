# -*- coding: utf-8 -*-
"""Clued Kernel R5 K1 architecture and contract freeze conformance.

Run directly:
    python tests/test_r5_k1_contract_freeze.py

The JSON contract is the value-level source of truth.  This suite deliberately
compares it with the implementation so contract drift fails closed.
"""

import argparse
import ast
import inspect
import hashlib
import json
import os
import subprocess
import sys


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

CONTRACT_REL = "docs/r5-kernel/contracts/kernel-contract-v1.1.json"
CONTRACT_PATH = os.path.join(ROOT, *CONTRACT_REL.split("/"))


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def load_contract():
    with open(CONTRACT_PATH, "r", encoding="utf-8") as fh:
        return json.load(fh)


def git(*args):
    cmd = ["git", "-c", "safe.directory=%s" % ROOT]
    cmd.extend(args)
    return subprocess.run(
        cmd, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace", check=False)


def command_paths(parser, prefix=()):
    sub_actions = [
        action for action in parser._actions
        if isinstance(action, argparse._SubParsersAction)
    ]
    if not sub_actions:
        return {" ".join(prefix)} if prefix else set()
    out = set()
    for action in sub_actions:
        for name, child in action.choices.items():
            out.update(command_paths(child, prefix + (name,)))
    return out


def imported_legacy_core_modules():
    findings = {}
    clued_root = os.path.join(ROOT, "clued")
    for dirpath, _dirnames, filenames in os.walk(clued_root):
        for filename in filenames:
            if not filename.endswith(".py"):
                continue
            path = os.path.join(dirpath, filename)
            rel = os.path.relpath(path, ROOT).replace(os.sep, "/")
            with open(path, "r", encoding="utf-8-sig") as fh:
                tree = ast.parse(fh.read(), filename=rel)
            roots = set()
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    roots.update(alias.name.split(".", 1)[0]
                                 for alias in node.names)
                elif isinstance(node, ast.ImportFrom) and node.level == 0 \
                        and node.module:
                    roots.add(node.module.split(".", 1)[0])
            external = sorted(roots.intersection({"memory_engine", "adapters"}))
            if external:
                findings[rel] = external
    return findings


def test_contract_identity_and_sources():
    c = load_contract()
    check(c["schema_version"] == 1, "contract schema_version drift")
    check(c["contract_id"] == "clued-kernel-r5-k1", "contract id drift")
    check(c["contract_version"] == "1.1.0", "contract version drift")
    check(c["gate"] == "K1" and c["decision"] == "FROZEN",
          "K1 must remain FROZEN")
    for rel in c["normative_sources"]:
        check(os.path.isfile(os.path.join(ROOT, *rel.split("/"))),
              "missing normative source: %s" % rel)


def test_truth_receipt_and_ancestry():
    c = load_contract()
    receipt = c["truth_receipt"]
    check(receipt["k0_decision"] == "NO_GO",
          "K1 must not reclassify historical K0")
    check(receipt["k1_does_not_reclassify_k0"] is True,
          "K0 non-reclassification flag missing")
    check(receipt["legacy_k0_evidence_status"] ==
          "UNAVAILABLE_ORPHAN_NOT_PORTABLE",
          "legacy evidence portability failure must remain explicit")
    check(receipt["original_evidence_bytes_verified"] is False,
          "missing legacy bytes must not be represented as verified")
    check(receipt["audit_gap_accepted"] is True,
          "rebaseline must explicitly accept the audit gap")
    check(receipt["previous_memory_claim_status"] ==
          "REISSUED_WITH_EXPLICIT_AUDIT_GAP",
          "rebaseline disposition drift")

    baseline = c["baseline_head"]
    required = [
        baseline,
        receipt["k0_historical_claim_anchor_commit"],
        receipt["k0_debt_closure_commit"],
    ]
    for commit in required:
        check(git("cat-file", "-e", "%s^{commit}" % commit).returncode == 0,
              "portable evidence commit missing: %s" % commit)
        check(git("merge-base", "--is-ancestor", commit, "HEAD").returncode == 0,
              "portable evidence commit is not anchored by HEAD: %s" % commit)

    rebaseline_rel = (
        "docs/r5-kernel/evidence/receipts/"
        "04-k1-evidence-rebaseline-receipt.json"
    )
    with open(os.path.join(ROOT, *rebaseline_rel.split("/")),
              "r", encoding="utf-8") as fh:
        rebaseline = json.load(fh)
    check(rebaseline["decision"] == "K1_REBASELINE_FROZEN",
          "K1 rebaseline receipt decision drift")
    check(rebaseline["legacy_evidence"]["status"] ==
          "UNAVAILABLE_ORPHAN_NOT_PORTABLE",
          "receipt must preserve the evidence gap")
    for asset in rebaseline["frozen_assets"]:
        path = os.path.join(ROOT, *asset["path"].split("/"))
        with open(path, "rb") as fh:
            digest = hashlib.sha256(fh.read()).hexdigest()
        check(digest == asset["sha256"],
              "rebaseline asset digest drift: %s" % asset["path"])

def test_versions_and_controller_surface():
    import clued
    from clued.controller import Controller

    c = load_contract()
    check(clued.__version__ == c["product_version"], "product version drift")
    check(clued.PROTOCOL_VERSION == c["protocol_version"],
          "protocol version drift")
    check(clued.RUNTIME_VERSION == c["runtime_version"],
          "runtime version drift")
    for name, expected in c["controller_contract"].items():
        actual = list(inspect.signature(getattr(Controller, name)).parameters)
        check(actual == expected,
              "Controller.%s parameters drift: %r != %r" %
              (name, actual, expected))


def test_cli_and_envelope_surface():
    from clued.cli import build_parser
    from clued.envelope import envelope

    c = load_contract()["cli_contract"]
    actual_commands = command_paths(build_parser())
    check(actual_commands == set(c["commands"]),
          "CLI command drift: %r != %r" %
          (sorted(actual_commands), sorted(c["commands"])))
    actual_fields = list(envelope(timestamp="2026-08-22T00:00:00Z",
                                  request_id="k1").keys())
    check(actual_fields == c["envelope_fields"],
          "JSON envelope field drift")
    check(c["json_stdout_objects"] == 1 and
          c["diagnostics_stream"] == "stderr",
          "JSON stream contract weakened")


def test_auth_surface():
    from clued.auth import engine, policy, provider

    c = load_contract()["auth_contract"]
    actual_results = [
        provider.AUTHORIZED, provider.DENIED,
        provider.DENIED_SECURITY, provider.UNAVAILABLE,
    ]
    check(actual_results == c["results"], "auth result drift")
    check(list(provider.REQUIRED_SCOPES) == c["required_scopes"],
          "required scope drift")
    check(engine.CONNECT_TIMEOUT_S == c["connect_timeout_s"],
          "connect timeout drift")
    check(engine.OP_TIMEOUT_S == c["operation_timeout_s"],
          "operation timeout drift")
    check(engine.MAX_ATTEMPTS == c["max_attempts"], "attempt count drift")
    check(engine.TOTAL_BUDGET_S == c["total_budget_s"], "budget drift")
    check(engine.DEGRADED_SESSION_TTL_S == c["degraded_session_ttl_s"],
          "degraded session TTL drift")
    actual_profiles = {
        name: values["lkg_max_age_s"]
        for name, values in policy.POLICY_PROFILES.items()
    }
    check(actual_profiles == c["policy_profiles"], "LKG policy drift")
    check(policy.DEFAULT_POLICY == c["default_policy"],
          "default policy drift")
    check(policy.UPGRADE_POLICY == c["upgrade_policy"],
          "upgrade policy drift")
    check(policy.MAX_LKG_MAX_AGE_S == c["max_lkg_age_s"],
          "maximum LKG age drift")


def test_state_machine_and_journal():
    from clued import state_machine
    from clued.pending_journal import PendingJournal, TERMINAL_STATES

    c = load_contract()
    sm = c["state_machine"]
    check(list(state_machine.STATES) == sm["states"], "state list drift")
    actual_transitions = {
        state: list(targets)
        for state, targets in state_machine.ALLOWED_TRANSITIONS.items()
    }
    check(actual_transitions == sm["transitions"],
          "state transition drift")

    journal = c["journal_contract"]
    check(list(TERMINAL_STATES) == journal["terminal_states"],
          "journal terminal state drift")
    actual_journal = {
        state: list(targets)
        for state, targets in PendingJournal._TRANSITIONS.items()
    }
    check(actual_journal == journal["transitions"],
          "journal transition drift")


def test_recovery_and_schemas():
    from clued import manifests
    from clued.auth.engine import SessionRecord
    from clued.controller import STATE_FILE_SCHEMA
    from clued.pending_journal import PAYLOAD_SCHEMA
    from clued.recovery import STEPS

    c = load_contract()
    check(list(STEPS) == c["recovery_contract"]["steps"],
          "recovery order drift")
    schemas = c["schema_contract"]
    actual = {
        "node": manifests.NODE_SCHEMA,
        "binding": manifests.BINDING_SCHEMA,
        "auth_cache": manifests.AUTH_CACHE_SCHEMA,
        "pending_op": manifests.PENDING_SCHEMA,
        "pending_payload": PAYLOAD_SCHEMA,
        "revoke_task": manifests.REVOKE_TASK_SCHEMA,
        "runtime_state": STATE_FILE_SCHEMA,
        "policy": manifests.POLICY_VERSION,
    }
    rec = SessionRecord("s", "b", "AUTHORIZED")
    actual["session_auth"] = rec.to_dict()["schema_version"]
    actual["conflict"] = "clued.conflict.v0.1"
    check(actual == schemas, "schema contract drift: %r != %r" %
          (actual, schemas))


def test_errors_and_exit_codes():
    from clued import errors

    c = load_contract()
    check(sorted(errors.ERROR_CODES) == sorted(c["error_codes"]),
          "stable error-code surface drift")
    actual_exit = {
        "ok": errors.EXIT_OK,
        "usage": errors.EXIT_USAGE,
        "capability": errors.EXIT_CAPABILITY,
        "denied": errors.EXIT_DENIED,
        "unavailable": errors.EXIT_UNAVAILABLE,
        "sync_fail": errors.EXIT_SYNC_FAIL,
        "conflict": errors.EXIT_CONFLICT,
        "transaction_fail": errors.EXIT_TXN_FAIL,
        "security": errors.EXIT_SECURITY,
    }
    check(actual_exit == c["exit_codes"], "exit-code mapping drift")


def test_legacy_core_bridge_boundary_and_next_gate():
    c = load_contract()
    expected = {
        "clued/controller.py": ["memory_engine"],
        "clued/installer.py": ["memory_engine"],
        "clued/memory_gate.py": ["adapters", "memory_engine"],
        "clued/paths.py": ["memory_engine"],
    }
    check(imported_legacy_core_modules() == expected,
          "legacy-core bridge boundary drift: %r" %
          imported_legacy_core_modules())
    check(c["architecture"]["legacy_core_bridges"] == [
        "clued.controller", "clued.installer", "clued.memory_gate",
        "clued.paths", "clued.sync_provider",
    ], "declared legacy-core bridge whitelist drift")
    check(c["next_gate"] == {
        "gate": "K2",
        "status": "LOCKED",
        "unlock_requires": [
            "K1 conformance test pass",
            "K0 regressions remediated or explicitly accepted as bounded debt",
            "fresh full regression evidence",
            "no secret scan hits",
            "explicit K2 authorization",
        ],
    }, "K2 gate weakened")
    check(c["compatibility_policy"]["semantic_recall"] ==
          "remains_disabled_and_not_product_qualified",
          "semantic recall qualification changed")


TESTS = [
    test_contract_identity_and_sources,
    test_truth_receipt_and_ancestry,
    test_versions_and_controller_surface,
    test_cli_and_envelope_surface,
    test_auth_surface,
    test_state_machine_and_journal,
    test_recovery_and_schemas,
    test_errors_and_exit_codes,
    test_legacy_core_bridge_boundary_and_next_gate,
]


def main():
    for test in TESTS:
        test()
        print("PASS %s" % test.__name__)
    print("K1 CONTRACT FREEZE: %d/%d PASS" % (len(TESTS), len(TESTS)))


if __name__ == "__main__":
    main()
