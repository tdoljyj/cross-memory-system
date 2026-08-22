# Clued Kernel R5 · K1 架构与合同冻结

- Gate：`K1`
- 裁决：`FROZEN`
- 冻结日期：`2026-08-22`
- 实现基线：`30c2f69723d897f235d971d6e0847b44b69d5699`
- 机器合同：`docs/r5-kernel/contracts/kernel-contract-v1.json`
- 合同版本：`clued-kernel-r5-k1/1.0.0`
- 产品 / 协议：Clued `0.2.0` / Agent Lifecycle Protocol `0.3.0`

## 1. 裁决与边界

K1 冻结 Clued Kernel 的架构边界和外部可观察合同。冻结对象包括：分层与依赖方向、Controller 公共入口、认证/同步双平面、状态机、Pending Journal、恢复顺序、数据 Schema、CLI JSON 包络、稳定错误码和退出码、兼容性与变更纪律。

K1 不执行发布、部署、真实 Binding 修改、语义召回启用、旧 holdout 读取或 R4 证据重跑。语义召回仍为 `DISABLED / NOT PRODUCT-QUALIFIED`；当前安全召回基线仍是 MIV-005A。

用户在 2026-08-22 明确下达“执行 K1 架构和合同冻结”，该指令构成对旧“K1 保持锁定”的明确解锁。它不把 K0 的 `NO_GO` 改写为 `PASS`，也不豁免后续门禁。

## 2. 真值收据与 K0 隔离

K0 证据提交为 `951078fc173809547ed377bfe326c68b9e476ac9`。K1 开工前使用 `merge-base --is-ancestor` 核验：该提交不是 `origin/main@30c2f697` 的祖先；本地 `r5-kernel-cloud-canonical` 相对 main 为 `ahead 1 / behind 2` 的隔离分叉，远端不存在该同名分支。旧“未 push/merge/tag/deploy”记录仍成立。

K0 的软件结论继续有效：

- K0 裁决仍为 `NO_GO`；
- 11 项卸载路径失败来自 Binding 目录残留 `state.json`；
- 1 项失败来自过时的环境归因断言；
- K1 只冻结现状合同，不声称上述回归已修复；
- K2 在新鲜全量回归、密钥扫描和明确授权前保持锁定。

## 3. 冻结架构

```text
Conversation Adapter / CLI
            |
            v
Lifecycle Controller  <---- 唯一编排与状态转换入口
       |           |
       v           v
  Auth Plane     Sync Plane
       \           /
        v         v
 Local Runtime: Registry / Journal / Audit / Locks / Manifests
                    |
                    v
 Controller bootstrap + Installer lifecycle + Memory Gate + Paths
                    + Sync Provider  <---- 仅允许的旧核心桥接面
          |                    |
          v                    v
 Memory Engine vNext-2.0   Git Sync Layer vNext-1.3
          \                    /
           v                  v
             Canonical Store
```

冻结的不变量：

1. `clued.controller.Controller` 是安装、认证、记忆访问、同步、状态、卸载和 doctor 的唯一编排入口；Adapter 不得绕过它。
2. 认证平面只回答当前 Binding / Session 是否获准；同步平面只负责本地与 Canonical Store 的版本收敛。拒绝、不可用、同步失败不得互相伪装。
3. `DENIED` / `DENIED_SECURITY` 立即 fail closed；只有严格的 `UNAVAILABLE` 加合规 LKG 才可进入 `DEGRADED_LOCAL`。
4. Canonical Store 是在线全局真值。降级期本地仅是临时操作真值，Pending 不得伪报已同步。
5. 任何 canonical push 必须走既有 Sync Layer；先 pull、再乐观锁验证、再 replay、再 push、再远端确认。
6. doctor FAIL 阻断 canonical read 与 push。仅既有协议定义的“本地安全落后”或精确 Clued 崩溃残留可按原流程自愈并复查。
7. 冲突显式进入 `CONFLICT_REVIEW`；禁止自动 last-write-wins、rebase、force push 或本地覆盖远端。
8. `.clued` 运行时、授权缓存、Session、Pending payload/journal、冲突快照和锁不得进入 Canonical Store。
9. `NO_CHANGE -> NO_WRITE -> NO_SYNC -> NO_INVALIDATION` 保持跨层不变量。
10. 旧核心导入只允许出现在五个白名单模块：Controller（Engine repo 上下文）、Installer（lifecycle 初态）、Memory Gate（对象读写）、Paths（路径解析）和 Sync Provider（同步协议）；新增桥接点必须重新审查。
11. K1 不赋予语义召回、发布或部署权限。

## 4. 冻结合同面

机器合同是值级唯一事实源；本节是人类可读摘要。两者不一致时，K1 专项测试必须失败，禁止静默选择一方。

### 4.1 Controller

冻结以下公共入口及参数名：

- `install`
- `auth_check`
- `auth_policy`
- `memory_recall`
- `memory_write`
- `sync`
- `status`
- `uninstall`
- `doctor`

