import assert from 'node:assert/strict';
import './clued-scan-start-732-successor.test.mjs';
import { restoreRetiredEntries } from './fixtures/retired-gated-proof-catalogue.mjs';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import {
  gateConditionHolds, gateFindings, registeredBootstrapOrdinarySuccessor,
  sha256Hex, workflowFindings, workflowJobs,
} from './clued-work-admission.mjs';
import {
  compileRegisteredWorkflow, registeredWorkflowSource, roleDefinitionDigest,
  rolesForSource, workflowBlob, parseWorkflowProfiles, REQUIRED_TESTS_SOURCE,
} from './clued-workflow-profile.mjs';

// These exact preregistered workflow bytes are active only in this unaccepted integrated candidate.
// Their registration and presence do not grant execution or qualify an installed Source.
// Copied byte-for-byte from Git 956078fcec98844ab9be05e857fe4f53b3372fc4.
// CI uses these local fixtures; it need not fetch that future commit.
const ROOT = new URL('../../', import.meta.url);
const require = createRequire(new URL('apps/clued-cloud/package.json', ROOT));
const yaml = require('yaml');
const load = name => JSON.parse(fs.readFileSync(new URL(`scripts/ci/${name}`, ROOT), 'utf8'));
const profiles = parseWorkflowProfiles(fs.readFileSync(new URL('scripts/ci/clued-gated-proof-profiles.json', ROOT)));
const roleSpecs = load('clued-gated-proof-role-specs.json');
const GATE_SHA = '3f48159e97624c9dd17f6d3e3ae626bc145c69124e4f7e3fbe4de20474d0dfe9';
const HISTORY_732=JSON.parse(fs.readFileSync(new URL('work/actions-hosted-migration/independent-ci-v1/test/fixtures/scan-start-prereg/gitleaks-732-source.json',ROOT),'utf8')).row;
const SOURCES = [
  {
    file: '.github/workflows/gitleaks.yml', job: 'gitleaks-trusted-self-hosted',
    before: 'e6fafbb0a40ce37795f1e50bbda03cd33fbf40e0',
    after: 'ba4690650935961e7f4aa289a3aa0dc874b8b4fd',
    sha256: 'd8daffb6f35d572ada3028f1b372bc9e728edb9d757a6442a702ae423645ff77',
    role: '2325e6f3f3d459f1204a77a842d4726b13cad06e73c1312478a6b9df013882bd',
    skipped: '8d172bdfeda9b554d2c8c0e5868ccae6e1a3096d',
    name: 'gitleaks-hosted-executor',
  },
  {
    file: '.github/workflows/trivy.yml', job: 'trivy-trusted-self-hosted',
    before: '50bd4ae3312ea3c5b1896a9ec81922b0b392343b',
    after: '9867c4c847a61aa33761e27b793e0928bc6cbfdc',
    sha256: 'ef85f4ad53e75d2105c1892600b83b8b70b198dc1518ff856ba53fb6c4053ccb',
    role: '7745a8c7286ffba75761d8ee00fbb099809318a9bdc6bf52760064d040cefa8f',
    skipped: '300ad19a59bf529ccebd45ae7fbb76189f806316',
    name: 'trivy-hosted-executor',
  },
];
function parseYaml(text) {
  assert.equal(require('yaml/package.json').version, '2.9.0', 'the registration parser is lockfile-pinned');
  const doc = yaml.parseDocument(text, { version: '1.2', uniqueKeys: true, strict: true, merge: false });
  assert.deepEqual(doc.errors, []);
  return doc.toJS({ maxAliasCount: 0 });
}
function source(file, blob) {
  const result = registeredWorkflowSource(profiles, file, blob);
  assert.equal(result.passed, true, result.reason);
  return result.profile.source_yaml;
}
function stripRegisteredG4AutomationSuccessor(profileBefore, rolesBefore) {
  const file = '.github/workflows/clued-g4-database.yml';
  const blob = '9d81933776a2646bdf0ff77f6ee2621cda551ec2';
  assert.equal(profileBefore.workflows[file].accepted_sources.filter(x => x.workflow_blob === blob).length, 1);
  const result = registeredWorkflowSource(profileBefore, file, blob);
  assert.equal(result.passed, true, result.reason);
  const text = result.profile.source_yaml, definition = parseYaml(text);
  assert.equal(workflowBlob(text), blob);
  assert.equal(sha256Hex(text), '989ce56d8c80f1afb6e1dfee8280fd7347cb91398c219b5b65cd36435d75dfde');
  const roles = rolesForSource(rolesBefore, file, blob);
  const expected = [
    ['database-gate-trusted-self-hosted', '0fa93fb5c2971639ab6ce63fcc40e661b6c86242b069513f6bab3b2e14dd5294'],
    ['database-gate-untrusted-hosted', '5bc34c9167c890b0b1923a82fa546932db1c0dd179265ce851c069ab788cb29d'],
  ];
  assert.deepEqual(roles, expected.map(([job_id, definition_sha256]) => ({ job_id, definition_sha256 })));
  for (const role of roles) assert.equal(roleDefinitionDigest(definition.jobs[role.job_id]), role.definition_sha256);
  assert.deepEqual(compileRegisteredWorkflow(text, {
    primary_ids: result.profile.primary_ids, parseYaml, accepted_roles: roles,
  }), result.profile);
  profileBefore.workflows[file].accepted_sources = profileBefore.workflows[file].accepted_sources.filter(x => x.workflow_blob !== blob);
  delete rolesBefore.workflows[file].sources[blob];
}
function stripRegisteredG4Successor(profileBefore, rolesBefore) {
  const file = '.github/workflows/clued-g4-database.yml';
  const blob = 'd7876890a4df616fddae675c4d66737a70eb7045';
  const oldBlob = 'a09cfc44e506a9672e5221a7fa6737747ddcb787';
  assert.equal(profileBefore.workflows[file].accepted_sources.filter(x => x.workflow_blob === blob).length, 1);
  const result = registeredWorkflowSource(profileBefore, file, blob);
  assert.equal(result.passed, true, result.reason);
  const text = result.profile.source_yaml;
  assert.equal(workflowBlob(text), blob);
  assert.equal(sha256Hex(text), '570cfb6e8b9b13c562de6cd690e01c8ef68b525b79206d937950bedf954d8c3d');
  const roles = rolesForSource(rolesBefore, file, blob);
  assert.deepEqual(roles, rolesForSource(rolesBefore, file, oldBlob));
  assert.deepEqual(compileRegisteredWorkflow(text, {
    primary_ids: result.profile.primary_ids, parseYaml, accepted_roles: roles,
  }), result.profile);
  profileBefore.workflows[file].accepted_sources = profileBefore.workflows[file].accepted_sources.filter(x => x.workflow_blob !== blob);
  delete rolesBefore.workflows[file].sources[blob];
}
function fixture(row) {
  return fs.readFileSync(new URL(`work/actions-hosted-migration/independent-ci-v1/test/fixtures/scan-start-prereg/${row.file.split('/').at(-1)}`, ROOT));
}
function check(row, baseText = source(row.file, row.before), headText = fixture(row).toString('utf8'), extra = {}) {
  return registeredBootstrapOrdinarySuccessor({
    file: { filename: row.file, status: 'modified' }, baseText, headText, profiles, roleSpecs, ...extra,
  });
}
const HEAD = 'a'.repeat(40), BASE = 'b'.repeat(40);
async function findings(row, headText, baseText = source(row.file, row.before), extraEnv = {}) {
  const seen = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://offline.invalid');
    assert.equal(parsed.pathname, `/repos/tdoljyj/cross-memory-system/contents/${row.file}`);
    assert.equal(options.method ?? 'GET', 'GET');
    const ref = parsed.searchParams.get('ref');
    assert.ok([HEAD, BASE].includes(ref)); seen.push(ref);
    const text = ref === HEAD ? headText : baseText;
    return new Response(JSON.stringify({ encoding: 'base64', content: Buffer.from(text).toString('base64') }), { status: 200 });
  };
  const result = await workflowFindings(fetchImpl, { ...extraEnv, GITHUB_API_URL: 'https://offline.invalid' },
    'tdoljyj/cross-memory-system', [{ filename: row.file, status: 'modified' }], HEAD, BASE);
  assert.deepEqual(seen, [HEAD, BASE], 'only the two fixed source reads; no Native or other request');
  return result;
}

