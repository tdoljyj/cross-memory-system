// Stage 10's retention of clued-control's state (step 3c-2b, DESIGN §41.7, safety as §35.3; resident-v2/state-retention.mjs):
// the stage outcomes stay flat while their month is open and move, under their own names, into receipts\<yyyy-mm>\ once it
// is past (sealed by index\<yyyy-mm>.json); train-shadow waits for the Owner's review, then 90 days; sweep records 90 days;
// closed ledger months a year; the newest of each kind stays; links refuse, second hard links stay; one pass a day.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { INDEX_DIRECTORY, PASS_CONTRACT, PASS_DIRECTORY, SEGMENTS_CONTRACT, TRAIN_REVIEW_CONTRACT, closeOutcomeMonths, pruneArea, readTrainReview,
  stateRetention, LANDING_BATCH_KEEP, LANDING_STATE_KEEP } from '../src/resident-v2/state-retention.mjs';
import { writeOutcome } from '../src/resident-v2/stage-inputs.mjs';
import { tempDir } from './resident-v2-fixtures.mjs';

const DAY = 86_400_000;
const RUN = `${'a'.repeat(16)}-${'b'.repeat(12)}`;
const stamp = ms => String(ms).padStart(13, '0');
const shadowName = ms => `${stamp(ms)}-${RUN}.json`;
const sweepName = (kind, ms, n = 0) => `${kind}-${stamp(ms)}-${RUN}-${String(n).padStart(8, '0')}.json`;
const ls = async dir => (await fs.readdir(dir)).sort();
const put = async (file, ms, text = 'x') => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); await fs.utimes(file, ms / 1000, ms / 1000); };
const roots = base => ({ receipts: path.join(base, 'receipts'), trainShadow: path.join(base, 'train-shadow'), trainSweep: path.join(base, 'train-sweep'), greenLedger: path.join(base, 'green-ledger') });
const nonce = c => c.repeat(32);

