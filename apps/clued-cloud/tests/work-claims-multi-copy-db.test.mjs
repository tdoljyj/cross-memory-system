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
import { CI_SIGNATURES, setWorkerGatewayCaller, workerGatewayRpc, findGatewayCloseoutMigration, snapshotCallerCatalog, assertGatewayCloseoutBoundary, replayGatewayCloseout } from './worker-gateway-caller-fixture.mjs';

// Work Claim multi-copy mode, a "race" (migration 20261003120000,
// GenericWorkClaim §5.3): only the Owner turns a Task into N copies, in two
// Native steps; copies never conflict with each other; the first copy written
// back (Clued storage gate or merged pull request) is adopted and the others
// are out with copy_not_adopted.

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

test('work claims: Owner-enabled races, copy slots, write-back adoption and copy_not_adopted',
  { timeout: 300000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-work-claims-multi-copy-'));
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
      values($1,'race@example.invalid',now()),($2,'race-other@example.invalid',now())`, [userId, otherUser]);
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

    // --- Only the Owner, in two Native steps, can start a race. ---
    const task = await createTask('race target');
    await assert.rejects(() => anon.query('select public.clued_work_claim_multi_confirmation_issue_v1($1)',
      [{ task_id: task, copies: 3, shared_resources: shared }]), /permission denied/);
    await assert.rejects(() => anon.query('select public.clued_work_claim_multi_enable_v1($1)',
      [{ confirmation_token: 'x', view_digest: 'x' }]), /permission denied/);
    await assert.rejects(() => native('clued_work_claim_multi_confirmation_issue_v1',
      { task_id: task, copies: 3, shared_resources: shared }, { ...fresh(userId), client_id: 'oauth-client' }),
    /direct_human_session_required/);
    const { session_id: _omit, ...noSession } = fresh(userId);
    assert.equal((await native('clued_work_claim_multi_confirmation_issue_v1',
      { task_id: task, copies: 3, shared_resources: shared }, noSession)).error_code, 'confirmation_token_session_id_required');
    for (const [input, code] of [
      [{ task_id: task, copies: 1, shared_resources: shared }, 'work_claim_multi_copies_invalid'],
      [{ task_id: task, copies: 9, shared_resources: shared }, 'work_claim_multi_copies_invalid'],
      [{ task_id: task, copies: 'x', shared_resources: shared }, 'work_claim_multi_copies_invalid'],
      [{ task_id: task, copies: 3 }, 'work_claim_multi_shared_invalid'],
      [{ task_id: task, copies: 3, shared_resources: [] }, 'work_claim_multi_shared_invalid'],
      [{ task_id: task, copies: 3, shared_resources: shared, mode: 'x' }, 'work_claim_multi_unknown_field'],
      [{ task_id: uuid(), copies: 3, shared_resources: shared }, 'work_claim_task_unavailable'],
    ]) assert.equal((await native('clued_work_claim_multi_confirmation_issue_v1', input)).error_code, code, JSON.stringify(input));
    assert.equal((await native('clued_work_claim_multi_confirmation_issue_v1',
      { task_id: task, copies: 3, shared_resources: shared }, fresh(otherUser))).error_code, 'work_claim_task_unavailable');

    // A Task with a live claim cannot become a race.
    const solo = committed(await claim(task)).claim;
    assert.equal(solo.copy_index, null);
    assert.equal((await native('clued_work_claim_multi_confirmation_issue_v1',
      { task_id: task, copies: 3, shared_resources: shared })).error_code, 'work_claim_multi_task_busy');
    committed(await release('claude', solo));

    const issued = await native('clued_work_claim_multi_confirmation_issue_v1', { task_id: task, copies: 3, shared_resources: shared });
    assert.equal(issued.status, 'issued');
    assert.match(issued.confirmation_token, /^clued_wcm_[0-9a-f]{64}$/);
    assert.deepEqual([issued.confirmation_view.copies, issued.confirmation_view.shared_resources, issued.confirmation_view.task_title],
      [3, shared, 'race target']);
    assert.equal(issued.max_copies, 8);
    assert.ok(issued.suggested_copies >= 2 && issued.suggested_copies <= 8);
    // Another session of the same account cannot use the token; that attempt burns it.
    assert.equal((await native('clued_work_claim_multi_enable_v1',
      { confirmation_token: issued.confirmation_token, view_digest: issued.view_digest }, fresh(userId, 'sess-other'))).error_code,
    'confirmation_token_binding_mismatch');
    const { enabled } = await enable({ task_id: task, copies: 3, shared_resources: shared });
    committed(enabled);
    assert.deepEqual([enabled.race.task_id, enabled.race.copies, enabled.race.shared_resources], [task, 3, shared]);
    const receipt = (await admin.query('select * from public.clued_audit_receipts where id=$1', [enabled.receipt_id])).rows[0];
    assert.deepEqual([receipt.binding_id, receipt.metadata.receipt_kind, receipt.metadata.principal],
      [null, 'WORK_CLAIM_MULTI_ENABLED', 'native_account_session']);
    assert.equal((await native('clued_work_claim_multi_confirmation_issue_v1',
      { task_id: task, copies: 2, shared_resources: shared })).error_code, 'work_claim_multi_already_set');
    // The race table is closed to client roles.
    await assert.rejects(() => anon.query('select * from clued_private.work_claim_task_modes_v1'), /permission denied/);

    // --- Copies: overlapping write sets, same Task, no conflict between them. ---
    const tokensBefore = Number((await admin.query(`select tokens from clued_private.work_claim_rate_buckets_v1
      where user_id=$1 and bucket_kind='task' and key_id=$2`, [userId, task])).rows[0].tokens);
    const c1 = committed(await claim(task, 'claude', 'session-a'));
    const c2 = committed(await claim(task, 'codex', 'session-b'));
    const c3 = committed(await claim(task, 'claude', 'session-c'));
    assert.deepEqual([c1.claim.copy_index, c2.claim.copy_index, c3.claim.copy_index], [1, 2, 3]);
    assert.deepEqual(c1.claim_mode, { mode: 'multi', copies: 3, copy_index: 1, shared_resources: shared });
    const tokensAfter = Number((await admin.query(`select tokens from clued_private.work_claim_rate_buckets_v1
      where user_id=$1 and bucket_kind='task' and key_id=$2`, [userId, task])).rows[0].tokens);
    assert.ok(tokensBefore - tokensAfter > 2.9, 'each copy takes a Task token');
    const full = await claim(task, 'codex', 'session-d');
    assert.equal(full.error_code, 'work_claim_copies_full', JSON.stringify(full));
    assert.deepEqual(full.live_copies.map((c) => c.copy_index), [1, 2, 3]);
    // Another Task's claim still conflicts with the copies' resources.
    const other = await createTask('other work');
    const clash = await claim(other, 'codex', 'session-e');
    assert.equal(clash.error_code, 'work_claim_conflict');
    assert.equal(clash.conflicts.length, 3);
    // Renewing a copy with a changed write set ignores its siblings.
    committed(await agent('claude', 'clued_work_renew_v1', { scope: 'global', claim_id: c1.claim.claim_id,
      fence: c1.claim.fence, lease_version: 1, progress_ref: 'r1', write_set: ['storage:c1/**', 'storage:c1/extra/**'] }));

    // --- GitHub door: every live copy is admitted on its own pull request. ---
    for (const [c, pr] of [[c1, 'o/n#11'], [c2, 'o/n#12'], [c3, 'o/n#13']]) {
      const v = await verify(c.claim, pr);
      assert.equal(v.verdict, 'ADMITTED', JSON.stringify(v));
    }
    // --- Storage door: drafts pass, siblings ignored; writing back adopts. ---
    assert.equal(await gate('codex', c2.claim, ['storage:c1/_copies/2/a.md']), null);
    assert.equal(await gate('claude', c1.claim, ['storage:c1/_copies/1/a.md']), null);
    // Without presenting a claim, a write still collides with the copies.
    assert.equal((await gate('codex', null, ['storage:c1/_copies/2/a.md'])).error_code, 'work_claim_conflict');
    assert.equal(await gate('codex', c2.claim, ['storage:c1/final/report.md']), null);
    assert.deepEqual(await row(c2.claim.claim_id), { status: 'ACTIVE', outcome: 'adopted', copy_index: 2, superseded_by: null });
    for (const c of [c1, c3]) {
      assert.deepEqual(await row(c.claim.claim_id),
        { status: 'SUPERSEDED', outcome: 'not_adopted', copy_index: c.claim.copy_index, superseded_by: c2.claim.claim_id });
    }
    const race = (await admin.query('select * from clued_private.work_claim_task_modes_v1 where task_id=$1', [task])).rows[0];
    assert.equal(race.adopted_claim_id, c2.claim.claim_id);
    const adoptReceipt = (await admin.query('select metadata from public.clued_audit_receipts where id=$1',
      [race.adopted_receipt_id])).rows[0].metadata;
    assert.deepEqual([adoptReceipt.receipt_kind, adoptReceipt.door, adoptReceipt.not_adopted.length],
      ['WORK_CLAIM_COPY_ADOPTED', 'clued-storage', 2]);
    // The other copies are out at every door.
    assert.equal((await gate('claude', c1.claim, ['storage:c1/_copies/1/b.md'])).error_code, 'copy_not_adopted');
    const late = await verify(c1.claim, 'o/n#11');
    assert.equal(late.verdict, 'REJECTED');
    assert.ok(late.reasons.includes('copy_not_adopted') && late.reasons.includes('claim_not_current'), JSON.stringify(late));
    assert.equal((await agent('claude', 'clued_work_renew_v1', { scope: 'global', claim_id: c3.claim.claim_id,
      fence: c3.claim.fence, lease_version: 1, progress_ref: 'r2' })).error_code, 'work_claim_not_active');
    const lost = await agent('reader', 'clued_work_claim_adopt_v1', { pr_ref: 'o/n#11', merge_sha: 'abcdef1' });
    assert.deepEqual([lost.status, lost.error_code], ['rejected', 'copy_not_adopted']);
    // The winner is still admitted; after adoption the Task is exclusive again.
    assert.equal((await verify(c2.claim, 'o/n#12')).verdict, 'ADMITTED');
    assert.equal((await claim(task, 'claude', 'session-f')).error_code, 'work_claim_conflict');
    committed(await release('codex', c2.claim));
    const after = committed(await claim(task, 'claude', 'session-f'));
    assert.equal(after.claim.copy_index, null);
    assert.equal(after.claim_mode, undefined);
    committed(await release('claude', after.claim));

    // --- GitHub write-back: a merged copy's pull request adopts it. ---
    const ghTask = await createTask('github race');
    committed((await enable({ task_id: ghTask, copies: 2, shared_resources: ['repo:o/n/**'] })).enabled);
    const g1 = committed(await claim(ghTask, 'claude', 'gh-a', ['src/feature.ts']));
    const g2 = committed(await claim(ghTask, 'codex', 'gh-b', ['src/feature.ts']));
    assert.equal((await verify(g1.claim, 'o/n#21')).verdict, 'ADMITTED');
    assert.equal((await verify(g2.claim, 'o/n#22')).verdict, 'ADMITTED');
    // The admission Binding is read-only; adopt accepts it, like verify's binding.
    assert.deepEqual(await agent('reader', 'clued_work_claim_adopt_v1', { pr_ref: 'o/n#99', merge_sha: 'abcdef1' }),
      { status: 'ok', adopted: false, reason: 'no_copy_for_pr', pr_ref: 'o/n#99' });
    await assert.rejects(() => agent('reader', 'clued_work_claim_adopt_v1', { pr_ref: 'not a pr', merge_sha: 'abcdef1' }),
      /work_claim_pr_ref_invalid/);
    await assert.rejects(() => agent('reader', 'clued_work_claim_adopt_v1', { pr_ref: 'o/n#22', merge_sha: 'abcdef1', x: 1 }),
      /work_claim_adopt_input_invalid/);
    // The winner released its claim right after merging: adoption still holds.
    committed(await release('codex', g2.claim));
    const won = await agent('reader', 'clued_work_claim_adopt_v1', { pr_ref: 'o/n#22', merge_sha: 'abcdef1234' });
    assert.deepEqual([won.status, won.adopted, won.claim_id, won.not_adopted], ['ok', true, g2.claim.claim_id, [g1.claim.claim_id]]);
    const again = await agent('reader', 'clued_work_claim_adopt_v1', { pr_ref: 'o/n#22', merge_sha: 'abcdef1234' });
    assert.deepEqual([again.adopted, again.replayed], [true, true]);
    assert.equal((await verify(g1.claim, 'o/n#21')).verdict, 'REJECTED');
    assert.deepEqual(await row(g1.claim.claim_id),
      { status: 'SUPERSEDED', outcome: 'not_adopted', copy_index: 1, superseded_by: g2.claim.claim_id });

    // --- A takeover of an expired copy keeps its slot. ---
    const tkTask = await createTask('takeover race');
    committed((await enable({ task_id: tkTask, copies: 2, shared_resources: ['storage:c2/final/**'] })).enabled);
    const t1 = committed(await claim(tkTask, 'claude', 'tk-a', ['storage:c2/**']));
    const t2 = committed(await claim(tkTask, 'codex', 'tk-b', ['storage:c2/**']));
    await admin.query(`update clued_private.work_claims_v1
      set expires_at=greatest(issued_at,clock_timestamp()-interval '1 second') where claim_id=$1`, [t1.claim.claim_id]);
    const taken = committed(await agent('codex', 'clued_work_takeover_v1',
      { scope: 'global', claim_id: t1.claim.claim_id, idempotency_key: uuid(), holder_session_ref: 'tk-c' }));
    assert.equal(taken.claim.copy_index, 1);
    assert.equal((await verify(taken.claim, 'o/n#31')).verdict, 'ADMITTED');
    assert.equal((await verify(t2.claim, 'o/n#32')).verdict, 'ADMITTED');

    // --- Exclusive Tasks are unchanged: one live claim, same-Task conflict. ---
    const plain = await createTask('plain');
    const p1 = committed(await claim(plain, 'claude', 'p-a', ['plain/a']));
    assert.equal(p1.claim.copy_index, null);
    const p2 = await claim(plain, 'codex', 'p-b', ['plain/b']);
    assert.equal(p2.error_code, 'work_claim_conflict');
    assert.equal(p2.conflicts[0].overlap.same_task, true);
    // The real formal migration is installed by the full chain and replays
    // unchanged after the original business/concurrency/negative matrix.
    const closeoutMigration = await findGatewayCloseoutMigration(root);
    const closeoutBefore = await snapshotCallerCatalog(admin);
    await replayGatewayCloseout(admin, await fs.readFile(path.join(root, 'supabase/migrations', closeoutMigration), 'utf8'));
    assert.deepEqual(await snapshotCallerCatalog(admin), closeoutBefore, 'formal closeout replay preserves definitions and caller ACLs');
    await assertGatewayCloseoutBoundary(admin);

  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await server.stop().catch(() => {});
  }
});
