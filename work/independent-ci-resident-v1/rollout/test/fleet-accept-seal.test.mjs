// Real seal and accept commands through the existing resident-node suite. GitHub and the acceptance door are controlled fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { planFiles } from '../../../../scripts/ci/ci-required-selection.mjs';
import * as publishModule from '../fleet/publish.mjs';
import { GRANT, GRANT_RECEIPT, TAG, fakeTime, prepWorld, resourceOf, sealedNothing, sha, timed, uploadsOf } from '../fleet/test/publish-fixtures.mjs';

// PLAN-accept-align-open-20261125 1.2 (red before: a rejected request was opened again, one gh workflow run, and answered WAITING_OWNER)
// the Owner's "reject" is final (the door replays rejected and never opens it again): seal reading rejected, at the start or after waiting,
// with or without --wait, answers REJECTED at once; no workflow run, no sleep, nothing written, the command exits non-zero
test('seal on a rejected request: FLEET_ACCEPTANCE_REJECTED at once, at the start and with --wait; never a gh workflow run, nothing written, exit non-zero', async t => {
  for (const wait of [0, 30]) {
    const w = await prepWorld(t);
    await w.prep();
    w.door.status = 'rejected';
    const time = fakeTime('2026-11-25T01:00:00Z');
    const before = await fs.readFile(w.index), n = (await uploadsOf(w)).length;
    const r = await timed(w, time, { wait });
    assert.deepEqual([r.status, r.answer, (await w.opens()).length], ['FLEET_ACCEPTANCE_REJECTED', 'rejected', 0], `wait ${wait}: rejected is final, never opened again`);
    assert.deepEqual(time.slept, [], `wait ${wait}: answered at once`);
    assert.equal(w.door.reads.length, 1, `wait ${wait}: one read`);
    assert.match(r.next, /new version/, `wait ${wait}: next names a new version, not the same seal again`);
    await sealedNothing(w, before, n);
    assert.notEqual(publishModule.exitCodeOf(r), 0);
  }
});


// Task 87d330d0 step 3: the two cases of the test above that its red run never reached, each on its own.
// (red before: --wait 60 waited the whole hour for the link and answered WAITING_OWNER opened:false)
test('seal --wait 60 on a request the workflow does not open: NOT_OPENED 15 minutes after its one run, not after the wait', async t => {
  const w = await prepWorld(t);
  await w.prep();
  Object.assign(w.door, { status: 'none', openTo: 'none' });
  const time = fakeTime('2026-11-25T01:00:00Z');
  const start = time.now, before = await fs.readFile(w.index), n = (await uploadsOf(w)).length;
  const r = await timed(w, time, { wait: 60 });
  assert.equal(r.status, 'FLEET_ACCEPTANCE_NOT_OPENED', JSON.stringify({ status: r.status, opened: r.opened ?? null, confirmUrl: r.confirmUrl ?? null, minutes: (time.now - start) / 60_000 }));
  assert.equal(time.now - start, 15 * 60_000, 'the wait is for the Owner, the run is given 15 minutes');
  assert.equal((await w.opens()).length, 1, 'one workflow run');
  await sealedNothing(w, before, n);
  assert.notEqual(publishModule.exitCodeOf(r), 0);
});

// (red before: the read that failed after the run threw ACCEPT_DOOR_UNAVAILABLE, and the caller ran seal again: a second run)
test('seal: a door that cannot be read after its one run answers NOT_OPENED at 15 minutes, never a throw', async t => {
  const w = await prepWorld(t);
  await w.prep();
  Object.assign(w.door, { status: 'none', openTo: 'none' });
  const time = fakeTime('2026-11-25T01:00:00Z', () => { w.door.fail = 1e9; });
  const start = time.now, before = await fs.readFile(w.index), n = (await uploadsOf(w)).length;
  let r;
  try { r = await timed(w, time, { wait: 0 }); } catch (e) { assert.fail(`seal threw ${e?.code ?? e} after ${(time.now - start) / 60_000} minutes`); }
  assert.equal(r.status, 'FLEET_ACCEPTANCE_NOT_OPENED', JSON.stringify(r));
  assert.equal(time.now - start, 15 * 60_000);
  assert.equal((await w.opens()).length, 1, 'one workflow run');
  assert.ok(w.door.reads.length >= 3, 'read again while there was time');
  await sealedNothing(w, before, n);
  assert.notEqual(publishModule.exitCodeOf(r), 0);
});


