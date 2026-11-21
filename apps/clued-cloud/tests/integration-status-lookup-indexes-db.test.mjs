import { stopCluster, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import { allowRawTestBindings } from './raw-binding-grants-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = '20261015144000_integration_status_lookup_indexes.sql';
const RECEIPT_INDEX = 'clued_audit_receipts_binding_committed_recent_idx';
const SESSION_INDEX = 'clued_continuity_sessions_binding_started_idx';
const FILLER = 100000;
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');

// These are the existing integration_view_v1 lookups, with its PL/pgSQL values
// replaced by parameters. No extra tie-breaker or ended_at predicate is added.
const receiptQuery = `select pg_catalog.jsonb_build_object('receipt_id', r.id, 'at', r.created_at) value
  from public.clued_audit_receipts r where r.binding_id = $1 and r.status = 'committed'
  order by r.created_at desc limit 1`;
const sessionQuery = `select max(s.started_at) value from public.clued_continuity_sessions s
  where s.binding_id = $1 and s.started_at >= $2`;

async function freePort() {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

function nodes(plan) {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}

test('Integration status: scaled latest evidence preserves results and uses binding indexes',
  { timeout: 300000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-integration-status-indexes-'));
  const server = new EmbeddedPostgres({
    databaseDir: directory, user: 'postgres', password: hash(), port: await freePort(),
    persistent: false, initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS],
    onLog() {}, onError(message) { process.stderr.write(`${message}\n`); },
  });
  let admin;
  try {
    await server.initialise();
    await server.start();
    admin = server.getPgClient();
    await admin.connect();
    await admin.query(`create role anon nologin; create role authenticated nologin;
      create role service_role nologin bypassrls; create role authenticator nologin noinherit;
      create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,
        banned_until timestamptz,deleted_at timestamptz);
      create function auth.uid() returns uuid language sql stable as
        $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as
        $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    const migrations = (await fs.readdir(path.join(root, 'supabase/migrations')))
      .filter(name => name.endsWith('.sql')).sort();
    assert.ok(migrations.includes(MIGRATION));
    for (const name of migrations.filter(name => name !== MIGRATION)) {
      try { await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    }
    await allowRawTestBindings(admin);
    const owner = uuid();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at)
      values($1,'status-indexes@example.invalid',now())`, [owner]);
    const binding = async label => (await admin.query(`insert into public.clued_agent_bindings
      (user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic',$2,$3,array['context:read'],array['*']) returning id`,
    [owner, label, hash()])).rows[0].id;
    const target = await binding('target');
    const foreign = await binding('foreign');
    const tied = await binding('tied');
    const empty = await binding('empty');

    // A large unrelated history, plus newer foreign and non-committed receipts,
    // must not replace the current Binding's latest committed evidence.
    await admin.query(`insert into public.clued_audit_receipts
      (user_id,binding_id,context_key,operation,object_type,status,created_at)
      select $1,$2,'global','synthetic_status_history','fixture',
        case when n%2=0 then 'committed' else 'pending' end,
        timestamptz '2026-10-15 01:00:00+00'+n*interval '1 second'
      from generate_series(1,${FILLER}) n`, [owner, foreign]);
    const committedId = uuid();
    await admin.query(`insert into public.clued_audit_receipts
      (id,user_id,binding_id,context_key,operation,object_type,status,created_at) values
      ($1,$2,$3,'global','synthetic_status_history','fixture','committed','2026-10-15 00:02:00+00'),
      (gen_random_uuid(),$2,$3,'global','synthetic_status_history','fixture','committed','2026-10-15 00:01:00+00'),
      (gen_random_uuid(),$2,$3,'global','synthetic_status_history','fixture','pending','2026-10-15 00:04:00+00'),
      (gen_random_uuid(),$2,$3,'global','synthetic_status_history','fixture','rejected','2026-10-15 00:05:00+00')`,
    [committedId, owner, target]);
    const tieIds = [uuid(), uuid()];
    await admin.query(`insert into public.clued_audit_receipts
      (id,user_id,binding_id,context_key,operation,object_type,status,created_at)
      select x,$1,$2,'global','synthetic_status_history','fixture','committed','2026-10-15 00:02:00+00'
      from unnest($3::uuid[]) x`, [owner, tied, tieIds]);

    await admin.query(`insert into public.clued_continuity_sessions
      (user_id,binding_id,context_key,token_hash,restored_version,started_at,expires_at,ended_at)
      select $1,$2,'global',md5(n::text)||md5('session-'||n::text),0,
        timestamptz '2026-10-15 01:00:00+00'+n*interval '1 second',
        timestamptz '2026-11-15 00:00:00+00',
        case when n%2=0 then timestamptz '2026-11-14 00:00:00+00' end
      from generate_series(1,${FILLER}) n`, [owner, foreign]);
    await admin.query(`insert into public.clued_continuity_sessions
      (user_id,binding_id,context_key,token_hash,restored_version,started_at,expires_at,ended_at) values
      ($1,$2,'global',$3,0,'2026-10-14 23:59:00+00','2026-11-15 00:00:00+00',null),
      ($1,$2,'global',$4,0,'2026-10-15 00:02:00+00','2026-11-15 00:00:00+00',null),
      ($1,$2,'global',$5,0,'2026-10-15 00:03:00+00','2026-11-15 00:00:00+00','2026-10-15 00:04:00+00')`,
    [owner, target, hash(), hash(), hash()]);
    await admin.query('analyze public.clued_audit_receipts; analyze public.clued_continuity_sessions');

    const link = '2026-10-15T00:00:00Z';
    const results = async () => ({
      receipt: (await admin.query(receiptQuery, [target])).rows,
      session: (await admin.query(sessionQuery, [target, link])).rows,
      afterLastSession: (await admin.query(sessionQuery, [target, '2026-10-15T00:04:00Z'])).rows,
      emptyReceipt: (await admin.query(receiptQuery, [empty])).rows,
      emptySession: (await admin.query(sessionQuery, [empty, link])).rows,
    });
    const explain = async (query, args) => (await admin.query(
      `explain (analyze, buffers, format json) ${query}`, args)).rows[0]['QUERY PLAN'][0];
    const planPair = async () => ({
      receipt: await explain(receiptQuery, [target]),
      session: await explain(sessionQuery, [target, link]),
    });
    const before = await results();
    assert.equal(before.receipt[0].value.receipt_id, committedId);
    assert.equal(before.session[0].value.toISOString(), '2026-10-15T00:03:00.000Z', 'ended resume remains evidence');
    assert.deepEqual(before.afterLastSession, [{ value: null }], 'link time still bounds resume evidence');
    assert.deepEqual(before.emptyReceipt, []);
    assert.deepEqual(before.emptySession, [{ value: null }]);
    assert.ok(tieIds.includes((await admin.query(receiptQuery, [tied])).rows[0].value.receipt_id));
    const plansBefore = await planPair();
    for (const plan of Object.values(plansBefore)) {
      assert.ok(nodes(plan.Plan).some(node => node['Node Type'] === 'Seq Scan'), 'pre-index large-history scan is observed');
    }

    // The publisher's dynamic EXECUTE runs inside its ledger transaction. Test
    // the same SQL execution boundary, and prove functions, ACLs and gateway
    // timeout do not change. No planner settings or production stats are touched.
    const catalog = async () => (await admin.query(`select
      (select md5(string_agg(p.oid::text||p.prosrc||coalesce(p.proacl::text,'')||p.proowner::text||coalesce(p.proconfig::text,''),'' order by p.oid))
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','clued_private')) functions,
      (select jsonb_object_agg(c.relname,coalesce(c.relacl::text,'')) from pg_class c
        where c.oid in ('public.clued_audit_receipts'::regclass,'public.clued_continuity_sessions'::regclass)) table_acls,
      (select rolconfig from pg_roles where rolname='clued_worker_gateway') gateway_config,
      current_setting('lock_timeout') lock_timeout, current_setting('statement_timeout') statement_timeout`)).rows[0];
    const catalogBefore = await catalog();
    const sql = await fs.readFile(path.join(root, 'supabase/migrations', MIGRATION), 'utf8');
    assert.ok(!sql.includes('$status_indexes$'));
    const apply = `do $apply$ begin execute $status_indexes$${sql}$status_indexes$; end $apply$`;
    await admin.query('begin');
    await admin.query(apply);
    await admin.query('commit');
    assert.deepEqual(await catalog(), catalogBefore, 'only indexes survive the migration transaction');
    assert.deepEqual(await results(), before);
    const tieAfter = (await admin.query(receiptQuery, [tied])).rows[0].value;
    assert.ok(tieIds.includes(tieAfter.receipt_id), 'equal timestamps retain the existing unspecified tie choice');
    assert.equal(new Date(tieAfter.at).toISOString(), '2026-10-15T00:02:00.000Z');
    const plansAfter = await planPair();
    for (const [kind, expected] of [['receipt', RECEIPT_INDEX], ['session', SESSION_INDEX]]) {
      const scans = nodes(plansAfter[kind].Plan);
      assert.ok(scans.some(node => node['Index Name'] === expected), `${kind} uses its real binding index`);
      assert.ok(!scans.some(node => node['Node Type'] === 'Seq Scan'), `${kind} no longer scans unrelated history`);
      t.diagnostic(JSON.stringify({ lookup: kind, rows_per_history: FILLER,
        before: { nodes: nodes(plansBefore[kind].Plan).map(node => node['Node Type']), execution_ms: plansBefore[kind]['Execution Time'] },
        after: { indexes: scans.map(node => node['Index Name']).filter(Boolean), execution_ms: plansAfter[kind]['Execution Time'] },
        timing_is_observation_only: true }));
    }
    // An unexpected existing name is an error, rather than trusting an index
    // with unknown contents. A collision on the second index also rolls back
    // the first index just created in the publisher transaction.
    await admin.query(`drop index public.${RECEIPT_INDEX}`);
    await admin.query('begin');
    await assert.rejects(admin.query(apply), error => error.code === '42P07');
    await admin.query('rollback');
    assert.deepEqual((await admin.query(`select to_regclass($1)::text receipt,
      to_regclass($2)::text session`, [`public.${RECEIPT_INDEX}`, `public.${SESSION_INDEX}`])).rows,
    [{ receipt: null, session: SESSION_INDEX }]);
    assert.deepEqual(await catalog(), catalogBefore);
    assert.deepEqual(await results(), before);
  } finally {
    await admin?.end().catch(() => {});
    await stopCluster(server);
  }
});
