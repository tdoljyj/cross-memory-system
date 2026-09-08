# Bootstrap 远端证据与撤回接线审查

**READ_ONLY_ENGINEERING_REVIEW — NO_QUALIFICATION_ISSUED**。评估者 `/root/project_list_auth_fix` 不参与实现。本审查不创建授权、根或协议，不调用生产、不读 Gold，也不执行旧探针。

**结论：现有已批准委托足以准备和创建限定范围的隔离工程证据记录，不需要再次询问 Owner；不足以直接打开正式资格执行入口。** 最小可复用位置是现有私有仓库的独立工程证据目录。签名 Owner、精确 GA、当前撤回与实际副作用之间的验证/执行链仍须真实实现、固定并独立接受；“文件已上传”不能补齐这条链。

## 原合同与已授权范围

[OwnerDelegation](OwnerDelegation_20260908.json) 的 `scope.allowed`、`required_before_each_authorization`、`signature_binding` 和 `limits`，连同 [独立 Owner 核验](IndependentOwnerBindingVerification.json)，限定 PR20 merge `4f722ea9d78488b749c15d27fe9145e9d9f9d2c2`；有效窗截至 **2026-09-09T09:28:59Z**，每 GA 最长600秒。仅前 Entry、合成数据、独立接受的精确对象；不包含模型/付费、生产权限、PQUAL-18后 Entry 正例或Health/Surgical授权。

本次从原保全ZIP只读核对了 S06 SHA256 `f967fdf3e63028d29ed191160698726b5d707aaae63bd951f6ba2e8584936fec` 的 §9.6、§23.1–23.2、§29.0；原 `ControlTypeAndAliasCrosswalk.json` SHA256 为 `c871c80c13b6eee6abf6ddc5d5189d31644d0cb872f685bd7bf33c59185252a2`。定位见 [来源边界](../mapping/ControllerSourceBoundary.json)。要求不能压缩成一个本地布尔值：

- §29.0第3879行：GA先于动作，固定 `authorization_status=AUTHORIZED`，至少绑定精确Gate/Profile、目标/源码/产物/config、上游GRR、StatusManifest、risk manifest、Subject/Binding/Scope、读写集/禁止项、凭据范围、时间/停止/回滚；撤回通过**独立不可变 Revocation Event**表达，不能原地改GA。
- 第3880、3885行：GA与GRR用途分离，均需Schema摘要、Audience、`control_trust_root_generation`、签发用途及签名；一个GA只有一个终态GRR。Intent/UNKNOWN只是既有Workflow/Attempt/Evidence辅助记录，不增加GRR枚举或新的授权类型。
- §23.1第3010–3012行：`revocation_epoch_vector`有schema version及account、integration-installation、context、binding四组成对scope ref/epoch；不适用层必须使用**已接受Schema明确允许的 not_applicable及原因**，不得填0、略去或自行新增Owner字段。Runner/Credential/Session等独立代际不塞进Vector。
- 第3012行要求适用Vector来自当前Canonical Store；**GitHub Owner/GA撤回记录不能冒充生产Clued Binding的当前Vector**。仅测试主体时，实际隔离状态源、适用层与N/A映射须先在精确Profile/Schema中接受；当前未见可直接套用的实例。

## 最小接线建议

