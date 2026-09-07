# Step 1 独立证据核对（限定 validation lane）

核对时间：2026-09-07 06:16–06:21 UTC。没有修改仓库，没有提交，没有重新触发 GitHub workflow，没有执行迁移或签发接受/冻结决定。

## 结论与范围

**VERIFIED：已有 validation lane 的四 Gate 正例及四个定点负例有真实运行、真实回执和一致的对象/实现绑定。CloseoutIndex 所引五份 artifact ZIP、五份回执与四份负例清单均已重新下载并逐字节重算大小和 SHA256，全部符合历史索引。**

本结论不是全产品/架构审查完成，不是 Step 2 已完成，也不能单独将 Step 1 全清单标记 READY。完整候选包及包内 review subject/历史义务由父代理另行检查；本子任务未独立取回约 246 MB 的候选字节。Library 持久副本未实际读取，仅 DOCUMENTED。未在本机重新运行 validator/negative harness。

核对对象是父代理本请求已从远端确定的 Git 对象。读取根 AGENTS.md 后，只检查显式 Git source/CI evidence，未将 historical memory snapshot 用作当前进度。Python 子进程遇到本机沙盒用户所有权校验，仅对这个受审仓库使用单命令 safe.directory 参数读取 Git 对象，没有修改 Git 全局配置。私库 gh 在沙盒凭据上下文返回 404，宿主只读权限获准后同一路径成功；不能把前者称为仓库不存在或网络故障。

## 精确对象和版本轴

| 内容 | 核对值 | 状态与边界 |
|---|---|---|
| Validation 语义候选 / 包修订 | v0.2.7 / v0.2.7.1-manifest-repair | VERIFIED：Git identity/source、两次正例回执一致；本子任务没有重算候选包本身 |
| Candidate | `Clued_Phase2_三轨修订与补证_完整审查候选包_v0.2.7.1_Manifest修复_20260906.zip`；246612118 bytes；960 members；SHA256 `6e51374a6caedb4f84d2b6bb9fe05cd695b25732833f9d0217c341f17e1c1649` | VERIFIED：索引、identity/source、正例回执、负例 base before/after 相同 |
| 包修订前任 | v0.2.7 原包；246708127 bytes；960 members；SHA256 `72b9481ebdedbe995a8073156679560163db3955f69da4509d9d488626e16c98` | DOCUMENTED：candidate-identity 的 predecessor_candidate；未独立下载原包对比 |
| 架构直接前任 | 168491377 bytes；440 members；SHA256 `4aae92c37813772e983a14537be52ca8b428af666e644b72d40084ccd592d68b` | VERIFIED：正例真实 Provenance gate 回执包含此结果；本子任务未独立复算嵌套字节，完整文件名由包内 subject 另核 |
| Mapping input | 68888178 bytes；257 members；SHA256 `18ed0482bfb639b4fcc8cdce45782b2649b127609f65286c7328cd143dc93dbd` | VERIFIED：CI 回执绑定；不能当架构前任 |
| Product input | 1367376 bytes；85 members；SHA256 `a79a733555eb45d731eb38c0c3984c2230fb8dd959f62dbfe3fe71f6cfe8c709` | VERIFIED：CI 回执绑定；不能当 validation 外包或架构前任 |

Git 固定证据位置：`artifacts/clued-validation/phase2-v027/{candidate-identity.json,candidate-source.json,closeout/ValidationLaneCloseoutIndex.json}`，索引提交 `59ed841b8264ea4e246d595bc425d44373cee615`。引用历史索引的 PASS 只解释为 `PHASE2_V027_VALIDATION_LANE_ONLY`，`authority_effect=NONE`。

## Run → Job → Artifact → Receipt

以下五次均为 run attempt 1，run/job/receipt 的 commit 与 run ID 匹配。正例的真实 gate step 为 success；负例的真实 fixture step 为 failure，且 Upload negative gate evidence 为 success，不是网络/下载失败造成红灯。

