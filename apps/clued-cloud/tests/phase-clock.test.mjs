import assert from 'node:assert/strict';
import test from 'node:test';
import { createPhaseClock } from './phase-clock.fixture.mjs';

function harness() {
  let elapsed = 0;
  const summaries = [];
  const details = [];
  const clock = createPhaseClock('test-shape', {
    now: () => elapsed,
    loadavg: () => [0, 0, 0],
    summary: (line) => summaries.push(JSON.parse(line)),
    detail: (text) => details.push(text),
  });
  return { clock, summaries, details, advance: (ms) => { elapsed += ms; } };
}

test('passing phases and slow cleanup can total more than the former parent deadline', async () => {
  const { clock, summaries, details, advance } = harness();
  for (const name of ['databaseSetup', 'fixture', 'qualifyCurrentCallers']) {
    await clock.phase(name, 60000, async () => advance(59000));
  }
  await clock.measure('closeConnections', async () => advance(4000));
  clock.postgresLog('PostgreSQL log from a passing case\n');
  clock.report(false);
  clock.report(false);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].shape, 'test-shape');
  assert.equal(summaries[0].total_ms, 181000);
  assert.deepEqual(summaries[0].phases_ms, {
    databaseSetup: 59000, fixture: 59000, qualifyCurrentCallers: 59000, closeConnections: 4000,
  });
  assert.deepEqual(details, []);
});

test('a stalled phase aborts with its name, skips later phases, and keeps the last 200 PostgreSQL lines', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { clock, summaries, details, advance } = harness();
  clock.postgresLog(Array.from({ length: 235 }, (_, i) => `line-${i + 1}\n`).join(''));
  clock.postgresLog('partial');
  clock.postgresLog('-line\r\n');
  let signal;
  let ranLaterPhase = false;
  const result = (async () => {
    await clock.phase('blockedFixture', 60000, (phaseSignal) => {
      signal = phaseSignal;
      return new Promise(() => {});
    });
    ranLaterPhase = true;
  })();
  await Promise.resolve();
  advance(60000);
  t.mock.timers.tick(60000);
  await assert.rejects(result, { code: 'PHASE_TIMEOUT', message: /blockedFixture/ });
  assert.equal(signal.aborted, true);
  assert.equal(ranLaterPhase, false);

  clock.report(true);
  assert.equal(summaries[0].phases_ms.blockedFixture, 60000);
  const [heading, ...logs] = details[0].split('\n');
  assert.match(heading, /"name":"blockedFixture","elapsed_ms":60000/);
  assert.equal(logs.length, 200);
  assert.equal(logs[0], 'line-37');
  assert.equal(logs.at(-1), 'partial-line');
});

test('diagnostic failures cannot change a phase result or mask its error', async () => {
  const fail = () => { throw new Error('diagnostic failure'); };
  const clock = createPhaseClock('test-shape', { now: fail, loadavg: fail, summary: fail, detail: fail });
  assert.equal(await clock.phase('ok', 60000, async () => 42), 42);
  const error = new Error('fixture failure');
  await assert.rejects(clock.phase('failed', 60000, async () => { throw error; }), (thrown) => thrown === error);
  assert.doesNotThrow(() => clock.report(true));

  const unwritable = createPhaseClock('test-shape', { summary: fail, detail: fail });
  assert.doesNotThrow(() => unwritable.report(true));
});
