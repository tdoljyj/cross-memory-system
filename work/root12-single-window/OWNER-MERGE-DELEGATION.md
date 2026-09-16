# 第 12 代：部分 Owner 合并由代理代为执行

**状态**：如实记录，不是授权文件。本文件不赋予任何权限，也不改变任何已签对象。

## 事实

这套控制体系把 **Owner 合并当作签名**。`verifyOwnerMergeArtifact` 核验三件事：

- `merged_by` 是 `tdoljyj`
- 合并提交的 `committer` 是 `web-flow`
- `verification.verified == true`、`reason == "valid"`

这三项想证明的是"有个人看过这些字节并认可了"。

2026-09-16，Owner 在本次会话中明确授权代理用 Owner 的 GitHub 令牌代按合并键，并要求
把这件事写进文档。据此，第 12 代的若干合并**不是**由 Owner 逐一人工审阅后按下的。

## 分界线

| PR | 合并提交 | 谁按的合并键 |
| --- | --- | --- |
| #227 | `2c6618c1…` | Owner 本人 |
| #228 | `4f632344…` | Owner 本人 |
| #229 | `5e608e9d…`（合并 `4f632344` 之后） | Owner 本人 |
| #231 | `f5d0a8fe…` | Owner 本人 |
| #232 | `6230a03c…` | 代理（经 Owner 明确授权） |
| #233 | `4ba5f4f1…` | 代理（经 Owner 明确授权） |
| #234 | `97e302c6…` | 代理（经 Owner 明确授权） |
| #235 | `23ede325…` | 代理（经 Owner 明确授权） |

`#230` 由代理开启后又撤回，未合并。

## 这对证据意味着什么

- 三项机器核验对上表所有合并**都成立**，因为令牌就是 Owner 的账号：提交仍由 GitHub 代签，
  仍是 `web-flow`、仍 `verified`。检查器查不出区别。
- 因此，凡是依赖"Owner 合并 ⇒ 有人独立看过"的推断，对标了代理的那几行**不成立**。
  这几份文档的字节由代理生成、由代理发布、由代理合并；除代理自己的断言外，没有第二方审阅。
- 受影响的具体主张：`Root12SignatureEvidence.json` 与 `Status32SignatureEvidence.json` 里的
  `merged_by: tdoljyj`、`required_verification`；`Root12IndependentAcceptance.json` 中
  "独立"二字，就本代已标代理的那几次发布而言，指的是与被测 Skill 相互独立，
  **不**指与作者相互独立。

## 边界

- 本文件不修改任何已签对象，也不追认任何权限。
- 后续代次若要恢复"合并即人工审阅"的强度，Owner 需要重新亲自按合并键，或引入第二个审阅账号。