test('the integrated candidate uses exactly the two preregistered workflow bytes and preserves the prior catalogue', () => {
  const profileBefore = structuredClone(profiles), rolesBefore = structuredClone(roleSpecs);
  // The ten workflows deleted after this generation are restored from the last catalogue that registered them.
  const RETIRED = restoreRetiredEntries(profileBefore, rolesBefore);
  assert.equal(RETIRED.length, 10, RETIRED.join(', '));
  for (const file of RETIRED) assert.equal(fs.existsSync(new URL(file, ROOT)), false, file);
  const h=registeredWorkflowSource(profileBefore,HISTORY_732.file,HISTORY_732.candidate_blob);
  assert.equal(h.passed,true);
  assert.equal(h.profile.source_sha256,HISTORY_732.candidate_sha256);
  assert.deepEqual(rolesBefore.workflows[HISTORY_732.file].sources[HISTORY_732.candidate_blob].map(({job_id,definition_sha256})=>({job_id,definition_sha256})),HISTORY_732.roles);
  profileBefore.workflows[HISTORY_732.file].accepted_sources=profileBefore.workflows[HISTORY_732.file].accepted_sources.filter(x=>x.workflow_blob!==HISTORY_732.candidate_blob);
  delete rolesBefore.workflows[HISTORY_732.file].sources[HISTORY_732.candidate_blob];
  for (const row of SOURCES) {
    const records = profileBefore.workflows[row.file].accepted_sources;
    assert.equal(records.filter(x => x.workflow_blob === row.after).length, 1);
    profileBefore.workflows[row.file].accepted_sources = records.filter(x => x.workflow_blob !== row.after);
    assert.equal(Object.hasOwn(rolesBefore.workflows[row.file].sources, row.after), true);
    delete rolesBefore.workflows[row.file].sources[row.after];
    const active = fs.readFileSync(new URL(row.file, ROOT), 'utf8');
    const current=row.file===HISTORY_732.file?{after:HISTORY_732.candidate_blob,sha256:HISTORY_732.candidate_sha256}:row;
    assert.equal(workflowBlob(active), current.after, 'the candidate switches only to an exact preregistered Source');
    assert.equal(sha256Hex(active), current.sha256);
    assert.equal(active, source(row.file, current.after));
    assert.equal(active,row.file===HISTORY_732.file?fs.readFileSync(new URL('work/actions-hosted-migration/independent-ci-v1/test/fixtures/scan-start-prereg/gitleaks-732.yml',ROOT),'utf8'):fixture(row).toString('utf8'));
  }
  // The separately frozen compound candidate is additive to this earlier
  // scan-start generation. Verify its exact identity before comparing the
  // unchanged predecessor catalogue; disk /3 is decoded above, never repinned.
  assert.equal(profileBefore.workflows[REQUIRED_TESTS_SOURCE.file].workflow_blob, REQUIRED_TESTS_SOURCE.workflow_blob);
  assert.deepEqual(rolesBefore.workflows[REQUIRED_TESTS_SOURCE.file].sources[REQUIRED_TESTS_SOURCE.workflow_blob]
    .map(role => [role.job_id, role.definition_sha256]), REQUIRED_TESTS_SOURCE.primary_ids
    .map(id => [id, REQUIRED_TESTS_SOURCE.role_sha256[id]]));
  delete profileBefore.workflows[REQUIRED_TESTS_SOURCE.file];
  delete rolesBefore.workflows[REQUIRED_TESTS_SOURCE.file];
  // Resident ADR 0032 step 2: the Windows side of the required tests is registered after this generation, additive too
  // The current Source exports the trusted base from the local candidate object store (Task 04f9b91b).
  const WINDOWS = '.github/workflows/clued-required-tests-windows.yml';
  const WINDOWS_BLOB = workflowBlob(fs.readFileSync(new URL(WINDOWS, ROOT), 'utf8'));
  assert.equal(profileBefore.workflows[WINDOWS].workflow_blob, WINDOWS_BLOB);
  assert.deepEqual(rolesBefore.workflows[WINDOWS].sources[WINDOWS_BLOB].map(role => [role.job_id, role.definition_sha256]),
    [['ci-suites-windows', 'bc032f2225f9efc593770491dca2790a7beccfd81c95e85276e74860cede23bd']]);
  delete profileBefore.workflows[WINDOWS];
  delete rolesBefore.workflows[WINDOWS];
  // #988: the Node 22 install managed-cache Source is registered after this generation; strip it like the other later successors.
  const NODE22 = '.github/workflows/clued-cloud-node22-install.yml', NODE22_BLOB = '30e783feb7ab54a578b5ed3b692fa664e00207d1';
  assert.equal(profileBefore.workflows[NODE22].accepted_sources.filter(x => x.workflow_blob === NODE22_BLOB).length, 1);
  profileBefore.workflows[NODE22].accepted_sources = profileBefore.workflows[NODE22].accepted_sources.filter(x => x.workflow_blob !== NODE22_BLOB);
  assert.equal(Object.hasOwn(rolesBefore.workflows[NODE22].sources, NODE22_BLOB), true);
  delete rolesBefore.workflows[NODE22].sources[NODE22_BLOB];
  // #1217 R2b: three gated workflows lost their main push trigger; each new byte form is a later additive Source and is
  // the workflow on disk. Strip it like the other later successors.
  for (const [file, blob] of [['.github/workflows/clued-cloud-node22-install.yml', 'a07a290c763654a7aaa749a1c2088d484afc4eed'],
    ['.github/workflows/design-refs.yml', '0d5575fdabf9f2e811b893d6a09eb4b36d2e7600'],
    ['.github/workflows/model-program-m2-scoped-consumer.yml', 'da6c77d5758f8f3e7a124fc3ab667fceebe235f8']]) {
    assert.equal(profileBefore.workflows[file].accepted_sources.filter(x => x.workflow_blob === blob).length, 1, file);
    assert.equal(workflowBlob(fs.readFileSync(new URL(file, ROOT), 'utf8')), blob, file);
    profileBefore.workflows[file].accepted_sources = profileBefore.workflows[file].accepted_sources.filter(x => x.workflow_blob !== blob);
    assert.equal(Object.hasOwn(rolesBefore.workflows[file].sources, blob), true, file);
    delete rolesBefore.workflows[file].sources[blob];
  }
  // A preregisters this exact later successor without consuming its YAML.
  // Authenticate its full Source and unchanged roles before projecting history.
  // Verify the later automation route's exact bytes and both complete roles,
  // then remove only that addition from this older historical projection.
  stripRegisteredG4AutomationSuccessor(profileBefore, rolesBefore);
  stripRegisteredG4Successor(profileBefore, rolesBefore);
  assert.equal(roleDefinitionDigest(profileBefore), 'ee9f3a94a83bb9dbfa0b02c5c7d2c9daaa7c48019bf98302a9f48877c7130c87');
  assert.equal(roleDefinitionDigest(rolesBefore), 'b884d1473b6aa27a124019f8e4a836a9e861fe7b8b96a970bdd8188d755bf75b');
  const admission = fs.readFileSync(new URL('./clued-work-admission.mjs', import.meta.url), 'utf8');
  const anchor = 'const BOOTSTRAP_ORDINARY_SOURCES=Object.freeze(';
  const start = admission.indexOf(anchor) + anchor.length, end = admission.indexOf(']);', start);
  const descriptors = JSON.parse(admission.slice(start, end + 1));
  assert.equal(descriptors.length, 16);
  assert.equal(roleDefinitionDigest(descriptors.slice(0, 13)), 'fd91deb730baa43753ecd06acf169f030ea8be747de65613f3da8d774012b95b');
  assert.deepEqual(descriptors.slice(13,15), SOURCES.map(row => ({
    file: row.file, predecessor_blob: row.before, candidate_blob: row.after, candidate_sha256: row.sha256,
    gate_sha256: GATE_SHA, roles: [{ job_id: row.job, definition_sha256: row.role }],
  })));
  assert.deepEqual(descriptors[15],HISTORY_732);
});

