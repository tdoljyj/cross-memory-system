# 分支清理记录 2026-09-16

删除了 `main` 以外的全部 171 个远程分支。每个分支的 tip sha 记录在
`branch-cleanup-20260916-backup.txt`，可逐条恢复：

```
git push origin <sha>:refs/heads/<branch>
```

## 为什么没有"先合并再删除"

`main` 的历史在 2026-09-15（PR #187 合并之后）被重写成了一条孤立历史，
当前根提交是 `7d215921`。被删的 138 个旧分支仍挂在重写前的历史上，根提交是
`de128e0c 初始提交`。两条历史**没有共同祖先**，`git merge-base` 返回空。

因此合并任何一个旧分支都会：

- 把 500+ 条重写前的提交灌回 `main`；
- 还原 `1e743976 chore: externalize historical narrative docs to Drive`
  有意外置到 Drive 的历史文档。

也正因为历史被重写，`git branch --merged` 在本仓库不具参考性——它把 138 个
工作早已落地的分支报成"未合并"。清理依据改用 GitHub 的 PR 记录。

## 清理依据

清理时仓库共 237 个 PR，**全部处于 closed 状态，没有任何 open PR**，
其中 233 个已合并。171 个分支按 PR 状态分为三类：

| 类别 | 数量 | 判定 |
| --- | --- | --- |
| A 有已合并 PR | 142 | 工作已落地 |
| B PR 关闭未合并 | 3 | 均被后续分支取代 |
| C 从未开过 PR | 26 | 旧历史线的中间/评审分支 |

B、C 两类逐个核对过，没有 `main` 中缺失的实质内容：

- `claude/root12-signatures`（PR #222）被 `root12-signatures-v2`（PR #224）取代，
  tip 提交信息已存在于 `main`。
- `claude/root12-grr-schema-ref`（PR #230）被 PR #231/#232/#233 取代。
- `governance/multitrack-bootstrap-v0.1.3`（PR #160）相对 `main` 净删除 633 个文件，
  是远落后的旧状态。
- `claude/inspiring-ritchie-nhjcpi`（无 PR）对 `.gitattributes` 的改动只是重写注释、
  调整条目顺序，生效规则集与 `main` 完全一致。
- `codex/phase2-qualification-evidence-20260908`（无 PR）在旧历史线上，内容已随
  当时的 PR 落地。

其余 C 类分支（`claude/root6-*`、`claude/round2*-review-*`、
`claude/route-b-manifest-narrowing-review` 等）是评审结论与"不予签发"记录，
本就没有打算并入主线。
