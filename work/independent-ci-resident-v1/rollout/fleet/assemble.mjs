// The node-side assembler (Decisions ddb4300f, b5d041d2 v2): turns the universal node package of an accepted Source into the
// per-node /4 package the frozen upgrader takes, from what is installed on this node. Pure node (no Python, no PowerShell, no git),
// NON-elevated, writes only under a new workDir; it replaces build-upgrade.ps1 on the node.
//
//   node assemble.mjs --artifact <fleet-node-<v>.tar> --artifact-sha <hex> --target <accepted-source.json> --work-dir <new dir>
//        [--root C:\ProgramData\CluedIndependentCI\resident] (--installed-package <dir> | --search-dir <dir> ...)
//
// target: the server's accepted-Source record { id, receipt_id, version, release_tag, archive_sha256, commit,
// resident_manifest_sha256, source_manifest_sha256, upgrader_manifest_sha256, bundle_sha256, universal_files_sha256 } (a ci_source_manifest_sha256 there is ignored: it is
// each node's own).
//
// Stage 1 (this file, whatever its version): the archive's sha256 must be artifactSha256 and the target's archive_sha256; it is read
// strictly (tar.mjs: no link, no climbing path) into workDir\x\ and every entry is checked against universal-manifest.json. Stage 2 is
// the ARCHIVE's own copy of this file (assembleExtracted), so one version assembles the same way on every node:
//   1. the archive is the target's (version, tag, commit and every universal value);
//   2. the installed state: upgrade\current.json, the installed package (its package-manifest.json hashes to current.json's
//      packageManifestSha256; a /4 package with an upgrader), whose record, linux/manifest.json, config\policy.json, config\companion.json
//      and runtime\node.exe are checked against its manifest (the root's copies too, where readable);
//   3. record inputs (ports.recordInputs: the installed references, Decision b1dd8a84), the archive's prepare-record.mjs and check-record.mjs;
//   4. policy and companion inputs from the installed configuration (build-package rewrites the three manifest fields and the
//      <sourceManifestSha256> placeholder, so the installed Source hash in relayScript/bundleScript goes back to the placeholder and the
//      generated bridgeManifestSha256 is dropped), through ports.nodeInputs with ownerAcceptance = { target.id, target.receipt_id };
//   5. Linux pins (ports.linuxPins) from the installed linux/manifest.json, the archive's bundle, the role hashes (ports.rolesDerived) from
//      the companion's roles-public.json and the version facts; stateCompat: the archive's, else the installed package's;
//   6. the archive's build-package.mjs twice (same sha), linux-pins check, identity and profile unchanged; the package's
//      sourceManifestSha256, residentManifestSha256, upgrader, commit, bundle and universal digest equal to the target's (never its
//      ciSourceManifestSha256: each node's own); then the archive's precheck.mjs. Returns { packageDir, packageManifestSha256, precheck, ... }.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { CLOSURE, PREPARE_RECORD, RESIDENT, universalFilesSha256 } from './facts.mjs';
import { RECORD_FILES, Refused, TOOL_PATH, linuxPins, linuxPinsCheck, nodeInputs, nodeProfileOf, recordInputs, rolesDerived } from './ports.mjs';
import { pyDumps, pyLoads } from './pyjson.mjs';
import { extractTar, readTar } from './tar.mjs';
import { BUNDLE_NAME, MANIFEST_NAME, UNIVERSAL_CONTRACT, bundleHeads, tagOf } from './universal.mjs';

export const ASSEMBLER_API = 1;
export const ASSEMBLY_CONTRACT = 'clued.independent-ci.fleet-assembly/1';
export const DEFAULT_ROOT = 'C:\\ProgramData\\CluedIndependentCI\\resident';
const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const TARGET_HEX = ['archive_sha256', 'resident_manifest_sha256', 'source_manifest_sha256', 'upgrader_manifest_sha256', 'bundle_sha256', 'universal_files_sha256'];
const sha = b => createHash('sha256').update(b).digest('hex');
const need = (ok, code, detail) => { if (!ok) throw new Refused(code, detail); };

export function validateTarget(t) {
  need(t && typeof t === 'object' && UUID.test(t.id ?? '') && UUID.test(t.receipt_id ?? '') && typeof t.version === 'string' && typeof t.release_tag === 'string'
    && /^[0-9a-f]{40}$/.test(t.commit ?? '') && TARGET_HEX.every(k => HEX64.test(t[k] ?? '')), 'FLEET_TARGET_REFUSED');
  return t;
}