test('outcome segments: the open month stays flat; a past month moves whole under the same names, then is sealed', async t => {
  const base = await tempDir(t), receipts = path.join(base, 'receipts');
  const SEP = Date.parse('2026-09-10T00:00:00Z'), OCT = Date.parse('2026-10-15T00:00:00Z'), LATE_OCT = Date.parse('2026-10-31T20:00:00Z');
  // an installed node's flat outcomes, written by the unchanged writer; the helper's receipts and other files around them
  const written = await writeOutcome({ receiptsRoot: receipts, nonce: nonce('a'), plan: { stage: 10, entryRole: 'train-maintenance' }, jobIds: [], result: { status: 'BLOCKED', sideEffects: 0 }, clock: () => OCT });
  await fs.utimes(path.join(receipts, `outcome-${nonce('a')}.json`), OCT / 1000, OCT / 1000);
  const bytes = await fs.readFile(path.join(receipts, `outcome-${nonce('a')}.json`));
  await put(path.join(receipts, `outcome-${nonce('b')}.json`), SEP);
  await put(path.join(receipts, `outcome-${nonce('c')}.json`), LATE_OCT);
  await put(path.join(receipts, `windows-formal-entry-${nonce('a')}.json`), OCT);
  await put(path.join(receipts, 'observations.jsonl'), SEP);
  const NOV1 = Date.parse('2026-11-01T06:00:00Z');
  await put(path.join(receipts, `outcome-${nonce('d')}.json`), NOV1 - 3_600_000);
  // the first pass in November: September and mid-October move; the outcome of late Oct 31 is less than seven days old and waits
  const first = await closeOutcomeMonths({ receipts, now: NOV1 });
  assert.deepEqual([first.refused, first.moved, first.segments, first.deferred, first.sealed, first.stopped], [null, 2, { '2026-09': 1, '2026-10': 1 }, 1, false, null]);
  assert.deepEqual(await ls(path.join(receipts, '2026-10')), [`outcome-${nonce('a')}.json`]);
  assert.deepEqual(await fs.readFile(path.join(receipts, '2026-10', `outcome-${nonce('a')}.json`)), bytes, 'moved, never rewritten');
  assert.equal(JSON.parse(bytes).at, written.at);
  assert.deepEqual(await ls(path.join(receipts, '2026-09')), [`outcome-${nonce('b')}.json`]);
  assert.deepEqual((await ls(receipts)).filter(n => n.endsWith('.json') || n.endsWith('.jsonl')),
    ['observations.jsonl', `outcome-${nonce('c')}.json`, `outcome-${nonce('d')}.json`, `windows-formal-entry-${nonce('a')}.json`]);
  // six days later the rest of October still waits (seven days, review R2 minor 7); a week later it goes and the month is
  // sealed; November stays open
  assert.equal((await closeOutcomeMonths({ receipts, now: NOV1 + 6 * DAY })).moved, 0);
  const second = await closeOutcomeMonths({ receipts, now: NOV1 + 7 * DAY });
  assert.deepEqual([second.moved, second.deferred, second.sealed, second.closedThrough], [1, 0, true, '2026-10']);
  const seal = JSON.parse(await fs.readFile(path.join(receipts, INDEX_DIRECTORY, '2026-10.json'), 'utf8'));
  assert.deepEqual([seal.contract, seal.month, seal.segments, seal.keptFlat], [SEGMENTS_CONTRACT, '2026-10', ['2026-09', '2026-10'], 0]);
  assert.ok((await ls(receipts)).includes(`outcome-${nonce('d')}.json`), 'the open month stays flat');
  // sealed: later passes of the month read only the index
  await put(path.join(receipts, `outcome-${nonce('e')}.json`), SEP);
  const third = await closeOutcomeMonths({ receipts, now: NOV1 + 8 * DAY });
  assert.deepEqual([third.moved, third.closedThrough, third.sealed], [0, '2026-10', false]);
  // a new outcome is still written flat, where the helper and the invoker read it
  await writeOutcome({ receiptsRoot: receipts, nonce: nonce('f'), plan: null, jobIds: [], result: { status: 'BLOCKED', sideEffects: 0 }, clock: () => NOV1 + 2 * DAY });
  assert.ok((await ls(receipts)).includes(`outcome-${nonce('f')}.json`));
  await fs.utimes(path.join(receipts, `outcome-${nonce('f')}.json`), (NOV1 + 2 * DAY) / 1000, (NOV1 + 2 * DAY) / 1000);
  // a pass stopped between link and unlink finishes; a different file of the same name is never replaced
  const DEC = Date.parse('2026-12-03T00:00:00Z');
  await fs.mkdir(path.join(receipts, '2026-11'));
  await fs.copyFile(path.join(receipts, `outcome-${nonce('d')}.json`), path.join(receipts, '2026-11', `outcome-${nonce('d')}.json`));
  await put(path.join(receipts, '2026-11', `outcome-${nonce('f')}.json`), DEC, 'other');
  const fourth = await closeOutcomeMonths({ receipts, now: DEC });
  assert.deepEqual([fourth.moved, fourth.segments], [2, { '2026-11': 1, '2026-09': 1 }]);
  assert.deepEqual([fourth.stopped?.name, fourth.stopped?.code, fourth.sealed], [`outcome-${nonce('f')}.json`, 'RETENTION_OPERATION_UNCONFIRMED', false]);
  assert.ok((await ls(receipts)).includes(`outcome-${nonce('f')}.json`), 'the flat outcome stays');
  // a redirected receipts directory moves nothing
  const elsewhere = path.join(base, 'elsewhere'), link = path.join(base, 'linked');
  await fs.mkdir(elsewhere);
  await fs.symlink(elsewhere, link, 'junction');
  assert.equal((await closeOutcomeMonths({ receipts: link, now: DEC })).refused, 'RETENTION_AREA_REDIRECTED');
});

test('strict sweep retention: exact new kinds expire after 90 days while newest of each kind and foreign names stay', async t => {
  const r = roots(await tempDir(t)), now = Date.parse('2027-03-01T00:00:00Z');
  const old = [], kept = [];
  for (const kind of ['scan-on', 'scan-shadow', 'scan-strict', 'strict-proof', 'strict-round', 'strict-front-proof', 'pending-revocations']) {
    old.push(sweepName(kind, now - 300 * DAY));
    kept.push(sweepName(kind, now - 200 * DAY, 1));
  }
  const foreign = `strict-unknown-${stamp(now - 400 * DAY)}-${RUN}-00000000.json`;
  for (const n of [...old, ...kept, foreign]) await put(path.join(r.trainSweep, n), now);
  const pass = await pruneArea({ area: 'train-sweep', roots: r, now });
  assert.equal(pass.refused, null); assert.deepEqual(pass.names.sort(), old.sort());
  assert.deepEqual(await ls(r.trainSweep), [...kept, foreign].sort());
});

