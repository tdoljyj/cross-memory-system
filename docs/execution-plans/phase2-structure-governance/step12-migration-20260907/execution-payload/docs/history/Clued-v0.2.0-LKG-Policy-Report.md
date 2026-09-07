# Clued v0.2.0 LKG Policy Report（阶段 B：LKG 策略化）

> 协议：《Clued v0.1 智能体安装、授权、弱网降级与卸载协议》
> （Clued Agent Lifecycle Protocol **v0.3.0**，FROZEN 2026-08-18；
>  LKG 策略经 **ADR-CLD-003** 固化：balanced=6h / strict=1h；
>  ADR-CLD-001 的 LKG 取值维度被 supersede，历史事实保留）
> 产品：Clued v0.2.0
> 实现执行者：DeepSeek V4 Pro（DSH@TURING）
> 实现基线：cross-memory-system / vNext-2.0
> 本轮：阶段 B（LKG 策略化）——仅追加本地提交，未 push / 未 tag / 未发布

---

## 1. Result

- **PASS**（策略实现、迁移、边界与回归全部通过；偏差清单为空）
- Product version：Clued **v0.2.0**
- Protocol version：Clued Agent Lifecycle Protocol **v0.3.0**（ADR-CLD-003）
- Branch：`main`
- Exact local HEAD：见「9. Git Evidence」（本轮全部提交均为本地提交）
- 验收不变量：TESTED_HEAD = FINAL_REPORT_HEAD = `git rev-parse HEAD` = 临时 bare remote HEAD（见 §7.4）
- Exact remote HEAD：`7efa73b659369caf844c2826781c32a2845e3463`（本轮未写入）
- Ahead/behind：本地 ahead 远端（本轮追加提交；**未 push**）
- Worktree：clean
- Confirm：**not pushed / no PR / no tag / no release / no rebase / no force push**

## 2. 策略合同（协议 §7.5 / ADR-CLD-003）

| 项 | 值 |
|---|---|
| `balanced` lkg_max_age | **6 小时**（新装默认） |
| `strict` lkg_max_age | **1 小时**（v0.1.0 升级保守迁移） |
| degraded session TTL | 30 分钟（不变） |
| effective_degraded_until | `min(lkg_authorized_at + policy.lkg_max_age, degraded_session_started_at + 30min)` |
| 新装默认 | `balanced`（installer 写入 binding manifest） |
| v0.1.0 遗留升级 | 无 `auth_policy` 字段 → 首次加载保守迁移 `strict`（幂等 + `policy_migrated` 审计一次） |
| 切到 balanced | 仅显式命令 `clued auth policy --binding-id <id> --set balanced`（`policy_change` 审计） |
| fail closed | 未知策略名 / 任意自定义秒数 / 超过 6h → `CLD-AUTH-006` 拒绝 |
| 不变量 | 每会话首次 Memory Access 在线尝试；仅 `UNAVAILABLE` 降级；`DENIED`/`DENIED_SECURITY`/账户变化/scope 缩减/Binding 异常/完整性失败 → 立即 LOCKED |

## 3. Changed Files（阶段 B）

**Added**
```
ADR-CLD-003-LKG-Policy-Profiles.md        # LKG 策略化 ADR（ACCEPTED，协议 v0.3.0 / 产品 v0.2.0）
clued/auth/policy.py                      # 唯一权威策略注册表（balanced/strict、默认/迁移值、6h 上限、resolve）
tests/test_clued_policy.py                # 策略/迁移/绝对截止/fail closed/status·doctor 呈现（22 项）
Clued-v0.2.0-LKG-Policy-Report.md（本文件）
```