test('the G4 automation projection refuses missing, duplicate, altered Source or FullRole', () => {
  const file = '.github/workflows/clued-g4-database.yml', blob = '9d81933776a2646bdf0ff77f6ee2621cda551ec2';
  for (const mutate of [
    (p, r) => { p.workflows[file].accepted_sources = p.workflows[file].accepted_sources.filter(x => x.workflow_blob !== blob); },
    (p, r) => { p.workflows[file].accepted_sources.push(structuredClone(p.workflows[file].accepted_sources.find(x => x.workflow_blob === blob))); },
    (p, r) => { p.workflows[file].accepted_sources.find(x => x.workflow_blob === blob).source_yaml += '\n'; },
    (p, r) => { p.workflows[file].accepted_sources.find(x => x.workflow_blob === blob).routes[0].self_hosted = false; },
    (p, r) => { delete r.workflows[file].sources[blob]; },
    (p, r) => { r.workflows[file].sources[blob][0].definition_sha256 = '0'.repeat(64); },
    (p, r) => { r.workflows[file].sources[blob][0].definition = { permissions: { contents: 'write' } }; },
    (p, r) => { r.workflows[file].sources[blob].push(structuredClone(r.workflows[file].sources[blob][0])); },
  ]) {
    const p = structuredClone(profiles), r = structuredClone(roleSpecs);
    mutate(p, r);
    assert.throws(() => stripRegisteredG4AutomationSuccessor(p, r));
  }
});

