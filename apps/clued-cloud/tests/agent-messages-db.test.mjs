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

// Agent Messaging v0.1 (migration 20261006090000, Task 3f6fb219, Owner
// Decision 24077bba): Agents of one account write to each other through
// Clued. A message to a claim reaches whoever holds it; a reply goes back to
// its sender and answers the request; a closed thread takes no more replies.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('agent messages: claim-addressed requests, replies, inbox, summary and their limits',
  { timeout: 300000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-agent-messages-'));
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
    await allowRawTestBindings(admin);

    const userId = uuid();
    const otherUser = uuid();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at)
      values($1,'messages@example.invalid',now()),($2,'messages-other@example.invalid',now())`, [userId, otherUser]);
    const tokens = {};
    const bindingIds = {};
    const bindings = [
      ['claude', userId, ['context:read', 'context:write'], ['*']],
      ['codex', userId, ['context:read', 'context:write'], ['*']],
      ['reader', userId, ['context:read'], ['*']],
      ['bystander', userId, ['context:read', 'context:write'], ['*']],
      ['narrow', userId, ['context:read', 'context:write'], ['project:00000000-0000-4000-8000-000000000001']],
      ['stranger', otherUser, ['context:read', 'context:write'], ['*']],
    ];
    for (const [name, owner, scopes, contexts] of bindings) {
      tokens[name] = hash();
      bindingIds[name] = (await admin.query(`insert into public.clued_agent_bindings
        (user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic',$2,$3,$4,$5) returning id`, [owner, name, tokens[name], scopes, contexts])).rows[0].id;
    }
    const anon = server.getPgClient();
    clients.push(anon);
    await anon.connect();
    await anon.query('set role anon');
    const agent = async (who, name, input) =>
      (await anon.query(`select public.${name}($1,$2) v`, [tokens[who], input])).rows[0].v;
    const committed = (result) => { assert.equal(result.status, 'committed', JSON.stringify(result)); return result; };
    const ok = (result) => { assert.equal(result.status, 'ok', JSON.stringify(result)); return result; };
    const rejected = (result, code) => { assert.deepEqual([result.status, result.error_code], ['rejected', code], JSON.stringify(result)); return result; };
    const createTask = async (title) => committed(await agent('claude', 'clued_record_mutate', {
      operation: 'create', record_type: 'task', record_schema_version: 1, lifecycle_status: 'active',
      scope: 'global', idempotency_key: uuid(), authority: 'observed',
      confidence_reason: 'messages fixture', source_refs: [], source_unavailable_reason: 'fixture',
      mutation: { title, content: 'fixture', type_fields: { execution_bucket: 'next' }, relations: {} },
    })).target_refs[0].id;
    const claim = async (taskId, who, session, writeSet) => committed(await agent(who, 'clued_work_claim_v1',
      { scope: 'global', idempotency_key: uuid(), task_id: taskId, write_set: writeSet, holder_session_ref: session }));
    const send = (who, input) => agent(who, 'clued_agent_message_send_v1', { idempotency_key: uuid(), ...input });
    const inbox = (who, input = {}) => agent(who, 'clued_agent_inbox_v1', input);
    const summary = (who, input = {}) => agent(who, 'clued_agent_inbox_summary_v1', input);
    const receipts = async (messageId) => (await admin.query(
      `select operation,metadata from public.clued_audit_receipts where object_type='agent_message' and object_id=$1`,
      [messageId])).rows;

    // Nobody but the definer reaches the table or the helpers.
    await assert.rejects(() => anon.query('select * from clued_private.agent_messages_v1'), /permission denied/);
    await assert.rejects(() => anon.query('select clued_private.agent_message_profile_v1()'), /permission denied/);

    // --- Session A (claude) holds a claim; session B (same Binding) and Codex are blocked by it. ---
    const taskA = await createTask('holder task');
    const holder = (await claim(taskA, 'claude', 'session-a', ['apps/x/**'])).claim;
    const taskB = await createTask('blocked task');
    const conflict = await agent('codex', 'clued_work_claim_v1', { scope: 'global', idempotency_key: uuid(),
      task_id: taskB, write_set: ['apps/x/y.ts'], holder_session_ref: 'codex-1' });
    rejected(conflict, 'work_claim_conflict');
    assert.equal(conflict.conflicts[0].claim_id, holder.claim_id);

    // Codex writes to the claim the conflict named.
    const ask = committed(await send('codex', { to: { claim_id: holder.claim_id }, session_ref: 'codex-1',
      subject: 'Need apps/x/y.ts', body: 'Blocked on apps/x/y.ts for task B. Can you release or narrow apps/x/**?',
      refs: [`claim:${holder.claim_id}`, `TASK:${taskB}`], idempotency_key: 'codex-1:ask-x' }));
    const askId = ask.message.message_id;
    assert.equal(ask.replayed, false);
    assert.deepEqual([ask.message.kind, ask.message.thread_id, ask.message.to_claim_id, ask.message.to_binding_id,
      ask.message.to_session_ref, ask.message.from_binding_id, ask.message.from_session_ref, ask.message.context_key],
      ['request', askId, holder.claim_id, bindingIds.claude, 'session-a', bindingIds.codex, 'codex-1', 'global']);
    assert.deepEqual(ask.message.refs, [`claim:${holder.claim_id}`, `task:${taskB}`], 'refs are normalized and sorted');
    assert.equal(ask.message.body, undefined, 'the send answer does not echo the body');
    const sentReceipt = await receipts(askId);
    assert.equal(sentReceipt.length, 1);
    assert.equal(sentReceipt[0].operation, 'agent_message_send');
    assert.equal(sentReceipt[0].metadata.receipt_kind, 'AGENT_MESSAGE_SENT');
    assert.equal(JSON.stringify(sentReceipt[0].metadata).includes('Blocked on'), false, 'the receipt never holds the body');

    // Replay with the same key returns the original; a different body under it is refused.
    const replay = committed(await send('codex', { to: { claim_id: holder.claim_id }, session_ref: 'codex-1',
      subject: 'Need apps/x/y.ts', body: 'Blocked on apps/x/y.ts for task B. Can you release or narrow apps/x/**?',
      refs: [`task:${taskB}`, `claim:${holder.claim_id}`], idempotency_key: 'codex-1:ask-x' }));
    assert.deepEqual([replay.replayed, replay.message.message_id], [true, askId]);
    rejected(await send('codex', { to: { claim_id: holder.claim_id }, session_ref: 'codex-1', subject: 'Need apps/x/y.ts',
      body: 'changed', idempotency_key: 'codex-1:ask-x' }), 'agent_message_idempotency_mismatch');

    // The holder's session sees it in the summary and the inbox; another session of the same Binding does not.
    let s = ok(await summary('claude', { session_ref: 'session-a' }));
    assert.deepEqual([s.unread_count, s.open_request_count, s.awaiting_reply_count], [1, 1, 0]);
    assert.equal(s.latest_unread[0].message_id, askId);
    assert.equal(s.latest_unread[0].body, undefined, 'the summary carries no body');
    s = ok(await summary('claude', { session_ref: 'session-b' }));
    assert.deepEqual([s.unread_count, s.open_request_count], [0, 0]);
    s = ok(await summary('claude', {}));
    assert.equal(s.unread_count, 1, 'without a session the connection reads every session’s mail');
    s = ok(await summary('claude', { claim_id: holder.claim_id }));
    assert.equal(s.open_request_count, 1, 'a renewal sees messages to its claim');
    s = ok(await summary('codex', { session_ref: 'codex-1' }));
    assert.deepEqual([s.unread_count, s.awaiting_reply_count], [0, 1]);
    // Summary is volatile: PostgREST runs STABLE RPCs read-only, and resolve_binding locks FOR SHARE.
    assert.equal((await admin.query(`select provolatile from pg_proc where proname='clued_agent_inbox_summary_v1'`)).rows[0].provolatile, 'v');

    let box = ok(await inbox('claude', { session_ref: 'session-a', view: 'unread', mark_read: false }));
    assert.equal(box.returned, 1);
    assert.equal(box.messages[0].body, 'Blocked on apps/x/y.ts for task B. Can you release or narrow apps/x/**?');
    assert.equal(box.messages[0].direction, 'incoming');
    assert.equal(box.messages[0].read_at, null);
    box = ok(await inbox('claude', { session_ref: 'session-a', view: 'unread' }));
    assert.equal(box.messages[0].read_at, null, 'the answer shows the message as it was before this read');
    assert.equal(ok(await inbox('claude', { session_ref: 'session-a', view: 'unread' })).returned, 0, 'now read');
    assert.equal(ok(await inbox('claude', { session_ref: 'session-a' })).returned, 1, 'still open');
    assert.equal(ok(await inbox('codex', { session_ref: 'codex-1' })).returned, 0, 'the sender has no incoming mail');
    box = ok(await inbox('codex', { session_ref: 'codex-1', view: 'sent' }));
    assert.deepEqual([box.returned, box.messages[0].direction, box.messages[0].answered_at], [1, 'outgoing', null]);
    assert.equal(ok(await inbox('stranger', {})).returned, 0, "another user's connection sees nothing");

    // Only participants reply; the holder answers, which marks the request answered.
    rejected(await send('bystander', { reply_to: askId, subject: 're', body: 'x' }), 'agent_message_not_participant');
    rejected(await send('claude', { reply_to: askId, session_ref: 'session-b', subject: 're', body: 'x' }),
      'agent_message_not_participant');
    rejected(await send('stranger', { reply_to: askId, subject: 're', body: 'x' }), 'agent_message_not_found');
    const answer = committed(await send('claude', { reply_to: askId, session_ref: 'session-a',
      subject: 'Re: Need apps/x/y.ts', body: 'Narrowing to apps/x/a/** within 10 minutes.' }));
    assert.deepEqual([answer.message.kind, answer.message.thread_id, answer.message.reply_to, answer.message.to_binding_id,
      answer.message.to_session_ref, answer.message.to_claim_id], ['reply', askId, askId, bindingIds.codex, 'codex-1', null]);
    s = ok(await summary('codex', { session_ref: 'codex-1' }));
    assert.deepEqual([s.unread_count, s.awaiting_reply_count], [1, 0], 'the answer arrived and the request is answered');
    s = ok(await summary('claude', { session_ref: 'session-a' }));
    assert.equal(s.open_request_count, 0);

    // The asker answers the answer: it goes back to the holder's session, and closes the thread.
    const thread = ok(await inbox('codex', { session_ref: 'codex-1', thread_id: askId }));
    assert.deepEqual(thread.messages.map((m) => [m.message_id, m.direction]), [[askId, 'outgoing'], [answer.message.message_id, 'incoming']]);
    const done = committed(await send('codex', { reply_to: answer.message.message_id, session_ref: 'codex-1',
      subject: 'Thanks', body: 'Claimed apps/x/y.ts after your narrowing.', close_thread: true }));
    assert.deepEqual([done.message.to_claim_id, done.message.to_binding_id, done.message.to_session_ref],
      [null, bindingIds.claude, 'session-a']);
    assert.ok(done.message.closed_at);
    rejected(await send('claude', { reply_to: done.message.message_id, session_ref: 'session-a', subject: 'x', body: 'y' }),
      'agent_message_thread_closed');
    assert.equal(ok(await inbox('claude', { session_ref: 'session-a' })).returned, 0, 'a closed thread leaves the open view');
    assert.equal(ok(await inbox('claude', { session_ref: 'session-a', view: 'all' })).returned, 2);

    // A message to a claim follows the claim; once it ends, the message stays with the holder it was sent to.
    const later = committed(await send('codex', { to: { claim_id: holder.claim_id }, session_ref: 'codex-1',
      kind: 'info', subject: 'FYI', body: 'Merged task B.' }));
    committed(await agent('claude', 'clued_work_release_v1',
      { scope: 'global', claim_id: holder.claim_id, fence: holder.fence, outcome: 'completed' }));
    box = ok(await inbox('claude', { session_ref: 'session-a', view: 'unread' }));
    assert.deepEqual(box.messages.map((m) => m.message_id), [later.message.message_id]);
    rejected(await send('codex', { to: { claim_id: holder.claim_id }, subject: 'x', body: 'y' }), 'agent_message_claim_not_live');
    rejected(await send('codex', { to: { claim_id: uuid() }, subject: 'x', body: 'y' }), 'agent_message_claim_not_found');

    // To a connection (and session) directly; not to yourself; not to another user's or a blind connection.
    const direct = committed(await send('claude', { to: { binding_id: bindingIds.codex, session_ref: 'codex-2' },
      session_ref: 'session-b', kind: 'info', subject: 'Heads-up', body: 'Touching apps/y next.' }));
    assert.equal(ok(await summary('codex', { session_ref: 'codex-2' })).unread_count, 1);
    assert.equal(ok(await summary('codex', { session_ref: 'codex-1' })).unread_count, 0);
    assert.equal(direct.message.kind, 'info');
    rejected(await send('claude', { to: { binding_id: bindingIds.claude, session_ref: 'session-b' }, session_ref: 'session-b',
      subject: 'x', body: 'y' }), 'agent_message_to_self');
    rejected(await send('claude', { to: { binding_id: bindingIds.stranger }, subject: 'x', body: 'y' }),
      'agent_message_recipient_not_found');
    rejected(await send('claude', { to: { binding_id: bindingIds.narrow }, subject: 'x', body: 'y' }),
      'agent_message_recipient_cannot_read');

    // A read-only connection cannot send; a malformed request is an error, not a stored message.
    await assert.rejects(() => send('reader', { to: { binding_id: bindingIds.claude }, subject: 'x', body: 'y' }), /binding_not_authorized/);
    for (const [input, code] of [
      [{ subject: 'x', body: 'y' }, 'agent_message_target_invalid'],
      [{ to: 'claim', subject: 'x', body: 'y' }, 'agent_message_target_invalid'],
      [{ to: { binding_id: bindingIds.codex, extra: 1 }, subject: 'x', body: 'y' }, 'agent_message_target_invalid'],
      [{ to: { binding_id: bindingIds.codex }, reply_to: askId, subject: 'x', body: 'y' }, 'agent_message_target_invalid'],
      [{ to: { claim_id: uuid(), binding_id: bindingIds.codex }, subject: 'x', body: 'y' }, 'agent_message_target_invalid'],
      [{ to: { claim_id: uuid(), session_ref: 's' }, subject: 'x', body: 'y' }, 'agent_message_target_invalid'],
      [{ to: { binding_id: 'not-a-uuid' }, subject: 'x', body: 'y' }, 'agent_message_target_invalid'],
      [{ to: { binding_id: bindingIds.codex }, kind: 'reply', subject: 'x', body: 'y' }, 'agent_message_kind_invalid'],
      [{ to: { binding_id: bindingIds.codex }, subject: '', body: 'y' }, 'agent_message_subject_invalid'],
      [{ to: { binding_id: bindingIds.codex }, subject: 'x', body: 'y'.repeat(4001) }, 'agent_message_body_invalid'],
      [{ to: { binding_id: bindingIds.codex }, subject: 'x', body: 'y', refs: ['no-colon'] }, 'agent_message_refs_invalid'],
      [{ to: { binding_id: bindingIds.codex }, subject: 'x', body: 'y', close_thread: true }, 'agent_message_close_thread_invalid'],
      [{ to: { binding_id: bindingIds.codex }, subject: 'x', body: 'y', idempotency_key: 'short' }, 'agent_message_idempotency_key_invalid'],
    ]) {
      await assert.rejects(() => send('claude', input), new RegExp(code), JSON.stringify(input).slice(0, 120));
    }
    await assert.rejects(() => inbox('claude', { view: 'everything' }), /agent_message_view_invalid/);
    await assert.rejects(() => inbox('claude', { limit: 0 }), /agent_message_limit_invalid/);
    await assert.rejects(() => inbox('claude', { limit: '5; drop' }), /agent_message_limit_invalid/);

    // Expired messages leave the views and are removed on the next send; their receipts stay.
    await admin.query(`update clued_private.agent_messages_v1 set created_at=now()-interval '15 days',
      expires_at=now()-interval '1 day' where message_id=$1`, [direct.message.message_id]);
    assert.equal(ok(await summary('codex', { session_ref: 'codex-2' })).unread_count, 0);
    committed(await send('codex', { to: { binding_id: bindingIds.claude }, subject: 'tick', body: 'tock', kind: 'info' }));
    assert.equal((await admin.query('select count(*)::int n from clued_private.agent_messages_v1 where message_id=$1',
      [direct.message.message_id])).rows[0].n, 0);
    assert.equal((await receipts(direct.message.message_id)).length, 1);

    // At most 120 sends per connection per hour.
    await admin.query(`insert into clued_private.agent_messages_v1(user_id,context_key,thread_id,kind,sender_binding_id,
        to_binding_id,subject,body,idempotency_key,request_hash,created_at,expires_at)
      select $1,'global',extensions.gen_random_uuid(),'info',$2,$3,'bulk','bulk','bulk-key-'||g,repeat('0',64),
        now()-interval '30 minutes',now()+interval '1 day' from generate_series(1,120) g`,
      [userId, bindingIds.codex, bindingIds.claude]);
    const limited = rejected(await send('codex', { to: { binding_id: bindingIds.claude }, subject: 'x', body: 'y' }),
      'agent_message_rate_limited');
    assert.equal(limited.limit, 'sends_per_binding_per_hour');
    assert.ok(limited.retry_after > 0 && limited.retry_after <= 3600, JSON.stringify(limited));
    committed(await send('claude', { to: { binding_id: bindingIds.codex }, subject: 'x', body: 'y', kind: 'info' }));
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await server.stop().catch(() => {});
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
});
