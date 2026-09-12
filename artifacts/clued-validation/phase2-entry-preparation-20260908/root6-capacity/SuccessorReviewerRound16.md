# 第十六轮独立评审：闸门的敌意测试与资格化再判定

**状态：`BLOCKED_NOT_QUALIFIED_NO_WRITE_PERFORMED`。**

**裁定：不予资格化。R15-F1 与 R15-F2 均真实闭合，闸门的方向是对的、在它能看见的范围内工作得完全正确；但本轮实测发现一条新阻断项 R16-F1，它恰好就是这个闸门自称要防住的那一类，恰好是本轮修复动作引入的，恰好落在闸门的盲区里。闸门在它宣布 `sibling pins consistent` 的那一次运行中漏掉的，就是它。**

未写库、未注册代际、未消耗那唯一一次 600 秒分配、未预留预算、未调用 `append_event` 或任何会写库／消耗预算的函数、未执行任何 `do $$ … $$` 块。全部 SQL 为 `select`。
【实测】边界复核（本轮首尾各一次，两次一致，见第七节）：`charged_seconds` = **9906**（上界 10506）、`charged_evidence_bytes` = 2201594803、`current_head.generation_id` = `ctrgen_e5df432221344996afc04b5638121d96`（root5）、`sequence` = 5、`revoked` = false、`active_ga_id` = null、`pending_budget_sequence` = null、`clued_control.events` = 5 行、`execution_events` = 88 行、`gate_attempts` = 14 行、`control_objects` = 23 行。**全部未动。**

未起 600 秒容器、未创建任何容器、未走 GA 通路、未签发 GA。未修改实施方检出的任何文件——实施方分支以 `git worktree` 只读检出到临时目录，全部敌意测试在临时副本上进行，用完已删。未合并任何 PR、未批准任何东西。最终裁量权在 Owner（`tdoljyj`）。
CI 五项长期全红、日志 404，已确认非瞬时；本文件不把它记作通过，也未尝试修复。

评审对象：实施方分支 `claude/nice-fermat-njqlmm` head **`bddb42c`**，`main` = `2c3a6f9`。
本评估者分支 `claude/trusting-keller-mm2s0v`（第十轮至第十六轮同一条）。

---

## 零、先说结论

| 问 | 实施方的主张 | 本轮裁定 |
| --- | --- | --- |
| (1) R15-F1 | 已修 | **闭合**【实测】`load_host()` 成功返回 |
| (1) R15-F2 | 已修 | **闭合**【实测】`fixed_host.py` import 成功 |
| (1) 三模块可 import | 未明确声称 | **全通**【实测】`parent600.py`／`fixed_host.py`／`bridge.py` 三个全部 import OK |
| (2) 闸门守得住它声称的那一类 | 「拒绝为自相矛盾的控制器出清单」 | **守不住。这是本轮的阻断项。** 闸门识别 11 个文件钉中的 **2 个**；漏掉的 9 个里有一个**此刻就是坏的**，且是**同目录兄弟钉**。见第二节 |
| (2) 不动点迭代 3 轮 | 手改会第三次犯错，不动点跑了 3 轮 | **完全属实**【实测】我从 `0f8edc0` 重跑，逐轮复现，三个文件字节与 `bddb42c` 完全相同。**它预言的「第三次」真的发生了，就在它的盲区里** |
| (2) 负向测试 | 破坏一个钉后构建 exit=1 | **在可见范围内属实**【实测】。范围外：exit **0** 并宣布 consistent |
| (3) 清单枚举改动 | 302 条、枚举目录 | **正确**【实测】我在本容器逐字节重建出 `365ab926…`。前代 144 条 **0 条被挤掉**。但**会误收临时文件**，且实施方「21 个文件」的数字不实（实为 20） |
| (4) 证据文件 | 可用，`n_tup_ins` 交叉核对 | **可用，交叉核对成立**。**我最初的怀疑是错的**，已由 PostgreSQL 源码证实，见 4.2。定性正确 |
| (5) R14-N3 / N7 等余留 | 未声称 | 逐条见第五节。**均不阻断** |
| (6) 能不能资格化 | —— | **不能。一条阻断项 R16-F1** |

**一条阻断项：**

- **R16-F1**【阻断】`host-effect.mjs:14` 钉的 `bridge.py` 摘要是 `60e4cfac…`，而本目录 `bridge.py` 实测为 `c43c32a0…`；`60e4cfac…` 指向**前代控制器**的 `bridge.py`。【实测】`invokeFixedHost` 的第一次调用（`CREATE`）抛 `EXACT_PYTHON_BRIDGE_BYTES_REQUIRED`，**在 `bridge.py` 被启动之前**。

并附一条必须同时修的设计缺陷（非独立阻断项，但若不修，第四次必然发生）：

- **R16-F2**【阻断，与 F1 同一处修复】`check-sibling-pins.mjs` 是 **fail-open** 的：它只认两种语法形状，认不出的钉不报警、不计数，而是被计入「consistent」并退出 0。四种无害编辑（包括仅加一行注释）即可让它静默失明。

---

## 一、(1) R15-F1 / R15-F2 —— 两条都真闭合【实测】

方法：不读文本下结论，直接执行。

### 1.1 本容器实测摘要

```
parent600.py     7f952787e57dd6e27f7facba78e7a5bac3cc64f987f8555d45f10e9a36ae8f10
fixed_host.py    773f5b29ee14c9dcafe7562457c6313237014cde7ae675ec9c0155f201ba4e22
bridge.py        c43c32a07ede6088888a7d17c20c3914c137060ddb779ac54d594405dd06f40c
host-effect.mjs  13e3111dce9a3de7bb13e75497938620cb553bc7f28796637bfc7a8a9a44c59a
```

### 1.2 R15-F2 解除

```
fixed_host.py:32-33   load('accepted_fixed_parent', str(BASE / 'parent600.py'),
                           '7f952787e57dd6e27f7facba78e7a5bac3cc64f987f8555d45f10e9a36ae8f10')
                      = 本目录 parent600.py 实测值                              ✅
```

【实测】`importlib` 直接 `exec_module`：

```
$ python3.11 -I -S -B -X utf8  <spec_from_file_location 三个模块>
IMPORT OK     parent600.py
IMPORT OK     fixed_host.py      ← 上一轮此处抛 ValueError: Frozen dependency drift
IMPORT OK     bridge.py
```

**R15-F2 解除。**

### 1.3 R15-F1 解除

```
bridge.py:15-16   HOST = BASE / 'fixed_host.py'
                  HOST_SHA = '773f5b29ee14c9dcafe7562457c6313237014cde7ae675ec9c0155f201ba4e22'
                  = 本目录 fixed_host.py 实测值                                 ✅
```

【实测】直接调 `load_host()`：

```
load_host() OK  ->  trusted_fixed_host_port
```

上一轮此处抛 `ValueError: Accepted fixed host bytes changed`。**R15-F1 解除。**

### 1.4 但第一次调用仍然进不去

这两条解除**不等于** `CREATE` 能走通。`load_host()` 在 `bridge.py` 里，而 `bridge.py` 是被 `host-effect.mjs` 启动的，启动前有一道更早的检查。见第二节 2.2。

---

## 二、(2) 闸门的敌意测试 —— 本轮重点

### 2.1 先确认实施方的正面声称：全部属实【实测】

