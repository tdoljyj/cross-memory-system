// M4 scan result cache by tested tree (DESIGN 65). The real trivy scanner loop and the real placement execution step,
// isolated only at their physical Docker transport (the same in-memory substitution as
// formal-trivy-scan-start-window.test.mjs); the cache port is the real one over a temporary directory, with the
// protected-path guard replaced (the offline tests do not run as root on Linux).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {makeJobV2} from '../src/job-v2.mjs';
import {digest} from '../src/proof.mjs';
import {noteScanStartResponseWindow} from '../src/scan-start-v1/grant.mjs';
import {admittedFacts,BASE} from './resident-v2-fixtures.mjs';
import {IMAGE,WORKFLOW_SHA256S,CHECKS_REPOSITORY} from '../worker/required-trivy-v3/plans.mjs';
import {cacheKey,cacheSettings,createResultCache,parseCacheRecord,cacheRecord,validateCacheHitEvidence,CACHE_HIT_CONTRACT,
  trivyScannersSha256,placementCommandTemplateSha256} from '../worker/scan-result-cache-v1/cache.mjs';
import {trivyResultKey} from '../worker/formal-trivy-v4/adapter.mjs';
import {placementResultKey,validateAdmission as placementAdmission,WORKFLOW_SHA256S as PLACEMENT_WORKFLOWS} from '../worker/formal-contract-placement-v2/adapter.mjs';
import {fixedCommands,LIMITS as PLACEMENT_LIMITS} from '../worker/formal-contract-placement-v2/container-entry.mjs';
import {observationFacts} from '../worker/protected-job-bridge-v4/signed-result.mjs';

