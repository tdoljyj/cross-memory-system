// Executed heads independent of the Source, and the first start's backfill (resident quota redesign v0.6 + §9,
// phase 1, items 1, 6, 7). The required case: a fresh state plus an archived old ledger. A head that already published
// checks must never be admitted again (2026-10-22: after the r2 reinstall #896 head 21d6d7e3 was admitted again, stage 3
// returned ROLE_ALREADY_PUBLISHED_ON_HEAD and the executor HALTed, Note 1550fef8).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { batchKey, headKey } from '../src/ledger.mjs';
import { ExecutedHeads, BACKFILL_MANIFEST_CONTRACT, CARRIED_FILE, executedHeadKey, mayHavePublished } from '../src/executed-heads.mjs';
import { sha256 } from '../src/canonical.mjs';
import { BASE, HEAD, SOURCE, WINDOWS_CLEAN, executorFixture, fakeEngine, notAdmitted, rawPolicy, triggerBytes } from './helpers.mjs';
import { BACKFILL_PENDING_MAX_MS } from '../src/executor.mjs';

const OLD_SOURCE = 'c'.repeat(64);
const subject = (o = {}) => ({ repo: 'tdoljyj/cross-memory-system', pr: 884, headSha: HEAD, baseSha: BASE, sourceManifestSha256: SOURCE, attempt: 1, ...o });
const stagesRun = engine => engine.calls.filter(c => c[0] === 'stage').map(c => c[1]);
const derived = engine => engine.calls.filter(c => c[0] === 'derive').length;

// Runs one batch per scripted head under OLD_SOURCE in its own state, then carries that state's ledger into a fresh
// install's state\backfill\<name>\ with install\backfill-manifest.json, exactly as install-resident.ps1 does.
async function oldInstall(t, heads) {
  const engine = fakeEngine();
  const base = engine.runStage;
  engine.runStage = async (batch, stage, o) => {
    const h = heads.find(x => batch.key === batchKey(subject({ sourceManifestSha256: OLD_SOURCE, pr: x.pr, headSha: x.headSha })));
    if (h?.fail && stage.number === h.fail.stage) { engine.calls.push(['stage', stage.number]); return h.fail.result; }
    return base(batch, stage, o);
  };
  const old = await executorFixture(t, { engine, policy: rawPolicy({ sourceManifestSha256: OLD_SOURCE }), integrity: { ok: true, sourceManifestSha256: OLD_SOURCE, residentManifestSha256: 'b'.repeat(64) } });
  for (const h of heads) { await old.drop(triggerBytes({ pr: h.pr, headSha: h.headSha })); h.result = await old.exec.tick(); }
  return old;
}
// The old state's own executed-heads records are carried only when asked: an install from before phase 1 has none, and
// the required case must be found from the ledger alone.
async function carry(oldRoot, newRoot, name = 'resident-uninstalled-20261022T061000Z-aa11bb', { executedHeads = false } = {}) {
  const files = [], heads = [];
  const walk = async rel => {
    for (const n of (await fs.readdir(path.join(oldRoot, 'state', ...rel.split('/').filter(Boolean)))).sort()) {
      const r = rel ? `${rel}/${n}` : n;
      const abs = path.join(oldRoot, 'state', ...r.split('/'));
      if ((await fs.stat(abs)).isDirectory()) {
        if (/^executed-heads\/[0-9a-f]{32}$/.test(r)) heads.push(n);
        if (/^(ledger-heads|ledger|ledger\/[0-9a-f]{64}|executed-heads|executed-heads\/[0-9a-f]{32})$/.test(r)) await walk(r);
        continue;
      }
      if (!CARRIED_FILE.test(r)) continue;
      const bytes = await fs.readFile(abs);
      const to = path.join(newRoot, 'state', 'backfill', '1', ...r.split('/'));
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.writeFile(to, bytes);
      files.push({ path: r, sha256: sha256(bytes), bytes: bytes.length });
    }
  };
  for (const top of ['ledger-heads', 'ledger', ...(executedHeads ? ['executed-heads'] : [])]) {
    try { await fs.access(path.join(oldRoot, 'state', top)); } catch { continue; }
    await walk(top);
  }
  return { contract: BACKFILL_MANIFEST_CONTRACT, sources: [{ name, dir: '1', files, ...(executedHeads ? { heads } : {}) }] };
}

