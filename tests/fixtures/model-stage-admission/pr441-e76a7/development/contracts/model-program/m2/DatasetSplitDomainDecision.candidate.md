# DatasetSplit 数据领域定义：一次裁定候选 v0.1

状态：CANDIDATE / NOT_ADOPTED。此文件准备精确的领域定义与接线决定，
不是正式 DatasetSplit、Domain Authority Receipt 或 M2 PASS。

## 有界查证结论

截至本次查证，在下列明确范围内未找到已发布的 DatasetSplit 机器定义或
Domain Authority Receipt schema/签发接线；不能扩大为“所有外部材料都不存在”。

| 已查来源 | 结论与证据强度 |
| --- | --- |
| 正规 release `information-flow-m0-frozen-archive-20260908` 的 A/B/C 原包 | 三包 transport 与内部 SHA256SUMS 匹配，35/12/159 个声明文件全部通过原 adapter；无 DatasetSplit 或其 receipt 定义。父包只定义 Information Flow 的 Schema/Taxonomy、Prompt/Config、Fixture/Gold/Threshold/Harness |
| 当前仓库 model-program 合同及整个工程树的 DatasetSplit 拼写检索 | M2 候选之外没有该机器对象 schema；M0 `EvidenceReceiptTemplates.json` 仅列四种 M0/Projection evidence 模板，没有 Domain Authority Receipt |
| `ObjectAuthorityRegistry_model_program_v1_20260918.json` | 精确 SHA `b89bb15a047cd59390428e86d33e8e2fc59d3a83954c68c2393d0e5b3dc4f3cc`：Dataset/Experiment/Training/Eval registries 归 MODEL PROGRAM；Authority/Gate/Receipt 权限保持既有领域/Kernel 边界。这是职责分配，不是 DatasetSplit 字段定义 |
| 已验证的 v1.0.1 原计划 | §6.1/6.2 列出 DomainAuthorityReference 和 DatasetSplit；§11.10 明确六种逻辑用途不得被当作新机器枚举。四大集合隔离已有要求，在已查范围尚未找到字段定义和认可接线 |
| Clued 当前精确检索 DatasetSplit、Domain Authority、DomainAuthority、ObjectAuthorityRegistry | 只命中本轮进展或无匹配；未找到认可回执。全授权 Global/4 Project 查询，查询无命中不等于全局不存在 |
| Clued 历史 DatasetSplit 查询 | 两条 2026-09-30 readiness checkpoint 已把映射记为 unresolved；它们仅是历史连续性记录，不是认可 |
| Drive 第一方模型文件夹、Dataset/DatasetSplit/数据集/DomainAuthority 标题索引与已读 v0.9.2 原文 | 文件夹仅旧计划与旧终审报告；旧计划只列对象/四集合隔离/M2-00回执交付要求，没有机器定义。旧计划只用于溯源，不用来覆盖当前 v1.0.1 |
| Library 有界关键词索引 | 首批10命中均为各版模型计划；仍有后续分页。索引只作定位，没有从 snippet 恢复任何正式定义 |

因此推荐把问题定位为 **已命名模型数据对象的领域合同落实缺口**，不是请求
Information Flow 重写 A/B/C。不存在现成定义的结论仅限已验证范围；若 Owner
提供新的权威对象/版本/摘要，先核对它，再按现有来源接线，避免重复定义。

## 数据到底分哪几组

保留四类隔离边界；六种用途描述是边界内的用途，不能当六种新权威枚举。

| 四类边界 | 包含的用途 | 允许作用 | 隔离要求 |
| --- | --- | --- | --- |
| 训练 | 训练 | 另行批准后学习权重/参数 | 不与开发、资格、最终 Holdout 共享样本/同源污染组 |
| 开发 | 开发、校准拟合、选型/策略验证 | 调试/探索；拟合校准器；选择实现、方法、阈值或路由策略 | 三用途各有身份与暴露记录；校准拟合与选型使用不同 partition。本最小候选不实现 cross-fitting |
| 资格 | 固定候选的阶段资格评测 | 按冻结合同评估指定候选 | 不能反过来选择/调优候选；候选改变需新资格；不并入最终 Holdout |
| 最终 Holdout | 最终独立验收 | 模型/校准器/阈值/工作流固定后，独立接受或拒绝 | 训练/开发/选型消费者不可访问样本、逐项结果、汇总分数或排名；不反复选择替代分支 |

推荐把 **校准拟合与选型/策略验证放在开发边界内，作为两个相互隔离的用途分区**。
原因是二者都会改变候选或决策策略，属于最终验收之前的开发活动；放进资格或
最终 Holdout 会混淆固定候选评测与选择。两者也不是权重训练集的别名。
此位置是设计建议，原计划没有替它指定机器父枚举。

## 推荐一次裁定的精确范围

推荐接受以下合同方向，并授权继续准备其非生产 schema/validator 候选，供独立审核：

1. DatasetSplit 由 MODEL PROGRAM 维护已命名数据对象的明确领域定义候选；
   若发现已发布权威定义，优先验证并绑定它。
   不将 IF-MVP0-A/B/C 的 schema 当作这个对象，也不原地修改它们。
2. 四类隔离边界为训练/开发/资格/最终 Holdout；六用途按上表映射。
   机器枚举拼写、版本 ID、URI 和注册位置随明确 schema 候选一起审阅，不能靠此
   中文表自动注册。当前 `dataset_split_ref=null / UNRESOLVED` 保持到正式绑定成功。
3. 最小字段候选覆盖：DatasetRevision与split身份/版本/摘要、四类父边界、
   逻辑用途、样本/来源身份、同源与近重复分组身份、允许消费者/用途、实验或资格范围、
   暴露记录、父子Lineage、失效与删除传播引用。资格/最终评估还需绑定固定候选和
   scorer/prompt/schema/policy revisions。这些引用不凭空证明其事实或许可。
4. 把 Domain Authority Receipt 视为 **既有权威的认可结果引用**，不用候选 JSON
   自签 ACCEPTED：认可必须绑定精确候选字节摘要/版本、领域与生产者、正式父包锁、
   独立只读审核证据、Owner认可来源、既有 Canonical/Kernel receipt ID 与适用范围。
   来源校验报告和Owner同意起草都不足以代替最终认可。若既有 receipt contract
   缺少所需扩展点，先提交其领域扩展候选；不创建第二 Receipt/Gate 引擎。

供 Owner 一次选择：**A（推荐）按上述四边界/六用途及模型领域归属继续做非生产
合同候选**；B：提供已有正式 DatasetSplit/receipt 的精确来源，优先只读接线；
C：提出不同的校准拟合/选型父边界，并明确理由及防污染措施。
本文件不记录 Owner 已经选择任何一项。

## 接线次序与明确产物

先形成 DatasetSplit schema/validator 与域引用候选 → 固定提交/摘要 → 独立只读审核
→ Owner通过既有权威机制认可精确版本 → 读回真实认可receipt与域引用 → 把M2 manifest
接到该版本，再验证 formal parent locks、manifest/use/consumer/scope/失效关系。
任何缺失或不匹配都继续 UNRESOLVED/BLOCKED，不自签批准。

这项决定补齐的是字段定义、用途映射和认可来源的接线。它不批准真实数据来源、
训练/蒸馏、付费算力、生产部署、合并、数据隐私或Holdout保密性，也不完成 M2-00/08/13。
现有 M1关闭状态、A/B/C原包、Storage checkout、runner与调度锁保持各自原边界。
