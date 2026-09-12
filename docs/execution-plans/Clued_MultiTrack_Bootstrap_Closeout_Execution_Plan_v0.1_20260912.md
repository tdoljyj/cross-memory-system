# Clued Multi-Track Bootstrap Closeout Execution Plan v0.1

**Plan ID:** `CLUED-MULTITRACK-BOOTSTRAP-CLOSEOUT-PLAN-v0.1-20260912`  
**Target Item:** `E-008 Multi-Track Bootstrap Governance / Current Governance Inventory`  
**Status:** `EXECUTION PLAN CANDIDATE / H0-BIASED / NOT AUTHORITY`  
**Authority effect:** `NONE`

> 本计划是已冻结 Multi-Track v0.2.1 的 Execution Plan Generation Layer 第一次正式 dogfood。它负责“怎样以最低必要成本验收 E-008 Bootstrap”，不是 SDD Technical Plan，也不创建生产 Authority。

## 第一步：验收清单

当前范围是 **Bootstrap Governance Projection / Inventory Closeout**，不是 Multi-Track Runtime MVP。当前信息足以执行大部分 P0；未知项集中在 GitHub Actions runner 启动原因和 fresh-context independent reviewer executor。最低必要假设只有：Repository / Supabase 只读证据可继续使用；任何不能独立证明的状态保持 UNKNOWN/BLOCKED，不影响无关路径。

| 编号 | 类型 | 名称 | 优先级 | 所需证据 |
|---|---|---|---|---|
| `A01` | Identity | Bootstrap Snapshot / Inventory 精确身份 | P0 | Snapshot ID、branch、blob SHA、source registry |
| `A02` | Coverage | 四轨与 49 Item 完整登记 | P0 | `current.json`、`tracks.md` |
| `A03` | Provenance | 49/49 Source / Derivation Chain | P0 | `source-registry.json` exact refs/SHA |
| `A04` | Authority | Projection ≠ Authority / fail-closed | P0 | Authority contract + negative assertions |
| `A05` | Currentness | Repository drift 与 Canonical currentness 分离 | P0 | projection watermark + currentness assessment |
| `A06` | Zero-Memory | 25/25 Structural Safe-Answer Coverage | P0 | `zero-memory-preflight.md` |
| `A07` | Priority | Current Frontier / dependency / blocker / impact / resource consistency | P0 | frontier、cross-track、bootstrap context |
| `A08` | Dynamic Governance | 新发现不产生无意义 priority churn | P0 | Bootstrap Priority Diff |
| `A09` | Repository | branch 与 current main 同步且无治理路径冲突 | P0 | compare result / merge ancestry |
| `A10` | Independent Review | fresh-context 只读独立复核 | P0 | exact target + independent review output |
| `A11` | CI / Delivery | PR 检查实际启动并给出可解释结论 | P0 for Merge；not P0 for read-only Bootstrap analysis | workflow/job evidence |
| `A12` | Closeout | Bootstrap Inventory Freeze Eligibility Decision | P0 | A01–A10；Merge 另需 A11 |
| `A13` | Runtime | ≥3 Agent Runtime Zero-Memory Gate | P1 / 后续 Runtime MVP | legal test identity + currentness + runtime |
| `A14` | Runtime | PriorityReconciliation / Replan Runtime | P1 / 后续 Runtime MVP | real registry/receipt |
| `A15` | Productization | 印记空间 / 用户多轨产品化 | P2 | Product Runtime + Multi-Track Runtime |

## 第二步：P0 验收步骤

