// JavaScript ports of the Python steps of rollout/build-upgrade.ps1 that the node-side assembler needs (Decision b5d041d2 v2: the
// node's companion account has no Python). Each one keeps the original's inputs, checks, refusal codes and output bytes; the
// differential tests (test/ports.test.mjs) run the original next to the port on the same fixtures and compare byte for byte.
//   recordInputs        reinstall/tools/record-inputs.py without --ref (Decision b1dd8a84: the installed references are carried)
//   nodeInputs          reinstall/tools/node-inputs.py#derive and its output bytes
//   linuxPins           reinstall/tools/linux-pins.py pins            linuxPinsCheck   linux-pins.py check
//   deriveRole          linux/bin/clued-ci-upgrade-linux#derive_role (frozen; the Linux stage recomputes it: ROLES_DERIVED_MISMATCH)
//   canonicalBytes      the same tool's canonical_bytes
//   rolesDerived        rollout/tools/roles-derived.py with the companion's roles-public.json copy (no configured-directory fallback:
//                       a node has no root export; a missing or other-generation copy is refused with the notice's code)
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PyFloat, pyCanonical, pyCopy, pyDumps, pyEqual, pyLoads } from './pyjson.mjs';

const sha = b => createHash('sha256').update(b).digest('hex');
export class Refused extends Error {
  constructor(code, detail = {}) { super(code); this.code = code; this.detail = detail; }
}
const need = (ok, code, detail) => { if (!ok) throw new Refused(code, detail); };
const isDict = v => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof PyFloat);
const get = (d, k, dflt = null) => (isDict(d) && Object.hasOwn(d, k) ? d[k] : dflt);
const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

// ---------------------------------------------------------------- record-inputs.py
export const RECORD_REFS = Object.freeze(['sourceAcceptanceRef', 'hostQualificationRef', 'ownerAuthorizationRef', 'publisherQualificationRef', 'ciPrincipalQualificationRef',
  'ownerPackageAcceptanceRef', 'installationReceiptRef']);
export const RECORD_FILES = Object.freeze(['record-manifest.json', 'installation.json', 'acceptance.json', 'source-manifest.json', 'signers.json']);
const FORMAL_ROLES = Object.freeze(['gitleaks', 'trivy', 'contract-placement']);
const BASE_VALUE_KEYS = Object.freeze(['appKeyId', 'appPublicKeySha256Base64', 'ciPrincipalBindingId', 'ciPrincipalRoleRef', 'ciTokenPinSha256', 'controllerNodeSha256']);

// The node profile: always the installed one, the installed (base) package's verified record (readBaseRecord). No caller names a node or
// a profile file: the repository carries none (rconfig.node_profile is the same rule).
export function installedNodeProfile(base, distribution) {
  const prof = base.acc.node;
  need(get(prof, 'contract') === 'clued.independent-ci.node-profile/1', 'INSTALLED_NODE_PROFILE_MISSING');
  need(get(prof, 'wslDistribution') === distribution, 'CONFIG_DISTRIBUTION_NOT_THE_PROFILES', { wslDistribution: get(prof, 'wslDistribution') });
  return { profile: prof, profileSha256: sha(Buffer.from(pyCanonical(prof), 'utf8')) };
}

// The installed (base) package's record, every file checked against the package manifest and the record manifest.
export function readBaseRecord(basePackage) {
  const pkgRaw = fs.readFileSync(path.join(basePackage, 'package-manifest.json'));
  const pins = new Map(pyLoads(pkgRaw.toString('utf8')).files.map(f => [f.target, f.sha256]));
  const raw = Object.fromEntries(RECORD_FILES.map(n => [n, fs.readFileSync(path.join(basePackage, 'record', n))]));
  for (const n of RECORD_FILES) need(sha(raw[n]) === pins.get('record\\' + n), 'BASE_RECORD_FILE_NOT_ITS_PACKAGE', { file: n });
  const rm = pyLoads(raw['record-manifest.json'].toString('utf8'));
  for (const [n, e] of Object.entries(rm.files)) need(Object.hasOwn(raw, n) && sha(raw[n]) === get(e, 'sha256'), 'BASE_RECORD_FILE_CHANGED', { file: n });
  const [inst, acc, man, signers] = ['installation.json', 'acceptance.json', 'source-manifest.json', 'signers.json'].map(n => pyLoads(raw[n].toString('utf8')));
  need(signers.signers.every(s => !Object.hasOwn(s, 'privateKey') && s.publicKeyPem.includes('BEGIN PUBLIC KEY') && !s.publicKeyPem.includes('PRIVATE')), 'SIGNERS_NOT_PUBLIC');
  return { pkgRaw, raw, recordManifest: rm, inst, acc, man, signers };
}

