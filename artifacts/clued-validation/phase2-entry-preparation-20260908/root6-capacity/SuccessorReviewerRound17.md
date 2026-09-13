# 第十七轮独立评审：自称 fail-closed 的闸门、自称已封死的绕过

**状态：`BLOCKED_NOT_QUALIFIED_NO_WRITE_PERFORMED`。**

**裁定：不予资格化。R16-F1 确已闭合；`__pycache__` 那条发现真实、重要、而且是实施方自己查出来的，方向确实在改善。但本轮三条阻断项：新闸门不是它自称的 fail-closed（七种绕过实测放行，其中一种就是 R16-F1 原封不动、只换了写法）；`__pycache__` 的修法只封住了四个同类入口中的一个（跨目录那三个实测仍可绕）；以及一条前十六轮都没人碰过的：这台 Linux 宿主上，`fixed_host.py` 仍硬性要求 `sys.platform == 'win32'`，`CREATE` 永远走不通。**

未写库、未注册代际、未消耗那唯一一次 600 秒分配、未预留预算、未调用 `append_event` 或任何会写库／消耗预算的函数、未执行任何 `do $$ … $$` 块。全部 SQL 为 `select`。
【实测】边界复核（本轮首尾各一次，两次一致，见第九节）：`charged_seconds` = **9906**（上界 10506）、`charged_evidence_bytes` = 2201594803、`current_head.generation_id` = `ctrgen_e5df432221344996afc04b5638121d96`（root5）、`sequence` = 5、`active_ga_id` = null、`pending_budget_sequence` = null、`clued_control.events` = 5 行、`execution_events` = 88 行、`gate_attempts` = 14 行、`control_objects` = 23 行、`execution_binding.controller_sha256` = `edf31377…`、该表 `n_tup_upd` = 0。**全部未动。**

未起 600 秒容器、未创建任何容器、未走 GA 通路、未签发 GA。未修改实施方检出的任何文件。未合并任何 PR、未批准任何东西。最终裁量权在 Owner（`tdoljyj`）。
CI 五项长期全红、日志 404，已确认非瞬时；本文件不把它记作通过，也未尝试修复。

评审对象：实施方分支 `claude/nice-fermat-njqlmm` head **`c578af3`**，`main` = `2c3a6f9`。
本评估者分支 `claude/trusting-keller-mm2s0v`（第十轮至第十七轮同一条）。

---

## 零、先说结论

| 问 | 实施方的主张 | 本轮裁定 |
| --- | --- | --- |
| (1) R16-F1 | 已修，失败点落到「下游的假授权」 | **闭合**【实测】字节检查已过、`bridge.py` 已启动、`load_host()` 已执行。**但「失败点是假授权」不实** —— 真实失败点是 `fixed_host.py:57` 的 Windows 平台闸，见第一节与 R17-F1 |
| (2) 闸门 fail-closed | 「每一个字面量都必须被解释，否则拒绝」 | **不是。这是本轮重点阻断项 R17-F3。** 七种改动实测放行，含 R16-F1 原样改写成字符串拼接 |
| (2) 具名声明／结构化识别「不会被滥用」 | 「tied to the syntax，stray digest 借不到豁免」 | **借得到**【实测】在同一文件里加**一行注释**即可，两种豁免都能借。见 2.4 |
| (2) 索引收整棵 QUAL 树是否太宽 | 未声称 | **太宽**【实测】钉成树里任何无关文件的摘要即放行；钉成**本目录另一个文件**的摘要也放行。见 2.3 |
| (2) `--write` 的修复规则 | 「按身份修复，覆盖任何形状」 | **只覆盖一种历史形态**【实测】本目录无同名文件即不修不报；**本轮修复必然产生的陈旧钉它修不了**。且会静默改写记录历史摘要的注释、会改写被结构化豁免的摘要。见 2.6 |
| (2) 大小写／跨行／拼接 | 未声称 | **全部看不见**【实测】大写、`'a'+'b'` 拼接都逃过正则，且逃得静默。见 2.5 |
| (3) `__pycache__` 是一条已证实的绕过 | 是 | **成立，我独立复现了两次**，并在**真实控制器**上把 600 秒上限改成 999999。见 3.1–3.2 |
| (3) 修法「双向拒绝」 | 构建期＋运行期两道 | **两道都真的触发，运行期确在逐文件校验之前**【实测】。**但只封了控制器目录这一个入口**；四个「先校验摘要再 exec」的跨目录模块全部仍可绕。阻断项 R17-F2。见 3.4 |
| (3) 标准库钉 44 个 / 控制器删除，不对称是否合理 | 合理 | **不对称本身合理，但执行不完整**【实测】真实运行路径上还有 2 个标准库模块（`platform`、`uuid`）连 `.py` 带 `.pyc` **都不在 302 条里**。见 3.5 |
| (3) 同类的其它缓存 | 未声称 | Node 的 v8 compile cache / `NODE_COMPILE_CACHE`**不是**同类绕过【实测】；ajv 无磁盘缓存；`-I` 已挡住 `PYTHONPYCACHEPREFIX`【实测】。见 3.6 |
| (4) 清单 302 条诚实 | 302、`f8ce675b…` | **诚实**【实测】302/302 逐条核对通过、清单文件在本容器**逐字节重建**出同一摘要 |
| (4) 闸门入清单有无循环 | 未声称 | **有一条实在的信任回路**：闸门的索引由**清单**播种，改清单一行即可把任意钉洗白【实测】。见 4.3 |
| (5) 可信入口端到端 | 「全链通」 | **属实**【实测】我自己跑通了。**但通到的是一条走不到活儿的路**（R17-F1），且入口验证的是「`cli.mjs` 起得来」，不是「控制器干得成事」 |
| (6) 余留项 | —— | 逐条见第六节 |
| (7) 能不能资格化 | —— | **不能。三条阻断项** |

**三条阻断项：**

- **R17-F1【阻断，最严重，前十六轮无人碰过】** 这是 `control-context-verifier-root6-**linux**-successor`，而 `fixed_host.py` 第 56 行与第 116 行仍写着 `if sys.platform != 'win32' ... raise`，并依赖 `observe.py` 里硬编码的 `C:/Program Files/Docker/Docker/resources/bin/docker.exe`。【实测】`CREATE` 在 `fixed_host.py:57` 抛 `ValueError: Exact Windows Docker host required`。**在这台 Linux 宿主上，600 秒容器创建不出来 —— 不是因为环境缺东西，是因为代码拒绝在 Linux 上运行。**
- **R17-F2【阻断】** `__pycache__` 的封堵只覆盖控制器目录。【实测】在 `docker-engineering-observation/` 放一个伪造的 `observe.cpython-311.pyc`：`observe.py` 的 sha256 一字未变、`load_host()` 成功、`observation.DOCKER` 变成攻击者指定的路径、构建期闸门 EXIT=0、运行期入口不查那个目录。
- **R17-F3【阻断】** 新闸门不是 fail-closed。【实测】七种改动放行，其中 **A6 就是 R16-F1 本身**，只是把 64 位十六进制拆成 `'60e4cfac…'+'…64fd7'`：闸门打印 `digest pins consistent`、EXIT=0，`build-linux-manifest.mjs` 照出 302 条清单，而 `invokeFixedHost` 的第一次调用抛 `EXACT_PYTHON_BRIDGE_BYTES_REQUIRED`。**「拒绝为自相矛盾的控制器出清单」这句话，在 `c578af3` 上仍然是假的。**

---

## 一、(1) R16-F1 —— 闭合，用执行验证【实测】

### 1.1 钉已改对

```
host-effect.mjs:14   bridge 钉 = c43c32a07ede6088888a7d17c20c3914c137060ddb779ac54d594405dd06f40c
本目录 bridge.py 实测 = c43c32a07ede6088888a7d17c20c3914c137060ddb779ac54d594405dd06f40c   ✅
host-effect.mjs:14   python 钉 = f56a588548dd013906ae1dcd1b6faa417f4e204da634ff354840d9643e78ff9e
/usr/bin/python3.11 实测        = f56a588548dd013906ae1dcd1b6faa417f4e204da634ff354840d9643e78ff9e   ✅
```

### 1.2 直接调 `invokeFixedHost`（第十六轮 6.2 节的验收要求第 2 条）

```
$ node -e "invokeFixedHost({operation:'CREATE',deadline:Date.now()+60000,gaRaw:'{\"gate_authorization_id\":\"ga_0…0\"}',containerId:null})"
THROW: Command failed: /usr/bin/python3.11 -I -S -B -X utf8 …/bridge.py
EXITCODE: 2
STDOUT: {"reason":"ValueError","state":"UNKNOWN", …}
```

**不再是 `EXACT_PYTHON_BRIDGE_BYTES_REQUIRED`，已经越过字节检查并真的启动了 `bridge.py`。R16-F1 闭合。**

### 1.3 但失败点不是实施方说的那个 —— 这一条必须更正

实施方 commit 写：「invokeFixedHost now gets past the byte check and **fails downstream on the dummy authorization**, which is the expected place.」

`bridge.py:107` 把异常吞成 `{"reason": "ValueError"}`，只看类型名是看不出落点的。我把三段拆开逐段执行，取真实 traceback：

