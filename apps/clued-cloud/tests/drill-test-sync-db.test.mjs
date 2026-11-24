// Drill test project sync (Task 87d330d0; design FABLE-drill-test-project-sync-20261124 §1, §2.2, §4.1).
//
// scripts/drill-test-sync.mjs brings the hosted test project clued-auth-test to
// production's applied migration list: the same rows, in production's order,
// each with the text production ran. These tests run it offline against an
// embedded PostgreSQL with the platform stand-ins the drift check uses; the
// production list is the committed ledger (supabase/ledger/production-history.json).
// Nothing here reads a credential or connects to a hosted database.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
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
      assert.deepEqual(Object.keys(config).sort(), ['database', 'host', 'password', 'port', 'ssl', 'user']);
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
    assert.throws(() => connectionConfig({ password: 'plain', host: refused }), /drill_test_pooler_host_invalid/, String(refused));
  }
  for (const refused of [undefined, '', 7]) {
    assert.throws(() => connectionConfig({ password: refused, host }), /drill_test_database_password_missing/, String(refused));
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

test('sync on a database: rebuild, catch up a prefix, refuse a diverged history, parking fixture, receipt',
  { timeout: 1_500_000 }, async () => {
  const { syncDatabase, seedFixtures, readTestHistory } = await sync();
  const repository = await readRepository();
  const snapshot = await readSnapshot();
  // Production's applied list as the release workflow exports it (supabase/production-schema/applied.sql).
  const production = repository.ledger.rows.map(({ version, name, statements_md5, statements_length }) =>
    ({ version, name, statements_md5, statements_length })).sort((a, b) => a.version.localeCompare(b.version));
  const identity = (rows) => rows.map(({ version, name, statements_md5 }) => `${version} ${name} ${statements_md5}`);
  const meta = (runId) => ({ sourceCommit: 'c'.repeat(40), runId, at: '2026-11-24T04:00:00.000Z' });

  await withCluster('drill-sync', async (admin) => {
    const run = (options) => syncDatabase(admin, { repository, snapshot, platform: 'embedded', ...options });
    const receipt = async () => {
      await admin.query('set role anon');
      try { return (await admin.query('select public.clued_drill_sync_receipt_v1() v')).rows[0].v; } finally { await admin.query('reset role'); }
    };
    const user = crypto.randomUUID();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at) values($1,'drill@example.invalid',now())`, [user]);

    // --- First run: rebuild from empty to a production list three rows short. ---
    const earlier = production.slice(0, -3);
    const first = await run({ applied: earlier, rebuild: true, meta: meta('101') });
    assert.equal(first.state, 'in-sync', JSON.stringify(first.error ?? first.at ?? null));
    assert.equal(first.applied.length, earlier.length);
    assert.deepEqual(identity(await readTestHistory(admin)), identity(earlier));
    assert.deepEqual(await receipt(), { contract: 'clued.drill-test-sync-receipt.v1', state: 'in-sync',
      production_last: { version: earlier.at(-1).version, name: earlier.at(-1).name }, production_rows: earlier.length,
      source_commit: 'c'.repeat(40), run_id: '101', at: '2026-11-24T04:00:00.000Z' });

    // --- One row in the middle differs: diverged, no file applied. ---
    const middle = earlier[Math.floor(earlier.length / 2)];
    const original = (await admin.query('select statements from supabase_migrations.schema_migrations where version=$1', [middle.version])).rows[0].statements;
    await admin.query('update supabase_migrations.schema_migrations set statements=$2 where version=$1', [middle.version, ['-- another text']]);
    const diverged = await run({ applied: production, meta: meta('102') });
    assert.equal(diverged.state, 'diverged');
    assert.deepEqual(diverged.applied, []);
    assert.equal(diverged.at.production.version, middle.version);
    assert.equal((await readTestHistory(admin)).length, earlier.length, 'no file was applied');
    assert.deepEqual(await receipt(), { contract: 'clued.drill-test-sync-receipt.v1', state: 'diverged',
      source_commit: 'c'.repeat(40), run_id: '102', at: '2026-11-24T04:00:00.000Z' });
    await admin.query('update supabase_migrations.schema_migrations set statements=$2 where version=$1', [middle.version, original]);

    // --- A prefix: exactly the missing rows are applied, in production's order. ---
    const caught = await run({ applied: production, meta: meta('103') });
    assert.equal(caught.state, 'in-sync', JSON.stringify(caught.error ?? caught.at ?? null));
    assert.deepEqual(caught.applied, production.slice(-3).map((r) => `${r.version}_${r.name}`));
    assert.deepEqual(identity(await readTestHistory(admin)), identity(production));
    assert.deepEqual([(await receipt()).state, (await receipt()).run_id, (await receipt()).production_rows], ['in-sync', '103', production.length]);
    // Again: nothing to do.
    const again = await run({ applied: production, meta: meta('104') });
    assert.deepEqual([again.state, again.applied], ['in-sync', []]);
    // An older list arriving late changes nothing, the receipt included.
    const late = await run({ applied: earlier, meta: meta('105') });
    assert.deepEqual([late.state, late.applied], ['stale', []]);
    assert.equal((await receipt()).run_id, '104');

    // --- The drill Binding and the parking spot (§1.4, §4.1; pending question 2). ---
    const human = async (name, input) => {
      await admin.query('begin');
      try {
        await admin.query('set local role authenticated');
        await admin.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)", [user, JSON.stringify(fresh(user))]);
        const value = (await admin.query(`select public.${name}($1) v`, [input])).rows[0].v;
        await admin.query('commit');
        return value;
      } catch (error) { await admin.query('rollback'); throw error; }
    };
    const issue = async (selected) => {
      const confirmation = await human('clued_headless_binding_confirmation_issue_v1', { label: 'drill', days: 90, selected });
      if (confirmation.status !== 'issued') return confirmation;
      return human('clued_headless_binding_issue_v1', { confirmation_token: confirmation.confirmation_token, view_digest: confirmation.view_digest });
    };
    const holders = async (token, scope) => {
      await admin.query('set role anon');
      try {
        return (await admin.query('select public.clued_work_merge_slot_holders_v1($1,$2::jsonb) v',
          [sha256(token), JSON.stringify({ scope, repository: 'tdoljyj/cross-memory-system' })])).rows[0].v;
      } finally { await admin.query('reset role'); }
    };
    const parkingRows = async () => (await admin.query(`select count(*)::int n from clued_private.binding_roles_v1
      where user_id=$1 and role='ci-admission' and purpose='parking' and revoked_at is null`, [user])).rows[0].n;
    // Pending question 2: with nothing but its auth.users row the account can issue a read-only token for the
    // global scope; a project scope needs a project the account owns under exactly that key.
    const project = `project:${crypto.randomUUID()}`;
    const refused = await issue([{ resource_kind: 'scope', resource_id: project, environment: 'canonical', actions: ['read'] }]);
    assert.equal(refused.error_code, 'selection_exceeds_requested_or_owned_permissions', JSON.stringify(refused));
    const drill = await issue([{ resource_kind: 'scope', resource_id: 'global', environment: 'canonical', actions: ['read'] }]);
    assert.equal(drill.status, 'committed', JSON.stringify(drill));
    // The account never marked ci-admission: the server admits every Binding, so the probe reads "held".
    assert.equal(await parkingRows(), 0);
    const open = await holders(drill.token, 'global');
    assert.deepEqual([open.status, open.holders, open.reason], ['ok', [], undefined], JSON.stringify(open));
    // The fixture: one parking spot per account, through the product's own functions.
    assert.deepEqual(await seedFixtures(admin), { users: 1, seeded: 1 });
    assert.equal(await parkingRows(), 1);
    assert.deepEqual(await holders(drill.token, 'global'), { status: 'ok', holders: [], reason: 'admission_binding_required' });
    assert.deepEqual(await seedFixtures(admin), { users: 1, seeded: 0 }, 'a second run adds nothing');
    assert.equal(await parkingRows(), 1);
    // The parking Binding's token was never returned to this process and admits nobody.
    const parking = (await admin.query(`select b.id,b.vendor,b.agent_name,b.scopes,b.context_keys from clued_private.binding_roles_v1 r
      join public.clued_agent_bindings b on b.id=r.binding_id where r.user_id=$1 and r.purpose='parking' and r.revoked_at is null`, [user])).rows[0];
    assert.deepEqual([parking.vendor, parking.agent_name, parking.scopes, parking.context_keys], ['Headless', 'drill-parking', ['context:read'], ['global']]);
    assert.equal((await admin.query(`select clued_private.binding_role_admits_v1(b,'ci-admission') ok from public.clued_agent_bindings b where b.id=$1`,
      [parking.id])).rows[0].ok, false);

    // --- Rebuild over a populated database: application data goes, auth stays, the fixture comes back. ---
    const rebuilt = await run({ applied: production, rebuild: true, meta: meta('106') });
    assert.equal(rebuilt.state, 'in-sync', JSON.stringify(rebuilt.error ?? rebuilt.at ?? null));
    assert.equal(rebuilt.applied.length, production.length);
    assert.deepEqual(rebuilt.fixtures, { users: 1, seeded: 1 });
    assert.deepEqual(identity(await readTestHistory(admin)), identity(production));
    assert.equal((await admin.query('select count(*)::int n from auth.users')).rows[0].n, 1);
    assert.equal(await parkingRows(), 1);
    assert.equal((await admin.query('select count(*)::int n from public.clued_agent_bindings where user_id=$1', [user])).rows[0].n, 1,
      'the drill Binding issued before the rebuild is gone; only the parking Binding exists');
    await assert.rejects(() => holders(drill.token, 'global'), /binding_not_authorized|authorization_revoked_or_expired/);
    assert.equal((await receipt()).run_id, '106');
  });
});
