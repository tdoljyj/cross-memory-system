// precheck.mjs (DESIGN §42.3.2): the installed upgrader's ACCEPT against a node root, read-only. The packages carry the REAL upgrader
// copy of this tree (tools/build-package.mjs upgraderCopy), as every built package does, so the code that decides is the code under test.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { canonicalJson, sha256 } from '../../src/canonical.mjs';
import { upgraderCopy } from '../../tools/build-package.mjs';
import { DECISION, NODE, buildTestPackage, installGeneration1, tempDir } from '../../upgrader/test/fixtures.mjs';
import { precheck } from '../precheck.mjs';

const RESIDENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const T = Date.parse('2026-11-01T08:00:00.000Z');
const TOOL = 'linux/upgrade-v1/bin/clued-ci-upgrade-linux';
const SIGNER = 'linux/upgrade-v1/bin/clued-ci-sign-qualification-v2.mjs';
const TOOL_MANIFEST = 'linux/upgrade-v1/manifest.json';
const FROZEN_LINUX = { [TOOL]: '#!/usr/bin/python3.12 -I\n# tool\n', [SIGNER]: '// signer\n', [TOOL_MANIFEST]: '{"files":[]}\n' };

// A package whose `upgrader` is this tree's copy (one copy file changed with `change`, or every copy file AND the manifest list
// rewritten with `forge`), carrying the three frozen Linux upgrade files (`linux` overrides some of them).
async function pkgWithCopy(dir, tag, { change = null, forge = null, linux = {}, ...options } = {}) {
  const copy = await upgraderCopy(RESIDENT);
  let { manifest, manifestSha256 } = copy;
  const bytes = new Map();
  for (const f of manifest.files) bytes.set(f.path, await fs.readFile(path.join(RESIDENT, ...f.path.split('/'))));
  for (const p of [change, forge].filter(Boolean)) {
    // a forged file would run on import: it marks that it did
    bytes.set(p, Buffer.concat([bytes.get(p), Buffer.from(p === forge ? '\nglobalThis.__cluedForgedImport = true;\n' : '\n// changed\n')]));
    manifest = { ...manifest, files: manifest.files.map(f => (f.path === p ? { ...f, sha256: sha256(bytes.get(p)), bytes: bytes.get(p).length } : f)) };
    // `change` is an honest new copy (its own hash); `forge` keeps claiming the installed hash
    if (p === change) manifestSha256 = sha256(Buffer.from(canonicalJson(manifest) + '\n'));
  }
  const frozen = { ...FROZEN_LINUX, ...linux };
  const pkg = await buildTestPackage(dir, { tag, upgrader: { manifestSha256, files: manifest.files }, ...options, mutate: (m, files, put) => {
    for (const [p, text] of Object.entries(frozen)) {
      put(p, text);
      m.linux.files.push({ path: p, sha256: sha256(files.get(p)), bytes: files.get(p).length });
    }
    options.mutate?.(m, files, put);
  } });
  for (const [p, b] of bytes) { await fs.mkdir(path.dirname(path.join(dir, 'upgrader', p)), { recursive: true }); await fs.writeFile(path.join(dir, 'upgrader', p), b); }
  return pkg;
}

// A node root at generation 1 of `base`, whose installed upgrader is this tree's copy, and whose policy names the node.
async function node(t, base) {
  const root = await tempDir(t, 'clued-precheck-root-');
  await installGeneration1(root, base, { upgraderManifest: base.manifest.upgrader.manifestSha256 });
  const policy = JSON.parse(await fs.readFile(path.join(root, 'config', 'policy.json'), 'utf8'));
  await fs.writeFile(path.join(root, 'config', 'policy.json'), JSON.stringify({ ...policy, node: { nodeName: NODE } }));
  return root;
}

async function world(t, nextOptions = {}) {
  const dir = await tempDir(t, 'clued-precheck-');
  const base = await pkgWithCopy(path.join(dir, 'n1'), 'n1');
  const next = await pkgWithCopy(path.join(dir, 'n2'), 'n2', nextOptions);
  const root = await node(t, base);
  const run = (over = {}) => precheck({ root, pkgDir: next.dir, pkgSha: next.sha, acceptance: DECISION, installedPkgDir: base.dir, clock: () => T, ...over });
  return { dir, base, next, root, run };
}

