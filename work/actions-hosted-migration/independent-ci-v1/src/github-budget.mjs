// Request-level maintenance telemetry. No credential, URL or response body is retained.
// This is an admission hint for EXTRA idle slices, never publication authority or a
// guarantee about other processes sharing the installation's quota.
export const PROVIDER_BUDGET_CONTRACT = 'clued.independent-ci.train-provider-budget/1';
const FRESH_MS = 60_000;
const MAX_ISO_MS = 253402300799999; // ISO year <=9999, also accepted by the facts reader.
const natural = v => Number.isSafeInteger(v) && v >= 0;
const number = v => typeof v === 'string' && /^\d+$/.test(v) && natural(Number(v)) ? Number(v) : null;

export function createGitHubBudgetObserver({ clock = Date.now } = {}) {
  let requests = 0, restRequests = 0, graphqlRequests = 0, retryAt = null;
  const resources = { core: null, graphql: null };
  const times = { core: null, graphql: null };
  const resourceOf = url => {
    try { const u = new URL(url); return u.origin === 'https://api.github.com' ? (u.pathname === '/graphql' ? 'graphql' : 'core') : null; }
    catch { return null; }
  };
  const hold = at => {
    const safe = Number.isFinite(at) && at >= 0 && at <= MAX_ISO_MS ? at : clock() + 60_000;
    retryAt = Math.max(retryAt ?? 0, safe);
  };
  function retain(kind, limit, remaining, reset) {
    if (!(limit > 0 && natural(limit) && natural(remaining) && remaining <= limit && natural(reset) && reset * 1000 <= MAX_ISO_MS)) return false;
    resources[kind] = { limit, remaining, resetAt: new Date(reset * 1000).toISOString() };
    times[kind] = clock();
    if (remaining === 0) hold(reset * 1000);
    return true;
  }
  return Object.freeze({
    begin(url) {
      const kind = resourceOf(url); if (!kind) return;
      requests++; if (kind === 'graphql') graphqlRequests++; else restRequests++;
    },
    observe(url, response) {
      if (!resourceOf(url)) return;
      const get = name => { try { return response?.headers?.get?.(name) ?? null; } catch { return null; } };
      const kind = get('x-ratelimit-resource');
      if (Object.hasOwn(resources, kind)) retain(kind, number(get('x-ratelimit-limit')), number(get('x-ratelimit-remaining')), number(get('x-ratelimit-reset')));
      if ([403, 429].includes(response?.status)) {
        const value = get('retry-after'), seconds = number(value);
        const httpDate = typeof value === 'string' && /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value);
        const after = seconds === null ? (httpDate ? Date.parse(value) : NaN) : clock() + seconds * 1000;
        // An absent secondary-limit deadline requires at least one minute. Never
        // shorten a primary reset or a longer Retry-After already observed.
        hold(Number.isFinite(after) && after > clock() ? after : clock() + 60_000);
      }
    },
    observeBody(url, body) {
      if (resourceOf(url) !== 'graphql' || !Array.isArray(body?.errors)) return;
      if (body.errors.some(e => e?.type === 'RATE_LIMITED' || e?.extensions?.code === 'RATE_LIMITED'
        || (typeof e?.message === 'string' && /rate limit|secondary limit/i.test(e.message)))) hold(clock() + 60_000);
    },
    seed(body) {
      for (const kind of ['core', 'graphql']) {
        const r = body?.resources?.[kind];
        if (!r || !retain(kind, r.limit, r.remaining, r.reset)) { resources[kind] = null; times[kind] = null; }
      }
    },
    snapshot() {
      const now = clock(), observed = times.core !== null && times.graphql !== null ? Math.min(times.core, times.graphql) : null;
      const fresh = observed !== null && ['core', 'graphql'].every(k => now >= times[k] && now - times[k] <= FRESH_MS);
      const ready = fresh && !(retryAt !== null && retryAt > now) && ['core', 'graphql'].every(kind => {
        const r = resources[kind];
        // Extra work may consume only the surplus above half of each provider
        // window. Normal/front work is not stopped by this reservation.
        return r && Date.parse(r.resetAt) > now && r.remaining > Math.ceil(r.limit / 2);
      });
      return { contract: PROVIDER_BUDGET_CONTRACT, state: ready ? 'ok' : fresh ? 'low' : 'unknown', requests, restRequests, graphqlRequests,
        rest: resources.core ? { ...resources.core } : null, graphql: resources.graphql ? { ...resources.graphql } : null,
        retryAt: retryAt !== null && retryAt > now ? new Date(retryAt).toISOString() : null,
        observedAt: observed === null ? null : new Date(observed).toISOString(), extraSlicesAllowed: ready };
    }
  });
}

// Optional telemetry must never turn a successful publisher request into a
// transport failure. One observation failure disables extra work for this port.
export function guardedGitHubBudgetObserver(observer, { clock = Date.now } = {}) {
  let failed = false;
  const fallback = createGitHubBudgetObserver({ clock });
  const call = (method, args) => {
    if (failed) return undefined;
    try { return observer[method](...args); } catch { failed = true; return undefined; }
  };
  return Object.freeze({
    begin(...args) { fallback.begin(...args); call('begin', args); },
    observe(...args) { call('observe', args); },
    observeBody(...args) { call('observeBody', args); },
    seed(...args) { call('seed', args); },
    snapshot() { return call('snapshot', []) ?? fallback.snapshot(); }
  });
}
