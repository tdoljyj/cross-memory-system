# 第 11 代（generation 11）签发文档

第 10 代 `ctrgen_48100437…` 已于 2026-09-16T03:00:00Z 过期，attempt 停在 `SIGNING`。
本目录是第 11 代的签发文档，用于在新窗口内完成 Phase 2 派发链并产出终局收据。

## 参数

| 项 | 值 |
| --- | --- |
| 代次 | `ctrgen_c725e90a595c00a041754ede3b00f408` |
| 后继绑定 | `sb_873f7cf2f79fb3cb168138441e6fddbc` |
| 窗口 | 2026-09-16T04:00:00Z → 2026-09-23T04:00:00Z（7 天） |
| 控制器 | `89710145b27872314cd666b1ff5491d72b4193730d1b6ff3038a9baefb4664c0`（沿用，不换） |
| 资格摘要 | `1d44c7d3fc0cb7e7f3e1bbbb1b604401d4f0bb1d288dddeef0c49f6aca1c1f0f` |
| 验收摘要 | `2638d1364046b8d72ebd233b49b3b7efb41397d166048c2e1a7cc93c632261ab` |

窗口改为 7 天：`register_successor_binding` 只要求 `expires_at > max(now, not_before)`，
控制库对窗口长度没有上限，24 小时是此前的文档策略而非技术限制。

## 相对第 10 代的改动

**ControllerQualification.root11.json** — `generation_id`、`predecessor_generation_id`、窗口。

**RuntimeAcceptance.root11.json**
- 窗口与 `accepted_at`
- `expected_ga.control_trust_root_generation` → 第 11 代
- `expected_ga.controller_digest` → `89710145…`
- `expected_ga.controller_qualification_ref` → 本代资格
- **删除 `scope_amendment` 描述符**

后两条是同一个决定的两面。控制器把范围修正案的身份写死在
`root10-single-window.mjs` 的 `root10ScopeIdentity` 里（GA id、修正案摘要、激活序号 120、
预算摘要、绝对时刻），只认第 10 代那一份；新代次带任何修正案都会在
`EXACT_SCOPE_ACTIVATION_CONTRACT` 被拒。因此第 11 代不带修正案，
GA 窗口直接承担 600 秒授权，`controller_digest` 也就必须直接等于当前绑定的控制器
（第 10 代写的是更早的 `d01bd55e…`，靠修正案往前推）。

适用测试集仍是 PQUAL-11/13/15/16/17：这五项由控制器 `grr.mjs` 硬编码、
套件本身也只有这五项，不依赖修正案事件。

**Root11SigningPayload.draft.json** — 代次、序数 11、窗口、前代引用、history、revocation。

## 根载荷的签名在数据库，不在文件里

与第 10 代一致：`Root11SigningPayload.json` 是**未签名载荷**，不含 `signature_binding`。
控制器的校验是 `signaturePayloadDigest(root) === canonicalDigest(已发布文件)`，
其中 `signaturePayloadDigest` 正是"根对象去掉 signature_binding 后的规范摘要"。

签名绑定存在**数据库根事件的 body** 里，包含 `owner_merge_commit`、
`signature_evidence_ref` 与 `signed_object_sha256`。因此顺序是：

1. 合并本 PR → 得到 merge commit 与文件 blob
2. 由 Owner 出具签名证据 blob（记录该 merge 与 payload 的 blob/file 摘要）并发布
3. 注册第 11 代时，根事件 body = 本载荷 + 上述 signature_binding

**合并本 PR 是第 1 步，文件保持未签名是正确状态。**

## 执行方式

不带修正案意味着整条链必须在 GA 自己的 600 秒窗口内完成
（Profile 将 GA 寿命封顶在 600 秒，PASS 还要求 `now < deadline`）。
容器不必跑满 600 秒，实测预算：

```
CREATE + START + 容器 120s + 停机 + 决定签名   约 170s
构建收据 + 提交承诺 + GRR                     约 95s
合计约 265s，余量约 335s
```

GRR 在 `commit_gate_result` 之前的失败不写库，因此余量可用于重试。
真正一次性的只有 CREATE、START 与最后的终局提交。
