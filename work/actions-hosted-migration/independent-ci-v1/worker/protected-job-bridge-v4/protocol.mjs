// Data codec only (Source v2 port of protected-job-bridge-v3/protocol.mjs; DESIGN S6, S7).
// No I/O, signer, actual-port brand or qualification issuer. A valid packet is not authenticated and
// cannot authorize Source or Host. Changes against v3:
//   - job contract v2 (claim-free, attempt 1..2) and v2 subjects;
//   - the admission is the complete Native facts of contract /2 (admission-facts-v2.mjs), validated the
//     same way for every role; the issue's batch claim generation (stage 1, A-strict) is sticky: every
//     callback response must carry an admission under the same generation (a renewal is the same);
//   - a fourth packet, BLOCKED: the Linux worker's public statement that it ended cleanly BEFORE any
//     preparation (for example REMOTE_REFS_CHANGED_SINCE_BUNDLE). It is unauthenticated data: it can only
//     end a stage early as a clean refusal, never produce or replace a result.
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {validateJobV2,subjectOfV2,SCANNER_ROLES_V2,sameClaimGeneration} from '../../src/job-v2.mjs';
import {canonical} from '../../src/proof.mjs';
import {validateFormalAdmissionV2} from '../../src/admission-facts-v2.mjs';
import {validateRemoteSnapshot} from '../formal-gitleaks-v4/required-history/prepare.mjs';

