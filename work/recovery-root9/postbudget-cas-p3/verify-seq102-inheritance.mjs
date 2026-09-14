#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const sql=fs.readFileSync(path.join(here,'reserve_gate.seq102-inheritance.fragment.sql'),'utf8');
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const C={
 root:'ctr_414bd3c724264a83894b0c55cf2ab878',root9:'ctrgen_308a1dfc185cff633892638581e0a34c',
 oldController:'c76438600d93d708ffe312c5980d8574f649836b65ae523daab0271e7fc9ff1b',
 controller:'c0b49c6a782efe219485486c120c05a7b5e7171394194cebc8b7aec76047d10a',
 oldQualification:'171828b556756186ed30b88928855fb8e6607f799911bf63214e9505fa984c71',
 qualification:'a48aa5934112cc968c622c200c7b994d7b928e0bb3d433b49b3d741680a57013',
 oldAcceptance:'107fe912496392a0a677f103feb395321292231db4459d1a9a0f170573125cb9',
 acceptance:'c1456fd186da21a707693af18f3dce5fdf1dcd54d7cc1b3c661290476f162552',
 budgetSha:'51eeb017ff28e5c15848a726de43436fe8421a8c574c0cdbdbce84a1aefc9e2a',
 profile:'d1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5',
 scope:'115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5',
 gate:'3487d9fc6ccee5478569021961eac93bf5ef6bd4bc2428559b20a44abb9c155a',
 runner:'runnergen_a256855fec9441839105c69b746c5244',credential:'credgen_bac92a11e7144a3fb9e67f40a6a07d11',session:'sessiongen_ffb02a907d334b0da0b37bf457a758c2',
 notBefore:'2026-09-14T03:00:00Z',expires:'2026-09-15T03:00:00Z',binding:'sb_201178b7a8111000d515f7f26a75a28b',
 p2Uri:'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/bfc65714f9b596c6140c745948185e92665a48dd',p2Sha:'dec179df0626c5f22bb33a979336430dd136c8a54895666bae2ce4b2b0eae887',
 p3Uri:'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/'+'3'.repeat(40),p3Sha:'3'.repeat(64),reviewUri:'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/'+'4'.repeat(40),reviewSha:'4'.repeat(64)
};
const acceptanceRaw=fs.readFileSync(path.join(here,'fixture.RuntimeAcceptance.root9.postbudget.json'),'utf8');
const qualificationRaw=fs.readFileSync(path.join(here,'fixture.ControllerQualification.root9.postbudget.candidate.json'),'utf8');
const previousBinding=()=>({root_id:C.root,profile_sha256:C.profile,controller_sha256:C.oldController,qualification_sha256:C.oldQualification,scope_sha256:C.scope,gate_id:'G-PREENTRY-SKILL-QUALIFICATION',gate_version:'fixed-synthetic-20260910.v10-env-order-repair',gate_sha256:C.gate,runtime_acceptance_sha256:C.oldAcceptance,prior_seconds:1506,prior_evidence_bytes:322546611});
const replacementBinding=()=>({...previousBinding(),controller_sha256:C.controller,qualification_sha256:C.qualification,runtime_acceptance_sha256:C.acceptance});
const inheritance=()=>({budget_sequence:102,budget_reservation_ref:{uri:'urn:clued:control-evidence:uscrdifznmlvczcekqpw:execution-events:102',sha256:C.budgetSha},original_controller_sha256:C.oldController,replacement_controller_sha256:C.controller,root_generation:C.root9,profile_sha256:C.profile,scope_sha256:C.scope,runner_generation:C.runner,credential_generation:C.credential,session_generation:C.session,reason:'POST_BUDGET_ROOT9_DYNAMIC_SIGNING_REPAIR',additional_allocation:false,automatic_refund:false,remaining_seconds:600,remaining_evidence_bytes:134217728});
const canon=v=>Array.isArray(v)?'['+v.map(canon).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canon(v[k])).join(',')+'}':JSON.stringify(v);
const digest=v=>sha(canon(v));
const deep=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const exactKeys=(v,keys)=>deep(Object.keys(v).sort(),[...keys].sort());
const repairRefs=()=>[
 {ga_id:'ga_04377008dc04437d9ee9d28a3c79ff3a',receipt_sha256:'b27286d6fcb54e34a62d8738f49c1ecafe3210c9a321a703c3828e38497e434c',budget_sequence:46},
 {ga_id:'ga_4e7ce4ad385e4f5aa633bcea2ddb71ce',receipt_sha256:'2fd3b68be76b3f4efcf10050d6c908bcb79c8d5a3e22290e18f582d780b53b7e',budget_sequence:51},
 {ga_id:'ga_1d52f4778d494399b12aea54fe4a189e',receipt_sha256:'3a311d678ed563d5dd1492ef53675fcba8e985dccf3880d032ca2029168fedf9',budget_sequence:59},
 {ga_id:'ga_6abb193a56304029a788f7cb624a0d35',receipt_sha256:'0bd435f4fd4bb9c4174a1d96b132908f128ceadcfa51021ba1871757ed16df77',budget_sequence:68},
 {ga_id:'ga_71a1d946fca34c1e9e700c80a546b3ad',receipt_sha256:'90955f5c896d8a76f65458fe36bff5d321b2d3d92d1ed10f1857f8628cb83bed',budget_sequence:73},
 {ga_id:'ga_41643fece183424daf7f05b8b2868f8e',receipt_sha256:'9a75bf4694d1584a51adbeb7c2497da62f6266e2654da9e0189ff2a43a87a0be',budget_sequence:77},
 {ga_id:'ga_e56ca0eb07304f2fbcf60eb8f29f3889',receipt_sha256:'74afd52096ce817ad2da9e5af8ce63e7f95705a13702ad7f12edce8fa4d4a4f5',budget_sequence:81},
 {ga_id:'ga_8eb410609e294d899806a319e6615f2b',receipt_sha256:'ee250a365f879f99aa41bf45274296cadc6f11d26567dc15c6be3c8778e4b533',budget_sequence:85}
];
const statusRef=()=>({uri:'control://status-manifests/sm_root9_status27_postbudget_signing_repair_v1',sha256:'1'.repeat(64)});
const baseline=()=>{
 const allocation={controller_digest:C.oldController,credential_generation:C.credential,environment:'ISOLATED_TEST',evidence_bytes:134217728,expires_at:C.expires,idempotency_key:'root9_final_skill_qualification_budget_v1',not_before:C.notBefore,profile_digest:C.profile,purpose:'SKILL_COEXISTENCE_QUALIFICATION',root_generation:C.root9,runner_generation:C.runner,scope_digest:C.scope,seconds:600,session_generation:C.session};
 const evidence={authority_effect:'NONE',controller_file_count:23,defect_code:'ROOT9_DYNAMIC_SIGNING_HELPER_NOT_MANIFEST_COVERED',independent_review_ref:{uri:C.reviewUri,sha256:C.reviewSha},new_controller_sha256:C.controller,new_qualification_sha256:C.qualification,new_runtime_acceptance_sha256:C.acceptance,p2_publication_ref:{uri:C.p2Uri,sha256:C.p2Sha},p3_publication_ref:{uri:C.p3Uri,sha256:C.p3Sha},pending_budget_inheritance:inheritance(),required_repair_refs:repairRefs(),status_manifest_ref:statusRef()};
 const evidenceSha=digest(evidence);
 const correction={sequence:103,recordingTransactionId:'xid-p3',idempotency_key:'root9_postbudget_dynamic_signing_repair_v1_qualification',request:{operation:'SUCCESSOR_BINDING_QUALIFICATION_CORRECTED',body:{binding_id:C.binding,supersedes_execution_sequence:100,status_manifest_ref:statusRef(),evidence,evidence_sha256:evidenceSha}}};
 const replacement=replacementBinding();
 const repoint={sequence:104,recordingTransactionId:'xid-p3',idempotency_key:'root9_postbudget_dynamic_signing_repair_v1_repoint',request:{operation:'EXECUTION_RUNTIME_ACCEPTANCE_REPOINTED',body:{binding_id:C.binding,supersedes_execution_sequence:101,qualification_correction_sequence:103,previous_binding:previousBinding(),previous_binding_sha256:digest(previousBinding()),new_binding:replacement,new_binding_sha256:digest(replacement),old_runtime_acceptance_sha256:C.oldAcceptance,new_runtime_acceptance_sha256:C.acceptance,acceptance_raw:acceptanceRaw,acceptance_sha256:C.acceptance,qualified_evidence:evidence,pending_budget_inheritance:inheritance()}}};
 return {allocation,budget:{sequence:102,idempotency_key:'root9_final_skill_qualification_budget_v1',request:{operation:'BUDGET_RESERVED',body:{raw:'sealed-raw',sha256:C.budgetSha}},rawSha:C.budgetSha},current:{root_id:C.root,sequence:104,pending_budget_sequence:102,active_ga_id:null,charged_seconds:11106,charged_evidence_bytes:2470030259,runner_generation:C.runner,credential_generation:C.credential,session_generation:C.session},window:{root_id:C.root,generation_id:C.root9,is_successor:true,budget_sequence_floor:98,not_before:C.notBefore,expires_at:C.expires},binding:{...replacement},ga:{root_generation:C.root9,profile:C.profile,controller:C.controller,scope:C.scope,qualification:C.qualification,runner:C.runner,credential:C.credential,session:C.session,status_manifest_ref:statusRef()},root9Qualification:{sequence:100,operation:'SUCCESSOR_BINDING_QUALIFIED',required_repair_refs:repairRefs()},correction,repoint,currentXid:'xid-gate',expectedEvidenceSha:evidenceSha};
};
function accepts(x){
 const {allocation:a,budget, current:c,window:w,binding:b,ga:g,root9Qualification:o,correction:q,repoint:r}=x;
 if(a.root_generation!==g.root_generation||a.profile_digest!==g.profile||a.scope_digest!==g.scope||a.runner_generation!==g.runner||a.credential_generation!==g.credential||a.session_generation!==g.session)return false;
 if(a.controller_digest===g.controller)return true;
 if(!exactKeys(a,['controller_digest','credential_generation','environment','evidence_bytes','expires_at','idempotency_key','not_before','profile_digest','purpose','root_generation','runner_generation','scope_digest','seconds','session_generation']))return false;
 if(!deep(a,{controller_digest:C.oldController,credential_generation:C.credential,environment:'ISOLATED_TEST',evidence_bytes:134217728,expires_at:C.expires,idempotency_key:'root9_final_skill_qualification_budget_v1',not_before:C.notBefore,profile_digest:C.profile,purpose:'SKILL_COEXISTENCE_QUALIFICATION',root_generation:C.root9,runner_generation:C.runner,scope_digest:C.scope,seconds:600,session_generation:C.session}))return false;
 if(budget.sequence!==102||budget.idempotency_key!=='root9_final_skill_qualification_budget_v1'||!exactKeys(budget.request,['operation','body'])||budget.request.operation!=='BUDGET_RESERVED'||!exactKeys(budget.request.body,['raw','sha256'])||budget.request.body.sha256!==C.budgetSha||budget.rawSha!==C.budgetSha)return false;
 if(!deep(c,{root_id:C.root,sequence:104,pending_budget_sequence:102,active_ga_id:null,charged_seconds:11106,charged_evidence_bytes:2470030259,runner_generation:C.runner,credential_generation:C.credential,session_generation:C.session}))return false;
 if(!deep(w,{root_id:C.root,generation_id:C.root9,is_successor:true,budget_sequence_floor:98,not_before:C.notBefore,expires_at:C.expires}))return false;
 if(!deep(b,replacementBinding()))return false;
 if(!deep(g,{root_generation:C.root9,profile:C.profile,controller:C.controller,scope:C.scope,qualification:C.qualification,runner:C.runner,credential:C.credential,session:C.session,status_manifest_ref:statusRef()}))return false;
 if(o.sequence!==100||o.operation!=='SUCCESSOR_BINDING_QUALIFIED'||!deep(o.required_repair_refs,repairRefs()))return false;
 if(q.sequence!==103||!q.recordingTransactionId||q.recordingTransactionId===x.currentXid||q.idempotency_key!=='root9_postbudget_dynamic_signing_repair_v1_qualification'||q.request.operation!=='SUCCESSOR_BINDING_QUALIFICATION_CORRECTED'||!exactKeys(q.request,['operation','body'])||!exactKeys(q.request.body,['binding_id','supersedes_execution_sequence','status_manifest_ref','evidence','evidence_sha256'])||q.request.body.binding_id!==C.binding||q.request.body.supersedes_execution_sequence!==100)return false;
 const e=q.request.body.evidence;
 if(!exactKeys(e,['authority_effect','controller_file_count','defect_code','independent_review_ref','new_controller_sha256','new_qualification_sha256','new_runtime_acceptance_sha256','p2_publication_ref','p3_publication_ref','pending_budget_inheritance','required_repair_refs','status_manifest_ref']))return false;
 if(q.request.body.evidence_sha256!==digest(e)||q.request.body.evidence_sha256!==x.expectedEvidenceSha)return false;
 if(e.authority_effect!=='NONE'||e.controller_file_count!==23||e.defect_code!=='ROOT9_DYNAMIC_SIGNING_HELPER_NOT_MANIFEST_COVERED'||e.new_controller_sha256!==C.controller||e.new_qualification_sha256!==C.qualification||e.new_runtime_acceptance_sha256!==C.acceptance||!deep(e.pending_budget_inheritance,inheritance()))return false;
 if(!deep(q.request.body.status_manifest_ref,g.status_manifest_ref)||!deep(e.status_manifest_ref,g.status_manifest_ref)||!exactKeys(g.status_manifest_ref,['uri','sha256']))return false;
 if(!deep(e.p2_publication_ref,{uri:C.p2Uri,sha256:C.p2Sha})||!deep(e.p3_publication_ref,{uri:C.p3Uri,sha256:C.p3Sha})||!deep(e.independent_review_ref,{uri:C.reviewUri,sha256:C.reviewSha})||!deep(e.required_repair_refs,o.required_repair_refs)||e.required_repair_refs.length!==8)return false;
 if(r.sequence!==104||!r.recordingTransactionId||r.recordingTransactionId===x.currentXid||r.recordingTransactionId!==q.recordingTransactionId||r.idempotency_key!=='root9_postbudget_dynamic_signing_repair_v1_repoint'||r.request.operation!=='EXECUTION_RUNTIME_ACCEPTANCE_REPOINTED'||!exactKeys(r.request,['operation','body'])||!exactKeys(r.request.body,['acceptance_raw','acceptance_sha256','binding_id','new_binding','new_binding_sha256','new_runtime_acceptance_sha256','old_runtime_acceptance_sha256','pending_budget_inheritance','previous_binding','previous_binding_sha256','qualification_correction_sequence','qualified_evidence','supersedes_execution_sequence']))return false;
 const rb=r.request.body;
 return rb.binding_id===C.binding&&rb.supersedes_execution_sequence===101&&rb.qualification_correction_sequence===103&&deep(rb.previous_binding,previousBinding())&&rb.previous_binding_sha256===digest(previousBinding())&&deep(rb.new_binding,replacementBinding())&&rb.new_binding_sha256===digest(replacementBinding())&&rb.old_runtime_acceptance_sha256===C.oldAcceptance&&rb.new_runtime_acceptance_sha256===C.acceptance&&rb.acceptance_sha256===C.acceptance&&sha(rb.acceptance_raw)===C.acceptance&&deep(rb.pending_budget_inheritance,inheritance())&&deep(rb.qualified_evidence,q.request.body.evidence);
}

