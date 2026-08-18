# 《Clued v0.1 智能体安装、授权、弱网降级与卸载协议》

> 中文品牌：自来  
> 英文品牌：Clued  
> 中文标语：换个 AI，也自来熟。  
> 英文标语：Every AI, clued in.  
> 技术核心：Cross Memory Engine  
> 技术协议：Cross Memory Protocol

---

## 0. 文档控制

| 项目                   | 值                                        |
| -------------------- | ---------------------------------------- |
| 协议版本                 | Clued Agent Lifecycle Protocol **v0.2.0** |
| 协议状态                 | **FROZEN（冻结）**                           |
| 冻结日期                 | 2026-08-18（v0.1.0）；2026-08-18（v0.2.0）   |
| 实现基线                 | `cross-memory-system` / vNext-2.0        |
| 当前远端 Canonical Store | GitHub 私有仓库                              |
| 首个参考适配器              | Codex Agent Adapter                      |
| 首个参考实现执行者            | DeepSeek V4 Pro                          |
| 兼容性要求                | 保持 vNext-1.3 同步层、vNext-2.0 记忆引擎及既有数据完全兼容 |

本协议是 Clued v0.1 的实现合同，而不是讨论稿。DeepSeek V4 Pro 应按本文的规范性要求实现首个参考版本。

> **版本变更记录**：
> - v0.1.0（2026-08-18）：首次冻结。
> - v0.2.0（2026-08-18）：依据 ADR-CLD-001（`ADR-CLD-001-LKG-Max-Age-One-Hour.md`），产品所有者批准将 `lkg_max_age` 由 6 小时收紧为 **1 小时**，废除「1 小时开启 / 6 小时完全失效」双界语义。产品名仍为「Clued v0.1」，协议版本提升至 v0.2.0。全部更新位置：§7.5、§17 CLD-003、§19.2、§22。

本文中的关键词具有以下约束力：

- **MUST / 必须**：不满足即不符合 Clued v0.1。
- **MUST NOT / 禁止**：出现即视为协议违规。
- **SHOULD / 应当**：除非存在书面记录的技术阻碍，否则必须实现。
- **MAY / 可以**：实现者可选，不影响合规性。

若本协议与仓库中旧文档发生冲突：

1. 涉及 vNext-1.3 同步语义或 vNext-2.0 记忆语义时，以旧协议和已通过测试的行为为准；
2. 涉及智能体安装、Agent Binding、会话认证、弱网降级、恢复和卸载时，以本协议为准；
3. 无法同时满足时，DeepSeek MUST 停止相关改动，报告冲突，不得自行重写旧核心。

---

## 1. 产品定义

### 1.1 Clued 是“为智能体安装”的服务

Clued 不是传统桌面软件、手机应用或面向设备用户的安装包。它是一套由智能体在对话中发起、执行并验证的能力绑定协议。

用户应能够在智能体对话框内表达：

- “安装 Clued”
- “连接我的 Clued”
- “检查 Clued 状态”
- “立即同步 Clued”
- “从这个智能体卸载 Clued”

智能体再通过其工具能力完成预检、授权、绑定、初始化、验证或卸载。用户不应被要求理解仓库目录、脚本参数、Git 命令或配置文件。

### 1.2 安装单位是 Agent Binding，不是物理设备

同一台设备上的不同智能体 MUST 分别安装并分别获得一个 Agent Binding。例如：

- Codex A 安装一次；
- Codex B 或另一个智能体安装一次；
- Claude、DeepSeek、本地 Agent 等各自安装一次。

它们可以共享同一物理节点上的运行时、本地存储和同步通道，但禁止共享逻辑身份。

因此，Clued 使用以下分层：

| 层级                    | 含义                      | 是否可共享              |
| --------------------- | ----------------------- | ------------------ |
| Account               | Clued 用户账户或当前 GitHub 身份 | 跨节点共享              |
| Local Node            | 一台设备或一个隔离运行环境           | 节点内共享              |
| Shared Runtime        | 本地执行、缓存、队列和同步能力         | 同一节点可共享            |
| Agent Binding         | 某个智能体实例与 Clued 的绑定      | **不可共享，逐智能体安装**    |
| Session Authorization | 某次智能体会话的授权结果            | **不可跨会话复用为在线认证结果** |

### 1.3 对话安装不等于无文件安装

“在对话框内安装”是交互模型，不是对底层持久化的否定。参考实现 MAY 写入适配器配置、绑定清单、节点状态和本地队列，但这些操作必须：

- 由智能体工具完成；
- 可审计、可回滚、可卸载；
- 不依赖传统 GUI 安装程序；
- 不把用户凭据写入对话、仓库或普通日志；
- 不修改与 Clued 无关的智能体配置。

### 1.4 纯对话能力边界

若智能体没有文件写入、命令执行、插件、Skill、MCP 或等价工具能力，它无法自行完成真实安装。此时 Clued MUST 返回 `CAPABILITY_UNAVAILABLE`，并明确说明需要的平台接入能力；禁止伪装成已安装。

---

## 2. v0.1 目标与非目标

### 2.1 必须实现

Clued v0.1 MUST 实现：

1. 对话原生的逐智能体安装协议；
2. Agent、Node、Account 三层身份与绑定；
3. 每个新会话首次访问记忆前的强制在线认证；
4. 授权明确拒绝与暂时网络不可达的严格区分；
5. 只对暂时网络故障开放的短时本地优先降级；
6. 有界重试和熔断，禁止无限连接；
7. 降级期间本地写入的 Pending Operation Journal；
8. 网络恢复后的重新认证、拉取、重放、冲突处理与推送；
9. 当前 Agent Binding 的对话原生卸载；
10. 节点级清理和云端数据删除的明确分离；
11. 机器可读的状态、错误码、审计事件和自动化测试；
12. Codex 的首个参考适配器。

### 2.2 明确不做

Clued v0.1 MUST NOT：

- 重写 Cross Memory Engine vNext-2.0 的 Router、Scope、Relevance、Confidence、Recency 或版本语义；
- 改写 vNext-1.3 的 Git 同步协议；
- 引入数据库、向量数据库或新的 SaaS 作为强依赖；
- 将 GitHub Canonical Store 替换为新的生产后端；
- 实现传统桌面/移动安装包；
- 实现计费、套餐、支付或完整商业后台；
- 实现永久离线许可证或“30 天偶尔联网一次”的授权模型；
- 自动删除用户的云端记忆；
- 在没有明确用户意图时静默安装或卸载；
- 为了通过测试而放松认证或数据一致性约束。

### 2.3 当前后端与未来后端

v0.1 当前以 GitHub 私有仓库作为 Canonical Store，并提供 GitHub 参考认证适配器。认证平面与同步平面 MUST 在代码结构中解耦，使未来可替换为 Clued 自有服务，但本版不得虚构尚不存在的生产 API。

