// Explicit successor schema. The /1 fixture remains immutable and exercised by
// hosted-relay-registry.test.mjs; no production qualification is created here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SPEC_CONTRACT, REGISTRY_CONTRACT, SPEC_CONTRACT_V2, REGISTRY_CONTRACT_V2,
  SCAN_START_WORKFLOW_GATE, validateSpec, validateRegistry, ROLE_INPUT_PINS } from '../src/hosted-relay-v1/registry.mjs';
import { buildRegistry, gitObjectReader, gitBlobSha1, main, scanWorkflow, serializeRegistry } from '../src/hosted-relay-v1/build-registry.mjs';
import { digest } from '../src/proof.mjs';
import { gateConditionHolds, gateFindings } from '../../../../scripts/ci/clued-work-admission.mjs';

const spec = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../src/hosted-relay-v1/registry.scan-start.spec.json', import.meta.url)), 'utf8'));
const legacy = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../src/hosted-relay-v1/registry.spec.json', import.meta.url)), 'utf8'));
const clone = v => structuredClone(v);
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const FREEZE = 'c8c146b4067a32a0ed3a1a6be04dda52a59dd4db', frozenReader = gitObjectReader(ROOT);
const CURRENT_REGISTRY_SNAPSHOT = 'dc5d309abb0dea547544cdc7d657e02513445f81';
const HISTORICAL_S190 = 'd86854407a1a69ec44cafd721438988e8a9af7e8';
// Git blobs are the freeze boundary; a Windows checkout may have CRLF bytes.
const workflows = Object.fromEntries(Object.entries(spec.roles).map(([role, entry]) =>
  [role, frozenReader.blob(frozenReader.entry(FREEZE, entry.workflowPath).sha).toString('utf8')]));
const options = role => ({ scanStart: spec.scanStart, inputPin: ROLE_INPUT_PINS[role] ?? null });

test('current /2 production registry rebuilds byte-identically from the actual reviewed local freeze', () => {
  const bytes = fs.readFileSync(new URL('../src/hosted-relay-v1/registry.json', import.meta.url), 'utf8');
  const current = validateRegistry(JSON.parse(bytes), { domain: 'production' });
  assert.equal(current.contract, REGISTRY_CONTRACT_V2);
  assert.equal(current.sourceCommit, CURRENT_REGISTRY_SNAPSHOT);
  assert.equal(current.requireCheckRunIdClaim, true);
  assert.deepEqual(current.scanStart, SCAN_START_WORKFLOW_GATE);
  const reader = gitObjectReader(ROOT);
  const rebuilt = buildRegistry({ spec, reader, commit: current.sourceCommit, domain: 'production' });
  assert.equal(serializeRegistry(rebuilt), bytes);
  for (const [role, entry] of Object.entries(current.roles)) {
    const workflow = reader.blob(reader.entry(current.sourceCommit, entry.workflowPath).sha);
    assert.equal(gitBlobSha1(workflow), entry.workflowBlob);
    const scan = scanWorkflow(workflow, spec.roles[role], options(role));
    assert.ok(scan.executed.includes(SCAN_START_WORKFLOW_GATE.scriptPath));
    const helper = entry.closure.find(p => p.path === SCAN_START_WORKFLOW_GATE.scriptPath);
    assert.equal(helper.sha256, SCAN_START_WORKFLOW_GATE.scriptSha256);
    assert.equal(helper.blob, reader.entry(current.sourceCommit, helper.path).sha);
  }
  assert.equal(Object.hasOwn(current, 'qualified'), false);
});

test('historical S190 /2 registry still rebuilds byte-identically from its original c8 freeze', () => {
  const registryPath = 'work/actions-hosted-migration/independent-ci-v1/src/hosted-relay-v1/registry.json';
  const oldEntry = frozenReader.entry(HISTORICAL_S190, registryPath);
  assert.ok(oldEntry && oldEntry.type === 'blob');
  const oldBytes = frozenReader.blob(oldEntry.sha).toString('utf8');
  const historical = validateRegistry(JSON.parse(oldBytes), { domain: 'production' });
  assert.equal(historical.sourceCommit, FREEZE);
  assert.equal(historical.contract, REGISTRY_CONTRACT_V2);
  assert.equal(serializeRegistry(buildRegistry({ spec, reader: frozenReader, commit: FREEZE, domain: 'production' })), oldBytes);
  assert.equal(Object.hasOwn(historical, 'qualified'), false);
});

