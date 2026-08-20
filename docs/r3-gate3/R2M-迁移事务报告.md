# R2M 报告：扁平 → 目录迁移事务实现与验证

- **时间**：2026-08-20T（UTC，以提交为准）
- **授权**：产品所有者 ——"授权 R2M：迁移事务实现与验证"
- **结果**：**12/12 测试 PASS**；独立 HEAD 提交
- **当前不执行**：真实迁移 / 真实 enable / Trial 3B（等迁移事务验收后单一裁决）

---

## 1. 迁移事务设计（tools/trial_migrate.py）

状态机（原子边界）：`PRE → BACKUP → STAGE → COMMIT → VERIFY → FINALIZE → DONE`

| 边界 | 语义 |
|---|---|
| PRE | flat 存在、directory 不存在、三轴 ACTIVE/ONLINE/ADVISORY、**备份目录不得在 state_root 内（路径越界阻断）** |
| BACKUP | 扁平**逐字节备份**（binding.flat.bin/.json + migrate-meta.json 含 SHA-256） |
| STAGE | 目录构件临时写入（binding.json.tmp） |
| COMMIT | 原子切换（os.replace；迁移窗口内双格式并存） |
| VERIFY | 目录可读、三轴与扁平逐字段一致、find_by_agent 可定位 |
| FINALIZE | 扁平移入备份区（os.replace → binding.flat.moved.json，**非删除、非 purge**） |
| DONE | 终态仅目录真值（bindings/ 下无扁平）；meta 记录 DONE |

**回滚**（任一边界失败）：恢复完整扁平 ADVISORY（逐字节）或完整目录 ADVISORY——**不允许半迁移**；
- FINALIZE 前失败：删除目录构件 → 完整扁平（原样）；
- FINALIZE 后失败：从备份恢复扁平 + 删目录 → 完整扁平。

**worker 集成**（trial_worker --action migrate）：固定 run_id、单 worker（O_EXCL lock）、
同 run_id 重发 → ALREADY_RUNNING/ALREADY_DONE、receipt 原子落盘、journal/tmp 终态零。

## 2. 测试覆盖（tests/test_trial_migrate.py，12 项全绿）

| 场景 | 结果 |
|---|---|
| 成功迁移（终态仅目录；扁平移入备份区逐字节+sha256；receipt exit 0） | ✓ test_m1 |
| 重复调用（同 run_id → ALREADY_DONE；新 run_id → flat 不存在 FAILED） | ✓ test_m2 |
| caller 中断（worker 独立完成） | ✓ test_m3 |
| 并发（lock done=False → ALREADY_RUNNING，无迁移） | ✓ test_m4 |
| **每原子边界故障注入**（PRE/BACKUP/STAGE/COMMIT/VERIFY/FINALIZE → FAILED exit 4；回滚单一真值；扁平逐字节一致；ADVISORY） | ✓ test_fi_*（6 项） |
| 双格式终态禁止（迁移后无扁平 + 目录 + 无 .tmp + journal 0） | ✓ test_m5 |
| 路径越界阻断（backup_dir 在 state_root 内 → PRE 拒绝 exit 4；无副作用） | ✓ test_m6 |

## 3. 全回归（迁移事务新构件组合）

| 文件 | 项数 | 失败 |
|---|---|---|
| test_trial_migrate（新增） | 12 | 0 |
| test_binding_layout | 9 | 0 |
| test_lifecycle_ctl | 18 | 0 |
| test_trial_runner | 6 | 0 |
| test_trial_worker | 12 | 0 |
| test_trial_worker_enable | 9 | 0 |
| test_truth_state_conformance | 13 | 0 |
| test_production_wiring | 10 | 0 |
| **合计** | **89** | **0** |

## 4. 边界

- 真实扁平 Binding（`codex-workbuddy-windows-primary.json`）**未触碰**（保持 ACTIVE/ONLINE/ADVISORY 兼容读）；
- 未执行真实迁移 / 真实 enable / Trial 3B；未 push / tag / release / purge；
- 迁移事务写入仅限：state_root/<bid>/（目录构件）、backup_dir（备份区）、lock；无其他路径。

## 5. 通过后下一步（单一裁决路径，等待产品所有者）

真实迁移 → 真实 conformance（新构件组合）→ 持久 worker enable（ENFORCED）。
