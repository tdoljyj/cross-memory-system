// End to end (Decisions ddb4300f, b5d041d2 v2): one universal archive from a commit (built twice: the same bytes), assembled on two
// different node sites into two /4 packages that the frozen upgrader reads and plans (readPackageOnce + buildPlan, also through the
// archive's precheck.mjs), whose universal values are equal to each other and to release.json although the two nodes' installed
// records carry other acceptance references and role material (so their ciSourceManifestSha256 differ); and the refusals: an archive
// that is not the target's or not its own manifest, a package that is not the current generation.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test, { after } from 'node:test';
import { assembleUpgrade, findInstalledPackage } from '../assemble.mjs';
import { universalFilesSha256 } from '../facts.mjs';
import { readTar, writeTar } from '../tar.mjs';
import { buildUniversal } from '../universal.mjs';
import { readPackageOnce } from '../../../upgrader/src/package.mjs';
import { buildPlan } from '../../../upgrader/src/plan.mjs';
import { fleetFacts, fixtureRepo, nodeSite, sha, targetOf, tempDir } from './fleet-fixtures.mjs';

const UNIVERSAL_KEYS = ['resident_manifest_sha256', 'source_manifest_sha256', 'upgrader_manifest_sha256', 'commit', 'bundle_sha256', 'universal_files_sha256'];

// One world for the file (building it is the slow part); removed after the last test.
const cleanups = [];
const keep = { after: f => cleanups.push(f) };
after(async () => { for (const f of cleanups.reverse()) await f(); });
let world = null;
async function getWorld() {
  if (world) return world;
  const t = keep;
  const fleet = fleetFacts();
  const { repo, commit } = await fixtureRepo(t, ['a', 'b']);
  const a = await nodeSite(t, 'a', fleet);
  const b = await nodeSite(t, 'b', fleetFacts());   // its own sourceAcceptanceRef, hostQualificationRef and role material
  const d = await tempDir(t, 'fleetout');
  const out1 = path.join(d, 'out1'), out2 = path.join(d, 'out2');
  const r1 = await buildUniversal({ repo, commit, version: '2026.11.12-1', out: out1 });
  const r2 = await buildUniversal({ repo, commit, version: '2026.11.12-1', out: out2 });
  const release = JSON.parse(await fs.readFile(r1.release, 'utf8'));
  world = { fleet, repo, commit, a, b, d, out1, out2, r1, r2, release, tar: r1.tar };
  return world;
}

test('universal: the same commit twice gives the same tar and release.json; SHA256SUMS; the tar is the commit\'s subset', { timeout: 600_000 }, async t => {
  const w = await getWorld();
  const [t1, t2] = [await fs.readFile(w.r1.tar), await fs.readFile(w.r2.tar)];
  assert.equal(sha(t1), sha(t2), 'tar bytes are reproducible');
  assert.ok((await fs.readFile(w.r1.release)).equals(await fs.readFile(w.r2.release)), 'release.json bytes are reproducible');
  const s = w.release.source;
  assert.deepEqual(Object.keys(s).sort(), ['archive_sha256', 'bundle_sha256', 'commit', 'release_tag', 'resident_manifest_sha256', 'source_manifest_sha256',
    'universal_files_sha256', 'upgrader_manifest_sha256', 'version'].sort());
  assert.deepEqual([s.version, s.release_tag, s.commit, s.archive_sha256], ['2026.11.12-1', 'fleet-node-2026.11.12-1', w.commit, sha(t1)]);
  assert.equal(await fs.readFile(path.join(w.out1, 'SHA256SUMS'), 'utf8'),
    `${sha(await fs.readFile(w.r1.release))}  fleet-node-2026.11.12-1.release.json\n${sha(t1)}  fleet-node-2026.11.12-1.tar\n`);
  const entries = readTar(t1);
  const names = entries.map(e => e.path);
  assert.ok(names.includes('universal-manifest.json') && names.includes('bundle/accepted.bundle'));
  assert.ok(names.includes('tree/work/independent-ci-resident-v1/rollout/fleet/assemble.mjs'), 'the assembler is archived');
  assert.ok(names.includes('tree/work/independent-ci-resident-v1/windows/install-resident.ps1'), 'the install scripts are archived');
  assert.ok(names.includes('tree/work/independent-ci-resident-v1/config/node-profile.fixture-b.json'), 'the node profiles are archived');
  assert.ok(!names.some(n => n.includes('/rollout/fleet/test/') || n === 'tree/README.fixture'), 'nothing outside the subset');
  const um = JSON.parse(entries.find(e => e.path === 'universal-manifest.json').data.toString('utf8'));
  assert.equal(sha(entries.find(e => e.path === 'bundle/accepted.bundle').data), s.bundle_sha256);
  assert.deepEqual(um.files, w.release.files);
});

