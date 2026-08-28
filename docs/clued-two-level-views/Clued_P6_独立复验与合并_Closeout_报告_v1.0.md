# Clued P6 独立复验与合并 Closeout 报告 v1.0

## 1. Closeout 裁决与固定边界

`PASS / P6_CLOSEOUT_ACCEPTED`

本报告对 P6 Shadow、Canary、Snapshot Publish/Rollback 的仓库实现链、冻结变更范围、r4 Evidence、P5 回归 Evidence、Release Gate 合同与进入 `main` 的 Git 事实执行一次独立只读 Closeout 核验，并将核验结论作为唯一新增文件入库。

本裁决只关闭 P6 的仓库实现与隔离验证阶段，不代表生产能力已经启用。以下项目明确不属于本次 PASS：

- G6-3B 生产真实流量 Shadow；
- 24 小时观察与至少 1,000 个合格生产读请求；
- 真实 Canary、流量切分与自动回退实操；
- G6-P 生产 Worker、Supabase、Binding、Pointer 或流量操作；
- G6-R Tag、Release、100% Promotion 与旧路径退休；
- DNS、Secrets、Migration、正式 Snapshot、Manifest、Current Pointer 或 `VERSION` 修改。

固定事实：

- P5 Closeout / P6 固定基线：`59ce5224b18bad502184a26e8c00f9e51521e41e`
- P6 最终实现提交：`015d41f0f920a8ce29da17d9f4f841db4cc7b3eb`
- Closeout 核验前远端 `main`：`c1789dd64d5e3717aa09fcf9588cb57d1ab009f6`
- r4 Evidence：`artifacts/clued-validation/p6/59ce5224-r4/`
- Closeout 报告路径：`docs/clued-two-level-views/Clued_P6_独立复验与合并_Closeout_报告_v1.0.md`

本报告的 Closeout Commit 必须以核验前远端 `main` 为唯一父提交，且 Commit diff 只能新增本报告。Commit SHA、报告 Git Blob 与报告 SHA-256 在提交后单独复核，不写入报告正文，避免自引用。

## 2. 权威 Git 提交链与历史更正

远端 Git 对象证明 P6 实际提交链为：

`59ce5224b18bad502184a26e8c00f9e51521e41e`

→ `08a765911ce64dbeeca925adcda718742278141a`
`[Codex@TURING] P6 isolated shadow canary publish rollback candidate`

→ `3fb8c05d806f69e0a3f165967ebfce4b41aa2630`
`[Codex@TURING] Fix P6 lock ownership and shadow semantics`

→ `d955ddeb44da08f304275c27be1f06874256d706`
`[Codex@TURING] Serialize P6 lock ownership transitions`

→ `015d41f0f920a8ce29da17d9f4f841db4cc7b3eb`
`[Codex@TURING] Retry transient Win32 P6 transition contention`

四条 Commit 均为普通单父提交；第一条唯一父提交为固定基线，后续每条唯一父提交为链中前一条。相对固定基线，最终实现 ahead 4、behind 0、merge commit 数为 0。

此前曾因 `08a7659…` 在独立复验环境不可取得而裁决 `UNAVAILABLE / UNVERIFIABLE`。该失败作为历史事实保留，不被本报告删除。当前远端已能读取该 Commit、Tree、Diff，且它是最终实现提交的可达祖先，因此本次不继承旧的“对象缺失”判断，而是对固定基线至 `015d41f…` 的完整四 Commit 范围重新核验。

同时更正一项旧叙述：`3fb8c05…` 的唯一父提交不是固定基线，而是 `08a7659…`。本报告只采用远端 Git 对象给出的真实拓扑。

## 3. 进入 main 与后续不可变性

Git 祖先关系证明：

- `015d41f…` 是当前远端 `main` 的祖先；
- `015d41f…` 之后的第一条提交 `e088b275d95f10f30587470476807213b847d8a4` 以它为唯一父提交；
- 当前 `main` 相对 `015d41f…` ahead 8、behind 0，merge-base 精确为 `015d41f…`；
- P6 进入主线后，后续变更只涉及前端显示文件、前端测试与 `protocol/continuity/v1/README.md`；没有再次修改 P6 实现、P6 Evidence、Migration、`memory/`、正式 Snapshot Pointer 或 `VERSION`。