async function writeFacts(root, over) {
  const facts = { contract: 'clued.independent-ci.linux-version-facts/1', generation: 1, ciSourceManifestSha256: 'a'.repeat(64), sourceCommit: null, manifestSha256: 'b'.repeat(64),
    roles: {}, pinsOk: true, staged: null, upgradeToolSha256: sha256(Buffer.from(FROZEN_LINUX[TOOL])), observedAt: new Date(T).toISOString(), ...over };
  await fs.mkdir(path.join(root, 'upgrade', 'mailbox', 'responses'), { recursive: true });
  await fs.writeFile(path.join(root, 'upgrade', 'mailbox', 'responses', 'version-facts.json'), JSON.stringify(facts));
}

test('precheck: PASS with the installed upgrader; the plan it reports is the one ACCEPT would make; nothing is written', async t => {
  const { next, root, run } = await world(t);
  const before = await listing(root);
  const r = await run();
  assert.equal(r.status, 'PRECHECK_PASS', JSON.stringify(r));
  assert.deepEqual([r.plan.fromGeneration, r.plan.toGeneration, r.plan.grantResource], [1, 2, `ci-resident:${NODE}/${next.sha}`]);
  assert.equal(r.plan.target.ciSourceManifestSha256, next.ciSource);
  assert.ok(r.plan.newDirs.some(d => d === `resident\\${next.residentSha}`));
  assert.ok(r.warnings.includes('LINUX_VERSION_FACTS_UNREADABLE'));
  assert.deepEqual(await listing(root), before);
  // the installed package is required: it is what the frozen files are compared with
  await assert.rejects(run({ installedPkgDir: undefined }), { code: 'USAGE' });
});

test('precheck: an admin-only slot is a stand-in, the rest is still decided', async t => {
  const { root, run } = await world(t);
  const denied = path.join(root, 'helpers', 'controller-formal-generic-v2.exe');
  const readSlot = file => (file === denied ? Promise.reject(Object.assign(new Error('EPERM'), { code: 'EPERM' })) : fs.readFile(file));
  const r = await run({ readSlot });
  assert.equal(r.status, 'PRECHECK_PASS_EXCEPT_UNREADABLE_SLOTS');
  assert.deepEqual(r.unreadableSlots, ['helpers\\controller-formal-generic-v2.exe']);
});

test('precheck: a changed frozen module is a channel change, and the changed files are named', async t => {
  const { run } = await world(t, { change: 'src/store.mjs' });
  const r = await run();
  assert.deepEqual([r.status, r.code, r.detail], ['PRECHECK_REFUSED', 'UPGRADE_CHANNEL_CHANGE_NEEDS_REINSTALL', 'upgrader']);
  assert.deepEqual(r.changedFrozenFiles.map(f => f.path), ['src/store.mjs']);
  assert.notEqual(r.upgrader.installed, r.upgrader.package);
});

test('precheck: a copy that claims the installed hash but is not its bytes is refused before anything of it runs', async t => {
  // a tampered file whose listed sha is not its bytes
  const a = await world(t);
  await fs.appendFile(path.join(a.next.dir, 'upgrader', 'upgrader', 'src', 'plan.mjs'), '\n// swapped\n');
  await assert.rejects(a.run(), { code: 'PRECHECK_UPGRADER_COPY_CHANGED' });
  // a consistently forged canonical.mjs AND its listed sha, still claiming the installed manifest hash: the hash computed here differs
  const b = await world(t, { forge: 'src/canonical.mjs' });
  await assert.rejects(b.run(), { code: 'PRECHECK_UPGRADER_COPY_CHANGED' });
  assert.equal(globalThis.__cluedForgedImport, undefined);
});