test('fresh state + archived old ledger: a head that published checks is never admitted again, under any Source, PR or base', async t => {
  const published = { pr: 884, headSha: HEAD };                                               // COMPLETED: every check published
  const stage1 = { pr: 885, headSha: '3'.repeat(40), fail: { stage: 1, result: { ok: false, code: 'STAGE_CHILD_REFUSED', proof: WINDOWS_CLEAN } } }; // stale base, burned at stage 1
  const halted = { pr: 886, headSha: '5'.repeat(40), fail: { stage: 3, result: { ok: false, code: 'ROLE_ALREADY_PUBLISHED_ON_HEAD', proof: WINDOWS_CLEAN } } };
  const old = await oldInstall(t, [published, stage1, halted]);
  assert.deepEqual([published.result.state, stage1.result.state, halted.result.state], ['COMPLETED', 'FAILED_CLEAN', 'HALTED']);
  const manifest = await carry(old.root, await (async () => { const d = path.join(old.root, '..', path.basename(old.root) + '-new'); await fs.mkdir(d); t.after(() => fs.rm(d, { recursive: true, force: true })); return d; })());
  const newRoot = path.join(old.root, '..', path.basename(old.root) + '-new');
  const engine = fakeEngine();
  const f = await executorFixture(t, { engine, root: newRoot, backfillManifest: manifest });
  assert.equal(await f.executedHeads.backfilled(), false);
  // the very first tick backfills, then refuses the published head before reserving anything
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.reason], ['IGNORED', 'HEAD_ALREADY_PUBLISHED_NO_RETRY']);
  assert.equal(derived(engine), 0, 'nothing was derived, reserved or run');
  assert.equal((await f.ledger.keys()).length, 0);
  assert.equal(await f.executedHeads.backfilled(), true);
  // also under another PR number and base: the head is what was published
  await f.drop(triggerBytes({ pr: 999, baseSha: '7'.repeat(40) }));
  assert.equal((await f.exec.tick()).reason, 'HEAD_ALREADY_PUBLISHED_NO_RETRY');
  // the head whose stage 3 found its role already published (the 2026-10-22 HALT): never again either
  await f.drop(triggerBytes({ pr: 886, headSha: '5'.repeat(40) }));
  assert.equal((await f.exec.tick()).reason, 'HEAD_ALREADY_PUBLISHED_NO_RETRY');
  // the head that never got past stage 1 under the old Source runs under the new one (as before phase 1)
  await f.drop(triggerBytes({ pr: 885, headSha: '3'.repeat(40) }));
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  const types = (await fs.readdir(path.join(newRoot, 'state', 'receipts'))).map(n => n.replace(/^\d{8}-|\.json$/g, ''));
  assert.equal(types[0], 'executed-heads-backfilled', 'the backfill is the first thing the new install records');
});

test('no batch runs before the backfill: a missing manifest or a changed carried file HALTs; an I/O error only defers', async t => {
  const none = await executorFixture(t, { backfillManifest: false });
  await none.drop(triggerBytes());
  const r = await none.exec.tick();
  assert.deepEqual([r.state, r.failureCode], ['HALTED', 'EXECUTED_HEADS_BACKFILL_MANIFEST_MISSING']);
  assert.equal(derived(none.engine), 0);
  assert.equal(await none.executedHeads.backfilled(), false);

  const published = { pr: 884, headSha: HEAD };
  const old = await oldInstall(t, [published]);
  const newRoot = path.join(old.root, '..', path.basename(old.root) + '-changed');
  await fs.mkdir(newRoot); t.after(() => fs.rm(newRoot, { recursive: true, force: true }));
  const manifest = await carry(old.root, newRoot);
  const victim = manifest.sources[0].files.find(x => x.path.startsWith('ledger-heads/'));
  await fs.writeFile(path.join(newRoot, 'state', 'backfill', manifest.sources[0].dir, ...victim.path.split('/')), '{"edited":true}');
  const changed = await executorFixture(t, { root: newRoot, backfillManifest: manifest });
  await changed.drop(triggerBytes());
  assert.deepEqual([(await changed.exec.tick()).failureCode, derived(changed.engine)], ['EXECUTED_HEADS_BACKFILL_SOURCE_CHANGED', 0]);

  const flaky = await executorFixture(t);
  const real = flaky.executedHeads.backfill.bind(flaky.executedHeads);
  let fail = true;
  flaky.executedHeads.backfill = async () => { if (fail) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); return real(); };
  await flaky.drop(triggerBytes());
  assert.equal((await flaky.exec.tick()).state, 'BACKFILL_PENDING');
  assert.equal(derived(flaky.engine), 0);
  assert.equal(await flaky.ledger.halted(), null, 'a transient error is no HALT');
  fail = false;
  assert.equal((await flaky.exec.tick()).state, 'COMPLETED');
  // an I/O error that lasts: deferred for BACKFILL_PENDING_MAX_MS since its first failure, then a HALT (never a batch)
  const stuck = await executorFixture(t);
  stuck.executedHeads.backfill = async () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); };
  await stuck.drop(triggerBytes());
  for (let i = 0; i < 20; i += 1) { assert.equal((await stuck.exec.tick()).state, 'BACKFILL_PENDING', `tick ${i}`); stuck.advance(BACKFILL_PENDING_MAX_MS / 25); }
  stuck.advance(BACKFILL_PENDING_MAX_MS);
  assert.deepEqual([(await stuck.exec.tick()).failureCode, derived(stuck.engine)], ['EXECUTED_HEADS_BACKFILL_UNAVAILABLE', 0]);
  assert.equal((await stuck.ledger.halted()).value.code, 'EXECUTED_HEADS_BACKFILL_UNAVAILABLE');
});