```
【实测】
bridge import OK
parse OK                 ← 假授权在这里就该被挡住，如果那真是失败原因的话
load_host OK -> trusted_fixed_host_port
Traceback (most recent call last):
  File "…/bridge.py", line 73, in dispatch
    h.prepare(nonce, value['ga_raw'])
  File "…/fixed_host.py", line 57, in prepare
    raise ValueError('Exact Windows Docker host required')
ValueError: Exact Windows Docker host required
```

**`parse()` 通过了 —— 那个「假授权」被完整接受了。** 失败在 `prepare()` 的第一行，是一道**平台闸**，与授权无关。这就是 R17-F1，见第五节。

**记一句：这是实施方本轮第三次把一个自述数字／判断说错**（前两次：索引重建丢宿主条目、测试方法误判自己的实现）。三次都是自查时发现的方向对、结论细节错。**自述仍不可直接采信。**

---

## 二、(2) 新闸门 —— 本轮重点，不是 fail-closed

### 2.1 先确认它的正面声称：四条全部属实【实测】

实施方声称四组敌意测试全部拒绝、干净状态通过。我把整棵 `scripts/phase2-qualification` 树复制到临时目录逐条重做（配齐前提：`gh v2.63.2` 装到 `/usr/local/bin/gh`、`ajv@6.15.0` 按 lockfile 装好）。

```
干净状态                                         digest pins consistent (43 accounted, 0 unexplained)  EXIT=0
A7  host-effect 钉前代 bridge.py（R16-F1 原样）   UNEXPLAINED … is …root5-window5-forward11-successor/bridge.py  EXIT=1  ✅
A3a 任意未知摘要作钉                             UNEXPLAINED … matches no file                                 EXIT=1  ✅
A8  只给被钉的 parent600.py 加一行注释            UNEXPLAINED fixed_host.py: 7f952787e57d matches no file       EXIT=1  ✅
A10 目录内存在 __pycache__                       UNEXPLAINED __pycache__/ exists beside the controller         EXIT=1  ✅
```

**四条全真，43 这个数字也对。** 而且比它自己说的多一条：

```
A9  改动跨目录被钉文件 docker-engineering-observation/observe.py
    → UNEXPLAINED fixed_host.py: cc3498e6dc5e matches no file    EXIT=1  ✅
```

**第十六轮 2.8 节点名的跨目录缺口，这一版真的补上了。** 这是实打实的进步，方向是对的。

**问题在于「必须被解释」这四个字，实际的判据比字面意思松得多。**

### 2.2 判据的实际形状【读文本 + 实测】

`check-digest-pins.mjs:139-149` 的核心是这样：

```js
const owners = index.get(lit) || [];                                   // 全树 + 清单里的绝对路径
const mine   = owners.filter(o => path.dirname(o) === DIR);
const stale  = owners.filter(o => path.dirname(o) !== DIR && fs.existsSync(path.join(DIR, path.basename(o))));
if (stale.length && !mine.length)                     → 报错
else if (owners.length || attempts.has(lit) || DECLARED_NON_FILE[lit]) → accounted
else                                                  → 报错
```

**它从头到尾没有「钉」这个概念。** 它不解析任何一处钉指向谁，只问一句：「这个 64 位字面量，是不是**某个**文件的摘要？」是，就算解释过了。

于是「解释」这个词被偷换了：*「这个值是某个文件的摘要」* 被当成了 *「这个值是它应该是的那个文件的摘要」*。前者几乎总是成立 —— 索引里【实测】有 **940 个不同摘要、1083 条路径**。

唯一真正做语义判断的，是 `stale` 那一条：**「字面量等于前代同名文件的摘要，且本目录有同名文件」**。这一条正好命中 R16-F1 的形状，所以四组自测全过。但它只是**一条签名**，不是一条不变式。

### 2.3 索引收整棵树 —— 太宽，两种放行【实测】

```
A2  host-effect.mjs 把 bridge.py 钉成 cli.mjs 的摘要（本目录另一个文件）
      闸门  digest pins consistent (43 accounted, 0 unexplained)   EXIT=0     ❌
      运行期 EXACT_PYTHON_BRIDGE_BYTES_REQUIRED

A1  host-effect.mjs 把 bridge.py 钉成 docker-engineering-observation/validation.py 的摘要（树里毫不相干的文件）
      闸门  digest pins consistent (43 accounted, 0 unexplained)   EXIT=0     ❌
      运行期 EXACT_PYTHON_BRIDGE_BYTES_REQUIRED
```

A2 尤其要紧：它走的是 `mine.length` 那个出口 —— **只要字面量碰巧等于本目录任何一个文件的摘要，`stale` 这条唯一的语义规则就被整条跳过。** 也就是说，闸门唯一会捉的那种错，可以用「指向本目录另一个文件」来豁免掉。

### 2.4 具名声明与结构化识别 —— 借得到，一行注释就够【实测】

闸门的注释写着：

> Structural recognitions, each tied to the syntax that gives the literal its meaning, **so a stray digest cannot borrow the exemption**

【实测】借得到。`attempts` 是**按文件收集的一个值集合**，正则在**整个文件文本**（注释在内）上跑，然后对该文件里**任意位置**的同值字面量放行：

```
A3a  任意摘要 dead0beef123… 作 bridge 钉，不加伪装
       UNEXPLAINED … matches no file                      EXIT=1   （对照组）

A3b  同一个摘要 + 在同一文件末尾加一行注释：
       // git/blobs/0123456789abcdef0123456789abcdef01234567', sha256: 'dead0beef123…'
       digest pins consistent (43 accounted, 0 unexplained)  EXIT=0  ❌

A4   同一个摘要 + 在同一文件末尾加一行注释：
       // "ga_00000000000000000000000000000000":'dead0beef123…'
       digest pins consistent (43 accounted, 0 unexplained)  EXIT=0  ❌
```

两种结构化豁免都能被一行注释借走。`BLOBREF_PIN` 里那个 40 位十六进制也不校验，写 40 个 `0` 就行。

**声明表本身的内容是诚实的**，这一点要说清楚。8 条具名声明我能独立核的核了 5 条【实测】：

```
cb5704c053850f1484f39f4396d638f2e603b7df48f6eb7045fea36b8f072654
   = sha256('select clock_timestamp() as observed_at, clued_control.read_execution() as execution')   ✅ 逐字节
1640995831b0c1f8ae616810e12eb7b97ee191e9f20b5c38eee32eb8bfac9d23
   = DB root5 issuer_bindings[STATUS].qualification_ref.sha256                                        ✅ 直查活库
80cf8f471248ae76e5a637b5f94f20f4863a243c7011e5728de86cb5fc7cf5d2
   = DB root5 issuer_bindings[GATE_AUTHORIZATION / GATE_RESULT].qualification_ref.sha256              ✅
acaf2073c654be95a3beab820f1460de1e6e68caa267e9c75bdd3c891bd894b3
   = DB 第 3 代 issuer_bindings[STATUS].qualification_ref.sha256                                      ✅
b6d4782fcf79cf599f3ccc7e2c7b7434e41a26c6d4a28c6711eac0c9f469e146
   = DB 第 3 代 issuer_bindings[GATE_AUTH / GATE_RESULT].qualification_ref.sha256                     ✅
```

**问题不在这张表写了什么，在于这个豁免机制是按「值」而不是按「位置」生效的。**

### 2.5 大小写、拼接 —— 看不见，而且看不见得静默【实测】

`HEX = /\b[a-f0-9]{64}\b/g`，只认小写、只认连续 64 位。

```
A5  钉改写成大写（前代 bridge.py 摘要的大写形式）
      digest pins consistent (42 accounted, 0 unexplained)   EXIT=0   ❌

A6  钉拆成两段字符串拼接 —— 这就是 R16-F1 本身，只换了写法：
      sha(fs.readFileSync(bridge))!=='60e4cfac015c15fd53921a61a6566f74'+'0e7414f218120b0bdbc17bf17be64fd7'
      闸门   digest pins consistent (42 accounted, 0 unexplained)   EXIT=0   ❌
      运行期 invokeFixedHost → THROW: EXACT_PYTHON_BRIDGE_BYTES_REQUIRED
```

注意那个 `42`。唯一的信号是「解释过的字面量少了一个」，**而这个数字不和任何期望值比对**，没有基线、没有断言、没有提示。第十六轮 R16-N3 要求「打印覆盖率」，这一版打印了分子，没有分母。**一个不报分母的覆盖率，和不报覆盖率是一回事。**

### 2.6 完整的 A 系列对照表【实测】

每一项都是：从干净副本重建 → 施加一处改动 → 跑 `node check-digest-pins.mjs` → 取真实退出码（`OUT=$(node …); RC=$?`，不经管道）。

