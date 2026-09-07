#!/usr/bin/env node
// Candidate-only projection. canonical()/sha256() follow the existing G1 verifier
// (scripts/verify-generated-artifacts.mjs:560-569); its G1 PASS is never reused.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync, realpathSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
const stableBytes = value => Buffer.from(canonical(value) + '\n', 'utf8');
const START = '<!-- BEGIN CLUED PHASE2 GOVERNANCE PROJECTION -->';
const END = '<!-- END CLUED PHASE2 GOVERNANCE PROJECTION -->';
const HERE = dirname(fileURLToPath(import.meta.url));
const FACT_IDS = [
  'step4_candidate_status', 'administrative_owner', 'namespace_groups', 'domain_registry_policy',
  'step5_candidate_status', 'version_axes', 'stable_map_identity', 'new_alias_entries',
  'direct_predecessor', 'historical_namespaces_cannot_issue_current_state',
  'step6_candidate_status', 'formal_domain_id', 'formal_program_id', 'formal_stage_id',
  'consumer_count', 'consumer_bindings', 'step4_decision', 'step5_decision', 'step6_decision',
];
const OPTIONAL = new Set(['step4_decision', 'step5_decision', 'step6_decision']);

function within(root, path) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}
function sourcePath(root, name) {
  if (typeof name !== 'string' || !name || isAbsolute(name) || name.includes('\0')) throw Error('invalid relative source path');
  const path = resolve(root, name);
  if (!within(root, path) || !within(realpathSync(root), realpathSync(path)) || lstatSync(path).isSymbolicLink()) throw Error('source path escapes root or is a symlink');
  return path;
}
export function pointer(value, path) {
  if (path === '') return value;
  if (typeof path !== 'string' || !path.startsWith('/')) throw Error('invalid JSON Pointer');
  for (const encoded of path.slice(1).split('/')) {
    if (/~(?![01])/u.test(encoded)) throw Error('invalid JSON Pointer escape');
    const key = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) throw Error('missing source pointer: ' + path);
    value = value[key];
  }
  return value;
}
function sameKeys(value, expected, label) {
  if (canonical(Object.keys(value).sort()) !== canonical([...expected].sort())) throw Error(label + ' exact key set mismatch');
}

export function buildModel(bindings, sourceRoot) {
  if (bindings.format !== 'SOURCE_REFERENCE_SELECTIONS_NOT_CANONICAL_REGISTRY' || bindings.authority_effect !== 'NONE') throw Error('unsupported projection binding boundary');
  sameKeys(bindings.facts, FACT_IDS, 'fact selection');
  const sources = {};
  const sourceIdentities = {};
  for (const id of Object.keys(bindings.sources).sort()) {
    const s = bindings.sources[id];
    if (!/^[0-9a-f]{64}$/u.test(s.sha256 || '')) throw Error('invalid source digest: ' + id);
    const raw = readFileSync(sourcePath(sourceRoot, s.path));
    if (sha256(raw) !== s.sha256) throw Error('source digest drift: ' + id);
    if (s.kind !== 'json' && s.kind !== 'text') throw Error('invalid source kind: ' + id);
    sources[id] = s.kind === 'json' ? JSON.parse(raw.toString('utf8')) : raw.toString('utf8');
    sourceIdentities[id] = { path: s.path, sha256: s.sha256, kind: s.kind };
  }
  const resolveSelection = selection => {
    if (!selection || typeof selection !== 'object') throw Error('invalid source selection');
    sameKeys(selection, ['source_id','pointer'], 'source selection');
    if (!Object.hasOwn(sources, selection.source_id)) throw Error('unknown source: ' + selection.source_id);
    return pointer(sources[selection.source_id], selection.pointer);
  };
  const facts = {};
  for (const id of FACT_IDS) {
    const selection = bindings.facts[id];
    if (selection === null && OPTIONAL.has(id)) {
      facts[id] = { state: 'UNBOUND', value: null, source: null };
    } else {
      const value = resolveSelection(selection);
      facts[id] = { state: value === null ? 'SOURCE_VALUE_NULL' : 'SOURCE_VALUE_OBSERVED', value,
                    source: { ...selection, sha256: sourceIdentities[selection.source_id].sha256 } };
    }
  }
  if (!Array.isArray(facts.namespace_groups.value) || !Array.isArray(facts.version_axes.value) || !Array.isArray(facts.new_alias_entries.value) || !Array.isArray(facts.consumer_bindings.value)) throw Error('expected source collection');
  if (facts.consumer_count.value !== facts.consumer_bindings.value.length) throw Error('consumer count/source rows mismatch');
  // Read-only comparisons are data, not assertions that different source commits must match.
  const lineage = (bindings.lineage_checks || []).map(check => {
    const expected = resolveSelection(check.expected_digest);
    if (!Object.hasOwn(sourceIdentities, check.target_source_id)) throw Error('unknown lineage target');
    const actual = sourceIdentities[check.target_source_id].sha256;
    return { id: check.id, source: check.expected_digest, target_source_id: check.target_source_id,
             expected_sha256: expected, observed_sha256: actual, status: expected === actual ? 'MATCH' : 'REQUIRES_UPSTREAM_REBINDING' };
  });
  return {
    projection_status: 'PREPARATION_ONLY_NOT_STEP7_GATE', authority_effect: 'NONE',
    input_bindings_sha256: sha256(stableBytes(bindings)), sources: sourceIdentities, facts,
    lineage_checks: lineage,
    source_lineage_status: lineage.some(x => x.status !== 'MATCH') ? 'REQUIRES_UPSTREAM_REBINDING' : 'SELECTED_LINEAGE_MATCHES',
    interpretation: 'Values are deterministic source projections. Null/unbound remains null/unbound. Observed status or attached decision is not independently authenticated or upgraded by this renderer.',
    runtime_schema_or_new_global_truth: false,
  };
}

