// The node side of a universal-package REINSTALL (rollout/fleet/BATCH1-INTERFACES.md section 3): from one accepted universal package and
// the Owner's acceptance file, and from nothing but what is installed on this node, the node's fresh-install /4 package, the Linux A/B
// inputs, the Linux root scripts and the elevated launcher. No per-node configuration file: every node value is read from the installed
// record and state (read-only); every value that must be equal on every node (fleetRefs) comes from the acceptance file.
// NON-elevated, Owner session; writes only under a new work directory; no WSL, no network.
//
//   node <unpacked>/tree/work/independent-ci-resident-v1/rollout/fleet/install.mjs prepare
//        --artifact <fleet-node-<v>.tar> --artifact-sha <hex> --acceptance <fleet-node-<v>.acceptance.json>
//        --work <new dir>
//   node .../install.mjs fleet-refs        (read-only: the installed record's formal role material, for an acceptance file)
//   node .../install.mjs source-hash --artifact <tar> --artifact-sha <hex> --acceptance <draft>
//                                           (read-only, any machine: the acceptance file's ciSourceManifestSha256, sourceHashOf)
// The command is the same on every node (section 8): no node-specific argument; the root is always C:\ProgramData\CluedIndependentCI\resident.
//
// prepare (BATCH1-INTERFACES.md sections 3, 7 and 8):
//   1. the acceptance (contract clued.independent-ci.fleet-node-acceptance/1, fleetRefs: FLEET_REF_KEYS + formalRoles); the archive's
//      sha256 is --artifact-sha and the acceptance's archive_sha256; it is read strictly (tar.mjs) and every entry checked against
//      universal-manifest.json (version and commit the acceptance's) BEFORE anything is written; this file and the modules it imports must
//      be the archive's own bytes.
//   2. the node (readNode), read-only: install\install-receipt.json (none: NODE_HAS_NO_INSTALL_FIRST_INSTALL_PATH) and upgrade\current.json
//      (one generation), record\* (the receipt's and the record manifest's hashes), config\policy.json and config\companion.json (the
//      receipt's), runtime\node.exe (the record's controllerNodeSha256), install\companion-account.json and companion-wsl.json (a
//      companion-account node), the Linux version facts and roles-public.json copy (a settled generation, at most an hour old:
//      expectedInstalledLinux; each side is read from its own record and the two need not name the same package, DESIGN section 73),
//      a reinstall's W1 pause an earlier stopped launch left (installedW1Reason), the installed tokens from the receipt
//      (installedSecretsOf: target, fingerprint, binding id; INSTALLED_UPGRADE_TOKEN_UNKNOWN / INSTALLED_HEARTBEAT_TOKEN_UNKNOWN; never
//      opened: the launcher carries them).
//   3. <work>\tree-<c8>\ (the archive's tree) and <work>\x\ (its bundle); inputs (<work>\inputs\): record inputs (the node's record values
//      + fleetRefs; the commit's prepare-record.mjs, check-record.mjs), policy/companion inputs (the installed ones, back to inputs;
//      ports.nodeInputs), the upgrader configuration (port of reinstall/tools/upgrader-config.py, validated by the tree's
//      validateUpgraderConfig), the Linux external pins (linuxExternalPins: the package's units' entry points, source-v2 entries of
//      the commit, the node's toolchain node), Source v2 (the archive's bundle, the three roles derived as
//      reinstall/linux/tools/derive-roles.py derives them), stateCompat (the archive's, else the installed one).
//   4. <work>\package\ (the archive's build-package.mjs --fresh-install, twice: the same sha; the universal values the archive's).
//   5. <work>\linux-in\ (port of reinstall/linux/assemble.py: the package's record, Linux files and upgrade tool, the tree's Linux scripts
//      and reviewed helper tools, src.git from the bundle); the scripts' output directory is a new C:\ProgramData\CluedIndependentCI\
//      reinstall-linux-out-<32hex> that the elevated launcher makes (and gives the companion account its rights): prepare changes no ACL.
//   6. <work>\inputs\reinstall-config.json: a clued.independent-ci.reinstall-config/1 synthesized from the node (reinstallConfigFor; no
//      hand-written per-node file), the installed copies it names under <work>\inputs\installed\, <work>\rehearsal\src-<c8>.git from the
//      bundle; then the package's reinstall/rehearse.py --file-locks-in-launcher --fleet (REHEARSAL_PASS or REHEARSAL_FAILED with its findings),
//      the package's reinstall/linux/prep.py in its --in-dir/--out-dir form (A.sh, B.sh, B-resume.sh in <work>\linux\), then W1: the
//      package's reinstall/tools/pause-old-resident.py (OLD_RESIDENT_PAUSED_NO_OPEN_BATCH; a reinstall's W1 pause already in force,
//      of this or an earlier package, is this launch's: confirmed at once; only after generate.py --fleet-plan --check passed), <work>\install-plan.json (w1Paused, launcher null), the package's
//      reinstall/launcher/generate.py --fleet-plan; then the plan once more with launcher filled (a record for people; the launcher pins
//      the plan as generate.py read it).
//   7. one JSON line { status, node, version, workDir, installPlan, launcher: { path, sha256 }, runCommand }.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { CLOSURE, PREPARE_RECORD, RESIDENT, universalFilesSha256 } from './facts.mjs';
import { PIN_FILES, RECORD_FILES, Refused, TRUSTED_SOURCE, companionCopy, nodeInputs, safeRel } from './ports.mjs';
import { pyCanonical, pyDumps, pyEqual, pyLoads } from './pyjson.mjs';
import { extractTar, readTar } from './tar.mjs';
import { BUNDLE_NAME, MANIFEST_NAME, UNIVERSAL_CONTRACT, VERSION, bundleHeads } from './universal.mjs';

export const ACCEPTANCE_CONTRACT = 'clued.independent-ci.fleet-node-acceptance/1';
export const PLAN_CONTRACT = 'clued.independent-ci.fleet-node-install-plan/1';
export const CONFIG_CONTRACT = 'clued.independent-ci.reinstall-config/1';
export const DEFAULT_ROOT = 'C:\\ProgramData\\CluedIndependentCI\\resident';
export const CI_ROOT = 'C:\\ProgramData\\CluedIndependentCI';   // where the launcher makes the Linux out directory (always the live one)
// fleetRefs (BATCH1-INTERFACES.md section 6): every acceptance reference of the record, the same on every node. sourceAcceptanceRef,
// hostQualificationRef and formalRoles enter source-manifest.json (ciSourceManifestSha256); the others enter acceptance.json / policy.
export const FLEET_REF_KEYS = Object.freeze(['sourceAcceptanceRef', 'hostQualificationRef', 'ownerAuthorizationRef', 'publisherQualificationRef',
  'ownerPackageAcceptanceRef', 'installationReceiptRef', 'ownerDecisionRef', 'ownerReceiptRef']);
export const FORMAL_ROLES = Object.freeze(['gitleaks', 'trivy', 'contract-placement']);
// The modules of this directory that run before the archive is extracted: they must be the archive's bytes.
export const OWN_MODULES = Object.freeze(['install.mjs', 'facts.mjs', 'ports.mjs', 'pyjson.mjs', 'tar.mjs', 'universal.mjs']);
export const LINUX_TIMEOUT_SECONDS = Object.freeze({ A: 1800, B: 7200 });
export const LINUX_SCRIPTS = Object.freeze({ A: 'A.sh', B: 'B.sh', BResume: 'B-resume.sh' });
const TOOLCHAIN_NODE = '/var/lib/clued-independent-ci/toolchain-build-legacy-v1/node';
const FACTS_MAX_AGE_MS = 3_600_000;
const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const ISO_Z = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/;
const USER_SID = /^S-1-5-21-\d{1,10}-\d{1,10}-\d{1,10}-\d{1,10}$/;
// paths that reach the root shell, cmd.exe and the elevated PowerShell (the registrar's WslPath rule, as prep.py checks it: letters,
// digits, '.', '_', '-' per part, no blank, no '.' or '..' part, no part ending in '.', which Windows would drop)
const WIN_PATH = /^[A-Za-z]:(?:\\(?!\.{1,2}(?:\\|$))[A-Za-z0-9._-]*[A-Za-z0-9_-])+$/;
// an installed token's target (the receipt's): the launcher copies it; rconfig's path shape, no blank or quote (Invoke-Child)
const TOKEN_PATH = WIN_PATH;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const sha = b => createHash('sha256').update(b).digest('hex');
const need = (ok, code, detail) => { if (!ok) throw new Refused(code, detail); };
const exact = (o, keys) => o !== null && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every(k => Object.hasOwn(o, k));
const jsonOf = b => JSON.parse(Buffer.from(b).toString('utf8').replace(/^\uFEFF/, ''));