test('scan-start is an explicit /2 successor; legacy contracts/spec stay /1 with their original fields', () => {
  assert.equal(SPEC_CONTRACT, 'clued.independent-ci.hosted-relay-registry-spec/1');
  assert.equal(REGISTRY_CONTRACT, 'clued.independent-ci.hosted-relay-registry/1');
  assert.equal(SPEC_CONTRACT_V2, 'clued.independent-ci.hosted-relay-registry-spec/2');
  assert.equal(REGISTRY_CONTRACT_V2, 'clued.independent-ci.hosted-relay-registry/2');
  assert.equal(legacy.contract, SPEC_CONTRACT); assert.equal(legacy.requireCheckRunIdClaim, false);
  assert.equal(Object.hasOwn(legacy, 'scanStart'), false); validateSpec(legacy);
  assert.equal(spec.contract, SPEC_CONTRACT_V2); assert.equal(spec.requireCheckRunIdClaim, true);
  assert.deepEqual(validateSpec(spec).scanStart, SCAN_START_WORKFLOW_GATE);
  assert.equal(Object.hasOwn(spec, 'qualified'), false);
  assert.throws(() => validateSpec({ ...legacy, scanStart: clone(SCAN_START_WORKFLOW_GATE) }));
});

test('/2 freezes the actual workflow/helper blobs from a real local Git commit; explicit CLI spec is required', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clued-registry-v2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (...args) => { const r = spawnSync('git', ['-C', dir, ...args], { env, windowsHide: true });
    assert.equal(r.status, 0, String(r.stderr)); return String(r.stdout).trim(); };
  git('init', '-q', '-b', 'main'); git('config', 'core.autocrlf', 'false');
  for (const file of new Set(Object.values(spec.roles).flatMap(r => r.closure))) {
    fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), frozenReader.blob(frozenReader.entry(FREEZE, file).sha));
  }
  git('add', '-A'); git('commit', '-q', '-m', 'isolated actual workflow/helper freeze');
  const commit = git('rev-parse', 'HEAD'), reader = gitObjectReader(dir);
  const registry = buildRegistry({ spec, reader, commit, domain: 'fixture' });
  assert.equal(registry.contract, REGISTRY_CONTRACT_V2); assert.equal(registry.sourceCommit, commit);
  assert.equal(registry.requireCheckRunIdClaim, true); assert.equal(Object.hasOwn(registry, 'qualified'), false);
  for (const [role, entry] of Object.entries(registry.roles)) {
    const helper = entry.closure.find(p => p.path === spec.scanStart.scriptPath);
    assert.equal(helper.sha256, SCAN_START_WORKFLOW_GATE.scriptSha256);
    assert.equal(helper.blob, gitBlobSha1(fs.readFileSync(path.join(ROOT, spec.scanStart.scriptPath))));
    assert.equal(entry.workflowBlob, gitBlobSha1(Buffer.from(workflows[role])));
    assert.ok(entry.forbiddenChangePrefixes.includes('scripts/ci/'));
  }
  validateRegistry(registry, { domain: 'fixture' });
  const output = path.join(dir, 'derived.json'), sink = { write() {} };
  const specFile = fileURLToPath(new URL('../src/hosted-relay-v1/registry.scan-start.spec.json', import.meta.url));
  assert.equal(main(['--repo', dir, '--commit', commit, '--spec', specFile, '--domain', 'fixture', '--out', output], sink), 0);
  assert.equal(fs.readFileSync(output, 'utf8'), serializeRegistry(registry));
  assert.equal(main(['--repo', dir, '--commit', commit, '--domain', 'fixture'], sink), 2, 'legacy default does not silently accept /2 permissions/gate');
  const bad = clone(registry); bad.requireCheckRunIdClaim = false; assert.throws(() => validateRegistry(bad));
  const foreign = clone(registry); const pin = foreign.roles.gitleaks.closure.find(p => p.path === spec.scanStart.scriptPath);
  pin.sha256 = 'f'.repeat(64); foreign.roles.gitleaks.closureSha256 = digest({ closure: foreign.roles.gitleaks.closure,
    mustNotExist: foreign.roles.gitleaks.mustNotExist, forbiddenChangePrefixes: foreign.roles.gitleaks.forbiddenChangePrefixes });
  assert.throws(() => validateRegistry(foreign));
  fs.appendFileSync(path.join(dir, spec.scanStart.scriptPath), '\n// changed helper\n'); git('add', spec.scanStart.scriptPath);
  git('commit', '-q', '-m', 'isolated wrong helper hash');
  assert.throws(() => buildRegistry({ spec, reader: gitObjectReader(dir), commit: 'HEAD', domain: 'fixture' }), { code: 'RELAY_REGISTRY_SCAN_START_HELPER_CHANGED' });
});

