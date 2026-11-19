// publish.mjs with a fake gh (never the real one, never the network): the release is created from the checked build output, with
// the commit as target and no token in gh's environment; the index gets one line only after gh succeeded; a version already in the
// index, a build whose archive is not its release.json, and a failing gh are refused without touching the index.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DRILL_RESERVED, acceptanceOf, attachAcceptance, attachFirstInstallKit, main, prepare, publish, seal } from '../publish.mjs';
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
  const env = { FAKE_GH_STATE: state, GH_TOKEN: 'fake-token-value-for-the-test', FAKE_GH_FAIL: undefined };
  const run = async (over = {}, extraEnv = {}) => {
    const saved = Object.fromEntries(Object.keys({ ...env, ...extraEnv }).map(k => [k, process.env[k]]));
    for (const [k, v] of Object.entries({ ...env, ...extraEnv })) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { return await publish({ dir: out, repo: 'tdoljyj/cross-memory-system', index, ghCommand: [process.execPath, fake], ...over }); }
    finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  };
  const calls = async () => { try { return JSON.parse(await fs.readFile(state, 'utf8')).calls; } catch { return []; } };
  const assets = async () => { try { return JSON.parse(await fs.readFile(state, 'utf8')).assets; } catch { return []; } };
  return { d, out, tar, source, index, run, calls, assets, fake };
}

test('publish: gh release create <tag> <assets> --target <commit>, without any token variable; then one index line', async t => {
  const w = await world(t);
  const r = await w.run();
  assert.equal(r.status, 'FLEET_RELEASE_PUBLISHED');
  assert.equal(r.url, `https://github.com/tdoljyj/cross-memory-system/releases/tag/${TAG}`);
  const [create, view] = await w.calls();
  assert.deepEqual(create.args.slice(0, 3), ['release', 'create', TAG]);
  assert.deepEqual(create.args.slice(3, 8).map(f => path.basename(f)), [`${TAG}.tar`, `${TAG}.release.json`, 'SHA256SUMS', `${TAG}.bootstrap.ps1`, `${TAG}.prereq-manifest.json`]);
  // the two node-entry assets are the archive's bytes; the published SHA256SUMS lists the four others (the build's two lines kept)
  const up = Object.fromEntries((await w.assets()).map(a => [a.name, a]));
  assert.equal(up[`${TAG}.bootstrap.ps1`].sha256, sha(BOOTSTRAP));
  assert.equal(up[`${TAG}.prereq-manifest.json`].sha256, sha(PREREQ));
  const sums = up.SHA256SUMS.text.split('\n').filter(Boolean);
  assert.deepEqual(sums.map(l => l.split('  ')[1]), [`${TAG}.bootstrap.ps1`, `${TAG}.prereq-manifest.json`, `${TAG}.release.json`, `${TAG}.tar`], 'sorted by name');
  for (const l of sums) { const [h, n] = l.split('  '); assert.equal(h, up[n].sha256, n); }
  assert.equal(up[`${TAG}.tar`].sha256, sha(w.tar));
  assert.equal((await fs.readFile(path.join(w.out, 'SHA256SUMS'), 'utf8')).split('\n').filter(Boolean).length, 2, 'the build output is not changed');
  assert.equal(create.args[create.args.indexOf('--repo') + 1], 'tdoljyj/cross-memory-system');
  assert.equal(create.args[create.args.indexOf('--target') + 1], COMMIT);
  assert.deepEqual(create.tokenSeen, [], 'gh uses only its own login');
  assert.deepEqual(view.args.slice(0, 3), ['release', 'view', TAG]);
  assert.ok(!JSON.stringify(await w.calls()).includes('fake-token-value'), 'no token in any argument');
  const lines = (await fs.readFile(w.index, 'utf8')).split('\r\n');
  assert.equal(lines[2], `| ${VERSION} | ${r.url} | ${w.source.archive_sha256} | ${COMMIT} |  |  |  |`);
  assert.equal(lines.length, 4, 'one line, with the index\'s own line ending');
  // the same version again: refused before gh is called
  await assert.rejects(w.run(), { code: 'PUBLISH_INDEX_ALREADY_HAS_VERSION' });
  assert.equal((await w.calls()).length, 2);
});

