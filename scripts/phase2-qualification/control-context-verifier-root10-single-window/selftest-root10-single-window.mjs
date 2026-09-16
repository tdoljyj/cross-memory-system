import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  canonicalDigest,sha,validateRoot10ControllerContract,checkRoot10SingleWindowSeries,
} from './root10-single-window.mjs';
import {validateRoot10ExecutorApplicability} from './result-evidence-root10.mjs';
import {committableBranchInput,repository as signingRepository,branch as signingBranch} from './dynamic-signing.mjs';

const candidate=JSON.parse(fs.readFileSync(new URL('./Root10ControllerContract.candidate.json',import.meta.url),'utf8'));
const clone=value=>structuredClone(value);
const compact=value=>JSON.stringify(value)+'\n';
const tests=[];
const pass=(name,fn)=>tests.push({name,fn});
const rejects=(pattern,fn)=>assert.throws(fn,pattern);

function fixture(){
 const contract=clone(candidate);
 const oldRootEvents=Array.from({length:9},(_,i)=>({sequence:i+1,root_id:contract.root_id,request:{kind:'HISTORICAL'}}));
 contract.baseline.root_events_sha256=canonicalDigest(oldRootEvents);
 const rootEvents=[...oldRootEvents,{sequence:10,root_id:contract.root_id,request:{kind:'GENERATION_REGISTERED',generation_id:contract.generation_id,predecessor_generation_id:contract.predecessor_generation,body:{control_trust_root_generation:contract.generation_id,history:{prefix_sequence:9,prefix_digest:contract.baseline.root_events_sha256},not_before:contract.window.not_before,expires_at:contract.window.expires_at}}}];
 const events=Array.from({length:110},(_,i)=>({sequence:i+1,root_id:contract.root_id,idempotency_key:'old_'+(i+1),request:{operation:'HISTORICAL',body:{}}}));
 for(const sequence of [1,5,11,18,27,41,46,51,59,68,73,77,81,85,91,102])events[sequence-1].request.operation='BUDGET_RESERVED';
 for(const sequence of [45,47,48,49,50,52,53,54,55,56,57,58,60,61,62,63,64])events[sequence-1].request.operation='EXECUTION_BINDING_FORWARD_ACCEPTED';
 const receiptRaw=compact({result:'BLOCKED'}),receiptSha=sha(receiptRaw);
 const ids=contract.baseline.historical_preimage110.attempt_ids,closure=contract.baseline.closure;
 const attempts=ids.map((ga_id,i)=>({ga_id,budget_sequence:i<2||ga_id===closure.ga_id?102:[46,51,59,68,73,77,81,85,91][i%9],phase:'BLOCKED',sequence:1,container_id:null,revoked:false,receipt_id:'old_'+i,receipt_raw:receiptRaw,receipt_sha256:receiptSha,decision:{decision_sha256:'2'.repeat(64),evidence_index_sha256:'3'.repeat(64)}}));
 const decisionRaw=compact({result:'BLOCKED'}),indexRaw=compact({tests:[]}),observationRaw=compact({not_started:true});
 Object.assign(closure,{decision_sha256:sha(decisionRaw),evidence_index_sha256:sha(indexRaw),observation_sha256:sha(observationRaw),receipt_sha256:receiptSha});
 const decisionBody={result:'BLOCKED',termination_mode:closure.termination_mode,decision_raw:decisionRaw,decision_sha256:closure.decision_sha256,evidence_index_raw:indexRaw,evidence_index_sha256:closure.evidence_index_sha256,not_started_evidence_raw:observationRaw,not_started_evidence_ref:{uri:'urn:clued:execution-evidence:'+contract.root_id+':'+closure.observation_sha256,sha256:closure.observation_sha256}};
 events.push({sequence:111,root_id:contract.root_id,idempotency_key:closure.decision_idempotency_key,request:{idempotency_key:closure.decision_idempotency_key,expected_sequence:110,ga_id:closure.ga_id,operation:'DECISION_RESERVED',body:decisionBody}});
 events.push({sequence:112,root_id:contract.root_id,idempotency_key:closure.signing_idempotency_key,request:{idempotency_key:closure.signing_idempotency_key,expected_sequence:111,ga_id:closure.ga_id,operation:'SIGNING',body:{decision_sha256:closure.decision_sha256}}});
 const closed=attempts.find(a=>a.ga_id===closure.ga_id);Object.assign(closed,{ga_sha256:closure.ga_sha256,phase:'BLOCKED',sequence:2,receipt_id:closure.receipt_id,receipt_raw:receiptRaw,receipt_sha256:closure.receipt_sha256,decision:{decision_sha256:closure.decision_sha256,evidence_index_sha256:closure.evidence_index_sha256}});
 contract.baseline.historical_preimage110.execution_events_sha256=canonicalDigest(events.slice(0,110));
 contract.baseline.historical_preimage110.other_attempts_sha256=canonicalDigest(attempts.filter(a=>a.ga_id!==closure.ga_id).sort((a,b)=>a.ga_id.localeCompare(b.ga_id)));
 for(let sequence=113;sequence<=116;sequence++)events.push({sequence,root_id:contract.root_id,idempotency_key:'activation_'+sequence,request:{operation:'ROOT10_ACTIVATION',body:{}}});
 const gaId='ga_ffffffffffffffffffffffffffffffff';
 const ga={gate_authorization_id:gaId,controller_digest:'1'.repeat(64),control_trust_root_generation:contract.generation_id,profile_digest:contract.fixed_digests.profile_sha256,scope_digest:contract.fixed_digests.scope_sha256,runner_generation:'runnergen_test',credential_generation:'credgen_test',session_generation:'sessiongen_test'};
 const gaRaw=compact(ga);
 const budget={controller_digest:ga.controller_digest,credential_generation:ga.credential_generation,environment:'ISOLATED_TEST',evidence_bytes:134217728,expires_at:contract.window.expires_at,idempotency_key:contract.postbaseline.budget_idempotency_key,not_before:contract.window.not_before,profile_digest:contract.fixed_digests.profile_sha256,purpose:'SKILL_COEXISTENCE_QUALIFICATION',root_generation:contract.generation_id,runner_generation:ga.runner_generation,scope_digest:contract.fixed_digests.scope_sha256,seconds:600,session_generation:ga.session_generation};
 const budgetRaw=compact(budget);
 events.push({sequence:117,root_id:contract.root_id,idempotency_key:contract.postbaseline.budget_idempotency_key,request:{operation:'BUDGET_RESERVED',body:{raw:budgetRaw,sha256:sha(budgetRaw)}}});
 attempts.push({ga_id:gaId,budget_sequence:117,phase:'PENDING',ga,ga_raw:gaRaw,ga_sha256:sha(gaRaw),receipt_raw:null,receipt_sha256:null});
 const execution={root:{root_set_id:contract.root_id,generation_id:contract.generation_id,events:rootEvents},events,attempts,binding:{root_id:contract.root_id},current:{root_id:contract.root_id,charged_seconds:11706,charged_evidence_bytes:2604247987,active_ga_id:gaId,pending_budget_sequence:null}};
 return {contract,execution,gaId,budget};
}
function rebaseBaseline(contract,execution){
 contract.baseline.historical_preimage110.execution_events_sha256=canonicalDigest(execution.events.slice(0,110));
 contract.baseline.historical_preimage110.other_attempts_sha256=canonicalDigest(execution.attempts.filter(a=>contract.baseline.historical_preimage110.attempt_ids.includes(a.ga_id)&&a.ga_id!==contract.baseline.closure.ga_id).sort((a,b)=>a.ga_id.localeCompare(b.ga_id)));
}
function series(value,operation='CURRENT_DISPATCH',result=null){return checkRoot10SingleWindowSeries({...value,operation,result});}

