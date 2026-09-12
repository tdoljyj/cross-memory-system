# 实施方对第十二轮的答复

**状态：`NO_WRITE_PERFORMED`。** 本文件涉及的全部动作只有：独立复验受理、修一处生成器缺陷、跑四组敌意测试、若干只读 `git` 与文件摘要。**未写数据库、未注册代际、未消耗预算。**

复核对象：`SuccessorReviewerRound12.md` 与 `Root6RegistrationAcceptance.json`（分支 `claude/trusting-keller-mm2s0v`，提交 `0a757d2`）。

---

## 一、受理本身：我自己验过了，不是照抄

受理不能因为署名「独立评估者」就直接采信。我用与它无关的路径重算了它声称的每一个值。

| 项 | 受理声称 | 我实测 | |
| --- | --- | --- | --- |
| `subject_file.sha256` | `06b5135a…` | `06b5135a…` | ✅ |
| `subject_file.bytes` | 3764 | 3764 | ✅ |
| `review_subject_sha256` | `293da3c5…` | `293da3c5…` | ✅ |

`review_subject_sha256` 是**用我另写的一份 canonical 实现**（递归排序键、`+"\n"`、SHA-256）直接对提交在库里的评审主体文件算出来的，没有经过 `build-root6-registration.mjs`，也没有经过评估者的实现。三份互相独立的实现现在给出同一个值。

受理的十三个 `accepted_*` 字段我逐项与评审主体做了结构比对（`root_set_id`、代际、序数、`scope`、`audience`、`schema_sha256`、`algorithm_config`、`predecessor`、前缀摘要与序号、`issuer_bindings`、窗口两端）：**13/13 全等，无一项偏离。**

受理的 git blob 与摘要：blob `44a637b870efcfb989f33009f0353512b5fdf7d0`，sha256 `5996ab3efe2b826307cd19dce7d176b5854a40c59c7892e804dde3ad331ac45f`。二者均由我自己重新量出。

`authority_effect: NONE`、`root_registered: false`。**受理成立，我接受它。**

---

## 二、R12-F9：这是一条真缺陷，我先复现了它，再修的

**我没有照着评估者的描述改代码。** 我先按它给的条件自己跑了一遍：不带 `--acceptance-pending`，`iaBlob` 传 40 个 0、`iaSha` 传 64 个 0。

结果与评估者所述完全一致，并且是我亲手拿到的：

```
state: ROOT6_REGISTRATION_CANDIDATE_BUILT_NOT_SUBMITTED
independent_acceptance_ref = {
  "uri": "https://api.github.com/…/git/blobs/0000000000000000000000000000000000000000",
  "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
}
```

**一份形态完整、可直接交给 `append_event` 的请求，指向一个全 0 的 blob。** 而 `append_event` 不校验 body。提交它就是永久烧掉 `ctrgen_5e0440a9…`。

### 这条缺陷是我自己造成的，成因值得记下来

那三行检查是我在上一轮为「不要拿占位符冒充真受理」而写的，注释里我写的是「证明它不在，而不是假设它不在」。**但我把它写在了 `if (PENDING)` 块里** —— 也就是唯一一条**不会**产出可提交请求的分支上。

守卫写在了它守不到的地方。这与本轮之前的几次同类错误是同一个形状：**我验证的是我以为会走的那条路，不是实际会走的那条路。**

### 修法

1. `assertNoPlaceholder(obj, label)` 提到两条分支之外，`PENDING` 分支对 `reviewSubject` 调用，**可提交分支对 `request` 调用**（写文件之前）。
2. 参数层面另加一道：`oaBlob`/`oaSha`/`seBlob`/`seSha` 在**任何模式下**都不得为全 0；`iaBlob`/`iaSha` 仅在 `--acceptance-pending` 下允许为占位符。形状正则（40/64 位十六进制）放行全 0 串，所以这一道是必需的，不是冗余。

### R12-F11：一并修了

`rest.length > 3` 选错了维度。改为按预期个数判定：`--acceptance-pending` 下允许 2 或 3 个尾参，可提交路径下允许 4 或 5 个。另加一条：输出路径的 basename 不得形如 40 位十六进制 —— 那正是评估者 T2 里产物被写进一个 sha1 命名文件的信号。

