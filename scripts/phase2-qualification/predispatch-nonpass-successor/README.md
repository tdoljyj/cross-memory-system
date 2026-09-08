# 派发前非通过恢复候选

仅为原 GA 已撤回、实际 UNKNOWN、全部不可变历史无 Intent/dispatch、无容器且固定宿主对账证明 not_started 的情况准备恢复终结。仍使用原 GA、GateResultReceipt、GATE_RESULT 签名、唯一结果 reservation 和最终 CAS；不签发新控制对象，不退款、不自动重试或 successor，不改变原 Gate、Root 或执行写集。

原 S06 §10.7 的 not_started 对账语义适用；stop_evidence_ref 在此受限分支明确引用未启动对账原始证据，绝不是容器 STOP 观察。整个 Gate 未派发时 test_results/index.tests 都为空，真实入口拒绝保留为诊断证据；不得填充未执行的测试或给出 PASS。正常容器 STOP 分支保留原校验。

原 GA 的 executor_ref/controller_digest 仍指 edf313 原 201 个已受查执行源。新 RecoverySourceManifest 是另一份恢复终结代码来源，不属于旧清单，也不继承旧资格。新的独立工程接受原字节必须进入本次结果 index，绑定原 GA/Root/Scope、新清单以及 old_qualification_extended=false；真实终结器验证两份完整源清单，再验原 GATE_RESULT 签名并交原 CAS。普通接受 JSON 的形状不证明其真实性，主控须提供真正独立评估记录；最终签名覆盖完整来源链。

候选写集：一个原 execution_transition 函数的 CREATE OR REPLACE；原 grr/result-terminal/write-targets 复制后仅添加上述分支；纯 not-started 校验器及恢复源核对器。未部署 SQL，没有改原函数权限、表、旧行或预算。执行前由主控对精确前序函数/Root/活动 GA 做事务内保护和独立接受，禁止直接将新函数当原 edf 资格的一部分。

结果装配材料：原格式 index/decision、not_started reconciliation raw、完整实际 SQL 快照、原 Docker 空库存观察、原入口失败诊断、独立整体非通过对账评估和新的源接受。所有引用均为原 Evidence URI/raw/SHA 编码；签名前必须检查整个 SQL 请求 jsonb 文本（含嵌套转义）不超过 131072 字节。不能删减原始证据来制造可接受大小。