**Modified**
```
clued/__init__.py                         # __version__ 0.2.0 / PROTOCOL_VERSION 0.3.0 / RUNTIME_VERSION 0.2.x
clued/auth/engine.py                      # 策略解析 lkg_max_age_for；有效截止 min()；degraded_started_at；
                                          # 未知策略/超 6h → CLD-AUTH-006 fail closed
clued/auth/authcache.py                   # POLICY_VERSION 0.1 → 0.2（旧缓存按自身版本自洽校验）
clued/manifests.py                        # binding manifest auth_policy 字段；校验未知策略 fail closed；
                                          # POLICY_VERSION 0.2
clued/registry.py                         # 遗留 Binding 保守迁移 strict（幂等 + policy_migrated 审计）
clued/controller.py                       # status 策略/LKG/窗口字段；doctor policy_<id> 检查；
                                          # auth_policy 命令；protocol_version 0.3.0
clued/cli.py                              # `clued auth policy [--set]` 子命令
clued/errors.py                           # CLD-AUTH-006
clued/audit.py                            # policy_migrated / policy_change 事件类型
clued/identifiers.py                      # epoch_to_rfc3339
clued/installer.py                        # 新装 Binding 默认 auth_policy=balanced
clued/codex_adapter.md                    # 意图表补 auth policy 命令
clued/recovery.py / pending_journal.py / memory_gate.py  # 头注 v0.3.0
tests/test_clued_auth.py                  # 超 6h 拒绝（21601s）；≤6h 覆盖允许
tests/test_clued_unit.py / test_clued_e2e.py  # 信封 protocol_version 0.3.0
Clued-v0.1-实施与复用文档.md               # 决策 3 superseded 注记 + 新增决策 11/12 + 版本头
ADR-CLD-001-LKG-Max-Age-One-Hour.md       # 标记 superseded by ADR-CLD-003（历史事实保留）
Clued_v0.1_智能体安装授权弱网降级与卸载协议.md  # v0.3.0：§0/§7.5/§13/§14/§17/§19.2/§22/§24
memory/状态.md                             # 阶段 B 登记（记忆纪律）
```

**Intentionally untouched core files（冻结区，一字未改）**
`sync-memory.py`、`sync-memory.ps1`、`memory.py`、`memory_engine/**`、`adapters/**`、`migrate-memory.py`、`guards.json`、`protocol-manifest.json`、`tests/test_acceptance.py`、`tests/test_memory_v2.py`、`AGENTS.md`、两份架构基线文档、`vNext-2.0-实施冲突记录.md`。

## 4. Architecture

- **策略权威源**：`clued/auth/policy.py`（POLICY_PROFILES / DEFAULT_POLICY /
  UPGRADE_POLICY / MAX_LKG_MAX_AGE_S / resolve_lkg_max_age）。禁止其它模块
  硬编码秒数。
- **裁决路径**：`AuthEngine.lkg_max_age_for(binding)` = 显式覆盖（仅缩短）>
  Binding.auth_policy > 引擎缺省（strict，保守）。`_degrade_decision` 用策略
  上限判 age，并以 `min(lkg_expires_at, session_expires_at)` 生成有效截止
  （写入 SessionRecord.degraded_started_at / degraded_until）。
- **迁移路径**：`AgentRegistry._migrate_auth_policy` —— 无 `auth_policy` 字段
  = clued-v0.1.0 遗留 → 写盘 strict + `policy_migrated` 审计（幂等，仅一次）。
- **命令路径**：`clued auth policy --binding-id <id> [--set balanced|strict]`
  —— 只读返回或显式切换（`policy_change` 审计；未知策略 CLD-AUTH-006）。
- **呈现路径**：`status` 每 Binding 输出 auth_policy / lkg_max_age /
  lkg_authorized_at / lkg_expires_at / degraded_session_expires_at /
  effective_degraded_until（全部派生非秘密）；`doctor` 逐 Binding
  `policy_<id>` 检查。

## 5. Test Evidence

**既有回归（零修改，全绿）**
```
python tests/test_acceptance.py        → 70/70 PASS（vNext-1.3 同步层）
python tests/test_memory_v2.py         → 55/55 PASS（vNext-2.0 记忆引擎）
```

**Clued 既有套件（协议版本断言更新至 0.3.0，其余零修改）**
```
python tests/test_clued_unit.py           → 27/27 PASS
python tests/test_clued_auth.py           → 18/18 PASS（含超 6h 拒绝更新）
python tests/test_clued_install.py        → 10/10 PASS
python tests/test_clued_pending.py        → 15/15 PASS
python tests/test_clued_recovery_crash.py → 13/13 PASS
python tests/test_clued_uninstall.py      → 11/11 PASS
python tests/test_clued_e2e.py            → 8/8 PASS
```

**新增策略/迁移测试（ADR-CLD-003，22 项）**
```
python tests/test_clued_policy.py         → 22/22 PASS
  balanced: 5h59m59s 可降级 / 6h00m00s 边界有效 / >6h 禁止降级
  strict:   59m59s 可降级 / 60m00s 边界有效 / >60m 禁止降级
  遗留 Binding 无 auth_policy → 按 strict 裁决（不静默放宽）
  有效截止 = min(LKG 到期, 会话到期)（600s 而非 1800s）
  运行中会话不越过 LKG 绝对截止；重新评估仍受 min() 约束
  每策略新会话仍在线尝试；DENIED / DENIED_SECURITY 与策略无关立即拒绝
  未知策略构造器/命令 → CLD-AUTH-006；未知策略 manifest fail closed
  >6h 秒数 fail closed；Adapter 不能扩大策略（注册表权威）
  新装默认 balanced；遗留迁移 strict 幂等（审计仅一次）
  显式命令切换策略（policy_change 审计×2）；同值切换无变化
  status 六字段齐全且无凭据样值；doctor 呈现当前策略
```

