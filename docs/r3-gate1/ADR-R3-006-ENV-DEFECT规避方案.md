# ADR-R3-006：ENV-DEFECT-001/002 的 Gate 2 规避方案（Gate 1 冻结）

- **状态**：DRAFT（Gate 1 交付：为 Gate 2 提出规避 ADR；不实施）
- **背景**：ENV-DEFECT-001（refs/remotes/ 下 git 写 ref 不落盘）与
  ENV-DEFECT-002（safe-delete 回收站不可用）已在 Gate 0 receipt 实锤并复现。
- **Gate 1 已落地**（`memory_engine/envprobe.py`）：
  - 启动时 capability probe（临时克隆上测 refs/remotes 写能力；safe-delete 探测）；
  - 明确诊断（`diagnose()`）与证据留存（`EnvProbeResult.to_dict()`）；
  - 测试归因分栏（`TestAttributor`：ENV vs LOGIC）。
- **本 ADR 边界**：只评估与冻结 Gate 2 规避方案；"临时 home"仅作候选，不提前成为正式合同。

## 1. 候选方案评估（不依赖持久 remote-tracking ref）

| 方案 | 机制 | 优点 | 风险/限制 | 裁决 |
|---|---|---|---|---|
| **A. ls-remote 现场直取** | 一切远端值取 `git ls-remote origin main` 输出，不读/写 refs/remotes | 纯只读、零写副作用、与现有 sync-memory.py 策略一致（"一切以 ls-remote 为准"） | 每次核验需网络往返（可缓存 5s）；离线时只能报 UNVERIFIED/LKG | **首选**（Gate 1 已按此实现 provider） |
| **B. FETCH_HEAD** | `git fetch origin main` 后读 `.git/FETCH_HEAD`（单层文件，非 refs/remotes） | 合并路径已在用（sync-memory.py merge FETCH_HEAD）；FETCH_HEAD 是普通文件可写可读 | fetch 有写副作用（对象库增长）；仍需网络 | 次选，用于 merge 场景 |
| **C. 独立状态文件** | 自定义 `.truth-state/` 目录记录最后核验结果（LKG） | 零 git 写路径；原子 replace 可用（已验证） | 状态文件非 git ref，git 工具不消费；仅 LKG 证据 | 与 A 组合使用（LKG 留存） |
| **D. 临时 home（隔离环境）** | 在全新 home/.gitconfig 下运行全部生命周期操作 | 完全规避沙盒 overlay | 环境切换成本高；与真实用户环境行为可能不一致；**仅候选** | **Gate 2 只作为备选验证场，不成为正式合同** |

## 2. 推荐组合（Gate 2 合同草案）

```
远端真值   = A (ls-remote 现场直取)          ← 唯一 current 事实源
合并路径   = B (FETCH_HEAD merge)            ← 既有行为，维持
LKG 留存   = C (.truth-state 独立状态文件)    ← receipt/LKG 证据
验证场     = D (临时 home) 仅用于 fault/e2e   ← 候选，不承诺
```

**明确禁止（Gate 2 也不得）**：把 Python 直写 `refs/remotes/**` 作为正式规避方案；
`git update-ref refs/remotes/**` 在缺陷环境一律视为不可用（fail-closed 探测后降级）。

## 3. ENV-DEFECT-002 规避

- safe-delete 回收站不可用：Gate 2 的 install/runtime_root 预检在缺陷环境应**跳过回收站清理**
  并改用直接删除（staging 目录内文件，非个人文件），或将预检拆分为"能力探测 + 降级路径"；
- 本 ADR 要求：预检失败必须携带 `SAFE_DELETE_FAIL_CLOSED` 原因码（已观察），
  归因层把它标为 ENV 而非 LOGIC（已实现于 TestAttributor）。

## 4. 归因与门槛（Gate 2 验收锚点）

1. 环境失败（ENV）与逻辑失败（LOGIC）分栏统计（已实现），**逻辑失败不得因环境缺陷豁免**；
2. 新增产品逻辑测试在隔离环境必须全绿；在本机缺陷环境允许 ENV 归因但 FAIL 计数保留；
3. Gate 2 e2e 在临时 home + 临时 bare remote + 合成 Agent 中运行（D 候选），
   真实用户环境试装需产品所有者单独授权。

## 5. 遗留（Gate 2 需决策）

- 缺陷环境下的 `git status` ahead/behind 显示是否可信（当前以 rev-list 直算 sha 替代）；
- 是否将 `.truth-state/` 纳入 gitignore（建议纳入，避免污染 worktree clean 判定）。
