# 阶段 6：路由、Skill、可读镜像与 G6 验收报告

> 状态：G6 PASS（2026-08-24 独立复评；阶段 7 仍需用户明确授权）
>
> 日期：2026-08-24
>
> 分支：`feat/clued-two-level-views-v1`
>
> 边界：仅更新本地路由合同、Worker/API/MCP、UI 文案、Skill、文档与测试；未写生产数据库、未导入旧数据、未启用 `PROJECT_VIEWS_V2`、未部署 Worker，未进入阶段 7。

## 1. 结论

阶段 6 已把 Global / Project 两级五视图的读取、写入、稳定 ID 和可读镜像语义收敛为 `two-level-five-view-v1` 单一合同。API、MCP、UI、Skill 与项目规则均引用同一语义；日志和归档只能作为按需证据，不能覆盖 State、Task 或 Decision。

补齐同一 fixture 的跨入口证据后，G6 三项门禁均已满足，独立复评结论为 `PASS`。V2 功能仍默认关闭，本文不声明生产端点、工具或面板已上线，也不自动进入阶段 7。

## 2. 单一语义合同

权威合同位于 `memory/contexts/routes.json` 的 `semantic_contract`，Worker 通过 `/v1/continuity/bootstrap` 与 `/v1/records/config` 发布同一结构：

1. 读取 Global registry 与 priority。
2. 读取相关 Project 的 State、Task 与 Decision。
3. 仅在需要历史或证据时读取 Log、Archive。
4. 写入 canonical Record。
5. 同一数据库事务产生 Event 与 Receipt。
6. Global / Project 派生视图自动反映结果。

所有入口保留数据库字段 `id` 作为 canonical ID。项目只被提及时不得猜造项目 ID 或自动确认；没有明确意图或实际工作证据时只能保持 unconfirmed candidate。

## 3. 两级五视图可读镜像

镜像目录合同固定为：

```text
Global/
  State.md
  Task.md
  Decision.md
  Archive.md
  Log.md
Projects/{canonical-project-id}/
  State.md
  Task.md
  Decision.md
  Archive.md
  Log.md
```

目录和文件只是查询视图，不是第二套正文存储。每条输出必须包含 canonical `id`，内容只允许查询结论或稳定 ID 引用；不得复制 canonical body，也不得在写数据库后再双写 Markdown 业务记录。确定性条目格式为：

```text
- `{id}` — {title}: {conclusion} [status={status}; version={version}]
```

## 4. 入口一致性

| 入口 | 读取/写入实现 | ID 与结论合同 |
|---|---|---|
| REST API | `GET/POST /v1/records` → account RPC wrapper | 返回 canonical `id`；写入进入统一 private core |
| MCP | `clued_record_list` / `clued_record_write` → binding RPC wrapper | 与 REST 返回同一 canonical `id`；写入进入同一 core |
| UI | 读取 `/v1/records` 并调用共享 `presentCluedRecord` | 显式显示 canonical ID、结论、状态与版本 |
| Skill | `$clued-continuity` | 按路由合同读取、保留 `id`、禁止猜 ID 与双写 |
| 可读镜像 | 两级五视图目录与 `formatCanonicalRecordReference` | 使用合同固定模板输出查询结论与稳定 ID 引用 |

集成测试以同一 global State fixture 分别调用 REST 与 MCP，并对完整记录做 deep equality：canonical `id`、title、body/conclusion、status、version 与时间戳全部一致。账户 UI 实际调用的共享 presentation 函数和 Markdown formatter 使用同一 fixture 复验；Skill、AGENTS、README 必须逐字包含路由合同中的目录和条目模板。V2 关闭时仍不得声称能力已上线。

## 5. Skill 漂移修复

阶段开始时，`apps/clued-cloud/AGENTS.md` 要求的 `$clued-continuity` 未安装，这是执行入口漂移。现已：