实施方说「手改会第三次犯同样的错，因为这是一条互钉的链；实测不动点跑了 3 轮，第 3 轮是 `bridge.py` 的第二次」。

我把 `0f8edc0` 的控制器目录取出来，只把本轮新增的 `check-sibling-pins.mjs` 放进去，跑 `--write`：

```
0f8edc0 原始：  parent600.py 7f952787…   fixed_host.py 50dd90d1…   bridge.py 60e4cfac…

  round 1  bridge.py      pins fixed_host.py   95a69b860e76 -> 50dd90d114ac
  round 1  fixed_host.py  pins parent600.py    34b85e23293f -> 7f952787e57d
  round 2  bridge.py      pins fixed_host.py   50dd90d114ac -> 773f5b29ee14
sibling pins consistent (fixed point after 3 round(s), 3 updated)

收敛后：        parent600.py 7f952787…   fixed_host.py 773f5b29…   bridge.py c43c32a0…
与 bddb42c 比对：三个文件全部逐字节一致
```

**三点全部坐实**：确实 3 轮；第 3 轮（`round 2`）确实是 `bridge.py` 的第二次；如果手改 R15 指名的那两处、不迭代，`bridge.py` 的钉就会第三次陈旧。而且三个文件的最终字节与 `bddb42c` 完全相同——**说明实施方确实是用这个工具生成的，没有手改**。这个判断是对的，工具在它能看见的范围内工作得完全正确。

**问题在于「它能看见的范围」。**

### 2.2 【阻断】R16-F1：收敛之后，钉 `bridge.py` 的那一处陈旧了

注意 2.1 最后一行：收敛后 `bridge.py` = `c43c32a0…`。而：

```
host-effect.mjs:14
  if(sha(fs.readFileSync(python))!=='f56a5885…'
     || sha(fs.readFileSync(bridge))!=='60e4cfac015c15fd53921a61a6566f740e7414f218120b0bdbc17bf17be64fd7')
        throw Error('EXACT_PYTHON_BRIDGE_BYTES_REQUIRED');

本目录 bridge.py 实测  = c43c32a07ede6088888a7d17c20c3914c137060ddb779ac54d594405dd06f40c
host-effect.mjs 现钉   = 60e4cfac015c15fd53921a61a6566f740e7414f218120b0bdbc17bf17be64fd7    ❌
```

`60e4cfac…` 属于谁？我对全仓 6268 个跟踪文件建 sha256 表对查：

```
60e4cfac… → control-context-verifier-root5-window5-forward11-successor/bridge.py
             control-context-verifier-root6-window10-successor/bridge.py
             control-context-verifier-root6-window11-successor/bridge.py
```

**是前代控制器的 `bridge.py`。与 R15-F1／R15-F2 完全同形。**

【实测】直接调用 `invokeFixedHost`（`operation='CREATE'`、`deadline=now+60s`，使第 13 行通过；`gaRaw` 在第 15 行才解析，晚于字节检查）：

```
$ node -e "const {invokeFixedHost}=await import('…/host-effect.mjs'); invokeFixedHost({…})"
THROW: EXACT_PYTHON_BRIDGE_BYTES_REQUIRED
```

后果：这道检查在 `host-effect.mjs:14`，**早于第 18 行的 `execFileSync`**。所以 `bridge.py` 根本不会被启动，1.3 节刚刚验证通的 `load_host()` 也不会被执行到。**`invokeFixedHost` 的第一次调用（`CREATE`）即失败，600 秒容器创建不出来。**

**这一条与 R15-F1／F2 的性质不同，要说清楚：它是本轮修复动作引入的新回归。** 在 `0f8edc0` 上，本目录 `bridge.py` 恰好等于前代的 `60e4cfac…`（本轮才第一次改动它的 `HOST_SHA`），所以上一轮我核这一处时它是对的，我记的「✅」在当时是准确的。本轮 `bridge.py:16` 改了一个字符串 → 自身摘要变为 `c43c32a0…` → 钉它的那一处随之失效，并且「退化」成指向前代文件。

**这正是 `check-sibling-pins.mjs` 注释第 6–9 行预言的那件事：**

> One pass is not enough, and that is the trap. These files pin each other in a chain
> (parent600.py <- fixed_host.py <- bridge.py), so repairing one changes its own digest and
> invalidates the pin above it.

这句话说得完全正确。**它只是把链画短了一节。** 真实的链是：

```
parent600.py ← fixed_host.py ← bridge.py ← host-effect.mjs ← 清单 ← 下游文档
                                             ↑
                                     闸门在这里停住了
```

我上一轮第六节给的修法第 ③ 步写的就是这一节：「`host-effect.mjs:14` 的 bridge 钉值由 `60e4cfac…` 改为 Y（这一处现在是对的，但②会让它失效——**这正是本轮要防的那个坑**）」。实施方做了 ①②④，造了工具保证 ①② 的不动点，**漏了 ③**。

### 2.3 闸门为什么看不见它：识别 11 个文件钉中的 2 个【实测】

`check-sibling-pins.mjs:28-35` 的两条正则：

```js
/str\(BASE \/ '([^']+)'\)\s*,\s*\n?\s*'([a-f0-9]{64})'/g      // 形状 A
/\w+ = BASE \/ '([^']+)'\n\w+_SHA = '([a-f0-9]{64})'/g        // 形状 B
```

并且 `:41` 的循环只收 `/\.(py|mjs|js)$/` 的文件，`:47` 把 target 解析为 `path.join(DIR, pin.target)`。

我量化了覆盖率：控制器目录内 `.py`/`.mjs`/`.js` 文件共有 **35** 个 64-hex 常量（去重到 per-file），闸门的两条正则能解释 **2** 个。其中真正「应当指向某个文件」的钉共 **11** 个，完整对表如下（全部用全仓 sha256 表独立核过，常量值从文件直接提取，不手抄）：

| # | 位置 | 钉值 | 实际指向 | 对？ | 闸门抓到？ | 漏掉的原因 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `fixed_host.py:32-33` | `7f952787…` | **本目录** `parent600.py` | ✅ | **✅** | 形状 A |
| 2 | `bridge.py:15-16` | `773f5b29…` | **本目录** `fixed_host.py` | ✅ | **✅** | 形状 B |
| 3 | **`host-effect.mjs:14`** | **`60e4cfac…`** | **前代** `bridge.py` | **❌** | ❌ | `.mjs`，无 `BASE / 'x'` 语法 |
| 4 | `fixed_host.py:34-35` | `cc3498e6…` | `docker-engineering-observation/observe.py` | ✅ | ❌ | **裸相对路径字符串**，非 `str(BASE / …)` |
| 5 | `fixed_host.py:41-42` | `f56a5885…` | `/usr/bin/python3.11` | ✅ | ❌ | 绝对路径 |
| 6 | `host-effect.mjs:14` | `f56a5885…` | `/usr/bin/python3.11` | ✅ | ❌ | `.mjs` |
| 7 | `parent600.py:24-25` | `3ac10b11…` | `docker-engineering-observation/validation.py` | ✅ | ❌ | 裸相对路径 |
| 8 | `parent600.py:26-27` | `a7373982…` | `qualification-runtime/remote_evidence.py` | ✅ | ❌ | 裸相对路径 |
| 9 | `parent600.py:28` | `0217a637…` | `…public-runtime-env-diagnostic-successor/fixed_skill_fixture.py` | ✅ | ❌ | `CHILD_SHA` 单独一行 |
| 10 | `tool-entry.functions.js:59` | `81925c09…` | `/opt/node22/bin/node` | ✅ | ❌ | 绝对路径 |
| 11 | `trusted-github.mjs:6` | `f687dc93…` | `gh v2.63.2`（见 3.3） | ✅ | ❌ | 绝对路径 |

