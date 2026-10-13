import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient } from '@supabase/supabase-js';

test('the installed SDK preserves the clicked account header while async auth changes accounts', async () => {
  let selectedAccount = 'synthetic-account-a';
  let releaseAuth;
  let reachedAuth;
  const entered = new Promise(resolve => { reachedAuth = resolve; });
  const authGate = new Promise(resolve => { releaseAuth = resolve; });
  const dispatched = [];
  const client = createClient('https://owner-switch.example.invalid', 'synthetic-public-key', {
    accessToken: async () => { reachedAuth(); await authGate; return selectedAccount; },
    global: { fetch: async (url, init) => {
      dispatched.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ status: 'committed' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    } },
  });
  const clickedToken = selectedAccount;
  const request = client.rpc('clued_owner_auto_approve_set_v1', { p_input: { enabled: false, base_version: 0 } })
    .setHeader('Authorization', 'Bearer ' + clickedToken);
  const result = Promise.resolve(request);
  await entered;
  selectedAccount = 'synthetic-account-b';
  releaseAuth();
  assert.equal((await result).error, null);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].headers.get('Authorization'), 'Bearer synthetic-account-a');
  assert.deepEqual(dispatched[0].body, { p_input: { enabled: false, base_version: 0 } });
  // Pinning one request does not change the shared client's authentication.
  await client.rpc('clued_owner_grants_list_v1', { p_input: {} });
  assert.equal(dispatched[1].headers.get('Authorization'), 'Bearer synthetic-account-b');
});
