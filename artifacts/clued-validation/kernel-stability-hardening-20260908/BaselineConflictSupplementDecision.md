# 基线冲突处置补充决定

2026-09-08。**用户已明确批准本补充适用性裁定；签名落地由主控集成，当前未签发任何阶段 PASS。** 本决定与同名 JSON 一起记录 RF-01–03 的全部处置。它是单独补充，不改三份原文和历史 Review Findings。

用户本轮原句的链接文本还原为：“批准这份已独立核对的基线冲突处置建议作为单独补充决定”。指向本目录 `ReviewFindings.md`，SHA256 为 `54301bbfabc7de5ca6d85a2611f3d80f4a3cc6ca5eb442684552d5d7aac24ecb`。准确原句与链接由主控 `/root` 转交本实现者；来源任务为 `01a07f5e-510d-7db3-877d-f56e9bfa07ea`。受查 main 为 `78fb8a0edcd09a526ffeeece4aa19fb27c1790b6`。

## 固定输入与保留范围

| 原文 | SHA256 |
|---|---|
| 原 21 步固定执行基线，20260907 | `f465bcb77aced171b4f241da7a23c1e02133716700227caaabb7954be39899ad` |
| Kernel Stability Hardening 横向接入正式基线 v0.1，20260908 | `936cb966a75765ca156f5706237467b940ea32891bbc98c2c21ec9a8b8ec06a0` |
| Kernel Health / Surgical Repair FIXED v0.1，20260908 | `44f59133c78e113710d5ee19e89c8a12a1393b15da27bb9290b521e8294a0b26` |

完整源路径列于同名 JSON。三份原文原字节继续保留。原 21 步的编号、含义、顺序、证据条件和已接受对象不压缩、不重排、不替换。尤其原 Step16“四 Gate 重跑”、Step17“Canonical Semantic No-Change”、Step18“不可绕过证明”、Step19“Naming Integrity Closeout”、Step20“Developer Skill”、Step21“User Skill”均保留。

既有 Naming/Structure 收口及历史 thin Developer/User adapter 接受只覆盖其原对象；后来的现有 Skill 接受也依其实际范围判断。不得用任一旧接受推导新增 Stability 合同或整个产品已接受。

## RF-01：六项新增事项改用未编号横向 Hook

下表名称不是新的步骤编号。按 Stability §12.9–12.17、§27 保留真实依赖，不覆盖原 Step16–21。

| 未编号 Hook | 真实前置及后继边界 |
|---|---|
| Stability 运行时与治理对齐 | 本轮适用合同及 HS0 Freeze 前置完成，受影响 S1–S6 实现、消费者接线、旧入口关闭、强制执行证据齐备后核验；位于 R11 前。原“四 Gate”证明仍按自身适用性要求。 |
| Developer Tooling / Console 非生产接线 | 在适用 R11、HS1 后，按 §12.12 接可信投影及受控操作；Console 不成为 Kernel Authority，不代替原语义不变证明。 |
| Evidence 与具名批准 | 在前述非生产接线后汇集 mutation/direct-write/idempotency/concurrency/state/receipt/projection/fail-closed 及具名审查证据，位于 HS2 前。六组原请求逐项映射；每个动作的授权须在动作前核实，不能等到本汇集 Hook 才补签，更不能替代原不可绕过证明。 |
| 冻结后治理与例外 | 保留原 Naming 收口范围；本轮后继链依 §27 位于 HS2、完整 Slice A 和 HS2.5 Repairability 后。变更触发适用性/失效核验；例外必须有 owner、scope、expiry、evidence。 |
| 首批 Product Inputs | 在前述治理条件后，单独绑定产品输入范围和接受条件，不含生产数据。新能力/Consumer 遵守稳定性合同及 CAS/State/Receipt，不恢复 direct-write；Developer Skill 接受不代替产品接受。 |
| 架构接受复验与发布 | 在适用产品输入接受后，绑定真实待发布对象，核验身份、写链、Hook 一致性、负例和 Shadow 漂移，并取得实际发布授权。随后仅在全部 Health 前置齐备时评估 HS3；User Skill 接受或测试成功不等于发布接受或生产安全。 |

## RF-02：按受影响对象处理 Freeze 与当前 P0

历史已接受对象与本轮新增受影响对象分别映射。证据只有在对象、版本、范围、失效条件仍匹配时才复用。新增 Stability Contract Freeze 必须取得本轮适用审查和接受；HS0 正式 Freeze 仍遵守 Health §4.1：在当前适用 R07–R10 P0 收口之后、R11 之前。原 Structure/Architecture 前置在实际适用时继续成立。

新增受影响对象的合同审查/接受、实现、接线、旧入口关闭、强制执行和运行时对齐，以横向事项记录依赖，不追溯声称旧 Freeze 接受了新合同，也不重开全部历史 21 步。任何实际适用 Gate 均不得跳过。

当前 P0 继续按 Stability §13，仅对正在触碰的 checkpoint、写入、重试、Receipt、鉴权、revision、状态风险就地闭合。不新增 A12/A13/A14 大包，不把完整未来 Command Engine 变成当前 P0 前置。A01–A11 的未来条件项保留真实阶段映射，不无差别前移形成循环，也不静默删除。新范围尚未齐备不泛化阻断既有已授权 P0。

## RF-03：R11 与 HS3 的原前置保持完整

R11 引用上述运行时对齐 Hook，并绑定实际合格执行主体、Profile、精确受查对象/运行时/配置、动作授权、停止/撤权新鲜度、预算和持久证据。Step12–14 Local Warning、原 Step16 或旧 Skill 接受均不能替代 R11。HS1 仍在 R11 后，仅 Detect/Classify/Diagnose/Report，不自动生产修复。

HS2 保持独立、限定非生产的故障注入与安全恢复授权。HS3 同时核对 Health §9 的全部适用 P0、R11、HS1、HS2、完整 Slice A、Repairability，以及真实适用的发布授权；全部满足后才评估受控 Surgical lane。HS4 仍在 HS3 后。本决定不发 HS0 Freeze、R11/HS1/HS2/HS3 PASS 或 SurgicalGrant。

## 批准效力与实施边界

本轮批准的是上述精确 RF-01–03 的单独 scope 裁定和文档落地，已不再只是等待批准的建议。历史 `ReviewFindings.md` 中“建议/未生效”描述保持原字节，由本后继决定表达新的批准事实。

本决定不批准另一个尚未批准的新范围，不提供生产 SQL、Worker 发布、故障注入、控制根注册、模型或 Surgical 权限，不自签 controller/Profile/GA，不授权 Entry 后 Slice A。既有单独授权既不因此被撤回，也不被扩张。主控负责真实签名集成和独立引用；本文件不预填未来 merge SHA、签名或 Canonical 业务回执。
