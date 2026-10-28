// C1b compatibility boundary, not a qualification of the legacy provider on another node.
// The callable v1 provider retains its original /1 acceptance and fixed TURING permissions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { canonical, digest } from '../src/proof.mjs';
import { validateFormalAcceptance } from '../worker/protected-job-bridge-v2/boundary.mjs';
import { decodeHeldSource } from '../worker/protected-job-bridge-v2/held-source.mjs';
import { fixtureRecord, NOW } from './resident-v2-fixtures.mjs';
import { deriveBatch, deriveRelayStage, deriveTrainRun, residentBatchKey } from '../src/resident-v2/derive-batch.mjs';
import { trainRunKey } from '../src/resident-v2/train-run.mjs';
import { subject } from './resident-v2-fixtures.mjs';
import { createFullAdmissionPortV2 } from '../src/full-admission-v2.mjs';
import { makeJobV2 } from '../src/job-v2.mjs';

const SID = 'S-1-5-21-1173730660-3877291096-655431861-1015';
const hash = b => createHash('sha256').update(b).digest('hex');
const uuid = '11111111-2222-4333-8444-555555555555';
const identity = { platform: 'win32', arch: 'x64', account: 'clued-control', hostname: 'TURING' };

function held(docs, controllerSid = SID) {
  const policy = Buffer.from('{"fixture":true}');
  return Buffer.from(JSON.stringify({ contract: 'clued.independent-ci.held-source-bytes/1', controllerSid, expiresAt: new Date(NOW + 3600000).toISOString(),
    documents: Object.fromEntries(Object.entries(docs).filter(([n]) => ['installation.json','acceptance.json','source-manifest.json','signers.json'].includes(n)).map(([n,b]) => [n, Buffer.from(b).toString('base64')])),
    sourceHashes: { 'config/merge-admission-policy.json': hash(policy) }, policyBase64: policy.toString('base64') }));
}

test('real legacy held decoder then acceptance validator rejects a current /2 record before the secret/port continuation', () => {
  const r = fixtureRecord();
  // Same legacy controller wrapper deliberately passes its old held gate: the /1 acceptance gate must still reject /2.
  const decoded = decodeHeldSource(held(r.docs), NOW);
  const config = JSON.parse(decoded.documents['installation.json']), accepted = JSON.parse(decoded.documents['acceptance.json']);
  let secretReads = 0, ports = 0;
  const continuation = () => { validateFormalAcceptance(config, accepted, identity, NOW); secretReads++; ports++; };
  assert.throws(continuation, { code: 'EXISTING_FORMAL_CONTROLLER_CONFIG_REQUIRED' });
  assert.equal(secretReads, 0); assert.equal(ports, 0);
  assert.throws(() => decodeHeldSource(held(r.docs, r.inputs.node.controllerSid), NOW), { code: 'HELD_SOURCE_RECORD_REFUSED' });
});

test('the existing genuine legacy /1 shape still passes the old pure acceptance gate only on its accepted identity', () => {
  const config = { contract: 'clued.independent-ci.one-shot/1', enabled: true, repository: 'tdoljyj/cross-memory-system', appId: 5368905, installationId: 172706661,
    repositoryId: 1334673495, acceptanceSha256: null, sourceManifestSha256: 'a'.repeat(64), ciTokenPinSha256: 'b'.repeat(64), evaluatorSha256: 'c'.repeat(64), policySha256: 'd'.repeat(64),
    ciPrincipalBindingId: uuid, ciPrincipalQualificationRef: uuid, appPublicKeySha256Base64: 'A'.repeat(43)+'=', scope: `project:${uuid}` };
  const accepted = { contract: 'clued.independent-ci.accepted-installation/1', domain: 'production', accepted: true, repository: config.repository,
    configSha256: digest(config), platform: 'win32', arch: 'x64', controllerAccount: 'clued-control', hostname: 'TURING', workerCannotReadController: true,
    acceptedAt: new Date(NOW-1000).toISOString(), expiresAt: new Date(NOW+3600000).toISOString(), ciPrincipalBindingId: uuid, ciPrincipalQualificationRef: uuid,
    ciTokenPinSha256: config.ciTokenPinSha256, appPublicKeySha256Base64: config.appPublicKeySha256Base64,
    ...Object.fromEntries(['sourceAcceptanceRef','hostQualificationRef','ownerAuthorizationRef','publisherQualificationRef','ownerPackageAcceptanceRef','installationReceiptRef'].map(k=>[k,uuid])) };
  config.acceptanceSha256 = digest(accepted);
  assert.equal(validateFormalAcceptance(config, accepted, identity, NOW), accepted);
  assert.throws(() => validateFormalAcceptance(config, accepted, {...identity, hostname:'COMPANY-01'}, NOW), { code: 'FORMAL_CONTROLLER_ACCEPTANCE_MISSING' });
});

