# Clued P2 独立复验与合并 Closeout 报告 v1.0

日期：2026-08-26
执行身份：`Codex@TURING`

## 最终裁决

`PASS / P2_CLOSEOUT_ACCEPTED`

独立运行时复验裁决：`PASS / P2_INDEPENDENT_RUNTIME_REVIEW_ACCEPTED_FOR_FF_MERGE`。

fast-forward 合并裁决：`PASS / P2_FF_MERGE_COMPLETED`。

P2 的三轮实现与修复、独立离线复验、候选对象校验及 fast-forward-only 对齐均已闭环。P3–P6 仍未执行且未授权。

## 固定候选与 Git 对象

- P2 候选 Commit：`1fc9c5faa4ba9e09f1bc69e1bdea69732111e214`
- 唯一父提交：`40abd21c3bb3b98dd43af19c2f4e2c187983b560`
- 候选 Tree：`39d9a1bfaca06fd66416e2c0d5f2fcfe8d4efc50`
- 完整祖先链：`7f1bc29cfd8f2ff80b24c7e10f55f1bc0a3df3e0 → 69254f3b8d3e5ac3604f8fd0c2ee1d8118f866d1 → 40abd21c3bb3b98dd43af19c2f4e2c187983b560 → 1fc9c5faa4ba9e09f1bc69e1bdea69732111e214`
- 开始门禁时远端 `main`：`1fc9c5faa4ba9e09f1bc69e1bdea69732111e214`
- 写入本报告前再次查询的远端 `main`：`1fc9c5faa4ba9e09f1bc69e1bdea69732111e214`

候选 Commit 经 `git show` / `rev-parse` / `rev-list` 独立核对，Commit、唯一父提交、Tree 和祖先链与固定事实逐项相同。

## 三轮修复过程与阻断关闭

### 第一轮：Request-local Verification Context

Commit `69254f3b8d3e5ac3604f8fd0c2ee1d8118f866d1` 在固定基线 `7f1bc29c…` 上引入 P2 Request-local Verification Context、边界独立 Evidence、版本包络和 F07/F08/F09/F25/F27/F30/F31 等失效/拒绝回归。该轮建立了“PASS 只在同一请求 Context 内复用、跨请求重新校验”的主体实现与测试骨架。

### 第二轮：权威输出绑定实时 Evidence

Commit `40abd21c3bb3b98dd43af19c2f4e2c187983b560` 关闭第一轮复审阻断：

- `authoritative=true` 必须绑定指定 boundary 上仍有效的成功 `BundleEvidence` 与完整 `SourceEnvelope`；零验证、失败验证、缺 boundary、Evidence 失效或跨 Evidence/跨 boundary 错绑均拒绝或降为非权威。
- `summary()` 改为从当前 Evidence 输出实际 Repository、Snapshot、Authorization、Version Envelope、Validator Contract 与 Doctor Version，不再返回无条件常量 PASS。
- Validator PASS 后、Evidence 创建前再次逐文件流式计算 SHA-256；中间篡改以 `manifest:hash-mismatch:data.txt` fail-closed，且不创建或缓存成功 Evidence。
- Owner Ref 与 Bundle Scope 的期望值固定来自版本化可信端点配置 `config/clued-endpoint-trust.json`；缺失、不匹配或配置变化均失效。
- PowerShell 非 `NONE` 路径收敛为单 Python 进程、单个不可序列化 Context，贯穿 align-and-verify、Mirror 与 doctor。
- 删除无业务意义的人工重复验证，只保留真实业务链路的 reuse。

### 第三轮：doctor 文档契约对齐

Commit `1fc9c5faa4ba9e09f1bc69e1bdea69732111e214` 只修改以下 5 个文件：

- `AGENTS.md`
- `artifacts/clued-validation/p2/7f1bc29c/SHA256SUMS`
- `artifacts/clued-validation/p2/7f1bc29c/p2_raw_results.jsonl`
- `docs/clued-two-level-views/Clued_P2_Request-local_Verification_Context_验收报告_v1.0.md`
- `tests/test_p2_verification_context.py`

