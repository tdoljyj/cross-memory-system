# Clued v0.1 实施与复用文档（CLD-000 输出 + 实现设计，v0.2.0）

> 协议依据：《Clued v0.1 智能体安装、授权、弱网降级与卸载协议》
> （Clued Agent Lifecycle Protocol **v0.2.0**，FROZEN，2026-08-18；
>  LKG = 1 小时经 **ADR-CLD-001** 固化）
> 实现执行者：DeepSeek V4 Pro（DSH@TURING）
> 实现基线：cross-memory-system / vNext-2.0（HEAD = tag vNext-2.0）
> 本轮性质：发布前协议纠偏与最终验收（CLD-FIX-001 ~ CLD-FIX-005）

---

## 1. CLD-000 仓库预检结论

| 项 | 结论 |
| --- | --- |
| 版本真值 | 本地 HEAD = 远端 main = `77e0797`（实现基线）；VERSION = `vNext-2.0`；tag = `vNext-2.0`（三者对齐） |
| 工作树 | 干净（`git status --porcelain` 为空） |
| vNext-1.3 同步层测试基线 | `tests/test_acceptance.py` **70/70 PASS** |
| vNext-2.0 记忆引擎测试基线 | `tests/test_memory_v2.py` **55/55 PASS** |
| 网络 | 本机直连 GitHub 被阻断；经本地代理 `http://127.0.0.1:7897`（`http.sslBackend=openssl`）可达；本克隆已配置仓库级代理 |
| 凭据 | gh CLI 已登录 `tdoljyj`（keyring），scope 含 `repo`；git 凭据经 gh credential helper |

## 2. 不可修改区域（vNext-1.3 / vNext-2.0 冻结区）

Clued 只新增文件 + 最小修改 `.gitignore`，以下文件**一个字节不改**：

| 冻结区 | 文件 |
| --- | --- |
| 同步层（vNext-1.3） | `sync-memory.py`、`sync-memory.ps1`、`protocol-manifest.json`、`guards.json`（只读引用，不改写） |
| 记忆引擎（vNext-2.0） | `memory_engine/**`、`memory.py`、`migrate-memory.py`、`adapters/**` |
| 记忆数据 | `memory/*.md`、`memory/index.json`、`memory/objects/**`、`memory/object-index.json`（`memory/状态.md` 按记忆纪律登记进展除外） |
| 既有测试 | `tests/test_acceptance.py`、`tests/test_memory_v2.py`（不修改，只要求保持全绿） |
| 基线文档 | `架构基线文档-vNext-1.3.md`、`架构基线文档-vNext-2.0.md`、`vNext-2.0-实施冲突记录.md` |

最小修改文件：`.gitignore` 追加一行 `.clued/`（Clued 运行时根，协议 §5.5「不得被默认推送到 Canonical Store」）。

## 3. 协议逻辑组件 → 实际文件映射

| 协议组件（§4.1） | 实现文件 |
| --- | --- |
| Conversation Adapter（Codex 首个参考适配器） | `clued/codex_adapter.md`（意图→命令映射、会话管理、状态呈现、自验证；核心逻辑不在提示词内） |
| Lifecycle Controller（状态机单一控制器） | `clued/controller.py` + `clued/state_machine.py` |
| Agent Registry | `clued/registry.py`（bindings 发现/创建/修复/冲突，不存凭据） |
| Auth Provider + GitHub 参考实现 | `clued/auth/provider.py` + `clued/auth/github_provider.py`（gh CLI，无令牌落地） |
| Authorization Cache（LKG 非秘密证明） | `clued/auth/authcache.py` |
| Circuit Breaker（auth/sync 双熔断） | `clued/circuit_breaker.py` |
| Local Runtime（锁/审计/状态/清单） | `clued/locking.py`、`clued/audit.py`、`clued/manifests.py`、`clued/paths.py` |
| Pending Operation Journal（含 payload staging） | `clued/pending_journal.py`（journal）+ `clued/memory_gate.py`（payload 包络） |
| Sync Provider（复用既有 pull/push/doctor） | `clued/sync_provider.py`（子进程调 `sync-memory.py`，不改写；GitRepo 只读 + 精确 restore/rollback） |
| Canonical Store | GitHub 私有仓库 `tdoljyj/cross-memory-system`（不改） |
| Memory Access 门禁 + 引擎复用 | `clued/memory_gate.py`（经 `memory_engine.recall_engine` / `write_engine`，不复制引擎逻辑） |
| 安装/卸载/恢复事务 | `clued/installer.py`、`clued/uninstaller.py`、`clued/recovery.py` |
| 命令合同（§13） | `clued/cli.py` + 仓库根 `clued.py`（`python clued.py … --json` / `python -m clued`） |

## 4. 新增文件清单

