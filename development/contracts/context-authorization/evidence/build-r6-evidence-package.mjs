import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Offline byte packaging only. This script cannot adopt files into the repo,
// start a database, call Canon/CI, or create review/execution qualifications.
const script = fileURLToPath(import.meta.url);
const here = path.dirname(script);
const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (key === '--verify-only') args.set(key, true);
  else { assert.ok(['--repo', '--evidence-root', '--output', '--inputs', '--from-envelope'].includes(key)); args.set(key, process.argv[++i]); }
}
const repo = path.resolve(args.get('--repo') ?? path.join(here, '..', 'repo'));
const evidenceRoot = path.resolve(args.get('--evidence-root') ?? here);
const output = path.resolve(args.get('--output') ?? path.join(evidenceRoot, 'r6-engineering-evidence-package-candidate-v2'));
const expectedOutput = path.join(evidenceRoot, 'r6-engineering-evidence-package-candidate-v2');
assert.equal(output, expectedOutput, 'writes are confined to the named candidate under the explicit evidence root');
assert.ok(path.relative(repo, output).startsWith('..'), 'candidate must stay outside the repository');
const inputPath = path.resolve(args.get('--inputs') ?? path.join(here, 'r6-engineering-evidence-package-inputs.v2.json'));
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const serialize = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
const slash = (value) => value.replaceAll('\\', '/');
const rawInputs = await fs.readFile(inputPath);
const inputs = JSON.parse(rawInputs);
assert.equal(inputs.schema, 'clued.r6-engineering-evidence-package-inputs.v1');
const original = new Map();
if (args.has('--from-envelope')) {
  const prior = JSON.parse(await fs.readFile(args.get('--from-envelope'), 'utf8'));
  assert.equal(prior.schema, 'clued.exact-original-engineering-evidence.v1');
  for (const item of prior.files) {
    const bytes = Buffer.from(item.original_base64, 'base64');
    assert.equal(bytes.toString('base64'), item.original_base64, 'canonical Base64');
    assert.equal(bytes.length, item.original_bytes);
    assert.equal(sha(bytes), item.original_sha256);
    assert.ok(!original.has(item.path)); original.set(item.path, bytes);
  }
}
for (const item of inputs.files) {
  assert.equal(path.basename(item.path), item.path, 'fixed sibling basenames only');
  const bytes = original.get(item.path) ?? await fs.readFile(path.join(evidenceRoot, item.path));
  assert.equal(bytes.length, item.original_bytes, `${item.path}: original size`);
  assert.equal(sha(bytes), item.original_sha256, `${item.path}: original SHA`);
  assert.ok(Buffer.from(bytes.toString('utf8')).equals(bytes), `${item.path}: valid exact UTF8`);
  original.set(item.path, bytes);
}
assert.equal(original.size, inputs.files.length, 'no duplicate or surplus originals');
const json = (name) => JSON.parse(original.get(name).toString('utf8'));
const evidenceDir = 'development/contracts/context-authorization/evidence';
const envelopeName = 'ExactAuthorizationRepairEvidenceR6.v1.json';
const summaryName = 'AuthorizationRepairR6BoundedSummary.v1.json';
const artifacts = new Map();
const envelope = {
  schema: 'clued.exact-original-engineering-evidence.v1',
  qualification: 'r6 engineering carrier only. Current bounded 45 main / 12 compat / 46 mixed-stage lifecycle / 60 UI API remain separate, never summed. Exact original bytes, historical failures and CRLF-to-LF copies are distinguished. Copying/Base64 is not independent review or new execution. Home Major, new-head CI, deployment, same-Binding Native upgrade and full eight-view acceptance remain incomplete.',
  files: inputs.files.map((item) => {
    const bytes = original.get(item.path);
    const text = bytes.toString('utf8');
    const normalized = Buffer.from(text.replaceAll('\r\n', '\n'), 'utf8');
    artifacts.set(`${evidenceDir}/${item.path}`, normalized);
    return { path: item.path, original_sha256: sha(bytes), original_bytes: bytes.length,
      original_base64: bytes.toString('base64'), git_text_sha256: sha(normalized),
      git_text_transform: bytes.equals(normalized) ? 'identity' : 'CRLF_to_LF' };
  }),
};
const envelopeBytes = serialize(envelope);
artifacts.set(`${evidenceDir}/${envelopeName}`, envelopeBytes);

