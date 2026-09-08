"""Independent black-box checks. Local engineering evidence, never formal PQUAL."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

def write(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8", newline="\n")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--controller", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    args = parser.parse_args()
    controller = args.controller.resolve()
    out = args.out_dir.resolve()
    out.mkdir(parents=True, exist_ok=False)
    digest = hashlib.sha256(controller.read_bytes()).hexdigest()
    rows = []

    def config(**change):
        value = dict(schema="clued.controller-candidate.v1", mode="LOCAL_ENGINEERING_ONLY",
            idempotency_key="probe", operation="noop", parameters={}, timeout_seconds=3,
            expected_runner_sha256=digest, expected_control_generation=1)
        value.update(change)
        return value

    def setup(name):
        root = out / name
        root.mkdir()
        return root

    def invoke(root, cfg, env=None):
        path = root / ("input-" + str(len(list(root.glob("input-*.json")))) + ".json")
        write(path, cfg)
        command = [sys.executable, str(controller), "run", "--config", str(path), "--evidence-dir", str(root)]
        done = subprocess.run(command, capture_output=True, text=True, env=env, timeout=15)
        result = json.loads(done.stdout)
        return result, done.returncode

    def record(name, pqual, result, check, detail):
        boundary = result.get("qualified") is False and result.get("authorization_effect") == "NONE" and result.get("formal_regressions_executed") is False
        rows.append(dict(check=name, source_pqual=pqual, scope="LOCAL_ENGINEERING_ONLY",
            status="PASS" if check and boundary else "FAIL", assertion=detail, observation=result))
        return rows[-1]

    def blocked(name, pqual, cfg, reason, initialize=None):
        root = setup(name)
        if initialize:
            initialize(root)
        result, code = invoke(root, cfg)
        record(name, pqual, result, code == 2 and result["status"] == "BLOCKED" and reason in result["reason"] and not (root / "runs" / "probe" / "fixture.json").exists(), "Rejected before fixture side effect: " + reason)

    root = setup("noop")
    result, code = invoke(root, config())
    record("noop", ["PQUAL-01", "PQUAL-20"], result, code == 0 and result["status"] == "COMPLETED", "Fixed local child completes with no authority.")
    root = setup("fixture-write")
    result, code = invoke(root, config(operation="fixture_write", parameters={"fixture_id":"synthetic-v1"}))
    target = root / "runs" / "probe" / "fixture.json"
    before = target.read_bytes()
    record("fixture-write", ["PQUAL-20"], result, code == 0 and b'"real_user_payload":false' in before and hashlib.sha256(before).hexdigest() == result["target_sha256"], "Exact built-in synthetic fixture bytes match receipt hash.")
    replay, _ = invoke(root, config(operation="fixture_write", parameters={"fixture_id":"synthetic-v1"}))
    record("completed-replay", ["PQUAL-16"], replay, replay.get("replayed_evidence_only") is True and target.read_bytes() == before, "Completed same-key request replays evidence without changing target.")
    changed, _ = invoke(root, config(operation="wait", parameters={"seconds":0}))
    record("changed-key-parameters", ["PQUAL-16"], changed, changed["status"] == "BLOCKED" and "same_key_changed_parameters" in changed["reason"] and target.read_bytes() == before, "Same key with changed operation is denied.")
    snapshots = {str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in root.rglob("*") if p.is_file()}
    done = subprocess.run([sys.executable,str(controller),"reconcile","--evidence-dir",str(root),"--idempotency-key","probe"],capture_output=True,text=True,timeout=10)
    reconciled = json.loads(done.stdout)
    snapshots_after = {str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in root.rglob("*") if p.is_file()}
    record("reconcile", ["PQUAL-16"], reconciled, reconciled["status"] == "UNKNOWN" and reconciled.get("target_matches") is True and reconciled.get("new_action_allowed") is False and reconciled.get("capacity_released") is False and reconciled.get("terminal_receipt_issued") is False and snapshots == snapshots_after, "Reconcile observes exact target, stays UNKNOWN, changes no files and grants no action.")

    for name, mutation in (
        ("forged-result-authority", {"qualified": True, "authorization_effect": "PRODUCTION_ACCEPTED", "formal_regressions_executed": True}),
        ("forged-result-binding", {"configuration_sha256": "0" * 64, "intent_sha256": "0" * 64}),
    ):
        root = setup(name)
        original, _ = invoke(root, config())
        result_path = root / "runs" / "probe" / "result.json"
        result_path.rename(result_path.with_name("preserved-original-result.json"))
        write(result_path, {**original, **mutation})
        result, _ = invoke(root, config())
        record(name, ["PQUAL-16", "PQUAL-20"], result,
               result["status"] in ("BLOCKED", "UNKNOWN"),
               "Corrupt existing receipt is rejected without rerun or claimed authority; original evidence is retained.")

    for name, filename, corrupt in (
        ("truncated-result-after-effect", "result.json", b'{"status":'),
        ("truncated-intent-after-effect", "intent.json", b'{"configuration":'),
        ("changed-target-after-effect", "fixture.json", b'{"fixture":"tampered-synthetic"}\n'),
    ):
        root = setup(name)
        cfg = config(operation="fixture_write", parameters={"fixture_id": "synthetic-v1"})
        original, _ = invoke(root, cfg)
        folder = root / "runs" / "probe"
        affected = folder / filename
        affected.rename(folder / ("preserved-original-" + filename))
        affected.write_bytes(corrupt)
        result, _ = invoke(root, cfg)
        record(name, ["PQUAL-16", "PQUAL-17", "PQUAL-20"], result,
               result["status"] == "UNKNOWN" and affected.read_bytes() == corrupt,
               "Existing side effect with corrupt evidence stays UNKNOWN; no replay, overwrite or re-execution.")

    for mode in ("PRE_ENTRY_SKILL_QUALIFICATION", "POST_ENTRY_SLICE_A"):
        blocked("formal-mode-denied-" + mode.lower(), ["PQUAL-01","PQUAL-02","PQUAL-07","PQUAL-18","PQUAL-19"], config(mode=mode), "formal_or_unknown_mode_denied")
    blocked("unknown-operation", ["PQUAL-06","PQUAL-07","PQUAL-09","PQUAL-10","PQUAL-17"], config(operation="publish_and_activate"), "operation_not_allowlisted")
    blocked("runner-drift", ["PQUAL-12"], config(expected_runner_sha256="0"*64), "runner_digest_drift")
    blocked("control-generation-drift", ["PQUAL-12","PQUAL-13"], config(expected_control_generation=2), "revoked_or_generation_changed")
    blocked("revoked-before-run", ["PQUAL-13"], config(), "revoked_or_generation_changed", lambda root: write(root/"control.json",dict(generation=1,revoked=True)))
    blocked("stop-before-run", ["PQUAL-11"], config(), "stop_requested", lambda root:(root/"STOP").write_text("independent test",encoding="utf-8"))
    blocked("path-traversal", ["PQUAL-09"], config(idempotency_key="../escape"), "invalid_idempotency_key")
    blocked("non-synthetic-payload", ["PQUAL-09"], config(operation="fixture_write",parameters={"fixture_id":"synthetic-v1","payload":"synthetic forbidden custom payload"}), "non_synthetic_parameters_denied")

    root = setup("environment-not-inherited")
    env = dict(os.environ)
    env["CLUED_DEVELOPER_CREDENTIAL"] = "synthetic-canary-not-a-secret"
    env["CLUED_PUBLIC_USER_CREDENTIAL"] = "synthetic-public-canary"
    result,_ = invoke(root,config(),env)
    keys = result.get("worker",{}).get("environment_keys",[])
    record("environment-not-inherited", ["PQUAL-08"], result, result["status"]=="COMPLETED" and not any(k.startswith("CLUED_") for k in keys) and set(keys) <= {"SYSTEMROOT","LC_CTYPE"}, "Real isolated Python child does not inherit synthetic credential environment keys; OS filesystem/network isolation remains unproven.")

    def running_fault(name, fault, pqual, expected):
        root = setup(name)
        cfg = config(operation="wait", parameters={"seconds":5},timeout_seconds=10)
        path=root/"input.json"
        write(path,cfg)
        proc=subprocess.Popen([sys.executable,str(controller),"run","--config",str(path),"--evidence-dir",str(root)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        intent=root/"runs"/"probe"/"intent.json"
        deadline=time.monotonic()+5
        while not intent.exists() and proc.poll() is None and time.monotonic()<deadline:
            time.sleep(0.002)
        if not intent.exists():
            proc.kill()
            stdout,stderr=proc.communicate()
            raise RuntimeError(name+" did not reach durable intent: "+stdout+stderr)
        fault(root)
        stdout,stderr=proc.communicate(timeout=12)
        result=json.loads(stdout)
        record(name,pqual,result,result["status"]==expected and not (root/"runs"/"probe"/"fixture.json").exists(), "Real mutation after durable intent; observed "+expected+".")
        return root,cfg,result

    running_fault("stop-during-run",lambda root:(root/"STOP").write_text("stop",encoding="utf-8"),["PQUAL-11"],"STOPPED")
    running_fault("revoke-during-run",lambda root:write(root/"control.json",dict(generation=1,revoked=True)),["PQUAL-13"],"STOPPED")
    running_fault("generation-during-run",lambda root:write(root/"control.json",dict(generation=2,revoked=False)),["PQUAL-12","PQUAL-13"],"STOPPED")

    root=setup("timeout-termination")
    result,_=invoke(root,config(operation="wait",parameters={"seconds":5},timeout_seconds=0.05))
    record("timeout-termination",["PQUAL-11","PQUAL-15"],result,result["status"]=="STOPPED" and result["reason"]=="deadline_exceeded" and result.get("worker",{}).get("termination_observed") is True,"Deadline kills fixed child and observes termination; no claim about remote process/capacity fencing.")

    root,cfg,result=running_fault("sink-failure-after-intent",lambda root:(root/"runs"/"probe"/"result.json").mkdir(),["PQUAL-16","PQUAL-17"],"UNKNOWN")
    blocked_result_path=root/"runs"/"probe"/"result.json"
    blocked_result_path.rename(blocked_result_path.with_name("preserved-result-sink-fault"))
    replay,_=invoke(root,cfg)
    record("unknown-no-retry",["PQUAL-16"],replay,replay["status"]=="UNKNOWN" and replay["reason"]=="unresolved_intent_no_automatic_retry" and not (root/"runs"/"probe"/"result.json").exists(),"Actual result persistence failure stays UNKNOWN; same key does not rerun. Injected empty directory preserved by rename.")
    reconcile=subprocess.run([sys.executable,str(controller),"reconcile","--evidence-dir",str(root),"--idempotency-key","probe"],capture_output=True,text=True,timeout=10)
    outcome=json.loads(reconcile.stdout)
    record("unknown-no-target",["PQUAL-16"],outcome,outcome["status"]=="UNKNOWN","No observable target cannot prove execution or authorize retry.")

    root=setup("sink-is-file")
    sink=root/"invalid-root"
    sink.write_text("preserve",encoding="utf-8")
    path=root/"input.json"
    write(path,config())
    done=subprocess.run([sys.executable,str(controller),"run","--config",str(path),"--evidence-dir",str(sink)],capture_output=True,text=True,timeout=10)
    result=json.loads(done.stdout)
    record("sink-is-file",["PQUAL-17"],result,result["status"]=="BLOCKED" and sink.read_text(encoding="utf-8")=="preserve","Non-directory evidence sink denied with original bytes unchanged.")

    summary=dict(scope="LOCAL_ENGINEERING_ONLY",formal_execution_state="NOT_EXECUTED",authorization_effect="NONE",qualified=False,
        controller_sha256=digest,controller_file=str(controller),test_file_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        executed_checks=len(rows),passed=sum(r["status"]=="PASS" for r in rows),failed=sum(r["status"]=="FAIL" for r in rows),checks=rows,
        limitations=["No real actor/issuer/Profile/GA validation","No service credential, production or model calls","No real OS filesystem or network isolation","No distributed fencing, grant expiry/renewal, budget or scope-shrink semantics","No real Skill loading, R11, human measurement or Slice A acceptance"])
    write(out/"IndependentVerification.json",summary)
    print(json.dumps({k:summary[k] for k in ("scope","formal_execution_state","executed_checks","passed","failed","controller_sha256")}))
    return 1 if summary["failed"] else 0

if __name__=="__main__":
    raise SystemExit(main())