async function readOrNull(file) {
  try { return await fs.readFile(file); } catch (e) { if (e?.code === 'ENOENT') return null; throw e; }
}

// The directory under searchDirs (each one and its direct subdirectories) whose package-manifest.json hashes to current.json's.
export async function findInstalledPackage({ root = DEFAULT_ROOT, searchDirs = [] }) {
  const current = JSON.parse((await fs.readFile(path.join(root, 'upgrade', 'current.json'))).toString('utf8'));
  need(HEX64.test(current?.packageManifestSha256 ?? ''), 'CURRENT_GENERATION_UNREADABLE');
  const candidates = [];
  for (const dir of searchDirs) {
    candidates.push(dir);
    const names = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const d of names.filter(n => n.isDirectory()).map(n => n.name).sort()) candidates.push(path.join(dir, d));
  }
  for (const dir of candidates) {
    const m = await readOrNull(path.join(dir, 'package-manifest.json')).catch(() => null);
    if (m && sha(m) === current.packageManifestSha256) return path.resolve(dir);
  }
  return null;
}

// ---------------------------------------------------------------- stage 1
export async function assembleUpgrade({ artifactPath, artifactSha256, target, root = DEFAULT_ROOT, installedPackageDir, workDir, now = Date.now(), node = process.execPath }) {
  validateTarget(target);
  need(HEX64.test(artifactSha256 ?? '') && artifactSha256 === target.archive_sha256, 'FLEET_ARTIFACT_SHA_NOT_THE_TARGETS');
  need(typeof installedPackageDir === 'string' && typeof workDir === 'string', 'USAGE');
  const bytes = await fs.readFile(artifactPath);
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
  await fs.mkdir(workDir, { recursive: false });
  const x = path.join(workDir, 'x');
  await extractTar(entries, x);
  const own = path.join(x, 'tree', ...RESIDENT.split('/'), 'rollout', 'fleet', 'assemble.mjs');
  const archived = await import(pathToFileURL(own).href);
  need(archived.ASSEMBLER_API === ASSEMBLER_API && typeof archived.assembleExtracted === 'function', 'FLEET_ASSEMBLER_API_UNKNOWN', archived.ASSEMBLER_API);
  return archived.assembleExtracted({ x, universal, target, root, installedPackageDir: path.resolve(installedPackageDir), workDir: path.resolve(workDir), now, node });
}

function run(node, args, { cwd } = {}) {
  const r = spawnSync(node, args, { cwd, maxBuffer: 1 << 26, windowsHide: true });
  const lines = String(r.stdout ?? '').split(/\r?\n/).filter(l => l.trim());
  return { status: r.status, last: lines.at(-1) ?? null, stderr: String(r.stderr ?? r.error ?? '').trim().slice(-300) };
}
const parsed = s => { try { return JSON.parse(s); } catch { return null; } };

