// Hosted relay registry (S15): deterministic derivation from one commit, the
// Owner Decision bc6fdad1 name rule, closure pins and the workflow refusals.
// Offline: an in-memory reader, plus a throwaway local git repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildRegistry, gitBlobSha1, gitObjectReader, main, scanWorkflow, serializeRegistry } from '../src/hosted-relay-v1/build-registry.mjs';
import { registryDigestOf, validateRegistry, validateSpec } from '../src/hosted-relay-v1/registry.mjs';
import { digest } from '../src/proof.mjs';
import { B, REPO_FILES, SPEC, fixtureRegistry, memoryReader } from './fixtures/hosted-relay/world.mjs';

const clone = value => structuredClone(value);
const build = (files = REPO_FILES, spec = SPEC, modes = {}) => buildRegistry({ spec, reader: memoryReader(files, { modes }), commit: B, domain: 'fixture' });
const refused = (fn, code, label = code) => assert.throws(fn, error => error.code === code, label);
const GITLEAKS = '.github/workflows/gitleaks.yml';
const HOSTED_LINE = `${REPO_FILES[GITLEAKS].split('\n').find(line => line.includes("&& 'gitleaks-hosted-executor' ||"))}\n`;
const workflowWith = (from, to, file = GITLEAKS) => {
  assert.ok(REPO_FILES[file].includes(from), `fixture lacks ${from}`);
  return { ...REPO_FILES, [file]: REPO_FILES[file].replace(from, to) };
};

test('the committed spec validates and derives a deterministic fixture registry', () => {
  validateSpec(clone(SPEC));
  const first = build(), second = build();
  assert.equal(serializeRegistry(first), serializeRegistry(second));
  assert.equal(first.domain, 'fixture');
  assert.equal(first.sourceCommit, B);
  // PR-B layout: job id `<role>-trusted-self-hosted`, closed expression name.
  const expected = { gitleaks: ['gitleaks-hosted-executor', 25], trivy: ['trivy-hosted-executor', 25] };
  assert.deepEqual(Object.keys(first.roles).sort(), Object.keys(expected));
  for (const [role, [job, minutes]] of Object.entries(expected)) {
    const entry = first.roles[role];
    assert.equal(entry.checkName, role);
    assert.equal(entry.hostedCheckName, job);
    assert.equal(entry.hostedJobId, `${role}-trusted-self-hosted`);
    assert.equal(entry.hostedJobTimeoutMinutes, minutes);
    assert.equal(entry.workflowBlob, gitBlobSha1(Buffer.from(REPO_FILES[entry.workflowPath])));
    for (const item of entry.closure) assert.equal(item.blob, gitBlobSha1(Buffer.from(REPO_FILES[item.path])));
  }
  const frozen = validateRegistry(first, { domain: 'fixture' });
  assert.match(registryDigestOf(frozen), /^[a-f0-9]{64}$/);
  assert.ok(Object.isFrozen(frozen.roles.gitleaks.closure[0]));
});

const GIT = (() => { const probe = spawnSync('git', ['--version'], { windowsHide: true }); return probe.status === 0 ? 'git' : null; })();

test('a real git commit and the in-memory reader derive identical pins; the CLI writes the same bytes once', { skip: GIT ? false : 'git unavailable' }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clued-relay-registry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (...args) => { const r = spawnSync(GIT, ['-C', dir, ...args], { env, windowsHide: true }); assert.equal(r.status, 0, String(r.stderr)); return String(r.stdout).trim(); };
  git('init', '-q', '-b', 'main'); git('config', 'core.autocrlf', 'false');
  for (const [file, content] of Object.entries(REPO_FILES)) {
    fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  git('add', '-A'); git('commit', '-q', '-m', 'fixture');
  const commit = git('rev-parse', 'HEAD');
  const real = buildRegistry({ spec: SPEC, reader: gitObjectReader(dir, { git: GIT }), commit: 'HEAD', domain: 'fixture' });
  assert.equal(real.sourceCommit, commit);
  assert.deepEqual(real.roles, build().roles);
  const out = path.join(dir, 'registry.json'), lines = [];
  const sink = { write: text => lines.push(text) };
  assert.equal(main(['--repo', dir, '--commit', commit, '--domain', 'fixture', '--out', out], sink), 0);
  assert.equal(fs.readFileSync(out, 'utf8'), serializeRegistry(real));
  assert.equal(main(['--repo', dir, '--commit', commit, '--domain', 'fixture', '--out', out], sink), 2); // never overwrites
  fs.writeFileSync(out, 'stale');
  assert.equal(main(['--repo', dir, '--commit', commit, '--domain', 'fixture', '--out', out, '--replace'], sink), 0); // one-command rebuild
  assert.equal(fs.readFileSync(out, 'utf8'), serializeRegistry(real));
  assert.equal(JSON.parse(lines.at(-1)).sourceCommit, commit);
  assert.deepEqual(fs.readdirSync(dir).filter(name => name.endsWith('.tmp')), []);
  assert.equal(main(['--repo', dir, '--commit', commit, '--replace'], sink), 2);
  assert.equal(main(['--repo', dir, '--commit', '--upload-pack=x', '--domain', 'fixture'], sink), 2);
  assert.match(lines.at(-1), /RELAY_REGISTRY_COMMIT_INVALID/);
  assert.equal(main(['--repo', dir], sink), 2);
});

