import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { publicationControllerGithub, controllerPorts } from '../src/resident-v2/entry-runtime.mjs';
import { makeIndependentPublicationIdentity } from '../../../../scripts/ci/clued-independent-publication-identity.mjs';
import { batchJobsV2, claimGeneration, subjectOfV2 } from '../src/job-v2.mjs';
import { digest, canonical } from '../src/proof.mjs';
import { ENTRY_V2 } from '../src/resident-v2/layout.mjs';
import { PLAN_CONTRACT_V2 } from '../src/resident-v2/stage-package.mjs';
import { EffectJournal } from '../src/effect-journal.mjs';
import { createFixtureWorkAdmissionPublisherV2 } from '../src/formal-work-admission-check-v2/publisher.mjs';
import { createFixtureControlPublisherV2 } from '../src/independent-control-checks-v2/publisher.mjs';
import { createStagedCheckPublisherV2 } from '../src/staged-check-publisher-v2.mjs';
import { validateRecordV2 } from '../src/resident-v2/record.mjs';
import { fixtureRecord, tempDir, subject, admittedFacts, signResult } from './resident-v2-fixtures.mjs';
import { createWorld } from './fixtures/hosted-relay/world.mjs';
import { createHostedRelayStage } from '../src/hosted-relay-v1/stage.mjs';
import { makeJobV2 } from '../src/job-v2.mjs';

function entryFacade({ports,jobs,journal,record,nonce}) {
 const [stage,entryRole]=jobs.length===2 ? (jobs[0].role==='control-admission'?[8,'control-checks']:[9,'relay-publisher'])
  : jobs[0].role==='work-admission'?[1,'work-admission']:[3,'check-publisher'];
 const plan={contract:PLAN_CONTRACT_V2,enabled:true,stage,entryRole,batchKey:'b'.repeat(64),batchId:'b'.repeat(16)+'-'+'c'.repeat(12),
  ownerPackageAcceptanceRef:record.accepted.ownerPackageAcceptanceRef,nodeSha256:record.config.controllerNodeSha256,nodeProfileSha256:digest(record.accepted.node),
  entrySha256:record.pins.get(ENTRY_V2[entryRole]),acceptanceSha256:record.hashes.acceptanceSha256,sourceManifestSha256:jobs[0].sourceManifestSha256,
  installationSha256:record.hashes.installationSha256,runtimeConfigPinSha256:record.hashes.runtimeConfigPinSha256,jobSha256:digest(jobs)};
 // Local fixture metadata only; real entries already hold the accepted record
 // and source-bound jobs from loadStageInputs.
 const fixtureRecord={...record,config:{...record.config,sourceManifestSha256:jobs[0].sourceManifestSha256},
  accepted:{...record.accepted,revocationMaintenanceQualification:{contract:'clued.independent-ci.revocation-maintenance-qualification/1',
   qualificationRef:'receipt:'+randomUUID(),sourceManifestSha256:jobs[0].sourceManifestSha256,allowWhileHalted:false,validUntil:null}}};
 return publicationControllerGithub({ports,jobs,journal,args:{nonce,configSha256:digest(plan)},record:fixtureRecord,plan});
}

