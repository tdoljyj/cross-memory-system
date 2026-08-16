# Cross Memory System vNext · 架构基线文档

> **基线版本**：vNext-1.3（2026-08-16 确立，同日按 A/B/C 结构化召回索引、统一护栏、令牌脱敏推进）
> **来源**：Chase 提供的《Cross_Memory_System_vNext_核心架构》（原件存 `附录/Cross_Memory_System_vNext_核心架构.html`，本文档为其规范 Markdown 转换；源 HTML 存在表格标签未闭合等结构问题，转换时已修正）
> **适用范围**：跨端记忆系统的全部实现与协议文档——本仓库（cross-memory-system）全部文件、Codex 端 `~/.codex/AGENTS.md` 与 sync-memory.ps1、WorkBuddy 端 `~/.workbuddy/MEMORY.md` 协议与 sync-memory.py，以及未来任何新接入端
> **权威性**：本文档是 vNext 核心架构规范，统一后续设计、实现和变更的依据。其他文档与本文档冲突时，以本文档为准；修改本文档必须在「变更记录」追加条目并同步全部协议副本
> **适用性说明**：正文（第一~二十一节）为通用理想架构（面向服务化/数据库实现）；本系统当前为「文件 + git 私有仓库」架构，**正文与附录 A 冲突时以附录 A 的落地映射为准**。附录 A 标注「不适用/展望」的条目不得在现有架构中机械套用（如 SQL 式 UPDATE、数值化 confidence、语义检索打分）

## 变更记录