const START=Date.parse('2026-11-07T00:00:00.000Z'),hex=c=>c.repeat(64),H1='a'.repeat(40),H2='d'.repeat(40),H3='e'.repeat(40);
const noGuard=async()=>{};
// In-memory copy of an adapter with its one physical import replaced and its private step exported (this module only).
async function isolated(url,physicalImport,stubLines,exportLine){
  const stub='data:text/javascript;base64,'+Buffer.from(stubLines.join('\n')).toString('base64');
  let source=await fs.readFile(url,'utf8');assert.equal(source.split(physicalImport).length,2,'one exact physical transport substitution');
  source=source.replace(physicalImport,physicalImport.replace(/from\s*(['"])[^'"]+\1/,`from ${JSON.stringify(stub)}`))
    .replace(/from\s*(['"])(\.[^'"]+)\1/g,(_all,_q,relative)=>`from ${JSON.stringify(new URL(relative,url).href)}`)+'\n'+exportLine+'\n';
  return import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
}
const trivyUrl=new URL('../worker/formal-trivy-v4/adapter.mjs',import.meta.url),dockerUrl=new URL('../worker/formal-trivy-v3/docker.mjs',import.meta.url);
const {regressionExecuteScanners}=await isolated(trivyUrl,"import { actualDockerClient, NATIVE_IMAGE, runFixedScanner } from '../formal-trivy-v3/docker.mjs';",
  [`export {NATIVE_IMAGE} from ${JSON.stringify(dockerUrl.href)};`,`export function actualDockerClient(){throw Error('ACTUAL_DOCKER_NOT_ALLOWED_IN_REGRESSION');}`,
    `export async function runFixedScanner(input){return input.docker.scanner(input);}`],'export {executeScanners as regressionExecuteScanners};');
const placementUrl=new URL('../worker/formal-contract-placement-v2/adapter.mjs',import.meta.url);
const {regressionExecutePlacement}=await isolated(placementUrl,"import {observeUnsignedContainer} from '../verify-once/verify-worker.mjs';",
  [`export async function observeUnsignedContainer(){throw Error('ACTUAL_DOCKER_NOT_ALLOWED_IN_REGRESSION');}`],'export {executePlacement as regressionExecutePlacement};');

async function cacheDir(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'clued-scan-cache-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
const port=(root,role,enabled=true)=>createResultCache(enabled?{enabled:true,root,role}:{enabled:false,reason:'SCAN_RESULT_CACHE_DISABLED'},{guard:noGuard});
const logs={stdout:{bytes:10,sha256:hex('5'),truncated:false},stderr:{bytes:0,sha256:hex('6'),truncated:false}};
const generationOf=()=>({claimId:randomUUID(),fence:3,epoch:1,expiresAt:new Date(Date.now()+3600000).toISOString()});
function grantFor(job,role){return async()=>{const issued=Date.now();return noteScanStartResponseWindow({status:'committed',contract:'clued.ci-scan-start-grant/1',launch_allowed:true,
  execution_id:randomUUID(),receipt_id:randomUUID(),repository_id:1334673495,head_sha:job.headSha,role,provider:'independent-controller',
  start_requested_at:new Date(issued).toISOString()},{issuedAt:new Date(issued).toISOString(),expiresAt:new Date(issued+120000).toISOString()});};}

// ---- trivy -------------------------------------------------------------------------------------------------------------
const CONTEXT={runtimeIdentity:'isolated-regression',hostAcceptanceRef:'host-acceptance-ref',sourceAcceptanceRef:'source-acceptance-ref'};
const KEY_CONTEXT={policyImage:IMAGE,dockerExecutableSha256:hex('7')};
function trivyRun(t,{headSha=H1,testSha=headSha,files=[{path:'README.md',sha256:hex('1')}],tree='c'.repeat(40),db=hex('a'),sourceManifestSha256=hex('e'),
  context=CONTEXT,keyContext=KEY_CONTEXT,resultCache=null,exitCode=0}={}){
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
    return admittedFacts(job,generation,{complete:true,paths:inputInventory.paths},{batchClaim:generation,observedAt:Date.now()});};
  const scanStartPort=async()=>{grants++;return grantFor(job,'trivy')();};
  const docker={async scanner({scan}){starts.push(scan.scanner);t.mock.timers.tick(1000);const at=new Date().toISOString();
    return {scanner:scan.scanner,requestSha256:hex('2'),nonce:hex('3'),executionId:randomUUID(),exitCode,complete:true,touched:true,reason:null,logs,
      containerId:'c-'+scan.scanner,imageId:'sha256:'+hex('4'),startedAt:at,finishedAt:at,cleanupConfirmed:true,cleanupObservedAt:at};}};
  return {job,starts,get admissions(){return admissions;},get grants(){return grants;},
    run:async()=>{const r=await regressionExecuteScanners({job,preparedRequest,snapshotDirectory:'/snapshot/repo',inputInventory,
      cache:{database,checksBundle,dbDecision:{status:'READY',fallback:false,db:database},provenanceSha256:hex('9')},checksPin,
      workflowSha256:WORKFLOW_SHA256S[0],docker,dockerRootDirectory:'/var/lib/docker',deadline:Date.now()+25*60000,
      admissionPort,scanStartPort,scanStartRecord:async()=>{},fixture:false,nativeScanStartRequired:true,context,generation,resultCache,keyContext});
      // As createFormalTrivyAdapter does after the snapshot is removed: the final observation is the one stored and signed.
      t.mock.timers.tick(10);
      const observation=r.observation&&Object.freeze({...r.observation,cleanup:{...r.observation.cleanup,snapshotRemoved:true,observedAt:new Date().toISOString()}});
      return {...r,observation};}};
}
const issueOf=job=>({job,expiresAt:new Date(Date.now()+3600000).toISOString()});
async function storeTrivy(t,resultCache,options={}){
  const first=trivyRun(t,{resultCache,...options}),r=await first.run();
  assert.equal(r.resultCache.lookup,'SCAN_RESULT_CACHE_MISS');assert.deepEqual(first.starts,['vuln','secret','misconfig']);
  const stored=await resultCache.store(r.resultKey,r.observation);assert.equal(stored.stored,true,stored.reason);
  return {first,r,stored};
}

test('trivy: the same tree scanned again under another commit is a hit; no scanner starts, admissions and the grant still happen',async t=>{
  t.mock.timers.enable({apis:['Date'],now:START});const resultCache=port(await cacheDir(t),'trivy');
  const {r:original,stored}=await storeTrivy(t,resultCache);
  const again=trivyRun(t,{headSha:H2,resultCache}),r=await again.run();
  assert.deepEqual(again.starts,[],'no scanner container is started');
  assert.equal(again.grants,1,'the scan-start grant is still taken and recorded (the head is burnt as for a real run)');
  assert.equal(again.admissions,2,'a role pre admission and a new post admission');
  assert.equal(r.status,'THREE_SCANNERS_OBSERVED_UNSIGNED');assert.equal(r.resultCache.lookup,'SCAN_RESULT_CACHE_HIT');
  const o=r.observation;assert.equal(o.conclusion,'success');assert.deepEqual(o.subject.headSha,H2,'the observation is for this job');
  assert.deepEqual(o.scans,original.observation.scans,'the original three real scanner records');
  assert.equal(o.cacheHit.contract,CACHE_HIT_CONTRACT);assert.equal(o.cacheHit.originalObservationSha256,digest(original.observation));
  assert.equal(o.cacheHit.recordSha256,stored.recordSha256);assert.equal(o.cacheHit.originalSubject.headSha,H1);
  assert.notEqual(o.postAdmissionSha256,original.observation.postAdmissionSha256,'fresh admissions');
  const facts=observationFacts(issueOf(again.job),o);assert.equal(facts.startedAt,o.cacheHit.servedAt,"the signed window is this run's");
  assert.equal((await resultCache.store(r.resultKey??null,o)).stored,false,'a hit is never stored');
});
test('trivy: a message-only force-push (new head, same tree) and a recomputed S (new testSha, same tree) both hit',async t=>{
  t.mock.timers.enable({apis:['Date'],now:START});const resultCache=port(await cacheDir(t),'trivy');await storeTrivy(t,resultCache);
  for(const run of [trivyRun(t,{headSha:H2,resultCache}),trivyRun(t,{headSha:H1,testSha:H3,resultCache})]){
    const r=await run.run();assert.deepEqual(run.starts,[]);assert.equal(r.resultCache.lookup,'SCAN_RESULT_CACHE_HIT');}
});
test('trivy: any change of a key component is a miss and the scanners run',async t=>{
  t.mock.timers.enable({apis:['Date'],now:START});const resultCache=port(await cacheDir(t),'trivy');await storeTrivy(t,resultCache);
  const variants={'file bytes':{files:[{path:'README.md',sha256:hex('2')}]},'file set':{files:[{path:'README.md',sha256:hex('1')},{path:'b.txt',sha256:hex('1')}]},
    'candidate tree':{tree:'f'.repeat(40)},'offline database':{db:hex('0')},'Source manifest':{sourceManifestSha256:hex('3')},
    'runtime identity':{context:{...CONTEXT,runtimeIdentity:'other-runtime'}},'host acceptance':{context:{...CONTEXT,hostAcceptanceRef:'other-host-ref'}},
    'source acceptance':{context:{...CONTEXT,sourceAcceptanceRef:'other-source-ref'}},'docker client':{keyContext:{...KEY_CONTEXT,dockerExecutableSha256:hex('8')}}};
  for(const [name,options] of Object.entries(variants)){
    const run=trivyRun(t,{headSha:H2,resultCache,...options}),r=await run.run();
    assert.deepEqual(run.starts,['vuln','secret','misconfig'],name);assert.equal(r.resultCache.lookup,'SCAN_RESULT_CACHE_MISS',name);}
});
test('trivy: a key with a missing component is no key: nothing is looked up, the scanners run',async t=>{
  t.mock.timers.enable({apis:['Date'],now:START});const resultCache=port(await cacheDir(t),'trivy');await storeTrivy(t,resultCache);
  for(const options of [{keyContext:{policyImage:IMAGE}},{keyContext:null},{context:{...CONTEXT,hostAcceptanceRef:''}}]){
    const run=trivyRun(t,{headSha:H2,resultCache,...options}),r=await run.run();
    assert.deepEqual(run.starts,['vuln','secret','misconfig']);assert.equal(r.resultCache.lookup,'SCAN_RESULT_CACHE_KEY_INCOMPLETE');assert.equal(r.resultKey,null);}
});
test('trivy: a tampered, truncated, foreign or unsuccessful record is a miss and the scanners run',async t=>{
  t.mock.timers.enable({apis:['Date'],now:START});const root=await cacheDir(t),resultCache=port(root,'trivy');
  const {r}=await storeTrivy(t,resultCache),file=path.join(root,'trivy',r.resultKey.keySha256+'.json'),good=await fs.readFile(file);
  const record=JSON.parse(good),resign=value=>{const {recordSha256,...body}=value;return JSON.stringify({...body,recordSha256:digest(body)});};
  const failed=structuredClone(record);failed.observation.conclusion='failure';failed.observation.scans[0].exitCode=1;failed.originalObservationSha256=digest(failed.observation);
  const chained=structuredClone(record);chained.observation.cacheHit={contract:CACHE_HIT_CONTRACT};chained.originalObservationSha256=digest(chained.observation);
  const otherKey=structuredClone(record);otherKey.key.candidateTreeSha='f'.repeat(40);
  const tampered={'one byte changed':Buffer.from(good.toString().replace('"success"','"succe5s"')),'truncated':good.subarray(0,good.length-7),'empty':Buffer.alloc(0),
    'not json':Buffer.from('{'),'conclusion rewritten, digest stale':Buffer.from(JSON.stringify({...record,observation:{...record.observation,scans:[]}})),
    'a failed run, re-digested':Buffer.from(resign(failed)),'a hit stored as a record, re-digested':Buffer.from(resign(chained)),
    'another key, re-digested':Buffer.from(resign(otherKey)),'observation digest stale':Buffer.from(resign({...record,originalObservationSha256:hex('0')}))};
  for(const [name,bytes] of Object.entries(tampered)){
    await fs.writeFile(file,bytes);const run=trivyRun(t,{headSha:H2,resultCache}),out=await run.run();
    assert.deepEqual(run.starts,['vuln','secret','misconfig'],name);assert.equal(out.observation.cacheHit,undefined,name);assert.notEqual(out.resultCache.lookup,'SCAN_RESULT_CACHE_HIT',name);}
  await fs.writeFile(file,good);const run=trivyRun(t,{headSha:H2,resultCache});await run.run();assert.deepEqual(run.starts,[],'the untouched record hits again');
});
test('trivy: with the policy switch off nothing is read or written, even with a valid record present',async t=>{
  t.mock.timers.enable({apis:['Date'],now:START});const root=await cacheDir(t);await storeTrivy(t,port(root,'trivy'));
  const config={workspaceRoot:'/w',runsRoot:'/r',trustedSourceDirectory:'/s',signingKeyFile:'/k/key',qualificationFile:'/k/q',publicKeyFile:'/k/pub',sourceManifestFile:'/s/m',entryFile:'/s/e'};
  for(const value of [undefined,{enabled:false,root},{enabled:'true',root},{enabled:true},{enabled:true,root:'/r/cache'},{enabled:true,root:'/k'},{enabled:true,root,extra:1}]){
    const settings=cacheSettings({...config,scanResultCache:value},'trivy');assert.equal(settings.enabled,false,JSON.stringify(value));
    const resultCache=createResultCache(settings,{guard:noGuard}),run=trivyRun(t,{headSha:H2,resultCache}),r=await run.run();
    assert.deepEqual(run.starts,['vuln','secret','misconfig']);assert.equal(r.resultKey,null);
    assert.equal((await resultCache.store(r.resultKey,r.observation)).stored,false);}
  assert.equal(cacheSettings({...config,scanResultCache:{enabled:true,root:'/var/lib/clued-independent-ci/scan-result-cache'}},'trivy').enabled,true);
  assert.equal(cacheSettings({...config,scanResultCache:{enabled:true,root:'/var/lib/c'}},'gitleaks').enabled,false,'gitleaks is never cached');
});

// ---- key completeness (pure) ------------------------------------------------------------------------------------------
test('cacheKey: every component is required and every change gives another key',()=>{
  const trivy={repo:'tdoljyj/cross-memory-system',profile:'required-trivy-three-scanners/1',sourceManifestSha256:hex('e'),sourceSha:'9'.repeat(40),
    workflowSha256:hex('1'),runtimeIdentity:'r',hostAcceptanceRef:'h',sourceAcceptanceRef:'s',candidateTreeSha:'c'.repeat(40),inputInventorySha256:hex('2'),
    image:IMAGE,nativeImageDigest:IMAGE.replace(':0.74.0@','@'),policyImage:IMAGE,dockerExecutableSha256:hex('3'),scannersSha256:hex('4'),
    database:{dbSha256:hex('5'),metadataSha256:hex('6'),fallback:false,checksDigest:'sha256:'+hex('7'),checksMajorVersion:2,checksContentSha256:hex('8')}};
  const placement={repo:'tdoljyj/cross-memory-system',profile:'required-contract-placement/1',sourceManifestSha256:hex('e'),sourceSha:'9'.repeat(40),
    workflowSha256:hex('1'),runtimeIdentity:'r',hostAcceptanceRef:'h',sourceAcceptanceRef:'s',testTreeSha:'c'.repeat(40),baseTreeSha:'b'.repeat(40),
    image:'img@sha256:'+hex('2'),containerNodeSha256:hex('3'),nodeExecutableSha256:hex('4'),gitExecutableSha256:hex('5'),toolPinsSha256:hex('6'),
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
test('record parsing refuses anything but its own key, contract and digest',()=>{
  const key=cacheKey('trivy',{repo:'tdoljyj/cross-memory-system',profile:'required-trivy-three-scanners/1',sourceManifestSha256:hex('e'),sourceSha:'9'.repeat(40),
    workflowSha256:hex('1'),runtimeIdentity:'r',hostAcceptanceRef:'h',sourceAcceptanceRef:'s',candidateTreeSha:'c'.repeat(40),inputInventorySha256:hex('2'),
    image:IMAGE,nativeImageDigest:IMAGE,policyImage:IMAGE,dockerExecutableSha256:hex('3'),scannersSha256:hex('4'),
    database:{dbSha256:hex('5'),metadataSha256:hex('6'),fallback:false,checksDigest:'sha256:'+hex('7'),checksMajorVersion:2,checksContentSha256:hex('8')}});
  const scan={complete:true,cleanupConfirmed:true,exitCode:0,preAdmissionSha256:hex('1'),postAdmissionSha256:hex('2'),logs};
  const o={contract:'clued.independent-ci.formal-scanner-observation/3',profile:'required-trivy-three-scanners/1',domain:'production-observation',fixture:false,
    formalEligible:false,checksWritten:false,qualificationIssued:false,conclusion:'success',sourceManifestSha256:hex('e'),sourceSha:'9'.repeat(40),runtimeIdentity:'r',
    hostAcceptanceRef:'h',sourceAcceptanceRef:'s',preAdmissionSha256:hex('1'),postAdmissionSha256:hex('2'),subject:{headSha:H1},candidateTreeSha:'c'.repeat(40),
    inputInventorySha256:hex('2'),image:IMAGE,nativeImageDigest:IMAGE,cache:key.components.database,scans:[scan,scan,scan]};
  const bytes=Buffer.from(JSON.stringify(cacheRecord('trivy',key,o,new Date(START).toISOString())));
  assert.equal(parseCacheRecord(bytes,'trivy',key).observation.conclusion,'success');
  assert.throws(()=>parseCacheRecord(bytes,'contract-placement',key),{code:'SCAN_RESULT_CACHE_KEY_INCOMPLETE'});
  assert.throws(()=>cacheRecord('trivy',key,{...o,sourceManifestSha256:hex('0')}),{code:'SCAN_RESULT_CACHE_OBSERVATION_REFUSED'},'a record is only for its own Source');
  assert.throws(()=>cacheRecord('trivy',key,{...o,image:'x@sha256:'+hex('0')}),{code:'SCAN_RESULT_CACHE_OBSERVATION_REFUSED'});
  assert.throws(()=>cacheRecord('trivy',key,{...o,conclusion:'failure'}),{code:'SCAN_RESULT_CACHE_OBSERVATION_REFUSED'},'failures are never stored');
  assert.throws(()=>validateCacheHitEvidence({contract:CACHE_HIT_CONTRACT}),{code:'SCAN_RESULT_CACHE_HIT_EVIDENCE_REQUIRED'});
});

// ---- contract-placement ------------------------------------------------------------------------------------------------
const TOOLS={node:{path:'/usr/local/bin/node',sha256:hex('1')},python:{path:'/usr/bin/python3',sha256:hex('2')},git:{path:'/usr/bin/git',sha256:hex('3')},
  esbuildJs:{path:'/opt/esbuild/main.js',sha256:hex('4')},esbuildBinary:{path:'/opt/esbuild/bin',sha256:hex('5')}};
const PCONFIG={image:'registry.example/placement@sha256:'+hex('a'),runtimeIdentity:'isolated-regression',hostAcceptanceRef:'host-acceptance-ref',sourceAcceptanceRef:'source-acceptance-ref',
  containerNodeSha256:hex('b'),nodeExecutableSha256:hex('c'),gitExecutableSha256:hex('d'),dockerRootDirectory:'/var/lib/docker'};
function placementRun(t,{headSha=H1,testSha=headSha,testTree='c'.repeat(40),baseTreeSha='b'.repeat(40),config=PCONFIG,tools=TOOLS,resultCache=null,exitCode=0}={}){
  const job=makeJobV2({repo:'tdoljyj/cross-memory-system',pr:777,headSha,baseSha:BASE,testSha,sourceManifestSha256:hex('e'),role:'contract-placement',attempt:1,createdAt:new Date(Date.now()-1000).toISOString()});
  const generation=generationOf(),accepted={profile:'required-contract-placement/1',tools,workflowSha256:PLACEMENT_WORKFLOWS[0],esbuildVersion:'0.28.1'};
  const facts=()=>{t.mock.timers.tick(1);return placementAdmission(job,admittedFacts(job,generation,{complete:true,paths:['README.md']},{batchClaim:generation,observedAt:Date.now()}),Date.now(),{batchClaim:generation});};
  let admissions=0,grants=0;const starts=[];
  const before=facts();
  const observe=async()=>{starts.push('placement');t.mock.timers.tick(2000);const at=new Date().toISOString();
    return {complete:true,cleanupConfirmed:true,reason:null,state:{Running:false,Status:'exited',ExitCode:exitCode},attached:{code:exitCode,timedOut:false,overflow:false,error:false,logs},
      isolation:{nonRoot:true,network:'none',credentialsMounted:false,controlPathsMounted:false},imageId:'sha256:'+hex('9'),startedAt:new Date(Date.now()-1500).toISOString(),finishedAt:at,cleanupObservedAt:at};};
  return {job,starts,get admissions(){return admissions;},get grants(){return grants;},
    run:()=>regressionExecutePlacement({job,config,accepted,prepared:{sourceSha:'9'.repeat(40),sourceTreeSha:'8'.repeat(40),candidateTreeSha:testTree},
      sealed:{packSha256:hex('7')},plan:{},before,again:async()=>{admissions++;return facts();},expires:Date.now()+300000,signal:null,
      scanStartPort:async()=>{grants++;return grantFor(job,'contract-placement')();},scanStartRecord:async()=>{},nativeScanStartRequired:true,
      resultCache,baseTreeSha,observe})};
}
async function storePlacement(t,resultCache,options={}){
  const first=placementRun(t,{resultCache,...options}),r=await first.run();
  assert.equal(r.resultCache.lookup,'SCAN_RESULT_CACHE_MISS');assert.deepEqual(first.starts,['placement']);
  const stored=await resultCache.store(r.resultKey,r.observation);assert.equal(stored.stored,true,stored.reason);return {r,stored};
}
test('placement: the same tested and base trees under other commits hit; no container starts, the grant and admissions still happen',async t=>{
  t.mock.timers.enable({apis:['Date'],now:START});const resultCache=port(await cacheDir(t),'contract-placement');
  const {r:original,stored}=await storePlacement(t,resultCache);
  for(const [headSha,testSha] of [[H2,H2],[H1,H3]]){
    const again=placementRun(t,{headSha,testSha,resultCache}),r=await again.run(),o=r.observation;
    assert.deepEqual(again.starts,[]);assert.equal(again.grants,1);assert.equal(again.admissions,2);
    assert.equal(r.resultCache.lookup,'SCAN_RESULT_CACHE_HIT');assert.equal(o.subject.headSha,headSha);
    assert.equal(o.exitCode,0);assert.equal(o.conclusion,'success');assert.deepEqual(o.logs,original.observation.logs);assert.equal(o.imageId,original.observation.imageId);
    assert.equal(o.cacheHit.originalObservationSha256,digest(original.observation));assert.equal(o.cacheHit.recordSha256,stored.recordSha256);
    assert.equal(o.commandSequenceSha256,digest(fixedCommands(again.job,TOOLS)),"this job's own command sequence");
    const facts=observationFacts(issueOf(again.job),o);assert.equal(facts.startedAt,o.startedAt);assert.equal(facts.exitCode,0);
  }
});
test('placement: another base tree, tested tree, tool, image, runtime or acceptance reference is a miss; the container runs',async t=>{
  t.mock.timers.enable({apis:['Date'],now:START});const resultCache=port(await cacheDir(t),'contract-placement');await storePlacement(t,resultCache);
  const variants={'base tree':{baseTreeSha:'f'.repeat(40)},'tested tree':{testTree:'f'.repeat(40)},'tool pin':{tools:{...TOOLS,python:{path:'/usr/bin/python3',sha256:hex('0')}}},
    'image':{config:{...PCONFIG,image:'registry.example/placement@sha256:'+hex('0')}},'in-image node':{config:{...PCONFIG,containerNodeSha256:hex('0')}},
    'host git':{config:{...PCONFIG,gitExecutableSha256:hex('0')}},'runtime':{config:{...PCONFIG,runtimeIdentity:'other'}},'host acceptance':{config:{...PCONFIG,hostAcceptanceRef:'other-ref'}}};
  for(const [name,options] of Object.entries(variants)){const run=placementRun(t,{headSha:H2,resultCache,...options}),r=await run.run();
    assert.deepEqual(run.starts,['placement'],name);assert.equal(r.resultCache.lookup,'SCAN_RESULT_CACHE_MISS',name);}
  const unknownBase=placementRun(t,{headSha:H2,resultCache,baseTreeSha:null}),r=await unknownBase.run();
  assert.deepEqual(unknownBase.starts,['placement']);assert.equal(r.resultCache.lookup,'SCAN_RESULT_CACHE_KEY_INCOMPLETE','an unknown base tree is no key');
});
test('placement: a tampered record is a miss, a failed run is never stored, and the switch off reads nothing',async t=>{
  t.mock.timers.enable({apis:['Date'],now:START});const root=await cacheDir(t),resultCache=port(root,'contract-placement');
  const {r}=await storePlacement(t,resultCache),file=path.join(root,'contract-placement',r.resultKey.keySha256+'.json'),good=await fs.readFile(file);
  await fs.writeFile(file,Buffer.from(good.toString().replace('"exitCode":0','"exitCode":1')));
  let run=placementRun(t,{headSha:H2,resultCache});assert.notEqual((await run.run()).resultCache.lookup,'SCAN_RESULT_CACHE_HIT');assert.deepEqual(run.starts,['placement']);
  await fs.writeFile(file,good);
  run=placementRun(t,{headSha:H2,resultCache:port(root,'contract-placement',false)});const off=await run.run();
  assert.deepEqual(run.starts,['placement']);assert.equal(off.resultCache.lookup,'SCAN_RESULT_CACHE_DISABLED');
  const failing=placementRun(t,{headSha:H2,testTree:'f'.repeat(40),resultCache,exitCode:1}),fr=await failing.run();
  assert.equal(fr.observation.conclusion,'failure');assert.equal((await resultCache.store(fr.resultKey,fr.observation)).stored,false,'a failure is not stored');
  run=placementRun(t,{headSha:H3,testTree:'f'.repeat(40),resultCache});await run.run();assert.deepEqual(run.starts,['placement'],'so the next commit runs again');
  assert.equal(placementResultKey({job:failing.job,config:PCONFIG,accepted:{tools:TOOLS,workflowSha256:PLACEMENT_WORKFLOWS[0],esbuildVersion:'0.28.1'},
    prepared:{sourceSha:'9'.repeat(40),candidateTreeSha:'c'.repeat(40)},baseTreeSha:'b'.repeat(40)}).components.limitsSha256,digest(PLACEMENT_LIMITS));
});
test('signer and issuer check: a hit observation must carry well-formed cacheHit; placement still refuses unknown fields',async t=>{
  t.mock.timers.enable({apis:['Date'],now:START});const resultCache=port(await cacheDir(t),'contract-placement');await storePlacement(t,resultCache);
  const run=placementRun(t,{headSha:H2,resultCache}),o=(await run.run()).observation,issue=issueOf(run.job);
  assert.ok(observationFacts(issue,o));
  assert.throws(()=>observationFacts(issue,{...o,cacheHit:{...o.cacheHit,recordSha256:'x'}}),{code:'SCAN_RESULT_CACHE_HIT_EVIDENCE_REQUIRED'});
  assert.throws(()=>observationFacts(issue,{...o,cacheHit:{...o.cacheHit,extra:1}}),{code:'SCAN_RESULT_CACHE_HIT_EVIDENCE_REQUIRED'});
  assert.throws(()=>observationFacts(issue,{...o,surprise:1}),{code:'ACTUAL_PLACEMENT_EVIDENCE_REQUIRED'});
  const {cacheHit:_h,...real}=o;assert.ok(observationFacts(issue,real),'an observation without cacheHit is checked exactly as before');
});