test('the later G4 projection refuses missing, duplicate, altered Source or FullRole', () => {
  const file = '.github/workflows/clued-g4-database.yml', blob = 'd7876890a4df616fddae675c4d66737a70eb7045';
  for (const mutate of [
    (p, r) => { p.workflows[file].accepted_sources = p.workflows[file].accepted_sources.filter(x => x.workflow_blob !== blob); },
    (p, r) => { p.workflows[file].accepted_sources.push(structuredClone(p.workflows[file].accepted_sources.find(x => x.workflow_blob === blob))); },
    (p, r) => { p.workflows[file].accepted_sources.find(x => x.workflow_blob === blob).source_yaml += '\n'; },
    (p, r) => { delete r.workflows[file].sources[blob]; },
    (p, r) => { r.workflows[file].sources[blob][0].definition_sha256 = '0'.repeat(64); },
  ]) {
    const p = structuredClone(profiles), r = structuredClone(roleSpecs);
    mutate(p, r);
    assert.throws(() => stripRegisteredG4Successor(p, r));
  }
});

test('the existing condition parser stays byte-identical and refuses PR-first, OR and always bypasses', () => {
  assert.equal(sha256Hex(gateConditionHolds.toString().replaceAll('\r\n', '\n')),
    'ef0108bde378363a14088d02756bc4eb001acb38973285daff78077f7c832a43');
  const gate = "needs.admission-gate.outputs.admitted == 'true'";
  assert.equal(gateConditionHolds(`${gate} && (github.event_name == 'pull_request' && (true))`), true);
  for (const condition of [
    `github.event_name == 'pull_request' && ${gate} && (true)`,
    `${gate} || (true)`, `${gate} && (true) || always()`, `${gate} && ((true) || (false)) || (true)`,
    'always()', null,
  ]) assert.equal(gateConditionHolds(condition), false, String(condition));
});

