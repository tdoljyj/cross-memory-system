# R3-001 实施状态与差距矩阵（Gate 0 现场重建）

> 依据：`docs/r3-gate0/R3-000-baseline-receipt.json`（evidence HEAD = `9dcc31b`）
> 规则：所有结论来自真实仓库证据（`ls`/`grep`/代码阅读/命令运行），旧文档仅作历史证据；**不得因存在旧文档或旧测试文件就判定实现完成**。
> 状态轴：`已实现` / `部分实现` / `未实现(<NONE>)` / `仅文档` / `与代码偏差`

---

## 1. MIV-000 ~ MIV-009 重建

| ID | 主题 | 真实状态 | 证据 | 说明 |
|---|---|---|---|---|
| MIV-000 | 跨端记忆对象模型（object schema/status） | 已实现 | `memory_engine/schema.py`、`memory_engine/lifecycle.py`（candidate/active/reinforced/superseded/expired/deprecated/archived/rejected 状态机） | engine doctor 17 项检查 ALL PASS；objects total=230 |
| MIV-001 | 记忆写入引擎（NEW/UPDATE/SUPERSEDE 决策） | 已实现 | `memory_engine/write_engine.py` | — |
| MIV-002 | 召回引擎（T0–T4 tier） | 已实现 | `memory_engine/recall_engine.py`、`recall_trace.py` | — |
| MIV-003 | 时间语义（temporal） | 已实现 | `memory_engine/temporal.py` | — |
| MIV-004 | 冲突处理 | 已实现 | `memory_engine/conflict.py` | — |
| MIV-005A | 相关性阈值与指标 v2 | 已实现 | `ADR-MIV-005A-001-Relevance-Threshold-and-Metric-v2.md`；`memory_engine/relevance.py`；`tests/test_relevance_admission*.py` | 测试 PASS |
| MIV-005B | 词法可行性审计 + 本地 Embedding 检索决策 | 部分实现（明确范围） | `ADR-MIV-005B-001-Lexical-Feasibility-Audit.md`、`ADR-MIV-005B-002-Local-Embedding-Retrieval-Decision.md`；`memory_eval/bm25_probe.py` | **NO-GO 边界：Embedding 模型权重、依赖、probe、cache、index 全部不授权（Gate 0 指令明确禁止）**；bm25_probe 测试 PASS |
| MIV-006 | 项目作用域隔离 | 已实现 | `ADR-MIV-006-001-Project-Scope-Isolation.md`；`memory_engine/project_scope` 相关 + `tests/test_project_scope.py` | 测试 PASS |
| MIV-007 | （计划未定义/仓库无证据） | 无 | 全仓 `MIV-007` 无命中 | 计划 MIV-000~009 中 007/008/009 无对应实现，作为差距项 |
| MIV-008 | （同上） | 无 | 全仓 `MIV-008` 无命中 | 差距项 |
| MIV-009 | （同上） | 无 | 全仓 `MIV-009` 无命中 | 差距项 |

**MIV 结论**：MIV-000~006 已实现且被测试覆盖（对应测试全 PASS）；MIV-007/008/009 无证据 → 未实现。

---

## 2. Truth Integrity 原语（R3-T01~T06 前身）

| 原语 | 真实状态 | 证据 |
|---|---|---|
| truth_request | `<NONE>` | 全仓 grep `truth_request` 无命中 |
| truth_receipt | `<NONE>` | 同上 |
| claim_gate / pre-answer gate | `<NONE>` | 同上 |
| TruthPlanner / TruthProvider | `<NONE>` | 同上 |
| RepositoryTruth（ls-remote 现场核验封装） | `<NONE>` | 现有 `sync-memory.py ls_remote()` 是裸 git 调用，无 claim/evidence 绑定 |
| EvidenceBinder（TESTED_HEAD/FINAL_REPORT_HEAD 绑定） | `<NONE>` | 仓库无此模块 |
| pre_answer hook（Adapter 回答前核验） | `<NONE>` | `adapters/interface.py` 仅 6 方法（read/recall/write/update/supersede/status），无 hook |
| CURRENT_STATE_UNVERIFIED | `<NONE>` | 无此回退值 |
| agent_binding_id / manifest_digest | `<NONE>`（binding 无 digest 概念） | clued 有 binding manifest，但无 digest 绑定 claim 机制 |

