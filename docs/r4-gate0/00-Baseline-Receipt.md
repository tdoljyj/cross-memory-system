# Clued R4 Gate 0-A · Live Baseline 与冻结证据收据

- 收据版本：`R4-G0-A-RECEIPT-v1.0`
- 生成时间：2026-08-20T20:45Z（UTC）
- 阶段：`Clued R4 Gate 0 · Semantic Recall Quality Closure` 的 Gate 0-A 阶段
- 计划文档：`Clued_R4_Gate0_语义召回质量收口_详细执行计划.md`（R4-G0-PLAN-v1.0）

> 本收据只证明「执行起点真实、干净、可重放」。它不授权 push、tag、release、
> 修改真实 Binding、下载模型或 R4-1 全面实施。Gate 0-B 起的所有写操作与供应链
> 动作需产品所有者按计划 §14.1 另行确认。

---

## 1. Result（起点判定）

**起点条件成立 → Gate 0-A 通过，可申请进入 Gate 0-B（待产品所有者确认供应链授权）。**

| 起点条件 | 要求 | 实测 | 判定 |
|---|---|---|---|
| local HEAD == origin/main | 相等 | `286e637f0f406b9c92e1307b04cea84ec2da8bd1` == 同值 | ✅ |
| ahead/behind | `0/0` | `0	0` | ✅ |
| worktree | clean | 仅新增 `docs/r4-gate0/`（本收据自身） | ✅ |
| branch | main | main | ✅ |
| 真实 Binding | ACTIVE/ONLINE/ENFORCED | 三轴一致 | ✅ |
| 完整测试 | 与基线一致 | 448/0/94/0，SKIP 归因一致 | ✅ |
| secret scan / 保护区 diff | 0 | 0 命中 / 0 diff | ✅ |

---

## 2. Live Repository Truth

| 项 | 值 |
|---|---|
| Repository | `tdoljyj/cross-memory-system` |
| remote | `https://github.com/tdoljyj/cross-memory-system.git` |
| `origin/main`（ls-remote 权威） | `286e637f0f406b9c92e1307b04cea84ec2da8bd1` |
| local HEAD（rev-parse） | `286e637f0f406b9c92e1307b04cea84ec2da8bd1` |
| ahead/behind | `0 / 0` |
| branch | `main` |
| worktree | clean（仅新增 `docs/r4-gate0/`） |
| VERSION 文件 | `vNext-2.0` |
| tags | `clued-v0.1.0`, `clued-v0.2.0`, `vNext-1.3`, `vNext-2.0` |
| 最新提交 | `286e637 docs(r3): archive Trial 4 pilot validation` |

真值核验方法：`git ls-remote origin main`（远端权威）+ `git rev-parse HEAD`（本地）+
`git rev-list --left-right --count <hash>...HEAD`（ahead/behind）+ `git status --porcelain`（worktree）。

---

## 3. Current Binding Truth

| 项 | 值 |
|---|---|
| Binding | `codex-workbuddy-windows-primary` |
| 构件 revision | `a41861835d989feed4008b7ac31bd34a901bf251` |
| 三轴状态 | `ACTIVE / ONLINE / ENFORCED` |
| 权威来源 | `.clued/bindings/codex-workbuddy-windows-primary/state.json` |
| 本轮是否修改 | **否**（Gate 0-A 全程只读真实 Binding） |

> 注：`.truth-state/codex-workbuddy-windows-primary.json` 内的 `capability_claim=ADVISORY`
> 是 trial4-conformance 阶段的旧缓存，非权威；权威三轴以 `.clued/bindings/.../state.json`
> 的 `binding=ACTIVE / session=ONLINE / truth=ENFORCED` 为准。

---

## 4. Doctor 三件套

### 4.1 `python memory.py doctor`（引擎 17 项）

**ALL PASS（0 WARN）。** objects：total=230（candidate=147, active=83），audit=230。

### 4.2 `python sync-memory.py doctor`（同步层）

**1 FAILURE（已知环境问题，非真值漂移）。** 关键行：

- `[PASS] remote reachable（286e637…）`
- `[PASS] local head readable（286e637…）`
- `[PASS] tracking ref valid`（在非沙盒下；沙盒下为 AUTO-HEALED）
- `[FAIL] ref write persists (behavior probe)（read back: refs/remotes）`
- `[PASS] working tree clean`
- `[PASS] local == remote（一致（SYNCED））`

**根因分析（实测，非推断）**：`git update-ref` 对**两层 ref**（`refs/remotes/origin/*`）
在 git `2.55.0.windows.3` + 当前 Windows 文件系统下 **exit 0 静默失败且不写文件、清空父目录**
——对照实验：`git update-ref refs/heads/doctor-test`（一层 ref）写入/删除均正常。此坑已由
`sync-memory.py` 第 13 行注释明示，并有 `write_ref()`（Python 直写 ref 文件）兜底。

**兜底验证（非沙盒）**：Python 直写 `refs/remotes/origin/main` 后，`git rev-parse` 读回
`286e637…`，`git rev-list --left-right --count origin/main...HEAD` 返回 `0 0`。真值一致。

**判定**：该 FAIL 是**系统级机制缺陷**（git 2.55 两层 ref 静默失败），已由代码兜底覆盖；
`local == remote`（SYNCED）与 worktree clean 均 PASS，真值经 `ls-remote` 独立核验，**不构成阻断态**。

### 4.3 `sync-memory.ps1 -Doctor`（Codex 端）

