#!/usr/bin/env python3
import json, pathlib, subprocess, sys, time
REPO=pathlib.Path(__file__).resolve().parents[2]
cmd=[sys.executable,"-m","unittest","discover","-s","tests/mps03","-p","test_*.py","-v"]
t0=time.time(); p=subprocess.run(cmd,cwd=REPO,text=True,capture_output=True)
out={"schema":"clued.mps03.repository-author-validation.v1","qualification":"implementation-candidate-only","g4_formal_pass_claimed":False,"g5_real_third_party_host_pass_claimed":False,"live_postgres_pass_claimed":False,"returncode":p.returncode,"duration_s":round(time.time()-t0,3),"stdout":p.stdout,"stderr":p.stderr,"command":cmd}
print(json.dumps(out,ensure_ascii=False,indent=2))
raise SystemExit(p.returncode)
