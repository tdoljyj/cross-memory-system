import crypto from 'node:crypto';
const sha=raw=>crypto.createHash('sha256').update(raw).digest('hex');
const need=(ok,why)=>{if(!ok)throw Error(why);};
const keys=['controller_digest','credential_generation','environment','evidence_bytes','expires_at','idempotency_key','not_before','profile_digest','purpose','root_generation','runner_generation','scope_digest','seconds','session_generation'];
export function checkConsumedBudget({ga,state,attempt,root,project,now=Date.now()}){
 const sequence=attempt.budget_sequence;
 need(Number.isSafeInteger(sequence)&&sequence>0&&state.current.pending_budget_sequence===null,'EXACT_THIS_GA_CONSUMED_BUDGET_REQUIRED');
 const matches=state.events?.filter(e=>e.sequence===sequence&&e.root_id===root.root_set_id);
 need(matches?.length===1&&matches[0].request?.operation==='BUDGET_RESERVED','ACTUAL_ORIGINAL_BUDGET_EVENT');
 const body=matches[0].request.body;
 need(typeof body?.raw==='string'&&sha(body.raw)===body.sha256,'ACTUAL_BUDGET_RAW_HASH');
 const budget=JSON.parse(body.raw);
 need(JSON.stringify(budget)+'\n'===body.raw&&Object.keys(budget).sort().join(',')===keys.join(','),'EXACT_COMPLETE_BUDGET_BYTES');
 need(ga.budget_reservation_ref.uri==='urn:clued:control-evidence:'+project+':execution-events:'+sequence&&ga.budget_reservation_ref.sha256===body.sha256,'EXACT_BUDGET_REFERENCE');
 for(const [b,g] of [['controller_digest','controller_digest'],['profile_digest','profile_digest'],['scope_digest','scope_digest'],['runner_generation','runner_generation'],['credential_generation','credential_generation'],['session_generation','session_generation'],['purpose','purpose'],['environment','environment'],['root_generation','control_trust_root_generation']])need(budget[b]===ga[g],'EXACT_BUDGET_SCOPE_AND_GENERATIONS');
 need(budget.seconds===180&&budget.evidence_bytes===134217728&&typeof budget.idempotency_key==='string'&&budget.idempotency_key.length>0,'EXACT_FIXED_BUDGET_LIMITS');
 const start=Date.parse(budget.not_before),end=Date.parse(budget.expires_at);
 need(Number.isFinite(start)&&Number.isFinite(end)&&start<=now&&now<end&&start<=Date.parse(ga.issued_at)&&Date.parse(ga.expires_at)<=end&&end<=Date.parse(root.expires_at),'EXACT_BUDGET_OWNER_AND_GA_WINDOW');
 need(state.attempts.filter(a=>a.budget_sequence===sequence).length===1,'ONE_BUDGET_ONE_GA');
 return {state:'BUDGET_EVIDENCE_MATCHED_NOT_ADMISSION',sequence};
}
