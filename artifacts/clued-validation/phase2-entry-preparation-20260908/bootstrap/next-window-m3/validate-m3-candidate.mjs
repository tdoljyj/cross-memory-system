#!/usr/bin/env node
// validate-m3-candidate.mjs — ExplicitOwnerApprovalM3.candidate.json 的独立校验器。
//
// 纪律要求（本轮已连续十四例「在不可能失败的条件下完成的验证」）：
// 每条断言除对真实字节运行外，还必须对一个已知坏变体运行并且失败（判别器）。
// 任一断言在真实字节上失败，或任一判别器在坏变体上没有失败，进程都以非零退出。
//
// 断言清单：
//   A1  R26-F1 字节门：JSON.stringify(JSON.parse(raw), null, 2) + "\n" 必须与文件
//       逐字节相等（库内 parseAuthenticatedAdministrativeJSON 的等价形式：任何
//       数组下标形键、非规范键序或非规范空白都会在此失败）。
//   A2  递归禁数组下标形键（如 "160"）——A1 的显名版本，报错直接点名违规键。
//   A3  占位符可枚举：硬编码清单（长度断言）== placeholders.list 声明 == 全文实际
//       出现的 __PENDING_*__ 集合，三方相等。
//   A4  载体不得含 M3 合并时间 T：全文所有 ISO 时间戳必须落在历史允许集内，且
//       不存在晚于 2026-09-13T07:05:16Z 的时间戳。
//   A5  结构钉位：window_rule、root7 代号/前代/expected_sequence、cp02 类清单、
//       forward cap 16→17 双侧、无扩权标志位。
//
// 用法：node validate-m3-candidate.mjs [candidate-path]
// 位于同目录时可不带参数。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const candidatePath = process.argv[2] ?? join(here, 'ExplicitOwnerApprovalM3.candidate.json');

// ---------------------------------------------------------------------------
// 硬编码占位符清单。改动候选件的占位符集合必须同步改这里，两处不一致即失败。
const EXPECTED_PLACEHOLDERS = [
  '__PENDING_M3_NOT_BEFORE__',
  '__PENDING_M3_EXPIRES_AT__',
  '__PENDING_M3_OWNER_MERGE_COMMIT__',
  '__PENDING_NW02_SUBJECT_SHA256__',
  '__PENDING_NW02_REGISTRATION_ACCEPTANCE_SHA256__',
  '__PENDING_NW02_STORE_ACCEPTANCE_SHA256__',
  '__PENDING_NW02_SIGNATURE_EVIDENCE_SHA256__',
  '__PENDING_ROOT7_HISTORY_PREFIX_DIGEST__',
  '__PENDING_ROOT7_ISSUER_STATUS_QUALIFICATION_URI__',
  '__PENDING_ROOT7_ISSUER_STATUS_QUALIFICATION_SHA256__',
  '__PENDING_ROOT7_ISSUER_GATE_QUALIFICATION_URI__',
  '__PENDING_ROOT7_ISSUER_GATE_QUALIFICATION_SHA256__',
  '__PENDING_ROOT7_SIGNED_OBJECT_SHA256__',
  '__PENDING_ROOT7_SIGNATURE_EVIDENCE_REF_URI__',
  '__PENDING_ROOT7_SIGNATURE_EVIDENCE_REF_SHA256__',
  '__PENDING_ROOT7_OWNER_APPROVAL_REF_URI__',
  '__PENDING_ROOT7_OWNER_APPROVAL_REF_SHA256__',
  '__PENDING_ROOT7_INDEPENDENT_ACCEPTANCE_REF_URI__',
  '__PENDING_ROOT7_INDEPENDENT_ACCEPTANCE_REF_SHA256__',
  '__PENDING_ROOT7_METADATA_BINDING_SHA256__',
  '__PENDING_ROOT7_IDEMPOTENCY_KEY__',
  '__PENDING_CP02_FROZEN_PREFIX_DIGEST_EVENTS_LE_6__',
  '__PENDING_CP02_MEASURED_ROOT_DIGEST_POST_ROOT7_REGISTRATION__',
  '__PENDING_CP02_PREIMAGE_PROSRC_SHA256_TABLE__',
  '__PENDING_CP02_UNTOUCHED_FUNCTIONS_DIGEST__',
  '__PENDING_F12_CONTROLLER_DIGEST__',
  '__PENDING_FORWARD_CAP_EXTENSION_OPINION_PATH__',
  '__PENDING_FORWARD_CAP_EXTENSION_OPINION_SHA256__',
];
const EXPECTED_PLACEHOLDER_COUNT = 28;

