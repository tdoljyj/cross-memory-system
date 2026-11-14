// Assemble the reviewed install package for install-resident.ps1 / install-resident-linux.sh.
//   node tools/build-package.mjs --out <new dir> --policy <policy.json> --companion <companion.json>
//        --node <node.exe> --record <prepared claim-free record dir> [--source-root <Source v2 checkout>
//        --source-files <list.txt>] [--linux-external-pins <pins.json>]
//        [--state-compat <stateCompat.json>] [--source-v2 <sourceV2.json>] [--fresh-install --upgrader-config <upgrader.json>]
// Source v2 (DESIGN S5, S12): the claim-free install record (resident-v2/prepare-record.mjs output) is
// installed admin-only into record\; the CI Source goes to source\<ciSourceManifestSha256>\ (the record's
// source-manifest.json hash, the directory the generic helper loads code from); no helper binary is
// packaged: the one generic helper is compiled at install from the installed Source and its hash is
// pinned in the broker configuration there. The bridge v4 bundle manifest (relay-public.ps1) is
// generated next to the installed bridge files and its hash goes into the companion configuration.
// Pure file assembly into a NEW directory: every file is copied create-only and listed with its
// SHA-256. package-manifest.json (Windows) lists each file with its install target; linux/manifest.json
// lists each Linux file with its INSTALLED path (review M7), plus the external entry points the units
// run from the installed Source (node, linux-worker.mjs, prepare-workspaces.py), so the unit guard
// pins exactly what systemd executes. Nothing on any host is touched.
//
// Package /4 (in-place upgrade channel, Task 018da927, spec A1, DESIGN §34) adds to /3:
//   nodeProfileSha256, windowsLayout (clued.independent-ci.resident-layout/1), stateCompat ({ schema, readableBySchemas }, --state-compat),
//   acceptance ({ decisionRef } = the policy's ownerAcceptance.decisionRef);
//   linux: { manifestSha256 (of linux/manifest.json), sourceV2: null | { commit, bundlePath, bundleSha256, rolesDerivedSha256: { gitleaks,
//     trivy, contract-placement } } (--source-v2: the accepted commit, its bundle file and the role hashes the Linux upgrade tool's stage
//     must derive; the bundle is copied to linux/source-v2/source.bundle), files: [{ path, sha256, bytes }] of every file under linux/ };
//     the frozen Linux upgrade tool and the signer go to linux/upgrade-v1/bin/ with linux/upgrade-v1/manifest.json
//     (clued.independent-ci.linux-upgrade-tool-manifest/1: both at their installed paths under /opt/clued-independent-ci/upgrade-v1/);
//   upgrader: { manifestSha256, files } of the upgrader's frozen code copy, upgrader\<manifestSha256>\, laid out as in this tree so its
//     relative imports resolve: upgrader\src\* (R/upgrader/src), src\* (the resident modules they import, transitively; nothing else)
//     and windows\upgrade-apply.ps1. Always computed, so an upgrade package names the upgrader it was built with and the upgrader
//     refuses a different one (UPGRADE_CHANNEL_CHANGE_NEEDS_REINSTALL).
// Install targets under upgrader\ are written into `files` only with --fresh-install (the upgrader refuses them in an in-place upgrade):
// the code copy, upgrader\bin\UpgraderServiceHost.cs, upgrader\runtime\node.exe (the same node.exe) and upgrader\config\upgrader.json
// (--upgrader-config, clued.independent-ci.resident-upgrader-config/1).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { HEX40, HEX64, UUID, canonicalJson, check, sha256 } from '../src/canonical.mjs';
import { validateStateCompat } from '../src/upgrade-mailbox.mjs';
import { FLEET_TRAIN, LEGACY_POLICY_KEYS, POLICY_CONTRACT_V7, validatePolicy } from '../src/policy.mjs';
import { RESIDENT_INSTALL_ROOT, validateCompanionConfig } from '../src/companion.mjs';
import { validateStatusConfig } from '../src/pr-status.mjs';
import { PANEL_REPO, validatePanelDispatchConfig } from '../src/panel-dispatch.mjs';
import {MERGE_RECONCILE_REPO,validateMergeReconcileConfig} from '../src/merge-reconcile-config.mjs';
import { INSTALLED_MANIFEST_CONTRACT } from '../src/service-ports.mjs';
import { pinnedNodeProfile } from '../src/node-profile.mjs';
import { nodeIdentityOf, nodeIdentitySha256 } from '../src/node-identity.mjs';

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RESIDENT_FILES = ['src', 'tools', 'windows'];
const LINUX_FILES = [
  ['bin/clued-ci-resident-linux', '/opt/clued-independent-ci/resident-v1/bin/clued-ci-resident-linux'],
  ['systemd/clued-ci-worker@.service', '/etc/systemd/system/clued-ci-worker@.service'],
  ['systemd/clued-ci-wsprep@.service', '/etc/systemd/system/clued-ci-wsprep@.service'],
  ['systemd/clued-ci-archive@.service', '/etc/systemd/system/clued-ci-archive@.service'],
];