// The fleet-wide part of a record (what record-inputs takes from the base record into the CI Source manifest): the formal role
// material and the two references every role's controllerRelay names.
export function fleetRecordOf(base) {
  const formalRoles = Object.fromEntries(FORMAL_ROLES.map(r => [r, Object.fromEntries(Object.entries(base.man.roles[r]).filter(([k]) => k !== 'sourceFiles' && k !== 'controllerRelay'))]));
  return { sourceAcceptanceRef: base.acc.sourceAcceptanceRef, hostQualificationRef: base.acc.hostQualificationRef, formalRoles };
}

export function recordInputs({ basePackage, commit, distribution, nodeRecord = {}, signer = null }) {
  need(/^[0-9a-f]{40}$/.test(commit ?? ''), 'COMMIT_MUST_BE_40_HEX');
  const base = readBaseRecord(basePackage);
  const { inst, acc } = base;
  const signers = pyCopy(base.signers);
  const { profile, profileSha256 } = installedNodeProfile(base, distribution);
  const roles = fleetRecordOf(base).formalRoles;
  const refs = Object.fromEntries(RECORD_REFS.map(k => [k, acc[k]]));
  const owner = { ownerDecisionRef: acc.ownerDecisionRef, ownerReceiptRef: acc.ownerReceiptRef, acceptedAt: acc.acceptedAt, validUntil: acc.validUntil };
  for (const s of signers.signers) {
    need(s.sourceAcceptanceRef === acc.sourceAcceptanceRef && s.qualificationRef === acc.hostQualificationRef, 'BASE_SIGNER_NOT_BOUND_TO_BASE_RECORD');
    s.sourceAcceptanceRef = refs.sourceAcceptanceRef;
    s.qualificationRef = refs.hostQualificationRef;
  }
  if (signer) signers.signers = [{ domain: 'production', keyId: signer.keyId, publicKeyPem: signer.publicKeyPem, qualificationRef: refs.hostQualificationRef,
    runtimeId: signer.runtimeId, sourceAcceptanceRef: refs.sourceAcceptanceRef }];
  const baseValues = Object.fromEntries(BASE_VALUE_KEYS.map(k => [k, inst[k]]));
  const v = { ...baseValues, ...nodeRecord };
  const inputs = {
    contract: 'clued.independent-ci.resident-record-inputs/2', repository: inst.repository, sourceCommit: commit, scope: inst.scope,
    node: profile, controllerAccount: acc.controllerAccount,
    appId: inst.appId, installationId: inst.installationId, repositoryId: inst.repositoryId, appKeyId: v.appKeyId,
    ciPrincipalBindingId: v.ciPrincipalBindingId, ciPrincipalRoleRef: v.ciPrincipalRoleRef, ciTokenPinSha256: v.ciTokenPinSha256,
    appPublicKeySha256Base64: v.appPublicKeySha256Base64, supabaseUrl: inst.supabaseUrl, publishableKey: inst.publishableKey,
    controllerNodeSha256: v.controllerNodeSha256, references: refs, owner, formalRoles: roles, signers,
  };
  return { inputs, bytes: Buffer.from(pyCanonical(inputs) + '\n', 'utf8'), profile, profileSha256, base };
}

// ---------------------------------------------------------------- node-inputs.py
const PROFILE_TEXT = Object.freeze(['hostname', 'nodeName', 'ownerSid', 'controllerSid', 'ownerProfileDirectory', 'runnerService', 'mutationMutex', 'wslDistribution']);