const results=[];
const test=(name,fn)=>{try{fn();results.push({name,status:'PASS'});}catch(e){results.push({name,status:'FAIL',error:e.message});}};
test('positive-exact-seq102-inheritance',()=>assert.equal(accepts(baseline()),true));
test('ordinary-equal-controller-path-preserved',()=>{const x=baseline();x.allocation.controller_digest=x.ga.controller;assert.equal(accepts(x),true);});
const mutations=[
 ['budget-sequence',x=>x.budget.sequence=101],['budget-sha',x=>x.budget.request.body.sha256='0'.repeat(64)],['budget-raw-sha',x=>x.budget.rawSha='0'.repeat(64)],['budget-operation',x=>x.budget.request.operation='OTHER'],['budget-idempotency',x=>x.budget.idempotency_key='other'],['budget-request-extra-key',x=>x.budget.request.extra=true],['budget-body-extra-key',x=>x.budget.request.body.extra=true],
 ['allocation-extra-key',x=>x.allocation.extra=true],['allocation-old-controller',x=>x.allocation.controller_digest='0'.repeat(64)],['allocation-root',x=>x.allocation.root_generation='other'],['allocation-profile',x=>x.allocation.profile_digest='0'.repeat(64)],['allocation-scope',x=>x.allocation.scope_digest='0'.repeat(64)],['allocation-runner',x=>x.allocation.runner_generation='other'],['allocation-credential',x=>x.allocation.credential_generation='other'],['allocation-session',x=>x.allocation.session_generation='other'],['allocation-window',x=>x.allocation.expires_at='2026-09-15T02:59:59Z'],['allocation-seconds',x=>x.allocation.seconds=601],['allocation-bytes',x=>x.allocation.evidence_bytes++],
 ['current-sequence',x=>x.current.sequence=105],['current-pending',x=>x.current.pending_budget_sequence=null],['current-active',x=>x.current.active_ga_id='ga_x'],['charged-seconds',x=>x.current.charged_seconds++],['charged-bytes',x=>x.current.charged_evidence_bytes++],
 ['window-root',x=>x.window.generation_id='other'],['window-floor',x=>x.window.budget_sequence_floor=99],['binding-controller',x=>x.binding.controller_sha256='0'.repeat(64)],['binding-qualification',x=>x.binding.qualification_sha256='0'.repeat(64)],['binding-acceptance',x=>x.binding.runtime_acceptance_sha256='0'.repeat(64)],
 ['ga-controller',x=>x.ga.controller='0'.repeat(64)],['ga-qualification',x=>x.ga.qualification='0'.repeat(64)],
 ['status-ref-seq103-body',x=>x.correction.request.body.status_manifest_ref.sha256='0'.repeat(64)],['status-ref-correction-evidence',x=>x.correction.request.body.evidence.status_manifest_ref.sha256='0'.repeat(64)],['status-ref-ga',x=>x.ga.status_manifest_ref.sha256='0'.repeat(64)],['status-ref-ga-extra-key',x=>x.ga.status_manifest_ref.signed_payload_sha256='2'.repeat(64)],
 ['seq100-repair-refs',x=>x.root9Qualification.required_repair_refs[0].budget_sequence=47],['seq103-missing',x=>x.correction.sequence=null],['seq103-txid-null',x=>x.correction.recordingTransactionId=null],['seq103-txid-current',x=>x.correction.recordingTransactionId=x.currentXid],['seq103-extra-body-key',x=>x.correction.request.body.extra=true],['seq103-evidence-extra-key',x=>x.correction.request.body.evidence.extra=true],['seq103-evidence',x=>x.correction.request.body.evidence.new_qualification_sha256='0'.repeat(64)],['seq103-canonical-digest',x=>x.correction.request.body.evidence_sha256='0'.repeat(64)],['p2-publication-ref',x=>x.correction.request.body.evidence.p2_publication_ref.sha256='0'.repeat(64)],['p3-publication-ref',x=>x.correction.request.body.evidence.p3_publication_ref.sha256='0'.repeat(64)],['review-ref',x=>x.correction.request.body.evidence.independent_review_ref.sha256='0'.repeat(64)],['repair-ref-value',x=>x.correction.request.body.evidence.required_repair_refs[0].receipt_sha256='0'.repeat(64)],['repair-ref-count',x=>x.correction.request.body.evidence.required_repair_refs.pop()],['repair-ref-extra-key',x=>x.correction.request.body.evidence.required_repair_refs[0].extra=true],
 ['seq104-sequence',x=>x.repoint.sequence=105],['seq104-txid-null',x=>x.repoint.recordingTransactionId=null],['seq104-txid-current',x=>x.repoint.recordingTransactionId=x.currentXid],['seq104-txid-different',x=>x.repoint.recordingTransactionId='xid-other'],['seq104-idempotency',x=>x.repoint.idempotency_key='other'],['seq104-extra-body-key',x=>x.repoint.request.body.extra=true],['seq104-old-binding',x=>x.repoint.request.body.previous_binding.controller_sha256='0'.repeat(64)],['seq104-old-binding-sha',x=>x.repoint.request.body.previous_binding_sha256='0'.repeat(64)],['seq104-new-binding',x=>x.repoint.request.body.new_binding.controller_sha256='0'.repeat(64)],['seq104-new-binding-sha',x=>x.repoint.request.body.new_binding_sha256='0'.repeat(64)],
 ['inheritance-extra-key',x=>x.repoint.request.body.pending_budget_inheritance.extra=true],['inheritance-new-controller',x=>x.repoint.request.body.pending_budget_inheritance.replacement_controller_sha256='0'.repeat(64)],['inheritance-new-allocation',x=>x.repoint.request.body.pending_budget_inheritance.additional_allocation=true],['inheritance-refund',x=>x.repoint.request.body.pending_budget_inheritance.automatic_refund=true],['inheritance-seconds',x=>x.repoint.request.body.pending_budget_inheritance.remaining_seconds=599],['inheritance-bytes',x=>x.repoint.request.body.pending_budget_inheritance.remaining_evidence_bytes--],['qualified-evidence-divergence',x=>x.repoint.request.body.qualified_evidence={different:true}],['acceptance-raw-sha',x=>x.repoint.request.body.acceptance_raw+=' ']
];
for(const [name,mutate] of mutations)test('reject-'+name,()=>{const x=structuredClone(baseline());mutate(x);assert.equal(accepts(x),false);});
test('static-exact-pins',()=>{for(const value of [C.root,C.root9,C.oldController,C.controller,C.qualification,C.acceptance,C.budgetSha,C.profile,C.scope,C.runner,C.credential,C.session,C.notBefore,C.expires])assert.ok(sql.includes(value),value);});
test('static-exact-chain-pins',()=>{for(const value of [C.p2Uri,C.p2Sha,'__P3_PUBLICATION_EVIDENCE_URI__','__P3_PUBLICATION_EVIDENCE_SHA256__','__INDEPENDENT_REVIEW_URI__','__INDEPENDENT_REVIEW_SHA256__','__CORRECTION_EVIDENCE_JSONB_SHA256__'])assert.ok(sql.includes(value),value);assert.ok(sql.includes("correction_event.request->'body'->'status_manifest_ref' is distinct from g->'status_manifest_ref'"));assert.ok(sql.includes("correction_event.request->'body'->'evidence'->'status_manifest_ref' is distinct from g->'status_manifest_ref'"));});
test('published-p2-artifact-pins',()=>{assert.equal(sha(qualificationRaw),C.qualification);assert.equal(sha(acceptanceRaw),C.acceptance);});
test('static-no-write-or-budget-side-effect',()=>{const code=sql.replace(/^--.*$/gm,'');assert.ok(!/\b(insert|update|delete|truncate|merge|call|perform)\b/i.test(code));assert.ok(!/reserve_execution_budget|automatic_refund\s*[,)]\s*true|additional_allocation\s*[,)]\s*true/i.test(code));});
test('static-only-original-error-domain',()=>assert.deepEqual([...sql.matchAll(/raise exception '([^']+)'/g)].map(m=>m[1]),['budget_consumption_binding_or_window_mismatch','budget_consumption_binding_or_window_mismatch']));
test('static-seq103-seq104-chain',()=>{assert.ok(sql.includes('sequence=103'));assert.ok(sql.includes('sequence=104'));assert.ok(sql.includes("qualification_correction_sequence' is distinct from '103'::jsonb"));});
const failed=results.filter(x=>x.status!=='PASS');
console.log(JSON.stringify({state:failed.length?'FAIL':'PASS',checks:results.length,passed:results.length-failed.length,failed,fragment_sha256:sha(sql)},null,2));
if(failed.length)process.exit(1);
