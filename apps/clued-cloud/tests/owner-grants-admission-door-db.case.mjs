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

// Re-review 7, MAJOR-3 (migration 20261005120000_owner_grants_admission_door;
// OwnerCredential.v0.1.md §6.3): the admission check asks for an Owner Grant
// of repo.protected_change on the head commit before it admits a pull request
// that changes protected paths. Only the ci-admission Binding asks; a grant is
// used once per commit and later runs of that commit replay the use.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const nowEpoch = () => Math.floor(Date.now() / 1000);
// An old sign-in on purpose: grants do not require a recent login (Decision 667f588b).
const session = (sub, sessionId = 'sess-main', extra = {}) =>
  ({ sub, role: 'authenticated', session_id: sessionId, aal: 'aal1',
    amr: [{ method: 'password', timestamp: nowEpoch() - 3 * 86400 }], ...extra });

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('owner grants: the admission door admits a protected commit once per grant and opens a request otherwise',
  { timeout: 300000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-owner-grants-admission-door-'));
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
      values($1,'owner-grants@example.invalid',now()),($2,'owner-grants-other@example.invalid',now())`, [userId, otherUser]);
    const tokens = {};
    const bindingIds = {};
    for (const [name, user, scopes] of [
      ['claude', userId, ['context:read', 'context:write']], ['codex', userId, ['context:read', 'context:write']],
      ['reader', userId, ['context:read']], ['stranger', otherUser, ['context:read', 'context:write']],
      ['admission', userId, ['context:read']], ['release', userId, ['context:read', 'context:write']],
    ]) {
      tokens[name] = hash();
      bindingIds[name] = (await admin.query(`insert into public.clued_agent_bindings
        (user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic',$2,$3,$4,array['*']) returning id`, [user, name, tokens[name], scopes])).rows[0].id;
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
    const native = async (name, input, claims = session(userId)) => {
      await human.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
        [claims.sub ?? '', JSON.stringify(claims)]);
      return (await human.query(`select public.${name}($1) v`, [input])).rows[0].v;
    };
    const committed = (result) => { assert.equal(result.status, 'committed', JSON.stringify(result)); return result; };
    const confirm = async (input, claims) => {
      const issued = await native('clued_owner_grant_confirmation_issue_v1', input, claims);
      assert.equal(issued.status, 'issued', JSON.stringify(issued));
      return issued;
    };
    const grant = (issued, claims, digest = issued.view_digest) =>
      native('clued_owner_grant_v1', { confirmation_token: issued.confirmation_token, view_digest: digest }, claims);

    const door = (who, input) => agent(who, 'clued_owner_grant_admission_door_v1', input);
    const action = 'repo.protected_change';
    const commitA = 'repo:tdoljyj/cross-memory-system/4f49b0e8aaaa';
    const commitB = 'repo:tdoljyj/cross-memory-system/b0b0b0b0bbbb';
    const uses = async (grantId) => (await admin.query('select uses from clued_private.owner_grants_v1 where id=$1', [grantId])).rows[0].uses;

    // --- Re-review 10, MAJOR-3: until the Owner marks the ci-admission role,
    // nobody can use the door (so nobody can write a note shown as the check's).
    await assert.rejects(() => door('admission', { action, resources: [commitA] }), /owner_grant_door_binding_not_authorized/);
    const receipt = (await admin.query(`insert into public.clued_audit_receipts
      (user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
      values($1,$2,'global','binding_role_set','binding_role','ci-admission',1,'{}'::jsonb) returning id`,
      [userId, bindingIds.admission])).rows[0].id;
    await admin.query(`insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id)
      values($1,$2,'ci-admission',now(),$3)`, [userId, bindingIds.admission, receipt]);
    await assert.rejects(() => door('claude', { action, resources: [commitA] }), /owner_grant_door_binding_not_authorized/);
    await assert.rejects(() => door('stranger', { action, resources: [commitA] }), /owner_grant_door_binding_not_authorized/);
    // Another user's door, once that user marks their own Binding, never sees this Owner's grants or requests.
    const strangerReceipt = (await admin.query(`insert into public.clued_audit_receipts
      (user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
      values($1,$2,'global','binding_role_set','binding_role','ci-admission',1,'{}'::jsonb) returning id`,
      [otherUser, bindingIds.stranger])).rows[0].id;
    await admin.query(`insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id)
      values($1,$2,'ci-admission',now(),$3)`, [otherUser, bindingIds.stranger, strangerReceipt]);

    // --- No grant: one pending request, reused, with the admission origin and
    // the check's note for the Owner. ---
    let result = await door('admission', { action, resources: [commitA], note: 'o/r#559 @ 4f49b0e8aaaa: .github/workflows/x.yml' });
    assert.deepEqual([result.status, result.admitted], ['ok', false]);
    const pending = result.owner_request;
    assert.deepEqual([pending.status, pending.action, pending.resources, pending.confirm_path],
      ['pending', action, [commitA], `/confirm/${pending.request_id}`]);
    assert.equal((await door('admission', { action, resources: [commitA] })).owner_request.request_id, pending.request_id);
    const origin = (await admin.query(`select r.metadata from public.clued_audit_receipts r
      join clued_private.owner_requests_v1 q on q.receipt_id=r.id where q.id=$1`, [pending.request_id])).rows[0].metadata;
    assert.equal(origin.origin, 'ci-admission');
    assert.equal((await admin.query('select agent_note from clued_private.owner_requests_v1 where id=$1', [pending.request_id])).rows[0].agent_note,
      'o/r#559 @ 4f49b0e8aaaa: .github/workflows/x.yml');

    // --- Re-review 9: the confirmation view marks the door's note as the
    // admission check's and offers no wider scope for this action. ---
    let viewed = await native('clued_owner_request_view_v1', { request_id: pending.request_id });
    assert.equal(viewed.view.request.note_source, 'ci-admission');
    assert.deepEqual(viewed.resource_options, [{ resource: commitA, options: [commitA] }]);
    // Re-review 10, MINOR-2: an Agent cannot open this request itself, alone
    // or in a bundle; another action's note stays the Agent's.
    await assert.rejects(() => agent('claude', 'clued_owner_request_v1',
      { action, resources: [commitB], agent_note: 'admission-door: trust me', idempotency_key: 'agent-protected-b' }), /owner_request_action_door_only/);
    await assert.rejects(() => agent('claude', 'clued_owner_request_bundle_v1', { idempotency_key: 'agent-protected-bundle',
      actions: [{ action, resources: [commitB] }, { action: 'release.production', resources: [commitB] }] }), /owner_request_bundle_invalid/);
    const other = committed(await agent('claude', 'clued_owner_request_v1',
      { action: 'release.production', resources: [commitB], agent_note: 'from the admission check', idempotency_key: 'agent-release-b' }));
    viewed = await native('clued_owner_request_view_v1', { request_id: other.request.request_id });
    assert.equal(viewed.view.request.note_source, 'agent');
    committed(await native('clued_owner_request_reject_v1', { request_id: other.request.request_id }));
    // Re-review 10, NIT: the confirmation step takes only the request's own commit.
    assert.equal((await native('clued_owner_grant_confirmation_issue_v1',
      { request_id: pending.request_id, choice: 'grant', resources: ['repo:tdoljyj/cross-memory-system/**'] })).error_code,
      'owner_grant_resources_not_offered');

    // --- The Owner approves once: that commit is admitted, and stays admitted
    // on later runs without taking another use; another commit is not. ---
    const once = committed(await grant(await confirm({ request_id: pending.request_id, choice: 'once' })));
    result = await door('admission', { action, resources: [commitA] });
    assert.deepEqual([result.admitted, result.grant.grant_id, result.grant.replayed], [true, once.grant.grant_id, false]);
    const firstUse = result.grant.receipt_id;
    const used = (await admin.query('select metadata from public.clued_audit_receipts where id=$1', [firstUse])).rows[0].metadata;
    assert.deepEqual([used.receipt_kind, used.door, used.action], ['OWNER_GRANT_USED', 'ci-admission', action]);
    for (let i = 0; i < 3; i += 1) {
      result = await door('admission', { action, resources: [commitA] });
      assert.deepEqual([result.admitted, result.grant.replayed, result.grant.receipt_id], [true, true, firstUse]);
    }
    assert.equal(await uses(once.grant.grant_id), 1, 'replays take no use');
    assert.equal((await door('admission', { action, resources: [commitB] })).admitted, false, 'a used once grant admits no other commit');

    // --- Re-review 8, MINOR-3: a grant for the repository glob admits no
    // commit; only a grant that names the commit does. ---
    committed(await grant(await confirm({ action, resources: ['repo:tdoljyj/cross-memory-system/**'] })));
    assert.equal((await door('admission', { action, resources: [commitB] })).admitted, false);
    const exactB = committed(await grant(await confirm({ action, resources: [commitB] })));
    result = await door('admission', { action, resources: [commitB] });
    assert.deepEqual([result.admitted, result.grant.grant_id], [true, exactB.grant.grant_id]);
    // A used grant keeps admitting its commit after its time runs out, until revoked.
    await admin.query(`update clued_private.owner_grants_v1 set granted_at=now()-interval '2 days',
      expires_at=now()-interval '1 day' where id=$1`, [once.grant.grant_id]);
    assert.deepEqual([(await door('admission', { action, resources: [commitA] })).admitted], [true]);
    committed(await native('clued_owner_grant_revoke_v1', { grant_id: exactB.grant.grant_id }));
    assert.equal((await door('admission', { action, resources: [commitB] })).admitted, false);
    assert.equal((await door('stranger', { action, resources: [commitA] })).admitted, false, "another user's door never uses this Owner's grant");
    committed(await native('clued_owner_grant_revoke_v1', { grant_id: once.grant.grant_id }));
    assert.equal((await door('admission', { action, resources: [commitA] })).admitted, false);
    await assert.rejects(() => door('admission', { action, resources: ['repo:tdoljyj/cross-memory-system/*'] }),
      /owner_grant_door_resources_invalid/);
    await assert.rejects(() => door('admission', { action, resources: [commitA], note: 5 }), /owner_grant_door_input_invalid/);

    // --- The release actions are not this door's, nor this action the release door's. ---
    await assert.rejects(() => door('admission', { action: 'release.production', resources: [commitA] }),
      /owner_grant_door_action_invalid/);
    await assert.rejects(() => agent('release', 'clued_owner_grant_door_consume_v1', { action, resources: [commitA] }),
      /owner_grant_door_action_invalid/);
    await assert.rejects(() => door('admission', { action, resources: [] }), /owner_grant_door_resources_invalid/);
    await assert.rejects(() => door('admission', { action, resources: [commitA], task_id: uuid() }), /owner_grant_door_input_invalid/);

    await assert.rejects(() => anon.query('select clued_private.owner_grant_admission_use_v1($1,$2,$3,$4)',
      [userId, bindingIds.admission, action, [commitA]]), /permission denied/);
    await assert.rejects(() => human.query('select public.clued_owner_grant_admission_door_v1($1,$2)',
      [tokens.admission, { action, resources: [commitA] }]), /permission denied/);
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await server.stop().catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  }
});
