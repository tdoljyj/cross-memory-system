# 第十五轮独立评审：五条阻断项的复审与资格化再判定

**状态：`BLOCKED_NOT_QUALIFIED_NO_WRITE_PERFORMED`。**

**裁定：不予资格化。第十四轮的五条阻断项全部真实闭合；但本轮实测发现两条新的阻断项，形状与 R14-F1/F2/F3 完全相同（改了文件没改配套摘要），且这两条在第十四轮就已经成立——是我上一轮漏掉的。**

未写库、未注册代际、未消耗那唯一一次 600 秒分配、未预留预算、未调用 `append_event` 或任何会写库／消耗预算的函数、未执行任何 `do $$ … $$` 块。全部 SQL 为 `select`。
【实测】边界复核（本轮首尾各一次，两次一致）：`charged_seconds` = **9906**（上界 10506）、`charged_evidence_bytes` = 2201594803、`current_head.generation_id` = `ctrgen_e5df432221344996afc04b5638121d96`（root5）、`sequence` = 5、`active_ga_id` = null、`pending_budget_sequence` = null、`clued_control.events` = 5 行、`execution_events` = 88 行、`gate_attempts` = 14 行。**全部未动。**

未起 600 秒容器、未走 GA 通路、未签发 GA。未修改实施方检出的任何文件——实施方分支以 `git worktree` 检出到临时目录，只读；测试产物在临时目录，用完已删。未合并任何 PR、未批准任何东西。最终裁量权在 Owner（`tdoljyj`）。
CI 五项长期全红、日志 404，已确认非瞬时；本文件不把它记作通过，也未尝试修复。

评审对象：实施方分支 `claude/nice-fermat-njqlmm` head **`0f8edc0`**（`92deaea` 修阻断项，`0f8edc0` Owner 再受理），`main` = `2c3a6f9`。
本评估者分支 `claude/trusting-keller-mm2s0v`（第十轮至第十五轮同一条）。

---

## 零、先说结论

| 问 | 实施方的主张 | 本轮裁定 |
| --- | --- | --- |
| (1) R14-F1 python 摘要重钉 | 已改 `f56a5885…` | **闭合**【实测】两处都改了，值也对 |
| (1) R14-F2 docker 端点 | 已改 unix socket，用自己的 prefix 实测 | **闭合**【实测】我用 `parent600.py` 自己的 prefix 跑通了 `docker version`。但**「镜像 rc=0」我复现不了**，见 1.2 |
| (1) R14-F3 gh 摘要重钉 | 已改 `f687dc93…` | **闭合，且比它声称的更强**【实测】我从上游 release 重建了那个二进制，逐字节等于钉值。见 1.3 |
| (1) R14-F4 `.pyc` 入清单 | 44 个，取自 `__cached__` | **闭合，且比我上一轮要求的更准确**。我上一轮说的「57 个 .pyc 全被加载」是错的，见 1.4 |
| (1) R14-F5 shell 工具入清单 | 4 个 | **闭合**【实测】，附三条不阻断的余留，见 1.5 |
| (2) 修复没引入新问题 | 未声称 | **删重复定义确实零影响**【实测】；**但另有两条早已存在、我上一轮没查出来的同形状阻断项**，见第二节 |
| (3) 清单的自指性 | 未声称 | **不构成循环**。清单不含自身摘要；含生成器字节是新增的（前代没有），无害但有排序约束 |
| (4) N3 / N5 / N7 | 未声称 | **三条都没做**。N3、N7 不阻断；N5 已被一次巧合部分抵消，见第四节 |
| (5) 容器可复现性 | 未声称 | **决定性改善**【实测】：在我这个容器里 **301/301 `ALL_ENTRIES_VERIFIED`**，0 不匹配、0 缺失。前提是三步配置，第四步（镜像）在本容器办不到 |
| (6) 能不能资格化 | —— | **不能。两条阻断项（R15-F1、R15-F2）** |

**两条阻断项（详见第二节）：**

- **R15-F1** `bridge.py:16` 的 `HOST_SHA` 仍是**前代**`fixed_host.py` 的摘要 → `load_host()` 实测抛 `ValueError: Accepted fixed host bytes changed`。
- **R15-F2** `fixed_host.py:33` 钉的 `parent600.py` 摘要仍是**前代**的 → 该模块 import 即抛 `ValueError: Frozen dependency drift`。

两条都在 `invokeFixedHost` 的第一次调用（`CREATE`）之前拦死。**它们不是本轮修复引入的——`755d744` 上就已经是错的，是我第十四轮漏掉的。** 我照实记。

---

## 一、(1) 五条阻断项逐条复审

方法：一律自己测，不采信实施方的自测结果。所有摘要在本容器重新计算。

### 1.1 R14-F1 —— 闭合【实测】

```
/usr/bin/python3.11  实测 sha256 = f56a588548dd013906ae1dcd1b6faa417f4e204da634ff354840d9643e78ff9e
host-effect.mjs:14   现钉 f56a5885…   ✅
fixed_host.py:41     现钉 f56a5885…   ✅
清单条目             f56a5885…  6,639,992 字节  ✅
```

三处现在互相一致，也与本容器的实际字节一致。`bridge.py` 的另一半钉值 `60e4cfac…` 仍然正确（本容器实测 `sha256(bridge.py)` = `60e4cfac015c15fd53921a61a6566f740e7414f218120b0bdbc17bf17be64fd7`）。

**R14-F1 解除。**

### 1.2 R14-F2 —— 端点闭合【实测】，但「镜像 rc=0」我复现不了

我按要求**用 `parent600.py` 自己的 `prefix`**，不用裸 docker。做法：在 `-I -S -B` 下 import `parent600.py`，取它自己的 `DOCKER` / `ENDPOINT` / `paths(nonce)`，按 `fixed_argv()` 第 124 行同样的表达式拼出 prefix 再执行。本容器 `dockerd` 非常驻，我先起了一个。

```
DOCKER   = /usr/bin/docker
ENDPOINT = unix:///var/run/docker.sock        ← 已改
PREFIX   = ['/usr/bin/docker', '--host=unix:///var/run/docker.sock', '--config=<work>/docker-config']

PREFIX + ['version','--format','{{.Server.Version}}']          → rc=0   out='29.3.1'
PREFIX + ['image','inspect', <pinned image>, '--format','{{.Id}}'] → rc=1
          err='Error response from daemon: No such image: python@sha256:285a71…'
```

**第一条决定性地证明端点修对了**：上一轮同一条命令在 `npipe://` 下是 `SIGSEGV` 段错误崩溃，现在 rc=0 正常返回。

第二条 rc=1，是因为本容器没有那个镜像。我去查了它能不能拿到：

