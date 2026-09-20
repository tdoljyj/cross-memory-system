from pathlib import Path
import ctypes, datetime, hashlib, json, os, socket, subprocess, sys
r=Path(r'C:\Users\Windows\AppData\Local\Temp\clued-m108-reviewer-remediate'); s=r/'scripts/model-program/m1-runtime-lifecycle-owner'
q=Path(__file__).parent; root=q.parent; frozen='37bee117aaba72a088b6a2379d4daa2a93c2bce7'
def git(*a): return subprocess.check_output(['git','-C',str(r),*a]).decode().strip()
def h(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def save(n,v): (q/n).write_bytes((json.dumps(v,indent=2,sort_keys=True)+'\n').encode())
wd=ctypes.create_unicode_buffer(32768); assert ctypes.windll.kernel32.GetWindowsDirectoryW(wd,32768)
ps=str(Path(wd.value)/'System32/WindowsPowerShell/v1.0/powershell.exe')
def observe(phase):
 script="$ErrorActionPreference='Stop'; [pscustomobject]@{llama_server_count=@(Get-Process -ErrorAction Stop|Where-Object ProcessName -eq 'llama-server').Count;listener_18088=@(Get-NetTCPConnection -State Listen -ErrorAction Stop|Where-Object LocalPort -eq 18088).Count}|ConvertTo-Json -Compress"
 v=json.loads(subprocess.check_output([ps,'-NoProfile','-Command',script])); v.update(phase=phase,utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),computer=socket.gethostname(),exact_head=git('rev-parse','HEAD'),tracked_status=git('status','--porcelain'),semantics='POINT_IN_TIME / NOT_CONTINUOUS_MONITORING')
 for n,p in {'guard':r'C:\Users\Public\Clued\ModelProgram\M1\runtime-state\M1-LIFE-QWEN35-08B-PC-001\M1RuntimeLifecycleAttemptGuard.json','runtime_root':r'C:\Users\Public\Clued\ModelProgram\M1\runtime-lifecycle-smoke\M1-LIFE-QWEN35-08B-PC-001','production_evidence':r'C:\Users\Public\Clued\ModelProgram\M1\evidence\M1-LIFE-QWEN35-08B-PC-001'}.items(): v[n+'_exists']=os.path.lexists(p)
 return v
assert git('rev-parse','HEAD')==frozen and not git('status','--porcelain')
manifest_hash=h(s/'source-manifest.json'); assert manifest_hash=='2f93920176846e40dd2cdf9596cf79cfe438dbaa5f94c44136dd59a7e3ecac99'
pre=observe('PRE'); save('PRE_QUALIFICATION.json',pre); print(json.dumps(pre),flush=True)
records=[]
for label in ('a','b'):
 out=root/('m108-0708-r3-'+label); assert not out.exists(); start=datetime.datetime.now(datetime.timezone.utc).isoformat()
 argv=[sys.executable,'-B',str(s/'build.py'),'--toolchain-archive',r'C:\Users\Windows\AppData\Local\Temp\go1.27.1.windows-amd64.zip','--output',str(out)]
 p=subprocess.run(argv,cwd=s,capture_output=True,timeout=360); (q/('build-'+label+'-wrapper.log')).write_bytes(p.stdout+p.stderr)
 rec=dict(label=label,argv=argv,exit_code=p.returncode,started_utc=start,ended_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),output=str(out)); records.append(rec); save('COMMANDS.json',records)
 print(json.dumps(rec),flush=True)
 if p.returncode: print((p.stdout+p.stderr).decode(errors='replace'),flush=True); raise SystemExit(p.returncode)
post=observe('POST'); save('POST_QUALIFICATION.json',post)
assert git('rev-parse','HEAD')==frozen and not git('status','--porcelain') and h(s/'source-manifest.json')==manifest_hash
builds=[]
for label in ('a','b'):
 out=root/('m108-0708-r3-'+label); receipt=json.loads((out/'build-receipt.json').read_bytes()); events=[json.loads(x) for x in (out/'go-test.log').read_text().splitlines() if x.strip()]
 assert not [v for v in events if v.get('Action') in ('fail','skip')]
 names={v['Test'] for v in events if v.get('Action')=='pass' and v.get('Test')}; summary={'top_level_pass':sum('/' not in n for n in names),'subtest_pass':sum('/' in n for n in names),'windows_native_top_level_pass':sum(n.startswith('TestWindows') and '/' not in n for n in names),'fail':0,'skip':0}
 actual={}
 for key in ('owner_binary','windows_test_binary'):
  f=Path(receipt[key]['path']); actual[key]={'bytes':f.stat().st_size,'sha256':h(f)}; assert actual[key]['bytes']==receipt[key]['bytes'] and actual[key]['sha256']==receipt[key]['sha256']
 assert receipt['native_source_manifest_sha256']==manifest_hash
 builds.append(dict(label=label,source_manifest_sha256=manifest_hash,test_summary=summary,actual_artifact_rehash=actual))
assert builds[0]['actual_artifact_rehash']==builds[1]['actual_artifact_rehash']
v=dict(source_freeze=frozen,source_manifest_sha256=manifest_hash,builds=builds,qualification_status='PASS / AUTHOR_QUALIFICATION_ONLY',independent_review_pass=False,owner_binary_executed=False,effectful_authority_issued=False,issuer_root_bound=False,model_execution_authorized=False,observation_limit='PRE_POST_ONLY / NOT_CONTINUOUS',commands=records)
save('QUALIFICATION_RECEIPT.json',v); print(json.dumps(v),flush=True)
