// CI node gateway (unified scheduling 2B; Task 54969190). The transport the Stage 1
// signature candidate was waiting for: a node's own Binding token names the
// principal, its P-256 signature over the command is verified here with WebCrypto
// (PostgreSQL cannot), and exactly one database mutation then runs the command in
// one transaction (public.clued_ci_node_command_v1). The database re-checks every
// signed identity field under its locks, refuses a reused command nonce and keeps
// the signed command. Closed per project until the Owner opens it (Q-B2): the
// database refuses with SIGNATURE_GATEWAY_NOT_ACTIVATED.
import { databaseGatewayToken, resolveSupabaseConfig, type DatabaseGatewayEnv } from './database-gateway';
import { CI_MAX_PAYLOAD_BYTES, ciCanonicalJson, verifyCiNodeCommand, type CiAuthenticatedPrincipal, type CiTrustedNodeSnapshot } from './ci-scheduling-v1';

export const CI_NODE_COMMAND_PATH = '/v1/ci/node';
export const CI_NODE_STATUS_PATH = '/v1/ci/node/status';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_REQUEST = CI_MAX_PAYLOAD_BYTES + 65536, MAX_REPLY = 262144, MAX_FETCHES = 4;
type Json = Record<string, unknown>;
type Fetch = (url: string, init: RequestInit) => Promise<Response>;
type Options = { fetchImpl?: Fetch; now?: () => number };
const publicErrors = new WeakMap<object, Readonly<{ code: string; status: number }>>();
class Denied extends Error {
  constructor(code: string, status = 403) { super(code); publicErrors.set(this, Object.freeze({ code, status })); }
}
function ensure(ok: unknown, code = 'CI_NODE_REQUEST_REFUSED', status = 400): asserts ok {
  if (!ok) throw new Denied(code, status);
}
function object(value: unknown, code?: string, status?: number): Json {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype, code, status);
  return value as Json;
}
function exact(value: Json, keys: readonly string[], code?: string, status?: number) {
  ensure(Reflect.ownKeys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k)), code, status);
}
const utf8 = new TextEncoder();
async function sha256(text: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(text))), b => b.toString(16).padStart(2, '0')).join('');
}
function result(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store', pragma: 'no-cache', 'x-content-type-options': 'nosniff' } });
}
async function boundedBody(body: ReadableStream<Uint8Array> | null, max: number, signal: AbortSignal, code: string, status: number): Promise<Uint8Array> {
  ensure(body, code, status);
  const reader = body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > max) { void reader.cancel().catch(() => {}); throw new Denied(code, status); }
      chunks.push(part.value);
    }
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
async function deadline<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
    controller.abort(); reject(new Denied('CI_NODE_GATEWAY_UNCONFIRMED', 503));
  }, 10_000); });
  try { return await Promise.race([run(controller.signal), timeout]); }
  finally { clearTimeout(timer); controller.abort(); }
}
function json(bytes: Uint8Array, code: string, status: number): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Denied(code, status); }
}

// Snapshot fields the verifier reads; the database returns exactly these.
const NODE_FIELDS = ['node_id', 'user_id', 'project_id', 'binding_id', 'binding_generation', 'version', 'key_version',
  'identity_fingerprint', 'identity_public_jwk', 'state', 'qualification_verified', 'publisher_approved',
  'binding_expires_at_ms', 'qualification_expires_at_ms'] as const;
function snapshot(doc: Json): { principal: CiAuthenticatedPrincipal; node: CiTrustedNodeSnapshot } {
  const principal = object(doc.principal, 'CI_NODE_GATEWAY_UNCONFIRMED', 503);
  exact(principal, ['user_id', 'project_id', 'binding_id', 'binding_generation'], 'CI_NODE_GATEWAY_UNCONFIRMED', 503);
  const node = object(doc.node, 'CI_NODE_GATEWAY_UNCONFIRMED', 503);
  exact(node, NODE_FIELDS, 'CI_NODE_GATEWAY_UNCONFIRMED', 503);
  return { principal: principal as unknown as CiAuthenticatedPrincipal, node: node as unknown as CiTrustedNodeSnapshot };
}

export function isCiNodeGatewayPath(pathname: string): boolean {
  return pathname === CI_NODE_COMMAND_PATH || pathname === CI_NODE_STATUS_PATH;
}

