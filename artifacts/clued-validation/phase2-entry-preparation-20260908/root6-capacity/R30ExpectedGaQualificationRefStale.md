# R30 —— 受理件 expected_ga.controller_qualification_ref 错钉（与 R29 同修）

**状态：`FINDING_ONLY`。发现于执行单第 1 步（Status24 生成器 :353 自验首跑）。**

【实测】活绑定受理件（fb389314）的
`accepted_subject.expected_ga.controller_qualification_ref.sha256 = 6e35ff20996e…`，
而活绑定 `qualification_sha256 = e7cfb30b…`（第 20 次前推钉入，= main@M2 的 v19 资格化字节）。

后果：GA 的 `controller_qualification_ref` **不在** `checkFixedGAFields` 的 varying 豁免集
（context.mjs:36），必须与 expected_ga 深等 → GA 带 `6e35ff20` 则 `:70`
`ga.controller_qualification_ref.sha256===binding.qualification_sha256` 炸；带 `e7cfb30b`
则 `EXACT_ACCEPTED_GA_FIELD` 炸。**step17 GA 签发两头堵 —— 若昨夜选乙硬冲，死点在此。**

成因：资格化件字节在 R24 之后又动过一次（A 曾把 ref 重钉到 ee08e48e，随后 R24-F2 记录
使资格化字节再变为 e7cfb30b），expected_ga 的 ref 未随最后一动。与 R29 同根：受理件的
前瞻字段没有一张 to_accept 清单覆盖。第十四例。

附带观察：`expected_ga.stage_receipt_refs[2] === [3]`（eb25e993 重复）——不炸任何现行
谓词，受理件重钉时一并裁。`authority_source_ref = 92186d46`（root5 注册体）—— root6 语义
待裁。

修复：并入 R29 的受理件重钉（下一窗口执行单第 2 步），Status24 生成器已以
`expected_ga_overrides` 显式接收重钉后的期望值（绝不静默修正）。

## 更正（2026-09-13，R31-F1）

R31 独立评审证伪了本记录的核心断言：6e35ff20 **不在**活绑定受理件字节（fb389314）内 ——
main@M2 的 fb389314 字节中 `expected_ga.controller_qualification_ref.sha256` 已是 e7cfb30b。
本记录当时实测的对象是**分支上的陈旧工作副本**（sha256 775fd644，build-status24.mjs:17
所读路径），不是活字节。「测了，但测错了对象」—— 与第十四例同族的对象选择错误，记为本记录
自身的缺陷。结论修正：受理件无需改 controller_qualification_ref（重钉工具改为断言 no-op），
重钉/重出基底必须显式取 fb389314 活字节并拒收 775fd644（R31 的 NC5 负控制）。
生成器的 expected_ga_overrides 机制保留 —— 它抓到的「不一致」是真的，只是不一致的元凶是
本地副本陈旧，不是活件有钉待换。