---

## 3. 不可破坏的既有约束

参考实现 MUST 保留以下行为：

1. 默认不加载全部记忆，由 Router 决定是否访问；
2. 召回遵循 Scope、Relevance、Confidence、Recency 的最小必要原则；
3. 写入必须版本化，并使用乐观锁；
4. 写入操作具有 `operation_id`，可以幂等重放；
5. Cache 服从 Canonical Store；
6. `NO_CHANGE → NO_WRITE → NO_SYNC → NO_INVALIDATION`；
7. 禁止 rebase，禁止 force push；
8. `doctor` 为 FAIL 时禁止 canonical read 和 push；
9. 日志、诊断和提交内容必须对秘密信息脱敏；
10. 同步脚本只处理其被允许处理的记忆文件；
11. 在线稳定状态的版本真值必须满足：本地 HEAD = 远端 HEAD = 声明 tag，并且工作树干净；
12. 保留既有 conflict snapshot、`.sync.lock`、Markdown、T0–T4、L1–L6 和 Git 协议；
13. Memory Engine 位于 Git 同步层之上，不得绕过同步层直接篡改 Canonical Store。

任何新状态文件、队列或适配器必须避开既有同步文件的跟踪范围，除非旧协议明确允许。

---

## 4. 逻辑架构

### 4.1 组件

| 组件                        | 职责                                        |
| ------------------------- | ----------------------------------------- |
| Conversation Adapter      | 将自然语言意图转换为受控的安装、状态、同步和卸载调用                |
| Lifecycle Controller      | 执行安装、绑定、升级、修复和卸载事务                        |
| Agent Registry            | 管理逐 Agent Binding，不存放明文凭据                 |
| Auth Provider             | 每会话进行在线授权，区分拒绝与不可用                        |
| Authorization Cache       | 只保存最近成功授权的证明元数据，用于短时弱网降级                  |
| Circuit Breaker           | 阻止无界重试，并控制恢复探测                            |
| Local Runtime             | 提供本地读取、写入、锁、审计和状态管理                       |
| Pending Operation Journal | 保存降级期尚未提交到远端的操作                           |
| Sync Provider             | 调用既有 `pull/push/doctor/bootstrap/sync` 能力 |
| Canonical Store           | 在线全局真值；v0.1 为 GitHub 私有仓库                 |

### 4.2 真值模型

- 在线且同步健康时：远端 Canonical Store 是全局唯一真值。
- 弱网降级时：本地状态是该节点的**临时操作真值**，但不升级为全局 Canonical Store。
- 降级写入必须进入 Pending Operation Journal，不得伪报为已同步。
- 恢复后必须先重新认证并拉取远端，再进行重放和合并。
- 冲突未解决前，不得声称节点已同步。

### 4.3 认证平面与同步平面

认证平面回答：“当前 Agent Binding 在当前会话是否允许访问 Clued？”

同步平面回答：“当前本地状态如何与 Canonical Store 达成一致？”

两者必须拥有独立接口、错误类型、超时和测试。同步超时不得伪装成授权拒绝；授权拒绝也不得被同步重试掩盖。

---

## 5. 身份与数据模型

### 5.1 标识符

| 字段             | 规则                                       |
| -------------- | ---------------------------------------- |
| `account_id`   | 来自认证提供方的稳定、非秘密账户标识；不得直接使用访问令牌            |
| `node_id`      | 首次初始化时生成 UUIDv4；同一共享运行时保持稳定              |
| `agent_id`     | 每个 Agent Binding 生成 UUIDv4；同节点不同智能体必须不同  |
| `binding_id`   | UUIDv4；v0.1 可与 `agent_id` 一一对应，但字段必须独立保留 |
| `session_id`   | 每次会话由适配器生成或接收；不得跨会话复用                    |
| `request_id`   | 每次协议调用 UUIDv4                            |
| `operation_id` | 每次逻辑写入 UUIDv4；重试和恢复时保持不变                 |

### 5.2 Node Manifest

```json
{
  "schema_version": "clued.node.v0.1",
  "node_id": "uuid",
  "created_at": "RFC3339",
  "runtime_version": "0.1.x",
  "canonical_provider": "github",
  "binding_count": 2
}
```

### 5.3 Agent Binding

```json
{
  "schema_version": "clued.binding.v0.1",
  "binding_id": "uuid",
  "agent_id": "uuid",
  "node_id": "uuid",
  "account_id": "provider-stable-id",
  "agent_type": "codex",
  "agent_instance_label": "user-readable-label",
  "adapter_version": "0.1.x",
  "scopes": ["memory:read", "memory:write", "sync:request"],
  "status": "ACTIVE",
  "installed_at": "RFC3339",
  "last_verified_at": "RFC3339",
  "installed_artifacts": [
    {"kind": "config", "path": "logical-or-resolved-path", "sha256": "hex"}
  ]
}
```

`installed_artifacts` 是卸载清单。卸载只能移除清单内且校验属于该 Binding 的内容；不得按模糊目录或通配符删除。

### 5.4 Authorization Cache

授权缓存只保存最后一次成功在线授权的非秘密证明元数据：

```json
{
  "schema_version": "clued.auth-cache.v0.1",
  "binding_id": "uuid",
  "account_id": "provider-stable-id",
  "scopes": ["memory:read", "memory:write", "sync:request"],
  "authorized_at": "RFC3339",
  "provider": "github",
  "provider_subject_hash": "sha256",
  "policy_version": "0.1",
  "proof_hash": "sha256"
}
```

禁止在该文件中写入令牌、Cookie、私钥、Git 凭据或可恢复的认证响应。

### 5.5 存储布局

协议只冻结逻辑布局，不冻结操作系统绝对路径：

```text
<clued_runtime_root>/
  node.json
  bindings/<binding_id>/binding.json
  auth/<binding_id>.json
  pending/<operation_id>.json
  conflicts/<conflict_id>/...
  state/runtime.json
  audit/events.jsonl
  locks/...
```

实现 MUST 通过现有 bootstrap/config 解析 `<clued_runtime_root>`，不得在多个模块中硬编码用户目录。该目录不得被默认推送到 Canonical Store。

---

## 6. 对话原生安装协议

### 6.1 用户意图

安装必须由明确意图触发。智能体 MAY 识别同义表达，但必须在产生持久化变更前说明：

- 将为“当前智能体”创建独立 Binding；
- 同一节点的其他智能体不会自动安装；
- 会使用当前 Canonical Store；
- 需要一次标准认证；
- 不会把密码或令牌保存到对话。

如果用户只是在询问 Clued，禁止自动安装。

### 6.2 安装前能力预检

安装器 MUST 检查并以 JSON 返回：

