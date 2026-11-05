// Read-only observation controller. Advisory signals schedule one protected
// engine read; they never authorize a scan, publication, relay enable or release.
import fs from 'node:fs/promises';
import path from 'node:path';
import { check, digest, HEX40, HEX64, sha256 } from './canonical.mjs';
import { ensureDir, exists, readJson, writeNewAtomic } from './store.mjs';
import { qualificationWindowSnapshot } from './relay-qualification-hold.mjs';

const CODE = 'RELAY_QUALIFICATION_OBSERVATION_UNCERTAIN';
const CONTRACT = 'clued.independent-ci.relay-qualification-observation-book/1';
const PHASES = ['initial', 'after-ref-move'], RETRY_MS = 300_000, MAX_ATTEMPTS = 12;
const STATIC = ['repo', 'runId', 'pr', 'headSha', 'baseSha', 'testSha', 'sourceManifestSha256', 'nodeProfileSha256',
  'claimId', 'fence', 'executionEpoch', 'stage1JobId'];
const ROLE_FIELDS = ['role', 'verdict', 'checkRunId', 'workflowRunId', 'runAttempt', 'annotationsComplete',
  'identityAnnotationCount', 'totalAnnotationCount', 'fullAnnotationsSha256', 'tokenPresent', 'tokenSha256',
  'signatureVerified', 'verifiedClaims', 'claimsSha256', 'checkRunIdClaimPresent', 'registryBindsCheckRunId', 'keyThumbprintSha256', 'attestationSha256'];
const CLAIMS = ['iss', 'aud', 'repository', 'repository_id', 'repository_owner', 'repository_owner_id', 'event_name', 'sub',
  'ref', 'base_ref', 'head_ref', 'job_workflow_ref', 'workflow_ref', 'runner_environment', 'run_id', 'run_attempt', 'sha',
  'workflow_sha', 'job_workflow_sha', 'iat', 'check_run_id'];
function fields(value, names) {
  check(value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype, CODE);
  const d = Object.getOwnPropertyDescriptors(value);
  check(Reflect.ownKeys(d).length === names.length && names.every(k => Object.hasOwn(d, k)
    && Object.hasOwn(d[k], 'value') && d[k].enumerable), CODE);
  return Object.fromEntries(names.map(k => [k, d[k].value]));
}
const positive = n => Number.isSafeInteger(n) && n > 0;
const iso = v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)
  && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const hashArray = v => sha256(Buffer.from(JSON.stringify(v)));