```
.gitignore（修改一行）
clued.py                                  # 仓库根命令入口（协议 §13 允许扩展现有入口）
clued/
  __init__.py  errors.py  envelope.py  identifiers.py  paths.py  redact.py
  audit.py  locking.py  state_machine.py  manifests.py  registry.py
  circuit_breaker.py  pending_journal.py  sync_provider.py  memory_gate.py
  installer.py  uninstaller.py  recovery.py  controller.py  cli.py  __main__.py
  auth/__init__.py  auth/provider.py  auth/github_provider.py  auth/authcache.py  auth/engine.py
  codex_adapter.md                        # Codex 参考适配器（CLD-006）
tests/
  clued_testkit.py
  test_clued_unit.py  test_clued_auth.py  test_clued_install.py
  test_clued_pending.py  test_clued_recovery_crash.py
  test_clued_uninstall.py  test_clued_e2e.py
ADR-CLD-001-LKG-Max-Age-One-Hour.md       # LKG = 1h 变更控制（协议 v0.2.0）
Clued_v0.1_智能体安装授权弱网降级与卸载协议.md  # 协议文档（v0.2.0，入库）
Clued-v0.1-实施与复用文档.md（本文件）
Clued-v0.1-Reference-Implementation-Report.md（最终交付报告，协议 §21 格式）
```

运行时根（gitignored，不入 Canonical Store）：`<repo>/.clued/`：

```
.clued/
  node.json                               # §5.2 Node Manifest
  bindings/<binding_id>/binding.json      # §5.3 Agent Binding + adapter.md（artifact）
  bindings/.revoked/<binding_id>.json     # 卸载归档（REVOKED 后保留审计）
  auth/<binding_id>.json                  # §5.4 LKG 授权缓存（非秘密）
  pending/<operation_id>.json             # §9 Pending Operation Journal
  pending-refs/<operation_id>.json        # payload 语义包络（受保护 staging）
  pending-refs/orphans/                   # 孤儿 payload 隔离区（审计保留）
  conflicts/<conflict_id>/                # §10.4 conflict snapshot（base/ours/theirs）
  state/runtime.json                      # 状态机、双熔断器、降级会话（节点级）
  state/sessions/<session_id>.json        # 会话授权结果（不可跨会话复用，§1.2）
  state/revoke-queue/<task>.json          # §12.4 离线远端撤销队列
  exports/<timestamp>/                    # §12.3 丢弃未同步数据前的可恢复导出
  audit/events.jsonl                      # §15.4 审计事件（脱敏）
  locks/                                  # 生命周期锁、单飞探测锁
  staging/<txn_id>/                       # §6.3 安装事务暂存区
```

## 5. 关键设计决策（含本轮修正结论）

