// The poller every 60 seconds with conditional reads (Decision 1b99e7e4): main's ref and the open pulls are REST reads with the
// ETag of their last answer; a 304 (gh exits 1 but prints the status line) keeps the last answer and proposes nothing new.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ETAG, MAIN_REF_ROUTE, PULLS_ROUTE, Poller, parseIncluded } from '../src/poller.mjs';
import { BACKSTOP_EVERY_MS, POLL_EVERY_MS, REPORT_EVERY_MS } from '../src/companion-main.mjs';
import { restAnswer, restPolls } from './gh-rest-stub.mjs';

const REPO = 'tdoljyj/cross-memory-system';
const MAIN = 'd'.repeat(40);
const TRAILER = 'Clued-Work-Claim: 842cf499-1519-4ba9-b3be-b9ac3f6e8ee4';
const compareOk = async argv => argv.some(a => a.includes('/compare/')) ? { code: 0, stdout: JSON.stringify({ behind_by: 0, base: MAIN }) } : { code: 9, stdout: '' };

test('cadence: the poller looks every 15 seconds in its own lane (f79929d9), the PR page once a minute, the ruleset backstop every five minutes', () => {
  assert.deepEqual([POLL_EVERY_MS, REPORT_EVERY_MS, BACKSTOP_EVERY_MS], [15_000, 60_000, 300_000]);
});

test('an unchanged minute is two 304s: nothing is proposed again, the last answer stands, the If-None-Match argv is exact', async () => {
  const pulls = [{ number: 884, headRefOid: 'a'.repeat(40), baseRefOid: MAIN, isDraft: false, body: TRAILER, updatedAt: '2026-10-30T01:00:00Z' }];
  const calls = [], written = [];
  const stub = restPolls(compareOk, { main: () => MAIN, pulls: () => pulls });
  const run = async (argv, o) => { calls.push(argv); return stub(argv, o); };
  const p = new Poller({ repo: REPO, ghExe: 'C:\\gh.exe', run, writeTrigger: async v => written.push(v), clock: () => 0 });
  assert.equal(await p.pass(), 1);
  assert.deepEqual(p.lastPass.reads, { fresh: 2, notModified: 0 });
  assert.deepEqual(calls[0], ['C:\\gh.exe', 'api', '--include', '--method', 'GET', MAIN_REF_ROUTE(REPO)], 'no If-None-Match before an ETag is known');
  calls.length = 0;
  assert.equal(await p.pass(), 0);
  assert.deepEqual(p.lastPass.reads, { fresh: 0, notModified: 2 });
  const listed = calls.find(a => a.includes(PULLS_ROUTE(REPO)));
  assert.deepEqual(listed.slice(0, 6), ['C:\\gh.exe', 'api', '--include', '--method', 'GET', '-H']);
  assert.match(listed[6], /^If-None-Match: W\/"[0-9a-f]{40}"$/);
  assert.equal(listed[7], PULLS_ROUTE(REPO));
  assert.deepEqual(p.lastPass.pulls.map(x => [x.pr, x.eligible]), [[884, true]], 'the kept answer is the pass\'s list');
  // the PR is edited: a new ETag, a 200, the new update time proposed once
  pulls[0].updatedAt = '2026-10-30T01:05:00Z';
  assert.equal(await p.pass(), 1);
  assert.deepEqual(p.lastPass.reads, { fresh: 1, notModified: 1 });
  assert.deepEqual(written.map(w => w.prUpdatedAt), ['2026-10-30T01:00:00.000Z', '2026-10-30T01:05:00.000Z']);
});

test('a new main tip is read fresh; drafts stay out and missing claim trailers do not hide PRs', async () => {
  let main = MAIN;
  const pulls = [
    { number: 1, headRefOid: 'a'.repeat(40), baseRefOid: MAIN, isDraft: false, body: TRAILER, updatedAt: 't' },
    { number: 2, headRefOid: 'b'.repeat(40), baseRefOid: MAIN, isDraft: true, body: TRAILER, updatedAt: 't' },
    { number: 3, headRefOid: 'c'.repeat(40), baseRefOid: MAIN, isDraft: false, body: 'no trailer', updatedAt: 't' },
  ];
  const cmp = async argv => argv.some(a => a.includes('/compare/')) ? { code: 0, stdout: JSON.stringify({ behind_by: 0, base: main }) } : { code: 9, stdout: '' };
  const p = new Poller({ repo: REPO, ghExe: 'C:\\gh.exe', run: restPolls(cmp, { main: () => main, pulls: () => pulls }), writeTrigger: async () => {}, clock: () => 0 });
  assert.equal(await p.pass(), 2);
  main = 'e'.repeat(40);
  await p.pass();
  assert.deepEqual(p.lastPass.reads, { fresh: 1, notModified: 1 });
  assert.equal(p.lastPass.mainSha, main);
  assert.equal(p.lastPass.pulls[0].hint, 'push-any-commit', 'its base is the old main now');
});

