# Cross Memory System vNext · 架构基线文档 vNext-2.0

> **基线版本**：vNext-2.0（2026-08-17 确立，DSH@TURING 按执行计划《Cross-Memory-System_vNext-2.0_执行计划.md》实施）
> **上一基线**：《架构基线文档-vNext-1.3.md》（2026-08-16 封版，vNext-1.3 Stable Baseline，保留为历史基线，一字未改）
> **适用范围**：跨端记忆系统全部实现与协议文档——本仓库、Codex 端（sync-memory.ps1）、WorkBuddy 端 / DSH 端（sync-memory.py + Memory Engine）、未来新接入端
> **权威性**：本文档是 vNext-2.0 规范；与 v1.3 文档冲突时以本文档为准；v1.3 的同步层四不变量、护栏契约、Trigger Matrix、L1-L6、写入纪律全部继续有效（本文档只增不改）
> **实施冲突记录**：见 `vNext-2.0-实施冲突记录.md`（C1–C9）

## 变更记录

| 版本 | 日期 | 变更内容 | 操作方 |
|---|---|---|---|
| vNext-2.0 | 2026-08-17 | Memory Engine Architecture 落地：Memory Object Layer（memory/objects/ + Schema v1）、Memory Lifecycle（candidate/active/superseded/archived/rejected）、Write Engine（NO_CHANGE/NEW/UPDATE/SUPERSEDE/DELETE + 去重/冲突裁决）、Recall Engine（T0-T4 → L1-L6 → 确定性混合召回）、Temporal（valid_from/until）、Conflict Resolver（证据优先级梯）、Consolidation（Episodic→Semantic）、Procedural Memory、Object Index（memory/object-index.json 派生索引 + rebuild）、Memory Audit（memory/audit/audit.log）、Engine Doctor（17 项检查）、Migration（migrate-memory.py dry-run/validate/migrate/rollback）、CLI（memory.py）、Adapter Interface（adapters/，MemoryAdapter 统一接口）。同步层（sync-memory.py/ps1）零改动；旧测试 70 项 + 新测试 55 项全绿 | DSH@TURING |

---

## 一、目标与定位

vNext-1.3 解决的是「记忆如何可靠地存在和同步」；vNext-2.0 解决的是：

> **AI 到底应该记住什么、什么时候想起什么、什么应该被更新、什么应该被遗忘，
> 以及如何保持这些判断长期一致。**

vNext-2.0 不是「一个能同步 MEMORY.md 的工具」，而是：

> **一个跨 AI、跨设备、可审计、可演化、具备生命周期管理和选择性召回能力的个人长期记忆引擎。**

## 二、目标架构（Memory Engine 位于同步层之上）

```text
AI Adapter（adapters/，统一接口 MemoryAdapter）
    ↓
Memory Router（T0–T4，AI 行为，引擎消费 tier）
    ↓
Recall Engine / Write Engine（memory_engine/）
    ↓
Memory Object Layer（memory/objects/*.json + Memory Lifecycle）
    ↓
Canonical Store（git 私有仓库 tdoljyj/cross-memory-system）
    ↓
Git Sync Layer（sync-memory.py / sync-memory.ps1，vNext-1.3 稳定基线）
```

硬约束：
- Git Sync Layer 仍是最底层；Memory Engine 不执行 git commit/push，一切持久化经 Sync Layer
- 旧 Markdown 五文件与 L1-L6 召回映射仍有效（第一阶段 = Object + Markdown 双写，
  Markdown 为 legacy canonical；第二阶段 Object 为 canonical、Markdown 为 projection，
  切换前必须提供 migration tool + rollback——本阶段已提供 migrate-memory.py）
- 不引入向量数据库 / embedding / 外部 Memory SaaS / 服务端组件（§18 纪律）

## 三、Memory Object Schema v1

`memory/objects/mem_<id>.json`，最小字段：

```json
{
  "schema_version": 1,
  "id": "mem_0123abcd",
  "type": "semantic",
  "scope": "global",
  "content": "用户偏好高信息密度、少废话的回答方式",
  "status": "active",
  "source": {"kind": "user_explicit", "adapter": "memory-engine",
             "session_id": null, "created_at": "...", "updated_at": "..."},
  "temporal": {"valid_from": null, "valid_until": null},
  "relations": {"supersedes": [], "superseded_by": [], "contradicts": [], "related": []},
  "classification": {"memory_layer": "semantic", "category": "preference",
                     "recall_layer": "L2", "priority": "high"},
  "provenance": {"evidence": "explicit", "source_ref": null},
  "tags": [], "entities": []
}
```

枚举与语义（实施冲突记录 C1 已裁决）：

