// Candidate serving-Worker successor. No policy activation door or seeded identity.
// Fresh OIDC authorizes this request, never the old no-exp attestation protocol.
// Raw OIDC / ephemeral GitHub read credentials exist only in request memory.
import type { ContinuityEnv } from './continuity';
import { databaseGatewayToken } from './database-gateway';

export const CI_SCAN_START_PATH = '/v1/ci/scan-start';
export const CI_SCAN_START_AUDIENCE = 'clued-ci-scan-start-v1';
const ISSUER = 'https://token.actions.githubusercontent.com';
const JWKS = ISSUER + '/.well-known/jwks';
const API = 'https://api.github.com';
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HEX40 = /^[a-f0-9]{40}$/, HEX64 = /^[a-f0-9]{64}$/;
const DIGITS = /^[1-9][0-9]{0,15}$/;
const REPO = /^[a-z0-9_.-]{1,100}\/[a-z0-9_.-]{1,100}$/;
const ROLE_NAMES = ['gitleaks', 'trivy', 'contract-placement'];
const REQUEST_FIELDS = ['contract', 'execution_id', 'claim_id', 'fence', 'epoch', 'pr', 'head_sha', 'base_sha', 'source_manifest_sha256', 'registry_sha256'];
type Json = Record<string, unknown>;
type Env = Pick<ContinuityEnv, 'SUPABASE_URL' | 'SUPABASE_PUBLISHABLE_KEY' | 'CLUED_DB_GATEWAY_TOKEN'>;
type Fetch = (url: string, init: RequestInit) => Promise<Response>;
type Options = { fetchImpl?: Fetch; now?: () => number };
const publicErrors = new WeakMap<object, Readonly<{ code: string; status: number }>>();
class Denied extends Error {
  constructor(code: string, status = 403) { super(code); publicErrors.set(this, Object.freeze({ code, status })); }
}
function require(ok: unknown, code = 'SCAN_START_PROOF_REFUSED', status = 403): asserts ok {
  if (!ok) throw new Denied(code, status);
}
function object(value: unknown): Json {
  require(value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype);
  return value as Json;
}
function exact(value: Json, keys: readonly string[]) {
  require(Reflect.ownKeys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k)));
}
function text(value: unknown, pattern: RegExp): string { require(typeof value === 'string' && pattern.test(value)); return value; }
function integer(value: unknown, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  require(typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max); return value;
}
const utf8 = new TextEncoder();
async function hash(bytes: Uint8Array<ArrayBuffer>, name = 'SHA-256'): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest(name, bytes)), b => b.toString(16).padStart(2, '0')).join('');
}
function b64url(value: string, max: number): Uint8Array<ArrayBuffer> {
  require(value.length > 0 && value.length <= max * 2 && /^[A-Za-z0-9_-]+$/.test(value));
  const decoded = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
  require(decoded.length > 0 && decoded.length <= max);
  const bytes = Uint8Array.from(decoded, c => c.charCodeAt(0));
  require(btoa(decoded).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_') === value);
  return bytes;
}
function jsonBytes(bytes: Uint8Array<ArrayBuffer>): unknown { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
async function boundedBody(body: ReadableStream<Uint8Array> | null, max: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  require(body, 'SCAN_START_TRANSPORT_UNCONFIRMED', 503);
  const reader = body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > max) { void reader.cancel().catch(() => {}); throw new Denied('SCAN_START_BODY_BOUND', 400); }
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
    controller.abort(); reject(new Denied('SCAN_START_TRANSPORT_UNCONFIRMED', 503));
  }, 10_000); });
  try { return await Promise.race([run(controller.signal), timeout]); }
  finally { clearTimeout(timer); controller.abort(); }
}
async function fetchJson(fetchImpl: Fetch, url: string, init: RequestInit, max = 262144, status = 200): Promise<unknown> {
  return deadline(async signal => {
    const response = await fetchImpl(url, { ...init, signal, redirect: 'error', cache: 'no-store' });
    require(response.status === status && (response.url === '' || response.url === url), 'SCAN_START_TRANSPORT_UNCONFIRMED', 503);
    const length = response.headers.get('content-length');
    require(length === null || /^\d+$/.test(length) && Number(length) <= max, 'SCAN_START_TRANSPORT_UNCONFIRMED', 503);
    return jsonBytes(await boundedBody(response.body, max, signal));
  });
}
function fresh(claims: Json, now: number) {
  const seconds = integer(Math.floor(now / 1000)), iat = integer(claims.iat), exp = integer(claims.exp), nbf = integer(claims.nbf);
  require(claims.iss === ISSUER && claims.aud === CI_SCAN_START_AUDIENCE && claims.runner_environment === 'github-hosted'
    && iat <= seconds + 5 && iat >= seconds - 120 && nbf <= seconds + 5 && nbf >= iat - 30 && nbf <= iat + 5
    && exp > seconds && exp > iat && exp - iat <= 600, 'SCAN_START_OIDC_REFUSED', 401);
}
async function verifiedClaims(token: string, fetchImpl: Fetch, now: number): Promise<Json> {
  require(token.length <= 8192, 'SCAN_START_OIDC_REFUSED', 401);
  const parts = token.split('.'); require(parts.length === 3, 'SCAN_START_OIDC_REFUSED', 401);
  const header = object(jsonBytes(b64url(parts[0], 2048))), claims = object(jsonBytes(b64url(parts[1], 6144)));
  require(Object.keys(header).every(k => ['alg', 'kid', 'typ', 'x5t'].includes(k)) && header.alg === 'RS256'
    && (header.typ === undefined || header.typ === 'JWT'), 'SCAN_START_OIDC_REFUSED', 401);
  const kid = text(header.kid, /^[A-Za-z0-9_.-]{1,128}$/), signature = b64url(parts[2], 1024);
  // One mandatory fixed-origin GET per request. No disk, isolate or verifier cache.
  const jwks = object(await fetchJson(fetchImpl, JWKS, { method: 'GET', headers: { accept: 'application/json' } }, 65536));
  exact(jwks, ['keys']); require(Array.isArray(jwks.keys) && jwks.keys.length > 0 && jwks.keys.length <= 32);
  const seen = new Set<string>(); let chosen: Json | null = null;
  for (const value of jwks.keys) {
    const key = object(value);
    require(Object.keys(key).every(k => ['kty', 'kid', 'use', 'alg', 'n', 'e', 'x5c', 'x5t'].includes(k))
      && key.kty === 'RSA' && (key.use === undefined || key.use === 'sig') && (key.alg === undefined || key.alg === 'RS256'));
    const id = text(key.kid, /^[A-Za-z0-9_.-]{1,128}$/); require(!seen.has(id)); seen.add(id);
    const modulus = b64url(text(key.n, /^[A-Za-z0-9_-]+$/), 1024);
    require(modulus.length >= 256 && modulus[0] >= 128 && key.e === 'AQAB');
    if (id === kid) { require(signature.length === modulus.length); chosen = key; }
  }
  require(chosen, 'SCAN_START_OIDC_REFUSED', 401);
  const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: text(chosen.n, /^[A-Za-z0-9_-]+$/), e: 'AQAB', alg: 'RS256' },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  require(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, utf8.encode(parts[0] + '.' + parts[1])), 'SCAN_START_OIDC_REFUSED', 401);
  fresh(claims, now); return claims;
}
function validPath(value: unknown): string {
  require(typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\\:\x00-\x1f\x7f]/.test(value)
    && !value.startsWith('/') && value.split('/').every(p => p && p !== '.' && p !== '..')); return value;
}
function result(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store', pragma: 'no-cache', 'x-content-type-options': 'nosniff' } });
}

