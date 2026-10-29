import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tempRoot } from './helpers.mjs';
import { UUID } from '../src/canonical.mjs';
import {
  UPGRADE_KINDS, UPGRADE_TIMEOUT_MS, UPGRADE_MAILBOX_RESPONSE_CONTRACT, LINUX_VERSION_FACTS_CONTRACT, GENERATION_CURRENT_CONTRACT, UPGRADE_STATUS_CONTRACT,
  VERSION_FACTS_MAX_AGE_MS, UpgradeMailbox, consistent, derivedRequestId, parseUpgradeStatus, responseFromTool, upgradeMailboxRequest, upgradeResumeRequest,
  upgradeToolArgs, validateGenerationCurrent, validateUpgradeArgs, validateUpgradeRequest, validateUpgradeResponse, validateUpgradeResume, validateVersionFacts,
} from '../src/upgrade-mailbox.mjs';

const OP = '11111111-2222-4333-8444-555555555555';
const H = c => c.repeat(64);
const T0 = Date.parse('2026-10-29T10:00:00.000Z');
const clockAt = ms => () => ms;

const facts = (over = {}) => ({ contract: LINUX_VERSION_FACTS_CONTRACT, generation: 3, ciSourceManifestSha256: H('c'), sourceCommit: '1'.repeat(40), manifestSha256: H('d'),
  roles: { gitleaks: { policySha256: H('1'), qualificationSha256: H('2') }, trivy: { policySha256: H('3'), qualificationSha256: H('4') } },
  pinsOk: true, staged: null, upgradeToolSha256: H('9'), observedAt: new Date(T0).toISOString(), ...over });
const current = (over = {}) => ({ contract: GENERATION_CURRENT_CONTRACT, generation: 3, packageManifestSha256: H('a'), residentManifestSha256: H('b'), ciSourceManifestSha256: H('c'),
  policySha256: H('e'), installReceiptSha256: H('f'), stateCompat: { schema: 1, readableBySchemas: [1] }, linux: { generation: 3, manifestSha256: H('d'), ciSourceManifestSha256: H('c') },
  opId: null, at: new Date(T0).toISOString(), ...over });

const ARGS = {
  'linux-version-facts': {},
  'linux-upgrade-stage': { packageManifestSha256: H('a'), generation: 4, linuxManifestSha256: H('d') },
  'linux-upgrade-switch': { fromGeneration: 3, toGeneration: 4, linuxManifestSha256: H('d') },
  'linux-upgrade-rollback': { fromGeneration: 4, toGeneration: 3 },
  'linux-upgrade-verify': { generation: 4 },
};

test('every kind has exact arguments, a fixed timeout and fixed tool argv', () => {
  assert.deepEqual(UPGRADE_KINDS, Object.keys(ARGS));
  assert.deepEqual(Object.values(UPGRADE_TIMEOUT_MS), [60_000, 1_200_000, 300_000, 300_000, 300_000]);
  for (const kind of UPGRADE_KINDS) {
    const r = upgradeMailboxRequest({ kind, opId: kind === 'linux-version-facts' ? null : OP, args: ARGS[kind] }, clockAt(T0));
    assert.equal(Date.parse(r.deadline) - Date.parse(r.createdAt), UPGRADE_TIMEOUT_MS[kind]);
    assert.ok(UUID.test(r.requestId));
    const argv = upgradeToolArgs(r);
    assert.ok(argv.every(a => typeof a === 'string' && !a.includes(' ') && !a.includes('/')), kind);
  }
  assert.deepEqual(upgradeToolArgs(upgradeMailboxRequest({ kind: 'linux-upgrade-switch', opId: OP, args: ARGS['linux-upgrade-switch'] }, clockAt(T0))),
    ['switch', '--op', OP, '--from', '3', '--to', '4', '--linux-manifest', H('d')]);
  // Wrong or extra arguments, a path smuggled in, generations out of order.
  assert.throws(() => validateUpgradeArgs('linux-version-facts', { x: 1 }), { code: 'UPGRADE_MAILBOX_ARGS_REFUSED' });
  assert.throws(() => validateUpgradeArgs('linux-upgrade-stage', { ...ARGS['linux-upgrade-stage'], path: '/etc' }), { code: 'UPGRADE_MAILBOX_ARGS_REFUSED' });
  assert.throws(() => validateUpgradeArgs('linux-upgrade-stage', { ...ARGS['linux-upgrade-stage'], generation: 1 }), { code: 'UPGRADE_MAILBOX_ARGS_REFUSED' });
  assert.throws(() => validateUpgradeArgs('linux-upgrade-switch', { ...ARGS['linux-upgrade-switch'], toGeneration: 5 }), { code: 'UPGRADE_MAILBOX_ARGS_REFUSED' });
  assert.throws(() => validateUpgradeArgs('linux-upgrade-rollback', { fromGeneration: 3, toGeneration: 4 }), { code: 'UPGRADE_MAILBOX_ARGS_REFUSED' });
  assert.throws(() => validateUpgradeArgs('linux-upgrade-verify', { generation: '4' }), { code: 'UPGRADE_MAILBOX_ARGS_REFUSED' });
  assert.throws(() => validateUpgradeArgs('linux-upgrade-shell', {}), { code: 'UPGRADE_MAILBOX_KIND_REFUSED' });
});

