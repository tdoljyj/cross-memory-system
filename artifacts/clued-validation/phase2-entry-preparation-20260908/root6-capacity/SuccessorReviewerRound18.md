# 第十八轮独立评审：把「改验证方式」当成答案，但新的验证方式仍然会在不接触被测对象时报成功

**状态：`BLOCKED_NOT_QUALIFIED_NO_WRITE_PERFORMED`。**

**裁定：不予资格化。R17-F1 与 R17-F2 确已闭合，两条我都用执行验证独立复现，修法也判对了。但 R17-F3 没有闭合 —— 只是从「正则的补集」换成了「自检没执行到的那一部分」。本轮三条阻断项：执行式自检的第②项在**根本没有到达那道字节比较**的情况下报 `ok`（与实施方自己抓到的 deadline 陷阱同形，是同一陷阱的第二个实例）；自检只执行三处钉，其余运行期校验（`arm_watchdog`、`trusted-github`）的陈旧钉写成拼接后两道闸门全绿而控制器在 `START` 第一步就抛；以及上一轮 4.3 的信任回路原样存在，并与前两条叠加成一条完整的洗白路径。**

未写库、未注册代际、未消耗那唯一一次 600 秒分配、未预留预算、未调用 `append_event` 或任何会写库／消耗预算的函数、未执行任何 `do $$ … $$` 块。全部 SQL 为 `select`（含 `pg_get_functiondef` 只读查询）。
【实测】边界复核（本轮首尾各一次，两次一致，见第十节）：`charged_seconds` = **9906**（上界 10506）、`charged_evidence_bytes` = 2201594803、`current_head.generation_id` = `ctrgen_e5df432221344996afc04b5638121d96`（root5）、root `sequence` = 5、`active_ga_id` = null、`pending_budget_sequence` = null、`clued_control.events` = 5 行、`execution_events` = 88 行、`gate_attempts` = 14 行、`control_objects` = 23 行、`execution_binding` 表的 `controller_sha256` = `edf31377…`、该表 `n_tup_upd` = 0。**全部未动。**

未起 600 秒容器、**未创建任何容器**（本容器 `dockerd` 全程未运行，`/var/run/docker.sock` 不存在，实测 `docker ps -a` 连不上守护进程；为验 `_invoke()` 我采用了打桩而非真调 docker，见 1.4）、未走 GA 通路、未签发 GA。未修改实施方检出的任何文件。未合并任何 PR、未批准任何东西。最终裁量权在 Owner（`tdoljyj`）。
CI 五项长期全红、日志 404，已确认非瞬时；本文件不把它记作通过，也未尝试修复。

评审对象：实施方分支 `claude/nice-fermat-njqlmm` head **`a51b7ce`**，`main` = `2c3a6f9`【实测】`git ls-tree origin/main …/control-context-verifier-root6-linux-successor/` 仍为空。
本评估者分支 `claude/trusting-keller-mm2s0v`（第十轮至第十八轮同一条）。

---

## 零、先说结论

| 问 | 实施方的主张 | 本轮裁定 |
| --- | --- | --- |
| (1) R17-F1 闭合 | `prepare()` 成功返回，全部步骤完成 | **闭合，且属实**【实测】我自己跑 `prepare()`，返回完整 record，四个子目录 + 4 个 Skill 文件 + fixture + `ga.raw` + `host-intent.json` **全部落盘**，没有静默跳过。见 1.1 |
| (1) 判据从 `observation` 挪到 `parent` 是否削弱 | 未声称 | **不削弱，反而略强**【实测】两个模块都经 `load()` 摘要校验后才 exec，防护等级相同；而新钉的 `18c2a16d…` **本身就在这份清单里**，旧的 `00ffff94…` 根本不在。见 1.2–1.3 |
| (1) `_invoke()`（实施方未验证过） | —— | **我验了，通过**【实测】带负向对照，**未创建容器**。见 1.4 |
| (1) 还有没有第五、第六处宿主假设 | 未声称 | **有，共四类**【实测】其中一类在**活路径上**（`observation.environment()` 返回 `SystemRoot=C:\Windows`，每次 docker 调用和看门狗启动都吃它），三类是死代码。**均不阻断**，理由逐条写在 1.5 |
| (2) 执行式自检「说了算」 | 直接执行控制器自己的字节检查 | **对三处钉成立，对其余不成立。这是本轮阻断项 R18-F1。** 见第二节 |
| (2) 三项是否都到达了目标检查 | 只说了 deadline 那一处 | **①③到达（带正向对照）；②在基线下到达，但它的「到达」判据是错的 —— 我构造了一个它报 `ok` 而字节比较根本没执行的例子。** 见 2.2–2.3 |
| (2) 自检会清理工作目录 | 「自称会清理」 | **不实**【实测】守卫是 `root.startsWith('/tmp/')`，而真实检出根是 `/home/user/…`。跑 3 次留 3 个目录 18 个文件；复制到 `/tmp/` 下则留 0 个。**不污染清单（逐字节重建一致），不影响下一次运行，不阻断。** 见 2.5 |
| (2) 自检入清单了吗 | 未声称 | **入了**【实测】303 条里有 `selftest-runtime-pins.mjs`，`check-digest-pins.mjs` 也在 |
| (3) `__pycache__` 加宽到整棵树 | 双向拒绝 | **闭合**【实测】五个兄弟目录逐个植入，两道**全部 exit 1**；R17 那个真伪造 `.pyc` 攻击也被两道拦下。运行期确在逐文件校验之前。见第三节 |
| (3) `os.walk` 会漏符号链接吗 | 未声称 | **符号链接的 `__pycache__`：构建期瞎、运行期抓得住**（两道判据不一致）；**符号链接引入的子目录里的 `__pycache__`：两道都瞎**，但不在加载路径上，**不阻断**。见 3.3 |
| (4) 清单 303 条诚实 | 303、`4ee072da…` | **诚实**【实测】303/303 逐条核对通过、本容器**逐字节重建**出同一份 62,148 字节 / 同一摘要；独立交叉核对工具 303 verified / 0 mismatched / 0 missing |
| (4) 上一轮 4.3 的信任回路 | 未处理 | **确未处理，且已能与 (2) 的缺口叠成完整洗白路径。阻断项 R18-F3。** 见 4.3 |
| (5) `platform`／`uuid` 是否已入清单 | 未声称 | **没有，而且缺口比上一轮报的大**【实测】真实执行路径上缺 5 个文件，其中一个是**本地机器码** `_uuid…so`。见第五节 |
| (6) 余留项 | —— | 逐条见第六节。**R17-2.8 已闭合**（`--write` 现在能修它自己制造的陈旧钉），这条实质改善了排期 |
| (7) 能不能资格化 | —— | **不能。三条阻断项，外加一条排期上的硬前置（第八节 8.4）** |

**三条阻断项：**

- **R18-F1【阻断，本轮重点】** 执行式自检不是权威，它只是把盲区换了个位置。【实测】(a) 第②项在 `fs.readFileSync` 抛 ENOENT 时走 `else { reached = true }`，**报 `ok` 而那道字节比较一行都没跑**；(b) 自检根本不执行 `arm_watchdog()` 的 `PYTHON_SHA`、`trusted-github.mjs` 的 gh 钉等校验，把它们写成拼接后**两道闸门全绿**，控制器在 `START` 第一步 / 第一次读 blob 时抛。
- **R18-F2【阻断】** 上一轮 4.3 的信任回路原样存在：往清单里加一行绝对路径条目即可把任意字面量洗成「已解释」【实测】；与 R18-F1 叠加后，**改一处钉 + 加一行清单 = 两道闸门全绿 + 控制器坏掉**。
- **R18-F3【阻断，排期】** 【实测】`effective_execution_binding()` 里的后继计数白名单是 `(1,…,19)`，而当前 `EXECUTION_BINDING_FORWARD_ACCEPTED` 事件**正好 19 条**。第 20 次换绑（即绑到新控制器那一次）会让该函数抛 `at_most_four_exact_binding_successors_required`，`read_execution()` 随之失败，**可信入口第一步就取不到期望摘要**。前十七轮的排期都没有列出这一步。

