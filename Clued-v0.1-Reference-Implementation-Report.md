# Clued v0.1 Reference Implementation Report

> 协议：《Clued v0.1 智能体安装、授权、弱网降级与卸载协议》（Clued Agent Lifecycle Protocol v0.1.0，FROZEN）
> 实现执行者：DeepSeek V4 Pro（DSH@TURING）
> 实现基线：cross-memory-system / vNext-2.0

---

## 1. Result

- **PASS**（协议 §20 十二项验收门槛全部满足；详见第 6 节场景证据）
- Branch：`main`
- HEAD：见 git log（本地提交，**未经用户授权不 push、不打 tag、不发布**，协议 §18）
- Worktree：clean（Clued 运行时根 `.clued/` 已 gitignore，不入 Canonical Store）

## 2. Protocol Mapping

| 协议条款 | 实现位置 |
|---|---|
| §1 产品定义 / 安装单位 = Agent Binding | `clued/registry.py`（逐 Binding，不可共享逻辑身份）；`clued/manifests.py`（node/binding schema） |
| §1.4 纯对话能力边界 | `clued/installer.py` preflight capability 检查 → `CLD-CAP-001`（exit 20） |
| §3 不可破坏的既有约束 | 冻结区零改动：`sync-memory.py/ps1`、`memory_engine/**`、`memory.py`、`guards.json`、`protocol-manifest.json` 一字未改；`clued/redact.py` 只读引用 guards.json 模式 |
| §4 逻辑架构 | 组件 → 文件映射见《Clued-v0.1-实施与复用文档.md》§3 |
| §5 身份与数据模型 | `clued/identifiers.py`（UUIDv4/RFC3339）；`clued/manifests.py`（§5.2–5.4 全部 schema 字段）；`clued/paths.py`（§5.5 逻辑布局，运行时根 gitignored） |
| §6 安装协议 | `clued/installer.py`（§6.2 十项预检 JSON、§6.3 十四步事务、§6.4 原子提交+回滚+INSTALL_ERROR 残留清单、§6.5 ALREADY_INSTALLED/REPAIRED/BINDING_CONFLICT、§6.6 无凭据交互） |
| §7 每会话授权 | `clued/auth/engine.py`（§7.1 首次访问强制在线尝试/会话复用；§7.3 有界预算 3s/5s/2 次/12s；§7.4 LOCKED 条件；§7.5 七条件降级+30min TTL；§7.6 降级权限矩阵）；`clued/auth/provider.py`（三值+DENIED_SECURITY）；`clued/auth/github_provider.py`（gh CLI，凭据不落地）；`clued/auth/authcache.py`（LKG 非秘密证明+proof_hash 完整性） |
| §8 弱网重试与熔断 | `clued/circuit_breaker.py`（CLOSED/OPEN/HALF_OPEN、2min→15min 指数冷却、单飞锁、手动探测速率限制） |
| §9 Pending Operation Journal | `clued/pending_journal.py`（§9.2 全字段、§9.3 状态转移/先 journal 后确认/APPLYING 崩溃恢复/PENDING_CORRUPT 保留证据、§9.4 operation_id 幂等+同 memory_id 保序） |
| §10 网络恢复与同步 | `clued/recovery.py`（§10.1 前提、§10.2 固定顺序（含第 9 节偏差）、§10.3 无变化规则、§10.4 冲突快照 base/ours/theirs+CONFLICT_REVIEW、§10.5 完成条件） |
| §11 状态机 | `clued/state_machine.py`（11 态+转换表）；单一控制器 `clued/controller.py`（transition() 审计+持久化） |
| §12 卸载协议 | `clued/uninstaller.py`（默认 detach-current-agent、manifest 精确删除+sha256 校验+符号链接拒绝、离线 REMOTE_REVOCATION_PENDING+撤销队列、last-binding 二次确认、丢弃前导出、幂等） |
| §13 命令与工具合同 | `clued/cli.py` + 仓库根 `clued.py`（`python clued.py <cmd> --json`）；信封 `clued/envelope.py`；退出码 `clued/errors.py`（0/10/20/30/31/40/41/50/60） |
| §14 稳定错误码 | `clued/errors.py`（23 个 CLD-* 全实现） |
| §15 安全与隐私 | 凭据走 gh keyring；审计 `clued/audit.py`（§15.4 全事件类型+脱敏）；供应链：artifact sha256+canonicalize+越界拒绝（`manifests._fs_safe_path`）；无 curl\|sh |
| §16 Codex 参考适配器 | `clued/codex_adapter.md`（意图表、session_id 规则、状态呈现模板、自清理、禁止事项；核心逻辑全部在可复用核心） |

