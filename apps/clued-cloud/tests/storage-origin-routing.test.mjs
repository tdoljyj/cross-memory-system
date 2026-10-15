import test from 'node:test';
import assert from 'node:assert/strict';
import { routeStorageOrigin } from '../worker/web-origin-routing.mjs';

const legacy = 'https://clued.pixelgrav.com';
const current = 'https://kooyumi.pixelgrav.com';
const alias = 'https://native.pixelgrav.com';
const callback = '/storage/google/callback';
const pages = ['/storage', '/storage/admin', '/storage/connections', '/storage/onboard', callback];
const environment = changes => Object.freeze({
  CLUED_OAUTH_ORIGIN: legacy,
  KOOYUMI_OAUTH_ORIGIN: current,
  CLUED_WEB_ORIGINS: current + ', ' + alias,
  CLUED_STORAGE_GOOGLE_REDIRECT_URI: legacy + callback,
  ...changes,
});

function redirect(request, env, target) {
  const response = routeStorageOrigin(request, env);
  assert.ok(response instanceof Response, 'storage origin routing must be synchronous');
  assert.equal(response.status, 302);
  const source = new URL(request.url);
  const destination = new URL(response.headers.get('location'));
  assert.equal(destination.origin, target);
  assert.equal(destination.pathname, source.pathname);
  assert.equal(destination.search, source.search);
  assert.equal(destination.hash, '');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  return response;
}

test('storage navigation keeps both domains on the configured Google callback session origin', () => {
  for (const target of [legacy, current]) {
    const source = target === legacy ? current : legacy;
    const env = environment({ CLUED_STORAGE_GOOGLE_REDIRECT_URI: target + callback });
    for (const page of pages) {
      for (const method of ['GET', 'HEAD']) {
        redirect(new Request(source + page + '?state=opaque&code=private-code', { method }), env, target);
        assert.equal(routeStorageOrigin(new Request(target + page), env), null);
      }
    }
  }
});

test('explicit Native aliases use the callback origin without changing the supplied environment', () => {
  const env = environment();
  const before = JSON.stringify(env);
  for (const page of pages) redirect(new Request(alias + page), env, legacy);
  assert.equal(JSON.stringify(env), before);
});

test('storage path matching normalizes encoding, repeated slashes, case and trailing slash', () => {
  const env = environment();
  for (const page of ['/STORAGE/', '/storage//ADMIN/', '/%73torage/connections', '//storage//onboard/', '/storage/GOOGLE/callback/']) {
    redirect(new Request(current + page + '?state=preserved'), env, legacy);
  }
});

test('MCP, OAuth and other application routes remain under their existing evaluators', () => {
  const env = environment();
  for (const origin of [legacy, current, alias]) {
    for (const page of ['/mcp', '/mcp/subroute', '/oauth/authorize', '/oauth/token', '/oauth/register',
      '/oauth/consent', '/oauth/request', '/oauth/decision', '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-protected-resource/mcp', '/v1/storage/google/start', '/storage/api',
      '/storage/onboard/extra', '/storage/google/callback/extra', '/']) {
      assert.equal(routeStorageOrigin(new Request(origin + page), env), null, origin + page);
    }
  }
});

test('uncontrolled origins cannot navigate through this helper even with hostile headers', () => {
  const env = environment();
  for (const origin of ['https://other.pixelgrav.com', 'https://kooyumi.pixelgrav.com.evil.test', 'http://kooyumi.pixelgrav.com']) {
    for (const page of pages) {
      const request = new Request(origin + page + '?origin=' + encodeURIComponent(legacy), {
        headers: { host: 'kooyumi.pixelgrav.com', origin: current, 'x-forwarded-host': 'clued.pixelgrav.com' },
      });
      assert.equal(routeStorageOrigin(request, env), null);
    }
  }
  const invalidSources = environment({ KOOYUMI_OAUTH_ORIGIN: current + '/', CLUED_WEB_ORIGINS: 'http://kooyumi.pixelgrav.com' });
  assert.equal(routeStorageOrigin(new Request(current + '/storage'), invalidSources), null);
});

test('request headers and query parameters cannot choose a different storage origin', () => {
  const request = new Request(current + '/storage?callback=https%3A%2F%2Fevil.test%2Fstorage%2Fgoogle%2Fcallback', {
    headers: { host: 'evil.test', origin: 'https://evil.test', 'x-forwarded-host': 'evil.test' },
  });
  redirect(request, environment(), legacy);
});

test('cross-origin requests never forward mutation bodies or Authorization headers', () => {
  const env = environment();
  for (const page of pages) {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const request = new Request(current + page, { method, body: 'never-forward-or-read-this-body' });
      Object.defineProperty(request, 'body', { get() { throw new Error('body must not be read'); } });
      for (const name of ['text', 'json', 'arrayBuffer', 'formData', 'blob']) {
        Object.defineProperty(request, name, { value() { throw new Error('body must not be consumed'); } });
      }
      const response = routeStorageOrigin(request, env);
      assert.equal(response.status, 404);
      assert.equal(response.headers.get('location'), null);
      assert.equal(request.bodyUsed, false);
    }
    for (const method of ['GET', 'HEAD']) {
      for (const value of ['', 'Bearer never-forward-this-token']) {
        const response = routeStorageOrigin(new Request(current + page, { method, headers: { authorization: value } }), env);
        assert.equal(response.status, 404);
        assert.equal(response.headers.get('location'), null);
      }
    }
  }
});

test('same-origin storage requests pass through including authenticated mutations', () => {
  const env = environment();
  for (const page of pages) {
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
      assert.equal(routeStorageOrigin(new Request(legacy + page, {
        method, headers: { authorization: 'Bearer same-origin-session' },
        ...(method === 'GET' ? {} : { body: 'same-origin-body' }),
      }), env), null);
    }
  }
});

test('an absent callback configuration falls back only to the exact legacy HTTPS origin', () => {
  for (const value of [undefined, '']) {
    const env = environment({ CLUED_STORAGE_GOOGLE_REDIRECT_URI: value });
    for (const page of pages) redirect(new Request(current + page), env, legacy);
    assert.equal(routeStorageOrigin(new Request(legacy + '/storage'), env), null);
  }
});

test('configured invalid callback addresses fail closed with one safe fixed error', async () => {
  let expectedError;
  for (const value of ['not-a-url', '//clued.pixelgrav.com/storage/google/callback',
    'http://clued.pixelgrav.com/storage/google/callback', legacy + '/', legacy + callback + '/',
    legacy + callback + '?state=private', legacy + callback + '#private',
    'https://private-user:private-password@clued.pixelgrav.com/storage/google/callback']) {
    const env = environment({ CLUED_STORAGE_GOOGLE_REDIRECT_URI: value });
    for (const origin of [legacy, current, alias]) {
      const response = routeStorageOrigin(new Request(origin + '/storage/onboard'), env);
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('location'), null);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      const body = await response.json();
      assert.deepEqual(Object.keys(body), ['error']);
      assert.match(body.error, /^[a-z][a-z0-9_]+$/);
      expectedError ??= body.error;
      assert.equal(body.error, expectedError);
      assert.ok(!JSON.stringify(body).includes(value));
      assert.ok(!JSON.stringify(body).includes('private-password'));
    }
    assert.equal(routeStorageOrigin(new Request('https://unknown.test/storage/onboard'), env), null);
    assert.equal(routeStorageOrigin(new Request(current + '/mcp'), env), null);
    assert.equal(routeStorageOrigin(new Request(current + '/oauth/authorize'), env), null);
  }
});
