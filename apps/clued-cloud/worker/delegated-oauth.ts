/** OAuth protocol is delegated to the maintained provider; BeamingFace retains live grants. */
import { OAuthProvider, OAuthError, GrantType, type AuthRequest, type OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { handleContinuityRequest, publicToolPolicies, type ContinuityEnv } from './continuity';
import { databaseGatewayToken } from './database-gateway';
import { isStorageAgentTool } from './storage-agent-tools';
import { storageReadTool, storageContentTool } from './storage-read-agent';
import { storageConnectionsTool } from './storage-connections';
import { OWNER_REQUEST_TOOL } from './owner-requests';
import { permissionDenial, permissionDenialResult } from './permission-guidance';
import { mcpProfileEmailSnapshot, mcpProfileTool, type McpProfile } from './mcp-profile';

const SCOPES = ['context:read', 'context:write', 'audit:read'];
const PENDING_TTL = 600;
// Owner-selectable authorization lifetimes; the database caps expiry at 365 days.
const LIFETIME_DAYS = [1, 7, 30, 90, 365];
export interface DelegatedOAuthEnv extends ContinuityEnv {
  CLUED_DELEGATED_OAUTH_V12?: string;
  CLUED_OAUTH_ORIGIN?: string;
  CLUED_AUTHORIZATION_ISSUER_TOKEN?: string;
  OAUTH_KV?: KVNamespace;
  KOOYUMI_OAUTH_ORIGIN?: string;
  KOOYUMI_AUTHORIZATION_ISSUER_TOKEN?: string;
  KOOYUMI_OAUTH_KV?: KVNamespace;
  OAUTH_PROVIDER?: OAuthHelpers;
}
// narrowed: false only on an access token whose scopes are the whole grant's
// (no refresh downscoping); absent on tokens issued before it existed.
interface AuthProps {
  userId: string; bindingId: string; bindingToken: string; scopes: string[]; expiresAt: string; narrowed?: boolean;
  // Optional for old tokens; new approvals may carry a verified display snapshot.
  // Refresh preserves it. Email changes are reflected only by a new authorization.
  profileSnapshot?: Pick<McpProfile, 'id' | 'email'>;
}
interface Pending { auth: AuthRequest; clientName: string; cookieHash: string; createdAt: number }
type Json = Record<string, unknown>;
class AuthorizationFailure extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) { super(message); }
}
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
export const delegatedOAuthEnabled = (env: DelegatedOAuthEnv) => env.CLUED_DELEGATED_OAUTH_V12 === 'true';
const randomHex = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
async function hash(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
}
function originOf(env: DelegatedOAuthEnv) {
  if (!env.CLUED_OAUTH_ORIGIN) throw new AuthorizationFailure(503, '授权服务尚未配置。');
  const url = new URL(env.CLUED_OAUTH_ORIGIN);
  if (url.protocol !== 'https:' || url.origin !== env.CLUED_OAUTH_ORIGIN) throw new AuthorizationFailure(503, '授权服务地址配置无效。');
  return url.origin;
}
function userToken(request: Request) {
  const token = request.headers.get('Authorization')?.match(/^Bearer (\S+)$/)?.[1];
  if (!token) throw new AuthorizationFailure(401, '请先登录 BeamingFace。');
  return token;
}
function transient(status: number) { return status === 429 || status >= 500; }
async function boundedBody(request: Request, maximum: number) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new AuthorizationFailure(413, '请求过大。'); }
      chunks.push(item.value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size); let position = 0;
  for (const chunk of chunks) { body.set(chunk, position); position += chunk.byteLength; }
  return body;
}
async function rpc(env: DelegatedOAuthEnv, token: string, name: string, body: Json): Promise<Json> {
  if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) throw new AuthorizationFailure(503, '账户服务尚未配置。');
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    if (transient(response.status)) throw new AuthorizationFailure(503, '服务暂不可用，请稍后重试；现有授权没有因此失效。');
    if (response.status === 400 && name === 'clued_authorization_manage_v12' && (body.p_input as Json | undefined)?.op === 'reduce') {
      const problem = await response.json().catch(() => null) as { code?: unknown; message?: unknown } | null;
      if (problem?.code === '22023' && problem.message === 'authorization_empty_projection_requires_binding_revoke') {
        throw new AuthorizationFailure(400, '本次修改未保存。要取消此连接的全部权限，请使用“撤销此连接”。', 'authorization_empty_projection_requires_binding_revoke');
      }
    }
    // Provider/database diagnostics can contain internal SQL, identifiers or credentials.
    throw new AuthorizationFailure(response.status === 401 ? 401 : response.status === 409 ? 409 : 403,
      response.status === 409 ? '授权请求已处理或版本发生变化，请重新连接。' : '当前账户或授权请求不能执行此操作。');
  }
  return await response.json() as Json;
}
async function bindingRpc(env: DelegatedOAuthEnv, name: string, bindingToken: string): Promise<Json> {
  const gatewayToken = databaseGatewayToken(env);
  if (!gatewayToken) throw new AuthorizationFailure(503, '授权服务暂不可用，请稍后重试。');
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY!, Authorization: `Bearer ${gatewayToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_token_hash: await hash(bindingToken) }), signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    if (transient(response.status)) throw new OAuthError('temporarily_unavailable', { description: 'BeamingFace authorization service is temporarily unavailable.', statusCode: 503 });
    const problem = await response.json().catch(() => null) as { code?: unknown } | null;
    if (response.status === 401 && typeof problem?.code === 'string' && /^PGRST30[123]$/.test(problem.code)) {
      throw new OAuthError('temporarily_unavailable', { description: 'BeamingFace authorization service is temporarily unavailable.', statusCode: 503 });
    }
    throw new OAuthError('invalid_grant', { description: 'BeamingFace authorization is revoked or unavailable to this connection.' });
  }
  return await response.json() as Json;
}
// Returns the scopes this access token may use. The Owner can widen a
// connection after its client token was issued (connection.permission
// requests), so a token that carries the whole grant follows the connection's
// live scopes. A token the client narrowed on refresh, or one issued before
// the flag existed, never exceeds its own scopes.
async function checkBinding(env: DelegatedOAuthEnv, props: AuthProps): Promise<readonly string[]> {
  const expiry = Date.parse(props?.expiresAt);
  if (!props || !/^clued_bnd_[a-f0-9]{64}$/.test(props.bindingToken) || !Array.isArray(props.scopes) || !Number.isFinite(expiry) || expiry <= Date.now()) throw new OAuthError('invalid_grant', { description: 'BeamingFace authorization is expired or revoked.' });
  const status = await bindingRpc(env, 'clued_authorization_status_v12', props.bindingToken);
  if (status.active !== true || status.binding_id !== props.bindingId) throw new OAuthError('invalid_grant', { description: 'BeamingFace authorization is expired or revoked.' });
  const live = status.scopes;
  if (!Array.isArray(live) || !live.every(scope => typeof scope === 'string')) return props.scopes;
  return props.narrowed === false ? live as string[] : props.scopes.filter(scope => live.includes(scope));
}
async function identity(env: DelegatedOAuthEnv, token: string): Promise<{ id: string; email?: string }> {
  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY!, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    if (transient(response.status)) throw new AuthorizationFailure(503, '账户服务暂不可用，请稍后重试。');
    throw new AuthorizationFailure(401, '登录已失效，请重新登录。');
  }
  const user = await response.json() as { id: string; email?: string };
  if (!user.id) throw new AuthorizationFailure(401, '无法验证账户。');
  return { id: user.id, email: user.email };
}
async function pendingRequest(request: Request, env: DelegatedOAuthEnv, id: string): Promise<Pending> {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new AuthorizationFailure(400, '授权请求无效。');
  const pending = await env.OAUTH_KV!.get<Pending>(`clued:pending:${id}`, 'json');
  const cookie = request.headers.get('Cookie')?.split(';').map(v => v.trim()).find(v => v.startsWith(`clued_auth_${id}=`))?.split('=')[1];
  if (!pending || !cookie || await hash(cookie) !== pending.cookieHash || Date.now() - pending.createdAt > PENDING_TTL * 1000) {
    throw new AuthorizationFailure(400, '授权请求已过期或不属于此浏览器，请重新连接。');
  }
  return pending;
}
async function prepare(env: DelegatedOAuthEnv, token: string, id: string, pending: Pending) {
  const issuer = env.CLUED_AUTHORIZATION_ISSUER_TOKEN;
  if (!issuer) throw new AuthorizationFailure(503, '授权签发服务尚未配置。');
  return rpc(env, token, 'clued_authorization_prepare_v12', {
    p_issuer_hash: await hash(issuer), p_request: {
      request_digest: await hash(JSON.stringify({ id, auth: pending.auth })), client_id: pending.auth.clientId,
      client_name: pending.clientName, redirect_uri: pending.auth.redirectUri,
      resource: `${originOf(env)}/mcp`, requested_scopes: pending.auth.scope,
    },
  });
}
function terminalRedirect(auth: AuthRequest, error: string) {
  const url = new URL(auth.redirectUri);
  url.searchParams.set('error', error);
  if (auth.state) url.searchParams.set('state', auth.state);
  if (auth.issuer) url.searchParams.set('iss', auth.issuer);
  return url.href;
}
async function revokeIssuedBinding(env: DelegatedOAuthEnv, bindingId: string) {
  const gatewayToken = databaseGatewayToken(env);
  if (!gatewayToken) throw new AuthorizationFailure(503, '撤销尚未确认，请稍后重试。');
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/clued_authorization_revoke_issuer_v12`, {
    method: 'POST', headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY!, Authorization: `Bearer ${gatewayToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_issuer_hash: await hash(env.CLUED_AUTHORIZATION_ISSUER_TOKEN!), p_binding_id: bindingId }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new AuthorizationFailure(503, '撤销尚未确认，请重试。');
}
async function revocationStorage(request: Request, env: DelegatedOAuthEnv): Promise<KVNamespace> {
  const storage = env.OAUTH_KV!;
  if (new URL(request.url).pathname !== '/oauth/token' || request.method !== 'POST' || !(request.headers.get('Content-Type') || '').startsWith('application/x-www-form-urlencoded')) return storage;
  const body = new URLSearchParams(await request.clone().text());
  if (!body.has('token') || body.has('grant_type')) return storage;
  const committed = new Map<string, Promise<void>>();
  // Only the maintained provider may reach this delete hook, after validating
  // the revocation client's credentials and its ownership of the real token.
  // Do not use it during refresh rotation, expiry cleanup or ordinary writes.
  return new Proxy(storage, { get(target, key) {
    if (key === 'delete') return async (input: string | string[]) => {
      for (const item of Array.isArray(input) ? input : [input]) {
        const match = /^(?:grant|token):([^:]+):([^:]+)(?::|$)/.exec(item);
        if (match) {
          const grant = await target.get<{ metadata?: { bindingId?: string } }>(`grant:${match[1]}:${match[2]}`, 'json');
          const id = grant?.metadata?.bindingId;
          if (!id) throw new AuthorizationFailure(503, '无法确认连接撤销对象，请在连接管理页撤销。');
          let operation = committed.get(id);
          if (!operation) { operation = revokeIssuedBinding(env, id); committed.set(id, operation); }
          await operation;
        }
        await target.delete(item);
      }
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
async function consentRoute(request: Request, env: DelegatedOAuthEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === '/oauth/connections/api' || url.pathname === '/oauth/projects/api') {
    const projects = url.pathname === '/oauth/projects/api';
    if (!['GET', 'POST'].includes(request.method)) return json({ error: 'method_not_allowed' }, 405);
    if (request.method === 'POST' && request.headers.get('Origin') !== originOf(env)) return json({ error: '请求来源不匹配。' }, 403);
    const token = userToken(request);
    let input: Json = { op: 'list' };
    if (request.method === 'POST') {
      if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) return json({ error: 'invalid_content_type' }, 415);
      const raw = await request.text();
      if (raw.length > 65536) return json({ error: '请求过大。' }, 413);
      input = JSON.parse(raw) as Json;
      if (!(projects ? ['invite_inspect', 'invite_create', 'invite_accept', 'invite_revoke', 'member_reduce', 'member_revoke'] : ['revoke', 'reduce', 'limit_confirmation_issue', 'limit_confirm']).includes(String(input.op))) return json({ error: 'operation_not_allowed' }, 400);
    }
    return json(await rpc(env, token, projects ? 'clued_project_access_v13' : 'clued_authorization_manage_v12', { p_input: input }));
  }
  if (url.pathname === '/oauth/authorize') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    const auth = await env.OAUTH_PROVIDER!.parseAuthRequest(request);
    if (auth.responseType !== 'code' || auth.codeChallengeMethod !== 'S256' || !auth.codeChallenge || !auth.scope.length || auth.scope.some(s => !SCOPES.includes(s))) {
      return json({ error: '需要授权码、PKCE S256 和支持的权限范围。' }, 400);
    }
    const resources = Array.isArray(auth.resource) ? auth.resource : [auth.resource];
    if (resources.length !== 1 || resources[0] !== `${originOf(env)}/mcp`) return json({ error: '授权目标不匹配。' }, 400);
    const client = await env.OAUTH_PROVIDER!.lookupClient(auth.clientId);
    if (!client) return json({ error: '客户端无效。' }, 400);
    const id = randomHex(); const cookie = randomHex();
    await env.OAUTH_KV!.put(`clued:pending:${id}`, JSON.stringify({ auth, clientName: client.clientName || auth.clientId, cookieHash: await hash(cookie), createdAt: Date.now() } satisfies Pending), { expirationTtl: PENDING_TTL });
    return new Response(null, { status: 302, headers: {
      Location: `${originOf(env)}/oauth/consent?request_id=${id}`,
      'Set-Cookie': `clued_auth_${id}=${cookie}; Path=/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=${PENDING_TTL}`,
      'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    } });
  }
  if (url.pathname !== '/oauth/request' && url.pathname !== '/oauth/decision') return null;
  if ((url.pathname === '/oauth/request' && request.method !== 'GET') || (url.pathname === '/oauth/decision' && request.method !== 'POST')) return json({ error: 'method_not_allowed' }, 405);
  if (request.method === 'POST' && request.headers.get('Origin') !== originOf(env)) return json({ error: '请求来源不匹配。' }, 403);
  if (request.method === 'POST' && !(request.headers.get('Content-Type') || '').startsWith('application/json')) return json({ error: 'invalid_content_type' }, 415);
  const id = url.searchParams.get('request_id') || '';
  const pending = await pendingRequest(request, env, id);
  const token = userToken(request);
  const prepared = await prepare(env, token, id, pending);
  if (request.method === 'GET') return json({ ...prepared, client_name: pending.clientName, client_id: pending.auth.clientId, requested_scopes: pending.auth.scope, user: await identity(env, token) });
  if (Number(request.headers.get('Content-Length') || '0') > 65536) return json({ error: '请求过大。' }, 413);
  const raw = await request.text();
  if (raw.length > 65536) return json({ error: '请求过大。' }, 413);
  const body = JSON.parse(raw) as Json;
  if (body.action === 'deny') {
    await rpc(env, token, 'clued_authorization_deny_v12', { p_issuer_hash: await hash(env.CLUED_AUTHORIZATION_ISSUER_TOKEN!), p_request_id: prepared.request_id, p_base_version: body.version });
    await env.OAUTH_KV!.delete(`clued:pending:${id}`);
    return json({ redirect_url: terminalRedirect(pending.auth, 'access_denied') });
  }
  if (body.action !== 'approve' || !Array.isArray(body.selected) || !body.selected.length || !LIFETIME_DAYS.includes(Number(body.days))) return json({ error: '请选择至少一项权限和有效期。' }, 400);
  const bindingToken = `clued_bnd_${randomHex()}`;
  const expiresAt = new Date(Date.now() + Number(body.days) * 86400000).toISOString();
  const approved = await rpc(env, token, 'clued_authorization_approve_v12', {
    p_issuer_hash: await hash(env.CLUED_AUTHORIZATION_ISSUER_TOKEN!), p_request_id: prepared.request_id,
    p_base_version: body.version, p_selected: body.selected, p_binding_hash: await hash(bindingToken), p_expires_at: expiresAt,
  });
  if (typeof approved.binding_id !== 'string' || !Array.isArray(approved.granted_scopes) || !approved.granted_scopes.length) throw new AuthorizationFailure(503, '授权结果缺少必要字段，尚未签发客户端令牌。');
  const user = await identity(env, token);
  // The provider encrypts props. Neither the human identity token nor this internal
  // binding secret is included in the browser response or sent to the MCP client.
  try {
    const profileSnapshot = mcpProfileEmailSnapshot(user);
    const result = await env.OAUTH_PROVIDER!.completeAuthorization({
      request: pending.auth, userId: user.id, metadata: { bindingId: approved.binding_id, clientName: pending.clientName },
      scope: approved.granted_scopes as string[], revokeExistingGrants: false,
      props: { userId: user.id, bindingId: approved.binding_id, bindingToken, scopes: approved.granted_scopes, expiresAt,
        ...(profileSnapshot.email ? { profileSnapshot } : {}) } satisfies AuthProps,
    });
    await env.OAUTH_KV!.delete(`clued:pending:${id}`);
    return json({ redirect_url: result.redirectTo });
  } catch {
    // Never retry approval or create a second authorization silently. Attempt to
    // close only the exact newly-created grant; its secret has not been disclosed.
    await rpc(env, token, 'clued_authorization_manage_v12', { p_input: { op: 'revoke', binding_id: approved.binding_id, base_version: approved.version } }).catch(() => undefined);
    throw new AuthorizationFailure(503, '客户端令牌签发结果尚未确认，请先在连接管理页核对状态，再重新连接。');
  }
}
export function requiredToolScopes(name: string, args: Json = {}): readonly string[] | null {
  // Identity display requires the live OAuth Binding, not business-memory scope.
  if (name === mcpProfileTool.name) return [];
  // Storage authority is a separate native-Owner grant, not context:write.
  // scopedApi still checks the live v12 Binding before the storage RPC performs
  // its exact connection/action grant check. This does not issue any grant.
  // The read tool is gated the same way: its read evaluator checks the Binding,
  // the Owner's read access row and the issuer read switch.
  // The connections list is read the same way: the database lists only what
  // the storage evaluators admit for this Binding.
  if (isStorageAgentTool(name) || name === storageReadTool.name || name === storageContentTool.name ||
    name === storageConnectionsTool.name) return [];
  // Asking the Owner for a connection permission, and reading a request, need
  // no scope here: the database checks the live connection (and, for a status
  // read of another request, context:read). Other requests need context:write.
  if (name === OWNER_REQUEST_TOOL) {
    return args.action === 'connection.permission' || 'request_id' in args ? [] : ['context:write'];
  }
  if (name === 'clued_context') {
    const operation = String(args.op);
    if (['context_list', 'record_list'].includes(operation)) return ['context:read'];
    if (['record_put', 'record_revoke', 'feedback_submit', 'feedback_list', 'feedback_withdraw'].includes(operation)) return ['context:write'];
    return null; // Publisher and membership operations require their separate governed flow.
  }
  return publicToolPolicies[name as keyof typeof publicToolPolicies]?.scopes ?? null;
}
async function scopedApi(request: Request, env: DelegatedOAuthEnv, props: AuthProps, ctx: ExecutionContext): Promise<Response> {
  const scopes = await checkBinding(env, props);
  if (request.method === 'POST') {
    let payload: Json | null = null;
    try { payload = await request.clone().json() as Json; }
    catch { /* Let the MCP transport return its standard parse-error response. */ }
    if (Array.isArray(payload)) return json({ error: 'batch_not_supported' }, 400);
    if (payload && typeof payload === 'object' && payload.jsonrpc === '2.0' && payload.method === 'tools/call') {
      const params = payload.params as Json | undefined;
      const required = requiredToolScopes(String(params?.name), (params?.arguments || {}) as Json);
      // A tool error, not an HTTP 403: Hosts drop the body of a 403, and the
      // Agent needs it to ask the Owner for the missing permission.
      if (!required || required.some(scope => !scopes.includes(scope))) {
        const missing = required ? required.filter(scope => !scopes.includes(scope)) : null;
        const denial = permissionDenial('insufficient_scope', params?.name, params?.arguments, missing);
        return json({ jsonrpc: '2.0', id: payload.id ?? null, result: permissionDenialResult(denial) }, 200);
      }
    }
  }
  const account = mcpProfileEmailSnapshot({ id: props.userId });
  const authenticatedMcpAccount = props.profileSnapshot === undefined ? account
    : mcpProfileEmailSnapshot(props.profileSnapshot, account.id);
  const headers = new Headers(request.headers);
  headers.set('Authorization', `Bearer ${props.bindingToken}`);
  const response = await handleContinuityRequest(new Request(request, { headers }), env, {
    waitUntil: promise => ctx.waitUntil(promise),
    // The provider encrypted this Auth user ID when consent was approved.
    // checkBinding above revalidates that same grant on every MCP request.
    authenticatedMcpAccount,
  });
  return response || json({ error: 'not_found' }, 404);
}
/** The feature remains disabled until its database migration and issuer are configured. */
export async function handleDelegatedOAuth(request: Request, env: DelegatedOAuthEnv, ctx: ExecutionContext, fallback: (request: Request) => Promise<Response>): Promise<Response> {
  try {
    const path = new URL(request.url).pathname;
    if (request.method === 'POST' && (path.startsWith('/oauth/') || path === '/mcp')) {
      request = new Request(request, { body: await boundedBody(request, path === '/mcp' ? 1024 * 1024 : 65536) });
    }
    const origin = originOf(env);
    if (new URL(request.url).origin !== origin) return json({ error: 'invalid_origin' }, 400);
    if (!env.OAUTH_KV || !env.CLUED_AUTHORIZATION_ISSUER_TOKEN) return json({ error: '授权服务尚未配置。' }, 503);
    const provider = new OAuthProvider<DelegatedOAuthEnv>({
      apiRoute: '/mcp',
      apiHandler: { async fetch(req, boundEnv, context) { return scopedApi(req, boundEnv, context.props as AuthProps, ctx); } },
      defaultHandler: { async fetch(req, boundEnv) { return await consentRoute(req, boundEnv) || await fallback(req); } },
      authorizeEndpoint: '/oauth/authorize', tokenEndpoint: '/oauth/token', clientRegistrationEndpoint: '/oauth/register',
      scopesSupported: SCOPES, clientIdMetadataDocumentEnabled: false, allowPlainPKCE: false, allowImplicitFlow: false,
      accessTokenTTL: 900, refreshTokenTTL: 365 * 86400,
      resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: SCOPES, resource_name: 'BeamingFace' },
      tokenExchangeCallback: async ({ grantType, props, scope, requestedScope }) => {
        await checkBinding(env, props);
        const narrowed = scope.some(item => !requestedScope.includes(item));
        // The provider fixes the refresh token lifetime at code exchange and never
        // extends it, so bind it to the lifetime the Owner chose for this grant.
        if (grantType !== GrantType.AUTHORIZATION_CODE) return { accessTokenProps: { ...props, scopes: requestedScope, narrowed } };
        const remaining = Math.ceil((Date.parse((props as AuthProps).expiresAt) - Date.now()) / 1000);
        return { accessTokenProps: { ...props, scopes: requestedScope, narrowed }, refreshTokenTTL: Math.max(60, remaining) };
      },
      onError: ({ status }) => json({ error: transient(status) ? 'temporarily_unavailable' : 'invalid_request', message: transient(status) ? '授权服务暂不可用，请稍后重试。' : '授权请求未通过验证。' }, status),
    });
    const requestEnv = { ...env, OAUTH_KV: await revocationStorage(request, env), OAUTH_PROVIDER: undefined };
    return await provider.fetch(request, requestEnv, ctx);
  } catch (error) {
    const status = error instanceof AuthorizationFailure ? error.status : error instanceof OAuthError ? error.statusCode : 503;
    return json({ error: error instanceof AuthorizationFailure ? error.code ?? error.message : status >= 500 ? '授权服务暂不可用，请稍后重试。' : '授权无效或已撤销。',
      ...(error instanceof AuthorizationFailure && error.code ? { message: error.message } : {}) }, status);
  }
}
