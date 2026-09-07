# ADR-CLD-001：LKG 最大年龄收紧为 1 小时

> **SUPERSEDED（2026-08-18）**：本 ADR 的 LKG 最大年龄取值维度已被
> **ADR-CLD-003（LKG 策略配置文件：balanced=6h / strict=1h，协议 v0.3.0）**
> 取代——LKG 上限从单一权威值改为固定策略配置（新装默认 balanced=6h，
> v0.1.0 升级保守迁移 strict=1h）。本 ADR 的**历史事实不改写、不删除**：
> 它记录了 v0.2.0 时期「LKG 唯一权威值 1 小时」的决策依据与代价。

- **Status**：`ACCEPTED`（superseded by ADR-CLD-003，2026-08-18）
- **Date**：2026-08-18
- **Decider**：Product Owner
- **Protocol**：Clued Agent Lifecycle Protocol（版本随之提升至 **v0.2.0**）
- **Product**：Clued v0.1（产品名不变）

---

## 1. 背景

Clued Agent Lifecycle Protocol v0.1.0（FROZEN）在弱网降级窗口上存在内部不一致：

- §7.5 参数表将 `lkg_max_age` 写为 **1 小时**；
- §7.5 降级条件 3 与 §22 冻结决策 7 写为 **6 小时**。

首个参考实现按 §22「歧义选更保守」做了「1 小时开启 / 6 小时完全失效」的双界裁决，并把这一裁决记录为协议偏差 D1。

## 2. 决定

产品所有者批准：

```text
lkg_max_age = 1 hour（唯一权威值）
```

具体语义：

| 参数 | 冻结值 |
|---|---:|
| 最近一次成功在线授权最大年龄 `lkg_max_age` | **1 小时** |
| 单次降级会话 TTL `degraded_session_ttl` | 30 分钟（不变） |
| 新会话首次 Memory Access | 仍必须先尝试在线认证 |
| 允许降级的认证结果 | 仅 `UNAVAILABLE` |
| `DENIED` / `DENIED_SECURITY` | 立即 LOCKED，绝不降级 |

边界语义（协议、实现、测试三处完全一致）：

```text
LKG age <= 1h：有效，可按规则降级
LKG age > 1h：失效，禁止降级
```

- 废除「1 小时用于开启、6 小时用于完全失效」的双界语义；
- 代码、测试、文档中不得再出现 6 小时 / 6h / 21600 作为有效降级上限；
- 30 分钟降级会话到期后必须重新进行有界在线认证尝试，不得自动无限续期。

## 3. 决策原因

缩短旧授权证明可用于弱网降级的时间，降低撤销、账户变化或 scope 变化未被及时感知的风险。

## 4. 代价

网络持续不可达超过 1 小时后，弱网降级不再可用，可用性下降；恢复在线认证与同步后才能重新进入降级。

## 5. 保持不变

- 每会话首次 Memory Access 强制在线认证尝试；
- 12 秒有界在线尝试（连接 3s / 操作 5s / 2 次 / 抖动 500–1500ms）；
- 单次降级会话 30 分钟 TTL；
- 仅 `UNAVAILABLE` 可进入降级；`DENIED` / `DENIED_SECURITY` 绝不降级；
- LKG 只保存非秘密证明元数据，篡改即禁止降级；
- 恢复前重新在线认证、doctor PASS、先 pull 后 replay/push。

## 6. 变更控制

- 本 ADR 依据协议 §22 变更控制条款：改变 LKG 属协议行为变化，必须写 ADR，协议版本至少升至 `0.2.0`；
- 协议版本由 v0.1.0 提升为 **v0.2.0**；产品与参考实现继续使用「Clued v0.1」名称；
- 报告中必须区分：

```text
Product: Clued v0.1
Protocol: Clued Agent Lifecycle Protocol v0.2.0
```

- 回滚本决定或再次调整 LKG 上限，必须重新写 ADR；
- 实现允许通过配置**缩短** LKG 上限；任何把上限延长到 1 小时以上的配置一律视为协议配置变化，实现必须拒绝（不得静默接受）。
