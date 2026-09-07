# Step 7 当前治理投影输入

当前选择为 `ProjectionBindings.repository.json`，输出位于 `repository-generated/`。从仓库根执行：

```text
node docs/execution-plans/phase2-structure-governance/step07-projection-20260907/project-governance.mjs --check docs/execution-plans/phase2-structure-governance/step07-projection-20260907/ProjectionBindings.repository.json . repository-generated RepositoryProjectionCheck.json
```

当前绑定 19 项来源、9 项上游摘要关系、Step 4/5/6 三项限定接受决定和 18 条精确消费者合同。12 个输出来自同一模型；三种聚合 ID 沿用原矩阵的 null，实际身份以逐消费者绑定为准。来源原状态与后来接受决定分开显示，生成器不发行运行权限或接受权。

AGENTS 和旧 Status 的精确来源副本保存在 `inputs/PreMigration-*.md`，避免迁移后输出反向成为自己的输入。正式 Step 12 保全根文档再执行区块/页面替换；本目录未执行物理迁移。

检查报告必须同时满足输出无差异、上游无差异。生成器返回的 `formal_step7_gate=false` 表示它只是证据生产者，限定验收须引用独立检查及单独决定。

`OriginalStep7CandidateEvidence.zip` 按原字节保留全部 159 项初版源码、8 项局部测试及夹具、报告和说明，逐成员复核通过。初版 `ProjectionBindings.candidate.json`、`generated/` 和原报告是历史候选，保留其当时范围；不能覆盖当前 repository 选择。初版测试依赖当时 work-root 位置，因此只在保全包中保存，当前独立验证入口采用仓库 Step 8 实际输入和检查器。

不读写业务 Canonical 数据，不更改 Worker、Binding 或生产授权。迁移、实际接线、CI enforcement 和不可绕过证明分别按后续步骤执行。
