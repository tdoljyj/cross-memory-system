# Status24 载荷决策表 —— 执行单第 1 步交付物之一

**状态：`DECISION_TABLE_AWAITING_INDEPENDENT_REVIEW`。本表不是载荷，不构成签发。**
基准：SignedStatus23 载荷（canonical+LF = `f4002ae4…`，即 R29 死锁里被错钉的那个值）。
目标：Status24 载荷，schema `510f3b90…`，root6 代际，GRR `:349-:357` 全谓词可过。

## 顶层字段

| 字段 | Status23 值 | Status24 值 | 依据 | 裁定 |
| --- | --- | --- | --- | --- |
| schema_digest | 76bb79f7… | **510f3b90…** | :349 钉本地 schema（冻结于 68133f2d） | 定 |
| control_trust_root_generation | ctrgen_e5df… | **ctrgen_5e0440a9…** | :349 | 定 |
| generation | 23 | **24** | 序数 | 定 |
| status_manifest_id | sm_78056a94… | 新造 sm_<32hex> | :342 uri 一致即可 | 定（值签发时造） |
| as_of | 2026-09-11T05:40:27.015Z | **待定钉：新窗口内时刻** | :350 | 待 T |
| expires_at | 2026-09-11T10:21:05Z | **待定钉：新窗口 expires_at** | :350 + append A4 恰等 | 待 T |
| audience / issuer_ref / issuer_purpose / object_type / schema_version | 不变 | 不变 | :341/:349 | 定 |
| observations | 见下 | 见下 | :351-352 深等 statusExpected | 定（三代际以预留时现值为准） |
| signature_binding | root5 版 | owner_merge_commit=M3、signed_object_sha256=S24、evidence ref 新出 | :358 | 待 M3 |

## observations（:351 statusExpected 逐字段）

root_set_id / root_generation(=root6) / profile(d1c060b8) / gate(3487d9fc) /
controller(**68133f2d**) / scope(115408c6) / runner・credential・session_generation
（= `execution_current` 现值，预留前复测）/ stage_receipt_refs（= expected_ga 的，沿用）。

## source_digests 19 项（source_refs 同步替换 ref）

| # | Status23 | 语义（已逐项实测识别） | Status24 | 裁定 |
| --- | --- | --- | --- | --- |
| 1-5 | f2ec1d6c/f40c8af2/eb25e993/83814ca7/e19261b7 | GA stage receipts（与 v19 expected_ga 相同） | 沿用 | 定 |
| 6 | 115408c6 | scope | 沿用 | 定 |
| 7 | dfe6299d | v16 资格化 | **e7cfb30b** | 定 |
| 8 | 92186d46 | root5 注册体摘要 | **root6 注册体摘要** —— 取法待验证（候选 canonical `4c9fcf89…` / +LF `a93bfdda…`，须对 root5 body 复算 92186d46 定取法） | **评审** |
| 9 | bac3ff3d | 运行时代际配置提案 | 沿用或重出 | **评审** |
| 10 | bf3dcbcf | 代际配置受理 | 沿用或重出 | **评审** |
| 11 | 9a88b7cf | 配置源观测 | 沿用或重出 | **评审** |
| 12 | 3487d9fc | gate | 沿用 | 定 |
| 13 | ac7bdd53 | root5 控制器 | **68133f2d** | 定 |
| 14 | d1c060b8 | profile | 沿用 | 定 |
| 15 | 512aae74 | 容量宿主范围受理 | 沿用或重出（宿主已 Windows→Linux）| **评审** |
| 16 | d5b261ce | profile/stage 适用性受理 | 沿用或重出 | **评审** |
| 17 | 1640995831 | STATUS issuer 资格 | 沿用 | 定 |
| 18 | 1a89e43f | window9 修复 SQL（非 JSON） | **本轮对应：CP-01 apply（2e2653d2）或 043 修复 SQL** | **评审** |
| 19 | e34850ab | window9 容量修复已应用受理 | **d3f643b4（本轮 043 修复受理件）** | 定（评审复核） |