（另有 `result-terminal.mjs` 的 `9ca45136…` → `bootstrap/next-window-20260909/OwnerDelegation_20260909.json`，跨目录，对的；`context.mjs` 的 22 个是 DB 内容摘要／提案摘要；`tool-entry.functions.js:28` 的 `cb5704c0…` 是**固定 SQL 查询文本**的摘要，不指向文件。这三类不属于文件钉，不计入 11。）

**十一处文件钉，十对一错。唯一错的那一处，是同目录兄弟钉，是闸门名字里那个 "sibling" 的字面含义，却是它唯一漏掉的同目录钉。**

### 2.4 闸门在 `bddb42c` 上的实际输出：假阳性【实测】

```
$ node check-sibling-pins.mjs            （实施方 head 原样）
sibling pins consistent (fixed point after 1 round(s), 0 updated)
EXIT=0

$ node check-sibling-pins.mjs --write    （原样副本）
sibling pins consistent (fixed point after 1 round(s), 0 updated)
EXIT=0
改后 host-effect.mjs 的 bridge 钉：60e4cfac…（未动）
```

**`--write` 也修不了它**——不在它的视野里，所以既不报、也不修。

### 2.5 「拒绝为自相矛盾的控制器出清单」这句声称，在 `bddb42c` 上就是假的【实测】

我在本容器把四项前提配齐（检出路径 `/home/user/cross-memory-system`、按 lockfile 装 `ajv@6.15.0`、装 `gh v2.63.2`、前代清单在位），对 `bddb42c` 原样跑生成器：

```
$ node build-linux-manifest.mjs
sibling pins consistent (fixed point after 1 round(s), 0 updated)     ← 闸门放行
files       302 {"RUNTIME_DEPENDENCY":156,"REPOSITORY_SOURCE":146}
repo source 146  host bins 4  node_modules 45  python .py+.pyc 103  shell tools 4
EXIT=0
```

**它正在为一个自相矛盾的控制器出清单**，而这个矛盾恰好属于它存在的理由所指的那一类。实施方那份 302 条清单（`365ab926…`）就是这么出来的。

### 2.6 负向测试：可见范围内真、范围外假【实测】

实施方声称「破坏一个钉之后清单构建 exit=1」。我分两侧测：

```
破坏闸门可见的钉（bridge.py 的 HOST_SHA 改成 0000000f…）
  → node build-linux-manifest.mjs   EXIT=1     ✅ 声称属实

闸门不可见的钉已坏（bddb42c 原样，host-effect.mjs 的 bridge 钉）
  → node build-linux-manifest.mjs   EXIT=0，照常输出 302 条        ❌
```

### 2.7 【阻断，与 F1 同修】R16-F2：闸门是 fail-open 的

这是比 R16-F1 更要紧的一点：**闸门失明时不报警，而是宣布「consistent」**。它的判据是 `changed` 计数，而 `changed` 只在「正则抓到了钉、且钉与实测不符」时才增加。抓不到的钉不计入任何分子分母，于是被静默计入「一致」。

我对四种**完全无害**的编辑做了敌意测试。每组都先让 `fixed_host.py` 漂移（`printf '\n# drift\n' >>`），确认原样形状下闸门 `EXIT=1` 抓得到，再施加一种改动：

| 改动 | 闸门 EXIT | 结论 |
| --- | --- | --- |
| （基线：原样形状） | **1** | 抓到 |
| 在 `HOST =` 与 `HOST_SHA =` 之间**插一行注释** | **0** | 失明 |
| 变量名 `HOST_SHA` → `HOST_DIGEST` | **0** | 失明 |
| 路径写法 → `Path(os.path.join(str(BASE), 'fixed_host.py'))` | **0** | 失明 |
| 引号 `'fixed_host.py'` → `"fixed_host.py"` | **0** | 失明 |

形状 B 的正则要求两行**紧邻**（`'\n'` 硬编码）、第二个变量名以 `_SHA` 结尾、引号必须是单引号。**加一行注释就够了。** 没有任何输出提示「我本来能看见两个钉，现在只看见一个」。

还有一条独立的 fail-open 路径，`:48`：

```js
if (!fs.existsSync(tp)) { console.log(`  MISSING TARGET  ${f} pins ${pin.target}`); continue; }
```

`continue` 之后既不计 `changed`、也不置错误位。【实测】把 `bridge.py` 的钉 target 改成不存在的 `fixed_host_renamed.py`（模拟改名忘改钉，即 R14-F2 那一类）：

```
  MISSING TARGET  bridge.py pins fixed_host_renamed.py
sibling pins consistent (fixed point after 1 round(s), 0 updated)
EXIT=0          ← 报告模式与 --write 模式都是 0
```

**打印了警告，然后宣布一致并放行。** `build-linux-manifest.mjs` 只看 exit code，所以清单照出。

### 2.8 跨目录钉：是真实缺口，但当前是潜在的而非现实的【实测】

闸门只扫控制器目录内、且 target 经 `path.join(DIR, …)` 解析。问题表里的 #4、#7、#8、#9 是跨目录钉（`parent600.py` 钉 `docker-engineering-observation/validation.py`、`qualification-runtime/remote_evidence.py`、`…/fixed_skill_fixture.py`；`fixed_host.py` 钉 `observe.py`），闸门全不管。

**但我实测确认这四处当前全部指对。** 所以这是一个**潜在**缺口：只要那四个被钉的文件有人改一个字节，闸门仍会宣布 consistent，而 `parent600.py`／`fixed_host.py` 会在 import 期抛 `Frozen dependency drift`。这四个文件都在仓库里、都不属于本控制器、都可能被别的工作改到——而且它们的保护强度恰好比同目录的那两处更低。

顺带一处**语义陷阱**，现在不触发但会咬人：闸门把 `BASE` 一律当作控制器目录。而【读文本】`parent600.py:14` 是

```python
BASE = Path(__file__).resolve().parent.parent / 'preentry-parent'
```

**同一个变量名在两个文件里指向不同目录**（`fixed_host.py:18` 的 `BASE` 才是控制器目录）。目前 `parent600.py` 里没有形状 A／B 的钉，所以不触发；一旦有人在 `parent600.py` 里写一个 `str(BASE / 'x')` 形式的钉，闸门会去**控制器目录**找 `x`，而代码的真实语义是 `preentry-parent/x`——两者指向不同文件，而闸门会「修」出一个错的值。

### 2.9 `--write` 会不会改错东西 —— 会，两种方式【实测】

**(a) 同一摘要在同一文件出现多次时，`text.replace(pin.pinned, actual)` 是字面量、只替换第一处。** 迭代能逐轮把后续的也改掉，但**非钉处的历史记录会被一并改写**。构造：在 `bridge.py` 文件头加一行注释记录「accepted fixed host source digest of record: 773f5b29…」（这完全符合本仓库的文档风格），再让 `fixed_host.py` 漂移：