该轮关闭最终文档契约阻断：`sync-memory.ps1 -AlignAndVerify` 的同一请求必须在同一个 Python 进程、同一个 Context 内完成 Mirror 与 doctor；成功后不得在同一请求中另起 `python memory.py doctor`。standalone doctor 明确定义为新的 doctor-only 请求，必须创建新 Context 并重新校验。对应正向契约与旧矛盾指令缺席均有回归测试锁定。

## Request-local 行为独立裁决

- 每一个非 `NONE` 请求执行一次真实 `git ls-remote`；Remote SHA 未变化也不复用上一请求结果，查询失败不以旧 SHA 降级。
- 实际 PowerShell Fixture 连续执行两个独立请求；每个请求一个 Python 进程、一个 Context，两个 `verification_id` 不同。
- 每个 Mirror + doctor 请求的真实计数为 `full_validation_count=3`、`reuse_count=1`：源、复制候选、本地 Mirror 三个真实边界完整校验，doctor 仅在同请求复用源 Evidence。
- 新请求创建新 Context、重新查询 Remote Head、重新完整校验，不跨请求复用 PASS Evidence。
- standalone `python memory.py doctor` 和 `python sync-memory.py doctor` 均属于新的 doctor-only 请求并创建新 Context；本轮 `memory.py doctor` 实测 `full=1/reuse=0`。
- `NONE` 在 Context、Git、Pointer、Manifest 和 Memory 读取前返回；本轮两次入口实测均为 exit 0、零 Git、零 Memory 读取。

## fail-closed 与拒绝等价

- F05：源 Manifest 文件哈希错误在复制前阻断；旧兼容路径与 P2 Context 路径均拒绝，不产生成功状态、切换或 Backup，既有 LKG 不变。
- F06：复制后目标损坏在目标独立校验阶段阻断；旧兼容路径与 P2 Context 路径均拒绝，Current Pointer 与既有 LKG 不变。
- dirty worktree、网络不可用、真实 Git divergence、Malformed Remote Ref 继续保留原错误分类并 fail-closed。
- Remote Head 查询失败不复用旧 SHA；Git divergence 不与 Canonical CAS Conflict 合并。
- 未发现“旧路径拒绝、新路径接受”。

## 独立离线复验结果

全部同步、损坏、Git 与请求链场景均在一次性本地 Fixture 中执行；未连接生产服务。

| 验证 | 本轮独立结果 |
|---|---|
| P2 专项 `tests.test_p2_verification_context` | `28/28 PASS`，47.713s |
| AGENTS 文档契约 | `1/1 PASS`，0.000s |
| Evidence 权威负向测试 | `6/6 PASS`，3.602s |
| F05/F06 定向回归 | `4/4 PASS`，11.579s |
| 实际非 NONE PowerShell 单请求/下一请求隔离 | `1/1 PASS`，19.199s |
| Python 全量 `unittest discover` | `48/48 PASS`，0 fail，70.075s |
| Clued Cloud 本地 `build-verified.sh` | `PASS`，完成 5 阶段 vinext build；未部署 |
| Cloud 离线合同回归 | `63/63 PASS`，0 fail，0 skip，2564.814ms |
| standalone `python memory.py doctor` | `PASS`，710 个 Manifest 文件，新的 `verification_id=6938e5bc153c41e9883a3a3624885a56`，`full=1/reuse=0` |
| standalone `python sync-memory.py doctor` | `PASS`，一次性本地 Mirror Fixture，新 doctor-only 请求 |
| PowerShell `-AlignAndVerify -Access NONE` | `PASS`，exit 0，零 Git、零 Mirror/Memory 读取 |
| Python 源码编译检查 | `5/5 PASS`；采用内存编译以避免生成额外文件 |
| `git diff --check` | `PASS` |