test('refusals: no answer, another status, a 304 with nothing kept, a body of the wrong shape; a bad ETag is never sent back', async () => {
  const answers = {
    none: { code: 1, stdout: '', stderr: 'gh: connection refused' },
    status: { code: 1, stdout: 'HTTP/2.0 502 Bad Gateway\r\n\r\n', stderr: 'gh: HTTP 502' },
    unexpected304: { code: 1, stdout: 'HTTP/2.0 304 Not Modified\r\nEtag: "x"\r\n\r\n', stderr: 'gh: HTTP 304' },
    shape: { code: 0, stdout: 'HTTP/2.0 200 OK\r\nEtag: "y"\r\n\r\n{"not":"a list"}' },
  };
  for (const [name, answer] of Object.entries(answers)) {
    const run = async argv => argv.some(a => a.endsWith('/git/ref/heads/main')) ? restAnswer(argv, { object: { sha: MAIN } }) : answer;
    const p = new Poller({ repo: REPO, ghExe: 'C:\\gh.exe', run, writeTrigger: async () => {}, clock: () => 0 });
    await assert.rejects(p.pass(), { code: 'POLLER_PULLS_UNAVAILABLE' }, name);
  }
  // an ETag GitHub would never send (a quote, a CR or a header injection) is not kept: the next read carries no If-None-Match
  const calls = [];
  const bad = 'W/"a\r\nX-Evil: 1"';
  const run = async argv => {
    calls.push(argv);
    if (argv.some(a => a.endsWith('/git/ref/heads/main'))) return { code: 0, stdout: `HTTP/2.0 200 OK\r\nEtag: ${bad}\r\n\r\n${JSON.stringify({ object: { sha: MAIN } })}` };
    return { code: 0, stdout: `HTTP/2.0 200 OK\r\nEtag: "ok\\"x"\r\n\r\n[]` };
  };
  const p = new Poller({ repo: REPO, ghExe: 'C:\\gh.exe', run, writeTrigger: async () => {}, clock: () => 0 });
  await p.pass(); await p.pass();
  assert.ok(calls.every(a => !a.includes('-H')), 'no If-None-Match with an ETag of another shape');
  assert.equal(ETAG.test('W/"0123abcd"'), true);
  for (const e of ['"a b"', 'W/"x"y"', '', '"' + 'a'.repeat(129) + '"', 'abc']) assert.equal(ETAG.test(e), false, e);
});

test('main\'s ref: the same refusals; a 304 counts only with gh\'s exit code 1; a 200 without an ETag drops the kept one; routes are literal', async () => {
  assert.equal(PULLS_ROUTE(REPO), 'repos/tdoljyj/cross-memory-system/pulls?state=open&base=main&per_page=50');
  assert.equal(MAIN_REF_ROUTE(REPO), 'repos/tdoljyj/cross-memory-system/git/ref/heads/main');
  const bad = [{ code: 1, stdout: '' }, { code: 1, stdout: 'HTTP/2.0 404 Not Found\r\n\r\n' }, { code: 1, stdout: 'HTTP/2.0 304 Not Modified\r\n\r\n' },
    { code: 0, stdout: 'HTTP/2.0 200 OK\r\n\r\n{"object":{"sha":"short"}}' }];
  for (const answer of bad) {
    const p = new Poller({ repo: REPO, ghExe: 'C:\\gh.exe', run: async () => answer, writeTrigger: async () => {}, clock: () => 0 });
    await assert.rejects(p.pass(), { code: 'POLLER_MAIN_TIP_UNAVAILABLE' }, answer.stdout);
  }
  // a kept value exists, but the 304 comes with another exit code (a timed-out or refused call): not taken
  let mode = 'fresh';
  const run = async argv => {
    if (!argv.some(a => a.endsWith('/git/ref/heads/main'))) return restAnswer(argv, []);
    if (mode === 'fresh') return { code: 0, stdout: `HTTP/2.0 200 OK\r\nEtag: "m1"\r\n\r\n${JSON.stringify({ object: { sha: MAIN } })}` };
    if (mode === 'timedOut') return { code: null, stdout: 'HTTP/2.0 304 Not Modified\r\n\r\n', timedOut: true };
    if (mode === 'noEtag') return { code: 0, stdout: `HTTP/2.0 200 OK\r\n\r\n${JSON.stringify({ object: { sha: MAIN } })}` };
    return { code: 1, stdout: 'HTTP/2.0 304 Not Modified\r\n\r\n', stderr: 'gh: HTTP 304' };
  };
  const calls = [];
  const p = new Poller({ repo: REPO, ghExe: 'C:\\gh.exe', run: async (a, o) => { calls.push(a); return run(a, o); }, writeTrigger: async () => {}, clock: () => 0 });
  await p.pass();
  mode = 'timedOut';
  await assert.rejects(p.pass(), { code: 'POLLER_MAIN_TIP_UNAVAILABLE' });
  mode = 'notModified';
  await p.pass();
  assert.equal(p.lastPass.mainSha, MAIN);
  mode = 'noEtag';
  await p.pass();
  calls.length = 0;
  mode = 'notModified';
  await assert.rejects(p.pass(), { code: 'POLLER_MAIN_TIP_UNAVAILABLE' }, 'no ETag kept after a 200 without one: a 304 has nothing to stand for');
  assert.ok(!calls[0].includes('-H'), 'and no If-None-Match was sent');
});

test('parseIncluded reads gh\'s --include output with CRLF or LF, takes the last ETag line, and refuses anything else', () => {
  assert.deepEqual(parseIncluded('HTTP/2.0 200 OK\r\nEtag: W/"ab"\r\n\r\n[1]'), { status: 200, etag: 'W/"ab"', body: '[1]' });
  assert.deepEqual(parseIncluded('HTTP/1.1 304 Not Modified\nETag: "cd"\n\n'), { status: 304, etag: '"cd"', body: '' });
  assert.deepEqual(parseIncluded('HTTP/2.0 200 OK\r\nX-A: 1\r\n\r\n{"etag":"in the body"}'), { status: 200, etag: null, body: '{"etag":"in the body"}' });
  for (const t of [null, '', '[1]', 'gh: HTTP 304', 'HTTP/2.0 OK\r\n\r\n']) assert.equal(parseIncluded(t), null, String(t));
});
