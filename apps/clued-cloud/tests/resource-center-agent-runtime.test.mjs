import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build, stop } from 'esbuild';
import { Miniflare } from 'miniflare';

// The suite uses --test-force-exit for legacy fixtures. Miniflare owns native
// Windows close callbacks that must drain naturally. Run this exact test in a
// bounded child without force-exit; require a successful natural process exit.
// Neither assertions nor runtime failures are skipped or converted to PASS.
if (process.env.CLUED_STORAGE_RUNTIME_CHILD !== '1') {
  test('native workerd Agent transport and natural runtime cleanup', { timeout: 40000 }, async () => {
    const env = { ...process.env, CLUED_STORAGE_RUNTIME_CHILD: '1' };
    delete env.NODE_TEST_CONTEXT;
    const { stdout } = await promisify(execFile)(process.execPath, ['--test', '--test-reporter=tap', fileURLToPath(import.meta.url)], {
      env, timeout: 30000,
    });
    assert.match(stdout, /ok 1 - native workerd MCP transport/);
    assert.match(stdout, /# pass 1/);
    assert.match(stdout, /# fail 0/);
  });
} else test('native workerd MCP transport shares jobs RPC with exact Binding hash; no provider access while executor is off', async () => {
  const { outputFiles } = await build({ stdin: {
    resolveDir: fileURLToPath(new URL('../', import.meta.url)), sourcefile: 'storage-agent-runtime.ts', contents: `
      import {handleContinuityRequest} from './worker/continuity.ts';
      export default {fetch(request,env,ctx){return handleContinuityRequest(request,{
        CLUED_STORAGE_ACCOUNT_V1:'true', CLUED_STORAGE_JOBS_V1:'true',
        SUPABASE_URL:'https://db.example.invalid', SUPABASE_PUBLISHABLE_KEY:'fixture-public-key'
      },ctx);}};`,
  }, bundle: true, platform: 'node', format: 'esm', write: false });
  stop();
  const ref = { connection_id: '20000000-0000-4000-8000-000000000001', job_id: '10000000-0000-4000-8000-000000000001' };
  const token = 'clued_bnd_' + 'a'.repeat(40), calls = [];
  const runtime = new Miniflare({ host: '127.0.0.1', port: 0, cf: false, telemetry: { enabled: false }, workers: [{
    config: { name: 'storage-agent-runtime-fixture', type: 'worker', compatibilityDate: '2026-08-23', compatibilityFlags: ['nodejs_compat'],
      manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents: outputFiles[0].text } } } },
    dev: { outboundService: { type: 'fetcher', handler: async request => {
      assert.equal(request.url, 'https://db.example.invalid/rest/v1/rpc/clued_storage_jobs_v1');
      assert.equal(request.headers.get('authorization'), 'Bearer fixture-public-key');
      const body = await request.json(); calls.push(body);
      assert.equal(body.p_token_hash, createHash('sha256').update(token).digest('hex'));
      return Response.json({ ...ref, status: 'queued', request_digest: 'a'.repeat(64), intent_id: null,
        receipt_id: '30000000-0000-4000-8000-000000000001', execution_permitted: false, credential_envelope: 'never-public' });
    } } },
  }] });
  const rpc = (method, params) => runtime.dispatchFetch('http://localhost/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  try {
    const tools = (await (await rpc('tools/list', {})).json()).result.tools;
    assert.equal(tools.filter(x => x.name.startsWith('clued_storage_')).length, 2);
    const mutation = { operation: 'create', target_kind: 'directory', destination_path: 'G:/My Drive/Clued_资料中心/track/topic', directory_semantics: 'topic' };
    for (const [name, args] of [['clued_storage_submit', { ...ref, mutation }], ['clued_storage_inspect', ref]]) {
      const response = await rpc('tools/call', { name, arguments: args });
      assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      const result = (await response.json()).result;
      assert.equal(result.isError, false); assert.equal(result.structuredContent.status, 'queued');
      assert.equal(JSON.stringify(result).includes('never-public'), false);
    }
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(x => x.p_input), [{ ...ref, mutation, action: 'submit' }, { ...ref, action: 'inspect' }]);
  } finally { await runtime.dispose(); }
});
