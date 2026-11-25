// drill/drill-vm.ps1 -Finalize opens the Owner's acceptance request (PLAN-accept-auto-seal-20261125.md 2.1, piece C): a candidate
// receipt that -Finalize judges PASS goes on to one `rollout/fleet/accept.mjs open` (one seal call, no wait), and the confirm link is in
// -Finalize's answer. A receipt that does not end PASS opens nothing and carries no link. Opening is an auxiliary step: whatever it
// answers, the conclusion and the receipt are what the read-back made them. Under the test marker the real opener is never run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RENEWAL_3BC571A6, m5DrillReceipt, notTheDrillsSource, opts, ps, psCode, q, readbackFor, tmp } from './drill-vm-fixtures.mjs';

const CONFIRM = 'https://clued.example/confirm/7c1e0a92';
const ACCEPT = fileURLToPath(new URL('../rollout/fleet/accept.mjs', import.meta.url));
const WAITING = JSON.stringify({ status: 'FLEET_ACCEPTANCE_WAITING_OWNER', confirmUrl: CONFIRM, expiresAt: '2026-11-26T03:00:00Z' });

// -Finalize through Invoke-DrillMain (dot-sourced, so the opener can be the test's): the answer, the receipt as written, the opener's calls.
//   opener  the stand-in's stdout and exit (null: none injected, the real path under the marker)
function finalizeWith(name, receipt, { row = notTheDrillsSource(), request = 'given', opener = { exit: 0, stdout: WAITING } } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, `${name}-`));
  const receiptFile = path.join(dir, 'receipt.json'), readback = path.join(dir, 'readback.json'), calls = path.join(dir, 'opener-calls.txt');
  const requestFile = path.join(dir, 'fleet-node-1.2.3.acceptance-request.json');
  fs.writeFileSync(receiptFile, JSON.stringify(receipt));
  fs.writeFileSync(readback, JSON.stringify(readbackFor(row, receipt.startedAt)));
  fs.writeFileSync(requestFile, '{}');
  const inject = opener === null ? '' : `$script:DrillAcceptanceOpener = { param($Node, $Arguments)
      $finalized = [bool]((Get-Content -Raw -LiteralPath ${q(receiptFile)} | ConvertFrom-Json).PSObject.Properties['finalizedAt'])
      [IO.File]::AppendAllText(${q(calls)}, (@($Arguments) -join '|') + '|finalizedBefore=' + $finalized + "\`n")
      @{ exit = ${opener.exit}; stdout = ${q(opener.stdout)}; stderr = '' } };`;
  const out = ps(`${inject} $Finalize = ${q(receiptFile)}; $ProductionReadback = ${q(readback)}; ${request === 'given' ? `$Request = ${q(requestFile)};` : request === 'none' ? '' : `$Request = ${request};`} Invoke-DrillMain`);
  return { out, receiptFile, requestFile, receipt: JSON.parse(fs.readFileSync(receiptFile, 'utf8')),
    calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : [] };
}
const candidate = name => m5DrillReceipt(name, RENEWAL_3BC571A6, { checker: 'PASS', missing: [], candidate: true });

test('-Finalize of a candidate that ends PASS opens the acceptance request once, after the receipt is final, and returns the link', opts, () => {
  const r = finalizeWith('accept-pass', candidate('accept-pass-run'));
  assert.equal(r.out.status, 'DRILL_FINALIZED');
  assert.equal(r.out.conclusion, 'PASS_A_PER_NODE_STEPS_REMAIN');
  assert.equal(r.out.acceptance.status, 'FLEET_ACCEPTANCE_WAITING_OWNER');
  assert.equal(r.out.acceptance.confirmUrl, CONFIRM);
  assert.equal(r.out.acceptance.expiresAt, '2026-11-26T03:00:00Z');
  assert.deepEqual(r.calls, [[ACCEPT, 'open', '--request', r.requestFile, '--drill-receipt', r.receiptFile].join('|') + '|finalizedBefore=True'],
    'accept.mjs open with this request and this (already final) receipt, once');
  assert.equal(r.receipt.conclusion, 'PASS_A_PER_NODE_STEPS_REMAIN');
});

