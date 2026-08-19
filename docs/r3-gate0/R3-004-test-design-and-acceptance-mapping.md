# R3-004 测试设计与验收映射（Gate 0 冻结）

- **绑定**：`docs/r3-gate0/R3-000-baseline-receipt.json`（evidence HEAD = `9dcc31b`）
- **基线事实**：现有 16 个测试文件；本机基线 = 245 PASS / 60 FAIL / 31 SKIP / 0 ERROR；60 FAIL 全部归因 ENV-DEFECT-001/002（见 receipt），非逻辑否决；31 SKIP 为 ps1 系列（PortableGit 护栏）。
- **本文件**：定义 Gate 1/2 将交付的新测试设计（fixture/MUST 映射/fault injection/零副作用证明/预算），**不实现**（实现属 Gate 1/2 范围）。

---

## 1. 测试套件分层

| 层 | 命名前缀 | 运行环境 | 用途 |
|---|---|---|---|
| Truth 原语 | `TST-T-*` | 临时 home + 临时 bare remote | planner/provider/binder/receipt/gate 单测与集成 |
| Distribution | `TST-D-*` | 本地 http 桩（allowlist 模拟） | manifest/下载/校验/staging/回滚 |
| Lifecycle | `TST-L-*` | 临时 home + 临时 bare remote + 合成 Agent | 六动作原子性/幂等/回滚/multi-binding |
| Cross-cutting | `TST-X-*` | 同 Lifecycle | conformance、零副作用、预算、e2e |

## 2. Fixture 设计

| fixture | 内容 |
|---|---|
| `fixtures/truth/` | 合成 receipt 集（有效/过期/篡改/无 HEAD）、claim 冲突集 |
| `fixtures/dist/` | 迷你 product artifact 树 + manifest（合法/缺 hash/超大小/越 revision/混入 model 条目） |
| `fixtures/lifecycle/` | 合成 Agent 配置、binding manifest、revoke queue 样例、DISABLED 迁移样例 |
| `fixtures/repo/` | 脱敏仓库快照（无真实记忆/凭据）——**脱敏 fixture，禁止含真实 memory/remote** |

## 3. MUST → 测试 ID 映射（Truth，来自 ADR-R3-002）

| MUST | 测试 ID | 判据 |
|---|---|---|
| 四类事实模型存在且守恒 | `TST-T-001` | stable/historical/current/mixed 分类正确；current 不来自记忆 |
| claim types 枚举与证据形态 | `TST-T-002` | 15 种 claim type 均可产出/校验 |
| source precedence 冲突裁决 | `TST-T-003` | 现场>receipt>报告>记忆；不可裁决 → UNVERIFIED |
| Truth Request/Receipt schema | `TST-T-004` | schema 校验 + 自含 digest 可离线校验 |
| 现场核验算法 | `TST-T-005` | ls-remote/status/ahead-behind 现场取证；verified_at 记录；交叉校验 |
| 远端不可达 → UNVERIFIED + 只报最后已知态 | `TST-T-006` | 断网注入 |
| Evidence Binder 四 HEAD 关系 | `TST-T-007` | tested==target；final_report≥tested；非法组合拒绝 |
| Claim Gate 拦截 | `TST-T-008` | 无 receipt/过期/篡改/能力不匹配 四类均被拦截；成功返回=0 |
| LKG 与 current 区分 | `TST-T-009` | LKG 必须带 verified_at+receipt 引用；不得伪装 current |
| Adapter 不直 Git、不自判 PASS | `TST-T-010` | 接口层注入 git 调用 → 拒绝 |
| feature flag 迁移回滚 | `TST-T-011` | legacy→ADVISORY→AUDIT→ENFORCED 逐档 + 回滚 |
| ADVISORY/AUDIT/ENFORCED 判定 | `TST-T-012` | 各档条件不全则拒升；DISABLED/UNINSTALLED 无 ENFORCED |

## 4. MUST → 测试 ID 映射（Distribution，来自 ADR-R3-003）

| MUST | 测试 ID | 判据 |
|---|---|---|
| artifact 分类与 model 隔离 | `TST-D-001` | model 条目入 product manifest → 校验失败 |
| manifest schema 校验 | `TST-D-002` | 缺 hash/超大小/越 revision/错平台 → 拒绝 |
| 固定 revision 禁 latest | `TST-D-003` | latest 引用拒绝 |
| allowlist 根信任链 | `TST-D-004` | allowlist→manifest→artifact 链断裂拒绝 |
| 受限下载 + staging + 单飞锁 | `TST-D-005` | 非白名单 URL 拒绝；并发同 revision 单下载 |
| 部分下载恢复 + 有界重试 | `TST-D-006` | 断点续传；3 次重试后 FAIL |
| 全量 SHA-256 校验后执行 | `TST-D-007` | 未校验 artifact 永不执行 |
| 原子切换 + 失败回滚 + residue 报告 | `TST-D-008` | 切换中断 → 旧版存活 + residue 报告 |
| 脱敏日志 | `TST-D-009` | 日志无 token/URL 细节 |

## 5. MUST → 测试 ID 映射（Lifecycle，来自 ADR-R3-003 §4-8）

