# 整套重装工具链（reinstall/）

把常驻执行器整套重装到一个节点：打包、生成提权启动器、生成 Linux 第 A/B 步 root 脚本，以及安装前对已装现场做全量只读预演。

这套工具来自 TURING 上 r4–r7 几次重装时用过、也审过的脚本（原先放在 `s34-reinstall\r4-work`，每一版都是从上一版打补丁派生出来的）。现在改为按参数生成：节点、提交、Owner 的 Decision 和回执、已装状态，都从文件读，不再写在代码里。

决定：KooYomi Decision `19baf5ec`。设计说明见 DESIGN §40。

## 1. 边界

- 所有工具都**不提权、不进 WSL root、不写主机**，只在配置的 `workDir` 下新建文件，绝不覆盖已有文件。真正改动主机的只有两样：Owner 点 UAC 运行的启动器，和 Owner 以 root 运行的 Linux 脚本。
- **秘密不进仓库，也不进任何生成物。**
  - 配置文件里只能写路径和公开值。`tools/rconfig.py` 会拒绝像秘密的键名和值，例如私钥头、`ghp_`、`github_pat_`、`sb_secret_`、JWT。
  - resident-upgrade token 只给出路径，工具只查它存不存在，从不打开内容。
  - 签名私钥只在 Linux 第 B 步由已审核的签名工具在 root 下读取。
- Linux 第 A/B/resume 三个脚本都是 root 脚本。改动生成器或 `linux/tools/` 之后，必须重新做一次完整的独立审核。

## 2. 构建配置（`config/*.json`，合同 `clued.independent-ci.reinstall-config/1`）

| 键 | 含义 |
|---|---|
| `node` / `nodeProfile` | 节点名；节点档案在提交树中的路径（`config/node-profile.<node>.json`），两者必须对应 |
| `workDir` | 输出目录（仓库外） |
| `repo` | 用来 `git archive` 提交的本地仓库 |
| `basePackage` | 一个审过的包，从它的 record 读取共用的公开值：仓库、App/installation id、KooYomi 公开地址和 publishable key、角色描述、公开签名者表 |
| `nodeRecord` | 节点自己的公开指纹，会覆盖 base 的值：`appKeyId`（数字）、`appPublicKeySha256Base64`、`ciPrincipalBindingId`、`ciTokenPinSha256`、`ciPrincipalRoleRef`、`controllerNodeSha256`。与 base 包不同的节点必须六项都给，不继承 base 的值。示例里的 `REPLACE_` 占位值无法通过加载 |
| `nodeExe`、`policyInput`、`companionInput` | 打包输入 |
| `upgradeTokenFile` | resident-upgrade token 的路径（只用路径） |
| `runner` | controller runner 服务的原始 binPath 和 DACL（服务名取自节点档案） |
| `launcher` | 安装后暂停、rearm、W1 暂停各自使用的 reason |
| `linux` | WSL 发行版（必须等于节点档案的 `wslDistribution`）；已装 Linux 常驻 manifest 的副本；已装 `roles-v3` 的副本（含 `formal-source-manifest-v2.json`），这两份副本由 root 复制出来；`host`：root 脚本钉住的节点自身事实，即 toolchain node 的 sha256、verify-result 公钥的 sha256、已装 Source v1 的 HEAD |
| `secretTargetsExist` | App 私钥和 ci-admission token 的目标位置是否已存在（启动器在提权后会核对） |

路径只许 ASCII 字母、数字、空格和 `._-\`，runner 的 binPath 和 SDDL 各有严格形状：这些值会进 root shell 和提权 PowerShell。

已有配置：
- `turing.json`
- `desk-w-591.example.json`：六项指纹和 `linux.host` 三项由现场回传后填入。

## 3. 打包：`build.ps1`

```
powershell -NoProfile -File build.ps1 -Config config\turing.json -Commit <40hex>                       # DRAFT（占位 ref）
powershell -NoProfile -File build.ps1 -Config ... -Commit ... -Final -DecisionRef <uuid> -ReceiptRef <uuid> -AcceptedAt <ISO Z> -Tag t
          [-Rehearsal <预演报告> -LinuxEvidence <file> -LinuxVersionFacts <file>]