| 步骤编号与名称 | 验收目标 | 对应清单编号 | 前置条件 | 执行动作 | 通过标准 | 失败处理 | 结果留存 | 并行属性 | 完成判定 |
|---|---|---|---|---|---|---|---|---|---|
| `P0-01 Exact Identity & Coverage` | 确认 Bootstrap 精确对象与清单完整 | A01,A02 | Git branch 可读 | 读取 `current.json`、Track 清单、Item count、Snapshot ID | 四轨存在；49 Item 可唯一解析；无重复 Item ID；Snapshot identity 唯一 | 修正 Projection 后重新生成 Watermark；不改 Canonical | Snapshot + compare evidence | 可并行 | deterministic PASS |
| `P0-02 Source Registry` | 每项都能回答“依据什么” | A03 | Library / repo exact sources 可读 | 校验 49/49 item_source_map；校验登记 SHA/Ref；Receipt 缺失必须显式 | coverage=49/49；无空 primary_source；missing Receipt 不写成 PASS | 仅补缺失 Source binding；无法获取 Receipt 标 pending | `source-registry.json` | 可并行 | 49/49 PASS |
| `P0-03 Authority Boundary` | 保证 Repository 不扩权 | A04 | Authority contract 可读 | 检查 Binding→Membership→Grant→Resource×Action→Currentness 链；检查 Repository-only default | `repository_grants_authority=false`；未认证 side-effect actions=[]；READY/Assignment 不等于 Authority | 修复 Projection wording/schema；禁止建第二 IAM | contract + negative checks | 可并行 | fail-closed PASS |
| `P0-04 Currentness / Drift` | 区分 Projection 完整性和上游 Currentness | A05 | Watermark / currentness assessment 可读 | 比较 tracked blob SHA；检查 Currentness state | Projection blob 全匹配；upstream 未证明时必须 `UNKNOWN`，不得 `CURRENT` | regenerated watermark；上游未知保持 fail-closed | watermark + assessment | 可并行 | integrity PASS + honest UNKNOWN allowed |
| `P0-05 Zero-Memory Structural Recovery` | 所有标准恢复问题有安全答案 | A06 | P0-01..04 结构可读 | 按 ZM01–ZM25 机器合同逐项解析 | `25/25 safe-answer coverage`；UNKNOWN/NOT_IMPLEMENTED 可作为正确答案 | 修复缺失字段/入口；不造 Runtime | preflight report | 可并行 | 25/25 structural PASS |
| `P0-06 Priority Graph Consistency` | Frontier、依赖、影响和资源不自相矛盾 | A07 | Snapshot + context 可读 | 检查 hard dependency、blocker、typed impact、parallel/resource rules | E-001 strict #1；E-008 nonblocking；不存在声明可并行但共享 exclusive resource 的冲突 | 只修受影响 edge/policy；不重排无关 Track | graph/context evidence | 可并行 | deterministic consistency PASS |
| `P0-07 Bootstrap Priority Diff` | 验证新事实不造成 priority churn | A08 | 25/25 / identity / CI discoveries 已存在 | 比较 before/after frontier | rank_changes=[]；E-001 保持 #1；E-008 内部 closeout/blocker 更新可解释 | 若真实依赖/资源改变再生成 Replan；否则不重排 | bootstrap-priority-diff | 可并行 | PASS if no unjustified churn |
| `P0-08 Main Sync / Branch Integrity` | 不基于 stale main 做 Freeze | A09 | GitHub 可读 | compare main...branch；检查 main 新变更路径冲突；必要时非 force sync | branch behind=0；main 新变更不丢失；governance files 未漂移 | 若 main 又移动，重做路径冲突审计后受控 sync | merge commit + compare | 不可与同路径写并行 | behind=0 at review cut |
| `P0-09 Fresh-context Independent Review` | 独立验证 Bootstrap Closeout | A10 | 固定 review target SHA / tree；合格 reviewer executor | 自动启动 ≥1 fresh-context read-only reviewer；不给作者修改权限；核 A01–A09 与 Authority 边界 | MAJOR=0；任何 MINOR 有明确处置；review target exact | 自动形成 finding → 定点修复 → 新 target → 重审；不让用户手工跑 | Independent Review report | 条件并行；必须在固定 target 后 | PASS required for Freeze |
| `P0-10 CI Actual Execution` | PR Merge 前获得真实 workflow evidence | A11 | GitHub Actions 能调度 runner | 自动观察 gitleaks/trivy/MCP jobs 是否出现 runner+steps，并取得 conclusion | jobs 实际启动；不是 `steps=[]/runner_id=0`；required checks 给出真实 PASS/FAIL | 当前路径若持续 pre-execution failure，保留证据，不重复无变化 rerun；等待平台恢复或独立 CI 环境授权 | workflow IDs/jobs | 与独立 Review 可并行 | required for Merge, not for Bootstrap read-only review |
| `P0-11 Freeze Eligibility` | 判断 Inventory 是否可冻结 | A12 | P0-01..09 PASS；P0-10 对 Merge 独立判断 | 生成 exact target digest + closeout matrix | Bootstrap 设计/Inventory无开放 MAJOR；明确 Runtime Gate 未完成；Freeze 不产生 Runtime Authority | 不满足则保持 Candidate；只报告最小剩余项 | Closeout decision candidate | 不可并行于目标修改 | eligible only after independent review |

