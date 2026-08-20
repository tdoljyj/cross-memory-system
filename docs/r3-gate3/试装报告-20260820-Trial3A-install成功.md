# 真实环境受控试装 Trial 3A 报告：install 成功

- **时间**：2026-08-20T04:49Z（UTC）
- **授权**：产品所有者 Trial 3A（真实 install；固定 run_id；不同时授权 conformance/enable）
- **HEAD**：`77f951a`；**Binding**：`codex-workbuddy-windows-primary`
- **结果**：**install 成功（ACTIVE / ADVISORY / ONLINE）；未执行 conformance/enable**

---

## 1. 执行前（64 项测试 + 快照 + 现场复核）

| 项 | 结果 |
|---|---|
| 64 项测试（52 相关 + 12 通道） | ✓ 64/0（lifecycle 18 / trial_runner 6 / e2e 5 / conformance 13 / wiring 10 / worker 12） |
| HEAD / Adapter/冻结区 vs 4a04e52 | ✓ 77f951a / DIFF=0 |
| Trial 3A 全新纯净快照 | ✓ `pre-trial3a-20260820T044945Z/`（bindings 空 / registry 无 / journal 0 / lock 无） |
| 保护区（vs pre-install 基线） | ✓ 内容 DIFF=0、新增 []、删除 [] |

## 2. 执行（worker 单次，固定 run_id）

- 执行入口：`tools/trial_worker.py`（独立 worker 进程，PowerShell Start-Process 启动，caller 立即返回）
- run_id：**`trial3a-codex-workbuddy-windows-primary-01`**（固定，未自动生成新 run_id）
- 启动 worker 次数：**1**；install 调用：**1**（receipt.install_calls=1）
- 未再次启动 worker；仅只读轮询 receipt/lock

## 3. Receipt（原子落盘，终态）

```json
{"schema_version": 1, "run_id": "trial3a-codex-workbuddy-windows-primary-01",
 "pid": 41396, "exit_code": 0, "install_calls": 1,
 "detail": {"binding_state": "ACTIVE", "truth": "ADVISORY", "session": "ONLINE",
            "journal_count": 0, "install_calls": 1},
 "ts": "2026-08-20T04:49:59Z"}
```
位置：`.clued/backups/pre-trial3a-20260820T044945Z/trial3a-receipt.json`（无 .tmp 残留）

## 4. 核验（8/8 PASS）

| 核对项 | 结果 |
|---|---|
| install_calls=1 | ✓（receipt.install_calls=1） |
| run_id / PID / exit code | ✓（固定 run_id / pid 41396 / exit 0） |
| journal=0 | ✓（bindings/ 无 .journal-*） |
| Binding 三轴完整 | ✓ ACTIVE / ONLINE / **ADVISORY**（binding_id 匹配） |
| 无 .tmp / 半写 | ✓ |
| 保护区新增/删除/内容变化 | ✓ 全零（memory 238 + frozen 8，vs pre-install 基线） |
| worker exit | ✓ DONE（stdout status=DONE；lock done=True） |
| 单 worker | ✓ lock.pid=41396 唯一；未启动第二 worker |

## 5. 实际文件变更（本轮新建，全在白名单内）

| 路径 | 变更 |
|---|---|
| `.clued/bindings/codex-workbuddy-windows-primary.json` | 新建（binding 状态：ACTIVE/ONLINE/ADVISORY） |
| `.clued/bindings/.trial-run.lock` | 新建（worker 运行证据：run_id/pid/done=True） |
| `.clued/backups/pre-trial3a-20260820T044945Z/*` | 新建（快照 + receipt + worker stdout/stderr） |

**未创建**：registry.json（worker 只做 install；登记如需要，等 conformance→enable 裁决）。

## 6. 保护区证明

- canonical memory（238 文件）/ 冻结区（8 文件）：SHA-256 vs pre-install 基线 **DIFF=0**；
  路径集合新增 [] / 删除 []（内容/新增/删除全零）；
- porcelain：**零输出**（bindings/ 与 backups/ 均为 .gitignore 忽略运行时构件）。

## 7. 边界遵守

- **未执行**：conformance、enable、recover_pending、repair/update/disable/uninstall/purge；
- **未**生成第二个 run_id、**未**第二次 install、未 push/tag/release；
- 旧污染/试装备份保持 AUDIT_ONLY / NOT_RESTORE_SOURCE（未动）。

## 8. 最终状态

- Binding `codex-workbuddy-windows-primary`：**ACTIVE / ONLINE / ADVISORY**（install 成功态，等待 conformance → enable 单独裁决）
- 仓库：HEAD=`77f951a`（本报告提交后见 Git Evidence）、porcelain 零输出