test('-Finalize of a candidate that ends FAIL opens nothing and carries no link; the conclusion is the read-back\'s', opts, () => {
  const r = finalizeWith('accept-fail', candidate('accept-fail-run'), { row: { ...notTheDrillsSource(), bindings_created: 1 } });
  assert.equal(r.out.status, 'DRILL_FINALIZED');
  assert.equal(r.out.conclusion, 'FAIL');
  assert.ok(!Object.hasOwn(r.out, 'acceptance'), JSON.stringify(r.out));
  assert.deepEqual(r.calls, []);
  assert.equal(r.receipt.conclusion, 'FAIL');
});

test('opening the request is auxiliary: a refused or broken opener leaves the PASS and the receipt as they are, and says why it is not open', opts, () => {
  for (const [name, opener, code] of [['accept-refused', { exit: 1, stdout: JSON.stringify({ status: 'ROLLOUT_REFUSED', code: 'SEAL_DRILL_RECEIPT_NOT_THIS_PACKAGE' }) }, 'SEAL_DRILL_RECEIPT_NOT_THIS_PACKAGE'],
    ['accept-garbage', { exit: 0, stdout: 'not json' }, 'DRILL_ACCEPTANCE_OPEN_FAILED']]) {
    const r = finalizeWith(name, candidate(`${name}-run`), { opener });
    assert.equal(r.out.status, 'DRILL_FINALIZED', name);
    assert.equal(r.out.conclusion, 'PASS_A_PER_NODE_STEPS_REMAIN', name);
    assert.equal(r.out.acceptance.status, 'NOT_OPENED', name);
    assert.equal(r.out.acceptance.code, code, name);
    assert.equal(r.out.acceptance.confirmUrl ?? null, null, name);
    assert.equal(r.receipt.conclusion, 'PASS_A_PER_NODE_STEPS_REMAIN', name);
  }
});

test('a candidate PASS without -Request is final all the same, and its answer says the request was not opened and how to open it', opts, () => {
  const r = finalizeWith('accept-no-request', candidate('accept-no-request-run'), { request: 'none' });
  assert.equal(r.out.conclusion, 'PASS_A_PER_NODE_STEPS_REMAIN');
  assert.equal(r.out.acceptance.status, 'NOT_OPENED');
  assert.equal(r.out.acceptance.code, 'DRILL_FINALIZE_NO_REQUEST');
  assert.match(r.out.acceptance.next, /accept\.mjs run --request/);
  assert.deepEqual(r.calls, []);
});

test('under the test marker the real opener is never run (no door, no gh from a test); -Request goes with -Finalize only', opts, () => {
  const r = finalizeWith('accept-marker', candidate('accept-marker-run'), { opener: null });
  assert.equal(r.out.conclusion, 'PASS_A_PER_NODE_STEPS_REMAIN');
  assert.equal(r.out.acceptance.status, 'NOT_OPENED');
  assert.equal(r.out.acceptance.code, 'DRILL_HOST_ACCESS_UNDER_TEST');
  assert.equal(psCode(`$Request = 'x.json'; $BaselineOnly = $true; Invoke-DrillMain`), 'DRILL_USAGE');
});

// review suggestion 7: the opener's own path work is inside the auxiliary step (a -Request no path can be made of: a NUL in it)
test('a -Request that is no path leaves the PASS and the receipt as they are: NOT_OPENED with DRILL_ACCEPTANCE_OPEN_FAILED, nothing run', opts, () => {
  const r = finalizeWith('accept-bad-path', candidate('accept-bad-path-run'), { request: '"x`0y.json"' });
  assert.equal(r.out.status, 'DRILL_FINALIZED', JSON.stringify(r.out));
  assert.equal(r.out.conclusion, 'PASS_A_PER_NODE_STEPS_REMAIN');
  assert.equal(r.out.acceptance.status, 'NOT_OPENED');
  assert.equal(r.out.acceptance.code, 'DRILL_ACCEPTANCE_OPEN_FAILED');
  assert.deepEqual(r.calls, []);
  assert.equal(r.receipt.conclusion, 'PASS_A_PER_NODE_STEPS_REMAIN');
});
