# ADR 0029：通用包重装停在半途：两侧各按自己的记录描述，暂停按原因认领，运行器先等再判

- 状态：已实现（分支 `claude/installer-half-install`，未发布、未安装）
- 日期：2026-11-13
- Owner Decision：统领原则（`42d5bf8d`：最终系统极简、低耗、高效，错误从机制上堵死）；节点只有两条路：通用升级，升不了就用通用安装包重装，不按台打补丁
- 证据（DESK = desk-w-591，只读）：`D:/w/tmp/desk-reinstall-8238bbf2/launch-20261113T091009Z/`（`progress/002..011`、`terminal.json`、`linux-version-facts.json`）；现装 `upgrade\current.json` 与 `upgrade\mailbox\responses\version-facts.json`；`D:/w/tmp/prepare-b.out`
- 代码：`rollout/fleet/install.mjs`（`readNode`、`rolesDerivedReinstall`、`prepareInstall`）、`reinstall/rehearse.py`、`reinstall/linux/prep.py`、`reinstall/launcher/template.ps1`（`Wait-RunnerState`）、`reinstall/launcher/continue.py`（`w1_pause`）
- 测试（修复前都失败）：`rollout/fleet/test/install.test.mjs` “install: a node an earlier package's launch left half installed …”；`reinstall/test/test_rehearse.py` `test_a_half_installed_node_is_rehearsed_as_it_is_by_the_generic_package`；`reinstall/test/test_fleet_continue.py` `test_the_field_stop_after_linux_b_is_continued_even_after_its_w1_pause_was_lifted`；`reinstall/test/test_launcher_service_state.py` `test_a_runner_the_paused_resident_swapped_for_its_maintenance_is_waited_for_not_refused`

## 1. 现场

包 `fleet-node-2026.11.13-8238bbf2`。TURING 同一个包装完并核验通过。DESK 当时在当班：

| 时刻（UTC） | 事 |
|---|---|
| 09:10 前 | `prepare`：W1 暂停确认（`OLD_RESIDENT_PAUSED_NO_OPEN_BATCH`），生成启动器 |
| 09:10:17–22 | 启动器：`windows-preflight-before-linux` 通过（运行器原样、已停） |
| 09:10:22–34 | Linux A、B 完成，输出核对通过（`011-linux-output-checked`）。Linux 侧已是新包：`ciSourceManifestSha256 = 1c10c73d…` |
| 09:10:35 | `Step-UninstallPreflight` 读到运行器是 `controller-formal-generic-v2.exe`、RUNNING（`originalBinary=false`、`stoppedPid0=false`，其余三项为真），停在 `RUNNER_SERVICE_NOT_AS_REVIEWED`。Windows 侧仍是旧装 `1309514d…` |
| 之后 | 同一个启动器再提权运行：`EXISTING_EXECUTION_PRESERVED`（启动器一次性，本来如此）；人工解除了 W1 暂停；再 `prepare`：`LINUX_VERSION_FACTS_NOT_THE_CURRENT_GENERATION`，detail 为空 |

结果：常驻 `versions.consistent=false`、`UPGRADE_VERSION_SKEW`，当班但不接活。

## 2. 三个根因

1. **运行器的一次读数被当成“运行器被改了”。** 暂停只停批次，不停常驻自己的维护：当班（ACTIVE）节点在暂停下仍做角色探测、队列观察、第 10 段只撤销（`executor.mjs` 暂停分支 `roleProbeMaintenance({ upgradePaused })`、`trainMaintenance({ paused })`，§41.3、§72）。每次都把运行器服务临时换成 controller，结束后由 broker 换回原样、停止。`Get-RunnerState` 读一次就判（`template.ps1` 两处预检），正好读在交换中间就停——而且第二处在 Linux B 之后，B 不可撤销。TURING 待命，没有这种交换，所以同一个包在它上面通过。
2. **`prepare` 要求被替换掉的两侧先彼此一致。** `install.mjs#readNode` 要求 Linux 版本事实等于 `current.json` 的 `linux` 块（`LINUX_VERSION_FACTS_NOT_THE_CURRENT_GENERATION`），`prep.py`、`rehearse.py` 各有一条同样的要求。停在 B 之后的节点正好不满足，于是通用重装这条路对它关死了；而 Linux A 本来就只按 Linux 自己的事实、以 root 核对现场（`OLD_MANIFEST`、`OLD_LINUX_RES_MANIFEST`、`OLD_GENERATION` 都取自 facts）。
3. **续行钉死在一次暂停确认的字节上。** 设计好的出路是续行（`generate.py --fleet-continue`，`before-uninstall`：跳过 Linux，从卸载预检起）。但启动器要求 `state\PAUSED.json` 逐字节等于生成时钉住的那一份（`Test-OldRootQuiet`：`OLD_RESIDENT_PAUSE_NOT_THE_W1_ONE`）。暂停一旦被解除，重新暂停得到的是另一份字节，这次启动就再也续不了；另一个包的 `prepare` 又把留下的 W1 暂停当成别人的暂停拒绝（`OLD_RESIDENT_PAUSED_BY_OTHER_REQUEST_RESUME_REQUIRED`），要人先去解除。