| Case | Run / Commit | Artifact | 四 Gate 结果（Identity, Manifest, Provenance, Product） | VERIFIED 的实际失败原因 |
|---|---|---|---|---|
| 正例 | [34069116734](https://github.com/tdoljyj/cross-memory-system/actions/runs/34069116734) / `07632caa673395e136c60d9cf4f2f884c03a59af` | 9999876944 | PASS / PASS / PASS / PASS | 不适用 |
| Candidate identity 负例 | [34068788695](https://github.com/tdoljyj/cross-memory-system/actions/runs/34068788695) / `ca3292bb58dce28115636a31f1c09301b9bd1b30` | 9999786548 | FAIL / SKIPPED / SKIPPED / SKIPPED | 外包追加 24 bytes，保留原 identity，实际大小不符；后续 gate 按 fail-closed 跳过 |
| Manifest 负例 | [34068853770](https://github.com/tdoljyj/cross-memory-system/actions/runs/34068853770) / `ea94e901f97507d6c7f600813b36acfe5db5bd4c` | 9999806197 | PASS / FAIL / PASS / PASS | Manifest 漏 `00_README.md`，覆盖检测失败 |
| Provenance 负例 | [34068945665](https://github.com/tdoljyj/cross-memory-system/actions/runs/34068945665) / `9c657f8ffcf67296d394946b2050e049dc535664` | 9999831842 | PASS / PASS / FAIL / PASS | 仅修改 direct predecessor 摘要并重新构造根完整性元数据，前任身份一致性检测失败 |
| Product input 负例 | [34069016068](https://github.com/tdoljyj/cross-memory-system/actions/runs/34069016068) / `90d1e9fc72b39f918c536d5a375d7096af439668` | 9999852995 | PASS / PASS / PASS / FAIL | requirements 声明从 36 改为 37 并重构完整性元数据，计数一致性检测失败 |

四份 fixture manifest 均证明（本次核对其真实 CI 记录，不宣称重新执行）validator exit code=1、intentional job exit code=1、expected_behavior_confirmed=true；base candidate before/after 大小与摘要一致；fixture 不是 release candidate；mutated fixture 本体未留存。它们证明上述四种针对性防护，不证明 validator 全部条件已获得完备负例覆盖。

补充最新 validation HEAD 证据：本次 live 列表显示 `59ed841b8264ea4e246d595bc425d44373cee615` 的 [run 34069453639](https://github.com/tdoljyj/cross-memory-system/actions/runs/34069453639) success；真实四 Gate step success、回执 overall PASS、四 Gate PASS、subject 相同。已下载该回执并自行重算 SHA256 `c1e5e7260ad601877de9d05a1d32aaca37b64f0f6297f57746013433e3de8ca2`。该补充 run 不在旧 CloseoutIndex 中，故作为新证据保留，未改写原索引。其 artifact 9999974175 的 ZIP SHA256 `4133d46f5032d2be7937951469549c91a0a1ec6bba8033c7e87f7a88ce8c78dc` **仅来自 API 元数据，未独立下载该 ZIP 重算**；下载回执内容的重算与 ZIP 的摘要是不同证据。

## 实现绑定和信任边界

VERIFIED：上述四负例、原正例、59ed841、c39cfd6 共七个 Git commit 内，下列五个输入文件的 Git blob 均相同。精确 Git blob 字节 SHA256 独立重算，详细内容在 `code-bindings.json`。

- Validator：blob `83b3346998a6a78171336607d6c8b298ed9afa4e`；SHA256 `e16cc9fa5fd2a54dc3922029851722936551a400979dc94dce691faa83bd7f4e`。
- Negative harness：blob `6b0ee1440f925098462cce2bd78bf69c32a74dbc`；SHA256 `46520afc2175c468bb15162c7ec2fb43d157ddcbb05481ea062f7a31083f6860`。
- Workflow：blob `9fcd0a6b9545d0ce3fce76a4c3ae77de4273b4d9`。
- Candidate identity：blob `95440b4feb0ac2630b0f0ee399115ff8dac9d422`。
- Candidate source：blob `a2d46ea9c4c1651b3d12d4478a583cd26004143b`。

在上述六个受检查输入路径（五个稳定输入 + negative-test-control）范围中，仅 control 随负例变化；原正例后恢复 `case=none`，其 blob `47d639c349ca63e8fc393420f3651492444f3ba8` 与索引/59ed841/c39cfd6 一致。本结论没有声称七个 commit 的全树仅这一项变化。七个 commit 都已用 `merge-base --is-ancestor` 确认是受检查 naming HEAD 的祖先。

Receipt 生产者是被检查 commit 中的 workflow/validator，运行于 GitHub Actions，并通过已认证私库 API 的 run/job/artifact 绑定追溯。Receipt 自身是 JSON，不是独立签名或外部 attestation。本次没有把 SHA256 当作授权证明，没有检查整个仓库管理员/规则变更/bypass 信任模型；Step 18 的不可绕过证明不能由这里推出。

Workflow 声明并校验 asset_id 的配置一致性，但实际下载命令按 tag+asset_name 解析；候选包最终 bytes/members/SHA256 检查守住内容身份。不能宣称运行时按 immutable asset ID 获取。若未来准入合同把 Release asset ID 本身列为必须实时绑定，应增加该项，而不是把已有内容身份 PASS 改判为字节不匹配。

## 证据留存与清单映射

| 项 | 本次结论 | 说明 |
|---|---|---|
| S01-01 | VERIFIED / DOCUMENTED，分项如上 | 元数据、CI subject与版本轴能对应；父代理须补完整包及包内合同的独立核对后综合判断 |
| S01-02 | VERIFIED（显式列出的输入与 CI） | 七个 commit 五稳定输入、控制模式、真实 run/job/receipt 相符 |
| S01-03 | VERIFIED | 原正例及 validation HEAD 正例均真实执行四 Gate PASS |
| S01-04 | VERIFIED（四个既有定点 case） | 精确目标、预期错误和 exit code，未将其他步骤 skipped 误判为未验证 |
| S01-05 | VERIFIED（当下 GitHub 可重取）；DOCUMENTED（Library 持久副本） | 五个旧 artifact ZIP 重取、hash一致；CI artifacts 均 2026-12-06 到期，不能仅凭临时链接宣称永久留存；Library/完整汇总 Receipt 未读 |
| S01-06 | VERIFIED（收口边界/恢复正例）；UNKNOWN（完整包的未关闭事项集合） | index 明确未签发 architecture acceptance/freeze，未启用 main required check，未生产写；其 next_authorized_work 为 Naming inventory，与新21步基线需经Step2入口补映射，不能用一句旧 next_authorized_work 跳步 |

当前保存位置为 `work/step1-evidence/`：五个 `{artifactId}.zip`；每个 `{runId}/` 内含 run.json、jobs.json、artifacts.json、原始 CIGateReceipt.json 和适用的 NegativeFixtureManifest.json；`verified-runs.json` 保存本轮重算结果，`code-bindings.json` 保存精确 Git 对象核验；`source-*` 是索引对应 commit 的精确输入文件。API JSON 采用本次工具输出保存，格式转换不改变语义，但不宣称它们是 GitHub 原响应 HTTP 字节。Receipt 与 fixture 均保留下载 UTF-8 原字节。

没有找到足以推翻这五次 CI 验证声明的 FAIL/冲突。仍需由父代理完成：精确候选包输入；全部已知义务与 Step 2 入口映射；持久取回方案登记。若父代理将已验证小回执另存受控私库，可补充一个实际验证的持久副本，保留原 run/receipt 身份及历史 index 原文，不必为了证明留存重跑旧 CI。
