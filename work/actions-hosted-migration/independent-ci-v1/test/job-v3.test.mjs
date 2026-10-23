// Job contract /3 (resident quota redesign phase 2, step 3b; design v0.5 §5.7): the identity names the tested commit S
// next to the head H and the base T. Outside the train (and in every batch until step 3c wires it) S = H.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { JOB_CONTRACT_V2, JOB_FIELDS_V2, IDENTITY_V2, SUBJECT_V2, batchJobsV2, jobIdV2, makeJobV2, sameBatchV2, subjectOfV2, validateJobV2 } from '../src/job-v2.mjs';
import { fixedCommands, validateEntryJob } from '../worker/formal-contract-placement-v2/container-entry.mjs';
import fs from 'node:fs';

const H = '1'.repeat(40), T = '2'.repeat(40), S = '4'.repeat(40);
const base = { repo: 'tdoljyj/cross-memory-system', pr: 888, headSha: H, baseSha: T, sourceManifestSha256: 'd'.repeat(64), createdAt: '2026-10-23T03:00:00.000Z', attempt: 1 };

test('job /3: the contract and the identity name the tested commit, right after the base', () => {
  assert.equal(JOB_CONTRACT_V2, 'clued.independent-ci.job/3');
  assert.deepEqual(IDENTITY_V2, ['repo', 'pr', 'headSha', 'baseSha', 'testSha', 'sourceManifestSha256', 'role', 'attempt']);
  assert.ok(JOB_FIELDS_V2.includes('testSha'));
  // the subject keeps its fields: its id binds S
  assert.ok(!SUBJECT_V2.includes('testSha') && SUBJECT_V2.includes('id'));
  const job = makeJobV2({ ...base, testSha: S, role: 'trivy' });
  const expected = createHash('sha256').update(JSON.stringify(['clued.independent-ci.job/3', base.repo, 888, H, T, S, base.sourceManifestSha256, 'trivy', 1])).digest('hex');
  assert.equal(job.id, expected);
  assert.equal(jobIdV2(job), expected);
});

test('job /3: S defaults to H, and another S is another job', () => {
  const head = makeJobV2({ ...base, role: 'trivy' });
  assert.equal(head.testSha, H);
  assert.deepEqual(head, makeJobV2({ ...base, testSha: H, role: 'trivy' }));
  const merged = makeJobV2({ ...base, testSha: S, role: 'trivy' });
  assert.notEqual(merged.id, head.id);
  assert.notDeepEqual(subjectOfV2(merged), subjectOfV2(head));
  // the six jobs of a batch share S; a batch on another S is another batch
  const jobs = batchJobsV2({ ...base, testSha: S });
  assert.ok(Object.values(jobs).every(j => j.testSha === S));
  assert.ok(sameBatchV2(jobs.trivy, jobs.gitleaks));
  assert.ok(!sameBatchV2(jobs.trivy, batchJobsV2(base).gitleaks));
  assert.ok(Object.values(batchJobsV2(base)).every(j => j.testSha === H));
});

test('job /3: a /2 job, a job without S, or with a malformed S is refused', () => {
  const job = makeJobV2({ ...base, role: 'contract-placement' });
  const { testSha, ...withoutS } = job;
  for (const bad of [withoutS, { ...withoutS, contract: 'clued.independent-ci.job/2' }, { ...job, testSha: 'X'.repeat(40) }, { ...job, testSha: S }, { ...job, testSha: null }])
    assert.throws(() => validateJobV2(bad), e => e.code === 'invalid_job_v2');
  assert.throws(() => makeJobV2({ ...base, testSha: 'abc', role: 'trivy' }), e => e.code === 'invalid_job_v2');
});

test('job /3: the placement container derives the same id and refuses /2', () => {
  for (const testSha of [H, S]) {
    const job = makeJobV2({ ...base, testSha, role: 'contract-placement' });
    assert.deepEqual(validateEntryJob(structuredClone(job)), job);
    const { testSha: _s, ...old } = job;
    assert.throws(() => validateEntryJob({ ...old, contract: 'clued.independent-ci.job/2' }), e => e.code === 'EXACT_PLACEMENT_JOB_REQUIRED');
    assert.throws(() => validateEntryJob({ ...job, testSha: '5'.repeat(40) }), e => e.code === 'EXACT_PLACEMENT_JOB_REQUIRED');
  }
});

test('job /3: the placement container builds and checks the tested commit S, against the base T (3b review m3)', () => {
  const tools = Object.fromEntries(['node', 'python', 'git', 'esbuildJs', 'esbuildBinary'].map((k, i) => [k, { path: `/usr/local/clued/${k}`, sha256: String(i).repeat(64) }]));
  const job = makeJobV2({ ...base, testSha: S, role: 'contract-placement' });
  const byId = Object.fromEntries(fixedCommands(job, tools).map(c => [c.id, c.args]));
  assert.ok(byId['actual-bootstrap-build'].includes(`--define:__CLUED_BUILD_SHA__=${JSON.stringify(S)}`));
  const placement = byId['placement-and-production-floor'];
  assert.equal(placement[placement.indexOf('--base') + 1], T);
  assert.equal(placement[placement.indexOf('--head') + 1], S);
  assert.ok(!Object.values(byId).flat().includes(H), 'the head is never what the container checks');
});

test('job /3: the bundle builder accepts descriptor /3 only and refuses S != H until step 3c', () => {
  const text = fs.readFileSync(new URL('../src/resident-v2/build-bundle.ps1', import.meta.url), 'utf8');
  assert.ok(text.includes("$d.contract -cne 'clued.independent-ci.resident-batch-descriptor/3'"));
  assert.ok(!text.includes('resident-batch-descriptor/2'));
  assert.ok(text.includes("if($d.testSha -cne $d.headSha){throw 'TEST_COMMIT_NOT_HEAD'}"));
});
