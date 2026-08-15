# Cross-Memory-System · 跨 AI 记忆系统

私有仓库：完整版配置手册 + 数据包快照 + **多机多 AI 协同**自动同步机制（2026-08-15 建立并更名）。

## 定位
一个 git 私有仓库作为**唯一数据源**，多台机器、多个 AI 助手各自持有工作区镜像，通过仓库互相交换记忆。设计目标不是单机双端，而是**任意机器 × 任意 AI** 的协同：各端从不直写对方工作区，一切经仓库收敛；每个提交都带 `AI名@机器名` 身份，可追溯到谁、在哪台机器、改了什么。

当前接入方：

| 接入方 | 工作区 | 读写方式 |
|---|---|---|
| Codex | `Documents\Codex\memory\` | `sync-memory.ps1`（收尾 push / 开场 `-Pull` / 接入 `-Doctor` 自检），代理优先 127.0.0.1:7897（固定 `http.sslBackend=openssl`）、直连兜底 |
| WorkBuddy | `~/.workbuddy/codex-memory-system\`（独立克隆） | 开场 `git pull` 读；写入前 `pull --rebase` → 修改 → push；不直写 Codex 侧工作区 |
| 未来其他 AI | 各自工作区 | 同 WorkBuddy：克隆 → pull --rebase → 改 → push；不直写任何既有工作区 |

## 多机多 AI 协同机制
1. **身份与审计**：每端以 `AI名@机器名`（如 `Codex@DESKTOP-X`）作为 git 作者提交，commit message 带 `[身份]` 前缀与变更文件清单；`git log --format='%an %s'` 即可看到谁在哪台机器改了什么。
2. **并发冲突分层**：追加类文件（`归档.md`）配 `merge=union`，两端同时追加自动保留、无需人工；改写类文件（`状态.md` / `待办.md`）靠「改前立即 pull --rebase + 小步提交 + 语义合并」，冲突时保留两端语义、绝不单方面覆盖。
3. **跨机可移植**：每机一份 gitignored 的 `sync.config.ps1`（身份 / 代理 / 记忆目录 / 提交身份），脚本无此文件时回落本机默认；换机器、换 OS（需 pwsh）只改这一个文件。
4. **接入自检**：新机器跑 `powershell -ExecutionPolicy Bypass -File sync-memory.ps1 -Doctor`，一次检查 git、网络与凭据、引用写入（沙盒 overlay 拦截，2026-08-16 实锤非 PortableGit 缺陷）、换行符配置、记忆目录，全部 PASS 才正式接入。

## 内容
- `配置手册与数据包-v4.md` — 完整手册：记忆机制、写入权限、新电脑配置步骤
- `memory/` — 记忆快照（画像 / 状态 / 决策 / 待办 / 归档）
- `AGENTS.md` — Codex 全局钩子副本（实际生效位置：`~/.codex/AGENTS.md`）
- `sync-memory.ps1` — Codex 侧记忆同步脚本：复制最新记忆 → git 提交 → 推送

## 写入纪律（所有接入方必须遵守）
1. **带身份提交**：每端以 `AI名@机器名` 作为 git 作者（Codex 脚本自动；手动客户端用 `git -c user.name="AI名@机器名" commit`）；commit message 带 `[身份]` 与变更文件
2. **改前先拉**：`git pull --rebase`，永远基于最新版修改；push 被拒 → 再 pull --rebase → 解决冲突 → 重推
3. **冲突合并**：文本冲突时保留两端内容做语义合并，绝不单方面覆盖；**绝不 force push / reset / 以本地覆盖远端**。`归档.md` 为追加类文件（union 自动合并），`状态.md` / `待办.md` 为改写类文件（冲突需语义合并）
4. **已否决不复活**：`决策.md` 已否决项绝不重复推荐；修改时尊重 Codex 的格式与作者立场
5. **双端对称「不越界」**：任何一端不直写对方工作区或克隆（Codex 不写 `~/.workbuddy`，WorkBuddy 不写 `Documents\Codex\memory`）；一切写入经仓库交换，各自工作区由各端自管。分叉属正常，靠 pull --rebase 收敛
6. **字节级一致**：语义相同的内容必须字节级一致（LF / 无 BOM，`.gitattributes` 锁定），避免互相重写
7. **只沉淀稳定长期信息**：不写流水账、一次性临时信息

## 新电脑接入（一次性）
1. 安装 GitHub CLI 并登录同一账号：`gh auth login`
2. 接入 GitHub MCP：`gh auth token` 拿到令牌后 `setx GITHUB_PAT_TOKEN "<令牌>"`（gho_ 开头，用户级环境变量）；在 `~/.codex/config.toml` 加 `[mcp_servers.github]`（`url = "https://api.githubcopilot.com/mcp/"`、`bearer_token_env_var = "GITHUB_PAT_TOKEN"`）或走桌面 App 设置 → MCP 入口；新会话 `codex mcp list` 应看到 44 个工具。注意 config.toml 会被启动重写、MCP 条目可能丢失需重加；gh 重新登录后令牌会变，需重跑 setx
3. 克隆仓库：`gh repo clone tdoljyj/cross-memory-system ~/.codex/projects/codex-memory-system`
4. 把 `memory\` 里的五个文件复制到 `Documents\Codex\memory\`
5. 写全局钩子 `~/.codex/AGENTS.md`（用仓库内 AGENTS.md 内容，路径里的 `<用户名>` 换成实际用户名）
6. 建立本机配置 `~/.codex/projects/codex-memory-system/sync.config.ps1`（gitignored）：`$AgentName = "Codex"`、`$ProxyUrl = "http://127.0.0.1:7897"`（无代理则 `""`）、`$MemoryDir`（非 Windows 或自定义路径时改）
7. 跑自检：`powershell -ExecutionPolicy Bypass -File ~/.codex/projects/codex-memory-system/sync-memory.ps1 -Doctor`，全部 PASS
8. 按手册第五节启用 Full access，然后新会话验证

## Codex 自动同步（每会话收尾）
- 钩子指令让 AI 在每次会话收尾时运行：`powershell -ExecutionPolicy Bypass -File ~/.codex/projects/codex-memory-system/sync-memory.ps1`
- 脚本自动：复制最新记忆 → git 提交 → 推送；远端有新提交时先拉取再推
- 想手动同步：在 PowerShell 里直接运行上面的命令

## WorkBuddy 接入要点
- 独立副本：`~/.workbuddy/codex-memory-system\`（目录名固定，remote 指向本仓库；已配 gh 凭据助手）
- 提交身份：`git config user.name "WorkBuddy@<机器名>"`（email 保持账号邮箱），commit message 带 `[身份]` 与变更文件；其余与本仓相同
- ⚠️ 连接策略（2026-08-15 21:28 复测修正 + 2026-08-16 更新）：WorkBuddy 沙箱内 **raw TCP 直连外网被拦**（`Connection was reset`），出网仅代理路径（见配置手册 5.3 权限矩阵）；因此 **WorkBuddy 侧 git 操作一律走代理**：`git -c http.proxy=http://127.0.0.1:7897 fetch/pull/push`。git 客户端优先**官方 Git for Windows**（`C:\Program Files\Git`，本机已装 2.55.0.3，sync-memory.py 自动优先）；**勿用 WorkBuddy 内置 PortableGit**（走代理 TLS 握手失败：schannel `failed to receive handshake` / openssl `unexpected eof`）。gh 凭据助手正常供 token。curl / gh CLI 走代理均正常
- ⚠️ TLS 后端（2026-08-15 21:32 复测补充）：Git Bash 自带 git + 代理时 schannel 默认后端仍**偶发**握手失败（`schannel: failed to receive handshake`）；命令固定加 `-c http.sslBackend=openssl`（对直连/代理均无副作用）
- **同步脚本 `sync-memory.py`**（Python 版，WorkBuddy 侧专用，2026-08-16 起）：WorkBuddy 沙盒 overlay 会拦截 git 写 tracking ref（`refs/remotes/origin/main` 两层目录，lockfile+rename 原子写 exit 0 静默失败），脚本策略=git 负责对象传输、Python 负责 ref 兜底写入；三模式 `pull` / `push` / `doctor`，用法见脚本头注释
- 会话开场：`python sync-memory.py pull`（自动 fetch + 对齐 + 补写 tracking ref + ls-remote 核验）→ 读 `memory/` 全部文件对齐上下文
- 会话收尾/重大决策：写入 + commit 后 `python sync-memory.py push`（非沙盒执行，判据=输出尾 `⚠️ Sandbox bypassed`）；**不直写 Codex 侧工作区**（`Documents\Codex\memory\` 由 Codex 自己同步）
- git 写操作必须非沙盒执行（dangerouslyDisableSandbox=true），判据=输出末尾 `⚠️ Sandbox bypassed`；push 后用 `git ls-remote origin main` 确认远端 commit

> 注意：本仓库含个人真实记忆数据，保持私有；如要公开，只发布去敏模板版。