// ---------------------------------------------------------------- the acceptance file
// The acceptance file (sections 2, 6): repository and ciSourceManifestSha256 are what the Owner accepts (the Source the train compares);
// `draft` (install.mjs source-hash) is the same file before its ciSourceManifestSha256 is known.
export const ACCEPTANCE_KEYS = Object.freeze(['contract', 'version', 'archive_sha256', 'commit', 'repository', 'ciSourceManifestSha256', 'cluedDecision', 'acceptedAt', 'fleetRefs']);
export function validateAcceptance(a, now = Date.now(), { draft = false } = {}) {
  const keys = draft ? ACCEPTANCE_KEYS.filter(k => k !== 'ciSourceManifestSha256' || Object.hasOwn(a ?? {}, k)) : ACCEPTANCE_KEYS;
  need(exact(a, keys) && a.contract === ACCEPTANCE_CONTRACT, 'FLEET_ACCEPTANCE_REFUSED', 'shape');
  need(VERSION.test(a.version ?? '') && HEX64.test(a.archive_sha256 ?? '') && /^[0-9a-f]{40}$/.test(a.commit ?? ''), 'FLEET_ACCEPTANCE_REFUSED', 'archive');
  need(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(a.repository ?? '') && (draft && a.ciSourceManifestSha256 === undefined || HEX64.test(a.ciSourceManifestSha256 ?? '')),
    'FLEET_ACCEPTANCE_REFUSED', 'source');
  need(typeof a.cluedDecision === 'string' && (/^[0-9a-f]{8}$/.test(a.cluedDecision) || UUID.test(a.cluedDecision)), 'FLEET_ACCEPTANCE_REFUSED', 'cluedDecision');
  need(typeof a.acceptedAt === 'string' && ISO_Z.test(a.acceptedAt) && Date.parse(a.acceptedAt) <= now, 'FLEET_ACCEPTANCE_REFUSED', 'acceptedAt');
  const f = a.fleetRefs;
  need(exact(f, [...FLEET_REF_KEYS, 'formalRoles']) && FLEET_REF_KEYS.every(k => UUID.test(f[k] ?? '') && !/^0{8}-/.test(f[k])), 'FLEET_ACCEPTANCE_REFUSED', 'fleetRefs');
  // the Decision the Owner named is the record's ownerDecisionRef; its receipt names the installation (reinstall/linux/prep.py: ownerReceiptRef ==
  // installationReceiptRef), and a decision is not its own receipt (prepare-record.mjs)
  need(a.cluedDecision.length === 8 ? f.ownerDecisionRef.startsWith(a.cluedDecision) : f.ownerDecisionRef === a.cluedDecision, 'FLEET_ACCEPTANCE_REFUSED', 'ownerDecisionRef is not cluedDecision');
  need(f.ownerReceiptRef === f.installationReceiptRef && f.ownerDecisionRef !== f.ownerReceiptRef, 'FLEET_ACCEPTANCE_REFUSED', 'receipt');
  need(exact(f.formalRoles, [...FORMAL_ROLES]), 'FLEET_ACCEPTANCE_REFUSED', 'formalRoles');
  return a;
}

// ---------------------------------------------------------------- stage 1: the archive
export function readArchive(bytes, artifactSha256, acceptance) {
  need(HEX64.test(artifactSha256 ?? '') && artifactSha256 === acceptance.archive_sha256, 'FLEET_ARTIFACT_SHA_NOT_THE_ACCEPTED');
  need(sha(bytes) === artifactSha256, 'FLEET_ARTIFACT_SHA_MISMATCH', { actual: sha(bytes) });
  const entries = readTar(bytes);
  const manifestEntry = entries.find(e => e.path === MANIFEST_NAME);
  need(manifestEntry, 'FLEET_ARCHIVE_REFUSED', 'no universal-manifest.json');
  const universal = JSON.parse(manifestEntry.data.toString('utf8'));
  need(universal?.contract === UNIVERSAL_CONTRACT && Array.isArray(universal.files), 'FLEET_ARCHIVE_REFUSED', 'contract');
  const listed = new Map(universal.files.map(f => [f.path, f]));
  need(listed.size === universal.files.length && listed.size === entries.length - 1, 'FLEET_ARCHIVE_NOT_ITS_MANIFEST', 'entries');
  for (const e of entries) {
    if (e.path === MANIFEST_NAME) continue;
    const f = listed.get(e.path);
    need(f && f.sha256 === sha(e.data) && f.bytes === e.data.length, 'FLEET_ARCHIVE_NOT_ITS_MANIFEST', e.path);
  }
  need(universal.version === acceptance.version && universal.commit === acceptance.commit, 'FLEET_ARCHIVE_NOT_THE_ACCEPTED', { version: universal.version, commit: universal.commit });
  return { entries, universal };
}

// ---------------------------------------------------------------- stage 2: the node, read-only
async function readOrNull(file) {
  try { return await fs.readFile(file); } catch (e) { if (e?.code === 'ENOENT') return null; throw e; }
}

