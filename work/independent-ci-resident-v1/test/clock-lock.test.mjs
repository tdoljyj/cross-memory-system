// Task ce2e5c1a step 2: no fixture of this suite reads the real clock when its file loads, or beside a fake clock it was given
// (clock-lock.mjs says what counts, what does not, and why). The Source v2 suite holds the same lock over its own tests.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLOCK_LOCK_FIX, scanClockLock, shownFinding, testFilesIn } from './clock-lock.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const shown = (f, base = path.join(here, '..')) => shownFinding(f, base);

test('the resident suite: no fixture reads the real clock when its file loads, or beside the fake clock it takes', () => {
  const findings = scanClockLock([...testFilesIn(here), ...testFilesIn(path.join(here, '..', 'rollout', 'test'))]);
  assert.deepEqual(findings.map(f => shown(f)), [], CLOCK_LOCK_FIX);
});

// The scanner itself, shape by shape: what it stops, and what it lets through.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clock-lock-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const scan = (name, files) => {
  const dir = path.join(tmp, name, 'test'); fs.mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), text);
  return scanClockLock([path.join(dir, 'x.test.mjs')]).map(f => shown(f, dir));
};

test('the lock stops a real-clock read at load time, in a before() hook, and through a load-time call', () => {
  assert.deepEqual(scan('load', { 'x.test.mjs': [
    'const A = Date.now();',
    'const B = new Date().toISOString(), C = new Date;',
    'const stamp = (at = new Date().toISOString()) => JSON.stringify({ at });',
    'const D = stamp();',
    'const W = `function Read { ${stamp(\'x\')} }`;',
    'describe(\'d\', () => { const t = performance.now(); });',
    'before(() => { globalThis.started = Date.now(); });',
    'const xs = [1].map(() => Date.now());',
    'const later = (clockFn = Date.now) => clockFn();',
    'const E = later();',
    'import { helperStamp } from \'./helper.mjs\';',
    'const F = helperStamp();',
    'const G = (() => Date())();',
  ].join('\n'), 'helper.mjs': 'export function helperStamp() { return nested(); }\nfunction nested() { return Date.now(); }\n' }), [
    'x.test.mjs:1 load Date.now()',
    'x.test.mjs:2 load new Date()',
    'x.test.mjs:2 load new Date()',
    'x.test.mjs:4 load stamp() reads the clock',
    'x.test.mjs:5 load stamp() reads the clock',
    'x.test.mjs:6 load performance.now()',
    'x.test.mjs:7 before Date.now()',
    'x.test.mjs:8 load Date.now()',
    'x.test.mjs:10 load later() reads the clock',
    'x.test.mjs:12 load helperStamp() reads the clock',
    'x.test.mjs:13 load Date()',
  ]);
});

test('the lock stops a fixture that takes a fake clock and calls the real one beside it', () => {
  assert.deepEqual(scan('mixed', { 'x.test.mjs': [
    'const iso = ms => new Date(ms).toISOString();',
    'const jobsFor = () => ({ createdAt: iso(Date.now() - 60000) });',
    'async function publisherWith(t, steps, { clock = null } = {}) {',
    '  const now = () => clock ? clock.now : Date.now();',
    '  const job = jobsFor();',
    '  return { job, finishedAt: Date.now() - 1000, at: now() };',
    '}',
    'const run = ({ now }) => jobsFor();',
  ].join('\n') }), [
    'x.test.mjs:4 mixed Date.now() in publisherWith',
    'x.test.mjs:5 mixed jobsFor() reads the clock in publisherWith',
    'x.test.mjs:6 mixed Date.now() in publisherWith',
    'x.test.mjs:8 mixed jobsFor() reads the clock in run',
  ]);
});

test('the lock lets through reads when a test runs, strings and templates, dated constants, and the real clock passed as the clock', () => {
  assert.deepEqual(scan('allowed', { 'x.test.mjs': [
    'const T0 = \'2026-11-19T02:00:00Z\', FAR = Date.parse(\'2099-01-01T00:00:00Z\'), d = new Date(T0);',
    'const stamp = (at = new Date().toISOString()) => at;',
    'const fresh = () => Date.now();',
    'const ps = `[DateTimeOffset]::UtcNow; Date.now(); ${T0}`, s = \'new Date()\';',
    'test(\'t\', async () => { const a = Date.now(); stamp(); fresh(); });',
    'test(\'u\', { skip: false }, () => new Date());',
    'after(() => Date.now()); beforeEach(() => Date.now()); afterEach(() => Date.now());',
    'setTimeout(() => Date.now(), 1);',
    'const obj = { at() { return Date.now(); }, get now() { return Date.now(); } };',
    'function fixture(t, { clock = null } = {}) { const now = clock ? () => clock.now : Date.now; return { at: now(), fake: clock?.now }; }',
    'const jobsFor = (now = Date.now) => ({ createdAt: now() - 60000 });',
    'function withClock({ clock }) { return jobsFor(() => clock.now); }',
    'for (const [name] of [[\'a\']]) test(name, () => Date.now());',
    'const re = /Date.now()/g, half = 10 / 2;',
  ].join('\n') }), []);
});