test('assemble: two node sites, one archive: equal universal values (= release.json), different packages, both read and planned by the frozen upgrader', { timeout: 600_000 }, async t => {
  const w = await getWorld();
  const target = targetOf(w.release);
  const results = [];
  for (const n of [w.a, w.b]) {
    const r = await assembleUpgrade({ artifactPath: w.tar, artifactSha256: w.release.source.archive_sha256, target, root: n.root, installedPackageDir: n.pkgDir,
      workDir: path.join(n.dir, 'assembly') });
    assert.equal(r.status, 'FLEET_PACKAGE_ASSEMBLED', JSON.stringify({ status: r.status, precheck: r.precheck && { status: r.precheck.status, code: r.precheck.code,
      detail: r.precheck.detail, advice: r.precheck.advice, hostConditions: r.precheck.hostConditions, hostPrerequisites: r.precheck.hostPrerequisites } }).slice(0, 3000));
    assert.match(r.precheck.status, /^PRECHECK_PASS/);
    assert.equal(r.node, n.profile.nodeName);
    results.push(r);
    // the frozen upgrader's own reader and planner, against this node's installed generation
    const pkg = await readPackageOnce(r.packageDir, r.packageManifestSha256);
    const m = pkg.manifest;
    for (const k of UNIVERSAL_KEYS) {
      const v = { resident_manifest_sha256: m.residentManifestSha256, source_manifest_sha256: m.sourceManifestSha256,
        upgrader_manifest_sha256: m.upgrader.manifestSha256, commit: m.linux.sourceV2.commit, bundle_sha256: m.linux.sourceV2.bundleSha256,
        universal_files_sha256: universalFilesSha256(m.files, m.residentManifestSha256, m.ciSourceManifestSha256) }[k];
      assert.equal(v, w.release.source[k], k);
    }
    assert.equal(m.acceptance.decisionRef, target.id);
    const policy = JSON.parse(pkg.bytesByPath.get(m.files.find(f => f.target === 'config\\policy.json').path).toString('utf8'));
    assert.deepEqual(policy.ownerAcceptance, { decisionRef: target.id, installReceiptRef: target.receipt_id });
    const current = JSON.parse(await fs.readFile(path.join(n.root, 'upgrade', 'current.json'), 'utf8'));
    const receipt = JSON.parse(await fs.readFile(path.join(n.root, 'install', 'install-receipt.json'), 'utf8'));
    const live = Object.fromEntries((await import('../../../upgrader/src/plan.mjs')).ALL_SLOTS.map(s => [s, 'a'.repeat(64)]));
    const { plan } = buildPlan({ generation: current, receipt, live, dirs: { resident: [], source: [] }, generationSha256: 'b'.repeat(64) }, m, {
      request: { node: n.profile.nodeName, packageManifestSha256: r.packageManifestSha256, packageDirectory: r.packageDir, acceptanceDecisionRef: target.id, drainMaxMinutes: 120 },
      packageFiles: pkg.bytesByPath, opId: '00000000-0000-4000-8000-000000000000', config: { node: n.profile.nodeName, nodeProfileSha256: policy.nodeProfileSha256,
        ownerSid: policy.companion.userSid, timeouts: { drainMaxMinutes: 120 } }, requestSha256: '0'.repeat(64) });
    assert.deepEqual([plan.fromGeneration, plan.toGeneration, plan.target.ciSourceManifestSha256], [1, 2, m.ciSourceManifestSha256]);
    // the node identity and profile are the installed ones
    assert.equal(m.nodeIdentitySha256, n.pkg.manifest.nodeIdentitySha256);
    assert.equal(m.nodeProfileSha256, n.pkg.manifest.nodeProfileSha256);
  }
  assert.notEqual(results[0].packageManifestSha256, results[1].packageManifestSha256, 'each node its own package');
  assert.deepEqual(results[0].universal, results[1].universal);
  const ci = await Promise.all(results.map(async r => JSON.parse(await fs.readFile(path.join(r.packageDir, 'package-manifest.json'), 'utf8')).ciSourceManifestSha256));
  assert.notEqual(ci[0], ci[1], 'each node keeps its own CI Source manifest (its installed references): not a universal value');
  // findInstalledPackage finds the current generation's package among others
  assert.equal(await findInstalledPackage({ root: w.a.root, searchDirs: [path.join(w.a.dir, 'packages'), path.join(w.b.dir, 'packages')] }), path.resolve(w.a.pkgDir));
  assert.equal(await findInstalledPackage({ root: w.a.root, searchDirs: [path.join(w.b.dir, 'packages')] }), null);
});