powershell -NoProfile -File build.ps1 -Config config\desk-w-591.json -Commit ... -PackageOnly           # 只出包（新节点）
```

依次执行：
1. `tools/record-inputs.py`
2. 提交自己的 `prepare-record.mjs`
3. `tools/check-record.mjs`（`validateRecordV2`）
4. `tools/upgrader-config.py`（用树里的 `validateUpgraderConfig` 校验）
5. `tools/linux-pins.py pins`：外部钉值的路径和顺序沿用已装 manifest，`source-v2` 下的钉值取**新提交**的文件
6. `build-package.mjs --fresh-install`
7. `linux-pins.py check`
8. `launcher/generate.py`：在新目录里重建一次，要求包 sha 相同

`workDir\tree-<c8>` 每次使用前都由 `tools/tree.py` 核对：必须与提交逐个 blob 相同，且没有多余文件（`build.ps1`、`generate.py`、`prep.py`）。

带 `-PackageOnly` 时不生成启动器：启动器要读的是本机的已装常驻，给别的节点打包时没有意义。

## 4. 启动器：`launcher/generate.py` + `launcher/template.ps1`

- **模板**：`template.ps1` 就是 r7 f4 在 TURING 上实际跑过的文本（6d32f2ba），把补丁历史合了进来，只多了一处：主机名改为参数 `$NodeHostname`。生成器钉住模板的 sha，不再打补丁；模板要改，就作为文本改动走审核。
- **数据来源**：启动器钉住的每一个值都来自文件，包括包、配置、包里 record 的节点档案（必须等于配置所指的档案），以及本机已装状态（只读）。
- **final 的前提**：Linux 第 B 步产出的 evidence 和 version facts，加上一份对**同一个包、同一提交、同一配置**的 `REHEARSAL_PASS` 预演报告，缺一不可（`FINAL_NEEDS_A_PASSING_REHEARSAL_OF_THIS_PACKAGE`）。24 小时时限由 `prep.py` 在节点变动之前检查；这里不再查，因为 W1 和 Linux B 之后节点处于半重装状态，无法重新预演。
- **步骤**：Q1–Q5、r4.1 C1–C3、r5 S1–S3、r5c 的升级通道、r7 的卸载计划 /3 和"经 SCM 停升级代理"。每一步都在模板注释里写了用途。

## 5. 对已装现场的全量只读预演：`rehearse.py`（预演不过不出 final）

```
python -I rehearse.py config\turing.json --commit <40hex> --package <包目录>
```

非提权、只读。每一项都直接运行节点上的真实工具或读取真实文件，不一致的地方就记为 finding（差异清单）。唯一以 root 身份运行的是 linuxHost 探查：只读，不写任何文件，git 不取可选锁。

| 检查 | 内容 |
|---|---|
| uninstall | 运行**已装的** `uninstall-resident.ps1` 做真实 dry-run：plan 合同必须是模板 `Test-UninstallPlan` 接受的那一版，模板读到的字段都要在；不能有记录中的升级 op；`upgraderService` 必须与服务实际是否存在一致，且为 true（模板要求） |
| upgrader | 装着 CluedCIUpgrader 时，模板的停服步骤必须经 SCM 停它 |
| verify | 新包的 `verify-resident.ps1` 输出形状（`status` 和 `checks.*.ok`）必须是启动器读的那样。已装的 verify 也真跑一次：不提权时它会被管理员专属文件挡住，此时只记为"未提权不可运行"，不算 finding；能跑出结果时，必须是 VERIFIED 或 PARTIALLY |
| status | `state/status.json` 的 `writtenAt`、`executor`、`current`、`halt`；`upgrade/status.json` 里没有 op；`upgrade/current.json` 的合同 |
| linux | Windows 侧的 Linux version facts（`upgrade/mailbox/responses/version-facts.json`）与第 1 代记录一致；配置里 root 复制的 Linux manifest 和 roles-v3 就是现装的（与 facts 里各项 sha 比对） |
| pins | 包里 Linux 常驻 manifest 的外部钉值：形状与已装一致，`source-v2` 钉值等于新提交里的文件 |
| linuxHost | 以 root 只读：对已装角色策略运行第 A、B0、B4 步会用的 `linux/tools/check-host.py`，钉值取配置的 `linux.host`；Source v1 的 HEAD 等于配置值；签名工具要读的 v1 qualification 都在（只查是否存在；签名和事实由第 B1 步签名工具核对，B1 在切换 Source 之前） |
| roles | 以普通用户在节点的 WSL 发行版里，对副本运行第 A 步会用的 `linux/tools/derive-roles.py`。必须成功，被重钉的 Source 文件逐个列出。发行版默认用户是 root 时拒绝运行 |
| node | 包里的节点档案就是配置所指的那份 |

报告（`clued.independent-ci.reinstall-rehearsal/1`）只新建、不覆盖，写在 `workDir\rehearsal\`。

r7 那次三回被拒，都能被预演提前抓到，`test/test_rehearse.py` 里有对应的回归测试：

| r7 被拒 | 预演的 finding |
|---|---|
| Linux 常驻 manifest 沿用了已装的外部钉值，而新提交改了这些文件 | `LINUX_EXTERNAL_PINS_NOT_THE_NEW_SOURCE` |
| 角色派生拒绝新提交改动过的 Source 文件（`PINNED_FILE_CHANGED_IN_NEW_COMMIT_REPIN_NEEDED`） | `ROLE_DERIVATION_REFUSED`，并带出被拒的 key |
| 启动器只认卸载计划 /2，而已装工具输出 /3 | `UNINSTALL_PLAN_CONTRACT_NOT_ACCEPTED_BY_LAUNCHER` |

## 6. Linux 套件：`linux/assemble.py`、`linux/prep.py`、`linux/tools/`

- `assemble.py`：组装 `workDir\linux\<in>`。内容包括：
  - 包里的 record 和 Source v2 安装器；
  - `linux-pkg/upgrade-v1/**`、`linux-res-pkg/**`；
  - 树里的 install、verify、uninstall-resident-linux.sh；
  - `linux/tools/` 下审过的辅助工具；
  - 一个裸仓库，HEAD 和唯一的 ref 都是 `refs/heads/accepted`。
- `prep.py`：生成三个脚本 `reinstall-linux-{A-stage,B-switch,B-resume}.<suffix>.sh`，$BASE 是 `/root/clued-ci-reinstall-<c8>`。
  - "已装状态"不再写死，取自节点自己的 version facts 和第 1 代记录（两份文件的副本）。
  - 非 `draft*` 后缀（即 final）必须附上 24 小时内的 PASS 预演报告。`draft*` 脚本只供审阅，脚本自己一开头就拒绝运行（`DRAFT_SCRIPTS_ARE_FOR_REVIEW_ONLY`）。
  - `<in>` 里的 `check-host`、`verify-signed`、`derive-roles` 副本必须与 `linux/tools/` 中提交的版本相同。
  - toolchain node、结果公钥、v1 HEAD 取自配置的 `linux.host`，不再是 TURING 的常量。
- `tools/derive-roles.py`：与冻结工具 `clued-ci-upgrade-linux` 的 `derive_role` 一样，把 5 个 Source 钉值（entry、qualification、worker、proof、job）重钉为新提交的值，其余一律不许变。
- 其余工具与 r7 审过的相同：`sign-qualification-v2.mjs`（9ee06a93）、`verify-source-v2.template.sh`（r7 的 60c078e0 加一处：v1 HEAD 改为变量 `V1_HEAD`，现 05314df4）、`check-host.py`（两项钉值改为参数）、`verify-signed.mjs`。

## 7. 一次整套重装的顺序

1. `build.ps1 -Final`：得到 final 包 W0（final 启动器此时还出不来）。
2. `rehearse.py`：结果必须是 REHEARSAL_PASS。
3. `linux/assemble.py`，再用 `linux/prep.py` 加预演报告，生成 final 版 Linux 脚本。
4. **W1**：`tools/pause-old-resident.py <config>`，非提权，必须返回 `OLD_RESIDENT_PAUSED_NO_OPEN_BATCH`。
5. **Linux A、B**：由 Owner 以 root 运行（`wsl -d <发行版> -u root`，`env -i`）。B 切换 Source 之后若失败，用 resume 续跑。
6. `build.ps1 -Final`：用同样的 ref，加上 `-Rehearsal`、`-LinuxEvidence`、`-LinuxVersionFacts`，得到 final 启动器。包 sha 必须不变。
7. UAC 一次。
8. rearm 恢复。

## 8. 新节点（例如 DESK-W-591 第 5 步）

- 节点档案 `config/node-profile.desk-w-591.json`：取自 Note `85717e8f`，已通过 `validateNodeProfile`。
- 配置：把 `config/desk-w-591.example.json` 复制为 `desk-w-591.json`，填入现场回传的六项指纹和 `linux.host` 三项，再运行 `build.ps1 -PackageOnly`。
- 首装不走这里的启动器和 Linux 脚本。它们只用于"已装节点上的整套重装"；首装按《DESK-W-591 主备安装操作说明》进行。
- `linux.installedManifest` 在新节点上只用作外部钉值的路径模板：node 钉值要等于节点上钉住的 toolchain node，`source-v2` 钉值总是取新提交的文件。

## 9. 历史

- **r4–r5c2**：TURING 的 Source34 重装，以及 018da927 升级通道的首次安装。
- **r7**（第 3 批）：
  - 包层的外部钉值（审核 BLOCKER-1）；
  - src.git 的 HEAD（BLOCKER-2）；
  - 切换 Source 后可续跑（MAJOR-1）；
  - 角色重钉（Linux A 在 23:47Z 被拒）；
  - 卸载计划 /3 与"经 SCM 停升级代理"（f3 启动器在 00:01Z 被拒）。
- KooYomi Note：`922efc6b`、`fb736ae8`、`598dca23`。

## 10. 测试

```
python -I -m unittest discover -s test -p "test_*.py"      # 在 reinstall/ 下运行
```

假 Host 回答节点的状态。测试覆盖：
- 上面三次被拒的回归；
- 卸载计划字段与升级代理；
- verify 的两种情况；
- 已装副本过期；
- facts 与第 1 代记录不一致；
- 包属于别的节点；
- 配置的秘密拒绝、占位值、节点档案与配置对应。