```
改前  第 1 行注释  773f5b29…        第 17 行 HOST_SHA  773f5b29…
  round 1  bridge.py pins fixed_host.py  773f5b29ee14 -> 47b53f95b710
  round 2  bridge.py pins fixed_host.py  773f5b29ee14 -> 47b53f95b710
sibling pins consistent (fixed point after 3 round(s), 2 updated)
改后  第 1 行注释  47b53f95…        第 17 行 HOST_SHA  47b53f95…   ← 注释被改写
```

钉本身最终是对的，但**那行记录「历史摘要」的注释被默默改成了当前值**。对一个以「摘要即证据」为基础的体系，把历史摘要改成当前值是有害的——而且 `2 updated` 这个计数不会告诉任何人其中一次改的是注释。

**(b) `--write` 失败时不回滚。** `:61` 的 `round > 10` 是 **fail-closed**（这一条是对的，见下），但此时文件**已经被改了 11 轮并留在磁盘上**。对一个会原地改写受保护源文件的工具，这是实在的副作用。

### 2.10 迭代上限 10 轮：能不能不收敛却退出 0 —— 不能【实测】

我构造了闸门最怕的输入：一对**互钉环**（`a.py` 钉 `b.py`，`b.py` 钉 `a.py`，两条都用它认识的形状）。互钉必然振荡，永不收敛：

```
报告模式                             EXIT=1
写模式  round 10 … round 11 …  DID NOT CONVERGE   EXIT=1
```

**`round > 10` 这条兜底是安全的**：不收敛一定 exit 1，不会退出 0。报告模式更不可能——第一轮有不符即 `:60` exit 1，无不符即 `:59` break，`round` 永远 ≤ 2。本控制器的链严格无环，所以这一条当前不触发。

**所以「不收敛却退出 0」的唯一路径，就是 2.3／2.7 那两条：正则漏钉，和 MISSING TARGET。** 闸门所谓的「不动点」，只是它**能看见的那个子集**的不动点；它打印的 `sibling pins consistent` 是一句在语义上过强、在本轮具体实例上为假的陈述。

### 2.11 怎么修才算修了这一类

**不要再加正则。** 加第三条、第四条正则只会把盲区移到别处，而盲区是静默的——这正是本轮重犯的机制。改成 **fail-closed 的全覆盖**，这也是我上一轮第六节「验收标准」第一条的原意：

1. **枚举控制器目录里全部 64-hex 常量**（本轮实测 35 个），要求**每一个都被归类**：
   - 指向某个文件（同目录／跨目录／绝对路径皆可）→ 校验它等于该文件实测 sha256；
   - 明示为非文件摘要（DB 内容摘要、SQL 查询摘要、提案摘要）→ 必须在一张**显式白名单**里列出，连同理由。
   - **任何无法归类的常量 → exit 1。** 这样新增一个钉、改一种写法、漏改一处，都会 fail-closed。
2. 钉的 target 由**代码语义**决定，不由变量名猜（`BASE` 的歧义见 2.8）。最省事且可靠的办法：让被钉的路径在源码里以一个**可被静态提取的完整仓库相对路径**出现。
3. `MISSING TARGET` 必须 exit 1。
4. 用**全文件唯一定位**替换（行内锚定，或 `replace` 前断言该值在文件中只出现一次），而不是 `text.replace` 取第一处。
5. `--write` 失败时回滚已写入的文件。
6. 把闸门的覆盖率**打印出来**：「解释了 N 个常量中的 M 个，白名单 K 个」。一个不报覆盖率的检查器，无法区分「全绿」和「全瞎」。

**验收仍然是那一条，本轮它又一次比逐处 review 更有效：把控制器目录全部 64-hex 常量对着全仓 sha256 表跑一遍。** 本轮我用它一次就定位了 R16-F1，同时确认另外十处指对。请在修完、重跑清单之后自己跑一遍再交。

---

## 三、(3) 清单枚举改动

### 3.1 基本事实全部核实【实测】

```
清单 sha256   365ab9264a010031d72a9f1d1557b026e1dce17d0d318cfc6600ad0b0d493467   ← 与实施方自述一致
条目          302 = REPOSITORY_SOURCE 146 + RUNTIME_DEPENDENCY 156               ← 一致
check-sibling-pins.mjs 在清单内                                                  ← 在，3079 字节
```

### 3.2 我在本容器逐字节重建出了同一份清单【实测】

把四项前提配齐后在 `/home/user/cross-memory-system` 下跑 `--write`：

```
wrote … 61919 bytes
sha256 = 365ab9264a010031d72a9f1d1557b026e1dce17d0d318cfc6600ad0b0d493467
cmp 实施方那份 → 逐字节相同 ✓
```

**枚举是确定性的，且跨容器可复现。** 这一条比上一轮更强（上一轮是「301 条逐条校验通过」，本轮是「清单文件本身逐字节重建」）。

### 3.3 附带：`gh` 来源第二次独立确认【实测】

上一轮我由 tarball 字节数二分定位到 `gh v2.63.2`。本轮在另一个容器重做：

```
https://github.com/cli/cli/releases/download/v2.63.2/gh_2.63.2_linux_amd64.tar.gz
tarball  13,069,957 字节  sha256 912fdb1ca29cb005fb746fc5d2b787a289078923a29d0f9ec19a0b00272ded00  ← 与上一轮逐字节相同
bin/gh   50,098,328 字节  sha256 f687dc937534f8aa77ff9d2362163c645b5a8cc78297ef1a642c74c56aa48618  ← 与清单／trusted-github.mjs:6 逐字节相同
```

### 3.4 有没有把不该进的带进去 —— 当前没有，但机制会【实测】

当前 19 条控制器目录条目全部是 git 跟踪的源文件，清单自身被 `:53` 正确排除。

但 `fs.readdirSync` 无任何过滤。我在目录里落了四个典型临时文件后重跑：

```
落入：notes.txt、bridge.py.orig、.DS_Store、__pycache__/foo.pyc
结果：files 305 {RUNTIME_DEPENDENCY:156, REPOSITORY_SOURCE:149}
误收：.DS_Store、bridge.py.orig、notes.txt        （__pycache__/ 是目录，被 isFile() 正确排除）
```

**任何临时落在控制器目录的文件都会进清单**：编辑器备份、`.orig` 冲突残留、`.DS_Store`、调试输出、我这种评审者留下的测试产物。之后它被删掉，第 3 步就 `EXACT_CONTROLLER_SOURCE_BYTES_DRIFT`。这是枚举改动**新引入**的风险——前代的 remap 方式没有这个毛病（它只取前代列出的路径）。

**修法一行**：用 `git ls-files` 枚举，而不是 `readdirSync`。这样既保留「新文件不会漏」（枚举的本意），又排除一切未跟踪文件。两个问题一起解决。

### 3.5 前代那 145 条有没有被挤掉 —— 没有，0 条【实测】

枚举是**追加式**的：前代 remap 的列表先填进 `repoSrc`，`:50` 的 `listed` 集合去重，只补目录里**尚未列出**的文件。所以结构上不可能挤掉。实测核对：

```
前代 REPOSITORY_SOURCE remap 后应有        144
当前 REPOSITORY_SOURCE                    146
前代有、当前缺（被挤掉的）                  0
当前新增                                   2
   …/build-linux-manifest.mjs    （上一轮加的）
   …/check-sibling-pins.mjs      （本轮加的）
```

