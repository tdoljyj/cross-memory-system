# 第 11 代（generation 11）签发文档

第 10 代 `ctrgen_48100437…` 的终结期限 2026-09-16T03:00:00Z 已过，那一轮的 attempt
停在 `SIGNING` 且再也出不了收据。一次性迁移已把它落为 `STALE`、释放 active 槽位、
计数器分文未动，控制库现在停在执行序号 **131**，基线 attempt 共 **18** 个。
本目录是第 11 代的签发文档，用于在新窗口内完成 Phase 2 派发链并产出终局收据。

## 参数

| 项 | 值 |
| --- | --- |
| 代次 | `ctrgen_c725e90a595c00a041754ede3b00f408` |
| 后继绑定 | `sb_873f7cf2f79fb3cb168138441e6fddbc` |
| 窗口 | 2026-09-16T04:00:00Z → 2026-09-23T04:00:00Z（7 天） |
| 控制器 | `fc6ca1759ef68a958564bd2d9fc16aab23297c2db30ac7581b4ec6227977c91f`（**新签**） |
| 控制器源提交 | `55fd9732cbec0994ceb699a3e3f8985e79d7647c` |
| 控制器合同 | `82417308ccffaf949f3d885d4b040cfe18cf45c1bf1a5cacbbf4dd67fb1214da` |
| 资格摘要 | `ef6a6db15dce4155e020198dcfc81e57b691624aa7dd9072d2349903da7e1f46` |
| 验收摘要 | `1ca99743e2971de9cf60c71162799d28705ec6803f7c3fa2825a8be46a8935b0` |
| 基线执行序号 | 131 |
| 本代预算事件序号 | 136 |

窗口 7 天：`register_successor_binding` 只要求 `expires_at > max(now, not_before)`，
控制库对窗口长度没有上限，24 小时是此前的文档策略而非技术限制。

## 为什么必须换控制器

早先的清单写过"第 11 代沿用第 10 代控制器，只改合同 JSON"。**那是错的。**

`root10-single-window.mjs` 的 `validateRoot10ControllerContract` 把代次相关的库状态
当作源码常量写死——`generation_ordinal===10`、`baseline.execution_sequence===112`、
`attempt_ids.length===17`、`charged_seconds===11106`、`caps.allocations===11` 等共 11 处。
合同 JSON 必须逐字等于它们，否则连 schema 校验都过不去。所以换代次 = 改源码 = 新控制器摘要。

改动只集中在这一个函数：

```
ordinal 10 → 11              root_sequence 9 → 10        execution_sequence 112 → 131
attempt_ids 17 → 18          charged 11106s → 11706s     charged bytes 2470030259 → 2604247987
allocation_count 10 → 11     historical_budget_count 16 → 17
caps 11/11706/2604247987 → 12/12306/2738465715
```

`series_forward_count` 仍是 17（第 10 代没有新增 forward），`caps.forwards`、`fixed_digests`、
`accepted_suite`、`reviewer_delegation`、`source_closure`、`invariants` 全部不变。

**不需要改的部分**：三个修正案身份（`root10TemporalIdentity` / `root10RuntimeClockIdentity` /
`root10ScopeIdentity`）里写死的 GA、事件序号 117/118/119/120 与计数器，只在对应 descriptor
存在时才会被读到；第 11 代不带任何修正案，这些路径整段跳过。
`checkRoot10SingleWindowSeries` 里的 `slice(0,110)`、`expected_sequence===110/111`、
`closure.budget_sequence===102`，指的都是第 9 代不会再变的历史，原样保留。

## 相对第 10 代的文档改动

**ControllerQualification.root11.json** — 代次与窗口；`controller_digest` 与
`controller_source_manifest_ref` 指向新控制器；`predecessor_controller_digest` 改为第 10 代
实际绑定的 `89710145…`；`first_budget_sequence` 117 → 136；
`amendment_ref` / `amendment_object_type` 置为 `null`（本代无修正案）；
`source_publication.owner_merge_commit` 暂为 `__OWNER_MERGE_COMMIT__`，合并后回填。

