import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson, sha256 } from '../../src/canonical.mjs';
import { UpgradeMailbox, responseFromTool } from '../../src/upgrade-mailbox.mjs';
import { loadUpgraderConfig, validateUpgraderConfig } from '../src/config.mjs';
import { parseInboxEntry, grantResource, UPGRADE_CANCEL_CONTRACT } from '../src/request.mjs';
import { Journal } from '../src/journal.mjs';
import { grantClient, interpret } from '../src/grant-client.mjs';
import { applyArgs, parseApplyOutput, WindowsPort } from '../src/windows-port.mjs';
import { ResidentPort, pauseRequestBytes } from '../src/resident-ports.mjs';
import { LinuxPort } from '../src/linux-port.mjs';
import { readPackageOnce } from '../src/package.mjs';
import { U, categoryOf, outcomeOf, UPGRADE_CODES } from '../src/codes.mjs';
import { validateIntakeRequest } from '../../src/intake-pause.mjs';
import { validateUpgradeResume } from '../../src/upgrade-mailbox.mjs';
import { T0, buildTestPackage, tempDir, testConfig, upgradeRequestBytes } from './fixtures.mjs';

const OP = '5e1f0000-0000-4000-8000-000000000001';
const PKG = 'ab'.repeat(32);

test('codes: every A8 code has one category; terminal outcomes follow the category', () => {
  assert.equal(UPGRADE_CODES.length, 33); // the 32 of A8 and UPGRADE_CANCELLED
  assert.equal(categoryOf(U.DRAIN_TIMEOUT), 'deferred');
  assert.equal(categoryOf(U.GRANT_DOOR_UNAVAILABLE), 'transient');
  assert.equal(outcomeOf(U.GRANT_STALE), 'STALE');
  assert.equal(outcomeOf(U.VERIFY_TIMEOUT), 'ROLLED_BACK_PAUSED');
  assert.equal(outcomeOf(U.JOURNAL_INCONSISTENT), 'ROLLBACK_FAILED');
  assert.equal(outcomeOf(U.LINUX_STAGE_REFUSED), 'REFUSED');
  assert.throws(() => outcomeOf(U.DRAIN_TIMEOUT), { code: 'UPGRADE_CODE_NOT_TERMINAL' });
});

test('config: exact keys, pauseConfirmMs >= 420 s, a public key only, and the hash the host was given', async t => {
  const root = await tempDir(t);
  const c = testConfig(root);
  validateUpgraderConfig(c);
  assert.throws(() => validateUpgraderConfig({ ...c, timeouts: { ...c.timeouts, pauseConfirmMs: 419_999 } }), { code: 'UPGRADER_CONFIG_REFUSED', detail: 'pauseConfirmMs' });
  assert.throws(() => validateUpgraderConfig({ ...c, publishableKey: 'sb_secret_abcdefghijkl' }), { detail: 'publishableKey' });
  assert.throws(() => validateUpgraderConfig({ ...c, supabaseUrl: 'http://insecure.example' }), { detail: 'origins' });
  assert.throws(() => validateUpgraderConfig({ ...c, tokenFile: '\\\\server\\share\\t' }), { detail: 'paths' });
  assert.throws(() => validateUpgraderConfig({ ...c, extra: 1 }), { code: 'UPGRADER_CONFIG_REFUSED' });
  assert.throws(() => validateUpgraderConfig({ ...c, timeouts: { ...c.timeouts, drainMaxMinutes: 121 } }), { detail: 'timeouts' });
  const file = path.join(root, 'upgrader.json');
  const bytes = Buffer.from(JSON.stringify(c));
  await fs.writeFile(file, bytes);
  assert.equal((await loadUpgraderConfig(file, sha256(bytes))).config.node, c.node);
  await assert.rejects(loadUpgraderConfig(file, 'cd'.repeat(32)), { code: 'UPGRADER_CONFIG_CHANGED' });
});