| MUST | 测试 ID | 判据 |
|---|---|---|
| install 事务原子/幂等/回滚 | `TST-L-001` | 中途失败全回滚；重复安装 ALREADY_INSTALLED |
| repair 重装 | `TST-L-002` | tamper 检测 → 按 manifest 修复 |
| update staged+原子+回滚 | `TST-L-003` | 迁移 dry-run 阻塞则中止；失败回滚旧版 |
| disable 本地立即 + 远端排队 | `TST-L-004` | DISABLED 状态；凭据失效；revoke queue 入队；离线 → REVOKE_PENDING 不伪报 |
| enable fresh-auth + re-conformance | `TST-L-005` | 认证失败保持 DISABLED |
| uninstall 默认仅当前 Binding | `TST-L-006` | 其他 binding/shared/记忆零误伤；再次卸载 ALREADY_UNINSTALLED |
| 三轴不变式 | `TST-L-007` | DISABLED/UNINSTALLED 无 ENFORCED；INSTALLED 需证据才 ENFORCED |
| 稳定错误码 | `TST-L-008` | CLD-* 码与 §6 表一致 |
| multi-binding 隔离 | `TST-L-009` | pending/凭据/queue 互不串扰 |
| last-binding cleanup | `TST-L-010` | 回收共享产物但 allowlist 保留 |
| conformance 前置 | `TST-L-011` | conformance FAIL → 降 ADVISORY/AUDIT + 标 PARTIAL |
| 单 Lifecycle Controller | `TST-L-012` | operation_id/锁/审计/幂等 全记录 |

## 6. Fault injection 点

| 注入点 | 手段 | 观察 |
|---|---|---|
| ls-remote 断网 | mock provider 抛网络异常 | UNVERIFIED + reason |
| manifest 篡改 | 改 1 bit | digest 校验失败 |
| 下载中断 | http 桩断流 | staging 部分文件 + 恢复/重试 |
| 切换 rename 失败 | 目标目录只读 | 回滚 + residue |
| 认证服务器 5xx | mock auth | DENIED/UNAVAILABLE 路径 |
| revoke 回调失败 | mock 远端拒收 | REVOKE_PENDING 标记 |
| doctor FAIL | 注入 refs/remotes 故障 | install 预检 FAIL（本机天然可复现） |

## 7. 真实数据零副作用证明方法

每 Gate 完成时执行（与 R3-000 相同方法）：

1. 记录真实 memory 目录全部文件 SHA-256 聚合 + 冻结区 8 文件 SHA（对比本 receipt 基线）；
2. `git status --porcelain` 证明 worktree 无真实文件修改；
3. 证明测试运行于临时 home / 临时 bare remote / 脱敏 fixture（环境变量 + 目录断言）；
4. secret scan（guards.json patterns）0 命中；
5. 所有测试内 git 写操作限定在 temp 路径。

## 8. 性能 / 磁盘 / 网络预算测量方案

| 维度 | 测量 | 预算（草案） |
|---|---|---|
| Truth 核验延迟 | p50/p95 每次回答前 gate | p95 ≤ 200ms（本地）/ ls-remote 异常时 ≤ 2s 降级 |
| 测试总时长 | CI 或本地全套 | ≤ 30 min（现有 acceptance 单文件 7 min 为基线参考） |
| 下载吞吐 | staging 写入速率 | 有界重试内完成；单文件 ≤ 100MB |
| 磁盘 | cache retention | 默认保留 2 revision；超限自动清理并记录 |
| 网络 | 下载字节数 | allowlist 内 URL 仅；失败重试 3 次封顶 |

## 9. Gate 1 与 Gate 2 的精确修改范围

| Gate | 允许修改 | 禁止 |
|---|---|---|
| Gate 1（Core Foundations） | 新增 `memory_engine/truth/` 模块（planner/provider/binder/receipt）、`clued/` 内 manifest 校验与下载核心、测试（TST-T/D 系列）、文档 | 不改真实 Binding 状态；不对真实用户 Binding 安装/升级；不下载真实产品 artifact |
| Gate 2（Enforcement + Full Lifecycle） | Claim Gate、Adapter 公共合同扩展、六动作完整实现（含 DISABLED 状态协议升级）、capability binding、TST-L/X 系列 | 全程在临时 home + 临时 bare remote + 合成 Agent + 无真实凭据环境；真实环境试装需单独授权 |
| 通用 | 版本号统一（protocol-manifest/VERSION/clued 单一版本源） | 不得修改真实 memory objects/index；不得触碰 MIV-005A 范围与 MIV-005B NO-GO |

---

## 10. 与 §18 成功定义的验收锚点

- `TST-T-008` 锁"current claim 无有效 receipt 成功返回 = 0"；
- `TST-D-007` 锁"未验证/部分 artifact 从未执行"；
- `TST-L-006/007/011` 锁"默认卸载仅当前 Binding / DISABLED·UNINSTALLED 无 ENFORCED / conformance 前置"；
- 全套绿 + Doctor ALL PASS + secret 0 + 真实 memory hash 不变 + TESTED_HEAD=FINAL_REPORT_HEAD=HEAD 齐备后，才可宣称"已确保"。
