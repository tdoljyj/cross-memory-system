// Task 67ae9ccb: a mailbox file the other side is still writing is not there yet. writeNew (store.mjs) creates the file
// exclusively and only then writes it; on 2026-10-23 at 10:45:42Z the service read a verified archive-linux answer in that
// gap, refused it (MAILBOX_RESPONSE_REFUSED) and HALTed batch 523849a6. Both readers now leave such a file for the next poll.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Mailbox } from '../src/mailbox.mjs';
import { COMPANION_CONFIG_CONTRACT, Companion, validateCompanionConfig } from '../src/companion.mjs';
import { TEST_NODE, TEST_NODE_SHA, tempRoot } from './helpers.mjs';

const BATCH = '0123456789abcdef-0123456789ab';
const T0 = Date.parse('2026-10-23T10:45:00Z');
const DIRECTORY = 'archive-0123456789ab-success-close-aaaaaaaaaaaa';

// The other side's exact bytes, written by its own writeNew into a twin mailbox (so the shapes stay the mailbox's own).
async function twinBytes(t, clock, write) {
  const twin = await Mailbox.open(await tempRoot(t), clock);
  return fs.readFile(await write(twin));
}

// writeNew one step at a time: the exclusive create, then the bytes in pieces, then sync and close. Tests read between.
async function slowWrite(t, file, bytes) {
  const handle = await fs.open(file, 'wx');
  t.after(() => handle.close().catch(() => {})); // also when an assertion fails before finish()
  let at = 0;
  return {
    async upTo(end) { await handle.write(bytes, at, end - at, at); at = end; },
    async finish() { await handle.write(bytes, at, bytes.length - at, at); at = bytes.length; await handle.sync(); await handle.close(); },
  };
}

// Prefix ends a reader can meet: just created (empty), one byte, half, all but the last two bytes ('}' and newline).
const cuts = bytes => [0, 1, Math.floor(bytes.length / 2), bytes.length - 2];

test('service: an answer polled between its create and its last byte is not there yet, never refused', async t => {
  const clock = () => T0;
  const box = await Mailbox.open(await tempRoot(t), clock);
  const req = await box.send('archive-linux', { batchId: BATCH, reason: 'success-close' }, 6 * 60_000);
  const bytes = await twinBytes(t, clock, async twin => { await twin.respond(req, { ok: true, verified: true, directory: DIRECTORY }); return path.join(twin.responses, `${req.requestId}.json`); });
  const w = await slowWrite(t, path.join(box.responses, `${req.requestId}.json`), bytes);
  for (const end of cuts(bytes)) {
    await w.upTo(end);
    assert.equal(await box.poll(req), null, `${end} of ${bytes.length} bytes written`);
  }
  await w.finish();
  const answer = await box.poll(req);
  assert.deepEqual([answer.ok, answer.verified, answer.directory], [true, true, DIRECTORY]);
});

test('service: an answer that grows between readBounded\'s size and its read is not there yet either', async t => {
  const clock = () => T0;
  const box = await Mailbox.open(await tempRoot(t), clock);
  const req = await box.send('archive-linux', { batchId: BATCH, reason: 'success-close' }, 6 * 60_000);
  const bytes = await twinBytes(t, clock, async twin => { await twin.respond(req, { ok: true, verified: true, directory: DIRECTORY }); return path.join(twin.responses, `${req.requestId}.json`); });
  const w = await slowWrite(t, path.join(box.responses, `${req.requestId}.json`), bytes);
  await w.upTo(10);
  // The writer's next bytes land after the reader's handle.stat() and before its handle.read() ('size-changed').
  const probe = await fs.open(path.join(box.responses, `${req.requestId}.json`), 'r');
  const proto = Object.getPrototypeOf(probe);
  await probe.close();
  const read = proto.read;
  t.after(() => { proto.read = read; });
  let grew = false;
  proto.read = async function (...args) { proto.read = read; await w.upTo(20); grew = true; return read.apply(this, args); };
  assert.equal(await box.poll(req), null);
  assert.equal(grew, true);
  await w.finish();
  assert.equal((await box.poll(req)).ok, true);
});

