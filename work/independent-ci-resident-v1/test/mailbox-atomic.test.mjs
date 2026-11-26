// Task 32d10618 (DESIGN §31): a reader never meets a half-written mailbox file. The mailbox writers (send, cancel, respond,
// writeTiming) publish a file whole - a temporary name, then one rename - and the readers that cannot be helped that way (the
// Owner's create-only drop boxes inbox\ and requests\) wait for an unfinished file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Mailbox, QUIESCENCE_REQUEST_MS } from '../src/mailbox.mjs';
import { Inbox, INBOX_UNFINISHED_GRACE_MS } from '../src/inbox.mjs';
import { TEMP_FILE, TEMP_PREFIX, sweepTemp, writeNewAtomic } from '../src/store.mjs';
import { parseTrigger } from '../src/trigger.mjs';
import { mailboxCompanion } from '../src/service-ports.mjs';
import { PAUSE_CONTRACT } from '../src/executor.mjs';
import { HEAD, executorFixture, fastSleep, rawPolicy, tempRoot, triggerBytes } from './helpers.mjs';

const BATCH = '0123456789abcdef-0123456789ab';
const T0 = Date.parse('2026-10-29T08:00:00Z');

// The write steps of writeNewAtomic and writeNew, as a test can stop at them: 'created' (the file exists, empty), 'written',
// 'synced', 'before-rename' and 'renamed'. probe(stage) runs at each, with the step not yet taken (or just taken, as named).
async function steps(t, probe) {
  const handle = await fs.open(new URL(import.meta.url));
  const proto = Object.getPrototypeOf(handle);
  await handle.close();
  const { writeFile, sync } = proto, rename = fs.rename;
  proto.writeFile = async function (...args) { await probe('created'); const r = await writeFile.apply(this, args); await probe('written'); return r; };
  proto.sync = async function (...args) { const r = await sync.apply(this, args); await probe('synced'); return r; };
  fs.rename = async (...args) => { await probe('before-rename'); const r = await rename(...args); await probe('renamed'); return r; };
  t.after(() => { proto.writeFile = writeFile; proto.sync = sync; fs.rename = rename; });
}

// Every file in the directory that is not a temporary name is complete JSON: no reader can meet an empty or short one.
async function assertNoPartialFile(dir, where) {
  for (const name of await fs.readdir(dir)) {
    if (TEMP_FILE.test(name)) continue;
    const bytes = await fs.readFile(path.join(dir, name));
    assert.ok(bytes.length > 0, `${where}: ${name} is empty`);
    assert.doesNotThrow(() => JSON.parse(bytes.toString('utf8')), `${where}: ${name} is incomplete`);
  }
}

// writeNew's way (create, then write in pieces), as a companion of before DESIGN §31 wrote.
async function slowWrite(t, file, bytes) {
  const handle = await fs.open(file, 'wx');
  t.after(() => handle.close().catch(() => {}));
  let at = 0;
  return {
    async upTo(end) { await handle.write(bytes, at, end - at, at); at = end; },
    async finish() { await handle.write(bytes, at, bytes.length - at, at); at = bytes.length; await handle.sync(); await handle.close(); },
  };
}

test('writeNewAtomic: the target appears whole, create-only, no temporary file is left, a failed write cleans up', async t => {
  const dir = await tempRoot(t);
  const file = path.join(dir, 'a.json');
  const sha = await writeNewAtomic(file, { n: 1 });
  assert.match(sha, /^[0-9a-f]{64}$/);
  assert.equal(await fs.readFile(file, 'utf8'), '{"n":1}\n');
  assert.deepEqual(await fs.readdir(dir), ['a.json']);
  // the target exists: refused, untouched, nothing left behind
  await assert.rejects(writeNewAtomic(file, { n: 2 }), { code: 'CREATE_ONLY_TARGET_EXISTS' });
  assert.equal(await fs.readFile(file, 'utf8'), '{"n":1}\n');
  assert.deepEqual(await fs.readdir(dir), ['a.json']);
  // a target that appears while the bytes are written is refused too (the second look, just before the rename)
  const racing = path.join(dir, 'b.json');
  const rename = fs.rename;
  t.after(() => { fs.rename = rename; });
  let armed = true;
  await steps(t, async stage => { if (stage === 'synced' && armed) { armed = false; await fs.writeFile(racing, 'other\n'); } });
  await assert.rejects(writeNewAtomic(racing, { n: 3 }), { code: 'CREATE_ONLY_TARGET_EXISTS' });
  assert.equal(await fs.readFile(racing, 'utf8'), 'other\n');
  assert.deepEqual((await fs.readdir(dir)).sort(), ['a.json', 'b.json'], 'the temporary file of the refused write is gone');
  // a rename that fails for good: the error is the caller's, and no temporary file stays
  const full = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  fs.rename = async () => { throw full; };
  await assert.rejects(writeNewAtomic(path.join(dir, 'c.json'), { n: 4 }), full);
  fs.rename = rename;
  assert.deepEqual((await fs.readdir(dir)).sort(), ['a.json', 'b.json']);
});

