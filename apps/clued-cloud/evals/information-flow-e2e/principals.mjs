// Two real principals with real tokens (plan section 2.2).
// Account sessions: GoTrue signup + password grant through the local
// gateway; the access JWT is issued and verified by the real GoTrue and
// PostgREST. Agent Bindings: minted through the production v12 issuance
// RPCs over real PostgREST with the owner's JWT (only the issuer row is a
// fixture). Raw secrets stay in memory; evidence records sha256 labels only.

import crypto from 'node:crypto';
import { label, sha256 } from './evidence.mjs';

export function decodeJwtClaims(token) {
  const [, payload] = token.split('.');
  return JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

export async function signUp(gateway, publishableKey, email, password) {
  const response = await fetch(`${gateway}/auth/v1/signup`, {
    method: 'POST', headers: { apikey: publishableKey, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`signup failed: ${response.status} ${body.msg ?? body.error_code ?? ''}`);
  return { status: response.status, userId: body.user?.id ?? body.id };
}

export async function signIn(gateway, publishableKey, email, password) {
  const response = await fetch(`${gateway}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: publishableKey, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await response.json();
  if (!response.ok || !body.access_token) throw new Error(`sign-in failed: ${response.status}`);
  const claims = decodeJwtClaims(body.access_token);
  return {
    status: response.status,
    accessToken: body.access_token,
    userId: claims.sub,
    signedInAt: Date.now(),
    claimsSummary: {
      role: claims.role, aal: claims.aal, has_session_id: typeof claims.session_id === 'string',
      session_label: label(claims.session_id), amr_methods: (claims.amr ?? []).map((row) => row.method),
      amr_has_timestamp: (claims.amr ?? []).every((row) => Number.isInteger(row.timestamp)),
      has_client_id: 'client_id' in claims, token_label: label(body.access_token),
    },
  };
}

export class AccountPrincipal {
  constructor(name, gateway, publishableKey, email) {
    this.name = name;
    this.gateway = gateway;
    this.publishableKey = publishableKey;
    this.email = email;
    this.password = crypto.randomBytes(32).toString('hex');
    this.session = null;
    this.sessions = [];
  }

  async register() {
    const created = await signUp(this.gateway, this.publishableKey, this.email, this.password);
    this.userId = created.userId;
    return created;
  }

  async newSession() {
    this.session = await signIn(this.gateway, this.publishableKey, this.email, this.password);
    this.sessions.push(this.session.claimsSummary);
    return this.session;
  }

  // Native two-step routes need a session authenticated within 15 minutes.
  async current(maxAgeMs = 8 * 60 * 1000) {
    if (!this.session || Date.now() - this.session.signedInAt > maxAgeMs) await this.newSession();
    return this.session;
  }
}

export function scopeEntry(scope, actions = ['read', 'write']) {
  return { resource_kind: 'scope', resource_id: scope, environment: 'canonical', actions };
}

export function newBindingToken(tag) {
  // Real random secret with the product prefix; only its sha256 is stored.
  return `clued_bnd_${tag}${crypto.randomBytes(24).toString('base64url')}`;
}

// clued_authorization_prepare_v12 + clued_authorization_approve_v12 over the
// gateway (PostgREST) with the owner's GoTrue JWT.
export async function mintBinding(recorder, owner, { issuerHash, resource, scopes, clientId, raw, requested }) {
  const session = await owner.current();
  const prepared = await recorder.postgrest('owner_jwt', 'clued_authorization_prepare_v12', {
    p_issuer_hash: issuerHash,
    p_request: { request_digest: sha256(`${clientId}:${raw}`), client_id: clientId, client_name: `IF S6 ${clientId}`,
      redirect_uri: 'http://127.0.0.1/ife2e/callback', resource,
      requested_scopes: requested ?? ['context:read', 'context:write'] },
  }, { session, extract: (body) => ({ version: body?.version, eligible_count: body?.eligible?.length }) });
  if (prepared.status !== 200) throw new Error(`prepare_v12 failed: ${prepared.status} ${JSON.stringify(prepared.body)}`);
  const approved = await recorder.postgrest('owner_jwt', 'clued_authorization_approve_v12', {
    p_issuer_hash: issuerHash, p_request_id: prepared.body.request_id, p_base_version: prepared.body.version,
    p_selected: scopes.map((scope) => scopeEntry(scope)), p_binding_hash: sha256(raw),
    p_expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
  }, { session, extract: (body) => ({ version: body?.version, granted_scopes: body?.granted_scopes }) });
  if (approved.status !== 200) throw new Error(`approve_v12 failed: ${approved.status} ${JSON.stringify(approved.body)}`);
  return { raw, bindingId: approved.body.binding_id, version: approved.body.version, label: label(raw),
    grantedScopes: approved.body.granted_scopes, scopes };
}
