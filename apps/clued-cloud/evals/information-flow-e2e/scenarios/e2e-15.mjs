// E2E-15: direct PostgREST calls to clued_candidate_promote_v1 with the
// owner's real GoTrue JWT: no token, an expired token (real clock), a reused
// token, and observed promotion with caller-asserted Evidence. Each is
// rejected by the RPC with a rejected Receipt; the candidate stays pending.
import { item, issueCandidate, key, submitNative } from './common.mjs';
import { sha256 } from '../evidence.mjs';
import { TTL_WAIT_MS } from './e2e-02.mjs';

export const id = 'E2E-15';

export async function run(ctx, r) {
  const { U, projects } = ctx;
  const scope = projects.p15;
  r.alias('P15', scope.slice(8));
  const sub = await submitNative(r, U, scope, 'seg_s6_e15', [item('a', 'fact'), item('parked', 'fact'), item('b', 'fact')]);
  const ca = r.alias('C15A', sub.ids.item_a);
  const cp = r.alias('C15P', sub.ids.item_parked);
  const cb = r.alias('C15B', sub.ids.item_b);
  const parkSession = await U.current(0);
  const parked = await issueCandidate(r, U, 'information', cp, {}, { session: parkSession });
  const parkedAt = Date.now();
  r.check('15.parked_issued', 'T1\' is issued and parked', 'issued', parked.body?.status);

  const statusOf = async (cid) => {
    const listed = await r.rest(U, 'GET', `/v1/intake?scope=${encodeURIComponent(scope)}`, undefined,
      { extract: (b) => ({ count: b?.candidates?.length }) });
    return listed.body?.candidates?.find((c) => c.id === cid)?.status ?? null;
  };
  const direct = async (tag, input, options = {}) => {
    const res = await r.postgrest('owner_jwt', 'clued_candidate_promote_v1', { p_input: input,
      p_received_payload_hash: sha256(JSON.stringify(input)) }, { ...options,
      extract: (b) => ({ status: b?.status, error_code: b?.error_code ?? null }) });
    const receipt = await r.observe('Receipt status', 'select status from public.clued_audit_receipts where id=$1',
      [res.body?.receipt_id ?? '00000000-0000-0000-0000-000000000000']);
    r.check(`15.${tag}.receipt`, `${tag}: rejected with a rejected Receipt`, ['rejected', ['rejected']],
      [res.body?.status, receipt.map((row) => row.status)]);
    return res.body?.error_code ?? null;
  };
  const base = (cid, extra = {}) => ({ idempotency_key: key('e15'), tier: 'information', candidate_id: cid, base_version: 1,
    ...extra });

  // (a) no token.
  r.check('15.a.code', '(a) no token: confirmation_token_required', 'confirmation_token_required',
    await direct('a', base(ca, { view_digest: 'a'.repeat(64) })));
  r.check('15.a.pending', '(a) the candidate stays pending', 'pending', await statusOf(ca));
  // (c) reused token: the first presentation burns it, the second is reused.
  const once = await issueCandidate(r, U, 'information', ca);
  r.check('15.c.first', '(c) first presentation with a wrong digest burns the token', 'confirmation_token_binding_mismatch',
    await direct('c_first', base(ca, { confirmation_token: once.body?.confirmation_token, view_digest: 'b'.repeat(64) })));
  r.check('15.c.code', '(c) reused token: confirmation_token_reused', 'confirmation_token_reused',
    await direct('c', base(ca, { confirmation_token: once.body?.confirmation_token, view_digest: once.body?.view_digest })));
  r.check('15.c.pending', '(c) the candidate stays pending', 'pending', await statusOf(ca));
  // (d) caller-asserted Evidence on either step.
  const live = await issueCandidate(r, U, 'information', ca, { authority: 'observed' });
  for (const field of ['evidence_ids', 'source_refs']) {
    r.check(`15.d.promote_${field}`, `(d) a promote body carrying ${field} is refused`, 'candidate_promote_unknown_field',
      await direct(`d_${field}`, base(ca, { confirmation_token: live.body?.confirmation_token,
        view_digest: live.body?.view_digest, [field]: [sub.evidenceId] })));
  }
  for (const field of ['evidence_ids', 'source_refs']) {
    const refused = await r.postgrest('owner_jwt', 'clued_candidate_confirmation_issue_v1', { p_input: { tier: 'information',
      candidate_id: ca, base_version: 1, authority: 'observed', [field]: [sub.evidenceId] } },
    { extract: (b) => ({ status: b?.status, error_code: b?.error_code ?? null }) });
    r.check(`15.d.confirm_${field}`, `(d) a confirmation body carrying ${field} is refused`,
      ['rejected', 'candidate_confirmation_unknown_field'], [refused.body?.status, refused.body?.error_code]);
  }
  // (d) defence in depth: the candidate row is re-pointed (fixture) at a
  // caller-hash Evidence from /v1/evidence; observed promotion is refused.
  const asserted = await r.rest(U, 'POST', '/v1/evidence', { idempotency_key: key('e15ev'), evidence_schema_version: 1,
    evidence_type: 'file', storage_ref: `intake:${sub.submissionId}`, content_hash: sub.segmentSha256,
    mime_type: 'application/json', size_bytes: 1 }, { extract: (b) => ({ status: b?.status }) });
  const assertedId = r.alias('E_ASSERTED', asserted.body?.evidence_ids?.[0]);
  const repointed = await r.fixture('re-point candidate evidence_ids to a caller-hash Evidence (defence-in-depth setup)',
    (f) => f.repointCandidateEvidence(cb, assertedId));
  r.check('15.d.repointed', '(d) fixture re-point applied', 1, repointed);
  const observedIssue = await issueCandidate(r, U, 'information', cb, { authority: 'observed' });
  r.check('15.d.observed', '(d) observed with caller-asserted Evidence is refused',
    ['rejected', 'observed_requires_server_computed_evidence'], [observedIssue.body?.status, observedIssue.body?.error_code]);
  r.check('15.d.pending', '(d) the candidates stay pending', ['pending', 'pending'], [await statusOf(ca), await statusOf(cb)]);

  return {
    deferred: {
      dueAt: parkedAt + TTL_WAIT_MS,
      run: async () => {
        r.check('15.b.waited', '(b) at least 301 s of real clock passed since T1\' was issued', true,
          Date.now() - parkedAt >= TTL_WAIT_MS);
        r.check('15.b.code', '(b) expired token: confirmation_token_expired', 'confirmation_token_expired',
          await direct('b', base(cp, { confirmation_token: parked.body?.confirmation_token,
            view_digest: parked.body?.view_digest }), { session: parkSession }));
        r.check('15.b.pending', '(b) the parked candidate stays pending', 'pending', await statusOf(cp));
      },
    },
  };
}
