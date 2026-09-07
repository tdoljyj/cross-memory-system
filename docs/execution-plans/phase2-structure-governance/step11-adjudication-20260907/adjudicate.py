from pathlib import Path
import json,hashlib,zipfile,subprocess,datetime,fnmatch,copy
O=Path(__file__).resolve().parent;W=O.parent;R=W/'phase2-governance-check';G=R/'docs/execution-plans/phase2-structure-governance';D=G/'step12-migration-20260907'
sha=lambda b:hashlib.sha256(b).hexdigest()
def obj(p):return json.loads(p.read_bytes())
def ref(p,pointer=''):return {'path':str(p),'sha256':sha(p.read_bytes()),'pointer':pointer}
draft_path=W/'step11-original28-preparation/Rows.json';draft=obj(draft_path)
assert sha(draft_path.read_bytes())=='1e1a4e878634cee835e168d4dfe2558e04c91a1c0ecb71cfd65d59a1356f3ec3'
a_path=G/'ArchitectureConstitutionAcceptanceDecision_20260907.json';a=obj(a_path)
assert sha(a_path.read_bytes())=='f2ec1d6cf3afbd80d415c65c7bc0f71d86d606bda9031a174d92517e421ac246'
assert a['state']=='ACCEPTED' and a['commit']=='039cfea5a0d91a4e4e02702f6cfdfe9379978b1e'
assert a['independent_review']['sha256']=='3e5276969f1e92858815d88a20b77c8070ac68b8676e0d6d66dfde8c15136599'
for e in [a['exact_subject'],a['independent_review'],a['delegation']]+a['evidence']:
 assert sha((G/e['path']).read_bytes())==e['sha256']
subject=obj(G/a['exact_subject']['path'])
assert subject['candidate_tree']==a['tree'] and subject['candidate_commit']==a['commit']
zpath=next((W/'candidate-source').glob('*v0.2.7.1*.zip'));z=zipfile.ZipFile(zpath)
# Container bytes already independently hashed in Step9; only referenced metadata is read here.
cache={};evidence_checks=[]
def pointer(j,p):
 for raw in p.split('/')[1:] if p else []:
  k=raw.replace('~1','/').replace('~0','~');j=j[int(k)] if isinstance(j,list) else j[k]
 return j
def read_evidence(e):
 if 'member' in e: locator=str(zpath)+'!/'+e['member'];loader=lambda:z.read(e['member'])
 elif '!/' in e.get('locator',''):
  member=e['locator'].split('!/',1)[1];locator=str(zpath)+'!/'+member;loader=lambda:z.read(member)
 else:
  if 'path' in e:p=G/e['path'] if (G/e['path']).exists() else R/e['path']
  else:p=Path(e['locator'])
  locator=str(p);loader=p.read_bytes
 if locator not in cache:cache[locator]=loader()
 raw=cache[locator];assert sha(raw)==e['sha256'],locator
 value=pointer(json.loads(raw),e.get('pointer','')) if e.get('pointer') or locator.endswith('.json') else raw
 evidence_checks.append({'locator':locator,'sha256':sha(raw),'pointer':e.get('pointer',''),'resolved':True})
 return value
for e in draft['sources']:read_evidence(e)
for row in draft['rows']:
 original=read_evidence(row['original_source']);matrix=read_evidence(row['original_matrix_source'])
 assert original['condition_id']==row['condition_id'] and original['original_text']==row['original_text']==matrix
 for e in row['evidence']:read_evidence(e)
assert len(draft['rows'])==28 and len({r['condition_id'] for r in draft['rows']})==28
historical=read_evidence(draft['version_vector_selection']['historical_vector'])
assert len(historical['axes'])==18
current=read_evidence(draft['version_vector_selection']['current_axis_registry']);assert len(current)==10
for r in draft['version_vector_selection']['current_axis_selection']:
 actual=pointer({'axes':current},r['selector']);assert actual['axis']==r['axis']
