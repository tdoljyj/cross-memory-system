// FIXTURE ONLY. An in-memory GitHub, Native admission and protected authority
// for the hosted relay tests. Keys are generated per test run; no key, token or
// JWT is stored in the repository. Shapes follow the read-only API replies seen
// on PR888 (github-shapes.json); values are synthetic.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createSign, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { canonical, digest, subjectOf } from '../../../src/proof.mjs';
import { JOB_CONTRACT, jobId } from '../../../src/queue.mjs';
import { buildRegistry, gitBlobSha1 } from '../../../src/hosted-relay-v1/build-registry.mjs';
import { relayFail, validateRegistry } from '../../../src/hosted-relay-v1/registry.mjs';
import { createGitHubOidcVerifier } from '../../../src/hosted-relay-v1/oidc.mjs';
import { createHostedRelayObserver } from '../../../src/hosted-relay-v1/observe.mjs';
import { createHostedRelayStage, createHostedRelayVerifier } from '../../../src/hosted-relay-v1/stage.mjs';
import { createStagedCheckPublisher } from '../../../src/staged-check-publisher.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SPEC = JSON.parse(fs.readFileSync(path.join(HERE, '../../../src/hosted-relay-v1/registry.spec.json'), 'utf8'));
export const REPO_FILES = Object.freeze(JSON.parse(fs.readFileSync(path.join(HERE, 'repo.json'), 'utf8')).files);
export const SHAPES = JSON.parse(fs.readFileSync(path.join(HERE, 'github-shapes.json'), 'utf8'));
export const CLAIMS_TEMPLATE = JSON.parse(fs.readFileSync(path.join(HERE, 'oidc-claims.template.json'), 'utf8'));
export const REPO = 'tdoljyj/cross-memory-system', REPO_ID = 1334673495, OWNER_ID = 52366662;
export const PR = 7, HEAD_REF = 'feature/relay-fixture';
// Relayable roles; contract-placement is a heavy role that is never relayed.
export const ROLES = Object.freeze(['gitleaks', 'trivy']);
export const HEAVY = Object.freeze(['contract-placement', 'gitleaks', 'trivy']);
const sha1 = text => createHash('sha1').update(text).digest('hex');
export const B = sha1('fixture main tip'), H = sha1('fixture head'), M0 = sha1('fixture merge'), OTHER = sha1('fixture other');
export const CLAIM = '6081c581-1fa5-4492-a4a4-dbdfe931c915', BINDING = '11111111-2222-4333-8444-555555555555';
export const MANIFEST = 'c'.repeat(64);
const REFS = { sourceAcceptanceRef: 'a1a1a1a1-0000-4000-8000-000000000001', hostQualificationRef: 'a1a1a1a1-0000-4000-8000-000000000002',
  ownerAuthorizationRef: 'a1a1a1a1-0000-4000-8000-000000000003', publisherQualificationRef: 'a1a1a1a1-0000-4000-8000-000000000004',
  ciPrincipalQualificationRef: 'a1a1a1a1-0000-4000-8000-000000000005' };
const iso = ms => new Date(ms).toISOString();
const bytesOf = content => (Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'));
const coded = code => Object.assign(new Error(code), { code });

// Directory trees over a path -> content map. Blob ids are real git blob ids;
// tree ids are deterministic fixture ids.
export function buildTrees(files, modes = {}) {
  const map = new Map(Object.entries(files).map(([file, content]) => [file, bytesOf(content)]));
  const trees = new Map(), dirs = new Map();
  const build = prefix => {
    const names = new Map();
    for (const file of map.keys()) {
      if (prefix && !file.startsWith(`${prefix}/`)) continue;
      const [first, ...more] = (prefix ? file.slice(prefix.length + 1) : file).split('/');
      names.set(first, more.length ? 'tree' : 'blob');
    }
    const entries = [...names.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, type]) => {
      const full = prefix ? `${prefix}/${name}` : name;
      if (type === 'tree') return { name, mode: '040000', type: 'tree', sha: build(full) };
      const mode = modes[full] ?? '100644';
      return { name, mode, type: mode === '160000' ? 'commit' : 'blob', sha: gitBlobSha1(map.get(full)) };
    });
    const sha = sha1(`tree:${prefix}:${JSON.stringify(entries)}`);
    trees.set(sha, entries); dirs.set(prefix, sha);
    return sha;
  };
  return { root: build(''), trees, dirs, map };
}