1. 当前智能体是否支持工具/命令或等价扩展；
2. 是否能解析可写的运行时根目录；
3. 是否能取得跨进程锁；
4. 既有 sync 脚本是否存在且可运行；
5. `doctor` 状态；
6. Git 和当前 Canonical remote 状态；
7. 当前 Agent 是否已经绑定；
8. 是否存在未完成安装或卸载事务；
9. 是否存在不兼容协议版本；
10. 凭据存储能力是否可用。

预检不得修改远端。预检失败必须给出稳定错误码，不得留下半安装状态。

### 6.3 安装事务

安装 MUST 按以下顺序执行：

1. **Acquire Lock**：取得节点级生命周期锁；
2. **Discover**：读取 node、既有 bindings 和核心版本；
3. **Stage**：把待安装适配器和 manifest 写入临时事务区；
4. **Verify Source**：校验本地源版本、允许清单与文件摘要；禁止执行未验证的远程脚本；
5. **Authenticate Online**：通过 Auth Provider 进行在线认证；首次安装不允许弱网降级；
6. **Resolve Account**：取得稳定 `account_id` 和授权 scopes；
7. **Create/Repair Node**：不存在则创建 node manifest，存在则验证；
8. **Create Agent Binding**：创建当前智能体独立 Binding；
9. **Attach Adapter**：只修改当前智能体对应的扩展点；
10. **Bootstrap/Pull**：通过既有同步层初始化或拉取；
11. **Doctor**：执行完整诊断；
12. **Commit Manifest**：原子提交 binding、artifact list 和状态；
13. **Verify Conversation Path**：通过适配器执行一次只读状态检查；
14. **Release Lock**：释放锁并返回安装摘要。

### 6.4 原子性与回滚

- 安装要么进入 `ACTIVE`，要么回滚到安装前状态。
- 所有文件替换必须使用同文件系统的临时文件 + 原子 rename/replace。
- 若 adapter 已写入但绑定提交失败，必须按 artifact manifest 回滚。
- 若首次远端认证失败，禁止创建可用 Binding。
- 回滚失败时进入 `INSTALL_ERROR`，保留审计事件和精确残留清单，禁止伪报安装成功。

### 6.5 幂等性

同一智能体重复执行“安装 Clued”时：

- 如果 Binding 健康：返回 `ALREADY_INSTALLED` 并执行轻量验证；
- 如果 Binding 可修复：执行事务性 repair，不创建第二个 Binding；
- 如果发现同 Agent 多 Binding：进入 `BINDING_CONFLICT`，不得自行选一个覆盖。

### 6.6 认证交互

v0.1 GitHub 参考适配器 SHOULD 使用已有、受保护的 GitHub/系统凭据或标准浏览器/设备授权流程。它 MUST NOT：

- 请求用户在对话中粘贴密码、PAT、私钥或 Cookie；
- 把凭据写进仓库、普通配置或日志；
- 为了安装自动扩大 GitHub scopes；
- 在认证失败时循环弹出登录。

---

## 7. 每会话授权协议

### 7.1 强制在线认证规则

每个新会话对 Clued 的**第一次 Memory Access**之前，系统 MUST 尝试在线认证。以下操作属于 Memory Access：

- 读取、检索或召回记忆；
- 新增、更新、删除记忆；
- 请求同步或查看包含私有记忆内容的状态；
- 执行恢复、冲突处理或远端操作。

仅查看不含私有内容的安装版本、协议版本和本地健康摘要 MAY 不触发在线认证。

同一 `session_id` 在线认证成功后，该结果可在本会话内复用；新 `session_id` 必须重新尝试在线认证。授权缓存不能替代这次尝试，只能在尝试明确判定为网络不可用后用于降级决策。

### 7.2 三值结果模型

Auth Provider MUST 返回且只返回下列语义之一：

| 结果            | 典型条件                                   | 后续动作      |
| ------------- | -------------------------------------- | --------- |
| `AUTHORIZED`  | 在线确认账户、Binding 和 scopes 有效             | 进入在线模式    |
| `DENIED`      | 401/403、Binding 被撤销、账户禁用、scope 缺失、签名无效 | 立即锁定，绝不降级 |
| `UNAVAILABLE` | DNS、连接超时、TLS 握手超时、临时 5xx、网络不可达         | 评估短时降级    |

解析错误、未知响应、证书校验失败默认视为安全错误，不得笼统地全部归为 `UNAVAILABLE`。其中证书过期、主机名不匹配或信任链异常 MUST 视为 `DENIED_SECURITY`，禁止降级。

### 7.3 有界在线尝试

参考默认值冻结如下：

| 参数       | 默认值              |
| -------- | ----------------:|
| 单次连接超时   | 3 秒              |
| 单次认证操作超时 | 5 秒              |
| 最大尝试次数   | 2 次              |
| 两次间延迟    | 500–1500 ms 随机抖动 |
| 总墙钟预算    | 12 秒             |

一旦超过总预算，必须返回 `UNAVAILABLE`，不得在前台继续连接。实现可以通过配置缩短这些值，但延长总预算必须作为协议配置变更记录。

### 7.4 明确拒绝绝不降级

发生以下任一情况，系统 MUST 进入 `LOCKED`，不得读取私有记忆、写入本地队列或使用旧授权缓存：

- 服务端或 GitHub 明确返回无权限；
- Binding 已撤销或禁用；
- 账户不匹配；
- 所需 scope 缺失；
- 本地 Binding、授权证明或 manifest 被篡改；
- 安全相关 TLS/签名校验失败；
- 已收到比本地缓存更新的撤销事实。

### 7.5 弱网降级的授权窗口

降级不是离线许可证，而是对一次失败在线认证的短时网络妥协。v0.1 默认策略（经 ADR-CLD-001 固化）：

| 参数                                  | 默认值              |
| ----------------------------------- | ----------------:|
| 最近成功在线授权最大年龄 `lkg_max_age`          | 1 小时             |
| 单次降级会话最大持续时间 `degraded_session_ttl` | 30 分钟            |
| 降级可用 scopes                         | 不超过最近成功授权 scopes |
| 跨会话继承                               | 禁止；新会话仍必须先尝试在线认证 |

只有同时满足下列条件才可进入 `DEGRADED_LOCAL`：

1. 本次在线认证结果严格为 `UNAVAILABLE`；
2. 存在校验完整的 Last-Known-Good 授权证明；
3. 证明年龄 `age <= 1 小时`（`lkg_max_age`；**age > 1 小时即失效**，无 6 小时或其它双界语义）；
4. Binding 本地状态为 ACTIVE；
5. 没有已知撤销、账户切换、scope 降级或安全错误；
6. 本地存储和 Pending Journal 通过完整性检查；
7. 当前操作在降级允许列表内。