function locator(value) {
  const l = fields(value, ['nonce', 'outcomeSha256', 'nativeReceiptSha256', 'jobId']);
  check(typeof l.nonce === 'string' && /^[a-f0-9]{32}$/.test(l.nonce)
    && ['outcomeSha256', 'nativeReceiptSha256', 'jobId'].every(k => typeof l[k] === 'string' && HEX64.test(l[k])), CODE);
  return l;
}
function expected(q, stage1, phase, prior) {
  const values = [...STATIC.map(k => q.subject[k]), stage1.nonce, stage1.outcomeSha256];
  return { id: hashArray(['clued.independent-ci.relay-qualification-run/1', ...values, phase,
    prior?.observationLocator.nonce ?? null, prior?.observationLocator.outcomeSha256 ?? null]), subjectSha256: hashArray(values) };
}
// Persistence is a second closed public filter, not cryptographic attestation.
// The production engine/Source still performs the complete typed validation.
function publicSuccess(value, q, stage1, phase, prior) {
  const r = fields(value, ['ok', 'code', 'proof', 'state', 'nativeReceiptSha256', 'observation', 'observationLocator', 'liveQualified']);
  const proof = fields(r.proof, ['windowsTreeZero', 'serviceOriginalStopped']), l = locator(r.observationLocator);
  const e = expected(q, stage1, phase, prior);
  check(r.ok === true && r.code === null && r.liveQualified === false && proof.windowsTreeZero === true
    && proof.serviceOriginalStopped === true && r.state === 'FORMAL_CHILD_COMPLETED_ORIGINAL_STOPPED_NO_QUALIFICATION'
    && l.jobId === e.id && r.nativeReceiptSha256 === l.nativeReceiptSha256, CODE);
  const o = fields(r.observation, ['contract', 'jobId', 'phase', 'subjectSha256', 'observedAt', 'liveQualified', 'roles', 'refObservation', 'jwksObservation']);
  check(o.contract === 'clued.independent-ci.relay-qualification-observation/1' && o.jobId === e.id && o.phase === phase
    && o.subjectSha256 === e.subjectSha256 && o.liveQualified === false && iso(o.observedAt), CODE);
  const ref = fields(o.refObservation, ['ref', 'beforeMergeSha', 'afterMergeSha', 'oldMergeReadable']);
  const jwks = fields(o.jwksObservation, ['networkFetched', 'sha256']);
  check(ref.ref === `refs/pull/${q.subject.pr}/merge` && [ref.beforeMergeSha, ref.afterMergeSha].every(v => typeof v === 'string' && HEX40.test(v))
    && ref.oldMergeReadable === true && (phase === 'initial' ? ref.beforeMergeSha === ref.afterMergeSha
      : ref.beforeMergeSha === prior.observation.refObservation.beforeMergeSha && ref.afterMergeSha !== ref.beforeMergeSha)
    && jwks.networkFetched === true && typeof jwks.sha256 === 'string' && HEX64.test(jwks.sha256), CODE);
  check(Array.isArray(o.roles) && Object.getPrototypeOf(o.roles) === Array.prototype, CODE);
  const rd = Object.getOwnPropertyDescriptors(o.roles);
  check(rd.length.value === 2 && Reflect.ownKeys(rd).length === 3 && [0, 1].every(i => rd[i] && Object.hasOwn(rd[i], 'value')), CODE);
  const roles = [0, 1].map(i => {
    const role = fields(rd[i].value, ROLE_FIELDS);
    check(role.role === ['gitleaks', 'trivy'][i] && role.verdict === 'ATTESTED_SUCCESS' && positive(role.checkRunId)
      && typeof role.workflowRunId === 'string' && /^[1-9][0-9]{0,19}$/.test(role.workflowRunId)
      && typeof role.runAttempt === 'string' && /^[1-9][0-9]{0,3}$/.test(role.runAttempt)
      && role.annotationsComplete === true && role.identityAnnotationCount === 1 && positive(role.totalAnnotationCount) && role.totalAnnotationCount <= 10000
      && role.tokenPresent === true && role.signatureVerified === true
      && ['checkRunIdClaimPresent', 'registryBindsCheckRunId'].every(k => typeof role[k] === 'boolean')
      && ['fullAnnotationsSha256', 'tokenSha256', 'claimsSha256', 'keyThumbprintSha256', 'attestationSha256']
        .every(k => typeof role[k] === 'string' && HEX64.test(role[k])), CODE);
    const claimsD = Object.getOwnPropertyDescriptors(role.verifiedClaims), keys = Reflect.ownKeys(claimsD);
    check(Object.getPrototypeOf(role.verifiedClaims) === Object.prototype && keys.length > 0 && keys.length <= CLAIMS.length
      && keys.every(k => typeof k === 'string' && CLAIMS.includes(k) && Object.hasOwn(claimsD[k], 'value') && claimsD[k].enumerable), CODE);
    const claims = Object.fromEntries(keys.map(k => {
      const v = claimsD[k].value;
      check(k === 'iat' || k === 'check_run_id' && typeof v === 'number' ? positive(v)
        : typeof v === 'string' && v.length > 0 && v.length <= 512 && !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v), CODE);
      return [k, v];
    }));
    check(digest(claims) === role.claimsSha256 && claims.repository === q.subject.repo && claims.sha === ref.beforeMergeSha
      && claims.run_id === role.workflowRunId && claims.run_attempt === role.runAttempt
      && role.checkRunIdClaimPresent === Object.hasOwn(claims, 'check_run_id'), CODE);
    return { ...role, verifiedClaims: claims };
  });
  const out = { ...r, proof, observationLocator: l, observation: { ...o, roles, refObservation: ref, jwksObservation: jwks } };
  check(Buffer.byteLength(JSON.stringify(out)) <= 20000, CODE);
  return out;
}
function preflightDeferred(value) {
  try {
    const r = fields(value, ['ok', 'code', 'deferred', 'proof', 'liveQualified', 'observation', 'observationLocator']);
    const p = fields(r.proof, ['windowsTreeZero', 'serviceOriginalStopped']);
    return r.ok === false && r.deferred === true && ['RELAY_QUALIFICATION_BUSY', 'RELAY_QUALIFICATION_WINDOW_UNCONFIRMED'].includes(r.code)
      && r.liveQualified === false && r.observation === null && r.observationLocator === null
      && p.windowsTreeZero === false && p.serviceOriginalStopped === false ? r.code : null;
  } catch { return null; }
}
function hostedReady(value) {
  try {
    const h = fields(value, ['observedAt', 'roles']), roles = fields(h.roles, ['gitleaks', 'trivy']);
    return positive(h.observedAt) && ['gitleaks', 'trivy'].every(k => fields(roles[k], ['state']).state === 'SUCCESS');
  } catch { return false; }
}
const held = code => ({ state: 'HELD', code, liveQualified: false });
const collected = (phase, result) => ({ state: 'OBSERVATIONS_COLLECTED_NO_QUALIFICATION', phase, result, liveQualified: false });

