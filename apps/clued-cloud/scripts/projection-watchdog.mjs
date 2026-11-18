// Run from an independent, single-instance scheduler using a LOGIN role that
// inherits only clued_projection_watchdog. No Builder or Canonical credentials.

const APPROVED_KEYS = new Set(['global.priority_frontier', 'global.__aggregate__']);
const ISO = (value) => typeof value === 'string' ? Date.parse(value) : NaN;
const elapsed = (now, then) => now - ISO(then);

export function evaluateProjectionWatchdog(snapshot, options = {}) {
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.projections) ||
    !Number.isFinite(ISO(snapshot.observed_at))) throw new Error('invalid_watchdog_snapshot');
  const now = ISO(snapshot.observed_at);
  const staleMs = options.staleMs ?? 5 * 60_000;
  if (!Number.isSafeInteger(staleMs) || staleMs <= 0) throw new Error('invalid_watchdog_threshold');
  const incidents = [];
  const add = (key, code, detail) => incidents.push({ key, code, detail });
  const heartbeat = snapshot.heartbeat;
  if (heartbeat && ['transport_unavailable', 'builder_protocol_error', 'exception'].includes(heartbeat.last_result)) {
    add('worker:degraded', 'WORKER_DEGRADED', `Last refresh result: ${heartbeat.last_result}.`);
  }
  if (snapshot.projections.length === 0) {
    add('projections:none', 'NO_PROJECTIONS', 'No tracked Global projection heads were returned.');
  }
  const keysByTenant = new Map();
  const unservedTenants = new Set();
  for (const row of snapshot.projections) {
    if (!row || !APPROVED_KEYS.has(row.projection_key) ||
      typeof row.tenant_key !== 'string' || !/^[0-9a-f]{64}$/.test(row.tenant_key) ||
      !['boolean', 'undefined'].includes(typeof row.builder_served) ||
      !Number.isSafeInteger(row.invalidation_revision) ||
      !Number.isSafeInteger(row.resolved_through_revision) ||
      !['match', 'mismatch', 'unavailable', 'not_applicable'].includes(row.source_digest_status)) {
      throw new Error('invalid_watchdog_projection');
    }
    const prefix = `${row.tenant_key}:${row.projection_key}`;
    const tenantKeys = keysByTenant.get(row.tenant_key) ?? new Set();
    if (tenantKeys.has(row.projection_key)) throw new Error('duplicate_watchdog_projection');
    tenantKeys.add(row.projection_key);
    keysByTenant.set(row.tenant_key, tenantKeys);
    const lag = row.invalidation_revision - row.resolved_through_revision;
    if ((lag === 0 && row.source_digest_status === 'not_applicable') ||
      (lag !== 0 && row.source_digest_status !== 'not_applicable')) {
      throw new Error('invalid_watchdog_digest_status');
    }
    // The running Builder cannot rebuild a tenant it holds no grant for, so such
    // rows are counted once below instead of alerting on each projection.
    if (row.builder_served === false) {
      unservedTenants.add(row.tenant_key);
      continue;
    }
    const summary = `${row.projection_key} revision ${row.resolved_through_revision}/${row.invalidation_revision}`;
    if (lag < 0) add(`${prefix}:revision_invariant`, 'REVISION_INVARIANT', summary);
    if (row.job_status === 'failed') {
      add(`${prefix}:terminal_failure`, 'TERMINAL_FAILURE',
        `${summary}; diagnostic error recorded in the private queue.`);
    }
    if (lag > 0 && row.job_status == null) {
      add(`${prefix}:queue_missing`, 'QUEUE_MISSING', summary);
    }
    if (lag > 0 && (!Number.isFinite(ISO(row.stale_since)) ||
      elapsed(now, row.stale_since) > staleMs)) {
      add(`${prefix}:stale_timeout`, 'STALE_TIMEOUT', summary);
    }
    if (lag === 0 && row.source_digest_status === 'mismatch') {
      add(`${prefix}:source_mismatch`, 'SOURCE_MISMATCH',
        `${summary}; stored source digest differs from the latest source vector.`);
    }
    if (lag === 0 && row.source_digest_status === 'unavailable') {
      add(`${prefix}:audit_gap`, 'AUDIT_GAP',
        `${summary}; no source digest is available for independent comparison.`);
    }
  }
  for (const [tenantKey, keys] of keysByTenant) {
    if (unservedTenants.has(tenantKey)) continue;
    for (const approvedKey of APPROVED_KEYS) {
      if (!keys.has(approvedKey)) {
        add(`${tenantKey}:${approvedKey}:head_missing`, 'HEAD_MISSING',
          `${approvedKey} was absent from the bounded status snapshot.`);
      }
    }
  }
  if (unservedTenants.size) {
    add('tenants:unserved', 'UNSERVED_TENANTS',
      `${unservedTenants.size} tenant(s) have Global projections the running Builder is not granted to rebuild.`);
  }
  return incidents.sort((a, b) => a.key.localeCompare(b.key));
}

export function notificationChanges(previousKeys, incidents) {
  const previous = new Set(previousKeys);
  const current = new Set(incidents.map((incident) => incident.key));
  return {
    opened: incidents.filter((incident) => !previous.has(incident.key)),
    recovered: [...previous].filter((key) => !current.has(key)).sort(),
    active: [...current].sort(),
  };
}