// Task 87d330d0 alignment: accept.mjs (part C) on part B's real seal and readFleet, reached through accept.mjs's own defaults (open gives
// seal wait 0, run one seal the whole --wait; deps.sealOptions and deps.readStatus give them this world's index, gh and door; nothing
// else is faked on B's side).
const acceptWorld = async (t, onSleep) => {
  const w = await prepWorld(t);
  await w.prep();
  const time = fakeTime('2026-11-25T01:00:00Z', onSleep);
  const request = JSON.parse(await fs.readFile(w.requestFile, 'utf8'));
  const upgrades = [];
  const deps = { sealOptions: { index: w.index, ghCommand: [process.execPath, w.fake], deps: { ...w.deps, clock: time.clock, sleep: time.sleep } },
    readStatus: w.deps.readStatus, now: time.clock, sleep: time.sleep, root: path.join(w.d, 'root'),
    upgrade: async argv => { upgrades.push(argv); return { status: 'FLEET_NODE_ALREADY_AT_THIS_PACKAGE', node: 'DESK' }; } };
  const { main: acceptMain, exitCodeOf: acceptExit } = await import('../fleet/accept.mjs');
  const run = (...extra) => acceptMain(['run', '--request', w.requestFile, '--work', path.join(w.d, 'work'), ...extra], deps);
  const open = () => acceptMain(['open', '--request', w.requestFile], deps);
  return { w, time, request, upgrades, run, open, acceptExit };
};

test('accept.mjs on the real seal and readFleet: open opens the request once and gives the link; approved, run seals and reads the fleet off the door', async t => {
  const { w, request, upgrades, run, open, acceptExit } = await acceptWorld(t);
  w.door.status = 'none';
  const opened = await open();
  assert.equal(opened.status, 'FLEET_ACCEPTANCE_WAITING_OWNER', JSON.stringify(opened));
  assert.equal(opened.confirmUrl, w.door.confirmUrl);
  assert.equal(acceptExit(opened), 0);
  assert.equal((await w.opens()).length, 1, 'one workflow run');
  // the Owner approves on the page; the in-service nodes report the accepted Source. Part A's answer as its migration writes it
  // (5b8aa67c2, PLAN-accept-align-open-20261125 3.2): the nodes in state active or draining, by name, so a registered node never approved
  // (state pending) is not in it and cannot hold the fleet back; a draining one is
  const at = request.ciSourceManifestSha256;
  Object.assign(w.door, { status: 'accepted', grant: GRANT, receipt: GRANT_RECEIPT, acceptedAt: '2026-11-25T01:02:03.456789+00:00',
    nodes: [{ name: 'DESK', source_sha256: at, paused: false }, { name: 'LEAVING', source_sha256: at, paused: false }, { name: 'TURING', source_sha256: at, paused: false }] });
  const done = await run();
  assert.equal(done.status, 'ROLLOUT_DONE', JSON.stringify(done));
  assert.deepEqual(done.nodes, ['DESK', 'LEAVING', 'TURING']);
  assert.equal(upgrades.length, 1);
  assert.ok((await w.assets()).some(a => a.name === `${TAG}.acceptance.json`), 'sealed on the Release');
  assert.equal((await w.opens()).length, 1, 'still one workflow run');
  // TURING not there yet: the door says so, and run names it
  w.door.nodes = [{ name: 'DESK', source_sha256: at, paused: false }, { name: 'LEAVING', source_sha256: at, paused: false }, { name: 'TURING', source_sha256: 'a'.repeat(64), paused: false }];
  const waiting = await run();
  assert.equal(waiting.status, 'ROLLOUT_WAITING_OTHER_NODES', JSON.stringify(waiting));
  assert.deepEqual(waiting.pending.map(n => n.node), ['TURING']);
  const acceptModule = await import('../fleet/accept.mjs');
  assert.equal(acceptModule.SEAL_INPUT_ERRORS, publishModule.SEAL_INPUT_ERRORS, 'accept.mjs stops on seal\'s own list');
});

