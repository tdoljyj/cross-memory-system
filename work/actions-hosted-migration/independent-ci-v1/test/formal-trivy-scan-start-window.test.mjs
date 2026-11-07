// Real adapter loop in production mode, isolated only at its physical Docker
// transport. The private export exists in this in-memory test module only;
// no installed policy/qualification bypass or product fixture flag is added.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {makeJobV2} from '../src/job-v2.mjs';
import {noteScanStartResponseWindow} from '../src/scan-start-v1/grant.mjs';
import {admittedFacts,HEAD,BASE} from './resident-v2-fixtures.mjs';
import {CARRIED_ADMISSION_MAX_AGE_MS,carriedAdmission} from '../worker/formal-trivy-v4/adapter.mjs';
import {FRESH_MS} from '../src/clock-skew.mjs';
import {IMAGE,WORKFLOW_SHA256S,CHECKS_REPOSITORY} from '../worker/required-trivy-v3/plans.mjs';

const adapterUrl=new URL('../worker/formal-trivy-v4/adapter.mjs',import.meta.url);
const dockerUrl=new URL('../worker/formal-trivy-v3/docker.mjs',import.meta.url);
const physicalStub='data:text/javascript;base64,'+Buffer.from([
  `export {NATIVE_IMAGE} from ${JSON.stringify(dockerUrl.href)};`,
  `export function actualDockerClient(){throw Error('ACTUAL_DOCKER_NOT_ALLOWED_IN_REGRESSION');}`,
  `export async function runFixedScanner(input){return input.docker.scanner(input);}`,
].join('\n')).toString('base64');
let source=await fs.readFile(adapterUrl,'utf8');
const physicalImport="import { actualDockerClient, NATIVE_IMAGE, runFixedScanner } from '../formal-trivy-v3/docker.mjs';";
assert.equal(source.split(physicalImport).length,2,'one exact physical transport substitution');
source=source.replace(physicalImport,`import {actualDockerClient,NATIVE_IMAGE,runFixedScanner} from ${JSON.stringify(physicalStub)};`)
  .replace(/from (['"])(\.[^'"]+)\1/g,(_all,_quote,relative)=>`from ${JSON.stringify(new URL(relative,adapterUrl).href)}`);
source+='\nexport {executeScanners as regressionExecuteScanners};\n';
const {regressionExecuteScanners}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const START=Date.parse('2026-11-03T00:00:00.000Z'),hex=c=>c.repeat(64);

function context(t,{lastAdmissionDelay=0,firstScannerDelay=0,monotonic}={}){
  t.mock.timers.enable({apis:['Date'],now:START});
  const job=makeJobV2({repo:'tdoljyj/cross-memory-system',pr:888,headSha:HEAD,baseSha:BASE,testSha:HEAD,
    sourceManifestSha256:hex('e'),role:'trivy',attempt:1,createdAt:new Date(START-1000).toISOString()});
  const generation={claimId:randomUUID(),fence:3,epoch:1,expiresAt:new Date(START+3600000).toISOString()};
  const database={exists:true,complete:true,directory:'/cache/db',bytes:128,sha256:hex('a'),metadataSha256:hex('b'),
    metadata:{Version:2,UpdatedAt:new Date(START-1000).toISOString(),NextUpdate:new Date(START+3600000).toISOString()}};
  const checksPin={repository:CHECKS_REPOSITORY,digest:'sha256:'+hex('c'),majorVersion:2,contentSha256:hex('d')};
  const checksBundle={complete:true,directory:'/cache/checks',contentSha256:checksPin.contentSha256,metadataSha256:hex('f'),
    metadata:{Digest:checksPin.digest,MajorVersion:2,DownloadedAt:new Date(START-1000).toISOString(),CustomBuild:false},files:[{path:'fixed.rego'}]};
  const preparedRequest={schema:'independent-ci.container-execution-request.v1',containerCommand:{image:IMAGE},
    identity:{...job,jobId:job.id},candidateTreeSha:'c'.repeat(40),sourceSha:HEAD,sourceTreeSha:'c'.repeat(40),nonce:hex('1')};
  const inputInventory={complete:true,candidateTreeSha:preparedRequest.candidateTreeSha,paths:['README.md'],files:[]};
  const starts=[];let admissions=0,grants=0,records=0;
  const admissionPort=async()=>{
    admissions++;await Promise.resolve();t.mock.timers.tick(1); // every answer is its own observation
    if(admissions===2&&lastAdmissionDelay)t.mock.timers.tick(lastAdmissionDelay);
    return admittedFacts(job,generation,{complete:true,paths:inputInventory.paths},{batchClaim:generation,observedAt:Date.now()});
  };
  const scanStartPort=async()=>{
    grants++;const issued=Date.now();return noteScanStartResponseWindow({status:'committed',contract:'clued.ci-scan-start-grant/1',launch_allowed:true,
      execution_id:randomUUID(),receipt_id:randomUUID(),repository_id:1334673495,head_sha:job.headSha,role:'trivy',provider:'independent-controller',
      start_requested_at:new Date(issued).toISOString()},{issuedAt:new Date(issued).toISOString(),expiresAt:new Date(issued+120000).toISOString()});
  };
  const docker={async scanner({scan}){
    starts.push(scan.scanner);if(starts.length===1&&firstScannerDelay)t.mock.timers.tick(firstScannerDelay);
    return {scanner:scan.scanner,complete:true,cleanupConfirmed:true,touched:true,cleanupObservedAt:new Date().toISOString(),exitCode:0};
  }};
  return {starts,get grants(){return grants;},get admissions(){return admissions;},get records(){return records;},
    run:()=>regressionExecuteScanners({job,preparedRequest,snapshotDirectory:'/snapshot/repo',inputInventory,
      cache:{database,checksBundle,dbDecision:{status:'READY',fallback:false,db:database},provenanceSha256:hex('9')},checksPin,
      workflowSha256:WORKFLOW_SHA256S[0],docker,dockerRootDirectory:'/var/lib/docker',deadline:START+25*60000,
      admissionPort,scanStartPort,scanStartRecord:async()=>{records++;await Promise.resolve();},fixture:false,nativeScanStartRequired:true,
      context:{runtimeIdentity:'isolated-regression',hostAcceptanceRef:'isolated',sourceAcceptanceRef:'isolated'},generation,
      ...(monotonic?{monotonic}:{})})};
}

test('last fresh-admission await crossing grant window refuses before the first physical scanner',async t=>{
  const c=context(t,{lastAdmissionDelay:120001});
  await assert.rejects(c.run(),{code:'SCAN_START_GRANT_REFUSED'});
  assert.deepEqual(c.starts,[]);assert.equal(c.grants,1);assert.equal(c.records,1);assert.equal(c.admissions,2);
});
test('an unexpired final admission starts all three fixed scanners with one role grant',async t=>{
  const c=context(t),r=await c.run();assert.equal(r.status,'THREE_SCANNERS_OBSERVED_UNSIGNED');
  assert.deepEqual(c.starts,['vuln','secret','misconfig']);assert.equal(c.grants,1);assert.equal(c.records,1);
  assert.equal(r.observation.fixture,false);assert.equal(r.observation.formalEligible,false);
});
test('after the first scanner starts the role unit continues even past transport window',async t=>{
  const c=context(t,{firstScannerDelay:120001}),r=await c.run();
  assert.equal(r.status,'THREE_SCANNERS_OBSERVED_UNSIGNED');assert.deepEqual(c.starts,['vuln','secret','misconfig']);
  assert.equal(c.grants,1);assert.equal(c.records,1);assert.ok(Date.now()>START+120000);
});

// CI Source round-trip trim (PR #1029 front batch: 3 back-to-back relay rounds, about 49 s). Nothing runs between one
// scanner's post admission and the next scanner's pre admission, or the final one: that admission is carried over.
// Before: 1 + 3 x 2 + 1 = 8 admission rounds; now 5. Every scanner still has a pre and a post admission, both recorded.
test("a scanner's post admission is the next scanner's pre admission: 5 admission rounds instead of 8, verdict unchanged",async t=>{
  const c=context(t),r=await c.run();
  assert.equal(r.status,'THREE_SCANNERS_OBSERVED_UNSIGNED');assert.equal(r.observation.conclusion,'success');
  assert.deepEqual(c.starts,['vuln','secret','misconfig']);assert.equal(c.admissions,5);
  const s=r.observation.scans,sha=/^[a-f0-9]{64}$/;
  assert.ok(s.every(x=>sha.test(x.preAdmissionSha256)&&sha.test(x.postAdmissionSha256)&&x.preAdmissionSha256!==x.postAdmissionSha256),'each scanner: a pre and a post admission');
  assert.equal(s[1].preAdmissionSha256,s[0].postAdmissionSha256);assert.equal(s[2].preAdmissionSha256,s[1].postAdmissionSha256);
  assert.equal(r.observation.postAdmissionSha256,s[2].postAdmissionSha256,"the final admission is the last scanner's post admission");
  assert.notEqual(r.observation.preAdmissionSha256,s[0].preAdmissionSha256,'the role pre admission stays its own round (the grant runs between)');
});
test('a carried admission past the freshness window is asked again: all 8 rounds, the same verdict',async t=>{
  let mono=0;const c=context(t,{monotonic:()=>(mono+=CARRIED_ADMISSION_MAX_AGE_MS+1)}),r=await c.run();
  assert.equal(r.status,'THREE_SCANNERS_OBSERVED_UNSIGNED');assert.equal(r.observation.conclusion,'success');assert.equal(c.admissions,8);
  const s=r.observation.scans;
  assert.notEqual(s[1].preAdmissionSha256,s[0].postAdmissionSha256);assert.notEqual(r.observation.postAdmissionSha256,s[2].postAdmissionSha256);
});
test('carriedAdmission: only inside the window on the monotonic clock, and only facts the full check still accepts',t=>{
  t.mock.timers.enable({apis:['Date'],now:START});
  assert.equal(CARRIED_ADMISSION_MAX_AGE_MS,FRESH_MS);
  const job=makeJobV2({repo:'tdoljyj/cross-memory-system',pr:888,headSha:HEAD,baseSha:BASE,testSha:HEAD,sourceManifestSha256:hex('e'),role:'trivy',attempt:1,createdAt:new Date(START-1000).toISOString()});
  const generation={claimId:randomUUID(),fence:3,epoch:1,expiresAt:new Date(START+3600000).toISOString()};
  const facts=admittedFacts(job,generation,{complete:true,paths:['README.md']},{batchClaim:generation,observedAt:START});
  const held={facts,sentMono:1000},at=(now,nowMono,batchClaim=generation)=>carriedAdmission(job,held,{now,nowMono,batchClaim});
  assert.equal(at(START,1000),held);assert.equal(at(START+5000,1000+FRESH_MS),held);
  assert.equal(at(START,1000+FRESH_MS+1),null,'older than the window');assert.equal(at(START,999),null,'monotonic clock went backwards');
  assert.equal(at(START+FRESH_MS+1,1000),null,'the facts themselves are no longer fresh');
  assert.equal(at(START,1000,{...generation,claimId:randomUUID()}),null,'another claim generation');
  assert.equal(carriedAdmission(job,null,{now:START,nowMono:1000}),null);assert.equal(carriedAdmission(job,{facts,sentMono:NaN},{now:START,nowMono:1000}),null);
});
