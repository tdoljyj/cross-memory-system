// Node test reporter for the known-failure rule of the required test checks
// (Task 2a5fdb66; scripts/ci/ci-required-selection.mjs). It is loaded from the
// trusted base checkout with --test-reporter=<this file> and writes one JSON
// line per event it keeps:
//   {"type":"fail","file":<abs>,"path":[names...],"failure_type":...,"fingerprint":...,"ms":...?}
//   {"type":"pass","file":<abs>,"path":[names...],"skip":true?,"ms":...?}   (skip only for a skipped test)
//   {"type":"summary","counts":{...},"success":bool}   (the run's own summary)
//   {"type":"begin"|"end","file":<abs>|null,"nesting":n,"name":...,"ms":...?,"wallFile":<abs>?}
//      (Node's test:dequeue / test:complete, wallFile only on a file's completion)
//   {"type":"metronome","n":<samples>,"median_ms":<number>|null}   (null if the run ended before the first tick)
// begin and end come as Node runs the tests, not in report order, and Node sends
// both for each test file itself (its name is the file's path): what began and
// did not end when the entry ended a command at its limit is what hung there
// (ci-required-selection.mjs unfinishedTests). What decides a command reads
// only the other lines.
// Every test:fail counts: a test, a suite, a hook (failure_type hookFailed), a
// parent that throws after its subtests, a file that fails to load. So does
// an error from asynchronous activity after a test ended (an uncaught
// exception or unhandled rejection), which Node reports only as a diagnostic.
// Left out: a parent that failed only because a subtest failed
// (subtestsFailed; the subtest carries the failure) and a todo test (Node
// does not fail the run for it). The fingerprint identifies why a test
// failed, so a known test failing for another reason is a new failure.
// The top-level file's completion includes loading, hooks and process exit. Its
// ms is the shard weight, with top-level test ms as a fallback.
// The metronome uses fixed JavaScript integer work because SHA-256 throughput
// varies with hardware SHA instruction support and skews comparisons between hosts.
import { createHash } from 'node:crypto';
import path from 'node:path';

const ASYNC_AFTER_END = /generated asynchronous activity after the test ended|triggered an? (?:uncaughtException|unhandledRejection) event/;