test('the executor records a head before its first publication stage; a later Source never runs it again', async t => {
  const f = await executorFixture(t);
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  const dir = path.join(f.root, 'state', 'executed-heads', executedHeadKey(subject()));
  const records = await fs.readdir(dir);
  assert.deepEqual(records, [`publication-${batchKey(subject()).slice(0, 16)}.json`]);
  const rec = JSON.parse(await fs.readFile(path.join(dir, records[0]), 'utf8'));
  assert.deepEqual([rec.stage, rec.basis, rec.sourceManifestSha256], [3, 'before-stage-3', SOURCE]);
  // the same state under a new Source (in place): the ledger's head key is new, the executed head is not
  const g = await executorFixture(t, { root: f.root, policy: rawPolicy({ sourceManifestSha256: 'd'.repeat(64) }), integrity: { ok: true, sourceManifestSha256: 'd'.repeat(64), residentManifestSha256: 'b'.repeat(64) } });
  await g.drop(triggerBytes({ pr: 990 }));
  assert.equal((await g.exec.tick()).reason, 'HEAD_ALREADY_PUBLISHED_NO_RETRY');
  assert.equal(derived(g.engine), 0);
});

test('a failure before any publication stage records nothing, so attempt 2 still runs; a refused record stops before stage 3', async t => {
  let n = 0;
  const engine = fakeEngine();
  const base = engine.runStage;
  engine.runStage = async (batch, stage, o) => (stage.number === 2 && ++n === 1 ? (engine.calls.push(['stage', 2]), { ok: false, code: 'REMOTE_REFS_CHANGED_SINCE_BUNDLE', proof: WINDOWS_CLEAN }) : base(batch, stage, o));
  const f = await executorFixture(t, { engine });
  await f.drop(triggerBytes());
  assert.ok((await f.exec.tick()).attempt2);
  assert.equal(await f.executedHeads.published(subject()), false);
  f.advance(600_000);
  assert.equal((await f.exec.tick()).state, 'COMPLETED', 'attempt 2 is not blocked by the executed heads');
  assert.equal(await f.executedHeads.published(subject()), true);

  const g = await executorFixture(t);
  g.executedHeads.record = async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
  await g.drop(triggerBytes());
  const r = await g.exec.tick();
  assert.deepEqual([r.state, r.failureCode], ['FAILED_CLEAN', 'EXECUTED_HEAD_RECORD_UNCONFIRMED']);
  assert.deepEqual(stagesRun(g.engine), [1, 2], 'stage 3 never ran');
});

