# Cross-Memory-System R3 Gate 1 Report

- **生成**：2026-08-19T（UTC，以 commit 时间为准）
- **授权**：产品所有者裁决 ——"正式指令：授权 R3 Gate 1。完成后停止，等待 Gate 2 裁决。"
- **授权范围**：R3-T01~T04、R3-D01~D03、仓库真值口径勘误、版本命名空间 ADR/矩阵、
  ENV-DEFECT-001/002 隔离检测与测试归因机制
- **不授权执行**：push/tag/release、真实 Agent 安装/修复/更新/停用/启用/卸载、
  真实环境试装、Embedding 模型下载、MIV-005A/B 与 MIV-007~009、
  真实 memory/objects/** 与 index.json 与冻结区修改、Python 直写 refs/remotes 作为正式方案

## 1. Result

- **PARTIAL → 依据 §18：Truth 只能标 ADVISORY**（Provider/Receipt/Binder/Gate 已实现并有隔离测试；
  Adapter pre-answer 接线与 ENFORCED 档位 enforcement 属 Gate 2）→ **未达 ENFORCED**
- Gate 1 范围内交付完成；已停在边界等待 Gate 2 裁决

## 2. Live Repository Truth（Gate 1 启动现场复核，2026-08-19T13:21:40Z）

| 项 | 值 |
|---|---|
| Gate 1 起始 local HEAD | `b4fcb154a65402cb88a6adb6b0140e7ee25e454b` |
| remote main（ls-remote） | `9dcc31be2b7f32f3199cfbd44e138d161fc0cfdb` |
| ahead/behind | 2 / 0 |
| worktree | clean（仅 `.gate-t0-workspace/`、`.gate0-workspace/` untracked） |
| VERSION | vNext-2.0 |
| 真实 memory / 冻结区 | 与 Gate 0 基线逐文件 hash 对齐（DIFF=0） |

（Gate 1 完成后的 HEAD/remote/ahead-behind 见 §10，提交后回填。）

## 3. 实现—测试—证据映射（R3-T01~T04 / R3-D01~D03）

| 项 | 实现文件 | 测试文件 | 证据要点 |
|---|---|---|---|
| R3-T01 TruthPlanner | `memory_engine/truth/planner.py` | `tests/test_truth_planner.py`（8 项） | 四类事实分类、15 claim types、保守升级、脱敏 Trace |
| R3-T02 RepositoryTruthProvider | `memory_engine/truth/provider.py` | `tests/test_truth_provider.py`（8 项） | ls-remote 现场直取、ahead/behind 直算 sha（无 tracking ref 依赖）、远端不可达 → UNVERIFIED、LKG 独立状态文件 |
| R3-T03 EvidenceBinder | `memory_engine/truth/binder.py` | `tests/test_truth_binder.py`（6 项） | 四 HEAD 绑定、tested==target 强制、祖先关系、digest 防篡改 |
| R3-T04 TruthReceipt | `memory_engine/truth/receipt.py` | `tests/test_truth_receipt_gate.py`（12 项，与 gate 合并） | issue/validate/digest/新鲜度/same-op reuse/claim_status fail-closed |
| Claim Gate 基础链路 | `memory_engine/truth/gate.py` | 同上 | 无 receipt → UNVERIFIED+reason、ENFORCED 无 receipt 抛错 |
| R3-D01 Manifest & Trust | `memory_engine/dist/manifest.py` | `tests/test_dist_manifest.py`（12 项） | 分类/固定 revision/allowlist 根信任/大小/兼容/model 混入拒绝 |
| R3-D02 ArtifactAcquisition | `memory_engine/dist/acquisition.py` | `tests/test_dist_acquisition.py`（7 项） | URL 门禁/单飞锁/续传/有界重试/全量校验/失败清理/脱敏日志 |
| R3-D03 AtomicArtifactStore | `memory_engine/dist/store.py` | `tests/test_dist_store.py`（8 项） | verified 提交/原子切换/回滚/residue/retention/路径越界拒绝 |
| ENV-DEFECT 检测与归因 | `memory_engine/envprobe.py` | `tests/test_envprobe.py`（7 项） | capability probe/诊断/归因分栏 |

## 4. Truth 链路默认 fail-closed（证据）

- `ClaimGate.check()`：无 receipt → `CURRENT_STATE_UNVERIFIED` + `NO_VALID_RECEIPT`；
  过期 → `RECEIPT_STALE`；篡改 → `RECEIPT_TAMPERED`（test_truth_receipt_gate 锁 12 项断言）
- `TruthReceipt.claim_status_from_receipt(None)` → UNVERIFIED（fail-closed）
- `EvidenceBinder`：tested!=target / evidence 非祖先 / final 早于 tested / digest 不符 → 全部拒绝
- `TruthPlanner.conservative_fallback`：无法核验 → UNVERIFIED，禁止降级记忆/报告

## 5. Distribution 阻断语义（证据）

- allowlist 外 URL / revision / path / hash → `CLD-DIST-002` / `CLD-DIST-001` 阻断
  （test_dist_manifest 12 项 + test_dist_acquisition 7 项）
- 下载失败 → staging 全量清理（无 `.verified.json` 残留，无半成品可消费）
- 产品 manifest 混入 model artifact → 拒绝（模型隔离边界测试：test_dist_manifest
  `test_model_artifact_in_product_manifest_rejected` / `test_model_manifest_separate_ok`）

## 6. 环境失败 vs 逻辑失败分栏（新增测试全绿）

- 新增 8 文件 68 项测试：**0 失败**（见 §7 汇总）→ 全部为产品逻辑测试，无环境豁免
- 既有测试 60 FAIL 归因：ENV（ENV-DEFECT-001/002 级联），由 `TestAttributor` 分栏
  （test_envprobe 7 项锁归因逻辑）
- 归因原则：环境失败记录为环境约束，**逻辑失败仍按失败计**，不以环境缺陷降低门槛

## 7. Test Evidence（全量）

- 命令：`python .gate0-workspace/run_tests.py`（逐文件隔离，timeout 900s/file，python 3.13.14）
- 汇总：**24 文件 / PASS=313 / FAIL=60 / SKIP=31 / ERROR=0** / nonzero_exit=7
- 新增测试（Gate 1，8 文件 68 项）：**0 失败**（truth 34 + dist 27 + envprobe 7），全部为隔离 fixture，无环境豁免
- 既有测试（16 文件）：245P/60F/31S，与 Gate 0 基线一致
- **归因分栏（attribution.json）**：60 FAIL 全部归 **ENV**（ENV-DEFECT-001/002 级联：doctor ref 探针 + install 预检 CLD-INSTALL-001），**LOGIC=0**；
  31 SKIP = ps1 系列（PortableGit 护栏）

## 8. Safety Evidence

- 真实 memory（238 文件）与冻结区（8 文件）：逐文件 SHA-256 对齐 Gate 0 基线（**DIFF=0**）
- Secret scan（guards.json patterns，全仓非 gate 工作区）：**0 命中**
- 本地/远端副作用：无 push；无真实 Binding 操作；新增模块全部在隔离 fixture 中测试；
  provider 对真实仓库只读验证（snapshot 未创建 .truth-state、0 tracked 修改）

## 9. Deviations / P0 / P1

- Protocol Deviations：**空**
- 未决 P0：无（Gate 1 范围内）
- 未决 P1：ENV-DEFECT-001/002（环境缺陷，规避 ADR 已交付：ADR-R3-006）；
  版本矩阵差异（vNext-2.0/vNext-1.3/0.3.0）经 ADR-R3-005 判定为正常差异，不修正

## 10. Git Evidence（提交后现场复核，2026-08-19T14:26:41Z）

- Gate 1 提交：`b324b7bcba33f62b8188d6ab9587373fd3a0f8f5`（24 文件，+3141）
- 起止 HEAD：`b4fcb15` → `b324b7b`
- remote main：`9dcc31be2b7f32f3199cfbd44e138d161fc0cfdb`（ls-remote 现场）
- ahead/behind：**3 / 0**（Gate 0 两提交 + Gate 1 一提交）
- worktree：clean（仅 `.gate-t0-workspace/`、`.gate0-workspace/` untracked）
- 真实 memory / 冻结区：逐文件 hash DIFF=0
- 无 rewrite / 无 push / 无 tag / 无 release

## 11. Next Decision

- **Gate 2 建议**（不自行启动）：
  1. Claim Gate 全面接线（R3-T05）+ Adapter 公共合同（R3-T06）；
  2. Lifecycle 六动作完整实现（R3-L01~L05，含 DISABLED 状态协议升级）；
  3. 三轴能力档位 UNAVAILABLE/ADVISORY/AUDIT/ENFORCED 落地；
  4. ENV-DEFECT 规避按 ADR-R3-006 组合方案（ls-remote 现场直取 + FETCH_HEAD + 独立状态文件）执行；
  5. 临时 home + 临时 bare remote + 合成 Agent 的完整 e2e（仅候选验证场）
- 等待产品所有者裁决：授权 R3 Gate 2 / 试装授权 / push 授权（默认 NO）