**Truth 结论：Truth Integrity 双 P0 之一整体未实现（0/8 原语存在）。**

---

## 3. Distribution 原语（R3-D01~D03 前身）

| 原语 | 真实状态 | 证据 |
|---|---|---|
| artifact manifest（版本化、分类） | 部分 | `clued/manifests.py`（node/binding manifest，`NODE_SCHEMA`）；`protocol-manifest.json`（协议行为清单，非 artifact manifest） |
| download（受限、staging、单飞锁、断点、有界重试） | `<NONE>` | 无下载代码；staging 仅用于安装事务 `clued/installer.py:229` |
| allowlist（固定 revision + hash + size 白名单） | `<NONE>` | 全仓 `allowlist` 无命中 |
| verify（全量 SHA-256 校验） | 部分 | `clued/manifests.py sha256_file()` 用于自产 adapter 副本校验，非下载 artifact 校验 |
| staging + 原子切换 | 部分 | `clued/installer.py`（staging_txn）+ `clued/memory_gate.py`、`clued/paths.py`；原子切换仅限本仓文件复制 |
| rollback_release / release_id | `<NONE>` | 全仓 `rollback_release`/`release_id` 无命中；installer 有 `rollback` 事务但非 release 级 |
| offline-bundle / checksum | `<NONE>` | 无 |
| 模型 artifact 隔离 | 不适用（无模型下载） | **明确：本仓库零模型权重/依赖/缓存，Embedding 相关全部 NO-GO（§1 MIV-005B）** |

**Distribution 结论：下载-校验-白名单-发布回滚链路未实现（核心为 <NONE>），仅有自产文件 staging/sha256 的局部能力。**

---

## 4. Clued 生命周期命令真实实现

`clued/cli.py` 子命令（现场枚举）：`install auth check policy status memory sync uninstall doctor`（共 9 个）。

| 动作 | 真实状态 | 证据 |
|---|---|---|
| install | 已实现 | `clued/installer.py`；预检含 capability/protocol_version/runtime_root/staging 残留/doctor；**本环境预检 FAIL（CLD-INSTALL-001，见 receipt ENV-DEFECT-001/002）** |
| repair | `<NONE>` | CLI 无 repair 子命令；`test_artifact_tamper_repairs` FAIL 佐证 |
| update | `<NONE>` | CLI 无 update 子命令 |
| disable | `<NONE>` | CLI 无 disable；state_machine 无 DISABLED 状态 |
| enable | `<NONE>` | CLI 无 enable |
| uninstall | 已实现 | `clued/uninstaller.py`；本环境测试 11 FAIL（同因 CLD-INSTALL-001 前置于环境缺陷，非 uninstall 自身逻辑在干净环境下的结论） |
| auth | 已实现 | `clued/auth/`（engine/provider/fake）；`test_clued_auth` PASS 18/18 |
| doctor | 已实现 | `clued/controller.py`；本环境 1 FAIL（refs/remotes） |
| status/memory/sync/policy/check | 已实现 | CLI 枚举 + `test_clued_unit` PASS 27/27 |

**Lifecycle 结论：六动作仅 install/uninstall 存在；repair/update/disable/enable 缺失 → R3-L01~L04 大部分未实现。**

---

## 5. 三轴状态模型现状

| 轴 | 现状 | 证据 |
|---|---|---|
| Binding 生命周期轴 | 11 态：UNINSTALLED/INSTALLING/AUTH_REQUIRED/ONLINE_SYNCED/ONLINE_DIRTY/DEGRADED_LOCAL/RECOVERING/CONFLICT_REVIEW/LOCKED/UNINSTALLING/INSTALL_ERROR | `clued/state_machine.py`（ALLOWED_TRANSITIONS + TRANSITION_EVENTS 完整） |
| 会话/同步轴 | ONLINE/DEGRADED/LOCKED 语义在生命周期态内表达 | 同上 |
| Truth 能力轴（UNAVAILABLE→ADVISORY→AUDIT→ENFORCED） | **不存在** | 全仓 `ENFORCED`/`ADVISORY`/`AUDIT_MODE` 无代码命中；`capability` 命中为 auth 能力探测（gh 可用性），非 Truth 能力 |

