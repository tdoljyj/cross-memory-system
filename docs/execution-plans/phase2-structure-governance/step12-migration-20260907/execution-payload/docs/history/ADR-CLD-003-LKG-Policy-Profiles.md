# ADR-CLD-003：LKG 策略配置文件（balanced=6h / strict=1h）

- **Status**：`ACCEPTED`
- **Date**：2026-08-18
- **Decider**：Product Owner
- **Protocol**：Clued Agent Lifecycle Protocol **v0.3.0**（自 v0.2.0 升级）
- **Product**：Clued **v0.2.0**（产品名从「Clued v0.1」升级）
- **Supersedes**：ADR-CLD-001（仅限 LKG 最大年龄取值维度；ADR-CLD-001 的历史事实与
  30 分钟降级 TTL 语义不变）
- **Related**：ADR-CLD-002（LOCKED → AUTH_REQUIRED，不受影响）

---

## 1. 背景

ADR-CLD-001（协议 v0.2.0）把 LKG 最大年龄固化为**唯一值 1 小时**，作为所有场景
的强安全默认。但对个人跨端、GitHub/代理偶发不可达的日常场景，1 小时窗口过于
苛刻：一次超过 1 小时的弱网窗口会直接失去本地优先能力，而 30 分钟降级会话
TTL 本身已经限制了单次降级时长。

产品所有者决定把 LKG 改为**固定策略配置**（语义策略名，不允许任意秒数），
并明确规定新装与升级的默认策略差异，杜绝静默扩大权限。

## 2. 决定

### 2.1 固定策略表（唯一权威值，见 `clued/auth/policy.py`）

| Policy | LKG 最大年龄 | 定位 |
|---|---:|---|
| `balanced` | **6 小时** | **新安装默认**；个人跨端、GitHub/代理偶发不可达 |
| `strict` | **1 小时** | **从 clued-v0.1.0 升级的既有安装保守迁移值**；高安全需求、短授权容忍 |

保持不变：

- 每个新会话首次 Memory Access 仍必须在线认证尝试（§7.1）；
- 只有 `UNAVAILABLE` 可以评估降级；`DENIED` / `DENIED_SECURITY`、账户变化、
  scope 缩减、Binding 异常或完整性失败立即 `LOCKED`（§7.4）；
- 单次 degraded session TTL 仍为 **30 分钟**；
- 超过当前策略 LKG 上限后，不删除本地记忆和 Pending，只暂停私有 Memory
  Access，等待在线认证恢复。

### 2.2 有效降级截止时间（绝对截止）

```text
effective_degraded_until
= min(
    lkg_authorized_at + policy.lkg_max_age,   -- LKG 到期
    degraded_session_started_at + 30min       -- 降级会话到期
  )
```

运行中的降级会话**不得越过 LKG 绝对截止时间**：不能在 LKG 临近失效时额外获得
完整 30 分钟。会话到期（有效截止）后，下一次 Memory Access 重新在线尝试；
若仍 `UNAVAILABLE` 且 LKG 仍有效，可开启新的降级会话（新会话的有效截止
重新按 min() 计算）。

### 2.3 迁移语义（不得静默扩大权限）

- **新安装**（install 创建新 Binding）：默认 `balanced`（6h），写入 Binding
  manifest 的 `auth_policy` 字段；
- **从 clued-v0.1.0 升级的既有安装**：Binding manifest 无 `auth_policy` 字段
  → 首次加载时**保守迁移为 `strict`（1h）**，绝不静默从 1h 放宽到 6h；
  迁移确定性且幂等（迁移后字段存在，不再重复写/重复审计），并写
  `policy_migrated` 审计事件；
- **切换到 `balanced` 只能经显式命令**（`clued auth policy --binding-id <id>
  --set balanced`），每次切换写 `policy_change` 审计事件；迁移逻辑绝不自动
  放宽。

### 2.4 Fail closed

- 未知策略名（非 balanced/strict）→ 拒绝（`CLD-AUTH-006`）；
- 任意自定义秒数 → 不允许作为策略，只允许作为「缩短」覆盖且**不得超过
  6 小时上限**，超过即拒绝；
- 任何超过 6 小时的静默扩展 → 拒绝；
- 引擎无法解析策略时按不降级处理（fail closed）。

## 3. 变更控制与版本

- 本 ADR 依据协议 §22 变更控制条款（LKG 行为变化必须写 ADR）；
- 协议版本由 v0.2.0 提升为 **v0.3.0**；产品版本由 Clued v0.1 提升为
  **Clued v0.2.0**；
- **ADR-CLD-001 标记为被本 ADR supersede**（仅 LKG 最大年龄取值维度），
  历史事实不改写、不删除；
- 更新位置：协议 §0 / §7.5 / §13 / §14（新增 CLD-AUTH-006）/ §17 CLD-003 /
  §19.2 / §22；Binding manifest schema（`auth_policy` 字段）；Authorization
  Cache policy_version（0.1 → 0.2，旧缓存按自身版本自洽校验，继续在 strict
  语义下可用）；status / doctor 呈现；CLI（`clued auth policy`）；迁移逻辑；
  测试（`tests/test_clued_policy.py`，22 项）。

## 4. 决策原因

- 单一 1h 值对「个人跨端 + GitHub/代理偶发不可达」场景过度严格，导致不必要
  的可用性损失；6h 平衡窗口仍受 30 分钟会话 TTL 与绝对截止 min() 约束；
- 新装默认 balanced 面向日常场景；升级保守 strict 保证**绝不静默扩大既有
  权限**，用户主动选择才放宽；
- 语义策略名 + fail closed 防止 Adapter/配置层自行发明任意窗口。

## 5. 代价

- 策略多样性增加测试面（每策略边界 + 迁移 + 绝对截止，22 项新测试）；
- 状态/doctor 需要呈现更多窗口字段（auth_policy / lkg_max_age /
  lkg_authorized_at / lkg_expires_at / degraded_session_expires_at /
  effective_degraded_until），但全部为派生非秘密信息。

## 6. 保持不变（与 ADR-CLD-001/002 不冲突）

- 每会话首次 Memory Access 强制在线认证尝试（§7.1）；
- 仅 `UNAVAILABLE` 可评估降级；`DENIED` / `DENIED_SECURITY` 立即 LOCKED（§7.4）；
- 单次降级会话 30 分钟 TTL；
- LKG 只保存非秘密证明元数据，篡改即禁止降级；
- 恢复前重新在线认证、doctor PASS、先 pull 后 replay/push；
- `LOCKED → AUTH_REQUIRED` 出口（ADR-CLD-002）不受影响。