test('requests are refused for a long deadline, a missing op, extra keys or another contract', () => {
  const ok = upgradeMailboxRequest({ kind: 'linux-upgrade-verify', opId: OP, args: { generation: 4 } }, clockAt(T0));
  assert.throws(() => validateUpgradeRequest({ ...ok, deadline: new Date(T0 + 300_001).toISOString() }), { code: 'UPGRADE_MAILBOX_REQUEST_TIME_REFUSED' });
  assert.throws(() => validateUpgradeRequest({ ...ok, deadline: ok.createdAt }), { code: 'UPGRADE_MAILBOX_REQUEST_TIME_REFUSED' });
  assert.throws(() => validateUpgradeRequest({ ...ok, opId: null }), { code: 'UPGRADE_MAILBOX_REQUEST_OP_REFUSED' });
  assert.throws(() => validateUpgradeRequest({ ...ok, batchId: 'x' }), { code: 'UPGRADE_MAILBOX_REQUEST_KEYS_REFUSED' });
  assert.throws(() => validateUpgradeRequest({ ...ok, contract: 'clued.independent-ci.upgrade-mailbox-request/2' }), { code: 'UPGRADE_MAILBOX_REQUEST_IDENTITY_REFUSED' });
  assert.throws(() => validateUpgradeRequest({ ...ok, kind: 'relay-stage' }), { code: 'UPGRADE_MAILBOX_REQUEST_KIND_REFUSED' });
  // The facts may be asked outside an operation, or inside one.
  validateUpgradeRequest(upgradeMailboxRequest({ kind: 'linux-version-facts', opId: OP }, clockAt(T0)));
});

test('responses: success only with exit 0 and a JSON result; refusals carry a code; the facts answer is a valid facts record', () => {
  const r = upgradeMailboxRequest({ kind: 'linux-upgrade-switch', opId: OP, args: ARGS['linux-upgrade-switch'] }, clockAt(T0));
  const base = { contract: UPGRADE_MAILBOX_RESPONSE_CONTRACT, requestId: r.requestId, kind: r.kind, observedAt: new Date(T0).toISOString() };
  validateUpgradeResponse({ ...base, ok: true, code: null, tool: { exit: 0, status: 'switched' }, result: { status: 'switched' } }, r);
  validateUpgradeResponse({ ...base, ok: false, code: 'UPGRADE_LINUX_QUIESCENCE_UNCONFIRMED', tool: { exit: 3, status: null }, result: null }, r);
  assert.throws(() => validateUpgradeResponse({ ...base, ok: true, code: null, tool: { exit: 1, status: null }, result: {} }, r), { code: 'UPGRADE_MAILBOX_RESPONSE_TOOL_REFUSED' });
  assert.throws(() => validateUpgradeResponse({ ...base, ok: false, code: 'X_Y', tool: { exit: 0, status: null }, result: null }, r), { code: 'UPGRADE_MAILBOX_RESPONSE_TOOL_REFUSED' });
  assert.throws(() => validateUpgradeResponse({ ...base, ok: false, code: null, tool: { exit: 1, status: null }, result: null }, r), { code: 'UPGRADE_MAILBOX_RESPONSE_STATUS_REFUSED' });
  assert.throws(() => validateUpgradeResponse({ ...base, ok: true, code: null, tool: { exit: 0, status: null }, result: { big: 'x'.repeat(70_000) } }, r), { code: 'UPGRADE_MAILBOX_RESPONSE_RESULT_REFUSED' });
  assert.throws(() => validateUpgradeResponse({ ...base, requestId: OP, ok: true, code: null, tool: { exit: 0, status: null }, result: {} }, r), { code: 'UPGRADE_MAILBOX_RESPONSE_IDENTITY_REFUSED' });
  const f = upgradeMailboxRequest({ kind: 'linux-version-facts' }, clockAt(T0));
  assert.throws(() => validateUpgradeResponse({ ...base, requestId: f.requestId, kind: f.kind, ok: true, code: null, tool: { exit: 0, status: null }, result: { generation: 3 } }, f),
    { code: 'LINUX_VERSION_FACTS_REFUSED' });
});

