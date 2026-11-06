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

// S2a-1 / BUG-20260924-002: an update merges the top-level type_fields and
// relations keys it sends; null removes a key; omitted keys are kept.
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

test('record updates merge type_fields and relations instead of replacing them', { timeout: 240000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-record-merge-'));
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

    for (const role of ['anon', 'authenticated', 'service_role']) {
      assert.equal((await admin.query('select has_function_privilege($1,$2,\'execute\') ok',
        [role, 'clued_private.m1_merge_record_object(jsonb,jsonb)'])).rows[0].ok, false, role);
      assert.equal((await admin.query('select has_function_privilege($1,$2,\'execute\') ok',
        [role, 'clued_private.m1_supersedes_set(jsonb)'])).rows[0].ok, false, role);
    }

    // The IF S4 Context Policy acceptance keeps wholesale replacement, explicitly.
    assert.match((await admin.query(`select pg_get_functiondef(
      'clued_private.context_policy_view_v1(uuid,jsonb)'::regprocedure) d`)).rows[0].d,
      /'field_mode','replace','lifecycle_status','active'/);

    const userId = uuid();
    const token = hash();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at) values($1,'owner@example.invalid',now())`, [userId]);
    await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','Owner host',$2,array['context:read','context:write'],array['global'])`, [userId, token]);
    const gateway = server.getPgClient();
    clients.push(gateway);
    await gateway.connect();
    await setWorkerGatewayCaller(gateway);
    const mutate = async (input) => (await gateway.query('select public.clued_record_mutate($1,$2) v', [token, input])).rows[0].v;
    const row = async (id) => (await admin.query(
      'select version::int v,type_fields,relations,content_hash from public.clued_memories where id=$1', [id])).rows[0];
    const base = { record_schema_version: 1, lifecycle_status: 'active', scope: 'global',
      authority: 'observed', confidence_reason: 'fixture' };
    const update = (id, version, mutation) => mutate({ ...base, operation: 'update', record_type: 'task',
      id, base_version: version, idempotency_key: uuid(), mutation });

    const created = await mutate({ ...base, operation: 'create', record_type: 'task', idempotency_key: uuid(),
      source_refs: [], source_unavailable_reason: 'fixture',
      mutation: { title: 'Merge fixture', content: 'body',
        type_fields: { execution_bucket: 'next', criticality: 'HIGH', affected_tracks: ['工程与平台'] },
        relations: { follows: ['a'], parent: 'p' } } });
    assert.equal(created.status, 'committed', JSON.stringify(created));
    const id = created.target_refs[0].id;

    // 1. Naming one key keeps every key it does not name (the BUG-002 case).
    let result = await update(id, 1, { type_fields: { criticality: 'LOW' } });
    assert.equal(result.status, 'committed', JSON.stringify(result));
    let current = await row(id);
    assert.deepEqual(current.type_fields, { execution_bucket: 'next', criticality: 'LOW', affected_tracks: ['工程与平台'] });
    assert.deepEqual(current.relations, { follows: ['a'], parent: 'p' }, 'relations untouched when not sent');

    // 2. null removes an optional key; nested values are replaced as a whole.
    result = await update(id, 2, { type_fields: { affected_tracks: null }, relations: { follows: ['b', 'c'] } });
    assert.equal(result.status, 'committed', JSON.stringify(result));
    current = await row(id);
    assert.deepEqual(current.type_fields, { execution_bucket: 'next', criticality: 'LOW' });
    assert.deepEqual(current.relations, { follows: ['b', 'c'], parent: 'p' });

    // 3. A required key cannot be removed, and a rejected update changes nothing.
    result = await update(id, 3, { type_fields: { execution_bucket: null } });
    assert.equal(result.status, 'rejected', JSON.stringify(result));
    assert.match(JSON.stringify(result), /invalid_task_execution_bucket/);
    assert.equal((await row(id)).v, 3);

    // 4. A non-object patch is rejected.
    result = await update(id, 3, { type_fields: ['execution_bucket'] });
    assert.equal(result.status, 'rejected', JSON.stringify(result));
    assert.match(JSON.stringify(result), /invalid_record_shape/);

    // 5. Sending the full object still works and an empty object is a no-op merge.
    result = await update(id, 3, { type_fields: { execution_bucket: 'later', criticality: 'LOW' } });
    assert.equal(result.status, 'committed', JSON.stringify(result));
    result = await update(id, 4, { type_fields: {} });
    assert.equal(result.status, 'committed', JSON.stringify(result));
    current = await row(id);
    assert.deepEqual(current.type_fields, { execution_bucket: 'later', criticality: 'LOW' });

    // 5b. field_mode='replace' keeps the wholesale replacement; an unknown mode is rejected.
    result = await mutate({ ...base, operation: 'update', record_type: 'task', id, base_version: 5,
      idempotency_key: uuid(), field_mode: 'patch', mutation: { type_fields: { criticality: 'MID' } } });
    assert.equal(result.status, 'rejected', JSON.stringify(result));
    assert.match(JSON.stringify(result), /invalid_field_mode/);
    result = await mutate({ ...base, operation: 'update', record_type: 'task', id, base_version: 5,
      idempotency_key: uuid(), field_mode: 'replace',
      mutation: { type_fields: { execution_bucket: 'later' }, relations: {} } });
    assert.equal(result.status, 'committed', JSON.stringify(result));
    current = await row(id);
    assert.deepEqual(current.type_fields, { execution_bucket: 'later' });
    assert.deepEqual(current.relations, {});
    result = await update(id, 6, { type_fields: { criticality: 'LOW' } });
    assert.equal(result.status, 'committed', JSON.stringify(result));
    current = await row(id);

    // 5c. A null object is rejected rather than read as "clear everything".
    result = await update(id, 7, { type_fields: null });
    assert.equal(result.status, 'rejected', JSON.stringify(result));
    assert.match(JSON.stringify(result), /invalid_record_shape/);

    // 6. The stored content hash covers the merged object.
    const expected = (await admin.query(`select clued_private.m1_record_content_hash(record_type,canonical_scope,
      lifecycle_status,title,content,type_fields,relations,source_refs,source_unavailable_reason,authority,
      observed_at,closed_at,confidence,confidence_reason) h from public.clued_memories where id=$1`, [id])).rows[0].h;
    assert.equal(current.content_hash, expected);

    // 8. field_mode is validated on create too.
    result = await mutate({ ...base, operation: 'create', record_type: 'note', idempotency_key: uuid(),
      field_mode: 'patch', source_refs: [], source_unavailable_reason: 'fixture',
      mutation: { title: 'n', content: 'n', type_fields: { note_kind: 'log' } } });
    assert.equal(result.status, 'rejected', JSON.stringify(result));
    assert.match(JSON.stringify(result), /invalid_field_mode/);

    // 9. Decision lineage: relations.supersedes changes only through clued_decision_supersede.
    const dec = await mutate({ ...base, operation: 'create', record_type: 'decision', idempotency_key: uuid(),
      source_refs: [], source_unavailable_reason: 'fixture',
      mutation: { title: 'Successor', content: 'd', type_fields: { rationale: 'r' }, relations: {} } });
    assert.equal(dec.status, 'committed', JSON.stringify(dec));
    const decId = dec.target_refs[0].id;
    const predecessor = uuid();
    await admin.query(`update public.clued_memories set relations=jsonb_build_object('supersedes',jsonb_build_array($2::text))
      where id=$1`, [decId, predecessor]);
    const decUpdate = (version, extra) => mutate({ ...base, operation: 'update', record_type: 'decision', id: decId,
      base_version: version, idempotency_key: uuid(), ...extra });
    result = await decUpdate(1, { mutation: { relations: { see_also: ['x'] } } });
    assert.equal(result.status, 'committed', JSON.stringify(result));
    assert.deepEqual((await row(decId)).relations, { supersedes: [predecessor], see_also: ['x'] });
    for (const extra of [{ mutation: { relations: { supersedes: null } } },
      { mutation: { relations: { supersedes: [uuid()] } } },
      { field_mode: 'replace', mutation: { relations: {} } }]) {
      result = await decUpdate(2, extra);
      assert.equal(result.status, 'rejected', JSON.stringify(result));
      assert.match(JSON.stringify(result), /decision_supersede_command_required/);
    }
    assert.deepEqual((await row(decId)).relations, { supersedes: [predecessor], see_also: ['x'] });
    // Resending the same set (any order, or the full M1 relations shape) is not a lineage change.
    result = await decUpdate(2, { mutation: { relations: { supersedes: [predecessor], depends_on: [] } } });
    assert.equal(result.status, 'committed', JSON.stringify(result));
    const plain = await mutate({ ...base, operation: 'create', record_type: 'decision', idempotency_key: uuid(),
      source_refs: [], source_unavailable_reason: 'fixture',
      mutation: { title: 'Plain', content: 'd', type_fields: { rationale: 'r' }, relations: {} } });
    const plainId = plain.target_refs[0].id;
    result = await mutate({ ...base, operation: 'update', record_type: 'decision', id: plainId, base_version: 1,
      idempotency_key: uuid(), mutation: { relations: { depends_on: [], supersedes: [], related_records: [] } } });
    assert.equal(result.status, 'committed', JSON.stringify(result));
    result = await mutate({ ...base, operation: 'update', record_type: 'decision', id: plainId, base_version: 2,
      idempotency_key: uuid(), field_mode: 'replace', mutation: { relations: {} } });
    assert.equal(result.status, 'committed', JSON.stringify(result));
    const twoParents = [uuid(), uuid()].sort();
    await admin.query(`update public.clued_memories set relations=jsonb_build_object('supersedes',$2::jsonb) where id=$1`,
      [plainId, JSON.stringify(twoParents)]);
    result = await mutate({ ...base, operation: 'update', record_type: 'decision', id: plainId, base_version: 3,
      idempotency_key: uuid(), mutation: { relations: { supersedes: [...twoParents].reverse() } } });
    assert.equal(result.status, 'committed', JSON.stringify(result));

    // field_mode must be a string when present.
    result = await update(id, 7, { type_fields: { criticality: 'LOW' } });
    assert.equal(result.status, 'committed', JSON.stringify(result));
    result = await mutate({ ...base, operation: 'update', record_type: 'task', id, base_version: 8,
      idempotency_key: uuid(), field_mode: null, mutation: { type_fields: { criticality: 'MID' } } });
    assert.equal(result.status, 'rejected', JSON.stringify(result));
    assert.match(JSON.stringify(result), /invalid_field_mode/);

    // 7. Close still carries only closure fields and keeps the merged type_fields.
    result = await mutate({ ...base, operation: 'close', record_type: 'task', lifecycle_status: 'completed', id,
      base_version: 8, idempotency_key: uuid(), mutation: { closure_summary: 'done', closed_reason: 'fixture' } });
    assert.equal(result.status, 'committed', JSON.stringify(result));
    assert.deepEqual((await row(id)).type_fields, { execution_bucket: "later", criticality: "LOW" });

    // 10. A relations-only update on a record whose relations are empty stores and
    //     returns every key it sends (Task b9ecc7cd reported this shape as dropped).
    const bare = await mutate({ ...base, operation: 'create', record_type: 'task', idempotency_key: uuid(),
      source_refs: [], source_unavailable_reason: 'fixture',
      mutation: { title: 'Relations-only fixture', content: 'body',
        type_fields: { execution_bucket: 'later' }, relations: {} } });
    assert.equal(bare.status, 'committed', JSON.stringify(bare));
    const bareId = bare.target_refs[0].id;
    const sent = { corrects: [uuid()], observed_by: 'fixture host', open_question: { text: 'q', blocking: false } };
    result = await update(bareId, 1, { relations: sent });
    assert.equal(result.status, 'committed', JSON.stringify(result));
    assert.deepEqual(result.supplemental.record.relations, sent);
    assert.deepEqual((await row(bareId)).relations, sent);
    assert.equal((await row(bareId)).v, 2);
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
    await removeTestDirectory(directory);
  }
});
