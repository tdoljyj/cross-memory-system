# root6 窗口迁移：构建脚本（**尚未执行，产物未提交**）

本目录只有一个可复现的构建脚本。**它的产物不在仓库里**，这是有意的，原因见下。

状态：`PREPARED_NOT_EXECUTED` — 没有签名、没有验收、没有注册、没有安装，未触碰数据库，未动预算。

## 这个脚本做什么

从已绑定的 root5 控制器源：

    scripts/phase2-qualification/control-context-verifier-root5-window5-forward11-successor/

构建 root6 后继源，窗口为 Owner 批准的 `2026-09-12T00:00:00Z` .. `2026-09-13T00:00:00Z`。

代际 id 由 `sha256("clued/root6-generation/v1" + 前代 + 窗口)` **派生而非随机**，因此重跑逐字节一致，复核者可以自行确认该 id 不是为迁就任何东西挑出来的。后续的 `GENERATION_REGISTERED` 追加必须使用同一个 id。

前代目录逐字节保留。`commitment-signing-next-window/signing.mjs` 被 **26 份已冻结产物**按哈希钉住，所以它是复制到新后继目录、而不是原地修改。manifest 在本仓库的惯例是**增量**的（旧的 `commitment-signing/signing.mjs` 与现行版本同时在列），故前代条目保留、新文件追加。

## 为什么产物不在仓库里

脚本**尚未成功执行**。执行请求被 Claude Code 权限分类器以 `Security Weaken` 拒绝两次。

该判断是站得住脚的：脚本客观上放宽三类安全校验——

1. `signing.mjs` 的代际白名单 `[root3, root5]` → `[root3, root5, root6]`
2. `root-window-validation.mjs` 的 Owner 窗口上界 `2026-09-11T10:21:05Z` → `2026-09-13T00:00:00Z`
3. `context.mjs` 中 4 处 dispatch/allocation cutoff 后移

这些是 Owner 批准的窗口迁移的一部分，但工具无从从上下文得知这一点。**未改用其他工具逐文件施加同样修改**——那属于规避该拒绝的意图。执行需要 Owner 明确授权。

曾有一个只落了 7 处改动的半成品目录 `control-context-verifier-root6-window10-successor/` 存在于工作树中，**已删除且从未提交**：它的 `context.mjs` 第 42 行要求活动头为 root6、第 170 行仍要求为 root5，自相矛盾，任何操作都会在 `EXACT_REGISTERED_ROOT5_CONTINUATION` 上失败。保留一个"看起来改完了、其实没有"的验证器，风险高于没有。

## 脚本覆盖的阻塞点（共 5 个文件、跨 3 个目录）

| 文件 | 改动 | 不改的后果 |
| --- | --- | --- |
| `context.mjs` | 代际常量、代际链、`generationForBudget`/`expiryForBudget` 的 root6 分支、continuation 钉住点、2 处 cutoff、1 处容量到期 | 多处硬失败；continuation 与第 42 行**互斥无解** |
| `root-window-validation.mjs` | Owner 窗口上界 | `readControlUri` 对当前代际调 `validateRootShape`，抛 `Owner window` |
| `status-manifest.root5.schema.json` | 2 处代际 const | schema 被实际编译执行，与 `context.mjs:310` 要求的 root6 **互斥无解** |
| `gate-result-receipt.root5.schema.json` | 1 处代际 const | **最终 GRR 交付物过不了自己的 schema** |
| `commitment-signing-root6-window/signing.mjs`（新后继） | 代际白名单 | `makeCommitment` 签 GA 与 GRR 时抛 `purpose_audience_generation_mismatch`——**在最后 600 秒里才会炸** |

前三处之外的两处是初版遗漏、经自查与对抗性复核补上的。

## 执行之后仍未完成的事

脚本只产出候选源。它**不**做下列任何一项：

- 重建后的 manifest 会产生**新的 controller_digest**，资格文档与运行时验收必须据此重新签发
- 两个 schema 改动改变其 sha256 与 blob sha，而 `readBlobRef` 要求改后的 schema **以 blob 形式存在于仓库并可取回**，故须先经 Owner 合并进 GitHub，运行时验收的 `control_schema_refs` 才能指向它们
- StatusManifest generation 24 须按新 schema 重建并经 Owner 合并签名
- 第二十次绑定前推
- root6 的 `GENERATION_REGISTERED` 追加（其 `revocation.expires_at` 须 ≤ 窗口末，且须绑定真实的历史前缀摘要）

边界不变：不重复应用 SQL9、不新增容量、不退款、不复用旧预算；不创建新 trust root、新签名身份、付费/模型预算或生产权限。预算 `charged_seconds` 为 10506 上限中的 9906，每次预留固定 600 秒，**恰好只剩一次分配且不可重试**。
