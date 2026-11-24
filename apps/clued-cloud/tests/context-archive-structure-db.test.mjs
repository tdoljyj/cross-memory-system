// Context archive, structure step C1a (design: production database third batch v2, section 3.2).
// A real PostgreSQL replays every migration before the C1a one, real restores, events and checkpoints are written
// through the Worker gateway RPCs (the stock), and the C1a migration is then applied the way the release workflow's
// migrate mode does (one plpgsql EXECUTE in one transaction).
// What it guards: once old checkpoints may be deleted (C1b), deleting one must not take anything else with it -
// not the current checkpoint, not the row a head points to, not the record of which events were absorbed (losing
// that turns absorbed events back into pending ones) - and the database itself refuses to delete a current checkpoint.
// The retention class of the new table (ledger) is registered in supabase/retention-classes.json, which is not on
// this branch's base: the B2 test retention-classes-db lists every table from pg_class and is red until it is added.
import { stopCluster, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS } from './cluster-cleanup.mjs';
import { allowTestIssuerCredentials } from './issuer-credentials-fixture.mjs';
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
import { setWorkerGatewayCaller, workerGatewayRpc } from './worker-gateway-caller-fixture.mjs';
import { MIGRATE_MODE_SQL, PLATFORM_SQL } from '../scripts/production-schema-drift.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const C1A_MIGRATION = '20261124140000_context_archive_structure_v1.sql';
const BATCHES = 'clued_private.context_archive_batches_v1';
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');

