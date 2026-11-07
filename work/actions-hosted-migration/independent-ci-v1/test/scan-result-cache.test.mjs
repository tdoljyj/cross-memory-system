// M4 scan result cache by tested tree (DESIGN 65). The real trivy scanner loop, the real result persistence step and the
// real placement execution step, isolated only at their physical Docker transport (the same in-memory substitution as
// formal-trivy-scan-start-window.test.mjs); the cache port is the real one over a temporary directory, with the
// protected-path guard replaced where a test says so (the offline tests do not run as root on Linux). Signed results are
// made with a test Ed25519 key through the real resultPayload, and checked by the real observationFacts and
// verifySignedBridgeResult with a real bridge v4 issue.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,generateKeyPairSync,sign} from 'node:crypto';
import {makeJobV2} from '../src/job-v2.mjs';
import {canonical,digest} from '../src/proof.mjs';
import {ENVELOPE_CONTRACT_V2} from '../src/proof-v2.mjs';
import {noteScanStartResponseWindow} from '../src/scan-start-v1/grant.mjs';
import {admittedFacts,BASE} from './resident-v2-fixtures.mjs';
import {IMAGE,WORKFLOW_SHA256S,CHECKS_REPOSITORY} from '../worker/required-trivy-v3/plans.mjs';
import {cacheKey,cacheSettings,createResultCache,parseCacheRecord,cacheRecord,validateCacheHitEvidence,verifyOriginalEnvelope,CACHE_HIT_CONTRACT,
  CACHE_TTL_MS,ORPHAN_TEMPORARY_AGE_MS,trivyScannersSha256,placementCommandTemplateSha256} from '../worker/scan-result-cache-v1/cache.mjs';
import {trivyResultKey} from '../worker/formal-trivy-v4/adapter.mjs';
import {placementResultKey,validateAdmission as placementAdmission,WORKFLOW_SHA256S as PLACEMENT_WORKFLOWS} from '../worker/formal-contract-placement-v2/adapter.mjs';
import {fixedCommands,LIMITS as PLACEMENT_LIMITS} from '../worker/formal-contract-placement-v2/container-entry.mjs';
import {observationFacts,resultPayload,verifySignedBridgeResult,RESULT_WRAPPER_CONTRACT_V2} from '../worker/protected-job-bridge-v4/signed-result.mjs';
import {makeIssue,makeResponse,encode,decode} from '../worker/protected-job-bridge-v4/protocol.mjs';
import {protectedPath} from '../worker/qualification-v2.mjs';

