import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomUUID, sign } from 'node:crypto';
import { executionSummary, observeGitleaksContainer } from '../worker/formal-gitleaks-v4/adapter.mjs';
import { observeDockerChild } from '../worker/formal-gitleaks-v3/docker-transport.mjs';
import { EventEmitter } from 'node:events';
import { IMAGE, SCAN_ARGS, prCommitRange } from '../worker/formal-gitleaks-v4/required-history/prepare.mjs';
import { summarizeGitleaksReport, validateGitleaksReport, gitleaksCheckSummary } from '../src/gitleaks-report.mjs';
import { canonical, digest } from '../src/proof.mjs';
import { batchJobsV2, claimGeneration, subjectOfV2 } from '../src/job-v2.mjs';
import { resultPayload, observationFacts } from '../worker/protected-job-bridge-v4/signed-result.mjs';
import { EffectJournal } from '../src/effect-journal.mjs';
import { createStagedCheckPublisherV2 } from '../src/staged-check-publisher-v2.mjs';
import { validateRecordV2 } from '../src/resident-v2/record.mjs';
import { HEAD, BASE, tempDir, fixtureRecord, admittedFacts } from './resident-v2-fixtures.mjs';

const iso = ms => new Date(ms).toISOString(), hash = 'a'.repeat(64), other = 'c'.repeat(40);
const secret = ['never', 'publish', 'this', 'credential'].join('-');
const finding = commit => ({ RuleID: 'generic-api-key', File: 'src/settings.js', StartLine: 17, EndLine: 17, Commit: commit,
  Match: secret, Secret: secret, Message: secret, Author: secret });
function execution(findings, commits = [HEAD], editActual = () => {}) {
  const now = Date.now(), job = batchJobsV2({ repo: 'tdoljyj/cross-memory-system', pr: 888, headSha: HEAD, baseSha: BASE,
    testSha: HEAD, sourceManifestSha256: 'd'.repeat(64), createdAt: iso(now - 60000), attempt: 1 }).gitleaks;
  const prepared = { sourceSha: other, packedHistorySha256: hash, remoteSnapshotSha256: hash, headSha: HEAD, baseSha: BASE, prCommits: commits };
  const plan = { profile: 'required-gitleaks-history/1', image: IMAGE, executable: '/usr/bin/gitleaks', cwd: '/repo', args: [...SCAN_ARGS],
    mounts: [['/repo', '/repo'], ['/ignore', '/reviewed.ignore'], ['/config', '/etc/gitconfig']], user: '65532:65532', network: 'none',
    rootfsReadOnly: true, capDrop: ['ALL'], noNewPrivileges: true, ipc: 'private', formalEligible: false, scanResultNotYetObserved: true,
    limits: { timeoutMs: 1200000, maxOutputBytes: 16777216, memoryBytes: 2147483648, cpus: 2, pids: 128 } };
  const code = findings.length ? 1 : 0;
  const actual = { complete: true, cleanupConfirmed: true, reason: null, imageId: 'sha256:' + hash, containerId: hash,
    state: { Running: false, Status: 'exited', ExitCode: code }, attached: { code, error: false, timedOut: false, overflow: false,
      stdout: JSON.stringify(findings), logs: { stdout: { sha256: hash, bytes: 1, truncated: false }, stderr: { sha256: hash, bytes: 0, truncated: false } } },
    isolation: { network: 'none', nonRoot: true, credentialsMounted: false, controlPathsMounted: false, dockerSocketMounted: false },
    startedAt: iso(now - 5000), finishedAt: iso(now - 1000), cleanupObservedAt: iso(now - 500) };
  editActual(actual);
  const observation = executionSummary(job, prepared, { ignore_sha256: hash }, plan, actual, { deadline: iso(now + 60000), nonce: hash },
    { runtimeIdentity: 'fixture-runtime', hostAcceptanceRef: 'fixture-host', sourceAcceptanceRef: 'fixture-source' });
  return { job, observation, plan };
}

test('其他分支有发现而本 PR 干净：全历史审计告警，PR 通过', () => {
  const { observation } = execution([finding(other)]);
  assert.equal(observation.conclusion, 'success');
  assert.equal(observation.exitCode, 0);
  assert.equal(observation.gitleaksReport.auditExitCode, 1);
  assert.equal(observation.gitleaksReport.other.count, 1);
  assert.equal(observation.gitleaksReport.pr.count, 0);
  assert.ok(!JSON.stringify(observation).includes(secret));
});

