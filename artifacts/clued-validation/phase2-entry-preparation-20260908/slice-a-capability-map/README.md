# Slice A 已有能力与最小接线位置

这是 A04–A07 的只读工程盘点，绑定主分支 `950a40b18d637d0f924a835efd93a09950fc7b81`。独立核对时主分支已从任务指定的 `dc67669` 前进，工作区与新主分支一致。没有实施 Entry 后功能，没有运行正式 Slice A，也没有重跑隔离探针或已有测试。

现有服务提供可复用的事务、鉴权和续接基础；缺口主要在从来源到候选、最小上下文及撤回影响的完整接线。精确文件、行号、既有检查及 24 个 case 对应关系在 [CapabilityMap.json](CapabilityMap.json)。其中“已有检查”指本次检查过的测试定义，不表示这些测试本轮执行或已替代正式验收。

| 范围 | 已有基础 | 后续最小工作或未成立条件 |
|---|---|---|
| A04 来源接入 | Evidence 元数据、摘要字段、来源 owner 检查、幂等 Receipt | 实际来源字节验真、会话切片与来源去重尚未找到完整服务入口 |
| A04 候选确认 | M1 Record CAS、权威分类、Decision supersede；项目有确认状态 | 项目确认不等于提取事实确认。缺候选接受／冲突／拒绝隔离流；M1 inferred 记录仍可直接 active |
| A05 先鉴权再检索 | exact-context search 先检查 binding/session，再限定 owner/scope；项目列表先过滤后 LIMIT | global record_list 先聚合再过滤来源，不可外推为所有路径均先限制私有读取 |
| A05 最小上下文 | ID/version、确定性 lexical search、当前视图与历史日志分类 | 未找到运行接线的 Context Compiler、真实 tokenizer、2048 token 强约束保留及不足即拒绝 |
| A07 来源撤回 | Record 撤销／归档及来源 unlink；当前记录检索排除失效记录 | 缺 Evidence 撤回到依赖 Record、checkpoint、Context Pack 的传播及失效证据 |
| A07 缩权 | 当前资源授权缩减、CAS、撤销/过期实时检查 | Canonical 字段级范围与编译缓存失效尚未接线；development allowed_fields 不授权个人 Canonical 数据 |
| A07 投影重建 | 现有 buildSnapshot、来源校验、确定性对象/五视图/索引生成 | 可复用生成器；但委托连接禁止全账户 export，必须先有合法隔离导出，不能用管理凭据绕过 |
| A07 中断幂等 | M1 请求摘要幂等、持久 checkpoint CAS、恢复入口 | 旧 checkpoint 重复键分支未比较新 payload/context；完整纵向链中断尚未运行 |
| A07 无模型读取 | SQL 精确记录与 lexical 路径不要求模型 | 仍须真实已知对象/版本场景及明确语义不可用；不能以读取成功代替第三 AI 生成 |
| A06 第三会话回接 | session restore/checkpoint、Evidence 与 artifact refs、跨宿主参考件 | 尚无两来源 Context → 独立真实第三 AI → 实际产物 → Receipt 的完整运行 |

后续实际输入齐备后，最小顺序是：复用 M1 而不另建 Canonical；补来源与候选适配；围绕精确授权读取加一个确定性 Compiler；补源撤回、字段缩权及 Context 失效；复用快照生成器与 M1 幂等核对；最后执行真实第三会话、产物回接及已预登记测量。

`kernel/` 下的 InMemoryContinuityLedger、InMemoryOperationCommitStore 和相关参考检查只能说明已有算法骨架。当前 MCP 可用、数据库事务检查、参考核验以及固定 AppContainer 合成探针均不能签发 Entry、Skill/controller 资格或 Slice A 通过。模型、第三会话、隔离环境、Authority/Profile/GA、独立 Gold/tokenizer 和 72 槽位仍按实际条件分别核定；本盘点没有扩大任何权限。