## 3. Changed Files

**Added（新增）**
```
clued.py                                  # 仓库根命令入口（§13）
clued/__init__.py  __main__.py            # 包与 python -m 入口
clued/errors.py  envelope.py  identifiers.py  paths.py  redact.py
clued/audit.py  locking.py  state_machine.py  manifests.py  registry.py
clued/circuit_breaker.py  pending_journal.py  sync_provider.py
clued/memory_gate.py  installer.py  uninstaller.py  recovery.py  controller.py  cli.py
clued/auth/__init__.py  provider.py  github_provider.py  authcache.py  engine.py  fake.py
clued/codex_adapter.md                    # Codex 参考适配器（CLD-006）
tests/clued_testkit.py
tests/test_clued_unit.py  test_clued_auth.py  test_clued_install.py
tests/test_clued_pending.py  test_clued_uninstall.py  test_clued_e2e.py
Clued-v0.1-实施与复用文档.md
Clued-v0.1-Reference-Implementation-Report.md（本文件）
```

**Modified（最小修改）**
```
.gitignore                                # +1 行：.clued/（协议 §5.5 运行时根不入仓）
```

**Intentionally untouched core files（冻结区，一字未改）**
`sync-memory.py`、`sync-memory.ps1`、`memory.py`、`memory_engine/**`、`adapters/**`、`migrate-memory.py`、`guards.json`、`protocol-manifest.json`、`memory/**`、`tests/test_acceptance.py`、`tests/test_memory_v2.py`、`AGENTS.md`、两份架构基线文档。

## 4. Architecture

- **Lifecycle**：`Controller`（单一状态机权威，§11.2）编排 install/auth/memory/sync/uninstall/status/doctor；状态持久化 `state/runtime.json`，每转换一条审计事件。
- **Auth plane**：`AuthProvider` 接口（三值结果 + `DENIED_SECURITY` 细分）与同步平面完全解耦（§4.3）；GitHub 参考实现经 gh CLI（keyring），Clued 零令牌落地；LKG 缓存只存非秘密证明元数据（§5.4 字段全集）+ proof_hash 防篡改。
- **Sync plane**：`SyncProvider` 子进程调用既有 `sync-memory.py pull/push/doctor/bootstrap`（不复制、不改写其逻辑）；`GitRepo` 仅只读 git（head/blob/ls-remote/ancestor/fetch 取证）+ 本地身份提交；push 一律经同步脚本。
- **Pending/recovery**：写入 = 引擎落盘 → 引用包（路径+sha256，无明文复制）→ 原子 Journal → 确认；恢复 = 重新认证(AUTHORIZED 硬要求) → doctor → 只读 fetch+祖先校验 → 乐观锁（FETCH_HEAD 真值）→ 冲突即停+快照 → 提交 payload → 同步层 pull → 引擎 doctor → push → 远端确认 → SYNCED → 关闭熔断。
- **Adapter**：Codex 适配器为指令文档，只做意图→命令映射与状态呈现；认证/熔断/Journal/恢复/卸载全部在核心，第二个 Adapter 零复制接入（复用指南见实施文档 §6）。

## 5. Test Evidence

既有回归（零修改）：
```
python tests/test_acceptance.py   → 70/70 PASS（vNext-1.3 同步层）
python tests/test_memory_v2.py    → 55/55 PASS（vNext-2.0 记忆引擎）
```