CLI、Conversation Adapter 和未来 Adapter 只面向这些入口，不依赖 Controller 私有方法或 Local Runtime 内部布局。

### 4.2 CLI 与响应包络

冻结命令族：`install`、`auth check/policy`、`status`、`memory recall/add/update/supersede/delete`、`sync`、`uninstall`、`doctor`。

`--json` 模式 stdout 必须且只能输出一个 JSON 对象；诊断写 stderr。响应包络固定字段为：

`protocol_version, request_id, ok, code, state, message, data, actions, retry_after_seconds, timestamp`

降级本地成功可以 `ok=true`，但必须显式返回 `DEGRADED_LOCAL`；未同步结果不得使用 `SYNCED` 语义。

### 4.3 认证

结果集合冻结为 `AUTHORIZED / DENIED / DENIED_SECURITY / UNAVAILABLE`；所需 scope 冻结为 `memory:read / memory:write / sync:request`。

在线预算冻结为：连接超时 3 秒、操作超时 5 秒、最多 2 次、总预算 12 秒。降级 Session TTL 为 1800 秒。LKG 策略为 `balanced=21600s`、`strict=3600s`；新装默认 balanced，旧安装缺字段时保守迁移 strict；最大 LKG 年龄不得超过 21600 秒。

`LOCKED -> AUTH_REQUIRED` 只能由新的在线 `AUTHORIZED` 加账户、scope、Binding 和完整性校验共同触发；旧 LKG 不得解锁。

### 4.4 状态机与 Journal

11 个规范状态及全部允许转换由机器合同完整冻结。任何新增、删除、重命名状态或改变允许转换，均属于 breaking change。

Pending Journal 的传输语义为至少一次，逻辑效果由稳定 `operation_id` 保证幂等。状态只允许：

- `PENDING -> APPLYING / CONFLICTED / REJECTED / PENDING_CORRUPT`
- `APPLYING -> SYNCED / CONFLICTED / REJECTED / PENDING_CORRUPT / PENDING`

`APPLYING -> PENDING` 仅用于崩溃后的幂等恢复；`SYNCED` 必须晚于远端确认。

### 4.5 恢复顺序

恢复顺序逐项冻结：

1. `ACQUIRE_SINGLE_FLIGHT_LOCK`
2. `AUTHENTICATE`
3. `DOCTOR_PASS`
4. `VALIDATE_PENDING_JOURNAL`
5. `PULL_VIA_EXISTING_SYNC_LAYER`
6. `VALIDATE_REMOTE_HEAD`
7. `LOAD_PENDING_IN_ORDER`
8. `REPLAY_WITH_SAME_OPERATION_ID`
9. `CHECK_OPTIMISTIC_LOCKS`
10. `RUN_EXISTING_MEMORY_VALIDATION`
11. `PUSH_VIA_EXISTING_SYNC_LAYER`
12. `VERIFY_REMOTE_RESULT`
13. `MARK_PENDING_SYNCED`
14. `INVALIDATE_ONLY_IF_CHANGED`
15. `CLOSE_BREAKERS_AND_RETURN_ONLINE`

顺序变化是 breaking change，必须提升合同 major 并重新开放冻结裁决。

### 4.6 Schema、错误码与退出码

冻结 Schema：node、binding、auth-cache、pending-op、pending-payload、revoke-task、session-auth、runtime-state、conflict 和 policy version。具体版本值见机器合同。

冻结退出码：`0 / 10 / 20 / 30 / 31 / 40 / 41 / 50 / 60`。已有 25 个 `CLD-*` 错误码的语义不得改变；新错误码只能细化，不得复用旧码表达不同含义。

## 5. 兼容性与变更控制

以下变更可在合同 v1 内追加，但必须有测试和文档：可选响应字段、不会改变旧语义的新错误码、内部实现替换。

以下变更必须提升合同 major，并由明确指令重新开放冻结：

- Controller 公共参数删除、重命名或语义变化；
- 状态或允许转换变化；
- Schema 既有字段语义变化；
- 认证结果重分类或放宽 fail-closed；
- 恢复步骤删除、重排或绕过；
- 认证/同步平面合并；
- 允许 Adapter 或运行时直接修改 Canonical Store；
- 启用语义召回或改变产品资格结论。

## 6. K1 验收与后续门禁

K1 专项测试 `tests/test_r5_k1_contract_freeze.py` 必须验证：

- JSON 合同可解析、版本与真值收据自洽；
- K0 提交与冻结 main 基线保持非祖先隔离；
- 产品/协议版本、Controller 参数、CLI 命令、包络字段与实现一致；
- 状态机、Journal、恢复顺序与机器合同逐值一致；
- Auth 常量、策略、Schema、错误码和退出码逐值一致；
- Clued 与旧核心的导入只出现在冻结桥接模块；
- K2 保持 `LOCKED`，语义召回保持 disabled。

K2 解锁前仍需：K0 回归修复或明确接受为有界债务、重新运行全量回归、密钥扫描零命中，以及新的明确 K2 授权。
