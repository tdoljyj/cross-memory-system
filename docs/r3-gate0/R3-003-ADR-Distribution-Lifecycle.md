# ADR-R3-003：Distribution & Agent Lifecycle（分发与生命周期）合同

- **状态**：DRAFT（Gate 0 冻结用，未实施）
- **绑定**：`docs/r3-gate0/R3-000-baseline-receipt.json`（evidence HEAD = `9dcc31b`）
- **范围**：artifact 分类与模型下载隔离、manifest schema/根信任/固定 revision/hash/cache-staging、六动作（install/repair/update/disable/enable/uninstall）、三轴状态模型与稳定错误码、multi-binding 共享与隔离、remote disable/revoke queue、last-binding cleanup、Truth conformance 作为 ENFORCED 绝对前置、兼容/迁移/回滚/协议版本变化。
- **协议变更纪律**：若本 ADR 引入 DISABLED 等语义改变现有生命周期协议（`clued/state_machine.py` 11 态），**必须按变更控制升级协议（manifest 先行），不得直接改代码**。

---

## 1. Artifact 分类与模型下载隔离

### 1.1 Artifact 分类

| 类别 | 定义 | 校验要求 |
|---|---|---|
| `product` | 产品自身可执行/模块（clued 包、sync 脚本、schema） | manifest 登记 + SHA-256 + 大小上限 + 固定 revision |
| `adapter` | 端侧适配器（codex/workbuddy/dsh 绑定副本） | 同上 + 平台/Agent/协议兼容性校验 |
| `binding-config` | Binding 配置、manifest、凭据元数据 | 同上（凭据本体永不入 manifest） |
| `model` | Embedding 权重/依赖/probe/cache/index | **独立 manifest，永不与 product 混入；默认禁止下载**（见 1.2） |
| `documentation` | ADR/报告/README | 不校验 hash（可追溯即可） |

### 1.2 模型下载隔离（明确禁止条款）

- Embedding 模型权重、依赖、probe、cache、index **全部不授权**（Gate 0 指令 + MIV-005B NO-GO 双重确认）；
- 若未来授权：必须走独立 `model-manifest`、独立 staging 目录、独立 allowlist、独立配额；**产品 manifest 中出现 model 条目 = 校验失败**；
- 本 ADR 生效期内系统不提供任何模型下载能力。

## 2. Manifest Schema、根信任、固定 revision

### 2.1 Manifest schema（草案 v1）

```json
{
  "schema_version": 1,
  "manifest_type": "product" | "adapter" | "binding-config" | "model",
  "release_id": "vNext-2.1-R3-G1",
  "revision": "<固定 revision，禁止 latest 标签>",
  "created_at_utc": "...",
  "artifacts": [
    {
      "path": "clued/controller.py",
      "sha256": "<hex>",
      "size_bytes": 12345,
      "max_size_bytes": 65536,
      "platforms": ["win32"],
      "agent_types": ["workbuddy", "codex"],
      "protocol_min": "0.3.0",
      "protocol_max": "0.3.x"
    }
  ],
  "trust": {
    "root": "GPG 指纹或 allowlist 哈希链",
    "signature": "<detached sig>"
  }
}
```

### 2.2 根信任与固定 revision

- 根信任 = 仓库内 `allowlist`（固定 revision → SHA-256 白名单），校验链：`allowlist → manifest → artifact`；
- **禁止跟随 latest**：一切下载引用固定 revision；manifest 中 revision 必须与 allowlist 匹配；
- 每 artifact：SHA-256 全量校验 + 大小上限（防 zip bomb）+ 平台/Agent/协议兼容性矩阵校验；
- 未校验或部分 artifact **永不执行**（§18）。

## 3. Cache / Staging / 原子切换

| 环节 | 规则 |
|---|---|
| 下载 | 受限（仅 allowlist 内 URL 前缀）、staging 落盘、单飞锁（同 revision 单下载）、部分下载断点续传、有界重试（3 次 + 抖动）、全量校验后才进入 verified 区 |
| cache | verified staged receipt 记录；retention 策略可配置（默认保留最近 2 个 revision） |
| 原子切换 | verified 区 → 正式区走原子 rename；失败回滚到旧版本并保留 residue 报告 |
| 脱敏 | 日志脱敏（URL 凭证、token），下载进度不泄露路径细节 |

## 4. 生命周期六动作（语义冻结）

| 动作 | 语义 | 前置条件 | 原子性/幂等/回滚 |
|---|---|---|---|
| `install` | 创建 Agent Binding（安装单位 = Agent Binding，非物理设备）；事务：预检（capability/protocol/doctor/runtime_root）→ staging → manifest 写入 → ACTIVE 或 AUTH_REQUIRED | 无既有 Binding；doctor ALL PASS；Truth conformance 通过才可 ENFORCED | 原子（失败全回滚）；幂等（重复安装返回 ALREADY_INSTALLED）；回滚=清 staging + 状态复位 |
| `repair` | 检测 tamper/缺失 → 按 manifest 重装该 Binding | Binding 存在 | 原子；幂等 |
| `update` | manifest 驱动 staged update → migration dry-run → 原子切换 → 旧版保留 → 重新 conformance | 下载校验通过；迁移 dry-run 无阻塞 | 原子；回滚到旧版本；失败不清除旧版 |
| `disable` | 本地立即停用（状态 DISABLED，凭据本地失效、Pending 保留）；远端状态确认/排队（revoke queue） | Binding 存在且非 UNINSTALLED | 幂等；**DISABLED 不得保留 ENFORCED**（降档规则见 §6） |
| `enable` | fresh-auth 重认证 → Doctor → Truth re-conformance → 恢复 | Binding 为 DISABLED | 幂等；失败保持 DISABLED |
| `uninstall` | detach-current-agent → 精确 manifest 删除 → 本地凭据立即失效 → remote revoke queue 入队 → 其他 Binding 零影响 | Binding 存在 | 幂等（再次卸载返回 ALREADY_UNINSTALLED）；默认只影响当前 Binding |

