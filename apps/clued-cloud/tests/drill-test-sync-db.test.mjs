// Drill test project sync (Task 87d330d0; design FABLE-drill-test-project-sync-20261124 §1, §4.1 and the ruling at its end).
//
// scripts/drill-test-sync.mjs brings the hosted test project clued-auth-test to
// production's applied migration list: the same rows, in production's order,
// each with the text production ran. These tests run it offline against an
// embedded PostgreSQL with the platform stand-ins the drift check uses; the
// production list is the committed ledger (supabase/ledger/production-history.json).
// Nothing here reads a credential or connects to a hosted database.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from '../scripts/generated/drill-pg.mjs';
import { withCluster } from '../scripts/production-schema-drift.mjs';
import { readRepository, readSnapshot } from '../scripts/production-schema-chain.mjs';

const sync = () => import('../scripts/drill-test-sync.mjs');
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const nowEpoch = () => Math.floor(Date.now() / 1000);
const fresh = (sub) => ({ sub, role: 'authenticated', session_id: 'sess-drill', aal: 'aal1', amr: [{ method: 'password', timestamp: nowEpoch() }] });
const row = (version, name, statements_md5) => ({ version, name, statements_md5 });

test('the connection is built from constants: no input routes it to production', async () => {
  const { connectionConfig, DRILL_TEST_REF, PRODUCTION_REF } = await sync();
  assert.equal(DRILL_TEST_REF, 'uscrdifznmlvczcekqpw');
  assert.equal(PRODUCTION_REF, 'ccxsikzwxlolxqlosril');
  const host = 'aws-0-ap-northeast-2.pooler.supabase.com';
  const passwords = ['plain', `p@db.${PRODUCTION_REF}.supabase.co:5432/postgres`, `x?host=db.${PRODUCTION_REF}.supabase.co&user=postgres.${PRODUCTION_REF}`,
    `postgresql://postgres.${PRODUCTION_REF}:y@${host}:5432/postgres`, 'a b#c/d%40e'];
  const saved = { ...process.env };
  // libpq-style variables of the environment do not override an explicit configuration either.
  Object.assign(process.env, { PGHOST: `db.${PRODUCTION_REF}.supabase.co`, PGUSER: `postgres.${PRODUCTION_REF}`, PGDATABASE: 'other', PGPORT: '6543',
    DATABASE_URL: `postgresql://postgres.${PRODUCTION_REF}:y@${host}:5432/postgres` });
  try {
    for (const password of passwords) {
      const config = connectionConfig({ password, host });
      assert.deepEqual(Object.keys(config).sort(), ['connectionTimeoutMillis', 'database', 'host', 'password', 'port', 'ssl', 'user']);
      const { password: kept, ...routing } = config;
      assert.equal(kept, password, 'the password is passed as it is, never parsed');
      assert.deepEqual({ host: routing.host, port: routing.port, user: routing.user, database: routing.database },
        { host, port: 5432, user: `postgres.${DRILL_TEST_REF}`, database: 'postgres' });
      assert.ok(routing.ssl, 'the session pooler is reached over TLS');
      assert.ok(!JSON.stringify(routing).includes(PRODUCTION_REF));
      const client = new pg.Client(config);
      assert.deepEqual([client.host, client.port, client.user, client.database], [host, 5432, `postgres.${DRILL_TEST_REF}`, 'postgres']);
    }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
  // The host is the session pooler of some region and nothing else; the tenant is the user name's suffix.
  for (const refused of [undefined, '', `db.${PRODUCTION_REF}.supabase.co`, `db.${DRILL_TEST_REF}.supabase.co`, 'example.invalid',
    `${host}:6543`, `${host}/postgres?user=postgres.${PRODUCTION_REF}`, `${PRODUCTION_REF}.pooler.supabase.com`, `x@${host}`, ` ${host}`]) {
    assert.throws(() => connectionConfig({ password: 'plain', host: refused }), { code: 'DRILL_SERVER_POOLER_HOST_NOT_SET' }, String(refused));
  }
  for (const refused of [undefined, '', 7]) {
    assert.throws(() => connectionConfig({ password: refused, host }), { code: 'DRILL_SERVER_DATABASE_CREDENTIAL_MISSING' }, String(refused));
  }
});

test('the plan: a prefix is caught up, anything else is diverged, an older list changes nothing', async () => {
  const { planSync } = await sync();
  const production = [row('20260101000000', 'a', 'm1'), row('20260102000000', 'b', 'm2'), row('20260103000000', 'c', 'm3'), row('20260104000000', 'd', 'm4')];
  assert.deepEqual(planSync({ production, test: [] }), { state: 'behind', missing: production });
  assert.deepEqual(planSync({ production, test: production.slice(0, 2) }), { state: 'behind', missing: production.slice(2) });
  assert.deepEqual(planSync({ production, test: production }), { state: 'in-sync', missing: [] });
  // Rows are compared in version order, whatever order they arrive in.
  assert.deepEqual(planSync({ production: [...production].reverse(), test: [production[1], production[0]] }), { state: 'behind', missing: production.slice(2) });
  // One row in the middle with another text: nothing is applied.
  const changed = [production[0], row('20260102000000', 'b', 'other'), production[2]];
  assert.deepEqual(planSync({ production, test: changed }),
    { state: 'diverged', missing: [], at: { index: 1, production: production[1], test: changed[1] } });
  assert.equal(planSync({ production, test: [production[0], row('20260102000000', 'renamed', 'm2')] }).state, 'diverged');
  assert.equal(planSync({ production, test: [production[0], production[2]] }).state, 'diverged');
  // The test project holds a row production never ran.
  assert.equal(planSync({ production: production.slice(0, 2), test: [production[0], production[1], row('20260102120000', 'local', 'x')] }).state, 'stale');
  assert.equal(planSync({ production: production.slice(0, 2), test: [production[0], row('20260101120000', 'local', 'x'), production[1]] }).state, 'diverged');
  // An older production list (a late run of an earlier release): the test project is already past it.
  assert.deepEqual(planSync({ production: production.slice(0, 3), test: production }), { state: 'stale', missing: [] });
  assert.throws(() => planSync({ production: [], test: [] }), /production_applied_missing/);
});

test('sync on a database: rebuild, catch up a prefix, refuse a diverged history, parking and project fixtures, nothing left behind',
  { timeout: 1_500_000 }, async () => {
  const { syncDatabase, seedFixtures, readTestHistory, runSync, DRILL_TEST_REF, RESULT_CONTRACT } = await sync();
  const repository = await readRepository();
  const snapshot = await readSnapshot();
  // Production's applied list as the release workflow exports it (supabase/production-schema/applied.sql).
  const production = repository.ledger.rows.map(({ version, name, statements_md5, statements_length }) =>
    ({ version, name, statements_md5, statements_length })).sort((a, b) => a.version.localeCompare(b.version));
  const identity = (rows) => rows.map(({ version, name, statements_md5 }) => `${version} ${name} ${statements_md5}`);
  // The first-install kit's scope (record.scope): a project of some id. The sync is given it, it holds none.
  const kitProject = crypto.randomUUID();
  const kitScope = `project:${kitProject}`;

  await withCluster('drill-sync', async (admin) => {
    const run = (options) => syncDatabase(admin, { repository, snapshot, platform: 'embedded', scope: kitScope, ...options });
    // The sync leaves no function of its own in the database (the ruling's section 2): production's history refuses an
    // anon-callable public.clued_* function it does not know, and the host has the result without one.
    const leftBehind = async () => (await admin.query(`select p.oid::regprocedure::text as name from pg_catalog.pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.proname ~ 'drill'`)).rows.map((r) => r.name);
    const user = crypto.randomUUID();
    // The hosted auth.users has created_at; the embedded stand-in does not.
    await admin.query('alter table auth.users add column created_at timestamptz default clock_timestamp()');
    await admin.query(`insert into auth.users(id,email,email_confirmed_at) values($1,'drill@example.invalid',now())`, [user]);
    const projects = async () => (await admin.query('select id, user_id, context_key from public.clued_projects order by id')).rows;

    // --- First run: rebuild from empty to a production list three rows short. ---
    const earlier = production.slice(0, -3);
    const first = await run({ applied: earlier, rebuild: true });
    assert.deepEqual(Object.keys(first).sort(), ['applied', 'fixtures', 'state']);
    assert.equal(first.state, 'in-sync');
    assert.equal(first.applied.length, earlier.length);
    assert.deepEqual(first.fixtures, { users: 1, seeded: 1, project: 'seeded', project_account: 'd***@example.invalid' }, 'the account present gets its parking spot and the kit\'s project in the same run');
    assert.deepEqual(await projects(), [{ id: kitProject, user_id: user, context_key: kitScope }]);
    assert.deepEqual(identity(await readTestHistory(admin)), identity(earlier));
    assert.deepEqual(await leftBehind(), []);

    // --- One row in the middle differs: diverged, no file applied. ---
    const middle = earlier[Math.floor(earlier.length / 2)];
    const original = (await admin.query('select statements from supabase_migrations.schema_migrations where version=$1', [middle.version])).rows[0].statements;
    await admin.query('update supabase_migrations.schema_migrations set statements=$2 where version=$1', [middle.version, ['-- another text']]);
    const diverged = await run({ applied: production });
    assert.equal(diverged.state, 'diverged');
    assert.deepEqual(diverged.applied, []);
    assert.equal(diverged.at.production.version, middle.version);
    assert.equal((await readTestHistory(admin)).length, earlier.length, 'no file was applied');
    assert.deepEqual(await leftBehind(), []);

    // The host's call on this database: the list from a file, the scope from the kit, the password from standard
    // input; its answer is a code. (The stand-in for the pooler's login is this cluster's own.)
    const directory = await mkdtemp(path.join(os.tmpdir(), 'drill-sync-call-'));
    const file = async (name, value) => { const at = path.join(directory, name); await writeFile(at, JSON.stringify(value)); return at; };
    const serverFile = await file('drill-server.json', { supabaseUrl: `https://${DRILL_TEST_REF}.supabase.co`, poolerHost: 'aws-0-ap-northeast-2.pooler.supabase.com' });
    const kitFile = await file('first-install-kit.json', { record: { scope: kitScope, repository: 'tdoljyj/cross-memory-system' } });
    const hostCall = async (list) => {
      const seen = [];
      const stand = { user: `postgres.${DRILL_TEST_REF}`, query: (...args) => admin.query(...args), end: async () => {} };
      const result = runSync(['--applied', await file('applied.json', { contract: 'clued.production-applied.v1', applied: list }), '--kit', kitFile, '--server', serverFile],
        { stdin: async () => 'a password', tool: async () => null, connect: async (pg, config) => { seen.push(config); return stand; } });
      return { result, seen };
    };
    try {
      const refused = await hostCall(production);
      await assert.rejects(refused.result, (error) => error.code === 'DRILL_SERVER_DIVERGED' && error.message.includes(middle.version) && !error.message.includes('a password'));
      assert.deepEqual(refused.seen.map((config) => [config.user, config.host, config.password]),
        [[`postgres.${DRILL_TEST_REF}`, 'aws-0-ap-northeast-2.pooler.supabase.com', 'a password']]);
      await admin.query('update supabase_migrations.schema_migrations set statements=$2 where version=$1', [middle.version, original]);
      // In sync with the list it was given: nothing to apply, and the result names what the drill's receipt records.
      assert.deepEqual(await (await hostCall(earlier)).result, { contract: RESULT_CONTRACT, state: 'in-sync',
        production_last: { version: earlier.at(-1).version, name: earlier.at(-1).name }, production_rows: earlier.length, applied: 0,
        fixtures: { users: 1, seeded: 0, project: 'present', project_account: 'd***@example.invalid' } });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

    // --- A prefix: exactly the missing rows are applied, in production's order. ---
    const during = [];
    const caught = await run({ applied: production, log: async () => { during.push(await leftBehind()); } });
    assert.deepEqual(during, [[], [], []]);
    assert.equal(caught.state, 'in-sync');
    assert.deepEqual(caught.applied, production.slice(-3).map((r) => `${r.version}_${r.name}`));
    assert.deepEqual(identity(await readTestHistory(admin)), identity(production));
    // Again: nothing to do.
    const again = await run({ applied: production });
    assert.deepEqual([again.state, again.applied, again.fixtures], ['in-sync', [], { users: 1, seeded: 0, project: 'present', project_account: 'd***@example.invalid' }]);
    // An older list arriving late changes nothing.
    const late = await run({ applied: earlier });
    assert.deepEqual(late, { state: 'stale', applied: [] });
    assert.deepEqual(identity(await readTestHistory(admin)), identity(production));

    const sessions = (account) => {
      const human = async (name, input) => {
        await admin.query('begin');
        try {
          await admin.query('set local role authenticated');
          await admin.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)", [account, JSON.stringify(fresh(account))]);
          const value = (await admin.query(`select public.${name}($1) v`, [input])).rows[0].v;
          await admin.query('commit');
          return value;
        } catch (error) { await admin.query('rollback'); throw error; }
      };
      return async (resource) => {
        const confirmation = await human('clued_headless_binding_confirmation_issue_v1',
          { label: 'drill', days: 90, selected: [{ resource_kind: 'scope', resource_id: resource, environment: 'canonical', actions: ['read'] }] });
        if (confirmation.status !== 'issued') return confirmation;
        return human('clued_headless_binding_issue_v1', { confirmation_token: confirmation.confirmation_token, view_digest: confirmation.view_digest });
      };
    };
    // The request the drill's guest (and before it the host) makes: the token's hash, the kit's scope and repository.
    const holders = async (token, scope) => {
      await admin.query('set role anon');
      try {
        return (await admin.query('select public.clued_work_merge_slot_holders_v1($1,$2::jsonb) v',
          [sha256(token), JSON.stringify({ scope, repository: 'tdoljyj/cross-memory-system' })])).rows[0].v;
      } finally { await admin.query('reset role'); }
    };
    const NOT_HELD = { status: 'ok', holders: [], reason: 'admission_binding_required' };

    // --- Which token the Owner issues for the drill (the ruling's section 3; the kit's scope is a project). ---
    {
      // An account that does not own that project (it signed up after the sync; parking seeded here, no project).
      const stranger = crypto.randomUUID();
      await admin.query(`insert into auth.users(id,email,email_confirmed_at) values($1,'drill-stranger@example.invalid',now())`, [stranger]);
      assert.deepEqual(await seedFixtures(admin, { scope: kitScope }), { users: 2, seeded: 1, project: 'present', project_account: 'd***@example.invalid' });
      // 1. "All contexts, read only" is not enough by itself: the token is issued and answers for the personal
      //    scope, but for the kit's project it is refused. The fixture has to hold the project.
      const everything = await sessions(stranger)('contexts:*');
      assert.equal(everything.status, 'committed', JSON.stringify({ ...everything, token: undefined }));
      assert.deepEqual((await admin.query('select scopes, context_keys from public.clued_agent_bindings where id=$1', [everything.binding_id])).rows,
        [{ scopes: ['context:read'], context_keys: ['*'] }]);
      assert.deepEqual(await holders(everything.token, 'global'), NOT_HELD);
      await assert.rejects(() => holders(everything.token, kitScope), /resource_action_not_authorized/);
      // Nor can that account issue a token for the project.
      assert.equal((await sessions(stranger)(kitScope)).error_code, 'selection_exceeds_requested_or_owned_permissions');
      // 2. The account the fixture gave the project to: a read-only token for that project is issued and is
      //    answered "holds no role", the answer the drill needs.
      const drill = await sessions(user)(kitScope);
      assert.equal(drill.status, 'committed', JSON.stringify({ ...drill, token: undefined }));
      assert.deepEqual(await holders(drill.token, kitScope), NOT_HELD);
      // For that account "all contexts, read only" is answered the same: either choice works once the project is there.
      const wide = await sessions(user)('contexts:*');
      assert.equal(wide.status, 'committed', JSON.stringify({ ...wide, token: undefined }));
      assert.deepEqual(await holders(wide.token, kitScope), NOT_HELD);
    }

    // --- The drill Binding and the parking spot (§1.4, §4.1; pending question 2). ---
    // An account that signs up between two syncs has no parking spot yet.
    const owner = user;
    {
      const user = crypto.randomUUID();
      await admin.query(`insert into auth.users(id,email,email_confirmed_at) values($1,'drill-late@example.invalid',now())`, [user]);
      await lateAccount(user);
    }
    async function lateAccount(user) {
    const issue = sessions(user);
    const parkingRows = async () => (await admin.query(`select count(*)::int n from clued_private.binding_roles_v1
      where user_id=$1 and role='ci-admission' and purpose='parking' and revoked_at is null`, [user])).rows[0].n;
    // With nothing but its auth.users row the account can issue a read-only token for the global scope.
    const drill = await issue('global');
    assert.equal(drill.status, 'committed', JSON.stringify(drill));
    // The account never marked ci-admission: the server admits every Binding, so the probe reads "held".
    assert.equal(await parkingRows(), 0);
    const open = await holders(drill.token, 'global');
    assert.deepEqual([open.status, open.holders, open.reason], ['ok', [], undefined], JSON.stringify(open));
    // The fixture: one parking spot per account, through the product's own functions.
    assert.deepEqual(await seedFixtures(admin, { scope: 'global' }), { users: 3, seeded: 1, project: null, project_account: null });
    assert.equal(await parkingRows(), 1);
    assert.deepEqual(await holders(drill.token, 'global'), NOT_HELD);
    assert.deepEqual(await seedFixtures(admin, { scope: kitScope }), { users: 3, seeded: 0, project: 'present', project_account: 'd***@example.invalid' }, 'a second run adds nothing');
    assert.equal(await parkingRows(), 1);
    // The parking Binding's token was never returned to this process and admits nobody.
    const parking = (await admin.query(`select b.id,b.vendor,b.agent_name,b.scopes,b.context_keys from clued_private.binding_roles_v1 r
      join public.clued_agent_bindings b on b.id=r.binding_id where r.user_id=$1 and r.purpose='parking' and r.revoked_at is null`, [user])).rows[0];
    assert.deepEqual([parking.vendor, parking.agent_name, parking.scopes, parking.context_keys], ['Headless', 'drill-parking', ['context:read'], ['global']]);
    assert.equal((await admin.query(`select clued_private.binding_role_admits_v1(b,'ci-admission') ok from public.clued_agent_bindings b where b.id=$1`,
      [parking.id])).rows[0].ok, false);

    // --- Rebuild over a populated database: application data goes, auth stays, the parking fixture comes back. ---
    const rebuilt = await run({ applied: production, rebuild: true, scope: 'global' });
    assert.equal(rebuilt.state, 'in-sync');
    assert.equal(rebuilt.applied.length, production.length);
    assert.deepEqual(rebuilt.fixtures, { users: 3, seeded: 3, project: null, project_account: null });
    assert.deepEqual(identity(await readTestHistory(admin)), identity(production));
    assert.equal((await admin.query('select count(*)::int n from auth.users')).rows[0].n, 3);
    assert.equal(await parkingRows(), 1);
    assert.equal((await admin.query('select count(*)::int n from public.clued_agent_bindings where user_id=$1', [user])).rows[0].n, 1,
      'the drill Binding issued before the rebuild is gone; only the parking Binding exists');
    await assert.rejects(() => holders(drill.token, 'global'), /binding_not_authorized|authorization_revoked_or_expired/);
    assert.deepEqual(await leftBehind(), []);
    assert.equal((await admin.query(`select count(*)::int n from clued_private.binding_roles_v1
      where user_id=$1 and role='ci-admission' and purpose='parking' and revoked_at is null`, [owner])).rows[0].n, 1);
    }
  });
});

test('two accounts and no project: the kit\'s project goes to the account that signed up first, the other gets parking only',
  { timeout: 1_500_000 }, async () => {
  const { syncDatabase, seedFixtures } = await sync();
  const repository = await readRepository();
  const snapshot = await readSnapshot();
  const production = repository.ledger.rows.map(({ version, name, statements_md5, statements_length }) =>
    ({ version, name, statements_md5, statements_length }));
  const kitProject = crypto.randomUUID();
  const kitScope = `project:${kitProject}`;
  await withCluster('drill-sync-two', async (admin) => {
    // The hosted auth.users has created_at; the embedded stand-in does not.
    await admin.query('alter table auth.users add column created_at timestamptz');
    // The earlier account has the greater id and the later e-mail: only the sign-up time decides.
    const earlier = 'ffffffff-0000-4000-8000-000000000002';
    const later = '00000000-0000-4000-8000-000000000001';
    const gone = '00000000-0000-4000-8000-000000000000';
    await admin.query(`insert into auth.users(id,email,email_confirmed_at,created_at,deleted_at) values
      ($1,'quiet.owner@qq.com',now(),'2026-09-03T00:00:00Z',null), ($2,'another@example.invalid',now(),'2026-09-05T00:00:00Z',null),
      ($3,'deleted@example.invalid',now(),'2026-09-01T00:00:00Z',now())`, [earlier, later, gone]);
    const projects = async () => (await admin.query('select id, user_id, context_key from public.clued_projects order by id')).rows;
    const parking = async () => (await admin.query(`select user_id from clued_private.binding_roles_v1
      where role='ci-admission' and purpose='parking' and revoked_at is null order by user_id`)).rows.map((r) => r.user_id);

    const first = await syncDatabase(admin, { applied: production, repository, snapshot, platform: 'embedded', scope: kitScope, rebuild: true });
    assert.equal(first.state, 'in-sync');
    // The account the Owner signs in with, told without its full address.
    assert.deepEqual(first.fixtures, { users: 2, seeded: 2, project: 'seeded', project_account: 'q***@qq.com' });
    assert.ok(!JSON.stringify(first).includes('quiet.owner'));
    assert.deepEqual(await projects(), [{ id: kitProject, user_id: earlier, context_key: kitScope }]);
    assert.deepEqual(await parking(), [later, earlier]);

    // Again: nothing changes, and the answer names the same account.
    const again = await syncDatabase(admin, { applied: production, repository, snapshot, platform: 'embedded', scope: kitScope });
    assert.deepEqual([again.state, again.applied, again.fixtures], ['in-sync', [], { users: 2, seeded: 0, project: 'present', project_account: 'q***@qq.com' }]);
    assert.deepEqual(await seedFixtures(admin, { scope: kitScope }), { users: 2, seeded: 0, project: 'present', project_account: 'q***@qq.com' });
    assert.deepEqual(await projects(), [{ id: kitProject, user_id: earlier, context_key: kitScope }]);
    assert.deepEqual(await parking(), [later, earlier]);

    // The later account: parking, no project; its "all contexts, read only" token is refused for the kit's scope.
    const human = async (name, input) => {
      await admin.query('begin');
      try {
        await admin.query('set local role authenticated');
        await admin.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)", [later, JSON.stringify(fresh(later))]);
        const value = (await admin.query(`select public.${name}($1) v`, [input])).rows[0].v;
        await admin.query('commit');
        return value;
      } catch (error) { await admin.query('rollback'); throw error; }
    };
    const confirmation = await human('clued_headless_binding_confirmation_issue_v1',
      { label: 'drill', days: 90, selected: [{ resource_kind: 'scope', resource_id: 'contexts:*', environment: 'canonical', actions: ['read'] }] });
    const wide = await human('clued_headless_binding_issue_v1', { confirmation_token: confirmation.confirmation_token, view_digest: confirmation.view_digest });
    assert.equal(wide.status, 'committed', JSON.stringify({ ...wide, token: undefined }));
    await admin.query('set role anon');
    try {
      await assert.rejects(() => admin.query('select public.clued_work_merge_slot_holders_v1($1,$2::jsonb) v',
        [sha256(wide.token), JSON.stringify({ scope: kitScope, repository: 'tdoljyj/cross-memory-system' })]), /resource_action_not_authorized/);
    } finally { await admin.query('reset role'); }
  });
});