test('may-have-published: anything not proven to have ended before the first publication stage counts', () => {
  const head = (o = {}) => ({ headKey: 'a'.repeat(64), key: 'b'.repeat(64), subject: subject(), ...o });
  const clean = (facts, plan = null) => ({ plan, terminal: { outcome: 'FAILED_CLEAN', facts } });
  assert.equal(mayHavePublished(head({ burnedBy: { quarantine: true } }), clean({ stage: 1 })).published, true);
  assert.equal(mayHavePublished(head(), null).published, true);
  assert.equal(mayHavePublished(head(), { terminal: null }).published, true);
  for (const outcome of ['COMPLETED', 'FAILED_UNKNOWN', 'SOMETHING']) assert.equal(mayHavePublished(head(), { terminal: { outcome, facts: {} } }).published, true, outcome);
  for (const stage of [0, 1, 2]) assert.equal(mayHavePublished(head(), clean({ stage })).published, false, stage);
  for (const stage of [3, 4, 5, 6, 7, 8, 9]) assert.equal(mayHavePublished(head(), clean({ stage })).published, true, stage);
  assert.equal(mayHavePublished(head(), clean({ stage: 2 }, { relayed: [{ role: 'gitleaks' }] })).published, true, 'a relayed role is published');
  assert.equal(mayHavePublished(head(), clean({ failureCode: 'OWNER_ABORTED', safePoint: 'in-stage-2' })).published, false);
  assert.equal(mayHavePublished(head(), clean({ failureCode: 'OWNER_ABORTED', safePoint: 'in-stage-4' })).published, true);
  assert.equal(mayHavePublished(head(), clean({ failureCode: 'OWNER_ABORTED', safePoint: 'before-stage-8' })).published, true);
});

test('a carried executed-heads key is kept whatever its record: empty, torn, or no record at all (independent re-review, MINOR-A)', async t => {
  const old = await oldInstall(t, []);
  const emptyHead = subject({ headSha: '7'.repeat(40) }), tornHead = subject({ headSha: '8'.repeat(40) }), bareHead = subject({ headSha: '9'.repeat(40) });
  const at = s => path.join(old.root, 'state', 'executed-heads', executedHeadKey(s));
  for (const [s, bytes] of [[emptyHead, ''], [tornHead, '{"repo":']]) { await fs.mkdir(at(s), { recursive: true }); await fs.writeFile(path.join(at(s), `backfill-${'a'.repeat(16)}.json`), bytes); }
  await fs.mkdir(at(bareHead), { recursive: true });
  const newRoot = path.join(old.root, '..', path.basename(old.root) + '-keys');
  await fs.mkdir(newRoot); t.after(() => fs.rm(newRoot, { recursive: true, force: true }));
  const manifest = await carry(old.root, newRoot, undefined, { executedHeads: true });
  assert.deepEqual(manifest.sources[0].heads.length, 3);
  const f = await executorFixture(t, { root: newRoot, backfillManifest: manifest });
  await f.exec.tick();
  for (const s of [emptyHead, tornHead, bareHead]) assert.equal(await f.executedHeads.published(s), true, s.headSha);
  const marker = await f.executedHeads.readMarker();
  assert.deepEqual([marker.published, marker.unreadable, marker.sources[1].keys], [3, 2, 3]);
  // keys are fixed-shape and unique, or the manifest is refused
  for (const bad of [['x'], ['a'.repeat(32), 'a'.repeat(32)], 'a'.repeat(32)]) {
    const m = structuredClone(manifest); m.sources[0].heads = bad;
    const badRoot = path.join(newRoot, '..', path.basename(newRoot) + `-bad${String(bad).length}`);
    t.after(() => fs.rm(badRoot, { recursive: true, force: true }));
    const g = await executorFixture(t, { root: badRoot, backfillManifest: m });
    assert.equal((await g.exec.tick()).failureCode, 'EXECUTED_HEADS_BACKFILL_MANIFEST_REFUSED', JSON.stringify(bad));
  }
});

