// Fixtures for the fleet tests: a small git repository whose one commit is this checkout's universal tree subset (plus fixture node
// profiles), and node sites: a REAL /4 package built by this checkout's build-package.mjs from a fixture record (each node its own
// profile, identity, signer and policy; the fleet record facts shared), installed as generation 1 into a temporary root
// (upgrader/test/fixtures.mjs installGeneration1), with the companion's roles-public.json copy and fresh version facts.
// Nothing here touches a real host directory, the network or a secret.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectTree } from '../universal.mjs';
import { TRUSTED_SOURCE, canonicalBytes } from '../ports.mjs';
import { PyFloat } from '../pyjson.mjs';
import { buildPackage } from '../../../tools/build-package.mjs';
import { nodeProfileSha256 } from '../../../src/node-profile.mjs';
import { installGeneration1 } from '../../../upgrader/test/fixtures.mjs';
import { assembleRecord, writeRecord } from '../../../../actions-hosted-migration/independent-ci-v1/src/resident-v2/prepare-record.mjs';
import { nodeProfile, recordInputs, roles, signerKeys, sourceFiles } from '../../../../actions-hosted-migration/independent-ci-v1/test/resident-v2-fixtures.mjs';

export const RES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const CHECKOUT = path.resolve(RES, '..', '..');
export const sha = b => createHash('sha256').update(b).digest('hex');
const hex = n => randomBytes(n).toString('hex');
const ENTRY = 'work/actions-hosted-migration/independent-ci-v1/worker/protected-job-bridge-v4/linux-worker.mjs';
const TOOL = path.join(RES, 'linux', 'bin', 'clued-ci-upgrade-linux');

export async function tempDir(t, prefix = 'fleet') {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(d, { recursive: true, force: true, maxRetries: 3 }));
  return d;
}
const put = async (file, data) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, data); };

export const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_AUTHOR_DATE: '2026-11-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-11-01T00:00:00Z', GIT_CONFIG_NOSYSTEM: '1' };
export function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, env: GIT_ENV, maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

// node profiles of the fixture fleet (prepare-record.mjs#validateNodeProfile shapes)
export function profileOf(letter) {
  const name = `fixture-${letter}`, host = `FIXTURE-${letter.toUpperCase()}`;
  return nodeProfile({ nodeName: name, hostname: host, ownerSid: `S-1-5-21-1-2-3-${2000 + letter.charCodeAt(0)}`, ownerProfileDirectory: `C:\\Users\\owner-${letter}`,
    runnerService: `actions.runner.tdoljyj-cross-memory-system.clued-ci-${name}`, mutationMutex: `Global\\CluedControlControllerMutationV1-${host}-1015` });
}

// The checkout's universal subset (tracked files and this assembler's untracked ones), as one commit. No node profile:
// a package carries none (each node's comes from its installed record).
export async function fixtureRepo(t) {
  const d = await tempDir(t, 'fleetrepo');
  const listing = new Map();
  for (const rec of git(CHECKOUT, 'ls-files', '-s', '-z').toString('utf8').split('\0').filter(Boolean)) {
    const tab = rec.indexOf('\t'); const [mode, oid] = rec.slice(0, tab).split(' ');
    listing.set(rec.slice(tab + 1), { mode, oid });
  }
  for (const p of git(CHECKOUT, 'ls-files', '-z', '--others', '--exclude-standard', '--', 'work/independent-ci-resident-v1').toString('utf8').split('\0').filter(Boolean)) {
    listing.set(p, { mode: '100644', oid: null });
  }
  const read = async paths => new Map(await Promise.all(paths.map(async p => [p, await fs.readFile(path.join(CHECKOUT, ...p.split('/')))])));
  const selected = await selectTree(listing, read);
  const repo = path.join(d, 'repo');
  for (const p of selected) await put(path.join(repo, ...p.split('/')), await fs.readFile(path.join(CHECKOUT, ...p.split('/'))));
  await put(path.join(repo, 'README.fixture'), 'not part of the universal subset\n');
  git(repo, '-c', 'core.autocrlf=false', 'init', '-q', '--initial-branch=main');
  git(repo, '-c', 'core.autocrlf=false', 'add', '-A');
  git(repo, '-c', 'core.autocrlf=false', 'commit', '-q', '-m', 'fixture');
  return { repo, commit: git(repo, 'rev-parse', 'HEAD').toString('utf8').trim(), selected };
}

export function fleetFacts() {
  return { sourceAcceptanceRef: randomUUID(), hostQualificationRef: randomUUID(), formalRoles: roles() };
}

