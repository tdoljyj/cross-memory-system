// Post-deploy projection check of the production release (Fable 1121 §6.1).
//
// The release gate (production-release-gate.mjs) stays as on main: its
// --post-deploy waits a few minutes for a backlog and then blocks. A
// projection queued without a request-side wake only catches up on the next
// Cron tick, so this wrapper calls the gate's --post-deploy again while its
// only findings are a backlog, until one Cron period plus two minutes has
// passed. A failed job, a digest mismatch, any other finding or a stalled call
// (cut by the child timeout) fails at once. It always writes a conclusion.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('..', import.meta.url));
const GATE = fileURLToPath(new URL('./production-release-gate.mjs', import.meta.url));
const WRANGLER_PRODUCTION = fileURLToPath(new URL('../wrangler.production.jsonc', import.meta.url));
/** One gate call: its own backlog wait (about three minutes) plus the database reads. */
export const CALL_TIMEOUT_MS = 4 * 60_000;
const RETRY_MS = 10_000;
const BACKLOG = /^projection_backlog_(?:pending|overdue):/;

// Only "every N minutes" has a known longest gap between two ticks.
export function cronPeriodMinutes(config) {
  const crons = config?.triggers?.crons;
  const match = Array.isArray(crons) && crons.length === 1 && typeof crons[0] === 'string'
    ? /^\*\/([1-9][0-9]?) \* \* \* \*$/.exec(crons[0]) : null;
  const minutes = match ? Number(match[1]) : NaN;
  if (!(minutes >= 1 && minutes <= 59)) throw new Error('cron_schedule_unsupported');
  return minutes;
}

/** The post-deploy window: one Cron period plus two minutes. */
export const windowMs = (periodMinutes) => (periodMinutes + 2) * 60_000;

/** The gate's findings from its last `production_release_blocked:` line. */
export function blockReasons(stderr) {
  const line = String(stderr ?? '').split('\n').map((text) => text.trim())
    .filter((text) => text.startsWith('production_release_blocked:')).at(-1);
  return line ? line.slice('production_release_blocked:'.length).split(',').filter(Boolean) : [];
}

export function spawnGate(evidenceOut, { spawn = spawnSync, env = process.env } = {}) {
  const run = spawn(process.execPath, [GATE, '--post-deploy', '--evidence-out', evidenceOut], {
    cwd: APP, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: CALL_TIMEOUT_MS, windowsHide: true,
  });
  return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '',
    timedOut: run.error?.code === 'ETIMEDOUT' || (run.status === null && Boolean(run.signal)) };
}

export async function runPostflight({ periodMinutes, runGate, now = Date.now,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)), log = () => {} }) {
  const started = now();
  const deadline = started + windowMs(periodMinutes);
  const attempts = [];
  for (let attempt = 1; ; attempt += 1) {
    const at = now() - started;
    const result = await runGate(attempt);
    const reasons = blockReasons(result.stderr);
    attempts.push({ attempt, started_after_ms: at, status: result.status ?? null, timed_out: Boolean(result.timedOut), reasons });
    if (result.timedOut) return { status: 'failed', reason: 'gate_call_timeout', attempts };
    if (result.status === 0) return { status: 'passed', attempts, gate_evidence: result.evidence ?? null };
    if (!reasons.length || !reasons.every((reason) => BACKLOG.test(reason))) {
      return { status: 'failed', reason: reasons.join(',') || 'gate_failed_without_reason', attempts };
    }
    const remaining = deadline - now();
    if (remaining <= 0) return { status: 'failed', reason: `window_ended:${reasons.join(',')}`, attempts };
    log(`projection backlog (${reasons.join(', ')}); calling the gate again (${Math.ceil(remaining / 1000)} s left)`);
    await sleep(Math.min(RETRY_MS, remaining));
    if (now() >= deadline) return { status: 'failed', reason: `window_ended:${reasons.join(',')}`, attempts };
  }
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

// Wrangler's own reader (JSONC: comments, trailing commas), as `wrangler deploy` reads it.
// The release tests read the production configuration through it too.
export async function readWranglerConfig(file) {
  const { experimental_readRawConfig: readRawConfig } = await import('wrangler');
  return readRawConfig({ config: file }).rawConfig;
}

export async function main(argv = process.argv.slice(2), { periodMinutes, runGate, now, sleep,
  configPath = WRANGLER_PRODUCTION, readConfig = readWranglerConfig,
  removeScratch = (directory) => rmSync(directory, { recursive: true, force: true }),
  writeConclusion = (file, text) => writeFileSync(file, text),
  log = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const out = option(argv, '--evidence-out');
  if (!out) {
    log('usage: projection-postflight.mjs --evidence-out FILE');
    return 2;
  }
  let scratch = null;
  let conclusion;
  // Every way out, an exception included, leaves a conclusion before the exit.
  try {
    let period = periodMinutes;
    if (period === undefined) {
      let config;
      try {
        config = await readConfig(configPath);
      } catch (error) {
        throw Object.assign(new Error(`wrangler_config_unreadable: ${error?.message ?? error}`), { conclusion: true });
      }
      period = cronPeriodMinutes(config);
    }
    scratch = mkdtempSync(path.join(os.tmpdir(), 'projection-postflight-'));
    const gate = runGate ?? (async (attempt) => {
      const evidence = path.join(scratch, `attempt-${attempt}.json`);
      const result = spawnGate(evidence);
      process.stderr.write(result.stderr);
      return { ...result, evidence: existsSync(evidence) ? JSON.parse(readFileSync(evidence, 'utf8')) : null };
    });
    conclusion = { period_minutes: period, window_ms: windowMs(period),
      ...await runPostflight({ periodMinutes: period, runGate: gate, now, sleep, log }) };
  } catch (error) {
    conclusion = { status: 'failed', reason: error?.message === 'cron_schedule_unsupported' || error?.conclusion
      ? error.message : `postflight_error: ${error?.message ?? error}`, attempts: conclusion?.attempts ?? [] };
  }
  // The conclusion first; the scratch directory after. A failed clean-up
  // (EBUSY, EACCES) only adds a warning and changes nothing written.
  const record = { contract: 'clued.production-projection-postflight.v1', ...conclusion, finished_at: new Date().toISOString() };
  try {
    writeConclusion(out, `${JSON.stringify(record, null, 2)}\n`);
    log(`projection postflight ${record.status}${record.reason ? `: ${record.reason}` : ''}`);
  } finally {
    if (scratch) {
      try {
        removeScratch(scratch);
      } catch (error) {
        log(`::warning::projection postflight could not remove ${scratch} (${error?.code ?? 'error'}): ${error?.message ?? error}`);
      }
    }
  }
  return record.status === 'passed' ? 0 : 1;
}

if (import.meta.main) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`projection postflight failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