test('precheck: identity, compatibility, acceptance and the same package are the upgrader\'s own refusals', async t => {
  const { dir, base, root } = await world(t);
  const cases = [
    ['identity', { nodeIdentitySha256: 'e'.repeat(64) }, DECISION, 'UPGRADE_CHANNEL_CHANGE_NEEDS_REINSTALL'],
    ['compat', { stateCompat: { schema: 2, readableBySchemas: [2] } }, DECISION, 'UPGRADE_STATE_COMPAT_REFUSED'],
    ['accept', {}, '1d84ddbb-ec1f-49c3-bbd0-953f72d53584', 'UPGRADE_REQUEST_REFUSED'],
  ];
  for (const [tag, options, acceptance, code] of cases) {
    const p = await pkgWithCopy(path.join(dir, tag), 'n2', options);
    const r = await precheck({ root, pkgDir: p.dir, pkgSha: p.sha, acceptance, installedPkgDir: base.dir, clock: () => T });
    assert.deepEqual([tag, r.status, r.code], [tag, 'PRECHECK_REFUSED', code], JSON.stringify(r));
  }
  const same = await precheck({ root, pkgDir: base.dir, pkgSha: base.sha, acceptance: DECISION, installedPkgDir: base.dir, clock: () => T });
  assert.deepEqual([same.status, same.code], ['PRECHECK_REFUSED', 'UPGRADE_SAME_AS_CURRENT']);
  await assert.rejects(precheck({ root, pkgDir: base.dir, pkgSha: 'a'.repeat(64), acceptance: DECISION, installedPkgDir: base.dir, clock: () => T }), { code: 'PRECHECK_PACKAGE_CHANGED' });
});

test('precheck: the frozen Linux upgrade tool, signer and tool manifest must be the installed package\'s and the node\'s', async t => {
  for (const changed of [TOOL, SIGNER, TOOL_MANIFEST]) {
    const { run } = await world(t, { linux: { [changed]: FROZEN_LINUX[changed] + '# changed\n' } });
    const r = await run();
    assert.deepEqual([changed, r.status, r.code, r.detail, r.changedFrozenFiles.map(f => f.path)],
      [changed, 'PRECHECK_REFUSED', 'UPGRADE_CHANNEL_CHANGE_NEEDS_REINSTALL', 'linux-upgrade-tool', [changed]]);
  }
  const { root, run } = await world(t);
  await writeFacts(root, { upgradeToolSha256: 'a'.repeat(64) });
  const r = await run();
  assert.deepEqual([r.status, r.code, r.detail], ['PRECHECK_REFUSED', 'UPGRADE_CHANNEL_CHANGE_NEEDS_REINSTALL', 'linux-upgrade-tool']);
  await writeFacts(root, { staged: { opId: '11111111-1111-4111-8111-111111111111', generation: 2 } });
  const s = await run();
  assert.equal(s.status, 'PRECHECK_PASS');
  assert.ok(s.warnings.includes('LINUX_HAS_A_STAGED_GENERATION'));
});

test('precheck: an installed package that is not the installed upgrader\'s is refused', async t => {
  const { next, run } = await world(t);
  await assert.rejects(run({ installedPkgDir: path.join(next.dir, 'nowhere') }), { code: 'ENOENT' });
  const other = await pkgWithCopy(path.join(path.dirname(next.dir), 'other'), 'n9', { change: 'src/inbox.mjs' });
  await assert.rejects(run({ installedPkgDir: other.dir }), { code: 'PRECHECK_INSTALLED_PACKAGE_IS_NOT_THE_CURRENT_GENERATION' });
  // an older package with the same upgrader (and so the same copy) is not the current generation either
  const older = await pkgWithCopy(path.join(path.dirname(next.dir), 'older'), 'n0');
  await assert.rejects(run({ installedPkgDir: older.dir }), { code: 'PRECHECK_INSTALLED_PACKAGE_IS_NOT_THE_CURRENT_GENERATION' });
});

async function listing(root) {
  const out = [];
  async function walk(d) {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p); else out.push([path.relative(root, p), sha256(await fs.readFile(p))]);
    }
  }
  await walk(root);
  return out.sort();
}