| 版本 | 日期 | 变更内容 | 操作方 |
|---|---|---|---|
| vNext-1.0 | 2026-08-16 | 确立为基线：转换 Chase 提供的 vNext 核心架构为规范文档；新增附录 A（现有实现映射：保留/调整/替换）与附录 B（验收标准落地对照） | WorkBuddy@TURING |
| vNext-1.1 | 2026-08-16 | 同日评审修订：新增适用性说明（正文与附录 A 冲突时以附录 A 为准）；十六节 Phase 标注现有架构落地状态；Trigger Matrix 补「受个人约束的通用问题」行；新增附录 C 隐私与安全约束；附录 B 用例 F 标注许可偏差（merge 收敛而非硬冲突）；附录 A 补 L6 工作区临时层映射、标注 Recall Score 为展望项 | WorkBuddy@TURING |
| vNext-1.2 | 2026-08-16 | 评审落地加固：① 双端同步脚本新增删除传播护栏（源 memory 目录 .md<5 拒绝同步，防推空仓）；② 双脚本核验统一为祖先判定（merge-base --is-ancestor，消除 py 并发下误写 .sync-failed）；③ py 配置参数化（sync.config.json）；④ 召回粒度由文件级升级为段级（L1–L6 映射到具体标题段）；⑤ 明确 Sync Layer 与 commit 职责边界；⑥ 同步全局钩子 ~/.codex/AGENTS.md。新增附录 D（保留/调整/替换/待办对照）。结构化语义合并与验收自动化记为待办 | Codex@TURING |
| vNext-1.2 补充加固 | 2026-08-16 | 同日续加固：ps1 PortableGit 硬阻断；两端 TEMP 备份清理（>7 天）；全仓脏检查（非阻断提示）；归档.md 瘦身阈值提示；py pull 代理预检；py doctor 协议新鲜度检查；两端 bootstrap 一键配置 | Codex@TURING |
| vNext-1.3 | 2026-08-16 | 工程化推进（结构化召回索引 + 统一护栏 + 令牌脱敏）：① 新增 memory/index.json（schema_version 1，files + L1–L6 recall 映射）作为召回与必需文件集的唯一事实源；② 双端同步护栏由硬编码 5 改为读 index.json 的 files 清单（缺失/为空拒绝同步）；③ 双端新增 redact() 令牌掩码（gho_/ghp_/github_pat_/Bearer）并接入 .sync-failed 与 doctor，doctor 提示长期令牌环境变量并展示 credential.helper；④ AGENTS.md / README 对齐 index.json 与「git 走 gh 凭据助手、不 setx 长期令牌」；⑤ 验收测试 8 → 10 用例（index.json 校验 / redact 回归 / missing-index 护栏） | Codex@TURING |
| vNext-1.3 收尾修复 | 2026-08-16 | 复盘「评估失误」后双向整改落地：① check_ref_valid 由 40-hex 正则改为比对 ls-remote 哈希（消假阳）；② doctor 增加方向判定，本地落后远端时显式「读前必须 re-pull」阻挡态；③ 新增 VERSION 文件 + git tag vNext-1.3 带外版本指针，基线文档文件名加版本号（架构基线文档-vNext-1.3.md，全仓引用同步）；④ 版本号标注 1.2→1.3 同步（AGENTS/README/双脚本/tests/配置手册）；⑤ ps1 -Pull 远端 hash 缺失 fail-closed（消 P0-A）；⑥ py tracking ref 加 cat-file 存在性校验（消悬空 ref，P1-A）；⑦ ps1 部署位置护栏（拒绝在 .workbuddy 镜像执行，P0-B）；⑧ py pull 领先自愈补推（P1-C）；⑨ AGENTS 加「评估类任务第一步 ls-remote」硬性 check-list；⑩ 验收测试补 null-remote / dangling-ref / deploy-guard / 领先自愈 4 条回归 | WorkBuddy@TURING |
| vNext-1.3 显式化加固 | 2026-08-16 | 将「版本真值核对 = 触发式、禁止定时/启动/调度自动化」显式写入 canon：AGENTS v3.1 第 51 行 check-list 后补机制性质注（防跑偏）；第十二节 Cache 与失效机制补「版本真值核对=触发式落地、禁周期形态」一句；与 Phase 6/12 废除批量加载一致，未引入新机制、未 bump 版本 | WorkBuddy@TURING |
| vNext-1.3 残留边界收窄 | 2026-08-16 | 把「端点完全无视协议则规则救不了」的残留边界收窄为可检测+阻断：① sync-memory.py doctor 新增「消费端 conform 触发式禁令」探针（纯函数 consumer_conformed，检测 MEMORY.md/Codex AGENTS.md 是否声明「版本真值核对/触发式/禁自动化」三要素；缺失=FAIL）；② AGENTS v3.1 明令 doctor 红旗=阻断态（conform 探针 FAIL / ref 漂移不得读 canon、不得 push）；③ bootstrap 接入门槛强化（须全 PASS、conform 探针不得 FAIL）。未引入周期任务、未 bump 版本、与 Phase 6/12 一致 | WorkBuddy@TURING |
| vNext-1.3 残留边界收窄-修正 | 2026-08-16 | 撤回「检测 Codex AGENTS.md」的跨端探针：按「不越界」纪律，各端 doctor 只自检本端（WorkBuddy 检 MEMORY.md、Codex 由 ps1 -Doctor 自检）；同步修正第十二节探针描述与验收表用例口径（TESTS 实际注册 20 项） | WorkBuddy@TURING |
| vNext-1.3 conform 缺口显式化 | 2026-08-16 | 审计实证（grep ps1 零 conform 代码）：上一行「Codex 由 ps1 -Doctor 自检」为**虚假覆盖**——ps1 从未实现该探针。方案 B 落地：改为显式承认「Codex 端 conform 无机器检查、依赖协议自觉」；同步修正第十二节与验收表口径；doctor 对 tracking ref 丢失（沙盒 overlay 常态）改为自愈项（自动补写，报 AUTO-HEALED 不计失败），阻断态限定为真分叉 / conform 缺失 / 远端不可达 | WorkBuddy@TURING |
| vNext-1.3 措施8/10/11/12/15 落地 | 2026-08-16 | 结构性加固收尾：① 措施8（C15）py/ps1 pull 领先不再内嵌 push（读路径无写副作用），只写 `.needs-push` 标记，由使用方非沙盒显式 push；② 措施10（C19）ps1 5 模式函数化（Invoke-DoctorMode/BootstrapMode/PullMode/CommitRepoMode/PushMode + 顶层 dispatch，exit→`$script:exitCode`）；③ 措施11（C17）冲突快照/写回备份从 %TEMP% 明文改仓库内 gitignored `.conflict-snapshots/`，成功即删；④ 措施12（C11）代理优先读 HTTPS_PROXY 环境变量 + proxy_alive 从 URL 解析 + resolve_network 直连兜底（消 7892 误杀）；⑤ 措施15（C23）bootstrap 恢复保守 GC（gc.auto=256 / gc.pruneExpire=2.weeks）。验收 21/21 PASS | WorkBuddy@TURING |
| vNext-1.3 术语统一（跨 AI → 跨端） | 2026-08-16 | 系统中文称呼由「跨 AI 记忆系统」统一为「跨端记忆系统」（端 = AI×机器 组合），全仓清除「多机多 AI」残留。语义分层：**架构关系层**用「共享」——各端隔离共享唯一数据源、互不同步、互不越界（README 定位句 / 新电脑接入导语）；**同步机制层**用「协同」——多端经 fetch/merge/push 收敛、冲突语义合并（README 系统定性「跨端记忆协同机制」、章节「跨端协同机制」、AGENTS.md 六章「跨端协同纪律」）。同步修改：README 标题/第 5 行/定位句/章节标题/新电脑接入导语、AGENTS.md 六章标题、本文档第 5 行适用范围全称。未改架构语义、未 bump 版本（VERSION 仍 vNext-1.3）；`memory/归档.md`「跨 AI 体检结论」为历史审计标题（指跨两端体检，事实准确），保留 | WorkBuddy@TURING |

> **目标**：将"每次开头强制加载记忆、结尾强制上传"改造成真正的按需读写型跨会话记忆系统。
>
> **核心原则**：默认不加载个人记忆；只有当当前问题与个人身份、偏好、历史项目、个人经历、约束等存在明确关联时才进行最小必要召回；只有本轮产生新的个人相关信息或修改时才持久化。

---

## 一、核心结论

原机制：

```
每次会话开始
    ↓
强制加载全部记忆
    ↓
AI回答
    ↓
每次会话结束
    ↓
强制上传全部记忆
```

应彻底废弃。

新的核心流程：

