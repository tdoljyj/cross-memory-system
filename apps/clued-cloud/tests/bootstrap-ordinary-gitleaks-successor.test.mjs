import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import '../../../scripts/ci/clued-scan-start-prereg.test.mjs';
import {
  registeredBootstrapOrdinarySuccessor,
  sha256Hex,
  workflowFindings,
} from '../../../scripts/ci/clued-work-admission.mjs';
import { registeredWorkflowSource, workflowBlob } from '../../../scripts/ci/clued-workflow-profile.mjs';

const FILE = '.github/workflows/gitleaks.yml';
const LEGACY = '74043d68d20dbee9f9404a66f0a02d3285fea0aa';
const BEFORE = '95f4527be27d02889892d029b398ab1cf2e71429';
const AFTER = 'd0fe73eeabc9c163d3216e57ca6a7633288262c5';
// The refrozen hosted gitleaks workflow (730 entries, frozen commit a38e8fef).
const NEXT = '8d172bdfeda9b554d2c8c0e5868ccae6e1a3096d';
const HEX = 'e6fafbb0a40ce37795f1e50bbda03cd33fbf40e0';
const SCAN_START = 'ba4690650935961e7f4aa289a3aa0dc874b8b4fd';
const HEAD = 'f88785c9f93bae4ad7e06e4f9be93d9471125a18';
const BASE = 'f6ae29eda25c5ffa6131662e60251492e0878aa2';
const ROOT = new URL('../../../', import.meta.url);
const load = name => JSON.parse(fs.readFileSync(new URL(`scripts/ci/${name}`, ROOT), 'utf8'));
const profiles = load('clued-gated-proof-profiles.json');
const roleSpecs = load('clued-gated-proof-role-specs.json');
const entry = blob => {
  const record = profiles.workflows[FILE];
  const matches = [record, ...record.accepted_sources].filter(value => value.workflow_blob === blob);
  assert.equal(matches.length, 1);
  return matches[0];
};
const text = blob => entry(blob).source_yaml;
const check = (before = BEFORE, after = AFTER, extra = {}) => registeredBootstrapOrdinarySuccessor({
  file: { filename: FILE, status: 'modified' }, baseText: text(before), headText: text(after), profiles, roleSpecs, ...extra,
});

test('the integrated gitleaks bytes match the exact preregistered scan-start Source and retain the frozen hex Source', () => {
  const actual = fs.readFileSync(new URL(FILE, ROOT), 'utf8');
  assert.equal(actual, text(SCAN_START));
  assert.equal(workflowBlob(actual), SCAN_START);
  assert.equal(sha256Hex(actual), 'd8daffb6f35d572ada3028f1b372bc9e728edb9d757a6442a702ae423645ff77');
  assert.equal(workflowBlob(text(HEX)), HEX);
  assert.equal(sha256Hex(text(HEX)), '9d6c23d2ae4769d123f7ddcd3a25810878d36a85efc2403c07ecec5ecd17cdab');
  assert.equal(workflowBlob(text(NEXT)), NEXT);
  // The 729-entry generation stays registered as its predecessor.
  assert.equal(workflowBlob(text(AFTER)), AFTER);
  assert.equal(sha256Hex(text(AFTER)), '46627f909229d06a6b5c35112f7619b28c6aa9f0a196a526b067e3a962d9da2b');
});

test('ordinary gitleaks admits the exact d0fe73ee to 8d172bdf generation and its self-pair', () => {
  for (const before of [AFTER, NEXT]) {
    const result = check(before, NEXT);
    assert.equal(result.passed, true, result.reason);
    assert.equal(result.registeredBootstrapOrdinaryTransition, false);
    assert.equal(result.execution_authority, false);
    assert.equal(result.roles[0].definition_sha256, '6c30ca4a766e00abe10aa225ff8296d3903857d384e43ecbae5fd8c374281103');
  }
  // A skipped generation, a rollback and changed bytes stay refused.
  assert.equal(check(BEFORE, NEXT).passed, false);
  assert.equal(check(LEGACY, NEXT).passed, false);
  assert.equal(check(NEXT, AFTER).passed, false);
  assert.equal(check(NEXT, BEFORE).passed, false);
  assert.equal(check(AFTER, NEXT, { headText: `${text(NEXT)}
` }).passed, false);
  const copy = structuredClone(roleSpecs);
  copy.workflows[FILE].sources[NEXT][0].definition.steps.push({ run: 'echo unregistered-role' });
  assert.equal(check(AFTER, NEXT, { roleSpecs: copy }).passed, false);
});