test('publish refuses a build whose archive is not its release.json, and leaves the index alone when gh fails', async t => {
  const w = await world(t);
  const before = await fs.readFile(w.index);
  await fs.appendFile(path.join(w.out, `${TAG}.tar`), 'x');
  await assert.rejects(w.run(), { code: 'PUBLISH_ARCHIVE_SHA_MISMATCH' });
  await fs.writeFile(path.join(w.out, `${TAG}.tar`), w.tar);
  await assert.rejects(w.run({}, { FAKE_GH_FAIL: '1' }), { code: 'PUBLISH_GH_RELEASE_CREATE_FAILED' });
  assert.ok((await fs.readFile(w.index)).equals(before));
  await fs.writeFile(path.join(w.out, 'SHA256SUMS'), `${'0'.repeat(64)}  ${TAG}.tar\n`);
  await assert.rejects(w.run(), { code: 'PUBLISH_SHA256SUMS_MISMATCH' });
  await assert.rejects(w.run({ repo: 'not a repo' }), { code: 'PUBLISH_REPO_REFUSED' });
});

test('publish creates an absent index with the seven-column header, and completes an older five- or six-column one', async t => {
  const w = await world(t);
  const fresh = path.join(w.d, 'sub', 'new-index.md');
  await w.run({ index: fresh });
  const lines = (await fs.readFile(fresh, 'utf8')).split('\n');
  assert.equal(lines[0], '| 版本 | Release | tar sha256 | commit | 接受时间 | Decision | 首装演练 |');
  assert.equal(lines[1], '|---|---|---|---|---|---|---|');
  assert.ok(lines[2].startsWith(`| ${VERSION} | https://`) && lines[2].endsWith(`| ${COMMIT} |  |  |  |`));
  const old = path.join(w.d, 'old-index.md');
  await fs.writeFile(old, '| 版本 | Release | tar sha256 | commit | 接受时间 |\n|---|---|---|---|---|\n| 0.1 | u | h | c |  |\n');
  await w.run({ index: old });
  const o = (await fs.readFile(old, 'utf8')).split('\n');
  assert.deepEqual(o.slice(0, 3), ['| 版本 | Release | tar sha256 | commit | 接受时间 | Decision | 首装演练 |', '|---|---|---|---|---|---|---|', '| 0.1 | u | h | c |  |  |  |']);
  assert.ok(o[3].startsWith(`| ${VERSION} |`));
  // the six-column table of today (accepted rows keep their cells; the drill cell of an older row stays empty)
  const six = path.join(w.d, 'six-index.md');
  await fs.writeFile(six, '| 版本 | Release | tar sha256 | commit | 接受时间 | Decision |\n|---|---|---|---|---|---|\n| 0.2 | u | h | c | 2026-11-19T12:22:39Z | c556370f |\n');
  await w.run({ index: six });
  assert.deepEqual((await fs.readFile(six, 'utf8')).split('\n').slice(0, 3), ['| 版本 | Release | tar sha256 | commit | 接受时间 | Decision | 首装演练 |', '|---|---|---|---|---|---|---|',
    '| 0.2 | u | h | c | 2026-11-19T12:22:39Z | c556370f |  |']);
});

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
  await w.run();
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

test('publish refuses an archive without the node entry (bootstrap.ps1, prereq-manifest.json) before gh is called', async t => {
  const w = await world(t);
  const tar = writeTar([{ path: `${FLEET}bootstrap.ps1`, data: BOOTSTRAP }, { path: 'universal-manifest.json', data: Buffer.from('{}') }]);
  const rel = JSON.parse(await fs.readFile(path.join(w.out, `${TAG}.release.json`), 'utf8'));
  rel.source.archive_sha256 = sha(tar); rel.archive = { name: `${TAG}.tar`, bytes: tar.length, sha256: sha(tar) };
  const rb = Buffer.from(JSON.stringify(rel, null, 1) + '\n');
  await fs.writeFile(path.join(w.out, `${TAG}.tar`), tar);
  await fs.writeFile(path.join(w.out, `${TAG}.release.json`), rb);
  await fs.writeFile(path.join(w.out, 'SHA256SUMS'), `${sha(rb)}  ${TAG}.release.json\n${sha(tar)}  ${TAG}.tar\n`);
  await assert.rejects(w.run(), { code: 'PUBLISH_ARCHIVE_LACKS_NODE_ENTRY' });
  assert.equal((await w.calls()).length, 0);
});

