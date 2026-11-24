// The guard that keeps test code off the real clock (Clued Task 11092b8b; FABLE-no-real-clock-20261122 §2.2, with
// FABLE-defect-remediation-plan-20261124 §3.4). A test that reads the real time, waits on a real timer or gives a child
// process a wall-clock limit has a verdict that depends on how loaded the host is: green on a fast machine, red on a slow
// one, and a red that has nothing to do with the change. The test entry preloads this module into every suite process
// (NODE_OPTIONS=--import=<this file>, so every node a test starts gets it too; test-clock-scan.mjs clockGuardEnv), and:
//   - Date.now(), Date() and new Date() without an argument, performance.now(), process.hrtime(), process.uptime(),
//     setTimeout and setInterval (global, node:timers, node:timers/promises, scheduler.wait), AbortSignal.timeout(), and
//     a child_process call (spawn, spawnSync, exec, execSync, execFile, execFileSync, fork) with a timeout option
// are refused when the code that calls them directly is test code: a file named *.test.* or under a test, tests, fixtures
// or evals directory of the checkout (CLUED_CLOCK_ROOT). Every refusal is one line in the record (CLUED_CLOCK_RECORD) and
// a thrown REAL_CLOCK_IN_TEST error at the place; the entry fails a command whose record has a line outside the debt list
// even when the test swallowed the error. A call from a file on the debt list (config/test-clock-debt.txt, which may only
// shrink: test-clock-scan.mjs debtVerdict), in a process whose test file is on the list too, is recorded and let through
// (check: a listed helper does not lend its debt to a new test). Code under test, node_modules and node's own code are let
// through: once the test cannot read the real time, code under test that reads it and is not given a clock fails every
// time, not now and then.
// node:test's own { timeout } option and what runs outside JavaScript (PowerShell, Python, SQL in a test) are read by the
// static scan (test-clock-scan.mjs) instead: there is no preload for them.
// What a test does instead (FAILURE_HELP): a constant for a moment; t.mock.timers for time passing (with mock timers on,
// the mocked functions answer and nothing is refused); until() for a real event; sleep() and elapsedMs() only for a file
// and kind the allowlist (scripts/ci/test-clock-allow.json, a protected path: every entry is an Owner grant) names.
// This guards against writing such a test by habit, not on purpose: a new vm context, a forged source URL or a child
// started without NODE_OPTIONS get past it (review catches those).
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { importsDebt } from './test-clock-scan.mjs';

const require = createRequire(import.meta.url);
const INSTALLED = Symbol.for('clued.test-clock-guard');
export const UNTIL_LIMIT_MS = 120_000;
export const UNTIL_POLL_MS = 20;
export const ERROR_CODE = 'REAL_CLOCK_IN_TEST';
export const FAILURE_HELP = [
  'Test code may not read the real clock, wait on a real timer or give a child process a time limit (the verdict then depends on how loaded the host is).',
  '  a moment      -> a constant; pass the clock to the code under test',
  "  time passing  -> t.mock.timers.enable({ apis: ['Date', 'setTimeout'] }) and tick",
  "  a real event  -> until(probe, 'what') from scripts/ci/test-clock-guard.mjs (no duration)",
  '  a child limit -> none: the entry bounds the whole command',
  '  a real delay  -> sleep()/elapsedMs() and an entry in scripts/ci/test-clock-allow.json (Owner grant)',
].join('\n');
const TEST_CODE = /(^|\/)(tests?|fixtures|evals)\/|\.test\.[cm]?[jt]sx?$/;
const GUARD_FILE = /(^|\/)scripts\/ci\/test-clock-guard\.mjs$/;
const TEST_NAME = /\.test\.[cm]?[jt]sx?$/;
const CHILD_CALLS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];

// One installation per process: a test that imports this file (for until) from another checkout than the preloaded one
// gets the same originals and the same rules, and nothing is wrapped twice.
const state = globalThis[INSTALLED] ?? install();