pass('01 canonical digest uses protocol LF',()=>{assert.equal(canonicalDigest([{a:1}]),sha('[{"a":1}]\n'));});
pass('02 finalized contract and actual CommittableBranch schema mapping validate',()=>{assert.equal(validateRoot10ControllerContract(fixture().contract).generation_ordinal,10);const input=committableBranchInput();assert.deepEqual(input,{repositoryNameWithOwner:signingRepository,branchName:signingBranch});assert.equal(Object.hasOwn(input,'refName'),false);});
pass('03 exact single budget and GA pass',()=>{assert.equal(series(fixture()).state,'ROOT10_SINGLE_WINDOW_SERIES_CHECKED');});
pass('04 terminal reconciliation uses the same window',()=>{assert.equal(series(fixture(),'RESULT_RECONCILIATION','FAIL').postbaseline_ga,1);});
pass('05 unpublished contract fails closed',()=>{const x=fixture();x.contract.ready=false;rejects(/ROOT10_CONTRACT_NOT_FINAL/,()=>series(x));});
pass('06 cap drift is rejected',()=>{const x=fixture();x.contract.caps.seconds++;rejects(/EXACT_AUTHORIZED_ROOT10_CAPS/,()=>series(x));});
pass('07 second postbaseline budget is rejected',()=>{const x=fixture();const e=clone(x.execution.events.at(-1));e.sequence=118;e.idempotency_key='extra';x.execution.events.push(e);rejects(/EXACT_ONE_ROOT10_BUDGET_EVENT/,()=>series(x));});
pass('08 second Root10 GA is rejected',()=>{const x=fixture();const a=clone(x.execution.attempts.at(-1));a.ga_id='ga_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';x.execution.attempts.push(a);rejects(/EXACT_ONE_ROOT10_GA/,()=>series(x));});
pass('09 seq102 cannot become the Root10 budget',()=>{const x=fixture();x.contract.postbaseline.budget_sequence=102;rejects(/EXACT_SINGLE_POSTBASELINE_BUDGET/,()=>series(x));});
pass('10 nonempty repair refs are rejected',()=>{const x=fixture();x.execution.events.at(-1).request.body.required_repair_refs=[{ga_id:x.gaId}];rejects(/NO_ROOT10_REPAIR/,()=>series(x));});
pass('11 successor GA is rejected',()=>{const x=fixture();x.execution.attempts.at(-1).successor_ga=true;rejects(/NO_ROOT10_REPAIR/,()=>series(x));});
pass('12 automatic retry is rejected',()=>{const x=fixture();x.execution.events.at(-1).request.body.automatic_retry=true;rejects(/NO_ROOT10_REPAIR/,()=>series(x));});
pass('13 refund is rejected',()=>{const x=fixture();x.execution.events.at(-1).request.body.refund=true;rejects(/NO_ROOT10_REPAIR/,()=>series(x));});
pass('14 explicit false no-retry fields remain admissible',()=>{const x=fixture();Object.assign(x.execution.attempts.at(-1),{automatic_retry:false,refund:false,successor_ga:false,repair_refs:[]});assert.equal(series(x).repairs,0);});
pass('15 changed budget bytes are rejected',()=>{const x=fixture();x.execution.events.at(-1).request.body.raw+=' ';rejects(/EXACT_ROOT10_BUDGET_BYTES/,()=>series(x));});
pass('16 incomplete budget shape is rejected',()=>{const x=fixture();const e=x.execution.events.at(-1),v=JSON.parse(e.request.body.raw);delete v.environment;e.request.body.raw=compact(v);e.request.body.sha256=sha(e.request.body.raw);rejects(/EXACT_ROOT10_BUDGET_SCOPE/,()=>series(x));});
pass('17 wrong budget generation is rejected',()=>{const x=fixture();const e=x.execution.events.at(-1),v=JSON.parse(e.request.body.raw);v.root_generation=x.contract.predecessor_generation;e.request.body.raw=compact(v);e.request.body.sha256=sha(e.request.body.raw);rejects(/EXACT_ROOT10_BUDGET_SCOPE/,()=>series(x));});
pass('18 historical total budget count is independently fixed',()=>{const x=fixture();x.execution.events[0].request.operation='HISTORICAL';rebaseBaseline(x.contract,x.execution);rejects(/EXACT_CUMULATIVE_CAPS/,()=>series(x));});
pass('19 series forward count is fixed and Root10 adds none',()=>{const x=fixture();x.execution.events[44].request.operation='HISTORICAL';rebaseBaseline(x.contract,x.execution);rejects(/EXACT_CUMULATIVE_CAPS/,()=>series(x));});
pass('20 PQUAL-18 is a negative guard, never a formal result',()=>{const x=fixture(),ids=x.contract.accepted_suite.formal_test_ids,suite={tests:Object.fromEntries(ids.concat('PQUAL-18').map(id=>[id,{}]))},mapping={state:'ACCEPTED_EXACT_ROOT10_EXECUTOR_APPLICABILITY',independent_reviewer:'/root/root9_recovery_review',root_id:x.contract.root_id,control_trust_root_generation:x.contract.generation_id,suite_ref:{uri:x.contract.accepted_suite.uri,sha256:x.contract.accepted_suite.sha256},suite_executor_sha256:x.contract.accepted_suite.original_executor_sha256,current_controller_sha256:'1'.repeat(64),formal_test_ids:ids,pqual18_disposition:x.contract.accepted_suite.pqual18_disposition,oracle_bytes_unchanged:true,fixture_refs_unchanged:true,test_definitions_unchanged:true,controller_executes_same_oracles:true,new_authority:false,authority_effect:'NONE'};rejects(/EXACT_5_FORMAL_PLUS_PQUAL18_NEGATIVE_GUARD/,()=>validateRoot10ExecutorApplicability({executorApplicability:mapping,suite,acceptedSuiteSha256:x.contract.accepted_suite.sha256,state:{binding:{root_id:x.contract.root_id}},ga:{control_trust_root_generation:x.contract.generation_id,controller_digest:'1'.repeat(64)},independentReviewer:mapping.independent_reviewer}));});

let passed=0;
for(const test of tests){try{test.fn();passed++;console.log('PASS',test.name);}catch(error){console.error('FAIL',test.name,error.stack);}}
assert.equal(tests.length,20,'exact focused Root10 controller unit-test denominator');
assert.equal(passed,20,'all focused Root10 controller unit tests pass');
console.log(JSON.stringify({state:'ROOT10_CONTROLLER_UNIT_TESTS_PASS',unit_tests_passed:passed,unit_tests_total:tests.length,formal_preflight_claimed:false,formal_suite_claimed:false,authority_effect:'NONE'}));
