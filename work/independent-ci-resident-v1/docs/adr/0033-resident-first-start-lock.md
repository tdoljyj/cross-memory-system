# ADR 0033：常驻首次启动不再被“被复用的 pid”挡住；启动被拒要留下原因；通道的 60 秒等待是下一版必须修的缺陷

- 状态：已实现（分支 `claude/resident-start-lock`，未发布、未安装）
- 日期：2026-11-14
- Owner Decision：统领原则（`42d5bf8d`：最终系统极简、低耗、高效，错误从机制上堵死）
- 代码：`src/resident-lock.mjs`（新）、`src/service-main.mjs`、`src/companion-main.mjs`（只换了 `readWin32Process` 的出处）
- 测试：`test/resident-start-lock.test.mjs`（夹具 `test/fixtures/service-start-entry.mjs`）
- 没有改：`upgrader/src/**`、`windows/upgrade-apply.ps1`、`src/instance-lock.mjs`、`src/store.mjs`（后两个在升级代理的导入闭包里，改一个字节就是通道变更，所有节点都要整套重装）

## 1. 现场（DESK，2026-11-14 01:37–01:40，升级操作 `17a31df9`）

第一次通用升级（包 `fleet-node-2026.11.14-4f4766cb`）在 `start` 步失败并回滚，终态 `ROLLED_BACK_PAUSED`。现场证据：

| 时间（北京） | 事实 | 出处 |
|---|---|---|
| 01:38:31.064 | 第 1 代执行器（pid 3832）确认停止 | 回执 `00000626-service-stop` |
| 01:38:38.125 | SwapBroker 启动 | Application 日志 |
| 01:38:38.405 | `CluedCIResident` 7023（1064）与 7031：“60000 毫秒内重新启动” | System 日志 |
| 01:39:38.272 | 升级代理的 `StartServices` 以 `RESIDENT_START_TIMEOUT` 结束 | `Windows PowerShell` 日志 403；`090-start.result.json` |
| 01:39:38.605 | SCM 重启的第 2 代执行器（pid 23604）接管旧锁 | `locks\stale-…173938603Z`、`holder.json` |
| 01:39:38.800 | 第 2 代 `service-start`，`generation: 2` | 回执 `00000627` |
| 01:39:38.805 | 被回滚的 stop 停掉 | 回执 `00000628` |

由此确定的事：

1. **第 2 代没有坏。** 两代的常驻代码只差 `tools/build-package.mjs`，`service-main.mjs` 与 `node.exe` 的哈希相同；第二次启动拿到了锁并写了回执。
2. **第一次启动是瞬时失败**：没有 `service-start` 回执，pid 3832 的旧锁原样留到 01:39:38.603 才被改名，所以执行器死在取锁或更早。
3. **回滚是差 0.3 秒造成的。** SCM 的失败重启间隔是 60 秒（`install-resident.ps1` 的 `restart/60000`），升级代理等 `running` 也是 60 秒（`upgrade-apply.ps1` 的 `Wait-ServiceState … 60`）。重启后的那次启动成功了，但晚了 0.3 秒。
4. **第一次为什么退出，现场没有留下。** `service-main.mjs` 把异常吞成退出码 4，服务宿主不接执行器的输出，回执还没开始写。

第 4 点只能给出候选，**不是实证**：前任退出只有 7 秒，旧锁里的 pid 3832 被别的进程拿去了，而执行器锁把“任何活着的 pid”都算作持有者，于是 `EXECUTOR_ALREADY_RUNNING`。支持它的事实：本机实测，400 个刚退出的 pid 里有 46 个在 10 秒内被复用，最快 1.3 秒；在一次性目录里用第 2 代入口和策略、预置“7 秒前、pid 仍活”的锁，得到与现场相同的特征（退出码 4、零输出、无回执、锁原样）；伴随进程早就为同一类问题改过（`companion-main.mjs` 的 `companionProcessAlive`）。另一个同样留不下痕迹的候选是接管时改名被扫描器短暂占住（`EPERM`/`EBUSY`）。

## 2. 决定

### 2.1 持有者的判断（`src/resident-lock.mjs`）

服务取执行器锁时，持有者只有同时满足下面几条才算还活着：

- pid 还在，并且不是本进程自己的 pid；
- 进程的启动时间**不晚于**锁里 `holder.json` 的 `at`。后来拿到这个 pid 的进程一定启动得更晚；启动时间和进程名来自系统进程表，不需要打开对方进程的权限，所以对方是 SYSTEM 的进程也判得出来；
- 进程名是 `node.exe`；路径和命令行读得到时，路径必须是本根目录的 `runtime\node.exe`，命令行里是 `service-main.mjs --root`。