```
用户请求
   ↓
Memory Router
   ↓
判断是否存在"个人记忆相关性"
   │
   ├── 无关 → 不访问 Memory
   │
   └── 相关
        ↓
     Recall Planner
        ↓
   只召回必要记忆
        ↓
   AI Context
        ↓
   正常回答
        ↓
   Memory Change Detector
        ↓
   是否产生新的个人信息/修改？
      │
      ├── 否 → 不写
      │
      └── 是
           ↓
       Candidate Memory
           ↓
       Validation
           ↓
       Versioned Commit
           ↓
       Sync / Cache Invalidation
```

核心思想：

> 不要把"按需加载"理解成"发现相关后加载全部个人记忆"。
>
> 应该采用：请求级记忆路由 → 最小必要召回 → 分层注入 → 本轮产生变化才写回 → 版本化提交 → 同步/缓存失效。

---

## 二、当前架构需要重点审查的问题

严重程度：

- **P0**：必须解决，否则可能导致核心数据错误
- **P1**：高优先级，影响核心体验
- **P2**：中等问题，影响性能/稳定性
- **P3**：优化项

### P0-1：全量加载记忆

问题位置：

```
Session Start
    ↓
Load All Memories
```

影响：

1. 无关问题也读取个人数据。
2. 增加上下文 token。
3. 增加延迟。
4. 增加模型受到无关历史信息干扰的概率。
5. 隐私边界变差。
6. 多端同时使用时容易出现旧数据覆盖新数据。

修复：建立 **Memory Router**。在不读取完整个人记忆的情况下，只根据当前请求判断：是否可能依赖个人上下文？

### P0-2：每轮强制上传

问题：即使 `Memory Before == Memory After` 仍执行写入。

影响：

- 无意义网络请求
- 数据库写放大
- 版本号不断增加
- Sync Event 爆炸
- Cache 不断失效
- 多端产生大量无意义冲突
- 更严重时可能出现旧状态覆盖新状态

修复：建立 **Memory Change Detector**。只有 `meaningful_change == true` 才进入 `Persist → Sync → Invalidate`，否则 NO-OP。

### P0-3：不同 Memory Module 之间直接互相同步

错误方向：

```
Codex Memory
     ↕
ChatGPT Memory
     ↕
Claude Memory
     ↕
Cursor Memory
```

正确结构：

```
             ┌── Codex
             │
             ├── Claude
             │
             ├── ChatGPT
             │
             ├── Cursor
             │
             └── Other AI
                    │
                    ▼
             ┌──────────────┐
             │ Memory Core  │
             └──────────────┘
                    │
          ┌─────────┼─────────┐
          ▼         ▼         ▼
       Storage    Index     Sync
```

原则：

> 各 AI Adapter 不应该互相同步，只和 Canonical Memory Store 同步。

### P0-4：缺少 Canonical Memory

必须明确：谁才是真正的记忆源？不能让 Codex = Source、ChatGPT = Source、Claude = Source 同时成立。必须定义 **Canonical Memory**。所有 AI 端：`Read → Canonical Memory`、`Write → Canonical Memory`。本地缓存只是 Cache，而不是事实源。

### P0-5：并发写入存在竞态

典型问题：

```
09:00:01 Codex 读取 version=15
09:00:02 Claude 读取 version=15
09:00:03 Codex 修改 → version=16
09:00:04 Claude 修改 → version=16
```

如果没有版本检查，Claude 可能覆盖 Codex 的修改。

修复：采用 **Optimistic Concurrency Control**。至少保存 `memory_id / version / updated_at`。提交时：

```
UPDATE memory
SET ...
WHERE memory_id = ?
AND version = expected_version
```

如果 `affected_rows == 0`，说明发生冲突，不能直接覆盖。

### P0-6：记忆状态不能只有"存在/不存在"

建议 Memory 至少拥有：`id / user_id / type / content / confidence / source / created_at / updated_at / version / status`。

其中 status 至少支持：`active / superseded / deleted / pending`。

例如：用户以前喜欢 A → A = superseded；用户现在喜欢 B → B = active。不要简单地做 `A → delete、B → insert`，否则历史关系和状态变化难以追踪。

---

## 三、记忆召回准确性

不能简单采用 `semantic search → top-k`，因为不同问题需要不同记忆类别。例如"我最近在做什么？"和"我喜欢什么颜色？"虽然都是个人信息，但属于不同记忆范围。

建议 Recall 综合：

```
Intent + Memory Type + Semantic Similarity + Recency + Confidence + Explicitness
```

形成 **Recall Score**。

---

## 四、Memory 分类体系

第一版不要做几十种类型，建议先建立六类。

- **L1：Identity**——职业、长期身份、长期角色
- **L2：Preference**——喜欢什么、不喜欢什么、工作习惯、工具偏好
- **L3：Project**——当前项目、项目目标、技术栈、长期决策
- **L4：History**——过去做过什么、已经尝试过什么、以前做出的决定
- **L5：Constraint**——不要联网、不要使用某工具、必须兼容某版本、预算、禁止某种方案。**这一类非常重要，优先级应该很高**
- **L6：Temporary Context**——今天正在调试某个 bug、这轮正在讨论某个文件、当前任务。**这种内容不要直接作为长期 Memory，否则记忆库会迅速污染**

---

## 五、记忆触发判断规则

### T0：绝对不加载

明显属于：数学题、算法题、语言语法、通用知识、历史知识、物理知识、一般代码问题、一般概念解释。例如"TCP 和 UDP 有什么区别？"——直接回答，`Memory Access = NONE`。

