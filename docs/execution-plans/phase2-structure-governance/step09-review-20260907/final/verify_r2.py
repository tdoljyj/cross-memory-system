from pathlib import Path
import subprocess,json,hashlib
O=Path(__file__).resolve().parent;R=O.parent/'phase2-governance-check';G=R/'docs/execution-plans/phase2-structure-governance';S=G/'step09-review-20260907';D=G/'step12-migration-20260907'
sha=lambda b:hashlib.sha256(b).hexdigest()
def obj(p):return json.loads(p.read_bytes())
def ref(p):return {'path':str(p),'sha256':sha(p.read_bytes())}
a=obj(S/'ReviewSubject_20260907.json');b=obj(S/'ReviewSubject_20260907.r2.json')
assert sha((S/'ReviewSubject_20260907.r2.json').read_bytes())=='741cf1fedefa35cec82e9f55bcf53bf2ce29fa6253fd68da2133ab0c2d724cbf'
assert b['candidate_commit']=='039cfea5a0d91a4e4e02702f6cfdfe9379978b1e'
tree=subprocess.check_output(['git','rev-parse',b['candidate_commit']+'^{tree}'],cwd=R).decode().strip()
assert tree==b['candidate_tree']=='cd87a2384ed330bdc1186f6db21d9978e414ba2e'
x={r['path']:r for r in a['supplementary_files']};y={r['path']:r for r in b['supplementary_files']}
assert not x.keys()-y.keys()
delta={k:r for k,r in y.items() if k not in x or x[k]!=r}
assert len(delta)==6 and len(y)==159
changed=[k for k in delta if k in x];assert changed==['docs/execution-plans/phase2-structure-governance/step12-migration-20260907/migration_execute.py']
names=subprocess.check_output(['git','diff','--name-only','-z',a['candidate_commit'],b['candidate_commit']],cwd=R).decode().split('\0')[:-1]
assert set(names)==set(delta)
prior=obj(O/'ExactSubjectVerification.json');prior_rows={r['path']:r for r in prior['verified_files']}
# Batch reads are limited to six changed/new blobs; the other 153 reuse prior exact bytes and verify unchanged Git object IDs.
tree_lines=subprocess.check_output(['git','ls-tree','-r','-z',b['candidate_commit']],cwd=R).split(b'\0')
blob_map={}
for line in tree_lines:
 if line:
  meta,path=line.split(b'\t',1);blob_map[path.decode()]=meta.decode().split()[2]
verified=[]
for k,r in y.items():
 if k not in delta:
  assert blob_map[k]==prior_rows[k]['git_blob'] and r['sha256']==prior_rows[k]['sha256']
  assert sha((R/k).read_bytes())==r['sha256']
  verified.append(dict(r,git_blob=blob_map[k],method='UNCHANGED_BLOB_REUSE_AND_CURRENT_DIGEST'))
data=subprocess.check_output(['git','cat-file','--batch'],cwd=R,input=''.join(b['candidate_commit']+':'+k+'\n' for k in delta).encode())
offset=0
for k,r in delta.items():
 end=data.index(b'\n',offset);blob,kind,n=data[offset:end].decode().split();assert kind=='blob'
 offset=end+1;n=int(n);raw=data[offset:offset+n];offset+=n+1
 assert len(raw)==r['bytes'] and sha(raw)==r['sha256'] and (R/k).read_bytes()==raw
 verified.append(dict(r,git_blob=blob,method='NEW_EXACT_COMMIT_BLOB_AND_CURRENT_BYTES'))
assert offset==len(data)
exact={'result':'EXACT_R2_SUBJECT_MATCH','candidate_commit':b['candidate_commit'],'candidate_tree':tree,'subject_ref':ref(S/'ReviewSubject_20260907.r2.json'),'original_verification':ref(O/'ExactSubjectVerification.json'),'files_verified':159,'unchanged_verified_blob_reuses':153,'new_or_changed_blobs_verified':6,'only_implementation_change':changed,'verified_files':verified,'authority_effect':'NONE'}
(O/'ExactSubjectVerification.r2.json').write_text(json.dumps(exact,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
repair=obj(D/'ParentLinkGuardRepair.json');run=json.loads(repair['five_existing_executor_tests_rerun_on_repaired_code']['stdout'])
assert repair['repaired_executor_sha256']==sha((D/'migration_execute.py').read_bytes())=='15ed103a96943125978e9134a8322c6195f62fe24d3e2e070a8ad538b17ea2fe'
assert run['tests_run']==5 and run['failures']==run['errors']==run['skipped']==0
assert run['executor_sha256']==repair['repaired_executor_sha256'] and run['execution_inputs_sha256']==sha((D/'ExecutionInputs.candidate.json').read_bytes())=='37a6909deedae17dbfe97e844d8ec596c5de46e73c3cefafd4136008d3f3dcec'
assert repair['old_implementation_read_only_control_admitted_protected_target'] and repair['ordinary_path_allowed'] and repair['isolated_marker_unchanged']
assert len(repair['new_implementation_rejections'])==2
review=obj(S/'disposition-review/Review.json');original=obj(S/'preparation/Original40Assessment.preparation.json')
assert review['counts']=={'PASS':10,'REVISE':0,'tests_run':0,'new_dispositions_issued':0,'formal_condition_closures':0}
assert {r['condition_id'] for r in review['rows']}=={r['condition_id'] for r in original['rows'] if r['classification']=='B'}
assert review['subject']['proposal']['sha256']==sha((S/'preparation/StagedDispositionProposal.json').read_bytes())
assert review['subject']['root_selection']['sha256']==sha((S/'preparation/RootSelectedDispositions.candidate.json').read_bytes())
correction={'result':'RESOLVED_FOR_EXACT_SCOPED_EXECUTOR','reviewer':'/root/architecture_review','method':'Independently examined exact Git diff and retained focused control source; correlated old/new hashes, real junction rejection and five fixture outputs. No repeat of unchanged 152 checks or original nine compatibility tests.','independent_source_conclusions':['Every parent below the fixed root is tested for symlink/junction before use.','Containment remains required after resolution.','Original and resolved first components are casefolded against protected prefixes.','Fixed 64path/39lock input and Step7/8 sources have unchanged exact blobs.'],'implementation':ref(D/'migration_execute.py'),'repair_evidence':ref(D/'ParentLinkGuardRepair.json'),'retained_control_source':ref(D/'verify-migration-parent-guard.retained.py'),'root_report_reused_as_observed_execution_not_authority':True,'actual_current_migration_performed':False,'non_bypass_accepted':False,'subject_verification':ref(O/'ExactSubjectVerification.r2.json')}
(O/'ExecutorCorrectionVerification.json').write_text(json.dumps(correction,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
external={'disposition_review':ref(S/'disposition-review/Review.json'),'disposition_reviewer':'/root/evidence_review','executor_correction_refs':[ref(D/'migration_execute.py'),ref(D/'ParentLinkGuardRepair.json'),ref(O/'ExecutorCorrectionVerification.json')],'executor_correction_status':'RESOLVED_BY_EXACT_R2_EXECUTOR_REPAIR_AND_FOCUSED_EVIDENCE'}
(O/'FinalExternalBindings.json').write_text(json.dumps(external,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
print(json.dumps({'result':exact['result'],'files':159,'reused':153,'delta':6,'repair':correction['result'],'disposition_pass':10}))