test('writeNewAtomic: a rename that a scanner blocks for a moment is tried again; any other error is not', async t => {
  const dir = await tempRoot(t);
  const rename = fs.rename;
  t.after(() => { fs.rename = rename; });
  let failures = 2;
  fs.rename = async (...args) => { if (failures-- > 0) throw Object.assign(new Error('busy'), { code: 'EPERM' }); return rename(...args); };
  const waits = [];
  await writeNewAtomic(path.join(dir, 'a.json'), { n: 1 }, { sleep: async ms => { waits.push(ms); } });
  assert.deepEqual(waits, [20, 50]);
  assert.equal(await fs.readFile(path.join(dir, 'a.json'), 'utf8'), '{"n":1}\n');
  // still blocked after every wait: the last error is thrown, and nothing is left behind
  fs.rename = async () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); };
  await assert.rejects(writeNewAtomic(path.join(dir, 'b.json'), { n: 2 }, { sleep: async () => {} }), { code: 'EBUSY' });
  assert.deepEqual(await fs.readdir(dir), ['a.json']);
});

test('at no moment of send, respond or cancel does a mailbox directory hold an empty or incomplete file; every reader copes', async t => {
  let now = T0;
  const box = await Mailbox.open(await tempRoot(t), () => now);
  // The companion's twin on the same directories (the service's send, the companion's respond share one root here).
  const first = await box.send('archive-linux', { batchId: BATCH, reason: 'success-close' }, 6 * 60_000);
  await box.respond(first, { ok: true, verified: true, directory: 'archive-0123456789ab-success-close-aaaaaaaaaaaa' });

  const seen = [];
  const known = new Set([first.requestId]);
  let target = null;           // { kind, request }
  let published = false;       // set once the rename of the file under test is done
  const probe = async stage => {
    seen.push(stage);
    await assertNoPartialFile(box.requests, `requests at ${stage}`);
    await assertNoPartialFile(box.responses, `responses at ${stage}`);
    const pending = await box.pending();
    assert.deepEqual(pending.filter(p => p.refused), [], `a request refused at ${stage}`);
    if (target?.kind === 'send') assert.equal(pending.filter(p => !known.has(p.requestId)).length, stage === 'renamed' ? 1 : 0, `send, ${stage}`);
    if (target?.kind === 'respond') assert.equal(await box.poll(target.request) !== null, published || stage === 'renamed', `respond, ${stage}`);
    if (target?.kind === 'cancel') assert.equal(await box.cancelled(target.request), stage === 'renamed', `cancel, ${stage}`);
    if (stage === 'renamed') published = true;
  };
  await steps(t, probe);

  const sentSeen = seen.length;
  target = { kind: 'send' };
  const sent = await box.send('linux-quiescence', { batchId: BATCH }, 60_000);
  known.add(sent.requestId);
  assert.equal(published, true);
  assert.ok(seen.length > sentSeen && seen.includes('created') && seen.includes('written') && seen.includes('before-rename'), `steps seen: ${seen.slice(sentSeen)}`);

  published = false;
  target = { kind: 'respond', request: sent };
  await box.respond(sent, { ok: true, proof: { linuxUnitsInactive: true, containersZero: true } });
  assert.equal(published, true);

  target = null;
  const other = await box.send('linux-quiescence', { batchId: BATCH }, 60_000);
  known.add(other.requestId);
  published = false;
  target = { kind: 'cancel', request: other };
  await box.cancel(other, 'owner-abort');
  assert.equal(published, true);
});