```
docker manifest inspect <pinned digest>   → 成功，返回 OCI manifest（4 层，python 3.12.14-alpine3.24）
docker pull <pinned digest>               → 失败：blob 取自 production.cloudfront.docker.com → Forbidden
curl https://production.cloudfront.docker.com/  → CONNECT tunnel failed, 403
另试 alpine:3.20、python:3.12-alpine        → 同样 403，同一个 CDN 主机
给 dockerd 配上本会话代理后重试             → 同样 403
```

**准确的表述**：这个镜像的 manifest 在本容器取得到（所以它确实存在、摘要可寻址），但**它的 blob 在本会话的网络策略下取不到**——被代理挡在 `production.cloudfront.docker.com` 这一个主机上，三个不同镜像同样结果。

我**不**把这条推广成「镜像拿不到」。我只能说：**在这个容器、经这条路径，我没拿到；实施方在它的容器里拿到了。** 这恰是上一轮记下的那个毛病的反面，我不重犯。

它的后果是实在的，且要写进资格前提：`fixed_argv('create')` 里带 `--pull=never`（我把整条 create argv 打出来看了，确实有），**所以镜像必须在容器里先在位**。这是第四项配置前提，见第五节。

**R14-F2 解除**（端点这一条）。**镜像可得性单列为前提，不作阻断项**——它不是控制器的缺陷。

### 1.3 R14-F3 —— 闭合，而且我做到了比「重钉」更强的一步【实测】

`trusted-github.mjs:6` 的 `expectedGh` 现为 `f687dc93…`，与清单条目一致（50,098,328 字节）。但「与自己的清单一致」只排除了自相矛盾，没证明这个值对应任何真实的东西——上一轮 `gh` 那条的真问题正是**没有来源**。

所以我去把它造了出来。`LinuxHostFeasibilityFinding.md` 第四节只留了一个数字：tarball 13,069,957 字节。我按这个数字在 `cli/cli` 的 release 里二分：

```
v2.63.0 content-length = 13,068,169
v2.63.1                 13,066,070
v2.63.2                 13,069,957    ← 命中
v2.64.0                 13,076,414
```

下载 `gh_2.63.2_linux_amd64.tar.gz` 并解包：

```
tarball  13,069,957 字节  sha256 912fdb1ca29cb005fb746fc5d2b787a289078923a29d0f9ec19a0b00272ded00
bin/gh   50,098,328 字节  sha256 f687dc937534f8aa77ff9d2362163c645b5a8cc78297ef1a642c74c56aa48618
清单钉   50,098,328 字节  sha256 f687dc93…                                    ← 逐字节相同
trusted-github.mjs:6                  f687dc93…                               ← 逐字节相同
```

**结论：钉的值不只是自洽，它对应 `gh v2.63.2` linux_amd64 的真实上游产物，我在本容器从公开 release 独立重建并逐字节复现。**

这同时把上一轮的 7.3 / 7.4-① 从「不可复现」改判为「可复现，只是来源没被记下来」。**`gh` 不再是那个跟 Windows 宿主一样会随机器消失的东西了。** 但**记录这件事仍然没有做**：控制器目录里没有任何文件写着 `v2.63.2`、URL 或上游摘要。这条降级为必须补的记录项（R15-N1），不再是阻断项。

**R14-F3 解除。**

### 1.4 R14-F4 —— 闭合，而且实施方做得比我上一轮要求的更准确

我上一轮写的是「57 个被实际加载的 `.pyc` 不在清单」，并要求把 57 个都钉上。**这句话里有一处是我错了，必须更正。**

【实测】新清单钉的是 **44** 个 `.pyc`，不是 57 个。差的 13 个是这些：

```
_collections_abc, abc, codecs, genericpath, importlib._bootstrap,
importlib._bootstrap_external, importlib.util, io, ntpath, os, posixpath,
stat, zipimport
```

逐个查它们的 `__spec__.loader`：

```
loader = <class '_frozen_importlib.FrozenImporter'>    origin = frozen    __cached__ = <不存在>
_imp.is_frozen(name) → True  （13 个全部）
```

**它们是冻结模块，字节码内嵌在 `python3.11` 这个二进制里，根本不读 `__pycache__`。** 而 `python3.11` 本身是被钉住的（`f56a5885…`）。所以这 13 个的 `.pyc` 钉不钉毫无意义——**不钉才是对的**。

实施方用「各模块自己的 `__cached__`」取集合，恰好自动排掉了这 13 个。这个做法比我提的「照前代钉 57 个」更准确，我照实记，并更正我上一轮 6.2 里「其中当前有效（因而被实际加载）: 57 / 57」那一句：**有效不等于被加载，13 个有效的 `.pyc` 从来没被读过。**

我自己重跑了枚举，与清单逐条对上：

```
parent600.py 闭包（-I -S -B）：src 59（57 个 .py + 2 个 lib-dynload .so），cached 44
清单里的 stdlib .py 57 + .pyc 44 + .so 2 = 103                      ← 与实施方自述一致
闭包中不在清单里的条目：0
```

**R14-F4 解除。**

### 1.5 R14-F5 —— 闭合【实测】，附三条不阻断的余留

```
/bin/sh → realpath /usr/bin/dash   清单钉 /usr/bin/dash   129,784 字节  86d31f6f…  ✅ 本容器一致
/usr/bin/sha256sum                                          39,336 字节  e484c36c…  ✅
/usr/bin/cut                                                39,432 字节  e48d1570…  ✅
/usr/bin/test                                               47,552 字节  da73061a…  ✅
```

四条都在，摘要在本容器逐字节对上。**R14-F5 解除。**

三条余留，都不阻断，都是提示：

1. **`test` 是 dash 的内建命令**。【实测】`/usr/bin/dash -c 'type test'` → `test is a shell builtin`。所以第 1、4 步的 `test` 根本不会执行 `/usr/bin/test`。钉它无害，但它不是被执行的字节。真正被执行的外部程序只有 `sha256sum` 和 `cut`（`type` 确认二者都解析到 `/usr/bin/`）。
2. **钉的是 `/usr/bin/dash` 的字节，没有钉 `/bin/sh` 指向谁**。【实测】`/bin/sh -> dash`。把这个符号链接改指向别的东西，301 条全绿而执行体换了。
3. **`sha256sum` 的哈希实现不在清单里**。【实测】`ldd /usr/bin/sha256sum` → `libcrypto.so.3`。第 1 步和第 4 步的 SHA-256 实际由 `libcrypto.so.3` 算，而它没被钉。同理未钉的还有 `ld-linux-x86-64.so.2`、`libc.so.6`（全部四个工具）、`libm/libz/libexpat`（python）、`libstdc++/libgcc_s/libpthread/libdl`（node）。前代对 PowerShell 侧的同类覆盖也是部分的（钉了 `mscorlib.dll`、`System.dll`，没钉 `ntdll`/`ucrtbase`），**所以这是持平，不是退步**。建议补上，理由见第五节：这些都是镜像自带文件，实测跨容器逐字节稳定，补进去的成本几乎为零。