test('ordinary gitleaks keeps the original conversion and its already-installed self-pair', () => {
  assert.equal(check(LEGACY, BEFORE).passed, true);
  assert.equal(check(BEFORE, BEFORE).passed, true);
});

test('ordinary gitleaks admits only the exact next successor and its explicit self-pair', () => {
  for (const before of [BEFORE, AFTER]) {
    const result = check(before);
    assert.equal(result.passed, true, result.reason);
    assert.equal(result.registeredBootstrapOrdinaryTransition, false);
    assert.equal(result.execution_authority, false);
    assert.equal(result.roles[0].definition_sha256, 'ce19a253d56ca6b81ad83cb6d86045f30e679397e815f14a632fe8aada46dacc');
  }
});

test('actual workflowFindings accepts the f6ae base to f887 gitleaks transition without any RPC', async () => {
  const seen = [];
  const contents = new Map([[HEAD, text(AFTER)], [BASE, text(BEFORE)]]);
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://offline.invalid');
    assert.equal(parsed.pathname, `/repos/tdoljyj/cross-memory-system/contents/${FILE}`);
    assert.equal(options.method ?? 'GET', 'GET');
    const ref = parsed.searchParams.get('ref');
    assert.ok(contents.has(ref), 'no other GitHub or Native request is permitted');
    seen.push(ref);
    return new Response(JSON.stringify({ encoding: 'base64', content: Buffer.from(contents.get(ref)).toString('base64') }), { status: 200 });
  };
  const result = await workflowFindings(fetchImpl, { GITHUB_API_URL: 'https://offline.invalid' },
    'tdoljyj/cross-memory-system', [{ filename: FILE, status: 'modified' }], HEAD, BASE);
  assert.deepEqual(result.gate, []);
  assert.deepEqual(seen, [HEAD, BASE]);
});

test('ordinary gitleaks refuses a skipped generation, rollback and unrelated registered predecessor', () => {
  assert.equal(check(LEGACY, AFTER).passed, false);
  assert.equal(check(AFTER, BEFORE).passed, false);
  assert.equal(check('cbe2f69ddabb49cd91cd26664a88d47859696fa5', AFTER).passed, false);
});

test('ordinary gitleaks requires both trusted profiles and the independent full successor Role', () => {
  const without = blob => {
    const copy = structuredClone(profiles);
    copy.workflows[FILE].accepted_sources = copy.workflows[FILE].accepted_sources.filter(value => value.workflow_blob !== blob);
    return copy;
  };
  for (const candidate of [null, without(BEFORE), without(AFTER)]) assert.equal(check(BEFORE, AFTER, { profiles: candidate }).passed, false);
  const mutations = [
    specs => { delete specs.workflows[FILE].sources[AFTER]; },
    specs => { specs.workflows[FILE].sources[AFTER][0].definition_sha256 = '0'.repeat(64); },
    specs => { specs.workflows[FILE].sources[AFTER][0].definition.steps.push({ run: 'echo unregistered-role' }); },
  ];
  assert.equal(check(BEFORE, AFTER, { roleSpecs: null }).passed, false);
  for (const mutate of mutations) {
    const copy = structuredClone(roleSpecs); mutate(copy);
    assert.equal(check(BEFORE, AFTER, { roleSpecs: copy }).passed, false);
  }
});

test('a catalogue-registered third Source cannot substitute for the exact pinned successor', () => {
  const extraText = `${text(AFTER)}\n# not an accepted ordinary-CI transition\n`;
  const blob = workflowBlob(extraText);
  const copy = structuredClone(profiles);
  copy.workflows[FILE].accepted_sources.push({ ...structuredClone(entry(AFTER)),
    workflow_blob: blob, source_sha256: sha256Hex(extraText), source_yaml: extraText });
  const specs = structuredClone(roleSpecs);
  specs.workflows[FILE].sources[blob] = structuredClone(specs.workflows[FILE].sources[AFTER]);
  assert.equal(registeredWorkflowSource(copy, FILE, blob).passed, true, 'third Source is valid in the generic catalogue');
  assert.equal(check(BEFORE, AFTER, { profiles: copy, roleSpecs: specs, headText: extraText }).passed, false);
});

