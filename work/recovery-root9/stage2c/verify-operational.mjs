import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = name => fs.readFileSync(path.join(dir, name), 'utf8');
const pre = read('preflight.sql');
const post = read('post-readback.sql');
const launcher = read('run-stage2c.sh');
const graph = JSON.parse(read('dependency-graph.json'));
const contract = JSON.parse(read('final-contract.json'));
const passed = [];
const test = (name, fn) => { fn(); passed.push(name); };

test('json-contracts-parse', () => {
  assert.equal(graph.object_type, 'Stage2COperationalDependencyGraph');
  assert.equal(contract.object_type, 'Root9Stage2CFinalOperationalContract');
});
test('m4-is-late-bound', () => {
  assert.equal(graph.future_m4.commit, null);
  assert.equal(contract.future_m4.commit, null);
  assert.equal(contract.future_m4.tree, null);
  assert.equal(contract.future_m4.source_parent, null);
  assert.equal(contract.future_m4.pull_request, null);
});
test('m3-exact', () => {
  for (const s of [pre, launcher, JSON.stringify(graph), JSON.stringify(contract)])
    assert.match(s, /9398c6cb8db84b802facebf683c134fb1ba4ad5d/);
});
test('sql-read-only-wrappers', () => {
  for (const sql of [pre, post]) {
    assert.match(sql, /begin transaction read only isolation level repeatable read;/i);
    assert.match(sql, /commit;/i);
    assert.doesNotMatch(sql, /\b(insert|update|delete|merge|truncate|alter|create|drop|grant|revoke)\s+/i);
  }
});
test('exact-preimage', () => {
  for (const x of ['sequence)=97','charged_seconds)=10506','charged_evidence_bytes)=2335812531','c.allocations=9','c.forwards=17','c.attempts=14','c.root_events=8','c.execution_events=97']) assert.ok(pre.includes(x), x);
});
test('exact-postimage', () => {
  for (const x of ['sequence)=101','c.root_events=9','c.execution_events=101','c.seq102=0','exec98_registered','exec99_prepared','exec100_qualified','exec101_repointed']) assert.ok(post.includes(x), x);
});
test('frozen-artifact-hashes', () => {
  const all = post + JSON.stringify(contract);
  for (const x of [
    'd3c597a2425343bb6fb897e4a6eaddd76cb73adf282a8cd07187e23a527cd76e',
    '8e02293caa447a5c2fe1749d89c082fe2e1e937180c937d746512d9b7e32b6a3',
    'd0c0126ae12d710e531e6ceea07c9ff4636d1f69ca85b6a91a49cd75021bccd8',
    '107fe912496392a0a677f103feb395321292231db4459d1a9a0f170573125cb9',
    'c76438600d93d708ffe312c5980d8574f649836b65ae523daab0271e7fc9ff1b',
    '171828b556756186ed30b88928855fb8e6607f799911bf63214e9505fa984c71'
  ]) assert.ok(all.includes(x), x);
});
test('snapshot-contract-is-symmetric', () => {
  const keys = [...pre.matchAll(/'([a-z0-9_]+)',encode\(sha256/g)].map(x => x[1]);
  const postKeys = [...post.matchAll(/'([a-z0-9_]+)',encode\(sha256/g)].map(x => x[1]);
  assert.deepEqual(keys, postKeys);
  assert.equal(keys.length, 10);
});
test('target-function-exclusion-symmetric', () => {
  const exact = "p.proname not in ('read_root','reserve_execution_budget','reserve_gate','install_root9_successor_v1')";
  assert.ok(pre.includes(exact)); assert.ok(post.includes(exact));
});
test('read-root-state-and-metadata-projection', () => {
  assert.match(post, /r->>'state'='STORED_NO_GATE_AUTHORITY'/);
  assert.match(post, /r->>'metadata_binding_sha256'=k\.new_binding_sha/);
});
test('all-changed-function-acls-are-narrow', () => {
  for (const signature of ['read_root(text)','reserve_execution_budget(text,text)','reserve_gate(text,text)']) {
    for (const role of ['public','anon','authenticated']) assert.ok(post.includes(`not has_function_privilege('${role}','clued_control.${signature}','EXECUTE')`), `${signature}:${role}`);
    assert.ok(post.includes(`has_function_privilege('service_role','clued_control.${signature}','EXECUTE')`), `${signature}:service_role`);
  }
});
test('target-function-acls-excluded-from-symmetric-snapshot', () => {
  const exact = "routine_name not in ('read_root','reserve_execution_budget','reserve_gate','install_root9_successor_v1')";
  assert.equal(pre.split(exact).length - 1, 1);
  assert.equal(post.split(exact).length - 1, 1);
  assert.deepEqual(contract.target_function_final_acl.execute_denied_to, ['public','anon','authenticated']);
  assert.deepEqual(contract.target_function_final_acl.execute_granted_to, ['service_role']);
});
test('launcher-default-never-connects', () => {
  const env = {...process.env}; delete env.DATABASE_URL;
  const out = execFileSync('bash', [path.join(dir,'run-stage2c.sh')], {encoding:'utf8', env});
  assert.match(out, /PASS_DRY_RUN_NO_DATABASE_CONTACT/);
  assert.match(out, /DRY_RUN_COMPLETE_NO_DATABASE_CONTACT/);
});
test('launcher-apply-needs-exact-confirmation', () => {
  const r = spawnSync('bash', [path.join(dir,'run-stage2c.sh'),'--apply-once','WRONG'], {encoding:'utf8'});
  assert.notEqual(r.status, 0); assert.match(r.stderr, /EXACT_APPLY_CONFIRMATION/);
});
test('launcher-requires-external-evidence', () => {
  const r = spawnSync('bash', [path.join(dir,'run-stage2c.sh'),'--apply-once','ROOT9_STAGE2C_CAS_REPOINT_ONCE'], {encoding:'utf8'});
  assert.notEqual(r.status, 0); assert.match(r.stderr, /VERIFIED_M4_EVIDENCE_REQUIRED/);
});
test('launcher-never-retries-apply', () => {
  assert.equal(launcher.split('\n').filter(x => x.includes('psql ') && x.includes('-f "$APPLY_SQL"')).length, 1);
  assert.match(launcher, /automatic_retry['"]?:false/);
  assert.doesNotMatch(launcher, /while .*APPLY_SQL/);
});
test('graph-acyclic', () => {
  const nodes = new Set(graph.nodes.map(n => n.id));
  const adj = new Map([...nodes].map(n => [n, []]));
  for (const [a,b] of graph.edges) { assert(nodes.has(a)&&nodes.has(b)); adj.get(a).push(b); }
  const seen=new Set(), active=new Set();
  const visit=n=>{ if(active.has(n)) throw Error('cycle'); if(seen.has(n)) return; active.add(n); for(const x of adj.get(n)) visit(x); active.delete(n); seen.add(n); };
  for(const n of nodes) visit(n);
});
test('forbidden-effects-explicit', () => {
  for (const k of ['history_rewrite','capacity_increase','refund','budget_reservation','sequence_102_creation','ga_dispatch','acl_expansion','automatic_retry_after_unknown']) assert.equal(contract.forbidden[k], true, k);
});

console.log(JSON.stringify({state:'PASS_STAGE2C_OPERATIONAL_OFFLINE', checks:passed.length, check_names:passed}, null, 2));
