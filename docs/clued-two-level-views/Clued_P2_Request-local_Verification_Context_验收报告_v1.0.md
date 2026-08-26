# Clued P2 Request-local Verification Context 验收报告 v1.0

## 裁决

`PASS / P2_DOCUMENTATION_CONTRACT_CORRECTED_ON_FEATURE_BRANCH`

固定基线：`main@7f1bc29cfd8f2ff80b24c7e10f55f1bc0a3df3e0`。实施分支：`codex/p2-request-local-verification-context`。原始 P2 Commit 为 `69254f3b8d3e5ac3604f8fd0c2ee1d8118f866d1`，第二轮修复 Commit 为 `40abd21c3bb3b98dd43af19c2f4e2c187983b560`。本轮只在 `40abd21c…` 上追加文档契约修复，不 amend、rebase 或重写已有 Commit；远端 `main` 在提交前仍为固定基线，未合并 `main`。

本轮仅修正 P2 Request-local Verification Context。未执行 P3 的隔离 Mirror、Backup/no-op、锁或原子切换改造；未执行 P4 的 Canonical-first/T1/T3 路由；未执行 P5–P6、生产访问、部署、数据库/RLS 变更或 Snapshot 发布。

## 复审问题闭环

1. `authoritative=true` 现在必须绑定指定 boundary 上仍有效的成功 `BundleEvidence`，并通过 `evidence_id` 与 `SourceEnvelope` 绑定。零校验、校验失败、缺 boundary、Evidence 失效或 Envelope 跨 boundary/跨 Evidence 均拒绝；仅有 Evidence 而无完整 Source Envelope 时只能输出 `authoritative=false`。
2. `summary()` 从当前 Evidence 输出实际 Repository、Snapshot、Authorization、完整 Version Envelope、Validator Contract 与 Doctor Version。`validator.result=pass` 只会在当前 Evidence 重新核验成功后出现，不再是无条件常量结论。
3. Validator 返回无错误后、Evidence 创建前，Context 再次逐项流式计算 Manifest 枚举文件的 SHA-256 并与声明比较。测试在 Validator PASS 后、Evidence 捕获前篡改文件，首次调用即以 `manifest:hash-mismatch:data.txt` 阻断，未创建 Evidence、未缓存 PASS。
4. PowerShell `-AlignAndVerify` 的非 `NONE` 请求由一个 Python 进程完成 align-and-verify → Mirror → doctor，并显式传递同一个不可序列化 Context。Context 没有模块级或持久 PASS 缓存；下一请求创建新 Context、重新查询 Remote Head 并重新校验。
5. 已删除为制造 reuse 增加的无业务意义重复验证。真实链路计数为：status `full=1/reuse=0`，Memory doctor `1/0`，recall `1/1`（读取后形成权威结果前复核），Mirror + doctor `3/1`（源、复制候选、本地 Mirror 三个真实边界；doctor 复用同请求源 Evidence）。
6. Owner Ref 与 Bundle Scope 的期望值来自版本化可信端点配置 `config/clued-endpoint-trust.json`，不从可选调用者环境变量取得。可信配置缺值、Manifest 缺值、不匹配或配置发生变化均失效并 fail-closed。
7. `AGENTS.md` 的 Read-before-alignment 第 4 步已收敛到实际入口：`sync-memory.ps1 -AlignAndVerify` 本身在同一 Python 进程和同一 Context 内完成 Mirror 与 doctor；成功后同一请求不得再启动 `python memory.py doctor`。独立 doctor 明确属于新的 doctor-only 请求，创建新 Context 并重新校验。文档契约回归测试同时锁定该正向要求与旧矛盾指令的缺席。

## Evidence 与失效语义

每个成功 `BundleEvidence` 保存：Evidence/Boundary 身份、被测根路径、验证时间、实际 Manifest、路径身份、实际文件内容指纹、授权证据哈希和 Version Envelope。Version Envelope 包含 Remote/Local Commit、仓库身份、根 `VERSION`、Git tag 集、Manifest、Current Pointer、可信端点配置、Snapshot/Canonical Version、Owner、Bundle Scope、Generator/Schema、Validator Contract 与 Doctor Version。

复用前及权威汇总前均重新检查请求授权、TTL、可信时钟和全部 Evidence 身份。路径、Manifest、Pointer、Version、tag、Remote、Owner/Scope 可信配置、授权、时钟、Validator/Doctor 或实际文件内容任一变化都会删除对应 boundary 的 PASS，随后只能完整重验或拒绝。源 Bundle、复制候选和本地 Mirror 的 Evidence 相互独立；源 PASS 不替代复制后目标的独立哈希校验。

`NONE` 在 Context、Git、Pointer、Manifest 和 Memory 读取前返回，保持零 Git、零 Memory 读取。

## 强制 Gate