function rolePolicy(role, letter, fleet, installedCi, { toolchainSha = hex(32), resultPublicKeySha256 = hex(32) } = {}) {
  const p = { schema: 'independent-ci.linux-policy.v3', role, formalEnabled: true, runtimeIdentity: `fixture-${letter}-runtime`, keyId: 'fixture-key', workspaceRoot: '/var/lib/clued-independent-ci/workspaces', runsRoot: '/var/lib/clued-independent-ci/runs',
    image: `sha256:${hex(32)}`, executionMode: role === 'contract-placement' ? 'node-entry' : 'scanner', dockerExecutable: '/usr/bin/docker', dockerExecutableSha256: hex(32),
    nodeExecutable: '/var/lib/clued-independent-ci/toolchain-build-legacy-v1/node', nodeExecutableSha256: toolchainSha, gitExecutable: '/usr/bin/git', gitExecutableSha256: hex(32),
    cpus: new PyFloat(1.5), entryFile: `${TRUSTED_SOURCE}/${ENTRY}`, trustedSourceDirectory: TRUSTED_SOURCE, hostAcceptanceRef: fleet.hostQualificationRef,
    sourceAcceptanceRef: fleet.sourceAcceptanceRef, sourceManifestSha256: installedCi, entrySha256: hex(32), qualificationSha256: hex(32), workerSha256: hex(32),
    proofSha256: hex(32), jobSha256: hex(32) };
  const BIND = ['runtimeIdentity', 'sourceManifestSha256', 'image', 'entrySha256', 'qualificationSha256', 'executionMode', 'workerSha256', 'proofSha256', 'jobSha256',
    'nodeExecutable', 'keyId', 'hostAcceptanceRef', 'sourceAcceptanceRef'];
  const q = { schema: 'independent-ci.runtime-qualification.v2', fixture: false, role, qualifiedAt: '2026-11-01T00:00:00.000Z', expiresAt: null, resultPublicKeySha256,
    ...Object.fromEntries(BIND.map(k => [k, p[k]])) };
  return { policy: canonicalBytes(p), qualification: canonicalBytes({ payload: q, signature: 'c2lnbmVk' }) };
}