## 与 R29 修复的闭环

S24 = canonicalDigest(本载荷 减 signature_binding)+LF。受理件重钉（第 2 步）把
`late_bound_fields.status_manifest_ref.signed_payload_sha256 → S24`，即 R29 死锁的解。
:357 与 :349 由此同时可满足 —— 这次的载荷是**先造后钉**，不是从模板抄前瞻摘要。

---

# window12（root7 / F12）增补节

上表是 **root6 期**的记录，原样保留。本节只列 window12 下**变了的行**，依据见
`Status24Window12Notes.md` 与 R31 的「v2 兼容映射」。生成器已参数化：
`node build-status24.mjs --decisions decisions.final.json --pending`。

## 顶层字段

| 字段 | root6 值 | window12 值 | 依据 | 裁定 |
| --- | --- | --- | --- | --- |
| schema_digest | 510f3b90… | **7e5df5dd…** | F12 已原地实化本地 schema；受理件 `control_schema_refs.StatusManifest.sha256` 同值（:348） | 定 |
| control_trust_root_generation | ctrgen_5e0440a9… | **ctrgen_26769cc7…** | root7 代际，与受理件 `expected_ga` 交叉核对 | 定（已造未烧） |
| issuer_ref | c1749399 / 1640995831… | **28ec4cca / 3cb175ca…** | :341 钉 root.issuer_bindings[STATUS]；:317 把 STATUS 钉死为 3cb175ca | **定（#17 翻案，见下）** |
| status_manifest_id | sm_672def3d… | 沿用 | :342 仅要求 uri 一致 | 沿用（不确定点 2） |
| generation | 24 | 24 | 状态清单序数，与 root 代际无关 | 沿用（不确定点 3） |
| as_of / expires_at | 待定钉 | 待定钉 | :349 | 待 T |

## observations

`root_generation` → **ctrgen_26769cc7…**；`controller_digest` → **73c05cad…**（F12 冻结点）；
`root_set_id` / `profile` / `gate` / `scope` 不变；三代际仍为待定钉。

## source_digests：变了的四行 + 一行升为待定钉

| # | root6 值 | window12 值 | 依据 | 裁定 |
| --- | --- | --- | --- | --- |
| 7 | e7cfb30b（v19 资格化） | **15f2ee74** | root7-runtime-v20 重出件；= 受理件 `expected_ga.controller_qualification_ref` | 定 |
| 8 | a93bfdda（root6 注册体） | **待定钉：canonicalDigest(root7 注册体)** | root7 注册后才可算 | **第六个待定钉** |
| 13 | 68133f2d（控制器清单） | **73c05cad** | F12 冻结点；= 受理件 `expected_ga.controller_digest` | 定 |
| 17 | 1640995831（STATUS issuer 资格） | **3cb175ca** | :317 钉死 + :341 —— root7 下必换新件 | **定（原「定」项翻案）** |
| 19 | d3f643b4（043 修复受理） | **82e9e2f0** | 该件属 window12 九件重出集，原地重写 | 定 |

其余各行（#1-6、#9-12、#14-16、#18）沿用 R31 裁定，字节本轮实测未变。

## a93bfdda 的去向

不再是 #8 的值，转岗为 **root7 注册体的 `predecessor` 钉**
（`decisions.final.json` → `root_registration_predecessor`）。取法（canonical+LF）不随冻结点变。

## 与 R29 修复的闭环（window12 版）

S24 = canonicalDigest(本载荷 减 signature_binding)+LF，落到受理件
`late_bound_fields.status_manifest_ref.signed_payload_sha256`（v20 重出件里现为
`__PENDING_STATUS24_PAYLOAD_SHA256__`）。**window12 下受理件按 F12 重出而非重钉** ——
`repin-acceptance.mjs` 转岗为谓词自验/判别器库（R31 v2 映射钉 4），本轮未改。