oldtargets=read_evidence(draft['old_target_source']);assert len(oldtargets)==318
inputs=obj(D/'ExecutionInputs.candidate.json');assert sha((D/'ExecutionInputs.candidate.json').read_bytes())=='37a6909deedae17dbfe97e844d8ec596c5de46e73c3cefafd4136008d3f3dcec'
assert len(inputs['changes'])==64 and len(inputs['immutable_input_locks'])==39
assert sha((D/'migration_execute.py').read_bytes())=='15ed103a96943125978e9134a8322c6195f62fe24d3e2e070a8ad538b17ea2fe'
assert len({r['path'].casefold() for r in inputs['changes']})==64
target_checks=[]
for r in inputs['changes']:
 p=R/r['path'];before=sha(p.read_bytes()) if p.is_file() else None
 assert before==r['before_sha256'],r['path']
 assert Path(r['path']).parts[0].casefold() not in {'.git','memory','artifacts','apps','cloud','.codex','.agents'}
 if r['payload']:
  b=(D/r['payload']['path']).read_bytes();assert sha(b)==r['after_sha256']==r['payload']['sha256'] and len(b)==r['payload']['bytes']
 else:assert r['after_sha256'] is None
 target_checks.append({'path':r['path'],'before_sha256':r['before_sha256'],'after_sha256':r['after_sha256'],'phase':r['phase'],'verified':True})
for r in inputs['immutable_input_locks']:assert sha((R/r['path']).read_bytes())==r['sha256'],r['path']
plan=obj(D/'MigrationPlan.candidate.json');assert len(plan['all_23_map_row_dispositions'])==23
checks=copy.deepcopy(draft['required_check_selection'])
workflow_checks=[]
for c in checks['checks']:
 e=c['current_definition'];blob=e.get('git_blob_sha1') or subprocess.check_output(['git','rev-parse',e['commit']+':'+e['path']],cwd=R).decode().strip()
 b=subprocess.check_output(['git','cat-file','blob',blob],cwd=R)
 assert sha(b)==e['sha256'] and (R/e['path']).read_bytes()==b
 assert ('  '+c['job_id']+':') in b.decode('utf8')
 workflow_checks.append({'check_id':c['check_id'],'definition':e,'independently_read':True,'class':c['original_class']})
paths=subprocess.check_output(['git','diff','--name-only','-z','40fea9e0fcd4d061946d0523f645c40893fced2b',a['commit']],cwd=R).decode().split('\0')[:-1]
assert len(paths)==159 and set(paths)=={r['path'] for r in subject['supplementary_files']}
policies={'memory-publication-gate':['memory/**','artifacts/clued-two-level-snapshots/**','scripts/verify-memory-publication.mjs','.github/workflows/memory-publication-gate.yml'],'clued-g4-database':['.github/workflows/clued-g4-database.yml','apps/clued-cloud/package.json','apps/clued-cloud/package-lock.json','apps/clued-cloud/supabase/**']}
conditional=[]
for id,patterns in policies.items():
 matches={k:[p for p in v if any(fnmatch.fnmatchcase(p,pat) for pat in patterns)] for k,v in {'candidate_supplement':paths,'migration':[r['path'] for r in inputs['changes']]}.items()}
 assert not any(matches.values());conditional.append({'check_id':id,'patterns_read_from_workflow':patterns,'matches':matches,'effect':'NOT_REQUIRED_FOR_THESE_EXACT_TWO_CHANGESETS; RECOMPUTE_ON_CHANGE; NOT_RUNTIME_PASS'})