### T1：强相关，必须召回

- "你知道我是做什么的吗？" → 召回 Identity
- "我之前那个游戏项目叫什么？" → 召回 Project + History
- "我之前为什么决定不用 Atlas 商业化？" → 召回 Project + History + Decision

### T2：个人相关，但只召回局部

"我现在应该用 UE 5.6 还是 5.5？"——这是技术问题，但用户自身项目上下文会明显影响答案。因此 `Memory = Project`，而不是 `Memory = ALL`。

### T3：疑似相关

"有没有适合我的游戏引擎学习路线？"——可以进行 **Light Recall**，只加载：当前游戏开发项目、技术栈、学习目标。

### T4：用户明确要求记忆

"记住，以后我的游戏项目都使用 Maya + UE。"——这是最高优先级：**Immediate Memory Write**。

---

## 六、Memory Trigger Matrix

| 类型 | Memory Read | Memory Write |
|---|---|---|
| 通用知识 | ❌ | ❌ |
| 数学/算法 | ❌ | ❌ |
| 普通代码语法 | ❌ | ❌ |
| 明确询问个人信息 | ✅ | ❌ |
| 个人偏好相关 | ✅ | 视变化 |
| 历史项目相关 | ✅ | 视变化 |
| 当前项目相关 | ✅ 局部 | 视变化 |
| 用户明确"记住" | ✅ 必要 | ✅ 立即 |
| 用户修改旧信息 | ✅ | ✅ |
| 普通闲聊 | 通常 ❌ | 通常 ❌ |
| 新的长期个人事实 | 视情况 | ✅ |
| 临时上下文 | 视情况 | ❌ 长期写入 |
| 通用问题但答案受个人约束影响（如「这工具能用吗」而用户有禁用约束/版本约束） | ✅ 仅 L5 Constraint | 视变化 |

---

## 七、关键边界：Router 不能先读取完整 Memory

错误：

```
Load Memory
    ↓
判断是否需要 Memory
```

这已经失去按需加载的意义。

正确：

```
User Message
    ↓
Memory Router
    ↓
判断 Memory Scope
    ↓
Recall Planner
    ↓
加载指定 Memory
```

Router 的主要输入：`current_user_message / conversation_context / system_metadata`。

Router 的输出：`NONE / IDENTITY / PREFERENCE / PROJECT / HISTORY / CONSTRAINT / MULTI_SCOPE`。

---

## 八、Recall 分层

不要 `Project → 全部加载`。应该：

```
Memory Index
     ↓
候选
     ↓
Ranking
     ↓
Top N
     ↓
Context Injection
```

例如"我之前那个游戏现在引擎用什么？"最终可能只需要：

```
Project: Engine = Unreal Engine 5.6.x
Project: DCC = Maya
```

而不是整个项目历史。

---

## 九、写入机制

不要 `整段聊天 → 上传`。应该：

```
AI Response
     ↓
Memory Change Detector
     ↓
Candidate Extraction
     ↓
Memory Validator
     ↓
Deduplication
     ↓
Conflict Detection
     ↓
Versioned Commit
```

---

## 十、事实与推测必须分离

例如 AI 认为"用户可能比较喜欢 UE"，不能直接写 `Preference: 喜欢 UE`，应该 `confidence = 0.55` 甚至 `pending`；只有明确程度足够高时才 `active`。而用户明确说"以后我都用 UE"，则 `confidence = 1.0`。

---

## 十一、写入必须幂等

网络重试（Write Memory → timeout → retry）不能产生多个重复 Memory。每个写操作必须拥有 `operation_id`；重复提交同一个 operation_id 只执行一次。

---

## 十二、Cache 与失效机制

推荐：

```
Memory Cache
key:   user_id + memory_id
value: memory content + version
```

读取时 `cache.version == store.version` 才认为有效。例如 version 15 → 16，自动 invalidate version 15。不要单纯依靠 TTL。正确：**Version-based invalidation + TTL fallback**。其中 Version 解决一致性，TTL 防止永久脏缓存。

> **版本真值核对 = 本机制的触发式落地**（对齐 AGENTS v3.1 第 51 行）：仅命中 T1–T4 或「最新版 / 审计」类请求时，在读前执行 `pull + ls-remote` 比对；**禁止定时 / 启动 / 调度自动化**等周期形态（Phase 6 已删 Session Start 全量 Load、Phase 12 已废除强制启动加载/强制结束上传）。新增版本核对流程须沿用此触发式，不得另设独立周期任务。
> doctor 含「消费端 conform 触发式禁令」探针（**仅检本端**消费记忆：WorkBuddy 侧 `MEMORY.md`；**Codex 端无机器检查——2026-08-16 审计实证 `sync-memory.ps1 -Doctor` 未实现 conform 探针，Codex 端对「版本真值核对/触发式/禁自动化」的遵从依赖协议自觉，属已知缺口**，各端不越界互检）；探针 FAIL = 阻断态（见 AGENTS v3.1 阻断态注），视为未 conform 到本加固，结论不可信。

---

## 十三、同步机制

最终结构：

```
             Memory Core
                  │
        ┌─────────┴─────────┐
        │                   │
   Canonical Store       Event Log
        │                   │
        └─────────┬─────────┘
                  │
               Sync Layer
        ┌─────────┼─────────┐
        ↓         ↓         ↓
      Codex     Claude    ChatGPT
```