// 历史时间戳允许集（全部来自既往窗口的已合并/已记录材料）。
const ALLOWED_TIMESTAMPS = new Set([
  '2026-09-11T13:14:51Z', // 上上窗口 not_before
  '2026-09-12T13:14:51Z', // 上上窗口 expires_at
  '2026-09-12T07:05:16Z', // 上一窗口 not_before（cbe898d3 committed_at）
  '2026-09-13T07:05:16Z', // 上一窗口 expires_at
  '2026-09-11T10:21:05Z', // root4/root5 预算过期（钉 5 的实测引文）
]);
const LATEST_ALLOWED = '2026-09-13T07:05:16Z';

// ---------------------------------------------------------------------------
class AssertionFailure extends Error {}
const fail = (id, msg) => { throw new AssertionFailure(`${id} FAILED: ${msg}`); };

// A1 —— R26-F1 字节门。
function checkA1(raw) {
  let value;
  try { value = JSON.parse(raw); } catch (e) { fail('A1', `not JSON: ${e.message}`); }
  const reserialized = JSON.stringify(value, null, 2) + '\n';
  if (reserialized !== raw) {
    let i = 0;
    while (i < raw.length && raw[i] === reserialized[i]) i++;
    fail('A1', `byte round-trip mismatch at offset ${i}: file has ${JSON.stringify(raw.slice(i, i + 40))}, reserialization has ${JSON.stringify(reserialized.slice(i, i + 40))} — R26-F1 class (array-index-like key, key order, or whitespace)`);
  }
  return value;
}

// A2 —— 递归禁数组下标形键。
function checkA2(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((v, i) => checkA2(v, `${path}[${i}]`));
  } else if (value !== null && typeof value === 'object') {
    for (const k of Object.keys(value)) {
      if (/^(0|[1-9][0-9]*)$/.test(k)) {
        fail('A2', `array-index-like key ${JSON.stringify(k)} at ${path} — JSON.stringify would enumerate it first (R26-F1)`);
      }
      checkA2(value[k], `${path}.${k}`);
    }
  }
}

// A3 —— 占位符三方集合相等 + 长度断言。
function checkA3(raw, value) {
  if (EXPECTED_PLACEHOLDERS.length !== EXPECTED_PLACEHOLDER_COUNT) {
    fail('A3', `hard-coded list length ${EXPECTED_PLACEHOLDERS.length} !== declared count ${EXPECTED_PLACEHOLDER_COUNT}`);
  }
  const inFile = new Set(raw.match(/__PENDING_[A-Z0-9_]+__/g) ?? []);
  const declared = new Set((value.placeholders?.list ?? []).map((e) => e.placeholder));
  const expected = new Set(EXPECTED_PLACEHOLDERS);
  if (expected.size !== EXPECTED_PLACEHOLDERS.length) fail('A3', 'duplicate entry in hard-coded list');
  for (const p of expected) {
    if (!inFile.has(p)) fail('A3', `expected placeholder never occurs in file: ${p}`);
    if (!declared.has(p)) fail('A3', `expected placeholder missing from placeholders.list: ${p}`);
  }
  for (const p of inFile) if (!expected.has(p)) fail('A3', `unenumerated placeholder in file: ${p}`);
  for (const p of declared) if (!expected.has(p)) fail('A3', `placeholders.list declares unknown placeholder: ${p}`);
  if (inFile.size !== EXPECTED_PLACEHOLDER_COUNT) {
    fail('A3', `distinct placeholders in file ${inFile.size} !== ${EXPECTED_PLACEHOLDER_COUNT}`);
  }
}

// A4 —— 时间戳允许集；载体不得含 T。
function checkA4(raw) {
  const stamps = raw.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z/g) ?? [];
  for (const s of stamps) {
    if (!ALLOWED_TIMESTAMPS.has(s)) {
      fail('A4', `timestamp ${s} is not in the historical allow-list — a materialized M3 time (or any new time) must not appear in the carrier`);
    }
    if (s > LATEST_ALLOWED) fail('A4', `timestamp ${s} is later than ${LATEST_ALLOWED}`);
  }
}

