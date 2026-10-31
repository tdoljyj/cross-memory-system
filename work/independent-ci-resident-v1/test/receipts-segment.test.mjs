// The receipt chain closed by month (step 3c-2b, DESIGN §41.7): the open segment stays flat in receipts\, a start seals the
// months before the current one and moves them (rename only) into receipts\archive\, reads only the seals and the open segment,
// and old receipts stay readable (latest, verifyAll); an interrupted seal is finished; a reader that does not seal moves nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ARCHIVE_DIR, INDEX_DIR, RECEIPT_SEAL_CONTRACT, ReceiptChain } from '../src/receipts.mjs';
import { tempRoot } from './helpers.mjs';

const OCT = Date.parse('2026-10-20T12:00:00Z'), NOV = Date.parse('2026-11-02T08:00:00Z'), DEC = Date.parse('2026-12-01T00:00:01Z');
const names = async dir => (await fs.readdir(dir)).filter(n => n.endsWith('.json')).sort();

test('a chain from before segmentation is an open segment; the first start in a later month seals and archives it', async t => {
  const dir = path.join(await tempRoot(t), 'receipts');
  let now = OCT;
  const old = await ReceiptChain.open(dir, () => now);
  for (const type of ['service-start', 'train-run-intent', 'train-run']) await old.append(type, { n: type });
  // the same month: nothing is sealed
  const same = await ReceiptChain.open(dir, () => now, { seal: true });
  assert.equal((await same.seals()).length, 0);
  assert.deepEqual(await names(dir), ['00000001-service-start.json', '00000002-train-run-intent.json', '00000003-train-run.json']);
  now = NOV;
  const chain = await ReceiptChain.open(dir, () => now, { seal: true });
  const [s] = await chain.seals();
  assert.deepEqual([s.seal.contract, s.seal.no, s.seal.month, s.seal.firstSeq, s.seal.lastSeq, s.seal.count, s.segment], [RECEIPT_SEAL_CONTRACT, 1, '2026-10', 1, 3, 3, '0001-2026-10']);
  assert.deepEqual(await names(dir), [], 'receipts\\ holds the open segment only');
  assert.deepEqual(await names(path.join(dir, ARCHIVE_DIR, '0001-2026-10')), ['00000001-service-start.json', '00000002-train-run-intent.json', '00000003-train-run.json']);
  // the chain goes on across the seal: the next receipt chains from the sealed head
  const r = await chain.append('service-start', { n: 4 });
  assert.equal(r.seq, 4);
  assert.equal(JSON.parse(await fs.readFile(r.file, 'utf8')).prevSha256, s.seal.headSha256);
  assert.deepEqual(await chain.verify(), { seq: 4, sha256: r.sha256 });
  assert.deepEqual(await chain.verifyAll(), { seq: 4, sha256: r.sha256 });
  // old receipts stay readable: latest() goes into the archive when the open segment has too few
  const latest = await chain.latest(['train-run-intent', 'train-run'], 5);
  assert.deepEqual(latest.map(e => [e.seq, e.type]), [[2, 'train-run-intent'], [3, 'train-run']]);
  assert.deepEqual((await chain.latest(['service-start'], 1)).map(e => e.seq), [4], 'the open segment first');
  // a second month: a second seal chained to the first
  await chain.append('train-run-intent', {});
  now = DEC;
  const again = await ReceiptChain.open(dir, () => now, { seal: true });
  const seals = await again.seals();
  assert.deepEqual(seals.map(x => [x.no, x.seal.firstSeq, x.seal.lastSeq, x.seal.prevSealSha256 === (x.no === 1 ? '0'.repeat(64) : seals[0].sha256)]), [[1, 1, 3, true], [2, 4, 5, true]]);
  assert.equal((await again.verifyAll()).seq, 5);
  assert.equal((await again.append('x', {})).seq, 6);
});