| # | 改动 | 闸门 EXIT | 该改动在运行期的后果 |
| --- | --- | --- | --- |
| A7 | host-effect 钉前代 `bridge.py`（R16-F1 原样） | **1** ✅ | throw |
| A8 | 只给被钉的 `parent600.py` 加一行注释 | **1** ✅ | import 期 drift |
| A9 | 改跨目录被钉文件 `observe.py` | **1** ✅ | import 期 drift |
| A10 | 目录内存在 `__pycache__` | **1** ✅ | 字节码绕过 |
| A3a | 任意未知摘要作钉 | **1** ✅ | throw |
| **A2** | 钉成**本目录另一个文件**（`cli.mjs`）的摘要 | **0** ❌ | `EXACT_PYTHON_BRIDGE_BYTES_REQUIRED` |
| **A1** | 钉成树里**无关文件**（`validation.py`）的摘要 | **0** ❌ | `EXACT_PYTHON_BRIDGE_BYTES_REQUIRED` |
| **A3b** | A3a ＋一行伪 blob-ref 注释 | **0** ❌ | `EXACT_PYTHON_BRIDGE_BYTES_REQUIRED` |
| **A4** | A3a ＋一行伪 `ga_` 注释 | **0** ❌ | `EXACT_PYTHON_BRIDGE_BYTES_REQUIRED` |
| **A5** | 钉写成**大写** | **0** ❌ | `EXACT_PYTHON_BRIDGE_BYTES_REQUIRED` |
| **A6** | 钉拆成 `'x'+'y'` **拼接**（＝ R16-F1） | **0** ❌ | `EXACT_PYTHON_BRIDGE_BYTES_REQUIRED` |
| **A11** | 把 `bridge.py` **改名**，钉一字不动 | **0** ❌ | `ENOENT: no such file or directory …/bridge.py` |
| **A12** | 往**清单**里加一条绝对路径条目，洗白任意钉 | **0** ❌ | `EXACT_PYTHON_BRIDGE_BYTES_REQUIRED` |
| A13 | 控制器目录的**子目录**里放 `.py`（闸门与清单都不扫） | **0** | 当前无副作用 |

**A11 要单独说：** 第十六轮 R16-F2 的第二条（`MISSING TARGET` 必须 exit 1，即 R14-F2 那一类「改名忘改钉」）**没有闭合，只是换了失明方式**。旧闸门至少还打印一行 `MISSING TARGET`；新闸门连这行都没有 —— 它压根不知道「target」是什么概念，`c43c32a0…` 仍然等于那个被改名的文件，于是 `mine.length` 成立，直接 accounted。

### 2.7 `--write` 的修复规则 —— 四个问题【实测】

**(a) 本目录没有同名文件 → 既不修也不报。** `:105-107` 的 `if (!fs.existsSync(here)) continue;`。验证端同一个 `existsSync` 条件让 `stale` 为空，于是走 `owners.length` 出口 accounted。A1 就是这种：

```
W2  钉 = validation.py 摘要，跑 --write
      digest pins consistent (43 accounted, 0 unexplained)   EXIT(--write)=0
      钉仍是 3ac10b11456d / bridge.py 实际 c43c32a07ede
      runtime THROW: EXACT_PYTHON_BRIDGE_BYTES_REQUIRED
```

**(b) 多个前代候选 —— 当前不会改错，但只是运气。** 【实测】我扫了索引：**87 个摘要对应多条路径，但「同一摘要对应两个不同 basename」的有 0 个**。所以 `for (const o of elsewhere) … break` 的顺序依赖当前不触发。一旦树里出现一份内容相同、名字不同的副本（换代时复制文件是常规动作），修复目标就由 `readdirSync` 的返回顺序决定。**这是潜在的，不是现实的，不计入阻断项。**

**(c) 会静默改写记录历史摘要的注释 —— R16-N4 未闭合，且 `split/join` 使它一次改全。**

```
W3  在 host-effect.mjs 第一行加：
      // For the record: the predecessor controller shipped bridge.py at 60e4cfac015c…
    跑 --write：
      round 1  host-effect.mjs pins bridge.py: 60e4cfac015c (…forward11-successor) -> c43c32a07ede
      repaired 1 pin(s) over 2 round(s)
    第 1 行变成：
      // For the record: the predecessor controller shipped bridge.py at c43c32a07ede…
```

**一行记录「前代发过什么」的历史事实，被改写成了当前值，计数只报 1。** 对一个以「摘要即证据」立身的体系，这是在伪造记录。

**(d) 修复完全不尊重它自己的豁免表。** 修复循环里没有任何 `DECLARED_NON_FILE` / `attempts` 检查，它对文件里**每一个**字面量一视同仁。构造：在前代目录里新增一个 `cli.mjs`（换代时往树里加文件是常规动作），把它的摘要写进 `context.mjs` 里、形状正好是被结构化识别的 `"ga_…":'…'`：

```
W5  报告模式  UNEXPLAINED context.mjs: 1ef6e662d3c0 is …runtime600/cli.mjs, not this controller's copy   EXIT=1
    写模式    round 1  context.mjs pins cli.mjs: 1ef6e662d3c0 (…runtime600) -> 23e5c73b8af5
              repaired 1 pin(s) over 2 round(s)                                                          EXIT=0
    那条 attempt 记录被改成了本目录 cli.mjs 的摘要
```

**豁免在一个方向上被滥用（给任意摘要放行），在另一个方向上被无视（把合法的声明摘要改掉）。两头都错。**

**(e) 失败时仍不回滚。** `:120` 的 `round > 20` 之前文件已被改了 21 轮并留在磁盘上。R16-N4 后半未闭合。

### 2.8 一条对排期最要紧的实测：`--write` 修不了接下来必然出现的陈旧钉

修 R17-F1 必须改 `fixed_host.py`。我模拟了那一步（只往 `fixed_host.py` 追加一行）：

```
【实测】node check-digest-pins.mjs --write
  UNEXPLAINED  bridge.py: 773f5b29ee14 matches no file and is not a declared non-file digest
REFUSED: 1 digest literal(s) unexplained            EXIT=1
bridge.py 的 HOST_SHA 仍是 773f5b29ee14 ／ fixed_host.py 实际已是 01d6b69ead4a
```

**它报错，但不修。** 因为 `773f5b29…` 现在不等于任何文件 —— 它不符合「等于前代同名文件」这条唯一的签名。「repair by identity, works for any shape added later」这句话，对**历史遗留**的四处成立，对**本轮修复即将产生**的陈旧钉不成立。第七节的排期据此写，必须手改并逐级手推。

### 2.9 「拒绝为自相矛盾的控制器出清单」在 `c578af3` 上仍然是假的【实测】

我在 `/home/user/cross-memory-system` 下（配齐四项前提），把 R16-F1 用 A6 的写法放回去，原样跑生成器：

```
$ node -e "invokeFixedHost({operation:'CREATE',…})"
runtime THROW: EXACT_PYTHON_BRIDGE_BYTES_REQUIRED          ← 控制器确实是坏的

$ node build-linux-manifest.mjs
digest pins consistent (42 literal(s) accounted for, 0 unexplained)   ← 闸门放行
files       302 {"RUNTIME_DEPENDENCY":156,"REPOSITORY_SOURCE":146}
BUILD EXIT=0
```

**同一句结论、同一个退出码、同一份 302 条清单。上一轮是 `sibling pins consistent`，这一轮是 `digest pins consistent`。缺陷类完全一样，只是我这次要多打一个 `+` 号。**

### 2.10 怎么修才算修了这一类 —— 第三次说同一件事

前两轮我说过「不要再加正则」，这一轮它没有加正则，改成了按身份匹配 —— 方向对。但**换了一种签名，仍然是签名**。签名的补集永远是静默的。

**唯一的出路是把「钉」变成一等公民，让被钉对象在源码里可被静态提取，然后校验的是「这个钉指向的那个文件的实测摘要」，而不是「这个值是不是某个文件的摘要」。** 具体：

1. **钉必须成对声明。** 一处钉 = (目标路径, 期望摘要)，两者在同一处、可被静态抽取。最省事且可靠的形式：让路径以一个完整的仓库相对路径字面量出现在紧邻位置。校验＝`sha256(解析后的路径) === 期望摘要`，路径不存在即 exit 1（这就把 A11 一并解决了）。
2. **索引只用于回答「这个陈旧值曾经属于谁」这一个诊断问题**，绝不用于「解释」。`owners.length` 不能是通过条件。
3. **非文件摘要一律走具名表，且表项必须绑定到出现位置**（文件名＋行号，或一个不可能出现在注释里的语法锚点），不能按值全文件放行。这样 A3b／A4 就借不到。
4. **常量枚举必须对大小写不敏感，并对「疑似被拆开的摘要」报警**：同一行里出现两个以上 16/32 位十六进制字符串连接的，视为可疑，exit 1。做不到完备就要做保守。
5. **打印分母并断言它。** 把「本控制器应有 N 个 64-hex 字面量、M 个文件钉」写成硬编码期望值，数量对不上即 exit 1。A5／A6 会立刻被 `43 → 42` 抓到。
6. **`--write` 只许改被判定为钉的那一处**（行内锚定），不许 `split/join` 全文件；豁免表里的值一律不许改；失败回滚。

**验收方法不变，而且请把负向测试打在盲区上**，这一条第十六轮写过、这一轮仍然适用，只是清单更长了：A1、A2、A3b、A4、A5、A6、A11、A12 —— **这八条都要 exit 1，才算测过。** 四条打在视野内的测试证明不了 fail-closed。

---

## 三、(3) `__pycache__` —— 发现成立，修法只封了四分之一