// Verify current subject bytes separately from historical assertions embedded
// inside immutable reports. Historical source hashes are not present-file refs.
const sourceReport = json('last-source-zero-safe-repair-r6.json');
const sourceReview = json('last-source-zero-security-review-r6.json');
const lifecycle = json('lifecycle-source-compatibility-fixture-repair-r6.json');
const uiReview = json('personal-records-name-order-code-review-r2.json');
const sourceManifest = json('last-source-zero-safe-repair-r6-manifest.json');
const mainRun = json('last-source-zero-repair-r6-qualification-run.json');
const compatRun = json('last-source-zero-repair-r6-compat-run.json');
assert.equal(sourceReview.verdict, 'BOUNDED_PASS');
assert.equal(sourceReview.code_qualified, true); assert.equal(sourceReview.report_qualified, true);
assert.equal(sourceReview.source_sha, inputs.source_sha256);
assert.equal(sourceReview.sql2_sha, inputs.serialization_sha256);
assert.equal(sourceReview.test_sha, inputs.main_test_sha256);
assert.equal(sourceReview.report_sha, sha(original.get('last-source-zero-safe-repair-r6.json')));
assert.equal(sourceReview.closing_manifest_sha, sha(original.get('last-source-zero-safe-repair-r6-manifest.json')));
assert.equal(uiReview.verdict, 'PASS'); assert.equal(uiReview.overall_naming_verdict, 'CHANGES_REQUIRED');
assert.equal(lifecycle.run.exit_code, 0); assert.equal(lifecycle.run.counts.pass, 46); assert.equal(lifecycle.run.counts.fail, 0); assert.equal(lifecycle.run.counts.skip, 0);
const currentSubjects = new Map();
const addSubject = (file, expected, role) => {
  const prior = currentSubjects.get(file);
  if (prior) { assert.equal(prior.expected_sha256, expected, file); prior.roles.push(role); }
  else currentSubjects.set(file, { path: file, expected_sha256: expected, roles: [role] });
};
for (const f of sourceReport.files) addSubject(`apps/clued-cloud/${f.path}`, f.sha256, 'SOURCE_AUTHOR_FROZEN_SUBJECT');
addSubject(`apps/clued-cloud/${sourceReport.readonly_serialization.path}`, sourceReport.readonly_serialization.sha256, 'SERIALIZATION_UNCHANGED');
addSubject(lifecycle.fixture.path, lifecycle.fixture.after_run_sha256, 'LIFECYCLE_ACTUAL_FROZEN_FIXTURE');
const subjectChecks = [];
for (const f of currentSubjects.values()) {
  const bytes = await fs.readFile(path.join(repo, f.path));
  assert.equal(sha(bytes), f.expected_sha256, `${f.path}: frozen r6 subject changed`);
  subjectChecks.push({ ...f, actual_sha256: sha(bytes), bytes: bytes.length, match: true });
}
const uiChecks = [];
for (const f of uiReview.subject.files) {
  const bytes = await fs.readFile(path.join(repo, f.path));
  uiChecks.push({ path: f.path, reviewed_sha256: f.closing_sha256, actual_sha256: sha(bytes), bytes: bytes.length,
    exact_match: sha(bytes) === f.closing_sha256, qualification: 'FROZEN_SEVEN_FILE_DELTA_ONLY_NOT_NEW_HEAD_ACCEPTANCE' });
}

