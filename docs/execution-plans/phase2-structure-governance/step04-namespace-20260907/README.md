# Step 4 最小命名空间治理候选

已将原 `CANDIDATE_TARGET_MAP_V0_1_1` 的 23 行整理成 **10 个管理分组 + 8 个 Domain 索引行**，共 18 个核心行。原 Map ID、v0.1.1 行修订和 v0.1.4 文档修订保持分离；所有原行恰好引用一次。分组只是一份可重建的视图，不创建新的程序 Namespace ID 或平行真源。

管理 Owner 已直接绑定现有 `ExecutionDelegation_20260907.json` 中明确的用户/项目所有者，维护与代审绑定同一已授权 Codex 任务。该文件记录了用户全部自有测试账号与全权执行/代审的原文来源。无需用户逐字段重新确认。程序 Domain issuer、运行时 writer 和独立 Review actor 的具体绑定保留在其实际发生或适用的阶段；管理所有权不会被当成这些证明。

本子任务仅准备候选。没有迁移、Freeze、生产变更、Canonical 写入或 Step 4 接受决定。以父任务的实际依赖与范围决定继续路径，不把未知一律扩大为整个工程阻断。

| 分组 | 范围 | 原 TM 行 | 原责任标签 |
|---|---|---|---|
| 1 | 根路由 | TM-01 | ROOT_ROUTER |
| 2 | 状态、版本及设计入口 | TM-02,TM-03,TM-09 | DCP |
| 3 | 协议与内核 | TM-04,TM-05 | AUTHORITY_CORE |
| 4 | 应用与产品投影 | TM-06 | PRODUCT_PROJECTION |
| 5 | 云端与配置 | TM-07,TM-08 | PLATFORM |
| 6 | 工具、测试和CI | TM-10,TM-11,TM-12 | DEVELOPMENT |
| 7 | 机制、Skill及厂商投影 | TM-13,TM-20,TM-21 | MECHANISM |
| 8 | 版本化制品及历史 | TM-14,TM-16 | DCP |
| 9 | 本人只读Bundle及兼容入口 | TM-15,TM-23 | USER_DATA |
| 10 | 开发合同、投影、索引及控制日志 | TM-17,TM-18,TM-19,TM-22 | DCP |

三份候选文件分别给出 Ownership 的八种角色、已有委托的完整起止/撤销/能力范围，以及 Domain 到 Namespace 和既有 Registry 的索引。它们共同引用 `Sources.json` 中的原件位置、JSON pointer 与 SHA256；`build_candidate.py` 只生成候选视图。

既有 `protocol/continuity/v1` 的 object/vocabulary Registry、Binding/Requirements Schema 继续保留 `local-rc-v15` 的原适用范围。候选包 CurrentArtifactRegistry 仍是作者设计输入索引。当前没有把二者提升成跨产品的运行时 Domain Registry，也没有新增一套被声称已接受的 Namespace schema。

四个关键冲突见 `KeyConflicts.candidate.json`：管理 Owner 与程序 issuer 的区别；apps/ 下真实 worker 的跨域职责；Map/IMC/Registry 标识层级不能混同；历史、私有及外部逻辑目标不能自动变成当前写入口。每项只阻断与它实际相关的后续动作，独立候选准备可以继续。

最低成本后续：父任务可直接审阅/修订这 18 行，按已有授权确认适用的管理归属；Step 5 复用原词汇与身份交叉表，Step 6 仅对当前活跃路径绑定真实 issuer/consumer。不要为了填表而激活未实现的商业、模型、DCP 或私域 store。

源码参考 commit：`5fad76df81c8a412e7768e08427841f0985a2588`。这里只读工程合同、配置元数据和候选包选定 JSON，未重新读取个人业务记忆，未改任何原件。
