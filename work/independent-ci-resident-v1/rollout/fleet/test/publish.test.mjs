// publish.mjs with a fake gh (never the real one, never the network): the release is created from the checked build output, with
// the commit as target and no token in gh's environment; the index gets one line only after gh succeeded; a version already in the
// index, a build whose archive is not its release.json, and a failing gh are refused without touching the index.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { attachAcceptance, main, publish } from '../publish.mjs';

const sha = b => createHash('sha256').update(b).digest('hex');
const VERSION = '2026.11.12-1', TAG = `fleet-node-${VERSION}`, COMMIT = 'a1'.repeat(20);

// Records its argv and whether a token variable reached it; "release view" answers from what "release create" uploaded.
const FAKE_GH = `import fs from 'node:fs';
const state = process.env.FAKE_GH_STATE;
const log = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, 'utf8')) : { calls: [], assets: [] };
const args = process.argv.slice(2);
log.calls.push({ args, tokenSeen: ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'].filter(k => process.env[k] !== undefined) });
if (process.env.FAKE_GH_FAIL === '1') { fs.writeFileSync(state, JSON.stringify(log)); console.error('HTTP 422: fake failure'); process.exit(1); }
if (args[0] === 'release' && args[1] === 'create') {
  const files = args.slice(3, args.indexOf('--repo'));
  log.assets = files.map(f => ({ name: f.split(/[\\\\/]/).pop(), size: fs.statSync(f).size }));
  console.log('https://github.com/' + args[args.indexOf('--repo') + 1] + '/releases/tag/' + args[2]);
}
if (args[0] === 'release' && args[1] === 'upload') log.assets.push({ name: args[3].split(/[\\\\/]/).pop(), size: fs.statSync(args[3]).size });
if (args[0] === 'release' && args[1] === 'view') console.log(JSON.stringify({ url: 'https://github.com/' + args[args.indexOf('--repo') + 1] + '/releases/tag/' + args[2], tagName: args[2], assets: log.assets }));
fs.writeFileSync(state, JSON.stringify(log));
`;

async function world(t) {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'fleetpub'));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  const out = path.join(d, 'out');
  await fs.mkdir(out);
  const tar = Buffer.from('not really a tar, only its bytes matter here\n');
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
  return { d, out, tar, source, index, run, calls };
}