export function nodeInputs({ policy, companion, profile, profileSha256, decision, receipt }) {
  need(UUID.test(decision ?? '') && UUID.test(receipt ?? ''), 'REFS_SHAPE');
  const base = get(policy, 'node');
  need(isDict(base) && pyEqual(get(get(companion, 'companion', {}), 'node'), base), 'BASE_INPUTS_NOT_ONE_NODE');
  need(pyEqual(get(get(policy, 'companion', {}), 'userSid'), get(base, 'ownerSid')), 'BASE_POLICY_USER_SID_NOT_ITS_OWNER');
  const pd = get(get(policy, 'linux', {}), 'distribution'), bd = get(base, 'wslDistribution'), cd = get(companion.companion, 'distribution');
  need(pyEqual(pd, bd) && pyEqual(bd, cd), 'BASE_DISTRIBUTION_NOT_ITS_NODES');
  const p = pyCopy(policy), c = pyCopy(companion);
  p.node = profile; p.nodeProfileSha256 = profileSha256;
  p.companion.userSid = profile.ownerSid; p.linux.distribution = profile.wslDistribution;
  p.ownerAcceptance = { decisionRef: decision, installReceiptRef: receipt };
  c.companion.node = profile; c.companion.nodeProfileSha256 = profileSha256; c.companion.distribution = profile.wslDistribution;
  if (isDict(c.status) && Object.hasOwn(c.status, 'node')) c.status.node = profile.nodeName;
  const stale = PROFILE_TEXT.filter(k => typeof base[k] === 'string' && !pyEqual(base[k], get(profile, k))).map(k => base[k]);
  for (const doc of [p, c]) {
    const text = pyCanonical(doc);
    const left = stale.filter(v => text.includes(v) || text.includes(pyDumps(v).slice(1, -1)));
    need(left.length === 0, 'NODE_INPUT_KEEPS_THE_BASE_NODE', { left });
  }
  const out = d => Buffer.from(pyDumps(d, { sortKeys: true, separators: [',', ':'] }), 'utf8');
  return { policy: p, companion: c, policyBytes: out(p), companionBytes: out(c) };
}

// ---------------------------------------------------------------- linux-pins.py
const SV2 = '/opt/clued-independent-ci/source-v2/';
const TOOLCHAIN_NODE = '/var/lib/clued-independent-ci/toolchain-build-legacy-v1/node';

function loadLinuxManifest(bytes) {
  const m = pyLoads(bytes.toString('utf8'));
  need(get(m, 'contract') === 'clued.independent-ci.resident-linux-manifest/2' && Object.keys(m).sort().join('|') === 'contract|files', 'MANIFEST_SHAPE');
  need(m.files.every(f => isDict(f) && Object.keys(f).sort().join('|') === 'installedPath|sha256' && typeof f.sha256 === 'string' && HEX64.test(f.sha256)), 'ENTRY_SHAPE');
  return m;
}

function treeSha(readTreeFile, installedPath) {
  const rel = installedPath.slice(SV2.length);
  need(rel && !rel.split('/').includes('..') && !rel.startsWith('/'), 'SOURCE_V2_PATH', { installedPath });
  return sha(readTreeFile(rel));
}

function expectedPins(inst, readTreeFile, node) {
  const pin = f => (f.installedPath.startsWith(SV2) ? treeSha(readTreeFile, f.installedPath) : node && f.installedPath === TOOLCHAIN_NODE ? node : f.sha256);
  return inst.files.slice(4).map(f => ({ installedPath: f.installedPath, sha256: pin(f) }));
}