### 3.1 我自己复现了，没有采信描述【实测】

合成实验，与实施方描述同形但完全独立构造：

```
victim.py:  SECRET_LIMIT = 600
loader.py:  先算 sha256，再 spec_from_file_location + exec_module

基线（-I -S -B，无缓存）
  victim.py sha256 = ee94baf05bd2147e2a3d06b8b380612a4935656972a2489a7cb84da212062ef9
  dont_write_bytecode = True
  SECRET_LIMIT = 600

伪造：把 SECRET_LIMIT = 999999 的源编译成 code，
      头部写 MAGIC + flags=0 + victim.py 的 mtime + victim.py 的 size + marshal(code)

再跑（同一条命令，victim.py 一字未动）
  victim.py sha256 = ee94baf05bd2147e2a3d06b8b380612a4935656972a2489a7cb84da212062ef9   ← 未变
  dont_write_bytecode = True
  SECRET_LIMIT = 999999                                                                 ← 已被替换
```

**`-B` 只挡写不挡读，时间戳式 `.pyc` 的有效性判据写在它自己头部 —— 全部属实。**

### 3.2 更进一步：我在真实控制器的真实加载路径上做了一次【实测】

合成实验只证明机制。我把同样的手法用在 `bridge.py → load_host() → fixed_host.py` 这条线上，篡改的是**那个 600 秒上限本身**：

```
改前：
  fixed_host.py sha256 = 773f5b29ee14c9dcafe7…
  load_host() OK   MAX_GA_SECONDS = 600    STOP_RESERVE_SECONDS = 30

伪造 __pycache__/fixed_host.cpython-311.pyc（MAX_GA_SECONDS=999999、STOP_RESERVE_SECONDS=0）

改后：
  fixed_host.py sha256 = 773f5b29ee14c9dcafe7…      ← 一字未变
  load_host() OK   MAX_GA_SECONDS = 999999  STOP_RESERVE_SECONDS = 0
```

`load_host()` 自己那道 `hashlib.sha256(HOST.read_bytes()) != HOST_SHA` 的检查**照常通过**，然后执行了伪造的字节码。**600 秒预算上限和 30 秒停机保留窗口，是这个体系里最不该被静默改掉的两个常量。这条发现的严重性不低于实施方自己的评估，甚至更高。**

### 3.3 两道拒绝都真的触发，运行期那道确在逐文件校验之前【实测】

```
构建期：mkdir __pycache__ && touch __pycache__/x.pyc
  UNEXPLAINED  __pycache__/ exists beside the controller modules: …  REFUSED  EXIT=1     ✅

运行期：用 JS 求值出 tool-entry.functions.js 里那段模板字面量的真实字符串，原样执行
  CONTROLLER_BYTECODE_CACHE_PRESENT                                            EXIT=1     ✅

顺序证明：同时（a）植入 __pycache__ 且（b）把清单里列的 cli.mjs 改一字节
  CONTROLLER_BYTECODE_CACHE_PRESENT                                            EXIT=1
  ← 字节码检查先赢，确在 `for e in d["files"]` 之前（tool-entry.functions.js:53 vs :55）  ✅
```

**这两条声称我核实了，属实。**

### 3.4 【阻断】R17-F2：只封了四个同类入口中的一个

构建期是 `fs.existsSync(path.join(DIR, '__pycache__'))`，运行期是 `os.path.isdir(os.path.join(os.path.dirname(man), "__pycache__"))`。**两处都只看控制器目录一个。**

而「先校验摘要、再 `spec_from_file_location` + `exec_module`」这个**完全相同**的模式，在控制器里有**四处是跨目录的**：

| 加载方 | 被加载文件 | 钉值 |
| --- | --- | --- |
| `fixed_host.py:34-35` | `docker-engineering-observation/observe.py` | `cc3498e6…` |
| `parent600.py:24-25` | `docker-engineering-observation/validation.py` | `3ac10b11…` |
| `parent600.py:26-27` | `qualification-runtime/remote_evidence.py` | `a7373982…` |
| `parent600.py:30-34` | `…public-runtime-env-diagnostic-successor/fixed_skill_fixture.py` | `0217a637…` |

【实测】拿第一个做：

```
在 docker-engineering-observation/ 下伪造 __pycache__/observe.cpython-311.pyc
（只把 DOCKER = Path('C:/Program Files/…/docker.exe') 换成 Path('/tmp/attacker-docker')）

observe.py sha256                        : cc3498e6dc5eed1f13fb     ← 一字未变
bridge.py → load_host()                  : OK
h.observation.DOCKER                     : /tmp/attacker-docker     ← 已被替换
node check-digest-pins.mjs               : digest pins consistent   EXIT=0
运行期入口检查 controller __pycache__      : False（不存在，放行）
运行期入口检查 那个目录的 __pycache__      : 根本不检查
```

**`observation.DOCKER` 正是 `fixed_host.py` 第 56 行和第 116 行拿来做二进制校验的那个值。** 换句话说，这条未封的路径直接能把「必须是这个 docker 可执行文件」这道检查指向攻击者选定的文件。

修法很直接：把两道检查从「控制器目录」改成「任何一个会被 `spec_from_file_location` 加载的源文件所在目录」，而那组目录在清单里是已知的。**并且在清单枚举时把这些目录的 `__pycache__` 也纳入拒绝，否则下一代还会重犯。**

### 3.5 标准库钉 44 个 / 控制器删除 —— 不对称合理，但执行不完整【实测】

**不对称本身合理，我同意实施方的判断，理由它写对了**：标准库 `.pyc` 随镜像固化、跨容器逐字节相同，钉得住；控制器自己的 `.pyc` 是生成物，`.py` 一动就变，钉它等于再造一条要同步的链 —— 而这条链正是本轮反复出错的那一类。

**但枚举范围错了。** `build-linux-manifest.mjs:75-88` 只 `exec_module(parent600.py)` 就收 `sys.modules`。真实运行路径是 `bridge.py → fixed_host.py → parent600.py + observe.py`，后两者还会拉进更多模块：

```
【实测】import bridge.py 并调 load_host() 之后，/usr/lib/python3.11/ 下可达的 .pyc：46 个
        其中不在 302 条清单里的：2 个
           /usr/lib/python3.11/__pycache__/platform.cpython-311.pyc
           /usr/lib/python3.11/__pycache__/uuid.cpython-311.pyc
        并且它们的 .py 也不在清单里（platform.py、uuid.py 均为 False）
```

**这两个模块整个 —— 源码和字节码 —— 都在控制器摘要的覆盖之外，而它们会在真实运行中被导入。** 这不是清单说了谎（它列的都对），是清单的枚举口径比实际执行面窄。等同于第 3.4 节的同一个根因：**枚举的起点是 `parent600.py`，而实际入口是 `bridge.py`。** 修法一行：把枚举脚本的 `spec_from_file_location` 目标改成 `bridge.py` 并调用 `load_host()`。

### 3.6 同类的其它缓存 —— 逐条查了【实测】

| 候选 | 裁定 |
| --- | --- |
| **Node v8 compile cache / `NODE_COMPILE_CACHE`** | **不是同类绕过。**【实测】(a) 用缓存跑一次，再改源码，输出是**新**代码；(b) 先用篡改源建缓存，再把源换回原版跑，输出是**原**代码；(c) 用**等长**的不同源（`AAAAAAAA` → `BBBBBBBB`）也各自正确。V8 会拿实际源校验 cached data，不匹配就重编译。**不能做代码替换。** 入口只清 `NODE_OPTIONS`／`NODE_PATH` 不清 `NODE_COMPILE_CACHE`，在这一点上无害 |
| **`PYTHONPYCACHEPREFIX` 重定向缓存目录** | **已被 `-I` 挡住。**【实测】不带 `-I` 时缓存落到 `$PYTHONPYCACHEPREFIX/…`；带 `-I`（隐含 `-E`）时落回本地 `__pycache__/`。入口与 `host-effect.mjs` 都用 `-I`，所以「检查 `__pycache__` 目录」这个位置是对的 —— 只是要覆盖全部四个目录 |
| **ajv 的运行时代码生成** | **不是磁盘缓存。** ajv 6 用 `new Function` 在内存里编译 schema，无 `.jsc` 之类的落盘产物；45 个 ajv 文件全在清单里、schema 文件也在。【读文本】未见任何持久化编译缓存路径 |
| **hash-based `.pyc`（PEP 552）** | 不是新缺口，是**修法方向**：`--check-hash-based-pycs always` 会让 `.pyc` 用源文件哈希而非 mtime/size 校验。可作为「删除并拒绝」之外的加固，但不能替代它 |

**结论：这一类里，CPython 的时间戳式 `.pyc` 是唯一成立的绕过，而它成立是因为校验字段存在被校验对象自己身上。Node 那边不成立。这个不对称是真的，不是运气。**

---

## 四、(4) 清单 302 条

### 4.1 诚实【实测】

