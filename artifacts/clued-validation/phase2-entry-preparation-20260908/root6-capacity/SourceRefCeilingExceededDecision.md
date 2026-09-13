# 源 blob ref 超出 Owner 批准上限 —— 需要你裁定路线

**状态：`ANALYSIS_NO_WRITE_PERFORMED`。本文件不签发受理、不构成授权、不消耗任何一次性资源。**

第二十二轮独立评审的 R22-F2。我逐项复现了，结论成立，而且**它卡死整条路径**：按当前字节，
**没有任何合法 GA 能为这个控制器构造出来**。这不是代码缺陷，我修不了，路线只能由你选。

---

## 一、事实

| | 值 |
| --- | --- |
| 控制器清单的 `REPOSITORY_SOURCE` 条目 | 149 |
| 去重后的不同 blob | 137 |
| 加上清单自身的 blob（`source_ref.blobs` 必含） | **138** |
| Owner 批准的上限 `source_refs_maximum` | **133** |
| 需要减少 | **5** |

上限在三处强制，任何一处都会拒：

1. `source-publication.mjs` 的 `planSourceBatches`：`refs.length<=133`
2. `context.mjs:134`：`CLOSED_SOURCE_REF_MAXIMUM`
3. `context.mjs:113` 的 `capacityDelta.source_refs_maximum: 133`

第 3 处不是代码里随手写的数字。【实测】它出自
`Root6OriginalInput4000000CapacityProposal20260912.json` 的 `capacity_delta`，并被
**两份 Owner 批准件**载明：`Root6OriginalInput4000000CapacityApproval20260912.json`
与 `…v2.json`，两者的 `capacity_delta` 里都含 `"source_refs_maximum":133`。
**它是你签过的数。**

---

## 二、不是这几轮加出来的 —— 从第一天就超

【实测】逐提交回溯 Linux 控制器每一版清单的去重 blob 数：

| 提交 | 源条目 | 不同 blob | |
| --- | --- | --- | --- |
| `755d744` Linux 控制器首次提交 | 145 | **134** | 已超 |
| `bddb42c` | 146 | 135 | 已超 |
| `a51b7ce` | 147 | 136 | 已超 |
| `efd5f3a`（我加 `HostProvisioning.json`） | 148 | 137 | 已超 |
| `b3e1046`（我加 `read-source-blobs-linux.mjs`） | 149 | **138** | 已超 |

**移植过来的那一刻就是 134，本来就超。** 我这几轮为修阻断项加的 4 个文件把它从 134 推到 138，
但**即使把我加的全部删光，仍然是 134 > 133**。这一条不能算在最近的改动头上，也不能靠回退解决。

---

## 三、三条路线，代价各不相同

### 路线 A：把控制器瘦到 ≤133 —— 我认为走不通，但把数字摆出来

要减 5 个不同 blob。可减的候选只有我加的 4 个：

| 文件 | 删掉的代价 |
| --- | --- |
| `HostProvisioning.json` | 退回 R20-F3：闸门拒绝时无法裁定是环境缺件还是控制器缺陷（第十五轮起要了六轮） |
| `read-source-blobs-linux.mjs` | 退回 R21-F3：那唯一一次 600 秒分配会烧在 `C:/Program Files/nodejs/node.exe` 的 ENOENT 上 |
| 其余 2 个 | 同属修阻断项所加 |

**删光这 4 个也只到 134，还差 1，而且换回四条已修的缺陷。**

### 路线 B：把清单收敛到真实加载集

**【2026-09-12 更新，数字已修正】** 我给出的第一版数字（43 个模块 / 44 blob）**偏小，是错的**。
当时的加载集只跟 `import`，看不见运行期按路径读取的文件。【实测】补上 `new URL(...)` 之后又发现：

- `grr.mjs` 读 `gate-result-receipt.root5.schema.json`
- `context.mjs` 读 `status-manifest.root5.schema.json`，并通过 `bytes()` 读两份 profile schema
  与两份 `ProfileDefinition.json`
- `root-window-validation.mjs` 读 `control-trust-root-set.schema.json`
- 经 `result-terminal → original-inputs-blob → scenario-observations → runtime600` 这条链，
  还传递可达 `preentry-parent/.../host-tool-bridge600/bridge.py`

**修正后：加载集 56 个模块，其中 52 个是仓库源，去重 blob 52，加清单自身 53。**
对上限 133 **余量 80**。结论方向不变（B 在数量上成立），但先前那个数不可用。

