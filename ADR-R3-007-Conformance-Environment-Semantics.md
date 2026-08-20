# ADR-R3-007：Conformance environment 语义冻结（P0-3）

- **状态**：ACCEPTED（2026-08-20 产品所有者裁决：必须冻结 environment 语义才能形成最终发布口径）
- **关联裁决**：R3 P0-3「Conformance environment 语义」阻断项
- **适用范围**：`memory_engine/truth/conformance.py::ConformanceVerifier.verify` 的 `environment` 参数

## 1. 问题

真实 Binding 试装通过 `environment="isolated"` 取得 ENFORCED 档位，
而同一 verifier 传 `environment="real"` 只能得到 AUDIT。若语义不冻结：

- 无法判断 ENFORCED 是否可推广到部署环境（冒充 isolated 风险）；
- receipt 无法追溯档位成立的环境前提；
- 发布口径不可形成。

## 2. 裁决语义（冻结）

**`environment` 表示「验证执行环境」（validation execution environment），
即执行 conformance 验证时验证器所处/所声明的环境类别；与 Binding 的部署
位置正交。**

| 取值 | 语义 | 档位上限 |
|---|---|---|
| `isolated` | 隔离/临时验证执行环境（测试夹具、试装验证、临时 home） | 全证据链 → ENFORCED |
| `real` | 真实部署执行环境（产品运行环境） | AUDIT（未授权不得升级） |

## 3. 防误解条款

1. 真实 Binding 的试装验证以 `isolated` 调用 verifier，表示
   「验证发生在隔离执行环境中」，**不等于**「该 Binding 部署在隔离环境」；
2. ENFORCED 档位绑定四元组：**(revision, 合同版本, 证据链, 验证执行环境)**，
   不自动迁移到任何部署环境；部署环境最终档位由产品所有者另行裁决；
3. 任何调用方不得把 `environment` 当作 Binding 部署属性上报或宣称；
4. verifier 输出 summary 必须携带 environment 语义标注（可追溯）。

## 4. 落地

- 合同条款：`memory_engine/truth/adapter_contract.py::ENVIRONMENT_SEMANTICS`
- verifier：`conformance.py` docstring + summary 标注
- 矩阵测试：`tests/test_truth_state_conformance.py::test_p0_3_environment_semantics_matrix`
- 本 ADR 为最终发布口径的组成部分；未冻结前不得形成发布结论
