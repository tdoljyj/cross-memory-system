// Shared synthetic inputs and transport helpers for the S6 scenarios.
// Synthetic text only (plan section 3): never real user data.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../evidence.mjs';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
export const vendored = path.join(repoRoot, 'development/contracts/information-flow/vendored');
export const uuid = () => crypto.randomUUID();

export const TOKENIZER = { package: 'js-tiktoken', version: '1.0.21', encoding: 'o200k_base',
  model_mapping: 'gpt-4.1-2025-04-14' };
export const ALL_TIERS = ['authority_information', 'authority_knowledge', 'candidate_information', 'candidate_knowledge'];
export const TEXT = 'Synthetic S6 harness fixture: the Qingshi risk list was confirmed by the owner.';

let counter = 0;
export const key = (label) => `if-s6-${label}-${String(++counter).padStart(4, '0')}`;

export const segment = (segmentId, text = TEXT) => ({
  schema_version: 'segment_input.v1', segment_id: segmentId,
  reference_time: '2026-09-24T10:00:00+08:00', timezone: 'Asia/Shanghai',
  messages: [{ message_id: 'msg_s6_a', evidence_id: 'ev_s6_a', author_role: 'user',
    created_at: '2026-09-24T09:58:00+08:00', context_only: false, content: text }],
});

export const item = (local, itemType, text = TEXT) => ({
  candidate_local_id: `item_${local}`, item_type: itemType,
  claim: `${itemType} claim ${local}: ${text}`.slice(0, 300), summary: `${itemType} summary ${local}`.slice(0, 120),
  action_level: 'reference', priority: null,
  entity_mentions: [{ type: 'project', mention: 'Qingshi', role: 'subject' }], topics: ['risk'],
  temporal_mentions: [], source_anchors: [{ message_id: 'msg_s6_a', exact_quote: 'risk list was confirmed' }],
  confidence: 0.9, uncertainties: [], sensitivity_hint: 'none',
});

export const documentOf = (segmentId, items) => ({ schema_version: 'candidate_information.v1', segment_id: segmentId,
  items });

export const policyDoc = (taskClass, scopes, overrides = {}) => ({
  schema: 'clued.context-policy.v1', task_class: taskClass, allowed_scopes: scopes,
  allowed_record_types: ['decision', 'note', 'profile_fact', 'state', 'task'], require_evidence: false,
  fields: { required: ['title'], optional: ['content', 'rationale'] }, max_items: 50, token_budget: 32768,
  tokenizer: TOKENIZER, freshness: { mode: 'current' }, ...overrides,
});

export const noteInput = (id, title, { scope = 'global', content = title, sources = [], authority = 'user_explicit',
  extra = {} } = {}) => ({
  operation: 'create', id, record_type: 'note', record_schema_version: 1, lifecycle_status: 'active', scope,
  idempotency_key: key('note'), authority, user_confirmed: true, confidence: 1,
  confidence_reason: 'S6 synthetic fixture', source_refs: sources,
  source_unavailable_reason: sources.length ? null : 'Synthetic fixture',
  mutation: { title, content, type_fields: { note_kind: 'general' }, relations: {} }, ...extra,
});

export const updateInput = (id, scope, base, mutation, extra = {}) => ({ operation: 'update', id, record_type: 'note',
  record_schema_version: 1, lifecycle_status: 'active', scope, idempotency_key: key('upd'), authority: 'user_explicit',
  confidence: 1, confidence_reason: 'S6 synthetic fixture', base_version: base, mutation, ...extra });

export function readFixture(...parts) {
  return JSON.parse(fs.readFileSync(path.join(vendored, ...parts), 'utf8'));
}

// ---- Transport helpers (every call is a recorded step).

export async function nativeNote(r, U, title, options = {}) {
  const id = uuid();
  const written = await r.rest(U, 'POST', '/v1/records', noteInput(id, title, options),
    { extract: (b) => ({ status: b?.status, replayed: b?.replayed }) });
  if (written.body?.status !== 'committed') throw new Error(`nativeNote failed: ${JSON.stringify(written.body)}`);
  return id;
}

export async function submitNative(r, U, scope, segmentId, items, extra = {}) {
  const res = await r.rest(U, 'POST', '/v1/intake', { idempotency_key: key('sub'), scope, segment: segment(segmentId),
    candidates: documentOf(segmentId, items), ...extra }, { extract: submitExtract });
  if (res.body?.status !== 'committed') throw new Error(`submitNative failed: ${JSON.stringify(res.body)}`);
  return submitted(res);
}

export async function submitAgent(r, B, scope, segmentId, items) {
  const res = await r.tool(B, 'clued_intake_submit', { idempotency_key: key('asub'), scope, segment: segment(segmentId),
    candidates: documentOf(segmentId, items) }, { extract: submitExtract });
  if (res.structured?.status !== 'committed') throw new Error(`submitAgent failed: ${JSON.stringify(res.structured)}`);
  return submitted({ ...res, body: res.structured });
}

export function submitExtract(b) {
  return { status: b?.status, replayed: b?.replayed, error_code: b?.error_code ?? null,
    candidates: b?.supplemental?.candidates?.map((c) => ({ local: c.candidate_local_id, status: c.status,
      version: c.version })) ?? null };
}

function submitted(res) {
  const body = res.body;
  const ids = Object.fromEntries(body.supplemental.candidates.map((c) => [c.candidate_local_id, c.id]));
  return { ids, submissionId: body.supplemental.submission_id, segmentSha256: body.supplemental.segment_sha256,
    evidenceId: body.evidence_ids?.[0], receiptId: body.receipt_id, body };
}