// build-registry reader over the same map (no git needed).
export function memoryReader(files, { commit = B, modes = {} } = {}) {
  const { root, dirs, map } = buildTrees(files, modes);
  const blobs = new Map([...map.values()].map(bytes => [gitBlobSha1(bytes), bytes]));
  return Object.freeze({
    resolve(rev) { if (rev !== commit) relayFail('RELAY_REGISTRY_COMMIT_INVALID'); return { commit, tree: root }; },
    entry(_commit, file) {
      if (map.has(file)) { const mode = modes[file] ?? '100644'; return { mode, type: mode === '160000' ? 'commit' : 'blob', sha: gitBlobSha1(map.get(file)) }; }
      if (dirs.has(file)) return { mode: '040000', type: 'tree', sha: dirs.get(file) };
      return null;
    },
    tree(_commit, dir) {
      return [...map.keys()].filter(file => file.startsWith(`${dir}/`)).sort().map(file => {
        const mode = modes[file] ?? '100644';
        return { path: file, mode, type: mode === '160000' ? 'commit' : 'blob', sha: gitBlobSha1(map.get(file)) };
      });
    },
    paths() { return [...map.keys()].sort(); },
    blob(sha) { return blobs.get(sha); },
  });
}

export const fixtureRegistry = (files = REPO_FILES, spec = SPEC) =>
  validateRegistry(buildRegistry({ spec, reader: memoryReader(files), commit: B, domain: 'fixture' }), { domain: 'fixture' });