function safeCell(value) {
  const text = typeof value === 'string' ? value : canonical(value);
  return String(text).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('|','&#124;').replaceAll('`','&#96;').replaceAll('\r','\\r').replaceAll('\n','\\n');
}
export function renderBlock(model) {
  const f = id => model.facts[id].value;
  const rows = [
    ['投影性质', model.projection_status],
    ['Step 4 原状态', f('step4_candidate_status')],
    ['管理 Owner（仅任务管理）', f('administrative_owner')],
    ['Namespace 候选组数', f('namespace_groups').length],
    ['Step 5 原状态', f('step5_candidate_status')],
    ['稳定 Map', f('stable_map_identity')],
    ['本候选新增 Alias 数', f('new_alias_entries').length],
    ['架构直接前序（原引用对象）', f('direct_predecessor')],
    ['历史命名空间不得签发当前状态', f('historical_namespaces_cannot_issue_current_state')],
    ['Step 6 原状态', f('step6_candidate_status')],
    ['聚合 ID 不另行发行，见逐消费者绑定', [f('formal_domain_id'),f('formal_program_id'),f('formal_stage_id')]],
    ['来源绑定行数（不等于新运行验收数）', f('consumer_count')],
    ['Step 4 / 5 / 6 Decision 来源状态', ['step4_decision','step5_decision','step6_decision'].map(k => model.facts[k].value?.status ?? model.facts[k].state)],
    ['已选上游引用一致性', model.source_lineage_status],
  ];
  const versionRows = f('version_axes').map(axis => [axis.axis, axis.observed_or_reserved_identity]);
  return [START, '', '本区块由已绑定的治理来源生成；候选、未定和历史状态保持原含义。它不授予权限，不写入业务 Canon，不宣告接受、冻结或实现。', '',
    `来源集合摘要：\`${model.input_bindings_sha256}\`；事实模型摘要：\`${sha256(stableBytes(model))}\`。`, '',
    '| 治理事实 | 来源值 |', '|---|---|', ...rows.map(([k,v]) => `| ${safeCell(k)} | ${safeCell(v)} |`), '',
    '| 版本轴 | 来源身份 |', '|---|---|', ...versionRows.map(([k,v]) => `| ${safeCell(k)} | ${safeCell(v)} |`), '',
    '未绑定 Decision 不被解释为接受；无实际消费者证据的准备行不被解释为运行接线完成。新增 Alias 为零不证明历史或外部别名已经全量枚举。', '', END, ''].join('\n');
}

