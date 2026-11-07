# M5 运维手册：companion 不再依赖 Owner 登录（DESIGN §65）

适用：DESK-W-591 先，TURING 后。每台各做一遍。

本轮代码只在分支上，**没有在任何机器上安装或切换**。下面的步骤都要等 Owner 批准整套重装（R 类）之后才做。

---

## 0. 安全规则（先读，必须遵守）

1. Windows 密码**只在安全桌面上的 Windows 凭据框里输入**。
   - 安全桌面：屏幕整体变暗，和 UAC 提示是同一个画面，标题是 “Clued companion”，用户名已预填。
   - 前提：这个提示框是你**自己刚启动的提权命令**弹出来的，而且你刚点过 UAC。
2. 在普通桌面上（屏幕没变暗）弹出的任何“请输入密码”的框，一律当作伪造，直接关掉。
3. Clued 的通知**从不**叫你输入密码或令牌。通知只给出一个码和本手册的章节号。
   - 通知队列里如果有要密码的文字，通知程序会拦下，改为显示“拦下一条可疑通知”。
4. GitHub 令牌只由你本人复制、粘贴。Agent 不运行 `-Login`，也看不到令牌。

---

## 1. 一次性准备（重装之前）

### 1.1 决定（只需一次）

接受 DESIGN §65.4.6 的“新增的秘密”：你的 Windows 密码会保存在任务计划程序里，SYSTEM 和管理员能还原出明文。

- 接受：写一条 Decision，继续往下做。
- 不接受：改走 M5-b（专用低权限账户），本手册不适用。

### 1.2 前提（Agent 可以替你只读核对）

- 你的 Windows 账户是**本地账户**，不是 Microsoft 账户（是 Microsoft 账户时，切换会被拒：`COMPANION_HEADLESS_MSA_UNSUPPORTED`）。
- 账户有密码，而且这个密码**只在这台机器上用**，没有在别处复用。
  - DESK 现在 `PasswordRequired=False`，看不出是不是空密码。如果是空的，请你自己在“设置 → 账户 → 登录选项”里设一个。
- 建议开启 C: 盘的 BitLocker（防止离线窃取）。不强制。
- 锁定策略要有余量（verify 会查，DESK 现在是 阈值 10、观察窗口 10 分钟，符合）。

### 1.3 生成 companion 专用的细粒度令牌（在 GitHub 网页上）

1. 打开 GitHub → 右上角头像 → **Settings** → 左栏最下 **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**。
2. 填写：
   - Token name：`clued-companion-desk`（TURING 用 `clued-companion-turing`）。
   - Expiration：由你决定。到期后 companion 会拒绝启动（失败关闭），照第 4.2 节换新令牌即可。
   - Resource owner：`tdoljyj`。
   - Repository access：**Only select repositories** → 只选 `cross-memory-system`。
3. Repository permissions，**只给下面这些，其余一律保持 No access**：

   | 权限 | 级别 |
   |---|---|
   | Metadata | Read-only（自动） |
   | Contents | Read-only |
   | Pull requests | Read-only |
   | Checks | Read-only |
   | Commit statuses | Read and write |
   | Actions | Read and write |
   | Issues | Read and write |

4. 点 **Generate token**。看到以 `github_pat_` 开头的令牌后，点复制按钮。**不要关这个页面**，等下一步存好再关。

### 1.4 存入令牌（你自己的 PowerShell 窗口，不提权）

普通方式打开 PowerShell（**不要**“以管理员身份运行”），执行：

```powershell
powershell.exe -NoProfile -File <仓库或安装包>\work\independent-ci-resident-v1\windows\companion-gh-login.ps1 -Login
```

