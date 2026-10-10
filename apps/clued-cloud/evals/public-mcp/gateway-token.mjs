import { createHmac } from 'node:crypto';

// Test-only credentials come from `supabase status`, never an environment secret.
export function assertLocalGatewayUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('local gateway URL required'); }
  if (!['http:', 'https:'].includes(url.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('local gateway requires a loopback HTTP origin');
  }
  return url.origin;
}

export function createLocalGatewayToken({ apiUrl, jwtSecret }, { now = Math.floor(Date.now() / 1000), ttlSeconds = 3600 } = {}) {
  assertLocalGatewayUrl(apiUrl);
  if (typeof jwtSecret !== 'string' || Buffer.byteLength(jwtSecret.trim()) < 32) {
    throw new Error('local Supabase status must report JWT_SECRET (at least 32 bytes)');
  }
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3600) {
    throw new Error('local gateway JWT requires a lifetime of 1..3600 seconds');
  }
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const payload = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ role: 'clued_worker_gateway', iat: now, exp: now + ttlSeconds })}`;
  return `${payload}.${createHmac('sha256', jwtSecret).update(payload).digest('base64url')}`;
}

// Configuration screening only: PostgREST still verifies the real JWT signature.
export function assertLocalGatewayConfig({ gatewayOrigin, gatewayToken }, now = Math.floor(Date.now() / 1000)) {
  assertLocalGatewayUrl(gatewayOrigin);
  try {
    const parts = gatewayToken.split('.');
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (parts.length !== 3 || !/^[A-Za-z0-9_-]{43}$/.test(parts[2]) || header.alg !== 'HS256'
      || claims.role !== 'clued_worker_gateway' || !Number.isSafeInteger(claims.iat)
      || !Number.isSafeInteger(claims.exp) || claims.iat > now || claims.exp <= now
      || claims.exp - claims.iat < 1 || claims.exp - claims.iat > 3600) throw new Error();
  } catch { throw new Error('local Worker requires a short-lived clued_worker_gateway JWT'); }
}

export function localGatewayChildEnv(source = process.env, extra = {}) {
  const keep = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'TEMP', 'TMP', 'USER', 'USERPROFILE',
    'LOGNAME', 'SHELL', 'TERM', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC', 'PATHEXT',
    'npm_config_cache', 'NVM_DIR', 'SUPABASE_INTERNAL_IMAGE_REGISTRY', 'DOCKER_HOST', 'CI', 'GITHUB_ACTIONS', 'RUNNER_TEMP',
    'RUNNER_TRACKING_ID', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_JOB', 'GITHUB_WORKSPACE', 'RUNNER_NAME'];
  return { ...Object.fromEntries(keep.filter((key) => source[key] !== undefined).map((key) => [key, source[key]])),
    DO_NOT_TRACK: '1', SUPABASE_TELEMETRY_DISABLED: '1', WRANGLER_SEND_METRICS: 'false', ...extra };
}
