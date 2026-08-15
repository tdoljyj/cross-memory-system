# Codex 跨会话记忆系统

私有仓库：完整版配置手册 + 数据包快照 + 自动同步机制（2026-08-15 建立）。

## 内容
- `配置手册与数据包-v4.md` — 完整手册：记忆机制、写入权限、新电脑配置步骤
- `memory/` — 当前记忆快照（画像 / 状态 / 决策 / 待办）
- `AGENTS.md` — 全局钩子副本（实际生效位置：`~/.codex/AGENTS.md`）
- `sync-memory.ps1` — 记忆同步脚本：复制最新记忆 → git 提交 → 推送

## 新电脑接入（一次性）
1. 安装 GitHub CLI 并登录同一账号：`gh auth login`
2. 克隆仓库：`gh repo clone tdoljyj/codex-memory-system ~/.codex/projects/codex-memory-system`
3. 把 `memory\` 里的四个文件复制到 `Documents\Codex\memory\`
4. 写全局钩子 `~/.codex/AGENTS.md`（用仓库内 AGENTS.md 内容，路径里的 `<用户名>` 换成实际用户名）
5. 按手册第五节启用 Full access，然后新会话验证

## 自动同步（每会话收尾）
- 钩子指令让 AI 在每次会话收尾时运行：`powershell -ExecutionPolicy Bypass -File ~/.codex/projects/codex-memory-system/sync-memory.ps1`
- 脚本自动：复制最新记忆 → git 提交 → 推送；多机共用时若远端有新提交会先拉取再推
- 想手动同步：在 PowerShell 里直接运行上面的命令

> 注意：本仓库含个人真实记忆数据，保持私有；如要公开，只发布去敏模板版。