---

## 二、(2) 修复有没有引入新问题

### 2.1 删掉重复的 `canonicalDigest` —— 零影响，三条证据【实测】

先确认实施方的自陈属实：【读文本】`context.mjs:14` 确实 `import {validateRootShape,canonicalDigest,signaturePayloadDigest} from './root-window-validation.mjs'`，`canonicalDigest` 在 `:30`（`same`）与 `:59`（`prefix_digest`）已在使用。**「为不改模块图而重复定义」这个理由确实是假的，import 本来就在。** 删得对。

问题是：删完之后 `BASELINE_EVENTS_DIGEST` 与 14 个 attempt 摘要**是不是还算得出同样的值**。三条证据：

**(a) 两份实现逐字节相同。** 我从 `755d744` 的 `context.mjs` 里把被删的那段原样抽出来，与 `root-window-validation.mjs` 的对应段比：

```
被删的 canonical(value){…}      495 字节  sha256 8bf54a9f568e19f0f6df939f002756201b818abe3a2d2578d7a222e0eb32a9fb
RWV 的 canonical(value){…}      495 字节  sha256 8bf54a9f568e19f0f6df939f002756201b818abe3a2d2578d7a222e0eb32a9fb
                                                  → IDENTICAL
```

摘要表达式 `update(canonical(value)+'\n','utf8').digest('hex')` 两处逐字符相同，差异只有绑定名（`boundedCrypto` vs `crypto`，同一个 `node:crypto` 默认导出）。

**(b) 差分测试 20 万例，0 处不符。** 把被删的那份原样 `eval` 出来，与 import 进来的那份在同一组输入上对拍：

```
随机用例 200,000 例（嵌套对象/数组/空串/转义引号/反斜杠/非 ASCII/代理对/U+0000/U+001F/
                     MAX_SAFE_INTEGER/±1/null/true/false，深度 0–4，键含重复与非 ASCII）
  值不符 0    抛错不符 0
边界用例 8 例（1.5 / NaN / Infinity / 2^53 / {a:1.5} / [undefined] / {a:undefined} / Date）
  两份实现的返回值或异常消息逐条相同，8/8
```

包括异常路径：`Unsafe or floating canonical number`、`Unsupported canonical value` 两条消息两份一模一样。

**(c) 被摘要覆盖的那份数据自上一轮起没有变过。** 我在库内重算 md5：

```
前 44 条事件 jsonb_agg::text   长度 624,523      md5 19dd50bdd93b2b3119194e171dc843f8
                                                （与第十四轮 3.2 节记录的值完全相同）
14 个 attempt jsonb_agg::text  长度 1,832,525    （长度与第十四轮相同）
```

第十四轮我用**被删的那一份实现**在真实数据上算出 `BASELINE_EVENTS_DIGEST` = `64b2ba3e…` 与 14 个 attempt 摘要，14/14 全中。(a)+(b) 证明两份实现不可区分，(c) 证明输入字节没变。

**结论：`BASELINE_EVENTS_DIGEST` 与 14 个 attempt 摘要仍然算得出同样的值。删除零影响。**

补一句方法上的坦白：624 KB / 1.8 MB 的原始数据无法经本会话传输，所以「在真实数据上端到端重算」这一步是第十四轮做的，本轮做的是「两份实现不可区分」+「输入未变」。这两步合起来等价，但不是同一次测量，我如实标出。

顺带：`grep` 全文确认 `canonical`（不带 Digest）这个标识符在新 `context.mjs` 里已无任何引用，删除没有留下悬空调用。

### 2.2 【阻断】R15-F1：`bridge.py` 钉的是**前代**`fixed_host.py` 的摘要

这是本轮最重要的发现。

```
bridge.py:16   HOST_SHA = '95a69b860e7613fb59f4af8abb2f3c82c847044b78b0cbe445d22a471a7080da'
bridge.py:58   if hashlib.sha256(HOST.read_bytes()).hexdigest() != HOST_SHA:
                   raise ValueError('Accepted fixed host bytes changed')

本控制器的 fixed_host.py  实测 sha256 = 50dd90d114ac6cd3d94d333002dbdb08b291d9e53f47b0230213a5e58f50bf0e
清单条目 fixed_host.py                  50dd90d1…  14,284 字节        ← 清单是对的
```

`95a69b86…` 属于谁？我把控制器目录里全部 34 个 64 位十六进制常量拿去和仓库里每个文件的 sha256 对表，结果是：

```
95a69b86… → scripts/phase2-qualification/control-context-verifier-root6-window10-successor/fixed_host.py
             scripts/phase2-qualification/control-context-verifier-root5-window5-forward11-successor/fixed_host.py
```

**是前代控制器的 `fixed_host.py`。**

【实测】直接调用：

```
$ python3.11 -I -S -B -X utf8 -c "…import bridge.py…; bridge.load_host()"
bridge.HOST_SHA  = 95a69b860e7613fb59f4af8abb2f3c82c847044b78b0cbe445d22a471a7080da
actual sha       = 50dd90d114ac6cd3d94d333002dbdb08b291d9e53f47b0230213a5e58f50bf0e
load_host(): ValueError: Accepted fixed host bytes changed
```

后果：`host-effect.mjs:18` 用 `execFileSync(python, ['-I','-S','-B','-X','utf8', bridge])` 启动 `bridge.py`；`bridge.main()` 里 `dispatch(value, load_host())` 会先求值 `load_host()`，异常被捕获后返回 `{'state':'UNKNOWN','reason':'ValueError'}` 且进程退出码 2。`execFileSync` 因退出码非 0 先抛；即使不抛，`host-effect.mjs:20` 的 `result.state!=='ACTUAL_FIXED_HOST_OBSERVATION_NOT_YET_REMOTE_RESULT'` 也会抛 `EXACT_ACTUAL_HOST_RESULT_REQUIRED`。

**`invokeFixedHost` 的第一次调用（`CREATE`）即失败。600 秒容器创建不出来。**

### 2.3 【阻断】R15-F2：`fixed_host.py` 钉的是**前代**`parent600.py` 的摘要