新增测试（全部零网络：沙盒克隆 + 本地 bare remote + sync-memory.py 副本 + FakeAuthProvider 故障注入）：
```
python tests/test_clued_unit.py      → 26/26 PASS（信封/退出码/状态机/清单/LKG/熔断/Journal/锁/路径越界/宽删禁令）
python tests/test_clued_auth.py      → 15/15 PASS（三值分类/12s 预算/拒绝绝不降级/TLS→DENIED_SECURITY/LKG 1h&6h 双界/篡改禁降级/30min TTL/scope 上限/能力缺失不降级）
python tests/test_clued_install.py   → 10/10 PASS（首装/第二 Agent 独立 Binding/幂等/篡改 repair/认证失败完全回滚/doctor FAIL 阻断/CLD-CAP-001/不修改记忆与无关配置/多 Binding 冲突）
python tests/test_clued_pending.py   → 11/11 PASS（CREATE/UPDATE/DELETE 先入 Journal 且不触远端/恢复顺序含重新认证/no-change 零 commit/乐观锁冲突→快照(base/ours/theirs)+CONFLICT_REVIEW+远端不被覆盖/APPLYING 崩溃恢复/Journal 损坏保留证据/推送失败 pending 不丢）
python tests/test_clued_uninstall.py  → 11/11 PASS（默认仅当前 Agent/凭据立即失效/在线 pending 阻断并显示数量/丢弃前导出/离线 REMOTE_REVOCATION_PENDING+队列重放/幂等/artifact 不符停止删除/卸载后无法 Memory Access/remove-node 二次确认/明确拒绝仍可本地卸载）
python tests/test_clued_e2e.py       → 8/8 PASS（CLI JSON 单一对象信封/安装-状态往返/拒绝退出码 30/降级写入 ok=true+state=DEGRADED_LOCAL+sync 恢复/参数错误退出码 10/同节点双 Agent 全生命周期/doctor）
```

安全专项：`test_repo_files_do_not_self_match_secret_patterns`（既有回归）对新文件同样全绿 → 代码/测试/文档无凭据样值自命中；`test_redact_covers_all_guards_patterns` 全绿 → 脱敏覆盖全部 guards 模式。

## 6. Required Scenarios（协议 §20 / §21.6）

| 场景 | 证据 |
|---|---|
| 多 Agent 同节点 | `test_second_agent_independent_binding` + `test_full_multi_agent_lifecycle`：独立 Binding/agent_id、共享 node_id 与运行时、卸载互不影响 |
| 明确拒绝 | `test_cli_denied_exit_30` + `test_recovery_denied_locks`：exit 30 → LOCKED，绝不降级、不读不写记忆 |
| 弱网降级 | `test_cli_degraded_memory_write_and_sync` + `test_unavailable_with_fresh_lkg_degrades`：≤12s 预算、30min 会话、LKG 双界、写队列化不伪报 SYNCED |
| 恢复重放 | `test_recovery_replays_and_confirms_remote`：重新认证 → doctor → fetch 校验 → 乐观锁 → pull → push → 远端确认后才 SYNCED |
| 冲突 | `test_recovery_conflict_snapshot_no_push`：批次停止、不推送、快照 base/ours/theirs、CONFLICT_REVIEW、远端不覆盖 |
| 离线卸载 | `test_uninstall_offline_revocation_pending` + `test_revoke_queue_runs_after_reconnect`：本地解绑 + REMOTE_REVOCATION_PENDING + 撤销队列联网后优先执行 |

## 7. Compatibility Evidence

- vNext-1.3：`sync-memory.py/ps1` 零改动；70/70 回归全绿；Clued 经子进程复用其 pull/push/doctor/bootstrap，不绕过其密钥扫描、删除传播护栏、锁、分歧核验。
- vNext-2.0：`memory_engine/**` 零改动；55/55 回归全绿；Clued 经 `adapters.CLIAdapter` 与 `memory_engine` API 读写，不复制 Router/Write/Recall 逻辑；Memory Engine 仍不执行 git（提交/推送由 Clued 恢复层经同步层完成）。
- Git 协议不变量：无 rebase、无 force push（全流程只 `commit`+`push`/`fetch`+`merge`）；远端确认用 `merge-base --is-ancestor`；doctor FAIL 阻断 canonical read/push（install/recovery 均有硬校验）；NO_CHANGE → NO_WRITE → NO_SYNC 有专门测试。

