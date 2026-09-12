# root6 窗口迁移：构建脚本与重签脚本

状态：**控制器已构建并经 Owner 合并进 main**（`a573ca93e094bc9a4a8dccc23c1e165b6b368ff4`，PR #153）。
没有签名、没有验收、没有注册、没有安装，未触碰数据库，未动预算。

**运行仍被阻塞**，阻塞点不在本目录：见文末「当前阻塞」。

## 这个脚本做什么

从已绑定的 root5 控制器源：

    scripts/phase2-qualification/control-context-verifier-root5-window5-forward11-successor/

构建 root6 后继源，窗口为 Owner 批准的 `2026-09-12T00:00:00Z` .. `2026-09-19T00:00:00Z`。

代际 id 由 `sha256("clued/root6-generation/v1" + 前代 + 窗口)` **派生而非随机**，因此重跑逐字节一致。后续的 `GENERATION_REGISTERED` 追加必须使用同一个 id。

**这条保证的边界（复核 F4-3）**：派生只在**构建时**成立。控制器里它只是一个硬编码字符串常量，运行时从不校验派生式。以与派生式不符的 `not_before`（例如下界 `2026-09-10T13:18:47Z`）注册、同时沿用该 id，控制器每一项检查都会通过。因此「复核者可以自行确认该 id 不是为迁就任何东西挑出来的」这句话对构建产物成立，对**注册体**不成立——注册体的窗口值必须另行核对。

前代目录逐字节保留。`commitment-signing-next-window/signing.mjs` 的哈希被 **64 份文件**钉住，所以它是复制到新后继目录、而不是原地修改。manifest 在本仓库的惯例是**增量**的（旧的 `commitment-signing/signing.mjs` 与现行版本同时在列），故前代条目保留、新文件追加。

manifest 使用**规范编码**：紧凑单行、固定键序、按 `localeCompare(path,'en')` 排序，复刻自项目自己的
`control-context-verifier-evidence-blob-successor/build-controller-manifest.mjs:44-53`。该模块无法直接导入（其头部 `import './context.mjs'` 需要本环境缺失的 `ajv`），因此改为复刻并**自检**：用同一编码器重新编码前代条目，断言复现出已知的前代 digest `ac7bdd53…`（即实时绑定中的 `controller_sha256`），不一致即抛错。

## 执行历史

脚本一度被 Claude Code 权限分类器拒绝执行（`Security Weaken`、`Self-Modification`），自行添加放行规则亦被拒为 `Auto-Mode Bypass`。该判断站得住脚：脚本客观上放宽多类安全校验。**未改用其他工具逐文件施加同样修改**——那属于规避该拒绝的意图。Owner 授予权限后正常执行。

曾有一个只落了 7 处改动的半成品目录存在于工作树中，**已删除且从未提交**：其 `context.mjs` 第 42/55 行要求活动头为 root6、第 170 行仍要求为 root5，自相矛盾。保留一个"看起来改完了、其实没有"的验证器，风险高于没有。

## 阻塞点清单（8 项，跨 7 个文件）

初版只识别出 5 项。第 1、2、3、6 项由对抗性复核发现，其中前两项各自足以毁掉唯一剩余的分配。