test('PR 发现经签名结果和真实发布器出现在 check-run output，正文不外泄', async t => {
  const { job, observation } = execution([finding(HEAD)]), { signer, docs } = fixtureRecord();
  const record = validateRecordV2(docs, { now: Date.now() }), c = { claimId: randomUUID(), fence: 3, epoch: 1, expiresAt: iso(Date.now() + 3600000) };
  const refs = Object.fromEntries(['sourceAcceptanceRef', 'hostQualificationRef', 'ownerAuthorizationRef', 'publisherQualificationRef', 'ciPrincipalQualificationRef'].map(k => [k, record.accepted[k]]));
  const authority = { fixture: true, async observe(j) { return { ...subjectOfV2(j), ...refs, ciPrincipalBindingId: record.config.ciPrincipalBindingId,
    sourceAccepted: true, hostQualified: true, publisherQualified: true, ciPrincipalQualified: true, observedAt: iso(Date.now()), claimExpiresAt: c.expiresAt, claim: claimGeneration(c) }; } };
  const nativeAdmission = { fixture: true, async evaluatePr(j, packet, opts) { return admittedFacts(j, c, packet, { domain: 'fixture', batchClaim: opts.batchClaim }); } };
  const checks = [], github = { fixture: true,
    async readChangedPaths(j) { return { complete: true, pr: j.pr, headSha: HEAD, baseSha: BASE, paths: ['src/settings.js'] }; },
    async readPullRequest(n) { return { number: n, state: 'open', merged: false, mergeable: true, head: { sha: HEAD, repo: { full_name: job.repo } }, base: { sha: BASE, ref: 'main', repo: { full_name: job.repo } } }; },
    async readChecks() { return { complete: true, checks: structuredClone(checks) }; },
    async createCheck(body) { const check = { id: 100, app: { id: 5368905 }, ...structuredClone(body) }; checks.push(check); return check; },
    async revokeCheck(id, body) { Object.assign(checks.find(c => c.id === id), body); return checks.find(c => c.id === id); } };
  const issue = { job, expiresAt: iso(Date.now() + 60000) };
  const payload = { ...resultPayload(issue, observation, observationFacts(issue, observation), 'fixture-runtime'), domain: 'fixture' };
  const envelope = { contract: 'independent-ci.signed-result.v2', keyId: 'fixture-key', payload,
    signature: sign(null, Buffer.from(canonical(payload)), signer.privateKey).toString('base64url') };
  const pub = createStagedCheckPublisherV2({ nativeAdmission, authority, github,
    journal: await EffectJournal.open(path.join(await tempDir(t), 'effects')),
    signers: new Map([...record.signers].map(([k, s]) => [k, { ...s, domain: 'fixture' }])), configuredChecks: record.config.checks,
    readChangedPaths: j => github.readChangedPaths(j), protectedDeployment: { enabled: true, domain: 'fixture', repository: job.repo,
      ciPrincipalBindingId: record.config.ciPrincipalBindingId, ...refs }, batchClaim: claimGeneration(c), domain: 'fixture' });
  const result = await pub.publish({ job, envelope });
  assert.equal(result.status, 'SETTLED', JSON.stringify(result));
  assert.equal(checks[0].conclusion, 'failure');
  const output = JSON.stringify(checks[0].output);
  for (const value of ['generic-api-key', 'src/settings.js', '17', HEAD]) assert.ok(output.includes(value), value);
  assert.ok(!output.includes(secret));
  assert.ok(!JSON.stringify(envelope).includes(secret));
});

