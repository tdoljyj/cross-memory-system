# Owner 自动审批持久开关 v0.1

Owner Decision `78388e18-eb33-40a6-876d-8e0a1ae1db45`；执行 Task `9b560d13-eff2-4ac2-9580-c52b13a7e3f9`。替代 OwnerCredential §12 的限时交互，不替代 §12.2 动作白名单、§4 风险规则、资源/Binding/Task 约束和正式门。

## 状态和接口

`clued_owner_grants_list_v1` 的 `auto_approve` 返回 `on:boolean`、`version:integer`、`persistent:true`、动作覆盖及排除列表。账号无设置为 `on:true/version:0`；未知或旧服务结果不得被客户端推断为开启。读取没有设置写副作用。

仅 Native Owner 登录会话可调用 `clued_owner_auto_approve_set_v1({enabled:boolean,base_version:integer})`。客户端固定点击时账号的请求 Authorization，防止等待异步认证期间切换账号导致写入新账号；不修改共享客户端的全局认证头。保存前服务校验直接账号与真实 session_id，按 owner_grant_lock 串行化并执行版本 CAS。只有 `status:committed` 加有效状态才报告保存成功；并发失败返回 `owner_auto_approve_version_conflict` 与当前状态，客户端保持或刷新权威状态后由 Owner 再次选择。开关保存不选择时长、不生成无限期 Grant。

旧 `confirmation_issue/on/off` RPC 统一拒绝 `owner_auto_approve_successor_required`，防止旧页面或延迟的令牌覆盖新的选择；历史令牌、时段和回执保留。

## 数据转换与审批

最后一次明确手动 Off 保持 Off；旧计时 On 或自然到期转为持久 On。旧开启替换时段所产生的关闭标记不是 Owner 手动 Off。迁移为每个实际转换记录保存来源、布尔选择与不可变回执。

默认 On 首次被实际审批使用时，在相同 Owner 锁下建立默认政策 Receipt 与真实持久载体；每个自动 Grant 继续以 auto_approve_id 引用真实载体。显式关闭即使发生在首次使用之前也持久保存，默认初始化不能覆盖它。

高风险授权 1 次、24 小时；常规授权沿用有效请求建议或 4 小时默认值。每条授权只覆盖请求的 Binding、资源与 Task，并有独立有效期。关闭停止后续自动批准；已发授权仍按原期限/次数有效且可撤销。connection.permission、model.dataset_split.* 及未加入白名单的新动作仍需独立确认。

## 验证边界

验证默认开启、显示与实际批准一致、Owner Off 持久保存、重开、CAS 冲突、登录与账号隔离、旧时段转换、真实载体/Receipt、授权独立期限、四个审批门、排除动作，以及完整和已安装生产迁移两种形态。手工批准流程的回归测试显式将测试账号设为 Off，不改变生产默认值。

源码和本地测试不证明生产已应用；上线由现行正式迁移/发布门和线上读取结果证明。