test('publish: gh release create <tag> <assets> --target <commit>, without any token variable; then one index line', async t => {
  const w = await world(t);
  const r = await w.run();
  assert.equal(r.status, 'FLEET_RELEASE_PUBLISHED');
  assert.equal(r.url, `https://github.com/tdoljyj/cross-memory-system/releases/tag/${TAG}`);
  const [create, view] = await w.calls();
  assert.deepEqual(create.args.slice(0, 3), ['release', 'create', TAG]);
  assert.deepEqual(create.args.slice(3, 6).map(f => path.basename(f)), [`${TAG}.tar`, `${TAG}.release.json`, 'SHA256SUMS']);
  assert.equal(create.args[create.args.indexOf('--repo') + 1], 'tdoljyj/cross-memory-system');
  assert.equal(create.args[create.args.indexOf('--target') + 1], COMMIT);
  assert.deepEqual(create.tokenSeen, [], 'gh uses only its own login');
  assert.deepEqual(view.args.slice(0, 3), ['release', 'view', TAG]);
  assert.ok(!JSON.stringify(await w.calls()).includes('fake-token-value'), 'no token in any argument');
  const lines = (await fs.readFile(w.index, 'utf8')).split('\r\n');
  assert.equal(lines[2], `| ${VERSION} | ${r.url} | ${w.source.archive_sha256} | ${COMMIT} |  |  |`);
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

test('publish creates an absent index with the six-column header, and completes an older five-column one', async t => {
  const w = await world(t);
  const fresh = path.join(w.d, 'sub', 'new-index.md');
  await w.run({ index: fresh });
  const lines = (await fs.readFile(fresh, 'utf8')).split('\n');
  assert.equal(lines[0], '| 版本 | Release | tar sha256 | commit | 接受时间 | Decision |');
  assert.equal(lines[1], '|---|---|---|---|---|---|');
  assert.ok(lines[2].startsWith(`| ${VERSION} | https://`) && lines[2].endsWith(`| ${COMMIT} |  |  |`));
  const old = path.join(w.d, 'old-index.md');
  await fs.writeFile(old, '| 版本 | Release | tar sha256 | commit | 接受时间 |\n|---|---|---|---|---|\n| 0.1 | u | h | c |  |\n');
  await w.run({ index: old });
  const o = (await fs.readFile(old, 'utf8')).split('\n');
  assert.deepEqual(o.slice(0, 3), ['| 版本 | Release | tar sha256 | commit | 接受时间 | Decision |', '|---|---|---|---|---|---|', '| 0.1 | u | h | c |  |  |']);
  assert.ok(o[3].startsWith(`| ${VERSION} |`));
});

const DECISION = 'b5d041d2';
const accept = async (w, over = {}, name = `${TAG}.acceptance.json`) => {
  const file = path.join(w.d, name);
  const decision = `${DECISION}-1111-4111-8111-111111111111`, receipt = 'e1e1e1e1-2222-4222-8222-222222222222';
  const fleetRefs = { sourceAcceptanceRef: decision, hostQualificationRef: decision, ownerAuthorizationRef: decision, publisherQualificationRef: decision,
    ownerPackageAcceptanceRef: decision, installationReceiptRef: receipt, ownerDecisionRef: decision, ownerReceiptRef: receipt,
    formalRoles: { gitleaks: {}, trivy: {}, 'contract-placement': {} } };
  await fs.writeFile(file, JSON.stringify({ contract: 'clued.independent-ci.fleet-node-acceptance/1', version: VERSION, archive_sha256: w.source.archive_sha256,
    commit: COMMIT, repository: 'tdoljyj/cross-memory-system', ciSourceManifestSha256: '7'.repeat(64), cluedDecision: DECISION, acceptedAt: '2026-11-12T08:00:00Z',
    fleetRefs, ...over }));
  return file;
};

test('attach-acceptance: uploads the file as an extra asset (no --clobber), fills accepted-at and Decision, refuses a second one', async t => {
  const w = await world(t);
  const file = await accept(w);
  const run = (over = {}) => attachAcceptance({ version: VERSION, acceptance: file, index: w.index, ghCommand: [process.execPath, path.join(w.d, 'fake-gh.mjs')], ...over });
  const saved = { ...process.env };
  process.env.FAKE_GH_STATE = path.join(w.d, 'gh-state.json');
  process.env.GH_TOKEN = 'fake-token-value-for-the-test';
  t.after(() => { for (const k of ['FAKE_GH_STATE', 'GH_TOKEN']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  await w.run();
  const before = (await w.calls()).length;
  const r = await run();
  assert.equal(r.status, 'FLEET_ACCEPTANCE_ATTACHED');
  const calls = await w.calls();
  assert.equal(calls.length, before + 2);
  const [up, view] = calls.slice(before);
  assert.deepEqual(up.args.slice(0, 3), ['release', 'upload', TAG]);
  assert.equal(path.basename(up.args[3]), `${TAG}.acceptance.json`);
  assert.ok(!up.args.includes('--clobber'));
  assert.deepEqual(up.tokenSeen, []);
  assert.deepEqual(view.args.slice(0, 3), ['release', 'view', TAG]);
  const lines = (await fs.readFile(w.index, 'utf8')).split('\r\n');
  assert.equal(lines[2], `| ${VERSION} | ${r.url} | ${w.source.archive_sha256} | ${COMMIT} | 2026-11-12T08:00:00Z | ${DECISION} |`);
  await assert.rejects(run(), { code: 'PUBLISH_ACCEPTANCE_ALREADY_ATTACHED' });
  assert.equal((await w.calls()).length, before + 2, 'refused before gh');
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
  ];
  for (const [over, code] of cases) await assert.rejects(attachAcceptance({ ...base, acceptance: await accept(w, over) }), { code });
  await assert.rejects(attachAcceptance({ ...base, acceptance: await accept(w, {}, 'other.json') }), { code: 'ACCEPTANCE_FILE_NAME_REFUSED' });
  await assert.rejects(attachAcceptance({ ...base, version: '9.9', acceptance: await accept(w, { version: '9.9' }, 'fleet-node-9.9.acceptance.json') }), { code: 'PUBLISH_INDEX_LACKS_VERSION' });
  await assert.rejects(attachAcceptance({ ...base, acceptance: await accept(w), repo: 'bad repo' }), { code: 'PUBLISH_REPO_REFUSED' });
  assert.ok((await fs.readFile(w.index)).equals(before));
  assert.equal((await w.calls()).length, n);
});

test('main: only the two subcommands, with their own options', async () => {
  await assert.rejects(main([]), { code: 'USAGE' });
  await assert.rejects(main(['--dir', 'x', '--repo', 'a/b', '--index', 'i']), { code: 'USAGE' });
  await assert.rejects(main(['release', '--dir', 'x']), { code: 'USAGE' });
  await assert.rejects(main(['release', '--dir', 'x', '--repo', 'a/b', '--version', '1']), { code: 'USAGE' });
  await assert.rejects(main(['attach-acceptance', '--version', '1']), { code: 'USAGE' });
});
