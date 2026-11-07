# ADR 0001：权限分离

- 状态：生效
- 日期：2026-10-21（设计 v0.1–v0.5）；2026-10-05（runner 改用专用低权限账户）；2026-11-07（companion 令牌收窄）
- Owner Decision：`0d84ddbb`（常驻设计的四项选择）；`9941fe6b`（runner 改用专用低权限账号）；`9dc130c7` 第 4 项（companion 换细粒度 GitHub 令牌）
- 档案：DESIGN §1.3、§3.1、§3.3、§8

## 背景

改造之前，每批的绑定包由 Agent 在用户可写的 `%TEMP%` 里生成，再由 Owner 的完整管理员令牌执行。能写用户目录的进程，只要在 UAC 弹出之前换掉文件，就能拿到管理员执行。挡住它的只有"点之前看一眼哈希"。

Agent 和 Owner 共用同一个 Windows 会话和同一个 GitHub 身份，所以"用户会话里的任意进程"必须当作攻击者来防。

## 决定

把职责拆给四个互相隔离的身份，各自只拿完成本职的最小权限：

| 身份 | 只做 | 不做 |
|---|---|---|
| `NT SERVICE\CluedCIResident`（虚拟账户，非管理员，按服务 SID 封出站） | 全部调度决定，写自己的 state | 联网、读秘密、加载用户目录的代码、碰 runner 服务 |
| `CluedCISwapBroker`（LocalSystem） | 把 runner 服务在原始二进制和白名单里的通用助手之间切换，启动一次再换回 | 改账户、启动类型、DACL；运行白名单以外的东西；杀进程 |
| `.\clued-control`（runner 账户） | 读 App 私钥和 ci-admission token，做实时核验与发布 | — |
| companion（Owner 会话，不提权） | 用 Owner 的读凭据打 bundle、搬运记录、启动固定的 unit、轮询 | 任何授权判断、任意命令、写执行器的 state 和 owner 目录 |

另外两条：

- 提权只发生在两类场合：安装、升级、卸载；Owner 往 `owner\` 写一个请求文件。提权脚本只从已安装副本运行，不启动其他程序，也不把管理员令牌交给 node。
- companion 访问 GitHub 用的令牌收窄为只限本仓库、最小权限的细粒度令牌（`9dc130c7` 第 4 项，未实施）。

## 理由

- **代码只从管理员专用目录加载，用户目录里的东西只当数据。** 这从结构上去掉了"换文件拿管理员"这条路，比看哈希可靠。
- **常驻服务不联网、不读秘密。** 被攻破的调度层最多做错调度，发不出伪造的检查。
- **只做一件事的 SYSTEM 代理，攻击面最小。** 它的请求格式精确、有领取标记、有期限，只接受钉住哈希的助手。

## 后果

- 每批 0 次 UAC。
- 秘密只有 clued-control 能读，换 App 私钥或 token 要走安装（只新建、从不覆盖）。
- Linux 侧以 WSL root 运行。WSL root 能从 Owner 会话直接拿到，所以 Linux 侧的事实最多和 Owner 会话一样可信。这是明确接受的边界（resident constraint `4fedfc84`），用"root 实测、测不出就失败"加上下一批的 root 预检来兜底。
- companion 依赖 Owner 的登录会话。见 [ADR 0011](0011-companion-without-logon.md)。