test('两个办理者争用同一探针时只发布一份完整的开工标记', async t => {
  const root = await tempRoot(t);
  const first = await Mailbox.open(root, () => T0);
  const second = await Mailbox.open(root, () => T0 + 1);
  const req = await first.send('linux-quiescence', { batchId: BATCH }, QUIESCENCE_REQUEST_MS);
  await steps(t, stage => assertNoPartialFile(first.responses, stage));
  // 第一个办理者已经查过目标不存在，在它发布前让第二个完成抢占。
  const link = fs.link;
  const race = t.mock.method(fs, 'link', async (from, to) => {
    race.mock.restore();
    assert.equal(await second.claimProbe(req), true);
    return link(from, to);
  });
  assert.equal(await first.claimProbe(req), false);
  const name = req.requestId + '.probe.json';
  assert.deepEqual(await fs.readdir(first.responses), [name]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(first.responses, name), 'utf8')), {
    requestId: req.requestId, at: T0 + 1,
  });
});

test('create-only holds for the answer, the request and the cancel: the first stands, a second write is refused or a no-op', async t => {
  const box = await Mailbox.open(await tempRoot(t), () => T0);
  const req = await box.send('archive-linux', { batchId: BATCH, reason: 'success-close' }, 60_000);
  const bytes = async () => fs.readFile(path.join(box.responses, `${req.requestId}.json`), 'utf8');
  await box.respond(req, { ok: false, code: 'FIRST_ANSWER' });
  const kept = await bytes();
  await assert.rejects(box.respond(req, { ok: false, code: 'SECOND_ANSWER' }), { code: 'CREATE_ONLY_TARGET_EXISTS' });
  assert.equal(await bytes(), kept);
  await box.cancel(req, 'owner-abort');
  const cancel = await fs.readFile(path.join(box.requests, `${req.requestId}.cancel.json`), 'utf8');
  assert.equal(await box.cancel(req, 'stage-ended'), true, 'idempotent');
  assert.equal(await fs.readFile(path.join(box.requests, `${req.requestId}.cancel.json`), 'utf8'), cancel, 'the first cancel stands');
  assert.deepEqual((await fs.readdir(box.requests)).filter(n => TEMP_FILE.test(n)), []);
  assert.deepEqual((await fs.readdir(box.responses)).filter(n => TEMP_FILE.test(n)), []);
});

test('a temporary name is never taken for a request, an answer or a cancel; old ones are swept, young ones are not', async t => {
  const root = await tempRoot(t);
  const box = await Mailbox.open(root, () => T0);
  const req = await box.send('linux-quiescence', { batchId: BATCH }, 60_000);
  const complete = await fs.readFile(path.join(box.requests, `${req.requestId}.json`), 'utf8');
  const answerName = `${req.requestId}.json`;
  // Temporary names of every writer, each holding a complete copy of what it would publish.
  const strays = [
    [box.requests, `${TEMP_PREFIX}aaaaaaaaaaaa-${req.requestId}.json`, complete],
    [box.requests, `${TEMP_PREFIX}bbbbbbbbbbbb-11111111-1111-4111-8111-111111111111.json`, complete],
    [box.responses, `${TEMP_PREFIX}cccccccccccc-${answerName}`, '{"a":1}\n'],
    [box.responses, `${TEMP_PREFIX}eeeeeeeeeeee-heartbeat.json`, '{"a":1}\n'],
  ];
  for (const [dir, name, text] of strays) await fs.writeFile(path.join(dir, name), text);
  assert.deepEqual((await box.pending()).map(p => p.requestId), [req.requestId], 'only the real request is pending');
  assert.equal(await box.poll(req), null);
  assert.equal(await box.heartbeat(), null);
  assert.ok(strays.every(([, name]) => TEMP_FILE.test(name)));
  // sweep: only names of this shape, only files older than the minimum age
  const old = new Date(Date.now() - 2 * 3_600_000);
  for (const [dir, name] of strays.slice(0, 3)) await fs.utimes(path.join(dir, name), old, old);
  await fs.writeFile(path.join(box.responses, 'not-ours.tmp'), 'x');
  await fs.utimes(path.join(box.responses, 'not-ours.tmp'), old, old);
  assert.equal(await sweepTemp(box.requests), 2);
  assert.equal(await sweepTemp(box.responses), 1);
  const left = [...(await fs.readdir(box.requests)), ...(await fs.readdir(box.responses))];
  assert.ok(left.includes(`${TEMP_PREFIX}eeeeeeeeeeee-heartbeat.json`), 'young temporary files stay');
  assert.ok(left.includes('not-ours.tmp'), 'other names are not touched');
  assert.ok(left.includes(`${req.requestId}.json`), 'the real files are not touched');
  // opening a mailbox sweeps the same way
  for (const [dir, name] of strays.slice(3)) await fs.utimes(path.join(dir, name), old, old);
  await Mailbox.open(root, () => T0);
  assert.deepEqual([...(await fs.readdir(box.requests)), ...(await fs.readdir(box.responses))].filter(n => TEMP_FILE.test(n)), []);
});