事件类型：`MEMORY_CREATED / MEMORY_UPDATED / MEMORY_SUPERSEDED / MEMORY_DELETED`。

每个事件至少带：`event_id / memory_id / user_id / version / operation_id / timestamp / source`。

---

## 十四、异常路径

**情况 1：读取成功，AI 请求失败** —— 结果：不写 Memory。

**情况 2：AI 成功，Memory Write 失败** —— 用户回答不能失败：`Response = Success`、`Memory = Retry/Pending`。

**情况 3：Memory 写成功，Sync 失败** —— 必须：Canonical Store 保留、Sync Event 保留、Retry。不能回滚已经成功的 Canonical Memory。

**情况 4：两个客户端同时修改** —— Codex v15→v16，Claude v15→v16；Claude 提交时 Conflict，进入 Conflict Resolver，不能直接覆盖。

---

## 十五、资源生命周期与泄漏

如果客户端包含 watcher / WebSocket / HTTP session / DB connection / thread / async task / timer / event listener / cache，都必须明确 `Create → Use → Dispose`。尤其不要每轮 `new MemoryClient()` 却不释放。建议 `Application → Singleton / Pool → Memory Client`，并提供明确 `shutdown()`。

---

## 十六、完整实施顺序

> 各 Phase 在现有「文件 + git」架构下的落地状态：✅=已由等价机制满足；⚙️=协议层落地（AGENTS/MEMORY 规则）；◻=展望项（服务化后才需要）。

- **Phase 1：定义 Memory Contract**。目标：确定整个系统唯一的数据契约。输入：现有 Memory 数据结构。输出：统一定义 `Memory / MemoryType / MemoryVersion / MemoryEvent / MemoryCandidate / RecallResult`。预期结果：所有模块遵循统一 Contract。⚙️ 本文档+AGENTS v3 即为契约。
- **Phase 2：建立 Canonical Memory Store**。目标：解决多模块数据源不一致。必须完成：Canonical Store（version / status / operation_id / event_id）。预期结果：所有 AI Adapter 不再互相同步。✅ git 仓库=Canonical Store（见附录 A）。
- **Phase 3：实现 Memory Router**。输入：current message、conversation context。输出：memory_required、scope、priority。例如 `{"memory_required": true, "scope": ["project", "preference"], "priority": "high"}`。⚙️ AGENTS v3 第一节 T0–T4。
- **Phase 4：实现 Recall Planner**。输入：Router result。输出：memory IDs（不是所有 Memory）。⚙️ AGENTS v3 第二节 L1–L6 文件映射。
- **Phase 5：实现最小上下文注入**。输入：RecallResult。输出：AI Context。目标：只提供回答当前问题真正需要的个人信息。⚙️ 文件分级选读+标准三件套。
- **Phase 6：取消 Session Start 全量 Load**。删除 `Session Start → Load All`，改成 `Session Start → Nothing`；只有 `Router = relevant` 才访问 Memory。✅ 已于 2026-08-16 v2 落地。
- **Phase 7：实现 Memory Change Detector**。输入：当前会话。输出：`NO_CHANGE / NEW_MEMORY / UPDATE_MEMORY / SUPERSEDE_MEMORY / DELETE_MEMORY`。✅ ps1 staged 空检查 +「仅改动才上传」。
- **Phase 8：实现 Versioned Write**。必须支持：optimistic locking、idempotency、conflict detection。✅ git 非快进拒绝 + staged 幂等 + merge 冲突处理。
- **Phase 9：实现 Sync Event**。只有 Canonical Store changed 才产生 Memory Event。✅ git push + git log（事件流）。
- **Phase 10：Cache Invalidation**。执行：write → version++ → emit event → invalidate cache。⚙️ 读前 pull 版本校验（AGENTS v3 第三节）。
- **Phase 11：异常恢复**。重点测试：network timeout、database failure、AI failure、sync failure、duplicate write、concurrent write、partial failure、process crash。✅ .sync-failed / .pending-writeback / 冲突快照 / trap 已覆盖（08-16 三轮审计验证）。
- **Phase 12：真正删除旧机制**。最后删除强制启动加载、强制结束上传，避免新旧两套机制并存。✅ 已于 2026-08-16 v2 删除。

---

## 十七、最终推荐架构

```
                  User Message
                       │
                       ▼
                ┌─────────────┐
                │Memory Router│
                └──────┬──────┘
                       │
              ┌────────┴────────┐
              │                 │
            NONE             RELEVANT
              │                 │
              ▼                 ▼
          Normal AI       Recall Planner
                                │
                                ▼
                         Memory Retrieval
                                │
                                ▼
                         Minimal Context
                                │
                                ▼
                             AI Core
                                │
                                ▼
                          AI Response
                                │
                                ▼
                     Memory Change Detector
                                │
                      ┌─────────┴─────────┐
                      │                   │
                   NO CHANGE           CHANGED
                      │                   │
                      ▼                   ▼
                    DONE            Candidate Memory
                                          │
                                          ▼
                                     Validation
                                          │
                                          ▼
                                    Dedup / Conflict
                                          │
                                          ▼
                                  Versioned Commit
                                          │
                               ┌──────────┴──────────┐
                               ▼                     ▼
                          Canonical Store        Event Log
                                                     │
                                                     ▼
                                                 Sync Layer
                                                     │
                                  ┌──────────────────┼─────────────────┐
                                  ▼                  ▼                 ▼
                                Codex              Claude            ChatGPT
```

