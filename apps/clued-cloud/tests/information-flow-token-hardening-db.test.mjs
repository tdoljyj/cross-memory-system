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

// Information Flow confirmation-token hardening (M0-D follow-up; B09 round 3
// F01, A03 register L29 and L30) on the full migration chain. The chain up to
// the hardening migration is applied first and each defect is reproduced;
// then the hardening migration (and anything later) is applied and the fixed
// behaviour is asserted through the public Native RPC entries.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARDENING_MIGRATION = '20260925000000_information_flow_token_hardening.sql';
const HARDENING_PREDECESSOR = '20260924233000_projection_head_event_shadow_fix.sql';
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const nowEpoch = () => Math.floor(Date.now() / 1000);
const fresh = (sub, session = 'sess-main') =>
  ({ sub, role: 'authenticated', session_id: session, aal: 'aal1', amr: [{ method: 'password', timestamp: nowEpoch() }] });
const noSession = (sub, sessionClaim) => {
  const claims = { sub, role: 'authenticated', aal: 'aal1', amr: [{ method: 'password', timestamp: nowEpoch() }] };
  if (sessionClaim !== undefined) claims.session_id = sessionClaim;
  return claims;
};
const TOKENIZER = { package: 'js-tiktoken', version: '1.0.21', encoding: 'o200k_base', model_mapping: 'gpt-4.1-2025-04-14' };
let keyCounter = 0;
const key = (label) => `if-th-${label}-${String(++keyCounter).padStart(4, '0')}`;

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

const TEXT = 'Qingshi token hardening fixture confirmed by the owner.';
const segment = (segmentId) => ({
  schema_version: 'segment_input.v1', segment_id: segmentId,
  reference_time: '2026-09-25T10:00:00+08:00', timezone: 'Asia/Shanghai',
  messages: [{ message_id: 'msg_th_a', evidence_id: 'ev_th_a', author_role: 'user',
    created_at: '2026-09-25T09:58:00+08:00', context_only: false, content: TEXT }],
});
const item = (local) => ({
  candidate_local_id: `item_${local}`, item_type: 'fact',
  claim: `fact claim ${local}: ${TEXT}`.slice(0, 300), summary: `fact summary ${local}`.slice(0, 120),
  action_level: 'reference', priority: null,
  entity_mentions: [{ type: 'project', mention: 'Qingshi', role: 'subject' }], topics: ['risk'],
  temporal_mentions: [], source_anchors: [{ message_id: 'msg_th_a', exact_quote: 'token hardening fixture' }],
  confidence: 0.9, uncertainties: [], sensitivity_hint: 'none',
});
const policyDoc = (taskClass) => ({
  schema: 'clued.context-policy.v1', task_class: taskClass, allowed_scopes: ['global'],
  allowed_record_types: ['note'], require_evidence: false,
  fields: { required: ['title'], optional: ['content'] }, max_items: 50, token_budget: 32768,
  tokenizer: TOKENIZER, freshness: { mode: 'current' },
});