export const MAX_BYTES=1048576;
export const ISSUE_CONTRACT='clued.independent-ci.protected-job-issue/2';
export const CHALLENGE_CONTRACT='clued.independent-ci.protected-job-challenge/2';
export const RESPONSE_CONTRACT='clued.independent-ci.protected-job-response/2';
export const BLOCKED_CONTRACT='clued.independent-ci.protected-job-blocked/1';
// One callback round (challenge -> relay -> Windows admission + refs -> relay -> response). 30 s was too tight
// on TURING: measured 34 s and about 47 s round trips, the Windows step alone up to about 30 s (PR #889 stage 2,
// 2026-10-21, Owner decision dd7378d2). Every round still re-runs the admission and the refs check. The relay alone
// sometimes takes 25-45 s (PR #915 stage 4, 2026-10-23), so a response's admission and refs snapshot are fresh at its
// issuance and the response only has to arrive inside this window (Owner decision 6f1fb753, validateResponse).
export const CALLBACK_WINDOW_MS=120000;
const REPO='tdoljyj/cross-memory-system',HASH=/^[a-f0-9]{64}$/,SHA=/^[a-f0-9]{40}$/;
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const ISSUE=['contract','domain','issueId','nonce','job','issuedAt','expiresAt','sourceAcceptanceRef','hostQualificationRef','admission','remoteRefs'];
const CHALLENGE=['contract','domain','issueId','issueSha256','subject','sequence','nonce','action','createdAt','deadline'];
const RESPONSE=['contract','domain','challengeSha256','issueSha256','sequence','nonce','issuedAt','expiresAt','admission','remoteRefs'];
const BLOCKED=['contract','domain','issueSha256','reason','sideEffectsMayHaveStarted','observedAt'];
const fail=code=>{throw Object.assign(new Error(code),{code});};
const check=(ok,code)=>{if(!ok)fail(code);};
const plain=v=>v!==null&&typeof v==='object'&&Object.getPrototypeOf(v)===Object.prototype;
const exact=(v,fields)=>plain(v)&&Object.keys(v).sort().join('|')===[...fields].sort().join('|');
const text=v=>typeof v==='string'&&v.length>0&&v.length<=4096&&!/[\x00-\x1f\x7f]/.test(v);
const nowValid=now=>check(Number.isSafeInteger(now)&&now>=0,'BRIDGE_CLOCK_INVALID');
function time(v){check(typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(v)&&Number.isFinite(Date.parse(v)),'BRIDGE_TIME_INVALID');return Date.parse(v);}
function dataTree(v,depth=0){
  check(depth<=24,'BRIDGE_DATA_DEPTH');
  if(v===null||typeof v==='string'||typeof v==='boolean')return;
  if(typeof v==='number'){check(Number.isFinite(v),'BRIDGE_DATA_NUMBER');return;}
  check(Array.isArray(v)||plain(v),'BRIDGE_DATA_TYPE');
  check(Object.keys(v).length<=10000,'BRIDGE_DATA_ITEMS');
  if(Array.isArray(v))check(v.length<=10000&&Object.keys(v).length===v.length&&Object.keys(v).every((key,i)=>key===String(i)),'BRIDGE_DENSE_ARRAY_REQUIRED');
  for(const value of Object.values(v))dataTree(value,depth+1);
}
function raw(v){dataTree(v);const b=Buffer.from(canonical(v),'utf8');check(b.length>0&&b.length<=MAX_BYTES,'BRIDGE_BYTE_BOUND');return b;}
export const digest=v=>createHash('sha256').update(raw(v)).digest('hex');
function packetShape(v){
  const fields={[ISSUE_CONTRACT]:ISSUE,[CHALLENGE_CONTRACT]:CHALLENGE,[RESPONSE_CONTRACT]:RESPONSE,[BLOCKED_CONTRACT]:BLOCKED}[v?.contract]??null;
  check(fields&&exact(v,fields)&&v.domain==='production','BRIDGE_PACKET_SHAPE_REQUIRED');
}
export function encode(v){packetShape(v);return raw(v);}
export function decode(bytes){
  check(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=MAX_BYTES,'BRIDGE_BYTE_BOUND');
  const s=bytes.toString('utf8');check(Buffer.from(s,'utf8').equals(bytes),'BRIDGE_UTF8_REQUIRED');
  let v;try{v=JSON.parse(s);}catch{fail('BRIDGE_JSON_REQUIRED');}
  packetShape(v);check(raw(v).equals(bytes),'BRIDGE_CANONICAL_BYTES_REQUIRED');return v;
}
export function jobValid(job){
  check(plain(job),'BRIDGE_JOB_REQUIRED');
  try{validateJobV2(job);}catch{fail('BRIDGE_FIXED_JOB_REQUIRED');}
  check(job.repo===REPO&&SCANNER_ROLES_V2.includes(job.role),'BRIDGE_FIXED_JOB_REQUIRED');return job;
}
// The shared v2 check plus the v3 protocol's closed shapes of the mode, merge slot and Owner review.
export function admissionValid(job,a,now,generation=null){
  try{validateFormalAdmissionV2(job,a,now,{batchClaim:generation});}catch{fail('BRIDGE_FORMAL_ADMISSION_SHAPE_REQUIRED');}
  check((a.scope==='global'||/^project:[a-f0-9-]{36}$/.test(a.scope))&&text(a.modeProofRef)&&text(a.observationRef)&&HASH.test(a.packetSha256??'')&&HASH.test(a.evaluationSha256??'')&&typeof a.mergeQueueHead==='boolean','BRIDGE_FORMAL_ADMISSION_SHAPE_REQUIRED');
  check(exact(a.mode,['state','layer','policyVersion'])&&['normal','efficiency','frozen'].includes(a.mode.state)
    &&['docs','code','protected'].includes(a.mode.layer)&&(text(a.mode.policyVersion)||Number.isSafeInteger(a.mode.policyVersion)),'BRIDGE_ADMISSION_MODE_REQUIRED');
  const slot=a.mergeSlot,states=['not_needed','missing','not_reported','held','not_required','auto_merge_forbidden'];
  check(states.includes(slot?.state)&&exact(slot,['ref','tip','until','state',...(['not_required','auto_merge_forbidden'].includes(slot?.state)?['observed']:[])])
    &&text(slot.ref)&&(slot.tip===null||SHA.test(slot.tip??''))&&(slot.until===null||Number.isFinite(Date.parse(slot.until)))
    &&(!Object.hasOwn(slot,'observed')||['not_needed','missing','not_reported','held'].includes(slot.observed)),'BRIDGE_MERGE_SLOT_SHAPE_REQUIRED');
  check(a.ownerReview===null||exact(a.ownerReview,['kind','grantId','carriedFrom'])&&text(a.ownerReview.kind)
    &&(a.ownerReview.grantId===null||text(a.ownerReview.grantId))&&(a.ownerReview.carriedFrom===null||text(a.ownerReview.carriedFrom)),'BRIDGE_OWNER_REVIEW_SHAPE_REQUIRED');
  check(Array.isArray(a.workflowGateFindings)&&a.workflowGateFindings.every(text),'BRIDGE_WORKFLOW_FINDINGS_REQUIRED');
  time(a.observedAt);time(a.claimExpiresAt);return a;
}
function refsValid(job,refs,now){
  check(exact(refs,['contract','repository','complete','observedAt','refs']),'BRIDGE_REFS_SHAPE_REQUIRED');time(refs.observedAt);
  const validated=validateRemoteSnapshot(refs,job,now);
  check(validated.find(r=>r.name==='refs/heads/main')?.objectSha===job.baseSha,'REMOTE_MAIN_BASE_CHANGED');return refs;
}
// The issue's claim generation: the batch claim stage 1 recorded (it is in batchClaimBound).
export const issueGeneration=issue=>issue.admission.batchClaimBound;
function initialValid(issue){
  const at=time(issue.issuedAt);admissionValid(issue.job,issue.admission,at);
  if(issue.job.role==='gitleaks')refsValid(issue.job,issue.remoteRefs,at);else check(issue.remoteRefs===null,'BRIDGE_TRIVY_REFS_NULL_REQUIRED');
  check(time(issue.expiresAt)<=time(issue.admission.claimExpiresAt),'BRIDGE_ISSUE_EXCEEDS_CLAIM');
}
export function validateIssue(issue,now=Date.now()){
  nowValid(now);packetShape(issue);check(issue.contract===ISSUE_CONTRACT,'BRIDGE_ISSUE_REQUIRED');jobValid(issue.job);
  check(UUID.test(issue.issueId??'')&&HASH.test(issue.nonce??'')&&text(issue.sourceAcceptanceRef)&&text(issue.hostQualificationRef),'BRIDGE_ISSUE_BINDING_REQUIRED');
  check(time(issue.issuedAt)<=now&&time(issue.issuedAt)>=Date.parse(issue.job.createdAt)&&time(issue.expiresAt)>now&&time(issue.expiresAt)>time(issue.issuedAt),'BRIDGE_ISSUE_EXPIRED');
  initialValid(issue);raw(issue);return issue;
}
export function validateChallenge(issue,challenge,now=Date.now()){
  validateIssue(issue,now);packetShape(challenge);check(challenge.contract===CHALLENGE_CONTRACT,'BRIDGE_CHALLENGE_REQUIRED');
  check(challenge.issueId===issue.issueId&&challenge.issueSha256===digest(issue)&&exact(challenge.subject,Object.keys(subjectOfV2(issue.job)))
    &&canonical(challenge.subject)===canonical(subjectOfV2(issue.job)),'BRIDGE_CHALLENGE_SUBJECT_CHANGED');
  check(Number.isSafeInteger(challenge.sequence)&&challenge.sequence>=1&&challenge.sequence<=32&&HASH.test(challenge.nonce??'')
    &&['admission','remote-refs'].includes(challenge.action)&&(challenge.action!=='remote-refs'||issue.job.role==='gitleaks'),'BRIDGE_CHALLENGE_ACTION_REQUIRED');
  const at=time(challenge.createdAt),end=time(challenge.deadline);
  check(at>=time(issue.issuedAt)&&at<=now&&end>now&&end>at&&end-at<=CALLBACK_WINDOW_MS&&end<=time(issue.expiresAt),'BRIDGE_CHALLENGE_EXPIRED');
  raw(challenge);return challenge;
}
export function validateResponse(issue,challenge,response,now=Date.now()){
  validateChallenge(issue,challenge,now);packetShape(response);check(response.contract===RESPONSE_CONTRACT,'BRIDGE_RESPONSE_REQUIRED');
  check(response.challengeSha256===digest(challenge)&&response.issueSha256===digest(issue)&&response.sequence===challenge.sequence&&response.nonce===challenge.nonce,'BRIDGE_RESPONSE_BINDING_CHANGED');
  const at=time(response.issuedAt),end=time(response.expiresAt);
  check(at>=time(challenge.createdAt)&&at<=now&&now-at<=CALLBACK_WINDOW_MS&&end>now&&end>at&&end-at<=CALLBACK_WINDOW_MS&&end<=time(challenge.deadline),'BRIDGE_RESPONSE_EXPIRED');
  if(challenge.action==='admission'){
    // Fresh when issued, like the issue's admission (Owner Decision 6f1fb753): the 30 s bound is measured at issuedAt,
    // and the response itself must still be inside its window (above). The claim outlives the arrival (end > now).
    check(response.remoteRefs===null,'BRIDGE_RESPONSE_REFS_NULL_REQUIRED');admissionValid(issue.job,response.admission,at,issueGeneration(issue));
    check(sameClaimGeneration(response.admission.batchClaimBound,issueGeneration(issue)),'BRIDGE_RESPONSE_CLAIM_GENERATION_CHANGED');
    check(time(response.admission.observedAt)<=at&&end<=time(response.admission.claimExpiresAt),'BRIDGE_RESPONSE_ADMISSION_TIME_REQUIRED');
  }else{
    // The refs snapshot likewise (Task 576231fa, as Owner Decision 6f1fb753 for the admission): its 30 s
    // (validateRemoteSnapshot) are measured at the response's issuedAt, the moment the Windows issuer wrote it right after
    // one complete collection, never at the arrival; the response itself must still arrive inside its window (above).
    check(response.admission===null,'BRIDGE_RESPONSE_ADMISSION_NULL_REQUIRED');refsValid(issue.job,response.remoteRefs,at);
    check(time(response.remoteRefs.observedAt)<=at,'BRIDGE_RESPONSE_REFS_TIME_REQUIRED');
  }
  raw(response);return response;
}
// A clean refusal before preparation, written by the Linux worker. Only the issue binding, a stable code
// and the explicit "nothing started" flag; the Windows issuer maps the code through a fixed allow-list.
export function validateBlocked(issue,blocked,now=Date.now()){
  packetShape(blocked);check(blocked.contract===BLOCKED_CONTRACT,'BRIDGE_BLOCKED_REQUIRED');
  check(blocked.issueSha256===digest(issue)&&/^[A-Z][A-Z0-9_]{1,79}$/.test(blocked.reason??'')&&blocked.sideEffectsMayHaveStarted===false,'BRIDGE_BLOCKED_BINDING_CHANGED');
  const at=time(blocked.observedAt);check(at>=time(issue.issuedAt)&&at<=now,'BRIDGE_BLOCKED_TIME_INVALID');
  raw(blocked);return blocked;
}
const frozen=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(frozen);Object.freeze(v);}return v;};
function contextValid(c,fields){check(plain(c)&&Object.keys(c).every(k=>fields.includes(k)),'BRIDGE_MAKER_CONTEXT_REQUIRED');}
function makeTime(c,key,now){return c[key]??new Date(now).toISOString();}
export function makeIssue(job,facts,refs,context){
  check(plain(context),'BRIDGE_MAKER_CONTEXT_REQUIRED');contextValid(context,['sourceAcceptanceRef','hostQualificationRef','expiresAt','issuedAt','issueId','nonce','now']);
  const now=context.now??Date.now();nowValid(now);jobValid(job);admissionValid(job,facts,now);
  if(job.role==='gitleaks')refsValid(job,refs,now);else check(refs===null,'BRIDGE_TRIVY_REFS_NULL_REQUIRED');
  const issue={contract:ISSUE_CONTRACT,domain:'production',issueId:context.issueId??randomUUID(),nonce:context.nonce??randomBytes(32).toString('hex'),
    job:structuredClone(job),issuedAt:makeTime(context,'issuedAt',now),expiresAt:new Date(Math.min(time(context.expiresAt),time(facts.claimExpiresAt))).toISOString(),
    sourceAcceptanceRef:context.sourceAcceptanceRef,hostQualificationRef:context.hostQualificationRef,admission:structuredClone(facts),remoteRefs:structuredClone(refs)};
  return frozen(validateIssue(issue,now));
}
export function makeChallenge(issue,action,sequence,context={}){
  contextValid(context,['now','nonce','createdAt','deadline']);const now=context.now??Date.now();validateIssue(issue,now);
  const challenge={contract:CHALLENGE_CONTRACT,domain:'production',issueId:issue.issueId,issueSha256:digest(issue),subject:subjectOfV2(issue.job),sequence,
    nonce:context.nonce??randomBytes(32).toString('hex'),action,createdAt:makeTime(context,'createdAt',now),
    deadline:context.deadline??new Date(Math.min(now+CALLBACK_WINDOW_MS,time(issue.expiresAt))).toISOString()};
  return frozen(validateChallenge(issue,challenge,now));
}
export function makeResponse(issue,challenge,facts,refs,context={}){
  contextValid(context,['now','issuedAt','expiresAt']);const now=context.now??Date.now();validateChallenge(issue,challenge,now);
  const response={contract:RESPONSE_CONTRACT,domain:'production',challengeSha256:digest(challenge),issueSha256:digest(issue),sequence:challenge.sequence,nonce:challenge.nonce,
    issuedAt:makeTime(context,'issuedAt',now),expiresAt:context.expiresAt??new Date(Math.min(now+CALLBACK_WINDOW_MS,time(challenge.deadline),facts?time(facts.claimExpiresAt):Infinity)).toISOString(),
    admission:structuredClone(facts),remoteRefs:structuredClone(refs)};
  return frozen(validateResponse(issue,challenge,response,now));
}
export function makeBlocked(issue,reason,context={}){
  contextValid(context,['now','observedAt']);const now=context.now??Date.now();
  const blocked={contract:BLOCKED_CONTRACT,domain:'production',issueSha256:digest(issue),reason,sideEffectsMayHaveStarted:false,observedAt:makeTime(context,'observedAt',now)};
  return frozen(validateBlocked(issue,blocked,now));
}
