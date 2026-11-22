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
import { setWorkerGatewayCaller, findGatewayCloseoutMigration, assertGatewayCloseoutBoundary } from './worker-gateway-caller-fixture.mjs';

// S2a-2 (Cross-Host v0.2.6 §21.1 CC-1, CC-3): a default search covers every
// readable scope and matches reworded (including Chinese) queries.
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

test('context search covers readable scopes and non-literal queries', { timeout: 600000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-search-scope-'));
  const server = new EmbeddedPostgres({
    databaseDir: directory, user: 'postgres', password: hash(), port: await freePort(),
    // The token-order assertions use Unicode byte ordering, not host locale collation.
    initdbFlags: [...EPHEMERAL_INITDB_FLAGS, '--locale=C', '--encoding=UTF8'],
    persistent: false, postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS],
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
    for (const fn of ['search_terms_v1(text)', 'search_min_score_v1(text[])',
      'search_score_v1(text,text,text[])', 'search_scope_allowed_v1(text,text,text,text[])']) {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        assert.equal((await admin.query('select has_function_privilege($1,$2,\'execute\') ok',
          [role, `clued_private.${fn}`])).rows[0].ok, false, `${role} ${fn}`);
      }
    }

    // Term splitting: punctuation and whitespace split; CJK runs become bigrams.
    assert.deepEqual((await admin.query(`select clued_private.search_terms_v1('字段合并，BUG-002') t`)).rows[0].t,
      ['002', 'bug', 'bug-002', '合并', '字段', '段合']);
    const terms = async (q) => (await admin.query('select clued_private.search_terms_v1($1) t', [q])).rows[0].t;
    assert.deepEqual(await terms('v1.6 event 3'), ['3', 'event', 'v1', 'v1.6']);
    assert.deepEqual(await terms('記録を更新する'), ['する', '新す', '更新', '記録']);
    assert.deepEqual(await terms('我'), ['我']);
    assert.deepEqual(await terms('我 部署'), ['部署']);
    // One-letter Latin runs are dropped; the first 24 distinct terms in query order are kept.
    assert.deepEqual(await terms('z_bra a cd'), ['bra', 'cd', 'z_bra']);
    const many = Array.from({ length: 30 }, (_, i) => `t${String(i).padStart(2, '0')}`);
    const kept = await terms(many.reverse().join(' '));
    assert.equal(kept.length, 24);
    assert.ok(!kept.includes('t00') && kept.includes('t29'), 'terms beyond the first 24 are the ones dropped');

    const userId = uuid();
    const allToken = hash();
    const globalToken = hash();
    const projectToken = hash();
    const profileToken = hash();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at) values($1,'owner@example.invalid',now())`, [userId]);
    await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','All scopes',$2,array['context:read','context:write'],array['*']),
            ($1,'synthetic','Global only',$3,array['context:read','context:write'],array['global'])`,
      [userId, allToken, globalToken]);
    const projectId = uuid();
    const projectScope = `project:${projectId}`;
    await admin.query(`insert into public.clued_projects(id,user_id,name,normalized_name,context_key,
      certainty_status,confirmed_at,lifecycle_status) values($1,$2,'Plugin','plugin',$3,'confirmed',now(),'active')`,
      [projectId, userId, projectScope]);
    await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','Project only',$2,array['context:read','context:write'],array[$4]),
            ($1,'synthetic','Global and profile',$3,array['context:read','context:write'],array['global','profile'])`,
      [userId, projectToken, profileToken, projectScope]);
    const gateway = server.getPgClient();
    clients.push(gateway);
    await gateway.connect();
    await setWorkerGatewayCaller(gateway);
    const rpc = async (token, name, input) => (await gateway.query(`select public.${name}($1,$2) v`, [token, input])).rows[0].v;
    const create = async (scope, type, title, content, typeFields) => {
      const r = await rpc(allToken, 'clued_record_mutate', { operation: 'create', record_type: type,
        record_schema_version: 1, lifecycle_status: 'active', scope, idempotency_key: uuid(),
        authority: 'observed', confidence_reason: 'fixture', source_refs: [], source_unavailable_reason: 'fixture',
        mutation: { title, content, type_fields: typeFields } });
      assert.equal(r.status, 'committed', JSON.stringify(r));
      return r.target_refs[0].id;
    };
    const bugTask = await create(projectScope, 'task', 'BUG-20260924-002 记录更新丢字段',
      '字段级合并缺陷：update 时整体替换 type_fields。', { execution_bucket: 'now' });
    const literalNote = await create(projectScope, 'note', '字段合并缺陷复盘', '字段合并缺陷的完整复盘。', { note_kind: 'log' });
    await create('global', 'note', '天气', '与检索无关的全局记录', { note_kind: 'log' });
    await create('profile', 'profile_fact', '字段合并偏好', '个人偏好：字段合并缺陷。', { fact_kind: 'preference' });

    const session = async (token, contextKey = 'global') =>
      (await rpc(token, 'clued_mcp_restore', { context_key: contextKey })).session_token;
    const allSession = await session(allToken);
    const search = (input, token = allToken, sess = allSession) =>
      rpc(token, 'clued_mcp_search_context', { session_token: sess, ...input });
    const recordIds = (result) => result.results.filter((r) => r.kind === 'record').map((r) => r.id);

    // CC-1: a default search (no context_key) finds a project record.
    let result = await search({ query: 'BUG-20260924-002' });
    assert.equal(result.scope, 'all');
    assert.ok(recordIds(result).includes(bugTask), JSON.stringify(result));
    assert.equal(result.absence_claim, false);
    assert.equal(result.record_candidates_capped, false);

    // An explicit context_key keeps the single-scope search, and an empty result says it is not absence.
    result = await search({ context_key: 'global', query: 'BUG-20260924-002' });
    assert.equal(result.scope, 'context');
    assert.deepEqual(recordIds(result), []);
    assert.equal(result.absence_claim, false);
    assert.match(result.empty_result_hint, /not evidence/);
    result = await search({ context_key: 'global', scope: 'all', query: 'BUG-20260924-002' });
    assert.ok(recordIds(result).includes(bugTask));

    // CC-3: a reworded Chinese question still finds the record; whole-query hits rank first.
    result = await search({ query: '字段合并的缺陷' });
    const ids = recordIds(result);
    assert.ok(ids.includes(bugTask), JSON.stringify(result));
    assert.ok(ids.includes(literalNote));
    const scores = Object.fromEntries(result.results.filter((r) => r.kind === 'record').map((r) => [r.id, r.match_score]));
    assert.ok(scores[bugTask] < 1 && scores[bugTask] >= 0.6, JSON.stringify(scores));
    result = await search({ query: '字段合并缺陷' });
    assert.equal(recordIds(result)[0], literalNote, 'the literal match ranks first');

    // Profile facts are never part of an all-scope search.
    assert.ok(!result.results.some((r) => r.scope === 'profile'), JSON.stringify(result));

    // Unrelated queries still miss.
    result = await search({ query: '部署流水线失败原因' });
    assert.deepEqual(recordIds(result), []);

    // A Binding limited to global does not see project records, even in all-scope mode.
    const globalSession = await session(globalToken);
    result = await search({ query: 'BUG-20260924-002' }, globalToken, globalSession);
    assert.deepEqual(recordIds(result), []);
    assert.deepEqual(result.scopes_searched, ['global']);

    // A default search uses the session's own context for authorization: a session
    // resumed in a project, and a project-only Binding, both search without context_key.
    const projectSession = await session(allToken, projectScope);
    result = await search({ query: 'BUG-20260924-002' }, allToken, projectSession);
    assert.equal(result.context_key, projectScope);
    assert.ok(recordIds(result).includes(bugTask), JSON.stringify(result));
    const projectOnlySession = await session(projectToken, projectScope);
    result = await search({ query: 'BUG-20260924-002' }, projectToken, projectOnlySession);
    assert.ok(recordIds(result).includes(bugTask), JSON.stringify(result));
    assert.deepEqual(result.scopes_searched, [projectScope]);
    // A session token of another Binding is not found, and a missing one asks to resume.
    await assert.rejects(() => search({ query: 'x' }, globalToken, projectSession), /resume_required/);
    await assert.rejects(() => search({ query: 'x' }, projectToken, undefined), /resume_required/);
    await assert.rejects(() => search({ query: 'x' }, projectToken, 'clued_ses_' + '0'.repeat(64)), /resume_required/);

    // scopes_searched never lists profile, which is not searched.
    const profileSession = await session(profileToken);
    result = await search({ query: '字段合并' }, profileToken, profileSession);
    assert.deepEqual(result.scopes_searched, ['global']);
    assert.ok(!result.results.some((r) => r.scope === 'profile'));
    result = await search({ query: '字段合并' });
    assert.equal(result.scopes_searched, 'all_owned_except_profile');

    // A one-term query with punctuation still matches the term.
    result = await search({ query: '缺陷！' });
    assert.ok(recordIds(result).includes(bugTask), JSON.stringify(result));
    assert.ok(recordIds(result).includes(literalNote));

    // Paging walks the ordered result without repeats.
    const first = await search({ query: '字段合并缺陷', limit: 1 });
    assert.equal(first.page.returned, 1);
    assert.equal(first.page.next_cursor, 1);
    const second = await search({ query: '字段合并缺陷', limit: 1, cursor: 1 });
    assert.notEqual(second.results[0].id, first.results[0].id);

    // An unusable bearer keeps its authorization error without a context_key.
    await assert.rejects(() => search({ query: 'x' }, hash(), allSession), /binding_not_authorized/);
    await assert.rejects(() => search({ query: 'x', cursor: 10001 }), /search_cursor_too_deep/);

    // Paging past the 2000 cap stays exact when the fence drops rows: the 20
    // best-ranked of 2010 tasks are done (HISTORY), 1990 remain current.
    for (let i = 0; i < 2010; i += 1) {
      await create('global', 'task', `Bulk paging task ${i}`, 'pagingbulk marker', { execution_bucket: 'later' });
    }
    await admin.query(`update public.clued_memories set status='done' where id in (
      select id from public.clued_memories where user_id=$1 and title like 'Bulk paging task %'
      order by updated_at desc,id limit 20)`, [userId]);
    result = await search({ query: 'pagingbulk', context_key: 'global', limit: 10, cursor: 1975 });
    assert.equal(result.page.returned, 10, JSON.stringify(result.page));
    assert.equal(result.page.next_cursor, 1985);
    result = await search({ query: 'pagingbulk', context_key: 'global', limit: 10, cursor: 1985 });
    assert.equal(result.page.returned, 5, JSON.stringify(result.page));
    assert.equal(result.page.next_cursor, null);
    assert.equal(result.record_candidates_capped, false);
    assert.ok(result.results.every((r) => r.authoritative), 'only current records are returned');

    // An unknown scope mode is rejected.
    await assert.rejects(() => search({ query: 'x', scope: 'everything' }), /invalid_search_scope/);
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
    await removeTestDirectory(directory);
  }
});