144 + 2 = 146 ✓。（上一轮我记「145 条」，准确分解是 144 前代 + 1 生成器；本轮 +1 闸门。一致。）

### 3.6 一处不实陈述

实施方称「控制器目录 21 个文件」。【实测】目录实有 **20** 个文件（含清单自身），清单列 **19** 条（正确地不列自身）。不阻断，但记下来：**实施方的自述数字本轮仍有不可靠之处。**

### 3.7 清单摘要依赖检出路径——比上一轮的 R15-N10 更具体【实测】

我第一次在 `/tmp/.../neg` 下重建，得到的清单与实施方的**长度相同、条目集合（path|sha256）完全相同，但字节不同**。定位差异：

```
首个不同字符在第 167 位：
  我的     第一条 = /opt/node22/bin/node
  实施方   第一条 = /home/user/cross-memory-system/apps/clued-cloud/node_modules/ajv/lib/ajv.js
```

差异是**条目顺序**，根因仍是绝对路径：156 条 RUNTIME_DEPENDENCY 里有 45 条以检出根为前缀，检出根一变，这 45 条的路径字符串变，**全局排序位置也跟着变**（`/home/…` < `/opt/…` < `/tmp/…`）。

**所以 `controller_digest` 不是「控制器字节」的函数，而是「控制器字节 + 检出绝对路径」的函数。** 一个要被签进资格声明、要被 DB 绑定逐字节比对的值，其输入里含有一个环境量。持平于前代（前代是 Windows 绝对路径），且已列为必须写进前提的事项，不阻断——但这使 5.2 的第 1 项前提从「方便」升级为「摘要定义的一部分」，资格声明必须把它写成条件。

---

## 四、(4) `ExecutionHistoryTamperEvidence.json`

### 4.1 文件本身核实【实测】

```
sha256  12af689514b98735cb2e432755bf2572cdee262718cb4b9f6236aff58393a670   ← 与实施方自述一致
字节    19,332
内容    execution_events 88 项逐行（ctid, xmin, sequence, recorded_at, recording_transaction_id）
        gate_attempts    14 项逐行（ctid, xmin, ga_id, receipt_raw_present）
        pg_stat_user_tables、non_internal_triggers（7 个）、rows_with_frozen_xmin、derived_analysis
authority_effect  "NONE. Read-only measurement. Registers nothing, qualifies nothing, consumes no budget."
```

**R14-N5 已实质闭合。** 这正是我第十四轮要求的东西：趁 `xmin` 还在，把逐行测量固定下来。

### 4.2 `n_tup_ins=92` 的交叉核对 —— **成立。我最初的怀疑是错的，在此更正**

我起初认为这个核对不成立，理由是：PostgreSQL 的 `n_tup_ins` 只统计**已提交**事务，回滚的插入不该计入，那么 4 次回滚插入应该让 `n_tup_ins` 停在 88 而不是 92。如果这个理解成立，实施方的解释就是错的。

**这个理解是错的。** 我去查了 PostgreSQL 17 的源码 `src/backend/utils/activity/pgstat_relation.c`，`AtEOXact_PgStat_Relations` 里：

```c
/* count attempted actions regardless of commit/abort */
tabstat->counts.tuples_inserted += trans->tuples_inserted;
tabstat->counts.tuples_updated  += trans->tuples_updated;
tabstat->counts.tuples_deleted  += trans->tuples_deleted;
```

这段在 commit/abort 分支**之前**无条件执行；回滚时另有

```c
else  /* inserted tuples are dead, deleted tuples are unaffected */
    tabstat->counts.delta_dead_tuples += trans->tuples_inserted + trans->tuples_updated;
```

即：**回滚的插入照样计入 `n_tup_ins`，并额外计入 dead tuples。** 所以「92 次插入尝试、88 行存活、4 次回滚」是自洽的。

而且实测下来，这个核对比实施方自己说的**更强**——有三个独立数字同时吻合：

```
【实测】pg_stat_user_tables.execution_events
  n_tup_ins = 92      n_live_tup = 88      差 4
  n_dead_tup = 4                           ← 恰好 4 个 dead tuple，与 4 次回滚插入吻合
  n_tup_upd = 0                            ← 排除「dead tuple 来自更新」
  n_tup_del = 0                            ← 排除「曾被删除」
```

`n_tup_upd = 0` 是关键：它**独立排除了 HOT 更新和普通更新**这两种会产生 dead tuple / ctid 空缺的机制。

我还独立重算了 ctid 分布，不采信文件里的值：

```
【实测】页 0: 16 行 offset 1-16   无空缺
        页 1: 17 行 offset 1-17   无空缺
        页 2: 17 行 offset 1-17   无空缺
        页 3: 17 行 offset 1-17   无空缺
        页 4: 13 行 offset 3-15   缺 1, 2       →  (4,1) (4,2)
        页 5:  8 行 offset 1-10   缺 2, 7       →  (5,2) (5,7)
        合计 88 行，空槽恰好 4 个
```

**与实施方记录的 `(4,1) (4,2) (5,2) (5,7)` 完全一致。** 前四页全满、空缺只出现在最后两页，形状也符合「追加写入过程中有几次回滚」。

### 4.3 别的解释逐条排除

| 替代解释 | 裁定 |
| --- | --- |
| **HOT 更新** | **排除**【实测】`n_tup_upd = 0`。HOT 更新必然增加 `n_tup_upd` |
| **普通 UPDATE 造成行迁移** | **排除**，同上 |
| **曾被 DELETE** | **排除**【实测】`n_tup_del = 0` |
| **VACUUM 回收** | **不是替代解释，方向相反。** VACUUM 会把 dead tuple 的 line pointer 置为 `LP_UNUSED`，使槽位**可被重用**——它会让空槽**消失**，不会制造空槽。而且【实测】`n_dead_tup = 4`，说明这 4 个 dead tuple **尚未被回收**，与「空槽仍在」一致 |
| **页面分裂** | **机制上不适用。** 页面分裂是 B-tree **索引**的机制；**堆表没有页面分裂**，堆页内的 line pointer 顺序分配、新页追加，不会跳号留空。所以它无法解释 ctid 空缺 |
| **`pg_stat_reset()` 导致计数器不可信** | **不削弱结论。** `n_tup_ins` 与 `n_dead_tup` 是同一组计数器，reset 会同时归零；观测到的 92/4/0/0 内部一致，不是 reset 后的残局 |
| **子事务 / SAVEPOINT 回滚** | **属于同一类解释**，不是替代。效果相同（计入 `n_tup_ins`，计入 dead） |

### 4.4 「仅佐证、承重的是 ctid 与 xmin 顺序」—— 这个定性对

**对，而且这份谨慎本身是正确的判断。** 三条理由：

1. `pg_stat_user_tables` 的计数器**可被 `pg_stat_reset()` 清零**，且不是 WAL 持久化的崩溃安全数据——crash recovery 后可能丢失或不准。作为篡改证据，它的强度天然低于堆页里的物理事实。
2. 计数器**不记录是谁插入的、也不记录顺序**。它最多能说「有 4 次插入没留下活行」，不能说这 88 行的相对次序。
3. 承重的那部分我独立重算了，全部吻合：