// Every direct package input ref is checked against original bytes. Current
// report log/manifest links are also checked independently before publishing.
const referenceChecks = [];
const checkRef = (owner, pointer, name, expected, length = null) => {
  const bytes = original.get(path.basename(name));
  assert.ok(bytes, `${owner}${pointer}: selected original missing: ${name}`);
  assert.equal(sha(bytes), expected, `${owner}${pointer}: reference SHA`);
  if (length !== null) assert.equal(bytes.length, length);
  referenceChecks.push({ owner, pointer, original: path.basename(name), sha256: expected, bytes: bytes.length, verified: true });
};
for (const r of sourceReport.runs) {
  checkRef('last-source-zero-safe-repair-r6.json', '/runs/manifest', r.manifest.path, r.manifest.sha256);
  checkRef('last-source-zero-safe-repair-r6.json', '/runs/log', r.log.path, r.log.sha256);
  assert.equal(r.log_sha256, r.log.sha256);
}
for (const f of sourceReport.fixed_artifacts) checkRef('last-source-zero-safe-repair-r6.json', '/fixed_artifacts', f.path, f.sha256);
for (const f of sourceManifest.files.filter((f) => /ui-acceptance/.test(f.path))) checkRef('last-source-zero-safe-repair-r6-manifest.json', '/files', f.path, f.sha256);
checkRef('lifecycle-source-compatibility-fixture-repair-r6.json', '/run/log', lifecycle.run.log.path, lifecycle.run.log.sha256);
checkRef('personal-records-name-order-code-review-r2.json', '/subject/manifest', uiReview.subject.manifest.path, uiReview.subject.manifest.sha256);
checkRef('personal-records-name-order-code-review-r2.json', '/subject/patch', uiReview.subject.patch.path, uiReview.subject.patch.sha256, uiReview.subject.patch.bytes);
checkRef('personal-records-name-order-code-review-r2.json', '/validation/log', uiReview.validation.current_local_evidence.path, uiReview.validation.current_local_evidence.sha256);
checkRef('personal-records-name-order-code-review-r2.json', '/validation/typecheck', uiReview.validation.current_local_evidence.typecheck.path, uiReview.validation.current_local_evidence.typecheck.sha256, uiReview.validation.current_local_evidence.typecheck.bytes);
for (const r of uiReview.validation.retained_failed_attempts) checkRef('personal-records-name-order-code-review-r2.json', '/validation/retained_failed_attempts', r.path, r.sha256);
for (const r of [mainRun, compatRun]) {
  assert.equal(r.exit_code, 0); assert.equal(r.source_before_sha256, inputs.source_sha256); assert.equal(r.source_after_sha256, inputs.source_sha256);
  assert.equal(r.serialization_sha256, inputs.serialization_sha256);
}
const mainText = original.get('last-source-zero-repair-r6-qualification.log').toString('utf8');
const compatText = original.get('last-source-zero-repair-r6-compat.log').toString('utf8');
assert.match(mainText, /pass 45\s*\r?\n.*fail 0[\s\S]*skipped 0/);
assert.match(compatText, /pass 12\s*\r?\n.*fail 0[\s\S]*skipped 0/);
const trace = [...mainText.matchAll(/\{"family":.*\}/g)].map((m) => JSON.parse(m[0]));
assert.equal(trace.length, 14); assert.deepEqual(trace, sourceReport.actual_wait_vectors);

