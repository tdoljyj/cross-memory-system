// The CI-script tests (scripts/ci and its neighbours) run in the clued-cloud
// unit command itself: the selection's {ci-script-tests} expansion lists them
// (scripts/ci/ci-required-selection.mjs, ciScriptTests), each in its own test
// process. What stays here: the admission self-tests run in their own suite,
// whenever their code changes; the one file they read outside those triggers
// (the application's public Supabase default) is checked below, on every
// change, as both readers parse it and as the admission self-test checks it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveSupabasePublicConfig } from '../app/supabase-public-config.ts';
import { PUBLIC_CONFIG_SOURCE, resolvePublicSupabaseConfig } from '../../../scripts/ci/clued-work-admission.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// The admission script and the runner hook (and with them the admission
// self-tests) read the application's public Supabase default from its source
// text, each with its own pattern.
test('the admission script and the runner hook read the application public Supabase default', () => {
  const { url, key } = resolveSupabasePublicConfig({});
  assert.deepEqual(resolvePublicSupabaseConfig({}, ROOT), { url, key, source: PUBLIC_CONFIG_SOURCE });
  // The runner hook's size limit and pattern (scripts/runner/clued-runner-job-started.mjs, decideWithCurrentEpoch).
  // It measures the GitHub contents API's base64, which ends every line of up to 60 characters (the last included) with a newline.
  const text = readFileSync(path.join(ROOT, PUBLIC_CONFIG_SOURCE), 'utf8');
  const base64 = Buffer.from(text).toString('base64');
  assert.ok(base64.length + Math.ceil(base64.length / 60) <= 32768, `${PUBLIC_CONFIG_SOURCE} is over the runner hook's 32768-character limit`);
  const runner = /return \{ url: "(https:\/\/[a-z0-9-]+\.supabase\.co)", key: "(sb_publishable_[A-Za-z0-9_-]+)" \};/.exec(text);
  assert.deepEqual(runner?.slice(1), [url, key]);
  // The admission self-test's own check of the default (scripts/ci/clued-work-admission.test.mjs).
  assert.match(url, /^https:\/\/[a-z]+\.supabase\.co$/);
});