第二十一轮 R21-F1 确立了一件事：控制器**真实静态可达**的模块是 **43 个**，而清单声明了 149 条
`REPOSITORY_SOURCE`。差额是前代目录里那些不被加载的文件。

若清单只声明真实加载集，去重 blob 会远低于 133，超限自然消失。

**但我不建议由我自己决定这么做**，理由要说清楚：清单同时是可信入口逐文件校验的对象，
「多包含不被加载的文件」是保守而非错误；前代控制器也是这么做的。收窄它会改变控制器摘要，
并且需要论证「这些被移出的文件确实不参与运行」——那是一次独立评审的工作量，不是我改个枚举。
**这条路线值得让下一轮评审出意见。**

### 路线 C：你重新签发容量材料，把上限提到 ≥138

最直接，代价是那条批准链要重走：新的容量提案、新的 Owner 批准件（含 v2 的对应件）、
以及所有钉着 `capacity_delta` 摘要的下游文档重签。

---

## 三之二、路线 B 的独立评审已回，结论要改这份文件

评审件：`RouteBManifestNarrowingReview.md`（分支 `claude/route-b-manifest-narrowing-review`）。
它用 `strace` 实测 + 静态全分支枚举 + 逐点否证三条独立推导取并集，**没有沿用我的方法**。

### 它改了三件事

**1. 数字是 142，不是 138。** 清单漏了 4 个运行期按路径读取的文件：三个 `skills/clued/*`
与 `apps/clued-cloud/package.json`。【我已复现并补进清单】补齐后 `REPOSITORY_SOURCE` 153 条、
去重加清单自身 **142**。**走 C 的话新上限必须 ≥142。**

三个 Skill 文件不只是计数问题：它们的字节只由 `fixed_skill_fixture.py` 的 `SUBJECT` 摘要保护，
而那道检查在 `prepare()` 里，属于 CREATE，**发生在 GA 签发与预算预留之后**——
Skill 字节漂移会烧掉那唯一一次 600 秒分配，与 R21-F3 同形。已补进清单，
可信入口在 node 启动前就拒，代价为零。**这一项与选哪条路线无关，我已经做了。**

**2. 路线 A 差的那 1 个是结构上不能删的。** Linux 移植相对 window11 只新增 5 个路径，
恰好 +5 个 blob（132→137）。删光正好回到 133——但第 5 个 `read-source-blobs-linux.mjs`
是活代码（`source-publication.mjs` import 它）。**A 差的不是一点点，是差在唯一不可删的那个上。**

**3. 「B 成立则你不用签任何东西」——这句是我说错的。** 收窄会改变清单字节 → 改变控制器摘要，
而摘要被四份已签件钉着。【实测】那四份钉的**全是 window11 的 `3a58eb87…`**；
Linux 控制器现在的摘要**全仓零引用**——它从未被任何签名件承认过。

| | B | C |
| --- | --- | --- |
| 新资格化 + 新运行时受理 | 需要 | 需要 |
| 容量适用性件、043 修复受理件按新摘要重出 | 需要 | 需要 |
| 新容量提案 | 不需要 | 需要 |
| 两份 Owner 批准件重签 | **不需要** | **需要** |

**B 与 C 的全部差额：一份提案 + 两份你的签名。** 其余是两条路线共同的沉没成本。

### 它的建议：C

理由不是 B 算不出来（B 算得出：收窄后 66 个 blob，余 67），而是 B 要换来一次
「93 个文件确实不参与运行」的独立论证，而**这次论证的第一遍就否掉了我的加载集**：
我算的 43 条漏了 17 条，其中 14 条真在加载集里。`linux-docker-driver/candidate.py` 与
`control-root-registration/verify.py` 是**模块作用域**读取——若真按 43 条收窄，
`parent600.py` 第一次 `load_exact` 就会炸，而收窄的论证本身会宣称它们「不参与运行」。
评审判定这就是**第九个实例**：修 R21-F1 的那个「计算加载集」自己漏了四类机制。

---

## 四、我需要你回答的

**A / B / C 选哪条。** 我不替你选，理由是：A 要牺牲已修的阻断项且仍不够；B 会改变控制器的
判定边界；C 需要你重新签名。三条都超出「实施方自行决定」的范围。

在你回答之前，我会继续处理不依赖这个裁定的事项（第二十二轮其余发现），但
**第 13 步及其后的一切都停在这里** —— 注册 root6 之后才发现 GA 构造不出来，是最坏的顺序。

---

## 五、边界

未写库、未注册代际、未预留预算、未跑 600 秒、未合并。
`charged_seconds` 9906 / 10506、head 仍 root5、代际 `ctrgen_5e0440a9…` 未注册。
