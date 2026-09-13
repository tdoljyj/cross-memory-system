#!/usr/bin/env node
// round32-prepared-edits.mjs -- Round 32 裁定的四处候选件编辑 + validator 同步，备妥未施加。
//
// 背景：Round 32 独立评审（Round32Review.md）复核 M3AdjudicationsRound1.md 全部裁定成立，
// 但施加动作在评审会话内被权限系统以 Self-Approval 拦截（评审会话不应自行翻转
// AWAITING 状态、不应把自己出具的意见件自行回填为「独立意见」）。本脚本把全部编辑
// 固化为可一步执行、逐处断言现值、执行后自动重跑 validator 的形式，供 Owner 或其
// 明示授权的会话运行。幂等：重复运行时现值断言会失败并明说已施加。
//
//   node round32-prepared-edits.mjs          # 施加编辑并重跑 validator
//
// 编辑清单（候选件 ExplicitOwnerApprovalM3.candidate.json）：
//   E1  cp02.additional_classes...state: AWAITING_ADJUDICATION_DO_NOT_TREAT_AS_GRANTED
//       -> ADJUDICATED_REQUIRED_AND_GRANTED（依据 M3AdjudicationsRound1 #1 + Round 32 复证）
//   E2  nw02.ordering 次序钉：NW-02 先于 root7 注册（M3AdjudicationsRound1 #5）
//   E3  forward_cap_extension.independent_opinion_ref 回填为
//       ForwardCapExtensionIndependentOpinion16To17.json（path + 实测 sha256）
//   E4  placeholders.list 移除两个 FORWARD_CAP 占位（28 -> 26）
// validator（validate-m3-candidate.mjs）同步：
//   V1  EXPECTED_PLACEHOLDERS 移除两项；EXPECTED_PLACEHOLDER_COUNT 28 -> 26
//   V2  A5：D6c 期望反转为 ADJUDICATED_REQUIRED_AND_GRANTED；加 nw02 次序钉；
//       加意见件 path 钉 + sha256 对文件字节实测
//   V3  判别器：D6c 坏变体改为「状态被退回 AWAITING」；新增 D6d「意见件摘要被改」
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CAND = path.join(here, 'ExplicitOwnerApprovalM3.candidate.json');
const VAL = path.join(here, 'validate-m3-candidate.mjs');
const OPINION_REL = 'artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/next-window-m3/ForwardCapExtensionIndependentOpinion16To17.json';
const OPINION_ABS = path.join(here, 'ForwardCapExtensionIndependentOpinion16To17.json');

const must = (cond, msg) => { if (!cond) throw new Error('PRECONDITION: ' + msg); };
const opinionSha = crypto.createHash('sha256').update(fs.readFileSync(OPINION_ABS)).digest('hex');
must(opinionSha === '4b1aab9d49eae48904ef899661d58e65b6eac93a6fc7cc07ead1d3d23d171880',
  'opinion file bytes changed since Round 32 issued it (' + opinionSha.slice(0, 12) + '); re-adjudicate before applying');

// ---- 候选件编辑
const v = JSON.parse(fs.readFileSync(CAND, 'utf8'));
const blk = v.cp02.additional_classes_this_draft_believes_required_but_plan_v2_step_3_does_not_name;
must(blk.state === 'AWAITING_ADJUDICATION_DO_NOT_TREAT_AS_GRANTED', 'E1 already applied or state drifted: ' + blk.state);
blk.state = 'ADJUDICATED_REQUIRED_AND_GRANTED';
blk.rule = 'ADJUDICATED: all three classes are REQUIRED and are authorized as CP-02 edit classes on equal footing with permitted_edit_classes, under the same discipline and prohibitions. Basis: M3AdjudicationsRound1.md item 1 (plan author, cp01 byte evidence) independently re-verified by Round 32 (Round32Review.md) -- cp01-substitutions.json from/to strings re-read, live store re-measured (89 events, every BUDGET_RESERVED sequence <= 85, post-baseline budgets exactly 8, so the ninth lands >= 90 with root7 and the new expiry), and the F12 schema digest 7e5df5dd re-measured from the tree. Plan v2 step 3 was an omission, not an exclusion.';

must(v.nw02.ordering === undefined, 'E2 already applied');
const nw = {};
for (const [k, val] of Object.entries(v.nw02)) {
  nw[k] = val;
  if (k === 'fail_closed_on_mismatch') nw.ordering = {
    nw02_before_generation_registration: true,
    why: 'plan v2 already fixes the sequence (step 4 NW-02 before step 6 root7 registration); M3AdjudicationsRound1.md item 5 ruled the order into this carrier, and Round 32 pins it as a hard clause so the order cannot drift silently.'
  };
}
v.nw02 = nw;

