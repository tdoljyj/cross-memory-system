# Clued v0.1 Reference Implementation Report（Pre-release Correction）

> 协议：《Clued v0.1 智能体安装、授权、弱网降级与卸载协议》
> （Clued Agent Lifecycle Protocol **v0.2.0**，FROZEN 2026-08-18；
>   LKG = 1 小时经 **ADR-CLD-001** 固化；
>   `LOCKED → AUTH_REQUIRED` 经 **ADR-CLD-002** 纳入 §11.2）
> 产品：Clued v0.1
> 实现执行者：DeepSeek V4 Pro（DSH@TURING）
> 实现基线：cross-memory-system / vNext-2.0
> 本轮：发布前协议纠偏与最终验收（CLD-FIX-001 ~ CLD-FIX-005 + D4 收口）

---

## 1. Result

- **PASS**（D1–D4 已全部解决并移出偏差清单；`Protocol Deviations` 为空）
- Product version：Clued v0.1
- Protocol version：Clued Agent Lifecycle Protocol **v0.2.0**（ADR-CLD-001 + ADR-CLD-002 发布前收口）
- Branch：`main`
- Exact local HEAD：见「9. Git Evidence」（本轮全部提交均为本地提交；最终精确 HEAD = 验收证据，见 §7.4 与本轮回报）
- 验收不变量：TESTED_HEAD = FINAL_REPORT_HEAD = `git rev-parse HEAD` = 临时 bare remote HEAD（见 §7.4）
- Exact remote HEAD：`77e0797344481519117defa626afea417a5f5f0b`
- Ahead/behind：本地 ahead 远端（本轮追加提交；**未 push**）
- Worktree：clean（`.clued/` 运行时根 gitignored，不入 Canonical Store）
- Confirm：**not pushed / no PR / no tag / no release**

## 2. Protocol Mapping（协议 v0.2.0 → 实现）

| 协议条款 | 实现位置 |
|---|---|
| §1 产品定义 / 安装单位 = Agent Binding | `clued/registry.py`；`clued/manifests.py`（node/binding schema） |
| §1.4 纯对话能力边界 | `clued/installer.py` preflight → `CLD-CAP-001`（exit 20） |
| §3 不可破坏的既有约束 | 冻结区零改动（见 §7）；`clued/redact.py` 只读引用 guards.json 模式 |
| §4 逻辑架构 | 组件 → 文件映射见《Clued-v0.1-实施与复用文档.md》§3 |
| §5 身份与数据模型 | `clued/identifiers.py`；`clued/manifests.py`；`clued/paths.py`（§5.5 布局，运行时根 gitignored） |
| §6 安装协议 | `clued/installer.py`（§6.2 十项预检、§6.3 十四步事务、§6.4 原子+回滚、§6.5 幂等/冲突） |
| §7 每会话授权（v0.2.0） | `clued/auth/engine.py`（§7.1 首次强制在线；§7.3 有界 3s/5s/2 次/12s；§7.4 LOCKED 条件；§7.5 七条件降级 + **LKG ≤ 1h（ADR-CLD-001）** + 30min TTL；§7.6 权限矩阵）；`clued/auth/provider.py`（三值 + DENIED_SECURITY）；`clued/auth/github_provider.py`（gh CLI，零令牌落地）；`clued/auth/authcache.py`（非秘密证明 + proof_hash 防篡改） |
| §8 弱网重试与熔断 | `clued/circuit_breaker.py`（CLOSED/OPEN/HALF_OPEN、2min→15min 指数冷却、单飞、速率限制） |
| §9 Pending Operation Journal | `clued/pending_journal.py`（状态机/损坏保留/孤儿检测隔离）+ `clued/memory_gate.py`（payload 语义包络 staging，原子顺序：operation_id → payload 原子写 → sha256 校验 → journal 原子写 → pending view → 确认） |
| §10 网络恢复与同步 | `clued/recovery.py`（§10.1 前提、§10.2 固定顺序 + 每步 `recovery_step` 审计、§10.3 无变化规则、§10.4 冲突快照 base/ours/theirs、§10.5 完成条件）；`clued/sync_provider.py`（子进程复用冻结同步层；GitRepo 只读 + 精确 restore/回滚） |
| §11 状态机 | `clued/state_machine.py`（11 态 + `LOCKED→AUTH_REQUIRED`，§11.2.1 正式条款，ADR-CLD-002）；单一控制器 `clued/controller.py`（TRANSITION_EVENTS 审计，`auth_recovered`） |
| §12 卸载协议 | `clued/uninstaller.py`（默认 detach-current-agent、manifest 精确删除、离线 REMOTE_REVOCATION_PENDING、幂等；导出含 payload 包络） |
| §13/§14 命令合同/错误码 | `clued/cli.py` + `clued.py`（JSON 信封 `protocol_version=0.2.0`）；`clued/errors.py`（23 个 CLD-* 全实现） |
| §15 安全与隐私 | gh keyring 凭据；`clued/audit.py`（§15.4 全事件 + 脱敏）；供应链 sha256 + canonicalize + 越界拒绝 |
| §16 Codex 参考适配器 | `clued/codex_adapter.md`（意图表、session_id、状态模板、自清理；核心逻辑在可复用核心） |
| §22 变更控制 | `ADR-CLD-001-LKG-Max-Age-One-Hour.md`（ACCEPTED，LKG 6h → 1h，协议 v0.2.0）+ `ADR-CLD-002-LOCKED-Recovery-Transition.md`（ACCEPTED，`LOCKED → AUTH_REQUIRED` 纳入 §11.2，v0.2.0 发布前收口） |

