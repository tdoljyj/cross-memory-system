import { stopCluster, removeTestDirectory, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS, startCluster } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { newCluster } from './pg-cluster-fixture.mjs';
import { allowRawTestBindings } from './raw-binding-grants-fixture.mjs';

// Agent messages switch (migration 20261008190000, Task 17a8649b, Owner
// Decision 2bacda7a): one switch per account, on by default, turned only by
// the user signed in to Clued directly. Off refuses new messages and replies;
// reading and replays of earlier sends are unchanged.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const nowEpoch = () => Math.floor(Date.now() / 1000);
const human = (sub, extra = {}) =>
  ({ sub, role: 'authenticated', session_id: 'sess-owner', aal: 'aal1', amr: [{ method: 'password', timestamp: nowEpoch() }], ...extra });


test('agent messages switch: default on, only the signed-in user turns it, off refuses sends',
  { timeout: 300000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-agent-messages-switch-'));
  const server = newCluster({
    databaseDir: directory, user: 'postgres', password: hash(), 
    persistent: false, initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS],
    onLog() {}, onError(message) { process.stderr.write(`${message}\n`); },
  });
  const clients = [];
  try {
    await startCluster(server);
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
    await allowRawTestBindings(admin);

    const userId = uuid();
    const otherUser = uuid();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at)
      values($1,'switch@example.invalid',now()),($2,'switch-other@example.invalid',now())`, [userId, otherUser]);
    const tokens = {};
    const bindingIds = {};
    for (const [name, owner] of [['claude', userId], ['codex', userId], ['other-a', otherUser], ['other-b', otherUser]]) {
      tokens[name] = hash();
      bindingIds[name] = (await admin.query(`insert into public.clued_agent_bindings
        (user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic',$2,$3,$4,$5) returning id`,
        [owner, name, tokens[name], ['context:read', 'context:write'], ['*']])).rows[0].id;
    }
    const anon = server.getPgClient();
    clients.push(anon);
    await anon.connect();
    await anon.query('set role anon');
    const page = server.getPgClient();
    clients.push(page);
    await page.connect();
    await page.query('set role authenticated');

    const agent = async (who, name, input) =>
      (await anon.query(`select public.${name}($1,$2) v`, [tokens[who], input])).rows[0].v;
    const native = async (name, input, claims = human(userId)) => {
      await page.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
        [claims.sub ?? '', JSON.stringify(claims)]);
      return (await page.query(`select public.${name}($1) v`, [input])).rows[0].v;
    };
    const committed = (result) => { assert.equal(result.status, 'committed', JSON.stringify(result)); return result; };
    const rejected = (result, code) => { assert.deepEqual([result.status, result.error_code], ['rejected', code], JSON.stringify(result)); return result; };
    const send = (who, to, key = uuid(), extra = {}) => agent(who, 'clued_agent_message_send_v1',
      { to: { binding_id: bindingIds[to] }, kind: 'info', subject: 'progress', body: 'PR 637 is waiting on CI.', idempotency_key: key, ...extra });
    const setting = (claims) => native('clued_agent_messages_setting_v1', {}, claims);
    const turn = (enabled, base_version, claims) => native('clued_agent_messages_setting_set_v1', { enabled, base_version }, claims);
    const switchReceipts = async (owner = userId) => (await admin.query(
      `select version,metadata from public.clued_audit_receipts
        where operation='agent_messages_setting_set' and user_id=$1 order by version`, [owner])).rows;

    // Nobody but the definer reaches the table or the helpers.
    for (const client of [anon, page]) {
      await assert.rejects(() => client.query('select * from clued_private.agent_message_settings_v1'), /permission denied/);
      await assert.rejects(() => client.query('select clued_private.agent_messages_enabled_v1($1)', [userId]), /permission denied/);
    }

    // --- Default: on, with no row. A new account needs no setting. ---
    assert.deepEqual(await setting(), { status: 'ok', enabled: true, version: 0, default: true, updated_at: null, receipt_id: null });
    assert.equal((await agent('claude', 'clued_agent_inbox_summary_v1', {})).agent_messages_enabled, true);
    const before = committed(await send('claude', 'codex', 'claude:before-switch'));

    // --- Agents cannot reach the switch: not through a Binding token, not through a delegated login. ---
    await assert.rejects(() => anon.query('select public.clued_agent_messages_setting_v1($1)', [{}]), /permission denied/);
    await assert.rejects(() => anon.query('select public.clued_agent_messages_setting_set_v1($1)', [{ enabled: false, base_version: 0 }]), /permission denied/);
    await assert.rejects(() => turn(false, 0, human(userId, { client_id: 'oauth-client' })), /direct_human_session_required/);
    await assert.rejects(() => setting(human(userId, { client_id: 'oauth-client' })), /direct_human_session_required/);
    await assert.rejects(() => turn(false, 0, { role: 'authenticated' }), /direct_human_session_required/);
    await assert.rejects(() => turn(false, 0, human(uuid())), /direct_human_session_required/, 'an unknown user');
    const noSession = human(userId); delete noSession.session_id;
    await assert.rejects(() => turn(false, 0, noSession), /agent_messages_setting_session_required/);
    for (const input of [{ enabled: 'no', base_version: 0 }, { enabled: false }, { enabled: false, base_version: -1 },
      { enabled: false, base_version: 1.5 }, { enabled: false, base_version: 0, extra: 1 }, []]) {
      await assert.rejects(() => native('clued_agent_messages_setting_set_v1', input), /agent_messages_setting_input_invalid/, JSON.stringify(input));
    }
    await assert.rejects(() => native('clued_agent_messages_setting_v1', { x: 1 }), /agent_messages_setting_input_invalid/);
    assert.deepEqual(await switchReceipts(), [], 'refused attempts change nothing');

    // --- The user turns it off. ---
    const off = committed(await turn(false, 0));
    assert.deepEqual([off.changed, off.enabled, off.version, off.default], [true, false, 1, false]);
    let receipts = await switchReceipts();
    assert.equal(receipts.length, 1);
    assert.deepEqual([receipts[0].metadata.receipt_kind, receipts[0].metadata.session_id, receipts[0].metadata.principal],
      ['AGENT_MESSAGES_DISABLED', 'sess-owner', 'native_account_session']);
    assert.equal(off.receipt_id !== null, true);

    // A stale page and a repeat change nothing.
    const stale = rejected(await turn(true, 0), 'agent_messages_setting_version_conflict');
    assert.deepEqual([stale.current.enabled, stale.current.version], [false, 1]);
    const same = committed(await turn(false, 1));
    assert.deepEqual([same.changed, same.enabled, same.version], [false, false, 1]);
    assert.equal((await switchReceipts()).length, 1);

    // Off: new messages and replies are refused with how_to; the refusal leaves no message.
    const refused = rejected(await send('claude', 'codex'), 'agent_messages_disabled');
    assert.match(refused.how_to, /tell the Owner in one line/);
    rejected(await agent('codex', 'clued_agent_message_send_v1', { reply_to: before.message.message_id,
      subject: 'ack', body: 'thanks', idempotency_key: uuid() }), 'agent_messages_disabled');
    assert.equal(Number((await admin.query('select count(*) from clued_private.agent_messages_v1 where user_id=$1', [userId])).rows[0].count), 1);
    // A replay of a send committed before the switch still answers.
    const replay = committed(await send('claude', 'codex', 'claude:before-switch'));
    assert.deepEqual([replay.replayed, replay.message.message_id], [true, before.message.message_id]);
    // Reading is unchanged, and the summary says the switch is off.
    const read = await agent('codex', 'clued_agent_inbox_v1', { view: 'all' });
    assert.equal(read.status, 'ok');
    assert.deepEqual(read.messages.map((m) => m.message_id), [before.message.message_id]);
    const summary = await agent('codex', 'clued_agent_inbox_summary_v1', {});
    assert.deepEqual([summary.status, summary.agent_messages_enabled], ['ok', false]);

    // Another account keeps its own default.
    assert.equal((await setting(human(otherUser))).enabled, true);
    committed(await send('other-a', 'other-b'));

    // --- The user turns it back on. ---
    const on = committed(await turn(true, 1));
    assert.deepEqual([on.changed, on.enabled, on.version], [true, true, 2]);
    receipts = await switchReceipts();
    assert.deepEqual(receipts.map((r) => [Number(r.version), r.metadata.receipt_kind]),
      [[1, 'AGENT_MESSAGES_DISABLED'], [2, 'AGENT_MESSAGES_ENABLED']]);
    assert.deepEqual(await switchReceipts(otherUser), []);
    committed(await send('claude', 'codex'));
    assert.equal((await agent('codex', 'clued_agent_inbox_summary_v1', {})).agent_messages_enabled, true);
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
    await removeTestDirectory(directory);
  }
});