| 字段 | 枚举 | 说明 |
|---|---|---|
| type | foundational / semantic / episodic / procedural / state / temporary | Memory Function Type（§5 双维度之「认知层」） |
| scope | global / project / session / agent / machine | 第一阶段参与逻辑：global/project/session；agent/machine 仅 metadata |
| status | candidate / active / reinforced / superseded / archived / rejected / expired / deprecated | 生命周期（§6） |
| classification.category | identity / preference / negative_preference / project / state / decision / history / event / constraint / workflow / toolchain / method / todo / other | 内容类别 |
| classification.recall_layer | L1–L6 | Recall Routing 维度（L1-L6 保持 v1.3 语义） |
| classification.priority | high / medium / low | |
| provenance.evidence | explicit / observed / inferred | 优先级 explicit > observed > inferred；inferred 不得直接升级为长期事实 |
| source.kind | user_explicit / user_implicit / observed / ai_inferred / migration / system / unknown | |

第一阶段无 numeric confidence（枚举替代）；数值化 confidence 仍为展望项。

## 四、Memory Lifecycle

```text
CANDIDATE → ACTIVE → REINFORCED → SUPERSEDED → ARCHIVED
    │          │          │            │
    ▼          ▼          ▼            ▼
REJECTED   EXPIRED   DEPRECATED   ARCHIVED
```

规则：
1. 对话中的新信息默认不是 ACTIVE（observed/inferred → candidate）
2. 用户明确要求「记住」（T4）→ 直接 ACTIVE；evidence=explicit → active
3. 用户明确纠正旧记忆 → UPDATE 或 SUPERSEDE
4. 被推翻的旧记忆不删除：status=superseded + temporal.valid_until=now
5. 新记忆 relations.supersedes 记录旧 id；旧记忆 superseded_by 反向记录
6. retrieval 默认不返回 superseded/archived/expired/deprecated/rejected
7. history 查询允许返回 superseded/archived/expired/deprecated

## 五、Write Engine

判定输出：NO_CHANGE / NEW_MEMORY / UPDATE_MEMORY / SUPERSEDE_MEMORY / DELETE_MEMORY。

流程：Candidate Detector → Candidate Memory → Existing Memory Lookup → Deduplication →
Conflict Detection → Lifecycle Decision → Write Operation → Canonical Store。

核心原则：不是「发现一句重要话 → 写进去」，而是「这句话是否改变了长期模型」。

四种场景（§8）：
- A 全新记忆 → NEW_MEMORY（evidence 决定 initial status）
- B 重复记忆（相似度 ≥ 0.85 或等价）→ NO_CHANGE，零副作用（不写对象/审计/索引）
- C 明确改变 → SUPERSEDE_MEMORY（旧 superseded，新 active，relations 链接）
- D 否决 → constraint / negative_preference + 与 X 建立关系，未来召回附带过滤

护栏：inferred 永不覆盖 explicit/observed（裁决后拒绝写入）；对象写入前做 guards.json
凭据样值扫描；DELETE = archive（不物理删除）；NO_CHANGE → NO_WRITE → NO_SYNC。

## 六、Conflict Resolver

冲突类型：同一事实不同值 / 同一 preference 反向 / 项目状态冲突 / 决策冲突 /
时间冲突 / 用户明确纠正 AI。

裁决优先级（§9）：

```text
用户当前明确表达 > 用户历史明确表达 > 用户长期稳定偏好 > 用户实际行为 > AI inference
```

实现：evidence 优先级 + 时间戳（同级别新者胜）；时间范围不相交 = 不同时期记忆（互不冲突）；
偏好极性反转（否定词标记）或引入新值实体 = 值变更/反向 → SUPERSEDE；
同实体细化（无新值实体、无极性反转）→ UPDATE。禁止 delete old + insert new。

## 七、Recall Engine（确定性混合召回）

流程：Query → T0-T4 Router → L1-L6 coarse routing → Candidate retrieval →
Metadata filtering → Temporal validity → Status filtering → Conflict filtering →
Relevance ranking → Context packing。

- T0：零文件读取纯短路（access=NONE，不碰 index.json / objects，§17 硬约束）
- T1：L1（identity/foundational）；T2：L3（project/state/decision）；
  T3：L3 light（仅 priority=high，≤3 条）；T4：Immediate Write 提示（走 Write Engine）
- Markdown 段级召回计划（memory/index.json recall 映射）与对象召回并行输出（双写兼容）
- 匹配模式：exact / keyword（CJK bigram + ASCII token）/ category / tag / entity /
  temporal / status / priority；排序确定性：score > priority > evidence > updated_at
- 冲突过滤：当前召回只保留竞争事实的胜者；历史查询返回全部版本
- 约束附带：返回对象实体的 constraint/negative_preference 一并输出（供推荐过滤）
- 不引入 Qdrant/Chroma/Pinecone/Neo4j/Redis/外部 SaaS；任何向量索引未来只能是
  LOCAL DERIVED INDEX，绝不能成为 Canonical Store

## 八、Temporal Memory