test('/2 exact unconditional gate precedes every action/scan; /1 identity and permission rules remain unchanged', () => {
  for (const [role, entry] of Object.entries(spec.roles)) {
    const text = workflows[role], start = text.indexOf('      - name: Acquire one-time scan permission\n');
    const end = text.indexOf('\n      - ', start + 1) + 1, gate = text.slice(start, end);
    assert.ok(start > 0 && end > start);
    assert.ok(scanWorkflow(Buffer.from(text), entry, options(role)).executed.includes(SCAN_START_WORKFLOW_GATE.scriptPath));
    assert.throws(() => scanWorkflow(Buffer.from(text), entry), { code: 'RELAY_REGISTRY_WORKFLOW_REFUSED' });
    const mutateHosted = fn => { const at = text.indexOf(`  ${role}-trusted-self-hosted:`); return text.slice(0, at) + fn(text.slice(at)); };
    const bad = [
      text.replace(gate, ''), text.replace(SCAN_START_WORKFLOW_GATE.scriptSha256, 'f'.repeat(64)),
      text.replace(gate, gate.replace('        env:', '        if: true\n        env:')),
      text.replace(gate, '').replace('      - name: Emit relay identity', gate + '      - name: Emit relay identity'),
      mutateHosted(body => body.replace('      checks: read', '      checks: write')),
      mutateHosted(body => body.replace('      contents: read', '      contents: read\n      packages: write')),
      text.replace('      - name: Emit relay identity', '      - name: Early token\n        run: echo "$ACTIONS_ID_TOKEN_REQUEST_TOKEN"\n      - name: Emit relay identity'),
      text.replace(gate, gate + gate), text.replace(gate, gate.replace('curl -fsS', 'curl -L -fsS')),
      text.replace(gate, gate.replace('?ref=$BASE_SHA', '?ref=$GITHUB_SHA')),
      text.replace(gate, '      - name: Scan early\n        run: gitleaks detect\n' + gate),
      text.replace(gate, gate.replace('        env:', '        continue-on-error: true\n        env:')),
      text.replace('      - name: Emit relay identity', '      - name: Emit relay identity\n        if: always()'),
    ];
    for (const value of bad) assert.throws(() => scanWorkflow(Buffer.from(value), entry, options(role)), { code: 'RELAY_REGISTRY_WORKFLOW_REFUSED' });
    const condition = text.match(/^ {6}(needs\.admission-gate\.outputs\.admitted == 'true' && .*)$/m)?.[1];
    assert.ok(condition); assert.equal(gateConditionHolds(condition), true);
    assert.deepEqual(gateFindings(text, text), [], 'existing Native gate parser accepts the frozen canonical workflow');
    for (const changed of [
      condition.replace("needs.admission-gate.outputs.admitted == 'true' && ", ''),
      condition.replace("github.event_name == 'pull_request' && ", ''),
      condition.replace(' && (', ' || ('), condition + ' || true', 'always()', '!cancelled()',
      condition + '\n      || true', condition.replace("== 'true'", "!= 'false'"),
    ]) {
      assert.throws(() => scanWorkflow(Buffer.from(text.replace(condition, changed)), entry, options(role)),
        { code: 'RELAY_REGISTRY_WORKFLOW_REFUSED' }, `${role}: exact canonical condition only`);
    }
    // Reordering the three conjunctions only changes their spelling; all
    // boolean assignments preserve admission AND PR AND the original route.
    for (const admitted of [false, true]) for (const pullRequest of [false, true]) for (const route of [false, true])
      assert.equal(admitted && (pullRequest && route), pullRequest && admitted && route);
  }
});
test('/2 requires a closed exact gate, check-run claim and both script-protected role closures', () => {
  for (const change of [v => v.requireCheckRunIdClaim = false, v => delete v.scanStart,
    v => v.scanStart.extra = 'unreviewed', v => v.scanStart.scriptSha256 = 'f'.repeat(64),
    v => v.scanStart.endpoint = 'https://foreign.invalid/v1/ci/scan-start',
    v => v.scanStart.audience = 'clued-hosted-relay-v1', v => v.scanStart.stepName = 'optional',
    v => delete v.roles.trivy, v => v.roles.trivy.forbiddenChangePrefixes = [],
    v => v.roles.gitleaks.closure = v.roles.gitleaks.closure.filter(p => p !== SCAN_START_WORKFLOW_GATE.scriptPath)]) {
    const bad = clone(spec); change(bad); assert.throws(() => validateSpec(bad));
  }
});