test('a hosted job name equal to a required check name is refused (Owner Decision bc6fdad1)', () => {
  const equal = clone(SPEC); equal.roles.gitleaks.hostedCheckName = 'gitleaks';
  refused(() => validateSpec(equal), 'RELAY_REGISTRY_CHECK_NAMES_EQUAL');
  refused(() => build(REPO_FILES, equal), 'RELAY_REGISTRY_CHECK_NAMES_EQUAL');
  for (const name of ['trivy', 'kooyumi-merge-slot', 'kooyumi-work-admission']) {
    const other = clone(SPEC); other.roles.gitleaks.hostedCheckName = name;
    refused(() => validateSpec(other), 'RELAY_REGISTRY_HOSTED_NAME_IS_REQUIRED');
  }
  const registry = clone(build()); registry.roles.trivy.hostedCheckName = 'trivy';
  refused(() => validateRegistry(registry), 'RELAY_REGISTRY_CHECK_NAMES_EQUAL');
  const duplicate = clone(SPEC); duplicate.roles.trivy.hostedCheckName = 'gitleaks-hosted-executor';
  refused(() => validateSpec(duplicate), 'RELAY_REGISTRY_SPEC_INVALID');
  const wrongRequired = clone(SPEC); wrongRequired.roles.gitleaks.checkName = 'trivy';
  refused(() => validateSpec(wrongRequired), 'RELAY_REGISTRY_SPEC_INVALID');
  const kooyumi = clone(SPEC); kooyumi.roles['kooyumi-merge-slot'] = clone(SPEC.roles.gitleaks);
  refused(() => validateSpec(kooyumi), 'RELAY_REGISTRY_ROLE_NOT_RELAYABLE');
  // contract-placement runs PR code while it holds id-token: write: never relayed.
  const placement = clone(SPEC); placement.roles['contract-placement'] = { checkName: 'contract-placement', hostedCheckName: 'contract-placement-hosted-executor',
    workflowPath: '.github/workflows/contract-placement.yml', runsOn: 'ubuntu-latest', closure: ['.github/workflows/contract-placement.yml'], mustNotExist: [] };
  refused(() => validateSpec(placement), 'RELAY_REGISTRY_ROLE_NOT_RELAYABLE');
  const placementRegistry = clone(build()); placementRegistry.roles['contract-placement'] = clone(placementRegistry.roles.trivy);
  refused(() => validateRegistry(placementRegistry), 'RELAY_REGISTRY_ROLE_NOT_RELAYABLE');
});

