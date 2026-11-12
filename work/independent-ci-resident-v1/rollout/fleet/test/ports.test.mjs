// Differential tests (Decision b5d041d2 v2): every JavaScript port in rollout/fleet runs next to its Python original on the same
// fixture, and the outputs must be byte-identical (refusals: the same code). The Python side runs with `python -I`; on a machine
// without Python these tests are skipped with that reason (the node never needs Python; the publishing and development machines have it).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { BIND, PIN_FILES, SOURCE_KEYS, TRUSTED_SOURCE, canonicalBytes, deriveRole, linuxPins, linuxPinsCheck, nodeInputs, recordInputs, rolesDerived } from '../ports.mjs';
import { pyCanonical, pyDumps, pyLoads } from '../pyjson.mjs';
import { assembleRecord } from '../../../../actions-hosted-migration/independent-ci-v1/src/resident-v2/prepare-record.mjs';
import { nodeProfile, recordInputs as fixtureInputs, roles, signerKeys, sourceFiles } from '../../../../actions-hosted-migration/independent-ci-v1/test/resident-v2-fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RES = path.resolve(HERE, '..', '..', '..');
const ORACLE = path.join(HERE, 'oracle.py');
const TOOL = path.join(RES, 'linux', 'bin', 'clued-ci-upgrade-linux');
const sha = b => createHash('sha256').update(b).digest('hex');
const PY = (() => { for (const c of ['python', 'python3']) { const r = spawnSync(c, ['-I', '-c', 'import sys; print(sys.version_info[0])']); if (r.status === 0 && String(r.stdout).trim() === '3') return c; } return null; })();
const skip = PY ? false : 'no Python 3 on this machine: the differential tests need the Python originals';
const py = (args, input) => spawnSync(PY, ['-I', '-B', ...args], { input, maxBuffer: 1 << 26 });
const winOnly = os.platform() === 'win32' ? false : 'rconfig.py requires Windows paths';

async function tmp(t) {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'fleetports'));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return d;
}
const put = async (file, data) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, data); };

test('pyjson: json.dumps byte for byte (sort_keys, separators, ensure_ascii, indent, floats, escapes)', { skip }, () => {
  const texts = ['{"b":1,"a":[1.5,2.0,-0.0,1e-05,1e16,123456789012345.6,0.0001,3e-7,1e22],"c":"caf\\u00e9 \\u4e2d \\ud83d\\ude00 \\u007f \\u0001\\n\\t\\"\\\\/"}',
    '[{"installedPath":"/x","sha256":"aa"},{}]', '{"z":{"y":[],"x":{}},"\\u00e9":true,"e":false,"n":null,"i":-12}', '[]', '{}', '"\\u2028"'];
  const opts = [{ sort_keys: true, separators: [',', ':'], ensure_ascii: false }, { sort_keys: true, separators: [',', ':'] }, { indent: 2 }, { indent: 1, sort_keys: true }, {}];
  const cases = texts.flatMap(t => opts.map(o => [t, o]));
  const r = py([ORACLE, 'dumps'], JSON.stringify(cases));
  assert.equal(r.status, 0, String(r.stderr));
  const want = JSON.parse(r.stdout);
  cases.forEach(([t, o], k) => {
    const got = pyDumps(pyLoads(t), { sortKeys: o.sort_keys ?? false, separators: o.separators ?? null, ensureAscii: o.ensure_ascii ?? true, indent: o.indent ?? null });
    assert.equal(got, want[k], `${t} ${JSON.stringify(o)}`);
  });
});

