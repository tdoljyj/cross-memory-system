# TM-19 本机可信启动器交接

**状态：模板与隔离定向测试已完成；未安装真实信任配置，未调用真实 GitHub API，未发布、激活或签发 Step15/18。**

- launcher：`scripts/naming-governance/trusted_launcher.py`，SHA256 `32d0d3e2fda441e589d33a0b63042482cf4c33630bb0eb63e69d2d7bd0e6d35a`。
- tests：`tests/test_naming_governance_trusted_launcher.py`，SHA256 `5b802a59e08e0bb4a70b47528860404de6f15c29d92291cd95bd09e7c47c0d3f`。
- 使用的真实 post_migration.py：SHA256 `bbe3dfe6d6949357ae32643e8cad7493b27d487638e7750c6b5b279c181d882e`。
- 22 项定向测试 PASS。完整输出、实际 payload/锁摘要及 fixture 边界见 `tests/FixtureTestReport.json`。

## 根任务负责的实际安装

在本仓库正常 clone 的 `.git/clued-phase2/` 独立安装这些固定名称：

```text
trusted_launcher.py
publication.py
post_migration.py
policy.json
trust-config.json
Bootstrap.json
```

publication.py 必须使用 architecture_review 完成父目录保护修复之后的最终字节；这里没有冻结旧版摘要。Policy 必须匹配那份实际核心、真实 accepted subject、Freeze、CI 与制品。启动器没有 bootstrap/install 命令，也没有候选提供 pin、源码或 repo-root 的参数。仓库内模板直接运行会拒绝；不能把可替换的 repo wrapper 当正式入口。

受信配置 contract 为 `clued.phase2.local-trust-config/v1`，字段只有本机安装需要的选择：

| 字段 | 实际内容 |
|---|---|
| pins.repository_root | 本机被授权 clone 的绝对路径，必须与启动器所在 `.git/clued-phase2` 对应。 |
| pins.launcher_sha256 | 实际安装 launcher 全字节摘要，包括头部。 |
| pins.publication_sha256 | 最终受信 publication.py 全字节摘要。 |
| pins.post_migration_sha256 | 受信本地安装检查器摘要。 |
| pins.policy_sha256 | 独立确认的实际 policy.json 原始字节摘要。 |
| pins.python | `{path, sha256}`；本机固定 Python 的绝对路径及可执行文件摘要。 |
| pins.gh | `{path, sha256}`；本机固定 gh/gh.exe 的绝对路径及摘要。 |
| pins.freeze | `{path, sha256}`；真实 Freeze 的仓库相对路径及独立固定摘要。 |
| bootstrap_sha256 | 同目录 Bootstrap.json 实际字节摘要。 |

`Bootstrap.json` 由根任务根据现有用户委托独立签发，类型 `Phase2TrustedLauncherBootstrap`，state=`AUTHORIZED`，scope=`TM19_GOVERNANCE_READ_PUBLISH`，具名 actor，authorization_ref=`{path, sha256}` 指向实际委托依据。它的 `pins_sha256` 必须等于 pins 对象按 **UTF-8、sorted keys、紧凑逗号/冒号、ensure_ascii=false、末尾单个换行** 序列化后的 SHA256。Config 再绑定 Bootstrap 原始字节，避免循环摘要。

这是委托安装记录，不是新的 runtime grant，也不是本启动器生成的密码学签名。启动器验证该记录、安装 pins、委托来源字节的一致性；根任务负责确认真正的授权和安装来源。测试里的 SYNTHETIC_TEST_INSTALLER / fixture_only=true 不能复制为真实安装证明。

## 固定入口

真实调用必须使用固定 Python 绝对路径和 `-I`，随后是隐藏信任目录内的 launcher 绝对路径。启动器在首次可能受 cwd 影响的标准库导入前拒绝没有 -I 的调用。

只允许：

```text
read
validate --attestation-commit EXACT_SHA --publication-pr ACTUAL_NUMBER
publish --attestation-commit EXACT_SHA --publication-pr ACTUAL_NUMBER --expected-current SHA_OR_NONE
```

默认 read。read 不接受用户指定 activation selector；validate 不接受写 CAS；publish 缺 CAS 直接拒绝。Policy、implementation、repo-root、source SHA、工具路径都只能取自已安装配置。

每次调用顺序为：

1. 检查安装位置和每个词法路径上的 symlink/junction，验证 launcher、publisher、post checker、policy、Python、gh、Freeze、Bootstrap 与委托依据摘要。
2. 将已验证的 publisher/post/policy 字节复制到信任目录内本次临时目录。候选 cwd 不是执行目录。
3. 以固定 Python `-I -B -X utf8` 先运行受信 post_migration.py。它检查真实本机 Freeze 所绑定的 64 路径、39 锁和三个 namespace 的额外写入；FAIL 时不启动 publication 核心，返回拒绝错误。
4. guard PASS 后，使用同一固定运行时启动受信 publication 副本。清除 PYTHON* 环境变量、固定 PATH 和 GitHub host。受信 runner 将核心的 gh 调用定向到已 pin 的绝对 gh 文件，并在每次执行前复验其路径与字节，避免 Windows 可执行文件搜索顺序选中候选 cwd 中的伪 gh。
5. 核心仍负责远端签名、实际 CI、subject、当前权限、CAS 和读写边界。启动器不改核心校验谓词，也不把 stdout PASS 变成 Step15/18 接受。

临时目录仅在 `.git/clued-phase2/.runs/` 下创建，并在请求结束清理；没有生成新的正式治理文件。源码快照避免本次执行被后续普通文件替换改变；本机同 UID 管理员蓄意改写整个信任目录、运行时或启动入口仍是明确管理员例外。

## 测试与证明边界

22 项覆盖：未安装模板、缺 Bootstrap、三个实际 mode 的 selector 约束、缺 CAS、拒绝 policy/source/repo override、Python -I 前置、cwd/PYTHONPATH 伪模块、cwd 伪 gh、受信源码/头部/post 模块/policy/Bootstrap 漂移、配置 pin 未重新授权、Python/gh 路径或字节变化、信任目录 junction，以及本机 SourceIndex/已接受来源/额外治理写入在核心启动前被拒绝。

测试使用真实 post checker 与真实 45 payload/39 锁的隔离安装；publication 是明示的 fixture stub，只运行本机 `gh --version` 验证路径选择。因此它证明启动器隔离和组合顺序，**不证明真实 publisher/API/签名/平台权限**。实际核心由其独立测试及后续真实 CI/低权限平台拒例证明。

固定 Python 可执行文件摘要与 -I 用来约束本机运行时入口及模块来源，不宣称验证整个系统标准库或防御同 UID 管理员。不得把无普通 writer 的当前权限快照单独称为不可绕过。

新 subject、Freeze、核心、policy、工具版本、实际权限或机器变化，都应触发显式配置重绑定并保留新的 Bootstrap；不能从候选自动更新信任。旧 pin 只标识受信的已选择版本，不能单独宣称其他机器/远端发布的全局最新版本。Step20/21 薄 Skill 应指向实际安装并实测的这个入口。

