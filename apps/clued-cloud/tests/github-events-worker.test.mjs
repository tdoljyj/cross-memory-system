import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import test from 'node:test';
import { loadContinuityWorker } from './worker-continuity-loader.mjs';

const worker = await loadContinuityWorker();
const secret = randomBytes(32).toString('hex');
const env = { GITHUB_WEBHOOK_SECRET: secret, CLUED_DB_GATEWAY_TOKEN: 'test-gateway',
  SUPABASE_URL: 'https://db.example.test', SUPABASE_PUBLISHABLE_KEY: 'test-key' };
const url = 'https://app.example.test/v1/github/events';
const sha = 'AB'.repeat(20);
const merged = { action: 'closed', number: 1161, repository: { full_name: 'Org/Repo', default_branch: 'trunk' },
  pull_request: { merged: true, base: { ref: 'trunk' }, merge_commit_sha: sha } };
const bytes = Buffer.from(JSON.stringify({ ...merged, title: '合入' }, null, 2) + '\n');
const sign = body => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

function deliver({ body = bytes, signature = sign(body), event = 'pull_request', environment = env,
  target = url, method = 'POST', headers = {} } = {}) {
  return worker.fetch(new Request(target, { method, ...(method === 'POST' ? { body } : {}),
    ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
    headers: { 'content-type': 'application/json', 'x-github-event': event,
      ...(signature ? { 'x-hub-signature-256': signature } : {}), ...headers } }), environment);
}

test('原始字节验签后，合入和关闭未合入的投递各送达网关一次', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (target, init) => {
    calls.push(JSON.parse(init.body));
    assert.equal(target, env.SUPABASE_URL + '/rest/v1/rpc/clued_work_pr_merged_event_v1');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    const headers = new Headers(init.headers);
    assert.equal(headers.get('authorization'), 'Bearer test-gateway');
    assert.equal(headers.get('apikey'), 'test-key');
    assert.equal(headers.has('x-hub-signature-256'), false);
    return Response.json({ status: 'ok', finished: 1, released: [] });
  });
  for (const mergeSha of [sha, null, undefined, '123abcd', 42]) {
    const body = mergeSha === sha ? bytes : JSON.stringify({ ...merged, pull_request: { ...merged.pull_request, merge_commit_sha: mergeSha } });
    assert.equal((await deliver({ body }))?.status, 200);
    assert.deepEqual(calls.splice(0), [{ p_input: { repository: 'Org/Repo', pr_number: 1161, merge_sha: mergeSha === sha ? sha : null } }]);
  }
  const body = JSON.stringify({ ...merged, pull_request: { ...merged.pull_request, merged: false } });
  assert.equal((await deliver({ body }))?.status, 200);
  assert.deepEqual(calls, [{ p_input: { repository: 'Org/Repo', pr_number: 1161, merged: false, merge_sha: null } }]);
});

test('已签名合入事件兼容只接受三个字段的旧数据库函数', async t => {
  const database = t.mock.method(globalThis, 'fetch', async (_target, init) => {
    const { p_input } = JSON.parse(init.body);
    const allowed = ['repository', 'pr_number', 'merge_sha'];
    if (Object.keys(p_input).some(key => !allowed.includes(key))) {
      return Response.json({ code: '22023' }, { status: 400 });
    }
    return Response.json({ status: 'ok', finished: 1, released: [] });
  });

  const response = await deliver();
  assert.equal(database.mock.callCount(), 1);
  assert.equal(response?.status, 200);
  assert.deepEqual(JSON.parse(database.mock.calls[0].arguments[1].body), {
    p_input: { repository: 'Org/Repo', pr_number: 1161, merge_sha: sha },
  });
});

test('生产形态环境中的已签名合入事件送达默认数据库', async t => {
  const database = t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ status: 'ok', finished: 1, released: [] }));
  const response = await deliver({ environment: { GITHUB_WEBHOOK_SECRET: secret, CLUED_DB_GATEWAY_TOKEN: 'test-gateway' } });

  assert.equal(response?.status, 200);
  assert.equal(database.mock.callCount(), 1);
  const [target, init] = database.mock.calls[0].arguments;
  assert.equal(target, 'https://ccxsikzwxlolxqlosril.supabase.co/rest/v1/rpc/clued_work_pr_merged_event_v1');
  const headers = new Headers(init.headers);
  assert.equal(headers.get('authorization'), 'Bearer test-gateway');
  assert.match(headers.get('apikey') ?? '', /^sb_publishable_/);
  assert.deepEqual(JSON.parse(init.body), {
    p_input: { repository: 'Org/Repo', pr_number: 1161, merge_sha: sha },
  });
});

test('无效签名、无关事件和关闭的路由都不会调用网关', async t => {
  const db = t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected database call'); });
  for (const [options, status] of [
    [{ signature: null }, 401], [{ signature: 'sha256=' + '0'.repeat(64) }, 401],
    [{ body: Buffer.concat([bytes, Buffer.from(' ')]), signature: sign(bytes) }, 401],
    [{ signature: 'sha256=' + 'a'.repeat(63) }, 401], [{ event: 'ping', signature: null }, 401],
    [{ event: 'ping' }, 204], [{ body: JSON.stringify({ ...merged, action: 'opened' }) }, 204],
    [{ body: JSON.stringify({ ...merged, pull_request: { ...merged.pull_request, merged: undefined } }) }, 204],
    [{ body: JSON.stringify({ ...merged, pull_request: { ...merged.pull_request, merged: 'false' } }) }, 204],
    [{ body: JSON.stringify({ ...merged, pull_request: { ...merged.pull_request, base: { ref: 'main' } } }) }, 204],
    [{ body: JSON.stringify({ action: 'closed', pull_request: { merged: true } }) }, 204],
    [{ body: '{' }, 400], [{ environment: { ...env, GITHUB_WEBHOOK_SECRET: undefined } }, 404],
    [{ method: 'GET' }, 405], [{ target: url + '?q=1' }, 404], [{ target: url.replace('https:', 'http:') }, 404],
    [{ body: Buffer.alloc(2 * 1024 * 1024 + 1), headers: { 'content-length': '1' } }, 413],
  ]) {
    assert.equal((await deliver(options))?.status, status);
    assert.equal(db.mock.callCount(), 0);
  }
});

test('无长度头的分块请求允许恰好 2 MiB，多一个字节即拒绝', async t => {
  const db = t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected database call'); });
  const bytes = Buffer.alloc(2 * 1024 * 1024);
  for (const extra of [0, 1]) {
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(bytes.subarray(0, 100));
      controller.enqueue(bytes.subarray(100));
      if (extra) controller.enqueue(Uint8Array.of(0));
      controller.close();
    } });
    const signature = sign(extra ? Buffer.concat([bytes, Buffer.alloc(1)]) : bytes);
    assert.equal((await deliver({ body, signature, event: 'ping' }))?.status, extra ? 413 : 204);
  }
  assert.equal(db.mock.callCount(), 0);
});

test('网关异常返回 500，响应体不暴露上游详情', async t => {
  const db = t.mock.method(globalThis, 'fetch', async () => new Response('private error', { status: 503 }));
  for (const mode of ['http', 'network']) {
    if (mode === 'network') db.mock.mockImplementation(async () => { throw new Error('private error'); });
    const response = await deliver();
    assert.equal(response?.status, 500);
    assert.doesNotMatch(await response.text(), /private error/);
  }
  assert.equal(db.mock.callCount(), 2);
});
