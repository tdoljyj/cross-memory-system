#!/usr/bin/env node
// Read-only Root10 runtime-clock material assembler. It performs GitHub verification only;
// it never signs a GA, writes the control store, starts a container, or declares PASS.
//
// Successor of ../../stage2/runner-material/build-root10-runner-material.mjs, which is
// hard-coded to the first round's topology: it asserts that the reviewer delegation and the
// executor applicability were published in the SAME owner merge, and it has no notion of the
// runtime-clock amendment. Under the runtime clock those artifacts live in three different
// owner merges, so this assembler takes a SET of publications and resolves every reference
// against whichever one actually carries its bytes, reporting the mapping it found.
//
// What it does NOT produce -- the live half, which only the dispatch driver can supply
// because the controller requires it to be at most 15 seconds old:
//   observation, ga_raw, status_manifest.raw, runtime_clock.event, runtime_clock.host_window.
// Those come from clued_control.read_execution() at dispatch time.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';

const args = process.argv.slice(2), configPath = args[0];
if (!configPath || !args.includes('--emit-json')) throw Error('usage: node build-root10-runtime-clock-material.mjs CONFIG.json --emit-json [--out FILE]');
const valueAfter = flag => {const i = args.indexOf(flag); return i < 0 ? null : args[i + 1];};
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const repository = 'tdoljyj/cross-memory-system', gh = cfg.gh_path || 'gh';
const need = (v, m) => {if (!v) throw Error(m);};
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const blob = b => crypto.createHash('sha1').update('blob ' + Buffer.byteLength(b) + '\0').update(b).digest('hex');
const ordered = v => Array.isArray(v) ? v.map(ordered) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, ordered(v[k])])) : v;
const digest = v => sha(JSON.stringify(ordered(v)) + '\n');
const same = (a, b) => digest(a) === digest(b);
const exactKeys = (v, keys, label) => need(v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === [...keys].sort().join(','), label);
const hex40 = v => typeof v === 'string' && /^[0-9a-f]{40}$/.test(v);
const hex64 = v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const read = p => fs.readFileSync(p, 'utf8');

const apiCache = new Map();
const api = endpoint => {
  need(endpoint === 'repos/' + repository || endpoint.startsWith('repos/' + repository + '/'), 'PRIVATE_REPOSITORY_ONLY');
  if (apiCache.has(endpoint)) return structuredClone(apiCache.get(endpoint));
  const v = JSON.parse(execFileSync(gh, ['api', '--hostname', 'github.com', endpoint], {encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024, windowsHide: true}));
  apiCache.set(endpoint, v);
  return structuredClone(v);
};

// Same owner-merge proof the controller applies: a verified web-flow merge of a pull request
// the Owner merged into main, with the complete (untruncated) tree.
function verifyPublication(label, input) {
  exactKeys(input, ['pr_number', 'merge_commit'], label + '_PUBLICATION_INPUT');
  need(Number.isSafeInteger(input.pr_number) && input.pr_number > 0 && hex40(input.merge_commit), label + '_PUBLICATION_ID');
  const repo = api('repos/' + repository);
  need(repo.private === true && repo.full_name === repository, label + '_PRIVATE_REPOSITORY');
  const pr = api('repos/' + repository + '/pulls/' + input.pr_number);
  need(pr.merged === true && pr.merged_at && pr.base?.ref === 'main' && pr.merged_by?.login === 'tdoljyj' && pr.merge_commit_sha === input.merge_commit, label + '_ACTUAL_OWNER_PR_MERGE');
  const commit = api('repos/' + repository + '/commits/' + input.merge_commit), v = commit.commit?.verification;
  need(commit.sha === input.merge_commit && commit.parents?.length === 2 && commit.committer?.login === 'web-flow' && v?.verified === true && v.reason === 'valid', label + '_VERIFIED_WEB_FLOW_MERGE');
  const prs = api('repos/' + repository + '/commits/' + input.merge_commit + '/pulls');
  need(Array.isArray(prs) && prs.filter(p => p.number === input.pr_number && p.merge_commit_sha === input.merge_commit && p.merged_at && p.base?.ref === 'main').length === 1, label + '_EXACT_MERGED_PR');
  const tree = api('repos/' + repository + '/git/trees/' + commit.commit.tree.sha + '?recursive=1');
  need(tree.sha === commit.commit.tree.sha && tree.truncated === false && Array.isArray(tree.tree), label + '_COMPLETE_TREE');
  return {label, pr_number: input.pr_number, merge_commit: input.merge_commit, tree_sha: tree.sha, tree: tree.tree};
}

