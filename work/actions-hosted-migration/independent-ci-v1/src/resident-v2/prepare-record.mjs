// Claim-free install record for Source v2 (DESIGN S5, S6). Replaces the per-claim / per-PR payload
// binder (prepare-payload.mjs + the out-of-repo derive-fNN.py / prepare-claim-config-rebind.mjs /
// repair-claim-config.ps1 chain). It is run ONCE per Source acceptance, before the Owner's single
// elevated install, and its output is copied by that install into resident\record\ (admin-only).
//
// What changed against v1, and why:
//   - no claim anywhere (installation.json had currentClaim; FIXED_NEW_CLAIM_REQUIRED hard-coded one):
//     the claim is resolved live per admission (full-admission-v2.mjs) and sticky per batch;
//   - no PR, head, base or job in the record: jobs are derived per batch from the trigger (derive-batch.mjs);
//   - the Owner acceptance window is the install's: `validUntil` null = until Source change or
//     uninstall (Owner decision 1b5d3687), otherwise a review deadline; no 24 h cap, no claim cap;
//   - the record pins the controller node and the six check mappings exactly as v1 did.
// Inputs /2 (resident active/standby design v0.4 §9 C1): the input `node` (node profile /1, validateNodeProfile
// below) replaces `hostname`; acceptance.json carries it whole as `node`, next to the unchanged `hostname`
// (= node.hostname). It is the host identity the Source used to carry as TURING constants. The acceptance contract
// stays /2: a reader that does not use `node` yet (the generic helper's FormalPublicBoundaryV2.cs) is unaffected,
// and every JS reader (record.mjs) refuses a record without a valid one.
// ciPrincipalRoleRef (primary/standby C7, design v0.4 section 7.2, resident DESIGN.md section 30) changes meaning, not shape: it is the
// Owner decision that this ci-admission connection MAY hold the role (a qualification), no longer the ground for "it holds the role
// now". A node is installed as STANDBY on a connection the service has not marked, and every hand-over changes who holds the role;
// whether this connection holds it now is only ever the role probe's answer. Validation is unchanged: a UUID.
// Pure WORK: no host path is read or written except --source-root (a checkout) and the new --out.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { canonical } from '../proof.mjs';
import { REPO } from './layout.mjs';

export const RECORD_INPUTS_CONTRACT = 'clued.independent-ci.resident-record-inputs/2';
export const RECORD_MANIFEST_CONTRACT = 'clued.independent-ci.resident-record/2';
export const INSTALLATION_CONTRACT_V2 = 'clued.independent-ci.one-shot/2';
export const ACCEPTANCE_CONTRACT_V2 = 'clued.independent-ci.accepted-installation/2';
export const SOURCES_SCHEMA_V2 = 'independent-ci.sources.v2';
export const CHECKS_V2 = Object.freeze({
  'gitleaks': { name: 'gitleaks', appId: 5368905 }, 'trivy': { name: 'trivy', appId: 5368905 },
  'work-admission': { name: 'kooyumi-work-admission', appId: 5368905 }, 'contract-placement': { name: 'contract-placement', appId: 5368905 },
  'control-admission': { name: 'kooyumi-admission-verified', appId: 5368905 }, 'control-merge-slot': { name: 'kooyumi-merge-slot', appId: 5368905 },
});
export const REFS = Object.freeze(['sourceAcceptanceRef', 'hostQualificationRef', 'ownerAuthorizationRef', 'publisherQualificationRef', 'ciPrincipalQualificationRef', 'ownerPackageAcceptanceRef', 'installationReceiptRef']);
const HASH = /^[a-f0-9]{64}$/, SHA = /^[a-f0-9]{40}$/, UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (ok, code) => { if (!ok) fail(code); };
const plain = v => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const exact = (v, keys) => plain(v) && Object.keys(v).sort().join('|') === [...keys].sort().join('|');
export const hash = v => createHash('sha256').update(typeof v === 'string' || Buffer.isBuffer(v) ? v : canonical(v)).digest('hex');
const relative = p => typeof p === 'string' && !p.startsWith('/') && !/[\\:\x00-\x1f]/.test(p) && p.split('/').every(x => x && x !== '.' && x !== '..');
const noSecrets = v => { if (plain(v)) { check(!Object.keys(v).some(k => /private.?key|token$|password|secret|ciTokenSha256/i.test(k)), 'PRIVATE_OR_LEGACY_INPUT_REFUSED'); Object.values(v).forEach(noSecrets); } else if (Array.isArray(v)) v.forEach(noSecrets); };

