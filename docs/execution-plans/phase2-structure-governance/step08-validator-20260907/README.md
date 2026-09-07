# Step 8 最终可重复执行候选

本目录用于顺序审查，不自行签署 Step 7 / 8 接受或 Step 11 Freeze。

当前结果：最终 repo-root SourceLocators 实际校验 exit 0；19 来源、9 接受关系、18 个类型化消费者、三份既有决定及 12 输出的独立 Step 7 检查通过。针对最终接线实际重跑的 4 个控制均按目标规则 exit 1：README 漂移、pending 升级 accepted、未执行升级 PASS、accepted 上游来源漂移。最后一例重新生成的输出字节完全一致，但因真实接受关系摘要不匹配仍被拒绝。

原 23 次 CLI 证据、13 类限定正例与 16 个基线负例作为精确历史证据复用；核心规则文件逐字节未变。可移植测试入口额外只运行了一个既有正例方法，实际通过，未再运行全套同类测试。普通 discovery 因没有显式来源而 SkipTest，绝不冒充验证通过。

运行命令（在仓库根；node 已在 PATH）：

```sh
python scripts/naming-governance/run.py --bindings docs/execution-plans/phase2-structure-governance/step08-validator-20260907/SourceLocators.json --source-root . --candidate-zip /path/to/original-candidate.zip --purpose evidence --report /path/to/CurrentReceipt.json
```

源定位入口是 SourceLocators.json。三份 *.portable.json 只重定位原 source_id / sha256 / pointer；51 份实际源字节集中于 ReferencedSourceBytes.zip，保留精确摘要和原位置。完整 246 MB 包不进入 Git，由 --candidate-zip 明确提供。核心对此引用继承先前完整包验证，本次父审查方另行补当前外部路径的字节摘要；不要把同体积任意文件视为已验证原包。

证据定位：

- IndependentStep7BindingReview.json：最终投影的独立限定审查，两处生成器变化仅为显示标签。
- CurrentBindingReceipt.json：最终真实输入的实际成功回执；不发行接受或 Freeze。
- FinalBindingVerification.json + FinalBindingControls.zip：4 个最终接线控制及全部输入差异/原回执。
- EvidenceIndex.json + Step8ValidatorEvidence_20260907.zip：原 23 次执行的 807 成员精确保全包。
- PortableAdaptation.json + PortableDriverCheck.zip：核心字节复用、原 8 个测试方法 AST 不变、可移植入口限定验证。
- SourceIndex.json + ReferencedSourceBytes.zip：可移植来源视图与全部 51 源成员摘要。

所有临时展开夹具已在逐成员验证 ZIP 后清除，没有将数百份夹具散入 Git。实际源保持原字节；纯路径适配不改变 source authority、消费者 scope 或历史接受内容。

这里证明 source/projection consistency 和限定治理规则。没有重新执行 hosted 登录/Binding、没有宣称 Step 13 迁移后兼容、Step 16 新四 Gate、Step 18 强制门禁或生产发布通过；各项仍依原顺序和实际变化范围执行。
