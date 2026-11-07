// CI Source round-trip trim (PR #1029 front batch): after the adapter's own post admission the Linux worker wrote one more
// admission challenge before signing (3 roles x 1 relay round, about 47 s), although the observation already names the
// adapter's answer (postAdmissionSha256). The real executeProtectedIssuedJob runs here with the real bridge v4 protocol
// (issue, challenges and responses made and validated for real); only its host-bound collaborators (accepted context,
// Root mailbox, role session, adapters, signer) are in-memory stand-ins, swapped in this test module only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {batchJobsV2} from '../src/job-v2.mjs';
import {FRESH_MS} from '../src/clock-skew.mjs';
import {makeIssue,makeResponse,encode,decode,issueGeneration} from '../worker/protected-job-bridge-v4/protocol.mjs';
import {adapterFinalAdmission,FINAL_ADMISSION_REUSE_MAX_MS,callbackValue} from '../worker/protected-job-bridge-v4/linux-worker.mjs';
import {admittedFacts,HEAD,BASE} from './resident-v2-fixtures.mjs';

const workerUrl=new URL('../worker/protected-job-bridge-v4/linux-worker.mjs',import.meta.url);
const stub=lines=>'data:text/javascript;base64,'+Buffer.from(lines.join('\n')).toString('base64');
const H='globalThis.__finalAdmissionHarness';
const stubs={
  './boundary.mjs':stub([`export async function loadLinuxContext(){return ${H}.context;}`,`export async function loadLinuxRelayContext(){return ${H}.context;}`,`export function takeAcceptedBridgeContext(c){return c;}`]),
  './mailbox.mjs':stub([`export async function openAcceptedMailbox(){return ${H}.box;}`,`export function takeActualMailbox(b){return b;}`]),
  './signed-result.mjs':stub([`export async function signActualBridgeResult(context,issue,observation){${H}.signed.push(observation);return {signed:true};}`]),
  '../formal-gitleaks-v4/adapter.mjs':stub([`export function createFormalGitleaksAdapter(ports){return ${H}.adapter(ports);}`]),
  '../formal-trivy-v4/adapter.mjs':stub([`export function createFormalTrivyAdapter(ports){return ${H}.adapter(ports);}`]),
  '../formal-contract-placement-v2/adapter.mjs':stub([`export function createFormalContractPlacementAdapter(ports){return ${H}.adapter(ports);}`]),
  '../formal-fixed-role-policy-v3/policy.mjs':stub([`export async function openFixedRoleSession(){return {async finish(o){${H}.finished.push(o);},async releaseClean(){}};}`,`export function takeActualRoleSession(s){return s;}`]),
  './issue-job.mjs':stub([`export async function readFixedIssueJob(){return ${H}.job;}`]),
};
let source=await fs.readFile(workerUrl,'utf8');
for(const [relative,url] of Object.entries(stubs)){const quoted=`'${relative}'`;assert.equal(source.split(quoted).length,2,'one import of '+relative);source=source.replace(quoted,JSON.stringify(url));}
source=source.replace(/from (['"])(\.[^'"]+)\1/g,(_all,_quote,relative)=>`from ${JSON.stringify(new URL(relative,workerUrl).href)}`);
const {executeProtectedIssuedJob}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));

const REPO='tdoljyj/cross-memory-system',PACKET={complete:true,paths:['a.txt']},iso=ms=>new Date(ms).toISOString();
function harness({role='trivy',observationNames='last'}={}){
  const job=batchJobsV2({repo:REPO,pr:888,headSha:HEAD,baseSha:BASE,testSha:HEAD,sourceManifestSha256:'e'.repeat(64),createdAt:iso(Date.now()-60_000),attempt:1})[role];
  const claim={claimId:randomUUID(),fence:3,epoch:1,expiresAt:iso(Date.now()+3600_000)};
  const context={role,config:{sourceManifestSha256:job.sourceManifestSha256},sourceAcceptanceRef:randomUUID(),hostQualificationRef:randomUUID()};
  const issue=makeIssue(job,admittedFacts(job,claim,PACKET,{batchClaim:claim}),role==='gitleaks'?{contract:'clued.independent-ci.remote-heads-tags/1',repository:REPO,complete:true,observedAt:iso(Date.now()),refs:[{name:'refs/heads/main',objectSha:BASE}]}:null,{sourceAcceptanceRef:context.sourceAcceptanceRef,hostQualificationRef:context.hostQualificationRef,expiresAt:iso(Date.now()+600_000)});
  const files=new Map([['issue',Buffer.from(encode(issue))]]),challenges=[];
  const box={async lock(){},async read(name){return files.get(name);},async write(name,bytes){files.set(name,Buffer.from(bytes));if(name.startsWith('challenge-'))challenges.push(decode(files.get(name)));},
    async wait(name){const challenge=decode(files.get('challenge-'+name.slice('response-'.length)));
      return Buffer.from(encode(makeResponse(issue,challenge,admittedFacts(job,claim,PACKET,{batchClaim:claim}),null)));}};
  const h={context,box,job,signed:[],finished:[],challenges,files,
    // The adapter's shape: a pre admission, its work, a post admission, then the observation naming the post admission.
    adapter:ports=>({async execute(subject){const before=await ports.admissionPort(subject),after=await ports.admissionPort(subject);
      h.afterPortCalls?.();
      return {status:'OBSERVED',observation:{preAdmissionSha256:before.observationSha256,postAdmissionSha256:observationNames==='last'?after.observationSha256:before.observationSha256}};}})};
  globalThis.__finalAdmissionHarness=h;return h;
}

test('the adapter\'s fresh post admission is used before signing: 2 admission challenges instead of 3, same signed result',async()=>{
  for(const role of ['trivy','gitleaks','contract-placement']){
    const h=harness({role}),r=await executeProtectedIssuedJob();
    assert.equal(r.status,'ACTUAL_SIGNED_ROLE_RESULT_EMITTED',role);
    assert.deepEqual(h.challenges.map(c=>c.action),['admission','admission'],role+': no extra bridge challenge');
    assert.equal(h.finished.length,1);assert.equal(h.signed.length,1);assert.ok(h.files.has('result'));
  }
});
test('an observation that does not name the last admission answer still gets one more admission challenge',async()=>{
  const h=harness({observationNames:'first'}),r=await executeProtectedIssuedJob();
  assert.equal(r.status,'ACTUAL_SIGNED_ROLE_RESULT_EMITTED');assert.deepEqual(h.challenges.map(c=>c.action),['admission','admission','admission']);
});
test('a post admission older than the freshness window is asked again before signing',async t=>{
  const h=harness();let shift=0;const now=performance.now.bind(performance);
  t.mock.method(performance,'now',()=>now()+shift);h.afterPortCalls=()=>{shift=FINAL_ADMISSION_REUSE_MAX_MS+1;};
  const r=await executeProtectedIssuedJob();
  assert.equal(r.status,'ACTUAL_SIGNED_ROLE_RESULT_EMITTED');assert.deepEqual(h.challenges.map(c=>c.action),['admission','admission','admission']);
});
test('adapterFinalAdmission: the exact named answer, inside the window, still accepted under the issue generation',()=>{
  assert.equal(FINAL_ADMISSION_REUSE_MAX_MS,FRESH_MS);
  const job=batchJobsV2({repo:REPO,pr:888,headSha:HEAD,baseSha:BASE,testSha:HEAD,sourceManifestSha256:'e'.repeat(64),createdAt:iso(Date.now()-60_000),attempt:1}).trivy;
  const claim={claimId:randomUUID(),fence:3,epoch:1,expiresAt:iso(Date.now()+3600_000)},t=Date.now();
  const issue=makeIssue(job,admittedFacts(job,claim,PACKET,{batchClaim:claim}),null,{sourceAcceptanceRef:randomUUID(),hostQualificationRef:randomUUID(),expiresAt:iso(t+600_000)});
  const facts=admittedFacts(job,claim,PACKET,{batchClaim:claim,observedAt:t});
  const held={facts,sentMono:100},named={postAdmissionSha256:facts.observationSha256},g=issueGeneration(issue);
  assert.equal(adapterFinalAdmission(job,g,held,named,{now:t,nowMono:100+FRESH_MS}),held);
  assert.equal(adapterFinalAdmission(job,g,held,named,{now:t,nowMono:101+FRESH_MS}),null,'older than the window');
  assert.equal(adapterFinalAdmission(job,g,held,named,{now:t,nowMono:99}),null,'monotonic clock went backwards');
  assert.equal(adapterFinalAdmission(job,g,held,named,{now:t+FRESH_MS+1,nowMono:100}),null,'facts no longer fresh');
  assert.equal(adapterFinalAdmission(job,{...g,claimId:randomUUID()},held,named,{now:t,nowMono:100}),null,'another claim generation');
  assert.equal(adapterFinalAdmission(job,g,held,{postAdmissionSha256:'0'.repeat(64)},{now:t,nowMono:100}),null,'another admission named');
  assert.equal(adapterFinalAdmission(job,g,held,{},{now:t,nowMono:100}),null);assert.equal(adapterFinalAdmission(job,g,null,named,{now:t,nowMono:100}),null);
  void callbackValue;
});
