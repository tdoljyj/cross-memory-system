import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertLocalGatewayConfig, assertLocalGatewayUrl, createLocalGatewayToken, localGatewayChildEnv }
  from '../evals/public-mcp/gateway-token.mjs';
import { WorkerHost } from '../evals/information-flow-e2e/harness.mjs';
import { assertNoSecrets, redact } from '../evals/information-flow-e2e/evidence.mjs';

const status = { apiUrl: 'http://127.0.0.1:54321', jwtSecret: 'synthetic-local-only-signing-secret-at-least-32-bytes' };
const now = 1000;

test('local gateway token has a verified HS256 signature, exact gateway role and bounded lifetime', () => {
  const token = createLocalGatewayToken(status, { now, ttlSeconds: 900 });
  const [header, payload, signature] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'HS256', typ: 'JWT' });
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url')),
    { role: 'clued_worker_gateway', iat: now, exp: now + 900 });
  assert.equal(signature, createHmac('sha256', status.jwtSecret).update(`${header}.${payload}`).digest('base64url'));
  assert.notEqual(signature, createHmac('sha256', 'wrong-synthetic-secret').update(`${header}.${payload}`).digest('base64url'));
  assert.doesNotThrow(() => assertLocalGatewayConfig({ gatewayOrigin: status.apiUrl, gatewayToken: token }, now));
});

test('local signer fails closed on missing secret, non-loopback origin and excessive TTL without exposing inputs', () => {
  for (const jwtSecret of [undefined, null, '', ' ', 'too-short']) {
    assert.throws(() => createLocalGatewayToken({ ...status, jwtSecret }, { now }), /JWT_SECRET/);
  }
  for (const apiUrl of ['https://production.supabase.co', 'http://localhost.attacker.invalid',
    'http://127.0.0.1@attacker.invalid', 'file:///tmp/db', 'http://127.0.0.1:54321/path',
    'http://user:synthetic-password@localhost:54321', 'http://localhost:54321?secret=synthetic-value']) {
    assert.throws(() => createLocalGatewayToken({ ...status, apiUrl }, { now }), (error) => {
      assert.equal(error.message.includes(apiUrl), false);
      assert.equal(error.message.includes(status.jwtSecret), false);
      return /loopback/.test(error.message);
    });
  }
  for (const ttlSeconds of [0, -1, 3601, Infinity, 1.5]) {
    assert.throws(() => createLocalGatewayToken(status, { now, ttlSeconds }), /lifetime/);
  }
  for (const url of ['http://localhost:54321', 'http://127.0.0.1:54321', 'http://[::1]:54321']) {
    assert.doesNotThrow(() => assertLocalGatewayUrl(url));
  }
});

test('the same local configuration signs a fresh Phase B token after the Phase A token expires', () => {
  const phaseAToken = createLocalGatewayToken(status, { now, ttlSeconds: 1 });
  const phaseBNow = now + 2;
  assert.throws(() => assertLocalGatewayConfig({ gatewayOrigin: status.apiUrl, gatewayToken: phaseAToken }, phaseBNow), /short-lived/);
  const phaseBToken = createLocalGatewayToken(status, { now: phaseBNow, ttlSeconds: 900 });
  assert.notEqual(phaseBToken, phaseAToken);
  assert.doesNotThrow(() => assertLocalGatewayConfig({ gatewayOrigin: status.apiUrl, gatewayToken: phaseBToken }, phaseBNow));
  const [header, payload, signature] = phaseBToken.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url')),
    { role: 'clued_worker_gateway', iat: phaseBNow, exp: phaseBNow + 900 });
  assert.equal(signature, createHmac('sha256', status.jwtSecret).update(`${header}.${payload}`).digest('base64url'));
});

test('Worker configuration refuses absent, expired, long-lived and anon/service_role gateway tokens', () => {
  const token = createLocalGatewayToken(status, { now, ttlSeconds: 900 });
  const [header, payload, signature] = token.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url'));
  const altered = (changes) => `${header}.${Buffer.from(JSON.stringify({ ...claims, ...changes })).toString('base64url')}.${signature}`;
  for (const gatewayToken of [undefined, '', 'synthetic-invalid-jwt', altered({ role: 'anon' }),
    altered({ role: 'authenticated' }), altered({ role: 'service_role' }), altered({ exp: now }),
    altered({ iat: now + 1 }), altered({ exp: now + 3601 })]) {
    assert.throws(() => assertLocalGatewayConfig({ gatewayOrigin: status.apiUrl, gatewayToken }, now), /short-lived/);
  }
  assert.throws(() => assertLocalGatewayConfig({ gatewayOrigin: 'https://production.supabase.co', gatewayToken: token }, now), /loopback/);
});