export async function handleCiNodeGatewayV1(request: Request, env: DatabaseGatewayEnv, options: Options = {}): Promise<Response> {
  try {
    const url = new URL(request.url);
    ensure(url.protocol === 'https:' && isCiNodeGatewayPath(url.pathname) && !url.search, 'CI_NODE_ROUTE_REFUSED', 404);
    ensure(request.method === 'POST', 'CI_NODE_METHOD_REFUSED', 405);
    ensure(request.headers.get('content-type')?.split(';')[0].trim() === 'application/json', 'CI_NODE_INPUT_REFUSED', 400);
    const auth = request.headers.get('authorization') ?? '';
    ensure(/^Bearer [\x21-\x7e]{16,1024}$/.test(auth), 'CI_NODE_TOKEN_REFUSED', 401);
    const tokenHash = await sha256(auth.slice(7));
    const input = object(json(await deadline(signal => boundedBody(request.body, MAX_REQUEST, signal, 'CI_NODE_INPUT_REFUSED', 400)),
      'CI_NODE_INPUT_REFUSED', 400), 'CI_NODE_INPUT_REFUSED', 400);
    const status = url.pathname === CI_NODE_STATUS_PATH;
    if (status) exact(input, ['node_id'], 'CI_NODE_INPUT_REFUSED', 400);
    else exact(input, ['command', 'payload'], 'CI_NODE_INPUT_REFUSED', 400);
    const command = status ? null : object(input.command, 'CI_NODE_INPUT_REFUSED', 400);
    const nodeId = status ? input.node_id : command!.node_id;
    ensure(typeof nodeId === 'string' && UUID.test(nodeId), 'CI_NODE_INPUT_REFUSED', 400);

    const dbToken = databaseGatewayToken(env);
    const { url: dbUrl, key: dbKey } = resolveSupabaseConfig(env);
    ensure(dbToken && dbKey && dbUrl, 'CI_NODE_GATEWAY_UNAVAILABLE', 503);
    const db = new URL(dbUrl);
    ensure(db.protocol === 'https:' && !db.username && !db.password && db.pathname === '/' && !db.search && !db.hash,
      'CI_NODE_GATEWAY_UNAVAILABLE', 503);
    const rawFetch = options.fetchImpl ?? ((u: string, i: RequestInit) => fetch(u, i)), clock = options.now ?? Date.now;
    // Trust read, trust re-read after the signature check, one mutation.
    let fetches = 0;
    const rpc = (name: 'clued_ci_node_trust_v1' | 'clued_ci_node_command_v1', body: Json) => deadline(async signal => {
      ensure(++fetches <= MAX_FETCHES, 'CI_NODE_GATEWAY_BOUND', 503);
      const target = db.origin + '/rest/v1/rpc/' + name;
      const response = await rawFetch(target, { method: 'POST', signal, redirect: 'error', cache: 'no-store', headers: {
        authorization: 'Bearer ' + dbToken, apikey: dbKey, 'content-type': 'application/json', accept: 'application/json',
      }, body: JSON.stringify(body) });
      ensure(response.status === 200 && (response.url === '' || response.url === target), 'CI_NODE_GATEWAY_UNCONFIRMED', 503);
      const length = response.headers.get('content-length');
      ensure(length === null || /^\d+$/.test(length) && Number(length) <= MAX_REPLY, 'CI_NODE_GATEWAY_UNCONFIRMED', 503);
      return object(json(await boundedBody(response.body, MAX_REPLY, signal, 'CI_NODE_GATEWAY_UNCONFIRMED', 503),
        'CI_NODE_GATEWAY_UNCONFIRMED', 503), 'CI_NODE_GATEWAY_UNCONFIRMED', 503);
    });
    const trust = async () => {
      const doc = await rpc('clued_ci_node_trust_v1', { p_token_hash: tokenHash, p_node_id: nodeId });
      ensure(doc.status === 'ok', 'CI_NODE_TRUST_REFUSED', 403);
      return doc;
    };

    if (status) {
      // Public facts about the caller's own node, so it can sign with the current
      // version and qualify against the current approved node list.
      const doc = await trust(); snapshot(doc);
      return result({ status: 'ok', node: doc.node, qualification: doc.qualification, node_list: doc.node_list, gateway_open: doc.gateway_open });
    }

    const first = snapshot(await trust());
    const principal = first.principal;
    let read = 0;
    const readTrustedNode = async (id: string): Promise<CiTrustedNodeSnapshot | null> => {
      if (id !== nodeId) return null;
      // The verifier reads before and after its crypto awaits; the first read is
      // the one above, the second is fresh. A refusal now (Binding revoked
      // meanwhile) is no trusted node, not a lookup outage.
      if (read++ === 0) return first.node;
      const doc = await rpc('clued_ci_node_trust_v1', { p_token_hash: tokenHash, p_node_id: nodeId });
      return doc.status === 'ok' ? snapshot(doc).node : null;
    };
    const verified = await verifyCiNodeCommand(command, input.payload, principal, readTrustedNode, clock);
    if (!verified.ok) throw new Denied('CI_NODE_' + verified.code, verified.code === 'TRUST_LOOKUP_FAILED' ? 503 : 403);
    const observation = verified.observation;
    ensure(HEX64.test(observation.nonce_sha256) && observation.payload_sha256 === command!.payload_sha256, 'CI_NODE_GATEWAY_UNCONFIRMED', 503);
    // The command exactly as signed (canonical, so key order and number forms
    // cannot differ from the signed bytes) and the payload as digested.
    const reply = await rpc('clued_ci_node_command_v1', {
      p_token_hash: tokenHash,
      p_command: JSON.parse(ciCanonicalJson(command)),
      p_payload: JSON.parse(ciCanonicalJson(input.payload, CI_MAX_PAYLOAD_BYTES)),
      p_verified: { operation: observation.operation, node_id: observation.node_id, payload_sha256: observation.payload_sha256,
        nonce_sha256: observation.nonce_sha256, verified_at_ms: observation.verified_at_ms },
    });
    if (reply.status === 'committed') {
      ensure(reply.operation === command!.operation, 'CI_NODE_GATEWAY_UNCONFIRMED', 503);
      return result(reply);
    }
    ensure(reply.status === 'rejected' && typeof reply.error_code === 'string' && /^[A-Z][A-Z0-9_]{2,80}(:[A-Za-z0-9_]{1,80})?$/.test(reply.error_code),
      'CI_NODE_GATEWAY_UNCONFIRMED', 503);
    return result({ status: 'refused', error_code: reply.error_code }, 409);
  } catch (error) {
    // No foreign error properties, coercion, instanceof or prototype traversal.
    const known = typeof error === 'object' && error !== null ? publicErrors.get(error) : undefined;
    return result({ status: 'refused', error_code: known?.code ?? 'CI_NODE_GATEWAY_UNCONFIRMED' }, known?.status ?? 503);
  }
}