async function listFiles(base, rel) {
  const abs = path.join(base, rel);
  const stat = await fs.lstat(abs);
  check(!stat.isSymbolicLink(), 'PACKAGE_LINK_REFUSED', rel);
  if (stat.isFile()) return /(^|\/)__pycache__\//.test(rel.replace(/\\/g, '/')) ? [] : [rel.replace(/\\/g, '/')];
  const out = [];
  for (const name of (await fs.readdir(abs)).sort()) if (name !== '__pycache__') out.push(...await listFiles(base, path.join(rel, name)));
  return out;
}

async function copyNew(from, to) {
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.copyFile(from, to, fs.constants.COPYFILE_EXCL);
  const bytes = await fs.readFile(to);
  return { sha256: sha256(bytes), bytes: bytes.length };
}

const writeJson = (file, value) => fs.writeFile(file, canonicalJson(value) + '\n', { flag: 'wx' });

const RECORD_FILES = ['installation.json', 'acceptance.json', 'source-manifest.json', 'signers.json', 'record-manifest.json'];
const BRIDGE_DIR = 'work/actions-hosted-migration/independent-ci-v1/worker/protected-job-bridge-v4';
const BRIDGE_FILES = ['boundary.mjs', 'formal-spool-acl.ps1', 'issue-job.mjs', 'linux-worker.mjs', 'mailbox.mjs', 'protocol.mjs', 'relay-public.ps1', 'relay-record.mjs', 'signed-result.mjs', 'windows-issuer.mjs'];
export const BRIDGE_MANIFEST_CONTRACT = 'clued.independent-ci.protected-job-bridge-source/4';

// ---- package /4 (DESIGN §34) ----
export const PACKAGE_CONTRACT = 'clued.independent-ci.resident-package/4';
export const WINDOWS_LAYOUT = 'clued.independent-ci.resident-layout/1';
export const DEFAULT_STATE_COMPAT = Object.freeze({ schema: 1, readableBySchemas: Object.freeze([1]) });
export const UPGRADER_MANIFEST_CONTRACT = 'clued.independent-ci.resident-upgrader-manifest/1';
export const UPGRADER_CONFIG_CONTRACT = 'clued.independent-ci.resident-upgrader-config/1';
export const LINUX_UPGRADE_TOOL_MANIFEST_CONTRACT = 'clued.independent-ci.linux-upgrade-tool-manifest/1';
export const LINUX_UPGRADE_V1 = '/opt/clued-independent-ci/upgrade-v1';
// The frozen Linux upgrade tool and the qualification signer (B3): repository file -> package path under linux/upgrade-v1/bin/.
export const LINUX_UPGRADE_FILES = Object.freeze([['bin/clued-ci-upgrade-linux', 'clued-ci-upgrade-linux'], ['bin/clued-ci-sign-qualification-v2.mjs', 'clued-ci-sign-qualification-v2.mjs']]);
export const LINUX_ROLES = Object.freeze(['gitleaks', 'trivy', 'contract-placement']);
export const SOURCE_V2_BUNDLE = 'linux/source-v2/source.bundle';
// The upgrader's frozen copy: its own code, its entry for upgrade-apply.ps1 (B2), and the resident modules its code imports.
const UPGRADER_DIRS = ['upgrader/src'];
const UPGRADER_WINDOWS = ['windows/upgrade-apply.ps1'];
const IMPORT_RE = /\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]|\bimport\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]|new URL\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*,\s*import\.meta\.url/g;