## 3. 决定

选 (b) 续装到完成，不选 (a) 回退 Linux。理由：B 不可撤销（卸载并重装 Linux 常驻、切 Source、重签资格），回退要再写一条同样重的反向 root 路径，而且断电时根本跑不了；续装只需要删掉几条“先一致”的要求。停下之后节点处于暂停（或版本不一致的 intake hold）之下不接活，再跑一次同样的通用命令就收敛，不存在只能人工处理的中间状态。

1. **两侧各按自己的记录描述（删要求，不加特例）。** `readNode` 不再要求 Linux 事实等于 `current.json` 的 `linux` 块：Windows 侧取回执与 `current.json`，Linux 侧取它自己的版本事实（已落定、一小时内）与 `roles-public.json`。`expectedInstalledLinux` 就是 facts；`rolesDerivedReinstall` 的 OLD 取 Linux 自己的 Source。Linux 侧的 Source manifest 字节只有两侧同包时才在 Windows 侧（记录里那份）；不同包时不给副本，需要它的两项（副本一致、角色推导里的旧 relay 引用）记 `deferredTo: linux-phase-a`，由 A 以 root 用 `/etc/clued-independent-ci/formal-source-manifest-v2.json` 核对——与已装 Linux manifest 延后给 A 是同一条规矩。`rehearse.py --fleet` 把两侧不同记为 `sameAsTheGenerationRecord: false`，此时已装 verify 只许 `two-sides-consistent` 一项不过；`prep.py` 在 fleet 形态下不再比 `current.json`。非 fleet 的手工路径不变。
   - 于是：被更早的包装了一半的节点（DESK），用新包照常 `prepare` + 启动器，Linux 从它现在的代到新包，Windows 从旧装到新包。
   - 本包自己装了一半（Linux 已是本包、Windows 不是）：Linux 步骤不能在自己上面再跑一遍，`prepare` 在写任何东西之前拒绝 `LINUX_SIDE_ALREADY_THIS_PACKAGE_CONTINUE_THE_STOPPED_LAUNCH`，detail 给出续行命令。
2. **暂停按原因认领。** `prepare`：现装 `PAUSED.json` 的 reason 是重装 W1 的形状（`fleet-node-reinstall-<版本>-w1-before-linux-switch`，任何版本）时，本次 W1 就是它（`plan.reasons.w1Pause` 取它的 reason），`pause-old-resident.py` 立即确认，不发第二个请求，不需要人先解除。别的暂停照旧拒绝。二选一里选“接受”而不是“早停时撤掉”：断电时撤不了，而且 A 之后停下时节点必须保持暂停。A 之前停下时自动解除（`Restore-W1Pause`）不变。
   续行：旧常驻还在的三种模式（`before-uninstall`、`b-timeout`、`a-timeout`）里，现场暂停不是钉住的那份时，`continue.py` 用启动器自己的 W1 reason 重新请求（就是 `prepare` 用的 `pause-old-resident.py`），把续行启动器的 `$InstalledPausedSha256` 钉成现在这份。别人的暂停仍拒绝（`W1_PAUSE_NOT_CONFIRMED`）。
3. **运行器先等再判。** `Wait-RunnerState`：两处只读预检在 `$RunnerSettleSeconds`（600 秒，与 quiesce 等常驻停下同一个上限）内每 2 秒读一次，直到运行器原样，按最后一次读数判；到时仍不对照旧 `RUNNER_SERVICE_NOT_AS_REVIEWED`。不关维护、不加开关。

## 4. 没有做的

