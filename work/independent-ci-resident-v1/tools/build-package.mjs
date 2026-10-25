// Assemble the reviewed install package for install-resident.ps1 / install-resident-linux.sh.
//   node tools/build-package.mjs --out <new dir> --policy <policy.json> --companion <companion.json>
//        --node <node.exe> --record <prepared claim-free record dir> [--source-root <Source v2 checkout>
//        --source-files <list.txt>] [--linux-external-pins <pins.json>]
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
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { HEX64, canonicalJson, check, sha256 } from '../src/canonical.mjs';
import { validatePolicy } from '../src/policy.mjs';
import { validateCompanionConfig, validateHintConfig } from '../src/companion.mjs';
import { validateStatusConfig } from '../src/pr-status.mjs';
import { INSTALLED_MANIFEST_CONTRACT } from '../src/service-ports.mjs';
import { pinnedNodeProfile } from '../src/node-profile.mjs';

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

export async function buildPackage({ out, policyFile, companionFile, nodeExe, recordDir, sourceRoot = null, sourceFiles = [], linuxExternalPins = [] }) {
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
  const finalPolicy = { ...policy, sourceManifestSha256, ciSourceManifestSha256, residentManifestSha256 };
  validatePolicy(finalPolicy);
  check(finalPolicy.nodeProfileSha256 === nodeProfileSha256 && canonicalJson(finalPolicy.node) === canonicalJson(node), 'PACKAGE_NODE_PROFILE_CHANGED');
  const companion = JSON.parse(await fs.readFile(companionFile, 'utf8'));
  check(companion.status?.node === undefined || companion.status.node === node.nodeName, 'PACKAGE_NODE_PROFILE_CHANGED');
  const sub = s => s.replace('<sourceManifestSha256>', ciSourceManifestSha256);
  const finalCompanion = { ...companion, companion: { ...companion.companion, relayScript: sub(companion.companion.relayScript), bundleScript: sub(companion.companion.bundleScript),
    ...(bridgeManifestSha256 ? { bridgeManifestSha256 } : {}) },
    // Hint mode reads the installed CI Source's relay observer; it follows the policy's relay switch.
    hints: { enabled: companion.hints?.enabled === true && finalPolicy.relay.enabled === true, ciSourceManifestSha256 },
    status: { ...companion.status, node: node.nodeName } };
  validateCompanionConfig(finalCompanion.companion);
  check(finalCompanion.companion.nodeProfileSha256 === nodeProfileSha256 && canonicalJson(finalCompanion.companion.node) === canonicalJson(node), 'PACKAGE_NODE_PROFILE_CHANGED');
  validateHintConfig(finalCompanion.hints);
  validateStatusConfig(finalCompanion.status);
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
  const files = [];
  const add = async (rel, target) => { files.push({ path: rel, target, sha256: sha256(await fs.readFile(path.join(out, rel))) }); };
  for (const e of residentEntries) await add(`resident/${e.path}`, `resident\\${residentManifestSha256}\\${e.path.replace(/\//g, '\\')}`);
  for (const e of sourceEntries) await add(`source/${e.path}`, `source\\${ciSourceManifestSha256}\\${e.path.replace(/\//g, '\\')}`);
  for (const e of recordEntries) await add(`record/${e.name}`, `record\\${e.name}`);
  for (const c of ['policy.json', 'companion.json', 'resident-installed-manifest.json', 'source-installed-manifest.json']) await add(`config/${c}`, `config\\${c}`);
  await add('runtime/node.exe', 'runtime\\node.exe');
  await add('resident/windows/ResidentServiceHost.cs', 'bin\\ResidentServiceHost.cs');
  await add('resident/windows/SwapBroker.cs', 'bin\\SwapBroker.cs');
  const pkg = { contract: 'clued.independent-ci.resident-package/3', sourceManifestSha256, ciSourceManifestSha256, residentManifestSha256, bridgeManifestSha256, files };
  await writeJson(path.join(out, 'package-manifest.json'), pkg);
  return { packageManifestSha256: sha256(await fs.readFile(path.join(out, 'package-manifest.json'))), sourceManifestSha256, ciSourceManifestSha256, residentManifestSha256, bridgeManifestSha256, files: files.length, runtimeSha256: runtime.sha256,
    linuxSourceV2InstallerSha256: sourceV2Installer.sha256 };
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, policy: { type: 'string' }, companion: { type: 'string' }, node: { type: 'string' }, record: { type: 'string' }, 'source-root': { type: 'string' }, 'source-files': { type: 'string' }, 'linux-external-pins': { type: 'string' } } });
  const sourceFiles = values['source-files'] ? (await fs.readFile(values['source-files'], 'utf8')).split(/\r?\n/).filter(Boolean) : [];
  const linuxExternalPins = values['linux-external-pins'] ? JSON.parse(await fs.readFile(values['linux-external-pins'], 'utf8')) : [];
  console.log(JSON.stringify(await buildPackage({ out: values.out, policyFile: values.policy, companionFile: values.companion, nodeExe: values.node, recordDir: values.record, sourceRoot: values['source-root'] ?? null, sourceFiles, linuxExternalPins })));
}
