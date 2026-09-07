# 5fad76d 实际 CI 的独立命名规则审查

**结论：`SUPPORTED_FOR_EXACT_SUBJECT`。可解除本精确对象的 `NSI-GAP-TYPED-RULE-REVIEW`。** 此结论要求保留逐项分类与源码补充证据，不修改原始 CI 文件，不解除 Library 或在线 Auth 配置缺口，不签发 Step 3 整体通过、Structure Freeze、Architecture Acceptance 或运行权限。

精确对象：

- commit：`5fad76df81c8a412e7768e08427841f0985a2588`
- tree：`39e9456e7334768f62f6135fe87b4ac0bd87ee45`
- CI run：`34100327450`
- scanner SHA256：`9ff7dc893b865a7736d6d9ffbe6f908c15f9c418e10a0602ae6fd33eedb8f81e`
- scope SHA256：`e8209cd50d6e066bf0b64b93c7c634816cf381a289c3dcd7cc8dda9cbac43af0`
- 实际 CI manifest SHA256：`e6e80781685b9cd76f1dbb19ba45fa9a9d623758271bde64a4999e30796dc882`
- 最终 148 项分类 SHA256：`26ba84344047fba0deede667fdd1c94bee40b7958a897aedc84ed523c941a6ab`

CI 成功及下载来源由根代理提供；本审查独立重算产物摘要，并将 source commit/tree、scanner/scope 原始 Git blob、扫描文件集合、实际 typed 数据和引用原件逐项绑定。没有把开发态运行代称实际 CI，也没有声称存在密码学签名。

## 本次确认的覆盖

实际 CI 包含 3,961 个 tracked 文件、60,146 条 typed observation、148 个 unresolved site。与本次提交的源文件集合及新鲜本地捕获完全相符；原始 148 项与最终逐项审查的复合身份多重集合完全一致。67 份引用来源摘要一致，51 条 RPC 候选来源的字面值、行列位置和摘要均已对照该提交的原始 Git 内容核验。主汇总记录完整保留了全部 typed observation 与 unresolved 指针，没有通过丢掉 UNKNOWN 来放行。

相对提交前 3,911 文件的开发分母，新增 50 个文件、删除 0 个。新增文件产生 1,528 条观察：JSON 命名 1,500、module 引用 20、role/capability/scope 8；新增 unresolved 为 0。增量精确解释了 58,618 → 60,146 的变化。

| 规则 | 选中文件/已读文件 | 观察 | unresolved |
|---|---:|---:|---:|
| JSON names | 3247 / 3247 | 57294 | 0 |
| package entries | 1 / 1 | 71 | 0 |
| routes | 273 / 273 | 40 | 3 |
| RPC | 273 / 273 | 59 | 8 |
| module references | 275 / 275 | 1876 | 8 |
| role/capability/scope | 273 / 273 | 365 | 127 |
| TOML/YAML names | 14 / 14 | 58 | 2 |
| SQL declarations | 32 / 32 | 383 | 0 |
| 已列入检查但无 extractor 的源语言 | 0 / 0 | 0 | 0 |

这些是代码规则分母，不是外部命名面的通过数量，也不是独立业务身份数量。选中文件集合已从实际 Git 树重新计算；复合 site 可展开多个观察，不能用观察数加 unresolved 数推导 candidate sites。

## RPC 分类缺陷已经修正

独立审查发现的“漏掉带数字 p5 名称、混入 `clued_bnd_` 令牌前缀”已修复。最终分类从 map values、helper 实参和 type union 提取精确来源。`continuity.ts` 的 382/906/1071/1129 行候选集合分别为 8/20/2/6，863/864/865 行 spread 分别为 2/6/5；每个候选均有来源证据，令牌前缀不再作为 RPC 目标。

三个 helper 名称 `clued_p5_attempt_begin`、`clued_p5_attempt_resolve`、`clued_p5_record_commit_failure` 虽未落入原始 `code_rpc` 分类，已经存在实际 CI 的普通 identifier index，且现在有精确 helper 调用位置补充。它们不是清单中从未出现的未知名称。本审查 JSON 保留这份来源补充，不改写原始 59 条 RPC observation 数，不宣称每个候选在每次调用中都可达或已获授权。

## 允许移交的义务与仍然存在的阻断

148 项分类为：有限来源 60、运行时或 Step 6 接线 85、非命名同名变量 3。3 条保留 Auth 路径有常量原件；8 个动态 import 有确定测试构建入口；`project:<id>`、请求 scope、授权 payload 等保留来源、模板和 UNKNOWN。93 项来自冻结历史目录，其 README 明确审计用途，不能为盘点未来实值而重新运行旧引擎，也不能复活旧授权。

Step 3 盘点名称、来源和显式未知；Step 4 处理 namespace owner/delegation；Step 5 处理 canonical vocabulary、alias、版本轴及对象/副本身份；Step 6 处理实际 consumer、精确输入、授权、receipt、失败行为和具体运行实例。固定基线 Step 3 第 185–187 行与 Step 5 第 403 行、Step 6 第 483 行支持这个顺序。`semantic_completeness=NOT_PROVEN` 不会自动使本规则审查永久失败，也不能据本结论改写成全程序语义已证明。

Library 完整清单和在线 Auth 配置的外部覆盖缺口仍保留，本结论不得解除它们。新源码、新语言、命名定义、scanner 或来源摘要变化时须重审受影响项；仅新增本精确 CI 对象的审查附件，不意味着必须无限重扫既有对象。任何后来补充都应明确关联原 CI 摘要并保留原件。

最终机器裁决与全部新增路径、来源补充、后续义务见 `IndependentReview.actual-ci.json`。最后核对返回 0，错误清单为空；中断前唯一暂时失败是作者更新分类附件后旧摘要失效，已针对最终版本重新绑定。未发现新的源码或覆盖问题。