// PLAN-drill-test-platform-acl-20261124 section 3. The hosted platform image newer than production's gives PUBLIC
// SELECT on pg_cron's own sequences (granted by supabase_admin); the worker gateway migrations refuse any effective
// privilege on any sequence, so their replay stopped there. On the hosted platform the executed text of that one
// predicate differs; the recorded text and its md5 stay production's.
const GATEWAY_FILES = ['migrations/20261009070002_worker_gateway_transition_v1.sql', 'migrations/20261010161848_worker_gateway_closeout_v1.sql'];
const PRODUCTION_PREDICATE = `pg_catalog.has_sequence_privilege('clued_worker_gateway',c.oid,'USAGE,SELECT,UPDATE') else false end)`;
const HOSTED_PREDICATE = `pg_catalog.has_sequence_privilege('clued_worker_gateway',c.oid,'USAGE,UPDATE')`;
const ledgerApplied = (repository) => repository.ledger.rows.map(({ version, name, statements_md5, statements_length }) =>
  ({ version, name, statements_md5, statements_length })).sort((a, b) => a.version.localeCompare(b.version));

test('hosted platform: only the two worker gateway rows run another sequence predicate; what is recorded is production\'s text', async () => {
  const { resolveSteps } = await sync();
  const repository = await readRepository();
  const snapshot = await readSnapshot();
  const applied = ledgerApplied(repository);
  const hosted = resolveSteps({ applied, repository, snapshot, platform: 'hosted' }).steps;
  const embedded = resolveSteps({ applied, repository, snapshot, platform: 'embedded' }).steps;
  assert.deepEqual(embedded.filter((step) => step.statements.includes(PRODUCTION_PREDICATE)).map((step) => step.file), GATEWAY_FILES,
    'the rows that carry the predicate');
  assert.deepEqual(hosted.filter((step) => step.run !== null && step.run.includes(HOSTED_PREDICATE)).map((step) => step.file), GATEWAY_FILES);
  for (const file of GATEWAY_FILES) {
    const [there, here] = [hosted, embedded].map((steps) => steps.find((step) => step.file === file));
    const source = repository.migrations[file.slice('migrations/'.length)];
    // Recorded: the text production stores, on both platforms.
    assert.equal(there.statements, here.statements, file);
    assert.equal(there.statements_md5, here.statements_md5, file);
    assert.equal(crypto.createHash('md5').update(there.statements).digest('hex'), there.statements_md5, file);
    assert.ok(!there.statements.includes(HOSTED_PREDICATE), file);
    // Executed: the embedded replay runs the file as it is; the hosted one differs in that predicate and nowhere else.
    assert.equal(here.run, source, file);
    assert.ok(!there.run.includes(PRODUCTION_PREDICATE), file);
    const [before, after] = source.split(PRODUCTION_PREDICATE);
    assert.ok(there.run.startsWith(before) && there.run.endsWith(after), file);
    const replaced = there.run.slice(before.length, there.run.length - after.length);
    // Membership and existence tests, never a comparison with to_regnamespace('cron'): without a cron schema that is
    // NULL and no sequence's SELECT would be refused.
    assert.ok(replaced.includes(`c.relnamespace in (select n.oid from pg_catalog.pg_namespace n where n.nspname='cron')`), file);
    assert.ok(replaced.includes('exists(select 1 from pg_catalog.pg_roles r where r.oid=c.relowner and r.rolsuper)'), file);
    assert.ok(!replaced.includes('to_regnamespace'), file);
    // The diagnostic keeps production's predicate (it ends the line there, without the closing parenthesis).
    assert.equal(there.run.split(`pg_catalog.has_sequence_privilege('clued_worker_gateway',c.oid,'USAGE,SELECT,UPDATE')`).length, 2, file);
  }
  // Every other row runs the same text on both platforms, the rows the embedded replay stands pg_cron in for aside.
  const other = hosted.filter((step, index) => step.run !== embedded[index].run).map((step) => step.file).filter((file) => !GATEWAY_FILES.includes(file));
  for (const file of other) {
    assert.ok((snapshot.replay_substitutions ?? []).some((entry) => entry.file === file && /^create\s+extension\b/i.test(entry.find)), file);
  }
});