export async function readNode({ root, now = Date.now() }) {
  const at = (...p) => path.join(root, ...p);
  const receiptBytes = await readOrNull(at('install', 'install-receipt.json'));
  need(receiptBytes !== null, 'NODE_HAS_NO_INSTALL_FIRST_INSTALL_PATH', 'no install\\install-receipt.json: a first install follows reinstall/README.md section 8c');
  const receipt = jsonOf(receiptBytes);
  const current = jsonOf(await fs.readFile(at('upgrade', 'current.json')));
  need(HEX64.test(current?.packageManifestSha256 ?? '') && current.packageManifestSha256 === receipt.packageManifestSha256 && current.installReceiptSha256 === sha(receiptBytes),
    'NODE_RECEIPT_NOT_THE_CURRENT_GENERATION');
  // the installed record: its manifest's hashes and the receipt's
  const raw = Object.fromEntries(await Promise.all(RECORD_FILES.map(async n => [n, await fs.readFile(at('record', n))])));
  const rm = jsonOf(raw['record-manifest.json']);
  for (const [n, e] of Object.entries(rm.files ?? {})) need(Object.hasOwn(raw, n) && sha(raw[n]) === e?.sha256, 'NODE_RECORD_FILE_CHANGED', n);
  need(sha(raw['acceptance.json']) === receipt.acceptanceSha256 && sha(raw['installation.json']) === receipt.installationSha256
    && sha(raw['source-manifest.json']) === current.ciSourceManifestSha256 && rm.sourceManifestSha256 === current.ciSourceManifestSha256, 'NODE_RECORD_NOT_THE_INSTALLED_GENERATION');
  const [acc, inst, man, signers] = ['acceptance.json', 'installation.json', 'source-manifest.json', 'signers.json'].map(n => jsonOf(raw[n]));
  const profile = acc.node;
  const profileSha256 = sha(Buffer.from(pyCanonical(profile), 'utf8'));
  need(profileSha256 === rm.nodeProfileSha256 && profileSha256 === receipt.nodeProfileSha256, 'NODE_PROFILE_NOT_THE_RECORDS');
  // the installed configuration
  const policyBytes = await fs.readFile(at('config', 'policy.json'));
  const companionBytes = await fs.readFile(at('config', 'companion.json'));
  need(sha(policyBytes) === receipt.policySha256 && sha(policyBytes) === current.policySha256, 'NODE_POLICY_NOT_THE_INSTALLED_ONE');
  need(receipt.companionConfigSha256 === undefined || sha(companionBytes) === receipt.companionConfigSha256, 'NODE_COMPANION_CONFIG_NOT_THE_INSTALLED_ONE');
  const policy = pyLoads(policyBytes.toString('utf8').replace(/^\uFEFF/, ''));
  const companion = pyLoads(companionBytes.toString('utf8').replace(/^\uFEFF/, ''));
  need(pyEqual(policy.node, pyLoads(pyCanonical(profile))), 'NODE_POLICY_NOT_THE_RECORDS_NODE');
  const nodeExe = at('runtime', 'node.exe');
  const nodeExeSha256 = sha(await fs.readFile(nodeExe));
  need(nodeExeSha256 === inst.controllerNodeSha256, 'NODE_RUNTIME_NOT_THE_RECORDS', { runtime: nodeExeSha256, record: inst.controllerNodeSha256 });
  // a companion-account node (M5-b): the companion runs as the profile's ownerSid; the Owner who clicks UAC is operatorSid
  const caBytes = await readOrNull(at('install', 'companion-account.json'));
  let companionAccount = null;
  if (caBytes !== null) {
    const ca = jsonOf(caBytes);
    need(ca?.contract === 'clued.independent-ci.companion-account/1' && ca.companionSid === profile.ownerSid && USER_SID.test(ca.companionSid ?? '')
      && USER_SID.test(ca.operatorSid ?? '') && ca.operatorSid !== ca.companionSid, 'NODE_COMPANION_ACCOUNT_REFUSED');
    // the resident distribution registered to that account: its ext4.vhdx directory (the configuration's companionAccount.wslVhdxDirectory)
    // the record is the node's own state: the live one, else the newest kept root's (a reinstall before the launcher carried it lost it;
    // the launcher carries it back from the same place: template.ps1 Step-CarryCompanionWslRecord)
    let cwBytes = await readOrNull(at('install', 'companion-wsl.json'));
    if (cwBytes === null) {
      const parent = path.dirname(root);
      // the kept roots: the parent's listing where this (non-elevated) process may list it, and those the installed backfill manifest names
      const named = ((await readOrNull(at('install', 'backfill-manifest.json')))?.toString('utf8').match(/resident-uninstalled-[0-9]{8}T[0-9]{6}Z-[0-9a-f]+/g)) ?? [];
      const kept = [...new Set([...(await fs.readdir(parent).catch(() => [])), ...named])].filter(n => /^resident-uninstalled-[0-9]{8}T[0-9]{6}Z-[0-9a-f]+$/.test(n)).sort().reverse();
      for (const n of kept) { cwBytes = await readOrNull(path.join(parent, n, 'install', 'companion-wsl.json')); if (cwBytes !== null) break; }
    }
    need(cwBytes !== null, 'NODE_COMPANION_WSL_RECORD_REFUSED', 'no install\companion-wsl.json, live or kept');
    const cw = jsonOf(cwBytes);
    const target = typeof cw?.target === 'string' && cw.target.endsWith('\\ext4.vhdx') ? cw.target.slice(0, -'\\ext4.vhdx'.length) : null;
    need(cw?.contract === 'clued.independent-ci.companion-wsl/1' && cw.companionSid === ca.companionSid && cw.distro === policy?.linux?.distribution && cw.stage === 'qualified'
      && /^[A-Z]:\\(?:[A-Za-z0-9._-]{1,64}\\){0,6}[A-Za-z0-9._-]{1,64}$/.test(target ?? ''), 'NODE_COMPANION_WSL_RECORD_REFUSED');
    companionAccount = { companionSid: ca.companionSid, operatorSid: ca.operatorSid, wslVhdxDirectory: target };
  }
  // the Linux half, from its own record: the companion's version facts (a settled generation, at most an hour old) and roles-v3 copy.
  // DESIGN section 73: it need not be the generation current.json names. A launch that stopped after Linux B leaves the Linux side at
  // that package and the Windows side at the one before it; the reinstall replaces both, each from what it is now (Linux A compares
  // the live host with expectedInstalledLinux as root), so no stop can leave a node this command cannot describe.
  const responses = at('upgrade', 'mailbox', 'responses');
  const factsBytes = await fs.readFile(path.join(responses, 'version-facts.json'));
  let facts;
  try { facts = pyLoads(new TextDecoder('utf-8', { fatal: true }).decode(factsBytes)); } catch { throw new Refused('LINUX_VERSION_FACTS_REFUSED'); }
  need(facts?.contract === 'clued.independent-ci.linux-version-facts/1' && facts.staged === null && facts.pinsOk === true, 'LINUX_VERSION_FACTS_NOT_A_SETTLED_GENERATION');
  need(Number.isSafeInteger(facts.generation) && facts.generation >= 1 && HEX64.test(facts.manifestSha256 ?? '') && HEX64.test(facts.ciSourceManifestSha256 ?? ''), 'LINUX_VERSION_FACTS_REFUSED');
  need(typeof facts.observedAt === 'string' && Math.abs(now - Date.parse(facts.observedAt)) <= FACTS_MAX_AGE_MS, 'LINUX_VERSION_FACTS_NOT_FRESH', { observedAt: facts.observedAt });
  const copy = companionCopy(await readOrNull(path.join(responses, 'roles-public.json')), facts.generation);
  const roles = {};
  for (const role of FORMAL_ROLES) {
    need(sha(copy[`${role}.json`]) === facts.roles?.[role]?.policySha256 && sha(copy[`${role}.qualification.json`]) === facts.roles?.[role]?.qualificationSha256,
      'INSTALLED_ROLES_COPY_NOT_CURRENT', { role });
    const q = pyLoads(copy[`${role}.qualification.json`].toString('utf8'));
    need(exact(q, ['payload', 'signature']), 'INSTALLED_QUALIFICATION_REFUSED', { role });
    roles[role] = { policyBytes: copy[`${role}.json`], qualificationBytes: copy[`${role}.qualification.json`], policy: pyLoads(copy[`${role}.json`].toString('utf8')), payload: q.payload };
  }
  // the node's Linux host facts the root scripts pin (were the configuration's linux.host): the toolchain node every role runs, the result key
  const toolchain = [...new Set(FORMAL_ROLES.map(r => roles[r].policy.nodeExecutable === TOOLCHAIN_NODE ? roles[r].policy.nodeExecutableSha256 : null))];
  need(toolchain.length === 1 && HEX64.test(toolchain[0] ?? ''), 'NODE_TOOLCHAIN_NODE_NOT_ONE_VALUE', { toolchain });
  const keys = [...new Set(FORMAL_ROLES.map(r => roles[r].payload.resultPublicKeySha256))];
  need(keys.length === 1 && HEX64.test(keys[0] ?? ''), 'NODE_RESULT_KEY_NOT_ONE_VALUE');
  // the installed Linux generation Linux A finds (section 8.2): the version facts. The installed Linux manifest's bytes are not on the
  // Windows side; A compares the live one with this hash as root. The Linux side's Source manifest is the Windows record's only while the
  // two sides are one package (linuxMan; null otherwise: its bytes are then on the Linux side alone and A reads them there).
  const expectedInstalledLinux = { generation: facts.generation, manifestSha256: facts.manifestSha256, ciSourceManifestSha256: facts.ciSourceManifestSha256 };
  const linuxMan = facts.ciSourceManifestSha256 === current.ciSourceManifestSha256 ? man : null;
  // a reinstall's W1 pause an earlier launch left in force (it stopped after Linux A began, or was cut off): this launch's W1 is that
  // pause, under its own reason, so a stopped launch never needs a person to lift a pause before the next prepare (section 7 step 4).
  const pausedBytes = await readOrNull(at('state', 'PAUSED.json'));
  let installedW1Reason = null;
  try { installedW1Reason = pausedBytes === null ? null : jsonOf(pausedBytes)?.source?.reason ?? null; } catch { installedW1Reason = null; }
  if (!(typeof installedW1Reason === 'string' && W1_REASON.test(installedW1Reason))) installedW1Reason = null;
  return { root, receipt, current, raw, rm, acc, inst, man, signers, profile, profileSha256, policy, companion, nodeExe, nodeExeSha256, companionAccount,
    facts, factsBytes, roles, linuxHost: { toolchainNodeSha256: toolchain[0], resultPublicKeySha256: keys[0] }, expectedInstalledLinux, linuxMan, installedW1Reason,
    distribution: policy?.linux?.distribution };
}

// ---------------------------------------------------------------- stage 3: inputs from the node's values and the fleet's
// resident-record-inputs/2 (reinstall/tools/record-inputs.py with -Final refs): the node's own values from its installed record, the
// references and the formal role material from fleetRefs. The signers are the node's, bound to the new references. (An upgrade passes
// the installed record back in, upgrade.mjs carriedRecord: validUntil is then the installed one; an acceptance file has none.)
export function recordInputsFor(node, acceptance) {
  const f = acceptance.fleetRefs, { acc, inst } = node;
  need(inst.ciPrincipalQualificationRef === acc.ciPrincipalQualificationRef && UUID.test(acc.ciPrincipalQualificationRef ?? ''), 'NODE_CI_PRINCIPAL_QUALIFICATION_REF_REFUSED');
  const signers = JSON.parse(JSON.stringify(node.signers));
  for (const s of signers.signers) {
    need(s.sourceAcceptanceRef === acc.sourceAcceptanceRef && s.qualificationRef === acc.hostQualificationRef, 'BASE_SIGNER_NOT_BOUND_TO_BASE_RECORD', { keyId: s.keyId });
    need(!Object.hasOwn(s, 'privateKey') && String(s.publicKeyPem).includes('BEGIN PUBLIC KEY') && !String(s.publicKeyPem).includes('PRIVATE'), 'SIGNERS_NOT_PUBLIC');
    s.sourceAcceptanceRef = f.sourceAcceptanceRef;
    s.qualificationRef = f.hostQualificationRef;
  }
  const references = { sourceAcceptanceRef: f.sourceAcceptanceRef, hostQualificationRef: f.hostQualificationRef, ownerAuthorizationRef: f.ownerAuthorizationRef,
    publisherQualificationRef: f.publisherQualificationRef, ciPrincipalQualificationRef: acc.ciPrincipalQualificationRef,
    ownerPackageAcceptanceRef: f.ownerPackageAcceptanceRef, installationReceiptRef: f.installationReceiptRef };
  return { contract: 'clued.independent-ci.resident-record-inputs/2', repository: inst.repository, sourceCommit: acceptance.commit, scope: inst.scope,
    node: node.profile, controllerAccount: acc.controllerAccount, appId: inst.appId, installationId: inst.installationId, repositoryId: inst.repositoryId,
    appKeyId: inst.appKeyId, ciPrincipalBindingId: inst.ciPrincipalBindingId, ciPrincipalRoleRef: inst.ciPrincipalRoleRef, ciTokenPinSha256: inst.ciTokenPinSha256,
    appPublicKeySha256Base64: inst.appPublicKeySha256Base64, supabaseUrl: inst.supabaseUrl, publishableKey: inst.publishableKey,
    controllerNodeSha256: inst.controllerNodeSha256, references,
    owner: { ownerDecisionRef: f.ownerDecisionRef, ownerReceiptRef: f.ownerReceiptRef, acceptedAt: acceptance.acceptedAt, validUntil: acceptance.validUntil ?? null },
    formalRoles: f.formalRoles, signers };
}