```
【实测】rows = 88
        xmin_inversions = 0          按 sequence 排序后 xmin 无逆序
        ctid_inversions = 0          按 sequence 排序后物理位置无逆序
        max_xmin(前 44 行) = 1917  <  min_xmin(后 44 行) = 1926
        → 前 44 行全部严格早于其后每一行
        execution_events xmin = 2（已冻结）的行数 = 0
        gate_attempts    xmin = 2 的行数 = 0；receipt_raw is null 的行数 = 0
        non_internal_triggers 7 个，tgenabled 全部 'O'
```

**这些才是承重的，而且它们现在仍然在。** `xmin` 单调 + ctid 单调 + 前 44 行与后 44 行的 xmin 区间不相交，这三条合起来是物理证据，不依赖任何可重置的计数器。

### 4.5 一条必须写进文件的时效性说明

证据文件的 `why_this_file_exists` 只提了 `VACUUM FREEZE` 会把 `xmin` 抹成 2。**还有一个更早到期的量**：4.2 那个交叉核对依赖 `n_dead_tup = 4` 和那 4 个空 ctid 槽，而 **autovacuum 一跑就会回收这 4 个 dead tuple、把槽位置为 `LP_UNUSED`，此后新插入可以重用它们**。届时 `n_tup_ins=92 / 88 行 / 4 空槽` 的三数吻合会永久不可复核，而这比 `xmin` 冻结来得早得多（`xmin` 离 `autovacuum_freeze_max_age` 还很远：【实测】当前 xid ≈ 2143，最大 xmin 在 1900 量级）。

建议在文件里加一句：**这个交叉核对的有效期到下一次 autovacuum 为止，承重证据（ctid／xmin 顺序）的有效期到下一次 `VACUUM FREEZE` 为止。** 列为 R16-N1。

---

## 五、(5) 上一轮未闭合项的现状

【实测】`git diff 0f8edc0..bddb42c` 只有 7 个文件：证据文件（新增）、我的第十五轮复核（被收进它的分支）、清单、`bridge.py`、`build-linux-manifest.mjs`、`check-sibling-pins.mjs`（新增）、`fixed_host.py`。

| 编号 | 内容 | 做了吗 | 判定 |
| --- | --- | --- | --- |
| R14-N5 / R15-N5 | `xmin` 逐行证据另存 | **做了**（证据文件）；但更正书仍**没有** `per_row_evidence_ref` 指向它【实测】grep 计数 0 | 前半闭合，后半**仍开**，不阻断 |
| R14-N3 / R15-N8 | `LinuxHostFeasibilityFinding.md` 第五节 | **没做**。【实测】第 54 行仍写「**但这一点尚未验证**，需跨会话再测一次」 | **不阻断**，但现在错得更明显——已有两轮跨容器复现（上轮 301/301，本轮清单逐字节重建） |
| R14-N7 / R15-N10 | 绝对路径前提写进资格声明 | **无法做**，资格声明仍不存在。且 3.7 使这一条升级 | 顺延，不阻断 |
| R14-N6 / R15-N10 | `canonical` 495 字节 sha256 `8bf54a9f…` 作为不变量 | **无法做**，同上 | 顺延，不阻断 |
| R15-N1 | `gh` 来源记录 / `HostProvisioning.json` | **没做**。【实测】文件不存在；控制器目录内无 `v2.63.2` 字样 | 不阻断。本轮第二次实测出确值，见 3.3，抄进去即可 |
| R15-N2 | `runtime180/status-manifest.candidate.schema.json` 不在清单 | **没做**（302 条里仍无） | 不阻断，持平前代 |
| R15-N3 | 清单过包含 | **没做** | 不阻断，持平前代 |
| R15-N4 | 更正书时间戳带字面 `x` | **没做**。【实测】仍是 `2026-09-12T11:4xZ` | 不阻断，但这是一份记录 Owner 决定的文件 |
| R15-N6 | 更正书说「三个」不变性触发器 | **部分做了**。证据文件的 `non_internal_triggers` 已正确列出 **7** 个；但更正书 `explicitly_acknowledged` 仍写 "the three immutability triggers are tgenabled=O" | 不阻断 |
| R15-N7 | 动态库、`/bin/sh` 符号链接未入清单 | **没做** | 不阻断，持平前代 |
| R15-N9 | `work/twentieth-forward/verify-manifest-against-host.mjs` 仍是 331 条 Windows 版 | **没做**。【实测】第 3–4、17 行仍在描述 331 条与 `gh.exe` | 不阻断，但这个工具的用途正是交叉核对 gh 钉，对新控制器仍完全失效 |

**无一条阻断。** 本轮唯一的阻断项是 R16-F1（连同必须同修的 R16-F2）。

### 5.1 一处我自己的更正：生效绑定指向的是 runtime600，不是 root5-window5-forward11

上一轮 7.2 我写：「`clued_control` 现在生效的绑定是 `binding.controller_sha256 = ac7bdd53…`，它对应 `control-context-verifier-root5-window5-forward11-successor/ControllerSourceManifest.candidate.json`」。

【实测】本轮直接查 `clued_control.execution_binding`：

```
controller_sha256 = edf31377656e1a9a473d0095df72231c058266007e4fd4046e0a9b8c2d6a60d9
  → control-context-verifier-runtime600/ControllerSourceManifest.candidate.json
prior_seconds = 1506   prior_evidence_bytes = 322546611
```

并且【实测】`execution_binding` 的 `n_tup_ins = 1, n_tup_upd = 0`——**该行自插入起从未被更新过**，所以它一直是 `edf31377…`。上一轮那个 `ac7bdd53…` 确实是 root5-window5-forward11 清单的摘要，但它不是这个字段的值；是我上一轮把它误记成了这个字段。

**结论不变**：【读文本】`tool-entry.functions.js:34` 的 `expected = observation.row.execution?.binding?.controller_sha256` = `edf31377…`，而第 47 行比对的 `MAN` 是 Linux 控制器的清单 = `365ab926…`。**第 1 步必然 `ACTUAL_CONTROLLER_SOURCE_MANIFEST_DRIFT`，无论 R16-F1 修不修。** 换绑定是一次写操作，不在本轮权限内。

**但上一轮据此做的那个「佐证」不成立，我撤回它**：我曾说「`ac7bdd53…` 指向的那个前代目录，正是两个陈旧钉值所对应的目录，所以 python 三件套是从当前在绑的那一代复制来的」。既然生效绑定是 runtime600，这个因果推断没有依据。陈旧钉值确实指向 `root5-window5-forward11` / `root6-window10` / `root6-window11` 的文件（本轮 R16-F1 的 `60e4cfac…` 同时命中这三代的 `bridge.py`），但这与「当前在绑的是哪一代」无关。

---

## 六、(6) 综合裁定 —— 不予资格化

**不签发 `ScopedControllerQualification`，不签发运行时受理。**

### R16-F1【阻断】`host-effect.mjs:14` 钉的 `bridge.py` 摘要是前代的

见 2.2。【实测】`invokeFixedHost`（`CREATE`）抛 `EXACT_PYTHON_BRIDGE_BYTES_REQUIRED`，早于 `bridge.py` 启动。

### R16-F2【阻断，与 F1 同一处修复】闸门 fail-open