function actualBlobRaw(ref) {
  const m = /^https:\/\/api[.]github[.]com\/repos\/tdoljyj\/cross-memory-system\/git\/blobs\/([0-9a-f]{40})$/.exec(ref?.uri);
  need(m && hex64(ref.sha256), 'EXACT_GITHUB_BLOB_REF');
  const response = api('repos/' + repository + '/git/blobs/' + m[1]);
  need(response.sha === m[1] && response.encoding === 'base64', 'ACTUAL_BLOB_RESPONSE');
  const bytes = Buffer.from(response.content, 'base64');
  need(bytes.length === response.size && sha(bytes) === ref.sha256 && blob(bytes) === m[1], 'ACTUAL_BLOB_BYTES');
  return {id: m[1], raw: bytes.toString('utf8')};
}

// Every publication is proven before anything is resolved against it, so a reference can never
// be satisfied by a tree whose owner merge was not checked.
exactKeys(cfg.publications, ['original_source', 'ga_target', 'reviewer', 'executor_applicability', 'acceptance', 'status_manifest'], 'EXACT_PUBLICATION_SET');
const pubs = Object.fromEntries(Object.entries(cfg.publications).map(([name, input]) => [name, verifyPublication(name.toUpperCase(), input)]));
const resolution = {};

// Resolve a reference in whichever proven publication carries its bytes. Recording the merge
// that was actually used, rather than assuming one, is the whole difference from the
// first-round assembler.
function descriptor(ref, label, candidates, exactPath = null) {
  const source = actualBlobRaw(ref);
  for (const name of candidates) {
    const pub = pubs[name];
    const matches = pub.tree.filter(e => e.type === 'blob' && e.mode === '100644' && e.sha === source.id && (exactPath === null || e.path === exactPath));
    if (matches.length === 0) continue;
    const artifactPath = matches.map(e => e.path).sort()[0];
    resolution[label] = {publication: name, commitSha: pub.merge_commit, artifactPath};
    return {ref, raw: source.raw, publication: {commitSha: pub.merge_commit, artifactPath}};
  }
  throw Error('BLOB_NOT_IN_ANY_PROVEN_OWNER_MERGE:' + label + ':' + source.id);
}

// An artifact identified by local bytes rather than by a signed ref: prove the same bytes are
// published at the named path in the named merge, and that GitHub returns them verbatim.
function artifactAt(raw, pubName, repoPath, label) {
  need(typeof repoPath === 'string' && !repoPath.startsWith('/') && !repoPath.includes('..'), label + '_SAFE_REPO_PATH');
  const pub = pubs[pubName], id = blob(raw), matches = pub.tree.filter(e => e.path === repoPath);
  need(matches.length === 1 && matches[0].type === 'blob' && matches[0].mode === '100644' && matches[0].sha === id, label + '_EXACT_PUBLICATION_PATH');
  const remote = actualBlobRaw({uri: 'https://api.github.com/repos/' + repository + '/git/blobs/' + id, sha256: sha(raw)});
  need(remote.raw === raw, label + '_ACTUAL_PUBLISHED_BYTES');
  resolution[label] = {publication: pubName, commitSha: pub.merge_commit, artifactPath: repoPath};
  return {raw, publication: {commitSha: pub.merge_commit, artifactPath: repoPath}};
}

exactKeys(cfg.paths, ['runtime_acceptance_local', 'runtime_acceptance_repo', 'controller_qualification_local', 'controller_qualification_repo',
  'status_signing_payload_local', 'status_signing_payload_repo'], 'EXACT_LOCAL_AND_REPO_PATHS');

const runtimeRaw = read(cfg.paths.runtime_acceptance_local), runtime = JSON.parse(runtimeRaw);
const qualificationRaw = read(cfg.paths.controller_qualification_local), qualification = JSON.parse(qualificationRaw);
const statusPayloadRaw = read(cfg.paths.status_signing_payload_local), statusPayload = JSON.parse(statusPayloadRaw);

