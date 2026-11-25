// Drill r13, A2 (task 87d330d0; drill-r13-fail.result.md section 1): a first install ends with the pause its launcher confirmed (Fable
// renew-key ruling 11-19, section 1 item 5; A6 holds it), but the drill's read ran verify-resident.ps1 without -ExpectPausedSha256, so
// verify checked 'not-paused' and A2 could never pass next to A6. And only the last 40 lines of verify's stdout came back: the fifty
// checks before not-halted were never seen. Here, against a stand-in verify that keeps the real rule on the pause (FAKE_VERIFY):
//   - the read hands verify the sha256 of the PAUSED.json the launcher's terminal confirmed (pause.paused.sha256), read from that object
//   - a pause other than that one fails verify (paused-as-expected)
//   - no confirmed pause in the launcher's terminal is never judged by "not paused": A2 fails and says the expectation was unreadable
//   - every check verify failed, with its detail, is in the read-back (verify.failed), wherever it sits in verify's output
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmp, sha, q, ps, opts, PAUSE_REQUEST, FAKE_VERIFY, evidence, verdictOf, pass } from './drill-vm-fixtures.mjs';

// A guest root as the read finds it after a first install: the pointer, the receipt, the status, the pause the node holds.
function guestRoot(name, { extraChecks = null } = {}) {
  const root = path.join(tmp, name);
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  put('upgrade/current.json', JSON.stringify({ residentManifestSha256: 'abc' }));
  put('install/install-receipt.json', '{}');
  put('state/status.json', JSON.stringify({ paused: true }));
  const pausedText = JSON.stringify({ source: { requestSha256: PAUSE_REQUEST, reason: 'hold-after-install' } });
  put('state/PAUSED.json', pausedText);
  put('resident/abc/windows/verify-resident.ps1', FAKE_VERIFY);
  if (extraChecks) put('fake-verify-checks.json', JSON.stringify(extraChecks));
  return { root, pausedSha: sha(pausedText) };
}
const read = (root, expect) => ps(`$ErrorActionPreference = 'Stop'; $g = & $script:GuestRead ${q(root)} $script:DrillNativeText ${expect ? q(expect) : '$null'}
  [ordered]@{ status = $g.verify.status; exit = $g.verify.exit; expect = $g.verify.expectPausedSha256; failed = @($g.verify.failed); checksRead = $g.verify.checksRead
    tail = @($g.verify.tail); stderr = ([string]$g.verify.stderr).Trim() }`);

test('the read hands verify the pause the launcher confirmed: a node holding it verifies, another pause does not', opts, () => {
  const { root, pausedSha } = guestRoot('r13-a2-held');
  const held = read(root, pausedSha);
  assert.deepEqual([held.status, held.exit, held.expect, held.failed, held.checksRead], ['RESIDENT_VERIFIED', 0, pausedSha, [], true]);
  assert.equal(held.stderr, 'verify: a note on stderr');

  const other = read(root, '8'.repeat(64));
  assert.equal(other.status, 'RESIDENT_VERIFICATION_FAILED');
  assert.deepEqual(other.failed.map((f) => f.name), ['paused-as-expected']);

  // no expectation given (the launcher's terminal showed none): verify runs on its own rule and the read says nothing was expected
  const none = read(root, null);
  assert.equal(none.status, 'RESIDENT_VERIFICATION_FAILED');
  assert.equal(none.expect, null);
  assert.deepEqual(none.failed.map((f) => f.name), ['not-paused']);
});

test('every check verify failed reaches the read-back with its detail, beyond the last 40 lines of its stdout', opts, () => {
  const extra = { 'companion-start-task': { ok: false, detail: 'COMPANION_START_TASK_MISSING' } };
  for (let i = 0; i < 50; i++) extra[`filler-${String(i).padStart(2, '0')}`] = { ok: true, detail: null };
  extra['companion-facts'] = { ok: false, detail: { missing: ['gh-config'], at: 'x' } };
  extra['receipt-chain'] = { ok: false, detail: 'r'.repeat(2000) };
  extra['upgrader-service'] = { ok: 'unreadable', detail: '' };
  const { root, pausedSha } = guestRoot('r13-a2-failed', { extraChecks: extra });
  const g = read(root, pausedSha);
  assert.equal(g.status, 'RESIDENT_VERIFICATION_FAILED');
  assert.equal(g.checksRead, true);
  assert.deepEqual(g.failed.map((f) => [f.name, f.ok]), [['companion-start-task', false], ['companion-facts', false], ['receipt-chain', false], ['upgrader-service', 'unreadable']]);
  assert.equal(g.failed[0].detail, 'COMPANION_START_TASK_MISSING');
  assert.deepEqual(JSON.parse(g.failed[1].detail), { missing: ['gh-config'], at: 'x' }, 'an object detail kept as compact JSON');
  assert.ok(g.failed[2].detail.length <= 300 && g.failed[2].detail.startsWith('rrrr'), 'a long detail is cut to the bound');
  assert.equal(g.tail.length, 40, 'the tail is still kept');
  assert.equal(g.tail.some((l) => l.includes('companion-start-task')), false, 'the first check is beyond the tail: only verify.failed shows it');
});

test('A2 passes only on a verify run against the pause the launcher confirmed; it names what failed', opts, () => {
  const e = JSON.parse(evidence());
  const a2 = (over) => { const r = verdictOf(evidence(over)); return { pass: pass(r).A2, detail: r.items.find((i) => i.id === 'A2').detail }; };
  const ok = a2({});
  assert.equal(ok.pass, true, ok.detail);

  // r13: verify said RESIDENT_VERIFIED but was never told the node is meant to be paused
  const unexpected = a2({ verify: { status: 'RESIDENT_VERIFIED' } });
  assert.equal(unexpected.pass, false, unexpected.detail);
  assert.match(unexpected.detail, /verifiedAgainst=none/);
  assert.equal(a2({ verify: { ...e.verify, expectPausedSha256: '8'.repeat(64) } }).pass, false, 'run against another pause');

  // the launcher's terminal shows no confirmed pause: never judged by "not paused"
  for (const [reason, launcher] of [
    ['not confirmed', { ...e.launcher, pause: { ...e.launcher.pause, confirmed: false } }],
    ['no PAUSED.json read', { ...e.launcher, pause: { ...e.launcher.pause, paused: null } }],
    ['no launcher result', null],
  ]) {
    const r = a2({ launcher, verify: { status: 'RESIDENT_VERIFIED', expectPausedSha256: null, failed: [] } });
    assert.equal(r.pass, false, reason);
    assert.match(r.detail, /expectPaused=UNREADABLE_FROM_LAUNCHER/, reason);
  }

  const failed = a2({ verify: { ...e.verify, status: 'RESIDENT_VERIFICATION_FAILED',
    failed: [{ name: 'companion-start-task', ok: false, detail: 'X' }, { name: 'paused-as-expected', ok: false, detail: null }] } });
  assert.equal(failed.pass, false);
  assert.match(failed.detail, /failed=companion-start-task,paused-as-expected/);
});