test('all actual current formal/R/train producers bind the same complete-node hash without selecting a legacy entry', () => {
  const r=fixtureRecord(), s=subject(), key=residentBatchKey(s), batchId=key.slice(0,16)+'-123456789abc';
  const d=deriveBatch({recordDocs:r.docs,subject:s,batchKey:key,batchId,now:NOW});
  const rs=deriveRelayStage({recordDocs:r.docs,batchJson:d.files['batch.json'],roles:['gitleaks','trivy'],batchKey:key,batchId,now:NOW});
  const rk=trainRunKey({repo:s.repo,seed:'e'.repeat(64)});
  const tr=deriveTrainRun({recordDocs:r.docs,runId:rk.slice(0,16)+'-abcdef012345',runKey:rk,mode:'shadow',now:NOW});
  const plans=Object.entries({...d.files,...rs.files,...tr.files}).filter(([n])=>n.endsWith('/formal-service-entry.json')).map(([,v])=>JSON.parse(v));
  assert.equal(plans.length,10);
  for(const p of plans){assert.equal(p.contract,'clued.independent-ci.fixed-formal-windows-entry/3');assert.equal(p.nodeProfileSha256,digest(r.inputs.node));assert.equal(p.acceptanceSha256,r.recordManifest.acceptanceSha256);}
  const current=fs.readFileSync(new URL('../src/independent-control-checks-v2/consumer.mjs',import.meta.url),'utf8');
  assert.match(current,/CONSUMER_PROVIDER_V2 = 'independent-control-checks-v2'/);
  assert.doesNotMatch(current,/from ['"][^'"]*independent-control-checks-v1/);
  const publisher=fs.readFileSync(new URL('../src/independent-control-checks-v2/publisher.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(publisher,/(?:import\(|from\s*)['"][^'"]*independent-control-checks-v1/);
  assert.equal(canonical(r.inputs.node),JSON.stringify(JSON.parse(canonical(r.inputs.node))));
});

test('the actual v2 admission environment cannot inherit an ambient request for the legacy installed consumer', async () => {
  const repo='tdoljyj/cross-memory-system', scope=`project:${uuid}`, policyText='{"fixture":"policy"}';
  const job=makeJobV2({...subject(),role:'control-admission',sourceManifestSha256:'d'.repeat(64)});
  const config={domain:'fixture',repository:repo,scope,workspace:os.tmpdir(),sourceManifestSha256:job.sourceManifestSha256,
    evaluatorSha256:digest('FIXTURE_EVALUATOR'),policyText,policySha256:digest(policyText),ciPrincipalBindingId:uuid,
    ciPrincipalQualificationRef:'fixture-qualification',publishableKey:'sb_publishable_fixture',supabaseUrl:'https://fixture.example.invalid'};
  let seen=null;
  const port=createFullAdmissionPortV2({protectedConfig:config,clock:()=>NOW,
    tokenProvider:async()=>({githubToken:'fixture-github',ciAdmissionToken:['clued','bnd','fixture123'].join('_'),ciPrincipalBindingId:uuid,ciPrincipalQualificationRef:config.ciPrincipalQualificationRef}),
    modeProvider:async()=>({complete:true,repository:repo,variable:'CLUED_MERGE_ADMISSION_STATE',source:'github-repository-variables',exists:false,observedAt:new Date(NOW).toISOString(),proofRef:'fixture-mode'}),
    recorderProvider:async()=>({domain:'fixture',kind:'independent-controller',observedAt:new Date(NOW).toISOString(),observationRef:'fixture',recorder:{newId:()=>uuid,record(){}}}),
    fetchImpl:async url=>{assert.ok(new URL(url).pathname.endsWith(`/pulls/${job.pr}`));return {ok:true,status:200,json:async()=>({number:job.pr,state:'open',body:`Clued-Work-Claim: ${uuid}\nClued-Work-Scope: ${scope}`,head:{sha:job.headSha,repo:{full_name:repo}},base:{sha:job.baseSha,ref:'main',repo:{full_name:repo}}})};},
    fixtureHooks:{evaluatorReader:()=>'FIXTURE_EVALUATOR',evaluateImpl:async({env})=>{seen=env;return {admitted:false,verdict:'DENIED',reasons:[]};}}});
  const original=process.env.CLUED_EXECUTION_PROVIDER;
  try{
    process.env.CLUED_EXECUTION_PROVIDER='independent-control-checks-v1';
    const facts=await port.evaluatePr(job,{complete:true,pr:job.pr,headSha:job.headSha,baseSha:job.baseSha,paths:['a.txt']});
    assert.equal(facts.reason,'full_admission_rejected');
    assert.ok(seen);assert.equal(Object.hasOwn(seen,'CLUED_EXECUTION_PROVIDER'),false);
  }finally{if(original===undefined)delete process.env.CLUED_EXECUTION_PROVIDER;else process.env.CLUED_EXECUTION_PROVIDER=original;}
});