---

## 一、(1) R17-F1 —— 闭合，修法正确，但目录里还有四类没人移植的宿主假设

### 1.1 `prepare()` 真的跑完了全部步骤，没有静默跳过【实测】

我没有采信「成功返回」这四个字，而是自己跑一次并把它写出来的东西全枚举了：

```
RETURNED RECORD:
 nonce               7565411649f5a2810dd23846ac018d41
 ga_sha256           9fe8037e81a052a808812890b7dd4d92af1ddf0505ec101390b6e36ed5b5dda8
 host_source_sha256  7c9d0fa4df941aca2c2ee5ad6738bc96dddfb4b7d5d4610d55caea332f548c4e
 started_monotonic / deadline_monotonic / deadline_utc / authority_effect: NONE

落盘内容：
  FILE ga.raw                               ← :87-88  写 GA 原字节
  FILE host-intent.json                     ← :93     observation.persist
  DIR  allowed / docker-config / temp       ← :70-71  四个子目录
  DIR  driver
  FILE driver/SKILL.md                      ← :74-81  Skill 字节先验后拷
  FILE driver/references/engineering.md
  FILE driver/references/memory-operations.md
  FILE driver/fixed_skill_fixture.py        ← :83-86  CHILD_SHA 校验后拷
```

**`prepare()` 的每一条语句都执行了**：平台闸（:59）、GA 长度界（:61）、`json.loads`、deadline 上界 600 秒（:66）、四个 `mkdir`、`subject_bytes_valid` 校验、四个 Skill 文件的 `open('xb')` 写入、`CHILD_PATH` 摘要校验、fixture 写入、`ga.raw` 写入、`persist`。**「成功返回」这个声称属实，而且是完整的。**

### 1.2 判据搬家是否削弱 —— 不削弱【实测】

三个子问题分开答。

**(a) `observe.py` 里的 `DOCKER_SHA` 原本还起别的作用吗？** 起，但与本控制器无关。【实测】全仓引用点只有两处在 `observe.py` 自己身上：`:245`（`observe()` 函数里的 win32 + docker 校验）与 `:264`（证据记录里回填 `docker_cli_sha256`）。而 `observe()` **不在本控制器的任何调用路径上** —— `bridge.dispatch` 的四个分支（CREATE/START/STOP/inspect）没有一条会走到它。所以把本控制器的判据挪走，**不改变 `observe.py` 对其他七个前代控制器的语义**（它们的 `fixed_host.py:56/:116` 仍原样引用 `observation.DOCKER_SHA`，一个字都没动 —— 这正是我上一轮要求的「不动共享模块」）。

**(b) `observation.digest()` 的语义等价吗？** 等价。【读文本】`def digest(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()` —— 它对传入的是哪个文件毫不关心，`Path(parent.DOCKER)` 只是换了实参。（`Path(...)` 这层包装是多余的，函数内部已经 `Path(path)`，但无害。）

**(c) `parent.DOCKER_SHA` 的来源等价吗？** 等价，而且**证据链更强**。两个常量都是源码里的硬编码值，都在一个先校摘要再 exec 的模块里（`fixed_host.load()` 对 `parent600.py` 钉 `feb409d4…`，对 `observe.py` 钉 `cc3498e6…`，两者同级）。差别在于：

```
旧判据 observation.DOCKER_SHA = 00ffff945b67… （Windows docker.exe）→ 不在这份清单里
新判据 parent.DOCKER_SHA      = 18c2a16d6aa0… （/usr/bin/docker）  → 在清单里，RUNTIME_DEPENDENCY，44,320,674 字节
【实测】/usr/bin/docker 非符号链接，本容器实测摘要 = 18c2a16d6aa0331bbd78b93e0a57f344c62bda0be52c054d4ee80e11176b0c30 ✅
```

**新判据比旧判据多受一层保护**：它被清单覆盖，因此可信入口的逐文件校验会独立复核它；旧判据不被覆盖。**这个搬家是净改善，我判它正确。**

### 1.3 修法与我上一轮给的最小修法逐字一致【读文本】

我上一轮写的三步 ①②③ 全部照做了，且 `observe.py` 确实**一字未动**（`git diff c578af3 a51b7ce` 的文件清单里没有它）。

### 1.4 `_invoke()`（第 119 行）—— 实施方没验过，我验了【实测】

`prepare()` 走不到 `_invoke()`，所以自检的第③项对它零覆盖。我用**不创建容器**的方式验：`_invoke()` 里平台闸之后的第一个调用点是 `parent.fixed_argv(...)`（:121），在那里打桩，就能在**不触碰 docker** 的前提下判断闸是否放行。

```
【实测】
FixedHost constructed OK
RESULT: gate PASSED -> reached REACHED_fixed_argv (line 121); NO docker was invoked, NO container created

--- 负向对照：把 parent.DOCKER_SHA 改成 '0'*64 再调一次 ---
  gate REFUSED at fixed_host.py:120 -> Exact Docker executable required   （证明那道闸确实在执行，不是被跳过）
```

**`_invoke()` 的平台闸与二进制闸在这台 Linux 上都放行，且确实在执行。R17-F1 的两处都闭合。**

### 1.5 第五处、第六处…… 我把整棵执行图重扫了一遍【实测】

上一轮我是靠「跑 `CREATE` 看真实 traceback」发现 F1 的。这一轮 `CREATE` 已经能跑过 `prepare()`，所以我换了方法：先把**真实执行集合**定出来，再逐个文件按「Windows 假设」扫。

执行集合（由钉图静态确定，逐条核过）：控制器目录的 `bridge.py` / `fixed_host.py` / `parent600.py`，跨目录 exec 的 `docker-engineering-observation/observe.py`、`docker-engineering-observation/validation.py`、`qualification-runtime/remote_evidence.py`、`control-context-verifier-public-runtime-env-diagnostic-successor/fixed_skill_fixture.py`，以及 `validation.py` 再 exec 的 `linux-docker-driver/candidate.py`。JS 侧 21 个文件全扫。

扫出四类，**按是否在活路径上分开**：

| # | 位置 | 内容 | 在活路径上？ | 判定 |
| --- | --- | --- | --- | --- |
| **第五处** | `fixed_host.py:148`、`:210` → `observe.py:50-51` | `observation.environment()` 返回 `{'SystemRoot':'C:\\Windows','WINDIR':'C:\\Windows','TEMP':…,'TMP':…}` —— **每一次 docker CLI 调用、以及看门狗子进程**，拿到的就是这个 env，且**没有 PATH、没有 HOME** | **是** | **未移植，但实测不致命**。见下 |
| 第六处 | `remote_evidence.py:98` | `GitHubEvidence.__init__` 写死 `C:/Program Files/GitHub CLI/gh.exe` | 否 | 死代码。只经 `parent600.intent_before_action` 可达，`bridge.dispatch` 四个分支都不调它。JS 侧另有 `trusted-github.mjs` 用 `/usr/local/bin/gh`。**不阻断** |
| 第七处 | `observe.py:245`、`validation.py:49-54` | `observe()` 里的 `sys.platform != 'win32'`；`host_valid()` 钉死 `Version=='29.7.2'`、`GitCommit=='6a43e3d'`、**`KernelVersion=='6.18.33.2-microsoft-standard-WSL2'`** | 否 | 死代码，但**值得记一笔**：【实测】本容器 docker 是 **29.3.1 / c2be9cc**，内核是 **6.18.44-fc-v24**，三项全不匹配。只要将来有任何一步调到 `observe()` 或 `host_valid()`，它必然拒绝。**当前不阻断** |
| 第八处 | `validation.py:57-63` `source_matches` | `win[1:3]==':/'` 时补一个 `/run/desktop/mnt/host/…` 的 Windows 别名 | 是（`parent600.prestart` 校验挂载源用它） | **在 Linux 上分支不触发，逻辑正确**：期望值是 posix 路径，Docker 报的 Source 也是同一串，直接命中 `aliases={win}`。**无害** |

