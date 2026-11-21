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
import { allowRawTestBindings } from './raw-binding-grants-fixture.mjs';

// search_context reads stored lower-cased texts (migration 20261010030000,
// Task 775a2292). The same searches answer exactly as before the migration;
// the triggers keep the stored texts in step with records, checkpoints and
// events; a row without a stored text is still found; nothing new is
// callable or readable by the API roles.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = '20261010030000_search_context_text_cache_reapply.sql';
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('search_context on stored lower-cased texts answers as before and stays in step', { timeout: 600000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-search-text-cache-'));
  const server = new EmbeddedPostgres({
    databaseDir: directory, user: 'postgres', password: hash(), port: await freePort(),
    persistent: false, initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS],
    onLog() {}, onError(message) { process.stderr.write(`${message}\n`); },
  });
  const clients = [];
  try {
    await server.initialise();
    await server.start();
    const admin = server.getPgClient();
    clients.push(admin);
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
    const names = (await fs.readdir(path.join(root, 'supabase/migrations'))).filter((name) => name.endsWith('.sql')).sort();
    assert.ok(names.includes(MIGRATION));
    const apply = async (list) => {
      for (const name of list) {
        try { await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')); }
        catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
      }
    };
    // Everything before the migration, then data, then the migration and the rest.
    await apply(names.filter((name) => name < MIGRATION));
    await allowRawTestBindings(admin);

    const userId = uuid();
    const token = hash();
    const projectId = uuid();
    const scope = `project:${projectId}`;
    await admin.query(`insert into auth.users(id,email,email_confirmed_at) values($1,'owner@example.invalid',now())`, [userId]);
    await admin.query(`insert into public.clued_projects(id,user_id,name,normalized_name,context_key,
      certainty_status,confirmed_at,lifecycle_status) values ($1,$2,'Alpha','alpha',$3,'confirmed',now(),'active')`,
      [projectId, userId, scope]);
    await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','All scopes',$2,array['context:read','context:write'],array['*'])`, [userId, token]);
    const anon = server.getPgClient();
    clients.push(anon);
    await anon.connect();
    await anon.query('set role anon');
    const rpc = async (name, input) => (await anon.query(`select public.${name}($1,$2) v`, [token, input])).rows[0].v;
    const create = async (where, title, content, typeFields = { note_kind: 'log' }) => {
      const r = await rpc('clued_record_mutate', { operation: 'create', record_type: 'note',
        record_schema_version: 1, lifecycle_status: 'active', scope: where, idempotency_key: uuid(),
        authority: 'observed', confidence_reason: 'fixture', source_refs: [], source_unavailable_reason: 'fixture',
        mutation: { title, content, type_fields: typeFields } });
      assert.equal(r.status, 'committed', JSON.stringify(r));
      return r.target_refs[0].id;
    };
    const session = async (contextKey) => rpc('clued_mcp_restore', { context_key: contextKey });

    // Records in two scopes, mixed case, CJK and Latin, terms in titles, contents and type fields.
    await create('global', 'Merge Executor 合并执行器', '执行器 merges the queue head; 认领 bound to the PR');
    await create('global', 'Runner hook', 'The HOOK refuses ungated re-runs; 合并 is not here');
    await create(scope, '项目记录 Alpha', 'alpha-beta_gamma.delta joined run and 认领');
    await create(scope, 'Type field only', 'nothing here', { note_kind: 'log', marker: 'FIELDMARKER 执行器' });
    for (let i = 0; i < 30; i += 1) await create('global', `Filler ${i}`, `filler text number ${i} 合并 ${i % 3 === 0 ? '执行' : ''}`);
    // LIKE and regex characters are plain text to the scorer.
    await create('global', 'Special chars', 'rate 100%_x\\y [a-z]+ (group) ÄÖÜ İstanbul ß');
    // Legacy events (history only) besides the record events, and checkpoints (history only).
    const legacyEvent = (marker) => admin.query(`insert into public.clued_context_events(user_id,context_key,event_type,payload)
      values($1,'global','note',$2)`, [userId, { marker }]);
    for (const marker of ['EventMarker 合并执行器', 'event 认领 only', 'unrelated payload']) await legacyEvent(marker);
    // Fixture checkpoints skip the currentness trigger, which needs a resumed session.
    await admin.query(`set session_replication_role = replica`);
    for (const [summary, snapshot] of [['Checkpoint 合并执行器 summary', { note: 'SnapshotMarker 认领' }],
      ['plain checkpoint', { deep: { nested: 'CHECKPOINTDEEP marker' } }]]) {
      await admin.query(`insert into public.clued_context_checkpoints(id,user_id,context_key,version,snapshot,summary,next_action)
        values($1,$2,'global',(select coalesce(max(version),0)+1 from public.clued_context_checkpoints where user_id=$2 and context_key='global'),$3,$4,'next')`,
        [uuid(), userId, snapshot, summary]);
    }
    await admin.query(`set session_replication_role = origin`);

    const searchSession = (await session('global')).session_token;
    const QUERIES = [
      { query: '合并执行器' }, { query: '执行器 认领' }, { query: '合并' }, { query: 'hook' }, { query: 'HOOK refuses' },
      { query: 'alpha-beta_gamma.delta' }, { query: 'fieldmarker' }, { query: 'eventmarker', include_history: true },
      { query: 'snapshotmarker', include_history: true },
      { query: 'checkpointdeep', include_history: true }, { query: '合并执行器', include_history: true },
      { query: '认领', include_history: true, limit: 3 }, { query: '合并', limit: 5, cursor: 5 }, { query: 'filler', limit: 50 },
      { query: '执', include_history: true }, { query: 'nomatchatall' }, { query: 'x' },
      { query: '合并', context_key: 'global' }, { query: '认领', scope: 'all' },
      { query: '100%_x\\y' }, { query: '[a-z]+' }, { query: 'äöü' }, { query: '%' }, { query: '_' },
    ];
    // Results without the volatile per-call fields.
    const answer = async (input) => {
      const r = await rpc('clued_mcp_search_context', { session_token: searchSession, ...input });
      return JSON.parse(JSON.stringify(r));
    };
    const before = [];
    for (const input of QUERIES) before.push(await answer(input));
    assert.ok(before.some((r) => r.results.length > 0), 'the fixture matches something');

    // As production: the text it applied first (20261010013611, history-only), then this file on top,
    // which must leave that state as it is; then this file once more.
    await admin.query(await fs.readFile(path.join(root, 'supabase/ledger/history-only/20261010013611_search_context_text_cache_v1.sql'), 'utf8'));
    await apply(names.filter((name) => name >= MIGRATION));
    await apply([MIGRATION]);
    // Backfill: one stored text per row of the three tables.
    const counts = (await admin.query(`select
      (select count(*) from public.clued_memories)::int records,
      (select count(*) from public.clued_context_checkpoints)::int checkpoints,
      (select count(*) from public.clued_context_events)::int events,
      (select count(*) filter (where source='record') from clued_private.search_text_v1)::int s_records,
      (select count(*) filter (where source='checkpoint') from clued_private.search_text_v1)::int s_checkpoints,
      (select count(*) filter (where source='event') from clued_private.search_text_v1)::int s_events`)).rows[0];
    assert.deepEqual([counts.s_records, counts.s_checkpoints, counts.s_events], [counts.records, counts.checkpoints, counts.events]);

    // The same searches answer exactly as before.
    for (const [i, input] of QUERIES.entries()) {
      assert.deepEqual(await answer(input), before[i], JSON.stringify(input));
    }

    // Triggers: a new record, an updated record and a new event are searchable at once.
    const fresh = await create('global', 'Fresh record', 'FRESHMARKER after the migration');
    let r = await answer({ query: 'freshmarker' });
    assert.deepEqual(r.results.filter((x) => x.kind === 'record').map((x) => x.id), [fresh]);
    await admin.query(`update public.clued_memories set content='RENAMEDMARKER now' where id=$1`, [fresh]);
    assert.equal((await answer({ query: 'freshmarker' })).results.filter((x) => x.kind === 'record').length, 0);
    assert.deepEqual((await answer({ query: 'renamedmarker' })).results.filter((x) => x.kind === 'record').map((x) => x.id), [fresh]);
    assert.equal((await admin.query(`select text_lc from clued_private.search_text_v1 where source='record' and source_id=$1`, [fresh])).rows[0].text_lc,
      'fresh record\nrenamedmarker now\n{"note_kind": "log"}');
    await legacyEvent('LATEEVENT marker');
    assert.ok((await answer({ query: 'lateevent', include_history: true })).results.some((x) => x.kind === 'event'));
    // A row without a stored text is still found.
    await admin.query(`delete from clued_private.search_text_v1 where source='record' and source_id=$1`, [fresh]);
    assert.deepEqual((await answer({ query: 'renamedmarker' })).results.filter((x) => x.kind === 'record').map((x) => x.id), [fresh]);
    // An update of type_fields alone refreshes the stored text.
    await admin.query(`update public.clued_memories set type_fields='{"note_kind":"log","tag":"TYPEONLYMARKER"}' where id=$1`, [fresh]);
    assert.deepEqual((await answer({ query: 'typeonlymarker' })).results.filter((x) => x.kind === 'record').map((x) => x.id), [fresh]);
    // A row moved to another account leaves this account's search and keys its text by the new account.
    const other = uuid();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at) values($1,'other@example.invalid',now())`, [other]);
    await admin.query(`update public.clued_memories set user_id=$2 where id=$1`, [fresh, other]);
    assert.equal((await answer({ query: 'typeonlymarker' })).results.filter((x) => x.kind === 'record').length, 0);
    assert.deepEqual((await admin.query(`select user_id from clued_private.search_text_v1 where source='record' and source_id=$1`, [fresh])).rows,
      [{ user_id: other }]);
    // Deleting a record or an event deletes its stored text.
    await admin.query(`delete from public.clued_memories where id=$1`, [fresh]);
    const [late] = (await admin.query(`select id from public.clued_context_events where payload->>'marker'='LATEEVENT marker'`)).rows;
    await admin.query(`delete from public.clued_context_events where id=$1`, [late.id]);
    assert.equal((await admin.query(`select count(*)::int n from clued_private.search_text_v1 where (source='record' and source_id=$1) or (source='event' and source_id=$2)`,
      [fresh, String(late.id)])).rows[0].n, 0);
    // Deleting a source row deletes its stored text.
    const [checkpoint] = (await admin.query(`select id from public.clued_context_checkpoints where summary='plain checkpoint'`)).rows;
    await admin.query(`delete from public.clued_context_checkpoints where id=$1`, [checkpoint.id]);
    assert.equal((await admin.query(`select count(*)::int n from clued_private.search_text_v1 where source='checkpoint' and source_id=$1`, [checkpoint.id])).rows[0].n, 0);

    // Nothing new is callable or readable by the API roles.
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const fn of ['search_text_record_v1(text,text,jsonb)', 'search_text_checkpoint_v1(text,text,jsonb)',
        'search_text_event_v1(jsonb)', 'search_text_sync_v1()', 'search_score_lc_v1(text,text,text[])']) {
        assert.equal((await admin.query(`select has_function_privilege($1,$2,'execute') ok`, [role, `clued_private.${fn}`])).rows[0].ok,
          false, `${role} ${fn}`);
      }
      assert.equal((await admin.query(`select has_table_privilege($1,'clued_private.search_text_v1','select') ok`, [role])).rows[0].ok,
        false, `${role} search_text_v1`);
    }
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
    await removeTestDirectory(directory).catch(() => {});
  }
});
