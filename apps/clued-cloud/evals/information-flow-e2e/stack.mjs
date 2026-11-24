// Local Supabase stack control for the S6 harness (plan section 2.3). The
// stack itself (db, kong, gotrue, postgrest) is started by the caller
// (`supabase start -x ...`); this module reads its status, resets the
// database through the full migration chain, restarts containers for
// E2E-08, and records image digests. Child processes get an allowlisted
// environment: no proxy, no Supabase access token, telemetry off.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const cloudRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SUPABASE_CLI_VERSION = '2.115.0';

// Allowlisted environment for every child process (plan section 7 point 3).
export function childEnv(extra = {}) {
  const keep = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL', 'TERM',
    'npm_config_cache', 'NVM_DIR', 'SUPABASE_INTERNAL_IMAGE_REGISTRY', 'DOCKER_HOST', 'CI', 'GITHUB_ACTIONS',
    'RUNNER_TEMP', 'IFE2E_DENY_PORTS', 'IFE2E_SUPABASE_BIN'];
  const env = {};
  for (const name of keep) if (process.env[name] !== undefined) env[name] = process.env[name];
  env.DO_NOT_TRACK = '1';
  env.SUPABASE_TELEMETRY_DISABLED = '1';
  env.WRANGLER_SEND_METRICS = 'false';
  return { ...env, ...extra };
}

export const FORBIDDEN_ENV = [/^SUPABASE_ACCESS_TOKEN$/, /^SUPABASE_DB_PASSWORD$/, /^CLOUDFLARE_API_TOKEN$/,
  /^CLOUDFLARE_ACCOUNT_ID$/, /^ANTHROPIC_API_KEY$/, /^OPENAI_API_KEY$/, /^GOOGLE_API_KEY$/, /^AZURE_OPENAI_/, /^AWS_/,
  /^PROMPTFOO_/, /^GEMINI_API_KEY$/, /^MISTRAL_API_KEY$/, /^COHERE_API_KEY$/];

export function supabaseCommand() {
  if (process.env.IFE2E_SUPABASE_BIN) return [process.env.IFE2E_SUPABASE_BIN, []];
  if (process.platform === 'linux' && process.env.GITHUB_ACTIONS === 'true') {
    return ['npx', ['--yes', '--offline', `--package=supabase@${SUPABASE_CLI_VERSION}`,
      `--package=@supabase/cli-linux-x64@${SUPABASE_CLI_VERSION}`, 'supabase']];
  }
  return [process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', `supabase@${SUPABASE_CLI_VERSION}`]];
}

export function supabase(args, { timeout = 600000 } = {}) {
  const [command, prefix] = supabaseCommand();
  return execFileSync(command, [...prefix, ...args], { cwd: cloudRoot, encoding: 'utf8', timeout,
    env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

export function status() {
  const parsed = JSON.parse(supabase(['status', '--output', 'json'], { timeout: 120000 }));
  const url = new URL(parsed.API_URL);
  const db = new URL(parsed.DB_URL);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !['127.0.0.1', 'localhost'].includes(db.hostname)) {
    throw new Error('the Supabase stack is not local');
  }
  return {
    apiUrl: parsed.API_URL.replace(/\/$/, ''),
    dbUrl: parsed.DB_URL,
    publishableKey: parsed.PUBLISHABLE_KEY ?? parsed.ANON_KEY,
    // Local demo signing secret; kept in memory only, never written to evidence.
    jwtSecret: parsed.JWT_SECRET ?? null,
    jwtAlgorithm: parsed.JWT_SECRET ? 'HS256_shared_secret_local' : 'asymmetric',
  };
}

export function projectId() {
  const text = fs.readFileSync(path.join(cloudRoot, 'supabase/config.toml'), 'utf8');
  return /^project_id\s*=\s*"([^"]+)"/m.exec(text)?.[1];
}

export function docker(args, { timeout = 180000 } = {}) {
  return execFileSync('docker', args, { encoding: 'utf8', timeout, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
}

export function containers() {
  const id = projectId();
  const names = docker(['ps', '--format', '{{.Names}}']).split('\n').filter(Boolean);
  const pick = (service) => names.find((name) => name === `supabase_${service}_${id}`) ?? null;
  return { db: pick('db'), rest: pick('rest'), auth: pick('auth'), kong: pick('kong') };
}

export function imageDigests() {
  const out = {};
  for (const [service, name] of Object.entries(containers())) {
    if (!name) { out[service] = null; continue; }
    const image = docker(['inspect', '--format', '{{.Config.Image}}', name]).trim();
    const [id, repoDigests] = docker(['image', 'inspect', '--format', '{{.Id}} {{json .RepoDigests}}', image]).trim()
      .split(' ');
    out[service] = { image, id, repo_digests: JSON.parse(repoDigests) };
  }
  return out;
}

// The Docker bridge subnets the local db container is attached to, read at
// runtime (F09): the observer accepts only loopback or these subnets.
export function dbNetworkCidrs() {
  const name = containers().db;
  if (!name) return [];
  const networks = Object.keys(JSON.parse(docker(['inspect', '--format', '{{json .NetworkSettings.Networks}}', name])));
  const cidrs = [];
  for (const network of networks) {
    const config = JSON.parse(docker(['network', 'inspect', '--format', '{{json .IPAM.Config}}', network]) || '[]') ?? [];
    for (const row of config) if (row?.Subnet) cidrs.push(row.Subnet);
  }
  return [...new Set(cidrs)].sort();
}

export function containerStartedAt() {
  const out = {};
  for (const [service, name] of Object.entries(containers())) {
    out[service] = name ? docker(['inspect', '--format', '{{.State.StartedAt}}', name]).trim() : null;
  }
  return out;
}

// The CLI only recreates the database: it applies no migration ([db.migrations] enabled = false). The chain is
// applied by scripts/ci/clued-local-migrate.mjs, in the shape production runs it.
export function resetDatabase() {
  const reset = supabase(['db', 'reset', '--local', '--no-seed'], { timeout: 900000 });
  return reset + execFileSync(process.execPath, [path.resolve(cloudRoot, '../../scripts/ci/clued-local-migrate.mjs')],
    { cwd: cloudRoot, encoding: 'utf8', timeout: 900000, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024 });
}

export async function waitHealthy(apiUrl, publishableKey, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const rest = await fetch(`${apiUrl}/rest/v1/`, { headers: { apikey: publishableKey } });
      const auth = await fetch(`${apiUrl}/auth/v1/health`, { headers: { apikey: publishableKey } });
      if (rest.status === 200 && auth.status === 200) return;
      last = `${rest.status}/${auth.status}`;
    } catch (error) { last = error.message; }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`stack not healthy: ${last}`);
}

// E2E-08: restart db, PostgREST, GoTrue and Kong; the data volume persists.
export function restartContainers() {
  const names = containers();
  for (const service of ['db', 'rest', 'auth', 'kong']) {
    if (!names[service]) throw new Error(`missing container for ${service}`);
  }
  docker(['restart', names.db]);
  docker(['restart', names.rest, names.auth, names.kong]);
  return names;
}

export function cliVersions() {
  const [command, prefix] = supabaseCommand();
  const version = execFileSync(command, [...prefix, '--version'], { cwd: cloudRoot, encoding: 'utf8', env: childEnv() })
    .trim();
  const docker_version = docker(['version', '--format', '{{.Server.Version}}']).trim();
  return { supabase_cli: version, docker: docker_version };
}
