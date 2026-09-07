# Clued Context v1.1 实现独立验收

日期：2026-09-07。审查对象：`C:/Users/Windows/Documents/Codex/2026-09-07/p/work/context-ownership-v11`，起点 `3064d77c1390b4b4dbb9db903df9f2fee75bf27c` 的未提交后继实现。审查者没有修改实现、生产或冻结治理文件，仅新增独立测试。

**结论：本报告列明的本地数据库与 Worker 独立验证通过，所发现的本地P0已修复；完整方案及生产发布仍未完成验收。** 独立测试最终 9/9、完整数据库测试两种迁移基线合计 14/14，均实际运行退出 0。本文不把静态检查、实现者报告、模拟传输或旧 TM19 PASS 改称生产实测。

## 独立实际运行

工作目录：`apps/clued-cloud`。Windows 原生 embedded-postgres，真实 PostgreSQL；没有启动 Docker或创建付费环境。

| 命令 | 结果 | 实际覆盖 |
|---|---|---|
| `node --test --test-force-exit tests/context-ownership-independent.test.mjs` | 9 PASS，0 FAIL；最终运行约 3.85 秒 | REST/MCP 原样保留已批准的领域正文；MCP撤销错误不返回成功旧包；真实 anon/authenticated 角色下Owner项目库存、列表环境、Binding project scope、Binding期限；PENDING不公开、保留旧current、篡改staged payload拒绝、恢复后同key交付与重放；真实typed receipt对象 |
| `node --test --test-force-exit tests/context-ownership-db.test.mjs` | 14 PASS，0 FAIL；约 10.52 秒 | 独立运行实现者提供的全部DB测试；production M1基线与仓库全部迁移两种profile；身份、Grant/Link、可信历史、固定版本、真实角色拒绝、旧数据槽隔离、并发CAS、故障回滚、精确接受/发布、反馈、撤回与TTL；User自有批注及源引用；Worker→真实PG的三RPC调用链 |

独立测试中的 Worker 上游使用传输fixture，证明真实 Worker 路由/返回处理，不证明线上 Supabase 授权。完整DB测试另将Worker的RPC传输桥接到真实PostgreSQL；Auth GET user及JWT仍是fixture，不证明线上签名认证。数据库测试在真实数据库的受限角色执行；管理员仅负责fixture和故障注入，业务调用以 anon/authenticated 角色及各自Binding运行。

完整14项独立运行绑定迁移摘要 `6dea03c0cddeff43987c69c126caf09af0b0ff8aa5e86116a473dfa0b463ce89`。随后唯一SQL变化为Owner管理列表增加已有项目下拉数据；最终 `9987438b…` 用新增Owner项目跨账号隔离负例及9项独立脚本补验通过，未机械重跑未受影响的14项。实现者另报告最终14项全通过，与独立执行记录分开。

### 最终小范围静态补验

运行验收后，主执行者补充Owner项目/Binding/Grant下拉、用 `useCallback` 统一 `clearPrivate` 并让effect清理绑定原 `activeGate`；数据库测试仅增加临时目录删除的路径护栏。本审查者重新读取最终文件并核对摘要，未发现新增P0，未重跑未受影响的数据库用例。

- 下拉数据来自Owner管理响应；项目、连接和Grant仍由SQL校验真实owner/scope。Grant下拉限定当前context，更新保留grant ID及CAS版本；账号状态变化清空项目、Binding、Grant列表与选择，不从显示名称推断授权。
- `clearPrivate`保持清除正文、结果、接受、发布ID及请求generation；TTL、模式变化和隐藏页面复用该函数。模式切换另清token，账号变化另清Owner元数据。effect cleanup使用注册时的 `activeGate` 并取消对应订阅和监听，不引入持久正文或凭据存储。
- 测试清理先将目标解析为绝对路径，要求直接父目录等于系统临时目录、basename以 `clued-context-v11-` 开头，再进行递归删除；业务测试、迁移和Worker字节未因该护栏变化。

以上仅是受影响变更的静态补验，不新增浏览器或运行PASS。最后build/typecheck/lint/API及旧回归日志由主执行者保留，不能算作本审查者独立运行。

### 发现、修复与独立复验

