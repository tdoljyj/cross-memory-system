# ADR 0007：合入闸门 strict 永久开，合并方式只留 merge

- 状态：生效
- 日期：2026-11-07
- Owner Decision：
  - `9e2511fe`：合入闸门——strict 永久开、只留 merge；全量扫描降为可选后台审计；不做换名；长远走 bors 式。
  - `78a3052f`：细节——main 改写时仍冻结；重新启用合并执行器，只给落后的车头做 update-branch；装机策略显式写 `sweep=audit`。
- 实施：Task `40f0dfb7`，分支 `claude/train-strict-permanent`，提交 `c933238b5`
- 档案：DESIGN §65

## 背景

原列车设计（DESIGN §41）要在开车后关掉规则集的 `strict`（"分支必须最新"），以免每次 main 移动都逼所有 PR 合 main。

strict 关着时，一条旧绿可能让一棵没测过的树合进 main。为此需要"单绿"，再加上"全量清扫撤旧绿"，而全量清扫一轮要几个小时。2026-11-07 一天之内装了 7 次包，每次都把扫描进度清零（Task `17ad69c2`），开车反复被挡。

## 决定

1. 规则集的 `strict` **永远开着**，合并方式只留 merge。
2. 列车策略新增 `train.sweep`，取值 `gate` / `audit` / `off`，默认 `audit`：
   - `audit`：接管不再等全量扫描，全量扫描每天最多一轮，作后台审计；
   - `off`：同 `audit`，但不跑全量扫描；
   - `gate`：旧行为，保留为回退。
3. 第 8 段只走"当前车头的 strict 路径"（`strictFrontHeadDecision`），要求实时读到 strict 为真。
4. strict 被关时，整个系统停下：
   - 第 8 段不发绿；
   - 第 10 段报 `TRAIN_STRICT_OFF`，并锁 PAUSE；
   - companion 兜底立即写暂停请求，备用节点也暂停。
5. main 被改写时，仍冻结到一轮 scope all 扫完（`78a3052f` 第 1 项）。
6. 不做检查名换代；"升级沿用扫描进度"（`57975737`）作废。

## 理由

- strict 开着时，GitHub 只合入已经包含 main 尖端 T 的 H。这时 merge(T, H) 是没有额外改动的三方合并，合出来的树就是 H 的树，所以**测什么就落什么**。
- 旧绿也无害。一条旧绿挂在某个 H 上，测的是当时的 main 尖端 T′。H 不可变；它今天包含 T，T′ 是 T 的祖先，所以它当时也包含 T′，当时测的树就是 H 的树。
- 因此，"除车头外不能有别的绿"和全量清扫都不再是安全前提。第 8 段的其他实时检查一条都没有放宽。

## 后果

- 装包不再清零任何前提，开车也不再被全量扫描挡住。测试里开车后约 180 秒（模拟时间）出绿。
- 车头落后 main（BEHIND）时 GitHub 不会合入，需要有人把 main 合进 PR。
  - 现在：由持有者自己合，PR 页面提示 `FRONT_NEEDS_MAIN_MERGE`。
  - 已决定、尚未实现：重新启用合并执行器，只给 BEHIND 的车头做 update-branch，受保护层暂不自动更新。它用 clued-admission App 5164952，这个 App 已有 `contents: write`。
- 每次 main 移动，后面的 PR 都要合一次 main。这是 strict 的固有代价，长远由 bors 式列车解决（[ADR 0010](0010-bors-preauthorized.md)）。
- 回退：一次 UAC 把策略写成 `train.sweep: "gate"`。
