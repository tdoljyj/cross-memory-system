# Clued v0.1 实施与复用文档（CLD-000 输出 + 实现设计）

> 协议依据：《Clued v0.1 智能体安装、授权、弱网降级与卸载协议》（Clued Agent Lifecycle Protocol v0.1.0，FROZEN，2026-08-18）
> 实现执行者：DeepSeek V4 Pro（DSH@TURING）
> 实现基线：cross-memory-system / vNext-2.0（HEAD = tag vNext-2.0）

---

## 1. CLD-000 仓库预检结论

| 项 | 结论 |
|---|---|
| 版本真值 | 本地 HEAD = 远端 main = `77e0797`；VERSION = `vNext-2.0`；tag = `vNext-2.0`（三者对齐） |
| 工作树 | 干净（`git status --porcelain` 为空） |
| vNext-1.3 同步层测试基线 | `tests/test_acceptance.py` **70/70 PASS** |
| vNext-2.0 记忆引擎测试基线 | `tests/test_memory_v2.py` **55/55 PASS** |
| 网络 | 本机直连 GitHub 被阻断；经本地代理 `http://127.0.0.1:7897`（`http.sslBackend=openssl`）可达；本克隆已配置仓库级代理 |
| 凭据 | gh CLI 已登录 `tdoljyj`（keyring），scope 含 `repo`；git 凭据经 gh credential helper |

## 2. 不可修改区域（vNext-1.3 / vNext-2.0 冻结区）

Clued v0.1 只新增文件 + 最小修改 `.gitignore`，以下文件**一个字节不改**：

| 冻结区 | 文件 |
|---|---|
| 同步层（vNext-1.3） | `sync-memory.py`、`sync-memory.ps1`、`protocol-manifest.json`、`guards.json`（只读引用，不改写） |
| 记忆引擎（vNext-2.0） | `memory_engine/**`、`memory.py`、`migrate-memory.py`、`adapters/**` |
| 记忆数据 | `memory/*.md`、`memory/index.json`、`memory/objects/**`、`memory/object-index.json` |
| 既有测试 | `tests/test_acceptance.py`、`tests/test_memory_v2.py`（不修改，只要求保持全绿） |
| 基线文档 | `架构基线文档-vNext-1.3.md`、`架构基线文档-vNext-2.0.md`、`vNext-2.0-实施冲突记录.md` |

最小修改文件：`.gitignore` 追加一行 `.clued/`（Clued 运行时根，协议 §5.5「不得被默认推送到 Canonical Store」）。

## 3. 协议逻辑组件 → 实际文件映射

| 协议组件（§4.1） | 实现文件 |
|---|---|
| Conversation Adapter（Codex 首个参考适配器） | `clued/codex_adapter.md`（意图→命令映射、会话管理、状态呈现、自验证；核心逻辑不在提示词内） |
| Lifecycle Controller（状态机单一控制器） | `clued/controller.py` + `clued/state_machine.py` |
| Agent Registry | `clued/registry.py`（bindings 发现/创建/修复/冲突，不存凭据） |
| Auth Provider + GitHub 参考实现 | `clued/auth/provider.py` + `clued/auth/github_provider.py`（gh CLI，无令牌落地） |
| Authorization Cache（LKG 非秘密证明） | `clued/auth/authcache.py` |
| Circuit Breaker（auth/sync 双熔断） | `clued/circuit_breaker.py` |
| Local Runtime（锁/审计/状态/清单） | `clued/locking.py`、`clued/audit.py`、`clued/manifests.py`、`clued/paths.py` |
| Pending Operation Journal | `clued/pending_journal.py` |
| Sync Provider（复用既有 pull/push/doctor） | `clued/sync_provider.py`（子进程调 `sync-memory.py`，不改写） |
| Canonical Store | GitHub 私有仓库 `tdoljyj/cross-memory-system`（不改） |
| Memory Access 门禁 + 引擎复用 | `clued/memory_gate.py`（经 `memory_engine.recall_engine` / `write_engine`，不复制引擎逻辑） |
| 安装/卸载/恢复事务 | `clued/installer.py`、`clued/uninstaller.py`、`clued/recovery.py` |
| 命令合同（§13） | `clued/cli.py` + 仓库根 `clued.py`（`python clued.py … --json` / `python -m clued`） |

## 4. 新增文件清单

```
.clgitignore（修改一行）
clued.py                                  # 仓库根命令入口（协议 §13 允许扩展现有入口）
clued/
  __init__.py  errors.py  envelope.py  identifiers.py  paths.py  redact.py
  audit.py  locking.py  state_machine.py  manifests.py  registry.py
  circuit_breaker.py  pending_journal.py  sync_provider.py  memory_gate.py
  installer.py  uninstaller.py  recovery.py  controller.py  cli.py  __main__.py
  auth/__init__.py  auth/provider.py  auth/github_provider.py  auth/authcache.py  auth/engine.py
  codex_adapter.md                        # Codex 参考适配器（CLD-006）
tests/
  test_clued_unit.py  test_clued_auth.py  test_clued_install.py
  test_clued_pending.py  test_clued_uninstall.py  test_clued_e2e.py
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
  conflicts/<conflict_id>/                # §10.4 conflict snapshot（base/ours/theirs）
  state/runtime.json                      # 状态机、双熔断器、降级会话（节点级）
  state/sessions/<session_id>.json        # 会话授权结果（不可跨会话复用，§1.2）
  state/revoke-queue/<task>.json          # §12.4 离线远端撤销队列
  exports/<timestamp>/                    # §12.3 丢弃未同步数据前的可恢复导出
  audit/events.jsonl                      # §15.4 审计事件（脱敏）
  locks/                                  # 生命周期锁、单飞探测锁
  staging/<txn_id>/                       # §6.3 安装事务暂存区
```