```
清单 sha256   f8ce675b30cc1d864ce5e4d942597d0f157c412d6592197c1bb592aeb77d661f   ← 与实施方自述一致
字节          61,918
条目          302 = REPOSITORY_SOURCE 146 + RUNTIME_DEPENDENCY 156               ← 一致
逐条核对      302 / 302 verified，drift 0，missing 0
清单不列自身   ✅        check-digest-pins.mjs 在清单内 ✅
check-sibling-pins.mjs 已从清单移除 ✅（文件已删）
控制器目录内的 __pycache__ 条目：0 ✅
控制器目录文件数：20（清单列 19 条）—— 实施方本轮的自述数字对了
```

四个宿主二进制在本容器的实测摘要与清单**逐字节一致**：`/opt/node22/bin/node` `81925c09…`、`/usr/bin/docker` `18c2a16d…`、`/usr/bin/python3.11` `f56a5885…`、`/usr/bin/cut`／`dash`／`sha256sum`／`test` 全对。

`gh v2.63.2` 第三次独立确认【实测】：tarball 13,069,957 字节 `912fdb1c…`，`bin/gh` `f687dc93…`，与清单及 `trusted-github.mjs:6` 逐字节相同。

### 4.2 逐字节重建成功【实测】

在 `/home/user/cross-memory-system`（检出根必须是这个，见第十六轮 3.7）下配齐前提后原样跑：

```
digest pins consistent (43 literal(s) accounted for, 0 unexplained)
files       302 {"RUNTIME_DEPENDENCY":156,"REPOSITORY_SOURCE":146}
wrote … 61918 bytes
sha256 = f8ce675b30cc1d864ce5e4d942597d0f157c412d6592197c1bb592aeb77d661f
cmp 实施方那份 → 逐字节相同 ✓
```

并且跑了第十六轮验收标准第 4 条（独立交叉核对工具）：

```
$ node work/twentieth-forward/verify-manifest-against-host.mjs …/ControllerSourceManifest.candidate.json --map /=/
"counts": {"verified": 302, "mismatched": 0, "missing": 0, "uncheckable_here": 0}
EXIT=0
```

**`ALL_ENTRIES_VERIFIED` 这个声称属实。**（该工具本身仍是 331 条 Windows 版，`gh_exe` 一节报 `NOT_IN_MANIFEST` 并回显旧的 `e2efa10a…` Windows 钉 —— 不影响 302/302 这个结果，但 R15-N9 仍开。）

### 4.3 循环 —— `check-digest-pins.mjs` 入清单本身没制造循环，但有另一条实在的信任回路

**先答问的那一半：没有循环。** 闸门在 `build-linux-manifest.mjs:31` 于**写清单之前**运行；清单由枚举重算，不读闸门的输出。闸门文件自己作为 REPOSITORY_SOURCE 进清单，只是让它的字节被摘要覆盖，不构成不动点问题。【实测】重建逐字节稳定，即是证明。

**但存在另一条回路，而且可被利用：闸门的索引由清单播种。** `:79-80` 从 `ControllerSourceManifest.candidate.json` 里取出所有绝对路径加进索引。于是：

```
A12【实测】
  ① 把 host-effect.mjs 的 bridge 钉改成某个任意文件 blob.bin 的摘要（01bc0da0e1de）
     闸门：UNEXPLAINED … matches no file                     EXIT=1
  ② 只往清单里追加一条 {"path":"…/blob.bin","role":"RUNTIME_DEPENDENCY",…}
     闸门：digest pins consistent (43 accounted, 0 unexplained)  EXIT=0
```

**往它要保护的那份清单里加一行，就能把任意字面量洗成「已解释」。** 这一轮的具体后果有限（下一次 `--write` 会重算清单、把那条挤掉），但方向是错的：**闸门的信任基应当是文件系统与源码，不该包含它的输出物。**

### 4.4 R16-N2 未做，风险仍在【实测】

`build-linux-manifest.mjs` 仍是 `readdirSync`（`git ls-files` 0 处）。第十六轮 3.4 节实测过的毛病原样保留：临时落在控制器目录的 `.DS_Store`／`.orig`／调试笔记都会进清单，事后被删就是 `EXACT_CONTROLLER_SOURCE_BYTES_DRIFT`。

**而本轮的 `__pycache__` 事故正是这个机制的一次实例** —— 一个临时产生的目录落在控制器旁边，`isFile()` 把它排除出清单，于是清单覆盖不到它。用 `git ls-files` 枚举同时解决两头（新文件不漏、未跟踪文件不进），并且会让「目录里出现了清单管不到的东西」这件事从一开始就不可能。

另外【实测】控制器目录的**子目录**同时是清单和闸门的盲区（A13）：`readdirSync` + `isFile()` 排除子目录，闸门的 `controllerFiles()` 也不递归。当前无副作用，记为 R17-N5。

---

## 五、(5) 可信入口端到端 —— 通了，但通到的是一条走不到活儿的路

### 5.1 我自己跑通了【实测】

按实施方那条教训（不切源码原文，用 JS 求值模板字面量）取出运行期真实命令串，原样交给 `/bin/sh`：

```
(a) expected = 活库里的绑定值 edf31377…（入口真正会用的值）
    ACTUAL_CONTROLLER_SOURCE_MANIFEST_DRIFT     EXIT=1
    ← 第 1 步就停。绑定仍指向 runtime600，与第十六轮 5.1 一致，换绑是写操作，不在本轮权限内

(b) expected = 实际清单摘要 f8ce675b…（为了走完后面几步）
    {"state":"BLOCKED","reason":"BOUNDED_STDIN_INPUT_REQUIRED",…}   EXIT=1
    ← 清单摘要 ✅ → 清单形状 ✅ → __pycache__ ✅ → 302 个文件逐条校验 ✅
      → node 字节校验 ✅ → cli.mjs 启动 ✅ → 空 stdin 正常报 BOUNDED_STDIN_INPUT_REQUIRED
```

**「可信入口第一次被端到端执行、全链通」这句声称属实，我独立复现了。** `dockerd` 本轮无需启动 —— 这条链根本走不到 docker。

### 5.2 它没测到的失败路径

1. **最要紧的那条：入口验证的是「`cli.mjs` 起得来」，不是「控制器干得成事」。** `cli.mjs` 在空 stdin 上返回 `BOUNDED_STDIN_INPUT_REQUIRED` 只说明进程起来了。真正的工作路径是 `cli.mjs → context.mjs → host-effect.mjs → bridge.py → fixed_host.prepare()`，而那一步在这台宿主上**必然**抛 `Exact Windows Docker host required`（R17-F1）。**「全链通」这个说法会让下一个读者以为控制器可用，它不可用。**
2. **跨目录 `__pycache__`（R17-F2）** —— 入口那道检查测了，但只测了它覆盖的那个目录。
3. **验证用的 python 自己没人验。** `sha256sum` 验清单、验 node；python 验 302 个文件（其中包括它自己 `/usr/bin/python3.11`）。注释写着「the runtime being checked is not the runtime doing the checking」—— 对 node 成立，对 python 是**自证**。持平于前代（前代 `powershell.exe` 同样如此），**不阻断**，但这句注释比实际情况说得满，记为 R17-N4。
4. **闸门与入口的结论都依赖宿主已被 provision。** 【实测】本容器原本**没有** `gh`；不装 `gh` 时闸门直接 `UNEXPLAINED trusted-github.mjs: f687dc937534 … REFUSED`。所以「43 accounted / 0 unexplained」只在一台已按某个未成文清单装好 `gh v2.63.2` 到 `/usr/local/bin/gh` 的机器上成立。**而 `HostProvisioning.json` 仍然不存在（R15-N1 仍开）。** 这条现在比上一轮更要紧：它已经是闸门结论的前提，不只是清单的前提。

---

## 六、(6) 第十六轮余留项的现状

