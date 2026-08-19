# ADR-R3-002：Truth Integrity（真值完整性）合同

- **状态**：DRAFT（Gate 0 冻结用，未实施）
- **绑定**：`docs/r3-gate0/R3-000-baseline-receipt.json`（evidence HEAD = `9dcc31b`）
- **范围**：冻结四类事实模型、claim types 与 source precedence、Truth Request/Receipt、现场核验算法、Validation Evidence Binder、Claim Gate、LKG 与 current 区分、Adapter/Installer 边界、feature flag 与迁移回滚、ADVISORY/AUDIT/ENFORCED 判定。
- **状态轴说明**：本 ADR 是**合同**，不是实现声明。任何实现均须以本 ADR 为契约并在对应 Gate 提供测试证据；在此之前系统只能声明为 ADVISORY 或 AUDIT，不得声明 ENFORCED。

---

## 1. 四类事实模型（fact kinds）

一切可被回答引用的"当前状态"必须是四类之一：

| Kind | 定义 | 示例 | 新鲜度要求 |
|---|---|---|---|
| `stable` | 一经发布不随日常操作改变，由发布动作固化 | manifest schema、协议版本、`VERSION` 文件、tag 指向 | 绑定发布 revision |
| `historical` | 过去某时点的事实，永不变更 | 某次验收的 TESTED_HEAD、旧报告结论、某 Gate 的 receipt | 绑定当时 HEAD + 时间戳，禁止改写 |
| `current` | 现在时的可变事实，回答"当前"问题唯一可引用类型 | 当前 local HEAD、当前 remote HEAD、当前 push 状态、当前安装状态 | 每问必核（见 §4 现场核验） |
| `mixed` | 同时含 stable/historical/current 的复合陈述 | "当前版本 vNext-2.0（stable）在 HEAD 9dcc31b（current）上通过 245 项测试（historical，绑定 TESTED_HEAD）" | 逐成分按各自规则 |

**守恒规则**：`current` 事实**不得**从记忆、旧报告、注入 profile 或会话历史推导；只能由现场证据（repository truth provider 的输出）产生。无法现场核验时输出 `CURRENT_STATE_UNVERIFIED`，不得输出猜测值。

## 2. Claim Types 与 Source Precedence

### 2.1 Claim types（与计划 R3-T01 对齐）

| claim type | 说明 | 证据形态 |
|---|---|---|
| `REPO_LOCAL_HEAD` | 本地 HEAD | receipt 绑定 evidence HEAD |
| `REPO_REMOTE_HEAD` | 远端 origin/main | ls-remote 输出 + verified_at |
| `REPO_BASELINE` | Gate 基线（head/relation/时间） | 一次性 receipt（本 ADR 即引 receipt） |
| `REPO_TOPOLOGY` | 受限拓扑（分支/标签存在性） | ls-remote / tag 枚举 |
| `REPO_WORKTREE` | worktree/index/untracked 状态 | git status --porcelain 现场输出 |
| `REPO_PUSH_STATUS` | 本地 vs 远端 ahead/behind | `git rev-list --left-right --count` 现场输出 |
| `PRODUCT_VERSION` | VERSION 文件 / 发布版本 | 文件内容 + 所在 HEAD |
| `VALIDATION_DECISION` | 验收判定（PASS/NO-GO/PARTIAL） | 绑定 FINAL_REPORT_HEAD 的报告 |
| `TEST_INVENTORY` | 测试文件清单 | 文件枚举 hash |
| `TEST_RESULT` | 测试运行结果（PASS/FAIL/SKIP 计数） | test-run.json + 运行命令 |
| `IMPLEMENTATION_PHASE` | 当前实施阶段（Gate 序号） | receipt/报告锚定 |
| `LIFECYCLE_STATE` | Binding 生命周期态 | clued state machine 状态文件 |
| `INSTALLED_ARTIFACT_VERSION` | 已安装 artifact 版本 | binding manifest digest |
| `CAPABILITY_ENFORCEMENT` | Truth 能力档位（ADVISORY/AUDIT/ENFORCED） | capability 记录 + conformance 证据 |
| `HISTORICAL_STATUS` | 过去状态（只读引用） | 历史 receipt/报告锚定其当时 HEAD |

### 2.2 Source precedence（同一事实多来源冲突时）

```
现场证据（repository truth provider / doctor / test 运行）      → 最高
本 Gate receipt（evidence-bound）                               → 次高
代码仓库内 ADR / 报告（锚定其声明时的 HEAD）                    → 仅历史
注入记忆 / USER.md / 会话记忆 / 旧对话摘要                      → 不可作 current 证据（只能作线索）
```

