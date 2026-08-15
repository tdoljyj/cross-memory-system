# 全局指令 · 跨会话记忆按需读写（v2，2026-08-16 起生效）

记忆文件（%USERPROFILE% 即本机用户目录）：

- 用户画像：%USERPROFILE%\Documents\Codex\memory\画像.md
- 当前状态：%USERPROFILE%\Documents\Codex\memory\状态.md
- 决策记录：%USERPROFILE%\Documents\Codex\memory\决策.md（已否决的绝不重复推荐）
- 待办：%USERPROFILE%\Documents\Codex\memory\待办.md
- 归档：%USERPROFILE%\Documents\Codex\memory\归档.md（历史审计项，仅在查历史细节时读）

## 一、按需加载（读）

**默认不加载**。仅当请求命中以下任一「加载触发」时才执行「读前对齐 + 读记忆」：

加载触发：
1. 用户提及自身：身份 / 职业 / 偏好 / 审美 / 经历 / 家庭 / 目标 / 计划（「你知道我是做什么的吗」「我之前说过…」「我的预算…」）
2. 指涉跨会话历史：「我们之前」「上次」「那个决定」「已否决的方案」
3. 任务依赖个人上下文才能答对：在研项目（游戏原型 /《山川夜语：逐日》/ Maya 工具 / Atlas / 工作室命名）、方案选型、进度安排（「接下来做什么」）、硬件与预算决策
4. 维护记忆系统本身：同步 / 审计 / 体检 / 改协议
5. 回答若不带个人上下文会与既往决策冲突或质量显著下降时

明确不加载：
- 与个人无关的通用问题：数学 / 代码语法 / 客观知识 / 翻译 / 公开事实
- 无个人指涉的简短查询与一次性机械操作

模糊兜底：拿不准是否命中时**加载**（误加载成本约 1 秒，漏加载成本是错误回答）。

文件分级（命中加载时按需选读，不必每次全读）：
- 身份 / 偏好 /「我是谁」→ 画像.md（+ 状态.md 了解当前主线）
- 要推荐方案 / 命名 / 做决策 → 决策.md 必读（防复活已否决项）
- 问进度 / 下一步 → 状态.md + 待办.md
- 查历史审计细节 → 归档.md
- 涉及在研项目或跨多个类别 → 画像 + 状态 + 决策 三件为标准集

## 二、读前对齐（仅在命中加载时执行）

1. 若 %USERPROFILE%\.codex\projects\codex-memory-system\.sync-failed 存在，先告知用户上次同步失败及时间戳。
2. 运行：powershell -ExecutionPolicy Bypass -File "%USERPROFILE%\.codex\projects\codex-memory-system\sync-memory.ps1" -Pull
3. -Pull 输出提示「could not auto-write / pending write-back」时，用 apply_patch 把仓库 memory 目录较新文件写回 %USERPROFILE%\Documents\Codex\memory 对应文件，再重跑 -Pull 清除标记；无更新则直接读取。

## 三、按需写入与上传（写）

- 写入触发：本轮对话产生了**稳定的个人/项目信息**——新进展、新决策、新否决、待办变化、用户纠正。产生即写回对应文件（只放这一处）。
- 上传触发：**仅当本轮实际改动了记忆文件**才运行收尾同步：powershell -ExecutionPolicy Bypass -File "%USERPROFILE%\.codex\projects\codex-memory-system\sync-memory.ps1"
- 未产生记忆写入（通用问答、记忆未变化）→ 不 commit、不 push，静默结束。
- 只沉淀稳定长期信息，不写一次性临时信息。

## 四、执行纪律（防"提交了但没推到远端"）

- 双端对称「不越界」：本端不直写对方工作区 / 克隆（不写 ~/.workbuddy，也不写对方机器的 Documents\Codex\memory）；一切记忆交换经本仓库（唯一数据源），分叉靠 merge（非 rebase）收敛，绝不 force push / reset / 以本地覆盖远端。
- git 写操作（commit / push / sync-memory.ps1）运行在带沙盒 overlay 的环境时（典型：WorkBuddy Bash 沙盒对 ~/.workbuddy 下写入跨命令不持久），必须改为非沙盒方式执行（系统 PowerShell / 编辑器文件通道 / 批准沙盒放行）；~/.codex 与 Documents 不受 overlay 影响。
- push 后立即用 `git ls-remote origin`（或 `git ls-remote <remote-url>`）对比远端真实 commit 确认已推送；勿依赖本地 `git status` 的 ahead 显示（沙盒 overlay 拦截 tracking ref 写入时本地引用可能失真；2026-08-16 实锤归因=沙盒 overlay，非 PortableGit 缺陷）。

## 五、多机多 AI 协同纪律

- 身份：每端以「AI名@机器名」作为 git 作者提交（Codex 脚本自动；手动端用 git -c user.name="AI名@机器名" commit），commit message 带 [身份] 与变更文件，便于追溯与冲突仲裁。
- 文件分区：归档.md 为追加类（union 自动合并，仅 `git merge` 生效）；状态.md / 待办.md 为改写类（改前立即 merge，冲突保留两端语义、绝不单方面覆盖）；决策.md / 画像.md 多为追加、偶发改写（默认合并，冲突语义合并）。收敛统一 `git merge`（非 rebase）。
- 每机一份 gitignored 的 sync.config.ps1（身份/代理/记忆目录/提交身份）；新机器先跑 sync-memory.ps1 -Doctor 自检再接入。
