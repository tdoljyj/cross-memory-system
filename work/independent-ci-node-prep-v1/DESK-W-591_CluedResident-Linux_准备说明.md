# DESK-W-591：专用发行版 CluedResident-Linux 准备说明

适用：DESK-W-591 现场（Owner 本人 + 现场 Agent）。本说明接在《DESK-W-591_节点准备_前置操作说明.md》之后：它的 0.1–0.7（Windows 侧）已完成，回执 `NODE_PREPARED`。现场已定用专用发行版 `CluedResident-Linux`（不用 `CluedCI-Linux`），本说明不再讨论选型。

目标：从零建出 `CluedResident-Linux`，装好与 TURING 对齐、并与 Source v2 角色策略钉值一致的依赖，跑通前置说明的 0.8（`NODE_PREPARED_LINUX`），然后回到主备安装操作说明第 1 步。

来源：Task `25ac6c5f`（判据 5）、Task `b7d84de2`、Decision `76c5ac24`、`3efb35c7`。下文所有版本和哈希都是 2026-10-30 在 TURING 上只读查得，或从官方发布页核实的。

## 先读：红线与约定

- 需要 root 的地方一律用 `wsl -d CluedResident-Linux -u root -- <命令>`。不引入别的提权方式，不在这个发行版里开交互式 shell。镜像自带首次启动建用户的向导（OOBE），只有交互式打开时才会触发；带命令的 `wsl -d … -- <命令>` 不会触发它。
- **不碰** `CluedCI-Linux`、`docker-desktop`、`company-win-01`；不往任何别的发行版里执行命令。
- 不需要任何秘密：本说明不涉及令牌、私钥或密码。
- 命令都在 Owner 的**普通**（不提权）PowerShell 里执行。下载的文件放在 `C:\Users\Windows\Documents\nodeprep\`（以下简称 `nodeprep`），与前置说明相同。
- **停止的条件**：任何一步的结果与“预期”不符，就停下，把那一步的完整输出写入 KooYomi Task `b7d84de2`，等协调方回复。不要手工补救，不要换版本，不要跳步。
- 每一步做完，把输出（不含秘密，本说明也没有秘密）写入 KooYomi Task `b7d84de2`。

## 1. 发行版来源与校验

### 1.1 下载官方镜像

Canonical 官方的 Ubuntu 24.04.5 WSL 镜像，与 TURING 的 `Ubuntu-24.04` 同为 24.04.5。

```powershell
$ProgressPreference = 'SilentlyContinue'
Invoke-WebRequest -UseBasicParsing -Uri https://releases.ubuntu.com/noble/ubuntu-24.04.5-wsl-amd64.wsl -OutFile C:\Users\Windows\Documents\nodeprep\ubuntu-24.04.5-wsl-amd64.tar.gz
(Get-FileHash C:\Users\Windows\Documents\nodeprep\ubuntu-24.04.5-wsl-amd64.tar.gz -Algorithm SHA256).Hash
(Invoke-WebRequest -UseBasicParsing -Uri https://releases.ubuntu.com/noble/SHA256SUMS).Content -split "`n" | Select-String 'ubuntu-24.04.5-wsl-amd64.wsl'
```

- 预期：文件 388,975,696 字节。哈希是 `BB415D824822C4B878125729AF451A5D18FB13D1CF5CBED9A7393AD64AC6039E`，第二条命令打印的官方 SHA256SUMS 行也是同一个值（小写，`bb415d82…039e *ubuntu-24.04.5-wsl-amd64.wsl`）。
- 说明：`.wsl` 文件就是 gzip 压缩的 tar，这里直接以 `.tar.gz` 的名字保存，内容和哈希不变。
- 停止：两个哈希中任何一个不同。

### 1.2 导入

先确认名字和目录都还没被占用：

```powershell
wsl.exe --list --quiet
Test-Path C:\WSL\CluedResident-Linux
```

- 预期：列表里没有 `CluedResident-Linux`（输出可能夹杂 NUL 字符，只看名字）；`Test-Path` 返回 `False`。
- 停止：名字已存在，或目录已存在。不要删除，也不要覆盖。

导入：

```powershell
New-Item -ItemType Directory C:\WSL\CluedResident-Linux | Out-Null
wsl.exe --import CluedResident-Linux C:\WSL\CluedResident-Linux C:\Users\Windows\Documents\nodeprep\ubuntu-24.04.5-wsl-amd64.tar.gz --version 2
wsl.exe --list --verbose
```

- 预期：`--import` 退出码 0，并显示“操作成功完成”或类似提示；列表里出现 `CluedResident-Linux`，状态 `Stopped`，VERSION `2`。`C:\WSL\CluedResident-Linux\ext4.vhdx` 出现。
- 安装目录与权限：`C:\WSL\CluedResident-Linux` 由 Owner 普通权限新建，继承 `C:\` 的默认权限。Owner 是属主，SYSTEM 和 Administrators 完全控制。WSL 按 Owner 身份打开这个 VHDX，所以 Owner 必须能读写它，**不要**改成只有管理员能访问。已知风险见文末“残余”。
- 停止：导入报错，或列表里的版本不是 2。

### 1.3 第一次以 root 运行（不触发 OOBE）

```powershell
wsl.exe -d CluedResident-Linux -u root -- cat /etc/os-release
wsl.exe -d CluedResident-Linux -u root -- id -u
```

- 预期：`VERSION="24.04.5 LTS (Noble Numbat)"`；`id -u` 输出 `0`；没有出现“创建用户名”这类提示。
- 停止：出现交互提示。按 Ctrl+C 退出并回传；不要创建用户。

## 2. `/etc/wsl.conf`：开 systemd，关 interop

镜像自带的 `wsl.conf` 只有 `[boot] systemd=true`。用下面这份整体替换它（这是新发行版，替换的是镜像自带文件）：

```powershell
wsl.exe -d CluedResident-Linux -u root -- sh -c "printf '[boot]\nsystemd=true\n\n[interop]\nenabled=false\nappendWindowsPath=false\n' > /etc/wsl.conf"
wsl.exe -d CluedResident-Linux -u root -- cat -A /etc/wsl.conf
```

- 预期：`cat -A` 输出下面 6 行，每行以 `$` 结尾，没有 `^M`：

  ```
  [boot]$
  systemd=true$
  $
  [interop]$
  enabled=false$
  appendWindowsPath=false$
  ```

- 停止：内容不同，或出现 `^M`。

让配置生效：

```powershell
wsl.exe --terminate CluedResident-Linux
```

只停这一个发行版；**不要** `wsl --shutdown`，那会把跑 PR runner 的 `CluedCI-Linux` 一起停掉。WSL 在下一次启动这个发行版时读取 `wsl.conf`。

验证（第一条命令会重新启动这个发行版）：

```powershell
wsl.exe -d CluedResident-Linux -u root -- cat /proc/1/comm
wsl.exe -d CluedResident-Linux -u root -- systemctl is-system-running
wsl.exe -d CluedResident-Linux -u root -- sh -c 'test -e /sys/fs/cgroup/cgroup.controllers && echo cgroup2=yes'
wsl.exe -d CluedResident-Linux -u root -- sh -c 'ls /proc/sys/fs/binfmt_misc/ | grep -i -e wslinterop || echo no-wslinterop-binfmt'
wsl.exe -d CluedResident-Linux -u root -- sh -c '/mnt/c/Windows/System32/cmd.exe /c ver; echo rc=$?'
wsl.exe -d CluedResident-Linux -u root -- sh -c 'echo $PATH'
wsl.exe -d CluedResident-Linux -u root -- sh -c 'ls -la /run/WSL 2>&1 | head -5'
```

- 预期：
  - `systemd`；
  - `running`，或刚启动时的 `starting`；`degraded` 时先跑 `systemctl --failed` 看是哪个单元，与 WSL 无关的单元（比如 `systemd-remount-fs`）可以记录后继续；
  - `cgroup2=yes`；
  - `no-wslinterop-binfmt`；
  - 启动 Windows 程序失败：报 `cannot execute binary file`、`Exec format error` 或 `Permission denied` 之类，最后一行 `rc=` 不是 0，**不能**出现 Windows 的版本号；
  - `PATH` 里没有任何 `/mnt/c/...`；
  - `/run/WSL`：如实记录。P0 的判定（Task `b7d84de2` 第 2 步）以“无法经 interop 启动 Windows 进程”为准，这里只是先留证据。
- 停止：`/proc/1/comm` 不是 `systemd`；能启动 `cmd.exe`（出现 Windows 版本号或 `rc=0`）；`PATH` 含 `/mnt/c`。

## 3. 依赖：与 TURING 对齐，并满足 Source v2 角色策略的钉值

TURING 的 `Ubuntu-24.04`（2026-10-30 只读查得）：

| 组件 | TURING 版本 | 来源 |
|---|---|---|
| Docker 引擎 `docker.io` | `29.1.3-0ubuntu3~24.04.2`（apt hold） | Ubuntu 官方源 universe（源码包 `docker.io-app`） |
| `containerd` | `2.2.1-0ubuntu1~24.04.3` | Ubuntu 官方源（`containerd-app`，noble-security） |
| `runc` | `1.3.4-0ubuntu1~24.04.1` | Ubuntu 官方源（`runc-app`） |
| `git` | `1:2.43.0-1ubuntu7.4`（apt hold） | Ubuntu 官方源 |
| `python3.12` / `python3.12-minimal` | `3.12.3-1ubuntu0.17`（minimal 为 apt hold） | Ubuntu 官方源 |
| `systemd` | `255.4-1ubuntu8.18`（apt hold） | Ubuntu 官方源 |
| `bridge-utils`、`pigz`、`iptables` | `1.7.1-1ubuntu2`、`2.8-1`、`1.8.10-3ubuntu2` | docker 依赖 |

**为什么是 Ubuntu 的 `docker.io`，不是 Docker 官方源的 `docker-ce`**：

- TURING 用的是 Ubuntu 官方源的 `docker.io`，没有配 Docker 官方 apt 源。
- 更关键的是，Source v2 的三个角色策略（`/etc/clued-independent-ci/roles-v3/{gitleaks,trivy,contract-placement}.json`）钉住了 `/usr/bin/docker` 的 sha256 `7ed12b00293d64742419a6601ae97960a367a0ce97c88b06e3278cc0a409557b`，这正是 `docker.io 29.1.3-0ubuntu3~24.04.2` 的客户端二进制。换成 `docker-ce`，二进制不同，角色会拒绝运行。
- 同理，`/usr/bin/git` 也被钉住：`eb54b535467e0975c1284d4c4d08eea779aeb248a5d34b02e2ee171382e22201`（`git 1:2.43.0-1ubuntu7.4`）。

### 3.1 安装钉版本的包

```powershell
wsl.exe -d CluedResident-Linux -u root -- apt-get update
wsl.exe -d CluedResident-Linux -u root -- env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends docker.io=29.1.3-0ubuntu3~24.04.2 containerd=2.2.1-0ubuntu1~24.04.3 runc=1.3.4-0ubuntu1~24.04.1 git=1:2.43.0-1ubuntu7.4 git-man=1:2.43.0-1ubuntu7.4 python3.12=3.12.3-1ubuntu0.17 python3.12-minimal=3.12.3-1ubuntu0.17 libpython3.12-stdlib=3.12.3-1ubuntu0.17 libpython3.12-minimal=3.12.3-1ubuntu0.17 bridge-utils pigz iptables ca-certificates xz-utils
wsl.exe -d CluedResident-Linux -u root -- apt-mark hold docker.io containerd runc git python3.12-minimal systemd
```

- 预期：`apt-get install` 退出码 0，没有 `E:` 开头的行；`apt-mark hold` 列出 6 个包。系统里已有更高版本的包时，apt 会提示降级并照样执行（因为指定了确切版本）。
- 停止：
  - 出现 `E: Version '…' for '…' was not found`（这个版本已从官方源撤下）：不要改用其他版本，回传，由协调方决定。docker 和 git 的二进制被角色策略钉住，换版本会让角色拒绝运行。
  - 出现任何其他 `E:` 行。

说明：

- 对比 TURING 的差异：多 hold 了 `containerd` 和 `runc`，防止日后自动升级产生漂移。
- `systemd` 不装新版本，只 hold。镜像自带的版本可能低于 TURING 的 `255.4-1ubuntu8.18`，下一步只做记录，不作为停止条件：没有任何策略钉住 systemd。

### 3.2 核对版本与钉值

```powershell
wsl.exe -d CluedResident-Linux -u root -- dpkg-query -W docker.io containerd runc git python3.12 python3.12-minimal systemd
wsl.exe -d CluedResident-Linux -u root -- sha256sum /usr/bin/docker /usr/bin/git /usr/bin/python3.12
wsl.exe -d CluedResident-Linux -u root -- systemctl is-active docker.service containerd.service
wsl.exe -d CluedResident-Linux -u root -- docker version --format '{{.Server.Version}} {{.Client.Version}}'
wsl.exe -d CluedResident-Linux -u root -- docker info --format '{{.CgroupDriver}}/{{.CgroupVersion}} {{.Driver}} {{.DockerRootDir}}'
wsl.exe -d CluedResident-Linux -u root -- apt-mark showhold
```

- 预期：
  - 版本与上表逐项相同；`systemd` 如实记录。
  - `/usr/bin/docker` = `7ed12b00293d64742419a6601ae97960a367a0ce97c88b06e3278cc0a409557b`；`/usr/bin/git` = `eb54b535467e0975c1284d4c4d08eea779aeb248a5d34b02e2ee171382e22201`。python 未被钉，TURING 上是 `e50d468e8b0adfb05733f5b87b3cff34829c4a8c1aea50c865aa8bdfe4bb150f`，相同最好，不同就如实记录。
  - `active` 两行。
  - `29.1.3 29.1.3`。
  - `systemd/2 overlayfs /var/lib/docker`；三个角色策略的 `dockerRootDirectory` 都是 `/var/lib/docker`，`dockerEndpoint` 是 `unix:///run/docker.sock`。
  - hold 列表含 `containerd docker.io git python3.12-minimal runc systemd`。
- 停止：docker 或 git 的哈希不符；版本不符；docker 不是 active；`docker info` 不是 `systemd/2`。

不建用户，不把任何人加进 `docker` 组：常驻的 Linux 侧全部以 root 运行（systemd 单元 `User=root`）。

## 4. 钉了哈希的 node 工具链

**需要的只有一个**：`/var/lib/clued-independent-ci/toolchain-build-legacy-v1/node`，Node.js **v24.19.0**，sha256 `bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12`。worker 单元、relay、Source v2 安装器和三个角色策略（`nodeExecutable` / `nodeExecutableSha256`）用的都是这一个路径和这个哈希（常驻 DESIGN.md S10“一个 Node”）。TURING 上的 `toolchain-build-v1/node` 是更早的同一字节副本，常驻 v2 不引用，新节点不需要。

**来源：官方 tarball，不从 TURING 复制。** 2026-10-30 已核实：nodejs.org 官方 `node-v24.19.0-linux-x64.tar.xz` 里的 `bin/node`，与 TURING 的钉值**逐字节相同**（sha256 都是 `bc17c508…`，125,989,464 字节）。

### 4.1 下载与校验（Windows 侧）

```powershell
$ProgressPreference = 'SilentlyContinue'
Invoke-WebRequest -UseBasicParsing -Uri https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-x64.tar.xz -OutFile C:\Users\Windows\Documents\nodeprep\node-v24.19.0-linux-x64.tar.xz
(Get-FileHash C:\Users\Windows\Documents\nodeprep\node-v24.19.0-linux-x64.tar.xz -Algorithm SHA256).Hash
(Invoke-WebRequest -UseBasicParsing -Uri https://nodejs.org/dist/v24.19.0/SHASUMS256.txt).Content -split "`n" | Select-String 'linux-x64.tar.xz'
```

- 预期：哈希 `14B342E71204F811BDE6153BE8E04B62AEF63C236FEF92B55F9C83154B409647`；官方 SHASUMS256 那一行也是 `14b342e7…9647  node-v24.19.0-linux-x64.tar.xz`。
- 停止：不符。

### 4.2 解出并核对 `bin/node`（发行版内，root 独占目录）

这一步要在第 5 节 0.8 的 `--apply` **之后**做：`/var/lib/clued-independent-ci` 由 0.8 创建（root 0700），本节只在它下面新建一个子目录。`/root/clued-nodeprep` 在 0.8 复制脚本时已建好。

```powershell
wsl.exe -d CluedResident-Linux -u root -- sha256sum /mnt/c/Users/Windows/Documents/nodeprep/node-v24.19.0-linux-x64.tar.xz
wsl.exe -d CluedResident-Linux -u root -- install -d -o root -g root -m 0700 /root/clued-nodeprep/node
wsl.exe -d CluedResident-Linux -u root -- tar -xJf /mnt/c/Users/Windows/Documents/nodeprep/node-v24.19.0-linux-x64.tar.xz -C /root/clued-nodeprep/node --no-same-owner node-v24.19.0-linux-x64/bin/node
wsl.exe -d CluedResident-Linux -u root -- sha256sum /root/clued-nodeprep/node/node-v24.19.0-linux-x64/bin/node
```

- 预期：tarball 哈希 `14b342e7…9647`（在发行版内再核一次，防止 Windows 侧核过之后文件被换）；`bin/node` 的哈希 `bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12`。
- 停止：任何一个不符。

### 4.3 放到钉住的位置

```powershell
wsl.exe -d CluedResident-Linux -u root -- test ! -e /var/lib/clued-independent-ci/toolchain-build-legacy-v1
wsl.exe -d CluedResident-Linux -u root -- install -d -o root -g root -m 0700 /var/lib/clued-independent-ci/toolchain-build-legacy-v1
wsl.exe -d CluedResident-Linux -u root -- install -o root -g root -m 0555 /root/clued-nodeprep/node/node-v24.19.0-linux-x64/bin/node /var/lib/clued-independent-ci/toolchain-build-legacy-v1/node
wsl.exe -d CluedResident-Linux -u root -- stat -c '%a %U:%G %s %n' /var/lib/clued-independent-ci/toolchain-build-legacy-v1 /var/lib/clued-independent-ci/toolchain-build-legacy-v1/node
wsl.exe -d CluedResident-Linux -u root -- sha256sum /var/lib/clued-independent-ci/toolchain-build-legacy-v1/node
wsl.exe -d CluedResident-Linux -u root -- /var/lib/clued-independent-ci/toolchain-build-legacy-v1/node --version
```

- 预期：
  - 第一条退出码 0（目标还不存在）；
  - `stat` 两行：`700 root:root … toolchain-build-legacy-v1` 和 `555 root:root 125989464 …/node`，与 TURING 相同（目录 `drwx------`，文件 `-r-xr-xr-x`）；
  - 哈希 `bc17c508…5e12`；
  - 版本 `v24.19.0`。
- 停止：第一条非 0（目标已存在，不覆盖）；属主、权限或哈希不符。

## 5. 跑前置说明的 0.8（`prepare-node-linux.sh`）

照《DESK-W-591_节点准备_前置操作说明.md》0.8 执行，发行版名固定为 `CluedResident-Linux`。顺序：先 5.1、5.2，再做第 4 节，最后 5.3 复核。

### 5.1 复制脚本到 root 独占位置并核对

```powershell
wsl.exe -d CluedResident-Linux -u root -- install -D -o root -g root -m 0700 /mnt/c/Users/Windows/Documents/nodeprep/prepare-node-linux.sh /root/clued-nodeprep/prepare-node-linux.sh
wsl.exe -d CluedResident-Linux -u root -- sha256sum /root/clued-nodeprep/prepare-node-linux.sh
```

- 预期：sha256 `d0ce9b97a8b717fa23ade224bf9aaa1632809608c7a07d5468043fd72cd2a050`，即 main `e15210d5` 上的 `work/independent-ci-node-prep-v1/linux/prepare-node-linux.sh`，KooYomi Task `25ac6c5f` 也记录了这个值。
- 停止：不符。

### 5.2 只读计划，再执行

```powershell
wsl.exe -d CluedResident-Linux -u root -- bash /root/clued-nodeprep/prepare-node-linux.sh --plan --distribution CluedResident-Linux
```

- 预期：
  - `dir` 行 7 条，全部 `absent`；
  - `fact pid1=systemd`，`fact cgroup2=yes`，`fact wsl.conf.systemd=yes`，`fact wsl.conf.interop=enabled=false`（或包含 `enabled=false`）；
  - `fact docker.service=active`，`fact python3.12=/usr/bin/python3.12`，`fact git=/usr/bin/git`，`fact docker=/usr/bin/docker`；
  - `fact toolchain.node=missing`（第 4 节在 0.8 之后做，这时还没有）；
  - 最后一行 `{"status":"DRY_RUN_PLAN_ONLY_NOTHING_WRITTEN","planSha256":"<64 位十六进制>"}`。
- 停止：
  - `SCRIPT_LOCATION_REFUSED`：没有从 `/root/clued-nodeprep` 运行，回到 5.1；
  - `DISTRIBUTION_HOSTS_GITHUB_RUNNERS`：新发行版里不应有 runner，回传；
  - `WRONG_DISTRIBUTION`、`PARENT_DIRECTORY_REFUSED`、`DIRECTORY_EXISTS_DIFFERENT:*`：回传。

Owner 弹窗确认后执行（把 `<planSha256>` 换成上一步的值）：

```powershell
wsl.exe -d CluedResident-Linux -u root -- bash /root/clued-nodeprep/prepare-node-linux.sh --apply --distribution CluedResident-Linux <planSha256>
```

- 预期：7 行 `created …`，最后一行 `{"status":"NODE_PREPARED_LINUX","planSha256":"<同一个值>"}`。
- 停止：`PLAN_CHANGED_SINCE_REVIEW`（回到 `--plan`），或任何其他拒绝码。

然后做第 4 节（node 工具链）。

### 5.3 复核

```powershell
wsl.exe -d CluedResident-Linux -u root -- bash /root/clued-nodeprep/prepare-node-linux.sh --plan --distribution CluedResident-Linux
```

- 预期：`dir` 行 7 条全部 `present`；`fact toolchain.node=present`；状态 `DRY_RUN_PLAN_ONLY_NOTHING_WRITTEN`。这里的 `planSha256` 会与 5.2 的不同，属正常：目录状态变了。

## 6. 回到主备安装操作说明第 1 步（前置说明 0.9）

重跑《DESK-W-591_主备安装操作说明.md》第 1 步的全部只读检查。另把 `wsl.exe -l -v` 的结果对照下表：

| 项 | 预期 |
|---|---|
| `Get-LocalUser -Name clued-control` | 有返回，SID 以 `-1007` 结尾（Windows 侧回执的 controllerSid） |
| 六个 `Test-Path` | 全为 True（见下面的说明） |
| `company-win-01` | 仍为 Running、Auto、`.\clued-runner`，原路径不变 |
| `company-win-02` | Stopped、Manual、`.\clued-control`、`"C:\ProgramData\CluedControl\runner\bin\RunnerService.exe"` |
| `wsl.exe -l -v` | 多一个 `CluedResident-Linux`，VERSION 2；`CluedCI-Linux`、`docker-desktop` 不变 |

**普通权限下核验显示 `UNKNOWN_ACCESS_DENIED` 怎么算**：在普通（不提权）PowerShell 里核验 `C:\ProgramData\CluedControl\trusted`、`C:\ProgramData\CluedControl\runner\bin`、`C:\ProgramData\CluedIndependentCI\state`，得到 `UNKNOWN_ACCESS_DENIED` 或“拒绝访问”，**这是正确结果**：

- 这三个目录按设计只有 SYSTEM、Administrators 和 `clued-control` 能访问，Owner 的普通令牌本就读不了，TURING 上也是一样。
- 存在与否、属主和 ACL 是否正确，以 Windows 侧节点准备的**提权回执**为准：`NODE_PREPARED`，其中 `postconditions` 的 `trusted`、`runnerServiceExe`、`state` 和 `replanNothingToDo` 均为 true。
- **不要为了让普通权限能读而放宽 ACL**。如需再次确认，只用前置说明 0.7 的提权干跑（`<MODE>` 留空）。它应得到 `NOTHING_TO_DO`，表示所有目录都已存在且与计划一致。

Linux 侧的核验以 5.3 的复核为准。全部满足后，进入主备安装操作说明第 2 步（P0）。P0 仍单独过关；第 2 节留下的 interop 证据供 P0 使用。

## 后续（不在本说明，另有步骤）

这些是常驻安装（`install-resident-linux.sh` 与 Source v2 安装）的其余前提，本说明只把发行版准备到它们之前：

- **Source v2 安装**（`clued-ci-install-source-v2`）：由它建 `/opt/clued-independent-ci/source-v2`、`/etc/clued-independent-ci/formal-source-manifest-v2.json`、`/etc/clued-independent-ci/roles-v3/`。这几个目标必须还不存在；本说明和 0.8 都不建它们。它的主机前提（钉住的 node、`/usr/bin/git`、没有 `formal-role.lock`）本说明已满足。
- **角色镜像**，三个角色策略按摘要钉住：
  - gitleaks：`ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f`
  - trivy：`ghcr.io/aquasecurity/trivy:0.74.0@sha256:ee940acbf1f58ebadb42d01434ce4609530bf1b52536afbd1eee66cd7123c5c9`
  - contract-placement：本地构建的镜像 `sha256:01cc626818fddd860988da5d5b8cc1a7ba9150c0994a24fc371c5aeb47834540`（基于 `python:3.12.14-bookworm@sha256:dbbe4ceb…` 加上同一个 node 与 esbuild 0.28.1）
  - trivy 漏洞库缓存。

  怎么取得或构建、怎么核对，由协调方另出步骤。
- **WSL 主机调优**（Task `f995d832`：P1 sysctl、P1b 内存保护），见 `work/independent-ci-resident-v1/linux/host-tuning/README.md`。
- **节点档案**：Windows 回执的 controllerSid（`…-1007`）加上 `wslDistribution = CluedResident-Linux`，构成常驻打包用的 `node-profile/1`，由协调方在打包时填入。

## 残余与已知限制

- **VHDX 在 Owner 可写的位置**：WSL 按 Owner 身份打开 `C:\WSL\CluedResident-Linux\ext4.vhdx`，所以 Owner 的普通令牌能写它。`CluedCI-Linux` 里的 PR 代码运行时带 Owner 的 Windows 令牌，并能经 `/mnt/c` 写 Windows 文件，理论上可以在本发行版**停止时**改动它的 VHDX。这与 TURING 的 `Ubuntu-24.04` 现状相同（VHDX 也在 Owner 可写的位置），属于“PR 代码与 Owner 令牌隔离”问题，由 P0 统一判定（Task `b7d84de2`，Decision `63696438`）；本说明不扩大、也不消除这一风险。
- **`/run/WSL`**：关掉 interop 后 `/run/WSL` 是否仍存在，未在真机上验证（TURING 不允许改动，本说明作者没有新建测试发行版）。第 2 节只要求“不能启动 Windows 程序”，并如实记录 `/run/WSL`。
- **interop 与 TURING 不同**：TURING 的 `Ubuntu-24.04` 没有关 interop；DESK-W-591 按 P0 要求关掉。常驻的 Windows 侧只从 Windows 调用 `wsl.exe` 进入发行版，不需要 Linux 侧启动 Windows 程序。
- **版本撤下**：所列 apt 版本 2026-10-30 仍在 Ubuntu 官方源（已核 Launchpad）。将来被撤下时，第 3.1 节会停在 `Version … not found`，由协调方决定，不要自行换版本。