另外两条我查了但判为无害：`subprocess.Popen(..., creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))`【实测】Linux 的 `subprocess` 没有 `CREATE_NO_WINDOW`，取到 0，POSIX 下 `creationflags=0` 合法；JS 侧的 `windowsHide:true` 在 Linux 上是空操作。

**第五处为什么不阻断 —— 我做了实测，没有只靠推理：**

```
【实测】用 observation.environment() 那个 env 跑 docker，与用正常 env 跑，对照：
  controller env (Windows-shaped) -> rc=1  out='29.3.1'  err='failed to connect to the docker API at unix:///var/run/…'
  normal env                      -> rc=1  out='29.3.1'  err='failed to connect to the docker API at unix:///var/run/…'
  （两者退出码、stdout、stderr 完全一致；docker CLI 用绝对路径调起、--config 显式给定，不需要 PATH/HOME）
```

**但它仍然是一处没移植干净的宿主假设，而且有一个真实的功能损失**：那个函数的意图（注释写着「explicit public infrastructure only」）是把子进程的临时目录约束在工作目录里，靠的是 `TEMP`/`TMP`。Go 写的 docker CLI 在 Unix 上只看 `TMPDIR`，**不看 `TEMP`/`TMP`** —— 所以这个约束在 Linux 上**没有生效**，docker 的临时文件会落到 `/tmp`。记为 R18-N1，不阻断。

**这一节的结论**：实施方只修了我点名的两处，是对的 —— 因为剩下的四类**确实都不阻断**。但没有人系统地找过，所以也没有人知道它们不阻断；「修完点名的两处」和「移植完成」之间的差距，这一轮仍然是靠评估者补上的。

---

## 二、(2) 执行式自检 —— 方向对，但它仍然会在没接触被测对象时报成功

### 2.1 先把做对的说清楚：它确实抓住了文本扫描抓不到的那一类【实测】

我把 R17 的 A6（R16-F1 原值、只换成拼接写法）原样放回去：

```
B1  host-effect.mjs: sha(fs.readFileSync(bridge))!=='60e4cfac015c15fd53921a61a6566f74'+'0e7414f218120b0bdbc17bf17be64fd7'
    构建期文本闸门   digest pins consistent (43 literal(s) accounted for, 0 unexplained)   EXIT=0   ← 仍然瞎
    执行式自检       FAILED  host-effect.mjs pins stale python or bridge bytes (the R16-F1 shape)   EXIT=1   ✅
```

**「文本扫描先跑，执行式自检说了算」这句话，对这一处成立。R16-F1 这个具体形状，这一轮真的被堵住了。这是实打实的进步，我明确记下。**

并且我为①③各做了正向对照，确认它们**确实到达了各自声称测的那道检查**（不是「退出 0 所以算过」）：

```
C1  fixed_host.py 里 parent600 的钉改陈旧（拼接写法）
      自检①  FAILED  python chain: ValueError: Frozen dependency drift: …/parent600.py     ✅ 到达 fixed_host.py:24 的比较
C2  fixed_host.py 里跨目录 observe.py 的钉改陈旧（拼接写法）
      自检①  FAILED  python chain: ValueError: Frozen dependency drift: docker-engineering-observation/observe.py  ✅
C3  把平台闸改回 sys.platform != 'win32'
      自检③  FAILED  PREPARE_FAILED fixed_host.py:60 ValueError: Exact Linux Docker host required   ✅ 到达 :59 的闸
```

**①和③是真的执行到了。③还带着行号，这是本轮自检里最好的一处设计。**

### 2.2 【阻断】第②项：同一个陷阱的第二个实例 —— 报 `ok`，而那道字节比较一行都没跑

实施方自己抓到的是「过期 deadline 让 :13 先抛」。**但它修的是那一个实例，不是那个形状。** 判据仍然是「抛出的错误不是我认识的那两个字符串就算成功」：

```js
} catch (e) {
  const m = String(e.message);
  if (m.includes('FIXED_LIVE_HOST_OPERATION_REQUIRED'))  fail('refused before the byte check ran, …');
  else if (m.includes('EXACT_PYTHON_BRIDGE_BYTES_REQUIRED')) fail('…');
  else { reached = true; }          // ← 任何别的错误都被当成「到达了」
}
if (reached) ok('host-effect.mjs byte checks on python3.11 and bridge.py pass');
```

而 `:14` 那一行本身就会抛别的错误 —— 它要先 `fs.readFileSync(python)` 和 `fs.readFileSync(bridge)`，**读文件失败就是在比较之前**。

```
B2【实测】只改一处：host-effect.mjs 的 const python 指向 '/usr/bin/python3.11-moved'（钉一个字都没动）

  构建期文本闸门  digest pins consistent (44 literal(s) accounted for, 0 unexplained)      EXIT=0
  执行式自检      ok  host-effect.mjs byte checks on python3.11 and bridge.py pass          EXIT=0   ❌
                  ok  （另外两项也过）  runtime pin self-test passed (all three exercised by execution)

  运行期          invokeFixedHost THROW: ENOENT: no such file or directory, open '/usr/bin/python3.11-moved'
```

**两道闸门全绿，自检逐字打印「byte checks … pass」，而那两个 `sha(...)!==` 比较一次都没有求值。控制器第一次 `CREATE` 就死。**

这不是我为了凑数构造的形状：**改解释器路径正是这个控制器这一轮刚做过的那类移植动作**（`fixed_host.py:40` 的 `PYTHON` 就是这么从 Windows 路径改过来的）。而且自检的①③用的是**自己脚本里硬编码的** `/usr/bin/python3.11`，不是 `host-effect.mjs` 的常量，所以它们不会替②兜底。

**实施方在注释里写下的那句教训 —— 「the deadline must be live for the byte check to be reached at all」—— 是对的；错在它被当成了一个特例修掉，而不是被当成「我必须证明我到达了」这个要求。正确的写法只有一种：让被测代码把「我执行了这道比较」这件事本身报告出来（哨兵值、或把比较结果而不是异常类型作为判据），而不是靠枚举失败字符串。**

### 2.3 【阻断】自检只测三件事，其余运行期校验一个都不测 —— 而它们同样能被写瞎

自检覆盖：`load()` 的三处摘要比较（①）、`host-effect.mjs` 的两处字节比较（②）、`prepare()` 的平台闸与 docker 摘要（③）。

**没有覆盖的运行期校验（我逐个列了，并挑两个做了实测）：**

| 未覆盖的校验 | 位置 | 后果 |
| --- | --- | --- |
| `arm_watchdog()` 的解释器钉 | `fixed_host.py:198` `observation.digest(PYTHON) != PYTHON_SHA` | **START 的第一步** |
| `_invoke()` 的平台 + docker 闸 | `fixed_host.py:119` | 每一次 docker 调用 |
| `trusted-github.mjs` 的 gh 字节校验 | `:13` `expectedGh` | 每一次读 blob |
| `tool-entry.functions.js` 的五步 | 入口本身 | 启动 |
| `grr.mjs` / `result-terminal.mjs` / `context.mjs` 的各类摘要 | 各处 | 结果通路 |
| `nonproduction-control-store/…/signing.mjs`（`trusted-github.mjs` 跨目录 import） | 目录外 | 闸门的 `controllerFiles()` 只扫本目录，连文本扫描都覆盖不到 |

实测两条，**都用最自然的拼接写法**（Python 相邻字符串字面量、JS 的 `+`）：

```
B3【实测】fixed_host.py:41  PYTHON_SHA = '4d6f5f81a4bca11191c4c7c6b4363269' '4d0a4ce74e068619d8fdc161d469859a'
          （值 = 前代 Windows python 的摘要；同步把 bridge/host-effect 的钉重算，以便只隔离这一个缺陷）
  构建期文本闸门  digest pins consistent (43 accounted, 0 unexplained)        EXIT=0
  执行式自检      三项全 ok，runtime pin self-test passed                      EXIT=0   ❌
  运行期          arm_watchdog THROW at fixed_host.py:199 -> Unknown: Fixed watchdog interpreter drift

B4【实测】trusted-github.mjs:6  const expectedGh='deadbeef…'+'…12345678'
  构建期文本闸门  digest pins consistent (43 accounted, 0 unexplained)        EXIT=0
  执行式自检      三项全 ok，runtime pin self-test passed                      EXIT=0   ❌
  运行期          api() THROW: GITHUB_CLI_BYTES_DRIFT
```

