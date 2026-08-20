# 真实环境 conformance 报告（Trial 3A-conformance）

- **时间**：2026-08-20T04:57Z（UTC）
- **授权**：产品所有者 ——"授权真实 conformance，enable 暂缓"
- **Binding**：`codex-workbuddy-windows-primary`（ACTIVE / ONLINE / ADVISORY）
- **结果**：**外部 conformance verdict = ENFORCED（候选档位）；binding 保持 ADVISORY（未自动切换）**

---

## 1. conformance 前检查（只读，全 PASS）

| 检查 | 结果 |
|---|---|
| registry.json 语义 | clued 代码**无 registry.json 引用** → install 不要求创建 → **合同允许暂不创建** ✓ |
| .trial-run.lock 与枚举器 | clued list_bindings 跳过点文件（`entry.startswith(".")`）→ **不误识别** ✓ |
| done lock 与 conformance | ConformanceVerifier/TruthStateStore **不读取 .trial-run.lock** → 不阻断/不污染 ✓ |
| Adapter/冻结区 vs 4a04e52 | **DIFF=0** ✓ |

**格式差异注明**：R3 试装 binding 为扁平文件 `bindings/<id>.json`；clued v0.1 枚举器为
`bindings/<id>/binding.json` 目录结构 —— 两套格式差异属 R3/clued **兼容层待接线项**
（不影响 ConformanceVerifier 判定；clued find_by_agent 当前不会列出该 binding）。

## 2. 外部 ConformanceVerifier 真实验证（禁止 Adapter 自证）

- 唯一证据目录：`.clued/backups/pre-trial3a-20260820T044945Z/conformance/`
- 固定 run_id：`trial3a-codex-workbuddy-windows-primary-conformance-01`
- verdict/receipt 原子落盘：`conformance-receipt.json`（无 .tmp 残留）

### Verdict

```
verdict: ENFORCED（候选档位）
证据链：receipt 有效（bound 4a04e52）+ .truth-state 强绑定
        （binding/adapter/revision/evidence_digest）+ 证据新鲜 + 隔离（受控试装）环境
```

### 核验清单

| 项 | 结果 |
|---|---|
| 合同 | contract_version=1（adapter 标识 truth-enabled） |
| 版本矩阵 | vNext-2.0 / vNext-1.3 / 0.3.0 / 1 / 1 ✓ |
| Truth 生产入口 | 5 入口（read/recall/write/sync/pre_answer）checked=5 / bypass=**0** ✓ |
| 状态强绑定 | binding_state_pre = ACTIVE/ONLINE/**ADVISORY**；strong_binding=OK ✓ |
| 故障注入 | **篡改 receipt → ADVISORY**（判定器拒绝坏证据，RECEIPT_TAMPERED）✓ |

### 关键约束遵守

- **未**把 conformance PASS 自动写成 ENFORCED：binding 文件 truth 保持 **ADVISORY**；
- Adapter 未自证：verdict 由冻结 ConformanceVerifier 生成；
- canonical memory（238）/ 冻结区（8）：DIFF=**0**；共享 Core / 其他 Binding 零修改。

## 3. pre/post 路径与哈希

- **pre**（Trial 3A 快照 `pre-trial3a-20260820T044945Z/pre-trial3a-snapshot.json`）：
  memory 238 + frozen 8 + .clued（不含 backups）2 文件；
- **post**（conformance 后）：
  - 保护区：内容 DIFF=0、新增 []、删除 []（vs pre-install 基线）；
  - 白名单新增（本轮）：`bindings/<bid>.json`、`.trial-run.lock`、
    `backups/pre-trial3a-20260820T044945Z/`（快照 + receipt + worker 输出 + conformance/）；
  - 无白名单外写入；porcelain 零输出。

## 4. 最终三轴状态（conformance 后，未 enable）

```
binding  = ACTIVE
session  = ONLINE
truth    = ADVISORY   ← 未切换 ENFORCED（enable 暂缓）
```

## 5. enable 前置说明（裁决要求）

现有持久 worker（trial_worker）已验证 install 通道能力；enable 为真实状态变更，
须在 conformance PASS 后**再证明 enable 使用的执行通道**具备：单 worker、固定
run_id、原子 receipt、宿主重发幂等 —— 待产品所有者裁决 enable 通道验证方案。

## 6. 边界遵守

- 未执行 enable / recover_pending / repair / update / disable / uninstall / purge；
- 未 push / tag / release；污染备份保持 AUDIT_ONLY / NOT_RESTORE_SOURCE。