因此 P6 最终实现已被主线包含，且在本次 Closeout 前未发生内容漂移。当前未找到独立 P6 功能分支引用，但最终 Commit 及全部祖先均由 `main` 可达，Git 对象可持续取得；分支引用缺失不影响已合入对象的可审计性。

## 4. 冻结变更范围复核

固定基线至最终实现累计变更 44 个文件。逐项与 `tests/test_p6_release.py` 的冻结 allowlist 比对结果：

- unexpected paths：0；
- forbidden paths：0；
- 新增 Migration：0；
- `memory/` 修改：0；
- P5 Evidence 修改：0；
- published Snapshot 修改：0；
- `artifacts/clued-two-level-snapshots/current.json` 修改：0；
- `VERSION` 修改：0；
- `.openai/hosting.json` 修改：0；
- `wrangler.jsonc` 新增或修改：0；
- `apps/clued-cloud/package-lock.json` 修改：0；
- 新增行尾空白或冲突标记：0。

所有实现变更均位于 P6 冻结源码、测试、Runbook 与 `artifacts/clued-validation/p6/` Evidence 范围内。

## 5. Release Gate 合同独立只读复核

本轮没有重写代码、重生成 Evidence 或连接任何生产目标。核验者直接读取最终实现 Git 对象，对 `tests/test_p6_release.py` 的 13 项门禁条件逐项重新求值：

| 门禁 | 结果 |
| --- | --- |
| 固定基线为祖先、P6 范围无 merge commit | PASS |
| 变更保持在冻结 P6 allowlist | PASS |
| 禁改文件、Migration、P5 Evidence 不变 | PASS |
| Snapshot CLI 缺少 Expected-Current 时 fail closed | PASS |
| M2 publish/rollback 共享 CAS 与 reconciliation 合同 | PASS |
| Shadow、Canary、Affinity 与版本归因 fail closed | PASS |
| Publication Lock 使用可信本地时间与 owner token | PASS |
| F26 保持 State/Task/Decision 高于历史 Log | PASS |
| F01–F32 均存在可执行测试覆盖引用 | PASS，缺失 0 |
| P5 `SHA256SUMS` 覆盖的 11 份 JSONL 仍匹配 | PASS，11/11 |
| P6 新文件无生产目标、部署命令或常见密钥前缀 | PASS |
| P6 package scripts 仅指向本地测试和 Evidence 校验 | PASS |
| r4 P6 Evidence SHA-256 全部匹配 | PASS，7/7 |

该核验是对远端冻结源文件、Git 拓扑和 Evidence 的独立只读复算；它不会把已提交的动态测试声明伪装成本轮重新运行结果。动态测试结果以 r4 不可变 Evidence 为实施证据，本轮通过源码合同交叉检查与逐字节哈希复核确认其未被篡改或漂移。

## 6. r4 Evidence 逐字节复核

`SHA256SUMS` 自身 SHA-256：

`e1c6d743e395a339e867e6edb7481e74882f746845d64a252cfa3a4d41c583cf`

