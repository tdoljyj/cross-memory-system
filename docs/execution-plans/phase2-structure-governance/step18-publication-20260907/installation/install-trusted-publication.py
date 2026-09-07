"""One-time delegated installation; requires an independently reviewed policy file."""
from pathlib import Path
import argparse, hashlib, json, shutil
from datetime import datetime, timezone
p=argparse.ArgumentParser()
p.add_argument('--policy',required=True,type=Path)
p.add_argument('--policy-sha256',required=True)
a=p.parse_args()
W=Path(__file__).parent
R=W/'phase2-governance-check'
P='docs/execution-plans/phase2-structure-governance/'
T=R/'.git/clued-phase2'
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def canonical(v): return (json.dumps(v,ensure_ascii=False,sort_keys=True,separators=(',',':'))+'\n').encode()
assert sha(a.policy)==a.policy_sha256
assert not T.exists(), 'Never overwrite an existing installed trust boundary'
expected={'trusted_launcher.py':'32d0d3e2fda441e589d33a0b63042482cf4c33630bb0eb63e69d2d7bd0e6d35a','publication.py':'74026fd0b6cf859b53d4f925a1147b9a787a92a426f93985f98e4077a2a028b7','post_migration.py':'bbe3dfe6d6949357ae32643e8cad7493b27d487638e7750c6b5b279c181d882e'}
for name,h in expected.items(): assert sha(R/'scripts/naming-governance'/name)==h
freeze=P+'Phase2StructureFreezeDecision_20260907.json'
authorization=P+'ExecutionDelegation_20260907.json'
assert sha(R/freeze)=='f40c8af253f811f820e4b3eccc144d63ca3548663810aba10bebb22331661b36'
assert sha(R/authorization)=='fb5b2c8767fa477b67f1d90183a3c9dd14ae9378520e61320ec0df486008d8c8'
python=Path('C:/Users/Windows/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe')
gh=Path('C:/Program Files/GitHub CLI/gh.exe')
pins={'repository_root':str(R.resolve()),'launcher_sha256':expected['trusted_launcher.py'],'publication_sha256':expected['publication.py'],'post_migration_sha256':expected['post_migration.py'],'policy_sha256':a.policy_sha256,'python':{'path':str(python),'sha256':sha(python)},'gh':{'path':str(gh),'sha256':sha(gh)},'freeze':{'path':freeze,'sha256':sha(R/freeze)}}
bootstrap={'type':'Phase2TrustedLauncherBootstrap','state':'AUTHORIZED','scope':'TM19_GOVERNANCE_READ_PUBLISH','actor':'Codex@DESK-W-591 under existing explicit delegated execution and review','authorization_ref':{'path':authorization,'sha256':sha(R/authorization)},'pins_sha256':hashlib.sha256(canonical(pins)).hexdigest(),'fixture_only':False,'issued_at':datetime.now(timezone.utc).isoformat(),'meaning':'Delegated local installation record, not a cryptographic signature or new runtime authority. Same-user administrator remains the audited exception.'}
b=canonical(bootstrap)
config={'contract':'clued.phase2.local-trust-config/v1','pins':pins,'bootstrap_sha256':hashlib.sha256(b).hexdigest()}
T.mkdir()
for name in expected: shutil.copyfile(R/'scripts/naming-governance'/name,T/name)
shutil.copyfile(a.policy,T/'policy.json')
(T/'Bootstrap.json').write_bytes(b)
(T/'trust-config.json').write_bytes(canonical(config))
print(json.dumps({'installed':str(T),'policy_sha256':a.policy_sha256,'bootstrap_sha256':config['bootstrap_sha256'],'files':{f.name:sha(f) for f in T.iterdir() if f.is_file()},'actual_publication':False}))