test('ordinary gitleaks refuses changed blob bytes and FrozenGate bytes', () => {
  assert.equal(check(BEFORE, AFTER, { headText: `${text(AFTER)}\n` }).passed, false);
  const changedGate = text(AFTER).replace('--mode gate', '--mode required');
  assert.notEqual(changedGate, text(AFTER));
  assert.equal(check(BEFORE, AFTER, { headText: changedGate }).passed, false);
  const copy = structuredClone(profiles);
  copy.workflows[FILE].accepted_sources.find(value => value.workflow_blob === AFTER).source_yaml = changedGate;
  assert.equal(check(BEFORE, AFTER, { profiles: copy }).passed, false);
});

test('ordinary gitleaks refuses invalid file/status/rename/base shapes', () => {
  for (const status of ['added', 'copied', 'renamed', 'removed', undefined]) {
    assert.equal(check(BEFORE, AFTER, { file: { filename: FILE, status } }).passed, false);
  }
  for (const file of [undefined, { filename: '.github/workflows/other.yml', status: 'modified' },
    { filename: FILE, status: 'modified', previous_filename: '.github/workflows/other.yml' }]) {
    assert.equal(check(BEFORE, AFTER, { file }).passed, false);
  }
  assert.equal(check(BEFORE, AFTER, { baseText: null }).passed, false);
});

// Task 169fd456: the hosted job prints its relay token as hex (GitHub masks JWT-shaped text). Both hex-identity
// successors are registered before either workflow changes; each admits only its exact predecessor and self-pair.
const HEX_SUCCESSORS = [
  ['.github/workflows/gitleaks.yml', NEXT, 'e6fafbb0a40ce37795f1e50bbda03cd33fbf40e0',
    '9d6c23d2ae4769d123f7ddcd3a25810878d36a85efc2403c07ecec5ecd17cdab', '339ea01c079430a47e66f1822cccdb281630117934158287dfbf1629c51e497f'],
  ['.github/workflows/trivy.yml', '300ad19a59bf529ccebd45ae7fbb76189f806316', '50bd4ae3312ea3c5b1896a9ec81922b0b392343b',
    '8ec20479b6a7bbf3cc3c2b085271c9a7ed4dc06a16ea9e39c05900428adfa0d2', '55d8a4d90ceb55f6abdd4ce583d0a0481987b28b9fbc7ba80372a455c48bdde8'],
];
test('the hex relay identity successors of gitleaks and trivy are registered (169fd456)', () => {
  for (const [file, before, after, sha256, definition] of HEX_SUCCESSORS) {
    const source = blob => [profiles.workflows[file], ...profiles.workflows[file].accepted_sources].find(value => value.workflow_blob === blob).source_yaml;
    const hexCheck = (from, to, extra = {}) => registeredBootstrapOrdinarySuccessor({ file: { filename: file, status: 'modified' },
      baseText: source(from), headText: source(to), profiles, roleSpecs, ...extra });
    assert.equal(workflowBlob(source(after)), after);
    assert.equal(sha256Hex(source(after)), sha256);
    assert.ok(source(after).includes('["value"].encode("ascii").hex())'), file);
    // Only the identity step differs from the predecessor.
    const strip = text => text.replace(/      - name: Emit relay identity\n[\s\S]*$/, '');
    assert.equal(strip(source(after)), strip(source(before)), file);
    for (const from of [before, after]) {
      const result = hexCheck(from, after);
      assert.equal(result.passed, true, `${file} ${result.reason}`);
      assert.equal(result.registeredBootstrapOrdinaryTransition, false);
      assert.equal(result.roles[0].definition_sha256, definition);
    }
    assert.equal(hexCheck(after, before).passed, false, `${file} rollback`);
    assert.equal(hexCheck(before, after, { headText: source(after).replace('.hex())', '.hex() )') }).passed, false, `${file} changed bytes`);
  }
});
