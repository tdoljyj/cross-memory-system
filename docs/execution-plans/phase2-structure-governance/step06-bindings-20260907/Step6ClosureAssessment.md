# Step 6 精确现有绑定候选

**可限定接受并进入 Step 7/8；没有需要靠虚构 ID 或全服务重跑才能消除的 Step6 缺口。** 本候选未签发接受、Freeze 或新运行权限。

18 个实际消费者均已形成：精确源码入口/函数 → typed input → 既有授权与运行参数校验 → 既有 Receipt 要求 → 实际 gate/validator。Owner 和治理 Domain 引用已接受 Step4；程序/阶段用既有入口和函数/工作流操作作限定身份，不新建全局 Registry。27 条授权、18 条 Receipt 合同保留既有 schema，运行时主体/ID/时间只由实际请求生成。

| 消费者 | 身份与权限链 | 执行证据范围 |
|---|---|---|
| C01 公开 bootstrap / MCP discovery | 已绑定既有入口、owner、typed input/auth/receipt/gate | SOURCE_BOUND; untouched hosted behavior not rerun |
| C02 账户JWT与Binding管理 | 已绑定既有入口、owner、typed input/auth/receipt/gate | SOURCE_BOUND; untouched hosted behavior not rerun |
| C03 连续性读取/审计 | 已绑定既有入口、owner、typed input/auth/receipt/gate | SOURCE_BOUND; untouched hosted behavior not rerun |
| C04 连续性 append/checkpoint/import | 已绑定既有入口、owner、typed input/auth/receipt/gate | SOURCE_BOUND; untouched hosted behavior not rerun |
| C05 Project REST/MCP | 已绑定既有入口、owner、typed input/auth/receipt/gate | SOURCE_BOUND; untouched hosted behavior not rerun |
| C06 Record读取与视图 | 已绑定既有入口、owner、typed input/auth/receipt/gate | SOURCE_BOUND; untouched hosted behavior not rerun |
| C07 Record mutation / Decision supersede | 已绑定既有入口、owner、typed input/auth/receipt/gate | SOURCE_BOUND; untouched hosted behavior not rerun |
| C08 Evidence ingest / extension Event | 已绑定既有入口、owner、typed input/auth/receipt/gate | SOURCE_BOUND; untouched hosted behavior not rerun |
| C09 Canonical Export | 已绑定既有入口、owner、typed input/auth/receipt/gate | SOURCE_BOUND; untouched hosted behavior not rerun |
| C10 P5 tenant Session/Attempt mutation | 已绑定既有入口、owner、typed input/auth/receipt/gate | SOURCE_BOUND; untouched hosted behavior not rerun |
| C11 Snapshot build/validate | 已绑定既有入口、owner、typed input/auth/receipt/gate | SOURCE_BOUND; untouched hosted behavior not rerun |
| C12 M2 snapshot publish/rollback | 已绑定既有入口、owner、typed input/auth/receipt/gate | SOURCE_BOUND; untouched hosted behavior not rerun |
| C13 Endpoint RequestVerificationContext | 已绑定既有入口、owner、typed input/auth/receipt/gate | SOURCE_BOUND; untouched hosted behavior not rerun |
| C14 账户页面与OAuth consent | 已绑定既有入口、owner、typed input/auth/receipt/gate | HISTORICAL_EXECUTED_A03_SUBSET_AND_CURRENT_CONFIG_OBSERVATION |
| C15 Phase2四Gate validator / CI | 已绑定既有入口、owner、typed input/auth/receipt/gate | RETAINED_ACTUAL_POSITIVE_AND_NEGATIVE_CI_WITH_UNCHANGED_VALIDATOR |
| C16 Naming scanner | 已绑定既有入口、owner、typed input/auth/receipt/gate | CURRENT_ACTUAL_CI_EXECUTION_AND_REGRESSION_EVIDENCE |
| C17 Naming external consolidator | 已绑定既有入口、owner、typed input/auth/receipt/gate | CURRENT_ACTUAL_CI_EXECUTION_AND_REGRESSION_EVIDENCE |
| C18 公开MCP required-check Receipt producer | 已绑定既有入口、owner、typed input/auth/receipt/gate | HISTORICAL_RECEIPT_PRODUCER_EVIDENCE_PARTIAL |

C15 校验器与保留正负 CI 完全同字节；保留其原 Candidate/Commit/Run，不改成新迁移 PASS。C16/C17 直接绑定本轮真实 CI 34105480323、commit 40fea9e，以及独立重算一致的 manifest `e23e6f69aaeab09e6085a9b4089db5ee0f13acd8c38c7f2dc76c2b21ef46c596`；71 项测试结果复用根代理真实平台查询。GitHub 提供的原 ZIP digest 仅标为平台元数据，未假称下载后自行重算。

C09 的声明 scope 是 context:read + audit:read，SQL Binding wrapper 实际检查 context:read/global。本次把两者精确分开并保留差异；纯结构命名迁移若保持 Worker/Binding/SQL/权限不变，这不阻断无关接线。任何依赖双 scope 的新 export 消费、权限变更或双 scope PASS 声明仍需针对性验证，不能借此裁决跳过。现有补丁草案未应用。

原矩阵 C15 把架构叫 v0.2.7 的混用已在补充视图纠正为架构 v0.2.5、交付 ZIP v0.2.7.1，v027 只是旧脚本命名。原 ConsumerMatrix 和原包 0绑定/0运行的历史声明保留原字节；本次新增绑定不是改写旧证据。

真正后续工作仅为规定阶段：Step8 对这组实际绑定运行治理正负例；Step13 核验实际被迁移的消费者路径/引用；Step16 跑迁移后的四个 ZIP Gate；Step18 证明选定正式生效入口不可绕过。旧 M1 对未知状态的返回行为已明确记录，没有宣称 fail-closed，也没有在命名治理中暗改它。

新候选引用检查 PASS：45 份原源码摘要、13 组历史比较、592 个摘要引用、112 个 JSON Pointer；未重扫库存或重跑全服务。详见 BindingChecks.json、SourceIndex.json、ExecutionEvidenceReuse.json 和 Step6ClosureAssessment.json。

根代理独立复核修正 C01：initialize 缺 bearer 返回 401，只有 tools/list 与 bootstrap 可匿名；setup 仅检查 bearer 存在，不证明用户身份/权限已验证。已修正同一授权条目的分操作规则，未增加授权条目或改生产。修前原件保存在 before-c01-correction，具体来源见 RootIndependentReview.json。