| 接点 | 复用方式与实际动作 | 必须保留的边界 |
| --- | --- | --- |
| 远端Intent位置 | 建议使用现有私有仓库 `tdoljyj/cross-memory-system` 下 `artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/runtime-evidence/<attempt-id>/`，将Intent、结果/恢复观察分别追加为唯一文件。宿主沿已有Git身份提交普通工程文件；取得远端commit，再按**该commit**独立读回Git blob、字节/SHA256和引用关系，成功后才允许下一实际副作用。 | 此路径是建议写集，须固定进实际Profile/GA的 `allowed_write_set`；本审查没有创建它。普通Git提交是持久化证据，不是GA签发。子进程不接收GitHub凭据、仓库写权限或可控制的远端目标；不改业务Canon或已有发布指针。 |
| 唯一性及UNKNOWN | 同attempt/幂等键只有一个不可变Intent；提交冲突或既有记录时先读回，比对全部参数。回执/响应未知时查询同一个目标，不自动再次执行动作。结果与清理独立追加，原始失败保留。 | “同名文件可更新”、新路径重试或最后写入者获胜不能当作幂等/CAS。Git远端写入失败不打开执行；远端写成功但回读未知也保持UNKNOWN。单个GA不能因恢复生成第二个终态GRR。 |
| Owner与GA来源 | Owner链继续使用PR20及已接受的同范围后继；GA、独立接受、Profile/Schema及实际受查物记录固定在同一私有工程范围，复用GitHub `web-flow` 验签/merge actor/精确tree+blob校验方法。GA必须引用真实独立接受和全部前置，再由已授权coordinator签发。 | 不调用旧TM19发布验证器使其“接受新subject”；不把GitHub admin等同任意issuer用途。GA与GRR虽可使用同一签名基础设施，仍须分别核对其实际签发用途和精确对象。 |
| Owner/GA撤回记录 | 用原合同已有的不可变Revocation Event绑定被撤回Owner委托或GA的精确ID/摘要、实际有权主体及签名证据，追加保存并独立读回。每个副作用前，宿主从实际当前远端控制记录集合核验完整性、有效期与撤回；旧签名只证明旧内容，不能证明今天未撤回。 | 记录目录和当前读取规则必须固定并独立接受；不能只查一个历史commit或凭“未找到文件”推导未撤回。Owner最新口头撤回先停止，再补证，不等待上传成功。GitHub记录集合不是新授权来源，也不替代Canonical Vector。 |
| 撤回到实际执行 | 宿主将核验后的精确GA/代际与单次动作绑定，实际监督进程树；撤回/过期/离线/不明时阻止下一动作并执行受授权停止。核对竞态、旧读结果、断网、宿主崩溃、迟到结果及资源占用。 | GitHub保存与读取本身没有提供本执行器的lease/fencing、事务级副作用门或即时远程终止。需要真实PQUAL-13–17级别观察，不能宣称“每次读API”已经解决竞态。原合同也不要求把不可fencing外部动作谎报为瞬间终止；未知结果保留核对和占用。 |

建议先完成一个**仅合成工程记录**的远端写入→精确读回→中断/同键恢复证据，再把同一适配器作为待接受的sink输入；这在现有Owner建设授权内，不等于获准运行新Skill。控制状态的按动作读取是本次授权核验，不应扩展成记忆版本的定时检查。

## 目前还缺的真实前置

1. **控制签发接线尚未闭合。** Owner签名已实证，但当前未提供符合原Schema的有效GA/Profile、签发用途/Schema摘要及可核验 `control_trust_root_generation` 绑定。不能拿旧publication Policy的sequence、本地generation=1或Owner merge SHA擅自代替该字段。可在本次已批限定用途内准备并独立审阅与既有签名设施一致的实际绑定；若方案实质需要新建/替换信任根，则越出此次批准范围，不能以改名规避。
2. **当前撤回权威与运行门尚未接线。** 缺Owner/GA事件集合的完整新鲜读取、适用Vector的真实隔离状态源/合法N/A证明、各独立代际，以及撤回到每次副作用的实际阻断/竞态证据。当前点时Owner核验不具备这项持续运行能力。
3. **远端sink与预算没有实际实例。** 建议位置尚非已接受的持久sink；需实际写入/读回/恢复、唯一Intent和预算预留/累加证据。R05–R10、完整Profile/Skill受查物及OS允许范围也必须按 [接受清单](IndependentAcceptanceChecklist.md) 满足，不能由远端上传抵消缺项。

本次只读观察当前冻结工程增量 [README](../../../../scripts/phase2-qualification/bootstrap-runtime/README.md) 与 `NativeHost.cs`（SHA256 `9cb4c0ba2499d516fcc7b06a69a9f8b7e6ef5471613f1553a87b19f89c5eaff1`，索引SHA256 `2fd4dc060e23a6c3140f232c288f288c42185d98dd28d7aa346ab7df4c096723`）：已记录STOP全树终止、kill-on-close和UNKNOWN保留，但明确没有远端Intent/GA/撤回/预算/Skill接线，网络仍是 `TIMEOUT_NOT_DENIAL_PROOF`。这些工程证据可复用；**本审查不将该增量接受为合格controller，也不开放正式入口。**