// ---------------------------------------------------------------- stage 2 (runs from the archive)
export async function assembleExtracted({ x, universal, target, root, installedPackageDir, workDir, now, node }) {
  validateTarget(target);
  const f = universal.facts;
  const wanted = { version: [universal.version, target.version], release_tag: [tagOf(universal.version), target.release_tag], commit: [universal.commit, target.commit],
    resident_manifest_sha256: [f.residentManifestSha256, target.resident_manifest_sha256],
    source_manifest_sha256: [f.sourceManifestSha256, target.source_manifest_sha256], upgrader_manifest_sha256: [f.upgraderManifestSha256, target.upgrader_manifest_sha256],
    bundle_sha256: [f.bundleSha256, target.bundle_sha256], universal_files_sha256: [f.universalFilesSha256, target.universal_files_sha256] };
  const off = Object.entries(wanted).filter(([, [a, b]]) => a !== b).map(([k]) => k);
  need(off.length === 0, 'FLEET_ARCHIVE_NOT_THE_TARGET', { fields: off });
  const tree = path.join(x, 'tree');
  const R = path.join(tree, ...RESIDENT.split('/'));
  const listedTree = new Set(universal.files.filter(e => e.path.startsWith('tree/')).map(e => e.path.slice(5)));
  // A file of the commit, by its exact (case-sensitive) path: only what the archive lists (null: the commit has none there).
  const readSourceFile = rel => (listedTree.has(rel) ? fsSync.readFileSync(path.join(tree, ...rel.split('/'))) : null);
  const readTreeFile = rel => { const b = readSourceFile(rel); if (b === null) throw new Refused('PINNED_FILE_MISSING_IN_NEW_COMMIT', { path: rel }); return b; };
  const result = { contract: ASSEMBLY_CONTRACT, version: universal.version, commit: universal.commit, decisionRef: target.id, unreadable: [] };
  const inputs = path.join(workDir, 'inputs');
  await fs.mkdir(inputs);

  // 2. the installed state
  const current = pyLoads((await fs.readFile(path.join(root, 'upgrade', 'current.json'))).toString('utf8'));
  const instRaw = await fs.readFile(path.join(installedPackageDir, 'package-manifest.json'));
  need(sha(instRaw) === current?.packageManifestSha256, 'INSTALLED_PACKAGE_IS_NOT_THE_CURRENT_GENERATION', { package: sha(instRaw), current: current?.packageManifestSha256 ?? null });
  const inst = JSON.parse(instRaw.toString('utf8'));
  for (const k of ['nodeIdentitySha256', 'nodeProfileSha256', 'residentManifestSha256', 'stateCompat', 'upgrader']) need(inst[k] !== undefined && inst[k] !== null, 'INSTALLED_PACKAGE_NOT_AN_UPGRADER_PACKAGE', k);
  const pinOf = t => inst.files.find(e => e.target === t)?.sha256 ?? null;
  const instFile = async (rel, target) => { const b = await fs.readFile(path.join(installedPackageDir, ...rel.split('/'))); need(sha(b) === pinOf(target), 'INSTALLED_PACKAGE_FILE_CHANGED', rel); return b; };
  // The root's copy of a package slot must be the package's (unreadable slots, e.g. the admin-only record, are listed).
  const rootSlot = async (target, code) => {
    let b;
    try { b = await fs.readFile(path.join(root, ...target.split('\\'))); } catch (e) {
      if (e?.code === 'EPERM' || e?.code === 'EACCES') { result.unreadable.push(target); return null; }
      throw e;
    }
    need(sha(b) === pinOf(target), code, target);
    return b;
  };
  const policyBytes = await rootSlot('config\\policy.json', 'INSTALLED_CONFIG_NOT_THE_CURRENT_PACKAGES') ?? await instFile('config/policy.json', 'config\\policy.json');
  const companionBytes = await rootSlot('config\\companion.json', 'INSTALLED_CONFIG_NOT_THE_CURRENT_PACKAGES') ?? await instFile('config/companion.json', 'config\\companion.json');
  for (const n of RECORD_FILES) await rootSlot(`record\\${n}`, 'INSTALLED_RECORD_NOT_THE_CURRENT_PACKAGES');
  const nodeExe = path.join(root, 'runtime', 'node.exe');
  need(sha(await fs.readFile(nodeExe)) === pinOf('runtime\\node.exe'), 'INSTALLED_RUNTIME_NOT_THE_CURRENT_PACKAGES');
  const instLinux = await fs.readFile(path.join(installedPackageDir, 'linux', 'manifest.json'));
  need(sha(instLinux) === inst.linux?.manifestSha256, 'INSTALLED_LINUX_MANIFEST_NOT_THE_PACKAGES');
  const policy = pyLoads(policyBytes.toString('utf8'));
  const companion = pyLoads(companionBytes.toString('utf8').replace(/^\uFEFF/, ''));
  const nodeName = policy?.node?.nodeName;

  // 3. the record: the installed references, this commit's Source
  const profileRel = await profileFor(tree, nodeName, inst.nodeProfileSha256);
  const ri = recordInputs({ basePackage: installedPackageDir, tree, commit: universal.commit, node: nodeName, nodeProfile: profileRel, distribution: policy?.linux?.distribution });
  need(ri.base.acc.node.nodeName === nodeName, 'INSTALLED_PACKAGE_IS_FOR_ANOTHER_NODE');
  await fs.writeFile(path.join(inputs, 'record-inputs.json'), ri.bytes, { flag: 'wx' });
  const record = path.join(workDir, 'record');
  const closure = path.join(tree, ...CLOSURE.split('/'));
  const prep = run(node, [path.join(tree, ...PREPARE_RECORD.split('/')), '--inputs', path.join(inputs, 'record-inputs.json'), '--source-root', tree, '--closure', closure, '--out', record]);
  need(prep.status === 0, 'PREPARE_RECORD_FAILED', prep.stderr);
  const chk = run(node, [path.join(R, 'reinstall', 'tools', 'check-record.mjs'), tree, record]);
  need(chk.status === 0, 'RECORD_V2_REFUSED_BY_RUNTIME_VALIDATOR', parsed(chk.last)?.code ?? chk.stderr);
  const closurePaths = JSON.parse((await fs.readFile(closure)).toString('utf8')).paths;
  await fs.writeFile(path.join(inputs, 'source-files.txt'), closurePaths.join('\n') + '\n', { flag: 'wx' });
  const manifestBytes = await fs.readFile(path.join(record, 'source-manifest.json'));
  const ciSha = sha(manifestBytes);

  // 4. policy and companion from the installed configuration
  const installedCi = inst.ciSourceManifestSha256;
  for (const k of ['relayScript', 'bundleScript']) {
    const s = companion?.companion?.[k];
    const at = `\\source\\${installedCi}\\`;
    need(typeof s === 'string' && s.split(at).length === 2, 'INSTALLED_COMPANION_SCRIPT_NOT_UNDER_ITS_SOURCE', k);
    companion.companion[k] = s.replace(at, '\\source\\<sourceManifestSha256>\\');
  }
  delete companion.companion.bridgeManifestSha256;
  const ni = nodeInputs({ policy, companion, profile: ri.profile, profileSha256: ri.profileSha256, decision: target.id, receipt: target.receipt_id });
  await fs.writeFile(path.join(inputs, 'policy.input.json'), ni.policyBytes, { flag: 'wx' });
  await fs.writeFile(path.join(inputs, 'companion.input.json'), ni.companionBytes, { flag: 'wx' });

  // 5. the Linux half
  const bpText = (await fs.readFile(path.join(R, 'tools', 'build-package.mjs'))).toString('utf8');
  const pins = linuxPins({ installedManifest: instLinux, buildPackageText: bpText, readTreeFile });
  await fs.writeFile(path.join(inputs, 'linux-external-pins.json'), pins.bytes, { flag: 'wx' });
  const bundle = path.join(x, ...BUNDLE_NAME.split('/'));
  const heads = bundleHeads(await fs.readFile(bundle));
  need(heads.length === 1 && heads[0] === `${universal.commit} refs/heads/accepted`, 'BUNDLE_NOT_ONLY_THE_ACCEPTED_COMMIT', heads);
  const responses = path.join(root, 'upgrade', 'mailbox', 'responses');
  const rolesPublic = await readOrNull(path.join(responses, 'roles-public.json'));
  const roles = rolesDerived({ toolBytes: await fs.readFile(path.join(tree, ...TOOL_PATH.split('/'))), readSourceFile, manifestBytes, ciSha,
    factsBytes: await fs.readFile(path.join(responses, 'version-facts.json')), rolesPublic, now });
  await fs.writeFile(path.join(inputs, 'source-v2.json'), JSON.stringify({ commit: universal.commit, bundle,
    rolesDerivedSha256: { gitleaks: roles.rolesDerivedSha256.gitleaks, trivy: roles.rolesDerivedSha256.trivy, 'contract-placement': roles.rolesDerivedSha256['contract-placement'] } }, null, 2), { flag: 'wx' });
  const stateCompat = universal.stateCompat ?? inst.stateCompat;
  await fs.writeFile(path.join(inputs, 'state-compat.json'), pyDumps(stateCompat, { sortKeys: true }) + '\n', { flag: 'wx' });

  // 6. the package, twice, with the archive's build-package.mjs
  const build = out => {
    const r = run(node, [path.join(R, 'tools', 'build-package.mjs'), '--out', out, '--policy', path.join(inputs, 'policy.input.json'), '--companion', path.join(inputs, 'companion.input.json'),
      '--node', nodeExe, '--record', record, '--source-root', tree, '--source-files', path.join(inputs, 'source-files.txt'),
      '--linux-external-pins', path.join(inputs, 'linux-external-pins.json'), '--source-v2', path.join(inputs, 'source-v2.json'), '--state-compat', path.join(inputs, 'state-compat.json')], { cwd: R });
    need(r.status === 0 && parsed(r.last)?.packageManifestSha256, 'BUILD_PACKAGE_FAILED', r.stderr);
    return parsed(r.last);
  };
  const packageDir = path.join(workDir, 'package');
  const first = build(packageDir);
  const again = build(path.join(workDir, 'package-rebuild'));
  need(first.packageManifestSha256 === again.packageManifestSha256, 'PACKAGE_NOT_REPRODUCIBLE');
  const pkgRaw = await fs.readFile(path.join(packageDir, 'package-manifest.json'));
  need(sha(pkgRaw) === first.packageManifestSha256, 'PACKAGE_CHANGED');
  const m = JSON.parse(pkgRaw.toString('utf8'));
  result.linuxShape = linuxPinsCheck({ packageManifest: await fs.readFile(path.join(packageDir, 'linux', 'manifest.json')), installedManifest: instLinux, readTreeFile });
  need(m.nodeIdentitySha256 === inst.nodeIdentitySha256, 'UPGRADE_NODE_IDENTITY_WOULD_CHANGE');
  need(m.nodeProfileSha256 === inst.nodeProfileSha256, 'UPGRADE_NODE_PROFILE_WOULD_CHANGE');
  const got = { resident_manifest_sha256: m.residentManifestSha256, source_manifest_sha256: m.sourceManifestSha256,
    upgrader_manifest_sha256: m.upgrader?.manifestSha256, commit: m.linux?.sourceV2?.commit, bundle_sha256: m.linux?.sourceV2?.bundleSha256,
    universal_files_sha256: universalFilesSha256(m.files, m.residentManifestSha256, m.ciSourceManifestSha256) };
  const differ = Object.keys(got).filter(k => got[k] !== target[k]);
  need(differ.length === 0 && m.acceptance?.decisionRef === target.id, 'FLEET_PACKAGE_NOT_THE_ACCEPTED_SOURCE', { fields: differ });
  // 7. the precheck: the installed upgrader's ACCEPT on this node, read-only (the archive's precheck.mjs)
  const pre = run(node, [path.join(R, 'rollout', 'precheck.mjs'), '--root', root, '--package', packageDir, '--package-sha', first.packageManifestSha256,
    '--acceptance', target.id, '--installed-package', installedPackageDir]);
  const precheck = parsed(pre.last) ?? { status: 'PRECHECK_FAILED', detail: pre.stderr };
  const pass = pre.status === 0 && typeof precheck.status === 'string' && precheck.status.startsWith('PRECHECK_PASS');
  return { ...result, status: pass ? 'FLEET_PACKAGE_ASSEMBLED' : 'FLEET_PACKAGE_ASSEMBLED_PRECHECK_REFUSED', node: nodeName, packageDir,
    packageManifestSha256: first.packageManifestSha256, grantResource: `ci-resident:${nodeName}/${first.packageManifestSha256}`,
    universal: got, rolesCopySource: roles.copySource, precheck };
}

