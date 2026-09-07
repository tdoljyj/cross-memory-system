from pathlib import Path
import hashlib,json,subprocess,os,zipfile,shutil
BASE=Path(__file__).resolve().parent.parent
R=BASE/'phase2-governance-check'; O=Path(__file__).resolve().parent
G=R/'docs/execution-plans/phase2-structure-governance'
S7=G/'step07-projection-20260907'; S8=G/'step08-validator-20260907'
hashes={}; checks=[]
def sha(b):return hashlib.sha256(b).hexdigest()
def read(p):
 b=p.read_bytes(); hashes[str(p)]={'sha256':sha(b),'bytes':len(b)}; return b
def obj(p):return json.loads(read(p))
def pointer(d,p):
 for k in p[1:].split('/') if p else []:
  k=k.replace('~1','/').replace('~0','~');d=d[int(k)] if isinstance(d,list) else d[k]
 return d
def check(name,ok,detail=None):
 checks.append({'check':name,'pass':bool(ok),'detail':detail});assert ok,(name,detail)
b=obj(S7/'ProjectionBindings.repository.json'); src={}
for key,ref in b['sources'].items():
 raw=read(R/ref['path']);check('source:'+key,sha(raw)==ref['sha256'])
 src[key]=json.loads(raw) if ref['kind']=='json' else raw.decode('utf-8')
manifest=obj(S7/'repository-generated/GovernanceManifest.projection.json')
for key,ref in b['facts'].items():
 expected=pointer(src[ref['source_id']],ref['pointer']) if ref is not None else None
 check('independent_fact:'+key,manifest['facts'][key]['value']==expected)
 if ref is not None:
  check('fact_provenance:'+key,manifest['facts'][key]['source']==dict(ref,sha256=b['sources'][ref['source_id']]['sha256']))
for c in b['lineage_checks']:
 expected=pointer(src[c['expected_digest']['source_id']],c['expected_digest']['pointer'])
 check('independent_lineage:'+c['id'],expected==b['sources'][c['target_source_id']]['sha256'])
a7=obj(G/'Step07-ScopedAcceptance_20260907.json'); a8=obj(G/'Step08-ScopedAcceptance_20260907.json')
check('step7_decision_exact',sha((G/'Step07-ScopedAcceptance_20260907.json').read_bytes())=='dec7601899be7118b3baff3d78793ecaf98b06316070b881ca30297a3b0f22b3')
check('step8_decision_exact',sha((G/'Step08-ScopedAcceptance_20260907.json').read_bytes())=='8bac86599481c9effc67274bb29b7f352d59d4e656add8805e41f7437ced455c')
for name,h in a7['subjects']['output_sha256'].items():check('output_digest:'+name,sha(read(S7/'repository-generated'/name))==h)
for name,ref in a8['subjects'].items():check('step8_subject:'+name,sha(read(G/ref['path']))==ref['sha256'])
registry=obj(S7/'repository-generated/GovernanceRegistry.projection.json')
check('manifest_registry_all_facts_identical',{r['id']:{k:v for k,v in r.items() if k!='id'} for r in registry['entries']}==manifest['facts'])
cons=obj(S7/'repository-generated/ConsumerBindings.projection.json')
check('consumer_projection_exact',cons['candidate_consumers']==manifest['facts']['consumer_bindings'])
check('18_consumers_27_authorization_18_receipts',len(src['consumers']['consumers'])==18 and src['typed-authorization']['binding_count']==27 and src['typed-receipts']['binding_count']==18)
check('aggregate_ids_remain_null',all(manifest['facts'][n]['value'] is None for n in ['formal_domain_id','formal_program_id','formal_stage_id']))
check('historical_copy_exact',(S7/'repository-generated/CURRENT_STATUS.history-original.md').read_bytes()==(R/b['sources']['historical-status']['path']).read_bytes())
blocks=[read(S7/'repository-generated'/n) for n in ['README.governance.md','AGENTS.governance.md','GovernanceDocs.projection.md']]
check('same_human_governance_block',len(set(blocks))==1)
check('human_metadata_equivalence',all(s in blocks[0].decode() for s in ['来源集合摘要','事实模型摘要','PREPARATION_ONLY_NOT_STEP7_GATE','治理来源生成']))
check('root_sensitive_value_not_in_new_governance_block',not any(s in blocks[0].decode() for s in ['175***@qq.com','owner_0e58f3caef99d95912279cee']))

