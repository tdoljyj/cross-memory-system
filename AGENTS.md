# Clued 仓库连续性入口（当前规则）

> 本节是当前 Clued 仓库的最高优先级入口；下方旧版 Memory Router / 同步规则继续保留，不因本次整理改变功能或测试语义。

1. 任何 Clued、Pixel Gravity、Clued Kernel、Clued Cloud、Binding、Memory Engine 或部署任务，开始前必须使用 `Clued Continuity`。
2. 必须读取当前用户 `project:clued` 上下文的同一份权威工作日志 `memory/contexts/projects/clued/日志.md`；它是用户的工作日志与长期记忆，不是 Clued 开发日志。不得再使用根目录 `日志.md`、`Clued_工作日志.md` 或 `工作日志.md`。
3. 必须先核对真实 GitHub `origin/main`、适用合同与部署目标，再判断当前状态；不得用聊天记忆或旧报告替代实时证据。
4. 完成后必须把用户目标、决策、授权、约束、动作、证据、错误、阻塞和唯一下一步写回同一份 `memory/contexts/projects/clued/日志.md`。
5. 版本口径以根目录 `CURRENT_STATUS.md` 为人类可读入口；`VERSION`、产品版本、Runtime、协议和合同版本不得混为一谈。
6. 不得触碰真实 flat Binding、执行真实迁移、启用语义召回、发布、部署、重写历史或删除受保护证据，除非获得针对该动作的明确授权。
7. 上述仓库文件仅是当前用户 `project:clued` 的生产前授权镜像；生产客户日志必须按 `user_id + context_key` 存入 Canonical Context，不能用 Git 仓库充当多租户数据面。

---

# 全局指令 · 跨会话记忆按需读写（v4.0，对齐架构基线 vNext-2.0，2026-08-17 起生效）

> 规范依据：本仓库《架构基线文档-vNext-2.0.md》（vNext-2.0，2026-08-17）。触发术语（T0–T4）、记忆分类（L1–L6）、Trigger Matrix、Router 边界、写入纪律与 vNext-1.3 一致；同步与执行纪律保留既定四不变量。vNext-2.0 新增 Memory Engine（对象层/生命周期/写引擎/召回引擎/审计/索引/迁移/CLI），位于同步层之上，不改动 v1.3 同步护栏。历史基线：《架构基线文档-vNext-1.3.md》。

记忆文件（%USERPROFILE% 即本机用户目录）：

- 用户画像：%USERPROFILE%\Documents\Codex\memory\画像.md
- 当前状态：%USERPROFILE%\Documents\Codex\memory\状态.md
- 决策记录：%USERPROFILE%\Documents\Codex\memory\决策.md（已否决的绝不重复推荐）
- 待办：%USERPROFILE%\Documents\Codex\memory\待办.md
- 归档：%USERPROFILE%\Documents\Codex\memory\归档.md（历史审计项，仅在查历史细节时读）
- 召回索引：本仓库 `memory/index.json`（L1–L6 → 文件+标题段的唯一事实源，同步护栏也据此判断必需文件集）

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

权威映射在 `memory/index.json`（`schema_version: 1`，`recall` 字段）；下表为其人类可读摘要，二者不一致时以 `index.json` 为准（`tests/test_acceptance.py` 会校验一致性）：

| 类型 | 内容 | 召回范围（段级，按需只读对应标题段） |
|---|---|---|
| L1 Identity | 职业、长期身份、角色 | 画像.md「身份轨迹」「一句话」「技术能力」 |
| L2 Preference | 喜好、审美、工作习惯、工具偏好 | 画像.md「审美」「工作方式（对 AI / 工具的要求）」「软件工程态度」「产品思维」「游戏偏好（研究型玩家）」 |
| L3 Project | 当前项目、目标、技术栈、长期决策 | 状态.md「主线一：游戏原型（UE）」「主线二：剧情编剧」「工作室」+ 决策.md「已确认」 |
| L4 History | 过去做过什么、尝试过什么、旧决定 | 归档.md（按需查对应节）+ 决策.md「已否决（不要重复推荐）」 |
| L5 Constraint | 禁止项、预算、必须兼容、已否决方案 | 决策.md「已否决（不要重复推荐）」+ 画像.md「雷区（不要触碰）」（必读，防复活已否决项） |
| L6 Temporary Context | 当前任务/本轮调试 | 不入库、不召回（会话内处理） |

标准三件套（在研项目或跨多类别）：画像 + 状态 + 决策。查历史审计细节才读归档.md。

## 三、读前对齐（仅在命中加载时执行）