async function freePort() {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

// The release workflow's migrate mode: the whole file is one EXECUTE inside one transaction.
async function migrate(client, text) {
  await client.query('begin');
  try {
    await client.query("select set_config('clued.migration_text', $1, true)", [text]);
    await client.query(MIGRATE_MODE_SQL);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  }
}

test('context archive structure: deleting an old checkpoint takes nothing else with it', { timeout: 600000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-context-archive-structure-'));
  const server = new EmbeddedPostgres({ databaseDir: directory, user: 'postgres', password: uuid(),
    port: await freePort(), persistent: false, initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS],
    onLog() {}, onError(message) { process.stderr.write(message + '\n'); } });
  const clients = [];
  const connect = async () => { const db = server.getPgClient(); clients.push(db); await db.connect(); return db; };
  try {
    await server.initialise(); await server.start();
    const admin = await connect();
    await admin.query(PLATFORM_SQL);
    const migrations = path.join(root, 'supabase/migrations');
    const names = (await fs.readdir(migrations)).filter(name => name.endsWith('.sql')).sort();
    for (const name of names.filter(name => name < C1A_MIGRATION)) {
      try { await admin.query(await fs.readFile(path.join(migrations, name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    }
    await allowRawTestBindings(admin);
    await allowTestIssuerCredentials(admin);
    const gateway = await connect();
    await setWorkerGatewayCaller(gateway);
    const other = await connect();
    const one = async (sql, args) => (await admin.query(sql, args)).rows[0];
    const all = async (sql, args) => (await admin.query(sql, args)).rows;

    // One user with one Binding on the global context; every row below is written by the real RPCs.
    const actor = async label => {
      const user = uuid(), token = hash();
      await admin.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())', [user, `${label}@example.invalid`]);
      await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic',$2,$3,array['context:read','context:write','audit:read'],array['global'])`, [user, label, token]);
      const rpc = (name, input) => workerGatewayRpc(gateway, name, token, input);
      const restore = () => rpc('clued_mcp_restore', { context_key: 'global', response_view: 'structured', event_order: 'oldest' });
      // One session: append `count` events, then (optionally) commit a checkpoint that absorbs exactly those events.
      const round = async (marker, count, commit = true) => {
        const session = await restore();
        let version = session.version;
        const events = [];
        for (let index = 0; index < count; index += 1) {
          const event = await rpc('clued_mcp_append_event', { context_key: 'global', session_token: session.session_token,
            base_version: version, event_type: 'note', payload: { marker: `${marker}-${index}` }, idempotency_key: uuid() });
          version = event.version;
          events.push(Number(event.event_id));
        }
        if (!commit) return { events };
        const checkpoint = await rpc('clued_mcp_commit_checkpoint', { context_key: 'global', session_token: session.session_token,
          base_version: version, snapshot: { marker }, summary: `summary ${marker}`, next_action: `next ${marker}`,
          idempotency_key: uuid(), coverage: { mode: 'explicit', contexts: ['global'], tracks: ['archive'], event_ids: events } });
        assert.equal(checkpoint.status, 'committed');
        return { events, id: (await one('select checkpoint_id id from public.clued_context_heads where user_id=$1 and context_key=$2',
          [user, 'global'])).id };
      };
      // What a resuming agent is given, without the two values every restore makes anew.
      const resumed = async () => {
        const { session_token: _token, receipt_id: _receipt, ...rest } = await restore();
        return rest;
      };
      const state = async () => ({
        resumed: await resumed(),
        head: await one('select to_jsonb(h) v from public.clued_context_heads h where user_id=$1', [user]),
        events: await all('select to_jsonb(e) v from public.clued_context_events e where user_id=$1 order by id', [user]),
        absorbed: (await all('select event_id from public.clued_checkpoint_event_absorptions where user_id=$1 order by event_id', [user]))
          .map(row => Number(row.event_id)),
        checkpoints: (await all('select id from public.clued_context_checkpoints where user_id=$1 order by version', [user])).map(row => row.id),
      });
      return { user, round, state };
    };
    const checkpoint = id => one('select to_jsonb(c) v from public.clued_context_checkpoints c where id=$1', [id]);

    // ---- stock, written before the migration ------------------------------------------------------------------
    // A: four checkpoints in a chain, each absorbed two events, and two events still pending after the fourth.
    const a = await actor('archive-chain');
    const a1 = await a.round('a1', 2), a2 = await a.round('a2', 2), a3 = await a.round('a3', 2), a4 = await a.round('a4', 2);
    const aPending = await a.round('a-pending', 2, false);
    // B: two checkpoints; the newer one no longer points back at the older one (what a chain looks like once the
    // row before it has been archived), so only the absorption record stands between the old row and its deletion.
    const b = await actor('archive-absorption');
    const b1 = await b.round('b1', 3), b2 = await b.round('b2', 1);
    await b.round('b-pending', 1, false);
    await admin.query('update public.clued_context_checkpoints set previous_checkpoint_id=null where id=$1', [b2.id]);
    // C: one checkpoint, the current one.
    const c = await actor('archive-current');
    const c1 = await c.round('c1', 2);
    await c.round('c-pending', 1, false);
    const d = await actor('archive-index');

    const before = { a: await a.state(), b: await b.state(), c: await c.state() };
    assert.equal(before.a.resumed.pending_event_count, 2);
    assert.deepEqual(before.a.resumed.events_after_checkpoint.map(event => Number(event.id)), aPending.events);
    assert.equal(before.a.resumed.provenance.checkpoint_id, a4.id);
    assert.equal((await checkpoint(a4.id)).v.previous_checkpoint_id, a3.id);
    assert.equal(before.b.resumed.pending_event_count, 1);
    assert.equal(before.c.resumed.pending_event_count, 1);

    const present = names.includes(C1A_MIGRATION);
    const text = present ? await fs.readFile(path.join(migrations, C1A_MIGRATION), 'utf8') : '';
    const structure = async () => ({
      table: (await one('select to_regclass($1) is not null present', [BATCHES])).present,
      constraints: await all(`select conrelid::regclass::text t, conname, pg_get_constraintdef(oid) d from pg_constraint
        where conrelid in ('public.clued_context_heads'::regclass,'public.clued_context_checkpoints'::regclass,
          'public.clued_checkpoint_event_absorptions'::regclass) order by 1,2`),
      indexes: await all(`select indexrelid::regclass::text i, pg_get_indexdef(indexrelid) d from pg_index
        where indrelid in ('public.clued_context_heads'::regclass,'public.clued_context_checkpoints'::regclass,
          'public.clued_checkpoint_event_absorptions'::regclass) order by 1`),
    });

    await t.test('a lock the migration cannot take within its lock timeout fails it with 55P03 and changes nothing', async () => {
      assert.ok(present, `${C1A_MIGRATION} is in the migration chain`);
      assert.match(text, /^set local lock_timeout='5s';/, 'the first statement bounds every lock wait');
      const untouched = await structure();
      await other.query('begin');
      await other.query('lock table public.clued_context_checkpoints in access share mode');
      const started = Date.now();
      try {
        await assert.rejects(migrate(admin, text), error => error.code === '55P03');
      } finally { await other.query('rollback'); }
      assert.ok(Date.now() - started < 30000, 'the wait is bounded');
      assert.deepEqual(await structure(), untouched);
    });

    if (present) await migrate(admin, text);

    await t.test('the migration changes no row a resuming agent reads', async () => {
      assert.deepEqual({ a: await a.state(), b: await b.state(), c: await c.state() }, before);
    });

    await t.test('foreign keys: head refuses, absorption record and successor let go', async () => {
      const action = async (table, column) => (await all(`select c.confdeltype::text action from pg_constraint c
        where c.conrelid=$1::regclass and c.contype='f' and c.confrelid='public.clued_context_checkpoints'::regclass
          and c.conkey=array(select a.attnum from pg_attribute a where a.attrelid=c.conrelid and a.attname=$2)`, [table, column]))
        .map(row => row.action);
      assert.deepEqual(await action('public.clued_context_heads', 'checkpoint_id'), ['a'], 'head: no action');
      assert.deepEqual(await action('public.clued_checkpoint_event_absorptions', 'checkpoint_id'), ['n'], 'absorption: set null');
      assert.deepEqual(await action('public.clued_context_checkpoints', 'previous_checkpoint_id'), ['n'], 'predecessor: set null');
    });

    await t.test('absorption record: one row per event is the primary key, the checkpoint may be gone', async () => {
      const keys = await all(`select c.contype::text kind, array(select a.attname::text from unnest(c.conkey) with ordinality k(attnum,pos)
          join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum order by k.pos) columns
        from pg_constraint c where c.conrelid='public.clued_checkpoint_event_absorptions'::regclass and c.contype in ('p','u')`);
      assert.deepEqual(keys, [{ kind: 'p', columns: ['user_id', 'context_key', 'event_id'] }]);
      assert.equal((await one(`select attnotnull n from pg_attribute where attrelid='public.clued_checkpoint_event_absorptions'::regclass
        and attname='checkpoint_id'`)).n, false);
    });

    await t.test('the two columns a deleted checkpoint is looked up by have a partial index over their non-null rows', async () => {
      const partial = async (table, column) => (await all(`select pg_get_expr(i.indpred,i.indrelid) predicate from pg_index i
        where i.indrelid=$1::regclass and i.indpred is not null and i.indnatts=1
          and i.indkey[0]=(select a.attnum from pg_attribute a where a.attrelid=i.indrelid and a.attname=$2)`, [table, column]))
        .map(row => row.predicate);
      assert.deepEqual(await partial('public.clued_checkpoint_event_absorptions', 'checkpoint_id'), ['(checkpoint_id IS NOT NULL)']);
      assert.deepEqual(await partial('public.clued_context_checkpoints', 'previous_checkpoint_id'), ['(previous_checkpoint_id IS NOT NULL)']);
    });

    await t.test('the current checkpoint cannot be deleted: the database refuses and the head still points at it', async () => {
      await assert.rejects(admin.query('delete from public.clued_context_checkpoints where id=$1', [c1.id]),
        error => error.code === '23503');
      assert.deepEqual(await c.state(), before.c);
      await assert.rejects(admin.query('delete from public.clued_context_checkpoints where id=$1', [a4.id]),
        error => error.code === '23503');
    });

    await t.test('deleting a checkpoint keeps its absorption record: no absorbed event becomes pending again', async () => {
      const cached = () => one(`select count(*)::int n from clued_private.search_text_v1 where source='checkpoint' and source_id=$1`, [b1.id]);
      assert.equal((await cached()).n, 1);
      assert.equal((await admin.query('delete from public.clued_context_checkpoints where id=$1', [b1.id])).rowCount, 1);
      const after = await b.state();
      assert.deepEqual(after.checkpoints, [b2.id]);
      assert.deepEqual(after.absorbed, before.b.absorbed);
      assert.deepEqual(after.events, before.b.events);
      assert.deepEqual(after.head, before.b.head);
      assert.deepEqual(after.resumed, before.b.resumed);
      assert.deepEqual(await all(`select event_id::int event_id, checkpoint_id from public.clued_checkpoint_event_absorptions
        where user_id=$1 order by event_id`, [b.user]),
      [...b1.events.map(event_id => ({ event_id, checkpoint_id: null })), ...b2.events.map(event_id => ({ event_id, checkpoint_id: b2.id }))]);
      assert.equal((await cached()).n, 0, 'the search text of the deleted checkpoint goes with it');
    });

    await t.test('versions one to three are deleted while the fourth stays online and current, its predecessor empty', async () => {
      const fourth = (await checkpoint(a4.id)).v;
      assert.equal((await admin.query('delete from public.clued_context_checkpoints where id=any($1::uuid[])',
        [[a1.id, a2.id, a3.id]])).rowCount, 3);
      const after = await a.state();
      assert.deepEqual(after.checkpoints, [a4.id]);
      assert.deepEqual((await checkpoint(a4.id)).v, { ...fourth, previous_checkpoint_id: null });
      assert.deepEqual(after.head, before.a.head);
      assert.deepEqual(after.events, before.a.events, 'no event, absorbed or pending, is deleted');
      assert.deepEqual(after.absorbed, before.a.absorbed);
      assert.deepEqual(after.resumed, before.a.resumed, 'current checkpoint, pending events and their count are as before');
      // The next checkpoint is committed as usual on top of the shortened chain.
      const fifth = await a.round('a5', 1);
      assert.equal((await checkpoint(fifth.id)).v.previous_checkpoint_id, a4.id);
      assert.equal((await a.state()).resumed.pending_event_count, 2);
    });

    await t.test('archive index: the table exists, closed to every API role', async () => {
      assert.equal((await one('select to_regclass($1) is not null present', [BATCHES])).present, true);
      const table = await one(`select c.relrowsecurity rls, (select count(*)::int from pg_policy p where p.polrelid=c.oid) policies
        from pg_class c where c.oid=$1::regclass`, [BATCHES]);
      assert.deepEqual(table, { rls: true, policies: 0 });
      for (const role of ['public', 'anon', 'authenticated', 'service_role', 'clued_worker_gateway']) {
        const held = await all(`select privilege_type from information_schema.role_table_grants
          where table_schema='clued_private' and table_name='context_archive_batches_v1' and grantee=$1`, [role === 'public' ? 'PUBLIC' : role]);
        assert.deepEqual(held, [], `${role} holds nothing on the archive index`);
      }
      assert.deepEqual((await all(`select a.attname::text name, format_type(a.atttypid,a.atttypmod) type, a.attnotnull required
        from pg_attribute a where a.attrelid=$1::regclass and a.attnum>0 and not a.attisdropped order by a.attnum`, [BATCHES])), [
        { name: 'batch_id', type: 'uuid', required: true }, { name: 'user_id', type: 'uuid', required: true },
        { name: 'context_key', type: 'text', required: true }, { name: 'kind', type: 'text', required: true },
        { name: 'row_count', type: 'integer', required: true }, { name: 'min_version', type: 'bigint', required: true },
        { name: 'max_version', type: 'bigint', required: true }, { name: 'earliest_at', type: 'timestamp with time zone', required: true },
        { name: 'latest_at', type: 'timestamp with time zone', required: true }, { name: 'content_sha256', type: 'text', required: true },
        { name: 'byte_count', type: 'bigint', required: true }, { name: 'object_key', type: 'text', required: true },
        { name: 'status', type: 'text', required: true }, { name: 'created_at', type: 'timestamp with time zone', required: true },
        { name: 'verified_at', type: 'timestamp with time zone', required: false },
        { name: 'archived_at', type: 'timestamp with time zone', required: false }, { name: 'member_ids', type: 'uuid[]', required: false },
      ]);
    });

    await t.test('archive index: one unfinished batch per context, only checkpoints, and it goes with its user', async () => {
      const sha = hash();
      const batch = (user, extra = {}) => {
        const row = { user_id: user, context_key: 'global', kind: 'checkpoint', row_count: 2, min_version: 1, max_version: 2,
          earliest_at: '2026-08-01T00:00:00Z', latest_at: '2026-08-02T00:00:00Z', content_sha256: sha, byte_count: 10,
          object_key: `v1/${user}/checkpoint/${sha}.ndjson`, member_ids: [uuid(), uuid()], ...extra };
        const columns = Object.keys(row);
        return admin.query(`insert into ${BATCHES}(${columns.join(',')}) values(${columns.map((_, index) => `$${index + 1}`).join(',')})
          returning batch_id, status, created_at`, Object.values(row));
      };
      const first = (await batch(d.user)).rows[0];
      assert.equal(first.status, 'pending');
      await assert.rejects(batch(d.user), error => error.code === '23505', 'a second pending batch of the same context');
      await admin.query(`update ${BATCHES} set status='verified', verified_at=now() where batch_id=$1`, [first.batch_id]);
      await assert.rejects(batch(d.user), error => error.code === '23505', 'a pending batch beside a verified one');
      await admin.query(`update ${BATCHES} set status='archived', archived_at=now(), member_ids=null where batch_id=$1`, [first.batch_id]);
      const second = (await batch(d.user)).rows[0];
      await batch(d.user, { context_key: 'project:other' });
      await batch(a.user);
      await assert.rejects(batch(c.user, { kind: 'event' }), error => error.code === '23514');
      await assert.rejects(batch(c.user, { status: 'deleted' }), error => error.code === '23514');
      await assert.rejects(batch(c.user, { content_sha256: 'not-a-hash' }), error => error.code === '23514');
      await assert.rejects(batch(c.user, { min_version: 3 }), error => error.code === '23514');
      await assert.rejects(batch(c.user, { row_count: 0, member_ids: [] }), error => error.code === '23514');
      await assert.rejects(admin.query(`update ${BATCHES} set status='archived', archived_at=now() where batch_id=$1`, [second.batch_id]),
        error => error.code === '23514', 'an archived batch keeps no member list');
      assert.equal((await one(`select count(*)::int n from ${BATCHES} where user_id=$1`, [d.user])).n, 3);
      await admin.query('delete from auth.users where id=$1', [d.user]);
      assert.equal((await one(`select count(*)::int n from ${BATCHES} where user_id=$1`, [d.user])).n, 0);
      assert.equal((await one(`select count(*)::int n from ${BATCHES}`)).n, 1);
    });
  } finally {
    for (const client of clients) await client.end().catch(() => {});
    await stopCluster(server);
  }
});
