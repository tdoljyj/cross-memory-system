# Cross-Memory-System · 跨端记忆系统

> **规范依据**：本仓库《架构基线文档-vNext-2.0.md》（当前基线版本 **vNext-2.0**，2026-08-17 确立）。历史基线《架构基线文档-vNext-1.3.md》（2026-08-16 封版）保留为历史文档。适用范围：本仓库全部文件、Codex 端（`~/.codex/AGENTS.md` + sync-memory.ps1）、WorkBuddy 端（`~/.workbuddy/MEMORY.md` + sync-memory.py）、DSH 端（`~/.dsh/AGENTS.md` + sync-memory.py + Memory Engine）及未来新接入端。本 README 与基线冲突时以基线为准；变更记录见 v2.0 基线文档。

私有仓库：完整版配置手册 + 数据包快照 + **跨端记忆协同机制**（2026-08-15 建立并更名）。

## 定位
一个 git 私有仓库作为**唯一数据源**（基线术语：**Canonical Memory Store**），多台机器、多个 AI 助手各自持有工作区镜像（基线术语：**AI Adapter / Cache**），通过仓库互相共享记忆。设计目标不是单机双端，而是**任意机器 × 任意 AI** 的跨端共享：各端从不直写对方工作区（Adapter 不互相同步，只与 Canonical Store 同步，基线 P0-3/P0-4），一切经仓库收敛；每个提交都带 `AI名@机器名` 身份，可追溯到谁、在哪台机器、改了什么。

**访问策略（基线 vNext）**：默认 NO MEMORY——由 Memory Router 按 T0–T4 判断个人相关性，命中才最小召回（L1–L6 文件映射）；本轮产生记忆变更才写入上传（NO_CHANGE → NO_WRITE → NO_SYNC）。详见 AGENTS.md v3 与基线文档。

当前接入方：