export function createWorld({ now = Date.parse('2026-10-21T06:00:00Z') } = {}) {
  const registry = fixtureRegistry();
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ed = generateKeyPairSync('ed25519');
  const kid = 'fixture-kid-1';
  const state = {
    now, calls: {}, faults: {}, nextId: 900_000,
    mainFiles: { ...REPO_FILES }, headFiles: { ...REPO_FILES, 'src/app.js': 'export const value = 2;\n' }, headModes: {},
    changedPaths: ['src/app.js'], mainTip: B,
    pr: { number: PR, state: 'open', draft: false, changed_files: 1,
      head: { sha: H, ref: HEAD_REF, repo: { full_name: REPO, id: REPO_ID } },
      base: { sha: B, ref: 'main', repo: { full_name: REPO, id: REPO_ID } } },
    compares: new Map(), commits: new Map(), trees: new Map(), checkRuns: [], annotations: new Map(),
    jwks: { keys: [{ ...rsa.publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' }] },
  };
  const count = name => { state.calls[name] = (state.calls[name] ?? 0) + 1; };
  const fault = name => { const value = state.faults[name]; if (typeof value === 'function') return value(state); return value; };

  // Commits B (main), H (head on B) and M0 (merge of H into B, tree of H).
  function rebuild() {
    state.trees = new Map(); state.commits = new Map();
    const main = buildTrees(state.mainFiles), head = buildTrees(state.headFiles, state.headModes);
    for (const built of [main, head]) for (const [sha, entries] of built.trees) state.trees.set(sha, entries);
    state.commits.set(B, { tree: main.root, parents: [sha1('fixture grandparent')] });
    state.commits.set(H, { tree: head.root, parents: [B] });
    state.commits.set(M0, { tree: head.root, parents: [B, H] });
    state.compares.set(`${B}...${H}`, { status: 'ahead', ahead_by: 1, behind_by: 0 });
    state.compares.set(`${B}...${B}`, { status: 'identical', ahead_by: 0, behind_by: 0 });
  }
  rebuild();

  function signToken(claims, { key = rsa.privateKey, header = { alg: 'RS256', kid, typ: 'JWT' } } = {}) {
    const input = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
    return `${input}.${createSign('RSA-SHA256').update(input).sign(key).toString('base64url')}`;
  }
  // The identity annotation text the hosted job prints: the token as lowercase hex (oidc.mjs tokenFromAnnotation).
  const hexToken = token => Buffer.from(token, 'latin1').toString('hex');
  function claimsFor(role, run, overrides = {}) {
    const workflowRef = `${REPO}/${registry.roles[role]?.workflowPath ?? `.github/workflows/${role}.yml`}@refs/pull/${PR}/merge`;
    const iat = Math.floor(Date.parse(run.completed_at) / 1000) - 20;
    const fill = value => (typeof value === 'string' ? value.replaceAll('@PR@', String(PR)).replaceAll('@HEAD_REF@', HEAD_REF)
      .replaceAll('@MERGE_SHA@', M0).replaceAll('@WORKFLOW_REF@', workflowRef).replaceAll('@RUN_ID@', String(run.runId))
      .replaceAll('@WORKFLOW@', role) : value);
    const claims = Object.fromEntries(Object.entries(CLAIMS_TEMPLATE).filter(([name]) => !name.startsWith('_')).map(([name, value]) => [name, fill(value)]));
    return { ...claims, iat, nbf: iat - 5, exp: iat + 300, jti: sha1(`jti:${role}:${run.id}`), ...overrides };
  }
  // One successful hosted run of a role's registered job with its identity annotation. `token` is the
  // annotation's raw text; by default the hex of a freshly signed token.
  function addHostedRun(role, { status = 'completed', conclusion = 'success', claims = {}, token = null, annotations = null, runId = null,
    startedAt = iso(state.now - 15 * 60_000), completedAt = iso(state.now - 10 * 60_000), name = null, appId = 15368, headSha = H } = {}) {
    const id = state.nextId++, rid = runId ?? 39_000_000_000 + id;
    const run = { id, runId: rid, name: name ?? registry.roles[role]?.hostedCheckName ?? `${role}-hosted-executor`, head_sha: headSha, status,
      conclusion: status === 'completed' ? conclusion : null, started_at: startedAt, completed_at: status === 'completed' ? completedAt : null,
      details_url: `https://github.com/${REPO}/actions/runs/${rid}/job/${id}`, external_id: `fixture-${id}`,
      app: { id: appId }, output: { annotations_count: 0 } };
    let list = annotations;
    if (list === null) list = status === 'completed' && conclusion === 'success'
      ? [{ annotation_level: 'notice', title: 'clued-hosted-relay-v1', message: token ?? hexToken(signToken(claimsFor(role, run, claims))), path: '.github' }] : [];
    run.output.annotations_count = list.length;
    state.checkRuns.push(run); state.annotations.set(id, list);
    return run;
  }
  const allHosted = (options = {}) => Object.fromEntries(ROLES.map(role => [role, addHostedRun(role, options[role] ?? {})]));

  const github = Object.freeze({
    fixture: true,
    async readPullRequest(number) { count('readPullRequest'); if (fault('readPullRequest')) throw coded(fault('readPullRequest')); if (number !== PR) throw coded('github_http_404'); return structuredClone(state.pr); },
    async readBranchHead(name) { count('readBranchHead'); if (name !== 'main') throw coded('github_http_404'); return { name, sha: state.mainTip }; },
    async readCompare(base, head) {
      count('readCompare');
      const reply = state.compares.get(`${base}...${head}`);
      if (!reply) throw coded('github_http_404');
      return { baseSha: base, headSha: head, status: reply.status, aheadBy: reply.ahead_by, behindBy: reply.behind_by, mergeBaseSha: base };
    },
    async readChangedPaths(job) {
      count('readChangedPaths');
      const p = state.pr;
      if (job.repo !== REPO || p.number !== job.pr || p.state !== 'open' || p.head.sha !== job.headSha || p.base.sha !== job.baseSha) throw coded('pr_subject_changed');
      if (fault('readChangedPaths')) throw coded(fault('readChangedPaths'));
      return { complete: true, pr: job.pr, headSha: job.headSha, baseSha: job.baseSha, paths: [...state.changedPaths].sort() };
    },
    async readGitCommit(sha) {
      count('readGitCommit');
      const commit = state.commits.get(sha);
      if (!commit) throw coded('github_http_404');
      return { sha, tree: commit.tree, parents: [...commit.parents] };
    },
    async readGitTree(sha) {
      count('readGitTree');
      const entries = state.trees.get(sha);
      if (!entries) throw coded('github_http_404');
      return { sha, entries: structuredClone(entries) };
    },
    async readCheckRunsByName(headSha, name) {
      count('readCheckRunsByName');
      if (fault('readCheckRunsByName')) throw coded(fault('readCheckRunsByName'));
      return { complete: true, checks: structuredClone(state.checkRuns.filter(run => run.head_sha === headSha && run.name === name)) };
    },
    async readChecks(headSha) {
      count('readChecks');
      return { complete: true, checks: structuredClone(state.checkRuns.filter(run => run.head_sha === headSha)) };
    },
    async readCheckRunAnnotations(id, expected) {
      count('readCheckRunAnnotations');
      const list = state.annotations.get(id) ?? [];
      if (list.length !== expected) throw coded('incomplete_annotations');
      return { complete: true, checkRunId: id, annotations: list.map(item => ({ level: item.annotation_level, title: item.title ?? '', message: item.message, path: item.path })) };
    },
    async createCheck(body) {
      count('createCheck');
      if (!body || !/^[a-f0-9]{40}$/.test(body.head_sha) || body.status !== 'completed' || !['success', 'failure'].includes(body.conclusion)
        || typeof body.name !== 'string' || !body.external_id?.startsWith('independent-ci:')) throw coded('invalid_check_publication');
      const mode = fault('createCheck');
      if (mode === 'refused') throw coded('github_http_422');
      if (mode === 'lost-no-write') throw coded('github_transport_unconfirmed');
      const run = { ...structuredClone(body), id: state.nextId++, app: { id: 5368905 } };
      state.checkRuns.push(run);
      if (mode === 'lost-after-write') throw coded('github_transport_unconfirmed');
      const returned = structuredClone(run);
      if (mode === 'tamper') run.conclusion = 'failure';
      return returned;
    },
    async revokeCheck(id, body) {
      count('revokeCheck');
      const run = state.checkRuns.find(item => item.id === id);
      if (!run) throw coded('github_http_404');
      Object.assign(run, structuredClone(body));
      return structuredClone(run);
    },
  });

  const nativeAdmission = Object.freeze({
    fixture: true,
    async evaluatePr(job, packet) {
      count('evaluatePr');
      if (fault('native')) return { contract: 'clued.independent-ci.full-admission/1', status: 'BLOCKED', admitted: false, reason: 'full_admission_rejected' };
      const facts = { contract: 'clued.independent-ci.full-admission/1', status: 'ADMITTED', admitted: true, completeAdmission: true,
        evaluator: 'scripts/ci/clued-work-admission.mjs#evaluate', domain: 'fixture', repository: REPO, scope: 'project:0597aa60-9b98-4da6-a4ab-63d7705b632f',
        prRef: `${REPO}#${job.pr}`, headSha: job.headSha, baseSha: job.baseSha, claimId: job.claimId, fence: job.fence, epoch: job.epoch,
        sourceManifestSha256: job.sourceManifestSha256, executionPolicy: 'staged', guarded: false, executionHandoverPending: false, mergeQueueHead: true,
        mode: { state: 'normal', layer: 'fixture', policyVersion: 1 }, mergeSlot: { state: 'held' }, ownerReview: null, workflowGateFindings: [],
        observedAt: iso(state.now), claimExpiresAt: iso(state.now + 3_600_000), modeProofRef: 'fixture-mode-proof', observationRef: 'fixture-observation',
        packetSha256: digest(packet), evaluationSha256: digest({ fixture: 'evaluation', headSha: job.headSha }) };
      return { ...facts, observationSha256: digest(facts) };
    },
  });
  const authority = Object.freeze({
    fixture: true,
    async observe(job) {
      count('authority');
      return { ...subjectOf(job), ...REFS, ciPrincipalBindingId: BINDING, sourceAccepted: true, hostQualified: true, publisherQualified: true,
        ciPrincipalQualified: true, observedAt: iso(state.now), claimExpiresAt: iso(state.now + 3_600_000) };
    },
  });
  const signers = new Map([['fixture-linux-key', { domain: 'fixture', publicKeyPem: ed.publicKey.export({ format: 'pem', type: 'spki' }),
    runtimeId: 'fixture-runtime', qualificationRef: REFS.hostQualificationRef, sourceAcceptanceRef: REFS.sourceAcceptanceRef }]]);
  const subject = () => ({ repo: REPO, pr: PR, headSha: H, baseSha: B, claimId: CLAIM, fence: 3, epoch: 1, sourceManifestSha256: MANIFEST });
  function localJob(role, attempt = 1) {
    const job = { contract: JOB_CONTRACT, id: '', ...subject(), role, createdAt: iso(state.now - 20 * 60_000), attempt };
    job.id = jobId(job);
    return job;
  }
  function signedResult(job, conclusion = 'success') {
    const payload = { contract: 'independent-ci.execution-result.v1', domain: 'fixture', runtimeId: 'fixture-runtime', subject: subjectOf(job),
      startedAt: iso(state.now - 5 * 60_000), finishedAt: iso(state.now - 60_000), conclusion, exitCode: conclusion === 'success' ? 0 : 1,
      stdoutSha256: 'd'.repeat(64), stderrSha256: 'e'.repeat(64), artifactsSha256: 'f'.repeat(64) };
    return { contract: 'independent-ci.signed-result.v1', keyId: 'fixture-linux-key', payload,
      signature: edSign(null, Buffer.from(canonical(payload)), ed.privateKey).toString('base64url') };
  }
  const jwksPort = Object.freeze({ async fetchJwks() { count('fetchJwks'); return structuredClone(state.jwks); } });
  const oidc = (options = {}) => createGitHubOidcVerifier({ audience: 'clued-hosted-relay-v1', jwksPort, clock: () => state.now, fixture: true, ...options });
  const observer = () => createHostedRelayObserver({ github, registry, clock: () => state.now });
  const verifier = () => createHostedRelayVerifier({ registry, observer: observer(), oidc: oidc() });
  const configuredChecks = { gitleaks: { name: 'gitleaks', appId: 5368905 }, trivy: { name: 'trivy', appId: 5368905 },
    'contract-placement': { name: 'contract-placement', appId: 5368905 } };
  function publisher(journal, hostedVerifier = verifier()) {
    return createStagedCheckPublisher({ nativeAdmission, authority, github, journal, signers, configuredChecks,
      readChangedPaths: job => github.readChangedPaths(job), clock: () => state.now, domain: 'fixture', hostedVerifier, localRoleMutex: true,
      protectedDeployment: { enabled: true, domain: 'fixture', repository: REPO, ciPrincipalBindingId: BINDING, ...REFS } });
  }
  function stage(journal, { localInputPins = { trivy: { checksDigest: registry.roles.trivy?.checksDigest } } } = {}) {
    const v = verifier();
    return { stage: createHostedRelayStage({ registry, verifier: v, publisher: publisher(journal, v), localInputPins }), verifier: v };
  }
  return { registry, state, rebuild, github, nativeAdmission, authority, signers, signToken, hexToken, claimsFor, addHostedRun, allHosted,
    oidc, observer, verifier, publisher, stage, subject, localJob, signedResult, rsa, kid, jwksPort };
}

export const published = state => state.checkRuns.filter(run => run.app.id === 5368905);