test('requests: upgrade and cancel shapes; anything else is refused', async t => {
  const pkgDir = await tempDir(t);
  const pkg = { sha: PKG, dir: pkgDir };
  const ok = parseInboxEntry(upgradeRequestBytes(pkg, { requestId: OP }));
  assert.equal(ok.kind, 'upgrade');
  assert.equal(ok.value.drainMaxMinutes, 120, 'default');
  for (const bad of [
    { ...JSON.parse(upgradeRequestBytes(pkg, { requestId: OP })), packageDirectory: '\\\\host\\share\\pkg' },
    { ...JSON.parse(upgradeRequestBytes(pkg, { requestId: OP })), packageDirectory: `${pkgDir}\\..\\x` },
    { ...JSON.parse(upgradeRequestBytes(pkg, { requestId: OP })), drainMaxMinutes: 9 },
    { ...JSON.parse(upgradeRequestBytes(pkg, { requestId: OP })), note: 'x'.repeat(501) },
    { ...JSON.parse(upgradeRequestBytes(pkg, { requestId: OP })), command: 'calc' },
    { ...JSON.parse(upgradeRequestBytes(pkg, { requestId: OP })), node: 'Bad_Node' },
  ]) assert.equal(parseInboxEntry(Buffer.from(JSON.stringify(bad))).kind, 'refused');
  assert.equal(parseInboxEntry(Buffer.from('x'.repeat(3000))).kind, 'refused');
  const cancel = parseInboxEntry(Buffer.from(JSON.stringify({ contract: UPGRADE_CANCEL_CONTRACT, requestId: OP, requestedAt: new Date(T0).toISOString(), nonce: 'ab'.repeat(8) })));
  assert.equal(cancel.kind, 'cancel');
  assert.equal(grantResource('fixture-node', PKG), `ci-resident:fixture-node/${PKG}`);
  assert.throws(() => grantResource('fixture-node', '*'), { code: U.REQUEST_REFUSED });
});

test('journal: create-only records, the resume rule, one open step at most', async t => {
  const root = await tempDir(t);
  const j = await Journal.create(root, OP, Buffer.from('{"requestId":"x"}'), { clock: () => T0 });
  const a = { exists: true, sha256: 'a'.repeat(64) }, b = { exists: true, sha256: 'b'.repeat(64) }, none = { exists: false, sha256: null };
  assert.equal(Journal.recover({ before: { k: a }, planned: { k: { sha256: 'b'.repeat(64) } }, after: { k: b } }), 'replay');
  assert.equal(Journal.recover({ before: { k: a }, planned: { k: { sha256: 'b'.repeat(64) } }, after: { k: a } }), 'redo');
  assert.equal(Journal.recover({ before: { k: a, m: a }, planned: { k: { sha256: 'b'.repeat(64) }, m: { sha256: 'b'.repeat(64) } }, after: { k: b, m: none } }), 'items');
  assert.equal(Journal.recover({ before: { k: a }, planned: { k: { sha256: 'b'.repeat(64) } }, after: { k: { exists: true, sha256: 'c'.repeat(64) } } }), 'inconsistent');
  assert.equal(Journal.recover({ before: {}, planned: {}, after: {} }), 'redo', 'a step that plans no object is done again');
  assert.equal(Journal.recover({ before: { k: none }, planned: { k: { sha256: null } }, after: { k: b } }), 'replay', 'null: must exist');
  const i = await j.intent({ seq: 10, step: 'accept', args: {} });
  await assert.rejects(j.intent({ seq: 10, step: 'accept', args: {} }), { code: 'CREATE_ONLY_TARGET_EXISTS' });
  await assert.rejects(j.intent({ seq: 11, step: 'accept' }), { code: 'UPGRADE_STEP_UNKNOWN' });
  await j.intent({ seq: 20, step: 'grant' });
  await assert.rejects(j.load(), { code: U.JOURNAL_INCONSISTENT, detail: 'two-open-steps' });
  await j.result(i, { ok: true });
  assert.equal((await j.load()).steps.length, 2);
  await assert.rejects(j.result({ ...i, seq: 30, step: 'hold' }, { ok: true, detail: { path: 'C:\\x y' } }), { code: 'UPGRADE_JOURNAL_DETAIL_REFUSED' });
});