test('pruning: names carry the age; the review holds train-shadow; the newest of each kind stays; links refuse', async t => {
  const base = await tempDir(t), r = roots(base), NOW = Date.parse('2027-03-01T00:00:00Z');
  for (const ms of [NOW - 200 * DAY, NOW - 120 * DAY, NOW - 10 * DAY]) await put(path.join(r.trainShadow, shadowName(ms)), ms);
  await put(path.join(r.trainShadow, 'observations.jsonl'), NOW - 400 * DAY);
  await put(path.join(r.trainShadow, `${shadowName(NOW - 300 * DAY)}.tmp`), NOW - 300 * DAY);
  // until the Owner's review, every shadow record stays (a review mark that cannot be read counts as none)
  assert.deepEqual((await pruneArea({ area: 'train-shadow', roots: r, now: NOW })).refused, 'RETENTION_REVIEW_PENDING');
  assert.deepEqual((await pruneArea({ area: 'train-shadow', roots: r, now: NOW, reviewCode: 'RETENTION_REVIEW_UNREADABLE' })).refused, 'RETENTION_REVIEW_UNREADABLE');
  assert.equal((await ls(r.trainShadow)).length, 5);
  const shadow = await pruneArea({ area: 'train-shadow', roots: r, now: NOW, reviewedAt: NOW - 30 * DAY });
  assert.deepEqual([shadow.deleted, shadow.names, shadow.deferred], [2, [shadowName(NOW - 200 * DAY), shadowName(NOW - 120 * DAY)], 0]);
  assert.deepEqual(await ls(r.trainShadow), [shadowName(NOW - 10 * DAY), `${shadowName(NOW - 300 * DAY)}.tmp`, 'observations.jsonl'].sort());
  // sweep records: per kind the newest stays however old; a second hard link stays; other names never go
  const old = [sweepName('proof', NOW - 300 * DAY), sweepName('proof', NOW - 200 * DAY, 1), sweepName('full-on', NOW - 300 * DAY), sweepName('full-on', NOW - 100 * DAY, 1),
    sweepName('front', NOW - 95 * DAY), sweepName('full-shadow', NOW - 95 * DAY)];
  for (const n of old) await put(path.join(r.trainSweep, n), NOW);
  await fs.link(path.join(r.trainSweep, sweepName('full-on', NOW - 300 * DAY)), path.join(r.trainSweep, 'crashed.tmp'));
  await put(path.join(r.trainSweep, 'notes.txt'), NOW - 400 * DAY);
  const sweep = await pruneArea({ area: 'train-sweep', roots: r, now: NOW });
  assert.deepEqual([sweep.refused, sweep.names, sweep.kept], [null, [sweepName('proof', NOW - 300 * DAY)], 1]);
  assert.deepEqual(await ls(r.trainSweep), [...old.slice(1), 'crashed.tmp', 'notes.txt'].sort());
  // closed ledger months: one year after the month ended, at most four a pass; a month holds files only
  for (const m of ['2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2026-02']) await put(path.join(r.greenLedger, 'closed', m, 'r.json'), NOW);
  const closed = await pruneArea({ area: 'green-ledger-closed', roots: r, now: NOW });
  assert.deepEqual([closed.names, closed.deferred], [['2025-01', '2025-02', '2025-03', '2025-04'], 1]);
  assert.deepEqual(await ls(path.join(r.greenLedger, 'closed')), ['2025-05', '2026-02']);
  // a junction (or anything but a plain file) inside a month refuses the whole area
  await fs.mkdir(path.join(base, 'outside'));
  await fs.symlink(path.join(base, 'outside'), path.join(r.greenLedger, 'closed', '2025-05', 'j'), 'junction');
  const refused = await pruneArea({ area: 'green-ledger-closed', roots: r, now: NOW });
  assert.deepEqual([refused.refused, refused.refusedName, refused.deleted], ['RETENTION_LINK_REFUSED', '2025-05', 0]);
  assert.deepEqual(await ls(path.join(r.greenLedger, 'closed')), ['2025-05', '2026-02']);
  // a redirected area deletes nothing; an area that is not there is no error
  await fs.symlink(path.join(base, 'outside'), path.join(base, 'shadow-link'), 'junction');
  assert.equal((await pruneArea({ area: 'train-shadow', roots: { ...r, trainShadow: path.join(base, 'shadow-link') }, now: NOW, reviewedAt: NOW })).refused, 'RETENTION_AREA_REDIRECTED');
  assert.deepEqual((await pruneArea({ area: 'retention-passes', roots: r, now: NOW })).refused, null);
  await assert.rejects(pruneArea({ area: 'receipts', roots: r, now: NOW }), { code: 'RETENTION_AREA_UNKNOWN' });
});

