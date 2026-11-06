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
import { setWorkerGatewayCaller, workerGatewayRpc, assertGatewayCloseoutBoundary } from './worker-gateway-caller-fixture.mjs';

// Priority custom v1 (migration 20261031070000, Task a72ecb24, Owner Decision
// be5d5b6c): record priority holds only the Owner's custom priority. Record
// writes drop type_fields.priority with a notice; existing values move to
// history and the column is reset; the custom priority is set by the Owner on
// /priority or by an Agent on the Owner's request (clued_mtpe_owner_pin
// custom_priority_set), each with a receipt, and the Owner undoes the latest
// change in one step; MTPE adds 0.3 x custom priority to the automatic score.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationName = '20261031070000_priority_custom_v1.sql';
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const nowEpoch = () => Math.floor(Date.now() / 1000);
const human = (sub, extra = {}) =>
  ({ sub, role: 'authenticated', session_id: 'sess-owner', aal: 'aal1', amr: [{ method: 'password', timestamp: nowEpoch() }], ...extra });

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('priority custom v1: Agent-written priority retired, one custom channel with two sources, MTPE reads it',
  { timeout: 300000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-priority-custom-'));
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
    const migrations = path.join(root, 'supabase/migrations');
    const names = (await fs.readdir(migrations)).filter((name) => name.endsWith('.sql')).sort();
    assert.ok(names.includes(migrationName));
    const apply = async (name) => {
      try { await admin.query(await fs.readFile(path.join(migrations, name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    };
    // The state right before the migration, with Agent-written priorities in it.
    for (const name of names.filter((name) => name < migrationName)) await apply(name);
    await allowRawTestBindings(admin);

    const userId = uuid();
    const otherUser = uuid();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at)
      values($1,'priority@example.invalid',now()),($2,'priority-other@example.invalid',now())`, [userId, otherUser]);
    const tokens = {};
    for (const [name, owner, scopes] of [['host', userId, ['context:read', 'context:write']],
      ['reader', userId, ['context:read']], ['other', otherUser, ['context:read', 'context:write']]]) {
      tokens[name] = hash();
      await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic',$2,$3,$4,$5)`, [owner, name, tokens[name], scopes, ['*']]);
    }
    const gateway = server.getPgClient();
    clients.push(gateway);
    await gateway.connect();
    await setWorkerGatewayCaller(gateway);
    const rpc = (who, name, input) => workerGatewayRpc(gateway, name, tokens[who], input);
    const mutate = (input, who = 'host') => rpc(who, 'clued_record_mutate', input);
    const record = (operation, extra) => ({ operation, record_type: 'task', record_schema_version: 1,
      lifecycle_status: 'active', scope: 'global', idempotency_key: uuid(), authority: 'user_explicit',
      user_confirmed: true, confidence_reason: 'priority custom fixture', ...extra });
    const create = async (title, typeFields, type = 'task') => {
      const result = await mutate(record('create', { record_type: type, source_refs: [], source_unavailable_reason: null,
        mutation: { title, content: title, type_fields: typeFields, relations: {} } }));
      assert.equal(result.status, 'committed', JSON.stringify(result));
      return result.target_refs[0].id;
    };
    const row = async (id) => (await admin.query(`select priority,type_fields,version,content_hash,updated_at,lifecycle_status
      from public.clued_memories where id=$1`, [id])).rows[0];
    const projection = async (id) => (await admin.query(`select algorithm_priority,priority_inputs
      from clued_private.mtpe_intake_projection where record_id=$1`, [id])).rows[0];

    const agentTask = await create('Agent-numbered task', { execution_bucket: 'next', criticality: 'NORMAL', priority: 90 });
    const plainTask = await create('Plain task', { execution_bucket: 'next', criticality: 'NORMAL' });
    const decision = await create('Agent-numbered decision', { rationale: 'fixture', priority: 70 }, 'decision');
    const imported = await create('Imported compatibility priority', { execution_bucket: 'next', criticality: 'NORMAL' });
    await admin.query('update public.clued_memories set priority=40 where id=$1', [imported]);
    const before = {};
    for (const id of [agentTask, plainTask, decision, imported]) before[id] = await row(id);
    assert.deepEqual([before[agentTask].priority, before[decision].priority, before[imported].priority], [90, 70, 40]);
    assert.equal((await projection(agentTask)).priority_inputs.explicit_priority_signal, 12);

    await apply(migrationName);
    for (const name of names.filter((name) => name > migrationName)) await apply(name);

    // --- The boundary stays: no anonymous or gateway RPC is added. ---
    await assertGatewayCloseoutBoundary(admin);
    for (const name of ['clued_priority_overview_v1', 'clued_priority_custom_set_v1', 'clued_priority_custom_undo_v1']) {
      const acl = (await admin.query(`select has_function_privilege('anon',$1,'EXECUTE') anon,
        has_function_privilege('clued_worker_gateway',$1,'EXECUTE') gateway,
        has_function_privilege('authenticated',$1,'EXECUTE') authenticated`, [`public.${name}(jsonb)`])).rows[0];
      assert.deepEqual(acl, { anon: false, gateway: false, authenticated: true }, name);
    }

    // --- Existing values moved to history; the column is reset; rows are otherwise untouched. ---
    const legacy = (await admin.query(`select record_id,column_priority,type_fields_priority
      from clued_private.record_priority_legacy_v1 order by column_priority desc`)).rows;
    assert.deepEqual(legacy.map((entry) => [entry.record_id, entry.column_priority, entry.type_fields_priority]),
      [[agentTask, 90, 90], [decision, 70, 70], [imported, 40, null]]);
    for (const id of [agentTask, plainTask, decision, imported]) {
      const after = await row(id);
      assert.equal(after.priority, 0, id);
      assert.deepEqual([after.type_fields, after.version, after.content_hash, after.updated_at.toISOString()],
        [before[id].type_fields, before[id].version, before[id].content_hash, before[id].updated_at.toISOString()], id);
    }
    const agentProjection = await projection(agentTask);
    assert.deepEqual([agentProjection.priority_inputs.explicit_priority_signal, agentProjection.priority_inputs.owner_custom_priority,
      agentProjection.priority_inputs.explicit_priority_rule], [0, 0, 'owner-custom-priority.v1']);

    // --- Record writes drop priority and say so. ---
    const notice = (result) => {
      assert.equal(result.notices?.[0]?.code, 'priority_not_writable', JSON.stringify(result));
      assert.match(result.notices[0].message, /custom_priority_set/);
    };
    const createInput = record('create', { source_refs: [], source_unavailable_reason: null,
      mutation: { title: 'New numbered task', content: 'x', type_fields: { execution_bucket: 'next', priority: 55 }, relations: {} } });
    const created = await mutate(createInput);
    assert.equal(created.status, 'committed', JSON.stringify(created));
    notice(created);
    const createdId = created.target_refs[0].id;
    assert.equal((await row(createdId)).priority, 0);
    assert.equal('priority' in (await row(createdId)).type_fields, false);
    const replay = await mutate(createInput);
    assert.equal(replay.replayed, true);
    notice(replay);
    const quiet = await mutate(record('update', { id: plainTask, base_version: 1,
      mutation: { type_fields: { user_product_impact: 2 } } }));
    assert.equal(quiet.status, 'committed', JSON.stringify(quiet));
    assert.equal('notices' in quiet, false);

    // The next update moves a stored Agent-written priority to legacy_priority,
    // and legacy_priority is kept as stored, also under field_mode=replace.
    const moved = await mutate(record('update', { id: agentTask, base_version: 1,
      mutation: { type_fields: { priority: 10, legacy_priority: 1 } } }));
    assert.equal(moved.status, 'committed', JSON.stringify(moved));
    notice(moved);
    let fields = (await row(agentTask)).type_fields;
    assert.deepEqual([fields.priority, fields.legacy_priority, fields.execution_bucket], [undefined, 90, 'next']);
    const replaced = await mutate(record('update', { id: agentTask, base_version: 2, field_mode: 'replace',
      mutation: { type_fields: { execution_bucket: 'next', criticality: 'NORMAL', legacy_priority: 5 } } }));
    assert.equal(replaced.status, 'committed', JSON.stringify(replaced));
    fields = (await row(agentTask)).type_fields;
    assert.deepEqual(fields, { execution_bucket: 'next', criticality: 'NORMAL', legacy_priority: 90 });
    assert.equal((await row(agentTask)).priority, 0);
    assert.equal('notices' in replaced, false, 'echoing the stored legacy_priority is not a priority write');

    const superseded = await rpc('host', 'clued_decision_supersede', {
      source_decisions: [{ id: decision, base_version: 1 }], supersede_reason: 'priority fixture', idempotency_key: uuid(),
      replacement: { record_schema_version: 1, scope: 'global', title: 'Replacement', content: 'current',
        type_fields: { rationale: 'replaces', priority: 80 }, relations: { supersedes: [decision] },
        source_refs: [], source_unavailable_reason: 'fixture', authority: 'observed', confidence_reason: 'fixture' } });
    assert.equal(superseded.status, 'committed', JSON.stringify(superseded));
    notice(superseded);
    const replacement = await row(superseded.supplemental.replacement.id);
    assert.deepEqual([replacement.priority, replacement.type_fields], [0, { rationale: 'replaces' }]);

    // Privileged SQL cannot write the column either: insert writes 0, update keeps it.
    await admin.query('update public.clued_memories set priority=77 where id=$1', [plainTask]);
    assert.equal((await row(plainTask)).priority, 0);

    // --- An Agent on the Owner's request: clued_mtpe_owner_pin custom_priority_set. ---
    const ask = (who, extra) => rpc(who, 'clued_mcp_mtpe_owner_pin', { operation: 'custom_priority_set',
      record_id: plainTask, priority: 80, base_version: 0, owner_instruction: '把 Plain task 提到最前面',
      idempotency_key: uuid(), user_confirmed: true, ...extra });
    const rejected = (result, code) => {
      assert.deepEqual([result.status, result.error_code], ['rejected', code], JSON.stringify(result)); return result; };
    await assert.rejects(() => ask('reader'), /insufficient_scope|binding_not_authorized|resource_action_not_authorized/);
    await assert.rejects(() => ask('other'), /record_not_found/);
    rejected(await ask('host', { owner_instruction: '  ' }), 'invalid_custom_priority_request');
    rejected(await ask('host', { owner_instruction: undefined }), 'invalid_custom_priority_request');
    rejected(await ask('host', { priority: 101 }), 'invalid_custom_priority_request');
    rejected(await ask('host', { user_confirmed: false }), 'invalid_custom_priority_request');
    rejected(await ask('host', { label: 'not a field of this tool' }), 'invalid_custom_priority_request');
    rejected(await ask('host', { expected_current_focus_id: plainTask }), 'invalid_custom_priority_request');
    const conflict = rejected(await ask('host', { base_version: 3 }), 'custom_priority_version_conflict');
    assert.equal(conflict.supplemental.custom_priority.version, 0);
    const scoreBefore = (await projection(plainTask)).algorithm_priority;
    const setKey = uuid();
    // The tool's other optional fields and a Host's _meta are accepted and unused.
    const set = await ask('host', { idempotency_key: setKey, reason: 'Owner asked', expected_current_focus_id: null,
      _meta: { progressToken: 1 } });
    assert.equal(set.status, 'committed', JSON.stringify(set));
    const agentReceipt = (await admin.query('select metadata from public.clued_audit_receipts where id=$1', [set.receipt_id])).rows[0].metadata;
    assert.deepEqual([agentReceipt.receipt_kind, agentReceipt.priority, agentReceipt.previous_priority, agentReceipt.base_version,
      agentReceipt.custom_priority_version, agentReceipt.changed, agentReceipt.owner_instruction],
      ['CUSTOM_PRIORITY_SET', 80, 0, 0, 1, true, '把 Plain task 提到最前面']);
    assert.equal(set.changed, true);
    assert.deepEqual([set.supplemental.custom_priority.priority, set.supplemental.custom_priority.version,
      set.supplemental.custom_priority.source, set.supplemental.custom_priority.owner_instruction,
      set.supplemental.custom_priority.agent_name, set.supplemental.custom_priority.undo_available],
      [80, 1, 'agent_on_owner_request', '把 Plain task 提到最前面', 'host', true]);
    assert.equal((await row(plainTask)).priority, 80);
    assert.equal(Number((await row(plainTask)).version), 2, 'a custom priority is not record content: the version stays');
    const scored = await projection(plainTask);
    assert.deepEqual([scored.priority_inputs.explicit_priority_signal, scored.priority_inputs.owner_custom_priority], [24, 80]);
    assert.equal(scored.algorithm_priority, scoreBefore + 24);
    assert.equal(set.event_ids.length, 1);
    assert.equal((await admin.query("select payload->>'canonical_event_type' t from public.clued_context_events where id=$1", [set.event_ids[0]])).rows[0].t,
      'extension:mtpe:custom_priority');
    const again = await ask('host', { idempotency_key: setKey, reason: 'Owner asked', expected_current_focus_id: null,
      _meta: { progressToken: 1 } });
    assert.equal(again.replayed, true);
    assert.equal(again.receipt_id, set.receipt_id);
    const same = await ask('host', { base_version: 1 });
    assert.deepEqual([same.status, same.changed, same.event_ids.length], ['committed', false, 0]);
    const historyCount = async () => Number((await admin.query(
      'select count(*) from clued_private.record_custom_priority_history_v1 where record_id=$1', [plainTask])).rows[0].count);
    assert.equal(await historyCount(), 1);

    // Record lists: custom priority first, then the most recent.
    const listed = (await rpc('host', 'clued_record_list', { level: 'global', record_type: 'task' })).records.map((entry) => entry.id);
    assert.equal(listed[0], plainTask);
    assert.deepEqual(listed.slice(1), [agentTask, createdId, imported]);

    // A closed record takes no new custom priority, but its value can always be cleared.
    const closed = await create('Closed task', { execution_bucket: 'next' });
    assert.equal((await ask('host', { record_id: closed, priority: 40 })).status, 'committed');
    assert.equal((await mutate(record('close', { id: closed, base_version: 1, lifecycle_status: 'completed',
      mutation: { closure_summary: 'done' } }))).status, 'committed');
    assert.equal((await row(closed)).priority, 40);
    rejected(await ask('host', { record_id: closed, base_version: 1 }), 'custom_priority_record_not_active');
    const cleared = await ask('host', { record_id: closed, base_version: 1, priority: 0 });
    assert.deepEqual([cleared.status, cleared.changed, (await row(closed)).priority], ['committed', true, 0]);
    assert.equal((await ask('host', { record_id: closed, base_version: 2, priority: 40 })).error_code, 'custom_priority_record_not_active');
    // Closing moves a stored Agent-written priority too, whatever the field mode.
    const closing = await create('Numbered task to close', { execution_bucket: 'next' });
    await admin.query(`update public.clued_memories set type_fields=type_fields||'{"priority":33}' where id=$1`, [closing]);
    assert.equal((await mutate(record('close', { id: closing, base_version: 1, lifecycle_status: 'completed',
      field_mode: 'replace', mutation: { closure_summary: 'done' } }))).status, 'committed');
    assert.deepEqual([(await row(closing)).type_fields.priority, (await row(closing)).type_fields.legacy_priority], [undefined, 33]);

    // --- The Owner on /priority. ---
    const page = server.getPgClient();
    clients.push(page);
    await page.connect();
    await page.query('set role authenticated');
    const native = async (name, input, claims = human(userId)) => {
      await page.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
        [claims.sub ?? '', JSON.stringify(claims)]);
      return (await page.query(`select public.${name}($1) v`, [input])).rows[0].v;
    };
    const pageReceipts = async () => (await admin.query(`select metadata from public.clued_audit_receipts
      where operation='custom_priority_set' and binding_id is null and user_id=$1 order by created_at,version`, [userId])).rows;

    const anon = server.getPgClient();
    clients.push(anon);
    await anon.connect();
    await anon.query('set role anon');
    for (const client of [anon, gateway]) {
      await assert.rejects(() => client.query('select public.clued_priority_overview_v1($1)', [{}]), /permission denied/);
      await assert.rejects(() => client.query('select public.clued_priority_custom_set_v1($1)',
        [{ record_id: plainTask, priority: 1, base_version: 1 }]), /permission denied/);
      await assert.rejects(() => client.query('select * from clued_private.record_custom_priority_v1'), /permission denied/);
    }
    await assert.rejects(() => native('clued_priority_overview_v1', {}, human(userId, { client_id: 'oauth-client' })),
      /direct_human_session_required/);
    await assert.rejects(() => native('clued_priority_custom_set_v1', { record_id: plainTask, priority: 30, base_version: 1 },
      human(userId, { client_id: 'oauth-client' })), /direct_human_session_required/);
    await assert.rejects(() => native('clued_priority_custom_set_v1', { record_id: plainTask, priority: 30, base_version: 1 },
      human(userId, { session_id: undefined })), /custom_priority_session_required/);
    for (const input of [{ record_id: plainTask, priority: 101, base_version: 1 }, { record_id: plainTask, priority: 3.5, base_version: 1 },
      { record_id: plainTask, priority: '30', base_version: 1 }, { record_id: plainTask, base_version: 1 },
      { record_id: plainTask, priority: 30, base_version: 1, source: 'agent_on_owner_request' }]) {
      await assert.rejects(() => native('clued_priority_custom_set_v1', input), /custom_priority_input_invalid/, JSON.stringify(input));
    }
    await assert.rejects(() => native('clued_priority_custom_set_v1', { record_id: uuid(), priority: 30, base_version: 0 }),
      /custom_priority_record_not_found/);

    const overview = await native('clued_priority_overview_v1', {});
    assert.equal(overview.status, 'ok');
    const entry = overview.records.find((item) => item.record_id === plainTask);
    assert.deepEqual([entry.custom.priority, entry.custom.source, entry.automatic.custom_points, entry.automatic.total],
      [80, 'agent_on_owner_request', 24, scored.algorithm_priority]);
    assert.equal(overview.records.some((item) => item.record_id === closed), false);
    assert.equal(overview.records.find((item) => item.record_id === agentTask).legacy_priority, 90);
    assert.equal(overview.total_records, overview.records.length);
    assert.deepEqual(overview.history.filter((item) => item.record_id === plainTask).map((item) => [item.record_id, item.priority, item.previous_priority, item.source, item.agent_name]),
      [[plainTask, 80, 0, 'agent_on_owner_request', 'host']]);

    assert.equal((await native('clued_priority_custom_set_v1', { record_id: plainTask, priority: 30, base_version: 0 })).error_code,
      'custom_priority_version_conflict');
    const ownerSet = await native('clued_priority_custom_set_v1', { record_id: plainTask, priority: 30, base_version: 1 });
    assert.deepEqual([ownerSet.status, ownerSet.changed, ownerSet.custom_priority.priority, ownerSet.custom_priority.version,
      ownerSet.custom_priority.source, ownerSet.custom_priority.owner_instruction], ['committed', true, 30, 2, 'owner_page', null]);
    assert.equal((await row(plainTask)).priority, 30);
    assert.equal((await projection(plainTask)).priority_inputs.explicit_priority_signal, 9);
    const unchanged = await native('clued_priority_custom_set_v1', { record_id: plainTask, priority: 30, base_version: 2 });
    assert.deepEqual([unchanged.status, unchanged.changed], ['committed', false]);
    assert.deepEqual((await pageReceipts()).map((item) => [item.metadata.receipt_kind, item.metadata.priority, item.metadata.previous_priority]),
      [['CUSTOM_PRIORITY_SET', 30, 80]]);

    // One-step undo, whoever made the latest change; undoing an undo restores it.
    const undone = await native('clued_priority_custom_undo_v1', { record_id: plainTask, base_version: 2 });
    assert.deepEqual([undone.status, undone.custom_priority.priority, undone.custom_priority.source, undone.custom_priority.version],
      ['committed', 80, 'owner_undo', 3]);
    assert.equal((await row(plainTask)).priority, 80);
    assert.equal((await native('clued_priority_custom_undo_v1', { record_id: plainTask, base_version: 2 })).error_code,
      'custom_priority_version_conflict');
    const redone = await native('clued_priority_custom_undo_v1', { record_id: plainTask, base_version: 3 });
    assert.equal(redone.custom_priority.priority, 30);
    const undoAgent = await ask('host', { record_id: imported, priority: 60 });
    assert.equal(undoAgent.status, 'committed', JSON.stringify(undoAgent));
    const backToNone = await native('clued_priority_custom_undo_v1', { record_id: imported, base_version: 1 });
    assert.deepEqual([backToNone.custom_priority.priority, (await row(imported)).priority], [0, 0]);
    assert.equal((await native('clued_priority_custom_undo_v1', { record_id: agentTask, base_version: 0 })).error_code,
      'custom_priority_nothing_to_undo');
    assert.deepEqual((await pageReceipts()).map((item) => item.metadata.receipt_kind),
      ['CUSTOM_PRIORITY_SET', 'CUSTOM_PRIORITY_UNDONE', 'CUSTOM_PRIORITY_UNDONE', 'CUSTOM_PRIORITY_UNDONE']);
    const history = (await native('clued_priority_overview_v1', {})).history;
    assert.deepEqual(history.slice(0, 2).map((item) => [item.record_id, item.priority, item.source, item.undo_of !== null]),
      [[imported, 0, 'owner_undo', true], [imported, 60, 'agent_on_owner_request', false]]);

    // Another account sees nothing of this one and cannot touch it.
    assert.deepEqual((await native('clued_priority_overview_v1', {}, human(otherUser))).records, []);
    await assert.rejects(() => native('clued_priority_custom_set_v1', { record_id: plainTask, priority: 1, base_version: 4 },
      human(otherUser)), /custom_priority_record_not_found/);
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
    await removeTestDirectory(directory);
  }
});