```
fixed_host.py:32-33  parent = load('accepted_fixed_parent', str(BASE / 'parent600.py'),
                                   '34b85e23293fe23567e00bd737cdc5bbb59fd4d9fd1875e3ce8f391471b58fb9')
fixed_host.py:22-25  def load(name, relative, expected):
                         if sha256(path.read_bytes()) != expected:
                             raise ValueError('Frozen dependency drift: ' + relative)

本控制器的 parent600.py  实测 sha256 = 7f952787e57dd6e27f7facba78e7a5bac3cc64f987f8555d45f10e9a36ae8f10
清单条目 parent600.py                  7f952787…  10,803 字节        ← 清单同样是对的

34b85e23… → control-context-verifier-root6-window10-successor/parent600.py
             control-context-verifier-root5-window5-forward11-successor/parent600.py
```

【实测】import 即抛：

```
$ python3.11 -I -S -B -c "…spec_from_file_location('fixed_host', fixed_host.py)…exec_module…"
ValueError: Frozen dependency drift: …/control-context-verifier-root6-linux-successor/parent600
```

这条比 R15-F1 还靠前：即使 `bridge.py:16` 改对了，`load_host()` 里 `spec.loader.exec_module(fixed_host)` 也会立刻在这里抛。

### 2.4 这两条不是本轮引入的，是我第十四轮漏掉的

```
755d744  parent600.py  c913ca54…   ≠ 34b85e23…   ← 当时就已经不符
755d744  fixed_host.py 06e7c286…   ≠ 95a69b86…   ← 当时就已经不符
92deaea  parent600.py  7f952787…   ≠ 34b85e23…
92deaea  fixed_host.py 50dd90d1…   ≠ 95a69b86…
```

**第十四轮这两条就成立，我没查出来。** 本轮的 F1/F2 修复把摘要又挪了一次，但不是它们造成的。我把这一点写死，免得下一轮把它记成回归。

同时要指出：**前代每一代都是把这两处一起改的**。核过 `control-context-verifier-next-window-successor`：

```
parent600.py  445fb8e2…    fixed_host.py:33 钉 445fb8e2…   ✅ 自洽
fixed_host.py 0fd8c9b7…    bridge.py:16    钉 0fd8c9b7…   ✅ 自洽
```

`root6-window10-successor` 同样自洽。**所以这不是「历来如此」，是这一代把 python 三件套从前代目录复制过来、改了文件内容却没改这两处交叉钉。** 与 R14-F1/F2/F3 是同一个动作没做完——只是这两处藏在 python 内部，不在 `.mjs` 里，上一轮我只扫了 `.mjs` 侧的路径改动。

### 2.5 除这两条外，全部文件摘要钉都指对了【实测】

同一张对表的完整结果（排除 DB 内容摘要、提案摘要、查询摘要这类本就不指向文件的值）：

| 位置 | 钉值 | 指向 |
| --- | --- | --- |
| `fixed_host.py:35` | `cc3498e6…` | `docker-engineering-observation/observe.py` ✅ |
| `fixed_host.py:41` | `f56a5885…` | `/usr/bin/python3.11` ✅ |
| `host-effect.mjs:14` | `f56a5885…` | `/usr/bin/python3.11` ✅ |
| `host-effect.mjs:14` | `60e4cfac…` | 本目录 `bridge.py` ✅ |
| `parent600.py:25` | `3ac10b11…` | `docker-engineering-observation/validation.py` ✅ |
| `parent600.py:27` | `a7373982…` | `qualification-runtime/remote_evidence.py` ✅ |
| `parent600.py:28` | `0217a637…` | `public-runtime-env-diagnostic-successor/fixed_skill_fixture.py` ✅ |
| `tool-entry.functions.js:59` | `81925c09…` | `/opt/node22/bin/node` ✅ |
| `trusted-github.mjs:6` | `f687dc93…` | `/usr/local/bin/gh`（= gh v2.63.2）✅ |
| **`bridge.py:16`** | **`95a69b86…`** | **前代的 `fixed_host.py`** ❌ |
| **`fixed_host.py:33`** | **`34b85e23…`** | **前代的 `parent600.py`** ❌ |

**十一处，九对二错。**

### 2.6 `.pyc` 枚举在不同启动路径下是否给出不同集合 —— 不会【实测】

这是本轮要我查的第二点。运行时的 python 启动路径与建清单时用的**不完全一样**：建清单用 `-I -S -B`，而 `host-effect.mjs:18` 实际启动 `bridge.py` 时多了 `-X utf8`，`fixed_host.py:200` 起看门狗时也是 `-I -S -B -X utf8`。`-X utf8` 会改变编解码器的选择，理论上能改变被 import 的模块集合。我实测了两组旗标 × 四个入口：

| 旗标 | 入口 | src | cached | 不在清单中 |
| --- | --- | --- | --- | --- |
| `-I -S -B` | `parent600.py` | 59 | 44 | **0** |
| `-I -S -B` | `bridge.py` | 47 | 32 | **0** |
| `-I -S -B` | 裸启动（无入口） | 39 | 26 | **0** |
| `-I -S -B -X utf8` | `parent600.py` | 59 | 44 | **0** |
| `-I -S -B -X utf8` | `bridge.py` | 47 | 32 | **0** |
| `-I -S -B -X utf8` | 裸启动 | 39 | 26 | **0** |
| `-I -S -B` | **第 3 步校验器自己**（`import json,hashlib,os,sys`） | 33 | 21 | **0** |

**加不加 `-X utf8`，两组结果逐条相同。** `parent600.py` 的闭包是其余全部入口的超集，这一点在本容器成立。第 3 步那个校验清单的 python 进程自己的模块集合也是 `parent600.py` 闭包的子集，0 条不在清单。

（`fixed_host.py` 这一格测不出来——它 import 就撞 R15-F2 抛异常。这本身就是 2.3 的实测证据。它的闭包是 `parent600.py` 闭包的子集加 `subprocess`/`datetime`/`math` 等，而那些已经在 `parent600.py` 的 59 条里；`bridge.py` 那一格 0 缺失，间接覆盖了这条路径的前半段。）

### 2.7 301 条里有没有**新的**该进未进项

我用两种独立方法查：

**方法一：静态 import 图遍历。** 从 `cli.mjs` 出发，跟踪全部相对 `import`／`export … from`／动态 `import()`／`readFileSync(new URL(…))`。

**方法二：真实 ESM 模块图。** 装一个 `resolve` 钩子，实际 `import` 控制器的七个顶层模块（`context.mjs`、`grr.mjs`、`historical-component-observations.mjs`、`original-inputs-blob.mjs`、`result-terminal.mjs`、`source-publication.mjs`、`request-denials.mjs`），记录每一个被解析的 `file://` URL。这会执行各模块的顶层代码（读 profile、编译 ajv schema），**不**触库、不触 docker。

```
真实 ESM 模块图：34 个文件     不在清单中：0
```

