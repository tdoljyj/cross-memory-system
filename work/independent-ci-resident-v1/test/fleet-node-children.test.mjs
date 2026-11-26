// Shared test registration for the three Windows fleet shards. Keep the subprocess bounds at this path,
// which the clock guard already recognizes when it is imported by another test.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test, { describe } from 'node:test';
import { pathToFileURL } from 'node:url';
import { FLEET_TESTS, RES, childEnv, skip, tail, windows } from './fleet-node-fixtures.mjs';

export const fleetChildFiles = () => windows ? fs.readdirSync(FLEET_TESTS).filter(n => n.endsWith('.test.mjs')).sort() : [];

export function runFleetChildren(files, shardIndex) {
  const assigned = files.filter((_, index) => index % 3 === shardIndex);
  if (shardIndex !== 0 && assigned.length === 0) {
    // An empty file would be counted by Node as a test. The first file owns the Windows-only skip.
    describe('no fleet children assigned to this file', { skip }, () => {});
  }
  for (const name of assigned) {
    test(`rollout/fleet/test/${name}`, { skip, timeout: 3_600_000 }, () => {
      const r = spawnSync(process.execPath, ['--test', path.join(FLEET_TESTS, name)], { cwd: RES, env: childEnv(), encoding: 'utf8', maxBuffer: 1 << 28, windowsHide: true, timeout: 3_500_000 });
      assert.ifError(r.error);
      assert.equal(r.status, 0, `${name} failed:\n${tail(r.stdout)}\n${tail(r.stderr, 2000)}`);
    });
  }
}

if (process.argv[1] && pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url) {
  // The selector still discovers this historical filename. It owns no cases after the split.
  describe('fleet cases are registered by fleet-node-children-1/2/3', () => {});
}