// Every repository file (forward-slash path from HERE) the given .mjs files reach through relative imports, including themselves.
// An import that leaves src/ or upgrader/src/ is refused: the copy holds nothing else.
export async function importClosure(base, start) {
  const seen = new Set(), todo = [...start];
  while (todo.length > 0) {
    const rel = todo.pop();
    if (seen.has(rel)) continue;
    check(/^(?:src|upgrader\/src)\/[A-Za-z0-9_.-]+$/.test(rel), 'PACKAGE_UPGRADER_IMPORT_REFUSED', rel);
    seen.add(rel);
    if (!rel.endsWith('.mjs')) continue;
    const text = await fs.readFile(path.join(base, ...rel.split('/')), 'utf8');
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2] ?? m[3];
      todo.push(path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)));
    }
  }
  return [...seen].sort();
}

// The upgrader's manifest over the copy (paths relative to upgrader\<manifestSha256>\).
export async function upgraderCopy(base = HERE) {
  const own = [];
  for (const d of UPGRADER_DIRS) own.push(...(await listFiles(base, d)).filter(f => f.endsWith('.mjs')));
  check(own.length > 0, 'PACKAGE_UPGRADER_REQUIRED');
  const rels = [...new Set([...(await importClosure(base, own)), ...UPGRADER_WINDOWS])].sort();
  const files = [];
  for (const rel of rels) {
    const bytes = await fs.readFile(path.join(base, ...rel.split('/')));
    files.push({ path: rel, sha256: sha256(bytes), bytes: bytes.length });
  }
  const manifest = { contract: UPGRADER_MANIFEST_CONTRACT, root: 'upgrader', files };
  return { manifest, manifestSha256: sha256(Buffer.from(canonicalJson(manifest) + '\n')) };
}

// --source-v2 input: { commit, bundle (a file path), rolesDerivedSha256: { gitleaks, trivy, contract-placement } }.
function validateSourceV2Input(s) {
  check(s && typeof s === 'object' && HEX40.test(s.commit ?? '') && typeof s.bundle === 'string' && s.bundle.length > 0
    && s.rolesDerivedSha256 && typeof s.rolesDerivedSha256 === 'object' && Object.keys(s.rolesDerivedSha256).sort().join('|') === [...LINUX_ROLES].sort().join('|')
    && LINUX_ROLES.every(r => HEX64.test(s.rolesDerivedSha256[r] ?? '')), 'PACKAGE_SOURCE_V2_INPUT_REFUSED');
  return s;
}