test('Information Flow token hardening: F01 burn order, L29 session binding, L30 action filter',
  { timeout: 900000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-if-th-'));
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
    const migrations = (await fs.readdir(path.join(root, 'supabase/migrations')))
      .filter((name) => name.endsWith('.sql')).sort();
    const hIndex = migrations.indexOf(HARDENING_MIGRATION);
    assert.ok(hIndex > 0, 'the hardening migration is in the chain');
    assert.equal(migrations[hIndex - 1], HARDENING_PREDECESSOR,
      'the hardening migration directly follows the projection head shadow fix');
    const versions = migrations.map((name) => name.split('_')[0]);
    assert.equal(new Set(versions).size, versions.length, 'migration versions are unique');
    const apply = async (name) => {
      try { await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    };
    for (const name of migrations.slice(0, hIndex)) await apply(name);

    const userId = uuid();
    const otherUser = uuid();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at)
      values($1,'if-th@example.invalid',now()),($2,'if-th-other@example.invalid',now())`, [userId, otherUser]);

    const human = server.getPgClient();
    clients.push(human);
    await human.connect();
    await human.query('set role authenticated');
    const as = async (claims) => human.query(
      "select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
      [claims.sub ?? '', JSON.stringify(claims)]);
    const native = async (name, input, claims = fresh(userId)) => {
      await as(claims);
      return (await human.query(`select public.${name}($1,$2) v`, [input, sha256(JSON.stringify(input))])).rows[0].v;
    };
    const nativeOne = async (name, input, claims = fresh(userId)) => {
      await as(claims);
      return (await human.query(`select public.${name}($1) v`, [input])).rows[0].v;
    };
    const candidateToken = async (id) => (await admin.query(
      'select * from clued_private.candidate_confirmation_tokens where id=$1', [id])).rows[0];
    const nativeToken = async (id) => (await admin.query(
      'select * from clued_private.native_confirmation_tokens where id=$1', [id])).rows[0];
    const count = async (table) => (await admin.query(`select count(*)::int n from ${table}`)).rows[0].n;
    const candidateStatus = async (id) => (await admin.query(
      'select status from clued_private.information_candidates where id=$1', [id])).rows[0].status;
    const receiptStatus = async (id) => (await admin.query(
      'select status from public.clued_audit_receipts where id=$1', [id])).rows[0].status;

    let submitCounter = 0;
    const submitCandidates = async (n) => {
      submitCounter += 1;
      const segmentId = `seg_th_${submitCounter}`;
      const items = Array.from({ length: n }, (_, index) => item(`${submitCounter}_${index}`));
      const result = await native('clued_user_intake_submit', { idempotency_key: key('submit'), scope: 'global',
        segment: segment(segmentId), candidates: { schema_version: 'candidate_information.v1', segment_id: segmentId, items } });
      assert.equal(result.status, 'committed', JSON.stringify(result));
      return result.supplemental.candidates.map((row) => row.id);
    };
    const ingestEvidence = async (label) => {
      const result = await native('clued_user_evidence_ingest', { idempotency_key: key('ev'), evidence_schema_version: 1,
        evidence_type: 'file', storage_ref: `native:${label}`, content_hash: sha256(label), mime_type: 'text/plain',
        size_bytes: 1 });
      assert.equal(result.status, 'committed', JSON.stringify(result));
      return result.evidence_ids[0];
    };
    const issueCandidate = (id, claims) => nativeOne('clued_candidate_confirmation_issue_v1',
      { tier: 'information', candidate_id: id, base_version: 1, authority: 'user_explicit' }, claims);
    const promoteInput = (id, issued, overrides = {}) => ({ idempotency_key: key('promote'), tier: 'information',
      candidate_id: id, base_version: 1, confirmation_token: issued.confirmation_token,
      view_digest: issued.view_digest, ...overrides });
    const issuePolicy = (taskClass, claims) => nativeOne('clued_context_policy_confirmation_issue_v1',
      { policy: policyDoc(taskClass), rationale: `Hardening policy ${taskClass}`, base_policy_version: 0 }, claims);
    const acceptInput = (taskClass, issued, overrides = {}) => ({ idempotency_key: key('accept'), task_class: taskClass,
      base_policy_version: 0, confirmation_token: issued.confirmation_token, view_digest: issued.view_digest, ...overrides });
    const issueWithdrawal = (evidenceId, claims) => nativeOne('clued_evidence_withdrawal_confirmation_issue_v1',
      { evidence_id: evidenceId, base_version: 0, reason: 'Hardening withdrawal' }, claims);
    const withdrawInput = (evidenceId, issued, overrides = {}) => ({ idempotency_key: key('withdraw'),
      evidence_id: evidenceId, base_version: 0, confirmation_token: issued.confirmation_token,
      view_digest: issued.view_digest, ...overrides });
    const issued = (result) => { assert.equal(result.status, 'issued', JSON.stringify(result)); return result; };

    // ---- Reproduction on the chain before the hardening migration.
    const [preCandidate, preCandidateNull] = await submitCandidates(2);
    const preEvidence = await ingestEvidence('pre-hardening');
    // F01: a malformed promote left the live token unburned.
    const preF01 = issued(await issueCandidate(preCandidate));
    const preF01Refused = await native('clued_candidate_promote_v1', promoteInput(preCandidate, preF01, { surprise: 1 }));
    assert.deepEqual([preF01Refused.status, preF01Refused.error_code], ['rejected', 'candidate_promote_unknown_field']);
    assert.equal((await candidateToken(preF01.token_id)).consumed_at, null, 'reproduced F01: the token was not burned');
    // L29: a JWT without session_id obtained a token with a NULL session.
    const preL29 = issued(await issueCandidate(preCandidateNull, noSession(userId)));
    assert.equal((await candidateToken(preL29.token_id)).session_id, null, 'reproduced L29: NULL session binding');
    // L30: an S4 token presented to S5 withdraw was burned.
    const preL30 = issued(await issuePolicy('pre.hardening'));
    const preL30Refused = await native('clued_evidence_withdraw_v1', withdrawInput(preEvidence, preL30));
    assert.deepEqual([preL30Refused.status, preL30Refused.error_code], ['rejected', 'confirmation_token_binding_mismatch']);
    assert.equal((await nativeToken(preL30.token_id)).consume_outcome, 'rejected',
      'reproduced L30: a token for another action was burned');

    // ---- Anchor drift: one anchor's whitespace changed in a patched function
    // (the last one patched, S4 accept) makes the migration fail with a
    // definition mismatch and leave nothing behind (the file is one implicit
    // transaction): no helper and no partially patched function.
    const def = async (signature) => (await admin.query('select pg_get_functiondef($1::regprocedure) d', [signature]))
      .rows[0].d;
    const ACCEPT = 'clued_private.context_policy_accept_core_v1(uuid,jsonb,text)';
    const PATCHED = ['clued_private.candidate_confirmation_issue_core_v1(uuid,jsonb)',
      'clued_private.context_policy_confirmation_issue_core_v1(uuid,jsonb)',
      'clued_private.evidence_withdrawal_confirmation_issue_core_v1(uuid,jsonb)',
      'clued_private.candidate_promote_core_v1(uuid,jsonb,text)', ACCEPT,
      'clued_private.evidence_withdraw_core_v1(uuid,jsonb,text)'];
    const definitionsBefore = Object.fromEntries(await Promise.all(PATCHED.map(async (sig) => [sig, await def(sig)])));
    const acceptOriginal = definitionsBefore[ACCEPT];
    const drifted = acceptOriginal.replace(
      '    select * into v_token from clued_private.native_confirmation_tokens t\n      where t.user_id=p_user_id\n',
      '    select * into v_token from clued_private.native_confirmation_tokens t\n      where  t.user_id=p_user_id\n');
    assert.notEqual(drifted, acceptOriginal, 'the drift probe changes the anchor');
    await admin.query(drifted);
    await assert.rejects(apply(HARDENING_MIGRATION), /token_hardening_accept_definition_mismatch/);
    assert.equal((await admin.query("select to_regprocedure('clued_private.native_session_id_v1()') r")).rows[0].r, null,
      'no helper is left behind');
    for (const sig of PATCHED.filter((sig) => sig !== ACCEPT)) {
      assert.equal(await def(sig), definitionsBefore[sig], `no partial patch: ${sig}`);
    }
    assert.equal(await def(ACCEPT), drifted);
    await admin.query(acceptOriginal);
    assert.equal(await def(ACCEPT), acceptOriginal, 'the drift probe is undone');

    // ---- Apply the hardening migration and every later migration.
    await apply(HARDENING_MIGRATION);
    for (const name of migrations.slice(hIndex + 1)) await apply(name);
    await assert.rejects(apply(HARDENING_MIGRATION), /already exists|definition_mismatch/,
      'the migration cannot be applied twice');

    // Effective definitions carry each patch; grants are unchanged.
    for (const signature of ['clued_private.candidate_confirmation_issue_core_v1(uuid,jsonb)',
      'clued_private.context_policy_confirmation_issue_core_v1(uuid,jsonb)',
      'clued_private.evidence_withdrawal_confirmation_issue_core_v1(uuid,jsonb)']) {
      assert.match(await def(signature), /confirmation_token_session_id_required/, signature);
    }
    for (const signature of ['clued_private.candidate_promote_core_v1(uuid,jsonb,text)',
      'clued_private.context_policy_accept_core_v1(uuid,jsonb,text)',
      'clued_private.evidence_withdraw_core_v1(uuid,jsonb,text)']) {
      assert.match(await def(signature), /v_token\.session_id is null or clued_private\.native_session_id_v1\(\) is null\n\s+or v_token\.session_id<>clued_private\.native_session_id_v1\(\) then/, signature);
    }
    assert.match(await def('clued_private.candidate_promote_core_v1(uuid,jsonb,text)'), /Single use \(F01\)/);
    assert.match(await def('clued_private.context_policy_accept_core_v1(uuid,jsonb,text)'),
      /where t\.user_id=p_user_id and t\.action='context_policy_accept'\n\s+and t\.token_hash=[^\n]+\n\s+for update;/);
    assert.match(await def('clued_private.evidence_withdraw_core_v1(uuid,jsonb,text)'),
      /where t\.user_id=p_user_id and t\.action='evidence_withdraw'\n\s+and t\.token_hash=[^\n]+\n\s+for update;/);
    const privilege = async (role, signature) => (await admin.query(
      'select has_function_privilege($1,$2,$3) v', [role, signature, 'execute'])).rows[0].v;
    for (const signature of ['public.clued_candidate_confirmation_issue_v1(jsonb)',
      'public.clued_candidate_promote_v1(jsonb,text)', 'public.clued_context_policy_confirmation_issue_v1(jsonb)',
      'public.clued_context_policy_accept_v1(jsonb,text)', 'public.clued_evidence_withdrawal_confirmation_issue_v1(jsonb)',
      'public.clued_evidence_withdraw_v1(jsonb,text)']) {
      assert.equal(await privilege('authenticated', signature), true, signature);
      assert.equal(await privilege('anon', signature), false, signature);
      assert.equal(await privilege('service_role', signature), false, signature);
    }
    for (const signature of ['clued_private.candidate_confirmation_issue_core_v1(uuid,jsonb)',
      'clued_private.candidate_promote_core_v1(uuid,jsonb,text)',
      'clued_private.context_policy_confirmation_issue_core_v1(uuid,jsonb)',
      'clued_private.context_policy_accept_core_v1(uuid,jsonb,text)',
      'clued_private.evidence_withdrawal_confirmation_issue_core_v1(uuid,jsonb)',
      'clued_private.evidence_withdraw_core_v1(uuid,jsonb,text)', 'clued_private.native_session_id_v1()']) {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        assert.equal(await privilege(role, signature), false, `${role} ${signature}`);
      }
    }

    // ---- F01: a malformed promote now burns a presented live token.
    // The token issued before the migration is burned by its next malformed use.
    const preF01Again = await native('clued_candidate_promote_v1', promoteInput(preCandidate, preF01, { surprise: 1 }));
    assert.equal(preF01Again.error_code, 'candidate_promote_unknown_field');
    assert.equal((await candidateToken(preF01.token_id)).consume_outcome, 'rejected');
    for (const overrides of [{ surprise: 1 }, { user_confirmed: true }, { view_digest: 'Z' }, { base_version: 'x' },
      { tier: 'authority' }, { candidate_id: 'not-a-uuid' }]) {
      const label = JSON.stringify(overrides);
      const live = issued(await issueCandidate(preCandidate));
      const refused = await native('clued_candidate_promote_v1', promoteInput(preCandidate, live, overrides));
      assert.equal(refused.status, 'rejected', label);
      assert.match(refused.error_code, /^(candidate_promote_unknown_field|invalid_promote_input)$/, label);
      assert.equal(await receiptStatus(refused.receipt_id), 'rejected', label);
      const row = await candidateToken(live.token_id);
      assert.deepEqual([row.consume_outcome, row.consumed_receipt_id], ['rejected', refused.receipt_id], label);
      const retry = await native('clued_candidate_promote_v1', promoteInput(preCandidate, live));
      assert.deepEqual([retry.status, retry.error_code], ['rejected', 'confirmation_token_reused'], label);
      assert.equal(await candidateStatus(preCandidate), 'pending', label);
    }
    // A token string that is not a live token of this user burns nothing and
    // still reports the shape error.
    const unknownToken = await native('clued_candidate_promote_v1',
      promoteInput(preCandidate, { confirmation_token: `clued_cft_${hash()}`, view_digest: 'a'.repeat(64) }, { surprise: 1 }));
    assert.equal(unknownToken.error_code, 'candidate_promote_unknown_field');
    // A valid promotion still commits after the patch.
    const good = issued(await issueCandidate(preCandidate));
    const promoted = await native('clued_candidate_promote_v1', promoteInput(preCandidate, good));
    assert.equal(promoted.supplemental?.outcome, 'promoted', JSON.stringify(promoted));
    assert.equal((await candidateToken(good.token_id)).consume_outcome, 'promoted');

    // ---- L29: no token without a non-empty session_id claim; consume
    // requires a non-null token session equal to the JWT's.
    const [l29Candidate] = await submitCandidates(1);
    const l29Evidence = await ingestEvidence('l29');
    const tokensBefore = [await count('clued_private.candidate_confirmation_tokens'),
      await count('clued_private.native_confirmation_tokens')];
    for (const claim of [undefined, '', '   ', 7, null, { id: 'x' }]) {
      const label = `session_id=${JSON.stringify(claim)}`;
      const claims = noSession(userId, claim);
      for (const [name, result] of [
        ['S3', await issueCandidate(l29Candidate, claims)],
        ['S4', await issuePolicy('l29.policy', claims)],
        ['S5', await issueWithdrawal(l29Evidence, claims)]]) {
        assert.deepEqual([result.status, result.error_code, result.confirmation_token],
          ['rejected', 'confirmation_token_session_id_required', undefined], `${name} ${label}`);
      }
    }
    assert.deepEqual([await count('clued_private.candidate_confirmation_tokens'),
      await count('clued_private.native_confirmation_tokens')], tokensBefore, 'no token row was written');
    // The NULL-session token issued before the migration is never accepted,
    // not even by a JWT that also lacks session_id.
    const preL29Consume = await native('clued_candidate_promote_v1', promoteInput(preCandidateNull, preL29),
      noSession(userId));
    assert.deepEqual([preL29Consume.status, preL29Consume.error_code], ['rejected', 'confirmation_token_binding_mismatch']);
    assert.equal(await candidateStatus(preCandidateNull), 'pending');
    // A session-bound token cannot be consumed by a JWT without session_id.
    for (const [label, run] of [
      ['S3', async () => {
        const t = issued(await issueCandidate(l29Candidate));
        return [t, await native('clued_candidate_promote_v1', promoteInput(l29Candidate, t), noSession(userId)),
          candidateToken];
      }],
      ['S4', async () => {
        const t = issued(await issuePolicy('l29.policy'));
        return [t, await native('clued_context_policy_accept_v1', acceptInput('l29.policy', t), noSession(userId)),
          nativeToken];
      }],
      ['S5', async () => {
        const t = issued(await issueWithdrawal(l29Evidence));
        return [t, await native('clued_evidence_withdraw_v1', withdrawInput(l29Evidence, t), noSession(userId, '')),
          nativeToken];
      }]]) {
      const [t, result, row] = await run();
      assert.deepEqual([result.status, result.error_code], ['rejected', 'confirmation_token_binding_mismatch'], label);
      assert.equal((await row(t.token_id)).session_id, 'sess-main', label);
      assert.equal((await row(t.token_id)).consume_outcome, 'rejected', label);
    }

    // ---- L30: a token for one Native action is invisible to the other.
    const l30Evidence = await ingestEvidence('l30');
    const s4Token = issued(await issuePolicy('l30.policy'));
    const s5Token = issued(await issueWithdrawal(l30Evidence));
    const s4ToS5 = await native('clued_evidence_withdraw_v1', withdrawInput(l30Evidence, s4Token));
    assert.deepEqual([s4ToS5.status, s4ToS5.error_code], ['rejected', 'confirmation_token_invalid']);
    const s5ToS4 = await native('clued_context_policy_accept_v1', acceptInput('l30.policy', s5Token));
    assert.deepEqual([s5ToS4.status, s5ToS4.error_code], ['rejected', 'confirmation_token_invalid']);
    // Also with a malformed body (the pre-lookup path).
    const s4ToS5Shape = await native('clued_evidence_withdraw_v1', withdrawInput(l30Evidence, s4Token, { surprise: 1 }));
    assert.equal(s4ToS5Shape.error_code, 'evidence_withdraw_unknown_field');
    const s5ToS4Shape = await native('clued_context_policy_accept_v1', acceptInput('l30.policy', s5Token, { surprise: 1 }));
    assert.equal(s5ToS4Shape.error_code, 'context_policy_accept_unknown_field');
    for (const t of [s4Token, s5Token]) {
      const row = await nativeToken(t.token_id);
      assert.deepEqual([row.consumed_at, row.revoked_at], [null, null], 'the other action burned nothing');
    }
    // Both tokens still work for their own action.
    const accepted = await native('clued_context_policy_accept_v1', acceptInput('l30.policy', s4Token));
    assert.equal(accepted.status, 'committed', JSON.stringify(accepted));
    const withdrawn = await native('clued_evidence_withdraw_v1', withdrawInput(l30Evidence, s5Token));
    assert.equal(withdrawn.status, 'committed', JSON.stringify(withdrawn));
    assert.equal((await nativeToken(s4Token.token_id)).consume_outcome, 'committed');
    assert.equal((await nativeToken(s5Token.token_id)).consume_outcome, 'committed');
    // ---- Cross-user: another user presenting A's live tokens (malformed and
    // well-formed) to S3, S4 and S5 cannot see or burn them; A still consumes them.
    const [crossCandidate] = await submitCandidates(1);
    const crossEvidence = await ingestEvidence('cross-user');
    const aS3 = issued(await issueCandidate(crossCandidate));
    const aS4 = issued(await issuePolicy('cross.policy'));
    const aS5 = issued(await issueWithdrawal(crossEvidence));
    const B = fresh(otherUser, 'sess-b');
    for (const [label, name, input, code] of [
      ['S3 malformed', 'clued_candidate_promote_v1', promoteInput(crossCandidate, aS3, { surprise: 1 }),
        'candidate_promote_unknown_field'],
      ['S3', 'clued_candidate_promote_v1', promoteInput(crossCandidate, aS3), 'confirmation_token_invalid'],
      ['S4 malformed', 'clued_context_policy_accept_v1', acceptInput('cross.policy', aS4, { surprise: 1 }),
        'context_policy_accept_unknown_field'],
      ['S4', 'clued_context_policy_accept_v1', acceptInput('cross.policy', aS4), 'confirmation_token_invalid'],
      ['S5 malformed', 'clued_evidence_withdraw_v1', withdrawInput(crossEvidence, aS5, { surprise: 1 }),
        'evidence_withdraw_unknown_field'],
      ['S5', 'clued_evidence_withdraw_v1', withdrawInput(crossEvidence, aS5), 'confirmation_token_invalid']]) {
      const refused = await native(name, input, B);
      assert.deepEqual([refused.status, refused.error_code], ['rejected', code], label);
    }
    assert.deepEqual([(await candidateToken(aS3.token_id)).consumed_at, (await nativeToken(aS4.token_id)).consumed_at,
      (await nativeToken(aS5.token_id)).consumed_at], [null, null, null], 'A\'s tokens stay live');
    const aPromoted = await native('clued_candidate_promote_v1', promoteInput(crossCandidate, aS3));
    assert.equal(aPromoted.supplemental?.outcome, 'promoted', JSON.stringify(aPromoted));
    const aAccepted = await native('clued_context_policy_accept_v1', acceptInput('cross.policy', aS4));
    assert.equal(aAccepted.status, 'committed', JSON.stringify(aAccepted));
    const aWithdrawn = await native('clued_evidence_withdraw_v1', withdrawInput(crossEvidence, aS5));
    assert.equal(aWithdrawn.status, 'committed', JSON.stringify(aWithdrawn));

    // A same-action token presented for another subject is still a burned
    // binding mismatch (single use, as S3 does for another candidate).
    const [evA, evB] = [await ingestEvidence('l30-a'), await ingestEvidence('l30-b')];
    const forA = issued(await issueWithdrawal(evA));
    const wrongSubject = await native('clued_evidence_withdraw_v1', withdrawInput(evB, forA));
    assert.equal(wrongSubject.error_code, 'confirmation_token_binding_mismatch');
    assert.equal((await nativeToken(forA.token_id)).consume_outcome, 'rejected');
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
    await removeTestDirectory(directory).catch(() => {});
  }
});
