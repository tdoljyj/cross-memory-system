// Shared offline Release, archive and acceptance-door fixtures for publish and resident-node tests.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { prepare, readBuild, seal, stageNodeEntry } from '../publish.mjs';
import { writeTar } from '../tar.mjs';
import { FAKE_GH } from './fleet-fixtures.mjs';

const IMAGE = 'c'.repeat(64);
const uploadsOf = async w => (await w.calls()).filter(c => c.args[1] === 'upload');
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
  // the fake acceptance door (PLAN-accept-binding-20261125 section 3, the contract with part A): the anonymous read of one resource
  // (public.clued_fleet_accept_status_v1) as the door would answer it now, every answer echoing the request's sha256; `status` is flipped
  // by a test (none, pending, accepted, rejected, expired). A `gh workflow run` (the release workflow's fleet-accept mode) the door has not
  // seen yet opens a request: none or expired become `openTo` (pending) on the next read; rejected stays rejected (part A: final, never
  // opened again; PLAN-accept-align-open-20261125 1.2). accepted replays the same row on every read.
  const requestId = '0b0b0b0b-1111-4111-8111-000000000001';
  const door = { status: 'accepted', grant: FIX_DECISION, receipt: FIX_RECEIPT, acceptedAt: '2026-11-19T12:22:39.628169+00:00', reads: [],
    confirmUrl: `https://kooyumi.pixelgrav.com/confirm/${requestId}`, expiresAt: '2099-01-01T00:00:00Z', answer: null, openTo: 'pending', opensSeen: 0, fail: 0,
    nodes: [{ name: 'TURING', source_sha256: 'b'.repeat(64), paused: false }] };
  const opensNow = () => { try { return JSON.parse(readFileSync(path.join(w.d, 'gh-state.json'), 'utf8')).calls.filter(c => c.args[0] === 'workflow').length; } catch { return 0; } };
  const answerOf = resource => {
    const base = { action: 'fleet.accept', resources: [resource], request_sha256: resource.split('/').pop() };
    if (door.answer) return door.answer(resource, base);
    const opens = opensNow();
    if (opens > door.opensSeen) { door.opensSeen = opens; if (['none', 'expired'].includes(door.status)) door.status = door.openTo; }
    if (door.status === 'pending') return { ...base, status: 'pending', request_id: requestId, confirm_path: `/confirm/${requestId}`, expires_at: door.expiresAt };
    if (door.status === 'accepted') return { ...base, status: 'accepted', grant_id: door.grant, receipt_id: door.receipt, accepted_at: door.acceptedAt, nodes: door.nodes };
    return { ...base, status: door.status };
  };
  const readStatus = async resource => {
    door.reads.push(resource);
    if (door.fail > 0) { door.fail--; throw Object.assign(new Error('ACCEPT_DOOR_UNAVAILABLE'), { code: 'ACCEPT_DOOR_UNAVAILABLE', detail: { http: 503, message: null } }); }
    return answerOf(resource);
  };
  const deps = { kitOf, readKit: () => ({}), fleetMaterial: async () => ({ formalRoles, installed: { ...carried, ciSourceManifestSha256: templateSource } }),
    sourceHash: async args => { s.sourceDrafts.push(args); return { ciSourceManifestSha256: s.sourceOf }; }, readStatus };
  const opens = async () => (await w.calls()).filter(c => c.args[0] === 'workflow');
  const gh = [process.execPath, w.fake];
  const prep = (over = {}) => prepare({ version: VERSION, dir: w.out, out, images: [image], index: w.index, ghCommand: gh, deps, ...over });
  const requestFile = path.join(out, `${TAG}.acceptance-request.json`);
  const kitAssets = async () => (await w.assets()).filter(a => a.name === `${TAG}.first-install-kit.json`);
  const setState = async edit => { const f = path.join(w.d, 'gh-state.json'); const st = JSON.parse(await fs.readFile(f, 'utf8')); edit(st); await fs.writeFile(f, JSON.stringify(st)); };
  // seal through the door: no Decision record, no Decision, receipt or time anywhere
  const sealDoor = async (over = {}) => seal({ request: requestFile, index: w.index, ghCommand: gh, deps, ...over });
  const sealIt = sealDoor;
  return { ...w, image, out, s, deps, prep, requestFile, sealIt, sealDoor, door, opens, kitAssets, carried, formalRoles, setState };
};
const GRANT = 'a5a5a5a5-1111-4111-8111-0000000000a1', GRANT_RECEIPT = 'b6b6b6b6-2222-4222-8222-0000000000b2';
const REQUEST_ASSET = `${TAG}.acceptance-request.json`;
const resourceOf = async w => `fleet-node:${REPO}/${VERSION}/${w.source.archive_sha256}/${sha(await fs.readFile(w.requestFile))}`;
const sealedNothing = async (w, indexBefore, uploadsBefore) => {
  assert.ok((await fs.readFile(w.index)).equals(indexBefore), 'the index is as it was');
  assert.equal((await uploadsOf(w)).length, uploadsBefore, 'nothing uploaded');
  assert.ok(!(await w.assets()).some(a => a.name.endsWith('.acceptance.json')), 'no acceptance on the Release');
  await assert.rejects(fs.access(path.join(w.out, `${TAG}.acceptance.json`)), 'no acceptance next to the request');
};
// a clock and a sleep for seal (deps.clock, deps.sleep): sleeping moves the clock; `onSleep` runs after each sleep
const fakeTime = (start, onSleep = () => {}) => {
  const t = { now: Date.parse(start), slept: [] };
  t.clock = () => t.now;
  t.sleep = async ms => { t.slept.push(ms); t.now += ms; onSleep(t); };
  return t;
};
const timed = (w, time, over = {}) => w.sealDoor({ deps: { ...w.deps, clock: time.clock, sleep: time.sleep }, now: time.now, ...over });

export { sha, VERSION, TAG, COMMIT, FLEET, BOOTSTRAP, PREREQ, world, REPO, RELEASE_ASSETS, rowOf,
  seedRelease, FIX, FIX_DECISION, FIX_RECEIPT, FIX_ACCEPTED_AT, requestLine, prepWorld, GRANT, GRANT_RECEIPT, REQUEST_ASSET,
  resourceOf, sealedNothing, fakeTime, timed, uploadsOf };
