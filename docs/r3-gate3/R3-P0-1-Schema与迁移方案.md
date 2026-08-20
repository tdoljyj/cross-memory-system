# R3-P0-1：Binding Schema 拆分与迁移方案（裁决授权下一轮执行）

- **状态**：方案冻结 + 工具就绪（代码/测试已完成）；**真实迁移未执行**（须产品所有者裁决）
- **授权边界**：2026-08-20 裁决 —— 本轮仅代码/合同/测试/文档；不得修改当前真实 Binding、不得重新 conformance/enable、不得 push

## 1. 新 Schema（冻结）

Binding 目录布局固定为两个文件，以 **binding_id + 各自 schema 版本字段**关联：

```
bindings/<id>/
├── binding.json   # Clued manifest：schema_version="clued.binding.v0.1"
│                  #   binding_id / agent_id / node_id / account_id /
│                  #   agent_type / agent_instance_label / adapter_version /
│                  #   scopes / auth_policy / status / installed_artifacts
└── state.json     # 生命周期三轴：schema_version="lifecycle.state.v0.1"
                   #   binding / session / truth / binding_id / updated_at
```

- **写入权**：binding.json 由 clued registry 语义（Agent/Adapter/scope 注册）持有；
  state.json 由 LifecycleController 语义（三轴）持有；两者物理分离，互不覆盖。
- **安装事务原子创建**：`registry.save_binding_with_state(binding, state)` /
  `LifecycleController.install(binding_id, manifest)` —— tmp 双写 → 依次 replace，
  第二个失败回滚第一个，**不产生半创建**（CLD-LAYOUT-004 fail-closed 兜底）。
- **读取兼容**：state.json 缺失而 binding.json 为 legacy 三轴 → directory-legacy
  兼容读（只读，写被 CLD-LAYOUT-003 拒绝，须迁移）；仅 manifest 无 state →
  CLD-LAYOUT-004（半创建）。

## 2. 迁移方案（directory-legacy → 新布局）

工具：`tools/migrate_legacy_layout.py`（原子事务，测试 `tests/test_migrate_legacy_layout.py` 全绿）。

```
PRE → BACKUP → STAGE → COMMIT → VERIFY → DONE
  └────────── 任意边界失败 → ROLLBACK（完整 legacy 逐字节恢复）──────────┘
```

| 阶段 | 动作 |
|---|---|
| PRE | state.json 不存在；binding.json 为 legacy 三轴（非 manifest）；备份目录不越界 |
| BACKUP | binding.json 逐字节备份 + SHA-256 → backups/legacy-migrate-<ts>/ |
| STAGE | 写 state.json.tmp（三轴原样 + schema + _migrated）+ binding.json.tmp（默认 manifest） |
| COMMIT | 原子 replace（先 state 后 manifest；失败回滚已 replace 文件） |
| VERIFY | 三轴一致 + `validate_binding_manifest` PASS + lifecycle 新布局可定位 + binding_id 关联一致 |
| DONE | meta 收尾（legacy_sha256 / backup 路径） |

**真实 Binding（codex-workbuddy-windows-primary）迁移要点**：
- 现状：legacy 三轴 binding.json（ACTIVE/ONLINE/ENFORCED，enable 于 7c49189 构件）；
- 迁移产出：state.json（三轴原样，含 ENFORCED）+ binding.json（默认 manifest，
  binding_id 派生 agent_instance_label="workbuddy-windows-primary"、scopes 默认、
  auth_policy=balanced 默认）；
- 迁移**保留**三轴 ENFORCED（不降级），但 ENFORCED 的证据链绑定 revision=7c49189
  不变；迁移后若需继续 ENFORCED 声明，须按 P0-3 语义（isolated 验证执行环境 +
  证据新鲜 ≤1h）重新取证 —— 由产品所有者另行裁决；
- 迁移前/后各做一次只读快照（pre/post），迁移后跑 clued doctor 验证
  binding 检查 PASS。

**执行前提（未满足，等待裁决）**：
1. 产品所有者授权真实 Binding 迁移；
2. 迁移后授权重新 conformance/enable（P0-3 语义下取证）；
3. 迁移后授权精确 HEAD fast-forward push（当前 7158b04，ahead 24/behind 0）。

## 3. 已完成的本轮改造（授权范围内）

| 项 | 落地 |
|---|---|
| lifecycle 读写 | state.json 规范路径 + legacy 兼容读 + CLD-LAYOUT-003/004 fail-closed |
| 安装事务 | LifecycleController.install(binding_id, manifest) / registry.save_binding_with_state 原子双写 |
| 迁移工具 | tools/migrate_legacy_layout.py + 全阶段回滚测试 |
| clued installer | 安装事务改为原子双写（binding.json + state.json） |
| 布局测试 | test_binding_layout.py 12 项（manifest 校验 / 半创建 / legacy 只读） |
| 兼容 fixture | registry.load_binding 校验 PASS + lifecycle 三轴同源读取（已验证） |