export class RelayQualificationObservations {
  constructor({ holds, engine, clock = Date.now }) { this.holds = holds; this.engine = engine; this.clock = clock; }
  async phaseState(root, phase, context) {
    const dir = path.join(root, phase);
    if (!(await exists(dir))) return { attempts: 0, result: null };
    const st = await fs.lstat(dir); check(st.isDirectory() && !st.isSymbolicLink(), CODE);
    const names = (await fs.readdir(dir)).sort();
    check(names.length <= MAX_ATTEMPTS && names.every((v, i) => v === `attempt-${String(i + 1).padStart(2, '0')}`), CODE);
    let last = null;
    for (const [i, name] of names.entries()) {
      const attemptDir = path.join(dir, name), st = await fs.lstat(attemptDir);
      check(st.isDirectory() && !st.isSymbolicLink(), CODE);
      check((await fs.readdir(attemptDir)).every(n => ['00-intent.json', '10-result.json'].includes(n)), CODE);
      const intent = fields((await readJson(path.join(attemptDir, '00-intent.json'), 4096)).value,
        ['contract', 'phase', 'attempt', 'contextSha256', 'at']);
      const terminal = fields((await readJson(path.join(attemptDir, '10-result.json'), 24576)).value,
        ['contract', 'phase', 'attempt', 'contextSha256', 'at', 'status', 'code', 'result']);
      check(intent.contract === CONTRACT && terminal.contract === CONTRACT && intent.phase === phase && terminal.phase === phase
        && intent.attempt === i + 1 && terminal.attempt === i + 1 && intent.contextSha256 === context.sha256
        && terminal.contextSha256 === context.sha256 && positive(intent.at) && positive(terminal.at) && terminal.at >= intent.at, CODE);
      if (last) check(last.status === 'PREFLIGHT_DEFERRED' && intent.at >= last.at + RETRY_MS, CODE);
      if (terminal.status === 'OBSERVED') {
        check(terminal.code === null, CODE);
        terminal.result = publicSuccess(terminal.result, context.q, context.stage1, phase, context.prior);
      } else if (terminal.status === 'PREFLIGHT_DEFERRED') {
        check(['RELAY_QUALIFICATION_BUSY', 'RELAY_QUALIFICATION_WINDOW_UNCONFIRMED'].includes(terminal.code) && terminal.result === null, CODE);
      } else check(terminal.status === 'UNCERTAIN_HOLD' && terminal.code === CODE && terminal.result === null, CODE);
      last = terminal;
    }
    return { attempts: names.length, result: last };
  }
  async runPhase(root, phase, q, stage1, prior) {
    const context = { q, stage1, prior, sha256: digest({ windowSha256: digest(q), stage1,
      priorSha256: prior ? digest(prior) : null, phase }) };
    const old = await this.phaseState(root, phase, context);
    if (old.result?.status === 'OBSERVED') return collected(phase, old.result.result);
    if (old.result?.status === 'UNCERTAIN_HOLD') return held(CODE);
    if (old.attempts >= MAX_ATTEMPTS) return held('RELAY_QUALIFICATION_PREFLIGHT_RETRIES_EXHAUSTED');
    if (old.result && this.clock() < old.result.at + RETRY_MS) return held('RELAY_QUALIFICATION_PREFLIGHT_BACKOFF');
    const phaseDir = path.join(root, phase); await ensureDir(phaseDir);
    const attempt = old.attempts + 1, attemptDir = path.join(phaseDir, `attempt-${String(attempt).padStart(2, '0')}`);
    try { await fs.mkdir(attemptDir, { mode: 0o700 }); } catch { return held(CODE); }
    // Exclusive mkdir elects one writer across processes. Atomic record writes
    // are single-writer inside it; a torn/missing terminal never reopens a call.
    await writeNewAtomic(path.join(attemptDir, '00-intent.json'), { contract: CONTRACT, phase, attempt,
      contextSha256: context.sha256, at: this.clock() });
    let status = 'UNCERTAIN_HOLD', code = CODE, result = null;
    try {
      const raw = await this.engine.runRelayQualification({ stage1Locator: stage1, phase, priorObservation: prior });
      const deferred = preflightDeferred(raw);
      if (deferred) { status = 'PREFLIGHT_DEFERRED'; code = deferred; }
      else { result = publicSuccess(raw, q, stage1, phase, prior); status = 'OBSERVED'; code = null; }
    } catch { /* no exception detail or unverified engine field is persisted */ }
    await writeNewAtomic(path.join(attemptDir, '10-result.json'), { contract: CONTRACT, phase, attempt,
      contextSha256: context.sha256, at: this.clock(), status, code, result });
    return status === 'OBSERVED' ? collected(phase, result) : held(status === 'PREFLIGHT_DEFERRED' ? code : CODE);
  }
  async tick({ subject, hint = null, livePull = null }) {
    try {
      const guard = await this.holds.inspect(subject);
      if (!guard.held || guard.unconfirmed || !guard.record) return held('RELAY_QUALIFICATION_GUARD_UNCONFIRMED');
      const q = qualificationWindowSnapshot(guard.record.window), stage1 = await this.holds.readStage1Locator(subject);
      if (!stage1) return held('RELAY_QUALIFICATION_STAGE1_NOT_READY');
      const root = path.join(this.holds.directory(subject), 'observations'); await ensureDir(root);
      const initialContext = { q, stage1, prior: null, sha256: digest({ windowSha256: digest(q), stage1, priorSha256: null, phase: 'initial' }) };
      const initial = await this.phaseState(root, 'initial', initialContext);
      if (initial.result?.status !== 'OBSERVED') {
        if (initial.result?.status === 'UNCERTAIN_HOLD') return held(CODE);
        if (!hostedReady(hint)) return held('RELAY_QUALIFICATION_WAITING_FOR_HOSTED');
        return await this.runPhase(root, 'initial', q, stage1, null);
      }
      const prior = initial.result.result;
      const secondContext = { q, stage1, prior, sha256: digest({ windowSha256: digest(q), stage1,
        priorSha256: digest(prior), phase: 'after-ref-move' }) };
      const second = await this.phaseState(root, 'after-ref-move', secondContext);
      if (second.result?.status === 'OBSERVED') return collected('after-ref-move', second.result.result);
      if (second.result?.status === 'UNCERTAIN_HOLD') return held(CODE);
      // A missing merge SHA is a wait. Never infer movement from head/base/time.
      const p = livePull && fields(livePull, Object.keys(livePull));
      if (!p || p.state !== 'open' || typeof p.mergeSha !== 'string' || !HEX40.test(p.mergeSha)
        || p.mergeSha === prior.observation.refObservation.beforeMergeSha) return held('RELAY_QUALIFICATION_WAITING_FOR_REF_MOVE');
      return await this.runPhase(root, 'after-ref-move', q, stage1, prior);
    } catch { return held(CODE); }
  }
}
