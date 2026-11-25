// The acceptance door (PLAN-accept-auto-seal-20261125 section 2.1, 2.2 and 5; part A serves it, this is part B's client). The Owner accepts one
// universal node package by approving one fleet.accept Grant on the Clued confirm page; publish.mjs seal asks this door and seals only on its
// "accepted". Its own small file on purpose: the frozen upgrader's grant-client.mjs is not imported (it ships inside the package and changes
// only with a package).
//
// The contract with part A (section 5):
//   input   { action: 'fleet.accept', resources: [<one resource>], op_id: <uuid> }, the resource
//           fleet-node:<owner>/<repo>/<version>/<tar sha256>/<acceptance-request file sha256> (the request's sha256 already binds tar,
//           commit, Source, kit and fleetRefs)
//   answer  { status: 'pending', confirmUrl, expiresAt }          not approved yet: the link the Owner opens, the request's expiry
//           { status: 'accepted', grant_id, receipt_id, accepted_at }   approved; the door's "accepted" row, replayed on every later ask
//           { status: 'rejected' } | { status: 'expired' }        the Owner said "not yet", or the request ran out (asking again reopens one)
// The Grant is never approved automatically and only on the page (the server's rule); nothing here can approve.
//
// The wire: one POST to the Clued database's PostgREST endpoint of ACCEPT_DOOR_RPC with the public publishable key and the SHA-256 of the
// publisher's Binding token (the way scripts/ci/clued-release-grant.mjs calls clued_owner_grant_door_consume_v1). Configuration comes from the
// environment only: CLUED_SUPABASE_URL, CLUED_SUPABASE_PUBLISHABLE_KEY and CLUED_FLEET_ACCEPT_TOKEN; the token is hashed for each call and
// never sent, written, logged or kept.
import { createHash } from 'node:crypto';
import { VERSION } from './universal.mjs';

export const ACCEPT_ACTION = 'fleet.accept';
// part A's door function (PLAN section 5, A: "门函数"); the one place its name is written on this side
export const ACCEPT_DOOR_RPC = 'clued_fleet_accept_door_v1';
export const CALL_TIMEOUT_MS = 30_000;
export const ANSWERS = Object.freeze(['pending', 'accepted', 'rejected', 'expired']);

const fail = (code, detail) => { throw Object.assign(new Error(detail === undefined ? code : `${code} ${JSON.stringify(detail)}`), { code, detail }); };
const check = (ok, code, detail) => { if (!ok) fail(code, detail); };
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TOKEN = /^[\x21-\x7e]{16,512}$/;
const CONFIRM = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/confirm\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/;

// The one resource of a fleet.accept request (section 2.1).
export function acceptResourceOf({ repository, version, archiveSha256, requestSha256 }) {
  check(REPO.test(repository ?? '') && VERSION.test(version ?? '') && HEX64.test(archiveSha256 ?? '') && HEX64.test(requestSha256 ?? ''), 'ACCEPT_RESOURCE_REFUSED',
    { repository, version });
  return `fleet-node:${repository}/${version}/${archiveSha256}/${requestSha256}`;
}