// These exercise the actual entry adapter and publisher engines, with simulated
// service ports. They are local integration checks, not runtime qualification.
async function fixture(t, active = true) {
  const time = Date.now(), iso = ms => new Date(ms).toISOString();
  const jobs = batchJobsV2(subject({ createdAt: iso(time - 60000) }));
  const claim = { claimId: randomUUID(), fence: 4, epoch: 3, expiresAt: iso(time + 3600000) };
  const checks = [], calls = [], tickets = new Map();
  let next = 101, current = true;
  const rawGithub = { fixture: true,
    async readPullRequest(n) { return { number: n, state: 'open', merged: false, mergeable: true, merge_commit_sha: 'd'.repeat(40),
      head: { sha: jobs.gitleaks.headSha, repo: { full_name: jobs.gitleaks.repo } },
      base: { sha: jobs.gitleaks.baseSha, ref: 'main', repo: { full_name: jobs.gitleaks.repo } } }; },
    async readGitCommit(sha) { return { sha, tree: 'c'.repeat(40), parents: sha === 'd'.repeat(40)
      ? [jobs.gitleaks.baseSha, jobs.gitleaks.headSha] : [jobs.gitleaks.baseSha] }; },
    async readBranchRules(branch) { return { complete: true, branch, rules: [
      { type: 'pull_request', rulesetId: 24182890, parameters: { allowed_merge_methods: ['merge'], required_approving_review_count: 0 } },
      { type: 'required_status_checks', rulesetId: 24182890, parameters: { strict_required_status_checks_policy: true,
        required_status_checks: ['kooyumi-work-admission','gitleaks','trivy','contract-placement','kooyumi-admission-verified','kooyumi-merge-slot']
          .map(context => ({ context, integration_id: 5368905 })) } },
    ] }; },
    async readChangedPaths(job) { return { complete: true, pr: job.pr, headSha: job.headSha, baseSha: job.baseSha, paths: ['scripts/ci/test.mjs'] }; },
    async readChecks(head) { return { complete: true, checks: structuredClone(checks.filter(c => c.head_sha === head)) }; },
    async createCheck(payload) { const check = { ...structuredClone(payload), id: next++, app: { id: 5368905 } }; checks.push(check); return structuredClone(check); },
    async revokeCheck(id, payload) { const check = checks.find(c => c.id === id); Object.assign(check, structuredClone(payload)); return structuredClone(check); },
  };
  const native = { async current(identity, mode) {
    return current && identity.claim.claim_id === claim.claimId && mode.executionPolicy === (active ? 'active' : 'staged') && mode.guarded === active;
  }, async command(input) {
    calls.push(input);
    if (input.action === 'publication_begin_independent') {
      if (!current) return { status: 'rejected' };
      const identity = input.independent_identity;
      if (!tickets.has(identity.effect_key)) tickets.set(identity.effect_key, { publication_id: randomUUID(), receipt_id: randomUUID() });
      return { status: 'ok', verdict: 'ADMITTED', execution_policy: 'active', execution_authorized: true, publication_required: true,
        ...tickets.get(identity.effect_key), independent_identity: identity };
    }
    assert.equal(input.action, 'publication_finish');
    return { status: 'committed', receipt_id: randomUUID(), must_revoke: !current };
  }};
  const headAuthorizationId = randomUUID();
  const admission = { fixture: true, async evaluatePr(job, packet, options = {}) {
    const facts = admittedFacts(job, claim, packet, { domain: 'fixture', batchClaim: options.batchClaim, mergeQueueHead: true,
      slotUntil: time + 3600000, observedAt: Date.now() });
    if (!active) return facts;
    delete facts.observationSha256;
    const body = { ...facts, contract: 'clued.independent-ci.full-admission/3', executionPolicy: 'active', guarded: true,
      publicationRequired: true, headAuthorizationId };
    return { ...body, observationSha256: digest(body) };
  }};
  const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
  const { docs, signer } = fixtureRecord(), record = validateRecordV2(docs, { now: time });
  const wrap = selected => entryFacade({ ports: { github: rawGithub, native }, jobs: selected, journal, nonce: 'a'.repeat(32), record });
  return { jobs, claim, checks, calls, journal, admission, wrap, record, signer, setCurrent: value => { current = value; } };
}

test('the actual entry adapter wires work admission to the original Native ticket and re-verifies without another POST', async t => {
  const f = await fixture(t), job = f.jobs['work-admission']; let batchClaim = null;
  const publisher = createFixtureWorkAdmissionPublisherV2({ github: f.wrap([job]), journal: f.journal, admission: f.admission,
    assertLive() {}, record() {}, authority: {}, batchClaims: { async read() { return batchClaim; }, async record(j, c) { batchClaim = claimGeneration(c); } } });
  const result = await publisher.publish(job);
  assert.equal(result.status, 'SETTLED', JSON.stringify(result));
  assert.equal(f.checks.length, 1); assert.match(f.checks[0].output.summary, /Native publication independent-ci:native:v1:/);
  assert.deepEqual(f.calls.map(c => c.action), ['publication_begin_independent', 'publication_begin_independent', 'publication_finish']);
  assert.equal((await publisher.publish(job)).sideEffects, 0); assert.equal(f.checks.length, 1);
});

