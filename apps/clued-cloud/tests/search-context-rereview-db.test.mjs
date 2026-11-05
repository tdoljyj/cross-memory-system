import { stopCluster, removeTestDirectory } from './cluster-cleanup.mjs';
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
import { setWorkerGatewayCaller, findGatewayCloseoutMigration, assertGatewayCloseoutBoundary } from './worker-gateway-caller-fixture.mjs';

// Search re-review (Owner Decisions 07f80a00 and 5d61f655, Task f46591b2):
// input checks after authorization, admitted-only resume hints, the session's
// context, merged projects, paging limit and byte budget.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

test('search re-review: inputs, sessions, merged projects and paging limit', { timeout: 600000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-search-rereview-'));
  const server = new EmbeddedPostgres({
    databaseDir: directory, user: 'postgres', password: hash(), port: await freePort(),
    persistent: false, postgresFlags: ['-c', 'io_method=sync'],
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
    for (const name of (await fs.readdir(path.join(root, 'supabase/migrations')))
      .filter((name) => name.endsWith('.sql')).sort()) {
      try { await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    }
    // The complete migration chain must include the formal G6 closeout.
    await findGatewayCloseoutMigration(root);
    await assertGatewayCloseoutBoundary(admin);
    await allowRawTestBindings(admin);
    for (const fn of ['search_int_input_v1(jsonb,integer)', 'search_bool_input_v1(jsonb)',
      'search_scope_allowed_v2(text,text,text,text[])']) {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        assert.equal((await admin.query('select has_function_privilege($1,$2,\'execute\') ok',
          [role, `clued_private.${fn}`])).rows[0].ok, false, `${role} ${fn}`);
      }
    }

    const userId = uuid();
    const allToken = hash();
    const projectAToken = hash();
    const writeOnlyToken = hash();
    const revokedToken = hash();
    const projectA = uuid();
    const projectB = uuid();
    const scopeA = `project:${projectA}`;
    const scopeB = `project:${projectB}`;
    await admin.query(`insert into auth.users(id,email,email_confirmed_at) values($1,'owner@example.invalid',now())`, [userId]);
    await admin.query(`insert into public.clued_projects(id,user_id,name,normalized_name,context_key,
      certainty_status,confirmed_at,lifecycle_status) values
      ($1,$3,'Alpha','alpha',$4,'confirmed',now(),'active'),($2,$3,'Beta','beta',$5,'confirmed',now(),'active')`,
      [projectA, projectB, userId, scopeA, scopeB]);
    await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','All scopes',$2,array['context:read','context:write'],array['*']),
            ($1,'synthetic','Project A only',$3,array['context:read','context:write'],array[$6]),
            ($1,'synthetic','Write only',$4,array['context:write'],array['global']),
            ($1,'synthetic','Revoked',$5,array['context:read'],array['global'])`,
      [userId, allToken, projectAToken, writeOnlyToken, revokedToken, scopeA]);
    await admin.query('update public.clued_agent_bindings set revoked_at=now() where token_hash=clued_private.credential_verifier_v1($1)', [revokedToken]);
    const gateway = server.getPgClient();
    clients.push(gateway);
    await gateway.connect();
    await setWorkerGatewayCaller(gateway);
    const rpc = async (token, name, input) => (await gateway.query(`select public.${name}($1,$2) v`, [token, input])).rows[0].v;
    const create = async (scope, title, content) => {
      const r = await rpc(allToken, 'clued_record_mutate', { operation: 'create', record_type: 'note',
        record_schema_version: 1, lifecycle_status: 'active', scope, idempotency_key: uuid(),
        authority: 'observed', confidence_reason: 'fixture', source_refs: [], source_unavailable_reason: 'fixture',
        mutation: { title, content, type_fields: { note_kind: 'log' } } });
      assert.equal(r.status, 'committed', JSON.stringify(r));
      return r.target_refs[0].id;
    };
    const resume = (token, contextKey = 'global') => rpc(token, 'clued_mcp_restore', { context_key: contextKey });
    const allSession = (await resume(allToken)).session_token;
    const search = (input, token = allToken, sess = allSession) =>
      rpc(token, 'clued_mcp_search_context', { session_token: sess, ...input });
    const recordIds = (result) => result.results.filter((r) => r.kind === 'record').map((r) => r.id);
    const note = await create('global', 'Rereview marker note', 'rereviewmarker body');

    // Paging and history inputs: integers (or digit strings) and booleans only,
    // checked after authorization, never a raw cast error.
    let result = await search({ query: 'rereviewmarker', limit: '5' });
    assert.equal(result.page.limit, 5);
    assert.deepEqual(recordIds(result), [note]);
    for (const bad of [{ limit: 'abc' }, { limit: 1.5 }, { cursor: 99999999999 }, { max_bytes: [1] },
      { include_history: 'yes' }, { include_history: 1 }]) {
      await assert.rejects(() => search({ query: 'rereviewmarker', ...bad }), /invalid_page_input/, JSON.stringify(bad));
    }
    await assert.rejects(() => search({ query: 'x', limit: 'abc' }, hash(), allSession), /binding_not_authorized/);
    await assert.rejects(() => search({ query: 'x', cursor: 10001 }), /search_cursor_too_deep/);
    await assert.rejects(() => search({ query: '' }), /invalid_query_length/);

    // A context_key other than the session's own context is named as such.
    await assert.rejects(() => search({ query: 'x', context_key: scopeA }), /session_context_mismatch/);

    // Without a session, only an admitted Binding is told to resume.
    await assert.rejects(() => search({ query: 'x' }, allToken, null), /resume_required/);
    await assert.rejects(() => search({ query: 'x' }, revokedToken, null), /binding_not_authorized/);
    await assert.rejects(() => search({ query: 'x' }, writeOnlyToken, null),
      (error) => !/resume_required/.test(error.message));

    // Merged projects: a Binding granted only project A does not see project
    // B's events or records after A is merged into B.
    const sessionA = (await resume(projectAToken, scopeA)).session_token;
    const resumedB = await resume(allToken, scopeB);
    await rpc(allToken, 'clued_mcp_append_event', { context_key: scopeB, session_token: resumedB.session_token,
      base_version: resumedB.version, event_type: 'action', payload: { marker: 'mergedsecretmarker' }, idempotency_key: uuid() });
    const recordB = await create(scopeB, 'Beta record', 'mergedsecretmarker in beta');
    result = await search({ query: 'mergedsecretmarker', context_key: scopeB, include_history: true }, allToken, resumedB.session_token);
    assert.ok(result.results.some((r) => r.kind === 'event'), JSON.stringify(result));
    assert.ok(recordIds(result).includes(recordB));
    await admin.query('update public.clued_projects set merged_into_project_id=$1 where id=$2', [projectB, projectA]);
    for (const includeHistory of [false, true]) {
      result = await search({ query: 'mergedsecretmarker', context_key: scopeA, include_history: includeHistory },
        projectAToken, sessionA);
      assert.deepEqual(result.results, [], `include_history=${includeHistory}: ${JSON.stringify(result)}`);
    }
    // An all-scope Binding resumed in A searches A's effective project, B.
    const allInA = (await resume(allToken, scopeA)).session_token;
    result = await search({ query: 'mergedsecretmarker', context_key: scopeA, include_history: true }, allToken, allInA);
    assert.ok(recordIds(result).includes(recordB), JSON.stringify(result));
    assert.ok(result.results.some((r) => r.kind === 'event' && Array.isArray(r.target_refs)), JSON.stringify(result));

    // Byte budget: the first row is returned even when it alone is over the budget.
    // Equal scores rank the newest first, so the large row is created last.
    await create('global', 'Oversize second', `oversizemarker ${'y'.repeat(100)}`);
    const big = await create('global', 'Oversize note', `oversizemarker ${'x'.repeat(6000)}`);
    result = await search({ query: 'oversizemarker', context_key: 'global', max_bytes: 4096 });
    assert.equal(result.page.returned, 1);
    assert.equal(result.results[0].id, big);
    assert.equal(result.page.oversize_first_item, true);
    assert.equal(result.page.truncated, true);

    // The paging limit: a page that reaches 10000 results has no next_cursor.
    // A migration leaves statement_timeout = 30s on this connection; the bulk
    // insert below can take longer on a busy runner.
    await admin.query('set statement_timeout = 0');
    await admin.query(`insert into public.clued_memories
      select (jsonb_populate_record(null::public.clued_memories, to_jsonb(m) || jsonb_build_object(
        'id', gen_random_uuid(), 'title', 'Bulk cap note ' || g, 'content', 'bulkcapmarker',
        'idempotency_key', null, 'record_key', null))).*
      from public.clued_memories m, generate_series(1,10003) g where m.id=$1`, [note]);
    result = await search({ query: 'bulkcapmarker', context_key: 'global', include_history: true, limit: 2, cursor: 9990 });
    assert.equal(result.page.next_cursor, 9992, JSON.stringify(result.page));
    assert.equal(result.page.cursor_limit_reached, false);
    result = await search({ query: 'bulkcapmarker', context_key: 'global', include_history: true, limit: 1, cursor: 10000 });
    assert.equal(result.page.returned, 1, JSON.stringify(result.page));
    assert.equal(result.page.truncated, true);
    assert.equal(result.page.next_cursor, null);
    assert.equal(result.page.cursor_limit_reached, true);
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
    await removeTestDirectory(directory);
  }
});
