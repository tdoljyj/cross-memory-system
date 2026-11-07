// in-toto Statement v1 + SLSA Provenance v1 for one independent-CI check result (L4 of optimisation plan bf57ff10).
//   Statement: https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md
//   Predicate: https://slsa.dev/spec/v1.0/provenance
// This is an ADDITIONAL, derived document. The signed-result envelope (proof-v2.mjs), the receipts, the journal and every
// verifier stay exactly as they are; nothing reads this file to decide anything in the pipeline.
//   subject            the tested commit S (gitCommit) and, when the observation names it, its tree (gitTree)
//   builder.id         urn:clued:independent-ci:node:<runtimeIdentity>:source:<sourceManifestSha256>
//   buildDefinition    what was asked (job identity, head/base/test commits) and what the Source pinned (manifest, image, profile)
//   runDetails         when it ran, and byproducts bound by hash to the signed result, the observation, the logs and the cleanup
import { canonical, digest } from '../proof.mjs';
import { validateJobV2 } from '../job-v2.mjs';

export const STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
export const PREDICATE_TYPE = 'https://slsa.dev/provenance/v1';
export const BUILD_TYPE = 'https://github.com/tdoljyj/cross-memory-system/tree/main/work/actions-hosted-migration/independent-ci-v1/docs/provenance/scanner-check/v1';
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const RFC3339 = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/;
const IMAGE = /^(?:sha256:[a-f0-9]{64}|[^\s,@]+@sha256:[a-f0-9]{64})$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const plain = v => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;

export const repoUri = repo => `git+https://github.com/${repo}`;
export const builderId = (runtimeIdentity, sourceManifestSha256) => {
  if (typeof runtimeIdentity !== 'string' || runtimeIdentity.length === 0 || runtimeIdentity.length > 200 || /[\x00-\x1f]/.test(runtimeIdentity) || !SHA256.test(sourceManifestSha256 ?? '')) fail('provenance_builder_invalid');
  return `urn:clued:independent-ci:node:${encodeURIComponent(runtimeIdentity)}:source:${sourceManifestSha256}`;
};

// job: a v2 job (job contract /3). envelope: the signed-result envelope of that job (ENVELOPE_CONTRACT_V2) as the Linux
// signer emitted it. observation: the unsigned execution observation the result was built from (optional extras only).
export function buildStatement({ job, envelope, observation = null }) {
  validateJobV2(job);
  const p = envelope?.payload;
  if (!plain(p) || typeof envelope.keyId !== 'string' || typeof p.runtimeId !== 'string' || p.subject?.id !== job.id
    || !RFC3339.test(p.startedAt ?? '') || !RFC3339.test(p.finishedAt ?? '') || !['success', 'failure'].includes(p.conclusion) || !Number.isInteger(p.exitCode)
    || !['stdoutSha256', 'stderrSha256', 'artifactsSha256'].every(k => SHA256.test(p[k] ?? ''))) fail('provenance_result_invalid');
  const o = plain(observation) ? observation : {};
  const subject = [{ name: repoUri(job.repo), digest: { gitCommit: job.testSha } }];
  if (SHA1.test(o.candidateTreeSha ?? '')) subject.push({ name: `${repoUri(job.repo)}#tree`, digest: { gitTree: o.candidateTreeSha } });
  const evidenceSha256 = digest(envelope);   // the same value verifyResultV2 returns as evidenceSha256 and the publisher journals
  const resolvedDependencies = [
    { name: 'base', uri: repoUri(job.repo), digest: { gitCommit: job.baseSha } },
    { name: 'source-manifest', digest: { sha256: job.sourceManifestSha256 } },
  ];
  if (typeof o.image === 'string' && IMAGE.test(o.image)) {
    const m = /sha256:([a-f0-9]{64})$/.exec(o.image);
    resolvedDependencies.push({ name: 'scanner-image', ...(o.image.includes('@') ? { uri: o.image.split('@')[0] } : {}), digest: { sha256: m[1] } });
  }
  for (const [name, key] of [['workflow', 'workflowSha256'], ['tool-pins', 'toolPinsSha256']]) if (SHA256.test(o[key] ?? '')) resolvedDependencies.push({ name, digest: { sha256: o[key] } });
  const byproduct = (name, sha, extra = {}) => ({ name, digest: { sha256: sha }, ...extra });
  const result = canonical({ conclusion: p.conclusion, exitCode: p.exitCode });
  const byproducts = [
    byproduct('signed-result', evidenceSha256, { mediaType: 'application/json' }),
    byproduct('check-result', digest(result), { mediaType: 'application/json', content: Buffer.from(result).toString('base64') }),
    byproduct('stdout', p.stdoutSha256), byproduct('stderr', p.stderrSha256), byproduct('artifacts', p.artifactsSha256),
  ];
  for (const [name, key] of [['request', 'requestDigest'], ['execution-observation', 'executionObservationSha256'], ['cleanup', 'cleanupSha256']]) if (SHA256.test(p[key] ?? '')) byproducts.push(byproduct(name, p[key]));
  return {
    _type: STATEMENT_TYPE,
    subject,
    predicateType: PREDICATE_TYPE,
    predicate: {
      buildDefinition: {
        buildType: BUILD_TYPE,
        externalParameters: { jobId: job.id, jobContract: job.contract, repo: job.repo, pr: job.pr, role: job.role, attempt: job.attempt,
          headSha: job.headSha, baseSha: job.baseSha, testSha: job.testSha, createdAt: job.createdAt },
        internalParameters: { resultContract: p.contract, signerKeyId: envelope.keyId, ...(typeof p.profile === 'string' ? { profile: p.profile } : {}),
          ...(typeof p.logDigestMode === 'string' ? { logDigestMode: p.logDigestMode } : {}) },
        resolvedDependencies,
      },
      runDetails: {
        builder: { id: builderId(p.runtimeId, job.sourceManifestSha256) },
        metadata: { invocationId: job.id, startedOn: p.startedAt, finishedOn: p.finishedAt },
        byproducts,
      },
    },
  };
}

