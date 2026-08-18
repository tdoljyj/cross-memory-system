# ADR-CLD-002：LOCKED → AUTH_REQUIRED 恢复转换纳入协议

- **Status**：`ACCEPTED`
- **Date**：2026-08-18
- **Decider**：Product Owner
- **Protocol**：Clued Agent Lifecycle Protocol **v0.2.0**（D4 作为 v0.2.0 发布前收口纳入，协议版本不再提升）
- **Product**：Clued v0.1（产品名不变）
- **Related**：ADR-CLD-001（LKG = 1h，独立决定，不受本 ADR 影响）

---

## 1. 背景

Clued Agent Lifecycle Protocol v0.1.0（FROZEN）的 §11.2 状态机只定义了「任意已安装状态 → `LOCKED`」的进入路径，没有定义 `LOCKED` 的恢复出口（除卸载外）。

首个参考实现按最保守语义实现了 `LOCKED → AUTH_REQUIRED` 出口：锁定原因只能通过一次**全新的在线验证**被消除，验证成功后回到「当前会话仍需授权」的保守状态（`AUTH_REQUIRED`），随后仍按每会话规则执行认证门禁。该出口被记录为协议偏差 **D4**，等待产品所有者确认。

## 2. 决定

产品所有者正式批准将状态转换

```text
LOCKED → AUTH_REQUIRED
```

纳入 Clued Agent Lifecycle Protocol **v0.2.0** 协议 §11.2。

该转换**不是绕过锁定**，而是锁定原因已经通过一次全新的在线验证被消除后，回到「当前会话仍需授权」的保守状态。

### 2.1 必须同时满足的前提（全部满足才允许转换）

1. 新的在线认证结果严格为 `AUTHORIZED`；
2. 当前账户与 Binding 的 `account_id` 一致；
3. Binding 状态为 `ACTIVE`；
4. scopes 满足 Binding 所需权限且没有扩大；
5. Binding manifest、Authorization Cache 和本地完整性检查通过；
6. **不使用旧 LKG 作为解锁依据**（解锁只能来自新的在线验证结果）；
7. 写入 `auth_recovered` 审计事件；
8. 返回 `AUTH_REQUIRED` 后，下一次 Memory Access 仍按每会话规则执行认证门禁（协议 §7.1，不得因解锁而获得跨会话豁免）。

### 2.2 LOCKED 期间继续严格禁止（不变）

- 使用旧 LKG 降级；
- 读取私有记忆；
- 新增、修改或删除记忆；
- 写入新的 Pending Operation；
- 请求 canonical read 或 push。

## 3. 变更控制与版本

- 本 ADR 依据协议 §22 变更控制条款登记（涉及状态语义扩展，必须写 ADR）；
- 由于 Agent Lifecycle Protocol **v0.2.0 尚未 push、tag 或发布**，D4 作为 **v0.2.0 发布前收口**纳入，**不需要再次升级协议版本**（协议仍为 v0.2.0；产品名仍为 Clued v0.1）；
- 从最终报告《Clued-v0.1-Reference-Implementation-Report.md》的 `Protocol Deviations` 删除 D4；
- 协议更新位置：§11.2（关键转换 + 前提）、§15.4（审计事件清单）；
- 本决定只允许产品所有者变更控制流程撤销，实现者不得自行删除或放宽该出口的任一前提。

## 4. 决策原因

- `LOCKED` 的成因（明确拒绝、安全错误、完整性不合规）一旦被一次全新的在线验证证明已消除，继续永久锁死（除卸载外无出口）会不必要地迫使已安装 Agent 卸载重装；
- 转换终点是 `AUTH_REQUIRED` 而非直接在线态，保证解锁后仍回到「当前会话需授权」的最保守状态，后续 Memory Access 继续走每会话认证门禁；
- 全部前提保持零降级语义：任一前提不满足即保持 `LOCKED`，不存在部分解锁。

## 5. 代价

- 实现需要账户一致、scope 合规、完整性检查的复核路径与 `auth_recovered` 审计事件（首个参考实现已完成）；
- 协议与测试矩阵增加一条状态转换语义（专项测试 3 项）。

## 6. 保持不变

- 每会话首次 Memory Access 强制在线认证尝试（§7.1）；
- 仅 `UNAVAILABLE` 可评估降级；`DENIED` / `DENIED_SECURITY` 立即 `LOCKED`，绝不降级（§7.4）；
- LOCKED 期间零访问、零降级、零旧 LKG 使用、零新 Pending、零 canonical read/push（§7.4 与本节 2.2）；
- ADR-CLD-001 的 `lkg_max_age = 1 小时` 与 30 分钟降级会话 TTL 不受影响；
- 卸载路径（LOCKED → UNINSTALLING）不变。

## 7. 实施与测试证据

- 状态机：`clued/state_machine.py`——`ALLOWED_TRANSITIONS[LOCKED] = (AUTH_REQUIRED, UNINSTALLING)`；`TRANSITION_EVENTS[(LOCKED, AUTH_REQUIRED)] = "auth_recovered"`；
- 控制器：`clued/controller.py`——`auth_check` / `ensure_access` 的 LOCKED 出口分支（新在线认证 + 账户一致 + Binding ACTIVE + scope 合规 + 完整性检查；任一不满足保持 LOCKED）；`_account_consistent` 账户一致判定；
- 审计：`LOCKED → AUTH_REQUIRED` = `auth_recovered`；随后按访问路径记 `auth_authorized`；
- 测试：`tests/test_clued_pending.py` D4 专项 3 项——`test_locked_no_degrade_no_access_no_lkg_use`、`test_locked_exit_requires_fresh_online_auth_and_audit`（含 `auth_recovered` 审计断言）、`test_locked_account_mismatch_blocks_exit`；
- 最终验收：在最终精确 HEAD 上九套测试 227 项 0 失败 0 跳过 + `clued.py doctor --json` exit 0 ALL PASS（见最终报告 §7.4）。
