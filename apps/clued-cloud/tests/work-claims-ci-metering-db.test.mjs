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
import { CI_SIGNATURES, setWorkerGatewayCaller, workerGatewayRpc, assertGatewayCloseoutBoundary } from './worker-gateway-caller-fixture.mjs';

// GitHub CI metered per Task (migration 20261003180000, GenericWorkClaim
// §10.4, Task bb9f1e36): verify with pr_ref and head_sha admits at most 40
// distinct heads per Task in any 24 hours, across all of the Task's claims and
// race copies; a head verified again is not counted again.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const nowEpoch = () => Math.floor(Date.now() / 1000);
const fresh = (sub, session = 'sess-main') =>
  ({ sub, role: 'authenticated', session_id: session, aal: 'aal1', amr: [{ method: 'password', timestamp: nowEpoch() }] });

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('work claims: GitHub CI heads metered per Task in a sliding 24-hour window',
  { timeout: 300000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-work-claims-ci-metering-'));
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
      values($1,'ci@example.invalid',now()),($2,'ci-other@example.invalid',now())`, [userId, otherUser]);
    const tokens = {};
    const bindingIds = {};
    for (const name of ['claude', 'codex', 'reader']) {
      tokens[name] = hash();
      bindingIds[name] = (await admin.query(`insert into public.clued_agent_bindings
        (user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic',$2,$3,$4,array['*']) returning id`,
        [userId, name, tokens[name], name === 'reader' ? ['context:read'] : ['context:read', 'context:write']])).rows[0].id;
    }
    const anon = server.getPgClient();
    clients.push(anon);
    await anon.connect();
    await anon.query('set role anon');
    const workerCaller = server.getPgClient();
    clients.push(workerCaller);
    await workerCaller.connect();
    await setWorkerGatewayCaller(workerCaller);
    const human = server.getPgClient();
    clients.push(human);
    await human.connect();
    await human.query('set role authenticated');
    const agent = async (who, name, input) =>
      CI_SIGNATURES.includes(name + '(text,jsonb)')
        ? (await anon.query(`select public.${name}($1,$2) v`, [tokens[who],input])).rows[0].v
        : await workerGatewayRpc(workerCaller, name, tokens[who], input);
    const native = async (name, input, claims = fresh(userId)) => {
      await human.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
        [claims.sub ?? '', JSON.stringify(claims)]);
      return (await human.query(`select public.${name}($1) v`, [input])).rows[0].v;
    };
    const committed = (result) => { assert.equal(result.status, 'committed', JSON.stringify(result)); return result; };
    const createTask = async (title) => committed(await agent('claude', 'clued_record_mutate', {
      operation: 'create', record_type: 'task', record_schema_version: 1, lifecycle_status: 'active',
      scope: 'global', idempotency_key: uuid(), authority: 'observed',
      confidence_reason: 'race fixture', source_refs: [], source_unavailable_reason: 'fixture',
      mutation: { title, content: 'fixture', type_fields: { execution_bucket: 'next' }, relations: {} },
    })).target_refs[0].id;
    const claim = (taskId, who = 'claude', session = 'session-a', writeSet = ['storage:c1/**']) =>
      agent(who, 'clued_work_claim_v1', { scope: 'global', idempotency_key: uuid(), task_id: taskId,
        write_set: writeSet, holder_session_ref: session });
    const release = (who, c) => agent(who, 'clued_work_release_v1',
      { scope: 'global', claim_id: c.claim_id, fence: c.fence, outcome: 'completed' });
    const verify = (c, pr, head = crypto.randomBytes(20).toString('hex')) => agent('reader', 'clued_work_verify_v1',
      { scope: 'global', claim_id: c.claim_id, pr_ref: pr, head_sha: head });
    const gate = async (who, c, resources) => (await admin.query(
      `select clued_private.work_claim_gate_v1($1,$2,'clued-storage','storage_submit','collision_only',$3,$4) v`,
      [userId, bindingIds[who], resources, c ? { claim_id: c.claim_id, fence: c.fence } : null])).rows[0].v;
    const enable = async (input, claims) => {
      const issued = await native('clued_work_claim_multi_confirmation_issue_v1', input, claims);
      assert.equal(issued.status, 'issued', JSON.stringify(issued));
      return { issued, enabled: await native('clued_work_claim_multi_enable_v1',
        { confirmation_token: issued.confirmation_token, view_digest: issued.view_digest }, claims) };
    };
    const row = async (claimId) => (await admin.query(
      'select status,outcome,copy_index,superseded_by from clued_private.work_claims_v1 where claim_id=$1', [claimId])).rows[0];
    const shared = ['storage:c1/final/**'];

    const sha = (i) => i.toString(16).padStart(40, '0');
    const usage = async (taskId) => Number((await admin.query(`select count(*) n from clued_private.work_claim_door_usage_v1
      where user_id=$1 and door='github-ci' and task_id=$2`, [userId, taskId])).rows[0].n);

    // --- Profile: the per-claim cap is gone, the per-Task meter is 40. ---
    const profile = (await admin.query('select clued_private.work_claim_profile_v1() p')).rows[0].p;
    assert.deepEqual([profile.max_heads_per_claim, profile.github_ci_heads_per_task_24h], [undefined, 40]);
    await assert.rejects(() => anon.query('select * from clued_private.work_claim_door_usage_v1'), /permission denied/);
    await assert.rejects(() => human.query('select * from clued_private.work_claim_door_usage_v1'), /permission denied/);

    // --- One Task, 40 heads in 24 hours; the 41st is refused with the time
    // the oldest head leaves the window. ---
    const task = await createTask('ci meter');
    const first = committed(await claim(task, 'claude', 'session-a')).claim;
    let v;
    for (let i = 1; i <= 40; i += 1) {
      v = await verify(first, 'o/r#1', sha(i));
      assert.deepEqual([v.verdict, v.task_ci_heads_24h, v.task_ci_head_cap, v.admitted_heads, v.ci_retry_after],
        ['ADMITTED', i, 40, i, null], JSON.stringify(v));
    }
    const oldest = (await admin.query(`select min(used_at) t from clued_private.work_claim_door_usage_v1
      where user_id=$1 and task_id=$2`, [userId, task])).rows[0].t;
    v = await verify(first, 'o/r#1', sha(41));
    assert.deepEqual([v.verdict, v.reasons, v.task_ci_heads_24h, v.admitted_heads],
      ['REJECTED', ['task_ci_head_cap_reached'], 40, 40]);
    assert.equal(new Date(v.ci_retry_after).getTime(), oldest.getTime() + 24 * 3600 * 1000);
    assert.equal(await usage(task), 40, 'a refused head is not recorded');
    // A head already counted (a re-run, the hourly re-verify) is still admitted.
    v = await verify(first, 'o/r#1', sha(7).toUpperCase());
    assert.deepEqual([v.verdict, v.task_ci_heads_24h], ['ADMITTED', 40]);
    // Without pr_ref (a hand dispatch, an Agent's own check) nothing is metered.
    v = await agent('reader', 'clued_work_verify_v1', { scope: 'global', claim_id: first.claim_id, head_sha: sha(99) });
    assert.deepEqual([v.verdict, v.task_ci_heads_24h], ['ADMITTED', 40]);

    // --- Another claim of the same Task does not buy more CI. ---
    committed(await release('claude', first));
    const second = committed(await claim(task, 'claude', 'session-b')).claim;
    v = await verify(second, 'o/r#2', sha(42));
    assert.deepEqual([v.verdict, v.reasons, v.admitted_heads], ['REJECTED', ['task_ci_head_cap_reached'], 0]);

    // --- The window slides: once the oldest head is 24 hours old, a new head
    // takes its place. ---
    await admin.query(`update clued_private.work_claim_door_usage_v1 set used_at=used_at-interval '24 hours 1 second'
      where user_id=$1 and task_id=$2 and unit_key=$3`, [userId, task, sha(1)]);
    v = await verify(second, 'o/r#2', sha(42));
    assert.deepEqual([v.verdict, v.task_ci_heads_24h, v.admitted_heads], ['ADMITTED', 40, 1]);
    // The aged head verified again is not counted again either.
    v = await verify(second, 'o/r#2', sha(1));
    assert.deepEqual([v.verdict, v.task_ci_heads_24h], ['ADMITTED', 40]);
    v = await verify(second, 'o/r#2', sha(43));
    assert.deepEqual([v.verdict, v.reasons], ['REJECTED', ['task_ci_head_cap_reached']]);
    committed(await release('claude', second));

    // --- Other Tasks have their own meter; a failing verify takes nothing. ---
    const other = await createTask('ci meter other');
    const otherClaim = committed(await claim(other, 'codex', 'session-c', ['storage:c2/**'])).claim;
    v = await agent('reader', 'clued_work_verify_v1', { scope: 'global', claim_id: otherClaim.claim_id,
      pr_ref: 'o/r#3', head_sha: sha(1), changed_paths: ['elsewhere/a'] });
    assert.deepEqual([v.verdict, v.reasons, v.task_ci_heads_24h], ['REJECTED', ['paths_outside_write_set'], 0]);
    v = await verify(otherClaim, 'o/r#3', sha(1));
    assert.deepEqual([v.verdict, v.task_ci_heads_24h], ['ADMITTED', 1]);
    committed(await release('codex', otherClaim));

    // --- Race copies share their Task's meter. ---
    const raceTask = await createTask('ci meter race');
    assert.equal((await enable({ task_id: raceTask, copies: 2, shared_resources: ['storage:c3/final/**'] })).enabled.status,
      'committed');
    const copyA = committed(await claim(raceTask, 'claude', 'session-d', ['storage:c3/**'])).claim;
    const copyB = committed(await claim(raceTask, 'codex', 'session-e', ['storage:c3/**'])).claim;
    assert.deepEqual([copyA.copy_index, copyB.copy_index], [1, 2]);
    v = await verify(copyA, 'o/r#4', sha(1));
    assert.deepEqual([v.verdict, v.task_ci_heads_24h], ['ADMITTED', 1]);
    v = await verify(copyB, 'o/r#5', sha(2));
    assert.deepEqual([v.verdict, v.task_ci_heads_24h], ['ADMITTED', 2]);
    await admin.query(`insert into clued_private.work_claim_door_usage_v1(user_id,door,task_id,binding_id,claim_id,unit_key,used_at)
      select $1,'github-ci',$2,$3,$4,lpad(to_hex(g),40,'f'),now() from generate_series(1,37) g`,
    [userId, raceTask, bindingIds.claude, copyA.claim_id]);

    // --- Two verifies racing for the last place: one wins. ---
    const racers = [];
    for (let i = 0; i < 2; i += 1) {
      const client = server.getPgClient();
      clients.push(client);
      await client.connect();
      await client.query('set role anon');
      racers.push(client);
    }
    const results = await Promise.all([[copyA, 'o/r#4', sha(100)], [copyB, 'o/r#5', sha(101)]].map(([c, pr, head], i) =>
      racers[i].query('select public.clued_work_verify_v1($1,$2) v',
        [tokens.reader, { scope: 'global', claim_id: c.claim_id, pr_ref: pr, head_sha: head }]).then((r) => r.rows[0].v)));
    assert.deepEqual(results.map((r) => r.verdict).sort(), ['ADMITTED', 'REJECTED'], JSON.stringify(results));
    assert.equal(await usage(raceTask), 40);

    // --- Task 6414f530: the legacy exemption status no longer reads the
    // removed max_claims_per_task_24h. ---
    const status = (await admin.query('select clued_private.work_claim_exemption_status_v1($1,$2) s', [userId, task])).rows[0].s;
    assert.deepEqual(Object.keys(status).sort(), ['active_exemptions', 'claims_last_24h']);
    assert.equal(status.claims_last_24h, 2);
    // Qualify the complete current chain's explicit Worker82/CI8 successor.
    // Historical Worker80 replay remains in its separate phase tests.
    await assertGatewayCloseoutBoundary(admin);

  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
    await removeTestDirectory(directory);
  }
});