30 分钟到期后，下一次 Memory Access 必须重新尝试在线认证。若仍不可用且 LKG 仍有效，可开启新的 30 分钟降级会话；这仍不改变“每个新会话必须在线尝试”的规则。

### 7.6 降级期间的权限

降级模式允许：

- 使用本节点已缓存且在原 scope 内的记忆；
- 进行本地新增、更新、删除，并写入 Pending Journal；
- 查看明确标注为“本地/未同步”的状态；
- 手动请求恢复探测。

降级模式禁止：

- 创建新 Agent Binding；
- 扩大 scopes 或切换账户；
- 执行云端删除、账户删除、计费或安全设置变更；
- 声称本地写入已同步；
- 覆盖或重写远端历史；
- 自动解决语义冲突；
- 使用缓存授权访问本地从未拥有过的 scope。

---

## 8. 弱网、重试与熔断协议

### 8.1 核心原则

网络不好时，Clued 应尽快转入明确、有限的本地工作状态，而不是不断阻塞用户。所有网络循环必须可证明有最大次数、最大时长和退出路径。

### 8.2 Circuit Breaker 状态

| 状态          | 行为                      |
| ----------- | ----------------------- |
| `CLOSED`    | 正常允许在线认证和同步             |
| `OPEN`      | 暂停自动网络调用，使用降级策略或返回不可用   |
| `HALF_OPEN` | 只允许一个探测请求；成功则关闭，失败则重新打开 |

### 8.3 熔断默认规则

- 一次会话认证达到 12 秒总预算仍不可用后，认证熔断器进入 OPEN；
- 连续 2 次同步暂时失败后，同步熔断器进入 OPEN；
- OPEN 初始冷却时间为 2 分钟；
- 连续探测失败可指数增加冷却时间，但最大为 15 分钟；
- 每个 Binding/Provider 同一时间最多一个 HALF_OPEN 请求；
- 用户发起“立即同步/重新连接”可触发一次受控探测，但连续点击不得绕过单飞锁和速率限制。

### 8.4 允许的恢复触发器

系统 MAY 在以下事件触发一次恢复探测：

1. 操作系统或运行环境报告网络状态变化；
2. 新会话首次 Memory Access；
3. 用户显式请求同步或重连；
4. 出现必须访问远端的操作；
5. 熔断冷却期结束后的低频 HALF_OPEN 探测。

禁止使用无限 while-loop、固定秒级轮询或多个 Agent 各自高频重试。

### 8.5 用户可见状态

进入降级时必须一次性说明：

- 当前为本地优先模式；
- 触发原因是网络暂时不可用，而非授权通过；
- 新写入将排队，尚未同步；
- 当前降级有效期；
- 用户可使用“立即同步”主动恢复。

同一故障周期内不应为每个本地操作重复刷屏。

---

## 9. Pending Operation Journal

### 9.1 目的

Pending Journal 保证降级期间的本地写入不会丢失，并能在恢复时以至少一次传输、幂等效果的方式提交。

### 9.2 操作结构

```json
{
  "schema_version": "clued.pending-op.v0.1",
  "operation_id": "uuid",
  "binding_id": "uuid",
  "agent_id": "uuid",
  "node_id": "uuid",
  "session_id": "uuid",
  "operation_type": "CREATE|UPDATE|DELETE",
  "memory_id": "stable-memory-id",
  "base_revision": "revision-or-null",
  "payload_ref": "local-encrypted-or-protected-reference",
  "payload_sha256": "hex",
  "created_at": "RFC3339",
  "status": "PENDING",
  "attempt_count": 0,
  "last_attempt_at": null,
  "last_error_code": null
}
```

### 9.3 Journal 规则

- 每次逻辑写入生成一个稳定 `operation_id`；重试不得生成新 ID。
- 先原子持久化 journal，再向用户确认“已保存在本地”。
- Journal 状态只能按 `PENDING → APPLYING → SYNCED` 或 `PENDING/APPLYING → CONFLICTED/REJECTED` 转移。
- `SYNCED` 记录在确认远端结果后才可归档。
- 进程崩溃后 `APPLYING` 必须可恢复为幂等重试状态。
- Journal 不得进入 Git 同步范围。
- Payload 必须沿用现有秘密扫描和隐私规则；能引用受保护本地对象时，不应重复写明文。
- 文件损坏时进入 `PENDING_CORRUPT`，保留原始证据，不得静默丢弃。

### 9.4 一致性保证

v0.1 提供：

- 传输层：至少一次；
- 逻辑效果：通过 `operation_id` 达到幂等一次；
- 多节点全局顺序：不保证；
- 同一 Binding 的待处理操作：按创建顺序处理；
- 同一 Memory ID 的操作：严格保序；
- 冲突：显式暴露，不做静默 last-write-wins。

---

## 10. 网络恢复与同步协议

### 10.1 恢复前提

恢复流程开始前必须：

1. 取得全局 `.sync.lock` 或与既有同步协议兼容的单飞锁；
2. 对当前会话重新在线认证；
3. 认证结果必须为 `AUTHORIZED`；
4. 执行 `doctor` 并通过；
5. 验证 Pending Journal 完整性。

若认证为 `DENIED`，立即进入 LOCKED；若为 `UNAVAILABLE`，保持降级且不增加高频重试。

### 10.2 固定恢复顺序

恢复 MUST 严格执行：

1. `AUTHENTICATE`
2. `DOCTOR`
3. `PULL_REMOTE`
4. `VALIDATE_REMOTE_HEAD`
5. `LOAD_PENDING_IN_ORDER`
6. `REPLAY_WITH_OPERATION_ID`
7. `CHECK_OPTIMISTIC_LOCKS`
8. `RUN_EXISTING_MEMORY_VALIDATION`
9. `PUSH_VIA_EXISTING_SYNC_LAYER`
10. `VERIFY_REMOTE_RESULT`
11. `MARK_PENDING_SYNCED`
12. `INVALIDATE_ONLY_IF_CHANGED`
13. `CLOSE_BREAKER_AND_RETURN_ONLINE`

禁止先把本地降级状态直接 push 再 pull；禁止绕过现有同步脚本直接改写远端。

### 10.3 无变化规则

恢复后若 Pending Journal 为空且远端没有变化，必须遵守：

`NO_CHANGE → NO_WRITE → NO_SYNC → NO_INVALIDATION`

不得为了更新“最后检查时间”制造 Git commit。

### 10.4 冲突规则

出现 base revision 不匹配、同一记忆远端已修改或语义验证不通过时：

