// Assemble the reviewed install package for install-resident.ps1 / install-resident-linux.sh.
//   node tools/build-package.mjs --out <new dir> --policy <policy.json> --companion <companion.json>
//        --node <node.exe> [--source-root <Source v2 checkout> --source-files <list.txt>]
//        [--helpers-dir <Source v2 generic helpers>] [--linux-external-pins <pins.json>]
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
import { validateCompanionConfig } from '../src/companion.mjs';
import { INSTALLED_MANIFEST_CONTRACT } from '../src/service-ports.mjs';

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

export async function buildPackage({ out, policyFile, companionFile, nodeExe, sourceRoot = null, sourceFiles = [], helpersDir = null, linuxExternalPins = [] }) {
  await fs.mkdir(out, { recursive: false });
  const residentEntries = [];
  for (const rel of RESIDENT_FILES) for (const f of await listFiles(HERE, rel)) {
    residentEntries.push({ path: f, ...await copyNew(path.join(HERE, f), path.join(out, 'resident', f)) });
  }
  const residentManifest = { contract: INSTALLED_MANIFEST_CONTRACT, root: 'resident', files: residentEntries };
  const residentManifestSha256 = sha256(Buffer.from(canonicalJson(residentManifest) + '\n'));
  const sourceEntries = [];
  for (const rel of sourceFiles) sourceEntries.push({ path: rel, ...await copyNew(path.join(sourceRoot, rel), path.join(out, 'source', rel)) });
  const sourceManifest = { contract: INSTALLED_MANIFEST_CONTRACT, root: 'source', files: sourceEntries };
  const sourceManifestSha256 = sha256(Buffer.from(canonicalJson(sourceManifest) + '\n'));
  const helperEntries = [];
  if (helpersDir) for (const name of (await fs.readdir(helpersDir)).sort()) {
    check(/^controller-formal-stage-0[1-8]-v2\.exe$/.test(name), 'PACKAGE_HELPER_NAME_REFUSED', name);
    helperEntries.push({ name, ...await copyNew(path.join(helpersDir, name), path.join(out, 'helpers', name)) });
  }
  const policy = JSON.parse(await fs.readFile(policyFile, 'utf8'));
  const finalPolicy = { ...policy, sourceManifestSha256, residentManifestSha256 };
  validatePolicy(finalPolicy);
  const companion = JSON.parse(await fs.readFile(companionFile, 'utf8'));
  const sub = s => s.replace('<sourceManifestSha256>', sourceManifestSha256);
  const finalCompanion = { ...companion, companion: { ...companion.companion, relayScript: sub(companion.companion.relayScript), bundleScript: sub(companion.companion.bundleScript) } };
  validateCompanionConfig(finalCompanion.companion);
  await fs.mkdir(path.join(out, 'config'));
  await writeJson(path.join(out, 'config', 'policy.json'), finalPolicy);
  await writeJson(path.join(out, 'config', 'companion.json'), finalCompanion);
  await writeJson(path.join(out, 'config', 'resident-installed-manifest.json'), residentManifest);
  await writeJson(path.join(out, 'config', 'source-installed-manifest.json'), sourceManifest);
  await writeJson(path.join(out, 'config', 'helpers-allow-list.json'), { contract: 'clued.independent-ci.swap-broker-allow-list/1', helpers: helperEntries.map(h => ({ name: h.name, sha256: h.sha256 })) });
  const runtime = await copyNew(nodeExe, path.join(out, 'runtime', 'node.exe'));
  // Linux half: installed paths, plus the external entry points the units execute.
  const linuxEntries = [];
  for (const [rel, installedPath] of LINUX_FILES) linuxEntries.push({ path: rel, installedPath, ...await copyNew(path.join(HERE, 'linux', rel), path.join(out, 'linux', rel)) });
  for (const p of linuxExternalPins) {
    check(typeof p.installedPath === 'string' && p.installedPath.startsWith('/') && !p.installedPath.split('/').includes('..') && HEX64.test(p.sha256), 'PACKAGE_LINUX_PIN_REFUSED');
    linuxEntries.push({ path: null, installedPath: p.installedPath, sha256: p.sha256, bytes: null });
  }
  await writeJson(path.join(out, 'linux', 'manifest.json'), { contract: 'clued.independent-ci.resident-linux-manifest/2', files: linuxEntries.map(({ installedPath, sha256: s }) => ({ installedPath, sha256: s })) });
  const files = [];
  const add = async (rel, target) => { files.push({ path: rel, target, sha256: sha256(await fs.readFile(path.join(out, rel))) }); };
  for (const e of residentEntries) await add(`resident/${e.path}`, `resident\\${residentManifestSha256}\\${e.path.replace(/\//g, '\\')}`);
  for (const e of sourceEntries) await add(`source/${e.path}`, `source\\${sourceManifestSha256}\\${e.path.replace(/\//g, '\\')}`);
  for (const h of helperEntries) await add(`helpers/${h.name}`, `helpers\\${h.name}`);
  for (const c of ['policy.json', 'companion.json', 'resident-installed-manifest.json', 'source-installed-manifest.json', 'helpers-allow-list.json']) await add(`config/${c}`, `config\\${c}`);
  await add('runtime/node.exe', 'runtime\\node.exe');
  await add('resident/windows/ResidentServiceHost.cs', 'bin\\ResidentServiceHost.cs');
  await add('resident/windows/SwapBroker.cs', 'bin\\SwapBroker.cs');
  const pkg = { contract: 'clued.independent-ci.resident-package/2', sourceManifestSha256, residentManifestSha256, files };
  await writeJson(path.join(out, 'package-manifest.json'), pkg);
  return { packageManifestSha256: sha256(await fs.readFile(path.join(out, 'package-manifest.json'))), sourceManifestSha256, residentManifestSha256, files: files.length, helpers: helperEntries.length, runtimeSha256: runtime.sha256 };
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, policy: { type: 'string' }, companion: { type: 'string' }, node: { type: 'string' }, 'source-root': { type: 'string' }, 'source-files': { type: 'string' }, 'helpers-dir': { type: 'string' }, 'linux-external-pins': { type: 'string' } } });
  const sourceFiles = values['source-files'] ? (await fs.readFile(values['source-files'], 'utf8')).split(/\r?\n/).filter(Boolean) : [];
  const linuxExternalPins = values['linux-external-pins'] ? JSON.parse(await fs.readFile(values['linux-external-pins'], 'utf8')) : [];
  console.log(JSON.stringify(await buildPackage({ out: values.out, policyFile: values.policy, companionFile: values.companion, nodeExe: values.node, sourceRoot: values['source-root'] ?? null, sourceFiles, helpersDir: values['helpers-dir'] ?? null, linuxExternalPins })));
}
