# 控制根代际绑定最小差额提案

**PROPOSAL_ONLY / NOT_EFFECTIVE / NO_ROOT_OR_AUTHORIZATION_ISSUED**。这是待用户裁定的权限差额，不是已接受政策、根登记、GA或资格结果。原固定文件、现有Owner委托和旧pins均未修改。

当前唯一请求：是否允许在下述限定范围内，**经既定独立评审通过后，为现有 GitHub 签名身份基础设施登记可核验的控制信任根代际绑定**。继续使用现有签名方法，不生成或接触任何新私钥；但新增登记仍改变哪些控制对象会被接受，不能伪装成普通JSON格式化。

## 为什么需要这一项具体裁定

原 `OwnerDelegation_20260908.json` L30允许既有签名身份承担限定前Entry用途，L36–39允许构建、独立接受及满足前置后的短时GA；**L70同时明确禁止自行新建trust root、改旧pins或复用旧签名接受新subject**。本提案只请求给这一条禁令增加下述一次、限定目的的代际登记例外，不推翻其余限制。

既有 `web-flow` 签名、Owner `tdoljyj`、精确tree/blob、Bootstrap与pins摘要均是真实来源标识，但受查材料没有提供当前可直接解引用的 `control_trust_root_generation` 实例及继承/撤回链。不能把 merge SHA、`Policy.sequence=1`、pins摘要或runner generation改名填入。详见 `ControlContractConcretizationReview.md`，SHA256 `09398c3f75c582bd769fbfb0ab3d5b135d4f063c59344166df3f3b920d07346a`。

## 拟允许的精确范围

| 项目 | 拟议范围与不可越过的边界 |
|---|---|
| 用途 | 只覆盖 `PRE_ENTRY_SKILL_QUALIFICATION` / `SKILL_COEXISTENCE_QUALIFICATION` / `DP-PREENTRY-SKILL-QUALIFICATION`；目标为已独立接受的精确非生产隔离controller与待资格Skill |
| 既有身份设施 | 只复用私有仓库 `tdoljyj/cross-memory-system` 的Owner `tdoljyj`批准、GitHub `web-flow` verified/valid签名、精确双亲/tree/blob绑定。旧TM19发布资格、旧subject及pins不变；不得调用旧验证器使其隐式接受新对象 |
| 拟登记对象 | 沿S06已有 `ControlTrustRootSet` / `control-trust-root-set.schema.json`语义登记**限定用途的代际与信任元数据**；不是新控制类型、第二Canonical Store或新签名键。候选schema语法通过不等于该登记已获接受 |
| 角色 | 原Owner保留授权/撤回权；既定独立评估者 `/root/project_list_auth_fix` 审查精确对象与证据；coordinator `/root` 只有在本提案被批准且独立接受后才可登记限定绑定。实现者不得自签合格，不更换评估者或转授新主体 |
| GA/GRR边界 | 绑定中分别记录实际issuer用途与Audience，禁止把GA签发用途与结果裁决用途混同。注册成功本身不签GA或GRR；每次GA仍须全部原前置、当前授权及最长600秒约束 |
| 环境与内容 | 只限 `ISOLATED_TEST`、合成工程数据；不包括生产业务、真实用户数据、模型动作、付费、分发、候选指针、Health/Surgical、PQUAL-18后Entry正例或Slice A实施 |
| 预算 | 新增模型预算0、付费预算0；本提案不增加原委托资源上限：最多1个受控隔离测试、累计7200秒、1GiB新增本地证据；现有已用量必须扣除，登记不自动补充预算或延长Owner有效窗 |

## 起始、继承和当前性的拟议约束

