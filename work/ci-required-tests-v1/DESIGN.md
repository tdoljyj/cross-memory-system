# 测试、构建与迁移验证成为必需检查 · 设计说明 v2

- 日期：2026-11-01（UTC）
- KooYomi：项目 0597aa60；Task `2a5fdb66`（本工作），拆出的漂移检查 Task `16b795e6`；认领 `1b3d6e2f`。
- 依据：Owner 目标 Decision `afec9be8`（全部算力可调度、完整 CI/CD），顺序 Decision `02e4374a`（本项第 3 项）；费用规则 Decision `9eb313f8`（新作业只用自建算力，[Runbook §2.4](../../docs/maintenance/runner-configuration-and-operations.md#24-现有与未来任务的费用原则迁移与防回流)）；不稳定测试隔离 Task `679a0c2b`；配置改动先独立审核 `01d4ba7d`。
- 修订：v1 经独立审核 FAIL（1 BLOCKER、3 MAJOR），v2 逐项修正，见 §10。
- 状态：代码与测试在 PR #971；前置的门禁登记在单独的 PR（§7）。三项新检查还**不是**必需检查，加进规则集要 Owner 操作（§8）。

## 0. 结论

1. 一个工作流 `.github/workflows/clued-required-tests.yml`：一个 `admission-gate`，加三个检查 job，全部只在自建 Linux 池（`[self-hosted, Linux, X64, clued, pool-general, trust-internal]`）上跑，不用 GitHub 托管分钟：
   - `clued-cloud-tests`：apps/clued-cloud 的 lint、迁移账本校验、typecheck、build、单元测试；
   - `ci-suites`：常驻层 Node/Python 测试、离线演练、Source v2 测试、组件版本检查、runner 费用策略检查、准入自测、选择脚本自测；
   - `migration-verify`：迁移在**生产 schema** 上验证，并检出漂移。
2. 生产 schema 漂移检查不需要任何生产凭据：生产的 schema 只读快照（不含数据、不含秘密）提交在仓库里，PR 作业只读这个文件。它对今晚的真实 bug 有效：在最近 158 个迁移文件上只命中一处，正是 `20261023092957_ci_scheduling_stage1_v1` 里的 `b.expires_at`（§4.5）。
3. **前置条件（独立审核 B1）**：准入的门禁守卫只接受 `GATE_JOB_SHA256` 里登记过的 `admission-gate` 字节。新 gate（自建 runner 加独立 CI 准入来源）要先登记，摘要 `cba210b1db348367ba2332a6be5712aff39840531dbba393f075365f1dc2ba44`，而且常驻节点执行准入用的是**安装时钉住的** `clued-work-admission.mjs`（`one-shot.mjs` 核对 `evaluatorSha256`）。所以顺序是：登记 PR 合入 → 常驻节点 Source 升级到含这个摘要的版本 → 本 PR 才能被准入（§7、§8）。
4. 常驻层（`work/independent-ci-resident-v1/`、Source v2）的代码在本 PR 里**没有改动**。六项现有必需检查照旧由 App `5368905` 发布；三项新检查由 GitHub Actions（App `15368`）在自建 runner 上产出。
5. main 上本来就红的测试按**测试名**列进 `scripts/ci/ci-known-failures.json`，照样运行；列表外的失败让检查失败，列表内的测试变绿时给出提示，修好一条删一条。
6. 首次对照发现了生产里的真实漂移（§4.6），已作为已审例外记入快照，交给 Task `16b795e6` 处理。

## 1. 现状（2026-10-31 只读核实）

- 必需检查六项：`kooyumi-work-admission`、`gitleaks`、`trivy`、`contract-placement`、`kooyumi-admission-verified`、`kooyumi-merge-slot`，都钉 App `5368905`（[independent-ci.md](../../docs/maintenance/independent-ci.md)）。没有一项跑代码测试。
- `clued-cloud-quality-gate.yml`、`clued-components.yml` 等是 `disabled_manually`；`clued-work-admission.yml` 也停用，所以按旧来源等待准入的 gate 永远不放行。例：`clued-g4-database.yml` 在 PR 上的 `admission-gate` 成功、重型 job 全部跳过（run 41207238505），另一次在 `clued-ci-company-linux-01` 上 checkout 失败（run 41221260964：工作目录不是 git 仓库）。
- 自建 runner 在线：`clued-ci-company-linux-01..04`、`clued-ci-company-win-01`、`clued-ci-home-win-01`（pool-general）。
- main `67893c2e` 上各套件在 TURING 本机的结果：常驻 Node 715 过 / 6 跳过；常驻 Python 87 过；离线演练 63/63；Source v2 Node 406/407（唯一失败是从子目录运行导致的路径重复，从仓库根运行即可）；组件检查、runner 费用策略通过；lint（0 error）、ledger:verify、typecheck、build 通过；**单元测试 2960 项中 86 项失败**（其余 2570 项通过）；准入自测 196 项中 4 项失败（工作流清单没跟上 `clued-native617-admission-dispatch.yml`、`clued-compute-panel.yml`）。

## 2. 为什么不改 `clued-cloud-quality-gate.yml`、不加常驻层角色

- 质量门是“已登记的普通 CI Source”：`scripts/ci/clued-work-admission.mjs` 的 `BOOTSTRAP_ORDINARY_SOURCES` 和 `scripts/ci/clued-gated-proof-profiles.json` 钉了它的确切字节和角色摘要，`scripts/ci/npm-cache-observation.test.mjs` 还断言它的托管 job 存在。改它要重新登记一代 Source。所以它保持停用，新检查用新名字。
- 把测试做成常驻层的正式角色（由 `5368905` 签发）要改 Source v2、Owner 接受后重装，而且测试要几分钟，会拉长每批。自建 Actions runner 已经在线、免费。

## 3. 三项检查怎么跑

### 3.1 结构

1. `admission-gate`（每次推送只有一个）：在 trusted base 上运行 `clued-work-admission.mjs --mode gate`，`CLUED_ADMISSION_GATE_SOURCE=independent-ci-native-work-admission`，等这个 head 上 App `5368905` 的 `kooyumi-work-admission`，最多 10 分钟。字节与 `contract-placement.yml` 已登记的 gate（`3f48159e…`）只差 `runs-on` 一行。
2. 三个检查 job 各自 checkout **trusted base** 到 `trusted/`、候选到 `candidate/`。选择、命令行和已知失败清单都来自 `trusted/scripts/ci/`；候选只是被测代码。
3. `node trusted/scripts/ci/ci-required-selection.mjs --check <检查名>` 用 API 列出 PR 改动文件，决定跑哪些套件；`--run <套件> --root candidate` 依次执行。

### 3.2 选择（`scripts/ci/ci-required-selection.mjs`）

- 每项检查下有若干套件，按路径模式选中。常驻层与 Source v2 互相 import，而且 import `scripts/ci/*`、读 `.gitleaks.toml`，所以这几个目录任何一处改动，两边的套件都跑；测试会扫描两个目录对外的 import，确认每个都被模式覆盖（独立审核 M3）。
- `clued-cloud-tests` 对任何改动都跑（应用测试会读工作流、合同、CI 脚本，路径排除不安全）。
- 改了选择脚本、已知失败清单、本工作流或 `.github/actions/**`：所有套件都跑。
- 拿不到改动列表（push、API 失败、列表到 GitHub 3000 文件上限）：所有套件都跑。
- 没有套件被选中：检查照样出现并成功，摘要写“not affected”。所以三项都能成为必需检查。
- 引入选择脚本的这个 PR 本身：base 上还没有脚本，工作流退回候选自带的副本并出警告。

### 3.3 信任、命名与重跑

- job 只在 `admission-gate` 放行、且是 push 到 main 或同仓库 PR（作者是 Owner，或 gate 认可的受信自动化路线）时运行。
- job 名把这些条件也算进去：不满足时名字是 `<检查名>-skipped`，必需检查根本不出现，PR 合不了（fail closed），条件跳过的 job 不会冒充成功。
- 被测代码（候选的 package.json 脚本、`run-tests.mjs`、`select-tests.mjs`、测试本身）是候选里的；它们由受保护路径和审查把关，trusted base 只钉住“跑哪些、用什么命令行、哪些失败是已知的”。
- 重跑：“Re-run all jobs”重新经过 gate 的每 head 重跑规则；“Re-run failed jobs”只重跑失败的检查 job，沿用 gate 之前的输出，用于偶发失败的重试。
- 任何工作流里同名的 job 都能满足必需检查（GitHub 按名字计数）；`.github/workflows/**` 是受保护路径，新增同名 job 要 Owner 的 `repo.protected_change` Grant。在门禁守卫里显式拒绝其他文件使用这三个名字，列为后续项（§9）。

### 3.4 已知失败（Task `679a0c2b`）

- `scripts/ci/ci-known-failures.json` 按套件、按**确切测试名**列出 main 上已经失败的测试，每条带原因：`clued-cloud` 86 条、`admission-self-tests` 4 条。
- 带 `known` 的命令在 Node 测试运行器上加 JUnit 报告，按报告逐条判断：列表外的失败让套件失败（出 `::error`）；列表内的失败出 `::warning`；列表内的测试通过时出“now passes, remove it”。进程非零退出却没有任何失败用例（进程崩溃、导入错误）、或者报告为空，也算失败。
- 清单在 trusted base 上读取，候选改不了它；改清单本身会让所有套件都跑。
- `resource-center-storage-read-pdf-bounds` 的 62 条是 Windows 才失败（子进程 URL），预计 Linux 能过；第一次自建 Linux 运行后按提示删掉。

## 4. 生产 schema 漂移检查（Task `16b795e6`）

### 4.1 今晚的 bug 是怎么漏过去的

数据库测试都按文件名顺序装 `supabase/migrations/` 下的全部文件。其中有账本标为 `repository_only: never_applied` 的 P5 系列（`20260827031728_clued_p5_tenant_isolation_concurrent_writes.sql` 等），它给 `public.clued_agent_bindings` 加了 `expires_at`。生产从没跑过这些文件。plpgsql 函数体在创建时不检查列，`clued_ci_node_registration_v1` 在测试库能跑、在生产调用时失败（PR #967 修）。

### 4.2 快照（`apps/clued-cloud/supabase/production-schema/`）

- `catalog.sql`：只读，只查系统目录。范围是 `public`、`clued_private`、`clued_storage_source`、`clued_watchdog`、`mtpe_m0`、`mtpe_m0_test`、`mtpe_m0_work`。比较的内容：
  - 关系：类型、RLS、属主、视图定义 md5、序列参数；
  - 列：类型、非空、默认值、identity、generated；
  - 约束、索引、触发器、策略；
  - 函数：签名、含默认值的参数、返回、语言、属主、`security definer`、volatility、strict、leakproof、parallel、`proconfig`、函数体 md5（先去掉 LF 前的 CR）；
  - 枚举、domain；
  - 授权和默认授权：表、列、函数、schema 对 `anon`/`authenticated`/`service_role`/`authenticator`/PUBLIC 的授权。
  不比较注释、统计、存储参数和扩展对象。不读任何表数据，也不读角色口令。
- `applied.sql`：读 `supabase_migrations.schema_migrations` 的 version、name 和语句的 md5/长度（与账本记录的事实相同）。
- `catalog.json`：两次查询的结果，加上已审清单（§4.4），绑定 `catalog.sql` 的 sha256；每个对象一行，刷新时 diff 可读。
- 2026-10-31 18:45Z 的快照：297 行迁移历史（到 `20261031164748`），9523 个对象。

### 4.3 检查（`apps/clued-cloud/scripts/production-schema-drift.mjs check`）

全部离线，每次约 20–30 秒，用两个一次性的内嵌 PostgreSQL：

1. **生产链**（`production-schema-chain.mjs`）：快照里的每一行按生产的 version 顺序，用生产实际跑过的文本（迁移文件或 `ledger/history-only/`，用账本自己的 `evaluateLedger` 绑定 md5）重放。找不到来源的行直接失败（`production_row_not_in_repository`、`chain_row_unresolved`）。
2. 重放完的目录指纹必须**等于**快照（已审例外除外），否则 `production_schema_drift`；已审例外如果对不上任何实际差异，就是过期，报 `known_deviation_stale`。
3. **比快照新的账本行**（发布过、账本记了、快照还没刷新）在比较之后按顺序重放，不会丢，也不会被当成待上线（独立审核 M2）。快照最新版本之前、快照里却没有的账本行报 `chain_snapshot_missing_ledger_row`。
4. 每个待上线迁移按发布工作流 migrate 模式的方式应用：每个文件一个事务、一次 plpgsql `EXECUTE`，所以事务控制语句或结尾的 `SELECT ... INTO` 在这里同样失败。
5. **仓库链**：另一个库按文件名顺序装全部文件（就是测试看到的样子），列出“只有仓库链有的列和函数”（今天 166 个）。
6. 待上线迁移通过表名或绑定到该表的名字（`b public.clued_agent_bindings;` 声明的变量、FROM/JOIN 别名）读取这类列时失败（`pending_migration_uses_repository_only_schema`）。同一个名字在文件里也绑定到另一个生产里确有该列的表时，不算命中；注释不参与匹配。确实要这样写就在文件里写 `-- production-schema: allow <schema>.<table>.<column>`。不带限定的列名（`select expires_at from t`）不在规则内，这是启发式规则的已知局限（§4.8）。

### 4.4 已审清单（都在 `catalog.json` 里，每条带原因，每条都被核对）

- `prehistory`：`202608230001_clued_continuity.sql`。生产第一行历史就是在改 `clued_agent_bindings`，这张表在迁移历史开始之前就存在。
- `replay_skip`：`history-only/20260919040423_p2_p6_activation_backfill.sql`，纯数据回填。这条行必须是生产跑过的，而且文本里不能有任何 create/alter/drop/grant/revoke/comment on 等 schema 语句。
- `replay_substitutions`：精确的单处文本替换（必须恰好出现一次），替换后的 schema 效果不变：`mtpe_m1_w6_w9` 的 `baseline_d3` 是生产数据的摘要；`pg_cron` 扩展由平台替身代替。
- `known_deviations`：已知的生产漂移（§4.6），**只能是确切键**，不接受通配符；对不上实际差异就报过期。
- 平台替身（`PLATFORM_SQL`）：照测试已有的 auth/extensions/cron 替身，默认授权照生产 `pg_default_acl` 的实际内容。

### 4.5 验证

- 用 18:45Z 的快照，在 TURING 本机套上 #967 修好后的文件（`be3ea75b`，迁移文件与账本）完整跑通：生产链 1 个 prehistory 加 296 行重放（1 行纯数据跳过），指纹与生产一致（含属主、参数默认值、列授权、序列参数），没有过期的例外，没有待上线迁移，结果 PASS。
- 重放还顺带确认了 `20261010161848_worker_gateway_closeout_v1` 里钉住的 G6 函数体 md5（只在按文件 LF 文本重放时才能通过；账本的 transform 记的是存储形态，不一定是执行形态）。
- 引用规则对最近 158 个迁移只命中一处，就是 `20261023092957_ci_scheduling_stage1_v1` 的 `b.expires_at`；#967 修过的写法（`to_jsonb(b)->>'expires_at'`）不命中。
- 单元测试：`apps/clued-cloud/tests/production-schema-drift.test.mjs`（14 项），选择、运行与已知失败：`scripts/ci/ci-required-selection.test.mjs`（18 项）。

### 4.6 首次对照发现的生产漂移（交给 Task `16b795e6`）

- `public` 里有一套任何迁移、history-only 文本、账本都没有来源的 v0 旧对象：`audit_receipts`、`bindings`、`devices`、`idempotency_keys`、`memory_objects`、`memory_revisions`、`profiles`、`tombstones` 八张表，以及 `clued_handle_new_user()`、`clued_set_updated_at()`、`rls_auto_enable()`。
- `mtpe_m0.source_kind`、`mtpe_m0_test.source_kind` 多出 `'evidence'` 标签，没有迁移加过。
- `mtpe_m0_work.drive59`：账本早已登记。
- 21 个函数在生产里是 CRLF 换行，代码与文件逐字相同（指纹已忽略 CR）。
- PR #967 那一行生产文本与文件不一致，已在 #967 `be3ea75b` 修正（文件改成生产实际文本、账本重新导出到 297 行）。

### 4.7 快照怎么刷新

- 刷新的人用只读连接（Supabase MCP 的 `execute_sql`，或只读角色的 psql）跑 `catalog.sql` 和 `applied.sql`，再运行 `node scripts/production-schema-drift.mjs import --catalog <结果> --applied <结果>`，开 PR。已审清单会保留下来；过期的例外检查会直接指出来。
- 建议每次生产发布后刷新一次。没刷新时，账本里比快照新的行在比较之后重放（§4.3 第 3 条），结论仍然成立，摘要提示“refresh the snapshot”；漏掉的只是快照之后发生的带外改动。检查不按时钟判过期，以免误报。
- 把刷新做进发布工作流要改受保护的发布工作流，并动用它的生产凭据，属于后续项，需要 Owner 批准。

### 4.8 局限

- 引用规则是名字绑定的启发式，不是语义分析：不带限定的列名、动态 SQL、`to_jsonb` 等写法看不出来。更彻底的办法是让数据库测试也按生产链建库（夹具支持 `CLUED_TEST_MIGRATION_CHAIN=production`），列为 Task `16b795e6` 的待办。
- 快照目录 `apps/clued-cloud/supabase/production-schema/**` 还不在受保护路径里（漂移脚本本身在 `scripts/` 下受保护）；放宽例外清单目前靠审查和上面的过期、精确键核对。加进受保护路径列为后续项。

## 5. 与常驻层、合并列车的关系

- 常驻层与 Source v2 的代码零改动。合并位报告器和合并执行器本来就按规则集实际要求的检查名和 integration 计数，新检查加进规则集后自动生效。
- 唯一的常驻侧依赖是 §7 的门禁登记：常驻节点执行准入用的是安装时钉住的 `clued-work-admission.mjs`，登记要随一次 Source 升级到达常驻节点。
- 列车车头批次测的是试合并提交 S；三项新检查跑在 PR 事件的合并 ref 上，main 前进后不会自动重跑。新检查只会多加限制，不削弱列车的不变量。车头批次重跑测试列为后续项。
- `clued-merge-slot-ci.yml`（停用中）的 `workflow_run` 清单不含新工作流；它重新启用之前要补上（准入自测里对应的那条已是已知失败）。

## 6. 费用

- 只用自建 runner 和 runner 本机的 `~/.npm`，没有 Actions cache、artifact、Packages、LFS，也没有托管 job。`validate_runner_budget_policy.py` 通过。每次推送只有一个 gate job 占 runner 等待准入（独立审核 m5）。
- 临时数据走 `ci-temporary-storage`，新工作流登记在 `coverage.json` 里，检查器对它没有发现。

## 7. 两个 PR 与顺序

1. **门禁登记 PR**（单独开）：在 `scripts/ci/clued-work-admission.mjs` 的 `GATE_JOB_SHA256` 里登记新 gate 的确切摘要 `cba210b1…`，并在 `clued-work-admission.test.mjs` 里断言它是“`contract-placement.yml` 的 gate 只把 `runs-on` 换成自建 Linux 池”。只改这两个文件。
2. 常驻节点的 Source 升级到含这次登记的 `clued-work-admission.mjs`（常驻准入用的是安装时钉住的副本）。
3. **PR #971**（本 PR）：新工作流、选择脚本、已知失败清单、漂移检查、`coverage.json` 一条。在 2 完成之前，它的 `kooyumi-work-admission` 会以 `admission_gate_changed` 拒绝。#967 先合（已在 `be3ea75b` 修好账本）。

## 8. 需要 Owner 做的事（逐项，Agent 都不做）

1. 批准门禁登记 PR 的受保护改动（`repo.protected_change`）。
2. 接受并安装（或原地升级）含这次登记的常驻 Source：常驻节点的准入评估器要换成新版本，这是 Source 变更，要 Owner 接受，安装时 UAC。
3. 批准 PR #971 的受保护改动。
4. 规则集 `24182890` 增加三项必需检查，integration 都钉 **GitHub Actions（App `15368`）**，不能留空：`clued-cloud-tests`、`ci-suites`、`migration-verify`。现有六项和 `strict` 等其他设置不变。建议在一个普通 PR 上看到三项都实际通过之后再加。
5. **不需要**重新启用任何停用的工作流，也不改 App、Secret、环境或 runner。

## 9. 后续项（不在本 PR）

- Task `16b795e6`：处理 §4.6 的漂移；建立快照刷新流程；让数据库测试支持按生产链建库；快照目录加进受保护路径。
- 门禁守卫拒绝 `clued-required-tests.yml` 以外的工作流使用 `clued-cloud-tests`、`ci-suites`、`migration-verify` 这三个 job 名。
- 修好已知失败清单里的测试，逐条删掉。
- `clued-g4-database.yml` 的 gate 还用旧准入来源，重型 job 从不运行；`clued-ci-company-linux-01` 的工作目录坏了（checkout 失败）。
- 数据库测试（`npm run test:db`，约 1740 项，main 上就有失败）按已知失败清单的方式接进来；常驻层的 Windows PowerShell 测试需要 Windows runner。
- 车头批次在试合并提交 S 上重跑这三项检查。

## 10. 独立审核（规则 `01d4ba7d`）

第一轮（v1，2026-11-01）FAIL：1 BLOCKER、3 MAJOR、9 MINOR、4 NIT。处理：

| 编号 | 问题 | 处理 |
| --- | --- | --- |
| B1 | 新 gate 字节未登记，准入以 `admission_gate_changed` 拒绝 | 合成一个 gate（§3.1），单独 PR 先登记摘要，再随常驻 Source 升级生效（§7） |
| M1 | 整套隔离会吞掉新失败 | 改成按测试名的已知失败清单，读 JUnit 报告逐条判断（§3.4） |
| M2 | 快照比账本旧时，已上线的迁移既不重放也不算待上线 | 比快照新的账本行在比较后重放；有缺口报错（§4.3） |
| M3 | 路径选择漏掉跨目录依赖 | 常驻层、Source v2、`scripts/ci/**`、`.gitleaks.toml` 互相触发，并有扫描 import 的测试（§3.2） |
| m1 | 例外清单可放宽、可过期 | 只接受确切键、过期报错、replay_skip 必须纯数据；目录保护列为后续 |
| m2 | 按文件隔离太粗 | 同 M1，按测试名 |
| m3 | 同名 job 可满足必需检查 | 写明依赖受保护路径；守卫规则列为后续 |
| m4 | 重跑说明不准确 | §3.3 改写 |
| m5 | 三个 gate 占 runner | 合成一个工作流一个 gate |
| m6 | merge-slot-ci 清单 | §5 写明 |
| m7 | 信任说法过头 | §3.3 改写 |
| m8 | 指纹漏项 | 加属主、参数默认值、leakproof/parallel、列授权、序列参数；重新抓取快照 |
| m9 | 不带限定的列引用 | §4.3、§4.8 写明局限 |
| NIT | 空展开、全零 base、rebuild 无超时 | 空展开与全零 base 报错；rebuild 加 `timeout` |
