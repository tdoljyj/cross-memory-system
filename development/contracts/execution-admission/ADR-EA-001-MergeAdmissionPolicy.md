# ADR-EA-001：合并准入采用「路径分级 × 全局状态」策略表，保留 GitHub strict，用 Clued 合并队列 + GitHub auto-merge 取代 Agent 轮询合并位

> 状态：**Accepted（Owner 2026-10-08 接受，Decision `d130195e`；接受的内容为 commit `33d858b1`）**
> 日期：2026-10-08
> 范围：`tdoljyj/cross-memory-system` 发往 `main` 的 pull request 的准入、合并串行化与模式切换。
> 决策对象：[MergeAdmission.v0.1.md](MergeAdmission.v0.1.md)（规范，Accepted）。研究报告与数据在 Google Drive 资料中心 `10_E_工程与平台/CI基础设施/`（报告 v0.1 候选 r2，文件 ID `1ETCsBd1ol9f_lIMNbxn1z7ph7H8JYUxJ`，SHA-256 `63a2b6d1bb9980e9ca07fc78ebd996a4c7ddad77a4ef0fa50e44a476aa2d8903`；三轮独立复审记录文件 ID `14TuVeFBnzebmJR7ErXYuj5lxxcQYIpi0`，SHA-256 `a1e575ed126dd36aaedb71ca6182033bf11fa1397daa447569ae1922a48c7228`；Clued Note `7bea039d`）。
> 来源：Owner Decision `8e767ed8`（先研究写方案；模式切换形态）、`f303f861`（P0-1 四项；按本 ADR 修订后由 `610eeaaa` 替换）、Task `ada1334c`；接受：Decision `d130195e`。
> 放置说明：仓库没有统一的 ADR 目录（现有 ADR 分散在 `docs/clued-two-level-views/`、`docs/history/`、`docs/r3-gate*/`），本 ADR 与它所解释的合同放在同一目录，便于同一个 PR 评审；Owner 可在接受时指定搬移。

## 1. 背景

2026-10-01 起，为多 Agent 并发开发加的执行准入（认领、`clued-work-admission` 必需检查、Owner 复核、合并位、每小时复核、重跑禁令）在六天里改了 26 个迁移、合同从 v7 到 v38，10-06 一天四个 Decision（`0edf7889`、`2ea795e4`、`cd84d455`、`f303f861`）。每次都是按单点痛点修补，没有一次说清「合并到 main 到底要保证什么」。2026-10-07 的审计（Task `ada1334c`）量化了代价：最近 60 个合并 PR 中位合并时长从 0.67 h 升到 1.5 h（受保护）/ 1.22 h（非受保护）；Owner 复核强制后 10 个受保护 PR 全部关闭重开（19 次）；合并位 45 分钟定时器与每 10 分钟轮询占用 Agent 会话；自托管 runner 排队（截图 10 个检查排队）是实际瓶颈。Owner 决定先研究、写经独立复审的规范、再按规范实施，并要求模式切换采用「路径分级 × 全局状态」。

## 2. 决策

1. **合并到 main 的保证分五条写明**（G1 归属不撞车、G2 受保护改动 Owner 看过、G3 合并结果 = 批过测过的 head、G4 共享资源只为被认领的工作花费、G5 串行化不浪费 CI），其中「按最终合并状态测过」只对受保护层是保证，其余层接受 main 的 push CI 事后发现。
2. **执行规则从常量 + 分支改为声明式策略表**：三层路径（受保护 / 普通代码 / 文档合同草案）× 三个全局状态（normal / frozen / efficiency），六列（认领、Owner 授权、是否含 main tip、合并位、每 head 重跑、auto-merge）。策略文件 `config/merge-admission-policy.json` 本身是受保护路径。
3. **受保护层是代码常量基线，任何状态不放松**；状态与文件只能对其他层生效，或对所有层加严（frozen）。配置解析失败、状态未知一律按 frozen（fail closed）。
4. **GitHub 规则集的 `strict` 保持开启**；必需检查列表不随状态变；状态只改检查内部判定。
5. **合并位改为 Clued 侧 FIFO 合并队列**：入队一次即排队，不再每 10 分钟轮询；位的时效绑 CI 运行状态（由默认分支上持 ci-admission Binding 的 job 上报），45 分钟改为兜底；CI 失败自动出队；队列头用 GitHub 原生 auto-merge 合并，Owner 批准仍在前；执行器为队列头并入 main 作为可选的第五步。
6. **每个当前 head 允许一次「Re-run all jobs」**（确认 `f303f861` 第 2 项），取代授权后关闭重开；「Re-run failed jobs」仍拒绝。
7. **`normal` 下三层都强制认领、都要求合并位**（修正 `f303f861` 第 3 项：strict 开启时任何一层的插队都让队列头白跑一轮自托管 CI，而取位只是一次续期）；`efficiency` 状态保留原第 3 项的形态（普通层与文档层认领提示、免合并位）供 Owner 选用，代价是这两层缺认领的 PR 不计量、可能白跑 CI。
8. **不采用第三方合并队列**（GitHub 原生队列不可用；Mergify、Trunk、Aviator 等不采用）；批量测试与失败二分推迟到 v0.2，由度量触发评估。
9. **CI 用量先测后减**：每周只读报告（自托管分钟、排队、重跑、并入 main 次数、白跑的最后一轮、gate 占用），削减项按数据排序（gate 等待、quality gate 对非代码改动空转、gitleaks/trivy 在自托管、插队白跑）。