test('the review mark: missing, exact, invalid', async t => {
  const file = path.join(await tempDir(t), 'train-shadow-reviewed.json');
  assert.deepEqual(await readTrainReview(file), { reviewedAt: null, code: 'RETENTION_REVIEW_PENDING' });
  await fs.writeFile(file, JSON.stringify({ contract: TRAIN_REVIEW_CONTRACT, reviewedAt: '2027-01-01T00:00:00Z', ref: 'owner' }));
  assert.deepEqual(await readTrainReview(file), { reviewedAt: Date.parse('2027-01-01T00:00:00Z'), code: null });
  await fs.writeFile(file, JSON.stringify({ contract: TRAIN_REVIEW_CONTRACT, reviewedAt: 'soon', ref: 'owner' }));
  assert.deepEqual(await readTrainReview(file), { reviewedAt: null, code: 'RETENTION_REVIEW_INVALID' });
  await fs.writeFile(file, JSON.stringify({ contract: TRAIN_REVIEW_CONTRACT, reviewedAt: '2027-01-01T00:00:00Z', ref: 'owner', extra: 1 }));
  assert.equal((await readTrainReview(file)).code, 'RETENTION_REVIEW_INVALID');
});

test('the daily pass: one record a day, readable in receipts\\retention; out of time or broken it never throws', async t => {
  const base = await tempDir(t), r = roots(base), NOW = Date.parse('2027-03-01T00:00:00Z');
  await put(path.join(r.trainSweep, sweepName('proof', NOW - 200 * DAY)), NOW);
  await put(path.join(r.trainSweep, sweepName('proof', NOW - DAY, 1)), NOW);
  await put(path.join(r.trainShadow, shadowName(NOW - 200 * DAY)), NOW);
  await put(path.join(r.trainShadow, shadowName(NOW - DAY)), NOW);
  await put(path.join(r.receipts, `outcome-${nonce('a')}.json`), NOW - 40 * DAY);
  const logged = [];
  let now = NOW;
  const pass = await stateRetention({ runId: RUN, roots: r, reviewFile: path.join(base, 'no-review.json'), clock: () => now, log: (kind, data) => logged.push([kind, data]) });
  assert.deepEqual([pass.contract, pass.runId, pass.review, pass.segments.moved, pass.segments.sealed], [PASS_CONTRACT, RUN, { reviewedAt: null, code: 'RETENTION_REVIEW_PENDING' }, 1, true]);
  assert.deepEqual(pass.areas.map(a => [a.area, a.refused, a.deleted]), [['train-shadow', 'RETENTION_REVIEW_PENDING', 0], ['train-sweep', null, 1], ['green-ledger-closed', null, 0], ['retention-passes', null, 0]]);
  assert.equal((await ls(r.trainShadow)).length, 2, 'no review: every shadow record stays');
  const records = await ls(path.join(r.receipts, PASS_DIRECTORY));
  assert.deepEqual(records, [`${stamp(NOW)}-${RUN}.json`]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(r.receipts, PASS_DIRECTORY, records[0]), 'utf8')), pass);
  assert.deepEqual(logged.map(([k]) => k), ['state_retention']);
  // at most once a day
  now = NOW + 3_600_000;
  assert.deepEqual(await stateRetention({ runId: RUN, roots: r, reviewFile: path.join(base, 'no-review.json'), clock: () => now }), { skipped: 'RETENTION_PASS_NOT_DUE' });
  // with the Owner's review the old shadow record goes; the newest stays
  const review = path.join(base, 'review.json');
  await fs.writeFile(review, JSON.stringify({ contract: TRAIN_REVIEW_CONTRACT, reviewedAt: '2027-02-01T00:00:00Z', ref: 'owner' }));
  now = NOW + DAY;
  const next = await stateRetention({ runId: RUN, roots: r, reviewFile: review, clock: () => now });
  assert.deepEqual([next.areas[0].area, next.areas[0].names], ['train-shadow', [shadowName(NOW - 200 * DAY)]]);
  assert.deepEqual(await ls(r.trainShadow), [shadowName(NOW - DAY)]);
  // no time left in the stage window: nothing happens, nothing is recorded
  now = NOW + 3 * DAY;
  assert.deepEqual(await stateRetention({ runId: RUN, roots: r, reviewFile: review, clock: () => now, notAfter: now + 1000 }), { skipped: 'RETENTION_PASS_NO_TIME' });
  // a broken area is an answer, never an exception: a redirected record directory stops the pass before anything
  const broken = { ...r, receipts: path.join(base, 'receipts2') };
  await fs.mkdir(broken.receipts);
  await fs.mkdir(path.join(base, 'outside'));
  await fs.symlink(path.join(base, 'outside'), path.join(broken.receipts, PASS_DIRECTORY), 'junction');
  const errs = [];
  assert.deepEqual(await stateRetention({ runId: RUN, roots: broken, reviewFile: review, clock: () => now, log: (k, d) => errs.push([k, d]) }), { error: 'RETENTION_AREA_REDIRECTED' });
  assert.deepEqual(errs, [['state_retention_failed', { code: 'RETENTION_AREA_REDIRECTED' }]]);
  assert.deepEqual(await stateRetention({ runId: 'x', roots: r, clock: () => now }), { error: 'RETENTION_RUN_ID_INVALID' });
});