// One base (installed) package: its record and the pins of its package manifest.
async function basePackage(dir, { node = nodeProfile(), extraRoleValue = true } = {}) {
  const formalRoles = roles();
  if (extraRoleValue) formalRoles.trivy.extra = { ratio: 2.5, whole: 2, label: 'caf\u00e9 \u4e2d' };
  const inputs = fixtureInputs({ node, formalRoles });
  const { files, recordManifest } = assembleRecord(inputs, sourceFiles());
  const all = { ...files, 'record-manifest.json': JSON.stringify(recordManifest) };
  for (const [n, text] of Object.entries(all)) await put(path.join(dir, 'record', n), text);
  const pins = Object.entries(all).map(([n, text]) => ({ path: `record/${n}`, target: `record\\${n}`, sha256: sha(Buffer.from(text)) }));
  await put(path.join(dir, 'package-manifest.json'), JSON.stringify({ contract: 'x', files: pins }));
  return { inputs, files: all };
}

function rconfigDoc(d, { node, base, policyInput = 'C:\\p.json', companionInput = 'C:\\c.json', signer = null, nodeRecord = {} }) {
  return { contract: 'clued.independent-ci.reinstall-config/1', node: node.nodeName, nodeProfile: `config/node-profile.${node.nodeName}.json`, workDir: d, repo: 'C:\\repo',
    basePackage: base, nodeRecord, nodeExe: 'C:\\node.exe', policyInput, companionInput, upgradeTokenFile: 'C:\\t\\resident-upgrade.token',
    runner: { binary: '"C:\\r\\RunnerService.exe"', sddl: 'D:(A;;;;;SY)' }, launcher: { pauseReason: 'p', rearmReason: 'r', w1PauseReason: 'w' },
    linux: { distribution: node.wslDistribution, installedManifest: 'C:\\i\\m.json', installedRoles: 'C:\\i\\roles-v3', host: { toolchainNodeSha256: 'b'.repeat(64), resultPublicKeySha256: 'c'.repeat(64), v1SourceHead: 'f'.repeat(40) } },
    ...(signer ? { signer } : {}) };
}

test('record-inputs.py without --ref == recordInputs, byte for byte (installed signer registry, and a configured signer)', { skip: skip || winOnly }, async t => {
  const d = await tmp(t);
  const node = nodeProfile();
  const base = path.join(d, 'base');
  await basePackage(base, { node });
  const tree = path.join(d, 'tree');
  await put(path.join(tree, 'work', 'independent-ci-resident-v1', 'config', `node-profile.${node.nodeName}.json`), JSON.stringify(node, null, 2));
  const commit = '1234567890abcdef1234567890abcdef12345678';
  const sk = signerKeys();
  for (const signer of [null, { keyId: 'test-key-2', runtimeId: 'fixture-runtime-2', publicKeyPem: sk.publicKeyPem }]) {
    const cfg = path.join(d, `cfg-${signer ? 's' : 'n'}.json`);
    await put(cfg, JSON.stringify(rconfigDoc(d, { node, base, signer })));
    const out = path.join(d, `inputs-${signer ? 's' : 'n'}.json`);
    const r = py([path.join(RES, 'reinstall', 'tools', 'record-inputs.py'), cfg, tree, commit, out]);
    assert.equal(r.status, 0, String(r.stderr) + String(r.stdout));
    const js = recordInputs({ basePackage: base, tree, commit, node: node.nodeName, nodeProfile: `config/node-profile.${node.nodeName}.json`, distribution: node.wslDistribution, signer });
    assert.ok(js.bytes.equals(await fs.readFile(out)), 'the same bytes');
  }
  // refusals keep their codes: a record file that is not its package's
  await fs.appendFile(path.join(base, 'record', 'signers.json'), ' ');
  assert.throws(() => recordInputs({ basePackage: base, tree, commit, node: node.nodeName, nodeProfile: `config/node-profile.${node.nodeName}.json`, distribution: node.wslDistribution }),
    { code: 'BASE_RECORD_FILE_NOT_ITS_PACKAGE' });
  const r = py([path.join(RES, 'reinstall', 'tools', 'record-inputs.py'), path.join(d, 'cfg-n.json'), tree, commit, path.join(d, 'again.json')]);
  assert.match(String(r.stderr), /BASE_RECORD_FILE_NOT_ITS_PACKAGE/);
});

