# Clued P2 Request-local Verification Context 验收报告 v1.0

## 裁决

`PASS / P2_IMPLEMENTED_ON_FEATURE_BRANCH`

固定基线为 `main@7f1bc29cfd8f2ff80b24c7e10f55f1bc0a3df3e0`。实施分支为 `codex/p2-request-local-verification-context`。提交前再次只读核验远端 `main` 仍为该固定 Commit；未合并 `main`。

本次只实施 P2 Request-local Verification Context。未执行 P3 的隔离 Mirror、Backup/no-op、同机锁或原子切换改造；未执行 P4 的 Canonical-first、T1/T3 路由或读取范围改造；未执行 P5–P6、生产访问、部署、数据库/RLS 变更或 Snapshot 发布。

## 实现结果

每个非 `NONE` 请求创建一个显式传递、仅存于当前进程内存的 `RequestVerificationContext`。Context 不可序列化，没有模块级 PASS 缓存；新请求、独立重试和新进程均重新创建并重新验证。`NONE`/T0 在 Context、Git、Pointer、Manifest 和 Memory 读取前返回。

同一请求内，复用前重新绑定并比较：

- 请求路径与解析后路径、卷/设备、目录 inode、文件属性、ACL/Owner/Group、可写性、Symlink/Junction 状态；
- Remote Head、Local Head、仓库身份、根 `VERSION`、完整 Git tag 集；
- Manifest SHA-256、Current Pointer SHA-256、Snapshot/Canonical Version、Owner、Bundle Scope、Generator/Schema；
- Manifest 枚举文件的流式内容指纹；
- Tenant/Organization/Workspace/Context/Binding/Role/Scope/Purpose/Policy/Revocation/Session 到期与授权结论；
- TTL、可信单调时钟、墙钟漂移、Validator Contract 与 Doctor Version。

任一项变化即删除相应 boundary 的 PASS；随后只能完整重验或 fail-closed。上下文授权、Remote Head、TTL、时钟信任变化直接 fail-closed。复用不依赖 mtime、size、tracking ref 或旧 Remote SHA。

源 Bundle、复制候选与本地 Mirror 使用不同 boundary key。源端 PASS 不会替代复制后目标的独立 Manifest/哈希校验；P1 的一次请求一次 `ls-remote` 及显式 Remote SHA 传递保持不变，参数 SHA 与 Context SHA 不一致时在校验前阻断。

Recall 在读取后、形成权威结果前再次核验；若期间输入改变，即使新状态能独立通过，也拒绝本次混合时点结果并要求新请求。权威输出必须带完整 Source Envelope：`sources_read`、source versions、freshness，以及始终存在的 degraded 字段。

## 强制 Gate

| Gate | 结果 | 独立证据 |
|---|---|---|
| F07 | PASS | 未变化：full validate 1、reuse 1；篡改后 invalidate、full validate 2、hash mismatch 阻断；新请求重新校验且 Context 不可序列化 |
| F08 | PASS | Manifest 不变而 Pointer 改变时 Version Envelope 失效并完整重验 |
| F09 | PASS | Owner mismatch 与 Tenant scope mismatch 均拒绝；授权、Remote SHA、TTL 变化清空证据并 fail-closed |
| F25 | PASS | TTL 过期、墙钟前跳/回拨、future `verified_at`、不可信时钟全部阻断；stale age 非负 |
| F27 | PASS | 相同字节的目录替换仍由路径身份变化触发失效与完整重验 |
| F30 | PASS | control 复用；分别改变 `VERSION`、tag、Manifest、Pointer、Validator 均失效；Manifest 与 Pointer 不一致明确拒绝 |
| F31 | PASS | 完整 Source Envelope 才可 `authoritative=true`；缺 sources/version/freshness/degraded reason 均拒绝或非权威 |

## 旧拒绝集合与回归

F05、F06 分别在旧兼容路径和真实 P2 Context 路径重复执行：

- F05 源 Manifest 文件哈希错误均在复制前阻断，没有成功状态、切换或 Backup；
- F06 复制后目标损坏均在目标独立校验阻断，Current Pointer 与既有 LKG 不变；
- dirty worktree、网络不可用、真实 Git divergence、Malformed Remote Ref 继续使用各自错误分类并 fail-closed；
- Remote 未变化仍为每请求一次 `ls-remote`，第二个新请求重新查询，失败不使用旧结果降级；
- Git divergence 未与 Canonical CAS Conflict 合并。

因此未发现“旧路径拒绝、新路径接受”。

| 验证 | 结果 |
|---|---|
| Python 全量（P1/P2/根切换） | 38/38 PASS，0 fail，23,832.507 ms |
| P2 + F05/F06 Context 专项 | 22/22 PASS |
| Cloud 离线合同回归 | 63/63 PASS，0 fail，0 skip，825.871 ms |
| Cloud 构建 | PASS，3,096.062 ms |
| `python memory.py doctor` | PASS，710 个 Manifest 文件，1,135.368 ms |
| `python sync-memory.py doctor` | PASS，一次性 OS 临时 Mirror Fixture，1,764.870 ms |
| PowerShell `-AlignAndVerify -Access NONE` | PASS，81.778 ms；零 Git、零 Mirror |

Cloud 构建只使用本地依赖与仓库源码；测试未调用生产服务。在线撤销、Supabase RLS 和生产授权变更没有被访问，而是通过注入的请求级授权/撤销/租户证据执行 fail-closed 合同测试。

## 变更文件

- `verification_context.py`
- `memory.py`
- `sync-memory.py`
- `AGENTS.md`
- `tests/test_p2_verification_context.py`
- `tests/test_p1_align_and_verify.py`
- `artifacts/clued-validation/p2/7f1bc29c/p2_raw_results.jsonl`
- `artifacts/clued-validation/p2/7f1bc29c/SHA256SUMS`
- `docs/clued-two-level-views/Clued_P2_Request-local_Verification_Context_验收报告_v1.0.md`

## 证据

- 原始结果：`artifacts/clued-validation/p2/7f1bc29c/p2_raw_results.jsonl`
- 文件哈希：`artifacts/clued-validation/p2/7f1bc29c/SHA256SUMS`
- 专项测试：`tests/test_p2_verification_context.py`
- 旧/新拒绝等价测试：`tests/test_p1_align_and_verify.py`

最终 Commit SHA 与各证据 Git Blob SHA 在功能分支提交后记录于提交/推送回执；本报告不预写尚未产生的 Git 身份。
