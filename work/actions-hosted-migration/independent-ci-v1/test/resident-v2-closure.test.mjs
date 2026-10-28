// The committed Source v2 closure equals the computed import closure and covers every pin list that a
// Source v2 component requires of the accepted Source manifest (record, generic helper, bridge, roles).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeClosure, CLOSURE_CONTRACT } from '../src/resident-v2/source-closure.mjs';
import { ENTRY_V2 } from '../src/resident-v2/layout.mjs';
import { REQUIRED_SOURCE_PATHS } from '../worker/protected-job-bridge-v4/boundary.mjs';
import { requiredSourcePaths } from '../worker/formal-fixed-role-policy-v3/policy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const CI = 'work/actions-hosted-migration/independent-ci-v1/';

test('source-closure.json is exactly the computed closure (regenerate it with source-closure.mjs after an import change)', () => {
  const committed = JSON.parse(fs.readFileSync(path.join(HERE, '../src/resident-v2/source-closure.json'), 'utf8'));
  assert.equal(committed.contract, CLOSURE_CONTRACT);
  assert.deepEqual(committed.paths, computeClosure(REPO));
});

test('the closure covers every Source v2 pin list', () => {
  const closure = new Set(computeClosure(REPO));
  const missing = list => list.filter(p => !closure.has(p));
  assert.deepEqual(missing([...Object.values(ENTRY_V2), '.gitleaks.toml']), [], 'record required pins (derive-batch)');
  assert.deepEqual(missing(REQUIRED_SOURCE_PATHS), [], 'bridge v4 boundary');
  for (const role of ['gitleaks', 'trivy', 'contract-placement']) assert.deepEqual(missing(requiredSourcePaths(role)), [], `role policy v3 ${role}`);
  const cs = fs.readFileSync(path.join(HERE, '../src/resident-v2/windows/FormalPublicBoundaryV2.cs'), 'utf8');
  const core = cs.slice(cs.indexOf('CoreSource={'), cs.indexOf('};', cs.indexOf('CoreSource={')));
  const pins = [...core.matchAll(/(P\+)?"([^"]+)"/g)].map(m => (m[1] ? CI : '') + m[2]);
  assert.ok(pins.length >= 14);
  assert.deepEqual(missing(pins), [], 'generic helper CoreSource');
});

test('node profile native source is pinned and no retained legacy bridge member is dropped', () => {
  const closure = new Set(computeClosure(REPO));
  assert.ok(closure.has(CI+'src/resident-v2/windows/NodeProfileV2.cs'));
  for(const name of ['boundary.mjs','formal-spool-acl.ps1','held-source.mjs','hold-source.ps1','linux-worker.mjs','mailbox.mjs','protocol.mjs','signed-result.mjs'])
    assert.ok(closure.has(CI+'worker/protected-job-bridge-v2/'+name),name);
});