**「拒绝为自相矛盾的控制器出清单」这句话，在 `a51b7ce` 上仍然是假的。** 上一轮我需要多打一个 `+` 号；这一轮我需要多打一个 `+` 号，并且把它打在自检没跑到的那半边。**缺陷类一模一样，只是盲区的边界移动了。**

顺带：A11（改名不改钉）**这一轮被①抓住了**，这是自检的实打实收益；但同一次运行里第②项照样打印 `ok`（因为 `readFileSync` 抛 ENOENT 走 `else`），**又一次印证 2.2**：

```
B5【实测】把 bridge.py 改名为 bridge_v2.py，钉一字不动
  构建期文本闸门  digest pins consistent (44 accounted, 0 unexplained)   EXIT=0   ← R16-F2 第二条仍未闭合
  执行式自检      FAILED python chain: FileNotFoundError: …/bridge.py    EXIT=1   ✅（靠①）
                  ok     host-effect.mjs byte checks … pass                       ❌（②又报了假 ok）
```

### 2.4 分母仍然没有断言 —— 唯一的信号又一次被浪费

B1/B3/B4 三条里，闸门打印的数字都从 **44 变成 43**，而这个数字**不与任何期望值比对**。R16-N3 → R17-N1 要求的「打印并断言分母」第三轮未做【实测】`check-digest-pins.mjs` 里硬编码期望值的断言数 = 0。**B3 和 B4 当场就会被 `44 → 43` 抓住。**

### 2.5 清理是死代码 —— 而且只在「不能用来出清单」的那种目录下才生效【实测】

自检末尾的清理：

```js
const root = …p.paths('0'*32)[0].parent…
if (root.startsWith('/tmp/')) for (const d of fs.readdirSync(root)) fs.rmSync(…);
```

而 `parent600.paths()` 的根是 `<QUAL>/preentry-parent/work`：

```
【实测】cleanup root = /home/user/cross-memory-system/scripts/phase2-qualification/preentry-parent/work
        startsWith('/tmp/') = False        ← 清理循环一次都不执行
```

后果，两组对照：

```
【实测】真实检出根 /home/user/cross-memory-system 下跑 3 次自检
   preentry-parent/work 子目录数 = 3    残留文件数 = 18   （每次一个随机 nonce 目录，含 4 份 Skill 拷贝 + fixture + ga.raw + host-intent.json）
【实测】把整棵树复制到 /tmp/… 下跑 3 次
   preentry-parent/work 子目录数 = 0
```

**而「必须在 `/home/user/cross-memory-system` 下出清单」是第十六轮 3.7 定下的、摘要定义的一部分。** 也就是说：**清理只在那个唯一不允许用来出清单的位置生效。** 实施方说「自称会清理」，它在实施方验证的那个地方确实清理了 —— 这正是问题：**这条声称是在一个它不可能失败的地方验证的。** 与 2.2 的 `else{reached=true}`、与前几轮的模式完全同形。

【实测】另外三个子问题的答案，逐条给：

- **会污染清单吗？不会。** 我带着残留目录原样跑 `build-linux-manifest.mjs --write`，产出与提交的那份**逐字节相同**（清单的仓库源枚举只 `readdirSync` 控制器目录一层，不碰 `preentry-parent`）。
- **会影响下一次运行吗？不会。** nonce 随机，`folder.mkdir(exist_ok=False)` 不撞。
- **会被 git 发现吗？不会。** `scripts/phase2-qualification/preentry-parent/.gitignore` 第 1 行就是 `work/` —— **这正是它三轮没被发现的原因**：`git status` 永远是干净的。

**综合判定：R18-N2，必须修，但不阻断。** 需要提醒的一件事：残留目录位于 QUAL 树内，而两道 `__pycache__` 检查现在都遍历整棵 QUAL 树 —— 只要将来有任何进程不带 `-B` 地 import 过那份 `driver/fixed_skill_fixture.py` 拷贝，**控制器会把自己锁死**（构建期与运行期同时 `CONTROLLER_BYTECODE_CACHE_PRESENT`）。这条不是现实缺陷，是残留物加上新检查后新出现的一个耦合。

### 2.6 自检本身入清单了吗 —— 入了【实测】

```
303 条里包含 …/selftest-runtime-pins.mjs        ✅
303 条里包含 …/check-digest-pins.mjs            ✅
清单不列自身                                    ✅
```

**所以「若它可被篡改，两道闸门一起失效」这个担心，在清单这一层是被覆盖的**：改动自检文件会让可信入口的逐文件校验报 `EXACT_CONTROLLER_SOURCE_BYTES_DRIFT`。但要说清楚这层保护的边界：**清单保护的是「运行时用的是这份自检」，不是「出清单时用的是这份自检」** —— 出清单那一刻自检还没有被任何东西钉住，`build-linux-manifest.mjs` 就是拿本地文件跑的。这是构建工具链的固有性质，前代同样如此，**不阻断**。

### 2.7 怎么改才算改了这一类 —— 第四次说同一件事，这次把要求写成可检验的形式

前三轮我说「不要再加正则」「让钉成为一等公民」。这一轮实施方换了验证方式 —— 方向对，但**换成执行以后，「覆盖率」这个问题没有跟着换过来**。执行式验证的补集同样是静默的，而且这一次补集更难看见，因为它藏在「我执行了什么」而不是「我匹配了什么」里。

三条硬要求：

1. **每一项自检必须把「我到达了那道检查」作为被测代码的输出，而不是作为测试代码的推断。** 具体到第②项：不要靠异常字符串分类，让 `host-effect.mjs` 导出一个只做那两次比较并返回布尔的函数（或让自检直接对 `python`/`bridge` 两个常量解析出的路径自行 `readFileSync` 并比对同一字面量），然后断言「比较发生了，且结果为真」。**判据必须是正向的。**
2. **枚举出控制器全部运行期字节／摘要校验，写成一张表，自检逐条执行，并断言表的长度。** 我在 2.3 给了起始清单（至少 6 处未覆盖）。做不到全执行的，必须在自检输出里**显式列为未覆盖**，而不是不提。
3. **文本闸门补上分母断言**（R17-N1，第三轮）。它成本最低、当场就能抓住 B3/B4。

**验收：下面这批必须全部 exit 1（构建期与自检合起来算过）——**
B1（拼接，已过）、**B2（`python` 常量指向不存在的路径）**、**B3（`PYTHON_SHA` 拼接写陈旧）**、**B4（`expectedGh` 拼接写陈旧）**、B5 的第②项不得报 `ok`、A1/A2/A3b/A4/A5（上一轮八条里文本闸门仍瞎的那几条，见第六节）、A12′（见 4.3）。

---

## 三、(3) `__pycache__` 加宽 —— 闭合

### 3.1 五个兄弟目录逐个植入，两道全部拒绝【实测】

不是只试实施方说的那一个路径，也不是只试我上一轮点名的那一个：

```
植入位置                                                              构建期闸门   运行期入口
docker-engineering-observation/__pycache__                            EXIT=1      CONTROLLER_BYTECODE_CACHE_PRESENT
qualification-runtime/__pycache__                                     EXIT=1      CONTROLLER_BYTECODE_CACHE_PRESENT
control-context-verifier-public-runtime-env-diagnostic-successor/…    EXIT=1      CONTROLLER_BYTECODE_CACHE_PRESENT
linux-docker-driver/__pycache__                （validation.py 再 exec 的那一层）  EXIT=1      CONTROLLER_BYTECODE_CACHE_PRESENT
preentry-parent/runtime-successor/__pycache__  （树里一个无关的深层目录）          EXIT=1      CONTROLLER_BYTECODE_CACHE_PRESENT
```

### 3.2 R17 的真攻击也被拦下了【实测】

我没有只放空目录，而是把上一轮那个真伪造的字节码重做了一遍：