// A5 —— 结构钉位。
function checkA5(v) {
  const pin = (cond, what) => { if (!cond) fail('A5', what); };
  pin(v.window_rule?.duration_seconds === 86400, 'window_rule.duration_seconds !== 86400');
  pin(v.window_rule?.rolling === false, 'window_rule.rolling !== false');
  pin(v.window_rule?.auto_renew === false, 'window_rule.auto_renew !== false');
  pin(v.window_rule?.not_before_source === 'VERIFIED_OWNER_MERGE_COMMIT_COMMITTED_AT', 'window_rule.not_before_source wrong');
  const g = v.generation_registration ?? {};
  pin(g.generation_id === 'ctrgen_26769cc7109ced40bc4016b2af678198', 'generation_registration.generation_id wrong');
  pin(g.predecessor_generation_id === 'ctrgen_5e0440a95ac8ee257b9e4236cabd275b', 'generation_registration.predecessor_generation_id wrong');
  pin(g.expected_sequence === 6, 'generation_registration.expected_sequence !== 6');
  pin(g.generation_ordinal === 7, 'generation_registration.generation_ordinal !== 7');
  pin(g.events_permitted === 1, 'generation_registration.events_permitted !== 1');
  pin(g.root_set_id === 'ctr_414bd3c724264a83894b0c55cf2ab878', 'generation_registration.root_set_id wrong');
  pin(g.new_trust_root === false && g.second_root_set === false && g.new_signing_identity === false, 'generation_registration expansion flags must all be false');
  const classes = v.cp02?.permitted_edit_classes ?? [];
  const wantClasses = [
    'BINDING_FORWARD_CAP_SERIES_F_16_TO_17',
    'SUPERSEDED_WINDOW_LITERALS_TO_THIS_WINDOW_MATERIALIZED_TIMESTAMPS',
    'FULL_ROOT_OBJECT_DIGEST_REPINNED_TO_ROOT7_POST_REGISTRATION_MEASURED_VALUES',
  ];
  pin(JSON.stringify(classes) === JSON.stringify(wantClasses), 'cp02.permitted_edit_classes differs from the plan-v2-step-3 set');
  pin(v.cp02?.additional_classes_this_draft_believes_required_but_plan_v2_step_3_does_not_name?.state === 'AWAITING_ADJUDICATION_DO_NOT_TREAT_AS_GRANTED', 'cp02 additional classes must stay marked un-granted');
  const f = v.forward_cap_extension ?? {};
  pin(f.from === 'series_f > 16' && f.to === 'series_f > 17', 'forward_cap_extension DB side must be 16 -> 17');
  pin(f.repository_side?.from === 16 && f.repository_side?.to === 17, 'forward_cap_extension repository side must be 16 -> 17');
  pin(f.covers_both_sides === true, 'forward_cap_extension.covers_both_sides !== true');
  pin(f.grants_additional_execution_capacity === false, 'forward_cap_extension must grant no capacity');
  const b = v.budget_effect ?? {};
  pin(b.new_capacity === false && b.refund === false && b.reset === false && b.automatic_retry === false, 'budget_effect must add nothing');
  pin(b.remaining_allocations_before_and_after === 1, 'remaining allocations must stay 1');
  pin(b.charged_seconds_ceiling_unchanged === 10506, 'charged_seconds ceiling must stay 10506');
  pin(b.charged_evidence_bytes_ceiling_unchanged === 2335812531, 'evidence bytes ceiling must stay 2335812531');
  const s = v.scope ?? {};
  pin(s.production_authority === false && s.paid_model_authority === false && s.scope_expansion === false, 'scope expansion flags must all be false');
  pin(v.authority_effect === 'NONE_UNTIL_VERIFIED_OWNER_MERGE', 'authority_effect wrong');
  pin(v.nw02?.temporarily_disabled_trigger === 'accepted_binding_immutable' && v.nw02?.trigger_must_be_restored_same_transaction === true, 'nw02 trigger clause wrong');
}