运行时前置排障不计入 P2 断言结果：默认 Python 3.13 安装缺少标准库 `difflib`，沙箱默认临时目录不可写；两类尝试均在进入相关测试断言前终止。正式独立复验固定使用仓库证据一致的 Python 3.12.13 与本轮隔离临时目录。尝试将 bytecode 缓存重定向到隔离目录时因缓存层级不存在而在编译前退出，随后使用不落盘的等价内存编译完成 `5/5 PASS`。这些排障未修改仓库文件或 P2 结论。

## 固定证据

- P2 验收报告 Blob：`8c2a950f296a3e84004304c64b92f008e8daf7d9`
- P2 原始结果 Blob：`9d6ec2903b2e789a0bd8239230a5434c3479363d`
- `SHA256SUMS` Blob：`513bc1ab8b6089d1874855391babc75e77a64abc`
- `SHA256SUMS` SHA-256：`3c5bb55222e0d81102c1fd2730c4edfccd33752b6b3f0bb1f0f7157726497e1a`

本轮在候选 Commit 上使用 `git ls-tree` 与本地 SHA-256 重算逐项确认上述三个 Blob 和 `SHA256SUMS` 内容哈希完全一致。原 P2 候选 Tree 未改动。

## fast-forward-only 合并事实

开始时本地 `main` 为 `19504e8bcbb3764788f3c748975063e53a2a28f0`，工作树干净；远端 `main` 已精确指向固定 P2 候选 `1fc9c5fa…`。执行 `git fetch origin main` 后确认本地 HEAD 是候选祖先，再执行：

`git merge --ff-only 1fc9c5faa4ba9e09f1bc69e1bdea69732111e214`

结果为 `Updating 19504e8..1fc9c5f` / `Fast-forward`。未产生 merge commit，未执行 squash、rebase、amend、force push 或任何历史重写。P2 候选的唯一父提交和 Tree 均保持固定值。

## 工作树与未执行事项

开始门禁前、ff-only 对齐后、全部独立测试后及生成本报告前，相关 Git 工作树均为干净状态。提交门禁要求 staged diff 只包含本报告；Closeout Commit 必须是候选 `1fc9c5fa…` 的普通单父提交，推送后再次核验远端、父提交、单文件新增、候选 Tree、证据 Blob 与全部相关工作树。

本轮未执行：

- P3、P4、P5 或 P6；P3 仍未授权。
- 生产服务访问、生产数据库访问、部署或生产配置变更。
- Tag、Release、数据库/RLS 变更。
- Snapshot、Manifest、Current Pointer 的修改、生成、切换或发布。
- P2 实现、测试、原始证据或验收报告的任何修改。
- Backup、正式 Mirror 切换或 Canonical 写入。

## sources_read

在用户禁止生产访问的边界内，连续性校验采用只读仓库 Snapshot 回退：

- `memory/manifest.json`
- `artifacts/clued-two-level-snapshots/current.json`
- `memory/global/state.md`
- `memory/global/task.md`
- `memory/global/decision.md`
- `memory/projects/0597aa60-9b98-4da6-a4ab-63d7705b632f/state.md`
- `memory/projects/0597aa60-9b98-4da6-a4ab-63d7705b632f/task.md`
- `memory/projects/0597aa60-9b98-4da6-a4ab-63d7705b632f/decision.md`
- `docs/clued-two-level-views/Clued_P2_Request-local_Verification_Context_验收报告_v1.0.md`
- `artifacts/clued-validation/p2/7f1bc29c/p2_raw_results.jsonl`
- `artifacts/clued-validation/p2/7f1bc29c/SHA256SUMS`

本地 `memory.py doctor` 结果为 Snapshot `snap_f6134235591bfcbfe4ba3a674383c3e0` / Canonical Version `cv_155`、`current + live_rechecked + views_complete`、710 个 Manifest 文件全部通过。未调用在线 Canonical Store，未进行 Canonical 写入。

## Closeout

三轮 P2 阻断已全部关闭，独立运行时复验接受候选进行 fast-forward 合并，ff-only 对齐已完成，固定证据保持不变。本轮唯一允许的新业务文件为本 Closeout 报告。

最终裁决：`PASS / P2_CLOSEOUT_ACCEPTED`