**合计：249 项，0 失败，0 跳过。**（隔离环境复跑证据见 §7.4）

**隔离环境 doctor**
```
python clued.py doctor --json  → exit 0（干净隔离 clone：local HEAD = 临时 bare remote HEAD，worktree clean）
```

## 6. Required Scenarios（协议 §20 / §21.6）

| 场景 | 证据 |
|---|---|
| 新装默认策略 | `test_new_install_defaults_to_balanced`：install → binding.auth_policy=balanced |
| v0.1.0 升级不扩大权限 | `test_legacy_binding_migrates_to_strict_idempotent`：剥除字段 → strict + 审计一次 + 幂等 |
| 绝对截止 | `test_effective_degraded_until_is_min_of_lkg_and_session` / `test_running_degraded_session_cannot_cross_lkg_deadline` |
| fail closed | `test_unknown_policy_*` / `test_over_6h_seconds_fail_closed` / `test_adapter_cannot_expand_policy` |
| 显式切换 | `test_explicit_command_switches_policy`（policy_change 审计；未知策略拒绝；同值无变化） |
| 明确拒绝与安全错误 | `test_denied_locks_regardless_of_policy` / `test_tls_denied_security_never_degrades_with_balanced` |
| 呈现 | `test_degraded_status_shows_policy_and_window_fields` / `test_doctor_reports_policy` |

## 7. Compatibility Evidence（含隔离验收）

1. **vNext-1.3**：`sync-memory.py/ps1` 零改动；70/70 回归全绿。
2. **vNext-2.0**：`memory_engine/**` 零改动；55/55 回归全绿。
3. **Git 协议不变量**：无 rebase、无 force push；本轮全部为追加本地提交。
4. **隔离环境验收**：临时目录 + 本地 bare remote + 从最终本地 HEAD 建立的
   干净 clone（bootstrap 后）；clone 内 local HEAD == 临时 remote HEAD、
   worktree clean；十套测试 249 项 + `clued.py doctor --json` 全绿
   （证据文件：`acceptance-evidence.txt`，临时目录；含每条命令退出码、测试
   计数、doctor 摘要、`git status --short` 为空、HEAD 对齐、真实远端前后
   一致、secret 扫描零命中）。全程零真实网络写入。

## 8. Known Limitations

| # | 限制 | 严重度 | 缓解 |
|---|---|---|---|
| L1 | 策略切换为本地显式命令；若本地运行时被完全控制，攻击者可切换 balanced 扩大降级窗口 | P3（本地运行时已被控制时 LKG 本身可被读取/替换，不新增威胁面） | policy_change 审计 + 切换需显式命令；降级仍受 30min 会话与在线认证约束 |
| L2 | Authorization Cache policy_version 升至 0.2；旧 0.1 缓存仍按自身版本自洽校验（strict 语义下可用），不强制重建 | P3 | 下次在线认证自然刷新为 0.2 缓存 |
| L3 | status/doctor 的窗口字段为派生值，跨进程并发下可能短暂不一致（无锁读取） | P3 | 仅展示用途，裁决以 engine 实时计算为准 |

## 9. Git Evidence

- 本轮追加本地提交（保留历史提交，无 amend/squash/rebase）：
  - （阶段 B 提交见本轮回报：ADR-CLD-003 + 协议 v0.3.0 + 实现 + 测试 + 报告 + 状态.md 登记）
- Exact remote HEAD：`7efa73b659369caf844c2826781c32a2845e3463`（本轮未写入）
- Exact local/remote relationship：本地 ahead 远端（追加提交未 push）；隔离验收在干净 clone 中另建临时 bare remote 完成
- Confirm：**no push / no PR / no tag / no release / no rebase / no force push**

## 10. Protocol Deviations

**当前偏差清单：空**（Result = PASS）。ADR-CLD-001 的 LKG 取值维度按变更控制
被 ADR-CLD-003 supersede（历史事实保留，非偏差）。

## 11. Next Actions（需产品决策）

1. 授权 push 阶段 B（真实仓库 doctor 在未推送状态下按设计报告本地/远端不一致，push 授权后转绿）。
2. 阶段 C（Cross-Memory-System 瘦身：先只读 Bloat Audit + `compact --dry-run`，禁止真实删除）待另行授权。
3. 是否对阶段 B 发布打 tag（如 `clued-v0.2.0`）。