test('hosted platform on a database: PUBLIC SELECT on the platform\'s cron sequence does not stop the replay, anything wider does',
  { timeout: 1_500_000 }, async () => {
  const { syncDatabase, resolveSteps, applyStep, readTestHistory } = await sync();
  const repository = await readRepository();
  const snapshot = await readSnapshot();
  const production = ledgerApplied(repository);
  const identity = (rows) => rows.map(({ version, name, statements_md5 }) => `${version} ${name} ${statements_md5}`);
  const hosted = resolveSteps({ applied: production, repository, snapshot, platform: 'hosted' }).steps;
  const gatewayAt = hosted.findIndex((step) => step.file === GATEWAY_FILES[0]);
  const gateway = hosted[gatewayAt];
  assert.ok(gatewayAt > 0 && production[gatewayAt].version === gateway.version);

  await withCluster('drill-sync-acl', async (admin) => {
    // The hosted auth.users has created_at; the embedded stand-in does not.
    await admin.query('alter table auth.users add column created_at timestamptz default clock_timestamp()');
    // 1. Everything before the first worker gateway row, as the embedded replay runs it. Row by row: the fixtures
    //    syncDatabase ends with need tables of later rows.
    const before = production.slice(0, gatewayAt);
    const embedded = resolveSteps({ applied: production, repository, snapshot, platform: 'embedded' });
    for (const [index, step] of embedded.steps.slice(0, gatewayAt).entries()) await applyStep(admin, step, index === 0 ? embedded.prehistory : []);
    assert.deepEqual(identity(await readTestHistory(admin)), identity(before));
    // 2. The test project's platform: PUBLIC reads the cron sequence, a superuser owns it, nobody else enters the schema.
    await admin.query('grant select on sequence cron.job_jobid_seq to public');
    assert.deepEqual((await admin.query(`select r.rolsuper, pg_catalog.has_schema_privilege('authenticator', 'cron', 'USAGE') as enters,
        exists(select 1 from pg_catalog.aclexplode(c.relacl) a where a.grantee = 0 and a.privilege_type = 'SELECT') as public_select
      from pg_catalog.pg_class c join pg_catalog.pg_roles r on r.oid = c.relowner where c.oid = 'cron.job_jobid_seq'::regclass`)).rows,
      [{ rolsuper: true, enters: false, public_select: true }]);

    // 3. The narrowness, before the replay goes on. The gateway row as the hosted platform runs it; a refused row is
    //    rolled back (applyStep), so the same database serves every case.
    const refused = async (label, { arrange, restore, kind, object }) => {
      await admin.query(arrange);
      try {
        await assert.rejects(applyStep(admin, gateway), (error) => {
          assert.equal(error.code, `DRILL_SERVER_SYNC_FAILED:${GATEWAY_FILES[0]}`, `${label}: ${error.message}`);
          assert.ok(error.detail.startsWith('worker_gateway_role_unexpected_privileges {'), `${label}: ${error.detail}`);
          const found = JSON.parse(error.detail.slice(error.detail.indexOf('{'))).violations;
          assert.ok(found.some((v) => v.kind === kind && v.object === object), `${label}: ${JSON.stringify(found)}`);
          return true;
        }, label);
      } finally { await admin.query(restore); }
      assert.equal((await readTestHistory(admin)).length, before.length, `${label}: nothing was recorded`);
    };
    await refused('PUBLIC USAGE on the cron sequence', { kind: 'sequence_permission', object: 'cron.job_jobid_seq',
      arrange: 'grant usage on sequence cron.job_jobid_seq to public', restore: 'revoke usage on sequence cron.job_jobid_seq from public' });
    await refused('PUBLIC UPDATE on the cron sequence', { kind: 'sequence_permission', object: 'cron.job_jobid_seq',
      arrange: 'grant update on sequence cron.job_jobid_seq to public', restore: 'revoke update on sequence cron.job_jobid_seq from public' });
    await refused('a cron sequence no superuser owns', { kind: 'sequence_permission', object: 'cron.drill_acl_seq',
      arrange: `create role drill_acl_owner nologin; create sequence cron.drill_acl_seq; alter sequence cron.drill_acl_seq owner to drill_acl_owner;
        grant select on sequence cron.drill_acl_seq to public`,
      restore: 'drop sequence cron.drill_acl_seq; drop role drill_acl_owner' });
    await refused('a sequence of another schema', { kind: 'sequence_permission', object: 'drill_acl_other.readable_seq',
      arrange: 'create schema drill_acl_other; create sequence drill_acl_other.readable_seq; grant select on sequence drill_acl_other.readable_seq to public',
      restore: 'drop schema drill_acl_other cascade' });
    await refused('SELECT granted to the role itself', { kind: 'sequence_permission', object: 'cron.job_jobid_seq',
      arrange: `create role clued_worker_gateway nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
        grant select on sequence cron.job_jobid_seq to clued_worker_gateway`,
      restore: 'drop owned by clued_worker_gateway; drop role clued_worker_gateway' });
    await refused('PUBLIC enters the cron schema', { kind: 'schema_permission', object: 'cron',
      arrange: 'grant usage on schema cron to public', restore: 'revoke usage on schema cron from public' });

    // 4. With the platform's grant alone, the hosted replay catches up to production's whole list, both worker
    //    gateway rows included. (Before the hosted predicate: DRILL_SERVER_SYNC_FAILED at the first of them, its
    //    detail a sequence_permission on cron.job_jobid_seq, the error of 2026-11-24.)
    const caught = await syncDatabase(admin, { applied: production, repository, snapshot, platform: 'hosted', scope: 'global' });
    assert.equal(caught.state, 'in-sync');
    assert.deepEqual(caught.applied, production.slice(gatewayAt).map((r) => `${r.version}_${r.name}`));
    assert.deepEqual(identity(await readTestHistory(admin)), identity(production));
    assert.equal((await admin.query(`select pg_catalog.has_sequence_privilege('clued_worker_gateway', 'cron.job_jobid_seq', 'SELECT') as reads`)).rows[0].reads, true,
      'the platform\'s grant is still there: the row was not let through by removing it');
  });
});