## 5. 关键设计决策与保守裁决

1. **运行时根解析**（§5.5）：优先级 `CROSS_MEMORY_CLUED_ROOT` 环境变量 > `sync.config.json` 的 `clued_runtime_root` > `<克隆根>/.clued`。不硬编码用户目录。
2. **认证后端**：GitHub 参考认证 = `gh api user` + `gh auth status`（凭据留在 gh keyring，Clued 不接触令牌）。TLS/证书错误 → `DENIED_SECURITY`（禁止降级）；401/403/scope 缺失 → `DENIED`；DNS/超时/断连 → `UNAVAILABLE`；gh 缺失 → `UNAVAILABLE(reason=capability)` → `CLD-CAP-001`，不降级（保守，§22 选更少权限）。
3. **LKG 年龄双界（§7.5 内部不一致的保守裁决）**：表值 `lkg_max_age=1h` 与条件 3 / §22.7 的 6h 并存时，按 §22「更保守」原则取交集——**开启降级要求 LKG ≤ 1h；LKG > 6h 视为证明完全失效**。两常量均可配置，改动需 ADR。
4. **Pending Journal 双用**：降级写入必入 Journal（协议要求）；在线写入同步失败时同样入 Journal（`ONLINE_DIRTY` 可恢复）。Journal 先原子落盘、再改工作树、再向用户确认（§9.3.2）。
5. **payload 引用式存储**（§9.3.7）：Journal 存 `payload_ref`（工作树相对路径）+ `payload_sha256`，不重复明文。
6. **恢复批次提交**：恢复只 stage 本批 Journal 的 `payload_ref` 文件，commit 身份 `<agent_type>@<hostname>`（CLI 可传 `--committer`），推送经 `sync-memory.py push`，禁止绕过同步层。
7. **LOCKED 出口扩展**：§11.2 表未定义 LOCKED 出口；实现增加 `LOCKED → AUTH_REQUIRED`（在线重新认证成功且账户/scope/Binding 恢复时），审计记录，文档化偏差（非 MUST 冲突）。
8. **GitHub 撤销语义**：GitHub 认证是账户级（无逐 Binding 令牌），`revoke()` 标记 Binding REVOKED 并登记撤销任务；不触碰用户共享的 gh 登录。文档化为 v0.1 已知限制。
9. **Adapter 不越界**：Codex 适配器只交付指令文档 + 由 Codex 自身在其工作区落地，Clued 核心不写 `~/.codex`（遵守既有 deploy-guard / 不越界纪律）。
10. **测试隔离**：沿用 `test_acceptance.py` 模式——沙盒克隆 + 把 `sync-memory.py` 复制进沙盒（脚本 REPO 自解析），认证用 `CLUED_AUTH_PROVIDER=fake:<spec.json>` 故障注入（跨进程状态文件持久化 outcome 序列），全测试零网络、零改动真实记忆。
11. **恢复顺序适配（文档化偏差 D2/D3）**：既有同步层 pull 硬性拒绝脏工作树；恢复改为「只读 fetch + 远端祖先校验 → 乐观锁（FETCH_HEAD）→ 冲突排除后提交 payload → 同步层 pull → push」，安全不变量全保留（详见交付报告第 9 节）。
12. **LOCKED 出口扩展（D4）**：`LOCKED → AUTH_REQUIRED`（在线重新认证成功且账户/scope/Binding 恢复），审计记录。
13. **LKG 双界（D1）**：开启降级要求 LKG ≤ 1h（`lkg_max_age`），> 6h 证明完全失效（§22.7 硬上限）；常量可配置。
14. **认证熔断与手动探测**：熔断 OPEN 时自动在线调用暂停（返回 UNAVAILABLE→按 LKG 降级）；用户显式操作（auth check / sync / uninstall）经单飞锁执行一次受控 HALF_OPEN 探测（§8.3.5-6）。

## 6. 第二个 Agent Adapter 复用指南

新 Adapter（Claude/ChatGPT/Cursor 等）只需：① 生成 `agent_type` / `agent_instance_label` / 每会话 `session_id`；② 调用 `clued.py` 命令（§13 合同，JSON 信封）；③ 按 `code`/`state` 呈现（§16.3 模板可复用）。**不得**自行实现认证、熔断、Journal、恢复、卸载逻辑，不得直接调用 git。核心入口：`clued install / auth check / status / memory / sync / uninstall / doctor`。