```
在 docker-engineering-observation/ 下伪造 __pycache__/observe.cpython-311.pyc
（只把 DOCKER = Path('C:/Program Files/…/docker.exe') 换成 Path('/tmp/attacker-docker')）

observe.py sha256          cc3498e6dc5e      ← 与钉 cc3498e6dc5e 逐字节相同，攻击确实成立
bridge.py → load_host()    OK
h.observation.DOCKER       /tmp/attacker-docker      ← 替换成功

构建期闸门  REFUSED: 6 digest literal(s) unexplained          EXIT=1   ✅
运行期入口  CONTROLLER_BYTECODE_CACHE_PRESENT                 EXIT=1   ✅
```

**攻击仍然有效，两道防线都拦住了。R17-F2 闭合。**

### 3.3 顺序与符号链接 —— 两个细问的答案【实测】

**顺序：运行期那道确在逐文件校验之前。** 同时植入 `__pycache__` 且把一个清单内文件改坏一字节：

```
运行期入口  CONTROLLER_BYTECODE_CACHE_PRESENT   （不是 EXACT_CONTROLLER_SOURCE_BYTES_DRIFT）
```

**符号链接 —— 两种情况不同，必须分开答：**

| 形态 | 构建期（JS `readdirSync` + `e.isDirectory()`） | 运行期（`os.walk`） | 可利用？ |
| --- | --- | --- | --- |
| `__pycache__` **本身**是指向别处目录的符号链接 | **瞎**【实测】EXIT=0 —— Dirent 对符号链接 `isDirectory()` 返回 false，直接 `continue` | **抓得住**【实测】EXIT=1 —— `os.walk` 用 `scandir` 的 `is_dir()`（跟随符号链接）把它列进 `dirnames`，只是不下降进去 | **是攻击路径，但最后一道防线仍然拒绝**。两道判据不一致，应统一 |
| 某个**子目录**是符号链接，其下含 `__pycache__` | **瞎**【实测】 | **也瞎**【实测】EXIT=0（`followlinks=False` 不下降） | **不可利用**：加载集合里的 `.py` 全在固定路径上，没有一个位于符号链接子目录下 |

**判定：R18-N3，构建期应改用 `lstat`／`isSymbolicLink()` 一并识别，使两道判据一致。不阻断。**

---

## 四、(4) 清单 303 条 —— 诚实；但 4.3 那条回路没人碰

### 4.1 诚实、可复现【实测】

```
清单 sha256   4ee072da961903b2b38c94ab4a36ab64ee13cf6dc170583cb2df1ec698f815c0   ← 与实施方自述一致
字节          62,148
条目          303 = REPOSITORY_SOURCE 147 + RUNTIME_DEPENDENCY 156                ← 一致
逐条核对      303 / 303 verified，drift 0，missing 0
object_type=ControllerSourceManifest   qualification_issued=False   清单不列自身  ✅
控制器目录 21 个文件（清单列 20 条，不含自身）—— 与自述一致
```

### 4.2 逐字节重建成功【实测】

在 `/home/user/cross-memory-system` 下配齐前提（`gh v2.63.2` 装到 `/usr/local/bin/gh`，tarball 13,069,957 字节 `912fdb1c…`、`bin/gh` `f687dc93…` —— 第四次独立确认；按 lockfile 装 `ajv@6.15.0` 等五个包）后原样跑：

```
digest pins consistent (44 literal(s) accounted for, 0 unexplained)
runtime pin self-test passed (all three exercised by execution)
files       303 {"RUNTIME_DEPENDENCY":156,"REPOSITORY_SOURCE":147}
wrote … 62148 bytes
cmp 实施方那份 → 逐字节相同 ✓
```

独立交叉核对工具（第十六轮验收第 4 条）：

```
$ node work/twentieth-forward/verify-manifest-against-host.mjs …candidate.json --map /=/
"counts": {"verified": 303, "mismatched": 0, "missing": 0, "uncheckable_here": 0}    EXIT=0
```

**`ALL_ENTRIES_VERIFIED` 属实。**（R15-N9 关于该工具仍是 Windows 版的记录本轮不再复述；它这次报 303 全过。）

### 4.3 【阻断 R18-F2】信任回路未处理，并已与 (2) 的缺口叠成完整洗白路径

`check-digest-pins.mjs:87-88` 依旧从 `ControllerSourceManifest.candidate.json` 里取绝对路径播种索引。上一轮我说「这一轮后果有限（下次 `--write` 会把那条挤掉）」—— **这一轮它不再有限，因为它可以和自检的覆盖缺口叠起来用：**

```
A12′【实测】
 ① 把 trusted-github.mjs 的 gh 钉改成任意文件 blob.bin 的摘要 71b99c30ce19（普通小写字面量，连拼接都不用）
      文本闸门  UNEXPLAINED trusted-github.mjs: 71b99c30ce19 matches no file …   EXIT=1
      自检      三项全 ok                                                        EXIT=0
 ② 只往清单里追加一条 {"path":"…/blob.bin","role":"RUNTIME_DEPENDENCY",…}，钉一个字都不再改
      文本闸门  digest pins consistent (44 accounted, 0 unexplained)             EXIT=0   ❌
      自检      三项全 ok，runtime pin self-test passed                          EXIT=0   ❌
 运行期  api() THROW: GITHUB_CLI_BYTES_DRIFT
```

**改一处钉 + 往它要保护的那份清单里加一行 = 两道闸门全绿 + 控制器坏掉。** 上一轮的 R17-N2 从「方向错」升级为阻断项：**闸门的信任基不能包含它自己的输出物。** 宿主二进制的摘要应当来自一张与清单并列、独立的 provisioning 表（即 R15-N1 那份始终不存在的 `HostProvisioning.json`）。

### 4.4 R16-N2 未做，风险仍在【实测】

`build-linux-manifest.mjs` 仍是 `readdirSync`（`git ls-files` 0 处）。上一轮记的毛病原样保留，并且现在多了一个实例：2.5 的残留工作目录就是「一个临时产生的目录落在树里、清单管不到」的第二次发生。

---

## 五、(5) `platform` 与 `uuid` —— 没做，而且缺口比上一轮报的大

【实测】303 条里 `platform`、`uuid` 相关条目数 = **0**。

我把上一轮的测量重做了一遍，并且这次把**两个枚举起点的差集**精确算了出来：

```
从 parent600.py 起（清单第 4 步的枚举起点）可达 stdlib .py:  59
从 bridge.py + load_host() 起（真实执行起点）可达 stdlib .py: 62

差集（真实路径有、枚举起点没有）——共 3 个模块 / 5 个文件：
  /usr/lib/python3.11/platform.py                                         .py在清单=False  .pyc存在=True  .pyc在清单=False
  /usr/lib/python3.11/uuid.py                                             .py在清单=False  .pyc存在=True  .pyc在清单=False
  /usr/lib/python3.11/lib-dynload/_uuid.cpython-311-x86_64-linux-gnu.so    不在清单
```

**上一轮我报的是 2 个模块 4 个文件，少报了第三个 —— 而第三个是本地机器码。** 并且这不是「清单有意不收 `.so`」：

```
【实测】清单里已有的 .so 条目：2 个
   /usr/lib/python3.11/lib-dynload/_hashlib.cpython-311-x86_64-linux-gnu.so
   /usr/lib/python3.11/lib-dynload/_json.cpython-311-x86_64-linux-gnu.so
【实测】真实执行路径上加载的 .so：3 个（上面两个 + _uuid…so）
```

**清单自己的口径就是「加载了哪个扩展模块就钉哪个」，而 `_hashlib.so` 正是算出这条链上每一个摘要的那个模块。漏掉 `_uuid.so` 不是政策，是同一个 bug：枚举的起点是 `parent600.py`，执行的起点是 `bridge.py`。** 修法仍是一行：把 `build-linux-manifest.mjs:81` 的 `spec_from_file_location` 目标改成 `bridge.py` 并调 `load_host()`。条目数会由 303 变为 **308**。

不阻断（这三个模块的字节仍受宿主镜像固化保护，且与前代持平），但**这是同一个根因第二轮未修，而且每轮测都会多找出一点**。