1. **登记前先找真实既有来源。** 先在获准的精确控制域和完整允许历史索引内核对是否已有合法根代际；若存在，只沿其合法继承规则绑定，不能另起一条链绕过。若确实不存在，须由固定digest的只读核验给出该域无先前登记的证据，再提交“首次登记”的精确候选。**本提案不指定任何合法起始代际值**，也不把“未搜到一个文件”当成无历史证明。
2. **新登记必须绑定实际签名身份与规则。** 固定信任服务身份、Owner批准对象、允许issuer用途/Audience、适用Schema digest、验证器/config摘要、适用环境、有效窗及撤回来源。起始代际值和权威RootSet ref必须由获准的真实登记机制产生并在独立接受中绑定，不能由测试样例或未合格Skill给出。
3. **继承只能追加。** 每次合法后继保留前代不可变ref/digest及真实授权，采用经接受的代际比较/继承规则；前代历史可按当时元数据验证，不能因此继续授权新动作。key/root/purpose/Audience/schema或验证规则变化需精确后继与独立接受，不能沿用旧签名证明新内容。不得以Git提交时间、分支排序、publication sequence代替控制代际顺序。
4. **撤回独立不可变。** Owner的任何后续撤回或缩权立即关闭受影响动作；沿原Revocation Event语义追加精确被撤回绑定、issuer和签名证据，不改写旧对象。撤回不等于已终止进程、不自动释放预算或容量；保留原停止与UNKNOWN核对要求。
5. **拒绝回退与不明。** 受信当前代际不能因旧镜像、历史commit、数据库恢复或旧签名回退。未知、缺记录、链不完整、用途错误、签名失败、过期、来源离线或无法判断当前性时拒绝新授权。不能由待验证对象自行提供信任锚。
6. **当前性须有实际可验证入口。** 在每次实际副作用前核对获准权威源中的当前RootSet和完整撤回状态；当前指针/读取规则/一致性与并发更新策略必须先固定并独立接受。GitHub不可变commit回读只能证明历史字节持久化，不单独证明未撤回、最新头完整或原子副作用门；已有durability观察不直接升级为accepted Control Evidence Store。
7. **既有EpochVector保持独立。** 此登记不能替代Canonical四层account/installation/context/binding epoch，也不能掩盖真实installation及读取实现缺口。根代际、Vector、runner/credential/session各自按原合同验证。

## 必须由真实来源确定、现在不得填假值的字段

- 精确RootSet typed URI/ID及其实际generation值；是否首次、已有前代ref/digest与完整历史证明。
- 当前允许的issuer用途与Audience、适用正式Schema digest、canonicalization/算法配置、真实签名服务信任元数据及验证器精确摘要。
- 获准Control Evidence Store及控制域、当前头/完整历史索引、撤回事件集合、当前性/并发一致性读取方法；现有私库工程目录不是自动授权的第二控制权威。
- 实际签发/生效/截止时间、Owner剩余窗口与预算、独立接受ref、负责人的精确身份绑定。

这些值须在拟登记对象落定时附可核验证据；不是允许执行者用占位值完成发行。若进一步实施需要新密钥、新信任服务、生产权限、改旧pin、扩展issuer用途或新增存储权威，已经超出本提案，必须保留拒绝并另报精确差额。

## 两种裁定的实际影响

| 裁定 | 可继续工作 | 仍保持关闭的入口 |
|---|---|---|
| 保留原禁令、不允许新登记 | 继续已有授权的候选schema、隔离工程、测试、证据接线和缺口修复；已有接受与生产修复证据不作废 | 找不到合法既有控制根代际时，正式GA及依赖它的PQUAL执行保持不可进入；不把语法/本地检查升级为资格 |
| 批准本提案，允许独立审查后登记 | 可在上述唯一目的内完成精确首次/后继绑定候选、实际来源核验、独立接受后登记；同范围后继沿本约束办理 | 前置不齐仍不得登记或签GA；登记成功仍不证明controller合格、四层Vector齐备、实际隔离/预算/停止/撤回通过，更不授权R11、Slice A或生产 |

供裁定的最小范围是“**批准本提案限定的非生产控制根代际绑定登记例外，须先独立接受精确对象，其余原委托限制不变**”，或“保留原禁令”。只有用户的明确裁定及其随后真实绑定证据才可能使例外生效；本文件没有记录用户已作任何选择。

原文依据：S06 SHA `f967fdf3e63028d29ed191160698726b5d707aaae63bd951f6ba2e8584936fec` L200/235/237、L2384/2388–2390、L3876–3887、L4334–4346；`OwnerDelegation_20260908.json` SHA `e09ef634712ce1206600402552073bae91e7296f2b4e2d3f99855bd760c944bd` L30–39/52–70。精确原包成员定位见上述审查报告。本提案不改写这些源，也不声称用户必须采用本方案。
