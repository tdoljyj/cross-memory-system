# Trial 4 报告：固化 HEAD → 真实迁移 → 外部 conformance → 持久 worker enable → fast-forward push（PILOT-VALIDATED）

- **时间**：2026-08-20
- **授权**：产品所有者正式裁决 ——「固化 HEAD PASS，授权 Trial 4 与 fast-forward push」→「最终裁决：Trial 4 PASS，R3 升级为 PILOT-VALIDATED」
- **构件**：`a418618`（a41861835d989feed4008b7ac31bd34a901bf251）；**Binding**：`codex-workbuddy-windows-primary`
- **结果**：**四阶段全 PASS；终态 ACTIVE / ONLINE / ENFORCED；push 成功（9dcc31b..a418618 → origin/main）**

---

## Step 0：硬门槛（全 PASS）

| 项 | 结果 |
|---|---|
| HEAD=a418618 / worktree clean | ✓ / porcelain 零输出 |
| 全量 542（38 文件） | **448 PASS / 0 FAIL / 94 SKIP / 0 ERROR**（nonzero_exit=[]） |
| 归因 | **ENV 63 / HEURISTIC 31 / UNKNOWN 0**（63+31=94） |
| 备份目录 `legacy-migrate-trial4-01/` | 不存在 ✓ / 授权白名单内 ✓ |
| 唯一 legacy Binding | directory-legacy，ACTIVE/ONLINE/**ENFORCED**（list_bindings/find_by_agent 唯一命中） |
| journal/tmp | =0 ✓ |
| 隔离测试（26/26 PASS） | A 组 6 项：ENFORCED 输入直接喂 worker migrate → **PRE fail-closed 拒绝**（三轴必须 ADVISORY），回滚保持原状 ⇒ 不存在「继承 ENFORCED」的迁移路径；B 组 20 项：授权流程（备份 ENFORCED 逐字节 → 旧 receipts 入只读备份 → 恢复 legacy 扁平 ADVISORY → worker migrate）→ 新布局 **ADVISORY**，ENFORCED 仅存于备份且 SHA-256 一致 |
| 旧 truth-state / receipts | 已纳入只读备份（run_id 各异，新流程不复用） |

注：全量测试运行器曾在本环境因子进程管道句柄继承卡死；已改为文件重定向捕获（方法学不变：逐文件子进程 + PASS/FAIL/SKIP 行统计），单实例完整跑通 38 文件。

## Step 1：真实 schema 迁移（持久 worker 单次，run_id=trial4-migrate-codex-workbuddy-windows-primary-01）

| 项 | 结果 |
|---|---|
| ENFORCED legacy 现场 | 整体 os.replace 移入证据区（directory-legacy-dir/），不删除；字节副本 `binding.directory-legacy.bin/.json` SHA-256 一致 |
| 旧证据 | old-conformance/enable/migrate receipts、old-truth-state、old-trial3b-lock、worker stdout/stderr 全部入备份（只读） |
| legacy 扁平恢复 | SHA-256 == trial3b flat（逐字节一致） |
| worker migrate | **DONE**（flat_sha256 与 trial3b 一致；receipt exit=0 migration=DONE） |
| 新布局终态 | `binding.json`=clued.binding.v0.1 manifest（校验 PASS，binding_id 关联一致）+ `state.json`=lifecycle.state.v0.1 三轴 **ACTIVE/ONLINE/ADVISORY** |
| list/find/doctor | list_bindings 唯一命中、find_by_agent `_layout=directory`、registry 不 corrupt（binding doctor PASS） |
| journal/tmp / 保护区 | =0 / git porcelain 零输出 |

## Step 2：真实 Conformance（外部 verifier，run_id=trial4-conformance-codex-workbuddy-windows-primary-01）

- **verdict = ENFORCED（候选）**：revision/digest=`a418618`；P0-3 冻结 isolated 语义（environment=isolated，summary 固化标注）；
- 生产入口 5 入口 checked=5 / bypass=**0**；版本矩阵 vNext-2.0 / vNext-1.3 / 0.3.0 / 1 / 1 一致；
- 故障注入：篡改 receipt_digest → **ADVISORY**（RECEIPT_TAMPERED）；证据过期 → **ADVISORY**；
- receipt 新鲜原子落盘（无 .tmp）；truth-state 强绑定写入 + 副本入证据区；
- **未自动修改 Binding**：conformance 后仍 ACTIVE/ONLINE/ADVISORY。

## Step 3：真实 Enable（已验证持久 worker 单次，run_id=trial4-enable-codex-workbuddy-windows-primary-01）

| 项 | 结果 |
|---|---|
| 终态 | **ACTIVE / ONLINE / ENFORCED**（state.json 三轴，schema lifecycle.state.v0.1） |
| enable 调用次数 | **1**（receipt.enable_calls=1） |
| receipt | 原子落盘（exit 0，transition=ADVISORY -> ENFORCED，run_id 固定） |
| binding doctor / journal/tmp / 保护区 | PASS / =0 / 零修改（porcelain 零输出） |
| conformance receipt 闭合 | verdict=ENFORCED、revision=a418618 一致 |

## Step 4：授权 fast-forward push

- 预检 6/6 PASS：origin/main 精确 9dcc31b；9dcc31b 是 a418618 祖先；ahead/behind=25/0；worktree clean；**tracked secret scan 零命中（429 文件）**；
- 执行：`git push origin a418618:main` → **9dcc31b..a418618 → main（普通 fast-forward，无 --force/tag/release）**；
- 收尾：local HEAD = remote main = **a418618**；ahead/behind=**0/0**。

---

## 产品所有者最终裁决（2026-08-20）

| 层级 | 裁决 |
|---|---|
| Trial 4 | **PASS** |
| 真实 Binding | **ACTIVE / ONLINE / ENFORCED** |
| R3 授权交付范围 | **PASS** |
| 真实受控试装 | **PASS / PILOT-VALIDATED** |
| 跨平台、其他 Agent/Binding 泛化 | PARTIAL / 未验证 |
| 发布状态 | UNRELEASED |
| Tag / Release / Purge | NO |

**ENFORCED 严格限定于**：Binding `codex-workbuddy-windows-primary` + 构件 a418618 + 合同 v1 + Windows/Python 3.13.x + clued.binding.v0.1＋lifecycle.state.v0.1 + 当前通过 conformance 的构件与证据组合。运行时仍须执行证据新鲜度与强绑定校验；不得扩展为所有平台或所有 Adapter 已 ENFORCED。

**测试口径固定**：542 = 448 PASS / 0 FAIL / 94 SKIP / 0 ERROR；SKIP：ENV 63 / HEURISTIC 31 / UNKNOWN 0；不得简称「全量全绿」。

**R3 开发执行阶段至此收口**：后续进入独立的真实使用观察期；发布与版本标签继续另行裁决。