34 个里包含 `control-context-verifier-runtime600/context.mjs`——**前代控制器的 context 确实被传递加载进来了**（经 `historical-component-observations.mjs:5 → runtime600/write-targets.mjs → … → runtime600/grr.mjs:3 → runtime600/context.mjs`）。它本身在清单里。

**唯一的缺口是一个被 `readFileSync` 读的文件：**

```
control-context-verifier-runtime600/context.mjs:134
  fs.readFileSync(new URL('../control-context-verifier-runtime180/status-manifest.candidate.schema.json', …))

该文件：存在（5,562 字节），但 301 条清单里没有。
前代 331 条清单里也没有。                          ← 持平，不是本轮退步
```

判定：**不阻断。** 该 `readFileSync` 在 `runtime600/context.mjs` 自己的一个函数体内，而本控制器只从 runtime600 取 `checkConsumedBudget` / `checkLateBoundPolicy` / `checkActualWriteTargets` 三个导出，不调用那个函数。所以模块虽被加载，那一行大概率不执行。我**没有**证明它一定不执行——只证明了它不在任何我能追到的调用路径上，且这个缺口与前代一模一样。列为 R15-N2。

另两类前面已说：动态库（1.5-③）、`/bin/sh` 符号链接（1.5-②）。

**另有一条不是缺口但值得记：清单是显著过包含的。** 145 条 `REPOSITORY_SOURCE` 里，真正被加载的只有 34 个 `.mjs` 加几份 schema；其余 100 多条是**别的世代控制器的源码**。过包含不损害安全性，但它意味着：任何人改动一个跟本控制器毫无关系的旧控制器文件，第 3 步就会 `EXACT_CONTROLLER_SOURCE_BYTES_DRIFT`。前代也是这个做法，持平，只作提示（R15-N3）。

### 2.8 Owner 更正书里的一处硬伤

`OwnerBaselineSubstitutionDecisionCorrection.json`：

```json
"issued_at_utc": "2026-09-12T11:4xZ",
...
"decided_at_utc": "2026-09-12T11:5xZ",
```

**两个时间戳都带字面 `x` 占位符，不是合法的 RFC3339。** 这是一份记录 Owner 决定的文件，落在里面的时间是「这个决定是什么时候做的」的唯一凭据。不阻断，但必须改（R15-N4）。

至于内容：我逐条核过它对我第十四轮 2.4／2.5／2.6 的转述，**引用准确，没有削弱，也没有夸大**。`explicitly_acknowledged` 四条与我 R14-N1 要求 Owner 正视的四点一一对应。这一条实施方做对了。

---

## 三、(3) 清单的自指性

**不构成循环。三点。**

**(a) 清单不含自身。**【实测】301 条里匹配 `ControllerSourceManifest` 的条目数 = **0**。前代 331 条同样为 0。所以不存在「清单里写着自己的摘要」这种取不到不动点的结构。

**(b) 清单摘要从库里来，不从文件里来。**【读文本】`tool-entry.functions.js:34` `expected = observation.row.execution?.binding?.controller_sha256`，第 47 行拿它和 `sha256sum "$MAN"` 比。期望值的来源是一次真实的 SQL 调用，不是被校验的那棵树。这是防自证的关键设计，仍然成立。

**(c) 钉生成器（`build-linux-manifest.mjs`）不是自指，是自测量。** 清单记的是生成器的 sha256（`be2b5209…`，5,914 字节），不是清单自己的摘要。`sha256(生成器)` 是一个与清单内容无关的确定值，所以「生成器运行后把自己的摘要写进产物」这个不动点是平凡可达的：改生成器、重跑、条目自动更新。【实测】本容器 301/301 校验通过，这一条也在其中，说明当前是自洽的。

**前代是怎么处理的？**【实测】`root6-window10-successor` 的 331 条清单里**一条生成器都没有**（`build-controller-manifest.mjs` 存在于 runtime180/runtime600 目录，但没有被钉）。**所以这是本轮新增，方向是更包含，不是退步。**

代价只有两条，都不阻断：

1. **多了一条排序约束**：生成器的字节必须先冻结，再生成清单；之后任何对生成器的改动都会让第 3 步失败，**哪怕控制器根本不执行它**——【实测】`build-linux-manifest.mjs` 不在真实 ESM 模块图里。
2. 与 2.7 的过包含是同一类代价。

**判定：不是循环，可以保留。** 真要说的话，1.5-③ 那个才是真循环的一半（`python3.11` 在校验包含它自己的清单），而我上一轮已经判过：前代把 `powershell.exe` 连同 `mscorlib.dll`、`System.dll` 钉进自己的清单，**同样是校验者在自己的清单里**，持平。

---

## 四、(4) R14-N3 / N5 / N7 的处理情况

【实测】`git diff 755d744..0f8edc0` 的全部改动只有九个文件：更正书（新增）、我的第十四轮复核（被收进它的分支）、清单、生成器、`context.mjs`、`fixed_host.py`、`host-effect.mjs`、`parent600.py`、`trusted-github.mjs`。

| 编号 | 要求 | 做了吗 | 判定 |
| --- | --- | --- | --- |
| R14-N1 | 更正 Owner 决定书的缺口陈述并请 Owner 重新过目 | **做了**，`OwnerBaselineSubstitutionDecisionCorrection.json`，Owner 已在更正后的陈述下再次接受并明确承认四点 | 关闭（但见 2.8 的时间戳） |
| R14-N2 | 改掉 `context.mjs` 注释的 "Strictly stronger" | **做了**。新注释写明「内容上更强、三处派生守卫上更弱，由摘要中和」，并补了触发器 `tgenabled='O'` 那条 | 关闭 |
| R14-N3 | `LinuxHostFeasibilityFinding.md` 第五节「容器可复现性尚未验证」应按第十四轮实测更新 | **没做**。【实测】该文件自 `a6d9b2d` 起未被改动，第五节第 2 条仍写着「这一点尚未验证，需跨会话再测一次」 | **不阻断**，但现在它错得更明显了——本轮已有 301/301 的结果（第五节） |
| R14-N5 | `xmin` 逐行证据易腐，应并入决定书或另存证据文件 | **没做**。更正书里只有聚合值（`n_tup_ins`、`n_tup_upd`、ctid 偏移序列、上界 2120、最晚 2026-09-11），**没有 88 行逐行数据** | **不阻断**，理由见下 |
| R14-N6 | 把 `canonical` 那 495 字节的 sha256 作为不变量写进资格声明 | **无法做**——资格声明尚不存在。【实测】`8bf54a9f…` 在实施方分支里只出现在我第十四轮那份文件里 | 顺延到资格声明 |
| R14-N7 | 绝对路径前提应写进资格声明 | **无法做**，同上。清单 45 条 node_modules 仍以 `/home/user/cross-memory-system/…` 落钉 | 顺延到资格声明 |