test('the heartbeat is written under a swept temporary name and a failed beat leaves none', async t => {
  const box = await Mailbox.open(await tempRoot(t), () => T0);
  await box.beat();
  assert.deepEqual(await fs.readdir(box.responses), ['heartbeat.json']);
  const rename = fs.rename;
  t.after(() => { fs.rename = rename; });
  fs.rename = async () => { throw new Error('locked'); };
  await assert.rejects(box.beat(), /locked/);
  fs.rename = rename;
  assert.deepEqual(await fs.readdir(box.responses), ['heartbeat.json']);
  assert.deepEqual(await box.heartbeat(), { at: T0 });
});

// ---- the Owner's drop boxes: inbox\ and requests\ cannot be renamed in, so the reader waits ----

test('Inbox.drop (the companion\'s writeTrigger): while it writes, the inbox holds an empty file at most, the reader skips it and never refuses a valid trigger; complete, it is read', async t => {
  let now = T0;
  const dir = await tempRoot(t), archive = await tempRoot(t);
  const inbox = await Inbox.open(dir, archive, () => now);
  const trigger = JSON.parse(triggerBytes().toString('utf8'));
  const stages = [];
  await steps(t, async stage => {
    stages.push(stage);
    const entries = await inbox.read(16, 1024);
    assert.deepEqual(entries.filter(e => e.refused), [], `a trigger refused at ${stage}`);
    const names = await fs.readdir(dir);
    for (const name of names) {
      const size = (await fs.stat(path.join(dir, name))).size;
      // the only unfinished state a single create-then-write can have is empty - and then the reader lists nothing
      if (size === 0) assert.deepEqual(entries, [], `an empty file is listed at ${stage}`);
      else assert.equal(entries.length, 1, `a complete file is not listed at ${stage}`);
    }
  });
  const name = await Inbox.drop(dir, trigger, () => now);
  assert.ok(stages.includes('created') && stages.includes('written'), String(stages));
  const [entry] = await inbox.read(16, 1024);
  assert.equal(entry.name, name);
  assert.deepEqual(parseTrigger(entry.bytes, { repo: trigger.repo }), { repo: trigger.repo, pr: 884, headSha: HEAD, baseSha: '2'.repeat(40), prUpdatedAt: null });
});

test('an inbox file still empty after the grace period is refused as before; one that was finished meanwhile is read; a vanished one is forgotten', async t => {
  let now = T0;
  const dir = await tempRoot(t), archive = await tempRoot(t);
  const inbox = await Inbox.open(dir, archive, () => now);
  const file = path.join(dir, `${String(now).padStart(13, '0')}-aaaaaaaaaaaa.json`);
  await fs.writeFile(file, '');
  assert.deepEqual(await inbox.read(16, 1024), []);
  now += INBOX_UNFINISHED_GRACE_MS - 1;
  assert.deepEqual(await inbox.read(16, 1024), []);
  now += 1;
  assert.deepEqual(await inbox.read(16, 1024), [{ name: path.basename(file), bytes: null, refused: 'INBOX_ENTRY_SHAPE_REFUSED' }]);
  // the file is disposed of: its first sighting is forgotten, a new unfinished file starts a new period
  await inbox.dispose(path.basename(file), 'rejected');
  assert.deepEqual(await inbox.read(16, 1024), []);
  assert.equal(inbox.unfinished.size, 0);
  const next = path.join(dir, `${String(now).padStart(13, '0')}-bbbbbbbbbbbb.json`);
  await fs.writeFile(next, '');
  assert.deepEqual(await inbox.read(16, 1024), []);
  await fs.writeFile(next, triggerBytes());
  assert.equal((await inbox.read(16, 1024)).length, 1);
  assert.equal(inbox.unfinished.size, 0);
  // an oversize file and a foreign name are refused at once, as they always were; finished garbage is read (the executor rejects it)
  await fs.writeFile(path.join(dir, `${String(now + 1).padStart(13, '0')}-cccccccccccc.json`), 'x'.repeat(2000));
  await fs.writeFile(path.join(dir, 'run.ps1'), 'x');
  await fs.writeFile(path.join(dir, `${String(now + 2).padStart(13, '0')}-dddddddddddd.json`), '{not json');
  const all = await inbox.read(16, 1024);
  assert.deepEqual(all.filter(e => e.refused).map(e => e.name).sort(), [`${String(now + 1).padStart(13, '0')}-cccccccccccc.json`, 'run.ps1']);
  assert.equal(all.find(e => e.name.endsWith('dddddddddddd.json')).bytes.toString('utf8'), '{not json');
});