test('closure pins come only from regular blobs present at the commit; forbidden paths must be absent', () => {
  const { ['.gitleaksignore']: _removed, ...missing } = REPO_FILES;
  refused(() => build(missing), 'RELAY_REGISTRY_CLOSURE_MISSING');
  refused(() => build(REPO_FILES, SPEC, { 'scripts/ci/reviewed_gitleaks.py': '120000' }), 'RELAY_REGISTRY_CLOSURE_NOT_REGULAR');
  refused(() => build(REPO_FILES, SPEC, { '.gitleaks.toml': '160000' }), 'RELAY_REGISTRY_CLOSURE_NOT_REGULAR');
  refused(() => build({ ...REPO_FILES, '.trivyignore': 'CVE-0000-0000\n' }), 'RELAY_REGISTRY_FORBIDDEN_PATH_PRESENT');
  const through = clone(SPEC); through.roles.trivy.mustNotExist = ['.trivyignore', 'src/app.js/inner'];
  refused(() => build(REPO_FILES, through), 'RELAY_REGISTRY_FORBIDDEN_PATH_PRESENT');
  const noWorkflow = clone(SPEC); noWorkflow.roles.gitleaks.closure = noWorkflow.roles.gitleaks.closure.filter(file => file !== GITLEAKS);
  refused(() => validateSpec(noWorkflow), 'RELAY_REGISTRY_SPEC_INVALID');
  const unsorted = clone(SPEC); unsorted.roles.gitleaks.closure.reverse();
  refused(() => validateSpec(unsorted), 'RELAY_REGISTRY_SPEC_INVALID');
  const escape = clone(SPEC); escape.roles.trivy.mustNotExist = ['../outside'];
  refused(() => validateSpec(escape), 'RELAY_REGISTRY_SPEC_INVALID');
  const noGithubRule = clone(SPEC); noGithubRule.forbiddenChangePrefixes = ['docs/'];
  refused(() => validateSpec(noGithubRule), 'RELAY_REGISTRY_SPEC_INVALID');
});

test('the workflow scan refuses a commit whose hosted job could mint an identity it should not', () => {
  const cases = [
    ['open expression hosted name', workflowWith(HOSTED_LINE, '    name: ${{ github.head_ref }}\n')],
    ['bare literal expression', workflowWith(HOSTED_LINE, "    name: ${{ 'gitleaks-hosted-executor' }}\n")],
    ['condition not enclosed', workflowWith(HOSTED_LINE, "    name: ${{ (a) || github.head_ref && 'gitleaks-hosted-executor' || 'x' }}\n")],
    ['nested expression', workflowWith(HOSTED_LINE, "    name: ${{ (a == ${{ b }}) && 'gitleaks-hosted-executor' || 'x' }}\n")],
    ['unbalanced condition', workflowWith(HOSTED_LINE, "    name: ${{ (a) || (b && 'gitleaks-hosted-executor' || 'x' }}\n")],
    ['hosted alternative is the required name', workflowWith("|| 'gitleaks-hosted-executor-skipped' }}", "|| 'gitleaks' }}")],
    ['hosted alternative is another required name', workflowWith("|| 'gitleaks-hosted-executor-skipped' }}", "|| 'kooyumi-merge-slot' }}")],
    ['literal hosted name equal to the required name', workflowWith(HOSTED_LINE, '    name: gitleaks\n')],
    ['a job that can carry the required name', workflowWith('    name: admission-gate\n', "    name: ${{ (github.event_name == 'push') && 'gitleaks' || 'admission-gate' }}\n")],
    ['a job id that is the required name', workflowWith('  admission-gate:\n    name: admission-gate\n', '  gitleaks:\n')],
    ['a second job with the hosted name', workflowWith('    name: admission-gate\n', '    name: gitleaks-hosted-executor\n')],
    ['id-token on another job', workflowWith('      pull-requests: read\n', '      pull-requests: read\n      id-token: write\n')],
    ['top-level id-token', workflowWith('permissions:\n  contents: read\n', 'permissions:\n  contents: read\n  id-token: write\n')],
    ['identity step not last', { ...REPO_FILES, [GITLEAKS]: `${REPO_FILES[GITLEAKS]}      - name: After identity\n        run: echo late\n` }],
    ['a step allowed to fail', workflowWith('      - name: Scan complete history\n', '      - name: Scan complete history\n        continue-on-error: true\n')],
    ['extra job permission', workflowWith('      contents: read\n      id-token: write\n', '      actions: read\n      contents: read\n      id-token: write\n')],
    ['pull_request_target', workflowWith('  pull_request:\n', '  pull_request_target:\n')],
    ['self-hosted runner', workflowWith('    runs-on: ubuntu-latest\n    timeout-minutes: 25\n', '    runs-on: [self-hosted, Linux]\n    timeout-minutes: 25\n')],
    ['no timeout', workflowWith('    timeout-minutes: 25\n', '')],
    ['tab', workflowWith('      - name: Scan complete history\n', '      - name: Scan complete history\t\n')],
    ['conditional identity step', workflowWith('      - name: Emit relay identity\n', '      - name: Emit relay identity\n        if: always()\n')],
    // A raw JWT is masked to "***" by GitHub (Task 169fd456): the identity step must print hex.
    ['raw token annotation', workflowWith('["value"].encode("ascii").hex()', '["value"]')],
    ['hex only in a comment', workflowWith('["value"].encode("ascii").hex())\')"', '["value"])\')"  # ["value"].encode("ascii").hex()')],
    ['token minted earlier', workflowWith('      - name: Scan complete history\n', '      - name: Scan complete history\n        env:\n          T: $ACTIONS_ID_TOKEN_REQUEST_TOKEN\n')],
  ];
  for (const [label, files] of cases) refused(() => build(files), 'RELAY_REGISTRY_WORKFLOW_REFUSED', label);
  // Flow-style job permissions are read the same way.
  const flow = workflowWith('    permissions:\n      contents: read\n      id-token: write\n', '    permissions: {contents: read, id-token: write}\n');
  assert.deepEqual(scanWorkflow(Buffer.from(flow[GITLEAKS]), SPEC.roles.gitleaks), { hostedJobId: 'gitleaks-trusted-self-hosted', hostedJobTimeoutMinutes: 25,
    executed: ['scripts/ci/reviewed_gitleaks.py'], localActions: ['.github/actions/ci-temporary-storage'] });
  // A literal hosted name (as the never-relayed placement job uses) is read as well.
  const literal = workflowWith(HOSTED_LINE, '    name: gitleaks-hosted-executor\n');
  assert.equal(scanWorkflow(Buffer.from(literal[GITLEAKS]), SPEC.roles.gitleaks).hostedJobId, 'gitleaks-trusted-self-hosted');
});