export async function issueCandidate(r, U, tier, id, input = {}, options = {}) {
  const route = tier === 'knowledge' ? '/v1/knowledge/candidates' : '/v1/intake';
  return r.rest(U, 'POST', `${route}/${id}/confirmation`, { base_version: 1, authority: 'user_explicit', ...input }, {
    ...options, extract: (b) => ({ status: b?.status, error_code: b?.error_code ?? null,
      record_type: b?.confirmation_view?.record_type ?? null, authority: b?.confirmation_view?.authority ?? null }) });
}

export async function promoteCandidate(r, U, tier, id, issued, overrides = {}, options = {}) {
  const route = tier === 'knowledge' ? '/v1/knowledge/candidates' : '/v1/intake';
  return r.rest(U, 'POST', `${route}/${id}/promote`, { idempotency_key: key('promo'), base_version: 1,
    confirmation_token: issued.confirmation_token, view_digest: issued.view_digest, ...overrides }, {
    ...options, extract: (b) => ({ status: b?.status, error_code: b?.error_code ?? null, replayed: b?.replayed ?? null,
      outcome: b?.supplemental?.outcome ?? null, record_version: b?.supplemental?.record_version ?? null }) });
}

export async function promote(r, U, tier, id, input = {}) {
  const issued = await issueCandidate(r, U, tier, id, input);
  if (issued.body?.status !== 'issued') throw new Error(`issue failed: ${JSON.stringify(issued.body)}`);
  const promoted = await promoteCandidate(r, U, tier, id, issued.body);
  if (promoted.body?.supplemental?.outcome !== 'promoted') {
    throw new Error(`promote failed: ${JSON.stringify(promoted.body)}`);
  }
  return { recordId: issued.body.record_id, issued: issued.body, promoted: promoted.body };
}

export async function acceptPolicy(r, U, doc, base = 0) {
  const issued = await r.rest(U, 'POST', '/v1/context/policies/confirmation', { policy: doc,
    rationale: 'Owner accepts (S6 synthetic)', base_policy_version: base },
  { extract: (b) => ({ status: b?.status, task_class: b?.task_class, error_code: b?.error_code ?? null }) });
  if (issued.body?.status !== 'issued') throw new Error(`policy issue failed: ${JSON.stringify(issued.body)}`);
  const accepted = await r.rest(U, 'POST', '/v1/context/policies', { idempotency_key: key('acc'),
    task_class: issued.body.task_class, base_policy_version: base, confirmation_token: issued.body.confirmation_token,
    view_digest: issued.body.view_digest }, { extract: (b) => ({ status: b?.status, error_code: b?.error_code ?? null }) });
  if (accepted.body?.status !== 'committed') throw new Error(`policy accept failed: ${JSON.stringify(accepted.body)}`);
  return { policyId: accepted.body.supplemental.policy_id, issued: issued.body, accepted: accepted.body };
}

export const packExtract = (b) => ({ status: b?.status, error_code: b?.error_code ?? null, reason: b?.reason ?? null,
  revalidation: b?.revalidation ?? null, items: b?.pack?.items?.map((row) => ({ id: row.canonical_id,
    version: row.version, tier: row.tier, labels: row.labels, human_confirmed: row.human_confirmed })) ?? null,
  authoritative: b?.pack?.authoritative ?? null, manifest_reused: b?.manifest?.reused ?? null,
  model_extraction: b?.pack?.model_extraction ?? null, execution_authorization: b?.pack?.execution_authorization ?? null,
  measurement_status: b?.measurement?.status ?? null });

export async function packMcp(r, B, args) {
  const res = await r.tool(B, 'clued_context_pack', args, { extract: packExtract });
  return res.structured;
}

export async function packRest(r, U, args, options = {}) {
  const res = await r.rest(U, 'POST', '/v1/context/pack', args, { ...options, extract: packExtract });
  return { status: res.status, body: res.body };
}

export function checkPack(r, id, pack) {
  const ok = pack?.status === 'ok' && typeof pack.pack_text === 'string';
  r.check(`${id}.pack_ok`, 'the compile returns a pack', 'ok', pack?.status);
  if (!ok) return false;
  r.check(`${id}.digest_binds_text`, 'sha256(pack_text) equals pack_digest', true, sha256(pack.pack_text) === pack.pack_digest);
  return true;
}

export const ids = (pack) => (pack?.pack?.items ?? []).map((row) => row.canonical_id).sort();

// Canonical/MTPE/projection/currentness/carrier snapshot (read-only observer).
export const canonicalSnapshotSql = `select
  (select count(*)::int from public.clued_memories where user_id=$1) memories,
  (select coalesce(sum(version),0)::int from public.clued_memories where user_id=$1) record_versions,
  (select count(*)::int from clued_private.mtpe_intake_projection where user_id=$1) mtpe,
  (select md5(coalesce(string_agg(to_jsonb(h)::text,',' order by to_jsonb(h)::text),'')) from clued_private.mtpe_intake_projection h where h.user_id=$1) mtpe_digest,
  (select coalesce(sum(invalidation_revision),0)::int from clued_private.projection_invalidation_heads where user_id=$1) projection_inv,
  (select coalesce(sum(snapshot_revision),0)::int from clued_private.scope_currentness_heads where user_id=$1) currentness,
  (select count(*)::int from clued_private.event_truth_carriers where user_id=$1) carriers`;
