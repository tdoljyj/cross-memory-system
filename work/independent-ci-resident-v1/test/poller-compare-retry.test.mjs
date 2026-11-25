import test from 'node:test';
import assert from 'node:assert/strict';
import { Poller } from '../src/poller.mjs';
import { restPolls } from './gh-rest-stub.mjs';

const REPO = 'tdoljyj/cross-memory-system';
const MAIN = '1c803685104719ee5584a178aee707f44262d831';
const PREVIOUS_MAIN = 'a43d06a887bc50cc42899a6ecaca3d4fef2a1556';
const HEAD = '657ec7257bcfcd28b2c641f9094fe4244a17dfe6';
const MERGED_HEAD = { number: 1308, headRefOid: HEAD, baseRefOid: MAIN, isDraft: false, updatedAt: '2026-11-25T20:10:22Z' };
const UPDATED_PR = { number: 1400, headRefOid: 'a'.repeat(40), baseRefOid: MAIN, isDraft: false, updatedAt: '2026-11-25T20:10:30Z' };
const START = Date.parse('2026-11-25T20:10:30Z');
const WINDOW_MS = 4 * 60_000;
const compareAnswer = base => ({ code: 0, stdout: JSON.stringify({ behind_by: 0, base }) });

function fixture(compare) {
  const state = { main: MAIN, pulls: [UPDATED_PR, MERGED_HEAD], now: START };
  const calls = [], written = [];
  const run = restPolls(async argv => {
    const route = argv.find(arg => arg.includes('/compare/'));
    assert.ok(route, `unexpected gh request: ${argv.join(' ')}`);
    const head = route.split('...')[1].split('?')[0];
    calls.push({ base: state.main, head, at: state.now });
    return compare(head, state.main);
  }, { main: () => state.main, pulls: () => state.pulls });
  const poller = new Poller({ repo: REPO, ghExe: 'gh-stub', run, clock: () => state.now,
    writeTrigger: async trigger => written.push({ trigger, at: state.now }) });
  return { state, poller, calls, written };
}

async function pollForFourMinutes({ state, poller }) {
  for (let elapsed = 0; elapsed <= WINDOW_MS; elapsed += 15_000) {
    state.now = START + elapsed;
    await poller.pass();
  }
}

function assertProposedWithinWindow(written) {
  const proposals = written.filter(({ trigger }) => trigger.pr === 1308);
  assert.deepEqual(proposals.map(({ trigger }) => [trigger.pr, trigger.headSha, trigger.baseSha]),
    [[1308, HEAD, MAIN]], '#1308 must be proposed once within four minutes');
  assert.ok(proposals[0].at <= START + WINDOW_MS);
}

test('#1308: a compare timeout is retried in time to propose the robot-merged head', async () => {
  let first = true;
  const f = fixture((head, base) => {
    if (head === HEAD && first) {
      first = false;
      return { timedOut: true };
    }
    return compareAnswer(base);
  });

  await pollForFourMinutes(f);

  assertProposedWithinWindow(f.written);
  assert.deepEqual(f.calls.filter(call => call.head === HEAD).map(call => call.at - START), [0, 60_000]);
});

test('#1308: the unproposed head goes before an updated, already proposed head that keeps timing out', async () => {
  const f = fixture((head, base) => head === UPDATED_PR.headRefOid && base === MAIN
    ? { timedOut: true } : compareAnswer(base));
  f.state.main = PREVIOUS_MAIN;
  f.state.now = START - 15_000;
  f.state.pulls = [{ ...UPDATED_PR, baseRefOid: PREVIOUS_MAIN, updatedAt: '2026-11-25T20:08:30Z' }];
  assert.equal(await f.poller.pass(), 1);
  f.state.main = MAIN;
  f.state.pulls = [UPDATED_PR, MERGED_HEAD];

  await pollForFourMinutes(f);

  assertProposedWithinWindow(f.written);
  assert.deepEqual(f.calls.filter(call => call.at === START).map(call => call.head), [HEAD, UPDATED_PR.headRefOid]);
});