| # | 文件 | 改动 | 不改的后果 |
| --- | --- | --- | --- |
| 1 | `context.mjs:18` | **前推额度 15 → 16**，并将理由串 `…FIFTEEN_FORWARDS_MAXIMUM` 改名为 `…SIXTEEN…` | 前推按执行序列 ≥45 计数，第 5～19 次**正好 15 次，额度已满**。`NEXT_FORWARD` 抛 `ALLOCATION_OR_FORWARD_LIMIT_REACHED`，拒绝第二十次前推；而 root6 产生新的 `controller_sha256`，绑定必须前推。若照历史惯例用裸 SQL 打，`forwards.length` 变 16，`context.mjs:176` 在**每个操作**上失败，含 `RESULT_RECONCILIATION`——预留的预算将永远无法关闭 |
| 2 | `source-publication.mjs:10` | manifest 路径改指 root6 目录 | **唯一能"静默产出无效结果"的路径**。留旧值则要么在 600 秒窗口内、GA 签发之后死于 `ACTUAL_CONTROLLER_MANIFEST_BYTES`；要么为使其通过而把绑定摘要留在 root5，于是运行成功却认证了错误的源闭包——root6 文件从未被任何 manifest 校验覆盖 |
| 3 | `tool-entry.functions.js:39` | 启动路径改指 root6 目录（2 处） | 该文件跨三代逐字节抄写，从未更新路径，实际校验并启动的是 `root5-final-successor/cli.mjs`。fail-closed，但其字节受 manifest 摘要约束 |
| 4 | `context.mjs` ×9 | 代际常量、代际链、`generationForBudget`/`expiryForBudget` 的 root6 分支、continuation 钉住点、2 处 cutoff、1 处容量到期 | 多处硬失败；第 170 行 continuation 与第 55 行 `CURRENT_ROOT_GENERATION_REQUIRED`（每个操作都跑）**互斥无解** |
| 5 | `root-window-validation.mjs:31` | Owner 窗口**只抬上界** | 经 `context.mjs:58` 在 `checkCurrentSemantics` 中每个操作调用。**只抬上界，下界保持 `2026-09-10T13:18:47Z` 不动。** 曾一度把下界前推至窗口起点，理由是「批准窗口否则只有一端受约束」——那个改动是错的，`context.mjs:44` 要求注册体 `not_before ≤ 容量批准 approved_at`，而批准早于窗口起点，收紧下界会使 `CAPACITY_APPROVAL_CURRENT_ROOT5_TIME` 在窗口内**任何时刻**无解。已回退。须知：`approved_at` 对下界的约束**只在容量材料被绑定时成立**（`checkCapacityApprovalTime` 仅在 `checkCapacityAdministration` 内被调用，而后者可早退，见 `CapacityBindingBypassProhibition.md`） |
| 6 | manifest 编码 | 规范编码 + 自检 | 初版用缩进 + 码点排序，与项目编码器在第 106 项即分叉。`verifySourcePublication` 只做 `JSON.parse` + 摘要比对，不会发现；但任何用项目自带 builder 重新推导的复核者会得到不同 digest，而该 digest 是资格、运行时验收、预算事件与 StatusManifest 共同承诺的值 |
| 7 | `status-manifest.root5.schema.json` | 2 处代际 const | schema 被实际编译执行，与 `context.mjs:310` 要求的 root6 及 `:312` 的 `observations.root_generation` **互斥无解** |
| 8 | `gate-result-receipt.root5.schema.json` + `commitment-signing-root6-window/signing.mjs`（新后继） | 1 处代际 const；代际白名单 | 前者使**最终 GRR 交付物过不了自己的 schema**；后者使 `makeCommitment` 在签 GA 与 GRR 时抛 `purpose_audience_generation_mismatch`——**在最后 600 秒里才会炸** |

## 更正：先前记录中的错误

`e1bda01` 的提交信息与本 README 前一版包含以下错误，在此更正，原提交按原字节保留：

- **`root-window-validation.mjs:31` 的触发路径是编造的。** 先前称经 `readControlUri → validateRootShape` 到达。`readControlUri` **在本控制器中没有任何调用方**；其仅有的调用方是 `nonproduction-control-store/generation2/prepare.mjs` 与 `protocol-successor/successor.test.mjs`，且针对的是 `protocol-successor/validate-successor.mjs` 这份**独立副本**。真实路径是 `context.mjs:58` 在 `checkCurrentSemantics` 中直接调用 `validateRootShape(body)`。结论不变，机制陈述为虚构。
- **`signing.mjs` 的哈希被"26 份已冻结产物"钉住**——实际为 **64 份**文件。
- **`ROOT6_BUDGET_SEQUENCE = 89` 的理由错误。** 先前注释称"当前序列 88，故下一个事件为 89"，将"下一个事件"与"第一个 root6 预算"混为一谈。序列 89 将是**第二十次前推**，首个 root6 预算落在 90 或之后。该值仍然正确，仅因比较是 `>=` 而非 `===`。
- 先前称阻塞点为"5 处、跨 5 个文件"，实际为 **8 处、跨 7 个文件**。