const ref = (name) => ({ path: name, original_sha256: sha(original.get(name)), original_bytes: original.get(name).length });
const summary = {
  schema: 'clued.authorization-repair-r6-bounded-engineering-summary.v1', authority_effect: 'NONE',
  package_revision: inputs.package_revision, candidate_status: 'OFFLINE_CANDIDATE_ROOT_ADOPTION_REQUIRED',
  task: { id: sourceReport.task_id, claim_id: sourceReport.claim_id, fence: 7, packaging_lease_reported_by_root: 9, budget_reset: false },
  source: { sql1_sha256: inputs.source_sha256, sql2_sha256: inputs.serialization_sha256, main_test_sha256: inputs.main_test_sha256 },
  original_envelope: { path: envelopeName, sha256: sha(envelopeBytes), schema: envelope.schema, byte_preservation_is_not_independent_review: true },
  current_bounded_evidence: [
    { id: 'source-main', counts: { pass: 45, fail: 0, skip: 0 }, run: ref('last-source-zero-repair-r6-qualification-run.json'), log: ref('last-source-zero-repair-r6-qualification.log'), scope: 'Full owned PG parent; 14 last-loss wait vectors plus 2 partial-loss scenarios. Verify wait branch is ready_profile; canonical-baseline wait is not separately proved.' },
    { id: 'compatibility', counts: { pass: 12, fail: 0, skip: 0 }, run: ref('last-source-zero-repair-r6-compat-run.json'), log: ref('last-source-zero-repair-r6-compat.log'), scope: 'Seven current SHA-pin fixtures and two label fixtures; case/root admission parent both execute, not 12 unique cases.' },
    { id: 'lifecycle', counts: { pass: 46, fail: 0, skip: 0 }, report: ref('lifecycle-source-compatibility-fixture-repair-r6.json'), log: ref('lifecycle-source-compatibility-final-test-r6.log'), scope: 'One full frozen fixture parent contains explicitly qualified historical pre-Source proofs and current r6 proofs; 46 does not mean 46 exclusively current-source cases.' },
    { id: 'ui-api', counts: { pass: 60, fail: 0, skip: 0 }, review: ref('personal-records-name-order-code-review-r2.json'), log: ref('personal-order-and-empty-source-ui-transport-r3.log'), scope: 'Frozen seven-file delta bounded PASS; component/HTTP double evidence, not whole browser/SQL/production. Typecheck exit0 comes from Root execution/subject; an empty log alone is not proof.' },
  ],
  independent_reviews: [
    { reviewer: sourceReview.reviewer, role: 'NON_AUTHOR_EXACT_SOURCE_AND_REPORT_REVIEW', report: ref('last-source-zero-security-review-r6.json'), verdict: sourceReview.verdict, code_qualified: sourceReview.code_qualified, report_qualified: sourceReview.report_qualified, copied_source_is_not_second_review: true },
    { reviewer: uiReview.reviewer, role: 'NON_AUTHOR_FROZEN_UI_API_DELTA_REVIEW', report: ref('personal-records-name-order-code-review-r2.json'), verdict: uiReview.verdict, overall_naming_verdict: uiReview.overall_naming_verdict },
  ],
  historical_evidence: inputs.files.filter((f) => f.classification === 'HISTORICAL_ONLY_PRESERVED').map((f) => ({ path: f.path, original_sha256: f.original_sha256, original_bytes: f.original_bytes, qualification: 'HISTORICAL_ONLY_NOT_R6_ACCEPTANCE' })),
  unresolved: { home_major: uiReview.carried_findings, new_head_ci: 'NOT_ESTABLISHED', protected_merge: 'NOT_ESTABLISHED', production_backup_and_migrations: 'NOT_ESTABLISHED', deployment_and_online_checks: 'NOT_ESTABLISHED', same_binding_native_upgrade: 'NOT_ESTABLISHED', whole_browser_and_eight_view_acceptance: 'INCOMPLETE', original_task_or_enhancement_closed: false },
  current_subject_checks: subjectChecks, ui_frozen_subject_checks: uiChecks, verified_direct_original_references: referenceChecks,
  limitations: ['No aggregate total or full-product PASS is produced.', 'Historical report Source/test hashes remain historical declarations; current subject bytes are checked separately.', 'No formal envelope JSON Schema or existing specialized validator was found; this builder validates only the declared byte carrier relations and selected current links.', 'No PG/CI/Git/Source/shared-path/Canon operation occurs during packaging.', 'New main inheritance and later edits invalidate their exact-file qualification until independently reconciled.', 'The original r1 naming report already contains replacement characters in one field; original bytes are preserved without silent reconstruction.'],
};
const summaryBytes = serialize(summary); artifacts.set(`${evidenceDir}/${summaryName}`, summaryBytes);
const ledger = `## r6 授权修复与限定证据（待 Root 采纳的追加段）\n\n当前受查 Source SQL SHA256 \`${inputs.source_sha256}\`，序列化 SQL \`${inputs.serialization_sha256}\`。主测试固定为 \`${inputs.main_test_sha256}\`。此前 r5 的两项 Major 已修；[r6 非作者 Source／报告复审](evidence/last-source-zero-security-review-r6.json)为 BOUNDED_PASS，原报告 SHA256 \`${sha(original.get('last-source-zero-security-review-r6.json'))}\`，代码与报告分别通过。复制源码、封装 Base64 或制作本包不产生第二份独立审核。\n\n实际限定执行分别为主父 45 PASS／0 FAIL／0 SKIP、兼容组 12 PASS／0 FAIL／0 SKIP、生命周期父 46 PASS／0 FAIL／0 SKIP、UI／HTTP 60 PASS／0 FAIL／0 SKIP，不能相加宣称全 Stack 通过。主父保存七类操作的十四个真实等待后撤权／自然到期及两种部分收窄回滚证据；状态计算 valid=true、空 capability、无人工 diagnostic。生命周期父同时包含独立保留的旧阶段和当前阶段证明，不把全部 46 项描述为只针对新 Source。\n\nUI／API [r2 差异复审](evidence/personal-records-name-order-code-review-r2.json)的原 SHA256 \`${sha(original.get('personal-records-name-order-code-review-r2.json'))}\`，PASS 仅限受查七文件；overall_naming 仍 CHANGES_REQUIRED，首页 R1-Major-01 尚未关闭。真实浏览器整体验收、后续主线／新 head 完整 CI、受保护合并、生产备份／迁移／发布、同 Binding Native 升级及八视图完整验收仍未完成，本段不关闭原 Task 或第三阶段增强。\n\n[r6 原字节封套](evidence/${envelopeName}) SHA256 \`${sha(envelopeBytes)}\` 保全原报告、原日志、原始失败与固定源码字节；相邻可读副本只按明确 identity／CRLF_to_LF 变换生成。原 SHA 与 Git LF 文本 SHA 分开列明。r4 复现、r5 CHANGES_REQUIRED、r6 两次安装失败及界面失败均保留，不改写为通过。详细范围与所有摘要见[限定工程摘要](evidence/${summaryName}) SHA256 \`${sha(summaryBytes)}\`。\n`;
artifacts.set('ReviewLedger.r6.append.md', Buffer.from(ledger, 'utf8'));
artifacts.set(`${evidenceDir}/r6-engineering-evidence-package-inputs.v2.json`, rawInputs);
const builderBytes = await fs.readFile(script); artifacts.set(`${evidenceDir}/build-r6-evidence-package.mjs`, builderBytes);
const readme = `r6 engineering package candidate\n\nRoot adoption only: copy candidate repo/ into the coordinated repository after main inheritance; append ReviewLedger.r6.append.md after binding any new observations. This builder never performs adoption.\n\nSuggested exact new repository paths: ${evidenceDir}/${envelopeName}; ${evidenceDir}/${summaryName}; all adjacent immutable originals/LF carriers; ${evidenceDir}/build-r6-evidence-package.mjs; ${evidenceDir}/r6-engineering-evidence-package-inputs.v2.json. Existing ReviewLedger.md is append-only here; old r4/r5 files are not overwritten.\n\nBuild/verify: node build-r6-evidence-package.mjs --repo <repository> --evidence-root <ui-acceptance> --output <ui-acceptance>/r6-engineering-evidence-package-candidate-v2 [--verify-only]. Add --from-envelope <ExactAuthorizationRepairEvidenceR6.v1.json> to reproduce original bytes from Base64 without original local logs. Same declared inputs produce identical bytes; differing existing candidate bytes cause refusal.\n\nOnly the generic existing self-described engineering envelope is reused; no formal schema validator, independent review or new execution is claimed by this byte pack. Current bounded qualifications and open home Major/new-head CI/online/full-eight-view work are in the summary.\n`;
artifacts.set('README.txt', Buffer.from(readme, 'utf8'));
const files = [...artifacts].sort(([a], [b]) => a.localeCompare(b)).map(([file, bytes]) => ({
  path: file.startsWith('development/') ? `repo/${file}` : file,
  suggested_repo_path: file.startsWith('development/') ? file : null,
  sha256: sha(bytes), bytes: bytes.length }));