for (const row of SOURCES) {
  test(`${row.file}: exact LF Git bytes recompile with locked parser and full independent role`, () => {
    const bytes = fixture(row), text = bytes.toString('utf8');
    assert.ok(Buffer.from(text).equals(bytes)); assert.ok(!text.includes('\r'));
    assert.equal(workflowBlob(text), row.after); assert.equal(sha256Hex(text), row.sha256);
    const value = parseYaml(text), roles = rolesForSource(roleSpecs, row.file, row.after);
    assert.deepEqual(roles, [{ job_id: row.job, definition_sha256: row.role, definition: value.jobs[row.job] }]);
    assert.equal(roleDefinitionDigest(value.jobs[row.job]), row.role);
    const compiled = compileRegisteredWorkflow(text, { primary_ids: [row.job], parseYaml, accepted_roles: roles });
    assert.deepEqual(compiled, registeredWorkflowSource(profiles, row.file, row.after).profile);
    assert.deepEqual(compiled.routes.map(x => [x.name, x.self_hosted]), [[row.name, false]]);
    assert.equal(Object.keys(compiled.routes[0].required_steps)[0], 'Acquire one-time scan permission');
    assert.equal(Object.keys(compiled.routes[0].required_steps).at(-1), 'Emit relay identity');
    assert.equal(sha256Hex(workflowJobs(text).find(x => x.name === 'admission-gate').lines.join('\n')), GATE_SHA);
    assert.deepEqual(gateFindings(text, text), []);
  });

  test(`${row.file}: exact predecessor and self-pair pass without execution/host qualification authority`, async () => {
    const text = fixture(row).toString('utf8');
    for (const base of [source(row.file, row.before), text]) {
      const result = check(row, base, text);
      assert.equal(result.passed, true, result.reason);
      assert.equal(result.registeredBootstrapOrdinaryTransition, false);
      assert.equal(result.execution_authority, false);
      assert.equal(result.host_qualification, 'separate_required');
      assert.deepEqual(await findings(row, text, base), { gate: [], owner: [] });
    }
  });

  test(`${row.file}: skipped generation, rollback, unknown bytes, renamed/added identity stay refused`, () => {
    const text = fixture(row).toString('utf8');
    assert.equal(check(row, source(row.file, row.skipped)).passed, false);
    assert.equal(check(row, text, source(row.file, row.before)).passed, false);
    assert.equal(check(row, undefined, text + '# unknown source\n').passed, false);
    assert.equal(check(row, undefined, text.replace('--mode gate', '--mode required')).passed, false);
    for (const file of [
      { filename: row.file, status: 'added' },
      { filename: row.file, status: 'modified', previous_filename: '.github/workflows/unrelated.yml' },
    ]) assert.equal(check(row, undefined, text, { file }).passed, false);
  });

  test(`${row.file}: missing/ambiguous profile or changed FullRole is never inherited`, () => {
    const missing = structuredClone(profiles);
    missing.workflows[row.file].accepted_sources = missing.workflows[row.file].accepted_sources.filter(x => x.workflow_blob !== row.after);
    assert.equal(check(row, undefined, undefined, { profiles: missing }).passed, false);
    const duplicate = structuredClone(profiles);
    duplicate.workflows[row.file].accepted_sources.push(structuredClone(registeredWorkflowSource(profiles, row.file, row.after).profile));
    assert.equal(check(row, undefined, undefined, { profiles: duplicate }).passed, false);
    for (const edit of [
      specs => { delete specs.workflows[row.file].sources[row.after]; },
      specs => { specs.workflows[row.file].sources[row.after][0].definition.steps.push({ run: 'echo changed-role' }); },
      specs => { const role = specs.workflows[row.file].sources[row.after][0]; role.definition.steps.push({ run: 'echo forged-role' }); role.definition_sha256 = roleDefinitionDigest(role.definition); },
    ]) { const specs = structuredClone(roleSpecs); edit(specs); assert.equal(check(row, undefined, undefined, { roleSpecs: specs }).passed, false); }
    assert.equal(check(row, undefined, undefined, { profiles: null }).passed, false);
    assert.equal(check(row, undefined, undefined, { roleSpecs: null }).passed, false);
  });

  test(`${row.file}: caller catalogue cannot authorize a third source or change the fixed transition`, async () => {
    const text = fixture(row).toString('utf8') + '# syntactically valid but not pre-registered\n';
    const value = parseYaml(text), roles = [{ job_id: row.job, definition_sha256: roleDefinitionDigest(value.jobs[row.job]), definition: value.jobs[row.job] }];
    const fake = compileRegisteredWorkflow(text, { primary_ids: [row.job], parseYaml, accepted_roles: roles });
    const forgedProfiles = structuredClone(profiles), forgedRoles = structuredClone(roleSpecs);
    forgedProfiles.workflows[row.file].accepted_sources.push(fake);
    forgedRoles.workflows[row.file].sources[fake.workflow_blob] = roles;
    assert.equal(registeredWorkflowSource(forgedProfiles, row.file, fake.workflow_blob).passed, true);
    assert.equal(check(row, undefined, text, { profiles: forgedProfiles, roleSpecs: forgedRoles }).passed, false);
    const result = await findings(row, text, undefined, { profiles: forgedProfiles, roleSpecs: forgedRoles });
    assert.ok(result.gate.includes(`workflow_gate:${row.file}:bootstrap_ordinary_Source_not_registered`));
  });

  test(`${row.file}: the actual gate still rejects a missing admission dependency/condition`, () => {
    const text = fixture(row).toString('utf8');
    for (const [before, after] of [
      ['    needs: admission-gate\n', ''],
      ["needs.admission-gate.outputs.admitted == 'true' &&", 'always() &&'],
    ]) {
      const changed = text.replace(before, after);
      assert.notEqual(changed, text); assert.ok(gateFindings(changed, text).length > 0);
      assert.equal(check(row, undefined, changed).passed, false);
    }
  });
}
