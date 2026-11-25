// publish.mjs with a fake gh (never the real one, never the network). There is no release command: prepare makes the Release from the
// checked build output (the commit as target, no token in gh's environment) and the index gets one line only after gh succeeded; a
// build whose archive is not its release.json, and a failing gh are refused without touching the index (FABLE-drill-release-step-20261121.md).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DRILL_RESERVED, acceptanceOf, attachAcceptance, attachFirstInstallKit, main, prepare, readBuild, seal, stageNodeEntry } from '../publish.mjs';
import * as publishModule from '../publish.mjs';
import { writeTar } from '../tar.mjs';
import { FAKE_GH } from './fleet-fixtures.mjs';

const sha = b => createHash('sha256').update(b).digest('hex');
const VERSION = '2026.11.12-1', TAG = `fleet-node-${VERSION}`, COMMIT = 'a1'.repeat(20);
const FLEET = 'tree/work/independent-ci-resident-v1/rollout/fleet/';
const BOOTSTRAP = Buffer.from('# bootstrap.ps1 of the accepted commit\r\nparam([string]$From)\r\n');
const PREREQ = Buffer.from(JSON.stringify({ contract: 'clued.independent-ci.fleet-node-prereq-manifest/1', items: [] }) + '\n');

async function world(t) {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'fleetpub'));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  const out = path.join(d, 'out');
  await fs.mkdir(out);
  // the archive carries the commit's bootstrap.ps1 and prereq-manifest.json: publish takes those bytes, never a working-tree copy
  const tar = writeTar([{ path: `${FLEET}bootstrap.ps1`, data: BOOTSTRAP }, { path: `${FLEET}prereq-manifest.json`, data: PREREQ },
    { path: 'universal-manifest.json', data: Buffer.from('{}') }]);
  const source = { version: VERSION, release_tag: TAG, archive_sha256: sha(tar), commit: COMMIT, resident_manifest_sha256: '2'.repeat(64),
    source_manifest_sha256: '3'.repeat(64), upgrader_manifest_sha256: '4'.repeat(64), bundle_sha256: '5'.repeat(64), universal_files_sha256: '6'.repeat(64) };
  const release = Buffer.from(JSON.stringify({ contract: 'clued.independent-ci.fleet-node-release/1', source, archive: { name: `${TAG}.tar`, bytes: tar.length, sha256: sha(tar) } }, null, 1) + '\n');
  await fs.writeFile(path.join(out, `${TAG}.tar`), tar);
  await fs.writeFile(path.join(out, `${TAG}.release.json`), release);
  await fs.writeFile(path.join(out, 'SHA256SUMS'), `${sha(release)}  ${TAG}.release.json\n${sha(tar)}  ${TAG}.tar\n`);
  const index = path.join(d, 'index.md');
  await fs.writeFile(index, '| 版本 | Release | tar sha256 | commit | 接受时间 |\r\n|---|---|---|---|---|\r\n');
  const fake = path.join(d, 'fake-gh.mjs');
  await fs.writeFile(fake, FAKE_GH);
  const state = path.join(d, 'gh-state.json');
  const calls = async () => { try { return JSON.parse(await fs.readFile(state, 'utf8')).calls; } catch { return []; } };
  const assets = async () => { try { return JSON.parse(await fs.readFile(state, 'utf8')).assets; } catch { return []; } };
  return { d, out, build: out, tar, source, index, calls, assets, fake, state };
}