export async function handleCiScanStartV1(request: Request, env: Env, options: Options = {}): Promise<Response> {
  try {
    const url = new URL(request.url);
    require(url.protocol === 'https:' && url.pathname === CI_SCAN_START_PATH && !url.search, 'SCAN_START_ROUTE_REFUSED', 404);
    require(request.method === 'POST', 'SCAN_START_METHOD_REFUSED', 405);
    require(request.headers.get('content-type')?.split(';')[0].trim() === 'application/json', 'SCAN_START_INPUT_REFUSED', 400);
    const auth = request.headers.get('authorization') ?? '';
    require(/^Bearer [A-Za-z0-9_.-]{16,8192}$/.test(auth), 'SCAN_START_OIDC_REFUSED', 401);
    const token = auth.slice(7), readToken = request.headers.get('x-github-read-token') ?? '';
    // Runtime GITHUB_TOKEN only; reject PAT/OAuth/Clued tokens. It is a bounded
    // fixed-GET capability, not authentication or a value forwarded to Native.
    require(/^ghs_[A-Za-z0-9_]{20,508}$/.test(readToken), 'SCAN_START_READ_CAPABILITY_REFUSED', 401);
    const input = object(jsonBytes(await deadline(signal => boundedBody(request.body, 16384, signal)))); exact(input, REQUEST_FIELDS);
    require(input.contract === 'clued.ci-scan-start-request/1', 'SCAN_START_INPUT_REFUSED', 400);
    for (const k of ['execution_id', 'claim_id']) text(input[k], UUID);
    for (const k of ['fence', 'epoch', 'pr']) integer(input[k]);
    for (const k of ['head_sha', 'base_sha']) text(input[k], HEX40);
    for (const k of ['source_manifest_sha256', 'registry_sha256']) text(input[k], HEX64);
    const rawFetch = options.fetchImpl ?? ((u: string, i: RequestInit) => fetch(u, i)), clock = options.now ?? Date.now;
    // One shared request budget includes JWKS, GitHub and both Native RPCs.
    // Refuse before issuing fetch 51; no assumption of a paid runtime allowance.
    let fetches = 0;
    const fetchImpl: Fetch = (u, i) => {
      require(++fetches <= 50, 'SCAN_START_PROOF_BOUND'); return rawFetch(u, i);
    };
    const claims = await verifiedClaims(token, fetchImpl, clock());
    const repository = text(claims.repository, /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/).toLowerCase();
    require(REPO.test(repository));
    const repositoryId = integer(Number(text(claims.repository_id, DIGITS)));
    const ownerId = integer(Number(text(claims.repository_owner_id, DIGITS)));
    require(typeof claims.repository_owner === 'string' && claims.repository_owner.toLowerCase() === repository.split('/')[0]);
    const dbToken = databaseGatewayToken(env), dbKey = env.SUPABASE_PUBLISHABLE_KEY;
    require(dbToken && dbKey && env.SUPABASE_URL, 'SCAN_START_GATEWAY_UNAVAILABLE', 503);
    const db = new URL(env.SUPABASE_URL);
    require(db.protocol === 'https:' && !db.username && !db.password && db.pathname === '/' && !db.search && !db.hash,
      'SCAN_START_GATEWAY_UNAVAILABLE', 503);
    const rpc = async (name: 'clued_ci_scan_start_policy_v1' | 'clued_ci_scan_start_hosted_v1', body: Json) =>
      object(await fetchJson(fetchImpl, db.origin + '/rest/v1/rpc/' + name, { method: 'POST', headers: {
        authorization: 'Bearer ' + dbToken, apikey: dbKey, 'content-type': 'application/json', accept: 'application/json',
      }, body: JSON.stringify(body) }, name === 'clued_ci_scan_start_policy_v1' ? 262144 : 65536));
    const policy = await rpc('clued_ci_scan_start_policy_v1', { p_input: { repository_id: repositoryId, repository } });
    require(policy.status === 'ok', 'SCAN_START_POLICY_INACTIVE');
    exact(policy, ['status', 'policy_id', 'repository_id', 'repository', 'repository_owner_id', 'scope', 'source_manifest_sha256', 'registry_sha256', 'roles', 'activated_at', 'hosted_head_sha']);
    const hostedHead = policy.hosted_head_sha;
    require(hostedHead === null || typeof hostedHead === 'string' && HEX40.test(hostedHead));
    require(hostedHead === null || hostedHead === input.head_sha, 'SCAN_START_HOSTED_HEAD_REFUSED');
    text(policy.policy_id, UUID);
    require(policy.repository === repository && policy.repository_id === repositoryId && policy.repository_owner_id === ownerId
      && policy.source_manifest_sha256 === input.source_manifest_sha256 && policy.registry_sha256 === input.registry_sha256);
    text(policy.scope, /^project:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
    require(typeof policy.activated_at === 'string' && Number.isFinite(Date.parse(policy.activated_at)) && Date.parse(policy.activated_at) <= clock());
    const roles = object(policy.roles), workflowRef = text(claims.workflow_ref, /^.+@refs\/pull\/[1-9][0-9]*\/merge$/);
    require(Object.keys(roles).length > 0 && Object.keys(roles).every(r => ROLE_NAMES.includes(r)));
    const matches: { role: string; pin: Json }[] = [], paths = new Set<string>();
    for (const [role, raw] of Object.entries(roles)) {
      const pin = object(raw); exact(pin, ['workflow_path', 'workflow_blob', 'workflow_sha256', 'check_name', 'hosted_allowed',
        'closure', 'must_not_exist', 'forbidden_change_prefixes']);
      const p = text(pin.workflow_path, /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/);
      text(pin.workflow_blob, HEX40); text(pin.workflow_sha256, HEX64);
      require(typeof pin.check_name === 'string' && pin.check_name.length > 0 && pin.check_name.length <= 100 && !/[\x00-\x1f\x7f]/.test(pin.check_name)
        && typeof pin.hosted_allowed === 'boolean' && !paths.has(p) && (role !== 'contract-placement' || pin.hosted_allowed === false)); paths.add(p);
      require(Array.isArray(pin.closure) && pin.closure.length >= 1 && pin.closure.length <= 64
        && Array.isArray(pin.must_not_exist) && pin.must_not_exist.length <= 64
        && Array.isArray(pin.forbidden_change_prefixes) && pin.forbidden_change_prefixes.length <= 64);
      const closurePaths = new Set<string>(); let workflowPinned = false;
      for (const item of pin.closure) {
        const entry = object(item); exact(entry, ['path', 'mode', 'blob', 'sha256']);
        const filePath = validPath(entry.path); require(!closurePaths.has(filePath)); closurePaths.add(filePath);
        require(entry.mode === '100644' || entry.mode === '100755'); text(entry.blob, HEX40); text(entry.sha256, HEX64);
        if (filePath === p) {
          require(entry.mode === '100644' && entry.blob === pin.workflow_blob && entry.sha256 === pin.workflow_sha256); workflowPinned = true;
        }
      }
      require(workflowPinned);
      const absentPaths = pin.must_not_exist.map(validPath);
      require(new Set(absentPaths).size === absentPaths.length && absentPaths.every(file => !closurePaths.has(file)));
      const forbiddenPrefixes = pin.forbidden_change_prefixes.map(value => {
        require(typeof value === 'string' && value.endsWith('/')); return validPath(value.slice(0, -1)) + '/';
      });
      require(new Set(forbiddenPrefixes).size === forbiddenPrefixes.length);
      if (workflowRef === repository + '/' + p + `@refs/pull/${input.pr}/merge`) matches.push({ role, pin });
    }
    require(matches.length === 1 && matches[0].pin.hosted_allowed === true);
    const { role, pin } = matches[0], merge = text(claims.sha, HEX40);
    require(claims.event_name === 'pull_request' && claims.sub === `repo:${claims.repository}:pull_request`
      && claims.ref === `refs/pull/${input.pr}/merge` && claims.base_ref === 'main'
      && claims.workflow_sha === merge && (claims.job_workflow_sha === undefined || claims.job_workflow_sha === merge)
      && (claims.job_workflow_ref === undefined || claims.job_workflow_ref === workflowRef));
    const runId = text(claims.run_id, DIGITS), attempt = integer(Number(text(claims.run_attempt, /^[1-9][0-9]{0,5}$/)), 1, 1_000_000);
    integer(Number(runId)); // GitHub JSON IDs must remain exact JavaScript integers.
    const checkId = integer(Number(text(claims.check_run_id, DIGITS)));
    const prefix = '/repos/' + repository;
    const get = async (route: string, max = 262144, status = 200) => {
      fresh(claims, clock());
      return fetchJson(fetchImpl, API + prefix + route, { method: 'GET', headers: {
      authorization: 'Bearer ' + readToken, accept: 'application/vnd.github+json', 'x-github-api-version': '2026-03-10',
      'user-agent': 'clued-ci-scan-start-v1',
      } }, max, status);
    };
    const repo = object(await get(''));
    require(repo.id === repositoryId && repo.full_name === claims.repository && object(repo.owner).id === ownerId && repo.fork === false);
    const readPr = async () => {
      const p = object(await get('/pulls/' + input.pr)), head = object(p.head), base = object(p.base);
      require(p.number === input.pr && p.state === 'open' && p.draft === false && head.sha === input.head_sha && base.sha === input.base_sha
        && base.ref === 'main' && head.ref === claims.head_ref && p.merge_commit_sha === merge
        && object(head.repo).id === repositoryId && object(base.repo).id === repositoryId
        && object(head.repo).full_name === claims.repository && object(base.repo).full_name === claims.repository);
      integer(p.changed_files, 1, 2000); return p;
    };
    const pr = await readPr();
    // Public locator from the protected Stage1 App. It is an additional binding,
    // never a replacement for the private Native claim/epoch/head grant check.
    let listed = 0, total = -1; const admission: Json[] = [], checkIds = new Set<number>();
    for (let page = 1; total < 0 || listed < total; page++) {
      const packet = object(await get(`/commits/${input.head_sha}/check-runs?per_page=100&filter=all&app_id=5368905&page=${page}`));
      const count = integer(packet.total_count, 0, 2000);
      require((total < 0 || total === count) && Array.isArray(packet.check_runs) && packet.check_runs.length <= 100
        && (count === 0 || packet.check_runs.length > 0)); total = count;
      require(listed + packet.check_runs.length <= total);
      for (const raw of packet.check_runs) {
        const check = object(raw), id = integer(check.id);
        require(!checkIds.has(id) && object(check.app).id === 5368905 && check.head_sha === input.head_sha); checkIds.add(id);
        if (check.name === 'kooyumi-work-admission') admission.push(check);
      }
      listed += packet.check_runs.length;
    }
    require(admission.length === 1 && admission[0].status === 'completed' && admission[0].conclusion === 'success');
    const summary = object(admission[0].output).summary, marker = 'clued-scan-start-subject/1 ';
    require(typeof summary === 'string' && summary.length <= 65536 && summary.split(marker).length === 2);
    const lines = summary.split(/\r?\n/).filter(line => line.startsWith(marker));
    require(lines.length === 1 && lines[0].length <= 2048);
    const declared = object(JSON.parse(lines[0].slice(marker.length)));
    exact(declared, ['claim_id', 'fence', 'epoch', 'source_manifest_sha256', 'registry_sha256']);
    require(['claim_id', 'fence', 'epoch', 'source_manifest_sha256', 'registry_sha256'].every(k => declared[k] === input[k]));
    const run = object(await get(`/actions/runs/${runId}/attempts/${attempt}`));
    require(run.id === Number(runId) && run.run_attempt === attempt && run.event === 'pull_request' && run.head_sha === input.head_sha
      && run.path === pin.workflow_path && run.status === 'in_progress' && run.conclusion === null
      && object(run.repository).id === repositoryId && object(run.head_repository).id === repositoryId);
    const jobs = object(await get(`/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`));
    require(Array.isArray(jobs.jobs) && integer(jobs.total_count, 1, 100) === jobs.jobs.length);
    // Bind by the job's actual check-run link, not an assumed equality between
    // the independent job and Check Run numeric identifiers.
    const selected = jobs.jobs.map(object).filter(j => j.check_run_url === API + prefix + '/check-runs/' + checkId); require(selected.length === 1);
    const job = selected[0];
    const jobId = integer(job.id);
    require(job.run_id === Number(runId) && job.head_sha === input.head_sha && job.name === pin.check_name
      && job.status === 'in_progress' && job.conclusion === null && job.check_run_url === API + prefix + '/check-runs/' + checkId
      && Array.isArray(job.labels) && job.labels.length > 0 && job.labels.length <= 16
      && job.labels.every(label => typeof label === 'string' && label.length <= 100 && label !== 'self-hosted'));
    const check = object(await get('/check-runs/' + checkId));
    require(check.id === checkId && check.name === pin.check_name && check.head_sha === input.head_sha && object(check.app).id === 15368
      && check.status === 'in_progress' && check.conclusion === null
      && check.details_url === `https://github.com/${claims.repository}/actions/runs/${runId}/job/${jobId}`);
    const commit = object(await get('/git/commits/' + merge)), head = object(await get('/git/commits/' + input.head_sha));
    const mergeTree = text(object(commit.tree).sha, HEX40), headTree = text(object(head.tree).sha, HEX40);
    require(commit.sha === merge && head.sha === input.head_sha && mergeTree === headTree
      && Array.isArray(commit.parents) && commit.parents.length === 2 && object(commit.parents[0]).sha === input.base_sha
      && object(commit.parents[1]).sha === input.head_sha);
    const changed = new Set<string>(), filenames = new Set<string>(); let files = 0;
    for (let page = 1; files < Number(pr.changed_files); page++) {
      const rows = await get(`/pulls/${input.pr}/files?per_page=100&page=${page}`);
      require(Array.isArray(rows) && rows.length > 0 && rows.length <= 100 && files + rows.length <= Number(pr.changed_files));
      for (const row of rows) {
        const f = object(row), filename = validPath(f.filename); require(!filenames.has(filename)); filenames.add(filename); changed.add(filename);
        require(typeof f.status === 'string' && ['added', 'modified', 'removed', 'renamed', 'copied', 'changed', 'unchanged'].includes(f.status));
        if (f.status === 'renamed') changed.add(validPath(f.previous_filename));
      }
      files += rows.length;
    }
    require(files === pr.changed_files && changed.size > 0 && changed.size <= 2000);
    // E1 is a pre-start gate. A later attestation cannot undo a burned global K.
    const forbidden = ['.github/', 'scripts/ci/', ...(pin.forbidden_change_prefixes as string[])];
    require([...changed].every(file => file.split('/').at(-1) !== '.gitattributes'
      && !forbidden.some(path => file === path.slice(0, -1) || file.startsWith(path))));
    const base = object(await get('/git/commits/' + input.base_sha)); require(base.sha === input.base_sha);
    const baseTree = text(object(base.tree).sha, HEX40);
    // One complete immutable recursive tree per distinct T/H/B root. A missing
    // or truncated inventory is never an absence proof. This avoids one GET per
    // directory without giving up ancestor mode or all-.gitattributes checks.
    const trees = new Map<string, Map<string, Json>>();
    const closurePaths = new Set((pin.closure as Json[]).map(entry => entry.path as string));
    const readTree = async (sha: string) => {
      let rows = trees.get(sha); if (rows) return rows;
      const packet = object(await get('/git/trees/' + sha + '?recursive=1', 8 * 1024 * 1024));
      require(packet.sha === sha && packet.truncated === false && Array.isArray(packet.tree) && packet.tree.length <= 32000);
      rows = new Map<string, Json>();
      for (const raw of packet.tree) {
        const entry = object(raw), name = validPath(entry.path); require(!rows.has(name));
        text(entry.sha, HEX40);
        require(entry.type === 'tree' && entry.mode === '040000' || entry.type === 'blob' && ['100644', '100755', '120000'].includes(entry.mode as string)
          || entry.type === 'commit' && entry.mode === '160000'); rows.set(name, entry);
        if (name.split('/').at(-1) === '.gitattributes') require(closurePaths.has(name));
      }
      for (const name of rows.keys()) {
        const segments = name.split('/');
        for (let i = 1; i < segments.length; i++) {
          const ancestor = rows.get(segments.slice(0, i).join('/'));
          require(ancestor?.type === 'tree' && ancestor.mode === '040000');
        }
      }
      trees.set(sha, rows); return rows;
    };
    const atPath = async (root: string, filePath: string): Promise<Json | null> => {
      const segments = filePath.split('/'), rows = await readTree(root);
      for (let i = 0; i < segments.length; i++) {
        const entry = rows.get(segments.slice(0, i + 1).join('/')); if (!entry) return null;
        if (i === segments.length - 1) return entry;
        require(entry.type === 'tree' && entry.mode === '040000');
      }
      throw new Denied('SCAN_START_PROOF_REFUSED');
    };
    const blobs = new Map<string, string>(), absentProofs = new Set<string>();
    const routeFor = (filePath: string, ref: string) => '/contents/' + filePath.split('/').map(encodeURIComponent).join('/') + '?ref=' + ref;
    const refs = [{ ref: merge, tree: mergeTree }, { ref: input.head_sha as string, tree: headTree }, { ref: input.base_sha as string, tree: baseTree }];
    for (const { ref, tree } of refs) {
      for (const raw of pin.closure as Json[]) {
        const entry = object(raw), filePath = entry.path as string, actual = await atPath(tree, filePath);
        require(actual && actual.type === 'blob' && actual.mode === entry.mode && actual.sha === entry.blob);
        const blob = entry.blob as string;
        let sha256 = blobs.get(blob);
        if (sha256 === undefined) {
          const file = object(await get('/git/blobs/' + blob, 524288));
          require(file.sha === blob && file.encoding === 'base64' && typeof file.content === 'string' && /^[A-Za-z0-9+/=\n\r]*$/.test(file.content));
          const decoded = atob(file.content.replace(/[\r\n]/g, ''));
          require(decoded.length <= 262144 && file.size === decoded.length);
          const bytes = Uint8Array.from(decoded, c => c.charCodeAt(0)), header = utf8.encode('blob ' + bytes.length + '\0');
          const gitBlob = new Uint8Array(header.length + bytes.length); gitBlob.set(header); gitBlob.set(bytes, header.length);
          require(await hash(gitBlob, 'SHA-1') === blob);
          sha256 = await hash(bytes); blobs.set(blob, sha256);
        }
        require(sha256 === entry.sha256);
      }
      for (const filePath of pin.must_not_exist as string[]) {
        require(await atPath(tree, filePath) === null);
        const key = tree + ':' + filePath;
        if (!absentProofs.has(key)) {
          const absent = object(await get(routeFor(filePath, ref), 4096, 404));
          require(absent.message === 'Not Found' && (absent.status === undefined || absent.status === '404'));
          absentProofs.add(key);
        }
      }
    }
    const latest = await readPr(); require(latest.changed_files === pr.changed_files);
    fresh(claims, clock());
    const verifiedAt = clock(), verified: Json = { policy_id: policy.policy_id, execution_id: input.execution_id,
      claim_id: input.claim_id, fence: input.fence, epoch: input.epoch, pr: input.pr, head_sha: input.head_sha, base_sha: input.base_sha,
      changed_paths: [...changed].sort(), source_manifest_sha256: policy.source_manifest_sha256, registry_sha256: policy.registry_sha256,
      workflow_path: pin.workflow_path, workflow_blob: pin.workflow_blob, workflow_sha256: pin.workflow_sha256,
      run_id: runId, run_attempt: attempt, token_sha256: await hash(utf8.encode(token)), claims_sha256: await hash(utf8.encode(JSON.stringify(claims))),
      verified_at: new Date(verifiedAt).toISOString(), expires_at: new Date(Number(claims.exp) * 1000).toISOString() };
    fresh(claims, clock());
    // Exactly one mutation. Lost/unknown replies never become launch permission.
    const grant = await rpc('clued_ci_scan_start_hosted_v1', { p_verified: verified });
    require(grant.status === 'committed' && grant.launch_allowed === true, 'SCAN_START_DENIED', 409);
    exact(grant, ['status', 'contract', 'launch_allowed', 'execution_id', 'receipt_id', 'repository_id', 'head_sha', 'role', 'provider', 'start_requested_at']);
    require(grant.contract === 'clued.ci-scan-start-grant/1' && grant.execution_id === input.execution_id && grant.repository_id === repositoryId
      && grant.head_sha === input.head_sha && grant.role === role && grant.provider === 'github-actions');
    text(grant.receipt_id, UUID);
    require(typeof grant.start_requested_at === 'string' && Number.isFinite(Date.parse(grant.start_requested_at))
      && new Date(grant.start_requested_at).toISOString() === grant.start_requested_at
      && Date.parse(grant.start_requested_at) >= verifiedAt - 5000 && Date.parse(grant.start_requested_at) <= clock() + 5000);
    fresh(claims, clock());
    return result(grant);
  } catch (error) {
    // No foreign error properties, coercion, instanceof or prototype traversal:
    // fetch/runtime failures may themselves be hostile objects or proxies.
    const known = typeof error === 'object' && error !== null ? publicErrors.get(error) : undefined;
    return result({ status: 'refused', launch_allowed: false,
      error_code: known?.code ?? 'SCAN_START_UNCONFIRMED' }, known?.status ?? 503);
  }
}
