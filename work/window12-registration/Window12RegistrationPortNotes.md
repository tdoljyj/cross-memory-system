# root7 注册体生成器移植说明（window12）

`build-root7-registration.mjs` 由 `work/twentieth-forward/build-root6-registration.mjs`
**逐字节复制**（基底 sha256 `e220bfcedb056c3a4d6ef7feeae0364727be696091dd930e55f0e064b5fb929c`）
后仅在下表各点改动。不是重打一遍 —— 前缀摘要自检、占位符泄漏防护、参数错位防护
（R12-F9/F11）、predecessor 方法自检（R9-F1 的键序修复）全部是原班代码。

**为什么这份文件最危险**：`append_event` 不校验 body（`:13` 只查是不是 JSON 对象）。
错误的 body 会被数据库接受、随后被控制器拒绝，而 `append_event:36` 从此禁止再注册
同一个 ctrgen。**没有第二次机会，没有回滚。**

## 改动点（穷举）

| # | 位置 | 原 | 新 |
|---|------|----|----|
| 1 | 常量 | ROOT6/ROOT5 | ROOT7=`ctrgen_26769cc7…` / ROOT6=`ctrgen_5e0440a9…`（+移植说明注释）|
| 2 | 快照头校验 | `=== ROOT5` | `=== ROOT6`（HEAD_IS_NOT_ROOT6）|
| 3 | EXPECTED_CHAIN | 5 条 | **+第 6 条**：seq 6 / root6 / prefix_sequence 5 / `bcc3742e…` |
| 4 | head 校验 | LAST_REGISTRATION_IS_NOT_ROOT5 | …NOT_ROOT6 |
| 5 | body | control_trust_root_generation / minimum_accepted_generation → ROOT7 | |
| 6 | body.predecessor | `{ROOT5, canonicalDigest(head.body)}` | `{ROOT6, 同式}` + R31 #8 依据注释 |
| 7 | **新增断言** | — | `canonicalDigest(最后一条注册体) === a93bfdda…`，否则中止 |
| 8 | request | generation_id/predecessor_generation_id → ROOT7/ROOT6；idempotency_key 前缀 `register-root7-window12-` | |
| 9 | 输出文件名与 state | Root6…/ROOT6_… | Root7…/ROOT7_… |

## 第 3 条的来源（关键：两个独立源，不是自证）

第 6 条是 2026-09-13 对 `clued_control.events` 的**独立只读 select**
（`where request->>'kind'='GENERATION_REGISTERED'`）钉下的，**不是**从本脚本将要哈希的
那份快照里读的 —— 与基底脚本对前五条的做法同理由：被截断、重排或替换的快照否则会
「自洽地通过」。实测值与 `steps13to20/step13-exec.sql` 当初提交的字面量逐字节相同。

## 第 7 条：a93bfdda 的三重独立确认

1. R31 评审对活库 seq 6 body 快照复算（含 signature_binding、sorted+compact+LF）；
2. 本脚本的 `predecessorOf` 循环 —— 它对**历史**证明同一方法：对 root6 注册体算出的
   predecessor.sha256 = `92186d46`，正是 step13 当初实际提交的值；
3. 新增的显式断言把方法应用到**当前 head**，要求等于 R31 的 a93bfdda。

三者任一不合即停。基底脚本只有第 2 条（方法对历史成立），**方法对且输入错**这一路
在基底里是敞开的 —— 这是本次移植补上的洞，也是「在不可能失败的条件下完成的验证」
连续十四例之后应有的补法。

## 已验证 / 未验证（诚实边界）

- **已验证**：加载无语法错；两条 fail-closed 路径（无参数、参数不足）按预期抛错中止。
- **未验证：成功路径。** 需要 NW-02 之后的 `read_root` 全量快照 ——
  `append_event:18` 要求 `metadata_binding_sha256` 等于整行 `accepted_binding` 的 sha256，
  而 NW-02 会重写该行，所以**必须 NW-02 之后重新导出快照再跑**（基底脚本头注的排序陷阱
  R8-F3b，原样适用）。第 3、7 条断言正是在那一刻才真正受检。
- `CONTROLLER_DIR` 默认仍指 window11 控制器；正式运行须以环境变量指向 F12 实化后的树。
  未改默认值是有意的：改成一个尚不存在的 F12 目录会让脚本现在就无法加载，
  掩盖掉上面那两条 fail-closed 验证。

## 正式运行前置（缺一不可）

NW-02 已应用 → 重新导出 `read_root` 快照 → M3 已合并（窗口 T 与 owner_approval_ref 实化）
→ 新 issuer 资格件两份已出（blob 与 sha256）→ 本注册体的**独立受理件**已出
（否则只能用 `--acceptance-pending` 出评审主体，不出可提交体）→ 独立评审 →
**Owner 对 append_event 的单独执行授权**（与 M3 合并是两回事）。