test('service: await polls an unfinished answer again and returns it finished; one unfinished at the deadline is no answer', async t => {
  let now = T0;
  const clock = () => now;
  const box = await Mailbox.open(await tempRoot(t), clock);
  const req = await box.send('archive-linux', { batchId: BATCH, reason: 'success-close' }, 6 * 60_000);
  const bytes = await twinBytes(t, clock, async twin => { await twin.respond(req, { ok: true, verified: true, directory: DIRECTORY }); return path.join(twin.responses, `${req.requestId}.json`); });
  const w = await slowWrite(t, path.join(box.responses, `${req.requestId}.json`), bytes);
  // Each sleep lets the writer go one step further; the first poll already finds the file, empty.
  const steps = [() => w.upTo(1), () => w.upTo(40), () => w.finish()];
  let polls = 0;
  const answer = await box.await(req, async ms => { polls += 1; now += ms; await steps.shift()?.(); });
  assert.equal(answer.ok, true);
  assert.equal(polls, 3, 'three unfinished polls, then the finished answer');

  const late = await box.send('archive-linux', { batchId: BATCH, reason: 'success-close' }, 5_000);
  const lateBytes = await twinBytes(t, clock, async twin => { await twin.respond(late, { ok: true, verified: true, directory: DIRECTORY }); return path.join(twin.responses, `${late.requestId}.json`); });
  const lw = await slowWrite(t, path.join(box.responses, `${late.requestId}.json`), lateBytes);
  await lw.upTo(20);
  assert.equal(await box.await(late, async ms => { now += ms; }), null, 'still unfinished at the deadline: the existing no-answer path');
  await lw.finish();
});

test('companion: a request polled between its create and its last byte is left out, never refused, then answered', async t => {
  let now = T0;
  const clock = () => now;
  const box = await Mailbox.open(await tempRoot(t), clock);
  let sent;
  const bytes = await twinBytes(t, clock, async twin => { sent = await twin.send('linux-quiescence', { batchId: BATCH }, 60_000); return path.join(twin.requests, `${sent.requestId}.json`); });
  const cfg = validateCompanionConfig({
    contract: COMPANION_CONFIG_CONTRACT,
    node: TEST_NODE, nodeProfileSha256: TEST_NODE_SHA,
    wslExe: 'C:\\Windows\\System32\\wsl.exe',
    powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    relayScript: 'C:\\ProgramData\\CluedIndependentCI\\resident\\source\\relay-public.ps1',
    bundleScript: 'C:\\ProgramData\\CluedIndependentCI\\resident\\source\\build-bundle.ps1',
    windowsSpool: 'C:\\ProgramData\\CluedIndependentCI\\formal-spool',
    distribution: TEST_NODE.wslDistribution,
    bridgeManifestSha256: '9'.repeat(64),
    linuxTool: '/opt/clued-independent-ci/resident-v1/bin/clued-ci-resident-linux',
  });
  const runs = [];
  const run = async args => { runs.push(args); return { code: 0, stdout: JSON.stringify({ linuxUnitsInactive: true, containersZero: true, pendingJobsQuiet: true }) }; };
  const c = new Companion({ cfg, mailbox: box, run, fileExists: async () => false, sleep: async ms => { now += ms; }, clock });
  const w = await slowWrite(t, path.join(box.requests, `${sent.requestId}.json`), bytes);
  for (const end of cuts(bytes)) {
    await w.upTo(end);
    assert.deepEqual(await box.pending(), [], `${end} of ${bytes.length} bytes written`);
    await c.step();
  }
  assert.deepEqual(await fs.readdir(box.responses), ['heartbeat.json'], 'no answer, refused or otherwise, to an unfinished request');
  assert.equal(runs.length, 0);
  await w.finish();
  assert.deepEqual(await box.pending(), [sent]);
  await c.step();
  assert.deepEqual((await box.poll(sent)).proof, { linuxUnitsInactive: true, containersZero: true });
});

