import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { selectSuites } from './ci-required-selection.mjs';

const script = fileURLToPath(new URL('./check-cron-budget.mjs', import.meta.url));
const repository = fileURLToPath(new URL('../../', import.meta.url));
const worker = 'apps/example/wrangler.production.jsonc';
const migration = 'apps/example/supabase/migrations/001_cron.sql';
const successor = 'apps/example/supabase/migrations/002_cron.sql';
const allowlist = 'scripts/ci/cron-budget-allowlist.json';

function fixture(t) {
  const root = mkdtempSync(path.join(repository, '.cron-budget-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  function write(file, content) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
    execFileSync('git', ['add', '--', file], { cwd: root, stdio: 'pipe' });
  }
  write(allowlist, JSON.stringify({ wrangler: [], pgCron: [] }));
  return { write, run: () => {
    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    assert.ifError(result.error);
    return { status: result.status, output: result.stdout + result.stderr };
  } };
}

function check(result, expected) {
  assert.equal(result.status, expected ? 1 : 0, result.output);
  if (expected) assert.match(result.output, expected);
}

test('18: the current every-minute Wrangler expression fails; */10 passes in JSONC', (t) => {
  const repo = fixture(t);
  const writeCron = (schedule) => repo.write(worker, `{\n  // Trigger in UTC\n  "vars": { "URL": "https://example.test/*" },\n  "triggers": { "crons": ["${schedule}",], },\n}`);
  writeCron('* * * * *');
  check(repo.run(), /wrangler\.production\.jsonc:.*less than 10 minutes/i);
  writeCron('*/10 * * * *');
  check(repo.run());
});

test('Wrangler rejects multiple triggers in a named environment and a five-minute hour-boundary gap', (t) => {
  const repo = fixture(t);
  repo.write(worker, '{"env":{"preview":{"triggers":{"crons":["0 * * * *","10 * * * *"]}}}}');
  check(repo.run(), /env\.preview\.triggers\.crons.*exactly one/i);
  repo.write(worker, '{"triggers":{"crons":["0,55 * * * *"]}}');
  check(repo.run(), /less than 10 minutes/i);
  repo.write(worker, '{"triggers":{"crons":[]}}');
  check(repo.run());
});

test('Wrangler checks midnight when either a restricted month day or a weekday can trigger', (t) => {
  const repo = fixture(t);
  repo.write(worker, '{"triggers":{"crons":["0,55 0,23 1 * MON"]}}');
  check(repo.run(), /less than 10 minutes/i);
  repo.write(worker, '{"triggers":{"crons":["0,55 0,23 * * MON"]}}');
  check(repo.run());
});

test('19: a new every-minute cron.schedule migration fails even alongside an exempt historical job', (t) => {
  const repo = fixture(t);
  repo.write(allowlist, JSON.stringify({ wrangler: [], pgCron: [
    { file: migration, job: 'legacy', schedule: '* * * * *', owner: 'T5', expiresOn: '2099-01-01' },
  ] }));
  repo.write(migration, "select cron.schedule('legacy', '* * * * *', 'select 1');");
  check(repo.run());
  repo.write(successor, `do $body$
begin
  perform "cron"./* registration */"schedule"(
    'new-job',
    '* * * * *',
    $command$select 1$command$
  );
end $body$;`);
  const result = repo.run();
  check(result, /002_cron\.sql:3:.*new-job.*less than 10 minutes/i);
  assert.match(result.output, /legacy.*new-job|new-job.*legacy/i);
});

test('the database budget compares hours and calendar days, and catches a shared minute', (t) => {
  const repo = fixture(t);
  repo.write(migration, `-- SELECT cron.schedule('* * * * *', 'select 1');
/* outer /* SELECT cron.schedule('* * * * *', 'select 1'); */ comment */
SELECT 'cron.schedule(''* * * * *'', ''select 1'')';
SELECT cron.schedule('morning', '0 1 * * MON', 'select 1');
SELECT cron.schedule('afternoon', '0 13 * * MON', 'select 1');
SELECT cron.schedule('tuesday', '0 1 * * TUE', 'select 1');`);
  check(repo.run());
  repo.write(successor, "select cron.schedule('0 1 1 * *', 'select 1');");
  check(repo.run(), /same minute.*morning|morning.*same minute/i);
});

test('an expired exception fails until a later migration retires the named job', (t) => {
  const repo = fixture(t);
  repo.write(allowlist, JSON.stringify({ wrangler: [], pgCron: [
    { file: migration, job: 'legacy', schedule: '* * * * *', owner: 'T5', expiresOn: '2000-01-01' },
  ] }));
  repo.write(migration, "select cron.schedule('legacy', '* * * * *', 'select 1');");
  check(repo.run(), /legacy.*expired.*2000-01-01/i);
  repo.write(successor, "select cron.unschedule('legacy');");
  check(repo.run());
});

test('dynamic schedules fail closed and pg_cron second intervals exceed the budget', (t) => {
  const repo = fixture(t);
  repo.write(migration, "select cron.schedule('dynamic', current_setting('app.schedule'), 'select 1');");
  check(repo.run(), /literal schedule/i);
  repo.write(migration, "select cron.schedule('seconds', '30 seconds', 'select 1');");
  check(repo.run(), /seconds.*less than 10 minutes/i);
});

test('a historical compliant collision peer is exempt only when paired with an unexpired legacy job', (t) => {
  const repo = fixture(t);
  repo.write(allowlist, JSON.stringify({ wrangler: [], pgCron: [
    { file: migration, job: 'legacy', schedule: '* * * * *', owner: 'T5', expiresOn: '2099-01-01' },
  ], collisionPeers: [{ file: migration, job: 'existing-daily', schedule: '17 3 * * *' }] }));
  repo.write(migration, `select cron.schedule('legacy', '* * * * *', 'select 1');
select cron.schedule('existing-daily', '17 3 * * *', 'select 1');`);
  check(repo.run());
  repo.write(successor, "select cron.schedule('new-daily', '17 3 * * *', 'select 1');");
  check(repo.run(), /new-daily.*same minute.*existing-daily/i);
});

test('the required CI selector runs the budget suite for each input on both platforms', () => {
  for (const platform of ['linux', 'win32']) {
    for (const file of [worker, 'wrangler.jsonc', migration, 'migrations/001_cron.sql', allowlist]) {
      assert.ok(selectSuites('ci-suites', [file], platform).suites.includes('cron-budget'), `${platform}: ${file}`);
    }
  }
});