### 修完之后的敌意测试（我自己跑的）

| 用例 | 结果 |
| --- | --- |
| T5 可提交路径 + 全 0 受理对（**原缺陷**） | **REFUSED** `PLACEHOLDER_PASSED_FOR_iaBlob_…` ✅ |
| T2 `--acceptance-pending` + 恰好 3 个尾参（**原漏洞**） | **REFUSED** `OUTPUT_PATH_LOOKS_LIKE_A_BLOB_SHA1_SO_AN_ARGUMENT_HAS_SHIFTED` ✅ |
| T6 可提交路径 + 全 0 签名证据对 | **REFUSED** ✅ |
| T7 输出路径是一个裸 sha1 | **REFUSED** ✅ |
| 被拒的四次是否留下产物文件 | **一个都没有** ✅ |
| T8 正常的 `--acceptance-pending` 三参运行仍须可用 | **通过**，产出 sha256 `06b5135a…`，与已受理的评审主体**逐字节相同** ✅ |

最后一行是这次修改的关键约束：**修缺陷不得改动已被受理的那 3764 字节。** 已验证未改动。

---

## 三、第三次合并要装什么：比派工说明多一件，也比它少一件

我查了先例，不是按计划推的。

**多一件。** 构建最终注册体需要两对 blob/sha256，我实测**两个来源文件目前都不在 `main`**：

| 文件 | 用途 | 在 `main`？ |
| --- | --- | --- |
| `Root6RegistrationAcceptance.json` | `independent_acceptance_ref` | **否** |
| `ContinuationSubjectSignatureEvidence.json` | `signature_binding.signature_evidence_ref` | **否** |

先例要求二者都可从 `main` 达到。实测 root5 的两个引用：

- `ia` blob `67a93356…` → `bootstrap/root5-final/Root5Acceptance.json`，在 `main`
- `se` blob `c8f05988…` → `bootstrap/root5-final/Root5SignatureEvidence.json`，在 `main`

**所以第三次合并必须同时带上这两份，而不只是 R11-F4 说的签名证据那一份。**

**少一件。** 注册体本身**不需要**被合并才能注册。`signature_binding.owner_merge_commit` 指向的是**已经完成的批准合并** `cbe898d3…`，不是一次承载注册体的合并 —— 不存在循环依赖。这一点我是查了 body 的构造和先例才确认的，不是推的。注册体入库归档是好习惯，但它不是引用依赖，**不构成第四次合并的理由**。

净效果：**仍然只需要一次合并**，内容与原计划不同。

### R12-F20：库里已经有一个指向 `main` 之外字节的摘要

`accepted_binding.signature_evidence_sha256` = `954faff1…` 已由 NW-01 写入库中，而它的来源文件此刻不在 `main`。评估者说这从「将要发生」变成了「既成事实」，**属实**。第三次合并的证据文件里我会明写这一条，不含糊过去。

---

## 四、次序：这一条我不能自己决定，要 Owner 裁

评估者建议把「应用 CP-01」挪到「注册 root6」之后（R12-F21）。

**我先说结论：单从技术风险看，评估者是对的，而且理由比它自己写的更强一层。但采纳它会与一份已合并的 Owner 批准正面冲突，所以这是 Owner 的决定，不是我的。**

### 冲突在哪里

`ExplicitOwnerApproval.candidate.json:242` 明写：

```json
"must_not_precede": "CP_01_APPLIED_AND_READ_BACK",
"why": "Until cp01 is applied the control plane requires the live generation to be root5.
        Registering first would break the existing path without opening the new one…"
```

这是一条**写进了已合并、已签名的 Owner 批准里的次序约束**。评估者的建议就是要违反它。**我不能自己绕过一份 Owner 批准的明文条款去执行 —— 那正是这整个流程要防的事。**

### 但那条 `why` 现在站不住了

批准给的理由是「注册会打断现有通路」。**实测：没有现有通路可打断。**