const runtimeArtifact = artifactAt(runtimeRaw, 'acceptance', cfg.paths.runtime_acceptance_repo, 'runtime_acceptance');
const qualificationArtifact = artifactAt(qualificationRaw, 'acceptance', cfg.paths.controller_qualification_repo, 'controller_qualification');
const statusArtifact = artifactAt(statusPayloadRaw, 'status_manifest', cfg.paths.status_signing_payload_repo, 'status_signing_payload');

need(runtime.state === 'ACCEPTED_EXACT_PREENTRY_CONTROLLER_RUNTIME' && runtime.independent_reviewer === '/root' && runtime.no_automatic_retry === true && runtime.no_successor_ga === true, 'EXACT_ROOT10_RUNTIME');
need(qualification.state === 'ACCEPTED_SCOPED_CONTROLLER_QUALIFICATION' && qualification.independent_reviewer === '/root' && qualification.first_budget_sequence === cfg.first_budget_sequence && qualification.automatic_retry === false && qualification.successor_ga === false, 'EXACT_ROOT10_QUALIFICATION');
need(runtime.controller_digest === qualification.controller_digest && runtime.scope_digest === qualification.scope_digest, 'RUNTIME_QUALIFICATION_BINDING');

const subject = runtime.accepted_subject, expected = subject?.expected_ga, root10 = subject?.root10_single_window;
// 第 11 代不带任何修正案：三个描述符必须整体缺席，控制器按第 10 代身份逐项比对，带了必被拒。
for (const key of ['scope_amendment', 'runtime_clock', 'temporal_continuation']) {
  need(!subject[key], 'NO_AMENDMENT_DESCRIPTOR:' + key);
}

// 源发布：控制器要求 source_ref.commit 是 Owner 合并的祖先（compare 为 ahead 或 identical），
// 而不是那次合并本身——第 11 代的源提交是分支上的普通提交，不是合并。
const sourceRef = expected?.source_ref;
need(hex40(sourceRef?.commit) && hex40(sourceRef.tree) && Array.isArray(sourceRef.blobs), 'EXACT_SOURCE_REF');
const sourceCommit = api('repos/' + repository + '/commits/' + sourceRef.commit);
need(sourceCommit.sha === sourceRef.commit && sourceCommit.commit.tree.sha === sourceRef.tree, 'ACTUAL_SOURCE_COMMIT_TREE');
const comparison = api('repos/' + repository + '/compare/' + sourceRef.commit + '...' + pubs.acceptance.merge_commit);
need(comparison.base_commit?.sha === sourceRef.commit && comparison.merge_base_commit?.sha === sourceRef.commit
  && ['ahead', 'identical'].includes(comparison.status), 'SOURCE_ANCESTOR_OF_ACTUAL_OWNER_MERGE');
need(sourceRef.blobs.filter(b => b.sha256 === runtime.controller_digest).length === 1, 'SOURCE_REF_CARRIES_THIS_CONTROLLER_MANIFEST');
const sourceTree = api('repos/' + repository + '/git/trees/' + sourceRef.tree + '?recursive=1');
need(sourceTree.truncated === false, 'FULL_SOURCE_TREE_REQUIRED');
for (const ref of sourceRef.blobs) {
  const id = /\/([0-9a-f]{40})$/.exec(ref.uri)?.[1];
  need(hex40(id) && sourceTree.tree.some(e => e.type === 'blob' && e.sha === id), 'SOURCE_REF_BLOB_NOT_IN_SOURCE_TREE:' + ref.sha256);
  need(pubs.acceptance.tree.some(e => e.type === 'blob' && e.sha === id), 'SOURCE_REF_BLOB_MOVED_BY_ACCEPTANCE_MERGE:' + ref.sha256);
}