// The installed policy and companion configuration back to build-package inputs (rollout/fleet/assemble.mjs step 4): the installed CI
// Source hash in relayScript/bundleScript returns to the placeholder, the generated bridgeManifestSha256 is dropped; build-package
// rewrites the three manifest fields. ports.nodeInputs adds ownerAcceptance (the fleet's decision and receipt); the node is unchanged.
export function configInputsFor(node, acceptance) {
  const companion = pyLoads(pyCanonical(node.companion));
  const installedCi = node.current.ciSourceManifestSha256;
  for (const k of ['relayScript', 'bundleScript']) {
    const s = companion?.companion?.[k];
    const at = `\\source\\${installedCi}\\`;
    need(typeof s === 'string' && s.split(at).length === 2, 'INSTALLED_COMPANION_SCRIPT_NOT_UNDER_ITS_SOURCE', k);
    companion.companion[k] = s.replace(at, '\\source\\<sourceManifestSha256>\\');
  }
  delete companion.companion.bridgeManifestSha256;
  return nodeInputs({ policy: node.policy, companion, profile: node.profile, profileSha256: node.profileSha256,
    decision: acceptance.fleetRefs.ownerDecisionRef, receipt: acceptance.fleetRefs.installationReceiptRef });
}

// reinstall/tools/upgrader-config.py: the fresh install's upgrader configuration from the record (the same bytes: json.dumps(indent=2)).
export async function upgraderConfigFor({ recordDir, residentTree }) {
  const inst = jsonOf(await fs.readFile(path.join(recordDir, 'installation.json')));
  const manifest = jsonOf(await fs.readFile(path.join(recordDir, 'record-manifest.json')));
  const node = jsonOf(await fs.readFile(path.join(recordDir, 'acceptance.json'))).node;
  const installer = (await fs.readFile(path.join(residentTree, 'windows', 'install-resident.ps1'))).toString('utf8');
  const target = /^\$UpgradeTokenTarget = '([^']+)'/m.exec(installer)?.[1];
  const root = /^\$Root = '([^']+)'/m.exec(installer)?.[1];
  const cfg = { contract: 'clued.independent-ci.resident-upgrader-config/1', node: node.nodeName, nodeProfileSha256: manifest.nodeProfileSha256,
    ownerSid: node.ownerSid, root, supabaseUrl: inst.supabaseUrl, publishableKey: inst.publishableKey, confirmOrigin: 'https://kooyumi.pixelgrav.com', tokenFile: target,
    timeouts: { drainMaxMinutes: 120, drainRetryMinutes: 60, deferMaxHours: 24, pauseConfirmMs: 600000, verifyMaxMs: 2700000, grantPollMs: [30000, 120000] },
    keepGenerations: 3 };
  need(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(cfg.node ?? '') && cfg.root === DEFAULT_ROOT && typeof target === 'string', 'UPGRADER_CONFIG_INPUT_REFUSED');
  const { validateUpgraderConfig } = await import(pathToFileURL(path.join(residentTree, 'upgrader', 'src', 'config.mjs')).href);
  validateUpgraderConfig(cfg);
  return Buffer.from(pyDumps(cfg, { indent: 2 }) + '\n', 'utf8');
}

// The installed tokens the launcher carries into the new install (section 8.1), from the receipt only (their content is never opened, and
// nothing outside the node is asked for): the upgrade token must be installed with its target and fingerprint; the heartbeat token is
// either not installed (no entry, null, or placed false: null) or installed with target, fingerprint and a binding id (or null).
// Anything else is refused with what is missing.
export function installedSecretsOf(receipt) {
  const missing = (t, keys) => keys.filter(k => !(k === 'target' ? typeof t?.[k] === 'string' && TOKEN_PATH.test(t[k]) : k === 'fingerprint' ? HEX64.test(t?.[k] ?? '') : t?.[k] === true));
  const up = receipt.upgradeToken;
  const upMissing = missing(up, ['placed', 'target', 'fingerprint']);
  need(upMissing.length === 0, 'INSTALLED_UPGRADE_TOKEN_UNKNOWN', { missing: upMissing.map(k => `upgradeToken.${k}`) });
  const hb = receipt.heartbeatToken;
  let heartbeatToken = null;
  if (!(hb === undefined || hb === null || (typeof hb === 'object' && hb.placed === false))) {
    const hbMissing = missing(hb, ['placed', 'target', 'fingerprint']);
    if (!(hb?.bindingId === null || hb?.bindingId === undefined || UUID.test(String(hb?.bindingId)))) hbMissing.push('bindingId');
    need(hbMissing.length === 0, 'INSTALLED_HEARTBEAT_TOKEN_UNKNOWN', { missing: hbMissing.map(k => `heartbeatToken.${k}`) });
    need(hb.target.toLowerCase() !== up.target.toLowerCase(), 'INSTALLED_HEARTBEAT_TOKEN_UNKNOWN', { ambiguous: 'heartbeatToken.target is upgradeToken.target' });
    heartbeatToken = { target: hb.target, fingerprint: hb.fingerprint, bindingId: hb.bindingId ?? null };
  }
  return { source: 'installed', upgradeToken: { target: up.target, fingerprint: up.fingerprint }, heartbeatToken };
}

// The Linux resident manifest's external pins (section 8.2: the installed manifest's bytes are not on the Windows side): every entry point
// the tree's units ExecStart (worker, wsprep, archive, in that order) under source-v2 (the commit's file) or the toolchain node (the
// node's, from its role policies): the same paths and order on every node.
const UNITS = Object.freeze(['clued-ci-worker@.service', 'clued-ci-wsprep@.service', 'clued-ci-archive@.service']);
export function linuxExternalPins({ residentTree, readTreeFile, toolchainNodeSha256 }) {
  const pins = [];
  for (const unit of UNITS) {
    const text = fsSync.readFileSync(path.join(residentTree, 'linux', 'systemd', unit), 'utf8');
    for (const line of text.split(/\r?\n/).filter(l => l.startsWith('ExecStart='))) {
      for (const tok of line.slice('ExecStart='.length).split(/\s+/)) {
        let pin = null;
        if (tok.startsWith(`${TRUSTED_SOURCE}/`)) pin = { installedPath: tok, sha256: sha(readTreeFile(safeRel(tok.slice(TRUSTED_SOURCE.length + 1)))) };
        else if (tok === TOOLCHAIN_NODE) pin = { installedPath: tok, sha256: toolchainNodeSha256 };
        else need(!tok.startsWith('/var/lib/clued-independent-ci/') && !tok.startsWith('/opt/clued-independent-ci/source-'), 'LINUX_UNIT_ENTRY_NOT_PINNABLE', { unit, tok });
        if (pin && !pins.some(p => p.installedPath === pin.installedPath)) pins.push(pin);
      }
    }
  }
  need(pins.some(p => p.installedPath === TOOLCHAIN_NODE) && pins.length >= 2, 'LINUX_EXTERNAL_PINS_INCOMPLETE', { pins: pins.map(p => p.installedPath) });
  return pins;
}