const closing = serialize({ schema: 'clued.r6-engineering-evidence-package-candidate-manifest.v1', authority_effect: 'NONE', files,
  inputs: { sha256: sha(rawInputs), bytes: rawInputs.length }, builder: { sha256: sha(builderBytes), bytes: builderBytes.length },
  self_reference: 'Manifest and verification exclude themselves to avoid hash cycles. All repo/ files are candidates for Root-controlled adoption only.' });
const verification = serialize({ schema: 'clued.r6-engineering-evidence-package-byte-verification.v1', authority_effect: 'NONE',
  method: 'AUTHOR_OFFLINE_BYTE_RELATIONS_ONLY_NOT_INDEPENDENT_REVIEW', manifest_sha256: sha(closing),
  original_files: envelope.files.length, original_bytes: inputs.files.reduce((n, f) => n + f.original_bytes, 0),
  base64_lengths_and_hashes_match: true, adjacent_transform_bytes_and_hashes_match: true,
  current_subject_files: subjectChecks.length, current_subject_mismatches: 0,
  ui_frozen_subject_files: uiChecks.length, ui_frozen_subject_mismatches: uiChecks.filter((f) => !f.exact_match).length,
  direct_original_reference_checks: referenceChecks.length, failed_historical_runs_retained: true,
  source_review: 'BOUNDED_PASS_ORIGINAL_REPORT', ui_delta_review: 'PASS_WITH_HOME_MAJOR_STILL_OPEN', new_execution_or_acceptance: false });