// Pure splice only; CLI never applies this function to repository files.
export function replaceGovernanceBlock(original, block) {
  if (typeof original !== 'string' || !block.startsWith(START) || !block.endsWith(END + '\n')) throw Error('invalid governance block');
  const starts = original.split(START).length - 1, ends = original.split(END).length - 1;
  if (starts !== 1 || ends !== 1) throw Error('exactly one paired governance block is required; no implicit append/whole-document rewrite');
  const start = original.indexOf(START), end = original.indexOf(END);
  if (end < start) throw Error('reversed governance markers');
  return original.slice(0,start) + block.slice(0,-1) + original.slice(end + END.length);
}

export function renderOutputs(model, preservedStatusBytes) {
  const block = renderBlock(model);
  const digest = sha256(stableBytes(model));
  const base = { projection_status: model.projection_status, authority_effect: 'NONE', facts_model_sha256: digest,
    sources: model.sources, input_bindings_sha256: model.input_bindings_sha256, source_lineage_status: model.source_lineage_status };
  const outputs = Object.fromEntries(['README.governance.md','AGENTS.governance.md','GovernanceDocs.projection.md'].map(n => [n,Buffer.from(block)]));
  const statusSource=model.sources['historical-status'];
  if (!statusSource || !Buffer.isBuffer(preservedStatusBytes) || sha256(preservedStatusBytes)!==statusSource.sha256) throw Error('exact old Status bytes required');
  const archiveTarget='docs/history/CURRENT_STATUS.before-phase2-'+statusSource.sha256.slice(0,12)+'.md';
  outputs['CURRENT_STATUS.projection.md']=Buffer.from('# Clued 当前治理状态\n\n本页只投影下列已绑定的治理来源；生产状态须查看其具体观察记录，不沿用旧文档中的过期 current 声明。\n\n'+block+'\n原状态文档按原字节保留为[历史记录]('+archiveTarget+')，不作为当前事实。此链接在正式 Step 12 保全后生效；本文件当前仅为迁移候选。\n');
  outputs['CURRENT_STATUS.history-original.md']=preservedStatusBytes;
  outputs['StatusMigrationPlan.candidate.json']=stableBytes({authority_effect:'NONE',migration_status:'NOT_EXECUTED',
    scheduled_step:12,source:statusSource,archive_target:archiveTarget,archive_sha256:statusSource.sha256,
    replacement_source:'CURRENT_STATUS.projection.md',prerequisite:'Applicable preceding gates and Step 11 Freeze; preserve original bytes before replacing the root Status.',
    readme_agents_rule:'Replace only explicitly marked governance blocks; no tutorial or business Canon edits.'});
  outputs['GovernanceManifest.projection.json'] = stableBytes({ ...base, facts: model.facts, lineage_checks: model.lineage_checks });
  outputs['GovernanceRegistry.projection.json'] = stableBytes({ ...base, entries: Object.keys(model.facts).sort().map(id => ({ id, ...model.facts[id] })), registry_scope: 'DERIVED_GOVERNANCE_VIEW_NOT_CANONICAL_REGISTRY' });
  outputs['IdentityFiles.projection.json'] = stableBytes({ ...base, identity_facts: Object.fromEntries(['version_axes','stable_map_identity','new_alias_entries','direct_predecessor'].map(k=>[k,model.facts[k]])) });
  outputs['ConsumerBindings.projection.json'] = stableBytes({ ...base, candidate_consumers: model.facts.consumer_bindings, active_binding_evidence_verified_here: false });
  for (const [name,sourceId] of [['WorkflowReferences.projection.json','workflow'],['ToolRouting.projection.json','tool-routing']]) {
    if (!model.sources[sourceId]) throw Error('required integration source missing: ' + sourceId);
    outputs[name] = stableBytes({ ...base, existing_source_ref: { source_id: sourceId, ...model.sources[sourceId] }, integration_state: 'REFERENCE_VIEW_ONLY_NOT_WIRED_OR_DEPLOYED', source_semantics_not_reinterpreted: true });
  }
  return outputs;
}

