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
import { setWorkerGatewayCaller, workerGatewayRpc } from './worker-gateway-caller-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const successor = '20261013023000_owner_auto_approve_persistent_switch.sql';
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const session = (sub) => ({ sub, role: 'authenticated', session_id: 'native-upgrade-test',
  amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }] });
const committed = (v) => { assert.equal(v.status, 'committed', JSON.stringify(v)); return v; };

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('persistent auto-approval upgrades installed timed state without rewriting its audit/grants; concurrent Off wins before a new grant',
  { timeout: 300000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-owner-auto-persistent-'));
  const server = new EmbeddedPostgres({ databaseDir: directory, user: 'postgres', password: hash(),
    port: await freePort(), persistent: false, initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS],
    onLog() {}, onError(message) { process.stderr.write(`${message}\n`); } });
  const clients = [];
  try {
    await server.initialise(); await server.start();
    const connect = async (role) => {
      const c = server.getPgClient(); clients.push(c); await c.connect();
      if (role) await c.query(`set role ${role}`);
      return c;
    };
    const admin = await connect();
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
    const names = (await fs.readdir(path.join(root, 'supabase/migrations'))).filter((n) => n.endsWith('.sql')).sort();
    for (const name of names.filter((n) => n < successor)) {
      try { await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    }
    await allowRawTestBindings(admin);
    const human = await connect('authenticated');
    const human2 = await connect('authenticated');
    const anon = await connect('anon');
    const agent = await connect();
    await setWorkerGatewayCaller(agent);
    const native = async (owner, name, input, client = human) => {
      await client.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
        [owner, JSON.stringify(session(owner))]);
      return (await client.query(`select public.${name}($1) v`, [input])).rows[0].v;
    };
    const oldOn = async (owner, seconds = 86400) => {
      const issued = await native(owner, 'clued_owner_auto_approve_confirmation_issue_v1', { expires_seconds: seconds });
      assert.equal(issued.status, 'issued');
      return committed(await native(owner, 'clued_owner_auto_approve_on_v1',
        { confirmation_token: issued.confirmation_token, view_digest: issued.view_digest }));
    };
    const owners = Object.fromEntries(['timed', 'expired', 'off', 'reopened', 'default', 'newOff', 'bindingDenied'].map((n) => [n, uuid()]));
    const bindings = {};
    for (const [name, id] of Object.entries(owners)) {
      await admin.query(`insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())`,
        [id, `${name}@example.invalid`]);
      const token = hash();
      const binding = (await admin.query(`insert into public.clued_agent_bindings
        (user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic',$2,$3,array['context:read','context:write'],array['*']) returning id`,
        [id, name, token])).rows[0].id;
      bindings[name] = { token, id: binding };
    }
    const ask = (name, suffix = uuid()) => workerGatewayRpc(agent, 'clued_owner_request_v1',
      bindings[name].token, { idempotency_key: uuid(), action: 'release.production',
        resources: [`repo:test/owner-auto/${suffix}`] });
    const timed = await oldOn(owners.timed, 3600);
    const oldGrant = committed(await ask('timed', 'legacy')).request.grant;
    const expired = await oldOn(owners.expired, 60);
    await admin.query(`update clued_private.owner_auto_approve_v1
      set turned_on_at=clock_timestamp()-interval '1 hour',expires_at=clock_timestamp()-interval '1 minute' where id=$1`,
      [expired.auto_approve.switch_id]);
    await oldOn(owners.off);
    await native(owners.off, 'clued_owner_auto_approve_off_v1', {});
    await oldOn(owners.reopened);
    await native(owners.reopened, 'clued_owner_auto_approve_off_v1', {});
    await oldOn(owners.reopened, 600);
    const pendingOldToken = await native(owners.off, 'clued_owner_auto_approve_confirmation_issue_v1', { expires_seconds: 60 });
    const historical = (await admin.query(`select id,user_id,turned_on_at,expires_at,turned_off_at,token_id,
      receipt_id,off_receipt_id,session_id from clued_private.owner_auto_approve_v1 order by id`)).rows;
    const oldGrantRow = (await admin.query(`select * from clued_private.owner_grants_v1 where id=$1`, [oldGrant.grant_id])).rows[0];
    await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', successor), 'utf8'));
    for (const name of names.filter((n) => n > successor)) await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8'));
    assert.deepEqual((await admin.query(`select
      has_function_privilege('authenticated','public.clued_owner_auto_approve_set_v1(jsonb)','EXECUTE') native,
      has_function_privilege('clued_worker_gateway','public.clued_owner_auto_approve_set_v1(jsonb)','EXECUTE') worker,
      has_function_privilege('anon','public.clued_owner_auto_approve_set_v1(jsonb)','EXECUTE') anon,
      has_function_privilege('service_role','public.clued_owner_auto_approve_set_v1(jsonb)','EXECUTE') service`)).rows[0],
      { native: true, worker: false, anon: false, service: false }, 'only the Native transport can execute the setter');

    assert.deepEqual((await admin.query(`select id,user_id,turned_on_at,expires_at,turned_off_at,token_id,
      receipt_id,off_receipt_id,session_id from clued_private.owner_auto_approve_v1
      where id=any($1::uuid[]) order by id`, [historical.map((r) => r.id)])).rows, historical);
    assert.deepEqual((await admin.query(`select * from clued_private.owner_grants_v1 where id=$1`, [oldGrant.grant_id])).rows[0], oldGrantRow);
    assert.equal(oldGrantRow.auto_approve_id, timed.auto_approve.switch_id, 'old grant retains its original FK and expiry');
    for (const name of ['timed', 'expired', 'reopened', 'default']) {
      const list = await native(owners[name], 'clued_owner_grants_list_v1', {});
      assert.deepEqual([list.auto_approve.on, list.auto_approve.persistent, list.auto_approve.expires_at], [true, true, null]);
      assert.equal(list.auto_approve.version, name === 'default' ? 0 : 1);
      assert.equal(committed(await ask(name)).request.status, 'approved_once');
    }
    const off = await native(owners.off, 'clued_owner_grants_list_v1', {});
    assert.deepEqual([off.auto_approve.on, off.auto_approve.version], [false, 1]);
    assert.equal(committed(await ask('off')).request.status, 'pending', 'latest manual Off is preserved');
    assert.equal((await native(owners.off, 'clued_owner_auto_approve_on_v1', {
      confirmation_token: pendingOldToken.confirmation_token, view_digest: pendingOldToken.view_digest,
    })).error_code, 'owner_auto_approve_successor_required');
    assert.equal((await native(owners.off, 'clued_owner_grants_list_v1', {})).auto_approve.on, false,
      'a previously displayed duration cannot undo explicit Off');
    assert.equal((await admin.query(`select consumed_at from clued_private.native_confirmation_tokens where id=$1`,
      [pendingOldToken.token_id])).rows[0].consumed_at, null, 'retired endpoint does not rewrite token history');

    // A Binding lacks Native privileges even if it fabricates a sub claim.
    await anon.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
      [owners.bindingDenied, JSON.stringify(session(owners.bindingDenied))]);
    await assert.rejects(() => anon.query('select public.clued_owner_auto_approve_set_v1($1)',
      [{ enabled: false, base_version: 0 }]), /permission denied/);
    assert.equal((await native(owners.bindingDenied, 'clued_owner_grants_list_v1', {})).auto_approve.on, true);

    const pid = async (c) => (await c.query('select pg_backend_pid() pid')).rows[0].pid;
    const agentPid = await pid(agent); const humanPid = await pid(human); const human2Pid = await pid(human2);
    const blockedBy = async (waiter, blocker) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if ((await admin.query('select $2::int=any(pg_blocking_pids($1)) blocked', [waiter, blocker])).rows[0].blocked) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail(`backend ${waiter} never waited for owner lock held by ${blocker}`);
    };

    // Off before the first default grant, in two actual PostgreSQL sessions.
    await human.query('begin');
    const newOff = committed(await native(owners.newOff, 'clued_owner_auto_approve_set_v1', { enabled: false, base_version: 0 }));
    const waitingRequest = ask('newOff');
    await blockedBy(agentPid, humanPid);
    await human.query('commit');
    assert.equal(committed(await waitingRequest).request.status, 'pending');
    assert.equal(newOff.auto_approve.version, 1);
    assert.equal((await admin.query(`select count(*)::int n from public.clued_audit_receipts
      where user_id=$1 and operation='owner_auto_approve_default'`, [owners.newOff])).rows[0].n, 0,
      'an automatic default cannot race past Off');

    // The second concurrent page does not overwrite a changed CAS version.
    await human.query('begin');
    const reopened = committed(await native(owners.newOff, 'clued_owner_auto_approve_set_v1', { enabled: true, base_version: 1 }));
    const waitingSetter = native(owners.newOff, 'clued_owner_auto_approve_set_v1', { enabled: false, base_version: 1 }, human2);
    await blockedBy(human2Pid, humanPid); await human.query('commit');
    const conflict = await waitingSetter;
    assert.equal(conflict.error_code, 'owner_auto_approve_version_conflict');
    assert.equal(conflict.auto_approve.version, 2);
    assert.equal(reopened.auto_approve.on, true);

    // If approval acquired the lock first, Off waits and preserves that grant.
    await agent.query('begin');
    const beforeOff = committed(await ask('newOff')).request.grant;
    const waitingOff = native(owners.newOff, 'clued_owner_auto_approve_set_v1', { enabled: false, base_version: 2 });
    await blockedBy(humanPid, agentPid); await agent.query('commit');
    assert.equal(committed(await waitingOff).auto_approve.on, false);
    assert.equal((await admin.query(`select revoked_at from clued_private.owner_grants_v1 where id=$1`,
      [beforeOff.grant_id])).rows[0].revoked_at, null, 'Off stops new approval without revoking issued grants');
    assert.equal(committed(await ask('newOff')).request.status, 'pending');
  } finally {
    // Release holder transactions concurrently with any waiter whose query is
    // still queued, so a failing lock assertion cannot deadlock test cleanup.
    await Promise.allSettled(clients.map((c) => c.query('rollback')));
    for (const c of clients.reverse()) await c.end().catch(() => {});
    await stopCluster(server); await removeTestDirectory(directory);
  }
});