**RuntimeAcceptance.root11.json** — 窗口与 `accepted_at`；
`expected_ga` 的代次、`controller_digest`、`controller_qualification_ref`；
`expected_ga.source_ref` 重建到新控制器源提交（36 条 blob：清单自身 + 清单声明的 35 个文件，
顺序沿用第 10 代成例并已逐条复现验证）；`late_bound_fields.status_manifest_ref` 指向新 Status
规范摘要；`root10_single_window.contract_ref` 指向新合同；
**不带 `scope_amendment` / `runtime_clock` / `temporal_continuation` 任何描述符**。

**Root11StatusManifest.json** — `observations.controller_digest`、`source_digests`、
`source_refs` 全部指向新控制器清单。

**OwnerApproval / IndependentAcceptance** — `unchanged.controller_sha256` 改为新控制器；
判词补记本轮实际复核过的四条。

适用测试集仍是 PQUAL-11/13/15/16/17：这五项由控制器 `grr.mjs` 硬编码、
套件本身也只有这五项，不依赖修正案事件。

## 验证过什么

- 两个历史摘要算法先用第 10 代已知值自检：`canonicalDigest(执行事件 1..110)` 复现 `715256b0…`，
  第 10 代 `other_attempts` 复现 `9d7fff4c…`
- `source_ref.blobs` 的构造以第 10 代的 34 条**逐条逐序**复现
- 根前缀摘要 `d4c85212…` 由两条独立路径算出并一致（合同侧与根载荷侧）
- `checkRoot10SingleWindowSeries` 以迁移后的**真实** `read_execution()`（序号 131）
  加模拟的注册/预算/GA 通过，`baseline_attempts: 18`
- 控制器自测：单窗口 20/20、运行时钟 16/16、范围修正案 38/38

`selftest-runtime-pins.mjs` 与 `check-digest-pins.mjs` 在 Windows 主机上因缺少
`/usr/bin/python3.11`、`/opt/node22/bin/node`、`/usr/bin/docker`、`/usr/local/bin/gh`
而无法运行，须在 Linux 控制器镜像内复核。

## 根载荷的签名在数据库，不在文件里

与第 10 代一致：`Root11SigningPayload.json` 是**未签名载荷**，不含 `signature_binding`。
控制器的校验是 `signaturePayloadDigest(root) === canonicalDigest(已发布文件)`，
其中 `signaturePayloadDigest` 正是"根对象去掉 `signature_binding` 后的规范摘要"。

签名绑定存在**数据库根事件的 body** 里，包含 `owner_merge_commit`、
`signature_evidence_ref` 与 `signed_object_sha256`。

本轮换控制器改了 `OwnerApproval` 与 `IndependentAcceptance` 的字节，
因而 `owner_approval_ref` / `independent_acceptance_ref` 变了，载荷也就变了。
**此前为旧载荷生成的 `Root11SignatureEvidence.json` 已不再对应，本 PR 删除它**，
待新载荷合并后重新出具——留着一份对不上号的签名证据比没有更糟。

## 发布顺序

1. **本 PR**：控制器源码 + 全部第 11 代文档（资格里的 merge commit 为占位符）→ Owner 合并，得 M1
2. **回填 PR**：把 `__OWNER_MERGE_COMMIT__` 换成 M1 及其 tree，级联重算资格→验收→Status→
   批准→送审→验收判词→载荷 → Owner 合并，得 M2
3. 对 M2 出具签名证据 blob 并发布
4. 注册第 11 代：根事件 body = 本载荷 + 上述 `signature_binding`；两处 CHECK 约束与
   `generation_pins` 一并落库
5. 分配预算（136 号事件）→ 签发 GA → 派发链 → 终局收据

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
