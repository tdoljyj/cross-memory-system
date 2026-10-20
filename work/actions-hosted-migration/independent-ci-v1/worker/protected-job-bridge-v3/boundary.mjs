// Reuse existing accepted-installation and Linux qualification contracts.
// No first-run acceptance promotion, new issuer, new PKI or caller trust flag.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {canonical,digest} from '../../src/proof.mjs';
import {validateJob} from '../../src/queue.mjs';
import {INSTALL_ROOT,readProtected,assertProtectedPaths} from '../../runtime/protected-files.mjs';
import {protectedPath} from '../qualification.mjs';
import {validateRelayDescriptor} from './mailbox.mjs';
import {openHeldSource,takeHeldSource} from './held-source.mjs';
import {loadFixedRolePolicy,takeActualRolePolicy} from '../formal-fixed-role-policy-v2/policy.mjs';
import {readFixedIssueJob} from './issue-job.mjs';
const SOURCE_ROOT=fileURLToPath(new URL('../../../../../',import.meta.url));
const P='work/actions-hosted-migration/independent-ci-v1/',D=P+'worker/protected-job-bridge-v3/';
const HASH=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/,REPO='tdoljyj/cross-memory-system';
const contexts=new WeakSet(),windowsLeases=new WeakMap(),fail=code=>{throw Object.assign(new Error(code),{code});},check=(v,c)=>{if(!v)fail(c);};
const freeze=v=>{if(Array.isArray(v)||v&&Object.getPrototypeOf(v)===Object.prototype){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
export const LOCAL_FILES=Object.freeze(['boundary.mjs','protocol.mjs','mailbox.mjs','windows-issuer.mjs','linux-worker.mjs','signed-result.mjs','relay-record.mjs','relay-public.ps1','formal-spool-acl.ps1','held-source.mjs','hold-source.ps1','issue-job.mjs']);
// Fixed offline-reviewed import/execution/config closure, never discovered at runtime.
export const REQUIRED_SOURCE_PATHS=Object.freeze([
  '.github/workflows/contract-placement.yml',
  '.github/workflows/gitleaks.yml',
  '.github/workflows/trivy.yml',
  '.gitleaks.toml',
  'config/merge-admission-policy.json',
  'scripts/ci/clued-control-workflow-source.mjs',
  'scripts/ci/clued-control-workflow-sources.json',
  'scripts/ci/clued-gated-proof-profiles.json',
  'scripts/ci/clued-gated-proof-role-specs.json',
  'scripts/ci/clued-production-publisher-source.mjs',
  'scripts/ci/clued-production-publisher-sources.json',
  'scripts/ci/clued-publisher-qualification-source.mjs',
  'scripts/ci/clued-publisher-qualification-sources.json',
  'scripts/ci/clued-work-admission.mjs',
  'scripts/ci/clued-workflow-profile.mjs',
  'scripts/ci/merge-admission-measurement-history.mjs',
  'scripts/ci/merge-admission-policy.mjs',
  'scripts/ci/merge-admission-source-producer.mjs',
  'scripts/ci/reviewed_gitleaks.py',
  'scripts/runner/clued-runner-job-started.mjs',
  'work/actions-hosted-migration/independent-ci-v1/runtime/protected-files.mjs',
  'work/actions-hosted-migration/independent-ci-v1/runtime/verify-install-acl.ps1',
  'work/actions-hosted-migration/independent-ci-v1/src/full-admission.mjs',
  'work/actions-hosted-migration/independent-ci-v1/src/github.mjs',
  'work/actions-hosted-migration/independent-ci-v1/src/proof.mjs',
  'work/actions-hosted-migration/independent-ci-v1/src/queue.mjs',
  'work/actions-hosted-migration/independent-ci-v1/src/worker.mjs',
  'work/actions-hosted-migration/independent-ci-v1/worker/formal-contract-placement-v1/adapter.mjs',
  'work/actions-hosted-migration/independent-ci-v1/worker/formal-contract-placement-v1/container-entry.mjs',
  'work/actions-hosted-migration/independent-ci-v1/worker/formal-fixed-role-policy-v2/integration.mjs',
  'work/actions-hosted-migration/independent-ci-v1/worker/formal-fixed-role-policy-v2/policy.mjs',
  'work/actions-hosted-migration/independent-ci-v1/worker/formal-gitleaks-v2/docker-transport.mjs',
  'work/actions-hosted-migration/independent-ci-v1/worker/formal-gitleaks-v2/required-history/prepare.mjs',
  'work/actions-hosted-migration/independent-ci-v1/worker/formal-gitleaks-v3/adapter.mjs',
  'work/actions-hosted-migration/independent-ci-v1/worker/formal-gitleaks-v3/docker-transport.mjs',
  'work/actions-hosted-migration/independent-ci-v1/worker/formal-gitleaks-v3/required-history/prepare.mjs',
  'work/actions-hosted-migration/independent-ci-v1/worker/formal-gitleaks-v3/required-history/selftest-shim.mjs',
  'work/actions-hosted-migration/independent-ci-v1/worker/formal-trivy-v3/adapter.mjs',
  'work/actions-hosted-migration/independent-ci-v1/worker/formal-trivy-v3/cache.mjs',
  'work/actions-hosted-migration/independent-ci-v1/worker/formal-trivy-v3/docker.mjs',
  'work/actions-hosted-migration/independent-ci-v1/worker/linux-launcher.mjs',
  'work/actions-hosted-migration/independent-ci-v1/worker/protected-controller-ports-v1/refs.mjs',
  'work/actions-hosted-migration/independent-ci-v1/worker/protected-job-bridge-v3/boundary.mjs',
  'work/actions-hosted-migration/independent-ci-v1/worker/protected-job-bridge-v3/formal-spool-acl.ps1',
  'work/actions-hosted-migration/independent-ci-v1/worker/protected-job-bridge-v3/held-source.mjs',
  'work/actions-hosted-migration/independent-ci-v1/worker/protected-job-bridge-v3/hold-source.ps1',
  'work/actions-hosted-migration/independent-ci-v1/worker/protected-job-bridge-v3/issue-job.mjs',
  'work/actions-hosted-migration/independent-ci-v1/worker/protected-job-bridge-v3/linux-worker.mjs',
  'work/actions-hosted-migration/independent-ci-v1/worker/protected-job-bridge-v3/mailbox.mjs',
  'work/actions-hosted-migration/independent-ci-v1/worker/protected-job-bridge-v3/protocol.mjs',
  'work/actions-hosted-migration/independent-ci-v1/worker/protected-job-bridge-v3/relay-public.ps1',
  'work/actions-hosted-migration/independent-ci-v1/worker/protected-job-bridge-v3/relay-record.mjs',
  'work/actions-hosted-migration/independent-ci-v1/worker/protected-job-bridge-v3/signed-result.mjs',
  'work/actions-hosted-migration/independent-ci-v1/worker/protected-job-bridge-v3/windows-issuer.mjs',
  'work/actions-hosted-migration/independent-ci-v1/worker/qualification.mjs',
  'work/actions-hosted-migration/independent-ci-v1/worker/required-gitleaks/prepare.mjs',
  'work/actions-hosted-migration/independent-ci-v1/worker/required-trivy-v2/plans.mjs',
  'work/actions-hosted-migration/independent-ci-v1/worker/verify-once/verify-worker.mjs',
]);
const REFS=['sourceAcceptanceRef','hostQualificationRef','ownerAuthorizationRef','publisherQualificationRef','ciPrincipalQualificationRef','ownerPackageAcceptanceRef','installationReceiptRef'];
export function validateFormalAcceptance(config,a,identity,now=Date.now()){
  check(config?.contract==='clued.independent-ci.one-shot/1'&&config.enabled===true&&!Object.hasOwn(config,'finiteFirstRun')&&!Object.hasOwn(config,'observationOnly')&&(!Object.hasOwn(config,'domain')||config.domain==='production')&&config.repository===REPO&&config.appId===5368905&&config.installationId===172706661&&config.repositoryId===1334673495&&
    HASH.test(config.acceptanceSha256??'')&&HASH.test(config.sourceManifestSha256??'')&&HASH.test(config.ciTokenPinSha256??'')&&HASH.test(config.evaluatorSha256??'')&&HASH.test(config.policySha256??'')&&
    UUID.test(config.ciPrincipalBindingId??'')&&typeof config.ciPrincipalQualificationRef==='string'&&/^[A-Za-z0-9+/]{43}=$/.test(config.appPublicKeySha256Base64??'')&&
    (config.scope==='global'||/^project:[a-f0-9-]{36}$/.test(config.scope)),'EXISTING_FORMAL_CONTROLLER_CONFIG_REQUIRED');
  check(a?.contract==='clued.independent-ci.accepted-installation/1'&&a.domain==='production'&&a.accepted===true&&a.repository===REPO&&
    a.configSha256===digest({...config,acceptanceSha256:null})&&a.platform==='win32'&&identity?.platform==='win32'&&a.arch===identity.arch&&a.controllerAccount===identity.account&&
    /^[A-Za-z0-9-]+$/.test(a.hostname??'')&&a.hostname.toLowerCase()===identity.hostname.toLowerCase()&&a.workerCannotReadController===true&&
    Date.parse(a.acceptedAt)<=now&&Date.parse(a.expiresAt)>now&&REFS.every(r=>UUID.test(a[r]??''))&&
    a.ciPrincipalBindingId===config.ciPrincipalBindingId&&a.ciPrincipalQualificationRef===config.ciPrincipalQualificationRef&&a.ciTokenPinSha256===config.ciTokenPinSha256&&
    a.appPublicKeySha256Base64===config.appPublicKeySha256Base64&&!Object.hasOwn(config,'ciTokenSha256')&&!Object.hasOwn(a,'ciTokenSha256'),
    'FORMAL_CONTROLLER_ACCEPTANCE_MISSING');return a;
}
export function validateSourcePins(files,required=REQUIRED_SOURCE_PATHS){
  check(Array.isArray(files)&&files.length<=10000,'BRIDGE_ACCEPTED_SOURCE_MISSING');const pins=new Map();
  for(const p of files){check(p&&Object.keys(p).sort().join('|')==='path|sha256'&&typeof p.path==='string'&&!p.path.startsWith('/')&&!/[\\:\x00-\x1f]/.test(p.path)&&!p.path.split('/').some(v=>!v||v==='.'||v==='..')&&HASH.test(p.sha256??'')&&!pins.has(p.path),'BRIDGE_SOURCE_PIN_INVALID');pins.set(p.path,p.sha256);}
  check(required.every(p=>pins.has(p)),'BRIDGE_ACCEPTED_SOURCE_INCOMPLETE');return pins;
}
async function checkSource(files,root,{windows=false}={}){
  const pins=validateSourcePins(files);
  for(const[relative,sha]of pins){const file=path.join(root,relative);if(windows)await assertProtectedPaths(root,[file]);else await protectedPath(file);check(digest(await readProtected(file))===sha,'BRIDGE_ACCEPTED_SOURCE_DRIFT');}
  return pins;
}
export async function loadWindowsContext(job){
  validateJob(job);check(job.repo===REPO&&['gitleaks','trivy','contract-placement'].includes(job.role)&&job.attempt===1,'FORMAL_BRIDGE_JOB_REQUIRED');
  check(process.platform==='win32','FORMAL_WINDOWS_CONTROLLER_REQUIRED');
  const lease=takeHeldSource(await openHeldSource());
  try{
    const held=lease.data,text=name=>new TextDecoder('utf-8',{fatal:true}).decode(held.documents[name]);
    const config=JSON.parse(text('installation.json')),acceptanceText=text('acceptance.json'),accepted=JSON.parse(acceptanceText);
    check(digest(acceptanceText)===config.acceptanceSha256,'FORMAL_ACCEPTANCE_BYTES_CHANGED');
    validateFormalAcceptance(config,accepted,{platform:process.platform,arch:process.arch,hostname:os.hostname(),account:os.userInfo().username});
    check(held.expiresAt===accepted.expiresAt&&config.sourceManifestSha256===job.sourceManifestSha256,'FORMAL_JOB_MANIFEST_CHANGED');
    const pins=validateSourcePins(accepted.sourceFiles);check(pins.size===held.sourceHashes.size&&[...pins].every(([p,s])=>held.sourceHashes.get(p)===s),'BRIDGE_ACCEPTED_SOURCE_DRIFT');
    check(pins.get('scripts/ci/clued-work-admission.mjs')===config.evaluatorSha256&&pins.get('config/merge-admission-policy.json')===config.policySha256,'FORMAL_NATIVE_SOURCE_CHANGED');
    const manifestText=text('source-manifest.json');check(digest(manifestText)===config.sourceManifestSha256,'FORMAL_SOURCE_MANIFEST_CHANGED');const manifest=JSON.parse(manifestText);
    check(manifest.repo===REPO&&manifest.roles?.[job.role],'FORMAL_JOB_ROLE_NOT_ACCEPTED');
    const descriptor=validateRelayDescriptor(manifest.roles[job.role].controllerRelay,accepted),signersData=JSON.parse(text('signers.json'));
    check(digest(signersData)===accepted.signerRegistrySha256&&Array.isArray(signersData.signers)&&signersData.signers.length>0,'EXISTING_RESULT_REGISTRY_REQUIRED');
    const signers=new Map();for(const s of signersData.signers){check(s.domain==='production'&&!signers.has(s.keyId)&&s.sourceAcceptanceRef===accepted.sourceAcceptanceRef&&s.qualificationRef===accepted.hostQualificationRef,'EXISTING_RESULT_REGISTRY_CHANGED');signers.set(s.keyId,s);}
    for(const s of signers.values())freeze(s);
    const context=freeze({side:'windows',job:Object.freeze(structuredClone(job)),config,accepted,manifest,descriptor,get signers(){return new Map(signers);},sourceRoot:SOURCE_ROOT,policyText:held.policyText,sourceAcceptanceRef:accepted.sourceAcceptanceRef,hostQualificationRef:accepted.hostQualificationRef});
    contexts.add(context);windowsLeases.set(context,lease);assertWindowsContextLive(context);return context;
  }catch(e){await lease.close();throw e;}
}
export function assertWindowsContextLive(context){
  check(contexts.has(context)&&context.side==='windows'&&windowsLeases.has(context),'ACTUAL_WINDOWS_CONTEXT_LEASE_REQUIRED');takeHeldSource(windowsLeases.get(context));
  validateFormalAcceptance(context.config,context.accepted,{platform:process.platform,arch:process.arch,hostname:os.hostname(),account:os.userInfo().username});return context;
}
export async function closeWindowsContext(context){check(contexts.has(context)&&context.side==='windows','ACTUAL_WINDOWS_CONTEXT_LEASE_REQUIRED');const lease=windowsLeases.get(context);windowsLeases.delete(context);if(lease)await lease.close();}
export async function loadLinuxContext(job=null){
  check(process.platform==='linux'&&process.getuid?.()===0,'FORMAL_LINUX_CONTROLLER_REQUIRED');
  job??=await readFixedIssueJob();const loaded=takeActualRolePolicy(await loadFixedRolePolicy(job)),{config,sourceManifestBytes}=loaded,manifest=JSON.parse(sourceManifestBytes);
  const role=job.role;check(['gitleaks','trivy','contract-placement'].includes(role)&&manifest.roles?.[role],'FORMAL_SCANNER_PROFILE_REQUIRED');
  check(config.entryFile===fileURLToPath(new URL('./linux-worker.mjs',import.meta.url)),'FORMAL_LINUX_ENTRY_NOT_ACCEPTED');
  const descriptor=validateRelayDescriptor(manifest.roles[role].controllerRelay,{sourceAcceptanceRef:config.sourceAcceptanceRef,hostQualificationRef:config.hostAcceptanceRef});
  await checkSource(manifest.roles[role].sourceFiles,config.trustedSourceDirectory);
  const context=freeze({side:'linux',role,...loaded,manifest,descriptor,sourceAcceptanceRef:config.sourceAcceptanceRef,hostQualificationRef:config.hostAcceptanceRef});contexts.add(context);return context;
}
export function takeAcceptedBridgeContext(context){check(contexts.has(context),'ACTUAL_ACCEPTED_BRIDGE_CONTEXT_REQUIRED');if(context.side==='windows')assertWindowsContextLive(context);return context;}