test('a registry is refused when tampered, mis-domained or not validated', () => {
  const registry = build();
  const tampered = clone(registry); tampered.roles.gitleaks.closure[0].blob = 'f'.repeat(40);
  refused(() => validateRegistry(tampered), 'RELAY_REGISTRY_INVALID');
  const reordered = clone(registry); reordered.roles.gitleaks.closure.reverse();
  refused(() => validateRegistry(reordered), 'RELAY_REGISTRY_INVALID');
  const extra = clone(registry); extra.note = 'x';
  refused(() => validateRegistry(extra), 'RELAY_REGISTRY_INVALID');
  const otherApp = clone(registry); otherApp.publisherAppId = 5164952;
  refused(() => validateRegistry(otherApp), 'RELAY_REGISTRY_INVALID');
  const otherAudience = clone(registry); otherAudience.audience = 'sts.amazonaws.com';
  refused(() => validateRegistry(otherAudience), 'RELAY_REGISTRY_INVALID');
  refused(() => validateRegistry(clone(registry), { domain: 'production' }), 'RELAY_REGISTRY_DOMAIN_MISMATCH');
  refused(() => registryDigestOf(clone(registry)), 'RELAY_REGISTRY_NOT_VALIDATED');
  assert.equal(registryDigestOf(fixtureRegistry()), registryDigestOf(fixtureRegistry()));
});

