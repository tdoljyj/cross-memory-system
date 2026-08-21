# R4 Gate 0-C · Vector Index Safety Report

日期：2026-08-21  
分支：`r4-gate0-r2`  
执行起点：`0e1f928d83b3c2c34262f01c425c0bd9dcb61f6f`  
Gate 结论：**PASS（仅 Gate 0-C）**

> 本报告只裁决安全向量索引。它不代表 Gate 0-D～0-I 完成，也不授权修改真实
> Binding、合并 main、tag、release、Reflection 或 purge。

## 1. 实施范围

- 新增 `memory_engine/vector_index.py`：外置派生索引、硬过滤、确定性 passage、
  generation 自检、原子 `CURRENT.json` 切换、并发锁、dirty/rebuild、Windows/POSIX
  权限收紧。
- 修改 `memory_engine/store.py`：仅当本端显式配置 `vector_cache_dir` 时，在
  canonical 对象写入**之前**取得同一构建锁并写 dirty marker。无法标记时
  fail-closed，canonical 不落盘。
- 新增 `tests/test_vector_index.py`：不依赖 torch/网络的安全与故障注入矩阵。
- 新增去敏证据 `evidence/index-manifest.redacted.json`。

未修改 `memory/objects/*.json`、`memory/index.json`、`memory/object-index.json`、
Clued Binding、同步脚本或冻结评测 fixture。

## 2. Passage 与索引数据边界

serializer 固结为 `r4-g0-passage-v1`。它只序列化当前 MIV-005A 已消费的四类
recall-visible 字段，顺序固定：`category`、`content`、`entities`、`tags`。
字符串统一 NFKC、换行和空白；tags/entities 去重后排序。`content_hash` 是规范化
passage 的 SHA-256。

下列内容不进入 passage：对象路径、source_ref、时间戳、权限字段、project/session
标识、状态与 provenance。索引文件也不保存 passage/正文，只保存：

- `object_id`、`content_hash`；
- `scope`、status 与不可逆的 project/session/visibility 摘要；
- 384 维 little-endian float32 向量。

## 3. Embedding 前硬过滤

过滤顺序在模型调用前完成，reason code 固定：

| 条件 | reason code |
|---|---|
| schema/枚举/必填字段非法 | `INVALID_OBJECT` |
| denied 标记或 denied 状态 | `ACCESS_DENIED` |
| 非 active/reinforced | `STATUS_NOT_RECALLABLE` |
| `type=temporary` | `TEMPORARY_OBJECT` |
| valid_from/valid_until 当前不可见 | `TEMPORAL_NOT_CURRENT` |
| guards 命中 secret | `SECRET_DETECTED` |
| supersedes/contradicts 裁决输家 | `CONFLICT_LOSER` |

T0/T4/temporary 查询仍由现有 recall 入口零读取短路；Gate 0-D 才会接入 query
向量路径。Gate 0-C 不改变默认召回行为。

## 4. Generation、原子性与并发

构建过程为：取得 `BUILD.lock` → 硬过滤 → batch=32 embedding → 写
`.staging-<generation>` → 校验 rows/vectors 的 size、SHA-256、行数、唯一 ID、
384 维和 manifest self-hash → 收紧权限 → 原子写 `CURRENT.json`。

- 任一阶段异常：旧 `CURRENT.json` 保持不变，临时 generation 清理；已完整落盘但
  尚未选中的 generation 只作为不可见孤儿保留。
- 相同 source/model/serializer fingerprint 且无 dirty marker：直接 `REUSED`，
  不重复调用模型。
- canonical 写入与 index build 使用同一锁；构建中写对象会在 canonical 落盘前
  被拒绝，避免 stale index 被误标为 clean。
- update/supersede/archive/delete 均经 `store.save_object` 触发 dirty；成功全量重建并
  原子切换后才清除 marker。
- 缓存根若位于仓库或 canonical memory 内，直接 `VECTOR_CACHE_INSIDE_REPOSITORY`。