// The door over HTTP: input -> the door's answer as it came (readAnswer holds it to the contract). A transport failure, a door not deployed
// (PGRST202), a 5xx or a body that is not JSON is ACCEPT_DOOR_UNAVAILABLE (asking again may help); a 4xx with the database's message is
// ACCEPT_DOOR_REFUSED (it will say the same again: the Binding is not the publisher's, another request of an accepted version, ...).
export function httpDoor({ supabaseUrl, publishableKey, token, fetchImpl = globalThis.fetch }) {
  check(/^https:\/\/[^\s/]+\/?$/.test(supabaseUrl ?? '') && typeof publishableKey === 'string' && publishableKey !== '' && TOKEN.test(String(token ?? '').trim()),
    'ACCEPT_DOOR_NOT_CONFIGURED');
  const endpoint = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/rpc/${ACCEPT_DOOR_RPC}`;
  const tokenHash = createHash('sha256').update(String(token).trim()).digest('hex');
  return async input => {
    let response, text;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { apikey: publishableKey, authorization: `Bearer ${publishableKey}`, 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'clued-fleet-accept' },
        body: JSON.stringify({ p_token_hash: tokenHash, p_input: input }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        redirect: 'error',
      });
      text = await response.text();
    } catch (e) {
      fail('ACCEPT_DOOR_UNAVAILABLE', { http: null, error: String(e?.name ?? 'Error') });
    }
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    const message = body && typeof body === 'object' ? String(body.message ?? body.error_code ?? body.code ?? '').slice(0, 200) : '';
    if (response.status === 200 && body !== null && typeof body === 'object') return body;
    if (response.status >= 400 && response.status < 500 && !(response.status === 404 && body?.code === 'PGRST202') && message !== '') {
      fail('ACCEPT_DOOR_REFUSED', { http: response.status, message });
    }
    return fail('ACCEPT_DOOR_UNAVAILABLE', { http: response.status, message: message || null });
  };
}

// The door from the environment (the command line's only way); missing configuration is refused before anything is called.
export function doorFromEnv(env = process.env, fetchImpl = globalThis.fetch) {
  const supabaseUrl = (env.CLUED_SUPABASE_URL ?? '').trim(), publishableKey = (env.CLUED_SUPABASE_PUBLISHABLE_KEY ?? '').trim(), token = (env.CLUED_FLEET_ACCEPT_TOKEN ?? '').trim();
  check(supabaseUrl && publishableKey && token, 'ACCEPT_DOOR_NOT_CONFIGURED',
    { missing: [['CLUED_SUPABASE_URL', supabaseUrl], ['CLUED_SUPABASE_PUBLISHABLE_KEY', publishableKey], ['CLUED_FLEET_ACCEPT_TOKEN', token]].filter(([, v]) => !v).map(([k]) => k) });
  return httpDoor({ supabaseUrl, publishableKey, token, fetchImpl });
}

// An answer held to the contract: { kind: 'pending', confirmUrl, expiresAt } | { kind: 'accepted', grantId, receiptId, acceptedAt } |
// { kind: 'rejected' | 'expired' }; acceptedAt to the second, UTC, ending in Z, not after `now`. Anything else is ACCEPT_DOOR_ANSWER_REFUSED.
export function readAnswer(answer, now = Date.now()) {
  check(answer !== null && typeof answer === 'object' && !Array.isArray(answer) && ANSWERS.includes(answer.status), 'ACCEPT_DOOR_ANSWER_REFUSED',
    { status: answer?.status ?? null });
  if (answer.status === 'pending') {
    check(CONFIRM.test(answer.confirmUrl ?? '') && TIME.test(answer.expiresAt ?? '') && Number.isFinite(Date.parse(answer.expiresAt)), 'ACCEPT_DOOR_ANSWER_REFUSED',
      { status: 'pending', confirmUrl: answer.confirmUrl ?? null, expiresAt: answer.expiresAt ?? null });
    return { kind: 'pending', confirmUrl: answer.confirmUrl, expiresAt: answer.expiresAt };
  }
  if (answer.status !== 'accepted') return { kind: answer.status };
  const at = TIME.test(answer.accepted_at ?? '') ? Date.parse(answer.accepted_at) : NaN;
  check(UUID.test(answer.grant_id ?? '') && UUID.test(answer.receipt_id ?? '') && answer.grant_id !== answer.receipt_id, 'ACCEPT_DOOR_ANSWER_REFUSED',
    { status: 'accepted', note: 'grant_id and receipt_id: two different UUIDs' });
  check(Number.isFinite(at) && at <= now, 'ACCEPT_DOOR_ANSWER_REFUSED', { status: 'accepted', accepted_at: answer.accepted_at ?? null });
  return { kind: 'accepted', grantId: answer.grant_id, receiptId: answer.receipt_id, acceptedAt: new Date(Math.floor(at / 1000) * 1000).toISOString().replace('.000Z', 'Z') };
}