checks['selection_state']='INDEPENDENTLY_ADJUDICATED_DESIGN_SELECTION_FOR_ROOT_FREEZE'
checks['changeset_evidence']['actual_supplement_diff']['paths']=paths
checks['changeset_evidence']['actual_supplement_diff']['paths_lf_utf8_sha256']=sha(('\n'.join(paths)+'\n').encode())
checks['independent_conditional_assessment']=conditional
vector=copy.deepcopy(draft['version_vector_selection']);vector['actual_subject_overlay']['architecture_acceptance']=ref(a_path)
vector['actual_subject_overlay']['architecture_state']='ACCEPTED_WITH_EXACT_STEP10_SCOPE';vector['actual_subject_overlay']['migration_executor']=ref(D/'migration_execute.py')
vector['freeze_effect']='This review selects exact applicable axes; the actual root Freeze adds its own decision identity externally, avoiding self-hash cycles.'
source_report={'type':'IndependentOriginal28SourceAndBindingChecks','reviewer':'/root/architecture_review','actual_step10':ref(a_path),'draft':ref(draft_path),'source_checks':evidence_checks,'unique_source_bytes_read':len(cache),'original_rows_and_text_verified':28,'current_vector_axes':10,'historical_vector_axes':18,'old_target_dispositions':318,'workflow_definitions':workflow_checks,'conditional_applicability':conditional,'exact_candidate_paths':159,'target_checks':target_checks,'immutable_locks':inputs['immutable_input_locks'],'prior_exact_executor_review':ref(W/'step09-independent-final/ExecutorCorrectionVerification.json'),'tests_rerun':0,'business_memory_reads':0,'repository_mutations':0}
(O/'SourceAndBindingChecks.json').write_text(json.dumps(source_report,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
reasons={
'F-MAJ-001/C1':'I read the actual protocol manifest claim_boundary: local G1 allowance is separate from authority_effect NONE and v3.3 cryptographic conformance false. The historical vector agrees; no full cutover is inferred.',
'F-MAJ-001/C2':'The conditional antecedent full G1 passed is not selected or evidenced. C3 is the applicable branch; retaining a later exact receipt is legitimate and is not a waived failed current check.',
'F-MAJ-001/C3':'Freeze can explicitly adopt the exact v3.3 pre-G1 normative contract and false executable authority while preserving the distinct Clued-v1.6 service axis. Root must include that scope declaration; current projections must not promote historical local qualification.',
'F-MAJ-003/C1':'Exact historical typed source and current accepted registry resolve independently as 18 historical and 10 currently selected axes. The selection reuses owning sources instead of creating a competing global version.',
'F-MAJ-003/C2':'Each historical axis preserves its observed status and supersession/compatibility evidence; actual Step10 is now explicitly overlaid on architecture v0.2.5. Unspecified compatibility and dormant runtime values retain their limits.',
'F-MAJ-003/C3':'The signing selection below binds current registry, historical qualifiers, actual package/predecessor/commit/tree, Step4–8, actual Step10, target inputs and guarded executor. Subsequent actual receipt/run identity remains due when that run exists.',
'F-MAJ-004/C1':'I checked all nine exact workflow definitions and job identities. Four BASE_CORE remain required, two conditions are recomputed against the unquoted exact Git delta and selected 64 paths, and the original limited aggregator and two Phase2 supplements do not replace base checks.',
'F-MAJ-004/C2':'The latest baseline explicitly defines Freeze as preceding production enforcement and old-entry closure. Thus current design selection can freeze while actual protected branch or equivalent scoped consumption boundary must be proved in Steps15/18. Sole-admin observation alone does not satisfy it.',
'F-MAJ-004/C3':'No signature chain is proved here. Digest binding is not a signature. The unchanged exact signature/attestation requirement is retained for the actual Step18 protected publication and Step19 durable evidence, without requiring a new signer/service now.',
'F-MAJ-004/C4':'No branch is currently proved a disposable merged duplicate. This does not block freezing a logical target. Root must perform bounded applicable duplicate disposition before Step19; deletion of active/unmerged work is not authorized by this row.',
'F-MAJ-011/C1':'The exact general governance source and profiles preserve common control facets with domain-specific projections. Actual Step10 now accepts the applicable contract; source authorship is not counted as independent runtime evidence.',
'F-MAJ-011/C2':'Actual Step10 binds delegated root acceptance, separate Step9 reviewer and producer roles. This review is independently after that decision; later publish/production/rollback need their own actual results.',
'F-MAJ-011/C3':'The website profile is a selected domain projection of shared semantics. It cannot issue rights in other domains, and inactive website/production obligations are not required to be implemented for this structure.',
'F-MAJ-014/C1':'The final 64 targets exclude protected payload roots, all 39 source locks match, and TM17–19 are source-reference indexes/projections. No target makes User Bundle or memory payload a development authority. Actual no-change proof remains Step17.',
'F-MAJ-014/C2':'Previously independently verified source-built router preserves default NONE and read-only exported snapshot boundaries. Final payload remains digest-identical. Freezing its target does not activate memory loading or execution authority.',
'F-MAJ-014/C3':'Actual Step10 explicitly accepts private historical preservation while forbidding current sensitive payload redistribution. The exact historical hints remain acknowledged; public-safe status is not granted. Final Skill/distribution artifact checks remain due.',
'F-MAJ-014/C4':'The explicit current-directory amendment and actual Step10 scope permit bounded current access review. They do not sanitize historical NOT_GRANTED or certify untouched Library copies. No new concrete exposure was identified in this bounded review.',
'F-MAJ-016/C1':'The source-owned 13-type crosswalk and accepted Step5/6 contracts provide concrete typed names for Freeze. Final acceptance does not create commerce entitlement, inactive consumers or a new runtime authority.',
'F-MAJ-016/C2':'Technical qualification, distribution, availability and entitlement are distinct source fields/relations. This is a current structural invariant; actual consumer evidence remains required when affected consumers run.',
'F-MAJ-016/C3':'The rule that Product/Store project only current owning facts is applicable as a contract. Those dormant product consumers are not selected for implementation, and no runtime PASS is inferred from their absence.',
'F-MAJ-017/C1':'Actual Step10 fixes r2 commit/tree and the independently reviewed 159-file subject. I rechecked the fixed 64 source-before/target digests and 39 locks for this Freeze. Historical 9bc source ancestry remains historical, not current HEAD.',
'F-MAJ-017/C2':'Step10 accepts responsibility/type boundaries at architecture v0.2.5. Concrete directories are only chosen by the separate Freeze now; no nonexistent Architecture v1.0 release is asserted.',
'F-MAJ-017/C3':'The binding envelope below resolves the sole 64-path execution selection, all 23 original map dispositions, three DCP target categories, final payload hashes, exact actual Step10 and corrected executor. Old pending prose is preserved as historical preparation and cannot override these final selections.',
'F-MAJ-017/C4':'The exact old-target source resolves to 318 dispositions and is distinguished from the current 23-row responsibility map and 64 physical paths. Its unchanged-byte inheritance was independently checked in Step9; current endpoint compatibility/sealing is still due after migration.',
'F-MAJ-018/C1':'Actual Step10 accepts original preregistered metrics and workstream ceiling, excluding new experimental spending. The source thresholds are not modified and no product measurement result is fabricated.',
'F-MAJ-018/C2':'Actual Step10 contains an identifiable accepted ProgramCriticalPathDecision for PHASE2-CORE-SLICE-A, with common readiness preserved and inactive full model/store exclusions. This is no longer an unsigned draft prerequisite.',
'F-MAJ-018/C3':'These future domains have not been selected. Their own budget, GO/NO-GO, rights and qualification gates remain required before activation; they cannot globally block unrelated current structure selection.',
'F-MAJ-018/C4':'Step7/8 actual source-to-projection-to-validator execution already has separate independent evidence. The latest fixed order retains real migration, changed-consumer, gate, no-change and non-bypass execution at Steps12–19. Schema/receipt presence alone never suffices.'}
assert set(reasons)=={r['condition_id'] for r in draft['rows']}
rows=[]
for r in draft['rows']:
 q=copy.deepcopy(r);q['draft_author_statement_reused_as_independent_proof']=False
 q['independent_adjudication']='READY_FOR_SCOPED_FREEZE_WITH_RETAINED_OBLIGATIONS'
 q['independent_reason']=reasons[r['condition_id']];q['adjudicated_after_actual_step10']=True
 q['current_structure_review_requirement_satisfied']=True;q['entire_original_condition_globally_closed']=False
 q['actual_step10_evidence']=ref(a_path);q['independent_binding_evidence']=ref(O/'SourceAndBindingChecks.json')
 q['authority_effect']='INDEPENDENT_STRUCTURE_REVIEW_ONLY; ROOT_MUST_ISSUE_FREEZE'
 rows.append(q)
bindings={'actual_architecture_acceptance':ref(a_path),'exact_review_subject':ref(G/a['exact_subject']['path']),'step9_independent_review':ref(G/a['independent_review']['path']),'scoped_acceptances':[ref(G/e['path']) for e in a['evidence']],'canonical_namespaces_ownership_domain_registry':ref(G/'Step04-ScopedAcceptance_20260907.json'),'version_vocabulary_logical_representation_copy_rules':ref(G/'Step05-ScopedAcceptance_20260907.json'),'typed_receipt_authorization_consumer_contract':ref(G/'Step06-ScopedAcceptance_20260907.json'),'deterministic_projection_contract':ref(G/'step07-projection-20260907/ProjectionBindings.repository.json'),'exact_projection_execution_acceptance':ref(G/'Step08-ScopedAcceptance_20260907.json'),'unique_final_execution_map':ref(D/'ExecutionInputs.candidate.json'), 'execution_map_pointers':['/changes','/immutable_input_locks','/source_map_rows','/dcp_map_rows','/projection_integrity','/rollback_rule'],'source_preserving_logical_map':ref(D/'MigrationPlan.candidate.json','/all_23_map_row_dispositions'),'old_to_new_history_resolution':ref(D/'HistoryPathMap.candidate.json'),'corrected_executor':ref(D/'migration_execute.py'),'corrected_executor_review':ref(W/'step09-independent-final/ExecutorCorrectionVerification.json'),'target_count':64,'source_lock_count':39,'original_map_rows':23,'physical_target_rows':target_checks,'immutable_source_locks':inputs['immutable_input_locks'],'g1_authority_selection':draft['g1_scope_selection'],'typed_version_vector_selection':vector,'required_check_selection':checks,'dcp_self_reference_rule':'TM19 is explicitly only prior accepted decision references. Actual Step10 and eventual Freeze are externally bound in this envelope, not recursively embedded in the hash of the same target output; this creates no missing authority or new authority index.','frozen_map_equivalence_rule':'Use the exact selected ExecutionInputs and original map-row dispositions as equivalent FrozenTargetMap/CurrentToTargetMap; do not manufacture a duplicate authoritative map. At root issuance the selected references acquire scoped frozen effect, while original candidate source bytes keep historical status.'}
report={'type':'IndependentOriginal28StructureAdjudication','review_id':'CLUED_PHASE2_ORIGINAL28_INDEPENDENT_ADJUDICATION_20260907','issued_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'reviewer':'/root/architecture_review','result':'READY_FOR_ROOT_SCOPED_STRUCTURE_FREEZE','actual_step10':ref(a_path),'draft_source':ref(draft_path),'independence':{'draft_author':'/root/evidence_review','reviewer_authored_original28_draft':False,'reviewer_authored_migration_implementation':False,'reviewer_previously_authored_original40_proposals':True,'overlapping_proposals_previously_separately_reviewed_and_now_actually_accepted':True,'prior_step9_evidence_reused_only_for_exact_unchanged_scope':True},'original_condition_count':28,'original_group_count':8,'rows':rows,'freeze_binding_envelope':bindings,'independent_checks':ref(O/'SourceAndBindingChecks.json'),'blocking_findings':[],'root_issuance_requirements':['Bind this whole original28 adjudication and actual Step10 digest in the separate real Freeze.','Adopt all exact envelope selections; no unresolved final target, mutable source locator or original vulnerable executor.','Retain every row obligation and G1/typed-vector/check applicability qualifiers; do not translate READY into global runtime closure.','Freeze only current logical structure and exact migration target. Before writing, independently recheck the same source/target hashes and locks; drift reopens affected bindings.'],'stage_separation':{'current':'Logical naming/contracts, ownership, exact target and migration binding are ready for root Freeze.','steps12_14':'Actual migration, changed consumer wiring and legacy sealing remain due.','step15':'Actual comparison/check integration at the selected write/CI boundary remains due.','step16_17':'Fresh applicable gates and Canonical Semantic No-Change remain due.','step18_19':'Mandatory-boundary, applicable signature/attestation, complete receipt custody and bounded duplicate-branch disposition remain due before closeout.','future':'Unselected model, commerce and product measurement retain activation-specific obligations without new current spending.'},'formal_structure_adjudication_performed':True,'freeze_issued':False,'physical_migration_performed':False,'step18_pass':False,'waivers_issued':0,'entire_original_conditions_globally_closed':0,'authority_effect':'INDEPENDENT_REVIEW_ONLY; NOT_A_FREEZE_DECISION','invalidation':'Affected source/decision/target/executor/check-policy drift reopens only related I1–I8 dependencies. Future actual execution results cannot be inherited from this review.'}
(O/'Adjudication.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
(O/'Adjudication.md').write_text('# Original 28 — independent structure adjudication\n\nReady for root scoped Structure Freeze after actual Step10. All 28 original IDs, texts and evidence pointers are retained in the machine report.\n\nThe freeze envelope binds the exact r2 subject, actual architecture acceptance, 64 target paths, 39 immutable locks, all 23 map dispositions, the three DCP categories, typed version/check selections and repaired executor. No unresolved target is accepted.\n\nThis review does not issue Freeze or claim migration, production enforcement or Step18 PASS. Later fixed-stage and inactive-domain obligations remain intact. No unchanged tests were rerun.\n',encoding='utf8')
print(json.dumps({'result':report['result'],'rows':28,'source_checks':len(evidence_checks),'source_files':len(cache),'targets':64,'locks':39,'sha256':sha((O/'Adjudication.json').read_bytes()),'bytes':(O/'Adjudication.json').stat().st_size}))