export async function buildPackage({ out, policyFile, companionFile, nodeExe, recordDir, sourceRoot = null, sourceFiles = [], linuxExternalPins = [],
  stateCompat = DEFAULT_STATE_COMPAT, sourceV2 = null, freshInstall = false, upgraderConfigFile = null }) {
  validateStateCompat(stateCompat, 'PACKAGE_STATE_COMPAT_REFUSED');
  if (sourceV2 !== null) validateSourceV2Input(sourceV2);
  check(!freshInstall || typeof upgraderConfigFile === 'string', 'PACKAGE_UPGRADER_CONFIG_REQUIRED');
  check(typeof recordDir === 'string', 'PACKAGE_RECORD_REQUIRED');
  await fs.mkdir(out, { recursive: false });
  // The claim-free install record: copied as is; its source-manifest.json names the Source directory.
  const recordEntries = [];
  for (const name of RECORD_FILES) recordEntries.push({ name, ...await copyNew(path.join(recordDir, name), path.join(out, 'record', name)) });
  const ciSourceManifestSha256 = recordEntries.find(e => e.name === 'source-manifest.json').sha256;
  const recordManifest = JSON.parse(await fs.readFile(path.join(out, 'record', 'record-manifest.json'), 'utf8'));
  check(recordManifest.sourceManifestSha256 === ciSourceManifestSha256 && recordManifest.claimBound === false, 'PACKAGE_RECORD_REFUSED');
  const accepted = JSON.parse(await fs.readFile(path.join(out, 'record', 'acceptance.json'), 'utf8'));
  check(recordEntries.find(e => e.name === 'acceptance.json').sha256 === recordManifest.acceptanceSha256, 'PACKAGE_RECORD_REFUSED');
  const node = pinnedNodeProfile(accepted.node, recordManifest.nodeProfileSha256);
  // Node identity (DESIGN section 30): derived from the two record files, which must agree; its hash goes into the package manifest, where the
  // install derives it again from the same bytes and refuses a different answer. Public ids and fingerprints only.
  const installation = JSON.parse(await fs.readFile(path.join(out, 'record', 'installation.json'), 'utf8'));
  check(recordEntries.find(e => e.name === 'installation.json').sha256 === recordManifest.installationSha256, 'PACKAGE_RECORD_REFUSED');
  const nodeIdentity = nodeIdentityOf(installation, accepted, recordManifest.acceptanceSha256);
  const nodeIdentitySha = nodeIdentitySha256(nodeIdentity);
  const nodeProfileSha256 = recordManifest.nodeProfileSha256;
  const residentEntries = [];
  for (const rel of RESIDENT_FILES) for (const f of await listFiles(HERE, rel)) {
    residentEntries.push({ path: f, ...await copyNew(path.join(HERE, f), path.join(out, 'resident', f)) });
  }
  const residentManifest = { contract: INSTALLED_MANIFEST_CONTRACT, root: 'resident', files: residentEntries };
  const residentManifestSha256 = sha256(Buffer.from(canonicalJson(residentManifest) + '\n'));
  const sourceEntries = [];
  for (const rel of sourceFiles) sourceEntries.push({ path: rel, ...await copyNew(path.join(sourceRoot, rel), path.join(out, 'source', rel)) });
  // relay-public.ps1 checks this generated manifest byte for byte before every transfer (bridge v4).
  let bridgeManifestSha256 = null;
  if (BRIDGE_FILES.every(n => sourceFiles.includes(`${BRIDGE_DIR}/${n}`))) {
    const runtimeFiles = Object.fromEntries(BRIDGE_FILES.map(n => { const e = sourceEntries.find(x => x.path === `${BRIDGE_DIR}/${n}`); return [n, { bytes: e.bytes, sha256: e.sha256 }]; }));
    const text = canonicalJson({ contract: BRIDGE_MANIFEST_CONTRACT, runtimeFiles });
    const rel = `${BRIDGE_DIR}/manifest.json`;
    await fs.writeFile(path.join(out, 'source', rel), text, { flag: 'wx' });
    bridgeManifestSha256 = sha256(Buffer.from(text));
    sourceEntries.push({ path: rel, sha256: bridgeManifestSha256, bytes: Buffer.byteLength(text) });
  }
  const sourceManifest = { contract: INSTALLED_MANIFEST_CONTRACT, root: 'source', files: sourceEntries };
  const sourceManifestSha256 = sha256(Buffer.from(canonicalJson(sourceManifest) + '\n'));
  const policy = JSON.parse(await fs.readFile(policyFile, 'utf8'));
  // DESIGN §76: the keys of a removed feature (policy `relay`, companion `hints`) an installed node's inputs still carry are left out
  // here, so every package (an upgrade carries the node's own policy and companion configuration) converges without a step of its own.
  // DESIGN §41.9 step 4: the train is the fleet's (policy.mjs FLEET_TRAIN), never the node's input; a /7 policy cannot carry it.
  const train = policy.contract === POLICY_CONTRACT_V7 ? policy.train : { ...FLEET_TRAIN };
  const finalPolicy = Object.fromEntries(Object.entries({ ...policy, train, sourceManifestSha256, ciSourceManifestSha256, residentManifestSha256 })
    .filter(([k]) => !LEGACY_POLICY_KEYS.includes(k)));
  validatePolicy(finalPolicy);
  check(finalPolicy.nodeProfileSha256 === nodeProfileSha256 && canonicalJson(finalPolicy.node) === canonicalJson(node), 'PACKAGE_NODE_PROFILE_CHANGED');
  const { hints: _legacyHints, ...companion } = JSON.parse(await fs.readFile(companionFile, 'utf8'));
  check(companion.status?.node === undefined || companion.status.node === node.nodeName, 'PACKAGE_NODE_PROFILE_CHANGED');
  const sub = s => s.replaceAll('<sourceManifestSha256>', ciSourceManifestSha256);
  const finalCompanion = { ...companion, companion: { ...companion.companion, relayScript: sub(companion.companion.relayScript), bundleScript: sub(companion.companion.bundleScript),
    ...(bridgeManifestSha256 ? { bridgeManifestSha256 } : {}) },
    status: { ...companion.status, node: node.nodeName } };
  // DESIGN §33: every Source script path lies under source\<this package's ciSourceManifestSha256>\ (a literal hash of another Source
  // in the input file is not replaced above and is refused here), so the installed config never names a Source that is not installed.
  validateCompanionConfig(finalCompanion.companion, { root: RESIDENT_INSTALL_ROOT, ciSourceManifestSha256 });
  check(finalCompanion.companion.nodeProfileSha256 === nodeProfileSha256 && canonicalJson(finalCompanion.companion.node) === canonicalJson(node), 'PACKAGE_NODE_PROFILE_CHANGED');
  validateStatusConfig(finalCompanion.status);
  // The panel trigger is on unless switched off, and it only exists for the panel's own repository: no silent "on" that does nothing.
  check(!validatePanelDispatchConfig(finalCompanion.panelDispatch).enabled || finalCompanion.repo === PANEL_REPO, 'PACKAGE_PANEL_DISPATCH_REPO_MISMATCH');
  check(!validateMergeReconcileConfig(finalCompanion.mergeReconcile).enabled||finalCompanion.repo===MERGE_RECONCILE_REPO,'PACKAGE_MERGE_RECONCILE_REPO_MISMATCH');
  await fs.mkdir(path.join(out, 'config'));
  await writeJson(path.join(out, 'config', 'policy.json'), finalPolicy);
  await writeJson(path.join(out, 'config', 'companion.json'), finalCompanion);
  await writeJson(path.join(out, 'config', 'resident-installed-manifest.json'), residentManifest);
  await writeJson(path.join(out, 'config', 'source-installed-manifest.json'), sourceManifest);
  const runtime = await copyNew(nodeExe, path.join(out, 'runtime', 'node.exe'));
  // Linux half: installed paths, plus the external entry points the units execute.
  const linuxEntries = [];
  for (const [rel, installedPath] of LINUX_FILES) linuxEntries.push({ path: rel, installedPath, ...await copyNew(path.join(HERE, 'linux', rel), path.join(out, 'linux', rel)) });
  for (const p of linuxExternalPins) {
    check(typeof p.installedPath === 'string' && p.installedPath.startsWith('/') && !p.installedPath.split('/').includes('..') && HEX64.test(p.sha256), 'PACKAGE_LINUX_PIN_REFUSED');
    linuxEntries.push({ path: null, installedPath: p.installedPath, sha256: p.sha256, bytes: null });
  }
  await writeJson(path.join(out, 'linux', 'manifest.json'), { contract: 'clued.independent-ci.resident-linux-manifest/2', files: linuxEntries.map(({ installedPath, sha256: s }) => ({ installedPath, sha256: s })) });
  // The Linux half of the Source v2 install (bin/clued-ci-install-source-v2) is run once by root from this
  // reviewed copy, never installed or pinned by the unit guard; its hash is reported for the Owner's review.
  const sourceV2Installer = await copyNew(path.join(HERE, 'linux', 'bin', 'clued-ci-install-source-v2'), path.join(out, 'linux', 'bin', 'clued-ci-install-source-v2'));
  // Package /4: the frozen Linux upgrade tool and the signer (installed once by root with install-resident-linux.sh --apply-upgrade-v1,
  // pinned by their own manifest), and the accepted Source v2 bundle the tool's stage clones from.
  const upgradeTool = [];
  for (const [rel, name] of LINUX_UPGRADE_FILES) upgradeTool.push({ name, ...await copyNew(path.join(HERE, 'linux', ...rel.split('/')), path.join(out, 'linux', 'upgrade-v1', 'bin', name)) });
  await writeJson(path.join(out, 'linux', 'upgrade-v1', 'manifest.json'), { contract: LINUX_UPGRADE_TOOL_MANIFEST_CONTRACT,
    files: upgradeTool.map(f => ({ installedPath: `${LINUX_UPGRADE_V1}/bin/${f.name}`, sha256: f.sha256 })) });
  let sourceV2Section = null;
  if (sourceV2 !== null) {
    const bundle = await copyNew(sourceV2.bundle, path.join(out, ...SOURCE_V2_BUNDLE.split('/')));
    sourceV2Section = { commit: sourceV2.commit, bundlePath: SOURCE_V2_BUNDLE, bundleSha256: bundle.sha256, rolesDerivedSha256: { ...sourceV2.rolesDerivedSha256 } };
  }
  // Every file under linux/ but the bundle (named by sourceV2 on its own), with its size: what the Linux upgrade tool may take.
  const linuxListed = [];
  for (const f of await listFiles(out, 'linux')) {
    if (f === SOURCE_V2_BUNDLE) continue;
    const bytes = await fs.readFile(path.join(out, ...f.split('/')));
    linuxListed.push({ path: f, sha256: sha256(bytes), bytes: bytes.length });
  }
  const linuxManifestSha256 = sha256(await fs.readFile(path.join(out, 'linux', 'manifest.json')));
  // The upgrader's frozen code copy (always: its hash names the upgrader this package was built with).
  const upgrader = await upgraderCopy(HERE);
  for (const f of upgrader.manifest.files) {
    const c = await copyNew(path.join(HERE, ...f.path.split('/')), path.join(out, 'upgrader', ...f.path.split('/')));
    check(c.sha256 === f.sha256, 'PACKAGE_UPGRADER_CHANGED_WHILE_BUILT', f.path);
  }
  const files = [];
  const add = async (rel, target) => { files.push({ path: rel, target, sha256: sha256(await fs.readFile(path.join(out, rel))) }); };
  for (const e of residentEntries) await add(`resident/${e.path}`, `resident\\${residentManifestSha256}\\${e.path.replace(/\//g, '\\')}`);
  for (const e of sourceEntries) await add(`source/${e.path}`, `source\\${ciSourceManifestSha256}\\${e.path.replace(/\//g, '\\')}`);
  for (const e of recordEntries) await add(`record/${e.name}`, `record\\${e.name}`);
  for (const c of ['policy.json', 'companion.json', 'resident-installed-manifest.json', 'source-installed-manifest.json']) await add(`config/${c}`, `config\\${c}`);
  await add('runtime/node.exe', 'runtime\\node.exe');
  await add('resident/windows/ResidentServiceHost.cs', 'bin\\ResidentServiceHost.cs');
  await add('resident/windows/SwapBroker.cs', 'bin\\SwapBroker.cs');
  if (freshInstall) {
    // Only a fresh install places the upgrader (install-resident.ps1 steps upgrader-files, upgrader-host, upgrader-service).
    const cfgBytes = await fs.readFile(upgraderConfigFile);
    const cfg = JSON.parse(cfgBytes.toString('utf8'));
    check(cfg?.contract === UPGRADER_CONFIG_CONTRACT && cfg.nodeProfileSha256 === nodeProfileSha256 && (cfg.node === undefined || cfg.node === node.nodeName)
      && (cfg.ownerSid === undefined || cfg.ownerSid === node.ownerSid), 'PACKAGE_UPGRADER_CONFIG_REFUSED');
    await fs.mkdir(path.join(out, 'upgrader-config'));
    await fs.writeFile(path.join(out, 'upgrader-config', 'upgrader.json'), cfgBytes, { flag: 'wx' });
    for (const f of upgrader.manifest.files) await add(`upgrader/${f.path}`, `upgrader\\${upgrader.manifestSha256}\\${f.path.replace(/\//g, '\\')}`);
    await add('resident/windows/UpgraderServiceHost.cs', 'upgrader\\bin\\UpgraderServiceHost.cs');
    await add('runtime/node.exe', 'upgrader\\runtime\\node.exe');
    await add('upgrader-config/upgrader.json', 'upgrader\\config\\upgrader.json');
  }
  const decisionRef = finalPolicy.ownerAcceptance?.decisionRef;
  check(UUID.test(decisionRef ?? ''), 'PACKAGE_ACCEPTANCE_DECISION_REQUIRED');
  const pkg = { contract: PACKAGE_CONTRACT, sourceManifestSha256, ciSourceManifestSha256, residentManifestSha256, bridgeManifestSha256, nodeIdentitySha256: nodeIdentitySha,
    nodeProfileSha256, windowsLayout: WINDOWS_LAYOUT, stateCompat: { schema: stateCompat.schema, readableBySchemas: [...stateCompat.readableBySchemas] }, acceptance: { decisionRef },
    files, linux: { manifestSha256: linuxManifestSha256, sourceV2: sourceV2Section, files: linuxListed },
    upgrader: { manifestSha256: upgrader.manifestSha256, files: upgrader.manifest.files } };
  await writeJson(path.join(out, 'package-manifest.json'), pkg);
  return { packageManifestSha256: sha256(await fs.readFile(path.join(out, 'package-manifest.json'))), sourceManifestSha256, ciSourceManifestSha256, residentManifestSha256, bridgeManifestSha256, files: files.length, runtimeSha256: runtime.sha256,
    nodeName: nodeIdentity.nodeName, nodeIdentitySha256: nodeIdentitySha, nodeProfileSha256,
    linuxSourceV2InstallerSha256: sourceV2Installer.sha256, linuxManifestSha256, upgraderManifestSha256: upgrader.manifestSha256,
    linuxUpgradeToolSha256: upgradeTool.find(f => f.name === 'clued-ci-upgrade-linux').sha256, linuxSignerSha256: upgradeTool.find(f => f.name === 'clued-ci-sign-qualification-v2.mjs').sha256,
    freshInstall: freshInstall === true };
}

