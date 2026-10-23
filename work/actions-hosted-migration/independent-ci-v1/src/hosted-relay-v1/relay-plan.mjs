// The per-role result of stage R as it crosses from the relay entry (clued-control) to the resident
// executor (free-minutes design S19, §7.3): the entry outcome record carries these rows, the stage fact
// copies them, and the resident writes them create-only into 25-plan. Pure; no I/O.
//
// One row per relay candidate, in the candidates' order:
//   { role, outcome, reason, receipt, checkRunId, externalId, attestationSha256, detail }
//   outcome RELAYED         -> App 5368905 published the required check from a verified hosted run
//                              (receipt relay-attested, checkRunId, externalId, attestationSha256 set);
//           LOCAL_REQUIRED  -> nothing was published for the role and K(head, role) is not held by the
//                              relay; reason is one of LOCAL_REASONS (receipt relay-local-fallback or
//                              relay-billing-refused);
//           HALT            -> RELAY_PUBLICATION_UNCERTAIN or ROLE_ALREADY_PUBLISHED_ON_HEAD; the role is
//                              never run locally afterwards (the executor HALTs);
//           ON_GITHUB       -> ROLE_ALREADY_ON_GITHUB: App 5368905 already published the role's check on the head and
//                              this node knows nothing of it (another node or install; primary/standby design v0.4
//                              §6.2, C4). Nothing was sent; the executor ends the batch cleanly and runs no local role;
//           NOT_PROCESSED   -> a later relayable role after a HALT (also HALT for the executor) or after ON_GITHUB.
// A plan the executor acts on (relayPlanEnding): every row RELAYED or LOCAL_REQUIRED (COMPLETE), or such rows, then one
// ON_GITHUB row, then only NOT_PROCESSED rows or never-relayable LOCAL_REQUIRED rows (ON_GITHUB).
import { LOCAL_REASONS, RELAY_CODES } from './stage.mjs';

export const RELAY_PLAN_ROW_FIELDS = Object.freeze(['role', 'outcome', 'reason', 'receipt', 'checkRunId', 'externalId', 'attestationSha256', 'detail']);
export const RELAY_OUTCOMES = Object.freeze(['RELAYED', 'LOCAL_REQUIRED', 'ON_GITHUB', 'HALT', 'NOT_PROCESSED']);
export const RELAY_RECEIPTS = Object.freeze(['relay-attested', 'relay-billing-refused', 'relay-local-fallback']);
export const RELAY_HALT_CODES = Object.freeze([RELAY_CODES.PUBLICATION_UNCERTAIN, RELAY_CODES.ROLE_ALREADY_PUBLISHED_ON_HEAD]);
const ROLES = ['gitleaks', 'trivy', 'contract-placement'];
const SHA256 = /^[a-f0-9]{64}$/;
const DETAIL = /^[A-Za-z0-9_:.-]{1,160}$/;
const EXTERNAL = /^independent-ci:relay:(gitleaks|trivy):[a-f0-9]{12}:run[1-9][0-9]{0,19}:a[1-9][0-9]{0,3}$/;
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

// Stage result row (stage.mjs) -> plan row. Anything that does not fit is HALT (fail closed).
export function planRowOf(row) {
  const detail = typeof row?.detail === 'string' && DETAIL.test(row.detail) ? row.detail : null;
  const base = { role: ROLES.includes(row?.role) ? row.role : 'unknown', outcome: 'HALT', reason: RELAY_CODES.PUBLICATION_UNCERTAIN, receipt: null,
    checkRunId: null, externalId: null, attestationSha256: null, detail };
  if (!plain(row) || !ROLES.includes(row.role)) return base;
  if (row.outcome === 'RELAYED' && Number.isSafeInteger(row.checkRunId) && row.checkRunId > 0 && EXTERNAL.test(row.externalId ?? '')
    && SHA256.test(row.attestationSha256 ?? '') && row.receipt === 'relay-attested')
    return { ...base, outcome: 'RELAYED', reason: null, receipt: 'relay-attested', checkRunId: row.checkRunId, externalId: row.externalId, attestationSha256: row.attestationSha256 };
  if (row.outcome === 'LOCAL_REQUIRED' && LOCAL_REASONS.includes(row.reason) && ['relay-local-fallback', 'relay-billing-refused'].includes(row.receipt))
    return { ...base, outcome: 'LOCAL_REQUIRED', reason: row.reason, receipt: row.receipt };
  if (row.outcome === 'ON_GITHUB' && row.reason === RELAY_CODES.ROLE_ALREADY_ON_GITHUB) return { ...base, outcome: 'ON_GITHUB', reason: RELAY_CODES.ROLE_ALREADY_ON_GITHUB };
  if (row.outcome === 'HALT' && RELAY_HALT_CODES.includes(row.reason)) return { ...base, reason: row.reason };
  if (row.outcome === 'NOT_PROCESSED') return { ...base, outcome: 'NOT_PROCESSED', reason: null };
  return base;
}

