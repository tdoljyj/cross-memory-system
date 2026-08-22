# Clued Kernel R5 · K2 Cloud Data Foundation

- Gate：`K2`
- 裁决：`IMPLEMENTATION_PASS / AWAITING_INDEPENDENT_ADJUDICATION`
- 日期：`2026-08-22`
- 远端起点：`main@500386a14e7ec3da08eb3cf83a81e4be223239e4`
- 受测实现：`ce699b0fe05001e04707b26b80f886a2a6d12db8`
- 分支：`r5-kernel-k2-cloud-data`
- 数据库：PostgreSQL `15.19`，仅本机 synthetic local/dev 实例

## 1. 裁决与边界

K2 已建立可迁移、可回滚、可重建、可审计的 PostgreSQL Cloud Data
Foundation，并满足 R5 v1.0 计划第 16 节的本地/开发验收条件。K2 没有切换
Canonical Store，没有连接 Supabase 或生产数据库，没有修改真实 Binding，没有读取
旧 R4 holdout，也没有启用语义召回、push、merge、tag、Release 或部署。

当前 Gate 状态：

```text
K2 IMPLEMENTATION PASS
K3 LOCKED
PRODUCT UNRELEASED
SEMANTIC RECALL DISABLED
```

本报告是 K2 候选执行证据；K3 需要新的明确授权。

## 2. 实现

### 2.1 PostgreSQL 数据基础

新增 `0001_cloud_data_foundation` 原子 migration，建立：

- `accounts`、`memory_spaces`、`devices`、`bindings`；
- `memory_versions` 不可变版本链；
- `memory_current` 可重建当前投影；
- `change_events` 账号内权威事件序列；
- `idempotency_records` 并发幂等保留记录；
- `index_jobs` 与 `memory_embeddings` 派生索引合同；
- `conflict_groups`、`tombstones`、`deletion_ledger`；
- `sync_acks`、`export_jobs`、`audit_events`。

所有租户表都包含 `account_id`。Memory Object 的最小字段包含正文、摘要、类型、
Scope、状态、Truth、敏感级别、来源、有效期、supersedes、conflict、schema、
Binding、时间和 `committed_seq`。

### 2.2 租户与角色边界

- 16 张租户表全部 `ENABLE` 且 `FORCE ROW LEVEL SECURITY`；
- `tenant_isolation` 使用 fail-closed 的账号上下文；
- `clued_client` 为 `NOLOGIN / NOBYPASSRLS` 且只授予直接读取；
- `clued_service` 为 `NOLOGIN / BYPASSRLS`，不会授予客户端；
- append-only 表即使在 replication role 下也通过 `ENABLE ALWAYS` trigger 拒绝
  `UPDATE/DELETE`；
- 服务函数固定 `search_path`，公共函数权限全部撤销后再最小授权。

### 2.3 顺序、幂等和投影

- `clued.allocate_committed_seq(account_id)` 通过账号行锁原子分配序号；
- 12 路真实并发提交得到连续唯一的 `1..12`；
- `clued.reserve_idempotency(...)` 对同一键/同一请求返回同一记录；
- 不同请求复用同一键返回固定冲突错误；
- `clued.rebuild_memory_current(account_id)` 从不可变版本链确定性重建；
- Tombstone 版本在投影重建后继续压过旧 ACTIVE 版本。

### 2.4 Migration、恢复和不变量

- up/down 均在单事务中执行；
- 人为中断 transaction 后无残留表；
- up/down/up 往返通过；
- custom-format backup 恢复到新数据库后，deletion ledger 和全部不变量保持有效；
- 不变量扫描覆盖 RLS、租户键、不可变触发器、事件缺口、投影、孤儿引用、
  embedding 合同、deleted ready index、冲突、墓碑、删除证明和安全 audit metadata。

### 2.5 零正文日志

第一次真实验收发现 PostgreSQL 默认会把触发 ERROR 的完整 SQL 写入 server log。
该结果未被计为 PASS。K2 随后新增数据库日志合同：

```text
log_statement = none
log_min_error_statement = panic
log_parameter_max_length = 0
log_parameter_max_length_on_error = 0
```

复测后，正文、删除正文和跨账号正文四类 synthetic marker 在 server log 中均为
零命中；错误仍保留固定码和不含正文的诊断。

## 3. 验证

| 项目 | 结果 |
|---|---:|
| K2 静态合同 | `14/14 PASS` |
| K2 PostgreSQL 真实集成 | `14/14 PASS` |
| K1 冻结合同 | `9/9 PASS` |
| vNext-1.3 同步层 | `70/70 PASS` |
| vNext-2.0 Memory Engine | `55/55 PASS` |
| 全量矩阵 | `580 PASS / 0 FAIL / 0 SKIP` |
| 候选树密钥扫描 | `466 files / 0 hits` |

全量矩阵共 41 个测试文件。沙盒首次运行 `test_envprobe.py` 时，3 项因
`CodexSandboxOffline` 无权访问 `~/.workbuddy/.envprobe-del-<pid>` 失败；同一测试
文件随后在宿主用户上下文精确复跑 `7/7 PASS`，替换其沙盒结果。其余 40 个文件
全部在首轮通过，因此最终裁决为 580/580，无未归类失败或跳过。

## 4. 已知限制

1. K2 只验证 synthetic local/dev PostgreSQL；没有创建 Supabase 项目或生产数据面。
2. JWT、Device、Binding 的第二层显式授权接线属于 K5；原始客户端不得直接获得
   数据库角色或连接串。
3. `memory_embeddings` 在 K2 只冻结版本、模型、维度、正文 hash 和数组合同；
   pgvector 查询与语义资格化属于 K7，当前没有填充或消费 embedding。
4. Cloud 写生命周期、冲突解决和 delete/update 竞态的产品路径属于 K3；K2 仅提供
   其需要的事务原语和约束。
5. 云端持续备份、PITR 与 deletion ledger 跨备份重放的运维流程属于 K8；K2 已验证
   本地 custom-format backup/restore 的数据不变量。

这些限制不放宽 K2 安全门槛，也不授权真实 Binding 或生产切换。

## 5. 回滚

- K2 尚未接入 Controller 或真实 Binding，功能回滚是停止使用候选包；
- 数据库使用 `0001_cloud_data_foundation.down.sql` 在 synthetic local/dev 回滚；
- 失败证据和报告不删除；
- 既有 Git Canonical、MIV-005A 和语义 disabled 状态不受影响。

## 6. 远端与后续 Gate

- 执行前与收尾前两次 `ls-remote origin main` 均为 `500386a...`；
- K2 实现提交为本地 `ce699b0...`；
- 未 push、未 merge、未 tag、未 Release、未 deploy；
- K3 `Memory Write and Lifecycle` 保持 `LOCKED`，等待新的明确授权。