1. 停止当前恢复批次；
2. 不推送包含未解决冲突的批次；
3. 生成现有格式兼容的 conflict snapshot；
4. 将相关 Pending Operation 标记为 `CONFLICTED`；
5. 保留本地版本、远端版本、共同 base、operation_id 和摘要；
6. 进入 `CONFLICT_REVIEW`；
7. 向用户给出不泄露私密内容的冲突摘要和解决入口。

v0.1 禁止自动选择本地覆盖远端、禁止 rebase、禁止 force push。

### 10.5 恢复完成条件

只有同时满足下列条件才可返回 `ONLINE_SYNCED`：

- 在线授权成功；
- doctor PASS；
- 所有本批 Pending Operation 已被远端确认或明确归档；
- 没有未解决冲突；
- 本地和远端版本关系通过既有校验；
- 工作树满足旧协议要求。

---

## 11. 状态机

### 11.1 规范状态

| 状态                | 含义                 |
| ----------------- | ------------------ |
| `UNINSTALLED`     | 当前 Agent 无 Binding |
| `INSTALLING`      | 安装事务进行中            |
| `AUTH_REQUIRED`   | 已绑定，但当前会话尚未认证      |
| `ONLINE_SYNCED`   | 在线、已授权、无待同步操作      |
| `ONLINE_DIRTY`    | 在线但存在尚未提交的本地操作     |
| `DEGRADED_LOCAL`  | 网络不可用且满足短时本地授权条件   |
| `RECOVERING`      | 正在重新认证、拉取并重放       |
| `CONFLICT_REVIEW` | 存在需要人工处理的冲突        |
| `LOCKED`          | 明确拒绝、安全错误或授权缓存不合规  |
| `UNINSTALLING`    | 卸载事务进行中            |
| `INSTALL_ERROR`   | 安装/修复失败且存在待处理残留    |

### 11.2 关键转换

| 起点             | 事件                      | 条件                   | 终点                            |
| -------------- | ----------------------- | -------------------- | ----------------------------- |
| UNINSTALLED    | install                 | 预检与在线认证成功            | AUTH_REQUIRED / ONLINE_SYNCED |
| AUTH_REQUIRED  | first access            | AUTHORIZED           | ONLINE_SYNCED                 |
| AUTH_REQUIRED  | first access            | UNAVAILABLE + LKG 合规 | DEGRADED_LOCAL                |
| AUTH_REQUIRED  | first access            | DENIED               | LOCKED                        |
| ONLINE_SYNCED  | local write             | 写入成功                 | ONLINE_DIRTY                  |
| ONLINE_SYNCED  | network failure         | LKG 合规               | DEGRADED_LOCAL                |
| DEGRADED_LOCAL | local write             | Journal 成功           | DEGRADED_LOCAL                |
| DEGRADED_LOCAL | recovery trigger        | 在线认证成功               | RECOVERING                    |
| RECOVERING     | replay success          | 验证全部通过               | ONLINE_SYNCED                 |
| RECOVERING     | conflict                | snapshot 成功          | CONFLICT_REVIEW               |
| 任意已安装状态        | explicit denial         | —                    | LOCKED                        |
| 任意已安装状态        | uninstall current agent | 用户明确确认               | UNINSTALLING → UNINSTALLED    |

代码中不得以多个互不一致的布尔值代替该状态机。状态转换必须经过单一控制器并写入审计事件。

---

## 12. 对话原生卸载协议

### 12.1 三种不同操作

| 操作                     | 默认性        | 影响                                 |
| ---------------------- | ---------- | ---------------------------------- |
| `detach-current-agent` | **默认卸载行为** | 只移除当前 Agent Binding 和适配器           |
| `remove-node`          | 必须二次确认     | 移除本节点所有 Agent Binding、共享运行时与可选本地缓存 |
| `delete-cloud-account` | 独立高风险操作    | 删除云端账户或记忆；v0.1 只定义接口，不自动实现         |

用户说“卸载 Clued”时，默认解释为 `detach-current-agent`。禁止默认删除其他 Agent、共享本地记忆或云端数据。

### 12.2 当前 Agent 卸载流程

1. 确认目标 `binding_id` 是当前智能体；
2. 取得生命周期锁；
3. 检查 Pending Journal 和冲突；
4. 若在线，执行最后一次受控恢复/同步；
5. 若存在未同步数据，清楚展示数量和风险；
6. 撤销当前 Binding 的远端授权或登记撤销任务；
7. 立即删除当前 Binding 的本地可用凭据；
8. 按 `installed_artifacts` 清单移除当前适配器；
9. 将 Binding 状态写为 REVOKED 后归档或删除；
10. 验证当前 Agent 已无法访问 Clued；
11. 验证其他 Agent Binding 仍然有效；
12. 释放锁并返回卸载摘要。

### 12.3 未同步数据处理

如果存在 Pending Operation：

- 在线且同步成功：正常卸载；
- 网络不可用：默认保留 Pending Journal 和共享运行时，完成当前 Agent 本地解绑，并标记 `REMOTE_REVOCATION_PENDING`；
- 明确授权拒绝：不得再尝试读取/同步记忆，但仍必须允许用户移除本地适配器和本地凭据；
- 用户要求丢弃未同步数据：必须进行独立、明确、不可混淆的确认，并先生成可恢复导出或说明无法恢复。

当前 Agent 卸载后，Pending Operation 仍保留原始 `agent_id` 与 `operation_id`，可由同节点共享运行时在重新授权后处理。不得将其冒充为其他 Agent 的新操作。

### 12.4 离线撤销

网络不可用时无法证明远端令牌已撤销。因此：

- 本地凭据和适配器必须立即失效；
- 远端撤销进入受保护的撤销队列；
- 只要共享运行时仍存在，恢复联网后优先执行撤销；
- 若这是节点最后一个 Binding，默认保留最小撤销执行器和撤销记录；
- 用户若坚持完全删除本地执行器，必须明确告知“远端撤销尚未确认”，并提供可重新执行撤销的记录；
- 禁止把“本地已卸载”表述为“云端已撤销”。

### 12.5 共享资源清理

- 节点上仍有其他 ACTIVE Binding 时，禁止删除共享运行时、本地 store、Pending Journal 或公共锁。
- 当前 Binding 是最后一个 Binding 时，可以询问是否清理共享运行时和本地缓存。
- 默认保留用户记忆和可恢复数据；清理数据必须独立确认。
- 删除必须基于 manifest 和解析后的精确路径；禁止递归删除宽泛目录、用户主目录、工作区根目录或未验证变量。

### 12.6 卸载幂等性

对已卸载 Agent 再次卸载必须返回 `ALREADY_UNINSTALLED`。残留修复 MAY 执行，但不得误伤其他 Binding。

---

## 13. 内部命令与工具合同

这些命令是智能体适配器调用的内部接口，不要求终端用户手工运行：