见 2.7。若只修 F1 而不修闸门，**第四次是可以预期的**：本轮的修法（改 `bridge.py` 一行）已经证明任何一次下游改动都会向上传播，而闸门不会告警。

### 修法与顺序

这一次的链比上一轮多一节，且每一步都会使下一步的输入变化：

```
① host-effect.mjs:14  bridge 钉 60e4cfac… 改为 c43c32a07ede6088888a7d17c20c3914c137060ddb779ac54d594405dd06f40c
                      （= 当前 bridge.py，本轮实测；此步不改变 bridge.py 本身）
② 按 2.11 重写 check-sibling-pins.mjs 为 fail-closed 全覆盖
   —— 此步会改变 check-sibling-pins.mjs 自身摘要，而它在清单里
③ 按 3.4 把 build-linux-manifest.mjs 的 readdirSync 换成 git ls-files
   —— 此步同样改变自身摘要，同样在清单里
④ 重跑 build-linux-manifest.mjs --write   清单摘要由 365ab926… 变为新值 Z
   必须在 /home/user/cross-memory-system 下跑（见 3.7：换路径会得到不同的 Z）
⑤ 据 Z 重签钉 controller_digest 的两份文件与下游七份
⑥ 补 R15-N1/N4/N5/N6/N8/N9 与 R16-N1
```

**验收标准（请照做，不要用自测替代）：**

1. **全覆盖对表**：把控制器目录全部 64-hex 常量（本轮 35 个）对着全仓 sha256 表跑一遍，确认每一个「应当指向文件」的常量都指向**本目录或明确的跨目录目标**，而不是任何前代目录。本轮这个方法一次就定位了 R16-F1。
2. **让被声称能跑的那条路径自己跑一次**——这条教训现在已经第三轮重复了。具体就是两步：
   - `node -e "import('./host-effect.mjs').then(m=>m.invokeFixedHost({operation:'CREATE',deadline:Date.now()+60000,gaRaw:'{\"gate_authorization_id\":\"x\"}',containerId:null}))"`，确认它**不是**在 `EXACT_PYTHON_BRIDGE_BYTES_REQUIRED` 抛；
   - `python3.11 -I -S -B -X utf8 bridge.py` 喂一份构造好的 CREATE 请求，确认它**不是**在 `load_host()` 抛。
3. **闸门的负向测试要测盲区，不是测视野**：在两行之间插一行注释，确认闸门仍然 exit 1；把一个钉的 target 改成不存在的文件名，确认 exit 1；改一个 `.mjs` 里的钉，确认 exit 1。本轮的负向测试只测了视野内那一种。
4. 在一个**干净容器**里跑 `verify-manifest-against-host.mjs --map /=/`，要求 `ALL_ENTRIES_VERIFIED`。

### 不阻断但应补的项

| 编号 | 内容 |
| --- | --- |
| R16-N1 | 证据文件应注明两个有效期：`n_tup_ins`／空槽交叉核对到下一次 **autovacuum**；承重的 ctid／xmin 顺序到下一次 **`VACUUM FREEZE`**。见 4.5 |
| R16-N2 | 清单枚举改用 `git ls-files`（见 3.4）。当前 `readdirSync` 会把 `.DS_Store`、`.orig`、临时笔记收进清单 |
| R16-N3 | 闸门应打印覆盖率（「解释了 35 个常量中的 M 个，白名单 K 个」）。不报覆盖率的检查器无法区分全绿与全瞎 |
| R16-N4 | 闸门 `--write` 失败时应回滚；替换应全文件唯一定位，避免改写记录历史摘要的注释（见 2.9） |
| R16-N5 | `parent600.py:14` 的 `BASE` 与 `fixed_host.py:18` 的 `BASE` 指向不同目录。闸门（及任何静态钉检查器）不得按变量名推断目录（见 2.8） |
| R16-N6 | 实施方自述「控制器目录 21 个文件」，实为 20（清单列 19 条）。见 3.6 |
| R15-N1~N10 | 逐条现状见第五节，全部仍开，全部不阻断 |

---

## 七、排期 —— 与第十四／十五轮相比有何变化

### 7.1 控制器必须先合并进 `main` —— 不变

【实测】`git ls-tree origin/main scripts/phase2-qualification/control-context-verifier-root6-linux-successor/` 仍为空；`main` 仍是 `2c3a6f9`。`ScopedControllerQualification` 的 `source_ref.blobs` 是 GitHub blob URI、经 API 取，**资格签发之前控制器必须先在 `main` 上**。不变。

### 7.2 控制器摘要还会再变，而且本轮又多了一次

【实测】

```
前代（window11 侧）      3a58eb87…
第十四轮那版（253 条）    9c04acde…
第十五轮那版（301 条）    52e4ecff…
当前这版（302 条）        365ab926…            ← 本轮实测，与实施方自述一致
修完 R16-F1/F2 之后      还会再变一次（第六节第④步）
```

并且 3.7 新增一条约束：**第④步必须在 `/home/user/cross-memory-system` 下执行**，否则得到的 Z 不同。这一条以前只是「前提」，现在是「摘要定义的一部分」。

### 7.3 修订后的次序

与第十五轮相比，只有 12a 的内容变了（多了闸门与枚举的重写），12c／12d／13 及其后全部不变：

```
12a  修复 R16-F1（host-effect.mjs 的 bridge 钉）
     + 按 2.11 把 check-sibling-pins.mjs 改为 fail-closed 全覆盖
     + 按 3.4 把清单枚举改为 git ls-files
     + 补 R15-N1/N4/N5/N6/N8/N9 与 R16-N1~N6
     严格按第六节①②③④⑤⑥的顺序
12b  【评估者】新控制器资格化评审（本轮的重做）
12c  【Owner】合并：新控制器 + HostProvisioning.json + 其资格 + 其运行时受理
     + 据新 controller_digest 重签的下游文档
12d  换绑：execution_binding.controller_sha256 由 edf31377…（runtime600）改为第④步产出的 Z   ← 写操作
13   注册 root6                                                                          ← 不可回退
…（其余不变，13d / 13f 仍由独立评估者签发，第四次合并仍在 CP-01 之后）
```

（12d 的「由」值按 5.1 更正为 `edf31377…`；第十五轮写的 `ac7bdd53…` 是我记错的字段。）

第十四轮 10.2／10.3 的两条结论本轮仍未受影响：`Status24ChainDependencyFinding.md` 的因果链与控制器实现无关；`HostLossTerminalRecord.md` 对 CP-01 的说法仍然过重——两份 schema（`510f3b90…`、`fae1e856…`）在新控制器里一个字节都没变。

---

## 八、对实施方的一句话

**R15-F1 和 R15-F2 是真闭合的，我执行验证过，不是纸面上的。** 而且「把修实例升级成修一类」这个判断是对的方向——我第十五轮给的修法是五个手工步骤，你看出那是个会重复失效的链，造了工具去求不动点。我从 `0f8edc0` 重跑了你的工具，三轮收敛、三个文件的字节与你交的完全一样：**你说的每一句关于那条链的话都是对的，而且你确实没有手改。**

**但你把那条链画短了一节，而你的闸门正好在那一节前面停住了。**