// The committed production registry (S15) is exactly what build-registry
// derives from its recorded frozen PR-B commit, whenever that commit is present.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../..');
const COMMITTED = path.join(HERE, '../src/hosted-relay-v1/registry.json');
// A registry built before the PR-A isolation rules (no per-role forbiddenChangePrefixes) is refused, so the relay
// fails closed (stage R refused) until PR-B is re-frozen with `python3 -I -B` and the registry rebuilt with this
// builder; the old PR-B commit itself is refused by the new builder.
const pendingIsolationRebuild = raw => Object.values(raw?.roles ?? {}).some(r => !Object.hasOwn(r, 'forbiddenChangePrefixes'));
test('the committed production registry validates and rebuilds byte-identically from its PR-B commit', async t => {
  let bytes = fs.readFileSync(COMMITTED, 'utf8');
  // /2 has its own exact-gate and frozen-commit regression. Keep this /1
  // regression on the historical object preserved at that successor's freeze,
  // rather than rebuilding /2 workflows with a legacy spec or changing it.
  const current = JSON.parse(bytes);
  if (current.contract === 'clued.independent-ci.hosted-relay-registry/2') {
    const historical = spawnSync(GIT, ['-C', ROOT, 'show', `${current.sourceCommit}:work/actions-hosted-migration/independent-ci-v1/src/hosted-relay-v1/registry.json`], { windowsHide: true });
    assert.equal(historical.status, 0, 'historical /1 registry must remain in the local freeze object');
    bytes = String(historical.stdout);
    assert.equal(JSON.parse(bytes).contract, 'clued.independent-ci.hosted-relay-registry/1');
  }
  if (pendingIsolationRebuild(JSON.parse(bytes))) {
    refused(() => validateRegistry(JSON.parse(bytes), { domain: 'production' }), 'RELAY_REGISTRY_INVALID', 'a pre-isolation registry fails closed');
    const sourceCommit = JSON.parse(bytes).sourceCommit;
    const present = GIT && spawnSync(GIT, ['-C', ROOT, 'cat-file', '-e', `${sourceCommit}^{commit}`], { windowsHide: true }).status === 0;
    if (present) refused(() => buildRegistry({ spec: SPEC, reader: gitObjectReader(ROOT, { git: GIT }), commit: sourceCommit }), 'RELAY_REGISTRY_WORKFLOW_REFUSED', 'its PR-B commit runs Python without -I');
    return;
  }
  const registry = validateRegistry(JSON.parse(bytes), { domain: 'production' });
  assert.deepEqual(Object.keys(registry.roles).sort(), ['gitleaks', 'trivy']);
  for (const [role, entry] of Object.entries(registry.roles)) {
    assert.equal(entry.checkName, role);
    assert.equal(entry.hostedCheckName, `${role}-hosted-executor`);
  }
  assert.equal(bytes, serializeRegistry(JSON.parse(bytes)));
  const present = GIT && spawnSync(GIT, ['-C', ROOT, 'cat-file', '-e', `${registry.sourceCommit}^{commit}`], { windowsHide: true }).status === 0;
  if (!present) { t.skip(`source commit ${registry.sourceCommit} not in the local object store`); return; }
  const rebuilt = buildRegistry({ spec: SPEC, reader: gitObjectReader(ROOT, { git: GIT }), commit: registry.sourceCommit });
  // A registry built by an older builder or spec (before the trivy checks digest, every .gitattributes and whole local
  // actions were pinned) still validates; stage R then keeps trivy local (no checks digest) and gitleaks keeps working.
  // The same PR-B commit rebuilds with the current builder, adding only those pins.
  if (!Object.hasOwn(registry.roles.trivy ?? {}, 'checksDigest') || registry.specSha256 !== digest(validateSpec(clone(SPEC)))) {
    t.diagnostic('the committed registry predates the current builder or spec; rebuild it from the frozen PR-B commit');
    assert.match(rebuilt.roles.trivy.checksDigest, /^sha256:[a-f0-9]{64}$/);
    for (const [role, entry] of Object.entries(rebuilt.roles)) {
      const old = registry.roles[role], paths = new Set(old.closure.map(item => item.path));
      assert.deepEqual(entry.closure.filter(item => paths.has(item.path)), old.closure, role);
      assert.ok(entry.closure.filter(item => !paths.has(item.path)).every(item => item.path.startsWith('.github/actions/') || item.path.endsWith('.gitattributes')), role);
      assert.equal(entry.workflowBlob, old.workflowBlob);
    }
    return;
  }
  assert.equal(serializeRegistry(rebuilt), bytes);
});