const ref = v.forward_cap_extension.independent_opinion_ref;
must(ref.path === '__PENDING_FORWARD_CAP_EXTENSION_OPINION_PATH__', 'E3 already applied: ' + ref.path);
ref.path = OPINION_REL;
ref.sha256 = opinionSha;
ref.note = 'issued by Round 32 (independent of plan author and drafting session H); validate-m3-candidate.mjs A5 verifies this sha256 against the file bytes, so any later edit to the opinion refuses here until re-adjudicated. The round 9 opinion (15-to-16) was cited by the merged NW-01 carrier at a path that never existed in the repository (Round32Review.md R32-F3) -- this ref is anchored by digest precisely so that cannot recur.';

const dropped = ['__PENDING_FORWARD_CAP_EXTENSION_OPINION_PATH__', '__PENDING_FORWARD_CAP_EXTENSION_OPINION_SHA256__'];
const before = v.placeholders.list.length;
v.placeholders.list = v.placeholders.list.filter(e => !dropped.includes(e.placeholder));
must(v.placeholders.list.length === before - 2, 'E4: expected exactly two entries to drop');

fs.writeFileSync(CAND, JSON.stringify(v, null, 2) + '\n');
console.log('candidate: E1-E4 applied (placeholders ' + before + ' -> ' + v.placeholders.list.length + ')');

// ---- validator 同步（逐处断言旧文本恰出现一次）
let t = fs.readFileSync(VAL, 'utf8');
const sub = (from, to, label) => {
  const n = t.split(from).length - 1;
  must(n === 1, 'V-edit "' + label + '": expected exactly 1 occurrence, found ' + n);
  t = t.split(from).join(to);
};
sub("  '__PENDING_FORWARD_CAP_EXTENSION_OPINION_PATH__',\n  '__PENDING_FORWARD_CAP_EXTENSION_OPINION_SHA256__',\n", '', 'V1 list');
sub('const EXPECTED_PLACEHOLDER_COUNT = 28;', 'const EXPECTED_PLACEHOLDER_COUNT = 26;', 'V1 count');
sub("pin(v.cp02?.additional_classes_this_draft_believes_required_but_plan_v2_step_3_does_not_name?.state === 'AWAITING_ADJUDICATION_DO_NOT_TREAT_AS_GRANTED', 'cp02 additional classes must stay marked un-granted');",
  "pin(v.cp02?.additional_classes_this_draft_believes_required_but_plan_v2_step_3_does_not_name?.state === 'ADJUDICATED_REQUIRED_AND_GRANTED', 'cp02 additional classes must carry the Round-32 adjudicated state, nothing else');\n  pin(v.nw02?.ordering?.nw02_before_generation_registration === true, 'nw02 must pin NW-02 before root7 registration (M3AdjudicationsRound1 item 5)');\n  {\n    const r = v.forward_cap_extension?.independent_opinion_ref ?? {};\n    pin(r.path === 'artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/next-window-m3/ForwardCapExtensionIndependentOpinion16To17.json', 'forward cap opinion path wrong');\n    let actual;\n    try { actual = createHash('sha256').update(readFileSync(join(here, 'ForwardCapExtensionIndependentOpinion16To17.json'))).digest('hex'); }\n    catch (e) { fail('A5', 'forward cap opinion file unreadable: ' + e.message); }\n    pin(r.sha256 === actual, 'forward cap opinion sha256 does not match the file bytes on disk');\n  }",
  'V2 A5');
sub("import { readFileSync } from 'node:fs';", "import { readFileSync } from 'node:fs';\nimport { createHash } from 'node:crypto';", 'V2 import');
sub("  // D6c: 草案补充类被改标成已授予 → A5 必须失败。\n  out.push(mustFail('D6c(A5,granted)', () => {\n    const bad = structuredClone(value);\n    bad.cp02.additional_classes_this_draft_believes_required_but_plan_v2_step_3_does_not_name.state = 'GRANTED';\n    checkA5(bad);\n  }));",
  "  // D6c: 已裁定状态被退回 AWAITING（或改成任何其它值）→ A5 必须失败。\n  out.push(mustFail('D6c(A5,state reverted)', () => {\n    const bad = structuredClone(value);\n    bad.cp02.additional_classes_this_draft_believes_required_but_plan_v2_step_3_does_not_name.state = 'AWAITING_ADJUDICATION_DO_NOT_TREAT_AS_GRANTED';\n    checkA5(bad);\n  }));\n  // D6d: 意见件摘要与文件字节不符 → A5 必须失败。\n  out.push(mustFail('D6d(A5,opinion sha)', () => {\n    const bad = structuredClone(value);\n    bad.forward_cap_extension.independent_opinion_ref.sha256 = '0'.repeat(64);\n    checkA5(bad);\n  }));",
  'V3 discriminators');
fs.writeFileSync(VAL, t);
console.log('validator: V1-V3 applied');

// ---- 施加后立即重跑 validator，任何失败都视为本脚本失败
const out = execFileSync(process.execPath, [VAL], {encoding: 'utf8'});
process.stdout.write(out);
must(/VALIDATION PASSED/.test(out), 'validator did not pass after edits');
console.log('round32 prepared edits: applied and re-validated.');