// readTreeFile(rel) -> Buffer of the commit's file (throws when missing, as Python's open does).
export function linuxPins({ installedManifest, buildPackageText, readTreeFile, toolchainNode = null }) {
  const inst = loadLinuxManifest(installedManifest);
  const block = buildPackageText.split('const LINUX_FILES = [')[1]?.split('];')[0] ?? '';
  const own = [...block.matchAll(/\['(?:bin|systemd)\/[^']+', '(\/[^']+)'\]/g)].map(m => m[1]);
  need(own.length === 4 && inst.files.slice(0, 4).map(f => f.installedPath).join('\n') === own.join('\n'), 'INSTALLED_ORDER_IS_NOT_PACKAGE_FILES_FIRST', { own });
  need(toolchainNode === null || /^[0-9a-f]{64}$/.test(toolchainNode), 'TOOLCHAIN_NODE_ARGUMENT');
  need(toolchainNode === null || inst.files.slice(4).some(f => f.installedPath === TOOLCHAIN_NODE), 'TOOLCHAIN_NODE_NOT_IN_INSTALLED_MANIFEST');
  const pins = expectedPins(inst, readTreeFile, toolchainNode);
  need(pins.every(p => p.installedPath.startsWith('/') && !p.installedPath.split('/').includes('..')), 'PIN_PATH');
  return { pins, bytes: Buffer.from(pyDumps(pins, { indent: 2 }) + '\n', 'utf8'),
    changedFromInstalled: pins.filter((p, k) => p.sha256 !== inst.files[4 + k].sha256).map(p => p.installedPath) };
}

export function linuxPinsCheck({ packageManifest, installedManifest, readTreeFile, toolchainNode = null }) {
  const a = loadLinuxManifest(packageManifest), b = loadLinuxManifest(installedManifest);
  need(a.files.length === b.files.length && a.files.every((f, k) => f.installedPath === b.files[k].installedPath), 'LINUX_MANIFEST_NOT_THE_INSTALLED_SHAPE');
  need(pyEqual(a.files.slice(4), expectedPins(b, readTreeFile, toolchainNode)), 'LINUX_EXTERNAL_PINS_NOT_THE_NEW_SOURCE');
  return { linuxOwnFilesChanged: a.files.slice(0, 4).filter((f, k) => f.sha256 !== b.files[k].sha256).map(f => f.installedPath),
    externalPinsChanged: a.files.slice(4).filter((f, k) => f.sha256 !== b.files[4 + k].sha256).map(f => f.installedPath), externalPins: a.files.length - 4 };
}

// ---------------------------------------------------------------- clued-ci-upgrade-linux (frozen) and roles-derived.py
export const TOOL_PATH = 'work/independent-ci-resident-v1/linux/bin/clued-ci-upgrade-linux';
const CI = 'work/actions-hosted-migration/independent-ci-v1/';
export const SOURCE_KEYS = Object.freeze(['sourceManifestSha256', 'entrySha256', 'qualificationSha256', 'workerSha256', 'proofSha256', 'jobSha256', 'sourceAcceptanceRef']);
export const PIN_FILES = Object.freeze({ qualificationSha256: CI + 'worker/qualification-v2.mjs', workerSha256: CI + 'src/worker-v2.mjs',
  proofSha256: CI + 'src/proof.mjs', jobSha256: CI + 'src/job-v2.mjs' });
export const BIND = Object.freeze(['runtimeIdentity', 'sourceManifestSha256', 'image', 'entrySha256', 'qualificationSha256', 'executionMode', 'workerSha256', 'proofSha256',
  'jobSha256', 'nodeExecutable', 'keyId', 'hostAcceptanceRef', 'sourceAcceptanceRef']);
export const TRUSTED_SOURCE = '/opt/clued-independent-ci/source-v2';
const SAFE = /^[A-Za-z0-9_.@+-]+(\/[A-Za-z0-9_.@+-]+)*$/;
const TOOL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const canonicalBytes = v => Buffer.from(pyCanonical(v) + '\n', 'utf8');

export function safeRel(rel) {
  need(typeof rel === 'string' && rel.length <= 400 && SAFE.test(rel) && !rel.split('/').includes('..') && !rel.startsWith('/'), 'TARGET_OUTSIDE_WHITELIST', { path: String(rel).slice(0, 200) });
  return rel;
}

export function deriveRole(role, policy, payload, newManifestSha, newManifest, fileSha) {
  need(isDict(policy) && get(policy, 'schema') === 'independent-ci.linux-policy.v3' && get(policy, 'role') === role && get(policy, 'formalEnabled') === true
    && !Object.hasOwn(policy, 'currentClaim') && !Object.hasOwn(policy, 'claimId'), 'INSTALLED_POLICY_REFUSED', { role });
  need(isDict(payload) && get(payload, 'schema') === 'independent-ci.runtime-qualification.v2' && get(payload, 'role') === role
    && get(payload, 'fixture') === false && !Object.hasOwn(payload, 'currentClaim'), 'INSTALLED_QUALIFICATION_REFUSED', { role });
  need(BIND.every(k => pyEqual(get(payload, k), get(policy, k))), 'INSTALLED_PAYLOAD_NOT_ITS_POLICY', { role });
  const trusted = TRUSTED_SOURCE + '/';
  need(typeof get(policy, 'entryFile') === 'string' && policy.entryFile.startsWith(trusted), 'ENTRY_OUTSIDE_TRUSTED', { role });
  const roles = isDict(newManifest) ? get(newManifest, 'roles') : null;
  const entry = isDict(roles) ? get(roles, role) : null;
  const relay = isDict(entry) ? get(entry, 'controllerRelay') : null;
  need(isDict(relay) && typeof get(relay, 'sourceAcceptanceRef') === 'string' && TOOL_UUID.test(relay.sourceAcceptanceRef), 'NEW_SOURCE_ACCEPTANCE_REQUIRED', { role });
  need(pyEqual(get(relay, 'hostQualificationRef'), get(policy, 'hostAcceptanceRef')), 'LINUX_HOST_FACTS_CHANGED', { role, field: 'hostAcceptanceRef' });
  const values = { sourceManifestSha256: newManifestSha, entrySha256: fileSha(policy.entryFile.slice(trusted.length)), sourceAcceptanceRef: relay.sourceAcceptanceRef };
  for (const [k, rel] of Object.entries(PIN_FILES)) values[k] = fileSha(rel);
  const newPolicy = { ...policy }, newPayload = { ...payload };
  for (const k of SOURCE_KEYS) { newPolicy[k] = values[k]; newPayload[k] = values[k]; }
  newPayload.qualifiedAt = null;
  const changed = Object.keys(policy).filter(k => !pyEqual(policy[k], newPolicy[k])).sort();
  need(changed.every(k => SOURCE_KEYS.includes(k)) && Object.keys(newPolicy).length === Object.keys(policy).length, 'POLICY_DIFF_OUTSIDE_SOURCE_BINDING', { role });
  return [newPolicy, newPayload];
}

const ROLES_PUBLIC_CONTRACT = 'clued.independent-ci.linux-roles-public/1';
const ROLES_PUBLIC_NAMES = Object.freeze(FORMAL_ROLES.flatMap(r => [`${r}.json`, `${r}.qualification.json`]));
const ROLES_PUBLIC_MAX_BYTES = 192 * 1024;
const ROLES_PUBLIC_FILE_MAX_BYTES = 16 * 1024;
const FACTS_MAX_AGE_MS = 3_600_000;
const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ISO_TZ = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/;
const isInt = v => typeof v === 'number' && Number.isSafeInteger(v);

// The companion's copy (roles-public.json next to the version facts): { name: bytes } for the facts' generation; absent or another
// generation is refused here (the Python tool fell back to a root export the node does not have).
export function companionCopy(rolesPublic, generation) {
  need(rolesPublic !== null, 'ROLES_PUBLIC_COPY_MISSING');
  let doc;
  try {
    if (!(rolesPublic.length > 0 && rolesPublic.length <= ROLES_PUBLIC_MAX_BYTES)) throw new Error('size');
    doc = pyLoads(new TextDecoder('utf-8', { fatal: true }).decode(rolesPublic));
    if (!isDict(doc) || Object.keys(doc).sort().join('|') !== 'contract|factsObservedAt|files|generation|observedAt' || doc.contract !== ROLES_PUBLIC_CONTRACT
      || !isInt(doc.generation) || !isDict(doc.files) || Object.keys(doc.files).sort().join('|') !== [...ROLES_PUBLIC_NAMES].sort().join('|')) throw new Error('shape');
  } catch (e) {
    if (e instanceof Refused) throw e;
    throw new Refused('ROLES_PUBLIC_COPY_REFUSED');
  }
  need(isInt(generation) && doc.generation === generation, 'ROLES_PUBLIC_COPY_OTHER_GENERATION', { copyGeneration: doc.generation, factsGeneration: generation });
  const files = {};
  for (const name of ROLES_PUBLIC_NAMES) {
    const entry = doc.files[name];
    need(isDict(entry) && Object.keys(entry).sort().join('|') === 'base64|sha256' && typeof entry.sha256 === 'string' && HEX64.test(entry.sha256)
      && typeof entry.base64 === 'string' && B64.test(entry.base64), 'ROLES_PUBLIC_COPY_REFUSED', { file: name });
    const data = Buffer.from(entry.base64, 'base64');
    need(data.length > 0 && data.length <= ROLES_PUBLIC_FILE_MAX_BYTES && sha(data) === entry.sha256, 'ROLES_PUBLIC_COPY_REFUSED', { file: name });
    files[name] = data;
  }
  return files;
}

// readSourceFile(rel) -> Buffer | null: the commit's file (a regular file; null when the commit has none at that path).
export function rolesDerived({ toolBytes, readSourceFile, manifestBytes, ciSha, factsBytes, rolesPublic, now = Date.now() }) {
  need(HEX64.test(ciSha ?? ''), 'USAGE');
  let facts;
  try { facts = pyLoads(new TextDecoder('utf-8', { fatal: true }).decode(factsBytes)); } catch { throw new Refused('LINUX_VERSION_FACTS_REFUSED'); }
  need(isDict(facts) && get(facts, 'contract') === 'clued.independent-ci.linux-version-facts/1' && isDict(get(facts, 'roles')), 'LINUX_VERSION_FACTS_REFUSED');
  need(typeof facts.observedAt === 'string' && ISO_TZ.test(facts.observedAt) && Number.isFinite(Date.parse(facts.observedAt)), 'LINUX_VERSION_FACTS_REFUSED');
  need(Math.abs(now - Date.parse(facts.observedAt)) <= FACTS_MAX_AGE_MS, 'LINUX_VERSION_FACTS_NOT_FRESH', { observedAt: facts.observedAt });
  const toolSha = sha(toolBytes);
  need(toolSha === get(facts, 'upgradeToolSha256'), 'LINUX_UPGRADE_TOOL_IS_NOT_THE_INSTALLED_ONE', { tree: toolSha, installed: get(facts, 'upgradeToolSha256') });
  need(sha(manifestBytes) === ciSha, 'NEW_SOURCE_MANIFEST_IS_NOT_THE_PACKAGES');
  const newManifest = pyLoads(manifestBytes.toString('utf8'));
  const fileSha = rel => {
    safeRel(rel);
    const b = readSourceFile(rel);
    need(b !== null, 'PINNED_FILE_MISSING_IN_NEW_COMMIT', { path: rel });
    need(b.length > 0, 'PINNED_FILE_EMPTY', { path: rel });
    return sha(b);
  };
  const copy = companionCopy(rolesPublic, get(facts, 'generation'));
  const out = {};
  for (const role of FORMAL_ROLES) {
    const r = isDict(facts.roles[role]) ? facts.roles[role] : {};
    const polBytes = copy[`${role}.json`];
    need(sha(polBytes) === get(r, 'policySha256'), 'INSTALLED_ROLES_COPY_NOT_CURRENT', { role });
    const qBytes = copy[`${role}.qualification.json`];
    need(sha(qBytes) === get(r, 'qualificationSha256'), 'INSTALLED_ROLES_COPY_NOT_CURRENT', { role, file: 'qualification' });
    const q = pyLoads(qBytes.toString('utf8'));
    need(isDict(q) && Object.keys(q).sort().join('|') === 'payload|signature', 'INSTALLED_QUALIFICATION_REFUSED', { role });
    const [newPolicy] = deriveRole(role, pyLoads(polBytes.toString('utf8')), q.payload, ciSha, newManifest, fileSha);
    out[role] = sha(canonicalBytes(newPolicy));
  }
  return { status: 'ROLES_DERIVED', rolesDerivedSha256: out, upgradeToolSha256: toolSha, copySource: 'companion' };
}