---

## 六、(6) 余留项现状

| 编号 | 内容 | 做了吗 | 判定 |
| --- | --- | --- | --- |
| **R17-F1** | Linux 控制器仍要求 win32 | **做了** | **闭合**【实测】见第一节。修法判正确 |
| **R17-F2** | `__pycache__` 只封一个入口 | **做了** | **闭合**【实测】见第三节。残留符号链接缺口降级为 R18-N3 |
| **R17-F3** | 闸门不是 fail-closed | **换了验证方式，盲区缩小但未闭合** | **仍阻断，重编为 R18-F1**。见第二节 |
| **R17-2.8** | `--write` 修不了自己制造的陈旧钉 | **做了**（新增 NAMED 通道） | **闭合**【实测】追加一行到 `fixed_host.py` 后 `--write` 一次修好 `bridge.HOST_SHA` 与 `host-effect` 的 bridge 钉，两道闸门随即全绿。**这实质简化了排期** |
| R17-N1 | 闸门打印并**断言分母** | **没做**【实测】硬编码期望值 0 处 | 不阻断，但它是 B3/B4 唯一漏出的信号被浪费掉的原因（第三轮） |
| **R17-N2** | 闸门索引由清单播种 | **没做** | **升级为阻断项 R18-F2**，见 4.3 |
| R17-N3 | `--check-hash-based-pycs always` | 没做 | 不阻断 |
| R17-N4 | 入口注释「the runtime being checked is not the runtime doing the checking」对 python 是自证 | **没做**【实测】原句仍在 | 不阻断 |
| R17-N5 | 控制器目录的**子目录**是闸门与清单的盲区 | **没做**【实测】`controllerFiles()` 仍是非递归 `readdirSync(DIR)` | 不阻断 |
| R17-N6 | `build-linux-manifest.mjs` 注释仍引用已删的 `check-sibling-pins.mjs` | **没做**【实测】1 处 | 不阻断 |
| R16-N1 | 证据文件注明两个有效期（autovacuum / VACUUM FREEZE） | **没做**【实测】只有历轮评审文件提到，证据文件 0 处 | 不阻断，仍开 |
| R16-N2 | 清单枚举改 `git ls-files` | **没做**【实测】0 处 | 不阻断；本轮 2.5 的残留是它的第二个实例 |
| R16-N3 | 打印覆盖率 | 分子有、分母仍无 | 同 R17-N1 |
| R16-N4 | `--write` 回滚 + 行内定位 + 尊重豁免表 | **没做**【实测】仍无回滚代码；仍会把一行「记录前代发过什么」的历史注释**静默改写成当前值**（我复现了） | 不阻断 |
| R15-N1 | `HostProvisioning.json` | **没做**【实测】文件不存在 | 不阻断，但因 4.3 重要性再升一级 |
| R15-N2 / N3 / N7 | 清单过包含、`runtime180` schema 缺、动态库与 `/bin/sh` 符号链接 | 没做 | 不阻断，持平前代；N7 与第五节的 `_uuid.so` 同源 |
| R15-N4 | 更正书时间戳带字面 `x` | **没做**【实测】`OwnerBaselineSubstitutionDecisionCorrection.json:7` 仍是 `2026-09-12T11:4xZ` | 不阻断 |
| R15-N5 | 更正书缺 `per_row_evidence_ref` | **没做**【实测】证据文件 0 处 | 不阻断 |
| R15-N6 | 更正书说「三个」不变性触发器（实为 7） | **没做** | 不阻断 |
| R14-N3 / R15-N8 | `LinuxHostFeasibilityFinding.md` 第五节「容器可复现性尚未验证」 | **没做**【实测】原文仍在 | 不阻断，但现在是**第四轮**跨容器复现（本轮 303/303 + 逐字节重建），该句应当改写 |
| R15-N9 | `verify-manifest-against-host.mjs` | 本轮该工具报 303 全过 | 不阻断 |
| R14-N6 / N7 | 写进资格声明的两条 | **无法做**（资格声明仍不存在） | 顺延 |

**本轮新增：R18-N1（`observation.environment()` 未移植，见 1.5）、R18-N2（自检清理是死代码，见 2.5）、R18-N3（符号链接 `__pycache__` 构建期瞎，见 3.3）、R18-N4（清单的 python 枚举起点，第五节，第二轮未修）。**

---

## 七、(7) 综合裁定 —— 不予资格化

**不签发 `ScopedControllerQualification`，不签发运行时受理。**

三条阻断项：

- **R18-F1** 执行式自检不权威：第②项会在没执行字节比较时报 `ok`（B2）；自检不覆盖的运行期校验写成拼接后两道闸门全绿而控制器抛（B3 `arm_watchdog`、B4 `trusted-github`）。修法与验收见 2.7。
- **R18-F2** 闸门索引由清单播种，改一处钉 + 加一行清单即可让两道全绿（A12′）。修法：索引只用于诊断「这个陈旧值曾属于谁」，宿主二进制摘要改由独立的 `HostProvisioning.json` 提供。
- **R18-F3** 第 20 次换绑会打爆 `effective_execution_binding()` 的后继计数白名单，见 8.4。这一条是排期上的硬前置，必须先解决，否则 12d 会把可信入口打死。

---

## 八、控制器合并进 `main` 与后续重签的确切排期

### 8.1 控制器必须先合并进 `main` —— 不变

【实测】`main` 仍是 `2c3a6f9`，其上 `scripts/phase2-qualification/control-context-verifier-root6-linux-successor/` 为空。`ScopedControllerQualification` 的 `source_ref.blobs` 是 GitHub blob URI、经 API 取，**资格签发之前控制器必须先在 `main` 上**。

### 8.2 控制器摘要的轨迹

```
前代（window11 侧）      3a58eb87…
第十四轮（253 条）        9c04acde…
第十五轮（301 条）        52e4ecff…
第十六轮（302 条）        365ab926…
第十七轮（302 条）        f8ce675b…
当前这版（303 条）        4ee072da…            ← 本轮实测，与实施方自述一致
修完 R18-F1/F2 + 第五节后  还会再变一次，条目数大概率由 303 变为 308
```

约束不变：**出清单必须在 `/home/user/cross-memory-system` 下执行**（检出根是摘要定义的一部分，第十六轮 3.7）。

### 8.3 修复次序 —— 比上一轮短，因为 `--write` 这次真的能用了

上一轮我写「①②③④ 必须手改并逐级手推」。**这一条本轮作废**【实测】：

```
【实测】往 fixed_host.py 追加一行，然后跑 node check-digest-pins.mjs --write
  round 1  bridge.py pins fixed_host.py: 7c9d0fa4df94 -> 8e83f2dfe4bd (named target)
  round 1  host-effect.mjs pins bridge.py: 3e49e27b144e -> 416fd559ca3b (named target)
  repaired 2 pin(s) over 2 round(s)                                          EXIT=0
  随后两道闸门全绿
```

但**边界要写清**：NAMED 通道只认三种语法形状，**跨目录钉修不了**【实测】改 `observe.py` 后 `--write` 报 `UNEXPLAINED fixed_host.py: cc3498e6dc5e matches no file` 但不修。所以：

```
①  按 2.7 重写 selftest-runtime-pins.mjs：正向到达判据 + 全部运行期校验的表 + 断言表长
②  按 4.3 断开索引与清单的回路；新增 HostProvisioning.json（R15-N1）并让宿主摘要从它来
③  按 R17-N1 给文本闸门加分母断言
④  按 3.3 把构建期的 __pycache__ 扫描改成也识别符号链接
⑤  按第五节把清单的 python 枚举起点由 parent600.py 改为 bridge.py + load_host()   → 303 变 308
⑥  按 2.5 修自检的清理（去掉 /tmp/ 守卫，或直接删自己刚建的那一个 nonce 目录）
⑦  按 1.5 移植 observation.environment()（或在 fixed_host 里给 Linux 另给一份 env）
⑧  按 4.4 / R16-N2 把枚举换成 git ls-files
    ※ ①…⑧ 每一步都改动清单内的文件；改完跑一次 `--write`，NAMED 通道会自动推平本目录内的链
⑨  重跑 build-linux-manifest.mjs --write，必须在 /home/user/cross-memory-system 下
    清单摘要由 4ee072da… 变为新值 Z
⑩  据 Z 重签钉 controller_digest 的两份文件与下游七份
⑪  补 R18-N1~N4、R17-N1~N6、R16-N1~N4、R15-N1/N4/N5/N6/N8
```