test('one control invocation routes both roles to distinct real publication identities', async t => {
  const f = await fixture(t), pair = [f.jobs['control-admission'], f.jobs['control-merge-slot']];
  const publisher = createFixtureControlPublisherV2({ github: f.wrap(pair), journal: f.journal, admission: f.admission,
    assertLive() {}, record() {}, authority: {}, batchClaim: claimGeneration(f.claim) });
  const result = await publisher.publishPair(pair, { waitUntil: Date.now() + 10000 });
  assert.equal(result.status, 'SETTLED', JSON.stringify(result));
  assert.deepEqual(f.checks.map(c => c.name), ['kooyumi-admission-verified', 'kooyumi-merge-slot']);
  const identities = f.calls.filter(c => c.action === 'publication_begin_independent').map(c => c.independent_identity);
  assert.equal(new Set(identities.map(i => i.controller_id)).size, 2);
  assert.equal(new Set(identities.map(i => i.effect_key)).size, 2);
  assert.ok(f.checks.every(c => c.output.summary.includes('begin Receipt')));
});

test('scanner publication through the actual entry adapter retains signed evidence and the Native marker', async t => {
  const f = await fixture(t), job = f.jobs.trivy, github = f.wrap([job]);
  const refs = Object.fromEntries(['sourceAcceptanceRef','hostQualificationRef','ownerAuthorizationRef','publisherQualificationRef','ciPrincipalQualificationRef'].map(k => [k, f.record.accepted[k]]));
  const authority = { fixture: true, async observe(j) { return { ...subjectOfV2(j), ...refs, ciPrincipalBindingId: f.record.config.ciPrincipalBindingId,
    sourceAccepted: true, hostQualified: true, publisherQualified: true, ciPrincipalQualified: true, observedAt: new Date().toISOString(),
    claimExpiresAt: f.claim.expiresAt, claim: claimGeneration(f.claim) }; } };
  const publisher = createStagedCheckPublisherV2({ nativeAdmission: f.admission, authority, github, journal: f.journal,
    signers: new Map([...f.record.signers].map(([k,v]) => [k, { ...v, domain: 'fixture' }])), configuredChecks: f.record.config.checks,
    readChangedPaths: j => github.readChangedPaths(j), batchClaim: claimGeneration(f.claim), domain: 'fixture',
    protectedDeployment: { enabled: true, domain: 'fixture', repository: job.repo, ciPrincipalBindingId: f.record.config.ciPrincipalBindingId, ...refs } });
  const envelope = signResult(job, f.signer, { domain: 'fixture', startedAt: Date.now() - 5000, finishedAt: Date.now() - 1000 });
  const result = await publisher.publish({ job, envelope });
  assert.equal(result.status, 'SETTLED', JSON.stringify(result));
  assert.equal(f.checks.length, 1); assert.match(f.checks[0].output.summary, /signed execution sha256/);
  assert.match(f.checks[0].output.summary, /Native publication independent-ci:native:v1:/);
});

test('legacy entry wiring still publishes without creating a Native publication', async t => {
  const f = await fixture(t, false), job = f.jobs['work-admission']; let batchClaim = null;
  const publisher = createFixtureWorkAdmissionPublisherV2({ github: f.wrap([job]), journal: f.journal, admission: f.admission,
    assertLive() {}, record() {}, authority: {}, batchClaims: { async read() { return batchClaim; }, async record(j, c) { batchClaim = claimGeneration(c); } } });
  const result = await publisher.publish(job); assert.equal(result.status, 'SETTLED', JSON.stringify(result));
  assert.equal(f.checks.length, 1); assert.equal(f.calls.length, 0);
});

test('the real read-only controller request carries the complete admitted packet paths',async t=>{
 const {docs}=fixtureRecord(),record=validateRecordV2(docs,{now:Date.now()}),job=batchJobsV2(subject()).gitleaks;
 const identity=makeIndependentPublicationIdentity({job,claim:{claim_id:randomUUID(),fence:4,execution_epoch:3},controller_id:randomUUID()});
 const paths=['scripts/ci/a.mjs','work/a.mjs'],requests=[],original=globalThis.fetch;
 t.after(()=>{globalThis.fetch=original;});
 globalThis.fetch=async(url,options)=>{
  const input=JSON.parse(options.body).p_input;requests.push(input);
  assert.deepEqual(input.changed_paths,paths);assert.equal(Object.hasOwn(input,'pr_ref'),false,'Agent observation must not bind or spend a CI head');
  return new Response(JSON.stringify({status:'ok',verdict:'ADMITTED',execution_policy:'staged',current_fence:4,execution_epoch:3,
   verified_at:new Date().toISOString(),claim:{...identity.claim,status:'ACTIVE',lease_key_required:false,execution_handover_pending:false,
   context_key:record.config.scope,bound_pr:`${job.repo}#${job.pr}`,expires_at:new Date(Date.now()+60000).toISOString()}}),{status:200});
 };
 const ports=controllerPorts({record,appKey:'fixture-unused-key',nativeToken:'fixture-unused-token',policyText:'',sourceRoot:'.',live(){},log(){}});
 assert.equal(await ports.native.current(identity,{scope:record.config.scope,executionPolicy:'staged',guarded:false,paths}),true);
 assert.equal(await ports.native.current(identity,{scope:record.config.scope,executionPolicy:'staged',guarded:false,paths:[]}),false);
 assert.equal(requests.length,1);
});

