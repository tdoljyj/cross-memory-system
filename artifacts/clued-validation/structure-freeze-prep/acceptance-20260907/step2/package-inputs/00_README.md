# Clued Phase 2 · v0.2.5 三轨修订与补证候选

当前身份：`CLUED_ARCHITECTURE_CONVERGENCE_V0_2_5`。架构唯一直接前任为精确v0.2.4；设计输入为已限定接受的精确映射v0.4.3。本文包内主文件为 `Clued_架构收敛候选_v0.2.5_20260906.md`、`Clued_Phase2_Charter_候选_v0.1.4_20260906.md`、`Clued_Phase2_结构准备设计_候选_v0.1.4_20260906.md`。

这次交付的是实际新架构设计，不是再修映射：24商业差分→22原合同→10领域整合合同→13具名设计接收目标。共同内核和首期Slice A不扩大为完整商店/模型/充值。原40接受条件和28结构条件完整保留。

**状态：作者候选，独立整合审查待进行；架构接受/结构冻结/Entry未签，G1未切。** 27条作者设计支持不等于关闭；9条仍缺实物证据或权限，4条未来义务未处置。真实运行/Repo写/CI调度/历史用户载荷访问/模型动作/商业启用均0。

## 阅读路径
先读主文，再读 `details/原40项架构接受条件与取证待办.md`、`data/ArchitectureIntakeCompletion.json` 和 `review/FreshContextReviewHandoff_v025.md`。完整合同现行条文在 `details/22合同现行规则与领域消费.md`；源码/文档检查脚本在 `scripts/`。

## 包结构与来源
`data/CurrentArtifactRegistry.json`登记新当前设计对象、字节、摘要；`sources/`只放精确原件副本，`archives/`含两份完整外审ZIP及其内嵌精确候选。原始源文件在自身命名空间解释，旧current/待审/接受不能搬成本包状态。全部来源的ZIP成员链在SourceProvenance，前任440成员保留在完整原ZIP，不为减少大小而丢弃。

`evidence/entry-preview`仅为离线candidate-manifest生成样例，**不是仓库当前README/Root AGENTS，不能安装或用作执行权威**。所读GitHub接口只作所选时点安全字段转录，不是原始API响应或用户数据审查。

## 复验
Python标准库即可运行，报告应输出包外：
```bash
python scripts/verify_v025.py --root . --report /tmp/v025-check.json --sealed
python scripts/entry_manifest_design.py selftest --root . --report /tmp/v025-entry-check.json
```
不联网，不运行历史来源脚本。根PACK_MANIFEST覆盖除根自身/根SHA清单之外的所有成员；根SHA256SUMS覆盖除根自身以外所有成员，包括Manifest和嵌套同名SHA清单。最终ZIP摘要及封包后/异目录报告由包外登记非循环绑定。

这是作者文档/来源/封包验证，不是独立审查或产品E2E。原130架构规格、90商业规格、54产品case与16许可设计例保持分来源计数、全部未执行。实际消费者绑定0，真实总数未知。

## 差分与引用核验
`changes/ChangeIndex.json`包含新当前文件的前后摘要、双向文本差分和JSON typed变化；`changes/PredecessorMemberDisposition.json`逐一登记精确前任440成员的保留位置与当前承接目标。`data/CurrentReferenceInventory.json`逐条列出当前JSON的完整路径型引用，排除具名历史快照字段；不声称该机械清单能够解析任意自然语言中的所有引用。