test('the companion maps a tool run to an answer: its own code, its JSON, or a fixed code', () => {
  const r = upgradeMailboxRequest({ kind: 'linux-upgrade-stage', opId: OP, args: ARGS['linux-upgrade-stage'] }, clockAt(T0));
  const ok = responseFromTool(r, { exit: 0, stdout: 'noise\n{"status":"staged","generation":4}\n' }, clockAt(T0));
  assert.equal(ok.ok, true); assert.deepEqual(ok.result, { status: 'staged', generation: 4 }); assert.deepEqual(ok.tool, { exit: 0, status: 'staged' });
  const refused = responseFromTool(r, { exit: 2, stdout: '{"status":"refused","code":"UPGRADE_LINUX_STAGE_REFUSED"}' }, clockAt(T0));
  assert.equal(refused.ok, false); assert.equal(refused.code, 'UPGRADE_LINUX_STAGE_REFUSED');
  assert.equal(responseFromTool(r, { exit: 0, stdout: 'not json' }, clockAt(T0)).code, 'UPGRADE_LINUX_TOOL_OUTPUT_REFUSED');
  assert.equal(responseFromTool(r, { exit: 7, stdout: '' }, clockAt(T0)).code, 'UPGRADE_LINUX_TOOL_FAILED');
  assert.equal(responseFromTool(r, { exit: null, stdout: '' }, clockAt(T0)).code, 'UPGRADE_LINUX_TOOL_NOT_RUN');
  const f = upgradeMailboxRequest({ kind: 'linux-version-facts' }, clockAt(T0));
  assert.equal(responseFromTool(f, { exit: 0, stdout: '{"generation":3}' }, clockAt(T0)).code, 'UPGRADE_LINUX_TOOL_OUTPUT_REFUSED');
  assert.equal(responseFromTool(f, { exit: 0, stdout: JSON.stringify(facts()) }, clockAt(T0)).ok, true);
});

test('consistent(current, facts): true, false on each mismatch, null when unknown or older than 15 minutes', () => {
  assert.equal(consistent(current(), facts(), T0), true);
  assert.equal(consistent(current(), facts({ generation: 2 }), T0), false);
  assert.equal(consistent(current(), facts({ generation: null }), T0), false);
  assert.equal(consistent(current(), facts({ ciSourceManifestSha256: H('0') }), T0), false);
  assert.equal(consistent(current(), facts({ manifestSha256: H('0') }), T0), false);
  assert.equal(consistent(current(), facts({ pinsOk: false }), T0), false);
  assert.equal(consistent(current(), facts(), T0 + VERSION_FACTS_MAX_AGE_MS), true);
  assert.equal(consistent(current(), facts(), T0 + VERSION_FACTS_MAX_AGE_MS + 1), null);
  assert.equal(consistent(current(), facts(), T0 - 6 * 60_000), null, 'dated ahead');
  assert.equal(consistent(null, facts(), T0), null);
  assert.equal(consistent(current(), null, T0), null);
  assert.equal(consistent(current({ linux: null }), facts(), T0), null);
  assert.equal(consistent(current(), { ...facts(), extra: 1 }, T0), null);
  assert.throws(() => validateVersionFacts(facts({ roles: { 'Bad Role': { policySha256: H('1'), qualificationSha256: H('2') } } })), { code: 'LINUX_VERSION_FACTS_REFUSED' });
  validateVersionFacts(facts({ staged: { opId: OP, generation: 4 } }));
  assert.throws(() => validateGenerationCurrent(current({ stateCompat: { schema: 1, readableBySchemas: [] } })), { code: 'GENERATION_CURRENT_REFUSED' });
});

