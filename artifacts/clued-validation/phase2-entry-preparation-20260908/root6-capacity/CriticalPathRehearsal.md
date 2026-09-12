# 空跑：控制器重建与七份文档换发，两个脚本第一次真的跑过

**状态：`REHEARSAL_ONLY_NO_WRITE_PERFORMED_NOTHING_COMMITTED_TO_THE_REPOSITORY`。**

**未写库、未注册代际、`charged_seconds` 仍为 9906/10506。产物全部写入会话临时目录，仓库零改动。**

运行手册第 3、4 步（`rebuild-controller-window11.mjs`、`reissue-seven-documents.mjs`）
位于 Owner 第一次合并之后的 24 小时窗口里，是关键路径，
**在此之前从未真正执行过一次。** 合并之后再发现问题就是在啃时钟，所以先用排练窗口空跑。

排练窗口：`now-100s .. now+86300s`（恰好 86400 秒，模拟一次刚刚发生的 Owner 合并）。

---

## 一、结果

两个脚本均 exit 0。

| 步骤 | 结果 |
| --- | --- |
| 控制器重建 | 331 条清单：**17 条重指向、4 条重算、314 条原样携带** |
| 产物 | 17 个控制器文件 + `ControllerSourceManifest.candidate.json` |
| 七份换发 | QUAL、RTA 移入 `bootstrap/root6-runtime-v18/`；PROP、APPR、APPL、REPR 原地重写 |
| 仓库 | `git status` 空 |

## 二、四项独立验证（不采信脚本自己的报告）

1. **manifest 自摘要**：重建产出的 manifest 文件实测 sha256，与换发脚本消费的
   `new_controller_sha256` 逐字相同。
2. **陈旧摘要扫描**：24 个产物 × 14 个前代摘要（7 份文档的 sha256 与 git blob sha1），
   命中 10 处。**逐个定位到 JSON 路径后，10 处全部落在 `supersedes` / `reissue.supersedes` 上**
   —— 按设计就该指向前一版。**真正陈旧的交叉引用：0 处。**
   （先看命中数就下结论会得出相反的判断。定位到路径才是判据。）
3. **前向引用**：凡按 path/uri 指名那七份产物之一的引用共 **14 处**，逐条比对：
   前向引用带新摘要、`supersedes` 带前代摘要、无一处指向自己。**14/14 正确。**
4. **残留字面量**：`2026-09-12T13:14:51Z` 0 处、`root6-window10-successor` 0 处、
   `2026-09-19T00:00:00Z` 1 处——在 `.reissue.reason` 的说明文字里（解释换发原因），不是活常量。

## 三、空跑抓到的两件事

### （1）换发脚本要求签发时刻落在它声明的窗口内

```js
assert.ok(Date.parse(newNotBefore) <= now.getTime() && now.getTime() < Date.parse(newExpiry),
  'DOCUMENTS_MUST_BE_ISSUED_INSIDE_THE_WINDOW_THEY_DECLARE');
```

第一次空跑就撞在这上面（我给的 `not_before` 是未来时刻）。真实运行时 T 是已发生的合并时刻，
自然满足。**不是缺陷，是正确行为**，但含义要说破：**这一步必须在那 24 小时之内跑完，
窗口耗尽后脚本会拒绝**，而不是产出一份声明着过期窗口的文档。

### （2）一处带日期的定时地雷，已拆除，并顺带堵上一个洞

`rebuild-controller-window11.mjs` 原本断言：

```js
assert.ok(Date.parse(newExpiry) < Date.parse(OLD_EXPIRY),   // OLD_EXPIRY = 2026-09-19T00:00:00Z
  'NEW_EXPIRY_MUST_NOT_EXCEED_THE_UNSATISFIABLE_ONE_IT_REPLACES');
```

它想表达的是「新窗口必须是机制能产出的值」，却写成了「必须早于那一个特定的不可产出值」。
两个后果：

- **地雷**：Owner 若在 `2026-09-18T00:00:00Z` 之后才合并，T+24h ≥ `2026-09-19`，
  **整条流水线在第 3 步就拒绝运行**。没有任何文档写过这个耦合。
- **洞**：`2026-09-15T00:00:00Z`（三天后，窗口规则永远产不出）当时会被**接受**。
  边界只挡住了 09-19 之后，没挡住 24 小时到 7 天之间的任何值。

改为按机制本身断言，不含任何日历日期：

```js
assert.notEqual(newExpiry, OLD_EXPIRY, 'NEW_EXPIRY_MUST_NOT_BE_THE_UNSATISFIABLE_VALUE_IT_REPLACES');
// 本脚本在第 3 步运行，即 Owner 合并定下 T 之后，故 T <= now；
// 窗口规则唯一能产出的 expiry 是 T+86400s，因此它距 now 至多 86400 秒。
assert.ok(Date.parse(newExpiry) - Date.now() <= 86400000,
  'NEW_EXPIRY_MUST_BE_AT_MOST_86400_SECONDS_AWAY_OR_IT_DID_NOT_COME_FROM_A_VERIFIED_MERGE');
```

实测四个取值：

| 传入 | 改前 | 改后 |
| --- | --- | --- |
| `now+86300s`（机制能产出） | 接受 | 接受 |
| `2026-09-15T00:00:00Z`（3 天后） | **接受** | 拒绝 |
| `2026-09-19T00:00:00Z` | 拒绝 | 拒绝（按名字） |
| `2026-09-20T00:00:00Z` | 拒绝 | 拒绝 |

新边界**比旧的更紧**，且与 `reissue-seven-documents.mjs` 的窗口断言同源
（两者现在都只依据「T 在过去、now 在窗口内」这一条事实）。

## 四、仍未验证的部分

- 排练用的是**编造的窗口**。真实 T 只有合并之后才存在，届时这两步要重跑一遍，
  产物摘要与本文所列**全部不同**（本文任何摘要都不得被当作预期值沿用）。
- 187 项 runtime dependency 由 manifest **原样携带**，本次空跑没有、也无法重新校验它们。
  它们已在 `ControllerDigestHostVerificationClosed.md` 中于那台 Windows 主机上 187/187 验过；
  运行手册要求第二次合并前**再验一次**，该要求不因本次空跑而解除。
- 换发产物的**目录归属**（QUAL/RTA 移入 v18、四份容量文档原地）是实施方的判断，
  脚本自己在 `for_review.placement` 里标了出来，仍待评估者确认。
- 评估者提出的「第八份文档」推回意见仍未闭合。

---

## 边界

未写库、未注册代际、未消耗那唯一一次 600 秒分配。
本次空跑的全部产物位于会话临时目录，**未进入仓库、未签发、未受理、不构成授权**。
仓库内唯一改动是上述断言。