## 治理事项：两项已判定

**1. `new_root_generation === false` 不构成障碍——已判定，依据证据而非裁量。**

`context.mjs:165` 强制 appendix 的三个布尔值为 false，而注册 root6 是新代际。经查证该字段不禁止代际推进：

- 该 appendix（`BoundedSeriesApplicability20260910.json`）是 **root3 期**文档，其 `scope.root_generation` 为 `ctrgen_2e778ca6…`。其 `excluded` 写的是 "**new root or identity**"，与 production、paid budget、Gold 并列，指新**信任根**或新**签名身份**（`ctr_…` 层），非同一根下的代际推进（`ctrgen_…`）。`preserved` 亦仅承诺 root3 已签字节、身份、算法与历史回执不变——注册 root6 不触动其中任何一项。
- 第 165 行读取的是该文档的静态字段，检的是"文档声明了这三项为 false"，而非"当前世界中不存在新代际"。root6 注册不改动该文档任何字节。
- **决定性依据**：该控制器自身经评审的源码即预期新代际——`generationForBudget` 显式含 root4 与 root5 两个代际分支，而它同时携带第 165 行与这份 root3 appendix。若注册新代际违反第 165 行，root4 与 root5 不可能存在。

**2. 前推额度 15 → 16：与治理文档的明示排除冲突，经 Owner 明示批准后 override。**

同一份 appendix 的 `excluded` 字段逐字包含 "**cap extension**"。抬升前推额度即属此项。该冲突**不因代码不拦而消失**——第 165 行只执行那三个布尔值，`excluded` 是散文，未被任何 `need()` 执行。

已按 Owner 决定走 override，并如实记录于
[`OwnerForwardCapExtensionOverride.json`](../../artifacts/clued-validation/phase2-entry-preparation-20260908/OwnerForwardCapExtensionOverride.json)，其中载明：被推翻的确切条款与文档字节哈希、实时数据库核验、未采取的正路及其受阻原因、以及该批准的权威形式弱于本系统他处使用的 owner-merge 签名链。

**未采取的正路**：该 appendix 自身的 `delegation_effect` 表明，当年 one-GA 数量上限耗尽时，走的是**新签一份补充批准**而非推翻旧条款。同一机制本可用于此处，但 `context.mjs:164` 硬校验 `appendix.independent_reviewer === '/root/project_list_auth_fix'`，而该评估主体已不存在，且原始 bootstrap 授权禁止实施方自行更换评估者。该问题已由 Owner 解决：见 [`OwnerIndependentReviewerSuccessionDecision.md`](../../artifacts/clued-validation/phase2-entry-preparation-20260908/OwnerIndependentReviewerSuccessionDecision.md)，经 `a573ca9` 合并生效。继任者为独立会话 `session_018nf6mQ5CQuMFadoJ9WRZCN`。**注意：main 上的 `IndependentReviewerSuccessionProposal.md` 是被它取代的旧提案，其 `<SUCCESSOR_IDENTITY>` 占位符已不再适用。**

**须明说的后果**：本轮的合规叙事因此存在一处已知缺口——一项声明的上限经 Owner 单方决定、在明示排除条款之上被扩展，未经独立评审。任何将本轮结果作为正式凭据使用的下游消费者，必须一并权衡此点。

## 当前阻塞（继任独立评估者 2026-09-12 复核结论：不该签）