test('the mailbox: send, pending, respond, poll; version facts are replaced whole', async t => {
  const root = await tempRoot(t);
  let now = T0;
  const box = await UpgradeMailbox.open(path.join(root, 'mailbox'), () => now);
  const id = derivedRequestId(OP, 80, 0);
  assert.ok(UUID.test(id)); assert.equal(id, derivedRequestId(OP, 80, 0)); assert.notEqual(id, derivedRequestId(OP, 80, 1));
  const r = await box.send({ kind: 'linux-upgrade-switch', opId: OP, args: ARGS['linux-upgrade-switch'], requestId: id });
  assert.deepEqual(await box.request(id), r);
  await assert.rejects(box.send({ kind: 'linux-upgrade-switch', opId: OP, args: ARGS['linux-upgrade-switch'], requestId: id }), { code: 'CREATE_ONLY_TARGET_EXISTS' });
  assert.equal(await box.poll(r), null);
  await fs.writeFile(path.join(box.requests, '00000000-0000-4000-8000-000000000000.json'), '{"contract":"x"}');
  const pending = await box.pending();
  assert.equal(pending.length, 2);
  assert.ok(pending.some(p => p.refused === true));
  const req = pending.find(p => !p.refused);
  await box.respond(req, { ok: true, tool: { exit: 0, status: 'switched' }, result: { status: 'switched' } });
  assert.equal((await box.poll(r)).ok, true);
  assert.equal((await box.pending()).filter(p => !p.refused).length, 0);
  // An unfinished response is no answer yet.
  const r2 = await box.send({ kind: 'linux-upgrade-verify', opId: OP, args: { generation: 4 } });
  await fs.writeFile(path.join(box.responses, `${r2.requestId}.json`), '{"contract":');
  assert.equal(await box.poll(r2), null);
  now = T0 + 300_001;
  assert.equal(await box.await(r2, async () => {}), null);
  assert.equal(await box.readVersionFacts(), null);
  await box.writeVersionFacts(facts());
  await box.writeVersionFacts(facts({ generation: 4 }));
  assert.equal((await box.readVersionFacts()).generation, 4);
  assert.deepEqual((await fs.readdir(box.responses)).filter(n => n.startsWith('.tmp-')), []);
  await assert.rejects(box.writeVersionFacts({ ...facts(), pinsOk: 'yes' }), { code: 'LINUX_VERSION_FACTS_REFUSED' });
});

test('upgrade-resume request and the lenient upgrade status reader', () => {
  const v = upgradeResumeRequest({ pausedSha256: H('7'), opId: OP, generation: 4 }, clockAt(T0));
  assert.equal(validateUpgradeResume(v), v);
  assert.throws(() => validateUpgradeResume({ ...v, by: 'S-1' }), { code: 'OWNER_REQUEST_REFUSED' });
  assert.throws(() => validateUpgradeResume({ ...v, generation: 0 }), { code: 'OWNER_REQUEST_REFUSED' });
  const status = { contract: UPGRADE_STATUS_CONTRACT, writtenAt: new Date(T0).toISOString(), upgraderPid: 1, current: { generation: 3, packageManifestSha256: H('a') },
    op: { opId: OP, state: 'WAITING_GRANT', phase: 'grant', phaseSince: new Date(T0).toISOString(), code: null, grant: { confirmUrl: `https://kooyumi.pixelgrav.com/confirm/${OP}` }, pausedBy: null },
    recent: [], generations: [] };
  const parsed = parseUpgradeStatus(Buffer.from(JSON.stringify(status)));
  assert.equal(parsed.op.confirmUrl, `https://kooyumi.pixelgrav.com/confirm/${OP}`);
  assert.equal(parsed.current.generation, 3);
  const bad = parseUpgradeStatus(Buffer.from(JSON.stringify({ ...status, op: { ...status.op, grant: { confirmUrl: 'javascript:alert(1)' }, state: 'BOGUS' } })));
  assert.equal(bad.op, null);
  assert.throws(() => parseUpgradeStatus(Buffer.from('{"contract":"x"}')), { code: 'UPGRADE_STATUS_REFUSED' });
});
