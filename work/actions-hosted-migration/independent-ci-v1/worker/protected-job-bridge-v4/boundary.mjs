// Source v2 port of protected-job-bridge-v3/boundary.mjs (DESIGN S6, S12). No first-run acceptance
// promotion, new issuer, new PKI or caller trust flag.
//   - Windows: the context is built inside a v2 stage entry (resident-v2/entry-runtime.mjs#runEntry) from
//     the claim-free install record that the entry already validated and still holds by handle
//     (held-record.mjs); its liveness is that lease. No accepted-installation/1, no expiresAt window.
//   - Linux: role policy v3 (no currentClaim), qualification v2, the v4 worker as the accepted entry.
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {validateJobV2,SCANNER_ROLES_V2} from '../../src/job-v2.mjs';
import {protectedPath,loadQualifiedPolicyV2} from '../qualification-v2.mjs';
import {validateRelayDescriptor} from './mailbox.mjs';
import {loadFixedRolePolicy,takeActualRolePolicy,validateSelectedFacts,fixedPolicyPath} from '../formal-fixed-role-policy-v3/policy.mjs';
import {readFixedIssueJob} from './issue-job.mjs';
const P='work/actions-hosted-migration/independent-ci-v1/';
const HASH=/^[a-f0-9]{64}$/,REPO='tdoljyj/cross-memory-system';
const contexts=new WeakSet(),windowsLive=new WeakMap(),fail=code=>{throw Object.assign(new Error(code),{code});},check=(v,c)=>{if(!v)fail(c);};
const freeze=v=>{if(Array.isArray(v)||v&&Object.getPrototypeOf(v)===Object.prototype){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
export const LOCAL_FILES=Object.freeze(['boundary.mjs','protocol.mjs','mailbox.mjs','windows-issuer.mjs','linux-worker.mjs','signed-result.mjs','relay-record.mjs','relay-public.ps1','formal-spool-acl.ps1','issue-job.mjs']);
// Fixed offline-reviewed import/execution/config closure of the bridge (both sides), never discovered at
// runtime. Every path must be pinned by the accepted Source manifest of the role.
export const REQUIRED_SOURCE_PATHS=Object.freeze([...LOCAL_FILES.map(n=>P+'worker/protected-job-bridge-v4/'+n),
  '.github/workflows/contract-placement.yml','.github/workflows/gitleaks.yml','.github/workflows/trivy.yml','.gitleaks.toml',
  'config/merge-admission-policy.json','scripts/ci/clued-work-admission.mjs','scripts/ci/reviewed_gitleaks.py',
  ...['src/proof.mjs','src/proof-v2.mjs','src/job-v2.mjs','src/admission-facts-v2.mjs','src/scan-start-v1/grant.mjs','src/scan-start-v1/native-port.mjs',
    'src/hosted-relay-v1/registry.mjs','src/hosted-relay-v1/registry.json','src/full-admission-v2.mjs','src/batch-claim-v2.mjs','src/worker-v2.mjs','src/worker.mjs',
    'src/independent-control-checks-v2/queue-facts.mjs','src/github.mjs','runtime/protected-files.mjs',
    'src/resident-v2/entry-runtime.mjs','src/resident-v2/stage-inputs.mjs','src/resident-v2/held-record.mjs','src/resident-v2/hold-record.ps1','src/resident-v2/layout.mjs','src/resident-v2/record.mjs',
    'worker/qualification-v2.mjs','worker/qualification.mjs','worker/formal-fixed-role-policy-v3/policy.mjs',
    'worker/formal-gitleaks-v4/adapter.mjs','worker/formal-gitleaks-v4/required-history/prepare.mjs','worker/formal-gitleaks-v4/required-history/selftest-shim.mjs','worker/formal-gitleaks-v3/docker-transport.mjs',
    'worker/formal-trivy-v4/adapter.mjs','worker/formal-trivy-v3/cache.mjs','worker/formal-trivy-v3/docker.mjs','worker/required-trivy-v3/plans.mjs','worker/required-trivy-v2/plans.mjs',
    'worker/formal-contract-placement-v2/adapter.mjs','worker/formal-contract-placement-v2/container-entry.mjs','worker/formal-gitleaks-v2/docker-transport.mjs',
    'worker/required-gitleaks/prepare.mjs','worker/trusted-workflows.mjs','worker/verify-once/verify-worker.mjs','worker/protected-controller-ports-v2/refs.mjs',
    'worker/scan-result-cache-v1/cache.mjs'].map(p=>P+p)].sort());
export function validateSourcePins(files,required=REQUIRED_SOURCE_PATHS){
  check(Array.isArray(files)&&files.length<=10000,'BRIDGE_ACCEPTED_SOURCE_MISSING');const pins=new Map();
  for(const p of files){check(p&&Object.keys(p).sort().join('|')==='path|sha256'&&typeof p.path==='string'&&!p.path.startsWith('/')&&!/[\\:\x00-\x1f]/.test(p.path)&&!p.path.split('/').some(v=>!v||v==='.'||v==='..')&&HASH.test(p.sha256??'')&&!pins.has(p.path),'BRIDGE_SOURCE_PIN_INVALID');pins.set(p.path,p.sha256);}
  check(required.every(p=>pins.has(p)),'BRIDGE_ACCEPTED_SOURCE_INCOMPLETE');return pins;
}
async function checkLinuxSource(files,root){
  const pins=validateSourcePins(files);
  for(const[relative,sha]of pins){const file=path.join(root,relative);await protectedPath(file);check(createHash('sha256').update(await readFile(file)).digest('hex')===sha,'BRIDGE_ACCEPTED_SOURCE_DRIFT');}
  return pins;
}
// Windows: inputs = resident-v2/stage-inputs.mjs#loadStageInputs result; live() re-asserts the held lease.
export function createWindowsContext({inputs,policyText,sourceRoot,live}){
  check(process.platform==='win32','FORMAL_WINDOWS_CONTROLLER_REQUIRED');
  check(typeof live==='function'&&typeof policyText==='string'&&typeof sourceRoot==='string','ACTUAL_WINDOWS_CONTEXT_LEASE_REQUIRED');
  const job=inputs.jobs?.[0];validateJobV2(job);check(inputs.jobs.length===1&&job.repo===REPO&&SCANNER_ROLES_V2.includes(job.role),'FORMAL_BRIDGE_JOB_REQUIRED');
  const {config,accepted,manifest}=inputs.record;
  check(config.sourceManifestSha256===job.sourceManifestSha256&&manifest.repo===REPO&&manifest.roles?.[job.role],'FORMAL_JOB_ROLE_NOT_ACCEPTED');
  validateSourcePins(accepted.sourceFiles);
  const descriptor=validateRelayDescriptor(manifest.roles[job.role].controllerRelay,accepted),signers=inputs.record.signers;
  const context=freeze({side:'windows',job:structuredClone(job),config,accepted,manifest,descriptor,get signers(){return new Map(signers);},sourceRoot,policyText,
    sourceAcceptanceRef:accepted.sourceAcceptanceRef,hostQualificationRef:accepted.hostQualificationRef});
  contexts.add(context);windowsLive.set(context,live);live();return context;
}
export function assertWindowsContextLive(context){
  check(contexts.has(context)&&context.side==='windows'&&windowsLive.has(context),'ACTUAL_WINDOWS_CONTEXT_LEASE_REQUIRED');windowsLive.get(context)();return context;
}
export function closeWindowsContext(context){check(contexts.has(context)&&context.side==='windows','ACTUAL_WINDOWS_CONTEXT_LEASE_REQUIRED');windowsLive.delete(context);}
export async function loadLinuxContext(job=null){
  check(process.platform==='linux'&&process.getuid?.()===0,'FORMAL_LINUX_CONTROLLER_REQUIRED');
  job??=await readFixedIssueJob();const loaded=takeActualRolePolicy(await loadFixedRolePolicy(job)),{config,sourceManifestBytes}=loaded,manifest=JSON.parse(sourceManifestBytes);
  const role=job.role;check(SCANNER_ROLES_V2.includes(role)&&manifest.roles?.[role],'FORMAL_SCANNER_PROFILE_REQUIRED');
  check(config.entryFile===fileURLToPath(new URL('./linux-worker.mjs',import.meta.url)),'FORMAL_LINUX_ENTRY_NOT_ACCEPTED');
  const descriptor=validateRelayDescriptor(manifest.roles[role].controllerRelay,{sourceAcceptanceRef:config.sourceAcceptanceRef,hostQualificationRef:config.hostAcceptanceRef});
  await checkLinuxSource(manifest.roles[role].sourceFiles,config.trustedSourceDirectory);
  // policy: the actual role policy this context was built from (openFixedRoleSession may reuse it; bf57ff10 P2 D).
  const context=freeze({side:'linux',role,...loaded,policy:loaded,manifest,descriptor,sourceAcceptanceRef:config.sourceAcceptanceRef,hostQualificationRef:config.hostAcceptanceRef});contexts.add(context);return context;
}
// bf57ff10 P2 C (2026-11-07): the context of the public relay (relay-record.mjs), which only moves public bytes between
// the fixed spools (no job, key, API or authority of its own); the Linux worker also uses it as the part of each
// callback's reload that must pass before a challenge is written (linux-worker.mjs, review MAJOR-1).
// What it checks, as loadLinuxContext does: the root principal; loadQualifiedPolicyV2 (the protected private policy file
// and its shape, the Docker socket, every runtime path, the pinned entry/docker/node/git/qualification/worker/proof/job
// bytes, the running node, the manifest hash, the qualification signature and payload); validateSelectedFacts at the
// current clock (Source context, qualification window, role pins and their required paths, role configuration); the
// accepted relay descriptor; the entry file; the shape and completeness of the bridge's Source pins (validateSourcePins).
// What it does NOT check, unlike loadLinuxContext / loadFixedRolePolicy (about 1 s together): the Git checkout
// (trackedSource: no shared/shallow repository, HEAD = the manifest's sourceSha, the tree, `git hash-object` of every role
// pin, a clean status), the bytes of the pinned Source files on disk (checkLinuxSource and trackedSource), trivy's cache
// root (protectedPath of formalTrivy.cacheRoot) and gitleaks' host python pin. The Linux worker still makes all of these
// in loadLinuxContext when it starts and in every callback before it adopts a response or signs. It is not an accepted
// bridge context (never in `contexts`): it cannot open the accepted mailbox or reach the signer.
export function relayContextOf(job,loaded,now=Date.now()){
  const facts=validateSelectedFacts(job,loaded,now),{config}=loaded,role=job.role;
  check(SCANNER_ROLES_V2.includes(role)&&facts.manifest.roles?.[role],'FORMAL_SCANNER_PROFILE_REQUIRED');
  check(config.entryFile===fileURLToPath(new URL('./linux-worker.mjs',import.meta.url)),'FORMAL_LINUX_ENTRY_NOT_ACCEPTED');
  const descriptor=validateRelayDescriptor(facts.manifest.roles[role].controllerRelay,{sourceAcceptanceRef:config.sourceAcceptanceRef,hostQualificationRef:config.hostAcceptanceRef});
  validateSourcePins(facts.manifest.roles[role].sourceFiles);
  return freeze({side:'linux-relay',role,config:structuredClone(config),manifest:facts.manifest,descriptor,sourceAcceptanceRef:config.sourceAcceptanceRef,hostQualificationRef:config.hostAcceptanceRef});
}
export async function loadLinuxRelayContext(job=null){
  check(process.platform==='linux'&&process.getuid?.()===0,'FORMAL_LINUX_CONTROLLER_REQUIRED');
  job??=await readFixedIssueJob();validateJobV2(job);
  const loaded=await loadQualifiedPolicyV2(fixedPolicyPath(job.role));
  // As loadFixedRolePolicy: the clock is read again after every asynchronous read above.
  return relayContextOf(job,loaded,Date.now());
}
export function takeAcceptedBridgeContext(context){check(contexts.has(context),'ACTUAL_ACCEPTED_BRIDGE_CONTEXT_REQUIRED');if(context.side==='windows')assertWindowsContextLive(context);return context;}
