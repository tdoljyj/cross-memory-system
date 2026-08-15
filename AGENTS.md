# 全局指令 · 跨会话记忆按需读写（v3.1，对齐架构基线 vNext-1.2，2026-08-16 起生效）

> 规范依据：本仓库《架构基线文档-vNext.md》（vNext-1.2）。触发术语（T0–T4）、记忆分类（L1–L6）、Trigger Matrix、Router 边界、写入纪律均与基线一致；同步与执行纪律保留既定四不变量。

记忆文件（%USERPROFILE% 即本机用户目录）：

- 用户画像：%USERPROFILE%\Documents\Codex\memory\画像.md
- 当前状态：%USERPROFILE%\Documents\Codex\memory\状态.md
- 决策记录：%USERPROFILE%\Documents\Codex\memory\决策.md（已否决的绝不重复推荐）
- 待办：%USERPROFILE%\Documents\Codex\memory\待办.md
- 归档：%USERPROFILE%\Documents\Codex\memory\归档.md（历史审计项，仅在查历史细节时读）

## 一、Memory Router（按需加载判断）

**默认 Memory Access = NONE**。Router 只根据当前请求判断个人相关性，判断发生在读取记忆之前（基线第七节：不得先加载再判断）。

触发分类（T0–T4）：
- **T0 绝对不加载**：数学题、算法题、语言语法、通用知识、历史/物理知识、一般代码问题、一般概念解释、无个人指涉的简短查询与一次性机械操作。
- **T1 强相关，必须召回**：提及自身身份/职业/偏好/审美/经历/家庭/目标/计划；指涉跨会话历史（「我们之前」「上次」「那个决定」）；维护记忆系统本身。
- **T2 个人相关，只召回局部**：通用技术问题但个人上下文显著影响答案（引擎版本选型、工具链方案、进度安排）；在研项目相关任务。
- **T3 疑似相关**：Light Recall，只加载当前项目、技术栈、学习目标等最小集。
- **T4 用户明确要求记忆**：「记住…」「以后都…」→ Immediate Memory Write，最高优先级。

模糊兜底：拿不准时按相关处理（误加载成本 ~1 秒，漏加载成本是错误回答）。

## 二、Recall Planner（最小召回，命中加载时执行）

L1–L6 记忆类型 → 文件映射（按需选读，不全读）：

| 类型 | 内容 | 召回范围（段级，按需只读对应标题段） |
|---|---|---|
| L1 Identity | 职业、长期身份、角色 | 画像.md「身份轨迹」「一句话」「技术能力」 |
| L2 Preference | 喜好、审美、工作习惯、工具偏好 | 画像.md「审美」「工作方式（对 AI / 工具的要求）」「软件工程态度」「产品思维」「游戏偏好（研究型玩家）」 |
| L3 Project | 当前项目、目标、技术栈、长期决策 | 状态.md「主线一」「主线二」「工作室」+ 决策.md「已确认」 |
| L4 History | 过去做过什么、尝试过什么、旧决定 | 归档.md（按需查对应节）+ 决策.md「已否决」 |
| L5 Constraint | 禁止项、预算、必须兼容、已否决方案 | 决策.md「已否决（不要重复推荐）」+ 画像.md「雷区（不要触碰）」（必读，防复活已否决项） |
| L6 Temporary Context | 当前任务/本轮调试 | 不入库、不召回（会话内处理） |

标准三件套（在研项目或跨多类别）：画像 + 状态 + 决策。查历史审计细节才读归档.md。

## 三、读前对齐（仅在命中加载时执行）

1. 若 %USERPROFILE%\.codex\projects\codex-memory-system\.sync-failed 存在，先告知用户上次同步失败及时间戳。
2. 运行：powershell -ExecutionPolicy Bypass -File "%USERPROFILE%\.codex\projects\codex-memory-system\sync-memory.ps1" -Pull
3. -Pull 输出提示「could not auto-write / pending write-back」时，用 apply_patch 把仓库 memory 目录较新文件写回 %USERPROFILE%\Documents\Codex\memory 对应文件，再重跑 -Pull 清除标记；无更新则直接读取。

