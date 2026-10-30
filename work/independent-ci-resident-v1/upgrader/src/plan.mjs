// The upgrade plan (ops\<opId>\010-accept.plan.json): what an in-place upgrade may change, decided once at ACCEPT from the
// node's current generation and the package, and never widened afterwards. upgrade-apply.ps1 reads only this file (by its
// hash) and the upgrader's steps only act on what it lists.
//
// The white list: resident\<new sha>\ and source\<new sha>\ (content-addressed, side by side with the old ones), a fixed set of
// file names under config\, record\, bin\ and runtime\ from the package, the files the install compiles or derives (bin\*.exe,
// helpers\, config\broker.json; staged by upgrade-apply.ps1 Compile), install\install-receipt.json (written by the upgrader),
// the binary paths of the resident and broker services and the Arguments of the companion task. Everything else is refused:
// the upgrader's own files, its service, the directory layout and ACLs, accounts, SDDLs, privileges, secrets and the node's
// identity or profile need a full reinstall (UPGRADE_CHANNEL_CHANGE_NEEDS_REINSTALL); a state the current generation could not
// read back after a rollback is refused (UPGRADE_STATE_COMPAT_REFUSED).
import { HEX64, canonicalJson, check, exactKeys, parseBoundedJson, sha256 } from '../../src/canonical.mjs';
import { validateStateCompat } from '../../src/upgrade-mailbox.mjs';
import { WINDOWS_LAYOUT } from './package.mjs';
import { grantResource } from './request.mjs';
import { U } from './codes.mjs';

export const PLAN_CONTRACT = 'clued.independent-ci.resident-upgrade-plan/1';
// Files the package brings, by their install target (the install's own names, install-resident.ps1).
export const PACKAGE_SLOTS = Object.freeze([
  'config\\policy.json', 'config\\companion.json', 'config\\resident-installed-manifest.json', 'config\\source-installed-manifest.json',
  'record\\installation.json', 'record\\acceptance.json', 'record\\source-manifest.json', 'record\\signers.json', 'record\\record-manifest.json',
  'bin\\ResidentServiceHost.cs', 'bin\\SwapBroker.cs', 'runtime\\node.exe',
]);
// Files upgrade-apply.ps1 Compile writes under staged\<pkgSha>\compiled\ (the install's recipe), never from the package.
export const GENERATED_SLOTS = Object.freeze(['bin\\ResidentServiceHost.exe', 'bin\\SwapBroker.exe', 'bin\\CluedCompanionJobHost.exe',
  'helpers\\controller-formal-generic-v2.exe', 'config\\broker.json']);
export const RECEIPT_SLOT = 'install\\install-receipt.json';
export const ALL_SLOTS = Object.freeze([...PACKAGE_SLOTS, ...GENERATED_SLOTS, RECEIPT_SLOT]);
// Top-level directories that only a full reinstall may touch.
const CHANNEL_ROOTS = new Set(['upgrader', 'upgrade', 'secrets', 'generations', 'archive']);
const MAX_MB = 120;

function classifyTarget(target, manifest) {
  const parts = target.split('\\');
  const top = parts[0].toLowerCase();
  if (CHANNEL_ROOTS.has(top)) return U.CHANNEL_CHANGE_NEEDS_REINSTALL;
  if (parts.length >= 3 && (parts[0] === 'resident' || parts[0] === 'source')) {
    const want = parts[0] === 'resident' ? manifest.residentManifestSha256 : manifest.ciSourceManifestSha256;
    return parts[1] === want ? null : U.TARGET_OUTSIDE_WHITELIST;
  }
  return PACKAGE_SLOTS.includes(target) ? null : U.TARGET_OUTSIDE_WHITELIST;
}

const fileOf = (manifest, target) => manifest.files.find(f => f.target === target);

