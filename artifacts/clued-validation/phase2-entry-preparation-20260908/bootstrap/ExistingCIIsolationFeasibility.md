# 既有 GitHub Actions 隔离探针可行性

核查时间：2026-09-08T11:00Z 附近。状态：**技术可行，尚不能启动**。本次仅只读核查，没有创建 workflow、触发运行、拉取镜像、运行容器或改变本机 Docker/WSL。

受查仓库：`tdoljyj/cross-memory-system`，本地和远端 main 均为 `78fb8a0edcd09a526ffeeece4aa19fb27c1790b6`；本次独立 `align-and-verify PROJECT` 通过，doctor ALL PASS。

## 已有可复用能力

- `.github/workflows/gitleaks.yml` 已用 `ubuntu-latest`、`contents: read`、固定 SHA 的 checkout 和固定 digest 的 Gitleaks 镜像执行 Docker。真实 [run 34217052119](https://github.com/tdoljyj/cross-memory-system/actions/runs/34217052119) 绑定上述 main；job `102031177416` 的 runner 为 `GitHub Actions 1000000501`，组为 `GitHub Actions`，labels 为 `ubuntu-latest`。2026-09-08T10:44:42Z 至 10:45:25Z 完成，Docker 扫描步骤及整项结果均为 success。这证明现有云端 Docker 工程路径可用，不证明隔离性质或控制器资格。
- `.github/workflows/clued-g4-database.yml` 已有标准 `ubuntu-24.04`、并发控制和超时；`memory-publication-gate.yml` 已有固定 checkout SHA、`persist-credentials: false`、只读仓库权限；`phase2-v027-validation.yml` 已有 artifact 上传及运行身份记录。可复用这些局部模式，不直接复用整个任务的权限、生产环境或触发器。
- 现有 Gitleaks 的整个仓库挂载不能照搬。探针只允许独立合成写目录和固定 driver 的只读挂载；禁止仓库、`.git`、Docker socket、宿主凭据和环境传入容器。宿主 GitHub Actions 自身仍是联网且有运行凭据的控制层，必须与无网络的容器主体明确区分。

## 同范围最小后继差异

受查冻结包为 `scripts/phase2-qualification/docker-isolation/`，`PreparationEvidence.json` SHA256 `be8e84000e1f804db1d1926ad3fba5b21753d076e93095f25f4ef5461ef71341`；其独立工程审查为 `bootstrap/DockerPreparationIndependentReview.json`。现有字节继续冻结。

1. `prepare.py` 的 Docker 路径是 Windows EXE，且 `run/formal` 无条件拒绝。需要一个独立受审的 Linux 后继，固定实际 Docker 可执行文件并补齐只允许 create/start/inspect/stop/wait 的宿主监督器；不能把现有准备包描述成可直接执行的控制器。
2. 固定真实 Linux amd64 Python 镜像 digest、镜像本地 ID/RepoDigest 和镜像自带环境。当前示例 image 为 null；现有 Gitleaks/Trivy 镜像不等于可用 Python 探针镜像。保留 `--pull=never`；若需下载，只能在容器执行前按固定来源和摘要单独核实该依赖，不能隐式回退到 tag。
3. 使用标准 Linux runner，绑定实际 image 版本、内核、Docker 版本、源码/配置/夹具/镜像摘要及 run/attempt；`ubuntu-24.04` 标签本身不是不可变 host 证明。保持原固定参数：非 root、只读 rootfs、network none、cap-drop ALL、no-new-privileges、CPU/内存/PID/tmpfs 限制及两项允许挂载。读取未来实际观察来判定文件、网络和进程树停止，不预填 PASS。
4. 工程包装使用只读 contents、checkout 不持久化凭据、单一并发槽和硬超时。每次受控执行不超过实际 GA 的 600 秒上限，预留停止取证时间。父进程显式设置合成环境哨兵但不得把宿主环境传入容器。记录 STOP 后准确容器 ID/状态/结束时间和后代停止证据；任务取消、runner 丢失或结果不明一律 UNKNOWN，不以 CI timeout/取消替代进程终止，不自动重试。
5. 本地 Intent 和事后上传 artifact 只作工程证据。正式远端 Intent 仍按主控已选定的私有 GitHub 不可变 commit/blob、精确摘要及动作前独立读回接线；普通 artifact 成功不能代替它。不得为了写证据给候选 workflow 任意仓库写权限。Owner/GA 当前状态、撤回及独立 generations、Profile 和受查 Skill 的正式绑定仍须现有批准链的实际输入。

## 计费和授权结论

这是私有仓库。GitHub 对私有仓库的标准托管 runner 提供随计划的包含额度，超额可能收费；既有 CI 成功不等于仍有免费余额。[GitHub Actions 计费](https://docs.github.com/en/billing/concepts/product-billing/github-actions)

本次 `gh api user` 确认登录 `tdoljyj`，但 `plan` 为 null。只读请求 `GET /users/tdoljyj/settings/billing/usage?year=2026&month=9` 返回 HTTP 404，CLI 明确提示当前凭据缺少 `user` scope。没有刷新授权或改设置。因此当前计划、剩余包含分钟/存储和阻止超额的预算设置均 **UNKNOWN**，不能推断为零费用或零余额。主控可通过现有已登录的 Billing & Licensing 页面只读核对这些数据；本次不要求新 token，也不增加费用。[个人用量查看](https://docs.github.com/en/billing/how-tos/products/estimate-spending)、[预算的 Stop usage 设置](https://docs.github.com/en/billing/how-tos/set-up-budgets)

`bootstrap/OwnerDelegation_20260908.json` 明确允许同范围后继在精确绑定、独立接受和新鲜授权后继续，未把 host 限死在本机 Windows。现有签名 Owner PR20 merge `4f722ea9d78488b749c15d27fe9145e9d9f9d2c2` 的窗口截至 2026-09-09T09:28:59Z；本报告不代替动作前重新核验撤回/窗口。故换用现有标准 GitHub Linux host 本身无需新增一般 Owner 授权；但精确 host 后继必须由指定独立 assessor 接受，且当前这项委派仅授权只读可行性核查。

Owner 限制仍为 paid_budget=0、model_budget=0、最多 1 项活动隔离测试、累计受控执行 7200 秒。免费额度和禁止超额机制未核实时保持不启动；若必须付费、增加凭据权限、扩大主体/网络/工具范围或超出窗口，不能用这份报告批准。补齐额度证据与最小 Linux 后继后，再由主控依既有独立接受和授权流程安排同范围合成工程观察。任何普通 CI 绿色均不是 controller qualified、R11/PQUAL 或 Entry 通过。
