# 测试、构建与迁移验证成为必需检查 · 设计说明 v1

- 日期：2026-11-01（UTC）
- KooYomi：项目 0597aa60；Task `2a5fdb66`（本工作），新拆出的漂移检查 Task `16b795e6`；认领 `1b3d6e2f`。
- 依据：Owner 目标 Decision `afec9be8`（全部算力可调度、完整 CI/CD），顺序 Decision `02e4374a`（本项第 3 项）；费用规则 Decision `9eb313f8`（新作业只用自建算力，[Runbook §2.4](../../docs/maintenance/runner-configuration-and-operations.md#24-现有与未来任务的费用原则迁移与防回流)）；不稳定测试隔离 Task `679a0c2b`。
- 状态：代码与测试在本 PR；三项新检查还**不是**必需检查，加进规则集要 Owner 操作（§8）。

## 0. 结论

1. 新增三项检查，全部只在自建 Linux 池（`[self-hosted, Linux, X64, clued, pool-general, trust-internal]`）上跑，不用 GitHub 托管分钟：
   - `clued-cloud-tests`：apps/clued-cloud 的 lint、迁移账本校验、typecheck、build、单元测试（`.github/workflows/clued-cloud-tests.yml`）；
   - `ci-suites`：常驻层 Node/Python 测试、离线演练、Source v2 测试、组件版本检查、runner 费用策略检查、准入自测（`.github/workflows/clued-ci-suites.yml`）；
   - `migration-verify`：迁移在**生产 schema** 上验证，并检出漂移（`.github/workflows/clued-migration-verify.yml`）。
2. 生产 schema 漂移检查不需要任何生产凭据：生产的 schema 只读快照（不含数据、不含秘密）提交在仓库里，PR 作业只读这个文件。它对今晚的真实 bug 有效：在最近 158 个迁移文件上只命中一处，正是 `20261023092957_ci_scheduling_stage1_v1` 里的 `b.expires_at`（§4.5）。
3. 常驻层（`work/independent-ci-resident-v1/`、Source v2）**没有改动**。六项现有必需检查照旧由 App `5368905` 发布；三项新检查由 GitHub Actions（App `15368`）在自建 runner 上产出。
4. main 上本来就红的测试没有被关掉，而是隔离运行、只出警告（§3.4）；隔离清单逐条写了原因，修好一条删一条。
5. 首次对照发现了生产里的真实漂移（§4.6），已作为已审例外记入快照，交给 Task `16b795e6` 处理。

## 1. 现状（2026-10-31 只读核实）

- 必需检查六项：`kooyumi-work-admission`、`gitleaks`、`trivy`、`contract-placement`、`kooyumi-admission-verified`、`kooyumi-merge-slot`，都钉 App `5368905`（[independent-ci.md](../../docs/maintenance/independent-ci.md)）。没有一项跑代码测试。
- `clued-cloud-quality-gate.yml`、`clued-components.yml` 等是 `disabled_manually`；`clued-work-admission.yml` 也停用，所以按旧来源等待准入的 gate 永远不放行。例：`clued-g4-database.yml` 在 PR 上的 `admission-gate` 成功、重型 job 全部跳过（run 41207238505），另一次在 `clued-ci-company-linux-01` 上 checkout 失败（run 41221260964：工作目录不是 git 仓库）。
- 自建 runner 在线：`clued-ci-company-linux-01..04`、`clued-ci-company-win-01`、`clued-ci-home-win-01`（pool-general）。
- main `67893c2e` 上各套件在 TURING 本机的结果：常驻 Node 715 过 / 6 跳过；常驻 Python 87 过；离线演练 63/63；Source v2 Node 406/407（唯一失败是从子目录运行导致的路径重复，从仓库根运行即可）；组件检查、runner 费用策略通过；lint（0 error）、ledger:verify、typecheck、build 通过；**单元测试 2960 项中 86 项失败，集中在 6 个文件**；准入自测 196 项中 4 项失败（工作流清单没跟上 `clued-native617-admission-dispatch.yml`、`clued-compute-panel.yml`）。

## 2. 为什么不改 `clued-cloud-quality-gate.yml`、不加常驻层角色

- 质量门是“已登记的普通 CI Source”：`scripts/ci/clued-work-admission.mjs` 的 `BOOTSTRAP_ORDINARY_SOURCES` 和 `scripts/ci/clued-gated-proof-profiles.json` 钉了它的确切字节和角色摘要，`scripts/ci/npm-cache-observation.test.mjs` 还断言它的托管 job 存在。改它就要重新登记一代 Source，范围远超本任务。所以它保持停用，新检查用新名字 `clued-cloud-tests`。
- 把测试做成常驻层的正式角色（由 `5368905` 签发）要改 Source v2、Owner 接受后重装（1 次 UAC 加 1 次 root），而且测试要几分钟，会拉长每批。自建 Actions runner 已经在线、免费，信任模型与现有 self-hosted 作业相同（§3.3）。

## 3. 三项检查怎么跑

### 3.1 结构（三个工作流相同）

1. `admission-gate`：在 trusted base 上运行 `clued-work-admission.mjs --mode gate`，`CLUED_ADMISSION_GATE_SOURCE=independent-ci-native-work-admission`，等这个 head 上 App `5368905` 的 `kooyumi-work-admission`，最多 10 分钟（与 `contract-placement.yml` 相同）。
2. 检查 job：先 checkout **trusted base** 到 `trusted/`，再 checkout 候选到 `candidate/`。选择和命令都来自 `trusted/scripts/ci/ci-required-selection.mjs`；候选只是被测代码。
3. `node trusted/... --check <检查名>` 用 API 列出 PR 改动文件，决定跑哪些套件；`--run <套件> --root candidate` 依次执行。

### 3.2 选择（`scripts/ci/ci-required-selection.mjs`）

- 每项检查下有若干套件，套件按路径模式选中；`clued-cloud-tests` 对任何改动都跑（应用测试会读工作流、合同、CI 脚本，路径排除不安全）。
- 改了选择脚本、三个工作流之一或 `.github/actions/**`：所有套件都跑。
- 拿不到改动列表（push、API 失败、列表到 GitHub 3000 文件上限）：所有套件都跑。
- 没有套件被选中：检查照样出现并成功，摘要写“not affected”。所以三项都能成为必需检查。
- 引入选择脚本的这个 PR 本身：base 上还没有脚本，工作流退回候选自带的副本并出警告（只有这一次）。

### 3.3 信任、命名与重跑

- job 只在 `admission-gate` 放行、且是 push 到 main 或同仓库 PR（作者是 Owner，或 gate 认可的受信自动化路线）时运行。
- job 名把这些条件也算进去：不满足时名字是 `<检查名>-skipped`。GitHub 把“条件跳过”的 job 当成功；如果跳过的 job 也叫必需检查的名字，就会悄悄放行。这样不满足时必需检查根本不出现，PR 合不了（fail closed）。
- 重跑沿用 gate 的规则（超出允许次数不放行，要推新提交）。
- 自建作业执行 PR 代码，与现有 self-hosted 作业同一信任边界：`.github/workflows/**`、`scripts/ci/**` 是受保护路径，改动要 Owner 的 `repo.protected_change` Grant 才能被准入。

### 3.4 隔离（Task `679a0c2b`）

- `UNIT_QUARANTINE`：main 上已经失败的 6 个单元测试文件，单独一条命令运行，失败只出 `::warning`，其余单元测试照常决定成败。`resource-center-storage-read-pdf-bounds` 在 Windows 上因子进程 URL 失败，预计 Linux 能过；第一次自建 Linux 运行后，能过的条目要删掉。
- `QUARANTINED`：整个套件失败只警告，目前只有 `admission-self-tests`（4 项在 main 上就失败）。
- 两个清单都写了逐条原因，测试要求原因非空。

## 4. 生产 schema 漂移检查（Task `16b795e6`）

### 4.1 今晚的 bug 是怎么漏过去的

数据库测试都按文件名顺序装 `supabase/migrations/` 下的全部文件。其中有账本标为 `repository_only: never_applied` 的 P5 系列（`20260827031728_clued_p5_tenant_isolation_concurrent_writes.sql` 等），它给 `public.clued_agent_bindings` 加了 `expires_at`。生产从没跑过这些文件，所以没有这一列。plpgsql 函数体在创建时不检查列，`clued_ci_node_registration_v1` 在测试库能跑、在生产调用时失败（PR #967 修）。

### 4.2 快照（`apps/clued-cloud/supabase/production-schema/`）

- `catalog.sql`：只读，只查系统目录。范围是 `public`、`clued_private`、`clued_storage_source`、`clued_watchdog`、`mtpe_m0`、`mtpe_m0_test`、`mtpe_m0_work`。内容包括关系、列（类型、非空、默认值、identity、generated）、约束、索引、触发器、策略、函数（签名、语言、返回、`security definer`、volatility、strict、`proconfig`、函数体 md5）、枚举和 domain，以及 `anon`/`authenticated`/`service_role`/`authenticator`/PUBLIC 的授权和默认授权。函数体、视图和策略只存 md5，函数体先去掉 LF 前的 CR。不读任何表数据，也不读角色口令。
- `applied.sql`：读 `supabase_migrations.schema_migrations` 的 version、name 和语句的 md5/长度（与账本记录的事实相同）。
- `catalog.json`：两次查询的结果，加上四份已审清单（§4.4），绑定 `catalog.sql` 的 sha256；每个对象一行，刷新时 diff 可读。
- 2026-10-31 的快照：297 行迁移历史（到 `20261031164748`），9485 个对象。

### 4.3 检查（`apps/clued-cloud/scripts/production-schema-drift.mjs check`）

全部离线，每次约 20–30 秒，用两个一次性的内嵌 PostgreSQL：

1. **生产链**（`production-schema-chain.mjs`）：快照里的每一行按生产的 version（应用时刻）顺序，用生产实际跑过的文本（迁移文件或 `ledger/history-only/`；用账本自己的 `evaluateLedger` 绑定 md5，未入账的行按 migrate 模式的规则匹配待上线文件）重放。任何一行找不到来源都直接失败（`production_row_not_in_repository`、`chain_row_unresolved`）。
2. 重放完的目录指纹必须**等于**快照，已审例外除外，否则 `production_schema_drift`，并列出“只在生产 / 只在重放 / 不同”，以及仓库链是否与生产一致。
3. 再把每个待上线迁移按发布工作流 migrate 模式的方式应用：每个文件一个事务、一次 plpgsql `EXECUTE`，所以事务控制语句或结尾的 `SELECT ... INTO` 在这里同样失败。
4. **仓库链**：另一个库按文件名顺序装全部文件（就是测试看到的样子），列出“只有仓库链有的列和函数”（今天 166 个）。
5. 待上线迁移通过表名或绑定到该表的名字（`b public.clued_agent_bindings;` 声明的变量、FROM/JOIN 别名）读取这类列时失败（`pending_migration_uses_repository_only_schema`）。同一个名字在文件里也绑定到另一个生产里确有该列的表时，不算命中；注释不参与匹配。确实要这样写（例如给生产加这一列的迁移）就在文件里写 `-- production-schema: allow <schema>.<table>.<column>`，由审查者看到。仓库独有的函数只报告，不拦截。

### 4.4 已审清单（都在 `catalog.json` 里，每条带原因）

- `prehistory`：`202608230001_clued_continuity.sql`。生产第一行历史就是在改 `clued_agent_bindings`，这张表在迁移历史开始之前就存在。
- `replay_skip`：`history-only/20260919040423_p2_p6_activation_backfill.sql`，纯数据回填，用生产行数做守卫，没有 DDL。
- `replay_substitutions`：精确的单处文本替换，替换后的 schema 效果不变。`mtpe_m1_w6_w9` 的 `baseline_d3` 是生产 61 行数据的摘要，空库算不出来；`pg_cron` 扩展由平台替身代替。
- `known_deviations`：已知的生产漂移（§4.6），按确切键列出。
- 平台替身（`PLATFORM_SQL`）：照测试已有的 auth/extensions/cron 替身，默认授权照生产 `pg_default_acl` 的实际内容。
- 每份清单都会被核对：列出的文件生产没跑过、替换文本不是恰好出现一次、原因为空，都直接失败，清单不会悄悄过期。

### 4.5 验证

- 用 2026-10-31 的快照，在 TURING 本机完整跑通（暂时去掉 #967 那一行，把 #967 的文件当待上线）：生产链 1 个 prehistory 加 295 行重放，指纹与生产一致；待上线迁移按 migrate 模式应用成功；结果 PASS。
- 重放还顺带确认了 `20261010161848_worker_gateway_closeout_v1` 里钉住的 G6 函数体 md5（它只在按文件 LF 文本重放时才能通过；账本的 transform 记的是存储形态，不一定是执行形态）。
- 引用规则对最近 158 个迁移只命中一处，就是 `20261023092957_ci_scheduling_stage1_v1` 的 `b.expires_at`，也就是今晚的 bug；#967 修过的写法（`to_jsonb(b)->>'expires_at'`）不命中。
- 单元测试：`apps/clued-cloud/tests/production-schema-drift.test.mjs`（11 项），选择与运行：`scripts/ci/ci-required-selection.test.mjs`（17 项）。

### 4.6 首次对照发现的生产漂移（交给 Task `16b795e6`）

- `public` 里有一套任何迁移、history-only 文本、账本都没有来源的 v0 旧对象：`audit_receipts`、`bindings`、`devices`、`idempotency_keys`、`memory_objects`、`memory_revisions`、`profiles`、`tombstones` 八张表，以及 `clued_handle_new_user()`、`clued_set_updated_at()`、`rls_auto_enable()`。
- `mtpe_m0.source_kind`、`mtpe_m0_test.source_kind` 多出 `'evidence'` 标签，没有迁移加过。
- `mtpe_m0_work.drive59`：账本早已登记。
- 21 个函数在生产里是 CRLF 换行，代码与文件逐字相同（指纹已忽略 CR）。
- **PR #967**：生产行 `20261031164748_ci_node_registration_binding_expiry_v1` 的文本（4107 字符，只有函数体）不是 PR 里的文件（4793 字符），看来不是经 migrate 模式应用的。在账本补上 history-only 文本和账本行之前，本检查和发布门都会报 `production_row_not_in_repository`。已告诉协调会话。

### 4.7 快照怎么刷新

- 刷新的人用只读连接（Supabase MCP 的 `execute_sql`，或只读角色的 psql）跑 `catalog.sql` 和 `applied.sql`，再运行 `node scripts/production-schema-drift.mjs import --catalog <结果> --applied <结果>`，开 PR。已审清单会保留下来，刷新 PR 的 diff 会显示它们是否仍然成立。
- 建议每次生产发布后刷新一次。没刷新时，已经上线的迁移仍被当成待上线，叠在旧快照上验证，结论仍然成立；漏掉的只是快照之后发生的带外改动。检查不按时钟判过期，以免误报。
- 把刷新做进发布工作流（发布后自动产出快照）要改受保护的发布工作流，并动用它的生产凭据，属于后续项，需要 Owner 批准。

### 4.8 局限

- plpgsql 函数体里的列引用是用名字绑定规则发现的，不是语义分析；绕开别名的写法（动态 SQL、`to_jsonb`）看不出来。更彻底的办法是让数据库测试也按生产链建库（夹具支持 `CLUED_TEST_MIGRATION_CHAIN=production`），列为 Task `16b795e6` 的待办。
- 指纹不比较对象属主、注释、统计信息和扩展内部对象。

## 5. 与常驻层、合并列车的关系

- 常驻层与 Source v2 零改动。合并位报告器和合并执行器本来就按规则集实际要求的检查名和 integration 计数（independent-ci.md），新检查加进规则集后自动生效。
- 列车车头批次测的是试合并提交 S；三项新检查跑在 PR 事件的合并 ref 上，main 前进后不会自动重跑。新检查只会多加限制（与 `kooyumi-merge-slot` 是“且”的关系），不削弱列车的不变量。车头批次重跑测试列为后续项。
- `clued-merge-slot-ci.test.mjs` 等准入自测会盘点工作流清单，新工作流会出现在其中；这些测试本来就在隔离清单里。

## 6. 费用

- 只用自建 runner 和 runner 本机的 `~/.npm`，没有 Actions cache、artifact、Packages、LFS，也没有托管 job。`validate_runner_budget_policy.py` 通过（新作业都是字面 self-hosted 加 trust-internal，PR 触发的有 concurrency 和 cancel-in-progress）。
- 临时数据走 `ci-temporary-storage`，三个工作流都登记在 `coverage.json` 里，检查器对它们没有发现。

## 7. 受保护路径与本 PR 改动

- 新增：`.github/workflows/clued-cloud-tests.yml`、`clued-ci-suites.yml`、`clued-migration-verify.yml`，`scripts/ci/ci-required-selection.mjs` 及其测试。
- 修改：`.github/actions/ci-temporary-storage/coverage.json`（只增加三个工作流的条目）。
- 应用侧：`apps/clued-cloud/scripts/production-schema-chain.mjs`、`production-schema-drift.mjs`，`apps/clued-cloud/supabase/production-schema/`，`apps/clued-cloud/tests/production-schema-drift.test.mjs`。
- `.github/**` 与 `scripts/ci/**` 是受保护路径：合入前要 Owner 批准，由协调会话申请并合入。

## 8. 需要 Owner 做的事（逐项，Agent 都不做）

1. **批准本 PR 的受保护改动**（`repo.protected_change`，针对确切 head），由协调会话申请。
2. **合入顺序**：先合 #967，并补上它那一行的账本记录（history-only 文本加账本行），再合本 PR；否则 `migration-verify` 报 `production_row_not_in_repository`（这是真问题，不是误报）。
3. **规则集 `24182890` 增加三项必需检查**，integration 都钉 **GitHub Actions（App `15368`）**，不能留空（留空等于任何来源都能发同名的通过检查）：`clued-cloud-tests`、`ci-suites`、`migration-verify`。现有六项和 `strict` 等其他设置不变。建议在本 PR 合入、并在一个普通 PR 上看到三项都实际通过之后再加。
4. **不需要**重新启用任何停用的工作流，也不需要改 App、Secret、环境或 runner。新工作流是新文件，合入后默认就是启用的。
5. （可选，后续）把快照刷新做进生产发布工作流，见 §4.7。

## 9. 后续项（不在本 PR）

- Task `16b795e6`：处理 §4.6 的漂移；建立快照刷新流程；让数据库测试支持按生产链建库。
- 修好隔离清单里的测试，逐条删掉（`UNIT_QUARANTINE`、`QUARANTINED`）。
- `clued-g4-database.yml` 的 gate 还用旧准入来源，重型 job 从不运行；`clued-ci-company-linux-01` 的工作目录坏了（checkout 失败）。
- 数据库测试（`npm run test:db`，约 1740 项，main 上就有失败）在隔离之后接进 `clued-cloud-tests` 或单独一项检查；常驻层的 Windows PowerShell 测试（`test-resident-windows.ps1`）需要 Windows runner。
- 车头批次在试合并提交 S 上重跑这三项检查。
