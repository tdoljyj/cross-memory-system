// Every table declares how long its rows live (FABLE-prod-db-shrink-v2-20261124 §7, B2).
//
// The table list is pg_class of a database that replayed every migration of the repository (as the database tests do), not
// the production snapshot catalog.json, which misses every table created after it was captured. The declarations are
// supabase/retention-classes.json:
//   schemas          the schemas this check covers: every table in them must be declared;
//   excludedSchemas  schema -> why its tables are not declared here;
//   tables           "<schema>.<table>" -> { class, ... } with class one of
//     rule       { rule }: the clued_private.retention_rule_*_v<n>(timestamptz) returns integer function that clears it
//                (the daily retention sweep calls every such function);
//     canonical  the user's own content;
//     state      { reason }: bounded by the number of entities, and why;
//     ledger     { reason }: a business ledger kept as such, and why;
//     pending    { owner, expiresOn }: not decided yet; red after expiresOn (Asia/Shanghai date).
// A schema with tables that neither list names, a table not declared, a declared table that no longer exists, a class
// without its field and a lapsed pending entry all fail.
import { stopCluster, removeTestDirectory, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = path.join(root, 'supabase/retention-classes.json');
const RULE_NAME = /^retention_rule_[a-z0-9_]+_v[0-9]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const nonEmpty = (value) => typeof value === 'string' && value.trim() !== '';
const shanghaiToday = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short' }).format(new Date());

// Every ordinary, partitioned and materialized relation outside the system schemas; a partition is declared through its parent.
const INVENTORY_SQL = `select n.nspname as schema, c.relname as name
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p', 'm') and not c.relispartition
    and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_(toast|temp_|toast_temp_)'
  order by 1, 2`;
// The functions the retention sweep discovers: the same name pattern and signature.
const RULES_SQL = `select p.proname as name
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'clued_private' and p.proname ~ '^retention_rule_[a-z0-9_]+_v[0-9]+$'
    and p.pronargs = 1 and p.proargtypes[0] = 'timestamptz'::regtype and p.prorettype = 'integer'::regtype`;

async function inventory(db) {
  const [tables, rules] = [await db.query(INVENTORY_SQL), await db.query(RULES_SQL)];
  return { tables: tables.rows.map((row) => `${row.schema}.${row.name}`), rules: new Set(rules.rows.map((row) => row.name)) };
}

function retentionErrors(registry, { tables, rules }, today = shanghaiToday()) {
  const errors = [];
  const schemas = Array.isArray(registry?.schemas) ? registry.schemas : [];
  const excluded = registry?.excludedSchemas && typeof registry.excludedSchemas === 'object' ? registry.excludedSchemas : {};
  const declared = registry?.tables && typeof registry.tables === 'object' ? registry.tables : {};
  if (!Array.isArray(registry?.schemas) || !schemas.every(nonEmpty)) errors.push('schemas must be a list of schema names');
  for (const [schema, reason] of Object.entries(excluded)) {
    if (!nonEmpty(reason)) errors.push(`excludedSchemas.${schema}: needs a reason`);
    if (schemas.includes(schema)) errors.push(`${schema}: in both schemas and excludedSchemas`);
  }
  const present = new Set(tables);
  for (const schema of new Set(tables.map((name) => name.slice(0, name.indexOf('.'))))) {
    if (!schemas.includes(schema) && !Object.hasOwn(excluded, schema)) {
      errors.push(`${schema}: has tables (${tables.filter((name) => name.startsWith(`${schema}.`)).join(', ')}) but neither schemas nor excludedSchemas names it`);
    }
  }
  for (const name of tables) {
    if (schemas.includes(name.slice(0, name.indexOf('.'))) && !Object.hasOwn(declared, name)) errors.push(`${name}: no retention class declared`);
  }
  for (const [name, entry] of Object.entries(declared)) {
    const label = `${name} (${entry?.class})`;
    if (!schemas.includes(name.slice(0, name.indexOf('.')))) errors.push(`${name}: declared outside the checked schemas`);
    else if (!present.has(name)) errors.push(`${name}: declared but no such table after the migrations`);
    switch (entry?.class) {
      case 'rule':
        if (!RULE_NAME.test(entry.rule ?? '')) errors.push(`${label}: rule must name a clued_private.retention_rule_*_v<n> function`);
        else if (!rules.has(entry.rule)) errors.push(`${label}: clued_private.${entry.rule}(timestamptz) returns integer does not exist`);
        break;
      case 'canonical':
        break;
      case 'state':
      case 'ledger':
        if (!nonEmpty(entry.reason)) errors.push(`${label}: needs a reason`);
        // §14.4: a class the author is not sure of is pending (owner, expiry), never state or ledger.
        else if (entry.reason.includes('低把握')) errors.push(`${label}: a reason with 低把握 must be pending`);
        break;
      case 'pending':
        if (!nonEmpty(entry.owner)) errors.push(`${label}: needs an owner`);
        if (!DATE.test(entry.expiresOn ?? '') || new Date(`${entry.expiresOn}T00:00:00Z`).toISOString().slice(0, 10) !== entry.expiresOn) {
          errors.push(`${label}: expiresOn must be a date (YYYY-MM-DD)`);
        } else if (entry.expiresOn < today) {
          errors.push(`${label}: undecided since ${entry.expiresOn} (owner ${entry.owner}); declare its class`);
        }
        break;
      default:
        errors.push(`${name}: class must be one of rule, canonical, state, ledger, pending`);
    }
  }
  return errors;
}

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('every table the migrations create declares its retention class', { timeout: 300000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-retention-classes-'));
  const server = new EmbeddedPostgres({ databaseDir: directory, user: 'postgres', password: crypto.randomUUID(),
    port: await freePort(), persistent: false, initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS],
    onLog() {}, onError(message) { process.stderr.write(`${message}\n`); } });
  let db;
  try {
    await server.initialise();
    await server.start();
    db = server.getPgClient();
    await db.connect();
    await db.query(`create role anon nologin; create role authenticated nologin;
      create role service_role nologin bypassrls; create role authenticator nologin noinherit;
      create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    const names = (await fs.readdir(path.join(root, 'supabase/migrations'))).filter((name) => name.endsWith('.sql')).sort();
    for (const name of names) {
      try { await db.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    }
    const replayed = await inventory(db);
    assert.ok(replayed.tables.length > 200, `${replayed.tables.length} tables`);
    const registry = JSON.parse(await fs.readFile(REGISTRY, 'utf8'));

    await t.test('the committed declarations cover exactly the replayed tables', () => {
      assert.deepEqual(retentionErrors(registry, replayed), []);
    });

    // Fixture migrations run in a transaction that is rolled back, so each case sees the replayed database plus its own change.
    const withFixture = async (sql, body) => {
      await db.query('begin');
      try {
        await db.query(sql);
        return await body(await inventory(db));
      } finally {
        await db.query('rollback');
      }
    };
    const edited = (change) => { const copy = structuredClone(registry); change(copy); return copy; };

    await t.test('a new table is red until it is declared', () => withFixture(
      'create table clued_private.retention_fixture_unlisted_v1(id bigint primary key)', (state) => {
        assert.deepEqual(retentionErrors(registry, state), ['clued_private.retention_fixture_unlisted_v1: no retention class declared']);
        const declared = edited((copy) => { copy.tables['clued_private.retention_fixture_unlisted_v1'] = { class: 'canonical' }; });
        assert.deepEqual(retentionErrors(declared, state), []);
      }));

    await t.test('a new schema with a table is red until one of the schema lists names it', () => withFixture(
      'create schema retention_fixture; create table retention_fixture.t(id int)', (state) => {
        const [error, ...rest] = retentionErrors(registry, state);
        assert.deepEqual(rest, []);
        assert.match(error, /^retention_fixture: has tables \(retention_fixture\.t\) but neither schemas nor excludedSchemas names it$/);
        assert.deepEqual(retentionErrors(edited((copy) => { copy.excludedSchemas.retention_fixture = 'fixture'; }), state), []);
        assert.deepEqual(retentionErrors(edited((copy) => { copy.excludedSchemas.retention_fixture = ' '; }), state),
          ['excludedSchemas.retention_fixture: needs a reason']);
        const covered = edited((copy) => { copy.schemas.push('retention_fixture'); });
        assert.deepEqual(retentionErrors(covered, state), ['retention_fixture.t: no retention class declared']);
        covered.tables['retention_fixture.t'] = { class: 'state', reason: 'fixture' };
        assert.deepEqual(retentionErrors(covered, state), []);
      }));

    await t.test('a declared table that no longer exists is red', () => {
      const stale = edited((copy) => { copy.tables['clued_private.retention_fixture_dropped_v1'] = { class: 'canonical' }; });
      assert.deepEqual(retentionErrors(stale, replayed), ['clued_private.retention_fixture_dropped_v1: declared but no such table after the migrations']);
      const outside = edited((copy) => { copy.tables['auth.users'] = { class: 'canonical' }; });
      assert.deepEqual(retentionErrors(outside, replayed), ['auth.users: declared outside the checked schemas']);
    });

    const someTable = replayed.tables.find((name) => registry.tables[name]?.class === 'state');
    await t.test('state and ledger need a reason', () => {
      for (const kind of ['state', 'ledger']) {
        for (const reason of [undefined, '', '  ']) {
          const copy = edited((r) => { r.tables[someTable] = { class: kind, reason }; });
          assert.deepEqual(retentionErrors(copy, replayed), [`${someTable} (${kind}): needs a reason`]);
        }
      }
      // FABLE-prod-db-shrink-v2-20261124 §14.4: a class the author is not sure of is pending, not state or ledger.
      for (const kind of ['state', 'ledger']) {
        const copy = edited((r) => { r.tables[someTable] = { class: kind, reason: '估计有界（低把握）' }; });
        assert.deepEqual(retentionErrors(copy, replayed), [`${someTable} (${kind}): a reason with 低把握 must be pending`]);
      }
      assert.deepEqual(retentionErrors(edited((r) => { r.tables[someTable] = { class: 'kept' }; }), replayed),
        [`${someTable}: class must be one of rule, canonical, state, ledger, pending`]);
    });

    await t.test('pending needs an owner and turns red after its date', () => {
      // Fixture dates before every committed pending date, so only the edited entry can lapse.
      const pending = (entry) => edited((r) => { r.tables[someTable] = { class: 'pending', ...entry }; });
      assert.deepEqual(retentionErrors(pending({ owner: 'Fable', expiresOn: '2026-01-15' }), replayed, '2026-01-15'), []);
      assert.deepEqual(retentionErrors(pending({ owner: 'Fable', expiresOn: '2026-01-15' }), replayed, '2026-01-16'),
        [`${someTable} (pending): undecided since 2026-01-15 (owner Fable); declare its class`]);
      assert.deepEqual(retentionErrors(pending({ owner: '', expiresOn: '2026-01-15' }), replayed, '2026-01-01'),
        [`${someTable} (pending): needs an owner`]);
      for (const expiresOn of [undefined, '2026-02-30', '15/12/2026']) {
        assert.deepEqual(retentionErrors(pending({ owner: 'Fable', expiresOn }), replayed, '2026-01-01'),
          [`${someTable} (pending): expiresOn must be a date (YYYY-MM-DD)`]);
      }
    });

    await t.test('rule names an existing retention_rule function with the sweep signature', () => withFixture(
      `create function clued_private.retention_rule_fixture_v1(p_at timestamptz) returns integer language sql as $$select 0$$;
       create function clued_private.retention_rule_fixture_text_v1(p_at text) returns integer language sql as $$select 0$$;`, (state) => {
        const rule = (name) => edited((r) => { r.tables[someTable] = { class: 'rule', rule: name }; });
        assert.deepEqual(retentionErrors(rule('retention_rule_fixture_v1'), state), []);
        assert.deepEqual(retentionErrors(rule('retention_rule_fixture_v1'), replayed),
          [`${someTable} (rule): clued_private.retention_rule_fixture_v1(timestamptz) returns integer does not exist`]);
        assert.deepEqual(retentionErrors(rule('retention_rule_fixture_text_v1'), state),
          [`${someTable} (rule): clued_private.retention_rule_fixture_text_v1(timestamptz) returns integer does not exist`]);
        assert.deepEqual(retentionErrors(rule('cleanup_everything'), state),
          [`${someTable} (rule): rule must name a clued_private.retention_rule_*_v<n> function`]);
      }));

    // The declarations named by the design: the B1 tables, the receipts and the other undecided tables, and the third archive batch.
    await t.test('the tables the shrink design names carry its classes', () => {
      const classOf = (name) => registry.tables[name]?.class;
      for (const name of ['public.clued_audit_receipts', 'clued_private.merge_measurement_events_v1',
        'clued_private.work_claim_execution_admissions_v1', 'clued_private.ci_jobs_v1']) {
        assert.equal(classOf(name), 'pending', name);
        assert.equal(registry.tables[name].expiresOn, '2026-12-15', name);
      }
      for (const name of ['public.clued_context_checkpoints', 'public.clued_context_events',
        'public.clued_checkpoint_event_absorptions', 'clued_private.search_text_v1']) assert.equal(classOf(name), 'canonical', name);
      // B1a and B1b merge before this change (design §12, B1a 与 B2 的衔接): their rules, which the replayed migrations create.
      assert.deepEqual(registry.tables['public.clued_memory_audit'], { class: 'rule', rule: 'retention_rule_memory_audit_v1' });
      assert.deepEqual(registry.tables['public.clued_continuity_sessions'], { class: 'rule', rule: 'retention_rule_session_payload_v1' });
      assert.deepEqual(registry.tables['clued_private.imprint_record_history_v1'], { class: 'rule', rule: 'retention_rule_imprint_history_v1' });
      for (const schema of ['mtpe_m0_test', 'mtpe_m0_work']) assert.ok(nonEmpty(registry.excludedSchemas[schema]), schema);
    });
    t.diagnostic(`replayed ${names.length} migrations; ${replayed.tables.length} tables`);
  } finally {
    await db?.end().catch(() => {});
    await stopCluster(server);
    await removeTestDirectory(directory);
  }
});