// PLAN-accept-align-open-20261125 1.2 and 1.4 (red before, a todo: run asked seal (wait 0) again, and seal opened a new request on the
// rejected it read at its start): the Owner's no is final; the one seal run gives answers REJECTED and no request is ever opened
test('accept.mjs run on the real seal: the Owner rejects the request it waits on -> ROLLOUT_STOPPED, no new request', async t => {
  let wr = null;
  const { w, run, acceptExit } = await acceptWorld(t, tt => { if (tt.slept.length === 1) wr.door.status = 'rejected'; });
  wr = w;
  w.door.status = 'pending';
  const r = await run('--wait', '10');
  assert.equal(r.status, 'ROLLOUT_STOPPED', JSON.stringify(r));
  assert.deepEqual([r.stage, r.code, r.answer], ['accept', 'FLEET_ACCEPTANCE_REJECTED', 'rejected']);
  assert.match(r.next, /new version/);
  assert.equal(acceptExit(r), 1);
  assert.deepEqual(await w.opens(), [], 'no request opened after the Owner said no');
  // the same command again (a lost process restarted, a rerun): still no request
  const again = await run();
  assert.equal(again.status, 'ROLLOUT_STOPPED', JSON.stringify(again));
  assert.deepEqual(await w.opens(), [], 'never opened again');
});

// PLAN-accept-align-open-20261125 2.4 (red before: run asked seal (wait 0) again every 30-120 s and each look that found no request
// dispatched once more, for the whole wait; it ended ROLLOUT_WAITING_OWNER FLEET_ACCEPTANCE_OPEN_QUEUED)
test('accept.mjs run on the real seal: a request the workflow never opens is ROLLOUT_STOPPED FLEET_ACCEPTANCE_NOT_OPENED 15 minutes after its one run', async t => {
  const { w, time, run, acceptExit } = await acceptWorld(t);
  Object.assign(w.door, { status: 'none', openTo: 'none' });
  const start = time.now;
  const r = await run('--wait', '60');
  assert.deepEqual([r.status, r.code, (await w.opens()).length], ['ROLLOUT_STOPPED', 'FLEET_ACCEPTANCE_NOT_OPENED', 1], JSON.stringify({ ...r, runs: (await w.opens()).length }));
  assert.equal(r.stage, 'accept');
  assert.equal(time.now - start, 15 * 60_000, 'stopped 15 minutes after the run, not at the end of the wait');
  assert.match(r.next, /fleet-accept/);
  assert.equal(acceptExit(r), 1);
});

// PLAN-accept-align-open-20261125 2.1 item 3 and 2.4 (red before: each look of run was a whole seal, which downloaded the Release's tar
// again): the Owner not answering for the whole wait is one seal, one download, no workflow run; then the default wait (a day) likewise
test('accept.mjs run on the real seal: the Owner does not answer for the whole wait: one download of the tar, no workflow run, ROLLOUT_WAITING_OWNER with the link', async t => {
  const { w, time, run, acceptExit } = await acceptWorld(t);
  w.door.status = 'pending';
  const tarsOf = calls => calls.filter(c => c.args[0] === 'release' && c.args[1] === 'download' && c.args[c.args.indexOf('--pattern') + 1] === `${TAG}.tar`).length;
  for (const [extra, minutes] of [[['--wait', '60'], 60], [[], 24 * 60]]) {
    const before = (await w.calls()).length, start = time.now;
    const r = await run(...extra);
    const calls = (await w.calls()).slice(before);
    assert.deepEqual([r.status, tarsOf(calls), calls.filter(c => c.args[0] === 'workflow').length], ['ROLLOUT_WAITING_OWNER', 1, 0],
      `${minutes} minutes: ${JSON.stringify({ status: r.status, code: r.code ?? null, tars: tarsOf(calls) })}`);
    assert.equal(r.confirmUrl, w.door.confirmUrl);
    assert.equal(time.now - start, minutes * 60_000, `${minutes} minutes waited`);
    assert.equal(acceptExit(r), 2);
  }
});

test('返修 7：真实 seal 场景由 resident-node 定向入口收录', () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const file = path.relative(root, fileURLToPath(import.meta.url));
  const plan = planFiles('resident-node', { root, files: [file] });
  assert.equal(plan.steps.length, 1);
});

test('返修 2b：open 前置校验超过预算时不派发', async t => {
  const { w, time } = await acceptWorld(t);
  Object.assign(w.door, { status: 'none', openTo: 'none' });
  const start = time.now;
  const { main } = await import('../fleet/accept.mjs');
  const result = await main(['open', '--request', w.requestFile], {
    now: time.clock,
    sealOptions: { index: w.index, ghCommand: [process.execPath, w.fake], deps: {
      ...w.deps, clock: time.clock, sleep: time.sleep,
      sourceHash: async args => {
        await time.sleep(6 * 60_000);
        return w.deps.sourceHash(args);
      },
    } },
  });
  assert.deepEqual([(await w.opens()).length, result.code, time.now - start], [0, 'FLEET_ACCEPTANCE_DEADLINE', 6 * 60_000], JSON.stringify(result));
});