// The node profile file of the archive's tree that is this node's installed profile (by name and canonical sha256).
async function profileFor(tree, nodeName, profileSha) {
  const dir = path.join(tree, ...RESIDENT.split('/'), 'config');
  for (const name of (await fs.readdir(dir)).sort()) {
    if (!/^node-profile\.[a-z0-9-]+\.json$/.test(name)) continue;
    let p = null;
    try { p = pyLoads((await fs.readFile(path.join(dir, name))).toString('utf8')); } catch { continue; }
    if (p?.nodeName !== nodeName) continue;
    try {
      if (nodeProfileOf(tree, `config/${name}`, nodeName, p.wslDistribution).profileSha256 === profileSha) return `config/${name}`;
    } catch { /* not this node's */ }
  }
  throw new Refused('UPGRADE_NODE_PROFILE_NOT_IN_ARCHIVE', { node: nodeName, nodeProfileSha256: profileSha });
}

export async function main(argv) {
  const { values } = parseArgs({ args: argv, options: { artifact: { type: 'string' }, 'artifact-sha': { type: 'string' }, target: { type: 'string' }, 'work-dir': { type: 'string' },
    root: { type: 'string' }, 'installed-package': { type: 'string' }, 'search-dir': { type: 'string', multiple: true } } });
  const root = values.root ?? DEFAULT_ROOT;
  const target = JSON.parse((await fs.readFile(values.target)).toString('utf8'));
  const installedPackageDir = values['installed-package'] ?? await findInstalledPackage({ root, searchDirs: values['search-dir'] ?? [] });
  need(installedPackageDir, 'INSTALLED_PACKAGE_NOT_FOUND');
  return assembleUpgrade({ artifactPath: values.artifact, artifactSha256: values['artifact-sha'], target, root, installedPackageDir, workDir: values['work-dir'] });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(r => { console.log(JSON.stringify(r)); process.exitCode = r.status === 'FLEET_PACKAGE_ASSEMBLED' ? 0 : 1; }, e => {
    console.log(JSON.stringify({ contract: ASSEMBLY_CONTRACT, status: 'FLEET_ASSEMBLY_REFUSED', code: e?.code ?? 'FLEET_ASSEMBLY_FAILED', detail: e?.detail ?? String(e?.message ?? e).slice(0, 300) }));
    process.exitCode = 1;
  });
}