## 5. 真实 E5 构建结果

使用 Gate 0-B 已验证的只读模型构件；运行时强制 offline，模型与 tokenizer 未复制
进仓库。派生缓存位于本任务临时区、在 Git 仓库之外，未写真实 WorkBuddy 缓存。

| 项 | 实测值 |
|---|---:|
| canonical 对象输入 | 233 |
| included | 84 |
| excluded | 149 |
| excluded reason | `STATUS_NOT_RECALLABLE=149` |
| batch | 32（尾批按实际余数） |
| dimension / dtype / norm | 384 / float32 / L2 |
| vectors bytes | 129,024（84×384×4） |
| rows bytes | 23,857 |
| index build（不含模型初始化） | 3,069.406 ms |
| 端到端（含模型初始化与 build 后复验） | 6.018 s |
| post-ACL self-check | 84/84 rows PASS |

关键摘要见 `evidence/index-manifest.redacted.json`。证据不含向量、Memory Object
正文副本、原始 query、secret、用户目录路径或原始 project/session ID。

## 6. 权限核验

POSIX 路径使用目录 0700、文件 0600。Windows 路径使用 protected DACL，仅保留：

- 当前执行 identity：Full Control；
- `SYSTEM`：Full Control；
- `Administrators`：Full Control。

现有子项先清除旧继承，再只继承已收紧根目录。一次中间 ACL 探针曾因对子文件
执行 `inheritance:r` 后未恢复继承而触发 `PermissionError`；该问题在候选代码中已
修正为两阶段 DACL，随后用真实 E5 进程完成 post-ACL 84-row 自检。失败探针未改变
canonical、Binding 或已选中 generation。

## 7. 可重放测试与故障注入

`tests/test_vector_index.py`：**15 PASS / 0 FAIL / 0 SKIP**。

覆盖：

1. serializer NFKC/空白/集合顺序与 content hash 稳定性；
2. allowed IDs 精确集合和七类排除 reason code；
3. secret 零 row、零模型输入、零缓存落盘；
4. 65 对象固定分批 `32/32/1`；错误维度/L2 拒绝；
5. 重复 build 幂等复用；
6. `before_current_switch` 中断保留旧 generation；
7. vectors 篡改、旧 manifest/错误模型 digest fail-closed；
8. dirty 全量重建、删除整个缓存后从 Objects 恢复；
9. 显式配置才标 dirty，默认零外置写；
10. build lock 期间 canonical 写入在落盘前拒绝；
11. 并发 build 拒绝；死亡 PID 锁自愈、不可识别锁保守拒绝；
12. Windows/POSIX 权限收紧后执行主体仍可读写；
13. 构建前后 canonical object/index SHA-256 集合完全相等。

兼容回归：`tests/test_acceptance.py` **70 PASS / 0 FAIL**（UTF-8 运行口径）、
`tests/test_memory_v2.py` **55 PASS / 0 FAIL**。`git diff --check`
通过。Clued install/update/disable/uninstall 源码未引用 vector cache；默认卸载仍只按
Binding manifest 精确删除，不执行真实缓存 purge。

## 8. Gate 0-C 退出条件裁决

| 条件 | 结果 |
|---|---|
| 只索引允许对象 | PASS |
| secret/temporary/invalid/denied/status/conflict 预过滤 | PASS |
| batch=32、float32、384、L2 | PASS |
| generation 原子切换与旧 generation 保留 | PASS |
| dirty/update/supersede/delete 全量重建语义 | PASS |
| 缓存删除可重建 | PASS |
| included 精确集合 / excluded reason 计数 | PASS |
| 并发、篡改、中断、错误 fingerprint、禁止路径 | PASS |
| Windows 最小权限与 post-ACL 复验 | PASS |
| canonical 零修改 | PASS |

因此 Gate 0-C = **PASS**。下一阶段是 Gate 0-D Hybrid Recall 接线；新能力仍默认
`off`，在 0-D 合同与回退测试通过前不得进入回答路径。
