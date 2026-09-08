# 原控制合同具体化审查

状态：**BOUNDED_REVIEW_ONLY / NO_AUTHORITY_ISSUED**。本次只读原包和既有公开验签配置，未生成 schema、资格、GA、根或私钥，未改 pins；没有重做四层 epoch 盘点。

**结论：缺少现成 JSON Schema 不是停止准备的理由。** 原合同已规定 GA、适用 Profile、DevelopmentMechanismFreezeReceipt 的核心语义、来源与边界，足以在当前 Owner 批准范围内形成忠实的候选机器表达、字段映射和校验器，再由被授权独立评估者接受。候选格式尚未接受、真实实例未绑定或控制根代际缺失时，正式签发仍不能通过。不能把“可以写候选 schema”误报为“已满足运行授权”。

## 精确原文来源

原保全 ZIP：`C:/Users/Windows/Documents/Codex/2026-09-07/ni-6/work/candidate-source/Clued_Phase2_三轨修订与补证_完整审查候选包_v0.2.7.1_Manifest修复_20260906.zip`。以下行号指其成员原始文本，摘要均本次从成员字节复算；不以提取后改写文件替代。

成员共同前缀 `P = Clued_Phase2_三轨修订与补证_v0.2.7_20260906/`，`A = P + sources/architecture_v024/`。

| 来源 | 精确成员、SHA256 | 关键定位 |
|---|---|---|
| S06 | `A + sources/Clued_Kernel_Next_多厂商连续性与执行基础设施完整整合方案_v3.3.md`；`f967fdf3e63028d29ed191160698726b5d707aaae63bd951f6ba2e8584936fec`；557313 bytes | L188–237 控制来源；L2384/2388–2394 代际与规范化；L3435 静态 Profile 引用；L3876–3887 GA/GRR；L4333–4346 唯一 schema/实例责任域 |
| 类型交叉表 | `A + data/ControlTypeAndAliasCrosswalk.json`；`c871c80c13b6eee6abf6ddc5d5189d31644d0cb872f685bd7bf33c59185252a2` | L24–40 GA；L43–59 GRR；L173–180 机制冻结回执；L364–365 根与工具链约束 |
| Profile 政策 | `A + data/QualificationPhasePolicy.json`；`154a5ca0e3d6786877662b68a173176ecd54712744400805ef4b2a93f5946f22` | L3–7 候选非部署；L9–71 前 Entry；L120–166 时限、独立代际、精确输入字段 |
| Controller 原计划 | `A + data/TestControllerQualificationPlan.json`；`b482c08ad0cb85fcec388da6505849d58e6b5d22a5982bcfefc7a2a19b204087` | L5 当前合法控制根；L19–25 独立构建与接受且不建新根；L29–30 未提供 wire 接线、不新建控制类型 |
| R09 原包视图 | `P + data/ReadinessAndGateCandidate.json`；`6d8adc8e29c3be0cd18e25925851559494f94384f79f8a2e530a68f3802d4ceb` | L167–182 R09 依赖 R08；L1198–1200 机制冻结回执类型、历史 NOT_ISSUED 和 null ref |
| S07 | `A + sources/Clued_第一方模型系统实施与验收计划_v0.8.1.md`；`74aff641b3ed0e0d034357824e1c744b5f22225ca113e87d62fc56482f3e7617` | L2150 `status=FROZEN`；L4445 pre-M0/vendor-neutral Mechanism Contract/变化失效；L4991 机制为权威源、不得签发 M0 |
| S20 | `A + sources/v03/DependencyAndGateMap.json`；`d055f84c0f6ccbfa586f260bff935f399a3b9f57a790859f0a6f684509d3fb0b` | L166–180 R09 与 R08 前置；L601 已有机制冻结回执名 |

S07/S20 来源由 `A + data/SourceLock.json` L53–58、L157–162 绑定，索引 SHA256 `ddab662da5d77c3e036adebf5f2bc3e55b1824b90dd09b7cbf73481edbaadf4d`。历史 NOT_ISSUED 是源记录的历史状态，不能覆盖本轮已签名的实际工程接受，也不能被反向编辑成运行资格。

