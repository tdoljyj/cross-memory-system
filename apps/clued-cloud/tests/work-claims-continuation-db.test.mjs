import { stopCluster, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS } from './cluster-cleanup.mjs';
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
import { enableManualOwnerApprovalFixture } from './manual-owner-approval-fixture.mjs';
import { CI_SIGNATURES, setWorkerGatewayCaller, workerGatewayRpc, findGatewayCloseoutMigration, snapshotCallerCatalog, assertGatewayCloseoutBoundary, replayGatewayCloseout } from './worker-gateway-caller-fixture.mjs';

// Work Claim continuation (migration 20261006180000, GenericWorkClaim §10.8,
// Decisions 754dff5d and 9aa6e329): a new claim that picks up, on the same Binding, the
// work its own claim of the Task released as completed with new evidence a
// moment ago takes no token and no Owner Grant use, keeps the first claim's
// hard deadline and names continued_from. Anything else is a start as before.

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

test('work claims: a same-Binding continuation of a completed claim takes no token',
  { timeout: 300000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-work-claims-continuation-'));
  const server = new EmbeddedPostgres({
    databaseDir: directory, user: 'postgres', password: hash(), port: await freePort(),
    persistent: false, initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS],
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
    await admin.query(`insert into auth.users(id,email,email_confirmed_at)
      values($1,'claims-continuation@example.invalid',now())`, [userId]);
    const tokens = {};
    const bindingIds = {};
    for (const name of ['claude', 'codex']) {
      tokens[name] = hash();
      bindingIds[name] = (await admin.query(`insert into public.clued_agent_bindings
        (user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic',$2,$3,array['context:read','context:write'],array['*']) returning id`,
        [userId, name, tokens[name]])).rows[0].id;
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
    const native = async (name, input, claims = fresh(userId)) => {
      await human.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
        [claims.sub ?? '', JSON.stringify(claims)]);
      return (await human.query(`select public.${name}($1) v`, [input])).rows[0].v;
    };
    const agent = async (who, name, input) =>
      CI_SIGNATURES.includes(name + '(text,jsonb)')
        ? (await anon.query(`select public.${name}($1,$2) v`, [tokens[who],input])).rows[0].v
        : await workerGatewayRpc(workerCaller, name, tokens[who], input);
    const committed = (result) => { assert.equal(result.status, 'committed', JSON.stringify(result)); return result; };
    const createTask = async (title) => committed(await agent('claude', 'clued_record_mutate', {
      operation: 'create', record_type: 'task', record_schema_version: 1, lifecycle_status: 'active',
      scope: 'global', idempotency_key: uuid(), authority: 'observed',
      confidence_reason: 'continuation fixture', source_refs: [], source_unavailable_reason: 'fixture',
      mutation: { title, content: 'fixture', type_fields: { execution_bucket: 'next' }, relations: {} },
    })).target_refs[0].id;
    const claim = (taskId, { who = 'claude', session = 'session-a', ...extra } = {}) =>
      agent(who, 'clued_work_claim_v1', { scope: 'global', idempotency_key: uuid(), task_id: taskId,
        write_set: [`steps/${taskId}/**`], ...(session === null ? {} : { holder_session_ref: session }), ...extra });
    let evidenceSeq = 0;
    const release = (c, { who = 'claude', outcome = 'completed', evidence = `commit:${++evidenceSeq}`, ...extra } = {}) =>
      agent(who, 'clued_work_release_v1', { scope: 'global', claim_id: c.claim_id, fence: c.fence, outcome,
        ...(evidence === null ? {} : { evidence_ref: evidence }), ...extra });
    const level = async (kind, key) => Number((await admin.query(`select clued_private.work_claim_bucket_level_v1(
        $1,$2,$3,b.capacity,b.refill,clock_timestamp()) v from (select
          (clued_private.work_claim_profile_v1()->>($2||'_claim_bucket_capacity'))::integer capacity,
          (clued_private.work_claim_profile_v1()->>($2||'_claim_bucket_refill_seconds'))::integer refill) b`,
      [userId, kind, key])).rows[0].v);
    const same = (a, b) => Math.abs(a - b) < 0.01;
    const empty = (taskId) => admin.query(`insert into clued_private.work_claim_rate_buckets_v1
        (user_id,bucket_kind,key_id,tokens,updated_at) values($1,'task',$2,0,clock_timestamp())
      on conflict (user_id,bucket_kind,key_id) do update set tokens=0,updated_at=clock_timestamp()`, [userId, taskId]);
    const resetBindingBucket = (who) => admin.query(`delete from clued_private.work_claim_rate_buckets_v1
      where user_id=$1 and bucket_kind='binding' and key_id=$2`, [userId, bindingIds[who]]);
    const issuedReceipt = async (claimId) => (await admin.query(
      "select metadata from public.clued_audit_receipts where operation='work_claim' and object_id=$1",
      [claimId])).rows[0].metadata;
    // The claim was issued and released that much earlier.
    const ageRelease = async (claimId, seconds) => {
      await admin.query(`update public.clued_audit_receipts set created_at=created_at-make_interval(secs=>$2)
        where operation='work_claim_release' and object_id=$1`, [claimId, seconds]);
      await admin.query(`update clued_private.work_claims_v1 set issued_at=issued_at-make_interval(secs=>$2)
        where claim_id=$1`, [claimId, seconds]);
    };
    // A first claim and its release, then a refused start (bucket emptied)
    // whose continuation.reason says why it was not a continuation.
    const notContinued = async (taskId, prior, next = {}) => {
      await empty(taskId);
      const refused = await claim(taskId, next);
      assert.equal(refused.error_code, 'work_claim_budget_exhausted', JSON.stringify(refused));
      assert.equal(refused.limit, 'task_claim_rate');
      if (prior) assert.equal(refused.continuation.prior_claim_id, prior.claim_id);
      return refused.continuation?.reason;
    };

    const profile = (await admin.query('select clued_private.work_claim_profile_v1() p')).rows[0].p;
    assert.equal(profile.continuation_window_seconds, 900);
    await assert.rejects(() => anon.query(`select clued_private.work_claim_continuation_v1(null,null,null,null)`),
      /permission denied/);

    // --- Stepwise work in one session: one start, then every step continues.
    const stepwise = await createTask('stepwise');
    const first = committed(await claim(stepwise)).claim;
    assert.equal(first.continued_from, null);
    assert.ok(same(await level('task', stepwise), 7));
    const bindingAfterFirst = await level('binding', bindingIds.claude);
    let prior = first;
    for (let step = 0; step < 20; step += 1) {
      committed(await release(prior));
      const next = committed(await claim(stepwise));
      assert.equal(next.continued_from, prior.claim_id, JSON.stringify(next));
      assert.equal(next.claim.continued_from, prior.claim_id);
      assert.equal(next.claim.hard_deadline_at, first.hard_deadline_at, 'the chain keeps the first hard deadline');
      assert.equal(next.claim.renewals, 0);
      assert.equal(next.claim.fence, prior.fence + 1);
      assert.ok(Date.parse(next.claim.expires_at) <= Date.parse(first.hard_deadline_at));
      prior = next.claim;
    }
    assert.ok(same(await level('task', stepwise), 7), 'twenty continuations take no Task token');
    assert.ok(Math.abs(await level('binding', bindingIds.claude) - bindingAfterFirst) < 0.05,
      'and no Binding token');
    const continuedReceipt = await issuedReceipt(prior.claim_id);
    assert.equal(continuedReceipt.continued_from, prior.continued_from);
    assert.equal(continuedReceipt.owner_grant_id, undefined);
    // A replay of a continued claim shows where it came from.
    const replayKey = uuid();
    committed(await release(prior));
    const keyed = committed(await claim(stepwise, { idempotency_key: replayKey }));
    const replay = committed(await claim(stepwise, { idempotency_key: replayKey }));
    assert.deepEqual([replay.replayed, replay.claim.claim_id, replay.claim.continued_from],
      [true, keyed.claim.claim_id, prior.claim_id]);
    prior = keyed.claim;

    // --- A continuation needs no token: it goes through on an empty bucket,
    // and opens no Owner Request.
    committed(await release(prior));
    await empty(stepwise);
    const onEmpty = committed(await claim(stepwise));
    assert.equal(onEmpty.continued_from, prior.claim_id);
    assert.equal((await admin.query(`select count(*)::integer n from clued_private.owner_requests_v1
      where user_id=$1 and task_id=$2`, [userId, stepwise])).rows[0].n, 0);
    prior = onEmpty.claim;

    // --- Evidence must be new to the chain.
    committed(await release(prior, { evidence: 'commit:1' }));
    assert.equal(await notContinued(stepwise, prior), 'no_new_evidence');
    const noEvidenceTask = await createTask('no evidence');
    const noEvidence = committed(await claim(noEvidenceTask)).claim;
    committed(await release(noEvidence, { evidence: null }));
    assert.equal(await notContinued(noEvidenceTask, noEvidence), 'no_new_evidence');

    // --- Only a completed release continues.
    const abandonedTask = await createTask('abandoned');
    const abandoned = committed(await claim(abandonedTask)).claim;
    committed(await release(abandoned, { outcome: 'abandoned' }));
    assert.equal(await notContinued(abandonedTask, abandoned), 'prior_not_completed');
    const expiredTask = await createTask('expired');
    const expired = committed(await claim(expiredTask)).claim;
    await admin.query(`update clued_private.work_claims_v1
      set expires_at=greatest(issued_at,clock_timestamp()-interval '1 second') where claim_id=$1`, [expired.claim_id]);
    assert.equal(await notContinued(expiredTask, expired), 'prior_not_completed');

    // --- The same Binding, whatever the session (Decision 9aa6e329): an
    // orchestrator may run each step in a new Host session, or send none.
    const noSessionTask = await createTask('no session');
    const noSession = committed(await claim(noSessionTask, { session: null })).claim;
    committed(await release(noSession));
    const noSessionNext = committed(await claim(noSessionTask, { session: null }));
    assert.equal(noSessionNext.continued_from, noSession.claim_id);
    committed(await release(noSessionNext.claim));
    const otherSessionTask = await createTask('other session');
    const otherSession = committed(await claim(otherSessionTask)).claim;
    committed(await release(otherSession));
    const otherSessionNext = committed(await claim(otherSessionTask, { session: 'session-b' }));
    assert.equal(otherSessionNext.continued_from, otherSession.claim_id);
    committed(await release(otherSessionNext.claim));
    const otherBindingTask = await createTask('other binding');
    const otherBinding = committed(await claim(otherBindingTask)).claim;
    committed(await release(otherBinding));
    await empty(otherBindingTask);
    const codexTry = await claim(otherBindingTask, { who: 'codex' });
    assert.equal(codexTry.continuation.reason, 'prior_other_holder');

    // --- Released by another Binding with the lease key: not this session's release.
    const keyTask = await createTask('released with key');
    const keyClaim = committed(await claim(keyTask));
    committed(await release(keyClaim.claim, { who: 'codex', lease_key: keyClaim.lease_key }));
    assert.equal(await notContinued(keyTask, keyClaim.claim), 'prior_released_by_other');

    // --- Within the window only.
    const windowTask = await createTask('window');
    const windowClaim = committed(await claim(windowTask)).claim;
    committed(await release(windowClaim));
    await ageRelease(windowClaim.claim_id, 901);
    assert.equal(await notContinued(windowTask, windowClaim), 'window_passed');
    const insideTask = await createTask('inside window');
    const insideClaim = committed(await claim(insideTask)).claim;
    committed(await release(insideClaim));
    await ageRelease(insideClaim.claim_id, 880);
    const inside = committed(await claim(insideTask));
    assert.equal(inside.continued_from, insideClaim.claim_id);
    committed(await release(inside.claim));

    // --- Not past the chain's hard deadline.
    const deadlineTask = await createTask('deadline');
    const deadlineClaim = committed(await claim(deadlineTask)).claim;
    committed(await release(deadlineClaim));
    await admin.query(`update clued_private.work_claims_v1 set issued_at=clock_timestamp()-interval '24 hours',
      expires_at=clock_timestamp()-interval '22 hours',hard_deadline_at=clock_timestamp()+interval '30 seconds'
      where claim_id=$1`, [deadlineClaim.claim_id]);
    await admin.query(`update public.clued_audit_receipts set created_at=clock_timestamp()
      where operation='work_claim_release' and object_id=$1`, [deadlineClaim.claim_id]);
    assert.equal(await notContinued(deadlineTask, deadlineClaim), 'chain_deadline_reached');
    // A fresh start after the chain ends gets a fresh 24 hours.
    await admin.query(`delete from clued_private.work_claim_rate_buckets_v1 where user_id=$1 and key_id=$2`,
      [userId, deadlineTask]);
    const restart = committed(await claim(deadlineTask));
    assert.equal(restart.continued_from, undefined);
    assert.ok(Date.parse(restart.claim.hard_deadline_at) - Date.now() > 23.9 * 3600 * 1000);
    committed(await release(restart.claim));

    // --- Nobody may have been waiting: a conflict refusal naming the claim, or
    // a request from another session addressed to it.
    const contestedTask = await createTask('contested');
    const contested = committed(await claim(contestedTask, { write_set: ['shared/contested/**'] })).claim;
    const waiterTask = await createTask('waiter');
    const clash = await claim(waiterTask, { who: 'codex', session: 'codex-1', write_set: ['shared/contested/x'] });
    assert.equal(clash.error_code, 'work_claim_conflict', JSON.stringify(clash));
    committed(await release(contested));
    assert.equal(await notContinued(contestedTask, contested, { write_set: ['shared/contested/**'] }),
      'prior_contested');
    const requestedTask = await createTask('requested');
    const requested = committed(await claim(requestedTask)).claim;
    committed(await agent('codex', 'clued_agent_message_send_v1', { idempotency_key: uuid(),
      to: { claim_id: requested.claim_id }, session_ref: 'codex-1', subject: 'Need these paths',
      body: 'Please release when you can.' }));
    committed(await release(requested));
    assert.equal(await notContinued(requestedTask, requested), 'prior_requested');
    // An info message is not a request.
    const infoTask = await createTask('info only');
    const informed = committed(await claim(infoTask)).claim;
    committed(await agent('codex', 'clued_agent_message_send_v1', { idempotency_key: uuid(), kind: 'info',
      to: { claim_id: informed.claim_id }, session_ref: 'codex-1', subject: 'FYI', body: 'Nothing needed.' }));
    committed(await release(informed));
    const afterInfo = committed(await claim(infoTask));
    assert.equal(afterInfo.continued_from, informed.claim_id);
    committed(await release(afterInfo.claim));

    // --- Another claim of the Task in between ends the chain.
    const betweenTask = await createTask('claim in between');
    const before = committed(await claim(betweenTask)).claim;
    committed(await release(before));
    await resetBindingBucket('codex');
    const codexBetween = committed(await claim(betweenTask, { who: 'codex', session: 'codex-1' })).claim;
    assert.equal(codexBetween.continued_from, null);
    committed(await release(codexBetween, { who: 'codex' }));
    assert.equal(await notContinued(betweenTask, codexBetween), 'prior_other_holder');

    // --- The holder's own conflict (claiming the next step before releasing
    // this one) does not contest its claim.
    const ownTask = await createTask('own conflict');
    const ownFirst = committed(await claim(ownTask)).claim;
    assert.equal((await claim(ownTask)).error_code, 'work_claim_conflict');
    committed(await release(ownFirst));
    const ownNext = committed(await claim(ownTask));
    assert.equal(ownNext.continued_from, ownFirst.claim_id);
    // Another session of the same Binding is someone else: it contests.
    assert.equal((await claim(ownTask, { session: 'session-b' })).error_code, 'work_claim_conflict');
    committed(await release(ownNext.claim));
    assert.equal(await notContinued(ownTask, ownNext.claim), 'prior_contested');

    // --- A takeover refused as still active contests the claim.
    const stillTask = await createTask('takeover attempt');
    const still = committed(await claim(stillTask)).claim;
    const attempt = await agent('codex', 'clued_work_takeover_v1',
      { scope: 'global', claim_id: still.claim_id, idempotency_key: uuid() });
    assert.equal(attempt.error_code, 'work_claim_still_active', JSON.stringify(attempt));
    committed(await release(still));
    assert.equal(await notContinued(stillTask, still), 'prior_contested');

    // --- A refusal whose Receipt the one-minute dedupe drops still contests.
    const dedupeTask = await createTask('dedupe holder');
    const dedupeWaiter = await createTask('dedupe waiter');
    const d1 = committed(await claim(dedupeTask, { write_set: ['shared/dedupe/**'] })).claim;
    assert.equal((await claim(dedupeWaiter, { who: 'codex', session: 'codex-2', write_set: ['shared/dedupe/x'] }))
      .error_code, 'work_claim_conflict');
    committed(await release(d1));
    await resetBindingBucket('claude');
    const d2 = committed(await claim(dedupeTask, { write_set: ['shared/dedupe/**'] })).claim;
    assert.equal(d2.continued_from, null, 'd1 was contested');
    assert.equal((await claim(dedupeWaiter, { who: 'codex', session: 'codex-2', write_set: ['shared/dedupe/x'] }))
      .error_code, 'work_claim_conflict');
    assert.equal((await admin.query(`select count(*)::integer n from public.clued_audit_receipts
      where operation='work_claim_reject' and object_id=$1`, [dedupeWaiter])).rows[0].n, 1, 'one Receipt a minute');
    committed(await release(d2));
    assert.equal(await notContinued(dedupeTask, d2, { write_set: ['shared/dedupe/**'] }), 'prior_contested');

    // --- A race copy and a claim the Owner handed over are not continued.
    const copyTask = await createTask('copy');
    const copy = committed(await claim(copyTask)).claim;
    committed(await release(copy));
    await admin.query('update clued_private.work_claims_v1 set copy_index=1 where claim_id=$1', [copy.claim_id]);
    assert.equal(await notContinued(copyTask, copy), 'prior_race_copy');
    const handedTask = await createTask('handed over');
    const handed = committed(await claim(handedTask)).claim;
    committed(await release(handed));
    await admin.query('update clued_private.work_claims_v1 set lease_key_required=true where claim_id=$1',
      [handed.claim_id]);
    assert.equal(await notContinued(handedTask, handed), 'prior_handed_over');

    // --- Draining, then completed: the completed release counts.
    const drainTask = await createTask('draining');
    const drain = committed(await claim(drainTask)).claim;
    committed(await release(drain, { outcome: 'draining', evidence: null }));
    committed(await release(drain));
    assert.equal(committed(await claim(drainTask)).continued_from, drain.claim_id);
    await admin.query(`update clued_private.work_claims_v1 set status='RELEASED',released_outcome='abandoned'
      where task_id=$1 and status='ACTIVE'`, [drainTask]);

    // --- A continuation on an empty bucket leaves an Owner Grant unused: a
    // start after an abandoned claim asks for a grant and uses it once; the
    // continuation of the granted claim does not use it again.
    await resetBindingBucket('claude');
    const grantTask = await createTask('grant untouched');
    const g1 = committed(await claim(grantTask)).claim;
    committed(await release(g1, { outcome: 'abandoned' }));
    await empty(grantTask);
    const askGrant = await claim(grantTask);
    assert.equal(askGrant.limit, 'task_claim_rate');
    assert.equal(askGrant.continuation.reason, 'prior_not_completed');
    const issued = await native('clued_owner_grant_confirmation_issue_v1',
      { request_id: askGrant.owner_request.request_id, choice: 'grant', max_uses: 5 });
    assert.equal(issued.status, 'issued', JSON.stringify(issued));
    const grant = committed(await native('clued_owner_grant_v1', { confirmation_token: issued.confirmation_token,
      view_digest: issued.view_digest })).grant;
    const g2 = committed(await claim(grantTask)).claim;
    assert.equal((await issuedReceipt(g2.claim_id)).owner_grant_id, grant.grant_id);
    const usesOf = async () => (await admin.query('select uses from clued_private.owner_grants_v1 where id=$1',
      [grant.grant_id])).rows[0].uses;
    assert.equal(await usesOf(), 1);
    committed(await release(g2));
    const g3 = committed(await claim(grantTask));
    assert.equal(g3.continued_from, g2.claim_id);
    assert.equal(await usesOf(), 1, 'the continuation leaves the grant unused');
    assert.equal((await issuedReceipt(g3.claim.claim_id)).owner_grant_id, undefined);
    committed(await release(g3.claim));

    // --- A takeover takes a token as before.
    const takeoverTask = await createTask('takeover');
    const taken = committed(await claim(takeoverTask)).claim;
    await admin.query(`update clued_private.work_claims_v1
      set expires_at=greatest(issued_at,clock_timestamp()-interval '1 second') where claim_id=$1`, [taken.claim_id]);
    const tookOver = committed(await agent('claude', 'clued_work_takeover_v1',
      { scope: 'global', claim_id: taken.claim_id, idempotency_key: uuid(), holder_session_ref: 'session-a' }));
    assert.equal(tookOver.continued_from, undefined);
    assert.ok(same(await level('task', takeoverTask), 6));
    // The real formal migration is installed by the full chain and replays
    // unchanged after the original business/concurrency/negative matrix.
    const closeoutMigration = await findGatewayCloseoutMigration(root);
    const closeoutBefore = await snapshotCallerCatalog(admin);
    await replayGatewayCloseout(admin, await fs.readFile(path.join(root, 'supabase/migrations', closeoutMigration), 'utf8'));
    assert.deepEqual(await snapshotCallerCatalog(admin), closeoutBefore, 'formal closeout replay preserves definitions and caller ACLs');
    await assertGatewayCloseoutBoundary(admin);

  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
  }
});