test('a partial UTF-8 sequence is unfinished too; a finished file of the wrong shape, size or identity is still refused', async t => {
  const clock = () => T0;
  const box = await Mailbox.open(await tempRoot(t), clock);
  const id = '11111111-1111-4111-8111-111111111111';
  // Unfinished: the write stopped inside a multi-byte character.
  await fs.writeFile(path.join(box.requests, `${id}.json`), Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xe2, 0x82]));
  assert.deepEqual(await box.pending(), []);
  const req = await box.send('archive-linux', { batchId: BATCH, reason: 'success-close' }, 60_000);
  const answer = path.join(box.responses, `${req.requestId}.json`);
  await fs.writeFile(answer, Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xe2, 0x82]));
  assert.equal(await box.poll(req), null);

  // Finished, wrong shape: a JSON value that is not an object, and an object with the wrong keys.
  const shapes = [['[]\n', 'MAILBOX_RESPONSE_REFUSED'], ['{"a":1}\n', 'MAILBOX_RESPONSE_KEYS_REFUSED'], [`{"a":"${'x'.repeat(5000)}"}\n`, 'MAILBOX_RESPONSE_REFUSED']];
  for (const [text, code] of shapes) {
    const r = await box.send('archive-linux', { batchId: BATCH, reason: 'success-close' }, 60_000);
    await fs.writeFile(path.join(box.responses, `${r.requestId}.json`), text);
    await assert.rejects(box.poll(r), { code }, text.slice(0, 12));
  }
  const kid = '22222222-2222-4222-8222-222222222222';
  await fs.writeFile(path.join(box.requests, `${kid}.json`), '{"a":1}\n');
  assert.deepEqual((await box.pending()).filter(p => p.refused).map(p => p.requestId), [kid]);

  // Finished, but a second name for the same file: the nlink===1 identity check still refuses it.
  const linked = await box.send('archive-linux', { batchId: BATCH, reason: 'success-close' }, 60_000);
  const other = await box.send('archive-linux', { batchId: BATCH, reason: 'success-close' }, 60_000);
  await box.respond(other, { ok: true, verified: true, directory: DIRECTORY });
  await fs.link(path.join(box.responses, `${other.requestId}.json`), path.join(box.responses, `${linked.requestId}.json`));
  await assert.rejects(box.poll(linked), { code: 'MAILBOX_RESPONSE_REFUSED', detail: 'identity' });
});

test('complete JSON null is refused on both sides while its unfinished prefixes wait', async t => {
  const box = await Mailbox.open(await tempRoot(t), () => T0);
  const req = await box.send('archive-linux', { batchId: BATCH, reason: 'success-close' }, 60_000);
  const response = path.join(box.responses, `${req.requestId}.json`);
  const id = '33333333-3333-4333-8333-333333333333';
  const request = path.join(box.requests, `${id}.json`);

  for (const prefix of ['', 'nu']) {
    await fs.writeFile(response, prefix);
    await fs.writeFile(request, prefix);
    assert.equal(await box.poll(req), null, `unfinished response: ${JSON.stringify(prefix)}`);
    assert.deepEqual((await box.pending()).filter(p => p.requestId === id), [], `unfinished request: ${JSON.stringify(prefix)}`);
  }

  // parseBoundedJson already refuses complete null with detail=object, before readFinished's pending sentinel.
  await fs.writeFile(response, 'null\n');
  await fs.writeFile(request, 'null\n');
  await assert.rejects(box.poll(req), { code: 'MAILBOX_RESPONSE_REFUSED', detail: 'object' });
  assert.deepEqual((await box.pending()).filter(p => p.requestId === id), [{ requestId: id, refused: true }]);
});