test('active hosted relay reaches the actual entry adapter without replacing its attested external identity',async t=>{
 const w=createWorld({now:Date.now()});w.allHosted();
 const journal=await EffectJournal.open(path.join(await tempDir(t),'effects')),s=w.subject();
 const jobs=['gitleaks','trivy'].map(role=>makeJobV2({repo:s.repo,pr:s.pr,headSha:s.headSha,baseSha:s.baseSha,sourceManifestSha256:s.sourceManifestSha256,
  role,createdAt:new Date(w.state.now-1200000).toISOString(),attempt:1}));
 const claim={claimId:s.claimId,fence:s.fence,epoch:s.epoch,expiresAt:new Date(w.state.now+3600000).toISOString()};
 const calls=[],tickets=new Map(),native={async current(){return true;},async command(input){calls.push(input);
  if(input.action==='publication_begin_independent'){
   const identity=input.independent_identity;if(!tickets.has(identity.effect_key))tickets.set(identity.effect_key,{publication_id:randomUUID(),receipt_id:randomUUID()});
   return {status:'ok',verdict:'ADMITTED',execution_policy:'active',execution_authorized:true,publication_required:true,...tickets.get(identity.effect_key),independent_identity:identity};
  }return {status:'committed',receipt_id:randomUUID(),must_revoke:false};
 }};
 const {docs}=fixtureRecord(),record=validateRecordV2(docs,{now:w.state.now});
 const github=entryFacade({ports:{github:w.github,native},jobs,journal,nonce:'b'.repeat(32),record});
 const headAuthorizationId=randomUUID(),nativeAdmission={fixture:true,async evaluatePr(job,packet,options={}){
  const facts=admittedFacts(job,claim,packet,{domain:'fixture',observedAt:w.state.now,batchClaim:options.batchClaim,slotUntil:w.state.now+3600000});
  delete facts.observationSha256;const body={...facts,contract:'clued.independent-ci.full-admission/3',executionPolicy:'active',guarded:true,publicationRequired:true,headAuthorizationId};
  return {...body,observationSha256:digest(body)};
 }};
 const sample=await w.authority.observe(jobs[0]),refs=Object.fromEntries(['sourceAcceptanceRef','hostQualificationRef','ownerAuthorizationRef','publisherQualificationRef','ciPrincipalQualificationRef'].map(k=>[k,sample[k]]));
 const authority={fixture:true,async observe(job){return {...await w.authority.observe(job),claim:claimGeneration(claim),claimExpiresAt:claim.expiresAt};}};
 const verifier=w.verifier(),publisher=createStagedCheckPublisherV2({nativeAdmission,authority,github,journal,signers:w.signers,
  configuredChecks:record.config.checks,readChangedPaths:j=>github.readChangedPaths(j),batchClaim:claimGeneration(claim),domain:'fixture',clock:()=>w.state.now,
  hostedVerifier:verifier,protectedDeployment:{enabled:true,domain:'fixture',repository:s.repo,ciPrincipalBindingId:sample.ciPrincipalBindingId,...refs}});
 const stage=createHostedRelayStage({registry:w.registry,verifier,publisher,localInputPins:{trivy:{checksDigest:w.registry.roles.trivy.checksDigest}}});
 const result=await stage.run({subject:s,attempt:1,roles:['gitleaks','trivy']});
 assert.equal(result.status,'COMPLETE',JSON.stringify(result));assert.ok(result.roles.every(r=>r.outcome==='RELAYED'));
 const checks=w.state.checkRuns.filter(c=>c.app.id===5368905);assert.equal(checks.length,2);
 assert.ok(checks.every(c=>c.external_id.startsWith('independent-ci:relay:')&&c.output.summary.includes('Native publication independent-ci:native:v1:')));
 assert.equal(calls.filter(c=>c.action==='publication_finish').length,2);
});