## 8. Known Limitations

| # | 限制 | 严重度 | 缓解 |
|---|---|---|---|
| L1 | GitHub 认证为账户级：无逐 Binding 远端令牌可撤销；`revoke()` 返回账户级说明并登记撤销队列，`remote_confirmed=False` | P1（v0.1 协议已预见：§2.3 认证平面解耦，未来换自有服务） | 撤销队列 + REMOTE_REVOCATION_PENDING 显式呈现 |
| L2 | 「远端撤销」在 v0.1 = Binding 标记 REVOKED + 队列任务，不涉及 gh 令牌本身（共享账户凭据不可逐绑定吊销） | P2 | 卸载摘要明示「远端撤销尚未确认」，不表述为云端已撤销（§12.4） |
| L3 | 引擎写入与 Journal 之间存在极小崩溃窗口（引擎落盘后、Journal 落盘前）：对象文件已在工作树，无数据丢失，仅 bookkeeping 缺失，由后续同步自然提交 | P3 | 文档化；完整性检查与 doctor 可发现未归档写入 |
| L4 | 熔断/降级状态为触发式（无后台线程/轮询，符合 §8.4 禁令）；OS 网络变化探测需 Adapter 显式调用 `clued sync` | P3 | 手动探测 + 新会话首次访问自动触发 |
| L5 | GitHub 认证可用性依赖本机 gh CLI 与代理配置（本机直连 GitHub 被阻断，需 127.0.0.1:7897 代理）；gh 缺失按能力缺失处理（CLD-CAP-001，不降级） | P2 | 预检第 10 项显式检测；错误码稳定 |
| L6 | `clued memory` 写路径 = Memory Object 层（vNext-2.0 双写架构下 Markdown 五文件仍由各端按既有纪律直接编辑，不经过 Clued CLI） | P3 | 与引擎语义一致，不重复实现 Markdown 写路径 |

## 9. Protocol Deviations

（§21.9 要求 PASS 时为空；以下两项为**保守裁决/顺序适配**，不改变任何 MUST 语义，逐条列出供产品审阅）

| # | 条款 | 偏差与理由 |
|---|---|---|
| D1 | §7.5 参数表 `lkg_max_age=1h` 与条件 3/§22.7 的 6h 并存 | 按 §22「歧义选更保守」取交集：开启降级要求 LKG ≤ 1h；> 6h 证明完全失效。常量可配置 |
| D2 | §10.2 恢复顺序第 3 步 PULL 与第 6-7 步乐观锁 | 既有同步层 pull 硬性拒绝脏工作树（防覆盖护栏）。Clued 恢复改为：只读 fetch+远端校验 → 乐观锁（FETCH_HEAD 真值）→ 冲突排除后才提交 payload → 同步层 pull → push。**安全不变量全部保留**：重新认证在前、先 pull 后 push、冲突批次不推送、远端确认后才 SYNCED、真分叉仍阻断 |
| D3 | §10.1.4 恢复前 doctor 必须 PASS | 恢复前存在两种预期 FAIL（工作树脏=本批 payload；本地落后/追踪 ref 漂移=即将 pull），由独立硬校验兜底（脏树覆盖检查 + 祖先判定）；其余任何 doctor FAIL 仍阻断 |
| D4 | §11.2 转换表无 LOCKED 出口 | 增加 LOCKED → AUTH_REQUIRED（在线重新认证成功且账户/scope/Binding 恢复），审计记录 |

## 10. Next Actions（需产品决策）

1. D1 的 LKG 双界是否收敛为单一值（1h 或 6h）——当前实现取保守交集。
2. v0.2 的逐 Binding 远端凭证/撤销（Clued 自有认证服务时实现真正 remote_confirmed 撤销）。
3. 是否把 `clued.py` 注册为系统级 `clued` 命令别名（协议 §13 允许扩展现有入口，当前以 `python clued.py` 形式交付）。
4. 用户授权后：push 本实现（当前按协议 §18 未 push、未打 tag、未发布）。
