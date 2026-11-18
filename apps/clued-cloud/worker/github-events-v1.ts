import { databaseGatewayToken, resolveSupabaseConfig, type DatabaseGatewayEnv } from './database-gateway';

export const GITHUB_EVENTS_PATH = '/v1/github/events';
const MAX_BYTES = 2 * 1024 * 1024;
type Env = DatabaseGatewayEnv & {
  GITHUB_WEBHOOK_SECRET?: string;
};

interface Delivery {
  action?: unknown;
  number?: unknown;
  repository?: { full_name?: unknown; default_branch?: unknown };
  pull_request?: { merged?: unknown; base?: { ref?: unknown }; merge_commit_sha?: unknown };
}

function reply(status: number): Response {
  return new Response(null, { status, headers: { 'cache-control': 'no-store' } });
}

// 按实际读取的字节限流，兼容没有长度头的分块请求。
async function readBody(request: Request): Promise<Uint8Array<ArrayBuffer> | null> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);
  let bytes = new Uint8Array(0);
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const nextLength = length + value.byteLength;
      if (nextLength > MAX_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      if (nextLength > bytes.length) {
        const larger = new Uint8Array(Math.min(MAX_BYTES, Math.max(nextLength, 2 * bytes.length)));
        larger.set(bytes);
        bytes = larger;
      }
      bytes.set(value, length);
      length = nextLength;
    }
  } finally {
    reader.releaseLock();
  }
  return bytes.subarray(0, length);
}

export async function handleGitHubEvents(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (!env.GITHUB_WEBHOOK_SECRET || url.protocol !== 'https:' || url.pathname !== GITHUB_EVENTS_PATH || url.href.includes('?')) return reply(404);
  if (request.method !== 'POST') return reply(405);
  if (Number(request.headers.get('content-length')) > MAX_BYTES) return reply(413);
  const signature = request.headers.get('x-hub-signature-256');
  if (!signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return reply(401);

  const bytes = await readBody(request);
  if (!bytes) return reply(413);
  const mac = Uint8Array.from({ length: 32 }, (_, i) => parseInt(signature.slice(7 + 2 * i, 9 + 2 * i), 16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.GITHUB_WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  if (!(await crypto.subtle.verify('HMAC', key, mac, bytes))) return reply(401);
  if (request.headers.get('x-github-event') !== 'pull_request') return reply(204);

  let event: Delivery | null;
  try {
    event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return reply(400);
  }
  const pr = event?.pull_request;
  const repo = event?.repository;
  if (event?.action !== 'closed' || typeof pr?.merged !== 'boolean' || typeof repo?.default_branch !== 'string'
    || !repo.default_branch || pr.base?.ref !== repo.default_branch) return reply(204);
  if (typeof repo.full_name !== 'string' || !/^[a-z0-9_.-]{1,100}\/[a-z0-9_.-]{1,100}$/i.test(repo.full_name)
    || typeof event.number !== 'number' || !Number.isSafeInteger(event.number) || event.number < 1 || event.number > 9999999999) return reply(400);
  const mergeSha = pr.merged ? pr.merge_commit_sha : null;
  const p_input = { repository: repo.full_name, pr_number: event.number, merged: pr.merged,
    merge_sha: typeof mergeSha === 'string' && /^[0-9a-f]{40}$/i.test(mergeSha) ? mergeSha : null };

  try {
    const token = databaseGatewayToken(env);
    const { url: dbUrl, key: dbKey } = resolveSupabaseConfig(env);
    if (!dbUrl || !token || !dbKey) return reply(500);
    const db = new URL(dbUrl);
    if (db.protocol !== 'https:' || db.username || db.password || db.pathname !== '/' || db.search || db.hash) return reply(500);
    const response = await fetch(db.origin + '/rest/v1/rpc/clued_work_pr_merged_event_v1', {
      method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000),
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, apikey: dbKey },
      body: JSON.stringify({ p_input }),
    });
    // PostgREST 用 HTTP 状态报告数据库异常。投递方只需状态，认领 ID 留在网关内。
    await response.body?.cancel();
    return reply(response.status === 200 ? 200 : 500);
  } catch {
    return reply(500);
  }
}