```text
clued install --agent-type codex --agent-instance <label> --json
clued auth check --binding-id <id> --session-id <id> --json
clued status --binding-id <id> --json
clued memory <operation> ... --session-id <id> --json
clued sync --binding-id <id> --session-id <id> --json
clued uninstall --binding-id <id> --mode detach-current-agent --json
clued doctor --json
```

若仓库已有命令入口，可扩展现有入口而非强行创建名为 `clued` 的二进制；但语义和 JSON 合同必须等价。

### 13.1 JSON 响应包络

```json
{
  "protocol_version": "0.2.0",
  "request_id": "uuid",
  "ok": true,
  "code": "AUTHORIZED",
  "state": "ONLINE_SYNCED",
  "message": "human-readable summary",
  "data": {},
  "actions": [],
  "retry_after_seconds": null,
  "timestamp": "RFC3339"
}
```

要求：

- JSON 模式的 stdout 只能输出一个有效 JSON 对象；诊断写 stderr；
- `ok=false` 必须使用非零退出码；
- 错误码稳定，不能依赖解析自然语言；
- message 不得包含秘密；
- 降级时 `ok` 可为 true，但 `state` 必须是 `DEGRADED_LOCAL`，并返回 pending 数量；
- 本地成功但未同步不得使用 `SYNCED` 字样。

### 13.2 退出码

| 退出码 | 含义                 |
| ---:| ------------------ |
| 0   | 请求成功，包括明确标注的降级本地成功 |
| 10  | 用户输入或参数错误          |
| 20  | 能力或依赖不可用           |
| 30  | 授权明确拒绝             |
| 31  | 网络不可用且不能降级         |
| 40  | 同步或 doctor 失败      |
| 41  | 冲突待处理              |
| 50  | 安装/卸载事务失败          |
| 60  | 数据完整性或安全错误         |

---

## 14. 稳定错误码

至少实现以下错误码：

| 错误码                 | 含义                    |
| ------------------- | --------------------- |
| `CLD-CAP-001`       | 当前智能体缺少安装所需工具能力       |
| `CLD-INSTALL-001`   | 安装预检失败                |
| `CLD-INSTALL-002`   | 安装事务回滚完成              |
| `CLD-INSTALL-003`   | 安装回滚不完整               |
| `CLD-BIND-001`      | Agent Binding 不存在     |
| `CLD-BIND-002`      | 同 Agent 存在冲突 Binding  |
| `CLD-AUTH-001`      | 在线授权明确拒绝              |
| `CLD-AUTH-002`      | 在线认证暂时不可用             |
| `CLD-AUTH-003`      | LKG 不存在或过期，禁止降级       |
| `CLD-AUTH-004`      | Binding/证明完整性失败       |
| `CLD-AUTH-005`      | scope 不足              |
| `CLD-NET-001`       | 网络预算耗尽，熔断器打开          |
| `CLD-SYNC-001`      | doctor FAIL           |
| `CLD-SYNC-002`      | pull 失败               |
| `CLD-SYNC-003`      | push 失败               |
| `CLD-SYNC-004`      | 远端确认失败                |
| `CLD-PEND-001`      | Pending Journal 损坏    |
| `CLD-PEND-002`      | Pending Operation 被拒绝 |
| `CLD-CONFLICT-001`  | 乐观锁或内容冲突              |
| `CLD-UNINSTALL-001` | 存在未同步操作               |
| `CLD-UNINSTALL-002` | 远端撤销待完成               |
| `CLD-UNINSTALL-003` | Artifact 校验不符，停止删除    |
| `CLD-SEC-001`       | 凭据或秘密泄漏风险             |
| `CLD-SEC-002`       | TLS、签名或信任链安全失败        |

错误码只能细化，不能在 v0.1.x 中改变既有语义。

---

## 15. 安全与隐私要求

### 15.1 凭据

- 凭据必须使用平台已有凭据系统、Git credential helper、`gh` 的安全凭据或操作系统密钥库；
- 禁止将凭据写入 Clued 仓库、Pending Journal、Binding manifest、审计日志或对话；
- 禁止把完整环境变量、HTTP headers、远端 URL 内嵌秘密打印到错误报告；
- 卸载当前 Agent 时必须立即使其本地凭据不可用；
- Agent 之间不得复制或读取彼此的私有凭据。

### 15.2 最小权限

- Agent Binding 只获得完成记忆读写和同步所需的 scope；
- 降级权限不得高于最近在线授权；
- install/update/uninstall、cloud delete、scope change 使用独立能力判定；
- 共享运行时必须在每个请求上验证 binding_id 和 session_id，不能因为同一进程而跳过授权。

### 15.3 供应链

- 禁止 `curl | sh`、下载后不校验即执行或从不受信任分支安装；
- 适配器文件必须有版本与 SHA-256；
- 更新只能覆盖 manifest 管理的文件；
- 路径必须 canonicalize 并验证位于允许根目录内；
- 符号链接不得把删除或覆盖导向允许根目录外。

### 15.4 审计

必须审计以下事件，但不得记录记忆正文或秘密：

- install begin/success/failure/rollback；
- bind create/revoke；
- auth authorized/denied/unavailable；
- degraded enter/expire/exit；
- pending create/replay/conflict/synced；
- breaker open/half-open/close；
- uninstall begin/success/pending-revoke/failure。

审计字段至少包括 timestamp、request_id、binding_id、event_type、result_code、redacted metadata。

---

## 16. Codex 参考适配器

### 16.1 适配器职责

Codex Adapter MUST：

1. 识别明确的安装、状态、同步和卸载意图；
2. 为当前 Codex 实例解析稳定的 agent instance 标识；
3. 为每个新对话生成/接收新的 session_id；
4. 在第一次 Memory Access 前调用 `auth check`；
5. 根据机器可读状态选择在线、降级或锁定路径；
6. 将用户操作转换为核心命令，而不自行实现第二套同步逻辑；
7. 将降级、待同步和冲突状态用自然语言准确呈现；
8. 支持在对话中卸载当前 Binding；
9. 卸载后移除自己的 hook/instruction/tool registration；
10. 不更改其他 Codex 实例或其他 Agent 的 Binding。

### 16.2 适配器不能做的事

- 不得把“读到了本地文件”当成授权成功；
- 不得在自然语言层吞掉 `DENIED`、`CONFLICT` 或 `PENDING`；
- 不得直接调用 Git 绕开 Sync Provider；
- 不得自动接受冲突；
- 不得在用户仅提问时自动安装；
- 不得为了便利在所有会话共用一个已认证标志。

### 16.3 对话结果示例

安装成功：

> Clued 已为当前智能体安装并完成在线验证。这个 Binding 只属于当前智能体；本设备上的其他智能体需要分别安装。

弱网降级：