- 启动器仍是一次性的（`EXISTING_EXECUTION_PRESERVED`）：再来一次的入口是 `prepare`（A 之前停下）或 `--fleet-continue`（A 之后），不是重跑同一个文件。
- 卸载之后的各种半途（`inside-uninstall`、`after-uninstall`、`after-install`）本来就由续行覆盖，未动。
- 冻结通道（`upgrader/src`、`upgrade-apply.ps1`）未动。
- 模板钉值 `TEMPLATE_SHA` 随 `Wait-RunnerState` 改变；本次改动未经独立审核，也未在真机运行。

## 5. 第二次现场（同日，包 `fleet-node-2026.11.13-45d41ebf`）：Linux A 的升级历史检查

`prepare` 通过；提权运行在 Linux A 停下（`LINUX_PHASE_A_NOT_COMPLETED`，A 的输出末尾 `HISTORY_WINDOWS_GENERATION_MISMATCH`、`UPGRADE_HISTORY_NOT_SETTLED`），A 在这之前只做核对，Linux 侧没有改动。证据：`D:/w/tmp/desk-reinstall-45d41ebf/launch-20261113T104103Z/`。

根因：同一条“先一致”的要求还有第四处，第 3 节第 1 条漏了它。`reinstall/linux/tools/check-reinstall-history.py#windows_idle`（A 的 `capture` 与 B 的 `verify-live` 都调用）除了核对 Windows 升级器空闲（`upgrade\status.json`：`op=null`、5 分钟内），还要求 Windows `current.json` 的 `linux` 块等于 Linux facts。Linux 自己的历史（facts、`current.json`、`g<N>.json`、`.next`/staged 为空、各目录与卸载计划一致）在同一个函数里本来就各自核过。

修法（删，不加特例）：`windows_idle` 只留“Windows 升级器空闲”，不再读 Windows `current.json`；`HISTORY_WINDOWS_GENERATION_MISMATCH` 这个码不复存在。顺带删掉 `prep.py` 里从 Windows `current.json` 取出、写进三个脚本却没有任何地方使用的 `OLD_PKG_SHA`（和输出里的 `oldPackage`）。

全链路清点（这次逐个读过，不再靠撞）：仓库里凡是把 Windows `current.json` 的 `linux` 块或 Windows 记录与 Linux facts 相比的地方——

| 位置 | 在不在通用重装的路上 | 处理 |
|---|---|---|
| `install.mjs#readNode`、`rolesDerivedReinstall` | 在 | 第 3 节已改 |
| `rehearse.py`（两侧比较、Source manifest 副本、已装 verify 的 `two-sides-consistent`） | 在 | 第 3 节已改（fleet 形态） |
| `prep.py:70` | 在 | 第 3 节已改（fleet 形态） |
| `check-reinstall-history.py#windows_idle`（A、B） | 在 | 本节 |
| 已装（旧）`verify-resident.ps1` 的 `two-sides-consistent` | 只在预演里跑 | 第 3 节已放行 |
| 新包 `verify-resident.ps1`、`Test-FleetLinuxOutput`、`generate.py` 的各项 | 在，但比的是新装的两侧或新包自己 | 不受影响 |
| 已装（旧）`uninstall-resident.ps1`、`rearm-resident.ps1` | 在 | 不读 facts（已读 DESK 现装文件确认；且两次现场的 `windows-preflight-before-linux` 都在两侧不同的状态下通过了它的 dry run） |
| Linux 侧其余脚本（`install/uninstall/verify-resident-linux.sh`、`clued-ci-upgrade-linux` 的 `version-facts`/`adopt-generation`、`derive-roles`、`check-host`） | 在 | 只读 Linux 自己的文件 |
| `src/upgrade-mailbox.mjs#consistent`、`engine-windows.mjs`、`status.mjs`（常驻运行时的 version-skew hold） | 旧常驻运行时 | 只停接活，不影响暂停、卸载 |
| `rollout/fleet/assemble.mjs`、`rollout/precheck.mjs`、`upgrader/` | 不在（原地升级通道） | 未动；两侧不同时原地升级本来就不该走 |

没有读到的：Linux 侧文件系统本身（A 的暂存目录、DESK 的 Linux 历史现状）——本机会话不进 WSL，只能从 A 的输出判断：A 走到历史检查，前面的现场核对（已装 Source、manifest、facts、主机钉值、卸载计划）都已通过。

测试（修复前以现场同一个码失败）：`reinstall/test/test_reinstall_history.py` `test_a_half_installed_node_is_judged_by_the_linux_sides_own_history`。
