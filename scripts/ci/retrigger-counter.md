# G5：人工重触发只读计数

根因与证据：`work/independent-ci-resident-v1/src/admission-rerun.mjs:7` 明确自动补跑使用 Owner 的 gh 登录，不能只按 `triggering_actor` 把 User 全部当作人工；该文件 `:285` 将结果写入节点本地状态，`:315` 才把成功结果转为中文提示。`work/independent-ci-resident-v1/src/pr-status.mjs:4`、`:162`、`:569` 证明提示在 commit status 中，不在评论中。修复前缺少将这些分散证据与运行、提交、时间线关联的只读统计入口。背景清单 `D:/w/tmp/PLAN-process-failure-classes-20261116.md:158` 的 G5 要求以自动补跑记录相抵。

## 使用

需要现有 Node 与已登录的 `gh`，无需 npm 安装。私有仓库需 Actions、Contents、Pull requests 的只读访问权。脚本只发显式 `gh api --method GET`，不提交、不重跑、不 dispatch，也不读取 companion 私有状态或凭据。

```powershell
node scripts/ci/retrigger-counter.mjs --repo tdoljyj/cross-memory-system --since 2026-11-16T00:00:00+08:00 --until 2026-11-17T00:00:00+08:00
```

对确知为自动化专用的 **User** 登录，可重复传 `--automation-actor <login>`；Bot 类型和 `[bot]` 后缀自动识别。不要把 Owner 的共享登录加到该列表，否则会把真正的人工操作也计为自动。

成功仅输出一行 JSON，退出 0。`counts` 中的 `reruns`、`empty_commits`、`main_merges`、`reopens` 均有 `manual/automatic/unknown/total`；`events` 提供 run:attempt、commit SHA 或 timeline event ID、北京时间、关联 PR 和归因依据；`prs` 提供逐 PR 计数。仓库总数按事件身份去重，同一提交出现在两个 PR 时只计一次，因此逐 PR 数量不应直接相加。

窗口为 `[since, until)`，输入必须带时区，输出为北京时间。失败同样只输出一行 `status:error` JSON，退出 1，不输出部分结果或假零值；不会回显 gh 的原始认证诊断。

## 计数口径与边界

- rerun 按额外 **attempt 次数**，不按有过重跑的 run 个数。读取所有保留 run，再逐次取 attempt 的 `run_started_at` 和 `triggering_actor`；不使用最初的 `created_at` 过滤，以免漏掉窗口前创建、窗口内重跑的运行。`workflow_dispatch` 是新 run，不属于 rerun，本简报要求的四类之外不另计。
- companion 自动补跑使用现有 `resident-queue/<node> (info only)` status 的“已自动补跑一次必需测试”提示。每个 head 的最早提示，只在其前 15 分钟内恰有一个 `clued-required-tests.yml` 的额外 attempt 时抵扣一次。重复 status 不重复抵扣；历史 attempt 同样参与匹配，旧提示不抵扣新人工操作。多个候选列为未知。此时间关联是现有可见证据下的保守识别规则，不是带签名的 attempt 回执；提示缺失或发布延迟超过 15 分钟时，无法仅凭 GitHub 完美识别共享身份的自动化。没有匹配证据的 User 按人工口径统计，不能据此声称精确还原了真人意图。
- 空提交按提交者时间入窗，要求恰有一个父提交且两者 tree SHA 相同；根提交、合并提交不算空提交。提交者 Bot/配置身份归自动，身份缺失归未知；GitHub `web-flow` 使用提交作者身份。人工是 GitHub User 身份口径，不能区分同一 User 凭据背后的真人与其它 Agent。
- 合 main 要求提交出现在 PR commits 列表、恰有两个父提交、标准 merge 信息指明合入默认分支，并核第二父提交是当前默认分支的祖先。普通 feature 合并不算。自定义/本地化合并信息不在此可识别集合内；GitHub API 不保存任意时刻的完整分支引用，当前祖先关系也不能证明过去的引用归属。每条结果的 `basis` 明示所用证据。
- 重开必须有同一 PR 时间线中先前的 closed 事件，按 reopened 时间计数；关闭可发生在窗口之前。每次关闭后再开均独立计数，不能用当前 PR state 代替历史次数。
- 提交覆盖当前全部分支，以及窗口内更新的 PR（含关闭/合入、分支已删除但 API 仍能读到的 PR）；已删除且无 PR 的不可达提交、被 force-push 丢弃的旧提交、已删除/超过 GitHub 保留期的 run 无法由这些只读 API 全量恢复。输出 `coverage` 明示边界，不把可见零计数当作全历史零操作的证明。
- 完整分页并核 Actions `total_count` 和 PR commit 数量。PR commits API 最多 250 条，超过即失败；单列表最多 1000 页、单次最多 20000 个 API 请求、每次 gh 最多 60 秒，触顶均失败，不静默截断。读取的是动态 API 观察值，不是跨接口事务快照；需在目标窗口结束后统计。该工具独立按需运行，不接入准入、合并或发布必经路径。

接口口径参考 [workflow runs/attempts](https://docs.github.com/en/rest/actions/workflow-runs)、[PR commits](https://docs.github.com/en/rest/pulls/pulls#list-commits-on-a-pull-request)、[issue timeline](https://docs.github.com/en/rest/issues/timeline)。

## 本地回归

录制的合成 API 响应在 `fixtures/retrigger-counter/responses.json`，没有真人数据或凭据。测试包含实际 CLI 子进程（仅在测试进程注入假的 gh GET）、共享身份补跑抵扣、历史与歧义提示、分页、跨 PR 去重、时间边界、空树比较、第二父提交核验，以及 API 失败/截断拒绝。

```powershell
node scripts/ci/ci-required-selection.mjs --run retrigger-counter --root D:/w/tmp/g5-retrigger-counter
node scripts/ci/ci-required-selection.mjs --run selection --root D:/w/tmp/g5-retrigger-counter
```

北京时间 2026-11-16：先写测试后运行，缺少实现导致 `ERR_MODULE_NOT_FOUND`、退出 1；补实现后首批 5/5 通过。扩展实际 CLI 测试发现 compare 的 `...` 被路径保护误拦（8/9），修正为只拒绝路径段 `.` / `..`；最终结果见套件输出。入口选择器 39/39 通过；依赖入口 15/15 及其扫描通过（需设置 `CI_BASE_SHA=7fe6eb22d7e5ade299c7d536239b7e86d7cc387a`）。这里记录本地工程验收，不宣称线上窗口或连续 10 个 PR 已验收。

本地提交尚被执行环境文件系统权限阻断：`git add` 无法创建工作区外的 `C:/w/relay-qual-169/combined-source190/.git/worktrees/g5-retrigger-counter/index.lock`，返回 Permission denied。未提权或改权限，HEAD 保持简报基线；改动留在工作区。后续正常本地提交需带 `Clued-Work-Claim: 7d83095f-b6ad-4e58-b57f-fbe85cbc1586`（接续时须重验/重新认领）及末行 `Co-Authored-By: Codex <codex@openai.com>`，不推送。
