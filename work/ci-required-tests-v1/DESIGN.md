# 测试、构建与迁移验证成为必需检查 · 设计说明 v5

- 日期：2026-11-01（UTC）
- KooYomi：项目 0597aa60；Task `2a5fdb66`（本工作），拆出的漂移检查 Task `16b795e6`；认领 `1b3d6e2f`。
- 依据：Owner 目标 Decision `afec9be8`（全部算力可调度、完整 CI/CD），顺序 Decision `02e4374a`（本项第 3 项）；费用规则 Decision `9eb313f8`（新作业只用自建算力，[Runbook §2.4](../../docs/maintenance/runner-configuration-and-operations.md#24-现有与未来任务的费用原则迁移与防回流)）；不稳定测试隔离 Task `679a0c2b`；配置改动先独立审核 `01d4ba7d`。
- 修订：v1 经独立审核 FAIL（1 BLOCKER、3 MAJOR），v2 逐项修正；v2 第二轮 FAIL（3 MAJOR），v3 再修；v3 第三轮 FAIL（1 MAJOR），v4 再修；第四轮 PASS，v5 收掉其中的 MINOR，见 §10。
- 状态：代码与测试在 PR #971；前置的门禁登记在单独的 PR（§7）。三项新检查还**不是**必需检查，加进规则集要 Owner 操作（§8）。

## 0. 结论

1. 一个工作流 `.github/workflows/clued-required-tests.yml`：一个 `admission-gate`，加三个检查 job，全部只在自建 Linux 池（`[self-hosted, Linux, X64, clued, pool-general, trust-internal]`）上跑，不用 GitHub 托管分钟：
   - `clued-cloud-tests`：apps/clued-cloud 的 lint、迁移账本校验、typecheck、build、单元测试；
   - `ci-suites`：常驻层 Node/Python 测试、离线演练、Source v2 测试、组件版本检查、runner 费用策略检查、准入自测、选择脚本自测；
   - `migration-verify`：迁移在**生产 schema** 上验证，并检出漂移。
2. 生产 schema 漂移检查不需要任何生产凭据：生产的 schema 只读快照（不含数据、不含秘密）提交在仓库里，PR 作业只读这个文件。它对今晚的真实 bug 有效：在最近 158 个迁移文件上只命中一处，正是 `20261023092957_ci_scheduling_stage1_v1` 里的 `b.expires_at`（§4.5）。
3. **前置条件（独立审核 B1）**：准入的门禁守卫只接受 `GATE_JOB_SHA256` 里登记过的 `admission-gate` 字节。新 gate（自建 runner 加独立 CI 准入来源）要先登记，摘要 `9c582144f424d1bc9ef7d3b048d3b7771c7b639ef5544bc04a8a80515c52b2f2`，而且常驻节点执行准入用的是**安装时钉住的** `clued-work-admission.mjs`（`one-shot.mjs` 核对 `evaluatorSha256`）。所以顺序是：登记 PR 合入 → 常驻节点 Source 升级到含这个摘要的版本 → 本 PR 才能被准入（§7、§8）。
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

1. `admission-gate`（每次推送只有一个）：在 trusted base 上运行 `clued-work-admission.mjs --mode gate`，`CLUED_ADMISSION_GATE_SOURCE=independent-ci-native-work-admission`，等这个 head 上 App `5368905` 的 `kooyumi-work-admission`，最多 10 分钟。字节与 `contract-placement.yml` 已登记的 gate（`3f48159e…`）只差 `runs-on` 一行（摘要 `9c582144…`）。
2. 三个检查 job 各自 checkout **trusted base** 到 `trusted/`、候选到 `candidate/`。选择、命令行和已知失败清单都来自 `trusted/scripts/ci/`；候选只是被测代码。
3. `node trusted/scripts/ci/ci-required-selection.mjs --check <检查名>` 用 API 列出 PR 改动文件，决定跑哪些套件；`--run <套件> --root candidate` 依次执行。

### 3.2 选择（`scripts/ci/ci-required-selection.mjs`）

- 每项检查下有若干套件，按路径模式选中。常驻层、Source v2、`scripts/ci`、`scripts/runner` 互相 import（准入自测经 `scripts/ci` 用到约 50 个 Source v2 文件，`clued-work-admission.mjs` 用到 `scripts/runner`），还读 `.gitleaks.toml`，所以这几处任何一处改动，常驻层、Source v2、离线演练和准入自测都跑。测试从每个 Node 套件运行的全部文件出发，算出**传递**的 import 闭包，确认闭包里每个文件都会选中这个套件（独立审核 M3，两轮）。
- `clued-cloud-tests` 对任何改动都跑（应用测试会读工作流、合同、CI 脚本，路径排除不安全）。
- 改了选择脚本、已知失败清单、本工作流或 `.github/actions/**`：所有套件都跑。
- 拿不到改动列表（push、API 失败、列表到 GitHub 3000 文件上限）：所有套件都跑。
- 没有套件被选中：检查照样出现并成功，摘要写“not affected”。所以三项都能成为必需检查。
- 引入选择脚本的这个 PR 本身：base 上还没有脚本，工作流退回候选自带的副本并出警告。

### 3.3 信任、命名与重跑

- job 只在 `admission-gate` 放行、且是 push 到 main 或同仓库 PR（作者是 Owner，或 gate 认可的受信自动化路线）时运行。
- job 名把这些条件也算进去：不满足时名字是 `<检查名>-skipped`，必需检查根本不出现，PR 合不了（fail closed），条件跳过的 job 不会冒充成功。
- 被测代码（候选的 package.json 脚本、`run-tests.mjs`、`select-tests.mjs`、测试本身）是候选里的；它们由受保护路径和审查把关，trusted base 只钉住“跑哪些、用什么命令行、哪些失败是已知的”。
- 重跑：仅按当前 Agent Contract A.7，在当前 head 上考虑“Re-run all jobs”，重新经过 gate 的每 head 重跑规则；不得用“Re-run failed jobs”或单 job 重跑沿用旧 gate 输出。实际是否可重跑仍受 A.7 的次数和拒绝条件限制。
- 任何工作流里同名的 job 都能满足必需检查（GitHub 按名字计数）；`.github/workflows/**` 是受保护路径，新增同名 job 要 Owner 的 `repo.protected_change` Grant。在门禁守卫里显式拒绝其他文件使用这三个名字，列为后续项（§9）。

### 3.4 已知失败（Task `679a0c2b`）

- `scripts/ci/ci-known-failures.json` 按套件列出 main 上已经失败的测试：`clued-cloud` 86 条、`admission-self-tests` 4 条。每条由三样确定：测试文件（相对仓库根）、完整的测试路径（外层 describe 和父测试在前）、失败指纹，外加原因。
- 带 `known` 的命令用 trusted base 上的报告器 `scripts/ci/ci-test-failures-reporter.mjs` 跑 Node 测试运行器。报告器记下每一次 `test:fail`：普通测试、suite、hook（`hookFailed`）、在子测试之后抛错的父测试、加载失败的文件；只因子测试失败而失败的父测试（`subtestsFailed`）不单记，由子测试承担。指纹是失败类型、错误码和去掉路径、十六进制摘要、数字之后的失败消息的 sha256 前 16 位，所以同一个已知测试换了失败原因就是新失败（独立审核第二轮 MAJOR-2：`clued-merge-slot-ci.yml` 清单缺 `clued-required-tests` 这件事，如今就体现在那条已知失败的指纹和原因里）。
- 判定：任何对不上已知条目的失败让套件失败（出 `::error`）；运行没有总结事件（没跑完）、退出码不是 0 或 1（信号、超时）、非零退出却没有失败、有失败却退出 0，也都失败。已知条目照常失败出 `::warning`；已知测试通过、或者已不存在时提示删除。
- 测试结束后的异步错误（未捕获异常、未处理的 rejection）Node 只发一条诊断，报告器把它记成 `<async activity after the test ended> > 测试名` 的失败；todo 测试的失败不记（Node 不因它判失败）。文件路径两边都取真实路径再比较，runner 目录在链接后面也能对上（独立审核第三轮）。
- 指纹去掉路径、行列号、十六进制摘要、时长、时间戳和五位以上的长数字，小数字保留：断言里的 `23 !== 22` 变成 `24 !== 22` 就是新失败。同一份代码在 TURING 上连跑两次，90 条指纹完全一致。
- 清单和报告器都在 trusted base 上读取，候选改不了；改它们会让所有套件都跑。重新生成：`node scripts/ci/ci-required-selection.mjs --write-known <套件>`，已有条目的原因按文件和测试路径保留，新条目没有原因，清单读取时会被拒，必须有人写上原因。
- 有些已知失败的指纹里带着仓库范围的数量或清单（例如登记过的 gated 工作流个数）。正常改动了这些数量的 PR 会让已知失败换指纹，而清单从 trusted base 读，同一个 PR 里改不了：先开一个 PR，用 `--write-known <套件> --keep` 把将来的那条失败连同原因加进清单，合入后再合真正的改动。重新生成时，只有指纹相同的条目保留原因；指纹变了要重新写原因。
- 残余：已有已知失败的测试文件，如果在测试全部结束后以非零码退出（`process.exit(3)` 之类），Node 不发任何失败事件，这个退出码被已知失败“解释”掉。这是 Node 测试运行器的限制，清单里的条目都来自这几个文件：`apps/clued-cloud/tests/ci-proof-profiles.test.mjs`、`production-publisher-source.test.mjs`、`ci-temporary-storage.test.mjs`、`integration-runtime-gate-evidence.test.mjs`、`resource-center-daily-install.test.mjs`、`resource-center-storage-read-pdf-bounds.test.mjs`，以及 `scripts/ci/clued-work-admission.test.mjs`、`clued-merge-slot-ci.test.mjs`。修好这些文件、删掉条目，残余就消失。
- 首次在自建 Linux runner 上运行时，Windows 才有的失败（`pdf-bounds` 62 条等）会提示“now passes”，Linux 才有的失败会报新失败。在 Owner 把检查加进规则集之前，先在 Linux 上跑一次，用 `--write-known` 重新生成清单。

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
4. 每个待上线迁移复现发布工作流 migrate 模式的文件执行部分：每个文件一个事务、一次 plpgsql `EXECUTE`，所以事务控制语句或结尾的 `SELECT ... INTO` 在这里同样失败。生产环境的执行后激活检查不在这项离线重放的覆盖内（§4.8）。
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
- 单元测试：`apps/clued-cloud/tests/production-schema-drift.test.mjs`（15 项），选择、运行、报告器与已知失败：`scripts/ci/ci-required-selection.test.mjs`（23 项）。

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

- 离线重放不调用生产发布工作流在 `EXECUTE` 后执行的 `clued_private.storage_conflict_require_scheduler_v1()`，也不证明生产 scheduler 已就绪。`migration-verify` 通过只证明本节列出的 schema 重放与引用检查，不能代替发布时的激活依赖检查。
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

1. **门禁登记 PR**（单独开）：在 `scripts/ci/clued-work-admission.mjs` 的 `GATE_JOB_SHA256` 里登记新 gate 的确切摘要 `9c582144…`，并在 `clued-work-admission.test.mjs` 里断言它是“`contract-placement.yml` 的 gate 只把 `runs-on` 换成自建 Linux 池”。只改这两个文件。
2. 常驻节点的 Source 升级到含这次登记的 `clued-work-admission.mjs`（常驻准入用的是安装时钉住的副本）。
3. **PR #971**（本 PR）：新工作流、选择脚本、已知失败清单、漂移检查、`coverage.json` 一条。在 2 完成之前，它的 `kooyumi-work-admission` 会以 `admission_gate_changed` 拒绝。#967 先合（已在 `be3ea75b` 修好账本）。

## 8. 需要 Owner 做的事（逐项，Agent 都不做）

1. 批准门禁登记 PR 的受保护改动（`repo.protected_change`）。
2. 接受并安装（或原地升级）含这次登记的常驻 Source：常驻节点的准入评估器要换成新版本，这是 Source 变更，要 Owner 接受，安装时 UAC。
3. 批准 PR #971 的受保护改动。
4. 先让三项检查在一个普通 PR 上于自建 Linux runner 实际跑一次，用 `--write-known` 按 Linux 结果更新已知失败清单（Agent 做，开普通 PR）。然后，规则集 `24182890` 增加三项必需检查，integration 都钉 **GitHub Actions（App `15368`）**，不能留空：`clued-cloud-tests`、`ci-suites`、`migration-verify`。现有六项和 `strict` 等其他设置不变。建议在一个普通 PR 上看到三项都实际通过之后再加。
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

第二轮（v2，2026-11-01）FAIL：B1、M2 已修好；3 MAJOR、4 MINOR、3 NIT。处理：

| 编号 | 问题 | 处理 |
| --- | --- | --- |
| MAJOR-1 | 不是测试用例的失败（子测试之后父测试抛错、describe 的 after hook）被任意一条已知失败“解释”掉 | 换成 trusted base 上的报告器，记下每一次 `test:fail`，并要求总结事件和正常退出码（§3.4） |
| MAJOR-2 | 按名字登记会掩盖已知测试的新失败原因（merge-slot 清单缺新工作流） | 条目带失败指纹；那条已知失败的原因已写明缺 `clued-required-tests` |
| MAJOR-3 | 只查一跳 import，漏掉 `scripts/runner` 和准入自测用到的 Source v2 | 共用的路径模式加上 `scripts/runner/**`，准入自测加上常驻层和 Source v2；测试改为传递闭包（§3.2） |
| MINOR 1 | 同名测试互相冒充 | 条目按文件、完整路径、指纹匹配 |
| MINOR 2 | 已不存在的条目没有提示 | 出 `known failure no longer runs` |
| MINOR 3 | 信号或残缺报告 | 要求总结事件；信号或 0/1 以外的退出码失败 |
| MINOR 4 | 比快照新的账本行不经过 replay_skip / 替换 | 这些行与快照行用同一份清单 |
| NIT | 反复解码 XML 名字 | 不再用 JUnit |
| NIT | SCHEMA_STATEMENT 可被动态 SQL 绕过 | 接受：清单要审查 |
| NIT | push 到 main 时 cancel-in-progress 会取消前一次 main 的运行 | 只在 PR 上取消 |

第三轮（v3，2026-11-01）FAIL：第二轮的指纹和传递闭包已修好；1 MAJOR、4 MINOR、4 NIT。处理：

| 编号 | 问题 | 处理 |
| --- | --- | --- |
| MAJOR | 同文件有已知失败时，测试结束后的异步错误（只发 diagnostic）被掩盖 | 报告器把这类诊断记成失败；非零的晚退出写为残余（§3.4） |
| MINOR-1 | 所有数字都被抹掉，`23 !== 22` 与 `24 !== 22` 同指纹 | 只抹掉行列号、时长、时间戳、五位以上数字 |
| MINOR-2 | runner 目录在链接后时全部条目对不上 | 两边都取真实路径 |
| MINOR-3 | todo 测试失败会误报 | 不记 todo 失败 |
| MINOR-4 | 比快照新的账本行的跳过与替换没有单测 | 抽成 `prepareReplay` 并测试 |
| NIT | 清单无法复现生成 | 新增 `--write-known` |
| NIT | 并发注释不准确 | 改写 |
| NIT | 文件级失败指纹相同、测试自身 stdout 产生的注解 | 接受 |

第四轮（v4，2026-11-01）**PASS**：0 BLOCKER、0 MAJOR；第三轮各项已修好，2 MINOR、2 NIT。处理：

| 编号 | 问题 | 处理 |
| --- | --- | --- |
| MINOR-A | 不分进程运行（`--test-isolation=none`）时诊断不带文件名，异步错误被忽略 | 不带文件的这类诊断记在 `<run>` 下，永远对不上已知条目 |
| MINOR-B | 指纹带仓库范围的数量，改了数量的 PR 无法在同一 PR 更新清单 | `--write-known --keep` 与两步做法写进 §3.4 |
| NIT-1 | 重新生成时指纹变了还沿用旧原因 | 只在指纹相同时沿用 |
| NIT-2 | 测试中途 `process.exit(0)` 让整个文件算通过 | Node 的行为，接受；已知条目会提示“no longer runs” |