// PR-A re-review: a local action the hosted job uses (`uses: ./<dir>`) is pinned whole, never hand-listed in part.
test('the builder pins every file of every local action of the hosted job, regular and covered, or refuses', () => {
  const ACTION = '.github/actions/ci-temporary-storage';
  const built = build();
  for (const role of ['gitleaks', 'trivy']) {
    const pinned = built.roles[role].closure.map(item => item.path).filter(file => file.startsWith(`${ACTION}/`));
    assert.deepEqual(pinned, Object.keys(REPO_FILES).filter(file => file.startsWith(`${ACTION}/`)).sort(), role);
  }
  // A file of the action that the spec does not pin (added to the action, or dropped from the spec).
  refused(() => build({ ...REPO_FILES, [`${ACTION}/extra.mjs`]: 'export {};\n' }), 'RELAY_REGISTRY_LOCAL_ACTION_NOT_PINNED', 'unpinned new file');
  const narrowed = clone(SPEC); narrowed.roles.trivy.closure = narrowed.roles.trivy.closure.filter(file => file !== `${ACTION}/coverage.json`);
  refused(() => build(REPO_FILES, narrowed), 'RELAY_REGISTRY_LOCAL_ACTION_NOT_PINNED', 'file dropped from the spec');
  // A symbolic link or a submodule inside the action is never a pinned regular file.
  refused(() => build(REPO_FILES, SPEC, { [`${ACTION}/setup.mjs`]: '120000' }), 'RELAY_REGISTRY_CLOSURE_NOT_REGULAR', 'symlink');
  const USES = `        uses: ./${ACTION}\n`;
  const usesOther = (dir, extra = {}) => ({ ...workflowWith(USES, `        uses: ./${dir}\n`), ...extra });
  // An action that is not there, or has no action.yml, is refused.
  refused(() => build(usesOther('.github/actions/missing')), 'RELAY_REGISTRY_LOCAL_ACTION_MISSING', 'missing action');
  refused(() => build(usesOther('.github/actions/noaction', { '.github/actions/noaction/run.sh': 'true\n' })), 'RELAY_REGISTRY_LOCAL_ACTION_MISSING', 'no action.yml');
  // A local action outside every forbidden change prefix could be changed by the very PR that is relayed.
  const outside = clone(SPEC); outside.roles.gitleaks.closure = [...outside.roles.gitleaks.closure, 'tools/act/action.yml'].sort();
  refused(() => build(usesOther('tools/act', { 'tools/act/action.yml': 'runs: {using: composite, steps: []}\n' }), outside), 'RELAY_REGISTRY_LOCAL_ACTION_NOT_COVERED', 'not covered');
  // Escaping or ambiguous local paths are refused by the scan.
  for (const bad of ['./.github/actions/../workflows', './', '.github/actions/x', './.github//actions']) {
    refused(() => build(workflowWith(USES, `        uses: ${bad}\n`)), 'RELAY_REGISTRY_WORKFLOW_REFUSED', bad);
  }
  // Quoted and commented forms are the same local action.
  assert.deepEqual(scanWorkflow(Buffer.from(workflowWith(USES, `        uses: './${ACTION}/' # pinned whole\n`)[GITLEAKS]), SPEC.roles.gitleaks).localActions, [ACTION]);
});

// PR-A review BLOCKER: the hosted gitleaks job ran `python3 scripts/ci/reviewed_gitleaks.py` from the PR checkout
// while it held id-token: write; without -I Python puts scripts/ci first on sys.path, so a PR adding
// scripts/ci/argparse.py ran PR code before the scan. The builder now requires isolated Python, pins every
// executed script, and refuses a registry that does not forbid changes under the executed script's directory.
test('the builder refuses non-isolated Python, -m, repository Node scripts, and executed scripts that are not pinned or covered', () => {
  const SCAN = 'python3 -I -B scripts/ci/reviewed_gitleaks.py', IDENT = 'python3 -I -B -c ';
  for (const [label, files] of [
    ['script without -I (the reported shadowing route)', workflowWith(SCAN, 'python3 scripts/ci/reviewed_gitleaks.py')],
    ['script with -B only', workflowWith(SCAN, 'python3 -B scripts/ci/reviewed_gitleaks.py')],
    ['identity -c without -I (cwd on sys.path)', workflowWith(IDENT, 'python3 -c ')],
    ['python -m', workflowWith(SCAN, 'python3 -I -m reviewed_gitleaks')],
    ['a repository node script', workflowWith(SCAN, `node scripts/ci/helper.mjs && ${SCAN}`)],
  ]) refused(() => build(files), 'RELAY_REGISTRY_WORKFLOW_REFUSED', label);
  // a bash script outside the closure is not pinned
  refused(() => build(workflowWith(SCAN, `bash scripts/ci/extra.sh && ${SCAN}`)), 'RELAY_REGISTRY_EXECUTED_SCRIPT_NOT_PINNED');
  // the role must forbid changes under the executed script's directory
  const uncovered = clone(SPEC); uncovered.roles.gitleaks.forbiddenChangePrefixes = [];
  refused(() => build(REPO_FILES, uncovered), 'RELAY_REGISTRY_EXECUTED_SCRIPT_NOT_COVERED');
  const elsewhere = clone(SPEC); elsewhere.roles.gitleaks.forbiddenChangePrefixes = ['scripts/other/'];
  refused(() => build(REPO_FILES, elsewhere), 'RELAY_REGISTRY_EXECUTED_SCRIPT_NOT_COVERED');
  // the registry carries the prefixes, and the attestation binds them through closureSha256
  const registry = build();
  assert.deepEqual(registry.roles.gitleaks.forbiddenChangePrefixes, ['scripts/ci/']);
  assert.deepEqual(registry.roles.trivy.forbiddenChangePrefixes, []);
  const widened = clone(registry); widened.roles.gitleaks.forbiddenChangePrefixes = [];
  refused(() => validateRegistry(widened, { domain: 'fixture' }), 'RELAY_REGISTRY_INVALID');
  for (const bad of [['scripts/ci'], ['/abs/'], ['../up/'], ['b/', 'a/']]) {
    const spec = clone(SPEC); spec.roles.gitleaks.forbiddenChangePrefixes = bad;
    refused(() => validateSpec(spec), 'RELAY_REGISTRY_SPEC_INVALID', bad.join(','));
  }
});