| 编号 | 内容 | 做了吗 | 判定 |
| --- | --- | --- | --- |
| **R16-F1** | `host-effect.mjs` 钉前代 `bridge.py` | **做了** | **闭合**【实测】见第一节 |
| **R16-F2** | 闸门 fail-open | **换了失败模式，未闭合** | **仍阻断，重编为 R17-F3**。A11 证明其中「MISSING TARGET 必须 exit 1」那一条不但没闭合，连警告都不打印了 |
| R16-N1 | 证据文件注明两个有效期（autovacuum / VACUUM FREEZE） | **没做**【实测】`grep autovacuum` = 0 | 不阻断，仍开 |
| R16-N2 | 清单枚举改 `git ls-files` | **没做**【实测】0 处 | 不阻断，但本轮 `__pycache__` 事故正是它的一次实例，见 4.4 |
| R16-N3 | 闸门打印覆盖率 | **做了一半**：打印分子（43），**没有分母、没有断言** | 不阻断，但它正是 A5／A6 唯一漏出的信号被浪费掉的原因 |
| R16-N4 | `--write` 回滚 + 全文件唯一定位 | **没做**，且 `split/join` 让注释改写变成一次改全 | 不阻断，见 2.7(c)(e) |
| R16-N5 | `BASE` 在两个文件里指向不同目录 | **已失效**：新闸门不按变量名推断目录 | **关闭**（问题消失，不是被修） |
| R16-N6 | 自述「21 个文件」实为 20 | **改对了**（本轮自述 20） | **关闭** |
| R15-N1 | `gh` 来源记录 / `HostProvisioning.json` | **没做**【实测】文件不存在，控制器目录内无 `v2.63.2` 字样 | 不阻断，但见 5.2 第 4 条，重要性升级 |
| R15-N2 | `runtime180/status-manifest.candidate.schema.json` 不在清单 | **没做** | 不阻断，持平前代 |
| R15-N3 | 清单过包含 | **没做** | 不阻断，持平前代 |
| R15-N4 | 更正书时间戳带字面 `x` | **没做**【实测】仍是 `2026-09-12T11:4xZ` | 不阻断 |
| R15-N5 | 更正书缺 `per_row_evidence_ref` | **没做**【实测】grep 计数 0 | 不阻断 |
| R15-N6 | 更正书说「三个」不变性触发器（实为 7） | **没做**【实测】原文仍在 | 不阻断 |
| R14-N3 / R15-N8 | `LinuxHostFeasibilityFinding.md` 第五节「尚未验证」 | **没做**【实测】第 54 行原样 | **不阻断，但现在错得更明显** —— 已有三轮跨容器复现（301/301、清单逐字节重建、本轮 302/302 + 逐字节重建） |
| R15-N7 | 动态库、`/bin/sh` 符号链接未入清单 | **没做** | 不阻断，持平前代 |
| R15-N9 | `verify-manifest-against-host.mjs` 仍是 331 条 Windows 版 | **没做**【实测】`gh_exe: NOT_IN_MANIFEST`，回显旧的 `e2efa10a…` | 不阻断，但见 4.2 |
| R14-N6 / N7 | 绝对路径前提、`canonical` 495 字节不变量写进资格声明 | **无法做**（资格声明仍不存在） | 顺延，不阻断 |

**除 R16-F2（→ R17-F3）外无一条阻断。本轮的阻断项是 R17-F1、R17-F2、R17-F3。**

---

## 七、(7) 综合裁定 —— 不予资格化

**不签发 `ScopedControllerQualification`，不签发运行时受理。**

### R17-F1【阻断】Linux 控制器的 `fixed_host.py` 仍要求 Windows

【读文本】

```
fixed_host.py:56   if sys.platform != 'win32' or observation.digest(observation.DOCKER) != observation.DOCKER_SHA:
fixed_host.py:57       raise ValueError('Exact Windows Docker host required')      ← prepare()，CREATE 的第一步
fixed_host.py:116  if sys.platform != 'win32' or observation.digest(observation.DOCKER) != observation.DOCKER_SHA:
fixed_host.py:117      raise ValueError('Exact Docker executable required')        ← _invoke()，每一次 docker 调用

docker-engineering-observation/observe.py:21
  DOCKER = Path('C:/Program Files/Docker/Docker/resources/bin/docker.exe')
  DOCKER_SHA = '00ffff945b67c65aae98dd980621a80ee135ed4e0931b33ca03687caee019713'
```

【实测】`CREATE` 的真实 traceback 见 1.3：`bridge.py:73 → fixed_host.py:57`。

**这不是环境问题。** 证据是这个目录里**别的**文件都已经移植好了：

```
parent600.py:39    DOCKER = '/usr/bin/docker'
parent600.py:40    ENDPOINT = 'unix:///var/run/docker.sock'
parent600.py:124   prefix = [DOCKER, '--host=' + ENDPOINT, …]              ← argv 已经是 Linux 的
清单               /usr/bin/docker  18c2a16d6aa0…  44,320,674 字节         ← 钉的是 Linux docker
LinuxHostFeasibilityFinding.md                                            ← 整份文档在论证这台 Linux 能当宿主
```

【实测】把这一版 `fixed_host.py` 和它的前代 `control-context-verifier-root6-window11-successor/fixed_host.py` 对一下，**整个 Linux 移植只有三处**：

```
33   parent600.py 的钉        34b85e23…  →  7f952787…
40-41 PYTHON / PYTHON_SHA     C:/Users/Windows/AppData/…/python.exe  →  /usr/bin/python3.11
70   skills 源目录            C:/Users/Windows/.codex/skills/clued   →  /home/user/cross-memory-system/skills/clued
```

**两处 `sys.platform != 'win32'` 和整个 `observation.DOCKER` 依赖，一个字都没改。** 移植做了三处、漏了第四处，而第四处是唯一一处会让 `CREATE` 直接失败的。

这和 R15-F1／R15-F2／R16-F1 是同一个家族：**一处改了，一处没改，而没改的那处在链的更上游／更早的执行点。** 区别在于前三次是摘要不一致，这一次是宿主假设不一致 —— **而闸门只看 64 位十六进制字面量，对这一类完全没有视野。** 我不认为闸门应该负责捕捉它；我认为它说明「把控制器目录的摘要对齐」这个验收标准本身不足以判定「这个控制器能干活」。

**修法建议（最小改动，不动共享的 `observe.py`）：** 【实测】`fixed_host.py` 只用到 `observation` 的 8 个名字（`DOCKER`、`DOCKER_SHA`、`Unknown`、`digest`、`environment`、`guard_ready`、`load_record`、`persist`），其中 `observe()` 那个函数（内含另一处 win32 检查）**根本没被控制器调用**。所以只需：

```
① 在 parent600.py 增加   DOCKER_SHA = '18c2a16d6aa0331bbd78b93e0a57f344c62bda0be52c054d4ee80e11176b0c30'
   （值来自清单的 /usr/bin/docker 条目，本容器实测一致）
② fixed_host.py:56 与 :116 改为
     if sys.platform != 'linux' or observation.digest(Path(parent.DOCKER)) != parent.DOCKER_SHA:
   —— 平台判据与二进制判据都改到已移植的 parent600 上，
      跨目录钉 cc3498e6…（observe.py）保持不变，前代控制器的钉不受影响
③ 改完必须让 CREATE 自己跑一次，确认它**不是**在 fixed_host.py:57 抛
```

### R17-F2【阻断】`__pycache__` 只封了四个入口中的一个

见 3.4。**修法：把构建期与运行期的两道检查扩展到全部四个「先校验摘要再 exec」的目录**，并在清单枚举里同样拒绝。这四个目录是已知的、有限的、在源码里以字面量出现的。

### R17-F3【阻断】闸门不是 fail-closed

见第二节。**修法见 2.10，负向测试必须覆盖 A1/A2/A3b/A4/A5/A6/A11/A12 八条。**

### 修法与顺序 —— 这一次链更长，而且工具帮不上忙

第十六轮我写了 ①②③④⑤⑥ 六步。这一轮多了一个起点（R17-F1 要改 `fixed_host.py`，那是链的**最底端**），而 2.8 节实测证明 **`--write` 修不了由此产生的陈旧钉**。所以必须手改并逐级手推：

```
① parent600.py    增加 DOCKER_SHA（Linux docker）
                  —— parent600.py 自身摘要由 7f952787… 变为 P
② fixed_host.py   两处 win32 闸改为按 parent 的 Linux 判据
                  同一步里把第 33 行钉 parent600.py 的值由 7f952787… 改为 P
                  —— fixed_host.py 自身摘要由 773f5b29… 变为 H
③ bridge.py:16    HOST_SHA 由 773f5b29… 改为 H
                  —— bridge.py 自身摘要由 c43c32a0… 变为 B
④ host-effect.mjs:14  bridge 钉由 c43c32a0… 改为 B
   ※ ①②③④ 一步都不能省，且 `--write` 只会在每一步报 REFUSED 而不修（2.8 实测）。
     每改完一步跑一次报告模式，确认剩下的报错条数在单调下降。
⑤ 按 3.4 把 __pycache__ 拒绝扩展到四个目录（构建期 + 运行期 tool-entry.functions.js）
⑥ 按 2.10 把闸门改成「钉是一等公民」的 fail-closed，并硬编码分母断言
⑦ 按 3.5 把清单的 python 枚举起点由 parent600.py 改为 bridge.py + load_host()
   —— 这会让 302 条变成 304 条左右（platform、uuid 的 .py 与 .pyc）
⑧ 按 4.4 把枚举由 readdirSync 换成 git ls-files
   ※ ⑤⑥⑦⑧ 每一步都改动清单内的文件，自身摘要随之变化
⑨ 重跑 build-linux-manifest.mjs --write
   必须在 /home/user/cross-memory-system 下跑（检出根是摘要定义的一部分，见第十六轮 3.7）
   清单摘要由 f8ce675b… 变为新值 Z
⑩ 据 Z 重签钉 controller_digest 的两份文件与下游七份
⑪ 补 R16-N1~N4、R15-N1/N4/N5/N6/N8/N9 与本轮 R17-N1~N5
```

**验收标准（请照做，不要用自测替代）：**