- 在仓库新增版本化 Skill：`skills/clued-continuity/`；
- 安装个人副本：`%USERPROFILE%/.codex/skills/clued-continuity/`；
- 两份 `SKILL.md` SHA-256 一致；
- 两份均通过 Skill Creator `quick_validate.py`；
- `apps/clued-cloud/AGENTS.md` 增加版本化 fallback，未来即使个人安装丢失也会 fail closed 并报告漂移。

当前会话的 Skill 清单不会热重载；新任务可直接发现已安装 Skill。本阶段没有通过 Skill 绕过功能开关或写入生产。

## 6. 验收证据

| 门禁 | 结果 |
|---|---:|
| Clued Cloud build + Node tests | `39/39 PASS` |
| G6 同一 fixture 跨入口专项 | `8/8 PASS` |
| V2 冻结合同 | `14/14 PASS` |
| TypeScript typecheck | PASS |
| ESLint | PASS |
| Clued 路由合同 | `8/8 PASS` |
| Clued Continuity Skill 校验 | 仓库版、个人版均 PASS，哈希一致 |
| Memory Engine 回归 | `55/55 PASS` |
| `git diff --check` | 提交前复验 |

全仓旧版 70 项同步层验收为 `68/70 PASS`，两项失败均未触及本阶段受测代码：

1. 测试会递归扫描被 `.gitignore` 排除的本地 `node_modules/.sites-runtime`，命中第三方依赖中的示例密钥字符串；这些文件不属于 Git 变更或提交集合。
2. 当前根 `README.md` 是精简 Clued 产品入口，旧测试仍要求已不在该文件中的“Codex / WorkBuddy / DSH 端侧差异表”；这是既存同步文档测试漂移。

两项均如实保留，不通过放宽密钥护栏或伪造 README 标题消除。G6 专用合同、应用、安全回归和路由测试全部通过。

## 7. 当前实现与能力声明核对

- Supabase schema、RLS、grants 和 canonical write core 本阶段未变更；沿用阶段 4 已通过的 16 项隔离数据库 pgTAP 证据。
- `PROJECT_VIEWS_V2` 缺省仍为关闭；关闭时 record REST endpoint 返回 disabled、MCP 不发布 V2 tools、UI 不显示面板。
- `/v1/records/config` 和公共 bootstrap 可发布无用户内容的语义合同；公共 bootstrap 的既有“不含 session token 或 Markdown 正文”安全测试继续通过。
- 文档明确区分“合同已实现”与“生产能力未启用”，没有生产迁移、数据导入或发布声明。

实现审阅参考了当前官方 [Supabase RLS 文档](https://supabase.com/docs/guides/database/postgres/row-level-security) 与 [Cloudflare Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)。本阶段未新增 schema、binding、secret 或外部网络依赖。

## 8. 回滚与停止线

本阶段没有生产状态变化。若 G6 不通过，只需回退本阶段分支提交并移除个人 Skill 副本；生产数据库、Worker、DNS、Binding、密钥和旧 Markdown 数据均无需回滚。

未经新的用户确认，不得：

- 进入阶段 7 集成评审；
- 应用生产 migration 或导入 207 条候选；
- 处理 26 条人工复核项为自动导入；
- 启用 `PROJECT_VIEWS_V2`；
- 部署 Worker、改 DNS、Binding 或密钥。

## 9. G6 重新裁决

独立复评逐项结论：

1. `PASS`：API、MCP、UI presentation、Skill/Markdown 模板在同一 fixture 上保留相同 canonical `id` 与完整结论字段。
2. `PASS`：Log/Archive 只按需作证据，不能覆盖 State、Task、Decision；路由、Agent contract 和 V2 冻结合同均有回归。
3. `PASS`：文档明确功能仍关闭，且与实际 feature flag、REST/MCP discovery 和 UI gating 一致，没有未实现的生产能力声明。
4. `PASS`：阶段 6 没有生产迁移、数据导入、功能启用或发布。

G6 最终判定 `PASS`。仍停止在阶段 6；只有用户明确授权进入阶段 7 后，才执行干净 clone 集成评审。