// Node profile /1: the one host identity an install is pinned to (design §9 C1), carried whole as the record's
// acceptance.json `node`; nodeProfileSha256 = hash(profile) (SHA-256 of its canonical JSON). The elevated
// installers (install/verify/uninstall-resident.ps1), the controller read lease (hold-record.ps1, held-record.mjs)
// and the v2 entries' secret reads (entry-runtime.mjs) take the host identity from it. TURING's profile is
// independent-ci-resident-v1/config/node-profile.turing.json: exactly the values the Source carried before.
// Every rule is a shape rule except mutationMutex, which must be the v1 name derived from the host and the
// controller account's RID (TURING: Global\CluedControlControllerMutationV1-TURING-1015, the name the v1 elevated tool
// control-install-delta-v2/invoker/FixedScm.cs shares with the broker so the two exclude each other; a new node has no v1
// tool, so there the derived name only has to be one fixed name per host). install-resident.ps1#Assert-NodeProfile is
// the PowerShell twin; test/fixtures/node-profile-cases.json holds both to the same answers and refusal codes.
//   nodeName              lower-case node label (resident-queue/<nodeName> on the PR page, design §5.2)
//   hostname              NetBIOS computer name, upper-case (COMPUTERNAME, Environment.MachineName)
//   ownerSid              the Owner's account (companion, relay, incoming spool writer)
//   ownerProfileDirectory the Owner's profile directory (USERPROFILE of the WSL relay call)
//   controllerSid         .\clued-control (the generic helper, the v2 entries, the outgoing spool writer)
//   runnerService         the carrier runner service the broker swaps (never routed a workflow)
//   wslDistribution       the Owner's WSL distribution that holds the Linux half
export const NODE_PROFILE_CONTRACT = 'clued.independent-ci.node-profile/1';
export const NODE_PROFILE_KEYS = Object.freeze(['contract', 'nodeName', 'hostname', 'ownerSid', 'ownerProfileDirectory', 'controllerSid', 'runnerService', 'mutationMutex', 'wslDistribution']);
const USER_SID = /^S-1-5-21-\d{1,10}-\d{1,10}-\d{1,10}-(\d{1,10})$/;
export function validateNodeProfile(n) {
  check(exact(n, NODE_PROFILE_KEYS) && NODE_PROFILE_KEYS.every(k => typeof n[k] === 'string') && n.contract === NODE_PROFILE_CONTRACT, 'NODE_PROFILE_FIELDS_REQUIRED');
  const owner = USER_SID.exec(n.ownerSid), controller = USER_SID.exec(n.controllerSid);
  check(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(n.nodeName) && /^[A-Z0-9](?:[A-Z0-9-]{0,13}[A-Z0-9])?$/.test(n.hostname)
    && owner && controller && n.ownerSid !== n.controllerSid && Number(controller[1]) >= 1000
    && /^C:\\Users\\[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/.test(n.ownerProfileDirectory)
    && /^actions\.runner\.tdoljyj-cross-memory-system\.clued-ci-[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(n.runnerService)
    && n.mutationMutex === `Global\\CluedControlControllerMutationV1-${n.hostname}-${controller[1]}`
    && /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/.test(n.wslDistribution), 'NODE_PROFILE_INVALID');
  return n;
}

function read(p, max = 16 * 1024 * 1024) {
  const st = fs.lstatSync(p);
  check(st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.size > 0 && st.size <= max, 'RECORD_SOURCE_FILE_BOUNDARY');
  const raw = fs.readFileSync(p), after = fs.lstatSync(p);
  check(st.ino === after.ino && st.size === after.size && st.mtimeMs === after.mtimeMs && raw.length === st.size, 'RECORD_SOURCE_FILE_CHANGED');
  return raw;
}

// Same role material rules as v1 prepare-payload.mjs#formalRoles (pinned images, fixed argv).
function validateRoles(roles) {
  check(exact(roles, ['gitleaks', 'trivy', 'contract-placement']), 'ACTUAL_THREE_FORMAL_ROLES_REQUIRED');
  const tool = x => exact(x, ['path', 'sha256']) && typeof x.path === 'string' && /^\/[A-Za-z0-9_./-]+$/.test(x.path) && !x.path.split('/').includes('..') && HASH.test(x.sha256);
  const cmd = (c, scanner, exe) => exact(c, ['image', 'scanner', 'executable', 'args', 'cwd']) && /@sha256:[a-f0-9]{64}$/.test(c.image) && c.scanner === scanner
    && c.executable === exe && c.cwd === '/input' && Array.isArray(c.args) && c.args.length > 0 && c.args.every(x => typeof x === 'string' && !/[\x00-\x1f]/.test(x));
  const { gitleaks: g, trivy: t, 'contract-placement': p } = roles;
  check(exact(g, ['containerCommand', 'hostTools', 'timeoutMs', 'maxOutputBytes']) && cmd(g.containerCommand, 'gitleaks', '/usr/bin/gitleaks')
    && exact(g.hostTools, ['python']) && tool(g.hostTools.python) && Number.isSafeInteger(g.timeoutMs) && Number.isSafeInteger(g.maxOutputBytes), 'ACTUAL_FIXED_GITLEAKS_MATERIAL_REQUIRED');
  check(exact(t, ['containerCommand', 'formalTrivy', 'timeoutMs', 'maxOutputBytes']) && cmd(t.containerCommand, 'trivy', '/usr/local/bin/trivy')
    && t.formalTrivy?.profile === 'required-trivy-three-scanners/1' && /^\/[A-Za-z0-9_./-]+$/.test(t.formalTrivy.cacheRoot ?? '')
    && /^sha256:[a-f0-9]{64}$/.test(t.formalTrivy.checksPin?.digest ?? '') && HASH.test(t.formalTrivy.checksPin?.contentSha256 ?? ''), 'ACTUAL_FIXED_TRIVY_MATERIAL_REQUIRED');
  check(exact(p, ['command', 'formalContractPlacement', 'timeoutMs', 'maxOutputBytes']) && exact(p.command, ['executable', 'executableSha256', 'args', 'cwd'])
    && tool({ path: p.command.executable, sha256: p.command.executableSha256 }) && exact(p.formalContractPlacement, ['profile', 'workflowSha256', 'esbuildVersion', 'tools'])
    && p.formalContractPlacement.profile === 'required-contract-placement/1' && HASH.test(p.formalContractPlacement.workflowSha256)
    && exact(p.formalContractPlacement.tools, ['node', 'python', 'git', 'esbuildJs', 'esbuildBinary']) && Object.values(p.formalContractPlacement.tools).every(tool), 'ACTUAL_FIXED_PLACEMENT_MATERIAL_REQUIRED');
  return roles;
}

export function validateRecordInputs(v, now = Date.now()) {
  noSecrets(v);
  check(exact(v, ['contract', 'repository', 'sourceCommit', 'scope', 'node', 'controllerAccount', 'appId', 'installationId', 'repositoryId', 'appKeyId',
    'ciPrincipalBindingId', 'ciPrincipalRoleRef', 'ciTokenPinSha256', 'appPublicKeySha256Base64', 'supabaseUrl', 'publishableKey', 'controllerNodeSha256',
    'references', 'owner', 'formalRoles', 'signers']), 'EXACT_RECORD_INPUT_FIELDS_REQUIRED');
  check(v.contract === RECORD_INPUTS_CONTRACT && v.repository === REPO && SHA.test(v.sourceCommit)
    && (v.scope === 'global' || /^project:[a-f0-9-]{36}$/.test(v.scope)), 'ACTUAL_REPOSITORY_SOURCE_SCOPE_REQUIRED');
  validateNodeProfile(v.node);
  check(v.controllerAccount === 'clued-control' && [v.appId, v.installationId, v.repositoryId, v.appKeyId].every(n => Number.isSafeInteger(n) && n > 0)
    && UUID.test(v.ciPrincipalBindingId) && UUID.test(v.ciPrincipalRoleRef) && HASH.test(v.ciTokenPinSha256) && /^[A-Za-z0-9+/]{43}=$/.test(v.appPublicKeySha256Base64)
    && /^https:\/\/[a-z0-9]+\.supabase\.co$/.test(v.supabaseUrl) && /^sb_publishable_[A-Za-z0-9_-]+$/.test(v.publishableKey) && HASH.test(v.controllerNodeSha256), 'EXISTING_PUBLIC_IDENTITY_REQUIRED');
  check(exact(v.references, REFS) && REFS.every(k => UUID.test(v.references[k] ?? '') && !/^0{8}-/.test(v.references[k])), 'GENUINE_FORMAL_REFERENCES_REQUIRED');
  const o = v.owner;
  check(exact(o, ['ownerDecisionRef', 'ownerReceiptRef', 'acceptedAt', 'validUntil']) && UUID.test(o.ownerDecisionRef) && UUID.test(o.ownerReceiptRef)
    && o.ownerDecisionRef !== o.ownerReceiptRef && ISO.test(o.acceptedAt) && Date.parse(o.acceptedAt) <= now
    && (o.validUntil === null || (ISO.test(o.validUntil) && Date.parse(o.validUntil) > now && Date.parse(o.validUntil) > Date.parse(o.acceptedAt))), 'SOURCE_ACCEPTANCE_WINDOW_REQUIRED');
  validateRoles(v.formalRoles);
  check(plain(v.signers) && Array.isArray(v.signers.signers) && v.signers.signers.length > 0, 'ACTUAL_EXISTING_PUBLIC_SIGNER_FILE_REQUIRED');
  return v;
}

export function readClosure(sourceRoot, closure) {
  check(Array.isArray(closure) && closure.length >= 10 && closure.length <= 10000 && new Set(closure).size === closure.length && closure.every(relative), 'EXACT_SOURCE_CLOSURE_REQUIRED');
  return [...closure].sort().map(p => { const b = read(path.join(sourceRoot, ...p.split('/'))); return { path: p, sha256: hash(b), bytes: b.length }; });
}

// Pure assembly of the four record files from validated inputs and the hashed Source closure.
export function assembleRecord(inputs, sourceFiles) {
  const pins = sourceFiles.map(x => ({ path: x.path, sha256: x.sha256 }));
  const pin = p => { const f = pins.find(x => x.path === p); check(f, 'ACCEPTED_SOURCE_CLOSURE_MISSING'); return f.sha256; };
  const relay = { contract: 'clued.independent-ci.protected-os-relay/2', mode: 'resident-companion-file-transfer',
    windowsRoot: 'C:\\ProgramData\\CluedIndependentCI\\formal-spool', linuxRoot: '/var/lib/clued-independent-ci/formal-spool',
    linuxWriterUid: 0, ownerBoundary: 'owner-wsl-administrator', sourceAcceptanceRef: inputs.references.sourceAcceptanceRef, hostQualificationRef: inputs.references.hostQualificationRef };
  const manifest = { schema: SOURCES_SCHEMA_V2, repo: inputs.repository, sourceSha: inputs.sourceCommit,
    roles: Object.fromEntries(Object.keys(CHECKS_V2).map(role => [role, { ...(inputs.formalRoles[role] ?? {}), sourceFiles: pins, controllerRelay: relay }])) };
  const manifestText = canonical(manifest);
  const config = { contract: INSTALLATION_CONTRACT_V2, enabled: true, repository: inputs.repository, repositoryId: inputs.repositoryId, appId: inputs.appId,
    installationId: inputs.installationId, appKeyId: inputs.appKeyId, appPublicKeySha256Base64: inputs.appPublicKeySha256Base64, scope: inputs.scope,
    ciPrincipalBindingId: inputs.ciPrincipalBindingId, ciPrincipalQualificationRef: inputs.references.ciPrincipalQualificationRef, ciPrincipalRoleRef: inputs.ciPrincipalRoleRef,
    ciTokenPinSha256: inputs.ciTokenPinSha256, supabaseUrl: inputs.supabaseUrl, publishableKey: inputs.publishableKey,
    evaluatorSha256: pin('scripts/ci/clued-work-admission.mjs'), policySha256: pin('config/merge-admission-policy.json'),
    controllerNodeSha256: inputs.controllerNodeSha256, acceptanceSha256: null, sourceManifestSha256: hash(manifestText), checks: CHECKS_V2 };
  const signersText = canonical(inputs.signers);
  const accepted = { contract: ACCEPTANCE_CONTRACT_V2, domain: 'production', accepted: true, repository: inputs.repository, hostname: inputs.node.hostname,
    node: inputs.node, platform: 'win32', arch: 'x64', controllerAccount: inputs.controllerAccount, workerCannotReadController: true, ...inputs.references,
    ciPrincipalBindingId: inputs.ciPrincipalBindingId, ciTokenPinSha256: inputs.ciTokenPinSha256, appPublicKeySha256Base64: inputs.appPublicKeySha256Base64,
    sourceFiles: pins, signerRegistrySha256: hash(inputs.signers), ownerDecisionRef: inputs.owner.ownerDecisionRef, ownerReceiptRef: inputs.owner.ownerReceiptRef,
    acceptedAt: inputs.owner.acceptedAt, validUntil: inputs.owner.validUntil, claimBound: false, configSha256: hash({ ...config, acceptanceSha256: null }) };
  const acceptanceText = canonical(accepted);
  config.acceptanceSha256 = hash(acceptanceText);
  const installationText = canonical(config);
  const files = { 'installation.json': installationText, 'acceptance.json': acceptanceText, 'source-manifest.json': manifestText, 'signers.json': signersText };
  const recordManifest = { contract: RECORD_MANIFEST_CONTRACT, files: Object.fromEntries(Object.entries(files).map(([n, t]) => [n, { bytes: Buffer.byteLength(t), sha256: hash(t) }])),
    sourceManifestSha256: config.sourceManifestSha256, acceptanceSha256: config.acceptanceSha256, installationSha256: hash(installationText),
    runtimeConfigPinSha256: accepted.configSha256, controllerNodeSha256: inputs.controllerNodeSha256, nodeProfileSha256: hash(inputs.node), validUntil: accepted.validUntil, claimBound: false };
  return { files, recordManifest };
}

export function writeRecord(out, { files, recordManifest }) {
  check(!fs.existsSync(out), 'RECORD_OUTPUT_EXISTS_PRESERVE_NO_RETRY');
  fs.mkdirSync(out);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(out, name), text, { flag: 'wx' });
  fs.writeFileSync(path.join(out, 'record-manifest.json'), canonical(recordManifest), { flag: 'wx' });
  return { status: 'RESIDENT_RECORD_PREPARED', recordManifestSha256: hash(canonical(recordManifest)), ...recordManifest };
}

async function main(argv = process.argv.slice(2)) {
  const args = Object.fromEntries(argv.reduce((acc, v, i, a) => (v.startsWith('--') ? [...acc, [v.slice(2), a[i + 1]]] : acc), []));
  check(args.inputs && args['source-root'] && args.closure && args.out, 'FIXED_RECORD_ARGUMENTS_REQUIRED');
  const inputs = validateRecordInputs(JSON.parse(read(args.inputs).toString('utf8')));
  const closure = JSON.parse(read(args.closure).toString('utf8'));
  check(exact(closure, ['contract', 'paths']) && closure.contract === 'clued.independent-ci.source-closure/2', 'EXACT_SOURCE_CLOSURE_REQUIRED');
  const sourceFiles = readClosure(args['source-root'], closure.paths);
  console.log(JSON.stringify(writeRecord(args.out, assembleRecord(inputs, sourceFiles))));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(e => { console.error(/^[A-Z][A-Z0-9_]{1,79}$/.test(e.code ?? '') ? e.code : 'RECORD_PREPARATION_UNCONFIRMED'); process.exitCode = 2; });
}