const REPO = 'tdoljyj/cross-memory-system';
const RELEASE_ASSETS = [`${TAG}.tar`, `${TAG}.release.json`, 'SHA256SUMS', `${TAG}.bootstrap.ps1`, `${TAG}.prereq-manifest.json`];
const rowOf = w => `| ${VERSION} | https://github.com/${REPO}/releases/tag/${TAG} | ${w.source.archive_sha256} | ${COMMIT} |  |  |  |`;
// The fake gh's state as the Release of this build would have it (the assets the release step publishes, through the fake's own
// "release create"); only: the assets kept (a release that stopped half way); row: the index row appended as well. The calls are cleared.
async function seedRelease(w, { only = null, row = false } = {}) {
  const build = await readBuild(w.build);
  const stage = await fs.mkdtemp(path.join(w.d, 'seed-'));
  const { sums, entry } = await stageNodeEntry(build, stage);
  const files = [build.assets[0], build.assets[1], sums, ...entry].filter(a => only === null || only.includes(a.name)).map(a => a.file);
  const r = spawnSync(process.execPath, [w.fake, 'release', 'create', TAG, ...files, '--repo', REPO, '--target', COMMIT], { env: { ...process.env, FAKE_GH_STATE: w.state }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const st = JSON.parse(await fs.readFile(w.state, 'utf8'));
  st.calls = [];
  await fs.writeFile(w.state, JSON.stringify(st));
  if (row) await fs.appendFile(w.index, `${rowOf(w)}\r\n`);
}
const releaseWrites = async w => (await w.calls()).filter(c => c.args[0] === 'release' && ['create', 'upload', 'delete-asset'].includes(c.args[1]));

const DECISION = 'b5d041d2';
const drillRefs = (decision, receipt) => ({ sourceAcceptanceRef: decision, hostQualificationRef: decision, ownerAuthorizationRef: decision, publisherQualificationRef: decision,
  ownerPackageAcceptanceRef: decision, installationReceiptRef: receipt, ownerDecisionRef: decision, ownerReceiptRef: receipt, formalRoles: { gitleaks: {}, trivy: {}, 'contract-placement': {} } });
const accept = async (w, over = {}, name = `${TAG}.acceptance.json`) => {
  const file = path.join(w.d, name);
  const decision = `${DECISION}-1111-4111-8111-111111111111`, receipt = 'e1e1e1e1-2222-4222-8222-222222222222';
  const fleetRefs = { sourceAcceptanceRef: decision, hostQualificationRef: decision, ownerAuthorizationRef: decision, publisherQualificationRef: decision,
    ownerPackageAcceptanceRef: decision, installationReceiptRef: receipt, ownerDecisionRef: decision, ownerReceiptRef: receipt,
    formalRoles: { gitleaks: {}, trivy: {}, 'contract-placement': {} } };
  await fs.writeFile(file, JSON.stringify({ contract: 'clued.independent-ci.fleet-node-acceptance/1', version: VERSION, archive_sha256: w.source.archive_sha256,
    commit: COMMIT, repository: 'tdoljyj/cross-memory-system', ciSourceManifestSha256: '7'.repeat(64), cluedDecision: DECISION, acceptedAt: '2026-11-12T08:00:00Z', firstInstallKitSha256: w.kitSha ?? 'e'.repeat(64),
    fleetRefs, ...over }));
  return file;
};

test('attach-acceptance: uploads the file as an extra asset (no --clobber), fills accepted-at, Decision and the drill cell; the same again changes nothing, another is refused', async t => {
  const w = await kitWorld(t);
  await w.attach();
  const file = await accept(w);
  const run = (over = {}) => attachAcceptance({ version: VERSION, acceptance: file, index: w.index, ghCommand: [process.execPath, path.join(w.d, 'fake-gh.mjs')], ...over });
  const saved = { ...process.env };
  process.env.FAKE_GH_STATE = path.join(w.d, 'gh-state.json');
  process.env.GH_TOKEN = 'fake-token-value-for-the-test';
  t.after(() => { for (const k of ['FAKE_GH_STATE', 'GH_TOKEN']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  const before = (await w.calls()).length;
  const r = await run();
  assert.equal(r.status, 'FLEET_ACCEPTANCE_ATTACHED');
  const calls = (await w.calls()).slice(before);
  // what it accepts is read back from the Release first (view, SHA256SUMS for the tar, the kit's sums file, the kit), then the one upload, then the view that checks it
  assert.deepEqual(calls.map(c => c.args.slice(0, 2).join(' ')), ['release view', 'release download', 'release download', 'release download', 'release upload', 'release view']);
  assert.deepEqual(calls.slice(1, 4).map(c => c.args[c.args.indexOf('--pattern') + 1]), ['SHA256SUMS', `${TAG}.first-install.SHA256SUMS`, `${TAG}.first-install-kit.json`]);
  const up = calls[4], view = calls[5];
  assert.deepEqual(up.args.slice(0, 3), ['release', 'upload', TAG]);
  assert.equal(path.basename(up.args[3]), `${TAG}.acceptance.json`);
  assert.ok(!up.args.includes('--clobber'));
  assert.deepEqual(up.tokenSeen, []);
  assert.deepEqual(view.args.slice(0, 3), ['release', 'view', TAG]);
  const lines = (await fs.readFile(w.index, 'utf8')).split('\r\n');
  assert.equal(lines[2], `| ${VERSION} | ${r.url} | ${w.source.archive_sha256} | ${COMMIT} | 2026-11-12T08:00:00Z | ${DECISION} | 首装未演练 |`);
  // the same acceptance again: nothing uploaded, the row as it is
  const indexAfter = await fs.readFile(w.index), uploads = (await w.calls()).filter(c => c.args[1] === 'upload').length;
  const again = await run();
  assert.equal(again.already, true);
  assert.ok((await fs.readFile(w.index)).equals(indexAfter));
  assert.equal((await w.calls()).filter(c => c.args[1] === 'upload').length, uploads, 'nothing uploaded again');
  const after = (await w.calls()).length;
  // another acceptance of an accepted version: refused before gh
  await fs.mkdir(path.join(w.d, 'sub'), { recursive: true });
  const other = await accept(w, { acceptedAt: '2026-11-12T09:00:00Z' }, `sub/${TAG}.acceptance.json`);
  await assert.rejects(run({ acceptance: other }), { code: 'PUBLISH_ACCEPTANCE_ALREADY_ATTACHED' });
  assert.equal((await w.calls()).length, after, 'refused before gh');
});

test('attach-acceptance refuses a file that is not this release, and leaves index and gh alone', async t => {
  const w = await world(t);
  await seedRelease(w, { row: true });
  const before = await fs.readFile(w.index);
  const n = (await w.calls()).length;
  const base = { version: VERSION, index: w.index, ghCommand: [process.execPath, path.join(w.d, 'fake-gh.mjs')] };
  const cases = [
    [{ archive_sha256: 'f'.repeat(64) }, 'ACCEPTANCE_NOT_THIS_RELEASE'],
    [{ commit: 'b2'.repeat(20) }, 'ACCEPTANCE_NOT_THIS_RELEASE'],
    [{ version: '2026.11.12-2' }, 'ACCEPTANCE_VERSION_MISMATCH'],
    [{ contract: 'x' }, 'ACCEPTANCE_CONTRACT_REFUSED'],
    [{ cluedDecision: 'nope' }, 'ACCEPTANCE_DECISION_REFUSED'],
    [{ acceptedAt: '2026-11-12 08:00' }, 'ACCEPTANCE_TIME_REFUSED'],
    [{ fleetRefs: null }, 'ACCEPTANCE_FLEETREFS_REFUSED'],
    // the whole contract every node reads (install.mjs validateAcceptance): repository, ciSourceManifestSha256, exact fleetRefs
    [{ ciSourceManifestSha256: undefined }, 'ACCEPTANCE_REFUSED'],
    [{ ciSourceManifestSha256: 'x' }, 'ACCEPTANCE_REFUSED'],
    [{ fleetRefs: { a: 'b' } }, 'ACCEPTANCE_REFUSED'],
    [{ repository: 'other/repo' }, 'ACCEPTANCE_NOT_THIS_REPOSITORY'],
    // a candidate drill's stand-in acceptance (DRILL_RESERVED) never reaches a Release, whatever else it carries
    ...[{ decision: DRILL_RESERVED.decision, receipt: 'e1e1e1e1-2222-4222-8222-222222222222' }, { decision: `${DECISION}-1111-4111-8111-111111111111`, receipt: DRILL_RESERVED.receipt }]
      .map(({ decision, receipt }) => [{ cluedDecision: decision, fleetRefs: drillRefs(decision, receipt) }, 'ACCEPTANCE_IS_THE_DRILLS_STAND_IN']),
    [{ cluedDecision: DRILL_RESERVED.decision.slice(0, 8), fleetRefs: drillRefs(DRILL_RESERVED.decision, 'e1e1e1e1-2222-4222-8222-222222222222') }, 'ACCEPTANCE_IS_THE_DRILLS_STAND_IN'],
  ];
  for (const [over, code] of cases) await assert.rejects(attachAcceptance({ ...base, acceptance: await accept(w, over) }), { code });
  await assert.rejects(attachAcceptance({ ...base, acceptance: await accept(w, {}, 'other.json') }), { code: 'ACCEPTANCE_FILE_NAME_REFUSED' });
  await assert.rejects(attachAcceptance({ ...base, version: '9.9', acceptance: await accept(w, { version: '9.9' }, 'fleet-node-9.9.acceptance.json') }), { code: 'PUBLISH_INDEX_LACKS_VERSION' });
  await assert.rejects(attachAcceptance({ ...base, acceptance: await accept(w), repo: 'bad repo' }), { code: 'PUBLISH_REPO_REFUSED' });
  assert.ok((await fs.readFile(w.index)).equals(before));
  assert.equal((await w.calls()).length, n);
});

const IMAGE = 'c'.repeat(64);
async function kitWorld(t) {
  const w = await world(t);
  await seedRelease(w, { row: true });
  const kit = path.join(w.d, `${TAG}.first-install-kit.json`);
  await fs.writeFile(kit, JSON.stringify({ contract: 'clued.independent-ci.fleet-node-first-install-kit/1', images: { pull: [], local: [{ id: IMAGE, asset: `role-image-${IMAGE}.tar.gz` }] } }));
  const image = path.join(w.d, `role-image-${IMAGE}.tar.gz`);
  await fs.writeFile(image, Buffer.from('gzip of a docker save'));
  const saved = { ...process.env };
  process.env.FAKE_GH_STATE = path.join(w.d, 'gh-state.json');
  process.env.GH_TOKEN = 'fake-token-value-for-the-test';
  t.after(() => { for (const k of ['FAKE_GH_STATE', 'GH_TOKEN']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  const attach = (over = {}) => attachFirstInstallKit({ version: VERSION, kit, images: [image], ghCommand: [process.execPath, w.fake], ...over });
  return { ...w, kit, image, attach, kitSha: sha(await fs.readFile(kit)) };
}

test('attach-first-install-kit: the kit, its local role images and one sums file over them, each uploaded without --clobber; a second time refused', async t => {
  const w = await kitWorld(t);
  const before = (await w.calls()).length;
  const r = await w.attach();
  assert.equal(r.status, 'FLEET_FIRST_INSTALL_KIT_ATTACHED');
  const calls = (await w.calls()).slice(before);
  const uploads = calls.filter(c => c.args[1] === 'upload');
  assert.deepEqual(uploads.map(c => path.basename(c.args[3])), [`${TAG}.first-install-kit.json`, `role-image-${IMAGE}.tar.gz`, `${TAG}.first-install.SHA256SUMS`]);
  for (const c of uploads) { assert.equal(c.args[2], TAG); assert.ok(!c.args.includes('--clobber')); assert.deepEqual(c.tokenSeen, []); }
  const sums = (await w.assets()).find(a => a.name === `${TAG}.first-install.SHA256SUMS`).text.split('\n').filter(Boolean);
  assert.deepEqual(sums.sort(), [`${sha(await fs.readFile(w.image))}  role-image-${IMAGE}.tar.gz`, `${sha(await fs.readFile(w.kit))}  ${TAG}.first-install-kit.json`].sort());
  const n = (await w.calls()).length;
  await assert.rejects(w.attach(), { code: 'PUBLISH_FIRST_INSTALL_KIT_ALREADY_ATTACHED' });
  assert.equal((await w.calls()).length, n + 1, 'only the view, nothing uploaded');
});

test('attach-first-install-kit refuses a kit and images that do not name each other, a wrong name, another version', async t => {
  const w = await kitWorld(t);
  const n = (await w.calls()).length;
  const other = path.join(w.d, `role-image-${'d'.repeat(64)}.tar.gz`);
  await fs.writeFile(other, 'x');
  await assert.rejects(w.attach({ images: [] }), { code: 'FIRST_INSTALL_KIT_IMAGES_NOT_THE_KITS' });
  await assert.rejects(w.attach({ images: [w.image, other] }), { code: 'FIRST_INSTALL_KIT_IMAGES_NOT_THE_KITS' });
  await assert.rejects(w.attach({ images: [other] }), { code: 'FIRST_INSTALL_KIT_IMAGES_NOT_THE_KITS' });
  const badName = path.join(w.d, 'kit.json');
  await fs.copyFile(w.kit, badName);
  await assert.rejects(w.attach({ kit: badName }), { code: 'FIRST_INSTALL_KIT_FILE_NAME_REFUSED' });
  const badContract = path.join(w.d, 'sub', `${TAG}.first-install-kit.json`);
  await fs.mkdir(path.dirname(badContract));
  await fs.writeFile(badContract, JSON.stringify({ contract: 'x' }));
  await assert.rejects(w.attach({ kit: badContract }), { code: 'FIRST_INSTALL_KIT_CONTRACT_REFUSED' });
  const imgName = path.join(w.d, 'image.tar.gz');
  await fs.copyFile(w.image, imgName);
  await assert.rejects(w.attach({ images: [imgName] }), { code: 'FIRST_INSTALL_IMAGE_FILE_NAME_REFUSED' });
  await assert.rejects(w.attach({ version: '2026.11.12-9' }), { code: 'FIRST_INSTALL_KIT_FILE_NAME_REFUSED' });
  await assert.rejects(w.attach({ repo: 'bad repo' }), { code: 'PUBLISH_REPO_REFUSED' });
  assert.equal((await w.calls()).length, n, 'refused before gh');
});

test('main: only prepare and seal, with their own options; release, the steps and the old entry have no command', async () => {
  for (const gone of [['attach-acceptance', '--version', '1', '--acceptance', 'a'], ['attach-first-install-kit', '--version', '1', '--kit', 'k'],
    ['acceptance-draft', '--version', '1', '--dir', 'x', '--base', 'b', '--out', 'o']]) await assert.rejects(main(gone), { code: 'USAGE' }, gone[0]);
  await assert.rejects(main(['prepare', '--version', '1', '--dir', 'x']), { code: 'USAGE' });
  await assert.rejects(main(['prepare', '--version', '1', '--dir', 'x', '--out', 'o', '--base', 'b']), { code: 'USAGE' }, 'no Decision or fleetRefs file goes into prepare');
  await assert.rejects(main(['seal', '--request', 'r', '--decision', 'd', '--receipt', 'x']), { code: 'USAGE' });
  // the door's answer is the one source of Decision (the Grant), receipt and time: none of the three is given on the command line, nor a record
  await assert.rejects(main(['seal']), { code: 'USAGE' });
  for (const extra of [['--decision', 'd'], ['--receipt', 'x'], ['--accepted-at', 't'], ['--acceptedAt', 't'], ['--decision-record', 'f'], ['--grant', 'g']]) {
    await assert.rejects(main(['seal', '--request', 'r', ...extra]), { code: 'USAGE' }, extra[0]);
  }
  await assert.rejects(main(['seal', '--request', 'r', '--dir', 'x']), { code: 'USAGE' }, 'seal reads no build and no node');
  await assert.rejects(main([]), { code: 'USAGE' });
  await assert.rejects(main(['--dir', 'x', '--repo', 'a/b', '--index', 'i']), { code: 'USAGE' });
  await assert.rejects(main(['release', '--dir', 'x']), { code: 'USAGE' });
  await assert.rejects(main(['release', '--dir', 'x', '--repo', 'a/b', '--version', '1']), { code: 'USAGE' });
});

// ---------------------------------------------------------------- the kit is part of every acceptance (Decision a056a7d9: the wrong road does not exist)
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const unchanged = async (w, indexBefore, callsBefore) => {
  assert.ok((await fs.readFile(w.index)).equals(indexBefore), 'the index row was not written');
  const made = (await w.calls()).slice(callsBefore);
  assert.deepEqual(made.filter(c => c.args[1] === 'upload'), [], 'nothing was uploaded');
};

test('78ad314b replay: the acceptance file as it was really accepted (nine keys, no firstInstallKitSha256) is refused; no upload, no index row', async t => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'fleetreplay'));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  const name = 'fleet-node-2026.11.19-78ad314b.acceptance.json';
  const file = path.join(d, name);
  await fs.copyFile(path.join(FIXTURES, name), file);
  const a = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(Object.keys(a).length, 9);
  assert.ok(!('firstInstallKitSha256' in a));
  const index = path.join(d, 'index.md');
  await fs.writeFile(index, `| 版本 | Release | tar sha256 | commit | 接受时间 | Decision |\n|---|---|---|---|---|---|\n| ${a.version} | https://github.com/tdoljyj/cross-memory-system/releases/tag/fleet-node-${a.version} | ${a.archive_sha256} | ${a.commit} |  |  |\n`);
  const fake = path.join(d, 'fake-gh.mjs'), state = path.join(d, 'gh-state.json');
  await fs.writeFile(fake, FAKE_GH);
  // the Release as it was published: the tar, release.json, SHA256SUMS and the two node-entry assets; no kit
  const assets = ['tar', 'release.json', 'bootstrap.ps1', 'prereq-manifest.json'].map(x => ({ name: `fleet-node-${a.version}.${x}`, size: 10, b64: '' })).concat([{ name: 'SHA256SUMS', size: 10, b64: '' }]);
  await fs.writeFile(state, JSON.stringify({ calls: [], assets }));
  const saved = process.env.FAKE_GH_STATE;
  process.env.FAKE_GH_STATE = state;
  t.after(() => { if (saved === undefined) delete process.env.FAKE_GH_STATE; else process.env.FAKE_GH_STATE = saved; });
  const before = await fs.readFile(index);
  await assert.rejects(attachAcceptance({ version: a.version, acceptance: file, index, ghCommand: [process.execPath, fake] }), { code: 'ACCEPTANCE_HAS_NO_FIRST_INSTALL_KIT' });
  assert.ok((await fs.readFile(index)).equals(before));
  assert.deepEqual(JSON.parse(await fs.readFile(state, 'utf8')).calls, [], 'refused before gh was called');
});

test('attach-acceptance refuses an acceptance whose kit is not on the Release: no kit asset, another hash, a role image missing', async t => {
  const w = await kitWorld(t);
  const base = { version: VERSION, index: w.index, ghCommand: [process.execPath, w.fake] };
  const indexBefore = await fs.readFile(w.index);
  // no kit on the Release at all (published, nothing attached yet)
  const n0 = (await w.calls()).length;
  await assert.rejects(attachAcceptance({ ...base, acceptance: await accept(w) }), { code: 'ACCEPTANCE_KIT_NOT_ON_RELEASE' });
  await unchanged(w, indexBefore, n0);
  await w.attach();
  const n = (await w.calls()).length;
  // the kit is there, the acceptance names another one
  await assert.rejects(attachAcceptance({ ...base, acceptance: await accept(w, { firstInstallKitSha256: 'f'.repeat(64) }) }), { code: 'ACCEPTANCE_KIT_NOT_THE_ATTACHED' });
  await unchanged(w, indexBefore, n);
  // the Release's SHA256SUMS names another tar than the one accepted (and the index row names)
  const state = JSON.parse(await fs.readFile(path.join(w.d, 'gh-state.json'), 'utf8'));
  const sums = state.assets.find(a => a.name === 'SHA256SUMS'), kept = sums.b64;
  sums.b64 = Buffer.from(Buffer.from(kept, 'base64').toString('utf8').replace(w.source.archive_sha256, '9'.repeat(64))).toString('base64');
  await fs.writeFile(path.join(w.d, 'gh-state.json'), JSON.stringify(state));
  await assert.rejects(attachAcceptance({ ...base, acceptance: await accept(w) }), { code: 'ACCEPTANCE_ARCHIVE_NOT_THE_RELEASES' });
  await unchanged(w, indexBefore, n);
  // a local role image the kit lists is not on the Release (the Release's SHA256SUMS as it was)
  const now = JSON.parse(await fs.readFile(path.join(w.d, 'gh-state.json'), 'utf8'));
  now.assets.find(a => a.name === 'SHA256SUMS').b64 = kept;
  state.assets = now.assets.filter(a => !a.name.startsWith('role-image-'));
  state.calls = now.calls;
  await fs.writeFile(path.join(w.d, 'gh-state.json'), JSON.stringify(state));
  await assert.rejects(attachAcceptance({ ...base, acceptance: await accept(w) }), { code: 'ACCEPTANCE_KIT_IMAGE_NOT_ON_RELEASE' });
  await unchanged(w, indexBefore, n);
});


// ---------------------------------------------------------------- the acceptance in two halves (Fable 3bc571a6 ruling section 3, Task 758989fa;
// rework: FABLE-renew-key-algorithm-ruling-20261119.md section 4; seal through the acceptance door: PLAN-accept-auto-seal-20261125 part B)
// prepare and seal with the node-side parts stood in for (the real ones are the first-install test): the node's kit, its record material, the archive's Source.
// kitOf gives new bytes on every read, as a real node does (template.versionFacts carries observedAt); kitReads counts them.
// The ids and time the fake door answers by default are those of one real Decision return (fixtures/clued-decision-mutate-3bc571a6.json:
// c556370f, receipt 7ccaefca, created 2026-11-19T12:22:39.628169+00:00); the fixture itself only gives the shape of a hand-written Decision
// record, which has no way into seal any more (the generation-18 test below).
const RECORD_FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'clued-decision-mutate-3bc571a6.json');
const FIX = JSON.parse(await fs.readFile(RECORD_FIXTURE, 'utf8'));
const FIX_DECISION = FIX.target_refs[0].id, FIX_RECEIPT = FIX.receipt_id, FIX_ACCEPTED_AT = '2026-11-19T12:22:39Z';
// the line DESK used to copy into a hand-written Decision (the generation-18 shape below names the request with it)
const requestLine = hash => `acceptance-request ${TAG} sha256:${hash}`;
// released: false leaves the Release and the index row to prepare (an empty gh state, an index with its header only)
const prepWorld = async (t, { templateSource = 'a'.repeat(64), packageSource = 'b'.repeat(64), released = true } = {}) => {
  const w = await world(t);
  if (released) await seedRelease(w, { row: true });
  const image = path.join(w.d, `role-image-${IMAGE}.tar.gz`);
  await fs.writeFile(image, Buffer.from('gzip of a docker save'));
  const carried = { sourceAcceptanceRef: '5c06efc1-6597-49bb-9883-57a7e7d6c344', hostQualificationRef: 'e46ab3f7-539f-4bc3-8f60-5ceec1eef8b9',
    ownerAuthorizationRef: '5c06efc1-6597-49bb-9883-57a7e7d6c344', publisherQualificationRef: '5c06efc1-6597-49bb-9883-57a7e7d6c344', ownerPackageAcceptanceRef: '5c06efc1-6597-49bb-9883-57a7e7d6c344' };
  const formalRoles = { gitleaks: {}, trivy: {}, 'contract-placement': {} };
  // a token variable in this process: gh never sees it
  const saved = { FAKE_GH_STATE: process.env.FAKE_GH_STATE, GH_TOKEN: process.env.GH_TOKEN };
  process.env.FAKE_GH_STATE = path.join(w.d, 'gh-state.json');
  process.env.GH_TOKEN = 'fake-token-value-for-the-test';
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const out = path.join(w.d, 'accept');
  const s = { kitReads: 0, kitBroken: false, sourceDrafts: [], sourceOf: packageSource };
  const kitOf = async () => {
    if (s.kitBroken) throw Object.assign(new Error('the node was asked for a kit'), { code: 'TEST_NODE_ASKED_FOR_A_KIT' });
    const observedAt = new Date(Date.UTC(2026, 10, 19, 12, 0, s.kitReads++)).toISOString();
    return { contract: 'clued.independent-ci.fleet-node-first-install-kit/1', template: { versionFacts: Buffer.from(JSON.stringify({ observedAt })).toString('base64') },
      config: { ciSourceManifestSha256: templateSource }, images: { pull: [], local: [{ id: IMAGE, asset: `role-image-${IMAGE}.tar.gz` }] } };
  };
  // the fake acceptance door (PLAN-accept-auto-seal-20261125 section 5, the contract with part A): what seal asks, and the answer as the door
  // would give it now; `status` is flipped by a test (pending -> accepted, rejected, expired). accepted replays the same row on every ask.
  const door = { status: 'accepted', grant: FIX_DECISION, receipt: FIX_RECEIPT, acceptedAt: '2026-11-19T12:22:39.628169+00:00', asked: [],
    confirmUrl: 'https://kooyumi.pixelgrav.com/confirm/0b0b0b0b-1111-4111-8111-000000000001', expiresAt: '2099-01-01T00:00:00Z', answer: null };
  const askDoor = async input => {
    door.asked.push(structuredClone(input));
    if (door.answer) return door.answer(input);
    if (door.status === 'pending') return { status: 'pending', confirmUrl: door.confirmUrl, expiresAt: door.expiresAt };
    if (door.status === 'accepted') return { status: 'accepted', grant_id: door.grant, receipt_id: door.receipt, accepted_at: door.acceptedAt };
    return { status: door.status };
  };
  const deps = { kitOf, readKit: () => ({}), fleetMaterial: async () => ({ formalRoles, installed: { ...carried, ciSourceManifestSha256: templateSource } }),
    sourceHash: async args => { s.sourceDrafts.push(args); return { ciSourceManifestSha256: s.sourceOf }; }, door: askDoor };
  const gh = [process.execPath, w.fake];
  const prep = (over = {}) => prepare({ version: VERSION, dir: w.out, out, images: [image], index: w.index, ghCommand: gh, deps, ...over });
  const requestFile = path.join(out, `${TAG}.acceptance-request.json`);
  const kitAssets = async () => (await w.assets()).filter(a => a.name === `${TAG}.first-install-kit.json`);
  const setState = async edit => { const f = path.join(w.d, 'gh-state.json'); const st = JSON.parse(await fs.readFile(f, 'utf8')); edit(st); await fs.writeFile(f, JSON.stringify(st)); };
  // seal through the door: no Decision record, no Decision, receipt or time anywhere
  const sealDoor = async (over = {}) => seal({ request: requestFile, index: w.index, ghCommand: gh, deps, ...over });
  const sealIt = sealDoor;
  return { ...w, image, out, s, deps, prep, requestFile, sealIt, sealDoor, door, kitAssets, carried, formalRoles, setState };
};
const noRequest = async w => { await assert.rejects(fs.access(w.requestFile)); };
const uploadsOf = async w => (await w.calls()).filter(c => c.args[1] === 'upload');
const b64Of = text => Buffer.from(text).toString('base64');

// ruling test 1 (red before: acceptance-draft refused ACCEPTANCE_REFUSED "cluedDecision")
test('prepare: no Decision, receipt or time goes in; the request the Owner reviews comes out, with the kit on the Release, the node\'s carried references and the line for the Decision', async t => {
  const w = await prepWorld(t);
  const r = await w.prep();
  assert.equal(r.status, 'FLEET_ACCEPTANCE_REQUEST_WRITTEN');
  assert.equal(r.kitFrom, 'node');
  const request = JSON.parse(await fs.readFile(w.requestFile, 'utf8'));
  assert.deepEqual(Object.keys(request), ['contract', 'version', 'archive_sha256', 'commit', 'repository', 'ciSourceManifestSha256', 'firstInstallKitSha256', 'fleetRefs']);
  assert.deepEqual(request.fleetRefs, { ...w.carried, formalRoles: w.formalRoles });
  assert.equal(request.contract, 'clued.independent-ci.fleet-node-acceptance-request/1');
  assert.deepEqual([request.archive_sha256, request.commit, request.ciSourceManifestSha256], [w.source.archive_sha256, COMMIT, 'b'.repeat(64)]);
  const [kit] = await w.kitAssets();
  assert.equal(request.firstInstallKitSha256, kit.sha256, 'the request names the kit on the Release');
  assert.ok((await fs.readFile(path.join(w.out, `${TAG}.first-install-kit.json`))).equals(Buffer.from(kit.b64, 'base64')));
  assert.ok(await fs.stat(path.join(w.out, `role-image-${IMAGE}.tar.gz`)));
  // the request file's sha256 binds tar, commit, Source, kit and fleetRefs at once (the acceptance door's resource names it); no line for a
  // hand-written Decision any more
  const requestSha = sha(await fs.readFile(w.requestFile));
  assert.equal(r.requestSha256, requestSha);
  assert.ok(!('decisionLine' in r));
  // the Source: first on the build's own tar (the bytes that go up), then again on the tar downloaded from the Release (the check seal makes),
  // with the drill's stand-in Decision and receipt (they do not enter it)
  assert.ok(w.s.sourceDrafts.length >= 2);
  assert.equal(path.resolve(w.s.sourceDrafts[0].artifactPath), path.resolve(w.build, `${TAG}.tar`));
  for (const d of w.s.sourceDrafts.slice(1)) {
    assert.ok(![w.out, w.build].some(dir => path.resolve(d.artifactPath).startsWith(path.resolve(dir))), 'computed on the tar downloaded from the Release');
  }
  for (const d of w.s.sourceDrafts) {
    assert.equal(d.acceptance.cluedDecision, DRILL_RESERVED.decision);
    assert.ok(!('ciSourceManifestSha256' in d.acceptance));
    assert.equal(d.artifactSha256, w.source.archive_sha256);
  }
  // nothing of an acceptance is on the Release, in the index or in the directory yet
  assert.ok(!(await w.assets()).some(a => a.name.endsWith('.acceptance.json')));
  assert.match((await fs.readFile(w.index, 'utf8')).split('\r\n')[2], /\|  \|  \|  \|$/);
  await assert.rejects(fs.access(path.join(w.out, `${TAG}.acceptance.json`)));
});

// ruling test 2 (red before: acceptance-draft refused PUBLISH_FIRST_INSTALL_KIT_ALREADY_ATTACHED_DIFFERENT)
test('prepare again after a stop: the node would give other kit bytes, the Release\'s kit is used, the kit is uploaded once; a third run asks no node', async t => {
  const w = await prepWorld(t);
  process.env.FAKE_GH_FAIL_UPLOAD_NTH = '2';   // the kit goes up, the role image does not (acceptance-draft.log: the network stopped it)
  t.after(() => { delete process.env.FAKE_GH_FAIL_UPLOAD_NTH; });
  await assert.rejects(w.prep(), { code: 'PUBLISH_GH_RELEASE_UPLOAD_FAILED' });
  await noRequest(w);
  assert.deepEqual((await w.assets()).filter(a => a.name.includes('first-install') || a.name.startsWith('role-image-')).map(a => a.name), [`${TAG}.first-install-kit.json`]);
  delete process.env.FAKE_GH_FAIL_UPLOAD_NTH;
  const reads = w.s.kitReads;
  const r = await w.prep();   // the same arguments, the same --out
  assert.equal(r.kitFrom, 'release');
  assert.equal(w.s.kitReads, reads, 'once a kit is on the Release no node is asked again');
  const names = (await w.assets()).map(a => a.name);
  for (const n of [`${TAG}.first-install-kit.json`, `role-image-${IMAGE}.tar.gz`, `${TAG}.first-install.SHA256SUMS`]) assert.equal(names.filter(x => x === n).length, 1, n);
  const [kit] = await w.kitAssets();
  assert.equal(JSON.parse(await fs.readFile(w.requestFile, 'utf8')).firstInstallKitSha256, kit.sha256);
  assert.equal((await uploadsOf(w)).filter(c => path.basename(c.args[3]) === `${TAG}.first-install-kit.json`).length, 1);
  // and once more after it finished: the same request, nothing uploaded, no node asked
  const before = await fs.readFile(w.requestFile), uploads = (await uploadsOf(w)).length;
  w.s.kitBroken = true;
  assert.equal((await w.prep()).kitFrom, 'release');
  assert.ok((await fs.readFile(w.requestFile)).equals(before));
  assert.equal((await uploadsOf(w)).length, uploads);
});

// review suggestion 1: what a resumed upload keeps is compared by content, not by size
test('prepare again after a stop: an image or sums file of the same size but other bytes on the Release is replaced, not kept', async t => {
  const w = await prepWorld(t);
  process.env.FAKE_GH_FAIL_UPLOAD_NTH = '3';   // the kit and the image go up, the sums file does not
  t.after(() => { delete process.env.FAKE_GH_FAIL_UPLOAD_NTH; });
  await assert.rejects(w.prep(), { code: 'PUBLISH_GH_RELEASE_UPLOAD_FAILED' });
  delete process.env.FAKE_GH_FAIL_UPLOAD_NTH;
  const local = await fs.readFile(w.image);
  const other = Buffer.from(local); other[0] ^= 1;
  await w.setState(st => { const a = st.assets.find(x => x.name === `role-image-${IMAGE}.tar.gz`); a.b64 = other.toString('base64'); a.sha256 = sha(other); });
  await w.prep();
  const img = (await w.assets()).filter(x => x.name === `role-image-${IMAGE}.tar.gz`);
  assert.deepEqual(img.map(x => x.sha256), [sha(local)], 'the image on the Release is the one the kit names');
  // the sums file: one line changed, the same size
  const sumsName = `${TAG}.first-install.SHA256SUMS`;
  const good = (await w.assets()).find(x => x.name === sumsName).text;
  const bad = good.replace(sha(local), sha(other));
  assert.equal(bad.length, good.length);
  await w.setState(st => { const a = st.assets.find(x => x.name === sumsName); a.b64 = b64Of(bad); a.text = bad; a.sha256 = sha(Buffer.from(bad)); });
  await w.prep();
  assert.deepEqual((await w.assets()).filter(x => x.name === sumsName).map(x => x.text), [good]);
});

// review suggestion 1: a transfer error stays a transfer error (acceptance-draft.log), it is not reported as a missing image
test('prepare keeps a download error of the previous Release\'s image as it is, not as a missing image', async t => {
  const w = await prepWorld(t);
  const prev = '2026.11.11-1', prevTag = `fleet-node-${prev}`;
  const body = Buffer.from('gzip of a docker save');
  const lines = (await fs.readFile(w.index, 'utf8')).split('\r\n');
  await fs.writeFile(w.index, [lines[0], lines[1], `| ${prev} | u | ${'1'.repeat(64)} | ${'2'.repeat(40)} | 2026-11-11T00:00:00Z | b5d041d2 |  |`, ...lines.slice(2)].join('\r\n'));
  const sumsText = `${sha(body)}  role-image-${IMAGE}.tar.gz\n`;
  await w.setState(st => { st.other = { [prevTag]: [{ name: `role-image-${IMAGE}.tar.gz`, size: body.length, b64: body.toString('base64') },
    { name: `${prevTag}.first-install.SHA256SUMS`, size: sumsText.length, b64: b64Of(sumsText) }] }; });
  process.env.FAKE_GH_FAIL_DOWNLOAD = `role-image-${IMAGE}.tar.gz`;
  t.after(() => { delete process.env.FAKE_GH_FAIL_DOWNLOAD; });
  await assert.rejects(w.prep({ images: [] }), e => e.code === 'PUBLISH_GH_RELEASE_DOWNLOAD_FAILED' && /TLS handshake timeout/.test(JSON.stringify(e.detail)));
  await noRequest(w);
  delete process.env.FAKE_GH_FAIL_DOWNLOAD;
  assert.equal((await w.prep({ images: [] })).status, 'FLEET_ACCEPTANCE_REQUEST_WRITTEN');
});

test('prepare refuses a template whose Source is this package\'s: no request, nothing uploaded', async t => {
  const w = await prepWorld(t, { templateSource: 'b'.repeat(64), packageSource: 'b'.repeat(64) });
  const before = await fs.readFile(w.index), n = (await w.calls()).length;
  await assert.rejects(w.prep(), { code: 'PREPARE_TEMPLATE_IS_THIS_SOURCE' });
  await noRequest(w);
  await unchanged(w, before, n);
});

test('prepare refuses a missing role image the previous Release does not have either; the previous Release\'s image is used when its sums agree', async t => {
  const w = await prepWorld(t);
  const before = await fs.readFile(w.index), n = (await w.calls()).length;
  await assert.rejects(w.prep({ images: [] }), { code: 'PREPARE_IMAGE_MISSING' });
  await noRequest(w);
  await unchanged(w, before, n);
  const prev = '2026.11.11-1', prevTag = `fleet-node-${prev}`;
  const body = Buffer.from('gzip of a docker save');
  const lines = (await fs.readFile(w.index, 'utf8')).split('\r\n');
  await fs.writeFile(w.index, [lines[0], lines[1], `| ${prev} | u | ${'1'.repeat(64)} | ${'2'.repeat(40)} | 2026-11-11T00:00:00Z | b5d041d2 |  |`, ...lines.slice(2)].join('\r\n'));
  const img = { name: `role-image-${IMAGE}.tar.gz`, size: body.length, b64: body.toString('base64') };
  const sums = (hash) => { const x = `${hash}  role-image-${IMAGE}.tar.gz\n`; return { name: `${prevTag}.first-install.SHA256SUMS`, size: x.length, b64: b64Of(x) }; };
  await w.setState(st => { st.other = { [prevTag]: [img, sums('9'.repeat(64))] }; });
  await assert.rejects(w.prep({ images: [] }), { code: 'PREPARE_PREVIOUS_IMAGE_NOT_ITS_SUMS' });
  await noRequest(w);
  await w.setState(st => { st.other[prevTag] = [img, sums(sha(body))]; });
  const r = await w.prep({ images: [] });
  assert.equal(r.status, 'FLEET_ACCEPTANCE_REQUEST_WRITTEN');
  assert.deepEqual(r.images, [IMAGE]);
});

// blocking 5: whether a version is accepted is what its Release holds (the acceptance asset); the index row is derived from it
test('prepare refuses a version whose Release holds its acceptance, also with the index row empty and also without a kit; it names seal to complete the row', async t => {
  // a seal that stopped after the upload: the acceptance is on the Release, the index row still empty
  const w = await prepWorld(t);
  await w.prep();
  const sealed = await w.sealIt();
  const index = await fs.readFile(w.index);
  await fs.writeFile(w.index, index.toString('utf8').replace(`| 2026-11-19T12:22:39Z | ${FIX_DECISION} | 首装未演练 |`, '|  |  |  |'));
  await fs.rm(sealed.acceptance);
  const before = await fs.readFile(w.index), request = await fs.readFile(w.requestFile), n = (await w.calls()).length, reads = w.s.kitReads;
  await assert.rejects(w.prep(), e => e.code === 'PREPARE_VERSION_ALREADY_ACCEPTED' && /seal/.test(JSON.stringify(e.detail)));
  await unchanged(w, before, n);
  assert.ok((await fs.readFile(w.requestFile)).equals(request), 'the request is not written again');
  assert.equal(w.s.kitReads, reads);
  // and the same seal completes the row
  assert.equal((await w.sealIt()).status, 'FLEET_ACCEPTANCE_SEALED');
  assert.ok((await fs.readFile(w.index)).equals(index));
  // an accepted version without a kit on its Release (78ad314b): prepare never gives it one
  const w2 = await prepWorld(t);
  const acc = Buffer.from('{"contract":"clued.independent-ci.fleet-node-acceptance/1"}\n');
  await w2.setState(st => { st.assets.push({ name: `${TAG}.acceptance.json`, size: acc.length, b64: acc.toString('base64'), sha256: sha(acc) }); });
  const before2 = await fs.readFile(w2.index), n2 = (await w2.calls()).length;
  await assert.rejects(w2.prep(), { code: 'PREPARE_VERSION_ALREADY_ACCEPTED' });
  await unchanged(w2, before2, n2);
  assert.equal(w2.s.kitReads, 0, 'no node asked');
  assert.deepEqual(await w2.kitAssets(), []);
  await noRequest(w2);
});

test('prepare refuses an index row filled by hand while the Release holds no acceptance: not its to guess; nothing uploaded', async t => {
  const w = await prepWorld(t);
  const text = await fs.readFile(w.index, 'utf8');
  assert.ok(text.includes('|  |  |  |'));
  await fs.writeFile(w.index, text.split('|  |  |  |').join(`| 2026-11-12T08:00:00Z | ${DECISION} |  |`));
  const before = await fs.readFile(w.index), n = (await w.calls()).length;
  await assert.rejects(w.prep(), { code: 'PUBLISH_ACCEPTANCE_INDEX_WITHOUT_ASSET' });
  await noRequest(w);
  await unchanged(w, before, n);
});

// blocking 2: one check of the request against the Release, used by prepare before it writes the request and by seal before anything goes up
test('prepare does not write a request seal would refuse: a Release whose release.json names another commit is refused first', async t => {
  const w = await prepWorld(t);
  await w.setState(st => {
    const a = st.assets.find(x => x.name === `${TAG}.release.json`);
    const rel = JSON.parse(Buffer.from(a.b64, 'base64').toString('utf8'));
    rel.source.commit = 'b2'.repeat(20);
    const b = Buffer.from(JSON.stringify(rel, null, 1) + '\n');
    a.b64 = b.toString('base64'); a.size = b.length; a.sha256 = sha(b);
  });
  await assert.rejects(w.prep(), { code: 'ACCEPTANCE_RELEASE_METADATA_NOT_THE_REQUESTS' });
  await noRequest(w);
  assert.deepEqual(await w.kitAssets(), [], 'refused before the kit is attached');
  assert.deepEqual(await uploadsOf(w), [], 'nothing uploaded');
});

// ruling test 3: seal never touches a node or a kit; the acceptance is the request's fields and the five the door's answer gives
test('seal: the request and the answer of the door; no node asked, only the acceptance uploaded; on the Release, next to the request, in the index; again changes nothing', async t => {
  const w = await prepWorld(t);
  await w.prep();
  w.s.kitBroken = true;   // from here a node asked for a kit fails the test
  const n = (await w.calls()).length;
  const r = await w.sealIt();
  assert.equal(r.status, 'FLEET_ACCEPTANCE_SEALED');
  assert.deepEqual((await w.calls()).slice(n).filter(c => c.args[1] === 'upload').map(c => path.basename(c.args[3])), [`${TAG}.acceptance.json`], 'only the acceptance goes up');
  const request = JSON.parse(await fs.readFile(w.requestFile, 'utf8'));
  const a = JSON.parse(await fs.readFile(r.acceptance, 'utf8'));
  assert.equal(r.acceptance, path.join(w.out, `${TAG}.acceptance.json`));
  // the five fields come from the door's answer: grant_id, receipt_id, accepted_at (UTC, to the second)
  assert.deepEqual(a, acceptanceOf(request, { decision: FIX_DECISION, receipt: FIX_RECEIPT, acceptedAt: FIX_ACCEPTED_AT }));
  assert.deepEqual([a.cluedDecision, a.fleetRefs.ownerDecisionRef, a.fleetRefs.installationReceiptRef, a.fleetRefs.ownerReceiptRef, a.acceptedAt],
    ['c556370f-b0fc-404b-b164-0f06699e4c7a', 'c556370f-b0fc-404b-b164-0f06699e4c7a', '7ccaefca-5fda-4bc8-9747-2a8101b92342', '7ccaefca-5fda-4bc8-9747-2a8101b92342', '2026-11-19T12:22:39Z']);
  await assert.rejects(fs.access(path.join(w.out, `${TAG}.decision-record.json`)), 'no Decision record next to the request');
  assert.equal((await w.assets()).find(x => x.name === `${TAG}.acceptance.json`).sha256, sha(await fs.readFile(r.acceptance)));
  assert.equal((await fs.readFile(w.index, 'utf8')).split('\r\n')[2], `| ${VERSION} | ${r.url} | ${w.source.archive_sha256} | ${COMMIT} | 2026-11-19T12:22:39Z | ${FIX_DECISION} | 首装未演练 |`);
  // again: nothing uploaded, nothing changed
  const index = await fs.readFile(w.index), m = (await w.calls()).length;
  const again = await w.sealIt();
  assert.equal(again.already, true);
  assert.ok((await fs.readFile(w.index)).equals(index));
  assert.deepEqual((await w.calls()).slice(m).filter(c => c.args[1] === 'upload'), []);
  // a run that stopped after the upload, before the index row: the same command completes the row, uploads nothing
  await fs.writeFile(w.index, index.toString('utf8').replace(`| 2026-11-19T12:22:39Z | ${FIX_DECISION} | 首装未演练 |`, '|  |  |  |'));
  await fs.rm(r.acceptance);
  const k0 = (await uploadsOf(w)).length;
  const done = await w.sealIt();
  assert.equal(done.already, false);
  assert.ok((await fs.readFile(w.index)).equals(index));
  assert.equal((await uploadsOf(w)).length, k0);
  // another Grant for an accepted version (a door that answered other ids): refused before anything is uploaded or written
  Object.assign(w.door, { grant: 'a1b2c3d4-0000-4000-8000-000000000009', receipt: 'a1b2c3d4-0000-4000-8000-00000000000a' });
  const before = await fs.readFile(w.index), k = (await w.calls()).length;
  await assert.rejects(w.sealIt(), { code: 'SEAL_ANOTHER_ACCEPTANCE_IN_DIRECTORY' });
  await fs.rename(r.acceptance, `${r.acceptance}.kept`);
  await assert.rejects(w.sealIt(), { code: 'PUBLISH_ACCEPTANCE_ALREADY_ATTACHED' });
  await unchanged(w, before, k);
  await assert.rejects(fs.access(r.acceptance));
});

// the drill's own acceptance file (acceptanceOf with DRILL_RESERVED) never reaches a Release; the door's answer naming the drill's ids is the
// door-answer test below
test('attach-acceptance refuses the stand-in acceptance file of the drill', async t => {
  const w = await prepWorld(t);
  await w.prep();
  const n = (await uploadsOf(w)).length;
  // the drill's own acceptance file (acceptanceOf with DRILL_RESERVED): refused by the step under seal too
  const drillFile = path.join(w.d, 'drill', `${TAG}.acceptance.json`);
  await fs.mkdir(path.dirname(drillFile));
  await fs.writeFile(drillFile, JSON.stringify(acceptanceOf(JSON.parse(await fs.readFile(w.requestFile, 'utf8')), DRILL_RESERVED)));
  await assert.rejects(attachAcceptance({ version: VERSION, acceptance: drillFile, index: w.index, ghCommand: [process.execPath, w.fake] }), { code: 'ACCEPTANCE_IS_THE_DRILLS_STAND_IN' });
  assert.equal((await uploadsOf(w)).length, n);
});

// ruling test 5 and blocking 2: the request against the Release as it is now (tar, release metadata, Source recomputed from the Release's tar, kit)
test('seal refuses a request whose Source is well formed but not the Release tar\'s, whose commit is not the Release\'s metadata, or whose tar or kit is not the Release\'s', async t => {
  const w = await prepWorld(t);
  await w.prep();
  const request = JSON.parse(await fs.readFile(w.requestFile, 'utf8'));
  const before = await fs.readFile(w.index), n = (await uploadsOf(w)).length;
  const cases = [
    [{ ciSourceManifestSha256: 'c'.repeat(64) }, 'ACCEPTANCE_SOURCE_NOT_THE_RELEASES'],
    [{ firstInstallKitSha256: 'f'.repeat(64) }, 'ACCEPTANCE_KIT_NOT_THE_ATTACHED'],
    [{ archive_sha256: 'f'.repeat(64) }, 'ACCEPTANCE_NOT_THIS_RELEASE'],
    [{ commit: 'b2'.repeat(20) }, 'ACCEPTANCE_NOT_THIS_RELEASE'],
    [{ cluedDecision: FIX_DECISION }, 'REQUEST_REFUSED'],
    [{ fleetRefs: { ...request.fleetRefs, ownerDecisionRef: FIX_DECISION } }, 'REQUEST_REFUSED'],
    [{ ciSourceManifestSha256: 'x' }, 'REQUEST_REFUSED'],
    [{ repository: 'other/repo' }, 'ACCEPTANCE_NOT_THIS_REPOSITORY'],
  ];
  for (const [over, code] of cases) {
    await fs.writeFile(w.requestFile, JSON.stringify({ ...request, ...over }));
    await assert.rejects(w.sealIt(), { code }, code);
  }
  // the index row and the request agree on another commit, the Release's release.json does not
  await fs.writeFile(w.requestFile, JSON.stringify({ ...request, commit: 'b2'.repeat(20) }));
  const text = await fs.readFile(w.index, 'utf8');
  await fs.writeFile(w.index, text.replace(`| ${COMMIT} |`, `| ${'b2'.repeat(20)} |`));
  await assert.rejects(w.sealIt(), { code: 'ACCEPTANCE_RELEASE_METADATA_NOT_THE_REQUESTS' });
  await fs.writeFile(w.index, text);
  await fs.writeFile(w.requestFile, JSON.stringify(request));
  // the Release's SHA256SUMS names another tar
  let kept;
  await w.setState(st => { const s0 = st.assets.find(a => a.name === 'SHA256SUMS'); kept = s0.b64; s0.b64 = b64Of(Buffer.from(kept, 'base64').toString('utf8').replace(w.source.archive_sha256, '9'.repeat(64))); });
  await assert.rejects(w.sealIt(), { code: 'ACCEPTANCE_ARCHIVE_NOT_THE_RELEASES' });
  await w.setState(st => { st.assets.find(a => a.name === 'SHA256SUMS').b64 = kept; });
  const wrongName = path.join(w.out, 'request.json');
  await fs.writeFile(wrongName, JSON.stringify(request));
  await assert.rejects(w.sealIt({ request: wrongName }), { code: 'REQUEST_FILE_NAME_REFUSED' });
  assert.ok((await fs.readFile(w.index)).equals(before));
  assert.equal((await uploadsOf(w)).length, n, 'nothing uploaded');
  await assert.rejects(fs.access(path.join(w.out, `${TAG}.acceptance.json`)));
  // the request as prepare wrote it still seals
  assert.equal((await w.sealIt()).status, 'FLEET_ACCEPTANCE_SEALED');
});

// Fable renew-key ruling, supplement "one round exposes every error" (3): branch candidates may be built, released, prepared and drilled to
// probe, but the one accepted must be built from a commit already on main. seal asks GitHub where the request's commit stands against main
// (compare main...<commit>: identical or behind = on main) and refuses anything else, and refuses when it cannot tell, before anything is
// uploaded or written.
test('seal refuses a candidate whose commit is not on main, or whose place cannot be read: nothing uploaded or written; one on main seals', async t => {
  const w = await prepWorld(t);
  await w.prep();
  const request = JSON.parse(await fs.readFile(w.requestFile, 'utf8'));
  const before = await fs.readFile(w.index), n = (await uploadsOf(w)).length;
  for (const [compare, code] of [['ahead', 'SEAL_COMMIT_NOT_ON_MAIN'], ['diverged', 'SEAL_COMMIT_NOT_ON_MAIN'], ['fail', 'SEAL_MAIN_UNREADABLE'],
    ['garbled', 'SEAL_MAIN_UNREADABLE']]) {
    await w.setState(st => { st.compare = compare; });
    await assert.rejects(w.sealIt(), { code }, compare);
  }
  assert.ok((await fs.readFile(w.index)).equals(before));
  assert.equal((await uploadsOf(w)).length, n, 'nothing uploaded');
  await assert.rejects(fs.access(path.join(w.out, `${TAG}.acceptance.json`)));
  await assert.rejects(fs.access(path.join(w.out, `${TAG}.decision-record.json`)));
  const asked = (await w.calls()).filter(c => c.args[0] === 'api');
  assert.ok(asked.length >= 4 && asked.every(c => c.args[1] === `repos/${request.repository}/compare/main...${request.commit}`), JSON.stringify(asked.map(c => c.args)));
  await w.setState(st => { st.compare = 'identical'; });
  assert.equal((await w.sealIt()).status, 'FLEET_ACCEPTANCE_SEALED');
});

// blocking 4: a candidate drill's receipt is taken only with one of two conclusions and candidate true; the set is defined once and exported
test('seal --drill-receipt: one of the two PASS conclusions of a candidate with these three hashes; anything else is refused first; the cell is never replaced', async t => {
  assert.deepEqual(publishModule.DRILL_PASS_CONCLUSIONS, ['PASS_A_FULL', 'PASS_A_PER_NODE_STEPS_REMAIN']);
  assert.ok(Object.isFrozen(publishModule.DRILL_PASS_CONCLUSIONS));
  const w = await prepWorld(t);
  await w.prep();
  const request = JSON.parse(await fs.readFile(w.requestFile, 'utf8'));
  assert.equal(publishModule.namesDrillReserved?.(acceptanceOf(request, DRILL_RESERVED)), true);
  assert.equal(publishModule.namesDrillReserved?.(acceptanceOf(request, { decision: FIX_DECISION, receipt: FIX_RECEIPT, acceptedAt: FIX_ACCEPTED_AT })), false);
  const receiptFile = path.join(w.d, 'receipt.json');
  const pass = { contract: 'clued.independent-ci.drill-receipt/1', version: VERSION, candidate: true, conclusion: 'PASS_A_FULL', tarSha256: request.archive_sha256,
    ciSourceManifestSha256: request.ciSourceManifestSha256, firstInstallKitSha256: request.firstInstallKitSha256, kitSha256: 'd'.repeat(64) };
  const before = await fs.readFile(w.index), n = (await w.calls()).length;
  for (const [over, code] of [[{ conclusion: 'FAIL' }, 'SEAL_DRILL_RECEIPT_NOT_PASS'], [{ conclusion: 'PENDING_PRODUCTION_READBACK' }, 'SEAL_DRILL_RECEIPT_NOT_PASS'],
    [{ conclusion: 'PASS_A_PENDING_PRODUCTION_READBACK' }, 'SEAL_DRILL_RECEIPT_NOT_PASS'], [{ conclusion: 'PASS_ANYTHING' }, 'SEAL_DRILL_RECEIPT_NOT_PASS'],
    [{ conclusion: 'PASS_A_REINSTALL_NOT_DRILLED' }, 'SEAL_DRILL_RECEIPT_NOT_PASS'],
    [{ candidate: undefined }, 'SEAL_DRILL_RECEIPT_NOT_A_CANDIDATE'], [{ candidate: false }, 'SEAL_DRILL_RECEIPT_NOT_A_CANDIDATE'], [{ candidate: 'true' }, 'SEAL_DRILL_RECEIPT_NOT_A_CANDIDATE'],
    [{ firstInstallKitSha256: 'f'.repeat(64) }, 'SEAL_DRILL_RECEIPT_NOT_THIS_PACKAGE'], [{ tarSha256: 'f'.repeat(64) }, 'SEAL_DRILL_RECEIPT_NOT_THIS_PACKAGE'],
    [{ ciSourceManifestSha256: 'f'.repeat(64) }, 'SEAL_DRILL_RECEIPT_NOT_THIS_PACKAGE'], [{ firstInstallKitSha256: undefined }, 'SEAL_DRILL_RECEIPT_NOT_THIS_PACKAGE'],
    [{ version: '2026.11.12-2' }, 'SEAL_DRILL_RECEIPT_REFUSED'], [{ contract: 'x' }, 'SEAL_DRILL_RECEIPT_REFUSED']]) {
    await fs.writeFile(receiptFile, JSON.stringify({ ...pass, ...over }));
    await assert.rejects(w.sealIt({ drillReceipt: receiptFile }), { code }, JSON.stringify(over));
  }
  await unchanged(w, before, n);
  const bytes = Buffer.from(JSON.stringify({ ...pass, conclusion: 'PASS_A_PER_NODE_STEPS_REMAIN' }));
  await fs.writeFile(receiptFile, bytes);
  const r = await w.sealIt({ drillReceipt: receiptFile });
  assert.equal(r.drill, `PASS_A_PER_NODE_STEPS_REMAIN receipt ${sha(bytes)}`);
  assert.ok((await fs.readFile(w.index, 'utf8')).split('\r\n')[2].endsWith(`| ${FIX_DECISION} | PASS_A_PER_NODE_STEPS_REMAIN receipt ${sha(bytes)} |`));
  // the same receipt again: nothing changes; another receipt, or none: refused, the cell stays
  assert.equal((await w.sealIt({ drillReceipt: receiptFile })).already, true);
  const index = await fs.readFile(w.index);
  const other = path.join(w.d, 'receipt-2.json');
  await fs.writeFile(other, JSON.stringify(pass));
  await assert.rejects(w.sealIt({ drillReceipt: other }), { code: 'SEAL_DRILL_RECEIPT_NOT_THE_RECORDED' });
  await assert.rejects(w.sealIt({ drillReceipt: null }), { code: 'SEAL_DRILL_RECEIPT_NOT_THE_RECORDED' });
  assert.ok((await fs.readFile(w.index)).equals(index));
});

// review r2, blocking: a second download of the same asset (prepare reads the Release before and after it attaches the kit) must not land on
// the first one's file: the real gh refuses a file that is already there (the fake one now does too)
test('prepare reads the Release twice (before and after the kit) without a download landing on an earlier one; the request is written', async t => {
  const w = await prepWorld(t);
  const r = await w.prep();
  assert.equal(r.status, 'FLEET_ACCEPTANCE_REQUEST_WRITTEN');
  const sumsDownloads = (await w.calls()).filter(c => c.args[1] === 'download' && c.args[c.args.indexOf('--pattern') + 1] === 'SHA256SUMS');
  assert.ok(sumsDownloads.length >= 2, 'the Release is read again after the kit is attached');
  const dirs = sumsDownloads.map(c => c.args[c.args.indexOf('--dir') + 1]);
  assert.equal(new Set(dirs).size, dirs.length, 'every download into a directory of its own');
  // and seal, whose check reads the same assets again
  assert.equal((await w.sealIt()).status, 'FLEET_ACCEPTANCE_SEALED');
});

// review r2, the same gap before the rework: two images reused from the previous Release read its first-install sums twice
test('prepare reuses two role images from the previous Release: its sums file is read for each without a download landing on an earlier one', async t => {
  const w = await prepWorld(t);
  const IMAGE2 = 'd'.repeat(64);
  const kitOf = async () => ({ contract: 'clued.independent-ci.fleet-node-first-install-kit/1', template: { versionFacts: 'e30=' }, config: { ciSourceManifestSha256: 'a'.repeat(64) },
    images: { pull: [], local: [{ id: IMAGE, asset: `role-image-${IMAGE}.tar.gz` }, { id: IMAGE2, asset: `role-image-${IMAGE2}.tar.gz` }] } });
  const prev = '2026.11.11-1', prevTag = `fleet-node-${prev}`;
  const one = Buffer.from('gzip of a docker save'), two = Buffer.from('gzip of another docker save');
  const lines = (await fs.readFile(w.index, 'utf8')).split('\r\n');
  await fs.writeFile(w.index, [lines[0], lines[1], `| ${prev} | u | ${'1'.repeat(64)} | ${'2'.repeat(40)} | 2026-11-11T00:00:00Z | b5d041d2 |  |`, ...lines.slice(2)].join('\r\n'));
  const sumsText = `${sha(one)}  role-image-${IMAGE}.tar.gz\n${sha(two)}  role-image-${IMAGE2}.tar.gz\n`;
  await w.setState(st => { st.other = { [prevTag]: [{ name: `role-image-${IMAGE}.tar.gz`, size: one.length, b64: one.toString('base64') },
    { name: `role-image-${IMAGE2}.tar.gz`, size: two.length, b64: two.toString('base64') }, { name: `${prevTag}.first-install.SHA256SUMS`, size: sumsText.length, b64: b64Of(sumsText) }] }; });
  const r = await w.prep({ images: [], deps: { ...w.deps, kitOf } });
  assert.equal(r.status, 'FLEET_ACCEPTANCE_REQUEST_WRITTEN');
  assert.deepEqual(r.images, [IMAGE, IMAGE2].sort());
  const up = Object.fromEntries((await w.assets()).map(a => [a.name, a.sha256]));
  assert.deepEqual([up[`role-image-${IMAGE}.tar.gz`], up[`role-image-${IMAGE2}.tar.gz`]], [sha(one), sha(two)]);
});

// ---------------------------------------------------------------- prepare makes the Release it needs (FABLE-drill-release-step-20261121.md):
// there is no release command any more; prepare finds the Release and the index row as they are, creates what is missing, completes a
// release that stopped half way, and refuses another build of the same version, a row without its Release and a commit not on the remote.

// T1 of the ruling, in this file's terms: a build, an index with its header only, an empty gh state, no release step
test('prepare on a build with no Release and no index row: checks the commit on the remote, creates the Release as release did, appends the row, writes the request', async t => {
  const w = await prepWorld(t, { released: false });
  const r = await w.prep();
  assert.equal(r.status, 'FLEET_ACCEPTANCE_REQUEST_WRITTEN');
  const calls = await w.calls();
  const commitAt = calls.findIndex(c => c.args[0] === 'api' && c.args[1] === `repos/${REPO}/commits/${COMMIT}`);
  const creates = calls.filter(c => c.args[1] === 'create');
  assert.equal(creates.length, 1);
  assert.ok(commitAt >= 0 && commitAt < calls.indexOf(creates[0]), 'the commit is asked for before the Release is created');
  assert.deepEqual(creates[0].args.slice(3, 8).map(f => path.basename(f)), RELEASE_ASSETS);
  assert.equal(creates[0].args[creates[0].args.indexOf('--target') + 1], COMMIT);
  assert.deepEqual(creates[0].tokenSeen, []);
  assert.deepEqual((await fs.readFile(w.index, 'utf8')).split('\r\n').slice(2), [rowOf(w), ''], 'one row');
  for (const n of [...RELEASE_ASSETS, `${TAG}.first-install-kit.json`, `role-image-${IMAGE}.tar.gz`, `${TAG}.first-install.SHA256SUMS`]) {
    assert.equal((await w.assets()).filter(a => a.name === n).length, 1, n);
  }
  await fs.access(w.requestFile);
});

// T2: the Release was created, the index row was never written (the G: write stopped)
test('prepare after a release that stopped before the index row: no second create, the row as release writes it, the request', async t => {
  const w = await prepWorld(t, { released: false });
  await seedRelease(w);
  const r = await w.prep();
  assert.equal(r.status, 'FLEET_ACCEPTANCE_REQUEST_WRITTEN');
  assert.deepEqual((await w.calls()).filter(c => c.args[1] === 'create'), [], 'no second create');
  assert.deepEqual((await releaseWrites(w)).map(c => path.basename(c.args[3])).filter(n => RELEASE_ASSETS.includes(n)), [], 'no package asset uploaded again');
  const lines = (await fs.readFile(w.index, 'utf8')).split('\r\n');
  assert.deepEqual(lines.slice(2), [rowOf(w), '']);
  await fs.access(w.requestFile);
  // the very row a prepare that created the Release writes
  const fresh = await prepWorld(t, { released: false });
  await fresh.prep();
  assert.equal((await fs.readFile(fresh.index, 'utf8')).split('\r\n')[2], lines[2]);
});

// T3: the Release holds only the tar (create stopped after the first asset)
test('prepare after a release that stopped half way: the four missing assets uploaded, never --clobber, the row and the request', async t => {
  const w = await prepWorld(t, { released: false });
  await seedRelease(w, { only: [`${TAG}.tar`] });
  const r = await w.prep();
  assert.equal(r.status, 'FLEET_ACCEPTANCE_REQUEST_WRITTEN');
  const writes = await releaseWrites(w);
  assert.deepEqual(writes.filter(c => c.args[1] === 'create'), []);
  assert.deepEqual(writes.map(c => path.basename(c.args[3])).filter(n => RELEASE_ASSETS.includes(n)).sort(), RELEASE_ASSETS.filter(n => n !== `${TAG}.tar`).sort());
  assert.ok((await w.calls()).every(c => !c.args.includes('--clobber')), 'never --clobber');
  for (const n of RELEASE_ASSETS) assert.equal((await w.assets()).filter(a => a.name === n).length, 1, n);
  assert.deepEqual((await fs.readFile(w.index, 'utf8')).split('\r\n').slice(2), [rowOf(w), '']);
  await fs.access(w.requestFile);
});

// T4: what can be checked locally is checked before anything is written outside
test('prepare checks first and writes after: a template of this Source or a missing image, with no Release, is refused with no create, no upload, the index as it was', async t => {
  for (const [over, run, code] of [[{ templateSource: 'b'.repeat(64), packageSource: 'b'.repeat(64) }, {}, 'PREPARE_TEMPLATE_IS_THIS_SOURCE'],
    [{}, { images: [] }, 'PREPARE_IMAGE_MISSING']]) {
    const w = await prepWorld(t, { released: false, ...over });
    const before = await fs.readFile(w.index);
    await assert.rejects(w.prep(run), { code }, code);
    assert.deepEqual(await releaseWrites(w), [], `${code}: nothing created or uploaded`);
    assert.ok((await fs.readFile(w.index)).equals(before), `${code}: the index as it was`);
    await noRequest(w);
  }
});

// T5: what prepare does not guess
test('prepare refuses an index row without its Release, a Release of another build of this version, a commit not on the remote: nothing written', async t => {
  // (a) the row is there, the Release is not
  const a = await prepWorld(t, { released: false });
  await fs.appendFile(a.index, `${rowOf(a)}\r\n`);
  const beforeA = await fs.readFile(a.index);
  await assert.rejects(a.prep(), { code: 'PREPARE_INDEX_ROW_WITHOUT_RELEASE' });
  assert.deepEqual(await releaseWrites(a), []);
  assert.ok((await fs.readFile(a.index)).equals(beforeA));
  await noRequest(a);
  // (b) the Release's SHA256SUMS is another build's (the same version built again): refused before any upload
  const b = await prepWorld(t, { released: false });
  await seedRelease(b);
  await b.setState(st => { const x = st.assets.find(y => y.name === 'SHA256SUMS'); x.text = x.text.replace(b.source.archive_sha256, '9'.repeat(64)); x.b64 = b64Of(x.text); x.sha256 = sha(Buffer.from(x.text)); });
  const beforeB = await fs.readFile(b.index);
  await assert.rejects(b.prep(), e => ['ACCEPTANCE_ARCHIVE_NOT_THE_RELEASES', 'ACCEPTANCE_RELEASE_METADATA_NOT_THE_REQUESTS'].includes(e.code), 'another build');
  assert.deepEqual(await releaseWrites(b), [], 'nothing uploaded');
  assert.ok((await fs.readFile(b.index)).equals(beforeB));
  await noRequest(b);
  // (c) the commit is not on the remote (the API answers 404): refused before anything is written
  const c = await prepWorld(t, { released: false });
  await fs.writeFile(c.state, JSON.stringify({ calls: [], assets: [], commitMissing: true }));
  const beforeC = await fs.readFile(c.index);
  await assert.rejects(c.prep(), { code: 'PREPARE_COMMIT_NOT_ON_REMOTE' });
  assert.ok((await c.calls()).some(x => x.args[0] === 'api' && x.args[1] === `repos/${REPO}/commits/${COMMIT}`), 'asked of the remote');
  assert.deepEqual(await releaseWrites(c), []);
  assert.ok((await fs.readFile(c.index)).equals(beforeC));
  await noRequest(c);
});

// T6: the release command is gone (an empty directory: before the fix it is refused by the build check, so nothing outside is reached)
test('main: release is no command, in any form', async t => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'fleetnorelease'));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  await assert.rejects(main(['release', '--dir', d, '--repo', 'a/b']), { code: 'USAGE' });
  await assert.rejects(main(['release', '--dir', d, '--repo', 'a/b', '--index', path.join(d, 'index.md')]), { code: 'USAGE' });
  await assert.rejects(main(['release']), { code: 'USAGE' });
});

// What the release command checked and wrote, now prepare's step 4 (the same assets, notes, target and index row)
test('prepare creates the Release as release did: gh release create <tag> <five assets> --target <commit>, without any token variable; then one index line; again no second create', async t => {
  const w = await prepWorld(t, { released: false });
  const r = await w.prep();
  assert.equal(r.status, 'FLEET_ACCEPTANCE_REQUEST_WRITTEN');
  const calls = await w.calls();
  const create = calls.find(c => c.args[1] === 'create'), view = calls[calls.indexOf(create) + 1];
  assert.deepEqual(create.args.slice(0, 3), ['release', 'create', TAG]);
  assert.deepEqual(create.args.slice(3, 8).map(f => path.basename(f)), RELEASE_ASSETS);
  // the two node-entry assets are the archive's bytes; the published SHA256SUMS lists the four others (the build's two lines kept)
  const up = Object.fromEntries((await w.assets()).map(a => [a.name, a]));
  assert.equal(up[`${TAG}.bootstrap.ps1`].sha256, sha(BOOTSTRAP));
  assert.equal(up[`${TAG}.prereq-manifest.json`].sha256, sha(PREREQ));
  const sums = up.SHA256SUMS.text.split('\n').filter(Boolean);
  assert.deepEqual(sums.map(l => l.split('  ')[1]), [`${TAG}.bootstrap.ps1`, `${TAG}.prereq-manifest.json`, `${TAG}.release.json`, `${TAG}.tar`], 'sorted by name');
  for (const l of sums) { const [h, n] = l.split('  '); assert.equal(h, up[n].sha256, n); }
  assert.equal(up[`${TAG}.tar`].sha256, sha(w.tar));
  assert.equal((await fs.readFile(path.join(w.build, 'SHA256SUMS'), 'utf8')).split('\n').filter(Boolean).length, 2, 'the build output is not changed');
  assert.equal(create.args[create.args.indexOf('--repo') + 1], REPO);
  assert.equal(create.args[create.args.indexOf('--target') + 1], COMMIT);
  assert.equal(create.args[create.args.indexOf('--title') + 1], TAG);
  assert.equal(create.args[create.args.indexOf('--notes') + 1].split('\n')[0], `Universal node package ${VERSION} (commit ${COMMIT}).`);
  assert.deepEqual(create.tokenSeen, [], 'gh uses only its own login');
  assert.deepEqual(view.args.slice(0, 3), ['release', 'view', TAG]);
  assert.ok(!JSON.stringify(calls).includes('fake-token-value'), 'no token in any argument');
  const lines = (await fs.readFile(w.index, 'utf8')).split('\r\n');
  assert.equal(lines[2], rowOf(w));
  assert.equal(lines.length, 4, 'one line, with the index\'s own line ending');
  // the same prepare again: no second create, the index as it is
  const index = await fs.readFile(w.index);
  await w.prep();
  assert.equal((await w.calls()).filter(c => c.args[1] === 'create').length, 1);
  assert.ok((await fs.readFile(w.index)).equals(index));
});

test('prepare refuses a build whose archive is not its release.json, and leaves the index alone when gh fails', async t => {
  const w = await prepWorld(t, { released: false });
  const before = await fs.readFile(w.index);
  await fs.appendFile(path.join(w.build, `${TAG}.tar`), 'x');
  await assert.rejects(w.prep(), { code: 'PUBLISH_ARCHIVE_SHA_MISMATCH' });
  await fs.writeFile(path.join(w.build, `${TAG}.tar`), w.tar);
  t.after(() => { delete process.env.FAKE_GH_FAIL_CREATE; delete process.env.FAKE_GH_FAIL; });
  process.env.FAKE_GH_FAIL_CREATE = '1';
  await assert.rejects(w.prep(), { code: 'PUBLISH_GH_RELEASE_CREATE_FAILED' });
  delete process.env.FAKE_GH_FAIL_CREATE;
  process.env.FAKE_GH_FAIL = '1';
  await assert.rejects(w.prep(), { code: 'PUBLISH_GH_RELEASE_VIEW_FAILED' });
  delete process.env.FAKE_GH_FAIL;
  assert.ok((await fs.readFile(w.index)).equals(before));
  await noRequest(w);
  await fs.writeFile(path.join(w.build, 'SHA256SUMS'), `${'0'.repeat(64)}  ${TAG}.tar\n`);
  await assert.rejects(w.prep(), { code: 'PUBLISH_SHA256SUMS_MISMATCH' });
  await assert.rejects(w.prep({ repo: 'not a repo' }), { code: 'PUBLISH_REPO_REFUSED' });
});

test('prepare creates an absent index with the seven-column header, and completes an older five- or six-column one', async t => {
  const w = await prepWorld(t, { released: false });
  const fresh = path.join(w.d, 'sub', 'new-index.md');
  await w.prep({ index: fresh });
  const lines = (await fs.readFile(fresh, 'utf8')).split('\n');
  assert.equal(lines[0], '| 版本 | Release | tar sha256 | commit | 接受时间 | Decision | 首装演练 |');
  assert.equal(lines[1], '|---|---|---|---|---|---|---|');
  assert.ok(lines[2].startsWith(`| ${VERSION} | https://`) && lines[2].endsWith(`| ${COMMIT} |  |  |  |`));
  // the Release is there from now on: the next two complete their index only
  const old = path.join(w.d, 'old-index.md');
  await fs.writeFile(old, '| 版本 | Release | tar sha256 | commit | 接受时间 |\n|---|---|---|---|---|\n| 0.1 | u | h | c |  |\n');
  await w.prep({ index: old });
  const o = (await fs.readFile(old, 'utf8')).split('\n');
  assert.deepEqual(o.slice(0, 3), ['| 版本 | Release | tar sha256 | commit | 接受时间 | Decision | 首装演练 |', '|---|---|---|---|---|---|---|', '| 0.1 | u | h | c |  |  |  |']);
  assert.ok(o[3].startsWith(`| ${VERSION} |`));
  // the six-column table of today (accepted rows keep their cells; the drill cell of an older row stays empty)
  const six = path.join(w.d, 'six-index.md');
  await fs.writeFile(six, '| 版本 | Release | tar sha256 | commit | 接受时间 | Decision |\n|---|---|---|---|---|---|\n| 0.2 | u | h | c | 2026-11-19T12:22:39Z | c556370f |\n');
  await w.prep({ index: six });
  assert.deepEqual((await fs.readFile(six, 'utf8')).split('\n').slice(0, 3), ['| 版本 | Release | tar sha256 | commit | 接受时间 | Decision | 首装演练 |', '|---|---|---|---|---|---|---|',
    '| 0.2 | u | h | c | 2026-11-19T12:22:39Z | c556370f |  |']);
  assert.equal((await w.calls()).filter(c => c.args[1] === 'create').length, 1);
});

test('prepare refuses an archive without the node entry (bootstrap.ps1, prereq-manifest.json) before gh is called', async t => {
  const w = await prepWorld(t, { released: false });
  const tar = writeTar([{ path: `${FLEET}bootstrap.ps1`, data: BOOTSTRAP }, { path: 'universal-manifest.json', data: Buffer.from('{}') }]);
  const rel = JSON.parse(await fs.readFile(path.join(w.build, `${TAG}.release.json`), 'utf8'));
  rel.source.archive_sha256 = sha(tar); rel.archive = { name: `${TAG}.tar`, bytes: tar.length, sha256: sha(tar) };
  const rb = Buffer.from(JSON.stringify(rel, null, 1) + '\n');
  await fs.writeFile(path.join(w.build, `${TAG}.tar`), tar);
  await fs.writeFile(path.join(w.build, `${TAG}.release.json`), rb);
  await fs.writeFile(path.join(w.build, 'SHA256SUMS'), `${sha(rb)}  ${TAG}.release.json\n${sha(tar)}  ${TAG}.tar\n`);
  await assert.rejects(w.prep(), { code: 'PUBLISH_ARCHIVE_LACKS_NODE_ENTRY' });
  assert.equal((await w.calls()).length, 0);
});

// Review 0e418483 (D:/w/tmp/claude-drill-release-review.result.md). A Release of this version already there is held to this build byte for
// byte, every asset it has, before anything goes up or into the index: the same size is not the same build (a tar is 512-byte aligned).
const flip = (st, name, at) => { const a = st.assets.find(x => x.name === name); const b = Buffer.from(a.b64, 'base64'); b[at < 0 ? b.length + at : at] ^= 0x01; a.b64 = b.toString('base64'); a.sha256 = sha(b); if ('text' in a) a.text = b.toString('utf8'); };
const nothingWritten = async (w, before) => {
  assert.deepEqual(await releaseWrites(w), [], 'nothing uploaded, nothing created');
  assert.ok((await fs.readFile(w.index)).equals(before), 'the index as it was');
  await noRequest(w);
};

// REVIEW H1 (S1): the half Release holds only a tar, another build's of the same size
test('prepare refuses a half Release whose tar is another build\'s of the same size, before any upload or index row', async t => {
  const w = await prepWorld(t, { released: false });
  await seedRelease(w, { only: [`${TAG}.tar`] });
  await w.setState(st => flip(st, `${TAG}.tar`, -1));
  const before = await fs.readFile(w.index);
  await assert.rejects(w.prep(), { code: 'ACCEPTANCE_ARCHIVE_NOT_THE_RELEASES' });
  await nothingWritten(w, before);
  assert.deepEqual(await w.kitAssets(), []);
});

// REVIEW H2 (B1): a node-entry asset of other bytes, the same size: on a half Release, and on a whole one whose SHA256SUMS is this build's
test('prepare refuses a Release whose bootstrap.ps1 or prereq-manifest.json is other bytes of the same size, half or whole, before any upload', async t => {
  for (const name of [`${TAG}.bootstrap.ps1`, `${TAG}.prereq-manifest.json`]) {
    const half = await prepWorld(t, { released: false });
    await seedRelease(half, { only: [name] });
    await half.setState(st => flip(st, name, 0));
    const before = await fs.readFile(half.index);
    await assert.rejects(half.prep(), { code: 'ACCEPTANCE_RELEASE_METADATA_NOT_THE_REQUESTS' }, `half: ${name}`);
    await nothingWritten(half, before);
    const whole = await prepWorld(t, { released: false });
    await seedRelease(whole, { row: true });
    await whole.setState(st => flip(st, name, 0));
    const beforeWhole = await fs.readFile(whole.index);
    await assert.rejects(whole.prep(), { code: 'ACCEPTANCE_RELEASE_METADATA_NOT_THE_REQUESTS' }, `whole: ${name}`);
    await nothingWritten(whole, beforeWhole);
    assert.deepEqual(await whole.kitAssets(), [], 'refused before the kit is attached');
  }
});

// the tar held at step 4 is the one step 5 checks: a half Release with this build's tar has it downloaded once
test('prepare after a release that stopped after the tar: the Release\'s tar is downloaded once, held at step 4 and reused at step 5', async t => {
  const w = await prepWorld(t, { released: false });
  await seedRelease(w, { only: [`${TAG}.tar`] });
  assert.equal((await w.prep()).status, 'FLEET_ACCEPTANCE_REQUEST_WRITTEN');
  const tarDownloads = (await w.calls()).filter(c => c.args[1] === 'download' && c.args[c.args.indexOf('--pattern') + 1] === `${TAG}.tar`);
  assert.equal(tarDownloads.length, 1);
});

// REVIEW H3: no row of this version in the index yet (a candidate before its Release): the previous version's image is found
test('prepare with no row of this version yet takes the previous version\'s image from its Release', async t => {
  const w = await prepWorld(t, { released: false });
  const PREV = '0.0.1', PTAG = `fleet-node-${PREV}`, img = Buffer.from('previous image bytes');
  const sumsText = `${sha(img)}  role-image-${IMAGE}.tar.gz\n`;
  await fs.appendFile(w.index, `| ${PREV} | https://github.com/${REPO}/releases/tag/${PTAG} | ${'1'.repeat(64)} | ${'2'.repeat(40)} | 2026-11-01T00:00:00Z | x | y |\r\n`);
  await fs.writeFile(w.state, JSON.stringify({ calls: [], assets: [], other: { [PTAG]: [
    { name: `role-image-${IMAGE}.tar.gz`, size: img.length, sha256: sha(img), b64: img.toString('base64') },
    { name: `${PTAG}.first-install.SHA256SUMS`, size: sumsText.length, sha256: sha(Buffer.from(sumsText)), b64: b64Of(sumsText), text: sumsText }] } }));
  assert.equal((await w.prep({ images: [] })).status, 'FLEET_ACCEPTANCE_REQUEST_WRITTEN');
  assert.ok((await w.calls()).some(c => c.args[1] === 'download' && c.args[2] === PTAG && c.args.includes(`role-image-${IMAGE}.tar.gz`)), 'taken from the previous Release');
  assert.equal((await w.assets()).find(a => a.name === `role-image-${IMAGE}.tar.gz`)?.sha256, sha(img), 'and put on this one');
});

// the commit on the remote: only GitHub's "no such commit" is "not on the remote"; a lookup that fails otherwise (a dropped connection) is
// reported as that, not as a commit never pushed
test('prepare tells a commit not on the remote (404, or 422 no commit found) from a lookup that failed: nothing written either way', async t => {
  for (const [missing, code] of [[true, 'PREPARE_COMMIT_NOT_ON_REMOTE'], ['422', 'PREPARE_COMMIT_NOT_ON_REMOTE'], ['fail', 'PREPARE_COMMIT_LOOKUP_FAILED']]) {
    const w = await prepWorld(t, { released: false });
    await fs.writeFile(w.state, JSON.stringify({ calls: [], assets: [], commitMissing: missing }));
    const before = await fs.readFile(w.index);
    await assert.rejects(w.prep(), { code }, String(missing));
    await nothingWritten(w, before);
  }
});

// an index row of this version without its Release is refused at step 0: no kit taken from the node, no Source computed, no download
test('prepare refuses an index row without its Release at once: no kit taken, no Source computed, nothing downloaded', async t => {
  const w = await prepWorld(t, { released: false });
  await fs.appendFile(w.index, `${rowOf(w)}\r\n`);
  const before = await fs.readFile(w.index);
  await assert.rejects(w.prep(), { code: 'PREPARE_INDEX_ROW_WITHOUT_RELEASE' });
  assert.equal(w.s.kitReads, 0, 'the node was not asked for its kit');
  assert.deepEqual(w.s.sourceDrafts, [], 'no Source computed');
  assert.deepEqual((await w.calls()).filter(c => c.args[1] === 'download'), [], 'nothing downloaded');
  await nothingWritten(w, before);
});

// ---------------------------------------------------------------- seal through the acceptance door (PLAN-accept-auto-seal-20261125 2.2, part B)
// The Owner's acceptance is one fleet.accept Grant approved on the confirm page; seal opens the request itself and reads Grant id, receipt id and
// the time from the door's answer. The Decision record (clued_record_mutate's return, saved by hand) has no way in.
const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const GRANT = 'a5a5a5a5-1111-4111-8111-0000000000a1', GRANT_RECEIPT = 'b6b6b6b6-2222-4222-8222-0000000000b2';
const resourceOf = async w => `fleet-node:${REPO}/${VERSION}/${w.source.archive_sha256}/${sha(await fs.readFile(w.requestFile))}`;
const sealedNothing = async (w, indexBefore, uploadsBefore) => {
  assert.ok((await fs.readFile(w.index)).equals(indexBefore), 'the index is as it was');
  assert.equal((await uploadsOf(w)).length, uploadsBefore, 'nothing uploaded');
  assert.ok(!(await w.assets()).some(a => a.name.endsWith('.acceptance.json')), 'no acceptance on the Release');
  await assert.rejects(fs.access(path.join(w.out, `${TAG}.acceptance.json`)), 'no acceptance next to the request');
};

test('seal through the door: not approved yet it answers WAITING_OWNER with the link, Release and index untouched; approved, the same call seals with the door\'s three values; again already, the same bytes', async t => {
  const w = await prepWorld(t);
  await w.prep();
  w.s.kitBroken = true;
  Object.assign(w.door, { status: 'pending', grant: GRANT, receipt: GRANT_RECEIPT, acceptedAt: '2026-11-25T01:02:03.456+00:00' });
  const before = await fs.readFile(w.index), n = (await uploadsOf(w)).length;
  const waiting = await w.sealDoor();
  assert.equal(waiting.status, 'FLEET_ACCEPTANCE_WAITING_OWNER');
  assert.equal(waiting.confirmUrl, w.door.confirmUrl);
  assert.equal(waiting.expiresAt, w.door.expiresAt);
  await sealedNothing(w, before, n);
  // what the door was asked: fleet.accept, exactly one resource binding version, tar and the request file's sha256, an op id
  assert.equal(w.door.asked.length, 1);
  const [asked] = w.door.asked;
  assert.deepEqual(Object.keys(asked).sort(), ['action', 'op_id', 'resources']);
  assert.equal(asked.action, 'fleet.accept');
  assert.deepEqual(asked.resources, [await resourceOf(w)]);
  assert.match(asked.op_id, UUID_RE);
  // the Owner approves on the page: the same call seals
  w.door.status = 'accepted';
  const r = await w.sealDoor();
  assert.equal(r.status, 'FLEET_ACCEPTANCE_SEALED');
  assert.equal(r.already, false);
  const request = JSON.parse(await fs.readFile(w.requestFile, 'utf8'));
  const bytes = await fs.readFile(path.join(w.out, `${TAG}.acceptance.json`));
  const a = JSON.parse(bytes.toString('utf8'));
  assert.deepEqual(a, acceptanceOf(request, { decision: GRANT, receipt: GRANT_RECEIPT, acceptedAt: '2026-11-25T01:02:03Z' }));
  assert.deepEqual([a.cluedDecision, a.fleetRefs.ownerDecisionRef, a.fleetRefs.installationReceiptRef, a.fleetRefs.ownerReceiptRef, a.acceptedAt],
    [GRANT, GRANT, GRANT_RECEIPT, GRANT_RECEIPT, '2026-11-25T01:02:03Z']);
  assert.equal((await w.assets()).find(x => x.name === `${TAG}.acceptance.json`).sha256, sha(bytes));
  assert.equal((await fs.readFile(w.index, 'utf8')).split('\r\n')[2], `| ${VERSION} | ${r.url} | ${w.source.archive_sha256} | ${COMMIT} | 2026-11-25T01:02:03Z | ${GRANT} | 首装未演练 |`);
  await assert.rejects(fs.access(path.join(w.out, `${TAG}.decision-record.json`)), 'no Decision record is written');
  // again: the door replays the same row, nothing uploaded, the same bytes
  const index = await fs.readFile(w.index), m = (await uploadsOf(w)).length;
  const again = await w.sealDoor();
  assert.equal(again.status, 'FLEET_ACCEPTANCE_SEALED');
  assert.equal(again.already, true);
  assert.ok((await fs.readFile(path.join(w.out, `${TAG}.acceptance.json`))).equals(bytes));
  assert.ok((await fs.readFile(w.index)).equals(index));
  assert.equal((await uploadsOf(w)).length, m);
});

test('seal through the door: rejected or expired answers REJECTED, writes nothing, and the command exits non-zero', async t => {
  for (const answer of ['rejected', 'expired']) {
    const w = await prepWorld(t);
    await w.prep();
    w.door.status = answer;
    const before = await fs.readFile(w.index), n = (await uploadsOf(w)).length;
    const r = await w.sealDoor();
    assert.equal(r.status, 'FLEET_ACCEPTANCE_REJECTED', answer);
    assert.equal(r.answer, answer);
    await sealedNothing(w, before, n);
    assert.equal(typeof publishModule.exitCodeOf, 'function', 'the command line sets its exit code from the answer');
    assert.notEqual(publishModule.exitCodeOf(r), 0, answer);
  }
  assert.equal(publishModule.exitCodeOf?.({ status: 'FLEET_ACCEPTANCE_SEALED' }), 0);
  assert.equal(publishModule.exitCodeOf?.({ status: 'FLEET_ACCEPTANCE_WAITING_OWNER' }), 0);
});

// the shape of D:/agent-temp/gen18-seal/decision-return.json (the hand-written Decision of generation 18: authority observed, the Owner's words
// copied from another session), its texts replaced by test text, naming this very request: before part B this sealed.
const gen18Record = async (w, name = 'gen18-decision-return.json') => {
  const r = structuredClone(FIX);
  Object.assign(r.supplemental.record, { authority: 'observed', title: 'TEST TEXT: the Owner accepts generation N',
    content: `TEST TEXT: the Owner said "accept" in another session.\n${requestLine(sha(await fs.readFile(w.requestFile)))}\n`,
    source_unavailable_reason: 'TEST TEXT: the words are in another session\'s transcript' });
  const file = path.join(w.d, name);
  await fs.writeFile(file, JSON.stringify(r));
  return file;
};

test('a Decision record has no way in: seal with --decision-record (the generation-18 shape) is USAGE, the Release and the index stay as they were', async t => {
  const w = await prepWorld(t);
  await w.prep();
  const record = await gen18Record(w);
  const before = await fs.readFile(w.index), n = (await uploadsOf(w)).length, calls = (await w.calls()).length;
  await assert.rejects(seal({ request: w.requestFile, decisionRecord: record, index: w.index, ghCommand: [process.execPath, w.fake], deps: w.deps }), { code: 'USAGE' });
  await sealedNothing(w, before, n);
  assert.equal((await w.calls()).length, calls, 'refused before gh');
  assert.deepEqual(w.door.asked, [], 'refused before the door');
  // the command line: the option is gone (a bad --repo shows the command would otherwise have gone on)
  await assert.rejects(main(['seal', '--request', w.requestFile, '--decision-record', record, '--repo', 'not a repo']), { code: 'USAGE' });
  await assert.rejects(main(['seal', '--request', w.requestFile, '--decision-record', record]), { code: 'USAGE' });
  await sealedNothing(w, before, n);
});

test('seal --wait: asks again at 30 to 120 second steps with the same op id until approved; the wait runs out as WAITING_OWNER; a bad --wait is USAGE', async t => {
  const w = await prepWorld(t);
  await w.prep();
  Object.assign(w.door, { status: 'pending', grant: GRANT, receipt: GRANT_RECEIPT, acceptedAt: '2026-11-25T01:02:03Z' });
  let clock = Date.parse('2026-11-25T01:00:00Z');
  const slept = [];
  const deps = { ...w.deps, clock: () => clock, sleep: async ms => { slept.push(ms); clock += ms; if (slept.length === 3) w.door.status = 'accepted'; } };
  const r = await w.sealDoor({ wait: 30, deps, now: clock });
  assert.equal(r.status, 'FLEET_ACCEPTANCE_SEALED');
  assert.equal(w.door.asked.length, 4);
  assert.equal(new Set(w.door.asked.map(x => x.op_id)).size, 1, 'one op id through the wait');
  assert.ok(slept.length === 3 && slept.every(ms => ms >= 30_000 && ms <= 120_000), JSON.stringify(slept));
  // never approved: the wait runs out (never past it), WAITING_OWNER, nothing written
  const w2 = await prepWorld(t);
  await w2.prep();
  w2.door.status = 'pending';
  const before = await fs.readFile(w2.index), n = (await uploadsOf(w2)).length;
  let c2 = Date.parse('2026-11-25T01:00:00Z');
  const start = c2, slept2 = [];
  const r2 = await w2.sealDoor({ wait: 5, deps: { ...w2.deps, clock: () => c2, sleep: async ms => { slept2.push(ms); c2 += ms; } }, now: c2 });
  assert.equal(r2.status, 'FLEET_ACCEPTANCE_WAITING_OWNER');
  assert.equal(r2.confirmUrl, w2.door.confirmUrl);
  assert.ok(c2 - start <= 5 * 60_000 && slept2.length >= 2, JSON.stringify(slept2));
  assert.ok(slept2.every(ms => ms > 0 && ms <= 120_000), JSON.stringify(slept2));
  await sealedNothing(w2, before, n);
  // the command line takes --wait <minutes>; anything else is USAGE (a bad --repo shows the option itself was taken)
  await assert.rejects(main(['seal', '--request', 'r', '--wait', '5', '--repo', 'not a repo']), { code: 'PUBLISH_REPO_REFUSED' });
  for (const bad of ['0', '-1', 'x', '1441', '']) await assert.rejects(main(['seal', '--request', 'r', '--wait', bad]), { code: 'USAGE' }, bad);
});

test('seal refuses a door answer that is not one of the four, an accepted one whose ids or time cannot stand, the drill\'s ids: nothing written', async t => {
  const w = await prepWorld(t);
  await w.prep();
  const before = await fs.readFile(w.index), n = (await uploadsOf(w)).length;
  const ok = { status: 'accepted', grant_id: GRANT, receipt_id: GRANT_RECEIPT, accepted_at: '2026-11-25T01:02:03Z' };
  const cases = [
    [{ ...ok, status: 'ok' }, 'ACCEPT_DOOR_ANSWER_REFUSED'],
    [null, 'ACCEPT_DOOR_ANSWER_REFUSED'],
    [{ ...ok, grant_id: 'nope' }, 'ACCEPT_DOOR_ANSWER_REFUSED'],
    [{ ...ok, receipt_id: undefined }, 'ACCEPT_DOOR_ANSWER_REFUSED'],
    [{ ...ok, receipt_id: GRANT }, 'ACCEPT_DOOR_ANSWER_REFUSED'],
    [{ ...ok, accepted_at: 'yesterday' }, 'ACCEPT_DOOR_ANSWER_REFUSED'],
    [{ ...ok, accepted_at: '2999-01-01T00:00:00Z' }, 'ACCEPT_DOOR_ANSWER_REFUSED'],
    [{ status: 'pending', confirmUrl: 'http://kooyumi.pixelgrav.com/confirm/0b0b0b0b-1111-4111-8111-000000000001', expiresAt: '2099-01-01T00:00:00Z' }, 'ACCEPT_DOOR_ANSWER_REFUSED'],
    [{ status: 'pending', expiresAt: '2099-01-01T00:00:00Z' }, 'ACCEPT_DOOR_ANSWER_REFUSED'],
    [{ ...ok, grant_id: DRILL_RESERVED.decision }, 'ACCEPTANCE_IS_THE_DRILLS_STAND_IN'],
    [{ ...ok, receipt_id: DRILL_RESERVED.receipt }, 'ACCEPTANCE_IS_THE_DRILLS_STAND_IN'],
  ];
  for (const [i, [answer, code]] of cases.entries()) {
    w.door.answer = () => answer;
    await assert.rejects(w.sealDoor(), { code }, `case ${i}`);
  }
  await sealedNothing(w, before, n);
  // what seal refuses on its own is refused before the Owner is asked: a request that is not the Release's, a drill receipt that is not a PASS,
  // a commit not on main
  w.door.answer = null;
  w.door.asked.length = 0;
  const request = JSON.parse(await fs.readFile(w.requestFile, 'utf8'));
  const requestBytes = await fs.readFile(w.requestFile);
  await fs.writeFile(w.requestFile, JSON.stringify({ ...request, ciSourceManifestSha256: 'c'.repeat(64) }));
  await assert.rejects(w.sealDoor(), { code: 'ACCEPTANCE_SOURCE_NOT_THE_RELEASES' });
  await fs.writeFile(w.requestFile, requestBytes);
  const receipt = path.join(w.d, 'fail-receipt.json');
  await fs.writeFile(receipt, JSON.stringify({ contract: 'clued.independent-ci.drill-receipt/1', version: VERSION, candidate: true, conclusion: 'FAIL' }));
  await assert.rejects(w.sealDoor({ drillReceipt: receipt }), { code: 'SEAL_DRILL_RECEIPT_NOT_PASS' });
  await w.setState(st => { st.compare = 'ahead'; });
  await assert.rejects(w.sealDoor(), { code: 'SEAL_COMMIT_NOT_ON_MAIN' });
  assert.deepEqual(w.door.asked, [], 'the door was never asked');
  await sealedNothing(w, before, n);
});

// the door client (accept-door.mjs, its own small file: not the frozen upgrader's grant-client.mjs): one POST to the Clued database's PostgREST
// endpoint with the publishable key and the SHA-256 of the publisher's Binding token, which is never sent, logged or kept
test('accept-door: the input goes as one POST with the token\'s hash only; door not deployed, refused, garbled are told apart; no configuration, no call', async () => {
  const door = await import('../accept-door.mjs');
  assert.equal(door.ACCEPT_ACTION, 'fleet.accept');
  assert.equal(door.acceptResourceOf({ repository: REPO, version: VERSION, archiveSha256: '1'.repeat(64), requestSha256: '2'.repeat(64) }),
    `fleet-node:${REPO}/${VERSION}/${'1'.repeat(64)}/${'2'.repeat(64)}`);
  const token = 'fake-binding-token-0123456789abcdef';
  const seen = [];
  let reply = { status: 200, body: { status: 'pending', confirmUrl: 'https://kooyumi.pixelgrav.com/confirm/0b0b0b0b-1111-4111-8111-000000000001', expiresAt: '2099-01-01T00:00:00Z' } };
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    if (reply.throws) throw new Error('ECONNRESET');
    return { status: reply.status, text: async () => (typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)) };
  };
  const ask = door.httpDoor({ supabaseUrl: 'https://db.example.test/', publishableKey: 'sb_publishable_test', token, fetchImpl });
  const input = { action: 'fleet.accept', resources: [`fleet-node:${REPO}/${VERSION}/${'1'.repeat(64)}/${'2'.repeat(64)}`], op_id: '0c0c0c0c-1111-4111-8111-000000000003' };
  assert.deepEqual(await ask(input), reply.body);
  const [call] = seen;
  assert.equal(call.url, `https://db.example.test/rest/v1/rpc/${door.ACCEPT_DOOR_RPC}`);
  assert.equal(call.init.method, 'POST');
  assert.deepEqual(JSON.parse(call.init.body), { p_token_hash: sha(Buffer.from(token)), p_input: input });
  assert.ok(!JSON.stringify(call.init).includes(token), 'the token itself never leaves');
  for (const [r, code] of [[{ status: 404, body: { code: 'PGRST202' } }, 'ACCEPT_DOOR_UNAVAILABLE'], [{ status: 503, body: '' }, 'ACCEPT_DOOR_UNAVAILABLE'],
    [{ throws: true }, 'ACCEPT_DOOR_UNAVAILABLE'], [{ status: 200, body: 'not json' }, 'ACCEPT_DOOR_UNAVAILABLE'],
    [{ status: 403, body: { code: '42501', message: 'owner_grant_door_binding_not_authorized' } }, 'ACCEPT_DOOR_REFUSED'],
    [{ status: 400, body: { message: 'fleet_accept_request_hash_changed' } }, 'ACCEPT_DOOR_REFUSED']]) {
    reply = r;
    await assert.rejects(ask(input), e => e.code === code && !JSON.stringify(e.detail ?? null).includes(token), JSON.stringify(r));
  }
  // configuration from the environment only (CLUED_SUPABASE_URL, CLUED_SUPABASE_PUBLISHABLE_KEY, CLUED_FLEET_ACCEPT_TOKEN); missing: refused, no call
  const n = seen.length;
  for (const env of [{}, { CLUED_SUPABASE_URL: 'https://db.example.test', CLUED_SUPABASE_PUBLISHABLE_KEY: 'k' }, { CLUED_FLEET_ACCEPT_TOKEN: token }]) {
    assert.throws(() => door.doorFromEnv(env, fetchImpl), { code: 'ACCEPT_DOOR_NOT_CONFIGURED' });
  }
  assert.equal(seen.length, n);
  assert.equal(typeof door.doorFromEnv({ CLUED_SUPABASE_URL: 'https://db.example.test', CLUED_SUPABASE_PUBLISHABLE_KEY: 'k', CLUED_FLEET_ACCEPT_TOKEN: token }, fetchImpl), 'function');
});

test('seal on the command line with no door configured is refused before the request is read or gh is called', async t => {
  const saved = Object.fromEntries(['CLUED_SUPABASE_URL', 'CLUED_SUPABASE_PUBLISHABLE_KEY', 'CLUED_FLEET_ACCEPT_TOKEN'].map(k => [k, process.env[k]]));
  for (const k of Object.keys(saved)) delete process.env[k];
  t.after(() => { for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v; });
  await assert.rejects(main(['seal', '--request', path.join(os.tmpdir(), 'no-such-dir-87d330d0', `${TAG}.acceptance-request.json`)]), { code: 'ACCEPT_DOOR_NOT_CONFIGURED' });
});
