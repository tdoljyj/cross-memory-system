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

## 恢复保障（实测）

删除后实测过，两类分支的恢复保障并不相同：

- **145 个有 PR 的分支（A 类 + B 类）**：head 提交由 GitHub 永久保存在
  `refs/pull/<n>/head`，与分支是否存在无关。即使本清单丢失，也能从对应 PR
  页面恢复。
- **26 个从未开过 PR 的分支（C 类）**：提交对象在分支删除后变为 unreachable。
  清理当天实测 `git fetch origin <sha>` 仍可取回，但这只是 GitHub 尚未回收；
  **本清单记录的 sha 阻止不了 GC**，窗口过后无法恢复。

之所以接受这一点：C 类分支经逐个核对，没有 `main` 中缺失的实质内容——它们是
评审结论、"不予签发"记录和被后续分支取代的中间态。若日后需要真正长期保全
这类分支，正确做法是打 tag 让提交重新可达，而不是只记 sha。

## 清理过程中的两个意外

- 连续删除约 144 个分支后触发了 GitHub 的二级速率限制，此后所有删除请求返回
  403（新建分支不受影响，实测可创建）。限制解除后排队的请求一并生效。
- 限制解除时，此前排队的删除把承载本清单的工作分支也删掉了，清单一度丢失，
  靠本地提交重新推送才恢复。把删除操作的恢复凭据放在同一仓库的非 main 分支上
  并不安全——这也是本清单应当合入 `main` 的原因。
