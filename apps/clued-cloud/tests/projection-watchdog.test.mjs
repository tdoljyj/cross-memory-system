import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  evaluateProjectionWatchdog, missingTenantIncidents, notificationChanges, runProjectionWatchdog,
  sendProjectionWatchdogEmail,
} from '../scripts/projection-watchdog.mjs';

const now = '2026-09-23T00:30:00.000Z';
const tenant = 'a'.repeat(64);
const row = (key, overrides = {}) => ({
  tenant_key: tenant, projection_key: key, invalidation_revision: 3,
  resolved_through_revision: 3, job_status: 'completed', stale_since: null,
  source_digest_status: 'match', last_error_code: null, ...overrides,
});
const snapshot = (overrides = {}) => ({
  observed_at: now,
  heartbeat: { last_started_at: '2026-09-23T00:29:00.000Z',
    last_finished_at: '2026-09-23T00:29:01.000Z', last_result: 'idle' },
  projections: [row('global.priority_frontier'), row('global.__aggregate__')],
  ...overrides,
});

test('watchdog detects idle, failed, stuck, missing, and inconsistent projection states', () => {
  assert.deepEqual(evaluateProjectionWatchdog(snapshot()), []);
  assert.deepEqual(evaluateProjectionWatchdog(snapshot({ heartbeat: null })).map((i) => i.code),
    []);
  assert.deepEqual(evaluateProjectionWatchdog(snapshot({ heartbeat: {
    last_started_at: '2026-09-23T00:20:00.000Z',
    last_finished_at: '2026-09-23T00:19:00.000Z', last_result: 'transport_unavailable',
  } })).map((i) => i.code).sort(),
  ['WORKER_DEGRADED']);
  const broken = snapshot({ projections: [
    row('global.priority_frontier', { invalidation_revision: 4,
      source_digest_status: 'not_applicable', job_status: 'failed',
      stale_since: '2026-09-23T00:20:00.000Z', last_error_code: 'builder_lease_expired' }),
    row('global.__aggregate__', { source_digest_status: 'mismatch' }),
  ] });
  assert.deepEqual(evaluateProjectionWatchdog(broken).map((i) => i.code).sort(),
    ['SOURCE_MISMATCH', 'STALE_TIMEOUT', 'TERMINAL_FAILURE'].sort());
  assert.ok(!JSON.stringify(evaluateProjectionWatchdog(snapshot({ projections: [row(
    'global.priority_frontier', { job_status: 'failed',
      last_error_code: 'Canonical body must not leave private diagnostics' })] })))
    .includes('Canonical body'));
  const missing = snapshot({ projections: [row('global.__aggregate__', {
    invalidation_revision: 4, source_digest_status: 'not_applicable',
    job_status: null, stale_since: now,
  })] });
  assert.deepEqual(evaluateProjectionWatchdog(missing).map((i) => i.code).sort(),
    ['HEAD_MISSING', 'QUEUE_MISSING'].sort());
  const gap = snapshot({ projections: [row('global.__aggregate__', {
    source_digest_status: 'unavailable',
  })] });
  assert.deepEqual(evaluateProjectionWatchdog(gap).map((i) => i.code).sort(),
    ['AUDIT_GAP', 'HEAD_MISSING'].sort());
  assert.deepEqual(evaluateProjectionWatchdog(snapshot({ projections: [] })).map((i) => i.code),
    ['NO_PROJECTIONS']);
  assert.throws(() => evaluateProjectionWatchdog(snapshot({ projections: [row('other')] })),
    /invalid_watchdog_projection/);
  assert.throws(() => evaluateProjectionWatchdog(snapshot({ projections: [row(
    'global.__aggregate__', { source_digest_status: null })] })), /invalid_watchdog_projection/);
});

