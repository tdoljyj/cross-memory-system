# ADR 0015：写后核对读不到而撤回的扫描检查，可以在同一 head 上重新发布

- 状态：生效（第 28 代，未安装）
- 日期：2026-11-08
- 缺陷：`664cc8eb`（现场 #1037 head `26ac75e4`，2026-11-07 16:22，常驻回执 3826–3827）
- 代码：`CI/src/staged-check-publisher-v2.mjs`（`publish`、`revoke`、`MAX_REPUBLICATIONS`、`republicationKey`）、`CI/src/withdrawal-text.mjs#withdrawnForUnavailability`、`CI/runtime/one-shot-v2.mjs`、`CI/src/resident-v2/stage-inputs.mjs`、`CI/src/resident-v2/stage-fact.mjs`、`R/src/engine-windows.mjs#parseStageOutcome`、`R/src/executor.mjs#publicationRetryable`
- 测试：`R/test/publication-republish.test.mjs`（端到端）、`CI/test/github-read-retry.test.mjs`（gen 28 各例）

## 背景

第 7 段发布 contract-placement 之后，发布器在写后边界重新做完整准入，Native 没在时限内答（`full_admission_unavailable`，传输类）。发布器按既有规则撤回检查：标题是 “verification unavailable”，正文写明 “no change of it was observed”，结局 `REVOKED`、原因 `full_admission_not_proven`。阶段事实映射为 `PUBLICATION_REVOKED`，属于干净但终局的失败：批次 `FAILED_CLEAN`，head 被烧，只能推新提交。

授权并没有被观察到变化，只是核对读不到。把这种情况和“授权确实变了”同样处理，代价是白烧一个 head。

## 决定

1. **只对这一种撤回开口子。** 撤回原因（`full_admission_not_proven` 时取端口自己的原因）属于 `withdrawnForUnavailability`，也就是撤回文字会写 “verification unavailable … no change of it was observed” 的那些原因：GitHub 500/502/503/504、无应答、`full_admission_unavailable`、Native 保护观察读不到。绑定变化、读回不一致、租约无法恢复（`lease_expired_after_write`）等仍是终局。
2. **先撤回、后重发。** 只有撤回本身已确认（PATCH 成 failure 并读回、效果记为 `revoked`）才会走到这里。撤回记录写 `republishable: true`，结局带 `republishSafe: true`。常驻层只认这个标志，从不按原因码推断。
3. **常驻层沿用现有的发布段原地重跑**（`PUBLICATION_RETRY_MS`：30 秒、90 秒、5 分钟，最多 3 次）。`publicationRetryable` 多认一种情形：`PUBLICATION_REVOKED` 且结局 `REVOKED`、`republishSafe`，且 Windows 证明齐全。和零副作用重跑共用同一个计数。
4. **重发是一次新的发布，不是重发旧的那条。**
   - 第 n 次重发（n = 1..3）有自己的效果键 `republicationKey(原键, n)`，日志记 `republicationOf`。
   - 写之前照常做完整边界：签名结果必须是原来那一份，Native 准入要新鲜，其余检查一项不少。授权真的变了，就在写之前拒绝，什么都不写。来源读不到，就以 `BLOCKED`、`safeToRerun` 结束。
   - 外部 id 沿用原检查的 id。GitHub 的必需检查、第 8 段和合并执行器都按“该角色最新的一条检查”计数，所以不需要改各处钉住的外部 id 格式。发布器自己的身份查找（`discoverKnown`、`createOrAdopt`）会跳过以前撤回的那几条（检查 id 取自 revoked 记录），所以重发时即使创建应答丢了，也能和首发一样找到新的那一条。
   - K(head, role) 保持原持有者（本地路径、原效果键），中继照旧被挡在外面。
5. **有上限。** 一个角色最多重发 3 次。第 3 次重发又因读不到被撤回，就不再带 `republishSafe`，之后再跑只会得到 `republication_limit_reached`。
6. **只用于 staged 策略（现在的生产策略）。** Native 发布（active）的账本每个作业只有一次发布，这里不重入：撤回时不标 `republishSafe`，万一走到重发，写之前以 `republication_native_unsupported` 停下。
7. 可恢复发布器（`one-shot-v2.mjs`）不在同一窗口里为重发做第二次尝试。重发的键不是原键，原键也已有记录，无副作用证明不可能成立；`BLOCKED` 原样交回，由常驻层重跑。

## 安全论证

- 重发之前，旧检查必然已经是 failure，而且读回确认过。新检查出现在旧检查之后，一切读者看的都是最新那条。
- 重发要从头证明一遍授权，和首发完全一样。现场情形是 Native 一时没答，所以可以重发；授权确实变了的情形会在写之前被拒，并且之后也不会再带 `republishSafe`。
- 上限是 3 次重跑、3 次重发，时间受发布段自身的时限约束。
- 撤回的检查还留在 GitHub 上，是一条 failure。它不会被计数，因为它不是最新的那条。

## 后果

- 现场这类情况不再烧 head：第 7 段 30 秒后重跑，以重发出绿，批次继续第 8 段。
- 第 3/5/7 段的 stage-terminal 回执的 `outcome` 多一个 `republishSafe` 字段，`publication-retry` 回执的 `failureCode` 可以是 `PUBLICATION_REVOKED`。
- 中继路径（`publishHosted`）不变。