test('backfill counts and skips a carried record that does not parse; the store refuses a bad subject', async t => {
  const old = await oldInstall(t, [{ pr: 884, headSha: HEAD }]);
  const newRoot = path.join(old.root, '..', path.basename(old.root) + '-torn');
  await fs.mkdir(newRoot); t.after(() => fs.rm(newRoot, { recursive: true, force: true }));
  // a torn ledger-heads record in the old state (its listed hash is of the torn bytes): unreadable, counted
  await fs.writeFile(path.join(old.root, 'state', 'ledger-heads', `${'9'.repeat(64)}.json`), '{"headKey":');
  // and an empty one (a write interrupted before its bytes; independent review of phase 1, MINOR 4): carried, counted
  await fs.writeFile(path.join(old.root, 'state', 'ledger-heads', `${'8'.repeat(64)}.json`), '');
  const manifest = await carry(old.root, newRoot);
  assert.equal(manifest.sources[0].files.find(x => x.path.includes('8'.repeat(64))).bytes, 0);
  const f = await executorFixture(t, { root: newRoot, backfillManifest: manifest });
  await f.exec.tick();
  const marker = await f.executedHeads.readMarker();
  assert.deepEqual([marker.published, marker.unreadable, marker.sources.map(s => s.name)], [1, 2, ['current', manifest.sources[0].name]]);
  // an empty listed file that is no longer empty is a changed carried state: HALT
  const grown = path.join(old.root, '..', path.basename(old.root) + '-grown');
  await fs.mkdir(grown); t.after(() => fs.rm(grown, { recursive: true, force: true }));
  const m2 = await carry(old.root, grown);
  await fs.writeFile(path.join(grown, 'state', 'backfill', '1', 'ledger-heads', `${'8'.repeat(64)}.json`), '{}');
  const g = await executorFixture(t, { root: grown, backfillManifest: m2 });
  assert.equal((await g.exec.tick()).failureCode, 'EXECUTED_HEADS_BACKFILL_SOURCE_CHANGED');
  assert.equal(await f.executedHeads.published(subject()), true);
  await assert.rejects(f.executedHeads.record({ repo: 'x', headSha: 'nope' }, { key: 'a'.repeat(64), origin: 'publication', basis: 'b' }), { code: 'EXECUTED_HEAD_SUBJECT_INVALID' });
  await assert.rejects(f.executedHeads.record(subject(), { key: 'a'.repeat(64), origin: 'other', basis: 'b' }), { code: 'EXECUTED_HEAD_RECORD_INVALID' });
  assert.equal(new ExecutedHeads(f.root, () => 0).manifestFile, null);
  assert.equal(headKey(subject()) !== executedHeadKey(subject()), true);
});

// Defect 39e8ba4f: a start whose backfill was already done (every restart after the install's first) left status.backfill at
// complete:false, so every PR page said "执行器启动中：回填已执行记录" for good. It reports complete:true with the marker's counts, or
// null for a count the marker does not give.
test('defect 39e8ba4f: a start after the backfill reports it complete, with the counts from BACKFILL-COMPLETE.json or null', async t => {
  const { StatusBoard } = await import('../src/status.mjs');
  const { BACKFILL_MARKER } = await import('../src/executed-heads.mjs');
  const first = await executorFixture(t);
  await first.exec.tick();
  assert.equal(await first.executedHeads.backfilled(), true);
  const markerFile = path.join(first.root, 'state', 'executed-heads', BACKFILL_MARKER);
  const marker = JSON.parse(await fs.readFile(markerFile, 'utf8'));
  await fs.writeFile(markerFile, JSON.stringify({ ...marker, published: 7, unreadable: 2 }));
  const status = new StatusBoard({ clock: () => Date.parse('2026-10-20T12:00:00Z') });
  const again = await executorFixture(t, { root: first.root, status });
  assert.deepEqual(status.content.backfill, { complete: false, published: null, unreadable: null }, 'a fresh board starts at false');
  await again.exec.tick();
  assert.deepEqual(status.content.backfill, { complete: true, published: 7, unreadable: 2 });
  assert.equal((await again.receipts.latest(['executed-heads-backfilled'], 5)).length, 1, 'no second backfill and no second receipt');
  // a marker whose counts cannot be read: complete, the counts null
  await fs.writeFile(markerFile, '{"torn":');
  const torn = new StatusBoard({ clock: () => Date.parse('2026-10-20T12:00:00Z') });
  const third = await executorFixture(t, { root: first.root, status: torn });
  await third.exec.tick();
  assert.deepEqual(torn.content.backfill, { complete: true, published: null, unreadable: null });
  await fs.writeFile(markerFile, JSON.stringify({ ...marker, published: -1, unreadable: 'x' }));
  const odd = new StatusBoard({ clock: () => Date.parse('2026-10-20T12:00:00Z') });
  const fourth = await executorFixture(t, { root: first.root, status: odd });
  await fourth.exec.tick();
  assert.deepEqual(odd.content.backfill, { complete: true, published: null, unreadable: null });
});