test('真实 Git 提交图：分支、标签及 base 历史不阻塞 PR；PR 中加入后又删除的发现仍失败', async t => {
  const repo = await tempDir(t), gitExe = 'C:/Program Files/Git/mingw64/libexec/git-core/git.exe';
  const git = (...args) => {
    const r = spawnSync(gitExe, ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_AUTHOR_NAME: 'CI fixture', GIT_COMMITTER_NAME: 'CI fixture', GIT_AUTHOR_EMAIL: 'ci@example.invalid', GIT_COMMITTER_EMAIL: 'ci@example.invalid' } });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  // Linux CI uses its native Git; Windows uses the single-link executable that
  // prepareRequiredHistory's noLinks gate also permits.
  const nativeGit = process.platform === 'win32' ? gitExe : '/usr/bin/git';
  const run = (...args) => {
    if (process.platform === 'win32') return git(...args);
    const r = spawnSync(nativeGit, ['-C', repo, '-c', 'user.name=CI fixture', '-c', 'user.email=ci@example.invalid', ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  const commit = async name => { await fs.writeFile(path.join(repo, 'settings.txt'), name); run('add', '.'); run('commit', '-m', name); return run('rev-parse', 'HEAD'); };
  run('init', '-b', 'main');
  const base = await commit('base');
  run('checkout', '-b', 'unrelated'); const unrelated = await commit('unrelated finding'); run('tag', 'unrelated-tag');
  run('checkout', '-b', 'pr', base); const added = await commit('finding added'); const head = await commit('finding deleted');
  const prCommits = await prCommitRange({ gitExecutable: nativeGit, gitDirectory: path.join(repo, '.git'), baseSha: base, headSha: head });
  assert.deepEqual(prCommits, [added, head].sort());
  const prepared = { headSha: head, baseSha: base, prCommits };
  const clean = summarizeGitleaksReport(JSON.stringify([finding(unrelated), finding(base)]), prepared, 1);
  assert.equal(clean.pr.count, 0); assert.equal(clean.other.count, 2);
  const dirty = summarizeGitleaksReport(JSON.stringify([finding(added), finding(unrelated)]), prepared, 1);
  assert.equal(dirty.pr.count, 1); assert.equal(dirty.other.count, 1);
  assert.ok(gitleaksCheckSummary(clean, prepared).includes('不阻塞本 PR'));
  assert.deepEqual(await prCommitRange({ gitExecutable: nativeGit, gitDirectory: path.join(repo, '.git'), baseSha: head, headSha: head }), []);
});

test('报告缺失、截断、未知退出码及报告和退出码矛盾均拒绝，干净 null 报告允许', () => {
  const prepared = { headSha: HEAD, baseSha: BASE, prCommits: [HEAD] };
  for (const [raw, code] of [[undefined, 0], ['', 0], ['[', 0], ['{}', 0], ['[]', 1], [JSON.stringify([finding(HEAD)]), 0], ['[]', 2], [JSON.stringify([{ ...finding(HEAD), Commit: 'invalid' }]), 1]]) {
    assert.throws(() => summarizeGitleaksReport(raw, prepared, code), { code: 'GITLEAKS_REPORT_INVALID' });
  }
  assert.equal(summarizeGitleaksReport('null', prepared, 0).pr.count, 0);
  const report = summarizeGitleaksReport(JSON.stringify([finding(HEAD)]), prepared, 1);
  for (const edit of [r => r.pr.locations[0].Secret = secret, r => r.extra = secret, r => r.pr.locations[0].file = 'path\n' + secret,
    r => r.baseSha = other, r => r.pr.count = 0, r => r.pr.locations = [], r => r.auditExitCode = 0]) {
    const changed = structuredClone(report); edit(changed);
    assert.throws(() => validateGitleaksReport(changed, prepared), { code: 'GITLEAKS_REPORT_INVALID' });
  }
});

test('发现多于输出限额仍全部计数，PR 位置信息单独保留，Markdown 不执行仓库文本', () => {
  const rows = [...Array.from({ length: 50 }, () => finding(other)), { ...finding(HEAD), File: '<script>_[link](url)|.js' }];
  const prepared = { headSha: HEAD, baseSha: BASE, prCommits: [HEAD] };
  const report = summarizeGitleaksReport(JSON.stringify(rows), prepared, 1), text = gitleaksCheckSummary(report, prepared);
  assert.equal(report.other.count, 50); assert.equal(report.other.locations.length, 10);
  assert.equal(report.pr.count, 1); assert.equal(report.pr.locations.length, 1);
  assert.match(text, /另有 40 条/); assert.ok(!text.includes('<script>')); assert.ok(!text.includes(secret));
  assert.ok(Buffer.byteLength(text) < 60000);
  const worst = [...Array.from({ length: 10 }, () => ({ ...finding(other), File: '<'.repeat(512) })),
    ...Array.from({ length: 10 }, () => ({ ...finding(HEAD), File: '&'.repeat(512) }))];
  assert.ok(Buffer.byteLength(gitleaksCheckSummary(summarizeGitleaksReport(JSON.stringify(worst), prepared, 1), prepared)) < 60000);
});

test('扫描错误、输出溢出及未确认清理不能由审计告警变成 PR 通过', () => {
  for (const edit of [o => o.attached.overflow = true, o => o.attached.timedOut = true, o => o.cleanupConfirmed = false,
    o => o.state.ExitCode = 2]) assert.throws(() => execution([finding(other)], [HEAD], edit), { code: 'ACTUAL_HISTORY_EXIT_AND_WHOLE_CONTAINER_CLEANUP_REQUIRED' });
  assert.throws(() => execution([finding(other)], [HEAD], o => o.attached.logs.stderr.bytes = 1), { code: 'GITLEAKS_SCAN_ERROR' });
});

test('真实观察器与传输收集有界 JSON stdout，stderr 仅摘要，Docker 仍禁日志和写挂载', async () => {
  const { plan } = execution([]), request = { nonce: hash, executionId: hash, deadline: iso(Date.now() + 60000) };
  const c = { imageDigest: IMAGE, dockerRootDirectory: '/var/lib/docker', limits: plan.limits }, id = 'f'.repeat(64), imageId = 'sha256:' + hash;
  const ok = stdout => ({ code: 0, error: false, overflow: false, timedOut: false, stdout });
  let started = false, create;
  const native = () => ({ Id: id, Name: '/clued-verify-' + hash, Image: imageId,
    Config: { Image: IMAGE, User: '65532:65532', Entrypoint: [plan.executable], Cmd: plan.args, WorkingDir: plan.cwd,
      Labels: { 'clued.verify.nonce': hash, 'clued.verify.execution': hash }, Env: ['NODE_OPTIONS=', 'NODE_PATH=', 'HOME=/scratch'] },
    HostConfig: { NetworkMode: 'none', IpcMode: 'private', PidMode: '', CgroupnsMode: 'private', Privileged: false, ReadonlyRootfs: true, CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'], PidsLimit: 128, Memory: 2147483648, MemorySwap: 2147483648, NanoCpus: 2e9,
      LogConfig: { Type: 'none' }, Tmpfs: { '/scratch': 'noexec,uid=65532' } },
    Mounts: plan.mounts.map(([Source, Destination]) => ({ Type: 'bind', Source, Destination, RW: false })),
    State: { Running: false, Status: 'exited', ExitCode: 1, Error: '', OOMKilled: false } });
  const docker = async (args, options) => {
    if (args[0] === 'info') return ok(JSON.stringify({ OSType: 'linux', DockerRootDir: '/var/lib/docker', SecurityOptions: ['seccomp'] }));
    if (args[0] === 'image') return ok(JSON.stringify([{ Id: imageId, RepoDigests: [IMAGE], Os: 'linux', Config: {} }]));
    if (args[0] === 'create') { create = args; return ok(id); }
    if (args[0] === 'inspect') return ok(JSON.stringify([native()]));
    if (args[0] === 'start') {
      started = true; assert.equal(options.digestOnly, false);
      const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.kill = () => {};
      const promise = observeDockerChild(p, options);
      p.stdout.emit('data', Buffer.from(JSON.stringify([finding(other)]))); p.stderr.emit('data', Buffer.from('discarded stderr'));
      p.emit('close', 1); return promise;
    }
    return ok('');
  };
  const actual = await observeGitleaksContainer(c, request, plan, docker);
  assert.equal(actual.complete, true, actual.reason); assert.equal(started, true);
  assert.equal(JSON.parse(actual.attached.stdout)[0].RuleID, 'generic-api-key');
  assert.equal(actual.attached.stderr, undefined); assert.equal(actual.attached.logs.stderr.bytes, 16);
  assert.ok(create.includes('--log-driver=none')); assert.ok(create.includes('--redact'));
  assert.ok(create.filter(s => s.startsWith('type=bind')).every(s => s.includes(',readonly,')));
  assert.deepEqual(plan.args.slice(-2), ['--report-path', '-']);
});