| Gate | 结果 | 证据摘要 |
|---|---|---|
| F07 | PASS | 同请求未变化为 full 1/reuse 1；篡改使 Evidence 失效、完整重验并拒绝；新请求重新校验；Context 不可序列化 |
| F08 | PASS | Current Pointer 变化使 Version Envelope 失效并完整重验 |
| F09 | PASS | Owner/Scope 缺失或不匹配、授权/Remote SHA/TTL 变化全部 fail-closed |
| F25 | PASS | TTL 过期、墙钟前跳/回拨、future verified-at、不可信时钟全部拒绝；stale age 非负 |
| F27 | PASS | 目录被相同字节副本替换仍由路径身份变化触发失效与重验 |
| F30 | PASS | `VERSION`、tag、Manifest、Pointer、可信 Owner/Scope 配置、Validator Contract 变化全部失效；Manifest/Pointer 不一致拒绝 |
| F31 | PASS | 完整且绑定当前 Evidence 的 Source Envelope 才允许 `authoritative=true`；缺项、失效或错绑均拒绝/非权威 |
| 文档契约 | PASS | AGENTS 包含单进程唯一 Context 的内置 doctor 契约，且不再要求 AlignAndVerify 成功后同请求另起 doctor |

新增负向测试覆盖：未调用 `verify_bundle()` 生成 Source Envelope；缺少 boundary；Validator PASS 后、Evidence 捕获前篡改；可信 Owner/Scope 期望缺失；Manifest Owner/Scope 缺失；Evidence 失效后 `summary()`；实际非 `NONE` PowerShell 单请求贯穿一个 Context；下一独立请求产生新 Context 并重新校验。

## 真实调用链与拒绝等价

实际 PowerShell Fixture 连续执行两个独立 `-AlignAndVerify -Access PROJECT` 请求。每个请求均为一个 Python 进程、一个 Context、一次真实 `git ls-remote`；两次请求的 `verification_id` 不同，每次 `full_validation_count=3`、`reuse_count=1`。未跨请求复用 Remote SHA 或 PASS Evidence。两个 standalone doctor 分别作为新的 doctor-only 请求执行并重新创建 Context，不属于 AlignAndVerify 请求的延续。

F05、F06 分别在旧兼容路径和 P2 Context 路径执行：

- F05 源 Manifest 文件哈希错误均在复制前阻断，无成功状态、切换或 Backup；
- F06 复制后目标损坏均在目标独立校验阻断，Current Pointer 和既有 LKG 不变；
- dirty worktree、网络不可用、真实 Git divergence、Malformed Remote Ref 保留原错误分类并 fail-closed；
- Remote 未变化仍为每请求一次 `ls-remote`，新请求重新查询，查询失败不使用旧 SHA 降级；
- Git divergence 未与 Canonical CAS Conflict 合并。

未发现“旧路径拒绝、新路径接受”。

## 复跑结果

| 验证 | 结果 |
|---|---|
| P2 专项 | 28/28 PASS，约 23,952 ms |
| AGENTS 文档契约 | 1/1 PASS |
| 新增 Evidence 权威负向测试 | 6/6 PASS，约 1,768 ms |
| F05/F06 定向回归 | 4/4 PASS，约 5,655 ms |
| 实际非 NONE PowerShell 单请求/下一请求测试 | 1/1 PASS，约 9,646 ms |
| Python 全量 | 48/48 PASS，0 fail，约 35,096 ms |
| Cloud 离线合同回归 | 63/63 PASS，0 fail，0 skip，约 817.329 ms |
| standalone `python memory.py doctor` | PASS，710 个 Manifest 文件，新 Context full 1/reuse 0，约 1,101.076 ms |
| standalone `python sync-memory.py doctor` | PASS，一次性 OS 临时 Mirror Fixture，新 Context，约 1,743.425 ms |
| PowerShell `-AlignAndVerify -Access NONE` | PASS，约 172.060 ms，零 Git、零 Mirror |
| Python bytecode 与 `git diff --check` | PASS |

Cloud 构建使用已有本地依赖和仓库源码。全部同步/损坏场景均在一次性 Fixture 中运行；未连接生产服务。

## 本轮追加修复变更文件

- `AGENTS.md`
- `tests/test_p2_verification_context.py`
- `artifacts/clued-validation/p2/7f1bc29c/p2_raw_results.jsonl`
- `artifacts/clued-validation/p2/7f1bc29c/SHA256SUMS`
- `docs/clued-two-level-views/Clued_P2_Request-local_Verification_Context_验收报告_v1.0.md`

## 证据路径

- 原始结果：`artifacts/clued-validation/p2/7f1bc29c/p2_raw_results.jsonl`
- 文件哈希：`artifacts/clued-validation/p2/7f1bc29c/SHA256SUMS`
- P2 Gate 与真实入口测试：`tests/test_p2_verification_context.py`
- F05/F06 与旧拒绝等价测试：`tests/test_p1_align_and_verify.py`
- 可信端点边界：`config/clued-endpoint-trust.json`

最终修复 Commit SHA 与证据 Git Blob SHA 在追加 Commit 和推送验证后由回执记录；本报告不预写尚未产生的 Git 身份。