## 3. Changed Files

**Added（本轮）**
```
ADR-CLD-001-LKG-Max-Age-One-Hour.md        # LKG=1h 变更控制 ADR（协议 v0.2.0）
Clued_v0.1_智能体安装授权弱网降级与卸载协议.md  # 协议文档（v0.2.0，入库）
tests/test_clued_recovery_crash.py         # 恢复顺序 + 崩溃故障注入（13 项）
```

**Modified（本轮）**
```
clued/__init__.py                          # PROTOCOL_VERSION 0.1.0 → 0.2.0
clued/auth/engine.py                       # LKG 单一 1h 值；配置延长拒绝；SessionAuthResult.account_id
clued/memory_gate.py                       # payload 语义包络 staging；pending view；replay（同一 operation_id/同一对象 id）
clued/pending_journal.py                   # payload 包络校验；孤儿 payload 检测/隔离/审计
clued/recovery.py                          # 严格 doctor 门 + pull 先于 replay + 残留自愈 + 提交回滚 + recovery_step 轨迹
clued/sync_provider.py                     # GitRepo：restore_paths / reset_soft_undo_commit / status =v1 / blob_sha returncode 校验
clued/controller.py                        # 恢复重认证去豁免；LOCKED 门（D4）；状态机审计事件；孤儿 doctor 检查
clued/audit.py                             # recovery_step 事件类型
clued/paths.py                             # pending-refs / orphans 路径
clued/uninstaller.py                       # 丢弃导出含 payload 包络
tests/test_clued_auth.py                   # LKG 1h 边界（59m59s / 60m00s / 3601s）+ 配置延长拒绝（18 项）
tests/test_clued_unit.py                   # 信封协议版本 0.2.0 + Journal created_at 单调（27 项）
tests/test_clued_pending.py                # 降级工作树干净 + doctor PASS；D4 专项 3 项（15 项）
tests/test_clued_e2e.py                    # 信封协议版本 0.2.0（8 项）
Clued-v0.1-实施与复用文档.md                 # 设计决策重写（staged payload / 严格恢复 / LKG 单值）
Clued-v0.1-Reference-Implementation-Report.md（本文件）
```

**Added（D4 收口轮）**
```
ADR-CLD-002-LOCKED-Recovery-Transition.md  # 见上方 Added 清单（D4 收口轮正式登记）
```

**Modified（D4 收口轮）**
```
Clued_v0.1_智能体安装授权弱网降级与卸载协议.md  # §0 变更记录、§11.2 转换行 + §11.2.1 安全前提、§15.4 审计事件（ADR-CLD-002）
Clued-v0.1-实施与复用文档.md                 # 设计决策 10：D4 由「待确认偏差」改为 ADR-CLD-002 批准条款
Clued-v0.1-Reference-Implementation-Report.md（本文件：Result=PASS、偏差清单清空、HEAD 证据）
memory/状态.md                              # 登记 D4 批准与最终收口状态（记忆纪律）
```

**Intentionally untouched core files（冻结区，一字未改，见 §7 差异核验）**
`sync-memory.py`、`sync-memory.ps1`、`memory.py`、`memory_engine/**`、`adapters/**`、`migrate-memory.py`、`guards.json`、`protocol-manifest.json`、`tests/test_acceptance.py`、`tests/test_memory_v2.py`、`AGENTS.md`、两份架构基线文档、`vNext-2.0-实施冲突记录.md`。

