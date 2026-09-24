// E2E-02: an Agent-captured candidate cannot be promoted by the Binding;
// token single use, binding, foreign session and real-clock expiry; a later
// Native confirmation succeeds.
import { issueCandidate, item, key, promoteCandidate, submitAgent } from './common.mjs';

export const id = 'E2E-02';
export const TTL_WAIT_MS = 301 * 1000;

const receiptsSql = 'select count(*)::int n from public.clued_audit_receipts where user_id=$1';

async function status(r, U, scope, candidateId) {
  const listed = await r.rest(U, 'GET', `/v1/intake?scope=${encodeURIComponent(scope)}&limit=200`, undefined, {
    extract: (b) => ({ status: b?.candidates?.find((c) => c.id === candidateId)?.status ?? null }) });
  return listed.body?.candidates?.find((c) => c.id === candidateId)?.status ?? null;
}

export async function run(ctx, r) {
  const { U, V, B_main: B, projects } = ctx;
  const scope = projects.p02;
  r.alias('P02', scope.slice(8));
  const submitted = await submitAgent(r, B, scope, 'seg_s6_e02', [item('e02', 'fact'), item('e02_parked', 'fact'),
    item('e02_other', 'fact')]);
  const c2 = r.alias('C2', submitted.ids.item_e02);
  const parkedCandidate = r.alias('C2_PARKED', submitted.ids.item_e02_parked);
  const other = r.alias('C2_OTHER', submitted.ids.item_e02_other);

  // Park T1 now: presented after the real 5-minute TTL has passed.
  const parkSession = await U.current(0);
  const t1 = await issueCandidate(r, U, 'information', parkedCandidate, {}, { session: parkSession });
  const t1IssuedAt = Date.now();
  r.check('02.t1_issued', 'T1 is issued for the parked candidate', 'issued', t1.body?.status);

  // (i) and (ii): the Binding bearer on the Native promote route.
  for (const [tag, body] of [
    ['i', { idempotency_key: key('e02i'), base_version: 1, authority: 'user_explicit', user_confirmed: true }],
    ['ii', { idempotency_key: key('e02ii'), base_version: 1, record_type: 'note', authority: 'observed',
      note: 'Promote me please' }]]) {
    const refused = await r.rest(null, 'POST', `/v1/intake/${c2}/promote`, body, { bearer: B.raw,
      extract: (b) => ({ error: b?.error ?? null }) });
    r.check(`02.${tag}.status`, `(${tag}) the Binding is refused at Worker authentication`, 401, refused.status);
    r.check(`02.${tag}.no_rpc`, `(${tag}) no request left the Worker (no RPC ran)`, [], refused.ledger);
    r.check(`02.${tag}.logged`, `(${tag}) the refusal is logged`, true, refused.logs.some((line) =>
      line.includes('information_flow_native_route_denied') && line.includes('binding_or_missing_token')));
    r.check(`02.${tag}.pending`, `(${tag}) the candidate stays pending`, 'pending', await status(r, U, scope, c2));
  }
  // The Binding cannot reach step 1 or reject either.
  for (const action of ['confirmation', 'reject']) {
    const refused = await r.rest(null, 'POST', `/v1/intake/${c2}/${action}`, { base_version: 1,
      ...(action === 'reject' ? { idempotency_key: key('e02rej') } : { authority: 'user_explicit' }) }, { bearer: B.raw });
    r.check(`02.binding_${action}`, `the Binding is refused on /${action} before any RPC`, [401, []],
      [refused.status, refused.ledger]);
  }

  // (iii) Direct PostgREST call as the Binding-callable role (apikey only).
  const receiptsBefore = (await r.observe('receipt count', receiptsSql, [U.userId]))[0].n;
  const direct = await r.postgrest('anon_apikey', 'clued_candidate_promote_v1', { p_input: { idempotency_key: key('e02iii'),
    tier: 'information', candidate_id: c2, base_version: 1 }, p_received_payload_hash: 'a'.repeat(64) },
  { extract: (b) => ({ code: b?.code ?? null }) });
  r.check('02.iii.status', '(iii) a direct Binding-role call is a permission error', [401, '42501'],
    [direct.status, direct.body?.code]);
  const receiptsAfter = (await r.observe('receipt count', receiptsSql, [U.userId]))[0].n;
  r.check('02.iii.no_receipt', '(iii) no Receipt was written', receiptsBefore, receiptsAfter);
  r.check('02.iii.pending', '(iii) the candidate stays pending', 'pending', await status(r, U, scope, c2));

  // MCP exposes no promotion, confirmation or reject tool.
  const tools = await r.mcp(B, 'tools/list', {}, { extract: (b) => ({ count: b?.result?.tools?.length }) });
  const names = (tools.body?.result?.tools ?? []).map((tool) => tool.name);
  r.check('02.no_promotion_tool', 'tools/list has no promotion-like tool', [],
    names.filter((name) => /promot|confirm|reject/.test(name)));
  const unknown = await r.tool(B, 'clued_candidate_promote_v1', {}, { extract: (b) => ({ code: b?.code ?? null }) });
  r.check('02.unknown_tool', 'calling a promotion tool name over MCP fails', 404, unknown.status);

  // Single use: T2 presented once with a wrong view digest (burned), then replayed.
  const t2 = await issueCandidate(r, U, 'information', c2);
  const burn = await promoteCandidate(r, U, 'information', c2, t2.body ?? {}, { view_digest: 'b'.repeat(64) });
  r.check('02.t2_first_use', 'T2 first use with a mismatched view digest is rejected and burns the token',
    [403, 'confirmation_token_binding_mismatch'], [burn.status, burn.body?.error_code]);
  const replay = await promoteCandidate(r, U, 'information', c2, t2.body ?? {});
  r.check('02.t2_replay', 'replaying T2 is rejected as reused', [403, 'confirmation_token_reused'],
    [replay.status, replay.body?.error_code]);
  // Foreign session: V presents U's token for U's candidate.
  const t3 = await issueCandidate(r, U, 'information', c2);
  const foreign = await promoteCandidate(r, V, 'information', c2, t3.body ?? {});
  r.check('02.foreign', 'a foreign account presenting the owner\'s token is rejected', true,
    [403, 422].includes(foreign.status) && foreign.body?.status === 'rejected');
  r.note(`E2E-02 foreign presentation error_code=${foreign.body?.error_code ?? foreign.body?.error}`);
  // Token issued for another candidate.
  const tOther = await issueCandidate(r, U, 'information', other);
  const wrong = await promoteCandidate(r, U, 'information', c2, tOther.body ?? {});
  r.check('02.other_candidate', 'a token issued for another candidate is rejected',
    [403, 'confirmation_token_binding_mismatch'], [wrong.status, wrong.body?.error_code]);
  r.check('02.pending_after_negatives', 'the candidate is still pending after every negative', 'pending',
    await status(r, U, scope, c2));
  r.check('02.same_request', 'issue and consume in one request', 'structurally_impossible_over_transport',
    'structurally_impossible_over_transport');
  r.note('Issue+consume in one request cannot be expressed over HTTP (one PostgREST transaction per request); '
    + 'covered at DB level by tests/information-flow-promotion-db.test.mjs (confirmation_token_same_request).');

  return {
    deferred: {
      dueAt: t1IssuedAt + TTL_WAIT_MS,
      run: async () => {
        const waited = Date.now() - t1IssuedAt;
        r.check('02.ttl_waited', 'at least 301 s of real clock passed since T1 was issued', true, waited >= TTL_WAIT_MS);
        const expired = await promoteCandidate(r, U, 'information', parkedCandidate, t1.body ?? {}, {},
          { session: parkSession });
        r.check('02.expired', 'the expired token is rejected', [403, 'confirmation_token_expired'],
          [expired.status, expired.body?.error_code]);
        r.check('02.expired_receipt', 'the rejection carries a Receipt', true, typeof expired.body?.receipt_id === 'string');
        r.check('02.parked_pending', 'the parked candidate stays pending', 'pending',
          await status(r, U, scope, parkedCandidate));
        const fresh = await issueCandidate(r, U, 'information', c2);
        const promoted = await promoteCandidate(r, U, 'information', c2, fresh.body ?? {});
        r.check('02.final_promoted', 'a later Native confirmation promotes the candidate', [200, 'promoted'],
          [promoted.status, promoted.body?.supplemental?.outcome]);
        r.alias('R2', fresh.body?.record_id);
        r.check('02.final_status', 'the candidate reads promoted', 'promoted', await status(r, U, scope, c2));
      },
    },
  };
}