**关于 N5，要说清楚它为什么不阻断 —— 这是一次巧合，不是实施方做对了。**

我第十四轮那份 `SuccessorReviewerRound14.md` 第九节带着完整的 88 行 `(sequence, xmin, recording_transaction_id, ctid)` 和 14 行 attempt 的 `xmin`。实施方为了引用它，把**整份文件**加进了自己的分支（`92deaea` 里 `+767` 行）。**所以逐行证据事实上已经在仓库里了，两条分支上各一份。** N5 担心的「`VACUUM FREEZE` 之后无人能复核」这个风险，被这次收录挡掉了。

但这是副产品：**更正书和决定书都没有指向那份数据。** 一个只读决定书的人看不到逐行证据的存在。所以 N5 降级为 R15-N5：**在更正书里加一行 `per_row_evidence_ref`，指向 `SuccessorReviewerRound14.md` 第九节**，一行的事。

顺带，本轮复测了 N5 关心的那个物理量：

```
execution_events 中 xmin = 2（已冻结）的行数  = 0        ← 证据仍在，未被冻结抹掉
gate_attempts 中 receipt_raw is null 的行数   = 0        ← 14 行仍全部被 guard_gate_bytes 整行冻结
execution_events  ins=92 upd=0 del=0 dead=4              ← 与第十四轮完全一致
gate_attempts     ins=14 upd=90 del=0 dead=17            ← upd 未增
accepted_binding  ins=1  upd=4  del=0 dead=4             ← 与第十四轮一致
```

**并且补上一个我上一轮数少了的数：`clued_control` 里的非内部触发器一共七个，`tgenabled` 全部是 `'O'`**，不是三个：

```
accepted_binding_immutable:O, control_objects_immutable:O, events_immutable:O,
execution_binding_immutable:O, execution_events_immutable:O, gate_attempt_no_delete:O,
gate_bytes_immutable:O
```

七个全部在 `session_replication_role='replica'` 下不触发。更正书里写的是三个。**这不改变结论（结论是「真正的前向保护是钉死的摘要，不是触发器」，更正书已经这么写了），但数字应当改成七个**（R15-N6）。

---

## 五、(5) 容器可复现性 —— 在 301 条新清单下重测

### 5.1 结果：301/301，`ALL_ENTRIES_VERIFIED`【实测】

第十四轮我在这类容器里测得 207/253、46 缺失。本轮在**这个新容器**里，对 301 条新清单：

```
第一次（容器原样）：
  state    MANIFEST_HOST_VERIFICATION
  verdict  DRIFT_DETECTED
  counts   verified 300,  mismatched 0,  missing 1,  uncheckable_here 0
  missing  /usr/local/bin/gh

补齐 gh（用 1.3 节从上游 release 重建的那个二进制）后：
  verdict  ALL_ENTRIES_VERIFIED
  counts   verified 301,  mismatched 0,  missing 0,  uncheckable_here 0
```

**这是一次跨容器的完整复现：实施方在它的容器里造的 301 条清单，在我这个另起的容器里逐字节全部对上，一条不差。**

三类条目的来源分开看：

| 类别 | 条数 | 跨容器可复现性 | 本轮实测 |
| --- | --- | --- | --- |
| 镜像自带（node、docker、python3.11、57 个 stdlib `.py`、44 个 `.pyc`、2 个 `.so`、dash/sha256sum/cut/test） | 111 | **可复现，逐字节相同** | 全部命中 |
| 仓库源码 | 145 | 可复现（git） | 全部命中 |
| lockfile 可重建（node_modules） | 45 | 可复现 | `npm install ajv@6.15.0`（lockfile 钉 6.15.0）后 45/45 命中 |
| 手工安装（`gh`） | 1 | **本轮由不可复现改判为可复现** | 由 gh v2.63.2 上游 release 重建，逐字节命中 |

**特别值得记的一条：44 个 `.pyc` 在两个不同容器里逐字节相同。** 这回答了「时间戳式 `.pyc` 会不会因 mtime 漂移而重生成」这个疑虑——镜像把 `.py` 和 `.pyc` 的 mtime 一起固化了，所以缓存在新容器里依然有效、依然被加载、依然与钉值一致。

### 5.2 但复现不是白来的：四步配置前提

要把一个新容器带到 `ALL_ENTRIES_VERIFIED`，必须先做三件事，都**不在**控制器目录里记着：

1. 仓库检出到 **`/home/user/cross-memory-system`** 这个确切路径（45 条 node_modules、`tool-entry.functions.js` 的 `REPO`、`fixed_host.py:70` 都硬编码它）。
2. 在 `apps/clued-cloud` 下按 lockfile 安装依赖（`node_modules` 被 `.gitignore` 排除）。
3. 安装 **gh v2.63.2 linux_amd64** 到 `/usr/local/bin/gh`。

第四件是运行期的，比前三件更麻烦：

4. **那个被钉死摘要的 python 镜像必须已经在本地 docker 里**（`create_argv` 带 `--pull=never`）。【实测】本容器**拉不到**：manifest 取得到，blob 在 `production.cloudfront.docker.com` 上被本会话代理 403 挡掉，三个不同镜像同样结果，给 dockerd 配代理后仍然 403。

第 1–3 步我本轮全部做到了。第 4 步没有。

### 5.3 对资格有效期的最终建议

**不要绑定单个会话。也不要只靠「每会话重跑复验」。要绑在一份显式的配置清单加一次启动前复验上。**

理由：第十四轮我建议「绑在启动前复验通过」，当时的依据是 207/253，缺的 46 条来路不明。现在依据变了——**301 条全部可复现**，其中 156 条运行期依赖只剩三个来源：镜像、lockfile、一个有版本号的上游 release。在这种情况下把资格限死在一个会话里是过度保守：等于每次都要重签资格，而重签资格要走一遍独立评估者流程。

具体形式，三条：

1. **在控制器目录里加一份 `HostProvisioning.json`**，把 5.2 的四步写成机器可读的前提：
   - 检出路径 `/home/user/cross-memory-system`；
   - `apps/clued-cloud/package-lock.json` 的摘要（依赖由它确定）；
   - `gh`：`v2.63.2`、URL `https://github.com/cli/cli/releases/download/v2.63.2/gh_2.63.2_linux_amd64.tar.gz`、tarball sha256 `912fdb1ca29cb005fb746fc5d2b787a289078923a29d0f9ec19a0b00272ded00`、解包后 `bin/gh` sha256 `f687dc93…`；
   - 镜像：`docker.io/library/python@sha256:285a713…`，并注明它必须在容器里预先在位。
   这四项我本轮**都实测过**，值就在上面，抄进去即可。