## 可在现有目的内继续具体化的部分

| 对象/字段 | 原合同已经确定的内容 | 可以直接准备的机器表达；不能推导的效力 |
|---|---|---|
| GateAuthorization | S06 L3879：动作前签发、`ga_*`、固定 `authorization_status=AUTHORIZED`，精确 Gate/Profile/目标/Commit/Tree/Blob/产物配置/上游回执/状态与风险摘要、Subject/Binding/Scope、读写集、凭据范围、时间/Deadline/停止/回滚；撤回用独立不可变事件 | 可编码必填、常量、精确引用、摘要、集合、时间约束及缺失拒绝。名字/JSON 类型选择是忠实表达，不增加签发权；不可写占位“已授权”实例补空项 |
| Profile | S06 L3435 要求 gate refs 的 ID、精确定义版本、digest 和 definition-set digest。原政策固定 `DP-PREENTRY-SKILL-QUALIFICATION`、purpose、ISOLATED_TEST、隔离候选状态、R05–R10、必要真假边界及最长600秒 | 可表达精确允许集、禁止集、controller 与候选分离、预算/停止/sink/fixture等绑定，并实现逐字段拒绝。政策历史为候选，不能仅载入文件即当 accepted Profile；不增后 Entry、真实模型、生产或付费权限 |
| DevelopmentMechanismFreezeReceipt | 原交叉表固定 `clued-development / PHASE2-ENTRY` 类型，来源 S07/S20，明确 `runtime_wire_schema=NOT_ADDED_BY_THIS_CANDIDATE`；S07 固定 `status=FROZEN`、vendor-neutral机制对象、Contract/Digest变化失效、无M0权力 | 可把已有 R09 决定的机制精确摘要、R08父证据、独立评估与真实签名引用整理成候选机器合同，逐字段标源。不得新增第七类core控制对象、冒充GA/GRR、让Skill成为规范源，或将尚未接受的表达直接标成原Schema已验签 |
| 通用校验 | S06 L3885：schema digest、Audience、root generation、用途、签名、expiry/revocation；L3880 四种终态；L2389–2394 规范化与wire命名；L4333–4346固定责任域 | 可实施引用可解、用途隔离、过期拒绝、原字段/枚举与规范化测试。原文特定GA/GRR大写枚举与一般wire约定须保留具体规则并显式说明，不擅自改枚举。不能新增与原责任域竞争的正式schema/live实例权威 |

OwnerDelegation L30、L36–39 已允许复用现有 tdoljyj/GitHub 签名身份基础设施用于这一次限定目的，构建、独立接受、前置齐备后由 coordinator 签短时 GA；同范围后继不要求重复 Owner 确认。L53 只复用验证方法，不让旧发布验证器接受新 subject；L70 禁止新根/新本地签名键/pin改写。因此“原包没附可执行schema”可以转为具体实现任务，而不是无期限等待外部 JSON。

上述候选机器表达仍须经真实独立接受，并按 S06 L3887/交叉表L365核对适用的机器合同工具链 Bootstrap 条件。本报告不裁定该条件已满足，也不把生成schema等同于签发资格。

## 已有签名设施究竟提供什么

这些是**现有受查配置和已保留签名证据**，本次未重新安装、验签或改pin，也没有读取私钥。