---

## 十八、验收标准

- **A. 无关问题**："1+1 等于多少？" → 必须 `Memory Read = 0、Memory Write = 0`。
- **B. 个人身份问题**："你知道我是做什么的吗？" → 必须 `Memory Router = Relevant、Identity Recall = true`，且不能加载全部 Memory。
- **C. 项目问题**："我之前那个游戏项目现在用什么引擎？" → 必须只召回 Project。
- **D. 明确记忆**："记住，以后我的游戏项目使用 Maya + UE。" → 必须 `Memory Write = 1、version +1、event = MEMORY_CREATED / MEMORY_UPDATED`。
- **E. 无变化**：用户连续问"UE 蓝图是什么？" → 不能产生 Memory Write、Sync Event、Cache Invalidation。
- **F. 并发**：Client A v10、Client B v10 → 必须 `A → v11 SUCCESS、B → CONFLICT`；不能 B 覆盖 A。
- **G. 重试**：同一个 operation_id 重复提交 5 次 → 只产生一个 Memory Mutation。
- **H. Sync Failure**：Store = SUCCESS、Sync = FAILURE → 最终 Memory 不丢、Event 不丢、可以 Retry。
- **I. Cache**：v10 cache → store v11 → 再次读取不能返回 v10。

---

## 十九、八条最终设计原则

1. **Memory 不再是 Session 的默认上下文**——默认不加载。
2. **Router 决定是否访问 Memory**——Message → Router → Recall。
3. **Recall 必须是最小集合**——Relevant Memory ≠ All Memory。
4. **Canonical Store 是唯一事实源**——AI Adapter ≠ Memory Source。
5. **所有写入必须版本化**——version + optimistic lock。
6. **所有写入必须幂等**——operation_id。
7. **Cache 服从 Canonical Store**——Cache ≠ Source of Truth。
8. **没有变化就什么都不做**——NO_CHANGE → NO_WRITE → NO_SYNC → NO_INVALIDATION。

---

## 二十、最终修正版：Cross Memory System vNext

```
Memory Access Policy

默认：NO MEMORY
触发：Memory Router 判断个人相关性
读取：按 Scope + Relevance + Confidence + Recency 最小召回
写入：只有明确新增/修改/删除个人记忆才执行
明确"记住"：高优先级立即进入 Memory Write Pipeline
持久化：Canonical Memory Store
并发：Optimistic Lock + Version
重复请求：Idempotency Key
同步：Event-based Sync
缓存：Version Invalidation + TTL Fallback
异常：Store / Sync / AI / Network 分离处理
生命周期：明确 Client / Connection / Worker / Listener / Timer 的创建和释放
默认行为：无个人关联 → 完全不碰 Memory
```

---

## 二十一、下一阶段：代码级审计

以上是架构级核心方案。真正进入工程实施后，应把现有仓库中的 Core / Memory / Sync / Adapter / Storage / Cache / Router / Recall / Persistence 逐个对照本架构进行代码级审计。每一个实际问题统一记录：文件、函数/类、问题、严重程度、触发条件、影响、根因、修复方案、修改顺序、回归测试。

最终目标不是在旧的"启动加载 / 结束上传"机制上继续修补，而是将系统真正收敛为：

```
按需读取 + 最小召回 + 按需写入 + Canonical Store + Versioned Memory
+ Event Sync + Cache Invalidation + Conflict Resolution + 异常可恢复
```

这套机制可以作为 Cross Memory System 的核心架构基线。

---

## 附录 A：现有实现映射（保留 / 调整 / 替换）

本系统当前为「文件 + git 私有仓库」架构，无服务端数据库。vNext 抽象概念按下表映射到现有机制；凡标注「保留」者即已由等价机制满足基线要求。