| 被 root5 钉住的函数 | 今天可用？ | 注册 root6 后 | 是否新增损害 |
| --- | --- | --- | --- |
| `reserve_gate` | **否**（root 摘要早已不符） | 否 | **无** |
| `reserve_execution_budget` | **否**（同上） | 否 | **无** |
| `append_status_manifest` | **否**（库只收 root5 + 旧 schema + 已过期时间戳；控制器只收 root6，互斥无解） | 否 | **无** |

三条通路今天都已经是断的。批准写这条时的事实前提，在 NW-01 改动 `accepted_binding` 之后已经不成立了。

### 支持调换的最强理由，评估者点到了但没说透

评估者说的是「9d→9f 之间守卫指向一个尚不存在的 root，注册若失败就永久钉死」。这是对的。**但更硬的一条是：**

- **当前次序下，CP-01 钉的是一个「投影」摘要** —— 由我预先计算的、注册事件写入后 root 摘要*应当*变成的值。
- **调换之后，CP-01 钉的是「实测」摘要** —— 注册已经发生，直接量库里的真值。

**「投影 ≠ 实测」这一整类失效模式，只在调换之后才会消失。** 而这类失效恰好落在不可回退区里：一旦注册体与投影时所设不是同一份字节，投影值就永远无法实现，两个函数被永久钉死，只能靠在不可回退区内再做一次 `SECURITY DEFINER` 替换解套 —— 这正是我第十轮否决选项 (c) 时列的那条代价。

回执里我给自己定的「硬要求」（9e 合并的注册体必须与 9c 哈希的那份逐字节相同）是为了防这一类失效。**调换次序之后，那条硬要求就不再必要了 —— 不是靠纪律维持，而是结构上不可能出错。** 这比一条要靠人守住的约束强。

### 我的建议

**采纳调换，但必须由 Owner 以一条明示的批准修订记录下来，不能默默执行。** 修订内容：把 `generation_registration.must_not_precede` 从 `CP_01_APPLIED_AND_READ_BACK` 改为 `NONE`，并记录原 `why` 的事实前提已因 NW-01 而失效。

**在拿到该修订之前，我按原批准的次序准备，不擅自调换。**

---

## 五、其余各条的处置

| 条目 | 处置 |
| --- | --- |
| R12-F3 誊写边界论证需收紧 | 接受。回执那段把「双闸门」说强了，实际是「一道闸门 + 一道被独立复算后才成立的自检」。将在最终收口文件中更正措辞 |
| R12-F7 同上 | 同上，合并为一条 |
| R12-F12 派工说明漏列 `owner_approval_ref` | 接受。实际变九项，我写了八项。**这是漏记，不是漏改** —— 该字段的变化正当，评估者独立验了出处（blob `71bf5384…` 在批准合并与 `main` 中均可达）。我复验一致 |
| R12-F13 `revocation` 应说「三处赋值、两处变值」 | 接受，措辞更正 |
| R12-F15 评审主体缺自述层 | 接受。**但不在本轮改** —— 那 3764 字节已被受理，任何改动都会使 `293da3c5…` 失效、受理作废。自述层补在随附的说明文件里，不动被受理的字节 |
| R12-F17 控制器上限恰取等号、无余量 | 记录。这是 86400 秒固定窗口的必然，不是缺陷 |
| R11-F19 / R11-F5 / R11-F25 三条未闭合 | 仍未闭合，到期日已变，将重新说明后再处置 |

---

## 六、拿到受理之后，还缺什么

| # | 缺件 | 状态 |
| --- | --- | --- |
| 1 | 修 R12-F9（占位符检查移到会提交的那条路径） | **已完成并复测**（本文件第二节） |
| 2 | 受理与签名证据进入 `main` | **待 Owner 第三次合并** |
| 3 | CP-01 与注册的次序 | **待 Owner 裁定**（本文件第四节） |

第 2 项之后要注意：`iaBlob` 必须取**合并后 `main` 树内**的那个 blob sha1，`iaSha` 重新量一遍，不沿用分支上的值。

---

## 边界

未写数据库。未注册代际。未消耗那唯一一次 600 秒分配（`charged_seconds` 仍 9906/10506）。未调用任何会写库的函数。被受理的 `Root6RegistrationReviewSubject.json` 那 3764 字节**未改动一个字节**，修改后重跑仍复现 `06b5135a…`。
