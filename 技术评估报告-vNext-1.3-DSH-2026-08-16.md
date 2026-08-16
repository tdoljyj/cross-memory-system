# 跨端记忆系统实现审计与技术评估报告（vNext-1.3 · DSH 端）

> **评估方**：DSH@TURING（第三接入端，独立克隆 `~/.dsh/projects/cross-memory-system`）
> **评估日期**：2026-08-16
> **评估基线**：HEAD = 远端 main = `cf5b3ddc69aabf96762234db8b4fe483101d8c04`（动手前已按 AGENTS v3.1 硬性 check-list 执行版本真值核对：`git ls-remote origin main` == 本地 `rev-parse HEAD`，工作树 clean，无需 fetch+merge）
> **方法**：① 实现层精读（sync-memory.py 1004 行 / sync-memory.ps1 969 行 / tests/test_acceptance.py 921 行 / guards.json / sync.config.json / .gitattributes / .gitignore / memory/index.json）；② 协议与文档层核对（AGENTS.md v3.1 / 架构基线文档-vNext-1.3.md 全文 680 行 / README / 配置手册-v4 / 附录 HTML / 记忆五文件）；③ git 历史全量复盘（含三方合并 `d436de8` 的冲突取舍）；④ 隔离沙盒实证复现（3 组，见附录 B）
> **验证基线**：`python sync-memory.py doctor` = **ALL PASS（exit 0）**；`python tests/test_acceptance.py` = **33 test(s), 0 failure(s), 0 skipped**。
> **评估结论先行**：vNext-1.3 在架构方向（按需读写、Canonical Store、护栏族、单一事实源治理）上已达到个人级系统的高成熟度，**数据安全四不变量与删除传播防线经三轮审计+33 项测试覆盖，机制可信**。但本次实现层审计发现 **3 个 P1 级实现缺陷（其中 1 个已被 3 组实证复现：密钥扫描可被绕过、令牌可入 git 历史）**，另有 P2×8、P3×9，均为「机制覆盖矩阵上的漏洞」而非架构路线问题；全部附修复方案与优先级，可低成本闭环。

---

## 一、摘要

本次评估是本系统第三轮完整审计（前两轮：2026-08-16 Codex 侧「实现审计与脚本加固」「二轮审计」、WorkBuddy 侧「三轮机制审计」、Codex 侧「全面评估」），重点不是复述既有机制，而是回答三个问题：

1. **架构是否成立**：成立。四层结构（协议层 → 路由/召回层 → 同步机制层 → 数据层）职责清晰，Canonical Store、Change Detector、OCC、Cache Invalidation 均有等价 git 机制落地（附录 A 映射表准确）。核心不变量（不覆盖远端、不丢变更、失败可重试）经 33 项验收测试与三端长期实战验证。
2. **实现层是否有洞**：有，且集中在一个共性根因——**「机制覆盖矩阵」没有按「脚本 × 路径 × 对象」系统化审计**。三个 P1 全部是矩阵盲区：ps1 推送路径对「预 staged 非 memory 文件」无覆盖（实证可把令牌推上远端）；部署护栏黑名单漏了 DSH 克隆 × ps1 单元格；py 配置缺失时的回落默认指向他端克隆。这说明系统对「预期路径」防护严密，对「路径组合」防护有洞。
3. **治理机制是否自洽**：部分自洽。单一事实源（index.json / guards.json / VERSION+tag）设计优秀，但执行有系统性滞后：tag `vNext-1.3` 落后 HEAD 12 个提交；文档计数（26/20/28）与实际测试数（27/19/33）多处不符；基线正文第十二节与变更记录互相矛盾。**「带外真值源」机制本身未被严格执行。**

问题全景：**P1×3（1 项已实证）+ P2×8 + P3×9**。全部 P1 与多数 P2 修复成本在「数行代码 + 1 条回归测试」量级，无架构级返工。

---

## 二、架构概览

### 2.1 组件清单与模块划分

