# PRE_ENTRY 原子 Gate 静态后继候选

候选 ID 固定为 `G-PREENTRY-SKILL-QUALIFICATION`，typed identity 为 `urn:clued:gate:G-PREENTRY-SKILL-QUALIFICATION`，版本 `fixed-synthetic-20260908.v1`。它只具体化既有 `SKILL_COEXISTENCE_QUALIFICATION` 用途，不是已登记 Gate，不签 GA，不产生测试通过。

本目录接管实施者尚未冻结的三个初稿；`*.initial.*` 保留原字节。原定义摘要为 `2ba55f8960f24feea0be413a380f7f481264df20c7172dd694c6555e8b7de9ef`。后继移除静态 Gate 中混入的实际 inputs/target write set，补独立 Test 定义、typed Registry 源及精确摘要。没有修改旧 Frozen Registry、Protocol、pins、已签 Profile 或其他 Gate 意义。

原文依据是保全 ZIP 的 S06 原成员 `Clued_Phase2_三轨修订与补证_v0.2.7_20260906/sources/architecture_v024/sources/Clued_Kernel_Next_多厂商连续性与执行基础设施完整整合方案_v3.3.md`，SHA256 `f967fdf3e63028d29ed191160698726b5d707aaae63bd951f6ba2e8584936fec`（557313 bytes，本路已重新计算）。L3435–3444 要求精确 Test/Gate/Profile 摘要、静态/动态分离与唯一结果；L3876–3887 规定独立授权、签名/用途/时限、结果；L4316、4320–4346 要求 typed ID、单向关系及固定责任域。独立适用性裁定见 SourceBindings 中原文件/hash，不把 PRE_ENTRY alias 或 B01–B06/PQUAL 测试号当现成 Gate。

待独立接受的静态落点是：

- `evals/kernel-next/preentry-skill-qualification.json#/tests/PQUAL-xx`：19 个独立 TestManifest，逐项保留原 setup/expected 文本和原 oracle 摘要、现有 Requirement 引用、固定 fixture/executor 输入、原始证据要求。
- 同文件 `#/gates/G-PREENTRY-SKILL-QUALIFICATION`：唯一 GateManifest，仅组合精确 Test refs、原前置/执行 Profile、默认资源与证据/失效规则。
- `evals/kernel-next/preentry-skill-qualification.registry.json`：S06 原登记来源之上的单项 typed 增量源，绑定同一 suite 文件/hash/pointer 与 Gate 内容摘要。合并/签名/接受之后才可纳入原 Registry 的当前组合及运行允许集，不作为并列 Registry 或第二动态 Canon。

当前实际文件仍全部在本候选目录。单独 GateDefinitionCandidate 是同一 suite 节点的审阅副本，字节一致由验证器检查；未来发布以精确 suite pointer 为唯一静态定义。Registry 定义集合摘要对单项精确 addition 编码计算，不自含自身摘要。Test→Requirement、Gate→Test 是单向边；本次没有创建反向 Requirement 索引，也没有把运行 GA/GRR 加入静态边。

原 19 项适用测试为 PQUAL-01–17、19、20；PQUAL-18 明确是独立后 Entry 正例，不运行、不通过、不外推。固定 child 只能做合成动作，不能证明全部 19 项行为已实现。所有缺少真实执行器故障路径、覆盖或独立 Evidence 的测试必须保持未执行/受阻。此 Gate 的 PASS 条件是同一精确输入下全部适用测试有实际充分证据及独立判断；不能拿一次 fixture 成功代替。

执行 Profile 使用 PR28 已签原字节与独立验签观察，保留 R05–R10、90 秒、128 MiB、0.5 CPU、16 PID、无网络/业务凭据/模型/付费，并保留父侧 Owner/Root/runner/credential/session/current 等实际核验。B01–B06 仍是机制边界；不为 controller 引入本 Gate、R11 或 R14 自证循环。签名来源是历史证明，当前资格、代际、撤回、预算及一次一授权必须另取真实输入。Test executor 摘要来自已签固定输入；不能把后续当前路径的新字节冒称同一受签输入。

现有 `protocol/continuity/v1/schemas/core/gate-manifest.schema.json` 明确是 V15 local-RC 且强制 Release Profile。本候选使用已接受 PRE_ENTRY 执行 Profile，不能据此混入 RC，也未修改该冻结 Schema。这里的静态具体格式、单项 Registry 组合适用性、独立接受目标及最终运行绑定是本次审阅事项；没有声称旧 RC Schema 已校验它。后续当前 Registry/消费者接线必须只接受本次独立接受的精确字节。

`node --test verify.test.mjs` 只做静态工程检查：两个独立构建进程的四个产物逐字节一致，typed/原源/版本/定义集合关联一致；8 类篡改拒绝。不是 ContractToolchainBootstrapAttestation、PQUAL 执行、Gate PASS 或运行资格。动态实例仍只进入既有追加式 Control Evidence Store；一个 GA/精确输入组合只保留一次 reservation、签名 Outbox 及唯一 GRR。UNKNOWN 不是 GRR 枚举，过期或签名缺失不能暴露 PASS。