## 5. 三轴状态模型（冻结）

```
轴1 Binding 生命周期：UNINSTALLED → INSTALLING → {AUTH_REQUIRED, ONLINE_SYNCED, ONLINE_DIRTY,
                      DEGRADED_LOCAL, RECOVERING, CONFLICT_REVIEW, LOCKED, DISABLED*}
                      → UNINSTALLING → UNINSTALLED
     *DISABLED 为新增状态（现 state_machine 11 态无此状态）——协议升级项
轴2 会话/同步：ONLINE / DEGRADED / LOCKED（表达在轴1状态内或附加属性）
轴3 Truth 能力：UNAVAILABLE → ADVISORY → AUDIT → ENFORCED（与 ADR-R3-002 §9/§10 联动）
```

**不变式（必须被测试锁定）**：
- `INSTALLED 态`（INSTALLED_STATES ∪ {DISABLED}）与 ENFORCED 无必然关系；ENFORCED 必须额外满足 ADR-R3-002 §10；
- `DISABLED / UNINSTALLED` 状态 **禁止**携带 ENFORCED 能力档位；
- 若保留 `ACTIVE + ADVISORY/AUDIT` 组合，必须由本 ADR 明确限定并对用户标为 PARTIAL（§8）；
- 状态迁移必须过单一 Lifecycle Controller（operation_id + 锁 + 审计 + 幂等）。

## 6. 稳定错误码（草案）

| 码 | 含义 |
|---|---|
| `CLD-INSTALL-001` | 安装预检失败（保留既有码；子项 detail 区分 runtime_root/doctor/capability…） |
| `CLD-INSTALL-002` | 重复安装（ALREADY_INSTALLED，幂等成功语义） |
| `CLD-REPAIR-001` | 修复失败（tamper 未消除） |
| `CLD-UPDATE-001` | 更新下载/校验失败 |
| `CLD-UPDATE-002` | 迁移 dry-run 阻塞 |
| `CLD-DISABLE-001` | 停用失败（锁定/事务中断） |
| `CLD-ENABLE-001` | 启用失败（fresh-auth 未通过 / conformance FAIL） |
| `CLD-UNINSTALL-001` | 卸载失败（精确删除不完整） |
| `CLD-CAP-001` | capability 不满足（既有，§1.4 引用） |
| `CLD-DIST-001` | manifest 校验失败（hash/revision/allowlist） |
| `CLD-DIST-002` | 下载被 allowlist 拒绝 |
| `CLD-REVOKE-001` | 远端 revoke 入队失败（离线 = 标记 REVOKE_PENDING，不伪报完成） |

## 7. Multi-Binding 共享与隔离

| 资源 | 共享 | 隔离 |
|---|---|---|
| 产品代码/artifact store | 共享（同一安装基底） | 只读共享，binding 不得改 |
| binding manifest / 凭据 | 隔离 | 每 binding 独立目录 |
| Pending journal | 隔离 | 每 binding 独立 |
| revoke queue | 共享队列 + per-binding 条目 | 互不串扰 |
| 记忆对象库 | 共享 Canonical Store | 经 memory engine 门禁 |

- 默认卸载只影响当前 Binding；其他 Binding、shared runtime、canonical memories 零误伤；
- last-binding cleanup：最后一个 Binding 卸载时可回收共享产物（allowlist 保留），必须走显式清理事务并记录。

## 8. Truth conformance 作为 ENFORCED 的绝对前置

- 安装/更新/启用后欲达 ENFORCED，必须：在线认证 + Doctor ALL PASS + manifest 完整 + capability conformance 全过（ADR-R3-002 §10）；
- 任一 FAIL → 档位降为 ADVISORY/AUDIT 并在 status 输出中显式标 `"truth": "PARTIAL"`；
- 离线 disable/revoke 必须准确标记 `REVOKE_PENDING`，**不得伪报远端完成**（§18）。

## 9. 兼容、迁移、回滚与协议版本变化

- 协议版本变化：新 schema 必须兼容旧 manifest（向后读）；`protocol_version` 升版走 manifest 先行，禁止直接改代码行为；
- 三处版本号不一致（protocol-manifest vNext-1.3 / VERSION vNext-2.0 / clued 0.3.0）在 Gate 1 统一为单一版本源；
- 迁移：旧 Binding（无 capability 记录）→ 迁移为 ADVISORY + 标记 legacy；不自动升级 ENFORCED；
- 回滚：update 失败回滚旧版本；disable 失败保持原状态；卸载失败进入 UNINSTALL_ERROR 并可重试。

---

## 10. 与 ADR-R3-002 的联动（不可分割）

1. 任何生命周期状态输出（status/install/uninstall 结果）含 current 类 claim → 必须带 Truth receipt；
2. ENFORCED 判定唯一来源 = Truth conformance（ADR-R3-002 §10），Lifecycle 只消费该判定；
3. 六动作全部原子、幂等、可回滚；DISABLED/UNINSTALLED 不保留 ENFORCED；默认卸载只影响当前 Binding —— 这些是 §18 成功定义的 Lifecycle 侧条件。