- 脚本从剪贴板读令牌，检查格式（必须是 `github_pat_` 开头），写入 companion 自己的配置目录，然后清空剪贴板。
- 看到的结果：`"status": "COMPANION_GH_LOGIN_STORED"`，以及令牌长度。屏幕上不会出现令牌本身。
- 存放位置：`%LOCALAPPDATA%\CluedIndependentCI\companion-gh\`。
  - `gh\hosts.yml`：令牌。
  - `home\.gitconfig`：让 git 的凭据助手指向这份配置。
  - 文件夹 ACL 是保护的，只有 SYSTEM、Administrators 和你本人。

为什么不用 `gh auth login --with-token`：gh 在 Windows 凭据管理器里的条目按“主机 + GitHub 账号”区分，和 `GH_CONFIG_DIR` 无关。companion 的令牌和你的令牌属于同一个 GitHub 账号，再登录一次会动到你（和 Agent）正在用的那条凭据。即使加 `--insecure-storage`，gh 登录时也会先清掉“当前账号”那一条。直接写 `hosts.yml` 才能保证你和 Agent 的 gh 登录完全不变。

脚本还会尽量清掉剪贴板历史（Win+V）。注意：这会清空你**全部**的剪贴板历史，不只是令牌那一条；有要留的内容请先另存。如果你开了“跨设备同步剪贴板”，请到“设置 → 系统 → 剪贴板”里点一次“清除”。

这时可以关掉 GitHub 页面了。

### 1.5 只读验证

同一个窗口执行：

```powershell
powershell.exe -NoProfile -File <同上路径>\companion-gh-login.ps1 -Check
```

应当看到：

- `"status": "COMPANION_GH_LOGIN_READY"`；
- `folder` 为 `ok`；`token` 为 `github_pat_ (length N)`；`gitconfig` 为 `ok`；
- `reads` 下 metadata、pulls、statuses、checks、actions、issues、rules 全是 `0`；`gitLsRemote` 为 `0`；
- `ownersOwnGhLogin.exit` 为 `0`，说明你自己的 gh 登录没有被动过。

写权限（statuses、actions、issues）无法只读验证。请在 GitHub 令牌页面上再看一眼权限表，和 1.3 的表一致即可。

---

## 2. 整套重装上线（R 类：Decision + UAC + Grant）

1. 照 R 类流程批准本次重装（见第 7 节“需要的批准项”）。
2. 用**你自己的提权窗口**运行重装启动器（点一次 UAC）。
3. 启动器前面的步骤和以往一样。最后一步是 `rearm-resident.ps1 -CompanionHeadless`：
   - 屏幕变暗，出现标题为 “Clued companion” 的 Windows 凭据框，用户名已填好。
   - 输入**你的 Windows 密码**，点“确定”。
4. 之后什么都不用做。脚本会在提权一侧验收，最多 8 分钟。
   - 结果在 `W\launch\terminal.json` 的 `companionHeadless.status`：
     - `COMPANION_HEADLESS_QUALIFIED`：完成。
     - `COMPANION_HEADLESS_FELL_BACK`：没通过，已自动退回原来的登录方式。节点照常工作（和今天一样依赖登录）。原因在 `stdout` 里的 `result.failed`。处理后按第 3 节重做。
     - `COMPANION_HEADLESS_PREFLIGHT_REFUSED`：前提不满足，什么都没改。原因在 `result.preflight.refusals`。
5. 中途窗口被关、机器重启、脚本出错：不用管。切换一开始就登记了一个只做回退的 SYSTEM 任务（`\Clued\CluedCIResidentCompanionFallback`），它在开机时运行，并从开始后第 16 分钟起每 15 分钟运行一次：只有当没验收完的切换已超过 15 分钟、**而且**那个切换窗口已经不在了（关掉、重启、出错），才退回原来的登录方式，然后删掉自己。所以凭据框开着多久都没关系。它做了什么写在 `C:\ProgramData\CluedIndependentCI\resident\install\companion-headless-fallback.json`。提权运行 verify、或再运行一次切换，也会先做同样的退回。

---

## 3. 单独切换或重做

先查已安装的代码目录名：

```powershell
(Get-Content C:\ProgramData\CluedIndependentCI\resident\install\install-receipt.json -Raw | ConvertFrom-Json).residentManifestSha256
```

在**你自己的提权窗口**里（点 UAC）执行，把 `<sha>` 换成上面的结果：

```powershell
powershell.exe -NoProfile -NonInteractive -File C:\ProgramData\CluedIndependentCI\resident\resident\<sha>\windows\rearm-resident.ps1 -CompanionHeadless
```

看到安全桌面凭据框就输入密码。结果是一行 JSON：`"status": "COMPANION_HEADLESS_QUALIFIED"` 表示完成。

---

## 4. 改密码以后

### 4.1 改了 Windows 密码

不重设的话，companion 下次开机就登录不上（任务结果 `0x8007052E`）。下次你登录时，通知会显示“companion 无法登录（码 0x8007052E）”。这个任务自己不会把账户锁住：自动触发只有开机和每 15 分钟一次（都长于 10 分钟的观察窗口），普通会话也没有权限反复运行它。注意：本机任何以你身份运行的程序本来就能靠输错密码锁住你的账户（与本任务无关，今天也是如此）。

重设：提权窗口，同第 3 节，把 `-CompanionHeadless` 换成 `-CompanionCredential`：

```powershell
powershell.exe -NoProfile -NonInteractive -File C:\ProgramData\CluedIndependentCI\resident\resident\<sha>\windows\rearm-resident.ps1 -CompanionCredential
```

在安全桌面上输入**新**密码。看到 `COMPANION_HEADLESS_QUALIFIED` 即完成。

### 4.2 GitHub 令牌到期或要换

1. 照 1.3 生成新令牌（或在令牌页面点 Regenerate），复制。
2. 普通窗口：`companion-gh-login.ps1 -Login`，然后 `-Check`（同 1.4、1.5）。脚本在已安装的目录里也有：`C:\ProgramData\CluedIndependentCI\resident\resident\<sha>\windows\companion-gh-login.ps1`。
3. 让 companion 读到新令牌：提权窗口执行

   ```powershell
   Stop-ScheduledTask -TaskPath '\Clued\' -TaskName 'CluedCIResidentCompanion'
   Start-ScheduledTask -TaskPath '\Clued\' -TaskName 'CluedCIResidentCompanion'
   ```

### 4.3 手动退回原来的登录方式

提权窗口，同第 3 节，参数换成 `-CompanionInteractive`。不需要密码；存下的密码随旧定义一起删除。

---

## 5. 排查

| 看到的 | 意思 | 怎么办 |
|---|---|---|
| 通知“companion 无法登录（码 0x8007052E）” | 存的密码不对，多半是改过密码 | 第 4.1 节 |
| 码 0x80070532 / 0x80070533 / 0x80070775 | 密码过期 / 账户停用 / 账户被锁 | 先在系统里处理账户，再第 4.1 节 |
| 码 0x80070569 | 没有“作为批处理作业登录”的权限 | 检查本地安全策略，再第 3 节 |
| 通知“companion 无心跳” | companion 5 分钟以上没心跳 | 运行下面的探针；看 `supervisor.json` 的 `lastRefusal` |
| 通知“companion 反复重启” | 15 分钟内退出 5 次以上 | 同上；`lastRefusal` 为 `COMPANION_GH_*` 时照第 4.2 节 |
| 通知“服务启动后 companion 没有出现” | 服务启动 10 分钟仍无心跳 | 同上 |
| verify 的 `companion-task` 为 `other:...` | 任务定义被改过 | 第 3 节重做（升级通道不会去修它，只记 `COMPANION_TASK_NEEDS_OWNER`） |
| verify 的 `companion-gh-config` 不通过 | 专用 gh 配置缺失或 ACL 不对 | 第 1.4、1.5 节 |

### 5.1 只读探针

普通窗口即可（提权运行时会多读两个进程的真实令牌）：

```powershell
powershell.exe -NoProfile -File C:\ProgramData\CluedIndependentCI\resident\resident\<sha>\windows\probe-companion-headless.ps1
```

- 它只读、不写任何东西，不需要密码。
- 输出 JSON，对应 DESIGN §65.6 的 Q1–Q4：
  - `q1`：本会话里 WSL 能用（`wslTrue=0`），`/mnt/c` 能读 bundles（`bundlesReadable=0`），`docker` 为 `active`。
  - `q2.sameInstance`：后台会话（companion 记下的 `bootIdBackground`）与本会话看到的是同一个发行版实例（boot_id 相同）为 `true`。切换前为 `not-yet`。
  - `q3`：companion 专用的 gh 登录和 git 拉取能用（都为 `0`）。
  - `q4`：监督进程和 companion 都在会话 0；提权运行时 `tokens` 里 `elevationType` 不是 2，`adminsDenyOnly` 为 true。
- 读不到后台的那一半（切换之前），这是正常的。切换本身会在 8 分钟内从提权一侧核对这些，不通过就自动退回。

### 5.2 给人看的记录

- `%LOCALAPPDATA%\CluedIndependentCI\supervisor.json`：监督进程的会话号、最近 50 次退出、最近一次拒绝的码。
- `%LOCALAPPDATA%\CluedIndependentCI\companion-session.json`：companion 每次启动时看到的 WSL boot_id 和 docker 状态。
- 都只是给人看的，没有任何判断依赖它们。

---

## 6. 真机验收（DESIGN §65.7）

自动测试已覆盖的部分见第 8 节。下面这些必须在真机上做，DESK 先、TURING 后：

| # | 怎么做 | 通过的样子 |
|---|---|---|
| T1 无人登录冷启动 | 重启，**不登录**；10 分钟后从另一台机器看 KooYomi 节点心跳，或之后登录再看 `status.json` 的 `executor.companion.firstBeatAfterServiceStartMs` | 首次心跳在服务启动后 ≤ 10 分钟；期间由另一节点推一个小 PR，本节点在无人登录时完整跑完一个批次 |
| T2 注销 | companion 运行时注销，再登录 | companion PID 不变（探针 `background.companionProcesses`），心跳空档 < 30 秒，正在跑的批次不受影响；再登录后没有第二个 companion，通知被显示并清空 |
| T3 崩溃 | 提权窗口按 PID 结束 companion 的 node（探针里那个 PID，**不要按名字杀**）；连续结束 6 次；再结束监督进程 | 10 秒内拉起；退避封顶 60 秒、不放弃；结束监督进程后 companion 随之结束，15 分钟内由重复触发拉起；期间服务只推迟，不烧 head |
| T4 凭据失效 | 改 Windows 密码但不重设，重启 | `LastTaskResult=0x8007052E`；两小时内事件 4740 为 0，4625 至多每 15 分钟 1 次；登录后看到通知；`-CompanionCredential` 后 5 分钟内有心跳 |
| T4b 反复运行 | **普通窗口**连续执行 10 次 `schtasks /run /tn \Clued\CluedCIResidentCompanion` | 每次都“拒绝访问”，这个任务不会因此产生失败登录 |
| T4c 令牌撤销 | 在 GitHub 上撤销 companion 的令牌 | companion 照常运行，打包按现有分类报 `BUNDLE_UNAVAILABLE`；换令牌按第 4.2 节 |
| T5 升级之后 | 下一次原地升级、回滚、Recover 之后 | 任务的 XML 哈希不变（verify 的 `companion-task` 仍为 `password`）；新代际 90 秒内运行 |
| T6 中途打断 | 第 3 节运行到“验收中”时关掉窗口（另做一次：验收中重启；再做一次：在凭据框停留 20 分钟再输入） | 前两种：标记超过 15 分钟后的下一次回退任务运行（每 15 分钟，或开机后 2 分钟）把任务改回 InteractiveToken，标记和回退任务都消失；或者 15 分钟后**提权**运行 verify，记 `STALE_MARKER_FELL_BACK`。第三种：窗口一直开着，回退任务不动它，切换正常完成 |
| T7 快速启动 | 关机（不是重启）再开机，不登录 | ≤ 20 分钟能执行 |
| T8 安全 | 普通窗口试改 launch 文件、`bin\`、任务；开着 PowerShell Transcription 和 ScriptBlock 日志跑一遍第 3 节；在通知队列里放一条要密码的文字；看任务安全描述符的所有者（verify 的事实 `sdOwner`，或提权 `(New-Object -ComObject Schedule.Service)` 读 `GetSecurityDescriptor(1)`） | 改不了；转录和事件日志里搜不到密码；那条通知被拦下；普通桌面上从不出现凭据框；所有者是 Administrators 或 SYSTEM（是你本人的 SID 就报告，需要改注册方式） |

T8 里的 junction 测试需要提权的测试机，不在生产节点上做。

---

## 7. 重装上线需要的批准项

1. Decision：接受 §65.4.6“新增的秘密”（Windows 密码存进任务计划程序）。
2. Decision + Grant：M5 整套重装（R 类，冻结的升级通道 `upgrade-apply.ps1` 和 `upgrader/src/machine.mjs` 一起换）。
3. UAC：运行重装启动器一次；最后一步在安全桌面上输入一次 Windows 密码。
4. 你本人生成并存入 companion 专用的细粒度令牌（第 1.3–1.5 节）。必须在重装之前做完：companion 没有它就不启动。
5. 方便时重启一次做 T1。

## 8. 自动测试覆盖了什么

- `windows/test-companion-headless.ps1`：共用函数一字不差；升级通道从不注册 companion 任务；监督进程和注册小程序用安装的同一个编译配方编译并跑纯测试；PowerShell 写的 launch 文件被监督进程接受；锁定规则；待验收标记和退回顺序（T6）；PowerShell 里不出现密码（T8）；git 配置在 PowerShell 和 node 里是同一段文字；探针只读。
- `windows/SupervisorPureTests.cs`：退避、launch 文件校验、真实 junction 被拒、ACL、拒绝提权令牌、环境白名单。
- `windows/RegistrarPureTests.cs`：任务定义（密码登录、两个触发器、无登录触发器、无失败重启、SDDL）、只输出码、账户核对、vtable 槽位（只读自测）。
- `test/companion-headless.test.mjs`：通知队列上限与丢弃、伪造通知被拦（T8）、通知程序的登录失败码映射和心跳/重启判断、companion 拒绝提权令牌、专用 gh 登录失败关闭、status 字段与 companion-absent。
- `upgrader/test/machine.test.mjs`：升级和回滚只写 launch 文件、从不注册 companion 任务（T5）。
- `windows/test-upgrade-windows.ps1`、`windows/test-resident-windows.ps1`：新通道和安装、卸载的文本与回读。
