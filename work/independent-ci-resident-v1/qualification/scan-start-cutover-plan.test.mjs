// Public immutable Git fixtures only. Never acceptance, production or a source
// of deployed identity/qualification; every builder result remains inactive.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {buildScanStartCutoverPlan,validateCutoverPolicyPlan,serializeCutoverPolicyPlan,REGISTRY_PATH,main} from './scan-start-cutover-plan.mjs';
import {gitObjectReader} from '../../actions-hosted-migration/independent-ci-v1/src/hosted-relay-v1/build-registry.mjs';
import {canonicalJson} from '../src/canonical.mjs';
const ROOT=fileURLToPath(new URL('../../../',import.meta.url));
const env={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_TERMINAL_PROMPT:'0',
  GIT_AUTHOR_NAME:'offline fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'offline fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'};
const git=(dir,args,input)=>{const r=spawnSync('git',['-C',dir,...args],{env,windowsHide:true,input,encoding:'utf8'});assert.equal(r.status,0,String(r.stderr));return r.stdout.trim();};
// A fixed frozen commit, never HEAD: the plan accepts a commit only while its closure equals the digests pinned in
// hosted-relay-v1/registry.json (the 732 hosted generation). 2640dce9 is the gen8 head that closure was frozen against;
// HEAD moves with every Source re-pin (DESIGN 52) and would make this module throw CUTOVER_FROZEN_CLOSURE_DRIFT.
const COMMIT='2640dce952d68337f391a842755ac763c6f2ad4a';
assert.equal(git(ROOT,['cat-file','-t',COMMIT]),'commit');
const INPUT={repoDir:ROOT,frozenCommit:COMMIT,ownerUserId:'11111111-1111-4111-8111-111111111111',projectId:'22222222-2222-4222-8222-222222222222',sourceManifestSha256:'e'.repeat(64),
  qualificationHeadSha:'a'.repeat(40),qualificationHoldEvidenceSha256:'b'.repeat(64)};
const sha=b=>createHash('sha256').update(b).digest('hex');
const TEMPLATE=buildScanStartCutoverPlan(INPUT);
const fresh=()=>structuredClone(TEMPLATE);
function resign(p){const {draftSha256,...body}=p;p.draftSha256=sha(Buffer.from(canonicalJson(body)));return p;}
function fixture(t){
  const parent=fs.realpathSync(os.tmpdir()),root=fs.mkdtempSync(path.join(parent,'scan-start-plan-fixture-')),dir=path.join(root,'repo');
  git(parent,['clone','--shared','--no-checkout','--quiet',ROOT,dir]);
  t.after(()=>{assert.equal(fs.realpathSync(root),root);assert.equal(path.dirname(root),parent);fs.rmSync(root,{recursive:true});});
  return {root,dir,commitFile(file,bytes){
    git(dir,['read-tree',COMMIT]);const blob=git(dir,['hash-object','-w','--stdin'],bytes);
    git(dir,['update-index','--add','--cacheinfo','100644,'+blob+','+file]);
    const tree=git(dir,['write-tree']);return git(dir,['commit-tree',tree,'-p',COMMIT,'-m','isolated unqualified drift']);
  }};
}

test('frozen registry raw bytes and every hosted closure derive three inactive Native roles',()=>{
  const p=fresh();assert.equal(p.state,'DRAFT_NOT_ACCEPTED_NOT_ACTIVATED');assert.equal(p.installability,'NOT_INSTALLABLE');
  assert.deepEqual(Object.keys(p.policy.roles).sort(),['contract-placement','gitleaks','trivy']);
  assert.equal(p.policy.roles['contract-placement'].hosted_allowed,false);
  assert.ok(Object.values(p.policy.roles).every(r=>r.hosted_allowed===false),'Native-only phase has no hosted execution');
  assert.equal(p.policy.hosted_head_sha,null);assert.equal(p.hostedQualificationPolicy.hosted_head_sha,INPUT.qualificationHeadSha);
  assert.equal(p.hostedQualificationPolicy.roles.gitleaks.hosted_allowed,true);assert.equal(p.hostedQualificationPolicy.roles.trivy.hosted_allowed,true);
  assert.equal(p.hostedQualificationPolicy.roles['contract-placement'].hosted_allowed,false);assert.equal(p.allHeadsPolicy,null);
  const reader=gitObjectReader(ROOT),entry=reader.entry(COMMIT,REGISTRY_PATH),raw=reader.blob(entry.sha),r=JSON.parse(raw);
  assert.equal(p.frozenSource.registryBlob,entry.sha);assert.equal(p.policy.registry_sha256,sha(raw));
  assert.notEqual(p.policy.registry_sha256,p.frozenSource.registryStructuralDigestForAuditOnly);
  for(const role of ['gitleaks','trivy']){
    assert.equal(p.policy.roles[role].check_name,r.roles[role].hostedCheckName);
    assert.notEqual(p.policy.roles[role].check_name,r.roles[role].checkName);
    assert.deepEqual(p.policy.roles[role].closure,r.roles[role].closure);
  }
  assert.equal(Object.hasOwn(p.policy,'ci_principal_binding_id'),false);assert.equal(Object.hasOwn(p.policy,'binding_id'),false);
  assert.equal(p.policy.activated_at,null);assert.equal(p.activated,false);assert.equal(p.liveQualified,false);
  assert.equal(p.cutover.nativeOnlyMustPassFirst,true);assert.equal(p.cutover.exactHeadQualificationHoldRequired,true);
  assert.equal(p.cutover.hostedGlobalWithRelayFalseForbidden,true);assert.equal(p.cutover.oldHeadsMayBeRescanned,false);
  assert.ok(p.remainingGates.includes('ACTUAL_L1_L2_L3_L4_QUALIFICATION'));
  assert.equal(serializeCutoverPolicyPlan(p),serializeCutoverPolicyPlan(buildScanStartCutoverPlan(INPUT)),'no wall-clock or random qualification evidence');
});
test('unknown exact owner/project/Source remains explicit NOT_INSTALLABLE, never guessed or accepted',()=>{
  const p=buildScanStartCutoverPlan({repoDir:ROOT,frozenCommit:COMMIT});
  assert.deepEqual(p.missingExactInputs,['owner_user_id','project_id_and_scope','accepted_source_manifest_sha256','installed_qualification_hold_head_sha','installed_qualification_hold_evidence_sha256']);
  assert.equal(p.policy.user_id,null);assert.equal(p.policy.scope,null);assert.equal(p.policy.source_manifest_sha256,null);
  assert.equal(p.installability,'NOT_INSTALLABLE');assert.equal(p.accepted,false);
  assert.equal(p.hostedQualificationPolicy,null,'unknown H emits no hosted-enabled payload at all');assert.equal(p.qualificationSubject.liveHoldVerified,false);
  assert.throws(()=>buildScanStartCutoverPlan({...INPUT,ciPrincipalBindingId:INPUT.ownerUserId}),{code:'CUTOVER_INPUT_SHAPE'});
  assert.throws(()=>buildScanStartCutoverPlan({...INPUT,frozenCommit:'HEAD'}),{code:'CUTOVER_FIXED_GIT_COMMIT_REQUIRED'});
});
test('missing placement, hosted placement and required-check-name confusion are refused even after draft resigning',()=>{
  for(const change of [p=>delete p.policy.roles['contract-placement'],p=>p.policy.roles['contract-placement'].hosted_allowed=true,
    p=>p.policy.roles.gitleaks.check_name='gitleaks',p=>p.policy.roles.trivy.check_name='trivy',
    p=>p.policy.ci_principal_binding_id=INPUT.ownerUserId,p=>delete p.hostedQualificationPolicy.roles['contract-placement'],
    p=>p.hostedQualificationPolicy.roles['contract-placement'].hosted_allowed=true,p=>p.hostedQualificationPolicy.roles.gitleaks.check_name='gitleaks']){
    const p=fresh();change(p);assert.throws(()=>validateCutoverPolicyPlan(resign(p)));
  }
});
test('Native registry SHA must be the frozen raw file, never the structural audit digest',()=>{
  const p=fresh();
  assert.throws(()=>buildScanStartCutoverPlan({...INPUT,expectedRawRegistrySha256:p.frozenSource.registryStructuralDigestForAuditOnly}),{code:'CUTOVER_RAW_REGISTRY_SHA_MISMATCH'});
  assert.equal(buildScanStartCutoverPlan({...INPUT,expectedRawRegistrySha256:p.policy.registry_sha256}).policy.registry_sha256,p.policy.registry_sha256);
  p.policy.registry_sha256=p.frozenSource.registryStructuralDigestForAuditOnly;assert.throws(()=>validateCutoverPolicyPlan(resign(p)),{code:'CUTOVER_RAW_REGISTRY_SHA_MISMATCH'});
});
test('a real frozen Git closure drift is refused while an unrelated worktree edit has no effect',t=>{
  const f=fixture(t),file='scripts/ci/clued-scan-start.mjs';
  const changed=f.commitFile(file,'// unqualified immutable helper drift\n');
  assert.throws(()=>buildScanStartCutoverPlan({...INPUT,repoDir:f.dir,frozenCommit:changed}),{code:'CUTOVER_FROZEN_CLOSURE_DRIFT'});
  fs.writeFileSync(path.join(f.dir,'unrelated-worktree-file'),'not a Git qualification');
  assert.equal(buildScanStartCutoverPlan({...INPUT,repoDir:f.dir}).draftSha256,fresh().draftSha256);
});
test('a frozen /1 registry and tampered /2 closure metadata cannot masquerade as the cutover policy',t=>{
  const f=fixture(t),p=fresh(),reader=gitObjectReader(ROOT),r=JSON.parse(reader.blob(reader.entry(COMMIT,REGISTRY_PATH).sha));
  const legacy={...r,contract:'clued.independent-ci.hosted-relay-registry/1'};delete legacy.scanStart;
  const old=f.commitFile(REGISTRY_PATH,JSON.stringify(legacy));assert.throws(()=>buildScanStartCutoverPlan({...INPUT,repoDir:f.dir,frozenCommit:old}));
  r.roles.gitleaks.closure[0].sha256='f'.repeat(64);
  const drift=f.commitFile(REGISTRY_PATH,JSON.stringify(r));assert.throws(()=>buildScanStartCutoverPlan({...INPUT,repoDir:f.dir,frozenCommit:drift}));
  assert.equal(p.accepted,false);
});
test('no draft can remove coordination/acceptance gates or enable a provider after resigning',()=>{
  for(const change of [p=>p.accepted=true,p=>p.policy.activated_at='2026-11-03T00:00:00Z',p=>p.remainingGates=[],p=>p.missingExactInputs=['invented'],
    p=>p.cutover.requiredOrdinaryHostedGlobalEnabled=true,p=>p.cutover.hostedGlobalWithRelayFalseForbidden=false,p=>p.cutover.resetMetersOrReleaseCaps=true,
    p=>p.cutover.unknownOutcomeKeepsHold=false,p=>p.cutover.ordinaryResumeOrSourceChangeCannotReleaseHold=false,p=>p.cutover.qualificationDispatchRestrictedToHeldNewHead=false,
    p=>p.credentialHandling.readSecrets=true,p=>p.credentialHandling.deleteOldCredentials=true,
    p=>p.hostedQualificationPolicy.hosted_head_sha=null,p=>p.hostedQualificationPolicy.hosted_head_sha='c'.repeat(40),
    p=>p.allHeadsPolicy={...p.hostedQualificationPolicy,hosted_head_sha:null},p=>p.qualificationSubject.liveHoldVerified=true]){
    const p=fresh();change(p);assert.throws(()=>validateCutoverPolicyPlan(resign(p)));
  }
});
test('exact H and public hold hash are draft bindings only; malformed and unproved qualifications never become global scope',()=>{
  assert.equal(fresh().qualificationSubject.liveHoldVerified,false);assert.equal(fresh().allHeadsPolicy,null);
  for(const bad of ['', 'A'.repeat(40),'a'.repeat(39),'a'.repeat(41),7])assert.throws(()=>buildScanStartCutoverPlan({...INPUT,qualificationHeadSha:bad}),{code:'CUTOVER_QUALIFICATION_HEAD'});
  const unknown=buildScanStartCutoverPlan({...INPUT,qualificationHeadSha:null,qualificationHoldEvidenceSha256:null});
  assert.equal(unknown.installability,'NOT_INSTALLABLE');assert.ok(unknown.missingExactInputs.includes('installed_qualification_hold_head_sha'));
  assert.equal(unknown.hostedQualificationPolicy,null);
  assert.equal(unknown.qualificationSubject.liveHoldVerified,false);assert.ok(unknown.remainingGates.includes('INSTALLED_ACCEPTED_SOURCE_EXACT_HEAD_HOLD_PROOF'));
});
test('CLI emits only a create-only inactive JSON candidate and never activation SQL',t=>{
  const f=fixture(t),out=path.join(f.root,'draft.json'),messages=[];
  const args=['--repo',ROOT,'--commit',COMMIT,'--out',out];
  assert.equal(main(args,{write:v=>messages.push(v)}),0);
  const p=JSON.parse(fs.readFileSync(out));assert.equal(p.accepted,false);assert.equal(p.policy.activated_at,null);
  assert.equal(main(args,{write:v=>messages.push(v)}),2,'existing candidate is never overwritten');
  assert.equal(fs.readFileSync(out,'utf8'),serializeCutoverPolicyPlan(p));
});
