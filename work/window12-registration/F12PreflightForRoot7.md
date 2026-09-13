# root7 注册前置预检（F12 实化后，注册体成型前）

三项本可以拖到 append_event 那一刻才暴露的未知，提前实测掉。全部只读。
时间：M4 PR #165 待合并期间。

## 1. 注册体生成器能对 F12 树加载 ✓

移植说明里记着一条诚实边界：`CONTROLLER_DIR` 默认仍指 window11 控制器，
正式运行须指向 F12 实化树。现已实测：

```
CONTROLLER_DIR=scripts/phase2-qualification/control-context-verifier-root6-linux-successor \
  node work/window12-registration/build-root7-registration.mjs
```

停在参数校验（`PASS_THE_ACCEPTANCE_PAIR_...`），**说明对 F12 树的
`root-window-validation.mjs` 导入成功** —— 若 F12 的该模块有加载期问题，
会先炸在 import 而不是参数检查。

## 2. F12 的窗口闸接受本窗注册体 ✓

`root-window-validation.mjs:31` 实化后为
`start >= 2026-09-13T05:45:14Z && end <= 2026-09-14T05:45:14Z`。
注册体将带 `not_before = T`、`expires_at = T+86400s`：

| 检查 | 结果 |
| --- | --- |
| `not_before = T` 过下界（闭区间）| true |
| `expires_at = T+86400` 过上界（闭区间）| true |
| 窗口宽度恰 86400s（生成器另一条硬断言）| true |

两端都是**闭区间**，T 正好落在边界上而不越界 —— 这是实化值恰好等于闸门边界的
必然结果，但「必然」不等于「验过」，所以验了。

## 3. F12 的 canonicalDigest 仍复现两代注册体摘要 ✓（最关键）

注册器里有一条硬断言：当前 head 注册体的 canonicalDigest 必须 = `a93bfdda…`
（R31 独立裁定值）。该断言用的是**控制器自己的** canonicalDigest —— F12 改过控制器
字节，若 canonicalDigest 行为随之变化，这条断言会在 append_event 前一刻才炸。

用 F12 的模块本尊复算：

| 输入 | F12 算出 | 期望 | |
| --- | --- | --- | --- |
| root6 注册体快照 | `a93bfdda74d9d693…4081c5` | 同 | ✓ |
| root5 注册体快照 | `92186d46e92ee7d2…58eff5` | 同（step13 实际提交值）| ✓ |

**两代都命中。** canonicalDigest 未因 F12 而漂移，注册器的断言在真实执行时会通过
而不是中止。

## 仍未验（诚实边界）

- **成功路径整体**：仍需 NW-02 之后重新导出的 `read_root` 全量快照
  （`append_event:18` 要求 `metadata_binding_sha256` 等于整行 `accepted_binding`
  的 sha256，而 NW-02 会重写该行）。本预检不改变这条。
- issuer blob uri：须 M4 合并发布后才可取。
- `__PENDING_ROOT7_REGISTRATION_BODY_CANONICAL_SHA256__`：注册后才可量测。