### 8.4 【本轮新增，也是对我自己上一轮的更正】换绑这一步不是 UPDATE，而且现在会打爆一个白名单

上一轮我写：「12d 换绑：`execution_binding.controller_sha256` 由 `edf31377…`（runtime600）改为 Z ← 写操作」。**这句话在两个地方错了，我必须更正。**

**更正一：可信入口读的不是那张表。**【实测】

```
clued_control.execution_binding 表里的 controller_sha256   = edf31377…  （= runtime600 的清单摘要）
clued_control.read_execution()->'binding'->>'controller_sha256' = ac7bdd53…（= root5-window5-forward11-successor 的清单摘要）
```

`read_execution()` 的 binding 来自 `clued_control.effective_execution_binding()`，那个函数**把基表那一行拿来，再重放全部 `EXECUTION_BINDING_FORWARD_ACCEPTED` 事件**得出有效绑定。而 `tool-entry.functions.js:34` 读的正是 `observation.row.execution?.binding?.controller_sha256`，也就是 `ac7bdd53…`。**所以第十七轮 5.1 里「edf31377… 是入口真正会用的值」这句话是错的，应为 `ac7bdd53…`。**（基表那一行从插入起从未被更新，`n_tup_upd` = 0 —— 这个观测没错，错的是它的含义。）

我据此重跑了入口【实测】：

```
(a) expected = ac7bdd53…（活库有效绑定值）   ACTUAL_CONTROLLER_SOURCE_MANIFEST_DRIFT   EXIT=1   ← 第 1 步就停，符合预期
(b) expected = 4ee072da…（实际清单摘要）     {"state":"BLOCKED","reason":"BOUNDED_STDIN_INPUT_REQUIRED",…}  EXIT=1
    ← 清单摘要 ✅ → 清单形状 ✅ → 全树 __pycache__ ✅ → 303 个文件逐条校验 ✅ → node 字节校验 ✅ → cli.mjs 启动 ✅
```

**「可信入口端到端通」这个声称属实，我独立复现了。**

**更正二，也是 R18-F3：换绑 = 追加第 20 条 forward 事件，而白名单只到 19。**【实测】

```
EXECUTION_BINDING_FORWARD_ACCEPTED 事件数 = 19   （sequence 10,25,26,40,45,50,58,62,63,64,65,66,67,71,72,76,80,84,88）
effective_execution_binding() 里的守卫：
   if n not in (1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19)
       then raise exception 'at_most_four_exact_binding_successors_required'; end if;
最近一条（sequence 88，idempotency_key = root5-window9-corrected-binding-20260911）
   new_binding.controller_sha256 = ac7bdd53…      ← 与当前有效绑定一致，机制确认
迁移历史里逐次出现 …_binding_forward_17 / _18_v2 等条目           ← 每次换绑都是一个 migration
```

`n` 现在正好 19。**第 20 条事件一落库，`effective_execution_binding()` 立刻抛异常；`read_execution()` 内联调用它，于是整个 `read_execution()` 失败；而可信入口的第一步就是 `actualSql(query)` 取期望摘要 —— 入口会在拿到任何东西之前死掉。** 这不是不可解（历史上这个白名单显然被逐次上调过），但**它是一次控制平面函数变更（migration），前十七轮的排期一步都没有列过它**。

### 8.5 修订后的次序

```
12a  按 8.3 的 ①…⑪ 修复
12b  【评估者】新控制器资格化评审（第四次重做）
     —— 验收必须包含 2.7 的负向测试批次；「自检报 ok」不再被接受为证据，
        必须给出「这道检查执行了，这是它的返回值」
12c  【Owner】合并：新控制器 + HostProvisioning.json + 其资格 + 其运行时受理
     + 据新 controller_digest 重签的下游文档
12c′ 【Owner，本轮新增】把 effective_execution_binding() 的后继计数白名单由 (1..19) 扩到 (1..20)
     —— 必须与 12d 在同一次 migration 里，或严格先于 12d；
        顺带建议把这个白名单改成一个上界比较，并把错误文案 'at_most_four…' 改准确
12d  换绑：追加第 20 条 EXECUTION_BINDING_FORWARD_ACCEPTED，
     new_binding.controller_sha256 由 ac7bdd53…（forward11）改为第⑨步产出的 Z     ← 写操作
13   注册 root6                                                                  ← 不可回退
…（其余不变，13d / 13f 仍由独立评估者签发，第四次合并仍在 CP-01 之后）
```

第十四轮 10.2／10.3 的两条结论本轮仍未受影响：`Status24ChainDependencyFinding.md` 的因果链与控制器实现无关；`HostLossTerminalRecord.md` 对 CP-01 的说法仍然过重 —— 两份 schema 在新控制器里一个字节都没变【实测】。

---

## 九、对实施方

**先说做对的四件，都要明确记下。**

**一、R17-F1 修得对，而且比我给的修法还略好。** 我给的是「把判据挪到已移植的 `parent600`」，你照做了，`observe.py` 一字未动，前代七个控制器的钉不受影响。我原本没想到的一点是：新钉的 `18c2a16d…` **本身就在这份清单里**，而旧的 `00ffff94…` 根本不在 —— 所以搬家之后那个值多受一层保护（可信入口的逐文件校验会独立复核它）。我自己跑了 `prepare()` 并把它写出的每一个文件都枚举了：四个子目录、四份 Skill 拷贝、fixture、`ga.raw`、`host-intent.json` 全部落盘，**没有静默跳过任何一步**。你说的「全部完成」是真的。

**二、`_invoke()` 你没验，我替你验了，它是通的。** 我用的方法是在平台闸之后的第一个调用点 `parent.fixed_argv` 打桩 —— 这样能证明闸放行了，同时**一个容器都不创建**。还做了负向对照（把 `DOCKER_SHA` 改成 `0*64`，`fixed_host.py:120` 抛 `Exact Docker executable required`），确认那道闸真的在执行而不是被绕过。**推荐你以后就用这个形状：在被测检查之后的第一个副作用点打一个哨兵，能判断「到达了」又不产生副作用。** 这正好也是你自检第②项缺的那个东西。

**三、`__pycache__` 这一轮是真的封住了。** 我没有只试你说的那一个目录，也没有只试我点名的那一个：五个兄弟目录逐个植入，包括 `linux-docker-driver/`（`validation.py` 再往下 exec 的那一层）和一个树里完全无关的深层目录，**两道全部 exit 1**。R17 那个真伪造字节码的攻击我原样重做了一遍 —— 攻击仍然成立（`observe.py` 摘要一字未变，`observation.DOCKER` 被换成 `/tmp/attacker-docker`），而两道防线都拦下了。运行期那道确在逐文件校验之前。**这是本轮最干净的一次闭合。**

**四、`--write` 现在真的能修它自己制造的陈旧钉。** 上一轮我实测它「报错但不修」，据此把排期写成「①②③④ 必须手改并逐级手推」。**这一条本轮作废**：追加一行到 `fixed_host.py`，`--write` 一次把 `bridge.HOST_SHA` 和 `host-effect` 的 bridge 钉都推平了。NAMED 那个「先解析变量再找比较」的做法是对的 —— 你在注释里写「an earlier attempt used a 400-character window and missed by about two hundred」，那个反省也是对的。

**然后说必须说的三件。**

**第一件，最要紧：你抓到的那个 deadline 陷阱，你只修了那一个实例，没修那个形状。**

你在注释里写下的那句话是完全正确的：「the check this test exists for never ran, and with a stale digest planted as a concatenation the test still reported ok」。但你的修法是让 deadline 变成有效值 —— 也就是消除了**那一条**通往「没到达」的路径。**判据本身没有改**：