test('返修 2c：GitHub 校验子进程受绝对终点约束', async t => {
  const w = await prepWorld(t);
  await w.prep();
  await w.setState(st => { st.compareDelayMs = 8_000; });
  const started = Date.now();
  await assert.rejects(w.sealDoor({ wait: 1, deadline: started + 500 }), { code: 'FLEET_ACCEPTANCE_DEADLINE' });
  assert.ok(Date.now() - started < 6_000);
  assert.deepEqual(w.door.reads, []);
  assert.deepEqual(await w.opens(), []);
});

test('返修 6a：run 派发后在结束前告知首个有效确认链接', async t => {
  const { w, time } = await acceptWorld(t);
  for (const start of ['none', 'expired']) {
    Object.assign(w.door, { status: start });
    const events = [];
    const { main } = await import('../fleet/accept.mjs');
    const result = await main(['run', '--request', w.requestFile, '--work', path.join(w.d, 'work'), '--wait', '1'], {
      now: time.clock, sleep: time.sleep, root: path.join(w.d, 'root'),
      sealOptions: { index: w.index, ghCommand: [process.execPath, w.fake], deps: { ...w.deps, clock: time.clock, sleep: time.sleep } },
      onPending: event => events.push({ ...event, at: time.now }),
    });
    assert.equal(result.status, 'ROLLOUT_WAITING_OWNER', start);
    assert.equal(events.length, 1, start);
    assert.equal(events[0].confirmUrl, w.door.confirmUrl);
    assert.ok(events[0].at < time.now);
  }
});

test('返修 1：过期时读超时', async t => {
  const start = '2026-11-25T01:00:00Z';
  const time = fakeTime(start);
  const w = await prepWorld(t);
  await w.prep();
  Object.assign(w.door, { status: 'pending', expiresAt: '2026-11-25T01:00:30Z' });
  const timeouts = [];
  const readStatus = async (resource, { timeoutMs = 30_000 } = {}) => {
    if (w.door.reads.length === 0) return w.deps.readStatus(resource);
    timeouts.push(timeoutMs);
    await time.sleep(timeoutMs);
    throw Object.assign(new Error('timed out'), { code: 'ACCEPT_DOOR_UNAVAILABLE' });
  };
  const r = await timed(w, time, { wait: 60, deps: { ...w.deps, readStatus, clock: time.clock, sleep: time.sleep } });
  assert.ok(r.status === 'FLEET_ACCEPTANCE_UNREADABLE' && !r.confirmUrl && time.now <= Date.parse(w.door.expiresAt), JSON.stringify({ status: r.status, expiresAt: r.expiresAt, waitedMs: time.now - Date.parse(start) }));
  assert.deepEqual(timeouts, [1000], 'the last read uses the time remaining until expiry');
  assert.deepEqual(await w.opens(), []);
  Object.assign(w.door, { status: 'expired', expiresAt: '2026-11-26T01:00:30Z' });
  const again = await timed(w, time);
  assert.equal(again.status, 'FLEET_ACCEPTANCE_WAITING_OWNER');
  assert.equal((await w.opens()).length, 1);
});
test('返修 3：连续非暂态读错', async t => {
  const { w, run } = await acceptWorld(t);
  let reads = 0;
  w.door.answer = (_resource, base) => {
    if (++reads <= 8 && reads % 2 === 0) throw Object.assign(new Error('403 refused'), { code: 'ACCEPT_DOOR_REFUSED' });
    return { ...base, status: 'none' };
  };
  const before = (await w.calls()).length;
  const r = await run('--wait', '60');
  const calls = (await w.calls()).slice(before);
  const workflows = calls.filter(c => c.args[0] === 'workflow').length;
  const tars = calls.filter(c => c.args[1] === 'download' && c.args[c.args.indexOf('--pattern') + 1] === TAG + '.tar').length;
  assert.deepEqual([workflows, tars, r.code], [1, 1, 'ACCEPT_DOOR_REFUSED'], JSON.stringify({ workflows, tars, status: r.status, code: r.code }));
});