test('the start reads the seals and the open segment only; verifyAll finds an edited archive; a broken seal chain fails closed', async t => {
  const dir = path.join(await tempRoot(t), 'receipts');
  let now = OCT;
  const a = await ReceiptChain.open(dir, () => now);
  await a.append('one', {}); await a.append('two', {});
  now = NOV;
  await ReceiptChain.open(dir, () => now, { seal: true });
  const archived = path.join(dir, ARCHIVE_DIR, '0001-2026-10', '00000001-one.json');
  const bytes = await fs.readFile(archived);
  await fs.writeFile(archived, Buffer.from(bytes.toString('utf8').replace('"one"', '"one"').replace('{}', '{"edited":true}')));
  const b = await ReceiptChain.open(dir, () => now);
  assert.equal((await b.verify()).seq, 2, 'the archive is not read at a start');
  await assert.rejects(b.verifyAll(), e => ['RECEIPT_CHAIN_BROKEN', 'RECEIPT_SEGMENT_CHANGED'].includes(e.code));
  await fs.writeFile(archived, bytes);
  assert.equal((await b.verifyAll()).seq, 2);
  const sealFile = path.join(dir, INDEX_DIR, '0001.json');
  const seal = JSON.parse(await fs.readFile(sealFile, 'utf8'));
  await fs.writeFile(sealFile, JSON.stringify({ ...seal, lastSeq: 3, count: 3 }));
  await assert.rejects(new ReceiptChain(dir, () => now).verifyAll(), { code: 'RECEIPT_SEGMENT_INCOMPLETE' });
  await fs.writeFile(sealFile, JSON.stringify({ ...seal, prevSealSha256: '1'.repeat(64) }));
  await assert.rejects(ReceiptChain.open(dir, () => now), { code: 'RECEIPT_SEAL_INVALID' });
  await fs.writeFile(path.join(dir, INDEX_DIR, '0003.json'), JSON.stringify(seal));
  await fs.writeFile(sealFile, JSON.stringify(seal));
  await assert.rejects(ReceiptChain.open(dir, () => now), { code: 'RECEIPT_SEAL_UNEXPECTED' }, 'a gap in the seals');
});

test('a start interrupted between the seal and its renames finishes them; a reader without seal moves nothing and skips them', async t => {
  const dir = path.join(await tempRoot(t), 'receipts');
  let now = OCT;
  const a = await ReceiptChain.open(dir, () => now);
  for (const n of [1, 2, 3]) await a.append(`r${n}`, {});
  now = NOV;
  await ReceiptChain.open(dir, () => now, { seal: true });
  // put one back, as if the start stopped after the first rename
  await fs.rename(path.join(dir, ARCHIVE_DIR, '0001-2026-10', '00000003-r3.json'), path.join(dir, '00000003-r3.json'));
  const reader = new ReceiptChain(dir, () => now);
  assert.equal((await reader.verify()).seq, 3);
  assert.deepEqual(await reader.entries(), [], 'a sealed range is no part of the open segment');
  assert.equal((await reader.verifyAll()).seq, 3, 'verifyAll reads the rest where it lies');
  assert.deepEqual(await names(dir), ['00000003-r3.json'], 'nothing moved by a reader');
  assert.equal((await reader.append('r4', {})).seq, 4);
  await ReceiptChain.open(dir, () => now, { seal: true });
  assert.deepEqual(await names(dir), ['00000004-r4.json']);
  assert.deepEqual(await names(path.join(dir, ARCHIVE_DIR, '0001-2026-10')), ['00000001-r1.json', '00000002-r2.json', '00000003-r3.json']);
});

test('tools/verify-receipts.mjs (verify-resident.ps1 runs it) checks the whole segmented chain: an edited archived month is broken', async t => {
  const { verifyReceipts } = await import('../tools/verify-receipts.mjs');
  const dir = path.join(await tempRoot(t), 'receipts');
  let now = OCT;
  const a = await ReceiptChain.open(dir, () => now);
  await a.append('one', {}); await a.append('two', {});
  now = NOV;
  const b = await ReceiptChain.open(dir, () => now, { seal: true });
  const head = await b.append('three', {});
  assert.deepEqual(await verifyReceipts(dir), { ok: true, report: { status: 'RECEIPT_CHAIN_INTACT', seq: 3, sha256: head.sha256, segments: 1 } });
  const archived = path.join(dir, ARCHIVE_DIR, '0001-2026-10', '00000001-one.json');
  await fs.writeFile(archived, Buffer.from((await fs.readFile(archived, 'utf8')).replace('{}', '{"edited":true}')));
  assert.equal((await b.verify()).seq, 3, 'the open segment alone does not see it');
  const broken = await verifyReceipts(dir);
  assert.deepEqual([broken.ok, broken.report.status], [false, 'RECEIPT_CHAIN_BROKEN']);
  // the command line: one JSON line, exit 1
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const tool = new URL('../tools/verify-receipts.mjs', import.meta.url);
  const r = await promisify(execFile)(process.execPath, [(await import('node:url')).fileURLToPath(tool), dir]).catch(e => e);
  assert.deepEqual([r.code, JSON.parse(r.stdout).status], [1, 'RECEIPT_CHAIN_BROKEN']);
});