缓存语义：本地镜像只是 Cache，仓库是唯一事实源。读前 pull 即版本校验（cache.version == store.version），不一致必须重取。

## 四、Memory Change Detector + 写入纪律（按需写入与上传）

- **写入触发**：本轮产生稳定的个人/项目信息（新进展、新决策、新否决、待办变化、用户纠正、T4 明确记忆）才写回对应文件。判定输出：NO_CHANGE / NEW_MEMORY / UPDATE_MEMORY / SUPERSEDE_MEMORY / DELETE_MEMORY。
- **上传触发**：仅当本轮实际改动了记忆文件才运行收尾同步：powershell -ExecutionPolicy Bypass -File "%USERPROFILE%\.codex\projects\codex-memory-system\sync-memory.ps1"
- **NO_CHANGE → NO_WRITE → NO_SYNC → NO_INVALIDATION**：通用问答或记忆未变化时不 commit、不 push，静默结束。
- **事实与推测分离**（基线第十节）：用户明确表达 → 直接写入；AI 推测 → 标注「（推测）」或不写，禁止把推测写成事实。
- **superseded 语义**（基线 P0-6）：旧结论被推翻时不删除，在决策.md 标注 superseded（保留于「已否决/已推翻」段）并记入归档，不要 delete+insert。
- 只沉淀稳定长期信息；L6 临时上下文不入长期记忆。

## 五、执行纪律（防"提交了但没推到远端"）

- 双端对称「不越界」：本端不直写对方工作区 / 克隆（不写 ~/.workbuddy，也不写对方机器的 Documents\Codex\memory）；一切记忆交换经本仓库（唯一数据源=Canonical Store），分叉靠 merge（非 rebase）收敛，绝不 force push / reset / 以本地覆盖远端。
- git 写操作（commit / push / sync-memory.ps1）运行在带沙盒 overlay 的环境时（典型：WorkBuddy Bash 沙盒对 ~/.workbuddy 下写入跨命令不持久），必须改为非沙盒方式执行（系统 PowerShell / 编辑器文件通道 / 批准沙盒放行）；~/.codex 与 Documents 不受 overlay 影响。
- push 后立即用 `git ls-remote origin`（或 `git ls-remote <remote-url>`）对比远端真实 commit 确认已推送；勿依赖本地 `git status` 的 ahead 显示（沙盒 overlay 拦截 tracking ref 写入时本地引用可能失真；2026-08-16 实锤归因=沙盒 overlay，非 PortableGit 缺陷）。
- 删除传播护栏：同步前校验源 memory 目录 `.md` ≥ 5 且各文件非空；不足则拒绝同步并写 `.sync-failed`，绝不把近空目录推成空仓。
- 核验统一：push/pull 后核验一律用 `merge-base --is-ancestor`（祖先判定），不用 `==` 比较；并发下本地落后于远端属正常（安全），仅真分叉才视为失败。

## 六、多机多 AI 协同纪律

- 身份：每端以「AI名@机器名」作为 git 作者提交（Codex 脚本自动；手动端用 git -c user.name="AI名@机器名" commit），commit message 带 [身份] 与变更文件，便于追溯与冲突仲裁。
- 文件分区：归档.md 为追加类（union 自动合并，仅 `git merge` 生效）；状态.md / 待办.md 为改写类（改前立即 merge，冲突保留两端语义、绝不单方面覆盖）；决策.md / 画像.md 多为追加、偶发改写（默认合并，冲突语义合并）。收敛统一 `git merge`（非 rebase）。
- 每机一份 gitignored 的 sync.config.ps1（身份/代理/记忆目录/提交身份）；新机器先跑 sync-memory.ps1 -Doctor 自检再接入。
