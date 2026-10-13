import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
// Re-review 7, MAJOR-3: the admission door's case runs with this file, which
// the authorization database job already lists.
import './owner-grants-admission-door-db.case.mjs';
import { allowRawTestBindings } from './raw-binding-grants-fixture.mjs';
import { enableManualOwnerApprovalFixture } from './manual-owner-approval-fixture.mjs';
import { CI_SIGNATURES, CLOSEOUT_MIGRATION, assertGatewayCloseoutBoundary, snapshotCallerCatalog, setWorkerGatewayCaller, workerGatewayRpc } from './worker-gateway-caller-fixture.mjs';

// Owner Credential v0.1, rollout step 4 (migration 20261003170000_owner_grants_release_door;
// OwnerCredential.v0.1.md §6.1): the production release workflow consumes an
// Owner Grant with its own Binding. It matches by action and resources only
// (Owner choice), and when nothing admits it opens or reuses a pending request
// whose link the run prints.

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

test('owner grants: the release door consumes by action and commit and opens a request otherwise',
  { timeout: 300000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-owner-grants-door-'));
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
    await enableManualOwnerApprovalFixture(admin);

    const userId = uuid();
    const otherUser = uuid();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at)
      values($1,'owner-grants@example.invalid',now()),($2,'owner-grants-other@example.invalid',now())`, [userId, otherUser]);
    const tokens = {};
    const bindingIds = {};
    for (const [name, user, scopes] of [
      ['claude', userId, ['context:read', 'context:write']], ['codex', userId, ['context:read', 'context:write']],
      ['reader', userId, ['context:read']], ['stranger', otherUser, ['context:read', 'context:write']],
      ['release', userId, ['context:read', 'context:write']],
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
    // Worker transport is distinct from anonymous CI doors and permission-denial probes.
    const workerCaller=server.getPgClient();clients.push(workerCaller);await workerCaller.connect();
    await setWorkerGatewayCaller(workerCaller);
    const human = server.getPgClient();
    clients.push(human);
    await human.connect();
    await human.query('set role authenticated');
    const agent = async (who, name, input) => CI_SIGNATURES.includes(name+'(text,jsonb)')
      ? (await anon.query(`select public.${name}($1,$2) v`, [tokens[who], input])).rows[0].v
      : workerGatewayRpc(workerCaller,name,tokens[who],input);
    const native = async (name, input, claims = session(userId)) => {
      await human.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
        [claims.sub ?? '', JSON.stringify(claims)]);
      return (await human.query(`select public.${name}($1) v`, [input])).rows[0].v;
    };
    const committed = (result) => { assert.equal(result.status, 'committed', JSON.stringify(result)); return result; };
    const consume = async (binding, action, resources, taskId = null) => (await admin.query(
      'select clued_private.owner_grant_consume_v1($1,$2,$3,$4,$5) v',
      [userId, binding, action, resources, taskId])).rows[0].v;
    const confirm = async (input, claims) => {
      const issued = await native('clued_owner_grant_confirmation_issue_v1', input, claims);
      assert.equal(issued.status, 'issued', JSON.stringify(issued));
      return issued;
    };
    const grant = (issued, claims, digest = issued.view_digest) =>
      native('clued_owner_grant_v1', { confirmation_token: issued.confirmation_token, view_digest: digest }, claims);

    const door = (who, input) => agent(who, 'clued_owner_grant_door_consume_v1', input);
    const commitA = 'repo:tdoljyj/cross-memory-system/4f49b0e8aaaa';
    const commitB = 'repo:tdoljyj/cross-memory-system/b0b0b0b0bbbb';

    // --- Claude asks, the Owner grants to Claude; the release Binding consumes it. ---
    const asked = committed(await agent('claude', 'clued_owner_request_v1',
      { action: 'release.production', resources: [commitA], idempotency_key: 'door-release-a' }));
    const given = committed(await grant(await confirm({ request_id: asked.request.request_id })));
    assert.equal(given.grant.any_agent, false, 'granted to the requesting Agent only');
    let result = await door('release', { action: 'release.production', resources: [commitA] });
    assert.deepEqual([result.status, result.consumed, result.grant.grant_id], ['ok', true, given.grant.grant_id]);
    const used = (await admin.query(`select metadata from public.clued_audit_receipts where id=$1`,
      [result.grant.receipt_id])).rows[0].metadata;
    assert.deepEqual([used.receipt_kind, used.door, used.action], ['OWNER_GRANT_USED', 'release-workflow', 'release.production']);
    // The same grant does not cover another commit or another action.
    result = await door('release', { action: 'migration.production', resources: [commitA] });
    assert.equal(result.consumed, false);

    // --- No grant: the door opens one pending request and reuses it. ---
    result = await door('release', { action: 'release.production', resources: [commitB] });
    assert.equal(result.consumed, false);
    const pending = result.owner_request;
    assert.deepEqual([pending.status, pending.action, pending.resources, pending.confirm_path],
      ['pending', 'release.production', [commitB], `/confirm/${pending.request_id}`]);
    const again = await door('release', { action: 'release.production', resources: [commitB] });
    assert.equal(again.owner_request.request_id, pending.request_id, 'one request per action and resources');
    assert.equal((await admin.query(`select count(*)::int n from clued_private.owner_requests_v1 where binding_id=$1`,
      [bindingIds.release])).rows[0].n, 2, 'commitB release plus commitA migration');
    // The Owner approves that request once: one run goes through, the next does not.
    committed(await grant(await confirm({ request_id: pending.request_id, choice: 'once' })));
    result = await door('release', { action: 'release.production', resources: [commitB] });
    assert.equal(result.consumed, true);
    result = await door('release', { action: 'release.production', resources: [commitB] });
    assert.equal(result.consumed, false);
    assert.notEqual(result.owner_request.request_id, pending.request_id, 'a decided request is not reused');

    // --- A grant for the repository glob covers any commit; a revoked grant covers nothing. ---
    const wide = committed(await grant(await confirm({ action: 'migration.production',
      resources: ['repo:tdoljyj/cross-memory-system/**'] })));
    result = await door('release', { action: 'migration.production', resources: [commitB] });
    assert.deepEqual([result.consumed, result.grant.grant_id], [true, wide.grant.grant_id]);
    committed(await native('clued_owner_grant_revoke_v1', { grant_id: wide.grant.grant_id }));
    assert.equal((await door('release', { action: 'migration.production', resources: [commitB] })).consumed, false);

    // --- Another user's grant never admits; refusals. ---
    assert.equal((await door('stranger', { action: 'release.production', resources: [commitA] })).consumed, false);
    await assert.rejects(() => door('reader', { action: 'release.production', resources: [commitA] }));
    await assert.rejects(() => door('release', { action: 'work_claim.extra_claims', resources: ['record:x'] }),
      /owner_grant_door_action_invalid/);
    await assert.rejects(() => door('release', { action: 'merge.main', resources: [commitA] }),
      /owner_grant_door_action_invalid/);
    await assert.rejects(() => door('release', { action: 'release.production', resources: [] }),
      /owner_grant_door_resources_invalid/);
    await assert.rejects(() => door('release', { action: 'release.production', resources: [commitA], task_id: uuid() }),
      /owner_grant_door_input_invalid/);
    await assert.rejects(() => anon.query('select clued_private.owner_grant_consume_door_v1($1,$2,$3,$4)',
      [userId, bindingIds.release, 'release.production', [commitA]]), /permission denied/);
    await assert.rejects(() => human.query('select public.clued_owner_grant_door_consume_v1($1,$2)',
      [tokens.release, { action: 'release.production', resources: [commitA] }]), /permission denied/);
    // The entire current chain was applied above; reapply the real closeout and compare catalog metadata.
    await assertGatewayCloseoutBoundary(admin);
    const closedCatalog=await snapshotCallerCatalog(admin);
    await admin.query(await fs.readFile(path.join(root,'supabase/migrations',CLOSEOUT_MIGRATION),'utf8'));
    await assertGatewayCloseoutBoundary(admin);
    assert.deepEqual(await snapshotCallerCatalog(admin),closedCatalog,'actual G6 replay preserves definitions and ACL');
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await server.stop().catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  }
});