function readLines(file) {
  try {
    return readFileSync(file, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  } catch {
    return [];
  }
}
function readAllow(file) {
  try {
    const entries = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

function install() {
  const real = {
    Date, now: Date.now, perfNow: performance.now.bind(performance), hrtime: process.hrtime, uptime: process.uptime,
    setTimeout: globalThis.setTimeout, setInterval: globalThis.setInterval, clearTimeout: globalThis.clearTimeout,
    abortTimeout: AbortSignal.timeout,
  };
  const env = process.env;
  // The checkout by its real path: node names a module by its real path, while the entry may give the checkout, and node
  // --test the test file, through a junction or link (review r3 §4). A path that cannot be resolved is taken as it is.
  const realPath = (file) => {
    try {
      return realpathSync.native(file);
    } catch {
      return file;
    }
  };
  const root = env.CLUED_CLOCK_ROOT ? realPath(path.resolve(env.CLUED_CLOCK_ROOT)) : null;
  let debt = null;
  let allow = null;
  const s = {
    real, root, record: env.CLUED_CLOCK_RECORD || null,
    debt: () => (debt ??= new Set(root ? readLines(path.join(root, 'config', 'test-clock-debt.txt')) : [])),
    allow: () => (allow ??= root ? readAllow(path.join(root, 'scripts', 'ci', 'test-clock-allow.json')) : []),
  };
  globalThis[INSTALLED] = s;
  // Imported for until() outside the entry (no checkout given): there is no debt list to judge by, so nothing is wrapped
  // or refused, and a test that imports until() runs as before where the entry does not preload the guard.
  if (!root) {
    Object.assign(s, { check() {}, caller: () => null, testFile: () => null, note() {} });
    return s;
  }

  // The file of the frame that called the wrapped function: the first frame with a file name (a builtin such as
  // Array.prototype.map has none). A call from node's own code (node:...) is node's business: let through.
  function caller(above) {
    const prepare = Error.prepareStackTrace;
    const limit = Error.stackTraceLimit;
    let sites;
    try {
      Error.prepareStackTrace = (_, frames) => frames;
      Error.stackTraceLimit = 10;
      const holder = {};
      Error.captureStackTrace(holder, above);
      sites = holder.stack;
    } finally {
      Error.prepareStackTrace = prepare;
      Error.stackTraceLimit = limit;
    }
    for (const site of Array.isArray(sites) ? sites : []) {
      let file = site.getFileName?.() ?? site.getScriptNameOrSourceURL?.();
      if (!file) continue;
      if (file.startsWith('node:')) return null;
      if (file.startsWith('file:')) {
        try {
          file = fileURLToPath(file);
        } catch {
          return null;
        }
      }
      return { file, line: site.getLineNumber() };
    }
    return null;
  }
  // The checkout path of a test-code file, or null for anything else (code under test, node_modules, a file outside the
  // checkout); a file named through a junction or link is read by its real path too (once a name).
  const named = new Map();
  function testFile(file) {
    if (!named.has(file)) {
      const absolute = path.resolve(file);
      named.set(file, nameIn(absolute) ?? nameIn(realPath(absolute)));
    }
    return named.get(file);
  }
  function nameIn(absolute) {
    const relative = root ? path.relative(root, absolute) : absolute;
    if (root && (relative.startsWith('..') || path.isAbsolute(relative))) return null;
    const name = relative.split(path.sep).join('/');
    if (/(^|\/)node_modules\//.test(name) || GUARD_FILE.test(name) || !TEST_CODE.test(name)) return null;
    return name;
  }
  function note(entry) {
    if (!s.record) return;
    try {
      appendFileSync(s.record, `${JSON.stringify({ ...entry, pid: process.pid })}\n`);
    } catch { /* the thrown error still stops the test */ }
  }
  // The test file this process runs: node --test starts one process a file (no suite uses --test-isolation=none), so it
  // is process.argv[1]; null when that is not test code (a script under test, node -e).
  let entry;
  const launched = process.argv[1];
  const entryFile = () => (entry === undefined ? (entry = launched ? testFile(launched) : null) : entry);
  // Whether a listed test of this process runs `file`: the entry when it is listed; else a listed *.test.* file the entry
  // imports (an aggregate test such as apps/clued-cloud/tests/local-dev-tools.test.mjs), when it is `file` or imports it.
  // A listed helper the entry imports is not such a test: an unlisted test that imports helpers.mjs borrows nothing.
  const read = (file) => {
    try {
      return readFileSync(path.join(root, file), 'utf8');
    } catch {
      return null;
    }
  };
  const runsListed = new Map();
  function listedTestRuns(file, test, list) {
    if (list.has(test)) return true;
    if (!runsListed.has(file)) {
      const reaches = (from) => from === file || importsDebt(from, { read, listed: new Set([file]), hitsOf: () => 1 });
      const tests = new Set([...list].filter((name) => TEST_NAME.test(name)));
      runsListed.set(file, importsDebt(test, { read, listed: tests, hitsOf: (name) => (reaches(name) ? 1 : 0) }));
    }
    return runsListed.get(file);
  }
  // Refuses `api` called from test code, recording it. A real-clock use is the debt of the file that makes the call (its
  // count on the list only shrinks, so the fix is measured where the code is) and of the test the process runs: a listed
  // helper (helpers.mjs waitFor) lets through only a listed test, so a new test cannot borrow a helper's debt. The test is
  // the process's, not one read off the stack: after an await in the helper the stack no longer has the test's frame.
  function check(api, above) {
    const site = caller(above);
    if (!site) return;
    const file = testFile(site.file);
    if (!file) return;
    const test = entryFile();
    const list = s.debt();
    const debt = list.has(file) && (test === null || listedTestRuns(file, test, list));
    note({ api, file, line: site.line, entry: test, debt });
    if (debt) return;
    const via = test && test !== file ? ` (run by ${test}, which the debt list does not name)` : '';
    const error = new Error(`${ERROR_CODE}: ${api} at ${file}:${site.line}${via}\n${FAILURE_HELP}`);
    error.code = ERROR_CODE;
    throw error;
  }
  s.check = check;
  s.caller = caller;
  s.testFile = testFile;
  s.note = note;

  const wrap = (api, fn) => {
    const wrapped = function (...args) {
      check(api, wrapped);
      return new.target ? Reflect.construct(fn, args, new.target) : fn.apply(this, args);
    };
    Object.defineProperty(wrapped, 'name', { value: fn.name });
    return wrapped;
  };

  const now = function now() {
    check('Date.now()', now);
    return real.now.call(real.Date);
  };
  // The traps are the frames the stack is cut above (a proxy is not a frame of its own).
  function construct(target, args, newTarget) {
    if (args.length === 0) check('new Date()', construct);
    return Reflect.construct(target, args, newTarget === GuardedDate ? target : newTarget);
  }
  function apply(target, self, args) {
    check('Date()', apply);
    return Reflect.apply(target, self, args);
  }
  // Date.now answers through the guard until the test puts its own clock there (Date.now = fake, t.mock.method): the
  // assignment lands on the real Date, and what is there then is what Date.now is. Putting the real one back is the guard again.
  const GuardedDate = new Proxy(real.Date, {
    construct, apply,
    get(target, key) {
      const value = Reflect.get(target, key, target);
      return key === 'now' && value === real.now ? now : value;
    },
  });
  globalThis.Date = GuardedDate;

  const perfNow = function now() {
    check('performance.now()', perfNow);
    return real.perfNow();
  };
  performance.now = perfNow;
  const hrtime = function hrtime(...args) {
    check('process.hrtime()', hrtime);
    return real.hrtime.apply(process, args);
  };
  hrtime.bigint = function bigint() {
    check('process.hrtime.bigint()', hrtime.bigint);
    return real.hrtime.bigint();
  };
  process.hrtime = hrtime;
  process.uptime = wrap('process.uptime()', real.uptime);

  const timers = require('node:timers');
  const timersPromises = require('node:timers/promises');
  const guardedSetTimeout = wrap('setTimeout', real.setTimeout);
  const guardedSetInterval = wrap('setInterval', real.setInterval);
  const promisesSetTimeout = wrap('timers/promises.setTimeout', timersPromises.setTimeout);
  // util.promisify(setTimeout) goes through the custom promisified function: the guarded one.
  Object.defineProperty(guardedSetTimeout, promisify.custom, { value: promisesSetTimeout, configurable: true });
  globalThis.setTimeout = guardedSetTimeout;
  globalThis.setInterval = guardedSetInterval;
  timers.setTimeout = guardedSetTimeout;
  timers.setInterval = guardedSetInterval;
  timersPromises.setTimeout = promisesSetTimeout;
  timersPromises.setInterval = wrap('timers/promises.setInterval', timersPromises.setInterval);
  if (timersPromises.scheduler?.wait) {
    const wait = timersPromises.scheduler.wait.bind(timersPromises.scheduler);
    timersPromises.scheduler.wait = wrap('scheduler.wait', wait);
  }
  AbortSignal.timeout = wrap('AbortSignal.timeout()', real.abortTimeout);

  // A time limit on a child process (§3.4): any timeout option a test passes. The entry bounds the whole command instead.
  const childProcess = require('node:child_process');
  // util.promisify(exec) and util.promisify(execFile) take the function's promisify.custom, which calls node's own exec
  // without passing the wrapper: the custom one is wrapped the same way.
  const limited = (name, args, above) => {
    const options = args.find((arg) => arg && typeof arg === 'object' && !Array.isArray(arg));
    const limit = options?.timeout;
    if (limit !== undefined && limit !== null && limit !== 0 && limit !== Infinity) check(`${name}({ timeout })`, above);
  };
  for (const name of CHILD_CALLS) {
    const original = childProcess[name];
    const guarded = function (...args) {
      limited(name, args, guarded);
      return original.apply(this, args);
    };
    Object.defineProperty(guarded, 'name', { value: name });
    const custom = original[promisify.custom];
    if (custom) {
      const guardedCustom = function (...args) {
        limited(name, args, guardedCustom);
        return custom.apply(this, args);
      };
      Object.defineProperty(guarded, promisify.custom, { value: guardedCustom, configurable: true });
    }
    childProcess[name] = guarded;
  }
  syncBuiltinESMExports();
  return s;
}

// The allowlist entry of the calling file for `kind`, or a refusal like any other.
function allowed(kind, above) {
  const site = state.caller(above);
  const file = site && state.testFile(site.file);
  if (!file) return;
  if (state.allow().some((entry) => entry?.file === file && entry?.kind === kind)) return;
  state.check(`${kind}() without an allowlist entry`, above);
}

// Waits for a real event: `probe` is a promise or a function polled until it returns (or resolves to) a truthy value,
// which until returns. There is no duration to give: the only bound is the guard's own (UNTIL_LIMIT_MS), and reaching it
// is a failure naming `what`.
export async function until(probe, what) {
  if (typeof what !== 'string' || !what) throw new TypeError("until(probe, 'what is awaited'): say what is awaited");
  const { real } = state;
  let timer;
  const limit = new Promise((_, reject) => {
    timer = real.setTimeout(() => reject(new Error(`until: ${what} did not happen within ${UNTIL_LIMIT_MS} ms`)), UNTIL_LIMIT_MS);
    timer.unref?.();
  });
  const poll = async () => {
    if (typeof probe !== 'function') return probe;
    for (;;) {
      const value = await probe();
      if (value) return value;
      await new Promise((resolve) => real.setTimeout(resolve, UNTIL_POLL_MS));
    }
  };
  try {
    return await Promise.race([poll(), limit]);
  } finally {
    real.clearTimeout(timer);
  }
}

// A real delay, for a file the allowlist names with kind "sleep" (its reason says why the test is about real time).
export function sleep(ms, why) {
  if (typeof why !== 'string' || !why) throw new TypeError("sleep(ms, 'why'): say why a real delay is needed");
  allowed('sleep', sleep);
  return new Promise((resolve) => state.real.setTimeout(resolve, ms));
}

// A stopwatch, for a file the allowlist names with kind "elapsedMs": returns a function giving the milliseconds since.
export function elapsedMs() {
  allowed('elapsedMs', elapsedMs);
  const started = state.real.perfNow();
  return () => state.real.perfNow() - started;
}