在 WorkBuddy 镜像（`~/.workbuddy/codex-memory-system`）内被 **deploy-guard 正确拒绝**
（`throw`，拒 `.workbuddy/.dsh` 镜像）。这是协议设计行为：ps1 是 Codex 端脚本，须在
`~/.codex/projects/codex-memory-system` 执行，非 Gate 0-A 在本端的失败项。

> 附带提醒（不在 Gate 0 范围）：Codex 端 `~/.codex/projects/codex-memory-system/.sync-failed`
> 存在 2026-08-19 10:32 残留（「Working memory directory has local changes not yet synced」）。
> 属 Codex 端遗留，Gate 0 不触碰。

---

## 5. 完整测试（逐 test ID 见 evidence）

| 项 | 值 |
|---|---|
| 测试文件数 | 38 |
| PASS | **448** |
| FAIL | **0** |
| SKIP | **94** |
| ERROR | **0** |
| nonzero-exit 文件 | 0 |
| SKIP 归因 | ENV **63** / HEURISTIC **31** / UNKNOWN **0** |

与计划 §1 基线（`542 = 448 PASS / 0 FAIL / 94 SKIP / 0 ERROR`，`ENV 63 / HEURISTIC 31 / UNKNOWN 0`）
**完全一致，回归零漂移**。

SKIP 归因明细：
- **ENV 63**：`test_clued_{e2e,install,pending,policy,recovery_crash,uninstall}` 共 62 例 +
  `test_acceptance::test_py_doctor_ref_write_probe` 1 例，均因「`.git/refs` 写入不持久
  （沙盒 overlay 拦截 git refs 写）」。
- **HEURISTIC 31**：`test_acceptance` 的 ps1/conformance 用例，因 ps1 护栏检测到
  `.workbuddy` 路径 git 客户端不安全而 SKIP。

---

## 6. MIV-005A Baseline（111 case，当前代码重跑）

- corpus_hash：`1bc2374405f9678bf455b6bfffb2ed6fe3b4c12054fb2fe521e8ac9db3482c0e`
- replay_hash：`f4266eabd2bed94da36c5fa7d99fba17a3493418b849da3dfcfcee7e2842159c`
- secret_leaks：`[]`

| 指标（v2） | 全语料 | non-paraphrase | paraphrase |
|---:|---:|---:|---:|
| precision_at5_v2 | 0.6556 | **1.0** | 0.0313 |
| hit_rate_at5 | 0.8 | 0.9483 | 0.0833 |
| false_recall_rate_v2 | 0.3444 | 0.0 | 0.9688 |
| critical_memory_recall_v2 | 0.7763 | 0.9063 | 0.0833 |

- NO MEMORY：**41/41**（0 违反）
- 泄漏：current_scope=0 / project_only=0 / superseded=0
- paraphrase：12 case 词法仅命中 top-5 **1/12**
- token P95：50

**关键观察**：当前 MIV-005A 词法召回在 non-paraphrase 场景已近完美
（precision 1.0、critical recall 0.9063、false recall 0），瓶颈**几乎全部集中在
paraphrase 场景**（12 个语义改写 golden 词法只命中 1 个）。这正是 Gate 0 引入 E5
语义召回的靶点，也与验收门槛（P@5≥0.90、critical recall≥0.95、false recall≤0.02、
paraphrase≥11/12）之间的差距完全吻合。

---

## 7. Secret Scan 与保护区 Diff

- secret scan（guards.json 5 类模式 × memory/*.md + memory/objects/*.json，共 235 文件）：**0 命中**
- 保护区 diff（`memory/`、`memory/index.json`、`memory/object-index.json`）：**0 改动**

---

## 8. 冻结证据

冻结对象 SHA-256 manifest 见 `evidence/frozen-eval-manifest.json`。核心摘要：

| 冻结对象 | SHA-256（前 16） |
|---|---|
| corpus.py | `4836f10836262098` |
| metrics.py | `77595574e3eee85d` |
| fixtures.json | `ad84011c4b341c5d` |
| memory objects（230） | `762da3281aa86a10` |
| corpus_hash | `1bc2374405f9678b` |
| replay_hash | `f4266eabd2bed94d` |

---

## 9. 授权白名单（Gate 0 计划修改路径）

本轮（Gate 0-A）唯一新增路径：

- `docs/r4-gate0/**`（本 Gate 证据目录）

后续 Gate 0-B～0-D 将新增/修改的代码路径（embedding adapter、vector index、hybrid recall、
新增测试等）在各自子 Gate 冻结时补充进白名单，并在 Gate 0-I 用此白名单校验 diff 只含授权路径。

---

## 10. 退出条件判定

Gate 0-A 退出条件「全部起点条件成立」已满足，具体见 §1 判定表。唯一非 PASS 项
（sync-memory.py doctor 的 `ref write persists` 探针）经根因定位为 git 2.55 两层 ref
静默失败的环境机制缺陷，已有 `write_ref()` 兜底，真值经 `ls-remote` 独立核验一致，
按 AGENTS.md「tracking ref 丢失属自愈项、不构成阻断态」的既有边界判定，**不阻断**。

**下一步**：Gate 0-B（模型供应链、依赖与离线 Runtime）需下载 `intfloat/multilingual-e5-small`
固定 revision `919cfbe…` 并安装 embedding backend 依赖，涉及网络与磁盘写入，按计划 §14.1
**需产品所有者确认后再执行**。