冲突处理：`current` 类一律现场重取；`historical` 类以绑定 HEAD 最新者为准并在报告标注；`stable` 类以发布 revision 为准；`mixed` 逐成分裁决。不可裁决 → `CURRENT_STATE_UNVERIFIED` + reason code。

## 3. Truth Request / Receipt

### 3.1 Truth Request（查询方 → Provider）

```
{
  "schema_version": 1,
  "request_id": "<uuid>",
  "claim_types": ["REPO_LOCAL_HEAD", "REPO_REMOTE_HEAD"],
  "context": {
    "agent_binding_id": "<binding-uuid>",   // 安装单位 = Agent Binding（非物理设备）
    "operation": "answer_current_state",
    "requested_at_utc": "<ISO8601>"
  },
  "mode": "verify" | "record" | "verify_or_record",
  "allow_unverified_fallback": false          // ENFORCED 下必须 false
}
```

### 3.2 Truth Receipt（Provider → 请求方）

```
{
  "schema_version": 1,
  "receipt_id": "<uuid>",
  "request_id": "<回声>",
  "claims": [
    {
      "claim_type": "REPO_REMOTE_HEAD",
      "value": "9dcc31be2b7f32f3199cfbd44e138d161fc0cfdb",
      "evidence": {"method": "git ls-remote origin main", "verified_at_utc": "...", "source": "live"},
      "status": "VERIFIED" | "UNVERIFIED" | "STALE",
      "reason_code": null | "REMOTE_UNREACHABLE" | "NO_LOCAL_REPO" | ...
    }
  ],
  "verdict": "CURRENT_STATE_VERIFIED" | "CURRENT_STATE_UNVERIFIED",
  "bound_evidence_head": "<HEAD 或 null>",
  "receipt_digest": "<sha256 of canonical fields>"     // 防篡改
}
```

**Receipt 规则**：每次核验颁发一次性 receipt；同 operation 同请求可复用（same-operation reuse）仅当 cache 窗口 ≤ 5s 且环境未变；receipt 必须可离线校验（自含 digest）。

## 4. 现场核验算法（Repository Truth Provider）

对每个 `current` claim 执行：

1. **本地取证**：`git rev-parse HEAD`、`git status --porcelain`、`git rev-list --left-right --count HEAD...origin/main`；
2. **远端取证**：`git ls-remote origin main`（记录 verified_at_utc，禁止从缓存/记忆取远端值）；
3. **绑定**：所有值写入 receipt，绑定 `bound_evidence_head = 本地 HEAD`；
4. **交叉校验**：receipt 内值必须互相一致（如 local==remote 时 ahead/behind 必为 0/0）；不一致 → 全部标 UNVERIFIED；
5. **输出**：receipt + verdict；无法取远端 → 远端 claim UNVERIFIED + `REMOTE_UNREACHABLE`，同时 **只能报告"最后一次已验证状态"**，不得表述为当前事实；
6. **Doctor 门禁**：现场 doctor 有 FAIL 时（如 ENV-DEFECT-001），current 类结论降级为 UNVERIFIED/ADVISORY，禁止在 FAIL 状态下颁发 ENFORCED 级结论。

**环境缺陷处置**：本机 refs/remotes 写故障（ENV-DEFECT-001）下，tracking ref 不可作为证据（AUTO-HEALED 是进程内假阳性）；一律以 ls-remote 现场输出为准，不信任本地 tracking ref 文件。

## 5. Validation Evidence Binder（验收证据绑定）

目标：任何"测试通过/验收通过"结论必须绑定四个 HEAD 且关系合法。

```
target_head     = 被验收提交
tested_head     = 测试实际运行的提交（= target_head，测试必须运行在干净 worktree）
final_report_head = 报告所在提交
evidence_head   = 报告引用的 receipt 证据基线（= receipt.bound_evidence_head）

合法：tested_head == target_head；evidence_head 指向 tested_head 所在历史；final_report_head 晚于 tested_head 且报告内自述。
非法：tested_head != target_head；报告引用无 receipt 的 current 值；final_report_head 早于 tested_head。
```

Binding 数据结构（作为 receipt 扩展）：

```
"evidence_binding": {
  "target_head": "...", "tested_head": "...",
  "final_report_head": "...", "evidence_head": "...",
  "test_inventory": {"file_count": 16, "sha256": "..."},
  "test_result": {"PASS": 245, "FAIL": 60, "SKIP": 31, "ERROR": 0, "driver": "run_tests.py"}
}
```

## 6. Claim Gate（回答前门禁）

回答含任何 `current` 类陈述前，Claim Gate 依次检查：

