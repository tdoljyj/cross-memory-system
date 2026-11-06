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

// raw-binding-grants: applies only migrations before 20261009050000, where raw Bindings still pass.

// The Owner's answer reaches the Agent (migration
// 20261009020000_owner_request_answers_v1; OwnerCredential.v0.1.md §13, Owner
// Decision 973e1b5b, Task d5bd604e). Once the Owner decides a request, it is an
// unread answer for the Binding (and session) that opened it, in the inbox
// summary folded into resume and renewal, and in the inbox, until read.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const nowEpoch = () => Math.floor(Date.now() / 1000);
const session = (sub, sessionId = 'sess-main') =>
  ({ sub, role: 'authenticated', session_id: sessionId, aal: 'aal1',
    amr: [{ method: 'password', timestamp: nowEpoch() - 3 * 86400 }] });

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('owner answers: a decided request reaches the session that asked, once, never for an automatic grant',
  { timeout: 300000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-owner-answers-'));
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
    const migrations = (await fs.readdir(path.join(root, 'supabase/migrations')))
      .filter((name) => name.endsWith('.sql')).sort();
    const answers = '20261009020000_owner_request_answers_v1.sql';
    assert.ok(migrations.includes(answers));
    const run = async (name) => {
      try { await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    };
    for (const name of migrations.filter((name) => name < answers)) await run(name);

    const userId = uuid();
    const otherUser = uuid();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at)
      values($1,'answers@example.invalid',now()),($2,'answers-other@example.invalid',now())`, [userId, otherUser]);
    const tokens = {};
    const bindingIds = {};
    for (const [name, user] of [['claude', userId], ['codex', userId], ['stranger', otherUser]]) {
      tokens[name] = hash();
      bindingIds[name] = (await admin.query(`insert into public.clued_agent_bindings
        (user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic',$2,$3,$4,array['*']) returning id`,
        [user, name, tokens[name], ['context:read', 'context:write']])).rows[0].id;
    }

    const anon = server.getPgClient();
    clients.push(anon);
    await anon.connect();
    await anon.query('set role anon');
    const human = server.getPgClient();
    clients.push(human);
    await human.connect();
    await human.query('set role authenticated');
    const agent = async (who, name, input) =>
      (await anon.query(`select public.${name}($1,$2) v`, [tokens[who], input])).rows[0].v;
    const native = async (name, input) => {
      const claims = session(userId);
      await human.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
        [claims.sub, JSON.stringify(claims)]);
      return (await human.query(`select public.${name}($1) v`, [input])).rows[0].v;
    };
    const committed = (result) => { assert.equal(result.status, 'committed', JSON.stringify(result)); return result; };
    const ok = (result) => { assert.equal(result.status, 'ok', JSON.stringify(result)); return result; };
    const sha = (c) => `repo:tdoljyj/cross-memory-system/${c.repeat(40)}`;
    const ask = async (input, who = 'claude') =>
      committed(await agent(who, 'clued_owner_request_v1', { idempotency_key: uuid(), ...input })).request;
    const approve = async (requestId, choice) => {
      const issued = await native('clued_owner_grant_confirmation_issue_v1', { request_id: requestId, choice });
      assert.equal(issued.status, 'issued', JSON.stringify(issued));
      return committed(await native('clued_owner_grant_v1',
        { confirmation_token: issued.confirmation_token, view_digest: issued.view_digest }));
    };
    const reject = async (requestId) => committed(await native('clued_owner_request_reject_v1', { request_id: requestId }));
    const summary = async (who, input = {}) => ok(await agent(who, 'clued_agent_inbox_summary_v1', input));
    const inbox = async (who, input = {}) => ok(await agent(who, 'clued_agent_inbox_v1', input));
    const ids = (list) => list.map((a) => a.request_id).sort();

    // --- A request the Owner decided before this migration is never an answer. ---
    const old = await ask({ action: 'release.production', resources: [sha('0')] });
    await approve(old.request_id, 'once');
    await run(answers);
    assert.equal((await summary('claude')).owner_answer_count, 0);

    // --- Requests name their session, or none. ---
    const a = await ask({ action: 'release.production', resources: [sha('a')], session_ref: 'session-1' });
    const b = await ask({ action: 'work_claim.extra_claims', resources: ['record:' + uuid()] });
    const c = await ask({ action: 'release.production', resources: [sha('c')], session_ref: 'session-2' });
    await assert.rejects(() => agent('claude', 'clued_owner_request_v1', { idempotency_key: uuid(),
      action: 'release.production', resources: [sha('d')], session_ref: ' ' }), /owner_request_session_ref_invalid/);
    await assert.rejects(() => agent('claude', 'clued_owner_request_v1', { idempotency_key: uuid(),
      action: 'release.production', resources: [sha('d')], session_ref: 7 }), /owner_request_session_ref_invalid/);
    assert.deepEqual((await admin.query(`select id,session_ref from clued_private.owner_requests_v1
      where id=any($1) order by session_ref nulls first`, [[a.request_id, b.request_id, c.request_id]])).rows
      .map((r) => [r.id, r.session_ref]),
      [[b.request_id, null], [a.request_id, 'session-1'], [c.request_id, 'session-2']]);
    // Pending requests are not answers.
    assert.equal((await summary('claude')).owner_answer_count, 0);
    assert.deepEqual((await summary('claude')).owner_answers, []);

    // --- The Owner approves once, grants, and rejects. ---
    await approve(a.request_id, 'once');
    await approve(b.request_id, 'grant');
    await reject(c.request_id);

    // Each session sees its own answers and those without a session; the
    // summary never marks them read.
    let s = await summary('claude', { session_ref: 'session-1' });
    assert.equal(s.owner_answer_count, 2);
    assert.deepEqual(ids(s.owner_answers), [a.request_id, b.request_id].sort());
    const answerA = s.owner_answers.find((x) => x.request_id === a.request_id);
    assert.equal(answerA.status, 'approved_once');
    assert.equal(answerA.source, 'owner_answer');
    assert.equal(answerA.grant.max_uses, 1);
    assert.equal(answerA.grant.auto_approved, false);
    assert.equal(s.owner_answers.find((x) => x.request_id === b.request_id).status, 'granted');
    assert.equal((await summary('claude', { session_ref: 'session-1' })).owner_answer_count, 2, 'not marked');
    s = await summary('claude', { session_ref: 'session-2' });
    assert.deepEqual(ids(s.owner_answers), [b.request_id, c.request_id].sort());
    assert.equal(s.owner_answers.find((x) => x.request_id === c.request_id).status, 'rejected');
    assert.equal((await summary('claude')).owner_answer_count, 3, 'no session: every session of the Binding');
    // Another Binding of the same account, or another account, sees none.
    assert.equal((await summary('codex')).owner_answer_count, 0);
    assert.equal((await summary('stranger')).owner_answer_count, 0);

    // --- The inbox shows them with the messages and marks them read. ---
    let box = await inbox('claude', { session_ref: 'session-1', mark_read: false });
    assert.deepEqual(ids(box.owner_answers), [a.request_id, b.request_id].sort());
    assert.equal((await summary('claude', { session_ref: 'session-1' })).owner_answer_count, 2, 'mark_read false');
    assert.deepEqual((await inbox('claude', { session_ref: 'session-1', view: 'sent' })).owner_answers, []);
    box = await inbox('claude', { session_ref: 'session-1' });
    assert.deepEqual(ids(box.owner_answers), [a.request_id, b.request_id].sort());
    assert.equal((await summary('claude', { session_ref: 'session-1' })).owner_answer_count, 0);
    assert.deepEqual((await inbox('claude', { session_ref: 'session-1' })).owner_answers, [], 'read once');
    s = await summary('claude', { session_ref: 'session-2' });
    assert.deepEqual(ids(s.owner_answers), [c.request_id], 'b was read by session-1');

    // --- Reading the status from the Binding that asked reads the answer; another Binding's read does not. ---
    ok(await agent('codex', 'clued_owner_request_status_v1', { request_id: c.request_id }));
    assert.equal((await summary('claude', { session_ref: 'session-2' })).owner_answer_count, 1);
    ok(await agent('claude', 'clued_owner_request_status_v1', { request_id: c.request_id }));
    assert.equal((await summary('claude', { session_ref: 'session-2' })).owner_answer_count, 0);

    // --- A renewal's summary (claim_id, no session) uses the claim's session. ---
    const taskId = committed(await agent('claude', 'clued_record_mutate', {
      operation: 'create', record_type: 'task', record_schema_version: 1, lifecycle_status: 'active',
      scope: 'global', idempotency_key: uuid(), authority: 'observed',
      confidence_reason: 'answers fixture', source_refs: [], source_unavailable_reason: 'fixture',
      mutation: { title: 'answers fixture', content: 'fixture', type_fields: { execution_bucket: 'next' }, relations: {} },
    })).target_refs[0].id;
    const held = committed(await agent('claude', 'clued_work_claim_v1', { scope: 'global', idempotency_key: uuid(),
      task_id: taskId, write_set: ['tests/answers-fixture.txt'], holder_session_ref: 'session-3' })).claim;
    const e = await ask({ action: 'release.production', resources: [sha('e')], session_ref: 'session-3' });
    const f = await ask({ action: 'release.production', resources: [sha('f')], session_ref: 'session-4' });
    await approve(e.request_id, 'once');
    await reject(f.request_id);
    s = await summary('claude', { claim_id: held.claim_id });
    assert.deepEqual(ids(s.owner_answers), [e.request_id]);
    assert.equal(s.owner_answer_count, 1);
    assert.equal((await summary('codex', { claim_id: held.claim_id })).owner_answer_count, 0);
    ok(await inbox('claude', { session_ref: 'session-3' }));
    ok(await inbox('claude', { session_ref: 'session-4' }));

    // --- A bundle is one answer, read as a whole. ---
    const asked = committed(await agent('claude', 'clued_owner_request_bundle_v1', {
      idempotency_key: uuid(), session_ref: 'session-5',
      actions: [{ action: 'migration.production', resources: [`${sha('g')}/apps/clued-cloud/supabase/migrations/x.sql`] },
        { action: 'release.production', resources: [sha('g')] }] })).request;
    assert.equal((await admin.query(`select count(*)::int n from clued_private.owner_requests_v1
      where bundle_id=$1 and session_ref='session-5'`, [asked.request_id])).rows[0].n, 2);
    for (const m of asked.bundle) await approve(m.request_id, 'once');
    s = await summary('claude', { session_ref: 'session-5' });
    assert.equal(s.owner_answer_count, 1);
    assert.equal(s.owner_answers[0].request_id, asked.request_id, 'shown as its first member');
    assert.deepEqual(s.owner_answers[0].bundle.map((m) => m.status), ['approved_once', 'approved_once']);
    assert.equal((await inbox('claude', { session_ref: 'session-5' })).owner_answers.length, 1);
    assert.equal((await admin.query(`select count(*)::int n from clued_private.owner_requests_v1
      where bundle_id=$1 and answer_seen_at is null`, [asked.request_id])).rows[0].n, 0, 'every member read');

    // --- The auto-approval switch already answered in the call: no second answer. ---
    const issued = await native('clued_owner_auto_approve_confirmation_issue_v1', { expires_seconds: 3600 });
    committed(await native('clued_owner_auto_approve_on_v1',
      { confirmation_token: issued.confirmation_token, view_digest: issued.view_digest }));
    const auto = await ask({ action: 'release.production', resources: [sha('h')], session_ref: 'session-6' });
    assert.equal(auto.status, 'approved_once');
    assert.equal(auto.grant.auto_approved, true);
    assert.equal((await summary('claude', { session_ref: 'session-6' })).owner_answer_count, 0);
    committed(await native('clued_owner_auto_approve_off_v1', {}));

    // --- Answers older than 7 days are no longer shown. ---
    const late = await ask({ action: 'release.production', resources: [sha('i')], session_ref: 'session-7' });
    await reject(late.request_id);
    assert.equal((await summary('claude', { session_ref: 'session-7' })).owner_answer_count, 1);
    await admin.query(`update clued_private.owner_requests_v1 set decided_at=now()-interval '8 days' where id=$1`,
      [late.request_id]);
    assert.equal((await summary('claude', { session_ref: 'session-7' })).owner_answer_count, 0);

    // --- The helpers are private. ---
    await assert.rejects(() => anon.query(
      'select clued_private.owner_answers_take_v1($1,$2,null,5,true)', [userId, bindingIds.claude]), /permission denied/);
    await assert.rejects(() => human.query(
      'select clued_private.owner_answer_count_v1($1,$2,null)', [userId, bindingIds.claude]), /permission denied/);
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
    await removeTestDirectory(directory).catch(() => {});
  }
});