## 4. Architecture

- **Lifecycle**：`Controller`（单一状态机权威）编排 install/auth/memory/sync/uninstall/status/doctor；状态转换经 `TRANSITION_EVENTS` 写入审计（如 `LOCKED → AUTH_REQUIRED` = `auth_recovered`）。
- **Auth plane**：`AuthProvider` 三值接口与同步平面完全解耦；GitHub 参考实现经 gh CLI（keyring）；LKG 只存非秘密证明元数据 + proof_hash 防篡改；LKG 上限唯一权威值 1 小时（`clued/auth/engine.py`，ADR-CLD-001）。
- **Sync plane**：`SyncProvider` 子进程调用既有 `sync-memory.py pull/push/doctor/bootstrap`（不复制、不改写）；`GitRepo` 只读取证 + 本地身份提交 + 精确 restore/回滚（`git reset --soft`，非 --hard / 非 checkout，仅回滚 Clued 自己的未推送提交）。
- **Pending/recovery**：降级/排队写入 = payload 语义包络原子落盘（`.clued/pending-refs/`）→ Journal 原子落盘 → 确认；**不修改工作树**。恢复 = 重新认证（必须 AUTHORIZED）→ doctor 严格门（PASS 或落后 pull 补救/自身残留自愈，复查必须 PASS）→ 校验 Journal → 冻结层 pull → 校验远端 → 乐观锁（read-only）→ 按原 operation_id replay 到 Memory Engine → 既有 Memory Validation → 提交 → 冻结层 push → 远端确认 → SYNCED → 关闭熔断。冲突整批停止 + base/ours/theirs 快照；push/确认失败回滚 Clued 自己的提交与残留，Pending 全部可重试。
- **Adapter**：Codex 适配器为指令文档，只做意图→命令映射与状态呈现；认证/熔断/Journal/恢复/卸载全部在核心。

## 5. Test Evidence

**既有回归（零修改，本轮全绿）**
```
python tests/test_acceptance.py        → 70/70 PASS（vNext-1.3 同步层）
python tests/test_memory_v2.py         → 55/55 PASS（vNext-2.0 记忆引擎）
```

**Clued 测试（本轮修正后，全部零网络：沙盒克隆 + 本地 bare remote + FakeAuthProvider）**
```
python tests/test_clued_unit.py           → 27/27 PASS（信封 0.2.0/退出码/状态机/清单/LKG 完整性/熔断/Journal 创建顺序与 created_at 单调/锁/越界）
python tests/test_clued_auth.py           → 18/18 PASS（三值/12s 预算/拒绝绝不降级/TLS→DENIED_SECURITY/LKG 1h 边界 59m59s·60m00s·3601s/篡改禁降级/配置延长拒绝/30min TTL/scope 上限）
python tests/test_clued_install.py        → 10/10 PASS（首装/第二 Agent/幂等/篡改 repair/认证失败回滚/doctor FAIL 阻断/CLD-CAP-001/不改记忆）
python tests/test_clued_pending.py        → 15/15 PASS（降级先入 Journal 且工作树干净 + doctor PASS/恢复顺序/no-change/冲突快照不覆盖远端/APPLYING 恢复/损坏保留/push 失败不丢/D4 专项 3 项）
python tests/test_clued_recovery_crash.py → 13/13 PASS（doctor FAIL 阻断 read/push 调用计数/严格事件序列/pull 失败可重试/整批冲突不推送/push·确认失败回滚干净可重试/崩溃矩阵 6 点/同 operation_id 幂等）
python tests/test_clued_uninstall.py      → 11/11 PASS（默认仅当前 Agent/凭据立即失效/离线撤销队列/幂等/artifact 不符停止删除/卸载后无法访问）
python tests/test_clued_e2e.py            → 8/8 PASS（CLI JSON 信封 0.2.0/安装-状态往返/拒绝 exit 30/降级写入+恢复/参数 10/双 Agent 全生命周期/卸载幂等/doctor）
```

**合计：227 项，0 失败，0 跳过。**（隔离环境复跑证据见 §7.4）

**隔离环境 doctor（CLD-FIX-005）**
```
python clued.py doctor --json  → exit 0（干净隔离 clone：local HEAD = 临时 bare remote HEAD，worktree clean）
```

## 6. Required Scenarios（协议 §20 / §21.6）