// One node: its installed package (generation 1) and its root. `fleet`: the shared record facts (another value: a node outside the fleet).
// companionAccount: the node runs its companion under its own account (install\companion-account.json, the profile's ownerSid).
export async function nodeSite(t, letter, fleet, { now = Date.now(), companionAccount = false, heartbeat = false } = {}) {
  const d = await tempDir(t, `fleetnode${letter}`);
  const profile = profileOf(letter);
  const signer = signerKeys();
  const references = Object.fromEntries(['ownerAuthorizationRef', 'publisherQualificationRef', 'ciPrincipalQualificationRef', 'ownerPackageAcceptanceRef', 'installationReceiptRef']
    .map(k => [k, randomUUID()]));
  Object.assign(references, { sourceAcceptanceRef: fleet.sourceAcceptanceRef, hostQualificationRef: fleet.hostQualificationRef });
  // the record's controllerNodeSha256 is the installed runtime's (reinstall README section 8); the role policies share the node's toolchain node
  const nodeExe = Buffer.from(`fixture node runtime ${letter}\n`);
  const toolchainSha = hex(32), resultPublicKeySha256 = sha(Buffer.from(signer.publicKeyPem, 'ascii'));
  const inputs = recordInputs({ node: profile, formalRoles: fleet.formalRoles, sourceCommit: 'c'.repeat(40), controllerNodeSha256: sha(nodeExe),
    publishableKey: 'sb_publishable_0000000000' }, references, signer);   // the upgrader configuration's shape (a fresh install writes one)
  const record = path.join(d, 'record');
  writeRecord(record, assembleRecord(inputs, sourceFiles()));
  const policy = JSON.parse(await fs.readFile(path.join(RES, 'config', 'policy.example.json'), 'utf8'));
  Object.assign(policy, { node: profile, nodeProfileSha256: nodeProfileSha256(profile) });
  policy.companion.userSid = profile.ownerSid; policy.linux.distribution = profile.wslDistribution;
  const companion = JSON.parse(await fs.readFile(path.join(RES, 'config', 'companion.example.json'), 'utf8'));
  Object.assign(companion.companion, { node: profile, nodeProfileSha256: nodeProfileSha256(profile), distribution: profile.wslDistribution });
  await put(path.join(d, 'in', 'policy.json'), JSON.stringify(policy));
  await put(path.join(d, 'in', 'companion.json'), JSON.stringify(companion));
  await put(path.join(d, 'in', 'node.exe'), nodeExe);
  await put(path.join(d, 'in', 'old.bundle'), `old bundle ${letter}\n`);
  const pkgDir = path.join(d, 'packages', 'g1');
  await fs.mkdir(path.dirname(pkgDir), { recursive: true });
  const built = await buildPackage({ out: pkgDir, policyFile: path.join(d, 'in', 'policy.json'), companionFile: path.join(d, 'in', 'companion.json'), nodeExe: path.join(d, 'in', 'node.exe'),
    recordDir: record, sourceRoot: CHECKOUT, sourceFiles: ['work/actions-hosted-migration/independent-ci-v1/src/resident-v2/derive-batch.mjs'],
    linuxExternalPins: [{ installedPath: `${TRUSTED_SOURCE}/${ENTRY}`, sha256: hex(32) }, { installedPath: '/var/lib/clued-independent-ci/toolchain-build-legacy-v1/node', sha256: toolchainSha }],
    sourceV2: { commit: 'c'.repeat(40), bundle: path.join(d, 'in', 'old.bundle'), rolesDerivedSha256: { gitleaks: hex(32), trivy: hex(32), 'contract-placement': hex(32) } } });
  const mBytes = await fs.readFile(path.join(pkgDir, 'package-manifest.json'));
  const m = JSON.parse(mBytes.toString('utf8'));
  const files = new Map();
  for (const f of m.files) files.set(f.path, await fs.readFile(path.join(pkgDir, ...f.path.split('/'))));
  const pkg = { dir: pkgDir, sha: sha(mBytes), manifest: m, files, residentSha: m.residentManifestSha256, ciSource: m.ciSourceManifestSha256,
    policySha: sha(files.get('config/policy.json')), linuxSha: m.linux.manifestSha256 };
  const root = path.join(d, 'root');
  await installGeneration1(root, pkg, { upgraderManifest: m.upgrader.manifestSha256, nodeProfile: m.nodeProfileSha256, nodeIdentity: m.nodeIdentitySha256 });
  // the companion's copy of the installed roles-v3 and the version facts it sits next to
  const at = new Date(now).toISOString();
  const copy = {}, factsRoles = {};
  for (const role of ['gitleaks', 'trivy', 'contract-placement']) {
    const { policy: pb, qualification: qb } = rolePolicy(role, letter, fleet, m.ciSourceManifestSha256, { toolchainSha, resultPublicKeySha256 });
    copy[`${role}.json`] = { sha256: sha(pb), base64: pb.toString('base64') };
    copy[`${role}.qualification.json`] = { sha256: sha(qb), base64: qb.toString('base64') };
    factsRoles[role] = { policySha256: sha(pb), qualificationSha256: sha(qb) };
  }
  const responses = path.join(root, 'upgrade', 'mailbox', 'responses');
  await put(path.join(responses, 'version-facts.json'), JSON.stringify({ contract: 'clued.independent-ci.linux-version-facts/1', generation: 1, ciSourceManifestSha256: m.ciSourceManifestSha256,
    sourceCommit: 'c'.repeat(40), manifestSha256: m.linux.manifestSha256, roles: factsRoles, pinsOk: true, staged: null, upgradeToolSha256: sha(await fs.readFile(TOOL)), observedAt: at }));
  await put(path.join(responses, 'roles-public.json'), JSON.stringify({ contract: 'clued.independent-ci.linux-roles-public/1', generation: 1, factsObservedAt: at, observedAt: at, files: copy }));
  if (companionAccount) {
    await put(path.join(root, 'install', 'companion-account.json'), JSON.stringify({ contract: 'clued.independent-ci.companion-account/1',
      companionSid: profile.ownerSid, operatorSid: `S-1-5-21-1-2-3-${3000 + letter.charCodeAt(0)}` }));
    await put(path.join(root, 'install', 'companion-wsl.json'), JSON.stringify({ contract: 'clued.independent-ci.companion-wsl/1', distro: profile.wslDistribution,
      target: `D:\\fixture-resident\\wsl\\${profile.wslDistribution}\\ext4.vhdx`, companionSid: profile.ownerSid, stage: 'qualified', imported: true }));
  }
  // the receipt names the installed upgrade token (install-resident.ps1 receipt /6) and, with `heartbeat`, the heartbeat token (DESIGN
  // section 41.6a): targets and fingerprints only; current.json pins the receipt's bytes
  const receiptFile = path.join(root, 'install', 'install-receipt.json');
  const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
  receipt.upgradeToken = { target: 'C:\\ProgramData\\CluedIndependentCI\\resident\\secrets\\resident-upgrade.token', placed: true, fingerprint: hex(32) };
  if (heartbeat) receipt.heartbeatToken = { target: 'C:\\ProgramData\\CluedIndependentCI\\resident\\secrets\\heartbeat\\ci-node-heartbeat.token', placed: true, fingerprint: hex(32), bindingId: randomUUID() };
  const receiptBytes = Buffer.from(JSON.stringify(receipt));
  await fs.writeFile(receiptFile, receiptBytes);
  const currentFile = path.join(root, 'upgrade', 'current.json');
  const current = JSON.parse(await fs.readFile(currentFile, 'utf8'));
  current.installReceiptSha256 = sha(receiptBytes);
  await fs.writeFile(currentFile, JSON.stringify(current));
  return { dir: d, letter, profile, root, pkgDir, pkg, built, signer, toolchainSha, resultPublicKeySha256, references, nodeExe };
}

