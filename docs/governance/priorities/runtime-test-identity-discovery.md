# Runtime Test Identity Discovery

**Status:** `AUTOMATED_TEST_IDENTITY_NOT_AVAILABLE`  
**Mode:** `READ-ONLY / AGGREGATE-ONLY DISCOVERY`  
**Authority effect:** `NONE`

本轮目标不是创建测试身份，而是确认系统里是否已经存在可以直接复用、且满足最终 Multi-Track Zero-Memory Runtime Gate 的合法 test/non-production 身份链。

## Final Gate 所需链

```text
Test Principal
↓
Current Binding
↓
Project Membership / Access
↓
Test / Non-production Development Space
↓
Development Grant / Assignment Scope
↓
Effective Resource × Action
↓
Priority Currentness
↓
Eligible Next Action
↓
>=3 Qualified Fresh-Context Agent Runs
```

## 只读聚合结果

当前 `clued-prod`：

| 对象 | 总数 / Active |
|---|---:|
| `public.bindings` | 0 / 0 |
| `project_memberships_v13` | 0 |
| `development_spaces_v14` | 0 |
| `development_grants_v14` | 0 / 0 |
| legacy `clued_agent_bindings` | 19 / 19 unrevoked |
| `authorizations_v12` | 11 / 11 active |
| `authorization_entries_v12` | 66 |

11 个 active Authorization 的 `binding_id`：

- 命中 `public.bindings`：**0**；
- 命中 legacy `clued_agent_bindings`：**11**。

Authorization Entry 当前聚合环境只有：

```text
environment = canonical
resource_kind = scope
entries = 66
bindings = 11
```

未发现 test / non-production Development Space 或 Development Grant。

`development_grants_v14.context_id` 的外键确实指向：

`clued_private.development_spaces_v14.id`

因此 Development Grant 测试链不是隐藏在别处的独立对象。

## 结论

当前存在真实旧 Agent Binding / Authorization 记录，但它们不能直接作为最终 Multi-Track Runtime Gate 的测试身份，因为：

1. 新的 `public.bindings` 当前为空；
2. Project Membership 为空；
3. Development Space 为空；
4. Development Grant 为空；
5. 现存 Authorization 绑定的是 legacy `clued_agent_bindings`；
6. 现有 Entry 只表现为 `canonical` 环境，没有可识别的 test/non-production 开发授权链。

所以当前正式状态为：

```text
AUTOMATED_TEST_IDENTITY_NOT_AVAILABLE

ZERO_MEMORY_MULTI_AGENT_RUNTIME_GATE
= BLOCKED
```

这不是要求用户现在手工创建测试身份。

根据多轨基线的最小用户负担原则，当前 Bootstrap 验收应：

- 保留已经完成的 `25/25 STRUCTURAL SAFE-ANSWER COVERAGE`；
- 不复用 legacy canonical Authorization 冒充测试环境；
- 不自行创建 Binding / Membership / Development Space / Grant；
- 不要求用户手工创建账号、开三个 Agent 或整理 Evidence；
- 待后续有合法 implementation/authorization work 建立 non-production test identity 后，系统自动继续最终 Runtime Gate。

## 当前允许继续的工作

仍可自动继续：

- Repository Projection 只读复核；
- Source / SHA / Drift 验证；
- Fresh-Agent structural recovery；
- 当前治理 Inventory Review；
- CI 启动问题诊断。

当前不得据此执行：

- 生产 Canonical 写；
- 新建/扩大真实 Authorization；
- 将 legacy canonical Binding 改造成测试 Grant；
- 声称最终 ≥3 Agent Runtime Gate 已 PASS。
