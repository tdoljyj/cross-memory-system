# ADR 0011：companion 不靠交互登录

- 状态：已决定，未实施。当前 companion 仍然是 AtLogOn 触发、Interactive 令牌。
- 日期：2026-11-07
- Owner Decision：`9dc130c7` 第 3 项（M5 采用 B2）、第 4 项（companion 改用细粒度 GitHub 令牌）
- 关联：
  - Task `59f8ef81`：无人交互登录时 companion 不可用；
  - 优化方案 Task `bf57ff10` 的 M5；
  - 设计稿 `e19dbb41` §65。
- 档案：DESIGN §8.4、§24

## 背景

companion 必须以 Owner 身份运行，原因有两个：

- WSL 发行版按 Windows 用户注册，Session 0 的服务账户访问不到；
- bundle 要用 Owner 自己的 git 凭据。

现在它是计划任务 `\Clued\CluedCIResidentCompanion`，AtLogOn 触发，用 Interactive 令牌。Owner 没登录时（重启后、注销后），三个服务都在运行，companion 却不在。结果是：

- 执行器以 `COMPANION_NOT_READY` 推迟一切；
- 从冷启动到能干活，没有时间上界。

## 决定

**采用 B2**：任务计划程序保存 Owner 的 Windows 密码（Password 登录类型，"不管用户是否登录都运行"），让 companion 在无人登录时也能启动和恢复。

- 密码由 Owner 在安全桌面的凭据框里输入，Agent 不经手。
- 密码只存在本机，建议开启 BitLocker。
- 随一次整套重装上线。改动涉及计划任务和账户相关的配置，属于冻结范围，不能走原地升级。

**改用细粒度令牌**：companion 的 gh 令牌换成只限本仓库、权限最小的细粒度令牌。令牌由 Owner 在 GitHub 生成，经 Windows 凭据界面存入。

## 理由

- 目标是"升级 0 次人工、重启不靠登录"（Task `bf57ff10`），节点重启后无人值守地恢复是它的前提。
- 同类做法已经在 DESK 的缓存维护任务上验证过（Decision `62922cfe`：用保存密码的 clued-runner 计划任务）。
- 细粒度令牌把 companion 能对 GitHub 做的事，收窄到本仓库的读操作和少数固定的写操作。

## 后果

- Windows 上会多存一份 Owner 密码，形式是 LSA 秘密，本机管理员可以取得。这与现有"Owner、root 是受信者"的边界一致。
- 实施之前，节点重启后需要 Owner 登录一次（锁屏也算登录），见 runbook §5.9。
- 验收要覆盖以下情形（Task `59f8ef81`）：
  - 无人登录时冷启动；
  - 注销；
  - companion 崩溃；
  - 有限重试耗尽；
  - 凭据失效；
  - HALT 或 PAUSE；
  - Source 或策略变化。