| ID | 严重度 | 最初发现 | 最终处置及证据 |
|---|---|---|---|
| IV01 | P0 | 通用脱敏函数递归删除已批准payload内的 `user_id`、`binding_id` 等合法领域字段，但保留原payload hash；REST/MCP都返回不一致内容。 | 独立测试初次真实 2 FAIL。新增仅适用于context的元数据脱敏器，正文原样保留；相同两条独立用例复验PASS。旧工具不变。 |
| IV02 | P0 | 页面TTL及授权错误只清结果，不清已展示在输入区的开发正文；模式切换保留Developer Token。 | 主执行者修复；独立静态核对TTL/错误清正文及模式清token。真实页面切换证据由主执行者提供，未由本审查者重复运行浏览器。 |
| IV03 | P0 | 页面授权缺少SQL必需的expiry；反馈action命名和MCP response类型与SQL不一致；更新Grant缺CAS字段。 | 已静态核对到expiry、单独更新按钮、正确action/response类型。完整Owner页面→真实DB路径仍由最终消费者验收负责，不以typecheck代替。 |
| IV04 | P0 | context_list早返回未统一检查环境、Binding project scope及Link，可能暴露私密资源名称。 | 执行者修复；独立真实PG环境隔离与scope枚举负例PASS。 |
| IV05 | P0 | 新入口未兼容检查可选Binding期限；已过期Binding可能仍使用有效Grant。 | 执行者修复；独立PG为M1基线加入可选expires_at列，旧token+未过期Grant在Binding过期后实际拒绝。 |
| IV06 | P0 | 初版发布直接VERIFIED，没有可复验的staged交付边界；回执/事件只有UUID。 | 执行者加入PENDING→第二事务delivery及private typed receipt/event视图。独立PG验证PENDING不可读、旧head保留、篡改拒绝、同键恢复与重放、receipt对象存在，PASS。 |
| IV07 | P0验收缺口 | 原H11仅由Developer Binding写另一条记录，未验证User自有批注和只读来源边界。 | 已补独立User context写授权；User Binding在自有context写精确source id/version/hash引用，源更新返回changed，撤销源Grant后保留个人正文并返回restricted。独立完整DB两profile运行PASS，错误source version拒绝。 |

IV02/IV03 的静态修复不能替代真实消费者验收。IV06 使用单一同数据库 `canonical_api` 渠道，不证明任何外部消费者交付。

## 审查后的适用范围

新开发正文位于同一在线Canon的private扩展；旧用户级日志、Evidence和回执不得承载私密正文。独立开发Binding、User Binding及登录Owner管理入口分开；登录及安装Skill不创造开发权限。新权限只覆盖个人所有者、显式项目及Grant；组织/跨所有者扩展没有被本次接受。

用户授权历史由服务器游标、固定版本或明确集合决定，不依赖客户端observed_at。接受绑定精确来源版本/hash及发布payload，交付重新检查当前授权和current CAS；同键重放前仍核当前权限。读接口无持久缓存，外部已复制正文不保证收回。

当前MCP授权拒绝走HTTP错误及JSON-RPC error，不包含成功旧package；不应将其解释为成功 `isError:false`。本次未证明所有外部MCP Host对该错误形式的兼容性。

## 尚不能判PASS的范围

1. **H10外部模型上下文隔离**：页面和请求生命周期清理不是模型遗忘；必须在实际Host用新的隔离会话及独立User Binding验证普通自测。主执行者已明确此边界，当前不能称H10全通过。
2. **真实消费者及生产**：当前没有本审查者执行的真实Owner登录→Grant/Link→独立User连接恢复、正式目标部署、启用flag及线上两Binding证据。主执行者报告的本地浏览器模式切换属于局部消费者证据。生产迁移/部署/启用未执行不得称已上线。
3. **Skill后继安装**：本次不能静默修改已安装Skill或TM19 pins。后继适配说明不等于已受信安装及实际多Host恢复。

上述范围是验收状态，不是要求重跑初代21步治理。后继发布绑定exact commit、迁移hash、Worker产物/flag、实际新tool/RPC schemas及权限、目标环境/受众/渠道、验证与回退即可。仅当实际修改TM18投影、Skill安装、TM19 Activation/pins时，核验对应受影响后继subject；不修改旧冻结字节、不借旧PASS证明新能力。

## 受验文件摘要

以下摘要绑定本报告的受验代码，后续改动应按影响补验，不将本次PASS无限延用。

| 文件（相对app目录） | SHA256 |
|---|---|
| `worker/continuity.ts` | `16782f4323c70d119d55f9e69adbfe4d6a3439b371347adf5767853dcb42804b` |
| `worker/contexts.ts` | `066cd8b6955c0dde8592aea0c654c4d2306f07bb5e4c3e70255300bbc47702d5` |
| `app/contexts/page.tsx` | `6052c1bcb9a3334dec9ad1a9acbd11c674d941ce1b524659e5df32b83674f5ac` |
| `app/contexts/context-session.ts` | `aea328f3a0d5634d4edf0ba8050fcbca832ebeed137640f0dfc89f23d8c95616` |
| `supabase/migrations/20260907123955_clued_context_ownership_publication_v11.sql` | `9987438b8a12af237b51eec93577e4617849d87e70d40deb7d5195b03c1d01db` |
| `tests/context-ownership-db.test.mjs` | `9579790863bbbc1a6457bab84ee3c4f69f70a86f26f2e9dc067c4adf418377fc` |
| `tests/context-ownership-independent.test.mjs` | `835a35cd52ba6534e0413d8008bada191a0e0a8d5b2dabf52eb298bfa3a06a69` |

独立运行没有发布、变更生产权限或写入用户真实正文，没有提交代码。本报告须与后续最终交付清单一起解读，不能单独当作全案接受决定。
