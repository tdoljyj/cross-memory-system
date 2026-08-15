# Cross-Memory-System · 跨 AI 记忆系统

私有仓库：完整版配置手册 + 数据包快照 + 多 AI 自动同步机制（2026-08-15 建立，2026-08-15 由 codex-memory-system 更名）。

## 定位
git 仓库为**唯一数据源**，多个 AI 助手各自持有工作区镜像，通过仓库互相交换记忆。当前接入方：

| 接入方 | 工作区 | 读写方式 |
|---|---|---|
| Codex | `Documents\Codex\memory\` | `sync-memory.ps1`（收尾 push / 开场 `-Pull`），代理优先 127.0.0.1:7897、直连兜底 |
| WorkBuddy | `~/.workbuddy/codex-memory-system\`（独立克隆） | 开场 `pull --rebase` 读；写入前 `pull --rebase` → 修改 → push（**不直写 Documents**，双端分叉由各自同步机制自愈） |
| 未来其他 AI | 各自工作区 | 同 WorkBuddy：克隆 → pull --rebase → 改 → push |

## 内容
- `配置手册与数据包-v4.md` — 完整手册：记忆机制、写入权限、新电脑配置步骤
- `memory/` — 记忆快照（画像 / 状态 / 决策 / 待办 / 归档）
- `AGENTS.md` — Codex 全局钩子副本（实际生效位置：`~/.codex/AGENTS.md`）
- `sync-memory.ps1` — Codex 侧记忆同步脚本：复制最新记忆 → git 提交 → 推送

## 写入纪律（所有接入方必须遵守）
1. **改前先拉**：`git pull --rebase`，永远基于最新版修改；push 被拒 → 再 pull --rebase → 解决冲突 → 重推
2. **冲突合并**：文本冲突时保留两端内容做语义合并，绝不单方面覆盖
3. **已否决不复活**：`决策.md` 已否决项绝不重复推荐；修改时尊重 Codex 的格式与作者立场
4. **不覆盖活跃编辑**：若对方工作区文件比远端新（正在编辑中），跳过直写，靠对方同步机制吸收
5. **只沉淀稳定长期信息**：不写流水账、一次性临时信息

## Codex 新电脑接入（一次性）
1. 安装 GitHub CLI 并登录同一账号：`gh auth login`
2. 克隆仓库：`gh repo clone tdoljyj/cross-memory-system ~/.codex/projects/codex-memory-system`
3. 把 `memory\` 里的五个文件复制到 `Documents\Codex\memory\`
4. 写全局钩子 `~/.codex/AGENTS.md`（用仓库内 AGENTS.md 内容，路径里的 `<用户名>` 换成实际用户名）
5. 按手册第五节启用 Full access，然后新会话验证

## Codex 自动同步（每会话收尾）
- 钩子指令让 AI 在每次会话收尾时运行：`powershell -ExecutionPolicy Bypass -File ~/.codex/projects/codex-memory-system/sync-memory.ps1`
- 脚本自动：复制最新记忆 → git 提交 → 推送；远端有新提交时先拉取再推
- 想手动同步：在 PowerShell 里直接运行上面的命令

## WorkBuddy 接入要点
- 独立副本：`~/.workbuddy/codex-memory-system\`（目录名固定，remote 指向本仓库；已配 gh 凭据助手）
- ⚠️ 连接策略（2026-08-15 21:28 复测修正 + 21:32 补充）：WorkBuddy 沙箱内 **raw TCP 直连外网被拦**（`Connection was reset`），出网仅代理路径（见配置手册 5.3 权限矩阵）；因此 **WorkBuddy 侧 git 操作一律走代理，且必须用 Git Bash 自带 git 并显式指定 openssl TLS 后端**：`git -c http.proxy=http://127.0.0.1:7897 -c http.sslBackend=openssl fetch/pull/push`。注意：① 必须用 `/mingw64/bin/git`（本机 2.55.0），WorkBuddy 内置 PortableGit 走代理会 TLS 握手失败（schannel `failed to receive handshake` / openssl `unexpected eof`），不要用；② 默认 schannel 后端在代理下也可能握手失败（`schannel: failed to receive handshake`），固定加 `-c http.sslBackend=openssl` 对直连/代理均无副作用；③ 偶发 TLS `unexpected eof` 属网络抖动，重试 1-2 次即可。gh 凭据助手正常供 token。curl / gh CLI 走代理均正常
- 会话开场：`git fetch origin main` + `git pull --rebase origin main` → 读 `memory/` 全部文件对齐上下文
- 会话收尾/重大决策：按上述纪律写入后 push（不直写 `Documents\Codex\memory\`；该侧属 Codex 工作区，分叉由 Codex 侧 sync 自愈）
- git 写操作必须非沙盒执行（dangerouslyDisableSandbox=true），判据=输出末尾 `⚠️ Sandbox bypassed`；push 后用 `git ls-remote origin main` 确认远端 commit

> 注意：本仓库含个人真实记忆数据，保持私有；如要公开，只发布去敏模板版。
