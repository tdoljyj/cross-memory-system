# F12 钉位清单 —— context.mjs 全部 window12 必改字节（grep 实测，2026-09-13）

root7 代号（已造，注册时才烧）：`ctrgen_26769cc7109ced40bc4016b2af678198`

| 行 | 现值 | F12 值 | 何时可定 |
|----|------|--------|---------|
| :15 `generation` | ctrgen_5e0440a9… | ctrgen_26769cc7… | 现在 |
| :18 `qualificationLimits.forwards` | 16 | 17 | 现在 |
| :191 `root6Expiry` | 2026-09-13T07:05:16Z | M3 committed_at+86400s | **M3 后实化** |
| :191 追加 | — | root7Generation 常量 + root7BudgetSequence 阈值 | 阈值=90 可现在定（第 9 次预算必 ≥90，budgets 1-8 全 ≤89 —— F12 时以活库复核）|
| :194/:195 | root6 分支封顶 | 追加 root7 分支（sequence>=90）| 现在（复核后）|
| :207/:226 | 经 root6Expiry | 随 :191 值动 | M3 后实化 |
| :208 `root6Generation` 连续性 | root6 | root7 注册后新执行的 root.generation_id=root7 → 需 root7 常量 | 现在 |
| :317 issuer 摘要×2 | root5 代已过期件 | 新 issuer 件（绑 root7、新窗）digest | 件体窗口 M3 后实化 → digest 随之 |
| :43 | 经 root6Expiry | 随 :191 | M3 后实化 |

**结论：M3 后只剩「时间戳字符串替换 + issuer 件 digest 重算 + manifest 重建」三步机械动作，
其余全部现在完成。实化脚本（realize-f12.mjs）为唯一 M3 后入口，替换计数逐一断言。**

未尽事项（F12 动手时以活库逐条复核，不得凭本表直接改）：
- budgets 1-8 的实际 sequence 上界（阈值 90 的前提）
- :208 在 root7 注册前的过渡期语义（forward 21 在注册后执行，root 已是 root7 → 一致）
- 其余 2026- 字面量仅 :158 注释（非钉）