1. **运行时根解析**（§5.5）：优先级 `CROSS_MEMORY_CLUED_ROOT` 环境变量 > `sync.config.json` 的 `clued_runtime_root` > `<克隆根>/.clued`。不硬编码用户目录。
2. **认证后端**：GitHub 参考认证 = `gh api user` + `gh auth status`（凭据留在 gh keyring，Clued 不接触令牌）。TLS/证书错误 → `DENIED_SECURITY`（禁止降级）；401/403/scope 缺失 → `DENIED`；DNS/超时/断连 → `UNAVAILABLE`；gh 缺失 → `UNAVAILABLE(reason=capability)` → `CLD-CAP-001`，不降级。
3. **LKG 单一权威值（CLD-FIX-001，ADR-CLD-001，协议 v0.2.0）**：`lkg_max_age = 1 小时`（`clued/auth/engine.py` 单一常量来源，禁止其它模块重复硬编码）。边界语义三处一致：**`age <= 1h` 有效、`age > 1h` 失效**；无 6 小时/双界语义。配置只允许缩短；延长到 1h 以上 = 协议配置变化，构造即拒绝（`CLD-AUTH-003`），不得静默接受。
4. **排队写入的原子顺序（CLD-FIX-003，执行计划 §5.2）**：生成稳定 `operation_id` → 原子写入 payload 语义包络（受保护 staging，`.clued/pending-refs/`，含重放所需全部参数与用户内容，不入 Git 范围）→ 计算校验 `payload_sha256` → 原子创建 PENDING Journal → 暴露给本地 pending view → 向用户确认「已保存在本地、尚未同步」。**排队期间不修改 Git 跟踪工作树**，因此恢复前 sync doctor 可以真实 PASS。Journal 状态只按 `PENDING → APPLYING → SYNCED` 或 `→ CONFLICTED/REJECTED/PENDING_CORRUPT` 转移；损坏保留证据；孤儿 payload 检测、隔离并审计。
5. **payload 包络（§9.3.7）**：`clued.pending-payload.v0.1`，含 `engine_op`（CREATE/UPDATE/SUPERSEDE/DELETE）、对象 id、`base_revision`、`base_pending`（pending 链标记）、内容、重建 candidate 字典与 `successor_oid`；sha256 校验；Journal 的 `operation_type` 遵循 §9.2 枚举（SUPERSEDE 归入 UPDATE）。秘密样值扫描照旧（写入即拒绝）。
6. **恢复严格顺序（CLD-FIX-002，执行计划 §4.2）**：单飞锁 → AUTHENTICATE（每次恢复必须重新在线认证且必须 `AUTHORIZED`）→ DOCTOR 严格门 → VALIDATE_PENDING_JOURNAL → 既有同步层 PULL → VALIDATE_REMOTE_HEAD → LOAD_PENDING_IN_ORDER → 乐观锁判定（read-only）→ REPLAY_WITH_SAME_OPERATION_ID（同一 engine API、同一对象 id，幂等效果）→ RUN_EXISTING_MEMORY_VALIDATION → 既有同步层 PUSH → VERIFY_REMOTE_RESULT → MARK_PENDING_SYNCED → INVALIDATE_ONLY_IF_CHANGED → CLOSE_BREAKERS。每步产生 `recovery_step` 审计事件（顺序证据）。
7. **doctor 严格门（不绕过）**：doctor PASS → 继续；doctor FAIL 一律阻断 canonical read 与 push。唯一精确补救（非「预期 FAIL」）：FAIL 行仅为「local == remote / tracking ref valid」且本地落后远端（frozen sync 层自身指令「读前必须 re-pull」）→ 先经既有同步层 pull → 复查 doctor 必须 PASS。崩溃残留自愈：FAIL 行仅为「working tree clean」且脏文件 ⊆ 上次 APPLYING 操作的 replay 残留 → 精确 restore/删除残留 → 复查 doctor 必须 PASS。其余任何 FAIL（脏树非本批残留、真分叉、篡改、不健康文件）→ `CLD-SYNC-001` 阻断。
8. **push/确认失败回滚**：replay 提交是 Clued 自己的未推送单目的提交；push 或远端确认失败时校验 `HEAD == 本批提交` 后 `git reset --soft` + 精确 restore/删除本批文件，Pending 全部回到 PENDING（不丢、不标 SYNCED），恢复入口重新回到 doctor 可 PASS。绝不 rebase/force push/回滚他人提交。
9. **冲突（§10.4）**：任何冲突 → 整批停止（不 replay、不 commit、不 push）、生成 base（staging 时刻 HEAD 内容）/ours（payload 意图渲染）/theirs（拉取后远端内容）快照、标记 CONFLICTED、进入 CONFLICT_REVIEW；绝不自动本地覆盖远端。
10. **LOCKED 出口（D4，待产品确认项）**：`LOCKED → AUTH_REQUIRED`（新的在线认证成功且账户一致 + Binding ACTIVE + scope 合规 + 完整性检查通过），审计 `auth_recovered` + `auth_authorized`；LOCKED 期间强制新在线认证、禁止降级、禁止读私有记忆、禁止写 Pending、禁止使用旧 LKG。**本轮未获产品所有者确认，仍列为协议偏差（D4），不自行删除。**
11. **GitHub 撤销语义**：GitHub 认证是账户级（无逐 Binding 令牌），`revoke()` 标记 Binding REVOKED 并登记撤销任务；不触碰用户共享的 gh 登录。文档化为 v0.1 已知限制。
12. **Adapter 不越界**：Codex 适配器只交付指令文档 + 由 Codex 自身在其工作区落地，Clued 核心不写 `~/.codex`（遵守既有 deploy-guard / 不越界纪律）。
13. **测试隔离**：沿用 `test_acceptance.py` 模式——沙盒克隆 + 把 `sync-memory.py` 复制进沙盒（脚本 REPO 自解析），认证用 `CLUED_AUTH_PROVIDER=fake:<spec.json>` 故障注入，全部测试零网络、零改动真实记忆；恢复顺序/崩溃注入在 `tests/test_clued_recovery_crash.py`（13 项）。
14. **认证熔断与手动探测**：熔断 OPEN 时自动在线调用暂停（返回 UNAVAILABLE→按 LKG 降级）；用户显式操作（auth check / sync / uninstall）经单飞锁执行一次受控 HALF_OPEN 探测（§8.3.5-6）。

## 6. 第二个 Agent Adapter 复用指南

新 Adapter（Claude/ChatGPT/Cursor 等）只需：① 生成 `agent_type` / `agent_instance_label` / 每会话 `session_id`；② 调用 `clued.py` 命令（§13 合同，JSON 信封）；③ 按 `code`/`state` 呈现（§16.3 模板可复用）。**不得**自行实现认证、熔断、Journal、恢复、卸载逻辑，不得直接调用 git。核心入口：`clued install / auth check / status / memory / sync / uninstall / doctor`。