test('grant client: only the configured endpoint, the public key, the token hash; answers mapped strictly', async t => {
  const root = await tempDir(t);
  const tokenFile = path.join(root, 't');
  await fs.writeFile(tokenFile, 'fixture-token-not-a-secret-000000\n');
  const resource = `ci-resident:fixture-node/${PKG}`;
  const calls = [];
  const answer = { status: 200, body: { status: 'ok', consumed: false, action: 'ci.resident_upgrade', resources: [resource], owner_request: { request_id: OP, status: 'pending', confirm_path: `/confirm/${OP}`, expires_at: new Date(T0).toISOString() } } };
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { status: answer.status, text: async () => JSON.stringify(answer.body) }; };
  const c = grantClient({ supabaseUrl: 'https://fixture-project.supabase.co', publishableKey: 'sb_publishable_FIXTUREONLY', confirmOrigin: 'https://kooyumi.pixelgrav.com', tokenFile, fetchImpl });
  const r = await c.consume({ opId: OP, resource, note: 'n' });
  assert.deepEqual(r, { kind: 'pending', requestId: OP, status: 'pending', confirmUrl: `https://kooyumi.pixelgrav.com/confirm/${OP}`, expiresAt: new Date(T0).toISOString() });
  assert.equal(calls[0].url, 'https://fixture-project.supabase.co/rest/v1/rpc/clued_owner_grant_door_consume_v1');
  assert.equal(calls[0].init.headers.apikey, 'sb_publishable_FIXTUREONLY');
  assert.equal(calls[0].init.headers.authorization, 'Bearer sb_publishable_FIXTUREONLY');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.p_token_hash, createHash('sha256').update('fixture-token-not-a-secret-000000').digest('hex'));
  assert.deepEqual(body.p_input, { action: 'ci.resident_upgrade', resources: [resource], op_id: OP, note: 'n' });
  assert.ok(!calls[0].init.body.includes('fixture-token'), 'the token itself never leaves');
  const ctx = { resource, origin: 'https://kooyumi.pixelgrav.com' };
  const grant = { grant_id: OP, receipt_id: OP, use: 1, max_uses: 1, expires_at: new Date(T0).toISOString(), replayed: true };
  assert.equal(interpret(200, { status: 'ok', consumed: true, action: 'ci.resident_upgrade', resources: [resource], grant }, ctx).grant.replayed, true);
  assert.equal(interpret(200, { status: 'ok', consumed: true, action: 'ci.resident_upgrade', resources: [`ci-resident:other/${PKG}`], grant }, ctx).kind, 'unavailable', 'another resource is no answer');
  assert.equal(interpret(200, { status: 'ok', consumed: false, action: 'ci.resident_upgrade', resources: [resource], owner_request: { request_id: OP, status: 'rejected' } }, ctx).code, U.GRANT_REJECTED);
  assert.equal(interpret(200, { status: 'ok', consumed: false, action: 'ci.resident_upgrade', resources: [resource], owner_request: { request_id: OP, status: 'expired' } }, ctx).code, U.GRANT_EXPIRED);
  assert.equal(interpret(403, { code: '42501', message: 'owner_grant_door_binding_not_authorized' }, ctx).code, U.GRANT_BINDING_NOT_AUTHORIZED);
  assert.equal(interpret(400, { message: 'owner_grant_door_resources_invalid' }, ctx).code, U.REQUEST_REFUSED);
  assert.equal(interpret(404, { code: 'PGRST202' }, ctx).kind, 'unavailable');
  assert.equal(interpret(200, { status: 'ok', consumed: false, action: 'ci.resident_upgrade', resources: [resource], owner_request: { request_id: OP, status: 'pending', confirm_path: 'https://evil/confirm' } }, ctx).confirmUrl, null);
  const down = grantClient({ supabaseUrl: 'https://fixture-project.supabase.co', publishableKey: 'sb_publishable_FIXTUREONLY', confirmOrigin: 'https://k.example', tokenFile,
    fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal((await down.consume({ opId: OP, resource })).code, U.GRANT_DOOR_UNAVAILABLE);
  await assert.rejects(c.consume({ opId: OP, resource: 'ci-resident:*/x' }), { code: U.REQUEST_REFUSED });
});