// The failure's message with what varies between runs and machines removed:
// absolute paths and file URLs (also escaped ones, with doubled separators),
// random temporary-directory suffixes (mkdtemp's six characters), line:column
// positions, hex digests, durations, timestamps and long numbers (ids, ports,
// times). Small numbers stay, so
// "expected 23, got 22" and "expected 24, got 22" are different failures.
export function normalizeFailure(message) {
  return String(message ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/file:\/\/\/?[^\s'"`)\]]+/g, '<path>')
    .replace(/(?:[A-Za-z]:)?(?:[\\/]+[^\s'"`)\]\\/:]+){2,}[\\/]*/g, '<path>')
    .replace(/-(?=[A-Za-z0-9]{6}\b)(?=[a-z]*[A-Z0-9])[A-Za-z0-9]{6}\b/g, '-<tmp>')
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z?/g, '<time>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/:\d+:\d+\b/g, ':<line>')
    .replace(/\b\d+(?:\.\d+)?\s?ms\b/g, '<ms>')
    .replace(/\b\d{5,}(?:\.\d+)?\b/g, '<n>')
    .replace(/\b\d+\.\d{3,}\b/g, '<n>')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .slice(0, 4000);
}

// A package or module that cannot be loaded: the run proves nothing about the change.
export const MISSING_DEPENDENCY = new Set(['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND']);
const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
]);

export function failureFingerprint(error) {
  const cause = error?.cause ?? error;
  const text = `${error?.failureType ?? ''}\n${cause?.code ?? ''}\n${normalizeFailure(cause?.message ?? cause)}`;
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

// A top-level test's duration as {ms}, or nothing.
const timed = (data) => (data.nesting === 0 && Number.isFinite(data.details?.duration_ms) ? { ms: Math.round(data.details.duration_ms) } : {});

const METRONOME_WORDS = 16 * 1024;
const METRONOME_ROUNDS = 640;

export function metronomeWorkload() {
  const words = new Uint32Array(METRONOME_WORDS);
  let mixed = 1;
  for (let round = 0; round < METRONOME_ROUNDS; round += 1) {
    for (let index = 0; index < words.length; index += 1) {
      mixed ^= words[index];
      mixed ^= mixed << 13;
      mixed ^= mixed >>> 17;
      mixed ^= mixed << 5;
      words[index] = mixed;
    }
  }
  return words;
}

export default async function* reporter(source, { workload = metronomeWorkload } = {}) {
  const samples = [];
  const timer = setInterval(() => {
    const start = performance.now();
    workload();
    samples.push(performance.now() - start);
  }, 5_000).unref();
  try {
    yield* testEvents(source);
  } finally {
    clearInterval(timer);
  }
  samples.sort((a, b) => a - b);
  const n = samples.length;
  const middle = Math.floor(n / 2);
  const median_ms = n === 0 ? null : (samples[Math.floor((n - 1) / 2)] + samples[middle]) / 2;
  yield `${JSON.stringify({ type: 'metronome', n, median_ms })}\n`;
}

async function* testEvents(source) {
  const stacks = new Map();
  const pathOf = (data) => {
    const stack = stacks.get(data.file) ?? [];
    return [...stack.slice(0, data.nesting), data.name];
  };
  for await (const event of source) {
    const data = event.data ?? {};
    if (event.type === 'test:start') {
      const stack = stacks.get(data.file) ?? [];
      stack.length = data.nesting;
      stack[data.nesting] = data.name;
      stacks.set(data.file, stack);
    } else if (event.type === 'test:fail') {
      const error = data.details?.error;
      if (error?.failureType === 'subtestsFailed' || (data.todo !== undefined && data.todo !== false)) continue;
      const cause = error?.cause ?? error;
      const code = cause?.code;
      const networkFailure = NETWORK_ERROR_CODES.has(code) || NETWORK_ERROR_CODES.has(cause?.cause?.code);
      yield `${JSON.stringify({ type: 'fail', file: data.file ?? null, path: pathOf(data), failure_type: error?.failureType ?? null,
        fingerprint: failureFingerprint(error), ...(MISSING_DEPENDENCY.has(code) ? { missing_dependency: code } : {}),
        ...(networkFailure ? { network_failure: true } : {}), ...timed(data) })}\n`;
    } else if (event.type === 'test:diagnostic' && ASYNC_AFTER_END.test(String(data.message ?? ''))) {
      // Without process isolation the diagnostic names no file; it is still a
      // failure, recorded under <run> so it never matches a known entry.
      const message = String(data.message);
      const test = /Test "([^"]*)"/.exec(message)?.[1] ?? '<file>';
      yield `${JSON.stringify({ type: 'fail', file: data.file ?? null, path: [data.file ? '<async activity after the test ended>' : '<run>', test],
        failure_type: 'asyncActivityAfterTest', fingerprint: failureFingerprint({ failureType: 'asyncActivityAfterTest', message }) })}\n`;
    } else if (event.type === 'test:pass') {
      // A skipped test is reported as passed by Node; it did not run (a failure run alone again must run).
      const skipped = data.skip !== undefined && data.skip !== false;
      yield `${JSON.stringify({ type: 'pass', file: data.file ?? null, path: pathOf(data), ...(skipped ? { skip: true } : {}), ...timed(data) })}\n`;
    } else if (event.type === 'test:dequeue' || event.type === 'test:complete') {
      const complete = event.type === 'test:complete';
      // Node can use the relative operand as the wrapper's name. Resolve it in the reporter's command cwd.
      const fileEnd = complete && data.nesting === 0 && !data.entryFile && typeof data.name === 'string'
        && (data.file ? path.relative(data.file, data.name) === '' : path.isAbsolute(data.name));
      yield `${JSON.stringify({ type: complete ? 'end' : 'begin', file: data.file ?? null, nesting: data.nesting, name: data.name,
        ...(complete ? timed(data) : {}), ...(fileEnd ? { wallFile: data.file ?? data.name } : {}) })}\n`;
    } else if (event.type === 'test:summary' && data.file === undefined) {
      yield `${JSON.stringify({ type: 'summary', counts: data.counts ?? null, success: data.success === true })}\n`;
    }
  }
}