> 当前无法连接授权服务，已根据最近一次有效授权临时切换到本地优先模式，最长 30 分钟。你的新修改会安全排队，但尚未同步到远端；连接恢复后会先重新认证再同步。

明确拒绝：

> 在线授权已被明确拒绝，因此没有启用本地降级，也没有读取或写入记忆。请恢复账户或 Binding 权限后重试。

卸载成功：

> Clued 已从当前智能体解绑。其他智能体的 Binding 和共享记忆没有被删除。

---

## 17. DeepSeek V4 Pro 实施工作包

### CLD-000：仓库预检与映射

交付：

- 阅读仓库级指令、README、设计文档、同步脚本、测试和版本状态；
- 输出 vNext-1.3 与 vNext-2.0 不可修改区域；
- 将本协议中的逻辑组件映射到实际文件路径；
- 确认当前测试基线全部通过；
- 列出新增文件和最小修改文件。

禁止：在完成映射前大规模重构。

### CLD-001：Agent Installation Contract

实现：

- Lifecycle Controller；
- node/binding/artifact manifest schema；
- 原子安装、repair、rollback 和幂等安装；
- 能力预检与机器可读结果。

### CLD-002：Agent Identity & Authentication

实现：

- Account/Node/Agent/Session 标识；
- Auth Provider 接口；
- GitHub 参考 Auth Provider；
- 三值认证结果；
- LKG 非秘密缓存；
- 每会话首次访问强制在线认证；
- scope 和完整性校验。

### CLD-003：Network Degraded Mode

实现：

- 授权与同步各自的 Circuit Breaker；
- 超时、两次尝试和总预算；
- 1 小时 LKG 上限（`lkg_max_age`，ADR-CLD-001）与 30 分钟降级会话；
- 降级权限矩阵；
- 单飞恢复探测；
- 不刷屏的状态通知。

### CLD-004：Pending Operation Recovery

实现：

- 原子 Pending Journal；
- operation_id 幂等；
- 崩溃恢复；
- 固定恢复顺序；
- optimistic lock；
- conflict snapshot；
- 远端确认后再归档。

### CLD-005：Agent Uninstall Contract

实现：

- 默认只解绑当前 Agent；
- manifest 驱动的精确卸载；
- 最后同步或 Pending 告警；
- 本地凭据立即失效；
- 远端撤销队列；
- 其他 Binding 不受影响；
- last-binding 清理提示；
- 幂等卸载和失败回滚。

### CLD-006：Codex Reference Adapter

实现：

- 对话意图到核心命令的适配；
- 当前 Agent Binding 和 session_id；
- install/status/sync/uninstall；
- 在线、降级、锁定、冲突的准确呈现；
- 安装与卸载后的自验证。

### CLD-007：端到端验收

实现：

- 全部单元、集成、故障注入和端到端测试；
- 不破坏所有既有测试；
- 输出验收报告、已知限制和复现命令；
- 不在未经用户授权时 push、打 tag 或发布。

---

## 18. 实施顺序与提交纪律

DeepSeek SHOULD 按以下顺序实施：

1. 只读审计与测试基线；
2. schema、状态机、错误码；
3. Agent Registry 与生命周期锁；
4. Auth Provider 与 GitHub reference；
5. 弱网策略与 Circuit Breaker；
6. Pending Journal 与 recovery；
7. install/uninstall transaction；
8. Codex Adapter；
9. 完整测试与文档；
10. 最终差异审计。

每个提交 SHOULD 单一目的、可测试、可回滚。禁止 rebase 和 force push。未经用户明确授权，DeepSeek MUST NOT push、创建 PR、发布 release 或创建 tag。

若工作树已有用户改动，必须保留并避开。不得使用 `git reset --hard`、`git checkout --` 或宽泛删除命令清理用户工作。

---

## 19. 测试矩阵

### 19.1 安装

- 全新节点首次安装成功；
- 已有节点安装第二个 Agent，生成独立 Binding；
- 同一 Agent 重复安装返回 ALREADY_INSTALLED；
- 半安装崩溃后 repair；
- 在线认证失败时完全回滚；
- doctor FAIL 时不得完成安装；
- 无工具能力时返回 CLD-CAP-001；
- artifact 被篡改时停止安装/修复；
- 安装不修改既有记忆或无关 Agent 配置。

### 19.2 授权

- 新会话第一次读取前在线认证；
- 同会话第二次访问不重复认证；
- 新会话重新认证；
- 401/403 明确拒绝绝不降级；
- revoked Binding 绝不降级；
- TLS 信任错误绝不降级；
- DNS/timeout 正确归类为 UNAVAILABLE；
- 缓存超过 1 小时禁止降级（`age <= 1h` 有效、`age > 1h` 失效，ADR-CLD-001）；
- 降级 scope 不超过 LKG scope；
- 30 分钟到期后强制重新尝试在线认证。

### 19.3 弱网与熔断

- 两次认证尝试总时长不超过 12 秒加可接受调度误差；
- 熔断打开后不发生秒级轮询；
- 多 Agent 同节点只发起一个 HALF_OPEN 探测；
- 网络变化触发一次恢复；
- 用户手动同步受单飞和速率限制；
- 故障期间不会为每次操作重复刷屏；
- 长时间断网不会形成无限线程、进程或请求。

### 19.4 Pending 与恢复

- 降级 CREATE/UPDATE/DELETE 均先入 journal；
- 进程在写入、应用、推送各阶段崩溃后可恢复；
- 重试保持同一 operation_id；
- 同一个 operation_id 不产生两次逻辑效果；
- 网络恢复先 auth、pull，后 replay/push；
- no-change 不写、不 sync、不 invalidate；
- push 后必须远端确认才能标记 SYNCED；
- journal 损坏不被静默删除；
- 冲突生成 snapshot 且不 force push；
- 失败批次数据不丢失。

### 19.5 卸载

- 默认只卸载当前 Agent；
- 其他 Agent Binding、运行时和记忆保持可用；
- 当前 Agent 有 pending 时展示准确数量；
- 离线卸载生成 REMOTE_REVOCATION_PENDING；
- 在线卸载完成远端撤销；
- 当前 Agent 的本地凭据立即不可用；
- 最后一个 Binding 时才提供共享清理；
- 云端数据不被默认删除；
- artifact hash/path 不符时停止危险删除；
- 重复卸载幂等；
- 卸载后当前 Agent 无法再调用 Memory Access。

### 19.6 回归与安全

- 仓库所有既有测试全部通过；
- vNext-1.3 sync 命令行为不变；
- vNext-2.0 Memory Engine 行为不变；
- 禁止 rebase/force push 的测试或静态校验通过；
- secrets scan 通过；
- 日志无 token、Cookie、私钥、Authorization header；
- 路径穿越、符号链接逃逸和宽泛删除测试通过；
- 两个 Agent 不可借用彼此 binding/session；
- doctor FAIL 阻止 canonical read/push。