# Independently correlate raw retained negative receipts with the expected rules and exit codes.
review=obj(S8/'RootIndependentStep8Review.json')
retained=[]
for archive_name,rows in [('Step8ValidatorEvidence_20260907.zip',review['original_cases']),('FinalBindingControls.zip',review['final_controls'])]:
 with zipfile.ZipFile(S8/archive_name) as z:
  wanted={r['receipt_sha256']:r for r in rows}
  for name in z.namelist():
   if not name.endswith('.json'):continue
   raw=z.read(name);h=sha(raw)
   if h not in wanted:continue
   expected=wanted.pop(h);receipt=json.loads(raw)
   code=expected.get('exit_code',1)
   check('retained_exit:'+expected['case'],receipt['exit_code']==code)
   if expected['target_rule']:
    check('retained_rule:'+expected['case'],expected['target_rule'] in [r['code'] for r in receipt['errors']])
   retained.append({'case':expected['case'],'archive':archive_name,'member':name,'sha256':h,'exit_code':code,'target_rule':expected['target_rule']})
  check('retained_all_found:'+archive_name,not wanted,list(wanted))

# One current positive CLI rerun; two selected controls add parser/output coverage without repeating all tests.
env=dict(os.environ,PYTHONDONTWRITEBYTECODE='1')
candidate=BASE/'candidate-source/Clued_Phase2_三轨修订与补证_完整审查候选包_v0.2.7.1_Manifest修复_20260906.zip'
cmd=['python','-X','utf8',str(R/'scripts/naming-governance/run.py'),'--bindings',str(S8/'SourceLocators.json'),'--source-root',str(R),'--candidate-zip',str(candidate),'--report',str(O/'CurrentPositiveReceipt.json')]
run=subprocess.run(cmd,capture_output=True,text=True,encoding='utf-8',env=env)
check('independent_actual_current_cli',run.returncode==0,run.stdout[-1000:])
receipt=obj(O/'CurrentPositiveReceipt.json');check('current_cli_no_bindings_gaps',receipt['exit_code']==0 and not receipt['errors'] and not receipt['step6_binding_gaps'])
duplicate=O/'DuplicateKey.bindings.json';raw=(S8/'SourceLocators.json').read_text(encoding='utf-8');duplicate.write_text('{"format":"SHADOW_DUPLICATE",'+raw.lstrip()[1:],encoding='utf-8')
cmd[cmd.index('--bindings')+1]=str(duplicate);cmd[cmd.index('--report')+1]=str(O/'DuplicateKeyReceipt.json')
run=subprocess.run(cmd,capture_output=True,text=True,encoding='utf-8',env=env)
receipt=obj(O/'DuplicateKeyReceipt.json');check('duplicate_source_selection_rejected',run.returncode==1 and any('duplicate JSON key' in r['detail'] for r in receipt['errors']),receipt['errors'])
outputs=O/'unexpected-output-control';outputs.mkdir(exist_ok=True)
for name in a7['subjects']['output_sha256']:shutil.copyfile(S7/'repository-generated'/name,outputs/name)
(outputs/'UNREGISTERED_CURRENT.md').write_text('unregistered current projection\n',encoding='utf-8')
run=subprocess.run(['node',str(R/'scripts/naming-governance/projection-check.mjs'),str(S7/'project-governance.mjs'),str(S7/'ProjectionBindings.repository.json'),str(R),str(outputs)],capture_output=True,text=True,encoding='utf-8',env=env)
result=json.loads(run.stdout);check('unexpected_current_output_rejected',run.returncode==1 and {'file':'UNREGISTERED_CURRENT.md','reason':'UNEXPECTED_OUTPUT'} in result['mismatches'])
(O/'UnexpectedOutputControl.json').write_text(json.dumps({'exit_code':run.returncode,'result':result},ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
report={'reviewer':'/root/architecture_review','checks':checks,'passed':len(checks),'failed':0,'sources':hashes,'retained_receipts':retained,'no_authority_issued':True,'not_repeated':['Full 246MB package hash already independently recomputed by root','All validator fixture runs','Live hosted services','Original complete historical/Library scan']}
(O/'IndependentChecks.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'checks':len(checks),'failed':0,'retained_receipts':len(retained)},ensure_ascii=False))