test('executor: a trigger still being written is not rejected - it is read when finished, and the batch runs; one never finished is rejected after the grace period', async t => {
  const f = await executorFixture(t);
  f.inbox.clock = f.clock; // the fixture's clock is virtual; the reader's grace period is counted on it
  const name = `${String(f.clock()).padStart(13, '0')}-000000000001.json`;
  const file = path.join(f.root, 'inbox', name);
  await fs.writeFile(file, ''); // the companion's create, before its write
  assert.equal((await f.exec.tick()).state, 'IDLE');
  assert.deepEqual(await fs.readdir(file.replace(name, '')), [name], 'left where it is');
  assert.deepEqual(await fs.readdir(path.join(f.root, 'state', 'inbox-archive', 'rejected')), []);
  await fs.writeFile(file, triggerBytes()); // its write
  const r = await f.exec.tick();
  assert.equal(r.state, 'COMPLETED');
  assert.ok(!(await f.receipts.entries()).some(e => e.type === 'trigger-rejected'), 'no trigger-rejected receipt');
  assert.deepEqual(await fs.readdir(path.join(f.root, 'state', 'inbox-archive', 'rejected')), []);
  // never finished
  const stuck = `${String(f.clock() + 5).padStart(13, '0')}-000000000002.json`;
  await fs.writeFile(path.join(f.root, 'inbox', stuck), '');
  await f.exec.tick();
  assert.deepEqual(await fs.readdir(path.join(f.root, 'inbox')), [stuck]);
  f.advance(INBOX_UNFINISHED_GRACE_MS);
  await f.exec.tick();
  assert.deepEqual(await fs.readdir(path.join(f.root, 'inbox')), []);
  const rejected = (await f.receipts.entries()).filter(e => e.type === 'trigger-rejected');
  assert.equal(rejected.length, 1);
});

test('executor: a pause request still being written in requests\\ is not lost; finished, it pauses', async t => {
  const f = await executorFixture(t);
  f.ports.requests.clock = f.clock;
  const name = `${String(f.clock()).padStart(13, '0')}-000000000003.json`;
  const file = path.join(f.root, 'requests', name);
  await fs.writeFile(file, '');
  assert.notEqual((await f.exec.tick()).state, 'PAUSED');
  assert.deepEqual(await fs.readdir(path.join(f.root, 'requests')), [name], 'not rejected while it is written');
  await fs.writeFile(file, JSON.stringify({ contract: PAUSE_CONTRACT, reason: 'emergency stop' }));
  assert.equal((await f.exec.tick()).state, 'PAUSED');
});

test('no mailbox or companion write is create-then-write any more, except the two a reader cannot be protected from (the pump mark, the drop boxes)', async () => {
  const read = async rel => fs.readFile(new URL(`../src/${rel}`, import.meta.url), 'utf8');
  const mailbox = await read('mailbox.mjs');
  // mailbox.mjs: one writeNew (the pump mark), every other mailbox file through writeNewAtomic
  assert.equal([...mailbox.matchAll(/\bwriteNew\(/g)].length, 1);
  assert.match(mailbox, /async claimPump[\s\S]{0,900}await writeNew\(/);
  assert.equal([...mailbox.matchAll(/\bwriteNewAtomic\(/g)].length, 7); // 请求、撤销、应答、计时，以及静止证明的开工、发布、收件记录
  const main = await read('companion-main.mjs');
  assert.doesNotMatch(main, /flag:\s*'wx'/);
  assert.equal([...main.matchAll(/Inbox\.drop\(/g)].length, 1);
  assert.match(main, /writeTrigger: v => Inbox\.drop\(inboxDir, v\)/);
  assert.doesNotMatch(await read('ruleset-backstop.mjs'), /\bwriteNew\(/);
});