仍然拒绝启动（宁可不启动，不要两个执行器）：进程信息整个读不到；或者是一个打不开、启动时间又不晚于锁的 `node.exe`。

锁本身只按 pid 来问，所以持有者记录由 `acquireResidentLock` 在被问到的那一刻自己读（那时锁目录还在，接管发生在回答之后）。

### 2.2 接管时的瞬时失败

`acquireResidentLock` 遇到 `EPERM`/`EBUSY`/`EACCES` 就整个重取一遍，间隔 20、50、100、250、500 毫秒，之后抛出。改名失败时什么都没变，重取是安全的。

### 2.3 启动被拒要留下原因

`service-main.mjs` 的入口改为 `run()`：启动阶段抛出的任何错误，把 `{ contract: clued.independent-ci.start-refused/1, code, detail, message, at, pid }` 写到 `state\start-refused.json`（仿伴随进程的 `companion-lock\refused.json`），再以退出码 4 结束。下一次拿到锁的启动把它删掉。因参数被拒的启动没有根目录可写，不留文件。

以后再出现“服务一启动就退出”，先看这个文件。

## 3. 测试（`test/resident-start-lock.test.mjs`）

服务只在 Windows 上能完整启动：过了锁之后第一个要 Windows 的步骤（`runner.mjs` 的 `serviceEnv`，子进程临时目录必须是盘符路径）在别的系统上会拒绝。所以“启动成功”在 Windows 上断言退出码 0 和 `service-start` 回执，在 Linux 上断言“锁已被接管，拒绝文件写的正是 `SERVICE_TEMP_DIR_REFUSED`”；所有退出码断言都把 `start-refused.json` 的内容带在失败信息里（#1095 第一版在 Linux CI 上只报了 `4 !== 0`）。

端到端：在子进程里跑服务入口本身，根目录是临时目录，锁里的 pid 背后是一个真的活进程。“Windows 对这个 pid 怎么说”由测试写的文件给出（只有测试入口读它），所以 Linux 上同样能跑；Windows 上另有一条用真实查询。

- 7 秒前的锁、pid 是活着的别的进程 → 新一代启动（退出码 0，有 `service-start` 回执，旧锁被搁置）。修复前：退出码 4。
- 同上，但那个 pid 是锁写下之后才启动的本根 `service-main` → 启动。
- 真正的持有者还活着 → 拒绝（退出码 4，没有回执，锁没动），`start-refused.json` 写着 `EXECUTOR_ALREADY_RUNNING` 和持有者 pid；持有者结束后再启动成功，文件被删。
- 进程信息读不到 → 拒绝。
- Windows 真实查询：活着的非 `service-main` 进程不挡启动。
- `residentProcessAlive` 的判定表；接管重试的次数与放弃条件。

## 4. 没有做的：下一版通道必须修

**`start` 步的等待与 SCM 的重启间隔相同，任何一次瞬时的首次启动失败都必然变成回滚。** 这在冻结通道里（`windows/upgrade-apply.ps1` 的 `Invoke-StartServices`），本次不改；本次只是把已知的瞬时失败来源从常驻一侧消掉。下一次通道变更（整套重装）必须一并修：

1. **以目标代的 `service-start` 回执为准**（回执体的 `generation` 等于目标代），不以 SCM 的 `running` 为准。`running` 只说明宿主的 `OnStart` 返回了：执行器随后立刻退出时，轮询既可能错过那一瞬间的 `running`（本次），也可能正好看到它而把一个已经死掉的服务判成启动成功。
2. **期限要长于 SCM 的重启间隔**（现在是 60 秒，期限至少 180 秒），或者见到 `stopped` 就自己再发一次 `sc start`。
3. 失败时把 `state\start-refused.json` 的内容带进 `090-start.result.json` 的 `detail`。

在那之前，节点上再遇到 `UPGRADE_START_FAILED` + `RESIDENT_START_TIMEOUT`：先看 `state\start-refused.json` 和回执里有没有目标代的 `service-start`；有回执说明新一代是好的，重新发起同一次升级即可。

## 5. 上线

常驻一侧的改动，不动通道：出新包后两台仍走通用升级（`rollout/fleet/upgrade.mjs`），先 DESK 后 TURING。注意这次修复装在**新一代**里：从第 1 代升到它的那一次启动，取锁的已经是新代码。

服务账户（`NT SERVICE\CluedCIResident`）下 `Get-CimInstance Win32_Process` 是否可用，本分支没有在真机上验证（节点只读）。查询失败时按“读不到”处理，即维持原来的拒绝，并且现在会留下 `start-refused.json`。