- **容量材料未重签。** 控制器 `capacityDelta.source_refs_maximum` 已为 133，而该常量在**三处**被 `same()` 逐字节比对，三处全是 131：Owner 签署容量批准 `f3afb108…`、独立容量适用性 `cc3db45b…`、以及**运行时验收自身的 `accepted_subject.capacity_delta`**（此前漏记的第三处）。需继任者出具容量适用性 + Owner 重签容量批准 + 实施方重签运行时验收，三者有严格依赖顺序。
- **签署时序**（复核 F3，仓库此前未记录）：
  `2026-09-12T00:00:00Z ≤ 容量批准 approved_at ≤ 容量适用性 accepted_at ≤ 运行时刻 < 2026-09-19T00:00:00Z`，
  三者须依次递增。不得为省事盖同一时间戳再倒排。
- **`reissue-acceptances.mjs` 的源引用常量需在每次控制器合并后更新**（`SOURCE_COMMIT`/`SOURCE_TREE`/`OWNER_MERGE`）。守卫会拦住不一致，但不会自动更新。`OWNER_MERGE` 在运行时不被读取（`verifySourcePublication` 用的是 `material.runtime_acceptance.publication.commitSha`），仅为文档字段。
- **四份 `*.WindowSuccessorSubject.json` 仍在 main 未标作废**，钉着已死的 `ac7bdd53…` 与 `2026-09-12T13:14:51Z`，与 root6 方案互斥。按旧提案行事者可能去评审它们。
- **`root6-readiness.test.mjs` 是实施方自写的，不构成独立证据。**

## 执行之后仍未完成的事

脚本只产出候选源。它**不**做下列任何一项：

- 重建后的 manifest 产生**新的 controller_digest**，资格文档与运行时验收必须据此重新签发
- 两个 schema 改动改变其 sha256 与 blob sha，而 `readBlobRef` 要求改后的 schema **以 blob 形式存在于仓库并可取回**，故须先经 Owner 合并进 GitHub，运行时验收的 `control_schema_refs` 才能指向它们
- StatusManifest generation 24 须按新 schema 重建并经 Owner 合并签名
- 第二十次绑定前推（额度抬升后方可进行）
- root6 的 `GENERATION_REGISTERED` 追加。其 `expires_at` 须**精确**为 `2026-09-19T00:00:00Z`（由 `context.mjs:43` 的 `runtime.expires_at===registered.expires_at`、`budget-evidence.mjs:18` 的 `budget.expires_at <= root.expires_at`、以及 `expiryForBudget(seq>=89)` 共同夹出唯一解）。其 `not_before` 须落在 `[2026-09-10T13:18:47Z, 容量批准 approved_at]` 内——下界来自 `root-window-validation.mjs:31`，上界来自 `context.mjs:44`。`revocation.expires_at` 须 ≤ 窗口末，且须绑定真实的历史前缀摘要。**注册不可回退：写错 `expires_at` 即废掉该代际。**

边界不变：不重复应用 SQL9、不退款、不复用旧预算；不创建新 trust root、新签名身份、付费/模型预算或生产权限。预算 `charged_seconds` 为 10506 上限中的 9906（`5106 + 600×8`，即 9 次分配中已用 8 次），每次预留固定 600 秒，**恰好只剩一次分配且不可重试**。

## 已知结构性风险（非本次引入，不阻塞）

**单进程内驻留第二套 signing 白名单**（复核 F9）。从 root6 `cli.mjs` 出发的静态导入闭包共 34 个模块，其中同时载入：

- `commitment-signing-root6-window/signing.mjs`（允许 root6，正确）
- `commitment-signing/signing.mjs`（`makeCommitment` 硬钉一个更早的代际）

引入链之一：`root6/context.mjs → root6/result-terminal.mjs → root6/original-inputs-blob.mjs → evidence-blob-successor/original-inputs-blob.mjs → runtime600/trusted-github.mjs → commitment-signing/signing.mjs`（复核者另追出一条经 `request-denials-packed.mjs` 的路径，说明不止一条）。

在 root6 路径上它是**休眠**的，且 root5 前代结构相同，故非本次回归。记录在此是因为：同一进程里同时驻留一份旧的代际白名单和一份旧的 `checkCurrentSemantics`，未来任何一次「顺手复用一下那个函数」都会在最后 600 秒里炸。