| 场景 | 证据 |
|---|---|
| 多 Agent 同节点 | `test_second_agent_independent_binding` + `test_full_multi_agent_lifecycle`：独立 Binding/agent_id、共享 node_id、卸载互不影响 |
| 明确拒绝 | `test_cli_denied_exit_30` + `test_recovery_denied_locks` + `test_locked_no_degrade_no_access_no_lkg_use`：exit 30 → LOCKED，绝不降级、不读不写、不用旧 LKG |
| 弱网降级 | `test_cli_degraded_memory_write_and_sync` + `test_unavailable_with_fresh_lkg_degrades` + `test_degraded_write_keeps_worktree_clean_and_doctor_pass`：≤12s 预算、LKG ≤ 1h、30min 会话、写队列化、**工作树保持干净（doctor 可真实 PASS）** |
| 恢复重放 | `test_recovery_replays_and_confirms_remote` + `test_recovery_event_sequence_strict`：重新认证 → doctor PASS → pull → 乐观锁 → replay（同一 operation_id）→ 校验 → push → 远端确认后才 SYNCED |
| 冲突 | `test_recovery_conflict_snapshot_no_push` + `test_conflict_stops_whole_batch_no_push`：整批停止、不推送、base/ours/theirs 快照、CONFLICT_REVIEW、远端不覆盖 |
| 崩溃与失败 | `test_clued_recovery_crash.py` 13 项：doctor FAIL 阻断、pull/push/确认失败可重试、6 个崩溃点幂等恢复、残留自愈 |
| 离线卸载 | `test_uninstall_offline_revocation_pending` + `test_revoke_queue_runs_after_reconnect`：本地解绑 + REMOTE_REVOCATION_PENDING + 撤销队列联网后优先执行 |

## 7. Compatibility Evidence（含隔离验收）

1. **vNext-1.3**：`sync-memory.py/ps1` 零改动；70/70 回归全绿；Clued 经子进程复用其 pull/push/doctor/bootstrap，不绕过其密钥扫描、删除传播护栏、锁、分歧核验；恢复前严格服从其 doctor（不豁免、不把 FAIL 当预期状态）。
2. **vNext-2.0**：`memory_engine/**` 零改动；55/55 回归全绿；replay 经 `adapters.CLIAdapter` / `write_engine` 执行（同一 operation_id、同一对象 id），replay 后运行既有 `memory.py doctor` 验证。
3. **Git 协议不变量**：无 rebase、无 force push；远端确认用 `merge-base --is-ancestor`；doctor FAIL 阻断 canonical read/push（调用计数证据）；NO_CHANGE → NO_WRITE → NO_SYNC 有专门测试；回滚仅限 Clued 自己的未推送提交（`git reset --soft` + 精确 restore，绝不动用户工作）。
4. **隔离环境验收（CLD-FIX-005 + D4 收口后最终重测）**：临时目录 + 本地 bare remote + 从最终本地 HEAD 建立的干净 clone（协议/ADR/报告/D4 收口提交之后；docs/memory 提交不改变被测代码）；clone 内 local HEAD == 临时 remote HEAD、worktree clean；九套测试 + `clued.py doctor --json` 全绿。最终重测证据文件：`acceptance-evidence.txt`（临时目录，含每条命令退出码、测试计数、doctor 摘要、`git status --short` 为空、HEAD 对齐、真实远端前后一致、secret 扫描零命中）。全程零真实网络写入（本地 bare remote + fake auth provider + `proxy=""`）。

## 8. Known Limitations

| # | 限制 | 严重度 | 缓解 |
|---|---|---|---|
| L1 | GitHub 认证为账户级：无逐 Binding 远端令牌可撤销；`revoke()` 返回账户级说明并登记撤销队列，`remote_confirmed=False` | P1（v0.1 协议已预见：§2.3 认证平面解耦，未来换自有服务） | 撤销队列 + REMOTE_REVOCATION_PENDING 显式呈现 |
| L2 | 「远端撤销」在 v0.1 = Binding 标记 REVOKED + 队列任务，不涉及 gh 令牌本身 | P2 | 卸载摘要明示「远端撤销尚未确认」（§12.4） |
| L3 | 降级期间的本地读取以工作树缓存记忆为准；Pending 操作经 pending view 供写入目标解析与状态展示，召回索引在同步完成后才包含未同步操作 | P3 | 状态/doctor 展示 pending 数量；恢复 replay 后进入召回 |
| L4 | 熔断/降级状态为触发式（无后台线程/轮询，符合 §8.4 禁令）；OS 网络变化探测需 Adapter 显式调用 `clued sync` | P3 | 手动探测 + 新会话首次访问自动触发 |
| L5 | GitHub 认证可用性依赖本机 gh CLI 与代理配置（本机直连 GitHub 被阻断，需 127.0.0.1:7897 代理）；gh 缺失按能力缺失处理（CLD-CAP-001，不降级） | P2 | 预检第 10 项显式检测；错误码稳定 |
| L6 | `clued memory` 写路径 = Memory Object 层（vNext-2.0 双写架构下 Markdown 五文件仍由各端按既有纪律直接编辑，不经过 Clued CLI） | P3 | 与引擎语义一致，不重复实现 Markdown 写路径 |

