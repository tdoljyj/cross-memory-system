# 第 11 代派发物料与驱动

改编自 `work/root10-single-window/scope-amendment/material/`（那一版从未合并进 main，
取自 `81172625`）。第 11 代不带任何修正案，因此：

- **物料装配器**去掉 `scope_amendment` 槽；`source_ref` 改从 `expected_ga` 读；
  "源提交必须是某次 Owner 合并"换成控制器实际用的"源提交必须是该合并的祖先"
  （`compare` 为 `ahead` 或 `identical`）——第 11 代的源提交 `55fd9732…` 是分支上的普通提交。
- **派发驱动**去掉修正案激活事件与被取代的时间延续事件；主机窗口改由 GA 自己的
  `issued_at`/`deadline` 界定；并断言这个 GA 上**不存在**任何修正案事件。

另外补上第 10 代那一轮实测才发现需要的三处：

| 补丁 | 原因 |
| --- | --- |
| `GH_TOKEN` 传给受信入口 | 入口要调 GitHub API |
| 丢掉 record 响应里没人读的 `current_context` | 入口单行 stdin 限 4 MiB，而 `execution_transition` 在两个响应里都回了 3.3 MB 上下文；`checkDispatchEvidence` 只读 dispatch 那一份 |
| `--grr-extras` | GRR 的物料比模板多 `grr_raw`、`oracle_assessments`、`result_executor_applicability` |

## 发布映射

`ga_target` 与 `acceptance` **必须是同一次合并**：无修正案分支上控制器检查
`result.ga.target_revision === material.runtime_acceptance.publication.commitSha`，
并用它作为 `verifySourcePublication` 的 Owner 合并。两者都是 #217 的 `f113e9a6…`。