test('windows port: fixed argv, one JSON line, exit 0 only on success', async () => {
  assert.deepEqual(applyArgs('C:\\u\\upgrade-apply.ps1', 'SwitchScm', { opId: OP, planSha256: PKG, generation: 3 }).slice(-8),
    ['-Action', 'SwitchScm', '-OpId', OP, '-PlanSha256', PKG, '-Generation', '3']);
  assert.throws(() => applyArgs('x', 'Invoke-Expression', { opId: OP, planSha256: PKG }), { code: 'UPGRADE_APPLY_ARGS_REFUSED' });
  assert.throws(() => applyArgs('x', 'Verify', { opId: OP, planSha256: PKG, expectPausedSha256: 'not-a-sha' }), { code: 'UPGRADE_APPLY_ARGS_REFUSED' });
  assert.deepEqual(parseApplyOutput(0, 'noise\n{"ok":true,"code":null,"resident":{"state":"stopped"}}'), { ok: true, code: null, resident: { state: 'stopped' } });
  assert.equal(parseApplyOutput(1, '{"ok":true}').ok, false);
  assert.equal(parseApplyOutput(0, '{"ok":false,"code":"SCM_SWITCH_FAILED"}').code, 'SCM_SWITCH_FAILED');
  assert.equal(parseApplyOutput(0, 'garbage').code, 'UPGRADE_APPLY_OUTPUT_REFUSED');
  const seen = [];
  const port = new WindowsPort({ upgraderDir: 'C:\\up\\abc', runImpl: async (file, argv) => { seen.push([file, argv]); return { exit: 0, stdout: '{"ok":true}' }; } });
  assert.equal((await port.stopServices({ opId: OP, planSha256: PKG })).ok, true);
  assert.equal(seen[0][0], 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.ok(seen[0][1].includes(path.join('C:\\up\\abc', 'windows', 'upgrade-apply.ps1')));
});

test('resident port: the frozen observation surface and the drop boxes, with the resident contracts', async t => {
  const root = await tempDir(t);
  for (const d of ['requests', 'owner', 'state/ledger/a', 'state/ledger/b', 'state/receipts', 'broker/requests', 'broker/responses', 'mailbox/responses']) await fs.mkdir(path.join(root, d), { recursive: true });
  let now = T0;
  const p = new ResidentPort(root, { clock: () => now });
  await fs.writeFile(path.join(root, 'state', 'ledger', 'b', '90-terminal.json'), '{}');
  assert.equal(await p.openBatches(), 1);
  assert.equal(await p.status(), null);
  await fs.writeFile(path.join(root, 'state', 'status.json'), JSON.stringify({ writtenAt: new Date(T0).toISOString(), executor: { state: 'HALTED' }, current: null, node: { probe: { at: new Date(T0).toISOString() } } }));
  assert.deepEqual(await p.status(), { writtenAt: T0, executorState: 'HALTED', current: false, probeAt: T0 });
  assert.equal(await p.halted(), true);
  // The hold: one request, renewed only after 30 minutes; the lift names the same holder.
  assert.equal(await p.hold(OP), true);
  assert.equal(await p.hold(OP), false);
  now += 31 * 60_000;
  assert.equal(await p.hold(OP), true);
  await p.liftHold(OP);
  const reqs = await fs.readdir(path.join(root, 'requests'));
  assert.equal(reqs.length, 3);
  for (const n of reqs) {
    assert.match(n, /^[0-9]{13}-[0-9a-f]{12}\.json$/);
    const v = validateIntakeRequest(JSON.parse(await fs.readFile(path.join(root, 'requests', n), 'utf8')));
    assert.equal(v.holder, 'resident-upgrade');
  }
  // The pause request: exact bytes, create-only; withdrawn by rename; PAUSED.json read by its raw bytes.
  const bytes = pauseRequestBytes(OP, 50);
  assert.deepEqual(JSON.parse(bytes), { contract: 'clued.independent-ci.resident-pause/1', reason: `resident-upgrade ${OP} 50` });
  assert.equal(await p.requestPause('0000000000001-aaaaaaaaaaaa.json', bytes), true);
  assert.equal(await p.requestPause('0000000000001-aaaaaaaaaaaa.json', bytes), false);
  assert.equal(await p.pauseRequestPending('0000000000001-aaaaaaaaaaaa.json'), true);
  assert.equal(await p.withdrawPause('0000000000001-aaaaaaaaaaaa.json', path.join(root, 'withdrawn.json')), true);
  assert.equal(await p.pauseRequestPending('0000000000001-aaaaaaaaaaaa.json'), false);
  const paused = Buffer.from(JSON.stringify({ source: { reason: 'r', requestSha256: sha256(bytes) }, at: 'x' }));
  await fs.writeFile(path.join(root, 'state', 'PAUSED.json'), paused);
  assert.deepEqual(await p.pauseState(), { sha256: sha256(paused), requestSha256: sha256(bytes) });
  // Receipts: names, and the bodies of the three frozen types only.
  const receipt = (seq, type, body) => fs.writeFile(path.join(root, 'state', 'receipts', `${String(seq).padStart(8, '0')}-${type}.json`), JSON.stringify({ body }));
  await receipt(1, 'service-start', { policySha256: PKG, generation: 1 });
  await receipt(2, 'train-run-intent', {});
  await receipt(3, 'paused', { reason: 'x' });
  assert.equal(await p.receiptHead(), 3);
  assert.equal(await p.trainOpen(), true);
  assert.deepEqual((await p.receiptsSince(1)).map(r => r.type), ['train-run-intent']);
  await receipt(4, 'train-run', {});
  assert.equal(await p.trainOpen(), false);
  await fs.writeFile(path.join(root, 'broker', 'requests', 'r1.json'), '{}');
  assert.equal(await p.brokerPending(), 1);
  await fs.writeFile(path.join(root, 'mailbox', 'responses', 'heartbeat.json'), JSON.stringify({ contract: 'x', at: T0 }));
  assert.equal(await p.companionHeartbeat(), T0);
  await p.requestUpgradeResume({ pausedSha256: sha256(paused), opId: OP, generation: 2 });
  const [ownerFile] = await fs.readdir(path.join(root, 'owner'));
  validateUpgradeResume(JSON.parse(await fs.readFile(path.join(root, 'owner', ownerFile), 'utf8')));
});

test('linux port: through the upgrade mailbox; a resumed call finds its own request; no answer is COMPANION_UNAVAILABLE', async t => {
  const root = await tempDir(t);
  let now = T0;
  const sleeps = [];
  const port = await LinuxPort.open(path.join(root, 'mailbox'), { clock: () => now, sleep: async ms => { sleeps.push(ms); await new Promise(r => setTimeout(r, 5)); now += ms; }, pollMs: 10_000 });
  const companion = new UpgradeMailbox(path.join(root, 'mailbox'), () => now);
  // A companion that answers every pending request once, from a fake tool run.
  const answerAll = async () => { for (const r of await companion.pending()) if (!r.refused) await companion.respond(r, { ok: true, tool: { exit: 0, status: 'switched' }, result: { status: 'switched' } }); };
  const call = port.switch({ opId: OP, fromGeneration: 1, toGeneration: 2, linuxManifestSha256: PKG }, 80);
  await new Promise(r => setTimeout(r, 50));
  await answerAll();
  const r = await call;
  assert.equal(r.ok, true);
  // Again with the same key: the same request, already answered (no second request file).
  const again = await port.switch({ opId: OP, fromGeneration: 1, toGeneration: 2, linuxManifestSha256: PKG }, 80);
  assert.equal(again.requestId, r.requestId);
  assert.equal((await fs.readdir(path.join(root, 'mailbox', 'requests'))).length, 1);
  // Nobody answers: after the 5 minute deadline, unavailable.
  const lost = await port.verify({ opId: OP, generation: 2 }, 100);
  assert.equal(lost.code, U.COMPANION_UNAVAILABLE);
  assert.ok(sleeps.length > 0);
  // A refusal carries the tool's own code.
  const stage = port.stage({ opId: OP, packageManifestSha256: PKG, generation: 2, linuxManifestSha256: PKG }, 65);
  await new Promise(r2 => setTimeout(r2, 50));
  for (const req of await companion.pending()) if (req.kind === 'linux-upgrade-stage') {
    const resp = responseFromTool(req, { exit: 3, stdout: '{"status":"refused","code":"UPGRADE_LINUX_STAGE_REFUSED"}' }, () => now);
    await fs.writeFile(path.join(root, 'mailbox', 'responses', `${req.requestId}.json`), canonicalJson(resp));
  }
  assert.equal((await stage).code, U.LINUX_STAGE_REFUSED);
});

test('package: read once, every byte hashed; links, a changed file and a non-canonical manifest are refused', async t => {
  const dir = await tempDir(t);
  const pkg = await buildTestPackage(path.join(dir, 'p'), { tag: 'n2' });
  const read = await readPackageOnce(pkg.dir, pkg.sha);
  assert.equal(read.manifest.contract, 'clued.independent-ci.resident-package/4');
  assert.ok(read.bytesByPath.size > 10);
  await assert.rejects(readPackageOnce(pkg.dir, 'cd'.repeat(32)), { code: U.PACKAGE_CHANGED });
  await assert.rejects(readPackageOnce('\\\\server\\share\\p', pkg.sha), { code: U.PACKAGE_UNREADABLE });
  await fs.writeFile(path.join(pkg.dir, 'config', 'companion.json'), 'changed');
  await assert.rejects(readPackageOnce(pkg.dir, pkg.sha), { code: U.PACKAGE_CHANGED });
  const pkg2 = await buildTestPackage(path.join(dir, 'q'), { tag: 'n2' });
  const pretty = Buffer.from(JSON.stringify(pkg2.manifest, null, 2));
  await fs.writeFile(path.join(pkg2.dir, 'package-manifest.json'), pretty);
  await assert.rejects(readPackageOnce(pkg2.dir, sha256(pretty)), { code: U.PACKAGE_CONTRACT_REFUSED });
  const pkg3 = await buildTestPackage(path.join(dir, 'r'), { tag: 'n2' });
  try {
    await fs.symlink(path.join(pkg3.dir, 'config'), path.join(dir, 'link'), 'junction');
    await fs.rm(path.join(pkg3.dir, 'record'), { recursive: true });
    await fs.symlink(path.join(pkg.dir, 'record'), path.join(pkg3.dir, 'record'), 'junction');
    await assert.rejects(readPackageOnce(pkg3.dir, pkg3.sha), { code: U.PACKAGE_UNREADABLE });
  } catch (error) {
    if (error.code !== 'EPERM') throw error; // no right to make links here: nothing to test
  }
});

test('package: twenty files of 1 MiB and more are read whole, each with a buffer of its own size', async t => {
  const dir = await tempDir(t);
  const big = await buildTestPackage(path.join(dir, 'big'), { tag: 'n2', mutate: (m, f, put) => {
    for (let i = 0; i < 20; i += 1) {
      const bytes = Buffer.alloc(1024 * 1024 + i * 4096, i + 1);
      put(`source/big/blob-${i}.bin`, bytes);
      m.files.push({ path: `source/big/blob-${i}.bin`, target: ['source', m.ciSourceManifestSha256, 'big', `blob-${i}.bin`].join('\\'), sha256: sha256(bytes) });
    }
  } });
  const heapBefore = process.memoryUsage().arrayBuffers;
  const read = await readPackageOnce(big.dir, big.sha);
  let total = 0;
  for (let i = 0; i < 20; i += 1) {
    const b = read.bytesByPath.get(`source/big/blob-${i}.bin`);
    assert.equal(b.length, 1024 * 1024 + i * 4096);
    assert.equal(b.buffer.byteLength <= b.length + 8192, true, 'no oversized backing buffer is kept');
    total += b.length;
  }
  assert.ok(process.memoryUsage().arrayBuffers - heapBefore < total * 3, 'memory stays near the package size');
  // A file that grows between fstat and the end of the read is refused (simulated by a size mismatch on a second read).
  const { readFileOnce } = await import('../src/package.mjs');
  await assert.rejects(readFileOnce(path.join(big.dir, 'source', 'big', 'blob-0.bin'), 1024), { code: U.PACKAGE_UNREADABLE, detail: 'size' });
});
