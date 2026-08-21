# R4 Gate 0-A Run 2 · Live Baseline Receipt

日期：2026-08-21  
分支：`r4-gate0-run2`  
Gate 结论：**PASS（Run 2 起点已冻结；已知失败作为后续可比较基线）**

## 1. 重启原因

原 Gate 0-A 冻结 230 个 Memory Objects；经授权的纯记忆同步后，当前 canonical
为 233 个对象，object-index/Markdown 摘要也已变化。按执行计划 §5.1，旧 run
不得直接进入 calibration。本 Run 2 从当前远端 main 重新冻结。

## 2. Live Repository Truth

| 项 | 值 |
|---|---|
| local HEAD | `6ee9b4b1723846ef9030be2443fd433c48031bd6` |
| origin/main | `6ee9b4b1723846ef9030be2443fd433c48031bd6` |
| ahead/behind | `0/0` |
| worktree | clean |
| Memory Objects | 233（active 84 / candidate 149） |

Python sync doctor 在标准临时克隆经 bootstrap 后 ALL PASS；PowerShell sync doctor
在 Run 2 worktree ALL PASS；Memory Engine doctor 17/17 PASS。Python doctor 直接
在 linked worktree 会把 `.git` 文件误当目录，该工具兼容缺口不作为仓库失败，
标准克隆已完成同一远端/同一 HEAD 的行为探针。

## 3. 全量测试 baseline

38 个文件逐进程隔离：**PASS 527 / FAIL 15 / SKIP 0 / ERROR 0**。

- CODE 11：`test_clued_uninstall` 9 + `test_clued_e2e` 2，均为
  `WinError 145`，binding 目录残留 `state.json`；这是已知 P0 修复靶点。
- ENV 3：`test_envprobe` 对受保护 `~/.workbuddy` 探针写入被拒绝（WinError 5）。
- ENV 1：临时 heuristic harness 未注入本机代理，remote probe FAIL。
- UNKNOWN 0。

逐 test ID 结果见 `evidence/test-outcomes-baseline.json`。

## 4. 冻结 MIV-005A replay

| 指标 | 全语料 | non-paraphrase | paraphrase |
|---|---:|---:|---:|
| precision_at5_v2 | 0.6556 | 1.0000 | 0.0313 |
| critical_memory_recall_v2 | 0.7763 | 0.9063 | 0.0833 |
| false_recall_rate_v2 | 0.3444 | 0.0000 | 0.9688 |

- corpus：111 cases；hash=`1bc2374405f9678bf455b6bfffb2ed6fe3b4c12054fb2fe521e8ac9db3482c0e`；
- replay=`f4266eabd2bed94da36c5fa7d99fba17a3493418b849da3dfcfcee7e2842159c`；
- NO MEMORY：41/41，0 violation；
- paraphrase：1/12 top-5 hit；
- project/superseded/secret leakage：0；
- prompt token P95：50。

## 5. 冻结 split 与不可修改项

ADR R1.6 已现场解析并验证：calibration 53 / holdout 58、无重叠、覆盖 111；
seed=20260819，固定 5×12=60 网格。完整 case ID 列表、ADR 摘要、corpus、
expected/forbidden、fixtures、metrics/eval source、Memory Objects/index/Markdown、
test source 与 baseline replay 摘要均写入 `evidence/frozen-eval-manifest.json`。

Gate 0-E 选择程序只允许加载 calibration 53 IDs；不得加载 holdout verdict、query、
expected/forbidden 明细。12 paraphrase 与 ADR 指定过滤 case 仅进入 Gate 0-F。

## 6. 授权边界

Run 2 baseline 未修改真实 Binding、Memory Objects、canonical index、评测 corpus、
fixtures、golden、expected/forbidden、metrics、Reflection、其他 Binding、tag、release
或 purge。当前 Binding 构件继续沿用既有已验证事实 `a418618`；本轮未触碰其路径。
