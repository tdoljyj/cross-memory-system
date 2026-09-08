# PRE_ENTRY Gate 与签名接线适用性裁定

独立评估者：/root/project_list_auth_fix。仅原文裁定与候选准备边界，不登记 Gate、不签发 GA/GRR、不扩展权限。

## 原子 Gate

S06 原始 member SHA256 f967fdf3e63028d29ed191160698726b5d707aaae63bd951f6ba2e8584936fec：L3437、L3441、L4316要求已登记的精确原子 Gate、独立定义/版本/摘要及实际输入；L3896、L3902–3903明确 G0a/G0b 不修改目标代码/数据库，G7A 是 RC 资格路径，不能将它们改名用于当前固定写入 fixture。B01–B06 是机制边界，PQUAL-01–20 是测试编号；均不是已存在的 Gate Definition。

已接受范围所依据 QualificationPhasePolicy（SHA256 154a5ca0e3d6786877662b68a173176ecd54712744400805ef4b2a93f5946f22）在 /phases/PRE_ENTRY_SKILL_QUALIFICATION/per_action_authorization_kind 仅声明 PRE_ENTRY_QUALIFICATION_GATE_AUTHORIZATION，/gate_control_type 仍为 GateAuthorization；它没有给出 gate_id、注册条目或静态 Gate Definition。QualificationPlan（SHA256 b482c08ad0cb85fcec388da6505849d58e6b5d22a5982bcfefc7a2a19b204087）/authority_source 仍要求 S06 及当前适用 Gate。这个 alias 不会自动变成合法原子 Gate。此前移除 Release Profile 专用组合字段不免除这一实际 GA 要求。

最小下一步不是重跑 G0–G7，也不是自造一个已经接受的 ID：实施者可在已批准固定资格计划的准备范围内，形成一个精确的静态资格 Gate 定义与来源映射候选，逐项绑定已有 PQUAL 适用动作、R05–R10、当前 Profile、Test/Fixture/Executor、预期与证据、Owner/reviewer、失效规则；保留原 Registry 和旧 pins。将“该新增登记是否仅具体化已批准资格用途，还是必须改变 S06 的 Registry 范围”作为独立接受时的明确判定，不让运行时自由填写名称。本次核查未找到已登记可直接复用的 ID，也没有登记任何新 ID。直到真实前向登记/接受/签名引用成立，GA 实例必须拒绝；当前纯构建、工程观察与隔离存储准备不受此字段缺口阻断。

Owner 已批准构建固定资格驱动器、同范围独立接受和精确签发；不能把“尚无具体 Gate 对象”自动等同新的用户许可，也不能把该总批准当作已完成登记。如最终候选必须修改原允许的测试用途、既有 Gate 含义或 Frozen Registry 原文，该具体变更才属于另行决定，而非以候选名字绕过。

## GA/GRR 签名证明与 live Store

S06 L868：Git 保存 Schema/URI 模板，live ga_*/grr_* 在追加式 Control Evidence Store。L3885：动态对象必须绑定 Schema Digest、Audience、control_trust_root_generation、签发用途、签名、期限和撤回。L3441还要求每个 GA 唯一结果 reservation、签名 outbox、终态前重新核实，不能跨外部签名维持一个数据库事务或在签名失败时暴露 PASS。

这些条款没有要求 Git 内联存放 live payload，也没有禁止对精确完整 payload 摘要做已核身份的签名历史证明。因此可以准备一个范围固定的签名 commitment：完整 canonical payload SHA256，加唯一 Store URI、对象类型/ID、用途/Audience、Schema/算法标识和 Root generation；真实 GitHub web-flow merge 验证这个完整 commitment。SQL 仍保存实际不可变 payload、reservation/current 状态、撤回和预算，验证器必须从实际 Store 取得原 payload，重算摘要并核对全部绑定，再验真实签名来源。历史 Git 证明不提供 currentness、准入、GA/GRR 本体或额外权限。

这属于可实施的候选接线结论，尚不是某份未知格式/代码的接受。当前已接受 Root 算法签的是 Root payload；不能只沿用其算法名称，便声称新 commitment 已受查。应固定同签名设施的精确用途分离 commitment 编码/Schema 与验证配置后继并独立接受，测试错误类型/URI/ID、替换 payload、用途/Audience/root generation 混用和未完成 reservation 均拒绝；不生成新密钥、不引入第二信任根，不把 GA 与 GRR 签名用途合并。真实签名等待时间必须落在实际 GA 截止前；到期仅可拒绝/同范围重新核验，不倒签。

本裁定不签发 Status、GA、GRR、controller 资格或任何 Gate PASS；不授权模型、生产、Slice A 或后 Entry PQUAL18。