test('返修 3b：派发响应丢失后只读门，沿用本次已校验的包', async t => {
  const { w, run } = await acceptWorld(t);
  w.door.status = 'none';
  await w.setState(st => { st.workflowLostReply = true; });
  const before = (await w.calls()).length;
  const result = await run('--wait', '1');
  const calls = (await w.calls()).slice(before);
  assert.deepEqual([result.status, result.confirmUrl, (await w.opens()).length], ['ROLLOUT_WAITING_OWNER', w.door.confirmUrl, 1]);
  assert.equal(calls.filter(c => c.args[0] === 'api').length, 1, 'only one preflight');
});
test('返修 5：open 保留拒绝终局和文案', async t => {
  const { w, open } = await acceptWorld(t);
  w.door.status = 'rejected';
  const r = await open();
  assert.ok(r.answer === 'rejected' && /new version/.test(r.next ?? ''), JSON.stringify(r));
});
test('返修 2a：起跑满 24 小时不再投节点请求', async t => {
  const { w } = await acceptWorld(t);
  let clock = 0, upgrades = 0;
  const { main } = await import('../fleet/accept.mjs');
  const r = await main(['run', '--request', w.requestFile, '--work', path.join(w.d, 'work')], {
    root: path.join(w.d, 'root'), now: () => clock,
    seal: async () => { clock += 24 * 3600_000 + 1; return { status: 'FLEET_ACCEPTANCE_SEALED' }; },
    upgrade: async () => { upgrades++; return { status: 'FLEET_NODE_ALREADY_AT_THIS_PACKAGE', node: 'fixture' }; },
    readFleet: async () => [],
  });
  assert.equal(upgrades, 0, JSON.stringify({ upgrades, clock, status: r.status }));
});

test('返修 4：冷目录封存后本机升级只下载一次 tar', async t => {
  const { w, time, request } = await acceptWorld(t);
  const { createServer } = await import('node:http');
  const { fetchPackage } = await import('../fleet/fetch.mjs');
  const { main } = await import('../fleet/accept.mjs');
  const names = [TAG + '.acceptance.json', 'SHA256SUMS', TAG + '.tar'];
  const bodies = [
    () => fs.readFile(path.join(w.out, TAG + '.acceptance.json')),
    () => fs.readFile(path.join(w.build, 'SHA256SUMS')),
    () => w.tar,
  ];
  let upgradeTar = 0;
  const server = createServer(async (req, res) => {
    try {
      if (req.url.endsWith('/releases/tags/' + TAG)) {
        const assets = await Promise.all(names.map(async (name, id) => ({ name, id, size: (await bodies[id]()).length })));
        return res.end(JSON.stringify({ assets }));
      }
      if (req.url.includes('/releases/assets/')) {
        res.writeHead(302, { location: '/blob/' + req.url.split('/').at(-1) });
        return res.end();
      }
      const i = Number(req.url.split('/').at(-1));
      if (i === 2) upgradeTar++;
      return res.end(await bodies[i]());
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const before = (await w.calls()).length;
  const r = await main(['run', '--request', w.requestFile, '--work', path.join(w.d, 'clean')], {
    sealOptions: { index: w.index, ghCommand: [process.execPath, w.fake], deps: { ...w.deps, clock: time.clock, sleep: time.sleep } },
    now: time.clock, root: path.join(w.d, 'root'),
    upgrade: async argv => {
      const after = flag => argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null;
      await fetchPackage({ version: after('--version'), repo: after('--repo'), dir: path.join(after('--work'), 'dl'),
        from: after('--from'), apiBase: 'http://127.0.0.1:' + server.address().port, getToken: () => 'fake',
        deadlineMs: 1000 });
      return { status: 'FLEET_NODE_ALREADY_AT_THIS_PACKAGE', node: 'DESK' };
    },
    readFleet: async () => [{ node: 'DESK', ciSourceManifestSha256: request.ciSourceManifestSha256, paused: false }],
  });
  assert.equal(r.status, 'ROLLOUT_DONE', JSON.stringify(r));
  const sealTar = (await w.calls()).slice(before).filter(c => c.args[1] === 'download' && c.args[c.args.indexOf('--pattern') + 1] === TAG + '.tar').length;
  assert.equal(sealTar + upgradeTar, 1, JSON.stringify({ sealTar, upgradeTar }));
});