1. **让 `CREATE` 自己跑到 docker。** 具体：`invokeFixedHost({operation:'CREATE',…})` 之后取**真实 traceback**（不要看 `bridge.py` 吞出来的 `{"reason":"ValueError"}`，它把落点全丢了），确认它**不是**在 `fixed_host.py` 的平台闸抛。**这一条的教训现在是第四轮重复了：让被声称能跑的那条路径自己跑一次，并且看真实的落点。**
2. **闸门负向测试打在盲区**：A1、A2、A3b、A4、A5、A6、A11、A12 八条全部 exit 1。
3. **`__pycache__` 负向测试打在四个目录上**，不是一个：在 `docker-engineering-observation/`、`qualification-runtime/`、`…public-runtime-env-diagnostic-successor/` 各植入一个空 `__pycache__`，要求构建期与运行期都 exit 1。
4. **全覆盖对表照旧**：控制器目录全部 64-hex 字面量对着全仓 sha256 表跑一遍（本轮 43 个）。这个方法第十六轮定位了 R16-F1，本轮确认 11 处文件钉全部指对。
5. 在一个**干净容器**里跑 `verify-manifest-against-host.mjs --map /=/`，要求 302（或 ⑦ 之后的新数）全部 verified。**本轮这一条已通过，是真的。**

### 不阻断但应补的项

| 编号 | 内容 |
| --- | --- |
| R17-N1 | 闸门应打印并**断言分母**（应有 N 个 64-hex 字面量、M 个文件钉），否则 A5／A6 那种「少了一个」的信号会被浪费。R16-N3 只做了分子 |
| R17-N2 | 闸门的索引不应由**清单**播种（4.3 的 A12）。宿主二进制的摘要应来自一张独立的、与清单并列的 provisioning 表，即 R15-N1 那份 `HostProvisioning.json` |
| R17-N3 | 考虑 `--check-hash-based-pycs always`，作为「删除并拒绝」之外的纵深加固（3.6） |
| R17-N4 | `tool-entry.functions.js:42-43` 的注释「the runtime being checked is not the runtime doing the checking」对 node 成立、对 python 是自证。请把这句话改准确（5.2 第 3 条） |
| R17-N5 | 控制器目录的**子目录**同时是清单枚举与闸门扫描的盲区（A13）。换成 `git ls-files` 会顺带解决 |
| R17-N6 | `build-linux-manifest.mjs:49` 的注释仍在引用已删除的 `check-sibling-pins.mjs` |
| R16-N1~N4、R15-N1~N9、R14-N3/N6/N7 | 逐条现状见第六节，全部仍开，全部不阻断 |

---

## 八、控制器合并进 `main` 与后续重签的确切排期

### 8.1 控制器必须先合并进 `main` —— 不变

【实测】`git ls-tree origin/main scripts/phase2-qualification/control-context-verifier-root6-linux-successor/` 仍为空；`main` 仍是 `2c3a6f9`。`ScopedControllerQualification` 的 `source_ref.blobs` 是 GitHub blob URI、经 API 取，**资格签发之前控制器必须先在 `main` 上**。不变。

### 8.2 控制器摘要还会再变，本轮又多一次

【实测】

```
前代（window11 侧）      3a58eb87…
第十四轮那版（253 条）    9c04acde…
第十五轮那版（301 条）    52e4ecff…
第十六轮那版（302 条）    365ab926…
当前这版（302 条）        f8ce675b…            ← 本轮实测，与实施方自述一致
修完 R17-F1/F2/F3 之后    还会再变一次（第七节第⑨步），且条目数大概率由 302 变为 304 左右
```

约束不变：**第⑨步必须在 `/home/user/cross-memory-system` 下执行**，否则得到的 Z 不同（这是摘要定义的一部分，不只是「前提」）。

### 8.3 修订后的次序

与第十六轮相比只有 12a 的内容变了（多了宿主移植、`__pycache__` 扩面、闸门重写、python 枚举起点修正）；12c／12d／13 及其后**全部不变**：

```
12a  按第七节 ①…⑪ 严格顺序修复
     其中 ①②③④ 必须手改并逐级手推（--write 修不了，2.8 实测）
12b  【评估者】新控制器资格化评审（第三次重做）
     —— 本轮起，验收必须包含「CREATE 跑到 docker」这一条，仅对齐摘要不再足够
12c  【Owner】合并：新控制器 + HostProvisioning.json + 其资格 + 其运行时受理
     + 据新 controller_digest 重签的下游文档
12d  换绑：execution_binding.controller_sha256 由 edf31377…（runtime600）改为第⑨步产出的 Z   ← 写操作
13   注册 root6                                                                           ← 不可回退
…（其余不变，13d / 13f 仍由独立评估者签发，第四次合并仍在 CP-01 之后）
```

【实测】`execution_binding` 本轮直查仍是 `edf31377…`，该表 `n_tup_upd = 0`（自插入起从未被更新），与第十六轮 5.1 的更正一致。

第十四轮 10.2／10.3 的两条结论本轮仍未受影响：`Status24ChainDependencyFinding.md` 的因果链与控制器实现无关；`HostLossTerminalRecord.md` 对 CP-01 的说法仍然过重 —— 两份 schema（`510f3b90…`、`fae1e856…`）在新控制器里一个字节都没变【实测】。

---

## 九、对实施方的一句话

**先说做对的三件，都要明确记下。**

**一、`__pycache__` 那条发现，是这轮所有事情里最有价值的。** 它比我前两轮提的任何一条都严重，是你自己查出来的，而且你是演示而不是论证。我没有采信你的描述，自己从头构造了一遍合成实验，又把同样的手法用在**真实控制器**上：伪造 `__pycache__/fixed_host.cpython-311.pyc`，`fixed_host.py` 的 sha256 一字未变、`load_host()` 自己那道摘要检查照常通过，而 `MAX_GA_SECONDS` 从 600 变成 999999、`STOP_RESERVE_SECONDS` 从 30 变成 0。**你篡改的是这个体系里最不该被静默改掉的两个常量，而三道检查全部放行。** 你对严重性的评估不但没有夸大，还偏保守了。

`-B` 只挡写不挡读、时间戳式 `.pyc` 的有效性判据写在它自己身上 —— 全对。「不钉进清单、删除并双向拒绝」这个选择也对，理由你写对了：控制器自己的 `.pyc` 是生成物，钉它等于再造一条要同步的链，而那正是本轮反复出错的那一类。我核了两道拒绝，**都真的触发，运行期那道确实在逐文件校验之前**（我同时植入 `__pycache__` 和一个被改坏的清单内文件，字节码那条先赢，证明顺序对）。

**二、跨目录钉这一次真的被覆盖了。** 第十六轮 2.8 我说那是个潜在缺口。你这一版改了 `observe.py` 一个字节，闸门 exit 1。这是实打实的进步。

**三、清单是诚实的，而且可复现。** 302/302 逐条核过、在本容器逐字节重建出同一个 `f8ce675b…`、独立交叉核对工具报 302 verified / 0 mismatched / 0 missing / 0 uncheckable。`gh v2.63.2` 我第三次独立确认，逐字节相同。控制器目录 20 个文件这个数字你这轮报对了。

**然后说三件必须说的。**

**第一件，也是最要紧的：你说「失败点落到下游的假授权」—— 不是的。** `bridge.py` 把异常吞成 `{"reason":"ValueError"}`，只看类型名是看不出落点的。我把三段拆开取真实 traceback：`parse()` **通过了**，那个假授权被完整接受；`load_host()` 也通过了；失败在 `fixed_host.py:57`，`ValueError: Exact Windows Docker host required`。

**这是一个 `control-context-verifier-root6-linux-successor`，而它的 `fixed_host.py` 第 56 行和第 116 行仍然写着 `if sys.platform != 'win32': raise`，并且拿 `observe.py` 里那个 `C:/Program Files/Docker/Docker/resources/bin/docker.exe` 去校验 docker 二进制。** 我把它和 window11 前代对了一下 diff：整个 Linux 移植只有三处 —— parent600 的钉、PYTHON 路径、skills 源目录。**两处平台闸一个字没改。**

而同一个目录里 `parent600.py` 已经是 `DOCKER = '/usr/bin/docker'`、`ENDPOINT = 'unix:///var/run/docker.sock'`，清单钉的是 Linux docker 的 `18c2a16d…`，`LinuxHostFeasibilityFinding.md` 整份文档在论证这台机器能当宿主。**意图毫无疑问是 Linux，移植做了三处漏了第四处，而第四处是唯一一处会让 `CREATE` 直接失败的。**

这和 R15-F1／R15-F2／R16-F1 是同一个家族：一处改了、一处没改，没改的那处在更早的执行点。区别是前三次是摘要不一致，这次是宿主假设不一致 —— **而你的闸门只看 64 位十六进制字面量，对这一类没有任何视野。** 我不认为闸门该负责捉它。我认为它说明：**「控制器目录的摘要全部自洽」这个验收标准，判不出「这个控制器能不能干活」。** 你这一轮第一次把可信入口跑通了，那是对的方向；但入口跑通只证明 `cli.mjs` 起得来，`cli.mjs → context.mjs → host-effect.mjs → bridge.py → prepare()` 这条真正干活的路，你没跑到底。**下一轮请跑到底，并且看真实的 traceback，不要看 `bridge.py` 吞出来的那个字符串 —— 它把落点全丢了。**

**第二件：你的闸门不是 fail-closed，它只是在一条很窄的签名上 fail-closed。**

你的四组敌意测试我全部复现，**四条都真**。数字 43 也对。但四条都打在你能看见的那一种形态上。我打了十四条，八条放行。最要紧的那条是这样的：

```js
sha(fs.readFileSync(bridge))!=='60e4cfac015c15fd53921a61a6566f74'+'0e7414f218120b0bdbc17bf17be64fd7'
```