export const targetOf = (release, over = {}) => ({ id: randomUUID(), receipt_id: randomUUID(), ...release.source, ...over });

// publish.mjs's fake gh (a script run with node: ghCommand = [process.execPath, file]; never the real gh, never the network). It records its argv
// and whether a token variable reached it; "release view" answers from what "release create" and "release upload" put into FAKE_GH_STATE
// (assets of the release being published), or from state.other[<tag>] (the assets of another, earlier release, seeded by the test);
// "release download --pattern <name> --dir <dir>" writes that asset (its bytes kept as base64) into <dir>.
// FAKE_GH_FAIL_DOWNLOAD=<asset name>: that one download fails as a dropped connection does (acceptance-draft.log).
// A download into a --dir that already holds a file of that name fails, as the real gh does without --clobber (review r2).
export const FAKE_GH = `import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const asset = f => { const b = fs.readFileSync(f), name = f.split(/[\\\\/]/).pop(); return { name, size: b.length, sha256: createHash('sha256').update(b).digest('hex'), b64: b.toString('base64'), ...(name.endsWith('SHA256SUMS') ? { text: b.toString('utf8') } : {}) }; };
const state = process.env.FAKE_GH_STATE;
const log = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, 'utf8')) : { calls: [], assets: [] };
const args = process.argv.slice(2);
log.calls.push({ args, tokenSeen: ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'].filter(k => process.env[k] !== undefined) });
if (process.env.FAKE_GH_FAIL === '1') { fs.writeFileSync(state, JSON.stringify(log)); console.error('HTTP 422: fake failure'); process.exit(1); }
const nth = Number(process.env.FAKE_GH_FAIL_UPLOAD_NTH || 0);
if (nth && args[0] === 'release' && args[1] === 'upload' && log.calls.filter(c => c.args[1] === 'upload').length === nth) { fs.writeFileSync(state, JSON.stringify(log)); console.error('HTTP 502: fake upload failure'); process.exit(1); }
if (args[0] === 'release' && args[1] === 'delete-asset') log.assets = log.assets.filter(a => a.name !== args[3]);
const assetsOf = tag => (log.other && log.other[tag]) || log.assets;
if (args[0] === 'release' && args[1] === 'create') {
  const files = args.slice(3, args.indexOf('--repo'));
  log.assets = files.map(asset);
  console.log('https://github.com/' + args[args.indexOf('--repo') + 1] + '/releases/tag/' + args[2]);
}
if (args[0] === 'release' && args[1] === 'upload') log.assets.push(asset(args[3]));
// "gh api repos/<repo>/compare/main...<commit>": where the commit stands against main, from the state's compare (default behind: on main);
// fail: the call fails; garbled: an answer that is not the API's
if (args[0] === 'api' && /^repos\\/[^/]+\\/[^/]+\\/compare\\/main\\.\\.\\.[0-9a-f]{40}$/.test(args[1] ?? '')) {
  const c = log.compare || 'behind';
  if (c === 'fail') { fs.writeFileSync(state, JSON.stringify(log)); console.error('HTTP 502: fake compare failure'); process.exit(1); }
  console.log(c === 'garbled' ? '<html>' : JSON.stringify({ status: c, ahead_by: c === 'ahead' || c === 'diverged' ? 1 : 0 }));
}
if (args[0] === 'release' && args[1] === 'view') console.log(JSON.stringify({ url: 'https://github.com/' + args[args.indexOf('--repo') + 1] + '/releases/tag/' + args[2], tagName: args[2], assets: assetsOf(args[2]).map(a => ({ name: a.name, size: a.size })) }));
if (args[0] === 'release' && args[1] === 'download') {
  const name = args[args.indexOf('--pattern') + 1], dir = args[args.indexOf('--dir') + 1];
  if (process.env.FAKE_GH_FAIL_DOWNLOAD === name) { fs.writeFileSync(state, JSON.stringify(log)); console.error('net/http: TLS handshake timeout'); process.exit(1); }
  const a = assetsOf(args[2]).find(x => x.name === name);
  if (!a) { fs.writeFileSync(state, JSON.stringify(log)); console.error('no assets match the file pattern'); process.exit(1); }
  // as gh 2.97.0 does: a file of that name already in --dir is an error unless --clobber or --skip-existing is given
  if (fs.existsSync(path.join(dir, name)) && !args.includes('--clobber') && !args.includes('--skip-existing')) {
    fs.writeFileSync(state, JSON.stringify(log)); console.error(name + ' already exists (use --clobber to overwrite file or --skip-existing to skip file)'); process.exit(1);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), Buffer.from(a.b64, 'base64'));
}
fs.writeFileSync(state, JSON.stringify(log));
`;