1. 若 %USERPROFILE%\.codex\projects\codex-memory-system\.sync-failed 存在，先告知用户上次同步失败及时间戳。
2. 运行（T0 绝不触发；命中 T1–T4 时显式声明召回范围，作为「读前判断」的代码锚点）：powershell -ExecutionPolicy Bypass -File "%USERPROFILE%\.codex\projects\codex-memory-system\sync-memory.ps1" -Pull -Access <NONE|IDENTITY|PREFERENCE|PROJECT|HISTORY|CONSTRAINT|MULTI>
   - `-Access NONE` 会让脚本直接跳过 pull（防 T0 误读）；缺省不传仍兼容旧流程，但建议显式传入以便审计。
3. -Pull 输出提示「could not auto-write / pending write-back」时，用 apply_patch 把仓库 memory 目录较新文件写回 %USERPROFILE%\Documents\Codex\memory 对应文件，再重跑 -Pull 清除标记；无更新则直接读取。

缓存语义：本地镜像只是 Cache，仓库是唯一事实源。读前 pull 即版本校验（cache.version == store.version），不一致必须重取。

**版本真值核对（硬性 check-list，任何「最新版 / 当前实现 / 评估现状 / 审计」类任务强制执行，不靠自觉）**：
1. 第一步（动手前，只读、不等写操作）：`git ls-remote origin main` 取远端真实 HEAD，与本地 `git rev-parse HEAD` 比对。
2. 本地 HEAD ≠ 远端时，先 `fetch + merge（非 rebase）` 对齐，再读任何文件；未对齐前，本地任何文件内容不得作为「当前实现」的依据。
3. 版本号以仓库根 `VERSION` 文件 + `git tag` 为准（带外真值源）；不得仅凭文档头部自述版本号判定——文件名无版本号、版本号写在正文里时尤其如此。
4. 「local ≠ remote」的任何已知证据都是全局红旗，必须当场处理，不得当作孤立 bug 略过。