test('node-inputs.py == nodeInputs, byte for byte; the same refusal for a base node left behind', { skip: skip || winOnly }, async t => {
  const d = await tmp(t);
  const baseNode = nodeProfile();
  const node = nodeProfile({ nodeName: 'fixture-b', hostname: 'FIXTURE-B', ownerSid: 'S-1-5-21-1-2-3-1002', mutationMutex: 'Global\\CluedControlControllerMutationV1-FIXTURE-B-1015',
    runnerService: 'actions.runner.tdoljyj-cross-memory-system.clued-ci-fixture-b', ownerProfileDirectory: 'C:\\Users\\fixture-b' });
  const policy = JSON.parse(await fs.readFile(path.join(RES, 'config', 'policy.example.json'), 'utf8'));
  Object.assign(policy, { node: baseNode, nodeProfileSha256: 'a'.repeat(64), ratio: 0.5, label: 'caf\u00e9' });
  policy.companion.userSid = baseNode.ownerSid; policy.linux.distribution = baseNode.wslDistribution;
  const companion = JSON.parse(await fs.readFile(path.join(RES, 'config', 'companion.example.json'), 'utf8'));
  Object.assign(companion.companion, { node: baseNode, nodeProfileSha256: 'a'.repeat(64), distribution: baseNode.wslDistribution });
  companion.status = { ...(companion.status ?? {}), node: baseNode.nodeName };
  const pFile = path.join(d, 'p.json'), cFile = path.join(d, 'c.json');
  await put(pFile, JSON.stringify(policy, null, 2)); await put(cFile, '\uFEFF' + JSON.stringify(companion));
  const tree = path.join(d, 'tree');
  await put(path.join(tree, 'work', 'independent-ci-resident-v1', 'config', `node-profile.${node.nodeName}.json`), JSON.stringify(node));
  const cfg = path.join(d, 'cfg.json');
  await put(cfg, JSON.stringify(rconfigDoc(d, { node, base: 'C:\\base', policyInput: pFile, companionInput: cFile })));
  const [dec, rec] = [randomUUID(), randomUUID()];
  const r = py([path.join(RES, 'reinstall', 'tools', 'node-inputs.py'), cfg, tree, dec, rec, path.join(d, 'po.json'), path.join(d, 'co.json')]);
  assert.equal(r.status, 0, String(r.stderr));
  const profile = pyLoads(await fs.readFile(path.join(tree, 'work', 'independent-ci-resident-v1', 'config', `node-profile.${node.nodeName}.json`), 'utf8'));
  const js = nodeInputs({ policy: pyLoads(await fs.readFile(pFile, 'utf8')), companion: pyLoads((await fs.readFile(cFile, 'utf8')).replace(/^\uFEFF/, '')),
    profile, profileSha256: sha(Buffer.from(pyCanonical(profile))), decision: dec, receipt: rec });
  assert.ok(js.policyBytes.equals(await fs.readFile(path.join(d, 'po.json'))), 'policy bytes');
  assert.ok(js.companionBytes.equals(await fs.readFile(path.join(d, 'co.json'))), 'companion bytes');
  // the base node's profile directory left in another field
  const leaky = { ...policy, someDir: `${baseNode.ownerProfileDirectory}\\x` };
  await put(pFile, JSON.stringify(leaky));
  const r2 = py([path.join(RES, 'reinstall', 'tools', 'node-inputs.py'), cfg, tree, dec, rec, path.join(d, 'po2.json'), path.join(d, 'co2.json')]);
  assert.match(String(r2.stderr), /NODE_INPUT_KEEPS_THE_BASE_NODE/);
  assert.throws(() => nodeInputs({ policy: pyLoads(JSON.stringify(leaky)), companion: pyLoads(JSON.stringify(companion)), profile, profileSha256: 'a'.repeat(64), decision: dec, receipt: rec }),
    { code: 'NODE_INPUT_KEEPS_THE_BASE_NODE' });
});