## 9. Git Evidence

- 本轮追加本地提交（保留历史提交，无 amend/squash/rebase）：
  - `c4b2a57` protocol: approve one-hour LKG via ADR-CLD-001 (v0.2.0)
  - `50798dc` fix: enforce doctor-pass pull-before-replay recovery (CLD-FIX-002/003)
  - `e9eb7fe` test: recovery ordering, crash fault injection, D4 LOCKED gate
  - `0ce3062` fix: make journal created_at strictly monotonic per binding
  - `a0e356f` docs: refresh implementation and acceptance report (v0.2.0)
  - `d477ae2` memory: record Clued pre-release correction status
  - `b13a430` docs: correct final test counts in report (227 total)
  - `8738d1c` memory: correct test count in status entry (227)
  - （D4 收口轮提交见本轮回报：ADR-CLD-002 + 协议 §11.2/§15.4 + 报告 PASS + 实施文档 + 状态.md 登记）
- Exact remote HEAD：`77e0797344481519117defa626afea417a5f5f0b`（本轮未写入）
- Exact local/remote relationship：本地 ahead 远端（追加提交未 push）；隔离验收在干净 clone 中另建临时 bare remote 完成（真实 GitHub 零写入，验收前后 `ls-remote` 一致）
- Confirm：**no push / no PR / no tag / no release / no rebase / no force push**

## 10. Protocol Deviations

**当前偏差清单：空**（Result = PASS）。

历史处置记录（全部已解决并移出偏差清单）：

| # | 条款 | 处置 |
|---|---|---|
| D1 | §7.5 LKG 双界（1h/6h 不一致） | **已解决**：ADR-CLD-001 批准 `lkg_max_age = 1h`，协议升至 v0.2.0；实现/测试/文档单一语义（age ≤ 1h 有效、age > 1h 失效），无 6 小时残留 |
| D2 | §10.2 恢复顺序适配（先 fetch 后 pull） | **已解决**：降级写入改为 .clued/ staging（不改工作树），恢复前 doctor 真实 PASS；恢复严格 auth → doctor PASS → pull → replay → validate → push → verify，每步审计事件 |
| D3 | §10.1.4 恢复前 doctor 豁免 | **已解决**：豁免已删除；doctor FAIL 严格阻断 read/push；仅保留冻结层自身指令的「本地落后 → 先 pull 后复查必须 PASS」与「自身 replay 残留 → 精确自愈后复查必须 PASS」两类精确补救 |
| D4 | §11.2 增加 LOCKED → AUTH_REQUIRED 出口 | **已解决（D4 收口）**：产品所有者批准（ADR-CLD-002，ACCEPTED），转换与 8 项安全前提写入协议 §11.2.1（新在线认证严格 AUTHORIZED + 账户一致 + Binding ACTIVE + scope 合规 + 完整性检查 + 不使用旧 LKG + 审计 auth_recovered + 解锁后仍按每会话门禁）；LOCKED 期间禁降级/禁读写/禁用旧 LKG 维持不变；专项测试 3 项全绿 |

> 偏差清单为空 → 按执行计划 §9 规则，Result = **PASS**。

## 11. Next Actions（需产品决策）

1. **授权 push** 本实现（当前按协议 §18 未 push、未打 tag、未发布；真实仓库 doctor 在本轮未推送状态下按设计报告本地/远端不一致，push 授权后转绿）。
2. v0.2 候选：逐 Binding 远端凭证撤销（Clued 自有认证服务时实现真正 remote_confirmed 撤销）。
3. 是否把 `clued.py` 注册为系统级 `clued` 命令别名（协议 §13 允许扩展现有入口，当前以 `python clued.py` 形式交付）。
4. 下一阶段（需另行授权）：LKG 策略化（`balanced=6h` 建议默认 / `strict=1h`，独立 ADR-CLD-003，协议升至 0.3.0）与 Cross-Memory-System 瘦身（先只读 Bloat Audit + `compact --dry-run`，禁止任何真实删除）。