| vNext 概念 | 现有实现 | 处置 | 说明 |
|---|---|---|---|
| Canonical Memory Store | GitHub 私有仓库 tdoljyj/cross-memory-system（`memory/*.md` + git 对象库，唯一数据源） | **保留** | 已合规：各端工作区只是 Cache/镜像，不是事实源（基线原则 4、7） |
| AI Adapter | Codex（sync-memory.ps1）/ WorkBuddy（sync-memory.py） | **保留** | 双端不互相同步（「不越界」规则），只与仓库同步（P0-3 已合规）。vNext-1.2 起 py 侧支持 sync.config.json 参数化；commit 在写入工作区后、push 前执行（Codex 因工作区非 git 克隆由脚本代 commit，WorkBuddy 因工作区即克隆由使用方 commit） |
| Memory Router | AGENTS.md / MEMORY.md 的触发分类 | **调整** | 术语重写为 T0–T4（见基线第五节），替换 2026-08-16 04:05 的五类触发表述 |
| Recall Planner + 分层召回 | 文件分级选读 | **调整** | L1–L6 → 具体标题段映射的权威源固化为 `memory/index.json`（`schema_version: 1`，`recall` 字段）；AGENTS.md v3.1 表为其人类可读摘要，由 `tests/test_acceptance.py` 校验一致性 |
| Memory Trigger Matrix | 无 | **新增** | 基线第六节矩阵纳入 AGENTS.md v3 |
| Memory Change Detector | ps1 staged 空检查（无变化 → skip commit）/ py 脏检查 / 「仅改动记忆文件才上传」 | **保留** | 已合规：NO_CHANGE → NO_WRITE → NO_SYNC（基线原则 8） |
| Versioned Commit | git commit/push + ls-remote 核验 | **保留** | git commit hash = version；push 后 ls-remote 核验 = 版本校验 |
| Optimistic Concurrency Control | fetch + merge（非 rebase）+ 非快进拒绝 + 冲突快照 + 重试一轮 | **保留** | git 非快进拒绝 ≡ `affected_rows == 0` 冲突语义（P0-5 已合规）；push/pull 后核验统一为 `merge-base --is-ancestor`（祖先判定，非 `==` 比较） |
| 幂等写入（operation_id） | `git add -A` + staged 空检查（相同内容不重复提交） | **保留** | 天然幂等：同一内容重复提交 → staged 为空 → NO-OP |
| Sync Event / Event Log | git push + git log（commit message 带身份与变更文件） | **保留** | git log = 事件流；事件类型映射为 commit 语义 |
| Cache Invalidation | 读前对齐（命中加载时先 pull）+ ls-remote 版本比较 | **调整** | 显式声明：本地镜像 = Cache，version = commit hash；读前必须验证 cache.version == store.version（pull 即 invalidate + 重取），不满足则重取 |
| status（active/superseded/deleted/pending） | 决策.md「已确认/已否决/搁置」+ 归档.md | **调整** | 引入 superseded 语义：旧结论被推翻时不删除，标注 superseded 并在归档留存（P0-6） |
| confidence（事实与推测分离） | 无 | **调整** | 写入纪律新增：用户明确表达 → 直接写入；AI 推测 → 标注「（推测）」或不写，禁止把推测写成事实（基线第十节）。数值化 confidence 评分为展望项，现有架构用「（推测）」标注替代 |
| L6 Temporary Context | 「只沉淀稳定长期信息」规则 | **保留** | 已合规：临时上下文不入长期记忆。落地映射：L6 只存在于各端会话内/工作区工作文件（如待办推进中的草稿、本轮调试状态），不进入 `memory/*.md` 五文件 |
| Recall Score（Intent+Similarity+Recency+Confidence+Explicitness 打分） | 无 | **展望** | 现有架构无检索引擎，召回由 L1–L6 文件映射直接决定；打分排序是服务化后的优化项，现阶段不得为此引入组件 |
| 异常路径（情况 1–4） | .sync-failed / .pending-writeback / 冲突快照 / merge --abort / 顶层 trap | **保留** | 四种异常路径均有对应机制（08-16 三轮审计验证）；删除传播护栏现由 `memory/index.json` 的 `files` 清单驱动（文件缺失或为空即拒绝同步），不再硬编码文件数 |
| 资源生命周期 | subprocess.run 上下文管理 / TcpClient Close+Dispose / with 块 | **保留** | 三轮审计验证无泄漏 |
| 服务端组件（DB / Event Bus / WebSocket） | 不适用 | **不引入** | 个人级系统维持文件+git 架构；vNext 抽象概念以 git 等价机制满足，不为此引入服务端组件 |

## 附录 B：验收标准落地对照（基线第十八节 → 现有可验证行为）

| 用例 | 基线要求 | 现有系统的验证方式 |
|---|---|---|
| A 无关问题 | Read=0、Write=0 | 通用问答不执行 pull、git log 无新提交 |
| B 身份问题 | Router=Relevant、只召回 Identity | pull 后仅读 画像.md |
| C 项目问题 | 只召回 Project | 仅读 状态.md / 画像.md 技术栈段 |
| D 明确"记住" | Write=1、version+1、event | 立即写入 + commit + push，git log 出现新 commit |
| E 无变化 | 无 Write / Sync / Invalidation | ps1 输出 "No memory changes; skip commit" |
| F 并发 | 后到者 CONFLICT 不覆盖 | push 非快进拒绝 → fetch+merge → 重推（08-15 22:40 已实测）。⚠️ 许可偏差：现有架构的冲突收敛方式是 **merge（保留两端语义）** 而非「后到者整体失败」——这满足基线的核心不变量「后到者不得覆盖先到者」（A 的变更不丢），且更符合记忆系统的追加型语义；服务化后可改为严格 OCC 冲突拒绝 |
| G 重试幂等 | 同一操作只产生一次变更 | staged 为空 → skip commit |
| H Sync 失败 | Memory/Event 不丢、可 Retry | .sync-failed 标记 + 下次开场提醒重推（已多次实测） |
| I Cache | 不返回旧版本 | pull 前 ls-remote 核验，不一致即重取 |

## 附录 C：隐私与安全约束（vNext-1.1 新增）

原架构文档未定义隐私边界，此处补齐。全部为硬约束：