| 文件 | Git Blob SHA | SHA-256 | 结果 |
| --- | --- | --- | --- |
| `canary_state_machine_evidence.jsonl` | `13c8df2767255a122faa6bc333f8dcfcf62f8ced` | `f235d77424a0ca7f29affcefcbf4618352a0941e875bd5c0f04d5f91cd8e86d0` | MATCH |
| `candidate-verification-scope.md` | `7b462b0dcb3d16a342ed931b50498de12ff7eece` | `c1c33b789bc7d8e57585f36ceb10a2406a60ea8e9f6f87640da8cec175a15669` | MATCH |
| `f19_publish_rollback_evidence.jsonl` | `df09f02aeb2bbb7dbd5a260c4d4f6ddacad773e4` | `88dcd6996d5c5f5e54c09e1befc481b9a26800dae70de56b451872d0fb8fded0` | MATCH |
| `f26_authority_conflict_evidence.jsonl` | `ed110bd92336aa42ae3c9424bb9e85f754100ee8` | `cfc2ce0f7da812af3f1dbf4f92d1760650f213ab3b07589a9d7abfc273c0036a` | MATCH |
| `isolated_shadow_evidence.jsonl` | `6f7eb7e1d83f8be602f8d2d2317dc979177f84cc` | `b7f1a6a409586cd414db3dd956d258265d24fa01c8d21a6d590ea167aab8c9e5` | MATCH |
| `migration_rebuild_restore_evidence.jsonl` | `943b8c62228396a95f97d9db5bfbf7b0261608fb` | `458d7ffe14e142f9da893d7871e4b0b9860c90cc4801af7a1fb81ce06ca5f940` | MATCH |
| `p6_raw_results.jsonl` | `ef99ae574ec90c26f65270f2334b03759a5e89bf` | `0006d112b829fc4924a62b6b4431dedc71dff30fb044b1d15301401c7703726b` | MATCH |

Evidence 语义复核结果：

- F19：可信时间、owner-token release、250 次重叠 transition stress、CAS、故障窗口、正式读回与自动恢复均记录为 PASS；
- F26：Snapshot、API、MCP、UI Contract 四个表面均保持 `state_task_decision` 为当前权威，Log 仅为历史 Evidence，冲突显式报告；
- G6-3A：固定合成夹具 5 条，hard differences=0，unclassified differences=0；
- 隔离 PostgreSQL：15 条既有 Migration，全链重建、双同源数据库 replay、RLS/GRANT、Receipt/Event/Idempotency、备份恢复均 PASS，`new_migration_added=false`；
- Canary：0%、1%、5%、25%、50%、100% 状态机与 HOLD/STOP/AUTO_ROLLBACK/ADVANCE 均被验证，但 `real_canary_executed=false`；
- 发布控制：`production_enabled=false`；未设置 `P6_RELEASE_CONTROL_ENABLED` 时不会启用发布控制；
- `p6_raw_results.jsonl` 明确记录 `g6_3b=NOT_EXECUTED_NOT_AUTHORIZED`、`real_canary=NOT_EXECUTED_NOT_AUTHORIZED`、`production_access=false`。

## 7. P5 回归 Evidence 未漂移

P6 Release Gate 引用的 P5 冻结目录 `artifacts/clued-validation/p5/8327b6b0/` 已重新读取并逐字节计算。`SHA256SUMS` 覆盖的 11 份 JSONL 全部匹配，未发现 P6 对 P5 CAS、幂等、RLS、事务原子性或 Gateway Evidence 的修改。

结果：`PASS / P5_FROZEN_EVIDENCE_UNCHANGED_11_OF_11`

## 8. 生产与发布边界

本次 Closeout 没有执行：

- 生产 Worker 读取、上传或部署；
- 生产 Supabase 连接、查询、Migration 或数据写入；
- DNS、Binding、Secret、Transform Rule 或流量配置修改；
- 真实 Shadow、真实 Canary、24 小时观察或 1,000 请求采样；
- 正式 Snapshot publish/rollback、Manifest 或 Pointer 切换；
- Tag、Release 或 100% Promotion；
- 语义召回启用或重新评估。

这些事项继续分别受 G6-3B、G6-P、G6-R 或后续 Kernel Next Gate 约束。P6 仓库阶段关闭不能作为任何生产操作的隐含授权。

## 9. 本轮唯一入库变更

本轮 Closeout 只允许新增：

`docs/clued-two-level-views/Clued_P6_独立复验与合并_Closeout_报告_v1.0.md`

不得修改 P6 实现、测试、Runbook、Evidence、`memory/`、协议、Migration、Worker 配置或任何生产对象。Closeout Commit 必须是普通单父 Commit，唯一父提交为核验前远端 `main`；禁止 amend、rebase、squash、force push 或历史重写。

完成报告 Commit、普通 fast-forward 入库和提交后复核后，P6 仓库阶段正式关闭并封存：

`PASS / P6_CLOSEOUT_ACCEPTED`