test('assemble refuses: archive sha, an archive that is not the target\'s, a tampered entry, not the current package', { timeout: 600_000 }, async t => {
  const w = await getWorld();
  const target = targetOf(w.release);
  const d = await tempDir(t, 'fleetbad');
  const run = (over = {}) => assembleUpgrade({ artifactPath: w.tar, artifactSha256: target.archive_sha256, target, root: w.a.root, installedPackageDir: w.a.pkgDir,
    workDir: path.join(d, `w${Math.random().toString(16).slice(2)}`), ...over });
  // the archive bytes are not the accepted ones
  const changed = Buffer.from(await fs.readFile(w.tar)); changed[changed.length - 2000] ^= 1;
  await fs.writeFile(path.join(d, 'changed.tar'), changed);
  await assert.rejects(run({ artifactPath: path.join(d, 'changed.tar') }), { code: 'FLEET_ARTIFACT_SHA_MISMATCH' });
  await assert.rejects(run({ artifactSha256: 'f'.repeat(64) }), { code: 'FLEET_ARTIFACT_SHA_NOT_THE_TARGETS' });
  // an accepted record that names other values than the archive carries
  const other = targetOf(w.release, { universal_files_sha256: 'e'.repeat(64) });
  await assert.rejects(run({ target: other }), { code: 'FLEET_ARCHIVE_NOT_THE_TARGET', detail: { fields: ['universal_files_sha256'] } });
  // a well-formed archive whose entry is not what its manifest says (its own sha accepted, to reach the check)
  const entries = readTar(await fs.readFile(w.tar)).map(e => ({ path: e.path, data: e.path.endsWith('/rollout/precheck.mjs') ? Buffer.concat([e.data, Buffer.from('\n')]) : e.data }));
  const forged = writeTar(entries);
  await fs.writeFile(path.join(d, 'forged.tar'), forged);
  const ft = { ...target, archive_sha256: sha(forged) };
  await assert.rejects(run({ artifactPath: path.join(d, 'forged.tar'), artifactSha256: sha(forged), target: ft }), { code: 'FLEET_ARCHIVE_NOT_ITS_MANIFEST' });
  // a climbing path inside an archive is refused before anything is written
  const climbing = Buffer.from(writeTar([{ path: 'xx/evil.txt', data: Buffer.from('x') }]));
  climbing.write('../', 0, 'ascii');
  let sum = 0; for (let k = 0; k < 512; k++) sum += k >= 148 && k < 156 ? 0x20 : climbing[k];
  climbing.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  await fs.writeFile(path.join(d, 'climb.tar'), climbing);
  const ct = { ...target, archive_sha256: sha(climbing) };
  const cw = path.join(d, 'climb-work');
  await assert.rejects(run({ artifactPath: path.join(d, 'climb.tar'), artifactSha256: sha(climbing), target: ct, workDir: cw }), { code: 'TAR_PATH_REFUSED' });
  await assert.rejects(fs.access(cw));
  // the installed package dir of another node is not this node's current generation
  await assert.rejects(run({ installedPackageDir: w.b.pkgDir }), { code: 'INSTALLED_PACKAGE_IS_NOT_THE_CURRENT_GENERATION' });
});
