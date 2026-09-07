# Context v1.1 后继实现范围与交付边界

状态：本地实现及限定验证；真实Owner网页登录与浏览器操作已核实，生产发布、两独立消费者与已安装 Skill 后继接线尚未完成。本文不签发线上 Canonical 业务接受，不把旧 TM19 PASS 用作新能力凭证。

## 真实起点

- 授权来源：本任务用户要求执行已交付的 v1.1，并采用《执行计划生成提示词-直用版.md》降低执行成本。沿用已授权工程工作及常规代审，未新增发布主体或信任根。
- 源码起点：`3064d77c1390b4b4dbb9db903df9f2fee75bf27c`，根 VERSION 为 `Clued-v1.6`，该提交无直接 tag。独立分支 `codex/context-ownership-v11`；不改其他任务工作区。
- 交付前正常快进对齐远端 `793fb0945e8b188d34b21af02dae87adc15d0abb`。上游新增Canonical搜索迁移、修订User Skill指引及应用AGENTS；本次运行代码无合并冲突。数据库两基线均补入搜索迁移，并新增无Grant连接在默认/历史搜索中不能找到私有开发正文的断言，14/14复验通过。原独立审核仍绑定其列明的原始摘要；本次追加验证由主执行者完成。
- 正式目标：Supabase `ccxsikzwxlolxqlosril` / Worker `clued-cloud` / `https://clued.pixelgrav.com`。旧 `.openai/hosting.json` 属另一个 Sites 发布面，未向其部署本次能力。
- 2026-09-07 只读核对正式 Worker：deployment `b7fb9087-0ce8-4b84-8c69-f0403b547c2c`；version `127811f4-997f-4815-b7ca-089dc387004c`，100%，注释 `Clued PR8 log isolation bf0baaa`。此为实际环境观察，注释本身不是源码制品绑定证明。
- 正式数据库仍为生产 M1 的旧 Binding 结构；仓库 P5 迁移存在不等于生产已执行。因此数据库测试同时运行生产 M1 与完整仓库两种基线。

## 必要变化及复用

| 范围 | 最终实现 | 必要性与影响 |
|---|---|---|
| Canonical 扩展 | 同一个 Supabase 的 `clued_private.context_*_v11` | 旧 Record/Event/Evidence/Receipt 的同账号可读路径无法执行 Binding 级 Grant；开发正文、反馈、证据选择及操作结果必须隔离。没有第二个数据服务或 Markdown 双写。 |
| 事务及审计 | 复用现有 PostgreSQL 事务、版本序列、CAS和幂等合同；新私有 Operation 是 Event/Receipt 规范对象的事实源，私有视图按真实 ID 派生 | 不把新正文放进旧可见日志。这里复用的是合同与数据库原语，**未调用旧 M1 正文写槽或伪称旧 M1 实体写入**。 |
| Binding | 新真实 Token/OAuth 路径仍核已有 Binding，另外核显式 Grant；P5字段存在时兼容有效期 | 登录不赋 Developer 能力；不自动创建 OAuth Binding。Owner管理要求普通登录JWT，拒绝委托OAuth客户端。 |
| 旧兼容边界 | 旧Binding表新增限制性OAuth RLS：委托客户端只看自身绑定，不读别的token_hash或修改绑定 | 这是明确的访问收窄，不能声称旧授权完全不变。普通Owner管理及既有安全定义函数保留；真实角色负例覆盖。 |
| 历史恢复 | Grant + Link、服务器游标、固定读点/最新版本/明确集合；个人批注使用用户自己的Context | 同一原ID不复制为另一权威；源变化和撤权不覆盖用户批注。 |
| 接受与发布 | 精确来源版本/hash、payload、环境/受众/渠道；先PENDING，再 `publication_deliver` 核验及CAS切current | 首批仅 `canonical_api`，单一必需消费者。没有外部广播平台。中断、篡改、CAS失败均保留旧current。 |
| 服务/页面 | 新RPC、MCP `clued_context`、`/v1/contexts`、Owner入口、`/contexts`页面 | `CONTEXT_OWNERSHIP_V11` 缺省关闭；原工具列表关闭态回归通过。页面不保存连接令牌，清除过期/切换结果。 |

Hash合同为 `SHA256(UTF8(PostgreSQL jsonb::text))`。它绑定规范JSON内容，不声明HTTP空白、对象键顺序等传输格式逐字节相同；接受和交付在同一规范下核验，Worker保留已授权payload中的全部领域字段。

## 冻结边界

未修改 `development/contracts/phase2/SourceIndex.json`、TM18五个投影、TM19 authority-index、Activation、发布器或本机pins。新RPC/tool/schema/权限属于独立后继运行语义，本目录记录其影响与证据；不把新增叫作“语义不变”。只有实际安装后继Skill或更新这些冻结对象时，才验证对应后继subject及受影响合同。无需重跑初代21步。

本次旧TM19读操作曾失败在一个GitHub文件请求；定点同资源读取随后成功。保留这项失败，不冒充整次读成功。该旧对象未被改动，其历史资格既不证明也不替代本次新运行能力。

## 上线前仍需的实际证据

1. 普通Owner登录已在实际生产网页核实，账户与用户指定账号一致，页面点击也通过。仍需签发/选择可撤销的Developer与独立User连接；通过真实Supabase签名认证完成授权、关联、晚登录恢复、撤权后拒绝。管理连接不能替代这两个普通调用主体，网页登录本身也不证明新上下文权限链通过。
2. 实际AI Host的新隔离会话，只带User Binding及获准普通产品上下文，验证H10。网页清空和模拟JWT无法证明外部模型隔离。
3. 对实际Skill后继消费者完成受影响范围绑定与安装核验。文档适配合同不等于已经安装，不能自动更新旧pins。
4. 以上证据具备后，绑定最终提交、迁移摘要、Worker构建清单、能力开关、精确目标及回退点；沿既有部署通道迁移→部署→限定启用→实际双连接验证。

当前尚未执行生产迁移/部署/开关，也未签发新生产Binding。Owner实际登录已核实；未完成的是新能力消费者与授权链验证，不能再将其笼统写为“用户未登录”。创建新安全敏感连接需在实际创建步骤确认其权限范围；后继Skill仍按实际变更范围资格核验。

## 回退与最小恢复

- 发布前保存实际Worker当前deployment/version及当前SQL策略定义。正式值必须现场再核，不能无限期使用上面的观察值。
- 新Worker开关关闭只关闭Worker入口；**不能阻止直接PostgREST RPC**。若已发新Grant，应先以Owner管理撤销受影响Grant、核直接RPC拒绝，再关闭Worker开关；保留记录、批注和不可变审计。
- 待交付版本可按原ID/version/expected_current和原幂等键重试；发生CAS冲突先重新读取，不能覆盖新current。生产源错配则停止对应交付。
- 不删除Canonical表、不恢复旧宽泛OAuth读取策略、不force/reset；保留前向兼容迁移，必要时沿既有Worker版本回退。

## 成本控制的实际落实

复用已有Node依赖和原生PostgreSQL，不安装Docker、不新建付费环境；一份双基线fixture覆盖多数断言，接口复用原路由，单渠道闭环；一次独立审核后仅按变更补验。Windows默认bash指向不可用WSL后，改用已安装Git Bash，一次构建成功，没有修改网络、代理或系统权限。未把旧全部治理、全Host排列、多渠道后台系统加入当前前置条件。