**关键差距：INSTALLED ≠ ENFORCED 的语义在代码中不存在；DISABLED/UNINSTALLED 与 ENFORCED 的互斥规则未建模。**

---

## 6. Adapter 合同与 capability

| 项 | 真实状态 | 证据 |
|---|---|---|
| `adapters/interface.py` | 已实现（6 抽象方法 read/recall/write/update/supersede/status） | 44 行；注释声明"Adapter 不得直改 Canonical Store" |
| `adapters/cli_adapter.py` | 已实现（CLI 适配器） | — |
| pre-answer hook / claim gate 接口 | `<NONE>` | 接口无 hook 方法 |
| capability 状态（UNAVAILABLE/ADVISORY/AUDIT/ENFORCED 上报） | `<NONE>` | auth/engine.py 的 UNAVAILABLE 是网络可用性，非 Truth 能力 |
| 协议版本一致性 | **偏差** | `protocol-manifest.json` 声明 `protocol_version: vNext-1.3`，`VERSION` 文件 = `vNext-2.0`，clued 运行时 `protocol_version: 0.3.0` → **三处版本号不一致** |

---

## 7. 既有生命周期协议 / LKG / Pending / Recovery / Uninstall 真值

| 项 | 真值 |
|---|---|
| 既有协议（Sync） | `protocol-manifest.json` 行为矩阵 + `sync-memory.py/ps1`；模式 pull/push/doctor/bootstrap |
| LKG 策略 | `ADR-CLD-001/002/003`（LKG Max-Age-One-Hour、LOCKED→Recovery、Policy Profiles）——**历史文档**；当前代码 `memory_engine/lifecycle.py` 无 1h/6h 常量；**文档与代码存在偏差，计划要求只报告冲突不自行选择** |
| Pending 机制 | `clued/pending_journal.py` 已实现（degraded 写日志）；测试 15 FAIL（环境缺陷级联，非逻辑否决） |
| Recovery | `clued/recovery.py` + `tests/test_clued_recovery_crash.py`；测试 13 FAIL（同因） |
| Uninstall | `clued/uninstaller.py`；测试 11 FAIL（同因） |

**注意**：clued 系测试的 FAIL 全部可归因 ENV-DEFECT-001/002（install 预检被环境阻断），**不代表干净环境下逻辑失败**；干净环境验证属 Gate 2 临时 home 范围。

---

## 8. 旧报告与当前代码偏差清单

| 旧材料 | 偏差 |
|---|---|
| 旧记忆称 HEAD=14854e39 / vNext-1.3 | **被现场证据推翻**：HEAD=9dcc31b，VERSION=vNext-2.0（receipt §live_repository_truth） |
| `.gate-t0-workspace/baseline-receipt-pre.json`（Gate T0 遗留） | local_head=null、memory 232 文件 hash c8512516…——与本次 238 文件 / 6da7e366… 不同（中间有合法记忆写入）；该 receipt 是 partial，仅作历史证据 |
| ADR-CLD-001/002/003（1h/6h LKG 策略） | 当前代码无对应常量/实现 → 文档超前于代码 |
| `Clued_v0.1_…弱网降级与卸载协议.md` | 协议文档 v0.1 vs 运行时 protocol_version 0.3.0 → 文档滞后 |

---

## 9. 结论摘要

- **Truth Integrity：未实现（0/8 原语）** — 最大 P0 差距，Gate 1 R3-T01~T06 全量待建。
- **Distribution：核心未实现**（下载/allowlist/发布回滚 <NONE>；staging/sha256 仅局部）。
- **Lifecycle：install/uninstall/auth/doctor 存在，repair/update/disable/enable 缺失；三轴模型仅第一轴实现；Truth 能力轴不存在。**
- **环境缺陷（ENV-DEFECT-001/002）** 使 60 项测试 FAIL、doctor 恒 1 FAIL —— 属基线环境事实，Gate 2 需在无 overlay/临时 home 环境完成 e2e。
- **版本号三处不一致**（protocol-manifest vNext-1.3 / VERSION vNext-2.0 / clued 0.3.0）需在 Gate 1 统一。
