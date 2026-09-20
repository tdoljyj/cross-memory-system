from __future__ import annotations
import sys, json, os, subprocess, hashlib, importlib.util, datetime as dt
from pathlib import Path
sys.dont_write_bytecode = True
REPO = Path(r"C:\Users\Windows\.dsh\projects\cross-memory-system")
SRC = REPO / "scripts/model-program/m1-runtime-lifecycle-owner"
RUNNER = Path(r"C:\Users\Windows\AppData\Local\Temp\clued-m108-r4-capture-boundary-runner.py")
OUT = Path(r"C:\Users\Public\Clued\Qualification\M1-08-Owner\m108-r4-capture-boundary-40eaa69913ad-focused")
TEST = Path(r"C:\Users\Public\Clued\Qualification\M1-08-Owner\m108-r4-capture-boundary-40eaa69913ad-a\m1-08-owner.tests.exe")
SOURCE_FREEZE = "5a691080fedd38e069f1bbb0ba335a34750e4682"
MANIFEST = "40eaa69913ade714d2e717a94a317d1b2ecce9b73b9ef0824b9aeeff345dc801"
REQUIRED = [
 "TestR4CaptureRequiresSignedClassBeforeFileOrLaunchEffect",
 "TestR4CaptureRequiresExactCodePairBeforeFileOrLaunchEffect",
 "TestR4ExpiredCaptureIsDrainedButNotPersisted",
 "TestR4FinalizationRevokesCaptureEvenWhenOwnedProcessCleanupFails",
]
def utc(): return dt.datetime.now(dt.timezone.utc).isoformat()
def sha(p):
 h=hashlib.sha256(); h.update(p.read_bytes()); return h.hexdigest()
spec=importlib.util.spec_from_file_location("r4runner", RUNNER); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
sys.path.insert(0,str(SRC))
from qualification_scope import QualificationScope
candidate=json.loads((REPO/"development/contracts/model-program/m1/governance/ExperimentAuthorizationProfile.M1-LIFE-QWEN35-08B-PC-001.candidate.json").read_bytes())
if OUT.exists(): raise SystemExit("focused output already exists")
with QualificationScope(OUT, REPO) as scope:
 temp=OUT/"temp"; temp.mkdir()
 pre=m.observe(os.environ.get("SystemRoot",r"C:\Windows"),candidate)
 (OUT/"PRE_FOCUSED.json").write_text(json.dumps(pre,indent=2)+"\n",encoding="utf-8")
 if pre["processes"] or pre["listeners"] or any(v["exists"] for v in pre["paths"].values()): raise RuntimeError("PRE_NOT_QUIESCENT")
 env={"SystemRoot":os.environ.get("SystemRoot",r"C:\Windows"),"WINDIR":os.environ.get("WINDIR",r"C:\Windows"),"TEMP":str(temp),"TMP":str(temp)}
 argv=[str(TEST),"-test.v","-test.count=1","-test.run","^TestR4"]
 started=utc(); p=subprocess.run(argv,cwd=SRC,env=env,capture_output=True,timeout=120); finished=utc()
 (OUT/"focused.stdout.log").write_bytes(p.stdout); (OUT/"focused.stderr.log").write_bytes(p.stderr)
 log=p.stdout.decode("utf-8","replace")
 for name in REQUIRED:
  if not any(line.startswith("--- PASS: "+name+" ") for line in log.splitlines()):
   raise RuntimeError("REQUIRED_FOCUSED_TEST_NOT_PASS: "+name)
 report={"top_level_pass":sum(1 for line in log.splitlines() if line.startswith("--- PASS: TestR4")),"subtest_pass":0,"fail":sum(1 for line in log.splitlines() if line.startswith("--- FAIL:")),"skip":sum(1 for line in log.splitlines() if line.startswith("--- SKIP:")),"required_tests":REQUIRED}
 post=m.observe(os.environ.get("SystemRoot",r"C:\Windows"),candidate)
 (OUT/"POST_FOCUSED.json").write_text(json.dumps(post,indent=2)+"\n",encoding="utf-8")
 if p.returncode or post["processes"] or post["listeners"] or post["paths"] != pre["paths"]: raise RuntimeError("FOCUSED_FAILED_OR_POST_DRIFT")
 receipt={"source_freeze_sha":SOURCE_FREEZE,"source_manifest_sha256":MANIFEST,"argv":argv,"cwd":str(SRC),"environment":env,"started_at_utc":started,"finished_at_utc":finished,"exit_code":p.returncode,**report,"native_test_binary":{"bytes":TEST.stat().st_size,"path":str(TEST).lower(),"sha256":sha(TEST)},"status":"FOCUSED_WINDOWS_PASS","qualification_namespace":scope.evidence(),"owner_binary_executed":False,"independent_review_pass":False,"limitations":["PRE/POST are time-point observations, not continuous monitoring"]}
 (OUT/"FOCUSED_RECEIPT.json").write_text(json.dumps(receipt,indent=2)+"\n",encoding="utf-8")
print(json.dumps(receipt))