// current: { generation: <upgrade\current.json value>, receipt: <install\install-receipt.json value>, receiptSha256,
//            live: { <slot>: sha256 | null }, dirs: { resident: [sha...], source: [sha...] } }
// manifest: the validated package manifest. options: { request, packageFiles (path -> bytes), opId, config, requestSha256 }.
export function buildPlan(current, manifest, { request, packageFiles, opId, config, requestSha256 }) {
  const cur = current.generation;
  const receipt = current.receipt ?? {};
  check(request.node === config.node, U.NODE_MISMATCH, 'request');
  check(request.packageManifestSha256 !== cur.packageManifestSha256, U.SAME_AS_CURRENT);
  // The upgrader's own channel, the layout and the node's identity are frozen between full installs.
  check(manifest.upgrader === null || manifest.upgrader.manifestSha256 === receipt.upgrader?.manifestSha256, U.CHANNEL_CHANGE_NEEDS_REINSTALL, 'upgrader');
  check(manifest.windowsLayout === (receipt.windowsLayout ?? WINDOWS_LAYOUT), U.CHANNEL_CHANGE_NEEDS_REINSTALL, 'windowsLayout');
  check(manifest.nodeProfileSha256 === config.nodeProfileSha256 && (receipt.nodeProfileSha256 === undefined || manifest.nodeProfileSha256 === receipt.nodeProfileSha256),
    U.CHANNEL_CHANGE_NEEDS_REINSTALL, 'nodeProfile');
  check(receipt.nodeIdentitySha256 === undefined || manifest.nodeIdentitySha256 === receipt.nodeIdentitySha256, U.CHANNEL_CHANGE_NEEDS_REINSTALL, 'nodeIdentity');
  // Every target, by class: the channel's own roots first (a reinstall), then the white list.
  const verdicts = manifest.files.map(f => classifyTarget(f.target, manifest));
  check(!verdicts.includes(U.CHANNEL_CHANGE_NEEDS_REINSTALL), U.CHANNEL_CHANGE_NEEDS_REINSTALL, 'target');
  check(!verdicts.includes(U.TARGET_OUTSIDE_WHITELIST), U.TARGET_OUTSIDE_WHITELIST, 'target');
  for (const slot of PACKAGE_SLOTS) check(fileOf(manifest, slot), U.PACKAGE_CONTRACT_REFUSED, `missing:${slot}`);
  // The new policy binds the package: same manifests, same acceptance, same node, same Owner account.
  const policyBytes = packageFiles.get(fileOf(manifest, 'config\\policy.json').path);
  const policy = parseBoundedJson(policyBytes, 1024 * 1024, U.PACKAGE_CONTRACT_REFUSED);
  check(policy.residentManifestSha256 === manifest.residentManifestSha256 && policy.ciSourceManifestSha256 === manifest.ciSourceManifestSha256
    && policy.sourceManifestSha256 === manifest.sourceManifestSha256 && policy.ownerAcceptance?.decisionRef === manifest.acceptance.decisionRef, U.PACKAGE_CONTRACT_REFUSED, 'policy');
  check(policy.nodeProfileSha256 === config.nodeProfileSha256 && policy.companion?.userSid === config.ownerSid, U.CHANNEL_CHANGE_NEEDS_REINSTALL, 'policy-node');
  check(request.acceptanceDecisionRef === manifest.acceptance.decisionRef, U.REQUEST_REFUSED, 'acceptance');
  // Both directions: the new code reads today's state, and today's code reads the new state after a rollback.
  validateStateCompat(cur.stateCompat, U.STATE_COMPAT_REFUSED);
  check(manifest.stateCompat.readableBySchemas.includes(cur.stateCompat.schema) && cur.stateCompat.readableBySchemas.includes(manifest.stateCompat.schema),
    U.STATE_COMPAT_REFUSED);
  check(cur.linux !== null, U.CHANNEL_CHANGE_NEEDS_REINSTALL, 'linux-not-adopted');

  const residentFile = rel => manifest.files.find(f => f.target === `resident\\${manifest.residentManifestSha256}\\${rel}`);
  const serviceEntry = residentFile('src\\service-main.mjs');
  const companionEntry = residentFile('src\\companion-main.mjs');
  check(serviceEntry && companionEntry, U.PACKAGE_CONTRACT_REFUSED, 'entries');
  const slots = [
    ...PACKAGE_SLOTS.map(target => ({ target, kind: 'package', from: fileOf(manifest, target).path, sha256: fileOf(manifest, target).sha256, oldSha256: current.live[target] ?? null })),
    ...GENERATED_SLOTS.map(target => ({ target, kind: 'generated', from: null, sha256: null, oldSha256: current.live[target] ?? null })),
    { target: RECEIPT_SLOT, kind: 'receipt', from: null, sha256: null, oldSha256: current.live[RECEIPT_SLOT] ?? null },
  ];
  // A slot the current generation does not have cannot be put back by a rollback (nothing to restore): refused.
  for (const s of slots) check(s.oldSha256 !== null && HEX64.test(s.oldSha256), U.CHANNEL_CHANGE_NEEDS_REINSTALL, `live:${s.target}`);
  const dirs = [
    { kind: 'resident', sha256: manifest.residentManifestSha256, present: current.dirs.resident.includes(manifest.residentManifestSha256) },
    { kind: 'source', sha256: manifest.ciSourceManifestSha256, present: current.dirs.source.includes(manifest.ciSourceManifestSha256) },
  ].filter(d => manifest.files.some(f => f.target.startsWith([d.kind, d.sha256, ''].join('\\')))); // only what the package brings
  const plan = {
    contract: PLAN_CONTRACT, opId, node: config.node, requestSha256, packageManifestSha256: request.packageManifestSha256, packageDirectory: request.packageDirectory,
    fromGeneration: cur.generation, toGeneration: cur.generation + 1,
    acceptanceDecisionRef: manifest.acceptance.decisionRef, drainMaxMinutes: Math.min(request.drainMaxMinutes, config.timeouts.drainMaxMinutes, MAX_MB),
    grantResource: grantResource(config.node, request.packageManifestSha256),
    current: { packageManifestSha256: cur.packageManifestSha256, residentManifestSha256: cur.residentManifestSha256, ciSourceManifestSha256: cur.ciSourceManifestSha256,
      policySha256: cur.policySha256, installReceiptSha256: cur.installReceiptSha256, stateCompat: cur.stateCompat, linux: cur.linux,
      fileSha256: current.generationSha256 },
    target: { residentManifestSha256: manifest.residentManifestSha256, ciSourceManifestSha256: manifest.ciSourceManifestSha256, sourceManifestSha256: manifest.sourceManifestSha256,
      bridgeManifestSha256: manifest.bridgeManifestSha256, policySha256: sha256(policyBytes), companionConfigSha256: fileOf(manifest, 'config\\companion.json').sha256,
      nodeSha256: fileOf(manifest, 'runtime\\node.exe').sha256, residentEntrySha256: serviceEntry.sha256, companionEntrySha256: companionEntry.sha256,
      stateCompat: manifest.stateCompat, windowsLayout: manifest.windowsLayout, nodeIdentitySha256: manifest.nodeIdentitySha256, nodeProfileSha256: manifest.nodeProfileSha256,
      linux: { manifestSha256: manifest.linux.manifestSha256, sourceCommit: manifest.linux.sourceV2?.commit ?? null } },
    dirs,
    slots,
    // What upgrade-apply.ps1 may change outside the files: nothing but these.
    scm: { resident: 'binPath', broker: 'binPath' },
    companionTask: 'arguments',
  };
  const bytes = Buffer.from(canonicalJson(plan) + '\n', 'utf8');
  return { plan, planSha256: sha256(bytes), planBytes: bytes };
}

export function validatePlan(p) {
  exactKeys(p, ['contract', 'opId', 'node', 'requestSha256', 'packageManifestSha256', 'packageDirectory', 'fromGeneration', 'toGeneration', 'acceptanceDecisionRef',
    'drainMaxMinutes', 'grantResource', 'current', 'target', 'dirs', 'slots', 'scm', 'companionTask'], U.JOURNAL_INCONSISTENT);
  check(p.contract === PLAN_CONTRACT && p.toGeneration === p.fromGeneration + 1, U.JOURNAL_INCONSISTENT, 'plan');
  return p;
}
