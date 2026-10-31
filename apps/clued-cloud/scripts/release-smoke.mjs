// Release smoke test for one environment (development/contracts/release/
// ReleasePipeline.v0.1.md §5). Read-only: it only sends GET requests to the
// named environment's public origin and never reads a credential.
//
// It passes when the origin serves the expected source commit at /healthz, the
// repository's Agent contract at /clued-agent.md with a matching bootstrap,
// and the home page with 200. The CD pipeline runs it after every deploy; a
// failure there rolls the Worker back to the previous version. After a
// rollback it checks the previous commit against that commit's contract,
// which --contract-file names (the pipeline writes it with git show).
// The test environment lives on its own Cloudflare account (Decision
// 87a4a26c); its workers.dev origin is passed with --origin.
//
//   node scripts/release-smoke.mjs --env test|production --commit <40-hex>
//     [--origin https://...] [--contract-file path] [--attempts 6] [--evidence-out path]
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contractVersionOf, verifyServedAgentContract } from './verify-served-agent-contract.mjs';

export const ENVIRONMENTS = Object.freeze({
  production: Object.freeze({ origin: 'https://kooyumi.pixelgrav.com', worker: 'clued-cloud' }),
  test: Object.freeze({ origin: null, worker: 'clued-cloud-test' }),
});
const contractSource = new URL('../../../protocol/agent/agent-contract.md', import.meta.url);

export function parseArgs(argv) {
  const options = {
    env: null, commit: null, origin: null, contractFile: null, attempts: 6, delayMs: 10_000, evidenceOut: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--env') options.env = value;
    else if (flag === '--commit') options.commit = value;
    else if (flag === '--origin') options.origin = value;
    else if (flag === '--contract-file') options.contractFile = value;
    else if (flag === '--attempts') options.attempts = Number(value);
    else if (flag === '--delay-ms') options.delayMs = Number(value);
    else if (flag === '--evidence-out') options.evidenceOut = value;
    else throw new Error(`release_smoke_unknown_argument:${flag}`);
    index += 1;
  }
  if (!Object.hasOwn(ENVIRONMENTS, options.env ?? '')) throw new Error('release_smoke_env_invalid');
  if (!/^[0-9a-f]{40}$/.test(options.commit ?? '')) throw new Error('release_smoke_commit_invalid');
  options.originOverridden = options.origin !== null && options.origin !== ENVIRONMENTS[options.env].origin;
  options.origin = (options.origin ?? ENVIRONMENTS[options.env].origin ?? '').replace(/\/$/, '');
  if (!/^https:\/\/[a-z0-9.-]+$/.test(options.origin)) throw new Error('release_smoke_origin_invalid');
  if (!Number.isInteger(options.attempts) || options.attempts < 1 || options.attempts > 30) {
    throw new Error('release_smoke_attempts_invalid');
  }
  if (!Number.isInteger(options.delayMs) || options.delayMs < 0 || options.delayMs > 60_000) {
    throw new Error('release_smoke_delay_invalid');
  }
  return options;
}

// Pure verdict over what one attempt observed, so tests need no network.
export function evaluateSmoke({ commit, contract, observed }) {
  const errors = [];
  const health = observed.health;
  if (health?.status !== 200) errors.push(`healthz_http_${health?.status ?? 'none'}`);
  else if (health.body?.status !== 'ok') errors.push('healthz_not_ok');
  else if (health.body?.source_commit !== commit) errors.push('healthz_source_commit_mismatch');
  if (observed.home?.status !== 200) errors.push(`home_http_${observed.home?.status ?? 'none'}`);
  if (observed.contract?.status !== 200 || observed.bootstrap?.status !== 200) {
    errors.push('agent_contract_unreachable');
  } else {
    for (const error of verifyServedAgentContract({
      contract, served: observed.contract.body, bootstrap: observed.bootstrap.body,
    })) errors.push(error);
  }
  return errors;
}

async function get(fetchImpl, url, accept, parse) {
  try {
    const response = await fetchImpl(url, {
      method: 'GET', redirect: 'manual', cache: 'no-store',
      signal: AbortSignal.timeout(10_000), headers: { accept },
    });
    let body = null;
    if (response.status === 200) {
      const text = await response.text();
      body = parse === 'json' ? JSON.parse(text) : text;
    }
    return { status: response.status, body };
  } catch {
    return { status: null, body: null };
  }
}

export async function observe({ origin, commit, fetchImpl }) {
  const bust = `release=${commit}`;
  return {
    health: await get(fetchImpl, `${origin}/healthz?${bust}`, 'application/json', 'json'),
    home: await get(fetchImpl, `${origin}/?${bust}`, 'text/html', 'text'),
    contract: await get(fetchImpl, `${origin}/clued-agent.md?${bust}`, 'text/markdown', 'text'),
    bootstrap: await get(fetchImpl, `${origin}/v1/continuity/bootstrap?${bust}`, 'application/json', 'json'),
  };
}

export async function runSmoke({ options, contract, fetchImpl = globalThis.fetch, sleep }) {
  const wait = sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  let errors = [];
  let attempt = 0;
  while (attempt < options.attempts) {
    attempt += 1;
    const observed = await observe({ origin: options.origin, commit: options.commit, fetchImpl });
    errors = evaluateSmoke({ commit: options.commit, contract, observed });
    if (errors.length === 0) break;
    if (attempt < options.attempts) await wait(options.delayMs);
  }
  return {
    contract: 'clued.release-smoke.v1',
    status: errors.length === 0 ? 'passed' : 'failed',
    environment: options.env,
    origin: options.origin,
    origin_overridden: options.originOverridden,
    source_commit: options.commit,
    contract_version: contractVersionOf(contract),
    attempts: attempt,
    errors,
    checked_at: new Date().toISOString(),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const contract = (await readFile(options.contractFile ?? contractSource, 'utf8')).replace(/\r\n/g, '\n');
  const result = await runSmoke({ options, contract });
  if (options.evidenceOut) await writeFile(options.evidenceOut, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== 'passed') process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'release_smoke_unexpected_error'}\n`);
    process.exitCode = 2;
  });
}