> ⚠️ **机制性质（防跑偏）**：版本真值核对是**触发式**——仅当请求命中 T1–T4 或属「最新版 / 评估现状 / 审计 / 提基线」类时，才在**读前**执行；**禁止定时任务 / 启动加载 / 调度自动化**等任何周期形态（版本真值核对 = 触发式、禁自动化；doctor conform 探针以「版本真值核对 / 触发式 / 禁自动化」三要素为判据）。依据：基线 Phase 6 已删「Session Start 全量 Load」、Phase 12 已废除强制启动加载/强制结束上传；版本对齐归属第十二节 Cache 与失效机制的「读前 pull + ls-remote 比对」，不另设独立周期任务。任何端点新增版本核对流程前须先读本最新基线，不得自创自动化。
> **doctor 红旗 = 阻断态（残留边界收窄）**：doctor 的「消费端 conform 触发式禁令」探针 FAIL（各端只检本端：WorkBuddy 检 `~/.workbuddy/MEMORY.md`、Codex 检 `~/.codex/AGENTS.md`、DSH 检 `~/.dsh/AGENTS.md`——ps1 `-Doctor` 检 Codex 钩子；py 检本端消费记忆，路径经 sync.config.json `consumer_memory_path` 参数化，DSH 端指向 `~/.dsh/AGENTS.md`），或本地与远端**真分叉** / 远端不可达，一律视为未对齐本加固——**不得据此读 canon 当依据、不得 push**，须先补声明（本端消费记忆含「版本真值核对/触发式/禁自动化」）或 re-pull 修红后再继续。沙盒 overlay 导致的 tracking ref 丢失属**自愈项**（doctor 自动补写并报 AUTO-HEALED，不计失败），不构成阻断态。

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
- 删除传播护栏：同步前按 `memory/index.json` 的 `files` 清单校验各文件存在且非空；不足则拒绝同步并写 `.sync-failed`，绝不把近空目录推成空仓（vNext-1.3 起护栏不再硬编码文件数）。
- 并发互斥：双端脚本入口有 `.sync.lock` 跨进程锁（按 PID 判活），同机并发 pull/push 会被拒绝而非交错，防 torn copy。
- 密钥扫描：提交前对 memory/*.md 做凭据样值扫描（ghp_/gho_/github_pat_/AKIA/私钥头/Bearer 长值），命中即拒绝同步并写 `.sync-failed`，防令牌入 git 历史。
- 脚本/文档提交：修改本仓库的脚本 / 文档 / 测试后，Codex 端收尾必须运行 `sync-memory.ps1 -CommitRepo`（提交并推送全部变更，不留未提交）；WorkBuddy 端在 push 前由使用方以「AI名@机器名」身份 commit 脚本/文档变更。绝不把脚本/文档变更长期留在工作树。
- 自主执行边界（默认直接做，不问）：对无风险、可逆、在任务范围内的合理操作——git commit/push、文件对齐/重命名+同步全部引用、补回归测试、清理临时文件、修复已列明的问题清单（如 R1–R4 这类已确认待办）、加带外指针/护栏/check-list、跑验证并闭环——一律**直接执行到底，不得以「要不要我顺手做 X」之类反问收尾**；任务未完成不要中断，做完才停。仅在破坏性/不可逆（rm -rf、force push、reset、删除记忆）、越出任务范围、或需外部授权/凭据时才停下确认。
- 核验统一：push/pull 后核验一律用 `merge-base --is-ancestor`（祖先判定），不用 `==` 比较；并发下本地落后于远端属正常（安全），仅真分叉才视为失败。

## 六、跨端协同纪律

- 身份：每端以「AI名@机器名」作为 git 作者提交（Codex 脚本自动；手动端用 git -c user.name="AI名@机器名" commit），commit message 带 [身份] 与变更文件，便于追溯与冲突仲裁。**合并提交同样适用**（GAP-2-4）：执行 merge 的一端必须带本端身份（`git -c user.name="AI名@机器名" merge --no-edit FETCH_HEAD` 或确认仓库级 user.name 已设为本端身份），不得出现无端身份的合并作者——历史 `d436de8` 作者=push 属身份越轨，不得复现。
- 文件分区：归档.md 为追加类（union 自动合并，仅 `git merge` 生效）；状态.md / 待办.md 为改写类（改前立即 merge，冲突保留两端语义、绝不单方面覆盖）；决策.md / 画像.md 多为追加、偶发改写（默认合并，冲突语义合并）。收敛统一 `git merge`（非 rebase）。
- 每机一份 gitignored 的 sync.config.ps1（身份/代理/记忆目录/提交身份）；新机器先跑 sync-memory.ps1 -Doctor 自检（须全 PASS、conform 探针不得 FAIL）再接入；doctor 任一红旗 = 阻断态，未修红不得读 canon / 不得 push。

## 七、Memory Engine（vNext-2.0，位于同步层之上）

- 组成：`memory.py`（CLI）、`migrate-memory.py`（迁移）、`memory_engine/`（Schema/Lifecycle/Write Engine/Recall Engine/Temporal/Conflict/Consolidation/Procedural/Object Index/Audit/Doctor）、`adapters/`（MemoryAdapter 统一接口）。
- 双写：Markdown 五文件继续作为 legacy canonical（L1–L6 映射不变）；结构化记忆以 `memory/objects/*.json` 为对象层（Schema v1，Object 是事实源；`memory/object-index.json` 是派生索引，不一致时 Object 优先，可 `python memory.py rebuild-index` 重建）。第一阶段 = Object + Markdown 双写。
- 写入纪律：新信息默认 candidate（T4「记住」/ explicit → active）；重复 → NO_CHANGE 零副作用；细化 → UPDATE；明确改变 → SUPERSEDE（旧不删除，记录 supersedes/superseded_by 与 valid_until）；否决 → constraint/negative_preference 并与实体关联；inferred 绝不覆盖 explicit/observed；DELETE = 归档不物理删除。
- 召回纪律：T0 零读取；T1→L1、T2→L3、T3→L3 light；`python memory.py recall "query" --tier T2 [--history]` 输出 Markdown 段级计划 + 对象结果；历史查询（--history）才返回 superseded/archived/expired。禁止因引擎存在而全量加载对象。
- 引擎体检：`python memory.py doctor [--fix]`（17 项检查，FAIL → exit 1）；同步层体检仍为 `python sync-memory.py doctor`（阻断态判定不变），二者互补。
- 同步边界：Memory Engine 不执行 git commit/push；对象/索引/审计变更后按既有纪律 commit（身份 `DSH@TURING`）→ `python sync-memory.py push`，护栏照旧。
- 迁移：`python migrate-memory.py --dry-run` → 审查 → `--migrate`（幂等）→ 回滚用 `--rollback`；不能确定的行一律 candidate + manual-review，绝不把推测自动升级成事实。
- 实施冲突记录：`vNext-2.0-实施冲突记录.md`（C1–C9）；测试：`python tests/test_acceptance.py`（v1.3 回归 70 项）+ `python tests/test_memory_v2.py`（v2.0 引擎 55 项）。