2. **资格声明写成有条件的**：「本资格以 `ControllerSourceManifest`（301 条，sha256 `52e4ecff…`）在启动时全部复验通过、且 `HostProvisioning.json` 四项前提满足为条件」。**不写会话号，写条件。**
3. **把复验做成 `tool-entry.functions.js` 的第 0 步**——实际上第 1–3 步已经实质做了前三项，所以这一步主要是把「镜像在位」也纳进来，并把结论写成一行可审计的输出。

另外给清单每条 `RUNTIME_DEPENDENCY` 加 `provenance` 字段（`IMAGE` / `LOCKFILE` / `RELEASE`）的建议仍然有效，而且现在三类都有确切成员数：111 / 45 / 1。（第十四轮我写的第三类是 `MANUAL`「不可复现」，本轮改判为 `RELEASE`「可复现」。）

---

## 六、(6) 综合裁定 —— 不予资格化

**不签发 `ScopedControllerQualification`，不签发运行时受理。** 阻断项两条，均为实测，任一条都使 600 秒容器创建不出来。

### R15-F1【阻断】`bridge.py:16` 的 `HOST_SHA` 是前代 `fixed_host.py` 的摘要

见 2.2。实测 `load_host()` 抛 `ValueError: Accepted fixed host bytes changed`。

### R15-F2【阻断】`fixed_host.py:33` 钉的 `parent600.py` 摘要是前代的

见 2.3。实测 import 即抛 `ValueError: Frozen dependency drift`。

### 修法，以及**必须按这个顺序**

这两条有依赖关系，改错顺序会像本轮一样「改了一处、另一处跟着失效」。依赖链是严格无环的：`parent600.py → fixed_host.py → bridge.py → host-effect.mjs → 清单 → 下游文档`。

```
① fixed_host.py:33  改为 7f952787e57dd6e27f7facba78e7a5bac3cc64f987f8555d45f10e9a36ae8f10
                    （= 当前 parent600.py，与清单一致）
   → 此时 fixed_host.py 自己的摘要变成一个新值 X

② bridge.py:16      改为 X（必须在①之后重新量，不能用本文件里的 50dd90d1…，那是①之前的值）
   → 此时 bridge.py 自己的摘要变成一个新值 Y

③ host-effect.mjs:14 的 bridge 钉值由 60e4cfac… 改为 Y
   （这一处现在是对的，但②会让它失效——这正是本轮要防的那个坑）

④ 重跑 build-linux-manifest.mjs --write，清单摘要由 52e4ecff… 变成新值 Z

⑤ 据 Z 重签钉 controller_digest 的两份文件与下游七份
```

**验收标准（请实施方照做，不要用自测替代）：**
- 把控制器目录里全部 64 位十六进制常量对着仓库全文件 sha256 表跑一遍，确认每一个「应当指向文件」的常量都指向**本目录**的文件，而不是任何前代目录。本轮我用的就是这个方法，它一次就把两条都揪出来了。
- 在一个**干净容器**里跑 `verify-manifest-against-host.mjs --map /=/`，要求 `ALL_ENTRIES_VERIFIED`。
- 实际执行一次 `python3.11 -I -S -B -X utf8 bridge.py`（喂一份构造好的 CREATE 请求），确认它**不是**在 `load_host()` 抛错。这一条上一轮的教训是「让被声称能跑的那条路径自己跑一次」，这次同样适用。

### 需要更正、但不阻断的项

| 编号 | 内容 |
| --- | --- |
| R15-N1 | `gh` 的来源仍无记录。本轮实测答案：**gh v2.63.2 linux_amd64**，tarball 13,069,957 字节 sha256 `912fdb1c…`，`bin/gh` 50,098,328 字节 sha256 `f687dc93…`。应写进 5.3-① 的 `HostProvisioning.json`。 |
| R15-N2 | `runtime180/status-manifest.candidate.schema.json` 被已加载模块 `runtime600/context.mjs:134` 的一个函数读取，不在 301 条清单里。前代 331 条同样没有，持平。我未证明该行会执行。 |
| R15-N3 | 清单显著过包含：145 条仓库源码里真正被加载的只有 34 个 `.mjs` 加几份 schema，其余是别代控制器的源码。改动任一无关旧文件都会让第 3 步失败。持平于前代，只作提示。 |
| R15-N4 | `OwnerBaselineSubstitutionDecisionCorrection.json` 的 `issued_at_utc` = `2026-09-12T11:4xZ`、`decided_at_utc` = `2026-09-12T11:5xZ`，带字面 `x` 占位符，非合法 RFC3339。 |
| R15-N5 | 更正书应加一条 `per_row_evidence_ref`，指向 `SuccessorReviewerRound14.md` 第九节的 88 行逐行 `xmin`/`ctid` 证据。该数据现已在两条分支上各有一份，但没有任何决定文件指向它。 |
| R15-N6 | 更正书说三个不变性触发器是 `tgenabled='O'`；实测 `clued_control` 下**七个**非内部触发器全部是 `'O'`。结论不变，数字应改。 |
| R15-N7 | 第 1、4 步的执行体只有 `sha256sum` 与 `cut` 是外部程序（`test` 是 dash 内建）；`/bin/sh` 的符号链接指向未被校验；`libcrypto.so.3`（sha256sum 的哈希实现）、`ld-linux`、`libc` 等动态库未入清单。持平于前代，但这些都是镜像自带、实测跨容器稳定的文件，补进去成本极低。 |
| R15-N8 | `LinuxHostFeasibilityFinding.md` 第五节第 2 条仍写「容器可复现性尚未验证」（R14-N3 未做）。现已由本轮 301/301 回答，且第 1 条（基线文件）也已由 Owner 更正书裁定。整节应重写。 |
| R15-N9 | `work/twentieth-forward/verify-manifest-against-host.mjs` 未随清单更新：它的 `GH_PIN` 仍硬编码 Windows 的 `e2efa10a…`，只找路径以 `GitHub CLI/gh.exe` 结尾的条目，因此对 Linux 清单永远输出 `NOT_IN_MANIFEST`。**这行的用途正是交叉核对 `trusted-github.mjs` 的钉值——也就是 R14-F3 那一类错误——现在它对新控制器完全失效。** 文件头注释也仍在描述 331 条的 Windows 清单。 |
| R15-N10（顺延） | R14-N6（`canonical` 495 字节的 sha256 `8bf54a9f…` 作为不变量）与 R14-N7（绝对路径前提）仍待写入尚不存在的资格声明。 |

---