export const W1_REASON = /^fleet-node-reinstall-[a-z0-9-]{1,80}-w1-before-linux-switch$/;
export const reasonsOf = version => {
  const v = `fleet-node-reinstall-${version.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
  return { pause: `${v}-hold-after-install`, rearm: `${v}-rearm-after-verify`, w1Pause: `${v}-w1-before-linux-switch` };
};

// The runner service's DACL as it is now (read-only; generate.py reads it again itself): `sc.exe sdshow`, its D: part.
export const defaultScm = service => {
  const r = run('C:\\Windows\\System32\\sc.exe', ['sdshow', service]);
  let d = r.stdout.trim();
  d = d.includes('D:') ? d.slice(d.indexOf('D:')) : '';
  d = d.includes('S:') ? d.slice(0, d.indexOf('S:')) : d;
  need(r.status === 0 && /^D:[A-Z0-9();:-]+$/.test(d), 'RUNNER_SERVICE_DACL_UNREADABLE', { service });
  return { sddl: d };
};

// clued.independent-ci.reinstall-config/1 (reinstall/tools/rconfig.py) of this node, from the node alone (sections 7.1, 8): the work
// directory and the copies under it, the bare repository of the archive's bundle, the new package (its record is the base), the installed
// runtime and configuration, the installed tokens' targets (paths only; the launcher carries them, section 8.1), the runner (the package
// installer's original binary, the live DACL), the fleet reasons, the Linux host facts (the one signing path: the installed roles-v3, 7.5)
// and the companion account. linux.installedManifest names a file that does not exist on the Windows side: the fleet rehearsal defers
// that comparison to Linux A, which checks the plan's expectedInstalledLinux (section 8.2).
export function reinstallConfigFor({ node, work, repo, packageDir, inputs, installed, secrets, runner, reasons }) {
  const { inst } = node;
  const cfg = { contract: CONFIG_CONTRACT, workDir: work, repo,
    basePackage: packageDir,
    nodeRecord: { appKeyId: inst.appKeyId, appPublicKeySha256Base64: inst.appPublicKeySha256Base64, ciPrincipalBindingId: inst.ciPrincipalBindingId,
      ciPrincipalRoleRef: inst.ciPrincipalRoleRef, ciTokenPinSha256: inst.ciTokenPinSha256, controllerNodeSha256: inst.controllerNodeSha256 },
    nodeExe: node.nodeExe, policyInput: path.join(inputs, 'policy.input.json'), companionInput: path.join(inputs, 'companion.input.json'),
    upgradeTokenFile: secrets.upgradeToken.target,
    ...(secrets.heartbeatToken ? { heartbeat: { tokenFile: secrets.heartbeatToken.target, bindingId: secrets.heartbeatToken.bindingId } } : {}),
    runner, launcher: { pauseReason: reasons.pause, rearmReason: reasons.rearm, w1PauseReason: reasons.w1Pause },
    linux: { distribution: node.distribution, installedManifest: path.join(installed, 'linux-resident-manifest.json'), installedRoles: path.join(installed, 'roles-v3'),
      host: { toolchainNodeSha256: node.linuxHost.toolchainNodeSha256, resultPublicKeySha256: node.linuxHost.resultPublicKeySha256 } },
    secretTargetsExist: [true, true],
    ...(node.companionAccount ? { operatorSid: node.companionAccount.operatorSid, companionAccount: { wslVhdxDirectory: node.companionAccount.wslVhdxDirectory } } : {}) };
  return cfg;
}

// reinstall/linux/tools/derive-roles.py (what Linux A derives as root and B compares, SOURCE_V2_DERIVED_ROLE_MISMATCH): each installed
// role policy with the new manifest, the two new references and the five Source pins of the commit; nothing else may change. OLD is
// the Linux side's own Source (its facts); its relay references are compared here only when that manifest is on the Windows side
// (node.linuxMan), and by Linux A as root in every case (derive-roles: INSTALLED_REFS_NOT_THE_OLD_RELAY).
export function rolesDerivedReinstall({ node, newManifestBytes, readTreeFile }) {
  const NEW = sha(newManifestBytes), OLD = node.expectedInstalledLinux.ciSourceManifestSha256;
  const newM = pyLoads(newManifestBytes.toString('utf8'));
  need(OLD !== NEW && newM.sourceSha !== undefined, 'NEW_SOURCE_IS_THE_INSTALLED_ONE');
  const out = {};
  for (const role of FORMAL_ROLES) {
    const orel = node.linuxMan?.roles[role].controllerRelay ?? null, nrel = newM.roles[role].controllerRelay;
    const { policy: pol, payload: pay } = node.roles[role];
    need(pol.sourceManifestSha256 === OLD && pay.sourceManifestSha256 === OLD, 'INSTALLED_NOT_THE_OLD_MANIFEST', { role });
    need(orel === null || (pol.sourceAcceptanceRef === orel.sourceAcceptanceRef && pol.hostAcceptanceRef === orel.hostQualificationRef), 'INSTALLED_REFS_NOT_THE_OLD_RELAY', { role });
    for (const k of ['sourceAcceptanceRef', 'hostAcceptanceRef', 'runtimeIdentity', 'image', 'entrySha256', 'qualificationSha256', 'executionMode', 'workerSha256',
      'proofSha256', 'jobSha256', 'nodeExecutable', 'keyId']) need(pyEqual(pay[k] ?? null, pol[k] ?? null), 'INSTALLED_PAYLOAD_NOT_ITS_POLICY', { role, key: k });
    need(typeof pol.entryFile === 'string' && pol.entryFile.startsWith(`${TRUSTED_SOURCE}/`), 'ENTRY_OUTSIDE_TRUSTED', { role });
    const fileSha = rel => sha(readTreeFile(safeRel(rel)));
    const pins = { entrySha256: fileSha(pol.entryFile.slice(TRUSTED_SOURCE.length + 1)), ...Object.fromEntries(Object.entries(PIN_FILES).map(([k, rel]) => [k, fileSha(rel)])) };
    for (const k of Object.keys(pins)) need(HEX64.test(String(pol[k])), 'INSTALLED_PIN_NOT_A_SHA256', { role, key: k });
    const np = { ...pol, sourceManifestSha256: NEW, sourceAcceptanceRef: nrel.sourceAcceptanceRef, hostAcceptanceRef: nrel.hostQualificationRef, ...pins };
    out[role] = sha(Buffer.from(pyCanonical(np) + '\n', 'utf8'));
  }
  return out;
}

// ---------------------------------------------------------------- tools
function run(exe, args, { cwd, env } = {}) {
  const r = spawnSync(exe, args, { cwd, env, maxBuffer: 1 << 26, windowsHide: true });
  const lines = String(r.stdout ?? '').split(/\r?\n/).filter(l => l.trim());
  return { status: r.status, last: lines.at(-1) ?? null, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? r.error ?? '').trim().slice(-600) };
}
const parsed = s => { try { return JSON.parse(s); } catch { return null; } };
// The package's Python tools, isolated (python -I): the Owner session's Python, never a repository checkout.
export const defaultPython = (script, args) => run('python', ['-I', script, ...args]);
function gitEnv(tmp) {
  const cfg = path.join(tmp, 'empty.gitconfig');
  if (!fsSync.existsSync(cfg)) fsSync.writeFileSync(cfg, '', { flag: 'wx' });
  return { ...process.env, GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
}

// reinstall/linux/assemble.py, laid out the same, from this package and the archive's tree and bundle (no repository checkout).
export async function assembleLinuxIn({ pkg, residentTree, bundle, commit, out, scratch }) {
  const copy = async (from, ...to) => { await fs.mkdir(path.dirname(path.join(out, ...to)), { recursive: true }); await fs.copyFile(from, path.join(out, ...to), fsSync.constants.COPYFILE_EXCL); };
  const P = (...p) => path.join(pkg, ...p);
  for (const f of ['acceptance.json', 'installation.json', 'record-manifest.json', 'signers.json', 'source-manifest.json']) await copy(P('record', f), 'record', f);
  await copy(P('linux', 'bin', 'clued-ci-install-source-v2'), 'tools', 'clued-ci-install-source-v2');
  for (const f of ['upgrade-v1/bin/clued-ci-upgrade-linux', 'upgrade-v1/bin/clued-ci-sign-qualification-v2.mjs', 'upgrade-v1/manifest.json']) await copy(P('linux', ...f.split('/')), 'linux-pkg', ...f.split('/'));
  const m = jsonOf(await fs.readFile(P('package-manifest.json')));
  const sv2 = m.linux?.sourceV2;
  need(sv2 && sv2.commit === commit && sv2.bundlePath === 'linux/source-v2/source.bundle' && sha(await fs.readFile(P('linux', 'source-v2', 'source.bundle'))) === sv2.bundleSha256,
    'SOURCE_V2_NOT_THE_ACCEPTED_COMMIT');
  await copy(P('linux', 'source-v2', 'source.bundle'), 'linux-pkg', 'source-v2', 'source.bundle');
  for (const f of ['install-resident-linux.sh', 'verify-resident-linux.sh', 'uninstall-resident-linux.sh']) await copy(path.join(residentTree, 'linux', f), 'tools', f);
  for (const f of ['bin/clued-ci-resident-linux', 'manifest.json', 'systemd/clued-ci-worker@.service', 'systemd/clued-ci-wsprep@.service', 'systemd/clued-ci-archive@.service']) {
    await copy(P('linux', ...f.split('/')), 'linux-res-pkg', ...f.split('/'));
  }
  for (const [src, dst] of [['check-host.py', 'check-host-r4.py'], ['verify-signed.mjs', 'verify-signed-r4.mjs'], ['derive-roles.py', 'derive-roles-r7.py']]) {
    await copy(path.join(residentTree, 'reinstall', 'linux', 'tools', src), 'tools', dst);
  }
  bareFromBundle({ git: path.join(out, 'src.git'), bundle, commit, env: gitEnv(scratch) });
}

// A bare repository whose HEAD and only ref refs/heads/accepted is the commit, fetched from the archive's bundle (never a remote).
export function bareFromBundle({ git, bundle, commit, env }) {
  const g = args => { const r = run('git', args, { env }); need(r.status === 0, 'GIT_FAILED', { args: args.filter(a => !path.isAbsolute(a)).slice(0, 3), stderr: r.stderr }); return r.stdout.trim(); };
  g(['init', '-q', '--bare', '--initial-branch=accepted', git]);
  g(['-C', git, 'fetch', '-q', '--no-tags', bundle, 'refs/heads/accepted:refs/heads/accepted']);
  need(g(['-C', git, 'rev-parse', 'refs/heads/accepted']) === commit && g(['-C', git, 'rev-parse', '--verify', 'HEAD^{commit}']) === commit, 'SRC_GIT_NOT_THE_ACCEPTED_COMMIT');
}

const wslPath = p => { const a = path.resolve(p); return `/mnt/${a[0].toLowerCase()}/${a.slice(3).replace(/\\/g, '/')}`; };
const writeNew = (file, data) => fs.writeFile(file, data, { flag: 'wx' });
// install-plan.json is rewritten as it is completed (scripts after prep.py, launcher after generate.py): replace, never append.
async function writePlan(file, plan) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
  await fs.rename(tmp, file);
}

export function runCommandOf(launcher, launcherSha256) {
  need(WIN_PATH.test(launcher) && HEX64.test(launcherSha256), 'LAUNCHER_PATH_REFUSED');
  return `$env:PSModulePath='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'; $b=[IO.File]::ReadAllBytes('${launcher}'); `
    + "$h=-join ([Security.Cryptography.SHA256]::Create().ComputeHash($b) | ForEach-Object { $_.ToString('x2') }); "
    + `if ($h -cne '${launcherSha256}') { throw ('LAUNCHER_CHANGED ' + $h) }; & ([scriptblock]::Create([Text.Encoding]::UTF8.GetString($b))) -RunApprovedInstall`;
}

// ---------------------------------------------------------------- prepare
export async function prepareInstall({ artifactPath, artifactSha256, acceptance, root = DEFAULT_ROOT, workDir, now = Date.now(),
  node: nodeBin = process.execPath, python = defaultPython, scm = defaultScm, selfDir = HERE }) {
  validateAcceptance(acceptance, now);
  need(typeof workDir === 'string' && WIN_PATH.test(path.resolve(workDir)), 'WORK_DIR_PATH_REFUSED');
  const bytes = await fs.readFile(artifactPath);
  const { entries, universal } = readArchive(bytes, artifactSha256, acceptance);
  const byPath = new Map(entries.map(e => [e.path, e.data]));
  // this program is the archive's: the modules running now are its bytes
  for (const n of OWN_MODULES) {
    const want = byPath.get(`tree/${RESIDENT}/rollout/fleet/${n}`);
    need(want && want.equals(await fs.readFile(path.join(selfDir, n))), 'FLEET_INSTALLER_NOT_THE_ARCHIVES', n);
  }
  const node = await readNode({ root, now });
  // The Linux side is already this package's and the Windows side is not: this package's own launch stopped between the two. Its
  // Linux phases cannot run again over themselves; that launch is continued from where it stopped (reinstall/README.md, --fleet-continue).
  need(!(node.facts.ciSourceManifestSha256 === acceptance.ciSourceManifestSha256 && node.current.ciSourceManifestSha256 !== acceptance.ciSourceManifestSha256),
    'LINUX_SIDE_ALREADY_THIS_PACKAGE_CONTINUE_THE_STOPPED_LAUNCH', { continueWith: 'python -I <tree>/work/independent-ci-resident-v1/reinstall/launcher/generate.py --fleet-continue <the stopped launch: launcher.ps1> --out <new launcher.ps1>' });
  need(typeof node.distribution === 'string' && node.distribution === node.profile.wslDistribution && /^[A-Za-z0-9._-]{1,64}$/.test(node.distribution), 'NODE_DISTRIBUTION_REFUSED');
  const secrets = installedSecretsOf(node.receipt);
  need(acceptance.repository === node.inst.repository, 'FLEET_ACCEPTANCE_NOT_THIS_REPOSITORY', { accepted: acceptance.repository, installed: node.inst.repository });
  const work = path.resolve(workDir);
  await fs.mkdir(work, { recursive: false });
  const x = path.join(work, 'x');
  await extractTar(entries, x);
  // the archive's tree where the reinstall tools look for it (rconfig workDir\tree-<c8>)
  const tree = path.join(work, `tree-${universal.commit.slice(0, 8)}`);
  await fs.rename(path.join(x, 'tree'), tree);
  const R = path.join(tree, ...RESIDENT.split('/'));
  const listedTree = new Set(universal.files.filter(e => e.path.startsWith('tree/')).map(e => e.path.slice(5)));
  const readTreeFile = rel => { need(listedTree.has(rel), 'PINNED_FILE_MISSING_IN_NEW_COMMIT', { path: rel }); return fsSync.readFileSync(path.join(tree, ...rel.split('/'))); };
  const inputs = path.join(work, 'inputs');
  await fs.mkdir(inputs);

  // the record: the node's values, the fleet's references and role material, the commit's Source
  const ri = recordInputsFor(node, acceptance);
  await writeNew(path.join(inputs, 'record-inputs.json'), pyCanonical(ri) + '\n');
  const record = path.join(inputs, 'record');
  const closure = path.join(tree, ...CLOSURE.split('/'));
  const prep = run(nodeBin, [path.join(tree, ...PREPARE_RECORD.split('/')), '--inputs', path.join(inputs, 'record-inputs.json'), '--source-root', tree, '--closure', closure, '--out', record]);
  need(prep.status === 0, 'PREPARE_RECORD_FAILED', prep.stderr);
  const chk = run(nodeBin, [path.join(R, 'reinstall', 'tools', 'check-record.mjs'), tree, record]);
  need(chk.status === 0, 'RECORD_V2_REFUSED_BY_RUNTIME_VALIDATOR', parsed(chk.last)?.code ?? chk.stderr);
  const manifestBytes = await fs.readFile(path.join(record, 'source-manifest.json'));
  const ciSourceManifestSha256 = sha(manifestBytes);
  // the Source the Owner accepted (source-hash computed it from the package and fleetRefs alone): this node's must be it
  need(ciSourceManifestSha256 === acceptance.ciSourceManifestSha256, 'FLEET_SOURCE_NOT_THE_ACCEPTED_ONE', { node: ciSourceManifestSha256, accepted: acceptance.ciSourceManifestSha256 });
  await writeNew(path.join(inputs, 'source-files.txt'), JSON.parse((await fs.readFile(closure)).toString('utf8')).paths.join('\n') + '\n');

  // policy, companion, upgrader configuration
  const ni = configInputsFor(node, acceptance);
  await writeNew(path.join(inputs, 'policy.input.json'), ni.policyBytes);
  await writeNew(path.join(inputs, 'companion.input.json'), ni.companionBytes);
  await writeNew(path.join(inputs, 'upgrader.input.json'), await upgraderConfigFor({ recordDir: record, residentTree: R }));

  // the Linux half: the external pins of the package's units, source-v2 entries of this commit, the node's toolchain node
  const pins = linuxExternalPins({ residentTree: R, readTreeFile, toolchainNodeSha256: node.linuxHost.toolchainNodeSha256 });
  await writeNew(path.join(inputs, 'linux-external-pins.json'), pyDumps(pins, { indent: 2 }) + '\n');
  const bundle = path.join(x, ...BUNDLE_NAME.split('/'));
  const heads = bundleHeads(await fs.readFile(bundle));
  need(heads.length === 1 && heads[0] === `${universal.commit} refs/heads/accepted`, 'BUNDLE_NOT_ONLY_THE_ACCEPTED_COMMIT', heads);
  const rolesDerivedSha256 = rolesDerivedReinstall({ node, newManifestBytes: manifestBytes, readTreeFile });
  await writeNew(path.join(inputs, 'source-v2.json'), JSON.stringify({ commit: universal.commit, bundle, rolesDerivedSha256 }, null, 2));
  const stateCompat = universal.stateCompat ?? node.current.stateCompat;
  await writeNew(path.join(inputs, 'state-compat.json'), pyDumps(stateCompat, { sortKeys: true }) + '\n');

  // the package, twice, with the archive's build-package.mjs
  const build = out => {
    const r = run(nodeBin, [path.join(R, 'tools', 'build-package.mjs'), '--out', out, '--policy', path.join(inputs, 'policy.input.json'), '--companion', path.join(inputs, 'companion.input.json'),
      '--node', node.nodeExe, '--record', record, '--source-root', tree, '--source-files', path.join(inputs, 'source-files.txt'), '--fresh-install',
      '--upgrader-config', path.join(inputs, 'upgrader.input.json'), '--linux-external-pins', path.join(inputs, 'linux-external-pins.json'),
      '--source-v2', path.join(inputs, 'source-v2.json'), '--state-compat', path.join(inputs, 'state-compat.json')], { cwd: R });
    need(r.status === 0 && HEX64.test(parsed(r.last)?.packageManifestSha256 ?? ''), 'BUILD_PACKAGE_FAILED', r.stderr);
    return parsed(r.last);
  };
  const packageDir = path.join(work, 'package');
  const first = build(packageDir);
  const again = build(path.join(x, 'package-rebuild'));
  need(first.packageManifestSha256 === again.packageManifestSha256, 'PACKAGE_NOT_REPRODUCIBLE');
  const pkgRaw = await fs.readFile(path.join(packageDir, 'package-manifest.json'));
  need(sha(pkgRaw) === first.packageManifestSha256, 'PACKAGE_CHANGED');
  const m = JSON.parse(pkgRaw.toString('utf8'));
  const f = universal.facts;
  const got = { residentManifestSha256: m.residentManifestSha256, sourceManifestSha256: m.sourceManifestSha256, upgraderManifestSha256: m.upgrader?.manifestSha256,
    bundleSha256: m.linux?.sourceV2?.bundleSha256, universalFilesSha256: universalFilesSha256(m.files, m.residentManifestSha256, m.ciSourceManifestSha256) };
  const differ = Object.keys(got).filter(k => got[k] !== f[k]);
  need(differ.length === 0 && m.linux?.sourceV2?.commit === universal.commit && m.ciSourceManifestSha256 === ciSourceManifestSha256
    && m.acceptance?.decisionRef === acceptance.fleetRefs.ownerDecisionRef && m.nodeProfileSha256 === node.profileSha256, 'FLEET_PACKAGE_NOT_THE_ACCEPTED_SOURCE', { fields: differ });
  need(m.files.some(e => e.target === 'upgrader\\config\\upgrader.json'), 'FLEET_PACKAGE_NOT_A_FRESH_INSTALL');

  // the Linux A/B inputs (<work>\linux-in) and the scripts' output directory: a new <CI root>\reinstall-linux-out-<32hex> that only the
  // elevated launcher makes, right before phase A (Administrators-owned, protected; the companion account may write in it), and that does
  // not exist now. The launcher also gives the companion account read on linux-in: nothing here changes an ACL.
  const companionAccount = node.companionAccount !== null;
  const linuxIn = path.join(work, 'linux-in'), linuxOut = path.join(CI_ROOT, `reinstall-linux-out-${randomBytes(16).toString('hex')}`);
  need(!fsSync.existsSync(linuxOut), 'LINUX_OUT_DIRECTORY_EXISTS', linuxOut);
  await fs.mkdir(linuxIn);
  await assembleLinuxIn({ pkg: packageDir, residentTree: R, bundle, commit: universal.commit, out: linuxIn, scratch: x });

  // the synthesized reinstall configuration and the installed copies it names (section 7.1)
  const installed = path.join(inputs, 'installed');
  await fs.mkdir(path.join(installed, 'roles-v3'), { recursive: true });
  await writeNew(path.join(installed, 'version-facts.json'), node.factsBytes);
  await fs.copyFile(path.join(root, 'upgrade', 'current.json'), path.join(installed, 'generation.json'), fsSync.constants.COPYFILE_EXCL);
  for (const role of FORMAL_ROLES) {
    await writeNew(path.join(installed, 'roles-v3', `${role}.json`), node.roles[role].policyBytes);
    await writeNew(path.join(installed, 'roles-v3', `${role}.qualification.json`), node.roles[role].qualificationBytes);
  }
  // the Linux side's Source manifest, when the Windows record is that one; otherwise its bytes are on the Linux side alone and what
  // needs them is Linux A's (rehearse.py --fleet: deferredTo linux-phase-a)
  if (node.linuxMan) await writeNew(path.join(installed, 'roles-v3', 'formal-source-manifest-v2.json'), node.raw['source-manifest.json']);
  const repo = path.join(work, 'rehearsal', `src-${universal.commit.slice(0, 8)}.git`);
  await fs.mkdir(path.dirname(repo));
  bareFromBundle({ git: repo, bundle, commit: universal.commit, env: gitEnv(x) });
  const installerText = (await fs.readFile(path.join(R, 'windows', 'install-resident.ps1'))).toString('utf8');
  const originalBinary = [...installerText.matchAll(/^\$OriginalBinary = '([^']+)'/gm)].map(r => r[1]);
  need(originalBinary.length === 1, 'PACKAGE_INSTALLER_RUNNER_BINARY_UNKNOWN');
  const reasons = { ...reasonsOf(universal.version), ...(node.installedW1Reason ? { w1Pause: node.installedW1Reason } : {}) };
  const cfg = reinstallConfigFor({ node, work, repo, packageDir, inputs, installed, secrets, reasons,
    runner: { binary: originalBinary[0], sddl: scm(node.profile.runnerService).sddl } });
  const configFile = path.join(inputs, 'reinstall-config.json');
  await writeNew(configFile, JSON.stringify(cfg, null, 2) + '\n');
  const pyJson = r => parsed(String(r.stdout ?? '').trim()) ?? parsed(r.last ?? '');

  // the package's rehearsal: read-only against the installed node, the file locks deferred to the elevated launcher
  const rh = python(path.join(R, 'reinstall', 'rehearse.py'), [configFile, '--commit', universal.commit, '--package', packageDir, '--file-locks-in-launcher', '--fleet']);
  const rr = pyJson(rh);
  need(rh.status === 0 && rr?.status === 'REHEARSAL_PASS' && typeof rr.report === 'string', 'REHEARSAL_FAILED', { findings: rr?.findings ?? null, report: rr?.report ?? null, stderr: rr ? undefined : rh.stderr });

  // the package's prep.py, --in-dir/--out-dir form: A.sh, B.sh, B-resume.sh in <work>\linux\
  const suffix = `f${new Date(now).toISOString().replace(/[-:]/g, '').slice(0, 15).toLowerCase()}`;
  const p = python(path.join(R, 'reinstall', 'linux', 'prep.py'), [configFile, universal.commit, ciSourceManifestSha256, acceptance.fleetRefs.sourceAcceptanceRef, packageDir, suffix,
    '--in-dir', linuxIn, '--out-dir', linuxOut, path.join(installed, 'version-facts.json'), path.join(installed, 'generation.json'), rr.report]);
  const pr = pyJson(p);
  need(p.status === 0 && pr?.scripts && pr.paths, 'LINUX_PREP_FAILED', p.stderr || p.last);
  const scripts = {};
  for (const [k, n] of Object.entries(LINUX_SCRIPTS)) {
    const file = pr.paths[n];
    const b = typeof file === 'string' ? await readOrNull(file) : null;
    need(b !== null && b.length > 0 && sha(b) === pr.scripts[n] && path.resolve(file) === path.join(work, 'linux', n), 'LINUX_PREP_SCRIPT_MISSING', n);
    scripts[k] = { path: file, sha256: sha(b) };
  }

  // the plan (w1Paused and launcher null); first generate.py --check: every check of the launcher's generation that does not need the
  // pause, nothing written. Only then W1, so that a launcher that cannot be generated never leaves the old resident paused (review new-3).
  const linuxManifestSha256 = m.linux.manifestSha256;
  const plan = { contract: PLAN_CONTRACT, node: node.profile.nodeName, version: universal.version, archive_sha256: acceptance.archive_sha256, commit: universal.commit,
    packageDir, packageManifestSha256: first.packageManifestSha256, ciSourceManifestSha256, linuxManifestSha256, companionAccount,
    linux: { distribution: node.distribution, inDir: linuxIn, wslInDir: wslPath(linuxIn), outDir: linuxOut, scripts, timeoutSeconds: { ...LINUX_TIMEOUT_SECONDS } },
    expectedLinux: { generation: 1, ciSourceManifestSha256, manifestSha256: linuxManifestSha256, packageManifestSha256: first.packageManifestSha256 },
    expectedInstalledLinux: { ...node.expectedInstalledLinux }, secrets, reasons, w1Paused: null, launcher: null };
  const planFile = path.join(work, 'install-plan.json');
  await writePlan(planFile, plan);
  const generatePy = path.join(R, 'reinstall', 'launcher', 'generate.py');
  const gc = python(generatePy, ['--fleet-plan', planFile, '--check']);
  need(gc.status === 0, 'LAUNCHER_CHECK_FAILED', gc.stderr || gc.last);

  // W1 (README section 7 step 4): the package's pause-old-resident.py, non-elevated, with the plan's w1Pause reason (the synthesized
  // configuration's launcher.w1PauseReason: this version's, or the reason of the reinstall W1 pause an earlier stopped launch left in
  // force, readNode's installedW1Reason); it waits for OLD_RESIDENT_PAUSED_NO_OPEN_BATCH and finds a pause of that reason confirmed at
  // once. The PAUSED.json it confirmed is pinned into the plan for generate.py.
  const w1 = python(path.join(R, 'reinstall', 'tools', 'pause-old-resident.py'), [configFile]);
  const wr = parsed(String(w1.stdout ?? '').trim().split(/\r?\n/).at(-1) ?? '') ?? parsed(w1.last ?? '');
  need(w1.status === 0 && wr?.status === 'OLD_RESIDENT_PAUSED_NO_OPEN_BATCH' && HEX64.test(wr.pausedSha256 ?? ''), 'W1_PAUSE_NOT_CONFIRMED', wr ?? { stderr: w1.stderr });
  const pausedBytes = await fs.readFile(path.join(root, 'state', 'PAUSED.json'));
  const paused = jsonOf(pausedBytes);
  need(sha(pausedBytes) === wr.pausedSha256 && paused?.source?.reason === reasons.w1Pause, 'W1_PAUSE_NOT_THIS_REQUEST', { pausedSha256: sha(pausedBytes), reason: paused?.source?.reason ?? null });
  plan.w1Paused = { sha256: wr.pausedSha256, reason: reasons.w1Pause };
  await writePlan(planFile, plan);

  // the launcher: generate.py reads the plan as it is now (w1Paused set, launcher null)
  const launcherFile = path.join(work, 'launcher.ps1');
  const g = python(generatePy, ['--fleet-plan', planFile, '--out', launcherFile]);
  need(g.status === 0, 'LAUNCHER_GENERATE_FAILED', g.stderr || g.last);
  const lb = await readOrNull(launcherFile);
  need(lb !== null && lb.length > 0, 'LAUNCHER_MISSING');
  plan.launcher = { path: launcherFile, sha256: sha(lb) };
  await writePlan(planFile, plan);
  return { status: 'FLEET_NODE_INSTALL_PREPARED', node: plan.node, version: plan.version, workDir: work, installPlan: planFile,
    launcher: plan.launcher, runCommand: runCommandOf(launcherFile, plan.launcher.sha256) };
}

// source-hash (read-only, no node): the ciSourceManifestSha256 every node's record will carry, from the package and a draft acceptance
// alone (repository, commit, fleetRefs: sourceAcceptanceRef, hostQualificationRef, formalRoles), computed by the archive's own
// prepare-record.mjs#assembleRecord over the archive's Source closure. The node values it needs to run are stand-ins: they never reach
// source-manifest.json (section 6). prepare recomputes it on each node and refuses another value (FLEET_SOURCE_NOT_THE_ACCEPTED_ONE).
export async function sourceHashOf({ artifactPath, artifactSha256, acceptance, now = Date.now() }) {
  validateAcceptance(acceptance, now, { draft: true });
  const { entries, universal } = readArchive(await fs.readFile(artifactPath), artifactSha256, acceptance);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-source-hash-'));
  try {
    const x = path.join(tmp, 'x');
    await extractTar(entries.filter(e => e.path.startsWith('tree/')), x);
    const tree = path.join(x, 'tree');
    const { assembleRecord, readClosure } = await import(pathToFileURL(path.join(tree, ...PREPARE_RECORD.split('/'))).href);
    const closure = JSON.parse((await fs.readFile(path.join(tree, ...CLOSURE.split('/')))).toString('utf8'));
    const f = acceptance.fleetRefs, z = '0'.repeat(64);
    const references = Object.fromEntries(['sourceAcceptanceRef', 'hostQualificationRef', 'ownerAuthorizationRef', 'publisherQualificationRef', 'ciPrincipalQualificationRef',
      'ownerPackageAcceptanceRef', 'installationReceiptRef'].map(k => [k, f[k] ?? f.ownerDecisionRef]));
    const standIn = { repository: acceptance.repository, sourceCommit: universal.commit, formalRoles: f.formalRoles, references, controllerAccount: 'clued-control',
      node: { hostname: 'source-hash' }, appId: 1, installationId: 1, repositoryId: 1, appKeyId: 1, ciPrincipalBindingId: f.ownerDecisionRef, ciPrincipalRoleRef: f.ownerDecisionRef,
      ciTokenPinSha256: z, appPublicKeySha256Base64: '', scope: 'global', supabaseUrl: '', publishableKey: '', controllerNodeSha256: z, signers: { signers: [] },
      owner: { ownerDecisionRef: f.ownerDecisionRef, ownerReceiptRef: f.ownerReceiptRef, acceptedAt: acceptance.acceptedAt, validUntil: null } };
    const { files } = assembleRecord(standIn, readClosure(tree, closure.paths));
    return { status: 'FLEET_SOURCE_HASH', version: universal.version, commit: universal.commit, repository: acceptance.repository,
      ciSourceManifestSha256: sha(Buffer.from(files['source-manifest.json'], 'utf8')) };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

// fleet-refs: what an acceptance file's fleetRefs.formalRoles is today on this node (the installed record), read-only.
export async function installedFleetMaterial(root = DEFAULT_ROOT) {
  const man = jsonOf(await fs.readFile(path.join(root, 'record', 'source-manifest.json')));
  const acc = jsonOf(await fs.readFile(path.join(root, 'record', 'acceptance.json')));
  const formalRoles = Object.fromEntries(FORMAL_ROLES.map(r => [r, Object.fromEntries(Object.entries(man.roles[r]).filter(([k]) => k !== 'sourceFiles' && k !== 'controllerRelay'))]));
  return { formalRoles, formalRolesSha256: sha(Buffer.from(pyCanonical(formalRoles), 'utf8')),
    installed: { sourceAcceptanceRef: acc.sourceAcceptanceRef, hostQualificationRef: acc.hostQualificationRef, ciSourceManifestSha256: sha(await fs.readFile(path.join(root, 'record', 'source-manifest.json'))) } };
}

// The command is the same on every node (section 8): no node-specific argument exists. `deps` is for tests only (a fixture root and
// stand-ins for the node's Python tools, ACL grants and SCM); the command line cannot reach it.
export async function main(argv, deps = {}) {
  const [cmd, ...rest] = argv;
  if (cmd === 'fleet-refs') {
    parseArgs({ args: rest, options: {} });
    return installedFleetMaterial(deps.root ?? DEFAULT_ROOT);
  }
  if (cmd === 'source-hash') {
    const { values } = parseArgs({ args: rest, options: { artifact: { type: 'string' }, 'artifact-sha': { type: 'string' }, acceptance: { type: 'string' } } });
    need(values.artifact && values['artifact-sha'] && values.acceptance, 'USAGE');
    return sourceHashOf({ artifactPath: values.artifact, artifactSha256: values['artifact-sha'], acceptance: jsonOf(await fs.readFile(values.acceptance)) });
  }
  need(cmd === 'prepare', 'USAGE');
  const { values } = parseArgs({ args: rest, options: { artifact: { type: 'string' }, 'artifact-sha': { type: 'string' }, acceptance: { type: 'string' }, work: { type: 'string' } } });
  need(values.artifact && values['artifact-sha'] && values.acceptance && values.work, 'USAGE');
  const acceptance = jsonOf(await fs.readFile(values.acceptance));
  return prepareInstall({ ...deps, artifactPath: values.artifact, artifactSha256: values['artifact-sha'], acceptance, workDir: values.work });
}

if (import.meta.main) {
  // Every Windows PowerShell 5.1 child (rehearse, generate, the uninstall/install dry runs, Get-Acl) gets its own module path: an
  // Owner session under PowerShell 7 would otherwise pass its path down and 5.1 cannot autoload Microsoft.PowerShell.Security.
  process.env.PSModulePath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules';
  main(process.argv.slice(2)).then(r => { console.log(JSON.stringify(r)); }, e => {
    console.log(JSON.stringify({ status: 'FLEET_NODE_INSTALL_REFUSED', code: e?.code ?? 'FLEET_NODE_INSTALL_FAILED', detail: e?.detail ?? String(e?.message ?? e).slice(0, 300) }));
    process.exitCode = 1;
  });
}
