// clued_ci_node_registration_v1 must not read b.expires_at directly (Task bae1899f): production's
// public.clued_agent_bindings has no expires_at column, so every /ci-nodes registration failed there with
// `record "b" has no field "expires_at"` (TURING, 2026-10-31). The fix reads it through to_jsonb(b), like
// clued_private.binding_live_v1, and changes nothing else.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const migrations = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../supabase/migrations');
const read = name => fs.readFileSync(path.join(migrations, name), 'utf8');
const registration = text => {
  const start = text.search(/create (?:or replace )?function public\.clued_ci_node_registration_v1\(/);
  assert.ok(start >= 0, 'the registration function is defined');
  const body = text.indexOf('as $$', start) + 5;
  return text.slice(body, text.indexOf('$$;', body));
};

test('the latest registration function reads the binding expiry through to_jsonb', () => {
  const latest = fs.readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()
    .filter(name => /function public\.clued_ci_node_registration_v1\(/.test(read(name))).at(-1);
  assert.equal(latest, '20261031170000_ci_node_registration_binding_expiry_v1.sql');
  const body = registration(read(latest));
  assert.doesNotMatch(body, /\bb\.expires_at\b/);
  assert.match(body, /\(to_jsonb\(b\)->>'expires_at'\)::timestamptz/);
});

test('the fix changes only the expiry expression of the stage-1 function', () => {
  const original = registration(read('20261023092957_ci_scheduling_stage1_v1.sql'));
  const fixed = registration(read('20261031170000_ci_node_registration_binding_expiry_v1.sql'));
  assert.equal(fixed, original.replace('b.expires_at', "(to_jsonb(b)->>'expires_at')::timestamptz"));
  assert.notEqual(fixed, original);
});