const START=Date.parse('2026-11-07T00:00:00.000Z'),hex=c=>c.repeat(64),H1='a'.repeat(40),H2='d'.repeat(40),H3='e'.repeat(40);
const noGuard=async()=>{};
// In-memory copy of a module with its physical imports replaced and its private steps exported (this test module only).
async function isolated(url,replacements,exportLine){
  let source=await fs.readFile(url,'utf8');
  for(const [physicalImport,stubLines] of replacements){
    const stub='data:text/javascript;base64,'+Buffer.from(stubLines.join('\n')).toString('base64');
    assert.equal(source.split(physicalImport).length,2,'one exact substitution of '+physicalImport);
    source=source.replace(physicalImport,physicalImport.replace(/(['"])[^'"]+\1(;?)$/,`${JSON.stringify(stub)}$2`));
  }
  source=source.replace(/from\s*(['"])(\.[^'"]+)\1/g,(_all,_q,relative)=>`from ${JSON.stringify(new URL(relative,url).href)}`)+'\n'+exportLine+'\n';
  return import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
}
const trivyUrl=new URL('../worker/formal-trivy-v4/adapter.mjs',import.meta.url),dockerUrl=new URL('../worker/formal-trivy-v3/docker.mjs',import.meta.url);
const {regressionExecuteScanners,regressionFinishObservation}=await isolated(trivyUrl,[["import { actualDockerClient, NATIVE_IMAGE, runFixedScanner } from '../formal-trivy-v3/docker.mjs';",
  [`export {NATIVE_IMAGE} from ${JSON.stringify(dockerUrl.href)};`,`export function actualDockerClient(){throw Error('ACTUAL_DOCKER_NOT_ALLOWED_IN_REGRESSION');}`,
    `export async function runFixedScanner(input){return input.docker.scanner(input);}`]]],
  'export {executeScanners as regressionExecuteScanners, finishObservation as regressionFinishObservation};');
const placementUrl=new URL('../worker/formal-contract-placement-v2/adapter.mjs',import.meta.url);
const {regressionExecutePlacement}=await isolated(placementUrl,[["import {observeUnsignedContainer} from '../verify-once/verify-worker.mjs';",
  [`export async function observeUnsignedContainer(){throw Error('ACTUAL_DOCKER_NOT_ALLOWED_IN_REGRESSION');}`]]],'export {executePlacement as regressionExecutePlacement};');

async function tempDir(t,prefix='clued-scan-cache-'){const dir=await fs.mkdtemp(path.join(os.tmpdir(),prefix));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
// The qualified result key, as the role policy holds it (publicKeyPem, keyId, runtimeIdentity) and the Windows issuer's signer table.
const KEYS=generateKeyPairSync('ed25519'),OTHER=generateKeyPairSync('ed25519');
const CONTEXT={runtimeIdentity:'isolated-regression',hostAcceptanceRef:'host-acceptance-ref-0001',sourceAcceptanceRef:'source-acceptance-ref-0001'};
const SIGNER={publicKeyPem:KEYS.publicKey.export({type:'spki',format:'pem'}),keyId:'result-key-1',runtimeId:CONTEXT.runtimeIdentity};
const SIGNERS=new Map([[SIGNER.keyId,{domain:'production',publicKeyPem:SIGNER.publicKeyPem,runtimeId:SIGNER.runtimeId,qualificationRef:CONTEXT.hostAcceptanceRef,sourceAcceptanceRef:CONTEXT.sourceAcceptanceRef}]]);
const port=(root,{guard=noGuard,signer=SIGNER,now}={})=>createResultCache({enabled:true,root,role:'trivy'},{guard,signer,...(now?{now}:{})});
const logs={stdout:{bytes:10,sha256:hex('5'),truncated:false},stderr:{bytes:0,sha256:hex('6'),truncated:false}};
const generationOf=()=>({claimId:randomUUID(),fence:3,epoch:1,expiresAt:new Date(Date.now()+3600000).toISOString()});
function grantFor(job,role){const issued=Date.now();return noteScanStartResponseWindow({status:'committed',contract:'clued.ci-scan-start-grant/1',launch_allowed:true,
  execution_id:randomUUID(),receipt_id:randomUUID(),repository_id:1334673495,head_sha:job.headSha,role,provider:'independent-controller',
  start_requested_at:new Date(issued).toISOString()},{issuedAt:new Date(issued).toISOString(),expiresAt:new Date(issued+120000).toISOString()});}
// The real bridge v4 issue for a job, and the result the Linux signer would emit for an observation (real resultPayload).
function issueFor(job,generation){
  return makeIssue(job,admittedFacts(job,generation,{complete:true,paths:['README.md']},{batchClaim:generation}),null,
    {sourceAcceptanceRef:CONTEXT.sourceAcceptanceRef,hostQualificationRef:CONTEXT.hostAcceptanceRef,expiresAt:new Date(Date.now()+3600000).toISOString()});
}
function signedResult(issue,observation,key=KEYS.privateKey,keyId=SIGNER.keyId){
  const payload=resultPayload(issue,observation,observationFacts(issue,observation),CONTEXT.runtimeIdentity);
  const envelope={contract:ENVELOPE_CONTRACT_V2,keyId,payload,signature:sign(null,Buffer.from(canonical(payload)),key).toString('base64url')};
  return {contract:RESULT_WRAPPER_CONTRACT_V2,domain:'production',issueSha256:digest(issue),envelope,observation};
}

// ---- trivy -------------------------------------------------------------------------------------------------------------
const KEY_CONTEXT={policyImage:IMAGE,dockerExecutableSha256:hex('7')};
function trivyRun(t,{headSha=H1,testSha=headSha,files=[{path:'README.md',sha256:hex('1')}],tree='c'.repeat(40),db=hex('a'),sourceManifestSha256=hex('e'),
  context=CONTEXT,keyContext=KEY_CONTEXT,resultCache=null,exitCode=0,refuseAdmissionAt=0,deadlineMs=25*60000}={}){
  const job=makeJobV2({repo:'tdoljyj/cross-memory-system',pr:888,headSha,baseSha:BASE,testSha,sourceManifestSha256,role:'trivy',attempt:1,createdAt:new Date(Date.now()-1000).toISOString()});
  const generation=generationOf(),database={exists:true,complete:true,directory:'/cache/db',bytes:128,sha256:db,metadataSha256:hex('b'),
    metadata:{Version:2,UpdatedAt:new Date(Date.now()-1000).toISOString(),NextUpdate:new Date(Date.now()+3600000).toISOString()}};
  const checksPin={repository:CHECKS_REPOSITORY,digest:'sha256:'+hex('c'),majorVersion:2,contentSha256:hex('d')};
  const checksBundle={complete:true,directory:'/cache/checks',contentSha256:checksPin.contentSha256,metadataSha256:hex('f'),
    metadata:{Digest:checksPin.digest,MajorVersion:2,DownloadedAt:new Date(Date.now()-1000).toISOString(),CustomBuild:false},files:[{path:'fixed.rego'}]};
  const preparedRequest={schema:'independent-ci.container-execution-request.v1',containerCommand:{image:IMAGE},identity:{...job,jobId:job.id},
    candidateTreeSha:tree,sourceSha:'9'.repeat(40),sourceTreeSha:'8'.repeat(40),nonce:hex('1')};
  const inputInventory={complete:true,candidateTreeSha:tree,paths:files.map(f=>f.path),files};
  const starts=[];let admissions=0,grants=0;
  const admissionPort=async()=>{admissions++;await Promise.resolve();t.mock.timers.tick(1);
    const facts=admittedFacts(job,generation,{complete:true,paths:inputInventory.paths},{batchClaim:generation,observedAt:Date.now()});
    return admissions===refuseAdmissionAt?{...facts,claimId:randomUUID()}:facts;};
  const scanStartPort=async()=>{grants++;return grantFor(job,'trivy');};
  const docker={async scanner({scan}){starts.push(scan.scanner);t.mock.timers.tick(1000);const at=new Date().toISOString();
    return {scanner:scan.scanner,requestSha256:hex('2'),nonce:hex('3'),executionId:randomUUID(),exitCode,complete:true,touched:true,reason:null,logs,
      containerId:'c-'+scan.scanner,imageId:'sha256:'+hex('4'),startedAt:new Date(Date.now()-500).toISOString(),finishedAt:at,cleanupConfirmed:true,cleanupObservedAt:at};}};
  return {job,generation,starts,get admissions(){return admissions;},get grants(){return grants;},
    run:async()=>{const r=await regressionExecuteScanners({job,preparedRequest,snapshotDirectory:'/snapshot/repo',inputInventory,
      cache:{database,checksBundle,dbDecision:{status:'READY',fallback:false,db:database},provenanceSha256:hex('9')},checksPin,
      workflowSha256:WORKFLOW_SHA256S[0],docker,dockerRootDirectory:'/var/lib/docker',deadline:Date.now()+deadlineMs,
      admissionPort,scanStartPort,scanStartRecord:async()=>{},fixture:false,nativeScanStartRequired:true,context,generation,resultCache,keyContext});
      // As createFormalTrivyAdapter does after the snapshot is removed: the final observation is the one persisted and signed.
      t.mock.timers.tick(10);
      const observation=r.observation&&Object.freeze({...r.observation,cleanup:{...r.observation.cleanup,snapshotRemoved:true,observedAt:new Date().toISOString()}});
      return {...r,observation};}};
}
// A run through the real persistence step: observation.json, result-cache.json, then (only for a real success) the store
// the bridge calls with the signed result. writes lists every file written, in order.
async function persist(t,run,r,resultCache){
  const dir=await tempDir(t,'clued-scan-run-'),writes=[];
  const write=async(file,value)=>{writes.push(path.basename(file));await fs.writeFile(file,canonical(value),{flag:'wx'});};
  const store=await regressionFinishObservation({run:dir,job:run.job,observation:r.observation,result:r,resultCache,write});
  return {dir,writes,store,read:async name=>JSON.parse(await fs.readFile(path.join(dir,name),'utf8'))};
}
async function storeTrivy(t,resultCache,options={}){
  const first=trivyRun(t,{resultCache,...options}),r=await first.run();
  assert.equal(r.resultCache.lookup,'SCAN_RESULT_CACHE_MISS');assert.deepEqual(first.starts,['vuln','secret','misconfig']);
  const issue=issueFor(first.job,first.generation),signed=signedResult(issue,r.observation),p=await persist(t,first,r,resultCache);
  assert.equal(typeof p.store,'function');const stored=await p.store(signed);assert.equal(stored.stored,true,stored.reason);
  return {first,r,signed,stored,persisted:p};
}

test('trivy: the same tree scanned again under another commit is a hit; no scanner starts, admissions and the grant still happen',async t=>{
  t.mock.timers.enable({apis:['Date'],now:START});const resultCache=port(await tempDir(t));
  const {r:original,signed:originalSigned,stored}=await storeTrivy(t,resultCache);
  const again=trivyRun(t,{headSha:H2,resultCache}),r=await again.run(),o=r.observation;
  assert.deepEqual(again.starts,[],'no scanner container is started');
  assert.equal(again.grants,1,'the scan-start grant is still taken and recorded (the head is burnt as for a real run)');
  assert.equal(again.admissions,2,'a role pre admission and a new post admission');
  assert.equal(r.status,'THREE_SCANNERS_OBSERVED_UNSIGNED');assert.equal(r.resultCache.lookup,'SCAN_RESULT_CACHE_HIT');
  assert.equal(o.conclusion,'success');assert.equal(o.subject.headSha,H2,'the observation is for this job');
  assert.equal(Object.hasOwn(o,'scans'),false,"the original scanner records are not presented as this run's");
  assert.deepEqual(o.cacheHit.originalObservation,original.observation,'the original observation travels inside cacheHit');
  assert.deepEqual(o.cacheHit.originalEnvelope,originalSigned.envelope,'with its signed envelope');
  assert.equal(o.cacheHit.contract,CACHE_HIT_CONTRACT);assert.equal(o.cacheHit.originalObservationSha256,digest(original.observation));
  assert.equal(o.cacheHit.recordSha256,stored.recordSha256);
  assert.notEqual(o.preAdmissionSha256,original.observation.preAdmissionSha256,"this run's own admissions");
  assert.notEqual(o.postAdmissionSha256,original.observation.postAdmissionSha256);
  // The Linux signer's payload and the Windows issuer's full verification of the hit (real issue, signer table).
  const issue=issueFor(again.job,again.generation),signed=signedResult(issue,o),facts=observationFacts(issue,o);
  assert.equal(facts.startedAt,o.cacheHit.servedAt,"the signed window is this run's");
  assert.deepEqual(signed.envelope.payload.cacheHit,{keySha256:o.cacheHit.keySha256,recordSha256:o.cacheHit.recordSha256,originalObservationSha256:o.cacheHit.originalObservationSha256},'the signed payload marks the hit');
  assert.equal(originalSigned.envelope.payload.cacheHit,null,'a real run is marked as no hit');
  assert.ok(verifySignedBridgeResult({issue,wrapper:signed,signers:SIGNERS}));
  const wrongMarker=signedResult(issue,o);wrongMarker.envelope.payload.cacheHit=null;
  wrongMarker.envelope.signature=sign(null,Buffer.from(canonical(wrongMarker.envelope.payload)),KEYS.privateKey).toString('base64url');
  assert.throws(()=>verifySignedBridgeResult({issue,wrapper:wrongMarker,signers:SIGNERS}),{code:'SIGNED_FORMAL_OBSERVATION_CHANGED'},'a hit signed as a real run is refused');
  const foreign=new Map([[SIGNER.keyId,{...SIGNERS.get(SIGNER.keyId),publicKeyPem:OTHER.publicKey.export({type:'spki',format:'pem'})}]]);
  assert.throws(()=>verifySignedBridgeResult({issue,wrapper:signed,signers:foreign}),{code:/RESULT_SIGNATURE_INVALID|result_signature_invalid|SCAN_RESULT_CACHE_SIGNATURE_INVALID/});
});
test('trivy: a message-only force-push (new head, same tree) and a recomputed S (new testSha, same tree) both hit',async t=>{
  t.mock.timers.enable({apis:['Date'],now:START});const resultCache=port(await tempDir(t));await storeTrivy(t,resultCache);
  for(const run of [trivyRun(t,{headSha:H2,resultCache}),trivyRun(t,{headSha:H1,testSha:H3,resultCache})]){
    const r=await run.run();assert.deepEqual(run.starts,[]);assert.equal(r.resultCache.lookup,'SCAN_RESULT_CACHE_HIT');}
});
test('trivy: any change of a key component is a miss and the scanners run',async t=>{
  t.mock.timers.enable({apis:['Date'],now:START});const resultCache=port(await tempDir(t));await storeTrivy(t,resultCache);
  const variants={'file bytes':{files:[{path:'README.md',sha256:hex('2')}]},'file set':{files:[{path:'README.md',sha256:hex('1')},{path:'b.txt',sha256:hex('1')}]},
    'candidate tree':{tree:'f'.repeat(40)},'offline database':{db:hex('0')},'Source manifest':{sourceManifestSha256:hex('3')},
    'runtime identity':{context:{...CONTEXT,runtimeIdentity:'other-runtime'}},'host acceptance':{context:{...CONTEXT,hostAcceptanceRef:'other-host-ref'}},
    'source acceptance':{context:{...CONTEXT,sourceAcceptanceRef:'other-source-ref'}},'docker client':{keyContext:{...KEY_CONTEXT,dockerExecutableSha256:hex('8')}}};
  for(const [name,options] of Object.entries(variants)){
    const run=trivyRun(t,{headSha:H2,resultCache,...options}),r=await run.run();
    assert.deepEqual(run.starts,['vuln','secret','misconfig'],name);assert.equal(r.resultCache.lookup,'SCAN_RESULT_CACHE_MISS',name);}
});
test('trivy: a key with a missing component is no key: nothing is looked up, the scanners run',async t=>{
  t.mock.timers.enable({apis:['Date'],now:START});const resultCache=port(await tempDir(t));await storeTrivy(t,resultCache);
  for(const options of [{keyContext:{policyImage:IMAGE}},{keyContext:null},{context:{...CONTEXT,hostAcceptanceRef:''}}]){
    const run=trivyRun(t,{headSha:H2,resultCache,...options}),r=await run.run();
    assert.deepEqual(run.starts,['vuln','secret','misconfig']);assert.equal(r.resultCache.lookup,'SCAN_RESULT_CACHE_KEY_INCOMPLETE');assert.equal(r.resultKey,null);}
  assert.equal(trivyResultKey({get job(){throw Error('boom');}}),null,'a key builder failure is no key, never a throw');
});
test('trivy: a tampered, truncated, unsigned, foreign or unsuccessful record is a miss and the scanners run',async t=>{
  t.mock.timers.enable({apis:['Date'],now:START});const root=await tempDir(t),resultCache=port(root);
  const {r}=await storeTrivy(t,resultCache),file=path.join(root,'trivy',r.resultKey.keySha256+'.json'),good=await fs.readFile(file);
  const record=JSON.parse(good),resign=value=>{const {recordSha256,...body}=value;return JSON.stringify({...body,recordSha256:digest(body)});};
  const failed=structuredClone(record);failed.observation.conclusion='failure';failed.observation.scans[0].exitCode=1;failed.originalObservationSha256=digest(failed.observation);
  const chained=structuredClone(record);chained.observation.cacheHit={contract:CACHE_HIT_CONTRACT};chained.originalObservationSha256=digest(chained.observation);
  const otherKey=structuredClone(record);otherKey.key.candidateTreeSha='f'.repeat(40);
  const forged=structuredClone(record);forged.envelope.signature=sign(null,Buffer.from(canonical(forged.envelope.payload)),OTHER.privateKey).toString('base64url');
  const unsigned=structuredClone(record);unsigned.envelope.signature='AAAA';
  const otherObservation=structuredClone(record);otherObservation.envelope.payload.executionObservationSha256=hex('0');
  const tampered={'one byte changed':Buffer.from(good.toString().replace('"success"','"succe5s"')),'truncated':good.subarray(0,good.length-7),'empty':Buffer.alloc(0),
    'not json':Buffer.from('{'),'scans removed, digest stale':Buffer.from(JSON.stringify({...record,observation:{...record.observation,scans:[]}})),
    'a failed run, re-digested':Buffer.from(resign(failed)),'a hit stored as a record, re-digested':Buffer.from(resign(chained)),
    'another key, re-digested':Buffer.from(resign(otherKey)),'observation digest stale':Buffer.from(resign({...record,originalObservationSha256:hex('0')})),
    'signed by another key, re-digested':Buffer.from(resign(forged)),'signature garbage, re-digested':Buffer.from(resign(unsigned)),
    'envelope of another observation, re-digested':Buffer.from(resign(otherObservation))};
  for(const [name,bytes] of Object.entries(tampered)){
    await fs.writeFile(file,bytes);const run=trivyRun(t,{headSha:H2,resultCache}),out=await run.run();
    assert.deepEqual(run.starts,['vuln','secret','misconfig'],name);assert.equal(out.observation.cacheHit,undefined,name);assert.notEqual(out.resultCache.lookup,'SCAN_RESULT_CACHE_HIT',name);}
  await fs.writeFile(file,good);const run=trivyRun(t,{headSha:H2,resultCache});await run.run();assert.deepEqual(run.starts,[],'the untouched record hits again');
});
test('trivy: a record stored in the future or older than its TTL is a miss',async t=>{
  t.mock.timers.enable({apis:['Date'],now:START});const root=await tempDir(t);
  await storeTrivy(t,port(root,{now:()=>Date.now()+60_000}));
  let run=trivyRun(t,{headSha:H2,resultCache:port(root)});assert.equal((await run.run()).resultCache.lookup,'SCAN_RESULT_CACHE_RECORD_FROM_FUTURE');assert.equal(run.starts.length,3);
  const fresh=await tempDir(t),resultCache=port(fresh);await storeTrivy(t,resultCache);
  t.mock.timers.tick(CACHE_TTL_MS.trivy-60_000);run=trivyRun(t,{headSha:H2,resultCache});assert.equal((await run.run()).resultCache.lookup,'SCAN_RESULT_CACHE_HIT','inside the TTL');
  t.mock.timers.tick(120_000);run=trivyRun(t,{headSha:H2,resultCache});assert.equal((await run.run()).resultCache.lookup,'SCAN_RESULT_CACHE_RECORD_EXPIRED');assert.equal(run.starts.length,3);
});
test('trivy: with the policy switch off nothing is read or written, even with a valid record present',async t=>{
  t.mock.timers.enable({apis:['Date'],now:START});const root=await tempDir(t);await storeTrivy(t,port(root));
  const config={workspaceRoot:'/w',runsRoot:'/r',trustedSourceDirectory:'/s',dockerRootDirectory:'/var/lib/docker',signingKeyFile:'/k/key',qualificationFile:'/k/q',publicKeyFile:'/k/pub',sourceManifestFile:'/s/m',entryFile:'/s/e'};
  for(const value of [undefined,{enabled:false,root},{enabled:'true',root},{enabled:true},{enabled:true,root:'/r/cache'},{enabled:true,root:'/k'},{enabled:true,root,extra:1},
    {enabled:true,root:'/var/lib/docker/cache'},{enabled:true,root:'/var/lib'}]){
    const settings=cacheSettings({...config,scanResultCache:value},'trivy');assert.equal(settings.enabled,false,JSON.stringify(value));
    const resultCache=createResultCache(settings,{guard:noGuard,signer:SIGNER}),run=trivyRun(t,{headSha:H2,resultCache}),r=await run.run();
    assert.deepEqual(run.starts,['vuln','secret','misconfig']);assert.equal(r.resultKey,null);
    assert.equal((await persist(t,run,r,resultCache)).store,null,'nothing to store with the switch off');}
  const on=cacheSettings({...config,scanResultCache:{enabled:true,root:'/var/lib/clued-independent-ci/scan-result-cache//'}},'trivy');
  assert.deepEqual([on.enabled,on.root],[true,'/var/lib/clued-independent-ci/scan-result-cache'],'trailing slashes are removed');
  assert.equal(cacheSettings({...config,scanResultCache:{enabled:true,root:'/var/lib/c'}},'gitleaks').enabled,false,'gitleaks is never cached');
  assert.equal(cacheSettings({...config,scanResultCache:{enabled:true,root:'/var/lib/c'}},'contract-placement').reason,'SCAN_RESULT_CACHE_KEY_NOT_CLOSED_FOR_ROLE','placement stays off');
  assert.equal(createResultCache({enabled:true,root,role:'trivy'},{guard:noGuard}).enabled,false,'no signer key, no cache');
});

// ---- guard, persistence and store maintenance ---------------------------------------------------------------------------
test('guard: all three levels are checked; a refusal at any of them (not root, group-writable, symlink, nlink, mode) is a miss',async t=>{
  t.mock.timers.enable({apis:['Date'],now:START});const root=await tempDir(t);const {r}=await storeTrivy(t,port(root));
  const calls=[];const record=async(file,options)=>{calls.push([path.relative(root,file)||'.',JSON.stringify(options)]);};
  let run=trivyRun(t,{headSha:H2,resultCache:port(root,{guard:record})});assert.equal((await run.run()).resultCache.lookup,'SCAN_RESULT_CACHE_HIT');
  assert.deepEqual(calls,[['.','{"directory":true}'],['trivy','{"directory":true}'],[path.join('trivy',r.resultKey.keySha256+'.json'),'{"privateFile":true}']]);
  const refusals={root:['ROOT_LINUX_REQUIRED',0],'group-writable root':['UNPROTECTED_PATH',0],'symlinked role directory':['UNPROTECTED_PATH',1],
    'record with two links':['UNSAFE_FILE_TYPE',2],'record not 0600':['PRIVATE_FILE_PERMISSIONS',2]};
  for(const [name,[code,level]] of Object.entries(refusals)){let n=0;
    const guard=async()=>{if(n++===level)throw Object.assign(new Error(code),{code});};
    run=trivyRun(t,{headSha:H2,resultCache:port(root,{guard})});const out=await run.run();
    assert.equal(out.resultCache.lookup,code,name);assert.deepEqual(run.starts,['vuln','secret','misconfig'],name);}
  run=trivyRun(t,{headSha:H2,resultCache:port(root,{guard:protectedPath})});
  assert.equal((await run.run()).resultCache.lookup,'ROOT_LINUX_REQUIRED','the real protectedPath refuses a non-root reader');
});
test('persistence: observation first, then result-cache.json; only a real success can be stored, and only with its own signed result',async t=>{
  t.mock.timers.enable({apis:['Date'],now:START});const root=await tempDir(t),resultCache=port(root);
  const {persisted,stored}=await storeTrivy(t,resultCache);
  assert.deepEqual(persisted.writes,['observation.json','result-cache.json','result-cache-store.json']);
  assert.equal((await persisted.read('result-cache.json')).lookup,'SCAN_RESULT_CACHE_MISS');assert.equal((await persisted.read('result-cache-store.json')).reason,stored.reason);
  const hit=trivyRun(t,{headSha:H2,resultCache}),hr=await hit.run(),hp=await persist(t,hit,hr,resultCache);
  assert.equal(hp.store,null,'a hit is never stored');assert.deepEqual(hp.writes,['observation.json','result-cache.json']);
  const facts=await hp.read('result-cache.json');assert.equal(facts.lookup,'SCAN_RESULT_CACHE_HIT');assert.equal(facts.cacheHit.recordSha256,hr.observation.cacheHit.recordSha256);
  const failing=trivyRun(t,{headSha:H3,tree:'f'.repeat(40),resultCache,exitCode:1}),fr=await failing.run();
  assert.equal(fr.observation.conclusion,'failure');assert.equal((await persist(t,failing,fr,resultCache)).store,null,'a failure is never stored');
  const other=trivyRun(t,{headSha:H3,tree:'1'.repeat(40),resultCache}),or=await other.run(),op=await persist(t,other,or,resultCache);
  const mismatch=await op.store(signedResult(issueFor(other.job,other.generation),{...or.observation,nonce:hex('0')}));
  assert.deepEqual([mismatch.stored,mismatch.reason],[false,'SCAN_RESULT_CACHE_SIGNED_RESULT_MISMATCH']);
  const unsignedStore=await resultCache.store(or.resultKey,or.observation,{...signedResult(issueFor(other.job,other.generation),or.observation).envelope,signature:'AAAA'});
  assert.equal(unsignedStore.stored,false,'the port itself refuses an envelope the key did not sign');
});
test('store: an orphan temporary file is removed (a two-link record reads again) and a damaged record is replaced',async t=>{
  t.mock.timers.enable({apis:['Date'],now:START});const root=await tempDir(t),resultCache=port(root);
  const {r}=await storeTrivy(t,resultCache),dir=path.join(root,'trivy'),file=path.join(dir,r.resultKey.keySha256+'.json');
  // A crash after link and before unlink: the record has two links and the strict guard refuses it.
  const orphan=path.join(dir,'.'+r.resultKey.keySha256+'.0123456789abcdef.tmp');await fs.link(file,orphan);
  const old=new Date(Date.now()-ORPHAN_TEMPORARY_AGE_MS-1000);await fs.utimes(orphan,old,old);
  const strict=async(p,options={})=>{if(options.privateFile&&(await fs.lstat(p)).nlink!==1)throw Object.assign(new Error('UNSAFE_FILE_TYPE'),{code:'UNSAFE_FILE_TYPE'});};
  let run=trivyRun(t,{headSha:H2,resultCache:port(root,{guard:strict})});assert.equal((await run.run()).resultCache.lookup,'UNSAFE_FILE_TYPE');
  // A real run of the same tree (no cache in the way) is what a later miss would store under the same key.
  const again=trivyRun(t,{headSha:H3}),ar=await again.run();
  const kept=await port(root,{guard:strict}).store(r.resultKey,ar.observation,signedResult(issueFor(again.job,again.generation),ar.observation).envelope);
  assert.equal(kept.reason,'SCAN_RESULT_CACHE_RECORD_EXISTS','the sweep removed the orphan, the record reads again and is kept');
  await assert.rejects(fs.lstat(orphan),{code:'ENOENT'});
  run=trivyRun(t,{headSha:H2,resultCache:port(root,{guard:strict})});assert.equal((await run.run()).resultCache.lookup,'SCAN_RESULT_CACHE_HIT');
  await fs.writeFile(file,'damaged');
  const replaced=await resultCache.store(r.resultKey,ar.observation,signedResult(issueFor(again.job,again.generation),ar.observation).envelope);
  assert.equal(replaced.reason,'SCAN_RESULT_CACHE_RECORD_REPLACED');
  run=trivyRun(t,{headSha:H2,resultCache});assert.equal((await run.run()).resultCache.lookup,'SCAN_RESULT_CACHE_HIT');
  assert.deepEqual((await fs.readdir(dir)).filter(n=>n.endsWith('.tmp')),[],'no temporary file is left behind');
});
test('hit path refusals: burn permission lapsed, post admission refused or deadline passed produce no observation',async t=>{
  t.mock.timers.enable({apis:['Date'],now:START});const root=await tempDir(t),resultCache=port(root);await storeTrivy(t,resultCache);
  const slow=ms=>({enabled:true,lookup:async key=>{const out=await resultCache.lookup(key);t.mock.timers.tick(ms);return out;}});
  const lapsed=trivyRun(t,{headSha:H2,resultCache:slow(120_001)});
  await assert.rejects(lapsed.run(),{code:'SCAN_START_GRANT_REFUSED'});assert.deepEqual(lapsed.starts,[]);
  const refused=trivyRun(t,{headSha:H2,resultCache,refuseAdmissionAt:2});await assert.rejects(refused.run());assert.deepEqual(refused.starts,[]);
  const late=trivyRun(t,{headSha:H2,resultCache:slow(60_000),deadlineMs:30_000});
  await assert.rejects(late.run(),{code:'AUTHORITY_EXPIRED_BEFORE_SCAN'});assert.deepEqual(late.starts,[]);
});

// ---- signer and issuer checks ------------------------------------------------------------------------------------------
test('signer and issuer: cacheHit only for trivy and only well formed, with the original scanners no later than storedAt',async t=>{
  t.mock.timers.enable({apis:['Date'],now:START});const resultCache=port(await tempDir(t));await storeTrivy(t,resultCache);
  const run=trivyRun(t,{headSha:H2,resultCache}),o=(await run.run()).observation,issue=issueFor(run.job,run.generation);
  assert.ok(observationFacts(issue,o));
  const bad={'record digest malformed':{...o.cacheHit,recordSha256:'x'},'extra field':{...o.cacheHit,extra:1},
    'original digest stale':{...o.cacheHit,originalObservationSha256:hex('0')},'stored after served':{...o.cacheHit,storedAt:new Date(Date.now()+1000).toISOString()},
    'original scanner after storedAt':{...o.cacheHit,storedAt:new Date(Date.parse(o.cacheHit.originalObservation.scans[2].finishedAt)-1).toISOString()},
    'original not a success':(()=>{const x=structuredClone(o.cacheHit);x.originalObservation.conclusion='failure';x.originalObservationSha256=digest(x.originalObservation);return x;})()};
  for(const [name,cacheHit] of Object.entries(bad))assert.throws(()=>observationFacts(issue,{...o,cacheHit}),{code:'SCAN_RESULT_CACHE_HIT_EVIDENCE_REQUIRED'},name);
  assert.throws(()=>observationFacts(issue,{...o,scans:o.cacheHit.originalObservation.scans}),{code:'SCAN_RESULT_CACHE_HIT_EVIDENCE_REQUIRED'},'no scans of its own beside cacheHit');
  const gl={...o,contract:'clued.independent-ci.formal-scanner-observation/2',profile:'required-gitleaks-history/1'};
  assert.throws(()=>observationFacts({...issue,job:{...issue.job,role:'gitleaks'}},gl),{code:/ACTUAL_FORMAL_PROFILE_REQUIRED|SCAN_RESULT_CACHE_HIT_ROLE_REFUSED/});
  assert.throws(()=>validateCacheHitEvidence(o.cacheHit,'gitleaks',o),{code:'SCAN_RESULT_CACHE_HIT_ROLE_REFUSED'});
  assert.throws(()=>validateCacheHitEvidence(o.cacheHit,'contract-placement',o),{code:'SCAN_RESULT_CACHE_HIT_ROLE_REFUSED'});
  assert.throws(()=>verifyOriginalEnvelope(o.cacheHit.originalEnvelope,{...SIGNER,publicKeyPem:OTHER.publicKey.export({type:'spki',format:'pem'})},o.cacheHit.originalObservation),{code:'SCAN_RESULT_CACHE_SIGNATURE_INVALID'});
  const {cacheHit:_h,...noHit}=o;assert.throws(()=>observationFacts(issue,noHit),{code:'ACTUAL_THREE_SCANNERS_CLEANUP_REQUIRED'},'without cacheHit it must have its own scans');
});

// ---- key completeness (pure) ------------------------------------------------------------------------------------------
test('cacheKey: every component is required and every change gives another key',()=>{
  const trivy={repo:'tdoljyj/cross-memory-system',profile:'required-trivy-three-scanners/1',sourceManifestSha256:hex('e'),sourceSha:'9'.repeat(40),
    workflowSha256:hex('1'),runtimeIdentity:'r',hostAcceptanceRef:'h',sourceAcceptanceRef:'s',candidateTreeSha:'c'.repeat(40),inputInventorySha256:hex('2'),
    image:IMAGE,nativeImageDigest:IMAGE.replace(':0.74.0@','@'),policyImage:IMAGE,dockerExecutableSha256:hex('3'),scannersSha256:hex('4'),
    database:{dbSha256:hex('5'),metadataSha256:hex('6'),fallback:false,checksDigest:'sha256:'+hex('7'),checksMajorVersion:2,checksContentSha256:hex('8')}};
  const placement={repo:'tdoljyj/cross-memory-system',profile:'required-contract-placement/1',sourceManifestSha256:hex('e'),sourceSha:'9'.repeat(40),
    workflowSha256:hex('1'),runtimeIdentity:'r',hostAcceptanceRef:'h',sourceAcceptanceRef:'s',testTreeSha:'c'.repeat(40),baseTreeSha:'b'.repeat(40),
    image:'img@sha256:'+hex('2'),containerNodeSha256:hex('3'),nodeExecutableSha256:hex('4'),gitExecutableSha256:hex('5'),dockerExecutableSha256:hex('9'),toolPinsSha256:hex('6'),
    esbuildVersion:'0.28.1',commandTemplateSha256:hex('7'),limitsSha256:hex('8')};
  const change=v=>typeof v==='boolean'?!v:typeof v==='number'?v+1:/^[a-f0-9]{40}$/.test(v)?'0'.repeat(40):/^[a-f0-9]{64}$/.test(v)?hex('0'):/@sha256:/.test(v)?v.replace(/[a-f0-9]{64}$/,hex('0')):/^sha256:/.test(v)?'sha256:'+hex('0'):v+'x';
  for(const [role,base] of [['trivy',trivy],['contract-placement',placement]]){
    const key=cacheKey(role,base);assert.ok(key,role);
    for(const name of Object.keys(base)){
      const {[name]:_drop,...missing}=base;assert.equal(cacheKey(role,missing),null,`${role}: missing ${name}`);
      if(name==='repo'||name==='profile'){assert.equal(cacheKey(role,{...base,[name]:base[name]+'x'}),null,`${role}: ${name} is fixed`);continue;}
      if(name==='database'){for(const field of Object.keys(base.database)){const k=cacheKey(role,{...base,database:{...base.database,[field]:change(base.database[field])}});
        assert.ok(k&&k.keySha256!==key.keySha256,`database.${field}`);}continue;}
      const other=cacheKey(role,{...base,[name]:change(base[name])});assert.ok(other,`${role}: changed ${name} stays valid`);assert.notEqual(other.keySha256,key.keySha256,`${role}: ${name}`);
    }
    assert.equal(cacheKey(role,{...base,extra:1}),null,'no unknown component');
  }
  assert.equal(cacheKey('gitleaks',trivy),null,'gitleaks has no cache key');
});
test('scanner and command digests: what the container sees, not per-run paths or commit ids',()=>{
  const scan=(source,arg)=>({scanner:'vuln',args:['fs',arg],mounts:[[source,'/repo'],['/cache/db','/scratch/db']],actualScanObserved:false});
  assert.equal(trivyScannersSha256([scan('/runs/a/repo','x'),scan('/runs/a/repo','x'),scan('/runs/a/repo','x')]),trivyScannersSha256([scan('/runs/b/repo','x'),scan('/runs/b/repo','x'),scan('/runs/b/repo','x')]));
  assert.notEqual(trivyScannersSha256([scan('/r','x'),scan('/r','x'),scan('/r','x')]),trivyScannersSha256([scan('/r','x'),scan('/r','y'),scan('/r','x')]));
  assert.equal(trivyScannersSha256([scan('/r','x')]),null);
  const tools={node:{path:'/usr/local/bin/node',sha256:hex('1')},python:{path:'/usr/bin/python3',sha256:hex('2')},git:{path:'/usr/bin/git',sha256:hex('3')},
    esbuildJs:{path:'/opt/esbuild/main.js',sha256:hex('4')},esbuildBinary:{path:'/opt/esbuild/bin',sha256:hex('5')}};
  const jobOf=(headSha,testSha,baseSha=BASE)=>makeJobV2({repo:'tdoljyj/cross-memory-system',pr:7,headSha,baseSha,testSha,role:'contract-placement',sourceManifestSha256:hex('e'),attempt:1,createdAt:new Date(START).toISOString()});
  const a=jobOf(H1,H1),b=jobOf(H2,H3);
  assert.equal(placementCommandTemplateSha256(fixedCommands(a,tools),a),placementCommandTemplateSha256(fixedCommands(b,tools),b));
  assert.notEqual(placementCommandTemplateSha256(fixedCommands(a,tools),a),placementCommandTemplateSha256(fixedCommands(a,{...tools,python:{path:'/usr/bin/python3.12',sha256:hex('2')}}),a));
});
test('record parsing: own key, contract, digest, TTL and signature only',async t=>{
  t.mock.timers.enable({apis:['Date'],now:START});const root=await tempDir(t);const {r,signed}=await storeTrivy(t,port(root));
  const bytes=await fs.readFile(path.join(root,'trivy',r.resultKey.keySha256+'.json')),now=Date.now();
  assert.equal(parseCacheRecord(bytes,'trivy',r.resultKey,{now,signer:SIGNER}).observation.conclusion,'success');
  assert.throws(()=>parseCacheRecord(bytes,'contract-placement',r.resultKey,{now,signer:SIGNER}),{code:'SCAN_RESULT_CACHE_KEY_INCOMPLETE'});
  assert.throws(()=>parseCacheRecord(bytes,'trivy',r.resultKey,{signer:SIGNER}),{code:'SCAN_RESULT_CACHE_CLOCK_UNKNOWN'});
  assert.throws(()=>parseCacheRecord(bytes,'trivy',r.resultKey,{now,signer:{...SIGNER,keyId:'other'}}),{code:'SCAN_RESULT_CACHE_ENVELOPE_REFUSED'});
  assert.throws(()=>cacheRecord('trivy',r.resultKey,{...r.observation,sourceManifestSha256:hex('0')},signed.envelope),{code:'SCAN_RESULT_CACHE_OBSERVATION_REFUSED'},'a record is only for its own Source');
  assert.throws(()=>cacheRecord('trivy',r.resultKey,{...r.observation,conclusion:'failure'},signed.envelope),{code:'SCAN_RESULT_CACHE_OBSERVATION_REFUSED'},'failures are never stored');
});

// ---- contract-placement: never served from the cache --------------------------------------------------------------------
const TOOLS={node:{path:'/usr/local/bin/node',sha256:hex('1')},python:{path:'/usr/bin/python3',sha256:hex('2')},git:{path:'/usr/bin/git',sha256:hex('3')},
  esbuildJs:{path:'/opt/esbuild/main.js',sha256:hex('4')},esbuildBinary:{path:'/opt/esbuild/bin',sha256:hex('5')}};
const PCONFIG={image:'registry.example/placement@sha256:'+hex('a'),runtimeIdentity:'isolated-regression',hostAcceptanceRef:'host-acceptance-ref',sourceAcceptanceRef:'source-acceptance-ref',
  containerNodeSha256:hex('b'),nodeExecutableSha256:hex('c'),gitExecutableSha256:hex('d'),dockerExecutableSha256:hex('e'),dockerRootDirectory:'/var/lib/docker'};
function placementRun(t,{headSha=H1,resultCache=null}={}){
  const job=makeJobV2({repo:'tdoljyj/cross-memory-system',pr:777,headSha,baseSha:BASE,testSha:headSha,sourceManifestSha256:hex('e'),role:'contract-placement',attempt:1,createdAt:new Date(Date.now()-1000).toISOString()});
  const generation=generationOf(),accepted={profile:'required-contract-placement/1',tools:TOOLS,workflowSha256:PLACEMENT_WORKFLOWS[0],esbuildVersion:'0.28.1'};
  const facts=()=>{t.mock.timers.tick(1);return placementAdmission(job,admittedFacts(job,generation,{complete:true,paths:['README.md']},{batchClaim:generation,observedAt:Date.now()}),Date.now(),{batchClaim:generation});};
  const starts=[],before=facts();
  const observe=async()=>{starts.push('placement');t.mock.timers.tick(2000);const at=new Date().toISOString();
    return {complete:true,cleanupConfirmed:true,reason:null,state:{Running:false,Status:'exited',ExitCode:0},attached:{code:0,timedOut:false,overflow:false,error:false,logs},
      isolation:{nonRoot:true,network:'none',credentialsMounted:false,controlPathsMounted:false},imageId:'sha256:'+hex('9'),startedAt:new Date(Date.now()-1500).toISOString(),finishedAt:at,cleanupObservedAt:at};};
  return {job,starts,run:()=>regressionExecutePlacement({job,config:PCONFIG,accepted,prepared:{sourceSha:'9'.repeat(40),sourceTreeSha:'8'.repeat(40),candidateTreeSha:'c'.repeat(40)},
    sealed:{packSha256:hex('7')},plan:{},before,again:async()=>facts(),expires:Date.now()+300000,signal:null,
    scanStartPort:async()=>grantFor(job,'contract-placement'),scanStartRecord:async()=>{},nativeScanStartRequired:true,resultCache,baseTreeSha:'b'.repeat(40),observe})};
}
test('placement: its candidate code reads more than the keyed trees, so it is never served: switch off, port off, every run starts the container',async t=>{
  t.mock.timers.enable({apis:['Date'],now:START});const root=await tempDir(t);
  const config={...PCONFIG,workspaceRoot:'/w',runsRoot:'/r',trustedSourceDirectory:'/s',scanResultCache:{enabled:true,root:'/var/lib/clued-independent-ci/scan-result-cache'}};
  const settings=cacheSettings(config,'contract-placement');assert.deepEqual([settings.enabled,settings.reason],[false,'SCAN_RESULT_CACHE_KEY_NOT_CLOSED_FOR_ROLE']);
  const forced=createResultCache({enabled:true,root,role:'contract-placement'},{guard:noGuard,signer:SIGNER});assert.equal(forced.enabled,false,'the port refuses placement too');
  for(const resultCache of [createResultCache(settings),forced]){
    for(const headSha of [H1,H2]){const run=placementRun(t,{headSha,resultCache}),r=await run.run();
      assert.deepEqual(run.starts,['placement']);assert.equal(r.observation.cacheHit,undefined);assert.equal(r.resultKey,null);}}
  const key=placementResultKey({job:placementRun(t).job,config:PCONFIG,accepted:{tools:TOOLS,workflowSha256:PLACEMENT_WORKFLOWS[0],esbuildVersion:'0.28.1'},
    prepared:{sourceSha:'9'.repeat(40),candidateTreeSha:'c'.repeat(40)},baseTreeSha:'b'.repeat(40)});
  assert.equal(key.components.limitsSha256,digest(PLACEMENT_LIMITS));assert.equal(key.components.dockerExecutableSha256,PCONFIG.dockerExecutableSha256);
});
test('placement and gitleaks observations carrying cacheHit are refused by the signer and the issuer check',async t=>{
  t.mock.timers.enable({apis:['Date'],now:START});const resultCache=port(await tempDir(t));await storeTrivy(t,resultCache);
  const trivy=trivyRun(t,{headSha:H2,resultCache}),hit=(await trivy.run()).observation.cacheHit;
  const run=placementRun(t),o=(await run.run()).observation,issue={job:run.job,expiresAt:new Date(Date.now()+3600000).toISOString()};
  assert.ok(observationFacts(issue,o),'a real placement observation is checked exactly as before');
  assert.throws(()=>observationFacts(issue,{...o,cacheHit:hit}),{code:'SCAN_RESULT_CACHE_HIT_ROLE_REFUSED'});
  assert.throws(()=>observationFacts(issue,{...o,surprise:1}),{code:'ACTUAL_PLACEMENT_EVIDENCE_REQUIRED'});
});

// ---- bridge: the store runs only after the signed result is written ------------------------------------------------------
const workerUrl=new URL('../worker/protected-job-bridge-v4/linux-worker.mjs',import.meta.url),W='globalThis.__scanCacheWorkerHarness';
const stub=lines=>'data:text/javascript;base64,'+Buffer.from(lines.join('\n')).toString('base64');
let workerSource=await fs.readFile(workerUrl,'utf8');
for(const [relative,lines] of Object.entries({'./boundary.mjs':[`export async function loadLinuxContext(){return ${W}.context;}`,`export function takeAcceptedBridgeContext(c){return c;}`],
  './mailbox.mjs':[`export async function openAcceptedMailbox(){return ${W}.box;}`,`export function takeActualMailbox(b){return b;}`],
  './signed-result.mjs':[`export async function signActualBridgeResult(context,issue,observation){${W}.events.push('sign');return {signed:observation};}`],
  '../formal-gitleaks-v4/adapter.mjs':[`export function createFormalGitleaksAdapter(ports){return ${W}.adapter(ports);}`],
  '../formal-trivy-v4/adapter.mjs':[`export function createFormalTrivyAdapter(ports){return ${W}.adapter(ports);}`],
  '../formal-contract-placement-v2/adapter.mjs':[`export function createFormalContractPlacementAdapter(ports){return ${W}.adapter(ports);}`],
  '../formal-fixed-role-policy-v3/policy.mjs':[`export async function openFixedRoleSession(){return {async finish(){${W}.events.push('finish');},async releaseClean(){}};}`,`export function takeActualRoleSession(s){return s;}`],
  './issue-job.mjs':[`export async function readFixedIssueJob(){return ${W}.job;}`]})){
  const quoted=`'${relative}'`;assert.equal(workerSource.split(quoted).length,2);workerSource=workerSource.replace(quoted,JSON.stringify(stub(lines)));}
workerSource=workerSource.replace(/from (['"])(\.[^'"]+)\1/g,(_all,_q,relative)=>`from ${JSON.stringify(new URL(relative,workerUrl).href)}`);
const {executeProtectedIssuedJob}=await import('data:text/javascript;base64,'+Buffer.from(workerSource).toString('base64'));
test('bridge: storeSignedResult is called once, after the signed result is written, with that result; a failing store changes nothing',async()=>{
  for(const failing of [false,true]){
    const job=makeJobV2({repo:'tdoljyj/cross-memory-system',pr:888,headSha:H1,baseSha:BASE,testSha:H1,sourceManifestSha256:hex('e'),role:'trivy',attempt:1,createdAt:new Date(Date.now()-60_000).toISOString()});
    const generation=generationOf(),issue=issueFor(job,generation),events=[],files=new Map([['issue',Buffer.from(encode(issue))]]),stored=[];
    const box={async lock(){},async read(name){return files.get(name);},async write(name,bytes){files.set(name,Buffer.from(bytes));events.push('write:'+name.replace(/-\d+$/,''));},
      async wait(name){const challenge=decode(files.get('challenge-'+name.slice('response-'.length)));
        return Buffer.from(encode(makeResponse(issue,challenge,admittedFacts(job,generation,{complete:true,paths:['README.md']},{batchClaim:generation}),null)));}};
    globalThis.__scanCacheWorkerHarness={context:{role:'trivy',config:{sourceManifestSha256:job.sourceManifestSha256},sourceAcceptanceRef:CONTEXT.sourceAcceptanceRef,hostQualificationRef:CONTEXT.hostAcceptanceRef},
      box,job,events,adapter:ports=>({async execute(subject){const before=await ports.admissionPort(subject),after=await ports.admissionPort(subject);
        return {status:'OBSERVED',observation:{preAdmissionSha256:before.observationSha256,postAdmissionSha256:after.observationSha256},
          storeSignedResult:async signed=>{events.push('store');stored.push(signed);if(failing)throw Error('disk full');}};}})};
    const r=await executeProtectedIssuedJob();
    assert.equal(r.status,'ACTUAL_SIGNED_ROLE_RESULT_EMITTED',String(failing));
    assert.deepEqual(events.filter(e=>!e.startsWith('write:challenge')),['finish','sign','write:result','store']);
    assert.equal(stored.length,1);assert.deepEqual(JSON.parse(files.get('result')),JSON.parse(canonical(stored[0])));
  }
});