| 层 | 组件 | 落地物 | 职责 |
|---|---|---|---|
| 协议层 | Memory Router（T0–T4） | AGENTS.md v3.1 §一 / ~/.dsh/MEMORY.md | 判断是否加载记忆；默认 NONE |
| 协议层 | Recall Planner（L1–L6） | memory/index.json（唯一事实源）+ AGENTS §二 | 段级最小召回映射 |
| 协议层 | 写入纪律 / Change Detector | AGENTS §四 + 脚本 staged 检查 | NO_CHANGE → NO_WRITE → NO_SYNC |
| 同步机制层 | Sync Layer ×3 实现 | sync-memory.ps1（Codex）/ sync-memory.py（WorkBuddy+DSH）/ git 手动流程 | 与 Canonical Store 同步，互不同步 |
| 同步机制层 | 护栏族 | guards.json（契约）+ 删除传播护栏 + 密钥扫描 + deploy-guard + git 客户端护栏 | 防推空仓 / 防令牌入史 / 防跨端污染 |
| 同步机制层 | 跨进程锁 | .sync.lock（py os.open O_EXCL / ps1 FileMode.CreateNew，互操作） | 同机并发互斥 |
| 同步机制层 | 冲突快照 | .conflict-snapshots/（仓库内、gitignored） | base/ours/theirs 三阶段留存 |
| 同步机制层 | Doctor / Bootstrap | 两脚本 doctor / bootstrap 模式 | 接入自检 / 一键配置 |
| 数据层 | Canonical Store | GitHub 私有仓库 tdoljyj/cross-memory-system（memory/*.md + 全仓） | 唯一数据源 |
| 数据层 | 镜像 Cache | 三端各自克隆/工作区 | 只读副本，读前对齐 |

### 2.2 依赖关系与分层评估

```
协议层(AGENTS/MEMORY/index.json 术语与规则)
        │ 引用（术语对齐、触发判据）
        ▼
同步机制层(sync-memory.py / .ps1)  ──读──▶ guards.json / sync.config.* / .gitattributes
        │ git fetch/merge/push
        ▼
数据层(GitHub 私有仓库 = Canonical Store)
        ▲
        │ 消费（AI 会话经 pull 对齐后段级召回）
镜像 Cache（三端克隆/工作区）
```

**分层评价（对照基线原则）**：

- ✅ **单一职责总体成立**：Router/Recall 在协议层（AI 行为），传输与护栏在机制层（脚本），事实在数据层（仓库）。commit 职责边界明确（ps1 代 commit；py 不 commit，使用方负责——附录 A 已登记）。
- ✅ **依赖方向正确**：脚本只依赖协议文档与本地配置，三端互不依赖（不越界硬规则）；Canonical Store 无反向依赖。
- ⚠️ **耦合点 1（机制-文档强耦合）**：护栏口径、conform 判据、文件集均「写死在协议文本里再被测试断言」，任何机制变更必须同步改 AGENTS/README/基线文档三处，历史已出现多次漂移（`test_doc_guard_wording_consistent` 存在的意义就是止血，见问题 P3-9）。
- ⚠️ **耦合点 2（双脚本语义复制）**：py/ps1 是同一协议的两份手工实现，无共享逻辑，已三次漂移（祖先判定、conform 探针补齐时间差、doctor 探针集不对称，见 P3-1）。
- ⚠️ **违反点 1（Change Detector 可被绕过）**：ps1 的 staged 空检查未限定 pathspec，预 staged 非 memory 文件会触发「memory sync」提交（P1-1，已实证）。
- ⚠️ **违反点 2（Access=NONE 纯短路只对 py 成立）**：基线声明「读路径不得有写副作用」，ps1 的 NONE 判断排在 5 个副作用步骤之后（P2-4）。

### 2.3 关键调用链

**读链（命中 T1–T4 时）**：

```
AI 会话：版本真值核对（ls-remote vs rev-parse，仅评估类任务强制）
  → python sync-memory.py pull / sync-memory.ps1 -Pull
      ├─ deploy-guard（py 拒 .codex 克隆 / ps1 拒 .workbuddy 镜像）
      ├─ Access=NONE 短路（py 纯短路 / ps1 非纯，P2-4）
      ├─ ensure_git_safe / Test-GitClientSafe（拒 PortableGit）
      ├─ 删除传播护栏（memory/index.json files 清单逐一非空）
      ├─ resolve_network（代理 3s 探测 → 直连兜底）
      ├─ acquire_lock（.sync.lock，O_EXCL + PID 探活）
      ├─ 工作树脏检查（memory pathspec 有未提交变更 → 拒绝）
      ├─ fetch origin main + merge --no-edit FETCH_HEAD（非 rebase）
      │    └─ 冲突 → backup_conflict 三阶段快照 → merge --abort → .sync-failed
      ├─ merge 后护栏复检（防远端异常空仓）
      ├─ confirm_no_divergence（merge-base --is-ancestor 祖先判定）
      ├─ restore_tracking_ref（沙盒 overlay 兜底，cat-file 验对象防悬空）
      └─ 领先 → 写 .needs-push（读不内嵌 push）；对齐 → 清 .sync-failed
  → AI 按 memory/index.json 段级召回（标准三件套=画像+状态+决策）
```

**写链（本轮产生记忆写入时）**：

```
ps1（Codex）：复制工作区 → repo memory（仅 index 文件）
  → 复制校验（SHA256）→ add -A -- memory 路径 → staged 检查
  → [漏洞点 P1-1：staged 名单未过滤 + commit 无 pathspec]
  → 密钥扫描（Find-SecretLeak 扫工作区；push 路径无 staged 扫描，P1-1/P2-2）
  → fetch + merge → commit（身份 Codex@TURING）→ push → 拒则二轮 → Confirm-RemotePushed（祖先判定）→ 清标记
py（WorkBuddy/DSH）：使用方 commit（身份 DSH@TURING）→ push 模式
  → 护栏（删除传播 / 密钥扫描 memory + staged 名单）→ 锁 → 脏检查
  → fetch+merge → push → 拒则二轮 → 核验 → 清 .sync-failed/.needs-push
```

**关键控制流特征**：所有远端真值取自 `ls-remote` / FETCH_HEAD，不信 tracking ref（沙盒 overlay 实锤教训）；所有核验用祖先判定非 `==` 比较（并发安全）；所有失败写 `.sync-failed` 且可重试；doctor 红旗 = 阻断态。

### 2.4 数据流与控制流清晰度

- **数据流单向收敛**：三端工作区 →（各自脚本）→ git 仓库 →（pull）→ 三端工作区。无端到端直连，无服务端组件（附录 A「不引入」纪律）。清晰。
- **控制流复杂度集中在异常路径**：push 二轮重试、merge abort、快照、标记生命周期（.sync-failed/.needs-push/.pending-writeback）已构成小型状态机，但**状态机无单一文档化定义**（每个标记的写入/清除条件散落在两脚本注释与 AGENTS 文本中），新增状态时有漂移风险（P3-1 的根源之一）。
- **事件流**：git log = Event Log（commit message 带身份+文件清单），`MEMORY_CREATED/UPDATED/SUPERSEDED/DELETED` 映射为 commit 语义（附录 A），无独立事件结构——个人级系统合理取舍。

---

## 三、问题清单

> 严重程度沿用基线口径：P0=核心数据错误（本次未发现）；P1=高优先级（安全/契约失效）；P2=中等（稳定性/一致性）；P3=优化项。每条附：位置（文件:行，@HEAD=cf5b3dd）、证据、影响、修复。

### P1-1【已实证】ps1 推送路径卷入预 staged 非 memory 文件：密钥扫描绕过 + NO_CHANGE 契约失效

- **位置**：`sync-memory.ps1:910-928`（`git add -A -- $memoryPaths` 只 stage memory 路径；`:913` `$staged = git diff --cached --name-only` 不过滤路径；`:928` `git commit -m "memory sync..."` 无 pathspec）。
- **证据（隔离仓库 3 组复现，附录 B）**：
  - 复现①：预 stage `AGENTS.md`（非 memory，85 行删除）+ memory 改动 → 产生提交 `memory sync [Test@TESTBOX]: AGENTS.md, 画像.md` 并推送，脚本自身却打印「2 uncommitted non-memory change(s) ... will NOT be committed or pushed」。
  - 复现②：预 stage 含 `ghp_` 令牌的 `README_x.md` → 令牌随 memory sync 提交**推上远端**（`Select-String` 在远端检出）。密钥扫描被绕过：`Find-SecretLeak` 只扫 `$memorySrc`（工作区 memory，`:884`），push 路径无 `Find-SecretLeakStaged`（该函数只在 `-CommitRepo` 路径 `:788` 调用）。
  - 复现③：无任何 memory 变化 + 仅预 stage `README_y.md` → 仍产生新提交并推送 → 违反 NO_CHANGE → NO_SYNC（基线原则 8 / 附录 A「Change Detector = staged 空检查」被绕过）。
- **影响**：① 令牌可入 git 历史（私有仓库一经 push，删除需 rewrite history，与四不变量冲突）；② memory sync 提交被污染（归属、message、审计混淆）；③ Change Detector 契约失效，可能把工作区里「有意未提交」的内容意外发布。
- **修复**（成本：~30 行 + 2 条回归测试）：`:913` 限定 `git diff --cached --name-only -- memory/`；`:928` commit 加 pathspec 或先 `git reset` 非 memory 路径；push 路径补 staged 扫描且**读 staged blob**（`git show :<path>`，见 P2-1）；新增回归测试「预 staged 非 memory 文件不得进入 memory sync 提交 / 含令牌时拒绝」。

### P1-2 部署位置护栏黑名单不对称：DSH 克隆内的 sync-memory.ps1 无保护

- **位置**：`sync-memory.ps1:34`（只拒 `\.workbuddy\`）、`sync-memory.py:976-984`（只拒 `\.codex\`）。护栏矩阵缺「DSH 克隆 × ps1」单元格。
- **证据**：仓库是共享的，**每个克隆都同时包含两个脚本**。在 DSH 克隆（`~/.dsh/projects/cross-memory-system`）运行 ps1：`$repoRoot`=DSH 克隆（`:28`）、`$MemoryDir` 默认 `Documents\Codex\memory`（`:44`）、身份强制写入 `git config user.name` = Codex@TURING（`:477`）→ 会把 **Codex 端工作区记忆拷入 DSH 克隆、以 Codex 身份提交推送**（跨端污染 + 身份伪造），且该路径不被任何 deploy-guard 拦截（py guard 不拦 .workbuddy/.dsh，ps1 guard 不拦 .dsh）。
- **影响**：护栏设计目标「任何端不得操作他端克隆」出现系统性漏洞；端数 N 增长时黑名单需要 O(N) 手工补全，本次三端接入即漏一单元格。
- **修复**（成本：低）：① 立即止血——ps1 guard 补 `\.dsh[\\/]`；② 机制性——护栏改**白名单/克隆身份令牌**（要求 per-clone `sync.config.ps1` 存在且 `$AgentName` 与脚本角色匹配；ps1 无 config 即拒绝运行），并补「脚本 × 克隆路径」2×N 覆盖矩阵回归测试。

### P1-3 py REPO 回落默认指向 WorkBuddy 克隆（fail-open 越界默认）

- **位置**：`sync-memory.py:94` `REPO = os.path.expanduser(_CONFIG.get("repo", "~/.workbuddy/codex-memory-system"))`。
- **证据**：`sync.config.json` 是 gitignored 文件——**任何新克隆天然缺失它**。新端/新机克隆后首次运行（doctor / pull / push 任一模式）且未先写 config 时，REPO 静默解析为 WorkBuddy 克隆路径；py 的 deploy-guard 只拦 `.codex` 不拦 `.workbuddy`（P1-2 同矩阵），该场景零拦截、零提示，直接对他端镜像执行 fetch/merge/push。
- **影响**：与「不越界」硬规则冲突的 fail-open 默认值；越界操作在一切护栏之后才生效。
- **修复**（成本：2 行 + 1 测试）：缺省 `REPO = os.path.dirname(os.path.abspath(__file__))`（脚本所在克隆，天然正确）；config 仅作显式覆盖。或 config 缺失时 fail-closed 拒绝运行（与 memory_dir_healthy 纪律一致）。

### P2-1 py staged 密钥扫描读工作树文件而非 staged blob（TOCTOU）

- **位置**：`sync-memory.py:429-452`（`find_secret_leak_staged` 用 `git diff --cached --name-only` 取名单，却读 `os.path.join(REPO, name)` 的**工作树当前内容**）。ps1 同函数（`:310-327`）在 `-CommitRepo` 路径因 `git add -A` 先行、工作树==索引而恰好正确；py 端提交由使用方执行，staged 内容与工作树无绑定。
- **影响**：「stage 令牌 → 工作树回改」后扫描读到的不是索引内容 → 漏检。与 P1-1 叠加时构成组合绕过。
- **修复**：读 staged blob（`git show :<path>`）或直接扫 `git diff --cached` 全文。成本低。

### P2-2 py 端非 memory 提交路径无密钥防护（已提交令牌可直接 push）

- **位置**：`sync-memory.py:666-731`（cmd_push 只扫 `memory/*.md` 工作树 + staged 名单；无 commit 职责）。
- **证据**：令牌若已 commit 进脚本/文档（HEAD 内，staged 为空），push 时两道扫描均放行 → 令牌随 push 进远端。ps1 侧有 `-CommitRepo` staged 扫描（`:788`）作等价防线；py 端（WorkBuddy / DSH）完全没有。注意：memory/*.md 内的已提交令牌仍会被 push 时的工作树扫描拦截（`test_py_secret_scan_blocks_push` 已验证），**缺口仅在非 memory 路径**。
- **修复**：py push 前扫 `origin/main..HEAD` 变更文件内容（复用 guards.json 模式）；或为 py 增加 commit 模式统一提交路径。成本：中（一个 diff 遍历函数 + 测试）。

### P2-3 py fetch 失败路径未脱敏

- **位置**：`sync-memory.py:591` `print("[fetch] %s" % ("OK" if code == 0 else "FAIL: " + err))`——原始 stderr 直接输出。对比同文件 `:598`（merge 错误）与 `:707`（push 错误）均经 `redact()`。
- **影响**：git 认证失败的错误文本可含凭据样值（如 URL 内嵌令牌），落入终端/日志，违反附录 C 隐私约束 4「日志脱敏」。
- **修复**：`:591` 改 `redact(err)`；建议把 redact 收进 `run()` 统一出口。成本 1 行。

### P2-4 ps1 -Pull Access=NONE 短路不纯（读路径有写副作用）

- **位置**：`sync-memory.ps1:650-680`。NONE 判断在 `:677`，位于 Test-GitClientSafe（可写 .sync-failed `:651`）、Clear-StaleTempBackups（删 %TEMP% 旧备份 `:655`）、index 校验（可写 .sync-failed `:658`）、脏检查（可写 .sync-failed `:667/:672`）之后。
- **证据**：py 侧 NONE 在一切副作用之前（`sync-memory.py:611-614`，docstring 明示「纯短路」）；基线/AGENTS 口径为「Access=NONE 直接跳过」。T0 场景下 ps1 仍删 TEMP 文件、可能因无关仓库状态失败写 marker。
- **修复**：NONE 判断移到函数最前（对齐 py）；补 ps1 侧 NONE 纯短路回归测试（当前测试只覆盖 py，`test_py_access_none_skips_pull`）。

### P2-5 DSH 端 conform 探针对象与注入对象错位

- **位置**：`sync.config.json:6` `consumer_memory_path: ~/.dsh/MEMORY.md` + `sync-memory.py:100-101`；AGENTS.md:58 端枚举只列 WorkBuddy/Codex。
- **证据**：DSH 每会话实际注入的是 `~/.dsh/AGENTS.md`（本会话系统注入即为证），`~/.dsh/MEMORY.md` 是「权威协议」文件、不注入会话。py doctor 的 conform 探针与「无 pull --rebase」检查都只验 MEMORY.md → **注入文件漂移时 doctor 依然全绿**。当前两文件恰好都 conform（实测均 True），缺口是潜在态。
- **修复**：DSH 端 `consumer_memory_path` 改指 `~/.dsh/AGENTS.md`（或双文件都检）；AGENTS.md:58 枚举补 DSH 端。成本极低。

### P2-6 备份保留期单一事实源与文档漂移（guards.json 2 天 vs 文档 7 天）

- **位置**：`guards.json:11` `backup_retention_days: 2`（两脚本实际读取的唯一事实源）；`架构基线文档-vNext-1.3.md:16/:659` 与 `memory/待办.md:26` 仍写「>7 天」。
- **影响**：文档承诺 7 天恢复窗口，实际 2 天即删（写回备份、冲突快照的恢复保障被夸大）。此前 vNext-1.3「写回成功不再删备份（交保留期清理）」的恢复价值随之缩水。
- **修复**：文档统一为 2 天（或按真实意图把 guards.json 改 7）；测试扩展 `test_doc_guard_wording_consistent` 加保留期口径断言。

### P2-7 决策.md 内部凭据策略新旧并存未 superseded

- **位置**：`memory/决策.md:18`（「令牌存 GITHUB_PAT_TOKEN…刷新 gh 后需 setx 同步」）vs 同文件 `:25`（「凭据接入改为 git 走 gh 凭据助手、不 setx 长期令牌」）——直接冲突。`配置手册与数据包-v4.md:403`、`memory/归档.md:13` 亦残留旧口径；README:50 为新口径。
- **影响**：协议层自相矛盾（AGENTS §四 明确要求 superseded 语义而非并存）；新会话读到旧条目可能复活旧行为（setx 长期令牌——恰是 vNext-1.3 要消除的安全风险）。
- **修复**：决策.md:18 标注 superseded 指向 :25；归档.md:13 属历史审计可保留但加「已废弃」注记；配置手册该行同注。

### P2-8 基线正文第十二节与变更记录/实现矛盾（权威文档内部不一致）

- **位置**：`架构基线文档-vNext-1.3.md:403`（「Codex 端无机器检查——2026-08-16 审计实证 sync-memory.ps1 -Doctor 未实现 conform 探针…属已知缺口」）vs 同文档变更记录 `:27`（DSH 端接入已补 ps1 conform 探针）vs 实现 `sync-memory.ps1:224-233/:560-565`（探针存在）。
- **影响**：基线文档自述「修改本文档必须在变更记录追加条目并同步全部协议副本」——变更记录更新了但正文未同步；后续维护者按正文行事会误判 ps1 无探针（该表述曾真实发生过一次「虚假覆盖」事故，见版本对比附录 §3）。
- **修复**：`:403` 改写为「ps1 -Doctor 已于 DSH 端接入轮补齐 conform 探针（各端只检本端）」。成本极低。

### P3-1 双脚本语义漂移面过大（无一致性测试）

- **位置**：全仓两脚本。历史漂移三次（祖先判定统一、conform 探针补齐时间差、doctor 探针集不对称）；`memory/待办.md:28` 曾把「双脚本协议统一或加一致性测试」**冻结**（理由是「核验逻辑已统一，彻底合并成本高」）——但冻结后仍持续漂移，冻结依据已不成立。
- **当前不对称清单**：ps1 doctor 无「memory files healthy」探针（py:919 有）；ps1 doctor 无「local==remote 落后阻挡态」（py:922-935 有，README:84 却把它写成通用排查项）；py doctor 无 ps1 的「ref write persists 行为探针」（ps1:532-537）；ps1 doctor 不自动补写 tracking ref（py 自愈 AUTO-HEALED）；py 无 -CommitRepo 模式；ps1 push 无 staged 扫描（P1-1）。
- **修复**：不重写合并，而是提取「协议行为清单」（manifest：模式 × 护栏 × 探针 × 退出码），生成同一组断言分别对两脚本执行（行为一致性测试）。成本：中；收益：永久消除该类漂移。

### P3-2 黑名单式 git 客户端护栏可被路径改名绕过

- **位置**：`sync-memory.py:123-126`（`git_is_safe` 按路径字符串判 "portablegit"/".workbuddy"）、`sync-memory.ps1:368-372`（`Test-GitClientSafe` 同）。目录重命名即失效。真实保障来自 py 的 `GIT_CANDIDATES` 官方 Git 优先 + doctor 提示；护栏应定位为 heuristic，README:72 的表述尚可，但 AGENTS 不应把它写成绝对防线。

### P3-3 PID 锁的 PID 复用固有缺陷（两实现均无法区分同进程与复用 PID）

- **位置**：`sync-memory.py:341-373`（OpenProcess+GetExitCodeProcess，保守语义）、`sync-memory.ps1:235-262`（Get-Process）。锁文件仅存 PID、无进程启动时间/句柄；PID 被无关长命进程复用 → 锁被永久楔住（需手工删 `.sync.lock`）。py 保守版把「无权打开」按存活处理，进一步放大了楔住概率（方向正确——防锁被偷——但代价是这类死锁）。
- **修复**：锁内容加启动时间戳 + 进程名核对；或改用持有句柄的锁（进程退出内核自动释放）。低概率问题，列为中期优化。

### P3-4 index.json files 项无路径净化

- **位置**：`sync-memory.py:238-248`（memory_dir_healthy）、`:251-271`（index_recall_valid）、`sync-memory.ps1:168-180`（Test-MemoryFilesHealthy）——直接 `os.path.join(memdir, f)`。files 含 `../x.md` 可逃逸 memory 目录：护栏检查与召回段名校验会读到任意本地路径；index.json 在共享仓库中，远端 merge 可注入。影响低（仅本地读取、无内容外泄），修复为 join 前校验 `os.path.basename(f) == f`。

### P3-5 网络往返冗余 + 超时策略不对称

- **位置**：py pull 路径 fetch 两次（`fetch_and_merge` `:588` + `confirm_no_divergence` 内再 fetch `:473`）；push 单流程最多 fetch×3 + push×2。py `run()` 固定 60s 超时、无 `http.lowSpeed`（`:170-178`）；ps1 有 lowSpeedLimit=1/15s 但无总超时。建议：单次 fetch 后复用 FETCH_HEAD/本地 merge-base，py 补 lowSpeed 参数对齐 ps1。

### P3-6 %TEMP% 全量 listdir

- **位置**：`sync-memory.py:514-535`、`sync-memory.ps1:380-398`——每次 pull/push/doctor 扫 `%TEMP%` 找 `codex-memory-*` 前缀目录。%TEMP% 文件量巨大时无谓 IO。修复：清理收敛到 `.conflict-snapshots/`（仓库内、gitignored、私有）或降频。

### P3-7 版本指针治理不严（tag 落后 12 提交、多轮修复不 bump、合并身份越轨、计数滞后）

- **位置/证据**（git 实测，HEAD=cf5b3dd）：
  - 唯一 tag `vNext-1.3` → `c2bb2cb`，落后 HEAD **12 个提交**（含 98ba9b7 Codex 全面修复、adbdf82 DSH 接入、d436de8 三方合并）；README:52 声称「tag 只随版本 bump 移动、HEAD 领先 tag 属正常」，但 12 个提交中包含实质机制变更，「带外真值源」已失去对当前实现的锚定能力。
  - `0410289` 宣称打 tag 与实际打 tag 时间差 4 小时；VERSION 文件创建后从未更新；vNext-1.0/1.1/1.2 无 tag。
  - 合并提交 `d436de8` 作者 = `push <tdoljyj@...>`（非任何端身份），与「AI名@机器名」提交约定冲突（身份规范未定义合并提交作者规则）。
  - 文档测试计数系统性滞后：98ba9b7 记 26 实 27、a9db397 记 20 实 19、合并后 33 无人回填（变更记录仍写 28）。
- **修复**：每轮机制修复打轻量 tag `vNext-1.3.<n>`（或 VERSION 加修订位）；合并提交作者规则写入 AGENTS §六；变更记录格补合并后总数。

### P3-8 报错文案误导 + README/配置手册文档缺口

- `sync-memory.py:621-623`：index.json 损坏/不可解析时也报「缺少必需文件」（py 未区分「索引缺失/非法/文件缺失」三种口径；ps1:853-858 已区分前两种）。
- README:69 记载 `sync.config.json` 字段缺 `consumer_memory_path`（DSH 接入轮新增）。
- README:61「端侧差异（Codex / WorkBuddy）」表仅两列，**DSH 无端侧差异行**（克隆位置/脚本/配置/消费端钩子/权限/网络策略六行均缺 DSH 列；DSH 仅登记于接入方表 README:18）。新端照表接入时 DSH 侧操作要点不可查。
- 配置手册-v4 残留「开场完整读取记忆文件」旧流程表述（README:30 已声明其为历史快照，但相关小节缺行内「已废弃」注记，新读者可能照做——与触发式按需读写冲突）。
- 均为小修：报错口径区分 + README 补 DSH 列/字段 + 配置手册加注记。

### P3-9 机制-文档耦合维护成本（治理观察项）

- 护栏口径（≥5 → index.json files）、版本号入文件名（-vNext-1.3.md 全仓引用同步）、conform 三要素（文本判据）——三类「机制变更必须同步改文档」的耦合点，历史靠回归测试强制止血（test_doc_guard_wording_consistent / test_repo_files_do_not_self_match_secret_patterns）。方向正确，但说明「文档即配置」的架构在端数增长后维护成本上升；中期可考虑把可机读判据（conform 要素、版本、文件集）全部收敛进 guards.json/index.json，文档只做人类可读摘要（AGENTS §二已对 index.json 采用此模式，值得推广）。

---

## 四、优化建议路线图

> 优先级：P0 立即（本轮后即可闭环，均 < 半天）；P1 短期（一周内）；P2 中期（按月）。成本按「代码行 + 测试条数 + 文档同步」估算。

| # | 对应问题 | 措施 | 预期收益 | 实施成本 | 优先级 |
|---|---|---|---|---|---|
| 1 | P1-1 | ps1 push 路径：staged 名单限 pathspec + commit 限 pathspec + 补 staged blob 扫描 + 2 条回归测试 | 堵死令牌入史通道；恢复 NO_CHANGE 契约 | ~30 行 + 2 测试 | **P0** |
| 2 | P1-3 | py REPO 默认 = 脚本所在克隆；config 缺失 fail-closed | 消除 fail-open 越界默认 | 2 行 + 1 测试 | **P0** |
| 3 | P1-2 | ps1 guard 补 `.dsh` 黑名单（止血）+ 白名单身份令牌（机制）+ 2×N 覆盖矩阵测试 | 消除跨端污染/身份伪造路径 | 10~40 行 + 2 测试 | **P0** |
| 4 | P2-3 | fetch 错误输出 redact | 日志脱敏闭环（附录 C-4） | 1 行 | **P0** |
| 5 | P2-5 | DSH consumer_memory_path → ~/.dsh/AGENTS.md；AGENTS:58 补 DSH | 探针覆盖真实注入对象 | 2 行 + 文档 2 行 | **P0** |
| 6 | P2-8 | 基线第十二节正文与变更记录对齐 | 权威文档内部一致 | 文档 1 段 | **P0** |
| 7 | P2-6 | 保留期口径统一（文档 2 天 或 guards.json 7 天）+ 口径测试 | 文档承诺与行为一致 | 文档 + 1 测试 | P1 |
| 8 | P2-7 | 决策.md:18 superseded 标注；配置手册/归档加「已废弃」注记 | 消除协议层新旧并存 | 文档 3 行 | P1 |
| 9 | P2-4 | ps1 NONE 短路前置 + 回归测试 | 读路径零副作用（T0 纯净） | 5 行 + 1 测试 | P1 |
| 10 | P2-1 | staged 扫描改读 `git show :path` | 消 TOCTOU | ~8 行 | P1 |
| 11 | P2-2 | py push 前扫 origin/main..HEAD 变更文件 | py 端非 memory 令牌防护 | ~30 行 + 1 测试 | P1 |
| 12 | P3-1 | 协议行为清单 + 双脚本一致性测试（先覆盖 doctor 探针集与 push 路径护栏） | 永久消除双实现漂移 | 0.5~1 天 | P1 |
| 13 | P3-7 | 每轮修复打 `vNext-1.3.<n>` tag；合并作者规则入 AGENTS §六；回填合并后测试计数 | 带外真值源重新可锚定 | git 操作 + 文档 | P1 |
| 14 | P3-4 | index.json files 路径净化（basename 校验） | 防远端注入逃逸 | 4 行 | P1 |
| 15 | P3-3 | 锁内容加时间戳/进程名；或句柄锁 | 消 PID 复用死锁 | 中 | P2 |
| 16 | P3-5/P3-6 | 单次 fetch 复用 + py lowSpeed 对齐；TEMP 清理收敛 | 网络往返减半、IO 降噪 | 中 | P2 |
| 17 | P3-8/P3-9 | 报错口径区分；README 补字段；机读判据收敛 guards.json/index.json | 文档债清理 | 低 | P2 |

**建议执行方式**：P0 六项（#1–#6）单轮修复闭环（对齐历史模式「评估 → 修复 → 回归 → 验收 33+N 全绿」）；每项修复独立 commit（身份 `DSH@TURING`），全部落地后跑 `tests/test_acceptance.py` + 双端 doctor，并打 `vNext-1.3.1` tag（P3-7 措施同轮落地）。

---

## 五、版本对比附录（vNext-1.0 → vNext-1.3）

> 完整版见本报告附录 A（含 commit hash 与 diff 佐证）。此节为结论表。

### 5.1 版本时间线与核心机制增量

| 版本 | 关键 commit | 解决什么问题 | 核心增量 | 设计取舍与得失 |
|---|---|---|---|---|
| 前史（v4） | `d896d8f`（ps1 诞生）→ `d7b73c7` | 单端记忆 → 多端协同 | ps1 同步脚本；rebase→merge + union driver（实测 rebase+union 会 exit 0 假成功丢单边内容）；`224b704` 引入 py（沙盒 overlay 拦 git 写 ref 的根治兜底） | 得：机制经实测收敛；失：脚本数×2，进入双实现时代 |
| vNext-1.0/1.1 | `c284d19`（两版折入同一 commit） | 确立 Chase vNext 架构为唯一规范基线 | 基线文档 + 附录 A/B + AGENTS v3（T0–T4/L1–L6/Trigger Matrix）；1.1 补适用性说明 + 附录 C 隐私约束 + 用例 F 许可偏差 | 得：术语统一、理想架构与实际落地映射明确；失：正文为服务化理想架构，与「文件+git」的映射靠附录 A 仲裁，文档复杂度上升 |
| vNext-1.2 | `2a31bba` + `e4b7914`（Codex 独轮） | 防推空仓、并发误报、换机成本、TEMP 膨胀 | 删除传播护栏（.md≥5 硬编码）、祖先判定核验统一、sync.config.json 参数化、段级召回、PortableGit 硬阻断、bootstrap | 得：安全与可移植性跃升；失：硬编码 5 成魔法数（1.3 立即被 index.json 取代）；py 配置缺失静默回落内置默认（本次审计定为 P1-3） |
| vNext-1.3 | `90797e5`→`d436de8`（5 轮 17 提交，三端交错） | 工程化与三端治理 | index.json 单一事实源、redact 全模式、.sync.lock、guards.json 契约、conform 探针、deploy-guard、.needs-push 闭环、PID 安全探活、doctor 阻挡态、VERSION+tag、DSH 第三端接入 | 得：护栏参数化+脱敏+锁形成完整安全面；**失/风险：① 跨端 conform 探针先加后撤（e74cc75→a9db397，21 分钟，越界教训）；②「ps1 自检」虚假覆盖（abac650 实证）→ DSH 轮才真正补齐（adbdf82）；③ 文档计数/版本标注系统性滞后；④ tag 指针不再更新（落后 12 提交）；⑤ 三方合并 d436de8 需要人工语义取舍（同缺陷双修复取 DSH 保守版，Codex 钩子字节比对整体删除）** |

### 5.2 版本治理结论

1. **名称一致性 ✓**：VERSION 内容与 tag 名同为 `vNext-1.3`，无错位。
2. **指针失效 ✗**：tag → `c2bb2cb`，落后 HEAD 12 提交（含两次 P1 修复轮与三方合并）；`0410289` 宣称打 tag 与实际打 tag 差 4 小时。
3. **覆盖不全 ✗**：1.0/1.1/1.2 无 tag；VERSION 创建后未随 1.3 内部 5 轮修复 bump（各轮均自述「未 bump 版本」）。
4. **教训沉淀**：「修复反复 + 虚假覆盖 + 计数滞后」三次治理事故的根因相同——**机制变更没有强制性的「正文/计数/tag 三同步」检查**。建议（本报告 #13）：tag 随每轮机制修复移动 + 变更记录格强制回填测试总数 + 合并作者规则明文化。

---

## 附录 A：版本对比细节（commit 级）

### A.1 时间线（HEAD=cf5b3dd，单线 main + 1 次三方合并）

```
de128e0(初始 v4 手册) → d896d8f(ps1 首现) → 3ed30ec(多机多 AI 协同, Codex@TURING)
→ d7b73c7(rebase→merge+union, WorkBuddy@TURING) → c9a4187/ce38b7c(加固, Codex@TURING)
→ 224b704(sync-memory.py 诞生, WorkBuddy@TURING) → fa38dd0(AGENTS v2 按需读写)
→ c284d19(vNext-1.0/1.1 折入, WorkBuddy@TURING) → 38456ff(基线对齐)
→ 2a31bba(vNext-1.2 加固, Codex@TURING) → e4b7914(1.2 补充)
→ 90797e5(验收测试 8 用例) → 5cc3339(index.json) → e35b76a(护栏参数化+redact, 测试 10)
→ 3ce1d83(.sync.lock+密钥扫描+-CommitRepo, 测试 15) → 0410289(check_ref_valid 消假阳+VERSION+tag)
→ 9d10193(基线文档改名+R1-R4, 测试 19) → 44de5b8(版本真值核对触发式, WorkBuddy@CHASE-PC)
→ e74cc75(conform 探针, 含跨端→越界) → a9db397(21 分钟后撤回跨端) → d3daee9(文档同步撤回)
→ abac650(conform 缺口显式化) → 613bf5b(guards.json 单一事实源+C5 抗欺骗) → d86284a(措施8/10/11/12/15, 测试 21)
→ c2bb2cb(runner 环境预检; ★tag vNext-1.3 指向此处) → 549e6c9..4551586(README/术语/勘误)
→ 3ed856e(接入复核 = 分叉 merge-base)
→ 【Codex 支】3404d09 → 98ba9b7(全面评估修复, 测试 27)
→ 【DSH 支】adbdf82(P1 修复+第三端接入, 测试 28) → 8158b5a → 69f1136(计数修正)
→ d436de8(★三方语义合并, 测试 33; 作者=push) → aeb7c04 → cf5b3dd(当前 HEAD)
```

### A.2 关键机制 diff 摘录（佐证）

**删除传播护栏：硬编码 5 → index.json files 清单**（2a31bba → e35b76a）：

```diff
-def memory_dir_healthy(min_count=5):
-    """删除传播护栏：memory 目录至少要有 5 个非空 .md 才允许同步。"""
-    files = [f for f in os.listdir(memdir) if f.endswith(".md")]
-    if len(files) < min_count:
-        return False
+def memory_dir_healthy():
+    """删除传播护栏：memory/index.json 声明的每个 .md 都必须存在且非空。"""
+    required = memory_files()
+    if not required:
+        return False
```

**check_ref_valid 消假阳**（0410289）：由「40-hex 正则」改为「比对 ls-remote 哈希」，悬空/漂移 ref 从 PASS 变 FAIL；doctor 增加「本地落后远端 → 读前必须 re-pull」阻挡态。

**PID 锁探活：同缺陷双端独立修复，语义合并取舍**（98ba9b7 vs adbdf82，d436de8 合并）：

```diff
+# Codex 简版（合并中被替换）：
+    if not handle:
+        return False
+# DSH 保守版（合并采纳，防锁被偷）：
+    if not handle:
+        # 5 = ERROR_ACCESS_DENIED：进程存在但无权查询 → 保守按存活
+        return ctypes.get_last_error() == 5
```

**deploy-guard 双端各自落地**（ps1:9d10193 拒 .workbuddy；py:adbdf82 拒 .codex）——本报告 P1-2 指出矩阵漏 DSH×ps1 单元格。

**ps1 `${remoteHash}..HEAD` 分词修复**（adbdf82）：`$remoteHash..HEAD` 被 PowerShell 拆成两参数 → rev-list 收到非法参数 → stdout 空 → `[int]@()=0` → 领先检测恒假（.needs-push 路径曾从未生效，回归测试实锤）。

### A.3 测试演进实测（文档口径 vs 代码事实）

**实际用例数：8 → 10 → 15 → 19 → 21 → 27(Codex 支)/28(DSH 支) → 33(合并)**。
文档记录的系统性偏差：`a9db397` 记 20 实 19；`98ba9b7` 记 26 实 27；合并后变更记录未回填 33。当前 HEAD 实测：**33/33 PASS, 0 skipped**（本报告基线；审计期间交叉核对曾出现「TESTS 注册 34 项」的读数，经 `^def test_` grep（33 个）与实际运行输出「33 test(s)」双重核验，以 33 为准）。

### A.4 版本演进暴露的治理问题（7 条，详见正文 P3-7）

1. 核心文件三端并行修改 → 同缺陷双修复 → 人工语义合并取舍（实锤 d436de8）
2. 带外版本指针（VERSION/tag）创建后不再维护
3. 修复反复与虚假覆盖（conform 探针三轮反复史）
4. 测试计数与版本标注系统性滞后
5. 合并提交身份越轨（作者=push）
6. WorkBuddy 双机器身份（CHASE-PC 与 TURING 同署名 WorkBuddy）
7. 机制-文档耦合维护成本

---

## 附录 B：实证复现记录（隔离沙盒）

> 环境：临时 bare 仓库 + 空克隆，seed 真实 memory/ 五文件 + index.json + AGENTS.md + guards.json + .gitattributes + sync-memory.ps1 + sync.config.ps1（$MemoryDir=临时工作区、$ProxyUrl=""），官方 git 2.55.0.windows.3 + pwsh。复现后全部临时目录已清理。

**复现①：预 staged 非 memory 文件被卷入 memory sync 提交**

- 步骤：`git add AGENTS.md`（stage 非 memory 文件，内容改写为 2 行）；工作区 画像.md 追加一行；运行 `sync-memory.ps1`（默认 push 模式）。
- 结果：脚本输出警告「2 uncommitted non-memory change(s) ... will NOT be committed or pushed」，随后仍产生提交 `memory sync [Test@TESTBOX]: AGENTS.md, 画像.md`（AGENTS.md 85 行删除）并推送远端；远端检出 AGENTS.md 为新内容。
- 结论：与脚本自身警告及 AGENTS §四 Change Detector 契约矛盾。

**复现②：staged 非 memory 文件携带令牌 → 推上远端（密钥扫描绕过）**

- 步骤：新建 `README_x.md` 含 `ghp_AAAA...`（32 位 A，运行时拼接避免测试文件自命中）；`git add README_x.md`；工作区 画像.md 追加一行；运行 ps1。
- 结果：提交 `memory sync [Test@TESTBOX]: README_x.md, 画像.md` 成功推送；远端 `Select-String` 检出令牌样值 = True。`Find-SecretLeak`（只扫工作区 memory）与缺失的 push 路径 staged 扫描均未拦截。
- 结论：P1-1 安全影响坐实——令牌可经此路径进入 git 历史。

**复现③：无 memory 变化仍产生推送（NO_CHANGE → SYNC 违约）**

- 步骤：仅 `git add README_y.md`（无令牌、非 memory），不做任何 memory 改动；运行 ps1。
- 结果：仍产生提交 `memory sync [Test@TESTBOX]: README_y.md` 并推送（远端 HEAD 前移）。
- 结论：Change Detector（staged 空检查）被预 staged 内容绕过，违反 NO_CHANGE → NO_SYNC（基线原则 8）。

**（对照）正常路径不受影响**：本轮基线运行 `tests/test_acceptance.py` 33/33 全绿、`sync-memory.py doctor` ALL PASS、`sync-memory.py pull` 对齐成功——三组复现均为矩阵盲区，非主路径回归。

---

## 附录 C：评估方法学与自检

- 版本真值核对（AGENTS v3.1 硬性 check-list 第 1–4 条）：`git ls-remote origin main` = `cf5b3ddc69aa...` = 本地 `rev-parse HEAD` ✓；VERSION=vNext-1.3、`git tag -l`=vNext-1.3 ✓（但 tag 指针落后 HEAD 12 提交，见 P3-7）。
- 只读纪律：本评估对三端实现文件零修改；所有实证在隔离临时仓库进行；未读写任何他端克隆/工作区（不越界）。
- 评估方独立性：DSH 为第三接入端，非 sync-memory.py 的原始作者（WorkBuddy 侧）亦非 ps1 作者（Codex 侧），结论不受作者偏差影响。
