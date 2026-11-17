import test from 'node:test';
import assert from 'node:assert/strict';
import { FleetLagNotifier, fleetLagEvents, githubFleetChanges, fleetLagReader } from '../src/fleet-lag-alert.mjs';
import { createHash } from 'node:crypto';

const NOW = Date.parse('2026-11-18T12:00:00Z'), HOUR = 3600000;
const SHA = 'a'.repeat(40), SOURCE = 'b'.repeat(64);
const change = { sha: SHA, at: NOW - 13 * HOUR, paths: ['work/independent-ci-resident-v1/src/ledger.mjs'] };
const fleet = { at: new Date(NOW).toISOString(), dropped: 0, nodes: [{ node: 'desk', sourceManifestSha256: SOURCE, state: 'NORMAL' }] };
const sources = new Map([[SOURCE, { sha: 'c'.repeat(40), at: NOW - 24 * HOUR }]]);

test('12 hour deployment lag names each node, missing change and blocker, without treating a different Source as older', () => {
  const args = { now: NOW, changes: [change], fleet, sources, contains: () => false, blocker: 'FLEET_SOURCE_MISMATCH' };
  assert.match(fleetLagEvents(args)[0].body, /desk.*FLEET_SOURCE_MISMATCH/s);
  assert.match(fleetLagEvents(args)[0].body, /ledger\.mjs/);
  assert.equal(fleetLagEvents({ ...args, now: change.at + 12 * HOUR - 1 }).length, 0);
  assert.equal(fleetLagEvents({ ...args, contains: () => true }).length, 0);
  const unknown = fleetLagEvents({ ...args, contains: () => null });
  assert.match(unknown[0].body, /Source 无法核验/);
  assert.doesNotMatch(unknown[0].body, /落后节点/);
  const stale = fleetLagEvents({ ...args, fleet: { ...fleet, at: new Date(NOW - HOUR).toISOString() } });
  assert.match(stale[0].body, /FLEET_STATUS_UNREADABLE/);
  assert.doesNotMatch(stale[0].body, /落后节点/);
});

test('fallback uses main merge time versus Source generation with an explicit qualification', () => {
  const args = { now: NOW, changes: [change], fleet, sources: new Map([[SOURCE, { at: NOW - 24 * HOUR }]]) };
  assert.match(fleetLagEvents(args)[0].body, /生成时间.*未核验已接受包/);
  assert.equal(fleetLagEvents({ ...args, sources: new Map([[SOURCE, { at: NOW }]]) }).length, 0);
});

test('notification delivery is deduplicated across restart and failure is advisory and retried', async () => {
  const state = { data: { notified: {} }, async save() {} };
  const input = async () => ({ now: NOW, changes: [change], fleet, sources, contains: () => false });
  let delivered = 0;
  const ports = { store: state, read: input, clock: () => NOW, notify: async () => { delivered++; } };
  await new FleetLagNotifier({ ...ports, notify: async () => { throw Error('offline'); } }).step();
  await new FleetLagNotifier(ports).step();
  await new FleetLagNotifier(ports).step();
  assert.equal(delivered, 1);
});

test('GitHub reader binds the main tip and filters node paths, including a merge accepted long after authoring', async () => {
  const calls = [];
  const read = githubFleetChanges({ ghExe: 'gh', repo: 'owner/repo', run: async argv => {
    calls.push(argv);
    const api = argv.at(-1);
    if (api.includes('commits/main')) return { exitCode: 0, stdout: JSON.stringify({ sha: SHA }) };
    return { exitCode: 0, stdout: JSON.stringify([{ sha: SHA, commit: { committer: { date: new Date(change.at).toISOString() } } }]) };
  } });
  const result = await read();
  assert.ok(result.changes.every(c => c.at === change.at));
  assert.ok(calls.some(a => a.at(-1).includes(`sha=${SHA}`)));
});

test('the live adapter binds a manifest digest to the fleet Source and compares against the pinned main', async () => {
  const bytes = Buffer.from(JSON.stringify({ sourceSha: 'c'.repeat(40) }));
  const hash = createHash('sha256').update(bytes).digest('hex');
  const github = async () => ({ changes: [change], mainSha: SHA });
  const calls = [];
  github.api = async endpoint => {
    calls.push(endpoint);
    return endpoint.startsWith('compare/') ? { status: 'ahead', total_commits: 1, commits: [{ sha: SHA }] }
      : { commit: { committer: { date: new Date(NOW - 24 * HOUR).toISOString() } } };
  };
  const read = fleetLagReader({ root: '/unused', clock: () => NOW, github, readFile: async () => bytes,
    readStatus: async () => ({ train: { nodes: { ...fleet, nodes: [{ node: 'desk', sourceManifestSha256: hash }] }, last: { decision: 'FLEET_SOURCE_MISMATCH' } } }) });
  const input = await read();
  assert.match(fleetLagEvents({ ...input, now: NOW })[0].body, /落后节点：desk.*FLEET_SOURCE_MISMATCH/s);
  assert.ok(calls.includes(`compare/${'c'.repeat(40)}...${SHA}`));
  assert.equal(calls.length, 2, 'one commit and one compare, independent of the number of changes');
  assert.match(fleetLagEvents({ ...input, now: NOW, fleet: { ...fleet, nodes: [] } })[0].body, /FLEET_STATUS_UNREADABLE/);
});

test('an old commit newly seen on main waits a full 12 hours, including across a companion restart', async () => {
  let now = NOW;
  const store = { data: { notified: {} }, async save() {} };
  const ports = { root: '/unused', observationStore: store, clock: () => now,
    github: async () => ({ mainSha: SHA, changes: [{ ...change, at: NOW - 30 * 24 * HOUR }] }),
    readFile: async () => { throw Error('not locally available'); },
    readStatus: async () => ({ train: { nodes: { ...fleet, at: new Date(now).toISOString() } } }) };
  assert.equal((await fleetLagReader(ports)()).changes[0].at, NOW);
  now += 11 * HOUR;
  assert.deepEqual(fleetLagEvents({ ...await fleetLagReader(ports)(), now }), []);
  now += HOUR;
  assert.equal(fleetLagEvents({ ...await fleetLagReader(ports)(), now }).length, 1);
});