valid_from / valid_until / created_at / updated_at。「我现在用什么」只返回当前
active+valid；「以前用过什么」允许返回历史。旧记忆不删除（CURRENT vs HISTORY）。

## 九、Consolidation 与 Procedural Memory

- Consolidation：Episodic → Semantic；必须保留 Episode 原始证据（relations.related）；
  证据 ≥ 阈值（默认 2）→ active，不足 → candidate；已有同类 Semantic → REINFORCE 合并。
- Procedural：type=procedural + category ∈ {workflow, toolchain, method}，记录
  「如何帮助这个用户完成事情」，按 tags/entities 任务锚点召回。

## 十、Object Index（派生索引）

`memory/object-index.json`：id/path/type/scope/status/priority/category/tags/entities/
valid_from/valid_until/supersedes/superseded_by。**Memory Object 本身是事实源，
index 是派生索引；不一致时 Object 优先**；doctor 必须能重建（rebuild-index / --fix）。

## 十一、Memory Audit

`memory/audit/audit.log`（JSON Lines，追加式）：memory_id / operation / timestamp /
adapter / reason / previous_status / new_status / session_id。不存敏感对话全文。
git 历史为最终审计真相源。

## 十二、Engine Doctor（17 项检查）

object schema validation / duplicate memory (active) / broken relation /
dangling supersedes / invalid status / invalid temporal range /
object-index mismatch / missing object file / orphan object file /
Markdown/Object divergence / forbidden secrets / invalid scope /
invalid memory type / invalid evidence / superseded not returned by recall /
current memory conflict / stale derived index（WARN，--fix 重建）。

判定 PASS/WARN/FAIL，任一 FAIL → exit 1。同步层阻断态（真分叉/远端不可达/conform 缺失
→ blocking FAIL）继续由 sync-memory.py doctor 承担（实施冲突记录 C3）。

## 十三、Migration

`migrate-memory.py --dry-run / --validate / --migrate / --rollback`。扫描画像/状态/
决策/待办/归档五文件，识别 identity/preference/project/decision/constraint/history；
用户明述（画像、决策）→ explicit → active；AI 记录（状态/归档/待办）→ observed →
candidate + manual-review；不确定绝不自动升级。id 由 source_ref+content 哈希派生（幂等），
rollback 只删本次迁移创建的对象（manifest 记录）。先 dry-run 再写入。

## 十四、CLI 与 Adapter Interface

- `python memory.py status / doctor [--fix] / recall "query" / add / update /
  supersede / consolidate / procedural / rebuild-index / migrate / delete / reject / audit`
- `adapters/interface.py`：MemoryAdapter 统一接口 read/recall/write/update/supersede/status；
  Adapter 不得直接修改 Canonical Store，必须 Adapter → Memory Engine → Sync Layer；
  本阶段只有 CLIAdapter，不实现 ChatGPT Adapter（后续 ChatGPT/Claude/Cursor 走统一接口）。

## 十五、vNext-1.3 全部保留项（本基线只增不改）

Canonical Store = GitHub 私有仓库；local memory = cache；T0 不读；T1-T4 按需召回；
T4 立即写入；NO_CHANGE → NO_WRITE → NO_SYNC → NO_INVALIDATION；superseded 不简单删除；
不 rebase、不 force push；版本真值核对 = 触发式、禁自动化；memory/index.json 是
recall mapping 事实源；同步脚本不越界提交；令牌脱敏；doctor 红旗 = 阻断态；
四不变量、护栏契约（protocol-manifest.json）、不越界纪律全部不变。

## 十六、验收标准（执行计划 §28）

新记忆 / 重复记忆 NO_CHANGE / 更新 supersede / 当前偏好只返回 active /
历史查询找到旧记忆 / 项目状态 / 跨 Adapter 同一 Canonical Memory /
T0 Memory Access = NONE 零读取 / 项目问题只读对应 project / 「记住」立即写 /
审计可追溯 / 远端变化不允许 stale cache 静默作为事实 / orphan → doctor FAIL /
index rebuild → PASS / 全部 v1.3 测试 100% PASS。

测试：`python tests/test_acceptance.py`（v1.3，70 项）+ `python tests/test_memory_v2.py`
（v2.0，55 项）。最终：旧测试全部 PASS + 新测试全部 PASS。

## 十七、最终设计原则（执行计划 §27，18 条全保留）

Memory != Chat History；Memory != RAG；Memory != Vector Database；
Git != Memory Engine；Markdown != 唯一记忆模型；Recall != Full Load；
New information != New memory；Inference != Fact；Current != History；
Superseded != Deleted；Episodic != Semantic；User preference != Project state；
Adapter != Canonical Store；Derived index != Source of Truth；Sync != Recall；
Recall != Write；T0 必须真正零读取；不因引入 Memory Engine 破坏 vNext-1.3 安全护栏。