export function compareOutputs(outputs, outputRoot) {
  const mismatches = [];
  const actual = existsSync(outputRoot) ? readdirSync(outputRoot) : [];
  for (const name of actual) if (!Object.hasOwn(outputs,name)) mismatches.push({ file: name, reason: 'UNEXPECTED_OUTPUT' });
  for (const name of Object.keys(outputs).sort()) {
    const path = resolve(outputRoot,name);
    if (!existsSync(path)) mismatches.push({ file: name, reason: 'MISSING_OUTPUT' });
    else if (lstatSync(path).isSymbolicLink() || !readFileSync(path).equals(outputs[name])) mismatches.push({ file: name, reason: 'OUTPUT_DRIFT' });
  }
  return mismatches;
}

export function main(argv) {
  if (argv.length !== 5 || !['--generate','--check'].includes(argv[0])) throw Error('usage: --generate|--check BINDINGS SOURCE_ROOT OUTPUT_SUBDIRECTORY REPORT_FILENAME');
  const [mode, bindingFile, sourceRoot, outputName, reportName] = argv;
  // Candidate outputs are confined to this work directory, even if --generate is misrouted.
  const outputRoot = resolve(HERE,outputName), reportPath = resolve(HERE,reportName);
  if (!within(HERE,outputRoot) || outputRoot === HERE || dirname(outputRoot)!==HERE || !within(HERE,reportPath) || dirname(reportPath) !== HERE) throw Error('output must stay in the candidate work directory');
  if (existsSync(outputRoot) && (lstatSync(outputRoot).isSymbolicLink() || !within(realpathSync(HERE),realpathSync(outputRoot)))) throw Error('output symlink/realpath escape');
  const rawBindings = readFileSync(resolve(bindingFile));
  const model = buildModel(JSON.parse(rawBindings.toString('utf8')), resolve(sourceRoot));
  const statusSource=model.sources['historical-status'];
  if (!statusSource) throw Error('historical Status source missing');
  const outputs = renderOutputs(model,readFileSync(sourcePath(resolve(sourceRoot),statusSource.path)));
  if (mode === '--generate') {
    mkdirSync(outputRoot,{recursive:true});
    for (const [name,bytes] of Object.entries(outputs)) {
      const path=resolve(outputRoot,name);
      if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw Error('output symlink rejected');
      writeFileSync(path,bytes);
    }
  }
  const mismatches = compareOutputs(outputs, outputRoot);
  const report = { candidate_output_consistency: mismatches.length ? 'DRIFT_DETECTED' : 'EXACT_REGENERATION_MATCH',
    validation_scope: 'LOCAL_GENERATED_CANDIDATE_BYTES_ONLY', formal_step7_gate: false, authority_effect: 'NONE',
    source_lineage_status: model.source_lineage_status, upstream_mismatches: model.lineage_checks.filter(x=>x.status !== 'MATCH'),
    decision_inputs: Object.fromEntries(['step4_decision','step5_decision','step6_decision'].map(k=>[k,model.facts[k].state])),
    bindings_file_sha256: sha256(rawBindings), generator_sha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
    facts_model_sha256: sha256(stableBytes(model)), output_sha256: Object.fromEntries(Object.entries(outputs).map(([n,b])=>[n,sha256(b)])),
    mismatches, integration_claim: 'Repository files, workflow, tool routes and runtime consumers were not modified or activated.' };
  if (existsSync(reportPath) && lstatSync(reportPath).isSymbolicLink()) throw Error('report symlink rejected');
  writeFileSync(reportPath,stableBytes(report));
  process.stdout.write(JSON.stringify(report)+'\n');
  return mismatches.length ? 1 : 0;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode=main(process.argv.slice(2)); }
  catch(error) { process.stderr.write(JSON.stringify({code:'PROJECTION_CANDIDATE_INVALID',message:error.message})+'\n'); process.exitCode=1; }
}