artifacts.set('CandidateManifest.v1.json', closing); artifacts.set('ByteVerification.v1.json', verification);
for (const item of envelope.files) {
  const decoded = Buffer.from(item.original_base64, 'base64');
  assert.equal(decoded.length, item.original_bytes); assert.equal(sha(decoded), item.original_sha256);
  const adjacent = artifacts.get(`${evidenceDir}/${item.path}`);
  assert.equal(sha(adjacent), item.git_text_sha256);
  assert.ok(Buffer.from(decoded.toString('utf8').replaceAll('\r\n', '\n')).equals(adjacent));
}
for (const [file, bytes] of artifacts) {
  const relative = file.startsWith('development/') ? `repo/${file}` : file;
  const target = path.resolve(output, relative);
  assert.ok(path.relative(output, target) && !path.relative(output, target).startsWith('..'));
  if (args.has('--verify-only')) assert.ok((await fs.readFile(target)).equals(bytes), `${relative}: candidate exact bytes`);
  else {
    await fs.mkdir(path.dirname(target), { recursive: true });
    try { await fs.writeFile(target, bytes, { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; assert.ok((await fs.readFile(target)).equals(bytes), `${relative}: existing candidate differs; no overwrite allowed`); }
  }
}
console.log(JSON.stringify({ candidate: slash(output), files: artifacts.size, originals: envelope.files.length,
  envelope_sha256: sha(envelopeBytes), summary_sha256: sha(summaryBytes), manifest_sha256: sha(closing), verification_sha256: sha(verification),
  current_subject_mismatches: 0, ui_frozen_subject_mismatches: uiChecks.filter((f) => !f.exact_match).length,
  operation: args.has('--verify-only') ? 'VERIFY_ONLY_NO_WRITES' : 'CANDIDATE_BUILD_ONLY_NO_REPO_WRITES' }));