---

## 20. v0.1 验收门槛

首个参考版本只有在全部满足时才算完成：

1. 用户能在 Codex 对话中完成当前 Agent 的安装、状态检查、手动同步和卸载；
2. 同节点两个 Agent 可以独立安装、独立卸载而共享底层运行时；
3. 每个新会话首次 Memory Access 前确实进行在线认证尝试；
4. 明确拒绝不会进入本地降级；
5. 暂时网络失败在最多 12 秒前台预算后停止重试并按规则降级；
6. 降级写入全部可恢复、可审计、不会伪报已同步；
7. 恢复顺序符合本协议，冲突不丢数据、不覆盖远端；
8. 卸载默认只影响当前 Agent，云端数据不被默认删除；
9. 所有既有测试与新增测试全部通过；
10. 无明文凭据、无无限重试、无危险删除、无 rebase/force push；
11. 实现文档能够让第二个 Agent Adapter 复用核心而不复制认证/同步逻辑；
12. DeepSeek 提供完整最终报告和可复现测试命令。

任何一项不满足，都不得标记为 Clued v0.1 reference complete。

---

## 21. DeepSeek 最终交付报告格式

DeepSeek 完成后必须按以下结构报告：

```markdown
# Clued v0.1 Reference Implementation Report

## 1. Result
- PASS / PARTIAL / BLOCKED
- Current branch and HEAD
- Dirty/clean worktree status

## 2. Protocol Mapping
- Each normative section → implementation files/classes/functions/tests

## 3. Changed Files
- Added
- Modified
- Intentionally untouched core files

## 4. Architecture
- Lifecycle
- Auth plane
- Sync plane
- Pending/recovery
- Adapter

## 5. Test Evidence
- Existing regression tests
- New unit tests
- Integration/E2E tests
- Fault injection
- Security checks
- Exact commands and results

## 6. Required Scenarios
- Multi-agent same node
- Explicit denial
- Weak network degradation
- Recovery replay
- Conflict
- Offline uninstall

## 7. Compatibility Evidence
- vNext-1.3
- vNext-2.0
- Git protocol invariants

## 8. Known Limitations
- No hidden failures; each limitation includes severity and workaround

## 9. Protocol Deviations
- Must be empty for PASS; otherwise cite exact section and reason

## 10. Next Actions
- Items requiring product owner decision
```

只说“代码已完成”或只展示新增测试，不构成验收证据。

---

## 22. 变更控制

本协议冻结后：

- 修正文字但不改变行为：版本升为 `0.2.x`；
- 改变超时、LKG、降级 TTL、权限或状态语义：必须写 ADR，并至少升为 `0.3.0`；
- 改变 vNext-1.3/vNext-2.0 核心兼容性：需要单独项目，不得夹带在 Clued v0.1；
- 实现发现歧义时，选择更保守、更少权限、不丢数据、不覆盖远端的行为，并在报告中列明；
- 发现 P0 安全或数据丢失矛盾时，停止相关模块实现并请求产品决策。

（v0.1.0 → v0.2.0 的 LKG 变更已按本条款执行：ADR-CLD-001 + 版本提升。）

以下决策在 v0.1 已冻结，不接受实现者自行改变：

1. 安装单位是 Agent Binding；
2. 同设备不同 Agent 分别安装；
3. 对话是安装/卸载入口；
4. 每新会话首次 Memory Access 必须在线认证尝试；
5. 只有 `UNAVAILABLE` 可以进入弱网降级；
6. `DENIED` 和安全错误绝不降级；
7. 默认 LKG 最大年龄 1 小时（ADR-CLD-001），单次降级会话 30 分钟；
8. 网络调用必须有界并使用熔断；
9. 降级写入必须进入 Pending Journal；
10. 恢复必须重新认证、先 pull、后 replay/push；
11. 远端仍是在线全局 Canonical Store；
12. 默认卸载只解绑当前 Agent；
13. 云端删除是独立高风险动作；
14. vNext-1.3 与 vNext-2.0 核心语义不可被本项目改写。

---

## 23. 可直接交给 DeepSeek V4 Pro 的执行指令

将下面内容与本协议文件一同交给 DeepSeek：

> 你现在负责在私有仓库 `tdoljyj/cross-memory-system` 中实现 Clued v0.1 的第一个参考版本。实现基线是 vNext-2.0；vNext-1.3 同步层和 vNext-2.0 记忆引擎是兼容性冻结区。  
> 
> 请完整阅读《Clued v0.1 智能体安装、授权、弱网降级与卸载协议》，把其中 MUST/MUST NOT 视为验收合同。先执行 CLD-000，只读审计仓库指令、文档、代码、测试、同步脚本和当前 Git 状态，建立“协议条款 → 实际文件”的映射，并运行既有测试得到基线。然后按 CLD-001 至 CLD-007 的顺序完成实现、测试、故障注入和文档。  
> 
> 首个适配器是 Codex，但生命周期、认证、熔断、Pending Journal、恢复和卸载必须位于可复用核心中，禁止把核心逻辑写死在 Codex 对话提示词里。当前 GitHub 是 Canonical Store；认证平面与同步平面必须解耦，不得虚构尚不存在的生产服务。  
> 
> 你可以在不改变协议语义的前提下根据仓库实际结构调整文件名和模块边界。不得引入传统 GUI 安装包，不得引入新的 SaaS/数据库强依赖，不得请求用户在对话中粘贴凭据，不得无限重试，不得 rebase、force push、覆盖用户已有改动或使用危险清理命令。未经明确授权，不要 push、建 PR、打 tag 或发布。  
> 
> 对普通实现细节自行做保守决定并继续，不要因非关键命名问题停工；但若发现协议与现有核心存在无法兼容的 P0 数据丢失、安全或权限矛盾，停止该相关模块，提供证据和最小决策问题。  
> 
> 完成后严格按本协议第 21 节输出报告，逐条给出协议映射、改动文件、测试证据、故障注入结果、兼容性证据、Git 状态、已知限制和任何偏差。只有所有第 20 节验收门槛通过，才可以声明 reference complete。

---

## 24. 冻结结论

Clued v0.1 的核心不是“把脚本包装成安装器”，而是建立一个可审计的 Agent Lifecycle：

- 用户在对话中发出意图；
- 每个智能体获得独立 Binding；
- 每个新会话仍严格尝试在线认证；
- 只有真实弱网才获得短时、本地优先的妥协；
- 网络恢复后重新认证并严格回归远端 Canonical；
- 卸载精确作用于当前智能体，不误删其他 Agent 或用户记忆。

至此，Clued Agent Lifecycle Protocol v0.2.0 冻结，可进入第一个参考实现阶段。