1. **有 receipt**：该 claim 存在有效 receipt；无 → 阻断或改写为 `CURRENT_STATE_UNVERIFIED`；
2. **receipt 新鲜**：created_at 距今 ≤ 阈值（current 类默认 60s，可通过 feature flag 收紧）；超时 → 重新核验；
3. **receipt 未篡改**：digest 校验通过；
4. **能力匹配**：claim 来源能力 ≤ 当前 capability 档（§9），ENFORCED 档禁止 UNVERIFIED claim 成功返回；
5. **成功返回率**：current claim 无有效 receipt 的成功返回必须为 0（§18 成功定义）。

被拦截时输出：
```
{"status": "CURRENT_STATE_UNVERIFIED", "reason": "no_valid_receipt|stale|tampered|capability_mismatch", "request_id": "..."}
```

## 7. LKG 与 current 的区别

| | LKG（Last Known Good） | current |
|---|---|---|
| 定义 | 最后一次**已验证**状态（receipt 有效） | 现在时的现场状态 |
| 引用条件 | 现场核验失败、网络不可达、环境异常 | 正常核验路径 |
| 标签 | 必须显式标注 `LKG` + 其 verified_at + 来源 receipt | 直接引用 |
| 禁止 | LKG 不得伪装为 current；不得在 ENFORCED 档将 LKG 当 current 返回 | — |

LKG 存储：receipt 历史（或 `LKG` receipt 类型），可被 `REPO_BASELINE`/`HISTORICAL_STATUS` claim 引用；ADR-CLD-001/002/003 的 1h/6h 策略属 LKG 新鲜度策略，本 ADR 不覆盖其取舍（由协议升级流程裁决）。

## 8. Adapter / Installer 边界

- **Adapter**：只调用 Truth Provider 与 Claim Gate 的公开接口（query → receipt → gate）；**不得直接执行 git、不得自判 PASS**；`adapters/interface.py` 须扩展 pre-answer hook 与 capability 上报方法（Gate 2 R3-T06 实现，本 ADR 只冻结合同）。
- **Installer**：负责 Binding 安装事务与 capability 写入；安装前必须运行 Doctor + Truth conformance；**不得**在预检失败时写入 ACTIVE。
- **Core vs Adapter**：真值规则与生命周期规则属 Core；Adapter 只调用和执行门禁。

## 9. Feature flag、迁移与回滚

- 引入 `truth_integrity` feature flag（默认 off，Gate 2 在临时 home 环境全量 e2e 后按 Binding 灰度）；
- 迁移路径：`legacy（无 receipt）→ ADVISORY（有 receipt 但无 enforcement）→ AUDIT（gate 只读记录不阻断）→ ENFORCED（gate 全量执行）`；
- 回滚：任何 Gate 内证据冲突 / 阻断条件触发即回退该 Binding 到上一档，并记录 reason code；不回退到"无记录"状态（LKG 保留）；
- 版本变化：claim type 集合变更走协议升级（manifest 先行），不得直接改代码。

## 10. ADVISORY / AUDIT / ENFORCED 判定

| 档位 | 判定条件（全部满足才可升级） |
|---|---|
| `UNAVAILABLE` | 无 receipt 能力 / 无 Binding |
| `ADVISORY` | 有 Provider+Receipt 实现；current 结论可附 LKG；无 claim gate 阻断；**对外必须标 PARTIAL** |
| `AUDIT` | 有 Claim Gate（只读记录，不阻断）；capability conformance 通过；Doctor ALL PASS |
| `ENFORCED` | 在 **AUDIT 模式**下证明：无有效 receipt 的 current claim 成功返回 = 0；fault injection 全绿；Doctor ALL PASS；manifest 完整；capability conformance 全过；**且当前系统满足 §18 全部条件** |

**不可达组合**：`INSTALLED 但 ENFORCED 证据不足` → 只能标 ADVISORY/AUDIT；`DISABLED/UNINSTALLED` → 不得保留 ENFORCED（与 ADR-R3-003 三轴模型联动）。旧 Adapter 不得伪装强制档位。

---

## 11. 验收映射（Gate 1/2 范围）

- R3-T01 Truth Planner → §1/§2（四类事实、claim types、precedence）
- R3-T02 Repository Truth Provider → §4（现场核验算法）
- R3-T03 Validation Evidence Binder → §5
- R3-T04 Truth Receipt Issuer/Validator → §3
- R3-T05 Claim Gate → §6
- R3-T06 Adapter 公共合同 → §8 + interface 扩展
- 测试：`docs/r3-gate0/R3-004-test-design.md` MUST-T-* 系列