## 第二阶段：P1/P2 摘要

| 项目 | 目标 | 对应清单 | 裁剪 / 降级 |
|---|---|---|---|
| Runtime Zero-Memory ≥3 Agent Gate | 验证真实 Authority/Currentness 下跨 Agent 一致性 | A13 | 当前不能降级成手工用户测试；保持 `BLOCKED_BY_AUTOMATED_TEST_IDENTITY_NOT_AVAILABLE` |
| PriorityReconciliation / Replan Runtime | 建真实动态重排 Runtime / Receipt | A14 | Bootstrap Diff 可作为设计 dogfood，但不能替代正式 Runtime |
| 用户多轨产品化 | 印记空间/模板/用户自定义 Track | A15 | 后置到 Product Runtime 与 Multi-Track Runtime 前置满足后 |

## 第三步：执行编排

当前最低成本路径：P0-01～08 已基本完成并可并行复核；固定 branch/tree 后执行 P0-09 fresh-context independent review。P0-10 CI 作为 **Merge Gate** 单独等待 runner 真正启动，不因为 CI 平台启动失败停止只读 Review。PASS 最小 Evidence 为 Snapshot/Source Registry/Authority Contract/Watermark/Zero-Memory 25/25/Graph/Diff/Main-sync/Independent Review。最终 Runtime ≥3 Agent Gate 不属于本 Bootstrap Freeze 的冒充替代项，保持后续 P1 阻断。

## 第四步：裁剪底线

1. **绝不能省略**：Exact identity、49/49 provenance、Authority fail-closed、Currentness honesty、25/25 structural recovery、Priority consistency、fresh-context independent review；省略会使 Inventory 无法可信冻结。
2. **CI 的裁剪边界**：不能为 Merge 省略真实 CI；但 runner 启动故障不应阻止与代码无关的只读 Independent Review。
3. **Runtime Gate 不得伪降级**：不得用旧 legacy binding、单 Agent、自审、用户手工开窗口或 Bootstrap projection 代替 ≥3 Agent Runtime Gate。
4. **未知项**：CI startup root cause 可带风险继续无关只读工作；Authority/Currentness 对 side-effect action 必须 fail closed。
5. **最低成本完整组合**：P0-01～09 → Bootstrap Freeze Eligibility；P0-10 真正执行 PASS → PR Ready/Merge Eligibility；A13/A14 留给后续 Runtime 实施，不反向扩张当前 Kernel Phase 2。

## 当前执行状态

```text
P0-01  DONE
P0-02  DONE
P0-03  DONE
P0-04  DONE (upstream Currentness honestly UNKNOWN)
P0-05  DONE — 25/25 structural safe-answer coverage
P0-06  DONE
P0-07  DONE — no priority churn
P0-08  DONE at sync cut — branch behind main = 0
P0-09  PENDING — automated fresh-context independent reviewer required
P0-10  BLOCKED — CI_PRE_EXECUTION_STARTUP_FAILURE
P0-11  NOT ELIGIBLE until P0-09 PASS

Runtime ≥3 Agent Gate
BLOCKED_BY_AUTOMATED_TEST_IDENTITY_NOT_AVAILABLE
```

**不可妥协底线：** Bootstrap Freeze 与 Runtime MVP PASS 是两件事。允许先冻结一个诚实、可恢复、明确标注 Runtime 未实现的 Bootstrap Inventory；不允许为了“全部绿色”伪造测试身份、CurrentnessReceipt、Replan Registry 或 Multi-Agent PASS。