```js
else { reached = true; }          // 任何我不认识的错误 = 到达了
```

而 `:14` 那一行自己就会抛你不认识的错误 —— 它得先 `fs.readFileSync`。我只改一个常量：

```
B2  host-effect.mjs 的 const python 指向 '/usr/bin/python3.11-moved'，钉一个字都没动
    文本闸门  digest pins consistent (44 accounted, 0 unexplained)                 EXIT=0
    自检      ok  host-effect.mjs byte checks on python3.11 and bridge.py pass     EXIT=0
    运行期    invokeFixedHost THROW: ENOENT … '/usr/bin/python3.11-moved'
```

**你的自检逐字打印「byte checks … pass」，而那两个 `sha(...)!==` 比较一次都没有求值。** 这不是我编出来的形状：**改解释器路径正是这个控制器这一轮刚做过的移植动作**（`fixed_host.py:40` 的 `PYTHON` 就是这么来的）。而且你的①③用的是自检脚本里硬编码的 `/usr/bin/python3.11`，不是 `host-effect.mjs` 的常量，所以它们不替②兜底。改名 `bridge.py` 那条（B5）同样：①抓住了，**②照样报 `ok`**。

**教训不是「再补一个错误字符串」。是：判据必须是正向的 —— 让被测代码告诉你比较发生了，而不是靠枚举失败方式反推。**

**第二件：自检只测三件事，而运行期的校验远不止三处 —— 剩下的那些，缺陷照样穿过两道闸门。**

我实测了两条，都用最自然的拼接写法：

```
B3  fixed_host.py:41   PYTHON_SHA = '4d6f5f81…' '4d0a4ce7…'      （arm_watchdog 用，自检不执行）
    两道闸门全绿，EXIT=0 / EXIT=0
    运行期  arm_watchdog THROW at fixed_host.py:199 -> Fixed watchdog interpreter drift   ← START 的第一步

B4  trusted-github.mjs:6   const expectedGh='deadbeef…'+'…12345678'
    两道闸门全绿，EXIT=0 / EXIT=0
    运行期  api() THROW: GITHUB_CLI_BYTES_DRIFT                                            ← 每一次读 blob
```

**「拒绝为自相矛盾的控制器出清单」这句话，在你这一版上和上一版一样是假的。上一轮我需要多打一个 `+` 号；这一轮我仍然只需要多打一个 `+` 号，再把它打在自检没跑到的那半边。** 你把盲区的边界移动了，没有让它消失。

还有一个本来当场就能抓住这两条的信号被浪费了：闸门打印的数字从 **44 变成 43**，而它**不与任何期望值比对**。R16-N3 → R17-N1 这条我提了三轮了。把 `44` 硬编码进去、对不上就 exit 1，B3 和 B4 立刻现形。这是全篇成本最低的一项。

**第三件：你说自检会清理工作目录 —— 它只在一个不能用来出清单的地方清理。**

```js
if (root.startsWith('/tmp/')) …
```

而 `parent600.paths()` 的根是 `<QUAL>/preentry-parent/work`：

```
【实测】真实检出根 /home/user/cross-memory-system  →  cleanup root 不以 /tmp/ 开头 → 清理一次都不执行
        跑 3 次自检 = 3 个残留目录 / 18 个文件（4 份 Skill 拷贝 + fixture + ga.raw + host-intent.json）
【实测】把整棵树复制到 /tmp/ 下跑 3 次      →  残留 0 个
```

**而「必须在 `/home/user/cross-memory-system` 下出清单」是第十六轮定下的、摘要定义的一部分。** 也就是说：**你验证这条声称的位置，恰好是这条声称不可能失败的位置。** 它三轮没被发现还有第二个原因 —— `preentry-parent/.gitignore` 第一行就是 `work/`，`git status` 永远干净。

好消息是它不污染清单（我带着残留跑 `--write`，产出与你那份逐字节相同）、不影响下一次运行（nonce 随机）。所以我判它不阻断。**但它和第一件是同一件事**：一次在「不可能失败的条件下」完成的验证。

**最后。** 这一轮你第一次把「补正则」换成了「改验证方式」，这是正确的转向，我希望它继续。`__pycache__` 封得干净、`--write` 真的能用了、平台闸修得对 —— 四件事是实打实的。但同一轮里，**你的新验证方式立刻长出了和旧验证方式一模一样的病**：它有一个补集，补集是静默的，而且你在那个补集里报的是 `ok` 而不是沉默 —— 这比文本闸门的沉默更糟，因为沉默至少不撒谎。

下一轮请把三条声称都改成一条命令可证伪的形式：

1. 「第②项到达了那道比较，这是它返回的布尔值」——**不要用异常字符串分类**；
2. 「控制器的运行期字节／摘要校验共 N 处，自检执行了其中 M 处，这 N−M 处未覆盖，它们是：……」——**把分母写出来**；
3. 「B2、B3、B4 三条负向测试都 exit 1，这是输出」。

以及一条给 Owner 的：**第 20 次换绑会打爆 `effective_execution_binding()` 的 `(1..19)` 白名单**，前十七轮的排期都漏了这一步，见 8.4。我上一轮说「入口用的是 `edf31377…`」也错了 —— 入口用的是 `effective_execution_binding()` 算出来的 `ac7bdd53…`，在此一并更正。

---

## 十、边界（再述）

未写库、未注册代际、未消耗那唯一一次 600 秒分配、未预留预算、未调用 `append_event` 或任何会写库／消耗预算的函数、未执行任何 `do $$ … $$` 块。全部 SQL 为 `select`（含 `pg_get_functiondef`、`supabase_migrations.schema_migrations` 的只读查询）。
【实测】收尾复核（与开篇一致）：`charged_seconds` 仍 **9906**（上界 10506）、`charged_evidence_bytes` 仍 2201594803、`root.generation_id` 仍 `ctrgen_e5df432221344996afc04b5638121d96`（root5）/ `sequence` 5、`active_ga_id` 与 `pending_budget_sequence` 均为 null、`events` 5 行、`execution_events` 88 行、`gate_attempts` 14 行、`control_objects` 23 行、`execution_binding` 表的 `controller_sha256` 仍 `edf31377…`、该表 `n_tup_upd` 仍为 0、`EXECUTION_BINDING_FORWARD_ACCEPTED` 事件仍 19 条。

**未起 600 秒容器、未创建任何容器、未走 GA 通路、未签发 GA。**【实测】本容器 `dockerd` 全程未运行（`/var/run/docker.sock` 不存在），`docker ps -a` 始终报连不上守护进程；为验 `_invoke()` 我在平台闸之后的第一个调用点打桩，**从未真正调起 docker**。

本轮为做只读检查，在容器里下载过 `gh v2.63.2` 的公开 release 并临时装到 `/usr/local/bin/gh`、按 lockfile 临时装过 `apps/clued-cloud/node_modules`、跑过 `check-digest-pins.mjs`／`selftest-runtime-pins.mjs`／`build-linux-manifest.mjs`、把实施方分支以 `git worktree` 只读检出到临时目录、把 `scripts/phase2-qualification` 整棵树复制到临时目录做 B/C/D/E/F/G 全部敌意测试。**伪造的 `.pyc` 与全部敌意改动只写在临时副本上，真实控制器与真实标准库未被触碰。**
为逐字节重建清单，在本评估者自己的克隆里短暂 `git checkout --detach a51b7ce` 并跑过一次 `--write`（产出与实施方那份逐字节相同），随后删除 `preentry-parent/work` 残留、切回本评估者分支；**实测工作树干净（`git status --porcelain` 0 行）**。临时安装的 `node_modules` 与 `/usr/local/bin/gh` 已删除，`git worktree` 已移除，宿主恢复为发现时的状态（本容器原本没有 `gh`）。临时目录产物已删。

**未修改实施方检出的任何文件。**
**本文件不签发资格、不签发运行时受理、不构成授权、不批准也不合并任何 PR。** 最终裁量权在 Owner（`tdoljyj`）。
CI 五项长期全红、日志 404，已确认非瞬时；本文件不把它记作通过，也未尝试修复。
