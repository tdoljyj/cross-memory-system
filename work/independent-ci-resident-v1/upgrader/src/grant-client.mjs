// The KooYomi Grant door for one upgrade (spec A2), called like scripts/ci/clued-release-grant.mjs: POST to the database's
// PostgREST endpoint of clued_owner_grant_door_consume_v1 with the PUBLIC publishable key and the SHA-256 of this node's own
// resident-upgrade token. The only host ever called is the configured supabaseUrl; the token is read from its admin-only
// file for each call and never written, logged or kept.
//
// ci.resident_upgrade is never approved automatically: without a Grant the door opens (or returns) the Owner request
// resident-upgrade:<op_id>, whose confirm link the status shows; the Owner approves on the page and the next call consumes.
// The same op_id replays the same use (replayed: true); a new op needs a new Grant.
import { createHash } from 'node:crypto';
import { UUID, check } from '../../src/canonical.mjs';
import { readBounded } from '../../src/store.mjs';
import { GRANT_RESOURCE } from './request.mjs';
import { U } from './codes.mjs';

export const DOOR_RPC = 'clued_owner_grant_door_consume_v1';
export const GRANT_ACTION = 'ci.resident_upgrade';
export const CALL_TIMEOUT_MS = 30_000;
const CONFIRM_PATH = /^\/confirm\/[0-9a-f-]{36}$/;
const ISO = v => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
const TOKEN = /^[\x21-\x7e]{16,512}$/;

export function grantClient({ supabaseUrl, publishableKey, confirmOrigin, tokenFile, fetchImpl = globalThis.fetch, readToken = null }) {
  const endpoint = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/rpc/${DOOR_RPC}`;
  const origin = confirmOrigin.replace(/\/$/, '');
  const tokenHash = async () => {
    const raw = readToken ? await readToken() : (await readBounded(tokenFile, 4096, 'UPGRADE_TOKEN_UNREADABLE')).toString('utf8');
    const token = raw.trim();
    check(TOKEN.test(token), 'UPGRADE_TOKEN_UNREADABLE');
    return createHash('sha256').update(token).digest('hex');
  };

  // { kind: 'consumed', grant } | { kind: 'pending', requestId, status, confirmUrl, expiresAt } | { kind: 'refused', code } |
  // { kind: 'unavailable', code, http }
  async function consume({ opId, resource, note = null }) {
    check(UUID.test(opId ?? '') && GRANT_RESOURCE.test(resource ?? '') && (note === null || (typeof note === 'string' && note.length <= 2000)), U.REQUEST_REFUSED, 'grant-input');
    let hash;
    try { hash = await tokenHash(); } catch { return { kind: 'unavailable', code: U.GRANT_DOOR_UNAVAILABLE, http: null, reason: 'token' }; }
    const input = { action: GRANT_ACTION, resources: [resource], op_id: opId, ...(note ? { note } : {}) };
    let response, body = null;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { apikey: publishableKey, authorization: `Bearer ${publishableKey}`, 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'clued-resident-upgrader' },
        body: JSON.stringify({ p_token_hash: hash, p_input: input }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        redirect: 'error',
      });
      try { const text = await response.text(); body = text ? JSON.parse(text) : null; } catch { body = null; }
    } catch {
      return { kind: 'unavailable', code: U.GRANT_DOOR_UNAVAILABLE, http: null };
    }
    return interpret(response.status, body, { opId, resource, origin });
  }

  return { consume, endpoint };
}

// Pure: the door's answer as the upgrader reads it.
export function interpret(status, body, { resource, origin }) {
  const message = body && typeof body === 'object' ? (body.message ?? body.error_code ?? null) : null;
  if (status === 400 && (message === 'owner_grant_door_input_invalid' || message === 'owner_grant_door_resources_invalid')) return { kind: 'refused', code: U.REQUEST_REFUSED };
  if ((status === 401 || status === 403) && (body?.code === '42501' || message === 'owner_grant_door_binding_not_authorized')) return { kind: 'refused', code: U.GRANT_BINDING_NOT_AUTHORIZED };
  if (status !== 200 || !body || typeof body !== 'object' || body.status !== 'ok') return { kind: 'unavailable', code: U.GRANT_DOOR_UNAVAILABLE, http: status };
  // The answer must be about exactly this action and resource.
  if (body.action !== GRANT_ACTION || !Array.isArray(body.resources) || body.resources.length !== 1 || body.resources[0] !== resource) return { kind: 'unavailable', code: U.GRANT_DOOR_UNAVAILABLE, http: status };
  if (body.consumed === true) {
    const g = body.grant;
    const ok = g && UUID.test(g.grant_id ?? '') && UUID.test(g.receipt_id ?? '') && Number.isSafeInteger(g.use) && Number.isSafeInteger(g.max_uses) && g.use >= 1 && g.use <= g.max_uses
      && typeof g.replayed === 'boolean' && ISO(g.expires_at);
    if (!ok) return { kind: 'unavailable', code: U.GRANT_DOOR_UNAVAILABLE, http: status };
    return { kind: 'consumed', grant: { grantId: g.grant_id, receiptId: g.receipt_id, use: g.use, maxUses: g.max_uses, expiresAt: g.expires_at, replayed: g.replayed } };
  }
  const r = body.owner_request;
  if (!r || typeof r !== 'object' || !UUID.test(r.request_id ?? '')) return { kind: 'unavailable', code: U.GRANT_DOOR_UNAVAILABLE, http: status };
  const confirmUrl = typeof r.confirm_path === 'string' && CONFIRM_PATH.test(r.confirm_path) ? origin + r.confirm_path : null;
  switch (r.status) {
    case 'pending': case 'approved':
      return { kind: 'pending', requestId: r.request_id, status: r.status, confirmUrl, expiresAt: ISO(r.expires_at) ? r.expires_at : null };
    case 'rejected': return { kind: 'refused', code: U.GRANT_REJECTED, requestId: r.request_id };
    case 'expired': return { kind: 'refused', code: U.GRANT_EXPIRED, requestId: r.request_id };
    case 'revoked': return { kind: 'refused', code: U.GRANT_REVOKED, requestId: r.request_id };
    default: return { kind: 'unavailable', code: U.GRANT_DOOR_UNAVAILABLE, http: status };
  }
}