// The ending of a plan the executor acts on: 'COMPLETE', 'ON_GITHUB' (see above), or null for anything else.
export function relayPlanEnding(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const at = rows.findIndex(r => r?.outcome === 'ON_GITHUB');
  const clean = r => ['RELAYED', 'LOCAL_REQUIRED'].includes(r?.outcome);
  if (at < 0) return rows.every(clean) ? 'COMPLETE' : null;
  return rows.slice(0, at).every(clean) && rows.slice(at + 1).every(r => r?.outcome === 'NOT_PROCESSED'
    || (r?.outcome === 'LOCAL_REQUIRED' && r.reason === 'RELAY_ROLE_NOT_RELAYABLE')) ? 'ON_GITHUB' : null;
}

// Strict check of plan rows read back from an outcome record or a stage fact. Returns a frozen copy or null.
export function validateRelayPlanRows(rows, candidates = null) {
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > ROLES.length) return null;
  const seen = new Set();
  for (const row of rows) {
    if (!plain(row) || Object.keys(row).length !== RELAY_PLAN_ROW_FIELDS.length || !RELAY_PLAN_ROW_FIELDS.every(k => Object.hasOwn(row, k))) return null;
    if (!ROLES.includes(row.role) || seen.has(row.role) || !RELAY_OUTCOMES.includes(row.outcome)) return null;
    seen.add(row.role);
    if (!(row.detail === null || (typeof row.detail === 'string' && DETAIL.test(row.detail)))) return null;
    const again = planRowOf({ ...row });
    if (again.outcome !== row.outcome || again.reason !== row.reason || again.receipt !== row.receipt || again.checkRunId !== row.checkRunId
      || again.externalId !== row.externalId || again.attestationSha256 !== row.attestationSha256) return null;
  }
  if (candidates !== null && (candidates.length !== rows.length || candidates.some((role, i) => rows[i].role !== role))) return null;
  return Object.freeze(rows.map(r => Object.freeze({ ...r })));
}

// Stage result (stage.mjs#run) -> entry result for runEntry/writeOutcome (stage-fact.mjs reads it back).
//   COMPLETE -> RELAY_COMPLETE (success); ON_GITHUB -> RELAY_COMPLETE with reason ROLE_ALREADY_ON_GITHUB (the rows say
//   which role; the executor ends the batch cleanly); HALT -> UNCERTAIN with the halt code; REFUSED -> BLOCKED, nothing done.
export function entryResultOf(stageResult) {
  const sideEffects = Number.isSafeInteger(stageResult?.sideEffects) && stageResult.sideEffects >= 0 ? stageResult.sideEffects : 1;
  const relay = Array.isArray(stageResult?.roles) ? stageResult.roles.map(planRowOf) : [];
  if (stageResult?.status === 'COMPLETE' && (stageResult.code ?? null) === null && relayPlanEnding(relay) === 'COMPLETE')
    return { status: 'RELAY_COMPLETE', reason: null, sideEffects, relay };
  if (stageResult?.status === 'ON_GITHUB' && stageResult.code === RELAY_CODES.ROLE_ALREADY_ON_GITHUB && relayPlanEnding(relay) === 'ON_GITHUB')
    return { status: 'RELAY_COMPLETE', reason: RELAY_CODES.ROLE_ALREADY_ON_GITHUB, sideEffects, relay };
  if (stageResult?.status === 'REFUSED' && sideEffects === 0)
    return { status: 'BLOCKED', reason: ['RELAY_STAGE_NOT_CONFIGURED', 'RELAY_STAGE_INPUT_INVALID'].includes(stageResult.code) ? stageResult.code : 'RELAY_STAGE_NOT_CONFIGURED', sideEffects: 0, relay: null };
  const reason = RELAY_HALT_CODES.includes(stageResult?.code) ? stageResult.code : RELAY_CODES.PUBLICATION_UNCERTAIN;
  return { status: 'UNCERTAIN', reason, sideEffects: Math.max(sideEffects, 1), relay };
}