1. **最小写入**：只沉淀稳定长期信息；一次性对话细节、临时凭证、密码、令牌、私钥绝不入记忆文件。
2. **仓库私有**：记忆仓库保持 GitHub 私有；如需公开，只发布去敏模板版，真实记忆不进公开仓库（决策.md 已确认）。
3. **按需读取即隐私默认**：T0 类问题不访问记忆 = 不读取个人数据；Memory Router 的判断必须在读取之前完成（第七节）。
4. **日志脱敏**：同步脚本输出、commit message、审计记录不得包含令牌等敏感值；doctor/审计展示凭证时一律截断或掩码。
5. **删除权**：用户要求删除某条记忆时，走 superseded/删除流程并 commit，git 历史中的旧版本视为受保护的审计痕迹，不再召回；如需彻底清除历史，另行评估（rewrite history 与四不变量冲突，需用户明确批准）。
6. **不越界**：各端不读取、不写入其他端的工作区与私有文件（双端对称「不越界」规则的隐私含义）。

## 附录 D：修订落地对照（保留 / 调整 / 替换 / 待办）

本附录记录各版本的落地清单，作为「明确保留、调整、替换」的权威记录。下表为 vNext-1.1 → vNext-1.2 的清单；vNext-1.2 → vNext-1.3 的清单见文末「vNext-1.3 追加」。凡未在本表出现的既有机制，默认维持前一版本状态不变。

| 修订项 | 处置 | 涉及文件 | 落地状态 |
|---|---|---|---|
| Canonical Store / Change Detector / OCC / 幂等 / Sync Event / 异常恢复 | 保留 | 不变 | ✅ 维持，机制等价 |
| 删除传播护栏（源 memory 目录 .md<5 拒绝同步） | 调整（新增护栏） | sync-memory.ps1 / sync-memory.py | ✅ 已落地 |
| 双脚本核验统一为祖先判定 | 调整 | sync-memory.py | ✅ 已落地（ps1 原本即祖先判定） |
| py 配置参数化（sync.config.json，gitignored） | 调整 | sync-memory.py / .gitignore | ✅ 已落地 |
| 召回粒度：文件级 → 段级（L1–L6 映射到具体标题段） | 调整 | AGENTS.md / ~/.codex/AGENTS.md | ✅ 已落地 |
| Sync Layer 与 commit 职责边界 | 调整（明确化） | 附录 A / README / AGENTS.md | ✅ 已落地 |
| 全局钩子副本对齐 | 调整 | ~/.codex/AGENTS.md | ✅ 已落地 |
| PortableGit 硬阻断（ps1 push/pull） | 调整（新增） | sync-memory.ps1 | ✅ 已落地 |
| TEMP 备份目录清理（>7 天） | 调整（新增） | sync-memory.ps1 / sync-memory.py | ✅ 已落地 |
| 全仓脏检查（非阻断提示） | 调整（新增） | sync-memory.ps1 / sync-memory.py | ✅ 已落地 |
| 归档.md 瘦身阈值提示 | 调整（新增） | 双脚本 doctor | ✅ 已落地 |
| py pull 代理预检 | 调整（新增） | sync-memory.py | ✅ 已落地 |
| 协议新鲜度检查（MEMORY.md 无 pull --rebase） | 调整（新增） | sync-memory.py doctor | ✅ 已落地 |
| per-clone 配置 bootstrap（-Bootstrap / bootstrap） | 调整（新增） | sync-memory.ps1 / sync-memory.py | ✅ 已落地 |
| 附录 B 验收标准转自动化测试 | 调整（新增） | tests/test_acceptance.py | ✅ 已落地（8 用例，无第三方依赖） |
| 结构化语义合并（状态/待办按标题块三路合并） | 待办 | 双脚本 | ◻ 待实现 |
| 归档.md union 合并后去重 | 待办 | 双脚本 | ◻ 待实现（瘦身阈值已单独落地） |
| Recall Score / item 级检索 | 展望 | 不引入组件 | ◻ 服务化后再评估 |
| 凭据按 AI 隔离 / 缓存 TTL 兜底 | 展望 | — | ◻ 未来接入多机再评估 |

### vNext-1.3 追加（vNext-1.2 → vNext-1.3，2026-08-16）

| 修订项 | 处置 | 涉及文件 | 落地状态 |
|---|---|---|---|
| 结构化召回索引 memory/index.json（files + L1–L6 recall） | 新增 | memory/index.json / AGENTS.md / tests/test_acceptance.py | ✅ 已落地 |
| 同步护栏由硬编码 5 → 读 index.json files 清单 | 调整 | sync-memory.ps1 / sync-memory.py | ✅ 已落地 |
| redact() 令牌掩码 + 长期令牌环境变量 doctor 提醒 | 新增 | sync-memory.ps1 / sync-memory.py | ✅ 已落地 |
| 凭据接入指引：git 走 gh 凭据助手，不 setx 长期令牌 | 调整 | README.md | ✅ 已落地 |
| 验收测试 8 → 10 用例（index.json 校验 / redact / missing-index 护栏） | 调整 | tests/test_acceptance.py | ✅ 已落地 |
| 消费端 conform 触发式禁令探针（doctor）+ 纯函数单测 consumer_conformed | 新增 | sync-memory.py doctor + tests/test_acceptance.py | ⚠️ 部分落地（仅 WorkBuddy 端 `MEMORY.md` 探针；Codex 端 ps1 无实现，见 changelog「conform 缺口显式化」） |