| 接入方 | 工作区 | 读写方式 |
|---|---|---|
| Codex | `Documents\Codex\memory\` | `sync-memory.ps1`（收尾 push / 开场 `-Pull` / 接入 `-Doctor` 自检），代理优先 127.0.0.1:7897（固定 `http.sslBackend=openssl`）、直连兜底 |
| WorkBuddy | `~/.workbuddy/codex-memory-system\`（独立克隆） | 开场 `python sync-memory.py pull` 读；写入前 `fetch + merge` → 修改 → push；不直写 Codex 侧工作区 |
| DSH（DeepSeek Harness） | `~/.dsh/projects/cross-memory-system\`（独立克隆，自远端 origin 克隆）+ `~/.dsh/MEMORY.md` 消费端 + `~/.dsh/AGENTS.md` 用户全局钩子（DSH 每会话自动注入，任意工作区生效） | 开场 `python sync-memory.py pull` 读；写入 commit（身份 `DSH@TURING`）→ `python sync-memory.py push`；不读写任何他端克隆（不越界） |
| 未来其他 AI | 各自工作区（独立克隆，**不复用/不克隆任何本地已有克隆**） | 同 WorkBuddy：克隆 → fetch + merge → 改 → push；不直写任何既有工作区 |

## 跨端协同机制
1. **身份与审计**：每端以 `AI名@机器名`（如 `Codex@DESKTOP-X`）作为 git 作者提交，commit message 带 `[身份]` 前缀与变更文件清单；`git log --format='%an %s'` 即可看到谁在哪台机器改了什么。
2. **并发冲突分层**：追加类文件（`归档.md`）配 `merge=union`，两端同时追加自动保留、无需人工；改写类文件（`状态.md` / `待办.md`）靠「改前立即 merge + 小步提交 + 语义合并」，冲突时保留两端语义、绝不单方面覆盖。⚠️ union 自动合并仅 `git merge` 生效（每机需 `git config merge.union.driver 'git merge-file --union %A %O %B'`），**禁止与 rebase 混用**（rebase + union driver 会静默丢单边内容）。
3. **跨机可移植**：每机一份 gitignored 的 `sync.config.ps1`（身份 / 代理 / 记忆目录 / 提交身份），脚本无此文件时回落本机默认；换机器、换 OS（需 pwsh）只改这一个文件。
4. **接入自检**：新机器跑 `powershell -ExecutionPolicy Bypass -File sync-memory.ps1 -Doctor`，一次检查 git、网络与凭据、引用写入（沙盒 overlay 拦截，2026-08-16 实锤非 PortableGit 缺陷）、换行符配置、记忆目录，全部 PASS 才正式接入。

## 内容
- `架构基线文档-vNext-2.0.md` — **vNext-2.0 架构规范（Memory Engine Architecture）**，当前基线
- `架构基线文档-vNext-1.3.md` — vNext-1.3 历史基线（2026-08-16 封版，保留）
- `vNext-2.0-实施冲突记录.md` — 执行计划与仓库现状冲突的逐项裁决（C1–C9）
- `附录/Cross_Memory_System_vNext_核心架构.html` — 基线源文件原件（Chase 提供）
- `配置手册与数据包-v4.md` — 完整手册：记忆机制、写入权限、新电脑配置步骤（⚠️ 其中 9.x 数据包为 2026-08-15 历史快照，AGENTS / 待办等内容可能已过期；权威以仓库当前 `架构基线文档-vNext-2.0.md`、`AGENTS.md` 与 `memory/*.md` 为准）
- `memory/` — 记忆快照（画像 / 状态 / 决策 / 待办 / 归档）+ `memory/index.json`（L1–L6 → 文件+标题段的召回索引，也是同步护栏的必需文件集唯一事实源）+ `memory/objects/`（Memory Object 层，v2.0）+ `memory/object-index.json`（派生索引）+ `memory/audit/`（审计日志）
- `memory_engine/` — vNext-2.0 Memory Engine（Schema / Lifecycle / Write / Recall / Temporal / Conflict / Consolidation / Procedural / Index / Audit / Doctor）
- `memory.py` — Memory Engine CLI（status / doctor / recall / add / update / supersede / consolidate / procedural / rebuild-index / migrate / delete / reject / audit）
- `migrate-memory.py` — Markdown → Object 迁移（--dry-run / --validate / --migrate / --rollback，幂等）
- `adapters/` — 统一 Adapter 接口（MemoryAdapter；当前 CLIAdapter，未来 ChatGPT/Claude/Cursor 走同一接口）
- `AGENTS.md` — Codex 全局钩子副本（当前 v4.0，对齐基线 T0–T4 / L1–L6 术语与段级召回 + v2.0 Memory Engine 章节；实际生效位置：`~/.codex/AGENTS.md`）
- `sync-memory.ps1` — Codex 侧记忆同步脚本：复制最新记忆 → git 提交 → 推送
- `sync-memory.py` — WorkBuddy / DSH 侧记忆同步脚本（四模式 pull / push / doctor / bootstrap；vNext-1.3 稳定基线，v2.0 未改动）

## 写入纪律（所有接入方必须遵守）
1. **带身份提交**：每端以 `AI名@机器名` 作为 git 作者（Codex 脚本自动；手动客户端用 `git -c user.name="AI名@机器名" commit`）；commit message 带 `[身份]` 与变更文件
2. **改前先拉**：`git fetch` + `git merge --no-edit FETCH_HEAD`（非 rebase），永远基于最新版修改；push 被拒 → 再 merge → 解决冲突 → 重推
3. **冲突合并**：文本冲突时保留两端内容做语义合并，绝不单方面覆盖；**绝不 force push / reset / 以本地覆盖远端**。`归档.md` 为追加类文件（union 自动合并，仅 merge 生效），`状态.md` / `待办.md` 为改写类文件（冲突需语义合并）。收敛统一用 `git merge`（非 rebase）
4. **已否决不复活**：`决策.md` 已否决项绝不重复推荐；修改时尊重 Codex 的格式与作者立场
5. **双端对称「不越界」**：任何一端不直写对方工作区或克隆（Codex 不写 `~/.workbuddy`，WorkBuddy 不写 `Documents\Codex\memory`）；一切写入经仓库交换，各自工作区由各端自管。分叉属正常，靠 merge 收敛
6. **字节级一致**：语义相同的内容必须字节级一致（LF / 无 BOM，`.gitattributes` 锁定），避免互相重写
7. **只沉淀稳定长期信息**：不写流水账、一次性临时信息

## 新电脑接入（一次性）

> 本仓库为「任意机器 × 任意 AI」跨端共享（见「定位」）：接入流程 = **通用步骤** + **端侧差异**。通用步骤对所有接入方一致；当前已登记 Codex、WorkBuddy、DSH 三端，未来新端照此模式登记（各端独立克隆，绝不复用/克隆任何本地已有克隆）。任一步失败先看「失败排查」；doctor 任一 FAIL 未修红前视为阻断态，不得据此读 canon 当依据、不得 push（AGENTS v3.1）。

### 通用步骤（所有接入方）

1. **安装 GitHub CLI 并登录同一账号**：`gh auth login`。git 侧凭据统一走 gh 生成的 git credential helper（`git config --show-origin --get credential.helper` 应指向 gh 的 `auth git-credential`，而非 git-credential-manager）；**不要**把 `gho_`/`ghp_` 长期令牌 `setx` 进用户环境变量（常驻令牌会被任意本机进程读取）。两脚本的 doctor 都会对 `GITHUB_PAT_TOKEN` / `GH_TOKEN` 给出 WARN，并对输出做令牌掩码。
2. **克隆私有仓库 `tdoljyj/cross-memory-system` 到本端工作区**（路径按端侧差异表；本端绝不克隆到对方工作区，也不直写对方克隆）。克隆后先做**版本真值核对**：取 `git ls-remote origin main` 输出首列 hash（`git ls-remote origin main | cut -f1`）与 `git rev-parse HEAD` 比对，一致再继续——此步只验证 clone 动作本身正确并建立基线（刚克隆的 HEAD 天然等于远端，不防后续漂移，后续漂移由每次读前对齐兜底）；版本号以仓库根 `VERSION` 文件 + git tag 为准（AGENTS v3.1 硬性 check-list）。
   > tag 语义：tag 只随版本 bump 移动，doc-only 变更不移动 tag；HEAD 领先 tag 属正常，以 `ls-remote` / `rev-parse HEAD` 比对为准。
3. **建立本机配置**（gitignored，各端格式见下表；脚本缺省回落内置默认，换机器只改这一个文件）。
4. **写入推荐 git 配置**（两脚本均提供 bootstrap，写入内容一致）：
   - `core.autocrlf=false`（配合 `.gitattributes` 的 `eol=lf`，换行符字节级一致，防互相重写）
   - `merge.union.driver = "git merge-file --union %A %O %B"`（归档.md 并发追加自动合并的必需驱动；须配合 `.gitattributes` 的 `memory/归档.md merge=union` 标注才生效，只配 driver 或只配 attributes 都是 no-op；仅 `git merge` 生效，**禁止 rebase**）
   - `maintenance.auto=false` / `fetch.autoMaintenance=false`（关后台自动维护，防沙盒下 ref 重写）/ `gc.pruneExpire=2.weeks`（不设 `gc.auto`，用 git 默认阈值 6700，小仓库几乎不触发自动 gc，需要时手动 `git gc`）
5. **跑 doctor 自检**（命令见下表）：覆盖 git 可用性与客户端安全（拒绝 git 可执行文件位于 PortableGit / `.workbuddy` 目录）、远端可达与凭据、tracking ref、ref 写入持久性、`core.autocrlf`、`.gitattributes`、union 驱动、残留标记、记忆目录健康（按 `memory/index.json` 的 files 清单，文件缺失或为空即 FAIL，防推空仓）、全局钩子一致性（Codex 侧 ps1 -Doctor 检查 `~/.codex/AGENTS.md` 与仓库 AGENTS.md 哈希一致，漂移=FAIL、缺失=WARN）、index.json 召回段名有效（双端 doctor）、本地与远端版本对齐、消费端 conform 探针。**全部 PASS 才正式接入**。
6. **准备消费端 + 新会话验证**：按端侧差异表完成消费端配置。新会话按 Memory Router 命中执行读前对齐（Codex：`-Pull`；WorkBuddy：`python sync-memory.py pull`），问「我是谁」能直接接上即通过；再让 AI 修改记忆文件一行并完成一次提交推送，`git log` 应出现 `AI名@机器名` 身份的新 commit。

### 端侧差异（Codex / WorkBuddy / DSH）

| 项 | Codex | WorkBuddy | DSH |
|---|---|---|---|
| 克隆位置 | `~/.codex/projects/codex-memory-system`（`gh repo clone tdoljyj/cross-memory-system` + 该路径） | `~/.workbuddy/codex-memory-system`（`gh repo clone tdoljyj/cross-memory-system` + 该路径，目录名固定，remote 指向本仓库） | `~/.dsh/projects/cross-memory-system`（`gh repo clone tdoljyj/cross-memory-system` + 该路径，**自远端 origin 克隆，绝不复用/克隆任何本地已有克隆**） |
| 同步脚本 | `sync-memory.ps1`（默认 push；`-Pull` 读前对齐 / `-Doctor` / `-Bootstrap` / `-CommitRepo` 提交脚本文档） | `sync-memory.py`（四模式 `pull` / `push` / `doctor` / `bootstrap`） | `sync-memory.py`（四模式 `pull` / `push` / `doctor` / `bootstrap`；commit 由使用方以 `DSH@TURING` 身份执行后 push） |
| 记忆工作区 | `Documents\Codex\memory\`：克隆后把 `memory\` 内 `memory/index.json` 声明的文件复制过去 | 克隆内 `memory\` 即工作区，无需复制 | 克隆内 `memory\` 即工作区，无需复制（同 WorkBuddy） |
| 消费端钩子 | 写全局钩子 `~/.codex/AGENTS.md`（用仓库内 AGENTS.md 内容，路径里 `<用户名>` 换成实际用户名） | WorkBuddy 系统注入 `~/.workbuddy/MEMORY.md`，无需手动 | 用户全局钩子 `~/.dsh/AGENTS.md`（DSH 每会话自动注入、任意工作区生效）；`~/.dsh/MEMORY.md` 为权威协议文件 |
| 本机配置 | `sync.config.ps1`（gitignored）：`$AgentName` / `$ProxyUrl`（默认 `http://127.0.0.1:7897`，无代理 `""`）/ `$MemoryDir` / `$GitEmail` | `sync.config.json`（gitignored）：`{repo, proxy, proxy_host, proxy_port, git_candidates}` | `sync.config.json`（gitignored）：`{repo, proxy, proxy_host, proxy_port, git_candidates, consumer_memory_path}`（`consumer_memory_path` 指向 `~/.dsh/AGENTS.md`） |
| 自检命令 | `powershell -ExecutionPolicy Bypass -File ...\sync-memory.ps1 -Doctor` | `python ...\sync-memory.py doctor` | `python ...\sync-memory.py doctor` |
| 权限要求 | Codex 桌面版启用 Full access（见配置手册第五节；`apply_patch` 写 `~/.codex` 与记忆目录必需） | 不依赖 Full access（WorkBuddy 侧 Full access 每会话临时、不可持久，2026-08-16 起弃用）：读/pull 沙盒内即可完成（Python 直写 ref 兜底）；仅 git 写操作（push）需逐次非沙盒执行（`dangerouslyDisableSandbox=true`），判据=输出尾 `⚠️ Sandbox bypassed` | 同 WorkBuddy（py 脚本）；仅 git 写操作（push）需非沙盒执行 |
| git 客户端 | 系统 git；ps1 内置部署护栏拒绝在 `~/.workbuddy` 镜像内运行，也拒绝 PortableGit / `.workbuddy` 路径的 git | 官方 Git for Windows 优先（`C:\Program Files\Git`，py 自动探测）；勿用 WorkBuddy 内置 PortableGit（代理 TLS 握手失败） | 官方 Git for Windows 优先（py 自动探测，`git_candidates` 可覆盖）；勿用 PortableGit |
| 网络策略 | 代理优先 `http://127.0.0.1:7897`、固定 `http.sslBackend=openssl`，直连兜底 | 代理优先级 config > 环境变量（`HTTPS_PROXY`/`HTTP_PROXY`）> 默认 `http://127.0.0.1:7897`；沙盒内 raw TCP 直连被拦，git 必须走代理；pull/push 前先探测代理存活，不可达 3 秒内快速失败 | 同 WorkBuddy（代理优先级 config > 环境变量 > 默认 7897；pull/push 前探测代理存活，3 秒快速失败） |

> Codex 可选：GitHub MCP（`~/.codex/config.toml` 的 `[mcp_servers.github]`）与记忆同步无关，如启用，bearer 令牌用最小权限并避免重复写环境变量。WorkBuddy 侧不经过 Codex MCP。

### 失败排查

- **doctor：`remote reachable + credential` FAIL** → 先 `gh auth status` 确认已登录；再确认代理已启动（默认 7897）；`git config --show-origin --get-all credential.helper` 应指向 gh 的 `auth git-credential`，而非 `GITHUB_PAT_TOKEN`/`GH_TOKEN` 环境变量（doctor 会 WARN）。
- **doctor：`tracking ref` FAIL** → WorkBuddy 侧多为沙盒 overlay 拦两层 ref 原子写（exit 0 静默失败），doctor 会自动补写并报 AUTO-HEALED（不计失败）；补写仍失败或报真分叉时，手动 `git fetch origin main && git merge --no-edit FETCH_HEAD`（非 rebase）后再跑。
- **doctor：`merge.union.driver` / `core.autocrlf` FAIL** → 未跑 bootstrap 或配置被覆盖，重跑 `-Bootstrap`（ps1）或 `bootstrap`（py）。
- **doctor：`git client safe` FAIL** → git 来自 PortableGit 或 `.workbuddy` 路径：Codex 侧换系统 git（ps1 会拒绝同步）；WorkBuddy 侧改 `sync.config.json` 的 `git_candidates` 指向官方 Git for Windows。
- **doctor：`memory dir healthy` FAIL** → 按 `memory/index.json` 的 files 清单，每个文件必须存在且非空：Codex 侧确认已复制完整；WorkBuddy 侧确认克隆内 `memory\` 完好（防把近空目录推成空仓）。
- **doctor：`local == remote` 标红「本地落后远端」** → 读前必须 re-pull（`-Pull` / `python sync-memory.py pull`），否则结论不可信；标红「分叉」→ 手动语义合并（保留两端内容）后再收敛，**绝不 force push / reset / 以本地覆盖远端**。
- **`.sync-failed` / `.pending-writeback` 残留** → 上次同步失败或待写回标记：先读标记文件内容定位原因，修复后重跑同步自动清除；`-Pull` 提示 pending write-back 时用 apply_patch 把仓库较新文件写回 Codex 工作区再重跑。
- **doctor：`global hook matches repo AGENTS.md` FAIL** → Codex 侧全局钩子与仓库 AGENTS.md 不一致（协议执行层落后）：复制仓库 `AGENTS.md` 到 `~/.codex/AGENTS.md` 后重跑；钩子缺失为 WARN（新机按接入步骤准备消费端即可）。
- **push 被拒（non-fast-forward）** → 远端有新提交：`git fetch` + `git merge --no-edit FETCH_HEAD`，归档.md 由 union 驱动自动合并、其余文件语义合并，解决后重推。
- **push 后 `git status` 显示 ahead/gone** → 沙盒 overlay 不写 tracking ref 所致（cosmetic）：以 `git ls-remote origin main` 为准，或跑 doctor 自愈补写；真伪以 `merge-base --is-ancestor` 判定。
- **WorkBuddy 侧 `[代理 ...] 不可达`** → 代理未启动：启动后重试，或改 `sync.config.json` 的 `proxy`；沙盒内 raw TCP 直连被拦，git 不可绕代理直连。
- **`.sync.lock` 并发锁冲突** → 同机已有另一同步在跑，等其结束重试（拒绝而非交错，防 torn copy）。
- **密钥扫描拦截（同步被拒并写 `.sync-failed`）** → 提交前命中 `ghp_`/`gho_`/`github_pat_`/`AKIA`/私钥头/Bearer 长值：清理记忆文件中的令牌样值后再同步（模式见 `guards.json`）。
- **ps1 在 WorkBuddy 镜像内运行被硬阻断** → `[deploy-guard] refusing to run inside a .workbuddy mirror`：sync-memory.ps1 只应在 Codex 侧克隆（`~/.codex/projects/...`）运行，WorkBuddy 侧用 `sync-memory.py`，脚本与工作区不可互换。

## 卸载 / 停用（一次性）

> 本系统**不安装任何定时任务、开机自启或系统服务**（对齐基线：触发式、禁自动化），卸载无需清理计划任务。系统的全部落点 = 每端一个克隆 + 消费端钩子 + 每端一个 gitignored 配置。**Canonical Memory Store（远端仓库）始终持有全部记忆**：卸载本机只移除本端缓存与钩子，远端数据不动；只有主动删除远端仓库才会真正抹掉所有端的共享记忆。

### 方案 A：仅停用（保留数据，可随时恢复）
1. 删除本端消费端钩子（解除每会话注入，AI 不再读写记忆）：
   - Codex：删除 `~/.codex/AGENTS.md`（`Documents\Codex\memory\` 数据副本可留可删）
   - WorkBuddy：删除 `~/.workbuddy/MEMORY.md`
   - DSH：删除 `~/.dsh/AGENTS.md` 与 `~/.dsh/MEMORY.md`
2. 克隆、配置文件、远端全部保留；新会话即不再触发记忆读写。恢复 = 按「新电脑接入」重建消费端钩子即可。

### 方案 B：完整卸载（本机彻底移除）
1. **先归档（必做）**：在本端克隆执行 `git fetch` + `git merge --no-edit FETCH_HEAD`（非 rebase）→ `python sync-memory.py push`（Codex 用 `sync-memory.ps1`）→ `git ls-remote origin main` 与本地 HEAD 比对，确认远端已收齐；如需离线备份，`git clone --mirror` 到备份路径或直接打包克隆目录。
2. 按方案 A 删除本端消费端钩子；可选删除 Codex 侧 `Documents\Codex\memory\`。
3. 删除本端 gitignored 配置：`sync.config.ps1`（Codex）/ `sync.config.json`（WorkBuddy、DSH，含 `consumer_memory_path`）。
4. 删除本端克隆目录：`~/.codex/projects/codex-memory-system` / `~/.workbuddy/codex-memory-system` / `~/.dsh/projects/cross-memory-system`。bootstrap 写入的推荐 git 配置（`core.autocrlf` / `merge.union.driver` / `maintenance.auto` / `fetch.autoMaintenance` / `gc.pruneExpire`）为**克隆级（local scope）**，随目录删除自然消失；仅当你曾手动用 `--global` 写过时才需 `git config --global --unset` 逐项还原。
5. 清理凭据（可选）：`gh auth status` 确认；不再用则 `gh auth logout`（同账号其它 GitHub 操作会一并失效），并移除 git credential helper 中的 gh 条目。Codex 如启用过 GitHub MCP，按需移除 `~/.codex/config.toml` 的 `[mcp_servers.github]`（与记忆同步无关，纯可选）。
6. 清理远端（可选，**不可逆**）：GitHub 仓库设置 → Danger Zone → Delete this repository 会**永久删除所有端的共享记忆且不可恢复**——仅在所有端均已停用、且完成归档/备份后执行；想保留数据可改为 Private 或转移所有权。

### 核验
- 新会话不再注入记忆钩子（Codex / DSH 的 `AGENTS.md` 已消失，WorkBuddy 无 `MEMORY.md`）；
- 克隆目录与配置文件均不存在；
- 删除远端前：`git ls-remote origin main` 输出与归档时 HEAD 一致。

## Codex 同步（按需触发，对齐基线 vNext-1.3）
- 钩子指令（AGENTS.md v3.1）：Memory Router 判定本轮产生记忆写入后才运行：`powershell -ExecutionPolicy Bypass -File ~/.codex/projects/codex-memory-system/sync-memory.ps1`
- 脚本自动：复制最新记忆 → git 提交（无变化则 skip commit）→ 推送；远端有新提交时先拉取再推
- NO_CHANGE 时不产生任何 commit / push / 缓存失效（基线原则 8）
- 删除传播护栏：同步前校验 `memory/index.json` 声明的必需文件齐全非空，不足则拒绝同步并写 `.sync-failed`，防推空仓；同步只处理 index 声明的文件——工作区/仓库中的非 index `.md` 不复制、不删除、不提交（防越界提交与静默丢失）
- 加固（vNext-1.2）：检测到 PortableGit / `.workbuddy` 的 git 客户端时拒绝同步；同步前清理过期 TEMP 备份目录；全仓有未提交的非 memory 变更时给出警告（脚本只提交 memory）；`-Doctor` 会提示归档.md 超瘦身阈值
- 加固（vNext-1.3）：同步入口 `.sync.lock` 跨进程锁（同机并发 pull/push 拒绝而非交错）；提交前密钥扫描（ghp_/gho_/github_pat_/AKIA/私钥头/Bearer 长值命中即拒绝）；pull 支持 `-Access <scope>`（`NONE` 直接跳过）；`-Doctor` 校验凭据来源是否走 gh 助手
- 编码约束（2026-08-17 P0 修复）：`sync-memory.ps1` 必须保留 UTF-8 BOM——Windows PowerShell 5.1 将无 BOM 的 UTF-8 按 ANSI（zh-CN=GBK）解析，中文注释会吞换行导致整脚本解析失败；任何保存/编辑不得剥离 BOM（`tests/test_acceptance.py` 有回归断言）
- 脚本/文档提交：修改 sync 脚本/文档/测试后，运行 `powershell -ExecutionPolicy Bypass -File sync-memory.ps1 -CommitRepo` 提交并推送全部变更（普通记忆同步只提交 `memory/*.md`，不代提交脚本/文档）
- 想手动同步：在 PowerShell 里直接运行上面的命令

## WorkBuddy 接入要点
- 独立副本：`~/.workbuddy/codex-memory-system\`（目录名固定，remote 指向本仓库；已配 gh 凭据助手）
- 提交身份：`git config user.name "WorkBuddy@<机器名>"`（email 保持账号邮箱），commit message 带 `[身份]` 与变更文件；其余与本仓相同
- ⚠️ 连接策略（2026-08-15 21:28 复测修正 + 2026-08-16 更新）：WorkBuddy 沙箱内 **raw TCP 直连外网被拦**（`Connection was reset`），出网仅代理路径（见配置手册 5.3 权限矩阵）；因此 **WorkBuddy 侧 git 操作一律走代理**：`git -c http.proxy=http://127.0.0.1:7897 fetch/pull/push`。git 客户端优先**官方 Git for Windows**（`C:\Program Files\Git`，本机已装 2.55.0.3，sync-memory.py 自动优先）；**勿用 WorkBuddy 内置 PortableGit**（走代理 TLS 握手失败：schannel `failed to receive handshake` / openssl `unexpected eof`）。gh 凭据助手正常供 token。curl / gh CLI 走代理均正常
- ⚠️ TLS 后端（2026-08-15 21:32 复测补充）：Git Bash 自带 git + 代理时 schannel 默认后端仍**偶发**握手失败（`schannel: failed to receive handshake`）；命令固定加 `-c http.sslBackend=openssl`（对直连/代理均无副作用）
- **同步脚本 `sync-memory.py`**（Python 版，WorkBuddy 侧专用，2026-08-16 起）：WorkBuddy 沙盒 overlay 会拦截 git 写 tracking ref（`refs/remotes/origin/main` 两层目录，lockfile+rename 原子写 exit 0 静默失败），脚本策略=git 负责对象传输、Python 负责 ref 兜底写入；四模式 `pull` / `push` / `doctor` / `bootstrap`，用法见脚本头注释
- **配置参数化（vNext-1.2）**：`sync-memory.py` 支持与脚本同目录、gitignored 的 `sync.config.json`（`{repo, proxy, proxy_host, proxy_port, git_candidates}`），缺省回落内置默认；换机器只改这一个文件
- **按需触发**（对齐基线 vNext-1.3 / AGENTS v3.1）：Memory Router 命中 T1–T4 才执行 `python sync-memory.py pull`（自动 fetch + 对齐 + 补写 tracking ref + 核验）→ 按 L1–L6 映射读所需文件；T0 通用问题直接回答，不访问记忆
- 写入上传：本轮产生记忆写入 + commit 后才 `python sync-memory.py push`（非沙盒执行，判据=输出尾 `⚠️ Sandbox bypassed`）；无写入不 push（NO_CHANGE → NO_SYNC）；**不直写 Codex 侧工作区**（`Documents\Codex\memory\` 由 Codex 自己同步）
- 删除传播护栏：pull/push 前校验 `memory/index.json` 声明的必需文件齐全非空，不足则拒绝并写 `.sync-failed`，防推空仓
- 代理预检：`pull` 与 `push` 均先探测代理存活，代理不可达时 3 秒内快速失败而非让 git 卡 60 秒超时
- git 写操作必须非沙盒执行（dangerouslyDisableSandbox=true），判据=输出末尾 `⚠️ Sandbox bypassed`；push 后用 `git ls-remote origin main` 确认远端 commit；push/pull 后核验统一用 `merge-base --is-ancestor`（祖先判定），并发下本地落后远端不误报

## 验收测试（附录 B 自动化）

`tests/test_acceptance.py` 把基线第十八节 / 附录 B 中可代码验证的验收标准自动化（纯标准库、无第三方依赖）：

    python tests/test_acceptance.py

覆盖：段级召回映射一致性（B/C）、无变化不写不推（E）、有变化提交推送（D）、并发合并不丢（F）、幂等（G）、同步失败标记 + 重试（H）、pull 版本校验（I）、删除传播护栏（P0 回归）。B/C 的 Router 判定属 AI 自然语言行为，脚本层只验证其「段级召回映射正确性」这一可判定不变量。

**Memory Engine 验收测试（vNext-2.0）**：

    python tests/test_memory_v2.py

覆盖执行计划 §21（A–Z：Schema/创建/去重/更新/推翻/冲突/时间有效性/active 过滤/历史召回/负向偏好/候选拒绝/巩固/程序性记忆/scope/索引重建/orphan/broken relation/Markdown 兼容/T0 零读取/T1 最小召回/T2 项目召回/T3 light/T4 立即写/NO_CHANGE 零副作用/superseded 永不赢得当前召回）与 §28 最终验收。运行前无需网络（沙盒本地文件仓库）；两套合计 125 项必须全绿。

> 注意：本仓库含个人真实记忆数据，保持私有；如要公开，只发布去敏模板版。

## Memory Engine 快速上手（vNext-2.0）

    python memory.py doctor            # 引擎体检（17 项，FAIL → exit 1）
    python memory.py status            # 对象库统计
    python memory.py recall "我现在用什么引擎" --tier T2   # 确定性召回（--history 看历史）
    python memory.py add --content "用户偏好高信息密度" --category preference --evidence explicit
    python memory.py update --id mem_xxx --content "同对象细化内容"
    python memory.py supersede --id mem_xxx --content "用户明确改变后的新值"
    python memory.py consolidate --from mem_a,mem_b --content "巩固后的语义结论" --confirm
    python memory.py procedural --content "GroundMate 必须兼容 Maya 2020.4–2026" --category toolchain
    python memory.py rebuild-index    # 重建派生索引（Object 优先）
    python migrate-memory.py --dry-run   # 迁移先 dry-run；--migrate 幂等；--rollback 回滚

纪律：Memory Engine 不执行 git commit/push——引擎写完后按既有纪律 commit（身份 `DSH@TURING`）→ `python sync-memory.py push`；T0 查询零读取；新信息默认 candidate，T4「记住」或 explicit 直接 active；inferred 绝不覆盖 explicit。