test('WorkerHost rejects unsafe credentials before spawning and retains gateway JWT only in IPC configuration', () => {
  const gatewayToken = createLocalGatewayToken(status);
  assert.throws(() => new WorkerHost({ gatewayOrigin: status.apiUrl }), /short-lived/);
  assert.throws(() => new WorkerHost({ gatewayOrigin: 'https://production.supabase.co', gatewayToken }), /loopback/);
  const host = new WorkerHost({ gatewayOrigin: status.apiUrl, gatewayToken, publishableKey: 'synthetic-public-key', env: {} });
  assert.equal(host.config.gatewayToken, gatewayToken);
  assert.equal(host.env.CLUED_DB_GATEWAY_TOKEN, undefined);
  assert.equal(host.child, undefined);
  const evidence = JSON.stringify(redact({ log: `failure ${gatewayToken}`, config: host.config }));
  assert.equal(evidence.includes(gatewayToken), false);
  assertNoSecrets(evidence, 'synthetic Worker evidence');
});

test('isolated child environment excludes production credentials and caller gateway/signing material', () => {
  const source = { PATH: 'synthetic-path', SystemRoot: 'synthetic-windows', SUPABASE_ACCESS_TOKEN: 'synthetic-production-token',
    SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-role', SUPABASE_PUBLISHABLE_KEY: 'synthetic-remote-key',
    SUPABASE_URL: 'https://production.supabase.co', JWT_SECRET: status.jwtSecret,
    CLUED_DB_GATEWAY_TOKEN: 'synthetic-production-gateway', CLOUDFLARE_API_TOKEN: 'synthetic-cloudflare-token',
    OPENAI_API_KEY: 'synthetic-model-key' };
  const env = localGatewayChildEnv(source);
  assert.equal(env.PATH, source.PATH);
  assert.equal(env.SystemRoot, source.SystemRoot);
  for (const key of Object.keys(source).filter((key) => !['PATH', 'SystemRoot'].includes(key))) assert.equal(key in env, false);
  assert.equal(env.WRANGLER_SEND_METRICS, 'false');
});

test('IPC Worker host supplies a real signed gateway JWT to the loopback HTTP boundary without logging it',
  { timeout: 30000 }, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-local-gateway-'));
    let verified = false;
    const server = http.createServer((request, response) => {
      const token = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
      const [header, payload, signature] = token.split('.');
      verified = signature === createHmac('sha256', status.jwtSecret).update(`${header}.${payload}`).digest('base64url')
        && JSON.parse(Buffer.from(payload, 'base64url')).role === 'clued_worker_gateway';
      response.writeHead(verified ? 200 : 401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ verified }));
    });
    let host;
    try {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const apiUrl = `http://127.0.0.1:${server.address().port}`;
      const gatewayToken = createLocalGatewayToken({ ...status, apiUrl });
      // The bundle contains variable references only; JWT and signing secret stay in memory.
      await fs.writeFile(path.join(directory, 'worker.js'), `export default { async fetch(request, env) {
        return fetch(env.SUPABASE_URL + '/rest/v1/rpc/synthetic_gateway_probe', {
          method: 'POST', headers: { Authorization: 'Bearer ' + env.CLUED_DB_GATEWAY_TOKEN }, body: '{}' });
      } };`);
      host = new WorkerHost({ bundleDir: directory, persistDir: path.join(directory, 'persist'),
        gatewayOrigin: apiUrl, gatewayToken, publishableKey: 'synthetic-public-key', env: localGatewayChildEnv() });
      await host.start();
      assert.ok(host.ready.binding_names.includes('CLUED_DB_GATEWAY_TOKEN'));
      const response = await fetch(host.url);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { verified: true });
      assert.equal(verified, true);
      await host.sync();
      assert.equal(JSON.stringify({ logs: host.logs, egress: host.egress, ready: host.ready }).includes(gatewayToken), false);
    } finally {
      await host?.stop();
      await new Promise((resolve) => server.close(resolve));
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