// Run as a program, on any platform. (The earlier test built a file:/// URL by hand, which no POSIX path ever equals: on Linux the
// command line did nothing, printed nothing and exited 0.)
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, policy: { type: 'string' }, companion: { type: 'string' }, node: { type: 'string' }, record: { type: 'string' }, 'source-root': { type: 'string' }, 'source-files': { type: 'string' }, 'linux-external-pins': { type: 'string' },
    'state-compat': { type: 'string' }, 'source-v2': { type: 'string' }, 'fresh-install': { type: 'boolean' }, 'upgrader-config': { type: 'string' } } });
  const sourceFiles = values['source-files'] ? (await fs.readFile(values['source-files'], 'utf8')).split(/\r?\n/).filter(Boolean) : [];
  const linuxExternalPins = values['linux-external-pins'] ? JSON.parse(await fs.readFile(values['linux-external-pins'], 'utf8')) : [];
  // --state-compat <json file> { schema, readableBySchemas }; --source-v2 <json file> { commit, bundle, rolesDerivedSha256 }.
  const stateCompat = values['state-compat'] ? JSON.parse(await fs.readFile(values['state-compat'], 'utf8')) : DEFAULT_STATE_COMPAT;
  const sourceV2 = values['source-v2'] ? JSON.parse(await fs.readFile(values['source-v2'], 'utf8')) : null;
  console.log(JSON.stringify(await buildPackage({ out: values.out, policyFile: values.policy, companionFile: values.companion, nodeExe: values.node, recordDir: values.record, sourceRoot: values['source-root'] ?? null, sourceFiles, linuxExternalPins,
    stateCompat, sourceV2, freshInstall: values['fresh-install'] === true, upgraderConfigFile: values['upgrader-config'] ?? null })));
}