## 3. 备选方案与否决理由

| 备选 | 否决理由 |
| --- | --- |
| GitHub 原生 merge queue | 只对组织名下公开仓库或 GitHub Enterprise Cloud 组织的私有仓库开放；本仓库是个人账号私有仓库，不可用（GitHub 文档与 Mergify FAQ 均如此说明） |
| Mergify merge queue（speculative checks、batch） | 需要给外部 GitHub App 仓库内容与 PR 的写权限，与「只有 Owner 的 App 私钥在 main 限定的 environment 里」的信任模型相悖；队列规则与认领、Owner Grant 两套判定并存；免费额度只到 5 个用户，超出 `$21`/seat/月；SaaS 依赖。可借鉴：失败即移出、batch 二分 |
| Trunk Merge Queue（impacted targets 并行队列、乐观合并、二分） | 同样是外部 App 写权限 + SaaS；其「impacted targets」在本仓库已由认领的 `write_set` 不相交保证，并行的收益只剩批量测试。可借鉴：按影响范围分队列的思路用于 v0.2 批量 |
| Bors-ng / homu | bors-ng 已停止维护并指向 GitHub merge queue；需要自托管一个有写权限的机器人，与执行器方案等价但多一套系统 |
| Zuul | 为多仓库、多项目的大型门禁设计，运行成本远超本仓库规模。可借鉴：失败后窗口减半的自适应、依赖链推测执行 |
| Aviator、Graphite 等托管合并队列 | 与 Mergify / Trunk 同类：外部 App 写权限 + SaaS，与认领 / Owner Grant 两套判定并存；未逐一评估功能细节，否决理由相同 |
| 关闭 `strict`，按 `write_set` 不相交并行合并 | 受保护层失去「合并结果 = 批过的 head」；复审 9–11 已证明检查时判定 + 几分钟后复核关不掉窗口；队列独占在 GitHub 侧同样只是判定时的结论 |
| 全局三档对所有 PR 一视同仁（无路径分层） | Owner 未选（Decision `8e767ed8`）：受保护层需要在任何档都不放松，一视同仁做不到 |
| 保留现行合并位，只把 45 分钟改长 | 不解决轮询与守 CI 占用 Agent 会话的问题；定时器仍与 CI 实际时长无关 |
| 认领与合并位只对受保护 PR 强制（`f303f861` 第 3 项原文） | `advise` 取消的是「未认领或过窄的 PR 不得合并」这道门，归属与按 Task 计量都靠它；取消串行化在 strict 下每次插队都白跑一轮自托管 CI。改为 `efficiency` 状态下可选 |

## 4. 后果

**正面**：以后调规则是改配置 + 写 Decision，不改脚本、不发合同版本；受保护层的安全边界有代码与表驱动测试双重保证；Agent 不再为合并位轮询与守 CI；Owner 授权后不再关闭重开；CI 用量有数据可依。

**负面与代价**：准入脚本一次较大的重构（常量 + 分支 → 读表），测试改为表驱动；新增 1–2 个迁移（位时效上报、队列）；执行器需要扩大 clued-admission App 权限（Owner 决定是否做）；`efficiency` 下普通层与文档层缺认领的 PR 不计量、插队会让队列头白跑一轮；`frozen` 的「只有 Owner 合并」在 GitHub 侧不可强制，靠合规与 Decision 记录；两个 ENFORCE 变量删除前仍是受保护层之外的放宽开关。

**对现有文档的影响**：WorkClaimAdmission v0.1 §4.4 合并位段落在实施后被 MergeAdmission §7 取代；合同 §1.7 合并位与重跑段落改写并缩短；CONTRIBUTING「Work claims」「Protected paths and Owner grants」按分层改写；`docs/maintenance/main-admission-self-test-deadlock.md` 不变。

## 5. 接受条件

- fresh-context 独立复审：BLOCKER 0、MAJOR 0（MINOR 可随接受一起修）。
- Owner 的 Clued Decision 指向 Drive 报告的精确文件 ID + 本 ADR 与合同所在的仓库 commit。
- 接受后：MergeAdmission.v0.1 状态改为 Accepted（一个 PR），再按其 §13 逐步实施，每步单独授权。

## 6. 关联

- 合同：[MergeAdmission.v0.1.md](MergeAdmission.v0.1.md)、[WorkClaimAdmission.v0.1.md](WorkClaimAdmission.v0.1.md)、[GenericWorkClaim.v0.1.md](GenericWorkClaim.v0.1.md)、[GitConnectorWriteContract.v0.1.md](../repository/GitConnectorWriteContract.v0.1.md)。
- Clued：Decision `8e767ed8`、`f303f861` → `610eeaaa`、`22c20e14`（准入自检死锁只用临时放行解锁）、`d130195e`（接受）、Task `ada1334c`；实施 Task 见 MergeAdmission §13 表。
- 代码：`scripts/ci/clued-work-admission.mjs`、`.github/workflows/clued-work-admission*.yml`、迁移 `20261006120000_work_claims_merge_slot.sql`。