## 七、资格化之后立刻会撞上的两条 —— 当前状态下的确切排期

第十四轮第八节末尾提前告知了两条。现在给排期。

### 7.1 控制器必须先合并进 `main`

【实测】`git ls-tree origin/main scripts/phase2-qualification/control-context-verifier-root6-linux-successor/` 仍为空。而 `ScopedControllerQualification` 的 `source_ref.blobs` 是 GitHub blob URI，`readBlobRef` 经 API 取。**资格签发之前，控制器必须先在 `main` 上。**

### 7.2 控制器摘要还会再变，而且会变两次

【实测】三个值：

```
前代（window11 侧）    3a58eb87…
第十四轮那版（253 条）  9c04acde…
当前这版（301 条）      52e4ecff…            ← 本轮实测，与实施方自述一致
修完 R15-F1/F2 之后     还会再变一次（上面修法的第④步）
```

【实测】另外，`clued_control` 现在生效的绑定是：

```
binding.controller_sha256 = ac7bdd53b7fe5705ee70f4fbb08ce6a5889ccf6d6574a3575e51f16bb09c2daa
```

它对应的是 **`control-context-verifier-root5-window5-forward11-successor/ControllerSourceManifest.candidate.json`**（我把仓库里全部清单文件挨个算了 sha256 对出来的）。也就是说：`tool-entry.functions.js` 第 1 步拿到的 `expected` 现在是 `ac7bdd53…`，而磁盘上的 Linux 清单是 `52e4ecff…`——**第 1 步现在就过不去，无论 F1/F2 修不修。** 换绑定是一次写操作，不在本轮权限内。

顺带一个佐证 R15-F1/F2 成因的事实：**`ac7bdd53…` 指向的那个前代目录，正是 `bridge.py:16` 与 `fixed_host.py:33` 那两个陈旧钉值所对应的目录**（`root5-window5-forward11-successor` 与 `root6-window10-successor` 的 python 三件套同摘要）。python 三件套是从当前在绑的那一代复制过来的，内容改了，交叉钉没改。

【实测】目前**没有任何文件**钉 `52e4ecff…`（Linux 控制器的资格与运行时受理都还不存在），所以第⑤步的重签是从零写，不是改。

### 7.3 因此，修订后的次序

在原 `Status24ChainDependencyFinding.md` 第三节的 `13` 之前，要插的一段现在是这样（比第十四轮多了 12a 的具体内容与 12c 的绑定更新）：

```
12a  修复 R15-F1、R15-F2，严格按第六节①②③④的顺序，并补 R15-N1/N4/N5/N6/N8/N9
12b  【评估者】新控制器资格化评审（本轮的重做）
12c  【Owner】合并：新控制器 + HostProvisioning.json + 其资格 + 其运行时受理
     + 据新 controller_digest 重签的下游文档
12d  换绑：binding.controller_sha256 由 ac7bdd53… 改为第④步产出的新值   ← 写操作
13   注册 root6                                                        ← 不可回退
…（其余不变，13d / 13f 仍由独立评估者签发，第四次合并仍在 CP-01 之后）
```

第十四轮 10.2／10.3 的两条结论本轮未受影响，仍然成立：`Status24ChainDependencyFinding.md` 的因果链与控制器实现无关，换控制器不改变它；`HostLossTerminalRecord.md` 对 CP-01 的说法仍然过重——两份 schema（`510f3b90…`、`fae1e856…`）在新控制器里一个字节都没变，CP-01 的 A1/A2 不需要因换控制器而重做。

---

## 八、对实施方的一句话

**五条阻断项全部真闭合，没有一条是纸面上的。** 而且有两条做得比我要求的更好：`.pyc` 用 `__cached__` 取集合，自动排掉了 13 个冻结模块——我上一轮让你照前代钉 57 个，那是我错了，你这样是对的；`gh` 的摘要不只是与清单自洽，我从上游 release 独立重建出了同样的字节。

`canonicalDigest` 那处自查也是对的：import 本来就在，理由确实是假的，删得对，而且删完摘要一分不变（我做了 20 万例差分对拍）。

**但本轮的两条阻断项，和你上轮那三条是同一件事的第二层。**

你上轮的总结是「改了路径没改配套摘要」。这次把范围说得更准一点：**你从上一代目录复制了 python 三件套，改了其中两个文件的内容，却没改它们互相之间的交叉钉。** `bridge.py` 钉 `fixed_host.py`，`fixed_host.py` 钉 `parent600.py`——这两处指向的仍然是**上一代**的文件。前代每一代都是把这两处一起改的，所以不是「历来如此」。

而且我要把我自己那份也认下来：**这两条在 `755d744` 上就已经是错的，我第十四轮查了 `.mjs` 侧的四处路径改动，没有往 python 文件内部查。** 我漏了。这一轮我改了方法——把控制器目录里全部 34 个 64 位十六进制常量拿去和仓库全文件的 sha256 对一遍表——一次就把两条都揪出来，同时确认另外九处都指对了。**这个表值得你在第④步之后自己跑一遍再交。** 它比逐处 review 可靠，因为它不依赖谁记得哪一处该查。

还有一条，关于 1.2：你写「镜像 rc=0」，我复现不了——本会话的代理把 docker 的 CDN 整个挡了。**我没有因此说「镜像拿不到」**，因为那正是你这一轮已经认过的那个错误的形状。我只说：在这个容器、经这条路径，我没拿到。但这件事要写进资格前提——`--pull=never` 意味着镜像必须先在位，而它在不在位取决于容器的网络策略，不取决于控制器。

---

## 边界（再述）

未写库、未注册代际、未消耗那唯一一次 600 秒分配、未预留预算、未调用 `append_event` 或任何会写库／消耗预算的函数、未执行任何 `do $$ … $$` 块。全部 SQL 为 `select`。
`charged_seconds` 仍 **9906**（上界 10506），`charged_evidence_bytes` 仍 2201594803，`current_head` 仍 root5（`ctrgen_e5df4322…`）/ sequence 5，`active_ga_id` 与 `pending_budget_sequence` 均为 null。
本轮为做只读检查在容器里起过 `dockerd`、拉取过 `gh` 的公开 release、在自己的克隆里按 lockfile 安装过 `node_modules`；**未起 600 秒容器、未创建任何容器、未走 GA 通路、未签发 GA。** 未修改实施方检出的任何文件（其分支以只读 worktree 检出到临时目录）；临时产物已删除。
**本文件不签发资格、不签发运行时受理、不构成授权、不批准也不合并任何 PR。** 最终裁量权在 Owner（`tdoljyj`）。
CI 五项长期全红、日志 404，已确认非瞬时；本文件不把它记作通过，也未尝试修复。