// D6 §8.4 (c), field 2026-11-19: landing batches and landing states were never pruned (the area's names did not include them). They now
// expire like the other sweep records, the newest of each kind always staying, and each kind keeps at most its cap however young.
test('landing retention: landing-batch keeps at most LANDING_BATCH_KEEP, newest first', async t => {
  const r = roots(await tempDir(t)), now = Date.parse('2027-03-01T00:00:00Z');
  const names = Array.from({ length: LANDING_BATCH_KEEP + 3 }, (_, i) => sweepName('landing-batch', now - (i + 1) * 60_000, i));
  const expired = sweepName('landing-batch', now - 100 * DAY, 9999);
  for (const n of [...names, expired]) await put(path.join(r.trainSweep, n), now);
  const pass = await pruneArea({ area: 'train-sweep', roots: r, now });
  assert.equal(pass.refused, null);
  assert.deepEqual(pass.names.sort(), [...names.slice(LANDING_BATCH_KEEP), expired].sort());
  assert.deepEqual(await ls(r.trainSweep), names.slice(0, LANDING_BATCH_KEEP).sort());
});

test('landing retention: landing-state keeps at most LANDING_STATE_KEEP, newest first (a refused one counts like any other)', async t => {
  const r = roots(await tempDir(t)), now = Date.parse('2027-03-01T00:00:00Z');
  const names = Array.from({ length: LANDING_STATE_KEEP + 2 }, (_, i) => sweepName('landing-state', now - (i + 1) * 60_000, i));
  const aged = sweepName('landing-state', now - 100 * DAY, 9999);
  for (const n of [...names, aged]) await put(path.join(r.trainSweep, n), now);
  const lone = sweepName('landing-batch', now - 400 * DAY);
  await put(path.join(r.trainSweep, lone), now);
  const pass = await pruneArea({ area: 'train-sweep', roots: r, now });
  assert.equal(pass.refused, null);
  assert.deepEqual(pass.names.sort(), [...names.slice(LANDING_STATE_KEEP), aged].sort());
  assert.deepEqual(await ls(r.trainSweep), [...names.slice(0, LANDING_STATE_KEEP), lone].sort(), 'the newest landing batch stays however old');
});