| 现有来源（相对仓库根） | 实际标识与可复用能力 | 代际结论 |
|---|---|---|
| `scripts/naming-governance/publication.py`，SHA `74026fd0b6cf859b53d4f925a1147b9a787a92a426f93985f98e4077a2a028b7`，L263–279 | GitHub `web-flow`、API verified=true/reason=valid、PGP签名存在、signed tree/双亲与commit一致；L240–249验证精确Git blob | 是签名服务身份/内容验证方法，没有读取或验证 `control_trust_root_generation` 的实现；未取得可映射为当前ctr代际的密钥轮换元数据 |
| `docs/execution-plans/phase2-structure-governance/step18-publication-20260907/installation/trust-config.json`，SHA `4f571efb9499684f61b3c8879110e9f62e24d28de96ac5ff0b992498dd126f23`，L1 | 公开固定launcher/publication/policy/runtime/gh/freeze摘要；bootstrap摘要 `4b65e4190dec621dc0083ce75615446cec33137aa3f2ef2834b0be6e0f4e38a4` | 真实内容标识可用于证明受查验证器与信任配置；不是控制根代际 |
| 同installation目录 `Bootstrap.json`，SHA `4b65e4190dec621dc0083ce75615446cec33137aa3f2ef2834b0be6e0f4e38a4`，L1 | `pins_sha256=f9eb75045170e0ca266516aca24f0957c4fcefb12a8095d6f2530a26fa38c33f`；scope仅 `TM19_GOVERNANCE_READ_PUBLISH`；明示本地委托安装记录，不是新runtime authority | 不能挪用旧scope或把pins摘要自行定义成新控制根generation |
| 同step18目录 `Policy.json`，SHA `15f3b467da195c8dee6d831d3ac4d7915cf56a8e950d0796023b7b1fa623959a`，L1 | repository=tdoljyj/cross-memory-system、publisher_actor=tdoljyj、`sequence=1`及精确旧subject | publication序号不是Root Generation；旧scope不因新用途自动扩大 |
| 本目录 `OwnerDelegation_20260908.json`，SHA `e09ef634712ce1206600402552073bae91e7296f2b4e2d3f99855bd760c944bd`，L30–39/52–54/70；`IndependentOwnerBindingVerification.json`，SHA `68409c1fc1fb16dca11d5e8966c5291f2507b1b48f27551cd46bd509eed7f517` | 真实Owner目的批准和独立验证的PR20 merge `4f722ea9d78488b749c15d27fe9145e9d9f9d2c2`；既有窗口与用途边界可用于新精确对象绑定 | mergeSHA是不可变内容/授权出处，不是代际，也不证明当前未撤回 |

`trusted_launcher.py` SHA `32d0d3e2fda441e589d33a0b63042482cf4c33630bb0eb63e69d2d7bd0e6d35a` L98–140只按上述固定runtime/config/pins/bootstrap/委托摘要检验；L242还明示同UID管理员替换例外。其内容摘要不能证明有一条当前适用的ctr单调演进/撤回链。

## 真正未闭合的字段与最小裁定边界

`control_trust_root_generation` 的**语义和来源要求已明确，具体有效值没有在受查材料中建立**。S06 L200用字符串引用示例 `ctr_generation`；L2384把控制根代际与其他版本轴分开；L3885要求拒绝root回退，L4334命名 `control-trust-root-set.schema.json`。原文没有授予执行者把任意正整数、mergeSHA、pins摘要、publication sequence或runner generation改名作为该值的权力；也没有要求它必须是某种本地整数计数。不能用schema实现替代真实来源。

可继续准备：字段的引用类型、与实际RootSet/issuer用途/Audience/schema摘要的解引用和一致性校验、缺失/过期/回退拒绝；将已存在公开签名配置作为真实来源证据保留。若另有**已合法建立**的控制根代际记录，核实其来源、当前性、历史次序与本用途即可复用，不需新建根或更换密钥。

确需另行裁定的仅是：在现有材料没有这项合法记录时，是否以及如何给既有签名基础设施建立一个**新的控制根代际登记/起始代际与继承规则**；谁有权声明/轮换/撤回、哪些issuer用途/Audience/schema受信、如何拒绝回退与核对当前状态。即便仍用GitHub签名、不生成新私钥，只要新增这项控制信任锚或改变接受规则，就不是单纯JSON格式化；现行OwnerDelegation L70禁止执行者自行完成。应提交这一精确差额裁定，不泛泛要求“最高权限”，不把整个Profile/机制/schema工作一起停掉。

四层真实epoch及installation输入缺口继续引用 `IsolatedProfileSourceMapping.md`，不得用本报告涉及的签名配置代替。下一步有界工作是：继续已有目的内的候选合同与验证接线准备；保留明确未绑定的真实根代际依赖，提交具体差额；实际来源和独立接受齐备前不签GA/资格。未产生新Authority、Canonical或正式控制实例。