**这就是 R16-F1，一模一样的值，一模一样的后果，我只是多打了一个 `+` 号。** 闸门说 `digest pins consistent (42 accounted, 0 unexplained)`，退出 0；`build-linux-manifest.mjs` 照出 302 条清单，退出 0；`invokeFixedHost` 抛 `EXACT_PYTHON_BRIDGE_BYTES_REQUIRED`。**「拒绝为自相矛盾的控制器出清单」这句话，在你这一版上和上一版一样是假的。**

根因在判据本身。你的验证循环里**没有「钉」这个概念** —— 它不解析任何一处钉指向谁，只问「这个 64 位字面量是不是**某个**文件的摘要」。索引里有 940 个不同摘要、1083 条路径，所以这个问题几乎总是「是」。真正做语义判断的只有 `stale` 那一条：「等于前代同名文件、且本目录有同名文件」。那是一条**签名**，不是不变式。于是：

- 把 `bridge.py` 钉成**本目录 `cli.mjs`** 的摘要 → `mine.length` 成立，`stale` 那条唯一的语义规则被整条跳过 → 放行；
- 钉成树里**任何无关文件**的摘要 → `owners.length` 成立 → 放行；
- 你注释里写「each tied to the syntax …, **so a stray digest cannot borrow the exemption**」—— 借得到。`attempts` 是按文件收集的**值集合**，正则在整个文件文本（注释在内）上跑。我在 `host-effect.mjs` 末尾加**一行注释** `// git/blobs/0000…0', sha256: '<任意摘要>'`，那个任意摘要在整个文件里就都被放行了。`"ga_…":'…'` 那条同样。那个 40 位 blob id 也不校验，写 40 个 `0` 就行；
- 把钉写成**大写**，或改**文件名**而不动钉 —— 都放行。改名那条尤其要说：旧闸门至少还打印一行 `MISSING TARGET`，**新闸门连这行都没有了** —— 它不知道「target」是什么，`c43c32a0…` 仍等于那个被改名的文件，直接 accounted，而运行期是 `ENOENT`。R16-F2 的第二条没闭合，只是换了失明方式。

**而且失明的时候它仍然不说自己失明。** 大写和拼接那两条，唯一的信号是 `43` 变成 `42`。第十六轮 R16-N3 要求打印覆盖率，你打印了分子，**没有分母**。一个不报分母的覆盖率，和不报覆盖率是一回事 —— 把期望值硬编码进去、对不上就 exit 1，这两条当场就会被抓到。

`--write` 那边也有四个问题：本目录没有同名文件就既不修也不报（钉成 `validation.py` 摘要那条，`--write` 跑完 EXIT=0，钉原样留着）；它会把一行记录「前代发过什么」的历史摘要注释**静默改写成当前值**（R16-N4 没做，`split/join` 还让它一次改全）；它**完全不尊重你自己的豁免表** —— 我在前代目录加一个文件、把它的摘要写成 `"ga_…":'…'` 的形状，`--write` 照样把那条声明摘要改掉了。**豁免在一个方向上被滥用，在另一个方向上被无视。**

还有一条对你下一步最直接的：**`--write` 修不了你接下来必然要制造的陈旧钉。** 我模拟了「改 `fixed_host.py`」这一步，闸门报 `UNEXPLAINED bridge.py: 773f5b29ee14 matches no file`，EXIT=1，**然后什么也不改** —— 因为新的陈旧值不等于任何前代同名文件，不符合那条签名。「works for Python, JavaScript, or any shape added later」这句话，对历史遗留的四处成立，对新产生的不成立。第七节的 ①②③④ 四步必须手改手推。

**修法我第三次说同一件事，这次说得更具体。** 前两轮我说「不要再加正则」，你这轮没加正则、改成按身份匹配 —— 方向对，但换了一种签名，仍然是签名，而签名的补集永远是静默的。**唯一的出路是让「钉」成为一等公民**：钉必须成对声明（目标路径 + 期望摘要，可静态抽取），校验的是「这个钉指向的那个文件的实测摘要」，路径不存在即 exit 1；索引只用来诊断「这个陈旧值曾经属于谁」，绝不用来「解释」；非文件摘要的豁免必须**绑定到出现位置**而不是按值全文件放行；打印并断言分母。

**第三件：`__pycache__` 你封了控制器目录，另外三个一模一样的入口没封。**

「先校验摘要、再 `spec_from_file_location` + `exec_module`」这个模式，在你的控制器里有四处是跨目录的：`observe.py`、`validation.py`、`remote_evidence.py`、`fixed_skill_fixture.py`。你的两道检查都只看 `dirname(manifest)` 一个目录。

我在 `docker-engineering-observation/` 下伪造了 `observe.cpython-311.pyc`，只改一行：

```
observe.py sha256              cc3498e6dc5eed1f13fb      ← 一字未变
bridge.py → load_host()        OK
h.observation.DOCKER           /tmp/attacker-docker      ← 已被替换
check-digest-pins.mjs          digest pins consistent    EXIT=0
运行期入口                      不检查那个目录
```

**`observation.DOCKER` 正是 `fixed_host.py` 第 56/116 行拿来做二进制校验的那个值。** 这条路径直接能把「必须是这个 docker 可执行文件」指向攻击者选定的文件。你的修法是对的，**范围是四分之一。**

顺带两条同源的：你的清单 python 枚举只 `exec_module(parent600.py)`，而真实入口是 `bridge.py`。我从 `bridge.py` 进去跑了一遍 —— 真实运行路径上有 **46 个**标准库 `.pyc` 可达，其中 `platform` 和 `uuid` **连 `.py` 带 `.pyc` 都不在 302 条里**。同一个根因：**枚举的起点不是执行的起点。** 另外你问过的其它缓存我逐条试了：Node 的 v8 compile cache **不是**同类绕过（改源得新代码、换回原源得原代码、等长不同源也各自正确，V8 会拿实际源校验），ajv 没有磁盘缓存，`PYTHONPYCACHEPREFIX` 已被 `-I` 挡住 —— **CPython 的时间戳式 `.pyc` 是唯一成立的那一个，而它成立是因为校验字段长在被校验对象自己身上。这个不对称是真的，不是运气。**

**最后。** 你这一轮第一次自己查出了一条比评估者提的都严重的缺陷，并且做法是演示不是论证 —— 这是真正的进步，我希望它继续。但同一轮里你又一次出现了自造问题（索引重建丢宿主条目，你自己发现并修了）、自述失误（「失败点是假授权」），以及**一条把「移植」只做了四分之三、把「封堵」只做了四分之一、把「fail-closed」只做在一条签名上的模式**。三件事形状一样：**做到了能看见的那部分，然后宣布做完了。**

下一轮请把三条声称都改成可被别人一条命令证伪的形式：「`CREATE` 跑到了 docker，这是 traceback」；「四个目录都植过 `__pycache__`，这是四条 exit 1」；「闸门的分母是 N，改任何一处让它变成 N−1 都 exit 1，这是负向测试输出」。

---

## 边界（再述）

未写库、未注册代际、未消耗那唯一一次 600 秒分配、未预留预算、未调用 `append_event` 或任何会写库／消耗预算的函数、未执行任何 `do $$ … $$` 块。全部 SQL 为 `select`。
【实测】收尾复核（与开篇一致）：`charged_seconds` 仍 **9906**（上界 10506）、`charged_evidence_bytes` 仍 2201594803、`current_head` 仍 root5（`ctrgen_e5df4322…`）/ sequence 5、`active_ga_id` 与 `pending_budget_sequence` 均为 null、`events` 5 行、`execution_events` 88 行、`gate_attempts` 14 行、`control_objects` 23 行、`execution_binding.controller_sha256` 仍 `edf31377…`、该表 `n_tup_upd` 仍为 0。

本轮为做只读检查，在容器里下载过 `gh v2.63.2` 的公开 release 并临时装到 `/usr/local/bin/gh`、按 lockfile 临时装过 `node_modules`、跑过 `check-digest-pins.mjs` 与 `build-linux-manifest.mjs`、把实施方分支以 `git worktree` 只读检出到临时目录、把 `scripts/phase2-qualification` 整棵树复制到临时目录做全部敌意测试。**伪造的 `.pyc` 全部只写在临时副本与合成文件上，真实控制器与真实标准库未被触碰。**
为逐字节重建清单，在本评估者自己的克隆里短暂 `git checkout --detach c578af3` 并跑过一次 `--write`（产出与实施方那份逐字节相同），随后 `git checkout -- .` 复原、切回本评估者分支；**实测工作树干净。** 临时安装的 `node_modules` 与 `/usr/local/bin/gh` 已删除，宿主恢复为发现时的状态（本容器原本没有 `gh`）。临时目录产物已删。

**未起 600 秒容器、未创建任何容器、未走 GA 通路、未签发 GA。未修改实施方检出的任何文件。**
**本文件不签发资格、不签发运行时受理、不构成授权、不批准也不合并任何 PR。** 最终裁量权在 Owner（`tdoljyj`）。
CI 五项长期全红、日志 404，已确认非瞬时；本文件不把它记作通过，也未尝试修复。
