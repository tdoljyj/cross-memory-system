# 本轮局部验证记录

Node v24.19.0 本轮执行 `test-projection.mjs`：8 项测试通过、0 失败、0 跳过。测试范围为本目录的新投影实现；没有重复原 G1/Step 3 测试，没有执行生产操作。

使用稳定选定输入生成 `generated/` 的 12 个文件后，再运行只读 `--check`，结果为 `EXACT_REGENERATION_MATCH`，输出 mismatch 0，已选上游引用 mismatch 0。两个结果分别保存在 `ProjectionConsistencyReport.json` 与 `ProjectionCheckReport.json`。

- 生成器 SHA256：`74b884f7fa211ede6d5fdf040dfab1a5227a7f0552ff52b303bb0166a5401abf`
- 输入清单文件 SHA256：`717cad53947753b27641d08cb23cb8252610c43aab9bac97295a56825a5527dc`
- 事实模型 SHA256：`ab1af57387b7d6d0e111de45bba5595b91239025ad2a04e302db025e1f07fca9`
- 原 Status 与保全副本 SHA256：`af52a717b2c37ebabf81a7123244aa3dd9a91042ea87037fd026925e8111f722`

第一次验证曾正确拒绝 Step 5 文件在捕获输入后发生的并发修订，未生成过期结果。根任务确认修订稳定后，本轮仅重新捕获指定文件，再执行上述局部验证。

Step 4 的限定接受状态来自已有精确决定。此次捕获时 Step 5 和 Step 6 Decision 槽位仍为 `UNBOUND`，正式 domain/program/stage ID 为源文件中的 `null`。这是该次输入的精确状态，不是对随后根任务可能签发决定的判断。后续输入变化应重新生成，并保留这次报告的原对象范围。

CLI 的 exit 0 仅表示选定来源可读取且生成结果字节一致。`upstream_mismatches` 必须另行检查，且 `formal_step7_gate` 始终为 false。Step 8 如使用此结果，还须判断其自身需要的已接受来源、真实 Step 6 接线和输入授权条件；不能把本地字节一致性代替这些条件。