// ---------------------------------------------------------------------------
// 判别器：对每条断言构造一个坏变体，断言它确实失败。
// 任何一个坏变体通过校验，即整个校验器不可信，进程失败。
function mustFail(id, fn) {
  try { fn(); } catch (e) {
    if (e instanceof AssertionFailure) return `${id} rejected as expected: ${e.message.slice(0, 100)}`;
    throw e;
  }
  throw new Error(`DISCRIMINATOR ${id} DID NOT FAIL — the validator cannot fail on this axis and proves nothing`);
}

function runDiscriminators(raw) {
  const value = JSON.parse(raw);
  const out = [];

  // D1: 注入数组下标形键 "160"（R26-F1 的原始形态）→ A1 必须失败。
  out.push(mustFail('D1(A1,"160" key)', () => {
    const bad = raw.replace('"schema_version": 1,', '"确认走C": "x",\n  "160": "y",\n  "schema_version": 1,');
    checkA1(bad);
  }));
  // D2: 插入一个多余空格（字节级扰动）→ A1 必须失败。
  out.push(mustFail('D2(A1,whitespace)', () => { checkA1(raw.replace('"kind":', '"kind" :')); }));
  // D3: 深层对象里的数字形键 → A2 必须失败。
  out.push(mustFail('D3(A2)', () => {
    const bad = structuredClone(value);
    bad.cp02.root_digest_repin['7'] = 'x';
    checkA2(bad);
  }));
  // D4a: 文件中出现未枚举占位符 → A3 必须失败。
  out.push(mustFail('D4a(A3,unenumerated)', () => {
    checkA3(raw + '/* __PENDING_SOMETHING_NEW__ */', value);
  }));
  // D4b: 清单中的占位符在文件中被改名（少一个、多一个未知）→ A3 必须失败。
  out.push(mustFail('D4b(A3,renamed)', () => {
    const bad = raw.split('__PENDING_M3_NOT_BEFORE__').join('__PENDING_M3_NOTBEFORE__');
    checkA3(bad, JSON.parse(bad));
  }));
  // D5a: 注入一个实化的 M3 时间戳 → A4 必须失败。
  out.push(mustFail('D5a(A4,T leaked)', () => { checkA4(raw + ' 2026-09-14T05:00:00Z'); }));
  // D5b: 注入允许集外的历史样时间戳 → A4 必须失败。
  out.push(mustFail('D5b(A4,unlisted)', () => { checkA4(raw + ' 2026-09-12T08:13:00Z'); }));
  // D6a: expected_sequence 改为 7 → A5 必须失败。
  out.push(mustFail('D6a(A5,sequence)', () => {
    const bad = structuredClone(value);
    bad.generation_registration.expected_sequence = 7;
    checkA5(bad);
  }));
  // D6b: forward cap 偷偷放宽到 18 → A5 必须失败。
  out.push(mustFail('D6b(A5,cap 18)', () => {
    const bad = structuredClone(value);
    bad.forward_cap_extension.to = 'series_f > 18';
    checkA5(bad);
  }));
  // D6c: 草案补充类被改标成已授予 → A5 必须失败。
  out.push(mustFail('D6c(A5,granted)', () => {
    const bad = structuredClone(value);
    bad.cp02.additional_classes_this_draft_believes_required_but_plan_v2_step_3_does_not_name.state = 'GRANTED';
    checkA5(bad);
  }));
  return out;
}

// ---------------------------------------------------------------------------
let raw;
try { raw = readFileSync(candidatePath, 'utf8'); }
catch (e) { console.error(`cannot read ${candidatePath}: ${e.message}`); process.exit(2); }

try {
  const value = checkA1(raw); console.log('A1 PASS  byte-identical round-trip (R26-F1 gate)');
  checkA2(value);              console.log('A2 PASS  no array-index-like keys');
  checkA3(raw, value);         console.log(`A3 PASS  ${EXPECTED_PLACEHOLDER_COUNT} placeholders, three-way set equality`);
  checkA4(raw);                console.log('A4 PASS  all timestamps historical; no materialized M3 time');
  checkA5(value);              console.log('A5 PASS  structural pins hold');
  for (const line of runDiscriminators(raw)) console.log(`   ${line}`);
  console.log(`\nVALIDATION PASSED with all discriminators demonstrably able to fail: ${candidatePath}`);
} catch (e) {
  console.error(String(e.message ?? e));
  process.exit(1);
}