// The previous package's reader (receipts.mjs at main 62e4bc94): every visible name in receipts\ is a receipt, numbered from 1
// without a gap, each chained to the one before from the genesis. Returns the head or throws.
async function previousReader(dir) {
  const { createHash } = await import('node:crypto');
  const names = (await fs.readdir(dir)).filter(n => !n.startsWith('.')).sort();
  let prev = '0'.repeat(64), seq = 0;
  // names first (its entries()), then the chain (its verify())
  for (const name of names) if (!/^(\d{8})-([a-z0-9-]{1,48})\.json$/.test(name)) throw Object.assign(new Error(name), { code: 'RECEIPT_NAME_UNEXPECTED' });
  for (const name of names) {
    const m = /^(\d{8})-([a-z0-9-]{1,48})\.json$/.exec(name);
    seq += 1;
    if (Number(m[1]) !== seq) throw Object.assign(new Error(name), { code: 'RECEIPT_SEQUENCE_GAP' });
    const bytes = await fs.readFile(path.join(dir, name));
    if (JSON.parse(bytes.toString('utf8')).prevSha256 !== prev) throw Object.assign(new Error(name), { code: 'RECEIPT_CHAIN_BROKEN' });
    prev = createHash('sha256').update(bytes).digest('hex');
  }
  return { seq, sha256: prev };
}

test('review R3 M7: a rollback to the previous package; segmented receipts break its reader, tools/receipts-unseal.mjs puts them back', async t => {
  const { unsealReceipts } = await import('../tools/receipts-unseal.mjs');
  const root = await tempRoot(t);
  const dir = path.join(root, 'receipts');
  let now = OCT;
  const a = await ReceiptChain.open(dir, () => now);
  for (const n of [1, 2, 3]) await a.append(`r${n}`, {});
  now = NOV;
  const b = await ReceiptChain.open(dir, () => now, { seal: true });
  await b.append('r4', {});
  now = DEC;
  const c = await ReceiptChain.open(dir, () => now, { seal: true });
  const head = await c.append('r5', {});
  assert.equal((await c.seals()).length, 2);
  await assert.rejects(previousReader(dir), { code: 'RECEIPT_NAME_UNEXPECTED' }, 'the previous reader cannot start on a segmented chain');
  // refusals: relative paths, a keep folder inside receipts\ or one that exists
  await assert.rejects(unsealReceipts('receipts', path.join(root, 'keep')), { code: 'UNSEAL_ARGUMENTS_REQUIRED' });
  await assert.rejects(unsealReceipts(dir, path.join(dir, 'keep')), { code: 'UNSEAL_KEEP_INSIDE_RECEIPTS' });
  await fs.mkdir(path.join(root, 'taken'));
  await assert.rejects(unsealReceipts(dir, path.join(root, 'taken')), { code: 'UNSEAL_KEEP_EXISTS' });
  // an edited archived month is never unsealed
  const archived = path.join(dir, ARCHIVE_DIR, '0001-2026-10', '00000002-r2.json');
  const bytes = await fs.readFile(archived);
  await fs.writeFile(archived, Buffer.from(bytes.toString('utf8').replace('{}', '{"edited":true}')));
  await assert.rejects(unsealReceipts(dir, path.join(root, 'keep')), e => ['RECEIPT_CHAIN_BROKEN', 'RECEIPT_SEGMENT_CHANGED'].includes(e.code));
  await fs.writeFile(archived, bytes);
  const r = await unsealReceipts(dir, path.join(root, 'keep'));
  assert.deepEqual(r, { status: 'RECEIPTS_UNSEALED', seq: 5, sha256: head.sha256, moved: 4, seals: 2 });
  assert.deepEqual(await previousReader(dir), { seq: 5, sha256: head.sha256 }, 'the previous reader starts again');
  assert.deepEqual(await names(path.join(root, 'keep', INDEX_DIR)), ['0001.json', '0002.json'], 'the seals are kept as evidence');
  assert.deepEqual((await fs.readdir(dir)).sort(), ['00000001-r1.json', '00000002-r2.json', '00000003-r3.json', '00000004-r4.json', '00000005-r5.json']);
  // and a segmenting start later seals afresh from the genesis
  const again = await ReceiptChain.open(dir, () => now, { seal: true });
  assert.deepEqual((await again.seals()).map(s => [s.seal.firstSeq, s.seal.lastSeq]), [[1, 4]]);
  assert.equal((await again.verifyAll()).seq, 5);
});

test('review R3 MINOR 1: the seal is written atomically; a temporary file a power loss left in index\ is no seal', async t => {
  const dir = path.join(await tempRoot(t), 'receipts');
  let now = OCT;
  const a = await ReceiptChain.open(dir, () => now);
  await a.append('one', {});
  await fs.mkdir(path.join(dir, INDEX_DIR));
  await fs.writeFile(path.join(dir, INDEX_DIR, '.tmp-0123456789ab-0001.json'), ''); // what a power loss in the middle leaves
  now = NOV;
  const b = await ReceiptChain.open(dir, () => now, { seal: true });
  assert.deepEqual((await b.seals()).map(s => s.seal.lastSeq), [1]);
  assert.ok((await fs.readdir(path.join(dir, INDEX_DIR))).includes('0001.json'));
  const src = await fs.readFile(new URL('../src/receipts.mjs', import.meta.url), 'utf8');
  assert.match(src, /await writeNewAtomic\(path\.join\(this\.dir, INDEX_DIR/, 'the seal goes through writeNewAtomic');
});