need(root10?.result_reviewer?.publication?.commitSha === pubs.reviewer.merge_commit, 'REVIEWER_PUBLICATION_MISMATCH');
need(root10.executor_applicability?.publication?.commitSha === pubs.executor_applicability.merge_commit, 'EXECUTOR_PUBLICATION_MISMATCH');
need(same(subject.result_reviewer_ref, root10.result_reviewer.ref), 'EXACT_ROOT10_RESULT_REVIEWER_REF');
for (const purpose of ['STATUS', 'GATE_AUTHORIZATION', 'GATE_RESULT']) {
  need(root10.issuer_qualification_refs?.[purpose]?.sha256 === qualification.issuer_qualification_sha256?.[purpose], 'EXACT_ROOT10_ISSUER_QUALIFICATION:' + purpose);
}
need(statusPayload.object_type === 'StatusManifest' && statusPayload.generation === cfg.status_generation && statusPayload.control_trust_root_generation === qualification.generation_id && statusPayload.schema_digest === subject.control_schema_refs?.StatusManifest?.sha256, 'EXACT_STATUS_PAYLOAD');
need(subject.late_bound_fields?.status_manifest_ref?.signed_payload_sha256 === digest(statusPayload), 'STATUS_ACCEPTED_SIGNING_PAYLOAD');
// 无修正案时 expected_ga 描述的就是本轮要签的 GA：控制器与资格必须**等于**当前绑定的那一套。
// （带修正案的那一版恰好相反，它要求两者不同，因为 GA 签发时绑定的是更早的控制器。）
need(hex64(expected?.controller_digest) && hex64(expected.controller_qualification_ref?.sha256), 'EXACT_FIXED_GA_RUNTIME_BINDING');
need(expected.controller_digest === runtime.controller_digest, 'FIXED_GA_NAMES_THIS_CONTROLLER');
need(expected.controller_qualification_ref.sha256 === sha(qualificationRaw), 'FIXED_GA_NAMES_THIS_QUALIFICATION');
need(expected.control_trust_root_generation === qualification.generation_id, 'EXACT_FIXED_GA_GENERATION');
need(Object.keys(expected).length === 38, 'EXACT_38_FIXED_GA_FIELDS');

// The signed GA is not a repository artifact; it lives in the control store and the driver
// takes ga_raw from the same observation the controller checks. Its fixed half is proven
// against `expected` here so a substituted GA cannot reach the entry unnoticed.
const gateRef = expected.artifact_refs?.find(ref => ref.sha256 === subject.gate?.content_digest);
need(gateRef, 'EXACT_GATE_REF');
const prerequisiteRefs = [expected.profile_ref.accepted_ref, ...expected.stage_receipt_refs, ...expected.upstream_gate_result_receipt_refs];
const uniquePrerequisites = [...new Map(prerequisiteRefs.map(ref => [ref.uri + '\0' + ref.sha256, ref])).values()];
const anywhere = ['original_source', 'ga_target', 'executor_applicability', 'acceptance', 'reviewer', 'status_manifest'];

const material = {
  operation: null,
  ga_raw: null,
  observation: null,
  runtime_acceptance: runtimeArtifact,
  controller_qualification: qualificationArtifact,
  gate_definition: descriptor(gateRef, 'gate_definition', anywhere),
  profile_signing_payload: descriptor(subject.profile_signing_payload_ref, 'profile_signing_payload', anywhere),
  prerequisite_materials: uniquePrerequisites.map((ref, i) => descriptor(ref, 'prerequisite_' + i, anywhere)),
  gate_suite: descriptor(subject.gate_suite_ref, 'gate_suite', anywhere),
  execution_scope: descriptor(expected.scope_ref, 'execution_scope', anywhere),
  result_reviewer: descriptor(subject.result_reviewer_ref, 'result_reviewer', ['reviewer'], root10.result_reviewer.publication.artifactPath),
  status_manifest: {raw: null, payload_raw: statusPayloadRaw, publication: statusArtifact.publication, store_ref: null, source_binding_sha256: null},
};

const report = {
  state: 'ROOT10_RUNTIME_CLOCK_MATERIAL_TEMPLATE_NOT_ADMISSION',
  authority_effect: 'NONE',
  qualified: false,
  controller_digest: runtime.controller_digest,
  runtime_acceptance_sha256: sha(runtimeRaw),
  controller_qualification_sha256: sha(qualificationRaw),
  publications: Object.fromEntries(Object.entries(pubs).map(([k, v]) => [k, {pr_number: v.pr_number, merge_commit: v.merge_commit, tree_sha: v.tree_sha}])),
  resolved: resolution,
  supplied_at_dispatch: ['operation', 'ga_raw', 'observation', 'host_window',
    'status_manifest.raw', 'status_manifest.store_ref', 'status_manifest.source_binding_sha256'],
};
const out = valueAfter('--out');
if (out) {
  fs.writeFileSync(out, JSON.stringify(material) + '\n', {flag: 'wx'});
  report.written = out;
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} else {
  process.stdout.write(JSON.stringify(material) + '\n');
  process.stderr.write(JSON.stringify(report, null, 2) + '\n');
}