export const statementBytes = statement => Buffer.from(canonical(statement), 'utf8');

const isDigestSet = d => plain(d) && Object.keys(d).length > 0 && Object.entries(d).every(([k, v]) => /^[a-zA-Z0-9_-]+$/.test(k) && typeof v === 'string' && /^[a-f0-9]+$/.test(v));
const isDescriptor = d => plain(d) && (typeof d.uri === 'string' || isDigestSet(d.digest) || typeof d.content === 'string')
  && (d.digest === undefined || isDigestSet(d.digest)) && (d.name === undefined || typeof d.name === 'string') && (d.uri === undefined || typeof d.uri === 'string')
  && (d.content === undefined || typeof d.content === 'string') && (d.mediaType === undefined || typeof d.mediaType === 'string');

// Field-level check against the two specifications (required fields, types, no unknown top-level members). Throws
// provenance_statement_invalid:<where>. Pure.
export function validateStatementV1(st) {
  const bad = where => fail(`provenance_statement_invalid:${where}`);
  if (!plain(st) || Object.keys(st).sort().join('|') !== ['_type', 'predicate', 'predicateType', 'subject'].join('|')) bad('top');
  if (st._type !== STATEMENT_TYPE) bad('_type');
  if (st.predicateType !== PREDICATE_TYPE) bad('predicateType');
  if (!Array.isArray(st.subject) || st.subject.length === 0 || !st.subject.every(s => plain(s) && isDigestSet(s.digest) && (s.name === undefined || typeof s.name === 'string'))) bad('subject');
  if (!st.subject.some(s => SHA1.test(s.digest.gitCommit ?? ''))) bad('subject.gitCommit');
  const pr = st.predicate;
  if (!plain(pr) || Object.keys(pr).sort().join('|') !== 'buildDefinition|runDetails') bad('predicate');
  const bd = pr.buildDefinition;
  if (!plain(bd) || typeof bd.buildType !== 'string' || !/^[a-z][a-z0-9+.-]*:/.test(bd.buildType) || !plain(bd.externalParameters)) bad('buildDefinition');
  if (bd.internalParameters !== undefined && !plain(bd.internalParameters)) bad('buildDefinition.internalParameters');
  if (bd.resolvedDependencies !== undefined && !(Array.isArray(bd.resolvedDependencies) && bd.resolvedDependencies.every(isDescriptor))) bad('buildDefinition.resolvedDependencies');
  const rd = pr.runDetails;
  if (!plain(rd) || !plain(rd.builder) || typeof rd.builder.id !== 'string' || rd.builder.id.length === 0) bad('runDetails.builder');
  if (rd.builder.version !== undefined && !plain(rd.builder.version)) bad('runDetails.builder.version');
  if (rd.builder.builderDependencies !== undefined && !(Array.isArray(rd.builder.builderDependencies) && rd.builder.builderDependencies.every(isDescriptor))) bad('runDetails.builder.builderDependencies');
  if (rd.metadata !== undefined) {
    const m = rd.metadata;
    if (!plain(m) || (m.invocationId !== undefined && typeof m.invocationId !== 'string') || ['startedOn', 'finishedOn'].some(k => m[k] !== undefined && !(typeof m[k] === 'string' && RFC3339.test(m[k])))) bad('runDetails.metadata');
  }
  if (rd.byproducts !== undefined && !(Array.isArray(rd.byproducts) && rd.byproducts.every(isDescriptor))) bad('runDetails.byproducts');
  return st;
}

// What the statement must say about THIS job and (optionally) THIS signed result. Pure; throws provenance_*_mismatch.
export function checkStatementBinding(st, { job, envelope = null } = {}) {
  validateStatementV1(st);
  const bd = st.predicate.buildDefinition, ep = bd.externalParameters;
  const commit = st.subject.find(s => s.digest.gitCommit);
  if (job) {
    validateJobV2(job);
    if (commit.digest.gitCommit !== job.testSha || commit.name !== repoUri(job.repo)) fail('provenance_subject_mismatch');
    if (['jobId:id', 'repo:repo', 'pr:pr', 'role:role', 'attempt:attempt', 'headSha:headSha', 'baseSha:baseSha', 'testSha:testSha'].some(x => { const [a, b] = x.split(':'); return ep[a] !== job[b]; })) fail('provenance_job_mismatch');
    if (!bd.resolvedDependencies?.some(d => d.name === 'source-manifest' && d.digest?.sha256 === job.sourceManifestSha256)) fail('provenance_job_mismatch');
    const id = st.predicate.runDetails.builder.id;
    if (!id.endsWith(`:source:${job.sourceManifestSha256}`) || !id.startsWith('urn:clued:independent-ci:node:')) fail('provenance_builder_mismatch');
  }
  if (envelope) {
    const signed = st.predicate.runDetails.byproducts?.find(b => b.name === 'signed-result');
    if (signed?.digest?.sha256 !== digest(envelope)) fail('provenance_result_mismatch');
    const p = envelope.payload;
    if (st.predicate.runDetails.builder.id !== builderId(p.runtimeId, job?.sourceManifestSha256 ?? p.subject?.sourceManifestSha256)) fail('provenance_builder_mismatch');
    const check = st.predicate.runDetails.byproducts.find(b => b.name === 'check-result');
    if (check?.content !== Buffer.from(canonical({ conclusion: p.conclusion, exitCode: p.exitCode })).toString('base64')) fail('provenance_result_mismatch');
  }
  return st;
}