test('the host\'s call: password from standard input only, pooler host from drill-server.json, scope from the kit, an answer in codes', async () => {
  const { runSync, readPoolerHost, readKitScope, connected, applyStep, connectionConfig, CODES, DRILL_TEST_REF, PRODUCTION_REF, RESULT_CONTRACT } = await sync();
  assert.deepEqual([...CODES].sort(), ['DRILL_SERVER_DATABASE_CREDENTIAL_MISSING', 'DRILL_SERVER_DATABASE_CREDENTIAL_REFUSED', 'DRILL_SERVER_DIVERGED',
    'DRILL_SERVER_POOLER_HOST_NOT_SET', 'DRILL_SERVER_PRODUCTION_LIST_MISSING', 'DRILL_SERVER_SYNC_FAILED', 'DRILL_SERVER_UNREACHABLE']);
  const script = fileURLToPath(new URL('../scripts/drill-test-sync.mjs', import.meta.url));
  const source = await readFile(script, 'utf8');
  assert.doesNotMatch(source, /process\.env|\benv\b|CLUED_DRILL_TEST_|GITHUB_/, 'the script reads no environment variable');
  assert.doesNotMatch(source, /drill_sync_receipt|NOT_IN_SYNC|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/, 'no receipt, no scope written down');
  const repository = await readRepository();
  const applied = repository.ledger.rows.map(({ version, name, statements_md5, statements_length }) => ({ version, name, statements_md5, statements_length }));
  const host = 'aws-0-ap-northeast-2.pooler.supabase.com';
  const url = `https://${DRILL_TEST_REF}.supabase.co`;
  const scope = `project:${crypto.randomUUID()}`;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'drill-sync-host-'));
  const file = async (name, value) => { const at = path.join(directory, name); await writeFile(at, typeof value === 'string' ? value : JSON.stringify(value)); return at; };
  try {
    // --- drill-server.json: the pooler's host name, of this project's file, in the session pooler's shape. ---
    const server = { contract: 'clued.drill.server/1', project: 'clued-auth-test', supabaseUrl: url, blackholeHosts: [], allowedHosts: [] };
    assert.equal(await readPoolerHost(await file('server.json', { ...server, poolerHost: host })), host);
    assert.equal(await readPoolerHost(await file('server-bom.json', `\uFEFF${JSON.stringify({ ...server, poolerHost: host })}`)), host);
    for (const [label, value] of [['no field', server], ['a placeholder', { ...server, poolerHost: null }], ['empty', { ...server, poolerHost: '' }],
      ['a placeholder text', { ...server, poolerHost: 'aws-N-REGION.pooler.supabase.com' }], ['the direct address', { ...server, poolerHost: `db.${DRILL_TEST_REF}.supabase.co` }],
      ['production\'s direct address', { ...server, poolerHost: `db.${PRODUCTION_REF}.supabase.co` }], ['a port', { ...server, poolerHost: `${host}:6543` }],
      ['another project\'s file', { ...server, supabaseUrl: `https://${PRODUCTION_REF}.supabase.co`, poolerHost: host }],
      ['no address', { poolerHost: host }], ['an array', [host]], ['not JSON', '{']]) {
      await assert.rejects(readPoolerHost(await file('refused.json', value)), { code: 'DRILL_SERVER_POOLER_HOST_NOT_SET' }, label);
    }
    await assert.rejects(readPoolerHost(path.join(directory, 'absent.json')), { code: 'DRILL_SERVER_POOLER_HOST_NOT_SET' });

    // --- The scope: the kit's record.scope or the value given, in the shape the kit allows. ---
    assert.equal(await readKitScope(await file('kit.json', { record: { scope, repository: 'tdoljyj/cross-memory-system' } })), scope);
    assert.equal(await readKitScope(await file('kit-global.json', { record: { scope: 'global' } })), 'global');
    for (const value of [{ record: {} }, { record: { scope: 'project:*' } }, { record: { scope: 'contexts:*' } }, { scope }, '{']) {
      await assert.rejects(readKitScope(await file('kit-refused.json', value)), /drill_test_scope_invalid/);
    }

    // --- The call. Each refusal that needs no password comes before the password is read. ---
    const appliedFile = await file('applied.json', { contract: 'clued.production-applied.v1', applied });
    const serverFile = await file('server.json', { ...server, poolerHost: host });
    const kitFile = await file('kit.json', { record: { scope } });
    const base = ['--applied', appliedFile, '--kit', kitFile, '--server', serverFile];
    const call = (argv, overrides = {}) => {
      const seen = { stdin: 0, connect: [] };
      const promise = runSync(argv, { stdin: async () => { seen.stdin += 1; return 'pw'; }, tool: async () => null,
        connect: async (pg, config) => { seen.connect.push(config); throw new Error('test: no database here'); }, ...overrides });
      return { promise, seen };
    };
    const refusedBeforePassword = async (argv, expected, overrides) => {
      const { promise, seen } = call(argv, overrides);
      await assert.rejects(promise, expected);
      assert.deepEqual(seen, { stdin: 0, connect: [] }, JSON.stringify(expected));
    };
    for (const argv of [[], ['--applied', appliedFile], ['--applied', appliedFile, '--kit', kitFile, '--scope', scope], ['--kit', kitFile], ['--applied', appliedFile, '--scope']]) {
      await refusedBeforePassword(argv, /^Error: usage: /);
    }
    await refusedBeforePassword(['--applied', appliedFile, '--scope', 'project:*'], /drill_test_scope_invalid/);
    // No tool given: the client is the generated module (scripts/generated/drill-pg.mjs), the one this file connects with.
    const handed = [];
    await assert.rejects(runSync(base, { stdin: async () => 'pw', connect: async (client) => { handed.push(client); throw new Error('test: no database here'); } }), /test: no database here/);
    assert.equal(handed.length, 1); assert.equal(typeof handed[0].Client, 'function'); assert.equal(handed[0], pg);
    // The release run exported no list (no file), or what is there is not one.
    await refusedBeforePassword(['--applied', path.join(directory, 'absent.json'), '--kit', kitFile, '--server', serverFile], { code: 'DRILL_SERVER_PRODUCTION_LIST_MISSING' });
    await refusedBeforePassword(['--applied', await file('empty.json', { applied: [] }), '--kit', kitFile, '--server', serverFile], { code: 'DRILL_SERVER_PRODUCTION_LIST_MISSING' });
    await refusedBeforePassword(['--applied', appliedFile, '--kit', kitFile, '--server', await file('unset.json', server)], { code: 'DRILL_SERVER_POOLER_HOST_NOT_SET' });

    // --- The password: standard input, as it is. Nothing given: no connection is tried. ---
    const saved = { ...process.env };
    Object.assign(process.env, { CLUED_DRILL_TEST_DATABASE_PASSWORD: 'from-the-environment', PGPASSWORD: 'from-the-environment', CLUED_DRILL_TEST_POOLER_HOST: host });
    try {
      const none = call(base, { stdin: async () => '' });
      await assert.rejects(none.promise, { code: 'DRILL_SERVER_DATABASE_CREDENTIAL_MISSING' });
      assert.deepEqual(none.seen.connect, [], 'an environment variable is not a password');
      const given = call(base, { stdin: async () => ' p@ss word#%\t' });
      await assert.rejects(given.promise, /test: no database here/);
      assert.deepEqual(given.seen.connect, [connectionConfig({ password: ' p@ss word#%\t', host })]);
      // The command itself, with nothing on standard input and a password in the environment: the code, no connection.
      const child = spawnSync(process.execPath, [script, ...base], { input: '', encoding: 'utf8', env: process.env, timeout: 120_000 });
      assert.equal(child.status, 1, child.stderr);
      assert.deepEqual(JSON.parse(child.stdout.trim().split('\n').at(-1)), { contract: RESULT_CONTRACT, state: 'failed', code: 'DRILL_SERVER_DATABASE_CREDENTIAL_MISSING' });
      assert.equal(child.stderr.trim(), 'drill-test-sync: DRILL_SERVER_DATABASE_CREDENTIAL_MISSING');
      const wrong = spawnSync(process.execPath, [script, '--applied', appliedFile], { input: 'pw\n', encoding: 'utf8', env: process.env, timeout: 120_000 });
      assert.deepEqual([wrong.status, wrong.stdout], [2, '']);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }

    // --- Connecting: a refused password is final, anything else is tried three times. ---
    const pgOf = (answers) => {
      const made = [];
      class Client {
        constructor(config) { this.config = config; made.push(this); }
        async connect() { const answer = answers[made.length - 1]; if (answer) throw Object.assign(new Error(`connect failed for ${this.config.password}`), { code: answer }); }
        async end() {}
      }
      return { pg: { Client }, made };
    };
    const config = connectionConfig({ password: 'pw', host });
    const quick = { pause: async () => {} };
    const refused = pgOf(['28P01']);
    await assert.rejects(connected(refused.pg, config, quick), (error) => error.code === 'DRILL_SERVER_DATABASE_CREDENTIAL_REFUSED' && error.message === error.code);
    assert.equal(refused.made.length, 1);
    const down = pgOf(['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND']);
    await assert.rejects(connected(down.pg, config, quick), (error) => error.code === 'DRILL_SERVER_UNREACHABLE' && !error.message.includes('pw'));
    assert.equal(down.made.length, 3);
    const flaky = pgOf(['ECONNRESET', 'ECONNRESET', null]);
    assert.equal(await connected(flaky.pg, config, quick), flaky.made[2]);
    const late = pgOf(['ECONNRESET', '28P01']);
    await assert.rejects(connected(late.pg, config, quick), { code: 'DRILL_SERVER_DATABASE_CREDENTIAL_REFUSED' });
    assert.equal(late.made.length, 2);

    // --- A row that fails names its file; the transaction is rolled back. ---
    const sent = [];
    const failing = { query: async (text) => { sent.push(text); if (text === 'select broken') throw new Error('syntax error'); return { rows: [{ md5: 'm' }] }; } };
    await assert.rejects(applyStep(failing, { version: '20260101000000', name: 'a', file: 'migrations/20260101000000_a.sql', run: 'select broken', statements: 's', statements_md5: 'm' }),
      (error) => error.code === 'DRILL_SERVER_SYNC_FAILED:migrations/20260101000000_a.sql' && error.detail === 'syntax error');
    assert.deepEqual(sent, ['begin', 'select broken', 'rollback']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('no workflow runs the sync: the drill host does, and the release workflow only exports the list it follows', async () => {
  const workflows = new URL('../../../.github/workflows/', import.meta.url);
  assert.equal(existsSync(new URL('clued-drill-test-sync.yml', workflows)), false, 'a hosted job is prohibited and a node must not hold the password');
  const { readdir } = await import('node:fs/promises');
  for (const name of await readdir(workflows)) {
    assert.doesNotMatch(await readFile(new URL(name, workflows), 'utf8'), /drill-test-sync\.yml|clued-drill-test\b|CLUED_DRILL_TEST/, name);
  }
  const release = (await readFile(new URL('clued-cloud-production-release.yml', workflows), 'utf8')).replace(/\r\n/g, '\n');
  assert.match(release, /\n          name: clued-production-applied-\$\{\{ github\.run_id \}\}\n/);
});