真实的链是 `parent600.py ← fixed_host.py ← bridge.py ← host-effect.mjs`。你的闸门注释写着「修下游会改变自身摘要从而使上游的钉再次失效」——这句话对 `host-effect.mjs` 同样成立，而且它**已经发生了**：你改了 `bridge.py:16` 一行，`bridge.py` 的摘要从 `60e4cfac…` 变成 `c43c32a0…`，而 `host-effect.mjs:14` 还钉着 `60e4cfac…`——那个值现在指向**前代**的 `bridge.py`。我实测 `invokeFixedHost` 的第一次调用抛 `EXACT_PYTHON_BRIDGE_BYTES_REQUIRED`，而且抛在 `bridge.py` 被启动之前，所以你刚修好的 `load_host()` 根本执行不到。

我第十五轮第六节的修法第③步写的就是这一处，并且专门标注了「这一处现在是对的，但②会让它失效——**这正是本轮要防的那个坑**」。你造了工具去防它，工具没覆盖它。

**所以最要紧的不是 F1 这一处，而是为什么闸门看不见它。**

你的闸门用两条正则认钉。我量化过：控制器目录里 35 个 64-hex 常量，其中 11 个是文件钉，**它认出 2 个**。漏掉的 9 个里有 4 个是跨目录钉、3 个是绝对路径钉、2 个在 `.mjs` 里——而那 2 个 `.mjs` 的钉里，恰好有一个是**同目录兄弟钉**，恰好是现在坏的那一个。

而且漏掉的时候它不说自己漏了。它说 `sibling pins consistent`，退出 0。我试了四种完全无害的编辑——**仅仅在两行之间插一行注释**、把变量名从 `_SHA` 改成 `_DIGEST`、路径改用 `os.path.join`、单引号改双引号——每一种都让它静默失明并宣布一致。钉指向一个不存在的文件时，它打印 `MISSING TARGET` 然后照样宣布一致、退出 0。

这就是为什么「`build-linux-manifest.mjs` 拒绝为自相矛盾的控制器出清单」这句话在你这一版上是假的：我在自己的容器里把四项前提配齐，对你的 head 原样跑了一遍，**闸门放行，302 条清单照出，EXIT=0**。你交的那份 `365ab926…` 就是为一个自相矛盾的控制器出的清单。

你的负向测试没有发现这一点，因为它测的是**视野内**那一种破坏。一个自称能防住一整类错误的工具，负向测试必须打在它的盲区上：在两行之间插一行注释、改一个 `.mjs` 里的钉、把 target 改成不存在的文件名——这三条要求都 exit 1，才算测过。

**修法不要再加正则。** 再加两条只是把盲区挪个地方，而盲区是静默的——这正是这一轮重犯的机制。要做成 fail-closed：枚举全部 64-hex 常量，要求**每一个都被解释**，解释不了就 exit 1，非文件摘要走一张写明理由的显式白名单。顺带把覆盖率打印出来——一个不报覆盖率的检查器，没法区分「全绿」和「全瞎」。

**两件你做对了、我要明确记下的事。**

一是证据文件。R14-N5 是我第十四轮提的，你做的比我要求的完整：88 行加 14 行逐行数据，加上 `pg_stat`、七个触发器（**这里你已经是 7 个了，比更正书里的「三个」准确**）、冻结行数、派生分析。而且那个 `n_tup_ins=92` 的交叉核对——**我起初认为它不成立**，因为我以为回滚的插入不计入 `n_tup_ins`。我去查了 PostgreSQL 17 的源码，`pgstat_relation.c` 里那行注释是 `count attempted actions regardless of commit/abort`，**是我错了，你的推理成立。** 而且比你说的更强：`n_dead_tup` 也正好是 4，`n_tup_upd=0` 独立排掉了 HOT 更新和普通更新，我自己重算的 ctid 空槽也正好是 `(4,1) (4,2) (5,2) (5,7)`。你把它标成「仅佐证、承重的是 ctid 与 xmin 顺序」——这个定性是对的，因为 `pg_stat` 计数器可被 reset、不是崩溃安全的，而 ctid 和 xmin 是堆页里的物理事实。该谨慎的地方你谨慎了。

二是清单枚举。「沿用前代 + 手工补」会漏掉新文件，这个自我诊断是准确的，而且改法是对的：我核过前代那 144 条**一条都没被挤掉**（因为是追加式、用 `listed` 去重），新增的正好是 `build-linux-manifest.mjs` 和 `check-sibling-pins.mjs` 两条。我还在自己的容器里**逐字节重建出了 `365ab926…`**——不是逐条校验，是整个清单文件字节相同。

但枚举用 `readdirSync` 换来了一个新毛病：我在目录里放了 `notes.txt`、`bridge.py.orig`、`.DS_Store`，**三个全进了清单**（302 → 305）。之后它们被删掉，第 3 步就 `EXACT_CONTROLLER_SOURCE_BYTES_DRIFT`。换成 `git ls-files` 就两头都占：新文件不会漏，未跟踪文件不会进。

最后一件小事，但跟信用有关：你说控制器目录 21 个文件，实际是 20（清单列 19 条，正确地不列自身）。这个数字不影响任何结论，我提它只因为**这一轮你的自述数字仍有不准的地方**，而你的自述是下一个评估者的起点。

还有一处是我自己要认的。我第十五轮写「生效绑定 `controller_sha256 = ac7bdd53…`，对应 `root5-window5-forward11`」，并据此推断「python 三件套是从当前在绑的那一代复制来的」。本轮直查 `execution_binding`：值是 `edf31377…`，指向 **runtime600**，而且该表 `n_tup_upd=0`，从来没被改过——**是我上一轮把一个别处的摘要误记成了这个字段，那个因果推断没有依据，我撤回。** 第 1 步过不去这个结论不变，只是「过不去」的对照目录不是我上一轮说的那个。

---

## 边界（再述）

未写库、未注册代际、未消耗那唯一一次 600 秒分配、未预留预算、未调用 `append_event` 或任何会写库／消耗预算的函数、未执行任何 `do $$ … $$` 块。全部 SQL 为 `select`。
【实测】收尾复核（与开篇一致）：`charged_seconds` 仍 **9906**（上界 10506）、`charged_evidence_bytes` 仍 2201594803、`current_head` 仍 root5（`ctrgen_e5df4322…`）/ sequence 5 / revoked false、`active_ga_id` 与 `pending_budget_sequence` 均为 null、`events` 5 行、`execution_events` 88 行、`gate_attempts` 14 行、`control_objects` 23 行、`execution_binding` `n_tup_upd` 仍为 0。
本轮为做只读检查，在容器里下载过 `gh v2.63.2` 的公开 release、在临时 worktree 与主克隆里按 lockfile 安装过 `node_modules`（已删除）、跑过 `check-sibling-pins.mjs` 与 `build-linux-manifest.mjs`（后者的 `--write` 仅在我自己的临时 worktree 与临时副本中执行，实施方检出的那份 worktree 只读）。**未起 600 秒容器、未创建任何容器、未走 GA 通路、未签发 GA。**
未修改实施方检出的任何文件；全部敌意测试在临时副本上进行，临时产物已删除；主克隆工作树已复原为干净状态。
**本文件不签发资格、不签发运行时受理、不构成授权、不批准也不合并任何 PR。** 最终裁量权在 Owner（`tdoljyj`）。
CI 五项长期全红、日志 404，已确认非瞬时；本文件不把它记作通过，也未尝试修复。
