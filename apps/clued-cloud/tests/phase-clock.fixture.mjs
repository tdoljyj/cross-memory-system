import os from 'node:os';
import { performance } from 'node:perf_hooks';

const LOG_LINES = 200;

// A broken clock, environment sampler or output stream must not change the test result.
function diagnostic(fn) {
  try { return fn(); } catch { return undefined; }
}

function testConcurrency() {
  const index = process.execArgv.findIndex((arg) => /^--test-concurrency(?:=|$)/.test(arg));
  if (index < 0) return null;
  return Number(process.execArgv[index].split('=')[1] ?? process.execArgv[index + 1]);
}

export function createPhaseClock(shape, {
  now = () => performance.now(),
  loadavg = os.loadavg,
  summary = (line) => process.stdout.write(`${line}\n`),
  detail = (text) => process.stderr.write(`${text}\n`),
} = {}) {
  const start = diagnostic(now);
  const startLoad = diagnostic(loadavg);
  const active = new Map();
  const phases = Object.create(null);
  const logs = [];
  let partialLine = '';
  let inFlightAtFailure;
  let reported = false;

  function mark(name, event) {
    diagnostic(() => {
      const at = now();
      if (event === 'start') {
        active.set(name, at);
      } else {
        const since = active.get(name);
        active.delete(name);
        if (since !== undefined) phases[name] = (phases[name] ?? 0) + Math.round(at - since);
      }
    });
  }

  function noteFailure(replace = false) {
    diagnostic(() => {
      if (replace || inFlightAtFailure === undefined) {
        const at = now();
        inFlightAtFailure = [...active].map(([name, since]) => ({ name, elapsed_ms: Math.round(at - since) }));
      }
    });
  }

  async function measure(name, fn) {
    mark(name, 'start');
    try {
      return await fn();
    } catch (error) {
      noteFailure();
      throw error;
    } finally {
      mark(name, 'end');
    }
  }

  async function phase(name, limitMs, fn) {
    const controller = new AbortController();
    let timer;
    try {
      return await measure(name, () => Promise.race([
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = Object.assign(new Error(`PHASE_TIMEOUT: ${name} exceeded ${limitMs} ms`), { code: 'PHASE_TIMEOUT' });
            noteFailure(true);
            reject(error);
            controller.abort(error);
          }, limitMs);
        }),
        Promise.resolve().then(() => fn(controller.signal)),
      ]));
    } finally {
      clearTimeout(timer);
    }
  }

  function postgresLog(chunk) {
    if (reported) return;
    diagnostic(() => {
      const lines = (partialLine + String(chunk)).split(/\r?\n/);
      partialLine = lines.pop();
      for (const line of lines) {
        logs.push(line);
        if (logs.length > LOG_LINES) logs.shift();
      }
    });
  }

  function report(failed) {
    if (reported) return;
    reported = true;
    diagnostic(() => summary(JSON.stringify({
      suite: 'resource-center-db', shape, total_ms: Math.round(now() - start), phases_ms: phases,
      load_start: startLoad, load_end: loadavg(), available_parallelism: os.availableParallelism(),
      test_concurrency: testConcurrency(),
    })));
    if (failed) {
      noteFailure();
      diagnostic(() => detail([
        `Resource Center DB (${shape}) failure ${JSON.stringify({ in_flight: inFlightAtFailure ?? [] })}`,
        ...[...logs, ...(partialLine ? [partialLine] : [])].slice(-LOG_LINES),
      ].join('\n')));
    }
    logs.length = 0;
    partialLine = '';
  }

  return { phase, measure, mark, noteFailure, postgresLog, report };
}