test('linux-pins.py pins/check == linuxPins/linuxPinsCheck (bytes; result; refusal)', { skip }, async t => {
  const d = await tmp(t);
  const tree = path.join(d, 'tree');
  const bp = await fs.readFile(path.join(RES, 'tools', 'build-package.mjs'));
  await put(path.join(tree, 'work', 'independent-ci-resident-v1', 'tools', 'build-package.mjs'), bp);
  const rels = ['work/actions-hosted-migration/independent-ci-v1/worker/protected-job-bridge-v4/linux-worker.mjs', 'work/a/\u00e9t\u00e9.py'];
  for (const [k, rel] of rels.entries()) await put(path.join(tree, ...rel.split('/')), `file ${k}\n`);
  const own = ['/opt/clued-independent-ci/resident-v1/bin/clued-ci-resident-linux', '/etc/systemd/system/clued-ci-worker@.service', '/etc/systemd/system/clued-ci-wsprep@.service', '/etc/systemd/system/clued-ci-archive@.service'];
  const inst = { contract: 'clued.independent-ci.resident-linux-manifest/2', files: [...own.map((p, k) => ({ installedPath: p, sha256: String(k).repeat(64) })),
    ...rels.map(r => ({ installedPath: `/opt/clued-independent-ci/source-v2/${r}`, sha256: 'a'.repeat(64) })),
    { installedPath: '/var/lib/clued-independent-ci/toolchain-build-legacy-v1/node', sha256: 'c'.repeat(64) }] };
  const instFile = path.join(d, 'inst.json');
  await put(instFile, JSON.stringify(inst));
  const readTreeFile = rel => readFileSync(path.join(tree, ...rel.split('/')));
  for (const node of [null, 'd'.repeat(64)]) {
    const out = path.join(d, `pins-${node ? 'n' : 'x'}.json`);
    const r = py([path.join(RES, 'reinstall', 'tools', 'linux-pins.py'), 'pins', instFile, out, tree, ...(node ? ['--toolchain-node', node] : [])]);
    assert.equal(r.status, 0, String(r.stderr));
    const js = linuxPins({ installedManifest: await fs.readFile(instFile), buildPackageText: bp.toString('utf8'), readTreeFile, toolchainNode: node });
    assert.ok(js.bytes.equals(await fs.readFile(out)), 'pins bytes');
    // check: a package manifest with the same shape
    const pkg = { contract: inst.contract, files: [...inst.files.slice(0, 4).map(f => ({ ...f, sha256: 'e'.repeat(64) })), ...js.pins] };
    const pkgFile = path.join(d, 'pkg.json');
    await fs.writeFile(pkgFile, JSON.stringify(pkg));
    const c = py([path.join(RES, 'reinstall', 'tools', 'linux-pins.py'), 'check', pkgFile, instFile, tree, ...(node ? ['--toolchain-node', node] : [])]);
    assert.equal(c.status, 0, String(c.stderr));
    assert.deepEqual(linuxPinsCheck({ packageManifest: await fs.readFile(pkgFile), installedManifest: await fs.readFile(instFile), readTreeFile, toolchainNode: node }), JSON.parse(c.stdout));
    // an external pin that is not the new Source's
    pkg.files[4] = { ...pkg.files[4], sha256: 'f'.repeat(64) };
    await fs.writeFile(pkgFile, JSON.stringify(pkg));
    const bad = py([path.join(RES, 'reinstall', 'tools', 'linux-pins.py'), 'check', pkgFile, instFile, tree, ...(node ? ['--toolchain-node', node] : [])]);
    assert.match(String(bad.stderr), /LINUX_EXTERNAL_PINS_NOT_THE_NEW_SOURCE/);
    assert.throws(() => linuxPinsCheck({ packageManifest: Buffer.from(JSON.stringify(pkg)), installedManifest: Buffer.from(JSON.stringify(inst)), readTreeFile, toolchainNode: node }),
      { code: 'LINUX_EXTERNAL_PINS_NOT_THE_NEW_SOURCE' });
  }
});