test('watchdog counts tenants the Builder does not serve instead of alerting per row', () => {
  const other = 'b'.repeat(64);
  const unserved = (key) => row(key, { tenant_key: other, builder_served: false,
    invalidation_revision: 4, resolved_through_revision: 0, job_status: 'queued',
    stale_since: '2026-09-23T00:00:00.000Z', source_digest_status: 'not_applicable' });
  const mixed = snapshot({ projections: [
    row('global.priority_frontier', { builder_served: true }),
    row('global.__aggregate__', { builder_served: true }),
    unserved('global.priority_frontier'), unserved('global.__aggregate__'),
  ] });
  const incidents = evaluateProjectionWatchdog(mixed);
  assert.deepEqual(incidents.map((i) => [i.key, i.code]), [['tenants:unserved', 'UNSERVED_TENANTS']]);
  assert.match(incidents[0].detail, /^1 tenant\(s\)/);
  assert.equal(JSON.stringify(incidents).includes(other), false);
  const servedStale = snapshot({ projections: [
    row('global.priority_frontier', { builder_served: true, invalidation_revision: 4,
      source_digest_status: 'not_applicable', stale_since: '2026-09-23T00:00:00.000Z' }),
    row('global.__aggregate__', { builder_served: true }),
  ] });
  assert.deepEqual(evaluateProjectionWatchdog(servedStale).map((i) => i.code), ['STALE_TIMEOUT']);
  assert.throws(() => evaluateProjectionWatchdog(snapshot({ projections: [
    row('global.__aggregate__', { builder_served: 'yes' })] })), /invalid_watchdog_projection/);
});

test('watchdog de-duplicates recurring incidents and emits recovery transitions', () => {
  const incidents = evaluateProjectionWatchdog(snapshot({ projections: [] }));
  const first = notificationChanges([], incidents);
  assert.equal(first.opened.length, 1);
  assert.deepEqual(notificationChanges(first.active, incidents),
    { opened: [], recovered: [], active: first.active });
  const recovered = notificationChanges(first.active, []);
  assert.deepEqual(recovered.recovered, ['projections:none']);
  assert.deepEqual(recovered.active, []);
  assert.deepEqual(missingTenantIncidents([tenant], []).map((incident) => incident.code),
    ['TENANT_MISSING']);
  assert.deepEqual(missingTenantIncidents([tenant], [tenant]), []);
});

test('email contains only bounded status, and failed delivery cannot advance state', async () => {
  const calls = [];
  const changes = notificationChanges([], evaluateProjectionWatchdog(snapshot({ projections: [] })));
  const config = { accountId: 'account', apiToken: 'secret', from: 'monitor@example.invalid',
    to: 'owner@example.invalid' };
  await sendProjectionWatchdogEmail(changes, config, async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ success: true,
      result: { queued: [config.to] } }) };
  });
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].init.body).to, config.to);
  assert.ok(!calls[0].init.body.includes('Canonical body'));
  await assert.rejects(() => sendProjectionWatchdogEmail(changes, config, async () => ({
    ok: false, status: 403, json: async () => ({ success: false }),
  })), /alert_delivery_failed_403/);
  // AbortSignal.timeout() uses an unref'd timer, so while the mocked fetch is
  // pending nothing else keeps the event loop alive and the process can exit
  // with this promise unsettled (seen on Node 22). Hold the loop open until the
  // abort fires.
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    await assert.rejects(() => sendProjectionWatchdogEmail(changes,
      { ...config, timeoutMs: 1 }, async (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      })), /timeout|abort/i);
  } finally {
    clearInterval(keepAlive);
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'clued-watchdog-'));
  const statePath = path.join(directory, 'state.json');
  await writeFile(statePath, JSON.stringify({ active: [`${tenant}:global.priority_frontier:stale_timeout`] }));
  const result = await runProjectionWatchdog({
    CLUED_WATCHDOG_STATE_PATH: statePath,
    CLUED_WATCHDOG_DRY_RUN: '1',
  });
  assert.equal(result.status, 'dry_run');
  assert.equal(result.changes.opened[0].code, 'MONITOR_READ_FAILURE');
  assert.deepEqual(result.changes.recovered, [], 'failed observations cannot prove recovery');
  assert.ok(result.changes.active.includes(`${tenant}:global.priority_frontier:stale_timeout`));
});