const IMAGE = 'c'.repeat(64);
async function kitWorld(t) {
  const w = await world(t);
  await w.run();
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

test('main: only release, prepare and seal, with their own options; the steps and the old entry have no command', async () => {
  for (const gone of [['attach-acceptance', '--version', '1', '--acceptance', 'a'], ['attach-first-install-kit', '--version', '1', '--kit', 'k'],
    ['acceptance-draft', '--version', '1', '--dir', 'x', '--base', 'b', '--out', 'o']]) await assert.rejects(main(gone), { code: 'USAGE' }, gone[0]);
  await assert.rejects(main(['prepare', '--version', '1', '--dir', 'x']), { code: 'USAGE' });
  await assert.rejects(main(['prepare', '--version', '1', '--dir', 'x', '--out', 'o', '--base', 'b']), { code: 'USAGE' }, 'no Decision or fleetRefs file goes into prepare');
  await assert.rejects(main(['seal', '--request', 'r', '--decision', 'd', '--receipt', 'x']), { code: 'USAGE' });
  await assert.rejects(main(['seal', '--request', 'r', '--decision', 'd', '--receipt', 'x', '--accepted-at', 't', '--dir', 'x']), { code: 'USAGE' }, 'seal reads no build and no node');
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


// ---------------------------------------------------------------- the acceptance in two halves (Fable 3bc571a6 ruling section 3, Task 758989fa)
// prepare and seal with the node-side parts stood in for (the real ones are the first-install test): the node's kit, its record material, the archive's Source.
// kitOf gives new bytes on every read, as a real node does (template.versionFacts carries observedAt); kitReads counts them.
const prepWorld = async (t, { templateSource = 'a'.repeat(64), packageSource = 'b'.repeat(64) } = {}) => {
  const w = await world(t);
  await w.run();
  const image = path.join(w.d, `role-image-${IMAGE}.tar.gz`);
  await fs.writeFile(image, Buffer.from('gzip of a docker save'));
  const carried = { sourceAcceptanceRef: '5c06efc1-6597-49bb-9883-57a7e7d6c344', hostQualificationRef: 'e46ab3f7-539f-4bc3-8f60-5ceec1eef8b9',
    ownerAuthorizationRef: '5c06efc1-6597-49bb-9883-57a7e7d6c344', publisherQualificationRef: '5c06efc1-6597-49bb-9883-57a7e7d6c344', ownerPackageAcceptanceRef: '5c06efc1-6597-49bb-9883-57a7e7d6c344' };
  const formalRoles = { gitleaks: {}, trivy: {}, 'contract-placement': {} };
  const saved = process.env.FAKE_GH_STATE;
  process.env.FAKE_GH_STATE = path.join(w.d, 'gh-state.json');
  t.after(() => { if (saved === undefined) delete process.env.FAKE_GH_STATE; else process.env.FAKE_GH_STATE = saved; });
  const out = path.join(w.d, 'accept');
  const s = { kitReads: 0, kitBroken: false, sourceDrafts: [] };
  const kitOf = async () => {
    if (s.kitBroken) throw Object.assign(new Error('the node was asked for a kit'), { code: 'TEST_NODE_ASKED_FOR_A_KIT' });
    const observedAt = new Date(Date.UTC(2026, 10, 19, 12, 0, s.kitReads++)).toISOString();
    return { contract: 'clued.independent-ci.fleet-node-first-install-kit/1', template: { versionFacts: Buffer.from(JSON.stringify({ observedAt })).toString('base64') },
      config: { ciSourceManifestSha256: templateSource }, images: { pull: [], local: [{ id: IMAGE, asset: `role-image-${IMAGE}.tar.gz` }] } };
  };
  const deps = { kitOf, readKit: () => ({}), fleetMaterial: async () => ({ formalRoles, installed: { ...carried, ciSourceManifestSha256: templateSource } }),
    sourceHash: async ({ acceptance }) => { s.sourceDrafts.push(acceptance); return { ciSourceManifestSha256: packageSource }; } };
  const gh = [process.execPath, w.fake];
  const prep = (over = {}) => prepare({ version: VERSION, dir: w.out, out, images: [image], index: w.index, ghCommand: gh, deps, ...over });
  const requestFile = path.join(out, `${TAG}.acceptance-request.json`);
  const decision = 'c556370f-b0fc-404b-b164-0f06699e4c7a', receipt = '0b5e1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
  const sealIt = (over = {}) => seal({ request: requestFile, decision, receipt, acceptedAt: '2026-11-19T12:22:39Z', index: w.index, ghCommand: gh, ...over });
  const kitAssets = async () => (await w.assets()).filter(a => a.name === `${TAG}.first-install-kit.json`);
  return { ...w, image, out, s, deps, prep, requestFile, decision, receipt, sealIt, kitAssets, carried, formalRoles };
};
const noRequest = async w => { await assert.rejects(fs.access(w.requestFile)); };
const uploadsOf = async w => (await w.calls()).filter(c => c.args[1] === 'upload');

// ruling test 1 (red before: acceptance-draft refused ACCEPTANCE_REFUSED "cluedDecision")
test('prepare: no Decision, receipt or time goes in; the request the Owner reviews comes out, with the kit on the Release and the node\'s carried references', async t => {
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
  // the Source is the package's, computed with the drill's stand-in Decision and receipt (they do not enter it)
  assert.equal(w.s.sourceDrafts.length, 1);
  assert.equal(w.s.sourceDrafts[0].cluedDecision, DRILL_RESERVED.decision);
  assert.ok(!('ciSourceManifestSha256' in w.s.sourceDrafts[0]));
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
  const stateFile = path.join(w.d, 'gh-state.json');
  const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  const img = { name: `role-image-${IMAGE}.tar.gz`, size: body.length, b64: body.toString('base64') };
  const sums = (hash) => { const x = `${hash}  role-image-${IMAGE}.tar.gz\n`; return { name: `${prevTag}.first-install.SHA256SUMS`, size: x.length, b64: Buffer.from(x).toString('base64') }; };
  state.other = { [prevTag]: [img, sums('9'.repeat(64))] };
  await fs.writeFile(stateFile, JSON.stringify(state));
  await assert.rejects(w.prep({ images: [] }), { code: 'PREPARE_PREVIOUS_IMAGE_NOT_ITS_SUMS' });
  await noRequest(w);
  state.other[prevTag] = [img, sums(sha(body))];
  await fs.writeFile(stateFile, JSON.stringify(state));
  const r = await w.prep({ images: [] });
  assert.equal(r.status, 'FLEET_ACCEPTANCE_REQUEST_WRITTEN');
  assert.deepEqual(r.images, [IMAGE]);
});

test('prepare refuses a version whose index row already has its acceptance: the kit is never added afterwards, nothing uploaded', async t => {
  const w = await prepWorld(t);
  const text = await fs.readFile(w.index, 'utf8');
  assert.ok(text.includes('|  |  |  |'));
  await fs.writeFile(w.index, text.split('|  |  |  |').join(`| 2026-11-12T08:00:00Z | ${DECISION} |  |`));
  const before = await fs.readFile(w.index), n = (await w.calls()).length;
  await assert.rejects(w.prep(), { code: 'PUBLISH_ACCEPTANCE_ALREADY_ATTACHED' });
  await noRequest(w);
  await unchanged(w, before, n);
});

// ruling test 3: seal never touches a node or a kit; the acceptance is the request's fields and the five the acceptance makes; the index row is written
test('seal: the request and the Decision, receipt and time; no node asked, only the acceptance uploaded; on the Release, next to the request, in the index; again changes nothing', async t => {
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
  assert.deepEqual(a, acceptanceOf(request, { decision: w.decision, receipt: w.receipt, acceptedAt: '2026-11-19T12:22:39Z' }));
  assert.deepEqual([a.cluedDecision, a.fleetRefs.ownerDecisionRef, a.fleetRefs.installationReceiptRef, a.fleetRefs.ownerReceiptRef], [w.decision, w.decision, w.receipt, w.receipt]);
  assert.equal((await w.assets()).find(x => x.name === `${TAG}.acceptance.json`).sha256, sha(await fs.readFile(r.acceptance)));
  assert.equal((await fs.readFile(w.index, 'utf8')).split('\r\n')[2], `| ${VERSION} | ${r.url} | ${w.source.archive_sha256} | ${COMMIT} | 2026-11-19T12:22:39Z | ${w.decision} | 首装未演练 |`);
  // again: nothing uploaded, nothing changed
  const index = await fs.readFile(w.index), m = (await w.calls()).length;
  const again = await w.sealIt();
  assert.equal(again.already, true);
  assert.ok((await fs.readFile(w.index)).equals(index));
  assert.deepEqual((await w.calls()).slice(m).filter(c => c.args[1] === 'upload'), []);
  // a run that stopped after the upload, before the index row: the same command completes the row, uploads nothing
  await fs.writeFile(w.index, index.toString('utf8').replace(`| 2026-11-19T12:22:39Z | ${w.decision} | 首装未演练 |`, '|  |  |  |'));
  await fs.rm(r.acceptance);
  const k0 = (await uploadsOf(w)).length;
  const done = await w.sealIt();
  assert.equal(done.already, false);
  assert.ok((await fs.readFile(w.index)).equals(index));
  assert.equal((await uploadsOf(w)).length, k0);
  // another Decision for an accepted version: refused before anything is uploaded or written
  const before = await fs.readFile(w.index), k = (await w.calls()).length;
  const other = { decision: 'a1b2c3d4-0000-4000-8000-000000000009' };
  await assert.rejects(w.sealIt(other), { code: 'SEAL_ANOTHER_ACCEPTANCE_IN_DIRECTORY' });
  await fs.rename(r.acceptance, `${r.acceptance}.kept`);
  await assert.rejects(w.sealIt(other), { code: 'PUBLISH_ACCEPTANCE_ALREADY_ATTACHED' });
  await unchanged(w, before, k);
  assert.equal((await w.calls()).length, k, 'refused before gh');
  await assert.rejects(fs.access(r.acceptance));
});

// ruling test 4: the drill's stand-in values are refused (seal, and the step under it whatever reaches it)
test('seal refuses the drill\'s stand-in Decision or receipt: no upload, no index row, no acceptance file; the drill\'s own file is refused by the step too', async t => {
  const w = await prepWorld(t);
  await w.prep();
  const before = await fs.readFile(w.index), n = (await w.calls()).length;
  for (const over of [{ decision: DRILL_RESERVED.decision }, { receipt: DRILL_RESERVED.receipt }, { decision: DRILL_RESERVED.decision, receipt: DRILL_RESERVED.receipt, acceptedAt: DRILL_RESERVED.acceptedAt }]) {
    await assert.rejects(w.sealIt(over), { code: 'ACCEPTANCE_IS_THE_DRILLS_STAND_IN' }, JSON.stringify(over));
  }
  await unchanged(w, before, n);
  await assert.rejects(fs.access(path.join(w.out, `${TAG}.acceptance.json`)));
  // the drill's acceptance as the drill makes it (acceptanceOf with DRILL_RESERVED): never attached either
  const drillFile = path.join(w.d, 'drill', `${TAG}.acceptance.json`);
  await fs.mkdir(path.dirname(drillFile));
  await fs.writeFile(drillFile, JSON.stringify(acceptanceOf(JSON.parse(await fs.readFile(w.requestFile, 'utf8')), DRILL_RESERVED)));
  await assert.rejects(attachAcceptance({ version: VERSION, acceptance: drillFile, index: w.index, ghCommand: [process.execPath, w.fake] }), { code: 'ACCEPTANCE_IS_THE_DRILLS_STAND_IN' });
  await unchanged(w, before, n);
});

// ruling test 5: the request's hashes against the Release as it is now
test('seal refuses a request whose tar, commit or kit is not the Release\'s, and a request or ids of another shape: nothing uploaded, nothing written', async t => {
  const w = await prepWorld(t);
  await w.prep();
  const request = JSON.parse(await fs.readFile(w.requestFile, 'utf8'));
  const before = await fs.readFile(w.index), n = (await uploadsOf(w)).length;
  const cases = [
    [{ firstInstallKitSha256: 'f'.repeat(64) }, 'ACCEPTANCE_KIT_NOT_THE_ATTACHED'],
    [{ archive_sha256: 'f'.repeat(64) }, 'ACCEPTANCE_NOT_THIS_RELEASE'],
    [{ commit: 'b2'.repeat(20) }, 'ACCEPTANCE_NOT_THIS_RELEASE'],
    [{ cluedDecision: w.decision }, 'REQUEST_REFUSED'],
    [{ fleetRefs: { ...request.fleetRefs, ownerDecisionRef: w.decision } }, 'REQUEST_REFUSED'],
    [{ ciSourceManifestSha256: 'x' }, 'REQUEST_REFUSED'],
    [{ repository: 'other/repo' }, 'ACCEPTANCE_NOT_THIS_REPOSITORY'],
  ];
  for (const [over, code] of cases) {
    await fs.writeFile(w.requestFile, JSON.stringify({ ...request, ...over }));
    await assert.rejects(w.sealIt(), { code }, code);
  }
  await fs.writeFile(w.requestFile, JSON.stringify(request));
  // the Release's SHA256SUMS names another tar
  const stateFile = path.join(w.d, 'gh-state.json');
  const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  const sums = state.assets.find(a => a.name === 'SHA256SUMS'), kept = sums.b64;
  sums.b64 = Buffer.from(Buffer.from(kept, 'base64').toString('utf8').replace(w.source.archive_sha256, '9'.repeat(64))).toString('base64');
  await fs.writeFile(stateFile, JSON.stringify(state));
  await assert.rejects(w.sealIt(), { code: 'ACCEPTANCE_ARCHIVE_NOT_THE_RELEASES' });
  const fixed = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  fixed.assets.find(a => a.name === 'SHA256SUMS').b64 = kept;
  await fs.writeFile(stateFile, JSON.stringify(fixed));
  const wrongName = path.join(w.out, 'request.json');
  await fs.writeFile(wrongName, JSON.stringify(request));
  for (const [over, code] of [[{ decision: 'b5d041d2' }, 'SEAL_IDS_REFUSED'], [{ receipt: w.decision }, 'SEAL_IDS_REFUSED'], [{ acceptedAt: '2999-01-01T00:00:00Z' }, 'ACCEPTANCE_REFUSED'],
    [{ acceptedAt: '2026-11-19 12:22' }, 'ACCEPTANCE_REFUSED'], [{ request: wrongName }, 'REQUEST_FILE_NAME_REFUSED']]) {
    await assert.rejects(w.sealIt(over), { code }, JSON.stringify(over));
  }
  assert.ok((await fs.readFile(w.index)).equals(before));
  assert.equal((await uploadsOf(w)).length, n, 'nothing uploaded');
  await assert.rejects(fs.access(path.join(w.out, `${TAG}.acceptance.json`)));
  // the request as prepare wrote it still seals
  assert.equal((await w.sealIt()).status, 'FLEET_ACCEPTANCE_SEALED');
});

test('seal --drill-receipt: a PASS receipt of these three hashes is named in the index row; FAIL, another package or another contract is refused first', async t => {
  const w = await prepWorld(t);
  await w.prep();
  const request = JSON.parse(await fs.readFile(w.requestFile, 'utf8'));
  const receiptFile = path.join(w.d, 'receipt.json');
  const pass = { contract: 'clued.independent-ci.drill-receipt/1', version: VERSION, candidate: true, conclusion: 'PASS_A_FULL', tarSha256: request.archive_sha256,
    ciSourceManifestSha256: request.ciSourceManifestSha256, firstInstallKitSha256: request.firstInstallKitSha256, kitSha256: 'd'.repeat(64) };
  const before = await fs.readFile(w.index), n = (await w.calls()).length;
  for (const [over, code] of [[{ conclusion: 'FAIL' }, 'SEAL_DRILL_RECEIPT_NOT_PASS'], [{ conclusion: 'PENDING_PRODUCTION_READBACK' }, 'SEAL_DRILL_RECEIPT_NOT_PASS'],
    [{ firstInstallKitSha256: 'f'.repeat(64) }, 'SEAL_DRILL_RECEIPT_NOT_THIS_PACKAGE'], [{ tarSha256: 'f'.repeat(64) }, 'SEAL_DRILL_RECEIPT_NOT_THIS_PACKAGE'],
    [{ ciSourceManifestSha256: 'f'.repeat(64) }, 'SEAL_DRILL_RECEIPT_NOT_THIS_PACKAGE'], [{ firstInstallKitSha256: undefined }, 'SEAL_DRILL_RECEIPT_NOT_THIS_PACKAGE'],
    [{ version: '2026.11.12-2' }, 'SEAL_DRILL_RECEIPT_REFUSED'], [{ contract: 'x' }, 'SEAL_DRILL_RECEIPT_REFUSED']]) {
    await fs.writeFile(receiptFile, JSON.stringify({ ...pass, ...over }));
    await assert.rejects(w.sealIt({ drillReceipt: receiptFile }), { code }, JSON.stringify(over));
  }
  await unchanged(w, before, n);
  assert.equal((await w.calls()).length, n, 'refused before gh');
  const bytes = Buffer.from(JSON.stringify(pass));
  await fs.writeFile(receiptFile, bytes);
  const r = await w.sealIt({ drillReceipt: receiptFile });
  assert.equal(r.drill, `PASS_A_FULL receipt ${sha(bytes)}`);
  assert.ok((await fs.readFile(w.index, 'utf8')).split('\r\n')[2].endsWith(`| ${w.decision} | PASS_A_FULL receipt ${sha(bytes)} |`));
});