export function missingTenantIncidents(previousTenants, currentTenants) {
  const current = new Set(currentTenants);
  return previousTenants.filter((tenant) => !current.has(tenant)).map((tenant) => ({
    key: `${tenant}:tenant_missing`, code: 'TENANT_MISSING',
    detail: 'A previously observed tenant has no Global projection heads in the latest snapshot.',
  }));
}

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export async function sendProjectionWatchdogEmail(changes, config, fetchImpl = fetch) {
  const { accountId, apiToken, from, to } = config;
  if (![accountId, apiToken, from, to].every((value) => typeof value === 'string' && value.length > 0)) {
    throw new Error('alert_delivery_not_configured');
  }
  const lines = [
    ...changes.opened.map((incident) => `OPEN ${incident.code}: ${incident.detail} [${incident.key}]`),
    ...changes.recovered.map((key) => `RECOVERED: ${key}`),
  ];
  if (!lines.length) return { status: 'no_change' };
  const text = `Clued projection refresh monitor\n\n${lines.join('\n')}\n\nNo Canonical content is included.\n`;
  const response = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/email/sending/send`,
    {
      method: 'POST',
      signal: AbortSignal.timeout(config.timeoutMs ?? 15_000),
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to, from: { address: from, name: 'Clued Monitor' },
        subject: changes.opened.length ? '[Clued] Projection refresh needs attention' :
          '[Clued] Projection refresh recovered',
        text, html: `<pre>${escapeHtml(text)}</pre>`,
      }),
    },
  );
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.success !== true ||
    !((body.result?.delivered || []).includes(to) || (body.result?.queued || []).includes(to))) {
    throw new Error(`alert_delivery_failed_${response.status}`);
  }
  return { status: 'accepted' };
}

export async function runProjectionWatchdog(env = process.env) {
  const statePath = env.CLUED_WATCHDOG_STATE_PATH;
  if (!statePath) throw new Error('watchdog_state_path_required');
  const { readFile, writeFile, rename } = await import('node:fs/promises');
  const { randomUUID } = await import('node:crypto');
  let previous = [];
  let previousTenants = [];
  try {
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    if (!Array.isArray(state.active) || !state.active.every((key) => typeof key === 'string') ||
      (state.observed_tenants !== undefined && (!Array.isArray(state.observed_tenants) ||
        !state.observed_tenants.every((key) => typeof key === 'string' && /^[0-9a-f]{64}$/.test(key))))) {
      throw new Error('invalid_watchdog_state');
    }
    previous = state.active;
    previousTenants = state.observed_tenants ?? [];
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let incidents;
  let observedTenants = previousTenants;
  let readSucceeded = false;
  try {
    if (!env.CLUED_WATCHDOG_DATABASE_URL) throw new Error('watchdog_database_not_configured');
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: env.CLUED_WATCHDOG_DATABASE_URL,
      connectionTimeoutMillis: 10_000, query_timeout: 15_000 });
    try {
      await client.connect();
      const result = await client.query('select clued_watchdog.projection_watchdog_snapshot() as snapshot');
      const freshSnapshot = result.rows[0]?.snapshot;
      incidents = evaluateProjectionWatchdog(freshSnapshot);
      const currentTenants = [...new Set(freshSnapshot.projections.map((row) => row.tenant_key))];
      incidents.push(...missingTenantIncidents(previousTenants, currentTenants));
      observedTenants = [...new Set([...previousTenants, ...currentTenants])].sort();
      readSucceeded = true;
    } finally {
      await client.end().catch(() => {});
    }
  } catch {
    // A failed observation cannot prove that previously observed incidents
    // recovered. Preserve their keys until a successful fresh snapshot.
    incidents = [
      ...previous.filter((key) => key !== 'monitor:read_failure').map((key) => ({
        key, code: 'STATUS_UNVERIFIED', detail: 'Status could not be rechecked.',
      })),
      { key: 'monitor:read_failure', code: 'MONITOR_READ_FAILURE',
        detail: 'Independent monitor could not read projection status.' },
    ];
  }
  const changes = notificationChanges(previous, incidents);
  const persistState = async () => {
    const temporary = `${statePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ active: changes.active,
      observed_tenants: observedTenants }), { mode: 0o600 });
    await rename(temporary, statePath);
  };
  if (!changes.opened.length && !changes.recovered.length) {
    if (readSucceeded && observedTenants.length !== previousTenants.length &&
      env.CLUED_WATCHDOG_DRY_RUN !== '1') await persistState();
    return { status: 'unchanged', incidents };
  }
  if (env.CLUED_WATCHDOG_DRY_RUN === '1') return { status: 'dry_run', changes };
  await sendProjectionWatchdogEmail(changes, {
    accountId: env.CLUED_ALERT_CF_ACCOUNT_ID,
    apiToken: env.CLUED_ALERT_CF_API_TOKEN,
    from: env.CLUED_ALERT_FROM,
    to: env.CLUED_ALERT_TO,
  });
  await persistState();
  return { status: 'notified', changes };
}

if (import.meta.main ?? process.argv[1]?.split(/[\\/]/).pop() === decodeURIComponent(import.meta.url.split('/').pop())) {
  runProjectionWatchdog().then((result) => {
    process.stdout.write(JSON.stringify({ status: result.status,
      active_incidents: result.incidents?.length ?? result.changes?.active.length ?? 0 }) + '\n');
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'watchdog_failed'}\n`);
    process.exitCode = 1;
  });
}