test('/2 gate failure cannot be bypassed by any later action, preparation, self-test or scanner condition', () => {
  for (const [role, entry] of Object.entries(spec.roles)) {
    const text=workflows[role], gateAt=text.indexOf('      - name: Acquire one-time scan permission\n');
    const identityAt=text.indexOf('      - name: Emit relay identity\n',gateAt);
    assert.ok(gateAt>=0 && identityAt>gateAt);
    const afterGate=text.indexOf('\n      - ',gateAt+1)+1;
    const steps=[...text.slice(afterGate,identityAt).matchAll(/^ {6}- (?:name|uses):[^\n]*\n/gm)];
    assert.ok(steps.length>=2, `${role}: actual guarded execution chain is present`);
    for (const step of steps) {
      const insert=afterGate+step.index+step[0].length;
      for (const condition of ['always()','!cancelled()','failure()',"github.event_name == 'pull_request'",'success()']) {
        const changed=text.slice(0,insert)+`        if: ${condition}\n`+text.slice(insert);
        assert.throws(()=>scanWorkflow(Buffer.from(changed),entry,options(role)), {code:'RELAY_REGISTRY_WORKFLOW_REFUSED'}, `${role}:${step[0].trim()}:${condition}`);
      }
      for (const key of ["'if'",'"if"']) {
        const changed=text.slice(0,insert)+`        ${key}: always()\n`+text.slice(insert);
        assert.throws(()=>scanWorkflow(Buffer.from(changed),entry,options(role)), {code:'RELAY_REGISTRY_WORKFLOW_REFUSED'});
      }
      for (const property of ['if : always()', '"i\\u0066": always()', '"\\x69f": always()',
        '!!str if: always()', '? if\n        : always()', '<<: {if: always()}', '"run": echo bypass',
        'unknown-property: true']) {
        const changed=text.slice(0,insert)+`        ${property}\n`+text.slice(insert);
        assert.throws(()=>scanWorkflow(Buffer.from(changed),entry,options(role)), {code:'RELAY_REGISTRY_WORKFLOW_REFUSED'});
        const first=text.slice(0,insert-step[0].length)+`      - ${property}\n        name: injected\n`+text.slice(insert);
        assert.throws(()=>scanWorkflow(Buffer.from(first),entry,options(role)), {code:'RELAY_REGISTRY_WORKFLOW_REFUSED'});
      }
    }
    assert.ok(scanWorkflow(Buffer.from(text),entry,options(role)), 'actual frozen unconditional chain stays accepted');
  }
});