async function oracleDerive() {
  const r = py([ORACLE, 'derive']);
  assert.equal(r.status, 0, String(r.stderr));
  return JSON.parse(r.stdout);
}

test('frozen tool: derive_role/canonical_bytes == deriveRole/canonicalBytes on the tool\'s own offline fixtures (results and refusals)', { skip }, async () => {
  const o = await oracleDerive();
  assert.deepEqual({ SOURCE_KEYS: [...SOURCE_KEYS], PIN_FILES: { ...PIN_FILES }, BIND: [...BIND], TRUSTED_SOURCE },
    { SOURCE_KEYS: o.constants.SOURCE_KEYS, PIN_FILES: o.constants.PIN_FILES, BIND: o.constants.BIND, TRUSTED_SOURCE: o.constants.TRUSTED_SOURCE });
  const files = new Map(Object.entries(o.files).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
  const manifest = Buffer.from(o.manifest, 'base64');
  const fileSha = rel => { if (!files.has(rel)) throw Object.assign(new Error('x'), { code: 'PINNED_FILE_MISSING_IN_NEW_COMMIT' }); return sha(files.get(rel)); };
  const seen = new Set();
  for (const c of o.cases) {
    const pol = pyLoads(Buffer.from(c.policy, 'base64').toString('utf8')), pay = pyLoads(Buffer.from(c.payload, 'base64').toString('utf8'));
    let got;
    try { const [np, nq] = deriveRole(c.role, pol, pay, o.manifestSha256, pyLoads(manifest.toString('utf8')), fileSha); got = { newPolicy: canonicalBytes(np).toString('base64'), newPayload: canonicalBytes(nq).toString('base64') }; }
    catch (e) { got = { code: e.code }; }
    const want = c.code ? { code: c.code } : { newPolicy: c.newPolicy, newPayload: c.newPayload };
    assert.deepEqual(got, want, `${c.role} ${c.name}`);
    seen.add(c.code ?? 'OK');
  }
  assert.deepEqual([...seen].sort(), ['ENTRY_OUTSIDE_TRUSTED', 'INSTALLED_PAYLOAD_NOT_ITS_POLICY', 'INSTALLED_QUALIFICATION_REFUSED', 'LINUX_HOST_FACTS_CHANGED', 'OK', 'PINNED_FILE_MISSING_IN_NEW_COMMIT'].sort());
});

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x', GIT_AUTHOR_DATE: '2026-10-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-10-01T00:00:00Z', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, ...args) => { const r = spawnSync('git', args, { cwd, env: GIT_ENV }); assert.equal(r.status, 0, String(r.stderr)); return String(r.stdout).trim(); };

test('roles-derived.py == rolesDerived end to end (the companion copy, fresh facts, the frozen tool of the tree); same refusals', { skip }, async t => {
  const o = await oracleDerive();
  const d = await tmp(t);
  const repo = path.join(d, 'repo'), tree = path.join(d, 'tree');
  for (const [rel, b64] of Object.entries(o.files)) { await put(path.join(repo, ...rel.split('/')), Buffer.from(b64, 'base64')); await put(path.join(tree, ...rel.split('/')), Buffer.from(b64, 'base64')); }
  git(repo, 'init', '-q'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'B');
  const commit = git(repo, 'rev-parse', 'HEAD');
  const tool = await fs.readFile(TOOL);
  await put(path.join(tree, 'work', 'independent-ci-resident-v1', 'linux', 'bin', 'clued-ci-upgrade-linux'), tool);
  const ok = o.cases.filter(c => c.name === 'floats-and-unicode');
  const copy = {}, factsRoles = {};
  for (const c of ok) {
    const pb = Buffer.from(c.policy, 'base64');
    const qb = canonicalBytes({ payload: pyLoads(Buffer.from(c.payload, 'base64').toString('utf8')), signature: 'c2lnbmVk' });
    copy[`${c.role}.json`] = { sha256: sha(pb), base64: pb.toString('base64') };
    copy[`${c.role}.qualification.json`] = { sha256: sha(qb), base64: qb.toString('base64') };
    factsRoles[c.role] = { policySha256: sha(pb), qualificationSha256: sha(qb) };
  }
  const resp = path.join(d, 'responses');
  const now = new Date().toISOString();
  const facts = { contract: 'clued.independent-ci.linux-version-facts/1', generation: 3, roles: factsRoles, upgradeToolSha256: sha(tool), observedAt: now };
  await put(path.join(resp, 'version-facts.json'), JSON.stringify(facts));
  await put(path.join(resp, 'roles-public.json'), JSON.stringify({ contract: 'clued.independent-ci.linux-roles-public/1', generation: 3, factsObservedAt: now, observedAt: now, files: copy }));
  const manifest = Buffer.from(o.manifest, 'base64');
  await put(path.join(d, 'source-manifest.json'), manifest);
  const runPy = () => {
    const r = py([path.join(RES, 'rollout', 'tools', 'roles-derived.py'), tree, repo, commit, path.join(d, 'empty'), path.join(d, 'source-manifest.json'), o.manifestSha256, path.join(resp, 'version-facts.json')]);
    return JSON.parse(String(r.stdout).trim().split('\n').at(-1));
  };
  const runJs = async () => {
    try {
      return rolesDerived({ toolBytes: tool, readSourceFile: rel => (o.files[rel] ? Buffer.from(o.files[rel], 'base64') : null), manifestBytes: manifest, ciSha: o.manifestSha256,
        factsBytes: readFileSync(path.join(resp, 'version-facts.json')), rolesPublic: readFileSync(path.join(resp, 'roles-public.json')) });
    } catch (e) { return { status: 'REFUSED', code: e.code }; }
  };
  const a = runPy(), b = await runJs();
  assert.equal(a.status, 'ROLES_DERIVED', JSON.stringify(a));
  assert.deepEqual(b.rolesDerivedSha256, a.rolesDerivedSha256);
  assert.deepEqual([b.upgradeToolSha256, b.copySource], [a.upgradeToolSha256, a.copySource]);
  // and each is the hash of the derived policy the oracle printed (floats stay floats, non-ASCII stays as is)
  for (const c of ok) assert.equal(a.rolesDerivedSha256[c.role], sha(Buffer.from(c.newPolicy, 'base64')));
  // refusals: a copy byte changed; stale facts; a tool that is not the installed one
  const pub = JSON.parse(readFileSync(path.join(resp, 'roles-public.json'), 'utf8'));
  pub.files['trivy.json'].sha256 = 'f'.repeat(64);
  await fs.writeFile(path.join(resp, 'roles-public.json'), JSON.stringify(pub));
  assert.deepEqual([runPy().code, (await runJs()).code], ['ROLES_PUBLIC_COPY_REFUSED', 'ROLES_PUBLIC_COPY_REFUSED']);
  await fs.writeFile(path.join(resp, 'version-facts.json'), JSON.stringify({ ...facts, observedAt: '2026-01-01T00:00:00Z' }));
  assert.deepEqual([runPy().code, (await runJs()).code], ['LINUX_VERSION_FACTS_NOT_FRESH', 'LINUX_VERSION_FACTS_NOT_FRESH']);
  await fs.writeFile(path.join(resp, 'version-facts.json'), JSON.stringify({ ...facts, upgradeToolSha256: 'e'.repeat(64) }));
  assert.deepEqual([runPy().code, (await runJs()).code], ['LINUX_UPGRADE_TOOL_IS_NOT_THE_INSTALLED_ONE', 'LINUX_UPGRADE_TOOL_IS_NOT_THE_INSTALLED_ONE']);
});