// PR-A round-3 review: the hosted trivy job's checks bundle digest is read from its env (exactly one CHECKS_DIGEST,
// actually used for trivy-checks@$CHECKS_DIGEST), never hand-copied; every .gitattributes of the commit is pinned.
test('the builder reads the trivy checks digest from the hosted job and pins every .gitattributes of the commit', () => {
  const TRIVY = '.github/workflows/trivy.yml', built = build();
  assert.equal(built.roles.trivy.checksDigest, `sha256:${'c'.repeat(64)}`);
  assert.equal(Object.hasOwn(built.roles.gitleaks, 'checksDigest'), false);
  const LINE = `          CHECKS_DIGEST: sha256:${'c'.repeat(64)}\n`;
  const trivyWith = (from, to) => workflowWith(from, to, TRIVY);
  for (const [label, files] of [
    ['missing', trivyWith(LINE, '')],
    ['tag, not a digest', trivyWith(LINE, '          CHECKS_DIGEST: ghcr.io/aquasecurity/trivy-checks:2\n')],
    ['twice', trivyWith(LINE, LINE + `          CHECKS_DIGEST: sha256:${'e'.repeat(64)}\n`)],
    ['not used', trivyWith('trivy-checks@$CHECKS_DIGEST', 'trivy-checks:2')],
  ]) refused(() => build(files), 'RELAY_REGISTRY_WORKFLOW_REFUSED', label);
  // A registry without it still validates (older builder); a malformed one does not.
  const raw = JSON.parse(JSON.stringify(built)); delete raw.roles.trivy.checksDigest;
  assert.ok(validateRegistry(raw, { domain: 'fixture' }));
  raw.roles.trivy.checksDigest = 'sha256:abc';
  refused(() => validateRegistry(raw, { domain: 'fixture' }), 'RELAY_REGISTRY_INVALID', 'malformed digest');
  const onGitleaks = JSON.parse(JSON.stringify(built)); onGitleaks.roles.gitleaks.checksDigest = built.roles.trivy.checksDigest;
  refused(() => validateRegistry(onGitleaks, { domain: 'fixture' }), 'RELAY_REGISTRY_INVALID', 'not a gitleaks field');
  // Every .gitattributes of the commit, at any depth, is pinned for both relayed roles (spec lists only the root one).
  assert.equal(SPEC.roles.gitleaks.closure.includes('docs/.gitattributes'), false);
  const deeper = build({ ...REPO_FILES, 'a/b/c/.gitattributes': '*.dat -text\n', 'a/b/c/x.gitattributes': 'not attributes\n' });
  for (const role of ['gitleaks', 'trivy']) {
    const pinned = deeper.roles[role].closure.map(item => item.path);
    assert.deepEqual(pinned.filter(file => file.endsWith('.gitattributes')), ['.gitattributes', 'a/b/c/.gitattributes', 'docs/.gitattributes'], role);
  }
  // A .gitattributes that is not a regular file is refused like any closure path.
  refused(() => build(REPO_FILES, SPEC, { 'docs/.gitattributes': '120000' }), 'RELAY_REGISTRY_CLOSURE_NOT_REGULAR', 'symlinked attributes');
});
